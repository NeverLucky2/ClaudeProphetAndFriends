package services

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"prophet-trader/interfaces"

	"github.com/sirupsen/logrus"
)

// ErrInsufficientMeanRevHistory is returned by GetSignal when a ticker has
// fewer bars than the minimum required to compute the mean-reversion signal
// (RSI(2) + SMA(200) + SMA(5)). The candidates service drops the ticker.
var ErrInsufficientMeanRevHistory = errors.New("insufficient bar history for mean-reversion signal")

// MeanRevSignal is the JSON shape returned by GET /api/v1/meanrev/signal/:symbol
// and embedded in each candidate of GET /api/v1/meanrev/candidates.
type MeanRevSignal struct {
	Ticker            string  `json:"ticker"`
	AsOf              string  `json:"as_of"`
	BarsCount         int     `json:"bars_count"`
	LastClose         float64 `json:"last_close"`
	RSI2              float64 `json:"rsi_2"`
	SMA200            float64 `json:"sma_200"`
	SMA5              float64 `json:"sma_5"`
	EarningsWithin5d  bool    `json:"earnings_within_5d"`
	EntrySignal       bool    `json:"entry_signal"`
	SignalVersion     string  `json:"signal_version"`
	Explanation       string  `json:"explanation,omitempty"`
}

// MeanRevCandidatesResponse is the JSON shape returned by GET /api/v1/meanrev/candidates.
type MeanRevCandidatesResponse struct {
	AsOf       string          `json:"as_of"`
	Count      int             `json:"count"`
	BearRegime bool            `json:"bear_regime"`
	BearMode   string          `json:"bear_mode"`
	Candidates []MeanRevSignal `json:"candidates"`
	Errors     []string        `json:"errors,omitempty"`
}

const (
	// minBars must cover SMA(200) (needs 200 closes) plus a few bars of margin
	// for RSI(2) Wilder smoothing warmup. 210 is the lower bound the agent
	// rules document.
	meanRevMinBars       = 210
	meanRevBarLookback   = 320 // calendar days; covers ~220 trading days with margin
	meanRevRSIPeriod     = 2
	meanRevSMA200Window  = 200
	meanRevSMA5Window    = 5
	meanRevSignalVersion = "v1"

	// Entry thresholds (mirror TRADING_RULES_MEANREV.md)
	meanRevRSIEntryMax = 5.0  // RSI(2) strictly less than this
	meanRevEarningsHorizonDays = 5

	// SPY is the bear-regime reference. SPY's last close < SMA(200) flips the
	// bear-regime flag; the operator controls behavior via MEANREV_BEAR_MODE.
	meanRevBearRegimeSymbol = "SPY"

	bearModeNormal   = "normal"
	bearModeHalfsize = "halfsize"
	bearModeHalt     = "halt"
)

// MeanRevUniverse is the fixed curated set of large-cap S&P 500 stocks Coil
// considers. Constraints (enforced at list-curation time, not runtime):
//   - US-listed common stock
//   - Price > $20
//   - 30-day average dollar volume > $50M
//   - Single-class plain tickers (no BRK.B, no preferreds)
//   - No ETFs (avoids overlap with Turtle), no sub-$5 microcaps
//
// Universe expansion is a v2 concern; for v1 the list is intentionally a
// small, stable set so the candidate scan is fast and deterministic.
var MeanRevUniverse = []string{
	"AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO",
	"JPM", "V", "WMT", "UNH", "MA", "JNJ", "XOM", "PG",
	"ORCL", "HD", "COST", "ABBV", "MRK", "KO", "BAC", "CVX",
	"PEP", "ADBE", "CRM", "NFLX", "AMD", "TMO", "ACN", "LLY",
	"MCD", "ABT", "CSCO", "DHR", "WFC", "LIN", "NKE", "DIS",
	"TXN", "NEE", "INTU", "AMGN", "IBM", "PM", "CMCSA", "RTX",
	"QCOM", "CAT", "BMY", "GS", "UNP", "AXP", "LOW", "BLK",
	"SCHW", "NOW", "GE", "AMAT", "DE", "SPGI", "BKNG", "ISRG",
	"MS", "ADI", "TJX", "MDT", "BA", "PLD", "MMC", "VRTX",
	"ADP", "LMT", "GILD", "MO", "SYK", "CI", "MDLZ", "SO",
}

// EarningsHorizonChecker is the narrow interface MeanRevCandidatesService
// depends on for the no-earnings-within-N-days filter. EarningsCalendarService
// implements it via HasEarningsWithinTradingDays; tests can supply stubs.
type EarningsHorizonChecker interface {
	HasEarningsWithinTradingDays(ticker string, days int, now time.Time) bool
}

// MeanRevSignalService computes per-symbol RSI(2)/SMA(200)/SMA(5) signals
// for the Coil agent. Pure-function compute; pass any BarFetcher.
type MeanRevSignalService struct {
	dataSvc BarFetcher
}

// NewMeanRevSignalService creates the service backed by the given BarFetcher.
func NewMeanRevSignalService(dataSvc BarFetcher) *MeanRevSignalService {
	return &MeanRevSignalService{dataSvc: dataSvc}
}

// GetSignal fetches daily bars for symbol and computes the per-symbol signal.
// Returns ErrInsufficientMeanRevHistory if fewer than meanRevMinBars bars are
// available; the candidates service treats this as a skip condition.
//
// The earnings_within_5d field is left false here — the candidates service
// fills it in based on EarningsCalendarService. Single-symbol callers that
// need it should consult the calendar separately.
func (s *MeanRevSignalService) GetSignal(ctx context.Context, symbol string) (*MeanRevSignal, error) {
	end := time.Now()
	start := end.AddDate(0, 0, -meanRevBarLookback)
	bars, err := s.dataSvc.GetHistoricalBars(ctx, symbol, start, end, "1Day")
	if err != nil {
		return nil, fmt.Errorf("fetch bars for %s: %w", symbol, err)
	}
	if len(bars) < meanRevMinBars {
		return nil, ErrInsufficientMeanRevHistory
	}
	return ComputeMeanRevSignal(symbol, bars), nil
}

// GetSignalSeries returns the per-day MeanRevSignal for the most recent `days`
// trading bars, each computed AS-OF that day by re-slicing the bar history into
// ComputeMeanRevSignal — so the RSI/SMA math is byte-for-byte the single-day
// path, never re-derived. Order is oldest→newest. Only days whose inclusive
// prefix has >= meanRevMinBars bars are returned, so SMA-200/SMA-5/RSI are always
// valid (never the meanRevSMA "0 on short prefix" sentinel); if fewer valid days
// exist than requested, fewer are returned. The last element equals GetSignal for
// the same bars (latest-day parity).
func (s *MeanRevSignalService) GetSignalSeries(ctx context.Context, symbol string, days int) ([]*MeanRevSignal, error) {
	if days <= 0 {
		return nil, fmt.Errorf("days must be positive, got %d", days)
	}
	end := time.Now()
	start := end.AddDate(0, 0, -meanRevBarLookback)
	bars, err := s.dataSvc.GetHistoricalBars(ctx, symbol, start, end, "1Day")
	if err != nil {
		return nil, fmt.Errorf("fetch bars for %s: %w", symbol, err)
	}
	if len(bars) < meanRevMinBars {
		return nil, ErrInsufficientMeanRevHistory
	}
	// Inclusive prefix bars[:idx+1] first reaches meanRevMinBars bars at idx = meanRevMinBars-1.
	firstValid := meanRevMinBars - 1
	startIdx := len(bars) - days
	if startIdx < firstValid {
		startIdx = firstValid
	}
	out := make([]*MeanRevSignal, 0, len(bars)-startIdx)
	for k := startIdx; k < len(bars); k++ {
		out = append(out, ComputeMeanRevSignal(symbol, bars[:k+1]))
	}
	return out, nil
}

// ComputeMeanRevSignal is the pure-function form of signal computation.
// Exposed so tests can drive it with synthetic bars without going through
// Alpaca. earnings_within_5d defaults to false; the candidates service is
// the authoritative source for that field.
func ComputeMeanRevSignal(symbol string, bars []*interfaces.Bar) *MeanRevSignal {
	L := len(bars)
	closes := make([]float64, L)
	for i, b := range bars {
		closes[i] = b.Close
	}

	lastClose := closes[L-1]
	sma200 := meanRevSMA(closes, meanRevSMA200Window)
	sma5 := meanRevSMA(closes, meanRevSMA5Window)
	rsi2 := wilderRSI(closes, meanRevRSIPeriod)

	entry := rsi2 < meanRevRSIEntryMax &&
		lastClose > sma200 &&
		lastClose < sma5

	return &MeanRevSignal{
		Ticker:           strings.ToUpper(symbol),
		AsOf:             bars[L-1].Timestamp.Format(time.RFC3339),
		BarsCount:        L,
		LastClose:        lastClose,
		RSI2:             rsi2,
		SMA200:           sma200,
		SMA5:             sma5,
		EarningsWithin5d: false,
		EntrySignal:      entry,
		SignalVersion:    meanRevSignalVersion,
	}
}

// meanRevSMA returns the simple mean of the last n closes, INCLUDING the
// most recent bar. Unlike trend_signal_service.go's sma (which excludes the
// last bar), the mean-reversion regime filter compares last_close against
// an SMA that includes today, matching the convention used in the
// Connors/Aronson literature.
func meanRevSMA(closes []float64, n int) float64 {
	L := len(closes)
	if L < n || n <= 0 {
		return 0
	}
	sum := 0.0
	for i := L - n; i < L; i++ {
		sum += closes[i]
	}
	return sum / float64(n)
}

// wilderRSI computes the n-period Wilder-smoothed Relative Strength Index
// over closes, returning RSI through the most recent bar (closes[L-1]).
//
// Definitions:
//
//	gain[i] = max(closes[i] - closes[i-1], 0)
//	loss[i] = max(closes[i-1] - closes[i], 0)
//	seed avgGain = mean(gain[1..n]); seed avgLoss = mean(loss[1..n])
//	avgGain[i] = (avgGain[i-1]*(n-1) + gain[i]) / n
//	avgLoss[i] = (avgLoss[i-1]*(n-1) + loss[i]) / n
//	RSI = 100 - 100/(1 + avgGain/avgLoss)
//
// Edge cases:
//   - All losses (avgGain = 0)        → RSI = 0
//   - All gains  (avgLoss = 0)        → RSI = 100
//   - Both zero  (flat series)        → RSI = 50 (no information; standard convention)
func wilderRSI(closes []float64, n int) float64 {
	L := len(closes)
	if L < n+1 || n <= 0 {
		return 50.0
	}
	// Seed window: gain/loss for bars 1..n
	var sumGain, sumLoss float64
	for i := 1; i <= n; i++ {
		ch := closes[i] - closes[i-1]
		if ch > 0 {
			sumGain += ch
		} else if ch < 0 {
			sumLoss -= ch
		}
	}
	avgGain := sumGain / float64(n)
	avgLoss := sumLoss / float64(n)

	// Wilder recursion: bars n+1 .. L-1
	for i := n + 1; i < L; i++ {
		ch := closes[i] - closes[i-1]
		gain, loss := 0.0, 0.0
		if ch > 0 {
			gain = ch
		} else if ch < 0 {
			loss = -ch
		}
		avgGain = (avgGain*float64(n-1) + gain) / float64(n)
		avgLoss = (avgLoss*float64(n-1) + loss) / float64(n)
	}
	if avgLoss == 0 && avgGain == 0 {
		return 50.0
	}
	if avgLoss == 0 {
		return 100.0
	}
	rs := avgGain / avgLoss
	return 100.0 - 100.0/(1.0+rs)
}

// MeanRevCandidatesService scans MeanRevUniverse and returns the filtered,
// ranked candidate list consumed by the Coil agent.
type MeanRevCandidatesService struct {
	signalSvc *MeanRevSignalService
	earnings  EarningsHorizonChecker
	universe  []string
	bearMode  string
	logger    *logrus.Logger

	// Cache: candidates are recomputed at most once per refreshInterval.
	// The agent calls the endpoint at most twice per day (15:45 and an
	// optional 09:35 morning beat); caching primarily protects against
	// accidental refresh storms.
	mu              sync.RWMutex
	cached          *MeanRevCandidatesResponse
	cachedAt        time.Time
	refreshInterval time.Duration
}

// NewMeanRevCandidatesService creates the candidates service.
//   - signalSvc: per-symbol bar fetch + RSI/SMA computation
//   - earnings:  optional earnings horizon checker; nil = skip earnings filter
//   - universe:  optional override (nil = use MeanRevUniverse)
//   - bearMode:  one of "normal", "halfsize", "halt" (env: MEANREV_BEAR_MODE).
//     Empty defaults to "halfsize" per spec.
func NewMeanRevCandidatesService(
	signalSvc *MeanRevSignalService,
	earnings EarningsHorizonChecker,
	universe []string,
	bearMode string,
) *MeanRevCandidatesService {
	if universe == nil {
		universe = append([]string{}, MeanRevUniverse...)
	}
	mode := strings.ToLower(strings.TrimSpace(bearMode))
	switch mode {
	case bearModeNormal, bearModeHalfsize, bearModeHalt:
		// valid
	default:
		mode = bearModeHalfsize
	}
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &MeanRevCandidatesService{
		signalSvc:       signalSvc,
		earnings:        earnings,
		universe:        universe,
		bearMode:        mode,
		logger:          logger,
		refreshInterval: 5 * time.Minute,
	}
}

// SetRefreshInterval overrides the cache TTL. Used by tests to force fresh
// computes. Negative values disable caching.
func (s *MeanRevCandidatesService) SetRefreshInterval(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshInterval = d
}

// GetCandidates returns the cached candidates response, recomputing if the
// cache is stale (older than refreshInterval). The result is always non-nil;
// per-symbol fetch errors land in Errors[] and the candidate is skipped.
func (s *MeanRevCandidatesService) GetCandidates(ctx context.Context) *MeanRevCandidatesResponse {
	s.mu.RLock()
	if s.cached != nil && s.refreshInterval >= 0 && time.Since(s.cachedAt) < s.refreshInterval {
		out := s.cached
		s.mu.RUnlock()
		return out
	}
	s.mu.RUnlock()

	resp := s.computeCandidates(ctx)
	s.mu.Lock()
	s.cached = resp
	s.cachedAt = time.Now()
	s.mu.Unlock()
	return resp
}

// Refresh unconditionally recomputes the candidate scan and overwrites the
// cache, bypassing the TTL. The background cache warmer calls this so the
// once-daily Coil beat reads a hot cache instead of triggering a cold
// full-universe scan that exceeds agent/preflight.js's 2s budget. Safe to
// call concurrently with GetCandidates reads.
func (s *MeanRevCandidatesService) Refresh(ctx context.Context) {
	resp := s.computeCandidates(ctx)
	s.mu.Lock()
	s.cached = resp
	s.cachedAt = time.Now()
	s.mu.Unlock()
}

// computeCandidates does the full scan-and-filter pass. Public-method
// GetCandidates wraps this with cache logic.
func (s *MeanRevCandidatesService) computeCandidates(ctx context.Context) *MeanRevCandidatesResponse {
	now := time.Now()
	resp := &MeanRevCandidatesResponse{
		BearMode:   s.bearMode,
		Candidates: make([]MeanRevSignal, 0),
		Errors:     nil,
	}

	// Bear regime read from SPY's last close vs SMA(200). Soft-fail: if SPY
	// data is unavailable, treat as not-bear and surface the error in
	// resp.Errors so the operator sees the staleness.
	bearSig, err := s.signalSvc.GetSignal(ctx, meanRevBearRegimeSymbol)
	if err != nil {
		resp.Errors = append(resp.Errors, fmt.Sprintf("bear-regime SPY signal: %s", err.Error()))
	} else if bearSig != nil {
		resp.BearRegime = bearSig.LastClose < bearSig.SMA200
	}

	var latestAsOf string
	for _, ticker := range s.universe {
		sig, err := s.signalSvc.GetSignal(ctx, ticker)
		if err != nil {
			if !errors.Is(err, ErrInsufficientMeanRevHistory) {
				resp.Errors = append(resp.Errors, fmt.Sprintf("%s: %s", ticker, err.Error()))
			}
			continue
		}
		if sig == nil {
			continue
		}
		if s.earnings != nil && s.earnings.HasEarningsWithinTradingDays(ticker, meanRevEarningsHorizonDays, now) {
			sig.EarningsWithin5d = true
			// Recompute EntrySignal with the earnings flag applied.
			sig.EntrySignal = sig.EntrySignal && !sig.EarningsWithin5d
		}
		// Only return tickers whose entry conditions hold. The agent never
		// needs to see signals that don't qualify; the universe is large
		// enough that surfacing every symbol every beat would burn context
		// for no decision benefit.
		if !sig.EntrySignal {
			continue
		}
		if sig.AsOf > latestAsOf {
			latestAsOf = sig.AsOf
		}
		sig.Explanation = ExplainMeanRevEntry(*sig)
		resp.Candidates = append(resp.Candidates, *sig)
	}

	// Sort by RSI(2) ascending — most oversold first. The agent walks the
	// list top-down within the position cap.
	sort.Slice(resp.Candidates, func(i, j int) bool {
		return resp.Candidates[i].RSI2 < resp.Candidates[j].RSI2
	})
	resp.Count = len(resp.Candidates)
	resp.AsOf = latestAsOf
	return resp
}

// GetSignalForTicker is a per-symbol lookup used by the /api/v1/meanrev/signal/:symbol
// endpoint. It enriches the per-symbol signal with the earnings_within_5d flag
// when an earnings checker is configured.
func (s *MeanRevCandidatesService) GetSignalForTicker(ctx context.Context, ticker string) (*MeanRevSignal, error) {
	sig, err := s.signalSvc.GetSignal(ctx, ticker)
	if err != nil {
		return nil, err
	}
	if s.earnings != nil {
		sig.EarningsWithin5d = s.earnings.HasEarningsWithinTradingDays(ticker, meanRevEarningsHorizonDays, time.Now())
		sig.EntrySignal = sig.EntrySignal && !sig.EarningsWithin5d
	}
	sig.Explanation = ExplainMeanRevEntry(*sig)
	return sig, nil
}

// GetSignalSeriesForTicker backs GET /api/v1/meanrev/signal-series/:symbol. It is
// a thin pass-through to the signal service; earnings enrichment is intentionally
// NOT applied — the shadow-eval scorer consumes only price/RSI/SMA, and a per-day
// earnings recompute would be both wrong (the earnings flag is as-of "now", not
// as-of each historical day) and unnecessary.
func (s *MeanRevCandidatesService) GetSignalSeriesForTicker(ctx context.Context, ticker string, days int) ([]*MeanRevSignal, error) {
	return s.signalSvc.GetSignalSeries(ctx, ticker, days)
}

// Universe returns a defensive copy of the configured universe.
func (s *MeanRevCandidatesService) Universe() []string {
	out := make([]string, len(s.universe))
	copy(out, s.universe)
	return out
}
