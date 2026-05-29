import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeDailyCostReport } from './analysis-scheduler.js';
import { recordBeat } from './cost-store.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('writeDailyCostReport produces data/reports/cost_{date}.md from seeded data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cost-report-test-'));
  try {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'default',
      agentName: 'Prophet', model: 'sonnet', phase: 'midday',
      cost: 3.18, input: 100000, output: 50000, reasoning: 0,
      cacheRead: 200000, cacheWrite: 5000,
      beatStartAt: '2026-05-28T18:00:00.000Z',
    });
    await writeDailyCostReport(root, '2026-05-28');
    const md = await readFile(path.join(root, 'data', 'reports', 'cost_2026-05-28.md'), 'utf-8');
    assert.match(md, /Daily Cost Report — 2026-05-28/);
    assert.match(md, /Prophet/);
    assert.match(md, /\$3\.18/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeDailyCostReport still writes file when there is no data (empty totals)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cost-report-test-empty-'));
  try {
    await writeDailyCostReport(root, '2026-05-28');
    const md = await readFile(path.join(root, 'data', 'reports', 'cost_2026-05-28.md'), 'utf-8');
    assert.match(md, /Daily Cost Report — 2026-05-28/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
