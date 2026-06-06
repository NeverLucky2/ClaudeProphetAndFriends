# EMA-Pullback Pre-Registered Backtest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pre-registered, lab-only backtest that decides whether a daily mechanical EMA-pullback strategy earns a fleet slot, gated on **beta-adjusted residual alpha** (not raw return).

**Architecture:** Node `.mjs` modules under `scripts/ema-*.mjs`, mirroring the Coil threshold/timeout study split (indicators → signal → exit-sim → build → beta → prereg → score). Pure functions are unit-tested with `node:test`; CLIs at the bottom of each file (guarded by the `import.meta.url === argv1` idiom) wire them into artifacts under `data/lab/` and a verdict in `docs/lab/ema-pullback-RESULTS.md`. Reuses `coil-threshold-metrics.mjs` (friction, date-block bootstrap), `coil-eventstudy-bars.mjs` (`parseBarsWithVolume`, `etDate`), `coil-eventstudy-build.mjs` (`chronoSplit`, `MEANREV_UNIVERSE`), and `coil-eventstudy-prereg.mjs` (`sha256short`).

**Tech Stack:** Node ≥18 ESM (`node:test`, `node:fs`, `node:crypto`), FMP `historical-price-eod/full` for bars. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-06-ema-pullback-backtest-design.md`

**Commit cadence:** per-task commits during the build (TDD frequent commits) on branch `ema-pullback-backtest`; squash to one commit when merging to local main (per workflow-preferences). All feature artifacts are read-only lab code — no deployment, no flags.

**Decision-config constants (locked — copied verbatim into the prereg in Task 8):**
- EMA primary `fast=25, slow=75`; pullback window `W=10`; `kStop=1.5`, `kTarget=1.5` (ATR-mult); `maxHold=10` bars.
- Friction round-trip bps: optimistic 10 / **representative 20 (decision)** / stress 30.
- Short borrow annual bps: ETF universe 50, large-cap cut 200.
- Benchmarks: SPY and QQQ (gate must pass against **both**).
- Split: chronological 50/50. Bootstrap: date-block 15 sessions, 10000 iters, seed 1234, CI [2.5, 97.5].
- Power floor: holdout trades ≥ 100 AND distinct entry dates ≥ 40.
- Warmup: discard first 250 bars per ticker; EMA SMA-seeded.

---

## Task 1: EMA universe module

**Files:**
- Create: `scripts/ema-universe.mjs`
- Test: `scripts/ema-universe.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMA_ETF_UNIVERSE, EMA_LARGECAP_UNIVERSE, BENCHMARKS, allStudyTickers } from './ema-universe.mjs';

test('ETF universe = Turtle macro basket + equity index ETFs, deduped', () => {
  for (const t of ['TLT', 'GLD', 'USO', 'DBC', 'UUP', 'EEM', 'EFA', 'SPY', 'QQQ', 'IWM']) {
    assert.ok(EMA_ETF_UNIVERSE.includes(t), `${t} missing`);
  }
  assert.equal(new Set(EMA_ETF_UNIVERSE).size, EMA_ETF_UNIVERSE.length, 'no dupes');
  assert.ok(!EMA_ETF_UNIVERSE.includes('DIA'), 'DIA excluded by default (near-redundant with SPY)');
});

test('large-cap cut reuses the Coil MEANREV universe', () => {
  assert.ok(EMA_LARGECAP_UNIVERSE.includes('AAPL') && EMA_LARGECAP_UNIVERSE.length >= 70);
});

test('benchmarks are SPY and QQQ', () => {
  assert.deepEqual(BENCHMARKS, ['SPY', 'QQQ']);
});

test('allStudyTickers unions everything incl. benchmarks, deduped', () => {
  const all = allStudyTickers();
  assert.ok(all.includes('SPY') && all.includes('AAPL') && all.includes('TLT'));
  assert.equal(new Set(all).size, all.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-universe.test.mjs`
Expected: FAIL — cannot find module `./ema-universe.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ema-universe.mjs
// Study universes for the EMA-pullback backtest. The ETF cut combines the Turtle
// multi-asset macro basket (mostly NON-equity → equity-beta ≈ 0, so raw ≈ alpha there)
// with the three liquid equity index ETFs (where beta-adjustment does the real work).
import { MEANREV_UNIVERSE } from './coil-eventstudy-build.mjs';

const TURTLE_MACRO = [
  'TLT', 'IEF', 'TIP', 'GLD', 'SLV', 'USO', 'UNG',
  'DBC', 'DBA', 'DBB', 'UUP', 'FXE', 'FXY', 'EEM', 'EFA',
];
const EQUITY_INDEX = ['SPY', 'QQQ', 'IWM']; // DIA omitted: near-redundant with SPY

export const EMA_ETF_UNIVERSE = [...new Set([...TURTLE_MACRO, ...EQUITY_INDEX])];
export const EMA_LARGECAP_UNIVERSE = [...MEANREV_UNIVERSE];
export const BENCHMARKS = ['SPY', 'QQQ'];

export function allStudyTickers() {
  return [...new Set([...EMA_ETF_UNIVERSE, ...EMA_LARGECAP_UNIVERSE, ...BENCHMARKS])];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-universe.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ema-universe.mjs scripts/ema-universe.test.mjs
git commit -m "feat(ema): study universes (Turtle macro + equity index + large-cap)"
```

---

## Task 2: Indicators — EMA, Wilder ATR(14), CCI(20)

**Files:**
- Create: `scripts/ema-indicators.mjs`
- Test: `scripts/ema-indicators.test.mjs`

All three return arrays aligned to `bars`/`closes` (index `i` = value as-of bar `i`), with `null` until enough history. EMA is SMA-seeded at index `period-1` then iterated — no lookahead.

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-indicators.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ema, atrWilder, cci } from './ema-indicators.mjs';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('ema: null before seed, SMA seed at period-1, then recursive', () => {
  const c = [1, 2, 3, 4, 5];
  const e = ema(c, 3);
  assert.equal(e[0], null);
  assert.equal(e[1], null);
  approx(e[2], 2);                 // SMA(1,2,3)=2 seed
  const k = 2 / (3 + 1);
  approx(e[3], (4 - 2) * k + 2);   // 2.5
  approx(e[4], (5 - e[3]) * k + e[3]);
});

test('atrWilder: seed = SMA of first `period` true ranges at index period', () => {
  // TR uses prev close, so first TR is at index 1; ATR seed lands at index `period`.
  const bars = [
    { high: 10, low: 9, close: 9.5 }, { high: 11, low: 9.5, close: 10.5 },
    { high: 12, low: 10, close: 11 }, { high: 11.5, low: 10.5, close: 11 },
  ];
  const a = atrWilder(bars, 2);
  assert.equal(a[0], null);
  assert.equal(a[1], null);        // need `period` TRs first
  assert.ok(a[2] > 0 && a[3] > 0); // seeded then smoothed
});

test('cci: 0 at flat series midpoint, finite when dispersed', () => {
  const flat = Array.from({ length: 25 }, () => ({ high: 10, low: 10, close: 10 }));
  const cf = cci(flat, 20);
  assert.equal(cf[24], 0);         // mean deviation 0 → defined as 0
  const up = Array.from({ length: 25 }, (_, i) => ({ high: i + 1, low: i, close: i + 0.5 }));
  assert.ok(Number.isFinite(cci(up, 20)[24]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-indicators.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ema-indicators.mjs
// Pure technical indicators for the EMA-pullback study. Each returns an array aligned to
// the input (value[i] uses only bars[0..i] — no lookahead). null until enough history.

export function ema(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += closes[i];
  seed /= period;
  out[period - 1] = seed;
  const k = 2 / (period + 1);
  let prev = seed;
  for (let i = period; i < closes.length; i += 1) {
    prev = (closes[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

function trueRanges(bars) {
  const tr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i += 1) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return tr;
}

export function atrWilder(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  const tr = trueRanges(bars);
  if (bars.length <= period) return out;
  let seed = 0;
  for (let i = 1; i <= period; i += 1) seed += tr[i]; // TR[1..period]
  seed /= period;
  out[period] = seed;
  let prev = seed;
  for (let i = period + 1; i < bars.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function cci(bars, period = 20) {
  const out = new Array(bars.length).fill(null);
  const tp = bars.map(b => (b.high + b.low + b.close) / 3);
  for (let i = period - 1; i < bars.length; i += 1) {
    let sma = 0;
    for (let j = i - period + 1; j <= i; j += 1) sma += tp[j];
    sma /= period;
    let md = 0;
    for (let j = i - period + 1; j <= i; j += 1) md += Math.abs(tp[j] - sma);
    md /= period;
    out[i] = md === 0 ? 0 : (tp[i] - sma) / (0.015 * md);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-indicators.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ema-indicators.mjs scripts/ema-indicators.test.mjs
git commit -m "feat(ema): EMA, Wilder ATR(14), CCI(20) indicators (TDD)"
```

---

## Task 3: Bar fetch (FMP) + lab loader

**Files:**
- Create: `scripts/ema-bars.mjs` (pure transform `fmpEodToBars` + `loadEmaBars`)
- Create: `scripts/ema-fetch-bars.mjs` (network CLI only)
- Test: `scripts/ema-bars.test.mjs`

Bars are cached **separately** from the production `data/bar-cache/` (deep 2006 backfill must not pollute the live bots) at `data/lab/ema-bar-cache/{TICKER}.json` as `{ written_at, bars: [...] }`, reusing `parseBarsWithVolume` so the loader returns the same `{date,open,high,low,close,volume}` shape as `loadBars`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fmpEodToBars, loadEmaBars } from './ema-bars.mjs';

test('fmpEodToBars maps FMP historical-price-eod/full rows to bar objects, ascending', () => {
  const payload = [
    { date: '2008-01-03', open: 2, high: 3, low: 1, close: 2.5, volume: 100 },
    { date: '2008-01-02', open: 1, high: 2, low: 0.5, close: 1.5, volume: 90 },
  ];
  const bars = fmpEodToBars(payload);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].date, '2008-01-02');     // ascending
  assert.deepEqual(
    { o: bars[1].open, h: bars[1].high, l: bars[1].low, c: bars[1].close, v: bars[1].volume },
    { o: 2, h: 3, l: 1, c: 2.5, v: 100 });
});

test('loadEmaBars reads {written_at,bars} from the lab cache dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'emabars-'));
  mkdirSync(join(root, 'data', 'lab', 'ema-bar-cache'), { recursive: true });
  writeFileSync(join(root, 'data', 'lab', 'ema-bar-cache', 'SPY.json'),
    JSON.stringify({ written_at: '2026-06-06', bars: [
      { Timestamp: '2008-01-02T00:00:00Z', Open: 1, High: 2, Low: 0.5, Close: 1.5, Volume: 9 },
    ] }));
  const bars = loadEmaBars(root, 'SPY');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].close, 1.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-bars.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ema-bars.mjs
// Lab bar cache for the EMA study, isolated from the production data/bar-cache so deep
// 2006 backfill never touches the live bots. Reuses parseBarsWithVolume for the shape.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBarsWithVolume } from './coil-eventstudy-bars.mjs';

export const EMA_CACHE_SUBDIR = join('data', 'lab', 'ema-bar-cache');

// FMP historical-price-eod/full returns a flat array of {date, open, high, low, close, volume}.
export function fmpEodToBars(payload) {
  const raw = Array.isArray(payload) ? payload : (payload.historical || payload.bars || []);
  return raw
    .filter(r => r && r.date && typeof r.close === 'number')
    .map(r => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function loadEmaBars(projectRoot, ticker) {
  const path = join(projectRoot, EMA_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return parseBarsWithVolume(obj);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-bars.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the fetch CLI (no unit test — network side-effect; mirrors the FMP idiom from the screener-migration scripts)**

```js
// scripts/ema-fetch-bars.mjs
// One-shot backfill: FMP historical-price-eod/full → data/lab/ema-bar-cache/{TICKER}.json.
// Requires FMP_API_KEY in the environment (source project-root .env first; see memory).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fmpEodToBars, EMA_CACHE_SUBDIR } from './ema-bars.mjs';
import { allStudyTickers } from './ema-universe.mjs';

const FROM = '2006-06-01';
const KEY = process.env.FMP_API_KEY;

async function fetchOne(ticker, to) {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  return fmpEodToBars(await res.json());
}

{
  if (!KEY) { process.stderr.write('FMP_API_KEY not set — source project-root .env first.\n'); process.exit(2); }
  const root = process.cwd();
  const to = new Date().toISOString().slice(0, 10);
  mkdirSync(join(root, EMA_CACHE_SUBDIR), { recursive: true });
  for (const t of allStudyTickers()) {
    try {
      const bars = await fetchOne(t, to);
      writeFileSync(join(root, EMA_CACHE_SUBDIR, `${t}.json`), JSON.stringify({ written_at: new Date().toISOString(), bars: bars.map(b => ({ Timestamp: `${b.date}T00:00:00Z`, Open: b.open, High: b.high, Low: b.low, Close: b.close, Volume: b.volume })) }));
      process.stdout.write(`${t}: ${bars.length} bars\n`);
    } catch (e) { process.stderr.write(`${t}: ${e.message}\n`); }
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add scripts/ema-bars.mjs scripts/ema-fetch-bars.mjs scripts/ema-bars.test.mjs
git commit -m "feat(ema): isolated lab bar cache + FMP EOD backfill CLI"
```

---

## Task 4: Signal predicate — welded, lookahead-free, long & short

**Files:**
- Create: `scripts/ema-signal.mjs`
- Test: `scripts/ema-signal.test.mjs`

`emaPullbackFiresAt(bars, idx, { fast, slow, W, direction })` returns `true` iff the §1 welded rules hold at `idx` for `direction` (`+1` long, `-1` short). Precompute EMA arrays once via `signalContext(bars, fast, slow)` to avoid O(n²).

Welding (long): `idx` is the FIRST bar to close above `EMA_fast[idx]` since the most-recent bar `d ∈ [idx-W, idx-1]` whose close was below `min(EMA_fast[d], EMA_slow[d])` (compared **as of `d`**), with NO bar between `d` and `idx` closing above `EMA_fast`. Trend `EMA_fast[idx] > EMA_slow[idx]`. Short = mirror.

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-signal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalContext, emaPullbackFiresAt, isStalePair } from './ema-signal.mjs';

// Build a long uptrend, force a single coherent dip-then-reclaim, assert it fires once.
function bar(c) { return { high: c + 0.5, low: c - 0.5, close: c, open: c }; }

test('long fires on coherent dip-below-both then first reclaim of fast', () => {
  // rising series → fast>slow; insert a dip below both, then a reclaim close above fast.
  const closes = [];
  for (let i = 0; i < 120; i += 1) closes.push(100 + i);          // strong uptrend
  closes.push(80);                                                 // dip below both EMAs (one bar)
  closes.push(225);                                                // reclaim: close back above fast
  const bars = closes.map(bar);
  const ctx = signalContext(bars, 25, 75);
  const reclaimIdx = bars.length - 1;
  assert.equal(emaPullbackFiresAt(bars, reclaimIdx, { fast: 25, slow: 75, W: 10, direction: 1, ctx }), true);
});

test('does NOT fire on a stale dip with an intervening reclaim', () => {
  const closes = [];
  for (let i = 0; i < 120; i += 1) closes.push(100 + i);
  closes.push(80);    // dip (idx 120)
  closes.push(225);   // intervening reclaim (idx 121) — consumes the dip
  closes.push(224);   // chop above fast
  closes.push(226);   // today: NOT the first reclaim since the dip
  const bars = closes.map(bar);
  const ctx = signalContext(bars, 25, 75);
  const today = bars.length - 1;
  assert.equal(emaPullbackFiresAt(bars, today, { fast: 25, slow: 75, W: 10, direction: 1, ctx }), false);
  assert.equal(isStalePair(bars, today, { fast: 25, slow: 75, W: 10, direction: 1, ctx }), true);
});

test('does not fire when trend is not intact (fast<=slow)', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 200 - i); // downtrend → fast<slow
  const bars = closes.map(bar);
  const ctx = signalContext(bars, 25, 75);
  assert.equal(emaPullbackFiresAt(bars, 119, { fast: 25, slow: 75, W: 10, direction: 1, ctx }), false);
});

test('short mirrors: fires on pop-above-both then first close back below fast', () => {
  const closes = [];
  for (let i = 0; i < 120; i += 1) closes.push(300 - i);          // downtrend → fast<slow
  closes.push(260);                                                // pop above both
  closes.push(150);                                                // close back below fast
  const bars = closes.map(bar);
  const ctx = signalContext(bars, 25, 75);
  assert.equal(emaPullbackFiresAt(bars, bars.length - 1, { fast: 25, slow: 75, W: 10, direction: -1, ctx }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-signal.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ema-signal.mjs
// Deterministic EMA-pullback signal. Episode-welded (the dip and the reclaim must be the
// same pullback) and lookahead-free (the historical dip close is compared to the EMA as of
// that bar, never as of today). direction: +1 long, -1 short.
import { ema } from './ema-indicators.mjs';

export function signalContext(bars, fast, slow) {
  const closes = bars.map(b => b.close);
  return { fast: ema(closes, fast), slow: ema(closes, slow), closes };
}

function ready(ctx, i) { return ctx.fast[i] != null && ctx.slow[i] != null; }

// First reclaim of EMA_fast at idx in `direction`, with EMA ready and trend intact.
function reclaimedAt(ctx, i, direction) {
  if (!ready(ctx, i) || !ready(ctx, i - 1)) return false;
  const c = ctx.closes[i], cPrev = ctx.closes[i - 1];
  if (direction === 1) return c > ctx.fast[i] && cPrev <= ctx.fast[i - 1] && ctx.fast[i] > ctx.slow[i];
  return c < ctx.fast[i] && cPrev >= ctx.fast[i - 1] && ctx.fast[i] < ctx.slow[i];
}

// Most-recent bar in [idx-W, idx-1] whose close pierced BOTH EMAs (as of that bar), in the
// pullback direction (long: below min; short: above max). Returns its index or -1.
function lastPierceBar(ctx, idx, W, direction) {
  for (let d = idx - 1; d >= Math.max(0, idx - W); d -= 1) {
    if (!ready(ctx, d)) continue;
    const c = ctx.closes[d];
    if (direction === 1 && c < Math.min(ctx.fast[d], ctx.slow[d])) return d;
    if (direction === -1 && c > Math.max(ctx.fast[d], ctx.slow[d])) return d;
  }
  return -1;
}

// True iff today is a reclaim, there is a qualifying pierce in window, but an INTERVENING
// reclaim already consumed it (so today is a stale pairing). Reported for the sanity count.
export function isStalePair(bars, idx, { fast, slow, W, direction, ctx }) {
  const cx = ctx || signalContext(bars, fast, slow);
  if (!reclaimedAt(cx, idx, direction)) return false;
  const d = lastPierceBar(cx, idx, W, direction);
  if (d < 0) return false;
  for (let j = d + 1; j < idx; j += 1) if (reclaimedAt(cx, j, direction)) return true;
  return false;
}

export function emaPullbackFiresAt(bars, idx, { fast, slow, W, direction, ctx }) {
  const cx = ctx || signalContext(bars, fast, slow);
  if (!reclaimedAt(cx, idx, direction)) return false;
  const d = lastPierceBar(cx, idx, W, direction);
  if (d < 0) return false;
  for (let j = d + 1; j < idx; j += 1) if (reclaimedAt(cx, j, direction)) return false; // welded: first reclaim only
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-signal.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ema-signal.mjs scripts/ema-signal.test.mjs
git commit -m "feat(ema): welded, lookahead-free pullback signal (long+short)"
```

---

## Task 5: Exit simulation — asymmetric gap model + net/borrow

**Files:**
- Create: `scripts/ema-exitsim.mjs`
- Test: `scripts/ema-exitsim.test.mjs`

`simulateEmaTrade(bars, entryIdx, { direction, atr, kStop, kTarget, maxHold })` fills at `close[entryIdx]`. **Asymmetric gaps:** stop is a market exit (adverse gap → fill at the open, worse); target is a limit (favorable gap → fill at the target price, never the better open). Same-bar both-touched → booked as the stop (loss) and flagged. Returns `{ entry, exit, exitReason, daysHeld, grossReturn, sameBarBoth, censored }` where `grossReturn` is **direction-signed** (positive = profitable trade). `netWithCosts(grossReturn, { direction, daysHeld, frictionBps, borrowBpsAnnual })` subtracts friction and (shorts only) borrow.

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-exitsim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateEmaTrade, netWithCosts } from './ema-exitsim.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('long stop gap-through fills at the open (worse than stop)', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },     // entry idx 0
    { open: 90, high: 91, low: 89, close: 90 }];                    // gaps below stop(=97)
  const t = simulateEmaTrade(bars, 0, { direction: 1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 5 });
  assert.equal(t.exitReason, 'stop');
  approx(t.exit, 90);                       // open, not the 97 stop
  approx(t.grossReturn, (90 - 100) / 100);
});

test('long target gap-up fills at the target, NOT the better open', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },
    { open: 110, high: 111, low: 109, close: 110 }];                // gaps above target(=103)
  const t = simulateEmaTrade(bars, 0, { direction: 1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 5 });
  assert.equal(t.exitReason, 'target');
  approx(t.exit, 103);                       // capped at target, not 110
  approx(t.grossReturn, (103 - 100) / 100);
});

test('same-bar both touched → booked as loss + flagged', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },
    { open: 100, high: 104, low: 96, close: 100 }];                 // hits target(103) AND stop(97)
  const t = simulateEmaTrade(bars, 0, { direction: 1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 5 });
  assert.equal(t.exitReason, 'stop');
  assert.equal(t.sameBarBoth, true);
  assert.ok(t.grossReturn < 0);
});

test('short profit is positive grossReturn (direction-signed)', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },
    { open: 97, high: 98, low: 96, close: 97 }];                    // short target(=97) hit
  const t = simulateEmaTrade(bars, 0, { direction: -1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 5 });
  assert.equal(t.exitReason, 'target');
  approx(t.grossReturn, (100 - 97) / 100);   // positive: price fell
});

test('time stop exits at close when no bracket hit', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },
    { open: 100, high: 100.5, low: 99.5, close: 100.2 }];
  const t = simulateEmaTrade(bars, 0, { direction: 1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 1 });
  assert.equal(t.exitReason, 'time_stop');
  approx(t.exit, 100.2);
});

test('netWithCosts: shorts pay borrow, longs do not', () => {
  const g = 0.01;
  approx(netWithCosts(g, { direction: 1, daysHeld: 10, frictionBps: 20, borrowBpsAnnual: 200 }), g - 0.002);
  approx(netWithCosts(g, { direction: -1, daysHeld: 10, frictionBps: 20, borrowBpsAnnual: 200 }),
    g - 0.002 - (0.02 * 10 / 252));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-exitsim.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ema-exitsim.mjs
// Exit simulation with the §3 asymmetric gap model. grossReturn is direction-signed:
// positive = the trade made money, for both longs and shorts. No lookahead.

function result(entry, exit, reason, k, direction, sameBarBoth) {
  const raw = (exit - entry) / entry;
  return { entry, exit, exitReason: reason, daysHeld: k, grossReturn: direction * raw, sameBarBoth, censored: false };
}

export function simulateEmaTrade(bars, entryIdx, { direction, atr, kStop, kTarget, maxHold }) {
  const entry = bars[entryIdx].close;
  const stop = direction === 1 ? entry - kStop * atr : entry + kStop * atr;
  const target = direction === 1 ? entry + kTarget * atr : entry - kTarget * atr;
  for (let k = 1; k <= maxHold; k += 1) {
    const j = entryIdx + k;
    if (j >= bars.length) return { entry, exit: null, exitReason: null, daysHeld: k - 1, grossReturn: null, sameBarBoth: false, censored: true };
    const b = bars[j];
    const stopHit = direction === 1 ? b.low <= stop : b.high >= stop;
    const tgtHit = direction === 1 ? b.high >= target : b.low <= target;
    if (stopHit && tgtHit) {
      // conservative: stop wins the same-bar tie; stop is a market exit → gap-honest fill
      const fill = direction === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return result(entry, fill, 'stop', k, direction, true);
    }
    if (stopHit) {
      const fill = direction === 1 ? Math.min(b.open, stop) : Math.max(b.open, stop);
      return result(entry, fill, 'stop', k, direction, false);
    }
    if (tgtHit) {
      // limit: never credited the better gapped-open → fill exactly at target
      return result(entry, target, 'target', k, direction, false);
    }
    if (k === maxHold) return result(entry, b.close, 'time_stop', k, direction, false);
  }
  return { entry, exit: null, exitReason: null, daysHeld: maxHold, grossReturn: null, sameBarBoth: false, censored: true };
}

export function netWithCosts(grossReturn, { direction, daysHeld, frictionBps, borrowBpsAnnual }) {
  let net = grossReturn - frictionBps / 10000;
  if (direction === -1) net -= (borrowBpsAnnual / 10000) * (daysHeld / 252);
  return net;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-exitsim.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ema-exitsim.mjs scripts/ema-exitsim.test.mjs
git commit -m "feat(ema): exit sim with asymmetric stop(market)/target(limit) gaps + borrow"
```

---

## Task 6: Trade enumeration + build CLI

**Files:**
- Create: `scripts/ema-build.mjs`
- Test: `scripts/ema-build.test.mjs`

`enumerateEmaTrades(bars, { fast, slow, W, kStop, kTarget, maxHold, warmup })` walks bars from `warmup`, opens a trade on the first fresh long-OR-short signal, computes `atr = atrWilder(bars,14)[idx]`, simulates, then skips to the exit bar (one-open-per-ticker). Emits `{ idx, date, exitDate, direction, atr, ...trade }`. The CLI runs the **primary config** over both universes, tags `cut` (etf|largecap), `chronoSplit`s, writes `data/lab/ema-instances.json`, and prints the stale-pair count.

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateEmaTrades } from './ema-build.mjs';

function bar(c) { return { date: `d${c}`, open: c, high: c + 1, low: c - 1, close: c }; }

test('enumerates non-overlapping trades with direction + exitDate', () => {
  const closes = [];
  for (let i = 0; i < 120; i += 1) closes.push(100 + i);
  closes.push(80); closes.push(225);          // coherent long setup ~ idx 121
  for (let i = 0; i < 10; i += 1) closes.push(226 + i);
  const bars = closes.map((c, i) => ({ date: `2008-${String(i).padStart(3, '0')}`, open: c, high: c + 1, low: c - 1, close: c }));
  const trades = enumerateEmaTrades(bars, { fast: 25, slow: 75, W: 10, kStop: 1.5, kTarget: 1.5, maxHold: 10, warmup: 80 });
  assert.ok(trades.length >= 1);
  for (const t of trades) {
    assert.ok(t.direction === 1 || t.direction === -1);
    assert.ok(t.idx >= 80);
    assert.ok(t.exitDate === null || t.exitDate > t.date);
  }
  // non-overlap: each trade starts after the prior one's exit index
  for (let i = 1; i < trades.length; i += 1) assert.ok(trades[i].idx > trades[i - 1].idx + trades[i - 1].daysHeld - 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-build.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ema-build.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signalContext, emaPullbackFiresAt, isStalePair } from './ema-signal.mjs';
import { atrWilder } from './ema-indicators.mjs';
import { simulateEmaTrade } from './ema-exitsim.mjs';
import { loadEmaBars } from './ema-bars.mjs';
import { EMA_ETF_UNIVERSE, EMA_LARGECAP_UNIVERSE } from './ema-universe.mjs';
import { chronoSplit } from './coil-eventstudy-build.mjs';

export function enumerateEmaTrades(bars, { fast, slow, W, kStop, kTarget, maxHold, warmup }) {
  const ctx = signalContext(bars, fast, slow);
  const atr = atrWilder(bars, 14);
  const trades = [];
  let stalePairs = 0;
  let openUntil = -1;
  for (let i = Math.max(warmup, 1); i < bars.length; i += 1) {
    if (i <= openUntil) continue;
    let direction = 0;
    if (emaPullbackFiresAt(bars, i, { fast, slow, W, direction: 1, ctx })) direction = 1;
    else if (emaPullbackFiresAt(bars, i, { fast, slow, W, direction: -1, ctx })) direction = -1;
    else {
      if (isStalePair(bars, i, { fast, slow, W, direction: 1, ctx }) || isStalePair(bars, i, { fast, slow, W, direction: -1, ctx })) stalePairs += 1;
      continue;
    }
    if (atr[i] == null) continue;
    const t = simulateEmaTrade(bars, i, { direction, atr: atr[i], kStop, kTarget, maxHold });
    const exitDate = t.censored ? null : bars[i + t.daysHeld].date;
    trades.push({ idx: i, date: bars[i].date, exitDate, direction, atr: atr[i], ...t });
    openUntil = i + (t.censored ? bars.length : t.daysHeld);
    if (t.censored) break;
  }
  trades.stalePairs = stalePairs;
  return trades;
}

// CLI: node scripts/ema-build.mjs [--out data/lab/ema-instances.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const cfg = { fast: 25, slow: 75, W: 10, kStop: 1.5, kTarget: 1.5, maxHold: 10, warmup: 250 };
    const cuts = [['etf', EMA_ETF_UNIVERSE], ['largecap', EMA_LARGECAP_UNIVERSE]];
    const rows = [];
    let stale = 0;
    for (const [cut, uni] of cuts) {
      for (const t of uni) {
        const bars = loadEmaBars(root, t);
        if (bars.length < cfg.warmup + 30) continue;
        const trades = enumerateEmaTrades(bars, cfg);
        stale += trades.stalePairs;
        for (const tr of trades) if (!tr.censored) rows.push({ ticker: t, cut, ...tr });
      }
    }
    const { all } = chronoSplit(rows);
    const out = flag('--out', join(root, 'data', 'lab', 'ema-instances.json'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(all, null, 2));
    process.stdout.write(JSON.stringify({ out, trades: rows.length, stale_pairs_rejected: stale }, null, 2) + '\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-build.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/ema-build.mjs scripts/ema-build.test.mjs
git commit -m "feat(ema): one-per-ticker long+short trade enumeration + build CLI"
```

---

## Task 7: Beta module — OLS beta + sign-aware residual

**Files:**
- Create: `scripts/ema-beta.mjs`
- Test: `scripts/ema-beta.test.mjs`

`olsBeta(assetRets, benchRets)` = slope of asset on benchmark. `benchReturnOverWindow(benchByDate, entryDate, exitDate)` = `(close[exit]/close[entry]) - 1`. `residual(net, { direction, beta, benchRet })` = `net - direction * beta * benchRet`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-beta.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { olsBeta, benchReturnOverWindow, residual } from './ema-beta.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('olsBeta recovers a known slope', () => {
  const bench = [0.01, -0.02, 0.03, -0.01, 0.02];
  const asset = bench.map(x => 2 * x + 0.001);   // beta 2
  approx(olsBeta(asset, bench), 2, 1e-6);
});

test('benchReturnOverWindow uses entry/exit closes', () => {
  const byDate = new Map([['2020-01-02', { close: 100 }], ['2020-01-10', { close: 110 }]]);
  approx(benchReturnOverWindow(byDate, '2020-01-02', '2020-01-10'), 0.1);
});

test('residual subtracts sign-aware market exposure', () => {
  approx(residual(0.05, { direction: 1, beta: 1.2, benchRet: 0.03 }), 0.05 - 1.2 * 0.03);
  // short: gains when market falls → exposure is -beta → residual = net + beta*benchRet
  approx(residual(0.05, { direction: -1, beta: 1.2, benchRet: 0.03 }), 0.05 + 1.2 * 0.03);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-beta.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ema-beta.mjs
// Per-instrument beta (estimated on TRAIN returns, frozen) and sign-aware per-trade
// market-neutralized residual. residual = net - direction * beta * benchRet.

export function olsBeta(assetRets, benchRets) {
  const n = Math.min(assetRets.length, benchRets.length);
  if (n < 2) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i += 1) { mx += benchRets[i]; my += assetRets[i]; }
  mx /= n; my /= n;
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i += 1) { const dx = benchRets[i] - mx; cov += dx * (assetRets[i] - my); varx += dx * dx; }
  return varx === 0 ? 0 : cov / varx;
}

export function dailyReturns(bars) {
  const r = [];
  for (let i = 1; i < bars.length; i += 1) r.push({ date: bars[i].date, ret: bars[i].close / bars[i - 1].close - 1 });
  return r;
}

export function benchReturnOverWindow(benchByDate, entryDate, exitDate) {
  const a = benchByDate.get(entryDate), b = benchByDate.get(exitDate);
  if (!a || !b) return null;
  return b.close / a.close - 1;
}

export function residual(net, { direction, beta, benchRet }) {
  return net - direction * beta * benchRet;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-beta.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ema-beta.mjs scripts/ema-beta.test.mjs
git commit -m "feat(ema): OLS beta + sign-aware market-neutralized residual"
```

---

## Task 8: Hash-locked pre-registration

**Files:**
- Create: `scripts/ema-prereg.mjs`
- Test: `scripts/ema-prereg.test.mjs`

Mirror `coil-threshold-prereg.mjs` exactly (reuse `sha256short` + the `stable()` serializer idiom). Encodes the full locked config + gates from the spec.

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmaPrereg, verifyEmaPrereg } from './ema-prereg.mjs';

test('prereg hashes stably and verifies', () => {
  const a = buildEmaPrereg({ trainN: 200, holdoutN: 200, createdUtc: '2026-06-06T00:00:00Z' });
  assert.equal(verifyEmaPrereg(a).ok, true);
  assert.equal(a.expected_outcome, 'REJECT');
  assert.deepEqual(a.benchmarks, ['SPY', 'QQQ']);
});

test('tampering breaks the hash', () => {
  const a = buildEmaPrereg({ trainN: 1, holdoutN: 1, createdUtc: '2026-06-06T00:00:00Z' });
  a.primary.fast = 9;
  assert.equal(verifyEmaPrereg(a).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-prereg.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ema-prereg.mjs
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

export function buildEmaPrereg({ trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'a daily mechanical EMA-pullback has no positive BETA-ADJUSTED edge net of costs (expected null)',
    primary: { fast: 25, slow: 75, W: 10, kStop: 1.5, kTarget: 1.5, maxHold: 10, cci: false, width_filter: false },
    grid_train_only: {
      ema_pairs: [[10, 30], [20, 50], [50, 150]], W: [5, 20], kStop: [1.0, 2.0],
      kTarget: [1.0, 3.0], maxHold: [5, 20], width_filter: [true], cci: [true],
    },
    entry_fill: 'signal_day_close',
    atr: 'wilder_14_asof_t',
    exit_gap_model: 'stop=market(gap_worse); target=limit(capped_at_target); same_bar_both=stop_loss',
    friction_bps: { optimistic: 10, representative: 20, stress: 30 },
    borrow_bps_annual: { etf: 50, largecap: 200 },
    decision_metric: 'beta-adjusted residual at 20bps (+ short borrow)',
    benchmarks: ['SPY', 'QQQ'],
    beta: 'per-instrument OLS on TRAIN daily returns, frozen',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    decision_rule: {
      gate_alpha: 'holdout beta-adjusted residual mean/trade 95% CI lo > 0 vs BOTH SPY and QQQ',
      gate_robust: 'train beta-adjusted residual mean > 0 (alpha sign-consistency)',
      verdict: 'KEEP-CANDIDATE iff gate_alpha AND gate_robust else REJECT; UNDERPOWERED if holdout trades < 100 OR distinct dates < 40',
    },
    power_floor: { trades: 100, distinct_dates: 40 },
    author_window_decontam: 'score trailing 24 months (2024-06..2026-06) separately',
    split: 'chronological 50/50',
    counts: { train_n: trainN, holdout_n: holdoutN },
    expected_outcome: 'REJECT',
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyEmaPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/ema-prereg.mjs --instances data/lab/ema-instances.json --out data/lab/ema-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/ema-instances.json'), 'utf8'));
    const a = buildEmaPrereg({
      trainN: inst.filter(r => r.split === 'train').length,
      holdoutN: inst.filter(r => r.split === 'holdout').length,
    });
    const out = flag('--out', 'data/lab/ema-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-prereg.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ema-prereg.mjs scripts/ema-prereg.test.mjs
git commit -m "feat(ema): hash-locked pre-registration (beta-adjusted gates)"
```

---

## Task 9: Scoring, gates, verdict + RESULTS render

**Files:**
- Create: `scripts/ema-score.mjs`
- Test: `scripts/ema-score.test.mjs`

Pure `decideEma({ alphaSPY, alphaQQQ, trainAlpha, nTrades, distinctDates, powerFloor })` returns the verdict. `alphaSPY`/`alphaQQQ` are `bootstrapMeanCI` outputs over holdout residuals; `trainAlpha` is the train residual mean. The CLI: load instances + prereg (refuse on hash mismatch — copy the `verifyEmaPrereg`/`exit(4)` guard from `coil-threshold-score.mjs:50`), load benchmark bars via `loadEmaBars`, compute per-instrument train betas, attach residuals, evaluate gates, build the report (long/short split raw+adj, per-year alpha, trailing-24mo slice, win rate + avg win/avg loss, same-bar-tie fraction, distinct-date N, and — only if the verdict passes — the §6 downside-beta ballast lens), write `docs/lab/ema-pullback-RESULTS.md`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideEma } from './ema-score.mjs';

const floor = { trades: 100, distinct_dates: 40 };

test('KEEP-CANDIDATE only when both benchmarks pass AND train alpha positive', () => {
  const v = decideEma({
    alphaSPY: { lo: 0.001, n: 200 }, alphaQQQ: { lo: 0.0005, n: 200 },
    trainAlpha: 0.0008, nTrades: 200, distinctDates: 60, powerFloor: floor });
  assert.equal(v.verdict, 'KEEP-CANDIDATE');
});

test('REJECT if either benchmark CI includes zero', () => {
  const v = decideEma({
    alphaSPY: { lo: 0.001, n: 200 }, alphaQQQ: { lo: -0.0002, n: 200 },
    trainAlpha: 0.0008, nTrades: 200, distinctDates: 60, powerFloor: floor });
  assert.equal(v.verdict, 'REJECT');
});

test('REJECT if train alpha not positive (no sign-consistency)', () => {
  const v = decideEma({
    alphaSPY: { lo: 0.001, n: 200 }, alphaQQQ: { lo: 0.001, n: 200 },
    trainAlpha: -0.0001, nTrades: 200, distinctDates: 60, powerFloor: floor });
  assert.equal(v.verdict, 'REJECT');
});

test('UNDERPOWERED takes precedence on thin samples', () => {
  const v = decideEma({
    alphaSPY: { lo: 0.01, n: 50 }, alphaQQQ: { lo: 0.01, n: 50 },
    trainAlpha: 0.01, nTrades: 50, distinctDates: 10, powerFloor: floor });
  assert.equal(v.verdict, 'UNDERPOWERED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-score.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation (pure decision + CLI)**

```js
// scripts/ema-score.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, winRate, bootstrapMeanCI } from './coil-threshold-metrics.mjs';
import { netWithCosts } from './ema-exitsim.mjs';
import { olsBeta, dailyReturns, benchReturnOverWindow, residual } from './ema-beta.mjs';
import { loadEmaBars } from './ema-bars.mjs';
import { indexByDate } from './coil-eventstudy-bars.mjs';

export function decideEma({ alphaSPY, alphaQQQ, trainAlpha, nTrades, distinctDates, powerFloor }) {
  if (nTrades < powerFloor.trades || distinctDates < powerFloor.distinct_dates) {
    return { verdict: 'UNDERPOWERED', reason: `n=${nTrades}/${distinctDates}d < ${powerFloor.trades}/${powerFloor.distinct_dates}d` };
  }
  const gAlpha = alphaSPY.lo > 0 && alphaQQQ.lo > 0;
  const gRobust = trainAlpha > 0;
  if (gAlpha && gRobust) return { verdict: 'KEEP-CANDIDATE', reason: 'alpha CI>0 vs both benchmarks + train sign-consistent', gAlpha, gRobust };
  return { verdict: 'REJECT', reason: `gate_alpha=${gAlpha} gate_robust=${gRobust}`, gAlpha, gRobust };
}

// CLI: node scripts/ema-score.mjs --instances data/lab/ema-instances.json \
//   --prereg data/lab/ema-prereg.json --out docs/lab/ema-pullback-RESULTS.md
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyEmaPrereg } = await import('./ema-prereg.mjs');
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/ema-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/ema-prereg.json'), 'utf8'));
    const v = verifyEmaPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const bps = prereg.friction_bps.representative;
    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };

    // Benchmark bars + train-frozen per-instrument betas.
    const benchBars = {}; const benchByDate = {};
    for (const bm of prereg.benchmarks) { benchBars[bm] = loadEmaBars(root, bm); benchByDate[bm] = new Map(benchBars[bm].map(b => [b.date, b])); }
    const train = inst.filter(r => r.split === 'train');
    const holdout = inst.filter(r => r.split === 'holdout');
    const betas = {}; // betas[bm][ticker]
    for (const bm of prereg.benchmarks) {
      betas[bm] = {};
      const bRets = new Map(dailyReturns(benchBars[bm]).map(x => [x.date, x.ret]));
      const byTicker = {};
      for (const r of train) (byTicker[r.ticker] ||= true);
      for (const tk of Object.keys(byTicker)) {
        const tb = loadEmaBars(root, tk);
        const aR = [], bR = [];
        for (const x of dailyReturns(tb)) { const b = bRets.get(x.date); if (b != null) { aR.push(x.ret); bR.push(b); } }
        betas[bm][tk] = olsBeta(aR, bR);
      }
    }

    const netOf = (r) => netWithCosts(r.grossReturn, { direction: r.direction, daysHeld: r.daysHeld, frictionBps: bps, borrowBpsAnnual: prereg.borrow_bps_annual[r.cut] });
    const residRows = (rows, bm) => rows.map(r => {
      const benchRet = benchReturnOverWindow(benchByDate[bm], r.date, r.exitDate);
      if (benchRet == null) return null;
      return { date: r.date, net: residual(netOf(r), { direction: r.direction, beta: betas[bm][r.ticker] ?? 0, benchRet }) };
    }).filter(Boolean);

    const alphaSPY = bootstrapMeanCI(residRows(holdout, 'SPY'), boot);
    const alphaQQQ = bootstrapMeanCI(residRows(holdout, 'QQQ'), boot);
    const trainAlpha = mean(residRows(train, 'SPY').map(r => r.net)) ?? 0;
    const distinctDates = new Set(holdout.map(r => r.date)).size;
    const verdict = decideEma({ alphaSPY, alphaQQQ, trainAlpha, nTrades: holdout.length, distinctDates, powerFloor: prereg.power_floor });

    // Descriptive splits (raw net) for the report.
    const split = (rows, dir) => { const r = rows.filter(x => dir == null || x.direction === dir).map(netOf); return { n: r.length, win: winRate(r), mean: mean(r), avgWin: mean(r.filter(x => x > 0)), avgLoss: mean(r.filter(x => x < 0)) }; };
    const sameBarTie = holdout.length ? holdout.filter(r => r.sameBarBoth).length / holdout.length : 0;

    const md = renderEmaResults({ prereg, bps, verdict, alphaSPY, alphaQQQ, trainAlpha,
      nLong: split(holdout, 1), nShort: split(holdout, -1), nAll: split(holdout, null),
      distinctDates, sameBarTie });
    const out = flag('--out', join(root, 'docs', 'lab', 'ema-pullback-RESULTS.md'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason}). Wrote ${out}\n`);
  }
}

function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(2) + '%'; }
function renderEmaResults(d) {
  const L = [];
  L.push('# EMA-Pullback Backtest — Results', '');
  L.push(`**Verdict: ${d.verdict.verdict}** — ${d.verdict.reason}`, '');
  L.push(`This tests a **daily mechanical adaptation** (fleet runs daily). The author's claim spans down to 400-tick; a daily REJECT does **not** debunk the intraday strategy. Prereg hash \`${d.prereg.artifact_hash}\`. Decision metric: beta-adjusted residual at ${d.bps}bps. Expected: REJECT.`, '');
  L.push('## Beta-adjusted holdout alpha (PRIMARY gate)', '', '| benchmark | n | mean | CI lo | CI hi |', '|---|---|---|---|---|');
  L.push(`| SPY | ${d.alphaSPY.n} | ${pct(d.alphaSPY.mean)} | ${pct(d.alphaSPY.lo)} | ${pct(d.alphaSPY.hi)} |`);
  L.push(`| QQQ | ${d.alphaQQQ.n} | ${pct(d.alphaQQQ.mean)} | ${pct(d.alphaQQQ.lo)} | ${pct(d.alphaQQQ.hi)} |`);
  L.push(`- train alpha (SPY-hedged) mean: ${pct(d.trainAlpha)}`, '');
  L.push('## Raw net by side (descriptive — NOT the gate)', '', '| side | n | win | mean | avgWin | avgLoss |', '|---|---|---|---|---|---|');
  for (const [k, s] of [['long', d.nLong], ['short', d.nShort], ['all', d.nAll]]) {
    L.push(`| ${k} | ${s.n} | ${pct(s.win)} | ${pct(s.mean)} | ${pct(s.avgWin)} | ${pct(s.avgLoss)} |`);
  }
  L.push('', `- distinct entry dates (effective N): ${d.distinctDates}`);
  L.push(`- same-bar both-touched booked-as-loss: ${pct(d.sameBarTie)}`, '');
  L.push('## Limitations', '', '- Signal-day-close fill; large-cap survivorship flatters longs (discount KEEP on that cut); daily bars only (intraday out of scope); CCI proxy ablation-only; train-frozen betas; flat short borrow; no regime sizing.');
  return L.join('\n');
}
```

> Note for the implementer: the per-year alpha breakdown, the trailing-24-month slice, and the downside-beta ballast lens (only rendered when verdict passes) are additive report rows. Wire them after the gate logic is green by reusing `residRows` filtered by `r.date` ranges (year buckets; `>= '2024-06-01'`) and a `worstDecileBeta(holdoutResid, benchWeeklyRets)` helper. Keep each as its own small commit with a focused test.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-score.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/ema-score.mjs scripts/ema-score.test.mjs
git commit -m "feat(ema): beta-adjusted dual-benchmark gates + RESULTS render"
```

---

## Task 10: Train-only sensitivity grid

**Files:**
- Create: `scripts/ema-grid.mjs`
- Test: `scripts/ema-grid.test.mjs`

`gridConfigs(prereg.grid_train_only)` enumerates the locked grid (one knob varied at a time off the primary — NOT a full cartesian, to limit forking paths). The CLI runs each config's enumeration over **train bars only**, reports raw + SPY-beta-adjusted mean/trade per config to `docs/lab/ema-pullback-grid-RESULTS.md`. Exploratory only — never gates.

- [ ] **Step 1: Write the failing test**

```js
// scripts/ema-grid.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridConfigs } from './ema-grid.mjs';

test('grid varies one knob at a time off the primary (no cartesian blowup)', () => {
  const primary = { fast: 25, slow: 75, W: 10, kStop: 1.5, kTarget: 1.5, maxHold: 10, cci: false, width_filter: false };
  const grid = { ema_pairs: [[10, 30], [20, 50], [50, 150]], W: [5, 20], kStop: [1.0, 2.0], kTarget: [1.0, 3.0], maxHold: [5, 20], width_filter: [true], cci: [true] };
  const cfgs = gridConfigs(primary, grid);
  // 3 ema pairs + 2 W + 2 kStop + 2 kTarget + 2 maxHold + 1 width + 1 cci + 1 primary = 14
  assert.equal(cfgs.length, 14);
  assert.ok(cfgs.some(c => c.label === 'primary'));
  assert.ok(cfgs.every(c => typeof c.fast === 'number'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/ema-grid.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/ema-grid.mjs
// One-knob-at-a-time sensitivity sweep off the locked primary (limits forking paths).
// TRAIN-ONLY and exploratory: it never feeds the verdict.
export function gridConfigs(primary, grid) {
  const cfgs = [{ label: 'primary', ...primary }];
  for (const [f, s] of grid.ema_pairs) cfgs.push({ label: `ema_${f}_${s}`, ...primary, fast: f, slow: s });
  for (const w of grid.W) cfgs.push({ label: `W_${w}`, ...primary, W: w });
  for (const k of grid.kStop) cfgs.push({ label: `kStop_${k}`, ...primary, kStop: k });
  for (const k of grid.kTarget) cfgs.push({ label: `kTarget_${k}`, ...primary, kTarget: k });
  for (const m of grid.maxHold) cfgs.push({ label: `maxHold_${m}`, ...primary, maxHold: m });
  for (const w of grid.width_filter) cfgs.push({ label: `width_${w}`, ...primary, width_filter: w });
  for (const c of grid.cci) cfgs.push({ label: `cci_${c}`, ...primary, cci: c });
  return cfgs;
}
```

> Note: the CLI wiring (run each config's `enumerateEmaTrades` over train bars, beta-adjust via Task 7, write the grid RESULTS table) mirrors the Task 9 CLI structure; `width_filter`/`cci` configs require the corresponding optional filters wired into `enumerateEmaTrades` (gate the EMA-gap-width and the CCI-divergence ablation behind config flags). Add those flags with their own focused tests when implementing the CLI.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/ema-grid.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/ema-grid.mjs scripts/ema-grid.test.mjs
git commit -m "feat(ema): train-only one-knob sensitivity grid"
```

---

## Task 11: Runbook + end-to-end dry run

**Files:**
- Create: `docs/lab/ema-pullback-RUNBOOK.md`
- Modify: none (verification task)

- [ ] **Step 1: Write the runbook**

```markdown
# EMA-Pullback Study — Runbook

Prereq: `set -a; source .env; set +a` (FMP_API_KEY into env — see memory).

1. Backfill bars:  `node scripts/ema-fetch-bars.mjs`
2. Build trades:   `node scripts/ema-build.mjs`
3. Pre-register:   `node scripts/ema-prereg.mjs`   ← MUST run before scoring; locks the hash
4. Score holdout:  `node scripts/ema-score.mjs`     ← refuses on prereg hash mismatch
5. Sensitivity:    `node scripts/ema-grid.mjs`       (exploratory; train-only)

Outputs: data/lab/ema-instances.json, data/lab/ema-prereg.json,
docs/lab/ema-pullback-RESULTS.md, docs/lab/ema-pullback-grid-RESULTS.md.

Order matters: prereg is built from instances, then frozen; score verifies the hash and
reads the holdout exactly once. Re-running build after prereg without re-pregging is fine
(counts only); changing any locked param requires deleting + rebuilding the prereg.
```

- [ ] **Step 2: Run the full unit suite**

Run: `node --test scripts/ema-*.test.mjs`
Expected: PASS (all tasks' tests green).

- [ ] **Step 3: Live dry run (network — needs FMP key + a few minutes)**

Run (PowerShell): `node scripts/ema-fetch-bars.mjs; node scripts/ema-build.mjs; node scripts/ema-prereg.mjs; node scripts/ema-score.mjs; node scripts/ema-grid.mjs`
Expected: a `VERDICT:` line and `docs/lab/ema-pullback-RESULTS.md` written. Confirm the holdout trade count and distinct-date count clear (or honestly fail) the power floor before trusting the verdict.

- [ ] **Step 4: Commit the runbook + results**

```bash
git add docs/lab/ema-pullback-RUNBOOK.md docs/lab/ema-pullback-RESULTS.md docs/lab/ema-pullback-grid-RESULTS.md data/lab/ema-prereg.json
git commit -m "docs(ema): runbook + first frozen-holdout RESULTS"
```

- [ ] **Step 5: Read RESULTS aloud against the spec.** Confirm the verdict line, framing sentence ("daily adaptation, not a debunk"), and that no raw-return number is presented as the gate. If KEEP-CANDIDATE, the §6 ballast lens (downside beta) must be present.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §1 welded/lookahead-free signal → Task 4. §2 fixed primary + grid → Tasks 6/10; long/short split → Tasks 6/9. §3 asymmetric gaps + borrow + tie/magnitude reporting → Tasks 5/9. §4 universe + warmup/seeding + effective-N + lab cache → Tasks 1/2/3/6/9. §5 beta-adjusted dual-benchmark gates + power floor + author-window + regime visibility → Tasks 7/8/9 (per-year + trailing-24mo are flagged additive rows in Task 9). §6 downside-beta ballast lens → Task 9 (verdict-conditional). §7 conventions → throughout. §8 limitations → Task 9 render.
- CCI ablation (§2) → indicator in Task 2, wired as a Task 10 grid flag (ablation-only, off the verdict) — matches spec intent.

**Placeholder scan:** the per-year/trailing-24mo rows and the grid CLI wiring are described as additive steps with explicit reuse instructions rather than full code, because they are mechanical compositions of already-defined, already-tested functions (`residRows`, `enumerateEmaTrades`, `bootstrapMeanCI`); each gets its own focused test+commit at implementation time. All load-bearing logic (indicators, signal welding, asymmetric exits, beta/residual, gates, prereg hash) has complete code + tests.

**Type consistency:** trade record shape `{ ticker, cut, idx, date, exitDate, direction, atr, entry, exit, exitReason, daysHeld, grossReturn, sameBarBoth, censored, split }` is produced in Task 6 and consumed unchanged in Tasks 7/9. `bootstrapMeanCI` rows are `{ date, net }` everywhere (matches `coil-threshold-metrics.mjs`). `decideEma` inputs match the Task 9 CLI call site.
