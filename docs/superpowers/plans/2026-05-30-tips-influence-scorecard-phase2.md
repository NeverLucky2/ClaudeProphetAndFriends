# Tips & Influence Scorecard — Phase 2 (candidate loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the out-of-universe loop: a **candidate queue** for tipped-but-not-traded (OOU) names, a **standalone eligibility evaluation** (options-liquidity-first, D6), and a human **Add-to-universe** action that appends to `config/prophet_tradable_universe.txt` and transitions the tip to active with its window anchored to add-time (D7). All read-only except the two sanctioned, human-clicked, flag-gated writes (the universe append + the candidate promotion).

**Architecture:** Three small Node modules — `options-eligibility.js` (read-only; calls the Go trading-bot backend's live options-chain endpoint, the same Alpaca data the real spread gate uses), `universe-store.js` (the sole sanctioned universe-file writer), and a `promoteCandidate` mutator added to the existing single-writer `tips-store.js` (D13). Two flag-gated server endpoints (`GET .../evaluate`, `POST .../promote`) and a candidate-queue section in the Tips tab wire it together. Eligibility evaluation is standalone — **not** coupled to `review-performance` (D15).

**Tech Stack:** Node 20+ ESM (global `fetch`), Express (already in `server.js`), `node:test` + `node:assert/strict`, vanilla JS in the single-file dashboard.

**Spec:** `docs/superpowers/specs/2026-05-30-tips-influence-scorecard-design.md` (§5.4–5.5, §6; D6/D7/D13/D15). Builds on Phase 1a (store + tab) and Phase 1b (scorer), both merged to local main.

---

## Design decisions (resolved from spec §11 open questions)

1. **Options-liquidity / OI data source = the Go backend's live chain endpoint.** The evaluator (Node) calls `GET {TRADING_BOT_URL}/api/options/chain/:symbol?expiration=<monthly>&type=call&delta_min=0.3&delta_max=0.7` (handler: `controllers/order_controller.go` `GetOptionsChain`). Each `contracts[]` element is an `interfaces.OptionContract` serialized with **PascalCase** keys: `StrikePrice, ExpirationDate, Premium, Bid, Ask, Volume, OpenInterest, ImpliedVolatility, Delta, Gamma, ...`. `TRADING_BOT_URL` is already defined in `agent/server.js` (default `http://localhost:4534`). This reuses the exact Alpaca options data the live spread gate consumes, so the verdict stays consistent with the gate the agent actually trades through. The endpoint surfaces a broker 429 as HTTP 429 (rate-limited) — treat that, and any non-200 / fetch failure, as **`options_data_unavailable` → verdict `reject`** (not a crash). The eval is on-demand (a few candidates), so the cost is negligible.
2. **Spread threshold = reuse the gate's own.** `PROPHET_OPTIONS_SPREAD_MAX_PCT` (default `0.10`); the gate rejects when `(ask−bid)/mid >= SpreadMaxPct`. The evaluator uses the same number and rule.
3. **Secondary context (never gating, D6) = bar-cache only.** Realized volatility (annualized stdev of recent daily log returns) + a trailing recent-move, both from `data/bar-cache` via the Phase-1b reader. **Market cap and ADV are deferred** (would need FMP profile / volume bars; they never gate the verdict, so they are out of scope here — noted as future).
4. **Universe write = append, effective next restart (§5.5).** `addToUniverse` appends `TICKER  # added via tips ledger <date>` to `config/prophet_tradable_universe.txt` (idempotent; the Go `LoadTradableUniverse` parser strips the inline comment). The Go guard reads the file at startup, so an add is **effective on the next agent restart** — documented, no live-reload endpoint (YAGNI / lowest risk). This is the *human-gated curation write* the spec sanctions as distinct from the automated catalyst top-up the file header forbids.
5. **Verdict bands (D6).** `reject` if options data unavailable, no liquid ATM contract, or `spreadPct >= SpreadMaxPct`. `strong` if `spreadPct <= 0.5*SpreadMaxPct` AND `openInterest >= 100` AND `volume > 0`. `watch` otherwise (borderline). The 3-day/recent move is shown as context only and **never** changes the verdict.
6. **Standalone (D15).** Evaluation is the dashboard "Evaluate" button + these endpoints only. It is **not** added to `review-performance`. (An optional dedicated skill is explicitly deferred.)

---

## File structure

- **Modify `agent/tips-store.js`** — add `promoteCandidate(projectRoot, id)` (single-writer mutator, D13): flips `pending_candidate` → `active`, sets `actionableAt = now` (window anchors to add-time, D7), stamps `promotedAt`. + tests.
- **Create `agent/universe-store.js`** — `addToUniverse(projectRoot, ticker, opts)`: the sole sanctioned, idempotent universe-file appender. + tests.
- **Create `agent/options-eligibility.js`** — `nextMonthlyExpiration`, `pickAtmContract`, `spreadVerdict`, `computeContext`, `evaluateCandidate`. Read-only; injectable `fetchChain`/`loadCloses` for tests. + tests.
- **Modify `agent/server.js`** — two flag-gated routes: `GET /api/tips/candidates/:id/evaluate`, `POST /api/tips/:id/promote`.
- **Modify `agent/public/index.html`** — a "Candidates (out-of-universe)" section in the Tips tab: list + Evaluate + Add-to-universe (with a confirm()).
- **Modify `.env.example`** — document that candidate eval reuses `PROPHET_OPTIONS_SPREAD_MAX_PCT` and calls the trading-bot backend.

Conventions mirrored: the Phase-1a/1b store (`serialize`, `_atomicWriteTips`, `readUniverse`, `readTips`), the Phase-1b bar-cache reader, the `/api/tips` flag pattern (`tipsEnabled()` → 404), and the Tips-tab JS (`esc`, `loadTipsPanel`). All commits local-only; squash-merge to local `main` at the end.

---

## Task 1: `promoteCandidate` in the tip store (D7 transition)

**Files:**
- Modify: `agent/tips-store.js`
- Test: `agent/tips-store.test.mjs`

- [ ] **Step 1: Write the failing tests** (append to `agent/tips-store.test.mjs`; add `promoteCandidate` to the import from `./tips-store.js`)

```javascript
import { promoteCandidate } from './tips-store.js'; // add to the existing import line

test('promoteCandidate flips an OOU candidate to active, anchoring the window to now', async () => {
  const root = await tmpRoot();
  const cand = await createTip(root, { ticker: 'SMCI', thesis: 'AI servers', source: 'dad' });
  assert.equal(cand.phase, 'pending_candidate');
  assert.equal(cand.actionableAt, null);
  const before = Date.now();
  const r = await promoteCandidate(root, cand.id);
  assert.equal(r.ok, true);
  assert.equal(r.tip.phase, 'active');
  assert.ok(r.tip.actionableAt && Date.parse(r.tip.actionableAt) >= before - 1000);
  assert.ok(r.tip.promotedAt);
  const stored = (await readTips(root)).find(t => t.id === cand.id);
  assert.equal(stored.phase, 'active');
  assert.equal(stored.actionableAt, r.tip.actionableAt);
});

test('promoteCandidate refuses a non-candidate or unknown id', async () => {
  const root = await tmpRoot();
  const active = await createTip(root, { ticker: 'IBM', thesis: 'x', source: 'self' }); // in-universe -> active
  assert.equal((await promoteCandidate(root, active.id)).ok, false);
  assert.equal((await promoteCandidate(root, 'nope')).ok, false);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/tips-store.test.mjs`
Expected: FAIL — `promoteCandidate is not a function`.

- [ ] **Step 3: Implement** (append to `agent/tips-store.js`, after `dismissTip`)

```javascript
// promoteCandidate: the D7 transition. An out-of-universe pending_candidate
// becomes active when a human adds its ticker to the universe; the scoring
// window anchors to add-time (actionableAt = now), not the original log time,
// so the tip is not penalised for the span the name was structurally untradable.
// Single-writer (D13): serialized like every other mutation.
export async function promoteCandidate(projectRoot, id) {
  return serialize(async () => {
    const tips = await readTips(projectRoot);
    const tip = tips.find(t => t.id === id);
    if (!tip) return { ok: false, reason: 'not_found' };
    if (tip.phase !== 'pending_candidate') return { ok: false, reason: 'not_a_candidate', tip };
    const now = new Date().toISOString();
    tip.phase = 'active';
    tip.actionableAt = now;
    tip.promotedAt = now;
    await _atomicWriteTips(projectRoot, tips);
    return { ok: true, tip };
  });
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/tips-store.test.mjs`
Expected: PASS (Phase-1 store tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-store.js agent/tips-store.test.mjs
git commit -m "feat(tips): promoteCandidate — D7 candidate→active transition (window anchors to now)"
```

---

## Task 2: `universe-store.js` — the sanctioned universe appender

**Files:**
- Create: `agent/universe-store.js`
- Test: `agent/universe-store.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// agent/universe-store.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addToUniverse } from './universe-store.js';
import { readUniverse } from './tips-store.js';

async function tmpRoot(initial = '# header\nSPY\nQQQ\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'uni-'));
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  await fs.writeFile(path.join(root, 'config', 'prophet_tradable_universe.txt'), initial);
  return root;
}

test('addToUniverse appends a new ticker and is visible to readUniverse', async () => {
  const root = await tmpRoot();
  const r = await addToUniverse(root, 'smci', { today: '2026-05-30' });
  assert.equal(r.added, true);
  assert.equal(r.alreadyPresent, false);
  assert.equal(r.ticker, 'SMCI');
  const uni = await readUniverse(root);
  assert.equal(uni.has('SMCI'), true);
  const raw = await fs.readFile(path.join(root, 'config', 'prophet_tradable_universe.txt'), 'utf-8');
  assert.match(raw, /SMCI {2}# added via tips ledger 2026-05-30/);
});

test('addToUniverse is idempotent for an existing ticker (case-insensitive)', async () => {
  const root = await tmpRoot();
  const r = await addToUniverse(root, 'spy');
  assert.equal(r.added, false);
  assert.equal(r.alreadyPresent, true);
});

test('addToUniverse appends a newline first when the file lacks a trailing one', async () => {
  const root = await tmpRoot('# header\nSPY'); // no trailing newline
  await addToUniverse(root, 'NVDA', { today: '2026-05-30' });
  const uni = await readUniverse(root);
  assert.equal(uni.has('SPY'), true); // not merged into the prior line
  assert.equal(uni.has('NVDA'), true);
});

test('addToUniverse rejects an invalid ticker', async () => {
  const root = await tmpRoot();
  await assert.rejects(() => addToUniverse(root, '123!'), /invalid ticker/);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/universe-store.test.mjs`
Expected: FAIL — `Cannot find module './universe-store.js'`.

- [ ] **Step 3: Implement `agent/universe-store.js`**

```javascript
// agent/universe-store.js
// The single sanctioned, human-gated writer to config/prophet_tradable_universe.txt
// (spec §5.5). Append-only and idempotent. Distinct from the automated catalyst
// top-up the file header forbids — this write happens only on an explicit human
// "Add to universe" click through the server. Takes effect on the next agent
// restart (the Go guard reads the file at startup).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readUniverse } from './tips-store.js';

function universeFile(projectRoot) {
  return path.join(projectRoot, 'config', 'prophet_tradable_universe.txt');
}

export async function addToUniverse(projectRoot, ticker, opts = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]*$/.test(t)) throw new Error('invalid ticker');
  if ((await readUniverse(projectRoot)).has(t)) {
    return { added: false, alreadyPresent: true, ticker: t };
  }
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const file = universeFile(projectRoot);
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const needsNL = raw.length > 0 && !raw.endsWith('\n');
  await fs.appendFile(file, `${needsNL ? '\n' : ''}${t}  # added via tips ledger ${today}\n`);
  return { added: true, alreadyPresent: false, ticker: t };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/universe-store.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/universe-store.js agent/universe-store.test.mjs
git commit -m "feat(tips): universe-store — sanctioned idempotent Add-to-universe append"
```

---

## Task 3: Eligibility primitives — expiration, ATM pick, spread verdict

**Files:**
- Create: `agent/options-eligibility.js`
- Test: `agent/options-eligibility.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// agent/options-eligibility.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextMonthlyExpiration, pickAtmContract, spreadVerdict } from './options-eligibility.js';

test('nextMonthlyExpiration returns a 3rd-Friday at least minDte out', () => {
  // 2026-05-30: May 3rd Friday is 2026-05-15 (past+inside minDte) -> June 3rd Friday 2026-06-19
  assert.equal(nextMonthlyExpiration('2026-05-30', 21), '2026-06-19');
  // 2026-06-01 with 21d min -> still 2026-06-19 (18 days? -> next is 2026-07-17). 06-19 is 18d out < 21 -> July
  assert.equal(nextMonthlyExpiration('2026-06-01', 21), '2026-07-17');
});

test('pickAtmContract chooses the call with |delta| nearest 0.5 and valid quotes', () => {
  const contracts = [
    { Bid: 0, Ask: 1, Delta: 0.5 },          // bid 0 -> skip
    { Bid: 4.0, Ask: 4.2, Delta: 0.30 },
    { Bid: 5.0, Ask: 5.1, Delta: 0.52 },     // closest to 0.5
    { Bid: 6.0, Ask: 6.3, Delta: 0.70 },
  ];
  const atm = pickAtmContract(contracts);
  assert.equal(atm.Delta, 0.52);
});

test('spreadVerdict bands: reject / watch / strong', () => {
  // strong: spread 2% (<=5%), OI>=100, vol>0
  assert.equal(spreadVerdict({ Bid: 4.95, Ask: 5.05, OpenInterest: 500, Volume: 50 }, 0.10).verdict, 'strong');
  // watch: spread 8% (between 5% and 10%)
  assert.equal(spreadVerdict({ Bid: 4.8, Ask: 5.2, OpenInterest: 500, Volume: 50 }, 0.10).verdict, 'watch');
  // reject: spread 12% (>=10%)
  assert.equal(spreadVerdict({ Bid: 4.7, Ask: 5.3, OpenInterest: 500, Volume: 50 }, 0.10).verdict, 'reject');
  // reject: no contract
  assert.equal(spreadVerdict(null, 0.10).verdict, 'reject');
  // watch (not strong): tight spread but thin OI
  assert.equal(spreadVerdict({ Bid: 4.95, Ask: 5.05, OpenInterest: 10, Volume: 50 }, 0.10).verdict, 'watch');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/options-eligibility.test.mjs`
Expected: FAIL — `Cannot find module './options-eligibility.js'`.

- [ ] **Step 3: Implement the primitives** (create `agent/options-eligibility.js`)

```javascript
// agent/options-eligibility.js
// Read-only candidate eligibility evaluation (spec §5.4, D6). Primary gate is
// options liquidity (representative ATM monthly spread vs the live spread-gate
// threshold) using the Go backend's chain endpoint — the same Alpaca data the
// real gate consumes. Secondary context (realized vol, recent move) is from
// bar-cache and NEVER gates the verdict.
import { loadDailyCloses } from './bar-cache-reader.js';
import { etDateString } from './market-calendar.js';

const DEFAULT_SPREAD_MAX_PCT = 0.10;
const MIN_OI = 100;

function _thirdFriday(year, month0) {
  // month0: 0-11. Find the 3rd Friday (noon-UTC anchor).
  const first = new Date(Date.UTC(year, month0, 1, 12));
  const toFirstFriday = (5 - first.getUTCDay() + 7) % 7; // 5 = Friday
  return new Date(Date.UTC(year, month0, 1 + toFirstFriday + 14, 12));
}

// nextMonthlyExpiration: the standard monthly (3rd Friday) at least minDte days
// out from fromEtDate, as "YYYY-MM-DD".
export function nextMonthlyExpiration(fromEtDate, minDte = 21) {
  const from = new Date(fromEtDate + 'T12:00:00Z');
  const minDate = new Date(from.getTime() + minDte * 86400000);
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  for (let i = 0; i < 6; i++) {
    const tf = _thirdFriday(y, m);
    if (tf >= minDate) return tf.toISOString().slice(0, 10);
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return _thirdFriday(y, m).toISOString().slice(0, 10);
}

function _num(c, ...keys) {
  for (const k of keys) if (typeof c?.[k] === 'number') return c[k];
  return undefined;
}

// pickAtmContract: the call contract with |delta| closest to 0.5 and positive
// bid/ask. Tolerant of PascalCase (Go) or lowercase keys.
export function pickAtmContract(contracts) {
  let best = null;
  let bestDist = Infinity;
  for (const c of contracts || []) {
    const bid = _num(c, 'Bid', 'bid');
    const ask = _num(c, 'Ask', 'ask');
    const delta = _num(c, 'Delta', 'delta');
    if (!(bid > 0) || !(ask > 0) || typeof delta !== 'number') continue;
    const dist = Math.abs(Math.abs(delta) - 0.5);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

// spreadVerdict: reject/watch/strong from a representative ATM contract.
export function spreadVerdict(contract, spreadMaxPct = DEFAULT_SPREAD_MAX_PCT, minOI = MIN_OI) {
  if (!contract) return { verdict: 'reject', reason: 'no_liquid_atm_contract', spreadPct: null };
  const bid = _num(contract, 'Bid', 'bid');
  const ask = _num(contract, 'Ask', 'ask');
  const oi = _num(contract, 'OpenInterest', 'openInterest') ?? 0;
  const vol = _num(contract, 'Volume', 'volume') ?? 0;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return { verdict: 'reject', reason: 'no_mid', spreadPct: null };
  const spreadPct = (ask - bid) / mid;
  if (spreadPct >= spreadMaxPct) return { verdict: 'reject', reason: 'spread_exceeds_gate', spreadPct, oi, vol };
  if (spreadPct <= 0.5 * spreadMaxPct && oi >= minOI && vol > 0) {
    return { verdict: 'strong', reason: 'tight_spread_liquid', spreadPct, oi, vol };
  }
  return { verdict: 'watch', reason: 'borderline', spreadPct, oi, vol };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/options-eligibility.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/options-eligibility.js agent/options-eligibility.test.mjs
git commit -m "feat(tips): eligibility primitives — monthly expiry, ATM pick, spread verdict"
```

---

## Task 4: `computeContext` + `evaluateCandidate` orchestrator

**Files:**
- Modify: `agent/options-eligibility.js`
- Test: `agent/options-eligibility.test.mjs`

- [ ] **Step 1: Write the failing tests** (append; add `computeContext`, `evaluateCandidate` to the import line)

```javascript
import { computeContext, evaluateCandidate } from './options-eligibility.js';

test('computeContext derives realized vol + trailing move from closes (never gating)', () => {
  // 11 ascending closes -> positive trailing move, finite realized vol
  const closes = new Map();
  for (let i = 0; i < 11; i++) {
    const d = `2026-05-${String(10 + i).padStart(2, '0')}`;
    closes.set(d, 100 + i);
  }
  const ctx = computeContext(closes, '2026-05-29');
  assert.equal(ctx.lastClose, 110);
  assert.ok(ctx.realizedVol >= 0);
  assert.ok(ctx.trailing5dMove > 0);
});

test('computeContext is null-safe on an empty close map', () => {
  const ctx = computeContext(new Map(), '2026-05-29');
  assert.equal(ctx.lastClose, null);
  assert.equal(ctx.realizedVol, null);
});

test('evaluateCandidate: liquid chain -> strong; injected fetch/closes', async () => {
  const out = await evaluateCandidate('/proj', 'SMCI', {
    spreadMaxPct: 0.10, todayEtDate: '2026-05-29', expiration: '2026-06-19',
    fetchChain: async () => ([{ Bid: 4.95, Ask: 5.05, Delta: 0.5, OpenInterest: 800, Volume: 120, StrikePrice: 600 }]),
    loadCloses: async () => new Map([['2026-05-26', 590], ['2026-05-29', 600]]),
  });
  assert.equal(out.ticker, 'SMCI');
  assert.equal(out.verdict, 'strong');
  assert.equal(out.liquidity.available, true);
  assert.ok(out.liquidity.contract.oi === 800);
  assert.equal(out.expiration, '2026-06-19');
});

test('evaluateCandidate: chain fetch failure -> reject with options_data_unavailable (no throw)', async () => {
  const out = await evaluateCandidate('/proj', 'XYZ', {
    todayEtDate: '2026-05-29', expiration: '2026-06-19',
    fetchChain: async () => { const e = new Error('boom'); e.status = 429; throw e; },
    loadCloses: async () => new Map(),
  });
  assert.equal(out.verdict, 'reject');
  assert.equal(out.liquidity.available, false);
  assert.match(out.liquidity.reason, /options_data_unavailable:rate_limited/);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/options-eligibility.test.mjs`
Expected: FAIL — `computeContext is not a function`.

- [ ] **Step 3: Implement** (append to `agent/options-eligibility.js`)

```javascript
// computeContext: secondary, NEVER-gating context from daily closes — annualized
// realized volatility and a trailing ~5-trading-day move. Null-safe.
export function computeContext(closes, asOfEtDate) {
  const dates = [...closes.keys()].filter(d => d <= asOfEtDate).sort();
  if (dates.length === 0) return { lastClose: null, realizedVol: null, trailing5dMove: null, asOf: asOfEtDate };
  const series = dates.map(d => closes.get(d));
  const lastClose = series[series.length - 1];
  // realized vol: stdev of up to the last 20 daily log returns, annualized (252).
  const rets = [];
  for (let i = Math.max(1, series.length - 20); i < series.length; i++) {
    if (series[i - 1] > 0 && series[i] > 0) rets.push(Math.log(series[i] / series[i - 1]));
  }
  let realizedVol = null;
  if (rets.length >= 2) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
    realizedVol = +(Math.sqrt(variance) * Math.sqrt(252)).toFixed(4);
  }
  const back = series.length > 5 ? series[series.length - 6] : series[0];
  const trailing5dMove = back > 0 ? +(lastClose / back - 1).toFixed(4) : null;
  return { lastClose, realizedVol, trailing5dMove, asOf: asOfEtDate };
}

async function _defaultFetchChain(tradingBotUrl, ticker, expiration) {
  const url = `${tradingBotUrl}/api/options/chain/${encodeURIComponent(ticker)}`
    + `?expiration=${expiration}&type=call&delta_min=0.3&delta_max=0.7`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) { const e = new Error(`chain HTTP ${res.status}`); e.status = res.status; throw e; }
  const j = await res.json();
  return Array.isArray(j.contracts) ? j.contracts : [];
}

// evaluateCandidate: the standalone, read-only verdict (spec §5.4). Primary gate
// = options liquidity (live chain); secondary context = bar-cache (never gating).
// Injectable fetchChain/loadCloses for tests. Never throws on data outages.
export async function evaluateCandidate(projectRoot, ticker, opts = {}) {
  const t = String(ticker || '').toUpperCase();
  const spreadMaxPct = opts.spreadMaxPct
    ?? Number(process.env.PROPHET_OPTIONS_SPREAD_MAX_PCT || DEFAULT_SPREAD_MAX_PCT);
  const todayEtDate = opts.todayEtDate ?? etDateString(new Date());
  const expiration = opts.expiration ?? nextMonthlyExpiration(todayEtDate);
  const tradingBotUrl = opts.tradingBotUrl || process.env.TRADING_BOT_URL || 'http://localhost:4534';
  const fetchChain = opts.fetchChain ?? ((tk) => _defaultFetchChain(tradingBotUrl, tk, expiration));
  const loadCloses = opts.loadCloses ?? ((sym) => loadDailyCloses(projectRoot, sym));

  let liquidity;
  try {
    const contracts = await fetchChain(t, expiration);
    const atm = pickAtmContract(contracts);
    const v = spreadVerdict(atm, spreadMaxPct);
    liquidity = {
      ...v,
      available: true,
      contract: atm ? {
        bid: _num(atm, 'Bid', 'bid'), ask: _num(atm, 'Ask', 'ask'),
        delta: _num(atm, 'Delta', 'delta'), oi: _num(atm, 'OpenInterest', 'openInterest'),
        vol: _num(atm, 'Volume', 'volume'), strike: _num(atm, 'StrikePrice', 'strike'),
      } : null,
    };
  } catch (err) {
    const why = err && err.status === 429 ? 'rate_limited' : (err && err.message) || 'chain_unavailable';
    liquidity = { verdict: 'reject', reason: `options_data_unavailable:${why}`, spreadPct: null, available: false, contract: null };
  }

  const context = computeContext(await loadCloses(t), todayEtDate);
  return { ticker: t, expiration, spreadMaxPct, verdict: liquidity.verdict, liquidity, context, evaluatedAt: new Date().toISOString() };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/options-eligibility.test.mjs`
Expected: PASS (3 prior + 4 new = 7).

- [ ] **Step 5: Commit**

```bash
git add agent/options-eligibility.js agent/options-eligibility.test.mjs
git commit -m "feat(tips): evaluateCandidate orchestrator + bar-cache context (never gating)"
```

---

## Task 5: Flag-gated evaluate + promote endpoints

**Files:**
- Modify: `agent/server.js`

- [ ] **Step 1: Add imports** (next to the existing tips imports — `import { readTips, createTip, dismissTip, getSources } from './tips-store.js';` and `import { scoreTips } from './tips-scorer.js';`)

```javascript
import { promoteCandidate } from './tips-store.js';
import { addToUniverse } from './universe-store.js';
import { evaluateCandidate } from './options-eligibility.js';
```

(If your editor prefers, fold `promoteCandidate` into the existing `./tips-store.js` import line instead of a second import — either is fine as long as it resolves.)

- [ ] **Step 2: Add the routes** (immediately after the `app.get('/api/tips/ledger', ...)` handler from Phase 1b)

```javascript
// Standalone candidate eligibility (D6/D15) — read-only, options-liquidity-first.
app.get('/api/tips/candidates/:id/evaluate', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const tip = (await readTips(PROJECT_ROOT)).find(t => t.id === req.params.id);
    if (!tip) return res.status(404).json({ error: 'tip not found' });
    if (tip.phase !== 'pending_candidate') return res.status(400).json({ error: 'not a pending candidate' });
    const evaluation = await evaluateCandidate(PROJECT_ROOT, tip.ticker, {});
    res.json({ evaluation });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add-to-universe + promote (D7) — the sanctioned, human-gated write. Appends to
// the universe file (effective next restart) and flips the tip to active.
app.post('/api/tips/:id/promote', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const tip = (await readTips(PROJECT_ROOT)).find(t => t.id === req.params.id);
    if (!tip) return res.status(404).json({ error: 'tip not found' });
    if (tip.phase !== 'pending_candidate') return res.status(400).json({ error: 'not a pending candidate' });
    const universe = await addToUniverse(PROJECT_ROOT, tip.ticker, {});
    const promoted = await promoteCandidate(PROJECT_ROOT, tip.id);
    if (!promoted.ok) return res.status(409).json({ error: promoted.reason, universe });
    res.json({ ok: true, tip: promoted.tip, universe, note: 'Universe add takes effect on next agent restart.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 3: Verify the server parses**

Run: `node -e "import('./agent/server.js').then(()=>console.log('loads')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `loads`.

- [ ] **Step 4: Smoke test (READ-ONLY paths only — do NOT run a real promote against the live universe file)**

```bash
ENABLE_TIPS_SCORECARD=true AGENT_PORT=3942 node agent/server.js &
sleep 2
# create an OOU candidate, then evaluate it (read-only). Promote is NOT smoked here
# because it would append to the real config/prophet_tradable_universe.txt.
CID=$(curl -s -XPOST localhost:3942/api/tips -H 'content-type: application/json' -d '{"ticker":"SMCI","thesis":"smoke","source":"self"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).tip.id))")
echo "evaluate -> $(curl -s localhost:3942/api/tips/candidates/$CID/evaluate -o /dev/null -w '%{http_code}')"   # 200 (verdict reject if bot down — fine)
echo "promote flag-off check on a second server below"
kill %1
# confirm both routes 404 when the flag is off:
AGENT_PORT=3943 node agent/server.js &
sleep 2
echo "evaluate flag-off -> $(curl -s localhost:3943/api/tips/candidates/x/evaluate -o /dev/null -w '%{http_code}')"  # 404
echo "promote  flag-off -> $(curl -s -XPOST localhost:3943/api/tips/x/promote -o /dev/null -w '%{http_code}')"        # 404
kill %1
```
Expected: evaluate (flag on) → `200`; both routes (flag off) → `404`. If the trading-bot backend is not running, the evaluate body's verdict will be `reject` with `options_data_unavailable` — that is correct behavior, still HTTP 200. **After smoking, delete the throwaway tip** the smoke created from `data/tips/tips.json` if it isn't wanted (or note it; the flag is OFF by default so it is invisible).

- [ ] **Step 5: Commit**

```bash
git add agent/server.js
git commit -m "feat(tips): flag-gated candidate evaluate + add-to-universe/promote endpoints"
```

---

## Task 6: Candidate queue in the Tips tab (Evaluate + Add-to-universe)

**Files:**
- Modify: `agent/public/index.html`

- [ ] **Step 1: Add a candidates container** — inside `#panel-tips`, insert immediately BEFORE the existing `<div id="tips-ledger"></div>` (added in Phase 1b):

```html
        <div id="tips-candidates"></div>
```

- [ ] **Step 2: Call the loader from `loadTipsPanel`** — immediately after the existing `loadTipsLedger();` line, add:

```javascript
    loadTipsCandidates();
```

- [ ] **Step 3: Add the candidate-queue JS** — paste after the `loadTipsLedger` function:

```javascript
async function loadTipsCandidates() {
  const host = document.getElementById('tips-candidates');
  if (!host) return;
  let tips;
  try {
    const res = await fetch('/api/tips');
    if (!res.ok) { host.innerHTML = ''; return; }
    tips = (await res.json()).tips.filter(t => t.phase === 'pending_candidate');
  } catch { host.innerHTML = ''; return; }
  if (!tips.length) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="settings-content" style="margin-bottom:18px;">
      <h3>Candidates <span style="opacity:.6;font-weight:normal;">— out-of-universe tips awaiting eligibility review</span></h3>
      ${tips.map(t => `
        <div class="trade-card" id="cand-${esc(t.id)}">
          <div class="trade-header">
            <span><span class="trade-symbol">${esc(t.ticker)}</span>
              <span class="trade-agent-badge">${esc(t.source)}</span></span>
            <span class="trade-time">${esc((t.surfacedAt || '').slice(0, 10))}</span>
          </div>
          <div class="trade-details">${esc(t.thesis || '')}</div>
          <div style="margin-top:6px; display:flex; gap:8px; align-items:center;">
            <button onclick="evaluateCandidate('${esc(t.id)}')">Evaluate</button>
            <span id="cand-verdict-${esc(t.id)}" style="font-size:12px;"></span>
          </div>
        </div>`).join('')}
    </div>`;
}

async function evaluateCandidate(id) {
  const out = document.getElementById('cand-verdict-' + id);
  if (out) out.textContent = 'evaluating…';
  try {
    const res = await fetch('/api/tips/candidates/' + id + '/evaluate');
    if (!res.ok) { if (out) out.textContent = 'error ' + res.status; return; }
    const { evaluation: e } = await res.json();
    const sp = e.liquidity.spreadPct == null ? 'n/a' : (e.liquidity.spreadPct * 100).toFixed(1) + '%';
    const ctx = e.context.realizedVol == null ? '' : ` · rvol ${(e.context.realizedVol * 100).toFixed(0)}%`;
    const canAdd = e.verdict !== 'reject';
    if (out) out.innerHTML =
      `<b class="${e.verdict === 'reject' ? 'pnl-neg' : 'pnl-pos'}">${esc(e.verdict)}</b> `
      + `(spread ${sp}${ctx})${e.liquidity.available ? '' : ' — ' + esc(e.liquidity.reason)} `
      + (canAdd ? `<button onclick="promoteCandidate('${esc(id)}','${esc(e.ticker)}')">Add to universe</button>` : '');
  } catch (err) { if (out) out.textContent = String(err); }
}

async function promoteCandidate(id, ticker) {
  if (!confirm('Add ' + ticker + ' to the tradable universe?\nTakes effect on the next agent restart.')) return;
  try {
    const res = await fetch('/api/tips/' + id + '/promote', { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { alert('Promote failed: ' + (j.error || res.status)); return; }
    loadTipsPanel(); // refresh: candidate leaves the queue, becomes an active tip
  } catch (err) { alert(String(err)); }
}
```

- [ ] **Step 2 sanity (counts):** run
`node -e "const s=require('fs').readFileSync('agent/public/index.html','utf8'); console.log('loadTipsCandidates:',(s.match(/loadTipsCandidates/g)||[]).length,'promoteCandidate:',(s.match(/promoteCandidate/g)||[]).length,'evaluateCandidate:',(s.match(/evaluateCandidate/g)||[]).length);"`
Expect: `loadTipsCandidates: 2`, `promoteCandidate: 2`, `evaluateCandidate: 2` (call + definition each; the page's `esc`/`.pnl-pos`/`.pnl-neg` already exist from Phase 1b).

- [ ] **Step 3: Manual browser check**

```bash
ENABLE_TIPS_SCORECARD=true node agent/server.js
```
Open the dashboard → **Tips**. Log an out-of-universe ticker (e.g. `SMCI`) → it appears under **Candidates**. Click **Evaluate** → a verdict renders (reject/watch/strong + spread; `reject · options_data_unavailable` if the trading-bot backend isn't running — expected). For a non-reject verdict, **Add to universe** appears; clicking it asks for confirmation, and on confirm the name moves out of Candidates and shows as an active tip. *(Only click Add if you actually intend to add the name — it writes the live universe file.)*

- [ ] **Step 4: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(tips): Tips-tab candidate queue — Evaluate + Add-to-universe"
```

---

## Task 7: Document + full suite green

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append to the Tips block in `.env.example`** (after the Phase-1b `TIPS_MIN_SAMPLE` line)

```bash
# Phase 2 (candidate loop): the standalone eligibility evaluation reuses the
# live options spread-gate threshold below and calls the trading-bot backend's
# /api/options/chain endpoint (TRADING_BOT_URL). No new flags; Add-to-universe
# is human-clicked in the dashboard and takes effect on the next agent restart.
#   PROPHET_OPTIONS_SPREAD_MAX_PCT (default 0.10) — reused as the candidate gate.
#   TRADING_BOT_URL (default http://localhost:4534) — options-chain source.
```

- [ ] **Step 2: Run the full tip + calendar + eligibility suite**

Run: `node --test agent/market-calendar.test.mjs agent/bar-cache-reader.test.mjs agent/tips-store.test.mjs agent/tips-scorer.test.mjs agent/universe-store.test.mjs agent/options-eligibility.test.mjs`
Expected: ALL pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(tips): document Phase 2 candidate-eval data sources (reused gate + bot chain)"
```

---

## Self-review (completed during planning)

**Spec coverage (Phase 2 slice of §10):**
- Candidate queue for OOU tips (§5.4) ✓ Task 6 (the `pending_candidate` phase already exists from 1a; this surfaces + acts on it).
- Standalone eligibility evaluation, options-liquidity-first, 3-day/recent move context-only-never-gating (D6) ✓ Tasks 3–4; standalone, NOT in `review-performance` (D15) ✓ (endpoints + dashboard only).
- Verdict buckets reject/watch/strong vs spread/OI ✓ Task 3.
- Add-to-universe appends exactly the ticker, idempotent, sanctioned write (§5.5) ✓ Task 2; "effective next restart" documented ✓ Tasks 5–7.
- D7 transition: promote flips to active, window anchors to add-time, no double-count ✓ Task 1; dedupe via idempotent universe add + candidate-only promote guard ✓ Tasks 2,5.
- Single-writer (D13): the server is the sole writer; `promoteCandidate` is serialized; `addToUniverse` is the only universe writer; eligibility is read-only ✓.
- Flag-gated default OFF ✓ Task 5 (routes 404 when disabled).
- **Deferred (out of Phase 2 scope, correctly):** the news-candidate feed + Trades-tab badge + Settings source editor (Phase 3, §5.3/§5.6/D14); the optional dedicated eval skill (D15 says "optionally"); market cap + ADV secondary context; a universe live-reload endpoint; the review-performance scorecard summary (§5.7 — Phase 3 or follow-up).

**Placeholder scan:** no TBD/TODO; every code step is complete and runnable.

**Type consistency:** `evaluateCandidate` → `{ ticker, expiration, spreadMaxPct, verdict, liquidity:{verdict,reason,spreadPct,oi,vol,available,contract:{bid,ask,delta,oi,vol,strike}|null}, context:{lastClose,realizedVol,trailing5dMove,asOf}, evaluatedAt }`; the server `evaluate` route returns `{ evaluation }` and the UI reads `evaluation.verdict / .liquidity.spreadPct / .liquidity.available / .liquidity.reason / .context.realizedVol / .ticker`. `promoteCandidate` → `{ ok, tip, reason? }`; the promote route returns `{ ok, tip, universe, note }`. `addToUniverse` → `{ added, alreadyPresent, ticker }`. Names match across store, endpoints, and UI.

**Safety:** the only state-changing actions are the two human-clicked, flag-gated writes; the smoke test deliberately exercises the read-only evaluate path and the flag-off 404s, and explicitly does NOT run a real promote against the live universe file; the promote UI requires a `confirm()`.
