package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"prophet-trader/interfaces"

	"github.com/sirupsen/logrus"
)

// MarketDataProvider is the data surface every non-intraday consumer reads
// through. It is interfaces.DataService plus the multi-symbol batch method that
// *AlpacaDataService adds beyond the interface. Both *AlpacaDataService and
// *SharedBarCache satisfy it, so either can be wired into every consumer
// (BarFetcher / MultiBarsFetcher / rvDataSource / intradayDataLike / DataService
// are all subsets of this method set).
type MarketDataProvider interface {
	interfaces.DataService
	GetMultiBars(ctx context.Context, symbols []string, start, end time.Time, timeframe string) (map[string][]*interfaces.Bar, error)
}

// SharedBarCache is a read-through, on-disk cache in front of a
// MarketDataProvider. It caches GetHistoricalBars / GetMultiBars for daily-and-
// coarser timeframes (one JSON file per symbol/timeframe/ET-date-window in a
// shared directory) and forwards everything else verbatim. It soft-fails on
// every error path: any miss / stale / corrupt / IO error degrades to a direct
// fetch, so the cache can never break or block a request.
type SharedBarCache struct {
	underlying MarketDataProvider
	dir        string
	ttl        time.Duration
	clock      func() time.Time // injectable; prod = time.Now
	logger     *logrus.Logger
}

// NewSharedBarCache wraps underlying. dir should already be an absolute path the
// caller has created (see cmd/bot/main.go). A nil logger disables debug logging.
func NewSharedBarCache(underlying MarketDataProvider, dir string, ttl time.Duration, logger *logrus.Logger) *SharedBarCache {
	return &SharedBarCache{
		underlying: underlying,
		dir:        dir,
		ttl:        ttl,
		clock:      time.Now,
		logger:     logger,
	}
}

// cachedBars is the on-disk payload. WrittenAt drives freshness; the key fields
// are stored for debuggability when inspecting the file.
type cachedBars struct {
	Symbol    string            `json:"symbol"`
	Timeframe string            `json:"timeframe"`
	StartDate string            `json:"start_date"`
	EndDate   string            `json:"end_date"`
	WrittenAt time.Time         `json:"written_at"`
	Bars      []*interfaces.Bar `json:"bars"`
}

// isCacheableTF reports whether a timeframe is daily-or-coarser (cacheable).
// Sub-daily timeframes churn within a session and are never cached.
func isCacheableTF(tf string) bool {
	switch tf {
	case "1Day", "1Week", "1Month":
		return true
	default:
		return false
	}
}

// dateKey normalizes an instant to its Eastern trading date. All bar callers
// pass end=now (a continuously shifting timestamp), so the key must collapse to
// date granularity or it would never hit. nyLoc is the services-package ET
// location (declared in penny_universe_service.go).
func dateKey(t time.Time) string { return t.In(nyLoc).Format("2006-01-02") }

// sanitize keeps only filesystem-safe characters (e.g. "BRK.B" -> "BRK_B").
func sanitize(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '_'
		}
	}, s)
}

func (c *SharedBarCache) entryPath(symbol, timeframe, startDate, endDate string) string {
	name := fmt.Sprintf("%s_%s_%s_%s.json", sanitize(symbol), sanitize(timeframe), startDate, endDate)
	return filepath.Join(c.dir, name)
}

func (c *SharedBarCache) debug(msg string, err error) {
	if c.logger != nil {
		c.logger.WithError(err).Debug("shared bar cache: " + msg)
	}
}

// readEntry returns cached bars iff the file exists, parses, and is within ttl.
// Every failure is a miss (nil, false) — soft-fail.
func (c *SharedBarCache) readEntry(path string) ([]*interfaces.Bar, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var p cachedBars
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, false
	}
	if c.clock().Sub(p.WrittenAt) >= c.ttl {
		return nil, false
	}
	return p.Bars, true
}

// writeEntry atomically writes bars to path (temp file + rename). Every error is
// logged at debug and otherwise ignored — a failed write never fails the call.
func (c *SharedBarCache) writeEntry(path string, p cachedBars) {
	data, err := json.Marshal(p)
	if err != nil {
		c.debug("marshal", err)
		return
	}
	tmp, err := os.CreateTemp(c.dir, "tmp-*")
	if err != nil {
		c.debug("create temp", err)
		return
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
		c.debug("write temp", err)
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		c.debug("close temp", err)
		return
	}
	// os.Rename replaces an existing target on Windows (MoveFileEx). A rename
	// onto a path another process holds open can fail with a sharing violation;
	// that is soft-failed here (the fetched bars were already returned).
	if err := os.Rename(tmpName, path); err != nil {
		_ = os.Remove(tmpName)
		c.debug("rename", err)
	}
}

// --- forwarded verbatim (not cached) ---

func (c *SharedBarCache) GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error) {
	return c.underlying.GetLatestBar(ctx, symbol)
}
func (c *SharedBarCache) GetLatestQuote(ctx context.Context, symbol string) (*interfaces.Quote, error) {
	return c.underlying.GetLatestQuote(ctx, symbol)
}
func (c *SharedBarCache) GetLatestTrade(ctx context.Context, symbol string) (*interfaces.Trade, error) {
	return c.underlying.GetLatestTrade(ctx, symbol)
}
func (c *SharedBarCache) StreamBars(ctx context.Context, symbols []string) (<-chan *interfaces.Bar, error) {
	return c.underlying.StreamBars(ctx, symbols)
}

// --- cached ---

func (c *SharedBarCache) GetHistoricalBars(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, error) {
	if !isCacheableTF(timeframe) {
		return c.underlying.GetHistoricalBars(ctx, symbol, start, end, timeframe)
	}
	sd, ed := dateKey(start), dateKey(end)
	path := c.entryPath(symbol, timeframe, sd, ed)
	if bars, ok := c.readEntry(path); ok {
		return bars, nil
	}
	bars, err := c.underlying.GetHistoricalBars(ctx, symbol, start, end, timeframe)
	if err != nil {
		return nil, err
	}
	if len(bars) > 0 { // never cache an empty/no-data result (it'd leak as a permanent miss)
		c.writeEntry(path, cachedBars{Symbol: symbol, Timeframe: timeframe, StartDate: sd, EndDate: ed, WrittenAt: c.clock(), Bars: bars})
	}
	return bars, nil
}

func (c *SharedBarCache) GetMultiBars(ctx context.Context, symbols []string, start, end time.Time, timeframe string) (map[string][]*interfaces.Bar, error) {
	if !isCacheableTF(timeframe) {
		return c.underlying.GetMultiBars(ctx, symbols, start, end, timeframe)
	}
	sd, ed := dateKey(start), dateKey(end)
	out := make(map[string][]*interfaces.Bar, len(symbols))
	var misses []string
	for _, s := range symbols {
		if bars, ok := c.readEntry(c.entryPath(s, timeframe, sd, ed)); ok {
			out[s] = bars
		} else {
			misses = append(misses, s)
		}
	}
	if len(misses) == 0 {
		return out, nil
	}
	fetched, err := c.underlying.GetMultiBars(ctx, misses, start, end, timeframe)
	if err != nil {
		return nil, err // match AlpacaDataService.GetMultiBars: error -> (nil, err)
	}
	for s, bars := range fetched {
		out[s] = bars
		if len(bars) > 0 {
			c.writeEntry(c.entryPath(s, timeframe, sd, ed), cachedBars{Symbol: s, Timeframe: timeframe, StartDate: sd, EndDate: ed, WrittenAt: c.clock(), Bars: bars})
		}
	}
	return out, nil
}
