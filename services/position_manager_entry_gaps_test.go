package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// seqEntryTrading returns a scripted SEQUENCE of GetOrder responses (the last
// element repeats once the sequence is exhausted) and records bracket/flatten
// PlaceOrder calls and CancelOrder calls. It models broker truth EVOLVING
// across the status-read → cancel → re-read window that checkEntryOrder must
// converge on. Embeds the base stubTrading (trade_guard_test.go) for the rest
// of the TradingService surface.
type seqEntryTrading struct {
	*stubTrading
	getOrders []*interfaces.Order
	getIdx    int
	canceled  []string
	placed    []*interfaces.Order
}

func (s *seqEntryTrading) GetOrder(_ context.Context, _ string) (*interfaces.Order, error) {
	i := s.getIdx
	if i >= len(s.getOrders) {
		i = len(s.getOrders) - 1
	}
	s.getIdx++
	return s.getOrders[i], nil
}

func (s *seqEntryTrading) CancelOrder(_ context.Context, id string) error {
	s.canceled = append(s.canceled, id)
	return nil
}

func (s *seqEntryTrading) PlaceOrder(_ context.Context, o *interfaces.Order) (*interfaces.OrderResult, error) {
	s.placed = append(s.placed, o)
	return &interfaces.OrderResult{OrderID: "x-1", Status: "accepted"}, nil
}

func (s *seqEntryTrading) canceledContains(id string) bool {
	for _, c := range s.canceled {
		if c == id {
			return true
		}
	}
	return false
}

// D1 residual race: between the status read and the cancel landing, MORE shares
// fill (2 → 5). The protective bracket must be sized to the FINAL filled qty
// read AFTER the cancel, not the stale pre-cancel qty — otherwise the extra 3
// shares are held unprotected, a smaller copy of the original partial-fill bug.
func TestCheckEntryOrder_PartialFill_BracketsTerminalQtyAfterCancel(t *testing.T) {
	pre := 4.40
	post := 4.50
	trading := &seqEntryTrading{
		stubTrading: &stubTrading{},
		getOrders: []*interfaces.Order{
			{ID: "entry-1", Status: "partially_filled", FilledQty: 2, FilledAvgPrice: &pre},
			{ID: "entry-1", Status: "canceled", FilledQty: 5, FilledAvgPrice: &post},
		},
	}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{
		Symbol: "III", Side: "buy", Status: "PENDING",
		Quantity: 98, RemainingQty: 98, EntryOrderID: "entry-1",
		StopLossPrice: 4.10, TakeProfitPrice: 5.40, AgentStrategy: "penny-momentum",
		CreatedAt: time.Now(),
	}
	injectPosition(pm, pos)

	pm.checkEntryOrder(context.Background(), pos)

	if pos.Status != "ACTIVE" {
		t.Fatalf("status = %q, want ACTIVE", pos.Status)
	}
	if pos.Quantity != 5 {
		t.Errorf("Quantity = %v, want 5 (terminal filled qty after cancel, not the stale pre-cancel 2)", pos.Quantity)
	}
	if pos.RemainingQty != 5 {
		t.Errorf("RemainingQty = %v, want 5", pos.RemainingQty)
	}
	if pos.EntryPrice != post {
		t.Errorf("EntryPrice = %v, want %v (terminal fill avg)", pos.EntryPrice, post)
	}
	if !trading.canceledContains("entry-1") {
		t.Errorf("entry remainder not cancelled: canceled=%v", trading.canceled)
	}
}

// D2: a PENDING entry that never progresses (0 filled, still "accepted") past
// the wall-clock timeout must terminalize to FAILED instead of hanging forever.
// The entry order is cancelled so it cannot fill later and re-desync.
func TestCheckEntryOrder_PendingTimeout_ZeroFill_MarksFailed(t *testing.T) {
	trading := &seqEntryTrading{
		stubTrading: &stubTrading{},
		getOrders: []*interfaces.Order{
			{ID: "entry-1", Status: "accepted", FilledQty: 0},
			{ID: "entry-1", Status: "canceled", FilledQty: 0},
		},
	}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{
		Symbol: "AAPL", Side: "buy", Status: "PENDING",
		Quantity: 10, RemainingQty: 10, EntryOrderID: "entry-1",
		AgentStrategy: "v2-options", CreatedAt: time.Now().Add(-301 * time.Second),
	}
	injectPosition(pm, pos)

	pm.checkEntryOrder(context.Background(), pos)

	if pos.Status != "FAILED" {
		t.Fatalf("status = %q, want FAILED (stuck PENDING entry must terminalize after timeout)", pos.Status)
	}
	if !trading.canceledContains("entry-1") {
		t.Errorf("stuck entry order not cancelled: canceled=%v", trading.canceled)
	}
	if len(trading.placed) != 0 {
		t.Errorf("placed %d orders, want 0 (nothing filled — no flatten)", len(trading.placed))
	}
}

// D2 stray-fill edge: the entry sat "accepted" with 0 filled, but a sliver
// (3 shares) filled in the cancel window. The timed-out entry must FAIL and
// FLATTEN exactly the stray shares actually held — never the ordered qty (10).
func TestCheckEntryOrder_PendingTimeout_StrayFill_Flattens(t *testing.T) {
	avg := 5.00
	trading := &seqEntryTrading{
		stubTrading: &stubTrading{},
		getOrders: []*interfaces.Order{
			{ID: "entry-1", Status: "accepted", FilledQty: 0},
			{ID: "entry-1", Status: "canceled", FilledQty: 3, FilledAvgPrice: &avg},
		},
	}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{
		Symbol: "AAPL", Side: "buy", Status: "PENDING",
		Quantity: 10, RemainingQty: 10, EntryOrderID: "entry-1",
		AgentStrategy: "v2-options", CreatedAt: time.Now().Add(-301 * time.Second),
	}
	injectPosition(pm, pos)

	pm.checkEntryOrder(context.Background(), pos)

	if pos.Status != "FAILED" {
		t.Fatalf("status = %q, want FAILED", pos.Status)
	}
	if len(trading.placed) != 1 {
		t.Fatalf("placed %d orders, want 1 (flatten the stray fill)", len(trading.placed))
	}
	if trading.placed[0].Qty != 3 {
		t.Errorf("flatten qty = %v, want 3 (the stray fill, not the ordered 10)", trading.placed[0].Qty)
	}
	if trading.placed[0].Side != "sell" {
		t.Errorf("flatten side = %q, want sell", trading.placed[0].Side)
	}
}
