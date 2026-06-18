package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// --- fakes ---

type fakeOptPositions struct {
	positions []*interfaces.OptionsPosition
	err       error
}

func (f *fakeOptPositions) ListOptionsPositions(_ context.Context) ([]*interfaces.OptionsPosition, error) {
	return f.positions, f.err
}

type fakeQuoter struct {
	snaps map[string]*interfaces.OptionContract
	err   error
}

func (f *fakeQuoter) GetOptionSnapshot(_ context.Context, sym string) (*interfaces.OptionContract, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.snaps[sym], nil
}

// recordingFlattener records every order/cancel so tests can assert no writes.
type recordingFlattener struct {
	placed   []*interfaces.OptionsOrder
	canceled []string
	orders   []*interfaces.Order // returned by ListOrders
	ordersErr error             // optional error from ListOrders
	byID     map[string]*interfaces.Order
}

func (f *recordingFlattener) PlaceOptionsOrder(_ context.Context, o *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	f.placed = append(f.placed, o)
	return &interfaces.OrderResult{OrderID: "new-" + o.Symbol, Status: "accepted"}, nil
}
func (f *recordingFlattener) ListOrders(_ context.Context, _ string) ([]*interfaces.Order, error) {
	return f.orders, f.ordersErr
}
func (f *recordingFlattener) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	if f.byID != nil {
		if o, ok := f.byID[id]; ok {
			return o, nil
		}
	}
	return &interfaces.Order{ID: id, Status: "canceled"}, nil
}
func (f *recordingFlattener) CancelOrder(_ context.Context, id string) error {
	f.canceled = append(f.canceled, id)
	return nil
}

func newTestMonitor(pos *fakeOptPositions, q *fakeQuoter, fl *recordingFlattener) *ProphetOptionsStopMonitor {
	m := NewProphetOptionsStopMonitor(pos, q, fl, ProphetOptionsStopConfig{
		StopPct:         0.50,
		Cooloff:         7 * time.Minute,
		Escalation:      60 * time.Second,
		SanityFloorFrac: 0.50,
	})
	m.SetBootTime(time.Date(2026, 5, 21, 13, 0, 0, 0, time.UTC))
	return m
}

func longPos(sym string, qty, entry, current, costBasis, unrealized float64) *interfaces.OptionsPosition {
	return &interfaces.OptionsPosition{
		Symbol: sym, Qty: qty, AvgEntryPrice: entry, CurrentPrice: current,
		CostBasis: costBasis, UnrealizedPL: unrealized, Side: "long",
	}
}

func TestMonitor_LossFraction(t *testing.T) {
	cases := []struct {
		name        string
		costBasis   float64
		unrealized  float64
		wantFrac    float64
		wantHasData bool
	}{
		{"down 60%", 5000, -3000, 0.60, true},
		{"down 50% exactly", 1000, -500, 0.50, true},
		{"up 20%", 1000, 200, -0.20, true},
		{"zero basis", 0, -100, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			frac, ok := lossFraction(&interfaces.OptionsPosition{CostBasis: tc.costBasis, UnrealizedPL: tc.unrealized})
			if ok != tc.wantHasData {
				t.Fatalf("ok=%v want %v", ok, tc.wantHasData)
			}
			if ok && frac != tc.wantFrac {
				t.Fatalf("frac=%v want %v", frac, tc.wantFrac)
			}
		})
	}
}

// symsOf is a tiny helper for assertion messages.
func symsOf(ps []*interfaces.OptionsPosition) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.Symbol
	}
	return out
}

func snap(bid, ask float64) *interfaces.OptionContract {
	return &interfaces.OptionContract{Bid: bid, Ask: ask, Premium: (bid + ask) / 2}
}

func TestMonitor_PlacesRung0OnTrigger(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos("NVDA_C", 10, 5, 2, 5000, -3000), // down 60%
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{v2OptionsFilledBuy("NVDA_C")}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute))) // grace satisfied
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 1 {
		t.Fatalf("got %d placements, want 1", len(fl.placed))
	}
	o := fl.placed[0]
	if o.Side != "sell" || o.PositionIntent != "sell_to_close" {
		t.Fatalf("got side=%s intent=%s, want sell/sell_to_close", o.Side, o.PositionIntent)
	}
	if o.Qty != 10 {
		t.Fatalf("got qty %v, want 10", o.Qty)
	}
	if o.LimitPrice == nil || *o.LimitPrice != 1.90 { // rung 0 = fresh bid
		t.Fatalf("got limit %v, want 1.90 (bid)", o.LimitPrice)
	}
	if o.ClientOrderID[:len(prophetStopCOIDTag)] != prophetStopCOIDTag {
		t.Fatalf("got coid %q, want %q prefix", o.ClientOrderID, prophetStopCOIDTag)
	}
}

func TestMonitor_NoDoubleSendWhenWorkingOrderExists(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "new",
			ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-10 * time.Second)},
		v2OptionsFilledBuy("NVDA_C"),
	}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 0 {
		t.Fatalf("within escalation window with a working order: want 0 placements, got %d", len(fl.placed))
	}
	if len(fl.canceled) != 0 {
		t.Fatalf("want 0 cancels (still inside window), got %d", len(fl.canceled))
	}
}

func TestMonitor_EscalatesAfterWindow_CancelConfirmThenWideLimit(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.40, 1.80)}} // mid 1.60
	working := &interfaces.Order{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "new",
		ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-120 * time.Second), FilledQty: 0}
	fl := &recordingFlattener{
		orders: []*interfaces.Order{working, v2OptionsFilledBuy("NVDA_C")},
		byID:   map[string]*interfaces.Order{"w1": {ID: "w1", Status: "canceled", FilledQty: 0}},
	}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.canceled) != 1 || fl.canceled[0] != "w1" {
		t.Fatalf("want cancel of w1, got %v", fl.canceled)
	}
	if len(fl.placed) != 1 {
		t.Fatalf("want 1 escalation placement, got %d", len(fl.placed))
	}
	// rung 1 terminal limit = sanityFloorFrac(0.50) * fresh mid(1.60) = 0.80
	if *fl.placed[0].LimitPrice != 0.80 {
		t.Fatalf("got limit %v, want 0.80 (sanity floor)", *fl.placed[0].LimitPrice)
	}
}

func TestMonitor_EscalationSizesAgainstRemainingQty(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.40, 1.80)}}
	working := &interfaces.Order{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "partially_filled",
		ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-120 * time.Second), FilledQty: 4}
	fl := &recordingFlattener{
		orders: []*interfaces.Order{working, v2OptionsFilledBuy("NVDA_C")},
		byID:   map[string]*interfaces.Order{"w1": {ID: "w1", Status: "canceled", FilledQty: 4}},
	}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 1 || fl.placed[0].Qty != 6 { // 10 - 4 filled
		t.Fatalf("want escalation qty 6, got %v", fl.placed)
	}
}

func TestMonitor_SanityFloorRestsWhenBidBelowFloor(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	// phantom: mid 1.60, floor 0.80, but bid collapsed to 0.05
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(0.05, 3.15)}}
	working := &interfaces.Order{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "new",
		ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-120 * time.Second)}
	fl := &recordingFlattener{orders: []*interfaces.Order{working, v2OptionsFilledBuy("NVDA_C")}, byID: map[string]*interfaces.Order{"w1": {ID: "w1", Status: "canceled"}}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 1 {
		t.Fatalf("want 1 placement resting at floor, got %d", len(fl.placed))
	}
	mid := (0.05 + 3.15) / 2 // 1.60
	if *fl.placed[0].LimitPrice != 0.50*mid { // never below floor
		t.Fatalf("got %v, want floor %v", *fl.placed[0].LimitPrice, 0.50*mid)
	}
}

func TestMonitor_CancelNotConfirmed_NoReplacement(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.40, 1.80)}}
	working := &interfaces.Order{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "new",
		ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-120 * time.Second)}
	// GetOrder still reports "new" → the cancel is NOT yet confirmed; the monitor
	// must NOT place a replacement (that would risk two live sell orders).
	fl := &recordingFlattener{
		orders: []*interfaces.Order{working, v2OptionsFilledBuy("NVDA_C")},
		byID:   map[string]*interfaces.Order{"w1": {ID: "w1", Status: "new"}},
	}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.canceled) != 1 {
		t.Fatalf("want cancel attempted once, got %d", len(fl.canceled))
	}
	if len(fl.placed) != 0 {
		t.Fatalf("cancel not confirmed: must NOT place a replacement, got %d", len(fl.placed))
	}
}

func TestMonitor_GraceSuppressesUntilBeatObserved(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{v2OptionsFilledBuy("NVDA_C")}}
	m := newTestMonitor(pos, q, fl)
	m.SetBootTime(now.Add(-30 * time.Second))

	// No beats observed at all → suppressed.
	m.SetBeatObserver(noBeats())
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("no beats: want 0 placements, got %d", len(fl.placed))
	}

	// A beat BEFORE boot → still suppressed (must be since boot).
	m.SetBeatObserver(beatObserved(now.Add(-90 * time.Second)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("pre-boot beat: want 0 placements, got %d", len(fl.placed))
	}

	// A beat AFTER boot → live.
	m.SetBeatObserver(beatObserved(now.Add(-10 * time.Second)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 1 {
		t.Fatalf("post-boot beat: want 1 placement, got %d", len(fl.placed))
	}
}

func TestMonitor_NoBeatObserverMeansGraceOff(t *testing.T) {
	// When no beat observer is wired, the monitor must not be permanently
	// dormant — it falls through to live.
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{v2OptionsFilledBuy("NVDA_C")}}
	m := newTestMonitor(pos, q, fl) // no SetBeatObserver
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 1 {
		t.Fatalf("no observer wired: want 1 placement (grace off), got %d", len(fl.placed))
	}
}

func TestMonitor_CooloffSuppressesWhenLLMActedRecently(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	// LLM bought-to-open NVDA_C 2 minutes ago (within 7m cool-off).
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "llm1", Symbol: "NVDA_C", Side: "buy", Status: "filled",
			ClientOrderID: "v2-options:abc", SubmittedAt: now.Add(-2 * time.Minute)},
	}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("recent LLM action: want 0 placements (cool-off), got %d", len(fl.placed))
	}
}

func TestMonitor_CooloffStaleActionDoesNotSuppress(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "llm1", Symbol: "NVDA_C", Side: "buy", Status: "filled",
			ClientOrderID: "v2-options:abc", SubmittedAt: now.Add(-30 * time.Minute)}, // stale
	}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 1 {
		t.Fatalf("stale LLM action: want 1 placement, got %d", len(fl.placed))
	}
}

func TestMonitor_MonitorOwnFlattenDoesNotTripCooloff(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.40, 1.80)}}
	// The monitor's own working flatten from 2 min ago (past escalation window).
	working := &interfaces.Order{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "new",
		ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-2 * time.Minute)}
	fl := &recordingFlattener{orders: []*interfaces.Order{working, v2OptionsFilledBuy("NVDA_C")}, byID: map[string]*interfaces.Order{"w1": {ID: "w1", Status: "canceled"}}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	// If the monitor's own order tripped the cool-off, it would suppress and not
	// escalate. It must escalate (cancel + replace).
	if len(fl.canceled) != 1 || len(fl.placed) != 1 {
		t.Fatalf("own flatten must not trip cool-off; got canceled=%d placed=%d", len(fl.canceled), len(fl.placed))
	}
}

func TestMonitor_StartTicksWhileOpenAndStops(t *testing.T) {
	pos := &fakeOptPositions{} // no positions → no orders
	fl := &recordingFlattener{}
	m := newTestMonitor(pos, &fakeQuoter{}, fl)

	ctx, cancel := context.WithCancel(context.Background())
	open := func() bool { return true }
	done := make(chan struct{})
	go func() { m.Start(ctx, time.Millisecond, time.Millisecond, open); close(done) }()
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Start did not return after ctx cancel")
	}
}

// beatObserved returns a beatObserver stub reporting a beat at t.
func beatObserved(t time.Time) beatObserver { return stubBeats{t: t, ok: true} }
func noBeats() beatObserver                 { return stubBeats{} }

type stubBeats struct {
	t  time.Time
	ok bool
}

func (s stubBeats) LastProphetBeat() (time.Time, bool) { return s.t, s.ok }

func TestAttributedToProphetSingleLeg(t *testing.T) {
	sym := "NVDA250620C00130000"
	buy := func(tag, status string, qty float64) *interfaces.Order {
		return &interfaces.Order{Symbol: sym, Side: "buy", Status: status, FilledQty: qty, ClientOrderID: tag}
	}
	cases := []struct {
		name   string
		orders []*interfaces.Order
		want   bool
	}{
		{"lone v2-options filled buy (qty)", []*interfaces.Order{buy("v2-options:a", "filled", 1)}, true},
		{"v2-options filled-status, qty unset", []*interfaces.Order{buy("v2-options:a", "filled", 0)}, true},
		{"v2-options + manual (untagged) buy", []*interfaces.Order{buy("v2-options:a", "filled", 1), buy("manual-uuid", "filled", 1)}, false},
		{"only v2-vertical buy", []*interfaces.Order{buy("v2-vertical:a", "filled", 1)}, false},
		{"only prophet-defensive buy", []*interfaces.Order{buy("prophet-defensive:a", "filled", 1)}, false},
		{"no buys", []*interfaces.Order{}, false},
		{"v2-options SELL only (no buy)", []*interfaces.Order{{Symbol: sym, Side: "sell", Status: "filled", FilledQty: 1, ClientOrderID: "v2-options:a"}}, false},
		{"unfilled v2-options buy (working)", []*interfaces.Order{buy("v2-options:a", "new", 0)}, false},
		{"different symbol v2-options buy", []*interfaces.Order{{Symbol: "AAPL250620C00200000", Side: "buy", Status: "filled", FilledQty: 1, ClientOrderID: "v2-options:a"}}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := attributedToProphetSingleLeg(sym, c.orders); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestHasPairedShort(t *testing.T) {
	longCall := "NVDA250620C00130000"
	shortCallSameClass := &interfaces.OptionsPosition{Symbol: "NVDA250620C00140000", Side: "short"}
	shortPutSameExp := &interfaces.OptionsPosition{Symbol: "NVDA250620P00120000", Side: "short"} // opposite type
	shortCallOtherExp := &interfaces.OptionsPosition{Symbol: "NVDA250718C00140000", Side: "short"}
	longSelf := &interfaces.OptionsPosition{Symbol: longCall, Side: "long"}

	cases := []struct {
		name string
		all  []*interfaces.OptionsPosition
		want bool
	}{
		{"same underlying+exp+type short", []*interfaces.OptionsPosition{longSelf, shortCallSameClass}, true},
		{"opposite type short", []*interfaces.OptionsPosition{longSelf, shortPutSameExp}, false},
		{"same type other expiration", []*interfaces.OptionsPosition{longSelf, shortCallOtherExp}, false},
		{"no short", []*interfaces.OptionsPosition{longSelf}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := hasPairedShort(longCall, c.all); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
	// Unparseable long symbol contributes no pairing.
	if hasPairedShort("NVDA_C", []*interfaces.OptionsPosition{{Symbol: "NVDA_C", Side: "short"}}) {
		t.Fatal("unparseable long symbol must not match")
	}
}

// v2OptionsFilledBuy is a stale, filled v2-options opening buy for sym — it
// satisfies Gate A attribution without tripping the cool-off (timestamp far in
// the past relative to the tests' "now").
func v2OptionsFilledBuy(sym string) *interfaces.Order {
	return &interfaces.Order{
		ID: "open-" + sym, Symbol: sym, Side: "buy", Status: "filled", FilledQty: 10,
		ClientOrderID: "v2-options:open-" + sym,
		SubmittedAt:   time.Date(2026, 5, 1, 14, 0, 0, 0, time.UTC),
	}
}

func TestMonitor_ScopeEligibleLongs(t *testing.T) {
	attributed := "NVDA250620C00130000"
	all := []*interfaces.OptionsPosition{
		longPos(attributed, 1, 5, 2, 500, -300),                                  // v2-options long → eligible
		{Symbol: "SPY250620C00500000", Qty: -10, Side: "short", CostBasis: -500}, // short → never eligible
		longPos("AMZN250620C00200000", 1, 5, 2, 500, -300),                       // long but unattributed (no order)
	}
	orders := []*interfaces.Order{v2OptionsFilledBuy(attributed)}
	m := newTestMonitor(&fakeOptPositions{}, &fakeQuoter{}, &recordingFlattener{})

	got := m.scopeEligibleLongs(all, orders)
	if len(got) != 1 || got[0].Symbol != attributed {
		t.Fatalf("got %v, want only [%s]", symsOf(got), attributed)
	}
}

func TestMonitor_SkipsUnattributedManualLong(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos("NVDA250620C00130000", 1, 5, 2, 500, -300), // down 60%, past stop
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA250620C00130000": snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "manual1", Symbol: "NVDA250620C00130000", Side: "buy", Status: "filled", FilledQty: 1,
			ClientOrderID: "manual-uuid", SubmittedAt: now.Add(-48 * time.Hour)}, // untagged → unattributed
	}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("manual (unattributed) long must NOT be flattened, got %d placements", len(fl.placed))
	}
}

func TestMonitor_SkipsVerticalLeg(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	longSym, shortSym := "NVDA250620C00130000", "NVDA250620C00140000"
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos(longSym, 1, 5, 2, 500, -300),
		{Symbol: shortSym, Qty: -1, Side: "short", CostBasis: -200},
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{longSym: snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "v1", Symbol: longSym, Side: "buy", Status: "filled", FilledQty: 1,
			ClientOrderID: "v2-vertical:abc", SubmittedAt: now.Add(-48 * time.Hour)},
	}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("vertical long leg must NOT be flattened, got %d placements", len(fl.placed))
	}
}

func TestMonitor_GateC_SkipsAttributedLongWithPairedShort(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	longSym, shortSym := "NVDA250620C00130000", "NVDA250620C00140000"
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos(longSym, 1, 5, 2, 500, -300),
		{Symbol: shortSym, Qty: -1, Side: "short", CostBasis: -200},
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{longSym: snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{v2OptionsFilledBuy(longSym)}} // Gate A PASSES
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("attributed long with a same-class short must be skipped by Gate C, got %d", len(fl.placed))
	}
}

func TestMonitor_GateC_FlattensAttributedLongWithoutPair(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	longSym := "NVDA250620C00130000"
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos(longSym, 1, 5, 2, 500, -300)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{longSym: snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{v2OptionsFilledBuy(longSym)}}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 1 {
		t.Fatalf("attributed long with no paired short must flatten, got %d", len(fl.placed))
	}
}

func TestMonitor_ListOrdersError_SkipsTick(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos("NVDA250620C00130000", 1, 5, 2, 500, -300),
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA250620C00130000": snap(1.90, 2.10)}}
	fl := &recordingFlattener{ordersErr: errors.New("boom")}
	m := newTestMonitor(pos, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("ListOrders error must skip the whole tick, got %d placements", len(fl.placed))
	}
}
