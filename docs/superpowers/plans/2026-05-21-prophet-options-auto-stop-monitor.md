# Prophet Options Auto-Stop Monitor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a flag-gated Go polling service that flattens the Prophet (`v2-options`) agent's long single-leg options positions past a deep catastrophic loss floor, without fighting the LLM's discretionary exits and without ever touching a Harvest condor leg.

**Architecture:** A `ProphetOptionsStopMonitor` goroutine (modeled on `services/harvest_exit_monitor.go`) ticks every minute while the market is open. Each tick it reads broker options positions, keeps only Prophet's (long, single-leg, not a Harvest condor leg), and for any position past `−PROPHET_OPTIONS_STOP_PCT` (default 0.50, computed from `UnrealizedPL/CostBasis`) places a marketable-limit sell-to-close that escalates to a wide limit bounded by a sanity floor. A "beats-observed" startup grace and a broker-order-history cool-off keep it from stomping the LLM. Idempotency is durable via a `ListOrders` working-order query (survives restart); flatten orders are tagged `v2-options-stop:…` so they never trip the monitor's own cool-off.

**Tech Stack:** Go (services package, `logrus`, `go test`), Alpaca options data/trading services, existing `TradeGuard` and `BeatContextController`.

---

## Design notes carried from the spec (read before starting)

- **Spec:** `docs/superpowers/specs/2026-05-21-prophet-options-auto-stop-monitor-design.md`.
- **`client_order_id` scheme (deviation from spec's "deterministic id," decided during planning):** flatten orders use `v2-options-stop:{symbol}:{unixnano}`. The **prefix** `v2-options-stop` (a) keeps them out of the cool-off filter, which matches on `ParseStrategyFromClientOrderID(coid) == "v2-options"` (`interfaces/trading.go:15` splits on the first colon), and (b) lets the idempotency query find the monitor's own working orders. The **unixnano nonce** guarantees uniqueness so a legitimate cancel-and-replace escalation is never rejected as a duplicate by the broker. The **durable** double-send guard is the `ListOrders` working-order query (§Task 4), not broker id-rejection.
- **Stop %, since-entry:** `lossFraction = -UnrealizedPL / CostBasis` for a long (UnrealizedPL is negative when down). Fires when `lossFraction >= stopPct`. Never use `OptionsPosition.UnrealizedPLPC` (it maps to Alpaca's *intraday* PLPC).
- **Rung pricing:** read a **fresh** quote at each placement. Rung 0 limit = fresh bid (marketable). Rung 1 (terminal) limit = `sanityFloorFrac × fresh_mid` (sweeps all liquidity at/above the floor; rests at the floor and never sells below it if the bid has collapsed).
- **Restart behavior:** double-send is prevented by the broker working-order query (durable). Rung counter is in-memory and resets on restart (acceptable, mirrors Harvest's documented `tierAttempt` behavior); escalation timing reads the working order's broker `SubmittedAt` (durable).
- Prophet's strategy id is the literal `"v2-options"` (`agent/config-store.js:399`). It maps to `AgentMain` via `AgentForStrategy`'s default (`services/trade_guard.go:36`).

---

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `services/alpaca_trading.go` | honor caller-supplied `ClientOrderID` in `PlaceOptionsOrder` | 1 |
| `services/alpaca_trading_test.go` | test for the above (create if absent) | 1 |
| `services/prophet_beat_observer.go` (create) | shared thread-safe holder of `lastProphetBeatAt` | 2 |
| `services/prophet_beat_observer_test.go` (create) | test the holder | 2 |
| `controllers/beat_context_controller.go` | stamp the holder when `strategy=="v2-options"` | 2 |
| `controllers/beat_context_controller_test.go` | test the stamp | 2 |
| `services/trade_guard.go` | add exported `HasRawSymbol` read method | 4 |
| `services/prophet_options_stop_monitor.go` (create) | the monitor: scoping, classify, flatten ladder, grace, cool-off, tick loop | 3,4,5 |
| `services/prophet_options_stop_monitor_test.go` (create) | all monitor tests | 3,4,5 |
| `config/config.go` | parse `ENABLE_PROPHET_OPTIONS_STOP` + 4 tuning vars | 6 |
| `cmd/bot/main.go` | wire + launch the goroutine behind the flag | 6 |
| `TRADING_RULES_V2.md` | document the monitor + flag | 7 |
| `~/.claude/.../memory/risk-enforcement-pr-status.md` + `MEMORY.md` | note Phase 2 shipped | 7 |

---

## Task 1: `PlaceOptionsOrder` honors a caller-supplied `ClientOrderID`

**Why:** The monitor must tag its flatten orders with the `v2-options-stop:` prefix. Today `PlaceOptionsOrder` always overwrites `req.ClientOrderID` with `{strategy}:{uuid}` when `Strategy` is set, so a caller cannot choose the id.

**Files:**
- Modify: `services/alpaca_trading.go:343-388` (`PlaceOptionsOrder`)
- Test: `services/alpaca_trading_test.go` (create if it does not exist)

- [ ] **Step 1: Write the failing test**

Add to `services/alpaca_trading_test.go`. This tests the small, pure id-selection helper we are about to extract (no network):

```go
package services

import "testing"

func TestResolveOptionsClientOrderID(t *testing.T) {
	cases := []struct {
		name          string
		caller        string
		strategy      string
		wantExact     string // when non-empty, result must equal this
		wantGenerated bool   // when true, result must be non-empty and start with strategy+":"
	}{
		{name: "caller-supplied wins", caller: "v2-options-stop:SPY:123", strategy: "v2-options", wantExact: "v2-options-stop:SPY:123"},
		{name: "generated from strategy", caller: "", strategy: "v2-options", wantGenerated: true},
		{name: "empty when neither", caller: "", strategy: "", wantExact: ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveOptionsClientOrderID(tc.caller, tc.strategy)
			if tc.wantExact != "" || (tc.caller == "" && tc.strategy == "") {
				if got != tc.wantExact {
					t.Fatalf("got %q, want %q", got, tc.wantExact)
				}
			}
			if tc.wantGenerated {
				if got == "" || got[:len(tc.strategy)+1] != tc.strategy+":" {
					t.Fatalf("got %q, want generated %q-prefixed id", got, tc.strategy+":")
				}
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestResolveOptionsClientOrderID -v`
Expected: FAIL — `undefined: resolveOptionsClientOrderID`.

- [ ] **Step 3: Extract the helper and use it in `PlaceOptionsOrder`**

In `services/alpaca_trading.go`, add the helper (near `PlaceOptionsOrder`):

```go
// resolveOptionsClientOrderID picks the broker client_order_id for an options
// order: a caller-supplied id always wins (lets the auto-stop monitor tag its
// flatten orders with a distinct "v2-options-stop:" prefix); otherwise, when a
// strategy is set, generate the standard "{strategy}:{uuid}" tag; otherwise empty.
func resolveOptionsClientOrderID(caller, strategy string) string {
	if caller != "" {
		return caller
	}
	if strategy != "" {
		return fmt.Sprintf("%s:%s", strategy, uuid.NewString())
	}
	return ""
}
```

Then replace the id block in `PlaceOptionsOrder` (currently lines ~359-363):

```go
	if coid := resolveOptionsClientOrderID(order.ClientOrderID, order.Strategy); coid != "" {
		req.ClientOrderID = coid
		order.ClientOrderID = coid
	}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./services/ -run TestResolveOptionsClientOrderID -v`
Expected: PASS (3 subtests).

- [ ] **Step 5: Run the full services + controllers suites (no regressions)**

Run: `go test ./services/... ./controllers/...`
Expected: PASS (existing options-order tests still green — the default path is unchanged when `ClientOrderID` is empty).

- [ ] **Step 6: Commit**

```bash
git add services/alpaca_trading.go services/alpaca_trading_test.go
git commit -m "Honor caller-supplied ClientOrderID in PlaceOptionsOrder"
```

---

## Task 2: Beat-observer — record when Prophet takes a beat

**Why:** The monitor's startup grace must know "has Prophet beaten since I booted?" `BeatContextController.HandleGet` already runs every beat with a `strategy` query param; we stamp a shared holder when it's Prophet.

**Files:**
- Create: `services/prophet_beat_observer.go`
- Create: `services/prophet_beat_observer_test.go`
- Modify: `controllers/beat_context_controller.go` (struct + `NewBeatContextController` + `HandleGet`)
- Test: `controllers/beat_context_controller_test.go`

- [ ] **Step 1: Write the failing test for the holder**

Create `services/prophet_beat_observer_test.go`:

```go
package services

import (
	"testing"
	"time"
)

func TestProphetBeatObserver_RecordsLatest(t *testing.T) {
	o := NewProphetBeatObserver()

	if _, ok := o.LastProphetBeat(); ok {
		t.Fatal("expected no beat observed initially")
	}

	t1 := time.Date(2026, 5, 21, 14, 0, 0, 0, time.UTC)
	o.RecordBeat(t1)
	got, ok := o.LastProphetBeat()
	if !ok || !got.Equal(t1) {
		t.Fatalf("got (%v,%v), want (%v,true)", got, ok, t1)
	}

	t2 := t1.Add(time.Minute)
	o.RecordBeat(t2)
	if got, _ := o.LastProphetBeat(); !got.Equal(t2) {
		t.Fatalf("got %v, want latest %v", got, t2)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestProphetBeatObserver -v`
Expected: FAIL — `undefined: NewProphetBeatObserver`.

- [ ] **Step 3: Implement the holder**

Create `services/prophet_beat_observer.go`:

```go
package services

import (
	"sync"
	"time"
)

// ProphetBeatObserver records the wall-clock time of the most recent Prophet
// (v2-options) beat. The auto-stop monitor reads it to implement a
// beats-observed startup grace: the loss floor stays dormant until Prophet has
// taken at least one beat since the monitor booted, deferring to the LLM's next
// decision after a restart/deploy. Thread-safe: written by the beat-context
// HTTP handler, read by the monitor goroutine.
type ProphetBeatObserver struct {
	mu       sync.RWMutex
	last     time.Time
	observed bool
}

func NewProphetBeatObserver() *ProphetBeatObserver {
	return &ProphetBeatObserver{}
}

// RecordBeat stamps the most recent Prophet beat time.
func (o *ProphetBeatObserver) RecordBeat(t time.Time) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.last = t
	o.observed = true
}

// LastProphetBeat returns the most recent beat time and whether any beat has
// been observed.
func (o *ProphetBeatObserver) LastProphetBeat() (time.Time, bool) {
	o.mu.RLock()
	defer o.mu.RUnlock()
	return o.last, o.observed
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestProphetBeatObserver -v`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the controller stamp**

Add to `controllers/beat_context_controller_test.go`. (The file already constructs a `BeatContextController` with five fake fetchers — reuse those fakes; only the new `beatRecorder` arg and assertion are shown. If the existing tests use a helper constructor, thread the new arg through it.)

```go
func TestBeatContext_StampsProphetBeat(t *testing.T) {
	rec := &fakeBeatRecorder{}
	c := newTestBeatController(t, rec) // helper that builds the controller with stub fetchers + rec

	// v2-options strategy → stamped
	doGet(t, c, "/api/v1/beat-context?strategy=v2-options")
	if rec.calls != 1 {
		t.Fatalf("v2-options beat: got %d stamps, want 1", rec.calls)
	}

	// other strategy → not stamped
	doGet(t, c, "/api/v1/beat-context?strategy=penny-momentum")
	if rec.calls != 1 {
		t.Fatalf("penny beat: got %d stamps, want still 1", rec.calls)
	}
}

type fakeBeatRecorder struct{ calls int }

func (f *fakeBeatRecorder) RecordBeat(time.Time) { f.calls++ }
```

> Implementer note: if `beat_context_controller_test.go` has no `newTestBeatController`/`doGet` helpers, add minimal ones using `httptest` and a `gin` engine, mirroring the existing test setup in that file. The assertion that matters: a `strategy=v2-options` GET calls `RecordBeat` exactly once; a non-Prophet strategy does not.

- [ ] **Step 6: Run test to verify it fails**

Run: `go test ./controllers/ -run TestBeatContext_StampsProphetBeat -v`
Expected: FAIL — controller has no beat recorder / does not compile.

- [ ] **Step 7: Wire the recorder into the controller**

In `controllers/beat_context_controller.go`:

Add the interface near the other fetcher interfaces:

```go
// ProphetBeatRecorder records that the Prophet (v2-options) agent took a beat.
// Implemented by *services.ProphetBeatObserver. Optional: nil disables stamping.
type ProphetBeatRecorder interface {
	RecordBeat(t time.Time)
}
```

Add a field to `BeatContextController`:

```go
	beatRec ProphetBeatRecorder
```

Add a setter (keeps `NewBeatContextController`'s signature stable):

```go
// SetProphetBeatRecorder wires the holder stamped on each Prophet beat. Optional.
func (c *BeatContextController) SetProphetBeatRecorder(r ProphetBeatRecorder) { c.beatRec = r }
```

At the **top** of `HandleGet`, after `strategy := ctx.Query("strategy")`:

```go
	if c.beatRec != nil && strategy == "v2-options" {
		c.beatRec.RecordBeat(time.Now().UTC())
	}
```

- [ ] **Step 8: Run the controller test to verify it passes**

Run: `go test ./controllers/ -run TestBeatContext_StampsProphetBeat -v`
Expected: PASS.

- [ ] **Step 9: Run full controllers + services suites**

Run: `go test ./services/... ./controllers/...`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add services/prophet_beat_observer.go services/prophet_beat_observer_test.go controllers/beat_context_controller.go controllers/beat_context_controller_test.go
git commit -m "Add Prophet beat observer and stamp it from beat-context handler"
```

---

## Task 3: Monitor core — scoping + floor classification (read path, no orders)

**Why:** Establish the read path with zero risk of placing an order. Build position scoping (exclude Harvest legs, shorts) and the since-entry loss classification, tested directly.

**Files:**
- Create: `services/prophet_options_stop_monitor.go`
- Create: `services/prophet_options_stop_monitor_test.go`

- [ ] **Step 1: Write the failing tests for scoping + classify**

Create `services/prophet_options_stop_monitor_test.go`:

```go
package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

// --- fakes ---

type fakeOptPositions struct {
	positions []*interfaces.OptionsPosition
	err       error
}

func (f *fakeOptPositions) ListOptionsPositions(_ context.Context) ([]*interfaces.OptionsPosition, error) {
	return f.positions, f.err
}

type fakeCondorLegs struct {
	condors []*models.DBHarvestCondor
	err     error
}

func (f *fakeCondorLegs) ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error) {
	return f.condors, f.err
}

type fakeQuoter struct {
	snaps map[string]*interfaces.OptionContract
	err   error
}

func (f *fakeQuoter) GetOptionSnapshot(_ context.Context, sym string) (*interfaces.OptionContract, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.snaps[sym], nil
}

// recordingFlattener records every order/cancel so tests can assert no writes.
type recordingFlattener struct {
	placed    []*interfaces.OptionsOrder
	canceled  []string
	orders    []*interfaces.Order // returned by ListOrders
	byID      map[string]*interfaces.Order
}

func (f *recordingFlattener) PlaceOptionsOrder(_ context.Context, o *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	f.placed = append(f.placed, o)
	return &interfaces.OrderResult{OrderID: "new-" + o.Symbol, Status: "accepted"}, nil
}
func (f *recordingFlattener) ListOrders(_ context.Context, _ string) ([]*interfaces.Order, error) {
	return f.orders, nil
}
func (f *recordingFlattener) GetOrder(_ context.Context, id string) (*interfaces.Order, error) {
	if f.byID != nil {
		if o, ok := f.byID[id]; ok {
			return o, nil
		}
	}
	return &interfaces.Order{ID: id, Status: "canceled"}, nil
}
func (f *recordingFlattener) CancelOrder(_ context.Context, id string) error {
	f.canceled = append(f.canceled, id)
	return nil
}

func newTestMonitor(pos *fakeOptPositions, legs *fakeCondorLegs, q *fakeQuoter, fl *recordingFlattener) *ProphetOptionsStopMonitor {
	m := NewProphetOptionsStopMonitor(pos, legs, q, fl, ProphetOptionsStopConfig{
		StopPct:         0.50,
		Cooloff:         7 * time.Minute,
		Escalation:      60 * time.Second,
		SanityFloorFrac: 0.50,
	})
	m.SetBootTime(time.Date(2026, 5, 21, 13, 0, 0, 0, time.UTC))
	return m
}

func longPos(sym string, qty, entry, current, costBasis, unrealized float64) *interfaces.OptionsPosition {
	return &interfaces.OptionsPosition{
		Symbol: sym, Qty: qty, AvgEntryPrice: entry, CurrentPrice: current,
		CostBasis: costBasis, UnrealizedPL: unrealized, Side: "long",
	}
}

func TestMonitor_Scoping_ExcludesCondorLegsAndShorts(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	condor := &models.DBHarvestCondor{
		CondorID: "c1", Status: "OPEN",
		ShortPutSymbol: "SPY_sp", LongPutSymbol: "SPY_lp",
		ShortCallSymbol: "SPY_sc", LongCallSymbol: "SPY_lc",
	}
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos("NVDA_C", 10, 5, 2, 5000, -3000), // Prophet long, down 60%
		longPos("SPY_lp", 10, 1, 1, 1000, 0),      // Harvest long leg — must be excluded
		{Symbol: "SPY_sc", Qty: -10, Side: "short", CostBasis: -500, UnrealizedPL: 0}, // short — excluded
	}}
	legs := &fakeCondorLegs{condors: []*models.DBHarvestCondor{condor}}
	m := newTestMonitor(pos, legs, &fakeQuoter{}, &recordingFlattener{})

	got, err := m.prophetPositions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Symbol != "NVDA_C" {
		t.Fatalf("got %v, want only [NVDA_C]", symsOf(got))
	}
	_ = now
}

func TestMonitor_Scoping_KeepsLegsOfClosedCondor(t *testing.T) {
	condor := &models.DBHarvestCondor{CondorID: "c1", Status: "CLOSED", LongPutSymbol: "SPY_lp"}
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("SPY_lp", 10, 1, 1, 1000, 0)}}
	legs := &fakeCondorLegs{condors: []*models.DBHarvestCondor{condor}}
	m := newTestMonitor(pos, legs, &fakeQuoter{}, &recordingFlattener{})

	got, _ := m.prophetPositions(context.Background())
	if len(got) != 1 {
		t.Fatalf("CLOSED condor legs should not be excluded; got %v", symsOf(got))
	}
}

func TestMonitor_LossFraction(t *testing.T) {
	m := newTestMonitor(&fakeOptPositions{}, &fakeCondorLegs{}, &fakeQuoter{}, &recordingFlattener{})
	cases := []struct {
		name        string
		costBasis   float64
		unrealized  float64
		wantFrac    float64
		wantHasData bool
	}{
		{"down 60%", 5000, -3000, 0.60, true},
		{"down 50% exactly", 1000, -500, 0.50, true},
		{"up 20%", 1000, 200, -0.20, true},
		{"zero basis", 0, -100, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			frac, ok := lossFraction(&interfaces.OptionsPosition{CostBasis: tc.costBasis, UnrealizedPL: tc.unrealized})
			if ok != tc.wantHasData {
				t.Fatalf("ok=%v want %v", ok, tc.wantHasData)
			}
			if ok && frac != tc.wantFrac {
				t.Fatalf("frac=%v want %v", frac, tc.wantFrac)
			}
		})
	}
}

// symsOf is a tiny helper for assertion messages.
func symsOf(ps []*interfaces.OptionsPosition) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.Symbol
	}
	return out
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./services/ -run TestMonitor_ -v`
Expected: FAIL — `undefined: NewProphetOptionsStopMonitor` / `ProphetOptionsStopConfig` / `lossFraction`.

- [ ] **Step 3: Implement the monitor skeleton, scoping, and classify**

Create `services/prophet_options_stop_monitor.go`:

```go
package services

import (
	"context"
	"time"

	"github.com/sirupsen/logrus"

	"prophet-trader/interfaces"
	"prophet-trader/models"
)

const (
	prophetStrategyID    = "v2-options"      // LLM order tag (also AgentMain via AgentForStrategy default)
	prophetStopCOIDTag   = "v2-options-stop" // distinct prefix so flatten orders never trip the cool-off
)

// --- narrow dependency interfaces (all fakeable in tests) ---

type optionsPositionLister interface {
	ListOptionsPositions(ctx context.Context) ([]*interfaces.OptionsPosition, error)
}

type condorLegLister interface {
	ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error)
}

type optionsQuoter interface {
	GetOptionSnapshot(ctx context.Context, optionSymbol string) (*interfaces.OptionContract, error)
}

type optionsFlattener interface {
	PlaceOptionsOrder(ctx context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error)
	ListOrders(ctx context.Context, status string) ([]*interfaces.Order, error)
	GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)
	CancelOrder(ctx context.Context, orderID string) error
}

type rawOwnershipChecker interface {
	HasRawSymbol(agent AgentSource, symbol string) bool
}

type beatObserver interface {
	LastProphetBeat() (time.Time, bool)
}

// ProphetOptionsStopConfig holds the tuning knobs (env-wired in main.go).
type ProphetOptionsStopConfig struct {
	StopPct         float64       // 0.50 → flatten at -50% of premium (since entry)
	Cooloff         time.Duration // suppress flatten if LLM acted on the symbol within this window
	Escalation      time.Duration // wait before escalating rung 0 → rung 1
	SanityFloorFrac float64       // terminal limit floor as a fraction of the fresh mid
}

// stopAttempt tracks the current escalation rung for a symbol within this
// process lifetime. In-memory: resets on restart (rung restarts at 0), which is
// acceptable because the durable double-send guard is the broker working-order
// query, not this map.
type stopAttempt struct {
	rung int
}

// ProphetOptionsStopMonitor flattens the Prophet (v2-options) agent's long
// single-leg options positions past a deep catastrophic loss floor. See
// docs/superpowers/specs/2026-05-21-prophet-options-auto-stop-monitor-design.md.
type ProphetOptionsStopMonitor struct {
	positions optionsPositionLister
	condors   condorLegLister
	quoter    optionsQuoter
	flattener optionsFlattener
	rawOwner  rawOwnershipChecker // optional
	beats     beatObserver        // optional
	logger    *logrus.Logger
	cfg       ProphetOptionsStopConfig
	bootTime  time.Time
	attempts  map[string]stopAttempt
}

func NewProphetOptionsStopMonitor(
	positions optionsPositionLister,
	condors condorLegLister,
	quoter optionsQuoter,
	flattener optionsFlattener,
	cfg ProphetOptionsStopConfig,
) *ProphetOptionsStopMonitor {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &ProphetOptionsStopMonitor{
		positions: positions,
		condors:   condors,
		quoter:    quoter,
		flattener: flattener,
		logger:    logger,
		cfg:       cfg,
		bootTime:  time.Now().UTC(),
		attempts:  map[string]stopAttempt{},
	}
}

// SetRawOwnershipChecker wires the read-only guard ownership check used only to
// flag flatten actions taken without a positive ownership record. Optional.
func (m *ProphetOptionsStopMonitor) SetRawOwnershipChecker(c rawOwnershipChecker) { m.rawOwner = c }

// SetBeatObserver wires the beats-observed startup-grace signal. Optional.
func (m *ProphetOptionsStopMonitor) SetBeatObserver(b beatObserver) { m.beats = b }

// SetBootTime overrides the boot time (tests).
func (m *ProphetOptionsStopMonitor) SetBootTime(t time.Time) { m.bootTime = t }

// lossFraction returns the since-entry loss as a positive fraction (0.60 = down
// 60%) and whether it could be computed. Uses UnrealizedPL/CostBasis, NOT the
// position's intraday UnrealizedPLPC field.
func lossFraction(p *interfaces.OptionsPosition) (float64, bool) {
	if p.CostBasis <= 0 {
		return 0, false
	}
	return -p.UnrealizedPL / p.CostBasis, true
}

// prophetPositions returns the long single-leg options positions that belong to
// Prophet — i.e. broker long us_option positions minus every leg of any
// non-CLOSED Harvest condor.
func (m *ProphetOptionsStopMonitor) prophetPositions(ctx context.Context) ([]*interfaces.OptionsPosition, error) {
	all, err := m.positions.ListOptionsPositions(ctx)
	if err != nil {
		return nil, err
	}
	condors, err := m.condors.ListOpenHarvestCondors()
	if err != nil {
		return nil, err // fail the whole tick: cannot scope safely without the exclusion set
	}
	exclude := map[string]struct{}{}
	for _, c := range condors {
		if c.Status == "CLOSED" {
			continue
		}
		for _, leg := range []string{c.ShortPutSymbol, c.LongPutSymbol, c.ShortCallSymbol, c.LongCallSymbol} {
			if leg != "" {
				exclude[leg] = struct{}{}
			}
		}
	}
	var out []*interfaces.OptionsPosition
	for _, p := range all {
		if p.Side != "long" {
			continue
		}
		if _, isLeg := exclude[p.Symbol]; isLeg {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// EvaluateTick runs one read-only pass (Task 3): identify Prophet positions past
// the floor and log them. Order placement is added in Task 4.
func (m *ProphetOptionsStopMonitor) EvaluateTick(ctx context.Context, now time.Time) {
	positions, err := m.prophetPositions(ctx)
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: scoping failed; skipping tick")
		return
	}
	for _, p := range positions {
		frac, ok := lossFraction(p)
		if !ok {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop_no_basis")
			continue
		}
		if frac >= m.cfg.StopPct {
			m.logger.WithFields(logrus.Fields{
				"symbol": p.Symbol, "loss_fraction": frac, "stop_pct": m.cfg.StopPct,
			}).Warn("prophet_options_stop_triggered")
		}
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./services/ -run TestMonitor_ -v`
Expected: PASS (scoping excludes legs/shorts, keeps closed-condor legs, classify math correct).

- [ ] **Step 5: Run full services suite**

Run: `go test ./services/...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/prophet_options_stop_monitor.go services/prophet_options_stop_monitor_test.go
git commit -m "Add Prophet options stop monitor: scoping + loss classification"
```

---

## Task 4: Flatten ladder — placement, escalation, sanity floor, idempotency

**Why:** The write path. On a triggered position: place a marketable-limit sell-to-close (rung 0), escalate to a wide limit bounded by the sanity floor (rung 1), never double-send (broker working-order query), cancel-confirm before replace, size against remaining qty.

**Files:**
- Modify: `services/trade_guard.go` (add exported `HasRawSymbol`)
- Modify: `services/prophet_options_stop_monitor.go` (flatten logic + helpers + `EvaluateTick` wiring)
- Test: `services/prophet_options_stop_monitor_test.go`

- [ ] **Step 1: Write the failing test for `HasRawSymbol`**

Add to `services/trade_guard_test.go`:

```go
func TestTradeGuard_HasRawSymbol(t *testing.T) {
	g := NewTradeGuard(nil, nil, TradeGuardConfig{})
	if g.HasRawSymbol(AgentMain, "NVDA_C") {
		t.Fatal("expected no raw symbol initially")
	}
	g.RecordRawBuy(AgentMain, "NVDA_C")
	if !g.HasRawSymbol(AgentMain, "NVDA_C") {
		t.Fatal("expected NVDA_C after RecordRawBuy")
	}
	if g.HasRawSymbol(AgentPenny, "NVDA_C") {
		t.Fatal("raw symbol must be per-agent")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestTradeGuard_HasRawSymbol -v`
Expected: FAIL — `undefined: g.HasRawSymbol`.

- [ ] **Step 3: Implement `HasRawSymbol`**

In `services/trade_guard.go`, near `agentOwnsSymbol`:

```go
// HasRawSymbol reports whether the agent has a raw (non-managed) ownership
// record for the symbol. Read-only; used by the options stop monitor to flag a
// flatten taken without a positive ownership record.
func (g *TradeGuard) HasRawSymbol(agent AgentSource, symbol string) bool {
	if agent == "" {
		agent = AgentMain
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	_, ok := g.rawSymbols[agent][symbol]
	return ok
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run TestTradeGuard_HasRawSymbol -v`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for the flatten ladder**

Add to `services/prophet_options_stop_monitor_test.go`. These call `EvaluateTick` end-to-end against the fakes:

```go
func snap(bid, ask float64) *interfaces.OptionContract {
	return &interfaces.OptionContract{Bid: bid, Ask: ask, Premium: (bid + ask) / 2}
}

func TestMonitor_PlacesRung0OnTrigger(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{
		longPos("NVDA_C", 10, 5, 2, 5000, -3000), // down 60%
	}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute))) // grace satisfied
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 1 {
		t.Fatalf("got %d placements, want 1", len(fl.placed))
	}
	o := fl.placed[0]
	if o.Side != "sell" || o.PositionIntent != "sell_to_close" {
		t.Fatalf("got side=%s intent=%s, want sell/sell_to_close", o.Side, o.PositionIntent)
	}
	if o.Qty != 10 {
		t.Fatalf("got qty %v, want 10", o.Qty)
	}
	if o.LimitPrice == nil || *o.LimitPrice != 1.90 { // rung 0 = fresh bid
		t.Fatalf("got limit %v, want 1.90 (bid)", o.LimitPrice)
	}
	if o.ClientOrderID[:len(prophetStopCOIDTag)] != prophetStopCOIDTag {
		t.Fatalf("got coid %q, want %q prefix", o.ClientOrderID, prophetStopCOIDTag)
	}
}

func TestMonitor_NoDoubleSendWhenWorkingOrderExists(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "new",
			ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-10 * time.Second)},
	}}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 0 {
		t.Fatalf("within escalation window with a working order: want 0 placements, got %d", len(fl.placed))
	}
	if len(fl.canceled) != 0 {
		t.Fatalf("want 0 cancels (still inside window), got %d", len(fl.canceled))
	}
}

func TestMonitor_EscalatesAfterWindow_CancelConfirmThenWideLimit(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.40, 1.80)}} // mid 1.60
	working := &interfaces.Order{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "new",
		ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-120 * time.Second), FilledQty: 0}
	fl := &recordingFlattener{
		orders: []*interfaces.Order{working},
		byID:   map[string]*interfaces.Order{"w1": {ID: "w1", Status: "canceled", FilledQty: 0}},
	}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.canceled) != 1 || fl.canceled[0] != "w1" {
		t.Fatalf("want cancel of w1, got %v", fl.canceled)
	}
	if len(fl.placed) != 1 {
		t.Fatalf("want 1 escalation placement, got %d", len(fl.placed))
	}
	// rung 1 terminal limit = sanityFloorFrac(0.50) * fresh mid(1.60) = 0.80
	if *fl.placed[0].LimitPrice != 0.80 {
		t.Fatalf("got limit %v, want 0.80 (sanity floor)", *fl.placed[0].LimitPrice)
	}
}

func TestMonitor_EscalationSizesAgainstRemainingQty(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.40, 1.80)}}
	working := &interfaces.Order{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "partially_filled",
		ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-120 * time.Second), FilledQty: 4}
	fl := &recordingFlattener{
		orders: []*interfaces.Order{working},
		byID:   map[string]*interfaces.Order{"w1": {ID: "w1", Status: "canceled", FilledQty: 4}},
	}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 1 || fl.placed[0].Qty != 6 { // 10 - 4 filled
		t.Fatalf("want escalation qty 6, got %v", fl.placed)
	}
}

func TestMonitor_SanityFloorRestsWhenBidBelowFloor(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	// phantom: mid 1.60, floor 0.80, but bid collapsed to 0.05
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(0.05, 3.15)}}
	working := &interfaces.Order{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "new",
		ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-120 * time.Second)}
	fl := &recordingFlattener{orders: []*interfaces.Order{working}, byID: map[string]*interfaces.Order{"w1": {ID: "w1", Status: "canceled"}}}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)

	if len(fl.placed) != 1 {
		t.Fatalf("want 1 placement resting at floor, got %d", len(fl.placed))
	}
	mid := (0.05 + 3.15) / 2 // 1.60
	if *fl.placed[0].LimitPrice != 0.50*mid { // never below floor
		t.Fatalf("got %v, want floor %v", *fl.placed[0].LimitPrice, 0.50*mid)
	}
}

// beatObserved returns a beatObserver stub reporting a beat at t.
func beatObserved(t time.Time) beatObserver { return stubBeats{t: t, ok: true} }
func noBeats() beatObserver                 { return stubBeats{} }

type stubBeats struct {
	t  time.Time
	ok bool
}

func (s stubBeats) LastProphetBeat() (time.Time, bool) { return s.t, s.ok }
```

- [ ] **Step 6: Run to verify they fail**

Run: `go test ./services/ -run TestMonitor_ -v`
Expected: FAIL — flatten not implemented; no placements occur.

- [ ] **Step 7: Implement the flatten ladder**

In `services/prophet_options_stop_monitor.go`, add helpers and replace the trigger branch of `EvaluateTick` with a call to `flatten`. Add `"fmt"` and `"strings"` to imports.

```go
// workingFlattenOrder returns the monitor's own still-working sell-to-close
// order for a symbol, if any, from a pre-fetched order list. "Working" = not in
// a terminal state. This is the durable double-send guard: it survives a restart
// because it reads broker state, not in-memory state.
func workingFlattenOrder(symbol string, orders []*interfaces.Order) *interfaces.Order {
	for _, o := range orders {
		if o.Symbol != symbol || o.Side != "sell" {
			continue
		}
		if !strings.HasPrefix(o.ClientOrderID, prophetStopCOIDTag+":") {
			continue
		}
		switch o.Status {
		case "filled", "canceled", "expired", "rejected", "done_for_day", "replaced":
			continue
		}
		return o
	}
	return nil
}

// llmActedRecently reports whether an LLM (v2-options-tagged) order touched the
// symbol within the cool-off window. The monitor's own flatten orders are tagged
// "v2-options-stop" → ParseStrategyFromClientOrderID returns "v2-options-stop",
// not "v2-options", so they never count here.
func llmActedRecently(symbol string, orders []*interfaces.Order, now time.Time, window time.Duration) bool {
	for _, o := range orders {
		if o.Symbol != symbol {
			continue
		}
		if interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID) != prophetStrategyID {
			continue
		}
		if now.Sub(o.SubmittedAt) <= window {
			return true
		}
	}
	return false
}

// flattenLimit returns the limit price for a rung given a fresh quote. Rung 0 is
// a marketable limit at the bid; rung 1+ is the sanity floor (sweeps all
// liquidity at/above the floor, rests at it, never sells below it).
func (m *ProphetOptionsStopMonitor) flattenLimit(rung int, bid, ask float64) float64 {
	mid := (bid + ask) / 2
	floor := m.cfg.SanityFloorFrac * mid
	if rung == 0 && bid > 0 {
		return bid
	}
	return floor
}

// placeFlatten places a sell-to-close at the given rung/qty with a uniquely
// tagged client_order_id, and records the rung in-memory.
func (m *ProphetOptionsStopMonitor) placeFlatten(ctx context.Context, symbol string, qty float64, rung int, bid, ask float64, now time.Time) {
	limit := m.flattenLimit(rung, bid, ask)
	coid := fmt.Sprintf("%s:%s:%d", prophetStopCOIDTag, symbol, now.UnixNano())
	order := &interfaces.OptionsOrder{
		Symbol:         symbol,
		Qty:            qty,
		Side:           "sell",
		PositionIntent: "sell_to_close",
		Type:           "limit",
		TimeInForce:    "day",
		LimitPrice:     &limit,
		ClientOrderID:  coid, // distinct prefix; honored by PlaceOptionsOrder (Task 1)
	}
	if m.rawOwner != nil && !m.rawOwner.HasRawSymbol(AgentMain, symbol) {
		m.logger.WithField("symbol", symbol).Warn("prophet_options_stop_unattributed")
	}
	if _, err := m.flattener.PlaceOptionsOrder(ctx, order); err != nil {
		m.logger.WithError(err).WithField("symbol", symbol).Error("prophet_options_stop: place failed")
		return
	}
	m.attempts[symbol] = stopAttempt{rung: rung}
	m.logger.WithFields(logrus.Fields{
		"symbol": symbol, "rung": rung, "qty": qty, "limit": limit,
	}).Warn("prophet_options_stop_flattened")
}

// flatten handles one triggered position: idempotency, escalation, placement.
func (m *ProphetOptionsStopMonitor) flatten(ctx context.Context, p *interfaces.OptionsPosition, orders []*interfaces.Order, now time.Time) {
	snap, err := m.quoter.GetOptionSnapshot(ctx, p.Symbol)
	if err != nil || snap == nil || (snap.Bid <= 0 && snap.Ask <= 0) {
		m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop: no quote; skipping")
		return
	}

	working := workingFlattenOrder(p.Symbol, orders)
	if working != nil {
		if now.Sub(working.SubmittedAt) < m.cfg.Escalation {
			return // still inside the escalation window
		}
		// Escalate: cancel-confirm-before-replace.
		if err := m.flattener.CancelOrder(ctx, working.ID); err != nil {
			m.logger.WithError(err).WithField("symbol", p.Symbol).Error("prophet_options_stop: cancel failed")
			return
		}
		confirmed, err := m.flattener.GetOrder(ctx, working.ID)
		if err != nil || confirmed == nil || (confirmed.Status != "canceled" && confirmed.Status != "filled") {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop: cancel not yet confirmed; will retry next tick")
			return
		}
		if confirmed.Status == "filled" {
			return // nothing left to escalate
		}
		remaining := absQty(p.Qty) - confirmed.FilledQty
		if remaining <= 0 {
			return
		}
		nextRung := m.attempts[p.Symbol].rung + 1
		m.logger.WithFields(logrus.Fields{"symbol": p.Symbol, "rung": nextRung}).Warn("prophet_options_stop_escalated")
		m.placeFlatten(ctx, p.Symbol, remaining, nextRung, snap.Bid, snap.Ask, now)
		return
	}

	// No working order → fresh placement at rung 0 for the full position qty.
	m.placeFlatten(ctx, p.Symbol, absQty(p.Qty), 0, snap.Bid, snap.Ask, now)
}

func absQty(q float64) float64 {
	if q < 0 {
		return -q
	}
	return q
}
```

Now replace the trigger branch in `EvaluateTick`. The function becomes (note: the grace and cool-off gating are added in Task 5; here we always proceed once triggered, but the tests already satisfy grace via `SetBeatObserver`, so guard on it now to keep tests honest):

```go
func (m *ProphetOptionsStopMonitor) EvaluateTick(ctx context.Context, now time.Time) {
	positions, err := m.prophetPositions(ctx)
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: scoping failed; skipping tick")
		return
	}
	orders, err := m.flattener.ListOrders(ctx, "all")
	if err != nil {
		m.logger.WithError(err).Warn("prophet_options_stop: list orders failed; skipping tick")
		return
	}
	for _, p := range positions {
		frac, ok := lossFraction(p)
		if !ok {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop_no_basis")
			continue
		}
		if frac < m.cfg.StopPct {
			delete(m.attempts, p.Symbol) // recovered above floor; reset rung
			continue
		}
		m.logger.WithFields(logrus.Fields{
			"symbol": p.Symbol, "loss_fraction": frac, "stop_pct": m.cfg.StopPct,
		}).Warn("prophet_options_stop_triggered")
		m.flatten(ctx, p, orders, now)
	}
}
```

> The `ListOrders(ctx, "all")` call is fetched once per tick and reused for both the working-order (idempotency) check and the cool-off (Task 5).

- [ ] **Step 8: Run to verify they pass**

Run: `go test ./services/ -run TestMonitor_ -v`
Expected: PASS (rung-0 placement, no-double-send, escalation with cancel-confirm + wide limit, remaining-qty sizing, sanity-floor rest).

- [ ] **Step 9: Run full services suite**

Run: `go test ./services/...`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add services/trade_guard.go services/trade_guard_test.go services/prophet_options_stop_monitor.go services/prophet_options_stop_monitor_test.go
git commit -m "Add Prophet options stop flatten ladder with durable idempotency"
```

---

## Task 5: Startup grace + cool-off gating

**Why:** Keep the floor from stomping the LLM: stay dormant until Prophet beats since boot, and suppress a flatten when the LLM acted on the symbol within the cool-off window.

**Files:**
- Modify: `services/prophet_options_stop_monitor.go` (`EvaluateTick` gating + a `graceSatisfied` helper)
- Test: `services/prophet_options_stop_monitor_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `services/prophet_options_stop_monitor_test.go`:

```go
func TestMonitor_GraceSuppressesUntilBeatObserved(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBootTime(now.Add(-30 * time.Second))

	// No beats observed at all → suppressed.
	m.SetBeatObserver(noBeats())
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("no beats: want 0 placements, got %d", len(fl.placed))
	}

	// A beat BEFORE boot → still suppressed (must be since boot).
	m.SetBeatObserver(beatObserved(now.Add(-90 * time.Second)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("pre-boot beat: want 0 placements, got %d", len(fl.placed))
	}

	// A beat AFTER boot → live.
	m.SetBeatObserver(beatObserved(now.Add(-10 * time.Second)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 1 {
		t.Fatalf("post-boot beat: want 1 placement, got %d", len(fl.placed))
	}
}

func TestMonitor_NoBeatObserverMeansGraceOff(t *testing.T) {
	// When no beat observer is wired (e.g. wall-clock fallback not used in tests),
	// the monitor must not be permanently dormant — it falls through to live.
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl) // no SetBeatObserver
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 1 {
		t.Fatalf("no observer wired: want 1 placement (grace off), got %d", len(fl.placed))
	}
}

func TestMonitor_CooloffSuppressesWhenLLMActedRecently(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	// LLM bought-to-open NVDA_C 2 minutes ago (within 7m cool-off).
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "llm1", Symbol: "NVDA_C", Side: "buy", Status: "filled",
			ClientOrderID: "v2-options:abc", SubmittedAt: now.Add(-2 * time.Minute)},
	}}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 0 {
		t.Fatalf("recent LLM action: want 0 placements (cool-off), got %d", len(fl.placed))
	}
}

func TestMonitor_CooloffStaleActionDoesNotSuppress(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.90, 2.10)}}
	fl := &recordingFlattener{orders: []*interfaces.Order{
		{ID: "llm1", Symbol: "NVDA_C", Side: "buy", Status: "filled",
			ClientOrderID: "v2-options:abc", SubmittedAt: now.Add(-30 * time.Minute)}, // stale
	}}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	if len(fl.placed) != 1 {
		t.Fatalf("stale LLM action: want 1 placement, got %d", len(fl.placed))
	}
}

func TestMonitor_MonitorOwnFlattenDoesNotTripCooloff(t *testing.T) {
	now := time.Date(2026, 5, 21, 15, 0, 0, 0, time.UTC)
	pos := &fakeOptPositions{positions: []*interfaces.OptionsPosition{longPos("NVDA_C", 10, 5, 2, 5000, -3000)}}
	q := &fakeQuoter{snaps: map[string]*interfaces.OptionContract{"NVDA_C": snap(1.40, 1.80)}}
	// The monitor's own working flatten from 2 min ago (past escalation window).
	working := &interfaces.Order{ID: "w1", Symbol: "NVDA_C", Side: "sell", Status: "new",
		ClientOrderID: "v2-options-stop:NVDA_C:111", SubmittedAt: now.Add(-2 * time.Minute)}
	fl := &recordingFlattener{orders: []*interfaces.Order{working}, byID: map[string]*interfaces.Order{"w1": {ID: "w1", Status: "canceled"}}}
	m := newTestMonitor(pos, &fakeCondorLegs{}, q, fl)
	m.SetBeatObserver(beatObserved(now.Add(-time.Minute)))
	m.EvaluateTick(context.Background(), now)
	// If the monitor's own order tripped the cool-off, it would suppress and not
	// escalate. It must escalate (cancel + replace).
	if len(fl.canceled) != 1 || len(fl.placed) != 1 {
		t.Fatalf("own flatten must not trip cool-off; got canceled=%d placed=%d", len(fl.canceled), len(fl.placed))
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `go test ./services/ -run TestMonitor_ -v`
Expected: FAIL — grace/cool-off not yet gating (the no-beats and cool-off tests place orders when they should not).

- [ ] **Step 3: Add the grace + cool-off gating to `EvaluateTick`**

In `services/prophet_options_stop_monitor.go`, add the helper:

```go
// graceSatisfied reports whether the beats-observed startup grace has elapsed:
// Prophet has taken a beat since the monitor booted. When no beat observer is
// wired, grace is off (returns true) so the monitor is never permanently
// dormant — the wall-clock fallback (if ever needed) lives in main.go wiring.
func (m *ProphetOptionsStopMonitor) graceSatisfied() bool {
	if m.beats == nil {
		return true
	}
	last, ok := m.beats.LastProphetBeat()
	return ok && last.After(m.bootTime)
}
```

Insert the gates in `EvaluateTick`, immediately after the `prophet_options_stop_triggered` log and **before** `m.flatten(...)`:

```go
		if !m.graceSatisfied() {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop_grace_suppressed")
			continue
		}
		if llmActedRecently(p.Symbol, orders, now, m.cfg.Cooloff) {
			m.logger.WithField("symbol", p.Symbol).Warn("prophet_options_stop_cooloff_suppressed")
			continue
		}
```

- [ ] **Step 4: Run to verify they pass**

Run: `go test ./services/ -run TestMonitor_ -v`
Expected: PASS (grace suppresses pre-boot/no-beat; cool-off suppresses recent LLM action; stale action and the monitor's own flatten do not suppress).

- [ ] **Step 5: Run full services suite**

Run: `go test ./services/...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/prophet_options_stop_monitor.go services/prophet_options_stop_monitor_test.go
git commit -m "Add beats-observed grace and cool-off gating to options stop monitor"
```

---

## Task 6: The tick loop + config + main.go wiring (flag-gated, default OFF)

**Why:** Make it runnable. Add the `Start` loop, parse config, and launch the goroutine behind `ENABLE_PROPHET_OPTIONS_STOP`.

**Files:**
- Modify: `services/prophet_options_stop_monitor.go` (add `Start`)
- Test: `services/prophet_options_stop_monitor_test.go` (a `Start` smoke test that cancels promptly)
- Modify: `config/config.go`
- Modify: `cmd/bot/main.go`

- [ ] **Step 1: Write the failing `Start` test**

Add to `services/prophet_options_stop_monitor_test.go`:

```go
func TestMonitor_StartTicksWhileOpenAndStops(t *testing.T) {
	pos := &fakeOptPositions{} // no positions → no orders
	fl := &recordingFlattener{}
	m := newTestMonitor(pos, &fakeCondorLegs{}, &fakeQuoter{}, fl)

	ctx, cancel := context.WithCancel(context.Background())
	open := func() bool { return true }
	done := make(chan struct{})
	go func() { m.Start(ctx, time.Millisecond, time.Millisecond, open); close(done) }()
	time.Sleep(10 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Start did not return after ctx cancel")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestMonitor_StartTicksWhileOpenAndStops -v`
Expected: FAIL — `m.Start undefined`.

- [ ] **Step 3: Implement `Start` (mirrors HarvestExitMonitor.Start)**

In `services/prophet_options_stop_monitor.go`:

```go
// Start runs the monitor's tick loop: every `interval` while marketIsOpen()
// reports true, else sleeps `idleInterval`. Returns when ctx is canceled.
// Launch as `go monitor.Start(...)` from main.go.
func (m *ProphetOptionsStopMonitor) Start(ctx context.Context, interval, idleInterval time.Duration, marketIsOpen func() bool) {
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if marketIsOpen() {
				m.EvaluateTick(ctx, time.Now().UTC())
				timer.Reset(interval)
			} else {
				timer.Reset(idleInterval)
			}
		}
	}
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run TestMonitor_StartTicksWhileOpenAndStops -v`
Expected: PASS.

- [ ] **Step 5: Add config parsing**

In `config/config.go`, add fields to the `Config` struct (near the Phase 1 `MaxPositionPct` field, ~line 44):

```go
	EnableProphetOptionsStop   bool
	ProphetOptionsStopPct      float64
	ProphetOptionsStopCooloffMin   float64
	ProphetOptionsStopEscalationSec float64
	ProphetOptionsStopSanityFloorFrac float64
```

In the loader (near the Phase 1 `ENABLE_POSITION_CAPS` parse, ~line 86), add:

```go
		EnableProphetOptionsStop:          getEnvOrDefault("ENABLE_PROPHET_OPTIONS_STOP", "false") == "true",
		ProphetOptionsStopPct:             parseFloat(getEnvOrDefault("PROPHET_OPTIONS_STOP_PCT", "0.50")),
		ProphetOptionsStopCooloffMin:      parseFloat(getEnvOrDefault("PROPHET_OPTIONS_STOP_COOLOFF_MIN", "7")),
		ProphetOptionsStopEscalationSec:   parseFloat(getEnvOrDefault("PROPHET_OPTIONS_STOP_ESCALATION_SEC", "60")),
		ProphetOptionsStopSanityFloorFrac: parseFloat(getEnvOrDefault("PROPHET_OPTIONS_STOP_SANITY_FLOOR_FRAC", "0.50")),
```

> Match the exact field-assignment style already used in this file (struct literal vs. field assignment). If the loader uses a struct literal, add the lines there; if it sets fields on a `cfg` var, mirror that.

- [ ] **Step 6: Verify config compiles + parses**

Run: `go build ./... && go test ./config/...`
Expected: PASS (build clean; config tests, if any, still green).

- [ ] **Step 7: Wire the goroutine in `main.go`**

In `cmd/bot/main.go`, immediately after the Harvest exit-monitor block (after line ~321), add. This reuses `tradingService`, the existing `nyLoc`/`marketIsOpen` pattern, `tradeGuard`, and the `beatObserver` (also wired into the beat-context controller — see note):

```go
	// Prophet options auto-stop monitor (default OFF; operator opts in).
	// A deep catastrophic loss floor on Prophet's long single-leg options that
	// the LLM heartbeat can't react to fast enough (esp. overnight gap at the
	// open). Scoped to v2-options long positions; never touches Harvest legs.
	if cfg.EnableProphetOptionsStop {
		optDataSvc := services.NewAlpacaOptionsDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey)
		stopMonitor := services.NewProphetOptionsStopMonitor(
			tradingService, // ListOptionsPositions
			storageService, // ListOpenHarvestCondors
			optDataSvc,     // GetOptionSnapshot
			tradingService, // PlaceOptionsOrder / ListOrders / GetOrder / CancelOrder
			services.ProphetOptionsStopConfig{
				StopPct:         cfg.ProphetOptionsStopPct,
				Cooloff:         time.Duration(cfg.ProphetOptionsStopCooloffMin) * time.Minute,
				Escalation:      time.Duration(cfg.ProphetOptionsStopEscalationSec) * time.Second,
				SanityFloorFrac: cfg.ProphetOptionsStopSanityFloorFrac,
			},
		)
		stopMonitor.SetRawOwnershipChecker(tradeGuard)
		stopMonitor.SetBeatObserver(prophetBeatObserver) // see Step 8
		nyLoc2, _ := time.LoadLocation("America/New_York")
		stopMarketOpen := func() bool { return services.StaticMarketPhase(time.Now().UTC(), nyLoc2) == "open" }
		go stopMonitor.Start(ctx, 1*time.Minute, 5*time.Minute, stopMarketOpen)
		logger.Info("Prophet options stop monitor started (ENABLE_PROPHET_OPTIONS_STOP=true)")
	} else {
		logger.Info("Prophet options stop monitor disabled (ENABLE_PROPHET_OPTIONS_STOP!=true)")
	}
```

- [ ] **Step 8: Wire the shared beat observer into the beat-context controller**

Still in `main.go`, where `BeatContextController` is constructed, create the shared observer and register it. Find the `NewBeatContextController(...)` call (grep `NewBeatContextController`), and just after it add:

```go
	prophetBeatObserver := services.NewProphetBeatObserver()
	beatContextController.SetProphetBeatRecorder(prophetBeatObserver)
```

> Ordering: `prophetBeatObserver` must be declared before the Step 7 block uses it. If the beat-context controller is constructed *after* line 321, move the `prophetBeatObserver := ...` declaration above the Step 7 block (declare the observer near the top of the wiring section, register it on the controller wherever that's built, and reference it in Step 7). The observer is a plain struct with no dependencies, so it can be created at any point before both uses. Verify the actual variable name of the beat-context controller via grep.

- [ ] **Step 9: Build the whole binary**

Run: `go build ./...`
Expected: clean build (no unused-variable / undeclared errors).

- [ ] **Step 10: Run the full Go suite**

Run: `go test ./...`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add services/prophet_options_stop_monitor.go services/prophet_options_stop_monitor_test.go config/config.go cmd/bot/main.go
git commit -m "Wire Prophet options stop monitor behind ENABLE_PROPHET_OPTIONS_STOP"
```

---

## Task 7: Documentation + memory

**Why:** Reconcile docs with the new enforced behavior and record Phase 2 shipping.

**Files:**
- Modify: `TRADING_RULES_V2.md`
- Modify: `~/.claude/projects/.../memory/risk-enforcement-pr-status.md` and `MEMORY.md`

- [ ] **Step 1: Document the monitor in `TRADING_RULES_V2.md`**

Find the section describing code-enforced limits / the `ENABLE_POSITION_CAPS` flag (added in Phase 1). Add a subsection:

```markdown
### Options auto-stop monitor (code-enforced, flag-gated)

When `ENABLE_PROPHET_OPTIONS_STOP=true`, a Go monitor polls Prophet's **long
single-leg** options positions every minute during market hours and flattens any
position past a **deep catastrophic floor** (`PROPHET_OPTIONS_STOP_PCT`, default
−50% of premium since entry). This is a backstop *far below* your ~−15%
discretionary stop — it exists for overnight gap-downs the heartbeat can't catch,
not normal loss management. It defers to you: it stays dormant until you've taken
a beat since it started, and suppresses itself for a few minutes after you act on
a symbol. It never touches Harvest condor legs. Default OFF (observe first).
```

- [ ] **Step 2: Verify no other doc overstates the prior "no automated stop" claim**

Run: `grep -rn "no automated stop\|stock-only" TRADING_RULES_V2.md TRADING_RULES.md`
Expected: review hits; update any that now read as false when the flag is on (qualify with "unless `ENABLE_PROPHET_OPTIONS_STOP`").

- [ ] **Step 3: Update memory**

Update `risk-enforcement-pr-status.md` to note Phase 2 (the options auto-stop monitor) is implemented on branch `prophet-options-auto-stop`, and adjust the `MEMORY.md` index hook line. (Use the Write/Edit tools on the memory files, not git.)

- [ ] **Step 4: Commit the repo docs**

```bash
git add TRADING_RULES_V2.md
git commit -m "Document Prophet options auto-stop monitor in TRADING_RULES_V2"
```

> The memory files live outside the repo and are not committed.

---

## Final whole-branch review (do not skip)

After Task 7, before any PR: run the whole-branch review (Phase 1's final review caught a critical nil-map panic). Use `superpowers:requesting-code-review`. Then run the full suites once more:

```bash
go test ./...
node --test   # only if any JS changed (none expected in this plan)
```

Expected: all green, with real output, before any "done" claim or PR.

---

## Self-review (completed by plan author)

**Spec coverage:** §3 lifecycle → Task 6 `Start` + wiring. §4 scoping → Task 3 `prophetPositions` (+ `_unattributed` in Task 4 `placeFlatten`). §5a floor → Task 3 `lossFraction`/classify. §5b grace → Task 2 + Task 5 `graceSatisfied`. §5c cool-off → Task 5 `llmActedRecently`. §6 flatten ladder/sanity floor/cancel-confirm/remaining-qty → Task 4. §6c idempotency → Task 4 `workingFlattenOrder` + Task 1 `ClientOrderID`. §7 guard bypass → Task 6 calls `tradingService.PlaceOptionsOrder` directly. §8 fail policy → Task 3/4 (scoping/list failures skip the tick; per-position quote failure skips that position). §9 config → Task 6. §10 tests → every task. §11 sequencing → task order matches.

**Placeholder scan:** No TBD/TODO; every code step has concrete code. The two "implementer note" callouts (test-helper shape in Task 2, struct-literal style in Task 6) point at existing-file conventions the implementer must match, not missing logic.

**Type consistency:** `ProphetOptionsStopConfig{StopPct,Cooloff,Escalation,SanityFloorFrac}` consistent across Tasks 3–6. `lossFraction`, `prophetPositions`, `flatten`, `placeFlatten`, `flattenLimit`, `workingFlattenOrder`, `llmActedRecently`, `graceSatisfied` names consistent. `beatObserver.LastProphetBeat() (time.Time, bool)` matches `ProphetBeatObserver` (Task 2) and the `stubBeats` test fake (Task 4). `prophetStopCOIDTag = "v2-options-stop"` used in placement, working-order detection, and cool-off exclusion consistently.
