# Commodity Roll-Spread Harvest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pre-registered, lab-only backtest that tests whether a dollar-neutral commodity roll-spread (long laddered / short front-month) is a friction-survivable premium that is orthogonal to the existing fleet — especially to Turtle, which holds the spread's own legs.

**Architecture:** Mirror the rejected `carry-*` suite (S3). Pure, individually-tested `commodity-*.mjs` modules: universe constants → fetch → signal (static + conditional plan) → dollar-neutral spread sim (long−short, short-leg borrow) → friction → pre-registration hash-lock → scorer that applies the dual gate and writes `docs/lab/`. Reuse the S1 `fleet-correlate`/`fleet-align`/`fleet-bars`/`fleet-turtle-sim` engine verbatim for the orthogonality gates and the Turtle-commodity comparator.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`, `node:crypto` (sha256 prereg), FMP `stable/historical-price-eod/full` for bars. No new dependencies.

## Global Constraints

- **Lab-only / paper:** no `.env` change, no Go/Node rebuild, no live-agent touch, no production `data/bar-cache`. Cache to `data/lab/commodity-cache/` (gitignored).
- **Pre-register BEFORE results:** `commodity-prereg.mjs` hash-locks the spec; the scorer writes the prereg JSON before reading any return.
- **Primary sleeve = USL/USO** (clean same-commodity roll). DBC/GSG + USCI/GSG = corroboration; UNL/UNG = reported-only (borrow-uneconomic). Verdict is on USL/USO.
- **Decisive gate = Gate 2.4** ρ to Turtle's commodity exposure (co-active weeks), because `models/trend_universe.go` holds `USO, UNG, DBC, DBA, DBB, GLD, SLV`. Bond-carry died on the analogous IEF overlap.
- **Dollar-neutral, NOT beta-neutral** (residual short-front tilt is real; do not claim beta-neutrality).
- **Static always-on is the primary, parameter-free signal.** Conditional trailing-3-month is a robustness variant only.
- **Full-sample is the primary edge estimate** (parameter-free ⇒ no overfit to guard); 2016–2026 reported as a stability/tail sub-period. USO mandate-change ⇒ report **pre-/post-2020-04 split**.
- **Friction:** per-leg round-trip half-spread {5 bps liquid, 12 bps thin}; short borrow {75 bps oil/broad, 250 bps natgas} annualized; verdict leans on **2× stress**.
- **Subagent TDD, Haiku implementers.** `node:test`. Frequent commits. Re-assert branch before each commit (`[[shared-root-worktree-collision]]`; a concurrent session is active on this repo).
- **Node `Date.now()`/`Math.random()` are fine in scripts here** (this is a normal Node CLI, not a workflow script) — but bootstraps must take an explicit `seed` for reproducibility, as the `fleet-correlate`/`coil-threshold-metrics` helpers already do.

## Pre-flight (execution-time, before Task 1)

The executor (via `superpowers:using-git-worktrees`) creates an isolated worktree `commodity-roll-spread` branched from local `main` @ `64c983a`. Then:
- [ ] Copy the untracked spec into the worktree: `docs/superpowers/specs/2026-06-20-commodity-roll-spread-harvest-design.md` and this plan must exist in the worktree.
- [ ] Confirm `data/lab/` is gitignored: `git check-ignore data/lab/commodity-cache/x.json` prints the path. If not, add `data/lab/` to `.gitignore` in the first commit.
- [ ] Confirm the S1 fleet cache exists for the lane series: `ls data/lab/fleet-bar-cache/QQQ.json data/lab/fleet-bar-cache/USO.json`. If absent, the lane/Turtle-comparator gates will be run after `scripts/fleet-fetch-bars.mjs` is re-run (note in RUNBOOK; do not block earlier tasks).

---

### Task 1: `commodity-universe.mjs` — single source of truth

**Files:**
- Create: `scripts/commodity-universe.mjs`
- Test: `scripts/commodity-universe.test.mjs`

**Interfaces:**
- Produces: `SPREADS` (array of `{key, long, short, role, start, longInTurtle, shortInTurtle}`), `PRIMARY_KEY='USL_USO'`, `TURTLE_COMMODITY_TICKERS` (`['USO','UNG','DBC','DBA','DBB','GLD','SLV']`), `FETCH_TICKERS`, `BENCHMARK='QQQ'`, `HALF_SPREAD_BPS` (`{USO:5,GSG:5,UNG:5,DBC:5,USL:12,UNL:12,USCI:12}`), `BORROW_BPS` (`{USO:75,GSG:75,DBC:75,USCI:75,UNG:250,UNL:250,USL:75}`), `FETCH_FROM='2006-01-01'`, `STABILITY_START='2016-01-01'`, `STUDY_END='2026-06-20'`, `USO_SPLIT='2020-04-01'`, `COND_LOOKBACK_MONTHS=3`, `EDGE_BLOCK_WEEKS=20`, `COMMODITY_CACHE_SUBDIR=join('data','lab','commodity-cache')`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/commodity-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPREADS, PRIMARY_KEY, TURTLE_COMMODITY_TICKERS, FETCH_TICKERS, HALF_SPREAD_BPS, BORROW_BPS, USO_SPLIT } from './commodity-universe.mjs';

test('primary spread is the clean same-commodity WTI roll', () => {
  const primary = SPREADS.find((s) => s.key === PRIMARY_KEY);
  assert.equal(primary.long, 'USL');
  assert.equal(primary.short, 'USO');
  assert.equal(primary.role, 'primary');
  assert.equal(primary.shortInTurtle, true); // USO is in Turtle → Gate 2.4 is decisive
});

test('Turtle commodity comparator matches trend_universe.go energy+commodity+metals', () => {
  assert.deepEqual([...TURTLE_COMMODITY_TICKERS].sort(),
    ['DBA','DBB','DBC','GLD','SLV','UNG','USO'].sort());
});

test('fetch list covers every leg + the Turtle comparator + benchmark', () => {
  for (const t of ['USL','USO','UNL','UNG','DBC','GSG','USCI','DBA','DBB','GLD','SLV','QQQ'])
    assert.ok(FETCH_TICKERS.includes(t), `missing ${t}`);
});

test('natgas is the most borrow-expensive short and USO split date is pinned', () => {
  assert.ok(BORROW_BPS.UNG > BORROW_BPS.USO);
  assert.equal(USO_SPLIT, '2020-04-01');
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test scripts/commodity-universe.test.mjs` → FAIL (module not found).
- [ ] **Step 3: Write minimal implementation**

```js
// scripts/commodity-universe.mjs
import { join } from 'node:path';

export const SPREADS = [
  { key: 'USL_USO',  long: 'USL',  short: 'USO', role: 'primary',       start: '2007-12-06', longInTurtle: false, shortInTurtle: true  },
  { key: 'UNL_UNG',  long: 'UNL',  short: 'UNG', role: 'reported_only', start: '2009-11-18', longInTurtle: false, shortInTurtle: true  },
  { key: 'DBC_GSG',  long: 'DBC',  short: 'GSG', role: 'corroboration', start: '2007-01-05', longInTurtle: true,  shortInTurtle: false },
  { key: 'USCI_GSG', long: 'USCI', short: 'GSG', role: 'triangulation', start: '2010-08-10', longInTurtle: false, shortInTurtle: false },
];
export const PRIMARY_KEY = 'USL_USO';
export const TURTLE_COMMODITY_TICKERS = ['USO', 'UNG', 'DBC', 'DBA', 'DBB', 'GLD', 'SLV']; // trend_universe.go energy+commodity+metals
export const BENCHMARK = 'QQQ';
export const FETCH_TICKERS = [...new Set([
  ...SPREADS.flatMap((s) => [s.long, s.short]), ...TURTLE_COMMODITY_TICKERS, BENCHMARK,
])];
export const HALF_SPREAD_BPS = { USO: 5, GSG: 5, UNG: 5, DBC: 5, USL: 12, UNL: 12, USCI: 12 };
export const BORROW_BPS      = { USO: 75, GSG: 75, DBC: 75, USCI: 75, USL: 75, UNG: 250, UNL: 250 };
export const FETCH_FROM = '2006-01-01';
export const STABILITY_START = '2016-01-01';
export const STUDY_END = '2026-06-20';
export const USO_SPLIT = '2020-04-01';
export const COND_LOOKBACK_MONTHS = 3;
export const EDGE_BLOCK_WEEKS = 20;
export const COMMODITY_CACHE_SUBDIR = join('data', 'lab', 'commodity-cache');
```

- [ ] **Step 4: Run test to verify it passes** — `node --test scripts/commodity-universe.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add scripts/commodity-universe.mjs scripts/commodity-universe.test.mjs && git commit -m "feat(commodity-roll): universe constants + Turtle-overlap comparator"`

---

### Task 2: `commodity-fetch.mjs` — ETF bar backfill (run-and-verify, mirrors `carry-fetch.mjs`)

**Files:**
- Create: `scripts/commodity-fetch.mjs`
- Test: `scripts/commodity-fetch.test.mjs` (pure helper only — the network run is a verify step, exactly as `carry-fetch` is untested for its fetch path)

**Interfaces:**
- Produces: `cachePath(root, ticker)`; writes `data/lab/commodity-cache/<TICKER>.json` as `{written_at, bars:[{Timestamp,Open,High,Low,Close,Volume}]}` (the shape `loadFleetBars`'s `parseBarsWithVolume` consumes). Reuses `fmpEodToBars` from `ema-bars.mjs`.

- [ ] **Step 1: Write the failing test** (pure helper):

```js
// scripts/commodity-fetch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachePath } from './commodity-fetch.mjs';
test('cachePath upper-cases and lands in the gitignored lab cache', () => {
  assert.match(cachePath('/r', 'uso'), /data[\\/]lab[\\/]commodity-cache[\\/]USO\.json$/);
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test scripts/commodity-fetch.test.mjs` → FAIL.
- [ ] **Step 3: Write implementation** (mirror `carry-fetch.mjs` exactly; only the ticker list + cache dir differ):

```js
// scripts/commodity-fetch.mjs
// One-shot FMP backfill → data/lab/commodity-cache/. Mirrors carry-fetch.mjs.
// Requires FMP_API_KEY (source project-root .env first). Run: node scripts/commodity-fetch.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fmpEodToBars } from './ema-bars.mjs';
import { COMMODITY_CACHE_SUBDIR, FETCH_TICKERS, FETCH_FROM } from './commodity-universe.mjs';

const KEY = process.env.FMP_API_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function cachePath(root, ticker) { return join(root, COMMODITY_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`); }

async function fetchBars(ticker, to) {
  const url = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${ticker}&from=${FETCH_FROM}&to=${to}&apikey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
  return fmpEodToBars(await res.json());
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('commodity-fetch.mjs')) {
  if (!KEY) { process.stderr.write('FMP_API_KEY not set — source project-root .env first.\n'); process.exit(2); }
  const root = process.cwd();
  const to = new Date().toISOString().slice(0, 10);
  mkdirSync(join(root, COMMODITY_CACHE_SUBDIR), { recursive: true });
  let ok = 0, fail = 0;
  for (const t of FETCH_TICKERS) {
    try {
      const bars = await fetchBars(t, to);
      writeFileSync(cachePath(root, t), JSON.stringify({ written_at: new Date().toISOString(),
        bars: bars.map((b) => ({ Timestamp: `${b.date}T12:00:00Z`, Open: b.open, High: b.high, Low: b.low, Close: b.close, Volume: b.volume })) }));
      ok += 1; process.stdout.write(`${t}: ${bars.length} bars (${bars[0]?.date} → ${bars.at(-1)?.date})\n`);
    } catch (e) { fail += 1; process.stderr.write(`${e.message}\n`); }
    await sleep(250);
  }
  process.stdout.write(`\ncommodity-fetch done: ${ok}/${FETCH_TICKERS.length} ok, ${fail} failed\n`);
}
```

- [ ] **Step 4: Verify** — `node --test scripts/commodity-fetch.test.mjs` → PASS. Then backfill: `set -a && . ./.env && set +a && node scripts/commodity-fetch.mjs` → expect 12/12 ok, USL from 2007-12, UNL from 2009-11, USCI from 2010-08.
- [ ] **Step 5: Commit** — `git add scripts/commodity-fetch.mjs scripts/commodity-fetch.test.mjs && git commit -m "feat(commodity-roll): FMP ETF backfill into gitignored lab cache"`

---

### Task 3: `commodity-signal.mjs` — static + conditional position plan

**Files:**
- Create: `scripts/commodity-signal.mjs`
- Test: `scripts/commodity-signal.test.mjs`

**Interfaces:**
- Consumes: a `spreadDaily` array `[{date, retSpread}]` (from Task 5, but the signal only needs `{date,retSpread}`, so it is built/tested independently here).
- Produces: `monthlySpreadReturns(spreadDaily)` → `[{month:'YYYY-MM', ret}]` (compounded within month); `staticPlan(months)` → `Map<'YYYY-MM', true>`; `conditionalPlan(monthly, {lookback})` → `Map<'YYYY-MM', boolean>` where month M is active iff the compounded gross spread return over the prior `lookback` months > 0 (no look-ahead: uses months strictly before M); `changeFraction(staticP, condP)` → fraction of months where the two plans differ.

- [ ] **Step 1: Write the failing test**

```js
// scripts/commodity-signal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlySpreadReturns, staticPlan, conditionalPlan, changeFraction } from './commodity-signal.mjs';

const daily = [
  { date: '2020-01-31', retSpread: 0.01 }, { date: '2020-02-28', retSpread: 0.02 },
  { date: '2020-03-31', retSpread: -0.05 }, { date: '2020-04-30', retSpread: 0.03 },
  { date: '2020-05-29', retSpread: 0.01 },
];

test('monthly compounding groups by calendar month', () => {
  const m = monthlySpreadReturns(daily);
  assert.deepEqual(m.map((x) => x.month), ['2020-01','2020-02','2020-03','2020-04','2020-05']);
  assert.ok(Math.abs(m[2].ret - (-0.05)) < 1e-9);
});

test('static plan always holds', () => {
  const m = monthlySpreadReturns(daily);
  const p = staticPlan(m.map((x) => x.month));
  assert.equal([...p.values()].every((v) => v === true), true);
});

test('conditional plan steps aside after negative trailing roll, no look-ahead', () => {
  const m = monthlySpreadReturns(daily);
  const p = conditionalPlan(m, { lookback: 2 });
  // 2020-05 sees trailing {Mar -0.05, Apr +0.03} → compounded < 0 → flat
  assert.equal(p.get('2020-05'), false);
  // 2020-03 sees trailing {Jan +0.01, Feb +0.02} → > 0 → active
  assert.equal(p.get('2020-03'), true);
});

test('changeFraction counts disagreements', () => {
  const m = monthlySpreadReturns(daily);
  const f = changeFraction(staticPlan(m.map((x) => x.month)), conditionalPlan(m, { lookback: 2 }));
  assert.ok(f > 0 && f <= 1);
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test scripts/commodity-signal.test.mjs` → FAIL.
- [ ] **Step 3: Write minimal implementation**

```js
// scripts/commodity-signal.mjs
// Static (always-on, parameter-free PRIMARY) and conditional (trailing-roll robustness variant)
// position plans for a dollar-neutral spread. Mirrors carry-signal's decisions→plan shape.
export function monthlySpreadReturns(spreadDaily) {
  const byMonth = new Map(); const order = [];
  for (const p of spreadDaily) {
    const k = p.date.slice(0, 7);
    if (!byMonth.has(k)) { byMonth.set(k, 1); order.push(k); }
    byMonth.set(k, byMonth.get(k) * (1 + p.retSpread));
  }
  return order.map((k) => ({ month: k, ret: byMonth.get(k) - 1 }));
}
export function staticPlan(months) { return new Map(months.map((m) => [m, true])); }
export function conditionalPlan(monthly, { lookback = 3 } = {}) {
  const plan = new Map();
  for (let i = 0; i < monthly.length; i += 1) {
    const prior = monthly.slice(Math.max(0, i - lookback), i); // strictly before month i → no look-ahead
    const comp = prior.reduce((a, r) => a * (1 + r.ret), 1) - 1;
    plan.set(monthly[i].month, prior.length === lookback ? comp > 0 : true); // warm-up: hold
  }
  return plan;
}
export function changeFraction(staticP, condP) {
  let diff = 0, n = 0;
  for (const [m, s] of staticP) { n += 1; if ((condP.get(m) ?? s) !== s) diff += 1; }
  return n ? diff / n : 0;
}
```

- [ ] **Step 4: Run test to verify it passes** — `node --test scripts/commodity-signal.test.mjs` → PASS.
- [ ] **Step 5: Commit** — `git add scripts/commodity-signal.mjs scripts/commodity-signal.test.mjs && git commit -m "feat(commodity-roll): static + conditional spread position plans"`

---

### Task 4: `commodity-friction.mjs` — per-leg spread + short borrow

**Files:**
- Create: `scripts/commodity-friction.mjs`
- Test: `scripts/commodity-friction.test.mjs`

**Interfaces:**
- Produces: `rebalanceCost(longTk, shortTk, stressMult)` → fractional round-trip cost charged once per monthly rebalance = `2·(halfSpreadLong+halfSpreadShort)/1e4·stress` (conservative: full round-trip both legs/month); `dailyBorrow(shortTk, stressMult)` → `(BORROW_BPS[short]/1e4)/252·stress`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/commodity-friction.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebalanceCost, dailyBorrow } from './commodity-friction.mjs';
import { HALF_SPREAD_BPS, BORROW_BPS } from './commodity-universe.mjs';

test('rebalance cost is round-trip on both legs, scaled by stress', () => {
  const base = rebalanceCost('USL', 'USO', 1);
  assert.ok(Math.abs(base - 2 * (HALF_SPREAD_BPS.USL + HALF_SPREAD_BPS.USO) / 1e4) < 1e-12);
  assert.ok(Math.abs(rebalanceCost('USL', 'USO', 2) - 2 * base) < 1e-12);
});

test('daily borrow annualizes the short-leg rate over 252 days; natgas dominates', () => {
  assert.ok(Math.abs(dailyBorrow('USO', 1) - (BORROW_BPS.USO / 1e4) / 252) < 1e-15);
  assert.ok(dailyBorrow('UNG', 1) > dailyBorrow('USO', 1));
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test scripts/commodity-friction.test.mjs` → FAIL.
- [ ] **Step 3: Write minimal implementation**

```js
// scripts/commodity-friction.mjs
import { HALF_SPREAD_BPS, BORROW_BPS } from './commodity-universe.mjs';
export function rebalanceCost(longTk, shortTk, stressMult = 1) {
  return 2 * ((HALF_SPREAD_BPS[longTk] + HALF_SPREAD_BPS[shortTk]) / 1e4) * stressMult;
}
export function dailyBorrow(shortTk, stressMult = 1) {
  return ((BORROW_BPS[shortTk] / 1e4) / 252) * stressMult;
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add scripts/commodity-friction.mjs scripts/commodity-friction.test.mjs && git commit -m "feat(commodity-roll): spread friction + short-leg borrow model"`

---

### Task 5: `commodity-sim.mjs` — dollar-neutral spread P&L (the genuinely new module)

**Files:**
- Create: `scripts/commodity-sim.mjs`
- Test: `scripts/commodity-sim.test.mjs`

**Interfaces:**
- Consumes: `loadFleetBars`-shaped bars `[{date,open,high,low,close,...}]`; `rebalanceCost`/`dailyBorrow` (Task 4); plans (Task 3).
- Produces: `spreadDailyReturns(longBars, shortBars, {start,end})` → `[{date, retLong, retShort, retSpread}]` over dates in BOTH (retSpread = retLong − retShort, the dollar-neutral spread); `simulateSpread(spreadDaily, plan, {longTk, shortTk, stressMult, start, end})` → `[{date, ret, active}]` (net: when active, `retSpread − dailyBorrow(short)`, minus `rebalanceCost` on the first trading day of each month and a round-trip on each flat→active transition; when flat, `ret=0`). Daily → weekly via reused `toWeekly`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/commodity-sim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spreadDailyReturns, simulateSpread } from './commodity-sim.mjs';
import { staticPlan, conditionalPlan, monthlySpreadReturns } from './commodity-signal.mjs';

const L = [ {date:'2021-01-04',close:100},{date:'2021-01-05',close:101},{date:'2021-02-01',close:101},{date:'2021-02-02',close:103} ];
const S = [ {date:'2021-01-04',close:50}, {date:'2021-01-05',close:50}, {date:'2021-02-01',close:50}, {date:'2021-02-02',close:49}  ];

test('spread daily return is long minus short on common dates', () => {
  const sd = spreadDailyReturns(L, S, {});
  assert.equal(sd[0].date, '2021-01-05');           // first common date with a prior close
  assert.ok(Math.abs(sd[0].retLong - 0.01) < 1e-9);
  assert.ok(Math.abs(sd[0].retShort - 0) < 1e-9);
  assert.ok(Math.abs(sd[0].retSpread - 0.01) < 1e-9);
});

test('static sim charges borrow every active day and rebalance at each month start', () => {
  const sd = spreadDailyReturns(L, S, {});
  const months = monthlySpreadReturns(sd).map((m) => m.month);
  const out = simulateSpread(sd, staticPlan(months), { longTk: 'USL', shortTk: 'USO', stressMult: 1 });
  assert.equal(out.every((p) => p.active), true);
  // net < gross because borrow + rebalance are subtracted
  const gross = sd.reduce((a, r) => a + r.retSpread, 0);
  const net = out.reduce((a, r) => a + r.ret, 0);
  assert.ok(net < gross);
});

test('conditional flat months earn nothing and pay no borrow', () => {
  const sd = spreadDailyReturns(L, S, {});
  const monthly = monthlySpreadReturns(sd);
  const plan = conditionalPlan(monthly, { lookback: 1 });
  const out = simulateSpread(sd, plan, { longTk: 'USL', shortTk: 'USO', stressMult: 1 });
  for (const p of out) if (!p.active) assert.equal(p.ret, 0);
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test scripts/commodity-sim.test.mjs` → FAIL.
- [ ] **Step 3: Write minimal implementation**

```js
// scripts/commodity-sim.mjs
// Dollar-neutral spread (long − short) daily P&L. Unlike carry-sim (long-or-cash), both legs are
// always positioned when active; the short leg pays borrow daily. Friction: round-trip both legs on
// the first trading day of each month (conservative) + a round-trip on each flat→active transition.
import { rebalanceCost, dailyBorrow } from './commodity-friction.mjs';

export function spreadDailyReturns(longBars, shortBars, { start, end } = {}) {
  const sIdx = new Map(shortBars.map((b) => [b.date, b]));
  const out = [];
  for (let i = 1; i < longBars.length; i += 1) {
    const d = longBars[i].date;
    if ((start && d < start) || (end && d > end)) continue;
    const lPrev = longBars[i - 1], lCur = longBars[i];
    const sCur = sIdx.get(d), sPrev = sIdx.get(longBars[i - 1].date);
    if (!sCur || !sPrev) continue;
    const retLong = lCur.close / lPrev.close - 1;
    const retShort = sCur.close / sPrev.close - 1;
    out.push({ date: d, retLong, retShort, retSpread: retLong - retShort });
  }
  return out;
}

export function simulateSpread(spreadDaily, plan, { longTk, shortTk, stressMult = 1, start, end } = {}) {
  const rows = spreadDaily.filter((p) => (!start || p.date >= start) && (!end || p.date <= end));
  const out = []; let prevMonth = null; let prevActive = false;
  for (const p of rows) {
    const month = p.date.slice(0, 7);
    const active = !!plan.get(month);
    let ret = 0;
    if (active) {
      ret = p.retSpread - dailyBorrow(shortTk, stressMult);
      if (month !== prevMonth) ret -= rebalanceCost(longTk, shortTk, stressMult); // monthly re-set
      if (!prevActive) ret -= rebalanceCost(longTk, shortTk, stressMult);          // re-entry round-trip
    }
    out.push({ date: p.date, ret, active });
    prevMonth = month; prevActive = active;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add scripts/commodity-sim.mjs scripts/commodity-sim.test.mjs && git commit -m "feat(commodity-roll): dollar-neutral spread sim (long-short, short-leg borrow)"`

---

### Task 6: `commodity-prereg.mjs` — hash-locked pre-registration (mirror `carry-prereg.mjs`)

**Files:**
- Create: `scripts/commodity-prereg.mjs`
- Test: `scripts/commodity-prereg.test.mjs`

**Interfaces:**
- Produces: `buildPrereg()` → object encoding §1/§4/§5 of the spec; `hashPrereg(prereg)` → sha256 of a canonical (sorted-key) serialization. Copy `canonical`/`hashPrereg` verbatim from `carry-prereg.mjs`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/commodity-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, hashPrereg } from './commodity-prereg.mjs';

test('prereg pins primary, the decisive Turtle gate, and the demand/supply cut', () => {
  const p = buildPrereg();
  assert.equal(p.universe.primary, 'USL_USO');
  assert.equal(p.orthogonality_gate.decisive, 'rho_to_turtle_commodity_cluster_co_active');
  assert.match(p.crash_type_cut, /demand.*supply/i);
  assert.equal(p.signal.beta_neutral, false); // we explicitly do NOT claim beta-neutral
});

test('hash is stable and order-independent', () => {
  assert.equal(hashPrereg(buildPrereg()), hashPrereg(buildPrereg()));
  assert.match(hashPrereg(buildPrereg()), /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Write implementation** (mirror `carry-prereg.mjs`; copy its `canonical`/`hashPrereg`):

```js
// scripts/commodity-prereg.mjs
import { createHash } from 'node:crypto';
import { PRIMARY_KEY, TURTLE_COMMODITY_TICKERS, STABILITY_START, STUDY_END, USO_SPLIT, COND_LOOKBACK_MONTHS, EDGE_BLOCK_WEEKS } from './commodity-universe.mjs';

export function buildPrereg() {
  return {
    study: 'commodity-roll-spread-harvest',
    window: { fetch_from: '2006', stability_start: STABILITY_START, end: STUDY_END,
      primary_estimate: 'FULL_SAMPLE_for_power_parameter_free', stability_role: 'sub_period_and_tails',
      uso_mandate_split: USO_SPLIT, uso_split_role: 'report_pre_vs_post_front_purity_degraded' },
    signal: { structure: 'dollar_neutral_long_laddered_short_front', beta_neutral: false,
      residual: 'net_short_front_month_tilt_is_the_cocrash_channel',
      primary_rule: 'static_always_on_parameter_free',
      variant: `conditional_trailing_${COND_LOOKBACK_MONTHS}m_roll_gt_0`, variant_role: 'robustness_only',
      rebalance: 'monthly' },
    universe: { primary: PRIMARY_KEY, corroboration: ['DBC_GSG', 'USCI_GSG'], reported_only: ['UNL_UNG'],
      verdict_bearing: 'primary_only', corroboration_rule: 'opposite_sign_downgrades_to_oil_idiosyncratic' },
    friction: { half_spread_round_trip_both_legs: true, short_borrow_annualized: true, stress: 2,
      verdict_leans_on: 'stressed_figure', uso_borrow_bps: 75, natgas_borrow_bps: 250 },
    edge_gate: { well_powered: true, basis: 'continuous_monthly_roll_accrual',
      a_friction_net_full_sample_ci_gt_0: { block_weeks: EDGE_BLOCK_WEEKS },
      b_tail_descriptive_power_flagged: 'named_backwardation_episodes_2022_defining', c_2x_friction_stress: true },
    orthogonality_gate: {
      qqq_beta_ci_near_0: true, qqq_rho_max: 0.3,
      crisis_mean_ci_not_below_0: true, crisis_power: 'cluster_limited_NOT_well_powered',
      lane_rho_max: 0.3, lanes: ['Coil', 'Turtle', 'Drift', 'DefProxy'],
      decisive: 'rho_to_turtle_commodity_cluster_co_active', turtle_cluster: TURTLE_COMMODITY_TICKERS,
      decisive_rho_max: 0.3, decisive_basis: 'legs_USO_UNG_DBC_are_turtle_holdings_bond_carry_precedent' },
    crash_type_cut: 'DESCRIPTIVE: classify each QQQ-worst-week cluster demand- vs supply-driven by sign of front-energy (USO) move; report sleeve return per type; a KEEP whose ballast is demand-driven-only is a regime artifact → downgrade',
    verdict: { keep_requires: 'edge_ci_gt_0 AND turtle_co_active_rho_lt_0.3 AND no_cocrash AND ballast_not_demand_only',
      keep_confidence: 'provisional_pending_more_supply_shock_regimes',
      reject_trustworthy: 'turtle_overlap_and_full_series_orthogonality_well_powered' },
    acceptable_findings: [
      'entangled with Turtle commodity sleeve (legs shared) -> REJECT (well-powered base case)',
      'supply-shock co-crash (2022) -> REJECT',
      'crowded-short borrow eats the premium at 2x -> REJECT',
      'oil-roll real but broad complex does not corroborate -> INCONCLUSIVE (oil-idiosyncratic)',
      'RV-roll orthogonal to Turtle-trend AND friction-survivable AND ballast beyond demand crashes -> provisional KEEP',
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

- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add scripts/commodity-prereg.mjs scripts/commodity-prereg.test.mjs && git commit -m "feat(commodity-roll): hash-locked pre-registration"`

---

### Task 7: `commodity-crash.mjs` — demand/supply crash classifier (tested pure helper for the scorer)

**Files:**
- Create: `scripts/commodity-crash.mjs`
- Test: `scripts/commodity-crash.test.mjs`

**Interfaces:**
- Produces: `classifyCrashWeeks(crisisWeekKeys, frontEnergyWeekly)` → `{demand:[wk...], supply:[wk...]}` splitting QQQ-worst weeks by the sign of the contemporaneous front-energy (USO) weekly return (energy down = demand-driven; energy up = supply-driven); `meanRet(sleeveWeeklyByWk, keys)` → mean sleeve return over those weeks.

- [ ] **Step 1: Write the failing test**

```js
// scripts/commodity-crash.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCrashWeeks, meanRet } from './commodity-crash.mjs';

test('demand crash = energy fell; supply crash = energy rose', () => {
  const front = new Map([['2020-W12', -0.30], ['2022-W09', 0.20]]);
  const { demand, supply } = classifyCrashWeeks(['2020-W12', '2022-W09'], front);
  assert.deepEqual(demand, ['2020-W12']);
  assert.deepEqual(supply, ['2022-W09']);
});

test('meanRet averages the sleeve over given weeks', () => {
  const sleeve = new Map([['a', 0.02], ['b', -0.04]]);
  assert.ok(Math.abs(meanRet(sleeve, ['a', 'b']) - (-0.01)) < 1e-9);
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Write minimal implementation**

```js
// scripts/commodity-crash.mjs
// Demand- vs supply-driven crash cut (the bond-carry bull/bear-steepening analogue).
export function classifyCrashWeeks(crisisWeekKeys, frontEnergyWeekly) {
  const demand = [], supply = [];
  for (const wk of crisisWeekKeys) {
    const e = frontEnergyWeekly.get(wk);
    if (e == null) continue;
    (e <= 0 ? demand : supply).push(wk);
  }
  return { demand, supply };
}
export function meanRet(sleeveWeeklyByWk, keys) {
  const vals = keys.map((k) => sleeveWeeklyByWk.get(k)).filter((v) => v != null);
  return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add scripts/commodity-crash.mjs scripts/commodity-crash.test.mjs && git commit -m "feat(commodity-roll): demand vs supply crash-type classifier"`

---

### Task 8: `commodity-score.mjs` — orchestrator + RESULTS (run-and-verify, mirrors `carry-score.mjs`)

**Files:**
- Create: `scripts/commodity-score.mjs`
- Create: `docs/lab/commodity-roll-spread-RUNBOOK.md` (written by hand in this task — data provenance, the Task-0 spike findings, USO-split caveat, reuse notes)
- Output (gitignored): `data/lab/commodity-prereg.json`; Output (committed): `docs/lab/commodity-roll-spread-RESULTS.md`

**Interfaces:**
- Consumes: every module above + reused `fleet-*`. Builds the primary sleeve (USL/USO), the corroboration sleeves, the Turtle-commodity comparator via `simulateTurtle(Map of TURTLE_COMMODITY_TICKERS bars)`, the lanes via the S1 builders, then applies the gates and writes RESULTS.

- [ ] **Step 1: Scaffold the orchestrator** (mirror `carry-score.mjs` section-by-section). Key wiring, copy the shapes from `carry-score.mjs`:

```js
// scripts/commodity-score.mjs — run: node scripts/commodity-score.mjs --root .
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildPrereg, hashPrereg } from './commodity-prereg.mjs';
import { loadFleetBars } from './fleet-bars.mjs';                 // reuse: bar loader (also serves commodity cache shape)
import { SPREADS, PRIMARY_KEY, TURTLE_COMMODITY_TICKERS, STABILITY_START, STUDY_END, EDGE_BLOCK_WEEKS, COND_LOOKBACK_MONTHS, USO_SPLIT, COMMODITY_CACHE_SUBDIR } from './commodity-universe.mjs';
import { spreadDailyReturns, simulateSpread } from './commodity-sim.mjs';
import { monthlySpreadReturns, staticPlan, conditionalPlan, changeFraction } from './commodity-signal.mjs';
import { classifyCrashWeeks, meanRet } from './commodity-crash.mjs';
import { toWeekly, isoWeekKey } from './fleet-align.mjs';
import { simulateTurtle } from './fleet-turtle-sim.mjs';
import { buildCoilSeries } from './fleet-coil-marks.mjs';
import { buildDriftSeries } from './fleet-drift-sim.mjs';
import { simulateDefensiveProxy } from './fleet-defensive-proxy.mjs';
import { TURTLE_ETFS } from './fleet-universe.mjs';
import { pearson, betaTo, bootstrapBetaCI, crisisWeeks, crisisMean, crisisMeanCI, rhoCrisis, rotationBand } from './fleet-correlate.mjs';
import { bootstrapMeanCI } from './coil-threshold-metrics.mjs';
```

- Load commodity-cache bars with a small local loader that reads `data/lab/commodity-cache/<T>.json` via the same `parseBarsWithVolume` path `loadFleetBars` uses (or copy `loadFleetBars` pointed at `COMMODITY_CACHE_SUBDIR`). The Turtle-commodity comparator: `const cMap = new Map(TURTLE_COMMODITY_TICKERS.map((t) => [t, loadCommodityBars(root, t)])); const turtleCommodityWk = toWeekly(simulateTurtle(cMap, { start: STABILITY_START, end: STUDY_END }));` — **exactly** the carry-score Turtle-rates trick, swapping the cluster.
- Front-energy weekly (for the crash cut): `toWeekly(dailyRet(loadCommodityBars(root,'USO'), STABILITY_START))` → `Map<week, ret>`.

- [ ] **Step 2: Implement the per-spread `evaluate(spread)`** — for each spread: `spreadDailyReturns` → static plan → `simulateSpread` at 1× and 2× → `toWeekly`; edge gate via `bootstrapMeanCI(rows,{blockSessions:EDGE_BLOCK_WEEKS,seed:7})` on full sample AND on the `STABILITY_START+` slice; orthogonality on the `STABILITY_START+` weeks aligned with QQQ/lanes/turtleCommodity; crisis cut via `crisisWeeks(qqqObj,'quintile')` → `crisisMean`/`crisisMeanCI`; demand/supply split via `classifyCrashWeeks(crisisWeekKeys, frontEnergyWeekly)` + `meanRet`. Reuse the `alignOnWeek` helper from `carry-score.mjs` verbatim.

- [ ] **Step 3: Verdict logic** — gates copied from spec §5:

```js
const trCoActivePass = rhoTurtleCommodityCoActive != null && Math.abs(rhoTurtleCommodityCoActive) < 0.3; // DECISIVE
const edgePass = edgeFull.lo > 0, stressPass = edge2x.lo > 0;
const qqqPass = Math.abs(rhoQ) < 0.3 && (betaCI.lo <= 0 && betaCI.hi >= 0);
const crisisPass = crCI.hi >= 0;                       // cluster-limited, reported as such
const lanePass = ['Coil','Turtle','Drift','DefProxy'].every((n) => Math.abs(laneRho[n]) < 0.3);
const ballastNotDemandOnly = !(supplyMean < 0 && demandMean > 0 && Math.abs(supplyMean) > Math.abs(demandMean));
// REJECT if !trCoActivePass (base case) || !qqqPass || !crisisPass || !lanePass || !(edgePass&&stressPass)
// INCONCLUSIVE if corroboration sign opposite primary, OR supply-episode count < 2, OR only USCI_GSG (Turtle-free) is orthogonal
// KEEP (provisional) otherwise
```

- [ ] **Step 4: Write RESULTS + run** — emit `docs/lab/commodity-roll-spread-RESULTS.md` (mirror carry-score's table layout: prereg hash header, VERDICT line, Gate 1 edge table full+stability+2×, Gate 1b tail + the **demand/supply table**, Gate 2 orthogonality table with the **decisive Turtle-commodity co-active ρ bolded**, corroboration row for DBC/GSG + USCI/GSG, conditional-variant change-fraction, USO pre/post-2020 split). Use `{ encoding: 'utf-8' }` on every `writeFileSync` for markdown. Run: `node scripts/commodity-score.mjs --root .` → prints `prereg <hash>` and `VERDICT: ...`.
- [ ] **Step 5: Verify the verdict is reasoned, not crashed** — assert the RESULTS file exists, contains the prereg hash and a VERDICT in {KEEP,REJECT,INCONCLUSIVE}, and that the decisive Turtle-commodity co-active ρ is populated (not `—`). If the fleet cache was missing (pre-flight), run `node scripts/fleet-fetch-bars.mjs` first and note it in the RUNBOOK.
- [ ] **Step 6: Commit** — `git add scripts/commodity-score.mjs docs/lab/commodity-roll-spread-RESULTS.md docs/lab/commodity-roll-spread-RUNBOOK.md && git commit -m "feat(commodity-roll): scorer + dual-gate verdict + RESULTS"`

---

### Task 9: Finalize — spec/plan in-tree, probe cleanup, squash-merge

- [ ] **Step 1:** Delete the throwaway probe: `git rm --cached scripts/commodity-feasibility-probe.mjs 2>/dev/null; rm -f scripts/commodity-feasibility-probe.mjs` (its findings live in the RUNBOOK + spec §3). Confirm `data/lab/` is gitignored and no cache/`commodity-prereg.json` is staged.
- [ ] **Step 2:** Run the full suite green: `node --test scripts/commodity-*.test.mjs` → all PASS.
- [ ] **Step 3:** Ensure the spec + this plan are committed in the worktree.
- [ ] **Step 4: Re-assert branch, then squash-merge to local main** (`[[shared-root-worktree-collision]]` — re-verify HEAD; a concurrent session is active). From the worktree: confirm `git rev-parse --abbrev-ref HEAD` = `commodity-roll-spread`, then squash-merge into local `main` as one commit per `[[workflow-preferences]]`. Do NOT push.

## Self-Review (completed against the spec)

**Spec coverage:** §1 universe → Task 1; §1 signals → Tasks 3/5; §2 windows/USO-split → Tasks 1/8; §3 spike → already done, recorded Task 8 RUNBOOK; §4 tail + demand/supply cut → Task 7 + Task 8 Step 4; §5 Gate 1 edge → Task 8 Step 2; §5 Gate 2 incl. decisive Turtle-commodity ρ → Task 8 Steps 2–3; §5 friction/borrow → Tasks 4; §5 verdict → Task 8 Step 3; §8 modules → Tasks 1–8; pre-registration → Task 6. No gaps.

**Placeholder scan:** every code step has runnable code; every run step has an exact command + expected result. The two run-and-verify tasks (fetch, score) mirror `carry-fetch`/`carry-score`, which are themselves untested-for-network by the same rationale, and each still ships a tested pure helper (`cachePath`, and the Task 7 classifier the scorer consumes).

**Type consistency:** sleeve daily rows are `{date,ret,active}` everywhere (matches `toWeekly`/`fleet-correlate`); weekly rows `{week,date,ret,active}`; spread rows `{date,retLong,retShort,retSpread}`; plans are `Map<'YYYY-MM',boolean>` consumed identically by `simulateSpread`. `simulateTurtle` is called with a `Map<ticker,bars>` subset exactly as `carry-score` calls it.

**Open risk flagged for execution:** if `loadFleetBars`/`parseBarsWithVolume` field-casing differs from the commodity-cache write shape, Task 8 Step 1's `loadCommodityBars` must use the same parser the cache shape targets — verify the first loaded ticker has non-empty bars before trusting any ρ.
