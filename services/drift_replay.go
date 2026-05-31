package services

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"prophet-trader/interfaces"
)

// StockFriction is the subset of config/friction.json's "stocks" profile the
// replay needs, plus provenance for reproducibility.
type StockFriction struct {
	PerShareSlippage  float64
	StopGapThroughPct float64
	RegFeePerShare    float64
	Version           string
	Hash              string // first 8 hex chars of sha256(file)
}

// LoadStockFriction reads the "stocks" block from config/friction.json. Fails
// loud on a missing or malformed file (no silent defaults).
func LoadStockFriction(path string) (StockFriction, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return StockFriction{}, fmt.Errorf("read friction config %s: %w", path, err)
	}
	var doc struct {
		Version string `json:"version"`
		Stocks  struct {
			PerShareSlippageUSD   float64 `json:"per_share_slippage_usd"`
			StopGapThroughPct     float64 `json:"stop_gap_through_pct"`
			RegulatoryFeePerShare float64 `json:"regulatory_fee_per_share"`
		} `json:"stocks"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return StockFriction{}, fmt.Errorf("parse friction config %s: %w", path, err)
	}
	sum := sha256.Sum256(raw)
	return StockFriction{
		PerShareSlippage:  doc.Stocks.PerShareSlippageUSD,
		StopGapThroughPct: doc.Stocks.StopGapThroughPct,
		RegFeePerShare:    doc.Stocks.RegulatoryFeePerShare,
		Version:           doc.Version,
		Hash:              fmt.Sprintf("%x", sum)[:8],
	}, nil
}

// frictionHaircut returns the per-share dollar haircut for a round trip. The
// stop_gap_through slippage is added ONLY for an intraday "stop" fill (assumed
// at exactly the stop price); a "stop_gap" exit already fills at the gapped-down
// open, which embeds the adverse move, so adding it again would double-count.
func frictionHaircut(entryPrice float64, reason string, f StockFriction) float64 {
	h := (f.PerShareSlippage + f.RegFeePerShare) * 2.0
	if reason == "stop" {
		h += f.StopGapThroughPct * entryPrice
	}
	return h
}

// ExitConfig parameterizes the daily-bar exit simulation. Defaults mirror Drift:
// 10% stop / 20% target / 60-trading-day time stop. The MA50-break leg is always
// active (it reuses computeDriftMA50).
type ExitConfig struct {
	StopPct      float64 // 0.10
	TargetPct    float64 // 0.20
	TimeStopDays int     // 60 (trading bars since entry)
}

// ExitResult is the outcome of one simulated trade. HoldingDays is in trading
// bars (ExitIdx - entryIdx). Reason ∈ {target, stop, stop_gap, target_gap, time,
// ma50_break, data_end}.
type ExitResult struct {
	ExitPrice    float64
	ExitIdx      int
	Reason       string
	HoldingDays  int
	RawReturnPct float64
}

func mkExit(price float64, idx, entryIdx int, entry float64, reason string) ExitResult {
	return ExitResult{
		ExitPrice:    roundTo2(price),
		ExitIdx:      idx,
		Reason:       reason,
		HoldingDays:  idx - entryIdx,
		RawReturnPct: roundTo2((price/entry - 1.0) * 100.0),
	}
}

// SimulateExit replays Drift's full exit on oldest-first daily bars, entering at
// bars[entryIdx].Open. Broker brackets (target/stop) fire intraday; the agent's
// EOD time-stop and MA50-break exits are decided at a bar's close and filled at
// the next session's open. Conservative tie-break: when an intraday bar pierces
// BOTH stop and target with stop < open < target, the stop is assumed first.
func SimulateExit(bars []*interfaces.Bar, entryIdx int, cfg ExitConfig) ExitResult {
	entry := bars[entryIdx].Open
	stop := entry * (1.0 - cfg.StopPct)
	target := entry * (1.0 + cfg.TargetPct)

	for i := entryIdx; i < len(bars); i++ {
		b := bars[i]

		// Intraday bracket, gap-priority first.
		if b.Open <= stop {
			return mkExit(b.Open, i, entryIdx, entry, "stop_gap")
		}
		if b.Open >= target {
			return mkExit(b.Open, i, entryIdx, entry, "target_gap")
		}
		lowHit := b.Low <= stop
		highHit := b.High >= target
		if lowHit { // stop-first covers the both-touched tie automatically
			return mkExit(stop, i, entryIdx, entry, "stop")
		}
		if highHit {
			return mkExit(target, i, entryIdx, entry, "target")
		}

		// EOD checks: decided at close i, filled at open i+1.
		timeStop := (i - entryIdx) >= cfg.TimeStopDays
		ma50 := computeDriftMA50(bars[:i+1])
		ma50Break := ma50.Warning == "" && !ma50.AboveMA
		if timeStop || ma50Break {
			reason := "ma50_break"
			if timeStop {
				reason = "time" // precedence; identical fill price either way
			}
			if i+1 < len(bars) {
				return mkExit(bars[i+1].Open, i+1, entryIdx, entry, reason)
			}
			return mkExit(b.Close, i, entryIdx, entry, "data_end")
		}
	}
	last := len(bars) - 1
	return mkExit(bars[last].Close, last, entryIdx, entry, "data_end")
}

// EntryResult is one cohort's entry for an earnings event. EntryIdx is the bar
// the trade fills on (signal day D + 1, the next session open). Found is false
// for a non-entry (no qualifying day, earnings absent, or qualifying on the last
// bar with no next-session open).
type EntryResult struct {
	Found          bool
	SignalIdx      int
	EntryIdx       int
	ExtensionPct   float64
	GapPct         float64
	DaysAfterGap   int
	CompositeScore float64
	Grade          string
	PeadStage      string
	EntryReason    string // continuation | pead_breakout | base_only
}

// findEntries scans trading days D in (earningsDate, earningsDate+windowCalDays]
// and returns the deployed cohort (base gates AND (continuation OR pead-ready),
// first qualifying day) and the control cohort (base gates only, first
// qualifying day). Entry fills at bars[D+1].Open; if D is the last bar, that
// cohort is a non-entry (Found=false). Signal is computed only on bars[:D+1] —
// no lookahead.
func findEntries(ticker string, bars []*interfaces.Bar, earningsDate, timing string, windowCalDays int) (deployed, control EntryResult) {
	idxE := findBarIndexByDate(bars, earningsDate)
	if idxE < 0 {
		return EntryResult{}, EntryResult{}
	}
	ed, err := time.Parse("2006-01-02", earningsDate)
	if err != nil {
		return EntryResult{}, EntryResult{}
	}
	windowEnd := ed.AddDate(0, 0, windowCalDays)

	mkEntry := func(sig *DriftSignal, d int, reason string) EntryResult {
		return EntryResult{
			Found:          true,
			SignalIdx:      d,
			EntryIdx:       d + 1,
			ExtensionPct:   sig.Continuation.ExtensionPct,
			GapPct:         sig.Gap.GapPct,
			DaysAfterGap:   sig.Continuation.DaysAfterGap,
			CompositeScore: sig.Composite.CompositeScore,
			Grade:          sig.Composite.Grade,
			PeadStage:      sig.PEAD.Stage,
			EntryReason:    reason,
		}
	}

	for d := idxE + 1; d < len(bars); d++ {
		bd := bars[d].Timestamp.UTC()
		if bd.Format("2006-01-02") <= earningsDate {
			continue
		}
		if bd.After(windowEnd) {
			break
		}
		if d+1 >= len(bars) {
			break // qualifying on the last bar → no next-session open to fill against
		}
		sig := ComputeDriftSignal(ticker, bars[:d+1], earningsDate, timing)
		baseGates := sig.Gap.GapPct >= 3.0 && sig.MA200.AboveMA && sig.MA50.AboveMA &&
			(sig.Composite.Grade == "A" || sig.Composite.Grade == "B")
		if !baseGates {
			continue
		}
		if !control.Found {
			control = mkEntry(sig, d, "base_only")
		}
		if !deployed.Found {
			peadReady := sig.PEAD.Stage == "SIGNAL_READY" || sig.PEAD.Stage == "BREAKOUT"
			if sig.Continuation.IsContinuation {
				deployed = mkEntry(sig, d, "continuation")
			} else if peadReady {
				deployed = mkEntry(sig, d, "pead_breakout")
			}
		}
		if deployed.Found && control.Found {
			break
		}
	}
	return deployed, control
}

// TradeOutcome is one simulated trade (one cohort, one event).
type TradeOutcome struct {
	Ticker            string  `json:"ticker"`
	EarningsDate      string  `json:"earnings_date"`
	Cohort            string  `json:"cohort"` // deployed | control
	EntryReason       string  `json:"entry_reason"`
	EntryPrice        float64 `json:"entry_price"`
	ExtensionPct      float64 `json:"extension_pct"`
	GapPct            float64 `json:"gap_pct"`
	DaysAfterGap      int     `json:"days_after_gap"`
	CompositeScore    float64 `json:"composite_score"`
	Grade             string  `json:"grade"`
	Timing            string  `json:"timing"`
	TimingSource      string  `json:"timing_source"`
	TimingInferRatio  float64 `json:"timing_infer_ratio"`
	ExitReason        string  `json:"exit_reason"`
	HoldingDays       int     `json:"holding_days"`
	GrossReturnPct    float64 `json:"gross_return_pct"`
	FrictionReturnPct float64 `json:"friction_return_pct"`
}

// CohortSummary holds expectancy stats for one cohort under one P&L basis.
type CohortSummary struct {
	N               int            `json:"n"`
	WinRate         float64        `json:"win_rate"`
	AvgWinPct       float64        `json:"avg_win_pct"`
	AvgLossPct      float64        `json:"avg_loss_pct"`
	ProfitFactor    float64        `json:"profit_factor"`
	ExpectancyPct   float64        `json:"expectancy_pct"`
	AvgHoldingDays  float64        `json:"avg_holding_days"`
	ExitReasonCount map[string]int `json:"exit_reason_count"`
}

// CohortReport bundles gross + friction summaries for one cohort.
type CohortReport struct {
	Gross    CohortSummary `json:"gross"`
	Friction CohortSummary `json:"friction"`
}

// Bucket is one extension_pct band (descriptive only).
type Bucket struct {
	Label      string  `json:"label"`
	Lo         float64 `json:"lo"`
	Hi         float64 `json:"hi"` // math.Inf(1) for the open top bucket
	N          int     `json:"n"`
	MeanReturn float64 `json:"mean_return_pct"`
	WinRate    float64 `json:"win_rate"`
	WinLoCI    float64 `json:"win_rate_ci_lo"`
	WinHiCI    float64 `json:"win_rate_ci_hi"`
}

// ReplaySummary is the full aggregation.
type ReplaySummary struct {
	Deployed             CohortReport  `json:"deployed"`
	Control              CohortReport  `json:"control"`
	DeployedTiming       TimingBreakdown `json:"deployed_timing"`
	ControlTiming        TimingBreakdown `json:"control_timing"`
	MarginalEdgeGrossPct float64      `json:"marginal_edge_gross_pct"`
	MarginalEdgeFricPct  float64      `json:"marginal_edge_friction_pct"`
	ExtSpearman          float64      `json:"extension_spearman"`
	ExtOLSSlope          float64      `json:"extension_ols_slope"`
	Buckets              []Bucket     `json:"extension_buckets"`
}

func ret(o TradeOutcome, friction bool) float64 {
	if friction {
		return o.FrictionReturnPct
	}
	return o.GrossReturnPct
}

func summarizeCohort(out []TradeOutcome, friction bool) CohortSummary {
	s := CohortSummary{ExitReasonCount: map[string]int{}}
	if len(out) == 0 {
		return s
	}
	var wins, losses, sumWin, sumLoss, sumRet, sumHold float64
	for _, o := range out {
		r := ret(o, friction)
		sumRet += r
		sumHold += float64(o.HoldingDays)
		s.ExitReasonCount[o.ExitReason]++
		if r > 0 {
			wins++
			sumWin += r
		} else {
			losses++
			sumLoss += -r
		}
	}
	n := float64(len(out))
	s.N = len(out)
	s.WinRate = wins / n
	if wins > 0 {
		s.AvgWinPct = roundTo2(sumWin / wins)
	}
	if losses > 0 {
		s.AvgLossPct = roundTo2(sumLoss / losses)
	}
	if sumLoss > 0 {
		s.ProfitFactor = roundTo2(sumWin / sumLoss)
	} else if sumWin > 0 {
		s.ProfitFactor = math.Inf(1)
	}
	s.ExpectancyPct = roundTo2(sumRet / n)
	s.AvgHoldingDays = roundTo2(sumHold / n)
	return s
}

func spearman(xs, ys []float64) float64 {
	return pearson(rank(xs), rank(ys))
}

func rank(v []float64) []float64 {
	type iv struct {
		idx int
		val float64
	}
	idx := make([]iv, len(v))
	for i, x := range v {
		idx[i] = iv{i, x}
	}
	sort.Slice(idx, func(a, b int) bool { return idx[a].val < idx[b].val })
	r := make([]float64, len(v))
	for i := 0; i < len(idx); {
		j := i
		for j+1 < len(idx) && idx[j+1].val == idx[i].val {
			j++
		}
		avg := float64(i+j)/2.0 + 1.0 // average rank (1-based) for ties
		for k := i; k <= j; k++ {
			r[idx[k].idx] = avg
		}
		i = j + 1
	}
	return r
}

func pearson(xs, ys []float64) float64 {
	n := float64(len(xs))
	if n == 0 {
		return 0
	}
	var sx, sy, sxx, syy, sxy float64
	for i := range xs {
		sx += xs[i]
		sy += ys[i]
		sxx += xs[i] * xs[i]
		syy += ys[i] * ys[i]
		sxy += xs[i] * ys[i]
	}
	den := math.Sqrt((n*sxx - sx*sx) * (n*syy - sy*sy))
	if den == 0 {
		return 0
	}
	return roundTo2((n*sxy - sx*sy) / den)
}

func olsSlope(xs, ys []float64) float64 {
	n := float64(len(xs))
	if n == 0 {
		return 0
	}
	var sx, sy, sxx, sxy float64
	for i := range xs {
		sx += xs[i]
		sy += ys[i]
		sxx += xs[i] * xs[i]
		sxy += xs[i] * ys[i]
	}
	den := n*sxx - sx*sx
	if den == 0 {
		return 0
	}
	return roundTo2((n*sxy - sx*sy) / den)
}

var extBucketEdges = []struct {
	label  string
	lo, hi float64
}{
	{"[0,1)", 0, 1},
	{"[1,2)", 1, 2},
	{"[2,4)", 2, 4},
	{"[4,7)", 4, 7},
	{"[7+]", 7, math.Inf(1)},
}

// TimingBreakdown summarizes one cohort's resolved-timing composition and the
// inference-confidence distribution over its MEASURED inferred entries. NearTies
// (0 < ratio < 1.5) is descriptive context for risk #1, not a gate.
type TimingBreakdown struct {
	BMO         int     `json:"bmo"`
	AMC         int     `json:"amc"`
	Fallback    int     `json:"fallback"`
	NearTies    int     `json:"near_ties"`
	RatioMin    float64 `json:"ratio_min"`
	RatioMedian float64 `json:"ratio_median"`
	RatioMax    float64 `json:"ratio_max"`
}

func summarizeTiming(out []TradeOutcome) TimingBreakdown {
	var tb TimingBreakdown
	var ratios []float64
	for _, o := range out {
		switch o.Timing {
		case "bmo":
			tb.BMO++
		case "amc":
			tb.AMC++
		}
		if o.TimingSource == "inferred_fallback" {
			tb.Fallback++
		}
		if o.TimingSource == "inferred" { // measured
			ratios = append(ratios, o.TimingInferRatio)
			if o.TimingInferRatio > 0 && o.TimingInferRatio < 1.5 {
				tb.NearTies++
			}
		}
	}
	if len(ratios) > 0 {
		sort.Float64s(ratios)
		tb.RatioMin = roundTo2(ratios[0])
		tb.RatioMax = roundTo2(ratios[len(ratios)-1])
		tb.RatioMedian = roundTo2(ratios[len(ratios)/2])
	}
	return tb
}

// wilson returns the Wilson 95% CI (z=1.96) for a proportion.
func wilson(wins, n float64) (lo, hi float64) {
	if n == 0 {
		return 0, 0
	}
	const z = 1.96
	p := wins / n
	d := 1 + z*z/n
	c := p + z*z/(2*n)
	m := z * math.Sqrt(p*(1-p)/n+z*z/(4*n*n))
	return (c - m) / d, (c + m) / d
}

func bucketize(out []TradeOutcome, friction bool) []Bucket {
	bs := make([]Bucket, len(extBucketEdges))
	sums := make([]float64, len(extBucketEdges))
	wins := make([]float64, len(extBucketEdges))
	for i, e := range extBucketEdges {
		bs[i] = Bucket{Label: e.label, Lo: e.lo, Hi: e.hi}
	}
	for _, o := range out {
		for i, e := range extBucketEdges {
			if o.ExtensionPct >= e.lo && (math.IsInf(e.hi, 1) || o.ExtensionPct < e.hi) {
				r := ret(o, friction)
				bs[i].N++
				sums[i] += r
				if r > 0 {
					wins[i]++
				}
				break
			}
		}
	}
	for i := range bs {
		if bs[i].N > 0 {
			n := float64(bs[i].N)
			bs[i].MeanReturn = roundTo2(sums[i] / n)
			bs[i].WinRate = roundTo2(wins[i] / n)
			lo, hi := wilson(wins[i], n)
			bs[i].WinLoCI = roundTo2(lo)
			bs[i].WinHiCI = roundTo2(hi)
		}
	}
	return bs
}

// Aggregate splits outcomes by cohort and computes all reported stats. The
// extension correlation/slope and buckets use the DEPLOYED cohort only (the
// rule under test). MarginalEdge = deployed minus control expectancy.
func Aggregate(outcomes []TradeOutcome) ReplaySummary {
	var dep, ctrl []TradeOutcome
	for _, o := range outcomes {
		if o.Cohort == "control" {
			ctrl = append(ctrl, o)
		} else {
			dep = append(dep, o)
		}
	}
	r := ReplaySummary{
		Deployed: CohortReport{summarizeCohort(dep, false), summarizeCohort(dep, true)},
		Control:  CohortReport{summarizeCohort(ctrl, false), summarizeCohort(ctrl, true)},
		Buckets:  bucketize(dep, true),
	}
	r.MarginalEdgeGrossPct = roundTo2(r.Deployed.Gross.ExpectancyPct - r.Control.Gross.ExpectancyPct)
	r.MarginalEdgeFricPct = roundTo2(r.Deployed.Friction.ExpectancyPct - r.Control.Friction.ExpectancyPct)
	if len(dep) >= 2 {
		xs := make([]float64, len(dep))
		ys := make([]float64, len(dep))
		for i, o := range dep {
			xs[i] = o.ExtensionPct
			ys[i] = o.FrictionReturnPct
		}
		r.ExtSpearman = spearman(xs, ys)
		r.ExtOLSSlope = olsSlope(xs, ys)
	}
	r.DeployedTiming = summarizeTiming(dep)
	r.ControlTiming = summarizeTiming(ctrl)
	return r
}

// RangeReporterFetcher is the narrow interface RunReplay needs.
// *EarningsCalendarService satisfies it.
type RangeReporterFetcher interface {
	FetchReportsInRange(ctx context.Context, from, to time.Time) ([]RecentReport, error)
}

// Coverage is the per-run scan accounting (mirrors the live scan-summary spirit).
type Coverage struct {
	EventsEnumerated int            `json:"events_enumerated"`
	InUniverse       int            `json:"in_universe"`
	BarsOK           int            `json:"bars_ok"`
	Dropped          map[string]int `json:"dropped"` // reason → count
	DeployedEntries  int            `json:"deployed_entries"`
	ControlEntries   int            `json:"control_entries"`
	NonEntries       int            `json:"non_entries"`
	NPeadEntries     int            `json:"n_pead_entries"`
	TimingFill      map[string]int `json:"timing_fill"` // bmo|amc → count (resolved)
	TimingFallback  int            `json:"timing_fallback"`
	PriceMin         float64        `json:"price_min"`
	PriceMedian      float64        `json:"price_median"`
	PriceMax         float64        `json:"price_max"`
	ActualFrom       string         `json:"actual_from"`
	ActualTo         string         `json:"actual_to"`
}

const driftReplayWindowCalDays = 14

// RunReplay enumerates earnings events in [from,to] within the universe, fetches
// one adjusted daily-bar window per symbol, finds deployed + control entries per
// event, simulates the full exit, and returns per-trade outcomes plus coverage.
// Soft-fails per symbol/event (counted in Coverage.Dropped), never panics.
func RunReplay(ctx context.Context, fetcher BarFetcher, earnings RangeReporterFetcher,
	universe []string, from, to time.Time, fr StockFriction, cfg ExitConfig) ([]TradeOutcome, Coverage) {

	cov := Coverage{Dropped: map[string]int{}, TimingFill: map[string]int{}}
	uset := map[string]bool{}
	for _, u := range universe {
		uset[strings.ToUpper(u)] = true
	}

	reports, err := earnings.FetchReportsInRange(ctx, from, to)
	if err != nil {
		cov.Dropped["earnings_fetch_error"]++
		return nil, cov
	}
	cov.EventsEnumerated = len(reports)

	type ev struct {
		date   time.Time
		timing string
	}
	bySym := map[string][]ev{}
	for _, r := range reports {
		sym := strings.ToUpper(r.Ticker)
		if !uset[sym] {
			continue
		}
		cov.InUniverse++
		bySym[sym] = append(bySym[sym], ev{r.Date, r.Timing})
	}

	var outcomes []TradeOutcome
	var entryPrices []float64
	var minDate, maxDate time.Time

	for sym, evs := range bySym {
		earliest, latest := evs[0].date, evs[0].date
		for _, e := range evs {
			if e.date.Before(earliest) {
				earliest = e.date
			}
			if e.date.After(latest) {
				latest = e.date
			}
		}
		start := earliest.AddDate(0, 0, -365)
		end := latest.AddDate(0, 0, 120)
		bars, ferr := fetcher.GetHistoricalBars(ctx, sym, start, end, "1Day")
		if ferr != nil || len(bars) < driftMinBars {
			cov.Dropped["bars_missing_or_short"]++
			continue
		}
		cov.BarsOK++
		if minDate.IsZero() || start.Before(minDate) {
			minDate = bars[0].Timestamp
		}
		if end.After(maxDate) {
			maxDate = bars[len(bars)-1].Timestamp
		}

		for _, e := range evs {
			edate := e.date.Format("2006-01-02")
			if findBarIndexByDate(bars, edate) < 0 {
				cov.Dropped["earnings_not_in_bars"]++
				continue
			}
			res := resolveDriftTiming(bars, edate, e.timing, true) // always infer offline
			cov.TimingFill[res.Timing]++
			if res.Source == "inferred_fallback" {
				cov.TimingFallback++
			}
			dep, ctrl := findEntries(sym, bars, edate, res.Timing, driftReplayWindowCalDays)
			if !dep.Found && !ctrl.Found {
				cov.NonEntries++
				continue
			}
			for _, c := range []struct {
				cohort string
				er     EntryResult
			}{{"deployed", dep}, {"control", ctrl}} {
				if !c.er.Found {
					continue
				}
				ex := SimulateExit(bars, c.er.EntryIdx, cfg)
				entry := bars[c.er.EntryIdx].Open
				gross := ex.RawReturnPct
				hc := frictionHaircut(entry, ex.Reason, fr)
				fric := roundTo2(((ex.ExitPrice-hc)/entry - 1.0) * 100.0)
				outcomes = append(outcomes, TradeOutcome{
					Ticker: sym, EarningsDate: edate, Cohort: c.cohort,
					EntryReason: c.er.EntryReason, EntryPrice: roundTo2(entry),
					ExtensionPct: c.er.ExtensionPct, GapPct: c.er.GapPct,
					DaysAfterGap: c.er.DaysAfterGap, CompositeScore: c.er.CompositeScore,
					Grade: c.er.Grade, ExitReason: ex.Reason, HoldingDays: ex.HoldingDays,
					GrossReturnPct: gross, FrictionReturnPct: fric,
					Timing: res.Timing, TimingSource: res.Source, TimingInferRatio: res.Ratio,
				})
				if c.cohort == "deployed" {
					cov.DeployedEntries++
					entryPrices = append(entryPrices, entry)
					if c.er.EntryReason == "pead_breakout" {
						cov.NPeadEntries++
					}
				} else {
					cov.ControlEntries++
				}
			}
		}
	}

	if len(entryPrices) > 0 {
		sort.Float64s(entryPrices)
		cov.PriceMin = roundTo2(entryPrices[0])
		cov.PriceMax = roundTo2(entryPrices[len(entryPrices)-1])
		cov.PriceMedian = roundTo2(entryPrices[len(entryPrices)/2])
	}
	if !minDate.IsZero() {
		cov.ActualFrom = minDate.Format("2006-01-02")
		cov.ActualTo = maxDate.Format("2006-01-02")
	}
	return outcomes, cov
}

// SymbolEarningsFetcher fetches one symbol's reported earnings in a window.
// *EarningsCalendarService satisfies it via FetchSymbolReports.
type SymbolEarningsFetcher interface {
	FetchSymbolReports(ctx context.Context, symbol string, from, to time.Time) ([]RecentReport, error)
}

// UniverseEarningsReporter adapts a per-symbol earnings fetcher to the
// RangeReporterFetcher interface RunReplay expects, by fetching each universe
// symbol's reported earnings and concatenating them. It uses the per-symbol
// /stable/earnings endpoint, which (unlike /stable/earnings-calendar) is neither
// ~1-year capped nor 4000-row truncated. Soft-fails per symbol.
type UniverseEarningsReporter struct {
	fetcher  SymbolEarningsFetcher
	universe []string
}

func NewUniverseEarningsReporter(fetcher SymbolEarningsFetcher, universe []string) *UniverseEarningsReporter {
	return &UniverseEarningsReporter{fetcher: fetcher, universe: universe}
}

// FetchReportsInRange fetches every universe symbol's reported earnings in
// [from, to] and concatenates them. A per-symbol fetch error is skipped so one
// bad ticker does not abort the run.
func (u *UniverseEarningsReporter) FetchReportsInRange(ctx context.Context, from, to time.Time) ([]RecentReport, error) {
	var all []RecentReport
	for _, sym := range u.universe {
		reps, err := u.fetcher.FetchSymbolReports(ctx, sym, from, to)
		if err != nil {
			continue
		}
		all = append(all, reps...)
	}
	return all, nil
}
