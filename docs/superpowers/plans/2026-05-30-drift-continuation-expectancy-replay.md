# Drift Continuation Expectancy Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline Go CLI that replays Drift's exact deployed entry + exit rules over ~3 years of historical earnings gaps to measure continuation-entry expectancy (gross + friction-adjusted), a base-gates-only control comparison, and the extension_pct↔return relationship.

**Architecture:** Reuse the compiled rule verbatim — `ComputeDriftSignal` on point-in-time bar slices for entries, `computeDriftMA50` inside a new daily-bar `SimulateExit` for the full 4-leg exit. Pure, TDD'd units (`SimulateExit`, `findEntries`, friction loader, `Aggregate`) live in `services/drift_replay.go`; a thin `cmd/driftreplay` wires the real Alpaca+FMP services and writes a markdown + JSON report. No live behavior changes.

**Tech Stack:** Go (services/cmd layout, sirupsen/logrus), `go test`, FMP `/stable/earnings-calendar`, Alpaca daily bars via `SharedBarCache`, `config/friction.json`.

**Spec:** `docs/superpowers/specs/2026-05-30-drift-continuation-expectancy-replay-design.md`

---

## File Structure

**New:**
- `services/drift_replay.go` — `ExitConfig`, `ExitResult`, `SimulateExit`; `EntryResult`, `findEntries`; `StockFriction`, `LoadStockFriction`, `frictionHaircut`; `TradeOutcome`, `CohortSummary`, `ReplaySummary`, `Bucket`, `Coverage`, `summarizeCohort`, `spearman`, `olsSlope`, `bucketize`, `Aggregate`; `RunReplay`.
- `services/drift_replay_test.go` — TDD for all of the above (reuses `makeDriftBars`/`driftBarRow`/`buildContinuationBars`/`stubDriftBarFetcherSvc`/`stubRecentReporterFetcher` from `drift_signal_service_test.go`, same package).
- `cmd/driftreplay/main.go` — CLI flags, service wiring, report writing.

**Modified:**
- `services/penny_earnings_service.go` — extract `FetchReportsInRange`; `FetchRecentReports` delegates.

All new Go lives in `package services` (drift_replay.go) so it can call the unexported `computeDriftMA50`, `roundTo2`, `findBarIndexByDate`, `ComputeDriftSignal`, `DriftUniverse`.

---

## Task 1: Refactor `FetchReportsInRange` out of `FetchRecentReports`

**Files:**
- Modify: `services/penny_earnings_service.go`
- Test: `services/penny_earnings_service_test.go`

- [ ] **Step 1: Write the failing test**

Append to `services/penny_earnings_service_test.go`:

```go
func TestFetchReportsInRange_ParsesExplicitWindow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/stable/earnings-calendar") {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("from"); got != "2023-01-01" {
			t.Errorf("from = %q, want 2023-01-01", got)
		}
		if got := r.URL.Query().Get("to"); got != "2023-01-31" {
			t.Errorf("to = %q, want 2023-01-31", got)
		}
		w.Write([]byte(`[{"symbol":"AAPL","date":"2023-01-15","time":"amc"},{"symbol":"MSFT","date":"2023-01-20","time":"bmo"}]`))
	}))
	defer srv.Close()

	s := NewEarningsCalendarService("k", "ak", "sk", "https://paper-api.alpaca.markets", srv.Client())
	s.fmpBaseURL = srv.URL

	from := time.Date(2023, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2023, 1, 31, 0, 0, 0, 0, time.UTC)
	out, err := s.FetchReportsInRange(context.Background(), from, to)
	if err != nil {
		t.Fatalf("FetchReportsInRange: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("got %d reports, want 2: %+v", len(out), out)
	}
	if out[0].Ticker != "AAPL" || out[0].Timing != "amc" {
		t.Errorf("report[0] = %+v, want AAPL/amc", out[0])
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestFetchReportsInRange_ParsesExplicitWindow`
Expected: FAIL — `s.FetchReportsInRange undefined`.

- [ ] **Step 3: Extract the method**

In `services/penny_earnings_service.go`, replace the body of `FetchRecentReports` (the function starting `func (s *EarningsCalendarService) FetchRecentReports(ctx context.Context, now time.Time, days int)`) with a delegating version, and add the new `FetchReportsInRange` holding the moved fetch/parse logic:

```go
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
```

Note: `FetchRecentReports` previously clamped to `<= today`; with an explicit-range method the clamp becomes the `to` bound (`nowET`), preserving behavior.

- [ ] **Step 4: Run the new test + the existing recent-reports tests**

Run: `go test ./services/ -run "TestFetchReportsInRange|TestFetchRecentReports" -v`
Expected: all PASS (existing `TestFetchRecentReports_ParsesPastWindow`, `_HandlesUpstreamError`, `_ZeroDaysReturnsEmpty` unaffected).

- [ ] **Step 5: Commit**

```bash
git add services/penny_earnings_service.go services/penny_earnings_service_test.go
git commit -m "refactor(earnings): extract FetchReportsInRange for arbitrary windows"
```

---

## Task 2: Friction loader + haircut

**Files:**
- Create: `services/drift_replay.go`
- Test: `services/drift_replay_test.go`

- [ ] **Step 1: Write the failing tests**

Create `services/drift_replay_test.go`:

```go
package services

import (
	"context"
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run "TestLoadStockFriction|TestFrictionHaircut"`
Expected: FAIL — `LoadStockFriction` / `StockFriction` / `frictionHaircut` undefined.

- [ ] **Step 3: Implement the loader + haircut**

Create `services/drift_replay.go`:

```go
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
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./services/ -run "TestLoadStockFriction|TestFrictionHaircut" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/drift_replay.go services/drift_replay_test.go
git commit -m "feat(driftreplay): friction loader + per-share haircut"
```

---

## Task 3: `SimulateExit` — the full 4-leg daily-bar exit

**Files:**
- Modify: `services/drift_replay.go`
- Test: `services/drift_replay_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `services/drift_replay_test.go`. Helper builds a flat lead-in (so `computeDriftMA50` is valid) then caller-supplied forward rows:

```go
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
	// entry 100; day+1 high 121 (>= target 120), low 99 (> stop 90), open 100.
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1},   // entry bar (open=100)
		{Open: 100, High: 121, Low: 99, Close: 120, Vol: 1},    // target touched
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
		{Open: 100, High: 101, Low: 89, Close: 95, Vol: 1}, // low 89 <= stop 90
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "stop" || r.ExitPrice != 90 {
		t.Fatalf("got %+v, want stop@90", r)
	}
}

func TestSimulateExit_BothTouched_StopFirst(t *testing.T) {
	// stop < open < target, but Low<=stop AND High>=target same day → stop-first.
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
	// Bar opens above target (125 >= 120) AND low pierces stop (88). Must be
	// target_gap at the open — a limit sell fills at the open before any stop.
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
		{Open: 85, High: 86, Low: 84, Close: 85, Vol: 1}, // opens below stop 90
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "stop_gap" || r.ExitPrice != 85 {
		t.Fatalf("got %+v, want stop_gap@85", r)
	}
}

func TestSimulateExit_TimeStop60TradingDays(t *testing.T) {
	// 62 flat forward bars at 100 (no bracket, MA50 flat → above_ma true).
	fwd := make([]driftBarRow, 62)
	for i := range fwd {
		fwd[i] = driftBarRow{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1}
	}
	bars, e := replayBars(t, 60, 100, fwd)
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "time" {
		t.Fatalf("got %+v, want time", r)
	}
	if r.HoldingDays != 61 { // exit fills at open[e+60+1]
		t.Errorf("HoldingDays = %d, want 61 (decided at e+60 close, filled e+61 open)", r.HoldingDays)
	}
}

func TestSimulateExit_MA50Break(t *testing.T) {
	// 60 flat lead at 100, entry bar 100, then a bar closing 95 (< trailing 50-MA
	// ~99.9, > stop 90, < target 120) → ma50_break, fill at the NEXT bar's open.
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1}, // entry bar
		{Open: 96, High: 96, Low: 94, Close: 95, Vol: 1},     // close 95 below MA50 → break at close
		{Open: 95, High: 95, Low: 95, Close: 95, Vol: 1},     // fill bar (next open)
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
	// No exit and bars run out: data_end at last close.
	bars, e := replayBars(t, 60, 100, []driftBarRow{
		{Open: 100, High: 100, Low: 100, Close: 100, Vol: 1},
		{Open: 100, High: 105, Low: 99, Close: 103, Vol: 1}, // no bracket, then end
	})
	r := SimulateExit(bars, e, stdExitCfg)
	if r.Reason != "data_end" || r.ExitPrice != 103 {
		t.Fatalf("got %+v, want data_end@103", r)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./services/ -run TestSimulateExit`
Expected: FAIL — `SimulateExit` / `ExitConfig` / `ExitResult` undefined.

- [ ] **Step 3: Implement `SimulateExit`**

Append to `services/drift_replay.go`:

```go
// ExitConfig parameterizes the daily-bar exit simulation. Defaults mirror Drift:
// 10% stop / 20% target / 60-trading-day time stop. The MA50-break leg is always
// active (it has no parameter; it reuses computeDriftMA50).
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
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./services/ -run TestSimulateExit -v`
Expected: all eight PASS.

- [ ] **Step 5: Commit**

```bash
git add services/drift_replay.go services/drift_replay_test.go
git commit -m "feat(driftreplay): SimulateExit — full 4-leg daily-bar exit"
```

---

## Task 4: `findEntries` — deployed + control cohorts

**Files:**
- Modify: `services/drift_replay.go`
- Test: `services/drift_replay_test.go`

- [ ] **Step 1: Write the failing tests**

`buildContinuationBars` (in `drift_signal_service_test.go`) builds a grade-A/B, BMO gap +6%, MONITORING-stage series whose tail makes `is_continuation == true`; its earnings bar is at `len-5`. `buildGradeABars` builds a grade-A/B name with `is_continuation == false`. Append:

```go
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
	// Control enters on the first base-gates day, on or before the deployed entry.
	if ctrl.EntryIdx > dep.EntryIdx {
		t.Errorf("control EntryIdx %d after deployed %d", ctrl.EntryIdx, dep.EntryIdx)
	}
}

func TestFindEntries_ControlOnlyWhenNoContinuation(t *testing.T) {
	// Grade-A/B but is_continuation == false and MONITORING → control enters,
	// deployed does not.
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./services/ -run TestFindEntries`
Expected: FAIL — `findEntries` / `EntryResult` undefined.

- [ ] **Step 3: Implement `findEntries`**

Append to `services/drift_replay.go`:

```go
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
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./services/ -run TestFindEntries -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/drift_replay.go services/drift_replay_test.go
git commit -m "feat(driftreplay): findEntries — deployed + base-only control cohorts"
```

---

## Task 5: Aggregation — cohort stats, correlation, buckets

**Files:**
- Modify: `services/drift_replay.go`
- Test: `services/drift_replay_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `services/drift_replay_test.go`:

```go
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
	// edges [0,1) [1,2) [2,4) [4,7) [7+] → 5 buckets, two populated, rest zero.
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./services/ -run "TestSummarizeCohort|TestSpearman|TestOLSSlope|TestBucketize|TestAggregate"`
Expected: FAIL — types/functions undefined.

- [ ] **Step 3: Implement the aggregation**

Append to `services/drift_replay.go`:

```go
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
	Deployed             CohortReport `json:"deployed"`
	Control              CohortReport `json:"control"`
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
	return r
}
```

- [ ] **Step 4: Run to verify pass**

Run: `go test ./services/ -run "TestSummarizeCohort|TestSpearman|TestOLSSlope|TestBucketize|TestAggregate" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/drift_replay.go services/drift_replay_test.go
git commit -m "feat(driftreplay): aggregation — cohort stats, spearman/slope, buckets"
```

---

## Task 6: `RunReplay` engine (fetch → entries → exits → outcomes)

**Files:**
- Modify: `services/drift_replay.go`
- Test: `services/drift_replay_test.go`

- [ ] **Step 1: Write the failing test (stub-driven, mirrors candidate-service tests)**

`stubDriftBarFetcherSvc{bars: map[string][]*interfaces.Bar}` and `stubRecentReporterFetcher{reports: []RecentReport}` already exist in `drift_signal_service_test.go`. The engine takes the same `RecentReporterFetcher` interface and a `BarFetcher`. Append:

```go
// stubRangeReporter satisfies RangeReporterFetcher (the existing
// stubRecentReporterFetcher only implements FetchRecentReports).
type stubRangeReporter struct{ reports []RecentReport }

func (s *stubRangeReporter) FetchReportsInRange(ctx context.Context, from, to time.Time) ([]RecentReport, error) {
	return s.reports, nil
}

func TestRunReplay_ProducesCohortOutcomes(t *testing.T) {
	cont := buildContinuationBars("CONT")
	edate := cont[len(cont)-5].Timestamp // earnings bar timestamp
	// buildContinuationBars returns 220 bars with a rising tail, so the entry has
	// forward bars for the exit sim (likely exits data_end within the short tail).
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestRunReplay`
Expected: FAIL — `RunReplay` / `Coverage` undefined.

- [ ] **Step 3: Implement `RunReplay`**

Append to `services/drift_replay.go`. `BarFetcher` is the existing services interface with `GetHistoricalBars`; `RecentReporterFetcher` is the existing interface with `FetchRecentReports` — add `FetchReportsInRange` is on the concrete `*EarningsCalendarService`, so the engine takes a narrower fetcher interface:

```go
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
	TimingFill       map[string]int `json:"timing_fill"` // bmo|amc|"" → count
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

	// Group in-universe events by symbol, tracking the min/max event dates.
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
		cov.TimingFill[r.Timing]++
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
			dep, ctrl := findEntries(sym, bars, edate, e.timing, driftReplayWindowCalDays)
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
```

- [ ] **Step 4: Run the new test + the full drift suite**

Run: `go test ./services/ -run "TestRunReplay|TestSimulateExit|TestFindEntries|TestAggregate|TestSummarizeCohort|TestLoadStockFriction|TestFrictionHaircut" -v`
Expected: all PASS.

- [ ] **Step 5: Full services regression**

Run: `go test ./services/ -count=1`
Expected: PASS (no regressions; existing drift/meanrev/earnings tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add services/drift_replay.go services/drift_replay_test.go
git commit -m "feat(driftreplay): RunReplay engine over universe earnings history"
```

---

## Task 7: `cmd/driftreplay` CLI + report writing + verification

**Files:**
- Create: `cmd/driftreplay/main.go`

No automated test — thin wiring + report formatting, verified by one real offline run. Mirrors `cmd/bot/main.go:56-92,289` for service construction.

- [ ] **Step 1: Implement the CLI**

Create `cmd/driftreplay/main.go`:

```go
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"prophet-trader/config"
	"prophet-trader/services"

	"github.com/sirupsen/logrus"
)

func main() {
	years := flag.Int("years", 3, "years of earnings history to replay")
	fromStr := flag.String("from", "", "explicit start YYYY-MM-DD (overrides --years)")
	toStr := flag.String("to", "", "explicit end YYYY-MM-DD (default: today)")
	outDir := flag.String("out", "data/reports", "output directory")
	frictionPath := flag.String("friction", "config/friction.json", "friction config path")
	flag.Parse()

	logger := logrus.New()
	if err := config.Load(); err != nil {
		logger.WithError(err).Fatal("config load")
	}
	cfg := config.AppConfig // package global populated by Load(); see cmd/bot/main.go:25-29

	var err error
	to := time.Now()
	if *toStr != "" {
		if to, err = time.Parse("2006-01-02", *toStr); err != nil {
			logger.WithError(err).Fatal("parse --to")
		}
	}
	from := to.AddDate(-*years, 0, 0)
	if *fromStr != "" {
		if from, err = time.Parse("2006-01-02", *fromStr); err != nil {
			logger.WithError(err).Fatal("parse --from")
		}
	}

	fr, err := services.LoadStockFriction(*frictionPath)
	if err != nil {
		logger.WithError(err).Fatal("load friction")
	}

	// Service wiring — mirrors cmd/bot/main.go.
	limiter := services.NewAlpacaDataRateLimiter(cfg.AlpacaDataRatePerMin, 10)
	raw := services.NewAlpacaDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey)
	raw.SetRateLimiter(limiter)
	cacheDir, _ := filepath.Abs("data/bar-cache")
	data := services.NewSharedBarCache(raw, cacheDir, cfg.BarCacheTTL, logger)
	earnings := services.NewEarningsCalendarService(cfg.FMPAPIKey, cfg.AlpacaAPIKey, cfg.AlpacaSecretKey, cfg.AlpacaBaseURL, nil)

	cfgExit := services.ExitConfig{StopPct: 0.10, TargetPct: 0.20, TimeStopDays: 60}
	ctx := context.Background()

	logger.WithFields(logrus.Fields{"from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"),
		"universe": len(services.DriftUniverse), "friction": fr.Version}).Info("driftreplay: starting")

	outcomes, cov := services.RunReplay(ctx, data, earnings, services.DriftUniverse, from, to, fr, cfgExit)
	summary := services.Aggregate(outcomes)

	rundate := time.Now().Format("2006-01-02")
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		logger.WithError(err).Fatal("mkdir out")
	}
	mdPath := filepath.Join(*outDir, "drift-continuation-replay-"+rundate+".md")
	jsonPath := filepath.Join(*outDir, "drift-continuation-replay-"+rundate+".json")

	md := renderMarkdown(from, to, fr, cov, summary, outcomes)
	if err := os.WriteFile(mdPath, []byte(md), 0o644); err != nil {
		logger.WithError(err).Fatal("write md")
	}
	sidecar := map[string]any{"from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"),
		"friction_version": fr.Version, "friction_hash": fr.Hash,
		"coverage": cov, "summary": summary, "outcomes": outcomes}
	jb, _ := json.MarshalIndent(sidecar, "", "  ")
	if err := os.WriteFile(jsonPath, jb, 0o644); err != nil {
		logger.WithError(err).Fatal("write json")
	}
	logger.WithFields(logrus.Fields{"md": mdPath, "json": jsonPath,
		"deployed": cov.DeployedEntries, "control": cov.ControlEntries}).Info("driftreplay: done")
}

func renderMarkdown(from, to time.Time, fr services.StockFriction, cov services.Coverage,
	s services.ReplaySummary, outcomes []services.TradeOutcome) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Drift Continuation Expectancy Replay\n\n")
	fmt.Fprintf(&b, "Window requested: %s → %s | actual: %s → %s | friction: %s (%s)\n\n",
		from.Format("2006-01-02"), to.Format("2006-01-02"), cov.ActualFrom, cov.ActualTo, fr.Version, fr.Hash)

	fmt.Fprintf(&b, "## Coverage\n\n")
	fmt.Fprintf(&b, "- events enumerated: %d | in-universe: %d | bars OK: %d\n", cov.EventsEnumerated, cov.InUniverse, cov.BarsOK)
	fmt.Fprintf(&b, "- deployed entries: %d | control entries: %d | non-entries: %d | pead entries: %d\n",
		cov.DeployedEntries, cov.ControlEntries, cov.NonEntries, cov.NPeadEntries)
	fmt.Fprintf(&b, "- timing fill: bmo=%d amc=%d unknown=%d\n", cov.TimingFill["bmo"], cov.TimingFill["amc"], cov.TimingFill[""])
	fmt.Fprintf(&b, "- entry price min/median/max: %.2f / %.2f / %.2f\n", cov.PriceMin, cov.PriceMedian, cov.PriceMax)
	fmt.Fprintf(&b, "- dropped: %v\n\n", cov.Dropped)

	writeCohort := func(name string, c services.CohortReport) {
		fmt.Fprintf(&b, "### %s\n\n", name)
		fmt.Fprintf(&b, "| basis | n | win%% | avg win%% | avg loss%% | PF | expectancy%% | avg hold |\n")
		fmt.Fprintf(&b, "|---|---|---|---|---|---|---|---|\n")
		for _, row := range []struct {
			label string
			cs    services.CohortSummary
		}{{"gross", c.Gross}, {"friction", c.Friction}} {
			fmt.Fprintf(&b, "| %s | %d | %.2f | %.2f | %.2f | %.2f | %.2f | %.1f |\n",
				row.label, row.cs.N, row.cs.WinRate, row.cs.AvgWinPct, row.cs.AvgLossPct,
				row.cs.ProfitFactor, row.cs.ExpectancyPct, row.cs.AvgHoldingDays)
		}
		fmt.Fprintf(&b, "\nexit reasons (gross): %v\n\n", c.Gross.ExitReasonCount)
	}
	fmt.Fprintf(&b, "## Expectancy\n\n")
	writeCohort("Deployed (continuation)", s.Deployed)
	writeCohort("Control (base gates only)", s.Control)
	fmt.Fprintf(&b, "**Marginal edge (deployed − control):** gross %.2f%% | friction %.2f%%\n\n",
		s.MarginalEdgeGrossPct, s.MarginalEdgeFricPct)

	fmt.Fprintf(&b, "## Anti-chase (extension_pct vs friction-adjusted return, deployed cohort)\n\n")
	fmt.Fprintf(&b, "- Spearman ρ = %.2f | OLS slope = %.2f (n=%d)\n", s.ExtSpearman, s.ExtOLSSlope, s.Deployed.Friction.N)
	fmt.Fprintf(&b, "- **Buckets are descriptive only — low-power at this n; do not read a cap from them alone.**\n\n")
	fmt.Fprintf(&b, "| ext bucket | n | mean ret%% | win rate | win CI |\n|---|---|---|---|---|\n")
	for _, bk := range s.Buckets {
		fmt.Fprintf(&b, "| %s | %d | %.2f | %.2f | [%.2f, %.2f] |\n",
			bk.Label, bk.N, bk.MeanReturn, bk.WinRate, bk.WinLoCI, bk.WinHiCI)
	}
	fmt.Fprintf(&b, "\n_Survivorship (current universe) biases up; daily-bar stop-first/next-open fills bias down; net unknown._\n")
	return b.String()
}
```

- [ ] **Step 2: Build everything + vet**

Run: `go build ./... && go vet ./services/ ./cmd/driftreplay/`
Expected: clean. (Config is loaded via `config.Load()` then `cfg := config.AppConfig`, exactly as `cmd/bot/main.go:25-29`; `AppConfig` is the package-global `Config` value.)

- [ ] **Step 3: One real offline run (the verification gate)**

Source the FMP key (it lives in project-root `.env`, not the shell — see `memory/fmp-api-key-location`) and run:

```bash
set -a; . ./.env; set +a
go run ./cmd/driftreplay --years 3
```

Expected: writes `data/reports/drift-continuation-replay-<today>.md` + `.json`. Open the `.md` and sanity-check:
- `bars OK` ≈ in-universe symbol count (≈80), `fetch`/`dropped` small.
- deployed `n` is tens, not 0; `n_pead_entries` likely 0 (confirms PEAD unreachability).
- exit-reason mix is plausible (a spread of target/stop/ma50_break/time, not 100% one bucket).
- pick one deployed outcome from the JSON and hand-verify its entry date is ≥1 day after its earnings date and `extension_pct` matches `(exit-bound math)` sanity.

Report the headline expectancy (gross + friction), marginal edge, and Spearman ρ to the operator. Do NOT change any rule or flag.

- [ ] **Step 4: Commit**

```bash
git add cmd/driftreplay/main.go
git commit -m "feat(driftreplay): CLI wiring + markdown/JSON report"
```

---

## Self-Review notes (spec coverage)

- Historical earnings enumeration (spec Component 1) → Task 1 (`FetchReportsInRange`) + Task 6 (universe filter, timing fill-rate).
- Per-symbol single bar fetch, adjusted, +120d (Component 2) → Task 6 (`RunReplay`, `GetHistoricalBars` window).
- Entry model + deployed/control cohorts + last-bar drop (Component 3) → Task 4 (`findEntries`).
- Full 4-leg exit, gap-priority, trading-day time stop, MA50-break via `computeDriftMA50`, next-open EOD fills (Component 4) → Task 3 (`SimulateExit`).
- Friction reuse + stop-only gap-through (Component 5) → Task 2 (`LoadStockFriction`, `frictionHaircut`).
- Aggregation: cohort stats, marginal edge, Spearman/slope, buckets+CI, price dist (Component 6) → Task 5 + Task 6 (Coverage).
- Lookahead guards → Task 4 (`bars[:d+1]`), Task 3 (`computeDriftMA50(bars[:i+1])`, next-open fills).
- Soft-fail/error handling → Task 6 (`Coverage.Dropped`, per-symbol/event skips).
- Report (md + JSON, UTF-8) → Task 7.
- Out of scope (tuning, PEAD replay, portfolio path, intraday, live tracking, guard impl) → not implemented, per spec.

**Type consistency check:** `ExitConfig`/`ExitResult` (Task 3) used unchanged in Task 6; `EntryResult.EntryIdx` (Task 4) feeds `SimulateExit(bars, EntryIdx, cfg)` (Task 6); `TradeOutcome`/`CohortReport`/`ReplaySummary` (Task 5) consumed by `renderMarkdown` (Task 7) with matching field names (`ExpectancyPct`, `ExitReasonCount`, `MarginalEdgeGrossPct`, `Buckets`); `RangeReporterFetcher.FetchReportsInRange` (Task 6) is satisfied by `*EarningsCalendarService` (Task 1). `BarFetcher` is the existing services interface (`GetHistoricalBars`), satisfied by `*SharedBarCache`.
