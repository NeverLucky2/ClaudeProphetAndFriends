# Tips & Influence Scorecard — Phase 1b (the scorer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the read-only **scorer** (`agent/tips-scorer.js`) that turns logged tips into the spec's three never-merged views — (A) tip-call quality (underlying forward-return vs SPY), (B) entangled influenced-trade P&L, (C) influenced-vs-autonomous context — with the human-exclusive/agent-discoverable split (D9) and per-source small-sample discipline (D11), surfaced in the Tips tab. Read-only: it never mutates the tip store (D13).

**Architecture:** A self-contained Node module computes the ledger on demand from existing files only: tips from `data/tips/tips.json` (via the Phase-1a store), Prophet trades from `data/sandboxes/<accountId>/decisive_actions/*.json`, daily prices from `data/bar-cache/`, and the agent-discovery index from `data/reports/daily_brief_*.json`. A new flag-gated `GET /api/tips/ledger` endpoint serves it; the Tips tab renders the three views. Trading-day arithmetic is added to the existing `agent/market-calendar.js`.

**Tech Stack:** Node 20 ESM, Express (already in `server.js`), `node:test` + `node:assert/strict`, vanilla JS in the single-file dashboard.

**Spec:** `docs/superpowers/specs/2026-05-30-tips-influence-scorecard-design.md` (Phase 1 scorer slice of §10; views in §5.2; D2/D9/D10/D11/D13).

---

## Schema spike findings (load-bearing — the data is messier than the spec assumed)

A real-data spike (`node scripts/apply-friction.mjs --agent default` + inspecting `decisive_actions/*.json`) established the following. **Honor these; do not re-derive from the spec's idealized field names.**

1. **All six agents share `accountId=6e4f26af`.** `data/sandboxes/6e4f26af/decisive_actions/*.json` is a co-mingled pool separated only by an inner `sandbox_id` field. Prophet (the `default` agent) is sandbox key **`sbx_6e4f26af`**. The scorer reads the account folder **and filters `action.sandbox_id === '<the default sandbox key>'`**, resolving both the accountId (folder) and the sandbox key (filter) from `data/agent-config.json` (`sandboxes[*].agent.activeAgentId === 'default'`). (`review-performance` does **not** filter by `sandbox_id`; the scorer is stricter on purpose.)

2. **`apply-friction.mjs` is a no-op for Prophet — it produces ZERO `*.friction.json`.** Each decisive action is a single OPEN *or* a single CLOSE, never a round-trip, so the canonical `entry_price`+`exit_price`+`size`-on-one-record schema the friction calculator requires never matches. Therefore `market_data.friction_adjusted_pl` / `raw_pl` are effectively **never present**. The scorer must not depend on them (it still *prefers* them if ever present, for forward-compat).

3. **Realized-P&L field names are free-form per beat** (the killer finding). Across real SELL (close) actions the dollar/percent P&L appears under: `option_loss_dollars`/`option_loss_pct`, `option_pnl_dollars`/`option_pnl_pct`, `loss_dollars`/`loss_pct`/`total_session_loss`, `gain_pct`, `unrealized_pl`/`unrealized_pct`, `option_price`-only, or **nothing structured at all** (the number lives only in free-text `reasoning`, e.g. "−19.5% loss (−$795)"). View B therefore needs a **tolerant extractor** that tags provenance + confidence and reports coverage; unresolved closes are shown as **data-gaps, never $0**.

4. **Action verbs (Prophet):** `BUY` = open, `SELL` = close. No `CLOSE` verb. `HOLD`/`PASS` are non-trades.

5. **Open vs close shapes differ.** Opens (BUY) carry `market_data.{entry_price, contracts, total_cost}`. Closes (SELL) carry the free-form P&L of finding 3 plus sometimes `option_cost_basis`/`option_current_price`. The entry timestamp is the BUY action's `timestamp`; realized P&L lives on the SELL.

6. **Underlying from an OCC option symbol:** `^[A-Z]{1,6}\d{6}[CP]\d{8}$` → leading letters (`AMD260717C00460000` → `AMD`, `QQQ260515C00712000` → `QQQ`). Plain tickers (`NVDA`, `XLE`, `SPY`) are direct underlying/ETF trades → the symbol is its own underlying.

7. **View A price source = `data/bar-cache/` (decided; FMP deferred).** Files `<SYM>_1Day_<start>_<end>.json` shaped `{symbol, timeframe, start_date, end_date, written_at, bars:[{Symbol, Timestamp, Open, High, Low, Close, Volume, VWAP}]}`. Daily bars; `Timestamp` is `T04:00:00Z` (= ET calendar date). Multiple rolling-window files exist per symbol → merge and dedupe by ET date (newest `written_at` wins). SPY is present. Coverage is good for the mega-cap universe (the only names that reach view A, since view A scores only **active**, in-universe tips). A symbol/date the cache lacks is reported as a **data-gap**, not fabricated; FMP fallback is documented as future work, not built here.

8. **`agentSurfaced` (D9) source = `data/reports/daily_brief_YYYYMMDD.json`.** Each brief has `date`, `analyst_actions:[{ticker, ..., date}]`, and `ticker_catalysts:[{ticker, ..., published}]`. A tip's ticker is `agentSurfaced` if it appears in any brief whose item date falls in the tip's window. Coverage is partial (briefs exist only on some dates; scans cover only the in-universe floor) — an honesty caveat surfaced in the output. News-origin candidates are `agentSurfaced` by construction (handled when Phase 3 lands; Phase 1b has no news-origin tips yet).

---

## File structure

- **Modify `agent/market-calendar.js`** — add `isTradingDay`, `nextTradingDay`, `addTradingDays` (holiday-aware, ET-date-string arithmetic). Reuses the existing `MARKET_HOLIDAYS`/`etDateString`.
- **Modify `agent/market-calendar.test.mjs`** — append trading-day-arithmetic tests.
- **Create `agent/bar-cache-reader.js`** — `loadDailyCloses`, `closeOnOrAfter`, `forwardReturn`. Pure FS + date math.
- **Create `agent/bar-cache-reader.test.mjs`**.
- **Create `agent/tips-scorer.js`** — the read-only scorer: sandbox resolution, action loading, `underlyingOf`, `extractRealizedPnl`, agent-surfaced index, views A/B/C, per-source assembly, `scoreTips`.
- **Create `agent/tips-scorer.test.mjs`**.
- **Modify `agent/server.js`** — add flag-gated `GET /api/tips/ledger`.
- **Modify `agent/public/index.html`** — render the three views + per-source breakdown + misses at equal prominence in the Tips tab.
- **Modify `.env.example`** — document `TIPS_ATTRIBUTION_WINDOW_DAYS` (default 3) and `TIPS_MIN_SAMPLE` (default 20).

Conventions mirrored: the Phase-1a store (`agent/tips-store.js` — `readTips`, `readUniverse`), the friction loader's `OCC_SYMBOL` regex and sandbox resolution (`scripts/apply-friction.mjs`), the `/api/tips` flag pattern in `server.js`, and `switchTab`/`esc()`/`.trade-card` in `index.html`.

All commits in this plan are local-only (do not push) — this branch squash-merges to local `main` at the end.

---

## Task 1: Holiday-aware trading-day arithmetic in `market-calendar.js`

**Files:**
- Modify: `agent/market-calendar.js`
- Test: `agent/market-calendar.test.mjs`

- [ ] **Step 1: Write the failing tests** (append to `agent/market-calendar.test.mjs`)

```javascript
import { isTradingDay, nextTradingDay, addTradingDays } from './market-calendar.js';

test('isTradingDay: weekdays true, weekends and holidays false', () => {
  assert.equal(isTradingDay('2026-05-28'), true);   // Thursday
  assert.equal(isTradingDay('2026-05-30'), false);  // Saturday
  assert.equal(isTradingDay('2026-05-31'), false);  // Sunday
  assert.equal(isTradingDay('2026-05-25'), false);  // Memorial Day (holiday)
});

test('nextTradingDay skips weekend', () => {
  assert.equal(nextTradingDay('2026-05-29'), '2026-06-01'); // Fri -> Mon
});

test('nextTradingDay skips a holiday', () => {
  assert.equal(nextTradingDay('2026-05-22'), '2026-05-26'); // Fri -> (Sat/Sun/Memorial) -> Tue
});

test('addTradingDays counts only trading days, holiday-aware', () => {
  // From Thu 2026-05-21: +1=Fri 22, +2 skips Sat/Sun/Memorial -> Tue 26, +3 -> Wed 27
  assert.equal(addTradingDays('2026-05-21', 3), '2026-05-27');
  assert.equal(addTradingDays('2026-05-21', 0), '2026-05-21'); // n=0 is identity
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `node --test agent/market-calendar.test.mjs`
Expected: FAIL — `isTradingDay is not a function` (export missing).

- [ ] **Step 3: Implement the helpers** (append to `agent/market-calendar.js`, after `isMarketHoliday`)

```javascript
// ── Trading-day arithmetic (holiday-aware) ──────────────────────────────────
// All helpers operate on ET calendar-date strings "YYYY-MM-DD". A noon-UTC
// anchor is used for stepping so DST never shifts the calendar date.
function _addCalendarDay(etDate) {
  const d = new Date(etDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// isTradingDay: a weekday that is not a full-close holiday.
export function isTradingDay(etDate) {
  const dow = new Date(etDate + 'T12:00:00Z').getUTCDay(); // 0 Sun .. 6 Sat
  if (dow === 0 || dow === 6) return false;
  return !MARKET_HOLIDAYS.has(etDate);
}

// nextTradingDay: the first trading day strictly after etDate.
export function nextTradingDay(etDate) {
  let d = _addCalendarDay(etDate);
  while (!isTradingDay(d)) d = _addCalendarDay(d);
  return d;
}

// addTradingDays: advance n trading days from etDate (n=0 returns etDate as-is,
// even if etDate itself is a weekend/holiday — callers anchor the start first).
export function addTradingDays(etDate, n) {
  let d = etDate;
  for (let i = 0; i < n; i++) d = nextTradingDay(d);
  return d;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `node --test agent/market-calendar.test.mjs`
Expected: PASS (existing tests + 4 new).

- [ ] **Step 5: Commit**

```bash
git add agent/market-calendar.js agent/market-calendar.test.mjs
git commit -m "feat(tips): holiday-aware trading-day arithmetic in market-calendar"
```

---

## Task 2: Bar-cache reader — daily closes + forward return

**Files:**
- Create: `agent/bar-cache-reader.js`
- Test: `agent/bar-cache-reader.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// agent/bar-cache-reader.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDailyCloses, closeOnOrAfter, forwardReturn } from './bar-cache-reader.js';

async function tmpCache(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-'));
  const dir = path.join(root, 'data', 'bar-cache');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, obj] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), JSON.stringify(obj));
  }
  return root;
}
function bar(date, close) {
  return { Symbol: 'X', Timestamp: `${date}T04:00:00Z`, Open: close, High: close, Low: close, Close: close, Volume: 1, VWAP: close };
}

test('loadDailyCloses merges rolling files, newest written_at wins on dupes', async () => {
  const root = await tmpCache({
    'X_1Day_2026-05-01_2026-05-04.json': { symbol: 'X', written_at: '2026-05-04T00:00:00Z', bars: [bar('2026-05-01', 100), bar('2026-05-04', 110)] },
    'X_1Day_2026-05-04_2026-05-06.json': { symbol: 'X', written_at: '2026-05-06T00:00:00Z', bars: [bar('2026-05-04', 111), bar('2026-05-06', 120)] },
  });
  const closes = await loadDailyCloses(root, 'X');
  assert.equal(closes.get('2026-05-01'), 100);
  assert.equal(closes.get('2026-05-04'), 111); // newer written_at wins
  assert.equal(closes.get('2026-05-06'), 120);
});

test('loadDailyCloses returns empty map for unknown symbol', async () => {
  const root = await tmpCache({});
  assert.equal((await loadDailyCloses(root, 'NOPE')).size, 0);
});

test('closeOnOrAfter finds the next available trading-day bar within lookahead', async () => {
  const closes = new Map([['2026-05-04', 111], ['2026-05-06', 120]]);
  assert.deepEqual(closeOnOrAfter(closes, '2026-05-05', 4), { date: '2026-05-06', close: 120 });
  assert.equal(closeOnOrAfter(closes, '2026-05-07', 1), null);
});

test('forwardReturn computes underlying return over a 3-trading-day window', async () => {
  // 2026-05-21 Thu close 100 ; +3 trading days = 2026-05-27 close 110 -> +10%
  const closes = new Map([['2026-05-21', 100], ['2026-05-27', 110]]);
  const r = forwardReturn(closes, '2026-05-21', 3, '2026-05-29');
  assert.equal(r.status, 'ok');
  assert.equal(r.startDate, '2026-05-21');
  assert.equal(r.endDate, '2026-05-27');
  assert.ok(Math.abs(r.ret - 0.1) < 1e-9);
});

test('forwardReturn is pending when the window end is in the future', async () => {
  const closes = new Map([['2026-05-28', 100]]);
  const r = forwardReturn(closes, '2026-05-28', 3, '2026-05-29'); // end ~ 2026-06-02 > today
  assert.equal(r.status, 'pending');
});

test('forwardReturn is no_data when the start bar is missing in the past', async () => {
  const closes = new Map();
  const r = forwardReturn(closes, '2026-05-04', 3, '2026-05-29');
  assert.equal(r.status, 'no_data');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --test agent/bar-cache-reader.test.mjs`
Expected: FAIL — `Cannot find module './bar-cache-reader.js'`.

- [ ] **Step 3: Implement `agent/bar-cache-reader.js`**

```javascript
// agent/bar-cache-reader.js
// Read-only daily-close lookup over data/bar-cache/<SYM>_1Day_<start>_<end>.json.
// Multiple rolling-window files exist per symbol; we merge them and dedupe by ET
// date, newest written_at winning. Pure FS + date math.
import fs from 'node:fs/promises';
import path from 'node:path';
import { etDateString, isTradingDay, nextTradingDay, addTradingDays } from './market-calendar.js';

function _addCalendarDay(etDate) {
  const d = new Date(etDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// loadDailyCloses returns Map<etDate, closePrice> merged across all cache files
// for the symbol. Bars use PascalCase Alpaca keys (Timestamp/Close).
export async function loadDailyCloses(projectRoot, symbol) {
  const dir = path.join(projectRoot, 'data', 'bar-cache');
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
  const prefix = `${symbol.toUpperCase()}_1Day_`;
  const winner = new Map(); // etDate -> { close, writtenAt }
  for (const f of files) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    let obj;
    try {
      obj = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
    } catch {
      continue; // skip malformed cache file
    }
    const bars = Array.isArray(obj) ? obj : (obj.bars || []);
    const writtenAt = (obj && obj.written_at) || '';
    for (const b of bars) {
      const ts = b.Timestamp || b.timestamp;
      const close = typeof b.Close === 'number' ? b.Close : b.close;
      if (!ts || typeof close !== 'number') continue;
      const d = etDateString(new Date(ts));
      const prev = winner.get(d);
      if (!prev || writtenAt >= prev.writtenAt) winner.set(d, { close, writtenAt });
    }
  }
  const out = new Map();
  for (const [d, v] of winner) out.set(d, v.close);
  return out;
}

// closeOnOrAfter walks forward up to maxLookahead calendar days to tolerate
// small cache gaps. Returns { date, close } or null.
export function closeOnOrAfter(closes, etDate, maxLookahead = 4) {
  let d = etDate;
  for (let i = 0; i <= maxLookahead; i++) {
    if (closes.has(d)) return { date: d, close: closes.get(d) };
    d = _addCalendarDay(d);
  }
  return null;
}

// forwardReturn: return of the underlying from the tip's start trading day over
// `windowDays` trading days. Anchors the start to a trading day, then ends at
// addTradingDays(start, windowDays). Status:
//   'ok'      -> { status, startDate, endDate, startClose, endClose, ret }
//   'pending' -> window end is after todayEtDate (bars not available yet)
//   'no_data' -> a needed bar is missing although the date is in the past
export function forwardReturn(closes, startEtDate, windowDays, todayEtDate) {
  const start = isTradingDay(startEtDate) ? startEtDate : nextTradingDay(startEtDate);
  const endTarget = addTradingDays(start, windowDays);
  const s = closeOnOrAfter(closes, start, 4);
  if (endTarget > todayEtDate) return { status: 'pending' };
  if (!s) return { status: 'no_data' };
  const e = closeOnOrAfter(closes, endTarget, 4);
  if (!e) return { status: 'no_data' };
  return {
    status: 'ok',
    startDate: s.date,
    endDate: e.date,
    startClose: s.close,
    endClose: e.close,
    ret: e.close / s.close - 1,
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test agent/bar-cache-reader.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/bar-cache-reader.js agent/bar-cache-reader.test.mjs
git commit -m "feat(tips): bar-cache daily-close reader + forward-return"
```

---

## Task 3: Scorer foundations — sandbox resolution, action loading, `underlyingOf`

**Files:**
- Create: `agent/tips-scorer.js`
- Test: `agent/tips-scorer.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// agent/tips-scorer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProphetSandboxes, loadProphetActions, underlyingOf } from './tips-scorer.js';

async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scorer-'));
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'agent-config.json'), JSON.stringify({
    sandboxes: {
      sbx_6e4f26af: { accountId: '6e4f26af', agent: { activeAgentId: 'default' } },
      sbx_mean_rev: { accountId: '6e4f26af', agent: { activeAgentId: 'mean-rev' } },
    },
  }));
  return root;
}
async function writeAction(root, accountId, fname, action) {
  const dir = path.join(root, 'data', 'sandboxes', accountId, 'decisive_actions');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fname), JSON.stringify(action));
}

test('underlyingOf extracts the underlying from OCC symbols and passes plain tickers', () => {
  assert.equal(underlyingOf('AMD260717C00460000'), 'AMD');
  assert.equal(underlyingOf('QQQ260515C00712000'), 'QQQ');
  assert.equal(underlyingOf('NVDA'), 'NVDA');
  assert.equal(underlyingOf('SPY'), 'SPY');
});

test('resolveProphetSandboxes returns the default agent folder + sandbox key', async () => {
  const root = await tmpRoot();
  const sbx = await resolveProphetSandboxes(root);
  assert.equal(sbx.length, 1);
  assert.equal(sbx[0].accountId, '6e4f26af');
  assert.equal(sbx[0].sandboxId, 'sbx_6e4f26af');
});

test('loadProphetActions filters the co-mingled folder by sandbox_id', async () => {
  const root = await tmpRoot();
  await writeAction(root, '6e4f26af', '2026-05-20T19-41-25Z_BUY_UNH.json',
    { timestamp: '2026-05-20T19:41:25Z', sandbox_id: 'sbx_mean_rev', action: 'BUY', symbol: 'UNH', market_data: {} });
  await writeAction(root, '6e4f26af', '2026-05-11T13-41-55Z_BUY_QQQ.json',
    { timestamp: '2026-05-11T13:41:55Z', sandbox_id: 'sbx_6e4f26af', action: 'BUY', symbol: 'QQQ260515C00712000', market_data: { entry_price: 7.6, contracts: 6 } });
  const actions = await loadProphetActions(root);
  assert.equal(actions.length, 1);                 // mean-rev action excluded
  assert.equal(actions[0].symbol, 'QQQ260515C00712000');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: FAIL — `Cannot find module './tips-scorer.js'`.

- [ ] **Step 3: Implement the foundations** (`agent/tips-scorer.js`)

```javascript
// agent/tips-scorer.js
// Read-only Influence-Ledger scorer (spec D13: never mutates the tip store).
// Computes three never-merged views from existing files only. See the schema
// spike in docs/superpowers/plans/2026-05-30-tips-influence-scorecard-phase1b.md.
import fs from 'node:fs/promises';
import path from 'node:path';

const OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

// underlyingOf: OCC option symbol -> underlying; plain ticker -> itself.
export function underlyingOf(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (OCC_SYMBOL.test(s)) return s.match(/^[A-Z]{1,6}/)[0];
  return s;
}

// resolveProphetSandboxes: from agent-config, every sandbox whose agent is the
// `default` (Prophet) agent. Returns [{ accountId (folder), sandboxId (filter) }].
export async function resolveProphetSandboxes(projectRoot) {
  const cfgPath = path.join(projectRoot, 'data', 'agent-config.json');
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
  const sandboxes = cfg.sandboxes || {};
  const out = [];
  for (const [key, sb] of Object.entries(sandboxes)) {
    if (sb && sb.agent && sb.agent.activeAgentId === 'default' && typeof sb.accountId === 'string') {
      out.push({ accountId: sb.accountId, sandboxId: key });
    }
  }
  return out;
}

// loadProphetActions: read decisive actions for the Prophet sandbox(es), filtered
// by inner sandbox_id (the account folder is co-mingled across agents). Prefers a
// sibling *.friction.json when present (forward-compat), else the raw *.json.
export async function loadProphetActions(projectRoot) {
  const sandboxes = await resolveProphetSandboxes(projectRoot);
  const wanted = new Set(sandboxes.map(s => s.sandboxId));
  const seenFolders = new Set();
  const actions = [];
  for (const { accountId } of sandboxes) {
    if (seenFolders.has(accountId)) continue; // shared accountId -> read once
    seenFolders.add(accountId);
    const dir = path.join(projectRoot, 'data', 'sandboxes', accountId, 'decisive_actions');
    let files;
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    const frictionStems = new Set(
      files.filter(f => f.endsWith('.friction.json')).map(f => f.slice(0, -('.friction.json'.length))),
    );
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const isFriction = f.endsWith('.friction.json');
      const stem = f.replace(/\.friction\.json$/, '').replace(/\.json$/, '');
      if (!isFriction && frictionStems.has(stem)) continue; // friction sibling wins
      let action;
      try {
        action = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
      } catch {
        continue;
      }
      if (!wanted.has(action.sandbox_id)) continue; // co-mingled folder filter
      actions.push(action);
    }
  }
  return actions;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-scorer.js agent/tips-scorer.test.mjs
git commit -m "feat(tips): scorer foundations — sandbox resolution, action loading, underlyingOf"
```

---

## Task 4: Tolerant realized-P&L extractor (`extractRealizedPnl`)

**Files:**
- Modify: `agent/tips-scorer.js`
- Test: `agent/tips-scorer.test.mjs`

- [ ] **Step 1: Write the failing tests** (append; add `extractRealizedPnl` to the import line)

```javascript
import { extractRealizedPnl } from './tips-scorer.js';

const md = (market_data, reasoning = '') => ({ action: 'SELL', symbol: 'AMD260717C00460000', reasoning, market_data });

test('extractRealizedPnl prefers friction_adjusted_pl, then raw_pl', () => {
  assert.deepEqual(extractRealizedPnl(md({ friction_adjusted_pl: -800, raw_pl: -795 })),
    { pnl: -800, source: 'friction_adjusted_pl', confidence: 'high' });
  assert.deepEqual(extractRealizedPnl(md({ raw_pl: -795 })),
    { pnl: -795, source: 'raw_pl', confidence: 'high' });
});

test('extractRealizedPnl reads signed free-form dollar fields', () => {
  assert.equal(extractRealizedPnl(md({ option_loss_dollars: -795 })).pnl, -795);
  assert.equal(extractRealizedPnl(md({ option_pnl_dollars: 240 })).pnl, 240);
});

test('extractRealizedPnl normalizes sign for magnitude-style loss/gain fields', () => {
  // a *loss* field stored as a positive magnitude must come out negative
  assert.equal(extractRealizedPnl(md({ loss_dollars: 312 })).pnl, -312);
  assert.equal(extractRealizedPnl(md({ gain_dollars: -50 })).pnl, 50);
});

test('extractRealizedPnl computes from cost basis + current price when contracts known', () => {
  const r = extractRealizedPnl(md({ option_cost_basis: 43.15, option_current_price: 35.2 }), { contracts: 10 });
  assert.ok(Math.abs(r.pnl - ((35.2 - 43.15) * 10 * 100)) < 1e-6); // -7950
  assert.equal(r.source, 'computed_from_prices');
});

test('extractRealizedPnl falls back to a dollar figure in reasoning (low confidence)', () => {
  const r = extractRealizedPnl(md({}, 'Hard stop. Position reached -19.5% loss (-$795) by 10:15.'));
  assert.equal(r.pnl, -795);
  assert.equal(r.confidence, 'low');
});

test('extractRealizedPnl returns null/none when nothing is resolvable', () => {
  assert.deepEqual(extractRealizedPnl(md({ option_price: 4.2 })),
    { pnl: null, source: 'unresolved', confidence: 'none' });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: FAIL — `extractRealizedPnl is not a function`.

- [ ] **Step 3: Implement `extractRealizedPnl`** (append to `agent/tips-scorer.js`)

```javascript
// Signed dollar P&L fields, in priority order. Names are free-form per beat
// (schema spike finding 3). Each entry: [key, signRule] where signRule coerces
// magnitude-style fields: 'asis' keeps the value, 'loss' forces <=0, 'gain' forces >=0.
const DOLLAR_PNL_FIELDS = [
  ['option_pnl_dollars', 'asis'],
  ['pnl_dollars', 'asis'],
  ['realized_pl', 'asis'],
  ['unrealized_pl', 'asis'],
  ['option_gain_dollars', 'gain'],
  ['gain_dollars', 'gain'],
  ['option_loss_dollars', 'loss'],
  ['loss_dollars', 'loss'],
  ['total_session_loss', 'loss'],
];

function _coerceSign(value, rule) {
  if (rule === 'loss') return -Math.abs(value);
  if (rule === 'gain') return Math.abs(value);
  return value;
}

// extractRealizedPnl: realized dollar P&L for a close (SELL) action, with a
// tolerant fallback chain. Returns { pnl: number|null, source, confidence }.
// confidence: 'high' (canonical friction fields) | 'medium' (structured md) |
// 'low' (parsed from free-text reasoning) | 'none' (unresolved).
// `opts.contracts` (from the matched open) enables the price-compute fallback.
export function extractRealizedPnl(action, opts = {}) {
  const m = (action && action.market_data) || {};
  if (typeof m.friction_adjusted_pl === 'number') {
    return { pnl: m.friction_adjusted_pl, source: 'friction_adjusted_pl', confidence: 'high' };
  }
  if (typeof m.raw_pl === 'number') {
    return { pnl: m.raw_pl, source: 'raw_pl', confidence: 'high' };
  }
  for (const [key, rule] of DOLLAR_PNL_FIELDS) {
    if (typeof m[key] === 'number') {
      return { pnl: _coerceSign(m[key], rule), source: `md:${key}`, confidence: 'medium' };
    }
  }
  if (typeof m.option_cost_basis === 'number' && typeof m.option_current_price === 'number'
      && typeof opts.contracts === 'number') {
    const pnl = (m.option_current_price - m.option_cost_basis) * opts.contracts * 100;
    return { pnl: +pnl.toFixed(4), source: 'computed_from_prices', confidence: 'medium' };
  }
  // Last resort: a dollar figure in the free-text reasoning, e.g. "(-$795)" or
  // "loss of $312". Negatives may be written with a leading '-' inside parens.
  const reasoning = String((action && action.reasoning) || '');
  const m1 = reasoning.match(/\(\s*(-?)\$\s*([\d,]+(?:\.\d+)?)\s*\)/)
    || reasoning.match(/\b(loss|gain|profit|down|up)\b[^$]{0,20}\$\s*([\d,]+(?:\.\d+)?)/i);
  if (m1) {
    const raw = Number(m1[m1.length - 1].replace(/,/g, ''));
    if (Number.isFinite(raw)) {
      let pnl = raw;
      const ctx = (m1[1] || m1[0] || '').toLowerCase();
      if (m1[1] === '-' || /loss|down/.test(ctx)) pnl = -Math.abs(raw);
      else if (/gain|profit|up/.test(ctx)) pnl = Math.abs(raw);
      return { pnl, source: 'reasoning_regex', confidence: 'low' };
    }
  }
  return { pnl: null, source: 'unresolved', confidence: 'none' };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: PASS (the 6 new + 3 prior = 9).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-scorer.js agent/tips-scorer.test.mjs
git commit -m "feat(tips): tolerant realized-P&L extractor with provenance + confidence"
```

---

## Task 5: Agent-surfaced index from daily briefs (D9)

**Files:**
- Modify: `agent/tips-scorer.js`
- Test: `agent/tips-scorer.test.mjs`

- [ ] **Step 1: Write the failing test** (append; add the two new imports)

```javascript
import { loadAgentSurfacedIndex, agentSurfacedFor } from './tips-scorer.js';

async function writeBrief(root, ymd, brief) {
  const dir = path.join(root, 'data', 'reports');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `daily_brief_${ymd}.json`), JSON.stringify(brief));
}

test('loadAgentSurfacedIndex maps tickers to the dates the scans flagged them', async () => {
  const root = await tmpRoot();
  await writeBrief(root, '20260518', {
    date: '2026-05-18',
    analyst_actions: [{ ticker: 'NVDA', date: '2026-05-18T11:52:08+00:00' }],
    ticker_catalysts: [{ ticker: 'MSFT', published: '2026-05-18T16:26:57+00:00' }],
  });
  const idx = await loadAgentSurfacedIndex(root);
  assert.ok(idx.get('NVDA').includes('2026-05-18'));
  assert.ok(idx.get('MSFT').includes('2026-05-18'));
  assert.equal(idx.has('AAPL'), false);
});

test('agentSurfacedFor is true only when a flag date falls inside the window', () => {
  const idx = new Map([['NVDA', ['2026-05-18', '2026-05-26']]]);
  assert.equal(agentSurfacedFor(idx, 'NVDA', '2026-05-18', '2026-05-21'), true);
  assert.equal(agentSurfacedFor(idx, 'NVDA', '2026-05-19', '2026-05-21'), false); // 18 before, 26 after
  assert.equal(agentSurfacedFor(idx, 'AAPL', '2026-05-18', '2026-05-21'), false);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: FAIL — `loadAgentSurfacedIndex is not a function`.

- [ ] **Step 3: Implement** (append to `agent/tips-scorer.js`; reuse the imported `etDateString`)

Add this import at the top of `agent/tips-scorer.js` (below the existing imports):

```javascript
import { etDateString } from './market-calendar.js';
```

Then append:

```javascript
// loadAgentSurfacedIndex: build Map<TICKER, [etDate,...]> of every name the
// catalyst-news / analyst-actions scans flagged, from persisted daily briefs
// (data/reports/daily_brief_*.json). Source for the D9 agent-discoverable split.
export async function loadAgentSurfacedIndex(projectRoot) {
  const dir = path.join(projectRoot, 'data', 'reports');
  const idx = new Map();
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return idx;
    throw err;
  }
  const add = (ticker, dateStr) => {
    if (!ticker || !dateStr) return;
    const t = String(ticker).toUpperCase();
    const d = etDateString(new Date(dateStr));
    if (d === 'Invalid Date') return;
    if (!idx.has(t)) idx.set(t, []);
    if (!idx.get(t).includes(d)) idx.get(t).push(d);
  };
  for (const f of files) {
    if (!/^daily_brief_\d{8}\.json$/.test(f)) continue;
    let brief;
    try {
      brief = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
    } catch {
      continue;
    }
    for (const a of brief.analyst_actions || []) add(a.ticker, a.date || brief.date);
    for (const c of brief.ticker_catalysts || []) add(c.ticker, c.published || brief.date);
  }
  return idx;
}

// agentSurfacedFor: did any scan flag of `ticker` land in [startEtDate, endEtDate]?
export function agentSurfacedFor(idx, ticker, startEtDate, endEtDate) {
  const dates = idx.get(String(ticker).toUpperCase());
  if (!dates) return false;
  return dates.some(d => d >= startEtDate && d <= endEtDate);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: PASS (11 total).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-scorer.js agent/tips-scorer.test.mjs
git commit -m "feat(tips): agent-surfaced index from daily briefs (D9 split source)"
```

---

## Task 6: View A — tip-call quality (forward return vs SPY)

**Files:**
- Modify: `agent/tips-scorer.js`
- Test: `agent/tips-scorer.test.mjs`

- [ ] **Step 1: Write the failing test** (append; add `computeViewA` to the import line)

```javascript
import { computeViewA } from './tips-scorer.js';

test('computeViewA scores every active tip: underlying return, SPY benchmark, agentSurfaced split', async () => {
  const root = await tmpRoot();
  // price data: NVDA +10% over the window, SPY +2% -> excess +8%
  const closesBySymbol = new Map([
    ['NVDA', new Map([['2026-05-21', 100], ['2026-05-27', 110]])],
    ['SPY', new Map([['2026-05-21', 500], ['2026-05-27', 510]])],
  ]);
  const tips = [
    { id: 't1', ticker: 'NVDA', source: 'self', phase: 'active', actionableAt: '2026-05-21T14:00:00-04:00', dismissed: false },
    { id: 't2', ticker: 'NVDA', source: 'dad', phase: 'pending_candidate', actionableAt: null, dismissed: false },
  ];
  const surfaced = new Map(); // none surfaced -> human-exclusive
  const out = await computeViewA(tips, {
    windowDays: 3, todayEtDate: '2026-05-29', surfacedIndex: surfaced,
    loadCloses: async (sym) => closesBySymbol.get(sym) || new Map(),
  });
  assert.equal(out.rows.length, 1);              // only the active tip is scored
  const r = out.rows[0];
  assert.ok(Math.abs(r.underlyingReturn - 0.10) < 1e-9);
  assert.ok(Math.abs(r.spyReturn - 0.02) < 1e-9);
  assert.ok(Math.abs(r.excessReturn - 0.08) < 1e-9);
  assert.equal(r.agentSurfaced, false);
  assert.equal(r.status, 'ok');
});

test('computeViewA marks a not-yet-closed window pending (still shown — D12 misses at equal prominence)', async () => {
  const root = await tmpRoot();
  const tips = [{ id: 't3', ticker: 'IBM', source: 'self', phase: 'active', actionableAt: '2026-05-28T14:00:00-04:00', dismissed: false }];
  const out = await computeViewA(tips, {
    windowDays: 3, todayEtDate: '2026-05-29', surfacedIndex: new Map(),
    loadCloses: async () => new Map([['2026-05-28', 250]]),
  });
  assert.equal(out.rows[0].status, 'pending');
  assert.equal(out.rows[0].underlyingReturn, null);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: FAIL — `computeViewA is not a function`.

- [ ] **Step 3: Implement `computeViewA`** (append to `agent/tips-scorer.js`)

Add the import of the bar-cache helpers at the top of `agent/tips-scorer.js`:

```javascript
import { loadDailyCloses, forwardReturn } from './bar-cache-reader.js';
import { addTradingDays, isTradingDay, nextTradingDay } from './market-calendar.js';
```

Then append:

```javascript
// computeViewA — the PRIMARY "is my advice good?" view (spec §5.2-A, D2/D10).
// For every ACTIVE tip (actionableAt set), the underlying's forward return over
// the window vs SPY over the same window. Pre-outcome manual tips make this
// unbiased. Tipped-but-not-traded names earn their keep here. Misses/pending are
// kept and shown (D12). Options inject `loadCloses`/`todayEtDate` for testing.
export async function computeViewA(tips, opts = {}) {
  const windowDays = opts.windowDays ?? 3;
  const todayEtDate = opts.todayEtDate ?? etDateString(new Date());
  const surfacedIndex = opts.surfacedIndex ?? new Map();
  const loadCloses = opts.loadCloses ?? (async (sym) => loadDailyCloses(opts.projectRoot, sym));

  const active = tips.filter(t => !t.dismissed && t.phase === 'active' && t.actionableAt);
  const spyCloses = await loadCloses('SPY');
  const rows = [];
  for (const tip of active) {
    const startEt = etDateString(new Date(tip.actionableAt));
    const anchored = isTradingDay(startEt) ? startEt : nextTradingDay(startEt);
    const endEt = addTradingDays(anchored, windowDays);
    const uCloses = await loadCloses(tip.ticker);
    const u = forwardReturn(uCloses, startEt, windowDays, todayEtDate);
    const spy = forwardReturn(spyCloses, startEt, windowDays, todayEtDate);
    const ok = u.status === 'ok' && spy.status === 'ok';
    rows.push({
      id: tip.id,
      ticker: tip.ticker,
      source: tip.source,
      thesis: tip.thesis,
      actionableAt: tip.actionableAt,
      windowStart: anchored,
      windowEnd: endEt,
      status: u.status === 'ok' ? spy.status : u.status, // 'ok' | 'pending' | 'no_data'
      underlyingReturn: ok ? u.ret : null,
      spyReturn: ok ? spy.ret : null,
      excessReturn: ok ? u.ret - spy.ret : null,
      agentSurfaced: agentSurfacedFor(surfacedIndex, tip.ticker, anchored, endEt),
    });
  }
  return { rows, windowDays };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: PASS (13 total).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-scorer.js agent/tips-scorer.test.mjs
git commit -m "feat(tips): view A — tip-call quality (forward return vs SPY, holiday-aware)"
```

---

## Task 7: View B — influenced-trade P&L (entangled, coverage-honest)

**Files:**
- Modify: `agent/tips-scorer.js`
- Test: `agent/tips-scorer.test.mjs`

- [ ] **Step 1: Write the failing test** (append; add `computeViewB` to the import line)

```javascript
import { computeViewB } from './tips-scorer.js';

function buy(ts, symbol, contracts) {
  return { timestamp: ts, sandbox_id: 'sbx_6e4f26af', action: 'BUY', symbol, market_data: { entry_price: 7.6, contracts } };
}
function sell(ts, symbol, md, reasoning = '') {
  return { timestamp: ts, sandbox_id: 'sbx_6e4f26af', action: 'SELL', symbol, market_data: md, reasoning };
}

test('computeViewB matches in-window opens to their closes and extracts realized P&L', () => {
  const tips = [{ id: 't1', ticker: 'AMD', source: 'self', phase: 'active', actionableAt: '2026-05-20T14:00:00-04:00', dismissed: false }];
  const actions = [
    buy('2026-05-20T15:00:00Z', 'AMD260717C00460000', 10),
    sell('2026-05-21T14:16:23Z', 'AMD260717C00460000', { option_loss_dollars: -795 }, '-19.5% loss (-$795)'),
  ];
  const out = computeViewB(tips, actions, { windowDays: 3, surfacedIndex: new Map() });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].pnl, -795);
  assert.equal(out.rows[0].pnlConfidence, 'medium');
  assert.equal(out.rows[0].underlying, 'AMD');
  assert.equal(out.coverage.resolved, 1);
  assert.equal(out.coverage.unresolved, 0);
});

test('computeViewB ignores opens entered outside the tip window', () => {
  const tips = [{ id: 't1', ticker: 'AMD', source: 'self', phase: 'active', actionableAt: '2026-05-20T14:00:00-04:00', dismissed: false }];
  const actions = [
    buy('2026-06-15T15:00:00Z', 'AMD260717C00460000', 10), // weeks later, outside window
    sell('2026-06-16T14:16:23Z', 'AMD260717C00460000', { option_loss_dollars: -795 }),
  ];
  const out = computeViewB(tips, actions, { windowDays: 3, surfacedIndex: new Map() });
  assert.equal(out.rows.length, 0);
});

test('computeViewB reports unresolved closes as data-gaps, never as $0', () => {
  const tips = [{ id: 't1', ticker: 'NVDA', source: 'self', phase: 'active', actionableAt: '2026-05-20T14:00:00-04:00', dismissed: false }];
  const actions = [
    buy('2026-05-20T15:00:00Z', 'NVDA260717C00230000', 5),
    sell('2026-05-21T14:16:23Z', 'NVDA260717C00230000', { option_price: 4.2 }), // no resolvable P&L
  ];
  const out = computeViewB(tips, actions, { windowDays: 3, surfacedIndex: new Map() });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].pnl, null);
  assert.equal(out.rows[0].pnlConfidence, 'none');
  assert.equal(out.coverage.resolved, 0);
  assert.equal(out.coverage.unresolved, 1);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: FAIL — `computeViewB is not a function`.

- [ ] **Step 3: Implement `computeViewB`** (append to `agent/tips-scorer.js`)

```javascript
// computeViewB — the entangled "what Prophet did with it" view (spec §5.2-B).
// Matches each tip's window to influenced option round-trips: a BUY (open) on
// the tip's underlying whose entry timestamp lands in [actionableAt, +window],
// paired to its closing SELL (exact option symbol). Realized P&L via the
// tolerant extractor; unresolved closes are kept as data-gaps (never $0).
// Synchronous: it operates on already-loaded actions, no FS.
export function computeViewB(tips, actions, opts = {}) {
  const windowDays = opts.windowDays ?? 3;
  const surfacedIndex = opts.surfacedIndex ?? new Map();
  const active = tips.filter(t => !t.dismissed && t.phase === 'active' && t.actionableAt);

  const opens = actions.filter(a => a.action === 'BUY');
  const closes = actions.filter(a => a.action === 'SELL');
  // Index closes by exact symbol, earliest-after-open chosen at match time.
  const closesBySymbol = new Map();
  for (const c of closes) {
    if (!closesBySymbol.has(c.symbol)) closesBySymbol.set(c.symbol, []);
    closesBySymbol.get(c.symbol).push(c);
  }
  for (const arr of closesBySymbol.values()) arr.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  const rows = [];
  const coverage = { resolved: 0, unresolved: 0 };
  const usedCloses = new Set();
  for (const tip of active) {
    const startEt = etDateString(new Date(tip.actionableAt));
    const anchored = isTradingDay(startEt) ? startEt : nextTradingDay(startEt);
    const endEt = addTradingDays(anchored, windowDays);
    for (const open of opens) {
      if (underlyingOf(open.symbol) !== tip.ticker) continue;
      const openEt = etDateString(new Date(open.timestamp));
      if (openEt < anchored || openEt > endEt) continue; // entry must be in-window
      // find the earliest unused close for this exact option symbol after the open
      const candidates = closesBySymbol.get(open.symbol) || [];
      const close = candidates.find(c => !usedCloses.has(c) && (c.timestamp || '') >= (open.timestamp || ''));
      if (!close) continue; // still open -> not a closed trade (closed-only)
      usedCloses.add(close);
      const contracts = open.market_data && open.market_data.contracts;
      const pnlInfo = extractRealizedPnl(close, { contracts });
      if (pnlInfo.pnl === null) coverage.unresolved += 1; else coverage.resolved += 1;
      rows.push({
        tipId: tip.id,
        source: tip.source,
        underlying: tip.ticker,
        optionSymbol: open.symbol,
        openAt: open.timestamp,
        closeAt: close.timestamp,
        pnl: pnlInfo.pnl,
        pnlSource: pnlInfo.source,
        pnlConfidence: pnlInfo.confidence,
        agentSurfaced: agentSurfacedFor(surfacedIndex, tip.ticker, anchored, endEt),
      });
    }
  }
  return { rows, coverage, windowDays };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: PASS (16 total).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-scorer.js agent/tips-scorer.test.mjs
git commit -m "feat(tips): view B — entangled influenced-trade P&L with coverage honesty"
```

---

## Task 8: Per-source stats + view C + top-level `scoreTips`

**Files:**
- Modify: `agent/tips-scorer.js`
- Test: `agent/tips-scorer.test.mjs`

- [ ] **Step 1: Write the failing test** (append; add `summarizeDistribution`, `scoreTips` to the import line)

```javascript
import { summarizeDistribution, scoreTips } from './tips-scorer.js';

test('summarizeDistribution flags small samples and demotes profit factor (D11)', () => {
  const s = summarizeDistribution([-795, 240, 120], { minSample: 20 });
  assert.equal(s.n, 3);
  assert.equal(s.smallSample, true);            // below threshold
  assert.equal(s.median, 120);
  assert.equal(s.profitFactorSuppressed, true); // demoted at small n
  assert.ok(Math.abs(s.sum - (-795 + 240 + 120)) < 1e-9);
});

test('summarizeDistribution exposes profit factor only at/above threshold', () => {
  const data = Array.from({ length: 20 }, (_, i) => (i % 2 ? 100 : -50));
  const s = summarizeDistribution(data, { minSample: 20 });
  assert.equal(s.smallSample, false);
  assert.equal(s.profitFactorSuppressed, false);
  assert.ok(Math.abs(s.profitFactor - (1000 / 500)) < 1e-9);
});

test('scoreTips assembles A/B/C + perSource and never emits a single headline score', async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, 'data', 'tips'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'tips', 'tips.json'), JSON.stringify([
    { id: 't1', ticker: 'NVDA', source: 'self', phase: 'active', actionableAt: '2026-05-21T14:00:00-04:00', dismissed: false, thesis: 'x' },
  ]));
  const out = await scoreTips(root, {
    windowDays: 3, minSample: 20, todayEtDate: '2026-05-29',
    loadCloses: async (sym) => new Map([['2026-05-21', sym === 'SPY' ? 500 : 100], ['2026-05-27', sym === 'SPY' ? 510 : 110]]),
  });
  assert.ok(out.viewA && out.viewB && out.viewC && out.perSource && out.meta);
  assert.equal('headlineScore' in out.meta, false); // ledger, not leaderboard
  assert.equal(out.viewA.rows[0].ticker, 'NVDA');
  assert.ok(out.meta.windowDays === 3);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: FAIL — `summarizeDistribution is not a function`.

- [ ] **Step 3: Implement** (append to `agent/tips-scorer.js`; also import `readTips` at the top)

Add at the top of `agent/tips-scorer.js`:

```javascript
import { readTips } from './tips-store.js';
```

Then append:

```javascript
// summarizeDistribution — small-n discipline (D11). Prefers the per-value
// distribution; profit factor is exposed ONLY at/above minSample, suppressed
// otherwise. No single headline score is ever produced.
export function summarizeDistribution(values, opts = {}) {
  const minSample = opts.minSample ?? 20;
  const xs = values.filter(v => typeof v === 'number');
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  const median = n === 0 ? null : (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2);
  const wins = xs.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(xs.filter(v => v < 0).reduce((a, b) => a + b, 0));
  const smallSample = n < minSample;
  const profitFactorSuppressed = smallSample || losses === 0;
  return {
    n,
    smallSample,
    sum: +sum.toFixed(4),
    median: median === null ? null : +median.toFixed(4),
    min: n ? sorted[0] : null,
    max: n ? sorted[n - 1] : null,
    winCount: xs.filter(v => v > 0).length,
    lossCount: xs.filter(v => v < 0).length,
    profitFactorSuppressed,
    profitFactor: profitFactorSuppressed ? null : +(wins / losses).toFixed(4),
    values: xs,
  };
}

function _perSource(rows, valueKey, minSample) {
  const bySource = new Map();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    if (typeof r[valueKey] === 'number') bySource.get(r.source).push(r[valueKey]);
  }
  const out = {};
  for (const [source, values] of bySource) {
    out[source] = summarizeDistribution(values, { minSample });
  }
  return out;
}

// scoreTips — top-level assembly. Read-only (D13). Emits the three never-merged
// views (D10), each split by agentSurfaced (D9), with per-source small-sample
// guards (D11) and explicit window/coverage meta. No leaderboard, no headline.
export async function scoreTips(projectRoot, opts = {}) {
  const windowDays = opts.windowDays ?? Number(process.env.TIPS_ATTRIBUTION_WINDOW_DAYS || 3);
  const minSample = opts.minSample ?? Number(process.env.TIPS_MIN_SAMPLE || 20);
  const todayEtDate = opts.todayEtDate ?? etDateString(new Date());

  const tips = await readTips(projectRoot);
  const surfacedIndex = await loadAgentSurfacedIndex(projectRoot);
  const actions = await loadProphetActions(projectRoot);

  const viewA = await computeViewA(tips, { projectRoot, windowDays, todayEtDate, surfacedIndex, loadCloses: opts.loadCloses });
  const viewB = computeViewB(tips, actions, { windowDays, surfacedIndex });

  // View C — context only (spec §5.2-C): catalyst (tip-influenced) option trades
  // vs all other closed Prophet option trades. Framed as trades-vs-rest, never
  // human-vs-agent. Demoted.
  const influencedSymbols = new Set(viewB.rows.map(r => r.optionSymbol));
  const allClosed = [];
  const closeBySym = new Map();
  for (const a of actions) {
    if (a.action !== 'BUY') continue;
    closeBySym.set(a.symbol, a.market_data && a.market_data.contracts);
  }
  for (const a of actions) {
    if (a.action !== 'SELL') continue;
    if (!OCC_SYMBOL.test(String(a.symbol))) continue; // option closes only
    const info = extractRealizedPnl(a, { contracts: closeBySym.get(a.symbol) });
    allClosed.push({ symbol: a.symbol, pnl: info.pnl, influenced: influencedSymbols.has(a.symbol) });
  }
  const influencedPnl = allClosed.filter(r => r.influenced && typeof r.pnl === 'number').map(r => r.pnl);
  const autonomousPnl = allClosed.filter(r => !r.influenced && typeof r.pnl === 'number').map(r => r.pnl);
  const viewC = {
    note: 'Context only — catalyst-influenced trades vs everything else, NOT human-vs-agent.',
    influenced: summarizeDistribution(influencedPnl, { minSample }),
    autonomous: summarizeDistribution(autonomousPnl, { minSample }),
  };

  // Per-source breakdowns with small-sample guards.
  const perSource = {
    viewA_excess: _perSource(viewA.rows.filter(r => r.status === 'ok'), 'excessReturn', minSample),
    viewB_pnl: _perSource(viewB.rows.filter(r => typeof r.pnl === 'number'), 'pnl', minSample),
  };

  return {
    viewA,
    viewB,
    viewC,
    perSource,
    meta: {
      windowDays,
      minSample,
      todayEtDate,
      tipCounts: {
        total: tips.filter(t => !t.dismissed).length,
        active: tips.filter(t => !t.dismissed && t.phase === 'active').length,
        pendingCandidate: tips.filter(t => !t.dismissed && t.phase === 'pending_candidate').length,
      },
      viewBCoverage: viewB.coverage,
      agentSurfacedCaveat: 'agentSurfaced is derived from persisted daily briefs (in-universe scan coverage only); absence is not proof the agent did not see it.',
    },
  };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test agent/tips-scorer.test.mjs`
Expected: PASS (19 total).

- [ ] **Step 5: Commit**

```bash
git add agent/tips-scorer.js agent/tips-scorer.test.mjs
git commit -m "feat(tips): per-source small-sample stats, view C, and scoreTips assembly"
```

---

## Task 9: Flag-gated `GET /api/tips/ledger` endpoint

**Files:**
- Modify: `agent/server.js`

- [ ] **Step 1: Add the import** (next to the existing `import { readTips, createTip, dismissTip, getSources } from './tips-store.js';`)

```javascript
import { scoreTips } from './tips-scorer.js';
```

- [ ] **Step 2: Add the route** (immediately after the `app.post('/api/tips/:id/dismiss', ...)` handler added in Phase 1a)

```javascript
app.get('/api/tips/ledger', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const ledger = await scoreTips(PROJECT_ROOT, {});
    res.json({ ledger });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 3: Verify the server module still parses**

Run: `node -e "import('./agent/server.js').then(()=>console.log('loads')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `loads`. (`tipsEnabled()` and `PROJECT_ROOT` already exist from Phase 1a.)

- [ ] **Step 4: Manual smoke test**

```bash
ENABLE_TIPS_SCORECARD=true AGENT_PORT=3940 node agent/server.js &
sleep 1
curl -s localhost:3940/api/tips/ledger | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('keys:',Object.keys(j.ledger));console.log('meta:',JSON.stringify(j.ledger.meta.tipCounts))})"
kill %1
```
Expected: `keys: [ 'viewA', 'viewB', 'viewC', 'perSource', 'meta' ]` and a `tipCounts` object. With the flag unset the route returns HTTP 404.

- [ ] **Step 5: Commit**

```bash
git add agent/server.js
git commit -m "feat(tips): flag-gated GET /api/tips/ledger (read-only scorer endpoint)"
```

---

## Task 10: Tips-tab ledger UI — three views, per-source, misses at equal prominence

**Files:**
- Modify: `agent/public/index.html`

- [ ] **Step 1: Add a ledger container** to `#panel-tips` — insert immediately **before** the existing `<div id="tips-list">...</div>` (added in Phase 1a)

```html
        <div id="tips-ledger"></div>
```

- [ ] **Step 2: Call the ledger loader** from `loadTipsPanel()` — add this line inside `loadTipsPanel`, right after the existing `formWrap.style.display = '';` assignment (so it runs only when the flag is enabled)

```javascript
    loadTipsLedger();
```

- [ ] **Step 3: Add the ledger renderer** (paste after the `submitTip` function in the Tips-tab JS block)

```javascript
function pct(x) { return x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%'; }
function usd(x) { return x == null ? '—' : (x >= 0 ? '+$' : '-$') + Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function retClass(x) { return x == null ? '' : (x >= 0 ? 'pnl-pos' : 'pnl-neg'); }

async function loadTipsLedger() {
  const host = document.getElementById('tips-ledger');
  if (!host) return;
  let ledger;
  try {
    const res = await fetch('/api/tips/ledger');
    if (!res.ok) { host.innerHTML = ''; return; }
    ledger = (await res.json()).ledger;
  } catch { host.innerHTML = ''; return; }

  const m = ledger.meta;
  // View A rows — misses/pending shown at equal prominence (D12).
  const aRows = ledger.viewA.rows.map(r => `
    <div class="trade-card">
      <div class="trade-header">
        <span><span class="trade-symbol">${esc(r.ticker)}</span>
          <span class="trade-agent-badge">${esc(r.source)}</span>
          <span class="trade-agent-badge">${r.agentSurfaced ? 'agent-discoverable' : 'human-exclusive'}</span></span>
        <span class="trade-time">${esc((r.actionableAt || '').slice(0, 10))} · ${r.windowDays || m.windowDays}TD</span>
      </div>
      <div class="trade-details">
        ${r.status === 'ok'
          ? `<span class="${retClass(r.excessReturn)}">${pct(r.underlyingReturn)} vs SPY ${pct(r.spyReturn)} → excess <b>${pct(r.excessReturn)}</b></span>`
          : `<span class="no-data" style="display:inline">${r.status === 'pending' ? 'window still open' : 'no price data'}</span>`}
        ${r.thesis ? `<div style="opacity:.7;margin-top:4px;">${esc(r.thesis)}</div>` : ''}
      </div>
    </div>`).join('') || '<div class="no-data">No active tips to score yet.</div>';

  // View B rows.
  const bRows = ledger.viewB.rows.map(r => `
    <div class="trade-card">
      <div class="trade-header">
        <span><span class="trade-symbol">${esc(r.underlying)}</span>
          <span class="trade-agent-badge">${esc(r.source)}</span>
          <span class="trade-agent-badge">${esc(r.optionSymbol)}</span></span>
        <span class="trade-time">${esc((r.closeAt || '').slice(0, 10))}</span>
      </div>
      <div class="trade-details">
        ${r.pnl == null
          ? `<span class="no-data" style="display:inline">P&amp;L unresolved (data gap) — not counted</span>`
          : `<span class="${retClass(r.pnl)}">${usd(r.pnl)}</span> <span style="opacity:.6;">(${esc(r.pnlConfidence)})</span>`}
      </div>
    </div>`).join('') || '<div class="no-data">No influenced trades matched yet.</div>';

  const srcLine = (label, bySrc) => Object.entries(bySrc).map(([s, d]) =>
    `<div>${esc(s)}: n=${d.n}${d.smallSample ? ' <span style="opacity:.6;">(small sample — ranking suppressed)</span>' : ''}, median ${label === 'A' ? pct(d.median) : usd(d.median)}, sum ${label === 'A' ? pct(d.sum) : usd(d.sum)}</div>`).join('') || '<div style="opacity:.6;">—</div>';

  host.innerHTML = `
    <div class="settings-content" style="margin-bottom:18px;">
      <h3>A · Tip-call quality <span style="opacity:.6;font-weight:normal;">— was the call good? (forward return vs SPY, ${m.windowDays} trading days)</span></h3>
      <div style="opacity:.7;font-size:12px;margin-bottom:8px;">Scores every active tip, traded or not. Misses and open windows shown at equal prominence.</div>
      ${aRows}
      <div style="margin-top:8px;font-size:12px;">
        <b>Per source (excess return):</b> ${srcLine('A', ledger.perSource.viewA_excess)}
      </div>
    </div>
    <div class="settings-content" style="margin-bottom:18px;">
      <h3>B · Influenced-trade P&amp;L <span style="opacity:.6;font-weight:normal;">— what Prophet did with it (entangled: your call + its selection + its exit)</span></h3>
      <div style="opacity:.7;font-size:12px;margin-bottom:8px;">Coverage: ${ledger.viewB.coverage.resolved} resolved, ${ledger.viewB.coverage.unresolved} unresolved (shown as gaps, never $0).</div>
      ${bRows}
      <div style="margin-top:8px;font-size:12px;">
        <b>Per source (realized P&amp;L):</b> ${srcLine('B', ledger.perSource.viewB_pnl)}
      </div>
    </div>
    <div class="settings-content" style="margin-bottom:18px;">
      <h3>C · Context <span style="opacity:.6;font-weight:normal;">— catalyst trades vs everything else (NOT human-vs-agent)</span></h3>
      <div style="font-size:12px;">Influenced: n=${ledger.viewC.influenced.n}, sum ${usd(ledger.viewC.influenced.sum)}, median ${usd(ledger.viewC.influenced.median)}</div>
      <div style="font-size:12px;">Autonomous: n=${ledger.viewC.autonomous.n}, sum ${usd(ledger.viewC.autonomous.sum)}, median ${usd(ledger.viewC.autonomous.median)}</div>
    </div>
    <div style="opacity:.55;font-size:11px;margin-bottom:8px;">${esc(m.agentSurfacedCaveat)}</div>`;
}
```

- [ ] **Step 4: Add minimal P&L color classes** — only if `.pnl-pos` / `.pnl-neg` are not already defined in the page `<style>`. Search `index.html` for `pnl-pos`; if absent, add to the `<style>` block:

```css
    .pnl-pos { color: var(--success, #2e7d32); }
    .pnl-neg { color: var(--error, #c62828); }
```

- [ ] **Step 5: Manual verification in the browser**

```bash
ENABLE_TIPS_SCORECARD=true node agent/server.js
```
Open the dashboard → **Tips** tab. Expected: below the log form, three labelled sections (A/B/C) render. With at least one in-universe active tip on a name in `data/bar-cache`, view A shows its forward return vs SPY (or "window still open" for a tip younger than the window). View B shows matched influenced trades or "No influenced trades matched yet." Per-source lines show `n=` and a "small sample" note. Restart without the flag → the ledger area is empty and the "Tips ledger is off" message shows (Phase-1a behavior preserved).

- [ ] **Step 6: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(tips): Tips-tab ledger UI — views A/B/C, per-source, misses at equal prominence"
```

---

## Task 11: Document the tuning flags + full suite green

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add the flag docs** (under the existing `ENABLE_TIPS_SCORECARD` block added in Phase 1a)

```bash
# Scorer tuning (Phase 1b). Attribution window in TRADING days (holiday-aware),
# and the per-source minimum sample below which ranking/profit-factor are
# suppressed (ledger-not-leaderboard, spec D11). Both have built-in defaults.
TIPS_ATTRIBUTION_WINDOW_DAYS=3
TIPS_MIN_SAMPLE=20
```

- [ ] **Step 2: Run the entire tip + calendar suite once more**

Run: `node --test agent/market-calendar.test.mjs agent/bar-cache-reader.test.mjs agent/tips-store.test.mjs agent/tips-scorer.test.mjs`
Expected: PASS — all suites green (Phase-1a store tests still pass; new calendar/bar-cache/scorer tests pass).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(tips): document TIPS_ATTRIBUTION_WINDOW_DAYS + TIPS_MIN_SAMPLE"
```

---

## Self-review (completed during planning)

**Spec coverage (Phase 1b scorer slice of §10):**
- View A — underlying forward-return vs SPY for *every* active tip, holiday-aware window, unbiased for pre-outcome manual tips (§5.2-A, D2/D10) ✓ Task 6 (+ Tasks 1–2 for the window math + prices).
- View B — entangled influenced-trade option P&L, closed-only, friction-adjusted-with-fallback (§5.2-B) ✓ Task 7 (+ Task 4 extractor).
- View C — influenced-vs-autonomous as context only, framed trades-vs-rest (§5.2-C) ✓ Task 8.
- Human-exclusive vs agent-discoverable split via `agentSurfaced` (D9) ✓ Tasks 5–8.
- Per-source small-sample guard; demote profit factor → distribution; no headline/leaderboard (D11) ✓ Task 8.
- Read-only, never mutates the tip store (D13) ✓ — scorer imports only `readTips`/`readUniverse`; no store mutators.
- Flag-gated default OFF (§7) ✓ Task 9 (route 404s when disabled).
- Tips-tab surfaces the three views + per-source + misses at equal prominence (§5.6, D12) ✓ Task 10.
- **Deferred (correctly out of Phase 1b scope):** candidate eligibility evaluation + Add-to-universe (Phase 2); news-candidate feed + Trades-tab badge + Settings source editor (Phase 3); `review-performance` scorecard-summary integration (spec §5.7 — may land in Phase 2 per §10). FMP price fallback (bar-cache primary suffices for in-universe view-A names; documented as future).

**Placeholder scan:** no TBD/TODO; every code step is complete and runnable.

**Type consistency:** record shapes are consistent across tasks — view A rows (`{id,ticker,source,thesis,actionableAt,windowStart,windowEnd,status,underlyingReturn,spyReturn,excessReturn,agentSurfaced}`), view B rows (`{tipId,source,underlying,optionSymbol,openAt,closeAt,pnl,pnlSource,pnlConfidence,agentSurfaced}`), `extractRealizedPnl` → `{pnl,source,confidence}`, `summarizeDistribution` → `{n,smallSample,sum,median,min,max,winCount,lossCount,profitFactorSuppressed,profitFactor,values}`. Exports consumed by the server (`scoreTips`) and by tests match the implementations. `computeViewA` is async (loads SPY + per-ticker closes); `computeViewB` is synchronous (operates on pre-loaded actions) — `scoreTips` awaits A and calls B directly, consistent with Tasks 6–8.

**Schema-spike fidelity:** the plan reads the co-mingled account folder filtered by `sandbox_id` (finding 1), does not depend on `*.friction.json` existing (finding 2), uses the tolerant multi-field + reasoning-regex extractor (finding 3), treats BUY/SELL as open/close (finding 4), derives the underlying via the OCC regex (finding 6), prices from bar-cache with data-gap honesty (finding 7), and `agentSurfaced` from daily briefs (finding 8).
