package services

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

func writeFrictionFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "friction.json")
	body := `{"version":"test.1","stocks":{"per_share_slippage_usd":0.02,"stop_gap_through_pct":0.003,"commission_per_share":0.0,"regulatory_fee_per_share":0.0001}}`
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadStockFriction_ReadsStocksBlock(t *testing.T) {
	f, err := LoadStockFriction(writeFrictionFixture(t))
	if err != nil {
		t.Fatalf("LoadStockFriction: %v", err)
	}
	if f.PerShareSlippage != 0.02 || f.StopGapThroughPct != 0.003 || f.RegFeePerShare != 0.0001 {
		t.Errorf("got %+v", f)
	}
	if f.Version != "test.1" {
		t.Errorf("version = %q, want test.1", f.Version)
	}
	if f.Hash == "" {
		t.Error("hash empty")
	}
}

func TestLoadStockFriction_MissingFileFailsLoud(t *testing.T) {
	if _, err := LoadStockFriction(filepath.Join(t.TempDir(), "nope.json")); err == nil {
		t.Error("expected error for missing file")
	}
}

func TestFrictionHaircut_StopAddsGapThrough_StopGapDoesNot(t *testing.T) {
	f := StockFriction{PerShareSlippage: 0.02, StopGapThroughPct: 0.003, RegFeePerShare: 0.0001}
	entry := 100.0
	base := (0.02 + 0.0001) * 2 // 0.0402
	if got := frictionHaircut(entry, "target", f); math.Abs(got-base) > 1e-9 {
		t.Errorf("target haircut = %v, want %v", got, base)
	}
	wantStop := base + 0.003*entry // + 0.30
	if got := frictionHaircut(entry, "stop", f); math.Abs(got-wantStop) > 1e-9 {
		t.Errorf("stop haircut = %v, want %v", got, wantStop)
	}
	// stop_gap must NOT add gap-through (the gapped open already embeds it).
	if got := frictionHaircut(entry, "stop_gap", f); math.Abs(got-base) > 1e-9 {
		t.Errorf("stop_gap haircut = %v, want %v (no double-count)", got, base)
	}
}

// replayBars builds n flat lead-in bars at `price`, then appends forward rows.
// Mon–Fri timestamps via makeMonFriBars (from drift_signal_service_test.go).
// Returns the bars and the entry index (= first forward bar).
func replayBars(t *testing.T, lead int, price float64, forward []driftBarRow) ([]*interfaces.Bar, int) {
	t.Helper()
	rows := make([]driftBarRow, 0, lead+len(forward))
	for i := 0; i < lead; i++ {
		rows = append(rows, driftBarRow{Open: price, High: price, Low: price, Close: price, Vol: 100_000})
	}
	rows = append(rows, forward...)
	return makeMonFriBars(rows), lead
}

var stdExitCfg = ExitConfig{StopPct: 0.10, TargetPct: 0.20, TimeStopDays: 60}

func TestSimulateExit_TargetHitIntraday(t *testing.T) {
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1},
		{Open: 100, High: 121, Low: 99, Close: 120, Vol: 1},
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "target" || r.ExitPrice != 120 {
		t.Fatalf("got %+v, want target@120", r)
	}
	if r.HoldingDays != 1 {
		t.Errorf("HoldingDays = %d, want 1", r.HoldingDays)
	}
}

func TestSimulateExit_StopHitIntraday(t *testing.T) {
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1},
		{Open: 100, High: 101, Low: 89, Close: 95, Vol: 1},
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "stop" || r.ExitPrice != 90 {
		t.Fatalf("got %+v, want stop@90", r)
	}
}

func TestSimulateExit_BothTouched_StopFirst(t *testing.T) {
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1},
		{Open: 105, High: 121, Low: 89, Close: 110, Vol: 1},
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "stop" || r.ExitPrice != 90 {
		t.Fatalf("got %+v, want stop@90 (stop-first tie-break)", r)
	}
}

func TestSimulateExit_GapUpThroughTarget_NotMisattributedAsStop(t *testing.T) {
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1},
		{Open: 125, High: 130, Low: 88, Close: 126, Vol: 1},
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "target_gap" || r.ExitPrice != 125 {
		t.Fatalf("got %+v, want target_gap@125", r)
	}
}

func TestSimulateExit_GapDownThroughStop(t *testing.T) {
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1},
		{Open: 85, High: 86, Low: 84, Close: 85, Vol: 1},
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "stop_gap" || r.ExitPrice != 85 {
		t.Fatalf("got %+v, want stop_gap@85", r)
	}
}

func TestSimulateExit_TimeStop60TradingDays(t *testing.T) {
	fwd := make([]driftBarRow, 62)
	for i := range fwd {
		fwd[i] = driftBarRow{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1}
	}
	bars, e := replayBars(t, 60, 100, fwd)
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "time" {
		t.Fatalf("got %+v, want time", r)
	}
	if r.HoldingDays != 61 {
		t.Errorf("HoldingDays = %d, want 61 (decided at e+60 close, filled e+61 open)", r.HoldingDays)
	}
}

func TestSimulateExit_MA50Break(t *testing.T) {
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1},
		{Open: 96, High: 96, Low: 94, Close: 95, Vol: 1},
		{Open: 95, High: 95, Low: 95, Close: 95, Vol: 1},
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "ma50_break" || r.ExitPrice != 95 {
		t.Fatalf("got %+v, want ma50_break@95 (next open)", r)
	}
	if r.HoldingDays != 2 {
		t.Errorf("HoldingDays = %d, want 2", r.HoldingDays)
	}
}

func TestSimulateExit_DataEndAtLastClose(t *testing.T) {
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1},
		{Open: 100, High: 105, Low: 99, Close: 103, Vol: 1},
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "data_end" || r.ExitPrice != 103 {
		t.Fatalf("got %+v, want data_end@103", r)
	}
}

func TestFindEntries_DeployedAndControl(t *testing.T) {
	bars := buildContinuationBars("CONT")
	earningsDate := bars[len(bars)-5].Timestamp.UTC().Format("2006-01-02")
	dep, ctrl := findEntries("CONT", bars, earningsDate, "bmo", 14)
	if !dep.Found {
		t.Fatal("deployed cohort: expected an entry")
	}
	if dep.EntryReason != "continuation" {
		t.Errorf("deployed EntryReason = %q, want continuation", dep.EntryReason)
	}
	if !ctrl.Found {
		t.Fatal("control cohort: expected an entry")
	}
	if ctrl.EntryReason != "base_only" {
		t.Errorf("control EntryReason = %q, want base_only", ctrl.EntryReason)
	}
	if ctrl.EntryIdx > dep.EntryIdx {
		t.Errorf("control EntryIdx %d after deployed %d", ctrl.EntryIdx, dep.EntryIdx)
	}
}

func TestFindEntries_ControlOnlyWhenNoContinuation(t *testing.T) {
	bars := buildGradeABars("FLT")
	earningsDate := bars[len(bars)-5].Timestamp.UTC().Format("2006-01-02")
	dep, ctrl := findEntries("FLT", bars, earningsDate, "bmo", 14)
	if dep.Found {
		t.Errorf("deployed: expected no entry, got %+v", dep)
	}
	if !ctrl.Found {
		t.Error("control: expected a base-only entry")
	}
}

func TestFindEntries_EarningsNotInBars(t *testing.T) {
	bars := buildGradeABars("X")
	dep, ctrl := findEntries("X", bars, "1990-01-01", "bmo", 14)
	if dep.Found || ctrl.Found {
		t.Errorf("expected no entries when earnings date absent: %+v %+v", dep, ctrl)
	}
}

func to(cohort, reason string, ext, gross, fr float64) TradeOutcome {
	return TradeOutcome{Cohort: cohort, ExitReason: reason, ExtensionPct: ext, GrossReturnPct: gross, FrictionReturnPct: fr}
}

func TestSummarizeCohort_BasicStats(t *testing.T) {
	out := []TradeOutcome{
		to("deployed", "target", 1, 20, 19.9),
		to("deployed", "stop", 2, -10, -10.3),
		to("deployed", "target", 3, 20, 19.9),
		to("deployed", "stop", 4, -10, -10.3),
	}
	s := summarizeCohort(out, false) // gross
	if s.N != 4 {
		t.Fatalf("N = %d, want 4", s.N)
	}
	if math.Abs(s.WinRate-0.5) > 1e-9 {
		t.Errorf("WinRate = %v, want 0.5", s.WinRate)
	}
	if math.Abs(s.ProfitFactor-2.0) > 1e-9 { // (20+20)/(10+10)
		t.Errorf("ProfitFactor = %v, want 2.0", s.ProfitFactor)
	}
	if math.Abs(s.ExpectancyPct-5.0) > 1e-9 { // (20-10+20-10)/4
		t.Errorf("ExpectancyPct = %v, want 5.0", s.ExpectancyPct)
	}
}

func TestSpearman_PerfectMonotone(t *testing.T) {
	xs := []float64{1, 2, 3, 4, 5}
	ys := []float64{10, 8, 6, 4, 2} // strictly decreasing → rho = -1
	if got := spearman(xs, ys); math.Abs(got-(-1.0)) > 1e-9 {
		t.Errorf("spearman = %v, want -1", got)
	}
}

func TestOLSSlope_KnownLine(t *testing.T) {
	xs := []float64{0, 1, 2, 3}
	ys := []float64{1, 3, 5, 7} // y = 2x + 1
	if got := olsSlope(xs, ys); math.Abs(got-2.0) > 1e-9 {
		t.Errorf("slope = %v, want 2", got)
	}
}

func TestBucketize_AssignsAndCountsEmpty(t *testing.T) {
	out := []TradeOutcome{
		to("deployed", "target", 0.5, 20, 20),
		to("deployed", "stop", 5.0, -10, -10),
	}
	bs := bucketize(out, false)
	if len(bs) != 5 {
		t.Fatalf("want 5 buckets, got %d", len(bs))
	}
	if bs[0].N != 1 || bs[3].N != 1 {
		t.Errorf("bucket counts wrong: %+v", bs)
	}
	if bs[1].N != 0 {
		t.Errorf("empty bucket should be present with N=0, got %+v", bs[1])
	}
}

func TestAggregate_SplitsCohortsAndMarginalEdge(t *testing.T) {
	out := []TradeOutcome{
		to("deployed", "target", 1, 20, 19.9),
		to("deployed", "stop", 2, -10, -10.3),
		to("control", "stop", 1, -10, -10.3),
		to("control", "stop", 2, -10, -10.3),
	}
	r := Aggregate(out)
	if r.Deployed.Gross.N != 2 || r.Control.Gross.N != 2 {
		t.Fatalf("cohort split wrong: dep %d ctrl %d", r.Deployed.Gross.N, r.Control.Gross.N)
	}
	if math.Abs(r.Deployed.Gross.ExpectancyPct-5.0) > 1e-9 { // (20-10)/2
		t.Errorf("deployed expectancy = %v, want 5", r.Deployed.Gross.ExpectancyPct)
	}
	if math.Abs(r.MarginalEdgeGrossPct-15.0) > 1e-9 { // 5 - (-10)
		t.Errorf("MarginalEdgeGrossPct = %v, want 15", r.MarginalEdgeGrossPct)
	}
}

// stubRangeReporter satisfies RangeReporterFetcher (the existing
// stubRecentReporterFetcher only implements FetchRecentReports).
type stubRangeReporter struct{ reports []RecentReport }

func (s *stubRangeReporter) FetchReportsInRange(ctx context.Context, from, to time.Time) ([]RecentReport, error) {
	return s.reports, nil
}

func TestRunReplay_ProducesCohortOutcomes(t *testing.T) {
	cont := buildContinuationBars("CONT")
	edate := cont[len(cont)-5].Timestamp // earnings bar timestamp
	stub := &stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{"CONT": cont}}
	rep := &stubRangeReporter{reports: []RecentReport{{Ticker: "CONT", Date: edate, Timing: "bmo"}}}
	fr := StockFriction{PerShareSlippage: 0.02, StopGapThroughPct: 0.003, RegFeePerShare: 0.0001}

	outcomes, cov := RunReplay(context.Background(), stub, rep, []string{"CONT"},
		edate.AddDate(0, 0, -5), edate.AddDate(0, 0, 5), fr, stdExitCfg)

	if cov.InUniverse != 1 {
		t.Errorf("InUniverse = %d, want 1", cov.InUniverse)
	}
	var haveDeployed bool
	for _, o := range outcomes {
		if o.Cohort == "deployed" && o.Ticker == "CONT" {
			haveDeployed = true
			if o.EntryReason != "continuation" {
				t.Errorf("EntryReason = %q, want continuation", o.EntryReason)
			}
			if o.ExitReason == "" {
				t.Error("ExitReason empty")
			}
		}
	}
	if !haveDeployed {
		t.Fatalf("expected a deployed-cohort outcome; got %+v", outcomes)
	}
}

type stubSymbolEarnings struct {
	byTicker map[string][]RecentReport
	errOn    map[string]bool
}

func (s *stubSymbolEarnings) FetchSymbolReports(ctx context.Context, symbol string, from, to time.Time) ([]RecentReport, error) {
	if s.errOn[symbol] {
		return nil, fmt.Errorf("boom %s", symbol)
	}
	return s.byTicker[symbol], nil
}

func TestUniverseEarningsReporter_MergesAndSoftFails(t *testing.T) {
	stub := &stubSymbolEarnings{
		byTicker: map[string][]RecentReport{
			"AAA": {{Ticker: "AAA", Date: time.Now(), Timing: ""}},
			"BBB": {{Ticker: "BBB", Date: time.Now(), Timing: ""}},
		},
		errOn: map[string]bool{"CCC": true},
	}
	r := NewUniverseEarningsReporter(stub, []string{"AAA", "BBB", "CCC"})
	out, err := r.FetchReportsInRange(context.Background(), time.Now().AddDate(-1, 0, 0), time.Now())
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(out) != 2 { // AAA + BBB; CCC soft-failed
		t.Fatalf("got %d reports, want 2: %+v", len(out), out)
	}
}

func TestRunReplay_RecordsResolvedTiming(t *testing.T) {
	cont := buildContinuationBars("CONT")
	edate := cont[len(cont)-5].Timestamp
	stub := &stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{"CONT": cont}}
	// Reporter passes UNKNOWN timing ("") — the replay must infer it.
	rep := &stubRangeReporter{reports: []RecentReport{{Ticker: "CONT", Date: edate, Timing: ""}}}
	fr := StockFriction{PerShareSlippage: 0.02, StopGapThroughPct: 0.003, RegFeePerShare: 0.0001}

	outcomes, cov := RunReplay(context.Background(), stub, rep, []string{"CONT"},
		edate.AddDate(0, 0, -5), edate.AddDate(0, 0, 5), fr, stdExitCfg)

	// buildContinuationBars is BMO-shaped → inferred "bmo".
	if cov.TimingFill["bmo"] == 0 {
		t.Errorf("TimingFill = %+v, want bmo>0 (inferred)", cov.TimingFill)
	}
	if cov.TimingFill[""] != 0 {
		t.Errorf("TimingFill[\"\"] = %d, want 0 (no raw unknowns recorded)", cov.TimingFill[""])
	}
	var sawResolved bool
	for _, o := range outcomes {
		if o.Cohort == "deployed" {
			sawResolved = true
			if o.Timing != "bmo" {
				t.Errorf("outcome.Timing = %q, want bmo", o.Timing)
			}
			if o.TimingSource != "inferred" {
				t.Errorf("outcome.TimingSource = %q, want inferred", o.TimingSource)
			}
		}
	}
	if !sawResolved {
		t.Fatalf("no deployed outcome; got %+v", outcomes)
	}
}

func toT(cohort, timing, source string, ratio, gross, fr float64) TradeOutcome {
	return TradeOutcome{Cohort: cohort, ExitReason: "target", Timing: timing, TimingSource: source,
		TimingInferRatio: ratio, GrossReturnPct: gross, FrictionReturnPct: fr}
}

func TestAggregate_TimingBreakdownPerCohort(t *testing.T) {
	out := []TradeOutcome{
		toT("deployed", "bmo", "inferred", 4.0, 20, 19.9),
		toT("deployed", "amc", "inferred", 1.2, -10, -10.3), // near-tie (ratio<1.5)
		toT("deployed", "amc", "inferred_fallback", 0, 5, 4.9),
		toT("control", "bmo", "inferred", 3.0, 20, 19.9),
	}
	r := Aggregate(out)
	if r.DeployedTiming.BMO != 1 || r.DeployedTiming.AMC != 2 {
		t.Errorf("deployed split = %+v, want bmo=1 amc=2", r.DeployedTiming)
	}
	if r.DeployedTiming.Fallback != 1 {
		t.Errorf("deployed fallback = %d, want 1", r.DeployedTiming.Fallback)
	}
	if r.DeployedTiming.NearTies != 1 {
		t.Errorf("deployed near-ties = %d, want 1 (the ratio=1.2 inferred entry)", r.DeployedTiming.NearTies)
	}
	// Ratio stats over the two MEASURED inferred entries (4.0, 1.2): min 1.2, max 4.0.
	if r.DeployedTiming.RatioMin != 1.2 || r.DeployedTiming.RatioMax != 4.0 {
		t.Errorf("ratio min/max = %v/%v, want 1.2/4.0", r.DeployedTiming.RatioMin, r.DeployedTiming.RatioMax)
	}
	if r.ControlTiming.BMO != 1 {
		t.Errorf("control split = %+v, want bmo=1", r.ControlTiming)
	}
}

func TestFindEntries_NeverEvaluatesBeforeEPlus1(t *testing.T) {
	bars := buildContinuationBars("CONT")
	eIdx := len(bars) - 5
	edate := bars[eIdx].Timestamp.UTC().Format("2006-01-02")
	dep, ctrl := findEntries("CONT", bars, edate, "bmo", 14)
	// Any found entry's SignalIdx (evaluation day D) must be >= E+1; entry fills at D+1.
	for _, er := range []EntryResult{dep, ctrl} {
		if er.Found && er.SignalIdx <= eIdx {
			t.Errorf("evaluated day %d <= earnings idx %d — window start regressed to E (lookahead risk)", er.SignalIdx, eIdx)
		}
	}
}
