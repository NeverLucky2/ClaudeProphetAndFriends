# Bond-Carry / Roll-Down Sleeve — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pre-registered, lab-only backtest of a curve-aware Treasury carry/roll-down sleeve (hold IEF when the yield curve pays positive carry+roll over cash, else cash) and run it through the dual gate (ballast-graded tail-first edge + orthogonality, incl. the make-or-break "different hat" check vs Turtle's rates cluster), producing an honest KEEP / REJECT / INCONCLUSIVE verdict.

**Architecture:** Mirror the `cef-*` module layout (`scripts/carry-*.mjs`), reusing the S1/S2 engine (`fleet-correlate`, `fleet-align` `toWeekly`, `coil-threshold-metrics` block-bootstrap, `fleet-turtle-sim`, `fleet-bars` parser). The signal is computed from the FMP `treasury-rates` curve **shape** (a fundamental signal, not ETF price — the orthogonality bet). Pure functions are TDD'd with `node:test`; the orchestrator `carry-score.mjs` is controller-authored and verified by running end-to-end.

**Tech Stack:** Node.js ESM (`.mjs`), built-in `node:test` + `node:assert/strict`, FMP `stable/treasury-rates` + `stable/historical-price-eod/full` (key in project-root `.env`), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-06-bond-carry-rolldown-design.md` (read it before starting).

**Conventions (match the existing scripts):**
- All `scripts/carry-*.mjs` are ESM. Pure modules export named functions; `*.test.mjs` sit beside them.
- Run a single test file: `node --test scripts/carry-signal.test.mjs`. Run all carry tests: `node --test scripts/carry-*.test.mjs`.
- `data/lab/*` is gitignored — caches are regenerable, never committed. Commit only `scripts/carry-*.mjs` (+ tests), `docs/lab/bond-carry-{RESULTS,RUNBOOK}.md`, the spec, and this plan.
- Curve yields from FMP are in **percent** units (e.g. `4.25` = 4.25%). Keep them in percent through the signal; convert to decimal only for the cash daily-accrual (`/100/252`).
- Commit after each task. Re-assert the branch in the commit command (shared-root HEAD collision lesson): `test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown"`.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/carry-universe.mjs` | Single source of truth: tickers, curve fields, `MOD_DUR`/roll constants, train/holdout dates, cache subdir, friction/bootstrap params. |
| `scripts/carry-friction.mjs` | IEF round-trip cost (+ stress multiplier). |
| `scripts/carry-bars.mjs` | Loaders: `loadCarryBars` (ETF bars, reuses `parseBarsWithVolume`) + `loadCurve` (treasury curve rows ascending). |
| `scripts/carry-fetch.mjs` | One-shot network backfill (2002+): treasury curve + IEF/TLT/TIP/QQQ/SPY bars → `data/lab/carry-cache/`. Also prints the Task-0 data-wall probe. |
| `scripts/carry-signal.mjs` | Pure curve-shape signal: month-end sampling, carry+roll, term-spread twin, `decideHold` (sign-zero primary), threshold-binding diagnostic. |
| `scripts/carry-sim.mjs` | Monthly IEF↔cash position sim → daily mark-to-market (`{date,ret,active}`) + hold episodes; cash **accrued** not marked; friction on exit. |
| `scripts/carry-prereg.mjs` | `buildPrereg()` / `hashPrereg()` — hash-locks the design. |
| `scripts/carry-score.mjs` | Orchestrator: prereg → sim (1×/2×) → edge gate + rate-shock dodge (descriptive) → orthogonality gate (+ steepening cut, co-active ρ) → twin verdict → RESULTS. |
| `docs/lab/bond-carry-RESULTS.md` | Generated verdict + tables. |
| `docs/lab/bond-carry-RUNBOOK.md` | How to reproduce + Task-0 data-wall findings. |

---

## Task 1: `carry-universe.mjs` — constants

**Files:**
- Create: `scripts/carry-universe.mjs`
- Test: `scripts/carry-universe.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/carry-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DURATION_ETF, RATES_CLUSTER, BENCHMARKS, CARRY_TICKERS,
  MOD_DUR, ROLL_FROM, ROLL_TO, CASH_FIELD, CARRY_CACHE_SUBDIR,
} from './carry-universe.mjs';

test('duration leg is IEF; rates cluster is Turtle\'s {TLT,IEF,TIP}', () => {
  assert.equal(DURATION_ETF, 'IEF');
  assert.deepEqual([...RATES_CLUSTER].sort(), ['IEF', 'TIP', 'TLT']);
});
test('CARRY_TICKERS is the de-duped union of duration+cluster+benchmarks', () => {
  assert.ok(CARRY_TICKERS.includes('IEF') && CARRY_TICKERS.includes('QQQ'));
  assert.equal(CARRY_TICKERS.length, new Set(CARRY_TICKERS).size);
});
test('roll constants are the documented defaults', () => {
  assert.equal(MOD_DUR, 7.5);
  assert.equal(ROLL_FROM, 'y10');
  assert.equal(ROLL_TO, 'y7');
  assert.equal(CASH_FIELD, 'm3');
});
test('cache subdir lives under data/lab', () => {
  assert.ok(CARRY_CACHE_SUBDIR.replaceAll('\\', '/').endsWith('data/lab/carry-cache'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/carry-universe.test.mjs`
Expected: FAIL (Cannot find module './carry-universe.mjs').

- [ ] **Step 3: Write the implementation**

```js
// scripts/carry-universe.mjs
// Single source of truth for the bond-carry study. Duration leg (IEF) + Turtle's rates cluster
// (the "different hat" comparator) + benchmarks + curve constants + windows.
import { join } from 'node:path';

export const DURATION_ETF = 'IEF';                  // 7–10y Treasury, the duration leg
export const RATES_CLUSTER = ['TLT', 'IEF', 'TIP']; // Turtle-v2 rates cluster (Gate 2.4 comparator)
export const BENCHMARKS = ['QQQ', 'SPY'];
export const CARRY_TICKERS = [...new Set([DURATION_ETF, ...RATES_CLUSTER, ...BENCHMARKS])];

// Curve points from FMP stable/treasury-rates, normalized keys (percent units; e.g. 4.25 = 4.25%).
export const CURVE_FIELDS = ['m3', 'y2', 'y5', 'y7', 'y10', 'y30'];
export const MOD_DUR = 7.5;     // representative IEF modified duration — fixed, documented, NOT fit
export const ROLL_FROM = 'y10'; // carry point (~IEF maturity)
export const ROLL_TO = 'y7';    // one roll-step down (10y slides toward 7y); interpolate if y7 absent
export const CASH_FIELD = 'm3'; // 3-month T-bill = cash opportunity cost + accrual rate

export const FETCH_FROM = '2002-07-01'; // IEF inception; Task-0 probe confirms true curve depth
export const TRAIN_END = '2014-12-31';  // train = diagnostic window only (primary rule is param-free)
export const HOLDOUT_START = '2015-01-01';
export const STUDY_END = '2026-06-06';

export const CARRY_CACHE_SUBDIR = join('data', 'lab', 'carry-cache');

export const EDGE_BLOCK_WEEKS = 26;        // ~6 months — captures curve-regime persistence
export const FRICTION_HALF_SPREAD_BPS = 1.5; // IEF ultra-liquid; round-trip ≈ 3bps
export const BUFFER_GRID_BPS = [25, 50];   // robustness variant only (percent: 0.25, 0.50)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/carry-universe.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown" && \
git add scripts/carry-universe.mjs scripts/carry-universe.test.mjs && \
git commit -m "feat(carry): universe + curve/roll constants"
```

---

## Task 2: `carry-friction.mjs` — round-trip cost

**Files:**
- Create: `scripts/carry-friction.mjs`
- Test: `scripts/carry-friction.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/carry-friction.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundTripCost } from './carry-friction.mjs';

test('round trip = 2 * half-spread (1.5bps) = 3bps', () => {
  assert.ok(Math.abs(roundTripCost(1) - 0.0003) < 1e-9);
});
test('2x stress doubles it', () => {
  assert.ok(Math.abs(roundTripCost(2) - 0.0006) < 1e-9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/carry-friction.test.mjs`
Expected: FAIL (Cannot find module).

- [ ] **Step 3: Write the implementation**

```js
// scripts/carry-friction.mjs
// One completed IEF hold = buy + sell = round trip = 2 * half-spread. Charged once on the exit
// day of each hold episode (see carry-sim). stressMult scales worst-case fills.
import { FRICTION_HALF_SPREAD_BPS } from './carry-universe.mjs';

export function roundTripCost(stressMult = 1) {
  return 2 * (FRICTION_HALF_SPREAD_BPS / 10000) * stressMult;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/carry-friction.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown" && \
git add scripts/carry-friction.mjs scripts/carry-friction.test.mjs && \
git commit -m "feat(carry): IEF round-trip friction"
```

---

## Task 3: `carry-bars.mjs` — bar + curve loaders

**Files:**
- Create: `scripts/carry-bars.mjs`
- Test: `scripts/carry-bars.test.mjs`

Note: `parseBarsWithVolume` (from `coil-eventstudy-bars.mjs`) parses `{written_at, bars:[{Timestamp,Open,High,Low,Close,Volume}]}` → `[{date,open,high,low,close,volume}]` ascending. `carry-fetch` writes that exact shape, so we reuse it.

- [ ] **Step 1: Write the failing test**

```js
// scripts/carry-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCarryBars, loadCurve } from './carry-bars.mjs';
import { CARRY_CACHE_SUBDIR } from './carry-universe.mjs';

function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'carry-'));
  mkdirSync(join(root, CARRY_CACHE_SUBDIR), { recursive: true });
  return root;
}

test('loadCarryBars returns [] when the ticker cache is missing', () => {
  assert.deepEqual(loadCarryBars(tmpRoot(), 'IEF'), []);
});
test('loadCarryBars parses the fleet-style bar JSON ascending', () => {
  const root = tmpRoot();
  writeFileSync(join(root, CARRY_CACHE_SUBDIR, 'IEF.json'), JSON.stringify({
    written_at: 'x',
    bars: [
      { Timestamp: '2002-07-30T12:00:00Z', Open: 80, High: 81, Low: 79, Close: 80.5, Volume: 1000 },
      { Timestamp: '2002-07-31T12:00:00Z', Open: 80.5, High: 82, Low: 80, Close: 81.2, Volume: 1200 },
    ],
  }));
  const bars = loadCarryBars(root, 'IEF');
  assert.equal(bars.length, 2);
  assert.equal(bars[0].date, '2002-07-30');
  assert.equal(bars[1].close, 81.2);
});
test('loadCurve returns rows sorted ascending by date', () => {
  const root = tmpRoot();
  writeFileSync(join(root, CARRY_CACHE_SUBDIR, 'treasury-rates.json'), JSON.stringify({
    written_at: 'x',
    curve: [
      { date: '2022-02-01', m3: 0.3, y7: 1.8, y10: 1.9 },
      { date: '2022-01-03', m3: 0.1, y7: 1.6, y10: 1.7 },
    ],
  }));
  const curve = loadCurve(root);
  assert.equal(curve.length, 2);
  assert.equal(curve[0].date, '2022-01-03');
  assert.equal(curve[1].y10, 1.9);
});
test('loadCurve returns [] when absent', () => {
  assert.deepEqual(loadCurve(tmpRoot()), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/carry-bars.test.mjs`
Expected: FAIL (Cannot find module).

- [ ] **Step 3: Write the implementation**

```js
// scripts/carry-bars.mjs
// Dedicated carry-study cache (isolated from the S1 fleet cache so the 2002-start deep backfill
// never mutates it). ETF bars reuse the fleet bar parser; the treasury curve is its own JSON.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBarsWithVolume } from './coil-eventstudy-bars.mjs';
import { CARRY_CACHE_SUBDIR } from './carry-universe.mjs';

export function loadCarryBars(projectRoot, ticker) {
  const path = join(projectRoot, CARRY_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  try { return parseBarsWithVolume(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return []; }
}

// Treasury curve rows ascending: [{date, m3, y2, y5, y7, y10, y30}] (percent units; missing = null).
export function loadCurve(projectRoot) {
  const path = join(projectRoot, CARRY_CACHE_SUBDIR, 'treasury-rates.json');
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return (obj.curve || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/carry-bars.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown" && \
git add scripts/carry-bars.mjs scripts/carry-bars.test.mjs && \
git commit -m "feat(carry): bar + treasury-curve cache loaders"
```

---

## Task 4: `carry-signal.mjs` — curve-shape carry+roll signal

**Files:**
- Create: `scripts/carry-signal.mjs`
- Test: `scripts/carry-signal.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/carry-signal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthEndCurve, carryRollSignal, termSpread, decideHold,
  monthlyDecisions, thresholdBindingFraction,
} from './carry-signal.mjs';

const CURVE = [
  { date: '2021-12-15', m3: 0.05, y7: 1.30, y10: 1.50 },
  { date: '2021-12-31', m3: 0.06, y7: 1.40, y10: 1.52 }, // month-end Dec 2021
  { date: '2022-01-31', m3: 0.20, y7: 1.80, y10: 1.78 }, // month-end Jan 2022
];

test('monthEndCurve keeps the last row of each calendar month', () => {
  const me = monthEndCurve(CURVE);
  assert.equal(me.length, 2);
  assert.equal(me[0].date, '2021-12-31');
  assert.equal(me[1].date, '2022-01-31');
});
test('carryRollSignal = (y10 + ModDur*(y10-y7)) - m3, in percent', () => {
  // (1.52 + 7.5*(1.52-1.40)) - 0.06 = 1.52 + 0.9 - 0.06 = 2.36
  assert.ok(Math.abs(carryRollSignal(CURVE[1]) - 2.36) < 1e-9);
});
test('carryRollSignal goes negative when the curve inverts (y10<y7) and cash is high', () => {
  // (1.78 + 7.5*(1.78-1.80)) - 0.20 = 1.78 - 0.15 - 0.20 = 1.43  (still positive here)
  // construct an inverted, high-cash row that flips negative:
  const inv = { date: '2023-06-30', m3: 5.4, y7: 4.2, y10: 4.0 };
  // (4.0 + 7.5*(4.0-4.2)) - 5.4 = 4.0 - 1.5 - 5.4 = -2.9
  assert.ok(carryRollSignal(inv) < 0);
});
test('termSpread = y10 - m3 (ModDur-free twin)', () => {
  assert.ok(Math.abs(termSpread(CURVE[1]) - (1.52 - 0.06)) < 1e-9);
});
test('decideHold is sign>buffer (sign-zero primary)', () => {
  assert.equal(decideHold(2.36, 0), true);
  assert.equal(decideHold(-2.9, 0), false);
  assert.equal(decideHold(0.20, 0.25), false); // +25bp buffer not cleared
  assert.equal(decideHold(null, 0), false);
});
test('monthlyDecisions maps each month-end to {month, value, hold}', () => {
  const d = monthlyDecisions(CURVE, carryRollSignal, { buffer: 0 });
  assert.equal(d.length, 2);
  assert.equal(d[0].month, '2021-12');
  assert.equal(d[0].hold, true);
});
test('thresholdBindingFraction reports how often a buffer flips the sign-only decision', () => {
  // both months have large positive signals; +25bp buffer flips neither
  assert.equal(thresholdBindingFraction(CURVE, carryRollSignal, 0.25), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/carry-signal.test.mjs`
Expected: FAIL (Cannot find module).

- [ ] **Step 3: Write the implementation**

```js
// scripts/carry-signal.mjs
// Curve-SHAPE carry+roll signal (fundamental, NOT ETF price — the orthogonality bet). Monthly:
// hold IEF when the curve pays positive carry+roll over cash; else cash. Term-spread is the
// ModDur-free robustness twin. All yields in percent (curve units).
import { MOD_DUR, ROLL_FROM, ROLL_TO, CASH_FIELD } from './carry-universe.mjs';

// Last available curve row of each calendar month (month-end sample), ascending.
export function monthEndCurve(curve) {
  const byMonth = new Map();
  for (const row of curve) byMonth.set(row.date.slice(0, 7), row); // ascending input → last wins
  return [...byMonth.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// carry + roll over cash, percent units. roll = ModDur * (y_from - y_to) (slide down the curve).
export function carryRollSignal(row, { modDur = MOD_DUR, from = ROLL_FROM, to = ROLL_TO, cash = CASH_FIELD } = {}) {
  const yFrom = row[from], yTo = row[to], yCash = row[cash];
  if (yFrom == null || yTo == null || yCash == null) return null;
  return (yFrom + modDur * (yFrom - yTo)) - yCash;
}

// ModDur-free twin: term spread y10 - y3mo.
export function termSpread(row, { from = ROLL_FROM, cash = CASH_FIELD } = {}) {
  if (row[from] == null || row[cash] == null) return null;
  return row[from] - row[cash];
}

// Hold when value strictly exceeds buffer (percent). buffer=0 is the parameter-free primary rule.
export function decideHold(value, buffer = 0) { return value != null && value > buffer; }

// Monthly decisions for a signal fn. Returns [{month, date, value, hold}].
export function monthlyDecisions(curve, signalFn, { buffer = 0 } = {}) {
  return monthEndCurve(curve).map((row) => {
    const value = signalFn(row);
    return { month: row.date.slice(0, 7), date: row.date, value, hold: decideHold(value, buffer) };
  });
}

// Diagnostic: fraction of months where a nonzero buffer flips the sign-only decision.
export function thresholdBindingFraction(curve, signalFn, buffer) {
  let flips = 0, n = 0;
  for (const row of monthEndCurve(curve)) {
    const v = signalFn(row); if (v == null) continue;
    n += 1;
    if (decideHold(v, 0) !== decideHold(v, buffer)) flips += 1;
  }
  return n ? flips / n : 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/carry-signal.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown" && \
git add scripts/carry-signal.mjs scripts/carry-signal.test.mjs && \
git commit -m "feat(carry): curve-shape carry+roll signal + term-spread twin"
```

---

## Task 5: `carry-sim.mjs` — monthly IEF↔cash sim, daily mark-to-market

**Files:**
- Create: `scripts/carry-sim.mjs`
- Test: `scripts/carry-sim.test.mjs`

Position for calendar month *X* is the decision made at the **end of month X−1** (no look-ahead); the cash rate during month *X* is that prior month-end's `m3`. Cash is **accrued** (`m3/100/252` per day, zero price vol), never marked. Friction (round trip) is charged once on the exit day of each hold episode.

- [ ] **Step 1: Write the failing test**

```js
// scripts/carry-sim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthPlan, simulateCarry } from './carry-sim.mjs';
import { roundTripCost } from './carry-friction.mjs';

// month-end curve rows (ascending) + monthly decisions aligned to them.
const ME = [
  { date: '2021-12-31', m3: 1.20 }, // sets month plan for 2022-01
  { date: '2022-01-31', m3: 2.40 }, // sets month plan for 2022-02
];
const DEC = [
  { month: '2021-12', hold: true },  // → 2022-01 holds IEF
  { month: '2022-01', hold: false }, // → 2022-02 cash
];

test('buildMonthPlan shifts each month-end decision to the NEXT month, carrying its cash rate', () => {
  const plan = buildMonthPlan(ME, DEC);
  assert.deepEqual(plan.get('2022-01'), { hold: true, cashRate: 1.20 });
  assert.deepEqual(plan.get('2022-02'), { hold: false, cashRate: 2.40 });
});

const IEF = [
  { date: '2022-01-03', close: 100 },
  { date: '2022-01-04', close: 101 }, // +1% holding day (Jan → hold)
  { date: '2022-02-01', close: 99 },  // first cash day (Feb → cash): exit charged here
  { date: '2022-02-02', close: 98 },  // cash day
];

test('holding days take IEF price return + active=true', () => {
  const plan = buildMonthPlan(ME, DEC);
  const { daily } = simulateCarry(IEF, plan, { stressMult: 1, start: '2022-01-01', end: '2022-12-31' });
  const jan4 = daily.find((d) => d.date === '2022-01-04');
  assert.ok(Math.abs(jan4.ret - 0.01) < 1e-9);
  assert.equal(jan4.active, true);
});
test('cash days accrue m3/100/252 with zero price vol + active=false; exit day pays the round trip', () => {
  const plan = buildMonthPlan(ME, DEC);
  const { daily, episodes } = simulateCarry(IEF, plan, { stressMult: 1, start: '2022-01-01', end: '2022-12-31' });
  const feb1 = daily.find((d) => d.date === '2022-02-01'); // exit day (was holding, now cash)
  const expectedAccrual = (2.40 / 100) / 252;
  assert.ok(Math.abs(feb1.ret - (expectedAccrual - roundTripCost(1))) < 1e-12);
  assert.equal(feb1.active, false);
  const feb2 = daily.find((d) => d.date === '2022-02-02'); // pure cash day, no friction
  assert.ok(Math.abs(feb2.ret - expectedAccrual) < 1e-12);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].start, '2022-01-04'); // first holding day with a return
  assert.equal(episodes[0].end, '2022-01-04');   // last holding day before exit
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/carry-sim.test.mjs`
Expected: FAIL (Cannot find module).

- [ ] **Step 3: Write the implementation**

```js
// scripts/carry-sim.mjs
// Monthly IEF↔cash sim → daily mark-to-market. Position for month X = decision at end of X-1
// (no look-ahead); cash during X accrues that prior month-end's m3 (zero price vol). Friction
// (round trip) charged once on the exit day of each hold episode.
import { roundTripCost } from './carry-friction.mjs';

// monthEndRows ascending [{date,...,m3}], decisions [{month,hold}] aligned to the SAME month-ends.
// Returns Map<'YYYY-MM', {hold, cashRate}> effective DURING that calendar month.
export function buildMonthPlan(monthEndRows, decisions, { cash = 'm3' } = {}) {
  const plan = new Map();
  const decByMonth = new Map(decisions.map((d) => [d.month, d]));
  for (let i = 0; i < monthEndRows.length; i += 1) {
    const cur = monthEndRows[i];
    const curMonth = cur.date.slice(0, 7);
    const dec = decByMonth.get(curMonth);
    // the decision/rate at end of curMonth governs the FOLLOWING calendar month
    const [y, m] = curMonth.split('-').map(Number);
    const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    plan.set(nextMonth, { hold: !!(dec && dec.hold), cashRate: cur[cash] });
  }
  return plan;
}

export function simulateCarry(iefBars, monthPlan, { stressMult = 1, start, end } = {}) {
  const bars = iefBars.filter((b) => (!start || b.date >= start) && (!end || b.date <= end));
  const daily = []; const episodes = [];
  let holding = false; let epStart = null; let epLast = null;
  for (let i = 1; i < bars.length; i += 1) {
    const b = bars[i];
    const pm = monthPlan.get(b.date.slice(0, 7));
    const wantHold = !!(pm && pm.hold);
    const cashRate = pm ? pm.cashRate : null;
    let ret;
    if (wantHold) {
      ret = bars[i].close / bars[i - 1].close - 1;
      if (!holding) { holding = true; epStart = b.date; }
      epLast = b.date;
    } else {
      ret = cashRate == null ? 0 : (cashRate / 100) / 252; // accrued, zero price vol
      if (holding) {
        ret -= roundTripCost(stressMult);                  // exit cost on the transition day
        episodes.push({ start: epStart, end: epLast });
        holding = false; epStart = null; epLast = null;
      }
    }
    daily.push({ date: b.date, ret, active: wantHold });
  }
  if (holding) episodes.push({ start: epStart, end: epLast });
  return { daily, episodes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/carry-sim.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown" && \
git add scripts/carry-sim.mjs scripts/carry-sim.test.mjs && \
git commit -m "feat(carry): monthly IEF/cash sim with accrued cash + exit friction"
```

---

## Task 6: `carry-prereg.mjs` — hash-locked pre-registration

**Files:**
- Create: `scripts/carry-prereg.mjs`
- Test: `scripts/carry-prereg.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/carry-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, hashPrereg } from './carry-prereg.mjs';

test('prereg names the study, the sign-zero primary rule, and the dual gate', () => {
  const p = buildPrereg();
  assert.equal(p.study, 'bond-carry-rolldown');
  assert.equal(p.signal.primary_rule, 'sign(carry_roll)>0');
  assert.ok(p.orthogonality_gate.turtle_rates_rho_max === 0.3);
  assert.ok(Array.isArray(p.acceptable_findings) && p.acceptable_findings.length >= 3);
});
test('hash is deterministic + sensitive to content', () => {
  const a = hashPrereg(buildPrereg());
  const b = hashPrereg(buildPrereg());
  assert.equal(a, b);
  assert.equal(a.length, 64);
  const mutated = { ...buildPrereg(), study: 'changed' };
  assert.notEqual(hashPrereg(mutated), a);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/carry-prereg.test.mjs`
Expected: FAIL (Cannot find module).

- [ ] **Step 3: Write the implementation**

```js
// scripts/carry-prereg.mjs
import { createHash } from 'node:crypto';
import {
  TRAIN_END, HOLDOUT_START, STUDY_END, MOD_DUR, ROLL_FROM, ROLL_TO, CASH_FIELD,
  EDGE_BLOCK_WEEKS, FRICTION_HALF_SPREAD_BPS,
} from './carry-universe.mjs';

export function buildPrereg() {
  return {
    study: 'bond-carry-rolldown',
    window: { fetch_from: '2002-07', train_end: TRAIN_END, holdout_start: HOLDOUT_START, end: STUDY_END,
      train_role: 'diagnostic_only_threshold_binding_fraction', holdout_role: 'all_gate_evaluation' },
    signal: { source: 'fmp_treasury_curve_shape_not_price', formula: 'y10 + ModDur*(y10-y7) - m3',
      mod_dur: MOD_DUR, roll_from: ROLL_FROM, roll_to: ROLL_TO, cash: CASH_FIELD,
      primary_rule: 'sign(carry_roll)>0', buffer_grid_bps: [25, 50], buffer_role: 'robustness_only',
      twin: 'term_spread_y10_minus_m3_no_ModDur', twin_rule: 'verdict_disagreement_downgrades_KEEP_to_INCONCLUSIVE',
      rebalance: 'monthly' },
    universe: { duration_leg: 'IEF', out_leg: 'cash_accrued_m3_zero_vol' },
    friction: { half_spread_bps: FRICTION_HALF_SPREAD_BPS, basis: 'round_trip_on_exit', stress: 2 },
    edge_gate: {
      ballast_graded: true,
      a_friction_net_holdout_ci_gt_0: { block_weeks: EDGE_BLOCK_WEEKS },
      b_dodge_check: 'DESCRIPTIVE_not_CI: rate-shock weeks = top-decile weekly d(y10); report cash-fraction + vs buy-hold IEF; bootstrap decorative; KEEP-on-edge requires cash through the 2022 drawdown as dated fact',
      c_2x_friction_stress: true,
      power_flag_on_b: 'independent_rate_shock_episode_count',
    },
    orthogonality_gate: {
      qqq_beta_ci_near_0: true, qqq_rho_max: 0.3, crisis_mean_ci_not_below_0: true,
      lane_rho_max: 0.3, lanes: ['Coil', 'Turtle', 'Drift', 'DefProxy'],
      turtle_rates_rho_max: 0.3, turtle_rates_rho_reported: 'all_weeks_AND_co_active_weeks',
    },
    steepening_cut: 'DESCRIPTIVE: classify each held episode bull vs bear by sign of d(y10) over the hold; report tail behavior per regime; downgrades confidence in a KEEP if ballast reading is bull-steepening-only',
    verdict: { keep_requires: 'gate2_pass AND dodge-narrative-shows-cash-through-2022 AND twin-agrees',
      keep_confidence: 'provisional_pending_more_regimes', reject_trustworthy: 'gate2_full_series_well_powered' },
    acceptable_findings: [
      'co-moves with Turtle-rates (different hat) -> REJECT (base case)',
      'too few independent rate regimes -> INCONCLUSIVE',
      'monthly signal lags the turn, still long duration into 2022 -> fails dodge',
      'genuinely orthogonal AND dodges 2022 -> provisional KEEP',
      'twin disagreement -> INCONCLUSIVE',
    ],
  };
}

function canonical(o) {
  if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
  if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  return JSON.stringify(o);
}
export function hashPrereg(prereg) { return createHash('sha256').update(canonical(prereg)).digest('hex'); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/carry-prereg.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown" && \
git add scripts/carry-prereg.mjs scripts/carry-prereg.test.mjs && \
git commit -m "feat(carry): hash-locked pre-registration"
```

---

## Task 7: `carry-fetch.mjs` + Task-0 data-wall probe (network, no unit test)

**Files:**
- Create: `scripts/carry-fetch.mjs`
- Modify: `docs/lab/bond-carry-RUNBOOK.md` (create, record probe findings)

This is a one-shot network backfill (no unit test — it hits FMP). It fetches the treasury curve and IEF/TLT/TIP/QQQ/SPY bars from 2002 into `data/lab/carry-cache/`, and prints the **Task-0 data-wall probe**: the true earliest curve date and which `yearN`/`monthN` fields FMP returns (confirming `y7` exists or that we must interpolate).

- [ ] **Step 1: Write `carry-fetch.mjs`**

```js
// scripts/carry-fetch.mjs
// One-shot FMP backfill → data/lab/carry-cache/. Treasury curve (stable/treasury-rates) +
// IEF/TLT/TIP/QQQ/SPY EOD bars (stable/historical-price-eod/full), 2002→today. Prints the
// Task-0 data-wall probe. Requires FMP_API_KEY (source project-root .env first).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fmpEodToBars } from './ema-bars.mjs';
import { CARRY_CACHE_SUBDIR, CARRY_TICKERS, FETCH_FROM } from './carry-universe.mjs';

const KEY = process.env.FMP_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalize FMP treasury fields → our keys; null when a maturity is absent.
function normCurveRow(r) {
  const num = (v) => (v == null || v === '' ? null : Number(v));
  return { date: r.date, m3: num(r.month3), y2: num(r.year2), y5: num(r.year5),
    y7: num(r.year7), y10: num(r.year10), y30: num(r.year30) };
}

async function fetchCurve(to) {
  // treasury-rates accepts from/to; page if needed. One call usually returns the full range.
  const url = `https://financialmodelingprep.com/stable/treasury-rates?from=${FETCH_FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`treasury-rates: HTTP ${res.status}`);
  const rows = (await res.json()).map(normCurveRow).filter((r) => r.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

async function fetchBars(ticker, to) {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${FETCH_FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  return fmpEodToBars(await res.json());
}

{
  if (!KEY) { process.stderr.write('FMP_API_KEY not set — source project-root .env first.\n'); process.exit(2); }
  const root = process.cwd();
  const to = new Date().toISOString().slice(0, 10);
  mkdirSync(join(root, CARRY_CACHE_SUBDIR), { recursive: true });

  const curve = await fetchCurve(to);
  writeFileSync(join(root, CARRY_CACHE_SUBDIR, 'treasury-rates.json'),
    JSON.stringify({ written_at: new Date().toISOString(), curve }));

  // ── Task-0 data-wall probe ──
  const fields = curve.length ? Object.keys(curve[0]).filter((k) => k !== 'date' && curve[0][k] != null) : [];
  const y7present = curve.some((r) => r.y7 != null);
  process.stdout.write(`\n[TASK-0 PROBE] curve rows: ${curve.length}; earliest: ${curve[0]?.date}; latest: ${curve.at(-1)?.date}\n`);
  process.stdout.write(`[TASK-0 PROBE] non-null fields in first row: ${fields.join(', ')}\n`);
  process.stdout.write(`[TASK-0 PROBE] y7 (year7) present anywhere: ${y7present} (if false → interpolate y5/y10 in carry-universe ROLL_TO handling)\n`);

  let ok = 0, fail = 0;
  for (const t of CARRY_TICKERS) {
    try {
      const bars = await fetchBars(t, to);
      writeFileSync(join(root, CARRY_CACHE_SUBDIR, `${t}.json`),
        JSON.stringify({ written_at: new Date().toISOString(),
          bars: bars.map((b) => ({ Timestamp: `${b.date}T12:00:00Z`, Open: b.open, High: b.high, Low: b.low, Close: b.close, Volume: b.volume })) }));
      ok += 1;
      process.stdout.write(`${t}: ${bars.length} bars (${bars[0]?.date} → ${bars.at(-1)?.date})\n`);
    } catch (e) { fail += 1; process.stderr.write(`${e.message}\n`); }
    await sleep(250);
  }
  process.stdout.write(`\ncarry-fetch done: curve ${curve.length} rows, ${ok}/${CARRY_TICKERS.length} ETFs ok, ${fail} failed\n`);
}
```

- [ ] **Step 2: Source the key and run the fetch**

```bash
export $(grep -v '^#' .env | grep FMP_API_KEY | xargs)
node scripts/carry-fetch.mjs
```

Expected: prints `[TASK-0 PROBE]` lines + per-ticker bar counts. **Record the three probe lines** verbatim into the RUNBOOK (next step).

- [ ] **Step 3: Act on the probe (decision point — pre-registration integrity)**

Inspect the probe output and handle these cases **before** Task 8 reads any return:
- **If `y7` is present anywhere = false:** change `ROLL_TO` handling — in `carry-signal.mjs` `carryRollSignal`, when `row.y7 == null`, interpolate `y7 ≈ (row.y5 + row.y10) / 2`. Add a one-line test for the interpolation branch; re-run `node --test scripts/carry-signal.test.mjs`. Update `carry-universe` comment + `carry-prereg` `roll_to` note.
- **If earliest curve date > 2002-07** (e.g. 2010): set `carry-universe` `FETCH_FROM`/`TRAIN_END`/`HOLDOUT_START` so the holdout still contains 2022 (e.g. train = earliest→2018, holdout = 2019→2026), and add a "reduced-power: curve depth only reaches <date>" note for RESULTS. Re-run the affected unit tests.
- **If a maturity used by the signal is missing in many rows:** prefer the nearest available point and document it.

These are pre-registration inputs: any change here must land **before** the orchestrator computes a single return. If no change is needed, state that explicitly in the RUNBOOK.

- [ ] **Step 4: Populate the S1 fleet cache (needed by the orchestrator's lane-ρ)**

The orchestrator reuses the S1 builders for Coil/Turtle/Drift/DefProxy + QQQ, which read `data/lab/fleet-bar-cache/` and `data/lab/fleet-earnings.json`. These are gitignored, so absent in this fresh worktree. Regenerate them:

```bash
node scripts/fleet-fetch-bars.mjs
node scripts/fleet-fetch-earnings.mjs
```

Expected: `fleet-fetch-bars done: N/N ok` and an earnings JSON written. (These fetch from 2014 — fine, the carry sleeve only overlaps those lanes 2015+.)

- [ ] **Step 5: Write the RUNBOOK with probe findings**

Create `docs/lab/bond-carry-RUNBOOK.md`:

```markdown
# Bond-Carry / Roll-Down Sleeve — RUNBOOK

## Reproduce
1. `export $(grep -v '^#' .env | grep FMP_API_KEY | xargs)`
2. `node scripts/carry-fetch.mjs`            # treasury curve + IEF/TLT/TIP/QQQ/SPY (2002+) → data/lab/carry-cache
3. `node scripts/fleet-fetch-bars.mjs && node scripts/fleet-fetch-earnings.mjs`  # S1 lanes (Coil/Turtle/Drift/DefProxy)
4. `node --test scripts/carry-*.test.mjs`    # unit tests
5. `node scripts/carry-score.mjs --root .`   # prereg → sim → gates → docs/lab/bond-carry-RESULTS.md

## Task-0 data-wall findings (2026-06-06)
- curve rows / earliest / latest: <paste probe line 1>
- non-null fields: <paste probe line 2>
- y7 present: <paste probe line 3>
- Action taken: <none | y7-interpolation | window-shift to keep 2022 in holdout — describe>

## Notes
- data/lab/* is gitignored; only this RUNBOOK + RESULTS + scripts are committed.
- Lab-only, paper, no deploy, no agent reads it.
```

- [ ] **Step 6: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown" && \
git add scripts/carry-fetch.mjs docs/lab/bond-carry-RUNBOOK.md scripts/carry-signal.mjs scripts/carry-signal.test.mjs scripts/carry-universe.mjs scripts/carry-prereg.mjs && \
git commit -m "feat(carry): FMP backfill + Task-0 data-wall probe + RUNBOOK"
```

(Include the signal/universe/prereg files only if the probe forced a change; otherwise drop them from the `git add`.)

---

## Task 8: `carry-score.mjs` — orchestrator (controller-authored, verified by running)

**Files:**
- Create: `scripts/carry-score.mjs`
- Generates: `docs/lab/bond-carry-RESULTS.md`

This is the integration task. It has no unit test; it is verified by running end-to-end and reviewing the RESULTS. Follow the `cef-score.mjs` template (read it: `scripts/cef-score.mjs`) and the gate definitions in spec §5. Build it in clearly-commented sections.

- [ ] **Step 1: Write `carry-score.mjs`**

Structure (each `// N)` is a section; fill with the math below):

```js
// scripts/carry-score.mjs
// Orchestrator: prereg FIRST → carry sleeve sim (carry+roll signal, 1x/2x friction) → edge gate
// (Gate 1a/c weekly block-bootstrap holdout) + rate-shock dodge (Gate 1b DESCRIPTIVE) →
// orthogonality (Gate 2 reuse fleet-correlate: β/ρ to QQQ, crisis mean, lane-ρ, Turtle-rates ρ
// all + co-active) + steepening cut (Gate 2b) → twin verdict (term-spread) → KEEP/REJECT/
// INCONCLUSIVE → RESULTS. Run: node scripts/carry-score.mjs --root .
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildPrereg, hashPrereg } from './carry-prereg.mjs';
import { loadCarryBars, loadCurve } from './carry-bars.mjs';
import { DURATION_ETF, RATES_CLUSTER, HOLDOUT_START, STUDY_END, EDGE_BLOCK_WEEKS, BUFFER_GRID_BPS } from './carry-universe.mjs';
import { monthEndCurve, carryRollSignal, termSpread, monthlyDecisions, thresholdBindingFraction } from './carry-signal.mjs';
import { buildMonthPlan, simulateCarry } from './carry-sim.mjs';
import { toWeekly } from './fleet-align.mjs';
import { loadFleetBars } from './fleet-bars.mjs';
import { simulateTurtle } from './fleet-turtle-sim.mjs';
import { buildCoilSeries } from './fleet-coil-marks.mjs';
import { buildDriftSeries } from './fleet-drift-sim.mjs';
import { pearson, betaTo, bootstrapBetaCI, crisisWeeks, crisisMean, crisisMeanCI } from './fleet-correlate.mjs';
import { bootstrapMeanCI } from './coil-threshold-metrics.mjs';
// NOTE: also import the DefProxy builder — first read scripts/fleet-defensive-proxy.mjs to confirm
// its exact export name + signature, then import it here (e.g. buildDefensiveProxySeries).

const f = (x, d = 3) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const pc = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : (100 * x).toFixed(d) + '%');
const dailyRet = (bars, start) => { const o = []; for (let i = 1; i < bars.length; i += 1) if (bars[i].date >= start) o.push({ date: bars[i].date, ret: bars[i].close / bars[i - 1].close - 1, active: true }); return o; };
const wkMap = (weekly) => new Map(weekly.map((p) => [p.week, p.ret]));
function alignOnWeek(byName) { const maps = Object.fromEntries(Object.entries(byName).map(([n, w]) => [n, wkMap(w)])); const names = Object.keys(maps); const weeks = [...maps[names[0]].keys()].filter((wk) => names.every((n) => maps[n].has(wk))).sort(); const vec = {}; for (const n of names) vec[n] = weeks.map((wk) => maps[n].get(wk)); return { weeks, vec }; }

// Weekly y10 series + week-over-week change, from the curve (last curve row per ISO week).
function weeklyY10Changes(curve) {
  const byWk = new Map();
  for (const r of curve) if (r.y10 != null) byWk.set(isoWeekKeyLocal(r.date), { week: isoWeekKeyLocal(r.date), date: r.date, y10: r.y10 });
  const rows = [...byWk.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  const out = [];
  for (let i = 1; i < rows.length; i += 1) out.push({ week: rows[i].week, date: rows[i].date, dY10: rows[i].y10 - rows[i - 1].y10 });
  return out;
}
// reuse isoWeekKey from fleet-align (import it instead of re-implementing):
import { isoWeekKey as isoWeekKeyLocal } from './fleet-align.mjs';

// Run the WHOLE pipeline for one signal fn → a verdict bundle (so we can run carry+roll AND the twin).
function evaluate(signalFn, { root, curve, iefBars, qqqWk, laneWk, turtleRatesWk }) {
  const me = monthEndCurve(curve);
  const decisions = monthlyDecisions(curve, signalFn, { buffer: 0 });   // sign-zero primary
  const plan = buildMonthPlan(me, decisions);
  const sim1 = simulateCarry(iefBars, plan, { stressMult: 1, end: STUDY_END });
  const sim2 = simulateCarry(iefBars, plan, { stressMult: 2, end: STUDY_END });
  const sleeveWk = toWeekly(sim1.daily);
  const sleeveWk2 = toWeekly(sim2.daily);
  const holdout = (wk) => wk.filter((p) => p.date >= HOLDOUT_START);
  // Gate 1a/c — edge (holdout weekly block bootstrap, 1x + 2x)
  const toRows = (wk) => holdout(wk).map((p) => ({ date: p.week, net: p.ret }));
  const edge1 = bootstrapMeanCI(toRows(sleeveWk), { blockSessions: EDGE_BLOCK_WEEKS, iterations: 2000, seed: 7 });
  const edge2 = bootstrapMeanCI(toRows(sleeveWk2), { blockSessions: EDGE_BLOCK_WEEKS, iterations: 2000, seed: 7 });
  // Gate 1b — rate-shock dodge (DESCRIPTIVE). rate-shock weeks = top-decile weekly dY10 in holdout.
  const dY = weeklyY10Changes(curve).filter((r) => r.date >= HOLDOUT_START);
  const k = Math.max(1, Math.floor(dY.length * 0.1));
  const shockWeeks = new Set(dY.slice().sort((a, b) => b.dY10 - a.dY10).slice(0, k).map((r) => r.week));
  const sleeveByWk = new Map(sleeveWk.map((p) => [p.week, p]));
  const iefWk = toWeekly(dailyRet(iefBars, HOLDOUT_START));
  const iefByWk = new Map(iefWk.map((p) => [p.week, p.ret]));
  let inCash = 0, shockN = 0, sleeveSum = 0, iefSum = 0;
  for (const wk of shockWeeks) { const s = sleeveByWk.get(wk); if (!s) continue; shockN += 1; if (!s.active) inCash += 1; sleeveSum += s.ret; iefSum += (iefByWk.get(wk) ?? 0); }
  const dodge = { shockN, cashFraction: shockN ? inCash / shockN : null, sleeveMean: shockN ? sleeveSum / shockN : null, iefMean: shockN ? iefSum / shockN : null };
  // independent rate-shock EPISODES (consecutive shock weeks collapse to one) → power flag
  const shockSorted = [...shockWeeks].sort();
  let episodes = 0; let prevIdx = -99; const allWk = sleeveWk.map((p) => p.week);
  for (const wk of shockSorted) { const idx = allWk.indexOf(wk); if (idx - prevIdx > 4) episodes += 1; prevIdx = idx; }
  // Gate 2 — orthogonality on common weeks (sleeve vs QQQ + lanes + Turtle-rates)
  const aligned = alignOnWeek({ Carry: sleeveWk, QQQ: qqqWk, Coil: laneWk.Coil, Turtle: laneWk.Turtle, Drift: laneWk.Drift, DefProxy: laneWk.DefProxy, TurtleRates: turtleRatesWk });
  const S = aligned.vec.Carry, Q = aligned.vec.QQQ;
  const beta = betaTo(S, Q); const betaCI = bootstrapBetaCI(S, Q, { seed: 7 }); const rhoQ = pearson(S, Q);
  const sObj = S.map((r) => ({ ret: r })); const qObj = Q.map((r) => ({ ret: r }));
  const crIdx = crisisWeeks(qObj, 'quintile');
  const crMean = crisisMean(sObj, crIdx); const crCI = crisisMeanCI(sObj, crIdx, { seed: 7 });
  const laneRho = { Coil: pearson(S, aligned.vec.Coil), Turtle: pearson(S, aligned.vec.Turtle), Drift: pearson(S, aligned.vec.Drift), DefProxy: pearson(S, aligned.vec.DefProxy) };
  const rhoTurtleRatesAll = pearson(S, aligned.vec.TurtleRates);
  // co-active ρ: weeks where the carry sleeve OR the turtle-rates sleeve is active
  const carryActive = new Map(sleeveWk.map((p) => [p.week, p.active]));
  const trActive = new Map(turtleRatesWk.map((p) => [p.week, p.active]));
  const coIdx = aligned.weeks.map((wk, i) => ((carryActive.get(wk) || trActive.get(wk)) ? i : -1)).filter((i) => i >= 0);
  const rhoTurtleRatesCo = pearson(coIdx.map((i) => S[i]), coIdx.map((i) => aligned.vec.TurtleRates[i]));
  // Gate 2b — steepening cut: classify each HELD episode bull vs bear by sign of dY10 over the hold
  const y10ByDate = new Map(curve.filter((r) => r.y10 != null).map((r) => [r.date, r.y10]));
  const nearestY10 = (d) => { let best = null; for (const r of curve) { if (r.y10 == null) continue; if (r.date <= d) best = r.y10; else break; } return best; };
  const steepening = sim1.episodes.map((ep) => { const a = nearestY10(ep.start), b = nearestY10(ep.end); return { ...ep, dY10: (a != null && b != null) ? b - a : null, regime: (a != null && b != null) ? (b - a <= 0 ? 'bull_steepening' : 'bear_steepening') : 'unknown' }; });
  // verdict (this signal)
  const edgePass = edge1.lo != null && edge1.lo > 0;
  const stressPass = edge2.lo != null && edge2.lo > 0;
  const betaPass = (betaCI.lo != null && betaCI.lo <= 0 && betaCI.hi >= 0) || Math.abs(beta) < 0.2;
  const rhoQPass = rhoQ != null && Math.abs(rhoQ) < 0.3;
  const crisisPass = crCI.hi != null && crCI.hi >= 0;
  const lanePass = ['Coil', 'Turtle', 'Drift', 'DefProxy'].every((n) => laneRho[n] != null && Math.abs(laneRho[n]) < 0.3);
  const turtleRatesPass = rhoTurtleRatesCo != null && Math.abs(rhoTurtleRatesCo) < 0.3; // co-active is decisive
  const gate2Pass = betaPass && rhoQPass && crisisPass && lanePass && turtleRatesPass;
  const dodgesThrough2022 = dodge.cashFraction != null && dodge.cashFraction >= 0.5; // dated-fact proxy; confirm vs episode narrative
  return { decisions, sim1, edge1, edge2, dodge, episodes, beta, betaCI, rhoQ, crMean, crCI, laneRho, rhoTurtleRatesAll, rhoTurtleRatesCo, steepening,
    edgePass, stressPass, betaPass, rhoQPass, crisisPass, lanePass, turtleRatesPass, gate2Pass, dodgesThrough2022 };
}

{
  const args = process.argv.slice(2);
  const root = (() => { const i = args.indexOf('--root'); return i >= 0 ? args[i + 1] : process.cwd(); })();

  // 1) prereg FIRST (lock before reading any return)
  const prereg = buildPrereg(); const preregHash = hashPrereg(prereg);
  mkdirSync(join(root, 'data', 'lab'), { recursive: true });
  writeFileSync(join(root, 'data', 'lab', 'carry-prereg.json'), JSON.stringify({ ...prereg, sha256: preregHash }, null, 2));

  // 2) load data
  const curve = loadCurve(root);
  const iefBars = loadCarryBars(root, DURATION_ETF);
  const qqqWk = toWeekly(dailyRet(loadCarryBars(root, 'QQQ'), HOLDOUT_START));
  // Turtle-rates-only sleeve: pass ONLY {TLT,IEF,TIP}; simulateTurtle's cluster cap → Turtle's rates behavior
  const ratesMap = new Map(RATES_CLUSTER.map((t) => [t, loadCarryBars(root, t)]));
  const turtleRatesWk = toWeekly(simulateTurtle(ratesMap, { start: HOLDOUT_START, end: STUDY_END }));
  // S1 lanes (reuse fleet cache); align happens on common weeks so 2014+ depth is fine
  const earnings = JSON.parse((await import('node:fs')).readFileSync(join(root, 'data', 'lab', 'fleet-earnings.json'), 'utf8'));
  const laneWk = {
    Coil: toWeekly(buildCoilSeries(root, { earningsByTicker: earnings, start: HOLDOUT_START })),
    Turtle: toWeekly(simulateTurtle(new Map((await import('./fleet-universe.mjs')).TURTLE_ETFS.map((e) => [e.ticker, loadFleetBars(root, e.ticker)])), { start: HOLDOUT_START, end: STUDY_END })),
    Drift: toWeekly(buildDriftSeries(root, { earningsByTicker: earnings, start: HOLDOUT_START, end: STUDY_END })),
    DefProxy: toWeekly(/* call the DefProxy builder confirmed from fleet-defensive-proxy.mjs, start: HOLDOUT_START */),
  };

  // 3) evaluate primary (carry+roll) and twin (term-spread)
  const ctx = { root, curve, iefBars, qqqWk, laneWk, turtleRatesWk };
  const primary = evaluate((row) => carryRollSignal(row), ctx);
  const twin = evaluate((row) => termSpread(row), ctx);

  // 4) twin agreement + power flag → final verdict
  const primaryKeep = primary.gate2Pass && primary.edgePass && primary.stressPass && primary.dodgesThrough2022;
  const twinKeep = twin.gate2Pass && twin.edgePass && twin.stressPass && twin.dodgesThrough2022;
  const lowPower = primary.episodes < 4;             // independent rate-shock episodes (power flag on Gate 1b)
  const twinDisagree = primaryKeep !== twinKeep;
  let verdict, reasons = [];
  if (!primary.gate2Pass) { verdict = 'REJECT'; if (!primary.turtleRatesPass) reasons.push(`different hat: ρ(co-active) to Turtle-rates ${f(primary.rhoTurtleRatesCo)} ≥ 0.3`); if (!primary.betaPass) reasons.push(`equity-β ${f(primary.beta)}`); if (!primary.rhoQPass) reasons.push(`ρ to QQQ ${f(primary.rhoQ)} ≥ 0.3`); if (!primary.crisisPass) reasons.push('co-crashes in QQQ worst weeks'); if (!primary.lanePass) reasons.push('redundant to a lane'); }
  else if (!(primary.edgePass && primary.stressPass)) { verdict = 'REJECT'; reasons.push('edge gate FAIL (holdout net CI ≤ 0 at 1x or 2x)'); }
  else if (lowPower || !primary.dodgesThrough2022) { verdict = 'INCONCLUSIVE'; reasons.push(lowPower ? `Gate 1b underpowered (${primary.episodes} independent rate-shock episodes)` : 'dodge narrative does not show cash through 2022'); }
  else if (twinDisagree) { verdict = 'INCONCLUSIVE'; reasons.push('robustness twin (term-spread) disagrees at the verdict level'); }
  else { verdict = 'KEEP (provisional — edge claim is a ~4-episode case study)'; }

  // 5) RESULTS (mirror cef-score's table style; include: edge 1x/2x, dodge table, β/ρ/crisis/lane/
  //    Turtle-rates all+co-active, steepening-cut table, twin-agreement line, episode/power flag,
  //    and the dated 2022/2018Q4/2025 episode narrative built from primary.sim1.episodes + dodge).
  //    Lead with: prereg hash, VERDICT, the ballast-graded/descriptive caveats from spec §5/§6.
  // ...assemble L = [] lines and writeFileSync(join(root,'docs','lab','bond-carry-RESULTS.md'), ...,{encoding:'utf-8'})
  process.stdout.write(`prereg ${preregHash}\nVERDICT: ${verdict}${reasons.length ? ' — ' + reasons.join('; ') : ''}\n`);
}
```

Implementation notes for the engineer:
- **Verdict precedence — confirm against real numbers (controller review).** Encode the precedence as written, but two nuances: (1) the dodge criterion is specifically about **2022** — also compute `cashFraction2022` (cash fraction over rate-shock weeks dated `2022-*`) and use *that* as the `dodgesThrough2022` dated fact, with the all-shock-weeks fraction reported as context; (2) `episodes < 4 → INCONCLUSIVE` must NOT override a Gate-2 REJECT (REJECT wins) and must NOT flip a clear 2022 dodge into INCONCLUSIVE on its own — a small episode count makes any KEEP **provisional** (already the KEEP label), and only forces INCONCLUSIVE when the 2022 episode itself is absent/unreadable. If the real data makes this precedence awkward, surface it for the controller rather than silently picking a branch.
- **Read `scripts/fleet-defensive-proxy.mjs` first** and wire its real builder into `laneWk.DefProxy` (the placeholder comment). If its signature can't be made to fit cleanly, compute the other three lanes and mark DefProxy `n/a` in RESULTS with a note (do NOT silently drop it from the gate without saying so).
- `simulateTurtle` reads bars via a `Map<ticker,bars>`; passing only `{TLT,IEF,TIP}` restricts it to the rates cluster (its internal `heldClusters` cap already limits it to one rates position — faithful Turtle-rates behavior).
- The `await import(...)` lines are to keep the top imports tidy; you may hoist them to static imports if preferred.
- The RESULTS file MUST state: return basis (price-change of IEF + accrued cash, friction-net), the **descriptive** nature of Gate 1b, the **provisional** nature of any KEEP, and the steepening-regime breakdown. Reuse the caveat tone from `cef-discount-reversion-RESULTS.md`.

- [ ] **Step 2: Run end-to-end + review**

```bash
node scripts/carry-score.mjs --root .
```

Expected: prints `prereg <hash>` + `VERDICT: ...`, and writes `docs/lab/bond-carry-RESULTS.md`. **Open RESULTS and sanity-check:** does the sign-zero signal go to cash during 2022 (the dodge narrative)? Are the β/ρ to QQQ low (bonds should be)? Is the Turtle-rates co-active ρ the deciding number? Do the numbers tell an internally-consistent story? If the verdict hinges on a number that looks wrong, debug the pipeline (not the verdict) before trusting it.

- [ ] **Step 3: Commit**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown" && \
git add scripts/carry-score.mjs docs/lab/bond-carry-RESULTS.md && \
git commit -m "feat(carry): orchestrator + RESULTS (dual gate + twin + steepening cut)"
```

---

## Task 9: Whole-study review, RUNBOOK finalize, squash-merge

**Files:**
- Modify: `docs/lab/bond-carry-RUNBOOK.md` (finalize), confirm `.gitignore`

- [ ] **Step 1: Confirm `data/lab` is gitignored and no cache leaked**

```bash
git status --porcelain
git check-ignore data/lab/carry-cache/IEF.json
```

Expected: no `data/lab/...` files staged/untracked-and-committed; `git check-ignore` echoes the path (i.e. it IS ignored). If `data/lab` is not ignored, add it to `.gitignore` in this commit.

- [ ] **Step 2: Run the full test suite + a clean reproduce**

```bash
node --test scripts/carry-*.test.mjs
```

Expected: all carry unit tests PASS. Spot-check that RESULTS regenerates deterministically (same prereg hash, same verdict) on a re-run of `carry-score.mjs`.

- [ ] **Step 3: Whole-study review (against the spec)**

Re-read spec §5/§6 and confirm every gate is implemented and reported: 1a (edge CI), 1b (rate-shock dodge, descriptive + power flag), 1c (2× stress), 2.1 (QQQ β/ρ), 2.2 (crisis mean), 2.3 (lane-ρ ×4), 2.4 (Turtle-rates all + co-active), 2b (steepening cut), twin downgrade, provisional-KEEP language. Fix any gap. Verify the verdict logic matches the spec's REJECT/INCONCLUSIVE/KEEP precedence.

- [ ] **Step 4: Finalize RUNBOOK** (fill the Task-0 findings + the final one-line verdict) and commit any review fixes.

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "bond-carry-rolldown" && \
git add -A && git commit -m "docs(carry): finalize RUNBOOK + whole-study review fixes"
```

- [ ] **Step 5: Squash-merge to local main** (per workflow — one commit for the subproject; confirm with the user first)

Use the `superpowers:finishing-a-development-branch` flow: squash the branch into local `main` as a single commit, lab-only, no deploy. Do this only when the user approves the verdict and the merge.

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 strategy → Tasks 1,4,5. §2 sample/holdout → universe dates + Task 8 holdout filter. §3 Task-0 probe → Task 7. §4 engine reuse → Task 8 imports. §5 Gate 1a/b/c → Task 8 `evaluate`. §5 Gate 2.1–2.4 + co-active → Task 8. §5 Gate 2b steepening → Task 8 `steepening`. §5 verdict (REJECT/INCONCLUSIVE/KEEP + twin downgrade + power flag) → Task 8 section 4. §1 twin → Task 8 `evaluate(termSpread)`. §6 priors/provisional-KEEP → prereg + RESULTS language. §8 workflow → Task 9. §9 sign-zero primary + threshold diagnostic + ModDur twin → Tasks 4,6,8.

**Placeholder scan:** The only intentional deferral is the DefProxy builder wiring (Task 8 Step 1 note) — gated behind "read fleet-defensive-proxy.mjs first" with an explicit fallback, not a silent TODO. Everything else is concrete code.

**Type consistency:** signal fns take a curve `row` and return a number|null (used by `monthlyDecisions`, `evaluate`); `monthEndCurve`→rows; `buildMonthPlan(monthEndRows, decisions)`→`Map`; `simulateCarry`→`{daily:[{date,ret,active}], episodes:[{start,end}]}`; `toWeekly`→`[{week,date,ret,active}]`; bootstrap rows are `{date,net}`; `crisisWeeks/crisisMean/crisisMeanCI` take `[{ret}]` + index set — all consistent across tasks.
