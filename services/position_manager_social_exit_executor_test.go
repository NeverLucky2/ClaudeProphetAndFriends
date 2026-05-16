package services

import (
	"context"
	"io"
	"prophet-trader/interfaces"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// recordingTrading embeds the package-shared stubTrading (declared in
// trade_guard_test.go) and overrides PlaceOrder / CancelOrder / GetOrder so
// each test can configure per-orderID responses and inspect the calls made.
//
// The defaults mimic a clean cancel: CancelOrder returns nil, GetOrder
// returns Status "canceled" unless overridden, PlaceOrder records the order
// and returns an accepted OrderResult.
type recordingTrading struct {
	*stubTrading

	cancelErrs    map[string]error
	orderStatuses map[string]string
	placeOrderErr error

	cancelOrders  []string
	placedOrders  []*interfaces.Order
	getOrderCalls []string
}

func newRecordingTrading() *recordingTrading {
	return &recordingTrading{
		stubTrading:   &stubTrading{},
		cancelErrs:    map[string]error{},
		orderStatuses: map[string]string{},
	}
}

func (r *recordingTrading) CancelOrder(_ context.Context, orderID string) error {
	r.cancelOrders = append(r.cancelOrders, orderID)
	return r.cancelErrs[orderID]
}

func (r *recordingTrading) GetOrder(_ context.Context, orderID string) (*interfaces.Order, error) {
	r.getOrderCalls = append(r.getOrderCalls, orderID)
	status, ok := r.orderStatuses[orderID]
	if !ok {
		status = "canceled"
	}
	return &interfaces.Order{ID: orderID, Status: status}, nil
}

func (r *recordingTrading) PlaceOrder(_ context.Context, order *interfaces.Order) (*interfaces.OrderResult, error) {
	if r.placeOrderErr != nil {
		return nil, r.placeOrderErr
	}
	r.placedOrders = append(r.placedOrders, order)
	return &interfaces.OrderResult{OrderID: "placed-" + order.Symbol, Status: "accepted"}, nil
}

func newSilentLogger() *logrus.Logger {
	logger := logrus.New()
	logger.SetOutput(io.Discard)
	return logger
}

func newTestPositionManager(trading interfaces.TradingService, positions map[string]*ManagedPosition) *PositionManager {
	return &PositionManager{
		tradingService: trading,
		positions:      positions,
		logger:         newSilentLogger(),
	}
}

func cancelOrderIDs(t *testing.T, calls []string, want ...string) {
	t.Helper()
	got := map[string]bool{}
	for _, id := range calls {
		got[id] = true
	}
	for _, id := range want {
		if !got[id] {
			t.Errorf("expected CancelOrder(%q) to be called; got calls=%v", id, calls)
		}
	}
}

// --- Tests ---

func TestExecuteSocialTimeExit_HappyPathLongPosition(t *testing.T) {
	trading := newRecordingTrading()
	// Both legs cancel cleanly — GetOrder returns the default "canceled".
	pos := &ManagedPosition{
		ID:                "p1",
		Symbol:            "ABCD",
		Side:              "buy",
		RemainingQty:      100,
		Status:            "ACTIVE",
		DominantSignal:    "social",
		AgentStrategy:     "penny-momentum",
		StopLossOrderID:   "stop-1",
		TakeProfitOrderID: "tp-1",
		CreatedAt:         time.Now().Add(-21 * time.Minute),
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": pos})

	if err := pm.executeSocialTimeExit(context.Background(), pos); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}

	cancelOrderIDs(t, trading.cancelOrders, "stop-1", "tp-1")
	if len(trading.cancelOrders) != 2 {
		t.Errorf("expected exactly 2 cancels, got %d: %v", len(trading.cancelOrders), trading.cancelOrders)
	}
	if len(trading.getOrderCalls) != 2 {
		t.Errorf("expected 2 GetOrder calls (one per leg, to detect mid-cancel fills), got %d", len(trading.getOrderCalls))
	}

	if len(trading.placedOrders) != 1 {
		t.Fatalf("expected 1 market sell, got %d (orders=%+v)", len(trading.placedOrders), trading.placedOrders)
	}
	ord := trading.placedOrders[0]
	if ord.Symbol != "ABCD" {
		t.Errorf("market sell Symbol: got %q, want ABCD", ord.Symbol)
	}
	if ord.Side != "sell" {
		t.Errorf("market sell Side: got %q, want sell", ord.Side)
	}
	if ord.Type != "market" {
		t.Errorf("market sell Type: got %q, want market", ord.Type)
	}
	if ord.TimeInForce != "day" {
		t.Errorf("market sell TimeInForce: got %q, want day", ord.TimeInForce)
	}
	if ord.Qty != 100 {
		t.Errorf("market sell Qty: got %v, want 100", ord.Qty)
	}
	if ord.Strategy != "penny-momentum" {
		t.Errorf("market sell Strategy: got %q, want penny-momentum", ord.Strategy)
	}

	if pos.Status != "CLOSED" {
		t.Errorf("expected pos.Status=CLOSED after exit, got %q", pos.Status)
	}
	if pos.ClosedAt == nil {
		t.Errorf("expected pos.ClosedAt to be set after exit")
	}
}

func TestExecuteSocialTimeExit_BracketLegFilledDuringCancel_SkipsMarketSell(t *testing.T) {
	trading := newRecordingTrading()
	// Stop-loss filled at the broker DURING our cancel attempt. Bracket has
	// closed the position; we must NOT place a duplicate market sell.
	trading.orderStatuses["stop-1"] = "filled"
	trading.orderStatuses["tp-1"] = "canceled"

	pos := &ManagedPosition{
		ID:                "p1",
		Symbol:            "ABCD",
		Side:              "buy",
		RemainingQty:      100,
		Status:            "ACTIVE",
		DominantSignal:    "social",
		AgentStrategy:     "penny-momentum",
		StopLossOrderID:   "stop-1",
		TakeProfitOrderID: "tp-1",
		CreatedAt:         time.Now().Add(-21 * time.Minute),
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": pos})

	if err := pm.executeSocialTimeExit(context.Background(), pos); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}

	if len(trading.placedOrders) != 0 {
		t.Errorf("expected 0 market sells when bracket leg filled mid-cancel, got %d (orders=%+v)", len(trading.placedOrders), trading.placedOrders)
	}
	if pos.Status != "ACTIVE" {
		t.Errorf("position status should NOT be flipped to CLOSED here — bracket monitor handles that. got %q", pos.Status)
	}
}

func TestExecuteSocialTimeExit_BracketLegPartiallyFilled_SkipsMarketSell(t *testing.T) {
	trading := newRecordingTrading()
	// "partially_filled" must be treated like "filled" — the broker has
	// already touched the position; placing a market sell could over-sell.
	trading.orderStatuses["stop-1"] = "canceled"
	trading.orderStatuses["tp-1"] = "partially_filled"

	pos := &ManagedPosition{
		ID:                "p1",
		Symbol:            "ABCD",
		Side:              "buy",
		RemainingQty:      100,
		Status:            "ACTIVE",
		DominantSignal:    "social",
		AgentStrategy:     "penny-momentum",
		StopLossOrderID:   "stop-1",
		TakeProfitOrderID: "tp-1",
		CreatedAt:         time.Now().Add(-21 * time.Minute),
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": pos})

	if err := pm.executeSocialTimeExit(context.Background(), pos); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}
	if len(trading.placedOrders) != 0 {
		t.Errorf("expected 0 market sells when bracket leg partially filled, got %d", len(trading.placedOrders))
	}
}

func TestExecuteSocialTimeExit_CancelsPartialExitOrders(t *testing.T) {
	trading := newRecordingTrading()

	pos := &ManagedPosition{
		ID:                "p1",
		Symbol:            "ABCD",
		Side:              "buy",
		RemainingQty:      50, // half exited via partial; remainder is 50
		Status:            "PARTIAL",
		DominantSignal:    "social",
		AgentStrategy:     "penny-momentum",
		StopLossOrderID:   "stop-1",
		TakeProfitOrderID: "tp-1",
		PartialExitOrders: []string{"pe-1", "pe-2"},
		CreatedAt:         time.Now().Add(-21 * time.Minute),
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": pos})

	if err := pm.executeSocialTimeExit(context.Background(), pos); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}

	cancelOrderIDs(t, trading.cancelOrders, "stop-1", "tp-1", "pe-1", "pe-2")
	if len(trading.cancelOrders) != 4 {
		t.Errorf("expected 4 cancels total (2 bracket + 2 partial-exit), got %d: %v", len(trading.cancelOrders), trading.cancelOrders)
	}

	if len(trading.placedOrders) != 1 {
		t.Fatalf("expected 1 market sell for remaining 50 shares, got %d", len(trading.placedOrders))
	}
	if trading.placedOrders[0].Qty != 50 {
		t.Errorf("expected market sell Qty=50 (remainder after partial), got %v", trading.placedOrders[0].Qty)
	}
}

func TestExecuteSocialTimeExit_PartialExitsCancelledEvenWhenBracketFilled(t *testing.T) {
	// Even if a bracket leg fills mid-cancel (so we skip the market sell),
	// unfilled partial-exit limits must still be cancelled — they would
	// otherwise remain live at the broker as orphans.
	trading := newRecordingTrading()
	trading.orderStatuses["stop-1"] = "filled"

	pos := &ManagedPosition{
		ID:                "p1",
		Symbol:            "ABCD",
		Side:              "buy",
		RemainingQty:      50,
		Status:            "PARTIAL",
		DominantSignal:    "social",
		AgentStrategy:     "penny-momentum",
		StopLossOrderID:   "stop-1",
		PartialExitOrders: []string{"pe-1"},
		CreatedAt:         time.Now().Add(-21 * time.Minute),
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": pos})

	if err := pm.executeSocialTimeExit(context.Background(), pos); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}

	cancelOrderIDs(t, trading.cancelOrders, "stop-1", "pe-1")
	if len(trading.placedOrders) != 0 {
		t.Errorf("expected 0 market sells (bracket already closed position), got %d", len(trading.placedOrders))
	}
}

func TestExecuteSocialTimeExit_AgentStrategyEmptyFallsBackToPennyMomentum(t *testing.T) {
	trading := newRecordingTrading()

	pos := &ManagedPosition{
		ID:              "p1",
		Symbol:          "ABCD",
		Side:            "buy",
		RemainingQty:    100,
		Status:          "ACTIVE",
		DominantSignal:  "social",
		AgentStrategy:   "", // legacy / pre-rename position
		StopLossOrderID: "stop-1",
		CreatedAt:       time.Now().Add(-21 * time.Minute),
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": pos})

	if err := pm.executeSocialTimeExit(context.Background(), pos); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}
	if len(trading.placedOrders) != 1 {
		t.Fatalf("expected 1 market sell, got %d", len(trading.placedOrders))
	}
	if trading.placedOrders[0].Strategy != "penny-momentum" {
		t.Errorf("expected fallback Strategy=penny-momentum for empty AgentStrategy, got %q", trading.placedOrders[0].Strategy)
	}
}

func TestExecuteSocialTimeExit_AgentStrategyPreserved(t *testing.T) {
	trading := newRecordingTrading()

	pos := &ManagedPosition{
		ID:              "p1",
		Symbol:          "ABCD",
		Side:            "buy",
		RemainingQty:    100,
		Status:          "ACTIVE",
		DominantSignal:  "social",
		AgentStrategy:   "penny-momentum",
		StopLossOrderID: "stop-1",
		CreatedAt:       time.Now().Add(-21 * time.Minute),
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": pos})

	if err := pm.executeSocialTimeExit(context.Background(), pos); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}
	if trading.placedOrders[0].Strategy != "penny-momentum" {
		t.Errorf("expected Strategy=penny-momentum, got %q", trading.placedOrders[0].Strategy)
	}
}

func TestExecuteSocialTimeExit_LivePositionAlreadyClosed_SkipsMarketSell(t *testing.T) {
	// pos (the snapshot the caller passes) still says ACTIVE, but the live
	// pointer in pm.positions has been transitioned to CLOSED on a prior tick.
	// executeSocialTimeExit must trust the live state, not the snapshot.
	trading := newRecordingTrading()

	snapshot := &ManagedPosition{
		ID:              "p1",
		Symbol:          "ABCD",
		Side:            "buy",
		RemainingQty:    100,
		Status:          "ACTIVE",
		DominantSignal:  "social",
		AgentStrategy:   "penny-momentum",
		StopLossOrderID: "stop-1",
		CreatedAt:       time.Now().Add(-21 * time.Minute),
	}
	// RemainingQty deliberately non-zero so the Status==CLOSED check is the
	// only thing that triggers the early return — otherwise the zero-qty
	// branch could mask a regression in the Status check.
	live := &ManagedPosition{
		ID:           "p1",
		Status:       "CLOSED",
		RemainingQty: 100,
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": live})

	if err := pm.executeSocialTimeExit(context.Background(), snapshot); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}
	if len(trading.placedOrders) != 0 {
		t.Errorf("expected 0 market sells when live position is CLOSED, got %d", len(trading.placedOrders))
	}
}

func TestExecuteSocialTimeExit_LivePositionZeroRemaining_SkipsMarketSell(t *testing.T) {
	trading := newRecordingTrading()

	snapshot := &ManagedPosition{
		ID:              "p1",
		Symbol:          "ABCD",
		Side:            "buy",
		RemainingQty:    100,
		Status:          "ACTIVE",
		DominantSignal:  "social",
		AgentStrategy:   "penny-momentum",
		StopLossOrderID: "stop-1",
		CreatedAt:       time.Now().Add(-21 * time.Minute),
	}
	live := &ManagedPosition{
		ID:           "p1",
		Status:       "ACTIVE", // status didn't flip yet but qty drained
		RemainingQty: 0,
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": live})

	if err := pm.executeSocialTimeExit(context.Background(), snapshot); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}
	if len(trading.placedOrders) != 0 {
		t.Errorf("expected 0 market sells when RemainingQty=0, got %d", len(trading.placedOrders))
	}
}

func TestExecuteSocialTimeExit_ShortPositionFlipsToBuy(t *testing.T) {
	// Defensive: penny is long-only today, but if a short ever gets opened
	// the exit must cover (buy) not sell-more.
	trading := newRecordingTrading()

	pos := &ManagedPosition{
		ID:              "p1",
		Symbol:          "ABCD",
		Side:            "sell",
		RemainingQty:    100,
		Status:          "ACTIVE",
		DominantSignal:  "social",
		AgentStrategy:   "penny-momentum",
		StopLossOrderID: "stop-1",
		CreatedAt:       time.Now().Add(-21 * time.Minute),
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": pos})

	if err := pm.executeSocialTimeExit(context.Background(), pos); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}
	if len(trading.placedOrders) != 1 {
		t.Fatalf("expected 1 market order, got %d", len(trading.placedOrders))
	}
	if trading.placedOrders[0].Side != "buy" {
		t.Errorf("expected short cover with Side=buy, got %q", trading.placedOrders[0].Side)
	}
}

func TestExecuteSocialTimeExit_EmptyOrderIDsAreSkipped(t *testing.T) {
	// A position whose bracket orders never got placed (e.g., bracket
	// failed) should not panic or call CancelOrder("").
	trading := newRecordingTrading()

	pos := &ManagedPosition{
		ID:                "p1",
		Symbol:            "ABCD",
		Side:              "buy",
		RemainingQty:      100,
		Status:            "ACTIVE",
		DominantSignal:    "social",
		AgentStrategy:     "penny-momentum",
		StopLossOrderID:   "",
		TakeProfitOrderID: "",
		CreatedAt:         time.Now().Add(-21 * time.Minute),
	}
	pm := newTestPositionManager(trading, map[string]*ManagedPosition{"p1": pos})

	if err := pm.executeSocialTimeExit(context.Background(), pos); err != nil {
		t.Fatalf("executeSocialTimeExit: %v", err)
	}

	if len(trading.cancelOrders) != 0 {
		t.Errorf("expected 0 cancels for empty order IDs, got %d: %v", len(trading.cancelOrders), trading.cancelOrders)
	}
	if len(trading.placedOrders) != 1 {
		t.Errorf("expected 1 market sell, got %d", len(trading.placedOrders))
	}
}
