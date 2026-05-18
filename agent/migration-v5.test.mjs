import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let cfgStore, credStore, tmpDir, configPath, secretsPath, backupDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-v5-'));
  configPath = path.join(tmpDir, 'agent-config.json');
  secretsPath = path.join(tmpDir, 'accounts-secrets.json');
  backupDir = path.join(tmpDir, 'backups');
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  credStore = await import('./credential-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir });
  // See note in config-store.test.mjs about why this matters
  credStore = cfgStore._setCredStoreForTests(credStore);
});

const v4Fixture = {
  schemaVersion: 4,
  activeAccountId: '6e4f26af',
  activeSandboxId: 'sbx_6e4f26af',
  activeAgentId: 'default',
  activeModel: 'anthropic/claude-sonnet-4-6',
  heartbeat: { pre_market: 900, market_open: 120, midday: 300, market_close: 120, after_hours: 7200, closed: 28800 },
  permissions: { allowLiveTrading: true, maxPositionPct: 15, maxDeployedPct: 80, maxDailyLoss: 5, maxOpenPositions: 10, maxOrderValue: 0, allowedTools: [], blockedTools: [], allowOptions: true, allowStocks: true, allow0DTE: false, requireConfirmation: false, maxToolRoundsPerBeat: 25 },
  plugins: { slack: { enabled: false, webhookUrl: '', channel: '', notifyOn: {} } },
  accounts: [
    { id: '6e4f26af', name: 'Paper (from .env)', publicKey: 'PK_SHARED', secretKey: 'SK_SHARED', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-11T12:47:51.486Z' },
    { id: '449fedf6', name: 'Harvest', publicKey: 'PK_SHARED', secretKey: 'SK_SHARED', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-13T14:17:33.497Z' },
    { id: 'f015e4df', name: 'Turtle', publicKey: 'PK_SHARED', secretKey: 'SK_SHARED', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-13T14:17:47.770Z' },
    { id: '1b6dc838', name: 'Spark', publicKey: 'PK_SHARED', secretKey: 'SK_SHARED', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-15T16:36:32.194Z' },
  ],
  sandboxes: {
    sbx_6e4f26af: { id: 'sbx_6e4f26af', accountId: '6e4f26af', name: 'Paper (from .env)', agent: { activeAgentId: 'default', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-11T12:47:51.486Z' },
    sbx_449fedf6: { id: 'sbx_449fedf6', accountId: '449fedf6', name: 'Harvest', agent: { activeAgentId: 'harvest', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-13T14:17:33.497Z' },
    sbx_f015e4df: { id: 'sbx_f015e4df', accountId: 'f015e4df', name: 'Turtle', agent: { activeAgentId: 'trend-prophet', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-13T14:17:47.770Z' },
    sbx_1b6dc838: { id: 'sbx_1b6dc838', accountId: '1b6dc838', name: 'Spark', agent: { activeAgentId: 'penny-prophet', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-15T16:36:32.194Z' },
  },
  agents: [
    { id: 'default', name: 'Prophet', strategyId: 'v2-options', model: 'anthropic/claude-sonnet-4-6' },
    { id: 'harvest', name: 'Harvest', strategyId: 'harvest', model: 'anthropic/claude-sonnet-4-6' },
    { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend', model: 'anthropic/claude-sonnet-4-6' },
    { id: 'penny-prophet', name: 'Spark', strategyId: 'penny-momentum', model: 'anthropic/claude-sonnet-4-6' },
  ],
  strategies: [],
  models: [],
};

test('v4→v5: 4 duplicate accounts dedup to 1 survivor, sandbox pointers rewritten', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const cfg = cfgStore.getConfig();

  assert.equal(cfg.schemaVersion, 5);
  assert.equal(cfg.accounts.length, 1, 'deduped to one account');
  const survivorId = cfg.accounts[0].id;
  assert.equal(cfg.accounts[0].name, 'Paper (from .env)', 'env-seeded account is survivor by name match');

  for (const sbx of Object.values(cfg.sandboxes)) {
    assert.equal(sbx.accountId, survivorId, `sandbox ${sbx.id} repointed at survivor`);
  }
});

test('v4→v5: surviving account row has NO publicKey/secretKey fields', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  assert.equal(onDisk.accounts[0].publicKey, undefined);
  assert.equal(onDisk.accounts[0].secretKey, undefined);
});

test('v4→v5: accounts-secrets.json contains survivor creds', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const onDisk = JSON.parse(await fs.readFile(secretsPath, 'utf-8'));
  const ids = Object.keys(onDisk);
  assert.equal(ids.length, 1);
  assert.deepEqual(onDisk[ids[0]], { publicKey: 'PK_SHARED', secretKey: 'SK_SHARED' });
});

test('v4→v5: backup file is written under backups/ before mutation', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const backups = await fs.readdir(backupDir);
  const v4Backup = backups.find(f => /^agent-config\.v4\.[0-9TZ:-]+\.json$/.test(f));
  assert.ok(v4Backup, `expected a v4 backup, got: ${backups.join(', ')}`);
  const backupContents = JSON.parse(await fs.readFile(path.join(backupDir, v4Backup), 'utf-8'));
  assert.equal(backupContents.schemaVersion, 4);
  assert.equal(backupContents.accounts.length, 4);
});

test('v4→v5: idempotent — re-running on v5 config is a no-op', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const afterFirst = await fs.readFile(configPath, 'utf-8');

  // Re-init module + re-load
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir });
  credStore = cfgStore._setCredStoreForTests(credStore);
  await cfgStore.loadConfig();
  const afterSecond = await fs.readFile(configPath, 'utf-8');

  assert.equal(JSON.parse(afterFirst).schemaVersion, 5);
  assert.equal(JSON.parse(afterSecond).schemaVersion, 5);

  // No second backup file written on the no-op migration
  const backups = await fs.readdir(backupDir);
  const v4Backups = backups.filter(f => /^agent-config\.v4\./.test(f));
  assert.equal(v4Backups.length, 1, 'only one backup, from the original v4→v5 migration');
});

test('v4→v5: single-account v4 config still extracts secrets, no merge happens', async () => {
  const single = { ...v4Fixture, accounts: [v4Fixture.accounts[0]], sandboxes: { sbx_6e4f26af: v4Fixture.sandboxes.sbx_6e4f26af } };
  await fs.writeFile(configPath, JSON.stringify(single));
  await cfgStore.loadConfig();
  const cfg = cfgStore.getConfig();
  assert.equal(cfg.accounts.length, 1);
  assert.equal(cfg.accounts[0].publicKey, undefined);
  const onDiskSecrets = JSON.parse(await fs.readFile(secretsPath, 'utf-8'));
  assert.deepEqual(onDiskSecrets['6e4f26af'], { publicKey: 'PK_SHARED', secretKey: 'SK_SHARED' });
});
