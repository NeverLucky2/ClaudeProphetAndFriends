# Shared Daily-Bar Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse redundant cross-agent daily-bar fetches (the Alpaca 429 storm) by adding a shared on-disk bar cache in front of the shared data service, and gate the candidate-cache warmer so only the agents that consume it run it.

**Architecture:** A `SharedBarCache` decorator wraps the rate-limited `*AlpacaDataService`, caching `GetHistoricalBars`/`GetMultiBars` for `≥1Day` timeframes as one JSON file per (symbol, timeframe, ET-date-window) under a shared dir, and forwarding everything else (incl. all intraday/sub-daily fetches) untouched. It soft-fails on every error path. Separately, the candidate warmer is gated to Coil/Drift via two env flags the orchestrator sets from `strategyId`.

**Tech Stack:** Go (`services`, `config`, `cmd/bot`), Go `testing`; Node ESM (`agent/orchestrator.js`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-22-shared-daily-bar-cache-design.md` (rev. 2).

**Refinement vs spec §4.5:** the spec described freshness by file `mtime`. This plan instead stores `WrittenAt` (set from an injectable `clock`) inside the JSON payload and compares `clock() - WrittenAt < ttl`. Semantics are identical (all bots use real `time.Now`), but it is deterministically testable and immune to mtime-not-updating / rename-resets-mtime quirks.

---

## File structure

- **Create `services/shared_bar_cache.go`** — the `MarketDataProvider` interface, the `SharedBarCache` decorator, the cache key/IO/TTL helpers. One responsibility: read-through caching of bar fetches.
- **Create `services/shared_bar_cache_test.go`** — decorator unit tests against a call-counting fake + `t.TempDir()`.
- **Modify `config/config.go`** — add `BarCacheEnabled`/`BarCacheDir`/`BarCacheTTL` + a `parseDurationOrDefault` helper.
- **Modify `config/config_test.go`** — defaults/override tests for the new config.
- **Modify `cmd/bot/main.go`** — wrap the data service in the cache; gate the candidate warmer behind the two env flags.
- **Create `agent/candidate-warmer-flags.js`** — pure `candidateWarmerFlags(strategyId)` helper (kept standalone so its test needn't import the whole orchestrator).
- **Modify `agent/orchestrator.js`** — import the helper and spread its flags into the spawned bot's env.
- **Create `agent/candidate-warmer-flags.test.mjs`** — `node:test` for the helper.
- **Modify `.env.example`** — document the new env vars.

---

## Task 1: Config — bar-cache settings

**Files:**
- Modify: `config/config.go`
- Test: `config/config_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `config/config_test.go`:

```go
func TestLoad_BarCache_Defaults(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "ops@example.com")
	t.Setenv("BAR_CACHE_ENABLED", "")
	t.Setenv("BAR_CACHE_DIR", "")
	t.Setenv("BAR_CACHE_TTL", "")
	_ = Load()
	if !AppConfig.BarCacheEnabled {
		t.Error("BarCacheEnabled should default to true")
	}
	if AppConfig.BarCacheDir != "./data/bar-cache" {
		t.Errorf("BarCacheDir default: got %q, want ./data/bar-cache", AppConfig.BarCacheDir)
	}
	if AppConfig.BarCacheTTL != 5*time.Minute {
		t.Errorf("BarCacheTTL default: got %v, want 5m", AppConfig.BarCacheTTL)
	}
}

func TestLoad_BarCache_Overrides(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "ops@example.com")
	t.Setenv("BAR_CACHE_ENABLED", "false")
	t.Setenv("BAR_CACHE_DIR", "/tmp/bc")
	t.Setenv("BAR_CACHE_TTL", "90s")
	_ = Load()
	if AppConfig.BarCacheEnabled {
		t.Error("BarCacheEnabled should be false when BAR_CACHE_ENABLED=false")
	}
	if AppConfig.BarCacheDir != "/tmp/bc" {
		t.Errorf("BarCacheDir override: got %q", AppConfig.BarCacheDir)
	}
	if AppConfig.BarCacheTTL != 90*time.Second {
		t.Errorf("BarCacheTTL override: got %v, want 90s", AppConfig.BarCacheTTL)
	}
}

func TestLoad_BarCacheTTL_BadValueFallsBackToDefault(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "ops@example.com")
	t.Setenv("BAR_CACHE_TTL", "not-a-duration")
	_ = Load()
	if AppConfig.BarCacheTTL != 5*time.Minute {
		t.Errorf("bad BAR_CACHE_TTL must fall back to 5m, got %v", AppConfig.BarCacheTTL)
	}
}
```

If `config/config_test.go` does not already import `time`, add it to that file's import block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./config/ -run BarCache -v`
Expected: FAIL — `AppConfig.BarCacheEnabled undefined` (and the other two fields).

- [ ] **Step 3: Add the config fields + helper**

In `config/config.go`, add `"time"` to the import block:

```go
import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)
```

Add to the `Config` struct (after the `AlpacaDataRatePerMin int` block):

```go
	// Shared daily-bar cache (cross-agent on-disk read cache for >=1Day bars).
	// Default ON — a pure, soft-failing read optimization. See
	// docs/superpowers/specs/2026-05-22-shared-daily-bar-cache-design.md.
	BarCacheEnabled bool
	BarCacheDir     string
	BarCacheTTL     time.Duration
```

Add to the `AppConfig = &Config{...}` literal (after the `AlpacaDataRatePerMin:` line):

```go
		BarCacheEnabled: getEnvOrDefault("BAR_CACHE_ENABLED", "true") == "true",
		BarCacheDir:     getEnvOrDefault("BAR_CACHE_DIR", "./data/bar-cache"),
		BarCacheTTL:     parseDurationOrDefault("BAR_CACHE_TTL", "5m"),
```

Add the helper near `parseIntOrDefault`:

```go
// parseDurationOrDefault reads a Go duration string (e.g. "5m", "90s") from key,
// falling back to def (which must itself parse) on absence or a parse error.
func parseDurationOrDefault(key, def string) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	d, _ := time.ParseDuration(def)
	return d
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./config/ -run BarCache -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add config/config.go config/config_test.go
git commit -m "Add BarCache config (enabled/dir/ttl)"
```

---

## Task 2: SharedBarCache scaffolding (interface + decorator + forwarding)

Build a drop-in decorator that satisfies every consumer interface and currently just forwards. Caching is layered on in Tasks 3–4.

**Files:**
- Create: `services/shared_bar_cache.go`
- Test: `services/shared_bar_cache_test.go`

- [ ] **Step 1: Write the failing test**

Create `services/shared_bar_cache_test.go`:

```go
package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// fakeCacheSource is a call-counting MarketDataProvider for the cache tests.
// Unique name within the services test package (no collision with the existing
// stubDataService / fakeBarFetcher / fakeMultiBarsFetcher stubs).
type fakeCacheSource struct {
	histCalls  int
	multiCalls int
	// bars maps symbol -> bars returned for any historical/multi request.
	bars     map[string][]*interfaces.Bar
	multiErr error
	histErr  error
}

func (f *fakeCacheSource) GetHistoricalBars(_ context.Context, symbol string, _, _ time.Time, _ string) ([]*interfaces.Bar, error) {
	f.histCalls++
	if f.histErr != nil {
		return nil, f.histErr
	}
	return f.bars[symbol], nil
}

func (f *fakeCacheSource) GetMultiBars(_ context.Context, symbols []string, _, _ time.Time, _ string) (map[string][]*interfaces.Bar, error) {
	f.multiCalls++
	if f.multiErr != nil {
		return nil, f.multiErr
	}
	out := make(map[string][]*interfaces.Bar, len(symbols))
	for _, s := range symbols {
		if b, ok := f.bars[s]; ok {
			out[s] = b
		}
	}
	return out, nil
}

func (f *fakeCacheSource) GetLatestBar(_ context.Context, symbol string) (*interfaces.Bar, error) {
	return &interfaces.Bar{Symbol: symbol, Close: 1}, nil
}
func (f *fakeCacheSource) GetLatestQuote(_ context.Context, symbol string) (*interfaces.Quote, error) {
	return &interfaces.Quote{Symbol: symbol, BidPrice: 1}, nil
}
func (f *fakeCacheSource) GetLatestTrade(_ context.Context, symbol string) (*interfaces.Trade, error) {
	return &interfaces.Trade{Symbol: symbol, Price: 1}, nil
}
func (f *fakeCacheSource) StreamBars(_ context.Context, _ []string) (<-chan *interfaces.Bar, error) {
	ch := make(chan *interfaces.Bar)
	close(ch)
	return ch, nil
}

// newTestCache builds a SharedBarCache over a fake, in a temp dir, with a fixed clock.
func newTestCache(t *testing.T, src *fakeCacheSource, now time.Time) *SharedBarCache {
	t.Helper()
	c := NewSharedBarCache(src, t.TempDir(), 5*time.Minute, nil)
	c.clock = func() time.Time { return now }
	return c
}

func TestSharedBarCache_SatisfiesInterfaces(t *testing.T) {
	var _ interfaces.DataService = (*SharedBarCache)(nil)
	var _ MarketDataProvider = (*SharedBarCache)(nil)
}

func TestSharedBarCache_ForwardsLatest(t *testing.T) {
	src := &fakeCacheSource{}
	c := newTestCache(t, src, time.Now())
	if q, err := c.GetLatestQuote(context.Background(), "SPY"); err != nil || q == nil || q.Symbol != "SPY" {
		t.Fatalf("GetLatestQuote should forward, got %+v err=%v", q, err)
	}
	if b, err := c.GetLatestBar(context.Background(), "SPY"); err != nil || b == nil {
		t.Fatalf("GetLatestBar should forward, got %+v err=%v", b, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestSharedBarCache -v`
Expected: FAIL — `undefined: NewSharedBarCache`, `undefined: SharedBarCache`, `undefined: MarketDataProvider`.

- [ ] **Step 3: Write the scaffolding implementation**

Create `services/shared_bar_cache.go`:

```go
package services

import (
	"context"
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

// --- cached in Tasks 3 & 4; pass-through for now ---

func (c *SharedBarCache) GetHistoricalBars(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, error) {
	return c.underlying.GetHistoricalBars(ctx, symbol, start, end, timeframe)
}

func (c *SharedBarCache) GetMultiBars(ctx context.Context, symbols []string, start, end time.Time, timeframe string) (map[string][]*interfaces.Bar, error) {
	return c.underlying.GetMultiBars(ctx, symbols, start, end, timeframe)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestSharedBarCache -v`
Expected: PASS (`SatisfiesInterfaces`, `ForwardsLatest`).

- [ ] **Step 5: Commit**

```bash
git add services/shared_bar_cache.go services/shared_bar_cache_test.go
git commit -m "Add SharedBarCache decorator scaffolding (forwarding + interface)"
```

---

## Task 3: Cache GetHistoricalBars (key, file IO, TTL, soft-fail)

**Files:**
- Modify: `services/shared_bar_cache.go`
- Test: `services/shared_bar_cache_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `services/shared_bar_cache_test.go`:

```go
func barsFor(sym string, n int) []*interfaces.Bar {
	out := make([]*interfaces.Bar, n)
	for i := range out {
		out[i] = &interfaces.Bar{Symbol: sym, Close: float64(i + 1)}
	}
	return out
}

func TestSharedBarCache_HistoricalHit(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)

	start := now.AddDate(0, 0, -30)
	for i := 0; i < 2; i++ {
		got, err := c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
		if err != nil || len(got) != 3 {
			t.Fatalf("call %d: got %d bars err=%v", i, len(got), err)
		}
	}
	if src.histCalls != 1 {
		t.Errorf("second identical call must hit cache: underlying called %d times, want 1", src.histCalls)
	}
}

func TestSharedBarCache_HistoricalTTLExpiry(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	c.clock = func() time.Time { return now.Add(6 * time.Minute) } // past 5m ttl
	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")

	if src.histCalls != 2 {
		t.Errorf("expired entry must refetch: underlying called %d times, want 2", src.histCalls)
	}
}

func TestSharedBarCache_SubDailyBypass(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Now()
	c := newTestCache(t, src, now)
	start := now.Add(-2 * time.Hour)

	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "5Min")
	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "5Min")

	if src.histCalls != 2 {
		t.Errorf("sub-daily must bypass cache: underlying called %d times, want 2", src.histCalls)
	}
	if files, _ := os.ReadDir(c.dir); len(files) != 0 {
		t.Errorf("sub-daily must not write cache files, found %d", len(files))
	}
}

func TestSharedBarCache_DateNormalization(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 5, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	// Same ET date, end a few minutes later & sub-second different -> same key.
	end2 := now.Add(4 * time.Minute)
	c.clock = func() time.Time { return end2 }
	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start.Add(time.Second), end2, "1Day")

	if src.histCalls != 1 {
		t.Errorf("same ET-date window must map to one key: underlying called %d times, want 1", src.histCalls)
	}
}

func TestSharedBarCache_CorruptFileSoftFails(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	// Prime, then corrupt the single cache file.
	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	files, _ := os.ReadDir(c.dir)
	if len(files) != 1 {
		t.Fatalf("expected 1 cache file, got %d", len(files))
	}
	if err := os.WriteFile(filepath.Join(c.dir, files[0].Name()), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	if err != nil || len(got) != 3 {
		t.Fatalf("corrupt file must soft-fail to a fetch: got %d bars err=%v", len(got), err)
	}
	if src.histCalls != 2 {
		t.Errorf("corrupt file must trigger a refetch: underlying called %d times, want 2", src.histCalls)
	}
}

func TestSharedBarCache_EmptyResultNotCached(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{}} // "ZZZZ" returns nil bars
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	_, _ = c.GetHistoricalBars(context.Background(), "ZZZZ", start, now, "1Day")
	_, _ = c.GetHistoricalBars(context.Background(), "ZZZZ", start, now, "1Day")
	if src.histCalls != 2 {
		t.Errorf("empty result must not be cached: underlying called %d times, want 2", src.histCalls)
	}
}
```

These new tests use `os` and `path/filepath`. Update the test file's import block (added in Task 2) to:

```go
import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"prophet-trader/interfaces"
)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./services/ -run TestSharedBarCache -v`
Expected: FAIL — hit/expiry/normalization/empty assertions fail because `GetHistoricalBars` still passes through (underlying called twice; no files written).

- [ ] **Step 3: Implement caching in GetHistoricalBars**

In `services/shared_bar_cache.go`, extend the import block:

```go
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
```

Add the cache-entry type and helpers (anywhere below the struct):

```go
// cachedBars is the on-disk payload. WrittenAt drives freshness (see plan note);
// the key fields are stored for debuggability when inspecting the file.
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
// location (see candidate_cache_warmer.go).
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
		return nil, false // not-exist or unreadable -> miss
	}
	var p cachedBars
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, false // corrupt -> miss
	}
	if c.clock().Sub(p.WrittenAt) >= c.ttl {
		return nil, false // stale -> miss
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
```

Replace the pass-through `GetHistoricalBars` body with:

```go
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./services/ -run TestSharedBarCache -v`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add services/shared_bar_cache.go services/shared_bar_cache_test.go
git commit -m "Cache GetHistoricalBars (date-keyed, ttl, atomic write, soft-fail)"
```

---

## Task 4: Cache GetMultiBars (per-symbol decomposition) + rename soft-fail

**Files:**
- Modify: `services/shared_bar_cache.go`
- Test: `services/shared_bar_cache_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `services/shared_bar_cache_test.go`:

```go
func TestSharedBarCache_MultiPartialHit(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{
		"AAA": barsFor("AAA", 2), "BBB": barsFor("BBB", 2), "CCC": barsFor("CCC", 2),
	}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	// Prime AAA and BBB via single-symbol fetches.
	_, _ = c.GetHistoricalBars(context.Background(), "AAA", start, now, "1Day")
	_, _ = c.GetHistoricalBars(context.Background(), "BBB", start, now, "1Day")
	if src.histCalls != 2 {
		t.Fatalf("setup: histCalls=%d want 2", src.histCalls)
	}

	out, err := c.GetMultiBars(context.Background(), []string{"AAA", "BBB", "CCC"}, start, now, "1Day")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 3 || len(out["AAA"]) != 2 || len(out["CCC"]) != 2 {
		t.Fatalf("merged result wrong: %v", out)
	}
	if src.multiCalls != 1 {
		t.Errorf("must batch-fetch the misses exactly once, got %d", src.multiCalls)
	}

	// CCC is now cached too: a second multi-call needs zero upstream calls.
	src.multiCalls = 0
	_, _ = c.GetMultiBars(context.Background(), []string{"AAA", "BBB", "CCC"}, start, now, "1Day")
	if src.multiCalls != 0 {
		t.Errorf("fully-warm multi-call must issue no upstream call, got %d", src.multiCalls)
	}
}

func TestSharedBarCache_MultiSubDailyBypass(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"AAA": barsFor("AAA", 2)}}
	now := time.Now()
	c := newTestCache(t, src, now)
	_, _ = c.GetMultiBars(context.Background(), []string{"AAA"}, now.Add(-2*time.Hour), now, "5Min")
	_, _ = c.GetMultiBars(context.Background(), []string{"AAA"}, now.Add(-2*time.Hour), now, "5Min")
	if src.multiCalls != 2 {
		t.Errorf("sub-daily multi must bypass cache, got %d want 2", src.multiCalls)
	}
}

func TestSharedBarCache_RenameFailureSoftFails(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	// Point the cache at a path that is a FILE, not a dir, so os.CreateTemp in
	// the "dir" fails on every write — exercising the write/rename soft-fail path.
	badDir := filepath.Join(t.TempDir(), "iam-a-file")
	if err := os.WriteFile(badDir, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := NewSharedBarCache(src, badDir, 5*time.Minute, nil)
	c.clock = func() time.Time { return now }

	start := now.AddDate(0, 0, -30)
	got, err := c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	if err != nil || len(got) != 3 {
		t.Fatalf("write failure must soft-fail and still return bars: got %d err=%v", len(got), err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./services/ -run TestSharedBarCache_Multi -v`
Expected: FAIL — `MultiPartialHit` fails (pass-through `GetMultiBars` issues a single batched call but caches nothing, so the warm re-call still calls upstream and partial-hit count is wrong).

- [ ] **Step 3: Implement caching in GetMultiBars**

Replace the pass-through `GetMultiBars` body in `services/shared_bar_cache.go` with:

```go
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./services/ -run TestSharedBarCache -v`
Expected: PASS (all cache tests, including multi + rename soft-fail).

Then the full services suite (regression — existing data-service tests must still pass):
Run: `go test ./services/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/shared_bar_cache.go services/shared_bar_cache_test.go
git commit -m "Cache GetMultiBars via per-symbol decomposition"
```

---

## Task 5: Wire the cache into main.go

**Files:**
- Modify: `cmd/bot/main.go`

No new unit test — this is composition wiring, verified by `go build` + the full suite. (Mirrors how the prior options-chain plan verified its `main.go` limiter wiring by reading + building.)

- [ ] **Step 1: Add the `path/filepath` import**

In `cmd/bot/main.go`, add `"path/filepath"` to the import block (alongside `"os"`).

- [ ] **Step 2: Replace the data-service construction block**

Find (around lines 72–77):

```go
	// Create data service
	dataService := services.NewAlpacaDataService(
		cfg.AlpacaAPIKey,
		cfg.AlpacaSecretKey,
	)
	dataService.SetRateLimiter(alpacaDataLimiter)
```

Replace with:

```go
	// Create the raw Alpaca data service + shared rate limiter, then wrap it in
	// the cross-agent shared bar cache. Every non-intraday consumer reads through
	// `dataService` (now a MarketDataProvider); the intraday service constructed
	// later is built separately and never wrapped (latency isolation, 1ec6b6a).
	rawDataService := services.NewAlpacaDataService(
		cfg.AlpacaAPIKey,
		cfg.AlpacaSecretKey,
	)
	rawDataService.SetRateLimiter(alpacaDataLimiter)

	var dataService services.MarketDataProvider = rawDataService
	if cfg.BarCacheEnabled {
		absCacheDir, err := filepath.Abs(cfg.BarCacheDir)
		if err != nil {
			absCacheDir = cfg.BarCacheDir
		}
		if err := os.MkdirAll(absCacheDir, 0o755); err != nil {
			logger.WithError(err).Warn("bar cache dir create failed — running without cache this session")
		} else {
			dataService = services.NewSharedBarCache(rawDataService, absCacheDir, cfg.BarCacheTTL, logger)
			logger.WithFields(logrus.Fields{
				"bar_cache_dir": absCacheDir, // operators: confirm every bot logs the SAME absolute path
				"bar_cache_ttl": cfg.BarCacheTTL,
			}).Info("Shared bar cache enabled")
		}
	} else {
		logger.Info("Shared bar cache disabled (BAR_CACHE_ENABLED != true)")
	}
```

All existing `dataService` usages downstream are unchanged: every consumer takes an interface that `MarketDataProvider` satisfies. The intraday service (constructed via `services.NewIntradayAlpacaDataService`, ~line 480) is untouched.

- [ ] **Step 3: Build to verify the swap compiles**

Run: `go build ./...`
Expected: success. (A failure here means some site expected the concrete `*AlpacaDataService` — widen it to an interface; none are expected per the constructor audit.)

- [ ] **Step 4: Run the full Go suite**

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/bot/main.go
git commit -m "Wire shared bar cache into the data path (default on)"
```

---

## Task 6: Gate the candidate warmer to Coil/Drift

**Files:**
- Modify: `cmd/bot/main.go`
- Create: `agent/candidate-warmer-flags.js`
- Modify: `agent/orchestrator.js`
- Create: `agent/candidate-warmer-flags.test.mjs`

- [ ] **Step 1: Write the failing JS test**

Create `agent/candidate-warmer-flags.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateWarmerFlags } from './candidate-warmer-flags.js';

test('coil (mean-rev-rsi2) enables only the meanrev warmer', () => {
  assert.deepEqual(candidateWarmerFlags('mean-rev-rsi2'), {
    ENABLE_MEANREV_WARMER: 'true',
    ENABLE_DRIFT_WARMER: 'false',
  });
});

test('drift (earnings-drift) enables only the drift warmer', () => {
  assert.deepEqual(candidateWarmerFlags('earnings-drift'), {
    ENABLE_MEANREV_WARMER: 'false',
    ENABLE_DRIFT_WARMER: 'true',
  });
});

test('every other strategy (and undefined) enables neither', () => {
  for (const sid of ['v2-options', 'trend', 'penny-momentum', undefined, null]) {
    assert.deepEqual(candidateWarmerFlags(sid), {
      ENABLE_MEANREV_WARMER: 'false',
      ENABLE_DRIFT_WARMER: 'false',
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test agent/candidate-warmer-flags.test.mjs`
Expected: FAIL — cannot find module `./candidate-warmer-flags.js`.

- [ ] **Step 3: Create the helper and wire it into the orchestrator**

Create `agent/candidate-warmer-flags.js`:

```js
// Candidate-cache warmer gating. The Go warmer (cmd/bot/main.go) is launched
// per-bot only for the cache that bot's agent actually reads: Coil
// (strategyId 'mean-rev-rsi2') reads /meanrev/candidates, Drift ('earnings-drift')
// reads /drift/candidates. Every other agent gets an explicit 'false' so it
// can't inherit a 'true' from the shared .env (same reasoning as the turtle flag).
export function candidateWarmerFlags(strategyId) {
  return {
    ENABLE_MEANREV_WARMER: strategyId === 'mean-rev-rsi2' ? 'true' : 'false',
    ENABLE_DRIFT_WARMER: strategyId === 'earnings-drift' ? 'true' : 'false',
  };
}
```

In `agent/orchestrator.js`, add the import near the top (with the other local imports, e.g. after `import { AgentHarness } from './harness.js';`):

```js
import { candidateWarmerFlags } from './candidate-warmer-flags.js';
```

In `startGoBackend`, spread the flags into the `env` object — change the tail of the literal (after the `TURTLE_SCHEDULER_ENABLED` line) to:

```js
      TURTLE_SCHEDULER_ENABLED: turtleSchedulerEnabled ? 'true' : 'false',
      ...candidateWarmerFlags(resolvedAgent?.strategyId),
    };
```

- [ ] **Step 4: Run the JS test to verify it passes**

Run: `node --test agent/candidate-warmer-flags.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Gate the warmer launch in main.go**

In `cmd/bot/main.go`, find (around lines 519–524):

```go
	// Keep the Coil/Drift candidate caches hot during their weekday ET beat
	// windows. Both agents beat once or twice a day — far apart relative to the
	// 5-min cache TTL — so without warming, every beat's preflight triggers a
	// cold full-universe scan that exceeds the 2s budget and fails open. The
	// warmer recomputes on a sub-TTL interval so the beat-time read is a hot hit.
	go services.RunCandidateCacheWarmer(ctx, services.CandidateCacheWarmInterval, logger, meanRevCandidatesSvc, driftCandidatesSvc)
```

Replace with:

```go
	// Keep the Coil/Drift candidate caches hot during their weekday ET beat
	// windows, but gate per-agent: only the bot whose agent reads a cache warms
	// it (Coil→meanrev, Drift→drift), set via ENABLE_MEANREV_WARMER /
	// ENABLE_DRIFT_WARMER by the orchestrator. The other four bots previously
	// warmed caches nothing reads — the dominant source of redundant cross-agent
	// daily-bar fetches. Gating only ever degrades to a slower on-demand cold
	// scan (fail-open), never to wrong/empty candidates.
	var candidateWarmers []services.CandidateRefresher
	if os.Getenv("ENABLE_MEANREV_WARMER") == "true" {
		candidateWarmers = append(candidateWarmers, meanRevCandidatesSvc)
	}
	if os.Getenv("ENABLE_DRIFT_WARMER") == "true" {
		candidateWarmers = append(candidateWarmers, driftCandidatesSvc)
	}
	if len(candidateWarmers) > 0 {
		go services.RunCandidateCacheWarmer(ctx, services.CandidateCacheWarmInterval, logger, candidateWarmers...)
		logger.WithField("warmers", len(candidateWarmers)).Info("Candidate cache warmer started")
	} else {
		logger.Info("Candidate cache warmer disabled (no ENABLE_MEANREV_WARMER/ENABLE_DRIFT_WARMER)")
	}
```

- [ ] **Step 6: Build + full Go suite**

Run: `go build ./... && go test ./...`
Expected: PASS. (`RunCandidateCacheWarmer` already returns early on an empty refresher slice, so the gated launch is safe.)

- [ ] **Step 7: Commit**

```bash
git add cmd/bot/main.go agent/candidate-warmer-flags.js agent/orchestrator.js agent/candidate-warmer-flags.test.mjs
git commit -m "Gate candidate warmer to consuming agents (Coil/Drift)"
```

---

## Task 7: Document env vars + final integration check

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document the new env vars**

In `.env.example`, near the existing `ALPACA_DATA_RATE_PER_MIN=180` line, add:

```bash
# Shared cross-agent daily-bar cache (>=1Day bars only). Default on; it is a
# soft-failing read optimization. Dir must resolve to the SAME absolute path for
# every bot (they share cwd); the bot logs the resolved absolute path at startup.
BAR_CACHE_ENABLED=true
BAR_CACHE_DIR=./data/bar-cache
BAR_CACHE_TTL=5m

# Candidate-cache warmer gating. Set automatically per-agent by the orchestrator
# from strategyId (Coil -> meanrev, Drift -> drift); listed here for reference.
# Do not set these to true globally — that would re-enable the redundant sweeps.
# ENABLE_MEANREV_WARMER=false
# ENABLE_DRIFT_WARMER=false
```

- [ ] **Step 2: Full integration check (Go + JS)**

Run: `go build ./... && go test ./... && node --test agent/**/*.test.mjs`
Expected: PASS across Go and the Node test suite.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "Document bar-cache + warmer-gating env vars"
```

---

## Self-review

**Spec coverage (rev. 2):**
- §3 / §4.1 decorator over shared service, intraday untouched → Tasks 2, 5. ✔
- §4.2 daily+ cached, sub-daily bypass → Task 3 (`isCacheableTF`) + tests in 3 & 4. ✔
- §4.3 ET-date-normalized key → Task 3 (`dateKey`) + `DateNormalization` test. ✔
- §4.4 per-symbol entries, GetMultiBars decomposition, no-data not cached → Task 4 + `MultiPartialHit` / Task 3 `EmptyResultNotCached`. ✔
- §4.5 file-per-key, atomic temp+rename, rename/IO soft-fail, absolute+logged dir → Task 3 (`writeEntry`), Task 4 (`RenameFailureSoftFails`), Task 5 (abs path + startup log). ✔
- §4.6 single 5-min TTL via WrittenAt → Task 1 (config) + Task 3 (`readEntry`, `TTLExpiry`). ✔ (mtime→WrittenAt refinement noted in header.)
- §4.7 config (enabled/dir/ttl), default on, limiter untouched, wiring → Tasks 1, 5. ✔
- §4.8 warmer gating via two strategyId-driven flags, main.go slice, safety → Task 6 (+ JS test). ✔
- §5 test matrix (hit, expiry, sub-daily bypass, soft-fail read+rename, normalization, multi partial, forwarding, warmer gating) → Tasks 2–4, 6. ✔
- §6 constructor-signature audit (done: all interfaces) + filename sanitize (Task 3 `sanitize`) + warmer wiring verification (Task 6). ✔

**Placeholder scan:** none — no TBD/TODO; every code step shows complete code, and import-block updates are spelled out explicitly wherever new imports are introduced (Tasks 1, 3).

**Type consistency:** `MarketDataProvider`, `SharedBarCache`, `NewSharedBarCache(underlying, dir, ttl, logger)`, `cachedBars{Symbol,Timeframe,StartDate,EndDate,WrittenAt,Bars}`, `isCacheableTF`, `dateKey`, `sanitize`, `entryPath`, `readEntry`, `writeEntry`, `candidateWarmerFlags(strategyId)`, config `BarCacheEnabled/BarCacheDir/BarCacheTTL`, env `ENABLE_MEANREV_WARMER`/`ENABLE_DRIFT_WARMER` — names/signatures consistent across all tasks.
