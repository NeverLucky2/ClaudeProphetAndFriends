# Orphan Surfacing + Auto-Flatten Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing orphan (stuck-exit) detection visible to the operator (Layer A: status endpoint + Node poller + Slack alert), and add an opt-in, dedicated-account-gated auto-flatten that liquidates a confirmed orphan (Layer B).

**Architecture:** Reuse the existing `findOrphans` detector as the single source of truth — no second detector. Layer A adds a read-only `OrphanStatus()` snapshot, an HTTP endpoint mirroring `SleeveController`, a Node poller mirroring the reconciliation sweep, and orphan events on the existing Slack `notifyOn` channel. Layer B adds a streak/latch state machine inside the existing ~60s `reconcileWithBroker` loop that, behind two independent flags, market-flattens a long orphan via the broker's `ClosePosition` primitive.

**Tech Stack:** Go 1.26 (`go test ./...`), Node ESM with `node:test` (`npm test`), gin HTTP, Alpaca API.

## Global Constraints

- **Auto-flatten (Layer B) acts ONLY when BOTH `EnableOrphanAutoFlatten` AND `OrphanAutoFlattenAccountIsDedicated` are true.** Enabling without affirming dedicated is inert (log once at startup, then behave as off). Fail-closed: the safe state of an un-affirmed money action is inaction.
- **Never block an exit / never sell what isn't ours.** Auto-flatten only ever calls `ClosePosition` on a **long** orphan (broker qty > 0) that `findOrphans` flagged — a symbol the broker holds where THIS bot's ledger has a terminal record and no live record. Short orphans are alerted, never covered.
- **Fail-closed on uncertainty:** market closed → don't sell; pre-flatten broker re-read fails → don't sell; either gate unset → don't sell.
- **One attempt per process, then latch.** A fired flatten is never re-submitted within the process. `orphanStreak`/`flattenLatched` are in-memory and reset on restart (deliberate — see spec "Restart behavior").
- **A real-money sell must leave a ledger trace:** on a successful flatten, append `orphan_autoflattened:<qty>@<orderID>` to the terminal record's `Notes` and persist.
- **Alert dedup:** the loud alert (Slack + `operator_review_required` log) fires once per newly-detected orphan symbol, cleared on resolution — never once per poll.
- **`OrphanStatus()` snapshots all mutable state under `pm.mu`** (the −15% halt's `Status()`-race class).
- **Layer A ships unconditionally; Layer B is default-off.** Both scoped per-bot to `mean-rev-rsi2-live` in `agent/coil-halt-flags.js` — every other bot gets an explicit `'false'`.
- Stage only the files each task names. The tree has one pre-existing untracked file (`Claudes Notes/coil-veto-ledger-usage.md`) — never stage it. Never `git add -A`.

---

## File structure

| File | New/Mod | Responsibility |
|---|---|---|
| `services/position_manager.go` | Mod | Config + state fields, `SetOrphanAutoFlatten`, `lastOrphans` storage, `OrphanStatus()`, `autoFlattenOrphans()` |
| `services/orphan_autoflatten_test.go` | New | Layer B state-machine tests |
| `controllers/orphan_controller.go` | New | `GET /api/v1/orphans/status` |
| `controllers/orphan_controller_test.go` | New | Controller 200/503 |
| `config/config.go` | Mod | The three flags |
| `cmd/bot/main.go` | Mod | Inject config + `marketIsOpen`; register route; startup log |
| `agent/coil-halt-flags.js` | Mod | Scope the two new flags per-bot |
| `agent/coil-halt-flags.test.mjs` | Mod | Assert scoping |
| `agent/orphan-poll.js` | New | Pure poller + dedup logic |
| `agent/orphan-poll.test.mjs` | New | Poller/dedup tests |
| `agent/server.js` | Mod | Wire the poller interval, `/api/orphans`, Slack push |
| `agent/trade-reconciliation.js` | Mod | Fix the misleading `SCOPE_NOTE` |
| `.env.example`, `docs/runbooks/coil-live-funding.md` | Mod | Document the flags + the dedicated-account constraint |

---

## Task 1: PM orphan-autoflatten state + `OrphanStatus()` snapshot (Go)

Adds the config/state fields, a setter, stores the per-pass orphan set, and exposes a locked read-only snapshot. No auto-flatten behavior yet (that is Task 3) — this task is the data model Layer A surfaces and Layer B mutates.

**Files:**
- Modify: `services/position_manager.go` (struct fields ~line 150 after `orphanReporter`; `NewPositionManager` init ~line 193; `detectOrphans` ~line 1478; new method near `OrphanReporter` usage)
- Test: `services/position_manager_orphan_test.go` (existing file — add tests)

**Interfaces:**
- Produces: `type OrphanAutoFlattenConfig struct { Enabled bool; AccountIsDedicated bool; Streak int; MarketIsOpen func() bool }`
- Produces: `func (pm *PositionManager) SetOrphanAutoFlatten(cfg OrphanAutoFlattenConfig)`
- Produces: `type OrphanStatusSnapshot struct { Orphans []OrphanAlert `json:"orphans"`; AutoFlattenEnabled bool `json:"auto_flatten_enabled"`; AccountDedicatedAffirmed bool `json:"account_dedicated_affirmed"`; Streak int `json:"streak"`; StreakBySymbol map[string]int `json:"streak_by_symbol"`; LatchedSymbols []string `json:"latched_symbols"`; LastActions []OrphanFlattenAction `json:"last_actions"` }`
- Produces: `type OrphanFlattenAction struct { Symbol string `json:"symbol"`; Qty float64 `json:"qty"`; OrderID string `json:"order_id,omitempty"`; Success bool `json:"success"`; Error string `json:"error,omitempty"`; At time.Time `json:"at"` }`
- Produces: `func (pm *PositionManager) OrphanStatus() OrphanStatusSnapshot`
- Consumes: existing `findOrphans`, `OrphanAlert`, `pm.mu`, `pm.orphanAlerted`.

- [ ] **Step 1: Write the failing test**

Add to `services/position_manager_orphan_test.go`:

```go
func TestOrphanStatus_ReflectsLastOrphansAndConfig(t *testing.T) {
	pm := &PositionManager{
		positions:     map[string]*ManagedPosition{},
		orphanAlerted: map[string]bool{},
		logger:        logrus.New(),
	}
	pm.SetOrphanAutoFlatten(OrphanAutoFlattenConfig{
		Enabled: true, AccountIsDedicated: true, Streak: 3,
		MarketIsOpen: func() bool { return true },
	})
	// Seed a terminal record + broker still holding → one orphan.
	pm.positions["p1"] = &ManagedPosition{ID: "p1", Symbol: "UNH", Status: "CLOSED"}
	pm.detectOrphans([]*interfaces.Position{{Symbol: "UNH", Qty: 13, Side: "long"}})

	s := pm.OrphanStatus()
	if len(s.Orphans) != 1 || s.Orphans[0].Symbol != "UNH" {
		t.Fatalf("expected 1 orphan UNH, got %+v", s.Orphans)
	}
	if !s.AutoFlattenEnabled || !s.AccountDedicatedAffirmed || s.Streak != 3 {
		t.Fatalf("config not reflected: %+v", s)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestOrphanStatus_ -v`
Expected: FAIL — `SetOrphanAutoFlatten` / `OrphanStatus` undefined.

- [ ] **Step 3: Add the fields + setter + snapshot**

In the `PositionManager` struct, after the `orphanReporter` field (~line 150):

```go
	// Orphan auto-flatten (Layer B) config + state. All guarded by mu. Zero-value
	// = disabled (Layer A detection still runs regardless).
	orphanAutoFlatten OrphanAutoFlattenConfig
	// orphanStreak counts consecutive reconcile passes a symbol has been an
	// orphan; flattenLatched marks symbols already auto-flattened this process.
	// Both in-memory (reset on restart — deliberate, see the 2026-07-14 spec).
	orphanStreak   map[string]int
	flattenLatched map[string]bool
	// lastOrphans is the orphan set from the most recent detectOrphans pass, so
	// OrphanStatus can report it without an HTTP-path broker read.
	lastOrphans []OrphanAlert
	// lastFlattenActions is a small ring of recent auto-flatten attempts for
	// operator observability via OrphanStatus.
	lastFlattenActions []OrphanFlattenAction
```

Add the types + setter near `findOrphans` (anywhere in the file's orphan region):

```go
// OrphanAutoFlattenConfig parameterizes Layer B. Enabled AND AccountIsDedicated
// must BOTH be true for any flatten to fire (see the 2026-07-14 spec's
// shared-account constraint). MarketIsOpen gates liquidation to RTH.
type OrphanAutoFlattenConfig struct {
	Enabled            bool
	AccountIsDedicated bool
	Streak             int
	MarketIsOpen       func() bool
}

// OrphanFlattenAction records one auto-flatten attempt for observability.
type OrphanFlattenAction struct {
	Symbol  string    `json:"symbol"`
	Qty     float64   `json:"qty"`
	OrderID string    `json:"order_id,omitempty"`
	Success bool      `json:"success"`
	Error   string    `json:"error,omitempty"`
	At      time.Time `json:"at"`
}

// OrphanStatusSnapshot is the read-only Layer A view.
type OrphanStatusSnapshot struct {
	Orphans                  []OrphanAlert         `json:"orphans"`
	AutoFlattenEnabled       bool                  `json:"auto_flatten_enabled"`
	AccountDedicatedAffirmed bool                  `json:"account_dedicated_affirmed"`
	Streak                   int                   `json:"streak"`
	StreakBySymbol           map[string]int        `json:"streak_by_symbol"`
	LatchedSymbols           []string              `json:"latched_symbols"`
	LastActions              []OrphanFlattenAction `json:"last_actions"`
}

// SetOrphanAutoFlatten installs the Layer B config and initializes its state
// maps. Called once at wiring time.
func (pm *PositionManager) SetOrphanAutoFlatten(cfg OrphanAutoFlattenConfig) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.orphanAutoFlatten = cfg
	if pm.orphanStreak == nil {
		pm.orphanStreak = map[string]int{}
	}
	if pm.flattenLatched == nil {
		pm.flattenLatched = map[string]bool{}
	}
}

// OrphanStatus returns a race-free snapshot of the current orphan set and the
// auto-flatten state. Snapshots under mu — the reconcile loop mutates these
// fields under the same lock.
func (pm *PositionManager) OrphanStatus() OrphanStatusSnapshot {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	streaks := make(map[string]int, len(pm.orphanStreak))
	for k, v := range pm.orphanStreak {
		streaks[k] = v
	}
	var latched []string
	for k, v := range pm.flattenLatched {
		if v {
			latched = append(latched, k)
		}
	}
	orphans := make([]OrphanAlert, len(pm.lastOrphans))
	copy(orphans, pm.lastOrphans)
	actions := make([]OrphanFlattenAction, len(pm.lastFlattenActions))
	copy(actions, pm.lastFlattenActions)
	return OrphanStatusSnapshot{
		Orphans:                  orphans,
		AutoFlattenEnabled:       pm.orphanAutoFlatten.Enabled,
		AccountDedicatedAffirmed: pm.orphanAutoFlatten.AccountIsDedicated,
		Streak:                   pm.orphanAutoFlatten.Streak,
		StreakBySymbol:           streaks,
		LatchedSymbols:           latched,
		LastActions:              actions,
	}
}
```

In `detectOrphans`, after `orphans := findOrphans(brokerPositions, managed)` (~line 1486), store the set under the lock. `detectOrphans` already takes `pm.mu.Lock()` shortly after; add the store inside that locked region (right after the `pm.mu.Lock()` at ~line 1493):

```go
	pm.mu.Lock()
	pm.lastOrphans = orphans // snapshot for OrphanStatus (Layer A)
	var newly []OrphanAlert
```

Initialize the maps in `NewPositionManager` (~line 193, alongside `orphanAlerted`):

```go
		orphanAlerted:      make(map[string]bool),
		orphanStreak:       make(map[string]int),
		flattenLatched:     make(map[string]bool),
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run TestOrphanStatus_ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/position_manager.go services/position_manager_orphan_test.go
git commit -m "feat(orphan): PM auto-flatten config/state + OrphanStatus() snapshot

Adds the Layer B config + in-memory streak/latch state, stores each pass's
orphan set for observability, and exposes a race-free OrphanStatus() snapshot
(under pm.mu). No auto-flatten behavior yet — this is the data model Layer A
surfaces and Layer B mutates.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `OrphanController` + route (Go)

Exposes `OrphanStatus()` over HTTP, mirroring `controllers/sleeve_controller.go`.

**Files:**
- Create: `controllers/orphan_controller.go`
- Create: `controllers/orphan_controller_test.go`
- Modify: `cmd/bot/main.go` (register the route near the other controllers)

**Interfaces:**
- Consumes: `(*services.PositionManager).OrphanStatus() services.OrphanStatusSnapshot` (Task 1).
- Produces: `type OrphanStatusProvider interface { OrphanStatus() services.OrphanStatusSnapshot }`, `func NewOrphanController(p OrphanStatusProvider) *OrphanController`, `func (oc *OrphanController) HandleGetStatus(c *gin.Context)`.

- [ ] **Step 1: Write the failing test**

Create `controllers/orphan_controller_test.go`:

```go
package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"prophet-trader/services"
	"testing"

	"github.com/gin-gonic/gin"
)

type fakeOrphanProvider struct{ snap services.OrphanStatusSnapshot }

func (f *fakeOrphanProvider) OrphanStatus() services.OrphanStatusSnapshot { return f.snap }

func TestOrphanController_ReturnsStatus(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc := NewOrphanController(&fakeOrphanProvider{snap: services.OrphanStatusSnapshot{
		Orphans: []services.OrphanAlert{{Symbol: "UNH", BrokerQty: 13}},
	}})
	r := gin.New()
	r.GET("/api/v1/orphans/status", oc.HandleGetStatus)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/v1/orphans/status", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var got services.OrphanStatusSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if len(got.Orphans) != 1 || got.Orphans[0].Symbol != "UNH" {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
}

func TestOrphanController_NilProvider503(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc := NewOrphanController(nil)
	r := gin.New()
	r.GET("/api/v1/orphans/status", oc.HandleGetStatus)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/v1/orphans/status", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", w.Code)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./controllers/ -run TestOrphanController_ -v`
Expected: FAIL — `NewOrphanController` undefined.

- [ ] **Step 3: Implement the controller**

Create `controllers/orphan_controller.go`:

```go
package controllers

import (
	"net/http"
	"prophet-trader/services"

	"github.com/gin-gonic/gin"
)

// OrphanStatusProvider is the read surface the controller needs.
// *services.PositionManager satisfies it.
type OrphanStatusProvider interface {
	OrphanStatus() services.OrphanStatusSnapshot
}

// OrphanController exposes the read-only orphan / auto-flatten snapshot.
type OrphanController struct {
	provider OrphanStatusProvider
}

// NewOrphanController creates the controller. A nil provider makes the endpoint
// return 503 (feature unavailable) rather than panicking.
func NewOrphanController(p OrphanStatusProvider) *OrphanController {
	return &OrphanController{provider: p}
}

// HandleGetStatus returns the orphan snapshot. GET /api/v1/orphans/status
func (oc *OrphanController) HandleGetStatus(c *gin.Context) {
	if oc.provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "orphan status not configured"})
		return
	}
	c.JSON(http.StatusOK, oc.provider.OrphanStatus())
}
```

Note: a nil `OrphanStatusProvider` passed as an interface is non-nil at the interface level only if a typed nil is passed; `NewOrphanController(nil)` stores an untyped nil, so `oc.provider == nil` is true. The test passes literal `nil`.

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./controllers/ -run TestOrphanController_ -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the route in main.go**

In `cmd/bot/main.go`, find where routes are registered (search for `sleeve/status` or `RegisterRoutes`/`router.GET`). Following whatever registration style is used there, add — using the same `positionManager` already constructed at line 180:

```go
	orphanController := controllers.NewOrphanController(positionManager)
	// register alongside the other v1 routes:
	// <router group>.GET("/api/v1/orphans/status", orphanController.HandleGetStatus)
```

Read the existing sleeve/guard route registration in `main.go` first and match it exactly (the router variable name and group prefix differ per codebase — do NOT guess; grep `sleeve/status` in `main.go` and mirror that line).

- [ ] **Step 6: Build + test**

Run: `go build ./... && go test ./controllers/`
Expected: build OK; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add controllers/orphan_controller.go controllers/orphan_controller_test.go cmd/bot/main.go
git commit -m "feat(orphan): GET /api/v1/orphans/status endpoint

Exposes PositionManager.OrphanStatus() over HTTP, mirroring SleeveController
(503 when unavailable). Layer A surfacing — the operator can now see orphans
without opening a file on the bot host.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Auto-flatten state machine (Go) — the core

The remediation. Runs inside `reconcileWithBroker` after `detectOrphans`, behind both gates.

**Files:**
- Modify: `services/position_manager.go` (`reconcileWithBroker` end ~line 529; new `autoFlattenOrphans` method; `recordFlattenAction` helper)
- Create: `services/orphan_autoflatten_test.go`

**Interfaces:**
- Consumes: `findOrphans`, `isTerminalStatus`, `pm.tradingService.ClosePosition(ctx, symbol, qty) (*interfaces.OrderResult, error)`, `pm.tradingService.GetPositions(ctx)`, `pm.savePositionToDB`, `pm.lastOrphans`, config from Task 1.
- Produces: `func (pm *PositionManager) autoFlattenOrphans(ctx context.Context, brokerPositions []*interfaces.Position)`

- [ ] **Step 1: Write the failing tests**

Create `services/orphan_autoflatten_test.go`. This uses the existing `reconcileStubTrading` fake (see `services/position_manager_orphan_test.go`) extended with a `ClosePosition` recorder. First check the fake's exact shape and extend it there if it lacks a `ClosePosition` hook; the tests below assume a `closeCalls []closeCall` recorder and a `closeErr error` toggle on the stub.

```go
package services

import (
	"context"
	"errors"
	"prophet-trader/interfaces"
	"testing"

	"github.com/sirupsen/logrus"
)

// helper: a PM with one terminal record for `sym` and a stub broker holding it.
func newAutoFlattenPM(t *testing.T, sym string, qty float64, cfg OrphanAutoFlattenConfig) (*PositionManager, *reconcileStubTrading) {
	t.Helper()
	trading := &reconcileStubTrading{
		stubTrading: &stubTrading{},
		positions:   []*interfaces.Position{{Symbol: sym, Qty: qty, Side: "long"}},
	}
	pm := &PositionManager{
		tradingService: trading,
		positions:      map[string]*ManagedPosition{"p1": {ID: "p1", Symbol: sym, Status: "CLOSED"}},
		orphanAlerted:  map[string]bool{},
		orphanStreak:   map[string]int{},
		flattenLatched: map[string]bool{},
		logger:         logrus.New(),
	}
	pm.SetOrphanAutoFlatten(cfg)
	return pm, trading
}

func openCfg() OrphanAutoFlattenConfig {
	return OrphanAutoFlattenConfig{Enabled: true, AccountIsDedicated: true, Streak: 3, MarketIsOpen: func() bool { return true }}
}

// Fires at 3, not before.
func TestAutoFlatten_FiresAtStreakThreshold(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	bp := trading.positions
	pm.autoFlattenOrphans(context.Background(), bp) // streak 1
	pm.autoFlattenOrphans(context.Background(), bp) // streak 2
	if len(trading.closeCalls) != 0 {
		t.Fatalf("must not fire before streak 3, got %d calls", len(trading.closeCalls))
	}
	pm.autoFlattenOrphans(context.Background(), bp) // streak 3 → fire
	if len(trading.closeCalls) != 1 || trading.closeCalls[0].symbol != "UNH" || trading.closeCalls[0].qty != 13 {
		t.Fatalf("expected 1 ClosePosition(UNH,13), got %+v", trading.closeCalls)
	}
}

// One attempt then latch: no second submit even if the orphan persists.
func TestAutoFlatten_OneAttemptThenLatch(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	bp := trading.positions
	for i := 0; i < 6; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 1 {
		t.Fatalf("expected exactly 1 ClosePosition across many passes, got %d", len(trading.closeCalls))
	}
}

// Failure latches too — never retried.
func TestAutoFlatten_FailureLatches(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	trading.closeErr = errors.New("rejected")
	bp := trading.positions
	for i := 0; i < 6; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 1 {
		t.Fatalf("a failed flatten must not be retried, got %d calls", len(trading.closeCalls))
	}
}

// Both gates required: not affirmed dedicated → never fires.
func TestAutoFlatten_NotDedicated_NeverFires(t *testing.T) {
	cfg := openCfg()
	cfg.AccountIsDedicated = false
	pm, trading := newAutoFlattenPM(t, "UNH", 13, cfg)
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("un-affirmed account must never flatten, got %d", len(trading.closeCalls))
	}
}

func TestAutoFlatten_Disabled_NeverFires(t *testing.T) {
	cfg := openCfg()
	cfg.Enabled = false
	pm, trading := newAutoFlattenPM(t, "UNH", 13, cfg)
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("disabled must never flatten, got %d", len(trading.closeCalls))
	}
}

// Market closed → never fires; streak preserved so it fires once open.
func TestAutoFlatten_MarketClosed_HoldsThenFires(t *testing.T) {
	cfg := openCfg()
	open := false
	cfg.MarketIsOpen = func() bool { return open }
	pm, trading := newAutoFlattenPM(t, "UNH", 13, cfg)
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("closed market must not flatten, got %d", len(trading.closeCalls))
	}
	open = true
	pm.autoFlattenOrphans(context.Background(), bp)
	if len(trading.closeCalls) != 1 {
		t.Fatalf("must fire once the market opens, got %d", len(trading.closeCalls))
	}
}

// Long-only: a short orphan (qty<0) is never flattened.
func TestAutoFlatten_ShortOrphan_NeverFlattened(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", -13, openCfg())
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("a short orphan must never be auto-covered, got %d", len(trading.closeCalls))
	}
}

// Catastrophic guard: a live (non-terminal) record means it is NOT an orphan.
func TestAutoFlatten_LiveRecord_NeverFlattened(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	pm.positions["p2"] = &ManagedPosition{ID: "p2", Symbol: "UNH", Status: "ACTIVE"}
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("a symbol with a live record is not an orphan; must never flatten, got %d", len(trading.closeCalls))
	}
}

// Success appends an audit note to the terminal record.
func TestAutoFlatten_SuccessAppendsAuditNote(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	bp := trading.positions
	for i := 0; i < 3; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 1 {
		t.Fatalf("expected 1 flatten, got %d", len(trading.closeCalls))
	}
	if note := pm.positions["p1"].Notes; !strings.Contains(note, "orphan_autoflattened") {
		t.Fatalf("expected audit note on terminal record, got %q", note)
	}
}

// Restart behavior (deliberate, per spec): in-memory streak/latch reset on a new
// process, so a still-present orphan re-accrues and re-fires. Pins that this is
// intended, not accidental.
func TestAutoFlatten_RestartReAttempts(t *testing.T) {
	pm1, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	bp := trading.positions
	trading.closeErr = errors.New("rejected") // first process: flatten fails, latches
	for i := 0; i < 4; i++ {
		pm1.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 1 {
		t.Fatalf("first process: expected 1 attempt, got %d", len(trading.closeCalls))
	}
	// Simulate a restart: a fresh PM over the SAME stub broker (orphan still held).
	trading.closeErr = nil
	pm2 := &PositionManager{
		tradingService: trading,
		positions:      map[string]*ManagedPosition{"p1": {ID: "p1", Symbol: "UNH", Status: "CLOSED"}},
		orphanAlerted:  map[string]bool{},
		orphanStreak:   map[string]int{},
		flattenLatched: map[string]bool{},
		logger:         logrus.New(),
	}
	pm2.SetOrphanAutoFlatten(openCfg())
	for i := 0; i < 3; i++ {
		pm2.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 2 {
		t.Fatalf("after restart the still-present orphan must re-fire (total 2 calls), got %d", len(trading.closeCalls))
	}
}
```

The test file imports `"strings"` for the audit-note assertion (`strings.Contains`).

(If `reconcileStubTrading` lacks `closeCalls`/`closeErr`/a `ClosePosition` method, add them there — a `type closeCall struct{ symbol string; qty float64 }`, a `closeCalls []closeCall` slice, a `closeErr error`, and a `ClosePosition` that appends and returns `closeErr`. Check the existing `stubTrading.ClosePosition` first — it may already exist and just need call-recording.)

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestAutoFlatten_ -v`
Expected: FAIL — `autoFlattenOrphans` undefined.

- [ ] **Step 3: Implement `autoFlattenOrphans`**

Add to `services/position_manager.go`:

```go
// orphanFlattenActionRing bounds lastFlattenActions.
const orphanFlattenActionRing = 20

// autoFlattenOrphans is Layer B: after detectOrphans has run this pass, advance
// each orphan's streak and, for a long orphan that has been stable for the
// configured number of passes, market-flatten it — ONCE, then latch. Behind two
// gates (Enabled AND AccountIsDedicated) so it is inert unless the operator has
// both turned it on and affirmed the account is single-agent (see the
// 2026-07-14 spec's shared-account constraint). Reuses this pass's broker
// positions; re-reads fresh right before any sell. Never blocks or touches an
// exit — ClosePosition does not pass through the trade guard.
func (pm *PositionManager) autoFlattenOrphans(ctx context.Context, brokerPositions []*interfaces.Position) {
	pm.mu.RLock()
	cfg := pm.orphanAutoFlatten
	pm.mu.RUnlock()
	if !cfg.Enabled || !cfg.AccountIsDedicated {
		return // both gates required; fail-closed
	}

	pm.mu.Lock()
	managed := make([]*ManagedPosition, 0, len(pm.positions))
	for _, p := range pm.positions {
		managed = append(managed, p)
	}
	pm.mu.Unlock()

	orphans := findOrphans(brokerPositions, managed)
	current := make(map[string]bool, len(orphans))
	for _, o := range orphans {
		current[o.Symbol] = true
	}

	pm.mu.Lock()
	// Advance streaks; drop resolved symbols (streak + latch cleared).
	for _, o := range orphans {
		pm.orphanStreak[o.Symbol]++
	}
	for sym := range pm.orphanStreak {
		if !current[sym] {
			delete(pm.orphanStreak, sym)
			delete(pm.flattenLatched, sym)
		}
	}
	// Decide who to fire on, under the lock, but ACT (network) outside it.
	// OrphanAlert already carries the exact terminal record's PositionID, so use
	// it directly — no Symbol→position map (which would be nondeterministic when
	// a symbol has more than one terminal record).
	type target struct {
		symbol string
		qty    float64
		posID  string
	}
	var toFire []target
	for _, o := range orphans {
		if pm.flattenLatched[o.Symbol] {
			continue
		}
		if pm.orphanStreak[o.Symbol] < cfg.Streak {
			continue
		}
		if o.BrokerQty <= 0 {
			continue // long-only; short orphan handled by the Layer-A alert only
		}
		toFire = append(toFire, target{symbol: o.Symbol, qty: o.BrokerQty, posID: o.PositionID})
	}
	pm.mu.Unlock()

	if len(toFire) == 0 {
		return
	}
	if cfg.MarketIsOpen != nil && !cfg.MarketIsOpen() {
		return // hold the streak; fire when the market opens
	}

	// Fresh re-read: confirm the shares are still held long before any sell.
	fresh, err := pm.tradingService.GetPositions(ctx)
	if err != nil {
		pm.logger.WithError(err).Warn("orphan auto-flatten: broker re-read failed — skipping this pass (fail-closed)")
		return
	}
	held := map[string]float64{}
	for _, p := range fresh {
		if p != nil {
			held[p.Symbol] = p.Qty
		}
	}

	for _, tg := range toFire {
		q, ok := held[tg.symbol]
		if !ok || q <= 0 {
			continue // resolved between the pass snapshot and now — do not sell
		}
		// Latch BEFORE the call so a mid-flight retry can never double-submit.
		pm.mu.Lock()
		pm.flattenLatched[tg.symbol] = true
		pm.mu.Unlock()

		res, ferr := pm.tradingService.ClosePosition(ctx, tg.symbol, q)
		if ferr != nil {
			pm.recordFlattenAction(OrphanFlattenAction{Symbol: tg.symbol, Qty: q, Success: false, Error: ferr.Error(), At: time.Now()})
			pm.logger.WithError(ferr).WithFields(logrus.Fields{
				"symbol": tg.symbol, "qty": q, "operator_review_required": true,
			}).Error("orphan auto-flatten FAILED — latched, will not retry; operator must resolve")
			continue
		}
		orderID := ""
		if res != nil {
			orderID = res.OrderID
		}
		pm.recordFlattenAction(OrphanFlattenAction{Symbol: tg.symbol, Qty: q, OrderID: orderID, Success: true, At: time.Now()})
		// Audit note on the terminal record (mirror reconciled_closed:broker_flat).
		pm.mu.Lock()
		if p, ok := pm.positions[tg.posID]; ok {
			p.Notes = strings.TrimSpace(p.Notes + fmt.Sprintf(" orphan_autoflattened:%v@%s", q, orderID))
			_ = pm.savePositionToDB(p)
		}
		pm.mu.Unlock()
		pm.logger.WithFields(logrus.Fields{
			"symbol": tg.symbol, "qty": q, "order_id": orderID, "operator_review_required": true,
		}).Warn("orphan auto-flattened — broker shares liquidated for a ledger-terminal position")
	}
}

// recordFlattenAction appends to the bounded observability ring under mu.
func (pm *PositionManager) recordFlattenAction(a OrphanFlattenAction) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.lastFlattenActions = append(pm.lastFlattenActions, a)
	if len(pm.lastFlattenActions) > orphanFlattenActionRing {
		pm.lastFlattenActions = pm.lastFlattenActions[len(pm.lastFlattenActions)-orphanFlattenActionRing:]
	}
}
```

Ensure `fmt` and `strings` are imported (they already are in `position_manager.go`).

- [ ] **Step 4: Call it from the reconcile loop**

In `reconcileWithBroker`, after `pm.detectOrphans(brokerPositions)` (~line 529):

```go
	// Report-only orphan detection reuses the broker positions read above.
	pm.detectOrphans(brokerPositions)
	// Layer B: auto-flatten a confirmed, stable orphan (both gates required;
	// inert otherwise). Runs AFTER detectOrphans so lastOrphans is populated.
	pm.autoFlattenOrphans(ctx, brokerPositions)

	return closed, nil
```

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./services/ -run TestAutoFlatten_ -v`
Expected: PASS (9 tests).

- [ ] **Step 6: Full package + build**

Run: `go build ./... && go test ./services/`
Expected: build OK; all PASS.

- [ ] **Step 7: Commit**

```bash
git add services/position_manager.go services/orphan_autoflatten_test.go
git commit -m "feat(orphan): auto-flatten a confirmed long orphan (Layer B)

After detectOrphans, advance each orphan's streak and, behind BOTH gates
(enabled AND account-affirmed-dedicated), market-flatten a long orphan stable
for N passes — one attempt then latch, market-open-gated, fresh-re-read
confirmed, with an audit note on the terminal record. Never touches an exit
(ClosePosition bypasses the trade guard) and can only sell shares this bot's own
ledger already marked terminal.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Config flags + main.go injection (Go)

**Files:**
- Modify: `config/config.go` (struct + `Load()`)
- Modify: `cmd/bot/main.go` (build `OrphanAutoFlattenConfig`, inject via `SetOrphanAutoFlatten`; startup log if enabled-but-not-affirmed)
- Modify: `config/config_test.go` (flag parse)

**Interfaces:**
- Consumes: `(*services.PositionManager).SetOrphanAutoFlatten(services.OrphanAutoFlattenConfig)` (Task 1), `services.StaticMarketPhase` (existing).
- Produces: `cfg.EnableOrphanAutoFlatten bool`, `cfg.OrphanAutoFlattenAccountIsDedicated bool`, `cfg.OrphanAutoFlattenStreak int`.

- [ ] **Step 1: Write the failing test**

Add to `config/config_test.go` (match the file's existing env-set/Load test style):

```go
func TestLoad_OrphanAutoFlattenFlags(t *testing.T) {
	t.Setenv("ENABLE_COIL_ORPHAN_AUTOFLATTEN", "true")
	t.Setenv("ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED", "true")
	t.Setenv("ORPHAN_AUTOFLATTEN_STREAK", "5")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !AppConfig.EnableOrphanAutoFlatten || !AppConfig.OrphanAutoFlattenAccountIsDedicated {
		t.Fatal("flags not parsed true")
	}
	if AppConfig.OrphanAutoFlattenStreak != 5 {
		t.Fatalf("streak = %d, want 5", AppConfig.OrphanAutoFlattenStreak)
	}
}

func TestLoad_OrphanAutoFlattenDefaults(t *testing.T) {
	// (ensure these env vars are unset in this test's environment)
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if AppConfig.EnableOrphanAutoFlatten || AppConfig.OrphanAutoFlattenAccountIsDedicated {
		t.Fatal("defaults must be false")
	}
	if AppConfig.OrphanAutoFlattenStreak != 3 {
		t.Fatalf("default streak = %d, want 3", AppConfig.OrphanAutoFlattenStreak)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./config/ -run OrphanAutoFlatten -v`
Expected: FAIL — fields undefined.

- [ ] **Step 3: Add the config fields**

In `config/config.go` `Config` struct (near the `EnableCoilLiveHalt` block from the live-funding branch):

```go
	// Orphan auto-flatten (2026-07-14 spec). Layer B remediation. Both booleans
	// default false. Acts only when BOTH are true (the second is the operator's
	// affirmation that the account is single-agent — the action is unsafe on a
	// shared account). OrphanAutoFlattenStreak defaults 3.
	EnableOrphanAutoFlatten             bool
	OrphanAutoFlattenAccountIsDedicated bool
	OrphanAutoFlattenStreak             int
```

In `Load()`'s `AppConfig` literal (match the helpers used by neighbors — `getEnvOrDefault(...) == "true"` for bools, `parseIntOrDefault` for the int; confirm the exact helper names in the file):

```go
		EnableOrphanAutoFlatten:             getEnvOrDefault("ENABLE_COIL_ORPHAN_AUTOFLATTEN", "false") == "true",
		OrphanAutoFlattenAccountIsDedicated: getEnvOrDefault("ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED", "false") == "true",
		OrphanAutoFlattenStreak:             parseIntOrDefault("ORPHAN_AUTOFLATTEN_STREAK", 3),
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./config/ -run OrphanAutoFlatten -v`
Expected: PASS.

- [ ] **Step 5: Inject into the PM in main.go**

In `cmd/bot/main.go`, after `positionManager` is constructed (line 180) and near the orphan-reporter wiring (line 438), add — reusing the `StaticMarketPhase` idiom already used at lines 518/567 (grep for `nyLoc` to reuse the loaded location, or load `America/New_York` as those sites do):

```go
	// Orphan auto-flatten (Layer B). Default off; acts only when BOTH the enable
	// flag and the dedicated-account affirmation are set.
	nyLocOrphan, _ := time.LoadLocation("America/New_York")
	positionManager.SetOrphanAutoFlatten(services.OrphanAutoFlattenConfig{
		Enabled:            cfg.EnableOrphanAutoFlatten,
		AccountIsDedicated: cfg.OrphanAutoFlattenAccountIsDedicated,
		Streak:             cfg.OrphanAutoFlattenStreak,
		MarketIsOpen:       func() bool { return services.StaticMarketPhase(time.Now().UTC(), nyLocOrphan) == "open" },
	})
	if cfg.EnableOrphanAutoFlatten && !cfg.OrphanAutoFlattenAccountIsDedicated {
		logger.Warn("orphan auto-flatten ENABLED but account NOT affirmed dedicated (ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED) — refusing to act; Layer A detection/surfacing still runs")
	} else if cfg.EnableOrphanAutoFlatten {
		logger.WithField("streak", cfg.OrphanAutoFlattenStreak).Warn("orphan auto-flatten ARMED (account affirmed dedicated)")
	}
```

- [ ] **Step 6: Build + full Go suite**

Run: `go build ./... && go test ./...`
Expected: build OK; all PASS.

- [ ] **Step 7: Commit**

```bash
git add config/config.go config/config_test.go cmd/bot/main.go
git commit -m "feat(orphan): wire auto-flatten config into the bot

Three flags (default off): ENABLE_COIL_ORPHAN_AUTOFLATTEN,
ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED, ORPHAN_AUTOFLATTEN_STREAK. main.go
injects them plus a StaticMarketPhase-based marketIsOpen, and logs loudly when
the feature is enabled without the dedicated-account affirmation (it then
refuses to act — Layer A still runs).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Scope the flags per-bot (Node)

Extend `agent/coil-halt-flags.js` (which already scopes `ENABLE_COIL_LIVE_HALT`) to also scope the two orphan-autoflatten booleans, so no non-live bot inherits a shared-`.env` `'true'`.

**Files:**
- Modify: `agent/coil-halt-flags.js`
- Modify: `agent/coil-halt-flags.test.mjs`

**Interfaces:**
- Consumes: `COIL_LIVE_STRATEGY_ID` from `agent/coil-strategy-ids.js`.
- Produces: the flags object returned by `coilHaltFlags(strategyId)` gains `ENABLE_COIL_ORPHAN_AUTOFLATTEN` and `ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED`.

- [ ] **Step 1: Read the existing module + test**

Read `agent/coil-halt-flags.js` and `agent/coil-halt-flags.test.mjs` in full. Note the exact function name and shape (it was created in the live-funding branch's Task 6b; it returns an object of env strings, scoping `ENABLE_COIL_LIVE_HALT` to the live id and `'false'` otherwise, passing through the operator's value for live).

- [ ] **Step 2: Write the failing test**

Add to `agent/coil-halt-flags.test.mjs`:

```js
test('orphan-autoflatten flags: live Coil gets the operator value, others hard-false', () => {
  const liveTrue = coilHaltFlags('mean-rev-rsi2-live', { ENABLE_COIL_ORPHAN_AUTOFLATTEN: 'true', ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED: 'true' });
  assert.equal(liveTrue.ENABLE_COIL_ORPHAN_AUTOFLATTEN, 'true');
  assert.equal(liveTrue.ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED, 'true');

  const liveUnset = coilHaltFlags('mean-rev-rsi2-live', {});
  assert.equal(liveUnset.ENABLE_COIL_ORPHAN_AUTOFLATTEN, 'false');

  for (const id of ['mean-rev-rsi2', 'trend', 'earnings-drift', 'v2-options', 'prophet-defensive']) {
    const other = coilHaltFlags(id, { ENABLE_COIL_ORPHAN_AUTOFLATTEN: 'true', ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED: 'true' });
    assert.equal(other.ENABLE_COIL_ORPHAN_AUTOFLATTEN, 'false', `${id} must hard-false the enable flag`);
    assert.equal(other.ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED, 'false', `${id} must hard-false the dedicated flag`);
  }
});
```

Match the existing test's call signature. If `coilHaltFlags` currently reads `process.env` directly instead of taking an env argument, follow whatever seam the existing tests use (they may set `process.env` then call with just the strategyId) — mirror it exactly rather than introducing a new parameter.

- [ ] **Step 3: Run to verify it fails**

Run: `node --test agent/coil-halt-flags.test.mjs`
Expected: FAIL — the new keys are absent/incorrect.

- [ ] **Step 4: Extend the module**

In `agent/coil-halt-flags.js`, add the two keys alongside the existing `ENABLE_COIL_LIVE_HALT` scoping, using the identical live-vs-other logic:

```js
    // Orphan auto-flatten (2026-07-14 spec). Same per-bot scoping as the halt:
    // only live Coil may receive a 'true'; every other bot is hard-'false' so it
    // cannot inherit a shared-.env value and start auto-flattening. The operator
    // keeps the kill switch (live Coil gets the operator's value, not a forced
    // 'true').
    ENABLE_COIL_ORPHAN_AUTOFLATTEN: isLive ? (env.ENABLE_COIL_ORPHAN_AUTOFLATTEN || 'false') : 'false',
    ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED: isLive ? (env.ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED || 'false') : 'false',
```

Match the module's existing variable names (`isLive`, `env`, or however it reads the operator value).

- [ ] **Step 5: Run to verify it passes + full suite**

Run: `node --test agent/coil-halt-flags.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/coil-halt-flags.js agent/coil-halt-flags.test.mjs
git commit -m "feat(orphan): scope auto-flatten flags to the live-Coil bot

Same per-bot scoping as ENABLE_COIL_LIVE_HALT: only mean-rev-rsi2-live may
receive a 'true' for the two orphan-autoflatten flags; every other bot gets an
explicit 'false' so a shared-.env value can never arm auto-flatten on a bot it
was not meant for.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Node orphan poller + `/api/orphans` + Slack push

Polls each running bot's `/api/v1/orphans/status` on an interval, exposes an aggregated `/api/orphans`, and pushes a deduped Slack alert on newly-detected orphans and on flatten actions.

**Files:**
- Create: `agent/orphan-poll.js` (pure logic: dedup + which alerts to emit)
- Create: `agent/orphan-poll.test.mjs`
- Modify: `agent/server.js` (interval wiring, `/api/orphans`, calling `notifySlack`)

**Interfaces:**
- Consumes: `notifySlack(text, sandboxId)`, `slackEnabled(event, sandboxId)`, `orchestrator.runtimes`, `getResolvedAgentForSandbox`.
- Produces: `export function diffOrphanAlerts(prevSymbols, snapshot)` → `{ newlyDetected: string[], resolved: string[], flattenEvents: [{symbol, success}] }` (pure); `export function makeOrphanPoller(deps)` → `{ pollOnce, getAggregate }`.

- [ ] **Step 1: Write the failing test (pure dedup logic)**

Create `agent/orphan-poll.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffOrphanAlerts } from './orphan-poll.js';

test('newly-detected orphan is reported once, not while it persists', () => {
  const snap1 = { orphans: [{ symbol: 'UNH' }], last_actions: [] };
  const d1 = diffOrphanAlerts(new Set(), snap1);
  assert.deepEqual(d1.newlyDetected, ['UNH']);

  // Same orphan still present next poll → not newly-detected again.
  const d2 = diffOrphanAlerts(new Set(['UNH']), snap1);
  assert.deepEqual(d2.newlyDetected, []);
});

test('a resolved-then-recurring orphan re-alerts', () => {
  const empty = { orphans: [], last_actions: [] };
  const withUNH = { orphans: [{ symbol: 'UNH' }], last_actions: [] };
  const resolved = diffOrphanAlerts(new Set(['UNH']), empty);
  assert.deepEqual(resolved.resolved, ['UNH']);
  const recurs = diffOrphanAlerts(new Set(), withUNH);
  assert.deepEqual(recurs.newlyDetected, ['UNH']);
});

test('flatten actions surface success/failure', () => {
  const snap = { orphans: [], last_actions: [{ symbol: 'UNH', success: true }, { symbol: 'MO', success: false }] };
  const d = diffOrphanAlerts(new Set(), snap);
  assert.deepEqual(d.flattenEvents, [{ symbol: 'UNH', success: true }, { symbol: 'MO', success: false }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test agent/orphan-poll.test.mjs`
Expected: FAIL — cannot resolve `./orphan-poll.js`.

- [ ] **Step 3: Implement the pure logic + poller factory**

Create `agent/orphan-poll.js`:

```js
// Orphan poller. Layer A surfacing for the Go-side orphan detector: poll each
// bot's /api/v1/orphans/status, expose an aggregate for the dashboard, and push
// deduped Slack alerts. No detection here — the Go findOrphans is the source of
// truth; this only surfaces it.

// diffOrphanAlerts is pure: given the set of orphan symbols already alerted for
// a sandbox and the latest snapshot, return which symbols are newly-detected,
// which resolved, and any flatten actions to announce. Dedup lives in the caller
// (it owns the per-sandbox prevSymbols set); this decides what changed.
export function diffOrphanAlerts(prevSymbols, snapshot) {
  const cur = new Set((snapshot?.orphans || []).map(o => o.symbol));
  const newlyDetected = [...cur].filter(s => !prevSymbols.has(s));
  const resolved = [...prevSymbols].filter(s => !cur.has(s));
  const flattenEvents = (snapshot?.last_actions || []).map(a => ({ symbol: a.symbol, success: a.success }));
  return { newlyDetected, resolved, flattenEvents };
}

// makeOrphanPoller builds a poller over injected deps so server.js stays thin
// and the poll cycle is testable. deps: { runtimes(), resolveAgent(sandboxId),
// notify(event, text, sandboxId), logger }.
export function makeOrphanPoller(deps) {
  const seen = new Map();        // sandboxId -> Set<symbol> already alerted
  const seenActions = new Map(); // sandboxId -> Set<actionKey> already announced
  const aggregate = new Map();   // sandboxId -> latest snapshot (for /api/orphans)

  async function pollOnce() {
    for (const runtime of deps.runtimes()) {
      const sandboxId = runtime?.harness?.sandboxId;
      const goAxios = runtime?.goAxios;
      if (!sandboxId || !goAxios) continue;
      try {
        const { data } = await goAxios.get('/api/v1/orphans/status');
        aggregate.set(sandboxId, data);
        const prev = seen.get(sandboxId) || new Set();
        const { newlyDetected, resolved, flattenEvents } = diffOrphanAlerts(prev, data);

        for (const sym of newlyDetected) {
          deps.notify('orphanDetected', `:warning: *Orphan detected* — ${sym}: broker holds shares this bot marked closed (no stop, no manager). Sandbox ${sandboxId}.`, sandboxId);
        }
        const next = new Set((data?.orphans || []).map(o => o.symbol));
        seen.set(sandboxId, next);
        void resolved; // resolution clears dedup via `next`; no alert on resolve

        const actSeen = seenActions.get(sandboxId) || new Set();
        for (const ev of flattenEvents) {
          const key = `${ev.symbol}:${ev.success}`;
          if (actSeen.has(key)) continue;
          actSeen.add(key);
          if (ev.success) {
            deps.notify('orphanFlattened', `:broom: *Orphan auto-flattened* — ${ev.symbol} liquidated. Sandbox ${sandboxId}.`, sandboxId);
          } else {
            deps.notify('orphanFlattenFailed', `:rotating_light: *Orphan auto-flatten FAILED* — ${ev.symbol}. Operator action required. Sandbox ${sandboxId}.`, sandboxId);
          }
        }
        seenActions.set(sandboxId, actSeen);
      } catch (err) {
        deps.logger?.(`orphan poll failed for ${sandboxId}: ${err.message}`);
        // soft-fail per sandbox
      }
    }
  }

  function getAggregate() {
    return Object.fromEntries(aggregate);
  }

  return { pollOnce, getAggregate };
}
```

- [ ] **Step 4: Run to verify the pure test passes**

Run: `node --test agent/orphan-poll.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Add a poller-cycle test**

Add to `agent/orphan-poll.test.mjs`:

```js
import { makeOrphanPoller } from './orphan-poll.js';

test('poller pushes once per new orphan and exposes the aggregate', async () => {
  const notifications = [];
  const snapshot = { orphans: [{ symbol: 'UNH' }], last_actions: [] };
  const runtime = { harness: { sandboxId: 'sbx_x' }, goAxios: { get: async () => ({ data: snapshot }) } };
  const p = makeOrphanPoller({
    runtimes: () => [runtime],
    resolveAgent: () => ({}),
    notify: (event, text, sandboxId) => notifications.push({ event, sandboxId }),
    logger: () => {},
  });
  await p.pollOnce();
  await p.pollOnce(); // second poll: same orphan, must NOT re-alert
  const detected = notifications.filter(n => n.event === 'orphanDetected');
  assert.equal(detected.length, 1, 'orphanDetected must fire once, not per poll');
  assert.ok(p.getAggregate().sbx_x, 'aggregate exposes the snapshot');
});
```

Run: `node --test agent/orphan-poll.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Wire into server.js**

In `agent/server.js`, after the Slack helpers (~line 281), construct the poller and run it on an interval; add the `/api/orphans` route. Use `slackEnabled` as the notify gate:

```js
import { makeOrphanPoller } from './orphan-poll.js';

const orphanPoller = makeOrphanPoller({
  runtimes: () => orchestrator.runtimes.values(),
  resolveAgent: (sandboxId) => getResolvedAgentForSandbox(sandboxId),
  notify: (event, text, sandboxId) => { if (slackEnabled(event, sandboxId)) notifySlack(text, sandboxId); },
  logger: (msg) => console.error(msg),
});
// Poll ~ every 60s (matches the Go reconcile cadence). Kill switch via env.
if (process.env.ORPHAN_POLL_ENABLED !== 'false') {
  setInterval(() => { orphanPoller.pollOnce().catch(() => {}); }, 60_000);
}

app.get('/api/orphans', (_req, res) => res.json(orphanPoller.getAggregate()));
```

Match the file's existing import placement (top of file) and route-registration style. Confirm `orchestrator.runtimes` is a Map (use `.values()`); the reconciliation sweep at line 201 iterates it the same way.

- [ ] **Step 7: Full Node suite + build check**

Run: `npm test`
Expected: PASS (baseline + the new orphan-poll tests). Then start the server briefly to confirm no import error: `node -e "import('./agent/orphan-poll.js').then(m=>console.log(typeof m.makeOrphanPoller))"` → prints `function`.

- [ ] **Step 8: Commit**

```bash
git add agent/orphan-poll.js agent/orphan-poll.test.mjs agent/server.js
git commit -m "feat(orphan): Node poller + /api/orphans + deduped Slack alerts

Polls each bot's /api/v1/orphans/status every ~60s, exposes an aggregated
/api/orphans for the dashboard, and pushes Slack alerts via the existing
notifyOn channel: orphanDetected (once per new symbol, not per poll),
orphanFlattened, orphanFlattenFailed. The dedup lives in a pure diffOrphanAlerts
so it is tested directly.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Fix the misleading reconciliation scope note (Node)

**Files:**
- Modify: `agent/trade-reconciliation.js` (`SCOPE_NOTE`, ~line 135)
- Modify: whichever test asserts `SCOPE_NOTE` text, if any (grep `SCOPE_NOTE` in `agent/*.test.mjs`)

**Interfaces:** none (string change).

- [ ] **Step 1: Write/adjust the failing test**

Add to `agent/trade-reconciliation.test.mjs` (or the file that imports `SCOPE_NOTE`):

```js
test('SCOPE_NOTE no longer claims closes are unverified, and points to the orphan detector', () => {
  assert.doesNotMatch(SCOPE_NOTE, /does not verify closes/i);
  assert.match(SCOPE_NOTE, /orphan/i);
});
```

Ensure `SCOPE_NOTE` is exported/importable; if it is not currently exported, export it.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test agent/trade-reconciliation.test.mjs`
Expected: FAIL — current text says closes are not verified.

- [ ] **Step 3: Rewrite the note**

In `agent/trade-reconciliation.js`, replace `SCOPE_NOTE`:

```js
const SCOPE_NOTE = 'Covers order placements (opens/adds). Closes/exits are covered separately by the Go-side orphan detector (GET /api/v1/orphans/status) — a logged-success close that did not flatten the broker surfaces there as an orphan, not here.';
```

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `node --test agent/trade-reconciliation.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/trade-reconciliation.js agent/trade-reconciliation.test.mjs
git commit -m "docs(orphan): reconciliation scope note points to the orphan detector

The note claimed closes/exits are not verified, which misled a reviewer into
thinking nothing covered them. Closes ARE covered — by the Go orphan detector.
The note now says so and points to /api/v1/orphans/status.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Document the flags + the dedicated-account constraint

**Files:**
- Modify: `.env.example`
- Modify: `docs/runbooks/coil-live-funding.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Add the flags to `.env.example`**

Append to `.env.example`:

```bash
# --- Orphan auto-flatten (2026-07-14 spec). Layer A (surfacing + Slack) is
# always on; these gate Layer B (active liquidation of a stuck exit). Default off.
# BOTH must be true to act. The second is your affirmation that this account is
# single-agent — auto-flatten would market-sell another agent's live position on
# a SHARED account, and the code cannot detect that on its own. NEVER set the
# dedicated flag on an account more than one bot trades.
ENABLE_COIL_ORPHAN_AUTOFLATTEN=false
ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED=false
ORPHAN_AUTOFLATTEN_STREAK=3
# ORPHAN_POLL_ENABLED=true   # Node-side surfacing poller; set false to disable
```

- [ ] **Step 2: Add a runbook section**

Append to `docs/runbooks/coil-live-funding.md`:

````markdown
## Stuck exits: detection, surfacing, and auto-flatten

Detection already runs in Go (`findOrphans`, every ~60s): a "orphan" is a symbol
the broker still holds where this bot's ledger marked the position terminal — a
close that did not flatten the broker side.

**Surfacing (always on).** `GET /api/v1/orphans/status` on the bot; the harness
aggregates it at `/api/orphans` and pushes Slack alerts (`orphanDetected`,
`orphanFlattened`, `orphanFlattenFailed`) if you enable those events in the
sandbox's Slack plugin `notifyOn`. Enable them for the live account.

**Auto-flatten (opt-in, default off).** When armed it market-sells a long orphan
that has persisted 3 reconcile passes (~3 min), once, then latches and alerts.

**⚠ The one rule that matters:** auto-flatten is only safe on a **dedicated,
single-agent account**. `GetPositions()` returns the whole Alpaca account, so on
a shared account the bot could market-sell *another agent's* live position that
happens to share a symbol with one of this bot's closed trades. The code cannot
detect that on its own. To arm it you must set BOTH `ENABLE_COIL_ORPHAN_AUTOFLATTEN=true`
and `ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED=true`; enabling without the
affirmation is inert (the bot logs a refusal at startup). **Never set the
dedicated flag on an account more than one bot trades.** The live Coil account
is dedicated by construction, which is the only reason it is safe here.

**When it fires:** confirm in the log (`orphan auto-flattened`), and note the
audit trail — the terminal record gets an `orphan_autoflattened:<qty>@<orderID>`
note. A **failed** flatten latches and alerts `operator_review_required`; resolve
it manually (the latch clears once the broker no longer holds the shares).

**Measurement caveat:** the ledger booked the position's P&L at its (phantom)
close price; the flatten realizes a different market price, so a small real-money
delta is uncaptured by segment P&L. Bounded at ~a few dollars per $600 position;
the audit note records the actual fill.
````

- [ ] **Step 3: Commit**

```bash
git add .env.example docs/runbooks/coil-live-funding.md
git commit -m "docs(orphan): document auto-flatten flags + the dedicated-account rule

Adds the three flags to .env.example and a runbook section whose headline is the
one rule that matters: auto-flatten is safe ONLY on a single-agent account,
because GetPositions() is whole-account and the code cannot detect a shared
account on its own. Both gates required; enabling without affirming is inert.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (coverage against the spec)

- Layer A: `OrphanStatus()` (T1) + endpoint (T2) + Node poller/`/api/orphans`/Slack (T6) + scope-note fix (T7). ✓
- Layer B: state machine with dedicated + long-only + market-open + fresh-re-read gates, one-attempt latch, audit note (T3); config/wiring/not-affirmed log (T4); per-bot flag scoping (T5). ✓
- All eight spec safety properties have a test in T3 (fires-at-threshold, one-attempt-latch, failure-latches, both-gates, long-only, market-open, live-record-never, audit-note) — plus `OrphanStatus` locking exercised in T1 and the halt-non-interference is structural (ClosePosition bypasses the guard; noted, not separately tested since there is no guard call to assert against).
- Restart behavior: in-memory maps (T1); pinned by `TestAutoFlatten_RestartReAttempts` (T3), which constructs a fresh PM over the same stub broker and asserts the still-present orphan re-fires.
- Dedup: pure `diffOrphanAlerts` (T6). ✓
- Measurement P&L delta: documented (T8), audit note (T3). ✓
- The `-race`-unavailability caveat from the halt work applies to T3's concurrency (OrphanStatus vs reconcile); mitigated by consistent `pm.mu` use — call it out to the reviewer.
