import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCostsResponse } from './cost-store.js';

test('buildCostsResponse shape: from/to/agents/totals', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 3.18, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 95 },
    ]},
  ];
  const res = buildCostsResponse(rangeData, 7, '2026-05-28');
  assert.equal(res.from, '2026-05-22');
  assert.equal(res.to, '2026-05-28');
  assert.equal(res.agents.length, 1);
  assert.equal(res.agents[0].agentId, 'default');
  assert.equal(res.agents[0].today.cost, 3.18);
  assert.equal(res.agents[0].sparkline.length, 7, 'sparkline length matches days');
  assert.equal(res.agents[0].sparkline[6], 3.18, 'last sparkline entry is today');
  assert.equal(res.agents[0].sparkline[0], 0, 'missing pre-history day is 0');
  assert.ok(res.totals.today.cost > 0);
});

test('buildCostsResponse delta is null when 7d avg is 0', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 1.0, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
    ]},
  ];
  const res = buildCostsResponse(rangeData, 7, '2026-05-28');
  assert.equal(res.agents[0].delta.costPct, null);
});

test('buildCostsResponse phasesToday has all phases with cost > 0 today', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 1.0, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'pre_market', cost: 0.5, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
    ]},
  ];
  const res = buildCostsResponse(rangeData, 7, '2026-05-28');
  assert.deepEqual(
    new Set(Object.keys(res.agents[0].phasesToday)),
    new Set(['midday', 'pre_market']),
  );
});
