# Coil Front-Run Diagnostic + Monitor — Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the near-miss episode enumerator, then use it to test whether Coil's RSI(2)<5 trigger is increasingly front-run — exploratorily on history, and confirmatorily on a pre-registered forward window.

**Architecture:** A pure episode enumerator (`coil-nearmiss-enum.mjs`) recomputes near-miss episodes from `data/bar-cache/` and classifies each as FIRE / BOUNCE / REGIME_EXIT / UNRESOLVED. A build CLI materialises episodes to `data/lab/coil-frontrun-episodes.json` with a SPY volatility tercile attached. A hash-locked pre-registration freezes the decision rule and the forward-window start. Two report scripts then read those artifacts: an exploratory diagnostic (history) and a confirmatory monitor (forward window).

**Tech Stack:** Node 20+ ESM (`"type": "module"`), `node:test` + `node:assert/strict`. No new dependencies. All statistics reuse `scripts/coil-threshold-metrics.mjs`.

**Spec:** `docs/superpowers/specs/2026-07-09-coil-inverse-veto-design.md` (Parts 1 & 2).

## Global Constraints

- **Never modify live Coil.** No edits to `services/`, `TRADING_RULES_MEANREV.md`, or any live config. This plan writes only `scripts/*.mjs`, `data/lab/*`, and `docs/lab/*`.
- **No new dependencies.** Everything reuses existing modules.
- **No behaviour change to any tested module.** The only edit to existing code is adding one `export` keyword (Task 4).
- **Constants, fixed and identical everywhere:** `FIRE_MAX = 5`, `NEAR_MISS_HI = 15`, `RESOLUTION_CAP = 10`, `MIN_BARS = 210`, `VOL_WINDOW = 20`, friction `20` bps, bootstrap `blockSessions = 15`, `iterations = 10000`, `seed = 1234`.
- **Gates are `entryFiresAt`'s strict gates:** `close > SMA200 && close < SMA5`. Never the preview's `SMA5 × 1.005` relaxed band.
- **The conversion metric applies NO earnings filter.** It measures price dynamics. (The return metrics read `coil-threshold-instances.json`, which already has the filter baked in.)
- **Run all commands from the repo root:** `C:\Users\mtzuo\OneDrive\Documents\Projects\ClaudeProphetAndFriends`.
- **Test command:** `node --test scripts/<file>.test.mjs` for one file; `npm test` for all.

---

### Task 1: Near-miss episode enumerator

The shared engine. Pure, no I/O. `resolveEpisode` takes a **precomputed facts array** rather than raw closes, so precedence and no-lookahead are testable with literal fixtures.

**Files:**
- Create: `scripts/coil-nearmiss-enum.mjs`
- Test: `scripts/coil-nearmiss-enum.test.mjs`

**Interfaces:**
- Consumes: `wilderRSI(closes, n)`, `sma(closes, idx, n)` from `scripts/coil-meanrev-signal.mjs`.
- Produces:
  - `MIN_BARS = 210`, `FIRE_MAX = 5`, `NEAR_MISS_HI = 15`, `RESOLUTION_CAP = 10`
  - `barFacts(closes, idx) -> {close, rsi2, s5, s200} | null`
  - `factsSeries(closes) -> Array<facts|null>`
  - `stateOf(facts|null) -> 'FIRE' | 'NEAR_MISS' | 'OUT'`
  - `resolveEpisode(facts, startIdx, {cap}) -> {outcome: 'FIRE'|'BOUNCE'|'REGIME_EXIT'|'UNRESOLVED', bars: number}`
  - `enumerateEpisodes(bars, {cap}) -> Array<{idx, date, rsi2, outcome, bars, resolveDate}>`

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-nearmiss-enum.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_BARS, FIRE_MAX, NEAR_MISS_HI, RESOLUTION_CAP,
  barFacts, factsSeries, stateOf, resolveEpisode, enumerateEpisodes,
} from './coil-nearmiss-enum.mjs';

// A facts literal: gates hold when s200 < close < s5.
const F = (close, rsi2, s5, s200) => ({ close, rsi2, s5, s200 });

test('constants match the pre-registered values', () => {
  assert.equal(MIN_BARS, 210);
  assert.equal(FIRE_MAX, 5);
  assert.equal(NEAR_MISS_HI, 15);
  assert.equal(RESOLUTION_CAP, 10);
});

test('stateOf classifies FIRE / NEAR_MISS / OUT', () => {
  assert.equal(stateOf(null), 'OUT');
  assert.equal(stateOf(F(100, 3, 105, 90)), 'FIRE');       // gates hold, rsi<5
  assert.equal(stateOf(F(100, 9, 105, 90)), 'NEAR_MISS');  // gates hold, 5<=rsi<15
  assert.equal(stateOf(F(100, 20, 105, 90)), 'OUT');       // rsi>=15
  assert.equal(stateOf(F(100, 9, 95, 90)), 'OUT');         // close>s5 -> gate fails
  assert.equal(stateOf(F(100, 9, 105, 110)), 'OUT');       // close<s200 -> gate fails
});

test('resolveEpisode: FIRE takes precedence over BOUNCE within a bar', () => {
  // A bar cannot be both: FIRE requires close<s5, BOUNCE requires close>s5.
  // But assert FIRE is checked first by giving a bar that fires.
  const facts = [F(100, 9, 105, 90), F(98, 3, 104, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'FIRE', bars: 1 });
});

test('resolveEpisode: close above SMA5 is a BOUNCE', () => {
  const facts = [F(100, 9, 105, 90), F(107, 60, 104, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'BOUNCE', bars: 1 });
});

test('resolveEpisode: dropping below SMA200 while under SMA5 is a REGIME_EXIT', () => {
  const facts = [F(100, 9, 105, 90), F(85, 6, 104, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'REGIME_EXIT', bars: 1 });
});

test('resolveEpisode: BOUNCE beats REGIME_EXIT when both could read true', () => {
  // close > s5 AND close < s200 is only possible if s5 < s200; bounce is checked first.
  const facts = [F(100, 9, 105, 90), F(96, 40, 95, 99)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'BOUNCE', bars: 1 });
});

test('resolveEpisode: UNRESOLVED at the cap', () => {
  // Bars that are neither fire, nor bounce, nor regime exit: rsi in band, close between.
  const hold = F(100, 9, 105, 90);
  const facts = [hold, hold, hold, hold];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 2 }), { outcome: 'UNRESOLVED', bars: 2 });
});

test('resolveEpisode: UNRESOLVED when the series ends first', () => {
  const facts = [F(100, 9, 105, 90), F(100, 9, 105, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'UNRESOLVED', bars: 1 });
});

test('resolveEpisode: null facts (insufficient warmup) resolve UNRESOLVED', () => {
  const facts = [F(100, 9, 105, 90), null];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'UNRESOLVED', bars: 1 });
});

test('resolveEpisode: no lookahead — truncating after the resolving bar is identical', () => {
  const facts = [F(100, 9, 105, 90), F(101, 12, 105, 90), F(98, 3, 104, 90), F(200, 99, 1, 1)];
  const full = resolveEpisode(facts, 0, { cap: 10 });
  const cut = resolveEpisode(facts.slice(0, 3), 0, { cap: 10 });
  assert.deepEqual(full, { outcome: 'FIRE', bars: 2 });
  assert.deepEqual(cut, full);
});

// --- enumerateEpisodes: fresh-signal dedup ---
// Bars carry {date, close}; facts are derived, so we drive it through real closes.
// A long uptrend then a sharp pullback puts the last bars in the near-miss/fire zone.
function upThenPullback(len = 240, drop = 0.6) {
  const closes = [];
  for (let i = 0; i < len - 8; i += 1) closes.push(100 + 0.2 * i);
  const peak = closes[closes.length - 1];
  for (let k = 1; k <= 8; k += 1) closes.push(peak - drop * k);
  return closes;
}
const barsOf = (closes) => closes.map((c, i) => ({ date: `d${String(i).padStart(4, '0')}`, close: c }));

test('barFacts returns null before MIN_BARS of warmup', () => {
  const closes = upThenPullback();
  assert.equal(barFacts(closes, MIN_BARS - 2), null);
  assert.notEqual(barFacts(closes, MIN_BARS - 1), null);
});

test('factsSeries length matches closes and early entries are null', () => {
  const closes = upThenPullback();
  const f = factsSeries(closes);
  assert.equal(f.length, closes.length);
  assert.equal(f[0], null);
});

test('enumerateEpisodes: consecutive in-band bars yield exactly one episode', () => {
  const bars = barsOf(upThenPullback());
  const eps = enumerateEpisodes(bars, { cap: RESOLUTION_CAP });
  const starts = eps.map(e => e.idx);
  assert.equal(new Set(starts).size, starts.length);       // no duplicate starts
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] > starts[i - 1] + 0, 'starts strictly increase');
  }
  // Every episode starts on a NEAR_MISS bar whose predecessor was not in-band.
  const facts = factsSeries(bars.map(b => b.close));
  for (const e of eps) {
    assert.equal(stateOf(facts[e.idx]), 'NEAR_MISS');
    assert.ok(!['NEAR_MISS', 'FIRE'].includes(stateOf(facts[e.idx - 1])));
  }
});

test('enumerateEpisodes: records date, rsi2, outcome and resolveDate', () => {
  const bars = barsOf(upThenPullback());
  const eps = enumerateEpisodes(bars, { cap: RESOLUTION_CAP });
  assert.ok(eps.length >= 1, 'fixture must produce at least one episode');
  const e = eps[0];
  assert.equal(e.date, bars[e.idx].date);
  assert.ok(e.rsi2 >= FIRE_MAX && e.rsi2 < NEAR_MISS_HI);
  assert.ok(['FIRE', 'BOUNCE', 'REGIME_EXIT', 'UNRESOLVED'].includes(e.outcome));
  if (e.outcome !== 'UNRESOLVED') assert.equal(e.resolveDate, bars[e.idx + e.bars].date);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-nearmiss-enum.test.mjs`
Expected: FAIL — `Cannot find module './coil-nearmiss-enum.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-nearmiss-enum.mjs`:

```js
// scripts/coil-nearmiss-enum.mjs
// Near-miss EPISODE enumeration for the Coil front-run study.
//
// A "near-miss" is a bar where Coil's non-RSI gates hold (close > SMA200, close < SMA5)
// and RSI(2) sits in [5, 15) — oversold, but not oversold enough to fire.
//
// RSI(2) is heavily autocorrelated: one dip yields several consecutive in-band bars.
// Counting BARS would measure episode length, not episode count. So we enumerate
// fresh-signal EPISODES (mirroring coil-threshold-build's one-open-trade-per-ticker rule)
// and follow each forward to a resolution.
//
// Resolution precedence within a bar (first match wins):
//   1. FIRE        — rsi2 < 5 with the gates still holding (it converted)
//   2. BOUNCE      — close > SMA5: the pullback condition broke ("it jumped")
//   3. REGIME_EXIT — close < SMA200: left the tradeable regime
// Nothing by `cap` bars -> UNRESOLVED (reported, excluded from the conversion rate).
//
// No lookahead: the check at d+k reads only facts[0..d+k].
import { wilderRSI, sma } from './coil-meanrev-signal.mjs';

const RSI_PERIOD = 2, SMA_LONG = 200, SMA_SHORT = 5;

export const MIN_BARS = 210;        // matches entryFiresAt's warmup guard
export const FIRE_MAX = 5;          // Coil's entry trigger
export const NEAR_MISS_HI = 15;     // the WATCH band's upper edge
export const RESOLUTION_CAP = 10;   // bars to follow an episode before giving up

// barFacts: everything a resolution decision needs, or null before warmup.
export function barFacts(closes, idx) {
  if (idx + 1 < MIN_BARS) return null;
  const s200 = sma(closes, idx, SMA_LONG);
  const s5 = sma(closes, idx, SMA_SHORT);
  if (s200 === null || s5 === null) return null;
  return { close: closes[idx], rsi2: wilderRSI(closes.slice(0, idx + 1), RSI_PERIOD), s5, s200 };
}

// factsSeries: one barFacts per bar. Computed once so wilderRSI runs once per bar.
export function factsSeries(closes) {
  return closes.map((_, i) => barFacts(closes, i));
}

export function stateOf(f) {
  if (!f) return 'OUT';
  if (!(f.close > f.s200 && f.close < f.s5)) return 'OUT';  // gates
  if (f.rsi2 < FIRE_MAX) return 'FIRE';
  if (f.rsi2 < NEAR_MISS_HI) return 'NEAR_MISS';
  return 'OUT';
}

export function resolveEpisode(facts, startIdx, { cap = RESOLUTION_CAP } = {}) {
  for (let k = 1; k <= cap; k += 1) {
    const j = startIdx + k;
    if (j >= facts.length) return { outcome: 'UNRESOLVED', bars: k - 1 };
    const f = facts[j];
    if (!f) return { outcome: 'UNRESOLVED', bars: k };
    if (f.rsi2 < FIRE_MAX && f.close < f.s5 && f.close > f.s200) return { outcome: 'FIRE', bars: k };
    if (f.close > f.s5) return { outcome: 'BOUNCE', bars: k };
    if (f.close < f.s200) return { outcome: 'REGIME_EXIT', bars: k };
  }
  return { outcome: 'UNRESOLVED', bars: cap };
}

// enumerateEpisodes: bars are [{date, close, ...}] ascending.
// An episode starts on the first NEAR_MISS bar whose predecessor was NOT in-band
// (neither NEAR_MISS nor FIRE), and no new episode starts inside a resolving one.
export function enumerateEpisodes(bars, { cap = RESOLUTION_CAP } = {}) {
  const closes = bars.map(b => b.close);
  const dates = bars.map(b => b.date);
  const facts = factsSeries(closes);
  const eps = [];
  let skipUntil = -1;
  for (let i = 1; i < facts.length; i += 1) {
    if (i <= skipUntil) continue;
    if (stateOf(facts[i]) !== 'NEAR_MISS') continue;
    const prev = stateOf(facts[i - 1]);
    if (prev === 'NEAR_MISS' || prev === 'FIRE') continue;
    const r = resolveEpisode(facts, i, { cap });
    eps.push({
      idx: i, date: dates[i], rsi2: facts[i].rsi2,
      outcome: r.outcome, bars: r.bars,
      resolveDate: dates[i + r.bars] ?? null,
    });
    skipUntil = i + r.bars;
  }
  return eps;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-nearmiss-enum.test.mjs`
Expected: PASS, all tests.

If `enumerateEpisodes: records date...` fails with "fixture must produce at least one episode", widen the pullback: change `upThenPullback()` to `upThenPullback(240, 1.2)` in the test. Do not weaken the assertion.

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-nearmiss-enum.mjs scripts/coil-nearmiss-enum.test.mjs
git commit -m "feat(coil-frontrun): near-miss episode enumerator with fresh-signal dedup"
```

---

### Task 2: SPY realized-volatility terciles

The confound control. Low-vol years produce fewer deep-oversold events regardless of crowding.

**Files:**
- Create: `scripts/coil-frontrun-vol.mjs`
- Test: `scripts/coil-frontrun-vol.test.mjs`

**Interfaces:**
- Consumes: nothing (pure; the caller supplies bars).
- Produces:
  - `VOL_WINDOW = 20`
  - `realizedVolSeries(bars, window) -> Map<dateString, number>`
  - `tercileBoundaries(volValues) -> {lo, hi} | null`
  - `tercileOf(vol, {lo, hi}) -> 'low' | 'mid' | 'high' | null`

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-frontrun-vol.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOL_WINDOW, realizedVolSeries, tercileBoundaries, tercileOf } from './coil-frontrun-vol.mjs';

const barsOf = (closes) => closes.map((c, i) => ({ date: `d${String(i).padStart(3, '0')}`, close: c }));

test('VOL_WINDOW is the pre-registered 20 sessions', () => {
  assert.equal(VOL_WINDOW, 20);
});

test('realizedVolSeries is empty until `window` returns exist', () => {
  const bars = barsOf(Array.from({ length: 10 }, (_, i) => 100 + i));
  assert.equal(realizedVolSeries(bars, 5).has('d004'), false);
  assert.equal(realizedVolSeries(bars, 5).has('d005'), true);
});

test('realizedVolSeries: a constant-growth series has ~zero volatility', () => {
  const bars = barsOf(Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i));
  const v = realizedVolSeries(bars, 5);
  assert.ok(v.get('d029') < 1e-9, 'constant log-return => zero stdev');
});

test('realizedVolSeries: a choppy series has higher vol than a smooth one', () => {
  const smooth = barsOf(Array.from({ length: 30 }, (_, i) => 100 + i));
  const choppy = barsOf(Array.from({ length: 30 }, (_, i) => 100 + i + (i % 2 ? 6 : -6)));
  assert.ok(realizedVolSeries(choppy, 10).get('d029') > realizedVolSeries(smooth, 10).get('d029'));
});

test('tercileBoundaries splits a uniform sample into thirds', () => {
  const vals = Array.from({ length: 300 }, (_, i) => i);
  const b = tercileBoundaries(vals);
  assert.equal(b.lo, 100);
  assert.equal(b.hi, 200);
});

test('tercileBoundaries returns null on a degenerate sample', () => {
  assert.equal(tercileBoundaries([1, 2]), null);
});

test('tercileOf assigns low/mid/high on the frozen boundaries', () => {
  const b = { lo: 10, hi: 20 };
  assert.equal(tercileOf(5, b), 'low');
  assert.equal(tercileOf(10, b), 'low');   // inclusive lower edge
  assert.equal(tercileOf(15, b), 'mid');
  assert.equal(tercileOf(20, b), 'mid');   // inclusive
  assert.equal(tercileOf(25, b), 'high');
  assert.equal(tercileOf(NaN, b), null);
  assert.equal(tercileOf(null, b), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-frontrun-vol.test.mjs`
Expected: FAIL — `Cannot find module './coil-frontrun-vol.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-frontrun-vol.mjs`:

```js
// scripts/coil-frontrun-vol.mjs
// SPY trailing realized-volatility terciles — the confound control for the front-run study.
// Low-volatility years produce fewer deep-oversold events regardless of any crowding, so every
// conversion statistic is reported within tercile as well as pooled.
//
// Tercile boundaries are computed ONCE over the historical sample and then FROZEN into the
// pre-registration, so the forward window is scored against fixed edges, not re-fit ones.

export const VOL_WINDOW = 20;

// realizedVolSeries: date -> stdev of the trailing `window` daily log returns.
// The value at bars[i] uses returns for bars[i-window+1 .. i] — no lookahead.
export function realizedVolSeries(bars, window = VOL_WINDOW) {
  const out = new Map();
  if (bars.length < window + 1) return out;
  const r = [];
  for (let i = 1; i < bars.length; i += 1) r.push(Math.log(bars[i].close / bars[i - 1].close));
  // r[i-1] is the return arriving at bars[i].
  for (let i = window; i < bars.length; i += 1) {
    const w = r.slice(i - window, i);
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const varr = w.reduce((a, b) => a + (b - m) * (b - m), 0) / (w.length - 1);
    out.set(bars[i].date, Math.sqrt(varr));
  }
  return out;
}

export function tercileBoundaries(volValues) {
  const s = [...volValues].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 3) return null;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { lo: q(1 / 3), hi: q(2 / 3) };
}

export function tercileOf(vol, boundaries) {
  if (!boundaries || !Number.isFinite(vol)) return null;
  if (vol <= boundaries.lo) return 'low';
  if (vol <= boundaries.hi) return 'mid';
  return 'high';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-frontrun-vol.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/coil-frontrun-vol.mjs scripts/coil-frontrun-vol.test.mjs
git commit -m "feat(coil-frontrun): SPY trailing realized-vol terciles (confound control)"
```

---

### Task 3: Episode build CLI

Materialises episodes across the universe, attaching each episode's SPY volatility at its start date.

**Files:**
- Create: `scripts/coil-frontrun-build.mjs`
- Test: `scripts/coil-frontrun-build.test.mjs`

**Interfaces:**
- Consumes: `enumerateEpisodes` (Task 1), `realizedVolSeries` (Task 2), `loadBars` from `scripts/coil-eventstudy-bars.mjs`, `MEANREV_UNIVERSE` from `scripts/coil-eventstudy-build.mjs`.
- Produces:
  - `buildEpisodes(root, {universe, cap}) -> Array<{ticker, idx, date, rsi2, outcome, bars, resolveDate, vol}>`
  - Writes `data/lab/coil-frontrun-episodes.json`

Note `loadBars(root, ticker)` reads every `data/bar-cache/<TICKER>_1Day_*.json`, merges by ET date, and resolves per-date conflicts by the newest `written_at`. Fixtures must therefore include a `written_at` field.

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-frontrun-build.test.mjs`:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEpisodes } from './coil-frontrun-build.mjs';

const _roots = [];
async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontrun-'));
  await fs.mkdir(path.join(root, 'data', 'bar-cache'), { recursive: true });
  _roots.push(root);
  return root;
}
after(async () => { await Promise.all(_roots.map(r => fs.rm(r, { recursive: true, force: true }))); });

// Sequential trading days starting 2021-01-04, as UTC timestamps at 05:00Z (=00:00 ET).
function isoDay(i) {
  const d = new Date(Date.UTC(2021, 0, 4 + i, 5, 0, 0));
  return d.toISOString();
}
async function writeBars(root, ticker, closes) {
  const bars = closes.map((c, i) => ({
    Timestamp: isoDay(i), Open: c, High: c * 1.01, Low: c * 0.99, Close: c, Volume: 1000,
  }));
  const file = path.join(root, 'data', 'bar-cache', `${ticker}_1Day_x.json`);
  await fs.writeFile(file, JSON.stringify({ written_at: '2026-07-09T00:00:00Z', bars }));
}
function upThenPullback(len = 260, drop = 1.2) {
  const closes = [];
  for (let i = 0; i < len - 8; i += 1) closes.push(100 + 0.2 * i);
  const peak = closes[closes.length - 1];
  for (let k = 1; k <= 8; k += 1) closes.push(peak - drop * k);
  return closes;
}

test('buildEpisodes returns [] when a ticker has too few bars', async () => {
  const root = await tmpRoot();
  await writeBars(root, 'AAA', [100, 101, 102]);
  assert.deepEqual(await buildEpisodes(root, { universe: ['AAA'] }), []);
});

test('buildEpisodes tags every episode with its ticker and a vol number', async () => {
  const root = await tmpRoot();
  const closes = upThenPullback();
  await writeBars(root, 'AAA', closes);
  await writeBars(root, 'SPY', closes);
  const eps = await buildEpisodes(root, { universe: ['AAA'] });
  assert.ok(eps.length >= 1, 'fixture must yield at least one episode');
  for (const e of eps) {
    assert.equal(e.ticker, 'AAA');
    assert.ok(Number.isFinite(e.vol), 'vol attached from the SPY series');
    assert.ok(['FIRE', 'BOUNCE', 'REGIME_EXIT', 'UNRESOLVED'].includes(e.outcome));
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('buildEpisodes sets vol=null when SPY has no bar for that date', async () => {
  const root = await tmpRoot();
  await writeBars(root, 'AAA', upThenPullback());
  // No SPY file at all.
  const eps = await buildEpisodes(root, { universe: ['AAA'] });
  assert.ok(eps.length >= 1);
  assert.equal(eps[0].vol, null);
});

test('buildEpisodes concatenates across tickers', async () => {
  const root = await tmpRoot();
  const closes = upThenPullback();
  await writeBars(root, 'AAA', closes);
  await writeBars(root, 'BBB', closes);
  await writeBars(root, 'SPY', closes);
  const eps = await buildEpisodes(root, { universe: ['AAA', 'BBB'] });
  assert.deepEqual([...new Set(eps.map(e => e.ticker))].sort(), ['AAA', 'BBB']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-frontrun-build.test.mjs`
Expected: FAIL — `Cannot find module './coil-frontrun-build.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-frontrun-build.mjs`:

```js
// scripts/coil-frontrun-build.mjs
// Materialise near-miss episodes across MEANREV_UNIVERSE, tagging each with SPY realized vol
// at its start date. Deliberately applies NO earnings filter: conversion is a question about
// price dynamics, not about Coil's tradeable set. (See the spec's "Shared engine" section.)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBars } from './coil-eventstudy-bars.mjs';
import { MEANREV_UNIVERSE } from './coil-eventstudy-build.mjs';
import { enumerateEpisodes, MIN_BARS, RESOLUTION_CAP } from './coil-nearmiss-enum.mjs';
import { realizedVolSeries, VOL_WINDOW } from './coil-frontrun-vol.mjs';

export async function buildEpisodes(root, { universe = MEANREV_UNIVERSE, cap = RESOLUTION_CAP } = {}) {
  const spyBars = loadBars(root, 'SPY');
  const vol = spyBars.length > VOL_WINDOW ? realizedVolSeries(spyBars, VOL_WINDOW) : new Map();
  const out = [];
  for (const ticker of universe) {
    const bars = loadBars(root, ticker);
    if (bars.length < MIN_BARS) continue;
    for (const e of enumerateEpisodes(bars, { cap })) {
      out.push({ ticker, ...e, vol: vol.get(e.date) ?? null });
    }
  }
  return out;
}

// CLI: node scripts/coil-frontrun-build.mjs [--out data/lab/coil-frontrun-episodes.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const out = flag('--out', join(root, 'data', 'lab', 'coil-frontrun-episodes.json'));
    const eps = await buildEpisodes(root);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(eps, null, 2));
    const by = (o) => eps.filter(e => e.outcome === o).length;
    const years = [...new Set(eps.map(e => e.date.slice(0, 4)))].sort();
    const span = years.length || 1;
    process.stdout.write(JSON.stringify({
      out, episodes: eps.length, fire: by('FIRE'), bounce: by('BOUNCE'),
      regime_exit: by('REGIME_EXIT'), unresolved: by('UNRESOLVED'),
      no_vol: eps.filter(e => e.vol == null).length,
      years, episodes_per_year: Math.round(eps.length / span),
    }, null, 2) + '\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-frontrun-build.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Build the real episode file and record the counts**

Run: `node scripts/coil-frontrun-build.mjs`
Expected: JSON summary on stdout, and `data/lab/coil-frontrun-episodes.json` created.

**Record `episodes_per_year` from the output — Task 4 needs it.**

**STOP AND REPORT to the operator if `episodes_per_year < 200`.** The pre-registered `n ≥ 200` gate would then be unreachable within a year, and the gate must be re-chosen *before* the prereg is committed — not after. Do not silently lower it.

Also report `no_vol` — if it is a large fraction of episodes, the SPY bar coverage does not span the episode window and the tercile control is compromised.

- [ ] **Step 6: Commit**

```bash
git add scripts/coil-frontrun-build.mjs scripts/coil-frontrun-build.test.mjs
git commit -m "feat(coil-frontrun): episode build CLI with SPY vol tagging"
```

`data/lab/coil-frontrun-episodes.json` is gitignored (`data/**`) and intentionally left untracked — it is a derived artifact, rebuildable from bars.

---

### Task 4: Hash-locked pre-registration

Freezes the decision rule and `forward_window_start` before any forward observation exists.

**Files:**
- Modify: `scripts/coil-threshold-prereg.mjs:9` — add one `export` keyword to `stable`
- Create: `scripts/coil-frontrun-prereg.mjs`
- Test: `scripts/coil-frontrun-prereg.test.mjs`

**Interfaces:**
- Consumes: `sha256short` from `scripts/coil-eventstudy-prereg.mjs`; `stable` from `scripts/coil-threshold-prereg.mjs`; `tercileBoundaries` (Task 2).
- Produces:
  - `buildFrontrunPrereg({episodes, forwardWindowStart, nGate, createdUtc}) -> artifact`
  - `verifyFrontrunPrereg(artifact) -> {ok, expected, found}`
  - `conversionRate(episodes) -> number | null`
  - Writes `data/lab/coil-frontrun-prereg.json`

- [ ] **Step 1: Make `stable` reusable**

In `scripts/coil-threshold-prereg.mjs`, line 9, change:

```js
function stable(v) {
```

to:

```js
export function stable(v) {
```

This is additive: no behaviour changes, and the existing tests must still pass.

Run: `node --test scripts/coil-threshold-prereg.test.mjs`
Expected: PASS (unchanged).

- [ ] **Step 2: Write the failing test**

Create `scripts/coil-frontrun-prereg.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrontrunPrereg, verifyFrontrunPrereg, conversionRate } from './coil-frontrun-prereg.mjs';

const ep = (date, outcome, vol) => ({ ticker: 'AAA', date, outcome, vol, rsi2: 9, bars: 2 });

test('conversionRate counts FIRE over (FIRE + BOUNCE), ignoring the rest', () => {
  const eps = [
    ep('2021-01-04', 'FIRE', 0.01), ep('2021-01-05', 'BOUNCE', 0.01),
    ep('2021-01-06', 'BOUNCE', 0.01), ep('2021-01-07', 'REGIME_EXIT', 0.01),
    ep('2021-01-08', 'UNRESOLVED', 0.01),
  ];
  assert.equal(conversionRate(eps), 1 / 3);
});

test('conversionRate returns null with no resolved episodes', () => {
  assert.equal(conversionRate([ep('2021-01-04', 'UNRESOLVED', 0.01)]), null);
});

test('buildFrontrunPrereg freezes the rule and self-hashes', () => {
  const eps = [ep('2021-01-04', 'FIRE', 0.01), ep('2021-01-05', 'BOUNCE', 0.02), ep('2021-01-06', 'BOUNCE', 0.03)];
  const a = buildFrontrunPrereg({
    episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z',
  });
  assert.equal(a.forward_window_start, '2026-07-09');
  assert.equal(a.n_gate, 200);
  assert.equal(a.near_miss_band[0], 5);
  assert.equal(a.near_miss_band[1], 15);
  assert.equal(a.fire_threshold, 5);
  assert.equal(a.resolution_cap, 10);
  assert.equal(a.bounce_definition, 'close > SMA5');
  assert.equal(a.expected_outcome, 'NOT_SUPPORTED');
  assert.equal(a.benchmark_conversion_rate, 1 / 3);
  assert.ok(a.vol_tercile_boundaries.lo <= a.vol_tercile_boundaries.hi);
  assert.ok(a.artifact_hash);
  assert.equal(verifyFrontrunPrereg(a).ok, true);
});

test('buildFrontrunPrereg uses ONLY pre-forward-window episodes for the benchmark', () => {
  const eps = [
    ep('2021-01-04', 'FIRE', 0.01),      // historical
    ep('2026-08-01', 'BOUNCE', 0.02),    // forward — must be excluded
    ep('2026-08-02', 'BOUNCE', 0.03),
  ];
  const a = buildFrontrunPrereg({
    episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z',
  });
  assert.equal(a.benchmark_conversion_rate, 1);   // the single historical episode fired
  assert.equal(a.counts.historical_resolved, 1);
});

test('verifyFrontrunPrereg detects a tampered artifact', () => {
  const eps = [ep('2021-01-04', 'FIRE', 0.01), ep('2021-01-05', 'BOUNCE', 0.02), ep('2021-01-06', 'BOUNCE', 0.03)];
  const a = buildFrontrunPrereg({
    episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z',
  });
  a.n_gate = 5;
  const v = verifyFrontrunPrereg(a);
  assert.equal(v.ok, false);
  assert.notEqual(v.expected, v.found);
});

test('buildFrontrunPrereg is deterministic for a fixed createdUtc', () => {
  const eps = [ep('2021-01-04', 'FIRE', 0.01), ep('2021-01-05', 'BOUNCE', 0.02), ep('2021-01-06', 'BOUNCE', 0.03)];
  const mk = () => buildFrontrunPrereg({ episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z' });
  assert.equal(mk().artifact_hash, mk().artifact_hash);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test scripts/coil-frontrun-prereg.test.mjs`
Expected: FAIL — `Cannot find module './coil-frontrun-prereg.mjs'`

- [ ] **Step 4: Write minimal implementation**

Create `scripts/coil-frontrun-prereg.mjs`:

```js
// scripts/coil-frontrun-prereg.mjs
// Hash-locked pre-registration for the Coil front-run monitor. Mirrors coil-threshold-prereg.
//
// The one invariant that makes the forward test confirmatory: the rule is frozen before any
// forward observation exists. Measuring the past to set the benchmark and size the gate cannot
// violate that — the forward window is empty at the time.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256short } from './coil-eventstudy-prereg.mjs';
import { stable } from './coil-threshold-prereg.mjs';
import { tercileBoundaries, VOL_WINDOW } from './coil-frontrun-vol.mjs';
import { FIRE_MAX, NEAR_MISS_HI, RESOLUTION_CAP } from './coil-nearmiss-enum.mjs';

export function conversionRate(episodes) {
  const resolved = episodes.filter(e => e.outcome === 'FIRE' || e.outcome === 'BOUNCE');
  if (!resolved.length) return null;
  return resolved.filter(e => e.outcome === 'FIRE').length / resolved.length;
}

export function buildFrontrunPrereg({ episodes, forwardWindowStart, nGate = 200, createdUtc }) {
  const hist = episodes.filter(e => e.date < forwardWindowStart);
  const histResolved = hist.filter(e => e.outcome === 'FIRE' || e.outcome === 'BOUNCE');
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis:
      'Coil\'s RSI(2)<5 trigger is increasingly front-run: near-miss episodes convert to fires ' +
      'LESS often in the forward window than historically (expected null: no change)',
    near_miss_band: [FIRE_MAX, NEAR_MISS_HI],
    fire_threshold: FIRE_MAX,
    gates: 'close > SMA200 AND close < SMA5 (entryFiresAt strict gates)',
    bounce_definition: 'close > SMA5',
    resolution_cap: RESOLUTION_CAP,
    enumeration: 'fresh-signal episodes; no new episode starts inside a resolving one',
    earnings_filter: 'NOT applied — conversion is a price-dynamics question',
    vol_control: { series: 'SPY', window_sessions: VOL_WINDOW, strata: ['low', 'mid', 'high'] },
    vol_tercile_boundaries: tercileBoundaries(hist.map(e => e.vol)),
    benchmark_conversion_rate: conversionRate(hist),
    forward_window_start: forwardWindowStart,
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    decision_rule: {
      gate1: 'n >= n_gate resolved forward episodes',
      gate2: 'pooled bootstrapDiffCI(historical, forward) on binary FIRE outcome has hi < 0',
      gate3: 'the same diff has hi < 0 in at least 2 of the 3 vol terciles',
      verdict: 'SUPPORTED iff gate1 AND gate2 AND gate3; UNDERPOWERED if !gate1; else NOT_SUPPORTED',
    },
    n_gate: nGate,
    secondary_not_gating: [
      'forward vs trailing-12-month historical rate',
      'C2/C3 shallow and deep return trends',
    ],
    expected_outcome: 'NOT_SUPPORTED',
    counts: { historical_total: hist.length, historical_resolved: histResolved.length },
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyFrontrunPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/coil-frontrun-prereg.mjs --episodes data/lab/coil-frontrun-episodes.json \
//        --forward-start 2026-07-09 --n-gate 200 --out data/lab/coil-frontrun-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const episodes = JSON.parse(readFileSync(flag('--episodes', 'data/lab/coil-frontrun-episodes.json'), 'utf8'));
    const forwardWindowStart = flag('--forward-start', null);
    if (!forwardWindowStart) { process.stderr.write('--forward-start YYYY-MM-DD is required\n'); process.exit(2); }
    const a = buildFrontrunPrereg({
      episodes, forwardWindowStart, nGate: Number(flag('--n-gate', '200')),
    });
    const out = flag('--out', 'data/lab/coil-frontrun-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash}, benchmark ${a.benchmark_conversion_rate}, historical resolved ${a.counts.historical_resolved})\n`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test scripts/coil-frontrun-prereg.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 6: Generate and force-add the real pre-registration**

Run (substitute today's ET date):

```bash
node scripts/coil-frontrun-prereg.mjs --episodes data/lab/coil-frontrun-episodes.json --forward-start 2026-07-09 --n-gate 200
```

Expected: `wrote data/lab/coil-frontrun-prereg.json (hash ..., benchmark 0.xx, historical resolved NNNN)`

`data/**` is gitignored, so the prereg must be **force-added** — this is the established convention (`data/lab/coil-prereg.json`, `coil-stop-prereg.json`, and `coil-timeout-prereg.json` are all tracked this way). An untracked pre-registration has a hollow hash guarantee.

```bash
git add -f data/lab/coil-frontrun-prereg.json
git add scripts/coil-frontrun-prereg.mjs scripts/coil-frontrun-prereg.test.mjs scripts/coil-threshold-prereg.mjs
git commit -m "feat(coil-frontrun): hash-locked pre-registration; export stable() for reuse"
```

- [ ] **Step 7: Verify it is actually tracked**

Run: `git ls-files data/lab/coil-frontrun-prereg.json`
Expected: the path is printed. If it prints nothing, the force-add failed — fix before continuing.

---

### Task 5: Exploratory historical diagnostic

Reports C1 (conversion, by year and tercile) plus C2/C3 (shallow and deep return trends). Discriminates the rival stories.

**Files:**
- Create: `scripts/coil-frontrun-diag.mjs`
- Test: `scripts/coil-frontrun-diag.test.mjs`
- Output: `docs/lab/coil-frontrun-diag-RESULTS.md`

**Interfaces:**
- Consumes: `tercileOf` (Task 2); `applyFriction`, `mean`, `bootstrapMeanCI`, `bootstrapDiffCI` from `scripts/coil-threshold-metrics.mjs`. (It does **not** use Task 4's `conversionRate` — it needs the bootstrap CI alongside the point estimate, which `bootstrapMeanCI` gives in one call.)
- Produces:
  - `conversionByYear(episodes) -> {[year]: {n, fire, bounce, rate, lo, hi}}`
  - `conversionByTercile(episodes, boundaries) -> {low|mid|high: {...}}`
  - `returnTrendByYear(instances, bps) -> {[year]: {shallow:{n,mean}, deep:{n,mean}, gap:{mean,lo,hi}}}`
  - `renderDiag(...) -> string` (markdown)

`bootstrapMeanCI` takes `{date, net}` rows and simply means `net`. A **binary** `net ∈ {0,1}` therefore yields a conversion-rate CI directly — no new statistics code.

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-frontrun-diag.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversionByYear, conversionByTercile, returnTrendByYear, renderDiag } from './coil-frontrun-diag.mjs';

const ep = (date, outcome, vol = 0.01) => ({ ticker: 'AAA', date, outcome, vol, rsi2: 9, bars: 2 });

test('conversionByYear buckets by calendar year and reports n/fire/bounce/rate', () => {
  const eps = [
    ep('2021-03-01', 'FIRE'), ep('2021-04-01', 'BOUNCE'),
    ep('2021-05-01', 'UNRESOLVED'),                       // excluded from the rate
    ep('2022-03-01', 'BOUNCE'), ep('2022-04-01', 'BOUNCE'),
  ];
  const r = conversionByYear(eps);
  assert.equal(r['2021'].n, 2);
  assert.equal(r['2021'].fire, 1);
  assert.equal(r['2021'].rate, 0.5);
  assert.equal(r['2022'].rate, 0);
  assert.ok(Number.isFinite(r['2021'].lo) && Number.isFinite(r['2021'].hi));
});

test('conversionByTercile assigns on the frozen boundaries', () => {
  const b = { lo: 0.01, hi: 0.02 };
  const eps = [
    ep('2021-03-01', 'FIRE', 0.005), ep('2021-03-02', 'BOUNCE', 0.008),
    ep('2021-03-03', 'FIRE', 0.03),
  ];
  const r = conversionByTercile(eps, b);
  assert.equal(r.low.n, 2);
  assert.equal(r.low.rate, 0.5);
  assert.equal(r.high.n, 1);
  assert.equal(r.high.rate, 1);
  assert.equal(r.mid.n, 0);
});

test('conversionByTercile ignores episodes with a null vol', () => {
  const b = { lo: 0.01, hi: 0.02 };
  const eps = [ep('2021-03-01', 'FIRE', null), ep('2021-03-02', 'FIRE', 0.005)];
  assert.equal(conversionByTercile(eps, b).low.n, 1);
});

test('returnTrendByYear separates shallow from deep and reports the gap', () => {
  const inst = [
    { date: '2021-03-01', bucket: '[0,5)', grossReturn: 0.02, censored: false },
    { date: '2021-03-02', bucket: '[0,5)', grossReturn: 0.01, censored: false },
    { date: '2021-03-03', bucket: '[8,10)', grossReturn: 0.00, censored: false },
    { date: '2021-03-04', bucket: '[10,15)', grossReturn: -0.01, censored: false },
    { date: '2021-03-05', bucket: '[5,8)', grossReturn: 0.00, censored: true },  // excluded
  ];
  const r = returnTrendByYear(inst, 20);
  assert.equal(r['2021'].deep.n, 2);
  assert.equal(r['2021'].shallow.n, 2);
  // net = gross - 0.0020
  assert.ok(Math.abs(r['2021'].deep.mean - (0.015 - 0.002)) < 1e-12);
  assert.ok(Math.abs(r['2021'].shallow.mean - (-0.005 - 0.002)) < 1e-12);
  assert.ok(r['2021'].gap.mean < 0, 'shallow underperforms deep in this fixture');
});

test('renderDiag emits the mandatory EXPLORATORY banner and per-cell n', () => {
  const md = renderDiag({
    byYear: { 2021: { n: 2, fire: 1, bounce: 1, rate: 0.5, lo: 0, hi: 1 } },
    byTercile: { low: { n: 2, fire: 1, bounce: 1, rate: 0.5, lo: 0, hi: 1 }, mid: { n: 0, fire: 0, bounce: 0, rate: null, lo: null, hi: null }, high: { n: 0, fire: 0, bounce: 0, rate: null, lo: null, hi: null } },
    returns: { 2021: { shallow: { n: 2, mean: -0.007 }, deep: { n: 2, mean: 0.013 }, gap: { mean: -0.02, lo: -0.05, hi: 0.01 } } },
    prereg: { artifact_hash: 'abc12345', benchmark_conversion_rate: 0.5 },
  });
  assert.match(md, /EXPLORATORY/);
  assert.match(md, /holdout was already spent/);
  assert.match(md, /must not drive a live Coil change/i);
  assert.match(md, /\| 2021 \| 2 \|/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-frontrun-diag.test.mjs`
Expected: FAIL — `Cannot find module './coil-frontrun-diag.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-frontrun-diag.mjs`:

```js
// scripts/coil-frontrun-diag.mjs
// EXPLORATORY historical diagnostic for the front-run thesis.
//
// C1 — conversion rate by year and vol tercile (the mechanism; a count statistic, real power).
// C2/C3 — shallow and deep friction-net return trends (the economics; a return statistic,
//         almost no power). Reported because their DIRECTIONS discriminate the rival stories:
//           operator's story    -> shallow up,  deep flat  => enter earlier
//           adverse selection   -> shallow flat, deep down => do NOT enter earlier
//           mechanism-only      -> both flat               => change nothing
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFriction, mean, bootstrapMeanCI, bootstrapDiffCI } from './coil-threshold-metrics.mjs';
import { tercileOf } from './coil-frontrun-vol.mjs';

const BOOT = { blockSessions: 15, iterations: 10000, seed: 1234 };
const RESOLVED = (e) => e.outcome === 'FIRE' || e.outcome === 'BOUNCE';
const binRows = (eps) => eps.map(e => ({ date: e.date, net: e.outcome === 'FIRE' ? 1 : 0 }));

function convCell(eps) {
  const r = eps.filter(RESOLVED);
  if (!r.length) return { n: 0, fire: 0, bounce: 0, rate: null, lo: null, hi: null };
  const ci = bootstrapMeanCI(binRows(r), BOOT);
  return {
    n: r.length,
    fire: r.filter(e => e.outcome === 'FIRE').length,
    bounce: r.filter(e => e.outcome === 'BOUNCE').length,
    rate: ci.mean, lo: ci.lo, hi: ci.hi,
  };
}

export function conversionByYear(episodes) {
  const out = {};
  for (const y of [...new Set(episodes.map(e => e.date.slice(0, 4)))].sort()) {
    out[y] = convCell(episodes.filter(e => e.date.startsWith(y)));
  }
  return out;
}

export function conversionByTercile(episodes, boundaries) {
  const out = {};
  for (const t of ['low', 'mid', 'high']) {
    out[t] = convCell(episodes.filter(e => tercileOf(e.vol, boundaries) === t));
  }
  return out;
}

export function returnTrendByYear(instances, bps = 20) {
  const usable = instances.filter(r => !r.censored && Number.isFinite(r.grossReturn));
  const out = {};
  for (const y of [...new Set(usable.map(r => r.date.slice(0, 4)))].sort()) {
    const rows = usable.filter(r => r.date.startsWith(y));
    const toRows = (rs) => rs.map(r => ({ date: r.date, net: applyFriction(r.grossReturn, bps) }));
    const deep = toRows(rows.filter(r => r.bucket === '[0,5)'));
    const shallow = toRows(rows.filter(r => r.bucket !== '[0,5)'));
    const gap = (deep.length && shallow.length)
      ? bootstrapDiffCI(deep, shallow, BOOT)      // CI on (shallow - deep)
      : { mean: null, lo: null, hi: null };
    out[y] = {
      deep: { n: deep.length, mean: mean(deep.map(r => r.net)) },
      shallow: { n: shallow.length, mean: mean(shallow.map(r => r.net)) },
      gap: { mean: gap.mean, lo: gap.lo, hi: gap.hi },
    };
  }
  return out;
}

const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%');
const rate = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');

export function renderDiag({ byYear, byTercile, returns, prereg }) {
  const L = [];
  L.push('# Coil Front-Run Diagnostic — Results', '');
  L.push('> **EXPLORATORY.** This sample\'s holdout was already spent on the RSI-threshold study');
  L.push('> (`08a17a3`). These results set a prior. They are **not** a confirmatory test and');
  L.push('> must not drive a live Coil change. The confirmatory test is the forward monitor');
  L.push('> (`coil-frontrun-monitor.mjs`), whose rule is frozen in prereg hash');
  L.push(`> \`${prereg.artifact_hash}\` with benchmark conversion rate ${rate(prereg.benchmark_conversion_rate)}.`, '');

  L.push('## C1 — conversion rate by year', '');
  L.push('`conversion = FIRE / (FIRE + BOUNCE)`. A **declining** rate is the front-run signature.', '');
  L.push('| year | n resolved | fire | bounce | rate | 95% CI |', '|---|---|---|---|---|---|');
  for (const [y, c] of Object.entries(byYear)) {
    L.push(`| ${y} | ${c.n} | ${c.fire} | ${c.bounce} | ${rate(c.rate)} | [${rate(c.lo)}, ${rate(c.hi)}] |`);
  }
  L.push('');

  L.push('## C1 — conversion rate by SPY volatility tercile', '');
  L.push('Low-vol regimes produce fewer deep-oversold events regardless of crowding. A decline that');
  L.push('appears **only** in one tercile is a volatility artifact, not front-running.', '');
  L.push('| tercile | n resolved | fire | bounce | rate | 95% CI |', '|---|---|---|---|---|---|');
  for (const t of ['low', 'mid', 'high']) {
    const c = byTercile[t];
    L.push(`| ${t} | ${c.n} | ${c.fire} | ${c.bounce} | ${rate(c.rate)} | [${rate(c.lo)}, ${rate(c.hi)}] |`);
  }
  L.push('');

  L.push('## C2 / C3 — shallow and deep friction-net edge by year', '');
  L.push('**Underpowered by construction** (per-trade σ ≈ 4–5%; MDE ≈ 1.6–2.0%/trade). Read the');
  L.push('*directions*, never the point estimates. Story discrimination:', '');
  L.push('- shallow ↑, deep flat → operator\'s story (crowd front-runs; entering earlier would pay)');
  L.push('- shallow flat, deep ↓ → adverse selection (only toxic dips reach RSI<5; do **not** enter earlier)');
  L.push('- both flat → mechanism-only (front-running real, edge already competed away; change nothing)', '');
  L.push('| year | deep n | deep net | shallow n | shallow net | gap (shallow−deep) | 95% CI |', '|---|---|---|---|---|---|---|');
  for (const [y, r] of Object.entries(returns)) {
    L.push(`| ${y} | ${r.deep.n} | ${pct(r.deep.mean)} | ${r.shallow.n} | ${pct(r.shallow.mean)} | ${pct(r.gap.mean)} | [${pct(r.gap.lo)}, ${pct(r.gap.hi)}] |`);
  }
  L.push('');

  L.push('## Limitations', '');
  L.push('- Exploratory: this sample\'s holdout is spent. No verdict is drawn here.');
  L.push('- Survivorship: today\'s 80-name universe only.');
  L.push('- Conversion uses **no earnings filter** (price-dynamics question); the return metrics do');
  L.push('  (they mirror Coil\'s tradeable set). The two populations therefore differ.');
  L.push('- Conversion measures **signal** conversion, not Coil fills — the ≤4-position cap means a');
  L.push('  converted signal need not become a Coil trade.');
  L.push('- Yearly deep-bucket n is ~80. Those CIs are wide. Do not over-read a single cell.');
  return L.join('\n');
}

// CLI: node scripts/coil-frontrun-diag.mjs
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const episodes = JSON.parse(readFileSync(flag('--episodes', 'data/lab/coil-frontrun-episodes.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/coil-frontrun-prereg.json'), 'utf8'));
    const instances = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-threshold-instances.json'), 'utf8'));
    const hist = episodes.filter(e => e.date < prereg.forward_window_start);
    const md = renderDiag({
      byYear: conversionByYear(hist),
      byTercile: conversionByTercile(hist, prereg.vol_tercile_boundaries),
      returns: returnTrendByYear(instances, 20),
      prereg,
    });
    const out = flag('--out', 'docs/lab/coil-frontrun-diag-RESULTS.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`wrote ${out}\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-frontrun-diag.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the real diagnostic**

Run: `node scripts/coil-frontrun-diag.mjs`
Expected: `wrote docs/lab/coil-frontrun-diag-RESULTS.md`

- [ ] **Step 6: Commit**

```bash
git add scripts/coil-frontrun-diag.mjs scripts/coil-frontrun-diag.test.mjs docs/lab/coil-frontrun-diag-RESULTS.md
git commit -m "feat(coil-frontrun): exploratory historical diagnostic (C1 conversion + C2/C3 return trends)"
```

- [ ] **Step 7: Report the result to the operator**

Summarise, in this order:
1. The C1 yearly conversion series — is it declining, and by how much relative to its CIs?
2. Whether any decline survives the tercile decomposition, or is confined to one vol stratum.
3. The C2/C3 directions, and which of the three stories they favour.
4. **Whether a pre-existing decline is already visible in history.** If so, say plainly that the forward monitor's primary test can be satisfied by trend continuation alone, and that the trailing-12-month secondary comparison is the one to watch.

---

### Task 6: Confirmatory forward monitor

Reads the frozen prereg, splits episodes at `forward_window_start`, applies the pre-registered decision rule. Refuses to emit a verdict on hash mismatch.

**Files:**
- Create: `scripts/coil-frontrun-monitor.mjs`
- Test: `scripts/coil-frontrun-monitor.test.mjs`
- Output: `docs/lab/coil-frontrun-monitor-RESULTS.md`

**Interfaces:**
- Consumes: `verifyFrontrunPrereg` (Task 4), `tercileOf` (Task 2), `bootstrapDiffCI` from `scripts/coil-threshold-metrics.mjs`.
- Produces:
  - `decideFrontrun({nForward, pooled, byTercile, nGate}) -> {verdict, reason, gate1, gate2, gate3}`
  - `monitor(episodes, prereg) -> {nForward, nHistorical, forwardRate, pooled, byTercile, trailing12, trailing12Rate, decision, mde}` — throws on prereg hash mismatch
  - `renderMonitor({prereg, result}) -> string`

`bootstrapDiffCI(A, B)` returns a CI on `mean(B) − mean(A)`. Pass `A = historical`, `B = forward`, so a **negative** interval means forward conversion is lower. Historical and forward dates are disjoint, so their date-blocks are disjoint; each bootstrap iteration still resamples both groups.

- [ ] **Step 1: Write the failing test**

Create `scripts/coil-frontrun-monitor.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFrontrun, monitor, renderMonitor } from './coil-frontrun-monitor.mjs';
import { buildFrontrunPrereg } from './coil-frontrun-prereg.mjs';

const CI = (lo, hi) => ({ lo, hi, mean: (lo + hi) / 2, nA: 100, nB: 100 });

test('decideFrontrun: UNDERPOWERED below the n gate, regardless of the CI', () => {
  const d = decideFrontrun({
    nForward: 10, pooled: CI(-0.30, -0.10),
    byTercile: { low: CI(-0.3, -0.1), mid: CI(-0.3, -0.1), high: CI(-0.3, -0.1) }, nGate: 200,
  });
  assert.equal(d.verdict, 'UNDERPOWERED');
  assert.match(d.reason, /n=10/);
});

test('decideFrontrun: SUPPORTED needs pooled hi<0 AND >=2 of 3 terciles hi<0', () => {
  const d = decideFrontrun({
    nForward: 500, pooled: CI(-0.20, -0.05),
    byTercile: { low: CI(-0.3, -0.1), mid: CI(-0.3, -0.05), high: CI(-0.1, 0.2) }, nGate: 200,
  });
  assert.equal(d.verdict, 'SUPPORTED');
  assert.equal(d.gate3, true);
});

test('decideFrontrun: a pooled effect confined to ONE tercile is NOT_SUPPORTED', () => {
  const d = decideFrontrun({
    nForward: 500, pooled: CI(-0.20, -0.02),
    byTercile: { low: CI(-0.4, -0.2), mid: CI(-0.1, 0.1), high: CI(-0.1, 0.2) }, nGate: 200,
  });
  assert.equal(d.verdict, 'NOT_SUPPORTED');
  assert.equal(d.gate3, false);
});

test('decideFrontrun: a pooled CI straddling zero is NOT_SUPPORTED', () => {
  const d = decideFrontrun({
    nForward: 500, pooled: CI(-0.20, 0.05),
    byTercile: { low: CI(-0.3, -0.1), mid: CI(-0.3, -0.1), high: CI(-0.3, -0.1) }, nGate: 200,
  });
  assert.equal(d.verdict, 'NOT_SUPPORTED');
  assert.equal(d.gate2, false);
});

test('decideFrontrun: a null tercile CI counts as not-passing, never as passing', () => {
  const d = decideFrontrun({
    nForward: 500, pooled: CI(-0.20, -0.05),
    byTercile: { low: CI(-0.3, -0.1), mid: { lo: null, hi: null }, high: { lo: null, hi: null } }, nGate: 200,
  });
  assert.equal(d.verdict, 'NOT_SUPPORTED');
});

test('monitor refuses to run on a tampered prereg', () => {
  const eps = [
    { ticker: 'A', date: '2021-01-04', outcome: 'FIRE', vol: 0.01 },
    { ticker: 'A', date: '2021-01-05', outcome: 'BOUNCE', vol: 0.02 },
    { ticker: 'A', date: '2021-01-06', outcome: 'BOUNCE', vol: 0.03 },
  ];
  const p = buildFrontrunPrereg({ episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z' });
  p.n_gate = 5;
  assert.throws(() => monitor(eps, p), /prereg hash mismatch/);
});

test('monitor splits at forward_window_start and reports nForward', () => {
  const eps = [];
  for (let i = 0; i < 40; i += 1) eps.push({ ticker: 'A', date: `2021-02-${String((i % 27) + 1).padStart(2, '0')}`, outcome: i % 2 ? 'FIRE' : 'BOUNCE', vol: 0.01 });
  const p = buildFrontrunPrereg({ episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z' });
  const fwd = [{ ticker: 'A', date: '2026-08-01', outcome: 'BOUNCE', vol: 0.01 }];
  const r = monitor([...eps, ...fwd], p);
  assert.equal(r.nForward, 1);
  assert.equal(r.decision.verdict, 'UNDERPOWERED');
});

test('monitor reports a trailing-12-month rate distinct from the pooled benchmark', () => {
  const eps = [];
  // Old history: all FIRE (high conversion).
  for (let i = 0; i < 20; i += 1) eps.push({ ticker: 'A', date: `2022-03-${String(i + 1).padStart(2, '0')}`, outcome: 'FIRE', vol: 0.01 });
  // The 12 months before the window: all BOUNCE (rate already 0).
  for (let i = 0; i < 20; i += 1) eps.push({ ticker: 'A', date: `2026-03-${String(i + 1).padStart(2, '0')}`, outcome: 'BOUNCE', vol: 0.01 });
  const p = buildFrontrunPrereg({ episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z' });
  assert.equal(p.benchmark_conversion_rate, 0.5);        // pooled benchmark
  const fwd = [{ ticker: 'A', date: '2026-08-01', outcome: 'BOUNCE', vol: 0.01 }];
  const r = monitor([...eps, ...fwd], p);
  // The decline is entirely pre-existing: the trailing-12m rate is already 0, so a "forward < pooled"
  // result would be pure trend continuation. This is exactly what the secondary comparison surfaces.
  assert.equal(r.trailing12Rate, 0);
  assert.notEqual(r.trailing12Rate, p.benchmark_conversion_rate);
  assert.ok(r.trailing12);
});

test('renderMonitor states the verdict, the n gate, and the trend-continuation caveat', () => {
  const md = renderMonitor({
    prereg: { artifact_hash: 'abc12345', n_gate: 200, benchmark_conversion_rate: 0.2, forward_window_start: '2026-07-09' },
    result: {
      nForward: 5, nHistorical: 40, forwardRate: 0.2,
      pooled: { lo: -0.1, hi: 0.1, mean: 0 },
      byTercile: { low: { lo: null, hi: null }, mid: { lo: null, hi: null }, high: { lo: null, hi: null } },
      trailing12: { lo: null, hi: null, mean: null }, trailing12Rate: 0.1,
      decision: { verdict: 'UNDERPOWERED', reason: 'n=5 < 200', gate1: false, gate2: false, gate3: false },
      mde: 0.05,
    },
  });
  assert.match(md, /UNDERPOWERED/);
  assert.match(md, /trend continuation/i);
  assert.match(md, /trailing-12-month/i);
  assert.match(md, /abc12345/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/coil-frontrun-monitor.test.mjs`
Expected: FAIL — `Cannot find module './coil-frontrun-monitor.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `scripts/coil-frontrun-monitor.mjs`:

```js
// scripts/coil-frontrun-monitor.mjs
// CONFIRMATORY forward monitor for the front-run thesis. Reads the frozen pre-registration,
// splits episodes at forward_window_start, and applies the pre-registered decision rule.
// Refuses to emit a verdict on a prereg-hash mismatch.
//
// A SUPPORTED verdict licenses exactly one thing: proposing a separate, pre-registered
// threshold study with a fresh holdout. It does NOT license changing Coil, and it does not
// imply "enter earlier" — see the spec's rival-stories table.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapDiffCI } from './coil-threshold-metrics.mjs';
import { tercileOf } from './coil-frontrun-vol.mjs';
import { verifyFrontrunPrereg } from './coil-frontrun-prereg.mjs';

const RESOLVED = (e) => e.outcome === 'FIRE' || e.outcome === 'BOUNCE';
const binRows = (eps) => eps.map(e => ({ date: e.date, net: e.outcome === 'FIRE' ? 1 : 0 }));
const passes = (ci) => !!(ci && Number.isFinite(ci.hi) && ci.hi < 0);

export function decideFrontrun({ nForward, pooled, byTercile, nGate }) {
  const gate1 = nForward >= nGate;
  if (!gate1) return { verdict: 'UNDERPOWERED', reason: `n=${nForward} < ${nGate}`, gate1, gate2: false, gate3: false };
  const gate2 = passes(pooled);
  const nPass = ['low', 'mid', 'high'].filter(t => passes(byTercile[t])).length;
  const gate3 = nPass >= 2;
  if (gate2 && gate3) return { verdict: 'SUPPORTED', reason: `pooled hi<0 and ${nPass}/3 terciles hi<0`, gate1, gate2, gate3 };
  return { verdict: 'NOT_SUPPORTED', reason: `gate2=${gate2} gate3=${gate3} (${nPass}/3 terciles)`, gate1, gate2, gate3 };
}

export function monitor(episodes, prereg) {
  const v = verifyFrontrunPrereg(prereg);
  if (!v.ok) throw new Error(`prereg hash mismatch (expected ${v.expected}, found ${v.found})`);

  const boot = {
    blockSessions: prereg.bootstrap.block_sessions,
    iterations: prereg.bootstrap.iterations,
    seed: prereg.bootstrap.seed,
  };
  const start = prereg.forward_window_start;
  const hist = episodes.filter(e => e.date < start && RESOLVED(e));
  const fwd = episodes.filter(e => e.date >= start && RESOLVED(e));

  const pooled = (hist.length && fwd.length) ? bootstrapDiffCI(binRows(hist), binRows(fwd), boot) : { lo: null, hi: null, mean: null };
  const byTercile = {};
  for (const t of ['low', 'mid', 'high']) {
    const h = hist.filter(e => tercileOf(e.vol, prereg.vol_tercile_boundaries) === t);
    const f = fwd.filter(e => tercileOf(e.vol, prereg.vol_tercile_boundaries) === t);
    byTercile[t] = (h.length && f.length) ? bootstrapDiffCI(binRows(h), binRows(f), boot) : { lo: null, hi: null, mean: null };
  }

  // SECONDARY, never decision-gating: forward vs the TRAILING-12-MONTH historical rate.
  // This is the guard against trend continuation — if the pooled benchmark was already falling,
  // the primary test can be satisfied without any new front-running.
  // Same month/day one year earlier; string comparison only, so no Date math is needed.
  const t12Start = `${Number(start.slice(0, 4)) - 1}${start.slice(4)}`;
  const hist12 = hist.filter(e => e.date >= t12Start);
  const trailing12 = (hist12.length && fwd.length)
    ? bootstrapDiffCI(binRows(hist12), binRows(fwd), boot)
    : { lo: null, hi: null, mean: null };
  const trailing12Rate = hist12.length ? hist12.filter(e => e.outcome === 'FIRE').length / hist12.length : null;

  const decision = decideFrontrun({ nForward: fwd.length, pooled, byTercile, nGate: prereg.n_gate });
  // Realized MDE: half the pooled CI width — the smallest shift this run could have detected.
  const mde = (pooled.lo != null && pooled.hi != null) ? (pooled.hi - pooled.lo) / 2 : null;
  const forwardRate = fwd.length ? fwd.filter(e => e.outcome === 'FIRE').length / fwd.length : null;

  return {
    nForward: fwd.length, nHistorical: hist.length, forwardRate,
    pooled, byTercile, trailing12, trailing12Rate, decision, mde,
  };
}

const rate = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
const pp = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + 'pp');

export function renderMonitor({ prereg, result }) {
  const L = [];
  L.push('# Coil Front-Run Monitor — Results', '');
  L.push(`**Verdict: ${result.decision.verdict}** — ${result.decision.reason}`, '');
  L.push(`Pre-registered rule, hash \`${prereg.artifact_hash}\`. Forward window opens \`${prereg.forward_window_start}\`.`);
  L.push(`Benchmark (historical) conversion rate: **${rate(prereg.benchmark_conversion_rate)}**. Expected outcome: NOT_SUPPORTED.`, '');

  L.push('## Forward window', '');
  L.push(`- resolved forward episodes: **${result.nForward}** (gate: n ≥ ${prereg.n_gate})`);
  L.push(`- forward conversion rate: **${rate(result.forwardRate)}**`);
  L.push(`- pooled diff (forward − historical): ${pp(result.pooled.mean)}, 95% CI [${pp(result.pooled.lo)}, ${pp(result.pooled.hi)}]`);
  L.push(`- realized MDE at this n: ${pp(result.mde)}`, '');

  L.push('## Vol-tercile decomposition (gate 3: ≥2 of 3 with hi < 0)', '');
  L.push('| tercile | diff | 95% CI | passes |', '|---|---|---|---|');
  for (const t of ['low', 'mid', 'high']) {
    const c = result.byTercile[t];
    const ok = !!(c && Number.isFinite(c.hi) && c.hi < 0);
    L.push(`| ${t} | ${pp(c.mean)} | [${pp(c.lo)}, ${pp(c.hi)}] | ${ok ? 'yes' : 'no'} |`);
  }
  L.push('');

  L.push('## Secondary — forward vs trailing-12-month history (never decision-gating)', '');
  L.push(`- trailing-12-month historical conversion rate: **${rate(result.trailing12Rate)}**`);
  L.push(`- pooled benchmark conversion rate: **${rate(prereg.benchmark_conversion_rate)}**`);
  L.push(`- diff (forward − trailing-12m): ${pp(result.trailing12.mean)}, 95% CI [${pp(result.trailing12.lo)}, ${pp(result.trailing12.hi)}]`, '');
  L.push('If the pooled benchmark sits well **above** the trailing-12-month rate, the primary test can be');
  L.push('satisfied by trend continuation alone. Compare the two before believing a SUPPORTED verdict.', '');

  L.push('## How to read this', '');
  L.push('- A SUPPORTED verdict licenses **one** thing: proposing a separate, pre-registered threshold');
  L.push('  study with a fresh holdout. It does **not** license changing Coil.');
  L.push('- **It does not mean "enter earlier."** Adverse selection predicts the same conversion decline');
  L.push('  while the deep-band edge decays. Read C2/C3 in the diagnostic to tell the stories apart.');
  L.push('- **Trend continuation is the live risk.** If the historical yearly series was already');
  L.push('  declining, "forward < pooled historical" can be satisfied by a pre-existing trend that has');
  L.push('  nothing to do with AI adoption. Check the yearly series in');
  L.push('  `docs/lab/coil-frontrun-diag-RESULTS.md` against the secondary comparison above.');
  return L.join('\n');
}

// CLI: node scripts/coil-frontrun-monitor.mjs
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const episodes = JSON.parse(readFileSync(flag('--episodes', 'data/lab/coil-frontrun-episodes.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/coil-frontrun-prereg.json'), 'utf8'));
    let result;
    try { result = monitor(episodes, prereg); }
    catch (e) { process.stderr.write(`REFUSING to score: ${e.message}\n`); process.exit(4); }
    const md = renderMonitor({ prereg, result });
    const out = flag('--out', 'docs/lab/coil-frontrun-monitor-RESULTS.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${result.decision.verdict} (${result.decision.reason}). Wrote ${out}\n`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/coil-frontrun-monitor.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the monitor once to confirm it reports UNDERPOWERED**

Run: `node scripts/coil-frontrun-monitor.mjs`
Expected: `VERDICT: UNDERPOWERED (n=0 < 200). Wrote docs/lab/coil-frontrun-monitor-RESULTS.md`

The forward window opened today, so zero forward episodes exist. **UNDERPOWERED is the correct result.** If it reports anything else, the split is wrong — investigate before continuing.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. No previously-passing test may regress — especially `scripts/coil-threshold-prereg.test.mjs`, which is the one existing file this plan touched.

- [ ] **Step 7: Commit**

```bash
git add scripts/coil-frontrun-monitor.mjs scripts/coil-frontrun-monitor.test.mjs docs/lab/coil-frontrun-monitor-RESULTS.md
git commit -m "feat(coil-frontrun): pre-registered confirmatory forward monitor"
```

---

## Operating the monitor

Re-run monthly. The episode file must be rebuilt first so new bars are picked up:

```bash
node scripts/coil-frontrun-build.mjs
node scripts/coil-frontrun-monitor.mjs
```

It emits `UNDERPOWERED` until `n ≥ 200` resolved forward episodes accrue — roughly one year at the historical episode rate. **Never edit `data/lab/coil-frontrun-prereg.json` after the forward window opens.** The hash check exists to make that failure loud; if you have a genuine reason to change the rule, the honest move is a new prereg with a new `forward_window_start`, discarding the accrued window.

## What this plan deliberately does not do

- It does not change Coil's RSI threshold, universe, or exits.
- It does not build the inverse-veto ledger — that is Plan 2 (`2026-07-09-coil-inverse-veto-ledger.md`), which depends on Task 1's enumerator.
- It does not re-test C2 (whether the shallow band is profitable). `08a17a3` already answered that: **KEEP**, shallow nets ≈ +0.06%/trade against +0.59% for Coil's own band.
