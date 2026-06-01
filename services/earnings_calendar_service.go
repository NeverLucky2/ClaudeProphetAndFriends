package services

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

const (
	earningsExclusionDays    = 3
	staleThreshold           = 36 * time.Hour
	staleWarnInterval        = 4 * time.Hour
	earningsFetchHorizonDays = 10
	calendarFetchHorizonDays = 14
	refreshCheckInterval     = 1 * time.Hour

	// FirstRefreshWaitTimeout is the maximum time cmd/bot/main.go waits for
	// the first earnings refresh before proceeding in fail-open mode.
	FirstRefreshWaitTimeout = 5 * time.Second
)

var nyLoc, _ = time.LoadLocation("America/New_York")

// AlpacaCalendarEntry is a market calendar entry (holiday or special session time).
type AlpacaCalendarEntry struct {
	Date         string `json:"date"`          // "YYYY-MM-DD"
	Open         string `json:"open"`          // "HH:MM" regular market open ET
	Close        string `json:"close"`         // "HH:MM" regular market close ET
	SessionOpen  string `json:"session_open"`  // "HHMM" extended-hours open ET
	SessionClose string `json:"session_close"` // "HHMM" extended-hours close ET
}

type earningsEntry struct {
	Ticker string
	Date   time.Time
	Time   string // "bmo" | "amc" | "" (other values normalized to "")
}

type EarningsCalendarService struct {
	httpClient        *http.Client
	fmpAPIKey         string
	fmpBaseURL        string
	alpacaAPIKey      string
	alpacaSecretKey   string
	alpacaBaseURL     string
	mu                sync.RWMutex
	entries           map[string]earningsEntry
	calendar          []AlpacaCalendarEntry
	lastRefreshETDate string
	lastRefresh       time.Time
	lastWarnTime      time.Time
	firstRefreshDone  chan struct{}
	firstRefreshOnce  sync.Once
	logger            *logrus.Logger
}

func NewEarningsCalendarService(
	fmpAPIKey, alpacaAPIKey, alpacaSecretKey, alpacaBaseURL string,
	httpClient *http.Client,
) *EarningsCalendarService {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	if alpacaBaseURL == "" {
		alpacaBaseURL = "https://paper-api.alpaca.markets"
	}
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &EarningsCalendarService{
		httpClient:       httpClient,
		fmpAPIKey:        fmpAPIKey,
		fmpBaseURL:       "https://financialmodelingprep.com",
		alpacaAPIKey:     alpacaAPIKey,
		alpacaSecretKey:  alpacaSecretKey,
		alpacaBaseURL:    alpacaBaseURL,
		entries:          make(map[string]earningsEntry),
		firstRefreshDone: make(chan struct{}),
		logger:           logger,
	}
}

// Start runs an initial refresh, then wakes every refreshCheckInterval and runs
// another refresh when the ET calendar day has rolled over. Exits on ctx cancellation.
func (s *EarningsCalendarService) Start(ctx context.Context) {
	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	s.refresh(time.Now())
	ticker := time.NewTicker(refreshCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			todayET := now.In(loc).Format("2006-01-02")
			s.mu.RLock()
			last := s.lastRefreshETDate
			s.mu.RUnlock()
			if shouldRefreshNow(todayET, last) {
				s.refresh(now)
			}
		}
	}
}

// shouldRefreshNow returns true if a refresh should fire because the ET calendar
// day has rolled over since the last successful refresh (or one has never run).
func shouldRefreshNow(todayETDate, lastRefreshETDate string) bool {
	return lastRefreshETDate != todayETDate
}

// IsExcluded returns true if the ticker has an effective earnings date within the
// next earningsExclusionDays trading days. Fail-open semantics: returns false if
// the cache has never been populated or if required calendar data is missing.
func (s *EarningsCalendarService) IsExcluded(ticker string, now time.Time) bool {
	s.mu.RLock()
	entry, hasEntry := s.entries[ticker]
	calendar := s.calendar
	lastRefresh := s.lastRefresh
	s.mu.RUnlock()

	if lastRefresh.IsZero() {
		return false
	}

	if time.Since(lastRefresh) > staleThreshold {
		if s.maybeWarn(now) {
			s.logger.Warnf("earnings calendar is stale (last refresh > %s ago) — still applying cached exclusions", staleThreshold)
		}
	}

	if !hasEntry {
		return false
	}

	if len(calendar) == 0 {
		if s.maybeWarn(now) {
			s.logger.Warn("earnings calendar trading-day cache empty — exclusion temporarily disabled")
		}
		return false
	}

	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	nowET := now.In(loc)
	nowDate := time.Date(nowET.Year(), nowET.Month(), nowET.Day(), 0, 0, 0, 0, loc)
	effective := s.effectiveDate(entry, calendar)
	distance := tradingDayDistance(nowDate, effective, calendar)
	if distance < 0 {
		return false
	}
	return distance <= earningsExclusionDays
}

// HasEarningsWithinTradingDays returns true if `ticker` has an effective
// earnings date within the next `days` trading days. Fail-open semantics
// match IsExcluded — returns false when the cache is unpopulated, when the
// trading-day calendar is empty, or when the ticker has no scheduled
// earnings on file.
//
// This is the variant Coil (and any other caller with a non-3-day horizon)
// uses; IsExcluded keeps its hard-coded earningsExclusionDays for Spark's
// existing universe filter.
func (s *EarningsCalendarService) HasEarningsWithinTradingDays(ticker string, days int, now time.Time) bool {
	if days <= 0 {
		return false
	}
	s.mu.RLock()
	entry, hasEntry := s.entries[ticker]
	calendar := s.calendar
	lastRefresh := s.lastRefresh
	s.mu.RUnlock()

	if lastRefresh.IsZero() || !hasEntry || len(calendar) == 0 {
		return false
	}
	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	nowET := now.In(loc)
	nowDate := time.Date(nowET.Year(), nowET.Month(), nowET.Day(), 0, 0, 0, 0, loc)
	effective := s.effectiveDate(entry, calendar)
	distance := tradingDayDistance(nowDate, effective, calendar)
	if distance < 0 {
		return false
	}
	return distance <= days
}

// RecentReport is a single past earnings event surfaced by FetchRecentReports.
// Timing is normalized to "bmo" / "amc" / "" (unknown).
type RecentReport struct {
	Ticker string
	Date   time.Time
	Timing string
}

// FetchRecentReports does a one-off (uncached) FMP /stable/earnings-calendar
// fetch covering a past calendar-day window approximating the last `days`
// trading days, and returns parsed entries whose date falls strictly on or
// before today. Used by the Drift agent's candidates service to enumerate
// post-earnings tickers without polluting the forward-looking cache used by
// IsExcluded / HasEarningsWithinTradingDays.
//
// Window is `days*2 + 4` calendar days to cover weekends + holidays. Drift's
// candidates service does trading-day distance filtering downstream using the
// AlpacaCalendarEntry cache via Calendar().
func (s *EarningsCalendarService) FetchRecentReports(ctx context.Context, now time.Time, days int) ([]RecentReport, error) {
	if days <= 0 {
		return nil, nil
	}
	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	nowET := now.In(loc)
	from := nowET.AddDate(0, 0, -(days*2 + 4))
	return s.FetchReportsInRange(ctx, from, nowET)
}

// FetchReportsInRange does a one-off (uncached) FMP /stable/earnings-calendar
// fetch over [from, to] (inclusive, by calendar date) and returns parsed
// RecentReport entries with timing normalized to "bmo"/"amc"/"". Entries
// outside [from, to] are dropped. Used by FetchRecentReports and the offline
// driftreplay tool (which needs arbitrary historical windows).
func (s *EarningsCalendarService) FetchReportsInRange(ctx context.Context, from, to time.Time) ([]RecentReport, error) {
	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	fromYMD := from.In(loc).Format("2006-01-02")
	toYMD := to.In(loc).Format("2006-01-02")
	url := fmt.Sprintf("%s/stable/earnings-calendar?from=%s&to=%s&apikey=%s",
		s.fmpBaseURL, fromYMD, toYMD, s.fmpAPIKey)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fmp earnings fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fmp earnings returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var items []fmpEarningsItem
	if err := json.Unmarshal(body, &items); err != nil {
		return nil, fmt.Errorf("parse earnings JSON: %w", err)
	}
	out := make([]RecentReport, 0, len(items))
	for _, it := range items {
		if it.Date < fromYMD || it.Date > toYMD {
			continue
		}
		d, perr := time.ParseInLocation("2006-01-02", it.Date, loc)
		if perr != nil {
			continue
		}
		t := strings.ToLower(strings.TrimSpace(it.Time))
		if t != "bmo" && t != "amc" {
			t = ""
		}
		out = append(out, RecentReport{Ticker: it.Symbol, Date: d, Timing: t})
	}
	return out, nil
}

// symbolEarningsItem parses the per-symbol /stable/earnings response, which —
// unlike /stable/earnings-calendar — carries no "time" (bmo/amc) field and
// includes epsActual (null for not-yet-reported / scheduled dates).
type symbolEarningsItem struct {
	Symbol    string   `json:"symbol"`
	Date      string   `json:"date"`
	EpsActual *float64 `json:"epsActual"`
}

// FetchSymbolReports fetches one symbol's earnings history from FMP
// /stable/earnings (full multi-year history; NOT subject to the
// earnings-calendar endpoint's ~1-year `from` cap or 4000-row truncation) and
// returns the REPORTED earnings (epsActual present) whose date is within
// [from, to]. Timing is always "" — the per-symbol endpoint has no bmo/amc
// field, so the AMC gap-bar convention applies downstream.
func (s *EarningsCalendarService) FetchSymbolReports(ctx context.Context, symbol string, from, to time.Time) ([]RecentReport, error) {
	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	fromYMD := from.In(loc).Format("2006-01-02")
	toYMD := to.In(loc).Format("2006-01-02")
	url := fmt.Sprintf("%s/stable/earnings?symbol=%s&apikey=%s", s.fmpBaseURL, symbol, s.fmpAPIKey)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fmp symbol earnings fetch %s: %w", symbol, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fmp symbol earnings %s returned HTTP %d", symbol, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var items []symbolEarningsItem
	if err := json.Unmarshal(body, &items); err != nil {
		return nil, fmt.Errorf("parse symbol earnings JSON %s: %w", symbol, err)
	}
	out := make([]RecentReport, 0, len(items))
	for _, it := range items {
		if it.EpsActual == nil { // not yet reported (scheduled/future)
			continue
		}
		if it.Date < fromYMD || it.Date > toYMD {
			continue
		}
		d, perr := time.ParseInLocation("2006-01-02", it.Date, loc)
		if perr != nil {
			continue
		}
		out = append(out, RecentReport{Ticker: strings.ToUpper(it.Symbol), Date: d, Timing: ""})
	}
	return out, nil
}

// WaitForFirstRefresh blocks until the first successful refresh has signaled
// firstRefreshDone, or the timeout elapses. Returns true if the signal arrived first.
func (s *EarningsCalendarService) WaitForFirstRefresh(timeout time.Duration) bool {
	select {
	case <-s.firstRefreshDone:
		return true
	case <-time.After(timeout):
		return false
	}
}

// Calendar returns a defensive copy of the cached Alpaca trading calendar.
// Other services (e.g. SECEdgarService) use this to avoid duplicate FMP/Alpaca
// fetches. Returns an empty slice if the calendar has not been populated yet.
func (s *EarningsCalendarService) Calendar() []AlpacaCalendarEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.calendar) == 0 {
		return nil
	}
	out := make([]AlpacaCalendarEntry, len(s.calendar))
	copy(out, s.calendar)
	return out
}

// tradingDayDistance returns the number of trading days from nowDate (exclusive)
// to effective (inclusive). Both arguments are compared by date in their stored
// location. Returns -1 if effective is strictly before nowDate.
func tradingDayDistance(nowDate, effective time.Time, calendar []AlpacaCalendarEntry) int {
	nowYMD := nowDate.Format("2006-01-02")
	effYMD := effective.Format("2006-01-02")
	if effYMD < nowYMD {
		return -1
	}
	if effYMD == nowYMD {
		return 0
	}
	count := 0
	for _, e := range calendar {
		if e.Date > nowYMD && e.Date <= effYMD {
			count++
		}
	}
	return count
}

// effectiveDate computes the trading day on which the post-earnings gap will manifest.
// For BMO/empty time: returns the first trading day on or after entry.Date.
// For AMC: returns the first trading day strictly after entry.Date.
// Returns entry.Date unchanged if calendar is empty or no qualifying day exists.
func (s *EarningsCalendarService) effectiveDate(entry earningsEntry, calendar []AlpacaCalendarEntry) time.Time {
	if len(calendar) == 0 {
		return entry.Date
	}
	entryYMD := entry.Date.Format("2006-01-02")
	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	for _, c := range calendar {
		if entry.Time == "amc" {
			if c.Date > entryYMD {
				if d, err := time.ParseInLocation("2006-01-02", c.Date, loc); err == nil {
					return d
				}
			}
		} else {
			if c.Date >= entryYMD {
				if d, err := time.ParseInLocation("2006-01-02", c.Date, loc); err == nil {
					return d
				}
			}
		}
	}
	return entry.Date
}

// maybeWarn returns true if a warning should be emitted right now (caller emits the log message)
// and updates lastWarnTime under write-lock. Returns false if the previous warn was within
// staleWarnInterval. The shared throttle covers all warn types (stale, empty calendar, etc.)
// to keep logs from flooding when multiple conditions co-occur.
func (s *EarningsCalendarService) maybeWarn(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.lastWarnTime.IsZero() && now.Sub(s.lastWarnTime) < staleWarnInterval {
		return false
	}
	s.lastWarnTime = now
	return true
}

type fmpEarningsItem struct {
	Symbol string `json:"symbol"`
	Date   string `json:"date"`
	Time   string `json:"time"`
}

// refreshEarnings fetches the FMP earnings calendar and replaces the entries map
// with the parsed result. The HTTP call and parse run outside the mutex; the lock
// is held only for the final swap. Returns the count of parsed and skipped entries
// for the caller to log; on failure returns an error and preserves the prior cache.
func (s *EarningsCalendarService) refreshEarnings(now time.Time) (parsed, skipped int, err error) {
	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	nowET := now.In(loc)
	from := nowET.Format("2006-01-02")
	to := nowET.AddDate(0, 0, earningsFetchHorizonDays).Format("2006-01-02")
	url := fmt.Sprintf("%s/stable/earnings-calendar?from=%s&to=%s&apikey=%s",
		s.fmpBaseURL, from, to, s.fmpAPIKey)

	resp, err := s.httpClient.Get(url)
	if err != nil {
		s.logger.WithError(err).Warn("EarningsCalendarService: FMP earnings fetch failed")
		return 0, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		s.logger.WithField("status", resp.StatusCode).Warn("EarningsCalendarService: FMP earnings non-200")
		return 0, 0, fmt.Errorf("fmp earnings returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		s.logger.WithError(err).Warn("EarningsCalendarService: failed to read FMP earnings body")
		return 0, 0, err
	}
	var items []fmpEarningsItem
	if err := json.Unmarshal(body, &items); err != nil {
		s.logger.WithError(err).Warn("EarningsCalendarService: failed to parse FMP earnings JSON")
		return 0, 0, err
	}

	todayYMD := from
	parsedMap := make(map[string]earningsEntry)
	for _, it := range items {
		d, perr := time.ParseInLocation("2006-01-02", it.Date, loc)
		if perr != nil {
			skipped++
			continue
		}
		if it.Date < todayYMD {
			continue
		}
		t := strings.ToLower(strings.TrimSpace(it.Time))
		if t != "bmo" && t != "amc" {
			t = ""
		}
		entry := earningsEntry{Ticker: it.Symbol, Date: d, Time: t}
		if existing, ok := parsedMap[it.Symbol]; !ok || d.Before(existing.Date) {
			parsedMap[it.Symbol] = entry
		}
	}

	s.mu.Lock()
	s.entries = parsedMap
	s.mu.Unlock()

	return len(parsedMap), skipped, nil
}

// refreshCalendar fetches the multi-day Alpaca trading-day calendar. Returns the
// first and last dates in the fetched calendar (for logging) on success.
func (s *EarningsCalendarService) refreshCalendar(now time.Time) (firstDate, lastDate string, err error) {
	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	nowET := now.In(loc)
	start := nowET.Format("2006-01-02")
	end := nowET.AddDate(0, 0, calendarFetchHorizonDays).Format("2006-01-02")
	url := fmt.Sprintf("%s/v2/calendar?start=%s&end=%s", s.alpacaBaseURL, start, end)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		s.logger.WithError(err).Warn("EarningsCalendarService: Alpaca calendar request build failed")
		return "", "", err
	}
	req.Header.Set("APCA-API-KEY-ID", s.alpacaAPIKey)
	req.Header.Set("APCA-API-SECRET-KEY", s.alpacaSecretKey)
	resp, err := s.httpClient.Do(req)
	if err != nil {
		s.logger.WithError(err).Warn("EarningsCalendarService: Alpaca calendar fetch failed")
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		s.logger.WithField("status", resp.StatusCode).Warn("EarningsCalendarService: Alpaca calendar non-200")
		return "", "", fmt.Errorf("alpaca calendar returned HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", err
	}
	var entries []AlpacaCalendarEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		s.logger.WithError(err).Warn("EarningsCalendarService: failed to parse Alpaca calendar JSON")
		return "", "", err
	}
	if len(entries) == 0 {
		s.logger.Warn("EarningsCalendarService: Alpaca calendar returned 0 entries")
		return "", "", fmt.Errorf("alpaca calendar empty")
	}

	s.mu.Lock()
	s.calendar = entries
	s.mu.Unlock()
	return entries[0].Date, entries[len(entries)-1].Date, nil
}

// refresh runs both fetches and updates lastRefresh / lastRefreshETDate.
// Signals firstRefreshDone only when both fetches succeeded. FMP failure aborts;
// Alpaca failure leaves prior calendar in place but skips the firstRefreshDone signal.
// On success, emits a single combined info log.
func (s *EarningsCalendarService) refresh(now time.Time) {
	parsed, skipped, err := s.refreshEarnings(now)
	if err != nil {
		return
	}
	calFrom, calTo, calErr := s.refreshCalendar(now)

	loc := nyLoc
	if loc == nil {
		loc = time.UTC
	}
	todayET := now.In(loc).Format("2006-01-02")

	s.mu.Lock()
	s.lastRefresh = now
	s.lastRefreshETDate = todayET
	s.mu.Unlock()

	fields := logrus.Fields{
		"parsed":  parsed,
		"skipped": skipped,
	}
	if calErr == nil {
		fields["calendar_from"] = calFrom
		fields["calendar_to"] = calTo
		s.firstRefreshOnce.Do(func() { close(s.firstRefreshDone) })
	}
	s.logger.WithFields(fields).Info("EarningsCalendarService: refresh complete")
}

// StaticMarketPhase returns the current market phase: "pre", "open", "after", or "closed".
// Used by Harvest and other services to determine if the market is currently open.
func StaticMarketPhase(now time.Time, loc *time.Location) string {
	return staticMarketPhase(now, loc)
}

func staticMarketPhase(now time.Time, loc *time.Location) string {
	nowET := now.In(loc)
	wd := nowET.Weekday()
	if wd == time.Saturday || wd == time.Sunday {
		return "closed"
	}
	h, m, _ := nowET.Clock()
	total := h*60 + m
	switch {
	case total < 4*60 || total >= 20*60:
		return "closed"
	case total < 9*60+30:
		return "pre"
	case total >= 16*60:
		return "after"
	default:
		return "open"
	}
}
