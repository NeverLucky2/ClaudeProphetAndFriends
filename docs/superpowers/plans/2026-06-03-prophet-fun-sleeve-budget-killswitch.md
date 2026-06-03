# Prophet Fun-Sleeve Budget + Kill-Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A flag-gated (default OFF), fail-closed Go pre-trade gate that enforces Prophet's live "fun sleeve" exposure cap, a separate permanent loss-budget disarm, per-position + concurrency caps, an independent manual kill switch, a required off-ramp deadline, and a PDT backstop — at the Go broker chokepoint.

**Architecture:** A self-contained `services.ProphetSleeveGuard` invoked in the existing opens-only / Prophet-scoped branch of `PlaceOptionsOrder`, after the existing `CheckOptionsOpen` + `CheckBuy`. It reads the dedicated sleeve account (every open position is the sleeve's), computes broker-derived realized loss off a configured constant baseline `B`, and blocks opens via returned errors. Two on-disk latch files (auto loss-budget + manual kill) survive restart and re-arm only by deliberate file deletion. Default OFF everywhere → the shared-paper fleet is untouched.

**Tech Stack:** Go (services + gin controllers), TDD via `go test ./services/` and `go test ./controllers/`. Spec: `docs/superpowers/specs/2026-06-03-prophet-fun-sleeve-budget-killswitch-design.md`.

**Windows/gotchas (from prior sessions):** `gofmt -l` flags ALL Go files (global CRLF artifact — NOT actionable, do NOT `gofmt -w`). Stale gopls "undefined" diagnostics after edits are noise — verify via real `go build ./...`. Run `go test` from the repo root.

**Final integration:** one squashed commit per backlog item (squash the per-task commits below at the end). Fold the spec + this plan into that squash. **Do NOT commit the squash / push / merge without explicit operator approval.** Per-task commits below are local checkpoints for subagent-driven execution.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `config/config.go` | env → `Config` sleeve fields | Modify |
| `config/config_test.go` | sleeve config defaults test | Modify |
| `services/prophet_sleeve_guard.go` | the entire sleeve money-logic unit | Create |
| `services/prophet_sleeve_guard_test.go` | unit tests | Create |
| `controllers/order_controller.go` | invoke guard on opening options buys | Modify |
| `controllers/order_controller_test.go` | close-never-blocked + open-blocked tests | Modify |
| `controllers/sleeve_controller.go` | `GET /sleeve/status` + `POST /sleeve/kill` | Create |
| `cmd/bot/main.go` | construct guard, wire controller, register routes | Modify |
| `TRADING_RULES_V2.md` | note 422 from sleeve gates | Modify |
| `agent/public/index.html` | teaching status card | Modify |

---

## Task 1: Config fields

**Files:**
- Modify: `config/config.go`
- Modify: `config/config_test.go`

- [ ] **Step 1: Write the failing test**

Add to `config/config_test.go` (inside the existing test file's package):

```go
func TestLoad_ProphetSleeveDefaults(t *testing.T) {
	for _, k := range []string{
		"ENABLE_PROPHET_SLEEVE", "PROPHET_SLEEVE_BASELINE_USD",
		"PROPHET_SLEEVE_MAX_POSITION_FRAC", "PROPHET_SLEEVE_MAX_POSITIONS",
		"PROPHET_SLEEVE_LOSS_BUDGET_FRAC", "PROPHET_SLEEVE_DEADLINE",
		"PROPHET_SLEEVE_DISARM_DIR",
	} {
		os.Unsetenv(k)
	}
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	c := AppConfig
	if c.EnableProphetSleeve {
		t.Errorf("EnableProphetSleeve should default false")
	}
	if c.ProphetSleeveBaselineUSD != 0 {
		t.Errorf("baseline default = %v, want 0", c.ProphetSleeveBaselineUSD)
	}
	if c.ProphetSleeveMaxPositionFrac != 0.25 {
		t.Errorf("max-position-frac default = %v, want 0.25", c.ProphetSleeveMaxPositionFrac)
	}
	if c.ProphetSleeveMaxPositions != 5 {
		t.Errorf("max-positions default = %v, want 5", c.ProphetSleeveMaxPositions)
	}
	if c.ProphetSleeveLossBudgetFrac != 0.50 {
		t.Errorf("loss-budget-frac default = %v, want 0.50", c.ProphetSleeveLossBudgetFrac)
	}
	if c.ProphetSleeveDeadline != "" {
		t.Errorf("deadline default = %q, want empty", c.ProphetSleeveDeadline)
	}
}
```

(If `os` is not already imported in `config_test.go`, add it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./config/ -run TestLoad_ProphetSleeveDefaults -v`
Expected: FAIL (compile error — `EnableProphetSleeve` undefined).

- [ ] **Step 3: Add the config fields**

In `config/config.go`, add to the `Config` struct (after the `BarCache*` block, before the closing `}`):

```go
	// Prophet fun-sleeve real-money safety gate. Flag-gated, default OFF.
	// Unlike the other gates, this one FAILS CLOSED on missing config (a money
	// gate's safe state is "block"). See the 2026-06-03 spec.
	EnableProphetSleeve          bool
	ProphetSleeveBaselineUSD     float64 // funded baseline B; <=0 => fail closed when enabled
	ProphetSleeveMaxPositionFrac float64 // per-position cap as fraction of B (0.25)
	ProphetSleeveMaxPositions    int     // concurrency cap (5)
	ProphetSleeveLossBudgetFrac  float64 // permanent-disarm realized-loss threshold as fraction of B (0.50)
	ProphetSleeveDeadline        string  // off-ramp date YYYY-MM-DD; empty/invalid => fail closed when enabled
	ProphetSleeveDisarmDir       string  // dir for kill/latch files; empty => derive from DatabasePath dir in main.go
```

In `Load()`, add to the `AppConfig = &Config{...}` literal (after the `BarCache*` lines):

```go
		EnableProphetSleeve:          getEnvOrDefault("ENABLE_PROPHET_SLEEVE", "false") == "true",
		ProphetSleeveBaselineUSD:     parseFloat(getEnvOrDefault("PROPHET_SLEEVE_BASELINE_USD", "0")),
		ProphetSleeveMaxPositionFrac: parseFloat(getEnvOrDefault("PROPHET_SLEEVE_MAX_POSITION_FRAC", "0.25")),
		ProphetSleeveMaxPositions:    parseIntOrDefault("PROPHET_SLEEVE_MAX_POSITIONS", 5),
		ProphetSleeveLossBudgetFrac:  parseFloat(getEnvOrDefault("PROPHET_SLEEVE_LOSS_BUDGET_FRAC", "0.50")),
		ProphetSleeveDeadline:        os.Getenv("PROPHET_SLEEVE_DEADLINE"),
		ProphetSleeveDisarmDir:       os.Getenv("PROPHET_SLEEVE_DISARM_DIR"),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./config/ -run TestLoad_ProphetSleeveDefaults -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config/config.go config/config_test.go
git commit -m "feat(sleeve): add Prophet fun-sleeve config fields (default OFF)"
```

---

## Task 2: Guard skeleton + reader interface + disabled no-op + fail-closed config gates

**Files:**
- Create: `services/prophet_sleeve_guard.go`
- Create: `services/prophet_sleeve_guard_test.go`

- [ ] **Step 1: Write the failing tests**

Create `services/prophet_sleeve_guard_test.go`:

```go
package services

import (
	"context"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// stubReader is a configurable SleeveAccountReader for tests.
type stubReader struct {
	acct    *interfaces.Account
	acctErr error
	opt     []*interfaces.OptionsPosition
	optErr  error
	eq      []*interfaces.Position
	eqErr   error
}

func (s *stubReader) GetAccount(_ context.Context) (*interfaces.Account, error) {
	return s.acct, s.acctErr
}
func (s *stubReader) ListOptionsPositions(_ context.Context) ([]*interfaces.OptionsPosition, error) {
	return s.opt, s.optErr
}
func (s *stubReader) GetPositions(_ context.Context) ([]*interfaces.Position, error) {
	return s.eq, s.eqErr
}

// armedCfg returns a fully-armed config rooted at a temp dir, far-future deadline.
func armedCfg(t *testing.T) ProphetSleeveConfig {
	t.Helper()
	return ProphetSleeveConfig{
		Enabled:         true,
		BaselineUSD:     1000,
		MaxPositionFrac: 0.25,
		MaxPositions:    5,
		LossBudgetFrac:  0.50,
		Deadline:        "2099-12-31",
		DisarmDir:       t.TempDir(),
	}
}

// healthyReader: equity == baseline, no positions, no day trades.
func healthyReader(baseline float64) *stubReader {
	return &stubReader{
		acct: &interfaces.Account{PortfolioValue: baseline, DayTradeCount: 0},
	}
}

func TestEvaluateOpen_DisabledIsNoOp(t *testing.T) {
	cfg := armedCfg(t)
	cfg.Enabled = false
	cfg.BaselineUSD = 0 // would fail closed if enabled
	g := NewProphetSleeveGuard(cfg, &stubReader{})
	if err := g.EvaluateOpen(context.Background(), 10_000, time.Now()); err != nil {
		t.Fatalf("disabled guard should no-op, got %v", err)
	}
}

func TestEvaluateOpen_BaselineUnconfiguredFailsClosed(t *testing.T) {
	cfg := armedCfg(t)
	cfg.BaselineUSD = 0
	g := NewProphetSleeveGuard(cfg, healthyReader(0))
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Fatal("baseline<=0 while enabled must fail closed")
	}
}

func TestEvaluateOpen_DeadlineGates(t *testing.T) {
	base := healthyReader(1000)
	now := time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC)

	// missing deadline -> block
	cfg := armedCfg(t)
	cfg.Deadline = ""
	if err := NewProphetSleeveGuard(cfg, base).EvaluateOpen(context.Background(), 1, now); err == nil {
		t.Error("missing deadline must fail closed")
	}
	// invalid deadline -> block
	cfg = armedCfg(t)
	cfg.Deadline = "not-a-date"
	if err := NewProphetSleeveGuard(cfg, base).EvaluateOpen(context.Background(), 1, now); err == nil {
		t.Error("invalid deadline must fail closed")
	}
	// past deadline -> block
	cfg = armedCfg(t)
	cfg.Deadline = "2026-06-01"
	if err := NewProphetSleeveGuard(cfg, base).EvaluateOpen(context.Background(), 1, now); err == nil {
		t.Error("past deadline must block")
	}
	// future deadline + healthy -> allow
	cfg = armedCfg(t)
	cfg.Deadline = "2026-12-31"
	if err := NewProphetSleeveGuard(cfg, base).EvaluateOpen(context.Background(), 1, now); err != nil {
		t.Errorf("future deadline + healthy should allow, got %v", err)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestEvaluateOpen -v`
Expected: FAIL (compile error — `ProphetSleeveGuard` etc. undefined).

- [ ] **Step 3: Create the guard with skeleton + config gates**

Create `services/prophet_sleeve_guard.go`:

```go
package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"prophet-trader/interfaces"

	"github.com/sirupsen/logrus"
)

const (
	sleeveKillFileName   = "KILL_PROPHET_SLEEVE"
	sleeveLatchFileName  = "sleeve_disarm.json"
	sleevePDTEquityFloor = 25000.0
	sleevePDTDayTradeMax = 3
)

// SleeveAccountReader is the narrow broker-read surface the sleeve guard needs.
// interfaces.TradingService satisfies it.
type SleeveAccountReader interface {
	GetAccount(ctx context.Context) (*interfaces.Account, error)
	ListOptionsPositions(ctx context.Context) ([]*interfaces.OptionsPosition, error)
	GetPositions(ctx context.Context) ([]*interfaces.Position, error)
}

// ProphetSleeveConfig holds the live fun-sleeve safety-gate parameters.
type ProphetSleeveConfig struct {
	Enabled         bool
	BaselineUSD     float64
	MaxPositionFrac float64
	MaxPositions    int
	LossBudgetFrac  float64
	Deadline        string // YYYY-MM-DD; empty/invalid => fail closed when enabled
	DisarmDir       string
}

// ProphetSleeveGuard enforces the dedicated-account fun-sleeve caps and disarms.
// FAILS CLOSED: any uncertainty (missing config, unreadable account, present latch)
// blocks the open. Invoked ONLY on opening options buys, so closes/exits are never blocked.
type ProphetSleeveGuard struct {
	cfg    ProphetSleeveConfig
	reader SleeveAccountReader
	logger *logrus.Logger
}

// NewProphetSleeveGuard constructs the guard.
func NewProphetSleeveGuard(cfg ProphetSleeveConfig, reader SleeveAccountReader) *ProphetSleeveGuard {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &ProphetSleeveGuard{cfg: cfg, reader: reader, logger: logger}
}

func (g *ProphetSleeveGuard) killPath() string {
	return filepath.Join(g.cfg.DisarmDir, sleeveKillFileName)
}
func (g *ProphetSleeveGuard) latchPath() string {
	return filepath.Join(g.cfg.DisarmDir, sleeveLatchFileName)
}

func sleeveFileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (g *ProphetSleeveGuard) block(reason string) error {
	g.logger.WithFields(logrus.Fields{"prophet_sleeve_block": true, "reason": reason}).
		Warn("Prophet sleeve gate blocked an open")
	return fmt.Errorf("prophet sleeve: %s", reason)
}

// checkDeadline blocks when the deadline is empty, unparseable, or on/after the
// day AFTER the deadline date (the deadline is inclusive end-of-day).
func (g *ProphetSleeveGuard) checkDeadline(now time.Time) error {
	if g.cfg.Deadline == "" {
		return g.block("no off-ramp deadline configured (PROPHET_SLEEVE_DEADLINE)")
	}
	d, err := time.Parse("2006-01-02", g.cfg.Deadline)
	if err != nil {
		return g.block(fmt.Sprintf("invalid deadline %q (want YYYY-MM-DD)", g.cfg.Deadline))
	}
	if !now.Before(d.AddDate(0, 0, 1)) {
		return g.block(fmt.Sprintf("past off-ramp deadline %s", g.cfg.Deadline))
	}
	return nil
}

// EvaluateOpen returns an error (blocking the open) or nil (allow). No-op when disabled.
// newPremium is the dollar premium outlay of the proposed open (= max loss on a long option).
// Later tasks extend this with disarm-file, metrics, PDT, loss-budget and cap checks.
func (g *ProphetSleeveGuard) EvaluateOpen(ctx context.Context, newPremium float64, now time.Time) error {
	if !g.cfg.Enabled {
		return nil
	}
	if g.cfg.BaselineUSD <= 0 {
		return g.block("baseline not configured (PROPHET_SLEEVE_BASELINE_USD<=0)")
	}
	if err := g.checkDeadline(now); err != nil {
		return err
	}
	return nil
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run TestEvaluateOpen -v`
Expected: PASS (all three tests).

- [ ] **Step 5: Verify build**

Run: `go build ./...`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add services/prophet_sleeve_guard.go services/prophet_sleeve_guard_test.go
git commit -m "feat(sleeve): guard skeleton + reader interface + fail-closed config gates"
```

---

## Task 3: Disarm-file checks (kill + loss latch present → block)

**Files:**
- Modify: `services/prophet_sleeve_guard.go`
- Modify: `services/prophet_sleeve_guard_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `services/prophet_sleeve_guard_test.go`:

```go
import "os" // add to the existing import block if not present
import "path/filepath" // add if not present

func TestEvaluateOpen_KillFileBlocks(t *testing.T) {
	cfg := armedCfg(t)
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	// pre-flight: armed, allows.
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err != nil {
		t.Fatalf("precondition: should allow, got %v", err)
	}
	if err := os.WriteFile(filepath.Join(cfg.DisarmDir, "KILL_PROPHET_SLEEVE"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("kill file present must block")
	}
}

func TestEvaluateOpen_LossLatchFileBlocks(t *testing.T) {
	cfg := armedCfg(t)
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	if err := os.WriteFile(filepath.Join(cfg.DisarmDir, "sleeve_disarm.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("loss latch file present must block")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run "TestEvaluateOpen_KillFileBlocks|TestEvaluateOpen_LossLatchFileBlocks" -v`
Expected: FAIL (latch/kill not yet checked — opens allowed).

- [ ] **Step 3: Add the file checks to EvaluateOpen**

In `services/prophet_sleeve_guard.go`, in `EvaluateOpen`, after the `checkDeadline` block and before `return nil`:

```go
	if sleeveFileExists(g.killPath()) {
		return g.block("manual kill switch engaged")
	}
	if sleeveFileExists(g.latchPath()) {
		return g.block("loss-budget disarm latched")
	}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run "TestEvaluateOpen" -v`
Expected: PASS (all prior + two new).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_sleeve_guard.go services/prophet_sleeve_guard_test.go
git commit -m "feat(sleeve): block opens when kill-flag or loss-latch file present"
```

---

## Task 4: Broker metrics + realized-loss formula + fail-closed on read error

**Files:**
- Modify: `services/prophet_sleeve_guard.go`
- Modify: `services/prophet_sleeve_guard_test.go`

- [ ] **Step 1: Write the failing tests (the 4 spec §6.1 cases + read error)**

Add to `services/prophet_sleeve_guard_test.go`:

```go
import "errors" // add to import block if not present

func TestComputeMetrics_RealizedLossFormula(t *testing.T) {
	const B = 1000.0
	cases := []struct {
		name       string
		equity     float64
		opt        []*interfaces.OptionsPosition
		wantLoss   float64
		wantDeploy float64
		wantOpen   int
	}{
		{
			name:   "buy $200 no move -> 0 realized",
			equity: 1000,
			opt:    []*interfaces.OptionsPosition{{CostBasis: 200, UnrealizedPL: 0}},
			wantLoss: 0, wantDeploy: 200, wantOpen: 1,
		},
		{
			name:   "open position down $150 still open -> 0 realized",
			equity: 850,
			opt:    []*interfaces.OptionsPosition{{CostBasis: 200, UnrealizedPL: -150}},
			wantLoss: 0, wantDeploy: 200, wantOpen: 1,
		},
		{
			name:     "closed one for -$150, flat -> 150 realized",
			equity:   850,
			opt:      nil,
			wantLoss: 150, wantDeploy: 0, wantOpen: 0,
		},
		{
			name:   "closed -$150 + open winner +$60 -> 150 realized",
			equity: 910,
			opt:    []*interfaces.OptionsPosition{{CostBasis: 200, UnrealizedPL: 60}},
			wantLoss: 150, wantDeploy: 200, wantOpen: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := armedCfg(t)
			cfg.BaselineUSD = B
			r := &stubReader{acct: &interfaces.Account{PortfolioValue: tc.equity}, opt: tc.opt}
			g := NewProphetSleeveGuard(cfg, r)
			m, err := g.computeMetrics(context.Background())
			if err != nil {
				t.Fatalf("computeMetrics: %v", err)
			}
			if m.realizedLoss != tc.wantLoss {
				t.Errorf("realizedLoss = %v, want %v", m.realizedLoss, tc.wantLoss)
			}
			if m.deployed != tc.wantDeploy {
				t.Errorf("deployed = %v, want %v", m.deployed, tc.wantDeploy)
			}
			if m.openCount != tc.wantOpen {
				t.Errorf("openCount = %v, want %v", m.openCount, tc.wantOpen)
			}
		})
	}
}

func TestEvaluateOpen_AccountReadErrorFailsClosed(t *testing.T) {
	cfg := armedCfg(t)
	r := &stubReader{acctErr: errors.New("boom")}
	g := NewProphetSleeveGuard(cfg, r)
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("account read error must fail closed")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run "TestComputeMetrics_RealizedLossFormula|TestEvaluateOpen_AccountReadErrorFailsClosed" -v`
Expected: FAIL (compile error — `computeMetrics` / `m.realizedLoss` undefined).

- [ ] **Step 3: Add metrics computation + wire into EvaluateOpen**

In `services/prophet_sleeve_guard.go`, add:

```go
// sleeveMetrics is the broker-derived snapshot used by the caps + loss budget.
type sleeveMetrics struct {
	equity        float64
	deployed      float64 // Σ CostBasis of open option positions (premium at risk)
	unrealized    float64 // Σ UnrealizedPL across open positions (options + equity)
	realizedLoss  float64 // max(0, B - equity + unrealized); see spec §6.1
	openCount     int
	dayTradeCount int
}

func (g *ProphetSleeveGuard) computeMetrics(ctx context.Context) (sleeveMetrics, error) {
	var m sleeveMetrics
	acct, err := g.reader.GetAccount(ctx)
	if err != nil {
		return m, fmt.Errorf("get account: %w", err)
	}
	if acct == nil {
		return m, fmt.Errorf("nil account")
	}
	optPos, err := g.reader.ListOptionsPositions(ctx)
	if err != nil {
		return m, fmt.Errorf("list options positions: %w", err)
	}
	eqPos, err := g.reader.GetPositions(ctx)
	if err != nil {
		return m, fmt.Errorf("get positions: %w", err)
	}
	m.equity = acct.PortfolioValue
	m.dayTradeCount = acct.DayTradeCount
	for _, p := range optPos {
		m.deployed += p.CostBasis
		m.unrealized += p.UnrealizedPL
		m.openCount++
	}
	for _, p := range eqPos {
		m.unrealized += p.UnrealizedPL
	}
	if realizedPnl := m.equity - g.cfg.BaselineUSD - m.unrealized; realizedPnl < 0 {
		m.realizedLoss = -realizedPnl
	}
	return m, nil
}
```

Then in `EvaluateOpen`, after the latch-file checks and before `return nil`:

```go
	m, err := g.computeMetrics(ctx)
	if err != nil {
		return g.block(fmt.Sprintf("account/positions unavailable (fail closed): %v", err))
	}
	_ = m // caps added in later tasks
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run "TestComputeMetrics_RealizedLossFormula|TestEvaluateOpen" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_sleeve_guard.go services/prophet_sleeve_guard_test.go
git commit -m "feat(sleeve): broker metrics + realized-loss formula, fail-closed on read error"
```

---

## Task 5: PDT backstop

**Files:**
- Modify: `services/prophet_sleeve_guard.go`
- Modify: `services/prophet_sleeve_guard_test.go`

- [ ] **Step 1: Write the failing tests (boundaries)**

Add to `services/prophet_sleeve_guard_test.go`:

```go
func TestEvaluateOpen_PDTBackstop(t *testing.T) {
	mk := func(dtc int, equity float64) *ProphetSleeveGuard {
		cfg := armedCfg(t)
		r := &stubReader{acct: &interfaces.Account{PortfolioValue: equity, DayTradeCount: dtc}}
		return NewProphetSleeveGuard(cfg, r)
	}
	// 3 day trades AND equity < 25k -> block
	if err := mk(3, 24999).EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("dtc=3 & equity<25k must block (PDT)")
	}
	// 2 day trades, equity < 25k -> allow (under the count)
	if err := mk(2, 24999).EvaluateOpen(context.Background(), 1, time.Now()); err != nil {
		t.Errorf("dtc=2 should not trip PDT, got %v", err)
	}
	// 3 day trades, equity >= 25k -> allow (PDT only bites sub-25k)
	if err := mk(3, 25001).EvaluateOpen(context.Background(), 1, time.Now()); err != nil {
		t.Errorf("equity>=25k should not trip PDT, got %v", err)
	}
}
```

Note: at equity 25001 with baseline 1000, realized-loss = max(0, 1000-25001+0)=0 and deployed 0, so caps (added later) won't block — this test stays valid after later tasks.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestEvaluateOpen_PDTBackstop -v`
Expected: FAIL (dtc=3 & sub-25k currently allowed).

- [ ] **Step 3: Add the PDT check**

In `EvaluateOpen`, replace the `_ = m // caps added in later tasks` line with:

```go
	if m.dayTradeCount >= sleevePDTDayTradeMax && m.equity < sleevePDTEquityFloor {
		return g.block(fmt.Sprintf("PDT backstop: day_trade_count=%d, equity=$%.2f < $%.0f",
			m.dayTradeCount, m.equity, sleevePDTEquityFloor))
	}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run TestEvaluateOpen -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_sleeve_guard.go services/prophet_sleeve_guard_test.go
git commit -m "feat(sleeve): PDT backstop (block opens when dtc>=3 and equity<25k)"
```

---

## Task 6: Loss-budget trip → latch persists → survives restart → no auto-rearm

**Files:**
- Modify: `services/prophet_sleeve_guard.go`
- Modify: `services/prophet_sleeve_guard_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `services/prophet_sleeve_guard_test.go`:

```go
// lossReader: realized loss = max(0, B - equity + unrealized). For a flat account
// (no open positions, unrealized 0), realized loss = B - equity.
func lossReader(B, equity float64) *stubReader {
	return &stubReader{acct: &interfaces.Account{PortfolioValue: equity}}
}

func TestEvaluateOpen_LossBudgetTripsLatchAndPersists(t *testing.T) {
	cfg := armedCfg(t) // B=1000, LossBudgetFrac=0.50 -> budget $500
	// equity 500 => realized loss 500 == budget -> trips.
	g := NewProphetSleeveGuard(cfg, lossReader(1000, 500))

	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Fatal("realized loss at budget must block")
	}
	// latch file written
	if !sleeveFileExists(filepath.Join(cfg.DisarmDir, "sleeve_disarm.json")) {
		t.Fatal("loss latch file should have been written")
	}
	// "restart": a fresh guard over the SAME dir, now with a HEALTHY account,
	// must still block (permanent disarm; no auto-rearm).
	g2 := NewProphetSleeveGuard(cfg, healthyReader(1000))
	if err := g2.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("after latch, a healthy-account restart must still block (no auto-rearm)")
	}
}

func TestEvaluateOpen_BelowBudgetDoesNotLatch(t *testing.T) {
	cfg := armedCfg(t) // budget $500
	// equity 600 => realized loss 400 < 500 -> no latch, allowed (caps permitting).
	g := NewProphetSleeveGuard(cfg, lossReader(1000, 600))
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err != nil {
		t.Errorf("below budget should allow, got %v", err)
	}
	if sleeveFileExists(filepath.Join(cfg.DisarmDir, "sleeve_disarm.json")) {
		t.Error("below budget must NOT write a latch file")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run "TestEvaluateOpen_LossBudget|TestEvaluateOpen_BelowBudget" -v`
Expected: FAIL (no latch written / not blocked).

- [ ] **Step 3: Add the latch writer + the loss-budget check**

In `services/prophet_sleeve_guard.go`, add imports `encoding/json` and keep `time`. Add:

```go
// sleeveLatch is the JSON payload written to the kill/disarm files.
type sleeveLatch struct {
	Reason       string    `json:"reason"`
	EngagedAt    time.Time `json:"engaged_at"`
	RealizedLoss float64   `json:"realized_loss,omitempty"`
	Baseline     float64   `json:"baseline"`
}

// tripLossLatch writes the loss-budget disarm file once (idempotent). The file's
// presence is what permanently blocks future opens (read in EvaluateOpen), so the
// disarm survives restart and re-arms only by deliberate file deletion.
func (g *ProphetSleeveGuard) tripLossLatch(realizedLoss float64) {
	if sleeveFileExists(g.latchPath()) {
		return
	}
	if err := os.MkdirAll(g.cfg.DisarmDir, 0o755); err != nil {
		g.logger.WithError(err).Error("prophet sleeve: cannot create disarm dir for loss latch")
		return
	}
	b, _ := json.MarshalIndent(sleeveLatch{
		Reason:       "loss budget reached",
		EngagedAt:    time.Now().UTC(),
		RealizedLoss: realizedLoss,
		Baseline:     g.cfg.BaselineUSD,
	}, "", "  ")
	if err := os.WriteFile(g.latchPath(), b, 0o644); err != nil {
		g.logger.WithError(err).Error("prophet sleeve: failed to write loss-budget latch")
	}
}
```

In `EvaluateOpen`, after the PDT check and before `return nil`:

```go
	if m.realizedLoss >= g.cfg.LossBudgetFrac*g.cfg.BaselineUSD {
		g.tripLossLatch(m.realizedLoss)
		return g.block(fmt.Sprintf("loss budget reached: realized loss $%.2f >= $%.2f",
			m.realizedLoss, g.cfg.LossBudgetFrac*g.cfg.BaselineUSD))
	}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run "TestEvaluateOpen" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_sleeve_guard.go services/prophet_sleeve_guard_test.go
git commit -m "feat(sleeve): loss-budget permanent disarm latch (persists, no auto-rearm)"
```

---

## Task 7: The three caps (per-position, concurrency, exposure)

**Files:**
- Modify: `services/prophet_sleeve_guard.go`
- Modify: `services/prophet_sleeve_guard_test.go`

- [ ] **Step 1: Write the failing tests (boundaries)**

Add to `services/prophet_sleeve_guard_test.go`:

```go
func TestEvaluateOpen_PerPositionCap(t *testing.T) {
	cfg := armedCfg(t) // B=1000, MaxPositionFrac=0.25 -> per-position $250
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	// just over
	if err := g.EvaluateOpen(context.Background(), 250.01, time.Now()); err == nil {
		t.Error("premium 250.01 > 250 cap must block")
	}
	// at the cap (not over)
	if err := g.EvaluateOpen(context.Background(), 250.0, time.Now()); err != nil {
		t.Errorf("premium 250.0 == cap should allow, got %v", err)
	}
}

func TestEvaluateOpen_ConcurrencyCap(t *testing.T) {
	cfg := armedCfg(t) // MaxPositions=5
	// 5 tiny open positions (deployed small so exposure not the binding cap)
	opt := make([]*interfaces.OptionsPosition, 5)
	for i := range opt {
		opt[i] = &interfaces.OptionsPosition{CostBasis: 1}
	}
	r := &stubReader{acct: &interfaces.Account{PortfolioValue: 1000}, opt: opt}
	g := NewProphetSleeveGuard(cfg, r)
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("openCount 5 >= MaxPositions 5 must block")
	}
}

func TestEvaluateOpen_ExposureCap(t *testing.T) {
	cfg := armedCfg(t) // B=1000; healthy -> Available=1000
	// one open at CostBasis 900, new 150 -> 1050 > 1000 -> block
	r := &stubReader{acct: &interfaces.Account{PortfolioValue: 1000},
		opt: []*interfaces.OptionsPosition{{CostBasis: 900}}}
	g := NewProphetSleeveGuard(cfg, r)
	if err := g.EvaluateOpen(context.Background(), 150, time.Now()); err == nil {
		t.Error("deployed 900 + new 150 > available 1000 must block")
	}
	// new 100 -> exactly 1000, not over -> allow
	if err := g.EvaluateOpen(context.Background(), 100, time.Now()); err != nil {
		t.Errorf("deployed 900 + new 100 == available 1000 should allow, got %v", err)
	}
}

func TestEvaluateOpen_ExposureRatchetsWithRealizedLoss(t *testing.T) {
	cfg := armedCfg(t) // B=1000, per-position cap $250, budget $500
	// realized loss 300 (equity 700, unrealized 0) -> Available 700.
	// one open position deployed 500; new 250 (== per-position cap, allowed THERE)
	// -> 500+250 = 750 > 700 Available -> EXPOSURE block (ratcheted), proving the
	// exposure cap subtracts realized loss rather than using the full baseline.
	// newPremium is kept at the per-position cap so the block can only come from
	// the ratcheted exposure check, not the per-position check.
	r := &stubReader{
		acct: &interfaces.Account{PortfolioValue: 700},
		opt:  []*interfaces.OptionsPosition{{CostBasis: 500, UnrealizedPL: 0}},
	}
	g := NewProphetSleeveGuard(cfg, r)
	if err := g.EvaluateOpen(context.Background(), 250, time.Now()); err == nil {
		t.Error("exposure must use ratcheted Available (B - realized_loss)")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestEvaluateOpen -v`
Expected: FAIL (caps not enforced yet).

- [ ] **Step 3: Add the three caps**

In `EvaluateOpen`, after the loss-budget block and before `return nil`:

```go
	if newPremium > g.cfg.MaxPositionFrac*g.cfg.BaselineUSD {
		return g.block(fmt.Sprintf("per-position cap: $%.2f > $%.2f (%.0f%% of baseline)",
			newPremium, g.cfg.MaxPositionFrac*g.cfg.BaselineUSD, g.cfg.MaxPositionFrac*100))
	}
	if m.openCount >= g.cfg.MaxPositions {
		return g.block(fmt.Sprintf("concurrency cap: %d open >= %d max", m.openCount, g.cfg.MaxPositions))
	}
	available := g.cfg.BaselineUSD - m.realizedLoss
	if m.deployed+newPremium > available {
		return g.block(fmt.Sprintf("exposure cap: deployed $%.2f + new $%.2f > available $%.2f",
			m.deployed, newPremium, available))
	}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run TestEvaluateOpen -v`
Expected: PASS (all cap + prior tests).

- [ ] **Step 5: Full services suite + build**

Run: `go test ./services/` then `go build ./...`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add services/prophet_sleeve_guard.go services/prophet_sleeve_guard_test.go
git commit -m "feat(sleeve): per-position, concurrency, and ratcheted exposure caps"
```

---

## Task 8: Status snapshot + EngageManualKill

**Files:**
- Modify: `services/prophet_sleeve_guard.go`
- Modify: `services/prophet_sleeve_guard_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `services/prophet_sleeve_guard_test.go`:

```go
func TestStatus_ArmedHealthy(t *testing.T) {
	cfg := armedCfg(t)
	now := time.Date(2026, 6, 3, 12, 0, 0, 0, time.UTC)
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	s := g.Status(context.Background(), now)
	if !s.Armed {
		t.Errorf("healthy guard should be armed; reasons=%v", s.DisarmReasons)
	}
	if s.Available != 1000 {
		t.Errorf("Available = %v, want 1000", s.Available)
	}
	if s.LossBudgetUSD != 500 {
		t.Errorf("LossBudgetUSD = %v, want 500", s.LossBudgetUSD)
	}
}

func TestStatus_DisarmedByKill(t *testing.T) {
	cfg := armedCfg(t)
	g := NewProphetSleeveGuard(cfg, healthyReader(1000))
	if err := g.EngageManualKill("operator test"); err != nil {
		t.Fatalf("EngageManualKill: %v", err)
	}
	s := g.Status(context.Background(), time.Now())
	if s.Armed {
		t.Error("kill engaged -> should be disarmed")
	}
	// And EvaluateOpen now blocks.
	if err := g.EvaluateOpen(context.Background(), 1, time.Now()); err == nil {
		t.Error("after EngageManualKill, opens must block")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestStatus -v`
Expected: FAIL (compile error — `Status`/`EngageManualKill` undefined).

- [ ] **Step 3: Add Status + EngageManualKill**

In `services/prophet_sleeve_guard.go`, add:

```go
// SleeveStatus is the read-only teaching/observability snapshot.
type SleeveStatus struct {
	Enabled        bool     `json:"enabled"`
	Armed          bool     `json:"armed"`
	DisarmReasons  []string `json:"disarm_reasons"`
	BaselineUSD    float64  `json:"baseline_usd"`
	AvailableUSD   float64  `json:"available_usd"`
	DeployedUSD    float64  `json:"deployed_usd"`
	RealizedLoss   float64  `json:"realized_loss_usd"`
	LossBudgetUSD  float64  `json:"loss_budget_usd"`
	OpenCount      int      `json:"open_count"`
	MaxPositions   int      `json:"max_positions"`
	Deadline       string   `json:"deadline"`
	DaysToDeadline int      `json:"days_to_deadline"`
}

// Status returns a read-only snapshot. Best-effort: a metrics-read failure is
// reported as a disarm reason rather than an error (this never places orders).
func (g *ProphetSleeveGuard) Status(ctx context.Context, now time.Time) SleeveStatus {
	s := SleeveStatus{
		Enabled:       g.cfg.Enabled,
		BaselineUSD:   g.cfg.BaselineUSD,
		LossBudgetUSD: g.cfg.LossBudgetFrac * g.cfg.BaselineUSD,
		MaxPositions:  g.cfg.MaxPositions,
		Deadline:      g.cfg.Deadline,
	}
	if !g.cfg.Enabled {
		return s
	}
	var reasons []string
	if g.cfg.BaselineUSD <= 0 {
		reasons = append(reasons, "baseline not configured")
	}
	if g.checkDeadline(now) != nil {
		reasons = append(reasons, "deadline")
	}
	if d, err := time.Parse("2006-01-02", g.cfg.Deadline); err == nil {
		s.DaysToDeadline = int(d.AddDate(0, 0, 1).Sub(now).Hours() / 24)
	}
	if sleeveFileExists(g.killPath()) {
		reasons = append(reasons, "manual kill engaged")
	}
	if sleeveFileExists(g.latchPath()) {
		reasons = append(reasons, "loss-budget latched")
	}
	if m, err := g.computeMetrics(ctx); err == nil {
		s.DeployedUSD = m.deployed
		s.RealizedLoss = m.realizedLoss
		s.OpenCount = m.openCount
		s.AvailableUSD = g.cfg.BaselineUSD - m.realizedLoss
		if m.realizedLoss >= g.cfg.LossBudgetFrac*g.cfg.BaselineUSD {
			reasons = append(reasons, "loss budget reached")
		}
	} else {
		reasons = append(reasons, "metrics unavailable")
	}
	s.DisarmReasons = reasons
	s.Armed = len(reasons) == 0
	return s
}

// EngageManualKill writes the kill-flag file (idempotent). Called by the
// POST /sleeve/kill handler and equivalent to the operator touching the file.
// There is intentionally NO programmatic re-arm — re-arming is file deletion only.
func (g *ProphetSleeveGuard) EngageManualKill(reason string) error {
	if reason == "" {
		reason = "manual kill"
	}
	if err := os.MkdirAll(g.cfg.DisarmDir, 0o755); err != nil {
		return fmt.Errorf("create disarm dir: %w", err)
	}
	b, _ := json.MarshalIndent(sleeveLatch{
		Reason:    reason,
		EngagedAt: time.Now().UTC(),
		Baseline:  g.cfg.BaselineUSD,
	}, "", "  ")
	return os.WriteFile(g.killPath(), b, 0o644)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `go test ./services/ -run "TestStatus|TestEvaluateOpen|TestComputeMetrics" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/prophet_sleeve_guard.go services/prophet_sleeve_guard_test.go
git commit -m "feat(sleeve): Status snapshot + EngageManualKill (no programmatic re-arm)"
```

---

## Task 9: Wire into the order controller (opens-only) + controller tests

**Files:**
- Modify: `controllers/order_controller.go`
- Modify: `controllers/order_controller_test.go`

The existing harness uses `recordingTradingService` (which already implements `GetAccount`/`ListOptionsPositions`/`GetPositions`, so it satisfies `services.SleeveAccountReader`), `noopStorage`, and the `gin.CreateTestContext` + `oc.PlaceOptionsOrder(c)` pattern (see `TestPlaceOptionsOrder_CloseNotBlocked`).

- [ ] **Step 1: Write the failing tests**

Add to `controllers/order_controller_test.go`:

```go
// newBlockingSleeveGuard returns an enabled sleeve guard pre-armed with a manual
// kill, so EvaluateOpen blocks every open and never reaches the broker reads
// (the kill-file check short-circuits before computeMetrics).
func newBlockingSleeveGuard(t *testing.T, reader services.SleeveAccountReader) *services.ProphetSleeveGuard {
	t.Helper()
	cfg := services.ProphetSleeveConfig{
		Enabled: true, BaselineUSD: 1000, MaxPositionFrac: 0.25,
		MaxPositions: 5, LossBudgetFrac: 0.50, Deadline: "2099-12-31", DisarmDir: t.TempDir(),
	}
	g := services.NewProphetSleeveGuard(cfg, reader)
	if err := g.EngageManualKill("test"); err != nil {
		t.Fatalf("EngageManualKill: %v", err)
	}
	return g
}

func TestPlaceOptionsOrder_SleeveBlocksOpen(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := &recordingTradingService{portfolio: 100000, cash: 100000,
		optionsQuote: &interfaces.OptionsQuote{BidPrice: 1.0, AskPrice: 1.02, Timestamp: time.Now()}}
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetSleeveGuard(newBlockingSleeveGuard(t, rec))
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	body := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":1,"strategy":"v2-options"}`
	c.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")
	oc.PlaceOptionsOrder(c)
	if rec.optionsOrdersPlaced != 0 {
		t.Fatalf("sleeve guard must block the open before placement, placed=%d", rec.optionsOrdersPlaced)
	}
}

func TestPlaceOptionsOrder_SleeveNeverBlocksClose(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := &recordingTradingService{portfolio: 100000, cash: 95000}
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetSleeveGuard(newBlockingSleeveGuard(t, rec)) // would block ANY open
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	body := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":30,"side":"sell","position_intent":"sell_to_close","type":"market","strategy":"v2-options"}`
	c.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")
	oc.PlaceOptionsOrder(c)
	if rec.optionsOrdersPlaced != 1 {
		t.Fatalf("a close must never be consulted by the sleeve guard, placed=%d", rec.optionsOrdersPlaced)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./controllers/ -run TestPlaceOptionsOrder_Sleeve -v`
Expected: FAIL (compile error — `SetSleeveGuard` undefined).

- [ ] **Step 3: Add the field + setter**

In `controllers/order_controller.go`, add a field to the `OrderController` struct:

```go
	sleeveGuard *services.ProphetSleeveGuard
```

Add the setter immediately after `SetGuard`:

```go
// SetSleeveGuard attaches the Prophet fun-sleeve safety gate (live real-money
// caps + disarm). Nil = not configured (no-op). See the 2026-06-03 spec.
func (oc *OrderController) SetSleeveGuard(g *services.ProphetSleeveGuard) {
	oc.sleeveGuard = g
}
```

- [ ] **Step 4: Restructure `PlaceOptionsOrder` so the sleeve gate runs independently**

The current code fetches the quote + computes `notional` *inside* `if oc.guard != nil`. The sleeve gate must run even when the TradeGuard is absent, and must not double-fetch the quote. Hoist the quote + notional out, then add the sleeve block after the guard block. Replace the existing block (from `agent := services.AgentForStrategy(req.Strategy)` through the closing `}` of `if oc.guard != nil {`) with:

```go
	agent := services.AgentForStrategy(req.Strategy)
	opening := isOpeningOption(req.PositionIntent, req.Side)

	// For opening buys, fetch the options quote once and compute the premium
	// notional up front; shared by the trade guard's dollar caps and the Prophet
	// sleeve gate (avoids a double quote fetch; preserves the single-fetch invariant).
	var openQuote *interfaces.OptionsQuote
	var openNotional float64
	if opening && req.Side == "buy" && oc.tradingService != nil {
		if q, err := oc.tradingService.GetOptionsQuote(ctx, order.Symbol); err == nil {
			openQuote = q
		}
		openNotional = optionsNotional(order, openQuote)
	}

	if oc.guard != nil {
		if opening && req.Side == "buy" {
			// Universe allowlist + spread/staleness gate (Prophet-scoped, flag-gated).
			if err := oc.guard.CheckOptionsOpen(agent, order.Underlying, order.Symbol, openQuote, time.Now()); err != nil {
				oc.logger.WithError(err).Warn("Options open blocked by trade guard (universe/spread)")
				c.JSON(422, gin.H{"error": err.Error()})
				return
			}
			// Existing dollar caps + daily-loss breaker.
			if err := oc.guard.CheckBuy(ctx, agent, order.Symbol, openNotional); err != nil {
				oc.logger.WithError(err).Warn("Options buy blocked by trade guard")
				c.JSON(422, gin.H{"error": err.Error()})
				return
			}
		} else if !opening {
			if err := oc.guard.CheckSell(ctx, agent, order.Symbol); err != nil {
				oc.logger.WithError(err).Warn("Options close blocked by trade guard")
				c.JSON(422, gin.H{"error": err.Error()})
				return
			}
		}
		// sell_to_open (short premium) is not size-capped in Phase 1 (out of scope);
		// ownership is still recorded after a successful placement below.
	}

	// Prophet fun-sleeve real-money gate (live): exposure/per-position/concurrency
	// caps + loss-budget disarm + manual kill + deadline + PDT. INDEPENDENT of the
	// trade guard above (must run even when oc.guard is nil). Opens-only by this
	// condition, so closes/exits are never consulted.
	if oc.sleeveGuard != nil && opening && req.Side == "buy" {
		if err := oc.sleeveGuard.EvaluateOpen(ctx, openNotional, time.Now()); err != nil {
			oc.logger.WithError(err).Warn("Options open blocked by Prophet sleeve guard")
			c.JSON(422, gin.H{"error": err.Error()})
			return
		}
	}
```

This preserves the existing single-quote-fetch invariant (`TestPlaceOptionsOrder_UniverseAndSpreadGates` asserts exactly one `GetOptionsQuote` call) because the hoisted block is the only fetch and the guard reuses `openQuote`.

- [ ] **Step 5: Run to verify it passes**

Run: `go test ./controllers/ -run TestPlaceOptionsOrder -v`
Expected: PASS (new + all existing options-order tests, including the close-not-blocked and single-quote-fetch invariants).

- [ ] **Step 6: Commit**

```bash
git add controllers/order_controller.go controllers/order_controller_test.go
git commit -m "feat(sleeve): wire sleeve guard into PlaceOptionsOrder (opens-only)"
```

---

## Task 10: Sleeve HTTP controller + main.go wiring + routes

**Files:**
- Create: `controllers/sleeve_controller.go`
- Modify: `cmd/bot/main.go`

- [ ] **Step 1: Create the controller (mirrors guard_controller.go)**

Create `controllers/sleeve_controller.go`:

```go
package controllers

import (
	"context"
	"net/http"
	"prophet-trader/services"
	"time"

	"github.com/gin-gonic/gin"
)

// SleeveController exposes the Prophet fun-sleeve guard state + manual kill.
type SleeveController struct {
	guard *services.ProphetSleeveGuard
}

// NewSleeveController creates the controller. guard may be nil (endpoints 503).
func NewSleeveController(guard *services.ProphetSleeveGuard) *SleeveController {
	return &SleeveController{guard: guard}
}

// HandleGetStatus returns the read-only sleeve snapshot. GET /api/v1/sleeve/status
func (sc *SleeveController) HandleGetStatus(c *gin.Context) {
	if sc.guard == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sleeve guard not configured"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	c.JSON(http.StatusOK, sc.guard.Status(ctx, time.Now()))
}

// HandleKill engages the independent manual kill switch (writes the kill file).
// POST /api/v1/sleeve/kill   body: {"reason":"..."} (optional)
// Re-arming is intentionally NOT exposed over HTTP — delete the file deliberately.
func (sc *SleeveController) HandleKill(c *gin.Context) {
	if sc.guard == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sleeve guard not configured"})
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body) // body optional
	if err := sc.guard.EngageManualKill(body.Reason); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"killed": true, "reason": body.Reason})
}
```

- [ ] **Step 2: Construct the guard + controller in main.go**

In `cmd/bot/main.go`, immediately after the `orderController.SetGuard(tradeGuard)` line (~227), add:

```go
	// Prophet fun-sleeve real-money safety gate (live). Default OFF; flag-gated.
	sleeveDisarmDir := cfg.ProphetSleeveDisarmDir
	if sleeveDisarmDir == "" {
		sleeveDisarmDir = filepath.Dir(cfg.DatabasePath)
	}
	sleeveGuard := services.NewProphetSleeveGuard(
		services.ProphetSleeveConfig{
			Enabled:         cfg.EnableProphetSleeve,
			BaselineUSD:     cfg.ProphetSleeveBaselineUSD,
			MaxPositionFrac: cfg.ProphetSleeveMaxPositionFrac,
			MaxPositions:    cfg.ProphetSleeveMaxPositions,
			LossBudgetFrac:  cfg.ProphetSleeveLossBudgetFrac,
			Deadline:        cfg.ProphetSleeveDeadline,
			DisarmDir:       sleeveDisarmDir,
		},
		tradingService,
	)
	orderController.SetSleeveGuard(sleeveGuard)
	sleeveController := controllers.NewSleeveController(sleeveGuard)
```

Ensure `path/filepath` is imported in `cmd/bot/main.go` (it likely already is; if not, add it).

- [ ] **Step 3: Thread the controller into the route setup + register routes**

The route-setup function takes the controllers as params (see `guardController *controllers.GuardController` at ~line 559 and its call site at ~line 491). Add `sleeveController` the same way:
- At the call site (~line 491, where `guardController,` is passed), add `sleeveController,` on the next line.
- In the function signature (~line 559, after `guardController *controllers.GuardController,`), add `sleeveController *controllers.SleeveController,`.

Then, next to the guard route (`api.GET("/guard/status", guardController.HandleGetStatus)` ~line 666), add:

```go
		// Prophet fun-sleeve gate: status + independent manual kill switch.
		api.GET("/sleeve/status", sleeveController.HandleGetStatus)
		api.POST("/sleeve/kill", sleeveController.HandleKill)
```

- [ ] **Step 4: Build + vet**

Run: `go build ./...` then `go vet ./...`
Expected: both exit 0.

- [ ] **Step 5: Smoke-run the route wiring (optional but recommended)**

Run: `go test ./controllers/ ./services/ ./config/`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add controllers/sleeve_controller.go cmd/bot/main.go
git commit -m "feat(sleeve): HTTP status + manual-kill endpoints, wire guard in main"
```

---

## Task 11: Rules note (V2)

**Files:**
- Modify: `TRADING_RULES_V2.md`

- [ ] **Step 1: Add a short subsection**

Append to `TRADING_RULES_V2.md` (find the risk/guards section; if none, add at the end under a new `## Live fun-sleeve safety gate` heading):

```markdown
## Live fun-sleeve safety gate (real money only)

When the live fun sleeve is active (`ENABLE_PROPHET_SLEEVE=true`, dedicated live
account), opening an options position may be rejected with HTTP 422 and a
`prophet sleeve: ...` reason. This is a **backend safety gate, not a market
signal** — it means one of: exposure cap reached, per-position size cap,
concurrency cap, the lifetime loss-budget permanent disarm, the manual kill
switch, a passed off-ramp deadline, a PDT backstop, or a fail-closed
misconfiguration. **Do not retry the same open in a loop.** Closes/exits are
never blocked by this gate. On paper (default) the gate is OFF and absent.
```

- [ ] **Step 2: Commit**

```bash
git add TRADING_RULES_V2.md
git commit -m "docs(sleeve): note the live fun-sleeve 422 gate in V2 rules"
```

---

## Task 12: Dashboard teaching card (manual eyeball)

**Files:**
- Modify: `agent/public/index.html`

This is the teaching surface (no jsdom in repo → no automated test; visual eyeball only).

- [ ] **Step 1: Add the fetch + render function**

In `agent/public/index.html`, locate `loadReconciliationBanner` (the established sibling pattern). Add a parallel function:

```javascript
async function loadSleeveStatus() {
  try {
    const res = await fetch('/api/v1/sleeve/status');
    if (!res.ok) { document.getElementById('sleeve-card').style.display = 'none'; return; }
    const s = await res.json();
    if (!s.enabled) { document.getElementById('sleeve-card').style.display = 'none'; return; }
    const el = document.getElementById('sleeve-card');
    el.style.display = 'block';
    const state = s.armed ? 'ARMED' : ('DISARMED — ' + (s.disarm_reasons || []).join(', '));
    el.innerHTML =
      '<div class="card-title">Prophet Fun Sleeve — ' + state + '</div>' +
      '<div>Baseline $' + (s.baseline_usd||0).toFixed(0) +
      ' · Available $' + (s.available_usd||0).toFixed(0) +
      ' · Deployed $' + (s.deployed_usd||0).toFixed(0) +
      ' · Realized loss $' + (s.realized_loss_usd||0).toFixed(0) +
      ' / budget $' + (s.loss_budget_usd||0).toFixed(0) +
      ' · Open ' + (s.open_count||0) + '/' + (s.max_positions||0) +
      ' · Deadline ' + (s.deadline||'—') + ' (' + (s.days_to_deadline||0) + 'd)</div>';
  } catch (e) {
    document.getElementById('sleeve-card').style.display = 'none';
  }
}
```

- [ ] **Step 2: Add the card container + call the loader**

Add a container near the reconciliation banner element:

```html
<div id="sleeve-card" class="card" style="display:none"></div>
```

And call `loadSleeveStatus()` wherever `loadReconciliationBanner()` is invoked (initial load + any refresh interval).

- [ ] **Step 3: Manual eyeball**

Rebuild the Go bot with `ENABLE_PROPHET_SLEEVE=true PROPHET_SLEEVE_BASELINE_USD=1000 PROPHET_SLEEVE_DEADLINE=2026-12-31` against a paper account, open the dashboard, confirm the card shows ARMED with sane numbers, `POST /api/v1/sleeve/kill`, refresh, confirm it flips to DISARMED. Delete the kill file, refresh, confirm ARMED again.

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(sleeve): dashboard teaching card for sleeve status"
```

---

## Final integration

- [ ] **Squash** the per-task commits into one squashed commit for this backlog item (comprehensive body: architecture, the four caps + formulas, the disarm state machine, fail-closed policy, PDT backstop, config/flags, token/cost note = zero new LLM beats, cold-start safety, default OFF). Fold in the spec + this plan. Co-author tag.
- [ ] **Confirm with the operator before committing the squash / pushing / merging.** Get the squash onto **local `main`** (the deploy artifact) once approved.
- [ ] **Deploy:** rebuild Go bot + restart Node. Verify `go build ./...` + full `go test ./services/ ./controllers/ ./config/` green on the merged main first.

## Self-review checklist (run before handoff)

- Spec §3 account model → Tasks 1/4/10 (constant baseline `B`, dedicated-account totals). ✓
- Spec §6 four caps → Tasks 6 (loss budget), 7 (per-position/concurrency/exposure). ✓
- Spec §6.1 formula → Task 4 (4-case table). ✓
- Spec §7 disarm state machine → Tasks 3 (file checks), 6 (auto latch), 8 (manual kill), 2 (deadline). ✓
- Spec §8 PDT → Task 5. ✓
- Spec §9 fail-closed → Tasks 2 (baseline/deadline), 4 (read error). ✓
- Spec §10 config → Task 1. ✓
- Spec §11 status surface → Tasks 8 (Status), 10 (endpoint), 12 (card). ✓
- Spec §12 testing → every Go task is TDD; closes-never-blocked = Task 9. ✓
- **Periodic auto-latch eval (spec §7 "dual evaluation")** is deferred: enforcement is fully covered by the pre-trade check (every open reads the latch). The periodic monitor-tick is an observability nicety; if wanted, add a follow-up task calling `EvaluateOpen`-equivalent latch evaluation from the once/day `MonitorPositions` post-close hook. Not required for correctness.
