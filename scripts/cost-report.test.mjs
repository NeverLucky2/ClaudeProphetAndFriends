import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordBeat } from '../agent/cost-store.js';

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      ['scripts/cost-report.mjs', ...args],
      { env: { ...process.env, ...env } }
    );
    let out = '', err = '';
    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { err += c; });
    proc.on('exit', code => resolve({ code, out, err }));
    proc.on('error', reject);
  });
}

test('cost-report.mjs --format json emits valid JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cost-cli-test-'));
  try {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'default',
      agentName: 'Prophet', model: 'sonnet', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0,
      cacheRead: 200, cacheWrite: 10,
      beatStartAt: new Date().toISOString(),
    });
    const { code, out } = await runCli(['--days', '7', '--format', 'json'],
      { COST_REPORT_PROJECT_ROOT: root });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.ok(parsed.agents);
    assert.ok(parsed.from);
    assert.ok(parsed.to);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cost-report.mjs --format markdown emits a markdown header', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cost-cli-md-test-'));
  try {
    const { code, out } = await runCli(['--days', '7', '--format', 'markdown'],
      { COST_REPORT_PROJECT_ROOT: root });
    assert.equal(code, 0);
    assert.match(out, /# Daily Cost Report/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
