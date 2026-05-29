package services

import (
	"context"
	"errors"
	"testing"

	"prophet-trader/interfaces"
)

// closeStubTrading scripts PlaceOrder / CancelOrder outcomes for the close path
// and records calls. Embeds the base stubTrading (trade_guard_test.go) for the
// rest of the TradingService surface.
type closeStubTrading struct {
	*stubTrading
	placeErr     error // if set, PlaceOrder returns this error (simulates a failed exit)
	placeCalls   int
	placedOrders []*interfaces.Order
	cancelErr    error // if set, CancelOrder returns this error
	canceled     []string
}

func (s *closeStubTrading) PlaceOrder(_ context.Context, o *interfaces.Order) (*interfaces.OrderResult, error) {
	s.placeCalls++
	if s.placeErr != nil {
		return nil, s.placeErr
	}
	s.placedOrders = append(s.placedOrders, o)
	return &interfaces.OrderResult{OrderID: "exit-1", Status: "accepted"}, nil
}

func (s *closeStubTrading) CancelOrder(_ context.Context, id string) error {
	s.canceled = append(s.canceled, id)
	return s.cancelErr
}

func (s *closeStubTrading) contains(id string) bool {
	for _, c := range s.canceled {
		if c == id {
			return true
		}
	}
	return false
}

// A failed exit order must NOT mark the position CLOSED, must leave the stop
// untouched (still protected), and must return an error. This is the Coil
// UNH/ADI orphan from 2026-05-26.
func TestClose_ExitOrderFails_StaysActiveAndErrors(t *testing.T) {
	trading := &closeStubTrading{stubTrading: &stubTrading{}, placeErr: errors.New("alpaca 429 rate limited")}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{Symbol: "UNH", Side: "buy", Status: "ACTIVE", Quantity: 13, RemainingQty: 13, StopLossOrderID: "stop-1", AgentStrategy: "mean-rev-rsi2"}
	injectPosition(pm, pos)
	if err := pm.savePositionToDB(pos); err != nil {
		t.Fatalf("seed DB: %v", err)
	}

	err := pm.CloseManagedPosition(context.Background(), pos.ID)
	if err == nil {
		t.Fatal("expected error when exit order fails, got nil")
	}
	if pos.Status != "ACTIVE" {
		t.Errorf("in-memory status = %q, want ACTIVE (failed close must not mark CLOSED)", pos.Status)
	}
	if trading.contains("stop-1") {
		t.Error("stop-loss was cancelled on a failed close — position left unprotected")
	}
	saved, err := pm.storageService.GetManagedPosition(pos.ID)
	if err != nil {
		t.Fatalf("GetManagedPosition: %v", err)
	}
	if saved.Status != "ACTIVE" {
		t.Errorf("persisted status = %q, want ACTIVE", saved.Status)
	}
}

// A successful exit closes the position, places exactly one strategy-tagged
// exit order, and tears down both bracket legs.
func TestClose_ExitOrderSucceeds_ClosesAndCancelsBracket(t *testing.T) {
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
	if trading.placeCalls != 1 {
		t.Errorf("placeCalls = %d, want 1", trading.placeCalls)
	}
	if len(trading.placedOrders) != 1 || trading.placedOrders[0].Strategy != "mean-rev-rsi2" {
		t.Errorf("exit order missing strategy tag: %+v", trading.placedOrders)
	}
	if !trading.contains("stop-1") || !trading.contains("tp-1") {
		t.Errorf("bracket not fully cancelled: canceled=%v", trading.canceled)
	}
}

// A PENDING position closes by cancelling the entry order; no exit order is placed.
func TestClose_Pending_CancelsEntry_NoExitOrder(t *testing.T) {
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
	if trading.placeCalls != 0 {
		t.Errorf("placeCalls = %d, want 0 (no exit order for a pending close)", trading.placeCalls)
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
