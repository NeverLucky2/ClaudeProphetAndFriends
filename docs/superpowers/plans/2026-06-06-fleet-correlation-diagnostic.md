# Fleet Correlation Diagnostic — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct each of the four fleet lanes' (Coil / Turtle / Drift / defensive-Prophet) return streams by backtesting their strategy logic over a common multi-year window, then measure whether they are genuinely uncorrelated — to each other and to the tech book (QQQ) — with a crisis-conditional cut that is guarded against the small-n / tail-selection artifacts that would otherwise fake "ballast."

**Architecture:** Pure-function JS modules (node ESM, `node:test`) producing per-lane **daily mark-to-market** return series, aligned onto a common daily index and aggregated to **weekly** for analysis. Correlation/β/crisis engine with a circular-rotation surrogate null. Lab-only, read-only, no runtime/deploy impact. Mirrors the EMA/ORB/coil-options study conventions.

**Tech Stack:** Node ESM `.mjs`, built-in `node:test`, FMP `stable/historical-price-eod/full` + earnings calendar, reused lab modules on **local main** (`ema-beta`, `coil-threshold-metrics`, `coil-opt-bsm`, `ema-bars`, `coil-eventstudy-bars`, `coil-threshold-build`).

**Spec:** `docs/superpowers/specs/2026-06-06-fleet-correlation-diagnostic-design.md` (read it first).

---

## Execution conventions (read before Task 1)

- **Isolated worktree off LOCAL main.** Create via `superpowers:using-git-worktrees` before executing. The reused modules live on local `main`, not origin. Re-assert the branch before any git mutation (shared-root-collision lesson). **Copy the uncommitted spec** `docs/superpowers/specs/2026-06-06-fleet-correlation-diagnostic-design.md` into the worktree (it is untracked in root and will NOT appear in a fresh worktree checkout) so it rides the final squash.
- **Pure modules → full TDD by Haiku subagents** (RED test first, verify fail, minimal GREEN, verify pass, commit).
- **Data-coupled CLIs → controller-authored at execution time** (the documented ORB/EMA pattern: `orb-score.mjs`/`ema-fetch-bars` were too fiddly to let Haiku improvise). Tasks 1, 10, 11 CLIs are controller-authored; their **contract** is fully specified here so there is no ambiguity. The pure logic they call is still TDD'd.
- **Bar shape** everywhere (post-load): `{ date:'YYYY-MM-DD', open, high, low, close, volume }`, ascending, ET-date-keyed (via `parseBarsWithVolume`).
- **Return-series shape** everywhere: array of `{ date:'YYYY-MM-DD', ret:number, active:boolean }` (ascending). `ret` is the lane's daily mark-to-market fractional return; `active` = lane held ≥1 position that day.
- **Data fetch range:** FMP from `2014-01-01` (indicator warmup); **analysis windows** = 3-way 2016-01-01→2026-06-06 (Coil/Turtle/def-Prophet), 4-way headline 2022-01-01→2026-06-06 (adds Drift).
- Source project-root `.env` for `FMP_API_KEY` before any fetch CLI.
- `data/lab/*` is git-ignored; only `docs/lab/fleet-correlation-RESULTS.md` + `docs/lab/fleet-correlation-RUNBOOK.md` are committed.

---

## Task 1: Data layer — universe, loader, bar fetch, Drift earnings fetch

**Files:**
- Create: `scripts/fleet-universe.mjs`
- Create: `scripts/fleet-universe.test.mjs`
- Create: `scripts/fleet-bars.mjs`
- Create: `scripts/fleet-bars.test.mjs`
- Create: `scripts/fleet-fetch-bars.mjs` (CLI, controller-authored)
- Create: `scripts/fleet-drift-earnings.mjs` (CLI, controller-authored)

- [ ] **Step 1: Write the failing test for `fleet-universe.mjs`**

```javascript
// scripts/fleet-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TURTLE_ETFS, clusterOf, MEANREV_UNIVERSE, BENCHMARKS, allFleetTickers } from './fleet-universe.mjs';

test('turtle ETF basket mirrors trend_universe.go: 15 names, 6 clusters', () => {
  assert.equal(TURTLE_ETFS.length, 15);
  assert.equal(clusterOf('TLT'), 'rates');
  assert.equal(clusterOf('GLD'), 'metals');
  assert.equal(clusterOf('EEM'), 'intl_equity');
  assert.equal(clusterOf('SPY'), ''); // not in basket
  const clusters = new Set(TURTLE_ETFS.map(e => e.cluster));
  assert.deepEqual([...clusters].sort(), ['commodity','energy','fx','intl_equity','metals','rates']);
});

test('benchmarks are QQQ (primary) and SPY (reference)', () => {
  assert.deepEqual(BENCHMARKS, ['QQQ', 'SPY']);
});

test('allFleetTickers is the deduped union of ETFs + meanrev + benchmarks', () => {
  const all = allFleetTickers();
  assert.ok(all.includes('TLT') && all.includes('AAPL') && all.includes('QQQ'));
  assert.equal(all.length, new Set(all).size); // deduped
});
```

- [ ] **Step 2: Run to verify fail** — `node --test scripts/fleet-universe.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Implement `fleet-universe.mjs`**

```javascript
// scripts/fleet-universe.mjs
// Single source of truth for the fleet study's tickers. ETF basket + clusters mirror
// models/trend_universe.go; MEANREV_UNIVERSE reused from coil-eventstudy-build.mjs.
import { MEANREV_UNIVERSE } from './coil-eventstudy-build.mjs';

export { MEANREV_UNIVERSE };

export const TURTLE_ETFS = [
  { ticker: 'TLT', cluster: 'rates' }, { ticker: 'IEF', cluster: 'rates' }, { ticker: 'TIP', cluster: 'rates' },
  { ticker: 'GLD', cluster: 'metals' }, { ticker: 'SLV', cluster: 'metals' },
  { ticker: 'USO', cluster: 'energy' }, { ticker: 'UNG', cluster: 'energy' },
  { ticker: 'DBC', cluster: 'commodity' }, { ticker: 'DBA', cluster: 'commodity' }, { ticker: 'DBB', cluster: 'commodity' },
  { ticker: 'UUP', cluster: 'fx' }, { ticker: 'FXE', cluster: 'fx' }, { ticker: 'FXY', cluster: 'fx' },
  { ticker: 'EEM', cluster: 'intl_equity' }, { ticker: 'EFA', cluster: 'intl_equity' },
];

export const BENCHMARKS = ['QQQ', 'SPY'];

export function clusterOf(ticker) {
  const t = String(ticker).toUpperCase().trim();
  const hit = TURTLE_ETFS.find(e => e.ticker === t);
  return hit ? hit.cluster : '';
}

export const DRIFT_UNIVERSE = MEANREV_UNIVERSE; // services.DriftUniverse reuses MeanRevUniverse

export function allFleetTickers() {
  return [...new Set([...TURTLE_ETFS.map(e => e.ticker), ...MEANREV_UNIVERSE, ...BENCHMARKS])];
}
```

- [ ] **Step 4: Run to verify pass** — `node --test scripts/fleet-universe.test.mjs` → PASS.

- [ ] **Step 5: Write the failing test for `fleet-bars.mjs`**

```javascript
// scripts/fleet-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFleetBars, FLEET_CACHE_SUBDIR } from './fleet-bars.mjs';

test('loadFleetBars parses the cache file into ascending {date,open,high,low,close,volume}', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-'));
  mkdirSync(join(root, FLEET_CACHE_SUBDIR), { recursive: true });
  writeFileSync(join(root, FLEET_CACHE_SUBDIR, 'TLT.json'), JSON.stringify({
    written_at: '2026-06-06T00:00:00Z',
    bars: [
      { Timestamp: '2016-01-05T00:00:00Z', Open: 1, High: 2, Low: 0.5, Close: 1.5, Volume: 10 },
      { Timestamp: '2016-01-04T00:00:00Z', Open: 1, High: 2, Low: 0.5, Close: 1.2, Volume: 9 },
    ],
  }));
  const bars = loadFleetBars(root, 'TLT');
  assert.equal(bars.length, 2);
  assert.deepEqual(bars.map(b => b.date), ['2016-01-04', '2016-01-05']); // ascending
  assert.equal(bars[1].close, 1.5);
});

test('loadFleetBars returns [] for a missing ticker', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-'));
  assert.deepEqual(loadFleetBars(root, 'NOPE'), []);
});
```

- [ ] **Step 6: Run to verify fail** — FAIL (module not found).

- [ ] **Step 7: Implement `fleet-bars.mjs`** (reuses `parseBarsWithVolume`)

```javascript
// scripts/fleet-bars.mjs
// Dedicated lab bar cache for the fleet study — isolated from production data/bar-cache
// so the deep backfill never touches live bots, and the study is reproducible.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBarsWithVolume } from './coil-eventstudy-bars.mjs';

export const FLEET_CACHE_SUBDIR = join('data', 'lab', 'fleet-bar-cache');

export function loadFleetBars(projectRoot, ticker) {
  const path = join(projectRoot, FLEET_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
  return parseBarsWithVolume(obj);
}

export function barsByDate(bars) {
  const m = new Map();
  for (let i = 0; i < bars.length; i += 1) m.set(bars[i].date, i);
  return m;
}
```

- [ ] **Step 8: Run to verify pass** — PASS.

- [ ] **Step 9: Controller-author `fleet-fetch-bars.mjs`** (CLI; mirror of `ema-fetch-bars.mjs`)

Contract: reads `FMP_API_KEY` from env; for each `allFleetTickers()`, GET `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol={T}&from=2014-01-01&to={today}&apikey={KEY}`; convert via `fmpEodToBars`; write `data/lab/fleet-bar-cache/{T}.json` as `{ written_at, bars:[{Timestamp,Open,High,Low,Close,Volume}] }`. Print `{T}: {n} bars` per ticker; tolerate per-ticker HTTP errors (log to stderr, continue). Exit 2 if no key.

```javascript
// scripts/fleet-fetch-bars.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fmpEodToBars } from './ema-bars.mjs';
import { FLEET_CACHE_SUBDIR } from './fleet-bars.mjs';
import { allFleetTickers } from './fleet-universe.mjs';

const FROM = '2014-01-01';
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
  mkdirSync(join(root, FLEET_CACHE_SUBDIR), { recursive: true });
  for (const t of allFleetTickers()) {
    try {
      const bars = await fetchOne(t, to);
      writeFileSync(join(root, FLEET_CACHE_SUBDIR, `${t}.json`),
        JSON.stringify({ written_at: new Date().toISOString(),
          bars: bars.map(b => ({ Timestamp: `${b.date}T00:00:00Z`, Open: b.open, High: b.high, Low: b.low, Close: b.close, Volume: b.volume })) }));
      process.stdout.write(`${t}: ${bars.length} bars\n`);
    } catch (e) { process.stderr.write(`${e.message}\n`); }
  }
}
```

- [ ] **Step 10: Controller-author `fleet-drift-earnings.mjs`** (CLI) + verify date quality

Contract: for each `DRIFT_UNIVERSE` ticker, fetch **actual historical earnings report dates + timing** from FMP. Primary endpoint: `https://financialmodelingprep.com/stable/earnings-calendar?symbol={T}&from=2021-06-01&to={today}&apikey={KEY}` (per-symbol; fields `date`, `time`/`when` ∈ {bmo,amc} when present). Write `data/lab/fleet-drift-earnings.json` = `{ "AAPL":[{ "date":"2024-05-02", "timing":"amc" }, ...], ... }` (timing `""` when vendor omits it → the sim infers it). **Verification step (mandatory):** print 3 known dates (e.g. AAPL 2024-05-02, NVDA 2024-05-22, MSFT 2024-04-25) and confirm they land within ±1 trading day of the fetched dates; if the endpoint is gated (403) or returns quarter-end-looking dates, STOP and report — do not silently fall back to `coil-earnings-dates.json` (those are fiscal-period ends, wrong bar for a gap).

- [ ] **Step 11: Run both CLIs** — `node scripts/fleet-fetch-bars.mjs` then `node scripts/fleet-drift-earnings.mjs`. Expected: ~80 universe + 15 ETF + 2 benchmark cache files; earnings JSON with the verification spot-check passing.

- [ ] **Step 12: Commit** — `git add scripts/fleet-universe.* scripts/fleet-bars.* scripts/fleet-fetch-bars.mjs scripts/fleet-drift-earnings.mjs && git commit -m "feat(fleet-corr): data layer — universe, lab bar loader, FMP bar + earnings fetch"`

---

## Task 2: Turtle lane sim → daily marks

**Files:**
- Create: `scripts/fleet-turtle-sim.mjs`
- Create: `scripts/fleet-turtle-sim.test.mjs`

Port the return-generating core of `services/trend_signal_service.go` + `services/turtle_executor.go`. Long-only. Gates modeled: position cap (6), one-per-cluster. Gates SIMPLIFIED OUT (documented in RESULTS): correlation-guard, aggregate-risk cap, segment breaker, regime gate (neutral).

- [ ] **Step 1: Write failing tests for indicators (exclude-last-bar + Wilder seed)**

```javascript
// scripts/fleet-turtle-sim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { donchianHigh, donchianLow, sma, wilderATR, entryFires, exitFires, positionDollars, simulateTurtle } from './fleet-turtle-sim.mjs';

test('donchianHigh excludes the last bar (the bar being tested)', () => {
  // closes: ...,10,12,11,[5]  — window n=3 over the 3 bars BEFORE the last → max(10,12,11)=12
  const closes = [1, 2, 3, 10, 12, 11, 5];
  assert.equal(donchianHigh(closes, 3), 12);
});

test('donchianLow excludes the last bar', () => {
  const closes = [9, 8, 7, 10, 6, 8, 99];
  assert.equal(donchianLow(closes, 3), 6);
});

test('sma over the n bars ending one before the last', () => {
  const closes = [1, 2, 3, 4, 5, 100];
  assert.equal(sma(closes, 3), (3 + 4 + 5) / 3);
});

test('wilderATR uses simple-mean seed then recursion (not an SMA of TR)', () => {
  const highs = [10, 11, 12, 13, 14];
  const lows = [9, 10, 11, 12, 13];
  const closes = [9.5, 10.5, 11.5, 12.5, 13.5];
  const atr = wilderATR(highs, lows, closes, 2);
  assert.ok(atr > 0 && Number.isFinite(atr));
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement indicators** (line-for-line port; exclude-last-bar semantics from the Go `donchianHigh`/`sma`/`wilderATR`)

```javascript
// scripts/fleet-turtle-sim.mjs
// Faithful long-only Donchian trend port (trend_signal_service.go + turtle_executor.go),
// daily mark-to-market. Simplified-out gates (documented): corr-guard, agg-risk cap,
// segment breaker, regime gate (neutral). Reuses fleet bar loader.
import { loadFleetBars, barsByDate } from './fleet-bars.mjs';
import { TURTLE_ETFS } from './fleet-universe.mjs';

export function donchianHigh(closes, n) {
  const L = closes.length; if (L < n + 2) return 0;
  let m = closes[L - n - 1];
  for (let i = L - n; i <= L - 2; i += 1) if (closes[i] > m) m = closes[i];
  return m;
}
export function donchianLow(closes, n) {
  const L = closes.length; if (L < n + 2) return 0;
  let m = closes[L - n - 1];
  for (let i = L - n; i <= L - 2; i += 1) if (closes[i] < m) m = closes[i];
  return m;
}
export function sma(closes, n) {
  const L = closes.length; if (L < n + 2) return 0;
  let s = 0; for (let i = L - n - 1; i <= L - 2; i += 1) s += closes[i];
  return s / n;
}
export function wilderATR(highs, lows, closes, n) {
  const L = closes.length; if (L < n + 1) return 0;
  const tr = new Array(L).fill(0);
  for (let i = 1; i < L; i += 1) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, Math.max(hc, lc));
  }
  let s = 0; for (let i = 1; i <= n; i += 1) s += tr[i];
  let atr = s / n;
  for (let i = n + 1; i < L; i += 1) atr = (atr * (n - 1) + tr[i]) / n;
  return atr;
}
```

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Write failing tests for entry/exit/sizing**

```javascript
test('entryFires requires close>Donchian100High AND close>SMA200 AND ATR/close>=0.5%', () => {
  // synthetic: last close breaks above both, ATR ratio above floor
  assert.equal(entryFires({ lastClose: 110, d100High: 100, sma200: 90, atr20: 2 }), true);
  assert.equal(entryFires({ lastClose: 99, d100High: 100, sma200: 90, atr20: 2 }), false); // no breakout
  assert.equal(entryFires({ lastClose: 110, d100High: 100, sma200: 120, atr20: 2 }), false); // below SMA200
  assert.equal(entryFires({ lastClose: 110, d100High: 100, sma200: 90, atr20: 0.2 }), false); // vol floor
});

test('exitFires: trailing stop on today_open<=Donchian50Low OR initial hard stop within 20d', () => {
  assert.equal(exitFires({ todayOpen: 80, d50Low: 85, entry: 100, atrAtEntry: 5, daysHeld: 3 }).reason, 'trailing_stop');
  assert.equal(exitFires({ todayOpen: 89, d50Low: 85, entry: 100, atrAtEntry: 5, daysHeld: 3 }).reason, 'initial_hard_stop'); // 89<=100-2*5=90
  assert.equal(exitFires({ todayOpen: 95, d50Low: 85, entry: 100, atrAtEntry: 5, daysHeld: 30 }).reason, ''); // hard stop expired, above trail
});

test('positionDollars = (portfolio*0.005)/(2*ATR/close), capped at 4% of portfolio', () => {
  // portfolio 100k, close 100, atr 1 → risk 500 / (2/100=0.02) = 25000; cap = 4000 → 4000
  assert.equal(positionDollars(100000, 100, 1), 4000);
  // atr 10 → 500/(20/100=0.2)=2500 (< 4000 cap)
  assert.equal(positionDollars(100000, 100, 10), 2500);
});
```

- [ ] **Step 6: Run to verify fail.**

- [ ] **Step 7: Implement entry/exit/sizing** (ports of `evaluateEntry`, `evaluateExit`, `computePositionDollars`; cold-start proximity filter omitted — it only delays the first-ever entry and is immaterial over a decade)

```javascript
export function entryFires({ lastClose, d100High, sma200, atr20 }) {
  if (lastClose <= d100High) return false;
  if (lastClose <= sma200) return false;
  if (lastClose === 0 || atr20 / lastClose < 0.005) return false;
  return true;
}
export function exitFires({ todayOpen, d50Low, entry, atrAtEntry, daysHeld }) {
  if (todayOpen <= d50Low) return { reason: 'trailing_stop' };
  if (daysHeld <= 20 && todayOpen <= entry - 2 * atrAtEntry) return { reason: 'initial_hard_stop' };
  return { reason: '' };
}
export function positionDollars(portfolio, lastClose, atr20) {
  if (portfolio <= 0 || lastClose <= 0 || atr20 <= 0) return 0;
  const raw = (portfolio * 0.005) / ((2 * atr20) / lastClose);
  const cap = portfolio * 0.04;
  return raw > cap ? cap : raw;
}
```

- [ ] **Step 8: Run to verify pass.**

- [ ] **Step 9: Write failing test for `simulateTurtle` (daily-marked series)**

```javascript
test('simulateTurtle marks open positions daily and returns {date,ret,active}[]', () => {
  // Two-ETF toy world over a handful of days with a clean breakout in one name.
  const barsByTicker = makeToyBreakout(); // helper builds a rising series that breaks Donchian
  const series = simulateTurtle(barsByTicker, { start: '2016-01-01', end: '2016-12-31', portfolio: 100000 });
  assert.ok(series.length > 0);
  assert.ok(series.every(p => typeof p.ret === 'number' && typeof p.active === 'boolean' && /^\d{4}-\d\d-\d\d$/.test(p.date)));
  // On a flat-no-position prefix, ret is 0 and active false
  assert.ok(series.some(p => p.active === true)); // the breakout produced a held position
});
```
(Helper `makeToyBreakout` builds ≥260 bars so indicators warm; controller may author it inline.)

- [ ] **Step 10: Run to verify fail.**

- [ ] **Step 11: Implement `simulateTurtle`** — the daily portfolio loop:

Logic (deterministic, daily):
1. Build the union sorted date index across all ETF bars within `[start,end]` (plus warmup before `start`).
2. Maintain `open[]` = `{ ticker, cluster, entryPrice, shares, atrAtEntry, entryDate, daysHeld }` and `equity` (start = `portfolio`, non-compounding base for sizing = constant `portfolio`).
3. For each date d (only dates ≥ `start`):
   a. **Mark:** `dayPnL = Σ open shares*(close_d − close_{prevHeldClose})`; `ret = dayPnL / portfolio`; push `{ date:d, ret, active: open.length>0 }`.
   b. **Exits:** for each open position compute today's `d50Low` (from that ticker's closes up to d) and evaluate `exitFires` against `open_d`; close at `open_d` price, drop from `open[]`.
   c. **Entries:** iterate `TURTLE_ETFS`; skip held tickers, skip if `open.length>=6`, skip if cluster slot taken (one per cluster among `open[]`); compute signal at d (`donchianHigh(closes,100)`, `sma(closes,200)`, `wilderATR(...,20)`); if `entryFires`, size with `positionDollars`, `shares=floor($/close_d)`, add to `open[]` (entry at `close_d`, the rules' entry-price reference).
   d. Increment `daysHeld` for surviving positions.
4. Return the daily series.

Use `loadFleetBars` per ticker; index each with `barsByDate`. Closes slice for a ticker at date d = closes up to and including d's index.

```javascript
export function simulateTurtle(barsByTicker, { start, end, portfolio = 100000 } = {}) {
  // barsByTicker: Map<ticker, bars[]>; bars ascending {date,open,high,low,close}
  const idx = {}; const closesAll = {};
  for (const [t, bars] of barsByTicker) { idx[t] = barsByDate(bars); closesAll[t] = bars; }
  const allDates = [...new Set([...barsByTicker.values()].flatMap(bs => bs.map(b => b.date)))]
    .filter(d => d >= start && d <= end).sort();
  const open = []; const series = [];
  let prevCloseByTicker = {};
  for (const d of allDates) {
    // (a) mark
    let dayPnL = 0;
    for (const p of open) {
      const bi = idx[p.ticker].get(d); if (bi == null) continue;
      const c = closesAll[p.ticker][bi].close;
      const prev = prevCloseByTicker[p.ticker] ?? p.entryPrice;
      dayPnL += p.shares * (c - prev);
    }
    series.push({ date: d, ret: dayPnL / portfolio, active: open.length > 0 });
    // (b) exits — evaluate against today's open price
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const p = open[i]; const bi = idx[p.ticker].get(d); if (bi == null) continue;
      const closes = closesAll[p.ticker].slice(0, bi + 1).map(b => b.close);
      const d50Low = donchianLow(closes, 50);
      const todayOpen = closesAll[p.ticker][bi].open;
      if (exitFires({ todayOpen, d50Low, entry: p.entryPrice, atrAtEntry: p.atrAtEntry, daysHeld: p.daysHeld }).reason) open.splice(i, 1);
    }
    // (c) entries
    const heldClusters = new Set(open.map(p => p.cluster));
    const heldTickers = new Set(open.map(p => p.ticker));
    for (const { ticker: t, cluster } of TURTLE_ETFS) {
      if (open.length >= 6) break;
      if (heldTickers.has(t) || heldClusters.has(cluster)) continue;
      const bi = idx[t]?.get(d); if (bi == null) continue;
      const b = closesAll[t]; const closes = b.slice(0, bi + 1).map(x => x.close);
      const highs = b.slice(0, bi + 1).map(x => x.high); const lows = b.slice(0, bi + 1).map(x => x.low);
      if (closes.length < 252) continue;
      const sig = { lastClose: closes[closes.length - 1], d100High: donchianHigh(closes, 100), sma200: sma(closes, 200), atr20: wilderATR(highs, lows, closes, 20) };
      if (!entryFires(sig)) continue;
      const dollars = positionDollars(portfolio, sig.lastClose, sig.atr20);
      const shares = Math.floor(dollars / sig.lastClose);
      if (shares < 1) continue;
      open.push({ ticker: t, cluster, entryPrice: sig.lastClose, shares, atrAtEntry: sig.atr20, entryDate: d, daysHeld: 0 });
      heldClusters.add(cluster); heldTickers.add(t);
    }
    // (d) advance held marks + age
    for (const p of open) { const bi = idx[p.ticker].get(d); if (bi != null) prevCloseByTicker[p.ticker] = closesAll[p.ticker][bi].close; p.daysHeld += 1; }
  }
  return series;
}
```

- [ ] **Step 12: Run to verify pass.**

- [ ] **Step 13: Commit** — `git commit -am "feat(fleet-corr): Turtle Donchian long-only sim → daily marks"`

---

## Task 3: Coil lane — rebuild tape (longer) + daily re-mark

**Files:**
- Create: `scripts/fleet-coil-marks.mjs`
- Create: `scripts/fleet-coil-marks.test.mjs`

Reuse `enumerateFreshTrades` (from `coil-threshold-build.mjs`) over `MEANREV_UNIVERSE` reading **fleet** bars (longer history), then daily re-mark each trade and overlay the portfolio sizing (5%/pos, ≤4, 24% cap, most-oversold-first). **Day-0 mark uses the trade's `entry` fill price** (matches the tape's `grossReturn`), close-to-close thereafter.

- [ ] **Step 1: Write failing test for single-trade daily marks**

```javascript
// scripts/fleet-coil-marks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remarkTrade, simulateCoilDaily } from './fleet-coil-marks.mjs';

test('remarkTrade: day-0 from entry fill, close-to-close after, through exitDate', () => {
  // bars for the underlying around the trade
  const bars = [
    { date: '2016-03-01', close: 100 }, // entry day; entry fill = 98 (below close)
    { date: '2016-03-02', close: 95 },
    { date: '2016-03-03', close: 102 }, // exit day
  ];
  const trade = { ticker: 'AAPL', date: '2016-03-01', entry: 98, exitDate: '2016-03-03' };
  const marks = remarkTrade(trade, bars); // [{date, ret}] per-share fractional vs entry-anchored chain
  // day0: 100/98-1; day1: 95/100-1; day2: 102/95-1
  assert.ok(Math.abs(marks[0].ret - (100 / 98 - 1)) < 1e-9);
  assert.ok(Math.abs(marks[1].ret - (95 / 100 - 1)) < 1e-9);
  assert.ok(Math.abs(marks[2].ret - (102 / 95 - 1)) < 1e-9);
  assert.deepEqual(marks.map(m => m.date), ['2016-03-01', '2016-03-02', '2016-03-03']);
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `remarkTrade`**

```javascript
// scripts/fleet-coil-marks.mjs
// Coil daily re-mark: turn the RSI(2) trade tape into a daily-marked portfolio return
// series. Day-0 anchored to the tape `entry` fill (matches grossReturn); close-to-close after.
import { loadFleetBars, barsByDate } from './fleet-bars.mjs';
import { enumerateFreshTrades } from './coil-threshold-build.mjs';
import { MEANREV_UNIVERSE } from './fleet-universe.mjs';

export function remarkTrade(trade, bars) {
  const bd = barsByDate(bars);
  const i0 = bd.get(trade.date); const iE = bd.get(trade.exitDate);
  if (i0 == null || iE == null || iE < i0) return [];
  const marks = [];
  for (let i = i0; i <= iE; i += 1) {
    const prev = i === i0 ? trade.entry : bars[i - 1].close;
    marks.push({ date: bars[i].date, ret: bars[i].close / prev - 1 });
  }
  return marks;
}
```

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Write failing test for portfolio overlay (concurrency + caps + most-oversold-first)**

```javascript
test('simulateCoilDaily overlays sizing: ≤4 concurrent, 24% cap, most-oversold-first; daily {date,ret,active}', () => {
  // Two overlapping trades, sizePct 0.05 → each contributes 0.05*perShareRet to portfolio ret that day
  const trades = [
    { ticker: 'AAPL', date: '2016-03-01', rsi2: 3, entry: 100, exitDate: '2016-03-02' },
    { ticker: 'MSFT', date: '2016-03-01', rsi2: 1, entry: 50, exitDate: '2016-03-02' },
  ];
  const barsByTicker = new Map([
    ['AAPL', [{ date: '2016-03-01', close: 100 }, { date: '2016-03-02', close: 110 }]],
    ['MSFT', [{ date: '2016-03-01', close: 50 }, { date: '2016-03-02', close: 55 }]],
  ]);
  const series = simulateCoilDaily(trades, barsByTicker, { sizePct: 0.05, maxPositions: 4, deployCap: 0.24 });
  const d2 = series.find(p => p.date === '2016-03-02');
  // AAPL 110/100-1=0.10, MSFT 55/50-1=0.10 → 0.05*0.10 + 0.05*0.10 = 0.01
  assert.ok(Math.abs(d2.ret - 0.01) < 1e-9);
  assert.equal(d2.active, true);
});
```

- [ ] **Step 6: Run to verify fail.**

- [ ] **Step 7: Implement `simulateCoilDaily`** — event-driven daily overlay:

Logic: sort trades by date; maintain `open[]` with each position's per-share mark chain (via `remarkTrade` precomputed per trade, indexed by date). At each date, free slots whose `exitDate < date`; admit new same-date trades most-oversold-first (lowest `rsi2`), respecting `maxPositions` and `open.length*sizePct+sizePct <= deployCap`; one-per-ticker. Daily portfolio `ret = Σ open sizePct * perShareRet_thatDate`. `active = open.length>0`. Emit on the union of all trade dates within the series span.

```javascript
export function simulateCoilDaily(trades, barsByTicker, { sizePct = 0.05, maxPositions = 4, deployCap = 0.24 } = {}) {
  const marksByTrade = trades.map(t => ({ t, marks: barsByTicker.has(t.ticker) ? remarkTrade(t, barsByTicker.get(t.ticker)) : [] }))
    .filter(x => x.marks.length);
  const retByDateTrade = marksByTrade.map(({ t, marks }) => ({ t, byDate: new Map(marks.map(m => [m.date, m.ret])), dates: marks.map(m => m.date) }));
  const allDates = [...new Set(retByDateTrade.flatMap(x => x.dates))].sort();
  const open = []; const series = [];
  const byEntryDate = new Map();
  for (const x of retByDateTrade) { const k = x.t.date; if (!byEntryDate.has(k)) byEntryDate.set(k, []); byEntryDate.get(k).push(x); }
  for (const d of allDates) {
    for (let i = open.length - 1; i >= 0; i -= 1) if (open[i].t.exitDate < d) open.splice(i, 1);
    const held = new Set(open.map(o => o.t.ticker));
    const cands = (byEntryDate.get(d) || []).slice().sort((a, b) => a.t.rsi2 - b.t.rsi2);
    for (const c of cands) {
      if (open.length >= maxPositions) break;
      if (open.length * sizePct + sizePct > deployCap + 1e-9) break;
      if (held.has(c.t.ticker)) continue;
      open.push(c); held.add(c.t.ticker);
    }
    let ret = 0;
    for (const o of open) { const r = o.byDate.get(d); if (r != null) ret += sizePct * r; }
    series.push({ date: d, ret, active: open.length > 0 });
  }
  return series;
}
```

- [ ] **Step 8: Run to verify pass.**

- [ ] **Step 9: Controller-author the tape rebuild glue** inside `fleet-coil-marks.mjs` (a `buildCoilSeries(root, earningsByTicker)` export): for each `MEANREV_UNIVERSE` ticker, `loadFleetBars`, `enumerateFreshTrades(bars, { rsiMax: 5, earningsDates })` (RSI<5 = Coil's live deep-oversold threshold, the tape's `[0,5)` bucket), keep `!censored` trades with an `exitDate`, attach `entry` (already on the trade as `entry`), then `simulateCoilDaily` across all tickers' trades + a `Map` of fleet bars. Filter the output series to `date>=2016-01-01`.

- [ ] **Step 10: Commit** — `git commit -am "feat(fleet-corr): Coil tape daily re-mark + portfolio overlay (entry-anchored day-0)"`

---

## Task 4: Drift lane — PEAD event sim → daily marks (2022+)

**Files:**
- Create: `scripts/fleet-drift-sim.mjs`
- Create: `scripts/fleet-drift-sim.test.mjs`

Port the return-generating core of `services/drift_signal_service.go` + `TRADING_RULES_DRIFT.md`. Continuation ON. Exits: +20% / −10% / 60 trading-day time stop / MA50 break. 4%/pos, ≤3 positions. Timing inferred (port `inferDriftTiming`) when the earnings JSON omits it.

- [ ] **Step 1: Write failing tests for the signal pieces (gap, composite/grade, continuation, MA50)**

```javascript
// scripts/fleet-drift-sim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGapPct, scoreGap, composite, grade, isContinuation, aboveMA, inferTiming, driftEntryQualifies, driftExit, simulateDrift } from './fleet-drift-sim.mjs';

test('computeGapPct: BMO = open[E]/close[E-1]-1; AMC = open[E+1]/close[E]-1', () => {
  const bars = [{ date: '2024-05-01', close: 100, open: 99 }, { date: '2024-05-02', close: 105, open: 103 }, { date: '2024-05-03', close: 108, open: 106 }];
  assert.ok(Math.abs(computeGapPct(bars, '2024-05-02', 'bmo') - (103 / 100 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(computeGapPct(bars, '2024-05-02', 'amc') - (106 / 105 - 1) * 100) < 1e-9);
});

test('grade thresholds A>=85 B>=70 C>=55 else D', () => {
  assert.equal(grade(85), 'A'); assert.equal(grade(70), 'B'); assert.equal(grade(55), 'C'); assert.equal(grade(54.9), 'D');
});

test('isContinuation: >=1 day after gap AND close>gapBarHigh AND close>priorHigh', () => {
  assert.equal(isContinuation({ daysAfterGap: 2, latestClose: 110, gapBarHigh: 105, priorHigh: 108 }), true);
  assert.equal(isContinuation({ daysAfterGap: 2, latestClose: 104, gapBarHigh: 105, priorHigh: 108 }), false);
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement the signal pieces** (ports of `computeDriftGap`, `scoreGap`/`scoreTrend`/`scoreVolRatio`/`scoreMA200Distance`/`scoreMA50Distance`, `computeDriftComposite` with weights gap .25 / trend .30 / vol .20 / ma200 .15 / ma50 .10, grade thresholds, `computeDriftContinuation`, MA helpers, `inferDriftTiming`). Bars `{date,open,high,low,close,volume}`.

(Full ports of the Go functions read in the spec's §5.3 source list. Each scorer is a `switch` ladder exactly as in `drift_signal_service.go`. `inferTiming` ports `inferDriftTiming` — larger overnight-gap side wins, AMC default on tie, all four prices positive.)

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Write failing tests for the entry filter and the four exits**

```javascript
test('entry filter: gap>=3 AND aboveMA200 AND aboveMA50 AND grade in {A,B} AND (continuation OR pead-ready)', () => {
  const base = { gapPct: 5, aboveMA200: true, aboveMA50: true, grade: 'B', continuation: true, peadStage: 'MONITORING' };
  assert.equal(driftEntryQualifies(base), true);
  assert.equal(driftEntryQualifies({ ...base, gapPct: 2 }), false);
  assert.equal(driftEntryQualifies({ ...base, continuation: false, peadStage: 'MONITORING' }), false);
  assert.equal(driftEntryQualifies({ ...base, continuation: false, peadStage: 'SIGNAL_READY' }), true);
});

test('exits: +20% target, -10% stop, 60-day time stop, MA50 break', () => {
  assert.equal(driftExit({ pnlPct: 0.21, daysHeld: 5, aboveMA50: true }).reason, 'target');
  assert.equal(driftExit({ pnlPct: -0.11, daysHeld: 5, aboveMA50: true }).reason, 'stop');
  assert.equal(driftExit({ pnlPct: 0.05, daysHeld: 60, aboveMA50: true }).reason, 'time_stop');
  assert.equal(driftExit({ pnlPct: 0.05, daysHeld: 5, aboveMA50: false }).reason, 'ma50_break');
  assert.equal(driftExit({ pnlPct: 0.05, daysHeld: 5, aboveMA50: true }).reason, '');
});
```

- [ ] **Step 6: Run to verify fail.**

- [ ] **Step 7: Implement `driftEntryQualifies` + `driftExit`**

```javascript
export function driftEntryQualifies({ gapPct, aboveMA200, aboveMA50, grade, continuation, peadStage }) {
  if (gapPct < 3.0) return false;
  if (!aboveMA200 || !aboveMA50) return false;
  if (grade !== 'A' && grade !== 'B') return false;
  return continuation || peadStage === 'SIGNAL_READY' || peadStage === 'BREAKOUT';
}
export function driftExit({ pnlPct, daysHeld, aboveMA50 }) {
  if (pnlPct >= 0.20) return { reason: 'target' };
  if (pnlPct <= -0.10) return { reason: 'stop' };
  if (daysHeld >= 60) return { reason: 'time_stop' };
  if (!aboveMA50) return { reason: 'ma50_break' };
  return { reason: '' };
}
```

- [ ] **Step 8: Run to verify pass.**

- [ ] **Step 9: Write failing test for `simulateDrift` (event-driven daily marks)**

```javascript
test('simulateDrift enters on a qualifying post-earnings event and marks daily to an exit', () => {
  const series = simulateDrift(makeDriftEvent(), { start: '2022-01-01', end: '2026-06-06', portfolio: 100000 });
  assert.ok(series.length > 0);
  assert.ok(series.every(p => typeof p.ret === 'number' && typeof p.active === 'boolean'));
  assert.ok(series.some(p => p.active)); // the event produced a held position
});
```

- [ ] **Step 10: Run to verify fail.**

- [ ] **Step 11: Implement `simulateDrift`** — per the earnings event stream:

Logic:
1. For each ticker, for each earnings date in `earningsByTicker[ticker]` (resolve timing: vendor or `inferTiming`), evaluate the entry signal **as of the entry decision bar** (gap bar +1 day, the first bar where continuation can be true): compute gap/MA200/MA50/grade/continuation/pead at that bar. If `driftEntryQualifies`, open a position at that bar's close, 4% of portfolio.
2. Cap ≤3 concurrent, one-per-ticker-per-earnings-cycle. (When >3 qualify same day, rank BREAKOUT > SIGNAL_READY > continuation > composite desc.)
3. Daily-mark each open position close-to-close; compute `pnlPct` from entry; each day evaluate `driftExit` (recompute `aboveMA50` daily). Close at the exit bar's close.
4. Daily portfolio `ret = Σ open posWeight * perShareRet_today` where `posWeight=0.04`. `active=open.length>0`. Emit over the union of dates ≥ `start`.

Use the same daily-mark machinery shape as Turtle (prev-close chain anchored at entry close).

- [ ] **Step 12: Run to verify pass.**

- [ ] **Step 13: Controller-author the driver glue** (`buildDriftSeries(root, earningsByTicker)` export): loop `DRIFT_UNIVERSE`, `loadFleetBars`, run `simulateDrift`; filter `date>=2022-01-01`.

- [ ] **Step 14: Commit** — `git commit -am "feat(fleet-corr): Drift PEAD event sim (continuation ON, 4 exits) → daily marks"`

---

## Task 5: defensive-Prophet proxy — 200DMA trigger + BSM put-spread daily marks

**Files:**
- Create: `scripts/fleet-defensive-proxy.mjs`
- Create: `scripts/fleet-defensive-proxy.test.mjs`

Structural-light, per spec §5.5. QQQ<200DMA trigger; defined-risk QQQ put-spread priced daily via `bsPrice`. NO timing inference is drawn from this lane downstream — it carries no headline number.

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/fleet-defensive-proxy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma200, triggered, putSpreadValue, simulateDefensiveProxy } from './fleet-defensive-proxy.mjs';
import { bsPrice } from './coil-opt-bsm.mjs';

test('triggered when close < 200-day SMA', () => {
  const closes = Array.from({ length: 250 }, (_, i) => 100); // flat 100
  assert.equal(triggered([...closes.slice(0, 249), 90]), true);
  assert.equal(triggered([...closes.slice(0, 249), 110]), false);
});

test('putSpreadValue = long higher-strike put − short lower-strike put (debit, ≥0)', () => {
  const S = 100, Klong = 95, Kshort = 85, T = 30 / 365, r = 0.04, sig = 0.2;
  const v = putSpreadValue(S, Klong, Kshort, T, r, sig);
  assert.ok(Math.abs(v - (bsPrice('put', S, Klong, T, r, sig) - bsPrice('put', S, Kshort, T, r, sig))) < 1e-12);
  assert.ok(v >= 0);
});

test('spread gains as the underlying falls (structural convexity sanity)', () => {
  const args = [95, 85, 30 / 365, 0.04, 0.3];
  assert.ok(putSpreadValue(90, ...args) > putSpreadValue(100, ...args));
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `sma200`/`triggered`/`putSpreadValue`** (reuse `bsPrice`)

```javascript
// scripts/fleet-defensive-proxy.mjs
import { bsPrice } from './coil-opt-bsm.mjs';

export function sma200(closes) {
  if (closes.length < 200) return 0;
  let s = 0; for (let i = closes.length - 200; i < closes.length; i += 1) s += closes[i];
  return s / 200;
}
export function triggered(closes) {
  const m = sma200(closes); return m > 0 && closes[closes.length - 1] < m;
}
export function putSpreadValue(S, Klong, Kshort, T, r, sigma) {
  return bsPrice('put', S, Klong, T, r, sigma) - bsPrice('put', S, Kshort, T, r, sigma);
}
```

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Write failing test for `simulateDefensiveProxy` (daily-marked spread P&L)**

```javascript
test('simulateDefensiveProxy: flat (ret 0, inactive) while untriggered; nonzero marks while a spread is on', () => {
  const qqqBars = makeQqqCrashThen200(); // ≥250 bars, a stretch below the 200DMA
  const series = simulateDefensiveProxy(qqqBars, { start: '2016-01-01', end: '2026-06-06' });
  assert.ok(series.every(p => typeof p.ret === 'number' && typeof p.active === 'boolean'));
  assert.ok(series.some(p => p.active === true));  // entered a hedge during the crash
  assert.ok(series.some(p => p.active === false && p.ret === 0)); // flat while untriggered
});
```

- [ ] **Step 6: Run to verify fail.**

- [ ] **Step 7: Implement `simulateDefensiveProxy`** — daily loop:

Logic: walk QQQ bars from `start`. State = `pos` (null or `{ Klong, Kshort, entryS, expiryIdx, contracts, prevValue }`). Each day:
1. σ estimate = trailing 20-day realized vol of QQQ daily log-returns, annualized.
2. If no `pos` and `triggered(closesUpToToday)`: open a spread — `Klong = round(S*0.95)`, `Kshort = round(S*0.85)`, T = 30 calendar days (`expiryIdx` ≈ +21 trading bars), size `contracts` so spread debit ≈ a fixed small notional fraction (e.g. spread cost = 1% of `portfolio`); set `prevValue` = today's `putSpreadValue`.
3. If `pos`: today's value = `putSpreadValue(S, Klong, Kshort, Tremaining, r, σ)`; `dayPnL = contracts*(value − prevValue)`; `ret = dayPnL / portfolio`; `prevValue = value`. Close when `!triggered` OR `today >= expiryIdx` (settle at intrinsic).
4. Emit `{ date, ret: pos? ret : 0, active: !!pos }`. Use `r = 0.04` constant (documented).

- [ ] **Step 8: Run to verify pass.**

- [ ] **Step 9: Commit** — `git commit -am "feat(fleet-corr): defensive-Prophet 200DMA proxy + BSM put-spread daily marks (structural-light)"`

---

## Task 6: Align lanes → weekly matrix

**Files:**
- Create: `scripts/fleet-align.mjs`
- Create: `scripts/fleet-align.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/fleet-align.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unionDates, alignDaily, toWeekly } from './fleet-align.mjs';

test('unionDates merges + sorts + dedupes lane date indices', () => {
  const a = [{ date: '2016-01-04', ret: 0.1, active: true }];
  const b = [{ date: '2016-01-05', ret: -0.1, active: true }, { date: '2016-01-04', ret: 0, active: false }];
  assert.deepEqual(unionDates({ A: a, B: b }), ['2016-01-04', '2016-01-05']);
});

test('alignDaily zero-fills missing lane days and carries active flag', () => {
  const lanes = { A: [{ date: '2016-01-05', ret: 0.2, active: true }] };
  const aligned = alignDaily(lanes, ['2016-01-04', '2016-01-05']);
  assert.deepEqual(aligned.A[0], { date: '2016-01-04', ret: 0, active: false });
  assert.deepEqual(aligned.A[1], { date: '2016-01-05', ret: 0.2, active: true });
});

test('toWeekly compounds daily returns within an ISO week and ORs the active flag', () => {
  const daily = [
    { date: '2016-01-04', ret: 0.1, active: true },  // Mon
    { date: '2016-01-05', ret: 0.1, active: false }, // Tue, same ISO week
  ];
  const w = toWeekly(daily);
  assert.equal(w.length, 1);
  assert.ok(Math.abs(w[0].ret - ((1.1 * 1.1) - 1)) < 1e-9);
  assert.equal(w[0].active, true); // OR of the daily active flags
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `fleet-align.mjs`** — union index, zero-fill, ISO-week compounding (reuse the `ISOWeek` idea: key by `getISOWeekKey(date)`; week label = the Monday). `active` weekly = OR of daily `active`.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `git commit -am "feat(fleet-corr): align lanes to a common index + weekly aggregation"`

---

## Task 7: Correlation + beta core

**Files:**
- Create: `scripts/fleet-correlate.mjs`
- Create: `scripts/fleet-correlate.test.mjs`

Reuse `olsBeta` (ema-beta), `mean` (coil-threshold-metrics). This task = matrix (Pearson/Spearman), QQQ β, active-week-conditional for sparse lanes, block-bootstrap CI.

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/fleet-correlate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pearson, spearman, zeroFraction, conditionalSeries, betaTo } from './fleet-correlate.mjs';

test('pearson is exact on a perfectly linear series', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-12);
});

test('spearman uses ranks (monotone but nonlinear → 1)', () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [1, 4, 9, 16]) - 1) < 1e-12);
});

test('zeroFraction + conditionalSeries drive the >40% sparse-lane rule', () => {
  const lane = [{ ret: 0, active: false }, { ret: 0, active: false }, { ret: 0.1, active: true }];
  assert.ok(Math.abs(zeroFraction(lane) - 2 / 3) < 1e-9);
  const { x, y } = conditionalSeries(lane, [{ ret: 0.01 }, { ret: 0.02 }, { ret: 0.03 }]);
  assert.deepEqual(x, [0.1]); assert.deepEqual(y, [0.03]); // only the active week survives
});

test('betaTo reuses olsBeta', () => {
  assert.ok(Math.abs(betaTo([2, 4, 6], [1, 2, 3]) - 2) < 1e-12);
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `pearson`/`spearman`/`zeroFraction`/`conditionalSeries`/`betaTo`**

```javascript
// scripts/fleet-correlate.mjs
import { olsBeta } from './ema-beta.mjs';
import { mean } from './coil-threshold-metrics.mjs';

export function pearson(x, y) {
  const n = Math.min(x.length, y.length); if (n < 2) return null;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i += 1) { const dx = x[i] - mx, dy = y[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  return vx === 0 || vy === 0 ? null : cov / Math.sqrt(vx * vy);
}
function rank(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j += 1;
    const avg = (i + j - 1) / 2 + 1; for (let k = i; k < j; k += 1) r[idx[k][1]] = avg; i = j; }
  return r;
}
export function spearman(x, y) { const n = Math.min(x.length, y.length); return pearson(rank(x.slice(0, n)), rank(y.slice(0, n))); }
export function zeroFraction(lane) { return lane.length ? lane.filter(p => p.ret === 0).length / lane.length : 1; }
export function conditionalSeries(lane, bench) {
  const x = [], y = []; for (let i = 0; i < lane.length; i += 1) if (lane[i].active) { x.push(lane[i].ret); y.push(bench[i].ret); }
  return { x, y };
}
export function betaTo(laneRets, benchRets) { return olsBeta(laneRets, benchRets); }
```

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Write failing test for block-bootstrap correlation CI (seeded determinism)**

```javascript
import { bootstrapCorrCI } from './fleet-correlate.mjs';
test('bootstrapCorrCI is deterministic for a fixed seed and brackets the point estimate', () => {
  const x = Array.from({ length: 120 }, (_, i) => Math.sin(i));
  const y = x.map(v => v + 0.01);
  const a = bootstrapCorrCI(x, y, { seed: 42 });
  const b = bootstrapCorrCI(x, y, { seed: 42 });
  assert.deepEqual(a, b);
  assert.ok(a.lo <= a.point && a.point <= a.hi);
});
```

- [ ] **Step 6: Run to verify fail.**

- [ ] **Step 7: Implement `bootstrapCorrCI`** — block-resample weekly indices (block length ~4 weeks to respect autocorrelation) using the `mulberry32` idiom; recompute pearson per resample; return `{ point, lo, hi, n }` at 2.5/97.5 pct. (Copy `mulberry32` locally or import from coil-threshold-metrics if exported; it is not exported there → define locally with the same constants.)

- [ ] **Step 8: Run to verify pass.**

- [ ] **Step 9: Commit** — `git commit -am "feat(fleet-corr): correlation/β core + active-week-conditional + block-bootstrap CI"`

---

## Task 8: Crisis-conditional cut + surrogate null (the centerpiece)

**Files:**
- Modify: `scripts/fleet-correlate.mjs`
- Modify: `scripts/fleet-correlate.test.mjs`

- [ ] **Step 1: Write failing tests for crisis selection, downside β, n-floor**

```javascript
import { crisisWeeks, downsideBeta, effectiveN, rollingCorr } from './fleet-correlate.mjs';

test('crisisWeeks selects the worst-quintile (primary) and worst-decile (secondary) QQQ weeks', () => {
  const qqq = Array.from({ length: 100 }, (_, i) => ({ ret: (i - 50) / 1000 })); // -0.05..+0.049
  const q = crisisWeeks(qqq, 'quintile'); const d = crisisWeeks(qqq, 'decile');
  assert.equal(q.length, 20); assert.equal(d.length, 10);
  assert.ok(Math.max(...q.map(i => qqq[i].ret)) <= Math.min(...qqq.filter((_, i) => !q.includes(i)).map(b => b.ret)));
});

test('effectiveN counts nonzero lane-weeks within a crisis index set', () => {
  const lane = [{ ret: 0 }, { ret: 0.1 }, { ret: 0 }, { ret: -0.2 }];
  assert.equal(effectiveN(lane, [0, 1, 3]), 2);
});

test('downsideBeta = OLS slope of lane on QQQ over the crisis index set', () => {
  const lane = [{ ret: 0 }, { ret: 0.2 }, { ret: 0.4 }];
  const qqq = [{ ret: 0 }, { ret: 0.1 }, { ret: 0.2 }];
  assert.ok(Math.abs(downsideBeta(lane, qqq, [0, 1, 2]) - 2) < 1e-12);
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `crisisWeeks`/`effectiveN`/`downsideBeta`/`rollingCorr`**

```javascript
export function crisisWeeks(qqqWeekly, bucket = 'quintile') {
  const frac = bucket === 'decile' ? 0.1 : 0.2;
  const k = Math.max(1, Math.floor(qqqWeekly.length * frac));
  return qqqWeekly.map((w, i) => [w.ret, i]).sort((a, b) => a[0] - b[0]).slice(0, k).map(p => p[1]).sort((a, b) => a - b);
}
export function effectiveN(lane, idxSet) { return idxSet.filter(i => lane[i] && lane[i].ret !== 0).length; }
export function downsideBeta(lane, qqq, idxSet) {
  return olsBeta(idxSet.map(i => lane[i].ret), idxSet.map(i => qqq[i].ret));
}
export function rollingCorr(lane, qqq, win = 26) {
  const out = [];
  for (let i = win; i <= lane.length; i += 1) out.push(pearson(lane.slice(i - win, i).map(p => p.ret), qqq.slice(i - win, i).map(p => p.ret)));
  return out;
}
```

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Write failing test for the circular-rotation surrogate null**

```javascript
import { surrogateJumpNull, downsideJump } from './fleet-correlate.mjs';

test('downsideJump = downsideBeta(crisis) − fullBeta; surrogate null gates the secret-beta label', () => {
  // Construct a lane with NO dependence on QQQ → observed jump should sit INSIDE the surrogate band.
  const n = 300;
  const qqq = Array.from({ length: n }, (_, i) => ({ ret: Math.sin(i) / 50 }));
  const lane = Array.from({ length: n }, (_, i) => ({ ret: Math.cos(i * 0.7) / 50, active: true }));
  const idx = crisisWeeks(qqq, 'quintile');
  const obs = downsideJump(lane, qqq, idx);
  const nullDist = surrogateJumpNull(lane, qqq, 'quintile', { K: 1000, seed: 7 });
  assert.equal(nullDist.length, 1000);
  // a known-independent lane should rarely exceed the 95th pct
  const p95 = [...nullDist].sort((a, b) => a - b)[Math.floor(0.95 * 1000)];
  assert.equal(typeof p95, 'number');
  assert.ok(typeof obs === 'number');
});

test('a TAIL-amplified-beta lane (co-moves only in crisis) exceeds the surrogate 95th pct', () => {
  // Note: a CONSTANT-beta lane has downsideβ≈fullβ → jump≈0 and (correctly) does NOT clear
  // the null. The jump detects beta AMPLIFICATION in the tail, not beta level. Construct a
  // lane uncorrelated to QQQ normally but strongly co-moving ONLY in crisis weeks.
  const n = 400;
  const qqq = Array.from({ length: n }, (_, i) => ({ ret: ((i * 37) % 100 - 50) / 1000 }));
  const crisis = crisisWeeks(qqq, 'quintile');
  const crisisSet = new Set(crisis);
  const lane = qqq.map((w, i) => ({ ret: crisisSet.has(i) ? 3 * w.ret : ((i % 7) - 3) / 1000, active: true }));
  const obs = downsideJump(lane, qqq, crisis);
  const nullDist = surrogateJumpNull(lane, qqq, 'quintile', { K: 1000, seed: 3 });
  const p95 = [...nullDist].sort((a, b) => a - b)[Math.floor(0.95 * nullDist.length)];
  assert.ok(obs > p95); // genuine tail co-movement clears the rotation null; rotations break the alignment
});
```

- [ ] **Step 6: Run to verify fail.**

- [ ] **Step 7: Implement `downsideJump` + `surrogateJumpNull`**

```javascript
export function downsideJump(lane, qqq, idxSet) {
  const full = olsBeta(lane.map(p => p.ret), qqq.map(p => p.ret));
  return downsideBeta(lane, qqq, idxSet) - full;
}
// Circular-rotation surrogate: rotate the lane series by a random offset against the fixed QQQ
// week sequence (preserves lane marginal + autocorrelation exactly, destroys QQQ cross-dependence).
// Returns K null values of the jump statistic Δ.
export function surrogateJumpNull(lane, qqq, bucket, { K = 1000, seed = 1234 } = {}) {
  const n = lane.length; const rng = mulberry32(seed); const out = [];
  for (let k = 0; k < K; k += 1) {
    const off = 1 + ((rng() * (n - 1)) | 0);
    const rot = Array.from({ length: n }, (_, i) => lane[(i + off) % n]);
    const idx = crisisWeeks(qqq, bucket); // crisis defined on the FIXED qqq
    out.push(downsideJump(rot, qqq, idx));
  }
  return out;
}
```
(`mulberry32` defined locally in this module per Task 7 Step 7.)

- [ ] **Step 8: Run to verify pass.**

- [ ] **Step 9: Commit** — `git commit -am "feat(fleet-corr): crisis-conditional cut + circular-rotation surrogate null + n-floor"`

---

## Task 9: Pre-registration (write + hash before scoring)

**Files:**
- Create: `scripts/fleet-prereg.mjs`
- Create: `scripts/fleet-prereg.test.mjs`

- [ ] **Step 1: Write failing test**

```javascript
// scripts/fleet-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, hashPrereg } from './fleet-prereg.mjs';

test('prereg block contains every pre-committed methodology key', () => {
  const p = buildPrereg();
  for (const k of ['windows', 'representation', 'benchmark', 'crisis', 'effective_n_floor', 'surrogate', 'sparse_lane_rule', 'lane_simplifications', 'acceptable_findings'])
    assert.ok(k in p, `missing ${k}`);
  assert.equal(p.crisis.primary, 'worst_quintile');
  assert.equal(p.effective_n_floor, 8);
  assert.equal(p.surrogate.K, 1000);
  assert.equal(p.surrogate.percentile, 95);
  assert.equal(p.sparse_lane_rule.zero_week_threshold, 0.40);
});

test('hashPrereg is a deterministic sha256 over canonical JSON', () => {
  const p = buildPrereg();
  assert.equal(hashPrereg(p), hashPrereg(buildPrereg()));
  assert.match(hashPrereg(p), /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `buildPrereg` + `hashPrereg`** (canonical JSON = sorted keys; `crypto.createHash('sha256')`). Encode every §11 commitment: windows (4-way 2022-01-01→2026-06-06; 3-way 2016-01-01→2026-06-06; Drift 2022+), representation (daily-MTM→weekly, gross), benchmark (QQQ/SPY), crisis (primary worst_quintile, secondary worst_decile), effective_n_floor 8, surrogate {K:1000, percentile:95, method:'circular_rotation'}, sparse_lane_rule {zero_week_threshold:0.40, metric:'active_week_conditional'}, lane_simplifications (Turtle 3 gates; def-Prophet proxy/no-timing; Drift continuation-ON + 2022 floor; regime neutral; Coil entry-anchored day-0), acceptable_findings (secretly-correlated / diversification-evaporates / equity-selloff-gap all valid).

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `git commit -am "feat(fleet-corr): hashed pre-registration block"`

---

## Task 10: Report renderer + per-lane classifier

**Files:**
- Create: `scripts/fleet-report.mjs`
- Create: `scripts/fleet-report.test.mjs`

- [ ] **Step 1: Write failing test for the classifier (the only non-trivial logic; renderer is controller-authored)**

```javascript
// scripts/fleet-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLane } from './fleet-report.mjs';

test('classifyLane: surrogate-cleared tail co-move OR high full β → secret_long_beta', () => {
  assert.equal(classifyLane({ fullBeta: 0.6, jump: 0.5, jumpP95: 0.2, crisisMean: -0.03 }), 'secret_long_beta');
  // jump below surrogate band AND low full β → genuine ballast
  assert.equal(classifyLane({ fullBeta: 0.05, jump: 0.4, jumpP95: 0.9, crisisMean: 0.0 }), 'genuine_ballast');
  // modest full beta, jump within band → mild overlap
  assert.equal(classifyLane({ fullBeta: 0.3, jump: 0.1, jumpP95: 0.4, crisisMean: -0.01 }), 'mild_overlap');
  // uncorrelated-until-crash: low full β but surrogate-CLEARED tail co-move IS the hidden tail risk
  assert.equal(classifyLane({ fullBeta: 0.05, jump: 0.5, jumpP95: 0.2, crisisMean: -0.04 }), 'secret_long_beta');
});

test('classifyLane returns insufficient_support when the crisis cell is below the n-floor', () => {
  assert.equal(classifyLane({ fullBeta: 0.1, jump: null, jumpP95: null, crisisMean: null, insufficient: true }), 'insufficient_support');
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `classifyLane`**

```javascript
// scripts/fleet-report.mjs
export function classifyLane({ fullBeta, jump, jumpP95, crisisMean, insufficient = false }) {
  if (insufficient) return 'insufficient_support';
  // Surrogate-cleared tail co-movement is the hidden-tail-risk the study hunts → flag it
  // regardless of full-sample β (the uncorrelated-until-crash case). High full β also flags.
  const tailCoMove = jump != null && jumpP95 != null && jump > jumpP95;
  if (tailCoMove || fullBeta >= 0.4) return 'secret_long_beta';
  if (Math.abs(fullBeta) >= 0.2) return 'mild_overlap';
  return 'genuine_ballast';
}
```

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Controller-author `renderReport(results)`** → returns the `docs/lab/fleet-correlation-RESULTS.md` string. Sections: prereg hash; **Table 1** full-sample corr matrix (Pearson/Spearman, n per cell, Coil/Turtle/Drift + QQQ/SPY; def-Prophet excluded — note why); **Table 2** QQQ β (full, flagged GROSS-not-net) + R²; **Table 3** crisis-conditional (per lane: crisis mean, downside β, jump Δ + surrogate p95 + label, active-week-conditional for sparse lanes, "insufficient support" where effective-n<8); rolling-corr summary; **Synthesis** per-lane {genuine_ballast / mild_overlap / secret_long_beta} via `classifyLane` + the ballast-gap call; **Caveats** (paper/gross-β/def-Prophet-proxy-no-timing/Drift-sparsity/Turtle-omitted-gates/both-windows). Write encoding utf-8.

- [ ] **Step 6: Commit** — `git commit -am "feat(fleet-corr): report renderer + surrogate-gated per-lane classifier"`

---

## Task 11: End-to-end orchestrator, run, RESULTS + RUNBOOK

**Files:**
- Create: `scripts/fleet-score.mjs` (CLI orchestrator, controller-authored)
- Create: `docs/lab/fleet-correlation-RESULTS.md` (generated, committed)
- Create: `docs/lab/fleet-correlation-RUNBOOK.md` (committed)

- [ ] **Step 1: Controller-author `fleet-score.mjs`** — orchestration contract: (1) `buildPrereg`+`hashPrereg` → write `data/lab/fleet-prereg.json` FIRST; (2) build each lane series (`simulateTurtle`/`buildCoilSeries`/`buildDriftSeries`/`simulateDefensiveProxy`) from `loadFleetBars`; load QQQ/SPY weekly; (3) `alignDaily`+`toWeekly`; (4) run the full correlate suite on BOTH windows (3-way 2016+, 4-way 2022+); (5) `renderReport` → write RESULTS.md. Flags: `--root <repo>`. No network (reads the lab cache populated in Task 1).

- [ ] **Step 2: Run the full suite** — source `.env`; `node scripts/fleet-fetch-bars.mjs && node scripts/fleet-drift-earnings.mjs && node scripts/fleet-score.mjs --root .` Expected: `data/lab/fleet-prereg.json` written before any scoring; `docs/lab/fleet-correlation-RESULTS.md` produced.

- [ ] **Step 3: Sanity-read the RESULTS** — confirm: prereg hash present; matrix cells carry n; Drift shown active-week-conditional + flagged; def-Prophet absent from Table 1, present only in the structural note; surrogate band printed beside each jump; both windows present. If any lane series is degenerate (all zeros), debug the sim, not the correlation.

- [ ] **Step 4: Write `docs/lab/fleet-correlation-RUNBOOK.md`** — re-run steps (source .env → fetch-bars → drift-earnings → score), module map, the prereg hash, known limits (Drift 2022+/sparse, def-Prophet proxy, Turtle omitted gates), and the deferred items (PCA; real-regime-gate reconstruction).

- [ ] **Step 5: Run the full test suite** — `node --test scripts/fleet-*.test.mjs` → all PASS.

- [ ] **Step 6: Final commit** — `git add scripts/fleet-score.mjs docs/lab/fleet-correlation-RESULTS.md docs/lab/fleet-correlation-RUNBOOK.md && git commit -am "feat(fleet-corr): end-to-end orchestrator + RESULTS + RUNBOOK"`

- [ ] **Step 7: Squash-merge to local main** — per `finishing-a-development-branch`: squash the worktree branch into one commit on local `main` (include the spec copied in at setup). Confirm `data/lab/*` stayed git-ignored (only the two `docs/lab/*.md` tracked). Do NOT push unless asked.

---

## Self-review notes (spec coverage)

- §3 decisions → daily-MTM (Tasks 2–5), weekly (Task 6), gross (no friction applied), QQQ/SPY benchmark (Task 11), regime-neutral (Tasks 2/4 omit gate).
- §5.1 Turtle (Task 2; 3 gates omitted, documented in report Task 10/11). §5.2 Coil entry-anchored day-0 (Task 3 Step 1/3). §5.3 Drift continuation-ON + inferred timing + 2022 floor (Tasks 1/4). §5.5 def-Prophet proxy, no timing inference (Task 5, report excludes from Table 1).
- §6 outputs 1–5: corr matrix (Task 7/11), β + gross guard (Task 7/10), crisis cut + surrogate null + n-floor + quintile-primary (Task 8), rolling corr (Task 8), synthesis/classifier + ballast gap (Task 10). Sparse-lane active-week-conditional (Task 7 `conditionalSeries` + report). Block-bootstrap CIs (Task 7).
- §11 prereg hashed (Task 9), written before scoring (Task 11 Step 1).
- Open items (§12): Drift earnings source resolved to FMP earnings-calendar w/ verification (Task 1 Step 10); surrogate seam handling documented (Task 8); active-week = ≥1 position / trigger-on (encoded in each sim's `active` flag).
