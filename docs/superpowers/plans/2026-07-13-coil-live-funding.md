# Coil → Live Funding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the code prerequisites that let Coil (`mean-rev`) trade a dedicated, real-money Alpaca account safely — a fail-closed paper/live mode check, a code-enforced −15% high-water halt, and a live rules variant — so the operator can fund $5k without any silent, unguarded path to real money.

**Architecture:** Three defensive layers, each following an existing in-repo pattern rather than inventing one.
1. **Mode integrity (Go + Node):** `ALPACA_PAPER` becomes load-bearing. The Alpaca client refuses to start when the `paper` boolean and `baseURL` disagree; `config-store` refuses to persist an account where they disagree.
2. **The halt (Go):** a new `CoilLiveHaltGuard` modelled directly on `services/prophet_sleeve_guard.go` (fail-closed, latch-file disarm, manual re-arm by file deletion). It is consulted inside `TradeGuard.CheckBuy`, which is the single chokepoint every entry passes through — both `OrderController.Buy` (`controllers/order_controller.go:129`) and `PositionManager.PlaceManagedPosition` (`services/position_manager.go:253`, Coil's actual entry path). `CheckBuy` is buys-only, so exits are structurally unblockable.
3. **Strategy-id registration (Go + Node):** the new `mean-rev-rsi2-live` id is registered in every id-keyed lookup, guarded by a conformance test.

**Tech Stack:** Go 1.26 (`go test ./...`), Node ESM with `node:test` (`npm test` → `node --test agent/**/*.test.mjs`), SQLite (per-sandbox DB), Alpaca API.

## Global Constraints

- **The order of tasks is a safety property, not a preference.** Tasks 1–4 are the spec's blocking prerequisites. **No real money is funded until Tasks 1–4 are merged and verified.** Task 6 (funding) is an operator action, not a code change.
- **Fail closed on money paths.** Any uncertainty (missing config, unreadable account, present latch, ambiguous mode) blocks a new entry. This inverts the repo's usual "unconfigured gate fails open" policy, matching the precedent set by `ProphetSleeveGuard` ("a money gate's safe state is block", `config/config.go:103-112`).
- **Never block an exit.** Every guard added here is invoked only on opening buys.
- **Live rules params (spec §3):** per-position **12%**, max concurrent **7**, total deploy ceiling **85%**, `MEANREV_BEAR_MODE=halt`, daily circuit breaker −2%, hard stop −7%, time stop 5 days, entry RSI(2)<5 AND close>200-SMA AND no earnings ≤5d.
- **Halt params (spec §4):** −15% from high-water portfolio value; blocks new entries only; requires manual re-arm.
- **Do not modify `TRADING_RULES_MEANREV.md`** (paper rules). The live variant is a new file.
- **Do not commit the working tree's unrelated Sonnet-5 model bump** (`README.md`, `agent/harness.js`, `agent/server.js`, `mcp-server.js`, `agent/analysis-scheduler.js`, `agent/public/index.html`, and the model-list edits in `agent/config-store.js`). Stage only the files each task names.
- **Secrets never enter git.** Live Alpaca keys go in `data/accounts-secrets.json` (gitignored) via the dashboard, never in a commit.

---

## Critical finding — read before starting

The spec's §3 introduces a new strategy id, `mean-rev-rsi2-live`. **A strategy id is a lookup key in five separate registries, and three of them fail OPEN.** Adopting the new id without registering it would silently produce an *unguarded* real-money Coil:

| Registry | File | Failure mode with an unregistered id |
|---|---|---|
| Guard agent attribution | `services/trade_guard.go:44` `AgentForStrategy` | Falls through to `AgentMain` — Coil loses its per-agent caps and cross-agent symbol-overlap protection, and is mistaken for Prophet |
| MCP tool allowlist | `agent/tool-allowlists.js:240` `resolveAllowedTools` | Returns `[]`, which means **"no filter" = every tool allowed** — live Coil would get the full toolset, including options tools |
| Beat preflight | `agent/preflight.js:441` `PREFLIGHT_REGISTRY` | No preflight registered → beat always runs (token waste, not unsafe) |
| Preflight positions query | `agent/preflight.js:367` — hardcodes `?strategy=mean-rev-rsi2` | **Dangerous:** in the live DB this returns `[]`, so on a day with no new candidates the beat is *skipped while live positions are open*, stranding them from LLM exit management (only the broker −7% stop remains) |
| Candidate-cache warmer | `agent/candidate-warmer-flags.js:8` | `ENABLE_MEANREV_WARMER=false` → Coil's candidate cache never warms |
| Reasoning digest | `agent/reasoning-digest.js:76` `STRATEGY_KIND` | Digest mislabels Coil |

Task 4 registers the id in all of these and adds a conformance test so a sixth registry cannot be missed later.

**Note on `MEANREV_BEAR_MODE=halt`:** it is *reported to the LLM* via the candidates endpoint (`cmd/bot/main.go:341`) and enforced by rules-prose, not by Go. It is a real tightening but it is **not** a code-enforced rail. The −15% halt (Task 3) is the only code-enforced backstop on real-money loss. Do not let the presence of `halt` mode create false comfort.

---

## Task 1: Make the paper/live flag load-bearing in Go

Closes spec §2 on the Go side. Today `isPaper` is accepted by `NewAlpacaTradingService` and **never stored or used** (`services/alpaca_trading.go:91-124`) — the client is built from `baseURL` alone. A misconfiguration trades real money while every log line says "paper".

**Files:**
- Modify: `services/alpaca_trading.go:91-124` (store + validate `isPaper`)
- Modify: `cmd/bot/main.go:60-71` (fatal, not warn, on mode mismatch; log resolved mode)
- Test: `services/alpaca_trading_paper_mode_test.go` (create)

**Interfaces:**
- Produces: `func IsPaperBaseURL(baseURL string) (isPaper bool, known bool)` in `services` — `known=false` for an unrecognized host. Used by Task 3's status endpoint and by `main.go`.
- Produces: `NewAlpacaTradingService` now returns a non-nil error when `isPaper` contradicts `baseURL`, or when `baseURL` is unrecognized.
- Produces: `(*AlpacaTradingService).IsPaper() bool`.

- [ ] **Step 1: Write the failing test**

Create `services/alpaca_trading_paper_mode_test.go`:

```go
package services

import "testing"

func TestIsPaperBaseURL(t *testing.T) {
	cases := []struct {
		url         string
		wantPaper   bool
		wantKnown   bool
	}{
		{"https://paper-api.alpaca.markets", true, true},
		{"https://paper-api.alpaca.markets/", true, true},
		{"https://api.alpaca.markets", false, true},
		{"https://api.alpaca.markets/v2", false, true},
		{"HTTPS://API.ALPACA.MARKETS", false, true},
		{"", false, false},
		{"https://example.com", false, false},
	}
	for _, c := range cases {
		gotPaper, gotKnown := IsPaperBaseURL(c.url)
		if gotPaper != c.wantPaper || gotKnown != c.wantKnown {
			t.Errorf("IsPaperBaseURL(%q) = (%v,%v), want (%v,%v)",
				c.url, gotPaper, gotKnown, c.wantPaper, c.wantKnown)
		}
	}
}

// A live URL flagged as paper is the false-comfort failure the spec names:
// real money traded while every log line reports "paper". Must refuse to start.
func TestNewAlpacaTradingService_RejectsModeMismatch(t *testing.T) {
	if _, err := NewAlpacaTradingService("k", "s", "https://api.alpaca.markets", true); err == nil {
		t.Fatal("live baseURL with isPaper=true must return an error, got nil")
	}
	if _, err := NewAlpacaTradingService("k", "s", "https://paper-api.alpaca.markets", false); err == nil {
		t.Fatal("paper baseURL with isPaper=false must return an error, got nil")
	}
}

func TestNewAlpacaTradingService_RejectsUnknownBaseURL(t *testing.T) {
	if _, err := NewAlpacaTradingService("k", "s", "https://example.com", true); err == nil {
		t.Fatal("unrecognized baseURL must fail closed, got nil error")
	}
}

func TestNewAlpacaTradingService_AcceptsConsistentModes(t *testing.T) {
	s, err := NewAlpacaTradingService("k", "s", "https://paper-api.alpaca.markets", true)
	if err != nil {
		t.Fatalf("consistent paper config must succeed, got %v", err)
	}
	if !s.IsPaper() {
		t.Error("IsPaper() = false, want true")
	}

	live, err := NewAlpacaTradingService("k", "s", "https://api.alpaca.markets", false)
	if err != nil {
		t.Fatalf("consistent live config must succeed, got %v", err)
	}
	if live.IsPaper() {
		t.Error("IsPaper() = true for live account, want false")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run 'PaperBaseURL|ModeMismatch|UnknownBaseURL|ConsistentModes' -v`
Expected: FAIL — `undefined: IsPaperBaseURL`, `s.IsPaper undefined`.

- [ ] **Step 3: Implement**

In `services/alpaca_trading.go`, add the `isPaper` field to the struct (after `baseURL string`, line 60):

```go
	baseURL    string
	// isPaper is the resolved paper/live mode. It is validated against baseURL
	// at construction (they cannot disagree), so it is a trustworthy label —
	// unlike the pre-2026-07 flag, which was accepted and discarded, letting a
	// live account report itself as paper.
	isPaper    bool
```

Add above `NewAlpacaTradingService` (line 90):

```go
const (
	alpacaPaperHost = "paper-api.alpaca.markets"
	alpacaLiveHost  = "api.alpaca.markets"
)

// IsPaperBaseURL classifies an Alpaca base URL. known=false means the host is
// not a recognized Alpaca endpoint — callers on a money path must fail closed
// rather than guess.
func IsPaperBaseURL(baseURL string) (isPaper bool, known bool) {
	u, err := neturl.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false, false
	}
	switch strings.ToLower(u.Host) {
	case alpacaPaperHost:
		return true, true
	case alpacaLiveHost:
		return false, true
	}
	return false, false
}

// IsPaper reports the validated paper/live mode of this client.
func (s *AlpacaTradingService) IsPaper() bool { return s.isPaper }
```

Replace the head of `NewAlpacaTradingService` (line 91) so it validates before constructing anything:

```go
func NewAlpacaTradingService(apiKey, secretKey, baseURL string, isPaper bool) (*AlpacaTradingService, error) {
	// Fail closed: the paper flag and the base URL are two independent sources
	// of truth for "is this real money". If they disagree, we cannot know which
	// is right — and the wrong guess trades real money under a "paper" label.
	urlIsPaper, known := IsPaperBaseURL(baseURL)
	if !known {
		return nil, fmt.Errorf("alpaca: unrecognized base URL %q (want %s or %s)", baseURL, alpacaPaperHost, alpacaLiveHost)
	}
	if urlIsPaper != isPaper {
		return nil, fmt.Errorf(
			"alpaca: mode mismatch — ALPACA_PAPER=%v but base URL %q is %s; refusing to start",
			isPaper, baseURL, map[bool]string{true: "PAPER", false: "LIVE"}[urlIsPaper])
	}

	client := alpaca.NewClient(alpaca.ClientOpts{
```

Then set the field in the struct literal (after `baseURL:    baseURL,`):

```go
		baseURL:    baseURL,
		isPaper:    isPaper,
```

`neturl` and `strings` are already imported (`services/alpaca_trading.go:12,15`).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'PaperBaseURL|ModeMismatch|UnknownBaseURL|ConsistentModes' -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Make main.go fatal on mismatch and log the resolved mode**

`cmd/bot/main.go:60-71` currently only *warns* when the trading service fails to construct ("will retry on requests"). For a mode mismatch that is exactly wrong — the bot would run on with a nil trading service and no loud signal. Replace lines 60-71:

```go
	// Create trading service. A mode mismatch (ALPACA_PAPER vs ALPACA_BASE_URL)
	// is FATAL, not a warning: it is the one misconfiguration that can trade real
	// money while every log line reports "paper". Other construction failures stay
	// non-fatal (the service retries on request).
	tradingService, err := services.NewAlpacaTradingService(
		cfg.AlpacaAPIKey,
		cfg.AlpacaSecretKey,
		cfg.AlpacaBaseURL,
		cfg.AlpacaPaper,
	)
	if err != nil {
		logger.Fatalf("FATAL: Alpaca trading service refused to start: %v", err)
	}

	// Announce the resolved mode from the URL — the authoritative source — not
	// from the flag.
	urlIsPaper, _ := services.IsPaperBaseURL(cfg.AlpacaBaseURL)
	mode := "LIVE — REAL MONEY"
	if urlIsPaper {
		mode = "paper"
	}
	logger.WithFields(logrus.Fields{
		"alpaca_mode":     mode,
		"alpaca_base_url": cfg.AlpacaBaseURL,
	}).Warn("Alpaca trading mode resolved")

	tradingService.SetRateLimiter(alpacaDataLimiter)
```

Note the `if tradingService != nil` guard on the old line 69 is now unnecessary — `err != nil` is fatal, so `tradingService` is non-nil past this point. Verify no later code in `main.go` depends on `tradingService` being nil-able; if it does, leave those nil checks alone (they are harmless).

- [ ] **Step 6: Verify the whole package still builds and passes**

Run: `go build ./... && go test ./services/ ./config/ ./controllers/`
Expected: build OK; all tests PASS. If any existing test constructed `NewAlpacaTradingService` with an inconsistent mode or a fake URL, it will now fail — fix those call sites to use a consistent pair (that is the point of the change, not a regression).

- [ ] **Step 7: Commit**

```bash
git add services/alpaca_trading.go services/alpaca_trading_paper_mode_test.go cmd/bot/main.go
git commit -m "feat(coil-live): make ALPACA_PAPER load-bearing — fail closed on mode mismatch

ALPACA_PAPER was decorative: read, passed, accepted as isPaper, then never
stored or used. Live-vs-paper was decided by baseURL alone, so a config where
the two disagreed would trade real money while every log line reported paper.

NewAlpacaTradingService now validates the flag against the URL and refuses to
start on mismatch or an unrecognized host. main.go treats that as FATAL and
logs the resolved mode derived from the URL, not the flag.

Blocking prerequisite for funding a live Coil account (spec §2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Reject inconsistent accounts in config-store (Node)

Closes spec §2 on the Node side. `agent/config-store.js:949` defaults `baseUrl` from `paper`, but an **explicit** `baseUrl` is accepted with no consistency check. `updateAccount:972-973` is worse: it defaults an empty `baseUrl` from the **old** `paper` value, then updates `paper` on the next line — so flipping `paper` alone never moves the URL.

**Files:**
- Modify: `agent/config-store.js:943-996` (`addAccount`, `updateAccount`)
- Test: `agent/config-store-account-mode.test.mjs` (create)

**Interfaces:**
- Produces: `export function resolveAccountMode({ baseUrl, paper })` → `{ baseUrl, paper }`, or throws `Error` on contradiction / unrecognized host. Exported so the test can drive it directly without touching the config file on disk.

- [ ] **Step 1: Write the failing test**

Create `agent/config-store-account-mode.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccountMode } from './config-store.js';

const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';

test('defaults baseUrl from the paper flag', () => {
  assert.deepEqual(resolveAccountMode({ paper: true }), { baseUrl: PAPER, paper: true });
  assert.deepEqual(resolveAccountMode({ paper: false }), { baseUrl: LIVE, paper: false });
});

test('accepts a baseUrl that agrees with the paper flag', () => {
  assert.deepEqual(resolveAccountMode({ baseUrl: LIVE, paper: false }), { baseUrl: LIVE, paper: false });
  assert.deepEqual(resolveAccountMode({ baseUrl: PAPER, paper: true }), { baseUrl: PAPER, paper: true });
});

// The false-comfort failure: an account labelled paper that points at real money.
test('rejects a live baseUrl labelled paper', () => {
  assert.throws(() => resolveAccountMode({ baseUrl: LIVE, paper: true }), /mode mismatch/i);
});

test('rejects a paper baseUrl labelled live', () => {
  assert.throws(() => resolveAccountMode({ baseUrl: PAPER, paper: false }), /mode mismatch/i);
});

test('rejects an unrecognized host (fails closed)', () => {
  assert.throws(() => resolveAccountMode({ baseUrl: 'https://example.com', paper: true }), /unrecognized/i);
});

test('trailing slashes and case do not defeat the check', () => {
  assert.throws(() => resolveAccountMode({ baseUrl: 'HTTPS://API.ALPACA.MARKETS/', paper: true }), /mode mismatch/i);
});

// Regression: updateAccount used the OLD paper value to default an empty
// baseUrl, so flipping paper alone left the URL pointing at the other mode.
test('flipping paper with no explicit baseUrl moves the URL', () => {
  assert.deepEqual(resolveAccountMode({ baseUrl: '', paper: false }), { baseUrl: LIVE, paper: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/config-store-account-mode.test.mjs`
Expected: FAIL — `resolveAccountMode` is not exported / not a function.

- [ ] **Step 3: Implement**

In `agent/config-store.js`, add above `addAccount` (line 943):

```js
const ALPACA_PAPER_URL = 'https://paper-api.alpaca.markets';
const ALPACA_LIVE_URL = 'https://api.alpaca.markets';

// resolveAccountMode is the single source of truth for an account's
// paper-vs-live identity. baseUrl and the paper boolean are two independent
// claims about whether real money is at stake; if they contradict, we cannot
// know which is right, and guessing wrong trades real money under a "paper"
// label. Fails closed: contradiction or unknown host throws.
export function resolveAccountMode({ baseUrl, paper }) {
  const isPaper = paper !== false;
  const raw = (baseUrl || '').trim();
  if (!raw) return { baseUrl: isPaper ? ALPACA_PAPER_URL : ALPACA_LIVE_URL, paper: isPaper };

  let host;
  try {
    host = new URL(raw).host.toLowerCase();
  } catch {
    throw new Error(`Account baseUrl is not a valid URL: ${raw}`);
  }

  const urlIsPaper = host === 'paper-api.alpaca.markets';
  const urlIsLive = host === 'api.alpaca.markets';
  if (!urlIsPaper && !urlIsLive) {
    throw new Error(`Account baseUrl has an unrecognized host: ${host} (want paper-api.alpaca.markets or api.alpaca.markets)`);
  }
  if (urlIsPaper !== isPaper) {
    throw new Error(
      `Account mode mismatch: paper=${isPaper} but baseUrl ${raw} is ${urlIsPaper ? 'PAPER' : 'LIVE'}. ` +
      `Refusing to save an account whose label contradicts its endpoint.`);
  }
  return { baseUrl: raw, paper: isPaper };
}
```

Rewrite `addAccount`'s account literal (lines 946-952) to route through it:

```js
export async function addAccount({ name, publicKey, secretKey, baseUrl, paper }) {
  if (!publicKey || !secretKey) throw new Error('publicKey and secretKey are required');
  const mode = resolveAccountMode({ baseUrl, paper });
  const id = crypto.randomUUID().slice(0, 8);
  const account = {
    id,
    name: name || `Account ${_config.accounts.length + 1}`,
    baseUrl: mode.baseUrl,
    paper: mode.paper,
    createdAt: new Date().toISOString(),
  };
```

Rewrite `updateAccount`'s mode handling (replace lines 971-973). This fixes the stale-`paper` ordering bug by resolving both fields together from the *merged* intent:

```js
  if (name !== undefined && name.trim()) account.name = name.trim();

  // Resolve baseUrl + paper together. Reading either in isolation is what let
  // them drift apart: the old code defaulted baseUrl from the PREVIOUS paper
  // value, then overwrote paper on the next line.
  if (baseUrl !== undefined || paper !== undefined) {
    const mode = resolveAccountMode({
      baseUrl: baseUrl !== undefined ? baseUrl : account.baseUrl,
      paper: paper !== undefined ? paper : account.paper,
    });
    account.baseUrl = mode.baseUrl;
    account.paper = mode.paper;
  }
```

Note: when the caller flips `paper` and leaves `baseUrl` undefined, this carries the *old* `baseUrl` forward and will now correctly **throw** rather than silently mislabel. That is intended — the operator must change both, which the dashboard does. Document this in the runbook (Task 6).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/config-store-account-mode.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full Node suite for regressions**

Run: `npm test`
Expected: PASS. Any existing test that created an account with a contradictory pair will now throw — fix the fixture, don't weaken the check.

- [ ] **Step 6: Commit**

```bash
git add agent/config-store.js agent/config-store-account-mode.test.mjs
git commit -m "feat(coil-live): reject accounts whose baseUrl contradicts the paper flag

config-store let an explicit baseUrl diverge from the paper boolean unchecked,
so an account could be labelled paper while pointing at api.alpaca.markets.
updateAccount was worse: it defaulted an empty baseUrl from the OLD paper value
before overwriting paper, so flipping the flag alone never moved the URL.

resolveAccountMode now resolves both fields together and fails closed on any
contradiction or unrecognized host.

Blocking prerequisite for funding a live Coil account (spec §2).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Code-enforced −15% high-water halt

Closes spec §4. This is the only rail bounding real-money loss and **must not** depend on the LLM self-policing. Modelled on `services/prophet_sleeve_guard.go`.

**Design note — why a baseline floor on the high-water mark.** The HWM is persisted to a JSON file. If that file were lost mid-drawdown, recomputing HWM from current equity would ratchet it *down*, and the halt would never fire — a fail-open hole. So the effective HWM is `max(configuredBaselineUSD, persistedHWM, currentEquity)`. A lost file can never drop the mark below the funded baseline.

**Files:**
- Create: `services/coil_live_halt_guard.go`
- Create: `services/coil_live_halt_guard_test.go`
- Modify: `services/trade_guard.go` (consult the halt inside `CheckBuy`)
- Modify: `config/config.go` (flags)
- Modify: `cmd/bot/main.go` (wiring)
- Test: `services/trade_guard_halt_test.go` (create — proves the halt reaches Coil's real entry path)

**Interfaces:**
- Produces: `type CoilLiveHaltConfig struct { Enabled bool; DrawdownPct float64; BaselineUSD float64; StateDir string }`
- Produces: `func NewCoilLiveHaltGuard(cfg CoilLiveHaltConfig, reader HaltAccountReader) *CoilLiveHaltGuard`
- Produces: `func (g *CoilLiveHaltGuard) EvaluateEntry(ctx context.Context) error` — nil = allow, error = block.
- Produces: `func (g *CoilLiveHaltGuard) Status(ctx context.Context) CoilHaltStatus`
- Produces: `type HaltAccountReader interface { GetAccount(ctx context.Context) (*interfaces.Account, error) }`
- Consumes: `TradeGuard` gains `SetHaltGuard(h EntryHalter)` where `type EntryHalter interface { EvaluateEntry(ctx context.Context) error }`.

- [ ] **Step 1: Write the failing test**

Create `services/coil_live_halt_guard_test.go`:

```go
package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"prophet-trader/interfaces"
	"testing"
)

type fakeHaltReader struct {
	equity float64
	err    error
}

func (f *fakeHaltReader) GetAccount(_ context.Context) (*interfaces.Account, error) {
	if f.err != nil {
		return nil, f.err
	}
	return &interfaces.Account{PortfolioValue: f.equity}, nil
}

func newTestHalt(t *testing.T, equity float64, baseline float64) (*CoilLiveHaltGuard, string) {
	t.Helper()
	dir := t.TempDir()
	g := NewCoilLiveHaltGuard(CoilLiveHaltConfig{
		Enabled:     true,
		DrawdownPct: 0.15,
		BaselineUSD: baseline,
		StateDir:    dir,
	}, &fakeHaltReader{equity: equity})
	return g, dir
}

func TestHalt_DisabledIsNoOp(t *testing.T) {
	g := NewCoilLiveHaltGuard(CoilLiveHaltConfig{Enabled: false}, &fakeHaltReader{equity: 1})
	if err := g.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("disabled guard must allow, got %v", err)
	}
}

func TestHalt_AllowsAboveThreshold(t *testing.T) {
	// Baseline 5000, equity 4300 => 14% drawdown, just inside the 15% limit.
	g, _ := newTestHalt(t, 4300, 5000)
	if err := g.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("14%% drawdown must be allowed, got %v", err)
	}
}

func TestHalt_BlocksAtThreshold(t *testing.T) {
	// Baseline 5000, equity 4250 => exactly -15%.
	g, dir := newTestHalt(t, 4250, 5000)
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("-15% drawdown must block, got nil")
	}
	if _, err := os.Stat(filepath.Join(dir, coilHaltLatchFileName)); err != nil {
		t.Fatalf("crossing the threshold must write the latch file: %v", err)
	}
}

// The mark ratchets UP with equity and never down — a drawdown is measured from
// the peak, not from the funded baseline.
func TestHalt_HighWaterRatchetsUp(t *testing.T) {
	dir := t.TempDir()
	reader := &fakeHaltReader{equity: 10000}
	cfg := CoilLiveHaltConfig{Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir}

	g := NewCoilLiveHaltGuard(cfg, reader)
	if err := g.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("equity at a new peak must be allowed, got %v", err)
	}

	// Equity falls to 8600 — only 14% off the 10000 peak: still allowed.
	reader.equity = 8600
	if err := g.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("14%% off peak must be allowed, got %v", err)
	}

	// 8400 is -16% off the 10000 peak, though still far above the 5000 baseline.
	reader.equity = 8400
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("-16% off the high-water peak must block even while above baseline")
	}
}

// A lost state file must not silently re-arm the guard mid-drawdown. The
// baseline floors the mark, so the halt still fires.
func TestHalt_LostStateFileFallsBackToBaseline(t *testing.T) {
	g, _ := newTestHalt(t, 4000, 5000) // no prior state file exists at all
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("with no state file, HWM must floor at the baseline and block at -20%")
	}
}

// Fail closed: an unreadable account blocks the entry.
func TestHalt_AccountErrorFailsClosed(t *testing.T) {
	dir := t.TempDir()
	g := NewCoilLiveHaltGuard(CoilLiveHaltConfig{
		Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir,
	}, &fakeHaltReader{err: errors.New("broker down")})
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("unreadable account must fail closed, got nil")
	}
}

// Fail closed: enabled but unconfigured baseline is a misconfiguration.
func TestHalt_ZeroBaselineFailsClosed(t *testing.T) {
	dir := t.TempDir()
	g := NewCoilLiveHaltGuard(CoilLiveHaltConfig{
		Enabled: true, DrawdownPct: 0.15, BaselineUSD: 0, StateDir: dir,
	}, &fakeHaltReader{equity: 5000})
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("enabled guard with no baseline must fail closed, got nil")
	}
}

// The latch survives recovery: once tripped, equity climbing back does NOT
// re-arm. Re-arm is deliberate file deletion only.
func TestHalt_LatchRequiresManualRearm(t *testing.T) {
	dir := t.TempDir()
	reader := &fakeHaltReader{equity: 4000}
	cfg := CoilLiveHaltConfig{Enabled: true, DrawdownPct: 0.15, BaselineUSD: 5000, StateDir: dir}

	g := NewCoilLiveHaltGuard(cfg, reader)
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("expected the halt to trip")
	}

	// Equity fully recovers. A fresh guard (simulating a restart) must STILL block.
	reader.equity = 6000
	g2 := NewCoilLiveHaltGuard(cfg, reader)
	err := g2.EvaluateEntry(context.Background())
	if err == nil {
		t.Fatal("a tripped latch must survive restart and recovery — got nil")
	}

	// Deleting the latch re-arms it.
	if rmErr := os.Remove(filepath.Join(dir, coilHaltLatchFileName)); rmErr != nil {
		t.Fatalf("remove latch: %v", rmErr)
	}
	g3 := NewCoilLiveHaltGuard(cfg, reader)
	if err := g3.EvaluateEntry(context.Background()); err != nil {
		t.Fatalf("after manual re-arm the guard must allow, got %v", err)
	}
}

func TestHalt_ManualKillBlocks(t *testing.T) {
	g, dir := newTestHalt(t, 5000, 5000)
	if err := os.WriteFile(filepath.Join(dir, coilHaltKillFileName), []byte("{}"), 0o644); err != nil {
		t.Fatalf("write kill file: %v", err)
	}
	if err := g.EvaluateEntry(context.Background()); err == nil {
		t.Fatal("manual kill file must block entries")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run 'TestHalt_' -v`
Expected: FAIL — `undefined: CoilLiveHaltGuard`, `undefined: CoilLiveHaltConfig`.

- [ ] **Step 3: Implement the guard**

Create `services/coil_live_halt_guard.go`:

```go
package services

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"

	"prophet-trader/interfaces"

	"github.com/sirupsen/logrus"
)

const (
	coilHaltKillFileName  = "KILL_COIL_LIVE"
	coilHaltLatchFileName = "coil_live_halt.json"
	coilHaltStateFileName = "coil_live_highwater.json"
)

// HaltAccountReader is the narrow broker-read surface the halt needs.
// interfaces.TradingService satisfies it.
type HaltAccountReader interface {
	GetAccount(ctx context.Context) (*interfaces.Account, error)
}

// CoilLiveHaltConfig parameterizes the live drawdown halt.
type CoilLiveHaltConfig struct {
	Enabled     bool
	DrawdownPct float64 // 0.15 = halt at -15% from the high-water mark
	BaselineUSD float64 // funded baseline; floors the high-water mark. <=0 => fail closed when enabled
	StateDir    string
}

// CoilLiveHaltGuard blocks NEW ENTRIES once live equity falls DrawdownPct below
// its high-water mark. It is the only code-enforced rail bounding real-money
// loss on the live Coil account — every other Coil cap (position size,
// concurrency, deploy ceiling) is prose the LLM is trusted to self-police, which
// is acceptable on paper and not acceptable here.
//
// FAILS CLOSED: missing baseline, unreadable account, or a present latch blocks
// the entry. Consulted only from TradeGuard.CheckBuy, so exits are never blocked.
//
// Re-arm is deliberate: delete the latch file. There is intentionally no
// programmatic re-arm.
type CoilLiveHaltGuard struct {
	cfg    CoilLiveHaltConfig
	reader HaltAccountReader
	logger *logrus.Logger
}

func NewCoilLiveHaltGuard(cfg CoilLiveHaltConfig, reader HaltAccountReader) *CoilLiveHaltGuard {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})
	return &CoilLiveHaltGuard{cfg: cfg, reader: reader, logger: logger}
}

func (g *CoilLiveHaltGuard) killPath() string  { return filepath.Join(g.cfg.StateDir, coilHaltKillFileName) }
func (g *CoilLiveHaltGuard) latchPath() string { return filepath.Join(g.cfg.StateDir, coilHaltLatchFileName) }
func (g *CoilLiveHaltGuard) statePath() string { return filepath.Join(g.cfg.StateDir, coilHaltStateFileName) }

func coilHaltFileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (g *CoilLiveHaltGuard) block(reason string) error {
	g.logger.WithFields(logrus.Fields{"coil_live_halt_block": true, "reason": reason}).
		Warn("Coil live halt blocked a new entry")
	return fmt.Errorf("coil live halt: %s", reason)
}

// highWaterState is the persisted peak. Written on every ratchet-up.
type highWaterState struct {
	HighWaterUSD float64   `json:"high_water_usd"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (g *CoilLiveHaltGuard) readPersistedHighWater() float64 {
	b, err := os.ReadFile(g.statePath())
	if err != nil {
		return 0 // absent/unreadable -> baseline floors it; never fails open
	}
	var s highWaterState
	if json.Unmarshal(b, &s) != nil {
		return 0
	}
	return s.HighWaterUSD
}

func (g *CoilLiveHaltGuard) writeHighWater(v float64) {
	if err := os.MkdirAll(g.cfg.StateDir, 0o755); err != nil {
		g.logger.WithError(err).Error("coil live halt: cannot create state dir")
		return
	}
	b, _ := json.MarshalIndent(highWaterState{HighWaterUSD: v, UpdatedAt: time.Now().UTC()}, "", "  ")
	if err := os.WriteFile(g.statePath(), b, 0o644); err != nil {
		g.logger.WithError(err).Error("coil live halt: failed to persist high-water mark")
	}
}

// effectiveHighWater is max(baseline, persisted, equity). Flooring at the
// funded baseline is what makes a lost state file safe: without it, a file lost
// mid-drawdown would reset the mark down to current equity and the halt would
// never fire.
func (g *CoilLiveHaltGuard) effectiveHighWater(equity float64) float64 {
	return math.Max(g.cfg.BaselineUSD, math.Max(g.readPersistedHighWater(), equity))
}

type coilHaltLatch struct {
	Reason       string    `json:"reason"`
	EngagedAt    time.Time `json:"engaged_at"`
	EquityUSD    float64   `json:"equity_usd"`
	HighWaterUSD float64   `json:"high_water_usd"`
	DrawdownPct  float64   `json:"drawdown_pct"`
}

func (g *CoilLiveHaltGuard) tripLatch(equity, hwm, dd float64) {
	if coilHaltFileExists(g.latchPath()) {
		return
	}
	if err := os.MkdirAll(g.cfg.StateDir, 0o755); err != nil {
		g.logger.WithError(err).Error("coil live halt: cannot create state dir for latch")
		return
	}
	b, _ := json.MarshalIndent(coilHaltLatch{
		Reason:       "high-water drawdown halt",
		EngagedAt:    time.Now().UTC(),
		EquityUSD:    equity,
		HighWaterUSD: hwm,
		DrawdownPct:  dd,
	}, "", "  ")
	if err := os.WriteFile(g.latchPath(), b, 0o644); err != nil {
		g.logger.WithError(err).Error("coil live halt: failed to write halt latch")
	}
}

// EvaluateEntry returns nil to allow a new entry, or an error to block it.
func (g *CoilLiveHaltGuard) EvaluateEntry(ctx context.Context) error {
	if !g.cfg.Enabled {
		return nil
	}
	if g.cfg.BaselineUSD <= 0 {
		return g.block("baseline not configured (COIL_LIVE_BASELINE_USD<=0)")
	}
	if g.cfg.DrawdownPct <= 0 || g.cfg.DrawdownPct >= 1 {
		return g.block(fmt.Sprintf("invalid drawdown pct %.4f (want 0<pct<1)", g.cfg.DrawdownPct))
	}
	if coilHaltFileExists(g.killPath()) {
		return g.block("manual kill switch engaged")
	}
	if coilHaltFileExists(g.latchPath()) {
		return g.block("drawdown halt latched — delete " + coilHaltLatchFileName + " to re-arm")
	}

	acct, err := g.reader.GetAccount(ctx)
	if err != nil {
		return g.block(fmt.Sprintf("account unavailable (fail closed): %v", err))
	}
	if acct == nil || acct.PortfolioValue <= 0 {
		return g.block("account portfolio value unavailable (fail closed)")
	}

	equity := acct.PortfolioValue
	hwm := g.effectiveHighWater(equity)
	if equity >= hwm {
		g.writeHighWater(equity) // ratchet up
		return nil
	}

	drawdown := (hwm - equity) / hwm
	if drawdown >= g.cfg.DrawdownPct {
		g.tripLatch(equity, hwm, drawdown)
		return g.block(fmt.Sprintf(
			"drawdown %.2f%% >= %.2f%% limit (equity $%.2f vs high-water $%.2f) — new entries halted; open positions still managed",
			drawdown*100, g.cfg.DrawdownPct*100, equity, hwm))
	}
	return nil
}

// CoilHaltStatus is the read-only observability snapshot.
type CoilHaltStatus struct {
	Enabled      bool     `json:"enabled"`
	Armed        bool     `json:"armed"`
	BlockReasons []string `json:"block_reasons"`
	EquityUSD    float64  `json:"equity_usd"`
	HighWaterUSD float64  `json:"high_water_usd"`
	DrawdownPct  float64  `json:"drawdown_pct"`
	LimitPct     float64  `json:"limit_pct"`
	BaselineUSD  float64  `json:"baseline_usd"`
}

// Status never places orders, so a read failure is reported as a reason rather
// than an error.
func (g *CoilLiveHaltGuard) Status(ctx context.Context) CoilHaltStatus {
	s := CoilHaltStatus{
		Enabled:     g.cfg.Enabled,
		LimitPct:    g.cfg.DrawdownPct,
		BaselineUSD: g.cfg.BaselineUSD,
	}
	if !g.cfg.Enabled {
		return s
	}
	var reasons []string
	if g.cfg.BaselineUSD <= 0 {
		reasons = append(reasons, "baseline not configured")
	}
	if coilHaltFileExists(g.killPath()) {
		reasons = append(reasons, "manual kill engaged")
	}
	if coilHaltFileExists(g.latchPath()) {
		reasons = append(reasons, "drawdown halt latched")
	}
	if acct, err := g.reader.GetAccount(ctx); err == nil && acct != nil && acct.PortfolioValue > 0 {
		s.EquityUSD = acct.PortfolioValue
		s.HighWaterUSD = g.effectiveHighWater(acct.PortfolioValue)
		if s.HighWaterUSD > 0 {
			s.DrawdownPct = (s.HighWaterUSD - s.EquityUSD) / s.HighWaterUSD
		}
		if s.DrawdownPct >= g.cfg.DrawdownPct {
			reasons = append(reasons, "drawdown limit reached")
		}
	} else {
		reasons = append(reasons, "account unavailable")
	}
	s.BlockReasons = reasons
	s.Armed = len(reasons) == 0
	return s
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'TestHalt_' -v`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing integration test — the halt must reach Coil's real entry path**

Coil enters via `place_managed_position` → `PositionManager` → `guard.CheckBuy` (`services/position_manager.go:253`), **not** via `OrderController.Buy`. A halt wired only into the order controller would be bypassed by Coil's actual entry path. This test pins that.

Create `services/trade_guard_halt_test.go`:

```go
package services

import (
	"context"
	"errors"
	"testing"
)

type stubHalter struct{ err error }

func (s *stubHalter) EvaluateEntry(_ context.Context) error { return s.err }

func TestCheckBuy_ConsultsHaltGuard(t *testing.T) {
	g := NewTradeGuard(&fakePositions{}, nil, TradeGuardConfig{})
	g.SetHaltGuard(&stubHalter{err: errors.New("drawdown halt latched")})

	err := g.CheckBuy(context.Background(), AgentMeanRev, "AAPL", 600)
	if err == nil {
		t.Fatal("CheckBuy must block when the halt guard blocks, got nil")
	}
}

func TestCheckBuy_AllowsWhenHaltArmed(t *testing.T) {
	g := NewTradeGuard(&fakePositions{}, nil, TradeGuardConfig{})
	g.SetHaltGuard(&stubHalter{err: nil})

	if err := g.CheckBuy(context.Background(), AgentMeanRev, "AAPL", 600); err != nil {
		t.Fatalf("CheckBuy must allow when the halt is armed, got %v", err)
	}
}

func TestCheckBuy_NoHaltGuardIsNoOp(t *testing.T) {
	g := NewTradeGuard(&fakePositions{}, nil, TradeGuardConfig{})
	if err := g.CheckBuy(context.Background(), AgentMeanRev, "AAPL", 600); err != nil {
		t.Fatalf("a guard with no halt wired must allow, got %v", err)
	}
}
```

`fakePositions` already exists in `services/trade_guard_test.go` — reuse it. If its name differs, use the existing stub that satisfies `positionLister` (check `services/trade_guard_test.go` for the exact type name and adapt; do **not** define a duplicate).

- [ ] **Step 6: Run to verify it fails**

Run: `go test ./services/ -run 'TestCheckBuy_.*Halt|TestCheckBuy_NoHalt' -v`
Expected: FAIL — `g.SetHaltGuard undefined`.

- [ ] **Step 7: Wire the halt into TradeGuard**

In `services/trade_guard.go`, add the interface near the other collaborator interfaces (after `OptionsExposureProvider`, ~line 226):

```go
// EntryHalter is a veto on NEW ENTRIES consulted by CheckBuy. Implemented by
// CoilLiveHaltGuard. Kept as an interface so the guard stays testable and so a
// bot with no halt configured pays nothing.
type EntryHalter interface {
	EvaluateEntry(ctx context.Context) error
}
```

Add the field to `TradeGuard` (after `optionsProvider`, ~line 244):

```go
	// halt is optional. When non-nil it can veto any new entry (drawdown halt on
	// the live account). Never consulted on exits — CheckBuy is buys-only.
	halt EntryHalter
```

Add the setter next to the other wiring methods:

```go
// SetHaltGuard wires the entry halt. nil disables it.
func (g *TradeGuard) SetHaltGuard(h EntryHalter) { g.halt = h }
```

In `CheckBuy` (line 279), consult it **first** — before the account fetch, so a halted account makes no broker calls. Insert immediately after the `if agent == ""` block:

```go
	// Entry halt (live drawdown backstop). Checked before anything else: when the
	// account is halted no new entry is permissible for any reason, so there is
	// no point spending a broker call to discover that.
	if g.halt != nil {
		if err := g.halt.EvaluateEntry(ctx); err != nil {
			return err
		}
	}
```

- [ ] **Step 8: Run to verify it passes**

Run: `go test ./services/ -run 'TestCheckBuy_' -v`
Expected: PASS (including the pre-existing CheckBuy tests).

- [ ] **Step 9: Add config flags**

In `config/config.go`, add to the `Config` struct (after the Prophet sleeve block, ~line 112):

```go
	// Coil live drawdown halt. The ONLY code-enforced rail bounding real-money
	// loss on the live Coil account. Like the Prophet sleeve gate, it FAILS
	// CLOSED on missing config. Default OFF; enabled only in the live Coil bot.
	EnableCoilLiveHalt   bool
	CoilLiveDrawdownPct  float64 // 0.15 = halt at -15% from high-water
	CoilLiveBaselineUSD  float64 // funded baseline; floors the high-water mark
	CoilLiveStateDir     string  // dir for halt latch/kill/state files; empty => derive from DatabasePath dir
```

In `Load()`, add to the `AppConfig` literal:

```go
		EnableCoilLiveHalt:  getEnvOrDefault("ENABLE_COIL_LIVE_HALT", "false") == "true",
		CoilLiveDrawdownPct: parseFloatOrDefault("COIL_LIVE_DRAWDOWN_PCT", 0.15),
		CoilLiveBaselineUSD: parseFloatOrDefault("COIL_LIVE_BASELINE_USD", 0),
		CoilLiveStateDir:    os.Getenv("COIL_LIVE_STATE_DIR"),
```

Use whatever float helper already exists in `config/config.go` (grep for `parseFloatOrDefault` / `getEnvFloat`; the sleeve's `ProphetSleeveBaselineUSD` uses it — match that name exactly rather than adding a new helper).

- [ ] **Step 10: Wire it in main.go**

In `cmd/bot/main.go`, immediately after the sleeve guard block (~line 249), add:

```go
	// Coil live drawdown halt. Default OFF; the live Coil bot sets
	// ENABLE_COIL_LIVE_HALT=true. Shares the sleeve's state-dir convention.
	coilHaltStateDir := cfg.CoilLiveStateDir
	if coilHaltStateDir == "" {
		coilHaltStateDir = filepath.Dir(cfg.DatabasePath)
	}
	if cfg.EnableCoilLiveHalt {
		coilHalt := services.NewCoilLiveHaltGuard(
			services.CoilLiveHaltConfig{
				Enabled:     true,
				DrawdownPct: cfg.CoilLiveDrawdownPct,
				BaselineUSD: cfg.CoilLiveBaselineUSD,
				StateDir:    coilHaltStateDir,
			},
			tradingService,
		)
		tradeGuard.SetHaltGuard(coilHalt)
		logger.WithFields(logrus.Fields{
			"coil_live_halt_enabled": true,
			"drawdown_pct":           cfg.CoilLiveDrawdownPct,
			"baseline_usd":           cfg.CoilLiveBaselineUSD,
			"state_dir":              coilHaltStateDir,
		}).Warn("Coil live drawdown halt ARMED")
	}
```

- [ ] **Step 11: Verify build + full Go suite**

Run: `go build ./... && go test ./...`
Expected: build OK, all PASS.

- [ ] **Step 12: Commit**

```bash
git add services/coil_live_halt_guard.go services/coil_live_halt_guard_test.go \
        services/trade_guard.go services/trade_guard_halt_test.go \
        config/config.go cmd/bot/main.go
git commit -m "feat(coil-live): code-enforced -15% high-water drawdown halt

Every existing Coil cap (6%/name, 14 positions, 85% deploy) is prose in a
markdown file the LLM is trusted to self-police. That is fine on paper; it is
not acceptable as the sole backstop on real money, since an agent that misreads
its own halt condition is exactly the failure the rail exists to catch.

CoilLiveHaltGuard blocks NEW ENTRIES once equity falls 15% below its high-water
mark, and is consulted inside TradeGuard.CheckBuy -- the chokepoint shared by
OrderController.Buy and PositionManager.PlaceManagedPosition (Coil's actual
entry path). CheckBuy is buys-only, so exits can never be blocked.

Fails closed (missing baseline / unreadable account / present latch all block).
The high-water mark is floored at the funded baseline so a lost state file
cannot silently re-arm the guard mid-drawdown. Re-arm is manual: delete the
latch file.

Blocking prerequisite for funding (spec §4).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Register the live strategy id everywhere (+ conformance test)

Closes the **Critical finding** above. Introduces `mean-rev-rsi2-live` into every id-keyed registry and adds a test that fails if a future registry forgets it.

**Files:**
- Modify: `services/trade_guard.go:44` (`AgentForStrategy`)
- Modify: `agent/tool-allowlists.js:224`
- Modify: `agent/preflight.js:364-371, 438-444` (make the Coil predicate strategy-aware)
- Modify: `agent/candidate-warmer-flags.js:8`
- Modify: `agent/reasoning-digest.js:76`
- Test: `services/trade_guard_test.go:500` (extend `TestAgentForStrategy`)
- Test: `agent/coil-strategy-registration.test.mjs` (create — the conformance test)

**Interfaces:**
- Produces: `agent/coil-strategy-ids.js` → `export const COIL_STRATEGY_IDS = ['mean-rev-rsi2', 'mean-rev-rsi2-live'];` and `export const COIL_LIVE_STRATEGY_ID = 'mean-rev-rsi2-live';` — the single list every Node registry imports, so registration cannot drift.

- [ ] **Step 1: Write the failing conformance test**

Create `agent/coil-strategy-registration.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COIL_STRATEGY_IDS, COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';
import { resolveAllowedTools, STRATEGY_TOOL_ALLOWLISTS } from './tool-allowlists.js';
import { PREFLIGHT_REGISTRY } from './preflight.js';
import { candidateWarmerFlags } from './candidate-warmer-flags.js';

// An unregistered strategy id does not fail loudly -- it fails OPEN. Left
// unregistered, live Coil would receive the FULL MCP toolset (resolveAllowedTools
// returns [], and [] means "no filter"). Every Coil id must resolve everywhere.
for (const id of COIL_STRATEGY_IDS) {
  test(`${id}: has a non-empty tool allowlist`, () => {
    const tools = resolveAllowedTools([], id);
    assert.ok(tools.length > 0, `${id} resolved to an EMPTY allowlist, which means NO FILTER (all tools allowed)`);
    assert.ok(STRATEGY_TOOL_ALLOWLISTS[id], `${id} missing from STRATEGY_TOOL_ALLOWLISTS`);
  });

  test(`${id}: has a registered preflight predicate`, () => {
    assert.equal(typeof PREFLIGHT_REGISTRY[id], 'function', `${id} has no preflight registered`);
  });

  test(`${id}: enables the meanrev candidate warmer`, () => {
    assert.equal(candidateWarmerFlags(id).ENABLE_MEANREV_WARMER, 'true');
    assert.equal(candidateWarmerFlags(id).ENABLE_DRIFT_WARMER, 'false');
  });
}

test('live Coil gets the same toolset as paper Coil', () => {
  assert.deepEqual(
    resolveAllowedTools([], COIL_LIVE_STRATEGY_ID),
    resolveAllowedTools([], 'mean-rev-rsi2'),
    'live Coil must not have a broader toolset than paper Coil',
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test agent/coil-strategy-registration.test.mjs`
Expected: FAIL — cannot resolve `./coil-strategy-ids.js`.

- [ ] **Step 3: Create the shared id list**

Create `agent/coil-strategy-ids.js`:

```js
// The strategy ids Coil trades under. A strategy id is a lookup key in five
// separate registries (guard agent attribution, MCP tool allowlist, beat
// preflight, candidate-cache warmer, reasoning digest) and THREE OF THEM FAIL
// OPEN -- most dangerously resolveAllowedTools, where an unknown id yields []
// which means "no filter, all tools allowed".
//
// Import this list rather than hardcoding an id, so adding a Coil variant can
// never silently unregister it. agent/coil-strategy-registration.test.mjs
// enforces that every id here resolves in every registry.
export const COIL_PAPER_STRATEGY_ID = 'mean-rev-rsi2';
export const COIL_LIVE_STRATEGY_ID = 'mean-rev-rsi2-live';
export const COIL_STRATEGY_IDS = [COIL_PAPER_STRATEGY_ID, COIL_LIVE_STRATEGY_ID];
```

- [ ] **Step 4: Register in tool-allowlists.js**

In `agent/tool-allowlists.js`, import at the top and replace the `mean-rev-rsi2` entry (line 225) so both ids share one definition:

```js
import { COIL_STRATEGY_IDS } from './coil-strategy-ids.js';
```

```js
const COIL_TOOLS = uniq([...BASE, ...MEANREV_SIGNALS, ...MANAGED]);

export const STRATEGY_TOOL_ALLOWLISTS = {
  // Every Coil id (paper + live) gets the identical, restricted toolset. Live
  // Coil must never have a broader surface than the paper record was built on.
  ...Object.fromEntries(COIL_STRATEGY_IDS.map(id => [id, COIL_TOOLS])),
  'earnings-drift': uniq([...BASE, ...DRIFT_SIGNALS, ...MANAGED]),
  // analyze_stocks: trend reads its cross_asset block (5-day DXY/rate/credit
  // proxies) to confirm or pause a Donchian breakout (TRADING_RULES_TREND.md
  // "Cross-Asset Context"). Without it the agent silently loses macro confluence.
  'trend': uniq([...BASE, ...TREND_SIGNALS, 'analyze_stocks', 'place_buy_order', 'place_sell_order', 'cancel_order']),
  'v2-options': ALL_TOOLS.filter(t => !NON_PROPHET.has(t)),
};
```

- [ ] **Step 5: Register in candidate-warmer-flags.js**

Replace the body of `agent/candidate-warmer-flags.js`:

```js
import { COIL_STRATEGY_IDS } from './coil-strategy-ids.js';

// Candidate-cache warmer gating. The Go warmer (cmd/bot/main.go) is launched
// per-bot only for the cache that bot's agent actually reads: Coil reads
// /meanrev/candidates, Drift ('earnings-drift') reads /drift/candidates. Every
// other agent gets an explicit 'false' so it can't inherit a 'true' from the
// shared .env (same reasoning as the turtle flag).
export function candidateWarmerFlags(strategyId) {
  return {
    ENABLE_MEANREV_WARMER: COIL_STRATEGY_IDS.includes(strategyId) ? 'true' : 'false',
    ENABLE_DRIFT_WARMER: strategyId === 'earnings-drift' ? 'true' : 'false',
  };
}
```

- [ ] **Step 6: Make the Coil preflight strategy-aware**

This is the dangerous one. `agent/preflight.js:367` hardcodes `?strategy=mean-rev-rsi2`. Under the live id that query returns `[]` from the live DB, so on a day with no new candidates the beat would be **skipped while live positions are open** — stranding them from LLM exit management.

Replace `meanRevPreflight` (lines 364-371):

```js
// Coil predicate. Coil fires once per trading day at 15:45 ET via an exclusive
// scheduledBeats window, so this only runs once daily — it skips the single beat
// on days with nothing to do.
//
// Skips when there are no strategy-attributed open positions AND no entry
// candidates. When candidates exist but there are no positions, the regime gate
// (RED block) and econ blackout still apply.
//
// The positions query MUST carry the agent's own strategy id. Hardcoding the
// paper id would make live Coil query a strategy it never trades under, get an
// empty array back, and skip a beat while holding real positions — i.e. stop
// managing exits on live money.
//
// Positions are read from /api/v1/positions?strategy=<id>, which returns a PLAIN
// ARRAY (order_controller.go HandleGetPositions) — hence the Array.isArray check
// + .length, not a {count} object. An open position always wins (exit-rule
// evaluation must run). Ambiguous shapes fail open.
function makeMeanRevPreflight(strategyId) {
  return async function meanRevPreflight(runtime, _agentConfig) {
    return candidatesAndPositionsPreflight(runtime, {
      candidatesUrl: '/api/v1/meanrev/candidates',
      positionsUrl: `/api/v1/positions?strategy=${encodeURIComponent(strategyId)}`,
      noWorkReason: 'no positions and no RSI(2) entry candidates',
      label: 'meanrev',
    });
  };
}
```

Then build the registry entries from the shared list (replace lines 438-444). Add the import at the top of the file:

```js
import { COIL_STRATEGY_IDS } from './coil-strategy-ids.js';
```

```js
export const PREFLIGHT_REGISTRY = {
  'trend':            trendPreflight,
  'v2-options':       prophetPreflight,
  // Each Coil id gets a predicate bound to its OWN strategy id, so the positions
  // query always matches the strategy the agent actually trades under.
  ...Object.fromEntries(COIL_STRATEGY_IDS.map(id => [id, makeMeanRevPreflight(id)])),
  'earnings-drift':   driftPreflight,
  'prophet-defensive': defensiveProphetPreflight,
};
```

- [ ] **Step 7: Register in reasoning-digest.js**

In `agent/reasoning-digest.js`, replace the `STRATEGY_KIND` map (line 76):

```js
import { COIL_STRATEGY_IDS } from './coil-strategy-ids.js';

const STRATEGY_KIND = {
  'trend': 'turtle',
  ...Object.fromEntries(COIL_STRATEGY_IDS.map(id => [id, 'coil'])),
};
```

(Adjust to the file's existing import style — if it is CommonJS, use the matching syntax. Check the top of the file first.)

- [ ] **Step 8: Register in the Go guard**

In `services/trade_guard.go`, add the live case to `AgentForStrategy` (line 48):

```go
	case "mean-rev-rsi2", "mean-rev-rsi2-live":
		return AgentMeanRev
```

Extend the existing `TestAgentForStrategy` in `services/trade_guard_test.go:500` — add `"mean-rev-rsi2-live": AgentMeanRev` to its case table. **Do not** let it default to `AgentMain`: that would strip Coil's per-agent caps and cross-agent symbol-overlap protection and mistake it for Prophet.

- [ ] **Step 9: Run all tests**

Run: `npm test && go test ./services/`
Expected: PASS — including the 9 new conformance assertions.

- [ ] **Step 10: Commit**

```bash
git add agent/coil-strategy-ids.js agent/coil-strategy-registration.test.mjs \
        agent/tool-allowlists.js agent/preflight.js agent/candidate-warmer-flags.js \
        agent/reasoning-digest.js services/trade_guard.go services/trade_guard_test.go
git commit -m "feat(coil-live): register mean-rev-rsi2-live in every strategy-id registry

A strategy id is a lookup key in five registries and three of them fail OPEN.
Adding the live id without registering it would have produced an UNGUARDED
real-money Coil:

- resolveAllowedTools returns [] for an unknown id, and [] means \"no filter\" --
  live Coil would have received the full MCP toolset, options tools included.
- AgentForStrategy would fall through to AgentMain, stripping Coil's per-agent
  caps and cross-agent symbol-overlap protection.
- preflight hardcoded ?strategy=mean-rev-rsi2, so live Coil would query a
  strategy it never trades under, get [] back, and skip its single daily beat
  while holding real positions -- i.e. stop managing exits on live money.

All five now derive from one shared COIL_STRATEGY_IDS list, and a conformance
test fails if any future registry forgets an id.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Live rules file + strategy entry

Closes spec §3. Creates `TRADING_RULES_MEANREV_LIVE.md` and registers the `mean-rev-rsi2-live` strategy. **`TRADING_RULES_MEANREV.md` is not modified.**

**Files:**
- Create: `TRADING_RULES_MEANREV_LIVE.md`
- Modify: `agent/config-store.js:380-387` (fix stale description; add the live strategy entry)
- Modify: `agent/orchestrator.js:180-195` (set `MEANREV_BEAR_MODE` per-strategy, not from shared .env)
- Test: `agent/config-store-strategies.test.mjs` (create)

**Interfaces:**
- Consumes: `COIL_LIVE_STRATEGY_ID` from Task 4's `agent/coil-strategy-ids.js`.

- [ ] **Step 1: Write the failing test**

Create `agent/config-store-strategies.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { _internals } from './config-store.js';
import { COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';

const strategies = _internals.defaultStrategies();
const byId = Object.fromEntries(strategies.map(s => [s.id, s]));

test('the live Coil strategy is registered', () => {
  const live = byId[COIL_LIVE_STRATEGY_ID];
  assert.ok(live, `${COIL_LIVE_STRATEGY_ID} is not in defaultStrategies()`);
  assert.equal(live.rulesFile, 'TRADING_RULES_MEANREV_LIVE.md');
});

test('the live rules file exists on disk', () => {
  assert.ok(existsSync('TRADING_RULES_MEANREV_LIVE.md'), 'live rules file is missing');
});

test('the live rules carry the live sizing params, not the paper ones', () => {
  const rules = readFileSync('TRADING_RULES_MEANREV_LIVE.md', 'utf8');
  assert.match(rules, /0\.12/, 'live rules must size at 12% per position');
  assert.match(rules, /Maximum 7 open/i, 'live rules must cap concurrency at 7');
  assert.match(rules, /halt/i, 'live rules must specify bear mode halt');
});

// The paper description claimed "5% per position; max 5 concurrent" while the
// rules file said 6% and 14. Do not let the live variant inherit a stale claim.
test('paper Coil description matches its rules file', () => {
  assert.match(byId['mean-rev-rsi2'].description, /6% per position/);
  assert.match(byId['mean-rev-rsi2'].description, /max 14 concurrent/);
});

test('live Coil description matches its rules file', () => {
  assert.match(byId[COIL_LIVE_STRATEGY_ID].description, /12% per position/);
  assert.match(byId[COIL_LIVE_STRATEGY_ID].description, /max 7 concurrent/);
});

test('paper Coil rules are untouched', () => {
  assert.equal(byId['mean-rev-rsi2'].rulesFile, 'TRADING_RULES_MEANREV.md');
});
```

If `config-store.js` does not already export an `_internals` handle exposing `defaultStrategies`, add one:

```js
// Exposed for tests only.
export const _internals = { defaultStrategies };
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test agent/config-store-strategies.test.mjs`
Expected: FAIL — live strategy not registered, rules file missing.

- [ ] **Step 3: Create the live rules file**

Create `TRADING_RULES_MEANREV_LIVE.md` by copying `TRADING_RULES_MEANREV.md` verbatim, then applying exactly these edits. Read the paper file first and preserve every section not listed here.

**Header** — add at the very top, above the existing title:

```markdown
> **LIVE — REAL MONEY.** This is the dedicated live Coil account (spec:
> `docs/superpowers/specs/2026-07-13-coil-live-funding-design.md`). Sizing and
> concurrency differ from the paper rules. A −15% high-water drawdown halt is
> enforced in Go and will refuse your entry orders regardless of what these
> rules say; it requires manual operator re-arm.
```

**Position Sizing** (paper lines 177-190) — change the 6% to 12%:

```markdown
3. Compute `position_dollars` = `portfolio_value × 0.12` (12% equal-weight per position)
```
```markdown
6. Cap `position_dollars` at 12% of `portfolio_value` (hard ceiling per position)
```

**Risk Management — Portfolio Level** (paper lines 194-208) — replace that whole section with:

```markdown
## Risk Management — Portfolio Level

**Rule:** Maximum 7 open Coil positions simultaneously
- 12% per position × 7 positions ≈ 85%, which is the total deploy ceiling below.

**Rule:** Maximum 12% of portfolio per single Coil position (hard cap, regardless of computed size)

**Rule:** Coil may deploy until **total account deployment reaches 85%** of portfolio_value
- Compute `total_deployed_pct = (portfolio_value − cash) / portfolio_value × 100` from the Beat Context account snapshot (the `Portfolio | Cash` line; fall back to `get_account`). If adding this entry's 12% would push `total_deployed_pct` above 85%, skip and log.

**Why 85%, honestly stated.** In the shared paper account this number was a
*courtesy limit*: four other agents drew on the same capital, and the ~15%
buffer was reserved for strategies that beat after Coil (Turtle/Drift at 17:00
ET). **None of that is true here.** This is a Coil-only account, so
`total_deployed_pct` *is* Coil's own deployment, and 85% is simply how long Coil
is permitted to be.

The operator has **deliberately kept 85%**, with eyes open, knowing that:
- RSI(2)<5 fires on many names at once in a broad selloff, so this rule *expands*
  capacity precisely as the market falls — Coil will add capital on each leg down.
- The bear-regime gate keys off SPY's 200-day SMA, which a fast 10% drawdown does
  not break for weeks, so it will not catch the first leg.

This max-long-into-a-selloff behavior is the **exact unsampled tail** the live
stage exists to observe. It is bounded by the $5k stage and the code-enforced
−15% halt, not by this rule. Do not "fix" this number without re-reading the spec.

**Daily Circuit Breaker:** If Coil-segment P&L ≤ −2% intraday, halt new entries for the rest of the session. Existing positions continue to be managed by the exit rules.

To check this on each heartbeat, call `get_segment_pnl()` (no args needed — strategy is auto-resolved). The response field `unrealized_pnl_percent` is the metric to compare against the −2.0 threshold.

*(Known gap, accepted for v1: this breaker resets daily, so a multi-day slide grants a fresh −2% of entry capacity each morning. The −15% halt and the $5k stage bound the dollar loss instead.)*

**Drawdown halt (enforced in Go, not by you):** once account equity falls 15%
below its high-water mark, the trade guard refuses every new entry. Exits are
unaffected — continue managing open positions normally. You cannot re-arm this;
the operator must delete the latch file.
```

**Bear Regime Behavior** (paper line 212+) — keep the section, and state that the live account runs `halt`:

```markdown
The live account runs `MEANREV_BEAR_MODE=halt`: **when SPY is below its 200-day
SMA, take no new entries at all.** Mean reversion's edge degrades in sustained
bear markets, and unlike the paper account there is no case for "keep the agent
learning" at the cost of real money. Existing positions continue to be managed.
```

Leave the −7% hard stop, 5-day time stop, and RSI(2)<5 / close>200-SMA / no-earnings-≤5d entry rules **unchanged**.

- [ ] **Step 4: Register the live strategy + fix the stale paper description**

In `agent/config-store.js`, replace the `mean-rev-rsi2` entry (lines 380-387). The paper description claimed "5% per position; max 5 concurrent" while `TRADING_RULES_MEANREV.md:183,196` says 6% and 14 — the rules file is authoritative:

```js
    {
      id: 'mean-rev-rsi2',
      name: 'Mean Reversion (Connors RSI(2))',
      description: 'RSI(2) oversold pullbacks within long-term uptrends. Curated S&P 500 large-cap universe; 6% per position; max 14 concurrent; 5-day timeout; -7% hard stop.',
      rulesFile: 'TRADING_RULES_MEANREV.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'mean-rev-rsi2-live',
      name: 'Mean Reversion RSI(2) — LIVE',
      description: 'REAL MONEY. Dedicated live Coil account. 12% per position; max 7 concurrent; 85% deploy ceiling; bear mode HALT; 5-day timeout; -7% hard stop; -15% high-water halt enforced in Go.',
      rulesFile: 'TRADING_RULES_MEANREV_LIVE.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
```

- [ ] **Step 5: Set MEANREV_BEAR_MODE per-strategy in the orchestrator**

`MEANREV_BEAR_MODE` currently reaches the bot only via the `...process.env` passthrough (`agent/orchestrator.js:181`), so it would come from the shared `.env` and apply to whichever bot happened to read it. Set it explicitly from the strategy, matching the existing `defensiveProphetEnabled` / `candidateWarmerFlags` pattern (`agent/orchestrator.js:177,194`).

Add the import at the top of `agent/orchestrator.js`:

```js
import { COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';
```

Add to the `env` object (after the `candidateWarmerFlags` spread, line 194):

```js
      // Bear-regime behavior is a per-strategy property, not a machine-wide one.
      // Live Coil halts below SPY's 200-SMA; paper Coil half-sizes. Setting it
      // explicitly stops either bot inheriting the other's mode from a shared .env.
      MEANREV_BEAR_MODE: resolvedAgent?.strategyId === COIL_LIVE_STRATEGY_ID ? 'halt' : 'halfsize',
```

- [ ] **Step 6: Run the tests**

Run: `node --test agent/config-store-strategies.test.mjs && npm test`
Expected: PASS (6 new tests + the existing suite).

- [ ] **Step 7: Commit**

```bash
git add TRADING_RULES_MEANREV_LIVE.md agent/config-store.js agent/orchestrator.js \
        agent/config-store-strategies.test.mjs
git commit -m "feat(coil-live): live rules variant (12%/name, max 7, bear=halt)

Adds TRADING_RULES_MEANREV_LIVE.md + the mean-rev-rsi2-live strategy entry.
The paper rules file is untouched.

The 85% deploy ceiling is kept at 85% but REWRITTEN, not re-numbered. Its old
rationale (a buffer reserved for Turtle/Drift, who beat after Coil) is false in
a Coil-only account, where it silently became a license to run 85% long -- and
the rule expands capacity precisely during selloffs. The rules now say so
explicitly and name it as the tail the live stage exists to sample.

Also fixes the stale paper description (claimed 5%/max-5; the rules file says
6%/max-14) so the live variant does not inherit the discrepancy, and sets
MEANREV_BEAR_MODE per-strategy in the orchestrator rather than letting it come
from a shared .env.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Funding runbook (operator actions — no live money before Tasks 1–5 are merged)

Closes spec §1 and §5. The account creation and funding are **operator actions**: they involve real credentials and real dollars, and are deliberately not automated. This task ships the runbook and the config scaffolding.

**Files:**
- Create: `docs/runbooks/coil-live-funding.md`
- Modify: `.env.example` (document the new flags)

- [ ] **Step 1: Document the new env flags**

Append to `.env.example`:

```bash
# --- Coil live account (real money). Default OFF. ---
# The ONLY code-enforced rail bounding real-money loss. Fails closed: when
# ENABLE_COIL_LIVE_HALT=true and COIL_LIVE_BASELINE_USD is unset, every entry is
# blocked. Re-arm after a trip by deleting the latch file in COIL_LIVE_STATE_DIR.
ENABLE_COIL_LIVE_HALT=false
COIL_LIVE_DRAWDOWN_PCT=0.15
COIL_LIVE_BASELINE_USD=5000
# COIL_LIVE_STATE_DIR=   # defaults to the sandbox DB directory
```

- [ ] **Step 2: Write the runbook**

Create `docs/runbooks/coil-live-funding.md`:

````markdown
# Runbook — funding live Coil

**Spec:** `docs/superpowers/specs/2026-07-13-coil-live-funding-design.md`

## Do not start until all of these are true

- [ ] Tasks 1–5 of `docs/superpowers/plans/2026-07-13-coil-live-funding.md` are merged to **local main** (the deploy source — an unpushed side branch is stranded).
- [ ] `go build ./... && go test ./... && npm test` all pass on local main.
- [ ] The Go bot has been **rebuilt** from local main. The halt lives in the Go binary; an un-rebuilt bot has no halt.

## 1. Create the live Alpaca account

Real Alpaca account, **margin, zero leverage**. Margin is for T+1 settlement
relief only — Coil rotates capital every ~4.5 days and a cash account would rack
up good-faith violations (3 in 12 months → 90-day restriction). **Coil never
borrows.** Holds are ~4.5 days, so it never day-trades and the sub-$25k PDT rule
does not bind.

## 2. Add the account in the dashboard

- Base URL **must** be `https://api.alpaca.markets` and the paper toggle **must** be off.
  As of Task 2 these can no longer disagree — `config-store` throws on a
  contradiction rather than saving an account that trades real money under a
  "paper" label. If you see `Account mode mismatch`, that guard is working.
- Credentials land in `data/accounts-secrets.json` (gitignored). **Never commit them.**

## 3. Create the sandbox

- `createSandboxForAccount()` generates a **random** `sbx_<uuid8>` id — it does
  not honor a chosen name. The readable `sbx_mean_rev` id was hand-set directly
  in `data/agent-config.json`. To get `sbx_mean_rev_live`, create the sandbox via
  the dashboard, then rename the key by hand in `data/agent-config.json` (stop
  the server first). A random id works fine — the readable one is a convenience.
- Bind it: `agent.activeAgentId: mean-rev`, and set the sandbox-level override
  `agent.overrides.strategyId: mean-rev-rsi2-live` (`config-store.js:1167` honors
  this) so the live bot loads the live rules while the `mean-rev` agent's own
  default stays on the paper strategy.
- Set on this bot only: `ENABLE_COIL_LIVE_HALT=true`, `COIL_LIVE_BASELINE_USD=5000`.
- Retire the paper `sbx_mean_rev` sandbox. It is currently flat, so shutdown
  strands nothing.

**Confirm the live rules actually loaded.** `resolveStrategyRules`
(`scripts/strategy-version.mjs:20-44`) fails OPEN on a bad `rulesFile`: a missing
or misspelled filename silently falls through to the *global* `TRADING_RULES.md`
— i.e. live Coil would run **Prophet's generic rules** with real money and no
error. Check the system prompt on the first beat contains the
`LIVE — REAL MONEY` header and the 12% sizing line.

## 4. Verify the halt is actually armed BEFORE funding

Start the bot and confirm in the log:

```
level=warning msg="Alpaca trading mode resolved" alpaca_mode="LIVE — REAL MONEY"
level=warning msg="Coil live drawdown halt ARMED" baseline_usd=5000 drawdown_pct=0.15
```

**If the halt line is absent, the halt is not running. Do not fund.**

Prove it blocks, don't assume it: touch the kill file in the state dir
(`KILL_COIL_LIVE`), confirm the next entry is refused with `coil live halt:
manual kill switch engaged`, then delete it.

## 5. Fund $5k

At 12%/name this yields ~$600 positions — the same notional the 26-trade paper
record was generated at, with half the dollars exposed and $5k held outside the
broker entirely.

Bounded worst case on the stage: ≈ −$750, ≈ −$1,200 with gap overshoot.

## 6. Stop the Merrill hand-mirror

Running the bot and the hand-mirror together takes the same signal twice with
real money — it doubles exposure and makes both books unmeasurable. Give each
open Merrill mirror position a deliberate exit decision under the existing rule:
judgment on winners, mechanics on losers; discretion never overrides a stop.

## Scale to $10k

When Coil reaches ~50 total trades **or** survives a genuine drawdown, whichever
comes first. Raise `COIL_LIVE_BASELINE_USD` to 10000 at the same time — it floors
the high-water mark.

## When the halt trips

1. The latch file `coil_live_halt.json` appears in the state dir. New entries are
   refused; **open positions keep being managed and exited** — this is by design.
2. Do a post-mortem before re-arming. The halt firing is the tail the stage
   exists to observe; it is data, not just an incident.
3. Re-arm by deleting the latch file. There is no programmatic re-arm, on purpose.

## What success is

**Not "it made money."** In this regime it is *expected* to make money. Success is:
the live trade ledger shows positive expectancy on its own (long-term holds
excluded), the stuck-exit path is proven to work, and the drawdown behavior is
finally *observed* rather than assumed.
````

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/coil-live-funding.md .env.example
git commit -m "docs(coil-live): funding runbook + env flags

Account creation and funding are deliberately operator actions, not automation.
The runbook gates funding on the halt being observably ARMED in the log and on a
proof that it blocks -- not on the assumption that it does.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Deferred — explicitly NOT in this plan

Named so they are not mistaken for oversights.

- **Stuck-exit / failed-close reconciliation (spec §4). ⚠️ The spec overstates the
  prior art — read this before relying on it.** `agent/trade-reconciliation.js`
  runs per-sandbox and the live sandbox will get its own `data/reconciliation/`
  directory automatically with zero wiring. **But it covers OPENS ONLY.** Its own
  `SCOPE_NOTE` (`agent/trade-reconciliation.js:135`), stamped on every report,
  says verbatim:

  > "Covers order placements (opens/adds). Does NOT verify closes/exits or live
  > position state — a logged-success close that did not execute will not be
  > caught here."

  A logged-success close that never executed is *exactly* the stuck-exit failure
  the spec calls "the operator's primary objection to Alpaca, and the one risk
  that is actually engineerable." **The existing reconciliation does not detect
  it.** Spec §4 assumes this is covered prior art; it is not.

  Not a $5k funding blocker — the −7% broker-side stop bounds any single stuck
  position, which is what makes the stage survivable. It **is** a blocker for
  scaling to $10k, and it is a real piece of new work (extend reconciliation to
  compare bot-side closes against broker position state). Track as the top
  follow-up; do not let the existing green reconciliation reports create false
  comfort that exits are verified. They verify entries.
- **Foundation B data clock (spec §4).** The measurement layer is built; its clock
  needs the Go rebuild, which Task 6 requires anyway — so live Coil is graded from
  trade one with no extra work here.
- **Rolling 5-day circuit breaker (spec §3).** Deliberately deferred to v2 by the
  spec; it is the rail most likely to misfire.
- **A halt status HTTP endpoint.** `CoilLiveHaltGuard.Status()` is written and
  tested but not exposed over HTTP. Wire it to a controller when the dashboard
  needs it, following `controllers.NewSleeveController`.
````
