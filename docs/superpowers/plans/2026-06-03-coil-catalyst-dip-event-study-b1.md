# Coil Catalyst-Dip Event Study — B1 (Price-Signature) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer historically whether Coil-style oversold dips with a *price-signature catalyst footprint* (big gap / volume spike) have materially worse market-adjusted forward returns than clean dips — read-only, pre-registered, no change to Coil's trading.

**Architecture:** A Node lab pipeline over adjusted daily bars: enumerate every historical bar where Coil's entry condition fired (RSI(2)<5 ∧ close>SMA200 ∧ close<SMA5), attach deterministic price-signature features + market-adjusted (vs SPY) lookahead-safe forward returns at +5/+10/+20 sessions, chronologically split, then a hash-locked pre-registration + a new two-sample bootstrap scorer that compares the catalyst-like vs clean buckets' mean forward return. Reuses the stage1 primitives (`forwardReturn`, bar-cache format, prereg hash-lock idiom); the two-sample scorer and instance generation are new.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert`, Alpaca market-data v2 (via the existing `stage1_backfill_bars.mjs`), JSON artifacts under `data/lab/`, report under `docs/lab/`.

**Spec:** `docs/superpowers/specs/2026-06-03-coil-catalyst-dip-measurement-design.md`

---

## File Structure

- `scripts/coil-eventstudy-bars.mjs` — volume-retaining bar loader + date-indexed access + SPY date alignment. **(new)**
- `scripts/coil-meanrev-signal.mjs` — JS port of Coil's Wilder RSI(2) / SMA(200) / SMA(5) + entry predicate + instance enumeration over a ticker's bars. **(new, parity-tested vs the Go algorithm)**
- `scripts/coil-catalyst-features.mjs` — per-instance price-signature features (gap, prior-day return, 5d drawdown, volume ratio, range z-score) + composite. **(new)**
- `scripts/coil-eventstudy-build.mjs` — orchestrator: load bars → enumerate instances → attach features + market-adjusted forward returns → chronological train/holdout split → write `data/lab/coil-instances.json` + feasibility counts. **(new)**
- `scripts/coil-eventstudy-prereg.mjs` — build/verify the hash-locked pre-registration artifact (cut threshold, effect size, SD prior, horizons, benchmark, bootstrap params, verdict rule). **(new, reuses the stage1-prereg hash idiom)**
- `scripts/coil-eventstudy-score.mjs` — two-sample market-adjusted mean-difference scorer + date-block bootstrap CI on the difference + SIGNAL/NO-EFFECT/INSUFFICIENT verdict; refuses to score the holdout on a prereg hash mismatch. **(new)**
- `docs/lab/coil-catalyst-dip-RESULTS.md` — the written verdict + evidence pointers. **(new, produced in Task 8)**

Each `*.mjs` has a sibling `*.test.mjs`. All modules are pure functions + a guarded CLI block (`import.meta.url === argv1` idiom, matching the stage1 scripts).

**Pre-registered constants (frozen here; do not tune to outcomes):**
- Horizons `H ∈ {5, 10, 20}` trading sessions. Entry `open[d+1]`, exit `close[d+H]` (lookahead-safe; reuse `forwardReturn`).
- Composite catalyst score `= volume_ratio × |gap_pct|`. Cut = **top tercile** (≥ 66.667th percentile) of the composite computed over **train** instances → threshold frozen in the prereg, applied to holdout.
- Benchmark = **SPY** (market-adjustment = ticker forward return − SPY forward return over the same calendar window).
- Effect size (material gap) `MDE = 0.010` (1.0 percentage point of market-adjusted forward return). SD prior `= 0.07` per instance (used only for the feasibility power note; never estimated from outcomes).
- Bootstrap = **date-block**, block = 10 sessions, 10000 iterations, seed 1234, two-sided 95% CI ([2.5, 97.5] pct).
- Firing base = price conditions only; the live earnings-within-5d skip is **omitted** in B1 (no historical earnings source while staying FMP-free) — earnings-gap dips remain in the base and are expected to land in the catalyst-like price bucket, so they don't contaminate the clean bucket. Faithfulness to the earnings-skip is restored in B2/live-A.

---

## Task 1: Backfill adjusted historical bars for Coil's universe + SPY

**Files:**
- Use: `scripts/stage1_backfill_bars.mjs` (existing; `adjustment=all`, writes `data/bar-cache/<SYM>_1Day_2021-11-01_2026-05-31.json` with `Volume`).
- Read: `services/meanrev_signal_service.go:82-93` (the 80-name `MeanRevUniverse`).

- [ ] **Step 1: Extract the universe symbol list**

Read `MeanRevUniverse` from `services/meanrev_signal_service.go` (lines 82-93) and form the symbol set = those 80 tickers **plus `SPY`** (benchmark). SPY is already used by Coil for bear-regime, but confirm a bar file exists.

- [ ] **Step 2: Run the backfill**

Run (symbols space-separated; the tool already pins `adjustment=all`, window 2021-11-01..2026-05-31):

```bash
node scripts/stage1_backfill_bars.mjs AAPL MSFT NVDA GOOGL AMZN META TSLA AVGO JPM V WMT UNH MA JNJ XOM PG ORCL HD COST ABBV MRK KO BAC CVX PEP ADBE CRM NFLX AMD TMO ACN LLY MCD ABT CSCO DHR WFC LIN NKE DIS TXN NEE INTU AMGN IBM PM CMCSA RTX QCOM CAT BMY GS UNP AXP LOW BLK SCHW NOW GE AMAT DE SPGI BKNG ISRG MS ADI TJX MDT BA PLD MMC VRTX ADP LMT GILD MO SYK CI MDLZ SO SPY
```

Expected: each line prints `<SYM>: <N> bars -> <file> (2021-11-03..2026-05-29)` with N ≈ 1130 sessions. Names already cached over the full window are still re-fetched (newest `written_at` wins in the loader).

- [ ] **Step 3: Verify coverage**

Run:

```bash
node -e "const{readdirSync,readFileSync}=require('node:fs');const f=readdirSync('data/bar-cache').filter(x=>x.includes('_1Day_2021-11-01_'));const need=['GOOGL','SPY','AAPL'];for(const t of need){const m=f.find(x=>x.startsWith(t+'_1Day_2021-11-01_'));const b=JSON.parse(readFileSync('data/bar-cache/'+m,'utf8')).bars;console.log(t,b.length,b[0].Timestamp.slice(0,10),b.at(-1).Timestamp.slice(0,10),'vol?',typeof b[0].Volume);}"
```

Expected: each prints ~1130 bars, span `2021-11-03 .. 2026-05-29`, `vol? number`. (No commit — this writes data artifacts under `data/bar-cache/`, which is git-ignored cache; nothing to commit.)

---

## Task 2: Volume-retaining bar loader (`coil-eventstudy-bars.mjs`)

**Files:**
- Create: `scripts/coil-eventstudy-bars.mjs`
- Test: `scripts/coil-eventstudy-bars.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBarsWithVolume, indexByDate } from './coil-eventstudy-bars.mjs';

test('parseBarsWithVolume keeps OHLCV and sorts ascending by ET date', () => {
  const obj = { bars: [
    { Timestamp: '2022-01-04T05:00:00Z', Open: 2, High: 3, Low: 1, Close: 2.5, Volume: 100 },
    { Timestamp: '2022-01-03T05:00:00Z', Open: 1, High: 2, Low: 0.5, Close: 1.5, Volume: 200 },
  ] };
  const bars = parseBarsWithVolume(obj);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].date, '2022-01-03');
  assert.deepEqual(
    { o: bars[0].open, h: bars[0].high, l: bars[0].low, c: bars[0].close, v: bars[0].volume },
    { o: 1, h: 2, l: 0.5, c: 1.5, v: 200 });
});

test('indexByDate maps date -> array index', () => {
  const bars = [{ date: '2022-01-03' }, { date: '2022-01-04' }];
  const idx = indexByDate(bars);
  assert.equal(idx.get('2022-01-04'), 1);
  assert.equal(idx.get('2022-01-05'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-eventstudy-bars.test.mjs`
Expected: FAIL — `Cannot find module './coil-eventstudy-bars.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
// scripts/coil-eventstudy-bars.mjs
// Bar loader for the Coil event study. UNLIKE stage1-build-signals' parseBarsObject,
// this RETAINS volume (the price-signature features need it). ET-date keyed, ascending.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function etDate(iso) {
  const p = {}; for (const x of ET_FMT.formatToParts(new Date(iso))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function parseBarsWithVolume(obj) {
  const raw = Array.isArray(obj) ? obj : (obj.bars || []);
  const byDate = new Map();
  for (const b of raw) {
    const ts = b.Timestamp || b.timestamp;
    const o = b.Open ?? b.open, h = b.High ?? b.high, l = b.Low ?? b.low, c = b.Close ?? b.close;
    const v = b.Volume ?? b.volume;
    if (!ts || typeof o !== 'number' || typeof c !== 'number') continue;
    byDate.set(etDate(ts), { date: etDate(ts), open: o, high: h, low: l, close: c, volume: v });
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function loadBars(projectRoot, ticker) {
  const dir = join(projectRoot, 'data', 'bar-cache');
  const prefix = `${ticker.toUpperCase()}_1Day_`;
  let files = [];
  try { files = readdirSync(dir); } catch { return []; }
  const winner = new Map(); // date -> { bar, writtenAt }
  for (const f of files) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    let obj; try { obj = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    const writtenAt = (obj && obj.written_at) || '';
    for (const bar of parseBarsWithVolume(obj)) {
      const prev = winner.get(bar.date);
      if (!prev || writtenAt >= prev.writtenAt) winner.set(bar.date, { bar, writtenAt });
    }
  }
  return [...winner.values()].map(v => v.bar).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function indexByDate(bars) {
  const m = new Map();
  for (let i = 0; i < bars.length; i += 1) m.set(bars[i].date, i);
  return m;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-eventstudy-bars.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-eventstudy-bars.mjs scripts/coil-eventstudy-bars.test.mjs
git commit -m "feat(coil-eventstudy): volume-retaining bar loader"
```

---

## Task 3: Coil signal replication + instance enumeration (`coil-meanrev-signal.mjs`)

**Files:**
- Create: `scripts/coil-meanrev-signal.mjs`
- Test: `scripts/coil-meanrev-signal.test.mjs`
- Reference: `services/meanrev_signal_service.go:137-238` (Wilder RSI(2), `meanRevSMA` includes the current bar, entry `rsi2<5 && close>sma200 && close<sma5`).

- [ ] **Step 1: Write the failing test (hand-computed RSI(2) parity + entry predicate)**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilderRSI, sma, entryFires, enumerateInstances } from './coil-meanrev-signal.mjs';

test('wilderRSI(2) matches the hand-computed value', () => {
  // closes [10,11,12,11,10]: seed gains 1,1 -> after recursion RS=0.25/0.75 -> RSI=25
  assert.ok(Math.abs(wilderRSI([10, 11, 12, 11, 10], 2) - 25) < 1e-9);
});
test('wilderRSI edge cases', () => {
  assert.equal(wilderRSI([1, 2, 3], 2), 100);   // all gains
  assert.equal(wilderRSI([3, 2, 1], 2), 0);     // all losses
});
test('sma includes the current bar', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 4, 5), 3); // mean of all 5 through idx 4
});
test('entryFires requires rsi2<5 AND close>sma200 AND close<sma5', () => {
  // close above its own 200-SMA (uptrend), below its 5-SMA (pulling back), RSI(2) extreme low.
  // Build 209 flat closes at 100, then a sharp 3-day drop to force RSI(2)<5 while staying >SMA200.
  const closes = Array(207).fill(100).concat([99, 98, 97]); // idx 209 = 97
  const i = closes.length - 1;
  assert.equal(entryFires(closes, i), true);
});
test('enumerateInstances returns firing indices with >=210 bars of history', () => {
  const closes = Array(207).fill(100).concat([99, 98, 97]);
  const bars = closes.map((c, k) => ({ date: `d${k}`, close: c, open: c, high: c, low: c, volume: 1 }));
  const idxs = enumerateInstances(bars).map(x => x.idx);
  assert.deepEqual(idxs, [209]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-meanrev-signal.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation (direct port of the Go algorithm)**

```js
// scripts/coil-meanrev-signal.mjs
// JS port of services/meanrev_signal_service.go — Wilder RSI(2), SMA(200)/SMA(5)
// INCLUDING the current bar, entry = rsi2<5 && close>sma200 && close<sma5.
// Min 210 bars of history through the instance index (mirrors meanRevMinBars).
const RSI_PERIOD = 2, SMA200 = 200, SMA5 = 5, RSI_MAX = 5.0, MIN_BARS = 210;

export function wilderRSI(closes, n = RSI_PERIOD) {
  const L = closes.length;
  if (L < n + 1 || n <= 0) return 50;
  let sumGain = 0, sumLoss = 0;
  for (let i = 1; i <= n; i += 1) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) sumGain += ch; else if (ch < 0) sumLoss -= ch;
  }
  let avgGain = sumGain / n, avgLoss = sumLoss / n;
  for (let i = n + 1; i < L; i += 1) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0, loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
  }
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Mean of the n closes ending at idx (INCLUSIVE), or null if not enough history.
export function sma(closes, idx, n) {
  if (idx < n - 1) return null;
  let s = 0; for (let i = idx - n + 1; i <= idx; i += 1) s += closes[i];
  return s / n;
}

// Entry predicate evaluated at index idx using closes[0..idx].
export function entryFires(closes, idx) {
  if (idx + 1 < MIN_BARS) return false;
  const rsi2 = wilderRSI(closes.slice(0, idx + 1), RSI_PERIOD);
  const sma200 = sma(closes, idx, SMA200);
  const sma5 = sma(closes, idx, SMA5);
  if (sma200 === null || sma5 === null) return false;
  const c = closes[idx];
  return rsi2 < RSI_MAX && c > sma200 && c < sma5;
}

// Every bar index where the entry fired, with the computed signal values attached.
export function enumerateInstances(bars) {
  const closes = bars.map(b => b.close);
  const out = [];
  for (let i = MIN_BARS - 1; i < bars.length; i += 1) {
    if (!entryFires(closes, i)) continue;
    out.push({
      idx: i, date: bars[i].date,
      rsi2: wilderRSI(closes.slice(0, i + 1), RSI_PERIOD),
      sma200: sma(closes, i, SMA200), sma5: sma(closes, i, SMA5), close: closes[i],
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-meanrev-signal.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Cross-check against the Go source of truth**

Run the existing Go signal test to confirm the reference algorithm is unchanged:
Run: `go test ./services/ -run TestComputeMeanRevSignal -count=1`
Expected: PASS. (If the Go test names differ, run `go test ./services/ -run MeanRev -count=1`.) This anchors the JS port to the Go behavior it mirrors.

- [ ] **Step 6: Commit**

```bash
git add scripts/coil-meanrev-signal.mjs scripts/coil-meanrev-signal.test.mjs
git commit -m "feat(coil-eventstudy): port Coil RSI(2)/SMA entry signal to JS with parity test"
```

---

## Task 4: Price-signature features (`coil-catalyst-features.mjs`)

**Files:**
- Create: `scripts/coil-catalyst-features.mjs`
- Test: `scripts/coil-catalyst-features.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { features, composite } from './coil-catalyst-features.mjs';

function bar(o, h, l, c, v) { return { open: o, high: h, low: l, close: c, volume: v }; }

test('features compute gap, prior-day return, 5d drawdown, volume ratio', () => {
  // 31 flat bars (close 100, vol 1000), then a gap-down high-volume bar at idx 31.
  const bars = [];
  for (let i = 0; i < 31; i += 1) bars.push(bar(100, 101, 99, 100, 1000));
  bars.push(bar(95, 96, 90, 92, 5000)); // idx 31: opens 95 vs prev close 100
  const f = features(bars, 31);
  assert.ok(Math.abs(f.gap_pct - (95 / 100 - 1)) < 1e-9);          // -0.05
  assert.ok(Math.abs(f.prior_day_return - (92 / 100 - 1)) < 1e-9); // -0.08
  assert.ok(f.drawdown_5d < 0);                                    // below recent high
  assert.ok(Math.abs(f.volume_ratio - 5) < 1e-9);                  // 5000 / mean(prev 30 = 1000)
  assert.equal(Number.isFinite(f.range_zscore), true);
});

test('features return null fields on insufficient history', () => {
  const bars = [bar(100, 101, 99, 100, 1000), bar(100, 101, 99, 100, 1000)];
  const f = features(bars, 1);
  assert.equal(f.volume_ratio, null); // <30 prior bars
});

test('composite = volume_ratio * |gap_pct|', () => {
  assert.ok(Math.abs(composite({ volume_ratio: 5, gap_pct: -0.05 }) - 0.25) < 1e-9);
  assert.equal(composite({ volume_ratio: null, gap_pct: -0.05 }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-catalyst-features.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// scripts/coil-catalyst-features.mjs
// Deterministic price-signature features at a bar index, from OHLCV bars.
// All null-guarded: a feature is null when its trailing window is too short or
// degenerate (zero volume / zero range). The composite is null if any input is null.
const VOL_WINDOW = 30, RANGE_WINDOW = 20;

function trueRange(bars, i) {
  const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

export function features(bars, i) {
  const f = { gap_pct: null, prior_day_return: null, drawdown_5d: null, volume_ratio: null, range_zscore: null };
  if (i < 1) return f;
  const prevC = bars[i - 1].close;
  if (prevC > 0) {
    f.gap_pct = bars[i].open / prevC - 1;
    f.prior_day_return = bars[i].close / prevC - 1;
  }
  if (i >= 4) {
    let hi = -Infinity; for (let k = i - 4; k <= i; k += 1) hi = Math.max(hi, bars[k].high);
    if (hi > 0) f.drawdown_5d = bars[i].close / hi - 1;
  }
  if (i >= VOL_WINDOW) {
    let s = 0; for (let k = i - VOL_WINDOW; k < i; k += 1) s += bars[k].volume;
    const avg = s / VOL_WINDOW;
    if (avg > 0) f.volume_ratio = bars[i].volume / avg;
  }
  if (i >= RANGE_WINDOW + 1) {
    const trs = []; for (let k = i - RANGE_WINDOW; k < i; k += 1) trs.push(trueRange(bars, k));
    const mean = trs.reduce((a, b) => a + b, 0) / trs.length;
    const sd = Math.sqrt(trs.reduce((a, b) => a + (b - mean) ** 2, 0) / trs.length);
    if (sd > 0) f.range_zscore = (trueRange(bars, i) - mean) / sd;
  }
  return f;
}

export function composite(f) {
  if (f.volume_ratio == null || f.gap_pct == null) return null;
  return f.volume_ratio * Math.abs(f.gap_pct);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-catalyst-features.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-catalyst-features.mjs scripts/coil-catalyst-features.test.mjs
git commit -m "feat(coil-eventstudy): price-signature features + composite"
```

---

## Task 5: Build orchestrator (`coil-eventstudy-build.mjs`)

**Files:**
- Create: `scripts/coil-eventstudy-build.mjs`
- Test: `scripts/coil-eventstudy-build.test.mjs`
- Reuse: `forwardReturn` from `scripts/stage1-bars.mjs`; `loadBars`/`indexByDate` from Task 2; `enumerateInstances` from Task 3; `features`/`composite` from Task 4.

- [ ] **Step 1: Write the failing test (market-adjustment + split are the logic to pin)**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketAdjustedForward, chronoSplit, feasibility } from './coil-eventstudy-build.mjs';

test('marketAdjustedForward subtracts the SPY forward return over the same dates', () => {
  // ticker rises 10% open[d+1]->close[d+H]; SPY rises 4%; H=2.
  const tk = [{ date: 'a', open: 0, high: 0, low: 0, close: 0, volume: 1 },
              { date: 'b', open: 100, high: 0, low: 0, close: 0, volume: 1 },
              { date: 'c', open: 0, high: 0, low: 0, close: 110, volume: 1 }];
  const spy = [{ date: 'a', open: 0, close: 0 }, { date: 'b', open: 100, close: 0 }, { date: 'c', open: 0, close: 104 }];
  const r = marketAdjustedForward(tk, 0, spy, 2);
  assert.ok(Math.abs(r - (0.10 - 0.04)) < 1e-9);
});

test('marketAdjustedForward null when SPY lacks the aligned dates', () => {
  const tk = [{ date: 'a', open: 1, close: 1 }, { date: 'b', open: 1, close: 1 }, { date: 'c', open: 1, close: 1 }];
  assert.equal(marketAdjustedForward(tk, 0, [{ date: 'z', open: 1, close: 1 }], 2), null);
});

test('chronoSplit is 50/50 by date order', () => {
  const inst = [{ date: '2022-01-01' }, { date: '2022-02-01' }, { date: '2022-03-01' }, { date: '2022-04-01' }];
  const { train, holdout } = chronoSplit(inst);
  assert.equal(train.length, 2); assert.equal(holdout.length, 2);
  assert.equal(train.every(x => x.split === 'train'), true);
});

test('feasibility counts non-null market-adjusted returns per bucket', () => {
  const inst = [
    { bucket: 'catalyst', madj: { 5: 0.01 } }, { bucket: 'catalyst', madj: { 5: null } },
    { bucket: 'clean', madj: { 5: -0.02 } },
  ];
  const fc = feasibility(inst, 5);
  assert.equal(fc.catalyst, 1); assert.equal(fc.clean, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-eventstudy-build.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// scripts/coil-eventstudy-build.mjs
// Orchestrate: bars -> Coil instances -> features + market-adjusted forward returns
// at H in {5,10,20} -> chronological 50/50 split + feasibility counts.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forwardReturn } from './stage1-bars.mjs';
import { loadBars, indexByDate } from './coil-eventstudy-bars.mjs';
import { enumerateInstances } from './coil-meanrev-signal.mjs';
import { features, composite } from './coil-catalyst-features.mjs';

export const HORIZONS = [5, 10, 20];

// Long-only (s=+1) ticker forward return minus SPY's, aligned on the ENTRY date (idx+1).
export function marketAdjustedForward(tickerBars, idx, spyBars, H) {
  const tk = forwardReturn(tickerBars, idx, H, 1);
  if (!tk) return null;
  const spyIdx = indexByDate(spyBars);
  const entryDate = tickerBars[idx + 1]?.date;
  const j = spyIdx.get(entryDate);
  if (j == null) return null;
  const sp = forwardReturn(spyBars, j, H, 1);
  if (!sp) return null;
  return tk.R - sp.R;
}

export function chronoSplit(instances) {
  const sorted = [...instances].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  const train = sorted.slice(0, mid).map(x => ({ ...x, split: 'train' }));
  const holdout = sorted.slice(mid).map(x => ({ ...x, split: 'holdout' }));
  return { train, holdout, all: [...train, ...holdout] };
}

export function feasibility(instances, H) {
  const fc = { catalyst: 0, clean: 0 };
  for (const x of instances) if (x.madj && x.madj[H] != null) fc[x.bucket] += 1;
  return fc;
}

// Build all instances across the universe (bucket left null until prereg threshold applied).
export function buildInstances(projectRoot, universe, benchmark = 'SPY') {
  const spy = loadBars(projectRoot, benchmark);
  const rows = [];
  for (const t of universe) {
    const bars = loadBars(projectRoot, t);
    if (bars.length < 210) continue;
    for (const inst of enumerateInstances(bars)) {
      const f = features(bars, inst.idx);
      const madj = {};
      for (const H of HORIZONS) madj[H] = marketAdjustedForward(bars, inst.idx, spy, H);
      rows.push({ ticker: t, date: inst.date, rsi2: inst.rsi2, ...f, composite: composite(f), madj });
    }
  }
  return rows;
}

// CLI: node scripts/coil-eventstudy-build.mjs [--out data/lab/coil-instances.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const out = flag('--out', join(root, 'data', 'lab', 'coil-instances.json'));
    // Universe read from the Go file's MeanRevUniverse, mirrored here to avoid a Go bridge.
    const universe = JSON.parse(readFileSync(join(root, 'data', 'lab', 'coil-universe.json'), 'utf8'));
    const rows = buildInstances(root, universe);
    const withComposite = rows.filter(r => r.composite != null);
    const { all } = chronoSplit(withComposite);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(all, null, 2));
    const byH = {};
    for (const H of HORIZONS) byH[H] = all.filter(r => r.madj[H] != null).length;
    process.stdout.write(JSON.stringify({
      out, universe: universe.length, instances: rows.length,
      with_composite: withComposite.length, scored_per_horizon: byH,
    }, null, 2) + '\n');
  }
}
```

Note: write the 80-name universe to `data/lab/coil-universe.json` (a JSON array) in this task as a committed fixture, so the build CLI has no Go dependency. Bucketing (`bucket`) is assigned in Task 7 after the prereg threshold is frozen.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-eventstudy-build.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-eventstudy-build.mjs scripts/coil-eventstudy-build.test.mjs data/lab/coil-universe.json
git commit -m "feat(coil-eventstudy): build orchestrator (instances + market-adjusted forward returns + split)"
```

---

## Task 6: Pre-registration artifact (`coil-eventstudy-prereg.mjs`)

**Files:**
- Create: `scripts/coil-eventstudy-prereg.mjs`
- Test: `scripts/coil-eventstudy-prereg.test.mjs`
- Reuse the hash idiom from `scripts/stage1-prereg.mjs` (`sha256short`, `stableStringify`, `verifyPrereg`).

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, verifyPrereg, tercileThreshold } from './coil-eventstudy-prereg.mjs';

test('tercileThreshold = 66.667th percentile of train composites', () => {
  const train = [{ composite: 1 }, { composite: 2 }, { composite: 3 }, { composite: 9 }];
  const thr = tercileThreshold(train);
  assert.ok(thr >= 3 && thr <= 9); // top third boundary
});

test('artifact hash verifies and detects tampering', () => {
  const a = buildPrereg({ cutThreshold: 0.42, trainN: 500, holdoutN: 500 });
  assert.equal(verifyPrereg(a).ok, true);
  a.effect_size_mde = 0.5; // tamper
  assert.equal(verifyPrereg(a).ok, false);
});

test('prereg freezes the material constants', () => {
  const a = buildPrereg({ cutThreshold: 0.42, trainN: 1, holdoutN: 1 });
  assert.equal(a.effect_size_mde, 0.010);
  assert.deepEqual(a.horizons, [5, 10, 20]);
  assert.equal(a.benchmark, 'SPY');
  assert.equal(a.bootstrap.block_sessions, 10);
  assert.equal(a.verdict_rule.SIGNAL.includes('hi < 0'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-eventstudy-prereg.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// scripts/coil-eventstudy-prereg.mjs
// Hash-locked pre-registration for the B1 two-sample event study. Freezes the cut
// threshold, effect size, horizons, benchmark, and bootstrap/verdict rules BEFORE
// scoring. Mirrors stage1-prereg's self-hash idiom.
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sha256short(t) { return createHash('sha256').update(t).digest('hex').slice(0, 8); }
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => k !== 'artifact_hash')
      .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// 66.667th percentile (nearest-rank) of the train composites — the catalyst-like cut.
export function tercileThreshold(train) {
  const xs = train.map(r => r.composite).filter(v => v != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil((2 / 3) * xs.length);
  return xs[Math.min(rank, xs.length) - 1];
}

export function buildPrereg({ cutThreshold, trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'catalyst-like oversold dips have LOWER market-adjusted forward return than clean dips',
    horizons: [5, 10, 20],
    benchmark: 'SPY',
    entry: 'open[d+1]', exit: 'close[d+H]',
    composite: 'volume_ratio * abs(gap_pct)',
    cut: { rule: 'composite >= top-tercile of TRAIN composites', threshold: cutThreshold },
    effect_size_mde: 0.010,
    sd_prior: 0.07,
    sided: 'one (catalyst worse => diff < 0)',
    bootstrap: { method: 'date_block', block_sessions: 10, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    verdict_rule: {
      SIGNAL: 'hi < 0 AND meanDiff <= -effect_size_mde',
      NO_EFFECT: 'lo >= -effect_size_mde AND hi <= +effect_size_mde (equivalence)',
      INSUFFICIENT: 'otherwise',
    },
    counts: { train_n: trainN, holdout_n: holdoutN },
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/coil-eventstudy-prereg.mjs --instances data/lab/coil-instances.json --out data/lab/coil-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { readFileSync } = await import('node:fs');
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-instances.json'), 'utf8'));
    const train = inst.filter(r => r.split === 'train');
    const holdout = inst.filter(r => r.split === 'holdout');
    const thr = tercileThreshold(train);
    const a = buildPrereg({ cutThreshold: thr, trainN: train.length, holdoutN: holdout.length });
    const out = flag('--out', 'data/lab/coil-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash}, cut ${thr})\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-eventstudy-prereg.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-eventstudy-prereg.mjs scripts/coil-eventstudy-prereg.test.mjs
git commit -m "feat(coil-eventstudy): hash-locked pre-registration artifact"
```

---

## Task 7: Two-sample bootstrap scorer (`coil-eventstudy-score.mjs`)

**Files:**
- Create: `scripts/coil-eventstudy-score.mjs`
- Test: `scripts/coil-eventstudy-score.test.mjs`
- Reuse `verifyPrereg` from Task 6.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignBuckets, meanDiff, dateBlockBootstrapDiff, scoreSplit } from './coil-eventstudy-score.mjs';

test('assignBuckets splits by the frozen threshold', () => {
  const inst = [{ composite: 0.5 }, { composite: 0.1 }];
  const out = assignBuckets(inst, 0.3);
  assert.equal(out[0].bucket, 'catalyst'); assert.equal(out[1].bucket, 'clean');
});

test('meanDiff = mean(catalyst) - mean(clean) over non-null returns at H', () => {
  const inst = [
    { bucket: 'catalyst', madj: { 5: -0.03 } }, { bucket: 'catalyst', madj: { 5: -0.01 } },
    { bucket: 'clean', madj: { 5: 0.02 } }, { bucket: 'clean', madj: { 5: 0.00 } },
  ];
  assert.ok(Math.abs(meanDiff(inst, 5) - (-0.02 - 0.01)) < 1e-9); // -0.02 vs +0.01 => -0.03
});

test('bootstrap CI brackets the point estimate and is reproducible', () => {
  const inst = [];
  for (let i = 0; i < 200; i += 1) inst.push({ date: `2022-01-${(i % 28) + 1}`, bucket: 'catalyst', madj: { 5: -0.02 } });
  for (let i = 0; i < 200; i += 1) inst.push({ date: `2022-02-${(i % 28) + 1}`, bucket: 'clean', madj: { 5: 0.00 } });
  const a = dateBlockBootstrapDiff(inst, 5, { blockSessions: 10, iterations: 500, seed: 1234 });
  const b = dateBlockBootstrapDiff(inst, 5, { blockSessions: 10, iterations: 500, seed: 1234 });
  assert.deepEqual(a, b);                 // reproducible
  assert.ok(a.lo <= a.meanDiff && a.meanDiff <= a.hi);
});

test('verdict mapping: SIGNAL / NO_EFFECT / INSUFFICIENT', () => {
  const art = { effect_size_mde: 0.01, bootstrap: { block_sessions: 10, iterations: 300, seed: 1 } };
  // strongly negative catalyst returns -> SIGNAL
  const sig = [];
  for (let i = 0; i < 150; i += 1) sig.push({ date: `2022-01-${(i % 28) + 1}`, bucket: 'catalyst', madj: { 5: -0.05 } });
  for (let i = 0; i < 150; i += 1) sig.push({ date: `2022-03-${(i % 28) + 1}`, bucket: 'clean', madj: { 5: 0.00 } });
  assert.equal(scoreSplit(sig, 5, art).verdict, 'SIGNAL');
  // near-identical buckets -> NO_EFFECT (equivalence)
  const noeff = [];
  for (let i = 0; i < 400; i += 1) noeff.push({ date: `2022-01-${(i % 28) + 1}`, bucket: 'catalyst', madj: { 5: 0.0001 } });
  for (let i = 0; i < 400; i += 1) noeff.push({ date: `2022-02-${(i % 28) + 1}`, bucket: 'clean', madj: { 5: 0.0 } });
  assert.equal(scoreSplit(noeff, 5, art).verdict, 'NO_EFFECT');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-eventstudy-score.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```js
// scripts/coil-eventstudy-score.mjs
// Two-sample scorer: mean market-adjusted forward-return difference (catalyst - clean),
// date-block bootstrap CI on the difference, equivalence-aware verdict. Refuses to
// score the holdout on a prereg hash mismatch.
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPrereg } from './coil-eventstudy-prereg.mjs';

export function assignBuckets(instances, threshold) {
  return instances.map(r => ({ ...r, bucket: (r.composite != null && r.composite >= threshold) ? 'catalyst' : 'clean' }));
}

function bucketReturns(instances, H) {
  const cat = [], cln = [];
  for (const r of instances) {
    const v = r.madj && r.madj[H];
    if (v == null) continue;
    (r.bucket === 'catalyst' ? cat : cln).push(v);
  }
  return { cat, cln };
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function meanDiff(instances, H) {
  const { cat, cln } = bucketReturns(instances, H);
  if (!cat.length || !cln.length) return null;
  return mean(cat) - mean(cln);
}

// mulberry32 PRNG — reproducible bootstrap (same idiom as trade-ledger.mjs).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Resample whole date-blocks with replacement; recompute the catalyst-clean mean diff each iter.
export function dateBlockBootstrapDiff(instances, H, { blockSessions = 10, iterations = 10000, seed = 1234 } = {}) {
  const usable = instances.filter(r => r.madj && r.madj[H] != null);
  const dates = [...new Set(usable.map(r => r.date))].sort();
  const blocks = [];
  for (let i = 0; i < dates.length; i += blockSessions) blocks.push(new Set(dates.slice(i, i + blockSessions)));
  const byBlock = blocks.map(set => usable.filter(r => set.has(r.date)));
  const rng = mulberry32(seed);
  const diffs = [];
  for (let it = 0; it < iterations; it += 1) {
    const sample = [];
    for (let b = 0; b < byBlock.length; b += 1) sample.push(...byBlock[(rng() * byBlock.length) | 0]);
    const d = meanDiff(sample, H);
    if (d != null) diffs.push(d);
  }
  diffs.sort((a, b) => a - b);
  const pct = (p) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor((p / 100) * diffs.length)))];
  return { meanDiff: meanDiff(usable, H), lo: pct(2.5), hi: pct(97.5), iters: diffs.length };
}

export function scoreSplit(instances, H, artifact) {
  const mde = artifact.effect_size_mde;
  const boot = dateBlockBootstrapDiff(instances, H, {
    blockSessions: artifact.bootstrap.block_sessions,
    iterations: artifact.bootstrap.iterations, seed: artifact.bootstrap.seed,
  });
  const { cat, cln } = bucketReturns(instances, H);
  let verdict;
  if (boot.meanDiff == null) verdict = 'INSUFFICIENT';
  else if (boot.hi < 0 && boot.meanDiff <= -mde) verdict = 'SIGNAL';
  else if (boot.lo >= -mde && boot.hi <= mde) verdict = 'NO_EFFECT';
  else verdict = 'INSUFFICIENT';
  return { H, n_catalyst: cat.length, n_clean: cln.length, ...boot, mde, verdict };
}

// CLI: cat data/lab/coil-instances.json | node scripts/coil-eventstudy-score.mjs --artifact data/lab/coil-prereg.json --split holdout
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const artifact = JSON.parse(readFileSync(flag('--artifact', 'data/lab/coil-prereg.json'), 'utf8'));
    const split = flag('--split', 'holdout');
    const v = verifyPrereg(artifact);
    if (split === 'holdout' && !v.ok) {
      process.stderr.write(`REFUSING to score holdout: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`);
      process.exit(4);
    }
    let stdin = ''; process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      const all = JSON.parse(stdin);
      const inSplit = assignBuckets(all.filter(r => (r.split ?? split) === split), artifact.cut.threshold);
      const out = { split, by_horizon: artifact.horizons.map(H => scoreSplit(inSplit, H, artifact)) };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-eventstudy-score.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-eventstudy-score.mjs scripts/coil-eventstudy-score.test.mjs
git commit -m "feat(coil-eventstudy): two-sample bootstrap mean-diff scorer + verdict"
```

---

## Task 8: Run the pipeline + write the verdict (`docs/lab/coil-catalyst-dip-RESULTS.md`)

**Files:**
- Create: `docs/lab/coil-catalyst-dip-RESULTS.md`
- Data outputs (git-ignored cache or force-committed evidence per the lab convention): `data/lab/coil-instances.json`, `data/lab/coil-prereg.json`.

- [ ] **Step 1: Build the instance table**

Run: `node scripts/coil-eventstudy-build.mjs --out data/lab/coil-instances.json`
Record the printed `instances`, `with_composite`, and `scored_per_horizon` counts.

- [ ] **Step 2: Feasibility gate (BEFORE freezing/scoring)**

Inspect `scored_per_horizon`. **Required floor: ≥ 200 instances in the smaller (catalyst) bucket at H=5.** Since the catalyst bucket is the top tercile (≈ ⅓), this means **`scored_per_horizon[5] ≥ 600`**. If below that, STOP and write a `RESULTS.md` that reports INSUFFICIENT base rate — do not relax the bar. Otherwise continue.

- [ ] **Step 3: Freeze the pre-registration**

Run: `node scripts/coil-eventstudy-prereg.mjs --instances data/lab/coil-instances.json --out data/lab/coil-prereg.json`
Record the printed `hash` and `cut`. From this point the artifact must not change.

- [ ] **Step 4: (Optional) inspect train, then score holdout once**

Run (train, exploratory):
`cat data/lab/coil-instances.json | node scripts/coil-eventstudy-score.mjs --artifact data/lab/coil-prereg.json --split train`
Then the one-shot holdout:
`cat data/lab/coil-instances.json | node scripts/coil-eventstudy-score.mjs --artifact data/lab/coil-prereg.json --split holdout`
Expected: a per-horizon block `{H, n_catalyst, n_clean, meanDiff, lo, hi, verdict}`. The scorer exits non-zero if the artifact hash was altered.

- [ ] **Step 5: Write `docs/lab/coil-catalyst-dip-RESULTS.md`**

Document, per horizon (5/10/20): n per bucket, meanDiff, the 95% CI, and the verdict. Then the interpretation that B exists to produce:
- **+5d vs +10d/+20d contrast** — if catalyst dips look worse at +5d but the gap shrinks/vanishes by +20d, that indicts Coil's **5-day timeout** (slower revert), not the entry → recommend an exit-rule study, NOT a gate.
- State explicitly that `clean` is a **lower bound on catalyst contamination** (price signature only; news catalysts without a price footprint sit in `clean`) and that the earnings-skip was omitted in B1.
- Record the verdict's consequence: `SIGNAL` → proceed to **B2** (news split) then **A** (live forward confirmation) before any gate; `NO_EFFECT` → catalysts (by price footprint) don't materially hurt entry returns — do not gate; `INSUFFICIENT` → report and stop.

- [ ] **Step 6: Commit**

```bash
git add docs/lab/coil-catalyst-dip-RESULTS.md data/lab/coil-prereg.json
git commit -m "docs(coil-eventstudy): B1 price-signature catalyst-dip results + verdict"
```

---

## Self-Review notes (author check)
- **Spec coverage:** instance gen (T3), price features (T4), market-adjusted un-censored forward returns at 5/10/20 (T5), pre-registration hash-lock (T6), two-sample CI/equivalence scorer (T7), feasibility-first + the entry-vs-exit-confound read (T8). News split (B2) and live instrument (A) are explicitly out of B1.
- **Confounds:** exit-rule confound → +10/+20d horizons (T5/T8); survivorship → SPY market-adjust (T5); look-ahead → `forwardReturn` open[d+1]/close[d+H] + train-only cut (T5/T6); forking paths → frozen prereg + hash refusal (T6/T7).
- **Known B1 caveats (documented, not bugs):** earnings-skip omitted; `clean` is a contamination lower bound; window partly burned by stage1 → B is discovery, A confirms.
- **Open confirmations:** Go signal test name in T3 Step 5; that all 80 names returned ≥210 bars in T1 (drop any that didn't, log them in RESULTS).
