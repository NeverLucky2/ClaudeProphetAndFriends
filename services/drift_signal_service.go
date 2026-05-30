package services

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"prophet-trader/interfaces"

	"github.com/sirupsen/logrus"
)

// ErrInsufficientDriftHistory is returned when a ticker has fewer bars than
// required for the MA200 calculation (200 closes + warmup).
var ErrInsufficientDriftHistory = errors.New("insufficient bar history for drift signal")

const (
	driftMinBars       = 210
	driftBarLookback   = 365 // calendar days
	driftSignalVersion = "v1"

	driftWeightGap   = 0.25
	driftWeightTrend = 0.30
	driftWeightVol   = 0.20
	driftWeightMA200 = 0.15
	driftWeightMA50  = 0.10

	driftGradeAThreshold = 85.0
	driftGradeBThreshold = 70.0
	driftGradeCThreshold = 55.0

	driftPEADWatchWeeks = 5
)

// DriftGap is the gap-component result.
type DriftGap struct {
	GapPct     float64 `json:"gap_pct"`
	GapType    string  `json:"gap_type"`
	BasePrice  float64 `json:"base_price"`
	GapPrice   float64 `json:"gap_price"`
	TimingUsed string  `json:"timing_used"`
	Score      float64 `json:"score"`
	Warning    string  `json:"warning,omitempty"`
}

// findBarIndexByDate returns the index in bars whose Timestamp date equals
// dateYMD (YYYY-MM-DD), comparing in UTC. Returns -1 if not found.
func findBarIndexByDate(bars []*interfaces.Bar, dateYMD string) int {
	for i, b := range bars {
		if b.Timestamp.UTC().Format("2006-01-02") == dateYMD {
			return i
		}
	}
	return -1
}

// scoreGap maps abs(gap%) to a 0–100 component score.
func scoreGap(absGapPct float64) float64 {
	switch {
	case absGapPct >= 10.0:
		return 100.0
	case absGapPct >= 7.0:
		return 85.0
	case absGapPct >= 5.0:
		return 70.0
	case absGapPct >= 3.0:
		return 55.0
	case absGapPct >= 1.0:
		return 35.0
	default:
		return 15.0
	}
}

// computeDriftGap computes the post-earnings gap.
//
//	BMO: gap = open[earnings_date]  / close[prev_trading_day] - 1
//	AMC / unknown: gap = open[next_trading_day] / close[earnings_date] - 1
//
// Bars are oldest-first.
func computeDriftGap(bars []*interfaces.Bar, earningsDate, timing string) DriftGap {
	idx := findBarIndexByDate(bars, earningsDate)
	if idx < 0 {
		return DriftGap{TimingUsed: timing, Warning: "earnings_date not in bars"}
	}
	t := strings.ToLower(timing)
	var base, gap float64
	if t == "bmo" {
		if idx == 0 {
			return DriftGap{TimingUsed: t, Warning: "no prior bar for BMO gap"}
		}
		base = bars[idx-1].Close
		gap = bars[idx].Open
	} else {
		if idx+1 >= len(bars) {
			return DriftGap{TimingUsed: t, Warning: "no next bar for AMC gap"}
		}
		base = bars[idx].Close
		gap = bars[idx+1].Open
	}
	if base == 0 {
		return DriftGap{TimingUsed: t, Warning: "base price zero"}
	}
	gapPct := (gap/base - 1.0) * 100.0
	g := DriftGap{
		GapPct:     roundTo2(gapPct),
		BasePrice:  roundTo2(base),
		GapPrice:   roundTo2(gap),
		TimingUsed: t,
		Score:      scoreGap(math.Abs(gapPct)),
	}
	if gapPct >= 0 {
		g.GapType = "up"
	} else {
		g.GapType = "down"
	}
	return g
}

// roundTo2 rounds to 2 decimal places using math.Round (banker-safe).
func roundTo2(v float64) float64 {
	return math.Round(v*100) / 100
}

// DriftTrend is the pre-earnings 20-day trend component.
type DriftTrend struct {
	Return20dPct   float64 `json:"return_20d_pct"`
	TrendDirection string  `json:"trend_direction"`
	Score          float64 `json:"score"`
	Warning        string  `json:"warning,omitempty"`
}

func scoreTrend(retPct float64) float64 {
	switch {
	case retPct >= 15.0:
		return 100.0
	case retPct >= 10.0:
		return 85.0
	case retPct >= 5.0:
		return 70.0
	case retPct >= 0.0:
		return 50.0
	case retPct >= -5.0:
		return 30.0
	default:
		return 15.0
	}
}

func computeDriftTrend(bars []*interfaces.Bar, earningsDate string) DriftTrend {
	idx := findBarIndexByDate(bars, earningsDate)
	if idx < 0 {
		return DriftTrend{Warning: "earnings_date not in bars"}
	}
	lookback := idx - 20
	if lookback < 0 {
		return DriftTrend{Warning: "insufficient lookback for 20d trend"}
	}
	base := bars[lookback].Close
	if base == 0 {
		return DriftTrend{Warning: "lookback close zero"}
	}
	ret := (bars[idx].Close/base - 1.0) * 100.0
	tr := DriftTrend{Return20dPct: roundTo2(ret), Score: scoreTrend(ret)}
	if ret >= 0 {
		tr.TrendDirection = "up"
	} else {
		tr.TrendDirection = "down"
	}
	return tr
}

// DriftVolRatio is the 20-day-vs-60-day volume ratio component.
type DriftVolRatio struct {
	VolRatio2060    float64 `json:"vol_ratio_20_60"`
	RecentAvgVolume int64   `json:"recent_avg_volume"`
	LongerAvgVolume int64   `json:"longer_avg_volume"`
	Score           float64 `json:"score"`
	Warning         string  `json:"warning,omitempty"`
}

func scoreVolRatio(ratio float64) float64 {
	switch {
	case ratio >= 2.0:
		return 100.0
	case ratio >= 1.5:
		return 80.0
	case ratio >= 1.2:
		return 60.0
	case ratio >= 1.0:
		return 40.0
	default:
		return 20.0
	}
}

// computeDriftVolRatio computes the 20-day vs 60-day average volume ratio
// using the window ending at the earnings bar. In oldest-first ordering, the
// 20-day window is bars[idx-19..idx] and the 60-day window is bars[idx-59..idx].
func computeDriftVolRatio(bars []*interfaces.Bar, earningsDate string) DriftVolRatio {
	idx := findBarIndexByDate(bars, earningsDate)
	if idx < 0 {
		return DriftVolRatio{Warning: "earnings_date not in bars"}
	}
	if idx < 59 {
		return DriftVolRatio{Warning: "insufficient bars for 60d volume window"}
	}
	var sum20, sum60 int64
	for i := idx - 19; i <= idx; i++ {
		sum20 += bars[i].Volume
	}
	for i := idx - 59; i <= idx; i++ {
		sum60 += bars[i].Volume
	}
	avg20 := float64(sum20) / 20.0
	avg60 := float64(sum60) / 60.0
	if avg60 == 0 {
		return DriftVolRatio{
			RecentAvgVolume: int64(avg20),
			Warning:         "longer-window average volume zero",
		}
	}
	ratio := avg20 / avg60
	return DriftVolRatio{
		VolRatio2060:    roundTo2(ratio),
		RecentAvgVolume: int64(avg20),
		LongerAvgVolume: int64(avg60),
		Score:           scoreVolRatio(ratio),
	}
}

// DriftMAPosition is the price-vs-moving-average component. Used for both the
// MA200 and MA50 sections of the signal; AboveMA is interpreted in context of
// the parent field (ma200_position vs ma50_position).
type DriftMAPosition struct {
	MA          float64 `json:"ma"`
	DistancePct float64 `json:"distance_pct"`
	AboveMA     bool    `json:"above_ma"`
	Score       float64 `json:"score"`
	Warning     string  `json:"warning,omitempty"`
}

func scoreMA200Distance(distancePct float64) float64 {
	switch {
	case distancePct >= 20.0:
		return 100.0
	case distancePct >= 10.0:
		return 85.0
	case distancePct >= 5.0:
		return 70.0
	case distancePct >= 0.0:
		return 55.0
	case distancePct >= -5.0:
		return 35.0
	default:
		return 15.0
	}
}

func computeDriftMA200(bars []*interfaces.Bar) DriftMAPosition {
	L := len(bars)
	if L < 200 {
		return DriftMAPosition{Warning: fmt.Sprintf("insufficient bars for MA200: %d/200", L)}
	}
	var sum float64
	for i := L - 200; i < L; i++ {
		sum += bars[i].Close
	}
	ma := sum / 200.0
	if ma == 0 {
		return DriftMAPosition{Warning: "MA200 is zero"}
	}
	current := bars[L-1].Close
	dist := (current/ma - 1.0) * 100.0
	return DriftMAPosition{
		MA:          roundTo2(ma),
		DistancePct: roundTo2(dist),
		AboveMA:     dist >= 0,
		Score:       scoreMA200Distance(dist),
	}
}

func scoreMA50Distance(distancePct float64) float64 {
	switch {
	case distancePct >= 10.0:
		return 100.0
	case distancePct >= 5.0:
		return 80.0
	case distancePct >= 0.0:
		return 60.0
	case distancePct >= -5.0:
		return 35.0
	default:
		return 15.0
	}
}

func computeDriftMA50(bars []*interfaces.Bar) DriftMAPosition {
	L := len(bars)
	if L < 50 {
		return DriftMAPosition{Warning: fmt.Sprintf("insufficient bars for MA50: %d/50", L)}
	}
	var sum float64
	for i := L - 50; i < L; i++ {
		sum += bars[i].Close
	}
	ma := sum / 50.0
	if ma == 0 {
		return DriftMAPosition{Warning: "MA50 is zero"}
	}
	current := bars[L-1].Close
	dist := (current/ma - 1.0) * 100.0
	return DriftMAPosition{
		MA:          roundTo2(ma),
		DistancePct: roundTo2(dist),
		AboveMA:     dist >= 0,
		Score:       scoreMA50Distance(dist),
	}
}

// computeDriftContinuation evaluates the robust higher-high continuation rule:
//
//	IsContinuation = DaysAfterGap >= 1
//	    AND latestClose > gapBarHigh   (cleared the earnings reaction high)
//	    AND latestClose > priorHigh    (fresh higher-high close, still advancing)
//
// Day-1 note: when DaysAfterGap == 1 the gap bar IS the prior bar, so
// GapBarHigh == PriorHigh and the two comparisons coincide (this matches the
// original spec's day-1 "close > previous day's high"); the higher-high confirm
// only adds independent filtering from day 2 on. Do not "simplify" the two
// checks into one.
func computeDriftContinuation(bars []*interfaces.Bar, earningsDate, timing string) DriftContinuation {
	idx := findBarIndexByDate(bars, earningsDate)
	if idx < 0 {
		return DriftContinuation{Warning: "earnings_date not in bars"}
	}
	gapBarIdx := idx
	if strings.ToLower(timing) != "bmo" {
		gapBarIdx = idx + 1 // AMC / unknown: gap manifests on the next bar's open
	}
	if gapBarIdx >= len(bars) {
		return DriftContinuation{Warning: "no gap bar yet for AMC"}
	}
	L := len(bars)
	if L < 2 {
		return DriftContinuation{Warning: "insufficient bars for continuation"}
	}
	latestIdx := L - 1
	gapBarHigh := bars[gapBarIdx].High
	latestClose := bars[L-1].Close
	priorHigh := bars[L-2].High
	daysAfterGap := latestIdx - gapBarIdx

	var extPct float64
	if gapBarHigh > 0 {
		extPct = roundTo2((latestClose/gapBarHigh - 1.0) * 100.0)
	}

	isCont := daysAfterGap >= 1 && latestClose > gapBarHigh && latestClose > priorHigh
	return DriftContinuation{
		IsContinuation: isCont,
		GapBarHigh:     roundTo2(gapBarHigh),
		LatestClose:    roundTo2(latestClose),
		PriorHigh:      roundTo2(priorHigh),
		DaysAfterGap:   daysAfterGap,
		ExtensionPct:   extPct,
	}
}

// DriftComposite is the weighted-sum scorecard with grade and component
// breakdown. ComponentBreakdown values are weighted contributions (raw
// score * weight) so callers can audit how the composite was built.
type DriftComposite struct {
	CompositeScore     float64            `json:"composite_score"`
	Grade              string             `json:"grade"`
	GradeDescription   string             `json:"grade_description"`
	ComponentBreakdown map[string]float64 `json:"component_breakdown"`
}

func computeDriftComposite(gapScore, trendScore, volScore, ma200Score, ma50Score float64) DriftComposite {
	composite := gapScore*driftWeightGap +
		trendScore*driftWeightTrend +
		volScore*driftWeightVol +
		ma200Score*driftWeightMA200 +
		ma50Score*driftWeightMA50
	composite = roundTo2(composite)

	grade, desc := "D", "Weak setup, avoid"
	switch {
	case composite >= driftGradeAThreshold:
		grade, desc = "A", "Strong earnings reaction with institutional accumulation"
	case composite >= driftGradeBThreshold:
		grade, desc = "B", "Good earnings reaction worth monitoring"
	case composite >= driftGradeCThreshold:
		grade, desc = "C", "Mixed signals, use caution"
	}

	return DriftComposite{
		CompositeScore:   composite,
		Grade:            grade,
		GradeDescription: desc,
		ComponentBreakdown: map[string]float64{
			"gap_size":           roundTo2(gapScore * driftWeightGap),
			"pre_earnings_trend": roundTo2(trendScore * driftWeightTrend),
			"volume_trend":       roundTo2(volScore * driftWeightVol),
			"ma200_position":     roundTo2(ma200Score * driftWeightMA200),
			"ma50_position":      roundTo2(ma50Score * driftWeightMA50),
		},
	}
}

// DriftWeeklyCandle is one aggregated ISO-week candle. Oldest-first ordering.
type DriftWeeklyCandle struct {
	WeekStart   string  `json:"week_start"` // ISO Monday YYYY-MM-DD
	Year        int     `json:"year"`
	Week        int     `json:"week"`
	Open        float64 `json:"open"`
	High        float64 `json:"high"`
	Low         float64 `json:"low"`
	Close       float64 `json:"close"`
	Volume      int64   `json:"volume"`
	IsGreen     bool    `json:"is_green"`
	PartialWeek bool    `json:"partial_week"`
	TradingDays int     `json:"trading_days"`
}

// dailyToWeekly groups daily bars into ISO-week candles. Bars are oldest-first;
// returned weeks are also oldest-first.
func dailyToWeekly(bars []*interfaces.Bar) []DriftWeeklyCandle {
	if len(bars) == 0 {
		return nil
	}
	type key struct{ year, week int }
	groups := map[key][]*interfaces.Bar{}
	keys := make([]key, 0)
	for _, b := range bars {
		y, w := b.Timestamp.UTC().ISOWeek()
		k := key{y, w}
		if _, ok := groups[k]; !ok {
			keys = append(keys, k)
		}
		groups[k] = append(groups[k], b)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].year != keys[j].year {
			return keys[i].year < keys[j].year
		}
		return keys[i].week < keys[j].week
	})
	out := make([]DriftWeeklyCandle, 0, len(keys))
	for _, k := range keys {
		days := groups[k]
		open := days[0].Open
		closeP := days[len(days)-1].Close
		high := days[0].High
		low := days[0].Low
		var vol int64
		for _, d := range days {
			if d.High > high {
				high = d.High
			}
			if d.Low < low {
				low = d.Low
			}
			vol += d.Volume
		}
		monday := isoWeekMonday(k.year, k.week)
		out = append(out, DriftWeeklyCandle{
			WeekStart:   monday.Format("2006-01-02"),
			Year:        k.year,
			Week:        k.week,
			Open:        roundTo2(open),
			High:        roundTo2(high),
			Low:         roundTo2(low),
			Close:       roundTo2(closeP),
			Volume:      vol,
			IsGreen:     closeP >= open,
			PartialWeek: len(days) < 5,
			TradingDays: len(days),
		})
	}
	return out
}

// isoWeekMonday returns the Monday date of the given ISO year+week.
func isoWeekMonday(year, week int) time.Time {
	jan4 := time.Date(year, 1, 4, 0, 0, 0, 0, time.UTC)
	weekday := int(jan4.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	week1Monday := jan4.AddDate(0, 0, -(weekday - 1))
	return week1Monday.AddDate(0, 0, (week-1)*7)
}

// DriftRedCandle is the weekly red-candle pullback we look for after earnings.
type DriftRedCandle struct {
	WeekStart    string  `json:"week_start"`
	WeekIndex    int     `json:"week_index"`
	Open         float64 `json:"open"`
	High         float64 `json:"high"`
	Low          float64 `json:"low"`
	Close        float64 `json:"close"`
	LowerWickPct float64 `json:"lower_wick_pct"`
	VolumeVsAvg  float64 `json:"volume_vs_avg"`
}

// DriftPEAD is the PEAD pattern classification.
type DriftPEAD struct {
	WeeksSinceEarnings int             `json:"weeks_since_earnings"`
	EarningsWeekIdx    int             `json:"earnings_week_idx"`
	RedCandle          *DriftRedCandle `json:"red_candle,omitempty"`
	IsBreakout         bool            `json:"is_breakout"`
	BreakoutPct        float64         `json:"breakout_pct"`
	Stage              string          `json:"stage"`
}

// DriftContinuation is the fast post-earnings continuation signal: a fresh
// higher-high close above the gap-bar high, confirming the move is still
// advancing. Bars are oldest-first. The gap bar is the bar the earnings gap is
// measured on (earningsIdx for BMO, earningsIdx+1 for AMC) — matching
// computeDriftGap.
type DriftContinuation struct {
	IsContinuation bool    `json:"is_continuation"`
	GapBarHigh     float64 `json:"gap_bar_high"`
	LatestClose    float64 `json:"latest_close"`
	PriorHigh      float64 `json:"prior_high"`
	DaysAfterGap   int     `json:"days_after_gap"`
	ExtensionPct   float64 `json:"extension_pct"` // (latest_close / gap_bar_high - 1) * 100
	Warning        string  `json:"warning,omitempty"`
}

// findEarningsWeekIdx returns the index of the ISO-week containing
// earningsDate in oldest-first weeklyCandles, or -1.
func findEarningsWeekIdx(weeklies []DriftWeeklyCandle, earningsDate string) int {
	t, err := time.Parse("2006-01-02", earningsDate)
	if err != nil {
		return -1
	}
	ey, ew := t.ISOWeek()
	for i, w := range weeklies {
		if w.Year == ey && w.Week == ew {
			return i
		}
	}
	return -1
}

// findDriftRedCandle finds the most recent red weekly candle strictly after
// the earnings week (oldest-first ordering → highest index that's red and
// > earningsIdx). Returns nil if none found.
func findDriftRedCandle(weeklies []DriftWeeklyCandle, earningsIdx int) *DriftRedCandle {
	if earningsIdx < 0 || earningsIdx >= len(weeklies)-1 {
		return nil
	}
	// Skip the most recent candle if it is the "current" (breakout candidate)
	// candle: we only want red candles strictly between earnings and now.
	// The most recent candle is checked as the breakout candidate by
	// analyzeDriftPEAD instead.
	for i := len(weeklies) - 2; i > earningsIdx; i-- {
		c := weeklies[i]
		if c.IsGreen {
			continue
		}
		var lowerWickPct float64
		rng := c.High - c.Low
		if rng > 0 {
			bodyLow := c.Open
			if c.Close < bodyLow {
				bodyLow = c.Close
			}
			lowerWickPct = (bodyLow - c.Low) / rng * 100.0
		}
		var sum int64
		var cnt int
		for j := i - 2; j <= i+2; j++ {
			if j == i || j < 0 || j >= len(weeklies) {
				continue
			}
			sum += weeklies[j].Volume
			cnt++
		}
		volRatio := 1.0
		if cnt > 0 && sum > 0 {
			volRatio = float64(c.Volume) / (float64(sum) / float64(cnt))
		}
		return &DriftRedCandle{
			WeekStart:    c.WeekStart,
			WeekIndex:    i,
			Open:         c.Open,
			High:         c.High,
			Low:          c.Low,
			Close:        c.Close,
			LowerWickPct: roundTo2(lowerWickPct),
			VolumeVsAvg:  roundTo2(volRatio),
		}
	}
	return nil
}

// analyzeDriftPEAD classifies the PEAD pattern stage given oldest-first
// weeklyCandles, the earnings date, and a watch-week budget.
func analyzeDriftPEAD(weeklies []DriftWeeklyCandle, earningsDate string, watchWeeks int) DriftPEAD {
	res := DriftPEAD{EarningsWeekIdx: -1, Stage: "MONITORING"}
	if len(weeklies) == 0 {
		return res
	}
	earningsIdx := findEarningsWeekIdx(weeklies, earningsDate)
	res.EarningsWeekIdx = earningsIdx
	if earningsIdx >= 0 {
		res.WeeksSinceEarnings = len(weeklies) - 1 - earningsIdx
	}
	if res.WeeksSinceEarnings > watchWeeks {
		res.Stage = "EXPIRED"
		return res
	}
	red := findDriftRedCandle(weeklies, earningsIdx)
	if red == nil {
		return res
	}
	res.RedCandle = red
	current := weeklies[len(weeklies)-1]
	if current.IsGreen && current.Close > red.High {
		res.IsBreakout = true
		if red.High != 0 {
			res.BreakoutPct = roundTo2((current.Close - red.High) / red.High * 100.0)
		}
		res.Stage = "BREAKOUT"
		return res
	}
	res.Stage = "SIGNAL_READY"
	return res
}

// DriftSignal is the full per-ticker drift signal payload.
type DriftSignal struct {
	Ticker         string            `json:"ticker"`
	AsOf           string            `json:"as_of"`
	BarsCount      int               `json:"bars_count"`
	LastClose      float64           `json:"last_close"`
	EarningsDate   string            `json:"earnings_date"`
	EarningsTiming string            `json:"earnings_timing"`
	Gap            DriftGap          `json:"gap"`
	Trend          DriftTrend        `json:"pre_earnings_trend"`
	VolRatio       DriftVolRatio     `json:"volume_trend"`
	MA200          DriftMAPosition   `json:"ma200_position"`
	MA50           DriftMAPosition   `json:"ma50_position"`
	Composite      DriftComposite    `json:"composite"`
	PEAD           DriftPEAD         `json:"pead"`
	Continuation   DriftContinuation `json:"continuation"`
	SignalVersion  string            `json:"signal_version"`
}

// DriftSignalService is the per-ticker compute service.
type DriftSignalService struct {
	dataSvc BarFetcher
}

// NewDriftSignalService creates a DriftSignalService backed by the given
// bar-fetching data source. AlpacaDataService implements BarFetcher.
func NewDriftSignalService(dataSvc BarFetcher) *DriftSignalService {
	return &DriftSignalService{dataSvc: dataSvc}
}

// GetSignal fetches bars for symbol and computes the full signal.
// Returns ErrInsufficientDriftHistory if fewer than driftMinBars bars are
// available.
func (s *DriftSignalService) GetSignal(ctx context.Context, symbol, earningsDate, timing string) (*DriftSignal, error) {
	end := time.Now()
	start := end.AddDate(0, 0, -driftBarLookback)
	bars, err := s.dataSvc.GetHistoricalBars(ctx, symbol, start, end, "1Day")
	if err != nil {
		return nil, fmt.Errorf("fetch bars for %s: %w", symbol, err)
	}
	if len(bars) < driftMinBars {
		return nil, ErrInsufficientDriftHistory
	}
	return ComputeDriftSignal(symbol, bars, earningsDate, timing), nil
}

// ComputeDriftSignal is the pure-function form. Bars are oldest-first.
// Exposed so tests can drive it with synthetic bars without going through
// Alpaca.
func ComputeDriftSignal(symbol string, bars []*interfaces.Bar, earningsDate, timing string) *DriftSignal {
	L := len(bars)
	gap := computeDriftGap(bars, earningsDate, timing)
	trend := computeDriftTrend(bars, earningsDate)
	vol := computeDriftVolRatio(bars, earningsDate)
	ma200 := computeDriftMA200(bars)
	ma50 := computeDriftMA50(bars)
	composite := computeDriftComposite(gap.Score, trend.Score, vol.Score, ma200.Score, ma50.Score)
	weeklies := dailyToWeekly(bars)
	pead := analyzeDriftPEAD(weeklies, earningsDate, driftPEADWatchWeeks)
	continuation := computeDriftContinuation(bars, earningsDate, timing)
	return &DriftSignal{
		Ticker:         strings.ToUpper(symbol),
		AsOf:           bars[L-1].Timestamp.Format(time.RFC3339),
		BarsCount:      L,
		LastClose:      bars[L-1].Close,
		EarningsDate:   earningsDate,
		EarningsTiming: timing,
		Gap:            gap,
		Trend:          trend,
		VolRatio:       vol,
		MA200:          ma200,
		MA50:           ma50,
		Composite:      composite,
		PEAD:           pead,
		Continuation:   continuation,
		SignalVersion:  driftSignalVersion,
	}
}

// DriftUniverse is the curated universe for v1. Reuses MeanRevUniverse to
// keep large-cap coverage consistent across the Coil/Drift sleeves. Universe
// expansion to broader S&P 500 or Russell 1000 is a v2 concern.
var DriftUniverse = append([]string{}, MeanRevUniverse...)

// RecentReporterFetcher is the narrow interface DriftCandidatesService
// depends on. EarningsCalendarService.FetchRecentReports satisfies it.
type RecentReporterFetcher interface {
	FetchRecentReports(ctx context.Context, now time.Time, days int) ([]RecentReport, error)
}

// DriftCandidatesResponse is the JSON shape returned by GET /api/v1/drift/candidates.
type DriftCandidatesResponse struct {
	AsOf       string        `json:"as_of"`
	Count      int           `json:"count"`
	Candidates []DriftSignal `json:"candidates"`
	Errors     []string      `json:"errors,omitempty"`
}

// DriftCandidatesService aggregates recent reports, computes per-ticker
// signals, filters by entry criteria, and ranks by composite descending.
type DriftCandidatesService struct {
	signalSvc       *DriftSignalService
	earnings        RecentReporterFetcher
	universe        map[string]bool
	logger          *logrus.Logger
	mu              sync.RWMutex
	cached          *DriftCandidatesResponse
	cachedAt        time.Time
	refreshInterval time.Duration
	continuationEnabled bool
}

// NewDriftCandidatesService creates the candidates service.
//   - signalSvc: per-symbol bar fetch + signal computation
//   - earnings: recent-reporter source (EarningsCalendarService satisfies it)
//   - universe: optional override (nil = use DriftUniverse default)
func NewDriftCandidatesService(signalSvc *DriftSignalService, earnings RecentReporterFetcher, universe []string) *DriftCandidatesService {
	if universe == nil {
		universe = DriftUniverse
	}
	uset := make(map[string]bool, len(universe))
	for _, t := range universe {
		uset[strings.ToUpper(t)] = true
	}
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &DriftCandidatesService{
		signalSvc:       signalSvc,
		earnings:        earnings,
		universe:        uset,
		logger:          logger,
		refreshInterval: 5 * time.Minute,
	}
}

// SetRefreshInterval overrides the cache TTL. Negative disables caching.
func (s *DriftCandidatesService) SetRefreshInterval(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshInterval = d
}

// SetContinuationEnabled toggles the continuation entry path. Default false
// (shadow): the candidate filter is unchanged and continuation is reported as
// false to the agent (would-be entries are logged only). True (enforce): the
// filter tightens to (continuation OR pead-ready) and is_continuation is
// reported truthfully so the agent can act. See the 2026-05-29 spec.
func (s *DriftCandidatesService) SetContinuationEnabled(enabled bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.continuationEnabled = enabled
}

// continuationMode renders the flag as a log label.
func continuationMode(enabled bool) string {
	if enabled {
		return "enforce"
	}
	return "shadow"
}

// GetCandidates returns the cached candidates response, recomputing if the
// cache is stale (older than refreshInterval). Pass `now` for testability.
func (s *DriftCandidatesService) GetCandidates(ctx context.Context, now time.Time) *DriftCandidatesResponse {
	s.mu.RLock()
	if s.cached != nil && s.refreshInterval >= 0 && time.Since(s.cachedAt) < s.refreshInterval {
		out := s.cached
		s.mu.RUnlock()
		return out
	}
	s.mu.RUnlock()
	resp := s.compute(ctx, now)
	s.mu.Lock()
	s.cached = resp
	s.cachedAt = time.Now()
	s.mu.Unlock()
	return resp
}

// Refresh unconditionally recomputes the candidate scan and overwrites the
// cache, bypassing the TTL. The background cache warmer calls this so Drift's
// once-daily 17:00 ET beat reads a hot cache instead of triggering a cold
// full-universe scan that exceeds agent/preflight.js's 2s budget. Safe to
// call concurrently with GetCandidates reads.
func (s *DriftCandidatesService) Refresh(ctx context.Context) {
	resp := s.compute(ctx, time.Now())
	s.mu.Lock()
	s.cached = resp
	s.cachedAt = time.Now()
	s.mu.Unlock()
}

func (s *DriftCandidatesService) compute(ctx context.Context, now time.Time) *DriftCandidatesResponse {
	resp := &DriftCandidatesResponse{Candidates: []DriftSignal{}}
	if s.earnings == nil {
		resp.Errors = append(resp.Errors, "no earnings source configured")
		return resp
	}
	reports, err := s.earnings.FetchRecentReports(ctx, now, 5)
	if err != nil {
		resp.Errors = append(resp.Errors, fmt.Sprintf("FetchRecentReports: %s", err.Error()))
		return resp
	}

	s.mu.RLock()
	enforce := s.continuationEnabled
	s.mu.RUnlock()

	var latestAsOf string
	var inUniverse, fetchErrors, scoredOK, droppedGap, droppedMA, droppedGrade, droppedNotActionable, actionable int

	for _, r := range reports {
		if !s.universe[strings.ToUpper(r.Ticker)] {
			continue
		}
		inUniverse++
		sig, err := s.signalSvc.GetSignal(ctx, r.Ticker, r.Date.Format("2006-01-02"), r.Timing)
		if err != nil {
			if !errors.Is(err, ErrInsufficientDriftHistory) {
				fetchErrors++
				resp.Errors = append(resp.Errors, fmt.Sprintf("%s: %s", r.Ticker, err.Error()))
			}
			continue
		}
		if sig == nil {
			continue
		}
		scoredOK++

		// Base entry gates (always applied; mirror TRADING_RULES_DRIFT.md).
		if sig.Gap.GapPct < 3.0 {
			droppedGap++
			continue
		}
		if !sig.MA200.AboveMA || !sig.MA50.AboveMA {
			droppedMA++
			continue
		}
		if sig.Composite.Grade != "A" && sig.Composite.Grade != "B" {
			droppedGrade++
			continue
		}

		peadReady := sig.PEAD.Stage == "SIGNAL_READY" || sig.PEAD.Stage == "BREAKOUT"
		cont := sig.Continuation.IsContinuation

		// Shadow telemetry: log every would-be continuation entry regardless of
		// mode (out of the LLM payload). Fields suffice to reconstruct forward
		// outcomes offline.
		if cont {
			s.logger.WithFields(logrus.Fields{
				"ticker":          sig.Ticker,
				"earnings_date":   sig.EarningsDate,
				"timing":          sig.EarningsTiming,
				"last_close":      sig.LastClose,
				"gap_pct":         sig.Gap.GapPct,
				"extension_pct":   sig.Continuation.ExtensionPct,
				"days_after_gap":  sig.Continuation.DaysAfterGap,
				"composite_score": sig.Composite.CompositeScore,
				"grade":           sig.Composite.Grade,
				"pead_stage":      sig.PEAD.Stage,
				"mode":            continuationMode(enforce),
			}).Info("drift: would-be continuation entry")
		}

		if cont || peadReady {
			actionable++
		}

		if enforce {
			// ENFORCE: only actionable names surface; is_continuation stays truthful.
			if !cont && !peadReady {
				droppedNotActionable++
				continue
			}
		} else {
			// SHADOW: keep the base-gates-only filter (non-actionable in-window
			// names still surface, preserving near-miss visibility); zero the
			// field so the agent's "continuation OR pead-ready" rule cannot act.
			sig.Continuation.IsContinuation = false
		}

		if sig.AsOf > latestAsOf {
			latestAsOf = sig.AsOf
		}
		resp.Candidates = append(resp.Candidates, *sig)
	}

	sort.SliceStable(resp.Candidates, func(i, j int) bool {
		return resp.Candidates[i].Composite.CompositeScore > resp.Candidates[j].Composite.CompositeScore
	})
	resp.Count = len(resp.Candidates)
	resp.AsOf = latestAsOf

	// Per-scan coverage summary (out of the LLM payload). Distinguishes
	// "fix works, no setups yet" from "fix didn't land", and surfaces the
	// 429-starvation confound via fetch_errors / in_universe.
	s.logger.WithFields(logrus.Fields{
		"mode":                   continuationMode(enforce),
		"reports_in_window":      len(reports),
		"in_universe":            inUniverse,
		"scored_ok":              scoredOK,
		"dropped_gap":            droppedGap,
		"dropped_ma":             droppedMA,
		"dropped_grade":          droppedGrade,
		"dropped_not_actionable": droppedNotActionable,
		"fetch_errors":           fetchErrors,
		"actionable_count":       actionable,
		"candidate_count":        resp.Count,
	}).Info("drift: candidate scan summary")

	return resp
}

// Universe returns a defensive copy of the configured ticker set (sorted).
func (s *DriftCandidatesService) Universe() []string {
	out := make([]string, 0, len(s.universe))
	for t := range s.universe {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// GetSignalForTicker is the per-symbol lookup used by /api/v1/drift/signal.
func (s *DriftCandidatesService) GetSignalForTicker(ctx context.Context, symbol, earningsDate, timing string) (*DriftSignal, error) {
	return s.signalSvc.GetSignal(ctx, symbol, earningsDate, timing)
}
