# Trade-Log ↔ Broker Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A once-daily (after close) job that compares each sandbox's trade-history log against the broker's actual orders, classifies discrepancies into phantom-success / false-failure / status-divergence, writes a per-sandbox report, and shows a day-level "possible mismatches" banner in the Trades tab.

**Architecture:** All Node. A pure matcher (`reconcileTrades`) plus pure windowing/coverage helpers and a report writer/reader live in a new `agent/trade-reconciliation.js`. A per-sandbox async runner ties them to the existing broker fetch (`goAxios` `GET /api/v1/orders?status=all`) and trade log (`trades-store.readTrades`). The `analysis-scheduler.js` fires the job after close; `server.js` injects the cross-sandbox runner (iterating `orchestrator.runtimes`, the same way `emitConnectFillsSummaries` does) and serves a read API; `index.html` renders the banner.

**Tech Stack:** Node.js (ES modules, `node:test`), vanilla browser JS/CSS. No Go/backend change (reuses the existing orders endpoint; a coverage guard handles the rare 500-truncation case).

**Spec:** `docs/superpowers/specs/2026-05-26-trade-reconciliation-design.md`

**Dependency:** the matcher reads `trade.status` (`'success'`/`'failed'`), added by the failed-trade-indicator feature (PR #67). Implement this on a branch based on that work (or after #67 merges) so the field exists.

---

## File Structure

- `agent/trade-reconciliation.js` — **new**. Pure: `classifyBrokerStatus`, `reconcileTrades`, `etDayOf`, `isReconcilableTrade`, `normalizeBrokerOrder`, `assessCoverage`. I/O (injected deps): `writeReconciliationReport`, `readReconciliationSummary`, `runReconciliationForSandbox`.
- `agent/trade-reconciliation.test.mjs` — **new**. Covered by the existing `npm test` glob.
- `agent/analysis-scheduler.js` — register `trade_reconciliation` job, schedule gate (16:45 ET weekday), injected runner.
- `agent/server.js` — inject the cross-sandbox runner into the scheduler; add `GET /api/reconciliation`.
- `agent/public/index.html` — banner element, CSS, fetch-on-seed, render.
- No changes to `agent/trades-store.js` or the Go backend.

---

## Task 1: Pure matcher — `classifyBrokerStatus` + `reconcileTrades`

**Files:**
- Create: `agent/trade-reconciliation.js`
- Test: `agent/trade-reconciliation.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `agent/trade-reconciliation.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBrokerStatus, reconcileTrades } from './trade-reconciliation.js';

const ok = (symbol, side, status, filledQty = 0) => ({ symbol, side, status, filledQty });
const log = (symbol, side, status) => ({ symbol, side, status, timestamp: '2026-05-26T13:33:00Z' });

test('classifyBrokerStatus: terminal-took / terminal-reject / unresolved', () => {
  assert.equal(classifyBrokerStatus('filled'), 'took');
  assert.equal(classifyBrokerStatus('partially_filled'), 'took');
  assert.equal(classifyBrokerStatus('done_for_day', 3), 'took');
  assert.equal(classifyBrokerStatus('done_for_day', 0), 'unresolved');
  assert.equal(classifyBrokerStatus('rejected'), 'reject');
  assert.equal(classifyBrokerStatus('canceled'), 'reject');
  assert.equal(classifyBrokerStatus('expired'), 'reject');
  assert.equal(classifyBrokerStatus('new'), 'unresolved');
  assert.equal(classifyBrokerStatus('pending_new'), 'unresolved');
  assert.equal(classifyBrokerStatus('accepted'), 'unresolved');
});

test('phantom success: logged success, no terminal broker order', () => {
  const r = reconcileTrades([log('AMD', 'buy', 'success')], []);
  assert.equal(r.counts.phantomSuccess, 1);
  assert.equal(r.mismatches[0].class, 'phantom_success');
  assert.equal(r.mismatches[0].symbol, 'AMD');
});

test('false failure: logged failed, broker filled', () => {
  const r = reconcileTrades([log('AMD', 'buy', 'failed')], [ok('AMD', 'buy', 'filled', 2)]);
  assert.equal(r.counts.falseFailure, 1);
  assert.equal(r.mismatches[0].class, 'false_failure');
});

test('status divergence: 3 logged success, broker 1 filled + 2 rejected → 2', () => {
  const r = reconcileTrades(
    [log('QQQ', 'buy', 'success'), log('QQQ', 'buy', 'success'), log('QQQ', 'buy', 'success')],
    [ok('QQQ', 'buy', 'filled', 4), ok('QQQ', 'buy', 'rejected'), ok('QQQ', 'buy', 'rejected')],
  );
  assert.equal(r.counts.statusDivergence, 2);
  assert.equal(r.mismatches[0].class, 'status_divergence');
});

test('clean day: logged success matched by a fill → no mismatch', () => {
  const r = reconcileTrades([log('AMD', 'buy', 'success')], [ok('AMD', 'buy', 'filled', 2)]);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.counts.phantomSuccess + r.counts.falseFailure + r.counts.statusDivergence, 0);
});

test('non-terminal: logged failed vs pending_new order → zero mismatches, unresolved counted', () => {
  const r = reconcileTrades([log('AMD', 'buy', 'failed')], [ok('AMD', 'buy', 'pending_new')]);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.counts.unresolved, 1);
});

test('empty inputs: no throw, zero counts', () => {
  const r = reconcileTrades([], []);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.counts.total, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test agent/trade-reconciliation.test.mjs`
Expected: FAIL — module/exports do not exist.

- [ ] **Step 3: Implement the matcher**

Create `agent/trade-reconciliation.js`:

```javascript
// Trade-log ↔ broker reconciliation. Pure matcher + windowing/coverage helpers
// (Tasks 1-2) and injected-dep I/O (Tasks 3-4). Compares what an agent's trade
// log recorded against the broker's actual orders for the day, classifying
// discrepancies. Only TERMINAL broker states drive a verdict — non-terminal
// orders are counted as `unresolved` and never flagged, so an in-flight order
// can never produce a confident-but-wrong banner.

// classifyBrokerStatus buckets a broker order status into 'took' | 'reject' |
// 'unresolved'. done_for_day counts as took only if something filled.
export function classifyBrokerStatus(status, filledQty = 0) {
  const s = String(status || '').toLowerCase();
  if (s === 'filled' || s === 'partially_filled') return 'took';
  if (s === 'done_for_day') return Number(filledQty) > 0 ? 'took' : 'unresolved';
  if (s === 'rejected' || s === 'canceled' || s === 'cancelled' || s === 'expired') return 'reject';
  return 'unresolved'; // new, accepted, pending_new, pending_cancel, pending_replace, …
}

// reconcileTrades groups logged trades and broker orders by (symbol, side) and
// classifies each group. Reports group-level when 1:1 attribution is ambiguous
// (no order id on the log side). Returns { mismatches, counts }.
export function reconcileTrades(loggedTrades, brokerOrders) {
  const logged = Array.isArray(loggedTrades) ? loggedTrades : [];
  const broker = Array.isArray(brokerOrders) ? brokerOrders : [];
  const keyOf = (symbol, side) => `${symbol}|${String(side || '').toLowerCase()}`;
  const groups = new Map();
  const group = (symbol, side) => {
    const k = keyOf(symbol, side);
    if (!groups.has(k)) groups.set(k, { symbol, side: String(side || '').toLowerCase(), logged: [], broker: [] });
    return groups.get(k);
  };
  for (const t of logged) group(t.symbol, t.side).logged.push(t);
  for (const o of broker) group(o.symbol, o.side).broker.push(o);

  const mismatches = [];
  const counts = { phantomSuccess: 0, falseFailure: 0, statusDivergence: 0, unresolved: 0, matched: 0, total: logged.length };

  for (const g of groups.values()) {
    const successLogs = g.logged.filter((t) => t.status === 'success');
    const failedLogs = g.logged.filter((t) => t.status === 'failed');
    let took = 0, reject = 0;
    const tookOrders = [], rejectOrders = [];
    for (const o of g.broker) {
      const c = classifyBrokerStatus(o.status, o.filledQty);
      if (c === 'took') { took++; tookOrders.push(o); }
      else if (c === 'reject') { reject++; rejectOrders.push(o); }
      else counts.unresolved++;
    }

    if (successLogs.length > 0 && took + reject === 0) {
      counts.phantomSuccess += successLogs.length;
      mismatches.push({
        class: 'phantom_success', symbol: g.symbol, side: g.side,
        loggedTrades: successLogs, brokerOrders: g.broker,
        note: `${successLogs.length} logged success, no accepted/rejected broker order`,
      });
    } else {
      if (successLogs.length > took && reject > 0) {
        const n = successLogs.length - took;
        counts.statusDivergence += n;
        mismatches.push({
          class: 'status_divergence', symbol: g.symbol, side: g.side,
          loggedTrades: successLogs, brokerOrders: rejectOrders,
          note: `${successLogs.length} logged success, broker ${took} took + ${reject} rejected → ${n} divergence`,
        });
      }
      if (failedLogs.length > 0 && took > 0) {
        const n = Math.min(failedLogs.length, took);
        counts.falseFailure += n;
        mismatches.push({
          class: 'false_failure', symbol: g.symbol, side: g.side,
          loggedTrades: failedLogs, brokerOrders: tookOrders,
          note: `${failedLogs.length} logged failed, broker has ${took} that took → ${n} false failure`,
        });
      }
    }
  }

  const flagged = mismatches.reduce((a, m) => a + m.loggedTrades.length, 0);
  counts.matched = Math.max(0, logged.length - flagged);
  return { mismatches, counts };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test agent/trade-reconciliation.test.mjs`
Expected: PASS — all Task 1 tests green.

- [ ] **Step 5: Commit**

```bash
git add agent/trade-reconciliation.js agent/trade-reconciliation.test.mjs
git commit -m "feat: pure reconcileTrades matcher (phantom/false-failure/divergence)"
```

---

## Task 2: Windowing, reconcilable filter, broker normalizer, coverage guard

**Files:**
- Modify: `agent/trade-reconciliation.js`
- Test: `agent/trade-reconciliation.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `agent/trade-reconciliation.test.mjs`:

```javascript
import { etDayOf, isReconcilableTrade, normalizeBrokerOrder, assessCoverage } from './trade-reconciliation.js';

test('etDayOf: a 20:00 ET order (next UTC day) maps to the correct ET day', () => {
  // 2026-05-26T20:00 ET (EDT, UTC-4) === 2026-05-27T00:00:00Z. A naive UTC slice
  // would say 2026-05-27; ET conversion must say 2026-05-26.
  assert.equal(etDayOf('2026-05-27T00:00:00.000Z'), '2026-05-26');
});

test('isReconcilableTrade: keeps order placements with a real symbol, drops closes/no-symbol', () => {
  assert.equal(isReconcilableTrade({ type: 'order', tool: 'place_options_order', symbol: 'AMD260717C00510000' }), true);
  assert.equal(isReconcilableTrade({ type: 'order', tool: 'place_managed_position', symbol: 'WMT' }), true);
  assert.equal(isReconcilableTrade({ type: 'close', tool: 'close_managed_position', symbol: 'pos_17793060' }), false);
  assert.equal(isReconcilableTrade({ type: 'order', tool: 'place_buy_order', symbol: '??' }), false);
  assert.equal(isReconcilableTrade({ type: 'order', symbol: '' }), false);
});

test('normalizeBrokerOrder: reads PascalCase Go JSON keys', () => {
  const n = normalizeBrokerOrder({ ID: 'o1', Symbol: 'AMD', Side: 'buy', Status: 'filled', FilledQty: 2, SubmittedAt: '2026-05-26T13:33:02Z', Strategy: 'v2' });
  assert.deepEqual(n, { id: 'o1', symbol: 'AMD', side: 'buy', status: 'filled', filledQty: 2, submittedAt: '2026-05-26T13:33:02Z', strategy: 'v2' });
});

test('assessCoverage: below limit is covered; at limit with oldest after day-start is not', () => {
  const dayStart = '2026-05-26T04:00:00.000Z'; // 00:00 ET (EDT)
  assert.equal(assessCoverage([{ submittedAt: '2026-05-26T13:00:00Z' }], dayStart, 500).covered, true);
  const full = Array.from({ length: 500 }, () => ({ submittedAt: '2026-05-26T18:00:00Z' }));
  assert.equal(assessCoverage(full, dayStart, 500).covered, false);
  const fullEarly = Array.from({ length: 500 }, (_, i) => ({ submittedAt: i === 0 ? '2026-05-26T03:00:00Z' : '2026-05-26T18:00:00Z' }));
  assert.equal(assessCoverage(fullEarly, dayStart, 500).covered, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test agent/trade-reconciliation.test.mjs`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement the helpers**

Add to `agent/trade-reconciliation.js` (import `_etDate` from the trade store to share one ET-day definition):

```javascript
import { _etDate } from './trades-store.js';

// etDayOf returns the America/New_York calendar day (YYYY-MM-DD) for an ISO
// instant, reusing the exact conversion the trade log is bucketed with. Never a
// UTC slice — after-hours orders (up to 20:00 ET) are the next UTC calendar day.
export function etDayOf(iso) {
  return _etDate(new Date(iso));
}

// isReconcilableTrade keeps only order placements that carry a real symbol. v1
// excludes close-type rows (they store a position_id in `symbol`, not a tradable
// symbol) and the '??' placeholder the harness writes when it can't resolve one.
export function isReconcilableTrade(trade) {
  if (!trade || trade.type === 'close') return false;
  const sym = trade.symbol;
  return typeof sym === 'string' && sym.length > 0 && sym !== '??';
}

// normalizeBrokerOrder maps the Go interfaces.Order JSON (PascalCase, no json
// tags) to the lower-camel shape the matcher expects. Lowercase fallbacks guard
// against future json-tag changes.
export function normalizeBrokerOrder(o) {
  return {
    id: o.ID ?? o.id ?? '',
    symbol: o.Symbol ?? o.symbol ?? '',
    side: o.Side ?? o.side ?? '',
    status: o.Status ?? o.status ?? '',
    filledQty: o.FilledQty ?? o.filledQty ?? 0,
    submittedAt: o.SubmittedAt ?? o.submittedAt ?? null,
    strategy: o.Strategy ?? o.strategy ?? '',
  };
}

// assessCoverage detects a truncated fetch: if the returned list hit the server
// limit AND its oldest order was submitted after the ET-day start, the window
// did not reach back far enough to cover the whole day. Returns { covered }.
export function assessCoverage(rawOrders, dayStartIso, limit = 500) {
  const list = Array.isArray(rawOrders) ? rawOrders : [];
  if (list.length < limit) return { covered: true };
  const dayStartMs = new Date(dayStartIso).getTime();
  let oldestMs = Infinity;
  for (const o of list) {
    const ms = new Date(o.submittedAt ?? o.SubmittedAt ?? 0).getTime();
    if (Number.isFinite(ms) && ms < oldestMs) oldestMs = ms;
  }
  return { covered: oldestMs <= dayStartMs };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test agent/trade-reconciliation.test.mjs`
Expected: PASS — Task 1 + Task 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add agent/trade-reconciliation.js agent/trade-reconciliation.test.mjs
git commit -m "feat: ET-day windowing, reconcilable filter, broker normalizer, coverage guard"
```

---

## Task 3: Report writer + reader (injected fs)

**Files:**
- Modify: `agent/trade-reconciliation.js`
- Test: `agent/trade-reconciliation.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `agent/trade-reconciliation.test.mjs`:

```javascript
import { writeReconciliationReport, readReconciliationSummary, SCOPE_NOTE } from './trade-reconciliation.js';

// Minimal in-memory fs covering only the methods used.
function fakeFs() {
  const files = new Map();
  return {
    files,
    async mkdir() {},
    async writeFile(p, data) { files.set(p.replace(/\\/g, '/'), data); },
    async readFile(p) {
      const k = p.replace(/\\/g, '/');
      if (!files.has(k)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files.get(k);
    },
    async readdir(p) {
      const base = p.replace(/\\/g, '/').replace(/\/$/, '') + '/';
      const names = new Set();
      for (const k of files.keys()) if (k.startsWith(base)) names.add(k.slice(base.length).split('/')[0]);
      if (names.size === 0) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return [...names];
    },
  };
}

test('writeReconciliationReport: writes JSON (with mismatchCount + scope) and a scoped .md', async () => {
  const fs = fakeFs();
  const report = { date: '2026-05-26', sandboxId: 'sbx_x', agentName: 'Prophet', strategy: 'v2',
    mismatches: [{ class: 'phantom_success', symbol: 'AMD', side: 'buy', loggedTrades: [{}], brokerOrders: [], note: 'n' }],
    counts: { phantomSuccess: 1, falseFailure: 0, statusDivergence: 0, unresolved: 0, matched: 0, total: 1 } };
  await writeReconciliationReport('/root', report, { fs });
  const json = JSON.parse(fs.files.get('/root/data/reconciliation/sbx_x/2026-05-26.json'));
  assert.equal(json.mismatchCount, 1);
  assert.equal(json.scope, SCOPE_NOTE);
  const md = fs.files.get('/root/data/reconciliation/sbx_x/2026-05-26.md');
  assert.match(md, /Covers order placements/);
});

test('readReconciliationSummary: aggregates across sandbox dirs for the date', async () => {
  const fs = fakeFs();
  const mk = (sid, count) => ({ date: '2026-05-26', sandboxId: sid, agentName: sid, strategy: 'v2',
    mismatches: count ? [{ class: 'phantom_success', symbol: 'AMD', side: 'buy', loggedTrades: [{}], brokerOrders: [], note: 'n' }] : [],
    counts: { phantomSuccess: count, falseFailure: 0, statusDivergence: 0, unresolved: 0, matched: 0, total: count } });
  await writeReconciliationReport('/root', mk('sbx_a', 1), { fs });
  await writeReconciliationReport('/root', mk('sbx_b', 0), { fs });
  const summary = await readReconciliationSummary('/root', { date: '2026-05-26' }, { fs });
  assert.equal(summary.mismatchCount, 1);
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].sandboxId, 'sbx_a');
});

test('readReconciliationSummary: no reports → zero, no throw', async () => {
  const fs = fakeFs();
  const summary = await readReconciliationSummary('/root', { date: '2026-05-26' }, { fs });
  assert.equal(summary.mismatchCount, 0);
  assert.deepEqual(summary.items, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test agent/trade-reconciliation.test.mjs`
Expected: FAIL — writer/reader/SCOPE_NOTE not exported.

- [ ] **Step 3: Implement writer + reader**

Add to `agent/trade-reconciliation.js` (top-level `import path from 'node:path';` and `import nodeFs from 'node:fs/promises';`):

```javascript
import path from 'node:path';
import nodeFs from 'node:fs/promises';

// Stated on every report and the banner so a clean result is not misread as
// "my positions match the broker." v1 checks opens, not closes/positions.
export const SCOPE_NOTE = 'Covers order placements (opens/adds). Does NOT verify closes/exits or live position state — a logged-success close that did not execute will not be caught here.';

function mismatchCountOf(counts) {
  return (counts?.phantomSuccess || 0) + (counts?.falseFailure || 0) + (counts?.statusDivergence || 0);
}

function reportDir(projectRoot, sandboxId) {
  return path.join(projectRoot, 'data', 'reconciliation', sandboxId);
}

// writeReconciliationReport writes <sandboxId>/<date>.json (machine) and .md
// (human). fs is injected for tests; defaults to node:fs/promises.
export async function writeReconciliationReport(projectRoot, report, { fs = nodeFs } = {}) {
  const dir = reportDir(projectRoot, report.sandboxId);
  await fs.mkdir(dir, { recursive: true });
  const mismatchCount = mismatchCountOf(report.counts);
  const json = { ...report, mismatchCount, scope: SCOPE_NOTE, generatedAt: report.generatedAt || new Date().toISOString() };
  await fs.writeFile(path.join(dir, `${report.date}.json`), JSON.stringify(json, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, `${report.date}.md`), renderReportMarkdown(json), 'utf-8');
  return json;
}

function renderReportMarkdown(r) {
  const lines = [
    `# Reconciliation — ${r.agentName || r.sandboxId} — ${r.date}`,
    '',
    `Strategy: \`${r.strategy}\` · Mismatches: **${r.mismatchCount}** · Unresolved: ${r.counts.unresolved} · Matched: ${r.counts.matched}`,
    '',
    `> ${SCOPE_NOTE}`,
    '',
  ];
  if (r.mismatches.length === 0) {
    lines.push('No mismatches.');
  } else {
    for (const m of r.mismatches) {
      lines.push(`- **${m.class}** ${m.symbol} ${m.side} — ${m.note}`);
    }
  }
  return lines.join('\n') + '\n';
}

// readReconciliationSummary reads one sandbox's report (sandboxId given) or
// aggregates across all sandbox dirs for the date. Missing/unparseable reports
// contribute nothing (silent-when-clean). Returns { date, mismatchCount, items }.
export async function readReconciliationSummary(projectRoot, { date, sandboxId } = {}, { fs = nodeFs } = {}) {
  const root = path.join(projectRoot, 'data', 'reconciliation');
  let sandboxIds;
  if (sandboxId) {
    sandboxIds = [sandboxId];
  } else {
    try { sandboxIds = await fs.readdir(root); }
    catch { return { date, mismatchCount: 0, items: [] }; }
  }
  let mismatchCount = 0;
  const items = [];
  for (const sid of sandboxIds) {
    let raw;
    try { raw = await fs.readFile(path.join(root, sid, `${date}.json`), 'utf-8'); }
    catch { continue; }
    let r;
    try { r = JSON.parse(raw); } catch { continue; }
    mismatchCount += r.mismatchCount || 0;
    for (const m of (r.mismatches || [])) {
      items.push({ sandboxId: sid, agentName: r.agentName, ...m });
    }
  }
  return { date, mismatchCount, items };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test agent/trade-reconciliation.test.mjs`
Expected: PASS — Tasks 1-3 green.

- [ ] **Step 5: Commit**

```bash
git add agent/trade-reconciliation.js agent/trade-reconciliation.test.mjs
git commit -m "feat: reconciliation report writer + reader with scope note"
```

---

## Task 4: Per-sandbox runner `runReconciliationForSandbox`

**Files:**
- Modify: `agent/trade-reconciliation.js`
- Test: `agent/trade-reconciliation.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `agent/trade-reconciliation.test.mjs`:

```javascript
import { runReconciliationForSandbox } from './trade-reconciliation.js';

const dayStart = '2026-05-26T04:00:00.000Z';
function deps(overrides = {}) {
  const fs = fakeFs();
  return {
    fs,
    args: {
      goAxios: { get: async () => ({ data: [{ ID: 'o1', Symbol: 'AMD', Side: 'buy', Status: 'filled', FilledQty: 2, SubmittedAt: '2026-05-26T13:33:02Z', Strategy: 'v2' }] }) },
      sandboxId: 'sbx_x', strategy: 'v2', agentName: 'Prophet',
      isoDate: '2026-05-26', dayStartIso: dayStart, projectRoot: '/root',
      readTradesFn: async () => ({ trades: [{ type: 'order', tool: 'place_options_order', symbol: 'AMD', side: 'buy', status: 'failed', timestamp: '2026-05-26T13:33:00Z' }] }),
      fsImpl: fs, limit: 500,
      ...overrides,
    },
  };
}

test('runner: writes a report flagging the false failure', async () => {
  const { fs, args } = deps();
  const report = await runReconciliationForSandbox(args);
  assert.equal(report.counts.falseFailure, 1);
  assert.ok(fs.files.get('/root/data/reconciliation/sbx_x/2026-05-26.json'));
});

test('runner: only reconciles broker orders matching the strategy tag and ET day', async () => {
  const { args } = deps({
    goAxios: { get: async () => ({ data: [
      { ID: 'o1', Symbol: 'AMD', Side: 'buy', Status: 'filled', FilledQty: 2, SubmittedAt: '2026-05-26T13:33:02Z', Strategy: 'penny' }, // wrong strategy
      { ID: 'o2', Symbol: 'AMD', Side: 'buy', Status: 'filled', FilledQty: 2, SubmittedAt: '2026-05-20T13:33:02Z', Strategy: 'v2' },    // wrong day
    ] }) },
    readTradesFn: async () => ({ trades: [{ type: 'order', tool: 'place_options_order', symbol: 'AMD', side: 'buy', status: 'success', timestamp: '2026-05-26T13:33:00Z' }] }),
  });
  const report = await runReconciliationForSandbox(args);
  assert.equal(report.counts.phantomSuccess, 1); // both broker orders filtered out → logged success is phantom
});

test('runner: incomplete coverage → no report written, returns null', async () => {
  const big = Array.from({ length: 500 }, () => ({ ID: 'x', Symbol: 'AMD', Side: 'buy', Status: 'filled', FilledQty: 2, SubmittedAt: '2026-05-26T18:00:00Z', Strategy: 'v2' }));
  const { fs, args } = deps({ goAxios: { get: async () => ({ data: big }) } });
  const report = await runReconciliationForSandbox(args);
  assert.equal(report, null);
  assert.equal(fs.files.size, 0);
});

test('runner: goAxios error → null, no throw', async () => {
  const { args } = deps({ goAxios: { get: async () => { throw new Error('bot down'); } } });
  assert.equal(await runReconciliationForSandbox(args), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test agent/trade-reconciliation.test.mjs`
Expected: FAIL — `runReconciliationForSandbox` not exported.

- [ ] **Step 3: Implement the runner**

Add to `agent/trade-reconciliation.js`:

```javascript
// runReconciliationForSandbox fetches the day's broker orders, applies the
// coverage guard, filters to this sandbox's strategy + ET day, reads the day's
// logged order-placements, reconciles, and writes a report. Soft-fail: returns
// null (no report) on fetch error or incomplete coverage, so the banner stays
// silent rather than wrong. All side-effecting deps are injected for testing.
export async function runReconciliationForSandbox({
  goAxios, sandboxId, strategy, agentName, isoDate, dayStartIso,
  projectRoot, readTradesFn, fsImpl = nodeFs, limit = 500,
}) {
  let raw;
  try {
    const resp = await goAxios.get('/api/v1/orders?status=all', { timeout: 5000 });
    raw = Array.isArray(resp?.data) ? resp.data : [];
  } catch {
    return null; // bot unreachable — soft-fail to silent
  }
  const norm = raw.map(normalizeBrokerOrder);
  if (!assessCoverage(norm, dayStartIso, limit).covered) return null;

  const dayOrders = norm.filter((o) => o.strategy === strategy && o.submittedAt && etDayOf(o.submittedAt) === isoDate);

  let logged = [];
  try {
    const { trades } = await readTradesFn(projectRoot, { from: isoDate, to: isoDate, sandboxId });
    logged = (trades || []).filter(isReconcilableTrade);
  } catch {
    return null;
  }

  const result = reconcileTrades(logged, dayOrders);
  const report = { date: isoDate, sandboxId, agentName, strategy, generatedAt: new Date().toISOString(), ...result };
  await writeReconciliationReport(projectRoot, report, { fs: fsImpl });
  return report;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test agent/trade-reconciliation.test.mjs`
Expected: PASS — Tasks 1-4 green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add agent/trade-reconciliation.js agent/trade-reconciliation.test.mjs
git commit -m "feat: per-sandbox reconciliation runner (fetch, guard, match, write)"
```

---

## Task 5: Scheduler job + server-side cross-sandbox wiring

**Files:**
- Modify: `agent/analysis-scheduler.js` (constructor ~line 195-228, `triggerJob` validJobs ~273-280 and dispatch, `_checkSchedule` ~1090, a `_runTradeReconciliation` method)
- Modify: `agent/server.js` (imports, scheduler construction ~line 140, a `runTradeReconciliationAllSandboxes` function)

- [ ] **Step 1: Add the scheduler state field + injected fn (constructor)**

In `agent/analysis-scheduler.js`, in the constructor, alongside `this._getHealthySandboxUrl = ...` (line 202):

```javascript
    this._runTradeReconciliationFn = options.runTradeReconciliation || null;
```

And alongside the other `_lastXDate` fields (after line 227):

```javascript
    this._lastTradeReconcileDate = null; // YYYY-MM-DD (daily after-close reconciliation)
```

- [ ] **Step 2: Register the job in `triggerJob`**

In the `validJobs` array (line 273-280), add `'trade_reconciliation'`:

```javascript
      'macro_regime_skill', 'breadth_skill', 'market_top_skill', 'bubble_skill',
      'trade_reconciliation',
    ];
```

Add a dispatch branch in `triggerJob` (after the existing `else if` chain, before the final `else`/closing — place it next to another simple job branch):

```javascript
      } else if (jobName === 'trade_reconciliation') {
        this._lastTradeReconcileDate = isoDate;
        await this._runTradeReconciliation(isoDate);
```

- [ ] **Step 3: Add the schedule gate**

In `_checkSchedule`, after the 16:30 loss-check block (ends ~line 1094), add:

```javascript
    // Daily trade-log ↔ broker reconciliation — 4:45 PM ET, after fills settle.
    if (isWeekday && hour === 16 && minute === 45 && this._lastTradeReconcileDate !== isoDate) {
      await this.triggerJob('trade_reconciliation').catch(() => {});
    }
```

- [ ] **Step 4: Add the `_runTradeReconciliation` method**

In `agent/analysis-scheduler.js`, in the `// ── Job runners ──` area (near `_runMacroRegimeSkill`):

```javascript
  // trade_reconciliation: delegates to the injected cross-sandbox runner (it
  // needs per-sandbox goAxios + trade-log access the scheduler does not hold).
  // Soft-fail: the runner reports per-sandbox; a failure leaves no report and
  // the banner stays silent.
  async _runTradeReconciliation(isoDate) {
    this._log(`Starting trade_reconciliation for ${isoDate}...`, 'info');
    this.emit('scheduler_job_start', { job: 'trade_reconciliation', date: isoDate });
    if (typeof this._runTradeReconciliationFn === 'function') {
      await this._runTradeReconciliationFn(isoDate);
    }
    this._log(`trade_reconciliation complete for ${isoDate}.`, 'success');
  }
```

- [ ] **Step 5: Wire the cross-sandbox runner in `server.js`**

In `agent/server.js`, add imports near the other agent-module imports (top of file):

```javascript
import { runReconciliationForSandbox, readReconciliationSummary } from './trade-reconciliation.js';
import nodeFs from 'node:fs/promises';
```

Ensure `readTrades` is imported from the trade store. Find the existing trades-store import (it imports `appendTrade`) and add `readTrades`:

```javascript
import { appendTrade, readTrades } from './trades-store.js';
```

Add this function above the `const scheduler = new AnalysisScheduler({` line (~140), using the `emitConnectFillsSummaries` iteration pattern:

```javascript
// Cross-sandbox reconciliation runner injected into the scheduler. Iterates
// running sandboxes, resolves each one's strategy tag + goAxios, and reconciles
// its trade log against the broker. Untagged agents (no strategyId) are skipped
// — their orders carry no tag to attribute. Soft-fail per sandbox.
async function runTradeReconciliationAllSandboxes(isoDate) {
  const dayStartIso = startOfEtTradingDayIso();
  for (const runtime of orchestrator.runtimes.values()) {
    try {
      const sandboxId = runtime?.harness?.sandboxId;
      if (!sandboxId) continue;
      const resolved = getResolvedAgentForSandbox(sandboxId);
      const strategy = resolved?.strategyId;
      const goAxios = runtime.goAxios;
      if (!strategy || !goAxios) continue;
      await runReconciliationForSandbox({
        goAxios, sandboxId, strategy, agentName: resolved?.name,
        isoDate, dayStartIso, projectRoot: PROJECT_ROOT,
        readTradesFn: readTrades, fsImpl: nodeFs,
      });
    } catch {
      // soft-fail per sandbox — one bot down must not abort the rest
    }
  }
}
```

Add **one new property** to the existing `new AnalysisScheduler({ ... })` call (line ~140) — leave the current `model`, `onEmergencyWake`, and `getHealthySandboxUrl` properties exactly as they are; just append:

```javascript
  // ...existing model / onEmergencyWake / getHealthySandboxUrl options unchanged...
  runTradeReconciliation: runTradeReconciliationAllSandboxes,
});
```

(`startOfEtTradingDayIso` is already imported in server.js for the fills summary, so no new import is needed for it.)

- [ ] **Step 6: Verify the scheduler still loads + full suite passes**

Run: `node --check agent/analysis-scheduler.js` then `node --check agent/server.js`
Expected: no syntax errors.

Run: `npm test`
Expected: PASS — 556+ existing tests still pass (the new module's tests included).

- [ ] **Step 7: Commit**

```bash
git add agent/analysis-scheduler.js agent/server.js
git commit -m "feat: schedule daily trade_reconciliation + wire cross-sandbox runner"
```

---

## Task 6: Read API — `GET /api/reconciliation`

**Files:**
- Modify: `agent/server.js` (add route near the `/api/trades` route ~line 736)

- [ ] **Step 1: Add the route**

In `agent/server.js`, after the `/api/trades` route handler, add:

```javascript
// Reconciliation summary for a date (default: today ET). Aggregates across
// sandboxes unless ?sandboxId= is given. Returns { date, mismatchCount, items }.
app.get('/api/reconciliation', async (req, res) => {
  const _etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = _etFmt.format(new Date());
  const date = String(req.query.date || today);
  const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const summary = await readReconciliationSummary(PROJECT_ROOT, { date, sandboxId }, { fs: nodeFs });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Manual verification of the route**

Write a scratch report and read it back through the running server:

1. Create `data/reconciliation/sbx_test/2020-01-02.json`:

```json
{"date":"2020-01-02","sandboxId":"sbx_test","agentName":"Prophet","strategy":"v2","mismatchCount":1,"scope":"Covers order placements (opens/adds). Does NOT verify closes/exits or live position state — a logged-success close that did not execute will not be caught here.","counts":{"phantomSuccess":1,"falseFailure":0,"statusDivergence":0,"unresolved":0,"matched":0,"total":1},"mismatches":[{"class":"phantom_success","symbol":"QQQ260717C00730000","side":"buy","loggedTrades":[{"symbol":"QQQ260717C00730000","status":"success"}],"brokerOrders":[],"note":"1 logged success, no accepted/rejected broker order"}]}
```

2. Start the server: `npm run agent`
3. `curl "http://localhost:<port>/api/reconciliation?date=2020-01-02"`
   Expected: `{"date":"2020-01-02","mismatchCount":1,"items":[{"sandboxId":"sbx_test",...,"class":"phantom_success","symbol":"QQQ260717C00730000",...}]}`
4. `curl "http://localhost:<port>/api/reconciliation?date=2020-01-03"` → `{"date":"2020-01-03","mismatchCount":0,"items":[]}`
5. `curl "http://localhost:<port>/api/reconciliation?date=bad"` → 400.
6. Remove the scratch dir: `data/reconciliation/sbx_test/`.

- [ ] **Step 3: Commit**

```bash
git add agent/server.js
git commit -m "feat: GET /api/reconciliation read route"
```

---

## Task 7: Trades-tab banner

**Files:**
- Modify: `agent/public/index.html` (CSS ~line 974; panel markup ~line 1174; seed path ~line 2576)

- [ ] **Step 1: Add CSS for the banner**

In `agent/public/index.html`, after the `.trades-filter-count` CSS (line 976), add:

```css
    .trades-recon-banner {
      display: none; align-items: center; gap: 10px; margin-bottom: 12px; padding: 8px 12px;
      border: 1px solid var(--error); border-left: 3px solid var(--error); border-radius: 4px;
      background: var(--surface-2, transparent); font-size: 13px; color: var(--ink);
    }
    .trades-recon-banner.is-shown { display: flex; }
    .trades-recon-banner .recon-detail { cursor: pointer; text-decoration: underline; color: var(--accent); }
    .trades-recon-banner .recon-dismiss { margin-left: auto; cursor: pointer; color: var(--ink-faint); border: none; background: none; font-size: 14px; }
    .trades-recon-items { display: none; font-size: 12px; color: var(--ink-muted); margin-bottom: 12px; font-family: 'IBM Plex Mono', monospace; }
    .trades-recon-items.is-shown { display: block; }
    .trades-recon-items .recon-scope { color: var(--ink-faint); margin-top: 6px; }
```

- [ ] **Step 2: Add the banner markup**

In the Trades panel, immediately before `<div id="trades-feed">` (line 1175), add:

```html
        <div class="trades-recon-banner" id="trades-recon-banner">
          <span id="trades-recon-summary"></span>
          <span class="recon-detail" id="trades-recon-toggle">details</span>
          <button class="recon-dismiss" id="trades-recon-dismiss" title="Dismiss">&times;</button>
        </div>
        <div class="trades-recon-items" id="trades-recon-items"></div>
```

- [ ] **Step 3: Add the fetch + render, called from the seed path**

In `agent/public/index.html`, add a function near `seedTodayTrades` (line 2576) and call it from there:

```javascript
async function loadReconciliationBanner() {
  const banner = document.getElementById('trades-recon-banner');
  if (!banner) return;
  try {
    const date = _todayEt();
    const res = await fetch('/api/reconciliation?date=' + encodeURIComponent(date));
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.mismatchCount) return; // silent when clean
    const noun = data.mismatchCount === 1 ? 'mismatch' : 'mismatches';
    document.getElementById('trades-recon-summary').textContent =
      `⚠ ${data.mismatchCount} possible broker ${noun} on ${data.date}`;
    const itemsEl = document.getElementById('trades-recon-items');
    itemsEl.innerHTML =
      (data.items || []).map(m =>
        '<div>' + esc((m.agentName || m.sandboxId || '') + ': ') + esc(m.class) + ' ' +
        esc(m.symbol || '') + ' ' + esc(m.side || '') + ' — ' + esc(m.note || '') + '</div>'
      ).join('') +
      '<div class="recon-scope">Covers order placements (opens/adds). Does NOT verify closes/exits or live position state.</div>';
    banner.classList.add('is-shown');
    document.getElementById('trades-recon-toggle').onclick = () => itemsEl.classList.toggle('is-shown');
    document.getElementById('trades-recon-dismiss').onclick = () => {
      banner.classList.remove('is-shown');
      itemsEl.classList.remove('is-shown');
    };
  } catch (err) {
    console.warn('loadReconciliationBanner failed:', err);
  }
}
```

In `seedTodayTrades`, add the call (it runs on Trades-tab load):

```javascript
async function seedTodayTrades() {
  try {
    const today = _todayEt();
    const data = await fetchTrades(today, today);
    renderTradesBulk(data.trades);
  } catch (err) {
    console.warn('seedTodayTrades failed:', err);
  }
  loadReconciliationBanner();
}
```

- [ ] **Step 4: Manual verification with a synthetic report**

1. Create `data/reconciliation/sbx_test/<TODAY-ET>.json` (use today's ET date as the filename and `date`) with `mismatchCount: 2` and two `mismatches` entries (reuse the Task 6 JSON shape; set two items, e.g. a `phantom_success` and a `status_divergence`).
2. Start the server (`npm run agent`), open the dashboard, go to the **Trades** tab.
3. Confirm: a red-bordered banner reads "⚠ 2 possible broker mismatches on \<today\>"; clicking **details** expands the two items and the scope line; **×** dismisses it.
4. Set `mismatchCount: 0` (and empty `mismatches`) → reload → confirm **no banner** appears.
5. Remove `data/reconciliation/sbx_test/`.

- [ ] **Step 5: Commit**

```bash
git add agent/public/index.html
git commit -m "feat: day-level reconciliation banner in the Trades tab"
```

---

## Self-Review Notes

- **Spec coverage:** matcher + three classes + terminal/non-terminal (Task 1) ↔ §Components.1; ET-day windowing + reconcilable filter + normalizer + coverage guard (Task 2) ↔ §Day windowing, §Components.1, §2 guard; report writer/reader + scope note (Task 3) ↔ §Components.3/§3; per-sandbox runner with attribution + soft-fail (Task 4) ↔ §Components.2; scheduler after-close gate + cross-sandbox wiring + untagged-skip (Task 5) ↔ §Components.2; read API (Task 6) ↔ §Components.4; banner, silent-when-clean, scope line (Task 7) ↔ §Components.5. Non-goals honored: no orphan-broker detection (matcher only walks from logged trades), no close reconciliation (`isReconcilableTrade` drops closes), no Go change, no per-card verdicts.
- **Placeholder scan:** none — every code step is complete; manual-verification steps give exact commands and synthetic fixtures.
- **Type consistency:** `reconcileTrades` → `{ mismatches, counts }` with `counts.{phantomSuccess,falseFailure,statusDivergence,unresolved,matched,total}`; writer adds top-level `mismatchCount` + `scope`; reader returns `{ date, mismatchCount, items }`; runner returns the report object or `null`. Broker shape `{id,symbol,side,status,filledQty,submittedAt,strategy}` consistent across normalizer, matcher, and runner. `isReconcilableTrade`/`etDayOf`/`assessCoverage`/`classifyBrokerStatus` names consistent between tests and implementation.
