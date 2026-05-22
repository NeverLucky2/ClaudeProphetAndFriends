package services

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"

	"prophet-trader/interfaces"
)

// IntradaySignalService computes the per-symbol intraday context blob
// injected into Prophet's market-hours beats. Cold symbols are resolved in two
// batched multi-symbol fetches (one 5Min, one 1Day) rather than per-symbol
// round trips, and the whole fetch is deadline-bounded so a slow or throttling
// upstream yields partial data instead of stalling the beat. Snapshots are
// cached 60s; sector ETF readings 6h.

const (
	intradayCacheTTL = 60 * time.Second
	sectorCacheTTL   = 6 * time.Hour
	intradayBarsTF   = "5Min"
	dailyBarsTF      = "1Day"
	atrLookback      = 20 // 20 trading days

	// defaultIntradayDeadline bounds the wall-clock spent waiting on upstream
	// bar fetches. Prophet's harness aborts the HTTP request at 3000ms and
	// drops the whole block; returning partial data just under that keeps the
	// endpoint responsive even when Alpaca is slow or throttling.
	defaultIntradayDeadline = 2500 * time.Millisecond
)

// sectorETFMap maps a symbol to its primary sector ETF for context.
// SPY/QQQ have no sector — they are the broad references themselves.
var sectorETFMap = map[string]string{
	"NVDA": "SMH",
	"AMD":  "SMH",
	"TSLA": "XLY",
	"MSTR": "XLK",
}

// intradayDataSource is the narrow subset of interfaces.DataService used by
// IntradaySignalService — a single batched multi-symbol bar fetch. Keeping the
// interface small lets tests stub it without implementing the full
// DataService surface.
type intradayDataSource interface {
	GetMultiBars(ctx context.Context, symbols []string, start, end time.Time, timeframe string) (map[string][]*interfaces.Bar, error)
}

// IntradaySignal is one symbol's snapshot.
type IntradaySignal struct {
	Symbol          string  `json:"symbol"`
	Price           float64 `json:"price"`
	DayChangePct    float64 `json:"day_change_pct"`
	VWAP            float64 `json:"vwap"`
	DistFromVWAPPct float64 `json:"dist_from_vwap_pct"`
	RVOL            float64 `json:"rvol"`
	SessionHigh     float64 `json:"session_high"`
	SessionLow      float64 `json:"session_low"`
	RangeOverATR    float64 `json:"range_over_atr"`
	SectorETF       string  `json:"sector_etf,omitempty"`
	SectorChangePct float64 `json:"sector_change_pct,omitempty"`
	Note            string  `json:"note,omitempty"`
}

// IntradaySignalSet is the full response.
type IntradaySignalSet struct {
	GeneratedAt time.Time        `json:"generated_at"`
	Signals     []IntradaySignal `json:"signals"`
	Errors      []string         `json:"errors,omitempty"`
}

type cachedSymbol struct {
	signal   IntradaySignal
	cachedAt time.Time
}

type cachedSector struct {
	pctChange float64
	cachedAt  time.Time
}

// IntradaySignalService caches per-symbol snapshots and sector ETF readings.
type IntradaySignalService struct {
	data intradayDataSource

	// deadline bounds the wall-clock GetSignals waits on upstream fetches
	// before returning whatever it has. Defaults to defaultIntradayDeadline;
	// overridable in tests.
	deadline time.Duration

	mu          sync.RWMutex
	symbolCache map[string]cachedSymbol
	sectorCache map[string]cachedSector
}

// NewIntradaySignalService constructs a service over the given data source.
// In production the source is *AlpacaDataService (which satisfies the
// intradayDataSource interface via GetMultiBars).
func NewIntradaySignalService(data intradayDataSource) *IntradaySignalService {
	return &IntradaySignalService{
		data:        data,
		deadline:    defaultIntradayDeadline,
		symbolCache: make(map[string]cachedSymbol),
		sectorCache: make(map[string]cachedSector),
	}
}

// GetSignals returns a snapshot for each requested symbol, in request order.
// Never returns nil. Symbols still fresh in cache are served without a fetch;
// the rest are resolved in two batched calls (one 5Min, one 1Day covering both
// the underlyings and any sector ETFs they need). The whole fetch is bounded
// by s.deadline — if upstream stalls or fails, partial/cached data is returned
// and the shortfall is recorded in Errors rather than blocking the caller.
func (s *IntradaySignalService) GetSignals(ctx context.Context, symbols []string, now time.Time) *IntradaySignalSet {
	set := &IntradaySignalSet{
		GeneratedAt: now.UTC(),
		Signals:     make([]IntradaySignal, 0, len(symbols)),
	}

	// Partition into cache-warm (served directly) and cold (need a fetch).
	computed := make(map[string]IntradaySignal, len(symbols))
	cold := make([]string, 0, len(symbols))
	s.mu.RLock()
	for _, sym := range symbols {
		if c, ok := s.symbolCache[sym]; ok && now.Sub(c.cachedAt) < intradayCacheTTL {
			computed[sym] = c.signal
		} else {
			cold = append(cold, sym)
		}
	}
	s.mu.RUnlock()

	if len(cold) > 0 {
		fresh, errs := s.fetchAndCompute(ctx, cold, now)
		for sym, sig := range fresh {
			computed[sym] = sig
		}
		set.Errors = append(set.Errors, errs...)
		// Cold symbols with no data returned (deadline or a failed call) still
		// get a row so the renderer shows the symbol was attempted.
		for _, sym := range cold {
			if _, ok := computed[sym]; !ok {
				computed[sym] = IntradaySignal{Symbol: sym, Note: "no data"}
			}
		}
	}

	// Assemble in request order for a deterministic layout.
	for _, sym := range symbols {
		if sig, ok := computed[sym]; ok {
			set.Signals = append(set.Signals, sig)
		}
	}
	return set
}

// fetchAndCompute batch-fetches bars for the cold symbols and computes their
// signals. Returns the freshly computed signals keyed by symbol plus any
// soft-fail notices. Complete snapshots (both timeframes present) are cached.
func (s *IntradaySignalService) fetchAndCompute(ctx context.Context, cold []string, now time.Time) (map[string]IntradaySignal, []string) {
	// Which sector ETFs need a daily fetch (cold in the 6h sector cache)?
	sectorFor := make(map[string]string, len(cold)) // symbol → its ETF
	needSector := make(map[string]bool)             // ETF → fetch needed
	s.mu.RLock()
	for _, sym := range cold {
		if etf := sectorETFMap[sym]; etf != "" {
			sectorFor[sym] = etf
			if c, ok := s.sectorCache[etf]; !ok || now.Sub(c.cachedAt) >= sectorCacheTTL {
				needSector[etf] = true
			}
		}
	}
	s.mu.RUnlock()

	// Sector ETFs ride along in the daily batch — no separate call.
	dailySyms := append([]string(nil), cold...)
	for etf := range needSector {
		dailySyms = append(dailySyms, etf)
	}

	sessionStart := startOfSessionUTC(now)
	dailyStart := now.AddDate(0, 0, -45) // calendar days, comfortably > 21 trading days

	intradayMap, dailyMap, errs := s.fetchBars(ctx, cold, dailySyms, sessionStart, dailyStart, now)

	// Refresh the sector cache from whatever daily bars arrived.
	if dailyMap != nil {
		s.mu.Lock()
		for etf := range needSector {
			if bars := dailyMap[etf]; len(bars) >= 2 {
				latest := bars[len(bars)-1]
				prior := bars[len(bars)-2]
				s.sectorCache[etf] = cachedSector{pctChange: calcDayChangePct(latest.Close, prior.Close), cachedAt: now}
			}
		}
		s.mu.Unlock()
	}

	fresh := make(map[string]IntradaySignal, len(cold))
	for _, sym := range cold {
		// No intraday data at all (failed/deadline) → leave for the caller to
		// mark "no data". An empty entry that came back on a successful call is
		// a legitimate "no bars yet" and is handled inside computeSignal.
		if intradayMap == nil {
			continue
		}

		var sectorPct float64
		var sectorOK bool
		if etf := sectorFor[sym]; etf != "" {
			s.mu.RLock()
			if c, ok := s.sectorCache[etf]; ok {
				sectorPct, sectorOK = c.pctChange, true
			}
			s.mu.RUnlock()
		}

		sig := computeSignal(sym, intradayMap[sym], dailyMap[sym], sectorFor[sym], sectorPct, sectorOK, now)
		fresh[sym] = sig

		// Cache only complete snapshots (both timeframes present) so a
		// deadline-truncated partial is retried on the next beat.
		if dailyMap != nil {
			s.mu.Lock()
			s.symbolCache[sym] = cachedSymbol{signal: sig, cachedAt: now}
			s.mu.Unlock()
		}
	}
	return fresh, errs
}

// fetchBars issues the two batched bar requests concurrently and waits up to
// s.deadline. A timeframe whose call fails or does not arrive in time yields a
// nil map plus a notice; the other timeframe is still returned. Goroutines
// abandoned at the deadline send to buffered channels (no leak); the bounded
// Alpaca client (boundedAlpacaClientOpts) caps how long they linger.
func (s *IntradaySignalService) fetchBars(ctx context.Context, intradaySyms, dailySyms []string, sessionStart, dailyStart, now time.Time) (map[string][]*interfaces.Bar, map[string][]*interfaces.Bar, []string) {
	type result struct {
		m   map[string][]*interfaces.Bar
		err error
	}
	intradayCh := make(chan result, 1)
	dailyCh := make(chan result, 1)

	go func() {
		m, err := s.data.GetMultiBars(ctx, intradaySyms, sessionStart, now, intradayBarsTF)
		intradayCh <- result{m, err}
	}()
	go func() {
		m, err := s.data.GetMultiBars(ctx, dailySyms, dailyStart, now, dailyBarsTF)
		dailyCh <- result{m, err}
	}()

	deadline := s.deadline
	if deadline <= 0 {
		deadline = defaultIntradayDeadline
	}
	timer := time.NewTimer(deadline)
	defer timer.Stop()

	var intradayMap, dailyMap map[string][]*interfaces.Bar
	var errs []string
	for received := 0; received < 2; {
		select {
		case r := <-intradayCh:
			if r.err != nil {
				errs = append(errs, fmt.Sprintf("intraday bars: %v", r.err))
			} else {
				intradayMap = r.m
			}
			received++
		case r := <-dailyCh:
			if r.err != nil {
				errs = append(errs, fmt.Sprintf("daily bars: %v", r.err))
			} else {
				dailyMap = r.m
			}
			received++
		case <-timer.C:
			errs = append(errs, "intraday fetch exceeded deadline; returning partial data")
			return intradayMap, dailyMap, errs
		case <-ctx.Done():
			errs = append(errs, fmt.Sprintf("intraday fetch canceled: %v", ctx.Err()))
			return intradayMap, dailyMap, errs
		}
	}
	return intradayMap, dailyMap, errs
}

// computeSignal turns one symbol's intraday + daily bars into a snapshot. Pure
// (no I/O); sectorPct is supplied by the caller from the sector cache. A nil or
// empty intraday slice yields a "no intraday bars yet" note; nil daily simply
// omits the daily-derived fields (RVOL, ATR range, day change).
func computeSignal(symbol string, intraday, daily []*interfaces.Bar, sectorETF string, sectorPct float64, sectorOK bool, now time.Time) IntradaySignal {
	sig := IntradaySignal{Symbol: symbol}

	if len(intraday) == 0 {
		sig.Note = "no intraday bars yet"
	} else {
		sig.VWAP = calcSessionVWAP(intraday)
		sig.SessionHigh = intraday[0].High
		sig.SessionLow = intraday[0].Low
		var cumVol int64
		for _, b := range intraday {
			if b.High > sig.SessionHigh {
				sig.SessionHigh = b.High
			}
			if b.Low < sig.SessionLow {
				sig.SessionLow = b.Low
			}
			cumVol += b.Volume
		}
		sig.Price = intraday[len(intraday)-1].Close
		if sig.VWAP > 0 {
			sig.DistFromVWAPPct = (sig.Price - sig.VWAP) / sig.VWAP * 100.0
		}

		if len(daily) > 0 {
			priorClose := daily[len(daily)-1].Close
			// If the most recent daily bar IS today's, prior close is the one before it.
			if isSameUTCDay(daily[len(daily)-1].Timestamp, now) && len(daily) > 1 {
				priorClose = daily[len(daily)-2].Close
			}
			sig.DayChangePct = calcDayChangePct(sig.Price, priorClose)
			atr := calcATR(trailingBars(daily, atrLookback+1))
			if atr > 0 {
				sig.RangeOverATR = calcRangeOverATR(sig.SessionHigh, sig.SessionLow, atr)
			}
			avgVol := avgDailyVolume(trailingBars(daily, atrLookback))
			sig.RVOL = calcRVOL(cumVol, avgVol, fractionOfSessionElapsed(now))
		}
	}

	if sectorETF != "" {
		sig.SectorETF = sectorETF
		if sectorOK {
			sig.SectorChangePct = sectorPct
		}
	}
	return sig
}

// ── pure functions (tested directly) ───────────────────────────────

// calcSessionVWAP returns the volume-weighted average of the per-bar VWAPs.
// Zero-volume bars are skipped. Returns 0 when total volume is zero.
func calcSessionVWAP(bars []*interfaces.Bar) float64 {
	var totalVol float64
	var weighted float64
	for _, b := range bars {
		if b.Volume == 0 {
			continue
		}
		v := float64(b.Volume)
		weighted += b.VWAP * v
		totalVol += v
	}
	if totalVol == 0 {
		return 0
	}
	return weighted / totalVol
}

// calcRVOL returns today's cumulative volume normalized by the 20-day average
// daily volume, time-adjusted for the fraction of session elapsed. Returns 0
// when either input is zero.
func calcRVOL(todayCumVol int64, avgDailyVol int64, sessionElapsed float64) float64 {
	if avgDailyVol <= 0 || sessionElapsed <= 0 {
		return 0
	}
	expected := float64(avgDailyVol) * sessionElapsed
	if expected <= 0 {
		return 0
	}
	return float64(todayCumVol) / expected
}

// calcRangeOverATR returns (session high − session low) / ATR. Returns 0 when
// ATR is zero or negative.
func calcRangeOverATR(high, low, atr float64) float64 {
	if atr <= 0 {
		return 0
	}
	return (high - low) / atr
}

// calcDayChangePct returns (latest − priorClose) / priorClose × 100. Returns 0
// when priorClose is zero.
func calcDayChangePct(latest, priorClose float64) float64 {
	if priorClose == 0 {
		return 0
	}
	return (latest - priorClose) / priorClose * 100.0
}

// calcATR averages true-range over the given daily bars. Needs at least two
// bars to compute one TR; returns 0 with fewer bars.
func calcATR(bars []*interfaces.Bar) float64 {
	if len(bars) < 2 {
		return 0
	}
	var sum float64
	for i := 1; i < len(bars); i++ {
		prevClose := bars[i-1].Close
		tr := math.Max(bars[i].High-bars[i].Low, math.Max(
			math.Abs(bars[i].High-prevClose),
			math.Abs(bars[i].Low-prevClose),
		))
		sum += tr
	}
	return sum / float64(len(bars)-1)
}

// fractionOfSessionElapsed returns the fraction (0..1) of the US-equities
// regular session that has elapsed at `now`. Before 9:30 ET → 0; after
// 16:00 ET → 1; weekends → 0.
func fractionOfSessionElapsed(now time.Time) float64 {
	day := now.Weekday()
	if day == time.Saturday || day == time.Sunday {
		return 0
	}
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return 0
	}
	et := now.In(loc)
	open := time.Date(et.Year(), et.Month(), et.Day(), 9, 30, 0, 0, loc)
	close := time.Date(et.Year(), et.Month(), et.Day(), 16, 0, 0, 0, loc)
	if !et.After(open) {
		return 0
	}
	if !et.Before(close) {
		return 1
	}
	elapsed := et.Sub(open).Seconds()
	total := close.Sub(open).Seconds()
	return elapsed / total
}

// ── helpers ────────────────────────────────────────────────────────

func trailingBars(bars []*interfaces.Bar, n int) []*interfaces.Bar {
	if len(bars) <= n {
		return bars
	}
	return bars[len(bars)-n:]
}

func avgDailyVolume(bars []*interfaces.Bar) int64 {
	if len(bars) == 0 {
		return 0
	}
	var sum int64
	for _, b := range bars {
		sum += b.Volume
	}
	return sum / int64(len(bars))
}

func startOfSessionUTC(now time.Time) time.Time {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return now.Add(-7 * time.Hour) // approximate fallback
	}
	et := now.In(loc)
	open := time.Date(et.Year(), et.Month(), et.Day(), 9, 30, 0, 0, loc)
	return open.UTC()
}

func isSameUTCDay(a, b time.Time) bool {
	au := a.UTC()
	bu := b.UTC()
	return au.Year() == bu.Year() && au.YearDay() == bu.YearDay()
}
