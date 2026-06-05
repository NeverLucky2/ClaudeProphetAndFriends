# Coil RSI-Threshold Backtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only, pre-registered backtest measuring whether loosening Coil's RSI(2)<5 entry threshold improves the strategy — never touching live Coil.

**Architecture:** Node ESM scripts that reuse the existing Coil signal math (`wilderRSI`/`sma`) and bar-cache loader, add a faithful exit simulator + a forward-earnings filter, enumerate Coil-faithful (fresh, one-per-ticker) trades over ~6yr of the 80-name universe, then score per-RSI-bucket edge (Phase 1, train kill-gate) and a portfolio sim under thresholds T∈{5,8,10,15} (Phase 2). The holdout is read once via a frozen pass; the verdict follows a hash-locked pre-registration (primary T=8, expected null KEEP).

**Tech Stack:** Node 18+ ESM (`"type":"module"`), `node:test` + `node:assert/strict`, global `fetch` (injectable), `node:crypto` (prereg hash). Reuses `scripts/coil-meanrev-signal.mjs`, `scripts/coil-eventstudy-{bars,build,prereg}.mjs`. Spec: `docs/superpowers/specs/2026-06-05-coil-rsi-threshold-backtest-design.md`.

---

## File Structure

- `scripts/coil-threshold-exitsim.mjs` — pure: `entryFiresAt(closes,idx,rsiMax)`, `simulateTrade(bars,entryIdx)`.
- `scripts/coil-threshold-earnings.mjs` — pure `earningsWithinNext5(...)` + FMP fetch I/O shell + CLI writing `data/lab/coil-earnings-dates.json`.
- `scripts/coil-threshold-metrics.mjs` — pure stats: `applyFriction`, `winRate`, `profitFactor`, `mean`, `median`, `bootstrapMeanCI`, `bootstrapDiffCI`.
- `scripts/coil-threshold-prereg.mjs` — `buildThresholdPrereg`, `verifyThresholdPrereg`.
- `scripts/coil-threshold-build.mjs` — pure `bucketOf`, `enumerateFreshTrades` + CLI writing `data/lab/coil-threshold-instances.json`.
- `scripts/coil-threshold-portfolio.mjs` — pure `simulatePortfolio`, `marginalFills` + CLI.
- `scripts/coil-threshold-score.mjs` — pure `bucketStats`, `decision` + CLI (train kill-gate, frozen holdout pass, hash-refuse) writing `docs/lab/coil-rsi-threshold-RESULTS.md`.
- Test file per script (`*.test.mjs`).
- Generated/committed: `data/lab/coil-threshold-prereg.json`, `data/lab/coil-earnings-dates.json`, `data/lab/coil-threshold-instances.json`, `docs/lab/coil-rsi-threshold-RESULTS.md`.

**Trade object shape** (produced by `simulateTrade`, enriched by enumeration), used everywhere downstream:
```
{ ticker, idx, date, rsi2, bucket, entry, exit, exitReason, daysHeld, grossReturn, censored, split }
```

---

## Task 1: Exit-sim module — threshold-parametrized entry detector

**Files:**
- Create: `scripts/coil-threshold-exitsim.mjs`
- Test: `scripts/coil-threshold-exitsim.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-threshold-exitsim.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryFiresAt } from './coil-threshold-exitsim.mjs';
import { entryFires } from './coil-meanrev-signal.mjs';

// Build a 220-bar series: long uptrend then a sharp multi-day pullback so RSI(2) is low
// and close sits below SMA5 but above SMA200 at the last bar.
function pullbackCloses() {
  const L = 220, closes = [];
  for (let i = 0; i <= L - 6; i += 1) closes[i] = 100 + 0.2 * i;
  const peak = closes[L - 6];
  for (let i = L - 5; i < L; i += 1) closes[i] = peak - 0.5 * (i - (L - 6));
  return closes;
}

test('entryFiresAt at rsiMax=5 equals the production entryFires', () => {
  const closes = pullbackCloses();
  const idx = closes.length - 1;
  assert.equal(entryFiresAt(closes, idx, 5), entryFires(closes, idx));
});

test('entryFiresAt is monotonic in rsiMax (15 is a superset of 5)', () => {
  const closes = pullbackCloses();
  const idx = closes.length - 1;
  if (entryFiresAt(closes, idx, 5)) assert.equal(entryFiresAt(closes, idx, 15), true);
});

test('entryFiresAt still enforces SMA gates regardless of rsiMax', () => {
  // close ABOVE sma5 must never fire, even at a very loose RSI bound.
  const L = 220, closes = [];
  for (let i = 0; i < L; i += 1) closes[i] = 100 + 0.2 * i; // pure uptrend, close>sma5
  assert.equal(entryFiresAt(closes, L - 1, 100), false);
});

test('entryFiresAt returns false before MIN_BARS history', () => {
  const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
  assert.equal(entryFiresAt(closes, 49, 15), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-threshold-exitsim.test.mjs`
Expected: FAIL — cannot resolve `entryFiresAt`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-threshold-exitsim.mjs`:

```js
// scripts/coil-threshold-exitsim.mjs
// Pure backtest primitives for the Coil RSI-threshold study:
//   - entryFiresAt: Coil's entry predicate with a parametrized RSI bound (only the
//     RSI threshold moves; the SMA200 regime + SMA5 pullback gates are unchanged).
//   - simulateTrade: faithful simulation of Coil's real exits.
// Reuses the production signal math; never mutates it.
import { wilderRSI, sma } from './coil-meanrev-signal.mjs';

// Mirror coil-meanrev-signal.mjs's module-local constants (not exported there).
const RSI_PERIOD = 2, SMA200 = 200, SMA5 = 5, MIN_BARS = 210;

// Coil's entry predicate with RSI(2) < rsiMax (rsiMax=5 reproduces production entryFires).
export function entryFiresAt(closes, idx, rsiMax) {
  if (idx + 1 < MIN_BARS) return false;
  const rsi2 = wilderRSI(closes.slice(0, idx + 1), RSI_PERIOD);
  const s200 = sma(closes, idx, SMA200);
  const s5 = sma(closes, idx, SMA5);
  if (s200 === null || s5 === null) return false;
  const c = closes[idx];
  return rsi2 < rsiMax && c > s200 && c < s5;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-threshold-exitsim.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-threshold-exitsim.mjs scripts/coil-threshold-exitsim.test.mjs
git commit -m "feat(coil-threshold): parametrized entry detector entryFiresAt"
```

---

## Task 2: Exit-sim module — `simulateTrade`

**Files:**
- Modify: `scripts/coil-threshold-exitsim.mjs`
- Test: `scripts/coil-threshold-exitsim.test.mjs`

- [ ] **Step 1: Append the failing test**

Append to `scripts/coil-threshold-exitsim.test.mjs`:

```js
import { simulateTrade } from './coil-threshold-exitsim.mjs';

// bar helper
const B = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });

test('simulateTrade: -7% intraday stop fills at the stop price', () => {
  // entry close = 100; day+1 dips to low 92 (< 93 stop) but opens 99
  const bars = [B('d0', 100, 100, 100, 100), B('d1', 99, 99, 92, 95)];
  const t = simulateTrade(bars, 0);
  assert.equal(t.exitReason, 'stop');
  assert.equal(t.exit, 93);                 // entry*0.93
  assert.equal(t.daysHeld, 1);
  assert.ok(Math.abs(t.grossReturn - (-0.07)) < 1e-9);
});

test('simulateTrade: gap-through stop fills at the open', () => {
  const bars = [B('d0', 100, 100, 100, 100), B('d1', 90, 91, 89, 90)]; // opens below 93
  const t = simulateTrade(bars, 0);
  assert.equal(t.exitReason, 'stop');
  assert.equal(t.exit, 90);                 // filled at the gapped-down open
});

test('simulateTrade: close above SMA5 triggers sma5_cross exit', () => {
  // Construct so that on d+1 the close pops above the 5-day SMA. Use a flat-ish base
  // then a jump; sma uses the last 5 closes including the current bar.
  const base = [];
  for (let i = 0; i < 6; i += 1) base.push(B('b' + i, 90, 91, 89, 90));
  const bars = [...base, B('entry', 88, 89, 87, 88), B('d1', 100, 101, 99, 100)];
  const entryIdx = bars.length - 2;
  const t = simulateTrade(bars, entryIdx);
  assert.equal(t.exitReason, 'sma5_cross');
  assert.equal(t.exit, 100);
});

test('simulateTrade: 5-day time stop exits at close[d+5]', () => {
  // Keep price below stop-trigger and below SMA5, RSI not >70, so only the timeout fires.
  const bars = [B('e', 100, 100, 100, 100)];
  for (let k = 1; k <= 5; k += 1) bars.push(B('d' + k, 96, 96.5, 95, 96)); // 96 > 93 stop, < entry
  const t = simulateTrade(bars, 0);
  assert.equal(t.exitReason, 'time_stop');
  assert.equal(t.daysHeld, 5);
  assert.equal(t.exit, 96);
});

test('simulateTrade: right-censored when data ends before any exit', () => {
  const bars = [B('e', 100, 100, 100, 100), B('d1', 96, 96, 95, 96)]; // only 1 bar after entry
  const t = simulateTrade(bars, 0);
  assert.equal(t.censored, true);
  assert.equal(t.grossReturn, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-threshold-exitsim.test.mjs`
Expected: FAIL — `simulateTrade` not exported.

- [ ] **Step 3: Append the implementation**

Append to `scripts/coil-threshold-exitsim.mjs`:

```js
function done(entry, exit, reason, k) {
  return { entry, exit, exitReason: reason, daysHeld: k, grossReturn: (exit - entry) / entry, censored: false };
}

// Simulate Coil's real exits from a fill at close[entryIdx]. First trigger wins; within a
// bar the intraday -7% stop (gap-honest) precedes the close-based exits, then the 5-day
// timeout. No lookahead: each check at d+k uses only bars[0..d+k].
export function simulateTrade(bars, entryIdx, { stopPct = 0.07, maxHold = 5, rsiExit = 70 } = {}) {
  const closes = bars.map(b => b.close);
  const entry = closes[entryIdx];
  const stop = entry * (1 - stopPct);
  for (let k = 1; k <= maxHold; k += 1) {
    const j = entryIdx + k;
    if (j >= bars.length) {
      return { entry, exit: null, exitReason: null, daysHeld: k - 1, grossReturn: null, censored: true };
    }
    const bar = bars[j];
    if (bar.open <= stop) return done(entry, bar.open, 'stop', k);   // gap-through fills at open
    if (bar.low <= stop) return done(entry, stop, 'stop', k);         // intraday touch fills at stop
    const rsi2 = wilderRSI(closes.slice(0, j + 1), RSI_PERIOD);
    if (rsi2 > rsiExit) return done(entry, bar.close, 'rsi_mean_cross', k);
    const s5 = sma(closes, j, SMA5);
    if (s5 !== null && bar.close > s5) return done(entry, bar.close, 'sma5_cross', k);
    if (k === maxHold) return done(entry, bar.close, 'time_stop', k);
  }
  return { entry, exit: null, exitReason: null, daysHeld: maxHold, grossReturn: null, censored: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-threshold-exitsim.test.mjs`
Expected: PASS (Tasks 1–2; 9 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-threshold-exitsim.mjs scripts/coil-threshold-exitsim.test.mjs
git commit -m "feat(coil-threshold): faithful exit simulator simulateTrade"
```

---

## Task 3: Earnings filter (pure window + FMP fetch shell)

**Files:**
- Create: `scripts/coil-threshold-earnings.mjs`
- Test: `scripts/coil-threshold-earnings.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-threshold-earnings.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earningsWithinNext5, fetchEarningsDates } from './coil-threshold-earnings.mjs';

const barDates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12', '2026-01-13'];

test('excludes entry when earnings falls in the next 5 trading bars', () => {
  // entry at idx 0 (2026-01-05); earnings 2026-01-08 is within (d0, d5]
  assert.equal(earningsWithinNext5(barDates, 0, ['2026-01-08']), true);
});

test('captures earnings on a non-trading day inside the forward window', () => {
  // 2026-01-10 is a Saturday; window (2026-01-05, 2026-01-12] still contains it
  assert.equal(earningsWithinNext5(barDates, 0, ['2026-01-10']), true);
});

test('does NOT exclude a PAST earnings date (Coil only skips forward earnings)', () => {
  assert.equal(earningsWithinNext5(barDates, 3, ['2026-01-05']), false);
});

test('does NOT exclude when the next earnings is beyond the 5-bar window', () => {
  // entry idx 0, window ends at idx 5 = 2026-01-12; earnings 2026-01-13 is outside
  assert.equal(earningsWithinNext5(barDates, 0, ['2026-01-13']), false);
});

test('fetchEarningsDates parses the FMP stable earnings-calendar shape', async () => {
  const stub = async () => ({
    ok: true, status: 200,
    json: async () => [
      { symbol: 'KO', date: '2026-02-10' }, { symbol: 'AAPL', date: '2026-02-01' },
      { symbol: 'KO', date: '2026-05-12' }, { symbol: 'ZZZZ', date: '2026-02-02' },
    ],
  });
  const out = await fetchEarningsDates({
    tickers: ['KO', 'AAPL'], from: '2026-01-01', to: '2026-06-01', apiKey: 'x', fetchImpl: stub,
  });
  assert.deepEqual(out.KO, ['2026-02-10', '2026-05-12']);
  assert.deepEqual(out.AAPL, ['2026-02-01']);
  assert.equal(out.ZZZZ, undefined); // not in requested universe
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-threshold-earnings.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-threshold-earnings.mjs`:

```js
// scripts/coil-threshold-earnings.mjs
// Replicates Coil's FORWARD earnings skip for the backtest: exclude an entry iff the
// ticker has an earnings date within the next 5 trading bars. Past earnings do NOT
// exclude (Coil trades post-earnings gap-downs). Earnings dates come from FMP's stable
// earnings-calendar (v3 is dead — see the screener migration notes).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const FMP_HOST = 'https://financialmodelingprep.com';

// barDates: ascending 'YYYY-MM-DD' for one ticker. tickerEarningsDates: array of 'YYYY-MM-DD'.
// True iff an earnings date e satisfies date[idx] < e <= date[min(idx+5, last)].
export function earningsWithinNext5(barDates, idx, tickerEarningsDates, horizon = 5) {
  const startExclusive = barDates[idx];
  const endInclusive = barDates[Math.min(idx + horizon, barDates.length - 1)];
  for (const e of tickerEarningsDates) {
    if (e > startExclusive && e <= endInclusive) return true;
  }
  return false;
}

// One FMP /stable/earnings-calendar fetch over [from,to], filtered to `tickers`.
// Returns { TICKER: [sorted unique 'YYYY-MM-DD', ...] }. Never throws on a bad ticker;
// throws only on transport/HTTP failure so the caller can soft-fail loudly.
export async function fetchEarningsDates({ tickers, from, to, apiKey, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('FMP_API_KEY not set (source the root .env)');
  const want = new Set(tickers.map(t => t.toUpperCase()));
  const url = `${FMP_HOST}/stable/earnings-calendar?from=${from}&to=${to}&apikey=${apiKey}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`FMP earnings-calendar failed (${resp.status})`);
  const items = await resp.json();
  if (!Array.isArray(items)) throw new Error('FMP earnings-calendar malformed (expected array)');
  const out = {};
  for (const it of items) {
    const sym = (it.symbol || '').toUpperCase();
    if (!want.has(sym) || !it.date) continue;
    (out[sym] ||= new Set()).add(it.date);
  }
  for (const k of Object.keys(out)) out[k] = [...out[k]].sort();
  return out;
}

// CLI: source .env first. node scripts/coil-threshold-earnings.mjs --from 2019-01-01 --to 2026-06-05
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { MEANREV_UNIVERSE } = await import('./coil-eventstudy-build.mjs');
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const from = flag('--from', '2019-01-01');
    const to = flag('--to', new Date().toISOString().slice(0, 10));
    const out = flag('--out', 'data/lab/coil-earnings-dates.json');
    try {
      const dates = await fetchEarningsDates({
        tickers: MEANREV_UNIVERSE, from, to, apiKey: process.env.FMP_API_KEY,
      });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(dates, null, 2));
      process.stdout.write(`wrote ${out} (${Object.keys(dates).length} tickers)\n`);
    } catch (e) {
      process.stderr.write(`coil-threshold-earnings FAILED: ${e.message}\n`);
      process.stderr.write('Backtest can still run WITHOUT the earnings filter, but the [0,5) baseline will then include pre-earnings entries Coil would skip. Re-run with FMP available before trusting the verdict.\n');
      process.exit(3);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-threshold-earnings.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-threshold-earnings.mjs scripts/coil-threshold-earnings.test.mjs
git commit -m "feat(coil-threshold): forward earnings filter + FMP fetch"
```

---

## Task 4: Enumeration & build (fresh-signal, bucketed, earnings-filtered)

**Files:**
- Create: `scripts/coil-threshold-build.mjs`
- Test: `scripts/coil-threshold-build.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-threshold-build.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, enumerateFreshTrades } from './coil-threshold-build.mjs';

test('bucketOf maps RSI to the pre-registered buckets', () => {
  assert.equal(bucketOf(2), '[0,5)');
  assert.equal(bucketOf(5), '[5,8)');
  assert.equal(bucketOf(8), '[8,10)');
  assert.equal(bucketOf(10), '[10,15)');
  assert.equal(bucketOf(15), null);
});

// Build 230 bars: uptrend, then engineer two separate pullback dips far enough apart
// that a fresh trade can close before the second. We assert one-per-ticker dedup: while a
// simulated position is open, intervening signals do NOT create extra trades.
function seriesWithTwoDips() {
  const L = 230, c = [];
  for (let i = 0; i < L; i += 1) c[i] = 100 + 0.2 * i;
  // dip A around idx 212-214, dip B around idx 224-226
  for (const base of [212, 224]) for (let k = 0; k < 3; k += 1) c[base + k] = c[base - 1] - 1.5 * (k + 1);
  return c.map((close, i) => ({ date: `2026-${String(1 + Math.floor(i / 31)).padStart(2, '0')}-${String(1 + (i % 31)).padStart(2, '0')}`, open: close, high: close + 0.5, low: close - 0.5, close }));
}

test('enumerateFreshTrades dedups overlapping same-name signals (one open at a time)', () => {
  const bars = seriesWithTwoDips();
  const trades = enumerateFreshTrades(bars, { rsiMax: 15, earningsDates: [] });
  // Every trade's entry idx must be strictly after the prior trade's exit bar.
  for (let i = 1; i < trades.length; i += 1) {
    assert.ok(trades[i].idx > trades[i - 1].idx + trades[i - 1].daysHeld,
      `trade ${i} entered before prior exit`);
  }
  assert.ok(trades.length >= 1);
  for (const t of trades) assert.ok(['[0,5)', '[5,8)', '[8,10)', '[10,15)'].includes(t.bucket));
});

test('enumerateFreshTrades drops entries with forward earnings', () => {
  const bars = seriesWithTwoDips();
  const all = enumerateFreshTrades(bars, { rsiMax: 15, earningsDates: [] });
  assert.ok(all.length >= 1);
  // Put an earnings date within 5 bars after the first trade's entry → that entry is skipped.
  const firstIdx = all[0].idx;
  const earnings = [bars[firstIdx + 2].date];
  const filtered = enumerateFreshTrades(bars, { rsiMax: 15, earningsDates: earnings });
  assert.ok(!filtered.some(t => t.idx === firstIdx), 'pre-earnings entry should be dropped');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-threshold-build.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-threshold-build.mjs`:

```js
// scripts/coil-threshold-build.mjs
// Enumerate Coil-faithful trades (fresh, one-per-ticker, forward-earnings-filtered) across
// the universe at the widest study threshold (RSI<15), simulate each, tag its RSI bucket,
// and chrono-split. Reuses loadBars, MEANREV_UNIVERSE, chronoSplit.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilderRSI } from './coil-meanrev-signal.mjs';
import { loadBars } from './coil-eventstudy-bars.mjs';
import { MEANREV_UNIVERSE, chronoSplit } from './coil-eventstudy-build.mjs';
import { entryFiresAt, simulateTrade } from './coil-threshold-exitsim.mjs';
import { earningsWithinNext5 } from './coil-threshold-earnings.mjs';

const MIN_BARS = 210, WIDEST_RSI = 15;

export function bucketOf(rsi2) {
  if (rsi2 < 5) return '[0,5)';
  if (rsi2 < 8) return '[5,8)';
  if (rsi2 < 10) return '[8,10)';
  if (rsi2 < 15) return '[10,15)';
  return null;
}

// One-per-ticker enumeration: open a trade on a fresh signal, then skip all signals until
// it exits (mirrors Coil's no-averaging / no-same-day-reentry). earningsDates excludes
// entries with forward earnings within 5 trading bars.
export function enumerateFreshTrades(bars, { rsiMax = WIDEST_RSI, earningsDates = [] } = {}) {
  const closes = bars.map(b => b.close);
  const barDates = bars.map(b => b.date);
  const trades = [];
  let openUntil = -1; // last bar index occupied by an open sim position
  for (let i = MIN_BARS - 1; i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    if (!entryFiresAt(closes, i, rsiMax)) continue;
    if (earningsWithinNext5(barDates, i, earningsDates)) continue;
    const rsi2 = wilderRSI(closes.slice(0, i + 1), 2);
    const t = simulateTrade(bars, i);
    trades.push({ idx: i, date: barDates[i], rsi2, bucket: bucketOf(rsi2), ...t });
    openUntil = i + (t.censored ? bars.length : t.daysHeld);
    if (t.censored) break; // no usable bars left
  }
  return trades;
}

// CLI: node scripts/coil-threshold-build.mjs [--earnings data/lab/coil-earnings-dates.json] [--out ...]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const earnPath = flag('--earnings', join(root, 'data', 'lab', 'coil-earnings-dates.json'));
    const out = flag('--out', join(root, 'data', 'lab', 'coil-threshold-instances.json'));
    let earningsByTicker = {};
    if (existsSync(earnPath)) earningsByTicker = JSON.parse(readFileSync(earnPath, 'utf8'));
    else process.stderr.write(`WARNING: ${earnPath} missing — running WITHOUT the earnings filter (verdict not trustworthy until present)\n`);
    const rows = [];
    let usedEarnings = 0;
    for (const t of MEANREV_UNIVERSE) {
      const bars = loadBars(root, t);
      if (bars.length < MIN_BARS) continue;
      const ed = earningsByTicker[t] || [];
      if (ed.length) usedEarnings += 1;
      for (const tr of enumerateFreshTrades(bars, { earningsDates: ed })) rows.push({ ticker: t, ...tr });
    }
    const completed = rows.filter(r => !r.censored);
    const { all } = chronoSplit(completed);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(all, null, 2));
    process.stdout.write(JSON.stringify({
      out, universe: MEANREV_UNIVERSE.length, tickers_with_earnings: usedEarnings,
      trades_total: rows.length, completed: completed.length, censored: rows.length - completed.length,
    }, null, 2) + '\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-threshold-build.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-threshold-build.mjs scripts/coil-threshold-build.test.mjs
git commit -m "feat(coil-threshold): fresh-signal enumeration + bucketed build"
```

---

## Task 5: Metrics & bootstrap

**Files:**
- Create: `scripts/coil-threshold-metrics.mjs`
- Test: `scripts/coil-threshold-metrics.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-threshold-metrics.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFriction, winRate, profitFactor, mean, median, bootstrapMeanCI, bootstrapDiffCI } from './coil-threshold-metrics.mjs';

test('applyFriction subtracts round-trip bps from gross', () => {
  assert.ok(Math.abs(applyFriction(0.05, 20) - (0.05 - 0.002)) < 1e-12); // 20bps = 0.002
});

test('winRate / profitFactor / mean / median', () => {
  const r = [0.10, -0.05, 0.20, -0.10];
  assert.equal(winRate(r), 0.5);
  assert.ok(Math.abs(profitFactor(r) - (0.30 / 0.15)) < 1e-9);
  assert.ok(Math.abs(mean(r) - 0.0375) < 1e-9);
  assert.equal(median([1, 3, 2]), 2);
});

test('bootstrapMeanCI is deterministic under a fixed seed and brackets the mean', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ date: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, net: (i % 5) - 2 }));
  const a = bootstrapMeanCI(rows, { iterations: 2000, seed: 7, blockSessions: 15 });
  const b = bootstrapMeanCI(rows, { iterations: 2000, seed: 7, blockSessions: 15 });
  assert.deepEqual(a, b);
  assert.ok(a.lo <= a.mean && a.mean <= a.hi);
});

test('bootstrapDiffCI returns a CI on (groupB - groupA) mean net', () => {
  const A = Array.from({ length: 100 }, (_, i) => ({ date: `2026-02-${String(1 + (i % 28)).padStart(2, '0')}`, net: 0.00 }));
  const B = Array.from({ length: 100 }, (_, i) => ({ date: `2026-02-${String(1 + (i % 28)).padStart(2, '0')}`, net: 0.05 }));
  const ci = bootstrapDiffCI(A, B, { iterations: 2000, seed: 1, blockSessions: 15 });
  assert.ok(ci.lo > 0 && ci.mean > 0); // B clearly higher
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-threshold-metrics.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-threshold-metrics.mjs`:

```js
// scripts/coil-threshold-metrics.mjs
// Pure metrics + date-block bootstrap (resamples whole calendar blocks so same-day,
// beta-correlated trades move together; block length >> the 5-day hold).

export function applyFriction(grossReturn, bps) { return grossReturn - bps / 10000; }
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function winRate(returns) { return returns.length ? returns.filter(r => r > 0).length / returns.length : null; }
export function profitFactor(returns) {
  let g = 0, l = 0;
  for (const r of returns) { if (r > 0) g += r; else l += -r; }
  return l === 0 ? (g > 0 ? Infinity : null) : g / l;
}

// mulberry32 — reproducible PRNG (same idiom as coil-eventstudy-score.mjs).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Group rows ({date, net}) into consecutive date-blocks of `blockSessions` distinct dates.
function blocksByDate(rows, blockSessions) {
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const blocks = [];
  for (let i = 0; i < dates.length; i += blockSessions) {
    const set = new Set(dates.slice(i, i + blockSessions));
    blocks.push(rows.filter(r => set.has(r.date)));
  }
  return blocks;
}
const pctOf = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))];

// 95% CI on the mean net of a single group, by date-block resampling.
export function bootstrapMeanCI(rows, { iterations = 10000, seed = 1234, blockSessions = 15 } = {}) {
  const usable = rows.filter(r => Number.isFinite(r.net));
  const blocks = blocksByDate(usable, blockSessions);
  const rng = mulberry32(seed);
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    const sample = [];
    for (let b = 0; b < blocks.length; b += 1) sample.push(...blocks[(rng() * blocks.length) | 0]);
    const m = mean(sample.map(r => r.net));
    if (m != null) means.push(m);
  }
  means.sort((a, b) => a - b);
  return { n: usable.length, mean: mean(usable.map(r => r.net)), lo: pctOf(means, 2.5), hi: pctOf(means, 97.5), iters: means.length };
}

// 95% CI on (mean net of B - mean net of A), resampling a shared date-block index so both
// groups move together on the same dates.
export function bootstrapDiffCI(rowsA, rowsB, { iterations = 10000, seed = 1234, blockSessions = 15 } = {}) {
  const A = rowsA.filter(r => Number.isFinite(r.net));
  const B = rowsB.filter(r => Number.isFinite(r.net));
  const dates = [...new Set([...A, ...B].map(r => r.date))].sort();
  const blockIdx = [];
  for (let i = 0; i < dates.length; i += blockSessions) blockIdx.push(new Set(dates.slice(i, i + blockSessions)));
  const aBlocks = blockIdx.map(set => A.filter(r => set.has(r.date)));
  const bBlocks = blockIdx.map(set => B.filter(r => set.has(r.date)));
  const rng = mulberry32(seed);
  const diffs = [];
  for (let it = 0; it < iterations; it += 1) {
    const aS = [], bS = [];
    for (let k = 0; k < blockIdx.length; k += 1) { const j = (rng() * blockIdx.length) | 0; aS.push(...aBlocks[j]); bS.push(...bBlocks[j]); }
    const ma = mean(aS.map(r => r.net)), mb = mean(bS.map(r => r.net));
    if (ma != null && mb != null) diffs.push(mb - ma);
  }
  diffs.sort((a, b) => a - b);
  const md = (mean(B.map(r => r.net)) ?? 0) - (mean(A.map(r => r.net)) ?? 0);
  return { nA: A.length, nB: B.length, mean: md, lo: pctOf(diffs, 2.5), hi: pctOf(diffs, 97.5), iters: diffs.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-threshold-metrics.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-threshold-metrics.mjs scripts/coil-threshold-metrics.test.mjs
git commit -m "feat(coil-threshold): metrics + date-block bootstrap CIs"
```

---

## Task 6: Pre-registration artifact (hash-locked)

**Files:**
- Create: `scripts/coil-threshold-prereg.mjs`
- Test: `scripts/coil-threshold-prereg.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-threshold-prereg.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThresholdPrereg, verifyThresholdPrereg } from './coil-threshold-prereg.mjs';

test('buildThresholdPrereg is self-consistent and hash-verifies', () => {
  const a = buildThresholdPrereg({ trainN: 100, holdoutN: 100, createdUtc: '2026-06-05T00:00:00.000Z' });
  assert.equal(a.primary_T, 8);
  assert.deepEqual(a.secondary_T, [10, 15]);
  assert.equal(a.expected_outcome, 'KEEP');
  assert.equal(verifyThresholdPrereg(a).ok, true);
});

test('verifyThresholdPrereg fails on tampering', () => {
  const a = buildThresholdPrereg({ trainN: 100, holdoutN: 100, createdUtc: '2026-06-05T00:00:00.000Z' });
  a.friction_bps.representative = 9999;
  assert.equal(verifyThresholdPrereg(a).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-threshold-prereg.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-threshold-prereg.mjs`:

```js
// scripts/coil-threshold-prereg.mjs
// Hash-locked pre-registration for the RSI-threshold study. Mirrors the self-hash idiom of
// coil-eventstudy-prereg.mjs (reusing its sha256short).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256short } from './coil-eventstudy-prereg.mjs';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => k !== 'artifact_hash')
      .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function buildThresholdPrereg({ trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'loosening Coil RSI(2)<5 does NOT improve risk-adjusted edge (expected null)',
    buckets: ['[0,5)', '[5,8)', '[8,10)', '[10,15)'],
    primary_T: 8,
    secondary_T: [10, 15],
    exit_model: { stop_pct: 7, rsi_exit: 70, sma5_cross: true, max_hold_days: 5, stop: 'intraday_gap_honest' },
    entry_fill: 'signal_day_close',
    earnings_filter: 'forward 5 trading bars, FMP stable earnings-calendar',
    enumeration: 'fresh signals only (one open trade per ticker)',
    friction_bps: { optimistic: 10, representative: 20, stress: 30 },
    decision_metric: 'friction-net return at 20bps',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    decision_rule: {
      gate1: 'holdout marginal-fill (present at T=8, absent at T=5) net-return 95% CI lo > 0',
      gate2: 'holdout portfolio net return(T=8) > net return(T=5) AND maxDD(T=8) <= maxDD(T=5)*1.1',
      verdict: 'CONSIDER iff gate1 AND gate2 else KEEP; UNDERPOWERED if marginal n < 30',
    },
    power_floor_n: 30,
    expected_outcome: 'KEEP',
    split: 'chronological 50/50',
    counts: { train_n: trainN, holdout_n: holdoutN },
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyThresholdPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/coil-threshold-prereg.mjs --instances data/lab/coil-threshold-instances.json --out data/lab/coil-threshold-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-threshold-instances.json'), 'utf8'));
    const trainN = inst.filter(r => r.split === 'train').length;
    const holdoutN = inst.filter(r => r.split === 'holdout').length;
    const a = buildThresholdPrereg({ trainN, holdoutN });
    const out = flag('--out', 'data/lab/coil-threshold-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-threshold-prereg.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-threshold-prereg.mjs scripts/coil-threshold-prereg.test.mjs
git commit -m "feat(coil-threshold): hash-locked pre-registration"
```

---

## Task 7: Portfolio simulator

**Files:**
- Create: `scripts/coil-threshold-portfolio.mjs`
- Test: `scripts/coil-threshold-portfolio.test.mjs`

The sim is event-driven: each trade (precomputed by `simulateTrade`) occupies a slot from its
entry date to its exit date. Walk dates ascending; free positions whose exit date has passed;
then fill open slots from that day's firing candidates (sorted by RSI asc), ≤4 positions, one
per ticker. Non-compounding fixed-fractional accounting (each trade contributes
`sizePct × net` to a cumulative return curve), so variants compare apples-to-apples.

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-threshold-portfolio.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulatePortfolio, marginalFills } from './coil-threshold-portfolio.mjs';

// Minimal candidate-trade fixtures: {ticker, date, rsi2, exitDate, net}
const trades = [
  { ticker: 'A', date: '2026-01-02', rsi2: 2, exitDate: '2026-01-05', net: 0.03 },
  { ticker: 'B', date: '2026-01-02', rsi2: 3, exitDate: '2026-01-06', net: 0.01 },
  { ticker: 'C', date: '2026-01-02', rsi2: 4, exitDate: '2026-01-06', net: -0.02 },
  { ticker: 'D', date: '2026-01-02', rsi2: 4.5, exitDate: '2026-01-06', net: 0.04 },
  { ticker: 'E', date: '2026-01-02', rsi2: 6, exitDate: '2026-01-06', net: 0.05 }, // shallow
];

test('cap binds at 4 — the 5th (shallow) candidate is not taken at T=5', () => {
  const r = simulatePortfolio(trades, { T: 5, maxPositions: 4, sizePct: 0.05 });
  assert.equal(r.fills.length, 4);
  assert.ok(!r.fills.some(f => f.ticker === 'E'));
});

test('looser T=8 admits E only when a slot is free', () => {
  // Drop D so only 3 sub-5 names exist on the day → E can fill the 4th slot at T=8.
  const t2 = trades.filter(t => t.ticker !== 'D');
  const r5 = simulatePortfolio(t2, { T: 5, maxPositions: 4, sizePct: 0.05 });
  const r8 = simulatePortfolio(t2, { T: 8, maxPositions: 4, sizePct: 0.05 });
  assert.ok(!r5.fills.some(f => f.ticker === 'E'));
  assert.ok(r8.fills.some(f => f.ticker === 'E'));
  const marg = marginalFills(r5.fills, r8.fills);
  assert.deepEqual(marg.map(f => f.ticker), ['E']);
});

test('one-per-ticker: a name already open is not re-entered', () => {
  const dup = [
    { ticker: 'A', date: '2026-01-02', rsi2: 2, exitDate: '2026-01-09', net: 0.03 },
    { ticker: 'A', date: '2026-01-05', rsi2: 2, exitDate: '2026-01-12', net: 0.10 },
  ];
  const r = simulatePortfolio(dup, { T: 5, maxPositions: 4, sizePct: 0.05 });
  assert.equal(r.fills.length, 1);
});

test('reports total net return and max drawdown', () => {
  const r = simulatePortfolio(trades, { T: 5, maxPositions: 4, sizePct: 0.05 });
  assert.ok(typeof r.totalNet === 'number');
  assert.ok(r.maxDrawdown <= 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-threshold-portfolio.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-threshold-portfolio.mjs`:

```js
// scripts/coil-threshold-portfolio.mjs
// Event-driven Coil portfolio sim. Input: candidate trades {ticker,date,rsi2,exitDate,net}
// (net already friction-adjusted). Honors max positions, one-per-ticker, most-oversold-first,
// and an RSI threshold T. Non-compounding fixed-fractional accounting for fair cross-T compare.

export function simulatePortfolio(trades, { T = 5, maxPositions = 4, sizePct = 0.05, deployCap = 0.24 } = {}) {
  const eligible = trades.filter(t => t.rsi2 < T);
  const dates = [...new Set(eligible.map(t => t.date))].sort();
  const byDate = new Map(dates.map(d => [d, []]));
  for (const t of eligible) byDate.get(t.date).push(t);

  const open = [];           // [{ticker, exitDate, net}]
  const fills = [];          // trades actually entered
  let cum = 0; const curve = []; // cumulative net return after each realized exit
  const realizeUpTo = (date) => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].exitDate <= date) { cum += sizePct * open[i].net; curve.push(cum); open.splice(i, 1); }
    }
  };

  for (const date of dates) {
    realizeUpTo(date);                                   // free slots whose exit has passed
    const held = new Set(open.map(p => p.ticker));
    const candidates = byDate.get(date).slice().sort((a, b) => a.rsi2 - b.rsi2);
    for (const c of candidates) {
      if (open.length >= maxPositions) break;
      if (open.length * sizePct + sizePct > deployCap + 1e-9) break;
      if (held.has(c.ticker)) continue;
      open.push({ ticker: c.ticker, exitDate: c.exitDate, net: c.net });
      held.add(c.ticker);
      fills.push(c);
    }
  }
  // realize any still-open positions at the end
  for (const p of open) { cum += sizePct * p.net; curve.push(cum); }

  let peak = 0, maxDrawdown = 0;
  for (const v of curve) { peak = Math.max(peak, v); maxDrawdown = Math.min(maxDrawdown, v - peak); }
  return { T, fills, totalNet: cum, maxDrawdown, nTrades: fills.length, curve };
}

// Trades present in `loose` fills but absent from `base` fills, keyed by ticker+date.
export function marginalFills(baseFills, looseFills) {
  const key = (f) => `${f.ticker}@${f.date}`;
  const baseKeys = new Set(baseFills.map(key));
  return looseFills.filter(f => !baseKeys.has(key(f)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-threshold-portfolio.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-threshold-portfolio.mjs scripts/coil-threshold-portfolio.test.mjs
git commit -m "feat(coil-threshold): event-driven portfolio simulator"
```

---

## Task 8: Scorer — kill-gate, frozen holdout pass, decision rule

**Files:**
- Create: `scripts/coil-threshold-score.mjs`
- Test: `scripts/coil-threshold-score.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-threshold-score.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketStats, decide } from './coil-threshold-score.mjs';

function trade(bucket, net, date, split) { return { bucket, grossReturn: net, date, split, censored: false }; }

test('bucketStats reports n and net metrics per bucket at 20bps', () => {
  const rows = [trade('[0,5)', 0.05, '2026-01-02', 'train'), trade('[0,5)', -0.03, '2026-01-03', 'train'), trade('[5,8)', 0.01, '2026-01-02', 'train')];
  const s = bucketStats(rows, { frictionBps: 20 });
  assert.equal(s['[0,5)'].n, 2);
  assert.equal(s['[5,8)'].n, 1);
  assert.ok(s['[0,5)'].meanNet < 0.05); // friction applied
});

test('decide returns KEEP when gate1 fails', () => {
  const v = decide({
    gate1: { lo: -0.01, mean: 0.0, hi: 0.02, nB: 50 },
    portfolioBase: { totalNet: 0.10, maxDrawdown: -0.05 },
    portfolioT: { totalNet: 0.08, maxDrawdown: -0.06 },
    powerFloorN: 30,
  });
  assert.equal(v.verdict, 'KEEP');
});

test('decide returns UNDERPOWERED when marginal n is below the floor', () => {
  const v = decide({
    gate1: { lo: 0.001, mean: 0.02, hi: 0.05, nB: 12 },
    portfolioBase: { totalNet: 0.10, maxDrawdown: -0.05 },
    portfolioT: { totalNet: 0.12, maxDrawdown: -0.05 },
    powerFloorN: 30,
  });
  assert.equal(v.verdict, 'UNDERPOWERED');
});

test('decide returns CONSIDER only when both gates pass with adequate n', () => {
  const v = decide({
    gate1: { lo: 0.005, mean: 0.02, hi: 0.05, nB: 60 },
    portfolioBase: { totalNet: 0.10, maxDrawdown: -0.05 },
    portfolioT: { totalNet: 0.13, maxDrawdown: -0.052 }, // DD within 1.1x of -0.05
    powerFloorN: 30,
  });
  assert.equal(v.verdict, 'CONSIDER');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-threshold-score.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-threshold-score.mjs`:

```js
// scripts/coil-threshold-score.mjs
// Phase-1 per-bucket descriptive stats + the pre-registered decision logic. The CLI wires
// build instances + portfolio sim into a train kill-gate, a single frozen holdout pass, and
// the verdict; it refuses to score the holdout on a prereg-hash mismatch.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFriction, mean, median, winRate, profitFactor, bootstrapMeanCI, bootstrapDiffCI } from './coil-threshold-metrics.mjs';

const BUCKETS = ['[0,5)', '[5,8)', '[8,10)', '[10,15)'];

export function bucketStats(rows, { frictionBps = 20 } = {}) {
  const out = {};
  for (const b of BUCKETS) {
    const r = rows.filter(x => x.bucket === b && !x.censored && Number.isFinite(x.grossReturn));
    const nets = r.map(x => applyFriction(x.grossReturn, frictionBps));
    out[b] = {
      n: r.length, winRate: winRate(nets), meanNet: mean(nets), medianNet: median(nets),
      profitFactor: profitFactor(nets),
    };
  }
  return out;
}

// Pre-registered verdict. gate1 = CI on marginal-fill net (from bootstrapMeanCI); portfolio*
// = {totalNet, maxDrawdown}. UNDERPOWERED takes precedence when the marginal sample is thin.
export function decide({ gate1, portfolioBase, portfolioT, powerFloorN = 30 }) {
  if (!gate1 || gate1.nB < powerFloorN) {
    return { verdict: 'UNDERPOWERED', reason: `marginal n=${gate1?.nB ?? 0} < ${powerFloorN}` };
  }
  const g1 = gate1.lo > 0;
  const g2 = portfolioT.totalNet > portfolioBase.totalNet
    && portfolioT.maxDrawdown >= portfolioBase.maxDrawdown * 1.1; // DD is negative; *1.1 deepens the floor
  if (g1 && g2) return { verdict: 'CONSIDER', reason: 'both gates passed', gate1: g1, gate2: g2 };
  return { verdict: 'KEEP', reason: `gate1=${g1} gate2=${g2}`, gate1: g1, gate2: g2 };
}
```

(Note on gate2 drawdown sign: drawdowns are ≤ 0; "≤ baseline ×1.1" in the spec means "no
more than 10% deeper," i.e. `portfolioT.maxDrawdown >= portfolioBase.maxDrawdown * 1.1`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-threshold-score.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Append the CLI orchestration (train kill-gate → frozen holdout pass → report)**

Append to `scripts/coil-threshold-score.mjs`:

```js
// CLI: node scripts/coil-threshold-score.mjs \
//   --instances data/lab/coil-threshold-instances.json --prereg data/lab/coil-threshold-prereg.json \
//   --out docs/lab/coil-rsi-threshold-RESULTS.md
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyThresholdPrereg } = await import('./coil-threshold-prereg.mjs');
    const { simulatePortfolio, marginalFills } = await import('./coil-threshold-portfolio.mjs');
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-threshold-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/coil-threshold-prereg.json'), 'utf8'));
    const v = verifyThresholdPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const bps = prereg.friction_bps.representative;
    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };
    const T = prereg.primary_T;

    // Each instance already carries its simulated trade; build portfolio candidate rows.
    const toCandidates = (rows) => rows.map(r => ({
      ticker: r.ticker, date: r.date, rsi2: r.rsi2,
      exitDate: r.exitDate ?? r.date, net: applyFriction(r.grossReturn, bps),
    }));

    const train = inst.filter(r => r.split === 'train');
    const holdout = inst.filter(r => r.split === 'holdout');

    // --- TRAIN kill-gate (in-sample, free to inspect): shallow buckets vs [0,5) diff-CI ---
    const trainStats = bucketStats(train, { frictionBps: bps });
    const baseTrainNets = train.filter(r => r.bucket === '[0,5)').map(r => ({ date: r.date, net: applyFriction(r.grossReturn, bps) }));
    const killGate = {};
    for (const b of ['[5,8)', '[8,10)', '[10,15)']) {
      const bn = train.filter(r => r.bucket === b).map(r => ({ date: r.date, net: applyFriction(r.grossReturn, bps) }));
      killGate[b] = bn.length ? bootstrapDiffCI(baseTrainNets, bn, boot) : null; // (bucket - baseline)
    }
    const killed = ['[5,8)', '[8,10)', '[10,15)'].every(b => killGate[b] && killGate[b].hi < 0);

    // --- FROZEN HOLDOUT pass (read once): Phase-1 stats + Phase-2 fills + decision ---
    const holdoutStats = bucketStats(holdout, { frictionBps: bps });
    const candBase = toCandidates(holdout);
    const pBase = simulatePortfolio(candBase, { T: 5 });
    const pT = simulatePortfolio(candBase, { T });
    const marg = marginalFills(pBase.fills, pT.fills);            // present at T, absent at 5
    const gate1 = bootstrapMeanCI(marg.map(f => ({ date: f.date, net: f.net })), boot);
    const verdict = killed
      ? { verdict: 'KEEP', reason: 'train kill-gate: shallow buckets all worse than [0,5)' }
      : decide({ gate1, portfolioBase: pBase, portfolioT: pT, powerFloorN: prereg.power_floor_n });

    // Secondary T (exploratory only — never gates the verdict)
    const secondary = {};
    for (const st of prereg.secondary_T) {
      const p = simulatePortfolio(candBase, { T: st });
      secondary[st] = { totalNet: p.totalNet, maxDrawdown: p.maxDrawdown, nTrades: p.nTrades };
    }

    const capUB = (() => {
      const dates = [...new Set(train.concat(holdout).map(r => r.date))];
      const sub5ByDate = {};
      for (const r of train.concat(holdout)) if (r.bucket === '[0,5)') sub5ByDate[r.date] = (sub5ByDate[r.date] || 0) + 1;
      const lt4 = dates.filter(d => (sub5ByDate[d] || 0) < 4).length;
      return { lt4_fraction: dates.length ? lt4 / dates.length : null, note: 'UPPER BOUND — ignores prior-day open slots; realized count is the Phase-2 fill log' };
    })();

    const md = renderResults({ prereg, T, bps, trainStats, holdoutStats, killGate, killed, pBase, pT, marg, gate1, verdict, secondary, capUB });
    const out = flag('--out', 'docs/lab/coil-rsi-threshold-RESULTS.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason}). Wrote ${out}\n`);
  }
}

function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(2) + '%'; }
function renderResults(d) {
  const L = [];
  L.push('# Coil RSI-Threshold Backtest — Results', '');
  L.push(`**Verdict: ${d.verdict.verdict}** — ${d.verdict.reason}`, '');
  L.push(`Primary T=${d.T}; friction ${d.bps}bps (representative); prereg hash \`${d.prereg.artifact_hash}\`. Expected: KEEP.`, '');
  L.push('## Per-bucket net edge (holdout)', '', '| bucket | n | win | meanNet | PF |', '|---|---|---|---|---|');
  for (const b of ['[0,5)', '[5,8)', '[8,10)', '[10,15)']) {
    const s = d.holdoutStats[b]; L.push(`| ${b} | ${s.n} | ${pct(s.winRate)} | ${pct(s.meanNet)} | ${s.profitFactor == null ? 'n/a' : s.profitFactor.toFixed(2)} |`);
  }
  L.push('', '## Train kill-gate (shallow − [0,5) diff-CI)', '');
  for (const b of ['[5,8)', '[8,10)', '[10,15)']) { const g = d.killGate[b]; L.push(`- ${b}: ${g ? `mean ${pct(g.mean)} CI [${pct(g.lo)}, ${pct(g.hi)}]` : 'n/a'}`); }
  L.push(`- killed: ${d.killed}`, '');
  L.push('## Phase-2 portfolio (holdout)', '', `- T=5 baseline: net ${pct(d.pBase.totalNet)}, maxDD ${pct(d.pBase.maxDrawdown)}, trades ${d.pBase.nTrades}`);
  L.push(`- T=${d.T}: net ${pct(d.pT.totalNet)}, maxDD ${pct(d.pT.maxDrawdown)}, trades ${d.pT.nTrades}`);
  L.push(`- marginal fills (T=${d.T} vs 5): n=${d.marg.length}, net CI [${pct(d.gate1.lo)}, ${pct(d.gate1.hi)}] (mean ${pct(d.gate1.mean)})`, '');
  L.push('### Secondary thresholds (exploratory only — not decision-gating)', '');
  for (const st of Object.keys(d.secondary)) { const s = d.secondary[st]; L.push(`- T=${st}: net ${pct(s.totalNet)}, maxDD ${pct(s.maxDrawdown)}, trades ${s.nTrades}`); }
  L.push('', `## Cap-binding (Phase-1 UPPER BOUND)`, '', `- fraction of dates with <4 sub-5 names: ${pct(d.capUB.lt4_fraction)} — ${d.capUB.note}`, '');
  L.push('## Limitations', '', '- Survivorship (today\'s universe; conservative re: false CONSIDER). Daily-close fills. Regime sizing held normal. Earnings = forward 5-trading-bar FMP filter.');
  return L.join('\n');
}
```

Note: `coil-threshold-build.mjs` must persist `exitDate` per trade for the portfolio sim.
Update `enumerateFreshTrades` to add `exitDate: t.censored ? null : barDates[i + t.daysHeld]` to
each pushed trade (one line), and add a test asserting `exitDate` equals the bar date at
`idx + daysHeld`. (Do this as part of this task's Step 5 edit since the scorer depends on it.)

- [ ] **Step 6: Add `exitDate` to build, with a test, then run both suites**

In `scripts/coil-threshold-build.mjs`, change the push line to include `exitDate`:

```js
const exitDate = t.censored ? null : barDates[i + t.daysHeld];
trades.push({ idx: i, date: barDates[i], rsi2, bucket: bucketOf(rsi2), exitDate, ...t });
```

Append to `scripts/coil-threshold-build.test.mjs`:

```js
test('enumerateFreshTrades records exitDate at idx+daysHeld', () => {
  const bars = seriesWithTwoDips();
  for (const tr of enumerateFreshTrades(bars, { rsiMax: 15, earningsDates: [] })) {
    if (!tr.censored) assert.equal(tr.exitDate, bars[tr.idx + tr.daysHeld].date);
  }
});
```

Run: `node --test scripts/coil-threshold-build.test.mjs scripts/coil-threshold-score.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/coil-threshold-score.mjs scripts/coil-threshold-score.test.mjs scripts/coil-threshold-build.mjs scripts/coil-threshold-build.test.mjs
git commit -m "feat(coil-threshold): scorer (kill-gate, frozen holdout, decision rule)"
```

---

## Task 9: Run the experiment + write results (integration)

**Files:** generates `data/lab/coil-earnings-dates.json`, `data/lab/coil-threshold-instances.json`, `data/lab/coil-threshold-prereg.json`, `docs/lab/coil-rsi-threshold-RESULTS.md`.

This task runs the pipeline on real data and produces the verdict. It is a sequence of CLI
runs, not a TDD cycle.

- [ ] **Step 1: Full unit suite green**

Run: `node --test scripts/coil-threshold-*.test.mjs`
Expected: all PASS, 0 fail.

- [ ] **Step 2: Fetch historical earnings (needs FMP key)**

The key lives in the root `.env` (not exported). In PowerShell, load it then run:
```
node scripts/coil-threshold-earnings.mjs --from 2019-01-01 --to 2026-06-05
```
(If FMP is unavailable, the script exits 3 with a clear message; the build will warn and run
without the filter — do NOT trust the verdict in that case; re-run when FMP is back.)
Expected: `wrote data/lab/coil-earnings-dates.json (N tickers)`.

- [ ] **Step 3: Build instances, then the prereg, then score**

```
node scripts/coil-threshold-build.mjs
node scripts/coil-threshold-prereg.mjs
node scripts/coil-threshold-score.mjs
```
Expected: build prints trade counts; prereg prints a hash; score prints `VERDICT: ...` and
writes `docs/lab/coil-rsi-threshold-RESULTS.md`.

- [ ] **Step 4: Sanity-check the results**

Read `docs/lab/coil-rsi-threshold-RESULTS.md`. Confirm: per-bucket `n` are populated and the
holdout marginal-fill `n` is reported (flagging UNDERPOWERED if <30); the verdict is one of
KEEP / CONSIDER / UNDERPOWERED; secondary T rows are labeled exploratory. Spot-check that the
`[0,5)` bucket has the most trades and that shallow buckets have progressively fewer.

- [ ] **Step 5: Commit the artifacts + results**

```bash
git add data/lab/coil-earnings-dates.json data/lab/coil-threshold-instances.json data/lab/coil-threshold-prereg.json docs/lab/coil-rsi-threshold-RESULTS.md
git commit -m "feat(coil-threshold): run backtest — prereg, instances, results"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** Phase-1 bucket edge (Tasks 4,5,8), Phase-2 portfolio sim (Task 7,8),
faithful exit sim with verified intraday stop (Task 2), entry-at-close + monotonic
`entryFiresAt` (Task 1), forward earnings filter via FMP (Task 3), fresh-signal dedup (Task 4),
date-block bootstrap ≥15 sessions + difference-CIs (Task 5), hash-locked prereg + primary T=8
+ secondary exploratory (Task 6), train kill-gate + single frozen holdout pass + decision rule
+ power floor + cap-binding upper bound (Task 8), run + RESULTS.md + disclosed limitations
(Task 9). Read-only throughout (no live files touched).

**Placeholder scan:** none — every code step is complete; the only "fill-in" is the real
data the experiment produces (Task 9), which is the point.

**Type consistency:** the trade object (`ticker,idx,date,rsi2,bucket,entry,exit,exitReason,
daysHeld,grossReturn,censored,exitDate,split`) is produced in Task 2/4 and consumed unchanged
in Tasks 7–8; portfolio candidates (`ticker,date,rsi2,exitDate,net`) and the gate1/portfolio
shapes match between `simulatePortfolio`/`bootstrapMeanCI` and `decide`.
