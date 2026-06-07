# Foundation B — Components 2b + 2c (beta/orientation + graduation gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the final two pieces of the fleet measurement layer — per-strategy beta/orientation from the live `DBSegmentPnL` daily series vs SPY (2b), and a two-track (alpha/ballast) coded graduation gate (2c) — so any strategy reaching real capital is filtered on both edge and orientation. Emits honest `HOLD: insufficient data` until the live series matures; verdicts are operator-reviewed, never auto-acted.

**Architecture:** Three new standalone Node ESM modules in `scripts/` reusing Component 3 (`managed-position-repair.mjs`), Component 2a (`trade-ledger.mjs`), and `significance-gate.mjs`. `alpaca-spy-daily.mjs` fetches SPY daily closes (Alpaca, split-adjusted); `segment-beta.mjs` reads the `db_segment_pn_ls` table via `node:sqlite` and computes gap-aware daily returns + deployed/unconditional/downside beta with bootstrap CIs; `graduation-gate.mjs` combines 2a's ledger + 2b's beta into the alpha/ballast track verdicts. All read-only; `node:test` throughout.

**Tech Stack:** Node.js ESM, built-in `node:sqlite` (`DatabaseSync`, `readOnly:true` — NOT better-sqlite3, ABI-broken on Node 24), `node:test`, Alpaca Data REST v2.

**Spec (authoritative):** `docs/superpowers/specs/2026-05-31-foundation-b-component2-measurement-design.md` §4 (2b), §5 (2c), §7 (pinned params). Parent: `2026-05-31-foundation-measurement-graduation-design.md`. **Read both before starting.** This plan builds 2b + 2c; 2a/3/1 are already merged on local `main`.

---

## Prerequisites (execution-time, before Task 1)

- Worktree off **local `main`** via `superpowers:using-git-worktrees` (memory `shared-root-worktree-collision`). All paths relative to the worktree root. **Branch off local `main` (currently `35785d7`), not origin** — the reused modules (`managed-position-repair.mjs`, `trade-ledger.mjs`, the Go `DBSegmentPnL` writer) live on local main, unpushed.
- Copy this plan + the two specs into the worktree and commit as the branch base (they're committed on main already, so they'll be present — verify with `ls docs/superpowers/specs/2026-05-31-foundation-b-component2-measurement-design.md`).
- Node v24; modules use only `node:` builtins + local imports → no `npm install`.
- **Reused exports (confirmed, do not redefine):**
  - `managed-position-repair.mjs`: `resolveSandboxDbPaths(projectRoot, agentId)`, `readClosedManagedPositions(dbPath)`, `parseManagedTimestamp(s)`, `cutoffDateToMs(dateStr)`, `isGraduationEligible(createdAtMs, cutoffMs)`, `deriveExitReason(p)`, `PART_A_DEPLOY_CUTOFF` (`'2026-05-31'`). Reader pattern: `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(dbPath, { readOnly: true }); db.prepare(sql).all();`
  - `trade-ledger.mjs`: `buildAgentLedger(closed, open, cutoffMs, agentId, baselineCfg, stressCfg)`, `buildLedgerReport(perAgent)`, `bootstrapExpectancyCI(pnls, {B,alpha,seed})`, `toFrictionAction`, `buildStressConfig`, `readOpenManagedPositions(dbPath)`. The eligible block exposes per-trade friction-adjusted P&L array + `expectancy@1×/@2×` + bootstrap CI.
  - `significance-gate.mjs`: `evaluateGate(trades, {min_losing_trades:5, min_drawdown_pct:0.05})` → `{ by_category, cleared_categories, blocked_categories, overall_trade_count }`.
- **Pinned params (spec §7, a-priori — do NOT tune):** `N=20`, `BETA_BAND=0.6`, `MIN_BETA_DAYS=30`, retire deadline `6` months, bootstrap `B=10000` seeded.

---

## Task 1: `alpaca-spy-daily.mjs` — SPY daily closes (2b dependency)

**Files:**
- Create: `scripts/alpaca-spy-daily.mjs`
- Test: `scripts/alpaca-spy-daily.test.mjs`

Fetch SPY daily closes from Alpaca Data REST (`adjustment=split` — keeps SPY a *price* return matching the strat P&L series). Full-window re-fetch each run (avoids adjusted-bar restatement staleness); on-disk cache `data/cache/spy_daily.json` is offline fallback only, flagging `gaps` on failure. Pure functions take an injected `fetchImpl` so tests mock the network.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/alpaca-spy-daily.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleBars, etDateOf, buildBarsUrl } from './alpaca-spy-daily.mjs';

test('buildBarsUrl requests 1Day split-adjusted with the window', () => {
  const url = buildBarsUrl('2026-01-01', '2026-03-31');
  assert.match(url, /\/v2\/stocks\/SPY\/bars/);
  assert.match(url, /timeframe=1Day/);
  assert.match(url, /adjustment=split/);
  assert.match(url, /start=2026-01-01/);
});

test('etDateOf buckets a UTC bar timestamp to its ET calendar date', () => {
  // 2026-03-02T21:00:00Z = 16:00 ET (market close) → 2026-03-02
  assert.equal(etDateOf('2026-03-02T21:00:00Z'), '2026-03-02');
});

test('assembleBars merges paginated pages into ordered dates + close map', () => {
  const pages = [
    { bars: [{ t: '2026-03-02T21:00:00Z', c: 580 }, { t: '2026-03-03T21:00:00Z', c: 585 }] },
    { bars: [{ t: '2026-03-04T21:00:00Z', c: 583 }] },
  ];
  const { dates, close } = assembleBars(pages);
  assert.deepEqual(dates, ['2026-03-02', '2026-03-03', '2026-03-04']);
  assert.equal(close['2026-03-04'], 583);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/alpaca-spy-daily.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/alpaca-spy-daily.mjs
// SPY daily closes from Alpaca Data REST (split-adjusted price returns). Full-window re-fetch
// each run (corporate-action restatement-safe); on-disk cache is an offline fallback that flags
// gaps. Spec §4.1 (D-B6: Alpaca not FMP). Pure assembly + injected fetch for testability.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CACHE = join('data', 'cache', 'spy_daily.json');

export function buildBarsUrl(start, end, pageToken) {
  const p = new URLSearchParams({ timeframe: '1Day', start, end, adjustment: 'split', limit: '10000' });
  if (pageToken) p.set('page_token', pageToken);
  return `https://data.alpaca.markets/v2/stocks/SPY/bars?${p.toString()}`;
}

// Alpaca daily bar timestamps are the session date at 00:00Z OR close at 21:00Z depending on feed;
// bucket to the ET calendar date (a daily bar maps 1:1 to its trading day).
export function etDateOf(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

export function assembleBars(pages) {
  const close = {}; const seen = [];
  for (const pg of pages) for (const b of (pg.bars || [])) {
    const d = etDateOf(b.t);
    if (!(d in close)) seen.push(d);
    close[d] = b.c;
  }
  const dates = seen.slice().sort();
  return { dates, close };
}

// fetchImpl(url, headers) → parsed JSON page ({ bars, next_page_token }). Injected for tests.
export async function fetchSpyDaily(start, end, { fetchImpl = defaultFetch } = {}) {
  const headers = { 'APCA-API-KEY-ID': process.env.ALPACA_PUBLIC_KEY || '', 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY || '' };
  try {
    const pages = []; let token;
    do {
      const page = await fetchImpl(buildBarsUrl(start, end, token), headers);
      pages.push(page); token = page.next_page_token;
    } while (token);
    const { dates, close } = assembleBars(pages);
    mkdirSync(join('data', 'cache'), { recursive: true });
    writeFileSync(CACHE, JSON.stringify({ written_at: new Date().toISOString(), dates, close }));
    return { dates, close, gaps: new Set() };
  } catch (e) {
    process.stderr.write(`alpaca-spy-daily: fetch failed (${e.message}) — using cache, flagging gaps\n`);
    let obj; try { obj = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { return { dates: [], close: {}, gaps: new Set() }; }
    return { dates: obj.dates, close: obj.close, gaps: new Set(obj.dates) };
  }
}

async function defaultFetch(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/alpaca-spy-daily.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/alpaca-spy-daily.mjs scripts/alpaca-spy-daily.test.mjs
git commit -m "feat(foundation-2b): SPY daily-close fetcher (Alpaca, split-adjusted)"
```

---

## Task 2: `segment-beta.mjs` — daily returns + beta/orientation (2b)

**Files:**
- Create: `scripts/segment-beta.mjs`
- Test: `scripts/segment-beta.test.mjs`

Reads the `db_segment_pn_ls` daily series, computes gap-aware daily returns (`r_d = (realized_d + Δunrealized_d) / pv_{d−1}`), and OLS beta (deployed / unconditional / downside) with bootstrap CIs. **Component-1 contract (verified in `segment_pnl_writer.go`):** `realized_pnl` is the day's increment (added, not differenced); a row is written every weekday even when flat; `portfolio_value`/`unrealized_pnl` are EoD whole-account.

- [ ] **Step 0: Confirm the real table + column names (do FIRST — GORM naming)**

Run against a real sandbox DB (read-only):
```bash
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%segment%'\").all());console.log(d.prepare('SELECT * FROM db_segment_pn_ls LIMIT 1').all());" data/sandboxes/sbx_mean_rev/prophet_trader.db
```
Expected: table `db_segment_pn_ls`; note the EXACT column names (GORM renders `RealizedPnL`→likely `realized_pn_l`, `UnrealizedPnL`→`unrealized_pn_l`, plus `strategy, date, deployed_percent, position_count, portfolio_value`). **Use the names this prints in the SQL below** — if they differ from the draft, fix the `SELECT` and the row-field mapping accordingly. If the table has 0 rows (writer not yet run / Go not rebuilt), that's expected — the synthetic tests below still pass; real-data validation waits for the data clock.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/segment-beta.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDailyReturns, computeBeta, assertNotCumulative } from './segment-beta.mjs';

const rows = [ // realized increments + EoD unrealized + pv
  { date: '2026-03-02', realizedPnl: 0,  unrealizedPnl: 0,   deployedPercent: 0,  portfolioValue: 100000 },
  { date: '2026-03-03', realizedPnl: 0,  unrealizedPnl: 200, deployedPercent: 20, portfolioValue: 100000 },
  { date: '2026-03-04', realizedPnl: 50, unrealizedPnl: 100, deployedPercent: 20, portfolioValue: 100200 },
];
const spy = { dates: ['2026-03-02','2026-03-03','2026-03-04'], close: { '2026-03-02':580,'2026-03-03':585,'2026-03-04':583 }, gaps: new Set() };

test('computeDailyReturns uses r_d=(realized+Δunrealized)/pv_{d-1}, gap-aware', () => {
  const r = computeDailyReturns(rows, spy);
  // 03-03: (0 + (200-0))/100000 = 0.002 ; 03-04: (50 + (100-200))/100000 = -0.0005
  const by = Object.fromEntries(r.map((x) => [x.date, x.ret]));
  assert.ok(Math.abs(by['2026-03-03'] - 0.002) < 1e-9);
  assert.ok(Math.abs(by['2026-03-04'] - (-0.0005)) < 1e-9);
});

test('computeDailyReturns drops an observation spanning a missing SPY day', () => {
  const gapped = { dates: ['2026-03-02','2026-03-04'], close: { '2026-03-02':580,'2026-03-04':583 }, gaps: new Set() };
  const r = computeDailyReturns(rows, gapped);
  assert.ok(!r.find((x) => x.date === '2026-03-04')); // 03-03 not consecutive in spy.dates → dropped
});

test('computeBeta returns deployed/unconditional/downside slope + CI, insufficient under MIN', () => {
  const stratR = [{ date: 'd1', ret: 0.01, deployed: true }, { date: 'd2', ret: -0.02, deployed: true }];
  const spyR = { d1: 0.01, d2: -0.02 };
  const b = computeBeta(stratR, spyR, { minDays: 30 });
  assert.equal(b.deployed.insufficient, true); // only 2 days < 30
});

test('assertNotCumulative throws on a monotone realized series', () => {
  assert.throws(() => assertNotCumulative([{ realizedPnl: 10 }, { realizedPnl: 20 }, { realizedPnl: 30 }]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/segment-beta.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/segment-beta.mjs
// 2b: daily returns from the DBSegmentPnL series + beta/orientation vs SPY (spec §4.2).
// node:sqlite reader (readOnly) mirroring managed-position-repair.mjs. Gap-aware (D-B7).
import { DatabaseSync } from 'node:sqlite';

const MIN_BETA_DAYS = 30;

// Read the daily series for one strategy. NOTE: confirm column names via Step 0; adjust if GORM
// rendered them differently (e.g. realized_pn_l). Maps to camelCase row objects.
export function readSegmentDaily(dbPath, strategy) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      'SELECT strategy, date, realized_pn_l AS realizedPnl, unrealized_pn_l AS unrealizedPnl, ' +
      'deployed_percent AS deployedPercent, portfolio_value AS portfolioValue ' +
      'FROM db_segment_pn_ls WHERE strategy = ? ORDER BY date ASC'
    ).all(strategy);
    return rows;
  } finally { db.close(); }
}

// Loud guard: realized_pnl must be a per-day INCREMENT (added), never cumulative (differenced).
export function assertNotCumulative(rows) {
  const r = rows.map((x) => x.realizedPnl).filter((v) => v != null);
  if (r.length >= 3) {
    let monotone = true;
    for (let i = 1; i < r.length; i += 1) if (r[i] < r[i - 1]) { monotone = false; break; }
    const allNonneg = r.every((v) => v >= 0);
    if (monotone && allNonneg && r[r.length - 1] > r[0]) {
      throw new Error('segment-beta: realized_pnl looks CUMULATIVE (monotone non-decreasing) — Component-1 contract says daily increment. Aborting to avoid a bent beta.');
    }
  }
}

// r_d = (realized_d + (unrealized_d - unrealized_{d-1})) / portfolio_value_{d-1}, gap-aware (D-B7).
export function computeDailyReturns(rows, spy) {
  assertNotCumulative(rows);
  const spyIdx = new Map(spy.dates.map((d, i) => [d, i]));
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cur = rows[i], prev = rows[i - 1];
    const di = spyIdx.get(cur.date), pi = spyIdx.get(prev.date);
    if (di == null || pi == null) continue;                 // a date SPY doesn't have → skip
    if (di - pi !== 1) continue;                            // not consecutive trading days → gap, drop
    if (spy.gaps.has(cur.date) || spy.gaps.has(prev.date)) continue; // SPY data outage → drop
    const pv = prev.portfolioValue;
    if (!pv) continue;
    const ret = (cur.realizedPnl + (cur.unrealizedPnl - prev.unrealizedPnl)) / pv;
    out.push({ date: cur.date, ret, deployed: cur.deployedPercent > 0 });
  }
  return out;
}

function olsBetaCI(xs, ys, { B = 2000, seed = 12345 } = {}) {
  const slope = (X, Y) => {
    const n = X.length; if (n < 2) return null;
    const mx = X.reduce((a, b) => a + b, 0) / n, my = Y.reduce((a, b) => a + b, 0) / n;
    let cov = 0, vx = 0; for (let i = 0; i < n; i += 1) { cov += (X[i] - mx) * (Y[i] - my); vx += (X[i] - mx) ** 2; }
    return vx === 0 ? null : cov / vx;
  };
  const point = slope(xs, ys);
  let a = seed >>> 0; const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = xs.length; const slopes = [];
  if (n >= 2) for (let b = 0; b < B; b += 1) {
    const X = [], Y = []; for (let k = 0; k < n; k += 1) { const j = (rnd() * n) | 0; X.push(xs[j]); Y.push(ys[j]); }
    const s = slope(X, Y); if (s != null) slopes.push(s);
  }
  slopes.sort((p, q) => p - q);
  const pct = (p) => (slopes.length ? slopes[Math.min(slopes.length - 1, Math.floor((p / 100) * slopes.length))] : null);
  return { point, lo: pct(2.5), hi: pct(97.5), n };
}

// stratReturns: [{date, ret, deployed}]; spyReturns: {date→ret}. Three filtered betas + CIs.
export function computeBeta(stratReturns, spyReturns, { minDays = MIN_BETA_DAYS } = {}) {
  const mk = (filterFn) => {
    const xs = [], ys = [];
    for (const s of stratReturns) { const sp = spyReturns[s.date]; if (sp == null) continue; if (!filterFn(s, sp)) continue; xs.push(sp); ys.push(s.ret); }
    if (xs.length < minDays) return { insufficient: true, n: xs.length };
    return olsBetaCI(xs, ys);
  };
  return {
    deployed: mk((s) => s.deployed),
    unconditional: mk(() => true),
    downside: mk((s, sp) => sp < 0),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/segment-beta.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/segment-beta.mjs scripts/segment-beta.test.mjs
git commit -m "feat(foundation-2b): segment daily returns + deployed/unconditional/downside beta"
```

---

## Task 3: `graduation-gate.mjs` — two-track graduation bar (2c)

**Files:**
- Create: `scripts/graduation-gate.mjs`
- Test: `scripts/graduation-gate.test.mjs`

Assigns each agent a track by **structural classification** (declared a-priori), then evaluates criteria → GRADUATE / HOLD / REJECT / RETIRE. ALPHA gates on edge-CI>0 + adversity + duration + deployed-beta-CI in `±BETA_BAND`. BALLAST (convex hedges like def-Prophet) gates on structural convexity + bounded-bleed + stress-payoff; **expectancy is NOT a gate**. Spec §5.

- [ ] **Step 1: Write the failing test**

```javascript
// scripts/graduation-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackOf, alphaVerdict, ballastVerdict } from './graduation-gate.mjs';

test('trackOf classifies by strategy id', () => {
  assert.equal(trackOf('sbx_mean_rev', 'default'), 'alpha');     // Coil
  assert.equal(trackOf('prophet-defensive'), 'ballast');
});

test('alphaVerdict GRADUATE when all criteria clear', () => {
  const v = alphaVerdict({
    eligibleTrades: 25, edgeCI: { lo: 12, hi: 60 }, adversityCleared: true,
    durationMonths: 4, deployedBeta: { point: 0.2, lo: 0.05, hi: 0.4, n: 40 },
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.verdict, 'GRADUATE');
});

test('alphaVerdict REJECT when deployed-beta CI lower bound on |beta| exceeds band', () => {
  const v = alphaVerdict({
    eligibleTrades: 25, edgeCI: { lo: 12, hi: 60 }, adversityCleared: true,
    durationMonths: 4, deployedBeta: { point: 0.9, lo: 0.7, hi: 1.1, n: 40 },
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.verdict, 'REJECT');
});

test('alphaVerdict HOLD when edge CI straddles 0 (not yet demonstrable)', () => {
  const v = alphaVerdict({
    eligibleTrades: 25, edgeCI: { lo: -5, hi: 40 }, adversityCleared: true,
    durationMonths: 4, deployedBeta: { point: 0.2, lo: 0.05, hi: 0.4, n: 40 },
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.verdict, 'HOLD');
});

test('alphaVerdict RETIRE when HOLD past the deadline', () => {
  const v = alphaVerdict({
    eligibleTrades: 5, edgeCI: { lo: -5, hi: 40 }, adversityCleared: false,
    durationMonths: 7, deployedBeta: { insufficient: true, n: 10 },
  }, { N: 20, BETA_BAND: 0.6, retireMonths: 6 });
  assert.equal(v.verdict, 'RETIRE');
});

test('ballastVerdict ignores expectancy; GRADUATE on structural+bounded-bleed+nonpositive downside', () => {
  const v = ballastVerdict({
    structurallyConvex: true, expectancy: -50, bleedBudgetPerTrade: -100,
    downsideBeta: { point: -0.6, lo: -0.9, hi: -0.1, n: 35 }, durationMonths: 4,
  }, { retireMonths: 6 });
  assert.equal(v.verdict, 'GRADUATE');
});

test('ballastVerdict REJECT when it ADDS crash risk (downside-beta CI lower bound > 0)', () => {
  const v = ballastVerdict({
    structurallyConvex: true, expectancy: -50, bleedBudgetPerTrade: -100,
    downsideBeta: { point: 0.5, lo: 0.2, hi: 0.8, n: 35 }, durationMonths: 4,
  }, { retireMonths: 6 });
  assert.equal(v.verdict, 'REJECT');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/graduation-gate.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/graduation-gate.mjs
// 2c: two-track graduation bar (spec §5). Structural track assignment, then criteria → verdict.
// Pure decision logic; the orchestrator (Task 4) feeds it 2a ledger + 2b beta. Never auto-acts.

const BALLAST_STRATEGIES = new Set(['prophet-defensive', 'harvest']); // convex hedge sleeves

// Track by structural classification (a-priori, not measured). agentId OR strategyId accepted.
export function trackOf(strategyId, _agentId) {
  return BALLAST_STRATEGIES.has(strategyId) ? 'ballast' : 'alpha';
}

// ALPHA: all must clear. m = { eligibleTrades, edgeCI:{lo,hi}, adversityCleared, durationMonths,
// deployedBeta:{point,lo,hi,n}|{insufficient,n} }. params { N, BETA_BAND, retireMonths=6 }.
export function alphaVerdict(m, { N = 20, BETA_BAND = 0.6, retireMonths = 6 } = {}) {
  const reasons = [];
  const volume = m.eligibleTrades >= N;
  const edge = m.edgeCI && m.edgeCI.lo != null && m.edgeCI.lo > 0;       // demonstrated edge
  const edgeReject = m.edgeCI && m.edgeCI.hi != null && m.edgeCI.hi <= 0; // demonstrably no edge
  const adversity = !!m.adversityCleared;
  const duration = m.durationMonths >= 3;
  // orientation: GRADUATE only if |beta| CI entirely within band; REJECT if CI lower bound on |beta|>band
  const b = m.deployedBeta || {};
  const betaKnown = !b.insufficient && b.lo != null && b.hi != null;
  const absLo = betaKnown ? Math.min(Math.abs(b.lo), Math.abs(b.hi), (b.lo <= 0 && b.hi >= 0) ? 0 : Infinity) : null;
  const inBand = betaKnown && Math.abs(b.lo) <= BETA_BAND && Math.abs(b.hi) <= BETA_BAND;
  const betaReject = betaKnown && absLo != null && absLo > BETA_BAND;

  if (edgeReject) return { verdict: 'REJECT', track: 'alpha', reason: 'edge CI upper bound <= 0 (demonstrably no edge)' };
  if (betaReject) return { verdict: 'REJECT', track: 'alpha', reason: `deployed-beta |CI| lower bound > ${BETA_BAND} (closet-beta)` };
  if (volume && edge && adversity && duration && inBand) return { verdict: 'GRADUATE', track: 'alpha', reason: 'all criteria clear' };
  if (!volume) reasons.push(`<${N} eligible trades (${m.eligibleTrades})`);
  if (!edge) reasons.push('edge CI not > 0 (not yet demonstrable)');
  if (!adversity) reasons.push('adversity floor not cleared');
  if (!duration) reasons.push(`<3mo (${m.durationMonths})`);
  if (!betaKnown) reasons.push(`deployed-beta insufficient (n=${b.n ?? 0})`); else if (!inBand) reasons.push('deployed-beta CI too wide to confirm in-band');
  if (m.durationMonths >= retireMonths) return { verdict: 'RETIRE', track: 'alpha', reason: `HOLD past ${retireMonths}mo deadline: ${reasons.join('; ')}` };
  return { verdict: 'HOLD', track: 'alpha', reason: reasons.join('; ') };
}

// BALLAST: expectancy is NOT a gate. m = { structurallyConvex, expectancy, bleedBudgetPerTrade,
// downsideBeta:{point,lo,hi,n}|{insufficient,n}, durationMonths }.
export function ballastVerdict(m, { retireMonths = 6 } = {}) {
  const reasons = [];
  const convex = !!m.structurallyConvex;
  const boundedBleed = m.expectancy >= m.bleedBudgetPerTrade;   // bleeds no more than budget
  const d = m.downsideBeta || {};
  const dKnown = !d.insufficient && d.lo != null && d.hi != null;
  const addsCrashRisk = dKnown && d.lo > 0;                     // CI lower bound > 0 → adds risk
  const stressOk = dKnown ? d.hi <= 0 : null;                   // pays/neutral when measurable
  const duration = m.durationMonths >= 3;

  if (!convex) return { verdict: 'REJECT', track: 'ballast', reason: 'not structurally convex (a hedge must be defined-risk long-premium)' };
  if (!boundedBleed) return { verdict: 'REJECT', track: 'ballast', reason: 'bleed exceeds budget' };
  if (addsCrashRisk) return { verdict: 'REJECT', track: 'ballast', reason: 'downside-beta CI lower bound > 0 (adds crash risk)' };
  // structural-only when downside sample is too sparse (D-B5): absence of a reading is HOLD, never REJECT
  if (convex && boundedBleed && duration && (stressOk === true || stressOk === null)) {
    if (stressOk === true) return { verdict: 'GRADUATE', track: 'ballast', reason: 'convex + bounded bleed + downside-beta CI <= 0' };
    reasons.push('downside-beta sample insufficient (structural-only — HOLD, not REJECT)');
  }
  if (!duration) reasons.push(`<3mo (${m.durationMonths})`);
  if (m.durationMonths >= retireMonths) return { verdict: 'RETIRE', track: 'ballast', reason: `HOLD past ${retireMonths}mo: ${reasons.join('; ')}` };
  return { verdict: 'HOLD', track: 'ballast', reason: reasons.join('; ') || 'accruing' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/graduation-gate.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/graduation-gate.mjs scripts/graduation-gate.test.mjs
git commit -m "feat(foundation-2c): two-track (alpha/ballast) graduation gate"
```

---

## Task 4: `graduation-report.mjs` — orchestrator + CLI (wires 2a+2b+2c)

**Files:**
- Create: `scripts/graduation-report.mjs`
- Test: `scripts/graduation-report.test.mjs`

Controller-style: per agent, resolve sandbox DB → 2a ledger (`buildAgentLedger`) → 2b beta (`readSegmentDaily`+`computeDailyReturns`+`computeBeta` vs `fetchSpyDaily`) → 2c verdict (`alphaVerdict`/`ballastVerdict` by `trackOf`). Renders a markdown report. Data-coupled; unit-test the pure assembly (`assembleVerdict`), run the rest live.

- [ ] **Step 1: Write the failing test (pure assembler)**

```javascript
// scripts/graduation-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleVerdict } from './graduation-report.mjs';

test('assembleVerdict routes a ballast agent through ballastVerdict', () => {
  const v = assembleVerdict('prophet-defensive', {
    ledger: { eligible: { trades: 4, edgeCI: { lo: -10, hi: 10 } } },
    beta: { deployed: { insufficient: true, n: 5 }, downside: { insufficient: true, n: 3 } },
    structurallyConvex: true, expectancy: -20, bleedBudgetPerTrade: -100, durationMonths: 1,
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.track, 'ballast');
  assert.equal(v.verdict, 'HOLD'); // convex+bounded but <3mo and downside insufficient → structural HOLD
});

test('assembleVerdict routes an equity agent through alphaVerdict and HOLDs on thin data', () => {
  const v = assembleVerdict('default', {
    ledger: { eligible: { trades: 0, edgeCI: { lo: null, hi: null } } },
    beta: { deployed: { insufficient: true, n: 0 } }, adversityCleared: false, durationMonths: 0,
  }, { N: 20, BETA_BAND: 0.6 });
  assert.equal(v.track, 'alpha');
  assert.equal(v.verdict, 'HOLD');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/graduation-report.test.mjs`
Expected: FAIL ("Cannot find module").

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/graduation-report.mjs
// 2c orchestrator: per-agent 2a ledger + 2b beta → 2c verdict → markdown. Read-only; never auto-acts.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSandboxDbPaths, readClosedManagedPositions, cutoffDateToMs, PART_A_DEPLOY_CUTOFF } from './managed-position-repair.mjs';
import { buildAgentLedger, buildStressConfig, readOpenManagedPositions } from './trade-ledger.mjs';
import { evaluateGate } from './significance-gate.mjs';
import { readSegmentDaily, computeDailyReturns, computeBeta } from './segment-beta.mjs';
import { fetchSpyDaily } from './alpaca-spy-daily.mjs';
import { trackOf, alphaVerdict, ballastVerdict } from './graduation-gate.mjs';

// Pure: given the assembled per-agent inputs, pick the track + verdict. m carries ledger/beta/etc.
export function assembleVerdict(strategyId, m, params) {
  const track = trackOf(strategyId);
  if (track === 'ballast') {
    return {
      track, ...ballastVerdict({
        structurallyConvex: m.structurallyConvex, expectancy: m.expectancy,
        bleedBudgetPerTrade: m.bleedBudgetPerTrade, downsideBeta: m.beta?.downside, durationMonths: m.durationMonths,
      }, params),
    };
  }
  return {
    track, ...alphaVerdict({
      eligibleTrades: m.ledger?.eligible?.trades ?? 0, edgeCI: m.ledger?.eligible?.edgeCI ?? {},
      adversityCleared: !!m.adversityCleared, durationMonths: m.durationMonths ?? 0, deployedBeta: m.beta?.deployed ?? {},
    }, params),
  };
}

// CLI: node scripts/graduation-report.mjs [--root .]  (agents resolved per Component 3)
// NOTE: data-coupled; left as the live entry point. The per-agent assembly reuses the imports above:
//   closed = readClosedManagedPositions(dbPath); open = readOpenManagedPositions(dbPath);
//   ledger = buildAgentLedger(closed, open, cutoffMs, agentId, baselineCfg, buildStressConfig(baselineCfg));
//   spy = await fetchSpyDaily(start, end); rows = readSegmentDaily(dbPath, strategyId);
//   beta = computeBeta(computeDailyReturns(rows, spy), Object.fromEntries(spy.dates.slice(1).map((d,i)=>[d, spy.close[d]/spy.close[spy.dates[i]]-1])), { minDays: 30 });
//   verdict = assembleVerdict(strategyId, { ledger, beta, ... }, { N: 20, BETA_BAND: 0.6 });
// Emit a markdown table of {agent, track, verdict, blocking reason} to docs/lab/graduation-report.md.
```

> **Implementer note:** flesh out the CLI block to iterate the known agents (Coil=`default`/`sbx_mean_rev`, Turtle=`trend`, Drift, DefensiveProphet=`prophet-defensive`), build each agent's inputs via the imported reusables, call `assembleVerdict`, and write `docs/lab/graduation-report.md`. Source SPY window from the earliest segment date to today. `baselineCfg` loads `config/friction.json` (as 2a does). For def-Prophet pass `structurallyConvex:true` and `bleedBudgetPerTrade` from the pinned hedge budget (placeholder until the def-Prophet sizing decision — annotate it `TBD: options friction model + dollar bleed budget, per spec §8`). Keep it read-only.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/graduation-report.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/graduation-report.mjs scripts/graduation-report.test.mjs
git commit -m "feat(foundation-2c): graduation-report orchestrator + CLI"
```

---

## Task 5: Live smoke, RUNBOOK, full-suite verification

**Files:**
- Create: `docs/lab/foundation-b-2b2c-RUNBOOK.md`

- [ ] **Step 1: Full unit suite**

Run: `node --test scripts/alpaca-spy-daily.test.mjs scripts/segment-beta.test.mjs scripts/graduation-gate.test.mjs scripts/graduation-report.test.mjs`
Expected: all PASS.

- [ ] **Step 2: Live smoke (expected: insufficient-data HOLD)**

```bash
export $(grep -E '^(ALPACA_PUBLIC_KEY|ALPACA_SECRET_KEY)=' .env | xargs)
node scripts/graduation-report.mjs --root .
```
Expected: a `docs/lab/graduation-report.md` where every agent is **HOLD: insufficient data** (the `db_segment_pn_ls` series is empty/short until the Go bot is rebuilt and the daily writer has run for weeks). **This is the correct output today** — it proves the pipeline runs end-to-end and will mature as data accrues. If SPY fetch fails (keys), the report still renders with gap flags. Do NOT fabricate data to force a non-HOLD.

- [ ] **Step 3: Write the RUNBOOK**

```markdown
# Foundation B 2b/2c — RUNBOOK

Beta/orientation (2b) + two-track graduation gate (2c) for the fleet measurement layer. Read-only,
operator-reviewed, never auto-acts. Spec: docs/superpowers/specs/2026-05-31-foundation-b-component2-measurement-design.md.

## Run
```bash
export $(grep -E '^(ALPACA_PUBLIC_KEY|ALPACA_SECRET_KEY)=' .env | xargs)
node scripts/graduation-report.mjs --root .     # → docs/lab/graduation-report.md
node --test scripts/{alpaca-spy-daily,segment-beta,graduation-gate,graduation-report}.test.mjs
```

## Dependencies / data clock
- Consumes the Go `db_segment_pn_ls` daily series (Component 1). **That writer only runs once the Go
  bot is rebuilt from local main** — until then the series is empty and every verdict is
  `HOLD: insufficient data` (correct, not a bug). Verdicts mature automatically as rows accrue
  (~a quarter for the 3-month clock + MIN_BETA_DAYS=30 deployed days).
- SPY from Alpaca (split-adjusted), not FMP (D-B6).

## Pinned params (a-priori, spec §7): N=20, BETA_BAND=0.6, MIN_BETA_DAYS=30, retire=6mo, bootstrap B=10000.

## Tracks
- ALPHA (Coil, Turtle): edge-CI>0 + adversity + ≥3mo + deployed-beta CI within ±0.6.
- BALLAST (DefensiveProphet): structural convexity + bounded bleed + downside-beta CI ≤ 0;
  expectancy is NOT a gate. The options friction model + dollar bleed budget are the one open
  seam (spec §8) — finalize when def-Prophet's ballast graduation approaches (~3mo out).

## Verdicts: GRADUATE / HOLD / REJECT / RETIRE (HOLD past 6mo). Operator-reviewed; never auto-acted.
```

- [ ] **Step 4: Commit + hand back**

```bash
git add docs/lab/foundation-b-2b2c-RUNBOOK.md docs/lab/graduation-report.md
git commit -m "docs(foundation-2b2c): RUNBOOK + initial (insufficient-data) graduation report"
```
Do NOT squash-merge autonomously — hand back to the controller for review + the merge decision.

---

## Self-Review (plan author)

**Spec coverage:** §4.1 alpaca-spy-daily → Task 1. §4.2 segment-beta (readSegmentDaily/computeDailyReturns/computeBeta/assertNotCumulative, gap-aware, three betas + CI, MIN_BETA_DAYS) → Task 2 (with Step 0 confirming GORM column names). §5.1 ALPHA criteria → Task 3 `alphaVerdict`. §5.2 BALLAST criteria (expectancy-not-a-gate, structural-only downside HOLD) → Task 3 `ballastVerdict`. §5.3 verdicts → Task 3. §7 pinned params → threaded as params (N/BETA_BAND/MIN_BETA_DAYS/retire/B). Orchestration (2a+2b+2c) → Task 4. D-B6 Alpaca-not-FMP → Task 1. D-B7 gap-aware → Task 2. D-C13 assertNotCumulative → Task 2. The options-friction/bleed-budget (§8) is correctly left a documented seam (def-Prophet ballast graduation is ≥3mo out).

**Placeholder scan:** Task 4's CLI block is intentionally a documented orchestration seam (data-coupled, run live), with the exact reuse calls spelled out + a pure `assembleVerdict` that IS unit-tested — acceptable for a controller script (mirrors how `overlay-score`/`fleet-score` were planned). The `bleedBudgetPerTrade` placeholder for def-Prophet is explicitly annotated as the spec-§8 deferred seam, not a hidden TODO.

**Type consistency:** `beta` object shape `{deployed,unconditional,downside}` each `{point,lo,hi,n}|{insufficient,n}` consistent across Task 2 (`computeBeta`) → Task 3 (`alphaVerdict`/`ballastVerdict`) → Task 4 (`assembleVerdict`). `edgeCI {lo,hi}` from 2a's `bootstrapExpectancyCI` consumed by `alphaVerdict`. `trackOf(strategyId)` consistent Task 3↔4. SPY `{dates,close,gaps}` shape consistent Task 1→2→4.
