import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let cfgStore, credStore, tmpDir, configPath, secretsPath, backupDir, sandboxesRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-v9-'));
  configPath = path.join(tmpDir, 'agent-config.json');
  secretsPath = path.join(tmpDir, 'accounts-secrets.json');
  backupDir = path.join(tmpDir, 'backups');
  sandboxesRoot = path.join(tmpDir, 'sandboxes');
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  credStore = await import('./credential-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot });
  credStore = cfgStore._setCredStoreForTests(credStore);
});

function v8WithPenny() {
  return {
    schemaVersion: 8,
    accounts: [],
    agents: [
      { id: 'default', name: 'Prophet', strategyId: 'v2-options' },
      { id: 'harvest', name: 'Harvest', strategyId: 'harvest' },
      { id: 'penny-prophet', name: 'Spark', strategyId: 'penny-momentum' },
      { id: 'mean-rev', name: 'Coil', strategyId: 'mean-rev-rsi2' },
      { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend' },
      { id: 'drift', name: 'Drift', strategyId: 'earnings-drift' },
      { id: 'defensive-prophet', name: 'DefensiveProphet', strategyId: 'prophet-defensive' },
    ],
    strategies: [
      { id: 'v2-options', name: 'Aggressive Options v2' },
      { id: 'penny-momentum', name: 'Penny Stock Momentum' },
      { id: 'trend', name: 'Multi-Asset Trend Following' },
    ],
    sandboxes: {
      sbx_keep: { id: 'sbx_keep', accountId: 'acct', agent: { activeAgentId: 'default', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {} },
      sbx_1b6dc838: { id: 'sbx_1b6dc838', accountId: 'acct', agent: { activeAgentId: 'penny-prophet', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {} },
    },
    models: [],
  };
}

test('v8→v9 removes the penny agent, strategy, and Spark sandbox; bumps version', async () => {
  await fs.writeFile(configPath, JSON.stringify(v8WithPenny()));
  const cfg = await cfgStore.loadConfig();
  assert.equal(cfg.schemaVersion, 9);
  assert.equal(cfg.agents.find(a => a.id === 'penny-prophet'), undefined);
  assert.equal(cfg.strategies.find(s => s.id === 'penny-momentum'), undefined);
  assert.equal(cfg.sandboxes.sbx_1b6dc838, undefined);
});

test('v8→v9 leaves the six surviving agents + the non-penny sandbox intact', async () => {
  await fs.writeFile(configPath, JSON.stringify(v8WithPenny()));
  const cfg = await cfgStore.loadConfig();
  for (const id of ['default', 'harvest', 'mean-rev', 'trend-prophet', 'drift', 'defensive-prophet']) {
    assert.ok(cfg.agents.find(a => a.id === id), `${id} survives`);
  }
  assert.ok(cfg.sandboxes.sbx_keep, 'non-penny sandbox survives');
});

test('v8→v9 does NOT re-add penny from defaults via mergeMissingDefaults', async () => {
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 8, accounts: [], agents: [], strategies: [], sandboxes: {}, models: [] }));
  const cfg = await cfgStore.loadConfig();
  assert.equal(cfg.agents.find(a => a.id === 'penny-prophet'), undefined);
  assert.equal(cfg.strategies.find(s => s.id === 'penny-momentum'), undefined);
});

test('v8→v9 is idempotent — reloading a v9 config is a no-op', async () => {
  await fs.writeFile(configPath, JSON.stringify(v8WithPenny()));
  await cfgStore.loadConfig();
  const afterFirst = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  assert.equal(afterFirst.schemaVersion, 9);
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot });
  credStore = cfgStore._setCredStoreForTests(credStore);
  const cfg2 = await cfgStore.loadConfig();
  assert.equal(cfg2.schemaVersion, 9);
  assert.equal(cfg2.agents.find(a => a.id === 'penny-prophet'), undefined);
});
