package services

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// makeMeanRevBars builds L bars from a closes slice. Reuses the same shape
// as makeBars in trend_signal_service_test.go but kept local to keep test
// dependencies explicit.
func makeMeanRevBars(closes []float64) []*interfaces.Bar {
	start := time.Date(2025, 1, 2, 16, 0, 0, 0, time.UTC)
	bars := make([]*interfaces.Bar, len(closes))
	for i, c := range closes {
		bars[i] = &interfaces.Bar{
			Symbol:    "TEST",
			Timestamp: start.AddDate(0, 0, i),
			Open:      c,
			Close:     c,
			High:      c * 1.01,
			Low:       c * 0.99,
			Volume:    1000,
		}
	}
	return bars
}

// constCloses returns a slice of length L filled with v.
func constCloses(L int, v float64) []float64 {
	closes := make([]float64, L)
	for i := range closes {
		closes[i] = v
	}
	return closes
}

func TestWilderRSI_FlatSeries(t *testing.T) {
	closes := constCloses(50, 100.0)
	got := wilderRSI(closes, 2)
	want := 50.0
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("wilderRSI on flat series = %v, want %v", got, want)
	}
}

func TestWilderRSI_AllGains(t *testing.T) {
	// Monotonic ascent: every bar is a gain, no losses. avgLoss = 0 → RSI = 100.
	L := 50
	closes := make([]float64, L)
	for i := range closes {
		closes[i] = 100.0 + float64(i)
	}
	got := wilderRSI(closes, 2)
	if got != 100.0 {
		t.Fatalf("wilderRSI on monotonic ascent = %v, want 100.0", got)
	}
}

func TestWilderRSI_AllLosses(t *testing.T) {
	// Monotonic descent: every bar is a loss, no gains. avgGain = 0 → RSI = 0.
	L := 50
	closes := make([]float64, L)
	for i := range closes {
		closes[i] = 200.0 - float64(i)
	}
	got := wilderRSI(closes, 2)
	if got != 0.0 {
		t.Fatalf("wilderRSI on monotonic descent = %v, want 0.0", got)
	}
}

func TestWilderRSI_RecentLossesOnFlatTail(t *testing.T) {
	// First ~40 bars flat at 100, then 5 sharp drops. RSI(2) should be near 0
	// because the most recent two bars are both losses and Wilder smoothing
	// puts almost all weight on the last value at n=2.
	L := 50
	closes := make([]float64, L)
	for i := range closes {
		closes[i] = 100.0
	}
	for i := L - 5; i < L; i++ {
		closes[i] = closes[i-1] - 1.0
	}
	got := wilderRSI(closes, 2)
	if got > 5.0 {
		t.Fatalf("wilderRSI after recent losses = %v, want < 5.0", got)
	}
}

func TestWilderRSI_KnownValue(t *testing.T) {
	// Closes: 1, 2, 1, 2, 1, 2 (alternating ±1).
	//   bars:    0  1  2  3  4  5
	//   ch:      _  +1 -1 +1 -1 +1
	// Seed (n=2) from bars 1..2: gain=1, loss=1 → avgGain=0.5, avgLoss=0.5
	// i=3: gain=+1, loss=0 → avgGain=(0.5*1+1)/2=0.75, avgLoss=(0.5*1+0)/2=0.25
	// i=4: gain=0, loss=1  → avgGain=(0.75*1+0)/2=0.375, avgLoss=(0.25*1+1)/2=0.625
	// i=5: gain=+1, loss=0 → avgGain=(0.375*1+1)/2=0.6875, avgLoss=(0.625*1+0)/2=0.3125
	// RSI = 100 - 100/(1+0.6875/0.3125) = 100 - 100/(1+2.2) = 100 - 31.25 = 68.75
	closes := []float64{1, 2, 1, 2, 1, 2}
	got := wilderRSI(closes, 2)
	want := 68.75
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("wilderRSI known-value = %v, want %v", got, want)
	}
}

func TestMeanRevSMA_IncludesLastBar(t *testing.T) {
	// Unlike trend_signal_service.sma which excludes the last bar, the
	// mean-reversion SMA(200) must include today's close so that "close >
	// SMA(200)" tests the same closes-window the literature describes.
	L := 200
	closes := make([]float64, L)
	for i := range closes {
		closes[i] = 100.0
	}
	closes[L-1] = 999.0
	got := meanRevSMA(closes, 200)
	wantSum := 99.0*float64(L-1) + 999.0 // 199 * 100 + 999 wait — closes are 100 except last
	wantSum = 100.0*float64(L-1) + 999.0
	want := wantSum / 200.0
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("meanRevSMA = %v, want %v (last bar must be included)", got, want)
	}
}

func TestMeanRevSMA_BasicMean(t *testing.T) {
	// closes[i] = 100 + i for i in [0..199] → mean = (100 + 299) / 2 = 199.5
	L := 200
	closes := make([]float64, L)
	for i := range closes {
		closes[i] = 100.0 + float64(i)
	}
	got := meanRevSMA(closes, 200)
	want := (100.0 + 299.0) / 2.0
	if math.Abs(got-want) > 1e-9 {
		t.Fatalf("meanRevSMA = %v, want %v", got, want)
	}
}

// stubBarFetcher is a per-symbol map-backed BarFetcher for the candidates
// service tests. Symbols not in the map return ErrSymbolNotFound to mimic
// Alpaca's "no bars" path.
type stubBarFetcher struct {
	bars map[string][]*interfaces.Bar
}

var errStubSymbolNotFound = errors.New("symbol not found")

func (f *stubBarFetcher) GetHistoricalBars(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, error) {
	b, ok := f.bars[symbol]
	if !ok {
		return nil, errStubSymbolNotFound
	}
	return b, nil
}

func TestGetMeanRevSignal_InsufficientHistory(t *testing.T) {
	closes := constCloses(100, 100.0) // below meanRevMinBars (210)
	svc := NewMeanRevSignalService(&stubBarFetcher{bars: map[string][]*interfaces.Bar{
		"TEST": makeMeanRevBars(closes),
	}})
	_, err := svc.GetSignal(context.Background(), "TEST")
	if !errors.Is(err, ErrInsufficientMeanRevHistory) {
		t.Fatalf("expected ErrInsufficientMeanRevHistory, got %v", err)
	}
}

func TestComputeMeanRevSignal_EntryConditions(t *testing.T) {
	// Construct closes so that:
	//   - last_close > SMA(200): closes trend up over 220 bars
	//   - RSI(2) is low: last 3 bars are sharp drops
	//   - last_close < SMA(5): the 5-day pullback puts price below the 5-day mean
	L := 220
	closes := make([]float64, L)
	// Gentle uptrend: bars 0..L-6 climb from 100 to ~140
	for i := 0; i <= L-6; i++ {
		closes[i] = 100.0 + 0.2*float64(i)
	}
	// Sharp 5-day pullback at the end
	peak := closes[L-6]
	for i := L - 5; i < L; i++ {
		closes[i] = peak - 0.5*float64(i-(L-6))
	}
	sig := ComputeMeanRevSignal("TEST", makeMeanRevBars(closes))
	if !sig.EntrySignal {
		t.Fatalf("expected entry signal=true; got false (rsi=%.2f, sma5=%.2f, sma200=%.2f, last=%.2f)",
			sig.RSI2, sig.SMA5, sig.SMA200, sig.LastClose)
	}
	if sig.RSI2 >= meanRevRSIEntryMax {
		t.Errorf("RSI(2) = %v, want < %v", sig.RSI2, meanRevRSIEntryMax)
	}
	if sig.LastClose <= sig.SMA200 {
		t.Errorf("last_close (%v) should be > SMA200 (%v)", sig.LastClose, sig.SMA200)
	}
	if sig.LastClose >= sig.SMA5 {
		t.Errorf("last_close (%v) should be < SMA5 (%v)", sig.LastClose, sig.SMA5)
	}
}

func TestComputeMeanRevSignal_NoEntryWhenAboveSMA5(t *testing.T) {
	// Strong uptrend with NO pullback — RSI is high, last_close > SMA5.
	L := 220
	closes := make([]float64, L)
	for i := range closes {
		closes[i] = 100.0 + 0.5*float64(i)
	}
	sig := ComputeMeanRevSignal("TEST", makeMeanRevBars(closes))
	if sig.EntrySignal {
		t.Fatalf("expected entry signal=false on runaway uptrend; got true (rsi=%.2f, sma5=%.2f, last=%.2f)",
			sig.RSI2, sig.SMA5, sig.LastClose)
	}
}

func TestComputeMeanRevSignal_NoEntryWhenBelowSMA200(t *testing.T) {
	// Bear regime: last_close below SMA(200). RSI may be low but the regime
	// filter blocks entry.
	L := 220
	closes := make([]float64, L)
	for i := 0; i < L-20; i++ {
		closes[i] = 200.0 - 0.1*float64(i)
	}
	// Final 20 bars decline further — close ends well below SMA(200)
	for i := L - 20; i < L; i++ {
		closes[i] = closes[i-1] - 0.5
	}
	sig := ComputeMeanRevSignal("TEST", makeMeanRevBars(closes))
	if sig.EntrySignal {
		t.Fatalf("expected entry signal=false below SMA200; got true (last=%.2f, sma200=%.2f)",
			sig.LastClose, sig.SMA200)
	}
	if sig.LastClose >= sig.SMA200 {
		t.Fatalf("test setup: last_close (%v) should be < SMA200 (%v)", sig.LastClose, sig.SMA200)
	}
}

// stubMeanRevEarningsChecker is a simple set-based implementation of
// EarningsHorizonChecker for tests.
type stubMeanRevEarningsChecker struct {
	excluded map[string]bool
}

func (s *stubMeanRevEarningsChecker) HasEarningsWithinTradingDays(ticker string, days int, now time.Time) bool {
	return s.excluded[ticker]
}

// pullbackCloses builds a 220-bar series whose RSI(2)/SMA layout produces a
// valid entry signal. Shared by candidates tests.
func pullbackCloses() []float64 {
	L := 220
	closes := make([]float64, L)
	for i := 0; i <= L-6; i++ {
		closes[i] = 100.0 + 0.2*float64(i)
	}
	peak := closes[L-6]
	for i := L - 5; i < L; i++ {
		closes[i] = peak - 0.5*float64(i-(L-6))
	}
	return closes
}

func TestCandidatesService_FiltersEarningsTicker(t *testing.T) {
	// Two tickers, both showing valid entry signals; one excluded by earnings.
	bars := map[string][]*interfaces.Bar{
		"AAA": makeMeanRevBars(pullbackCloses()),
		"BBB": makeMeanRevBars(pullbackCloses()),
		"SPY": makeMeanRevBars(pullbackCloses()), // SPY for bear-regime probe
	}
	sig := NewMeanRevSignalService(&stubBarFetcher{bars: bars})
	earnings := &stubMeanRevEarningsChecker{excluded: map[string]bool{"BBB": true}}
	svc := NewMeanRevCandidatesService(sig, earnings, []string{"AAA", "BBB"}, "normal")
	svc.SetRefreshInterval(-1) // disable cache

	resp := svc.GetCandidates(context.Background())
	if resp.Count != 1 {
		t.Fatalf("expected 1 candidate after earnings filter, got %d (candidates=%+v)", resp.Count, resp.Candidates)
	}
	if resp.Candidates[0].Ticker != "AAA" {
		t.Fatalf("expected AAA to pass, got %s", resp.Candidates[0].Ticker)
	}
}

func TestCandidatesService_SortedByRSIAscending(t *testing.T) {
	// Build two pullback series with distinct RSI(2) values. We'll cheat by
	// using different pullback depths so RSI sorts differ.
	deepPullback := func() []float64 {
		L := 220
		closes := make([]float64, L)
		for i := 0; i <= L-6; i++ {
			closes[i] = 100.0 + 0.2*float64(i)
		}
		peak := closes[L-6]
		for i := L - 5; i < L; i++ {
			closes[i] = peak - 1.0*float64(i-(L-6)) // deeper pullback → lower RSI
		}
		return closes
	}
	bars := map[string][]*interfaces.Bar{
		"SHALLOW": makeMeanRevBars(pullbackCloses()),
		"DEEP":    makeMeanRevBars(deepPullback()),
		"SPY":     makeMeanRevBars(pullbackCloses()),
	}
	sig := NewMeanRevSignalService(&stubBarFetcher{bars: bars})
	svc := NewMeanRevCandidatesService(sig, nil, []string{"SHALLOW", "DEEP"}, "normal")
	svc.SetRefreshInterval(-1)

	resp := svc.GetCandidates(context.Background())
	if resp.Count != 2 {
		t.Fatalf("expected 2 candidates, got %d", resp.Count)
	}
	if resp.Candidates[0].RSI2 > resp.Candidates[1].RSI2 {
		t.Fatalf("candidates not sorted by RSI ascending: %v then %v",
			resp.Candidates[0].RSI2, resp.Candidates[1].RSI2)
	}
}

func TestCandidatesService_BearRegimeAnnotation(t *testing.T) {
	// SPY closes well below its SMA(200): bear regime should be flagged.
	L := 220
	spyCloses := make([]float64, L)
	for i := 0; i < L-30; i++ {
		spyCloses[i] = 500.0
	}
	for i := L - 30; i < L; i++ {
		spyCloses[i] = 400.0 - float64(i-(L-30))*2.0 // sharp decline at the tail
	}
	bars := map[string][]*interfaces.Bar{
		"AAA": makeMeanRevBars(pullbackCloses()),
		"SPY": makeMeanRevBars(spyCloses),
	}
	sig := NewMeanRevSignalService(&stubBarFetcher{bars: bars})
	svc := NewMeanRevCandidatesService(sig, nil, []string{"AAA"}, "halfsize")
	svc.SetRefreshInterval(-1)

	resp := svc.GetCandidates(context.Background())
	if !resp.BearRegime {
		t.Fatalf("expected BearRegime=true when SPY < SMA200; got false")
	}
	if resp.BearMode != "halfsize" {
		t.Fatalf("BearMode = %q, want %q", resp.BearMode, "halfsize")
	}
}

func TestCandidatesService_BearModeNormalization(t *testing.T) {
	// Invalid or empty mode should default to halfsize.
	sig := NewMeanRevSignalService(&stubBarFetcher{bars: map[string][]*interfaces.Bar{
		"SPY": makeMeanRevBars(pullbackCloses()),
	}})
	cases := map[string]string{
		"":         "halfsize",
		"garbage":  "halfsize",
		"NORMAL":   "normal",
		"HALT":     "halt",
		"halfsize": "halfsize",
	}
	for input, want := range cases {
		svc := NewMeanRevCandidatesService(sig, nil, []string{}, input)
		svc.SetRefreshInterval(-1)
		if got := svc.GetCandidates(context.Background()).BearMode; got != want {
			t.Errorf("mode %q normalized to %q, want %q", input, got, want)
		}
	}
}

func TestCandidatesService_SkipsInsufficientHistory(t *testing.T) {
	bars := map[string][]*interfaces.Bar{
		"SHORT": makeMeanRevBars(constCloses(50, 100.0)), // way below meanRevMinBars
		"GOOD":  makeMeanRevBars(pullbackCloses()),
		"SPY":   makeMeanRevBars(pullbackCloses()),
	}
	sig := NewMeanRevSignalService(&stubBarFetcher{bars: bars})
	svc := NewMeanRevCandidatesService(sig, nil, []string{"SHORT", "GOOD"}, "normal")
	svc.SetRefreshInterval(-1)

	resp := svc.GetCandidates(context.Background())
	// Only GOOD passes (SHORT silently dropped due to ErrInsufficientMeanRevHistory).
	if resp.Count != 1 || resp.Candidates[0].Ticker != "GOOD" {
		t.Fatalf("expected only GOOD; got %+v", resp.Candidates)
	}
	// Insufficient-history errors should NOT pollute Errors[] — they're an
	// expected condition, not a fetch failure.
	for _, e := range resp.Errors {
		if e == "" {
			continue
		}
		t.Errorf("unexpected error entry: %q", e)
	}
}

func TestCandidatesService_SurfacesFetchErrors(t *testing.T) {
	bars := map[string][]*interfaces.Bar{
		"GOOD": makeMeanRevBars(pullbackCloses()),
		"SPY":  makeMeanRevBars(pullbackCloses()),
		// "MISSING" intentionally absent — stubBarFetcher returns errStubSymbolNotFound.
	}
	sig := NewMeanRevSignalService(&stubBarFetcher{bars: bars})
	svc := NewMeanRevCandidatesService(sig, nil, []string{"GOOD", "MISSING"}, "normal")
	svc.SetRefreshInterval(-1)

	resp := svc.GetCandidates(context.Background())
	if resp.Count != 1 {
		t.Fatalf("expected 1 candidate, got %d", resp.Count)
	}
	if len(resp.Errors) == 0 {
		t.Fatalf("expected fetch error for MISSING to be surfaced; got Errors=[]")
	}
}

func TestCandidatesService_CachingHonored(t *testing.T) {
	// First call populates cache; second call within TTL must hit cache and
	// not invoke the fetcher again. We detect this by mutating the underlying
	// bars between calls and confirming the cached response wins.
	stub := &stubBarFetcher{bars: map[string][]*interfaces.Bar{
		"AAA": makeMeanRevBars(pullbackCloses()),
		"SPY": makeMeanRevBars(pullbackCloses()),
	}}
	sig := NewMeanRevSignalService(stub)
	svc := NewMeanRevCandidatesService(sig, nil, []string{"AAA"}, "normal")
	svc.SetRefreshInterval(10 * time.Minute)

	first := svc.GetCandidates(context.Background())
	if first.Count != 1 {
		t.Fatalf("first call: expected 1 candidate, got %d", first.Count)
	}

	// Wipe AAA from the stub — without caching, the second call would see 0.
	delete(stub.bars, "AAA")
	second := svc.GetCandidates(context.Background())
	if second.Count != 1 {
		t.Fatalf("cached call should have returned the prior result; got %d candidates", second.Count)
	}

	// Disable cache and re-call — now we should see the empty result.
	svc.SetRefreshInterval(-1)
	third := svc.GetCandidates(context.Background())
	if third.Count != 0 {
		t.Fatalf("after cache disabled, expected 0 candidates; got %d", third.Count)
	}
}

func TestCandidatesService_RefreshBypassesTTL(t *testing.T) {
	// Refresh must recompute and overwrite the cache even when the cached entry
	// is still within its TTL. That's what lets the background warmer keep the
	// cache hot so the once-daily Coil beat hits it instead of triggering a
	// cold full-universe scan that blows past the 2s preflight budget.
	//
	// Detection mirrors TestCandidatesService_CachingHonored: mutate the stub
	// between calls so a cached read and a recompute return different counts.
	stub := &stubBarFetcher{bars: map[string][]*interfaces.Bar{
		"AAA": makeMeanRevBars(pullbackCloses()),
		"SPY": makeMeanRevBars(pullbackCloses()),
	}}
	sig := NewMeanRevSignalService(stub)
	svc := NewMeanRevCandidatesService(sig, nil, []string{"AAA"}, "normal")
	svc.SetRefreshInterval(10 * time.Minute) // caching ON, long TTL

	if first := svc.GetCandidates(context.Background()); first.Count != 1 {
		t.Fatalf("first call: expected 1 candidate, got %d", first.Count)
	}

	// Wipe AAA. A within-TTL read still serves the cached (stale) result.
	delete(stub.bars, "AAA")
	if cached := svc.GetCandidates(context.Background()); cached.Count != 1 {
		t.Fatalf("within-TTL read should be cached; got %d", cached.Count)
	}

	// Refresh bypasses the TTL and recomputes against the mutated fetcher.
	svc.Refresh(context.Background())

	// The cache now reflects the recompute (0), despite being within the TTL.
	if after := svc.GetCandidates(context.Background()); after.Count != 0 {
		t.Fatalf("Refresh should have recomputed an empty result into cache; got %d", after.Count)
	}
}

func TestGetSignalForTicker_AppliesEarningsFilter(t *testing.T) {
	bars := map[string][]*interfaces.Bar{
		"AAA": makeMeanRevBars(pullbackCloses()),
	}
	sig := NewMeanRevSignalService(&stubBarFetcher{bars: bars})
	earnings := &stubMeanRevEarningsChecker{excluded: map[string]bool{"AAA": true}}
	svc := NewMeanRevCandidatesService(sig, earnings, []string{"AAA"}, "normal")
	svc.SetRefreshInterval(-1)

	got, err := svc.GetSignalForTicker(context.Background(), "AAA")
	if err != nil {
		t.Fatalf("GetSignalForTicker failed: %v", err)
	}
	if !got.EarningsWithin5d {
		t.Errorf("EarningsWithin5d = false, want true")
	}
	if got.EntrySignal {
		t.Errorf("EntrySignal should be false when earnings filter fires")
	}
}
