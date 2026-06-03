package services

import (
	"context"
	"errors"
	"testing"

	"prophet-trader/interfaces"
)

// closeStubTrading scripts the managed-close path's broker calls and records
// them. Embeds the base stubTrading (trade_guard_test.go) for the rest of the
// TradingService surface. The close liquidates via ClosePosition (the broker's
// atomic close-position endpoint); a protective-stop re-placement after a
// failed close still goes through PlaceOrder.
type closeStubTrading struct {
	*stubTrading

	closeErr    error   // if set, ClosePosition returns this on every call
	closeErrSeq []error // per-call ClosePosition outcomes (index = call-1); nil slot = success; takes precedence over closeErr when in range
	closeCalls  int

	placeErr   error // if set, PlaceOrder (stop re-placement) returns this
	placeCalls int

	cancelErr error // if set, CancelOrder returns this
	canceled  []string

	// getOrderStatusSeq scripts the broker status returned by GetOrder on each
	// call, modelling Alpaca's async cancel settle (pending_cancel → canceled).
	// Calls past the end of the slice default to "canceled" (settled).
	getOrderStatusSeq []string
	getOrderCalls     int
}

func (s *closeStubTrading) ClosePosition(_ context.Context, _ string, _ float64) (*interfaces.OrderResult, error) {
	s.closeCalls++
	if s.closeErrSeq != nil && s.closeCalls-1 < len(s.closeErrSeq) {
		if e := s.closeErrSeq[s.closeCalls-1]; e != nil {
			return nil, e
		}
	} else if s.closeErr != nil {
		return nil, s.closeErr
	}
	return &interfaces.OrderResult{OrderID: "close-1", Status: "accepted"}, nil
}

// PlaceOrder backs the protective-stop re-placement on the retry-failure path.
func (s *closeStubTrading) PlaceOrder(_ context.Context, _ *interfaces.Order) (*interfaces.OrderResult, error) {
	s.placeCalls++
	if s.placeErr != nil {
		return nil, s.placeErr
	}
	return &interfaces.OrderResult{OrderID: "stop-replaced", Status: "accepted"}, nil
}

func (s *closeStubTrading) CancelOrder(_ context.Context, id string) error {
	s.canceled = append(s.canceled, id)
	return s.cancelErr
}

func (s *closeStubTrading) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	status := "canceled"
	if s.getOrderStatusSeq != nil && s.getOrderCalls < len(s.getOrderStatusSeq) {
		status = s.getOrderStatusSeq[s.getOrderCalls]
	}
	s.getOrderCalls++
	return &interfaces.Order{ID: id, Status: status}, nil
}

func (s *closeStubTrading) contains(id string) bool {
	for _, c := range s.canceled {
		if c == id {
			return true
		}
	}
	return false
}

// A transient liquidation failure (429/outage, NOT a held-shares rejection)
// must NOT mark the position CLOSED, must leave the protective stop untouched
// (still protected), and must return an error. This is the Coil UNH/ADI orphan
// from 2026-05-26, and the storm-safety property that the close attempts the
// liquidation before ever touching the bracket.
func TestClose_LiquidationFailsTransient_StaysActiveAndErrors(t *testing.T) {
	trading := &closeStubTrading{stubTrading: &stubTrading{}, closeErr: errors.New("alpaca 429 rate limited")}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{Symbol: "UNH", Side: "buy", Status: "ACTIVE", Quantity: 13, RemainingQty: 13, StopLossOrderID: "stop-1", AgentStrategy: "mean-rev-rsi2"}
	injectPosition(pm, pos)
	if err := pm.savePositionToDB(pos); err != nil {
		t.Fatalf("seed DB: %v", err)
	}

	err := pm.CloseManagedPosition(context.Background(), pos.ID)
	if err == nil {
		t.Fatal("expected error when liquidation fails, got nil")
	}
	if pos.Status != "ACTIVE" {
		t.Errorf("in-memory status = %q, want ACTIVE (failed close must not mark CLOSED)", pos.Status)
	}
	if trading.contains("stop-1") {
		t.Error("stop-loss was cancelled on a transient failure — position left unprotected")
	}
	if trading.closeCalls != 1 {
		t.Errorf("closeCalls = %d, want 1 (a transient failure must NOT trigger the cancel-bracket-and-retry path)", trading.closeCalls)
	}
	saved, err := pm.storageService.GetManagedPosition(pos.ID)
	if err != nil {
		t.Fatalf("GetManagedPosition: %v", err)
	}
	if saved.Status != "ACTIVE" {
		t.Errorf("persisted status = %q, want ACTIVE", saved.Status)
	}
}

// A successful liquidation closes the position via the atomic close-position
// endpoint and tears down both bracket legs.
func TestClose_LiquidationSucceeds_ClosesAndCancelsBracket(t *testing.T) {
	trading := &closeStubTrading{stubTrading: &stubTrading{}}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{Symbol: "UNH", Side: "buy", Status: "ACTIVE", Quantity: 13, RemainingQty: 13, StopLossOrderID: "stop-1", TakeProfitOrderID: "tp-1", AgentStrategy: "mean-rev-rsi2"}
	injectPosition(pm, pos)

	if err := pm.CloseManagedPosition(context.Background(), pos.ID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pos.Status != "CLOSED" {
		t.Errorf("status = %q, want CLOSED", pos.Status)
	}
	if pos.ClosedAt == nil {
		t.Error("ClosedAt not set")
	}
	if trading.closeCalls != 1 {
		t.Errorf("closeCalls = %d, want 1", trading.closeCalls)
	}
	if !trading.contains("stop-1") || !trading.contains("tp-1") {
		t.Errorf("bracket not fully cancelled: canceled=%v", trading.canceled)
	}
}

// A PENDING position closes by cancelling the entry order; no liquidation.
func TestClose_Pending_CancelsEntry_NoLiquidation(t *testing.T) {
	trading := &closeStubTrading{stubTrading: &stubTrading{}}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{Symbol: "WMT", Side: "buy", Status: "PENDING", Quantity: 42, RemainingQty: 42, EntryOrderID: "entry-1"}
	injectPosition(pm, pos)

	if err := pm.CloseManagedPosition(context.Background(), pos.ID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pos.Status != "CLOSED" {
		t.Errorf("status = %q, want CLOSED", pos.Status)
	}
	if trading.closeCalls != 0 {
		t.Errorf("closeCalls = %d, want 0 (no liquidation for a pending close)", trading.closeCalls)
	}
	if !trading.contains("entry-1") {
		t.Errorf("entry order not cancelled: canceled=%v", trading.canceled)
	}
}

// Fail-closed for PENDING: if the entry-cancel errors, the entry could still
// fill, so the position must NOT be marked CLOSED.
func TestClose_Pending_CancelFails_StaysPending(t *testing.T) {
	trading := &closeStubTrading{stubTrading: &stubTrading{}, cancelErr: errors.New("alpaca 429 rate limited")}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{Symbol: "WMT", Side: "buy", Status: "PENDING", Quantity: 42, RemainingQty: 42, EntryOrderID: "entry-1"}
	injectPosition(pm, pos)

	err := pm.CloseManagedPosition(context.Background(), pos.ID)
	if err == nil {
		t.Fatal("expected error when entry cancel fails, got nil")
	}
	if pos.Status != "PENDING" {
		t.Errorf("status = %q, want PENDING (failed entry-cancel must not mark CLOSED)", pos.Status)
	}
}

// The regression that stranded Coil's LIN/MO on 2026-06-03: the resting GTC stop
// reserves the shares (Alpaca held_for_orders), so the full-quantity liquidation
// is rejected for "insufficient qty available". The close must detect that, cancel
// the bracket to free the shares, then — because Alpaca processes the cancel
// asynchronously (pending_cancel → canceled) and does not release the shares
// until it actually reaches canceled — WAIT for the cancel to settle before
// retrying. An immediate retry races the cancel and hits the same rejection.
func TestClose_BlockedByRestingStop_CancelsWaitsForSettleRetriesAndCloses(t *testing.T) {
	qtyErr := errors.New("insufficient qty available for order (requested: 42, available: 0) (HTTP 403, Code 40310000)")
	// Liquidation call 1: blocked by the resting stop. Call 2 (after the cancel
	// settles): succeeds.
	trading := &closeStubTrading{
		stubTrading: &stubTrading{},
		closeErrSeq: []error{qtyErr, nil},
		// The cancelled stop sits in pending_cancel for two polls before the
		// broker reports it canceled (shares released). The close path must wait
		// through this before retrying.
		getOrderStatusSeq: []string{"pending_cancel", "pending_cancel", "canceled"},
	}
	pm := newReconcilePM(t, trading)
	pm.cancelSettlePoll = 0 // no real sleeping in tests
	pos := &ManagedPosition{Symbol: "WMT", Side: "buy", Status: "ACTIVE", Quantity: 42, RemainingQty: 42, StopLossOrderID: "stop-1", AgentStrategy: "mean-rev-rsi2"}
	injectPosition(pm, pos)

	if err := pm.CloseManagedPosition(context.Background(), pos.ID); err != nil {
		t.Fatalf("expected nil error after the cancel settled and the retry closed, got %v", err)
	}
	if pos.Status != "CLOSED" {
		t.Errorf("status = %q, want CLOSED after the retried liquidation succeeded", pos.Status)
	}
	if !trading.contains("stop-1") {
		t.Error("stop-loss must be cancelled to free the reserved shares before the retry")
	}
	if trading.closeCalls != 2 {
		t.Errorf("closeCalls = %d, want 2 (liquidation, then retry after the cancel settled)", trading.closeCalls)
	}
	if trading.getOrderCalls != 3 {
		t.Errorf("getOrderCalls = %d, want 3 (must poll the cancelled stop through both pending_cancel states until canceled before retrying — this is the race fix)", trading.getOrderCalls)
	}
}

// Worst case of the LIN/MO path: the liquidation is blocked by the resting stop,
// the bracket is cancelled to free the shares, but the retry STILL fails. The
// position is now unprotected (its stop was just cancelled), so the close must
// re-place the stop to restore protection, stay ACTIVE, and return an error —
// never mark CLOSED while the broker still holds the shares.
func TestClose_BlockedThenRetryFails_ReplacesStopStaysActive(t *testing.T) {
	qtyErr := errors.New("insufficient qty available for order (requested: 42, available: 0)")
	// Both liquidation attempts blocked; the stop re-placement (PlaceOrder) succeeds.
	trading := &closeStubTrading{
		stubTrading: &stubTrading{},
		closeErrSeq: []error{qtyErr, qtyErr},
	}
	pm := newReconcilePM(t, trading)
	pm.cancelSettlePoll = 0
	pos := &ManagedPosition{Symbol: "WMT", Side: "buy", Status: "ACTIVE", Quantity: 42, RemainingQty: 42, StopLossPrice: 110.18, StopLossOrderID: "stop-1", AgentStrategy: "mean-rev-rsi2"}
	injectPosition(pm, pos)

	err := pm.CloseManagedPosition(context.Background(), pos.ID)
	if err == nil {
		t.Fatal("expected error when the retried liquidation also fails, got nil")
	}
	if pos.Status != "ACTIVE" {
		t.Errorf("status = %q, want ACTIVE (a position the broker still holds must not be marked CLOSED)", pos.Status)
	}
	if pos.StopLossOrderID == "stop-1" {
		t.Error("stop was not re-placed — position left unprotected after the bracket was cancelled")
	}
	if trading.closeCalls != 2 {
		t.Errorf("closeCalls = %d, want 2 (liquidation, then retry)", trading.closeCalls)
	}
	if trading.placeCalls != 1 {
		t.Errorf("placeCalls = %d, want 1 (the stop re-placement)", trading.placeCalls)
	}
}
