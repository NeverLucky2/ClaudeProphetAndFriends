import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let cfgStore;
let credStore;
let tmpDir;
let configPath;
let secretsPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-store-'));
  configPath = path.join(tmpDir, 'agent-config.json');
  secretsPath = path.join(tmpDir, 'accounts-secrets.json');
  // Fresh module instances per test. The cachebust query forces Node's ESM
  // loader to give us a NEW module instance so module-level state (the _store,
  // _config, etc.) doesn't leak between tests.
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  credStore = await import('./credential-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath });
  // Critical: tell cfgStore to use the SAME credential-store instance the test
  // reads from. _setCredStoreForTests returns a mutable proxy wrapper around the
  // ESM namespace (ESM namespaces are frozen; the proxy lets tests monkey-patch
  // individual methods like setCredentials). Reassign credStore so the test's
  // own reads/writes also go through the same proxy.
  credStore = cfgStore._setCredStoreForTests(credStore);
});

test('addAccount: writes metadata to config and creds to credential store', async () => {
  await cfgStore.loadConfig();
  const account = await cfgStore.addAccount({
    name: 'Test',
    publicKey: 'PK_TEST',
    secretKey: 'SK_TEST',
    baseUrl: 'https://paper-api.alpaca.markets',
    paper: true,
  });

  const onDiskCfg = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const acct = onDiskCfg.accounts.find(a => a.id === account.id);
  assert.ok(acct, 'account row exists in config');
  // Creds also written to secrets file via credential store
  const onDiskSecrets = JSON.parse(await fs.readFile(secretsPath, 'utf-8'));
  assert.deepEqual(onDiskSecrets[account.id], { publicKey: 'PK_TEST', secretKey: 'SK_TEST' });
});

test('getAccountById returns merged metadata + creds shape', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({
    name: 'M', publicKey: 'PK', secretKey: 'SK', baseUrl: 'https://paper-api.alpaca.markets', paper: true,
  });
  const got = cfgStore.getAccountById(a.id);
  assert.equal(got.publicKey, 'PK');
  assert.equal(got.secretKey, 'SK');
  assert.equal(got.name, 'M');
});

test('addAccount rolls back metadata when credential write fails', async () => {
  await cfgStore.loadConfig();
  // Monkey-patch setCredentials to throw
  const origSet = credStore.setCredentials;
  credStore.setCredentials = async () => { throw new Error('disk full'); };
  cfgStore._setCredStoreForTests(credStore);

  await assert.rejects(
    () => cfgStore.addAccount({ name: 'X', publicKey: 'PK', secretKey: 'SK', baseUrl: 'https://paper-api.alpaca.markets', paper: true }),
    /disk full/
  );

  const cfg = cfgStore.getConfig();
  assert.equal(cfg.accounts.length, 0, 'account row was rolled back');

  credStore.setCredentials = origSet;
});

test('updateAccount with both publicKey + secretKey rotates via credential store', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'X', publicKey: 'OLD_PK', secretKey: 'OLD_SK', baseUrl: 'https://paper-api.alpaca.markets', paper: true });
  await cfgStore.updateAccount(a.id, { publicKey: 'NEW_PK', secretKey: 'NEW_SK' });
  assert.deepEqual(credStore.getCredentials(a.id), { publicKey: 'NEW_PK', secretKey: 'NEW_SK' });
});

test('updateAccount with only publicKey throws (both-or-neither)', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'X', publicKey: 'PK', secretKey: 'SK', baseUrl: 'https://paper-api.alpaca.markets', paper: true });
  await assert.rejects(
    () => cfgStore.updateAccount(a.id, { publicKey: 'NEW_PK_ONLY' }),
    /both publicKey and secretKey/i
  );
});

test('updateAccount with neither key leaves credentials untouched', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'X', publicKey: 'PK', secretKey: 'SK', baseUrl: 'https://paper-api.alpaca.markets', paper: true });
  await cfgStore.updateAccount(a.id, { name: 'Renamed' });
  assert.deepEqual(credStore.getCredentials(a.id), { publicKey: 'PK', secretKey: 'SK' });
});

test('removeAccount deletes both the metadata row and the credentials', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'X', publicKey: 'PK', secretKey: 'SK', baseUrl: 'https://paper-api.alpaca.markets', paper: true });
  await cfgStore.removeAccount(a.id);
  assert.equal(cfgStore.getAccountById(a.id), null);
  assert.equal(credStore.getCredentials(a.id), null);
});

test('getAccountById returns null creds when secrets are missing for that id', async () => {
  await cfgStore.loadConfig();
  // Synthesize an orphan: write a metadata-only account directly
  const cfg = cfgStore.getConfig();
  cfg.accounts.push({ id: 'orphan', name: 'O', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: new Date().toISOString() });
  const got = cfgStore.getAccountById('orphan');
  assert.equal(got.publicKey, null);
  assert.equal(got.secretKey, null);
});

// ── createSandboxForAccount ───────────────────────────────────────────

test('createSandboxForAccount: generates sbx_<uuid8> distinct from sbx_<accountId>', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'A', publicKey: 'PK', secretKey: 'SK', baseUrl: 'https://paper-api.alpaca.markets', paper: true });
  const sbx = await cfgStore.createSandboxForAccount(a.id, { name: 'First' });
  assert.equal(sbx.accountId, a.id);
  assert.notEqual(sbx.id, `sbx_${a.id}`, 'sandbox id is no longer derived from accountId');
  assert.match(sbx.id, /^sbx_[0-9a-f]{8}$/);
  assert.equal(sbx.name, 'First');
});

test('createSandboxForAccount: two calls produce distinct sandboxes pointing at same account', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'A', publicKey: 'PK', secretKey: 'SK', baseUrl: 'https://paper-api.alpaca.markets', paper: true });
  const sbx1 = await cfgStore.createSandboxForAccount(a.id, { name: 'One' });
  const sbx2 = await cfgStore.createSandboxForAccount(a.id, { name: 'Two' });
  assert.notEqual(sbx1.id, sbx2.id);
  assert.equal(sbx1.accountId, a.id);
  assert.equal(sbx2.accountId, a.id);
});

test('createSandboxForAccount: throws if accountId unknown', async () => {
  await cfgStore.loadConfig();
  await assert.rejects(
    () => cfgStore.createSandboxForAccount('nope', { name: 'X' }),
    /account not found/i
  );
});

test('createSandboxForAccount: applies agentId override when provided', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'A', publicKey: 'PK', secretKey: 'SK', baseUrl: 'https://paper-api.alpaca.markets', paper: true });
  const sbx = await cfgStore.createSandboxForAccount(a.id, { name: 'Harvest sbx', agentId: 'harvest' });
  assert.equal(sbx.agent.activeAgentId, 'harvest');
});

// ── normalizeConfig merges code-default agents/strategies missing on disk ──

test('loadConfig merges code-default agents/strategies missing from persisted config', async () => {
  // Simulate a config saved BEFORE the `drift` agent + `earnings-drift`
  // strategy were added to the code defaults, with a user rename in place.
  const raw = {
    schemaVersion: 5,
    accounts: [],
    sandboxes: {},
    agents: [
      { id: 'default', name: 'Prophet', strategyId: 'v2-options' },
      { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend' }, // user rename
      { id: 'mean-rev', name: 'Coil', strategyId: 'mean-rev-rsi2' },
    ],
    strategies: [
      { id: 'v2-options', name: 'Aggressive Options v2' },
      { id: 'mean-rev-rsi2', name: 'Mean Reversion (Connors RSI(2))' },
    ],
  };
  await fs.writeFile(configPath, JSON.stringify(raw, null, 2));

  const cfg = await cfgStore.loadConfig();

  // Missing code-default agent + strategy are merged in from defaults.
  assert.ok(cfg.agents.find(a => a.id === 'drift'), 'drift agent merged in from defaults');
  assert.ok(cfg.strategies.find(s => s.id === 'earnings-drift'), 'earnings-drift strategy merged in');
  // User rename is preserved (NOT clobbered by the code default name 'TrendProphet').
  assert.equal(cfg.agents.find(a => a.id === 'trend-prophet').name, 'Turtle', 'user rename preserved');
  // Pre-existing agents stay; no duplicate ids introduced by the merge.
  assert.ok(cfg.agents.find(a => a.id === 'mean-rev'), 'existing coil agent preserved');
  const ids = cfg.agents.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate agent ids');
});

test('default agent (Prophet) has additive scheduledBeats and suppresses pre_market snap', async () => {
  const cfg = await cfgStore.loadConfig();
  const agents = cfg.agents;
  const prophet = agents.find(a => a.id === 'default');
  assert.ok(prophet, 'Prophet agent (id=default) should exist');
  assert.equal(prophet.heartbeatOverrides?.pre_market, 86400, 'pre_market cadence should be 24h (silenced)');
  assert.deepEqual(prophet.scheduledBeats?.times, ['09:15'], 'should have 09:15 scheduled wake');
  assert.equal(prophet.scheduledBeats?.exclusive, false, 'scheduledBeats should be additive');
  assert.equal(prophet.scheduledBeats?.weekdaysOnly, true, 'scheduledBeats should be weekdays-only');
  assert.deepEqual(prophet.suppressPhaseSnaps, ['pre_market'], 'should suppress 04:00 pre_market snap');
});

test('non-Prophet/Harvest agents do NOT have the new pre-market scheduled-wake fields', async () => {
  const cfg = await cfgStore.loadConfig();
  const agents = cfg.agents;

  // PennyProphet retired by v9 migration
  assert.equal(agents.find(a => a.id === 'penny-prophet'), undefined, 'PennyProphet retired');

  // Coil: exclusive scheduledBeats (15:45) — must NOT flip to non-exclusive
  const coil = agents.find(a => a.id === 'mean-rev');
  assert.ok(coil, 'Coil should exist');
  assert.equal(coil.scheduledBeats?.exclusive, true, 'Coil must remain exclusive-mode');
  assert.equal(coil.suppressPhaseSnaps, undefined, 'Coil should not suppress any phase snaps');
});

test('defaults include the defensive-prophet agent + prophet-defensive strategy', async () => {
  await cfgStore.loadConfig();
  const cfg = cfgStore.getConfig();
  const agent = cfg.agents.find(a => a.id === 'defensive-prophet');
  assert.ok(agent, 'defensive-prophet agent must be present');
  assert.equal(agent.strategyId, 'prophet-defensive');
  const strat = cfg.strategies.find(s => s.id === 'prophet-defensive');
  assert.ok(strat, 'prophet-defensive strategy must be present');
  assert.equal(strat.rulesFile, 'TRADING_RULES_DEFENSIVE_PROPHET.md');
});
