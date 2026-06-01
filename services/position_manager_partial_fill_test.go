package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// entryFillTrading scripts the entry order's GetOrder response and records
// bracket PlaceOrder calls and CancelOrder calls. Embeds the package stubTrading
// (trade_guard_test.go) for the rest of the TradingService surface.
//
// It models the III-on-Spark failure: an entry order that comes back
// partially_filled (2 of 98), where the managed row must converge to broker
// truth instead of hanging PENDING forever with the real shares unprotected.
type entryFillTrading struct {
	*stubTrading
	entryOrder *interfaces.Order // returned by GetOrder for any id (the entry order)
	placed     []*interfaces.Order
	canceled   []string
}

func (s *entryFillTrading) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	if s.entryOrder != nil {
		return s.entryOrder, nil
	}
	return &interfaces.Order{ID: id, Status: "accepted"}, nil
}

func (s *entryFillTrading) PlaceOrder(_ context.Context, o *interfaces.Order) (*interfaces.OrderResult, error) {
	s.placed = append(s.placed, o)
	return &interfaces.OrderResult{OrderID: "bracket-1", Status: "accepted"}, nil
}

func (s *entryFillTrading) CancelOrder(_ context.Context, id string) error {
	s.canceled = append(s.canceled, id)
	return nil
}

func (s *entryFillTrading) canceledContains(id string) bool {
	for _, c := range s.canceled {
		if c == id {
			return true
		}
	}
	return false
}

func fptr(f float64) *float64 { return &f }

// THE III BUG: a partial entry fill (2 of 98) must NOT leave the position stuck
// PENDING. The position should go ACTIVE on the filled quantity, resize to the
// real fill, cancel the unfilled remainder so it can't fill later and re-desync,
// and place a protective bracket on the shares actually held.
func TestCheckEntryOrder_PartialFill_AcceptsAndCancelsRemainder(t *testing.T) {
	avg := 4.47
	trading := &entryFillTrading{
		stubTrading: &stubTrading{},
		entryOrder: &interfaces.Order{
			ID: "entry-1", Status: "partially_filled", FilledQty: 2, FilledAvgPrice: &avg,
		},
	}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{
		Symbol: "III", Side: "buy", Status: "PENDING",
		Quantity: 98, RemainingQty: 98, EntryOrderID: "entry-1",
		EntryPrice: 5.07, StopLossPrice: 4.56, TakeProfitPrice: 6.08,

	}
	injectPosition(pm, pos)

	pm.checkEntryOrder(context.Background(), pos)

	if pos.Status != "ACTIVE" {
		t.Fatalf("status = %q, want ACTIVE (partial fill must not stay PENDING — the III hang)", pos.Status)
	}
	if pos.Quantity != 2 {
		t.Errorf("Quantity = %v, want 2 (resized to the real fill)", pos.Quantity)
	}
	if pos.RemainingQty != 2 {
		t.Errorf("RemainingQty = %v, want 2", pos.RemainingQty)
	}
	if pos.EntryPrice != 4.47 {
		t.Errorf("EntryPrice = %v, want 4.47 (broker fill avg)", pos.EntryPrice)
	}
	if !trading.canceledContains("entry-1") {
		t.Errorf("entry remainder not cancelled: canceled=%v", trading.canceled)
	}
	if len(trading.placed) == 0 {
		t.Errorf("no protective bracket placed on the filled shares")
	}
	// Persisted ACTIVE so a reload doesn't resurrect a PENDING phantom.
	saved, err := pm.storageService.GetManagedPosition(pos.ID)
	if err != nil {
		t.Fatalf("GetManagedPosition: %v", err)
	}
	if saved.Status != "ACTIVE" {
		t.Errorf("persisted status = %q, want ACTIVE", saved.Status)
	}
}

// A broker-rejected entry (0 filled) must go terminal (FAILED), not hang PENDING
// forever. No bracket, no flatten (nothing was filled).
func TestCheckEntryOrder_Rejected_MarksFailed(t *testing.T) {
	trading := &entryFillTrading{
		stubTrading: &stubTrading{},
		entryOrder:  &interfaces.Order{ID: "entry-1", Status: "rejected", FilledQty: 0},
	}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{
		Symbol: "III", Side: "buy", Status: "PENDING",
		Quantity: 98, RemainingQty: 98, EntryOrderID: "entry-1",

	}
	injectPosition(pm, pos)

	pm.checkEntryOrder(context.Background(), pos)

	if pos.Status != "FAILED" {
		t.Fatalf("status = %q, want FAILED (rejected entry must not hang PENDING)", pos.Status)
	}
	if len(trading.placed) != 0 {
		t.Errorf("placed %d orders, want 0 (nothing filled — no bracket)", len(trading.placed))
	}
}

// Regression guard: a full fill still activates exactly as before — preserves
// existing behavior while the new branches are added.
func TestCheckEntryOrder_FullFill_StillActivates(t *testing.T) {
	avg := 5.07
	trading := &entryFillTrading{
		stubTrading: &stubTrading{},
		entryOrder:  &interfaces.Order{ID: "entry-1", Status: "filled", FilledQty: 98, FilledAvgPrice: &avg},
	}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{
		Symbol: "III", Side: "buy", Status: "PENDING",
		Quantity: 98, RemainingQty: 98, EntryOrderID: "entry-1",
		StopLossPrice: 4.56, TakeProfitPrice: 6.08,

	}
	injectPosition(pm, pos)

	pm.checkEntryOrder(context.Background(), pos)

	if pos.Status != "ACTIVE" {
		t.Fatalf("status = %q, want ACTIVE", pos.Status)
	}
	if pos.Quantity != 98 {
		t.Errorf("Quantity = %v, want 98 (full fill unchanged)", pos.Quantity)
	}
	if pos.EntryPrice != 5.07 {
		t.Errorf("EntryPrice = %v, want 5.07", pos.EntryPrice)
	}
	// A full fill leaves nothing to cancel.
	if trading.canceledContains("entry-1") {
		t.Errorf("entry order cancelled on a full fill — should not happen")
	}
	_ = time.Now
}
