# Beat-Context Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read first:** `docs/superpowers/plans/2026-05-16-llm-token-savings-prerequisites.md`. It contains the verified trading-service API surface, strategy-rule loading (all `.md` rule files are authoritative), recommended execution sequence (this plan is **#2** — do it after the Penny social-exit timer), and the cross-plan ordering rationale.

**Goal:** Bundle the 4-5 read-only tool calls that every heartbeat performs (account, positions, econ blackout, regime gate, segment-PnL) into a single backend endpoint and inject the rendered context into the heartbeat prompt — eliminating 4-5 tool round-trips per beat across all four agents.

**Architecture:** New `GET /api/v1/beat-context?strategy=<id>` endpoint. The harness fetches it before each beat (with a short timeout, same soft-fail pattern as the existing intraday prefix) and prepends a rendered markdown block to the heartbeat prompt. Strategy rules are updated to document: "your beat already contains the live account/positions/blackout/regime values — only call the underlying tools if you need fresher data."

**Tech Stack:** Go 1.21+, Gin, existing controllers (no new business logic — pure aggregation). Node.js prompt rendering on the harness side.

---

## File Structure

- Create: `controllers/beat_context_controller.go` — the aggregator endpoint.
- Create: `controllers/beat_context_controller_test.go`.
- Modify: `cmd/bot/main.go` — wire the controller and route.
- Create: `agent/beat-context.js` — fetch + render helper (mirror of `agent/intraday-prompt.js`).
- Create: `agent/beat-context.test.mjs`.
- Modify: `agent/harness.js:822-847` — insert the rendered block alongside the existing `intradayPrefix`.
- Modify: `TRADING_RULES.md`, `TRADING_RULES_V2.md`, `TRADING_RULES_HARVEST.md`, `TRADING_RULES_PENNY.md`, `TRADING_RULES_TREND.md` — annotate that the beat already contains this data and the explicit tool calls are now optional / refresh-only.

---

## Task 1: Backend aggregator endpoint

**Files:**
- Create: `controllers/beat_context_controller.go`
- Create: `controllers/beat_context_controller_test.go`
- Modify: `cmd/bot/main.go`

- [ ] **Step 1: Write a failing test**

`controllers/beat_context_controller_test.go`:

```go
package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

type stubAcct struct{}
func (s stubAcct) GetAccount() (*Account, error) {
	return &Account{PortfolioValue: 100_000, Cash: 50_000, BuyingPower: 200_000}, nil
}

type stubBlackout struct{ blackout bool; reason string }
func (s stubBlackout) Status() (isBlackout bool, reason string, err error) {
	return s.blackout, s.reason, nil
}

type stubRegime struct{}
func (s stubRegime) Status() (tier string, score int, sizingMultiplier float64, block bool, err error) {
	return "NORMAL", 55, 0.8, false, nil
}

type stubPnL struct{ unrealized float64; deployed float64 }
func (s stubPnL) Get(strategy string) (unrealizedPct, deployedPct float64, err error) {
	return s.unrealized, s.deployed, nil
}

type stubPositions struct{}
func (s stubPositions) List(strategy string) ([]PositionSummary, error) {
	return []PositionSummary{
		{Symbol: "TLT", Qty: 100, UnrealizedPnL: 250.0, UnrealizedPnLPct: 1.2},
	}, nil
}

func TestBeatContext_HappyPath(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctrl := NewBeatContextController(stubAcct{}, stubPositions{}, stubBlackout{}, stubRegime{}, stubPnL{unrealized: 0.5, deployed: 12.0})
	r := gin.New()
	r.GET("/api/v1/beat-context", ctrl.HandleGet)

	req := httptest.NewRequest("GET", "/api/v1/beat-context?strategy=trend", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", w.Code, w.Body)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["account"] == nil || body["positions"] == nil || body["econ_blackout"] == nil ||
		body["regime_gate"] == nil || body["segment_pnl"] == nil {
		t.Errorf("missing field: %+v", body)
	}
}

func TestBeatContext_OmitsSegmentPnLWithoutStrategy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	ctrl := NewBeatContextController(stubAcct{}, stubPositions{}, stubBlackout{}, stubRegime{}, stubPnL{})
	r := gin.New()
	r.GET("/api/v1/beat-context", ctrl.HandleGet)

	req := httptest.NewRequest("GET", "/api/v1/beat-context", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var body map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if _, present := body["segment_pnl"]; present {
		t.Errorf("expected segment_pnl absent without ?strategy=, got %v", body["segment_pnl"])
	}
}

func TestBeatContext_SoftFailsOnDownstreamErrors(t *testing.T) {
	// If a downstream errors, return what we have with `errors: [...]` rather
	// than a 500 — the agent's rules-side fail policies (closed on error) take
	// over downstream.
	// Stub stand-ins return error from one of the dependencies.
	... // implementation deferred to Step 3 with the actual error stubs
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./controllers -run TestBeatContext -v
```

Expected: FAIL with `undefined: NewBeatContextController`.

- [ ] **Step 3: Implement the controller**

`controllers/beat_context_controller.go`:

```go
package controllers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// BeatContextController bundles the read-only context every agent beat needs
// into a single endpoint, eliminating 4-5 separate MCP tool round-trips per
// heartbeat.
type BeatContextController struct {
	acct       AccountFetcher
	positions  PositionsFetcher
	blackout   BlackoutFetcher
	regime     RegimeFetcher
	segmentPnL SegmentPnLFetcher
}

type AccountFetcher interface {
	GetAccount() (*Account, error)
}

type PositionsFetcher interface {
	List(strategy string) ([]PositionSummary, error)
}

type BlackoutFetcher interface {
	Status() (isBlackout bool, reason string, err error)
}

type RegimeFetcher interface {
	Status() (tier string, score int, sizingMultiplier float64, block bool, err error)
}

type SegmentPnLFetcher interface {
	Get(strategy string) (unrealizedPct, deployedPct float64, err error)
}

type PositionSummary struct {
	Symbol           string  `json:"symbol"`
	Qty              float64 `json:"qty"`
	UnrealizedPnL    float64 `json:"unrealized_pnl"`
	UnrealizedPnLPct float64 `json:"unrealized_pnl_pct"`
}

type Account struct {
	PortfolioValue float64 `json:"portfolio_value"`
	Cash           float64 `json:"cash"`
	BuyingPower    float64 `json:"buying_power"`
}

func NewBeatContextController(
	acct AccountFetcher,
	positions PositionsFetcher,
	blackout BlackoutFetcher,
	regime RegimeFetcher,
	segmentPnL SegmentPnLFetcher,
) *BeatContextController {
	return &BeatContextController{
		acct: acct, positions: positions, blackout: blackout, regime: regime, segmentPnL: segmentPnL,
	}
}

func (c *BeatContextController) HandleGet(ctx *gin.Context) {
	strategy := ctx.Query("strategy")
	out := gin.H{"fetched_at": time.Now().UTC().Format(time.RFC3339)}
	var errs []string

	if acct, err := c.acct.GetAccount(); err != nil {
		errs = append(errs, "account: "+err.Error())
	} else {
		out["account"] = acct
	}

	if positions, err := c.positions.List(strategy); err != nil {
		errs = append(errs, "positions: "+err.Error())
	} else {
		out["positions"] = positions
	}

	if isBlackout, reason, err := c.blackout.Status(); err != nil {
		errs = append(errs, "blackout: "+err.Error())
	} else {
		out["econ_blackout"] = gin.H{"is_blackout": isBlackout, "reason": reason}
	}

	if tier, score, mult, block, err := c.regime.Status(); err != nil {
		errs = append(errs, "regime: "+err.Error())
	} else {
		out["regime_gate"] = gin.H{
			"tier":               tier,
			"score":              score,
			"sizing_multiplier":  mult,
			"block_new_entries":  block,
		}
	}

	if strategy != "" {
		if unrl, dep, err := c.segmentPnL.Get(strategy); err != nil {
			errs = append(errs, "segment_pnl: "+err.Error())
		} else {
			out["segment_pnl"] = gin.H{
				"unrealized_pnl_percent": unrl,
				"deployed_percent":       dep,
				"strategy":               strategy,
			}
		}
	}

	if len(errs) > 0 {
		out["errors"] = errs
	}
	ctx.JSON(http.StatusOK, out)
}
```

- [ ] **Step 4: Add adapter types in main.go to convert existing controllers/services to the new interfaces**

In `cmd/bot/main.go`, after existing controller construction, add small adapters where field names don't match. Example for blackout (assuming `economicFeedsController` exposes `EconBlackoutStatus()`):

```go
type blackoutAdapter struct{ c *controllers.EconomicFeedsController }
func (a blackoutAdapter) Status() (bool, string, error) {
	st, err := a.c.EconBlackoutStatus()
	if err != nil { return false, "", err }
	return st.IsBlackout, st.Reason, nil
}
```

Repeat for `RegimeFetcher`, `SegmentPnLFetcher`, `PositionsFetcher`, `AccountFetcher`. Construct:

```go
beatCtxController := controllers.NewBeatContextController(
	accountAdapter{orderController},
	positionsAdapter{positionController},
	blackoutAdapter{economicFeedsController},
	regimeAdapter{regimeGateController},
	segmentPnLAdapter{segmentPnLController},
)
```

Register route in `setupRouter`: `r.GET("/api/v1/beat-context", beatCtxController.HandleGet)`.

- [ ] **Step 5: Run tests**

```bash
go test ./controllers -run TestBeatContext -v
go build ./...
```

Expected: PASS + build green.

- [ ] **Step 6: Commit**

```bash
git add controllers/beat_context_controller.go controllers/beat_context_controller_test.go cmd/bot/main.go
git commit -m "feat(beat-context): aggregator endpoint bundling per-beat context"
```

---

## Task 2: Harness-side fetch + render

**Files:**
- Create: `agent/beat-context.js`
- Create: `agent/beat-context.test.mjs`
- Modify: `agent/harness.js:822-847`

- [ ] **Step 1: Write failing tests for the renderer**

`agent/beat-context.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBeatContextBlock } from './beat-context.js';

test('renders all sections when present', () => {
  const block = renderBeatContextBlock({
    account: { portfolio_value: 100000, cash: 50000, buying_power: 200000 },
    positions: [{ symbol: 'TLT', qty: 100, unrealized_pnl: 250, unrealized_pnl_pct: 1.2 }],
    econ_blackout: { is_blackout: false, reason: '' },
    regime_gate: { tier: 'NORMAL', score: 55, sizing_multiplier: 0.8, block_new_entries: false },
    segment_pnl: { unrealized_pnl_percent: 0.5, deployed_percent: 12.0, strategy: 'trend' },
  });
  assert.match(block, /## Beat Context/);
  assert.match(block, /Portfolio: \$100,000/);
  assert.match(block, /TLT.*100.*\+1\.2%/);
  assert.match(block, /Regime: NORMAL/);
  assert.match(block, /Segment trend.*deployed 12\.0%/);
});

test('renders block when downstream returned errors', () => {
  const block = renderBeatContextBlock({
    account: { portfolio_value: 100000 },
    errors: ['regime: timeout'],
  });
  assert.match(block, /errors:.*regime: timeout/i);
});

test('returns empty string when payload is null', () => {
  assert.equal(renderBeatContextBlock(null), '');
});

test('returns empty string when payload has no usable fields', () => {
  assert.equal(renderBeatContextBlock({}), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test agent/beat-context.test.mjs
```

Expected: FAIL with `Cannot find module './beat-context.js'`.

- [ ] **Step 3: Implement the renderer**

`agent/beat-context.js`:

```js
// Renders the beat-context block injected into every heartbeat prompt.
// Output is read-only context, NOT a checklist — agents are told to call
// the underlying MCP tools only when they need fresher data than the snapshot.
export function renderBeatContextBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines = [];
  if (ctx.account && typeof ctx.account.portfolio_value === 'number') {
    const a = ctx.account;
    lines.push(`Portfolio: $${a.portfolio_value.toLocaleString()} | Cash: $${(a.cash ?? 0).toLocaleString()} | Buying Power: $${(a.buying_power ?? 0).toLocaleString()}`);
  }
  if (Array.isArray(ctx.positions) && ctx.positions.length > 0) {
    lines.push('Positions:');
    for (const p of ctx.positions) {
      const sign = p.unrealized_pnl_pct >= 0 ? '+' : '';
      lines.push(`  - ${p.symbol}: ${p.qty} sh, P&L ${sign}${(p.unrealized_pnl_pct ?? 0).toFixed(1)}% ($${(p.unrealized_pnl ?? 0).toFixed(2)})`);
    }
  } else if (Array.isArray(ctx.positions)) {
    lines.push('Positions: none');
  }
  if (ctx.econ_blackout) {
    lines.push(`Econ Blackout: ${ctx.econ_blackout.is_blackout ? 'YES — ' + (ctx.econ_blackout.reason || 'unspecified') : 'no'}`);
  }
  if (ctx.regime_gate) {
    const rg = ctx.regime_gate;
    lines.push(`Regime: ${rg.tier} (score ${rg.score}, size ${rg.sizing_multiplier}×, block=${rg.block_new_entries})`);
  }
  if (ctx.segment_pnl) {
    const sp = ctx.segment_pnl;
    lines.push(`Segment ${sp.strategy}: P&L ${sp.unrealized_pnl_percent.toFixed(2)}%, deployed ${sp.deployed_percent.toFixed(1)}%`);
  }
  if (Array.isArray(ctx.errors) && ctx.errors.length > 0) {
    lines.push(`errors: ${ctx.errors.join('; ')}`);
  }
  if (lines.length === 0) return '';
  return '## Beat Context (read-only snapshot)\n' + lines.join('\n');
}

// fetchBeatContext returns the parsed payload or null on any error / timeout.
// The 800ms timeout matches agent/harness.js:826-845's intraday-blob fetch
// pattern — same soft-fail philosophy: a missing block does not block the
// beat, the LLM can fetch fresh via the underlying MCP tools.
export async function fetchBeatContext(goAxios, strategyId) {
  if (!goAxios) return null;
  try {
    const url = strategyId
      ? `/api/v1/beat-context?strategy=${encodeURIComponent(strategyId)}`
      : '/api/v1/beat-context';
    const resp = await goAxios.get(url, { timeout: 800 });
    return resp?.data ?? null;
  } catch (_err) {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test agent/beat-context.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Wire into harness.js**

In `agent/harness.js`, replace lines 826-845 (the intraday-block injection):

```js
let intradayPrefix = '';
let beatContextPrefix = '';
if (shouldInjectIntraday(this._agentConfig?.strategyId, phase)) {
  const runtime = this.getRuntime ? this.getRuntime(this.sandboxId) : null;
  if (runtime?.goAxios) {
    try {
      const symbols = PROPHET_INTRADAY_WATCHLIST.join(',');
      const resp = await runtime.goAxios.get(
        `/api/v1/intraday/signals?symbols=${encodeURIComponent(symbols)}`,
        { timeout: 800 }
      );
      const block = renderIntradayBlock(resp?.data);
      if (block) intradayPrefix = `\n\n${block}`;
    } catch (err) {
      this.state.emit('agent_log', {
        message: `Beat #${beatNum}: intraday blob fetch failed (${err.message}); proceeding without it`,
        level: 'warn',
      });
    }
  }
}

// Beat-context bundle — fetched for every agent regardless of strategy/phase
// when BEAT_CONTEXT_ENABLED is not explicitly disabled. Default-on with an
// opt-out env var so operators can kill the injection without redeploying
// the harness. Soft-fails on error: the LLM can still call the underlying
// MCP tools when the block is absent.
if (process.env.BEAT_CONTEXT_ENABLED !== 'false') {
  const runtime = this.getRuntime ? this.getRuntime(this.sandboxId) : null;
  if (runtime?.goAxios) {
    const ctx = await fetchBeatContext(runtime.goAxios, this._agentConfig?.strategyId);
    const block = renderBeatContextBlock(ctx);
    if (block) beatContextPrefix = `\n\n${block}`;
  }
}
```

Update the import at the top of `harness.js`:

```js
import { renderIntradayBlock, shouldInjectIntraday } from './intraday-prompt.js';
import { fetchBeatContext, renderBeatContextBlock } from './beat-context.js';
```

Update the prompt assembly on line 847:

```js
const prompt = `[HEARTBEAT #${beatNum}] Phase: ${PHASE_DEFAULTS[phase].label}. Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET. Current heartbeat interval: ${this.state.heartbeatSeconds}s.${emergencyPrefix}${beatContextPrefix}${intradayPrefix}\n\nPerform your duties for this phase.`;
```

(Beat context first, intraday second — context is the more universal block.)

- [ ] **Step 6: Run all harness tests**

```bash
node --test agent/*.test.mjs
```

Expected: all PASS (existing tests don't read the prompt body).

- [ ] **Step 7: Commit**

```bash
git add agent/beat-context.js agent/beat-context.test.mjs agent/harness.js
git commit -m "feat(harness): inject beat-context bundle into heartbeat prompt"
```

---

## Task 2b: Add `BEAT_CONTEXT_ENABLED` opt-out to .env.example

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document the opt-out**

```bash
echo "" >> .env.example
echo "# Beat-context bundle injection — default on. Set to 'false' to disable" >> .env.example
echo "# (e.g., to isolate an LLM behavior regression to the bundle)." >> .env.example
echo "BEAT_CONTEXT_ENABLED=true" >> .env.example
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(beat-context): document BEAT_CONTEXT_ENABLED opt-out flag"
```

---

## Task 3: Rules updates — tell agents the snapshot exists

**Files:**
- Modify: `TRADING_RULES_V2.md`
- Modify: `TRADING_RULES_HARVEST.md`
- Modify: `TRADING_RULES_PENNY.md`
- Modify: `TRADING_RULES_TREND.md`
- Modify: `data/agent-config.json` (for the live PennyProphet customRules)

- [ ] **Step 1: Add a shared "Beat Context Block" subsection**

Insert near the top of each rules file (after the agent identity, before the heartbeat behavior section):

```markdown
## Beat Context Block

Each heartbeat begins with a `## Beat Context (read-only snapshot)` block
containing the live account snapshot, your strategy-tagged positions, econ
blackout flag, regime-gate tier/multiplier/block-flag, and (when applicable)
segment P&L. Use these values directly — do not call `get_account`,
`get_positions`, `get_econ_blackout_status`, `get_regime_gate_status`, or
`get_segment_pnl` redundantly unless you need a refreshed read mid-beat.

If the block is missing or contains an `errors:` line for a particular field,
fall back to the corresponding tool call (the rule's existing fail-closed
policy still applies on tool error).
```

- [ ] **Step 2: Update penny customRules in data/agent-config.json**

Apply the same insertion to the `customRules` field of `penny-momentum` strategy.

- [ ] **Step 3: Commit**

```bash
git add TRADING_RULES_V2.md TRADING_RULES_HARVEST.md TRADING_RULES_PENNY.md TRADING_RULES_TREND.md data/agent-config.json
git commit -m "docs(beat-context): document the per-beat snapshot block in all rules"
```

---

## Task 4: Manual smoke test

- [ ] **Step 1: Restart bot and check live prompt**

Add a temporary `console.log(prompt)` line in `harness.js` (just before the `_runClaude` call) for one run, OR enable `OPENCODE_LOG_LEVEL=debug` and verify the heartbeat prompt actually contains the `## Beat Context` block. Remove the temp log after confirming.

- [ ] **Step 2: Verify token reduction**

Compare token counts (the harness logs `Beat cost: $X | Tokens: N` at `harness.js:1020-1025`) for a few beats before/after the change on a moderately busy agent (Prophet during midday). Expected: net token savings of roughly the bundled-tool result size (each tool call's output, ~200-1000 tokens each) minus the rendered block (~100-300 tokens). With 4 tools eliminated, net savings should be visible in the log.

- [ ] **Step 3: Verify graceful degradation**

Stop the Go backend mid-beat. The harness should log a soft-fail and proceed without the block. The next beat retries cleanly.

---

## Self-Review

**Coverage of the four agents:**
- Prophet/V2 — calls all 5 today (account, positions, blackout, regime, intraday). Block covers 4. ✅
- Harvest — calls account, positions, blackout, FOMC, IVR. **Gap: FOMC is harvest-specific, not in the bundle.** Decided to leave it out — single-strategy fields belong in strategy-specific endpoints, not the shared bundle. Harvest beat still calls `get_harvest_state` (which carries FOMC implicitly via the pre-loop checks) and `get_harvest_ivr` per-underlying; the 4 bundled fields are a clean subset.
- Penny — calls account, positions, blackout, regime, candidates. Bundle covers 4; `get_penny_candidates` stays as it's the entry trigger and the agent must see it fresh on every beat (preflight already skips when count is 0).
- Trend — bundled fields cover the entire pre-loop except `get_trend_signal` per-ticker, which is the signal compute and must be called.

**Gaps surfaced:**

1. **Strategy-tagged positions:** `PositionsFetcher.List(strategy)` needs strategy filtering. Today `/api/v1/positions?strategy=X` exists (used by preflight). The adapter just wraps that. Confirm during execution.
2. **Stale-data risk:** Snapshot is fetched once per beat, then the agent might spend 60+ seconds before acting. The snapshot fields (account values, regime tier) drift slowly enough that this is fine, BUT: for any decision near a threshold (e.g., regime score = 21 with DEFENSIVE/RED boundary at 20), the agent should re-fetch. Rules update in Task 3 covers this — "do not call redundantly **unless you need a refreshed read mid-beat**."
3. **Permission filter on the bundled endpoint:** `OPENPROPHET_TOOL_ALLOWLIST` blocks specific MCP tool names today (`harness.js:935-952`). The new endpoint is not an MCP tool — it's an HTTP fetch in the harness. So an allowlist that previously blocked `get_account` would still see the account data via the bundle. **This is a behavior change.** Mitigation: the new `BEAT_CONTEXT_ENABLED=true` env flag (Task 2 step 5 + Task 2b) gives operators a global kill switch. Per-agent suppression is left as a future follow-up — the current allowlist usage in `data/agent-config.json` is for cost/blast-radius, not data privacy, so the global flag is sufficient.
4. **Test coverage:** I have unit tests for the renderer and the controller, but no integration test for the harness fetching from a live mock backend. Manual smoke in Task 4 covers this — acceptable for a small change.

**Type/signature consistency:** `BeatContextController` interfaces (`AccountFetcher`, `PositionsFetcher`, `BlackoutFetcher`, `RegimeFetcher`, `SegmentPnLFetcher`) match the adapter shapes in Task 1 Step 4. `renderBeatContextBlock` returns string always (including empty). `fetchBeatContext` returns null on any error. ✅

**No placeholders:** One `...` remains in Task 1 Step 1's `TestBeatContext_SoftFailsOnDownstreamErrors` — kept intentionally as a forward reference because the error-stub pattern is straightforward and adding it inline would duplicate boilerplate. The implementer should add a `{err: errors.New("boom")}` field to each stub type and a corresponding error-path branch in `HandleGet`. Acceptable as a documented small follow-on within the same task.

---

## Out of Scope

- Auth/permissions for the new endpoint (matches the existing `/api/v1/*` posture — same trust boundary).
- Streaming updates within a beat (the snapshot is point-in-time per beat; agents needing intra-beat freshness call the original tools).
- Strategy-specific fields in the bundle (FOMC for Harvest, ORB for Penny, etc.) — these stay in their existing endpoints and tools.

---

## Expected impact

Per-beat tool round-trip count drops by 4 (account, positions, blackout, regime). At ~500-1500 tokens per round-trip (input + result tokens including system context), that's **roughly 2k-6k tokens saved per beat × all four agents**. On a typical session with Prophet ~30-50 beats, Penny ~20-40, Harvest ~5-10, Trend ~1, this compounds into the largest token-savings line item of the four plans — even though it's the smallest implementation.
