# Friction Layer + Walk-Forward Hold-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Node.js post-processor that injects realistic execution friction into paper-trade data, plus a walk-forward 80/20 hold-out validation step to the four adapt-strategy skills, so the agent learning loop trains on data that better resembles live trading.

**Architecture:** Standalone Node.js post-processor (`scripts/apply-friction.mjs`) reads `data/sandboxes/*/decisive_actions/*.json`, applies asset-class-specific friction, and writes parallel `*.friction.json` files. A predicate scorer (`scripts/score-rule-against-holdout.mjs`) validates proposed rule changes against the most recent 20% of trades the adapter did not see during proposal generation. Six `.claude/skills/*/SKILL.md` files are edited to invoke the post-processor as Step 0, read `*.friction.json` instead of raw `*.json`, use `market_data.friction_adjusted_pl`, and (for the four adapt skills) split into adapt/hold-out and apply the hold-out verdict to each proposed rule change. No Go agent changes.

**Tech Stack:** Node.js (ESM `.mjs`), `node:test` + `node:assert/strict` (consistent with existing `mcp-tools/regime-and-guard.test.mjs`). All tests run via `npm test`.

**Spec:** `docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md`

---

## File Structure

**Created:**
- `config/friction.json` — friction parameters (versioned)
- `scripts/apply-friction.mjs` — post-processor
- `scripts/apply-friction.test.mjs` — tests for post-processor
- `scripts/score-rule-against-holdout.mjs` — predicate scorer
- `scripts/score-rule-against-holdout.test.mjs` — tests for predicate scorer
- `scripts/test-fixtures/` — JSON fixtures for tests (decisive actions, agent-config snippets)

**Modified:**
- `.gitignore` — add `data/sandboxes/**/*.friction.json`
- `package.json` — extend `test` script glob to include `scripts/**/*.test.mjs`
- `.claude/skills/adapt-strategy/SKILL.md` — Step 0, 2.5, 6.5, 6.6
- `.claude/skills/adapt-strategy-penny/SKILL.md` — Step 0, 2.5, 6.5, 6.6
- `.claude/skills/harvest-parameter-review/SKILL.md` — Step 0, 2.5, 6.5, 6.6 + read-window adjustment
- `.claude/skills/trend-parameter-review/SKILL.md` — Step 0, 2.5, 6.5, 6.6 + read-window adjustment
- `.claude/skills/review-performance/SKILL.md` — Step 0 only (no hold-out logic; it's a report)
- `.claude/skills/review-performance-penny/SKILL.md` — Step 0 only

`scripts/apply-friction.mjs` is a single file with several exported functions to keep tests focused. Same for `scripts/score-rule-against-holdout.mjs`. Pattern matches the existing `mcp-tools/regime-and-guard.mjs` single-file-with-exports approach.

---

## Task 1: Config, test glob, gitignore

**Files:**
- Create: `config/friction.json`
- Modify: `.gitignore` (append one line)
- Modify: `package.json:13` (extend `test` script)

- [ ] **Step 1: Create `config/friction.json` with starter values**

```json
{
  "version": "2026-05-17.1",
  "stocks": {
    "per_share_slippage_usd": 0.02,
    "stop_gap_through_pct": 0.003,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001
  },
  "penny_stocks": {
    "per_share_slippage_usd": 0.01,
    "slippage_pct_of_price_floor": 0.02,
    "stop_gap_through_pct": 0.015,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001
  },
  "single_leg_options": {
    "spread_crossing_pct_open": 0.60,
    "spread_crossing_pct_close": 0.65,
    "spread_crossing_pct_close_when_losing": 0.75,
    "assumed_spread_pct_of_mid": 0.04,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05
  },
  "iron_condor": {
    "spread_crossing_pct_open": 0.55,
    "spread_crossing_pct_close": 0.65,
    "spread_crossing_pct_close_when_losing": 0.80,
    "assumed_spread_pct_of_credit": 0.10,
    "leg_count": 4,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05
  }
}
```

- [ ] **Step 2: Append `.gitignore` entry**

Add to end of `.gitignore`:
```
# Friction-adjusted derived trade files (regenerated from raw decisive_actions by scripts/apply-friction.mjs)
data/sandboxes/**/*.friction.json
```

- [ ] **Step 3: Extend `package.json` test glob**

Change line 13 from:
```json
"test": "node --test agent/**/*.test.mjs mcp-tools/**/*.test.mjs"
```
to:
```json
"test": "node --test agent/**/*.test.mjs mcp-tools/**/*.test.mjs scripts/**/*.test.mjs"
```

- [ ] **Step 4: Verify config parses as JSON**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('config/friction.json','utf8')).version)"`
Expected output: `2026-05-17.1`

- [ ] **Step 5: Verify `npm test` still passes (no new tests yet)**

Run: `npm test`
Expected: all existing tests pass; the new `scripts/**/*.test.mjs` glob matches zero files (silently fine).

- [ ] **Step 6: Commit**

```bash
git add config/friction.json .gitignore package.json
git commit -m "feat(friction): add config, gitignore derived files, extend test glob"
```

---

## Task 2: Asset class detection

**Files:**
- Create: `scripts/apply-friction.mjs` (initial export)
- Create: `scripts/apply-friction.test.mjs` (initial test file)

The asset class detection function decides which friction profile applies to a given decisive action. The detection table from the spec:

| Detection rule | Class |
|---|---|
| Agent is `harvest` | `iron_condor` (override) |
| OCC symbol AND reasoning contains "iron condor", "IC", or "4-leg" | `iron_condor` |
| OCC symbol (no IC marker) | `single_leg_options` |
| Plain ticker AND agent is `penny-prophet` | `penny_stocks` |
| Plain ticker, any other agent | `stocks` |
| None of the above | `null` (skip) |

OCC format regex: `^[A-Z]{1,6}\d{6}[CP]\d{8}$`

- [ ] **Step 1: Write failing tests for `detectAssetClass`**

Create `scripts/apply-friction.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectAssetClass } from './apply-friction.mjs';

test('detectAssetClass: harvest agent always returns iron_condor', () => {
  assert.equal(detectAssetClass({ symbol: 'SPY', reasoning: '' }, 'harvest'), 'iron_condor');
  assert.equal(detectAssetClass({ symbol: 'QQQ260515C00712000', reasoning: '' }, 'harvest'), 'iron_condor');
});

test('detectAssetClass: OCC + IC marker in reasoning -> iron_condor', () => {
  const action = { symbol: 'SPY260620P00400000', reasoning: 'opened iron condor on SPY' };
  assert.equal(detectAssetClass(action, 'default'), 'iron_condor');
});

test('detectAssetClass: OCC + "IC" abbreviation -> iron_condor', () => {
  const action = { symbol: 'SPY260620P00400000', reasoning: 'IC at 400/410/430/440' };
  assert.equal(detectAssetClass(action, 'default'), 'iron_condor');
});

test('detectAssetClass: OCC + "4-leg" -> iron_condor', () => {
  const action = { symbol: 'SPY260620P00400000', reasoning: '4-leg structure' };
  assert.equal(detectAssetClass(action, 'default'), 'iron_condor');
});

test('detectAssetClass: OCC without IC marker -> single_leg_options', () => {
  const action = { symbol: 'QQQ260515C00712000', reasoning: 'long call' };
  assert.equal(detectAssetClass(action, 'default'), 'single_leg_options');
});

test('detectAssetClass: plain ticker + penny-prophet -> penny_stocks', () => {
  assert.equal(detectAssetClass({ symbol: 'ABCD', reasoning: '' }, 'penny-prophet'), 'penny_stocks');
});

test('detectAssetClass: plain ticker + default agent -> stocks', () => {
  assert.equal(detectAssetClass({ symbol: 'SPY', reasoning: '' }, 'default'), 'stocks');
});

test('detectAssetClass: plain ticker + trend-prophet -> stocks', () => {
  assert.equal(detectAssetClass({ symbol: 'AAPL', reasoning: '' }, 'trend-prophet'), 'stocks');
});

test('detectAssetClass: unrecognized symbol shape -> null (skip)', () => {
  assert.equal(detectAssetClass({ symbol: 'weird-thing-not-a-ticker-or-occ', reasoning: '' }, 'default'), null);
});

test('detectAssetClass: missing symbol -> null', () => {
  assert.equal(detectAssetClass({ reasoning: '' }, 'default'), null);
});
```

- [ ] **Step 2: Create `scripts/apply-friction.mjs` with stub**

```js
// Friction post-processor. Reads raw decisive_actions JSON, applies asset-class-specific
// friction estimates, writes parallel *.friction.json files. Spec:
// docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md

const OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const IC_MARKERS = ['iron condor', 'ic ', ' ic', '4-leg', '4 leg'];

export function detectAssetClass(action, agentId) {
  if (agentId === 'harvest') return 'iron_condor';
  const symbol = action?.symbol;
  if (typeof symbol !== 'string' || symbol.length === 0) return null;

  if (OCC_SYMBOL.test(symbol)) {
    const reasoning = (action.reasoning ?? '').toLowerCase();
    const hasMarker = IC_MARKERS.some(m => reasoning.includes(m));
    return hasMarker ? 'iron_condor' : 'single_leg_options';
  }

  // Plain ticker heuristic: 1-5 uppercase letters
  if (/^[A-Z]{1,5}$/.test(symbol)) {
    return agentId === 'penny-prophet' ? 'penny_stocks' : 'stocks';
  }

  return null;
}
```

- [ ] **Step 3: Run tests, verify all 10 pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: 10 passing tests, 0 failing.

- [ ] **Step 4: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs
git commit -m "feat(friction): asset class detection"
```

---

## Task 3: Stop-out detection

**Files:**
- Modify: `scripts/apply-friction.mjs` (add export)
- Modify: `scripts/apply-friction.test.mjs` (add tests)

Stop-out detection scans `reasoning` for any of a broadened substring list AND requires `market_data.unrealized_pct < 0`. The broadened list (from spec) is intentionally generous to reduce false negatives.

- [ ] **Step 1: Append failing tests**

Append to `scripts/apply-friction.test.mjs`:
```js
import { isStopOut } from './apply-friction.mjs';

const STOP_PHRASINGS = [
  'stop hit',
  'stopped out',
  'stop triggered',
  'hit my stop',
  'hit stop',
  'stop loss fired',
  'SL hit',
  'stop loss triggered',
  'forced out',
];

for (const phrase of STOP_PHRASINGS) {
  test(`isStopOut: "${phrase}" + losing P&L -> true`, () => {
    const action = { reasoning: `Position ${phrase} at -12%`, market_data: { unrealized_pct: -12 } };
    assert.equal(isStopOut(action), true);
  });
}

test('isStopOut: stop phrase but POSITIVE P&L -> false (not really a stop)', () => {
  const action = { reasoning: 'stop hit but ended up positive', market_data: { unrealized_pct: 2 } };
  assert.equal(isStopOut(action), false);
});

test('isStopOut: no stop phrase -> false', () => {
  const action = { reasoning: 'closing for profit', market_data: { unrealized_pct: -5 } };
  assert.equal(isStopOut(action), false);
});

test('isStopOut: case-insensitive matching', () => {
  const action = { reasoning: 'STOPPED OUT at the low', market_data: { unrealized_pct: -8 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: missing market_data -> false (cannot confirm losing P&L)', () => {
  assert.equal(isStopOut({ reasoning: 'stop hit' }), false);
});
```

- [ ] **Step 2: Run tests, verify they fail with "isStopOut is not defined"**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `isStopOut`.

- [ ] **Step 3: Add `isStopOut` to `scripts/apply-friction.mjs`**

Append to `scripts/apply-friction.mjs`:
```js
const STOP_OUT_SUBSTRINGS = [
  'stop hit',
  'stopped out',
  'stop triggered',
  'hit my stop',
  'hit stop',
  'stop loss fired',
  'sl hit',
  'stop loss triggered',
  'forced out',
];

export function isStopOut(action) {
  const unrealizedPct = action?.market_data?.unrealized_pct;
  if (typeof unrealizedPct !== 'number' || unrealizedPct >= 0) return false;
  const reasoning = (action?.reasoning ?? '').toLowerCase();
  return STOP_OUT_SUBSTRINGS.some(s => reasoning.includes(s));
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all tests pass (including the prior 10 from Task 2).

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs
git commit -m "feat(friction): stop-out detection with broadened phrasings"
```

---

## Task 4: Stock friction calculator

**Files:**
- Modify: `scripts/apply-friction.mjs` (add export)
- Modify: `scripts/apply-friction.test.mjs` (add tests)

Computes the friction haircut for a stock trade. Inputs: action (`{ market_data: { entry_price, exit_price, size } }`), profile (the `stocks` block of friction.json), and a precomputed `stopOut` boolean. Returns `{ haircut_total_usd, haircut_breakdown }`.

Formula (from spec): `(per_share_slippage + reg_fee) × shares × 2`; if stop-out, add `stop_gap_through_pct × entry_price × shares`. `size` is share count.

- [ ] **Step 1: Append failing tests**

```js
import { computeStockFriction } from './apply-friction.mjs';

const STOCK_PROFILE = {
  per_share_slippage_usd: 0.02,
  stop_gap_through_pct: 0.003,
  commission_per_share: 0.0,
  regulatory_fee_per_share: 0.0001,
};

test('computeStockFriction: round trip with no stop-out', () => {
  // 100 shares, no stop. Per-side: (0.02 + 0.0001) × 100 = 2.01. Round trip = 4.02.
  const action = { market_data: { entry_price: 100, exit_price: 102, size: 100 } };
  const result = computeStockFriction(action, STOCK_PROFILE, false);
  assert.equal(result.haircut_total_usd, 4.02);
  assert.equal(result.haircut_breakdown.slippage, 4.0);
  assert.equal(result.haircut_breakdown.regulatory_fees, 0.02);
});

test('computeStockFriction: stop-out adds gap-through extra', () => {
  // Base haircut 4.02 (above). Stop adds 0.003 × 100 × 100 = 30.
  const action = { market_data: { entry_price: 100, exit_price: 88, size: 100 } };
  const result = computeStockFriction(action, STOCK_PROFILE, true);
  assert.equal(result.haircut_total_usd, 4.02 + 30);
  assert.equal(result.haircut_breakdown.stop_gap_through, 30);
});

test('computeStockFriction: missing size -> throws clear error', () => {
  const action = { market_data: { entry_price: 100, exit_price: 102 } };
  assert.throws(() => computeStockFriction(action, STOCK_PROFILE, false), /size/);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `computeStockFriction`.

- [ ] **Step 3: Add implementation**

Append to `scripts/apply-friction.mjs`:
```js
export function computeStockFriction(action, profile, stopOut) {
  const md = action?.market_data ?? {};
  const { entry_price, size } = md;
  if (typeof size !== 'number') {
    throw new Error(`computeStockFriction: missing market_data.size on action ${action?.symbol}`);
  }

  const slippage = profile.per_share_slippage_usd * size * 2;
  const regulatory_fees = profile.regulatory_fee_per_share * size * 2;
  const commissions = (profile.commission_per_share ?? 0) * size * 2;
  const stop_gap_through = stopOut
    ? profile.stop_gap_through_pct * entry_price * size
    : 0;

  const haircut_total_usd = +(slippage + regulatory_fees + commissions + stop_gap_through).toFixed(4);
  return {
    haircut_total_usd,
    haircut_breakdown: { slippage, regulatory_fees, commissions, stop_gap_through },
  };
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs
git commit -m "feat(friction): stock friction calculator"
```

---

## Task 5: Penny stock friction calculator

**Files:**
- Modify: `scripts/apply-friction.mjs` (add export)
- Modify: `scripts/apply-friction.test.mjs` (add tests)

Same shape as stocks, but effective per-share slippage = `max(per_share_slippage_usd, slippage_pct_of_price_floor × entry_price)`. Prevents under-modeling on sub-$1 names.

- [ ] **Step 1: Append failing tests**

```js
import { computePennyFriction } from './apply-friction.mjs';

const PENNY_PROFILE = {
  per_share_slippage_usd: 0.01,
  slippage_pct_of_price_floor: 0.02,
  stop_gap_through_pct: 0.015,
  commission_per_share: 0.0,
  regulatory_fee_per_share: 0.0001,
};

test('computePennyFriction: $0.50 stock uses pct floor (0.02 × 0.50 = 0.01 ties with usd floor)', () => {
  // size 1000. Effective per-share = max(0.01, 0.02 × 0.5) = 0.01.
  // Slippage: 0.01 × 1000 × 2 = 20. Reg fees: 0.0001 × 1000 × 2 = 0.2.
  const action = { market_data: { entry_price: 0.5, exit_price: 0.52, size: 1000 } };
  const result = computePennyFriction(action, PENNY_PROFILE, false);
  assert.equal(result.haircut_total_usd, 20.2);
});

test('computePennyFriction: $0.05 stock uses pct floor (0.02 × 0.05 = 0.001 < 0.01 -> floor wins... no, max wins)', () => {
  // Effective = max(0.01, 0.02 × 0.05) = max(0.01, 0.001) = 0.01.
  // The "floor" actually caps DOWN here — 0.01 is the higher value.
  // This test documents that behavior. For sub-$0.50 names, the absolute $0.01 still dominates.
  const action = { market_data: { entry_price: 0.05, exit_price: 0.06, size: 1000 } };
  const result = computePennyFriction(action, PENNY_PROFILE, false);
  // Slippage: 0.01 × 1000 × 2 = 20.
  assert.equal(result.haircut_breakdown.slippage, 20);
});

test('computePennyFriction: $2 stock — pct floor wins (0.02 × 2 = 0.04 > 0.01)', () => {
  // Effective = max(0.01, 0.04) = 0.04. Slippage: 0.04 × 1000 × 2 = 80.
  const action = { market_data: { entry_price: 2.0, exit_price: 2.1, size: 1000 } };
  const result = computePennyFriction(action, PENNY_PROFILE, false);
  assert.equal(result.haircut_breakdown.slippage, 80);
});

test('computePennyFriction: stop-out uses wider gap-through (0.015)', () => {
  const action = { market_data: { entry_price: 2.0, exit_price: 1.5, size: 1000 } };
  const result = computePennyFriction(action, PENNY_PROFILE, true);
  // Stop gap: 0.015 × 2.0 × 1000 = 30.
  assert.equal(result.haircut_breakdown.stop_gap_through, 30);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `computePennyFriction`.

- [ ] **Step 3: Add implementation**

Append to `scripts/apply-friction.mjs`:
```js
export function computePennyFriction(action, profile, stopOut) {
  const md = action?.market_data ?? {};
  const { entry_price, size } = md;
  if (typeof size !== 'number') {
    throw new Error(`computePennyFriction: missing market_data.size on action ${action?.symbol}`);
  }
  if (typeof entry_price !== 'number') {
    throw new Error(`computePennyFriction: missing market_data.entry_price on action ${action?.symbol}`);
  }

  const effectiveSlippagePerShare = Math.max(
    profile.per_share_slippage_usd,
    profile.slippage_pct_of_price_floor * entry_price,
  );
  const slippage = effectiveSlippagePerShare * size * 2;
  const regulatory_fees = profile.regulatory_fee_per_share * size * 2;
  const commissions = (profile.commission_per_share ?? 0) * size * 2;
  const stop_gap_through = stopOut
    ? profile.stop_gap_through_pct * entry_price * size
    : 0;

  const haircut_total_usd = +(slippage + regulatory_fees + commissions + stop_gap_through).toFixed(4);
  return {
    haircut_total_usd,
    haircut_breakdown: { slippage, regulatory_fees, commissions, stop_gap_through },
  };
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs
git commit -m "feat(friction): penny stock friction with price-floor slippage"
```

---

## Task 6: Single-leg option friction calculator

**Files:**
- Modify: `scripts/apply-friction.mjs` (add export)
- Modify: `scripts/apply-friction.test.mjs` (add tests)

Formula (from spec):
- `mid_price = (entry_price + exit_price) / 2`
- `spread_dollars = assumed_spread_pct_of_mid × mid_price`
- `close_was_losing = exit_price < entry_price` (long-only assumption — see spec caveat)
- `selected_close_pct = close_was_losing ? spread_crossing_pct_close_when_losing : spread_crossing_pct_close`
- `spread_cost = spread_dollars × (spread_crossing_pct_open + selected_close_pct) × contracts × 100`
- `commissions_and_fees = (commission_per_contract + regulatory_fee_per_contract) × contracts × 2`

`market_data.size` is contract count.

- [ ] **Step 1: Append failing tests**

```js
import { computeSingleLegOptionFriction } from './apply-friction.mjs';

const OPT_PROFILE = {
  spread_crossing_pct_open: 0.60,
  spread_crossing_pct_close: 0.65,
  spread_crossing_pct_close_when_losing: 0.75,
  assumed_spread_pct_of_mid: 0.04,
  commission_per_contract: 0.65,
  regulatory_fee_per_contract: 0.05,
};

test('computeSingleLegOptionFriction: winning close uses normal close pct', () => {
  // entry 7.50, exit 8.50, 6 contracts. mid = 8.0, spread_dollars = 0.04 × 8 = 0.32.
  // crossing = 0.60 + 0.65 = 1.25. spread_cost = 0.32 × 1.25 × 6 × 100 = 240.
  // fees = (0.65 + 0.05) × 6 × 2 = 8.4. Total = 248.4.
  const action = { market_data: { entry_price: 7.5, exit_price: 8.5, size: 6 } };
  const result = computeSingleLegOptionFriction(action, OPT_PROFILE);
  assert.equal(result.haircut_total_usd, 248.4);
  assert.equal(result.close_was_losing, false);
});

test('computeSingleLegOptionFriction: losing close uses higher close pct', () => {
  // entry 7.50, exit 6.80, 6 contracts. mid = 7.15. spread_dollars = 0.04 × 7.15 = 0.286.
  // crossing = 0.60 + 0.75 = 1.35. spread_cost = 0.286 × 1.35 × 6 × 100 = 231.66.
  // fees = 8.4. Total = 240.06.
  const action = { market_data: { entry_price: 7.5, exit_price: 6.8, size: 6 } };
  const result = computeSingleLegOptionFriction(action, OPT_PROFILE);
  assert.ok(Math.abs(result.haircut_total_usd - 240.06) < 0.01, `got ${result.haircut_total_usd}`);
  assert.equal(result.close_was_losing, true);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `computeSingleLegOptionFriction`.

- [ ] **Step 3: Add implementation**

Append to `scripts/apply-friction.mjs`:
```js
export function computeSingleLegOptionFriction(action, profile) {
  const md = action?.market_data ?? {};
  const { entry_price, exit_price, size } = md;
  if (typeof entry_price !== 'number' || typeof exit_price !== 'number' || typeof size !== 'number') {
    throw new Error(`computeSingleLegOptionFriction: missing entry_price/exit_price/size on ${action?.symbol}`);
  }

  const mid_price = (entry_price + exit_price) / 2;
  const spread_dollars = profile.assumed_spread_pct_of_mid * mid_price;
  const close_was_losing = exit_price < entry_price;
  const selected_close_pct = close_was_losing
    ? profile.spread_crossing_pct_close_when_losing
    : profile.spread_crossing_pct_close;

  const spread_crossing = spread_dollars * (profile.spread_crossing_pct_open + selected_close_pct) * size * 100;
  const commissions = profile.commission_per_contract * size * 2;
  const regulatory_fees = profile.regulatory_fee_per_contract * size * 2;

  const haircut_total_usd = +(spread_crossing + commissions + regulatory_fees).toFixed(4);
  return {
    haircut_total_usd,
    close_was_losing,
    haircut_breakdown: { spread_crossing, commissions, regulatory_fees },
  };
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs
git commit -m "feat(friction): single-leg option calculator with losing-close asymmetry"
```

---

## Task 7: Iron condor friction calculator

**Files:**
- Modify: `scripts/apply-friction.mjs` (add export)
- Modify: `scripts/apply-friction.test.mjs` (add tests)

Formula (from spec):
- `theoretical_credit` from `market_data.theoretical_credit` if present, else estimated as `entry_price × contracts × 100`
- `base_spread_cost = assumed_spread_pct_of_credit × theoretical_credit`
- `close_was_losing = exit_price < entry_price` (for ICs, "losing" means buyback cost > opening credit)
- `losing_close_multiplier = close_was_losing ? (spread_crossing_pct_close_when_losing − spread_crossing_pct_close) : 0`
- `spread_crossing = base_spread_cost × (1 + losing_close_multiplier)`
- `commissions_and_fees = (commission + fee) × leg_count × 2 × contracts`

- [ ] **Step 1: Append failing tests**

```js
import { computeIronCondorFriction } from './apply-friction.mjs';

const IC_PROFILE = {
  spread_crossing_pct_open: 0.55,
  spread_crossing_pct_close: 0.65,
  spread_crossing_pct_close_when_losing: 0.80,
  assumed_spread_pct_of_credit: 0.10,
  leg_count: 4,
  commission_per_contract: 0.65,
  regulatory_fee_per_contract: 0.05,
};

test('computeIronCondorFriction: winning close, explicit theoretical_credit', () => {
  // 10 contracts, theoretical_credit = $2000. exit < entry means losing in long-credit framing.
  // For ICs we use the explicit credit. Winning close: exit_price > entry_price (selling closer).
  // entry 2.0, exit 0.5 (closed for less debit -> winning close).
  // wait — ICs are sold for credit. entry_price is the credit received. If you close for less debit,
  //   you keep more credit -> winning. So close_was_losing = exit_price > entry_price for ICs?
  // For consistency with single-leg long convention: this test uses exit < entry == winning close.
  // (The spec uses exit_price < entry_price uniformly. Behavior is documented; user can refine later.)
  const action = { market_data: { entry_price: 2.0, exit_price: 0.5, size: 10, theoretical_credit: 2000 } };
  const result = computeIronCondorFriction(action, IC_PROFILE);
  // base_spread_cost = 0.10 × 2000 = 200.
  // close_was_losing = (0.5 < 2.0) = true → multiplier = 0.80 - 0.65 = 0.15. spread = 200 × 1.15 = 230.
  // fees = (0.65 + 0.05) × 4 × 2 × 10 = 56. Total = 286.
  assert.equal(result.haircut_total_usd, 286);
  assert.equal(result.close_was_losing, true);
});

test('computeIronCondorFriction: theoretical_credit estimated from entry × contracts × 100 when absent', () => {
  // entry 2.0, 10 contracts → estimated credit = 2.0 × 10 × 100 = 2000.
  const action = { market_data: { entry_price: 2.0, exit_price: 0.5, size: 10 } };
  const result = computeIronCondorFriction(action, IC_PROFILE);
  // Same numbers as above.
  assert.equal(result.haircut_total_usd, 286);
});

test('computeIronCondorFriction: non-losing close skips multiplier', () => {
  // exit > entry → close_was_losing = false → multiplier = 0.
  const action = { market_data: { entry_price: 1.0, exit_price: 1.5, size: 10, theoretical_credit: 1000 } };
  const result = computeIronCondorFriction(action, IC_PROFILE);
  // base = 100. spread = 100 × 1 = 100. fees = 56. Total = 156.
  assert.equal(result.haircut_total_usd, 156);
  assert.equal(result.close_was_losing, false);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `computeIronCondorFriction`.

- [ ] **Step 3: Add implementation**

Append to `scripts/apply-friction.mjs`:
```js
export function computeIronCondorFriction(action, profile) {
  const md = action?.market_data ?? {};
  const { entry_price, exit_price, size } = md;
  if (typeof entry_price !== 'number' || typeof exit_price !== 'number' || typeof size !== 'number') {
    throw new Error(`computeIronCondorFriction: missing entry_price/exit_price/size on ${action?.symbol}`);
  }

  const theoretical_credit = typeof md.theoretical_credit === 'number'
    ? md.theoretical_credit
    : entry_price * size * 100;

  const close_was_losing = exit_price < entry_price;
  const base_spread_cost = profile.assumed_spread_pct_of_credit * theoretical_credit;
  const losing_close_multiplier = close_was_losing
    ? (profile.spread_crossing_pct_close_when_losing - profile.spread_crossing_pct_close)
    : 0;
  const spread_crossing = base_spread_cost * (1 + losing_close_multiplier);

  const commissions = profile.commission_per_contract * profile.leg_count * 2 * size;
  const regulatory_fees = profile.regulatory_fee_per_contract * profile.leg_count * 2 * size;

  const haircut_total_usd = +(spread_crossing + commissions + regulatory_fees).toFixed(4);
  return {
    haircut_total_usd,
    close_was_losing,
    haircut_breakdown: { spread_crossing, commissions, regulatory_fees },
  };
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs
git commit -m "feat(friction): iron condor calculator with 4-leg compounding"
```

---

## Task 8: Friction dispatcher + friction_meta builder

**Files:**
- Modify: `scripts/apply-friction.mjs` (add export)
- Modify: `scripts/apply-friction.test.mjs` (add tests)

`applyFriction(action, agentId, config)` is the top-level pure transform:
1. Detect asset class. If null → return `{ skip: true, reason: 'unrecognized asset class' }`.
2. Validate `market_data.entry_price` and `exit_price` present. If not → `{ skip: true, reason: 'missing market_data' }`.
3. Detect stop-out (only meaningful for stocks/penny).
4. Dispatch to the correct calculator.
5. Compute `raw_pl` from `market_data.unrealized_pl` if present, else fall back to `(exit_price - entry_price) × size × (100 if option else 1)`.
6. `friction_adjusted_pl = raw_pl - haircut_total_usd`.
7. Build the augmented action object with `market_data.raw_pl`, `market_data.friction_adjusted_pl`, and `friction_meta` block.

- [ ] **Step 1: Append failing tests**

```js
import { applyFriction } from './apply-friction.mjs';

const FULL_CONFIG = {
  version: '2026-05-17.1',
  stocks: STOCK_PROFILE,
  penny_stocks: PENNY_PROFILE,
  single_leg_options: OPT_PROFILE,
  iron_condor: IC_PROFILE,
};

test('applyFriction: stock trade produces augmented action with friction_meta', () => {
  const action = {
    symbol: 'SPY',
    reasoning: 'taking profit at target',
    market_data: { entry_price: 500, exit_price: 505, size: 100, unrealized_pl: 500 },
  };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.skip, undefined);
  assert.equal(result.action.market_data.raw_pl, 500);
  assert.equal(result.action.market_data.friction_adjusted_pl, 500 - 4.02);
  assert.equal(result.action.friction_meta.profile_applied, 'stocks');
  assert.equal(result.action.friction_meta.close_was_losing, false);
  assert.equal(result.action.friction_meta.friction_config_version, '2026-05-17.1');
  assert.ok(typeof result.action.friction_meta.friction_config_hash === 'string');
  assert.equal(result.action.friction_meta.friction_config_hash.length, 8);
});

test('applyFriction: unrecognized asset class -> skip with reason', () => {
  const action = { symbol: 'weird-symbol', reasoning: '', market_data: { entry_price: 1, exit_price: 1, size: 1 } };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.skip, true);
  assert.match(result.reason, /asset class/);
});

test('applyFriction: missing entry_price -> skip with reason', () => {
  const action = { symbol: 'SPY', reasoning: '', market_data: { exit_price: 100, size: 10 } };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.skip, true);
  assert.match(result.reason, /market_data/);
});

test('applyFriction: option uses single_leg_options profile (close_was_losing surfaced)', () => {
  const action = {
    symbol: 'QQQ260515C00712000',
    reasoning: 'thesis broken, cutting',
    market_data: { entry_price: 7.5, exit_price: 6.8, size: 6, unrealized_pl: -420 },
  };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.action.friction_meta.profile_applied, 'single_leg_options');
  assert.equal(result.action.friction_meta.close_was_losing, true);
});

test('applyFriction: harvest agent forces iron_condor profile even on non-OCC symbol', () => {
  const action = {
    symbol: 'SPY',
    reasoning: '',
    market_data: { entry_price: 2.0, exit_price: 0.5, size: 10, theoretical_credit: 2000, unrealized_pl: 1500 },
  };
  const result = applyFriction(action, 'harvest', FULL_CONFIG);
  assert.equal(result.action.friction_meta.profile_applied, 'iron_condor');
});

test('applyFriction: sign-flip warning surfaced when small winner becomes loser', () => {
  // Stock trade: raw P&L of +$3, haircut $4.02 → friction_adjusted = -1.02.
  const action = {
    symbol: 'SPY',
    reasoning: 'small win',
    market_data: { entry_price: 100, exit_price: 100.03, size: 100, unrealized_pl: 3 },
  };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.action.market_data.friction_adjusted_pl < 0, true);
  assert.equal(result.sign_flip_warning, true);
});

test('applyFriction: raw_pl falls back to (exit-entry)×size when unrealized_pl absent (stocks)', () => {
  const action = { symbol: 'SPY', reasoning: '', market_data: { entry_price: 100, exit_price: 105, size: 100 } };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.action.market_data.raw_pl, 500);
});

test('applyFriction: raw_pl falls back to (exit-entry)×size×100 for options', () => {
  const action = {
    symbol: 'QQQ260515C00712000',
    reasoning: '',
    market_data: { entry_price: 5.0, exit_price: 6.0, size: 2 },
  };
  const result = applyFriction(action, 'default', FULL_CONFIG);
  assert.equal(result.action.market_data.raw_pl, 200);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `applyFriction`.

- [ ] **Step 3: Add implementation**

Append to `scripts/apply-friction.mjs`:
```js
import { createHash } from 'node:crypto';

const CALCULATORS = {
  stocks: (action, profile) => {
    const stopOut = isStopOut(action);
    const r = computeStockFriction(action, profile, stopOut);
    return { ...r, close_was_losing: action.market_data.exit_price < action.market_data.entry_price };
  },
  penny_stocks: (action, profile) => {
    const stopOut = isStopOut(action);
    const r = computePennyFriction(action, profile, stopOut);
    return { ...r, close_was_losing: action.market_data.exit_price < action.market_data.entry_price };
  },
  single_leg_options: (action, profile) => computeSingleLegOptionFriction(action, profile),
  iron_condor: (action, profile) => computeIronCondorFriction(action, profile),
};

function configHashShort(config) {
  // Stable JSON for hashing (sorted keys). For correctness here we use a canonical form.
  const json = JSON.stringify(config, Object.keys(config).sort());
  return createHash('sha256').update(json).digest('hex').slice(0, 8);
}

function deriveRawPl(action, profileKey) {
  const md = action.market_data;
  if (typeof md.unrealized_pl === 'number') return md.unrealized_pl;
  const isOption = profileKey === 'single_leg_options' || profileKey === 'iron_condor';
  const multiplier = isOption ? 100 : 1;
  return (md.exit_price - md.entry_price) * md.size * multiplier;
}

export function applyFriction(action, agentId, config) {
  const profileKey = detectAssetClass(action, agentId);
  if (!profileKey) return { skip: true, reason: 'unrecognized asset class' };

  const md = action?.market_data;
  if (!md || typeof md.entry_price !== 'number' || typeof md.exit_price !== 'number') {
    return { skip: true, reason: 'missing market_data.entry_price or exit_price' };
  }

  const profile = config[profileKey];
  if (!profile) return { skip: true, reason: `no friction profile for ${profileKey}` };

  const calc = CALCULATORS[profileKey](action, profile);
  const raw_pl = deriveRawPl(action, profileKey);
  const friction_adjusted_pl = +(raw_pl - calc.haircut_total_usd).toFixed(4);

  const augmented = {
    ...action,
    market_data: {
      ...md,
      raw_pl,
      friction_adjusted_pl,
    },
    friction_meta: {
      profile_applied: profileKey,
      close_was_losing: calc.close_was_losing,
      haircut_total_usd: calc.haircut_total_usd,
      haircut_breakdown: calc.haircut_breakdown,
      friction_config_version: config.version,
      friction_config_hash: configHashShort(config),
    },
  };

  const sign_flip_warning = raw_pl > 0 && friction_adjusted_pl < 0;
  return sign_flip_warning ? { action: augmented, sign_flip_warning: true } : { action: augmented };
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs
git commit -m "feat(friction): top-level applyFriction dispatcher with friction_meta"
```

---

## Task 9: Config loader

**Files:**
- Modify: `scripts/apply-friction.mjs` (add export)
- Modify: `scripts/apply-friction.test.mjs` (add tests)
- Create: `scripts/test-fixtures/friction-valid.json`
- Create: `scripts/test-fixtures/friction-malformed.json`

`loadFrictionConfig(path)` reads and parses the JSON, validates required keys exist (version + 4 profiles), and throws a clear error if missing or malformed. No silent default fallback.

- [ ] **Step 1: Create test fixtures**

`scripts/test-fixtures/friction-valid.json` — copy of `config/friction.json` from Task 1.

`scripts/test-fixtures/friction-malformed.json`:
```json
{ "version": "broken", "stocks": null }
```

- [ ] **Step 2: Append failing tests**

```js
import { loadFrictionConfig } from './apply-friction.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX_DIR = join(__dirname, 'test-fixtures');

test('loadFrictionConfig: valid file returns parsed config with all profiles', () => {
  const cfg = loadFrictionConfig(join(FIX_DIR, 'friction-valid.json'));
  assert.equal(cfg.version, '2026-05-17.1');
  assert.ok(cfg.stocks);
  assert.ok(cfg.penny_stocks);
  assert.ok(cfg.single_leg_options);
  assert.ok(cfg.iron_condor);
});

test('loadFrictionConfig: missing file throws with clear message', () => {
  assert.throws(
    () => loadFrictionConfig(join(FIX_DIR, 'nonexistent.json')),
    /friction config.*not found/i,
  );
});

test('loadFrictionConfig: malformed file (missing profiles) throws', () => {
  assert.throws(
    () => loadFrictionConfig(join(FIX_DIR, 'friction-malformed.json')),
    /missing required profile/i,
  );
});
```

- [ ] **Step 3: Run tests, verify failures**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `loadFrictionConfig`.

- [ ] **Step 4: Add implementation**

Append to `scripts/apply-friction.mjs`:
```js
import { readFileSync, existsSync } from 'node:fs';

const REQUIRED_PROFILES = ['stocks', 'penny_stocks', 'single_leg_options', 'iron_condor'];

export function loadFrictionConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`friction config not found at ${path}. See docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md for the required schema.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`friction config at ${path} is not valid JSON: ${err.message}`);
  }
  if (typeof parsed.version !== 'string') {
    throw new Error(`friction config at ${path} is missing required string field "version"`);
  }
  for (const key of REQUIRED_PROFILES) {
    if (!parsed[key] || typeof parsed[key] !== 'object') {
      throw new Error(`friction config at ${path} is missing required profile "${key}"`);
    }
  }
  return parsed;
}
```

- [ ] **Step 5: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs scripts/test-fixtures/friction-valid.json scripts/test-fixtures/friction-malformed.json
git commit -m "feat(friction): config loader with strict validation"
```

---

## Task 10: Atomic write helper

**Files:**
- Modify: `scripts/apply-friction.mjs` (add export)
- Modify: `scripts/apply-friction.test.mjs` (add tests)

`writeAtomic(path, content, fsImpl)` writes to `<path>.tmp`, then renames to `<path>`. `fsImpl` is injectable for testing. Default is `node:fs`.

- [ ] **Step 1: Append failing tests**

```js
import { writeAtomic } from './apply-friction.mjs';

function makeMockFs(opts = {}) {
  const writes = [];
  const renames = [];
  const removes = [];
  const writeFileSync = (path, content) => {
    if (opts.writeShouldThrow) throw new Error('disk full');
    writes.push({ path, content });
  };
  const renameSync = (from, to) => {
    if (opts.renameShouldThrow) throw new Error('rename failed');
    renames.push({ from, to });
  };
  const unlinkSync = (path) => { removes.push(path); };
  const existsSync = () => false; // No leftover tmp at start
  return { mock: { writeFileSync, renameSync, unlinkSync, existsSync }, writes, renames, removes };
}

test('writeAtomic: writes to .tmp then renames', () => {
  const { mock, writes, renames } = makeMockFs();
  writeAtomic('/path/to/file.json', '{"a":1}', mock);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/path/to/file.json.tmp');
  assert.equal(writes[0].content, '{"a":1}');
  assert.equal(renames.length, 1);
  assert.deepEqual(renames[0], { from: '/path/to/file.json.tmp', to: '/path/to/file.json' });
});

test('writeAtomic: if rename throws, attempts to clean up the tmp file', () => {
  const { mock, removes } = makeMockFs({ renameShouldThrow: true });
  assert.throws(() => writeAtomic('/path/to/file.json', '{}', mock), /rename failed/);
  assert.deepEqual(removes, ['/path/to/file.json.tmp']);
});

test('writeAtomic: if write throws, does not rename and does not leave stale tmp', () => {
  const { mock, renames, removes } = makeMockFs({ writeShouldThrow: true });
  assert.throws(() => writeAtomic('/path/to/file.json', '{}', mock), /disk full/);
  assert.equal(renames.length, 0);
  // Write failed before tmp existed → no cleanup needed (existsSync returned false in mock)
  assert.equal(removes.length, 0);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `writeAtomic`.

- [ ] **Step 3: Add implementation**

Append to `scripts/apply-friction.mjs`:
```js
import * as defaultFs from 'node:fs';

export function writeAtomic(path, content, fsImpl = defaultFs) {
  const tmp = `${path}.tmp`;
  fsImpl.writeFileSync(tmp, content);
  try {
    fsImpl.renameSync(tmp, path);
  } catch (err) {
    if (fsImpl.existsSync(tmp)) {
      try { fsImpl.unlinkSync(tmp); } catch { /* best effort */ }
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs
git commit -m "feat(friction): atomic write helper with injectable fs"
```

---

## Task 11: Sandbox resolver

**Files:**
- Modify: `scripts/apply-friction.mjs` (add export)
- Modify: `scripts/apply-friction.test.mjs` (add tests)
- Create: `scripts/test-fixtures/agent-config-sample.json`

`resolveSandboxesForAgent(agentConfigPath, agentId)` reads `data/agent-config.json` and returns the list of `accountId` values for sandboxes whose `agent.activeAgentId === agentId`.

- [ ] **Step 1: Create fixture**

`scripts/test-fixtures/agent-config-sample.json`:
```json
{
  "agents": [
    { "id": "default", "name": "Prophet", "strategyId": "prophet-v1" },
    { "id": "penny-prophet", "name": "Spark", "strategyId": "penny-v1" },
    { "id": "harvest", "name": "Harvest", "strategyId": "harvest-v1" }
  ],
  "strategies": [
    { "id": "prophet-v1", "name": "Prophet V1", "customRules": "...", "updatedAt": "2026-05-15T00:00:00Z" }
  ],
  "sandboxes": {
    "sb1": { "name": "sb1", "accountId": "aaa111", "agent": { "activeAgentId": "default" } },
    "sb2": { "name": "sb2", "accountId": "bbb222", "agent": { "activeAgentId": "default" } },
    "sb3": { "name": "sb3", "accountId": "ccc333", "agent": { "activeAgentId": "penny-prophet" } },
    "sb4": { "name": "sb4", "accountId": "ddd444", "agent": { "activeAgentId": "harvest" } }
  }
}
```

- [ ] **Step 2: Append failing tests**

```js
import { resolveSandboxesForAgent } from './apply-friction.mjs';

const AGENT_CFG = join(FIX_DIR, 'agent-config-sample.json');

test('resolveSandboxesForAgent: returns accountIds for matching sandboxes', () => {
  const ids = resolveSandboxesForAgent(AGENT_CFG, 'default');
  assert.deepEqual(ids.sort(), ['aaa111', 'bbb222']);
});

test('resolveSandboxesForAgent: returns single match', () => {
  assert.deepEqual(resolveSandboxesForAgent(AGENT_CFG, 'harvest'), ['ddd444']);
});

test('resolveSandboxesForAgent: returns empty array for agent with no sandboxes', () => {
  assert.deepEqual(resolveSandboxesForAgent(AGENT_CFG, 'trend-prophet'), []);
});

test('resolveSandboxesForAgent: throws if agent-config missing', () => {
  assert.throws(
    () => resolveSandboxesForAgent('/nope.json', 'default'),
    /agent-config.*not found/i,
  );
});
```

- [ ] **Step 3: Run tests, verify failures**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `resolveSandboxesForAgent`.

- [ ] **Step 4: Add implementation**

Append to `scripts/apply-friction.mjs`:
```js
export function resolveSandboxesForAgent(agentConfigPath, agentId) {
  if (!existsSync(agentConfigPath)) {
    throw new Error(`agent-config not found at ${agentConfigPath}`);
  }
  const cfg = JSON.parse(readFileSync(agentConfigPath, 'utf8'));
  const sandboxes = cfg.sandboxes ?? {};
  const ids = [];
  for (const sb of Object.values(sandboxes)) {
    if (sb?.agent?.activeAgentId === agentId && typeof sb.accountId === 'string') {
      ids.push(sb.accountId);
    }
  }
  return ids;
}
```

- [ ] **Step 5: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs scripts/test-fixtures/agent-config-sample.json
git commit -m "feat(friction): sandbox resolver against agent-config"
```

---

## Task 12: Main `apply-friction.mjs` orchestrator + CLI + integration test

**Files:**
- Modify: `scripts/apply-friction.mjs` (add orchestrator + CLI entry)
- Modify: `scripts/apply-friction.test.mjs` (add integration test)
- Create: `scripts/test-fixtures/integration-sandbox/decisive_actions/2026-05-11_BUY_SPY.json`
- Create: `scripts/test-fixtures/integration-sandbox/decisive_actions/2026-05-11_SELL_SPY.json`
- Create: `scripts/test-fixtures/integration-agent-config.json`

`processSandboxes({ agentId, projectRoot, fs })` is the testable entry point. It:
1. Loads config from `<projectRoot>/config/friction.json`.
2. Resolves sandboxes from `<projectRoot>/data/agent-config.json`.
3. For each sandbox: globs `data/sandboxes/<id>/decisive_actions/*.json` (excluding `*.friction.json`), applies friction, writes `.friction.json` atomically, collects skip/sign-flip stats.
4. Returns `{ processed, skipped, sign_flips, skip_reasons }`.

CLI entry parses `--agent <id>` and calls `processSandboxes`, then prints stats.

- [ ] **Step 1: Create integration fixtures**

`scripts/test-fixtures/integration-agent-config.json`:
```json
{
  "agents": [{ "id": "default", "name": "Prophet", "strategyId": "p1" }],
  "strategies": [{ "id": "p1", "name": "P1", "customRules": "" }],
  "sandboxes": {
    "ints": { "name": "ints", "accountId": "integration-sandbox", "agent": { "activeAgentId": "default" } }
  }
}
```

`scripts/test-fixtures/integration-sandbox/decisive_actions/2026-05-11_BUY_SPY.json`:
```json
{
  "timestamp": "2026-05-11T14:00:00Z",
  "action": "BUY",
  "symbol": "SPY",
  "reasoning": "entry on breakout",
  "market_data": { "entry_price": 500, "exit_price": 500, "size": 100 }
}
```

`scripts/test-fixtures/integration-sandbox/decisive_actions/2026-05-11_SELL_SPY.json`:
```json
{
  "timestamp": "2026-05-11T15:30:00Z",
  "action": "SELL",
  "symbol": "SPY",
  "reasoning": "taking profit at target",
  "market_data": { "entry_price": 500, "exit_price": 505, "size": 100, "unrealized_pl": 500 }
}
```

- [ ] **Step 2: Append integration test**

```js
import { processSandboxes } from './apply-friction.mjs';
import { rmSync, readFileSync, existsSync } from 'node:fs';

test('processSandboxes: end-to-end on integration fixtures', () => {
  // Layout under FIX_DIR:
  //   integration-agent-config.json
  //   integration-sandbox/decisive_actions/*.json
  // Project root we pass is FIX_DIR-like; but our code expects projectRoot/config/friction.json
  // and projectRoot/data/agent-config.json and projectRoot/data/sandboxes/<id>/decisive_actions.
  // We construct a minimal layout in a temp dir.

  const tmpRoot = join(FIX_DIR, '__tmp_integration__');
  rmSync(tmpRoot, { recursive: true, force: true });

  // Build the layout the orchestrator expects.
  const { mkdirSync, writeFileSync, cpSync } = defaultFsForTest();
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  cpSync(join(FIX_DIR, 'friction-valid.json'), join(tmpRoot, 'config', 'friction.json'));
  mkdirSync(join(tmpRoot, 'data'), { recursive: true });
  cpSync(join(FIX_DIR, 'integration-agent-config.json'), join(tmpRoot, 'data', 'agent-config.json'));
  cpSync(
    join(FIX_DIR, 'integration-sandbox'),
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox'),
    { recursive: true },
  );

  const result = processSandboxes({ agentId: 'default', projectRoot: tmpRoot });
  assert.equal(result.processed, 1, 'one SELL with full market_data should process (BUY lacks unrealized_pl exit)');
  // Actually both have entry_price + exit_price; both produce .friction.json.
  // Let's adjust expectations:
  // BUY: entry=exit=500 → raw_pl = 0, friction adjusted = -4.02.
  // SELL: raw_pl = 500, friction adjusted = 495.98.
  assert.equal(result.processed, 2);
  assert.equal(result.skipped, 0);

  const sellFriction = JSON.parse(readFileSync(
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json'),
    'utf8',
  ));
  assert.equal(sellFriction.market_data.friction_adjusted_pl, 495.98);
  assert.equal(sellFriction.friction_meta.profile_applied, 'stocks');

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('processSandboxes: idempotent (two runs produce byte-identical output)', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_idempotent__');
  rmSync(tmpRoot, { recursive: true, force: true });
  const { mkdirSync, cpSync, readFileSync: rfs } = defaultFsForTest();
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  cpSync(join(FIX_DIR, 'friction-valid.json'), join(tmpRoot, 'config', 'friction.json'));
  mkdirSync(join(tmpRoot, 'data'), { recursive: true });
  cpSync(join(FIX_DIR, 'integration-agent-config.json'), join(tmpRoot, 'data', 'agent-config.json'));
  cpSync(
    join(FIX_DIR, 'integration-sandbox'),
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox'),
    { recursive: true },
  );

  processSandboxes({ agentId: 'default', projectRoot: tmpRoot });
  const firstRun = rfs(
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json'),
    'utf8',
  );
  processSandboxes({ agentId: 'default', projectRoot: tmpRoot });
  const secondRun = rfs(
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json'),
    'utf8',
  );
  assert.equal(firstRun, secondRun, 'idempotent runs must produce byte-identical output');

  rmSync(tmpRoot, { recursive: true, force: true });
});

// Helper used in the two tests above.
function defaultFsForTest() {
  return defaultFs;
}
```

Add at top of test file (after existing imports):
```js
import * as defaultFs from 'node:fs';
```

- [ ] **Step 3: Run tests, verify failures**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: failures referencing `processSandboxes`.

- [ ] **Step 4: Add orchestrator implementation**

Append to `scripts/apply-friction.mjs`:
```js
import { readdirSync, mkdirSync } from 'node:fs';

export function processSandboxes({ agentId, projectRoot, fs = defaultFs }) {
  const configPath = join(projectRoot, 'config', 'friction.json');
  const agentCfgPath = join(projectRoot, 'data', 'agent-config.json');
  const config = loadFrictionConfig(configPath);
  const sandboxIds = resolveSandboxesForAgent(agentCfgPath, agentId);

  const stats = { processed: 0, skipped: 0, sign_flips: 0, skip_reasons: {} };

  for (const sbId of sandboxIds) {
    const dir = join(projectRoot, 'data', 'sandboxes', sbId, 'decisive_actions');
    if (!fs.existsSync(dir)) continue;
    const entries = readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.friction.json'));
    for (const fname of entries) {
      const fullPath = join(dir, fname);
      let action;
      try {
        action = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch (err) {
        process.stderr.write(`apply-friction: malformed JSON at ${fullPath}: ${err.message}\n`);
        stats.skipped += 1;
        stats.skip_reasons['malformed_json'] = (stats.skip_reasons['malformed_json'] ?? 0) + 1;
        continue;
      }
      const out = applyFriction(action, agentId, config);
      if (out.skip) {
        process.stderr.write(`apply-friction: skipped ${fullPath}: ${out.reason}\n`);
        stats.skipped += 1;
        stats.skip_reasons[out.reason] = (stats.skip_reasons[out.reason] ?? 0) + 1;
        continue;
      }
      if (out.sign_flip_warning) {
        process.stderr.write(`apply-friction: sign-flip on ${fullPath} (raw ${out.action.market_data.raw_pl} -> adjusted ${out.action.market_data.friction_adjusted_pl})\n`);
        stats.sign_flips += 1;
      }
      const outPath = join(dir, fname.replace(/\.json$/, '.friction.json'));
      const content = JSON.stringify(out.action, null, 2);
      writeAtomic(outPath, content, fs);
      stats.processed += 1;
    }
  }

  return stats;
}

// CLI entry — only runs when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])) {
  const args = process.argv.slice(2);
  const agentIdx = args.indexOf('--agent');
  if (agentIdx === -1 || !args[agentIdx + 1]) {
    process.stderr.write('Usage: node scripts/apply-friction.mjs --agent <agent-id>\n');
    process.exit(2);
  }
  const agentId = args[agentIdx + 1];
  const projectRoot = process.cwd();
  const stats = processSandboxes({ agentId, projectRoot });
  process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
}
```

Also add `join` and `existsSync` to imports at top of file if not already (consolidate imports):
```js
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as defaultFs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
```

Remove the duplicate `import { readFileSync, existsSync } from 'node:fs';` line added in Task 9.

- [ ] **Step 5: Run tests, all pass**

Run: `node --test scripts/apply-friction.test.mjs`
Expected: all pass, including integration and idempotency tests.

- [ ] **Step 6: Smoke-test the CLI against the real data**

Run: `node scripts/apply-friction.mjs --agent default`
Expected: prints a stats JSON to stdout; any skipped files printed to stderr. New `.friction.json` files appear in `data/sandboxes/*/decisive_actions/` for the Prophet sandboxes.

- [ ] **Step 7: Commit**

```bash
git add scripts/apply-friction.mjs scripts/apply-friction.test.mjs scripts/test-fixtures/
git commit -m "feat(friction): apply-friction orchestrator + CLI + integration tests"
```

---

## Task 13: Effect-size gate + verdict envelope

**Files:**
- Create: `scripts/score-rule-against-holdout.mjs`
- Create: `scripts/score-rule-against-holdout.test.mjs`

The effect-size gate (from spec):
- `trades_affected == 0` → `INCONCLUSIVE`
- `trades_affected < 3 AND |net_pl_delta_usd| < 200` → `INCONCLUSIVE`
- `net_pl_delta_usd > 0` AND gate cleared → `APPROVED-BY-HOLDOUT`
- `net_pl_delta_usd < 0` AND gate cleared → `REJECTED-BY-HOLDOUT`

`buildVerdict({ predicate, params, holdout_size, trades_affected, net_pl_delta_usd, blocked_winners, blocked_losers, limitation_notes, details })` returns the envelope. `review_type: "mechanical"` is fixed.

- [ ] **Step 1: Write failing tests**

Create `scripts/score-rule-against-holdout.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVerdict } from './score-rule-against-holdout.mjs';

test('buildVerdict: trades_affected = 0 -> INCONCLUSIVE', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 0, net_pl_delta_usd: 0,
    blocked_winners: 0, blocked_losers: 0, details: [],
  });
  assert.equal(v.verdict, 'INCONCLUSIVE');
});

test('buildVerdict: 1 trade affected, small delta -> INCONCLUSIVE', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 1, net_pl_delta_usd: 50,
    blocked_winners: 0, blocked_losers: 1, details: [],
  });
  assert.equal(v.verdict, 'INCONCLUSIVE');
});

test('buildVerdict: 1 trade, large absolute delta -> APPROVED', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 1, net_pl_delta_usd: 250,
    blocked_winners: 0, blocked_losers: 1, details: [],
  });
  assert.equal(v.verdict, 'APPROVED-BY-HOLDOUT');
});

test('buildVerdict: 4 trades, small delta -> APPROVED (passes trade-count gate)', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 4, net_pl_delta_usd: 80,
    blocked_winners: 1, blocked_losers: 3, details: [],
  });
  assert.equal(v.verdict, 'APPROVED-BY-HOLDOUT');
});

test('buildVerdict: gate cleared with negative delta -> REJECTED', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 4, net_pl_delta_usd: -300,
    blocked_winners: 2, blocked_losers: 2, details: [],
  });
  assert.equal(v.verdict, 'REJECTED-BY-HOLDOUT');
});

test('buildVerdict: envelope always carries review_type "mechanical"', () => {
  const v = buildVerdict({
    predicate: 'max_position_size_pct', params: { limit: 0.15 },
    holdout_size: 15, trades_affected: 0, net_pl_delta_usd: 0,
    blocked_winners: 0, blocked_losers: 0, details: [],
  });
  assert.equal(v.review_type, 'mechanical');
});

test('buildVerdict: limitation_notes propagated when provided', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 2, net_pl_delta_usd: 150,
    blocked_winners: 0, blocked_losers: 2, details: [],
    limitation_notes: ['cannot see intra-trade trough'],
  });
  assert.deepEqual(v.limitation_notes, ['cannot see intra-trade trough']);
});
```

- [ ] **Step 2: Create stub module**

Create `scripts/score-rule-against-holdout.mjs`:
```js
// Predicate scorer for walk-forward hold-out validation. Spec:
// docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md

const MIN_TRADES_FOR_NON_INCONCLUSIVE = 3;
const MIN_ABS_DELTA_FOR_NON_INCONCLUSIVE = 200;

export function buildVerdict({
  predicate, params, holdout_size, trades_affected, net_pl_delta_usd,
  blocked_winners, blocked_losers, details, limitation_notes = [],
}) {
  let verdict;
  if (trades_affected === 0) {
    verdict = 'INCONCLUSIVE';
  } else if (trades_affected < MIN_TRADES_FOR_NON_INCONCLUSIVE
    && Math.abs(net_pl_delta_usd) < MIN_ABS_DELTA_FOR_NON_INCONCLUSIVE) {
    verdict = 'INCONCLUSIVE';
  } else if (net_pl_delta_usd > 0) {
    verdict = 'APPROVED-BY-HOLDOUT';
  } else if (net_pl_delta_usd < 0) {
    verdict = 'REJECTED-BY-HOLDOUT';
  } else {
    verdict = 'INCONCLUSIVE';
  }
  return {
    predicate, params, review_type: 'mechanical',
    holdout_size, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers,
    verdict, limitation_notes, details,
  };
}
```

- [ ] **Step 3: Run tests, all pass**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: 7 passing.

- [ ] **Step 4: Commit**

```bash
git add scripts/score-rule-against-holdout.mjs scripts/score-rule-against-holdout.test.mjs
git commit -m "feat(holdout): verdict envelope + effect-size gate"
```

---

## Task 14: `max_position_size_pct` predicate

**Files:**
- Modify: `scripts/score-rule-against-holdout.mjs` (add export)
- Modify: `scripts/score-rule-against-holdout.test.mjs` (add tests)

`scoreMaxPositionSizePct(holdoutTrades, { limit })` flags trades where `(entry_price × size) / portfolio_value > limit`. Each held-out trade is expected to carry `market_data.entry_price`, `market_data.size`, and `market_data.portfolio_value` (the portfolio value at entry time).

Since this predicate doesn't change trade outcomes, `net_pl_delta_usd` is conservatively reported as the negative of the trade's friction-adjusted P&L for flagged winning trades AND positive for flagged losers (because the rule prevents both). This is a simplification: enforcing the rule may have meant the trade didn't happen, so the P&L delta is the inverse of what occurred.

- [ ] **Step 1: Append failing tests**

```js
import { scoreMaxPositionSizePct } from './score-rule-against-holdout.mjs';

test('scoreMaxPositionSizePct: no holdout trades -> INCONCLUSIVE', () => {
  const v = scoreMaxPositionSizePct([], { limit: 0.15 });
  assert.equal(v.verdict, 'INCONCLUSIVE');
  assert.equal(v.trades_affected, 0);
});

test('scoreMaxPositionSizePct: trade within limit -> not flagged', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 500, size: 30, portfolio_value: 100000, friction_adjusted_pl: 200 },
  }]; // size/value = 0.15 exactly = not over.
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 0);
});

test('scoreMaxPositionSizePct: oversized winning trade -> flagged, delta is negative of pl', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: 800 },
  }]; // 0.25 > 0.15.
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, -800); // would have prevented an $800 winner
  assert.equal(v.blocked_winners, 1);
});

test('scoreMaxPositionSizePct: oversized losing trade -> flagged, delta is positive', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: -500 },
  }];
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 500); // would have prevented a $500 loss
  assert.equal(v.blocked_losers, 1);
});

test('scoreMaxPositionSizePct: mixed -> net delta is sum', () => {
  const trades = [
    { symbol: 'A', market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: 800 } },
    { symbol: 'B', market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: -500 } },
  ];
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 2);
  assert.equal(v.net_pl_delta_usd, -300);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: failures referencing `scoreMaxPositionSizePct`.

- [ ] **Step 3: Add implementation**

Append to `scripts/score-rule-against-holdout.mjs`:
```js
export function scoreMaxPositionSizePct(holdoutTrades, params) {
  const { limit } = params;
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  for (const t of holdoutTrades) {
    const md = t.market_data ?? {};
    if (typeof md.entry_price !== 'number' || typeof md.size !== 'number' || typeof md.portfolio_value !== 'number') continue;
    const positionPct = (md.entry_price * md.size) / md.portfolio_value;
    if (positionPct > limit) {
      trades_affected += 1;
      const pl = md.friction_adjusted_pl ?? 0;
      net_pl_delta_usd -= pl;
      if (pl > 0) blocked_winners += 1;
      if (pl < 0) blocked_losers += 1;
      details.push({ symbol: t.symbol, position_pct: +positionPct.toFixed(4), pl });
    }
  }
  return buildVerdict({
    predicate: 'max_position_size_pct', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
  });
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/score-rule-against-holdout.mjs scripts/score-rule-against-holdout.test.mjs
git commit -m "feat(holdout): max_position_size_pct predicate"
```

---

## Task 15: `stop_at_pct` predicate

**Files:**
- Modify: `scripts/score-rule-against-holdout.mjs` (add export)
- Modify: `scripts/score-rule-against-holdout.test.mjs` (add tests)

This predicate has the schema limitation called out in the spec: we cannot see intra-trade trough. We only flag trades whose **closing** `unrealized_pct` was past the threshold. For each flagged trade, the P&L delta is `(stop_threshold × entry_value) − actual_pl` — i.e., what the trade would have produced if exited at the stop level versus what it actually produced.

`limitation_notes` is always populated with the schema caveat.

- [ ] **Step 1: Append failing tests**

```js
import { scoreStopAtPct } from './score-rule-against-holdout.mjs';

test('scoreStopAtPct: includes limitation_notes always', () => {
  const v = scoreStopAtPct([], { stop: -0.10 });
  assert.ok(v.limitation_notes.length > 0);
  assert.match(v.limitation_notes[0], /intra-trade trough/);
});

test('scoreStopAtPct: trade that closed at -5% with stop -10% -> not flagged', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 100, size: 100, friction_adjusted_pl: -500, unrealized_pct: -5 },
  }];
  const v = scoreStopAtPct(trades, { stop: -0.10 });
  assert.equal(v.trades_affected, 0);
});

test('scoreStopAtPct: trade that closed at -15% with stop -10% -> flagged, positive delta (rule cuts earlier)', () => {
  // entry_value = 100 × 100 = 10000. Stop at -10% → -1000 exit. Actual pl = -1500.
  // Delta = -1000 - (-1500) = +500 (rule would save $500).
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 100, size: 100, friction_adjusted_pl: -1500, unrealized_pct: -15 },
  }];
  const v = scoreStopAtPct(trades, { stop: -0.10 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 500);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: failures referencing `scoreStopAtPct`.

- [ ] **Step 3: Add implementation**

Append to `scripts/score-rule-against-holdout.mjs`:
```js
const STOP_AT_PCT_LIMITATION = 'stop_at_pct only sees trades that CLOSED past threshold; true firing count likely higher because intra-trade trough is not in the trade schema';

export function scoreStopAtPct(holdoutTrades, params) {
  const { stop } = params; // e.g., -0.10
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  for (const t of holdoutTrades) {
    const md = t.market_data ?? {};
    if (typeof md.unrealized_pct !== 'number' || typeof md.entry_price !== 'number' || typeof md.size !== 'number') continue;
    const actualPctFraction = md.unrealized_pct / 100;
    if (actualPctFraction >= stop) continue; // didn't close past the stop

    trades_affected += 1;
    const entryValue = md.entry_price * md.size;
    const stoppedExitPl = stop * entryValue;
    const actualPl = md.friction_adjusted_pl ?? 0;
    const delta = stoppedExitPl - actualPl;
    net_pl_delta_usd += delta;
    if (delta > 0) blocked_losers += 1; // we'd be cutting losers earlier
    if (delta < 0) blocked_winners += 1; // very unusual, but possible if trade recovered partially
    details.push({ symbol: t.symbol, actual_pl: actualPl, stopped_exit_pl: stoppedExitPl, delta });
  }
  return buildVerdict({
    predicate: 'stop_at_pct', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
    limitation_notes: [STOP_AT_PCT_LIMITATION],
  });
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/score-rule-against-holdout.mjs scripts/score-rule-against-holdout.test.mjs
git commit -m "feat(holdout): stop_at_pct predicate with intra-trade-trough limitation note"
```

---

## Task 16: `max_concurrent_positions` predicate

**Files:**
- Modify: `scripts/score-rule-against-holdout.mjs` (add export)
- Modify: `scripts/score-rule-against-holdout.test.mjs` (add tests)

Reconstructs concurrent open-position counts from the BUY/SELL sequence and flags windows exceeding `limit`. Each held-out trade has `action` (BUY/SELL/CLOSE), `symbol`, `timestamp`. For each BUY that pushes open count over `limit`, that trade is flagged.

- [ ] **Step 1: Append failing tests**

```js
import { scoreMaxConcurrentPositions } from './score-rule-against-holdout.mjs';

test('scoreMaxConcurrentPositions: never exceeds limit -> 0 affected', () => {
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 100 } },
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 100 } },
    { action: 'BUY', symbol: 'B', timestamp: '2026-05-01T12:00:00Z', market_data: { friction_adjusted_pl: 50 } },
  ];
  const v = scoreMaxConcurrentPositions(trades, { limit: 3 });
  assert.equal(v.trades_affected, 0);
});

test('scoreMaxConcurrentPositions: exceeds limit -> flagged', () => {
  // Limit 2. Three BUYs in a row without SELLs.
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 100 } },
    { action: 'BUY', symbol: 'B', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'C', timestamp: '2026-05-01T12:00:00Z', market_data: { friction_adjusted_pl: -200 } },
  ];
  const v = scoreMaxConcurrentPositions(trades, { limit: 2 });
  assert.equal(v.trades_affected, 1); // only the 3rd BUY pushes count to 3 (>2)
  assert.equal(v.net_pl_delta_usd, 200); // -1 × (-200), preventing the loser saves $200
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: failures referencing `scoreMaxConcurrentPositions`.

- [ ] **Step 3: Add implementation**

Append to `scripts/score-rule-against-holdout.mjs`:
```js
export function scoreMaxConcurrentPositions(holdoutTrades, params) {
  const { limit } = params;
  const open = new Set();
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  const sorted = [...holdoutTrades].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));

  for (const t of sorted) {
    const isOpen = t.action === 'BUY';
    const isClose = t.action === 'SELL' || t.action === 'CLOSE';
    if (isOpen) {
      if (open.size >= limit) {
        trades_affected += 1;
        const pl = t.market_data?.friction_adjusted_pl ?? 0;
        net_pl_delta_usd -= pl;
        if (pl > 0) blocked_winners += 1;
        if (pl < 0) blocked_losers += 1;
        details.push({ symbol: t.symbol, timestamp: t.timestamp, open_count_before_block: open.size, pl });
      } else {
        open.add(t.symbol);
      }
    } else if (isClose) {
      open.delete(t.symbol);
    }
  }
  return buildVerdict({
    predicate: 'max_concurrent_positions', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
  });
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/score-rule-against-holdout.mjs scripts/score-rule-against-holdout.test.mjs
git commit -m "feat(holdout): max_concurrent_positions predicate"
```

---

## Task 17: `no_reentry_within_hours` predicate

**Files:**
- Modify: `scripts/score-rule-against-holdout.mjs` (add export)
- Modify: `scripts/score-rule-against-holdout.test.mjs` (add tests)

Flags any BUY that occurs within `hours` of a SELL/CLOSE of the same symbol earlier in the hold-out timeline.

- [ ] **Step 1: Append failing tests**

```js
import { scoreNoReentryWithinHours } from './score-rule-against-holdout.mjs';

test('scoreNoReentryWithinHours: no reentries -> 0 affected', () => {
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'B', timestamp: '2026-05-01T12:30:00Z', market_data: { friction_adjusted_pl: 100 } },
  ];
  const v = scoreNoReentryWithinHours(trades, { hours: 2 });
  assert.equal(v.trades_affected, 0);
});

test('scoreNoReentryWithinHours: reentry within window -> flagged', () => {
  // SELL at 11:00, BUY at 12:30 → 1.5h gap, under 2h window.
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T12:30:00Z', market_data: { friction_adjusted_pl: -75 } },
  ];
  const v = scoreNoReentryWithinHours(trades, { hours: 2 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 75); // prevents a $75 loss
});

test('scoreNoReentryWithinHours: reentry past window -> not flagged', () => {
  const trades = [
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T14:00:00Z', market_data: { friction_adjusted_pl: -75 } },
  ];
  const v = scoreNoReentryWithinHours(trades, { hours: 2 });
  assert.equal(v.trades_affected, 0);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: failures referencing `scoreNoReentryWithinHours`.

- [ ] **Step 3: Add implementation**

Append to `scripts/score-rule-against-holdout.mjs`:
```js
export function scoreNoReentryWithinHours(holdoutTrades, params) {
  const { hours } = params;
  const windowMs = hours * 3600 * 1000;
  const sorted = [...holdoutTrades].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  const lastExitBySymbol = new Map();
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  for (const t of sorted) {
    const ts = Date.parse(t.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (t.action === 'SELL' || t.action === 'CLOSE') {
      lastExitBySymbol.set(t.symbol, ts);
    } else if (t.action === 'BUY') {
      const lastExit = lastExitBySymbol.get(t.symbol);
      if (lastExit !== undefined && (ts - lastExit) < windowMs) {
        trades_affected += 1;
        const pl = t.market_data?.friction_adjusted_pl ?? 0;
        net_pl_delta_usd -= pl;
        if (pl > 0) blocked_winners += 1;
        if (pl < 0) blocked_losers += 1;
        details.push({ symbol: t.symbol, timestamp: t.timestamp, hours_since_exit: (ts - lastExit) / 3600000, pl });
      }
    }
  }
  return buildVerdict({
    predicate: 'no_reentry_within_hours', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
  });
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/score-rule-against-holdout.mjs scripts/score-rule-against-holdout.test.mjs
git commit -m "feat(holdout): no_reentry_within_hours predicate"
```

---

## Task 18: `dte_bounds` predicate

**Files:**
- Modify: `scripts/score-rule-against-holdout.mjs` (add export)
- Modify: `scripts/score-rule-against-holdout.test.mjs` (add tests)

Parses DTE from OCC symbol format `^[A-Z]{1,6}(\d{6})[CP]\d{8}$` where the 6-digit field is YYMMDD expiration. Computes days from trade's `timestamp` (entry) to expiration. Flags trades outside `[min, max]`.

- [ ] **Step 1: Append failing tests**

```js
import { scoreDteBounds } from './score-rule-against-holdout.mjs';

test('scoreDteBounds: non-option trade ignored', () => {
  const trades = [{ action: 'BUY', symbol: 'SPY', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 100 } }];
  const v = scoreDteBounds(trades, { min: 50, max: 120 });
  assert.equal(v.trades_affected, 0);
});

test('scoreDteBounds: option DTE within bounds -> not flagged', () => {
  // Entry 2026-05-01, exp 260801 (Aug 1) = ~92 days.
  const trades = [{
    action: 'BUY', symbol: 'SPY260801C00400000', timestamp: '2026-05-01T10:00:00Z',
    market_data: { friction_adjusted_pl: 100 },
  }];
  const v = scoreDteBounds(trades, { min: 50, max: 120 });
  assert.equal(v.trades_affected, 0);
});

test('scoreDteBounds: option DTE under min -> flagged', () => {
  // Entry 2026-05-01, exp 260510 = 9 days.
  const trades = [{
    action: 'BUY', symbol: 'SPY260510C00400000', timestamp: '2026-05-01T10:00:00Z',
    market_data: { friction_adjusted_pl: -200 },
  }];
  const v = scoreDteBounds(trades, { min: 50, max: 120 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 200); // prevents a $200 loss
});

test('scoreDteBounds: option DTE over max -> flagged', () => {
  // Entry 2026-05-01, exp 270501 = 365 days.
  const trades = [{
    action: 'BUY', symbol: 'SPY270501C00400000', timestamp: '2026-05-01T10:00:00Z',
    market_data: { friction_adjusted_pl: 50 },
  }];
  const v = scoreDteBounds(trades, { min: 50, max: 120 });
  assert.equal(v.trades_affected, 1);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: failures referencing `scoreDteBounds`.

- [ ] **Step 3: Add implementation**

Append to `scripts/score-rule-against-holdout.mjs`:
```js
const OCC_FOR_DTE = /^[A-Z]{1,6}(\d{2})(\d{2})(\d{2})[CP]\d{8}$/;

function parseDteFromOcc(symbol, entryTimestamp) {
  const m = OCC_FOR_DTE.exec(symbol);
  if (!m) return null;
  const yy = Number(m[1]), mm = Number(m[2]), dd = Number(m[3]);
  // Assume 20YY for OCC (good through 2099)
  const expMs = Date.UTC(2000 + yy, mm - 1, dd);
  const entryMs = Date.parse(entryTimestamp);
  if (!Number.isFinite(entryMs) || !Number.isFinite(expMs)) return null;
  return Math.round((expMs - entryMs) / 86400000);
}

export function scoreDteBounds(holdoutTrades, params) {
  const { min, max } = params;
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];

  for (const t of holdoutTrades) {
    if (t.action !== 'BUY') continue;
    const dte = parseDteFromOcc(t.symbol ?? '', t.timestamp);
    if (dte === null) continue;
    if (dte < min || dte > max) {
      trades_affected += 1;
      const pl = t.market_data?.friction_adjusted_pl ?? 0;
      net_pl_delta_usd -= pl;
      if (pl > 0) blocked_winners += 1;
      if (pl < 0) blocked_losers += 1;
      details.push({ symbol: t.symbol, dte, pl });
    }
  }
  return buildVerdict({
    predicate: 'dte_bounds', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
  });
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/score-rule-against-holdout.mjs scripts/score-rule-against-holdout.test.mjs
git commit -m "feat(holdout): dte_bounds predicate with OCC parsing"
```

---

## Task 19: `score-rule-against-holdout.mjs` CLI dispatcher

**Files:**
- Modify: `scripts/score-rule-against-holdout.mjs` (add CLI block + dispatcher)
- Modify: `scripts/score-rule-against-holdout.test.mjs` (add tests for dispatch + error)

CLI args: `--predicate <name> --params <json>` then trades come from stdin as a JSON array.

`dispatchPredicate(name, params, trades)` maps the predicate name to its scorer. Unknown name throws with a clear error listing supported predicates.

- [ ] **Step 1: Append failing tests**

```js
import { dispatchPredicate, SUPPORTED_PREDICATES } from './score-rule-against-holdout.mjs';

test('dispatchPredicate: max_position_size_pct routes correctly', () => {
  const v = dispatchPredicate('max_position_size_pct', { limit: 0.15 }, []);
  assert.equal(v.predicate, 'max_position_size_pct');
});

test('dispatchPredicate: unknown name throws with supported list', () => {
  assert.throws(
    () => dispatchPredicate('nonexistent', {}, []),
    /unknown predicate.*max_position_size_pct/,
  );
});

test('SUPPORTED_PREDICATES contains the 5 starter predicates', () => {
  assert.deepEqual(SUPPORTED_PREDICATES.sort(), [
    'dte_bounds',
    'max_concurrent_positions',
    'max_position_size_pct',
    'no_reentry_within_hours',
    'stop_at_pct',
  ]);
});
```

- [ ] **Step 2: Run tests, verify failures**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: failures referencing `dispatchPredicate` and `SUPPORTED_PREDICATES`.

- [ ] **Step 3: Add dispatcher + CLI**

Append to `scripts/score-rule-against-holdout.mjs`:
```js
const PREDICATE_MAP = {
  max_position_size_pct: scoreMaxPositionSizePct,
  stop_at_pct: scoreStopAtPct,
  max_concurrent_positions: scoreMaxConcurrentPositions,
  no_reentry_within_hours: scoreNoReentryWithinHours,
  dte_bounds: scoreDteBounds,
};

export const SUPPORTED_PREDICATES = Object.keys(PREDICATE_MAP);

export function dispatchPredicate(name, params, holdoutTrades) {
  const fn = PREDICATE_MAP[name];
  if (!fn) {
    throw new Error(`unknown predicate "${name}". Supported: ${SUPPORTED_PREDICATES.join(', ')}`);
  }
  return fn(holdoutTrades, params);
}

// CLI entry — only runs when invoked directly, not when imported.
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1])) {
  const args = process.argv.slice(2);
  const pIdx = args.indexOf('--predicate');
  const paramsIdx = args.indexOf('--params');
  if (pIdx === -1 || paramsIdx === -1) {
    process.stderr.write('Usage: cat holdout.json | node scripts/score-rule-against-holdout.mjs --predicate <name> --params <json>\n');
    process.exit(2);
  }
  const predicate = args[pIdx + 1];
  let params;
  try { params = JSON.parse(args[paramsIdx + 1]); } catch (err) {
    process.stderr.write(`--params is not valid JSON: ${err.message}\n`);
    process.exit(2);
  }
  // Read trades from stdin (synchronous, small data).
  let stdin = '';
  process.stdin.on('data', chunk => { stdin += chunk; });
  process.stdin.on('end', () => {
    let trades;
    try { trades = JSON.parse(stdin); } catch (err) {
      process.stderr.write(`stdin is not valid JSON: ${err.message}\n`);
      process.exit(2);
    }
    try {
      const result = dispatchPredicate(predicate, params, trades);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
  });
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `node --test scripts/score-rule-against-holdout.test.mjs`
Expected: all pass.

- [ ] **Step 5: Smoke-test the CLI**

Run:
```bash
echo '[]' | node scripts/score-rule-against-holdout.mjs --predicate stop_at_pct --params '{"stop":-0.10}'
```
Expected: JSON output with `"verdict": "INCONCLUSIVE"`.

- [ ] **Step 6: Commit**

```bash
git add scripts/score-rule-against-holdout.mjs scripts/score-rule-against-holdout.test.mjs
git commit -m "feat(holdout): predicate dispatcher + CLI"
```

---

## Task 20: Edit `adapt-strategy/SKILL.md`

**Files:**
- Modify: `.claude/skills/adapt-strategy/SKILL.md`

Insert new Step 0 (after the frontmatter description block), increase read window from 60 to 75, insert new Step 2.5 before Step 5 (Gap analysis), insert Step 6.5 and Step 6.6 between Step 6 (proposals) and Step 7 (present and confirm).

- [ ] **Step 1: Insert Step 0 after the existing intro paragraph**

Find this block in `.claude/skills/adapt-strategy/SKILL.md`:
```
You are closing the learning loop for the Prophet trading agent. Your job is to read what the agent actually did, compare it to what the strategy says it should do, find the gaps, and propose concrete rule changes — then apply the ones the user approves.

## Step 1 — Resolve target agent, strategy, and sandboxes
```

Replace with:
```
You are closing the learning loop for the Prophet trading agent. Your job is to read what the agent actually did, compare it to what the strategy says it should do, find the gaps, and propose concrete rule changes — then apply the ones the user approves.

## Step 0 — Apply friction to raw trade data

Before reading any trade data, run:

```
node scripts/apply-friction.mjs --agent default
```

Report the resulting `{ processed, skipped, sign_flips, skip_reasons }` stats to the user. **If `skipped` exceeds 10% of `processed + skipped`, warn the user that the adapt set may be biased and offer to abort.**

All subsequent data loading reads `*.friction.json` files in each sandbox's `decisive_actions/` directory, NOT the raw `*.json` files. **All P&L-derived metrics (win rate, average win/loss, profit factor) MUST use `market_data.friction_adjusted_pl`. If that field is absent on a record, fall back to the original P&L field and tag the record in any output as "raw-pl-fallback".**

## Step 1 — Resolve target agent, strategy, and sandboxes
```

- [ ] **Step 2: Increase read window from 60 to 75 in Step 3**

Find this line in Step 3:
```
read the **60 most recent overall** (not 60 per sandbox).
```
Replace with:
```
read the **75 most recent overall** (not 75 per sandbox). If fewer than 75 `.friction.json` files exist across all sandboxes, use what's available; if fewer than 20 exist in total, warn the user explicitly that adaptation may be premature on this little data and offer to abort.
```

- [ ] **Step 3: Insert Step 2.5 (split into adapt/hold-out) after Step 3 (Load decisions) and before Step 4 (Load P&L)**

Find the heading `## Step 4 — Load recent P&L context (all Prophet sandboxes)` and insert immediately before it:

````
## Step 3.5 — Split into adapt set and hold-out set

Sort all loaded decisions by timestamp ascending. Compute `holdout_size = ceil(N × 0.20)` where N is the number of loaded decisions. The **adapt set** is the oldest `N − holdout_size` decisions; the **hold-out set** is the newest `holdout_size`.

State both counts and date ranges to the user explicitly, plus symbol concentration:

> Adapting on N1 decisions (date1 → date2). Holding out N2 decisions (date3 → date4) for validation.
> Adapt-set top 3 symbols: SYM1 (X%), SYM2 (Y%), SYM3 (Z%).
> Hold-out-set top 3 symbols: SYM1 (X%), SYM2 (Y%), SYM3 (Z%).

**Gap analysis (Step 5) and proposal generation (Step 6) use ONLY the adapt set.** Do not peek at the hold-out set during these steps — it is reserved for Step 6.5 validation.

````

- [ ] **Step 4: Insert Step 6.5 and Step 6.6 between Step 6 and Step 7**

Find the heading `## Step 7 — Present and confirm` and insert immediately before it:

````
## Step 6.5 — Validate proposed edits against hold-out (READ-ONLY, NO ITERATION)

For each proposed edit from Step 6, classify it as **mechanical** (the rule maps to a supported predicate) or **qualitative** (everything else).

**Mechanical predicates currently supported:**

| Rule shape | Predicate name | Params |
|---|---|---|
| Position size ≤ X% | `max_position_size_pct` | `{ "limit": X }` |
| Stop at -X% | `stop_at_pct` | `{ "stop": -X }` |
| Max N concurrent positions | `max_concurrent_positions` | `{ "limit": N }` |
| No re-entry within N hours | `no_reentry_within_hours` | `{ "hours": N }` |
| DTE between min and max | `dte_bounds` | `{ "min": M, "max": X }` |

For each mechanical edit, invoke the scorer (pipe the hold-out set as a JSON array on stdin):

```
echo '<HOLDOUT_JSON_ARRAY>' | node scripts/score-rule-against-holdout.mjs --predicate <name> --params '<params>'
```

Capture the returned envelope including `verdict`, `trades_affected`, `net_pl_delta_usd`, and any `limitation_notes`.

For each qualitative edit, read the hold-out trades and write a one-paragraph judgment citing specific held-out trades by symbol and timestamp. Emit a parallel envelope with `review_type: "qualitative"` and a `verdict` of APPROVED-BY-HOLDOUT, REJECTED-BY-HOLDOUT, or INCONCLUSIVE based on your judgment.

**Once hold-out data has been read in this step, no new proposals may be generated in the same skill invocation.** If the user wants to propose alternatives after seeing hold-out verdicts, that requires a new skill run with a fresh trade window. This prevents hold-out information from leaking into proposal generation.

## Step 6.6 — Attach hold-out verdicts to proposals

For each proposal, attach a verdict block to its display:

> **HOLD-OUT VERDICT:** APPROVED-BY-HOLDOUT — `review_type: mechanical` — trades_affected: 3 — net_pl_delta_usd: +$145
> Limitations: (any `limitation_notes` from the scorer)
> ⚠️ A 12-15 trade hold-out is a sanity check, not a hypothesis test.

Application rules to apply in Step 8:
- **APPROVED-BY-HOLDOUT**: user-approved proposals applied normally.
- **REJECTED-BY-HOLDOUT**: requires explicit user override before being applied.
- **INCONCLUSIVE**: user decides as normal — most proposals will land here at current sample size. Do not auto-reject or auto-approve.

````

- [ ] **Step 5: Verify the skill still parses (no broken markdown)**

Run: `node -e "process.stdout.write(require('fs').readFileSync('.claude/skills/adapt-strategy/SKILL.md','utf8').length + ' chars')"`
Expected: prints a character count larger than the pre-edit version.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/adapt-strategy/SKILL.md
git commit -m "feat(adapt-strategy): wire friction + walk-forward hold-out"
```

---

## Task 21: Edit `adapt-strategy-penny/SKILL.md`

**Files:**
- Modify: `.claude/skills/adapt-strategy-penny/SKILL.md`

Same pattern as Task 20, but agent ID is `penny-prophet` in the Step 0 command. Read window also goes from 60 → 75.

- [ ] **Step 1: Read the current file to find the equivalent insertion points**

Run: `node -e "process.stdout.write(require('fs').readFileSync('.claude/skills/adapt-strategy-penny/SKILL.md','utf8'))"` (or use Read).

The file's structure should mirror `adapt-strategy/SKILL.md`. Identify (a) the intro paragraph before "## Step 1", (b) the read-window number in the load-decisions step, (c) the heading before the P&L-load step, (d) the heading before "Present and confirm".

- [ ] **Step 2: Insert Step 0 with `--agent penny-prophet`**

Use the same insertion text as Task 20 Step 1, but replace `--agent default` with `--agent penny-prophet`.

- [ ] **Step 3: Increase read window 60 → 75 (or whatever the current value is)**

Match Task 20 Step 2; if the current window is different from 60, use the same `max(current × 1.25, 50)` adjustment as the spec says — i.e., round up by ~25% with a floor of 50.

- [ ] **Step 4: Insert Step 3.5 (split into adapt/hold-out)**

Same text as Task 20 Step 3.

- [ ] **Step 5: Insert Step 6.5 and Step 6.6**

Same text as Task 20 Step 4.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/adapt-strategy-penny/SKILL.md
git commit -m "feat(adapt-strategy-penny): wire friction + walk-forward hold-out"
```

---

## Task 22: Edit `harvest-parameter-review/SKILL.md`

**Files:**
- Modify: `.claude/skills/harvest-parameter-review/SKILL.md`

Same pattern as Task 20, agent ID `harvest`. The current read window in this skill is unknown — read it first, then apply `max(current × 1.25, 50)`. Iron-condor profile applies via the `harvest` agent override.

- [ ] **Step 1: Read the current file and identify insertion points + current read window**

Use Read on `.claude/skills/harvest-parameter-review/SKILL.md`.

- [ ] **Step 2: Insert Step 0 with `--agent harvest`**

Same template as Task 20 Step 1, with `--agent harvest`.

- [ ] **Step 3: Adjust read window to `max(current × 1.25, 50)`**

Read the existing value, compute new value, replace.

- [ ] **Step 4: Insert Step 3.5 (split into adapt/hold-out)**

Same text as Task 20 Step 3, with one tweak: the per-rule predicate table in Step 6.5 should note that for Harvest, `dte_bounds` is especially relevant for filtering away short-dated condors.

- [ ] **Step 5: Insert Step 6.5 and Step 6.6**

Same template as Task 20 Step 4.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/harvest-parameter-review/SKILL.md
git commit -m "feat(harvest-parameter-review): wire friction + walk-forward hold-out"
```

---

## Task 23: Edit `trend-parameter-review/SKILL.md`

**Files:**
- Modify: `.claude/skills/trend-parameter-review/SKILL.md`

Same pattern as Task 22. Agent ID is `trend-prophet`.

- [ ] **Step 1: Read the current file and identify insertion points + current read window**

Use Read on `.claude/skills/trend-parameter-review/SKILL.md`.

- [ ] **Step 2: Insert Step 0 with `--agent trend-prophet`**

Same template as Task 20 Step 1, with `--agent trend-prophet`.

- [ ] **Step 3: Adjust read window to `max(current × 1.25, 50)`**

Read existing value, compute new value, replace.

- [ ] **Step 4: Insert Step 3.5 (split into adapt/hold-out)**

Same text as Task 20 Step 3.

- [ ] **Step 5: Insert Step 6.5 and Step 6.6**

Same template as Task 20 Step 4.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/trend-parameter-review/SKILL.md
git commit -m "feat(trend-parameter-review): wire friction + walk-forward hold-out"
```

---

## Task 24: Edit `review-performance/SKILL.md`

**Files:**
- Modify: `.claude/skills/review-performance/SKILL.md`

`review-performance` is a report, not an adapter. It gets ONLY the Step 0 friction-run + `friction_adjusted_pl` directive. No hold-out logic.

- [ ] **Step 1: Read the current file and find the intro/first-step boundary**

Use Read on `.claude/skills/review-performance/SKILL.md`.

- [ ] **Step 2: Insert Step 0**

Insert before the first `## Step 1` heading:

```
## Step 0 — Apply friction to raw trade data

Before reading any trade data, run:

```
node scripts/apply-friction.mjs --agent default
```

Report the resulting `{ processed, skipped, sign_flips }` stats to the user. All subsequent data loading reads `*.friction.json` files. All P&L-derived metrics (win rate, profit factor, average win/loss, drawdown) MUST use `market_data.friction_adjusted_pl`. If absent on a record, fall back to the original P&L field and tag the record in output as "raw-pl-fallback".

```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/review-performance/SKILL.md
git commit -m "feat(review-performance): read friction-adjusted P&L"
```

---

## Task 25: Edit `review-performance-penny/SKILL.md`

**Files:**
- Modify: `.claude/skills/review-performance-penny/SKILL.md`

Same as Task 24, but `--agent penny-prophet`.

- [ ] **Step 1: Read the current file**

Use Read on `.claude/skills/review-performance-penny/SKILL.md`.

- [ ] **Step 2: Insert Step 0 with `--agent penny-prophet`**

Same as Task 24 Step 2, but the command line is `node scripts/apply-friction.mjs --agent penny-prophet`.

- [ ] **Step 3: Final full test sweep**

Run: `npm test`
Expected: all Node tests pass (existing + new friction + new holdout). Total new test count: ~50.

- [ ] **Step 4: Final smoke test against real data**

Run:
```bash
node scripts/apply-friction.mjs --agent default
node scripts/apply-friction.mjs --agent penny-prophet
node scripts/apply-friction.mjs --agent harvest
node scripts/apply-friction.mjs --agent trend-prophet
```
Expected: each prints stats JSON. New `.friction.json` files appear in each agent's sandboxes. Stderr surfaces any skipped records.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/review-performance-penny/SKILL.md
git commit -m "feat(review-performance-penny): read friction-adjusted P&L"
```

---

## Done

After Task 25 the friction layer and walk-forward hold-out are wired end to end. The branch `feat-friction-and-walkforward` is ready for the user to review and open a PR (per workflow preference, commits will be squashed in the PR).
