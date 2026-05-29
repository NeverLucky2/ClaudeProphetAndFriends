package services

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// driftBarRow is a compact OHLCV tuple used by makeDriftBars.
type driftBarRow struct {
	Open, High, Low, Close float64
	Vol                    int
}

// makeDriftBars builds bars with explicit OHLCV from per-bar tuples. Index 0
// is the oldest bar (matches Alpaca convention used by the rest of services/).
func makeDriftBars(rows []driftBarRow) []*interfaces.Bar {
	start := time.Date(2026, 1, 5, 16, 0, 0, 0, time.UTC) // Mon
	bars := make([]*interfaces.Bar, len(rows))
	for i, r := range rows {
		bars[i] = &interfaces.Bar{
			Symbol:    "TEST",
			Timestamp: start.AddDate(0, 0, i),
			Open:      r.Open,
			High:      r.High,
			Low:       r.Low,
			Close:     r.Close,
			Volume:    int64(r.Vol),
		}
	}
	return bars
}

func TestDriftGapScore_BMO(t *testing.T) {
	// BMO: gap = open[earnings_date] / close[prev_day] - 1
	// Two bars: prev close = 100, earnings open = 107 → gap = 7% → score = 85
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 107, High: 110, Low: 106, Close: 109, Vol: 5000},
	})
	earningsDate := bars[1].Timestamp.Format("2006-01-02")
	got := computeDriftGap(bars, earningsDate, "bmo")
	if math.Abs(got.GapPct-7.0) > 1e-9 {
		t.Errorf("GapPct = %v, want 7.0", got.GapPct)
	}
	if got.Score != 85.0 {
		t.Errorf("Score = %v, want 85.0", got.Score)
	}
	if got.GapType != "up" {
		t.Errorf("GapType = %q, want up", got.GapType)
	}
}

func TestDriftGapScore_AMC(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},  // earnings day
		{Open: 105, High: 108, Low: 104, Close: 107, Vol: 5000}, // next day
	})
	earningsDate := bars[0].Timestamp.Format("2006-01-02")
	got := computeDriftGap(bars, earningsDate, "amc")
	if math.Abs(got.GapPct-5.0) > 1e-9 {
		t.Errorf("GapPct = %v, want 5.0", got.GapPct)
	}
	if got.Score != 70.0 {
		t.Errorf("Score = %v, want 70.0", got.Score)
	}
}

func TestDriftGapScore_EarningsDateNotInBars(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}})
	got := computeDriftGap(bars, "1999-01-01", "bmo")
	if got.Warning == "" {
		t.Error("expected warning on missing date")
	}
}

func TestDriftGapScore_GapDown(t *testing.T) {
	// BMO gap-down: close 100 → open 92 = -8% → abs 8% → score 85
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 92, High: 93, Low: 89, Close: 90, Vol: 5000},
	})
	earningsDate := bars[1].Timestamp.Format("2006-01-02")
	got := computeDriftGap(bars, earningsDate, "bmo")
	if got.GapType != "down" {
		t.Errorf("GapType = %q, want down", got.GapType)
	}
	if got.Score != 85.0 {
		t.Errorf("Score = %v, want 85.0 (|gap|=8%%)", got.Score)
	}
}

func TestDriftScoreTrend(t *testing.T) {
	cases := []struct {
		retPct float64
		want   float64
	}{
		{20.0, 100.0},
		{12.0, 85.0},
		{7.0, 70.0},
		{2.0, 50.0},
		{-3.0, 30.0},
		{-10.0, 15.0},
	}
	for _, c := range cases {
		if got := scoreTrend(c.retPct); got != c.want {
			t.Errorf("scoreTrend(%v) = %v, want %v", c.retPct, got, c.want)
		}
	}
}

func TestComputeDriftTrend_20DayReturn(t *testing.T) {
	// 25 bars. earningsIdx = 24, lookback = 4 (20 days back). close[4]=100, close[24]=110 → +10% → 85
	rows := make([]driftBarRow, 25)
	for i := range rows {
		rows[i] = driftBarRow{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}
	}
	rows[4].Close = 100
	rows[24].Close = 110
	rows[24].Open = 105
	rows[24].High = 111
	rows[24].Low = 104
	bars := makeDriftBars(rows)
	earningsDate := bars[24].Timestamp.Format("2006-01-02")
	got := computeDriftTrend(bars, earningsDate)
	if math.Abs(got.Return20dPct-10.0) > 1e-9 {
		t.Errorf("Return20dPct = %v, want 10.0", got.Return20dPct)
	}
	if got.Score != 85.0 {
		t.Errorf("Score = %v, want 85.0", got.Score)
	}
}

func TestComputeDriftVolRatio(t *testing.T) {
	// 60-day window OVERLAPS the 20-day window (both end at earningsIdx).
	// For ratio = 2.0: 20-day avg = 200k, 60-day avg = 100k.
	//   sum_60 = 60 * 100k = 6M
	//   sum_20 (subset) = 20 * 200k = 4M
	//   → prior 40 bars must sum to 2M → 50k each.
	rows := make([]driftBarRow, 80)
	for i := range rows {
		rows[i] = driftBarRow{Open: 100, High: 101, Low: 99, Close: 100, Vol: 50_000}
	}
	for i := 60; i < 80; i++ {
		rows[i].Vol = 200_000
	}
	bars := makeDriftBars(rows)
	earningsDate := bars[len(bars)-1].Timestamp.Format("2006-01-02")
	got := computeDriftVolRatio(bars, earningsDate)
	if math.Abs(got.VolRatio2060-2.0) > 1e-6 {
		t.Errorf("VolRatio2060 = %v, want 2.0", got.VolRatio2060)
	}
	if got.Score != 100.0 {
		t.Errorf("Score = %v, want 100.0", got.Score)
	}
}

func TestComputeDriftMA200_AboveMA(t *testing.T) {
	rows := make([]driftBarRow, 210)
	for i := range rows {
		rows[i] = driftBarRow{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}
	}
	// Push the last 10 bars way up so the trailing 200-window includes some high values
	// while the very last close is dramatically above the MA.
	for i := 200; i < 210; i++ {
		rows[i].Close = 130
	}
	bars := makeDriftBars(rows)
	got := computeDriftMA200(bars)
	if !got.AboveMA {
		t.Errorf("AboveMA = false, want true")
	}
	if got.Score < 70 {
		t.Errorf("Score = %v, want ≥70 (price far above MA200)", got.Score)
	}
}

func TestComputeDriftMA50_BelowMA(t *testing.T) {
	rows := make([]driftBarRow, 60)
	for i := range rows {
		rows[i] = driftBarRow{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}
	}
	rows[59].Close = 90 // last close ~10% below MA50
	bars := makeDriftBars(rows)
	got := computeDriftMA50(bars)
	if got.AboveMA {
		t.Errorf("AboveMA = true, want false")
	}
	if got.Score >= 35 {
		t.Errorf("Score = %v, want <35 (deeply below)", got.Score)
	}
}

func TestComputeDriftMA50_AboveMA(t *testing.T) {
	rows := make([]driftBarRow, 60)
	for i := range rows {
		rows[i] = driftBarRow{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}
	}
	rows[59].Close = 110 // last close 10% above
	bars := makeDriftBars(rows)
	got := computeDriftMA50(bars)
	if !got.AboveMA {
		t.Errorf("AboveMA = false, want true")
	}
}

func TestComputeDriftComposite_GradeA(t *testing.T) {
	got := computeDriftComposite(100, 100, 100, 100, 100)
	if got.CompositeScore < driftGradeAThreshold {
		t.Errorf("CompositeScore = %v, want ≥85", got.CompositeScore)
	}
	if got.Grade != "A" {
		t.Errorf("Grade = %q, want A", got.Grade)
	}
}

func TestComputeDriftComposite_GradeD(t *testing.T) {
	got := computeDriftComposite(15, 15, 20, 15, 15)
	if got.Grade != "D" {
		t.Errorf("Grade = %q, want D (score=%v)", got.Grade, got.CompositeScore)
	}
}

func TestComputeDriftComposite_WeightedSum(t *testing.T) {
	// 100*0.25 + 50*0.30 + 60*0.20 + 70*0.15 + 80*0.10 = 25+15+12+10.5+8 = 70.5 → grade B
	got := computeDriftComposite(100, 50, 60, 70, 80)
	want := 70.5
	if math.Abs(got.CompositeScore-want) > 1e-6 {
		t.Errorf("CompositeScore = %v, want %v", got.CompositeScore, want)
	}
	if got.Grade != "B" {
		t.Errorf("Grade = %q, want B", got.Grade)
	}
}

func TestComputeDriftComposite_BoundaryAt70(t *testing.T) {
	// Score == 70 exactly should be grade B (inclusive lower bound)
	// 70 * (0.25+0.30+0.20+0.15+0.10) = 70.
	got := computeDriftComposite(70, 70, 70, 70, 70)
	if got.Grade != "B" {
		t.Errorf("Grade = %q (score %v), want B at exact 70 boundary", got.Grade, got.CompositeScore)
	}
}

func TestDailyToWeekly_BasicAggregation(t *testing.T) {
	// 5 trading days Mon-Fri of one ISO week.
	rows := []driftBarRow{
		{Open: 100, High: 105, Low: 99, Close: 102, Vol: 1000},  // Mon
		{Open: 102, High: 108, Low: 101, Close: 106, Vol: 1100}, // Tue
		{Open: 106, High: 110, Low: 104, Close: 109, Vol: 1200}, // Wed
		{Open: 109, High: 112, Low: 107, Close: 111, Vol: 1300}, // Thu
		{Open: 111, High: 115, Low: 110, Close: 114, Vol: 1400}, // Fri
	}
	bars := makeDriftBars(rows) // starts Mon 2026-01-05
	weeks := dailyToWeekly(bars)
	if len(weeks) != 1 {
		t.Fatalf("expected 1 weekly candle, got %d: %+v", len(weeks), weeks)
	}
	w := weeks[0]
	if w.Open != 100 || w.Close != 114 || w.High != 115 || w.Low != 99 {
		t.Errorf("week OHLC mismatch: %+v", w)
	}
	if !w.IsGreen {
		t.Errorf("week is_green = false, want true (close > open)")
	}
	if w.Volume != 1000+1100+1200+1300+1400 {
		t.Errorf("week volume = %d, want 6000", w.Volume)
	}
}

func TestDailyToWeekly_TwoWeeks(t *testing.T) {
	// 10 trading days = 2 full weeks. First week green (100→110), second week red (111→105).
	rows := make([]driftBarRow, 10)
	for i := 0; i < 5; i++ {
		rows[i] = driftBarRow{Open: 100, High: 111, Low: 99, Close: 100 + float64(i+1)*2, Vol: 1000}
	}
	rows[0].Open = 100
	for i := 5; i < 10; i++ {
		rows[i] = driftBarRow{Open: 111, High: 112, Low: 105, Close: 111 - float64(i-4), Vol: 2000}
	}
	bars := makeDriftBars(rows)
	weeks := dailyToWeekly(bars)
	if len(weeks) != 2 {
		t.Fatalf("expected 2 weekly candles, got %d", len(weeks))
	}
	if !weeks[0].IsGreen || weeks[1].IsGreen {
		t.Errorf("week colors wrong: w0.green=%v w1.green=%v", weeks[0].IsGreen, weeks[1].IsGreen)
	}
}

func TestFindEarningsWeekIdx_MatchesISOWeek(t *testing.T) {
	rows := make([]driftBarRow, 15)
	for i := range rows {
		rows[i] = driftBarRow{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}
	}
	bars := makeDriftBars(rows) // starts Mon 2026-01-05
	weeks := dailyToWeekly(bars)
	// 2026-01-05 is in ISO week 2 of 2026; we expect weeks[0] to be that week.
	target := bars[2].Timestamp.Format("2006-01-02") // Wed of same week
	idx := findEarningsWeekIdx(weeks, target)
	if idx != 0 {
		t.Errorf("findEarningsWeekIdx = %d, want 0", idx)
	}
}

// makeMonFriBars builds bars only on Mon-Fri, starting from a fixed Monday.
// This is used by the PEAD tests because dailyToWeekly groups by ISO week
// and weekend bars would otherwise span 0 or odd weeks.
func makeMonFriBars(rows []driftBarRow) []*interfaces.Bar {
	start := time.Date(2026, 1, 5, 16, 0, 0, 0, time.UTC) // Mon
	bars := make([]*interfaces.Bar, 0, len(rows))
	day := start
	added := 0
	for added < len(rows) {
		wd := day.Weekday()
		if wd == time.Saturday || wd == time.Sunday {
			day = day.AddDate(0, 0, 1)
			continue
		}
		r := rows[added]
		bars = append(bars, &interfaces.Bar{
			Symbol:    "TEST",
			Timestamp: day,
			Open:      r.Open,
			High:      r.High,
			Low:       r.Low,
			Close:     r.Close,
			Volume:    int64(r.Vol),
		})
		added++
		day = day.AddDate(0, 0, 1)
	}
	return bars
}

func TestAnalyzeDriftPEAD_Monitoring(t *testing.T) {
	// 4 weeks of trading days, all green. Earnings in week 0 → no red after → MONITORING.
	rows := make([]driftBarRow, 20)
	for i := range rows {
		c := 100.0 + float64(i)*0.5
		rows[i] = driftBarRow{Open: c - 0.3, High: c + 0.2, Low: c - 0.4, Close: c, Vol: 1000}
	}
	bars := makeMonFriBars(rows)
	weeks := dailyToWeekly(bars)
	if len(weeks) != 4 {
		t.Fatalf("setup failure: expected 4 weeks, got %d", len(weeks))
	}
	got := analyzeDriftPEAD(weeks, bars[0].Timestamp.Format("2006-01-02"), driftPEADWatchWeeks)
	if got.Stage != "MONITORING" {
		t.Errorf("Stage = %q, want MONITORING (no red candle yet)", got.Stage)
	}
	if got.IsBreakout {
		t.Errorf("IsBreakout = true, want false")
	}
}

func TestAnalyzeDriftPEAD_Breakout(t *testing.T) {
	// 4 weeks of trading days: week 0 (earnings, green), week 1 (red),
	// week 2 (red, narrower so we know the red detector picks the closest red),
	// week 3 (green, close > week-2 high). Note: findDriftRedCandle skips the
	// most recent week (week 3) and looks for the highest-index red, which is
	// week 2. Breakout test: current.Close > red(week2).High.
	rows := []driftBarRow{}
	// Week 0: Mon 2026-01-05 — green
	for i := 0; i < 5; i++ {
		rows = append(rows, driftBarRow{Open: 100, High: 105, Low: 99, Close: 100 + float64(i), Vol: 1000})
	}
	// Week 1: red, open 108 close 100
	for i := 0; i < 5; i++ {
		rows = append(rows, driftBarRow{Open: 108, High: 110, Low: 99, Close: 108 - float64(i+1), Vol: 1000})
	}
	// Week 2: red, narrow, open 102 close 98. High = 103.
	for i := 0; i < 5; i++ {
		rows = append(rows, driftBarRow{Open: 102, High: 103, Low: 97, Close: 102 - float64(i+1), Vol: 1000})
	}
	// Week 3: green, closes well above week-2 high (103). Final close 115.
	for i := 0; i < 5; i++ {
		rows = append(rows, driftBarRow{Open: 100, High: 120, Low: 99, Close: 100 + float64(i+1)*3, Vol: 1000})
	}
	bars := makeMonFriBars(rows)
	weeks := dailyToWeekly(bars)
	if len(weeks) != 4 {
		t.Fatalf("setup failure: expected 4 weeks, got %d (weeks=%+v)", len(weeks), weeks)
	}
	got := analyzeDriftPEAD(weeks, bars[0].Timestamp.Format("2006-01-02"), driftPEADWatchWeeks)
	if got.Stage != "BREAKOUT" {
		t.Errorf("Stage = %q, want BREAKOUT (weeks=%+v, red=%+v)", got.Stage, weeks, got.RedCandle)
	}
	if !got.IsBreakout {
		t.Errorf("IsBreakout = false, want true")
	}
	if got.RedCandle == nil {
		t.Fatal("expected RedCandle to be populated")
	}
}

func TestAnalyzeDriftPEAD_Expired(t *testing.T) {
	// 7 weeks of trading days, earnings in week 0 → weeks_since_earnings = 6 > 5.
	rows := make([]driftBarRow, 35)
	for i := range rows {
		c := 100.0 + float64(i)*0.5
		rows[i] = driftBarRow{Open: c - 0.3, High: c + 0.2, Low: c - 0.4, Close: c, Vol: 1000}
	}
	bars := makeMonFriBars(rows)
	weeks := dailyToWeekly(bars)
	if len(weeks) < 7 {
		t.Fatalf("setup failure: need ≥7 weeks, got %d", len(weeks))
	}
	got := analyzeDriftPEAD(weeks, bars[0].Timestamp.Format("2006-01-02"), driftPEADWatchWeeks)
	if got.Stage != "EXPIRED" {
		t.Errorf("Stage = %q, want EXPIRED (weeks_since_earnings=%d)", got.Stage, got.WeeksSinceEarnings)
	}
}

// stubDriftBarFetcherSvc is a per-symbol map BarFetcher for service-level tests.
// (Controller tests have their own copy in controllers/_test.go.)
type stubDriftBarFetcherSvc struct {
	bars map[string][]*interfaces.Bar
}

func (f *stubDriftBarFetcherSvc) GetHistoricalBars(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, error) {
	if b, ok := f.bars[symbol]; ok {
		return b, nil
	}
	return nil, nil
}

func TestDriftSignalService_ComputeSignal_FullPipeline(t *testing.T) {
	// Build a 220-Mon-Fri bar series:
	//   - bars[0..199] flat at 100
	//   - bars[200..214] rising 0.4/day pre-earnings (15-day climb = +6%)
	//   - bars[215] = earnings day with BMO gap +6%
	//   - bars[216..219] continue green
	rows := make([]driftBarRow, 220)
	for i := 0; i < 200; i++ {
		rows[i] = driftBarRow{Open: 100, High: 100.5, Low: 99.5, Close: 100, Vol: 100_000}
	}
	for i := 200; i < 215; i++ {
		c := 100 + 0.4*float64(i-199)
		rows[i] = driftBarRow{Open: c - 0.2, High: c + 0.2, Low: c - 0.3, Close: c, Vol: 100_000}
	}
	// earnings day: open gaps 6% above prior close
	earningsIdx := 215
	prevClose := rows[earningsIdx-1].Close
	rows[earningsIdx] = driftBarRow{
		Open: prevClose * 1.06, High: prevClose*1.06 + 1, Low: prevClose * 1.05, Close: prevClose*1.06 + 0.5,
		Vol: 200_000,
	}
	for i := earningsIdx + 1; i < 220; i++ {
		c := rows[i-1].Close + 0.3
		rows[i] = driftBarRow{Open: c - 0.1, High: c + 0.5, Low: c - 0.2, Close: c, Vol: 200_000}
	}
	bars := makeMonFriBars(rows)
	svc := NewDriftSignalService(&stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{"TEST": bars}})
	earningsDate := bars[earningsIdx].Timestamp.Format("2006-01-02")
	sig, err := svc.GetSignal(context.Background(), "TEST", earningsDate, "bmo")
	if err != nil {
		t.Fatalf("GetSignal err = %v", err)
	}
	if sig == nil {
		t.Fatal("expected signal, got nil")
	}
	if sig.Gap.Score < 70 {
		t.Errorf("gap score = %v, want ≥70 (constructed 6%% gap)", sig.Gap.Score)
	}
	if sig.Composite.Grade == "D" {
		t.Errorf("expected grade ≥ C, got D (composite=%v)", sig.Composite.CompositeScore)
	}
	if sig.SignalVersion != driftSignalVersion {
		t.Errorf("SignalVersion = %q, want %q", sig.SignalVersion, driftSignalVersion)
	}
	if !sig.MA200.AboveMA || !sig.MA50.AboveMA {
		t.Errorf("MA flags: above_ma_200=%v above_ma_50=%v; want both true", sig.MA200.AboveMA, sig.MA50.AboveMA)
	}
}

func TestDriftSignalService_InsufficientHistory(t *testing.T) {
	bars := make([]*interfaces.Bar, 50)
	for i := range bars {
		bars[i] = &interfaces.Bar{Close: 100, Volume: 1000}
	}
	svc := NewDriftSignalService(&stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{"TEST": bars}})
	_, err := svc.GetSignal(context.Background(), "TEST", "2026-05-15", "amc")
	if !errors.Is(err, ErrInsufficientDriftHistory) {
		t.Fatalf("err = %v, want ErrInsufficientDriftHistory", err)
	}
}

// stubRecentReporterFetcher returns a canned RecentReport list.
type stubRecentReporterFetcher struct {
	reports []RecentReport
	err     error
}

func (s *stubRecentReporterFetcher) FetchRecentReports(ctx context.Context, now time.Time, days int) ([]RecentReport, error) {
	return s.reports, s.err
}

// buildGradeABars returns a 220-Mon-Fri-bar series that produces grade-A signal
// for the ticker. Earnings at bars[L-5].
func buildGradeABars(ticker string) []*interfaces.Bar {
	rows := make([]driftBarRow, 220)
	for i := 0; i < 200; i++ {
		rows[i] = driftBarRow{Open: 100, High: 100.5, Low: 99.5, Close: 100, Vol: 100_000}
	}
	for i := 200; i < 215; i++ {
		c := 100 + 0.4*float64(i-199)
		rows[i] = driftBarRow{Open: c - 0.2, High: c + 0.2, Low: c - 0.3, Close: c, Vol: 100_000}
	}
	earningsIdx := 215
	prevClose := rows[earningsIdx-1].Close
	rows[earningsIdx] = driftBarRow{
		Open: prevClose * 1.06, High: prevClose*1.06 + 1, Low: prevClose * 1.05, Close: prevClose*1.06 + 0.5,
		Vol: 200_000,
	}
	for i := earningsIdx + 1; i < 220; i++ {
		c := rows[i-1].Close + 0.3
		rows[i] = driftBarRow{Open: c - 0.1, High: c + 0.5, Low: c - 0.2, Close: c, Vol: 200_000}
	}
	bars := makeMonFriBars(rows)
	for _, b := range bars {
		b.Symbol = ticker
	}
	return bars
}

// earningsDateForGradeABars returns the earnings-day date string for the bars
// produced by buildGradeABars (earnings at index L-5).
func earningsDateForGradeABars(bars []*interfaces.Bar) string {
	return bars[len(bars)-5].Timestamp.Format("2006-01-02")
}

func TestDriftCandidatesService_FiltersByUniverse(t *testing.T) {
	aaplBars := buildGradeABars("AAPL")
	outsideBars := buildGradeABars("ZZZ")
	stubBars := map[string][]*interfaces.Bar{
		"AAPL": aaplBars,
		"ZZZ":  outsideBars,
	}
	reports := []RecentReport{
		{Ticker: "AAPL", Date: aaplBars[len(aaplBars)-5].Timestamp, Timing: "bmo"},
		{Ticker: "ZZZ", Date: outsideBars[len(outsideBars)-5].Timestamp, Timing: "bmo"},
	}
	universe := []string{"AAPL"}
	sigSvc := NewDriftSignalService(&stubDriftBarFetcherSvc{bars: stubBars})
	cs := NewDriftCandidatesService(sigSvc, &stubRecentReporterFetcher{reports: reports}, universe)
	cs.SetRefreshInterval(-1)

	resp := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 0, 0, 0, time.UTC))
	if resp.Count != 1 {
		t.Fatalf("expected 1 candidate (AAPL only), got %d: %+v", resp.Count, resp.Candidates)
	}
	if resp.Candidates[0].Ticker != "AAPL" {
		t.Errorf("expected AAPL, got %s", resp.Candidates[0].Ticker)
	}
}

func TestDriftCandidatesService_SortsByCompositeDesc(t *testing.T) {
	aaa := buildGradeABars("AAA")
	bbb := buildGradeABars("BBB")
	// Crush BBB's MA200 score by pushing the bulk of bars 0..200 way up so MA200
	// ends well above current price → MA200 score = 15 → composite drops.
	for i := 0; i < 200; i++ {
		bbb[i].Close = 300
	}
	stubBars := map[string][]*interfaces.Bar{"AAA": aaa, "BBB": bbb}
	reports := []RecentReport{
		{Ticker: "AAA", Date: aaa[len(aaa)-5].Timestamp, Timing: "bmo"},
		{Ticker: "BBB", Date: bbb[len(bbb)-5].Timestamp, Timing: "bmo"},
	}
	cs := NewDriftCandidatesService(
		NewDriftSignalService(&stubDriftBarFetcherSvc{bars: stubBars}),
		&stubRecentReporterFetcher{reports: reports},
		[]string{"AAA", "BBB"},
	)
	cs.SetRefreshInterval(-1)
	resp := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 0, 0, 0, time.UTC))
	if len(resp.Candidates) < 1 {
		t.Fatalf("expected ≥1 candidate, got %d", len(resp.Candidates))
	}
	// If both pass filters, AAA must come first; if BBB is filtered out, AAA alone is fine.
	if resp.Candidates[0].Ticker != "AAA" {
		t.Errorf("first candidate = %s, want AAA (lower MA200 score on BBB should rank it lower)", resp.Candidates[0].Ticker)
	}
	if len(resp.Candidates) >= 2 {
		if resp.Candidates[0].Composite.CompositeScore < resp.Candidates[1].Composite.CompositeScore {
			t.Errorf("not sorted desc: %v then %v",
				resp.Candidates[0].Composite.CompositeScore,
				resp.Candidates[1].Composite.CompositeScore)
		}
	}
}

func TestDriftCandidatesService_DropsLowGap(t *testing.T) {
	// Build a series where the earnings-day gap is only 1% → score 35 → grade D.
	rows := make([]driftBarRow, 220)
	for i := 0; i < 220; i++ {
		c := 100.0 + 0.05*float64(i)
		rows[i] = driftBarRow{Open: c - 0.05, High: c + 0.05, Low: c - 0.1, Close: c, Vol: 100_000}
	}
	earningsIdx := 215
	prevClose := rows[earningsIdx-1].Close
	rows[earningsIdx].Open = prevClose * 1.01 // 1% gap — too small
	bars := makeMonFriBars(rows)
	cs := NewDriftCandidatesService(
		NewDriftSignalService(&stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{"LOW": bars}}),
		&stubRecentReporterFetcher{reports: []RecentReport{
			{Ticker: "LOW", Date: bars[earningsIdx].Timestamp, Timing: "bmo"},
		}},
		[]string{"LOW"},
	)
	cs.SetRefreshInterval(-1)
	resp := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 0, 0, 0, time.UTC))
	if resp.Count != 0 {
		t.Errorf("expected 0 candidates (gap < 3%%), got %d: first=%+v", resp.Count, resp.Candidates)
	}
}

func TestDriftCandidatesService_PropagatesFetchErrors(t *testing.T) {
	cs := NewDriftCandidatesService(
		NewDriftSignalService(&stubDriftBarFetcherSvc{}),
		&stubRecentReporterFetcher{err: errors.New("fmp down")},
		[]string{"AAPL"},
	)
	cs.SetRefreshInterval(-1)
	resp := cs.GetCandidates(context.Background(), time.Now())
	if len(resp.Errors) == 0 {
		t.Errorf("expected error surfaced in response.Errors; got Errors=[]")
	}
}

func TestDriftCandidatesService_CachingHonored(t *testing.T) {
	stub := &stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{
		"AAA": buildGradeABars("AAA"),
	}}
	reports := []RecentReport{
		{Ticker: "AAA", Date: stub.bars["AAA"][len(stub.bars["AAA"])-5].Timestamp, Timing: "bmo"},
	}
	cs := NewDriftCandidatesService(
		NewDriftSignalService(stub),
		&stubRecentReporterFetcher{reports: reports},
		[]string{"AAA"},
	)
	cs.SetRefreshInterval(10 * time.Minute)
	first := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 0, 0, 0, time.UTC))
	if first.Count != 1 {
		t.Fatalf("first: expected 1 candidate, got %d", first.Count)
	}
	delete(stub.bars, "AAA")
	second := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 1, 0, 0, time.UTC))
	if second.Count != 1 {
		t.Fatalf("cached call should still return 1 candidate; got %d", second.Count)
	}
	cs.SetRefreshInterval(-1)
	third := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 2, 0, 0, time.UTC))
	if third.Count != 0 {
		t.Fatalf("after cache disabled, expected 0 candidates; got %d", third.Count)
	}
}

func TestDriftCandidatesService_RefreshBypassesTTL(t *testing.T) {
	// Refresh must recompute and overwrite the cache even within the TTL, so the
	// background warmer keeps Drift's once-daily 17:00 ET beat reading a hot
	// cache instead of triggering a cold scan that exceeds the 2s preflight
	// budget. Detection mirrors TestDriftCandidatesService_CachingHonored.
	stub := &stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar{
		"AAA": buildGradeABars("AAA"),
	}}
	reports := []RecentReport{
		{Ticker: "AAA", Date: stub.bars["AAA"][len(stub.bars["AAA"])-5].Timestamp, Timing: "bmo"},
	}
	cs := NewDriftCandidatesService(
		NewDriftSignalService(stub),
		&stubRecentReporterFetcher{reports: reports},
		[]string{"AAA"},
	)
	cs.SetRefreshInterval(10 * time.Minute) // caching ON, long TTL

	if first := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 0, 0, 0, time.UTC)); first.Count != 1 {
		t.Fatalf("first: expected 1 candidate, got %d", first.Count)
	}

	// Wipe AAA. A within-TTL read still serves the cached (stale) result.
	delete(stub.bars, "AAA")
	if cached := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 1, 0, 0, time.UTC)); cached.Count != 1 {
		t.Fatalf("within-TTL read should be cached; got %d", cached.Count)
	}

	// Refresh bypasses the TTL and recomputes against the mutated fetcher.
	cs.Refresh(context.Background())

	if after := cs.GetCandidates(context.Background(), time.Date(2026, 5, 19, 17, 2, 0, 0, time.UTC)); after.Count != 0 {
		t.Fatalf("Refresh should have recomputed an empty result into cache; got %d", after.Count)
	}
}

func TestComputeDriftContinuation_BMO_DayAfterHigherHigh(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 104, High: 106, Low: 103, Close: 105, Vol: 5000}, // earnings (gap bar)
		{Open: 106, High: 108, Low: 105, Close: 107, Vol: 4000}, // day-after
	})
	earningsDate := bars[1].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "bmo")
	if !got.IsContinuation {
		t.Errorf("IsContinuation = false, want true (%+v)", got)
	}
	if got.DaysAfterGap != 1 {
		t.Errorf("DaysAfterGap = %d, want 1", got.DaysAfterGap)
	}
	if got.GapBarHigh != 106 {
		t.Errorf("GapBarHigh = %v, want 106", got.GapBarHigh)
	}
	if got.ExtensionPct <= 0 {
		t.Errorf("ExtensionPct = %v, want > 0", got.ExtensionPct)
	}
	if got.GapBarHigh != got.PriorHigh {
		t.Errorf("day-1 identity broken: GapBarHigh=%v PriorHigh=%v (must be equal when DaysAfterGap==1)", got.GapBarHigh, got.PriorHigh)
	}
}

func TestComputeDriftContinuation_AMC_DayAfterHigherHigh(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},  // earnings date
		{Open: 103, High: 107, Low: 102, Close: 106, Vol: 5000}, // gap bar (next day)
		{Open: 106, High: 109, Low: 105, Close: 108, Vol: 4000}, // latest
	})
	earningsDate := bars[0].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "amc")
	if !got.IsContinuation {
		t.Errorf("IsContinuation = false, want true (%+v)", got)
	}
	if got.GapBarHigh != 107 {
		t.Errorf("GapBarHigh = %v, want 107 (AMC gap bar = earningsIdx+1)", got.GapBarHigh)
	}
	if got.DaysAfterGap != 1 {
		t.Errorf("DaysAfterGap = %d, want 1", got.DaysAfterGap)
	}
}

func TestComputeDriftContinuation_GapIsLatestBar_False(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 104, High: 106, Low: 103, Close: 105, Vol: 5000}, // earnings = latest
	})
	earningsDate := bars[1].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "bmo")
	if got.IsContinuation {
		t.Errorf("IsContinuation = true, want false (DaysAfterGap=%d)", got.DaysAfterGap)
	}
	if got.DaysAfterGap != 0 {
		t.Errorf("DaysAfterGap = %d, want 0", got.DaysAfterGap)
	}
}

func TestComputeDriftContinuation_StalledBelowPriorHigh_False(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 104, High: 106, Low: 103, Close: 105, Vol: 5000}, // earnings (gap bar, high 106)
		{Open: 106, High: 110, Low: 105, Close: 109, Vol: 4000}, // day-after, high 110
		{Open: 108, High: 109, Low: 107, Close: 107, Vol: 3000}, // latest: close 107 > 106 but < priorHigh 110
	})
	earningsDate := bars[1].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "bmo")
	if got.IsContinuation {
		t.Errorf("IsContinuation = true, want false (close %v <= priorHigh %v)", got.LatestClose, got.PriorHigh)
	}
	if got.DaysAfterGap != 2 {
		t.Errorf("DaysAfterGap = %d, want 2", got.DaysAfterGap)
	}
}

func TestComputeDriftContinuation_EarningsNotInBars(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}})
	got := computeDriftContinuation(bars, "1999-01-01", "bmo")
	if got.IsContinuation || got.Warning == "" {
		t.Errorf("want IsContinuation=false with warning; got %+v", got)
	}
}

func TestComputeDriftContinuation_AMC_NoGapBarYet(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000}})
	earningsDate := bars[0].Timestamp.UTC().Format("2006-01-02")
	got := computeDriftContinuation(bars, earningsDate, "amc")
	if got.IsContinuation || got.Warning == "" {
		t.Errorf("want IsContinuation=false with warning; got %+v", got)
	}
}

func TestComputeDriftSignal_PopulatesContinuation(t *testing.T) {
	bars := makeDriftBars([]driftBarRow{
		{Open: 100, High: 101, Low: 99, Close: 100, Vol: 1000},
		{Open: 104, High: 106, Low: 103, Close: 105, Vol: 5000}, // earnings
		{Open: 106, High: 108, Low: 105, Close: 107, Vol: 4000},
	})
	earningsDate := bars[1].Timestamp.UTC().Format("2006-01-02")
	sig := ComputeDriftSignal("TEST", bars, earningsDate, "bmo")
	if !sig.Continuation.IsContinuation {
		t.Errorf("signal.Continuation.IsContinuation = false, want true (%+v)", sig.Continuation)
	}
}
