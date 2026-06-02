import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let cfgStore, credStore, tmpDir, configPath, secretsPath, backupDir, sandboxesRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-v10-'));
  configPath = path.join(tmpDir, 'agent-config.json');
  secretsPath = path.join(tmpDir, 'accounts-secrets.json');
  backupDir = path.join(tmpDir, 'backups');
  sandboxesRoot = path.join(tmpDir, 'sandboxes');
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  credStore = await import('./credential-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot });
  credStore = cfgStore._setCredStoreForTests(credStore);
});

function v9WithHarvest() {
  return {
    schemaVersion: 9,
    accounts: [],
    agents: [
      { id: 'default', name: 'Prophet', strategyId: 'v2-options' },
      { id: 'harvest', name: 'Harvest', strategyId: 'harvest' },
      { id: 'mean-rev', name: 'Coil', strategyId: 'mean-rev-rsi2' },
      { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend' },
      { id: 'drift', name: 'Drift', strategyId: 'earnings-drift' },
      { id: 'defensive-prophet', name: 'DefensiveProphet', strategyId: 'prophet-defensive' },
    ],
    strategies: [
      { id: 'v2-options', name: 'Aggressive Options v2' },
      { id: 'harvest', name: 'Harvest — Iron Condor Premium Seller' },
      { id: 'trend', name: 'Multi-Asset Trend Following' },
    ],
    sandboxes: {
      sbx_keep: { id: 'sbx_keep', accountId: 'acct', agent: { activeAgentId: 'default', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {} },
      sbx_449fedf6: { id: 'sbx_449fedf6', accountId: 'acct', agent: { activeAgentId: 'harvest', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {} },
    },
    models: [],
  };
}

test('v9→v10 removes the harvest agent, strategy, and Harvest sandbox; bumps version', async () => {
  await fs.writeFile(configPath, JSON.stringify(v9WithHarvest()));
  const cfg = await cfgStore.loadConfig();
  assert.equal(cfg.schemaVersion, 10);
  assert.equal(cfg.agents.find(a => a.id === 'harvest'), undefined);
  assert.equal(cfg.strategies.find(s => s.id === 'harvest'), undefined);
  assert.equal(cfg.sandboxes.sbx_449fedf6, undefined);
});

test('v9→v10 leaves the five surviving agents + the non-harvest sandbox intact', async () => {
  await fs.writeFile(configPath, JSON.stringify(v9WithHarvest()));
  const cfg = await cfgStore.loadConfig();
  for (const id of ['default', 'mean-rev', 'trend-prophet', 'drift', 'defensive-prophet']) {
    assert.ok(cfg.agents.find(a => a.id === id), `${id} survives`);
  }
  assert.ok(cfg.sandboxes.sbx_keep, 'non-harvest sandbox survives');
});

test('v9→v10 does NOT re-add harvest from defaults via mergeMissingDefaults', async () => {
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 9, accounts: [], agents: [], strategies: [], sandboxes: {}, models: [] }));
  const cfg = await cfgStore.loadConfig();
  assert.equal(cfg.agents.find(a => a.id === 'harvest'), undefined);
  assert.equal(cfg.strategies.find(s => s.id === 'harvest'), undefined);
});

test('v9→v10 is idempotent — reloading a v10 config is a no-op', async () => {
  await fs.writeFile(configPath, JSON.stringify(v9WithHarvest()));
  await cfgStore.loadConfig();
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot });
  credStore = cfgStore._setCredStoreForTests(credStore);
  const cfg2 = await cfgStore.loadConfig();
  assert.equal(cfg2.schemaVersion, 10);
  assert.equal(cfg2.agents.find(a => a.id === 'harvest'), undefined);
});
