package services

import (
	"context"
	"errors"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"sync"
	"testing"
)

// TestRoundToTick pins the Alpaca tick-rounding contract. The two real
// rejections that motivated this code were LAND ($9.49 entry → 0.9× stop
// = $8.541, rejected with HTTP 422 code 42210000) and III ($4.18 → $3.762,
// same rejection). Both must snap to $0.01 after rounding.
func TestRoundToTick(t *testing.T) {
	cases := []struct {
		name string
		in   float64
		want float64
	}{
		{"LAND stop reproduces production rejection", 8.541, 8.54},
		{"LAND target reproduces production rejection", 11.388, 11.39},
		{"III stop reproduces production rejection", 3.762, 3.76},
		{"III target reproduces production float artifact", 5.015999999999999, 5.02},
		{"already-clean cent-tick is idempotent", 4.18, 4.18},
		{"sub-$1 keeps four-decimal sub-penny resolution", 0.5432, 0.5432},
		{"exact $1.00 uses cent tick", 1.0, 1.00},
		{"just-below-$1 keeps sub-penny", 0.999, 0.999},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := roundToTick(tc.in)
			if got != tc.want {
				t.Errorf("roundToTick(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestCalculateStopLoss_RoundsToTick verifies the calculator that feeds
// PlaceManagedPosition no longer emits sub-penny stop prices. Before the fix,
// entryPrice=9.49 with stopPercent=10 returned 8.541 — exactly the value
// Alpaca rejected for LAND on 2026-05-18.
func TestCalculateStopLoss_RoundsToTick(t *testing.T) {
	pm := &PositionManager{}
	stopPct := 10.0
	got := pm.calculateStopLoss(9.49, nil, &stopPct, "buy")
	if got != 8.54 {
		t.Errorf("calculateStopLoss(9.49, 10%%) = %v, want 8.54 (was 8.541 pre-fix)", got)
	}
}

// TestCalculateTakeProfit_RoundsToTick mirrors the stop test for the target.
// 9.49 + 20% = 11.388 pre-fix; post-fix it must be 11.39.
func TestCalculateTakeProfit_RoundsToTick(t *testing.T) {
	pm := &PositionManager{}
	pct := 20.0
	got := pm.calculateTakeProfit(9.49, nil, &pct, "buy")
	if got != 11.39 {
		t.Errorf("calculateTakeProfit(9.49, 20%%) = %v, want 11.39 (was 11.388 pre-fix)", got)
	}
}

// stubTradingBracketScenarios records every order placed and lets a test
// inject failure on the first stop, the first take-profit, etc. This lets us
// exercise the auto-flatten path without a real broker.
type stubTradingBracketScenarios struct {
	*stubTrading
	mu             sync.Mutex
	recorded       []*interfaces.Order
	failNextStop   bool   // fail the next "stop" type order
	failAllStops   bool   // fail every "stop" type order
	failAllLimits  bool   // fail every "limit" type order (take-profit, partial)
	failureMessage string // error text returned to the caller
}

func (s *stubTradingBracketScenarios) PlaceOrder(_ context.Context, order *interfaces.Order) (*interfaces.OrderResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Record a copy so the test inspects what was sent at the moment of the
	// call, not a later-mutated pointer.
	cp := *order
	s.recorded = append(s.recorded, &cp)

	msg := s.failureMessage
	if msg == "" {
		msg = "simulated broker rejection"
	}

	if order.Type == "stop" {
		if s.failAllStops || s.failNextStop {
			s.failNextStop = false
			return nil, errors.New(msg)
		}
	}
	if order.Type == "limit" && s.failAllLimits {
		return nil, errors.New(msg)
	}

	return &interfaces.OrderResult{
		OrderID: "stub-" + order.Symbol + "-" + order.Type,
		Status:  "accepted",
	}, nil
}

func (s *stubTradingBracketScenarios) ordersByType(orderType string) []*interfaces.Order {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*interfaces.Order, 0)
	for _, o := range s.recorded {
		if o.Type == orderType {
			out = append(out, o)
		}
	}
	return out
}

// TestPlaceRiskOrders_AutoFlattenOnPersistentStopFailure exercises the bug
// fix for Spark/LAND 2026-05-18. With the broker rejecting every stop-loss
// placement, the position must end up FAILED and a market sell must be
// dispatched — not silently left ACTIVE with no protection.
func TestPlaceRiskOrders_AutoFlattenOnPersistentStopFailure(t *testing.T) {
	storage, err := database.NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	trading := &stubTradingBracketScenarios{
		stubTrading:    &stubTrading{},
		failAllStops:   true,
		failureMessage: "invalid stop_price 8.541. sub-penny increment does not fulfill minimum pricing criteria",
	}
	pm := NewPositionManager(trading, nil, storage)

	pos := &ManagedPosition{
		ID:            "pos_test_LAND",
		Symbol:        "LAND",
		Side:          "buy",
		Quantity:      216,
		RemainingQty:  216,
		EntryPrice:    9.49,
		StopLossPrice: 8.54,
		AgentStrategy: "trend",
		Status:        "ACTIVE",
	}
	pm.positions[pos.ID] = pos

	pm.placeRiskOrders(context.Background(), pos)

	if pos.Status != "FAILED" {
		t.Errorf("position.Status = %q, want FAILED after persistent stop failure", pos.Status)
	}

	stopAttempts := trading.ordersByType("stop")
	if len(stopAttempts) != 2 {
		t.Errorf("expected exactly 2 stop attempts (initial + 1 retry), got %d", len(stopAttempts))
	}

	flattenOrders := trading.ordersByType("market")
	if len(flattenOrders) != 1 {
		t.Fatalf("expected 1 auto-flatten market sell, got %d", len(flattenOrders))
	}
	flat := flattenOrders[0]
	if flat.Symbol != "LAND" {
		t.Errorf("flatten.Symbol = %q, want LAND", flat.Symbol)
	}
	if flat.Side != "sell" {
		t.Errorf("flatten.Side = %q, want sell (closing a long)", flat.Side)
	}
	if flat.Qty != 216 {
		t.Errorf("flatten.Qty = %v, want 216 (full remaining)", flat.Qty)
	}
	if flat.Strategy != "trend" {
		t.Errorf("flatten.Strategy = %q, want trend (attribution must propagate)", flat.Strategy)
	}
}

// TestPlaceRiskOrders_RetrySucceedsAfterTransientStopFailure verifies that a
// single transient stop-placement failure does NOT trigger a flatten — the
// retry succeeds and the position stays ACTIVE.
func TestPlaceRiskOrders_RetrySucceedsAfterTransientStopFailure(t *testing.T) {
	storage, err := database.NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	trading := &stubTradingBracketScenarios{
		stubTrading:  &stubTrading{},
		failNextStop: true, // fail once then succeed
	}
	pm := NewPositionManager(trading, nil, storage)

	pos := &ManagedPosition{
		ID:              "pos_test_III",
		Symbol:          "III",
		Side:            "buy",
		Quantity:        490,
		RemainingQty:    490,
		EntryPrice:      4.18,
		StopLossPrice:   3.76,
		TakeProfitPrice: 5.02,

		Status:          "ACTIVE",
	}
	pm.positions[pos.ID] = pos

	pm.placeRiskOrders(context.Background(), pos)

	if pos.Status != "ACTIVE" {
		t.Errorf("position.Status = %q, want ACTIVE (transient stop failure should self-heal on retry)", pos.Status)
	}
	if len(trading.ordersByType("stop")) != 2 {
		t.Errorf("expected 2 stop attempts (initial fail + retry succeed), got %d", len(trading.ordersByType("stop")))
	}
	if len(trading.ordersByType("market")) != 0 {
		t.Errorf("expected 0 flatten orders on transient failure, got %d", len(trading.ordersByType("market")))
	}
	if len(trading.ordersByType("limit")) != 1 {
		t.Errorf("expected take-profit limit order after stop succeeded, got %d", len(trading.ordersByType("limit")))
	}
}

// TestPlaceRiskOrders_TakeProfitFailureDoesNotFlatten verifies the asymmetric
// failure policy: a missing take-profit is annoying but the position is still
// protected by the stop, so we don't force-close it.
func TestPlaceRiskOrders_TakeProfitFailureDoesNotFlatten(t *testing.T) {
	storage, err := database.NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	trading := &stubTradingBracketScenarios{
		stubTrading:   &stubTrading{},
		failAllLimits: true,
	}
	pm := NewPositionManager(trading, nil, storage)

	pos := &ManagedPosition{
		ID:              "pos_test_takeprofit_only",
		Symbol:          "ACME",
		Side:            "buy",
		Quantity:        100,
		RemainingQty:    100,
		EntryPrice:      5.00,
		StopLossPrice:   4.50,
		TakeProfitPrice: 6.00,

		Status:          "ACTIVE",
	}
	pm.positions[pos.ID] = pos

	pm.placeRiskOrders(context.Background(), pos)

	if pos.Status != "ACTIVE" {
		t.Errorf("position.Status = %q, want ACTIVE (target failure must not flatten)", pos.Status)
	}
	if len(trading.ordersByType("market")) != 0 {
		t.Errorf("unexpected flatten on take-profit-only failure: %d market orders", len(trading.ordersByType("market")))
	}
}

// TestPlaceStopLossOrder_SnapsSubPennyOnTheWayOut is the last-line-of-defense
// test. Even if a caller hands placeStopLossOrder a position with a 3-decimal
// StopLossPrice (e.g. a row loaded from a pre-fix DB), the order sent to the
// broker must carry a tick-aligned price.
func TestPlaceStopLossOrder_SnapsSubPennyOnTheWayOut(t *testing.T) {
	storage, err := database.NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	trading := &stubTradingBracketScenarios{stubTrading: &stubTrading{}}
	pm := NewPositionManager(trading, nil, storage)

	pos := &ManagedPosition{
		ID:            "pos_test_subpenny",
		Symbol:        "LAND",
		Side:          "buy",
		RemainingQty:  216,
		StopLossPrice: 8.541, // sub-penny — must be cleaned on the way out
	}

	if err := pm.placeStopLossOrder(context.Background(), pos); err != nil {
		t.Fatalf("placeStopLossOrder: %v", err)
	}

	if pos.StopLossPrice != 8.54 {
		t.Errorf("position.StopLossPrice = %v, want 8.54 after defensive snap", pos.StopLossPrice)
	}
	stops := trading.ordersByType("stop")
	if len(stops) != 1 {
		t.Fatalf("expected 1 stop order, got %d", len(stops))
	}
	if stops[0].StopPrice == nil {
		t.Fatal("stop order missing StopPrice")
	}
	if *stops[0].StopPrice != 8.54 {
		t.Errorf("broker received stop_price = %v, want 8.54", *stops[0].StopPrice)
	}
}
