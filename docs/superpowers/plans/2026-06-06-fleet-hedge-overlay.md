# Fleet Hedge-Overlay Lab Study Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pre-registered, lab-only study that ranks four equity-selloff hedges (def-Prophet put-spread proxy, static GLD, static TLT, static VIXM) by cost-adjusted crash efficiency — calm-period drag vs regime-split crash cushion — against both the user's reconstructed Merrill book and QQQ, emitting a recommendation doc (or honest null). No deploy, no live-agent impact.

**Architecture:** New `overlay-*.mjs` modules under `scripts/`, reusing the S1 fleet engine (`fleet-align`, `fleet-correlate`, `fleet-bars`, `fleet-defensive-proxy`, `fleet-prereg`/`fleet-report` idioms) and the S3 treasury-curve loader idiom. Pure modules are unit-tested with `node:test`; two controller-authored CLIs (`overlay-fetch`, `overlay-score`) are data-coupled and run manually. All data in an isolated `data/lab/overlay-cache/` (gitignored); only `docs/lab/fleet-hedge-overlay-{RESULTS,RUNBOOK}.md` are committed.

**Tech Stack:** Node.js ESM, `node:test`, FMP `stable/historical-price-eod/full` + `stable/treasury-rates`, sha256 pre-registration.

**Spec:** `docs/superpowers/specs/2026-06-06-fleet-hedge-overlay-design.md` (read it first).

---

## Prerequisites (execution-time, before Task 1)

- Worktree created off **local `main`** via `superpowers:using-git-worktrees` (memory `shared-root-worktree-collision`). All paths below are relative to the worktree root.
- The spec file currently exists **untracked in the root checkout only**. Copy it into the worktree and commit it as the branch base:
  ```bash
  # from the worktree root; <ROOT> = the main checkout path
  cp "<ROOT>/docs/superpowers/specs/2026-06-06-fleet-hedge-overlay-design.md" docs/superpowers/specs/
  cp "<ROOT>/docs/superpowers/plans/2026-06-06-fleet-hedge-overlay.md" docs/superpowers/plans/
  git add docs/superpowers/specs/2026-06-06-fleet-hedge-overlay-design.md docs/superpowers/plans/2026-06-06-fleet-hedge-overlay.md
  git commit -m "docs(overlay): hedge-overlay study spec + plan (Subproject 4)"
  ```
- Confirm `data/lab/` is gitignored (it is — verify `git check-ignore data/lab/x` prints the path).
- Reused modules live on local `main`; do not modify them. Bar shape from `loadFleetBars`/`parseBarsWithVolume`: `[{date:'YYYY-MM-DD', open, high, low, close, volume}]` ascending. Lane series shape: `[{date, ret, active}]`. Weekly shape (`toWeekly`): `[{week, date, ret, active}]`.

---

## Task 1: `overlay-universe.mjs` — holdings parse + instrument lists

**Files:**
- Create: `scripts/overlay-universe.mjs`
- Test: `scripts/overlay-universe.test.mjs`

The Holdings CSV has quoted fields containing commas inside numbers (`"4,209.90"`) and parenthesized negatives (`"(213.55)"`). We only need `Symbol`, `Quantity`, `Value ($)`. Exclude the cash row (`Symbol` is `--`). Map `VFIAX → VOO` at parse time. Keep tiny weights.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHoldings, OVERLAY_CACHE_SUBDIR, CANDIDATES } from './overlay-universe.mjs';

const SAMPLE = [
  '"COB Date","Security #","Symbol","CUSIP #","Security Description","Account Nickname","Account Registration","Account #","Quantity","Price ($)","Value ($)","Unrealized Gain/Loss ($)","Unrealized Gain/Loss (%)","Cumulative Investment Return ($)","Cumulative Investment Return (%)","Accrued Interest ($)"',
  '"5/18/2026","00415","AMD","007903107","ADVNCD MICRO D INC","--","CMA-Edge","27Z-89R00","10","420.99","4,209.90","3,003.25","248.89","--","--","--"',
  '"5/18/2026","9T2U4","VFIAX","922908710","VANGUARD 500 INDEX FUND","--","CMA-Edge","27Z-89R00","3.124","684.05","2,136.98","620.02","40.87","668.23","45.50","--"',
  '"5/18/2026","94SX0","--","990156937","ML DIRECT DEPOSIT PROGRM","--","CMA-Edge","27Z-89R00","774","1.00","774.00","--","--","--","--","--"',
].join('\n');

test('parseHoldings extracts symbol+value, maps VFIAX→VOO, drops cash row', () => {
  const h = parseHoldings(SAMPLE);
  assert.equal(h.length, 2);
  const amd = h.find((x) => x.symbol === 'AMD');
  assert.equal(amd.value, 4209.90);
  assert.ok(h.find((x) => x.symbol === 'VOO')); // VFIAX remapped
  assert.ok(!h.find((x) => x.symbol === '--'));
});

test('CANDIDATES + cache subdir are defined', () => {
  assert.match(OVERLAY_CACHE_SUBDIR, /overlay-cache/);
  assert.deepEqual(CANDIDATES.map((c) => c.id).sort(), ['def_prophet', 'gld', 'tlt', 'vixm']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-universe.test.mjs`
Expected: FAIL ("Cannot find module './overlay-universe.mjs'").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-universe.mjs
// Source of truth for the hedge-overlay study: parse the Merrill Holdings CSV into
// {symbol,value} weights, and declare the four hedge candidates + isolated cache dir.
import { join } from 'node:path';

export const OVERLAY_CACHE_SUBDIR = join('data', 'lab', 'overlay-cache');

// VFIAX (mutual fund, no clean FMP daily bar) → VOO proxy (spec §3.1).
const SYMBOL_REMAP = { VFIAX: 'VOO' };

// Candidates (spec §4). `kind` drives funding/convexity handling downstream.
export const CANDIDATES = [
  { id: 'def_prophet', label: 'def-Prophet proxy', kind: 'spread', sizes: [0.005, 0.01, 0.02], convex: true },
  { id: 'gld', label: 'Static GLD', kind: 'static', ticker: 'GLD', sizes: [0.025, 0.05, 0.10, 0.15, 0.20], convex: false },
  { id: 'tlt', label: 'Static TLT', kind: 'static', ticker: 'TLT', sizes: [0.025, 0.05, 0.10, 0.15, 0.20], convex: false },
  { id: 'vixm', label: 'Static VIXM', kind: 'static', ticker: 'VIXM', sizes: [0.025, 0.05, 0.10, 0.15, 0.20], convex: true },
];

// One CSV record line → array of fields, honoring double-quoted fields (commas inside quotes kept).
function splitCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// "4,209.90" → 4209.90 ; "(213.55)" → -213.55 ; "--" → null
function parseMoney(s) {
  const t = String(s).trim();
  if (!t || t === '--') return null;
  const neg = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[(),]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

export function parseHoldings(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]);
  const iSym = header.indexOf('Symbol');
  const iVal = header.indexOf('Value ($)');
  const iQty = header.indexOf('Quantity');
  const out = [];
  for (let r = 1; r < lines.length; r += 1) {
    const f = splitCsvLine(lines[r]);
    let symbol = (f[iSym] || '').trim();
    if (!symbol || symbol === '--') continue;          // cash / non-security row
    symbol = SYMBOL_REMAP[symbol] || symbol;
    const value = parseMoney(f[iVal]);
    if (value == null || value <= 0) continue;
    out.push({ symbol, quantity: parseMoney(f[iQty]), value });
  }
  // Collapse duplicate symbols (e.g. VFIAX+VOO both → VOO) by summing value.
  const merged = new Map();
  for (const h of out) merged.set(h.symbol, (merged.get(h.symbol) || 0) + h.value);
  return [...merged.entries()].map(([symbol, value]) => ({ symbol, value }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/overlay-universe.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-universe.mjs scripts/overlay-universe.test.mjs
git commit -m "feat(overlay): holdings CSV parser + candidate/cache definitions"
```

---

## Task 2: `overlay-fetch.mjs` — FMP backfill CLI (controller-authored, no unit test)

**Files:**
- Create: `scripts/overlay-fetch.mjs`

Mirror `scripts/fleet-fetch-bars.mjs`. Fetch: every book ticker from the latest `data/portfolio/Holdings_*.csv`, the candidate ETFs (`GLD`,`TLT`,`VIXM`), `QQQ`, plus the treasury curve; write to `data/lab/overlay-cache/`. Record true earliest bar date per ticker into `overlay-cache/_earliest.json` (feeds Task 0 / §13). This is run manually with `FMP_API_KEY` sourced; no unit test (network).

- [ ] **Step 1: Write the script**

```javascript
// scripts/overlay-fetch.mjs
// One-shot FMP backfill → data/lab/overlay-cache/. Bars: noon-UTC timestamps (etDate round-trip,
// see fleet-bars). Treasury curve: {curve:[{date,m3,y2,y5,y7,y10,y30}]}. Records earliest dates.
// Run: node scripts/overlay-fetch.mjs   (source project-root .env first for FMP_API_KEY)
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fmpEodToBars } from './ema-bars.mjs';
import { OVERLAY_CACHE_SUBDIR, CANDIDATES, parseHoldings } from './overlay-universe.mjs';

const FROM = '2014-01-01';
const KEY = process.env.FMP_API_KEY;

function latestHoldingsPath(root) {
  const dir = join(root, 'data', 'portfolio');
  const files = readdirSync(dir).filter((f) => /^Holdings_.*\.csv$/.test(f)).sort();
  if (!files.length) throw new Error('no Holdings_*.csv in data/portfolio');
  return join(dir, files[files.length - 1]);
}

async function fetchBars(ticker, to) {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  return fmpEodToBars(await res.json());
}

async function fetchCurve(to) {
  const url = `https://financialmodelingprep.com/stable/treasury-rates?from=${FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`treasury: HTTP ${res.status}`);
  const raw = await res.json();
  const curve = raw.map((r) => ({
    date: r.date, m3: r.month3 ?? null, y2: r.year2 ?? null, y5: r.year5 ?? null,
    y7: r.year7 ?? null, y10: r.year10 ?? null, y30: r.year30 ?? null,
  })).sort((a, b) => (a.date < b.date ? -1 : 1));
  return curve;
}

{
  if (!KEY) { process.stderr.write('FMP_API_KEY not set — source project-root .env first.\n'); process.exit(2); }
  const root = process.cwd();
  const to = new Date().toISOString().slice(0, 10);
  mkdirSync(join(root, OVERLAY_CACHE_SUBDIR), { recursive: true });

  const holdings = parseHoldings(readFileSync(latestHoldingsPath(root), 'utf8'));
  const etfs = CANDIDATES.filter((c) => c.ticker).map((c) => c.ticker);
  const tickers = [...new Set([...holdings.map((h) => h.symbol), ...etfs, 'QQQ'])];

  const earliest = {};
  let ok = 0, fail = 0;
  for (const t of tickers) {
    try {
      const bars = await fetchBars(t, to);
      if (bars.length) earliest[t] = bars[0].date;
      writeFileSync(join(root, OVERLAY_CACHE_SUBDIR, `${t}.json`),
        JSON.stringify({ written_at: new Date().toISOString(),
          bars: bars.map((b) => ({ Timestamp: `${b.date}T12:00:00Z`, Open: b.open, High: b.high, Low: b.low, Close: b.close, Volume: b.volume })) }));
      ok += 1; process.stdout.write(`${t}: ${bars.length} bars\n`);
    } catch (e) { fail += 1; process.stderr.write(`${e.message}\n`); }
  }
  try {
    const curve = await fetchCurve(to);
    writeFileSync(join(root, OVERLAY_CACHE_SUBDIR, 'treasury-rates.json'), JSON.stringify({ written_at: new Date().toISOString(), curve }));
    earliest.__curve = curve.length ? curve[0].date : null;
    process.stdout.write(`treasury: ${curve.length} rows\n`);
  } catch (e) { fail += 1; process.stderr.write(`${e.message}\n`); }

  writeFileSync(join(root, OVERLAY_CACHE_SUBDIR, '_earliest.json'), JSON.stringify(earliest, null, 2));
  process.stdout.write(`\noverlay-fetch done: ${ok}/${tickers.length} ok, ${fail} failed\n`);
}
```

- [ ] **Step 2: Verify it parses (no run — needs key/network)**

Run: `node --check scripts/overlay-fetch.mjs`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add scripts/overlay-fetch.mjs
git commit -m "feat(overlay): FMP backfill CLI for book tickers + candidates + treasury curve"
```

---

## Task 3: `overlay-book.mjs` — reconstructed book weekly returns

**Files:**
- Create: `scripts/overlay-book.mjs`
- Test: `scripts/overlay-book.test.mjs`

Build the daily book return series with **dynamic weekly (here: daily) renormalization** — each day, use only holdings with a bar that day AND the prior trading day, weight = value renormalized over the available set. Also report dropped-weight fraction per year. Takes a `barsByTicker` Map (so it's pure/testable).

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-book.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookDaily, droppedWeightByYear } from './overlay-book.mjs';

// Two holdings; B has no bar on day 2 → that day weights 100% A (renormalized).
const bars = new Map([
  ['A', [{ date: '2020-01-02', close: 100 }, { date: '2020-01-03', close: 110 }, { date: '2020-01-06', close: 121 }]],
  ['B', [{ date: '2020-01-02', close: 50 }, { date: '2020-01-06', close: 60 }]],
]);
const holdings = [{ symbol: 'A', value: 50 }, { symbol: 'B', value: 50 }];

test('bookDaily renormalizes over available names each day', () => {
  const s = bookDaily(holdings, bars, { start: '2020-01-01', end: '2020-12-31' });
  // 2020-01-03: only A has prior+today bar → ret = 110/100-1 = 0.10
  const d3 = s.find((p) => p.date === '2020-01-03');
  assert.ok(Math.abs(d3.ret - 0.10) < 1e-9);
  // 2020-01-06: A ret = 121/110-1=0.10 (prior day 01-03), B ret = 60/50-1=0.20 (prior available bar 01-02).
  // Equal weight 0.5/0.5 → 0.5*0.10 + 0.5*0.20 = 0.15
  const d6 = s.find((p) => p.date === '2020-01-06');
  assert.ok(Math.abs(d6.ret - 0.15) < 1e-9);
});

test('droppedWeightByYear reports fraction of book value with no bar that year', () => {
  const dw = droppedWeightByYear(holdings, bars, { start: '2020-01-01', end: '2020-12-31' });
  assert.ok(dw['2020'] >= 0 && dw['2020'] <= 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-book.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-book.mjs
// Reconstruct the Merrill book's daily return series from current value-weights, with daily
// renormalization over names that have a usable (prior + today) bar. Pure: takes a barsByTicker Map.
import { barsByDate } from './fleet-bars.mjs';

// Returns [{date, ret, active:true}] over [start,end]; ret = Σ w_i r_i renormalized over available names.
export function bookDaily(holdings, barsByTicker, { start, end } = {}) {
  const idx = new Map(); const arr = new Map();
  for (const h of holdings) { const b = barsByTicker.get(h.symbol) || []; idx.set(h.symbol, barsByDate(b)); arr.set(h.symbol, b); }
  const allDates = [...new Set(holdings.flatMap((h) => (barsByTicker.get(h.symbol) || []).map((b) => b.date)))]
    .filter((d) => (!start || d >= start) && (!end || d <= end)).sort();
  const series = [];
  for (const d of allDates) {
    let wsum = 0; const parts = [];
    for (const h of holdings) {
      const bi = idx.get(h.symbol).get(d); if (bi == null || bi < 1) continue;
      const b = arr.get(h.symbol);
      const r = b[bi].close / b[bi - 1].close - 1;
      parts.push({ w: h.value, r }); wsum += h.value;
    }
    if (!parts.length || wsum <= 0) continue;
    let ret = 0; for (const p of parts) ret += (p.w / wsum) * p.r;
    series.push({ date: d, ret, active: true });
  }
  return series;
}

// Mean fraction of book value (by year) whose names had NO bar that calendar year.
export function droppedWeightByYear(holdings, barsByTicker, { start, end } = {}) {
  const total = holdings.reduce((s, h) => s + h.value, 0) || 1;
  const years = new Set();
  for (const h of holdings) for (const b of (barsByTicker.get(h.symbol) || [])) {
    if ((!start || b.date >= start) && (!end || b.date <= end)) years.add(b.date.slice(0, 4));
  }
  const out = {};
  for (const y of [...years].sort()) {
    let present = 0;
    for (const h of holdings) {
      const has = (barsByTicker.get(h.symbol) || []).some((b) => b.date.slice(0, 4) === y);
      if (has) present += h.value;
    }
    out[y] = 1 - present / total;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/overlay-book.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-book.mjs scripts/overlay-book.test.mjs
git commit -m "feat(overlay): reconstructed-book daily returns with dynamic renormalization"
```

---

## Task 4: `overlay-regime.mjs` — rate-shock split, episodes, risk-free

**Files:**
- Create: `scripts/overlay-regime.mjs`
- Test: `scripts/overlay-regime.test.mjs`

From the treasury curve (loaded via `carry-bars`'s `loadCurve` shape `[{date, m3, y10, ...}]`): build a daily risk-free series (`m3`, forward-filled, daily-accrued) and classify **rate-shock weeks** = top-decile weekly Δy10 over the full window. Then `splitCrisis(crisisIdx, rateShockWeekSet)` → `{rateShockIdx, growthScareIdx}`, and `countEpisodes(idxArray)` = number of contiguous runs.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-regime.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateShockWeeks, splitCrisis, countEpisodes, riskFreeDaily } from './overlay-regime.mjs';

test('rateShockWeeks flags top-decile weekly Δy10 indices', () => {
  // 10 weeks; week 5 has the biggest y10 jump.
  const weeklyY10 = [2.0, 2.0, 2.0, 2.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0]; // Δ at index 4 = +1.0
  const set = rateShockWeeks(weeklyY10, { topFrac: 0.1 });
  assert.ok(set.has(4));
  assert.equal(set.size, 1);
});

test('splitCrisis partitions crisis indices by rate-shock membership', () => {
  const { rateShockIdx, growthScareIdx } = splitCrisis([2, 4, 7], new Set([4]));
  assert.deepEqual(rateShockIdx, [4]);
  assert.deepEqual(growthScareIdx, [2, 7]);
});

test('countEpisodes counts contiguous runs', () => {
  assert.equal(countEpisodes([1, 2, 3, 7, 8, 20]), 3);
  assert.equal(countEpisodes([]), 0);
});

test('riskFreeDaily forward-fills m3 and accrues per-day', () => {
  const curve = [{ date: '2020-01-02', m3: 1.512 }, { date: '2020-01-06', m3: 2.52 }];
  const rf = riskFreeDaily(curve, ['2020-01-02', '2020-01-03', '2020-01-06']);
  assert.ok(Math.abs(rf.get('2020-01-03') - (1.512 / 100) / 252) < 1e-12); // ffilled from 01-02
  assert.ok(Math.abs(rf.get('2020-01-06') - (2.52 / 100) / 252) < 1e-12);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-regime.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-regime.mjs
// Regime split for the hedge-overlay study: rate-shock weeks (top-decile weekly Δy10, S3 idiom),
// crisis-subset partition, contiguous-episode counting, and a forward-filled risk-free series.

// weeklyY10: array of week-end 10y yields (percent). Returns Set of week indices whose Δy10
// (vs prior week) is in the top `topFrac` of all weekly changes. Signal-independent of QQQ.
export function rateShockWeeks(weeklyY10, { topFrac = 0.1 } = {}) {
  const deltas = [];
  for (let i = 1; i < weeklyY10.length; i += 1) {
    if (weeklyY10[i] == null || weeklyY10[i - 1] == null) continue;
    deltas.push({ i, d: weeklyY10[i] - weeklyY10[i - 1] });
  }
  if (!deltas.length) return new Set();
  const k = Math.max(1, Math.floor(deltas.length * topFrac));
  return new Set(deltas.slice().sort((a, b) => b.d - a.d).slice(0, k).map((x) => x.i));
}

export function splitCrisis(crisisIdx, rateShockSet) {
  const rateShockIdx = crisisIdx.filter((i) => rateShockSet.has(i));
  const growthScareIdx = crisisIdx.filter((i) => !rateShockSet.has(i));
  return { rateShockIdx, growthScareIdx };
}

export function countEpisodes(idxArray) {
  const s = [...idxArray].sort((a, b) => a - b);
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (i === 0 || s[i] !== s[i - 1] + 1) n += 1;
  return n;
}

// curve: [{date, m3}] ascending; dates: target trading dates. Returns Map<date, dailyRf>.
export function riskFreeDaily(curve, dates) {
  const sorted = curve.slice().filter((r) => r.m3 != null).sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = new Map(); let j = 0; let cur = null;
  for (const d of dates) {
    while (j < sorted.length && sorted[j].date <= d) { cur = sorted[j].m3; j += 1; }
    out.set(d, cur == null ? 0 : (cur / 100) / 252);
  }
  return out;
}

// Week-end 10y yields aligned to a weekly index: pick the LAST curve y10 on/before each week's date.
export function weeklyY10ForWeeks(curve, weekEndDates) {
  const sorted = curve.slice().filter((r) => r.y10 != null).sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = []; let j = 0; let cur = null;
  for (const d of weekEndDates) {
    while (j < sorted.length && sorted[j].date <= d) { cur = sorted[j].y10; j += 1; }
    out.push(cur);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/overlay-regime.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-regime.mjs scripts/overlay-regime.test.mjs
git commit -m "feat(overlay): rate-shock split + episode count + risk-free series"
```

---

## Task 5: `overlay-candidates.mjs` — hedge daily return series

**Files:**
- Create: `scripts/overlay-candidates.mjs`
- Test: `scripts/overlay-candidates.test.mjs`

Each candidate emits a **raw daily hedge-return series** `[{date, ret, active}]` (the funding convention is applied later in `overlay-combine`). Static sleeves: ETF close-to-close returns. def-Prophet: reuse `simulateDefensiveProxy` (its `ret` is already net of premium for a given `costPct` = the size).

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-candidates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staticSleeveDaily, hedgeDaily } from './overlay-candidates.mjs';

const gld = [{ date: '2020-01-02', close: 100 }, { date: '2020-01-03', close: 102 }, { date: '2020-01-06', close: 101 }];

test('staticSleeveDaily = close-to-close ETF returns', () => {
  const s = staticSleeveDaily(gld, { start: '2020-01-01', end: '2020-12-31' });
  assert.equal(s.length, 2);
  assert.ok(Math.abs(s[0].ret - 0.02) < 1e-9);
  assert.ok(Math.abs(s[1].ret - (101 / 102 - 1)) < 1e-9);
  assert.equal(s[0].active, true);
});

test('hedgeDaily routes static candidates to the sleeve builder', () => {
  const barsByTicker = new Map([['GLD', gld]]);
  const s = hedgeDaily({ id: 'gld', kind: 'static', ticker: 'GLD' }, { barsByTicker, qqqBars: [], start: '2020-01-01', end: '2020-12-31' });
  assert.equal(s.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-candidates.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-candidates.mjs
// Build each hedge candidate's RAW daily return series (funding applied later in overlay-combine).
import { simulateDefensiveProxy } from './fleet-defensive-proxy.mjs';

export function staticSleeveDaily(bars, { start, end } = {}) {
  const out = [];
  for (let i = 1; i < bars.length; i += 1) {
    const d = bars[i].date;
    if ((start && d < start) || (end && d > end)) continue;
    out.push({ date: d, ret: bars[i].close / bars[i - 1].close - 1, active: true });
  }
  return out;
}

// candidate: from overlay-universe CANDIDATES. ctx: {barsByTicker, qqqBars, start, end, size}.
// For 'spread', `size` is the def-Prophet costPct (premium fraction). Returns [{date,ret,active}].
export function hedgeDaily(candidate, { barsByTicker, qqqBars, start, end, size } = {}) {
  if (candidate.kind === 'static') {
    return staticSleeveDaily(barsByTicker.get(candidate.ticker) || [], { start, end });
  }
  if (candidate.kind === 'spread') {
    return simulateDefensiveProxy(qqqBars, { start, end, costPct: size ?? 0.01 });
  }
  throw new Error(`unknown candidate kind: ${candidate.kind}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/overlay-candidates.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-candidates.mjs scripts/overlay-candidates.test.mjs
git commit -m "feat(overlay): candidate hedge daily-return builders"
```

---

## Task 6: `overlay-combine.mjs` — overlay metrics (the core math)

**Files:**
- Create: `scripts/overlay-combine.mjs`
- Test: `scripts/overlay-combine.test.mjs`

Given **weekly** book + hedge series (aligned to the same index), a size `w`, the funding convention, and weekly risk-free, compute the per-week **contribution** series and the metrics:
- `contribWeekly_t`: cash-static `w*(hedge_t − rf_t)`; book-static `w*(hedge_t − book_t)`; spread `hedge_t` (size already in costPct).
- **drag** (cost) = `−52 * mean(contrib over NON-crisis weeks)`.
- **cushion** (per crisis idx set) = `crisisMean(contribWeekly, idx)`; **CI** = `crisisMeanCI(contribWeekly, idx)` (this IS the paired-difference bootstrap, since contrib is already the per-week book↔combined difference).
- **efficiency** = `cushion / drag` when `drag > 0`, else `free_ballast`.
- **maxDD** + **Sharpe** of `combined_t = book_t + contrib_t`.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-combine.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contribWeekly, calmDrag, cushion, efficiency, maxDrawdown } from './overlay-combine.mjs';

const hedge = [{ ret: -0.01 }, { ret: -0.01 }, { ret: 0.05 }, { ret: -0.01 }]; // bleeds, pays in crisis
const book = [{ ret: 0.02 }, { ret: 0.01 }, { ret: -0.08 }, { ret: 0.015 }];
const rf = [0.0002, 0.0002, 0.0002, 0.0002];
const crisisIdx = [2]; // week 2 is the crash

test('contribWeekly cash-funded = w*(hedge - rf)', () => {
  const c = contribWeekly(hedge, book, { w: 1, funding: 'cash', rf });
  assert.ok(Math.abs(c[0].ret - (-0.01 - 0.0002)) < 1e-9);
  assert.ok(Math.abs(c[2].ret - (0.05 - 0.0002)) < 1e-9);
});

test('calmDrag annualizes mean over NON-crisis weeks only (sign: positive cost = positive drag)', () => {
  const c = contribWeekly(hedge, book, { w: 1, funding: 'cash', rf });
  const d = calmDrag(c, crisisIdx);
  // non-crisis contribs ≈ -0.0102,-0.0102,-0.0102 → mean ~ -0.0102 → drag = -52*mean > 0
  assert.ok(d > 0);
});

test('cushion is positive when hedge pays in the crisis week', () => {
  const c = contribWeekly(hedge, book, { w: 1, funding: 'cash', rf });
  assert.ok(cushion(c, crisisIdx) > 0);
});

test('efficiency returns free_ballast when drag<=0', () => {
  assert.equal(efficiency(0.5, -0.2).flag, 'free_ballast');
  assert.ok(Math.abs(efficiency(0.5, 2).value - 0.25) < 1e-9); // 0.5 cushion / 2% drag
});

test('maxDrawdown of a simple combined series', () => {
  const dd = maxDrawdown([0.1, -0.2, 0.05]);
  assert.ok(dd < 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-combine.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-combine.mjs
// Overlay metrics: calm-period drag (non-crisis weeks) vs regime-split crash cushion (crisis weeks),
// on the per-week contribution series. Reuses fleet-correlate crisisMean/crisisMeanCI as the
// paired-difference bootstrap (contrib IS the per-week combined−book difference). Spec §5.
import { crisisMean, crisisMeanCI } from './fleet-correlate.mjs';
import { mean } from './coil-threshold-metrics.mjs';

const WEEKS_PER_YEAR = 52;

// hedgeW, bookW: [{ret}] aligned. rf: number[] weekly risk-free (same length). Returns [{ret}].
export function contribWeekly(hedgeW, bookW, { w = 1, funding = 'cash', rf = [], isSpread = false } = {}) {
  const n = Math.min(hedgeW.length, bookW.length);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const h = hedgeW[i].ret;
    let c;
    if (isSpread) c = h;                                    // size already in costPct
    else if (funding === 'book') c = w * (h - bookW[i].ret);
    else c = w * (h - (rf[i] ?? 0));                        // cash-funded (default)
    out.push({ ret: c });
  }
  return out;
}

// Positive number = positive annualized COST. Computed over NON-crisis weeks only (spec §5).
export function calmDrag(contribW, crisisIdx) {
  const crisis = new Set(crisisIdx);
  const calm = contribW.filter((_, i) => !crisis.has(i)).map((p) => p.ret);
  if (!calm.length) return 0;
  return -WEEKS_PER_YEAR * mean(calm);
}

export function cushion(contribW, idx) { return crisisMean(contribW, idx); }
export function cushionCI(contribW, idx, opts = {}) { return crisisMeanCI(contribW, idx, opts); }

// cushion per 1%/yr drag; drag<=0 → free_ballast (honest positive calm carry). drag is a fraction/yr.
export function efficiency(cushionVal, dragFrac) {
  if (dragFrac == null || dragFrac <= 0) return { flag: 'free_ballast', value: null };
  return { flag: 'ok', value: cushionVal / (dragFrac * 100) };
}

// combinedW: number[] weekly returns. Returns the most-negative peak-to-trough (a negative number).
export function maxDrawdown(rets) {
  let eq = 1, peak = 1, mdd = 0;
  for (const r of rets) { eq *= (1 + r); if (eq > peak) peak = eq; const dd = eq / peak - 1; if (dd < mdd) mdd = dd; }
  return mdd;
}

export function sharpe(rets) {
  if (rets.length < 2) return null;
  const m = mean(rets);
  let v = 0; for (const r of rets) v += (r - m) * (r - m);
  const sd = Math.sqrt(v / (rets.length - 1));
  return sd === 0 ? null : (m / sd) * Math.sqrt(WEEKS_PER_YEAR);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/overlay-combine.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-combine.mjs scripts/overlay-combine.test.mjs
git commit -m "feat(overlay): overlay metrics — calm drag, cushion+CI, efficiency, maxDD/Sharpe"
```

---

## Task 7: `overlay-stress.mjs` — standardized shock payoff (convex candidates)

**Files:**
- Create: `scripts/overlay-stress.mjs`
- Test: `scripts/overlay-stress.test.mjs`

Sample-independent convex-payoff view (spec §5, §7 convexity guard). def-Prophet: terminal-intrinsic spread payoff `max(Klong−S,0) − max(Kshort−S,0)` at the shocked spot, normalized to net premium (so it reads as a multiple of premium-at-risk). VIXM: conservative shock-beta estimate from its observed crisis-week response (caller supplies the crisis mean).

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-stress.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spreadIntrinsicPayoff, spreadStressGrid } from './overlay-stress.mjs';

test('spreadIntrinsicPayoff = capped long-minus-short put intrinsic', () => {
  // S0=100, long 95 put, short 85 put. At S=80: long=15, short=5 → 10. Width cap = 10.
  assert.equal(spreadIntrinsicPayoff(80, 95, 85), 10);
  assert.equal(spreadIntrinsicPayoff(96, 95, 85), 0); // OTM
  assert.equal(spreadIntrinsicPayoff(70, 95, 85), 10); // capped at width
});

test('spreadStressGrid returns intrinsic at each shock for 95/85 strikes off S0=100', () => {
  const g = spreadStressGrid(100, { longPct: 0.95, shortPct: 0.85, shocks: [-0.10, -0.20, -0.30] });
  assert.equal(g['-0.10'], 5);  // S=90: long 95→5, short 85→0 → 5
  assert.equal(g['-0.20'], 10); // S=80: 15-5 = 10 (capped)
  assert.equal(g['-0.30'], 10); // S=70: capped at width 10
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-stress.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-stress.mjs
// Standardized −X% QQQ shock payoffs for the convex candidates — sample-independent complement to
// the in-sample cushion (spec §5; def-Prophet D-DP13 terminal-intrinsic, no greeks).

// Terminal-intrinsic value of a long(Klong)/short(Kshort) put DEBIT spread at spot S (Klong>Kshort).
export function spreadIntrinsicPayoff(S, Klong, Kshort) {
  return Math.max(Klong - S, 0) - Math.max(Kshort - S, 0);
}

// Grid of intrinsic payoff at standardized shocks off S0, using OTM strikes (def-Prophet geometry
// long ~5% OTM / short ~15% OTM). Returns { '-0.10': payoff, ... } in price units.
export function spreadStressGrid(S0, { longPct = 0.95, shortPct = 0.85, shocks = [-0.10, -0.20, -0.30] } = {}) {
  const Klong = S0 * longPct, Kshort = S0 * shortPct;
  const out = {};
  for (const sh of shocks) out[String(sh)] = spreadIntrinsicPayoff(S0 * (1 + sh), Klong, Kshort);
  return out;
}

// VIXM: linear shock-beta extrapolation from its observed crisis-week mean response (conservative,
// no convex amplification claimed). crisisMeanRet = VIXM weekly mean in crisis weeks; refShock the
// mean QQQ crisis-week move. Returns expected VIXM payoff fraction at each shock.
export function vixmStressGrid(crisisMeanRet, refShock, { shocks = [-0.10, -0.20, -0.30] } = {}) {
  const beta = refShock === 0 ? 0 : crisisMeanRet / refShock; // ret per unit QQQ move
  const out = {};
  for (const sh of shocks) out[String(sh)] = beta * sh;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/overlay-stress.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-stress.mjs scripts/overlay-stress.test.mjs
git commit -m "feat(overlay): standardized shock payoff grid for convex candidates"
```

---

## Task 8: `overlay-frontier.mjs` — frontier, classification, decision rule

**Files:**
- Create: `scripts/overlay-frontier.mjs`
- Test: `scripts/overlay-frontier.test.mjs`

Given per-candidate per-size metric rows, compute: the recommended size (smallest size whose marginal cushion-per-drag gain over the prior size falls below a threshold, else the max-efficiency size), the **regime class** (`robust`/`fragile`/`ineffective`) from the lumped + subset cushion CIs, and the **recommendation branch** (a/b/c) with the §7 convexity guard.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-frontier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regimeClass, recommend } from './overlay-frontier.mjs';

test('regimeClass: cushions (CI lo>0) in both subsets = robust', () => {
  assert.equal(regimeClass({ rateShock: { lo: 0.001 }, growthScare: { lo: 0.002 } }), 'robust');
  assert.equal(regimeClass({ rateShock: { lo: -0.001 }, growthScare: { lo: 0.002 } }), 'fragile');
  assert.equal(regimeClass({ rateShock: { lo: -0.001 }, growthScare: { lo: -0.002 } }), 'ineffective');
});

test('recommend: a static robust candidate dominates → branch a', () => {
  const cands = [
    { id: 'gld', convex: false, class: 'robust', lumpedLo: 0.001, drag: 1.0, cushion: 0.4, stressOk: true },
    { id: 'def_prophet', convex: true, class: 'fragile', lumpedLo: 0.001, drag: 0.5, cushion: 0.3, stressOk: true },
  ];
  const r = recommend(cands);
  assert.equal(r.branch, 'a');
  assert.equal(r.pick, 'gld');
});

test('recommend: only def-Prophet robust → branch b', () => {
  const cands = [
    { id: 'gld', convex: false, class: 'fragile', lumpedLo: 0.0, drag: 1.0, cushion: 0.2, stressOk: true },
    { id: 'def_prophet', convex: true, class: 'robust', lumpedLo: 0.001, drag: 0.5, cushion: 0.3, stressOk: true },
  ];
  assert.equal(recommend(cands).branch, 'b');
});

test('recommend: convex guard blocks a put-spread branch-a win without stress corroboration', () => {
  const cands = [
    { id: 'def_prophet', convex: true, class: 'robust', lumpedLo: 0.001, drag: 0.4, cushion: 0.9, stressOk: false },
    { id: 'gld', convex: false, class: 'fragile', lumpedLo: 0.0, drag: 1.0, cushion: 0.2, stressOk: true },
  ];
  // def_prophet would dominate on efficiency, but stressOk=false + convex → cannot win branch a;
  // it is still robust, so falls through to branch b (def-Prophet primary).
  assert.equal(recommend(cands).branch, 'b');
});

test('recommend: nothing robust → branch c (honest null)', () => {
  const cands = [{ id: 'gld', convex: false, class: 'ineffective', lumpedLo: -0.001, drag: 1, cushion: -0.1, stressOk: true }];
  assert.equal(recommend(cands).branch, 'c');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-frontier.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-frontier.mjs
// Frontier dominance + regime classification + the pre-registered decision rule (spec §7),
// including the convexity guard (4(a) cannot be won by a convex candidate on in-sample cushion alone).

// subsets: { rateShock:{lo}, growthScare:{lo} } — bootstrap CI lower bounds of the cushion.
export function regimeClass(subsets) {
  const rs = subsets.rateShock && subsets.rateShock.lo != null && subsets.rateShock.lo > 0;
  const gs = subsets.growthScare && subsets.growthScare.lo != null && subsets.growthScare.lo > 0;
  if (rs && gs) return 'robust';
  if (rs || gs) return 'fragile';
  return 'ineffective';
}

// Smallest size index whose marginal efficiency gain over the prior size < `flatTol`, else max-eff.
export function recommendedSize(rows, { flatTol = 0.05 } = {}) {
  if (!rows.length) return null;
  const eff = rows.map((r) => (r.efficiency && r.efficiency.value != null ? r.efficiency.value : -Infinity));
  for (let i = 1; i < eff.length; i += 1) {
    const gain = eff[i] - eff[i - 1];
    if (Number.isFinite(gain) && gain < flatTol) return rows[i - 1];
  }
  let best = 0; for (let i = 1; i < eff.length; i += 1) if (eff[i] > eff[best]) best = i;
  return rows[best];
}

// cands: [{ id, convex, class, lumpedLo, drag, cushion, stressOk }] at recommended size.
// budget: calm-drag reference (fraction/yr) for "cheap". Returns { branch:'a'|'b'|'c', pick }.
export function recommend(cands, { budget = 0.02 } = {}) {
  const robust = cands.filter((c) => c.class === 'robust' && c.lumpedLo != null && c.lumpedLo > 0);
  if (!robust.length) return { branch: 'c', pick: null };

  // Branch (a): a robust candidate that is cheap (drag<=budget) dominates. Convex candidates may
  // only win (a) if stress-corroborated; otherwise they are excluded from the (a) contest.
  const aEligible = robust.filter((c) => c.drag <= budget && (!c.convex || c.stressOk));
  if (aEligible.length) {
    // dominance = highest cushion per drag (free_ballast drag<=0 sorts first)
    aEligible.sort((x, y) => (y.cushion / Math.max(y.drag, 1e-9)) - (x.cushion / Math.max(x.drag, 1e-9)));
    const pick = aEligible[0];
    // If the winner is a static sleeve, it's a genuine 4(a). If only def-Prophet qualifies, that's 4(b).
    if (!pick.convex) return { branch: 'a', pick: pick.id };
  }

  // Branch (b): def-Prophet is robust (the expected base case).
  const dp = robust.find((c) => c.id === 'def_prophet');
  if (dp) return { branch: 'b', pick: 'def_prophet' };

  // A robust convex non-def-Prophet (VIXM) with stress support but only it robust → treat as (b)-like
  // primary on that candidate; otherwise (a) for a static, else null.
  const staticRobust = robust.find((c) => !c.convex);
  if (staticRobust) return { branch: 'a', pick: staticRobust.id };
  return { branch: 'b', pick: robust[0].id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/overlay-frontier.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-frontier.mjs scripts/overlay-frontier.test.mjs
git commit -m "feat(overlay): frontier dominance + regime class + decision rule w/ convexity guard"
```

---

## Task 9: `overlay-datawall.mjs` — Task-0 data-wall gate

**Files:**
- Create: `scripts/overlay-datawall.mjs`
- Test: `scripts/overlay-datawall.test.mjs`

Spec §13. Given the `_earliest` map, the candidate/curve presence, and per-year dropped-weight, produce a provenance summary and a per-era gate: eras with dropped-weight > threshold (default 0.30) have their reconstructed-Merrill cuts marked suppressed.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-datawall.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppressedEras, dataWallSummary } from './overlay-datawall.mjs';

test('suppressedEras flags years over the dropped-weight threshold', () => {
  const dw = { '2016': 0.55, '2017': 0.40, '2020': 0.05, '2022': 0.02 };
  assert.deepEqual(suppressedEras(dw, { threshold: 0.30 }), ['2016', '2017']);
});

test('dataWallSummary reports VIXM + curve coverage flags', () => {
  const s = dataWallSummary({
    earliest: { VIXM: '2011-01-10', __curve: '2002-01-02' },
    droppedByYear: { '2020': 0.05 }, windowStart: '2016-01-01',
  });
  assert.equal(s.vixmCoversWindow, true);
  assert.equal(s.curveCoversWindow, true);
  assert.ok(Array.isArray(s.suppressed));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-datawall.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-datawall.mjs
// Task 0 (spec §13): pre-modeling data-wall verification — earliest dates, VIXM/curve coverage,
// and per-era dropped-weight gate for the reconstructed-Merrill target.

export function suppressedEras(droppedByYear, { threshold = 0.30 } = {}) {
  return Object.keys(droppedByYear).filter((y) => droppedByYear[y] > threshold).sort();
}

export function dataWallSummary({ earliest = {}, droppedByYear = {}, windowStart = '2016-01-01', threshold = 0.30 } = {}) {
  const vixm = earliest.VIXM || null;
  const curve = earliest.__curve || null;
  return {
    vixm, curve,
    vixmCoversWindow: vixm != null && vixm <= windowStart,
    curveCoversWindow: curve != null && curve <= windowStart,
    droppedByYear,
    suppressed: suppressedEras(droppedByYear, { threshold }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/overlay-datawall.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-datawall.mjs scripts/overlay-datawall.test.mjs
git commit -m "feat(overlay): Task-0 data-wall gate (coverage + per-era dropped-weight)"
```

---

## Task 10: `overlay-prereg.mjs` — hashed pre-registration

**Files:**
- Create: `scripts/overlay-prereg.mjs`
- Test: `scripts/overlay-prereg.test.mjs`

Mirror `fleet-prereg.mjs` (reuse its `canonical`+`hashPrereg` approach — re-implement locally to keep the module self-contained, matching the carry/cef siblings).

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, hashPrereg } from './overlay-prereg.mjs';

test('prereg hash is stable + records the key decisions', () => {
  const p = buildPrereg();
  assert.equal(hashPrereg(p), hashPrereg(buildPrereg()));     // deterministic
  assert.equal(p.cost_metric, 'calm_period_non_crisis_drag'); // the critical §5 fix
  assert.ok(p.funding && p.funding.primary === 'cash_rf');
  assert.ok(p.decision_branches.includes('c_honest_null'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-prereg.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-prereg.mjs
// Pre-registration for the hedge-overlay study — sha256-hashed methodology block, written before scoring.
import { createHash } from 'node:crypto';

export function buildPrereg() {
  return {
    study: 'fleet-hedge-overlay',
    window: { start: '2016-01-01', end: '2026-06-06' },
    targets: ['reconstructed_merrill_book', 'QQQ'],
    candidates: ['def_prophet_proxy', 'static_GLD', 'static_TLT', 'static_VIXM'],
    size_grids: { static: [0.025, 0.05, 0.10, 0.15, 0.20], spread_premium: [0.005, 0.01, 0.02] },
    cost_metric: 'calm_period_non_crisis_drag',
    funding: { primary: 'cash_rf', conservative_bracket: 'book_funded_reallocation', read_against: 'conservative_bound' },
    cushion_metric: 'crisis_mean_contribution_paired_difference_bootstrap_CI',
    crisis: { definition: 'QQQ_worst_quintile', split: ['lumped', 'rate_shock', 'growth_scare'], rate_shock: 'top_decile_weekly_dy10_full_window' },
    episode_rule: 'subset_cushion_with_le_2_episodes_is_descriptive_CI_decorative',
    convex_candidates: ['def_prophet_proxy', 'static_VIXM'],
    convexity_guard: 'branch_a_not_winnable_by_convex_candidate_without_stress_corroboration',
    stress_shocks: [-0.10, -0.20, -0.30],
    bleed_budget_reference_pct_yr: 2,
    effective_n_floor: 8,
    decision_branches: ['a_robust_cheap_dominates', 'b_def_prophet_primary', 'c_honest_null'],
    data_wall_gate: { dropped_weight_threshold: 0.30, action: 'suppress_era_merrill_cuts' },
    acceptable_findings: [
      'a cheap static sleeve robustly cushions and is recommended',
      'only def-Prophet is regime-robust; activate it, statics as complements',
      'honest null: no static hedge worth adding; rely on def-Prophet, accept residual gap',
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

Run: `node --test scripts/overlay-prereg.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-prereg.mjs scripts/overlay-prereg.test.mjs
git commit -m "feat(overlay): hashed pre-registration block"
```

---

## Task 11: `overlay-report.mjs` — RESULTS renderer

**Files:**
- Create: `scripts/overlay-report.mjs`
- Test: `scripts/overlay-report.test.mjs`

Render the RESULTS markdown: a Task-0 data-provenance table, then per-target (book + QQQ) sections each with a per-candidate × size frontier table (calm-drag, lumped/rate-shock/growth-scare cushion + CI + episode counts), the stress grid for convex candidates, and the recommendation. Light test: renders a string with the expected headers.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/overlay-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from './overlay-report.mjs';

test('renderReport emits the key sections', () => {
  const model = {
    preregHash: 'abc123',
    dataWall: { vixm: '2011-01-10', curve: '2002-01-02', vixmCoversWindow: true, curveCoversWindow: true, droppedByYear: { '2016': 0.5, '2022': 0.02 }, suppressed: ['2016'] },
    targets: [{
      name: 'Reconstructed Merrill book',
      rows: [{ candidate: 'Static GLD', size: '10%', calmDrag: 0.9, lumped: { mean: 0.3, lo: 0.1, hi: 0.5, episodes: 3 }, rateShock: { mean: -0.1, lo: -0.3, hi: 0.1, episodes: 1 }, growthScare: { mean: 0.4, lo: 0.2, hi: 0.6, episodes: 2 }, efficiency: { flag: 'ok', value: 0.33 }, regimeClass: 'fragile' }],
      stress: [{ candidate: 'def-Prophet proxy', grid: { '-0.10': 5, '-0.20': 10, '-0.30': 10 } }],
      recommendation: { branch: 'b', pick: 'def_prophet', text: 'Only def-Prophet is regime-robust.' },
    }],
  };
  const md = renderReport(model);
  assert.match(md, /# Fleet Hedge-Overlay/);
  assert.match(md, /Pre-registration hash/);
  assert.match(md, /Data-wall/);
  assert.match(md, /Reconstructed Merrill book/);
  assert.match(md, /Recommendation/);
  assert.match(md, /episodes/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/overlay-report.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/overlay-report.mjs
// RESULTS.md renderer for the hedge-overlay study (controller-data-coupled shape, pure string fn).
const f = (x, d = 3) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const pc = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : (100 * x).toFixed(d) + '%');
const cuc = (c) => (c ? `${pc(c.mean)} [${pc(c.lo)},${pc(c.hi)}] (ep ${c.episodes})` : '—');

export function renderReport(model) {
  const L = [];
  L.push('# Fleet Hedge-Overlay — RESULTS', '');
  L.push(`**Pre-registration hash (sha256):** \`${model.preregHash || '—'}\``);
  L.push('**Lab-only, reconstructed returns.** Cost = **calm-period (non-crisis) drag**; benefit = crash-conditional **cushion** (paired-difference bootstrap CI) split lumped / rate-shock / growth-scare. Convex candidates (def-Prophet, VIXM) carry a stress grid + the §7 convexity guard. Recommendation read against the **conservative book-funded** drag bound.', '');

  const dw = model.dataWall || {};
  L.push('## Task 0 — Data-wall provenance', '');
  L.push(`- VIXM earliest: \`${dw.vixm || '—'}\` (covers 2016 window: ${dw.vixmCoversWindow ? 'yes' : 'NO'})`);
  L.push(`- Treasury curve earliest: \`${dw.curve || '—'}\` (covers window: ${dw.curveCoversWindow ? 'yes' : 'NO'})`);
  if (dw.suppressed && dw.suppressed.length) L.push(`- **Suppressed eras (dropped-weight > 30%, Merrill target):** ${dw.suppressed.join(', ')}`);
  L.push('');
  if (dw.droppedByYear) {
    L.push('| Year | dropped book weight |', '|---|--:|');
    for (const y of Object.keys(dw.droppedByYear).sort()) L.push(`| ${y} | ${pc(dw.droppedByYear[y])} |`);
    L.push('');
  }

  for (const t of model.targets) {
    L.push(`## Target: ${t.name}`, '');
    L.push('| Candidate | size | calm drag/yr | cushion lumped | rate-shock | growth-scare | efficiency | regime |');
    L.push('|---|--:|--:|:--|:--|:--|--:|:--|');
    for (const r of t.rows) {
      const eff = r.efficiency && r.efficiency.flag === 'free_ballast' ? 'free_ballast' : f(r.efficiency && r.efficiency.value, 2);
      L.push(`| ${r.candidate} | ${r.size} | ${pc(r.calmDrag)} | ${cuc(r.lumped)} | ${cuc(r.rateShock)} | ${cuc(r.growthScare)} | ${eff} | ${r.regimeClass} |`);
    }
    L.push('');
    if (t.stress && t.stress.length) {
      L.push('### Stress-shock payoff (convex candidates, sample-independent)', '');
      L.push('| Candidate | −10% | −20% | −30% |', '|---|--:|--:|--:|');
      for (const s of t.stress) L.push(`| ${s.candidate} | ${f(s.grid['-0.1'] ?? s.grid['-0.10'])} | ${f(s.grid['-0.2'] ?? s.grid['-0.20'])} | ${f(s.grid['-0.3'] ?? s.grid['-0.30'])} |`);
      L.push('');
    }
    L.push('### Recommendation', '');
    L.push(`**Branch ${t.recommendation.branch}** — ${t.recommendation.text}`, '');
  }
  return L.join('\n') + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/overlay-report.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scripts/overlay-report.mjs scripts/overlay-report.test.mjs
git commit -m "feat(overlay): RESULTS renderer (provenance + frontier + stress + recommendation)"
```

---

## Task 12: `overlay-score.mjs` — orchestrator (controller-authored)

**Files:**
- Create: `scripts/overlay-score.mjs`

Wires Task 0 → prereg → book + QQQ targets → candidates → regime split → combine/stress/frontier → report. Data-coupled; no unit test (validated by the live run in Task 13). Reads only the `overlay-cache` populated by Task 2. Mirrors `fleet-score.mjs` structure.

- [ ] **Step 1: Write the script**

```javascript
// scripts/overlay-score.mjs
// Orchestrator (controller-authored): Task-0 data-wall → prereg → per-target frontier → RESULTS.
// No network. Run: node scripts/overlay-score.mjs --root .
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OVERLAY_CACHE_SUBDIR, CANDIDATES, parseHoldings } from './overlay-universe.mjs';
import { loadFleetBars } from './fleet-bars.mjs'; // generic loader; point it at overlay-cache below
import { parseBarsWithVolume } from './coil-eventstudy-bars.mjs';
import { loadCurveFrom } from './overlay-curve.mjs';
import { bookDaily, droppedWeightByYear } from './overlay-book.mjs';
import { hedgeDaily } from './overlay-candidates.mjs';
import { rateShockWeeks, splitCrisis, countEpisodes, riskFreeDaily, weeklyY10ForWeeks } from './overlay-regime.mjs';
import { contribWeekly, calmDrag, cushion, cushionCI, efficiency, maxDrawdown, sharpe } from './overlay-combine.mjs';
import { spreadStressGrid, vixmStressGrid } from './overlay-stress.mjs';
import { regimeClass, recommendedSize, recommend } from './overlay-frontier.mjs';
import { buildPrereg, hashPrereg } from './overlay-prereg.mjs';
import { dataWallSummary } from './overlay-datawall.mjs';
import { renderReport } from './overlay-report.mjs';
import { unionDates, alignDaily, toWeekly } from './fleet-align.mjs';
import { crisisWeeks } from './fleet-correlate.mjs';

const START = '2016-01-01', END = '2026-06-06';

function loadOverlayBars(root, ticker) {
  const p = join(root, OVERLAY_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  try { return parseBarsWithVolume(JSON.parse(readFileSync(p, 'utf8'))); } catch { return []; }
}
function latestHoldings(root) {
  const dir = join(root, 'data', 'portfolio');
  const fs = readdirSync(dir).filter((f) => /^Holdings_.*\.csv$/.test(f)).sort();
  return parseHoldings(readFileSync(join(dir, fs[fs.length - 1]), 'utf8'));
}
function benchWeekly(bars) {
  const daily = [];
  for (let i = 1; i < bars.length; i += 1) { const d = bars[i].date; if (d < START || d > END) continue; daily.push({ date: d, ret: bars[i].close / bars[i - 1].close - 1, active: true }); }
  return daily;
}

{
  const args = process.argv.slice(2);
  const root = (() => { const i = args.indexOf('--root'); return i >= 0 ? args[i + 1] : process.cwd(); })();

  const prereg = buildPrereg();
  const preregHash = hashPrereg(prereg);
  mkdirSync(join(root, 'data', 'lab'), { recursive: true });
  writeFileSync(join(root, OVERLAY_CACHE_SUBDIR, 'overlay-prereg.json'), JSON.stringify({ ...prereg, sha256: preregHash }, null, 2));

  const holdings = latestHoldings(root);
  const bookBarsByTicker = new Map(holdings.map((h) => [h.symbol, loadOverlayBars(root, h.symbol)]));
  const qqqBars = loadOverlayBars(root, 'QQQ');
  const curve = loadCurveFrom(root); // [{date,m3,y10,...}]
  const earliestPath = join(root, OVERLAY_CACHE_SUBDIR, '_earliest.json');
  const earliest = existsSync(earliestPath) ? JSON.parse(readFileSync(earliestPath, 'utf8')) : {};

  // ── Task 0 data-wall ──
  const droppedByYear = droppedWeightByYear(holdings, bookBarsByTicker, { start: START, end: END });
  const dataWall = dataWallSummary({ earliest, droppedByYear, windowStart: START });

  // ── Build the two target book series ──
  const bookSeries = bookDaily(holdings, bookBarsByTicker, { start: START, end: END });
  const qqqDaily = benchWeekly(qqqBars);

  // ── Candidate raw daily series (one per candidate; spread expanded per costPct size) ──
  const candDaily = {};
  for (const c of CANDIDATES) {
    if (c.kind === 'spread') for (const sz of c.sizes) candDaily[`${c.id}@${sz}`] = hedgeDaily(c, { barsByTicker: bookBarsByTicker, qqqBars, start: START, end: END, size: sz });
    else candDaily[c.id] = hedgeDaily(c, { barsByTicker: new Map([[c.ticker, loadOverlayBars(root, c.ticker)]]), qqqBars, start: START, end: END });
  }

  // ── Common weekly alignment across book, QQQ, all candidate series ──
  const lanes = { Book: bookSeries, QQQ: qqqDaily, ...candDaily };
  const dates = unionDates(lanes);
  const aligned = alignDaily(lanes, dates);
  const weekly = {}; for (const k of Object.keys(aligned)) weekly[k] = toWeekly(aligned[k]);
  const weekEndDates = weekly.QQQ.map((w) => w.date);
  const rfDailyMap = riskFreeDaily(curve, dates);
  const rfWeekly = toWeekly(dates.map((d) => ({ date: d, ret: rfDailyMap.get(d) || 0, active: true }))).map((w) => w.ret);

  const crisisIdx = crisisWeeks(weekly.QQQ, 'quintile');
  const wY10 = weeklyY10ForWeeks(curve, weekEndDates);
  const rsSet = rateShockWeeks(wY10, { topFrac: 0.1 });
  const { rateShockIdx, growthScareIdx } = splitCrisis(crisisIdx, rsSet);

  const targets = [];
  for (const [targetName, bookW] of [['Reconstructed Merrill book', weekly.Book], ['QQQ', weekly.QQQ]]) {
    const rows = []; const stress = []; const recRows = [];
    for (const c of CANDIDATES) {
      const sizeRows = [];
      const sizeList = c.kind === 'spread' ? c.sizes : c.sizes;
      for (const sz of sizeList) {
        const hw = c.kind === 'spread' ? weekly[`${c.id}@${sz}`] : weekly[c.id];
        const isSpread = c.kind === 'spread';
        const contrib = contribWeekly(hw, bookW, { w: sz, funding: 'cash', rf: rfWeekly, isSpread });
        const contribBookFunded = contribWeekly(hw, bookW, { w: sz, funding: 'book', rf: rfWeekly, isSpread });
        const drag = calmDrag(contrib, crisisIdx);
        const dragConservative = calmDrag(contribBookFunded, crisisIdx);
        const lumped = { mean: cushion(contrib, crisisIdx), ...pickCI(cushionCI(contrib, crisisIdx)), episodes: countEpisodes(crisisIdx) };
        const rateShock = { mean: cushion(contrib, rateShockIdx), ...pickCI(cushionCI(contrib, rateShockIdx)), episodes: countEpisodes(rateShockIdx) };
        const growthScare = { mean: cushion(contrib, growthScareIdx), ...pickCI(cushionCI(contrib, growthScareIdx)), episodes: countEpisodes(growthScareIdx) };
        const rc = regimeClass({ rateShock, growthScare });
        sizeRows.push({ candidate: c.label, sizeNum: sz, size: c.kind === 'spread' ? `${(sz * 100).toFixed(1)}% prem` : `${(sz * 100).toFixed(1)}%`,
          calmDrag: drag, calmDragConservative: dragConservative, lumped, rateShock, growthScare,
          efficiency: efficiency(lumped.mean, dragConservative), regimeClass: rc });
      }
      rows.push(...sizeRows);
      const rec = recommendedSize(sizeRows) || sizeRows[0];
      // stress grid for convex candidates (def-Prophet via QQQ spot; VIXM via shock-beta)
      if (c.id === 'def_prophet') stress.push({ candidate: c.label, grid: spreadStressGrid(100, { longPct: 0.95, shortPct: 0.85 }) });
      if (c.id === 'vixm') stress.push({ candidate: c.label, grid: vixmStressGrid(rec.lumped.mean, meanCrisisQQQ(weekly.QQQ, crisisIdx)) });
      const stressOk = c.id === 'def_prophet' ? true : (c.id === 'vixm' ? rec.lumped.lo > 0 : true);
      recRows.push({ id: c.id, convex: c.convex, class: rec.regimeClass, lumpedLo: rec.lumped.lo, drag: rec.calmDragConservative, cushion: rec.lumped.mean, stressOk });
    }
    const decision = recommend(recRows, { budget: 0.02 });
    targets.push({ name: targetName, rows, stress, recommendation: { ...decision, text: decisionText(decision) } });
  }

  const md = renderReport({ preregHash, dataWall, targets });
  mkdirSync(join(root, 'docs', 'lab'), { recursive: true });
  writeFileSync(join(root, 'docs', 'lab', 'fleet-hedge-overlay-RESULTS.md'), md, { encoding: 'utf-8' });
  process.stdout.write(`prereg ${preregHash}\nRESULTS: docs/lab/fleet-hedge-overlay-RESULTS.md\n`);
  for (const t of targets) process.stdout.write(`[${t.name}] branch ${t.recommendation.branch} pick ${t.recommendation.pick}\n`);
}

function pickCI(ci) { return { lo: ci.lo, hi: ci.hi }; }
function meanCrisisQQQ(qqqW, idx) { if (!idx.length) return -0.05; return idx.reduce((s, i) => s + qqqW[i].ret, 0) / idx.length; }
function decisionText(d) {
  if (d.branch === 'a') return `A robust, cheap candidate (${d.pick}) dominates the frontier — recommend it at the noted size.`;
  if (d.branch === 'b') return 'Only def-Prophet is regime-robust — activate it as the primary hedge; static sleeves only as cheap regime-specific complements.';
  return 'Honest null — no static hedge clears robust+cheap; rely on the already-built def-Prophet and accept the residual gap.';
}
```

> **Note for implementer:** `overlay-score.mjs` imports two tiny helpers not yet created: `loadCurveFrom` (Task 12b). Create `scripts/overlay-curve.mjs` exporting `loadCurveFrom(root)` that reads `data/lab/overlay-cache/treasury-rates.json` and returns the sorted `curve` array (copy the body of `carry-bars.mjs`'s `loadCurve`, but point at `OVERLAY_CACHE_SUBDIR`). Add a one-line test that it returns `[]` when the file is missing.

- [ ] **Step 2: Create `overlay-curve.mjs` + test, verify both parse**

```javascript
// scripts/overlay-curve.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OVERLAY_CACHE_SUBDIR } from './overlay-universe.mjs';
export function loadCurveFrom(projectRoot) {
  const path = join(projectRoot, OVERLAY_CACHE_SUBDIR, 'treasury-rates.json');
  let obj; try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return (obj.curve || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
}
```

```javascript
// scripts/overlay-curve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCurveFrom } from './overlay-curve.mjs';
test('loadCurveFrom returns [] when cache missing', () => { assert.deepEqual(loadCurveFrom('/no/such/root'), []); });
```

Run: `node --test scripts/overlay-curve.test.mjs` (PASS) and `node --check scripts/overlay-score.mjs` (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add scripts/overlay-score.mjs scripts/overlay-curve.mjs scripts/overlay-curve.test.mjs
git commit -m "feat(overlay): orchestrator + treasury-curve loader"
```

---

## Task 13: Live run, RUNBOOK, full-suite verification, squash-merge

**Files:**
- Create: `docs/lab/fleet-hedge-overlay-RUNBOOK.md`
- Generated (gitignored): `data/lab/overlay-cache/*`, `docs/lab/fleet-hedge-overlay-RESULTS.md` (RESULTS **is** committed)

- [ ] **Step 1: Run the full unit suite**

Run: `node --test scripts/overlay-*.test.mjs`
Expected: all PASS (Tasks 1,3,4,5,6,7,8,9,10,11,12b).

- [ ] **Step 2: Backfill data + score (network; source the root .env)**

```bash
export $(grep -E '^FMP_API_KEY=' .env | xargs)
node scripts/overlay-fetch.mjs
node scripts/overlay-score.mjs --root .
```
Expected: `overlay-fetch done: N/N ok` (note any failed tickers — they become dropped weight, which the data-wall reports), then `RESULTS: docs/lab/fleet-hedge-overlay-RESULTS.md` and a branch/pick line per target.

- [ ] **Step 3: Sanity-read RESULTS**

Open `docs/lab/fleet-hedge-overlay-RESULTS.md`. Confirm: Task-0 provenance shows VIXM/curve cover 2016; suppressed eras (if any) are pre-2020; static GLD/TLT show negative/zero cushion in the **rate-shock** column (the expected 2022 failure); def-Prophet/VIXM cushion in both subsets; the recommendation branch is internally consistent with the tables. **If RESULTS contradicts the spec's expected base case, report it — do not edit numbers.**

- [ ] **Step 4: Write the RUNBOOK**

```markdown
# Fleet Hedge-Overlay — RUNBOOK

Ranks four equity-selloff hedges (def-Prophet proxy, static GLD/TLT/VIXM) by cost-adjusted crash
efficiency vs the reconstructed Merrill book + QQQ. Lab-only, read-only. Spec:
`docs/superpowers/specs/2026-06-06-fleet-hedge-overlay-design.md`.

## Re-run
```bash
export $(grep -E '^FMP_API_KEY=' .env | xargs)   # project-root .env
node scripts/overlay-fetch.mjs                   # book tickers + GLD/TLT/VIXM + QQQ + treasury → data/lab/overlay-cache/
node scripts/overlay-score.mjs --root .          # Task0 → prereg → frontier → docs/lab/fleet-hedge-overlay-RESULTS.md
node --test scripts/overlay-*.test.mjs           # unit tests
```
`data/lab/*` is gitignored; only RESULTS + this RUNBOOK are committed.

## How to read it
- **Cost = calm-period (non-crisis) drag**, read against the conservative book-funded bound.
- **Cushion** split lumped / rate-shock / growth-scare, each with paired-difference bootstrap CI and
  **episode count** — a ≤2-episode CI is decorative (descriptive only).
- **Convex candidates** (def-Prophet, VIXM) also show a −10/−20/−30% stress grid; branch (a) can't be
  won by a convex candidate without stress corroboration (convexity guard).
- **Recommendation branches:** (a) robust cheap static dominates / (b) def-Prophet primary / (c) null.

## Key limits (also in the hashed prereg)
- Reconstructed PAPER returns; static current-weights book; bull-favorable window; ~3 crisis episodes
  total (rate-shock ≈ 2022 only). See spec §12.
```

- [ ] **Step 5: Commit RESULTS + RUNBOOK**

```bash
git add docs/lab/fleet-hedge-overlay-RESULTS.md docs/lab/fleet-hedge-overlay-RUNBOOK.md
git commit -m "docs(overlay): study RESULTS + RUNBOOK"
```

- [ ] **Step 6: Hand back for the verdict + squash-merge**

Do NOT squash-merge autonomously. Report the recommendation branch + the per-target tables to the controller for the honest read, then (on approval) squash-merge the branch to **local `main`** (unpushed, lab-only) per memory `claude-commits-must-reach-local-main`, and `git worktree remove` the worktree.

---

## Self-Review (completed by plan author)

**Spec coverage:** §1 purpose → Tasks 10/12 (prereg + orchestrator emit the recommendation). §3.1 reconstructed book + dynamic renorm + dropped-weight → Task 3. §3.2 QQQ target → Task 12. §4 candidates + funding convention + convexity caveat → Tasks 5 (series), 6 (funding), 1 (definitions). §5 calm-drag/cushion/CI/efficiency/stress/frontier → Tasks 6, 7, 8. §6 regime split + episodes → Task 4. §7 decision rule + convexity guard → Task 8. §8 module map → Tasks 1–12. §9 data/cache → Task 2. §10 TDD/workflow → all tasks. §11 defaults → Task 10 prereg. §12 risks → RUNBOOK/RESULTS text. §13 Task-0 gate → Task 9 + Task 12 wiring.

**Placeholder scan:** none — every code step has complete code; the one cross-task helper (`loadCurveFrom`/`overlay-curve.mjs`) is created in Task 12 Step 2.

**Type consistency:** candidate object shape (`id/label/kind/ticker/sizes/convex`) consistent across Tasks 1/5/12. Weekly series `[{ret}]` consumed identically by Tasks 6/12. `efficiency()` returns `{flag,value}` consumed by Tasks 8/11/12. `cushion`/`cushionCI` reuse `crisisMean`/`crisisMeanCI` (verified signatures in `fleet-correlate.mjs`). `recommend()` input row shape (`{id,convex,class,lumpedLo,drag,cushion,stressOk}`) matches what Task 12 builds.
