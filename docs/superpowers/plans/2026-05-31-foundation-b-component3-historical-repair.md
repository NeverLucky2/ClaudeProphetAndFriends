# Foundation B — Component 3: Historical Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one-time, read-only Node tooling that quarantines pre-Part-A-deploy closed `managed_positions` and derives a best-effort exit reason per position, flagging stored-vs-derived mislabels (e.g. Coil's COST false `STOPPED_OUT`).

**Architecture:** A single ESM module `scripts/managed-position-repair.mjs` of small pure functions (timestamp parse, cutoff→ms, eligibility predicate, exit-reason derivation, report aggregator, markdown renderer) plus a thin DB reader (`node:sqlite`, read-only) and a CLI guard. Pure functions are unit-tested and re-imported by Component 2; the DB reader gets one integration test against a temp SQLite file with the real schema. Nothing mutates the database.

**Tech Stack:** Node ≥ 22.5 (built-in `node:sqlite` `DatabaseSync`; the installed `better-sqlite3` is ABI-broken on Node 24), `node:test`, ESM (`"type": "module"`).

**Spec:** `docs/superpowers/specs/2026-05-31-foundation-b-component3-historical-repair-design.md`

**Branch:** `foundation-b-component3-historical-repair` (already created; the spec commit `ec02f31` is on it). All task commits land here; squash at the finish-branch step into the single backlog-item commit.

**File structure:**
- Create: `scripts/managed-position-repair.mjs` — the whole component (pure functions + reader + CLI guard).
- Create: `scripts/managed-position-repair.test.mjs` — co-located `node:test` suite.
- No other files change. (Parent-spec D-B8 was already added in the spec commit.)

**Conventions to follow (from `scripts/apply-friction.mjs`):** named exports for every function; CLI guard at the bottom gated on `fileURLToPath(import.meta.url) === resolve(process.argv[1])` so importing the module never runs the CLI; sandbox resolution by reading `data/agent-config.json`.

---

### Task 1: `parseManagedTimestamp` — Go-format datetime → epoch ms

GORM stores `created_at`/`closed_at` as e.g. `"2026-05-20 14:41:11.1594068-05:00"` (space not `T`, 7-digit fractional, embedded offset). `new Date()` does not parse this reliably, so normalize first.

**Files:**
- Create: `scripts/managed-position-repair.mjs`
- Test: `scripts/managed-position-repair.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/managed-position-repair.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManagedTimestamp } from './managed-position-repair.mjs';

test('parseManagedTimestamp parses Go-format datetime with 7-digit fractional + offset', () => {
  const ms = parseManagedTimestamp('2026-05-20 14:41:11.1594068-05:00');
  assert.equal(ms, Date.parse('2026-05-20T14:41:11.159-05:00'));
});

test('parseManagedTimestamp orders correctly across dates', () => {
  const a = parseManagedTimestamp('2026-05-20 14:41:11.1594068-05:00');
  const b = parseManagedTimestamp('2026-05-29 08:37:56.1750541-05:00');
  assert.ok(a < b);
});

test('parseManagedTimestamp handles a value with no fractional seconds', () => {
  const ms = parseManagedTimestamp('2026-05-20 14:41:11-05:00');
  assert.equal(ms, Date.parse('2026-05-20T14:41:11-05:00'));
});

test('parseManagedTimestamp returns null on empty/garbage/non-string', () => {
  assert.equal(parseManagedTimestamp(''), null);
  assert.equal(parseManagedTimestamp(null), null);
  assert.equal(parseManagedTimestamp('not a date'), null);
  assert.equal(parseManagedTimestamp(42), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: FAIL — `Cannot find module './managed-position-repair.mjs'` (or "parseManagedTimestamp is not a function").

- [ ] **Step 3: Write minimal implementation**

Create `scripts/managed-position-repair.mjs`:

```js
// Foundation B Component 3 — one-time, read-only historical repair over closed
// managed_positions: quarantine-by-entry-date + exit-reason derivation w/ a
// stored-vs-derived mislabel flag. Display-only; never mutates the DB.
// Spec: docs/superpowers/specs/2026-05-31-foundation-b-component3-historical-repair-design.md

// Parse GORM's stored time.Time form, e.g. "2026-05-20 14:41:11.1594068-05:00".
// Returns epoch ms, or null when unparseable/empty/non-string.
export function parseManagedTimestamp(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  // space → 'T' (first space only; the offset has none), truncate fractional to 3 digits
  const normalized = s.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: PASS (4 tests). A `node:sqlite` experimental warning may appear later; it does not fail tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/managed-position-repair.mjs scripts/managed-position-repair.test.mjs
git commit -m "feat(component3): parseManagedTimestamp for GORM datetime strings"
```

---

### Task 2: `cutoffDateToMs` + `isGraduationEligible` — the quarantine predicate

Cutoff date parsed at **midnight America/New_York** (DST-aware), inclusive boundary.

**Files:**
- Modify: `scripts/managed-position-repair.mjs`
- Test: `scripts/managed-position-repair.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/managed-position-repair.test.mjs`:

```js
import {
  cutoffDateToMs, isGraduationEligible, PART_A_DEPLOY_CUTOFF,
} from './managed-position-repair.mjs';

test('PART_A_DEPLOY_CUTOFF default is 2026-05-31', () => {
  assert.equal(PART_A_DEPLOY_CUTOFF, '2026-05-31');
});

test('cutoffDateToMs returns ET midnight (EDT in summer)', () => {
  assert.equal(cutoffDateToMs('2026-05-31'), Date.parse('2026-05-31T00:00:00-04:00'));
});

test('cutoffDateToMs is DST-aware (EST in winter)', () => {
  assert.equal(cutoffDateToMs('2026-01-15'), Date.parse('2026-01-15T00:00:00-05:00'));
});

test('isGraduationEligible: pre-cutoff entry is quarantined', () => {
  const entry = parseManagedTimestamp('2026-05-20 14:41:11.1594068-05:00');
  assert.equal(isGraduationEligible(entry, cutoffDateToMs('2026-05-31')), false);
});

test('isGraduationEligible: entry exactly at cutoff is eligible (inclusive)', () => {
  const cutoff = cutoffDateToMs('2026-05-31');
  assert.equal(isGraduationEligible(cutoff, cutoff), true);
});

test('isGraduationEligible: post-cutoff entry is eligible', () => {
  const entry = parseManagedTimestamp('2026-06-02 10:00:00.0000000-04:00');
  assert.equal(isGraduationEligible(entry, cutoffDateToMs('2026-05-31')), true);
});

test('isGraduationEligible: null createdAt is not eligible', () => {
  assert.equal(isGraduationEligible(null, cutoffDateToMs('2026-05-31')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: FAIL — `cutoffDateToMs`/`isGraduationEligible`/`PART_A_DEPLOY_CUTOFF` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/managed-position-repair.mjs`:

```js
const ET_TZ = 'America/New_York';

// The boundary at which the data-generating process became trustworthy (the
// Part-A-corrected bot going live). Bump to the real rebuild date at deploy.
export const PART_A_DEPLOY_CUTOFF = '2026-05-31';

// Offset (ms) of `timeZone` from UTC at the given instant: (wallclock read in
// the zone, interpreted as UTC) − epochMs.
function zoneOffsetMs(epochMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(epochMs)).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - epochMs;
}

// 'YYYY-MM-DD' → epoch ms at 00:00 in `timeZone` (default ET), DST-aware.
export function cutoffDateToMs(dateStr, timeZone = ET_TZ) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = zoneOffsetMs(utcGuess, timeZone);
  return utcGuess - offset;
}

// A closed position is graduation-eligible iff entered on/after the cutoff.
export function isGraduationEligible(createdAtMs, cutoffMs) {
  return typeof createdAtMs === 'number' && createdAtMs >= cutoffMs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/managed-position-repair.mjs scripts/managed-position-repair.test.mjs
git commit -m "feat(component3): ET-midnight cutoff + graduation-eligibility predicate"
```

---

### Task 3: `deriveExitReason` — exit-reason classifier + mislabel flag

Side-aware price-vs-level (per share). Precedence: reconcile note → missing/degenerate levels → price bands. Mislabel per the {derived}×{stored} truth table.

**Files:**
- Modify: `scripts/managed-position-repair.mjs`
- Test: `scripts/managed-position-repair.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/managed-position-repair.test.mjs`:

```js
import { deriveExitReason, EXIT_MATCH_TOL_PCT } from './managed-position-repair.mjs';

const longBase = { side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110 };

test('default tolerance band is 0.25%', () => {
  assert.equal(EXIT_MATCH_TOL_PCT, 0.0025);
});

test('long stop-out: exit at/below stop, stored STOPPED_OUT → stop, not mislabeled', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 94.9, storedStatus: 'STOPPED_OUT' });
  assert.equal(r.derived, 'stop');
  assert.equal(r.mislabeled, false);
});

test('long target: exit near target, stored CLOSED → target, not mislabeled', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 109.8, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'target');
  assert.equal(r.mislabeled, false);
});

test('long signal: exit near neither level, stored CLOSED → signal_or_time, not mislabeled', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 103, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'signal_or_time');
  assert.equal(r.mislabeled, false);
});

test('COST repair: stored STOPPED_OUT but exit +1.5% above stop → signal_or_time, MISLABELED', () => {
  const r = deriveExitReason({
    side: 'buy', entryPrice: 1004.76, stopLossPrice: 970.06, takeProfitPrice: 1147.38,
    exitPrice: 1019.69, storedStatus: 'STOPPED_OUT',
  });
  assert.equal(r.derived, 'signal_or_time');
  assert.equal(r.mislabeled, true);
});

test('inverse mislabel: stored STOPPED_OUT but priced at target → target, MISLABELED', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 109.8, storedStatus: 'STOPPED_OUT' });
  assert.equal(r.derived, 'target');
  assert.equal(r.mislabeled, true);
});

test('mislabel: stored CLOSED but priced at stop → stop, MISLABELED', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 94.9, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'stop');
  assert.equal(r.mislabeled, true);
});

test('short inversion: side sell, exit at/above stop → stop, not mislabeled', () => {
  const r = deriveExitReason({
    side: 'sell', entryPrice: 100, stopLossPrice: 105, takeProfitPrice: 90,
    exitPrice: 105.1, storedStatus: 'STOPPED_OUT',
  });
  assert.equal(r.derived, 'stop');
  assert.equal(r.mislabeled, false);
});

test('missing stop → indeterminate, not mislabeled', () => {
  const r = deriveExitReason({ side: 'buy', entryPrice: 100, stopLossPrice: 0, takeProfitPrice: 110, exitPrice: 94.9, storedStatus: 'STOPPED_OUT' });
  assert.equal(r.derived, 'indeterminate');
  assert.equal(r.mislabeled, false);
});

test('missing target → indeterminate, not mislabeled', () => {
  const r = deriveExitReason({ side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 0, exitPrice: 103, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'indeterminate');
  assert.equal(r.mislabeled, false);
});

test('degenerate overlapping bands → indeterminate', () => {
  const r = deriveExitReason({ side: 'buy', entryPrice: 100, stopLossPrice: 100, takeProfitPrice: 100.1, exitPrice: 100, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'indeterminate');
});

test('reconciled note → reconciled, never mislabeled even if priced like a stop', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 94.9, storedStatus: 'STOPPED_OUT', notes: 'x reconciled_closed:broker_flat' });
  assert.equal(r.derived, 'reconciled');
  assert.equal(r.mislabeled, false);
});

test('band edge: exit exactly at stop upper edge counts as stop', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 95 * 1.0025, storedStatus: 'STOPPED_OUT' });
  assert.equal(r.derived, 'stop');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: FAIL — `deriveExitReason`/`EXIT_MATCH_TOL_PCT` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/managed-position-repair.mjs`:

```js
export const EXIT_MATCH_TOL_PCT = 0.0025; // absorbs ≤10s mark staleness + liquid-stop slippage; NOT tuned to COST

// Derive a best-effort exit reason from stored prices and flag stored-vs-derived
// contradictions. Display-only. Returns { derived, mislabeled, basis }.
//   derived ∈ {stop, target, signal_or_time, reconciled, indeterminate}
export function deriveExitReason(p, tol = EXIT_MATCH_TOL_PCT) {
  const { side, stopLossPrice, takeProfitPrice, exitPrice, storedStatus, notes } = p;

  // 1. Reconcile-close: broker-side exit, true reason unknown. Never mislabel.
  if (typeof notes === 'string' && notes.includes('reconciled_closed')) {
    return { derived: 'reconciled', mislabeled: false, basis: 'reconcile_note' };
  }

  // 2. Indeterminate: missing levels or a non-positive exit mark.
  const hasStop = typeof stopLossPrice === 'number' && stopLossPrice > 0;
  const hasTarget = typeof takeProfitPrice === 'number' && takeProfitPrice > 0;
  const hasExit = typeof exitPrice === 'number' && exitPrice > 0;
  if (!hasStop || !hasTarget || !hasExit) {
    return { derived: 'indeterminate', mislabeled: false, basis: 'missing_levels' };
  }

  const isLong = side !== 'sell';
  let stopMatch, targetMatch;
  if (isLong) {
    const stopUpper = stopLossPrice * (1 + tol);
    const targetLower = takeProfitPrice * (1 - tol);
    if (stopUpper >= targetLower) {
      return { derived: 'indeterminate', mislabeled: false, basis: 'degenerate_bands' };
    }
    stopMatch = exitPrice <= stopUpper;
    targetMatch = exitPrice >= targetLower;
  } else {
    const stopLower = stopLossPrice * (1 - tol);
    const targetUpper = takeProfitPrice * (1 + tol);
    if (targetUpper >= stopLower) {
      return { derived: 'indeterminate', mislabeled: false, basis: 'degenerate_bands' };
    }
    stopMatch = exitPrice >= stopLower;
    targetMatch = exitPrice <= targetUpper;
  }

  // 3. Price-vs-level. Stop takes precedence (bands proven disjoint above).
  let derived;
  if (stopMatch) derived = 'stop';
  else if (targetMatch) derived = 'target';
  else derived = 'signal_or_time';

  const mislabeled =
    (storedStatus === 'STOPPED_OUT' && derived !== 'stop') ||
    (storedStatus === 'CLOSED' && derived === 'stop');

  return { derived, mislabeled, basis: 'price_vs_level' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: PASS (all tests through Task 3).

- [ ] **Step 5: Commit**

```bash
git add scripts/managed-position-repair.mjs scripts/managed-position-repair.test.mjs
git commit -m "feat(component3): side-aware exit-reason derivation + mislabel truth table"
```

---

### Task 4: `buildRepairReport` — pure aggregator

**Files:**
- Modify: `scripts/managed-position-repair.mjs`
- Test: `scripts/managed-position-repair.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/managed-position-repair.test.mjs`:

```js
import { buildRepairReport } from './managed-position-repair.mjs';

test('buildRepairReport buckets eligibility, mislabels, and indeterminates', () => {
  const cutoffMs = cutoffDateToMs('2026-05-31');
  const positions = [
    // pre-cutoff, mislabeled (COST-like): quarantined + mislabeled
    { symbol: 'COST', agentStrategy: 'mean-rev-rsi2', side: 'buy', entryPrice: 1004.76,
      stopLossPrice: 970.06, takeProfitPrice: 1147.38, exitPrice: 1019.69,
      storedStatus: 'STOPPED_OUT', createdAt: '2026-05-26 14:46:00.1464526-05:00' },
    // post-cutoff, clean stop: eligible, not mislabeled
    { symbol: 'AAPL', agentStrategy: 'mean-rev-rsi2', side: 'buy', entryPrice: 100,
      stopLossPrice: 95, takeProfitPrice: 110, exitPrice: 94.9,
      storedStatus: 'STOPPED_OUT', createdAt: '2026-06-02 10:00:00.0000000-04:00' },
    // pre-cutoff, missing target: quarantined + indeterminate
    { symbol: 'XYZ', agentStrategy: 'trend', side: 'buy', entryPrice: 50,
      stopLossPrice: 45, takeProfitPrice: 0, exitPrice: 52,
      storedStatus: 'CLOSED', createdAt: '2026-05-01 09:00:00.0000000-04:00' },
  ];
  const report = buildRepairReport(positions, cutoffMs, { date: '2026-05-31', source: 'DEFAULT' });

  assert.equal(report.cutoff.date, '2026-05-31');
  assert.equal(report.cutoff.source, 'DEFAULT');
  assert.deepEqual(report.perStrategy['mean-rev-rsi2'], { eligible: 1, quarantined: 1 });
  assert.deepEqual(report.perStrategy['trend'], { eligible: 0, quarantined: 1 });
  assert.equal(report.mislabeled.length, 1);
  assert.equal(report.mislabeled[0].symbol, 'COST');
  assert.equal(report.mislabeled[0].derived, 'signal_or_time');
  assert.equal(report.indeterminate.length, 1);
  assert.equal(report.indeterminate[0].symbol, 'XYZ');
  assert.equal(report.indeterminate[0].reason, 'missing_levels');
});

test('buildRepairReport defaults cutoff meta when omitted', () => {
  const report = buildRepairReport([], cutoffDateToMs('2026-05-31'));
  assert.equal(report.cutoff.source, 'DEFAULT');
  assert.deepEqual(report.perStrategy, {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: FAIL — `buildRepairReport` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/managed-position-repair.mjs`:

```js
// Aggregate per-strategy eligibility + the mislabel/indeterminate lists. Pure.
export function buildRepairReport(positions, cutoffMs, cutoffMeta = {}) {
  const perStrategy = {};
  const mislabeled = [];
  const indeterminate = [];

  for (const p of positions) {
    const strat = p.agentStrategy || '(untagged)';
    perStrategy[strat] ??= { eligible: 0, quarantined: 0 };
    if (isGraduationEligible(parseManagedTimestamp(p.createdAt), cutoffMs)) {
      perStrategy[strat].eligible += 1;
    } else {
      perStrategy[strat].quarantined += 1;
    }

    const { derived, mislabeled: isMis, basis } = deriveExitReason(p);
    if (isMis) {
      mislabeled.push({
        symbol: p.symbol, strategy: strat, storedStatus: p.storedStatus, derived,
        entry: p.entryPrice, stop: p.stopLossPrice, target: p.takeProfitPrice,
        exit: p.exitPrice, notes: p.notes,
      });
    }
    if (derived === 'indeterminate') {
      indeterminate.push({ symbol: p.symbol, strategy: strat, reason: basis });
    }
  }

  return {
    cutoff: { date: cutoffMeta.date ?? null, source: cutoffMeta.source ?? 'DEFAULT' },
    perStrategy, mislabeled, indeterminate,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: PASS (all tests through Task 4).

- [ ] **Step 5: Commit**

```bash
git add scripts/managed-position-repair.mjs scripts/managed-position-repair.test.mjs
git commit -m "feat(component3): buildRepairReport aggregator"
```

---

### Task 5: `readClosedManagedPositions` — `node:sqlite` reader (wide interface)

Read-only reader. Returns the wide normalized interface Component 2 reuses. Integration-tested against a temp DB seeded with the **real** snake_case schema.

**Files:**
- Modify: `scripts/managed-position-repair.mjs`
- Test: `scripts/managed-position-repair.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/managed-position-repair.test.mjs`:

```js
import { readClosedManagedPositions } from './managed-position-repair.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('readClosedManagedPositions maps real schema + filters to closed-trade rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpr-'));
  const dbPath = join(dir, 'prophet_trader.db');
  try {
    const seed = new DatabaseSync(dbPath);
    // Minimal real-schema subset (snake_case, datetime stored as Go-format text).
    seed.exec(`CREATE TABLE managed_positions (
      position_id TEXT, symbol TEXT, side TEXT, strategy TEXT, agent_strategy TEXT,
      quantity REAL, entry_price REAL, entry_order_id TEXT, allocation_dollars REAL,
      stop_loss_price REAL, take_profit_price REAL,
      status TEXT, current_price REAL, unrealized_pl REAL, unrealized_plpc REAL,
      remaining_qty REAL, notes TEXT, created_at datetime, closed_at datetime
    )`);
    const ins = seed.prepare(`INSERT INTO managed_positions
      (position_id,symbol,side,agent_strategy,quantity,entry_price,entry_order_id,allocation_dollars,
       stop_loss_price,take_profit_price,status,current_price,unrealized_pl,unrealized_plpc,
       remaining_qty,notes,created_at,closed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('p1','COST','buy','mean-rev-rsi2',1,1004.76,'o1',1004.76,970.06,1147.38,
      'STOPPED_OUT',1019.69,59.72,1.4859,1,'Entry: rsi2',
      '2026-05-26 14:46:00.1464526-05:00','2026-05-29 08:37:56.1750541-05:00');
    ins.run('p2','WMT','buy','mean-rev-rsi2',1,118.47,'o2',118.47,110.18,130.32,
      'ACTIVE',118.47,0,0,1,'Entry: rsi2','2026-05-26 14:45:49.508606-05:00',null);
    ins.run('p3','FOO','buy','mean-rev-rsi2',1,10,'o3',10,9,12,
      'FAILED',0,0,0,1,'','2026-05-26 14:45:49.508606-05:00',null);
    seed.close();

    const rows = readClosedManagedPositions(dbPath);
    assert.equal(rows.length, 1); // only the CLOSED/STOPPED_OUT row; ACTIVE + FAILED excluded
    const r = rows[0];
    assert.equal(r.symbol, 'COST');
    assert.equal(r.storedStatus, 'STOPPED_OUT');
    assert.equal(r.exitPrice, 1019.69);          // current_price → exitPrice
    assert.equal(r.realizedPnlPct, 1.4859);       // unrealized_plpc → realizedPnlPct
    assert.equal(r.stopLossPrice, 970.06);
    assert.equal(r.takeProfitPrice, 1147.38);
    assert.equal(r.agentStrategy, 'mean-rev-rsi2');
    assert.equal(r.createdAt, '2026-05-26 14:46:00.1464526-05:00');
    assert.equal(r.entryOrderId, 'o1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: FAIL — `readClosedManagedPositions` not exported.

- [ ] **Step 3: Write minimal implementation**

Add the import at the **top** of `scripts/managed-position-repair.mjs` (below the header comment):

```js
import { DatabaseSync } from 'node:sqlite';
```

Append the reader to `scripts/managed-position-repair.mjs`:

```js
// Read closed managed positions from one sandbox DB, read-only. The wide
// interface is deliberate: Component 2 reuses this exact shape so it never
// re-touches this landed module. This is the closed-trade (realized) leg only —
// the daily mark-to-market series comes from Component 1's DBSegmentPnL rows.
export function readClosedManagedPositions(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT position_id, symbol, side, agent_strategy, entry_price,
              stop_loss_price, take_profit_price, current_price,
              unrealized_pl, unrealized_plpc, remaining_qty, quantity,
              allocation_dollars, entry_order_id, status, notes,
              created_at, closed_at
       FROM managed_positions
       WHERE status IN ('CLOSED', 'STOPPED_OUT')`
    ).all();
    return rows.map(r => ({
      positionId: r.position_id,
      symbol: r.symbol,
      side: r.side,
      agentStrategy: r.agent_strategy,
      entryPrice: r.entry_price,
      stopLossPrice: r.stop_loss_price,
      takeProfitPrice: r.take_profit_price,
      exitPrice: r.current_price,        // last monitor mark (not the fill); see spec §2.3
      realizedPnlPct: r.unrealized_plpc, // per-share %, consistent with exitPrice
      realizedPnl: r.unrealized_pl,      // dollars; partial-blended — provided, not classified on
      quantity: r.quantity,
      remainingQty: r.remaining_qty,
      allocationDollars: r.allocation_dollars,
      entryOrderId: r.entry_order_id,
      storedStatus: r.status,
      notes: r.notes,
      createdAt: r.created_at,
      closedAt: r.closed_at,
    }));
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: PASS (all tests through Task 5). Ignore the `ExperimentalWarning: SQLite is an experimental feature` line on stderr.

- [ ] **Step 5: Commit**

```bash
git add scripts/managed-position-repair.mjs scripts/managed-position-repair.test.mjs
git commit -m "feat(component3): read-only node:sqlite reader for closed managed positions"
```

---

### Task 6: `renderMarkdownReport` — operator-facing markdown

**Files:**
- Modify: `scripts/managed-position-repair.mjs`
- Test: `scripts/managed-position-repair.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/managed-position-repair.test.mjs`:

```js
import { renderMarkdownReport } from './managed-position-repair.mjs';

test('renderMarkdownReport stamps the cutoff source and lists a mislabel', () => {
  const report = {
    cutoff: { date: '2026-05-31', source: 'DEFAULT' },
    perStrategy: { 'mean-rev-rsi2': { eligible: 0, quarantined: 2 } },
    mislabeled: [{ symbol: 'COST', strategy: 'mean-rev-rsi2', storedStatus: 'STOPPED_OUT',
      derived: 'signal_or_time', entry: 1004.76, stop: 970.06, target: 1147.38, exit: 1019.69 }],
    indeterminate: [],
  };
  const md = renderMarkdownReport(report);
  assert.match(md, /Cutoff:\*\* 2026-05-31 \(DEFAULT\)/);
  assert.match(md, /mean-rev-rsi2 \| 0 \| 2/);
  assert.match(md, /COST .* STOPPED_OUT .* signal_or_time/);
  assert.match(md, /Indeterminate.*0/);
});

test('renderMarkdownReport shows OVERRIDE and "none" when empty', () => {
  const md = renderMarkdownReport({
    cutoff: { date: '2026-04-23', source: 'OVERRIDE' },
    perStrategy: {}, mislabeled: [], indeterminate: [],
  });
  assert.match(md, /\(OVERRIDE\)/);
  assert.match(md, /_none_/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: FAIL — `renderMarkdownReport` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/managed-position-repair.mjs`:

```js
// Render the one-time operator report as markdown. Pure.
export function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# Managed-position repair report (display-only)');
  lines.push('');
  lines.push(`**Cutoff:** ${report.cutoff.date} (${report.cutoff.source})`);
  lines.push('');
  lines.push('## Quarantine by strategy');
  lines.push('');
  lines.push('| strategy | eligible | quarantined |');
  lines.push('| --- | ---: | ---: |');
  for (const [strat, c] of Object.entries(report.perStrategy).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${strat} | ${c.eligible} | ${c.quarantined} |`);
  }
  lines.push('');
  lines.push(`## Mislabeled exits (stored vs derived) — ${report.mislabeled.length}`);
  lines.push('');
  if (report.mislabeled.length === 0) {
    lines.push('_none_');
  } else {
    lines.push('| symbol | strategy | stored | derived | entry | stop | target | exit |');
    lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: |');
    for (const m of report.mislabeled) {
      lines.push(`| ${m.symbol} | ${m.strategy} | ${m.storedStatus} | ${m.derived} | ${m.entry} | ${m.stop} | ${m.target} | ${m.exit} |`);
    }
  }
  lines.push('');
  lines.push(`## Indeterminate (excluded from mislabel flagging) — ${report.indeterminate.length}`);
  lines.push('');
  if (report.indeterminate.length === 0) {
    lines.push('_none_');
  } else {
    lines.push('| symbol | strategy | reason |');
    lines.push('| --- | --- | --- |');
    for (const it of report.indeterminate) {
      lines.push(`| ${it.symbol} | ${it.strategy} | ${it.reason} |`);
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: PASS (all tests through Task 6).

- [ ] **Step 5: Commit**

```bash
git add scripts/managed-position-repair.mjs scripts/managed-position-repair.test.mjs
git commit -m "feat(component3): markdown report renderer"
```

---

### Task 7: `resolveSandboxDbPaths` + CLI guard

Sandbox resolution from `data/agent-config.json` (testable) + the thin CLI guard (verified by a real run, matching how `apply-friction.mjs` leaves its guard untested).

**Files:**
- Modify: `scripts/managed-position-repair.mjs`
- Test: `scripts/managed-position-repair.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/managed-position-repair.test.mjs`:

```js
import { resolveSandboxDbPaths } from './managed-position-repair.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

test('resolveSandboxDbPaths returns existing DBs, optionally filtered by agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'mpr-root-'));
  try {
    mkdirSync(join(root, 'data', 'sandboxes', 'acctA'), { recursive: true });
    mkdirSync(join(root, 'data', 'sandboxes', 'acctB'), { recursive: true });
    // acctA has a db file, acctB does not (should be skipped)
    writeFileSync(join(root, 'data', 'sandboxes', 'acctA', 'prophet_trader.db'), '');
    writeFileSync(join(root, 'data', 'agent-config.json'), JSON.stringify({
      sandboxes: {
        s1: { accountId: 'acctA', agent: { activeAgentId: 'default' } },
        s2: { accountId: 'acctB', agent: { activeAgentId: 'turtle-trend' } },
      },
    }));

    const all = resolveSandboxDbPaths(root);
    assert.deepEqual(all, [join(root, 'data', 'sandboxes', 'acctA', 'prophet_trader.db')]);

    const filtered = resolveSandboxDbPaths(root, 'turtle-trend');
    assert.deepEqual(filtered, []); // acctB matches agent but has no db file
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: FAIL — `resolveSandboxDbPaths` not exported.

- [ ] **Step 3: Write minimal implementation**

Add these imports at the **top** of `scripts/managed-position-repair.mjs` (with the existing imports):

```js
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```

Append `resolveSandboxDbPaths` + the CLI guard to `scripts/managed-position-repair.mjs`:

```js
// Resolve per-sandbox DB paths from data/agent-config.json. Optionally scope to
// one agent by activeAgentId. Skips sandboxes whose DB file is absent.
export function resolveSandboxDbPaths(projectRoot, agentId) {
  const cfgPath = join(projectRoot, 'data', 'agent-config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const sandboxes = cfg.sandboxes ?? {};
  const out = [];
  for (const sb of Object.values(sandboxes)) {
    if (!sb || typeof sb.accountId !== 'string') continue;
    if (agentId && sb.agent?.activeAgentId !== agentId) continue;
    const dbPath = join(projectRoot, 'data', 'sandboxes', sb.accountId, 'prophet_trader.db');
    if (existsSync(dbPath)) out.push(dbPath);
  }
  return out;
}

// CLI entry — only when invoked directly, never on import (matches apply-friction.mjs).
{
  const argv1abs = process.argv[1] ? resolve(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1abs) {
    const args = process.argv.slice(2);
    const agentIdx = args.indexOf('--agent');
    const cutoffIdx = args.indexOf('--cutoff');
    const agentId = agentIdx !== -1 ? args[agentIdx + 1] : undefined;
    const cutoffDate = cutoffIdx !== -1 ? args[cutoffIdx + 1] : PART_A_DEPLOY_CUTOFF;
    const source = cutoffIdx !== -1 ? 'OVERRIDE' : 'DEFAULT';
    if (source === 'OVERRIDE') {
      process.stderr.write(
        `WARNING: quarantine cutoff overridden to ${cutoffDate} (default ${PART_A_DEPLOY_CUTOFF}). ` +
        `Boundary moved — confirm this is intentional before trusting the eligible/quarantined split.\n`,
      );
    }
    const cutoffMs = cutoffDateToMs(cutoffDate);
    const projectRoot = process.cwd();
    const positions = [];
    for (const dbPath of resolveSandboxDbPaths(projectRoot, agentId)) {
      try {
        positions.push(...readClosedManagedPositions(dbPath));
      } catch (err) {
        process.stderr.write(`skip ${dbPath}: ${err.message}\n`);
      }
    }
    const report = buildRepairReport(positions, cutoffMs, { date: cutoffDate, source });
    process.stdout.write(renderMarkdownReport(report) + '\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/managed-position-repair.test.mjs`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/managed-position-repair.mjs scripts/managed-position-repair.test.mjs
git commit -m "feat(component3): sandbox resolution + one-time CLI report guard"
```

---

### Task 8: Full-suite green + real-data smoke run (verification before done)

**Files:** none (verification only).

- [ ] **Step 1: Run the full project test suite**

Run: `npm test`
Expected: the whole suite passes, including `scripts/managed-position-repair.test.mjs`. (The `node:sqlite` ExperimentalWarning on stderr is expected and non-fatal.)

- [ ] **Step 2: Smoke-run the CLI against real sandboxes**

Run: `node scripts/managed-position-repair.mjs`
Expected: a markdown report on stdout with `**Cutoff:** 2026-05-31 (DEFAULT)`, a per-strategy table, and — for the Coil sandbox — `COST` listed under "Mislabeled exits" with `STOPPED_OUT` → `signal_or_time`. Confirm `mean-rev-rsi2` shows its closed rows as **quarantined** (all entered before 2026-05-31). No file or DB writes occur.

- [ ] **Step 3: Smoke-run the loud override**

Run: `node scripts/managed-position-repair.mjs --cutoff 2026-04-23`
Expected: a `WARNING: quarantine cutoff overridden...` line on **stderr**, and the report header reads `(OVERRIDE)`; some previously-quarantined rows now count as eligible.

- [ ] **Step 4: Final commit (if anything changed) — otherwise proceed to finish-branch**

No code changes are expected in this task. If the smoke run surfaced a discrepancy, fix it under TDD (add a failing test first) before continuing.

---

## Self-Review (completed during planning)

**Spec coverage:**
- Quarantine by entry date → Tasks 1, 2 (parse + cutoff + predicate). ✓
- Exit-reason derivation + mislabel truth table → Task 3 (all six cells + reconciled/indeterminate tested). ✓
- Wide closed-position reader, `node:sqlite`, read-only → Task 5. ✓
- Per-strategy/mislabel/indeterminate aggregation → Task 4. ✓
- Loud override + cutoff stamp + sandbox resolution + one-time markdown report → Tasks 6, 7. ✓
- Display-only / no DB writes → enforced by `{ readOnly: true }` (Task 5) and verified in Task 8 Step 2. ✓
- D-B8 parent-spec pin → already committed in the spec commit. ✓

**Placeholder scan:** none — every code step carries full code; commands have expected output.

**Type consistency:** position object shape (`exitPrice`, `realizedPnlPct`, `stopLossPrice`, `takeProfitPrice`, `storedStatus`, `agentStrategy`, `createdAt`, `notes`, `side`) is identical across the reader (Task 5), `deriveExitReason` (Task 3), and `buildRepairReport` (Task 4). Report shape (`cutoff{date,source}`, `perStrategy`, `mislabeled[]`, `indeterminate[]`) is identical across Task 4 and the renderer (Task 6). `cutoffDateToMs`/`isGraduationEligible`/`parseManagedTimestamp` signatures match every call site.

**Out of scope (per spec):** beta/daily-series/friction/graduation verdicts (Component 2), DB mutation, options/Harvest (`harvest_condors`), WAL checkpoint-before-read (a Component-2 scheduled-read concern).
