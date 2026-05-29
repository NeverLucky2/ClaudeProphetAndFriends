import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _etDate } from './cost-store.js';

test('_etDate returns YYYY-MM-DD in America/New_York', () => {
  // 2026-05-28 14:32:11 UTC is 2026-05-28 10:32 EDT
  assert.equal(_etDate(new Date('2026-05-28T14:32:11.000Z')), '2026-05-28');
});

test('_etDate handles UTC-midnight that is still previous ET day', () => {
  // 2026-05-29 00:30 UTC is 2026-05-28 20:30 EDT
  assert.equal(_etDate(new Date('2026-05-29T00:30:00.000Z')), '2026-05-28');
});

test('_etDate handles UTC-noon that is morning ET (no boundary)', () => {
  // 2026-01-15 17:00 UTC is 2026-01-15 12:00 EST (DST off)
  assert.equal(_etDate(new Date('2026-01-15T17:00:00.000Z')), '2026-01-15');
});

test('_etDate handles DST spring-forward day', () => {
  // 2026-03-08 07:00 UTC is 2026-03-08 02:00 EST → spring forward at 02:00 → 03:00 EDT
  // The date is unambiguously 2026-03-08
  assert.equal(_etDate(new Date('2026-03-08T07:00:00.000Z')), '2026-03-08');
});

import { recordBeat, readDay } from './cost-store.js';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function tmpRoot() {
  return await mkdtemp(path.join(tmpdir(), 'cost-store-test-'));
}

test('recordBeat first write creates directory + file with one row', async () => {
  const root = await tmpRoot();
  try {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1',
      agentId: 'default', agentName: 'Prophet', model: 'sonnet',
      phase: 'midday',
      cost: 1.2345, input: 1000, output: 500, reasoning: 0,
      cacheRead: 4000, cacheWrite: 100,
      beatStartAt: '2026-05-28T14:32:11.000Z',
    });
    const day = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(day.schemaVersion, 1);
    assert.equal(day.date, '2026-05-28');
    assert.equal(day.rows.length, 1);
    const row = day.rows[0];
    assert.equal(row.sandboxId, 'sbx1');
    assert.equal(row.agentId, 'default');
    assert.equal(row.agentName, 'Prophet');
    assert.equal(row.model, 'sonnet');
    assert.equal(row.phase, 'midday');
    assert.equal(row.cost, 1.2345);
    assert.equal(row.input, 1000);
    assert.equal(row.output, 500);
    assert.equal(row.reasoning, 0);
    assert.equal(row.cacheRead, 4000);
    assert.equal(row.cacheWrite, 100);
    assert.equal(row.beatCount, 1);
    assert.equal(row.firstBeatAt, '2026-05-28T14:32:11.000Z');
    assert.ok(row.lastBeatAt >= row.firstBeatAt, `lastBeatAt (${row.lastBeatAt}) should be at or after firstBeatAt`);
    // lastBeatAt is "now" at write time, so it should be a valid ISO string from after beatStartAt
    assert.match(row.lastBeatAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordBeat throws clear error on invalid beatStartAt', async () => {
  const root = await tmpRoot();
  try {
    await assert.rejects(
      recordBeat(root, {
        accountId: 'acc1', sandboxId: 'sbx1', agentId: 'a',
        agentName: 'A', model: 'm', phase: 'midday',
        cost: 1.0, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0,
        beatStartAt: 'not a valid ISO',
      }),
      /invalid beatStartAt/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordBeat second beat accumulates into existing row', async () => {
  const root = await tmpRoot();
  try {
    const beat1 = {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'default',
      agentName: 'Prophet', model: 'sonnet', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 200, cacheWrite: 10,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    };
    const beat2 = { ...beat1,
      cost: 0.5, input: 50, output: 25, reasoning: 0, cacheRead: 100, cacheWrite: 5,
      beatStartAt: '2026-05-28T14:05:00.000Z',
    };
    await recordBeat(root, beat1);
    await recordBeat(root, beat2);
    const day = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(day.rows.length, 1, 'should upsert, not append');
    const row = day.rows[0];
    assert.equal(row.cost, 1.5);
    assert.equal(row.input, 150);
    assert.equal(row.output, 75);
    assert.equal(row.cacheRead, 300);
    assert.equal(row.cacheWrite, 15);
    assert.equal(row.beatCount, 2);
    assert.equal(row.firstBeatAt, '2026-05-28T14:00:00.000Z', 'firstBeatAt preserved');
    // lastBeatAt is "now" — assert it advanced past firstBeatAt
    assert.ok(row.lastBeatAt > row.firstBeatAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordBeat different phases on same sandbox are independent rows', async () => {
  const root = await tmpRoot();
  try {
    const base = {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'default',
      agentName: 'Prophet', model: 'sonnet',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    };
    await recordBeat(root, { ...base, phase: 'midday' });
    await recordBeat(root, { ...base, phase: 'pre_market' });
    const day = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(day.rows.length, 2);
    const phases = day.rows.map(r => r.phase).sort();
    assert.deepEqual(phases, ['midday', 'pre_market']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordBeat different sandboxes on same day are independent rows', async () => {
  const root = await tmpRoot();
  try {
    const base = {
      accountId: 'acc1', agentId: 'default', agentName: 'Prophet',
      model: 'sonnet', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    };
    await recordBeat(root, { ...base, sandboxId: 'sbx1' });
    await recordBeat(root, { ...base, sandboxId: 'sbx2' });
    const day = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(day.rows.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordBeat sorts rows by (sandboxId, agentId, phase) on every write', async () => {
  const root = await tmpRoot();
  try {
    const base = {
      accountId: 'acc1', agentName: 'X', model: 'sonnet',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    };
    // Insert out of order
    await recordBeat(root, { ...base, sandboxId: 'sbx_z', agentId: 'b', phase: 'midday' });
    await recordBeat(root, { ...base, sandboxId: 'sbx_a', agentId: 'a', phase: 'pre_market' });
    await recordBeat(root, { ...base, sandboxId: 'sbx_a', agentId: 'a', phase: 'midday' });
    const day = await readDay(root, 'acc1', '2026-05-28');
    const keys = day.rows.map(r => `${r.sandboxId}|${r.agentId}|${r.phase}`);
    assert.deepEqual(keys, [
      'sbx_a|a|midday',
      'sbx_a|a|pre_market',
      'sbx_z|b|midday',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic write: simulated rename failure leaves existing file intact', async () => {
  const root = await tmpRoot();
  try {
    // First beat lands successfully
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'a', agentName: 'A',
      model: 'm', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    });
    const before = await readDay(root, 'acc1', '2026-05-28');

    // Patch fs.rename to throw, then attempt a second beat
    const fsmod = await import('node:fs/promises');
    const realRename = fsmod.default.rename;
    fsmod.default.rename = async () => { throw new Error('simulated EIO'); };
    let threw = false;
    try {
      await recordBeat(root, {
        accountId: 'acc1', sandboxId: 'sbx1', agentId: 'a', agentName: 'A',
        model: 'm', phase: 'midday',
        cost: 99.0, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0,
        beatStartAt: '2026-05-28T14:05:00.000Z',
      });
    } catch { threw = true; }
    fsmod.default.rename = realRename;

    assert.ok(threw, 'recordBeat should propagate write errors');
    const after = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(after.rows[0].cost, before.rows[0].cost, 'existing file unchanged on rename failure');
    assert.equal(after.rows[0].beatCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readDay returns null for missing file', async () => {
  const root = await tmpRoot();
  try {
    const day = await readDay(root, 'noacc', '2026-05-28');
    assert.equal(day, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readDay returns null and warns once for corrupt JSON', async () => {
  const root = await tmpRoot();
  try {
    const dir = path.join(root, 'data', 'sandboxes', 'acc1', 'costs');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2026-05-28.json'), '{not json');

    const warnings = [];
    const logger = (msg) => warnings.push(msg);

    const r1 = await readDay(root, 'acc1', '2026-05-28', { logger });
    const r2 = await readDay(root, 'acc1', '2026-05-28', { logger });
    assert.equal(r1, null);
    assert.equal(r2, null);
    assert.equal(warnings.length, 1, 'warn exactly once per file per process');
    assert.match(warnings[0], /corrupt/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readDay returns null and warns for unknown schemaVersion', async () => {
  const root = await tmpRoot();
  try {
    const dir = path.join(root, 'data', 'sandboxes', 'acc1', 'costs');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2026-05-28.json'),
      JSON.stringify({ schemaVersion: 999, date: '2026-05-28', rows: [] }));
    const warnings = [];
    const r = await readDay(root, 'acc1', '2026-05-28', { logger: (m) => warnings.push(m) });
    assert.equal(r, null);
    assert.match(warnings[0], /schema/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { readRange } from './cost-store.js';

async function seedThreeDays(root) {
  for (const [date, sbx] of [
    ['2026-05-26', 'sbx1'],
    ['2026-05-27', 'sbx1'],
    ['2026-05-27', 'sbx2'],
    ['2026-05-28', 'sbx1'],
  ]) {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: sbx, agentId: 'a', agentName: 'A',
      model: 'm', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: `${date}T18:00:00.000Z`,  // 18:00Z = 14:00 EDT
    });
  }
}

test('readRange returns days inclusive, newest last', async () => {
  const root = await tmpRoot();
  try {
    await seedThreeDays(root);
    const result = await readRange(root, { from: '2026-05-26', to: '2026-05-28' });
    const dates = result.map(d => d.date);
    assert.deepEqual(dates, ['2026-05-26', '2026-05-27', '2026-05-28']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readRange skips missing days entirely (no empty entry)', async () => {
  const root = await tmpRoot();
  try {
    // Only seed 2026-05-28
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'a', agentName: 'A',
      model: 'm', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T18:00:00.000Z',
    });
    const result = await readRange(root, { from: '2026-05-26', to: '2026-05-28' });
    assert.equal(result.length, 1);
    assert.equal(result[0].date, '2026-05-28');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readRange sandboxId filter limits returned rows', async () => {
  const root = await tmpRoot();
  try {
    await seedThreeDays(root);
    const result = await readRange(root, {
      from: '2026-05-26', to: '2026-05-28', sandboxId: 'sbx2',
    });
    const sandboxIds = result.flatMap(d => d.rows.map(r => r.sandboxId));
    assert.deepEqual(new Set(sandboxIds), new Set(['sbx2']));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readRange iterates all accounts when accountId not specified', async () => {
  const root = await tmpRoot();
  try {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'a', agentName: 'A',
      model: 'm', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T18:00:00.000Z',
    });
    await recordBeat(root, {
      accountId: 'acc2', sandboxId: 'sbx9', agentId: 'b', agentName: 'B',
      model: 'm', phase: 'midday',
      cost: 2.0, input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T18:00:00.000Z',
    });
    const result = await readRange(root, { from: '2026-05-28', to: '2026-05-28' });
    assert.equal(result.length, 1);
    assert.equal(result[0].rows.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { aggregateByAgent } from './cost-store.js';

test('aggregateByAgent empty input returns empty object', () => {
  assert.deepEqual(aggregateByAgent([]), {});
});

test('aggregateByAgent groups by agentId, preserves agentName + model', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'sonnet',
        phase: 'midday', cost: 1.0, input: 100, output: 50, reasoning: 0,
        cacheRead: 200, cacheWrite: 10, beatCount: 2 },
    ]},
  ];
  const agg = aggregateByAgent(rangeData);
  assert.ok(agg.default, 'agent key present');
  assert.equal(agg.default.agentName, 'Prophet');
  assert.equal(agg.default.model, 'sonnet');
  assert.ok(agg.default.dates['2026-05-28']);
  assert.equal(agg.default.dates['2026-05-28'].cost, 1.0);
  assert.equal(agg.default.dates['2026-05-28'].tokens, 100 + 50 + 200 + 10);
  assert.equal(agg.default.dates['2026-05-28'].beatCount, 2);
  assert.equal(agg.default.dates['2026-05-28'].phases.midday.cost, 1.0);
});

test('aggregateByAgent sums phases within an agent-day and across days', () => {
  const rangeData = [
    { date: '2026-05-27', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 1.0, input: 100, output: 50, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'pre_market', cost: 0.5, input: 50, output: 25, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
    ]},
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 2.0, input: 200, output: 100, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 2 },
    ]},
  ];
  const agg = aggregateByAgent(rangeData);
  assert.equal(agg.default.dates['2026-05-27'].cost, 1.5);
  assert.equal(agg.default.dates['2026-05-27'].beatCount, 2);
  assert.equal(Object.keys(agg.default.dates['2026-05-27'].phases).length, 2);
  assert.equal(agg.default.dates['2026-05-28'].cost, 2.0);
});

test('aggregateByAgent groups multiple agents separately', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 1.0, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
      { sandboxId: 'sbx2', agentId: 'penny-prophet', agentName: 'Spark', model: 'm',
        phase: 'midday', cost: 0.5, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
    ]},
  ];
  const agg = aggregateByAgent(rangeData);
  assert.deepEqual(Object.keys(agg).sort(), ['default', 'penny-prophet']);
});
