# Foundation B — Component 2a: Per-Trade Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-agent, friction-adjusted closed-trade ledger (win rate, profit factor, expectancy @1×/@2×, per-trade bootstrap CI, marked-equity bias check) from closed `managed_positions`, reusing Component 3 + `apply-friction`.

**Architecture:** One ESM module `scripts/trade-ledger.mjs` of small pure functions plus a `node:sqlite` open-position reader and a CLI guard. It imports Component 3's reader/eligibility/derive and routes each closed position through `apply-friction` via an adapter whose stop-out flag comes from Component 3's `deriveExitReason` (D-B8). Pure functions are unit-tested; the CLI is verified by a real-data smoke on the Coil sandbox.

**Tech Stack:** Node ≥ 22.5 (`node:sqlite` `DatabaseSync`), `node:test`, ESM. Reuses `scripts/managed-position-repair.mjs` (Component 3) and `scripts/apply-friction.mjs`.

**Spec:** `docs/superpowers/specs/2026-05-31-foundation-b-component2-measurement-design.md` (§3, §6, §7).

**Branch:** `foundation-b-c2-measurement` (already created off the C3 commit; the C2 spec commit `beb41a1` is on it). All task commits land here; squash at the finish-branch step.

**File structure:**
- Create: `scripts/trade-ledger.mjs` — the whole of 2a (adapter, stress config, open reader, metrics, ledger, marked-equity, bootstrap, report, CLI).
- Create: `scripts/trade-ledger.test.mjs` — co-located `node:test` suite.

**Shared test config** (used by several tasks — define once at the top of the test file in Task 1):
```js
export const TEST_CFG = {
  version: 'test',
  stocks: { per_share_slippage_usd: 0.01, regulatory_fee_per_share: 0.0001, commission_per_share: 0, stop_gap_through_pct: 0.003 },
  penny_stocks: { per_share_slippage_usd: 0.01, slippage_pct_of_price_floor: 0.001, regulatory_fee_per_share: 0.0001, commission_per_share: 0, stop_gap_through_pct: 0.01 },
  single_leg_options: { assumed_spread_pct_of_mid: 0.05, spread_crossing_pct_open: 0.5, spread_crossing_pct_close: 0.5, spread_crossing_pct_close_when_losing: 0.75, commission_per_contract: 0.65, regulatory_fee_per_contract: 0.01 },
  iron_condor: { assumed_spread_pct_of_credit: 0.1, spread_crossing_pct_close: 0.5, spread_crossing_pct_close_when_losing: 0.75, commission_per_contract: 0.65, regulatory_fee_per_contract: 0.01, leg_count: 4 },
};
```

---

### Task 1: `toFrictionAction` — managed position → apply-friction action shape

**Files:** Create `scripts/trade-ledger.mjs`, `scripts/trade-ledger.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/trade-ledger.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFrictionAction } from './trade-ledger.mjs';

export const TEST_CFG = {
  version: 'test',
  stocks: { per_share_slippage_usd: 0.01, regulatory_fee_per_share: 0.0001, commission_per_share: 0, stop_gap_through_pct: 0.003 },
  penny_stocks: { per_share_slippage_usd: 0.01, slippage_pct_of_price_floor: 0.001, regulatory_fee_per_share: 0.0001, commission_per_share: 0, stop_gap_through_pct: 0.01 },
  single_leg_options: { assumed_spread_pct_of_mid: 0.05, spread_crossing_pct_open: 0.5, spread_crossing_pct_close: 0.5, spread_crossing_pct_close_when_losing: 0.75, commission_per_contract: 0.65, regulatory_fee_per_contract: 0.01 },
  iron_condor: { assumed_spread_pct_of_credit: 0.1, spread_crossing_pct_close: 0.5, spread_crossing_pct_close_when_losing: 0.75, commission_per_contract: 0.65, regulatory_fee_per_contract: 0.01, leg_count: 4 },
};

const longStop = { symbol: 'AAPL', side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110, exitPrice: 94.9, realizedPnl: -510, realizedPnlPct: -5.1, quantity: 100, storedStatus: 'STOPPED_OUT', notes: 'x' };
const longSignal = { symbol: 'MSFT', side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110, exitPrice: 103, realizedPnl: 300, realizedPnlPct: 3, quantity: 100, storedStatus: 'CLOSED', notes: 'took profit early' };

test('toFrictionAction maps fields into apply-friction action shape', () => {
  const a = toFrictionAction(longSignal, 'mean-rev-rsi2');
  assert.equal(a.symbol, 'MSFT');
  assert.deepEqual(a.market_data, { entry_price: 100, exit_price: 103, size: 100, unrealized_pl: 300, unrealized_pct: 3 });
});

test('toFrictionAction sets reasoning="stopped out" iff derived exit is a stop', () => {
  assert.equal(toFrictionAction(longStop, 'mean-rev-rsi2').reasoning, 'stopped out');
  assert.equal(toFrictionAction(longSignal, 'mean-rev-rsi2').reasoning, 'took profit early');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: FAIL — `Cannot find module './trade-ledger.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/trade-ledger.mjs`:

```js
// Foundation B Component 2a — per-agent friction-adjusted closed-trade ledger.
// Reuses Component 3 (managed-position-repair.mjs) + apply-friction.mjs. Read-only.
// Spec: docs/superpowers/specs/2026-05-31-foundation-b-component2-measurement-design.md

import { deriveExitReason } from './managed-position-repair.mjs';

// Map a Component-3 closed-position object to the action shape applyFriction
// consumes. The stop-out flag is driven by Component 3's derived classification
// (D-B8), so apply-friction's stop-gap-through haircut fires on a derived losing
// stop — note isStopOut also requires unrealized_pct < 0 (a profitable trailing
// stop gets base friction only).
export function toFrictionAction(position, agentId) {
  const isStop = deriveExitReason(position).derived === 'stop';
  return {
    symbol: position.symbol,
    reasoning: isStop ? 'stopped out' : (position.notes ?? ''),
    market_data: {
      entry_price: position.entryPrice,
      exit_price: position.exitPrice,
      size: position.quantity,
      unrealized_pl: position.realizedPnl,
      unrealized_pct: position.realizedPnlPct,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: PASS (2 tests). (`node:sqlite` experimental warning may appear once the reader lands — non-fatal.)

- [ ] **Step 5: Commit**

```bash
git add scripts/trade-ledger.mjs scripts/trade-ledger.test.mjs
git commit -m "feat(component2a): toFrictionAction adapter (stop-out from derived reason)"
```

---

### Task 2: `buildStressConfig` — 2× only the uncertain frictions

**Files:** Modify `scripts/trade-ledger.mjs`, `scripts/trade-ledger.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/trade-ledger.test.mjs`:

```js
import { buildStressConfig } from './trade-ledger.mjs';

test('buildStressConfig doubles uncertain frictions, leaves deterministic fees', () => {
  const stress = buildStressConfig(TEST_CFG);
  // uncertain → doubled
  assert.equal(stress.stocks.per_share_slippage_usd, 0.02);
  assert.equal(stress.stocks.stop_gap_through_pct, 0.006);
  assert.equal(stress.penny_stocks.slippage_pct_of_price_floor, 0.002);
  assert.equal(stress.single_leg_options.assumed_spread_pct_of_mid, 0.10);
  // deterministic fees → unchanged
  assert.equal(stress.stocks.regulatory_fee_per_share, 0.0001);
  assert.equal(stress.single_leg_options.commission_per_contract, 0.65);
  // baseline not mutated
  assert.equal(TEST_CFG.stocks.per_share_slippage_usd, 0.01);
  assert.match(stress.version, /stress2x/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: FAIL — `buildStressConfig` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/trade-ledger.mjs`:

```js
// Build a 2× stress friction config by doubling ONLY the genuinely uncertain
// frictions (slippage, gap-through, assumed spread). Deterministic fees
// (commission, regulatory) are exact known costs with no worse-than-modeled
// tail — doubling them would inflate the gate with fictional cost.
const STRESS_KEYS = [
  'per_share_slippage_usd', 'slippage_pct_of_price_floor', 'stop_gap_through_pct',
  'assumed_spread_pct_of_mid', 'assumed_spread_pct_of_credit',
];
const FRICTION_PROFILES = ['stocks', 'penny_stocks', 'single_leg_options', 'iron_condor'];

export function buildStressConfig(baseline) {
  const out = structuredClone(baseline);
  for (const profileKey of FRICTION_PROFILES) {
    const p = out[profileKey];
    if (!p) continue;
    for (const k of STRESS_KEYS) {
      if (typeof p[k] === 'number') p[k] *= 2;
    }
  }
  out.version = `${baseline.version ?? 'v?'}-stress2x`;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: PASS (all through Task 2).

- [ ] **Step 5: Commit**

```bash
git add scripts/trade-ledger.mjs scripts/trade-ledger.test.mjs
git commit -m "feat(component2a): buildStressConfig (2x uncertain frictions only)"
```

---

### Task 3: `readOpenManagedPositions` — node:sqlite open-position reader

**Files:** Modify `scripts/trade-ledger.mjs`, `scripts/trade-ledger.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/trade-ledger.test.mjs`:

```js
import { readOpenManagedPositions } from './trade-ledger.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('readOpenManagedPositions returns ACTIVE+PARTIAL only, mapped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'));
  const dbPath = join(dir, 'prophet_trader.db');
  try {
    const seed = new DatabaseSync(dbPath);
    seed.exec(`CREATE TABLE managed_positions (
      position_id TEXT, symbol TEXT, side TEXT, agent_strategy TEXT, quantity REAL,
      entry_price REAL, stop_loss_price REAL, take_profit_price REAL, status TEXT,
      current_price REAL, unrealized_pl REAL, unrealized_plpc REAL, remaining_qty REAL,
      notes TEXT, created_at datetime, closed_at datetime )`);
    const ins = seed.prepare(`INSERT INTO managed_positions
      (position_id,symbol,side,agent_strategy,quantity,entry_price,status,current_price,unrealized_pl,unrealized_plpc,remaining_qty,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('o1','WMT','buy','mean-rev-rsi2',10,118.47,'ACTIVE',120,15.3,1.29,10,'2026-06-02 10:00:00.0-04:00');
    ins.run('o2','DE','buy','mean-rev-rsi2',5,529,'PARTIAL',540,55,2.0,3,'2026-06-02 10:00:00.0-04:00');
    ins.run('o3','COST','buy','mean-rev-rsi2',1,1004,'CLOSED',1019,59,1.4,1,'2026-05-26 14:46:00.0-05:00');
    seed.close();

    const rows = readOpenManagedPositions(dbPath);
    assert.equal(rows.length, 2);
    const wmt = rows.find(r => r.symbol === 'WMT');
    assert.equal(wmt.unrealizedPl, 15.3);
    assert.equal(wmt.quantity, 10);
    assert.equal(wmt.agentStrategy, 'mean-rev-rsi2');
    assert.equal(wmt.createdAt, '2026-06-02 10:00:00.0-04:00');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: FAIL — `readOpenManagedPositions` not exported.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `scripts/trade-ledger.mjs` (below the existing import):

```js
import { DatabaseSync } from 'node:sqlite';
```

Append to `scripts/trade-ledger.mjs`:

```js
// Open managed positions (ACTIVE + PARTIAL = still-open, possibly reduced qty),
// read-only. Mirror of Component 3's closed reader for the marked-equity leg.
export function readOpenManagedPositions(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT symbol, side, agent_strategy, entry_price, quantity,
              current_price, unrealized_pl, unrealized_plpc, remaining_qty,
              created_at
       FROM managed_positions
       WHERE status IN ('ACTIVE', 'PARTIAL')`
    ).all();
    return rows.map(r => ({
      symbol: r.symbol,
      side: r.side,
      agentStrategy: r.agent_strategy,
      entryPrice: r.entry_price,
      quantity: r.quantity,
      currentPrice: r.current_price,
      unrealizedPl: r.unrealized_pl,
      unrealizedPlPct: r.unrealized_plpc,
      remainingQty: r.remaining_qty,
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: PASS (all through Task 3).

- [ ] **Step 5: Commit**

```bash
git add scripts/trade-ledger.mjs scripts/trade-ledger.test.mjs
git commit -m "feat(component2a): readOpenManagedPositions (ACTIVE/PARTIAL reader)"
```

---

### Task 4: `frictionAdjustedPnl` + `metricsFromPnls` — per-trade friction + summary metrics

**Files:** Modify `scripts/trade-ledger.mjs`, `scripts/trade-ledger.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/trade-ledger.test.mjs`:

```js
import { frictionAdjustedPnl, metricsFromPnls } from './trade-ledger.mjs';

test('frictionAdjustedPnl subtracts the apply-friction haircut from realized P&L', () => {
  // stocks: slippage 0.01*100*2=2, reg 0.0001*100*2=0.02, stop_gap 0.003*100*100=30 (stop-out)
  const stopPos = { symbol: 'AAPL', side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110, exitPrice: 94.9, realizedPnl: -510, realizedPnlPct: -5.1, quantity: 100, storedStatus: 'STOPPED_OUT' };
  const adj = frictionAdjustedPnl(stopPos, 'mean-rev-rsi2', TEST_CFG);
  assert.ok(adj < -510, `expected haircut to worsen P&L, got ${adj}`);
});

test('metricsFromPnls computes win rate, profit factor, expectancy', () => {
  const m = metricsFromPnls([100, 200, -50, -50]);
  assert.equal(m.count, 4);
  assert.equal(m.winners, 2);
  assert.equal(m.losers, 2);
  assert.equal(m.winRate, 0.5);
  assert.equal(m.profitFactor, 3); // 300 / 100
  assert.equal(m.expectancy, 50);  // 200/4
});

test('metricsFromPnls profit factor is null (not Infinity) with zero losses', () => {
  const m = metricsFromPnls([100, 50, 10]);
  assert.equal(m.profitFactor, null);
  assert.equal(m.losers, 0);
});

test('metricsFromPnls empty array is well-defined', () => {
  const m = metricsFromPnls([]);
  assert.equal(m.count, 0);
  assert.equal(m.winRate, 0);
  assert.equal(m.profitFactor, null);
  assert.equal(m.expectancy, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: FAIL — `frictionAdjustedPnl`/`metricsFromPnls` not exported.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `scripts/trade-ledger.mjs`:

```js
import { applyFriction } from './apply-friction.mjs';
```

Append to `scripts/trade-ledger.mjs`:

```js
// Friction-adjusted realized P&L for one closed position, or null if the
// asset class isn't recognized by apply-friction.
export function frictionAdjustedPnl(position, agentId, config) {
  const out = applyFriction(toFrictionAction(position, agentId), agentId, config);
  if (out.skip) return null;
  return out.action.market_data.friction_adjusted_pl;
}

// Summary metrics over an array of (friction-adjusted) per-trade P&L numbers.
// Profit factor is null (undefined), never Infinity, when there are no losses.
export function metricsFromPnls(pnls) {
  const n = pnls.length;
  const winners = pnls.filter(p => p > 0);
  const losers = pnls.filter(p => p < 0);
  const sumWin = winners.reduce((s, x) => s + x, 0);
  const sumLossAbs = Math.abs(losers.reduce((s, x) => s + x, 0));
  return {
    count: n,
    winners: winners.length,
    losers: losers.length,
    winRate: n ? winners.length / n : 0,
    profitFactor: losers.length === 0 ? null : sumWin / sumLossAbs,
    avgWin: winners.length ? sumWin / winners.length : 0,
    avgLoss: losers.length ? -sumLossAbs / losers.length : 0,
    expectancy: n ? pnls.reduce((s, x) => s + x, 0) / n : 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: PASS (all through Task 4).

- [ ] **Step 5: Commit**

```bash
git add scripts/trade-ledger.mjs scripts/trade-ledger.test.mjs
git commit -m "feat(component2a): friction-adjusted per-trade P&L + summary metrics"
```

---

### Task 5: `bootstrapExpectancyCI` — seeded bootstrap CI on per-trade P&L

**Files:** Modify `scripts/trade-ledger.mjs`, `scripts/trade-ledger.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/trade-ledger.test.mjs`:

```js
import { bootstrapExpectancyCI } from './trade-ledger.mjs';

test('bootstrapExpectancyCI is deterministic for a fixed seed', () => {
  const a = bootstrapExpectancyCI([10, -5, 20, -3, 8], { seed: 42 });
  const b = bootstrapExpectancyCI([10, -5, 20, -3, 8], { seed: 42 });
  assert.deepEqual(a, b);
  assert.ok(a.lo < a.mean && a.mean < a.hi);
  assert.equal(a.n, 5);
});

test('bootstrapExpectancyCI widens with smaller n', () => {
  const small = bootstrapExpectancyCI([5, -5, 6, -4], { seed: 1 });
  const big = bootstrapExpectancyCI(Array.from({ length: 80 }, (_, i) => (i % 2 ? 6 : -4)), { seed: 1 });
  assert.ok((small.hi - small.lo) > (big.hi - big.lo));
});

test('bootstrapExpectancyCI empty array → nulls', () => {
  assert.deepEqual(bootstrapExpectancyCI([]), { mean: null, lo: null, hi: null, n: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: FAIL — `bootstrapExpectancyCI` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/trade-ledger.mjs`:

```js
// Small seeded PRNG (mulberry32) so bootstrap CIs are reproducible in tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Percentile bootstrap CI on the mean per-trade P&L — the demonstrated-edge
// statistic 2c gates on (a count floor can't tell edge from luck).
export function bootstrapExpectancyCI(pnls, { B = 10000, alpha = 0.05, seed = 12345 } = {}) {
  const n = pnls.length;
  if (n === 0) return { mean: null, lo: null, hi: null, n: 0 };
  const rng = mulberry32(seed);
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += pnls[(rng() * n) | 0];
    means[b] = s / n;
  }
  means.sort((x, y) => x - y);
  return {
    mean: pnls.reduce((s, x) => s + x, 0) / n,
    lo: means[Math.floor((alpha / 2) * B)],
    hi: means[Math.floor((1 - alpha / 2) * B)],
    n,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: PASS (all through Task 5).

- [ ] **Step 5: Commit**

```bash
git add scripts/trade-ledger.mjs scripts/trade-ledger.test.mjs
git commit -m "feat(component2a): seeded bootstrap expectancy CI"
```

---

### Task 6: `markedEquityExpectancy` — aligned, entry-friction-adjusted bias check

**Files:** Modify `scripts/trade-ledger.mjs`, `scripts/trade-ledger.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/trade-ledger.test.mjs`:

```js
import { markedEquityExpectancy } from './trade-ledger.mjs';

test('markedEquityExpectancy blends eligible closed friction-adj realized + eligible open marks (entry-friction subtracted)', () => {
  // 2 eligible closed friction-adj pnls + 1 eligible open: WMT qty 10 unrealizedPl 15.3
  // entry-side stock friction = (0.01 + 0.0001 + 0) * 10 = 0.101 → open contributes 15.3 - 0.101
  const r = markedEquityExpectancy([100, -20], [{ symbol: 'WMT', quantity: 10, unrealizedPl: 15.3 }], TEST_CFG);
  const expectedTotal = 100 + (-20) + (15.3 - 0.101);
  assert.equal(r.count, 3);
  assert.ok(Math.abs(r.value - expectedTotal) < 1e-9);
  assert.ok(Math.abs(r.perTrade - expectedTotal / 3) < 1e-9);
});

test('markedEquityExpectancy with no positions → null perTrade', () => {
  const r = markedEquityExpectancy([], [], TEST_CFG);
  assert.equal(r.count, 0);
  assert.equal(r.perTrade, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: FAIL — `markedEquityExpectancy` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/trade-ledger.mjs`:

```js
// One-side (entry) stock friction estimate — the friction already paid to be in
// an open position. Half of apply-friction's round-trip stock haircut, minus the
// stop-gap term (no exit yet).
function entrySideStockFriction(qty, profile) {
  const perShare = (profile.per_share_slippage_usd ?? 0)
    + (profile.regulatory_fee_per_share ?? 0)
    + (profile.commission_per_share ?? 0);
  return perShare * qty;
}

// Secondary marked-equity expectancy (hold-losers bias check): eligible closed
// friction-adjusted realized P&L + eligible open marks with entry-side friction
// subtracted, over aligned (eligible-closed + eligible-open) populations.
export function markedEquityExpectancy(eligibleClosedPnls, eligibleOpen, config) {
  const stocks = config.stocks ?? {};
  const closedSum = eligibleClosedPnls.reduce((s, x) => s + x, 0);
  const openSum = eligibleOpen.reduce(
    (s, p) => s + (p.unrealizedPl - entrySideStockFriction(p.quantity, stocks)), 0);
  const count = eligibleClosedPnls.length + eligibleOpen.length;
  const value = closedSum + openSum;
  return { count, value, perTrade: count ? value / count : null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: PASS (all through Task 6).

- [ ] **Step 5: Commit**

```bash
git add scripts/trade-ledger.mjs scripts/trade-ledger.test.mjs
git commit -m "feat(component2a): marked-equity expectancy (aligned + entry-friction)"
```

---

### Task 7: `buildAgentLedger` — partition, metrics @1×/@2×, bootstrap, marked-equity

**Files:** Modify `scripts/trade-ledger.mjs`, `scripts/trade-ledger.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/trade-ledger.test.mjs`:

```js
import { buildAgentLedger } from './trade-ledger.mjs';
import { cutoffDateToMs } from './managed-position-repair.mjs';

const CUTOFF = cutoffDateToMs('2026-05-31');
function closedPos(symbol, createdAt, realizedPnl, realizedPnlPct, exitPrice, storedStatus) {
  return { symbol, side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110,
    exitPrice, realizedPnl, realizedPnlPct, quantity: 100, storedStatus, notes: '' };
}

test('buildAgentLedger partitions eligible vs quarantined and fills both blocks', () => {
  const closed = [
    closedPos('PRE1', '2026-05-20 14:00:00.0-05:00', 300, 3, 103, 'CLOSED'),   // quarantined
    closedPos('POST1', '2026-06-02 10:00:00.0-04:00', 300, 3, 103, 'CLOSED'),  // eligible win
    closedPos('POST2', '2026-06-03 10:00:00.0-04:00', -210, -2.1, 97.9, 'CLOSED'), // eligible loss
  ];
  const open = [{ symbol: 'OPN', quantity: 10, unrealizedPl: 50, agentStrategy: 'mean-rev-rsi2', createdAt: '2026-06-04 10:00:00.0-04:00' }];
  const led = buildAgentLedger(closed, open, CUTOFF, 'mean-rev-rsi2', TEST_CFG, buildStressConfig(TEST_CFG));

  assert.equal(led.eligible.count, 2);
  assert.equal(led.quarantined.count, 1);
  assert.equal(led.allClosed.count, 3);
  // expectancy @2x is <= @1x (more friction)
  assert.ok(led.eligibleExpectancy2x <= led.eligible.expectancy);
  // bootstrap CI present on the eligible (2x) per-trade pnls
  assert.equal(led.edgeCI.n, 2);
  assert.ok('lo' in led.edgeCI && 'hi' in led.edgeCI);
  // marked-equity counts eligible closed (2) + eligible open (1)
  assert.equal(led.markedEquity.count, 3);
});

test('buildAgentLedger eligible block empty when all trades pre-cutoff (today\'s reality)', () => {
  const closed = [closedPos('PRE1', '2026-05-20 14:00:00.0-05:00', 300, 3, 103, 'CLOSED')];
  const led = buildAgentLedger(closed, [], CUTOFF, 'mean-rev-rsi2', TEST_CFG, buildStressConfig(TEST_CFG));
  assert.equal(led.eligible.count, 0);
  assert.equal(led.quarantined.count, 1);
  assert.equal(led.edgeCI.n, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: FAIL — `buildAgentLedger` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to the Component-3 import at the top of `scripts/trade-ledger.mjs` (extend the existing line):

```js
import { deriveExitReason, isGraduationEligible, parseManagedTimestamp } from './managed-position-repair.mjs';
```

Append to `scripts/trade-ledger.mjs`:

```js
// Full per-agent ledger: eligible/quarantined/all-closed metric blocks,
// expectancy at 1× and 2× friction, the demonstrated-edge bootstrap CI (on the
// eligible 2×-friction per-trade P&L), and the marked-equity bias check.
export function buildAgentLedger(closed, open, cutoffMs, agentId, baselineCfg, stressCfg) {
  const isElig = (p) => isGraduationEligible(parseManagedTimestamp(p.createdAt), cutoffMs);
  const eligibleClosed = closed.filter(isElig);
  const quarantinedClosed = closed.filter(p => !isElig(p));
  const eligibleOpen = open.filter(isElig);

  const adj = (list, cfg) => list.map(p => frictionAdjustedPnl(p, agentId, cfg)).filter(v => v !== null);
  const eligPnls1x = adj(eligibleClosed, baselineCfg);
  const eligPnls2x = adj(eligibleClosed, stressCfg);
  const allClosedPnls1x = adj(closed, baselineCfg);
  const quarPnls1x = adj(quarantinedClosed, baselineCfg);

  return {
    agentStrategy: agentId,
    eligible: metricsFromPnls(eligPnls1x),
    eligibleExpectancy2x: eligPnls2x.length ? eligPnls2x.reduce((s, x) => s + x, 0) / eligPnls2x.length : 0,
    edgeCI: bootstrapExpectancyCI(eligPnls2x),
    quarantined: metricsFromPnls(quarPnls1x),
    allClosed: metricsFromPnls(allClosedPnls1x),
    markedEquity: markedEquityExpectancy(eligPnls1x, eligibleOpen, baselineCfg),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: PASS (all through Task 7).

- [ ] **Step 5: Commit**

```bash
git add scripts/trade-ledger.mjs scripts/trade-ledger.test.mjs
git commit -m "feat(component2a): buildAgentLedger (partition + 1x/2x + edge CI + marked-equity)"
```

---

### Task 8: report builder + markdown renderer + CLI guard

**Files:** Modify `scripts/trade-ledger.mjs`, `scripts/trade-ledger.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/trade-ledger.test.mjs`:

```js
import { renderLedgerMarkdown } from './trade-ledger.mjs';

test('renderLedgerMarkdown shows per-agent eligible/all-closed + edge CI', () => {
  const report = { agents: { 'mean-rev-rsi2': {
    agentStrategy: 'mean-rev-rsi2',
    eligible: { count: 2, winRate: 0.5, profitFactor: 3, expectancy: 45 },
    eligibleExpectancy2x: 40,
    edgeCI: { mean: 40, lo: -10, hi: 90, n: 2 },
    quarantined: { count: 1 },
    allClosed: { count: 3, winRate: 0.67, profitFactor: 2.1, expectancy: 60 },
    markedEquity: { count: 3, value: 120, perTrade: 40 },
  } } };
  const md = renderLedgerMarkdown(report);
  assert.match(md, /mean-rev-rsi2/);
  assert.match(md, /eligible/i);
  assert.match(md, /edge CI/i);
  assert.match(md, /-10.*90/); // CI bounds rendered
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: FAIL — `renderLedgerMarkdown` not exported.

- [ ] **Step 3: Write minimal implementation**

Add the remaining imports at the top of `scripts/trade-ledger.mjs`:

```js
import { readClosedManagedPositions, resolveSandboxDbPaths, cutoffDateToMs, PART_A_DEPLOY_CUTOFF } from './managed-position-repair.mjs';
import { loadFrictionConfig } from './apply-friction.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```

(Extend the existing `./managed-position-repair.mjs` import rather than duplicating — final import list is: `deriveExitReason, isGraduationEligible, parseManagedTimestamp, readClosedManagedPositions, resolveSandboxDbPaths, cutoffDateToMs, PART_A_DEPLOY_CUTOFF`.)

Append to `scripts/trade-ledger.mjs`:

```js
const fmt = (v) => (v === null || v === undefined ? '—' : (typeof v === 'number' ? +v.toFixed(2) : v));

export function buildLedgerReport(perAgent) {
  return { agents: perAgent };
}

export function renderLedgerMarkdown(report) {
  const lines = ['# Per-agent trade ledger (friction-adjusted, display-only)', ''];
  for (const [agent, l] of Object.entries(report.agents).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${agent}`, '');
    lines.push('| block | n | win% | profit factor | expectancy |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    lines.push(`| eligible | ${l.eligible.count} | ${fmt((l.eligible.winRate ?? 0) * 100)} | ${fmt(l.eligible.profitFactor)} | ${fmt(l.eligible.expectancy)} |`);
    lines.push(`| all-closed (incl. quarantined) | ${l.allClosed.count} | ${fmt((l.allClosed.winRate ?? 0) * 100)} | ${fmt(l.allClosed.profitFactor)} | ${fmt(l.allClosed.expectancy)} |`);
    lines.push('');
    lines.push(`- expectancy @2× friction: **${fmt(l.eligibleExpectancy2x)}**`);
    lines.push(`- edge CI (eligible, net 2× friction, n=${l.edgeCI.n}): [${fmt(l.edgeCI.lo)}, ${fmt(l.edgeCI.hi)}] mean ${fmt(l.edgeCI.mean)}`);
    lines.push(`- marked-equity expectancy (eligible closed+open, entry-friction): ${fmt(l.markedEquity.perTrade)} over ${l.markedEquity.count}`);
    lines.push('');
  }
  return lines.join('\n');
}

// CLI entry — only when invoked directly (matches apply-friction.mjs / Component 3).
{
  const argv1abs = process.argv[1] ? resolve(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1abs) {
    const args = process.argv.slice(2);
    const agentIdx = args.indexOf('--agent');
    const agentFilter = agentIdx !== -1 ? args[agentIdx + 1] : undefined;
    const projectRoot = process.cwd();
    const baselineCfg = loadFrictionConfig(join(projectRoot, 'config', 'friction.json'));
    const stressCfg = buildStressConfig(baselineCfg);
    const cutoffMs = cutoffDateToMs(PART_A_DEPLOY_CUTOFF);

    // Group closed + open positions by agent_strategy across all resolved sandboxes.
    const byAgent = {}; // strat → { closed:[], open:[] }
    for (const dbPath of resolveSandboxDbPaths(projectRoot, agentFilter)) {
      try {
        for (const p of readClosedManagedPositions(dbPath)) {
          (byAgent[p.agentStrategy] ??= { closed: [], open: [] }).closed.push(p);
        }
        for (const p of readOpenManagedPositions(dbPath)) {
          (byAgent[p.agentStrategy] ??= { closed: [], open: [] }).open.push(p);
        }
      } catch (err) {
        process.stderr.write(`skip ${dbPath}: ${err.message}\n`);
      }
    }
    const perAgent = {};
    for (const [strat, { closed, open }] of Object.entries(byAgent)) {
      if (!strat) continue; // skip untagged
      perAgent[strat] = buildAgentLedger(closed, open, cutoffMs, strat, baselineCfg, stressCfg);
    }
    process.stdout.write(renderLedgerMarkdown(buildLedgerReport(perAgent)) + '\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: PASS (all through Task 8).

- [ ] **Step 5: Commit**

```bash
git add scripts/trade-ledger.mjs scripts/trade-ledger.test.mjs
git commit -m "feat(component2a): ledger report + markdown renderer + CLI guard"
```

---

### Task 9: full suite green + real-data Coil smoke

**Files:** none (verification only).

- [ ] **Step 1: Run the full Component-2a test suite**

Run: `node --test scripts/trade-ledger.test.mjs`
Expected: all tests pass. (`node:sqlite` ExperimentalWarning on stderr is expected, non-fatal.)

- [ ] **Step 2: Confirm `config/friction.json` exists, then smoke-run the CLI on real sandboxes**

Run (from the main working dir so `config/` + `data/sandboxes/` resolve — the CLI is read-only):
```bash
cd "C:/Users/mtzuo/OneDrive/Documents/Projects/ClaudeProphetAndFriends" && node ".claude/worktrees/foundation-b-c3-repair/scripts/trade-ledger.mjs"
```
Expected: a markdown per-agent ledger. For configured sandboxes with closed trades, an `all-closed` row with real win%/profit-factor/expectancy; `eligible` rows show **0** (all current trades pre-cutoff → quarantined), confirming D-C14 (smoke validates plumbing, not the eligible/graduation math).

- [ ] **Step 3: End-to-end on the real Coil DB directly (sbx_mean_rev is not a configured sandbox)**

Run (from the worktree):
```bash
cd "C:/Users/mtzuo/OneDrive/Documents/Projects/ClaudeProphetAndFriends/.claude/worktrees/foundation-b-c3-repair" && node --input-type=module -e "
import { readClosedManagedPositions } from './scripts/managed-position-repair.mjs';
import { readOpenManagedPositions, buildAgentLedger, buildStressConfig, renderLedgerMarkdown, buildLedgerReport } from './scripts/trade-ledger.mjs';
import { loadFrictionConfig } from './scripts/apply-friction.mjs';
import { cutoffDateToMs, PART_A_DEPLOY_CUTOFF } from './scripts/managed-position-repair.mjs';
const db = 'C:/Users/mtzuo/OneDrive/Documents/Projects/ClaudeProphetAndFriends/data/sandboxes/sbx_mean_rev/prophet_trader.db';
const cfg = loadFrictionConfig('C:/Users/mtzuo/OneDrive/Documents/Projects/ClaudeProphetAndFriends/config/friction.json');
const closed = readClosedManagedPositions(db), open = readOpenManagedPositions(db);
const led = buildAgentLedger(closed, open, cutoffDateToMs(PART_A_DEPLOY_CUTOFF), 'mean-rev-rsi2', cfg, buildStressConfig(cfg));
console.log(renderLedgerMarkdown(buildLedgerReport({ 'mean-rev-rsi2': led })));
" 2>&1 | grep -v ExperimentalWarning | grep -v 'node --trace'
```
Expected: `mean-rev-rsi2` ledger — **all-closed** block shows the 4 Coil trades' real friction-adjusted win%/profit-factor/expectancy; **eligible** block shows 0 (the 4 trades are pre-cutoff). This is the real-data validation of 2a's metric plumbing.

- [ ] **Step 4: No code changes expected.** If a discrepancy surfaces, fix it under TDD (failing test first) before finishing.

---

## Self-Review (completed during planning)

**Spec coverage (§3):** friction adapter w/ derived stop-out → Task 1; 2× uncertain-only stress → Task 2; open reader → Task 3; per-trade friction + metrics + profit-factor-null → Task 4; bootstrap edge CI → Task 5; marked-equity aligned+entry-friction → Task 6; eligible/quarantined/all-closed + 1×/2× → Task 7; report+markdown+CLI → Task 8; D-C14 smoke caveat → Task 9. ✓ (2b/2c are out of scope per the spec — separate follow-up plans.)

**Placeholder scan:** none — every code step carries full code; commands have expected output; the friction config is a concrete inline `TEST_CFG` for units and the real `config/friction.json` for the smoke.

**Type consistency:** position object shape (`entryPrice, exitPrice, quantity, realizedPnl, realizedPnlPct, createdAt, storedStatus, agentStrategy, side, notes, stopLossPrice, takeProfitPrice`) matches Component 3's reader and is used identically across Tasks 1/4/7. Ledger object keys (`eligible, eligibleExpectancy2x, edgeCI, quarantined, allClosed, markedEquity`) are produced in Task 7 and consumed unchanged in Task 8's renderer. `metricsFromPnls` return shape (`count, winners, losers, winRate, profitFactor, avgWin, avgLoss, expectancy`) is consistent Task 4 → Task 8.

**Known limitation (noted, not a gap):** `apply-friction`'s `detectAssetClass` only special-cases `agentId === 'penny-prophet'` for the penny profile; PennyProphet's `AgentStrategy` differs, so its managed positions would get the `stocks` profile. Out of scope — the ballast agents (Coil, Turtle) are equity `stocks`; penny is not in the ballast plan.
