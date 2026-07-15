import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffOrphanAlerts, makeOrphanPoller } from './orphan-poll.js';

test('newly-detected orphan is reported once, not while it persists', () => {
  const snap1 = { orphans: [{ symbol: 'UNH' }], last_actions: [] };
  const d1 = diffOrphanAlerts(new Set(), snap1);
  assert.deepEqual(d1.newlyDetected, ['UNH']);

  // Same orphan still present next poll → not newly-detected again.
  const d2 = diffOrphanAlerts(new Set(['UNH']), snap1);
  assert.deepEqual(d2.newlyDetected, []);
});

test('a resolved-then-recurring orphan re-alerts', () => {
  const empty = { orphans: [], last_actions: [] };
  const withUNH = { orphans: [{ symbol: 'UNH' }], last_actions: [] };
  const resolved = diffOrphanAlerts(new Set(['UNH']), empty);
  assert.deepEqual(resolved.resolved, ['UNH']);
  const recurs = diffOrphanAlerts(new Set(), withUNH);
  assert.deepEqual(recurs.newlyDetected, ['UNH']);
});

test('flatten actions surface success/failure, carrying at/order_id identity', () => {
  const snap = {
    orphans: [],
    last_actions: [
      { symbol: 'UNH', success: true, at: '2026-07-14T10:00:00Z', order_id: 'ord_1' },
      { symbol: 'MO', success: false, at: '2026-07-14T10:05:00Z' },
    ],
  };
  const d = diffOrphanAlerts(new Set(), snap);
  assert.deepEqual(d.flattenEvents, [
    { symbol: 'UNH', success: true, at: '2026-07-14T10:00:00Z', order_id: 'ord_1' },
    { symbol: 'MO', success: false, at: '2026-07-14T10:05:00Z', order_id: undefined },
  ]);
});

test('poller pushes once per new orphan and exposes the aggregate', async () => {
  const notifications = [];
  const snapshot = { orphans: [{ symbol: 'UNH' }], last_actions: [] };
  const runtime = { harness: { sandboxId: 'sbx_x' }, goAxios: { get: async () => ({ data: snapshot }) } };
  const p = makeOrphanPoller({
    runtimes: () => [runtime],
    resolveAgent: () => ({}),
    notify: (event, text, sandboxId) => notifications.push({ event, sandboxId }),
    logger: () => {},
  });
  await p.pollOnce();
  await p.pollOnce(); // second poll: same orphan, must NOT re-alert
  const detected = notifications.filter(n => n.event === 'orphanDetected');
  assert.equal(detected.length, 1, 'orphanDetected must fire once, not per poll');
  assert.ok(p.getAggregate().sbx_x, 'aggregate exposes the snapshot');
});

test('makeOrphanPoller: ring-replay of the same action dedups, a later occurrence with a new `at` re-alerts', async () => {
  const notifications = [];
  let snapshot = { orphans: [], last_actions: [{ symbol: 'MO', success: false, at: '2026-07-15T14:00:00Z' }] };
  const runtime = { harness: { sandboxId: 'sbx_mo' }, goAxios: { get: async () => ({ data: snapshot }) } };
  const p = makeOrphanPoller({
    runtimes: () => [runtime],
    notify: (event, text, sandboxId) => notifications.push({ event, sandboxId }),
    logger: () => {},
  });

  await p.pollOnce(); // poll 1: first occurrence of the failure — alerts
  await p.pollOnce(); // poll 2: Go ring replays the SAME action (same `at`) — must NOT re-alert

  // poll 3: a genuinely new occurrence weeks later — distinct `at` — must re-alert
  snapshot = { orphans: [], last_actions: [{ symbol: 'MO', success: false, at: '2026-07-20T14:00:00Z' }] };
  await p.pollOnce();

  const failed = notifications.filter(n => n.event === 'orphanFlattenFailed');
  assert.equal(failed.length, 2, 'ring replay of the same `at` must dedup; a new `at` occurrence must produce a second alert');
});

test('makeOrphanPoller: fail-then-succeed for the same symbol both alert (distinct success, distinct at)', async () => {
  const notifications = [];
  let snapshot = { orphans: [], last_actions: [{ symbol: 'MO', success: false, at: '2026-07-15T14:00:00Z' }] };
  const runtime = { harness: { sandboxId: 'sbx_mo2' }, goAxios: { get: async () => ({ data: snapshot }) } };
  const p = makeOrphanPoller({
    runtimes: () => [runtime],
    notify: (event, text, sandboxId) => notifications.push({ event, sandboxId }),
    logger: () => {},
  });

  await p.pollOnce(); // flatten attempt fails
  snapshot = { orphans: [], last_actions: [{ symbol: 'MO', success: true, at: '2026-07-15T14:05:00Z', order_id: 'ord_2' }] };
  await p.pollOnce(); // retried flatten succeeds — distinct success AND distinct `at`

  const failedCount = notifications.filter(n => n.event === 'orphanFlattenFailed').length;
  const succeededCount = notifications.filter(n => n.event === 'orphanFlattened').length;
  assert.equal(failedCount, 1, 'the failure must have alerted');
  assert.equal(succeededCount, 1, 'the subsequent success must also alert, not be swallowed by the failure key');
});
