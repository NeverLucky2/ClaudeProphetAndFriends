package services

import (
	"context"
	"fmt"
	"math"
	"sync/atomic"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// ── pure-function tests ────────────────────────────────────────────

func TestCalcSessionVWAP_Empty(t *testing.T) {
	if got := calcSessionVWAP(nil); got != 0 {
		t.Errorf("expected 0 for nil bars, got %f", got)
	}
}

func TestCalcSessionVWAP_SingleBar(t *testing.T) {
	bars := []*interfaces.Bar{{VWAP: 50.0, Volume: 100}}
	if got := calcSessionVWAP(bars); got != 50.0 {
		t.Errorf("expected 50.0, got %f", got)
	}
}

func TestCalcSessionVWAP_MultiBarWeighted(t *testing.T) {
	// Two bars: VWAP 10 with vol 100, VWAP 20 with vol 300.
	// Volume-weighted = (10*100 + 20*300)/(100+300) = 7000/400 = 17.5
	bars := []*interfaces.Bar{
		{VWAP: 10.0, Volume: 100},
		{VWAP: 20.0, Volume: 300},
	}
	got := calcSessionVWAP(bars)
	if math.Abs(got-17.5) > 1e-9 {
		t.Errorf("expected 17.5, got %f", got)
	}
}

func TestCalcSessionVWAP_SkipsZeroVolumeBar(t *testing.T) {
	bars := []*interfaces.Bar{
		{VWAP: 10.0, Volume: 100},
		{VWAP: 999.0, Volume: 0}, // anomaly — should not affect result
		{VWAP: 20.0, Volume: 100},
	}
	got := calcSessionVWAP(bars)
	if math.Abs(got-15.0) > 1e-9 {
		t.Errorf("expected 15.0 (zero-vol bar skipped), got %f", got)
	}
}

func TestCalcSessionVWAP_AllZeroVolumeReturnsZero(t *testing.T) {
	bars := []*interfaces.Bar{
		{VWAP: 10.0, Volume: 0},
		{VWAP: 20.0, Volume: 0},
	}
	if got := calcSessionVWAP(bars); got != 0 {
		t.Errorf("expected 0 when all bars have zero volume, got %f", got)
	}
}

func TestCalcRVOL_RunningOnPace(t *testing.T) {
	// today=500K cumulative, avg=1M daily, elapsed=0.5 → expected 1.0
	got := calcRVOL(500_000, 1_000_000, 0.5)
	if math.Abs(got-1.0) > 1e-9 {
		t.Errorf("expected RVOL=1.0 (on pace), got %f", got)
	}
}

func TestCalcRVOL_RunningHot(t *testing.T) {
	// today=1M cumulative, avg=1M daily, elapsed=0.5 → 2.0 (twice normal pace)
	got := calcRVOL(1_000_000, 1_000_000, 0.5)
	if math.Abs(got-2.0) > 1e-9 {
		t.Errorf("expected RVOL=2.0, got %f", got)
	}
}

func TestCalcRVOL_ZeroAvgDailyVol(t *testing.T) {
	if got := calcRVOL(500_000, 0, 0.5); got != 0 {
		t.Errorf("expected 0 when avgDailyVol=0, got %f", got)
	}
}

func TestCalcRVOL_ZeroSessionElapsed(t *testing.T) {
	if got := calcRVOL(0, 1_000_000, 0); got != 0 {
		t.Errorf("expected 0 when sessionElapsed=0, got %f", got)
	}
}

func TestCalcRangeOverATR_Typical(t *testing.T) {
	got := calcRangeOverATR(110, 100, 5)
	if math.Abs(got-2.0) > 1e-9 {
		t.Errorf("expected 2.0, got %f", got)
	}
}

func TestCalcRangeOverATR_ZeroATR(t *testing.T) {
	if got := calcRangeOverATR(110, 100, 0); got != 0 {
		t.Errorf("expected 0 when atr=0, got %f", got)
	}
}

func TestCalcDayChangePct_Typical(t *testing.T) {
	// latest=110, prior=100 → +10%
	got := calcDayChangePct(110, 100)
	if math.Abs(got-10.0) > 1e-9 {
		t.Errorf("expected +10.0, got %f", got)
	}
}

func TestCalcDayChangePct_ZeroPriorClose(t *testing.T) {
	if got := calcDayChangePct(110, 0); got != 0 {
		t.Errorf("expected 0 when priorClose=0, got %f", got)
	}
}

func TestCalcATR20_KnownFixture(t *testing.T) {
	// Three bars with simple true-range values: TR1=10, TR2=20, TR3=15.
	// (Real ATR-20 uses 21 bars; we test the math with fewer for clarity.)
	// Bars: prevClose seeded by bar[0].Close.
	bars := []*interfaces.Bar{
		{Close: 100, High: 100, Low: 100},
		{Close: 110, High: 110, Low: 100}, // TR = max(10, |110-100|, |100-100|) = 10
		{Close: 130, High: 130, Low: 110}, // TR = max(20, |130-110|, |110-110|) = 20
		{Close: 130, High: 135, Low: 120}, // TR = max(15, |135-130|, |120-130|) = 15
	}
	got := calcATR(bars)
	want := (10.0 + 20.0 + 15.0) / 3.0
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("expected ATR=%f, got %f", want, got)
	}
}

func TestCalcATR_InsufficientBarsReturnsZero(t *testing.T) {
	bars := []*interfaces.Bar{{Close: 100}}
	if got := calcATR(bars); got != 0 {
		t.Errorf("expected 0 with single bar, got %f", got)
	}
	if got := calcATR(nil); got != 0 {
		t.Errorf("expected 0 with nil bars, got %f", got)
	}
}

func TestFractionOfSessionElapsed_BeforeOpen(t *testing.T) {
	// 9:00 ET = 13:00 UTC (during EDT) — strictly before open.
	now := time.Date(2026, 6, 15, 13, 0, 0, 0, time.UTC) // Monday, EDT
	if got := fractionOfSessionElapsed(now); got != 0 {
		t.Errorf("expected 0 before open, got %f", got)
	}
}

func TestFractionOfSessionElapsed_AtOpen(t *testing.T) {
	// 9:30 ET on a weekday → 0
	// EDT = UTC-4 → 13:30 UTC
	now := time.Date(2026, 6, 15, 13, 30, 0, 0, time.UTC)
	if got := fractionOfSessionElapsed(now); got != 0 {
		t.Errorf("expected 0 at the open bell, got %f", got)
	}
}

func TestFractionOfSessionElapsed_Midday(t *testing.T) {
	// 12:45 ET → (12:45 − 9:30) / 6:30 = 195/390 = 0.5
	// EDT = UTC-4 → 16:45 UTC
	now := time.Date(2026, 6, 15, 16, 45, 0, 0, time.UTC)
	got := fractionOfSessionElapsed(now)
	if math.Abs(got-0.5) > 1e-9 {
		t.Errorf("expected 0.5 at 12:45 ET, got %f", got)
	}
}

func TestFractionOfSessionElapsed_AfterClose(t *testing.T) {
	// 17:00 ET → 1
	now := time.Date(2026, 6, 15, 21, 0, 0, 0, time.UTC)
	if got := fractionOfSessionElapsed(now); got != 1.0 {
		t.Errorf("expected 1.0 after close, got %f", got)
	}
}

// ── IntradaySignalService — stub data source + integration ─────────

// stubDataService implements intradayDataSource. The service batches all
// symbols of a timeframe into one GetMultiBars call, so the stub tracks how
// many batch calls were issued (multiCalls), can simulate a wholesale
// timeframe failure (failTF), and can stall a call past the deadline
// (multiDelay) to exercise the partial-return path.
type stubDataService struct {
	intraday   map[string][]*interfaces.Bar
	daily      map[string][]*interfaces.Bar
	failTF     map[string]bool // timeframe ("5Min"/"1Day") → whole-call failure
	multiDelay time.Duration   // stall before each GetMultiBars returns
	multiCalls int32
}

func (s *stubDataService) GetMultiBars(ctx context.Context, symbols []string, start, end time.Time, timeframe string) (map[string][]*interfaces.Bar, error) {
	atomic.AddInt32(&s.multiCalls, 1)
	if s.multiDelay > 0 {
		time.Sleep(s.multiDelay)
	}
	if s.failTF[timeframe] {
		return nil, fmt.Errorf("simulated %s multibars failure", timeframe)
	}
	var src map[string][]*interfaces.Bar
	switch timeframe {
	case "5Min":
		src = s.intraday
	case "1Day":
		src = s.daily
	}
	out := make(map[string][]*interfaces.Bar, len(symbols))
	for _, sym := range symbols {
		if bars, ok := src[sym]; ok {
			out[sym] = bars
		}
	}
	return out, nil
}

func makeIntradayBars(closePrice float64, volume int64, count int) []*interfaces.Bar {
	bars := make([]*interfaces.Bar, count)
	for i := 0; i < count; i++ {
		bars[i] = &interfaces.Bar{
			Open: closePrice, Close: closePrice, High: closePrice + 0.5, Low: closePrice - 0.5,
			Volume: volume, VWAP: closePrice,
		}
	}
	return bars
}

func makeDailyBars(closes []float64) []*interfaces.Bar {
	bars := make([]*interfaces.Bar, len(closes))
	for i, c := range closes {
		bars[i] = &interfaces.Bar{
			Open: c, Close: c, High: c + 1, Low: c - 1,
			Volume: 10_000_000,
		}
	}
	return bars
}

// fullStub builds a stub populated with intraday + daily bars for the full
// Prophet watchlist plus the sector ETFs, so batched fetches resolve every
// requested symbol.
func fullStub() *stubDataService {
	daily := makeDailyBars([]float64{430, 431, 432, 433, 434, 435, 436, 437, 438, 439,
		440, 441, 442, 443, 444, 445, 446, 447, 448, 449, 450})
	sectorDaily := makeDailyBars([]float64{240, 242, 244, 246, 248, 250, 252, 250, 248, 246,
		244, 246, 248, 250, 252, 250, 248, 250, 252, 254, 256})
	syms := []string{"SPY", "QQQ", "NVDA", "AMD", "TSLA", "MSTR"}
	sectors := []string{"SMH", "XLY", "XLK"}
	ds := &stubDataService{
		intraday: map[string][]*interfaces.Bar{},
		daily:    map[string][]*interfaces.Bar{},
	}
	for _, s := range syms {
		ds.intraday[s] = makeIntradayBars(432.10, 100_000, 12) // 12 × 100K = 1.2M today
		ds.daily[s] = daily
	}
	for _, s := range sectors {
		ds.intraday[s] = makeIntradayBars(250.00, 50_000, 12)
		ds.daily[s] = sectorDaily
	}
	return ds
}

func TestIntradaySignalService_HappyPath(t *testing.T) {
	// Mid-session: 12:45 ET on a weekday → sessionElapsed=0.5.
	now := time.Date(2026, 6, 15, 16, 45, 0, 0, time.UTC)

	svc := NewIntradaySignalService(fullStub())
	set := svc.GetSignals(context.Background(), []string{"SPY"}, now)
	if set == nil {
		t.Fatal("GetSignals returned nil")
	}
	if len(set.Signals) != 1 {
		t.Fatalf("expected 1 signal, got %d", len(set.Signals))
	}
	sig := set.Signals[0]
	if sig.Symbol != "SPY" {
		t.Errorf("expected SPY, got %s", sig.Symbol)
	}
	if sig.VWAP <= 0 {
		t.Errorf("VWAP not populated: %f", sig.VWAP)
	}
	if sig.RVOL <= 0 {
		t.Errorf("RVOL not populated: %f", sig.RVOL)
	}
	if sig.SessionHigh < sig.SessionLow {
		t.Errorf("invalid range: high=%f low=%f", sig.SessionHigh, sig.SessionLow)
	}
}

// The whole point of the batch refactor: a 6-symbol watchlist must cost two
// upstream calls (one 5Min, one 1Day), not 12 per-symbol round trips.
func TestIntradaySignalService_BatchesIntoTwoCalls(t *testing.T) {
	now := time.Date(2026, 6, 15, 16, 45, 0, 0, time.UTC)
	ds := fullStub()

	svc := NewIntradaySignalService(ds)
	set := svc.GetSignals(context.Background(), []string{"SPY", "QQQ", "NVDA", "AMD", "TSLA", "MSTR"}, now)

	if got := atomic.LoadInt32(&ds.multiCalls); got != 2 {
		t.Errorf("expected exactly 2 batch calls for 6 symbols, got %d", got)
	}
	if len(set.Signals) != 6 {
		t.Fatalf("expected 6 signals, got %d", len(set.Signals))
	}
	// Order must match the requested order.
	want := []string{"SPY", "QQQ", "NVDA", "AMD", "TSLA", "MSTR"}
	for i, s := range set.Signals {
		if s.Symbol != want[i] {
			t.Errorf("signal %d: expected %s, got %s", i, want[i], s.Symbol)
		}
	}
}

// Sector ETFs are folded into the daily batch (not a third call) and their
// % change is attached to the underlying.
func TestIntradaySignalService_SectorFoldedIntoDailyBatch(t *testing.T) {
	now := time.Date(2026, 6, 15, 16, 45, 0, 0, time.UTC)
	ds := fullStub()

	svc := NewIntradaySignalService(ds)
	set := svc.GetSignals(context.Background(), []string{"NVDA"}, now)

	if got := atomic.LoadInt32(&ds.multiCalls); got != 2 {
		t.Errorf("expected 2 batch calls (sector folded into daily), got %d", got)
	}
	if len(set.Signals) != 1 {
		t.Fatalf("expected 1 signal, got %d", len(set.Signals))
	}
	if set.Signals[0].SectorETF != "SMH" {
		t.Errorf("expected sector ETF SMH, got %q", set.Signals[0].SectorETF)
	}
	if set.Signals[0].SectorChangePct == 0 {
		t.Error("expected non-zero sector change pct")
	}
}

// A symbol the broker returns no bars for (present in neither map though the
// call succeeded) is emitted with a note rather than dropping the response.
func TestIntradaySignalService_UnknownSymbolGetsNote(t *testing.T) {
	now := time.Date(2026, 6, 15, 16, 45, 0, 0, time.UTC)
	ds := fullStub()

	svc := NewIntradaySignalService(ds)
	set := svc.GetSignals(context.Background(), []string{"SPY", "ZZZZ"}, now)

	var spyOK, zzzzSeen bool
	for _, s := range set.Signals {
		if s.Symbol == "SPY" && s.VWAP > 0 {
			spyOK = true
		}
		if s.Symbol == "ZZZZ" && s.Note != "" {
			zzzzSeen = true
		}
	}
	if !spyOK {
		t.Error("SPY should remain populated alongside an unknown symbol")
	}
	if !zzzzSeen {
		t.Error("unknown symbol should be emitted with a note")
	}
}

// When a timeframe's batch call fails wholesale, the response is still
// returned (soft-fail), with the failure surfaced in Errors.
func TestIntradaySignalService_WholeCallFailureSoftFails(t *testing.T) {
	now := time.Date(2026, 6, 15, 16, 45, 0, 0, time.UTC)
	ds := fullStub()
	ds.failTF = map[string]bool{"5Min": true}

	svc := NewIntradaySignalService(ds)
	set := svc.GetSignals(context.Background(), []string{"SPY"}, now)
	if set == nil {
		t.Fatal("expected non-nil set even when a batch call fails")
	}
	if len(set.Errors) == 0 {
		t.Error("expected the 5Min batch failure to surface in Errors")
	}
}

// The deadline guard is the core of fix #3: a stalled upstream must not block
// past the budget. GetSignals returns promptly with partial data instead of
// waiting for the slow fetch.
func TestIntradaySignalService_DeadlineReturnsPartial(t *testing.T) {
	now := time.Date(2026, 6, 15, 16, 45, 0, 0, time.UTC)
	ds := fullStub()
	ds.multiDelay = 500 * time.Millisecond // far longer than the test deadline

	svc := NewIntradaySignalService(ds)
	svc.deadline = 50 * time.Millisecond // shrink for a fast test

	start := time.Now()
	set := svc.GetSignals(context.Background(), []string{"SPY"}, now)
	elapsed := time.Since(start)

	if elapsed > 300*time.Millisecond {
		t.Errorf("GetSignals blocked past its deadline: took %v", elapsed)
	}
	if set == nil {
		t.Fatal("expected non-nil set on deadline")
	}
	if len(set.Errors) == 0 {
		t.Error("expected a deadline notice in Errors")
	}
}

func TestIntradaySignalService_CacheHit(t *testing.T) {
	now := time.Date(2026, 6, 15, 16, 45, 0, 0, time.UTC)
	ds := fullStub()
	svc := NewIntradaySignalService(ds)

	_ = svc.GetSignals(context.Background(), []string{"SPY"}, now)
	callsAfterFirst := atomic.LoadInt32(&ds.multiCalls)
	if callsAfterFirst == 0 {
		t.Fatal("expected a batch fetch on the first call")
	}
	// Second call within cache TTL (5 seconds later) — must reuse cache.
	_ = svc.GetSignals(context.Background(), []string{"SPY"}, now.Add(5*time.Second))
	callsAfterSecond := atomic.LoadInt32(&ds.multiCalls)
	if callsAfterSecond != callsAfterFirst {
		t.Errorf("expected no new fetches within cache TTL; before=%d after=%d", callsAfterFirst, callsAfterSecond)
	}
	// Third call past TTL (90s later) — must refetch.
	_ = svc.GetSignals(context.Background(), []string{"SPY"}, now.Add(90*time.Second))
	callsAfterThird := atomic.LoadInt32(&ds.multiCalls)
	if callsAfterThird == callsAfterSecond {
		t.Errorf("expected new fetches after cache TTL expired; before=%d after=%d", callsAfterSecond, callsAfterThird)
	}
}
