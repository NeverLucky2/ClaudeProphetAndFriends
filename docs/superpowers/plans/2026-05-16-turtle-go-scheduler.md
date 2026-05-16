# Turtle (TrendProphet) Go-Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read first:** `docs/superpowers/plans/2026-05-16-llm-token-savings-prerequisites.md`. It contains the verified `services/alpaca_trading.go` API surface (the trader interface below is built on `PlaceOrder` / `GetOrder` / `CancelOrder` — no `PlaceLimitOrder` / `PlaceMarketOrder` / `GetOrderStatus` shortcuts exist), strategy-rule loading (`TRADING_RULES_TREND.md` is authoritative), recommended execution sequence (this plan is **#4**, do this last), and the `Strategy: "trend"` attribution invariant for every order.

**Goal:** Replace the once-per-day TrendProphet LLM heartbeat with a Go scheduler that runs the full TRADING_RULES_TREND.md heartbeat sequence (steps 1-5) deterministically. The LLM is retained only for the quarterly `trend_parameter_review`.

**Architecture:** A new `TurtleScheduler` service runs as a background goroutine in `cmd/bot/main.go`, fires at 17:00 ET each weekday, and executes pre-loop checks → exits → entries → pending-fill reconciliation → heartbeat-summary log. A persisted `DBTrendLedger` table tracks open positions and metadata that the broker doesn't store (atr_at_entry, donchian_100_high_at_entry, cold_start_completed). Strategy attribution survives via the `strategy: "trend"` tag on every order. The TrendProphet agent (LLM) is left configured but its preflight predicate is updated to skip every beat when `TURTLE_SCHEDULER_ENABLED=true`.

**Tech Stack:** Go 1.21+, GORM, Alpaca trading API. Reuses existing `TrendSignalService` for signal computation and `TradeGuard` for buy-side guards.

---

## File Structure

- Create: `models/trend_models.go` — `DBTrendLedgerEntry` (one row per open trend position; closed entries persist for audit).
- Create: `services/turtle_scheduler.go` — top-level scheduler + tick.
- Create: `services/turtle_scheduler_test.go`.
- Create: `services/turtle_executor.go` — the per-tick heartbeat sequence (pure-ish; injectable deps).
- Create: `services/turtle_executor_test.go`.
- Create: `services/turtle_ledger.go` — DB CRUD wrappers around `DBTrendLedgerEntry`.
- Create: `services/turtle_ledger_test.go`.
- Modify: `database/storage.go` — register the new model for AutoMigrate.
- Modify: `cmd/bot/main.go` — construct + start the scheduler behind `TURTLE_SCHEDULER_ENABLED` env flag.
- Modify: `agent/preflight.js` — when the flag is on (surfaced via a new endpoint, see Task 5), trend preflight always returns `{skip: true, reason: "scheduler enabled"}`.
- Create: `controllers/turtle_controller.go` — small read-only endpoint `GET /api/v1/turtle/status` returning scheduler state + last-run summary.
- Modify: `cmd/bot/main.go` (router setup) — wire the controller.
- Modify: `TRADING_RULES_TREND.md` — annotate the heartbeat sequence as backend-executed.

---

## Task 0: Confirm dependencies and helpers

- [ ] **Step 1: Confirm the trading-service interface (already verified)**

Per the prereq doc, the real surface is:

- `PlaceOrder(ctx, *interfaces.Order) (*interfaces.OrderResult, error)` — single entry point for market + limit, with strategy attribution via `order.Strategy`.
- `GetOrder(ctx, orderID) (*interfaces.Order, error)` — returns the order including `.Status`, `.FilledQty`, `.FilledAvgPrice`.
- `CancelOrder(ctx, orderID) error`.
- `GetPositions(ctx) ([]*interfaces.Position, error)` — unfiltered; per-strategy attribution lives on the HTTP layer (`/api/v1/positions?strategy=trend`).
- `GetAccount(ctx) (*interfaces.Account, error)`.

The `turtleTrader` interface in Task 3 wraps this surface — no adapters needed beyond exposing it on a smaller interface for testability.

- [ ] **Step 2: Confirm TradeGuard usage**

`grep -n "guard.CheckBuy" services/ | head` — confirm the call style used by penny / managed positions so the scheduler can apply the same cross-agent guard.

- [ ] **Step 3: Confirm segment-PnL service surface**

`grep -n "GetSegmentPnL\|SegmentPnLService" services/segment_pnl_service.go controllers/segment_pnl_controller.go | head` — the scheduler needs `unrealized_pnl_percent` and `deployed_percent` for strategy = "trend".

---

## Task 1: Ledger model + CRUD

**Files:**
- Create: `models/trend_models.go`
- Create: `services/turtle_ledger.go`
- Create: `services/turtle_ledger_test.go`
- Modify: `database/storage.go` (AutoMigrate registration)

- [ ] **Step 1: Define the DB model**

`models/trend_models.go`:

```go
package models

import (
	"time"

	"gorm.io/gorm"
)

// DBTrendLedgerEntry mirrors the per-position metadata in TRADING_RULES_TREND.md
// "Persisted Ledger" section. One row per Turtle position; closed rows are
// retained for audit (Status flips to CLOSED instead of being deleted).
type DBTrendLedgerEntry struct {
	gorm.Model
	Ticker                  string    `gorm:"index"`
	EntryDate               time.Time
	EntryPrice              float64
	Shares                  int
	ATRAtEntry              float64
	InitialStop             float64
	Donchian100HighAtEntry  float64
	Strategy                string    // always "trend"
	Status                  string    `gorm:"index"` // pending_fill | open | closed
	EntryOrderID            string
	ExitOrderID             string
	ExitDate                *time.Time
	ExitPrice               float64
	ExitReason              string // trailing_stop | initial_hard_stop | manual | reconciliation
}

// DBTurtleSession tracks per-day run state: last_heartbeat_date,
// cold_start_completed, circuit_breaker_tripped. One row total; queried by
// hardcoded ID = "singleton".
type DBTurtleSession struct {
	gorm.Model
	SessionID              string `gorm:"uniqueIndex"`
	LastHeartbeatDate      string // ISO date (YYYY-MM-DD)
	ColdStartCompleted     bool
	CircuitBreakerTrippedDate string // ISO date; empty when not tripped
}

func (DBTrendLedgerEntry) TableName() string { return "trend_ledger_entries" }
func (DBTurtleSession) TableName() string    { return "turtle_session" }
```

- [ ] **Step 2: Register in AutoMigrate**

In `database/storage.go`, find the AutoMigrate call (search for `AutoMigrate(`) and add:

```go
&models.DBTrendLedgerEntry{},
&models.DBTurtleSession{},
```

- [ ] **Step 3: Write failing test for the ledger CRUD**

`services/turtle_ledger_test.go`:

```go
package services

import (
	"testing"
	"time"

	"prophet-trader/models"
)

func TestTurtleLedger_CreateListUpdate(t *testing.T) {
	store := newInMemTurtleStore(t)
	ledger := NewTurtleLedger(store)

	entry := &models.DBTrendLedgerEntry{
		Ticker:                  "TLT",
		EntryDate:               time.Date(2026, 5, 15, 0, 0, 0, 0, time.UTC),
		EntryPrice:              92.50,
		Shares:                  100,
		ATRAtEntry:              1.20,
		InitialStop:             92.50 - 2*1.20,
		Donchian100HighAtEntry:  92.10,
		Strategy:                "trend",
		Status:                  "pending_fill",
		EntryOrderID:            "ord-1",
	}
	if err := ledger.Save(entry); err != nil {
		t.Fatal(err)
	}
	open, err := ledger.ListOpen()
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 1 || open[0].Ticker != "TLT" {
		t.Fatalf("expected 1 TLT row, got %+v", open)
	}

	open[0].Status = "open"
	open[0].EntryPrice = 92.62 // actual fill
	if err := ledger.Save(open[0]); err != nil {
		t.Fatal(err)
	}
	again, _ := ledger.ListOpen()
	if again[0].Status != "open" || again[0].EntryPrice != 92.62 {
		t.Errorf("update did not persist: %+v", again[0])
	}
}
```

`newInMemTurtleStore` is a helper that returns an in-memory SQLite-backed `*database.LocalStorage`. Add (or reuse the existing equivalent — many of the harvest tests have this; `grep -n "InMemoryStorage\|newTestStore" services/ database/`).

- [ ] **Step 4: Run test to verify it fails**

```bash
go test ./services -run TestTurtleLedger -v
```

Expected: FAIL with `undefined: NewTurtleLedger`.

- [ ] **Step 5: Implement TurtleLedger**

`services/turtle_ledger.go`:

```go
package services

import (
	"prophet-trader/models"
)

type ledgerStore interface {
	SaveTrendLedgerEntry(e *models.DBTrendLedgerEntry) error
	ListOpenTrendLedgerEntries() ([]*models.DBTrendLedgerEntry, error)
	GetTrendLedgerEntryByID(id uint) (*models.DBTrendLedgerEntry, error)
	GetTurtleSession() (*models.DBTurtleSession, error)
	SaveTurtleSession(s *models.DBTurtleSession) error
}

type TurtleLedger struct {
	store ledgerStore
}

func NewTurtleLedger(store ledgerStore) *TurtleLedger {
	return &TurtleLedger{store: store}
}

func (l *TurtleLedger) Save(e *models.DBTrendLedgerEntry) error {
	return l.store.SaveTrendLedgerEntry(e)
}

func (l *TurtleLedger) ListOpen() ([]*models.DBTrendLedgerEntry, error) {
	return l.store.ListOpenTrendLedgerEntries()
}

func (l *TurtleLedger) Session() (*models.DBTurtleSession, error) {
	return l.store.GetTurtleSession()
}

func (l *TurtleLedger) SaveSession(s *models.DBTurtleSession) error {
	return l.store.SaveTurtleSession(s)
}
```

- [ ] **Step 6: Implement the storage methods**

In `database/storage.go`, add the four methods returned by the `ledgerStore` interface (use `s.db.Save(...)`, `s.db.Where("status IN ?", []string{"pending_fill", "open"}).Find(...)`, etc.). Singleton session uses `Where("session_id = ?", "singleton")` and creates on first save.

- [ ] **Step 7: Run tests**

```bash
go test ./services -run TestTurtleLedger -v
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add models/trend_models.go services/turtle_ledger.go services/turtle_ledger_test.go database/storage.go
git commit -m "feat(turtle): trend ledger model + CRUD"
```

---

## Task 2: Entry-eligibility evaluator (pure)

**Files:**
- Create: `services/turtle_executor.go` (start with pure helpers)
- Create: `services/turtle_executor_test.go`

Implement the pure entry-eligibility checks first — easy TDD, no I/O. The executor will glue these to the signal service and trading service in Task 3.

- [ ] **Step 1: Write failing tests for `evaluateEntry`**

`services/turtle_executor_test.go`:

```go
package services

import (
	"testing"
)

func TestEvaluateEntry_AllConditionsHold(t *testing.T) {
	sig := &TrendSignal{
		Ticker: "TLT", LastClose: 95.00, Donchian100High: 92.00,
		SMA200: 90.00, ATR20: 1.50, BarsCount: 300,
	}
	res := evaluateEntry(sig, false /* coldStart */)
	if !res.Eligible {
		t.Errorf("expected eligible, got reason=%q", res.Reason)
	}
}

func TestEvaluateEntry_FailsOnNotAboveDonchian(t *testing.T) {
	sig := &TrendSignal{LastClose: 91.50, Donchian100High: 92.00, SMA200: 90.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible || res.Reason == "" {
		t.Errorf("expected ineligible, got %+v", res)
	}
}

func TestEvaluateEntry_FailsOnBelowSMA200(t *testing.T) {
	sig := &TrendSignal{LastClose: 93.00, Donchian100High: 92.00, SMA200: 94.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("expected ineligible (below sma200), got eligible")
	}
}

func TestEvaluateEntry_FailsOnFlatATR(t *testing.T) {
	sig := &TrendSignal{LastClose: 100.00, Donchian100High: 99.00, SMA200: 95.00, ATR20: 0.30, BarsCount: 300}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("expected ineligible (ATR floor), got eligible")
	}
}

func TestEvaluateEntry_ColdStartProximityFilter(t *testing.T) {
	// Cold start: (donchian100High - lastClose) must be ≤ atr20
	// Far above: 100 close, 92 high → distance 8, ATR 1.5 → too far
	sig := &TrendSignal{LastClose: 100.00, Donchian100High: 92.00, SMA200: 90.00, ATR20: 1.50, BarsCount: 300}
	res := evaluateEntry(sig, true)
	if res.Eligible {
		t.Errorf("expected cold-start ineligibility (too far above breakout), got eligible")
	}
	// Close to high: 92.5 close, 92 high → distance 0.5, ATR 1.5 → eligible
	sig.LastClose = 92.50
	res = evaluateEntry(sig, true)
	if !res.Eligible {
		t.Errorf("expected cold-start eligibility within ATR proximity, got %q", res.Reason)
	}
}

func TestEvaluateEntry_FailsOnLowBarsCount(t *testing.T) {
	sig := &TrendSignal{LastClose: 95.00, Donchian100High: 92.00, SMA200: 90.00, ATR20: 1.50, BarsCount: 249}
	res := evaluateEntry(sig, false)
	if res.Eligible {
		t.Errorf("expected ineligible (insufficient bars), got eligible")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
go test ./services -run TestEvaluateEntry -v
```

Expected: FAIL with `undefined: evaluateEntry`.

- [ ] **Step 3: Implement `evaluateEntry`**

`services/turtle_executor.go`:

```go
package services

import "fmt"

type EntryEval struct {
	Eligible bool
	Reason   string
}

// evaluateEntry applies the entry rules in TRADING_RULES_TREND.md "Signal
// Definitions → Entry signal". When coldStart is true, the proximity filter
// is added.
func evaluateEntry(sig *TrendSignal, coldStart bool) EntryEval {
	if sig == nil {
		return EntryEval{false, "no signal"}
	}
	if sig.BarsCount < 250 {
		return EntryEval{false, fmt.Sprintf("insufficient history: bars=%d", sig.BarsCount)}
	}
	if sig.LastClose <= sig.Donchian100High {
		return EntryEval{false, "last_close not above Donchian-100 high"}
	}
	if sig.LastClose <= sig.SMA200 {
		return EntryEval{false, "last_close not above SMA-200 (regime filter)"}
	}
	if sig.LastClose == 0 || sig.ATR20/sig.LastClose < 0.005 {
		return EntryEval{false, "ATR / last_close below 0.5% volatility floor"}
	}
	if coldStart {
		if sig.Donchian100High-sig.LastClose > sig.ATR20 {
			return EntryEval{false, "cold-start proximity filter: > 1 ATR above breakout"}
		}
	}
	return EntryEval{true, ""}
}
```

- [ ] **Step 4: Run tests**

```bash
go test ./services -run TestEvaluateEntry -v
```

Expected: PASS.

- [ ] **Step 5: Add exit-eligibility evaluator**

Add to `services/turtle_executor_test.go`:

```go
func TestEvaluateExit_TrailingStopFires(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 91.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5, 5)
	got := evaluateExit(entry, sig, 90.50 /* today open */, 5 /* days since entry */)
	if got.Reason != "trailing_stop" {
		t.Errorf("expected trailing_stop, got %q", got.Reason)
	}
}

func TestEvaluateExit_InitialHardStopFiresWithin20Days(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 80.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5, 5)
	entry.InitialStop = 95.0 - 2*1.5 // 92.0
	got := evaluateExit(entry, sig, 91.50 /* today open */, 10)
	if got.Reason != "initial_hard_stop" {
		t.Errorf("expected initial_hard_stop, got %q", got.Reason)
	}
}

func TestEvaluateExit_HardStopInactivePast20Days(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 80.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5, 5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 91.50, 21)
	if got.Reason == "initial_hard_stop" {
		t.Errorf("hard stop should not fire past 20 days")
	}
}

func TestEvaluateExit_NoExitWhenAboveAllStops(t *testing.T) {
	sig := &TrendSignal{Donchian50Low: 91.00}
	entry := mkLedgerOpen("TLT", 95.0, 100, 1.5, 5)
	entry.InitialStop = 92.0
	got := evaluateExit(entry, sig, 96.0, 10)
	if got.Reason != "" {
		t.Errorf("expected no exit, got %q", got.Reason)
	}
}

func mkLedgerOpen(ticker string, entryPx float64, shares int, atr float64, daysAgo int) *models.DBTrendLedgerEntry {
	return &models.DBTrendLedgerEntry{
		Ticker: ticker, EntryPrice: entryPx, Shares: shares, ATRAtEntry: atr,
		Status: "open",
	}
}
```

- [ ] **Step 6: Implement `evaluateExit`**

Add to `services/turtle_executor.go`:

```go
type ExitEval struct {
	Reason string // "trailing_stop" | "initial_hard_stop" | ""
}

// evaluateExit applies TRADING_RULES_TREND.md "Exit signals". Trailing stop
// is always active; initial hard stop only fires when daysSinceEntry ≤ 20.
func evaluateExit(entry *models.DBTrendLedgerEntry, sig *TrendSignal, todayOpen float64, daysSinceEntry int) ExitEval {
	if entry == nil || sig == nil {
		return ExitEval{}
	}
	if todayOpen <= sig.Donchian50Low {
		return ExitEval{Reason: "trailing_stop"}
	}
	if daysSinceEntry <= 20 && todayOpen <= entry.InitialStop {
		return ExitEval{Reason: "initial_hard_stop"}
	}
	return ExitEval{}
}
```

- [ ] **Step 7: Run all evaluator tests**

```bash
go test ./services -run TestEvaluateEntry -v
go test ./services -run TestEvaluateExit -v
```

Expected: all PASS.

- [ ] **Step 8: Add position-sizing evaluator**

Add to test file:

```go
func TestComputePositionDollars_ATRSizingHitsRiskTarget(t *testing.T) {
	// portfolio=$100k, risk 0.5% = $500
	// ATR=$1.50, lastClose=$100 → stopDistance=$3 → dollars = $500 / ($3/$100) = $500 * 33.33 = ~$16,666
	dollars := computePositionDollars(100_000, 100.0, 1.50, 1.0)
	wantMin := 16_000.0
	wantMax := 17_000.0
	if dollars < wantMin || dollars > wantMax {
		t.Errorf("got $%.2f, want roughly $16,666", dollars)
	}
}

func TestComputePositionDollars_CapsAt4PctOfPortfolio(t *testing.T) {
	// ATR=$0.50, lastClose=$100 → stopDistance=$1 → uncapped = $50,000 ⇒ 50% of $100k
	// cap = 4% → $4000
	dollars := computePositionDollars(100_000, 100.0, 0.50, 1.0)
	if dollars > 4_000+1 {
		t.Errorf("expected cap at $4000, got $%.2f", dollars)
	}
}

func TestComputePositionDollars_AppliesSizingMultiplier(t *testing.T) {
	// Same as ATR test but with 0.5x multiplier
	full := computePositionDollars(100_000, 100.0, 1.50, 1.0)
	half := computePositionDollars(100_000, 100.0, 1.50, 0.5)
	if abs(half - full*0.5) > 1 {
		t.Errorf("multiplier not applied: full=%.2f half=%.2f", full, half)
	}
}
```

- [ ] **Step 9: Implement `computePositionDollars`**

Add to executor:

```go
// computePositionDollars implements TRADING_RULES_TREND.md "Position Sizing":
//
//   stop_distance_per_share = 2 * atr20
//   position_dollars = (portfolio * 0.005) / (stop_distance_per_share / last_close)
//   position_dollars = min(position_dollars * sizing_multiplier, portfolio * 0.04)
//
// Returns 0 when inputs are invalid.
func computePositionDollars(portfolio, lastClose, atr20, sizingMultiplier float64) float64 {
	if portfolio <= 0 || lastClose <= 0 || atr20 <= 0 {
		return 0
	}
	stopDistance := 2.0 * atr20
	riskBudget := portfolio * 0.005
	raw := riskBudget / (stopDistance / lastClose)
	raw *= sizingMultiplier
	cap := portfolio * 0.04
	if raw > cap {
		return cap
	}
	return raw
}
```

- [ ] **Step 10: Commit**

```bash
git add services/turtle_executor.go services/turtle_executor_test.go
git commit -m "feat(turtle): pure entry/exit/sizing evaluators with tests"
```

---

## Task 3: Executor — full per-day heartbeat

**Files:**
- Modify: `services/turtle_executor.go`
- Modify: `services/turtle_executor_test.go`

The executor takes injected deps (signal service, trading service, ledger, segment-PnL fetcher, account fetcher, regime-gate status) and runs the full sequence from TRADING_RULES_TREND.md "Heartbeat Behavior".

- [ ] **Step 1: Define the executor struct and `RunHeartbeat` method skeleton**

Add to `services/turtle_executor.go`:

```go
const turtleUniverse = "TLT,GLD,USO,DBC,UUP,EEM"

type accountFetcher interface {
	GetAccount() (*Account, error) // adapt to actual type from orderController
}

type signalFetcher interface {
	GetSignal(ctx context.Context, symbol string) (*TrendSignal, error)
}

type quoteFetcher interface {
	GetLatestQuote(ctx context.Context, symbol string) (todayOpen float64, err error)
}

type turtleTrader interface {
	PlaceOrder(ctx context.Context, order *interfaces.Order) (*interfaces.OrderResult, error)
	CancelOrder(ctx context.Context, orderID string) error
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
	GetPositions(ctx context.Context) ([]*interfaces.Position, error)
}

type segmentPnLFetcher interface {
	GetSegmentPnL(ctx context.Context, strategy string) (unrealizedPct, deployedPct float64, err error)
}

type regimeGateFetcher interface {
	GetRegimeGateStatus(ctx context.Context) (tier string, sizingMultiplier float64, blockNewEntries bool, err error)
}

type TurtleExecutor struct {
	ledger        *TurtleLedger
	signals       signalFetcher
	quotes        quoteFetcher
	trader        turtleTrader
	account       accountFetcher
	segmentPnL    segmentPnLFetcher
	regimeGate    regimeGateFetcher
	universe      []string // {"TLT","GLD","USO","DBC","UUP","EEM"}
	logger        *logrus.Logger
}

type HeartbeatResult struct {
	Date            string
	PositionsOpen   int
	Evaluated       []string
	Entries         []string
	Exits           []string
	Skips           []string // ticker:reason
	Errors          []string
	CircuitBreaker  bool
}

func (e *TurtleExecutor) RunHeartbeat(ctx context.Context, now time.Time) (*HeartbeatResult, error) {
	res := &HeartbeatResult{Date: now.Format("2006-01-02")}
	// Step 1: pre-loop checks (sequence + early returns)
	// Step 2: exits per existing ledger row
	// Step 3: entries per universe ticker
	// Step 4: pending-fill reconciliation (from previous heartbeat)
	// Step 5: summary log
	// Filled in by subsequent tasks/tests.
	return res, nil
}
```

- [ ] **Step 2: Wire pre-loop checks first (out-of-window, duplicate-heartbeat, segment circuit-breaker, deployed cap)**

Add a `preloopCheck(ctx, now, session)` method that returns an early-skip reason. Test:

```go
func TestPreloopCheck_OutOfWindow(t *testing.T) {
	exec := newTestExecutor(t)
	// 14:00 ET is far outside the 16:55-17:05 window
	now := time.Date(2026, 5, 15, 18, 0, 0, 0, time.UTC) // 14:00 ET in DST
	session := &models.DBTurtleSession{LastHeartbeatDate: ""}
	skip := exec.preloopCheck(now, session)
	if skip == "" {
		t.Errorf("expected out-of-window skip")
	}
}

func TestPreloopCheck_DuplicateForToday(t *testing.T) {
	exec := newTestExecutor(t)
	now := time.Date(2026, 5, 15, 21, 0, 0, 0, time.UTC) // 17:00 ET
	session := &models.DBTurtleSession{LastHeartbeatDate: "2026-05-15"}
	skip := exec.preloopCheck(now, session)
	if skip != "duplicate heartbeat for 2026-05-15 — skipping" {
		t.Errorf("got %q", skip)
	}
}
```

Implementation:

```go
const (
	turtleWindowStart = 16*60 + 55
	turtleWindowEnd   = 17*60 + 5
)

func (e *TurtleExecutor) preloopCheck(now time.Time, session *models.DBTurtleSession) string {
	et, _ := time.LoadLocation("America/New_York")
	local := now.In(et)
	mins := local.Hour()*60 + local.Minute()
	if mins < turtleWindowStart || mins > turtleWindowEnd {
		return fmt.Sprintf("out-of-window: %02d:%02d ET (runs 16:55-17:05)", local.Hour(), local.Minute())
	}
	today := local.Format("2006-01-02")
	if session != nil && session.LastHeartbeatDate == today {
		return fmt.Sprintf("duplicate heartbeat for %s — skipping", today)
	}
	return ""
}
```

(Add segment-PnL + deployed-cap checks once the trading service mocks exist — both follow the same pattern: query the fetcher, compare, set `res.CircuitBreaker = true` if tripped, mutate Skips.)

- [ ] **Step 3: Implement exit loop**

Test:

```go
func TestRunExitLoop_TrailingStopExitsPosition(t *testing.T) {
	// Setup: 1 open ledger entry TLT, signal says donchian_50_low=91, today_open=90.5
	// Expect: market-sell order placed, ledger row flipped to closed with exit_reason=trailing_stop
	... (full mock + assertions)
}
```

Implementation method on executor:

```go
func (e *TurtleExecutor) runExits(ctx context.Context, now time.Time, res *HeartbeatResult) {
	open, err := e.ledger.ListOpen()
	if err != nil {
		res.Errors = append(res.Errors, "list ledger: "+err.Error())
		return
	}
	for _, entry := range open {
		if entry.Status != "open" {
			continue
		}
		sig, err := e.signals.GetSignal(ctx, entry.Ticker)
		if err != nil {
			res.Errors = append(res.Errors, entry.Ticker+" signal: "+err.Error())
			continue
		}
		todayOpen, err := e.quotes.GetLatestQuote(ctx, entry.Ticker)
		if err != nil {
			res.Errors = append(res.Errors, entry.Ticker+" quote: "+err.Error())
			continue
		}
		days := int(now.Sub(entry.EntryDate).Hours() / 24)
		ex := evaluateExit(entry, sig, todayOpen, days)
		if ex.Reason == "" {
			continue
		}
		ord, err := e.trader.PlaceOrder(ctx, &interfaces.Order{
			Symbol:      entry.Ticker,
			Qty:         float64(entry.Shares),
			Side:        "sell",
			Type:        "market",
			TimeInForce: "day",
			Strategy:    "trend",
		})
		if err != nil {
			res.Errors = append(res.Errors, entry.Ticker+" market sell: "+err.Error())
			continue
		}
		orderID := ord.OrderID
		// Flip ledger row to closed (fill price is best-effort filled from order status next heartbeat)
		closedAt := now
		entry.Status = "closed"
		entry.ExitOrderID = orderID
		entry.ExitDate = &closedAt
		entry.ExitReason = ex.Reason
		if err := e.ledger.Save(entry); err != nil {
			res.Errors = append(res.Errors, entry.Ticker+" ledger update: "+err.Error())
			continue
		}
		res.Exits = append(res.Exits, fmt.Sprintf("%s:%s", entry.Ticker, ex.Reason))
	}
}
```

- [ ] **Step 4: Implement entry loop**

Following the same TDD pattern: test → implementation. Entry loop calls `evaluateEntry`, `computePositionDollars`, applies regime sizing multiplier, places a limit order at `last_close * 1.005`, writes a `pending_fill` ledger row, applies `TradeGuard.CheckBuy` (look up how `services/trade_guard.go` is called from `PlaceManagedPosition`).

- [ ] **Step 5: Implement pending-fill reconciliation**

For each row with `Status == "pending_fill"` from the *previous* day:
- `ord, err := e.trader.GetOrder(ctx, row.EntryOrderID)`
- `ord.Status == "filled"` → set `row.Status = "open"`, `row.EntryPrice = *ord.FilledAvgPrice` (defensive: nil-check), recompute `row.InitialStop = row.EntryPrice - 2*row.ATRAtEntry`, save.
- `ord.Status` ∈ {`"canceled"`, `"expired"`} → set `row.Status = "closed"`, `row.ExitReason = "missed_entry"`, save.
- `ord.Status == "partially_filled"` → set `row.Status = "open"`, `row.Shares = int(ord.FilledQty)`, `row.EntryPrice = *ord.FilledAvgPrice`, recompute `InitialStop`, save.
- Any other status (still working) → leave the row as `pending_fill`. Next heartbeat retries; if the order is still working at 17:00 the day after the limit was placed, it was never filled (Alpaca cancels day TIF at session close), so the next-day `GetOrder` will report `expired`.

Test each case.

- [ ] **Step 6: Tie it all together in `RunHeartbeat`**

```go
func (e *TurtleExecutor) RunHeartbeat(ctx context.Context, now time.Time) (*HeartbeatResult, error) {
	res := &HeartbeatResult{Date: now.Format("2006-01-02")}
	session, err := e.ledger.Session()
	if err != nil {
		return nil, fmt.Errorf("load session: %w", err)
	}
	if skip := e.preloopCheck(now, session); skip != "" {
		res.Skips = append(res.Skips, skip)
		return res, nil
	}
	// (Reconcile pending-fills from yesterday → Exit loop → Entry loop → summary)
	e.runPendingFillReconcile(ctx, res)
	e.runExits(ctx, now, res)
	e.runEntries(ctx, now, res)

	// Persist session
	et, _ := time.LoadLocation("America/New_York")
	session.LastHeartbeatDate = now.In(et).Format("2006-01-02")
	if err := e.ledger.SaveSession(session); err != nil {
		res.Errors = append(res.Errors, "save session: "+err.Error())
	}
	return res, nil
}
```

- [ ] **Step 7: Verify all executor tests pass**

```bash
go test ./services -run TestTurtle -v
go test ./services -run TestEvaluate -v
go test ./services -run TestRunHeartbeat -v
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add services/turtle_executor.go services/turtle_executor_test.go
git commit -m "feat(turtle): full heartbeat sequence executor"
```

---

## Task 4: Scheduler — fire once per day at 17:00 ET

**Files:**
- Create: `services/turtle_scheduler.go`
- Create: `services/turtle_scheduler_test.go`

- [ ] **Step 1: Define the scheduler**

`services/turtle_scheduler.go`:

```go
package services

import (
	"context"
	"time"

	"github.com/sirupsen/logrus"
)

type TurtleScheduler struct {
	executor *TurtleExecutor
	logger   *logrus.Logger
	now      func() time.Time
	last     *HeartbeatResult
}

func NewTurtleScheduler(exec *TurtleExecutor, logger *logrus.Logger) *TurtleScheduler {
	return &TurtleScheduler{executor: exec, logger: logger, now: time.Now}
}

// Start runs until ctx is canceled. Each tick computes the duration until
// the next 17:00 ET weekday and sleeps. On wake, RunHeartbeat is called;
// the result is logged and cached for the status endpoint.
func (s *TurtleScheduler) Start(ctx context.Context) {
	for {
		next := nextFireTime(s.now())
		wait := time.Until(next)
		s.logger.Infof("[turtle-scheduler] next fire at %s (in %s)", next.Format(time.RFC3339), wait)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
			res, err := s.executor.RunHeartbeat(ctx, s.now())
			if err != nil {
				s.logger.WithError(err).Error("[turtle-scheduler] heartbeat failed")
				continue
			}
			s.last = res
			s.logger.WithFields(logrus.Fields{
				"date":    res.Date,
				"entries": res.Entries,
				"exits":   res.Exits,
				"skips":   res.Skips,
				"errors":  res.Errors,
			}).Info("[turtle-scheduler] heartbeat complete")
		}
	}
}

func (s *TurtleScheduler) LastResult() *HeartbeatResult {
	return s.last
}

// nextFireTime returns the next weekday 17:00 ET (UTC-anchored) after `from`.
func nextFireTime(from time.Time) time.Time {
	et, _ := time.LoadLocation("America/New_York")
	local := from.In(et)
	candidate := time.Date(local.Year(), local.Month(), local.Day(), 17, 0, 0, 0, et)
	if !candidate.After(local) {
		candidate = candidate.Add(24 * time.Hour)
	}
	for candidate.Weekday() == time.Saturday || candidate.Weekday() == time.Sunday {
		candidate = candidate.Add(24 * time.Hour)
	}
	return candidate.UTC()
}
```

- [ ] **Step 2: Test `nextFireTime`**

```go
func TestNextFireTime_FromMondayMorning(t *testing.T) {
	et, _ := time.LoadLocation("America/New_York")
	from := time.Date(2026, 5, 18, 10, 0, 0, 0, et) // Mon 10:00 ET
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 5, 18, 17, 0, 0, 0, et)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestNextFireTime_FromFridayEvening_RollsToMonday(t *testing.T) {
	et, _ := time.LoadLocation("America/New_York")
	from := time.Date(2026, 5, 15, 19, 0, 0, 0, et) // Fri 19:00 ET (past 17:00)
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 5, 18, 17, 0, 0, 0, et) // Mon
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestNextFireTime_FromSaturday_RollsToMonday(t *testing.T) {
	et, _ := time.LoadLocation("America/New_York")
	from := time.Date(2026, 5, 16, 10, 0, 0, 0, et) // Sat
	got := nextFireTime(from.UTC()).In(et)
	want := time.Date(2026, 5, 18, 17, 0, 0, 0, et)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
```

- [ ] **Step 3: Run + verify**

```bash
go test ./services -run TestNextFireTime -v
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add services/turtle_scheduler.go services/turtle_scheduler_test.go
git commit -m "feat(turtle): scheduler with weekday-aware 17:00 ET fire"
```

---

## Task 5: Wire in main.go + status endpoint + preflight

**Files:**
- Modify: `cmd/bot/main.go`
- Create: `controllers/turtle_controller.go`
- Modify: `agent/preflight.js` (trendPreflight)

- [ ] **Step 1: Wire executor + scheduler in main.go**

Below the existing `trendController := controllers.NewTrendController(...)` line in main.go:

```go
if os.Getenv("TURTLE_SCHEDULER_ENABLED") == "true" {
	turtleLedger := services.NewTurtleLedger(storageService)
	turtleExec := services.NewTurtleExecutor(
		turtleLedger, trendSignalSvc,
		/* quoteFetcher: */ tradingService,
		/* turtleTrader: */ tradingService, // adapt if multiple interfaces
		/* accountFetcher: */ orderController,
		/* segmentPnLFetcher: */ segmentPnLSvc,
		/* regimeGateFetcher: */ regimeGateController,
		logger,
	)
	turtleScheduler := services.NewTurtleScheduler(turtleExec, logger)
	turtleController := controllers.NewTurtleController(turtleScheduler)
	// Add the controller to the router via a new param OR via a global registration helper
	go turtleScheduler.Start(ctx)
	logger.Info("Turtle scheduler started")
}
```

(`NewTurtleExecutor` needs a constructor with the params listed; add it to `turtle_executor.go`.)

- [ ] **Step 2: Create read-only status controller**

`controllers/turtle_controller.go`:

```go
package controllers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

type TurtleController struct {
	scheduler *services.TurtleScheduler
}

func NewTurtleController(scheduler *services.TurtleScheduler) *TurtleController {
	return &TurtleController{scheduler: scheduler}
}

func (tc *TurtleController) HandleGetStatus(c *gin.Context) {
	last := tc.scheduler.LastResult()
	c.JSON(http.StatusOK, gin.H{
		"scheduler_enabled": true,
		"last_run":          last,
	})
}
```

Register the route in `setupRouter` under `/api/v1/turtle/status`.

- [ ] **Step 3: Modify trendPreflight in agent/preflight.js**

At the top of `trendPreflight` (line 285), add:

```js
// When the Turtle Go scheduler is running, the LLM has nothing to do —
// the scheduler executes the full strategy and the LLM is retained only
// for quarterly trend_parameter_review (a manual operator flow).
try {
  const sched = await runtime.goAxios.get('/api/v1/turtle/status', { timeout: 800 });
  if (sched?.data?.scheduler_enabled === true) {
    return { skip: true, reason: 'Turtle Go scheduler enabled — LLM beat unnecessary' };
  }
} catch (_err) {
  // Fail open — fall through to the existing logic
}
```

- [ ] **Step 4: Verify smoke**

```bash
TURTLE_SCHEDULER_ENABLED=true ./prophet_bot.exe &
curl http://localhost:8080/api/v1/turtle/status
```

Expected: `{"scheduler_enabled":true,"last_run":null}` until 17:00 ET, then `last_run` populated.

- [ ] **Step 5: Commit**

```bash
git add cmd/bot/main.go controllers/turtle_controller.go agent/preflight.js
git commit -m "feat(turtle): wire scheduler, status endpoint, preflight skip"
```

---

## Task 6: Rules doc + operator notes

**Files:**
- Modify: `TRADING_RULES_TREND.md`
- Modify: `.env.example`

- [ ] **Step 1: Add the front-matter note**

At the top of `TRADING_RULES_TREND.md`, after the existing **Style** line:

```markdown
> **Backend automation:** When `TURTLE_SCHEDULER_ENABLED=true` (operator env flag), the entire `Heartbeat Behavior` sequence below is executed by `TurtleScheduler` in the Go backend on a daily 17:00 ET cron. The LLM is retained only for the quarterly parameter-review skill. This rules file is the auditable spec of what the scheduler does; edits here do NOT change agent runtime behavior unless the scheduler is updated to match.
```

- [ ] **Step 2: Add the env var**

```bash
echo "" >> .env.example
echo "# Turtle Go scheduler — when true, daily Trend heartbeat runs in Go, not LLM." >> .env.example
echo "TURTLE_SCHEDULER_ENABLED=false" >> .env.example
```

- [ ] **Step 3: Commit**

```bash
git add TRADING_RULES_TREND.md .env.example
git commit -m "docs(turtle): document Go-scheduler env flag"
```

---

## Task 7: Manual smoke + first-run dry-test

- [ ] **Step 1: Cold-start safety check**

Bring up the bot in paper mode with the flag on, no existing ledger:

```bash
TURTLE_SCHEDULER_ENABLED=true ./prophet_bot.exe
```

At the next 17:00 ET, the scheduler should log a heartbeat with `cold_start_completed: false`, and apply the proximity filter. Verify by checking the log for `ColdStart` skip reasons and confirming `data/storage/*.db` shows a `turtle_session` row with `cold_start_completed: true` after the first heartbeat with any fill.

- [ ] **Step 2: Position carry-over on restart**

After a heartbeat creates a `pending_fill` ledger row, restart the bot. Confirm `pm.loadFromDB()` (or equivalent) doesn't touch the trend ledger — the scheduler's next 17:00 reconciliation should resolve it.

- [ ] **Step 3: Confirm LLM is not waking**

Watch the harness log. With the flag on, the trend-agent beat should print `Beat skipped (preflight): Turtle Go scheduler enabled` instead of spawning opencode.

---

## Self-Review

**Spec coverage (TRADING_RULES_TREND.md):**

- Universe filter — `turtleUniverse` const, used by entry loop. ✅
- Cold-start proximity filter — `evaluateEntry(sig, coldStart)`. ✅
- Persisted ledger — `DBTrendLedgerEntry`. ✅
- Startup reconciliation — pending-fill reconcile loop. ✅
- Hard stops (broker fail / reconciliation mismatch) — surfaced as `res.Errors`; need to add an explicit "halt all entries on error" branch in `RunHeartbeat`. **Gap — add Task 3 step 6b: when `len(res.Errors) > 0` from the exit loop, abort the entry loop.** (Add inline before commit.)
- Position sizing — `computePositionDollars`. ✅
- Risk caps (5 positions, 18% deployed, 2.5% aggregate risk) — partially in entry loop. **Need explicit aggregate-risk check** by summing `(stop_distance * shares) / portfolio` across the ledger and comparing to 2.5%. Add to entry-loop tests.
- Daily circuit breaker — segment-PnL preloop check. ✅ (assuming Task 0 confirmed the service)
- Regime gate — entry-loop fetches multiplier, applies in `computePositionDollars`. ✅
- Idempotency — `LastHeartbeatDate` check. ✅
- Heartbeat schedule (17:00 ET weekdays) — `nextFireTime`. ✅
- Out-of-window log — `preloopCheck`. ✅

**Gaps found:**

1. **Aggregate-risk cap not wired into entry loop.** Add a test + check that sums `(2 * atr_at_entry * shares) / portfolio` across the current ledger and rejects the new entry if it would push above 2.5%. Add this to Task 3 step 4 before committing.
2. **`TradeGuard.CheckBuy` integration.** Mentioned in Task 3 step 4 but signature not pinned. Resolve via `grep -n "guard.CheckBuy\|trade_guard" services/` during execution; pass `AgentSource = "main"` (since trend orders are not from the penny aggregator).
3. **Order-tag plumbing.** Every order must carry `strategy: "trend"` on the `interfaces.Order.Strategy` field. `PlaceOrder` then encodes `client_order_id` as `"trend:" + uuid` automatically (see `services/alpaca_trading.go:86-93`). Resist any temptation to set `ClientOrderID` manually.
4. **Cross-asset context block.** TRADING_RULES_TREND.md lines 378-396 talk about `cross_asset.dxy_change_pct_5d` etc. — this is *informational* for the LLM and not a hard rule. **Out of scope for Go port** (the rules don't say "skip if dxy disagrees"); the LLM-driven version was using it for "wait or size smaller" judgment, which we're replacing with the regime-gate sizing multiplier anyway.
5. **Sector-cap rejection handling.** When `PlaceOrder` fails with a TradeGuard sector-cap error, log + skip rather than halt. Pattern matches the penny flow.
6. **Quarterly param review.** This plan leaves the LLM-driven `trend_parameter_review` running via `analysis-scheduler.js`. No change needed there — the parameter review writes adjustments to the rules-doc / agent config, which the operator then verifies and commits. Scheduler picks up the new constants on next bot restart (constants like risk per trade, BP cap are currently hard-coded; promote to env or a config struct in a follow-up if param review wants to vary them).

**Type/signature consistency:** `HeartbeatResult` referenced consistently. `evaluateEntry/Exit` use the same `TrendSignal` shape as `services/trend_signal_service.go` defines. `turtleTrader` interface is defined once and reused. ✅

**No placeholders:** One "filled in by subsequent tasks/tests" remains in Task 3 step 1's skeleton `RunHeartbeat` — that's the introductory shape pre-implementation, and Task 3 step 6 replaces it with the real version. Acceptable as a transitional staging step.

---

## Out of Scope

- Real-time signal updates intra-day (Turtle is EOD-only by design).
- Short-side or leveraged ETF trends (rules-doc v1 limitation).
- Cross-strategy capital arbitration at the harness level (called out explicitly in the rules doc).
- Migrating the quarterly `trend_parameter_review` to Go — it's a low-frequency LLM task where reasoning matters.
- Operator dashboard for trend ledger — basic JSON endpoint is enough for v1.
