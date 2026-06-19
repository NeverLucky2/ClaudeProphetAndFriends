# Reduced-EOV Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lab-only, pre-registered backtest that tests whether reduced-EOV (call-volume intensity) forward-predicts the underlying stock returns of 20 heavily-optioned mega-caps, with a train→holdout replication and a beta-neutral dual gate.

**Architecture:** Two layers. (1) A **pure analytical core** (universe → signal → portfolio → panel build → prereg → score) that is fully TDD'd on synthetic fixtures and never touches the network — this is where correctness lives. (2) Thin **I/O fetchers** (Alpaca options contracts, option daily bars, adjusted stock bars, corporate actions) that fill `data/lab/` caches the core consumes. The pure core is proven before the expensive data pull.

**Tech Stack:** Node ESM `.mjs`, `node --test`. Reuses existing repo helpers: `coil-threshold-metrics.mjs` (`mean`, `bootstrapMeanCI` date-block seeded), `ema-beta.mjs` (`olsBeta`, `dailyReturns`), `coil-eventstudy-prereg.mjs` (`sha256short`). Mirrors the ORB study's prereg/score hash-lock pattern.

## Global Constraints

- **Lab-only, read-only. No deployment.** No agent, config, or strategy file is touched.
- **Spec:** `docs/superpowers/specs/2026-06-19-reduced-eov-backtest-design.md` — authoritative; this plan implements it.
- **Universe (fixed, 20):** `AAPL MSFT NVDA AMZN GOOGL META TSLA AMD NFLX ADBE BABA SHOP PYPL ROKU MRNA BA WMT JPM ZM EBAY`. Benchmarks: `QQQ` (primary), `SPY` (robustness).
- **Signal:** `reducedEOV(n,T) = CallVol(n,T) / mean(CallVol(n, T-21..T-1))`; trailing **21 trading-day** window excluding T; cross-sectional **percentile rank**; skip a date with **< 12** valid names. Half-signal only (no OI) — verdict language must say "proxy".
- **Timing:** signal from day T (known after close) → enter **T+1 open**, exit **T+1+h open**, `h ∈ {1,3,5}`. Open-to-open. Adjusted prices (`adjustment=all`).
- **Confirmatory cell:** long-short top-5 − bottom-5, `h=3`, beta-neutralized. Direction `d*` fixed on train. All other cells exploratory, cannot promote a REJECT.
- **Bootstrap:** moving date-block, `block_sessions=15`, `iterations=10000`, `seed=1234`, 95% CI. Betas: OLS on **train only**, frozen, applied to holdout.
- **Power floor:** UNDERPOWERED if holdout < **100** distinct formation dates, or held leg < **200** pooled name-trades.
- **Friction:** equity bps from prereg, applied per leg per rebalance, **no netting** of overlaps (deliberately conservative). Spread net = gross − 4·bps/1e4 (two baskets × round-trip); leg net = gross − 2·bps/1e4.
- **Committed artifacts only:** `docs/lab/eov-RESULTS.md` (carries prereg hash) + `docs/lab/eov-RUNBOOK.md`. Everything under `data/lab/eov-*` is git-ignored.
- **Expected outcome:** REJECT (honest prior). Do not tune toward KEEP.

---

## File Structure

New, all under `scripts/` unless noted:

- `eov-universe.mjs` — universe + benchmark constants and ticker helpers. *(pure)*
- `eov-signal.mjs` — trailing mean, reducedEOV, split-exclusion, cross-sectional rank. *(pure)*
- `eov-portfolio.mjs` — open-to-open forward return, daily spread (top-k − bottom-k), leg rows. *(pure)*
- `eov-aggregate.mjs` — per-name daily CallVol aggregation + contract-count integrity. *(pure)*
- `eov-build.mjs` — `buildPanel()` (pure) + CLI that loads caches → `data/lab/eov-instances.json`.
- `eov-prereg.mjs` — `buildEovPrereg()` / `verifyEovPrereg()` (hash-lock). *(pure + CLI)*
- `eov-score.mjs` — friction, beta-neutralize, per-name alpha, `decideEov()` (pure) + CLI → `docs/lab/eov-RESULTS.md`.
- `eov-fetch-contracts.mjs`, `eov-fetch-bars.mjs`, `eov-fetch-stockbars.mjs`, `eov-fetch-corpactions.mjs` — thin I/O.
- Tests: `scripts/eov-*.test.mjs` per pure module.
- Docs: `docs/lab/eov-RUNBOOK.md` (committed), `docs/lab/eov-RESULTS.md` (generated).

---

## Task 1: Universe module + gitignore

**Files:**
- Create: `scripts/eov-universe.mjs`
- Test: `scripts/eov-universe.test.mjs`
- Modify: `.gitignore` (ensure `data/lab/eov-*` ignored)

**Interfaces:**
- Produces: `EOV_UNIVERSE: string[]` (20), `BENCHMARK='QQQ'`, `BENCHMARK2='SPY'`, `eovUniverse(): string[]`, `allEovStockTickers(): string[]` (22 = 20 + QQQ + SPY).

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/eov-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EOV_UNIVERSE, BENCHMARK, BENCHMARK2, eovUniverse, allEovStockTickers } from './eov-universe.mjs';

test('universe is the fixed paper-derived 20, no dupes, no GOOG/SQ', () => {
  assert.equal(EOV_UNIVERSE.length, 20);
  assert.equal(new Set(EOV_UNIVERSE).size, 20);
  assert.ok(EOV_UNIVERSE.includes('GOOGL') && !EOV_UNIVERSE.includes('GOOG'));
  assert.ok(!EOV_UNIVERSE.includes('SQ'));
});

test('allEovStockTickers adds QQQ + SPY benchmarks', () => {
  assert.equal(BENCHMARK, 'QQQ');
  assert.equal(BENCHMARK2, 'SPY');
  const all = allEovStockTickers();
  assert.equal(all.length, 22);
  assert.ok(all.includes('QQQ') && all.includes('SPY'));
  assert.deepEqual(eovUniverse(), EOV_UNIVERSE);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test scripts/eov-universe.test.mjs`
Expected: FAIL (cannot find module / exports undefined).

- [ ] **Step 3: Implement**

```javascript
// scripts/eov-universe.mjs
export const EOV_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'NFLX', 'ADBE',
  'BABA', 'SHOP', 'PYPL', 'ROKU', 'MRNA', 'BA', 'WMT', 'JPM', 'ZM', 'EBAY',
];
export const BENCHMARK = 'QQQ';
export const BENCHMARK2 = 'SPY';
export const eovUniverse = () => [...EOV_UNIVERSE];
export const allEovStockTickers = () => [...EOV_UNIVERSE, BENCHMARK, BENCHMARK2];
```

- [ ] **Step 4: Run test, verify pass**

Run: `node --test scripts/eov-universe.test.mjs`
Expected: PASS.

- [ ] **Step 5: Ensure gitignore covers lab data**

Run: `grep -n "data/lab" .gitignore` — if `data/lab/` (or `data/lab/*`) is already present, do nothing. Otherwise append:

```
data/lab/eov-*
```

- [ ] **Step 6: Commit**

```bash
git add scripts/eov-universe.mjs scripts/eov-universe.test.mjs .gitignore
git commit -m "feat(eov): universe module + lab-data gitignore"
```

---

## Task 2: Signal math (trailing mean, reducedEOV, split exclusion, rank)

**Files:**
- Create: `scripts/eov-signal.mjs`
- Test: `scripts/eov-signal.test.mjs`

**Interfaces:**
- Consumes: nothing external.
- Produces:
  - `trailingMean(values: number[], idx: number, window=21): number|null` — mean of `values[idx-window..idx-1]`; null if `idx < window`.
  - `reducedEOV(values: number[], idx: number, window=21): number|null` — `values[idx]/trailingMean`; null if mean null or 0.
  - `splitExcludedDates(tradingDates: string[], splitDate: string, window=21): Set<string>` — split date through split+window trading days inclusive.
  - `crossSectionalRank(valueByTicker: Record<string,number>, minNames=12): Record<string,number>|null` — percentile rank in [0,1] over finite values; null if `< minNames` valid.

- [ ] **Step 1: Write the failing tests**

```javascript
// scripts/eov-signal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailingMean, reducedEOV, splitExcludedDates, crossSectionalRank } from './eov-signal.mjs';

test('trailingMean needs full window, excludes current', () => {
  const v = Array.from({ length: 25 }, (_, i) => i + 1); // 1..25
  assert.equal(trailingMean(v, 20, 21), null);              // only 20 priors
  assert.equal(trailingMean(v, 21, 21), 11);                // mean(1..21)=11
});

test('reducedEOV is current / trailing mean, null-safe', () => {
  const v = [...Array(21).fill(10), 30]; // idx21 current=30, trailing mean=10
  assert.equal(reducedEOV(v, 21, 21), 3);
  const z = [...Array(21).fill(0), 5];
  assert.equal(reducedEOV(z, 21, 21), null);  // zero trailing mean
});

test('splitExcludedDates covers split day through split+window trading days', () => {
  const dates = Array.from({ length: 30 }, (_, i) => `D${String(i).padStart(2, '0')}`);
  const ex = splitExcludedDates(dates, 'D05', 21);
  assert.ok(ex.has('D05'));        // split day
  assert.ok(ex.has('D26'));        // +21 trading days
  assert.ok(!ex.has('D27'));       // window closed
  assert.ok(!ex.has('D04'));       // before split
});

test('crossSectionalRank: percentile in [0,1], null below minNames', () => {
  const r = crossSectionalRank({ A: 1, B: 2, C: 3, D: 4 }, 4);
  assert.equal(r.A, 0); assert.equal(r.D, 1);
  assert.ok(r.B > 0 && r.B < r.C);
  assert.equal(crossSectionalRank({ A: 1, B: 2 }, 12), null);     // too few
  assert.equal(crossSectionalRank({ A: 1, B: NaN, C: 3 }, 3), null); // NaN dropped -> 2 valid < 3
});
```

- [ ] **Step 2: Run, verify fail**

Run: `node --test scripts/eov-signal.test.mjs` → FAIL.

- [ ] **Step 3: Implement**

```javascript
// scripts/eov-signal.mjs
export function trailingMean(values, idx, window = 21) {
  if (idx < window) return null;
  let s = 0;
  for (let i = idx - window; i < idx; i += 1) s += values[i];
  return s / window;
}

export function reducedEOV(values, idx, window = 21) {
  const tm = trailingMean(values, idx, window);
  if (tm == null || tm === 0) return null;
  return values[idx] / tm;
}

export function splitExcludedDates(tradingDates, splitDate, window = 21) {
  const i = tradingDates.indexOf(splitDate);
  const out = new Set();
  if (i < 0) return out;
  for (let j = i; j <= i + window && j < tradingDates.length; j += 1) out.add(tradingDates[j]);
  return out;
}

export function crossSectionalRank(valueByTicker, minNames = 12) {
  const entries = Object.entries(valueByTicker).filter(([, v]) => Number.isFinite(v));
  if (entries.length < minNames) return null;
  entries.sort((a, b) => a[1] - b[1]);
  const n = entries.length;
  const out = {};
  // percentile rank: 0 for the min, 1 for the max
  entries.forEach(([tk], i) => { out[tk] = n === 1 ? 0.5 : i / (n - 1); });
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test scripts/eov-signal.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/eov-signal.mjs scripts/eov-signal.test.mjs
git commit -m "feat(eov): signal math (trailing mean, reducedEOV, split exclusion, x-sec rank)"
```

---

## Task 3: Portfolio construction (forward return, daily spread, leg rows)

**Files:**
- Create: `scripts/eov-portfolio.mjs`
- Test: `scripts/eov-portfolio.test.mjs`

**Interfaces:**
- Consumes: nothing external (operates on plain maps/arrays).
- Produces:
  - `forwardReturnOpenToOpen(openByDate: Map<string,number>, dates: string[], t: number, h: number): number|null` — `open(dates[t+1+h]) / open(dates[t+1]) - 1`; null if any index/price missing.
  - `dailySpread(rankByTicker: Record<string,number>, retByTicker: Record<string,number>, k=5): {spread:number, top:string[], bottom:string[]}|null` — equal-weight mean(top-k rets) − mean(bottom-k rets); null if fewer than `2*k` tickers have both a rank and a finite return.

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/eov-portfolio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardReturnOpenToOpen, dailySpread } from './eov-portfolio.mjs';

test('forwardReturnOpenToOpen is open(T+1+h)/open(T+1)-1', () => {
  const dates = ['D0', 'D1', 'D2', 'D3', 'D4'];
  const open = new Map([['D0', 10], ['D1', 11], ['D2', 12], ['D3', 13], ['D4', 14]]);
  // t=0 -> entry D1(11), exit D1+3=D4(14) -> 14/11-1
  assert.ok(Math.abs(forwardReturnOpenToOpen(open, dates, 0, 3) - (14 / 11 - 1)) < 1e-12);
  assert.equal(forwardReturnOpenToOpen(open, dates, 3, 3), null); // exit out of range
});

test('dailySpread = mean(top-k) - mean(bottom-k), null if too few names', () => {
  const rank = { A: 1.0, B: 0.8, C: 0.6, D: 0.4, E: 0.2, F: 0.0 };
  const ret = { A: 0.05, B: 0.04, C: 0.03, D: 0.02, E: 0.01, F: 0.00 };
  const r = dailySpread(rank, ret, 2);
  // top2 = A,B (0.045 mean); bottom2 = F,E (0.005 mean) -> 0.04
  assert.ok(Math.abs(r.spread - 0.04) < 1e-12);
  assert.deepEqual(r.top.sort(), ['A', 'B']);
  assert.deepEqual(r.bottom.sort(), ['E', 'F']);
  assert.equal(dailySpread({ A: 1, B: 0 }, { A: 0.1, B: 0 }, 2), null); // need 2*k=4
});
```

- [ ] **Step 2: Run, verify fail** — `node --test scripts/eov-portfolio.test.mjs` → FAIL.

- [ ] **Step 3: Implement**

```javascript
// scripts/eov-portfolio.mjs
import { mean } from './coil-threshold-metrics.mjs';

export function forwardReturnOpenToOpen(openByDate, dates, t, h) {
  const ei = t + 1, xi = t + 1 + h;
  if (ei >= dates.length || xi >= dates.length) return null;
  const e = openByDate.get(dates[ei]), x = openByDate.get(dates[xi]);
  if (!Number.isFinite(e) || !Number.isFinite(x) || e === 0) return null;
  return x / e - 1;
}

export function dailySpread(rankByTicker, retByTicker, k = 5) {
  const usable = Object.keys(rankByTicker)
    .filter(tk => Number.isFinite(rankByTicker[tk]) && Number.isFinite(retByTicker[tk]));
  if (usable.length < 2 * k) return null;
  usable.sort((a, b) => rankByTicker[b] - rankByTicker[a]); // high rank first
  const top = usable.slice(0, k);
  const bottom = usable.slice(-k);
  return { spread: mean(top.map(t => retByTicker[t])) - mean(bottom.map(t => retByTicker[t])), top, bottom };
}
```

- [ ] **Step 4: Run, verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/eov-portfolio.mjs scripts/eov-portfolio.test.mjs
git commit -m "feat(eov): portfolio construction (open-to-open return, daily top-k/bottom-k spread)"
```

---

## Task 4: CallVol aggregation + contract-count integrity

**Files:**
- Create: `scripts/eov-aggregate.mjs`
- Test: `scripts/eov-aggregate.test.mjs`

**Interfaces:**
- Consumes: nothing external.
- Produces:
  - `aggregateCallVol(barsByContract: Record<string, Array<{date:string, v:number}>>): Record<string, number>` — date → summed call volume across contracts (only bars with finite `v`).
  - `contractCountByMonth(barsByContract): Record<string, number>` — `YYYY-MM` → count of distinct contracts that traded that month (integrity check for §7.3 enumeration ramp).

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/eov-aggregate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCallVol, contractCountByMonth } from './eov-aggregate.mjs';

const bars = {
  'C1': [{ date: '2024-02-01', v: 100 }, { date: '2024-02-02', v: 50 }],
  'C2': [{ date: '2024-02-01', v: 10 }, { date: '2024-03-01', v: 7 }],
  'C3': [{ date: '2024-02-01', v: NaN }],
};

test('aggregateCallVol sums finite volume per date across contracts', () => {
  const a = aggregateCallVol(bars);
  assert.equal(a['2024-02-01'], 110); // 100 + 10, NaN dropped
  assert.equal(a['2024-02-02'], 50);
  assert.equal(a['2024-03-01'], 7);
});

test('contractCountByMonth counts distinct contracts trading per month', () => {
  const c = contractCountByMonth(bars);
  assert.equal(c['2024-02'], 2); // C1, C2 (C3 has no finite bar)
  assert.equal(c['2024-03'], 1); // C2
});
```

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement**

```javascript
// scripts/eov-aggregate.mjs
export function aggregateCallVol(barsByContract) {
  const out = {};
  for (const bars of Object.values(barsByContract)) {
    for (const b of bars) {
      if (!Number.isFinite(b.v)) continue;
      out[b.date] = (out[b.date] ?? 0) + b.v;
    }
  }
  return out;
}

export function contractCountByMonth(barsByContract) {
  const byMonth = {};
  for (const [sym, bars] of Object.entries(barsByContract)) {
    const months = new Set();
    for (const b of bars) if (Number.isFinite(b.v)) months.add(b.date.slice(0, 7));
    for (const m of months) { byMonth[m] = byMonth[m] ?? new Set(); byMonth[m].add(sym); }
  }
  const out = {};
  for (const [m, set] of Object.entries(byMonth)) out[m] = set.size;
  return out;
}
```

- [ ] **Step 4: Run, verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/eov-aggregate.mjs scripts/eov-aggregate.test.mjs
git commit -m "feat(eov): per-name CallVol aggregation + contract-count integrity"
```

---

## Task 5: Panel build (`buildPanel` pure + CLI)

**Files:**
- Create: `scripts/eov-build.mjs`
- Test: `scripts/eov-build.test.mjs`

**Interfaces:**
- Consumes: `reducedEOV`, `splitExcludedDates`, `crossSectionalRank` (Task 2); `forwardReturnOpenToOpen`, `dailySpread` (Task 3); `dailyReturns` (`ema-beta.mjs`).
- Produces: `buildPanel(inputs) -> bundle`.
  - `inputs = { callVolByName: Record<ticker, Record<date, number>>, stockBarsByName: Record<ticker, Array<{date,open,close}>>, splitsByName: Record<ticker, string[]>, universe: string[], window=21, horizons=[1,3,5], kLeg=5, minNames=12, splitFrac=0.7 }`. `stockBarsByName` must also contain `QQQ` and `SPY`.
  - `bundle = { meta:{ validDates:string[], splitBoundary:string, trainN:number, holdoutN:number, horizons:number[], kLeg, window }, spread: Record<h, Array<{date, grossSpread, qqqRet, spyRet, split}>>, legs: Record<h, Array<{date, ticker, leg:'top'|'bottom', grossRet, qqqRet, spyRet, split}>>, nameDailyRet: Record<ticker, Array<{date, ret}>> }`.
  - `split` is `'train'` for the earliest `splitFrac` of `validDates`, else `'holdout'`. `validDates` = formation dates where the cross-sectional rank exists (≥minNames) AND the h=3 spread is formable.

- [ ] **Step 1: Write the failing test** (synthetic 60-day panel, 12 names, one split)

```javascript
// scripts/eov-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanel } from './eov-build.mjs';

function synth() {
  const N = 60;
  const dates = Array.from({ length: N }, (_, i) => `2024-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`);
  const names = Array.from({ length: 12 }, (_, i) => `T${i}`);
  const callVolByName = {}, stockBarsByName = {}, splitsByName = {};
  names.forEach((nm, k) => {
    const cv = {}; const bars = [];
    for (let i = 0; i < N; i += 1) {
      cv[dates[i]] = 100 + ((i * (k + 1)) % 50);            // varies by name/day
      const px = 100 + i * 0.1 + k;                          // gentle uptrend
      bars.push({ date: dates[i], open: px, close: px + 0.05 });
    }
    callVolByName[nm] = cv; stockBarsByName[nm] = bars; splitsByName[nm] = [];
  });
  // benchmarks
  for (const b of ['QQQ', 'SPY']) {
    stockBarsByName[b] = dates.map((d, i) => ({ date: d, open: 200 + i * 0.1, close: 200 + i * 0.1 }));
  }
  return { callVolByName, stockBarsByName, splitsByName, universe: names, dates };
}

test('buildPanel yields warm-up-respecting panel with train/holdout split', () => {
  const s = synth();
  const b = buildPanel({ ...s, window: 21, horizons: [1, 3, 5], kLeg: 5, minNames: 12, splitFrac: 0.7 });
  // first 21 days are warm-up -> earliest valid formation date is at/after index 21
  assert.ok(b.meta.validDates[0] >= s.dates[21]);
  assert.ok(b.meta.trainN > 0 && b.meta.holdoutN > 0);
  assert.equal(b.meta.trainN + b.meta.holdoutN, b.meta.validDates.length);
  // every spread row has matched qqq window return + a split label
  for (const row of b.spread['3']) {
    assert.ok(Number.isFinite(row.grossSpread));
    assert.ok(Number.isFinite(row.qqqRet));
    assert.ok(row.split === 'train' || row.split === 'holdout');
  }
  // legs at h=3 carry 5 top + 5 bottom per formation date
  const oneDate = b.spread['3'][0].date;
  const legsThatDay = b.legs['3'].filter(r => r.date === oneDate);
  assert.equal(legsThatDay.filter(r => r.leg === 'top').length, 5);
  assert.equal(legsThatDay.filter(r => r.leg === 'bottom').length, 5);
});

test('buildPanel excludes a split window from the affected name only', () => {
  const s = synth();
  s.splitsByName['T0'] = [s.dates[25]]; // split mid-window
  const b = buildPanel({ ...s, window: 21, horizons: [3], kLeg: 5, minNames: 12, splitFrac: 0.7 });
  // T0 must not appear in any leg row whose date is in [dates[25], dates[25]+21]
  const excluded = new Set(s.dates.slice(25, 25 + 22));
  assert.ok(!b.legs['3'].some(r => r.ticker === 'T0' && excluded.has(r.date)));
});
```

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement `buildPanel` + CLI**

```javascript
// scripts/eov-build.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reducedEOV, splitExcludedDates, crossSectionalRank } from './eov-signal.mjs';
import { forwardReturnOpenToOpen, dailySpread } from './eov-portfolio.mjs';
import { dailyReturns } from './ema-beta.mjs';

export function buildPanel({ callVolByName, stockBarsByName, splitsByName, universe,
  window = 21, horizons = [1, 3, 5], kLeg = 5, minNames = 12, splitFrac = 0.7 }) {
  // common trading-date axis = union of stock bar dates across the universe, sorted
  const dateSet = new Set();
  for (const nm of universe) for (const b of (stockBarsByName[nm] || [])) dateSet.add(b.date);
  const dates = [...dateSet].sort();

  // per-name aligned callVol arrays + open maps + exclusion sets
  const cvArr = {}, openByName = {}, exclByName = {};
  for (const nm of universe) {
    cvArr[nm] = dates.map(d => (callVolByName[nm]?.[d] ?? null));
    openByName[nm] = new Map((stockBarsByName[nm] || []).map(b => [b.date, b.open]));
    let ex = new Set();
    for (const sd of (splitsByName[nm] || [])) ex = new Set([...ex, ...splitExcludedDates(dates, sd, window)]);
    exclByName[nm] = ex;
  }
  const qOpen = new Map((stockBarsByName.QQQ || []).map(b => [b.date, b.open]));
  const sOpen = new Map((stockBarsByName.SPY || []).map(b => [b.date, b.open]));
  const benchRet = (openMap, t, h) => forwardReturnOpenToOpen(openMap, dates, t, h);

  // reducedEOV with null when in a split window or warm-up incomplete
  const eovArr = {};
  for (const nm of universe) {
    eovArr[nm] = dates.map((d, i) => (exclByName[nm].has(d) ? null : (() => {
      const vals = cvArr[nm];
      if (vals[i] == null) return null;
      // trailing window must be fully populated (no nulls) to be valid
      if (i < window) return null;
      for (let j = i - window; j < i; j += 1) if (vals[j] == null) return null;
      return reducedEOV(vals, i, window);
    })()));
  }

  const spread = Object.fromEntries(horizons.map(h => [h, []]));
  const legs = Object.fromEntries(horizons.map(h => [h, []]));
  const validDatesSet = new Set();

  for (let t = 0; t < dates.length; t += 1) {
    const valueByTicker = {};
    for (const nm of universe) { const e = eovArr[nm][t]; if (e != null) valueByTicker[nm] = e; }
    const rank = crossSectionalRank(valueByTicker, minNames);
    if (!rank) continue;
    for (const h of horizons) {
      const retByTicker = {};
      for (const nm of Object.keys(rank)) { const r = forwardReturnOpenToOpen(openByName[nm], dates, t, h); if (r != null) retByTicker[nm] = r; }
      const ds = dailySpread(rank, retByTicker, kLeg);
      if (!ds) continue;
      const qqqRet = benchRet(qOpen, t, h), spyRet = benchRet(sOpen, t, h);
      const date = dates[t];
      spread[h].push({ date, grossSpread: ds.spread, qqqRet, spyRet, split: 'train' });
      for (const tk of ds.top) legs[h].push({ date, ticker: tk, leg: 'top', grossRet: retByTicker[tk], qqqRet, spyRet, split: 'train' });
      for (const tk of ds.bottom) legs[h].push({ date, ticker: tk, leg: 'bottom', grossRet: retByTicker[tk], qqqRet, spyRet, split: 'train' });
      if (h === 3) validDatesSet.add(date); // confirmatory horizon defines valid formation dates
    }
  }

  const validDates = [...validDatesSet].sort();
  const cut = Math.floor(validDates.length * splitFrac);
  const splitBoundary = validDates[cut - 1] ?? null;
  const holdoutDates = new Set(validDates.slice(cut));
  const label = (d) => (holdoutDates.has(d) ? 'holdout' : 'train');
  for (const h of horizons) {
    for (const row of spread[h]) row.split = label(row.date);
    for (const row of legs[h]) row.split = label(row.date);
  }

  const nameDailyRet = {};
  for (const nm of universe) nameDailyRet[nm] = dailyReturns(stockBarsByName[nm] || []);
  nameDailyRet.QQQ = dailyReturns(stockBarsByName.QQQ || []);

  return {
    meta: { validDates, splitBoundary, trainN: validDates.length - holdoutDates.size, holdoutN: holdoutDates.size, horizons, kLeg, window },
    spread, legs, nameDailyRet,
  };
}

// CLI: load caches under data/lab/, write data/lab/eov-instances.json + integrity table
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { EOV_UNIVERSE } = await import('./eov-universe.mjs');
    const { contractCountByMonth } = await import('./eov-aggregate.mjs');
    const root = process.cwd();
    const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
    const callVolByName = {}, stockBarsByName = {}, splitsByName = {};
    for (const nm of [...EOV_UNIVERSE, 'QQQ', 'SPY']) {
      const sb = readJson(join(root, 'data/lab/eov-stockbars', `${nm}.json`));
      stockBarsByName[nm] = sb.bars.map(b => ({ date: b.Timestamp.slice(0, 10), open: b.Open, close: b.Close }));
    }
    for (const nm of EOV_UNIVERSE) {
      callVolByName[nm] = readJson(join(root, 'data/lab/eov-volume-cache', `${nm}.json`)).callVol;
    }
    const splits = readJson(join(root, 'data/lab/eov-splits.json'));
    for (const nm of EOV_UNIVERSE) splitsByName[nm] = splits[nm] || [];
    const bundle = buildPanel({ callVolByName, stockBarsByName, splitsByName, universe: EOV_UNIVERSE });
    mkdirSync(join(root, 'data/lab'), { recursive: true });
    writeFileSync(join(root, 'data/lab/eov-instances.json'), JSON.stringify(bundle));
    process.stdout.write(`panel: ${bundle.meta.validDates.length} valid dates (train ${bundle.meta.trainN} / holdout ${bundle.meta.holdoutN}), boundary ${bundle.meta.splitBoundary}\n`);
  }
}
```

- [ ] **Step 4: Run, verify pass** → `node --test scripts/eov-build.test.mjs` PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/eov-build.mjs scripts/eov-build.test.mjs
git commit -m "feat(eov): buildPanel (EOV panel, spread/leg rows, train/holdout split) + CLI"
```

---

## Task 6: Pre-registration (hash-lock)

**Files:**
- Create: `scripts/eov-prereg.mjs`
- Test: `scripts/eov-prereg.test.mjs`

**Interfaces:**
- Consumes: `sha256short` from `coil-eventstudy-prereg.mjs`.
- Produces: `buildEovPrereg({ trainN, holdoutN, validDatesN, splitBoundary, createdUtc }) -> artifact` (with `.artifact_hash`); `verifyEovPrereg(artifact) -> { ok, expected, found }`.

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/eov-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEovPrereg, verifyEovPrereg } from './eov-prereg.mjs';

test('prereg is self-consistent and tamper-evident', () => {
  const a = buildEovPrereg({ trainN: 300, holdoutN: 130, validDatesN: 430, splitBoundary: '2025-09-01', createdUtc: '2026-06-19T00:00:00Z' });
  assert.equal(verifyEovPrereg(a).ok, true);
  assert.equal(a.confirmatory_cell.h, 3);
  assert.equal(a.bootstrap.seed, 1234);
  assert.equal(a.expected_outcome, 'REJECT');
  a.power_floor.distinct_dates = 1; // tamper
  assert.equal(verifyEovPrereg(a).ok, false);
});

test('hash is stable across key ordering', () => {
  const a = buildEovPrereg({ trainN: 1, holdoutN: 1, validDatesN: 2, splitBoundary: 'x', createdUtc: 't' });
  const b = buildEovPrereg({ trainN: 1, holdoutN: 1, validDatesN: 2, splitBoundary: 'x', createdUtc: 't' });
  assert.equal(a.artifact_hash, b.artifact_hash);
});
```

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement** (mirror `orb-prereg.mjs`)

```javascript
// scripts/eov-prereg.mjs
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256short } from './coil-eventstudy-prereg.mjs';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => k !== 'artifact_hash').map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function buildEovPrereg({ trainN, holdoutN, validDatesN, splitBoundary, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'reduced-EOV (call-volume intensity, half-signal: no OI) has uncertain tradable forward edge on 20 heavily-optioned mega-caps, in either direction',
    signal: { definition: 'CallVol(T)/mean(CallVol(T-21..T-1))', window: 21, half: 'callvol_over_trailing_only', oi_half: 'unavailable' },
    universe: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'NFLX', 'ADBE', 'BABA', 'SHOP', 'PYPL', 'ROKU', 'MRNA', 'BA', 'WMT', 'JPM', 'ZM', 'EBAY'],
    benchmark: 'QQQ', benchmark_robustness: 'SPY',
    confirmatory_cell: { construction: 'long_short_top5_minus_bottom5', h: 3, k: 5, beta_neutralized: true },
    horizons_exploratory: [1, 5],
    timing: 'signal day T (post-close) -> enter T+1 open, exit T+1+h open, open-to-open, adjustment=all',
    min_names_per_date: 12,
    friction_bps: { equity: { optimistic: 1, decision: 2, stress: 5 } },
    friction_model: 'spread_net = gross - 4*bps/1e4; leg_net = gross - 2*bps/1e4 (no overlap netting, conservative)',
    beta: 'spread-vs-QQQ and per-name-vs-QQQ OLS on TRAIN daily returns, frozen, applied to holdout',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    direction_rule: "d* = sign(mean train beta-neutral spread_resid at h=3); REJECT(NO-SIGNAL) unless train oriented CI lo>0",
    decision_rule: {
      gate_a: 'holdout beta-neutral spread_resid oriented (by d*) 95% CI lo>0',
      gate_b: 'held-leg (top if d*>0 else bottom) pooled per-name beta-adjusted alpha 95% CI lo>0',
      robustness: 'spread_resid same sign as d* at h=1 and h=5 (supportive, non-gating)',
      verdict: 'KEEP-CANDIDATE iff train-signal & gate_a & gate_b & not underpowered; else REJECT',
    },
    power_floor: { distinct_dates: 100, name_trades: 200 },
    split: 'chronological 70/30 on valid formation dates (h=3)',
    counts: { train_n: trainN, holdout_n: holdoutN, valid_dates_n: validDatesN, split_boundary: splitBoundary },
    limitations: ['half-signal-no-OI', '~2.3yr-thin-holdout', 'enumeration-survivorship', 'options-bar-volume-consolidation-unverified', 'train-beta-stability'],
    expected_outcome: 'REJECT',
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyEovPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const bundle = JSON.parse(readFileSync(flag('--instances', 'data/lab/eov-instances.json'), 'utf8'));
    const a = buildEovPrereg({ trainN: bundle.meta.trainN, holdoutN: bundle.meta.holdoutN, validDatesN: bundle.meta.validDates.length, splitBoundary: bundle.meta.splitBoundary });
    const out = flag('--out', 'data/lab/eov-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
```

- [ ] **Step 4: Run, verify pass** → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/eov-prereg.mjs scripts/eov-prereg.test.mjs
git commit -m "feat(eov): hash-locked pre-registration (mirrors orb-prereg)"
```

---

## Task 7: Scoring (friction, beta-neutralize, alpha, `decideEov`, render)

**Files:**
- Create: `scripts/eov-score.mjs`
- Test: `scripts/eov-score.test.mjs`

**Interfaces:**
- Consumes: `mean`, `bootstrapMeanCI` (`coil-threshold-metrics.mjs`); `olsBeta` (`ema-beta.mjs`); `verifyEovPrereg` (Task 6); bundle from Task 5.
- Produces (pure, exported):
  - `netSpread(gross:number, bps:number): number` = `gross - 4*bps/1e4`.
  - `netLeg(gross:number, bps:number): number` = `gross - 2*bps/1e4`.
  - `betaNeutralResidSeries(rows: Array<{date,grossSpread,qqqRet,split}>, bps, beta): Array<{date, net}>` — `net = netSpread - beta*qqqRet`, beta applied to all rows.
  - `estimateSpreadBeta(trainRows, bps): number` — `olsBeta` of `netSpread` on `qqqRet` over train rows.
  - `orientRows(rows, dstar): Array<{date, net}>` — multiplies `net` by `sign(dstar)`.
  - `decideEov({ trainGateLo, gateALo, gateBLo, nDatesHoldout, nNameTrades, powerFloor }): { verdict, reason }` — verdicts `NO-SIGNAL | UNDERPOWERED | REJECT | KEEP-CANDIDATE`.

- [ ] **Step 1: Write failing tests** (focus on the pure verdict + orientation/friction)

```javascript
// scripts/eov-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netSpread, netLeg, orientRows, decideEov } from './eov-score.mjs';

test('friction model: spread pays 4 legs, single leg pays 2', () => {
  assert.ok(Math.abs(netSpread(0.01, 2) - (0.01 - 4 * 2 / 1e4)) < 1e-12);
  assert.ok(Math.abs(netLeg(0.01, 2) - (0.01 - 2 * 2 / 1e4)) < 1e-12);
});

test('orientRows flips sign for a reversal direction', () => {
  const r = orientRows([{ date: 'D', net: -0.02 }], -1);
  assert.ok(Math.abs(r[0].net - 0.02) < 1e-12); // reversal: negative spread becomes positive oriented
});

test('decideEov: power floor dominates', () => {
  const v = decideEov({ trainGateLo: 0.1, gateALo: 0.1, gateBLo: 0.1, nDatesHoldout: 50, nNameTrades: 999, powerFloor: { distinct_dates: 100, name_trades: 200 } });
  assert.equal(v.verdict, 'UNDERPOWERED');
});

test('decideEov: no train signal -> NO-SIGNAL', () => {
  const v = decideEov({ trainGateLo: -0.01, gateALo: 0.1, gateBLo: 0.1, nDatesHoldout: 150, nNameTrades: 999, powerFloor: { distinct_dates: 100, name_trades: 200 } });
  assert.equal(v.verdict, 'NO-SIGNAL');
});

test('decideEov: all gates pass -> KEEP-CANDIDATE; one fails -> REJECT', () => {
  const base = { trainGateLo: 0.02, nDatesHoldout: 150, nNameTrades: 800, powerFloor: { distinct_dates: 100, name_trades: 200 } };
  assert.equal(decideEov({ ...base, gateALo: 0.01, gateBLo: 0.01 }).verdict, 'KEEP-CANDIDATE');
  assert.equal(decideEov({ ...base, gateALo: 0.01, gateBLo: -0.01 }).verdict, 'REJECT');
});
```

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement** (pure functions + CLI wiring; CLI mirrors `orb-score.mjs`)

```javascript
// scripts/eov-score.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, bootstrapMeanCI } from './coil-threshold-metrics.mjs';
import { olsBeta } from './ema-beta.mjs';

export const netSpread = (gross, bps) => gross - 4 * bps / 1e4;
export const netLeg = (gross, bps) => gross - 2 * bps / 1e4;

export function estimateSpreadBeta(trainRows, bps) {
  const a = [], b = [];
  for (const r of trainRows) if (Number.isFinite(r.grossSpread) && Number.isFinite(r.qqqRet)) { a.push(netSpread(r.grossSpread, bps)); b.push(r.qqqRet); }
  return olsBeta(a, b);
}

export function betaNeutralResidSeries(rows, bps, beta) {
  return rows
    .filter(r => Number.isFinite(r.grossSpread) && Number.isFinite(r.qqqRet))
    .map(r => ({ date: r.date, net: netSpread(r.grossSpread, bps) - beta * r.qqqRet }));
}

export const orientRows = (rows, dstar) => rows.map(r => ({ date: r.date, net: Math.sign(dstar) * r.net }));

export function decideEov({ trainGateLo, gateALo, gateBLo, nDatesHoldout, nNameTrades, powerFloor }) {
  if (nDatesHoldout < powerFloor.distinct_dates || nNameTrades < powerFloor.name_trades) {
    return { verdict: 'UNDERPOWERED', reason: `holdout ${nDatesHoldout}d / ${nNameTrades} name-trades < ${powerFloor.distinct_dates}/${powerFloor.name_trades}` };
  }
  if (!(trainGateLo > 0)) return { verdict: 'NO-SIGNAL', reason: 'train oriented CI lo<=0; no in-sample direction to confirm' };
  const gA = gateALo > 0, gB = gateBLo > 0;
  if (gA && gB) return { verdict: 'KEEP-CANDIDATE', reason: 'train signal + gate_a + gate_b all pass' };
  return { verdict: 'REJECT', reason: `gate_a=${gA} gate_b=${gB}` };
}

function r4(x) { return x == null ? 'n/a' : Number(x).toFixed(4); }

// CLI
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyEovPrereg } = await import('./eov-prereg.mjs');
    const args = process.argv.slice(2); const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const bundle = JSON.parse(readFileSync(flag('--instances', 'data/lab/eov-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/eov-prereg.json'), 'utf8'));
    const v = verifyEovPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const bps = prereg.friction_bps.equity.decision;
    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };
    const H = 3;
    const sp = bundle.spread[H];
    const trainSp = sp.filter(r => r.split === 'train'), holdSp = sp.filter(r => r.split === 'holdout');

    // Stage 1: beta on train, d*, train oriented CI
    const betaSpread = estimateSpreadBeta(trainSp, bps);
    const trainResid = betaNeutralResidSeries(trainSp, bps, betaSpread);
    const dstar = Math.sign(mean(trainResid.map(r => r.net)) ?? 0) || 1;
    const trainGate = bootstrapMeanCI(orientRows(trainResid, dstar), boot);

    // Stage 2: Gate A (holdout oriented spread_resid)
    const holdResid = betaNeutralResidSeries(holdSp, bps, betaSpread);
    const gateA = bootstrapMeanCI(orientRows(holdResid, dstar), boot);

    // Gate B: held leg per-name beta-adjusted alpha on holdout
    const heldLeg = dstar > 0 ? 'top' : 'bottom';
    const trainDates = new Set(bundle.meta.validDates.slice(0, bundle.meta.trainN));
    const qByDate = new Map(bundle.nameDailyRet.QQQ.map(x => [x.date, x.ret]));
    const betaByName = {};
    for (const tk of prereg.universe) {
      const aR = [], bR = [];
      for (const x of (bundle.nameDailyRet[tk] || [])) { if (!trainDates.has(x.date)) continue; const q = qByDate.get(x.date); if (q != null) { aR.push(x.ret); bR.push(q); } }
      betaByName[tk] = olsBeta(aR, bR);
    }
    const legRows = bundle.legs[H].filter(r => r.leg === heldLeg && r.split === 'holdout' && Number.isFinite(r.grossRet) && Number.isFinite(r.qqqRet))
      .map(r => ({ date: r.date, net: netLeg(r.grossRet, bps) - (betaByName[r.ticker] ?? 0) * r.qqqRet }));
    const gateB = bootstrapMeanCI(legRows, boot);

    // Robustness: spread_resid sign at h=1,5
    const robustness = {};
    for (const h of [1, 5]) {
      const rows = betaNeutralResidSeries(bundle.spread[h].filter(r => r.split === 'holdout'), bps, betaSpread);
      robustness[h] = Math.sign(mean(rows.map(r => r.net)) ?? 0);
    }

    const nDatesHoldout = new Set(holdSp.map(r => r.date)).size;
    const verdict = decideEov({ trainGateLo: trainGate.lo, gateALo: gateA.lo, gateBLo: gateB.lo, nDatesHoldout, nNameTrades: legRows.length, powerFloor: prereg.power_floor });

    const dir = dstar > 0 ? 'MOMENTUM (long high-EOV)' : 'REVERSAL (long low-EOV)';
    const L = [];
    L.push('# Reduced-EOV Backtest — Results', '');
    L.push(`**Verdict: ${verdict.verdict}** — ${verdict.reason}`, '');
    L.push(`Half-signal **proxy** (call-volume intensity only; no open-interest half). Prereg hash \`${prereg.artifact_hash}\`. Friction ${bps}bps. Direction fixed on train: **${dir}** (d*=${dstar}). Expected: REJECT.`, '');
    L.push('## Confirmatory cell (long-short, h=3, beta-neutral)', '', '| stage | n | mean | CI lo | CI hi |', '|---|---|---|---|---|');
    L.push(`| train oriented spread_resid | ${trainGate.n} | ${r4(trainGate.mean)} | ${r4(trainGate.lo)} | ${r4(trainGate.hi)} |`);
    L.push(`| Gate A holdout oriented spread_resid | ${gateA.n} | ${r4(gateA.mean)} | ${r4(gateA.lo)} | ${r4(gateA.hi)} |`);
    L.push(`| Gate B holdout held-leg alpha (${heldLeg}) | ${gateB.n} | ${r4(gateB.mean)} | ${r4(gateB.lo)} | ${r4(gateB.hi)} |`);
    L.push('', `- spread-vs-QQQ train beta: ${r4(betaSpread)}; holdout distinct dates: ${nDatesHoldout}; held-leg name-trades: ${legRows.length}`);
    L.push(`- robustness sign (want = d*=${dstar}): h1=${robustness[1]}, h5=${robustness[5]}`, '');
    L.push('## Limitations', '', ...prereg.limitations.map(s => `- ${s}`));
    L.push('', '_Lab-only. A KEEP-CANDIDATE authorizes only forward paper-collection confirmation, never deployment._');
    const out = flag('--out', join(root, 'docs', 'lab', 'eov-RESULTS.md'));
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, L.join('\n'));
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason}). Wrote ${out}\n`);
  }
}
```

- [ ] **Step 4: Run, verify pass** → `node --test scripts/eov-score.test.mjs` PASS.

- [ ] **Step 5: Full pure-core test sweep + commit**

Run: `node --test scripts/eov-*.test.mjs`
Expected: all PASS.

```bash
git add scripts/eov-score.mjs scripts/eov-score.test.mjs
git commit -m "feat(eov): scoring (friction, beta-neutral gates, train->holdout decideEov, RESULTS render)"
```

---

## Task 8: Fetchers — option contracts + option daily bars (I/O)

**Files:**
- Create: `scripts/eov-fetch-contracts.mjs`, `scripts/eov-fetch-bars.mjs`

**Interfaces:**
- `eov-fetch-contracts.mjs` writes `data/lab/eov-contracts/<TICKER>.json` = `{ written_at, symbols: string[] }` (call contracts only, active + inactive).
- `eov-fetch-bars.mjs` reads those, writes `data/lab/eov-volume-cache/<TICKER>.json` = `{ written_at, callVol: Record<date, number> }` using `aggregateCallVol` (Task 4).
- Reuses the `.env` cred reader idiom from `orb-fetch-bars.mjs`.

> Network code — no unit test (matches `orb-fetch-bars.mjs`). Validated by the smoke run in Step 3–4.

- [ ] **Step 1: Implement `eov-fetch-contracts.mjs`**

```javascript
// scripts/eov-fetch-contracts.mjs
// Enumerate CALL contracts (active + inactive/expired) per underlying. Creds from .env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EOV_UNIVERSE } from './eov-universe.mjs';

const TRADE = 'https://paper-api.alpaca.markets';
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
async function listContracts(sym, status, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  const out = []; let token = null;
  for (let page = 0; page < 5000; page += 1) {
    const q = new URLSearchParams({ underlying_symbols: sym, type: 'call', status, limit: '10000' });
    if (token) q.set('page_token', token);
    const r = await fetch(`${TRADE}/v2/options/contracts?${q}`, { headers });
    if (!r.ok) throw new Error(`${sym}/${status}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    for (const c of (j.option_contracts || [])) out.push(c.symbol);
    token = j.next_page_token; if (!token) break;
  }
  return out;
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  mkdirSync(join(process.cwd(), 'data/lab/eov-contracts'), { recursive: true });
  for (const sym of EOV_UNIVERSE) {
    try {
      const active = await listContracts(sym, 'active', id, sec);
      const inactive = await listContracts(sym, 'inactive', id, sec);
      const symbols = [...new Set([...active, ...inactive])];
      writeFileSync(join(process.cwd(), 'data/lab/eov-contracts', `${sym}.json`), JSON.stringify({ written_at: new Date().toISOString(), symbols }));
      console.log(`${sym}: ${symbols.length} call contracts (active ${active.length} / inactive ${inactive.length})`);
    } catch (e) { console.log(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 350));
  }
}
```

- [ ] **Step 2: Implement `eov-fetch-bars.mjs`**

```javascript
// scripts/eov-fetch-bars.mjs
// Daily option bars per call contract -> per-name daily CallVol. Creds from .env.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EOV_UNIVERSE } from './eov-universe.mjs';
import { aggregateCallVol } from './eov-aggregate.mjs';

const DATA = 'https://data.alpaca.markets';
const START = '2024-01-01', END = new Date().toISOString().slice(0, 10);
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
async function barsForBatch(symbols, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  const byContract = {}; let token = null;
  for (let page = 0; page < 20000; page += 1) {
    const q = new URLSearchParams({ symbols: symbols.join(','), timeframe: '1Day', start: START, end: END, limit: '10000' });
    if (token) q.set('page_token', token);
    const r = await fetch(`${DATA}/v1beta1/options/bars?${q}`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    for (const [sym, bars] of Object.entries(j.bars || {})) {
      byContract[sym] = byContract[sym] || [];
      for (const b of bars) byContract[sym].push({ date: b.t.slice(0, 10), v: b.v });
    }
    token = j.next_page_token; if (!token) break;
  }
  return byContract;
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  mkdirSync(join(process.cwd(), 'data/lab/eov-volume-cache'), { recursive: true });
  for (const sym of EOV_UNIVERSE) {
    try {
      const { symbols } = JSON.parse(readFileSync(join(process.cwd(), 'data/lab/eov-contracts', `${sym}.json`), 'utf8'));
      const byContract = {};
      for (let i = 0; i < symbols.length; i += 200) {
        Object.assign(byContract, await barsForBatch(symbols.slice(i, i + 200), id, sec));
        await new Promise(r => setTimeout(r, 350));
      }
      const callVol = aggregateCallVol(byContract);
      writeFileSync(join(process.cwd(), 'data/lab/eov-volume-cache', `${sym}.json`), JSON.stringify({ written_at: new Date().toISOString(), callVol }));
      console.log(`${sym}: ${Object.keys(callVol).length} days of CallVol from ${symbols.length} contracts`);
    } catch (e) { console.log(`${sym}: ${e.message}`); }
  }
}
```

- [ ] **Step 3: Smoke one name first (feasibility + §7.4 consolidated-volume eyeball)**

Run (from the worktree, with `.env` copied in):
```bash
node -e "process.argv[2]='AAPL'" # (or temporarily hardcode EOV_UNIVERSE=['AAPL'] in a scratch run)
node scripts/eov-fetch-contracts.mjs
node scripts/eov-fetch-bars.mjs
```
Expected: AAPL prints thousands of contracts and a few hundred days of CallVol with plausibly large daily numbers (mega-cap calls trade ≫ 1k contracts/day). If daily CallVol looks implausibly tiny, the bars feed is single-venue — note it for RESULTS §7.4.

- [ ] **Step 4: Full pull**

```bash
node scripts/eov-fetch-contracts.mjs
node scripts/eov-fetch-bars.mjs
```
Expected: all 20 names cached under `data/lab/eov-volume-cache/`.

- [ ] **Step 5: Commit (scripts only — caches are git-ignored)**

```bash
git add scripts/eov-fetch-contracts.mjs scripts/eov-fetch-bars.mjs
git commit -m "feat(eov): Alpaca option contract + daily-bar fetchers (per-name CallVol)"
```

---

## Task 9: Fetchers — adjusted stock bars + corporate actions (I/O)

**Files:**
- Create: `scripts/eov-fetch-stockbars.mjs`, `scripts/eov-fetch-corpactions.mjs`

**Interfaces:**
- `eov-fetch-stockbars.mjs` → `data/lab/eov-stockbars/<TICKER>.json` = `{ written_at, bars: [{Timestamp, Open, Close}] }`, **`adjustment=all`**, 1Day, for the 22 tickers (`allEovStockTickers`).
- `eov-fetch-corpactions.mjs` → `data/lab/eov-splits.json` = `Record<ticker, string[]>` (split dates in-window).

> Network code — no unit test. The shapes here are exactly what Task 5's CLI loader reads.

- [ ] **Step 1: Implement `eov-fetch-stockbars.mjs`** (adapted from `orb-fetch-bars.mjs`, daily + SIP-default feed)

```javascript
// scripts/eov-fetch-stockbars.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { allEovStockTickers } from './eov-universe.mjs';

const START = '2024-01-01', END = new Date().toISOString().slice(0, 10);
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
async function fetchBars(sym, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  let token = null; const out = [];
  for (let page = 0; page < 2000; page += 1) {
    const q = new URLSearchParams({ timeframe: '1Day', start: START, end: END, adjustment: 'all', limit: '10000', feed: 'iex' });
    if (token) q.set('page_token', token);
    const r = await fetch(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(sym)}/bars?${q}`, { headers });
    if (!r.ok) throw new Error(`${sym}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    for (const b of (j.bars || [])) out.push({ Timestamp: b.t, Open: b.o, Close: b.c });
    token = j.next_page_token; if (!token) break;
  }
  return out;
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  mkdirSync(join(process.cwd(), 'data/lab/eov-stockbars'), { recursive: true });
  for (const sym of allEovStockTickers()) {
    try { const bars = await fetchBars(sym, id, sec);
      writeFileSync(join(process.cwd(), 'data/lab/eov-stockbars', `${sym}.json`), JSON.stringify({ written_at: new Date().toISOString(), bars }));
      console.log(`${sym}: ${bars.length} daily bars`);
    } catch (e) { console.log(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 300));
  }
}
```

> Note: `feed: 'iex'` matches the ORB study's free feed. Daily adjusted bars are sufficient for open-to-open returns; if a name looks sparse, RESULTS notes coverage (spec §3).

- [ ] **Step 2: Implement `eov-fetch-corpactions.mjs`**

```javascript
// scripts/eov-fetch-corpactions.mjs
// In-window forward stock splits per name -> data/lab/eov-splits.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EOV_UNIVERSE } from './eov-universe.mjs';

const START = '2024-01-01', END = new Date().toISOString().slice(0, 10);
function creds() {
  const env = readFileSync('.env', 'utf8'); const m = {};
  for (const line of env.split(/\r?\n/)) { const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/); if (mm) m[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return { id: m.ALPACA_PUBLIC_KEY || m.ALPACA_API_KEY, sec: m.ALPACA_SECRET_KEY || m.ALPACA_API_SECRET };
}
async function splitsFor(sym, id, sec) {
  const headers = { 'APCA-API-KEY-ID': id, 'APCA-API-SECRET-KEY': sec };
  const out = []; let token = null;
  for (let page = 0; page < 100; page += 1) {
    const q = new URLSearchParams({ types: 'forward_split,reverse_split', symbols: sym, start: START, end: END, limit: '1000' });
    if (token) q.set('page_token', token);
    const r = await fetch(`https://paper-api.alpaca.markets/v2/corporate_actions/announcements?${q}`, { headers });
    if (!r.ok) throw new Error(`${sym}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.corporate_actions || j.announcements || []);
    for (const c of rows) { const d = c.ex_date || c.effective_date || c.process_date; if (d) out.push(d); }
    token = (j && j.next_page_token) || null; if (!token) break;
  }
  return [...new Set(out)].sort();
}
{
  const { id, sec } = creds();
  if (!id || !sec) { console.error('missing Alpaca creds in .env'); process.exit(1); }
  const splits = {};
  for (const sym of EOV_UNIVERSE) {
    try { splits[sym] = await splitsFor(sym, id, sec); console.log(`${sym}: splits ${JSON.stringify(splits[sym])}`); }
    catch (e) { splits[sym] = []; console.log(`${sym}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 300));
  }
  mkdirSync(join(process.cwd(), 'data/lab'), { recursive: true });
  writeFileSync(join(process.cwd(), 'data/lab/eov-splits.json'), JSON.stringify(splits, null, 2));
}
```

- [ ] **Step 3: Run both + sanity-check the known split**

```bash
node scripts/eov-fetch-stockbars.mjs
node scripts/eov-fetch-corpactions.mjs
```
Expected: `NVDA` shows a split around `2024-06-10` (the 10:1). If the announcements endpoint returns an unexpected shape, inspect one raw response and adjust the `rows`/date-field extraction before relying on it (this is the one endpoint not previously used in the repo).

- [ ] **Step 4: Commit (scripts only)**

```bash
git add scripts/eov-fetch-stockbars.mjs scripts/eov-fetch-corpactions.mjs
git commit -m "feat(eov): adjusted stock-bar + split fetchers"
```

---

## Task 10: End-to-end run, RUNBOOK, verdict

**Files:**
- Create: `docs/lab/eov-RUNBOOK.md`
- Generate + commit: `docs/lab/eov-RESULTS.md`

- [ ] **Step 1: Build the panel from real caches**

```bash
node scripts/eov-build.mjs
```
Expected: prints valid-date count + train/holdout split + boundary. Sanity: validDates ≥ ~300, holdout ≥ 100 distinct dates (else expect UNDERPOWERED — that is itself a legitimate, honest result).

- [ ] **Step 2: Inspect the integrity table**

Open `data/lab/eov-instances.json` (or add a one-off `contractCountByMonth` print in build) and confirm contract counts per name don't ramp pathologically over time (spec §7.3). Note anything notable for RESULTS.

- [ ] **Step 3: Freeze the prereg (MUST precede scoring)**

```bash
node scripts/eov-prereg.mjs
```
Expected: writes `data/lab/eov-prereg.json` and prints the hash.

- [ ] **Step 4: Score the frozen holdout**

```bash
node scripts/eov-score.mjs
```
Expected: prints `VERDICT: ...` and writes `docs/lab/eov-RESULTS.md`. Confirm the refusal path too:
```bash
node -e "const f='data/lab/eov-prereg.json';const j=require('fs').readFileSync(f,'utf8');require('fs').writeFileSync(f,j.replace(/\"seed\": 1234/,'\"seed\": 9999'));"
node scripts/eov-score.mjs ; echo "exit=$?"   # expect REFUSING + exit=4
node scripts/eov-prereg.mjs                    # rewrite clean prereg
```

- [ ] **Step 5: Write the RUNBOOK**

```markdown
# Reduced-EOV Study — Runbook

Lab-only pre-registered backtest of reduced-EOV (call-volume intensity) forward power on 20
heavily-optioned mega-caps. Read-only; no deployment. Spec:
`docs/superpowers/specs/2026-06-19-reduced-eov-backtest-design.md`.

## Prereq
Alpaca creds (`ALPACA_PUBLIC_KEY` / `ALPACA_SECRET_KEY`) in `.env` in the run directory
(copy project-root `.env` into the worktree; `.env` is git-ignored).

## Pipeline (order matters)
```bash
node scripts/eov-fetch-contracts.mjs   # 1. enumerate call contracts (active+inactive) -> data/lab/eov-contracts/
node scripts/eov-fetch-bars.mjs        # 2. option daily bars -> per-name CallVol -> data/lab/eov-volume-cache/
node scripts/eov-fetch-stockbars.mjs   # 3. adjusted daily stock bars (20+QQQ+SPY) -> data/lab/eov-stockbars/
node scripts/eov-fetch-corpactions.mjs # 4. splits -> data/lab/eov-splits.json
node scripts/eov-build.mjs             # 5. EOV panel + forward returns -> data/lab/eov-instances.json
node scripts/eov-prereg.mjs            # 6. write + hash-lock data/lab/eov-prereg.json (MUST precede scoring)
node scripts/eov-score.mjs             # 7. score frozen holdout -> docs/lab/eov-RESULTS.md (+ VERDICT)
```
`eov-score.mjs` refuses (exit 4) on a prereg hash mismatch. `data/lab/*` is git-ignored;
only `docs/lab/eov-RESULTS.md` (carries the prereg hash) is committed.

## Tests
```bash
node --test scripts/eov-*.test.mjs
```

## Decision
Confirmatory cell: long-short top5−bottom5, h=3, beta-neutral, direction fixed on train.
KEEP-CANDIDATE requires train signal (oriented CI lo>0) AND Gate A (holdout oriented
spread_resid CI lo>0) AND Gate B (held-leg per-name beta-adjusted alpha CI lo>0); UNDERPOWERED
if holdout < 100 dates or held leg < 200 name-trades. Half-signal proxy (no OI). Honest prior:
REJECT. A KEEP authorizes only forward paper-collection — never deployment.
```

- [ ] **Step 6: Final test sweep + commit results**

```bash
node --test scripts/eov-*.test.mjs
git add docs/lab/eov-RUNBOOK.md docs/lab/eov-RESULTS.md
git commit -m "docs(lab): reduced-EOV runbook + RESULTS (verdict: <fill from run>)"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §2 signal → Tasks 2,5; §3 universe → Task 1; §4 construction/adjusted/splits/overlap/betas → Tasks 3,5,7; §5 gates/train→holdout/power → Tasks 6,7; §6 holdout split → Task 5; §7 limitations → carried in prereg (Task 6) + RESULTS (Task 7); §8 pipeline (7 scripts) → Tasks 5–10; §9 YAGNI respected (no GEX, no options-exec sim, no grid). All covered.
- **Placeholders:** none — every code step is concrete. The single fill-in is the verdict string in Task 10 Step 6 (only knowable post-run, by design).
- **Type consistency:** bundle shape from Task 5 (`spread[h]`/`legs[h]`/`nameDailyRet`/`meta`) is consumed verbatim in Tasks 6–7; `bootstrapMeanCI(rows,{iterations,seed,blockSessions})` and `olsBeta(a,b)` signatures match the existing modules; cache shapes written in Tasks 8–9 match the loader in Task 5's CLI.
