package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// These tests cover the stuck-exit escalation path: when the LLM (v2-options)
// repeatedly places non-marketable sell limits that cancel unfilled, the monitor
// takes over and crosses the spread with a marketable flatten — independent of
// P&L (the position is typically a thesis-broken WINNER, so the loss-stop never
// fires). They reuse the fakes defined in prophet_options_stop_monitor_test.go.

// enableStuck turns on the stuck-exit trigger with the production defaults.
func enableStuck(m *ProphetOptionsStopMonitor) *ProphetOptionsStopMonitor {
	m.cfg.StuckExitEnabled = true
	m.cfg.StuckExitWindow = 5 * time.Minute
	m.cfg.StuckExitMinReprices = 3
	return m
}

// llmSell builds an LLM-tagged (v2-options) sell order.
func llmSell(id, sym, status string, filledQty float64, ageSec int, now time.Time) *interfaces.Order {
	return &interfaces.Order{
		ID: id, Symbol: sym, Side: "sell", Status: status,
		ClientOrderID: "v2-options:" + id,
		SubmittedAt:   now.Add(-time.Duration(ageSec) * time.Second),
		FilledQty:     filledQty,
	}
}

// winnerPos is a long option that is UP (so the loss-stop never triggers).
// costBasis 5490 = 27.45 * 2 * 100; +740 unrealized → lossFraction ≈ -0.13.
func winnerPos(sym string) *interfaces.OptionsPosition {
	return longPos(sym, 2, 27.45, 31.15, 5490, 740)
}

func TestStuckExit_PlacesMarketableFlattenWhenLLMStuck(t *testing.T) {
	now := time.Date(2026, 6, 2, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{winnerPos("MSFT_C")}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"MSFT_C": snap(31.00, 31.30)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		llmSell("a", "MSFT_C", "canceled", 0, 300, now),
		llmSell("b", "MSFT_C", "canceled", 0, 200, now),
		llmSell("c", "MSFT_C", "canceled", 0, 90, now),
	}}
	m := enableStuck(newTestMonitor(pos, &fakeCondorLegs{}, q, fl))
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 1 {
		t.Fatalf("got %d placements, want 1", len(fl.placed))
	}
	o := fl.placed[0]
	if o.Side != "sell" || o.PositionIntent != "sell_to_close" {
		t.Fatalf("got side=%s intent=%s, want sell/sell_to_close", o.Side, o.PositionIntent)
	}
	if o.Qty != 2 {
		t.Fatalf("got qty %v, want 2 (full position)", o.Qty)
	}
	if o.LimitPrice == nil || *o.LimitPrice != 31.00 { // rung 0 = marketable limit at bid
		t.Fatalf("got limit %v, want 31.00 (bid)", o.LimitPrice)
	}
	if o.ClientOrderID[:len(prophetStopCOIDTag)] != prophetStopCOIDTag {
		t.Fatalf("got coid %q, want %q prefix", o.ClientOrderID, prophetStopCOIDTag)
	}
}

func TestStuckExit_BelowRepriceThresholdNoAction(t *testing.T) {
	now := time.Date(2026, 6, 2, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{winnerPos("MSFT_C")}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"MSFT_C": snap(31.00, 31.30)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		llmSell("a", "MSFT_C", "canceled", 0, 200, now),
		llmSell("b", "MSFT_C", "canceled", 0, 90, now),
	}}
	m := enableStuck(newTestMonitor(pos, &fakeCondorLegs{}, q, fl))
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 0 {
		t.Fatalf("2 reprices (< threshold 3): want 0 placements, got %d", len(fl.placed))
	}
}

func TestStuckExit_DisabledNoAction(t *testing.T) {
	now := time.Date(2026, 6, 2, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{winnerPos("MSFT_C")}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"MSFT_C": snap(31.00, 31.30)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		llmSell("a", "MSFT_C", "canceled", 0, 300, now),
		llmSell("b", "MSFT_C", "canceled", 0, 200, now),
		llmSell("c", "MSFT_C", "canceled", 0, 90, now),
	}}
	// NOTE: enableStuck NOT called → flag default OFF.
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 0 {
		t.Fatalf("flag OFF: want 0 placements even at 3+ reprices, got %d", len(fl.placed))
	}
}

func TestStuckExit_RecentFillMeansProgressNoAction(t *testing.T) {
	now := time.Date(2026, 6, 2, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{winnerPos("MSFT_C")}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"MSFT_C": snap(31.00, 31.30)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		llmSell("a", "MSFT_C", "canceled", 0, 300, now),
		llmSell("b", "MSFT_C", "canceled", 0, 200, now),
		llmSell("c", "MSFT_C", "canceled", 0, 90, now),
		// A recent partial fill: the LLM IS making progress → not stuck.
		llmSell("d", "MSFT_C", "partially_filled", 1, 30, now),
	}}
	m := enableStuck(newTestMonitor(pos, &fakeCondorLegs{}, q, fl))
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 0 {
		t.Fatalf("recent fill = progress: want 0 placements, got %d", len(fl.placed))
	}
}

func TestStuckExit_MonitorOwnOrdersDoNotCount(t *testing.T) {
	now := time.Date(2026, 6, 2, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{winnerPos("MSFT_C")}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"MSFT_C": snap(31.00, 31.30)}}
	// Three canceled flattens tagged as the monitor's OWN (v2-options-stop), not the LLM.
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "s1", Symbol: "MSFT_C", Side: "sell", Status: "canceled", ClientOrderID: "v2-options-stop:MSFT_C:1", SubmittedAt: now.Add(-300 * time.Second)},
		{ID: "s2", Symbol: "MSFT_C", Side: "sell", Status: "canceled", ClientOrderID: "v2-options-stop:MSFT_C:2", SubmittedAt: now.Add(-200 * time.Second)},
		{ID: "s3", Symbol: "MSFT_C", Side: "sell", Status: "canceled", ClientOrderID: "v2-options-stop:MSFT_C:3", SubmittedAt: now.Add(-90 * time.Second)},
	}}
	m := enableStuck(newTestMonitor(pos, &fakeCondorLegs{}, q, fl))
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 0 {
		t.Fatalf("monitor's own canceled orders must not count as LLM reprices: want 0, got %d", len(fl.placed))
	}
}

func TestStuckExit_LossPathTakesPrecedenceAndCooloffStillApplies(t *testing.T) {
	now := time.Date(2026, 6, 2, 15, 0, 0, 0, time.UTC)
	// Loss-triggered position (down ~60%) AND a recent LLM buy (cool-off active).
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos("MSFT_C", 2, 27.45, 11, 5490, -3290), // frac ≈ 0.60 ≥ StopPct
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"MSFT_C": snap(11.00, 11.40)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "buy1", Symbol: "MSFT_C", Side: "buy", Status: "filled", ClientOrderID: "v2-options:buy1", SubmittedAt: now.Add(-2 * time.Minute)},
		llmSell("a", "MSFT_C", "canceled", 0, 300, now),
		llmSell("b", "MSFT_C", "canceled", 0, 200, now),
		llmSell("c", "MSFT_C", "canceled", 0, 90, now),
	}}
	m := enableStuck(newTestMonitor(pos, &fakeCondorLegs{}, q, fl))
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	// Loss path runs (frac ≥ StopPct), cool-off suppresses; the stuck path must
	// NOT override the loss-path cool-off.
	if len(fl.placed) != 0 {
		t.Fatalf("loss-triggered + cool-off: want 0 placements, got %d", len(fl.placed))
	}
}

func TestStuckExit_CancelsWorkingLLMSellThenPlaces(t *testing.T) {
	now := time.Date(2026, 6, 2, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{winnerPos("MSFT_C")}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"MSFT_C": snap(31.00, 31.30)}}
	// 3 prior canceled reprices + 1 currently-working LLM sell holding the qty.
	working := llmSell("w", "MSFT_C", "new", 0, 5, now)
	fl := &recordingFlattener{
		orders: []*interfaces.Order{
			llmSell("a", "MSFT_C", "canceled", 0, 300, now),
			llmSell("b", "MSFT_C", "canceled", 0, 200, now),
			llmSell("c", "MSFT_C", "canceled", 0, 90, now),
			working,
		},
		byID: map[string]*interfaces.Order{"w": {ID: "w", Status: "canceled", FilledQty: 0}},
	}
	m := enableStuck(newTestMonitor(pos, &fakeCondorLegs{}, q, fl))
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.canceled) != 1 || fl.canceled[0] != "w" {
		t.Fatalf("must cancel the working LLM sell to free qty; got cancels %v", fl.canceled)
	}
	if len(fl.placed) != 1 || fl.placed[0].LimitPrice == nil || *fl.placed[0].LimitPrice != 31.00 {
		t.Fatalf("must place marketable flatten at bid after freeing qty; got %v", fl.placed)
	}
}

func TestStuckExit_NoDoubleSendWhenMonitorOrderWorking(t *testing.T) {
	now := time.Date(2026, 6, 2, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{winnerPos("MSFT_C")}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"MSFT_C": snap(31.00, 31.30)}}
	// Stuck pattern present, but the monitor already has a working flatten inside
	// the escalation window → it must not place a second order.
	monitorWorking := &interfaces.Order{ID: "mw", Symbol: "MSFT_C", Side: "sell", Status: "new",
		ClientOrderID: "v2-options-stop:MSFT_C:1", SubmittedAt: now.Add(-10 * time.Second)}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		llmSell("a", "MSFT_C", "canceled", 0, 300, now),
		llmSell("b", "MSFT_C", "canceled", 0, 200, now),
		llmSell("c", "MSFT_C", "canceled", 0, 90, now),
		monitorWorking,
	}}
	m := enableStuck(newTestMonitor(pos, &fakeCondorLegs{}, q, fl))
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 0 || len(fl.canceled) != 0 {
		t.Fatalf("monitor order working inside escalation window: want 0/0, got placed=%d canceled=%d", len(fl.placed), len(fl.canceled))
	}
}
