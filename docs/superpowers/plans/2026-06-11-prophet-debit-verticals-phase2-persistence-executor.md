# Prophet Debit Verticals — Phase 2 (Persistence & Executor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the persistence + execution layer for Prophet's debit verticals: gorm model, ledger, executor (mleg place, two-phase fail-closed close, reconcile, deterministic backstops), intraday scheduler, and the default-OFF feature flag.

**Architecture:** Mirror the proven `prophet_hedge_*` engine (ledger façade over a storage-subset interface; executor with small consumer-defined interfaces and stub-based tests; reconcile-then-manage tick), but driven by an intraday loop shaped like `ProphetOptionsStopMonitor.Start` rather than the hedge's once-daily fire. Consumes Phase 1's pure functions (`verticalEconomics`, `verticalDebitLimit`, `selectVerticalExit`, `attributeVerticalPnl`, `verticalDTE`). Spec: `docs/superpowers/specs/2026-06-11-prophet-debit-verticals-phase2-persistence-executor-design.md`.

**Tech Stack:** Go, gorm (sqlite), logrus, standard `testing` with hand-rolled stubs (no mock framework — match the hedge tests).

---

## Branch & commit discipline (EVERY task)

- Work in the repo root `C:/Users/mtzuo/OneDrive/Documents/Projects/ClaudeProphetAndFriends` on branch **`prophet-debit-verticals-phase2`** (exists; holds the spec commits).
- Before EVERY commit: `git symbolic-ref --short HEAD` must print `prophet-debit-verticals-phase2`; anything else → STOP, report BLOCKED.
- Stage ONLY the files named in the task. Never `git add -A` / `git add .` (the shared root checkout has unrelated changes).
- CRLF working tree: `gofmt -l` flags are harmless (`.gitattributes text=auto`); use tabs in Go code; don't reformat existing files.
- `go test ./services/ -run X -v` compiles the whole package — pre-existing unrelated tests may also run; that's fine. The known-flaky `TestAggregator_Composite` is unrelated — ignore it if it appears.

## Existing code this plan builds on (read-only context)

- Phase 1 pure core (already on this branch via main): `services/prophet_vertical_structure.go` (`VerticalDirection`, `CallDebit`, `PutDebit`, `verticalEconomics`, `verticalDebitLimit`), `services/prophet_vertical_lifecycle.go` (`verticalDTE`, `VerticalState`, `VerticalExitConfig`, `selectVerticalExit`), `services/prophet_vertical_attribution.go` (`VerticalSnapshot`, `VerticalAttribution`, `attributeVerticalPnl`). Test helper `almostEqual` exists in `services/prophet_vertical_structure_test.go`.
- `services/mleg.go`: `MultiLegOrder{Underlying, Legs, Contracts, LimitPrice, TimeInForce, Strategy}`, `MultiLegOrderLeg{Symbol, Side, PositionIntent}`. ⚠️ Its `LimitPrice` comment ("net credit … positive = we receive credit") is WRONG (stale Harvest legacy): per Alpaca's Options Level 3 docs, **positive = net debit, negative = net credit**, and `LimitPrice == 0` sends a market combo. Task 8 fixes the comment.
- `services/prophet_hedge_executor.go` / `_ledger.go` / `_constants.go` / `models/prophet_hedge_models.go` / `database/storage.go:580` — the patterns being mirrored.
- `services/prophet_options_stop_monitor.go:294` — `Start(ctx, interval, idleInterval, marketIsOpen)` loop shape.
- `cmd/bot/main.go:419` (hedge flag-gate idiom), `:477-479` (`StaticMarketPhase` market-open gate), `services.NewHedgeAccountFetcher(tradingService, dataService)` (provides `GetLatestBar`).
- `interfaces.Order{Status, FilledQty, FilledAvgPrice *float64}`, `interfaces.OptionContract{Bid, Ask, ImpliedVolatility, …}`, `interfaces.OptionsQuote{Symbol, BidPrice, AskPrice, Timestamp}`, guard `CheckOptionsOpen(agent, underlying, symbol, quote, now)`, `AgentMain`.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `models/prophet_vertical_models.go` | 1 | `DBProphetVerticalSpread` row |
| `database/storage.go` (modify) | 1 | AutoMigrate registration + 3 storage methods |
| `database/storage_prophet_vertical_test.go` | 1 | DB-backed storage test |
| `services/prophet_vertical_constants.go` | 2 | Compile-time knobs |
| `services/prophet_vertical_ledger.go` (+`_test`) | 2 | Ledger façade + fake store |
| `services/prophet_vertical_executor.go` (+`_test`) | 3–6 | Place / reconcile / close / manage |
| `config/config.go` + `config/config_test.go` (modify) | 7 | `EnableProphetDebitVerticals` flag |
| `services/prophet_vertical_scheduler.go` (+`_test`) | 8 | Intraday loop + `LastResult` |
| `cmd/bot/main.go` (modify) + `services/mleg.go` (comment fix) | 8 | Flag-gated wiring |

---

### Task 1: DB model + storage methods

**Files:**
- Create: `models/prophet_vertical_models.go`
- Modify: `database/storage.go` (AutoMigrate list at `:42`; new methods after `GetProphetHedgeClosedPnL`, ~`:627`)
- Test: `database/storage_prophet_vertical_test.go`

- [ ] **Step 1: Write the failing test** — create `database/storage_prophet_vertical_test.go`:

```go
package database

import (
	"testing"
	"time"

	"prophet-trader/models"
)

func TestProphetVerticalSpread_SaveListOpenGet(t *testing.T) {
	s, err := NewLocalStorage(":memory:")
	if err != nil {
		t.Fatalf("storage: %v", err)
	}
	open := &models.DBProphetVerticalSpread{
		VerticalID: "v1", Underlying: "AMZN", Direction: "call_debit", Status: "open",
		LongSymbol: "AMZN260717C00240000", LongStrike: 240,
		ShortSymbol: "AMZN260717C00260000", ShortStrike: 260,
		Contracts: 1, Expiration: time.Now().Add(35 * 24 * time.Hour),
	}
	closing := &models.DBProphetVerticalSpread{VerticalID: "v2", Underlying: "CEG", Direction: "put_debit", Status: "closing"}
	closed := &models.DBProphetVerticalSpread{VerticalID: "v3", Underlying: "CEG", Direction: "put_debit", Status: "closed"}
	for _, sp := range []*models.DBProphetVerticalSpread{open, closing, closed} {
		if err := s.SaveProphetVerticalSpread(sp); err != nil {
			t.Fatalf("save %s: %v", sp.VerticalID, err)
		}
	}
	got, err := s.ListOpenProphetVerticalSpreads()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 { // open + closing are live; closed is terminal
		t.Fatalf("want 2 live rows, got %d", len(got))
	}
	byID, err := s.GetProphetVerticalSpreadByID(open.ID)
	if err != nil || byID.VerticalID != "v1" {
		t.Fatalf("get by id: %v / %+v", err, byID)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./database/ -run TestProphetVerticalSpread -v`
Expected: FAIL — `models.DBProphetVerticalSpread` / storage methods undefined.

- [ ] **Step 3: Implement.** Create `models/prophet_vertical_models.go`:

```go
package models

import (
	"time"

	"gorm.io/gorm"
)

// DBProphetVerticalSpread is one LLM-initiated, defined-risk debit vertical
// (call-debit bullish / put-debit bearish). Dedicated table for the same
// reason as DBProphetHedgeSpread: multi-leg doesn't fit the single-symbol
// managed_positions model. Closed rows are retained for the teaching ledger;
// the entry-snapshot + attribution fields make the "right on direction and
// still lost" decomposition durable. No session row: the manage tick is
// idempotent and intraday, so there is no once-daily state to dedupe.
type DBProphetVerticalSpread struct {
	gorm.Model
	VerticalID string `gorm:"uniqueIndex"`
	Underlying string `gorm:"index"`
	Direction  string // "call_debit" | "put_debit" (services.VerticalDirection)
	Expiration time.Time

	LongSymbol  string
	LongStrike  float64
	ShortSymbol string
	ShortStrike float64

	Contracts           int
	NetDebitPerContract float64 // per-share net debit (quoted at place; updated to fill)
	TotalDebit          float64 // NetDebitPerContract * 100 * Contracts (= max loss)
	MaxGain             float64 // (width − net debit) * 100 * Contracts
	Breakeven           float64

	// Entry snapshot, captured at fill-DETECTION (first manage tick that sees
	// the fill; ≤ one tick of drift, absorbed by AttribResidual). Inputs to
	// attributeVerticalPnl. Zero values = degraded feed at capture time.
	EntrySpot         float64
	EntryLongVol      float64
	EntryShortVol     float64
	EntryTimeToExpiry float64 // years

	EntryOrderID string
	CloseOrderID string `gorm:"column:close_order_id"`

	// Status: pending_fill | open | closing | closed | failed
	Status         string `gorm:"index"`
	CloseRequested bool   // set by RequestClose (LLM); manage tick acts on it
	CloseReason    string // llm_requested | salvage_stop | profit_capture | force_close | reconciled
	RealizedPnL    float64 `gorm:"column:realized_pnl"`

	// Black-Scholes reprice-walk decomposition of RealizedPnL (teaching output).
	AttribDirection float64
	AttribTheta     float64
	AttribIV        float64
	AttribResidual  float64

	OpenedAt time.Time
	ClosedAt *time.Time
}

func (DBProphetVerticalSpread) TableName() string { return "prophet_vertical_spreads" }
```

In `database/storage.go`: add `&models.DBProphetVerticalSpread{},` to the `AutoMigrate(...)` list (after `&models.DBProphetHedgeSession{},`), and append after `GetProphetHedgeClosedPnL`:

```go
// ── Prophet debit-vertical storage ────────────────────────────────

func (s *LocalStorage) SaveProphetVerticalSpread(e *models.DBProphetVerticalSpread) error {
	return s.db.Save(e).Error
}

// ListOpenProphetVerticalSpreads returns verticals still in a live state
// (pending_fill, open, closing) — the set the executor reconciles/manages.
func (s *LocalStorage) ListOpenProphetVerticalSpreads() ([]*models.DBProphetVerticalSpread, error) {
	var out []*models.DBProphetVerticalSpread
	err := s.db.Where("status IN ?", []string{"pending_fill", "open", "closing"}).Find(&out).Error
	return out, err
}

func (s *LocalStorage) GetProphetVerticalSpreadByID(id uint) (*models.DBProphetVerticalSpread, error) {
	var e models.DBProphetVerticalSpread
	if err := s.db.First(&e, id).Error; err != nil {
		return nil, err
	}
	return &e, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./database/ -run TestProphetVerticalSpread -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add models/prophet_vertical_models.go database/storage.go database/storage_prophet_vertical_test.go
git commit -m "feat(prophet-vertical): DBProphetVerticalSpread model + storage methods + AutoMigrate"
```

---

### Task 2: Constants + ledger façade

**Files:**
- Create: `services/prophet_vertical_constants.go`
- Create: `services/prophet_vertical_ledger.go`
- Test: `services/prophet_vertical_ledger_test.go`

- [ ] **Step 1: Write the failing test** — create `services/prophet_vertical_ledger_test.go`:

```go
package services

import (
	"fmt"
	"testing"

	"prophet-trader/models"
)

// fakeVerticalStore is the in-memory verticalLedgerStore used across the
// Phase-2 executor tests (mirrors newFakeHedgeStore).
type fakeVerticalStore struct {
	spreads map[string]*models.DBProphetVerticalSpread
	nextID  uint
}

func newFakeVerticalStore() *fakeVerticalStore {
	return &fakeVerticalStore{spreads: map[string]*models.DBProphetVerticalSpread{}}
}

func (f *fakeVerticalStore) SaveProphetVerticalSpread(e *models.DBProphetVerticalSpread) error {
	if e.ID == 0 {
		f.nextID++
		e.ID = f.nextID
	}
	f.spreads[e.VerticalID] = e
	return nil
}

func (f *fakeVerticalStore) ListOpenProphetVerticalSpreads() ([]*models.DBProphetVerticalSpread, error) {
	var out []*models.DBProphetVerticalSpread
	for _, sp := range f.spreads {
		if sp.Status == "pending_fill" || sp.Status == "open" || sp.Status == "closing" {
			out = append(out, sp)
		}
	}
	return out, nil
}

func (f *fakeVerticalStore) GetProphetVerticalSpreadByID(id uint) (*models.DBProphetVerticalSpread, error) {
	for _, sp := range f.spreads {
		if sp.ID == id {
			return sp, nil
		}
	}
	return nil, fmt.Errorf("not found: %d", id)
}

func TestVerticalLedger_RoundTrip(t *testing.T) {
	led := NewProphetVerticalLedger(newFakeVerticalStore())
	sp := &models.DBProphetVerticalSpread{VerticalID: "v1", Status: "pending_fill"}
	if err := led.Save(sp); err != nil {
		t.Fatalf("save: %v", err)
	}
	open, err := led.ListOpen()
	if err != nil || len(open) != 1 || open[0].VerticalID != "v1" {
		t.Fatalf("listopen: %v / %d rows", err, len(open))
	}
	sp.Status = "closed"
	_ = led.Save(sp)
	open, _ = led.ListOpen()
	if len(open) != 0 {
		t.Fatalf("closed row must not be live, got %d", len(open))
	}
}

func TestVerticalExitConfigFromConstants(t *testing.T) {
	cfg := verticalExitConfig()
	if cfg.ForceDTE != verticalForceDTE || cfg.SalvageFloorFrac != verticalSalvageFloorFrac {
		t.Fatalf("exit config must reflect the constants: %+v", cfg)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run 'TestVerticalLedger|TestVerticalExitConfig' -v`
Expected: FAIL — `NewProphetVerticalLedger` / constants undefined.

- [ ] **Step 3: Implement.** Create `services/prophet_vertical_constants.go`:

```go
package services

import "time"

// Prophet debit-vertical tuning constants. Compile-time knobs (the hedge-engine
// pattern — not env vars). Pre-registered in the feature spec §10; paper-phase
// teaching-toy values.
const (
	verticalStrategyTag = "v2-vertical" // distinct from "v2-options" so the
	// options stop monitor ignores vertical legs (it filters on exactly
	// "v2-options") and broker reconciliation attributes combos correctly.
	verticalContracts        = 1      // v1: always 1 contract (clean attribution)
	verticalDebitCapUSD      = 1000.0 // max net debit per vertical (= max loss cap), absolute $
	verticalLimitBufferFrac  = 0.25   // marketable-limit buffer (same as hedge opens)
	verticalForceDTE         = 2      // force-close at/under this DTE
	verticalCaptureDTE       = 3      // capture short-ITM at/under this DTE
	verticalSalvageFloorFrac = 0.20   // salvage-stop at ≤20% of debit paid
	verticalExpectedExitCost = 5.0    // $/contract round-trip estimate for the let-expire carve-out

	verticalTickInterval = 5 * time.Minute  // manage cadence while market open
	verticalIdleInterval = 30 * time.Minute // re-check cadence while closed
)

// verticalExitConfig bundles the backstop constants for selectVerticalExit.
func verticalExitConfig() VerticalExitConfig {
	return VerticalExitConfig{
		SalvageFloorFrac: verticalSalvageFloorFrac,
		ForceDTE:         verticalForceDTE,
		CaptureDTE:       verticalCaptureDTE,
		ExpectedExitCost: verticalExpectedExitCost,
	}
}
```

Create `services/prophet_vertical_ledger.go`:

```go
package services

import "prophet-trader/models"

// verticalLedgerStore is the storage subset the vertical ledger needs.
// Implemented by *database.LocalStorage; tests substitute fakeVerticalStore.
type verticalLedgerStore interface {
	SaveProphetVerticalSpread(e *models.DBProphetVerticalSpread) error
	ListOpenProphetVerticalSpreads() ([]*models.DBProphetVerticalSpread, error)
	GetProphetVerticalSpreadByID(id uint) (*models.DBProphetVerticalSpread, error)
}

// ProphetVerticalLedger is a thin, stateless façade over vertical storage.
type ProphetVerticalLedger struct{ store verticalLedgerStore }

func NewProphetVerticalLedger(store verticalLedgerStore) *ProphetVerticalLedger {
	return &ProphetVerticalLedger{store: store}
}

func (l *ProphetVerticalLedger) Save(e *models.DBProphetVerticalSpread) error {
	return l.store.SaveProphetVerticalSpread(e)
}
func (l *ProphetVerticalLedger) ListOpen() ([]*models.DBProphetVerticalSpread, error) {
	return l.store.ListOpenProphetVerticalSpreads()
}
func (l *ProphetVerticalLedger) GetByID(id uint) (*models.DBProphetVerticalSpread, error) {
	return l.store.GetProphetVerticalSpreadByID(id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'TestVerticalLedger|TestVerticalExitConfig' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_constants.go services/prophet_vertical_ledger.go services/prophet_vertical_ledger_test.go
git commit -m "feat(prophet-vertical): constants + ledger facade over storage subset"
```

---

### Task 3: Executor — `Place`

**Files:**
- Create: `services/prophet_vertical_executor.go`
- Test: `services/prophet_vertical_executor_test.go`

- [ ] **Step 1: Write the failing test** — create `services/prophet_vertical_executor_test.go`. This file also defines the stub harness reused by Tasks 4–6:

```go
package services

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// ── stub harness (mirrors the hedge stubs) ──────────────────────────

type vertStubChain struct{ snaps map[string]*interfaces.OptionContract }

func (s vertStubChain) GetOptionSnapshot(_ context.Context, sym string) (*interfaces.OptionContract, error) {
	c, ok := s.snaps[sym]
	if !ok || c == nil {
		return nil, errors.New("no snapshot")
	}
	return c, nil
}

type vertStubBars struct{ bars map[string]*interfaces.Bar }

func (s vertStubBars) GetLatestBar(_ context.Context, sym string) (*interfaces.Bar, error) {
	b, ok := s.bars[sym]
	if !ok {
		return nil, errors.New("no bar")
	}
	return b, nil
}

type vertPlaced struct{ order MultiLegOrder }
type vertStubMleg struct {
	placed   []vertPlaced
	orders   map[string]*interfaces.Order
	placeErr error
}

func (s *vertStubMleg) PlaceMultiLegOrder(_ context.Context, o MultiLegOrder) (string, error) {
	if s.placeErr != nil {
		return "", s.placeErr
	}
	s.placed = append(s.placed, vertPlaced{order: o})
	return "mleg-vert", nil
}
func (s *vertStubMleg) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	o, ok := s.orders[id]
	if !ok {
		return nil, errors.New("order not found")
	}
	return o, nil
}

type vertStubGuard struct {
	rejected []string // symbols to reject
	checked  []string // symbols seen
}

func (g *vertStubGuard) CheckOptionsOpen(_ AgentSource, _ string, symbol string, _ *interfaces.OptionsQuote, _ time.Time) error {
	g.checked = append(g.checked, symbol)
	for _, r := range g.rejected {
		if r == symbol {
			return errors.New("guard: rejected " + symbol)
		}
	}
	return nil
}

// newVertExec builds an executor over the fake store with the given stubs.
func newVertExec(store *fakeVerticalStore, chain vertStubChain, bars vertStubBars, mleg *vertStubMleg, guard *vertStubGuard) (*ProphetVerticalExecutor, *ProphetVerticalLedger) {
	led := NewProphetVerticalLedger(store)
	var g verticalGuard
	if guard != nil {
		g = guard
	}
	return NewProphetVerticalExecutor(led, chain, bars, mleg, g, nil), led
}

// liquid AMZN call legs: long 240 mid 7.00 (BA 6.80/7.20), short 260 mid 2.00 (BA 1.90/2.10)
func amznCallSnaps() map[string]*interfaces.OptionContract {
	return map[string]*interfaces.OptionContract{
		"AMZN260717C00240000": {Symbol: "AMZN260717C00240000", ContractType: "call", StrikePrice: 240, Bid: 6.80, Ask: 7.20, ImpliedVolatility: 0.35},
		"AMZN260717C00260000": {Symbol: "AMZN260717C00260000", ContractType: "call", StrikePrice: 260, Bid: 1.90, Ask: 2.10, ImpliedVolatility: 0.32},
	}
}

func amznPlaceReq() PlaceVerticalRequest {
	return PlaceVerticalRequest{
		Underlying: "AMZN", Expiration: time.Date(2026, 7, 17, 20, 0, 0, 0, time.UTC),
		Direction:  CallDebit,
		LongSymbol: "AMZN260717C00240000", LongStrike: 240,
		ShortSymbol: "AMZN260717C00260000", ShortStrike: 260,
	}
}

// ── Place tests ─────────────────────────────────────────────────────

func TestPlace_SubmitsDebitComboAndPersistsPending(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	guard := &vertStubGuard{}
	ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, vertStubBars{}, mleg, guard)

	id, err := ex.Place(context.Background(), amznPlaceReq(), time.Now())
	if err != nil {
		t.Fatalf("place: %v", err)
	}
	if len(mleg.placed) != 1 {
		t.Fatalf("want 1 combo placed, got %d", len(mleg.placed))
	}
	o := mleg.placed[0].order
	// net mid 5.00 + 0.25*(0.40+0.20)=0.15 → 5.15 positive DEBIT limit
	if o.LimitPrice <= 0 {
		t.Fatalf("opening debit limit must be positive (Alpaca: positive=debit), got %v", o.LimitPrice)
	}
	if !almostEqual(o.LimitPrice, 5.15, 1e-9) {
		t.Fatalf("limit = %v, want 5.15", o.LimitPrice)
	}
	if o.Strategy != verticalStrategyTag || o.Contracts != verticalContracts || o.Underlying != "AMZN" {
		t.Fatalf("order meta wrong: %+v", o)
	}
	if len(o.Legs) != 2 ||
		o.Legs[0].Symbol != "AMZN260717C00240000" || o.Legs[0].Side != "buy" || o.Legs[0].PositionIntent != "buy_to_open" ||
		o.Legs[1].Symbol != "AMZN260717C00260000" || o.Legs[1].Side != "sell" || o.Legs[1].PositionIntent != "sell_to_open" {
		t.Fatalf("legs wrong: %+v", o.Legs)
	}
	if len(guard.checked) != 2 {
		t.Fatalf("guard must run per leg (2 checks), got %v", guard.checked)
	}
	sp := store.spreads[id]
	if sp == nil || sp.Status != "pending_fill" || sp.EntryOrderID != "mleg-vert" {
		t.Fatalf("row not persisted as pending_fill: %+v", sp)
	}
	if !almostEqual(sp.TotalDebit, 5.15*100, 1e-6) || sp.MaxGain <= 0 || sp.Breakeven <= 240 {
		t.Fatalf("economics not recorded: %+v", sp)
	}
}

func TestPlace_GuardRejectionBlocksEitherLeg(t *testing.T) {
	for _, rejected := range []string{"AMZN260717C00240000", "AMZN260717C00260000"} {
		store := newFakeVerticalStore()
		mleg := &vertStubMleg{}
		ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, vertStubBars{}, mleg, &vertStubGuard{rejected: []string{rejected}})
		if _, err := ex.Place(context.Background(), amznPlaceReq(), time.Now()); err == nil {
			t.Fatalf("guard rejection of %s must block the open", rejected)
		}
		if len(mleg.placed) != 0 || len(store.spreads) != 0 {
			t.Fatal("no order and no row may exist after a guard rejection")
		}
	}
}

func TestPlace_DebitCapRejects(t *testing.T) {
	snaps := amznCallSnaps()
	snaps["AMZN260717C00240000"].Bid, snaps["AMZN260717C00240000"].Ask = 14.0, 14.4 // mid 14.2 → debit ~12.35 → $1235 > $1000 cap
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	ex, _ := newVertExec(store, vertStubChain{snaps: snaps}, vertStubBars{}, mleg, &vertStubGuard{})
	_, err := ex.Place(context.Background(), amznPlaceReq(), time.Now())
	if err == nil || !strings.Contains(err.Error(), "debit cap") {
		t.Fatalf("expected debit-cap rejection, got %v", err)
	}
	if len(mleg.placed) != 0 {
		t.Fatal("capped order must not be placed")
	}
}

func TestPlace_MissingQuoteFailsClosed(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	ex, _ := newVertExec(store, vertStubChain{snaps: map[string]*interfaces.OptionContract{}}, vertStubBars{}, mleg, &vertStubGuard{})
	if _, err := ex.Place(context.Background(), amznPlaceReq(), time.Now()); err == nil {
		t.Fatal("missing leg snapshot must fail the place (no blind order)")
	}
	if len(mleg.placed) != 0 || len(store.spreads) != 0 {
		t.Fatal("no order and no row on a failed place")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestPlace_ -v`
Expected: FAIL — `ProphetVerticalExecutor` / `PlaceVerticalRequest` / `verticalGuard` undefined.

- [ ] **Step 3: Implement.** Create `services/prophet_vertical_executor.go`:

```go
package services

import (
	"context"
	"fmt"
	"io"
	"math"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)

// Consumer-defined dependency interfaces (mirror the hedge executor's split).
type verticalChainFetcher interface {
	GetOptionSnapshot(ctx context.Context, optionSymbol string) (*interfaces.OptionContract, error)
}
type verticalBarFetcher interface {
	GetLatestBar(ctx context.Context, symbol string) (*interfaces.Bar, error)
}
type verticalMlegTrader interface {
	PlaceMultiLegOrder(ctx context.Context, order MultiLegOrder) (string, error)
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
}
type verticalGuard interface {
	CheckOptionsOpen(agent AgentSource, underlying, symbol string, quote *interfaces.OptionsQuote, now time.Time) error
}

// PlaceVerticalRequest is the fully-specified vertical Phase 3's tools submit.
// Strikes/symbols come from the (Phase 3) proposal record; Place re-prices the
// exact legs at execution time and enforces the guards — never re-derives.
type PlaceVerticalRequest struct {
	Underlying  string
	Expiration  time.Time
	Direction   VerticalDirection
	LongSymbol  string
	LongStrike  float64
	ShortSymbol string
	ShortStrike float64
}

// VerticalTickResult is the per-tick outcome cached by the scheduler.
type VerticalTickResult struct {
	Date      string   `json:"date"`
	OpenCount int      `json:"open_count"`
	Closed    []string `json:"closed,omitempty"`
	Skips     []string `json:"skips,omitempty"`
	Errors    []string `json:"errors,omitempty"`
}

type ProphetVerticalExecutor struct {
	ledger *ProphetVerticalLedger
	chain  verticalChainFetcher
	bars   verticalBarFetcher
	trader verticalMlegTrader
	guard  verticalGuard
	logger *logrus.Logger
}

func NewProphetVerticalExecutor(ledger *ProphetVerticalLedger, chain verticalChainFetcher, bars verticalBarFetcher, trader verticalMlegTrader, guard verticalGuard, logger *logrus.Logger) *ProphetVerticalExecutor {
	if logger == nil {
		logger = logrus.New()
		logger.SetOutput(io.Discard)
	}
	return &ProphetVerticalExecutor{ledger: ledger, chain: chain, bars: bars, trader: trader, guard: guard, logger: logger}
}

// legQuote adapts an option snapshot to the guard's OptionsQuote input.
func legQuote(c *interfaces.OptionContract, now time.Time) *interfaces.OptionsQuote {
	return &interfaces.OptionsQuote{Symbol: c.Symbol, BidPrice: c.Bid, AskPrice: c.Ask, Timestamp: now}
}

// Place submits the opening debit combo for an LLM-confirmed vertical.
// Fail-closed: any missing quote, guard rejection, or cap breach returns an
// error with NO order placed and NO row persisted.
func (e *ProphetVerticalExecutor) Place(ctx context.Context, req PlaceVerticalRequest, now time.Time) (string, error) {
	long, err := e.chain.GetOptionSnapshot(ctx, req.LongSymbol)
	if err != nil || long == nil {
		return "", fmt.Errorf("place vertical: long leg snapshot unavailable: %w", err)
	}
	short, err := e.chain.GetOptionSnapshot(ctx, req.ShortSymbol)
	if err != nil || short == nil {
		return "", fmt.Errorf("place vertical: short leg snapshot unavailable: %w", err)
	}

	longMid := (long.Bid + long.Ask) / 2
	shortMid := (short.Bid + short.Ask) / 2
	width := math.Abs(req.LongStrike - req.ShortStrike)
	// Positive = net DEBIT we pay (Alpaca mleg convention), capped at intrinsic width.
	debit := verticalDebitLimit(longMid, shortMid, long.Ask-long.Bid, short.Ask-short.Bid, width, verticalLimitBufferFrac)
	if debit <= 0 {
		return "", fmt.Errorf("place vertical: non-positive net debit %.2f — not a debit spread at current quotes", debit)
	}
	if debit*100*float64(verticalContracts) > verticalDebitCapUSD {
		return "", fmt.Errorf("place vertical: debit cap — $%.0f exceeds $%.0f per-vertical max loss cap", debit*100, verticalDebitCapUSD)
	}

	if e.guard != nil {
		for _, leg := range []*interfaces.OptionContract{long, short} {
			if err := e.guard.CheckOptionsOpen(AgentMain, req.Underlying, leg.Symbol, legQuote(leg, now), now); err != nil {
				return "", fmt.Errorf("place vertical: guard blocked %s: %w", leg.Symbol, err)
			}
		}
	}

	orderID, err := e.trader.PlaceMultiLegOrder(ctx, MultiLegOrder{
		Underlying: req.Underlying, Contracts: verticalContracts, TimeInForce: "day",
		Strategy: verticalStrategyTag, LimitPrice: debit,
		Legs: []MultiLegOrderLeg{
			{Symbol: req.LongSymbol, Side: "buy", PositionIntent: "buy_to_open"},
			{Symbol: req.ShortSymbol, Side: "sell", PositionIntent: "sell_to_open"},
		},
	})
	if err != nil {
		return "", fmt.Errorf("place vertical: %w", err)
	}

	maxLoss, maxGain, breakeven := verticalEconomics(req.Direction, req.LongStrike, req.ShortStrike, debit)
	_ = maxLoss // TotalDebit below IS the max loss
	sp := &models.DBProphetVerticalSpread{
		VerticalID: fmt.Sprintf("vert-%d", now.UnixNano()),
		Underlying: req.Underlying, Direction: string(req.Direction), Expiration: req.Expiration,
		LongSymbol: req.LongSymbol, LongStrike: req.LongStrike,
		ShortSymbol: req.ShortSymbol, ShortStrike: req.ShortStrike,
		Contracts: verticalContracts, NetDebitPerContract: debit,
		TotalDebit: debit * 100 * float64(verticalContracts),
		MaxGain:    maxGain * float64(verticalContracts), Breakeven: breakeven,
		EntryOrderID: orderID, Status: "pending_fill",
	}
	if err := e.ledger.Save(sp); err != nil {
		return "", fmt.Errorf("place vertical: order %s submitted but row save failed: %w", orderID, err)
	}
	return sp.VerticalID, nil
}
```

Note: Phase 1's `verticalEconomics` returns per-contract values for 1 contract; `MaxGain` scales by `verticalContracts` (=1 in v1) for forward-compatibility.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestPlace_ -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_executor.go services/prophet_vertical_executor_test.go
git commit -m "feat(prophet-vertical): executor Place — per-leg guard, debit cap, positive-debit mleg combo, pending_fill row"
```

---

### Task 4: Executor — `reconcilePending` + entry snapshot

**Files:**
- Modify: `services/prophet_vertical_executor.go`
- Test: `services/prophet_vertical_executor_test.go` (append)

- [ ] **Step 1: Write the failing test** — append:

```go
func pendingRow(store *fakeVerticalStore) *models.DBProphetVerticalSpread {
	sp := &models.DBProphetVerticalSpread{
		VerticalID: "v1", Underlying: "AMZN", Direction: "call_debit",
		Expiration:  time.Now().Add(35 * 24 * time.Hour),
		LongSymbol:  "AMZN260717C00240000", LongStrike: 240,
		ShortSymbol: "AMZN260717C00260000", ShortStrike: 260,
		Contracts: 1, NetDebitPerContract: 5.15, TotalDebit: 515,
		EntryOrderID: "o1", Status: "pending_fill",
	}
	_ = store.SaveProphetVerticalSpread(sp)
	return sp
}

func TestReconcilePending_FilledOpensAndSnapshots(t *testing.T) {
	store := newFakeVerticalStore()
	avg := 5.0
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "filled", FilledQty: 1, FilledAvgPrice: &avg},
	}}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 245.0}}}
	ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, bars, mleg, &vertStubGuard{})
	pendingRow(store)

	res := &VerticalTickResult{}
	ex.RunManageTick(context.Background(), time.Now(), res)

	sp := store.spreads["v1"]
	if sp.Status != "open" {
		t.Fatalf("filled entry must open, got %s (errors: %v)", sp.Status, res.Errors)
	}
	if !almostEqual(sp.NetDebitPerContract, 5.0, 1e-9) || !almostEqual(sp.TotalDebit, 500, 1e-9) {
		t.Fatalf("fill economics not updated: %+v", sp)
	}
	if !almostEqual(sp.MaxGain, (20-5.0)*100, 1e-9) {
		t.Fatalf("MaxGain not recomputed from fill debit: %v", sp.MaxGain)
	}
	if sp.EntrySpot != 245.0 || sp.EntryLongVol != 0.35 || sp.EntryShortVol != 0.32 || sp.EntryTimeToExpiry <= 0 {
		t.Fatalf("entry snapshot not captured: %+v", sp)
	}
	if sp.OpenedAt.IsZero() {
		t.Fatal("OpenedAt must be set on fill")
	}
}

func TestReconcilePending_CanceledFails_NeverSingleLeg(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "canceled", FilledQty: 0},
	}}
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, mleg, &vertStubGuard{})
	pendingRow(store)
	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})
	if s := store.spreads["v1"].Status; s != "failed" {
		t.Fatalf("canceled entry must become failed (never open/single-leg), got %s", s)
	}
}

func TestReconcilePending_StillWorkingLeavesPending(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "accepted"},
	}}
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, mleg, &vertStubGuard{})
	pendingRow(store)
	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})
	if s := store.spreads["v1"].Status; s != "pending_fill" {
		t.Fatalf("working order must stay pending_fill, got %s", s)
	}
}

func TestReconcilePending_DegradedFeedStillOpens(t *testing.T) {
	// Missing bar/snapshots must NOT block the open transition — snapshot
	// fields stay zero (attribution degrades; Residual absorbs).
	store := newFakeVerticalStore()
	avg := 5.0
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"o1": {ID: "o1", Status: "filled", FilledQty: 1, FilledAvgPrice: &avg},
	}}
	ex, _ := newVertExec(store, vertStubChain{snaps: map[string]*interfaces.OptionContract{}}, vertStubBars{}, mleg, &vertStubGuard{})
	pendingRow(store)
	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})
	sp := store.spreads["v1"]
	if sp.Status != "open" {
		t.Fatalf("degraded feed must not block the open, got %s", sp.Status)
	}
	if sp.EntrySpot != 0 || sp.EntryLongVol != 0 {
		t.Fatalf("degraded snapshot fields must stay zero: %+v", sp)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestReconcilePending -v`
Expected: FAIL — `RunManageTick` undefined.

- [ ] **Step 3: Implement.** Append to `services/prophet_vertical_executor.go`:

```go
// RunManageTick is the scheduler-driven heartbeat: reconcile in-flight orders
// first, then manage open verticals (Task 6 adds manageOpen). res accumulates
// the per-tick outcome for LastResult/status.
func (e *ProphetVerticalExecutor) RunManageTick(ctx context.Context, now time.Time, res *VerticalTickResult) {
	res.Date = now.In(nyLoc).Format("2006-01-02")
	open, err := e.ledger.ListOpen()
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("list open: %v", err))
		return
	}
	for _, sp := range open {
		switch sp.Status {
		case "pending_fill":
			e.reconcilePending(ctx, sp, now, res)
		case "closing":
			e.reconcileClosing(ctx, sp, now, res)
		}
	}
	e.manageOpen(ctx, open, now, res)
	if fresh, err := e.ledger.ListOpen(); err == nil {
		res.OpenCount = len(fresh)
	}
}

// reconcilePending transitions a pending_fill vertical by broker order state.
// mleg combos are ATOMIC: "filled" means N complete spreads — never a half-
// spread — so the ledger can never hold a single-leg position.
func (e *ProphetVerticalExecutor) reconcilePending(ctx context.Context, sp *models.DBProphetVerticalSpread, now time.Time, res *VerticalTickResult) {
	if sp.EntryOrderID == "" {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: empty EntryOrderID", sp.VerticalID))
		return
	}
	ord, err := e.trader.GetOrder(ctx, sp.EntryOrderID)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: GetOrder: %v", sp.VerticalID, err))
		return
	}
	switch ord.Status {
	case "filled", "partially_filled":
		if ord.FilledAvgPrice == nil || ord.FilledQty < 1 {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: %s with nil/0 fill — leaving pending", sp.VerticalID, ord.Status))
			return
		}
		fillDebit := *ord.FilledAvgPrice
		sp.Status = "open"
		sp.Contracts = int(ord.FilledQty)
		sp.NetDebitPerContract = fillDebit
		sp.TotalDebit = fillDebit * 100 * float64(sp.Contracts)
		_, maxGain, breakeven := verticalEconomics(VerticalDirection(sp.Direction), sp.LongStrike, sp.ShortStrike, fillDebit)
		sp.MaxGain = maxGain * float64(sp.Contracts)
		sp.Breakeven = breakeven
		sp.OpenedAt = now
		e.captureEntrySnapshot(ctx, sp, now)
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save open: %v", sp.VerticalID, err))
		}
	case "canceled", "expired", "rejected":
		sp.Status = "failed"
		sp.CloseReason = "reconciled"
		t := now
		sp.ClosedAt = &t
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile %s: save failed: %v", sp.VerticalID, err))
		}
	default:
		// new/accepted/pending_new — still working; leave pending_fill.
	}
}

// captureEntrySnapshot best-effort fills the attribution baseline at fill
// detection. Missing data leaves zero fields (degraded attribution, never a
// blocked transition).
func (e *ProphetVerticalExecutor) captureEntrySnapshot(ctx context.Context, sp *models.DBProphetVerticalSpread, now time.Time) {
	if bar, err := e.bars.GetLatestBar(ctx, sp.Underlying); err == nil && bar != nil {
		sp.EntrySpot = bar.Close
	}
	if long, err := e.chain.GetOptionSnapshot(ctx, sp.LongSymbol); err == nil && long != nil {
		sp.EntryLongVol = long.ImpliedVolatility
	}
	if short, err := e.chain.GetOptionSnapshot(ctx, sp.ShortSymbol); err == nil && short != nil {
		sp.EntryShortVol = short.ImpliedVolatility
	}
	sp.EntryTimeToExpiry = sp.Expiration.Sub(now).Hours() / 24 / 365
}
```

Also add these two stubs so the file compiles before Tasks 5–6 (replaced there):

```go
func (e *ProphetVerticalExecutor) reconcileClosing(ctx context.Context, sp *models.DBProphetVerticalSpread, now time.Time, res *VerticalTickResult) {
}
func (e *ProphetVerticalExecutor) manageOpen(ctx context.Context, open []*models.DBProphetVerticalSpread, now time.Time, res *VerticalTickResult) {
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'TestReconcilePending|TestPlace_' -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_executor.go services/prophet_vertical_executor_test.go
git commit -m "feat(prophet-vertical): reconcilePending — fill->open + entry snapshot, canceled->failed, atomic-combo invariant"
```

---

### Task 5: Executor — fail-closed close (`closeVertical` + `reconcileClosing`)

**Files:**
- Modify: `services/prophet_vertical_executor.go` (replace the `reconcileClosing` stub)
- Test: `services/prophet_vertical_executor_test.go` (append)

- [ ] **Step 1: Write the failing test** — append:

```go
func openRow(store *fakeVerticalStore) *models.DBProphetVerticalSpread {
	sp := &models.DBProphetVerticalSpread{
		VerticalID: "v1", Underlying: "AMZN", Direction: "call_debit",
		Expiration:  time.Now().Add(35 * 24 * time.Hour),
		LongSymbol:  "AMZN260717C00240000", LongStrike: 240,
		ShortSymbol: "AMZN260717C00260000", ShortStrike: 260,
		Contracts: 1, NetDebitPerContract: 5.0, TotalDebit: 500, MaxGain: 1500,
		EntrySpot: 245, EntryLongVol: 0.35, EntryShortVol: 0.32, EntryTimeToExpiry: 35.0 / 365,
		Status: "open", OpenedAt: time.Now().Add(-48 * time.Hour),
	}
	_ = store.SaveProphetVerticalSpread(sp)
	return sp
}

func TestCloseVertical_MarketComboAndClosingState(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, vertStubBars{}, mleg, &vertStubGuard{})
	sp := openRow(store)

	ex.closeVertical(context.Background(), sp, "force_close", &VerticalTickResult{})

	if len(mleg.placed) != 1 {
		t.Fatalf("want 1 close combo, got %d", len(mleg.placed))
	}
	o := mleg.placed[0].order
	// SIGN-HAZARD GUARD: a close RECEIVES credit; per Alpaca (positive=debit)
	// a positive limit here would mean "willing to pay". v1 closes at MARKET.
	if o.LimitPrice != 0 {
		t.Fatalf("close must be a market combo (LimitPrice==0), got %v", o.LimitPrice)
	}
	if len(o.Legs) != 2 ||
		o.Legs[0].Symbol != sp.LongSymbol || o.Legs[0].Side != "sell" || o.Legs[0].PositionIntent != "sell_to_close" ||
		o.Legs[1].Symbol != sp.ShortSymbol || o.Legs[1].Side != "buy" || o.Legs[1].PositionIntent != "buy_to_close" {
		t.Fatalf("close legs wrong: %+v", o.Legs)
	}
	if o.Strategy != verticalStrategyTag {
		t.Fatalf("close must carry the vertical tag, got %q", o.Strategy)
	}
	if sp.Status != "closing" || sp.CloseOrderID != "mleg-vert" || sp.CloseReason != "force_close" {
		t.Fatalf("row not flipped to closing: %+v", sp)
	}
}

func TestReconcileClosing_FilledClosesWithPnLAndAttribution(t *testing.T) {
	store := newFakeVerticalStore()
	avg := 8.0 // close proceeds 8.00/share → realized = 800 − 500 = +300
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"c1": {ID: "c1", Status: "filled", FilledQty: 1, FilledAvgPrice: &avg},
	}}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 258.0}}}
	ex, _ := newVertExec(store, vertStubChain{snaps: amznCallSnaps()}, bars, mleg, &vertStubGuard{})
	sp := openRow(store)
	sp.Status = "closing"
	sp.CloseOrderID = "c1"
	sp.CloseReason = "llm_requested"

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "closed" {
		t.Fatalf("filled close must finalize closed, got %s", sp.Status)
	}
	if !almostEqual(sp.RealizedPnL, 300, 1e-9) {
		t.Fatalf("realized = %v, want 300", sp.RealizedPnL)
	}
	if sp.ClosedAt == nil {
		t.Fatal("ClosedAt must be set")
	}
	sum := sp.AttribDirection + sp.AttribTheta + sp.AttribIV + sp.AttribResidual
	if !almostEqual(sum, sp.RealizedPnL, 1e-6) {
		t.Fatalf("attribution components must reconcile to realized P&L: sum=%v realized=%v", sum, sp.RealizedPnL)
	}
	if sp.AttribDirection == 0 && sp.AttribTheta == 0 && sp.AttribIV == 0 {
		t.Fatal("attribution must be computed (non-degenerate inputs)")
	}
}

func TestReconcileClosing_CanceledRevertsToOpen_NeverStranded(t *testing.T) {
	// THE fail-closed test: a canceled/rejected close must revert to open
	// (retry next tick) — NEVER closed, NEVER stuck in closing.
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"c1": {ID: "c1", Status: "canceled"},
	}}
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, mleg, &vertStubGuard{})
	sp := openRow(store)
	sp.Status = "closing"
	sp.CloseOrderID = "c1"

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "open" {
		t.Fatalf("canceled close must revert to open (never closed/stranded), got %s", sp.Status)
	}
	if sp.CloseOrderID != "" {
		t.Fatal("CloseOrderID must be cleared on revert")
	}
}

func TestReconcileClosing_NilFillPriceStaysClosing(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{orders: map[string]*interfaces.Order{
		"c1": {ID: "c1", Status: "filled", FilledQty: 1, FilledAvgPrice: nil},
	}}
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, mleg, &vertStubGuard{})
	sp := openRow(store)
	sp.Status = "closing"
	sp.CloseOrderID = "c1"
	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})
	if sp.Status != "closing" {
		t.Fatalf("nil fill price must leave closing (retry), got %s", sp.Status)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run 'TestCloseVertical|TestReconcileClosing' -v`
Expected: FAIL — `closeVertical` undefined / `reconcileClosing` stub does nothing.

- [ ] **Step 3: Implement.** Replace the `reconcileClosing` stub in `services/prophet_vertical_executor.go` with:

```go
// closeVertical places the reverse atomic combo AT MARKET (LimitPrice 0 —
// mirrors hedge closeSpread; per Alpaca's sign convention a positive limit on
// a credit-receiving close would mean "willing to pay") and flips the row to
// "closing". Fail-closed: ONLY reconcileClosing marks the row closed, after
// the broker confirms the fill.
func (e *ProphetVerticalExecutor) closeVertical(ctx context.Context, sp *models.DBProphetVerticalSpread, reason string, res *VerticalTickResult) {
	id, err := e.trader.PlaceMultiLegOrder(ctx, MultiLegOrder{
		Underlying: sp.Underlying, Contracts: sp.Contracts, TimeInForce: "day",
		Strategy: verticalStrategyTag,
		Legs: []MultiLegOrderLeg{
			{Symbol: sp.LongSymbol, Side: "sell", PositionIntent: "sell_to_close"},
			{Symbol: sp.ShortSymbol, Side: "buy", PositionIntent: "buy_to_close"},
		},
	})
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("close %s (%s): %v", sp.VerticalID, reason, err))
		return
	}
	sp.Status = "closing"
	sp.CloseReason = reason
	sp.CloseOrderID = id
	if err := e.ledger.Save(sp); err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("close %s: save: %v", sp.VerticalID, err))
		return
	}
	res.Closed = append(res.Closed, sp.VerticalID)
}

// reconcileClosing finalizes a vertical whose close combo filled: realized P&L
// = close proceeds − TotalDebit, plus the direction/theta/IV attribution from
// the stored entry snapshot vs the exit snapshot captured now. A canceled/
// rejected close REVERTS to "open" so manageOpen retries next tick — never
// strand a position in limbo (the fail-closed carry-forward).
func (e *ProphetVerticalExecutor) reconcileClosing(ctx context.Context, sp *models.DBProphetVerticalSpread, now time.Time, res *VerticalTickResult) {
	if sp.CloseOrderID == "" {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: empty CloseOrderID", sp.VerticalID))
		return
	}
	ord, err := e.trader.GetOrder(ctx, sp.CloseOrderID)
	if err != nil {
		res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: GetOrder: %v", sp.VerticalID, err))
		return
	}
	switch ord.Status {
	case "filled", "partially_filled":
		if ord.FilledAvgPrice == nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: %s with nil fill — leaving closing", sp.VerticalID, ord.Status))
			return
		}
		proceeds := *ord.FilledAvgPrice * 100 * float64(sp.Contracts)
		sp.RealizedPnL = proceeds - sp.TotalDebit
		sp.Status = "closed"
		t := now
		sp.ClosedAt = &t
		e.attributeClose(ctx, sp, now)
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: save closed: %v", sp.VerticalID, err))
		}
	case "canceled", "expired", "rejected":
		sp.Status = "open"
		sp.CloseOrderID = ""
		if err := e.ledger.Save(sp); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("reconcile-close %s: save revert: %v", sp.VerticalID, err))
		}
	default:
		// still working — leave closing
	}
}

// attributeClose computes the teaching decomposition at close-fill detection.
// Best-effort: degraded inputs produce degraded components; Residual always
// reconciles the model to the realized fill P&L.
func (e *ProphetVerticalExecutor) attributeClose(ctx context.Context, sp *models.DBProphetVerticalSpread, now time.Time) {
	exit := VerticalSnapshot{TimeToExpiry: sp.Expiration.Sub(now).Hours() / 24 / 365}
	if bar, err := e.bars.GetLatestBar(ctx, sp.Underlying); err == nil && bar != nil {
		exit.Spot = bar.Close
	}
	if long, err := e.chain.GetOptionSnapshot(ctx, sp.LongSymbol); err == nil && long != nil {
		exit.LongVol = long.ImpliedVolatility
	}
	if short, err := e.chain.GetOptionSnapshot(ctx, sp.ShortSymbol); err == nil && short != nil {
		exit.ShortVol = short.ImpliedVolatility
	}
	entry := VerticalSnapshot{
		Spot: sp.EntrySpot, LongVol: sp.EntryLongVol, ShortVol: sp.EntryShortVol,
		TimeToExpiry: sp.EntryTimeToExpiry,
	}
	a := attributeVerticalPnl(VerticalDirection(sp.Direction), sp.LongStrike, sp.ShortStrike, entry, exit, sp.RealizedPnL, sp.Contracts)
	sp.AttribDirection, sp.AttribTheta, sp.AttribIV, sp.AttribResidual = a.Direction, a.Theta, a.IV, a.Residual
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'TestCloseVertical|TestReconcileClosing' -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_executor.go services/prophet_vertical_executor_test.go
git commit -m "feat(prophet-vertical): fail-closed two-phase close — market combo (LimitPrice 0), closed only on confirmed fill, canceled reverts to open, attribution at close"
```

---

### Task 6: Executor — `manageOpen` + `RequestClose`

**Files:**
- Modify: `services/prophet_vertical_executor.go` (replace the `manageOpen` stub)
- Test: `services/prophet_vertical_executor_test.go` (append)

- [ ] **Step 1: Write the failing test** — append:

```go
// snapsWithMids returns leg snapshots with the given per-share mids (BA ±0.10).
func snapsWithMids(longMid, shortMid float64) map[string]*interfaces.OptionContract {
	return map[string]*interfaces.OptionContract{
		"AMZN260717C00240000": {Symbol: "AMZN260717C00240000", ContractType: "call", StrikePrice: 240, Bid: longMid - 0.10, Ask: longMid + 0.10, ImpliedVolatility: 0.30},
		"AMZN260717C00260000": {Symbol: "AMZN260717C00260000", ContractType: "call", StrikePrice: 260, Bid: shortMid - 0.10, Ask: shortMid + 0.10, ImpliedVolatility: 0.28},
	}
}

func TestManageOpen_CloseRequestedClosesLLMReason(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 250.0}}}
	ex, _ := newVertExec(store, vertStubChain{snaps: snapsWithMids(7.0, 2.0)}, bars, mleg, &vertStubGuard{})
	sp := openRow(store)
	sp.CloseRequested = true

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "closing" || sp.CloseReason != "llm_requested" {
		t.Fatalf("CloseRequested must close with llm_requested, got %s/%s", sp.Status, sp.CloseReason)
	}
}

func TestManageOpen_ForceCloseAtDTEFloor(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 250.0}}} // between strikes
	ex, _ := newVertExec(store, vertStubChain{snaps: snapsWithMids(10.2, 0.1)}, bars, mleg, &vertStubGuard{})
	sp := openRow(store)
	sp.Expiration = time.Now().Add(36 * time.Hour) // DTE 1 ≤ force 2

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "closing" || sp.CloseReason != "force_close" {
		t.Fatalf("DTE≤floor must force-close, got %s/%s", sp.Status, sp.CloseReason)
	}
}

func TestManageOpen_LetExpireCarveOutHolds(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 230.0}}} // both legs OTM
	// residual value: mids 0.03/0.01 → value $2 ≤ $5 expected exit cost
	ex, _ := newVertExec(store, vertStubChain{snaps: snapsWithMids(0.03, 0.01)}, bars, mleg, &vertStubGuard{})
	sp := openRow(store)
	sp.Expiration = time.Now().Add(36 * time.Hour)

	res := &VerticalTickResult{}
	ex.RunManageTick(context.Background(), time.Now(), res)

	if sp.Status != "open" || len(mleg.placed) != 0 {
		t.Fatalf("worthless both-OTM spread must ride to expiry (let_expire), got %s, %d orders", sp.Status, len(mleg.placed))
	}
}

func TestManageOpen_HealthyHolds(t *testing.T) {
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	bars := vertStubBars{bars: map[string]*interfaces.Bar{"AMZN": {Close: 250.0}}}
	ex, _ := newVertExec(store, vertStubChain{snaps: snapsWithMids(7.0, 2.0)}, bars, mleg, &vertStubGuard{})
	openRow(store) // DTE ~35, value $500 (healthy)

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if len(mleg.placed) != 0 {
		t.Fatal("healthy vertical must hold (no close order)")
	}
}

func TestManageOpen_BlindNearExpiryForceCloses(t *testing.T) {
	// Degraded feed (no snapshots/spot) at the DTE floor: close protectively
	// rather than ride blind into expiry.
	store := newFakeVerticalStore()
	mleg := &vertStubMleg{}
	ex, _ := newVertExec(store, vertStubChain{snaps: map[string]*interfaces.OptionContract{}}, vertStubBars{}, mleg, &vertStubGuard{})
	sp := openRow(store)
	sp.Expiration = time.Now().Add(36 * time.Hour)

	ex.RunManageTick(context.Background(), time.Now(), &VerticalTickResult{})

	if sp.Status != "closing" || sp.CloseReason != "force_close" {
		t.Fatalf("blind near-expiry must force-close, got %s/%s", sp.Status, sp.CloseReason)
	}
}

func TestRequestClose_SetsFlag(t *testing.T) {
	store := newFakeVerticalStore()
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, &vertStubMleg{}, &vertStubGuard{})
	sp := openRow(store)
	if err := ex.RequestClose(context.Background(), sp.VerticalID); err != nil {
		t.Fatalf("request close: %v", err)
	}
	if !store.spreads["v1"].CloseRequested {
		t.Fatal("CloseRequested must be persisted")
	}
	if err := ex.RequestClose(context.Background(), "nope"); err == nil {
		t.Fatal("unknown vertical must error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run 'TestManageOpen|TestRequestClose' -v`
Expected: FAIL — `manageOpen` stub does nothing / `RequestClose` undefined.

- [ ] **Step 3: Implement.** Replace the `manageOpen` stub with:

```go
// verticalValue prices the spread at current quotes: (longMid − shortMid)
// × 100 × contracts. valued=false on any missing leg quote.
func (e *ProphetVerticalExecutor) verticalValue(ctx context.Context, sp *models.DBProphetVerticalSpread) (float64, bool) {
	long, err := e.chain.GetOptionSnapshot(ctx, sp.LongSymbol)
	if err != nil || long == nil {
		return 0, false
	}
	short, err := e.chain.GetOptionSnapshot(ctx, sp.ShortSymbol)
	if err != nil || short == nil {
		return 0, false
	}
	longMid := (long.Bid + long.Ask) / 2
	shortMid := (short.Bid + short.Ask) / 2
	return (longMid - shortMid) * 100 * float64(sp.Contracts), true
}

// manageOpen applies the LLM close request and the deterministic backstops to
// every "open" vertical. Precedence lives in selectVerticalExit: the near-expiry
// both-legs-OTM branch evaluates FIRST (let_expire if residual ≤ exit cost,
// else force_close), then salvage → profit-capture → force-close.
// Degraded feed: if neither value nor spot is available we cannot evaluate the
// resolver — but at/under the force DTE we close protectively rather than ride
// blind into expiry; otherwise skip this tick.
func (e *ProphetVerticalExecutor) manageOpen(ctx context.Context, open []*models.DBProphetVerticalSpread, now time.Time, res *VerticalTickResult) {
	for _, sp := range open {
		if sp.Status != "open" {
			continue // pending_fill/closing handled by reconcile
		}
		if sp.CloseRequested {
			e.closeVertical(ctx, sp, "llm_requested", res)
			continue
		}
		var spot float64
		if bar, err := e.bars.GetLatestBar(ctx, sp.Underlying); err == nil && bar != nil {
			spot = bar.Close
		}
		value, valued := e.verticalValue(ctx, sp)
		dte := verticalDTE(sp.Expiration, now)
		if !valued || spot <= 0 {
			if dte <= verticalForceDTE {
				e.closeVertical(ctx, sp, "force_close", res)
			} else {
				res.Skips = append(res.Skips, fmt.Sprintf("%s: quotes unavailable — skipping tick", sp.VerticalID))
			}
			continue
		}
		state := VerticalState{
			Direction: VerticalDirection(sp.Direction), Spot: spot,
			LongStrike: sp.LongStrike, ShortStrike: sp.ShortStrike,
			CurrentValueTotal: value, MaxGainTotal: sp.MaxGain, TotalDebit: sp.TotalDebit,
			DTE: dte,
		}
		if reason, act := selectVerticalExit(state, verticalExitConfig()); act {
			e.closeVertical(ctx, sp, reason, res)
		}
	}
}

// RequestClose marks a vertical for LLM-initiated close; the next manage tick
// executes it through the same fail-closed closeVertical path as the backstops.
func (e *ProphetVerticalExecutor) RequestClose(_ context.Context, verticalID string) error {
	open, err := e.ledger.ListOpen()
	if err != nil {
		return fmt.Errorf("request close: %w", err)
	}
	for _, sp := range open {
		if sp.VerticalID == verticalID {
			sp.CloseRequested = true
			return e.ledger.Save(sp)
		}
	}
	return fmt.Errorf("request close: no live vertical %q", verticalID)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'TestManageOpen|TestRequestClose|TestReconcile|TestCloseVertical|TestPlace_' -v`
Expected: PASS (all executor tests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_vertical_executor.go services/prophet_vertical_executor_test.go
git commit -m "feat(prophet-vertical): manageOpen backstops via selectVerticalExit + RequestClose, blind-near-expiry protective close"
```

---

### Task 7: Config flag (default OFF)

**Files:**
- Modify: `config/config.go` (struct field near `EnableProphetDefensive` at `:47`; parse line near `:145`)
- Modify: `config/config_test.go` (append)

- [ ] **Step 1: Write the failing test** — append to `config/config_test.go` (mirror `TestLoadConfig_ProphetDefensiveDefaultsOff` at `:165`):

```go
func TestLoadConfig_ProphetDebitVerticalsDefaultsOff(t *testing.T) {
	t.Setenv("ENABLE_PROPHET_DEBIT_VERTICALS", "")
	LoadConfig()
	if AppConfig.EnableProphetDebitVerticals {
		t.Fatal("ENABLE_PROPHET_DEBIT_VERTICALS must default to false")
	}
	t.Setenv("ENABLE_PROPHET_DEBIT_VERTICALS", "true")
	LoadConfig()
	if !AppConfig.EnableProphetDebitVerticals {
		t.Fatal("ENABLE_PROPHET_DEBIT_VERTICALS=true must enable the flag")
	}
}
```

(Adjust the `LoadConfig()` call form to match how the neighboring defensive test invokes it — same file, same pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./config/ -run TestLoadConfig_ProphetDebitVerticals -v`
Expected: FAIL — field undefined.

- [ ] **Step 3: Implement.** In `config/config.go`, after the `EnableProphetDefensive` field:

```go
	// Prophet debit-vertical teaching sleeve (flag-gated rollout, default OFF).
	// When false the vertical executor/scheduler is never constructed in cmd/bot.
	EnableProphetDebitVerticals bool
```

and after the `EnableProphetDefensive:` parse line:

```go
		EnableProphetDebitVerticals: getEnvOrDefault("ENABLE_PROPHET_DEBIT_VERTICALS", "false") == "true",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./config/ -run TestLoadConfig_ProphetDebitVerticals -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config/config.go config/config_test.go
git commit -m "feat(prophet-vertical): ENABLE_PROPHET_DEBIT_VERTICALS flag, default OFF"
```

---

### Task 8: Scheduler + wiring + mleg comment fix + final verification

**Files:**
- Create: `services/prophet_vertical_scheduler.go`
- Test: `services/prophet_vertical_scheduler_test.go`
- Modify: `cmd/bot/main.go` (insert after the hedge block, ~`:437`)
- Modify: `services/mleg.go` (comment fix only)
- Modify: `.env.example` (document the flag)

- [ ] **Step 1: Write the failing test** — create `services/prophet_vertical_scheduler_test.go`:

```go
package services

import (
	"context"
	"testing"
	"time"
)

func TestVerticalScheduler_TicksAndCachesResult(t *testing.T) {
	store := newFakeVerticalStore()
	ex, _ := newVertExec(store, vertStubChain{}, vertStubBars{}, &vertStubMleg{}, &vertStubGuard{})
	s := NewProphetVerticalScheduler(ex, 5*time.Millisecond, 5*time.Millisecond, func() bool { return true }, nil)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Start(ctx); close(done) }()

	deadline := time.After(2 * time.Second)
	for s.LastResult() == nil {
		select {
		case <-deadline:
			t.Fatal("scheduler never ticked")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	<-done
	if s.LastResult().Date == "" {
		t.Fatal("tick result must carry a date")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestVerticalScheduler -v`
Expected: FAIL — `NewProphetVerticalScheduler` undefined.

- [ ] **Step 3: Implement.** Create `services/prophet_vertical_scheduler.go`:

```go
package services

import (
	"context"
	"io"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// ProphetVerticalScheduler drives the vertical executor's manage tick on an
// intraday cadence: every `interval` while marketIsOpen(), else `idleInterval`.
// Loop shape mirrors ProphetOptionsStopMonitor.Start (NOT the once-daily hedge
// scheduler). Opens are LLM-triggered via Phase 3; this loop only manages, so
// with an empty ledger it is a cheap no-op.
type ProphetVerticalScheduler struct {
	executor     *ProphetVerticalExecutor
	interval     time.Duration
	idleInterval time.Duration
	marketIsOpen func() bool
	logger       *logrus.Logger

	mu   sync.RWMutex
	last *VerticalTickResult
}

func NewProphetVerticalScheduler(exec *ProphetVerticalExecutor, interval, idleInterval time.Duration, marketIsOpen func() bool, logger *logrus.Logger) *ProphetVerticalScheduler {
	if logger == nil {
		logger = logrus.New()
		logger.SetOutput(io.Discard)
	}
	return &ProphetVerticalScheduler{
		executor: exec, interval: interval, idleInterval: idleInterval,
		marketIsOpen: marketIsOpen, logger: logger,
	}
}

// Start blocks until ctx is canceled.
func (s *ProphetVerticalScheduler) Start(ctx context.Context) {
	timer := time.NewTimer(s.interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			s.logger.Info("vertical-scheduler: context canceled, exiting")
			return
		case <-timer.C:
		}
		res := &VerticalTickResult{}
		s.executor.RunManageTick(ctx, time.Now(), res)
		s.mu.Lock()
		s.last = res
		s.mu.Unlock()
		if len(res.Closed) > 0 || len(res.Errors) > 0 {
			s.logger.WithFields(logrus.Fields{
				"open_count": res.OpenCount, "closed": res.Closed, "errors": res.Errors,
			}).Info("vertical-scheduler: tick")
		}
		next := s.interval
		if s.marketIsOpen != nil && !s.marketIsOpen() {
			next = s.idleInterval
		}
		timer.Reset(next)
	}
}

// LastResult returns the most recent tick result (nil before the first tick).
func (s *ProphetVerticalScheduler) LastResult() *VerticalTickResult {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.last
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestVerticalScheduler -v`
Expected: PASS.

- [ ] **Step 5: Wire `cmd/bot/main.go`.** Insert after the Defensive-Prophet block (after line `:436`'s closing `}`):

```go
	// Prophet debit-vertical manage loop (ENABLE_PROPHET_DEBIT_VERTICALS=false
	// by default). LLM-triggered opens arrive via the Phase-3 tools; this
	// intraday loop only reconciles fills and fires the deterministic backstops,
	// so with no verticals it is a no-op. Distinct "v2-vertical" strategy tag
	// keeps the options stop monitor away from vertical legs.
	if cfg.EnableProphetDebitVerticals && tradingService != nil {
		verticalLedger := services.NewProphetVerticalLedger(storageService)
		verticalOptionsData := services.NewAlpacaOptionsDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey)
		verticalExecutor := services.NewProphetVerticalExecutor(
			verticalLedger,
			verticalOptionsData,
			services.NewHedgeAccountFetcher(tradingService, dataService), // GetLatestBar provider
			tradingService,
			tradeGuard,
			logger,
		)
		nyLocVert, _ := time.LoadLocation("America/New_York")
		verticalMarketOpen := func() bool { return services.StaticMarketPhase(time.Now().UTC(), nyLocVert) == "open" }
		verticalScheduler := services.NewProphetVerticalScheduler(verticalExecutor, services.VerticalTickInterval(), services.VerticalIdleInterval(), verticalMarketOpen, logger)
		go verticalScheduler.Start(ctx)
		logger.Info("Prophet debit-vertical scheduler started (ENABLE_PROPHET_DEBIT_VERTICALS=true)")
	} else if cfg.EnableProphetDebitVerticals {
		logger.Warn("Prophet debit-verticals requested but trading service unavailable — scheduler not started")
	}
```

The constants are unexported, so add two tiny accessors at the bottom of `services/prophet_vertical_constants.go`:

```go
// VerticalTickInterval / VerticalIdleInterval expose the cadence to cmd/bot.
func VerticalTickInterval() time.Duration { return verticalTickInterval }
func VerticalIdleInterval() time.Duration { return verticalIdleInterval }
```

Check `time` is imported in `cmd/bot/main.go` (it is — the stop-monitor block uses it).

- [ ] **Step 6: Fix the stale `services/mleg.go` comment.** Replace:

```go
	LimitPrice  float64 // net credit limit (positive = we receive credit)
```

with:

```go
	// LimitPrice is passed straight through to Alpaca's mleg limit_price.
	// Alpaca convention (Options Level 3 docs): POSITIVE = net debit we pay,
	// NEGATIVE = net credit we receive, 0 = market combo. (An earlier comment
	// here said positive=credit — that was Harvest-era legacy and wrong.)
	LimitPrice float64
```

- [ ] **Step 7: Document the flag in `.env.example`.** After the `ENABLE_PROPHET_DEFENSIVE` entry, add:

```bash
# Prophet debit-vertical teaching sleeve (Phase 2: manage loop only; Phase 3
# adds the LLM tools that open positions). Default OFF.
ENABLE_PROPHET_DEBIT_VERTICALS=false
```

- [ ] **Step 8: Final verification**

Run: `go build ./... && go vet ./services/ ./database/ ./config/ ./cmd/... && go test ./services/ ./database/ ./config/`
Expected: build + vet clean; all packages `ok` (the known-flaky unrelated `TestAggregator_Composite` excepted).

- [ ] **Step 9: Commit**

```bash
git add services/prophet_vertical_scheduler.go services/prophet_vertical_scheduler_test.go services/prophet_vertical_constants.go cmd/bot/main.go services/mleg.go .env.example
git commit -m "feat(prophet-vertical): intraday scheduler + flag-gated main.go wiring + mleg LimitPrice sign-convention comment fix"
```

---

## Self-Review

**1. Spec coverage:** model+AutoMigrate+storage (T1), constants incl. debit cap + ledger (T2), Place w/ per-leg guard + positive-debit limit + cap (T3), reconcilePending + fill-detection entry snapshot + atomic-combo invariant (T4), market-close + fail-closed reconcileClosing + attribution-at-close (T5), manageOpen backstops + let-expire carve-out + blind-near-expiry protective close + RequestClose (T6), flag default-OFF (T7), stop-monitor-shaped scheduler + LastResult + wiring + mleg comment fix + .env.example (T8). Spec §9 leftovers all addressed: comment fix (T8), `stopMarketOpen`-style gate (T8 wiring), IV degradation path (T4/T5 best-effort capture), `LastResult` built (T8). The per-vertical debit cap (feature-spec §5 guardrail, absent from the Phase-2 spec's constants) is resolved here as `verticalDebitCapUSD` enforced in `Place` — keeps "no parallel uncapped path" without needing an account fetcher.

**2. Placeholder scan:** none; every step has complete code and exact commands. The Task-4 `reconcileClosing`/`manageOpen` empty stubs are explicit compile shims replaced by Tasks 5–6 (stated inline).

**3. Type consistency:** `VerticalTickResult` (T3) used in T4–T8; `fakeVerticalStore` (T2) used in T3–T8; stub names (`vertStubChain`/`vertStubBars`/`vertStubMleg`/`vertStubGuard`, `newVertExec`) defined once in T3 and reused; `verticalExitConfig()` (T2) consumed in T6; `RunManageTick(ctx, now, res)` signature consistent (T4 def, T5/T6/T8 use); model field names in T1 match every later read/write; Phase-1 names (`VerticalDirection`, `verticalEconomics`, `verticalDebitLimit`, `verticalDTE`, `VerticalState`, `VerticalExitConfig`, `selectVerticalExit`, `VerticalSnapshot`, `attributeVerticalPnl`, `almostEqual`) match the merged Phase-1 code.

**Known judgment calls (documented, not placeholders):** `RunManageTick` takes `res` as a parameter (vs returning it) so reconcile and manage share one accumulator — minor deviation from hedge's `RunHeartbeat() (*HedgeResult, error)`, simpler for the scheduler. `RequestClose` searches `ListOpen` by `VerticalID` string (no new storage method needed). Exported `VerticalTickInterval()`/`VerticalIdleInterval()` accessors keep constants unexported while letting `cmd/bot` wire them.
