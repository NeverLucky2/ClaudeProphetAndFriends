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
