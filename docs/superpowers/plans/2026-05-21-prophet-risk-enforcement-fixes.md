# Prophet Risk-Enforcement Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the risk-control gaps from the 2026-05-21 fresh-eyes review: route Prophet's options orders through the TradeGuard, add hard per-position/deployed caps, make the daily-loss breaker fail-closed, fix agent attribution + N-way overlap, fix the heartbeat weekend boundary hole, and reconcile the docs.

**Architecture:** Two layers. (1) MCP layer (`mcp-server.js`) enforces a per-order dollar cap — extracted into a pure, testable module. (2) Go `TradeGuard` enforces cross-agent + portfolio caps; the options order path is wired through it for the first time. Node harness gets a pure phase-boundary helper. All flag-gated, all TDD.

**Tech Stack:** Go (services/controllers, `go test`), Node ESM (`agent/`, `mcp-server.js`, `node --test`).

**Spec:** `docs/superpowers/specs/2026-05-21-prophet-risk-enforcement-fixes-design.md`

**Task order & dependencies:** 1(E) and 2(A) are independent. 3 (`AgentForStrategy`) precedes 4 (N-way needs the constants), 8 (attribution wiring), and 9 (options routing). 6 (caps) precedes 7 (alloc test needs caps) and 9. 7 (alloc-from-limit-price) precedes 8 (attribution test relies on it). 9–10 precede 11 (integration). Each task ends green before the next starts.

---

## Task 0: Create the working branch

- [ ] **Step 1: Branch off main**

Run:
```bash
git checkout main && git pull --ff-only && git checkout -b prophet-risk-enforcement
```
Expected: on a new branch `prophet-risk-enforcement`. If `main` can't fast-forward, branch off current HEAD and note it in the PR.

---

## Task 1 (Fix E): Heartbeat phase-boundary weekend hole

**Files:**
- Modify: `agent/harness.js` (add exported `secondsToNextPhaseBoundary`; `_getSecondsToNextPhaseBoundary` delegates)
- Test: `agent/harness.test.mjs`

The current method returns `null` on weekends and after the last weekday boundary, so a late-Sunday closed beat sleeps a full 8h and overshoots Monday 04:00 pre-market. Fix: a pure function with an 8-day weekend-skipping lookahead to the next trading day's first boundary (04:00 ET = 240 min), mirroring `_getSecondsToNextScheduledBeat`.

- [ ] **Step 1: Write the failing tests**

Add to `agent/harness.test.mjs`:
```javascript
import { secondsToNextPhaseBoundary } from './harness.js';

// Boundaries are phase starts in ET minutes: 240(04:00) 570(09:30) 630(10:30) 900(15:00) 960(16:00).
// America/New_York is UTC-4 in May (EDT): 13:00Z = 09:00 ET. Use mid-May 2026 (no DST edge).

test('weekday before a later boundary returns seconds to that boundary', () => {
  // Thu 2026-05-21 13:00Z = 09:00 ET (540 min). Next boundary 09:30 (570) = 30 min.
  assert.equal(secondsToNextPhaseBoundary(new Date('2026-05-21T13:00:00Z')), 30 * 60);
});

test('weekday after the last boundary looks ahead to next day 04:00', () => {
  // Thu 2026-05-21 21:00Z = 17:00 ET, past the 16:00 last boundary.
  // Next boundary = Fri 04:00 ET: 7h to midnight + 4h = 11h.
  assert.equal(secondsToNextPhaseBoundary(new Date('2026-05-21T21:00:00Z')), 11 * 3600);
});

test('weekend looks ahead to Monday 04:00 (never returns null)', () => {
  // Sun 2026-05-24 23:00Z = 19:00 ET Sunday. Next boundary = Mon 04:00 ET = 9h.
  assert.equal(secondsToNextPhaseBoundary(new Date('2026-05-24T23:00:00Z')), 9 * 3600);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/harness.test.mjs`
Expected: FAIL — `secondsToNextPhaseBoundary` is not exported.

- [ ] **Step 3: Implement the pure helper and delegate**

In `agent/harness.js`, add this exported function just after `getCurrentPhase` (after line 42):
```javascript
// secondsToNextPhaseBoundary returns the seconds from `now` until the next
// phase-start boundary, looking ahead across weekends to the next trading day's
// first boundary (04:00 ET = 240 min) when none remain today. Always positive
// on/after a trading week — never null — so _scheduleNext can snap the agent
// awake at the next session's open. Mirrors the 8-day ET lookahead in
// _getSecondsToNextScheduledBeat. Pure (takes `now`) for testability, like
// outOfTrendWindow/isClosedPhase in preflight.js.
export function secondsToNextPhaseBoundary(now) {
  const dayName = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  const dayMap = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
  const nowDow = dayMap[dayName] || 1;
  const etStr = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const [h, m, s] = etStr.split(':').map(Number);
  const nowSecs = h * 3600 + m * 60 + s;

  const boundaries = Object.values(PHASE_DEFAULTS)
    .filter(cfg => cfg.range)
    .map(cfg => cfg.range[0] * 60)
    .sort((a, b) => a - b);

  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const dow = ((nowDow - 1 + dayOffset) % 7) + 1; // 1=Mon..7=Sun
    if (dow === 6 || dow === 7) continue;            // skip weekends — no boundaries
    for (const bSecs of boundaries) {
      const offset = dayOffset * 86400 + bSecs - nowSecs;
      if (offset > 0) return offset;
    }
  }
  return null; // unreachable within an 8-day window
}
```
Then replace the body of `_getSecondsToNextPhaseBoundary()` (lines 639-657) with:
```javascript
  _getSecondsToNextPhaseBoundary() {
    return secondsToNextPhaseBoundary(new Date());
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test agent/harness.test.mjs`
Expected: PASS (3 new + all existing).

- [ ] **Step 5: Commit**

```bash
git add agent/harness.js agent/harness.test.mjs
git commit -m "$(cat <<'EOF'
Fix heartbeat boundary hole that skipped next-session open

_getSecondsToNextPhaseBoundary returned null on weekends and after the
last weekday boundary, so a late-Sunday closed beat slept a full 8h and
could overshoot Monday 04:00 pre-market. Extract a pure
secondsToNextPhaseBoundary(now) with an 8-day weekend-skipping lookahead;
the existing < seconds clamp still ensures it only shortens the sleep.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 (Fix A): maxOrderValue options 100x multiplier (MCP layer)

**Files:**
- Create: `mcp-order-value.js`, `mcp-order-value.test.mjs`
- Modify: `mcp-server.js` (`enforcePermissions`, ~line 1582)

`mcp-server.js` calls `main()` at import (connects a stdio transport), so it can't be imported in a test — extract the order-value computation into a pure module. The bug: options `limit_price` is per contract; real outlay is ×100.

- [ ] **Step 1: Write the failing tests**

Create `mcp-order-value.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderValue } from './mcp-order-value.js';

test('stock buy: limit_price x qty, no multiplier', () => {
  assert.equal(computeOrderValue('place_buy_order', { limit_price: 50, qty: 10 }), 500);
});
test('options order: limit_price x qty x 100', () => {
  assert.equal(computeOrderValue('place_options_order', { limit_price: 6, quantity: 30 }), 18000);
});
test('allocation_dollars wins when provided', () => {
  assert.equal(computeOrderValue('place_managed_position', { allocation_dollars: 1500, limit_price: 1, qty: 1 }), 1500);
});
test('market options order with no price computes 0 (Go layer blocks)', () => {
  assert.equal(computeOrderValue('place_options_order', { quantity: 5 }), 0);
});
test('condor tools are NOT given the single-leg x100', () => {
  assert.equal(computeOrderValue('open_iron_condor', { limit_price: 2, quantity: 3 }), 6);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test mcp-order-value.test.mjs`
Expected: FAIL — cannot find module `./mcp-order-value.js`.

- [ ] **Step 3: Implement the pure module**

Create `mcp-order-value.js`:
```javascript
// computeOrderValue returns the dollar value used for the maxOrderValue cap.
// Extracted from mcp-server.js enforcePermissions so it can be unit-tested
// (mcp-server.js self-runs main() on import). Options single-leg orders carry a
// per-contract limit_price; real cash outlay is ×100 (OCC multiplier). Iron
// condors are excluded — they are credit spreads with their own sizing.
const OPTIONS_SINGLE_LEG_TOOLS = new Set(['place_options_order']);

export function computeOrderValue(toolName, args = {}) {
  const allocValue = args.allocation_dollars || 0;
  if (allocValue > 0) return allocValue;
  const price = args.limit_price || args.entry_price || 0;
  const qty = args.quantity || args.qty || 0;
  let value = price * qty;
  if (OPTIONS_SINGLE_LEG_TOOLS.has(toolName)) value *= 100;
  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test mcp-order-value.test.mjs`
Expected: PASS (5/5).

- [ ] **Step 5: Wire it into enforcePermissions**

In `mcp-server.js`, add near the top imports:
```javascript
import { computeOrderValue } from './mcp-order-value.js';
```
Replace the `Max order value` block (~lines 1582-1589):
```javascript
    // Max order value
    if (perms.maxOrderValue > 0) {
      const orderValue = (args.limit_price || args.entry_price || 0) * (args.quantity || args.qty || 0);
      const allocValue = args.allocation_dollars || 0;
      const checkValue = allocValue || orderValue;
      if (checkValue > perms.maxOrderValue) {
        throw new Error(`Order value $${checkValue.toFixed(2)} exceeds max allowed $${perms.maxOrderValue}. Reduce size or change permissions.`);
      }
    }
```
with:
```javascript
    // Max order value (options single-leg orders are ×100 for the contract multiplier)
    if (perms.maxOrderValue > 0) {
      const checkValue = computeOrderValue(toolName, args);
      if (checkValue > perms.maxOrderValue) {
        throw new Error(`Order value $${checkValue.toFixed(2)} exceeds max allowed $${perms.maxOrderValue}. Reduce size or change permissions.`);
      }
    }
```

- [ ] **Step 6: Verify and commit**

Run: `node --test mcp-order-value.test.mjs && node --check mcp-server.js`
Expected: tests PASS; no syntax errors.
```bash
git add mcp-order-value.js mcp-order-value.test.mjs mcp-server.js
git commit -m "$(cat <<'EOF'
Fix maxOrderValue ignoring the options 100x contract multiplier

place_options_order limit_price is per contract; the cap compared raw
price*qty, so a 30-lot at $6 read as $180 not $18,000 and passed any cap.
Extract computeOrderValue into a pure testable module and apply x100 to
single-leg options only; iron-condor tools keep their own sizing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 (Fix D.1): Agent constants + AgentForStrategy mapping

**Files:**
- Modify: `services/trade_guard.go` (constants ~line 15; add `AgentForStrategy`)
- Test: `services/trade_guard_test.go`

- [ ] **Step 1: Write the failing test**

Add to `services/trade_guard_test.go`:
```go
func TestAgentForStrategy(t *testing.T) {
	cases := map[string]AgentSource{
		"v2-options": AgentMain, "penny-momentum": AgentPenny, "harvest": AgentHarvest,
		"trend": AgentTrend, "mean-rev-rsi2": AgentMeanRev, "earnings-drift": AgentDrift,
		"": AgentMain, "unknown-xyz": AgentMain,
	}
	for strat, want := range cases {
		if got := AgentForStrategy(strat); got != want {
			t.Errorf("AgentForStrategy(%q) = %q, want %q", strat, got, want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestAgentForStrategy -v`
Expected: FAIL — `AgentTrend`/`AgentMeanRev`/`AgentDrift`/`AgentForStrategy` undefined.

- [ ] **Step 3: Add constants and mapping**

In `services/trade_guard.go`, extend the const block (lines 15-19):
```go
const (
	AgentMain    AgentSource = "main"
	AgentPenny   AgentSource = "penny"
	AgentHarvest AgentSource = "harvest"
	AgentTrend   AgentSource = "trend"
	AgentMeanRev AgentSource = "meanrev"
	AgentDrift   AgentSource = "drift"
)

// AgentForStrategy maps a strategyId (the OPENPROPHET_STRATEGY tag every order
// path forwards) to its guard AgentSource. This is the production attribution
// channel: agent_source is never sent by the MCP/harness, so deriving from the
// strategy tag is what makes per-agent caps and cross-agent overlap identify the
// right agent. Unknown/empty → main (legacy default).
func AgentForStrategy(strategyId string) AgentSource {
	switch strategyId {
	case "penny-momentum":
		return AgentPenny
	case "harvest":
		return AgentHarvest
	case "trend":
		return AgentTrend
	case "mean-rev-rsi2":
		return AgentMeanRev
	case "earnings-drift":
		return AgentDrift
	default:
		return AgentMain
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestAgentForStrategy -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/trade_guard.go services/trade_guard_test.go
git commit -m "$(cat <<'EOF'
Add trend/meanrev/drift agents and AgentForStrategy mapping

The guard modeled only main/penny/harvest. Add the missing agents and
AgentForStrategy, which derives the guard agent from the strategy tag the
order paths already forward (agent_source is never sent by the MCP).
Prereq for N-way overlap and options-path attribution.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 (Fix D.2): N-way symbol-overlap check

**Files:**
- Modify: `services/trade_guard.go` (`CheckBuy`/`CheckSell` use N-way; remove `opponentOf`)
- Test: `services/trade_guard_test.go`

- [ ] **Step 1: Write the failing test**

Add to `services/trade_guard_test.go` (reuse the existing `managedPos` helper and `stubLister`):
```go
func TestGuard_NWayOverlap_BlocksAnyOtherAgent(t *testing.T) {
	// A trend-tagged position on TLT must block a main buy of TLT — the old
	// binary opponentOf (main<->penny only) would have allowed it.
	lister := &stubLister{positions: []*ManagedPosition{
		managedPos("TLT", AgentTrend, "ACTIVE", 1000),
	}}
	g := NewTradeGuard(lister, &stubTrading{portfolio: 100000}, defaultConfig())
	if err := g.CheckBuy(context.Background(), AgentMain, "TLT", 0); err == nil {
		t.Fatal("expected main buy of TLT blocked by trend's holding")
	}
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 0); err != nil {
		t.Fatalf("unrelated symbol should pass: %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestGuard_NWayOverlap -v`
Expected: FAIL — main buy of TLT allowed (binary `opponentOf` checks only penny).

- [ ] **Step 3: Replace binary opponent logic with N-way**

In `services/trade_guard.go`, add near `agentOwnsSymbol`:
```go
// heldByAnyOtherAgent returns the first agent != self that owns the symbol, or
// "" if none. Replaces binary opponentOf so all six strategies are checked.
// Exact-symbol-string match (OCC option symbols never collide with tickers).
func (g *TradeGuard) heldByAnyOtherAgent(self AgentSource, symbol string) AgentSource {
	for _, other := range []AgentSource{AgentMain, AgentPenny, AgentHarvest, AgentTrend, AgentMeanRev, AgentDrift} {
		if other == self {
			continue
		}
		if g.agentOwnsSymbol(other, symbol) {
			return other
		}
	}
	return ""
}
```
In `CheckBuy`, replace the opponent block (line 218 `opponent := g.opponentOf(agent)` and lines 245-247):
```go
	if owner := g.heldByAnyOtherAgent(agent, symbol); owner != "" {
		return fmt.Errorf("guard: %s agent holds %s — %s agent cannot open a position in the same symbol", owner, symbol, agent)
	}
```
(Delete the now-unused `opponent := g.opponentOf(agent)` line in CheckBuy.)
In `CheckSell`, replace its opponent block (lines 276-282):
```go
	if owner := g.heldByAnyOtherAgent(agent, symbol); owner != "" {
		return fmt.Errorf("guard: %s agent holds %s — %s agent cannot sell it", owner, symbol, agent)
	}
```
Delete the unused `opponentOf` method (lines 565-570).

- [ ] **Step 4: Run the full guard suite**

Run: `go test ./services/ -run TestGuard -v`
Expected: PASS — new test passes; existing main↔penny overlap tests still pass (penny is iterated).

- [ ] **Step 5: Commit**

```bash
git add services/trade_guard.go services/trade_guard_test.go
git commit -m "$(cat <<'EOF'
Make cross-agent symbol-overlap N-way instead of binary

opponentOf only checked main<->penny, so trend/meanrev/drift/harvest
holdings did not block other agents. Replace with heldByAnyOtherAgent
over all six agents. Exact-string match, so OCC option symbols never
collide with tickers (cross-instrument overlap is a documented non-goal).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 (Fix C): Daily-loss breaker fail-closed

**Files:**
- Modify: `services/trade_guard.go` (`CheckBuy` ~line 240, `checkDailyLoss` ~line 421)
- Test: `services/trade_guard_test.go`

`stubTrading` already has a `getAcctErr error` field and `GetAccount` returns it. The test file imports `errors`.

- [ ] **Step 1: Write the failing tests**

Add to `services/trade_guard_test.go`:
```go
func TestGuard_DailyLoss_FailsClosedOnFetchError(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5
	g := NewTradeGuard(&stubLister{}, &stubTrading{getAcctErr: errors.New("alpaca 503")}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 0); err == nil {
		t.Fatal("expected buy blocked when account fetch errors (fail closed)")
	}
}

func TestGuard_DailyLoss_NilTradingServiceAllows(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5
	g := NewTradeGuard(&stubLister{}, nil, cfg) // no account context
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 0); err != nil {
		t.Fatalf("nil trading service should fail open: %v", err)
	}
}

func TestGuard_DailyLoss_RecoversAfterTransientError(t *testing.T) {
	cfg := defaultConfig()
	cfg.MaxDailyLossPct = 5
	stub := &stubTrading{portfolio: 100000, lastEquity: 100000, getAcctErr: errors.New("503")}
	g := NewTradeGuard(&stubLister{}, stub, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 0); err == nil {
		t.Fatal("first call should block on error")
	}
	stub.getAcctErr = nil // API recovers
	if err := g.CheckBuy(context.Background(), AgentMain, "AAPL", 0); err != nil {
		t.Fatalf("second call should allow once API recovers (no latch): %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./services/ -run TestGuard_DailyLoss -v`
Expected: FAIL — fetch error currently no-ops (first test allows the buy).

- [ ] **Step 3: Thread the fetch error and fail closed**

In `services/trade_guard.go` `CheckBuy`, replace (lines 240-243):
```go
	dailyAcct, _ := getAcct()
	if err := g.checkDailyLoss(dailyAcct); err != nil {
		return err
	}
```
with:
```go
	dailyAcct, dailyErr := getAcct()
	if err := g.checkDailyLoss(dailyAcct, dailyErr); err != nil {
		return err
	}
```
Replace `checkDailyLoss` (lines 421-436) with:
```go
// checkDailyLoss blocks new buys when intraday equity is down beyond
// MaxDailyLossPct. Fail policy:
//   - disabled when MaxDailyLossPct <= 0.
//   - acctErr != nil → fail CLOSED (cannot read live equity; don't open new risk
//     while blind to P&L). Per-CheckBuy, no latch — self-recovers when the API
//     recovers. Mirrors checkPennyCapCap.
//   - acct == nil with no error (nil trading service / tests) → fail open.
//   - LastEquity/PortfolioValue <= 0 (new account) → fail open.
func (g *TradeGuard) checkDailyLoss(acct *interfaces.Account, acctErr error) error {
	if g.cfg.MaxDailyLossPct <= 0 {
		return nil
	}
	if acctErr != nil {
		g.logger.WithFields(logrus.Fields{
			"daily_loss_check_unavailable": true,
			"operator_review_required":     true,
		}).Warn("daily-loss breaker: account fetch failed — blocking new buys (fail closed)")
		return fmt.Errorf("guard: daily loss breaker — account unavailable, blocking new entries: %w", acctErr)
	}
	if acct == nil {
		return nil
	}
	if acct.LastEquity <= 0 || acct.PortfolioValue <= 0 {
		return nil
	}
	lossPct := (acct.LastEquity - acct.PortfolioValue) / acct.LastEquity * 100
	if lossPct >= g.cfg.MaxDailyLossPct {
		return fmt.Errorf(
			"guard: daily loss circuit breaker — down %.2f%% from previous close ($%.2f → $%.2f), exceeds %.2f%% limit",
			lossPct, acct.LastEquity, acct.PortfolioValue, g.cfg.MaxDailyLossPct,
		)
	}
	return nil
}
```
(`logrus` is already imported in this file.)

- [ ] **Step 4: Run the full guard suite**

Run: `go test ./services/ -run TestGuard -v`
Expected: PASS — new daily-loss tests pass; existing daily-loss tests (which pass an account, not an error) still pass.

- [ ] **Step 5: Commit**

```bash
git add services/trade_guard.go services/trade_guard_test.go
git commit -m "$(cat <<'EOF'
Make daily-loss breaker fail closed on account-fetch error

CheckBuy discarded the GetAccount error and checkDailyLoss(nil) no-oped,
so a flaky account API silently disabled the breaker while the penny cap
failed closed on the same error. Thread the error through and block new
buys when equity can't be read (per-CheckBuy, no latch). Logs an
operator-visible warning.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6 (Fix B.1): Position-cap config fields + checkPositionCaps

**Files:**
- Modify: `services/trade_guard.go` (`TradeGuardConfig`, `CheckBuy`, add `checkPositionCaps`)
- Modify: `services/trade_guard_test.go` (add `cash` to `stubTrading`)
- Test: `services/trade_guard_test.go`

- [ ] **Step 1: Extend the stub for portfolio cash**

In `services/trade_guard_test.go`, add a `cash` field to `stubTrading` (lines 29-34) and return it in `GetAccount`:
```go
type stubTrading struct {
	portfolio    float64
	cash         float64
	lastEquity   float64
	getAcctCalls int
	getAcctErr   error
}
```
In `GetAccount` (line 41), include Cash:
```go
	return &interfaces.Account{PortfolioValue: s.portfolio, Cash: s.cash, LastEquity: s.lastEquity}, nil
```

- [ ] **Step 2: Write the failing tests**

Add to `services/trade_guard_test.go`:
```go
func capCfg() TradeGuardConfig {
	c := defaultConfig()
	c.EnablePositionCaps = true
	c.MaxPositionPct = 0.12
	c.MaxDeployedPct = 0.50
	return c
}

func TestGuard_PositionCap_BlocksOversizedTrade(t *testing.T) {
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000, cash: 100000}, capCfg())
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 13000); err == nil {
		t.Fatal("expected per-position cap to block $13k on $100k portfolio")
	}
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 11000); err != nil {
		t.Fatalf("$11k under 12%% cap should pass: %v", err)
	}
}

func TestGuard_DeployedCap_ProjectsPostTrade(t *testing.T) {
	// 49% deployed (cash 51k of 100k); a $5k order projects to 54% > 50%.
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000, cash: 51000}, capCfg())
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 5000); err == nil {
		t.Fatal("expected projected-deployed cap to block (49%+5% > 50%)")
	}
}

func TestGuard_PositionCaps_FailClosedOnIndeterminateNotional(t *testing.T) {
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000, cash: 100000}, capCfg())
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 0); err == nil {
		t.Fatal("expected fail-closed when caps enabled and notional indeterminate")
	}
}

func TestGuard_PositionCaps_DisabledIsNoop(t *testing.T) {
	cfg := capCfg()
	cfg.EnablePositionCaps = false
	g := NewTradeGuard(&stubLister{}, &stubTrading{portfolio: 100000, cash: 100000}, cfg)
	if err := g.CheckBuy(context.Background(), AgentMain, "SPY", 0); err != nil {
		t.Fatalf("caps disabled → notional 0 must not block: %v", err)
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./services/ -run 'TestGuard_PositionCap|TestGuard_DeployedCap' -v`
Expected: FAIL — config fields / `checkPositionCaps` don't exist (compile error first).

- [ ] **Step 4: Add config fields**

In `services/trade_guard.go` `TradeGuardConfig`, add:
```go
	// EnablePositionCaps flag-gates the per-position and deployed caps below.
	EnablePositionCaps bool `json:"enable_position_caps"`
	// MaxPositionPct caps a single new trade's notional as a fraction of
	// portfolio value (0.12 = 12%). Zero disables.
	MaxPositionPct float64 `json:"max_position_pct"`
	// MaxDeployedPct caps whole-account deployment after the trade:
	// (PortfolioValue - Cash + notional) / PortfolioValue. Zero disables.
	MaxDeployedPct float64 `json:"max_deployed_pct"`
```

- [ ] **Step 5: Add the check and call it from CheckBuy**

Add to `services/trade_guard.go`:
```go
// checkPositionCaps enforces the per-position and projected-deployed caps.
// Fail policy: acctErr → fail closed; no account context (acct==nil /
// PortfolioValue<=0) → fail open; caps enabled but notional<=0 (size
// indeterminate, e.g. an unpriceable market options order) → fail closed.
func (g *TradeGuard) checkPositionCaps(acct *interfaces.Account, acctErr error, notional float64) error {
	if acctErr != nil {
		return fmt.Errorf("guard: failed to fetch account for position cap check: %w", acctErr)
	}
	if acct == nil || acct.PortfolioValue <= 0 {
		return nil
	}
	if notional <= 0 {
		g.logger.WithField("guard_notional_indeterminate", true).
			Warn("position caps enabled but order notional indeterminate — blocking (fail closed)")
		return fmt.Errorf("guard: position caps enabled but order notional could not be determined")
	}
	if g.cfg.MaxPositionPct > 0 {
		maxPos := acct.PortfolioValue * g.cfg.MaxPositionPct
		if notional > maxPos {
			return fmt.Errorf("guard: position cap — $%.2f exceeds %.0f%% per-position cap ($%.2f of $%.2f)",
				notional, g.cfg.MaxPositionPct*100, maxPos, acct.PortfolioValue)
		}
	}
	if g.cfg.MaxDeployedPct > 0 {
		projected := (acct.PortfolioValue - acct.Cash + notional) / acct.PortfolioValue
		if projected > g.cfg.MaxDeployedPct {
			return fmt.Errorf("guard: deployed cap — projected %.1f%% exceeds %.0f%% deployed cap ($%.2f cash of $%.2f)",
				projected*100, g.cfg.MaxDeployedPct*100, acct.Cash, acct.PortfolioValue)
		}
	}
	return nil
}
```
In `CheckBuy`, after the sector-cap block (after line 254) and before the penny block (`if agent == AgentPenny`), add:
```go
	if g.cfg.EnablePositionCaps {
		capAcct, capErr := getAcct()
		if err := g.checkPositionCaps(capAcct, capErr, allocationDollars); err != nil {
			return err
		}
	}
```

- [ ] **Step 6: Run tests + full guard suite**

Run: `go test ./services/ -run TestGuard -v`
Expected: PASS (new cap tests + all existing).

- [ ] **Step 7: Commit**

```bash
git add services/trade_guard.go services/trade_guard_test.go
git commit -m "$(cat <<'EOF'
Add hard per-position and projected-deployed caps to the guard

Flag-gated (EnablePositionCaps) per-position % and whole-account deployed
% caps. Deployed gate is projected (current + notional) so one large lot
can't overshoot. Fail closed on indeterminate notional; fail open with no
account context.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7 (Fix B.2): Compute allocationDollars for all agents in Buy

**Files:**
- Modify: `controllers/order_controller.go` (`Buy`, lines 92-107)
- Modify: `controllers/order_controller_test.go` (extend `recordingTradingService` with an account)
- Test: `controllers/order_controller_test.go`

Today `allocationDollars` is computed only for penny, so the caps/sector cap can never fire on a non-penny stock buy.

- [ ] **Step 1: Extend the recording stub with an account**

First, ensure the test file imports the services package — the new tests reference `services.NewTradeGuard`, `services.TradeGuardConfig`, `services.AgentForStrategy`, and `services.ManagedPosition`. Add to the import block (it currently imports only `prophet-trader/interfaces`):
```go
	"prophet-trader/services"
```

In `controllers/order_controller_test.go`, add fields to `recordingTradingService` (lines 20-23):
```go
type recordingTradingService struct {
	mu                  sync.Mutex
	recordedOrders      []*interfaces.Order
	portfolio           float64
	cash                float64
	optionsOrdersPlaced int
}
```
Replace its `GetAccount` (lines 43-45) so caps have a real account:
```go
func (r *recordingTradingService) GetAccount(_ context.Context) (*interfaces.Account, error) {
	return &interfaces.Account{PortfolioValue: r.portfolio, Cash: r.cash, LastEquity: r.portfolio}, nil
}
```

- [ ] **Step 2: Write the failing test**

Add to `controllers/order_controller_test.go`:
```go
func TestBuy_ComputesAllocationForAllAgents(t *testing.T) {
	rec := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		EnablePositionCaps: true, MaxPositionPct: 0.12, MaxDeployedPct: 0.50,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	lp := 100.0
	// 200 * $100 = $20k > 12% of $100k — must block a MAIN (non-penny) buy.
	_, err := oc.Buy(context.Background(), BuyRequest{
		Symbol: "AAPL", Qty: 200, Type: "limit", LimitPrice: &lp, Strategy: "v2-options",
	})
	if err == nil {
		t.Fatal("expected per-position cap to block a $20k main stock buy")
	}
}
```
This needs a `positionLister` for the guard. Add a minimal one to the test file if not present:
```go
type stubGuardLister struct{}

func (stubGuardLister) ListManagedPositions(_ string) []*services.ManagedPosition { return nil }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./controllers/ -run TestBuy_ComputesAllocationForAllAgents -v`
Expected: FAIL — `allocationDollars` stays 0 for main, cap not applied, no error.

- [ ] **Step 4: Compute allocation for every agent**

In `controllers/order_controller.go` `Buy`, replace the guard block (lines 92-107):
```go
	if oc.guard != nil {
		allocationDollars := 0.0
		if agent == services.AgentPenny {
			if quote, err := oc.dataService.GetLatestQuote(ctx, req.Symbol); err == nil {
				price := quote.AskPrice
				if price <= 0 {
					price = quote.BidPrice
				}
				allocationDollars = price * req.Qty
			}
		}
		if err := oc.guard.CheckBuy(ctx, agent, req.Symbol, allocationDollars); err != nil {
			oc.logger.WithError(err).Warn("Buy order blocked by trade guard")
			return nil, err
		}
	}
```
with:
```go
	if oc.guard != nil {
		// Compute notional for every agent so the per-position/deployed/sector
		// caps can apply. Prefer the order's limit price; else a quote. Zero when
		// neither is available — the guard's fail policy then governs.
		allocationDollars := 0.0
		if req.LimitPrice != nil && *req.LimitPrice > 0 {
			allocationDollars = *req.LimitPrice * req.Qty
		} else if oc.dataService != nil {
			if quote, err := oc.dataService.GetLatestQuote(ctx, req.Symbol); err == nil {
				price := quote.AskPrice
				if price <= 0 {
					price = quote.BidPrice
				}
				allocationDollars = price * req.Qty
			}
		}
		if err := oc.guard.CheckBuy(ctx, agent, req.Symbol, allocationDollars); err != nil {
			oc.logger.WithError(err).Warn("Buy order blocked by trade guard")
			return nil, err
		}
	}
```

- [ ] **Step 5: Run tests to verify pass + no regressions**

Run: `go test ./controllers/ -run TestBuy -v`
Expected: PASS — new test passes; existing Buy tests pass.

- [ ] **Step 6: Commit**

```bash
git add controllers/order_controller.go controllers/order_controller_test.go
git commit -m "$(cat <<'EOF'
Compute order notional for all agents in Buy, not just penny

The per-position/deployed/sector caps could never fire on a non-penny
stock buy because allocationDollars was only computed for penny. Compute
it from the limit price or a quote for every agent.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8 (Fix D.3): Derive agent from strategy in the order paths

**Files:**
- Modify: `controllers/order_controller.go` (`Buy` lines 86-89, `Sell` lines 159-162)
- Modify: `services/position_manager.go` (`PlaceManagedPosition`, lines 173-177)
- Modify: `services/turtle_executor.go:479`
- Test: `controllers/order_controller_test.go`

- [ ] **Step 1: Write the failing test (reproduces production gap #2)**

Add to `controllers/order_controller_test.go`:
```go
func TestBuy_AttributesByStrategyTagNotAgentSource(t *testing.T) {
	// Production sends strategy="penny-momentum" and NO agent_source. The guard
	// must see AgentPenny so the $500 penny per-position cap applies.
	rec := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		PennyMaxPositionDollars: 500, PennyMaxCapitalPct: 0.20,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	lp := 1.0
	// $1 * 600 = $600 > $500 penny per-position cap — only blocks if attributed to penny.
	_, err := oc.Buy(context.Background(), BuyRequest{
		Symbol: "ABCD", Qty: 600, Type: "limit", LimitPrice: &lp, Strategy: "penny-momentum",
	})
	if err == nil {
		t.Fatal("expected penny per-position cap to block a $600 buy attributed via strategy tag")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./controllers/ -run TestBuy_AttributesByStrategyTag -v`
Expected: FAIL — order attributes to `AgentMain` (default), penny cap never applies.

- [ ] **Step 3: Derive agent from strategy in Buy and Sell**

In `controllers/order_controller.go` `Buy`, replace (lines 86-89):
```go
	agent := req.AgentSource
	if agent == "" {
		agent = services.AgentMain
	}
```
with:
```go
	// Attribution: explicit AgentSource overrides; else derive from the strategy
	// tag the MCP forwards (agent_source is never sent in production).
	agent := req.AgentSource
	if agent == "" {
		agent = services.AgentForStrategy(req.Strategy)
	}
```
Apply the identical replacement in `Sell` (lines 159-162).

- [ ] **Step 4: Derive agent from strategy in PlaceManagedPosition**

In `services/position_manager.go`, replace (lines 173-177):
```go
	// Resolve agent source
	agent := req.AgentSource
	if agent == "" {
		agent = AgentMain
	}
```
with:
```go
	// Resolve agent source: explicit override wins; else derive from the agent
	// strategy tag (agent_source is not sent by the MCP in production).
	agent := req.AgentSource
	if agent == "" {
		agent = AgentForStrategy(req.AgentStrategy)
	}
```

- [ ] **Step 5: Fix turtle attribution**

In `services/turtle_executor.go:479`, change `AgentMain` to `AgentTrend`:
```go
			if err := e.guard.CheckBuy(ctx, AgentTrend, ticker, dollars); err != nil {
```

- [ ] **Step 6: Run affected suites**

Run: `go test ./controllers/ ./services/ -run 'TestBuy_AttributesByStrategyTag|TestGuard|Turtle|ManagedPosition' -v`
Expected: PASS — new attribution test passes; existing guard/turtle/managed-position tests pass.

- [ ] **Step 7: Commit**

```bash
git add controllers/order_controller.go services/position_manager.go services/turtle_executor.go controllers/order_controller_test.go
git commit -m "$(cat <<'EOF'
Derive guard agent from strategy tag (fix production attribution)

agent_source is never sent by the MCP/harness, so every order defaulted
to AgentMain and per-agent caps/overlap were keyed off an unset field.
Derive the agent from the strategy tag (AgentForStrategy) in Buy, Sell,
and PlaceManagedPosition; keep explicit AgentSource as an override. Fix
turtle to attribute as AgentTrend.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9 (Fix B.3): Route options orders through the guard

**Files:**
- Modify: `controllers/order_controller.go` (`PlaceOptionsOrder`, lines 491-557; add helpers)
- Modify: `controllers/order_controller_test.go` (count options placements)
- Test: `controllers/order_controller_test.go`

Gate options orders through the guard with ×100 notional and ownership recording, on **opening** intent only so closes are never blocked.

- [ ] **Step 1: Extend the stub to count options placements**

In `controllers/order_controller_test.go`, replace `PlaceOptionsOrder` (lines 46-48) so it returns a result and counts calls:
```go
func (r *recordingTradingService) PlaceOptionsOrder(_ context.Context, order *interfaces.OptionsOrder) (*interfaces.OrderResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.optionsOrdersPlaced++
	return &interfaces.OrderResult{OrderID: "opt-" + order.Symbol, Status: "accepted"}, nil
}
```

- [ ] **Step 2: Write the failing tests**

Add to `controllers/order_controller_test.go`:
```go
func TestPlaceOptionsOrder_GuardBlocksOversizedOpen(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		EnablePositionCaps: true, MaxPositionPct: 0.12, MaxDeployedPct: 0.50,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	// 30 * $6 * 100 = $18,000 > 12% of $100k → blocked on buy_to_open.
	body := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":30,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":6,"strategy":"v2-options"}`
	c.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")
	oc.PlaceOptionsOrder(c)
	if rec.optionsOrdersPlaced != 0 {
		t.Fatalf("guard should block before placement, placed=%d", rec.optionsOrdersPlaced)
	}
}

func TestPlaceOptionsOrder_CloseNotBlocked(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := &recordingTradingService{portfolio: 100000, cash: 95000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		EnablePositionCaps: true, MaxPositionPct: 0.12, MaxDeployedPct: 0.50,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	body := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":30,"side":"sell","position_intent":"sell_to_close","type":"market","strategy":"v2-options"}`
	c.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")
	oc.PlaceOptionsOrder(c)
	if rec.optionsOrdersPlaced != 1 {
		t.Fatalf("close order must not be blocked, placed=%d", rec.optionsOrdersPlaced)
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./controllers/ -run TestPlaceOptionsOrder -v`
Expected: FAIL — the buy is placed (guard never consulted), so the first assertion fails.

- [ ] **Step 4: Add helpers and wire the guard into PlaceOptionsOrder**

In `controllers/order_controller.go`, add near `PlaceOptionsOrder`:
```go
// isOpeningOption reports whether an options order opens (vs closes) a position.
// Caps + the daily-loss breaker apply only to opens; closes must never block.
func isOpeningOption(intent, side string) bool {
	switch intent {
	case "buy_to_open", "sell_to_open":
		return true
	case "buy_to_close", "sell_to_close":
		return false
	default:
		return side == "buy"
	}
}

// optionsNotional returns the dollar outlay for an options order: per-contract
// price x qty x 100. Uses the limit price when present, else a fetched quote
// (mid, then ask, then last). Returns 0 when no price is obtainable — the guard
// then fails closed if position caps are enabled.
func optionsNotional(ctx context.Context, ts interfaces.TradingService, order *interfaces.OptionsOrder) float64 {
	price := 0.0
	if order.LimitPrice != nil && *order.LimitPrice > 0 {
		price = *order.LimitPrice
	} else if q, err := ts.GetOptionsQuote(ctx, order.Symbol); err == nil && q != nil {
		switch {
		case q.BidPrice > 0 && q.AskPrice > 0:
			price = (q.BidPrice + q.AskPrice) / 2
		case q.AskPrice > 0:
			price = q.AskPrice
		case q.LastPrice > 0:
			price = q.LastPrice
		}
	}
	return price * order.Qty * 100
}
```
In `PlaceOptionsOrder`, insert this **after** the `ctx, cancel := context.WithTimeout(...)` / `defer cancel()` block (lines 525-526) — so `ctx` is in scope — and **before** `result, err := oc.tradingService.PlaceOptionsOrder`:
```go
	agent := services.AgentForStrategy(req.Strategy)
	opening := isOpeningOption(req.PositionIntent, req.Side)
	if oc.guard != nil {
		if opening && req.Side == "buy" {
			notional := optionsNotional(ctx, oc.tradingService, order)
			if err := oc.guard.CheckBuy(ctx, agent, order.Symbol, notional); err != nil {
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
```
After `result, err := oc.tradingService.PlaceOptionsOrder(...)` succeeds (after the error check, before the DBOrder persistence ~line 535), insert:
```go
	if oc.guard != nil {
		if opening {
			oc.guard.RecordRawBuy(agent, order.Symbol)
		} else {
			oc.guard.RecordRawSell(agent, order.Symbol)
		}
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./controllers/ -run TestPlaceOptionsOrder -v`
Expected: PASS — open blocked at $18k; close placed.

- [ ] **Step 6: Commit**

```bash
git add controllers/order_controller.go controllers/order_controller_test.go
git commit -m "$(cat <<'EOF'
Route options orders through the trade guard

PlaceOptionsOrder never consulted the guard, so Prophet's options entries
(its only real entries) bypassed the daily-loss breaker and every cap.
Gate opening buys through CheckBuy with x100 notional; record/clear
ownership; never block closes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10 (Fix B.4): Config wiring for position caps

**Files:**
- Modify: `config/config.go` (struct + `Load`)
- Modify: `cmd/bot/main.go` (`NewTradeGuard` lines 157-164; log fields 170-176)
- Test: `config/config_test.go`

- [ ] **Step 1: Write the failing test**

Add to `config/config_test.go`:
```go
func TestLoad_PositionCapDefaults(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !AppConfig.EnablePositionCaps {
		t.Error("EnablePositionCaps should default true")
	}
	if AppConfig.MaxPositionPct != 0.12 {
		t.Errorf("MaxPositionPct = %v, want 0.12", AppConfig.MaxPositionPct)
	}
	if AppConfig.MaxDeployedPct != 0.50 {
		t.Errorf("MaxDeployedPct = %v, want 0.50", AppConfig.MaxDeployedPct)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./config/ -run TestLoad_PositionCapDefaults -v`
Expected: FAIL — fields don't exist (compile error), then mismatch.

- [ ] **Step 3: Add config fields and parsing**

In `config/config.go` `Config` struct, add near the regime-gate fields:
```go
	// Position caps (hybrid hard backstops). Flag-gated like the regime gate.
	EnablePositionCaps bool
	MaxPositionPct     float64 // per-position cap, fraction of portfolio (0.12 = 12%)
	MaxDeployedPct     float64 // whole-account deployed ceiling (0.50 = 50%)
```
In `Load()`, add to the `AppConfig` literal:
```go
		EnablePositionCaps: getEnvOrDefault("ENABLE_POSITION_CAPS", "true") == "true",
		MaxPositionPct:     parseFloat(getEnvOrDefault("MAX_POSITION_PCT", "0.12")),
		MaxDeployedPct:     parseFloat(getEnvOrDefault("MAX_DEPLOYED_PCT", "0.50")),
```

- [ ] **Step 4: Wire into the guard**

In `cmd/bot/main.go`, extend the `TradeGuardConfig` literal (lines 157-164) with:
```go
			EnablePositionCaps:      cfg.EnablePositionCaps,
			MaxPositionPct:          cfg.MaxPositionPct,
			MaxDeployedPct:          cfg.MaxDeployedPct,
```
Add to the "Trade guard initialized" log fields (lines 170-176):
```go
		"position_caps_enabled":      cfg.EnablePositionCaps,
		"max_position_pct":           cfg.MaxPositionPct,
		"max_deployed_pct":           cfg.MaxDeployedPct,
```

- [ ] **Step 5: Run config tests + build**

Run: `go test ./config/ -v && go build ./...`
Expected: config test PASS; build clean.

- [ ] **Step 6: Commit**

```bash
git add config/config.go config/config_test.go cmd/bot/main.go
git commit -m "$(cat <<'EOF'
Wire position-cap config into the trade guard

ENABLE_POSITION_CAPS (default true), MAX_POSITION_PCT (0.12 = V2's
per-position rule), MAX_DEPLOYED_PCT (0.50 = conservative end of the
50-70% cash rule). All env-tunable.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11 (Fix B.5): End-to-end integration test (the central thesis)

**Files:**
- Test: `controllers/order_controller_test.go`

One test on the full path Prophet uses: an options order with `strategy="v2-options"` and **no** `agent_source` must hit `CheckBuy` (gap #1) with ×100 notional, attributed to `AgentMain` via the strategy tag (gap #2).

- [ ] **Step 1: Write the test**

Add to `controllers/order_controller_test.go`:
```go
func TestPlaceOptionsOrder_FullPath_GatedAndAttributedToMain(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Gap #1: with caps on, an $18k buy is gated (not placed) — proves options
	// now reach the guard.
	rec := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard := services.NewTradeGuard(&stubGuardLister{}, rec, services.TradeGuardConfig{
		EnablePositionCaps: true, MaxPositionPct: 0.12, MaxDeployedPct: 0.50,
	})
	oc := NewOrderController(rec, nil, noopStorage{})
	oc.SetGuard(guard)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	big := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":30,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":6,"strategy":"v2-options"}`
	c.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(big))
	c.Request.Header.Set("Content-Type", "application/json")
	oc.PlaceOptionsOrder(c)
	if rec.optionsOrdersPlaced != 0 {
		t.Fatalf("gap #1: options order should be gated, placed=%d", rec.optionsOrdersPlaced)
	}

	// Gap #2: a small buy (caps off) attributes to AgentMain via strategy tag.
	rec2 := &recordingTradingService{portfolio: 100000, cash: 100000}
	guard2 := services.NewTradeGuard(&stubGuardLister{}, rec2, services.TradeGuardConfig{})
	oc2 := NewOrderController(rec2, nil, noopStorage{})
	oc2.SetGuard(guard2)
	c2, _ := gin.CreateTestContext(httptest.NewRecorder())
	small := `{"symbol":"SPY260116C00500000","underlying":"SPY","qty":1,"side":"buy","position_intent":"buy_to_open","type":"limit","limit_price":1,"strategy":"v2-options"}`
	c2.Request = httptest.NewRequest("POST", "/options/order", bytes.NewBufferString(small))
	c2.Request.Header.Set("Content-Type", "application/json")
	oc2.PlaceOptionsOrder(c2)
	st := guard2.Status(context.Background())
	found := false
	for _, s := range st.MainSymbols {
		if s == "SPY260116C00500000" {
			found = true
		}
	}
	if !found {
		t.Fatal("gap #2: options buy with strategy=v2-options must attribute to AgentMain")
	}
}
```

- [ ] **Step 2: Run it**

Run: `go test ./controllers/ -run TestPlaceOptionsOrder_FullPath -v`
Expected: PASS.

- [ ] **Step 3: Run the entire Go + Node suite (no regressions)**

Run: `go test ./... && node --test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add controllers/order_controller_test.go
git commit -m "$(cat <<'EOF'
Add end-to-end test for options order gating + attribution

Exercises the production path (strategy=v2-options, no agent_source): the
options order is gated by the guard (gap #1) and attributes to AgentMain
via the strategy tag (gap #2).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12 (Fix F): Doc reconciliation

**Files:**
- Modify: `TRADING_RULES.md` (deprecation header)
- Modify: `TRADING_RULES_V2.md` (enforced-caps note, N-way scope honesty, penny cap number)
- Modify: `agent/harness.js` (`buildSystemPrompt`, ~line 97)

- [ ] **Step 1: Deprecate V1**

At the top of `TRADING_RULES.md`, add:
```markdown
> **DEPRECATED.** Legacy V1 rule set, kept only as a fallback when no strategy
> rules file resolves (`agent/harness.js:87`). The live Prophet (`v2-options`)
> agent uses `TRADING_RULES_V2.md`. Edit V2 for behavior changes, not this file.
```

- [ ] **Step 2: Update V2 to match enforced reality**

In `TRADING_RULES_V2.md`, under Position Sizing / Risk Management, add:
```markdown
> **Code-enforced (not advisory) as of 2026-05-21:** per-position size (12%) and
> total deployed (50%) are hard caps in the TradeGuard when `ENABLE_POSITION_CAPS`
> is on (default on). The daily-loss breaker blocks new entries (including
> options) and fails closed when account equity can't be read. The 40% V2 segment
> cap and the sector caps remain advisory.
```
In the Cross-Agent Sector Cap section, add:
```markdown
> **Symbol-overlap scope:** the cross-agent symbol guard is exact-string. It does
> not catch Prophet (options, OCC symbols) and a stock agent concentrating in the
> same *underlying* — that collision is not currently guarded. Underlying-level
> overlap is a tracked follow-up.
```
Change any "30%" penny-lane reference to "20% (default; env-tunable via `PENNY_MAX_CAPITAL_PCT`)" to match `config/config.go`.

- [ ] **Step 3: Fix the hard-vs-discretionary framing**

In `agent/harness.js`, the rules block (~line 97) currently begins "These are the hard rules you MUST follow." Replace that sentence so the line reads:
```javascript
    ? `## Strategy Rules\nSome of these are enforced in code (position size, total deployed, the daily-loss breaker, per-order value, and the live/options/0DTE gates) — orders that violate them are rejected by the system. The rest are discretionary guidance you are expected to follow. They define what you can trade, position sizes, risk limits, and exit criteria.\n\n${tradingRules}`
```

- [ ] **Step 4: Verify and commit**

Run: `node --check agent/harness.js`
Expected: no syntax errors.
```bash
git add TRADING_RULES.md TRADING_RULES_V2.md agent/harness.js
git commit -m "$(cat <<'EOF'
Reconcile rules docs with enforced reality

Deprecate V1 TRADING_RULES.md; note in V2 which caps are now code-enforced
vs advisory; state the N-way overlap's exact-string scope limit; align the
penny cap number with config (20%); reword the system-prompt rules header
to distinguish enforced from discretionary.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Run the full suite**

Run: `go test ./... && node --test`
Expected: all PASS. No success claim without green output (per verification-before-completion).

- [ ] **Carry-forward items (not implemented here)**

Documented in the spec, intentionally deferred: raw-ownership reconciliation/expiry (spec B6), guard concurrency/TOCTOU on the deployed cap (coarse backstop), underlying-level cross-instrument overlap, and Phase 2 (the Prophet options auto-stop monitor — its own spec/plan, which the owner noted may span multiple sessions).
