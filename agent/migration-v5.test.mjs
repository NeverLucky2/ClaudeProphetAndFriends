import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let cfgStore, credStore, tmpDir, configPath, secretsPath, backupDir;

let sandboxesRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-v5-'));
  configPath = path.join(tmpDir, 'agent-config.json');
  secretsPath = path.join(tmpDir, 'accounts-secrets.json');
  backupDir = path.join(tmpDir, 'backups');
  sandboxesRoot = path.join(tmpDir, 'sandboxes');
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  credStore = await import('./credential-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot });
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

  assert.equal(cfg.schemaVersion, 10);
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

  assert.equal(JSON.parse(afterFirst).schemaVersion, 10);
  assert.equal(JSON.parse(afterSecond).schemaVersion, 10);

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

test('v4→v5: runtime dirs rekey from accountId to sandboxId', async () => {
  // Pre-create one runtime dir per old accountId
  for (const acctId of ['6e4f26af', '449fedf6', 'f015e4df', '1b6dc838']) {
    const dir = path.join(tmpDir, 'sandboxes', acctId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'prophet_trader.db'), `db for ${acctId}`);
    await fs.mkdir(path.join(dir, 'activity_logs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'activity_logs', 'sample.log'), `log for ${acctId}`);
  }

  cfgStore._setPathsForTests({
    configPath, secretsPath, backupDir,
    sandboxesRoot: path.join(tmpDir, 'sandboxes'),
  });
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();

  // After rekey, dirs live under sandboxId
  for (const sbxId of ['sbx_6e4f26af', 'sbx_449fedf6', 'sbx_f015e4df', 'sbx_1b6dc838']) {
    const newDir = path.join(tmpDir, 'sandboxes', sbxId);
    await fs.access(newDir);  // throws if missing
    const dbContents = await fs.readFile(path.join(newDir, 'prophet_trader.db'), 'utf-8');
    assert.ok(dbContents.startsWith('db for '), 'db file was moved, not overwritten');
  }

  // Old dirs no longer exist
  for (const acctId of ['6e4f26af', '449fedf6', 'f015e4df', '1b6dc838']) {
    await assert.rejects(
      fs.access(path.join(tmpDir, 'sandboxes', acctId)),
      /ENOENT/,
      `old dir for ${acctId} should be gone`
    );
  }
});

test('v4→v5: rekey is a no-op when target dir already exists (idempotency safety)', async () => {
  await fs.mkdir(path.join(tmpDir, 'sandboxes', 'sbx_6e4f26af'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'sandboxes', 'sbx_6e4f26af', 'marker'), 'preexisting');
  await fs.mkdir(path.join(tmpDir, 'sandboxes', '6e4f26af'), { recursive: true });

  cfgStore._setPathsForTests({
    configPath, secretsPath, backupDir,
    sandboxesRoot: path.join(tmpDir, 'sandboxes'),
  });
  const single = { ...v4Fixture, accounts: [v4Fixture.accounts[0]], sandboxes: { sbx_6e4f26af: v4Fixture.sandboxes.sbx_6e4f26af } };
  await fs.writeFile(configPath, JSON.stringify(single));
  await cfgStore.loadConfig();

  // Pre-existing marker survives — rekey skipped because target already populated
  const marker = await fs.readFile(path.join(tmpDir, 'sandboxes', 'sbx_6e4f26af', 'marker'), 'utf-8');
  assert.equal(marker, 'preexisting');
});

test('v4→v5: rename failure aborts migration before secrets are stripped', async () => {
  // Pre-create a source dir so there is a rename to attempt
  const sandboxesDir = path.join(tmpDir, 'sandboxes');
  await fs.mkdir(path.join(sandboxesDir, '6e4f26af'), { recursive: true });
  await fs.writeFile(path.join(sandboxesDir, '6e4f26af', 'prophet_trader.db'), 'data');

  cfgStore._setPathsForTests({
    configPath, secretsPath, backupDir,
    sandboxesRoot: sandboxesDir,
  });

  const single = {
    ...v4Fixture,
    accounts: [v4Fixture.accounts[0]],
    sandboxes: { sbx_6e4f26af: v4Fixture.sandboxes.sbx_6e4f26af },
  };
  await fs.writeFile(configPath, JSON.stringify(single));

  // Patch fs.promises.rename to simulate an OS lock (e.g. OneDrive holding the dir)
  const renameMock = mock.method(fs, 'rename', async () => {
    throw new Error('OneDrive locked');
  });

  let thrown;
  try {
    await cfgStore.loadConfig();
  } catch (err) {
    thrown = err;
  } finally {
    renameMock.mock.restore();
  }

  // Migration must have thrown with the expected message
  assert.ok(thrown, 'loadConfig should have thrown when rename fails');
  assert.ok(
    thrown.message.includes('v4→v5 migration aborted'),
    `expected "v4→v5 migration aborted" in error, got: ${thrown.message}`
  );
  assert.ok(
    thrown.message.includes('pre-mutation backup is at'),
    `expected "pre-mutation backup is at" in error message, got: ${thrown.message}`
  );

  // The on-disk config must NOT have been mutated — secrets still present, schemaVersion still 4
  const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  assert.equal(onDisk.schemaVersion, 4, 'schemaVersion must not have been bumped');
  assert.ok(onDisk.accounts[0].publicKey, 'publicKey must NOT have been stripped');
});

// v5 → v6: mechanical / price-only agents are exempted from emergency-alert
// wakes so the mid-session scanner no longer burns a beat on agents that can't
// act on news. Mirrors the structure of the v4 fixture but at schemaVersion 5.
const v5AgentsFixture = {
  schemaVersion: 5,
  accounts: [],
  sandboxes: {},
  agents: [
    { id: 'default', name: 'Prophet', strategyId: 'v2-options' },
    { id: 'harvest', name: 'Harvest', strategyId: 'harvest' },
    { id: 'mean-rev', name: 'Coil', strategyId: 'mean-rev-rsi2' },
    { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend' },
    { id: 'penny-prophet', name: 'Spark', strategyId: 'penny-momentum' },
  ],
  strategies: [],
  models: [],
};

test('v5→v7: mechanical agents get respondsToEmergencyWakes=false, reactive agents untouched, version bumped', async () => {
  await fs.writeFile(configPath, JSON.stringify(v5AgentsFixture));
  await cfgStore.loadConfig();
  const cfg = cfgStore.getConfig();
  const byId = Object.fromEntries(cfg.agents.map(a => [a.id, a]));

  assert.equal(cfg.schemaVersion, 10, 'schemaVersion bumped to 10');
  assert.equal(byId['harvest'], undefined, 'harvest retired by v10');
  assert.equal(byId['mean-rev'].respondsToEmergencyWakes, false);
  assert.equal(byId['trend-prophet'].respondsToEmergencyWakes, false);
  // Drift is absent from the v5 fixture → merged from defaults, which now carry
  // the flag inline; either way it must end up exempt.
  assert.equal(byId['drift'].respondsToEmergencyWakes, false);
  // News-reactive agents are left untouched (flag absent => default reactive).
  assert.notEqual(byId['default'].respondsToEmergencyWakes, false);
  assert.equal(byId['penny-prophet'], undefined, 'penny-prophet retired by v9');
});

test('v5→v6: a user-set respondsToEmergencyWakes value is not clobbered', async () => {
  const fixture = {
    ...v5AgentsFixture,
    agents: [
      // User deliberately re-enabled emergency wakes for Turtle (a surviving
      // mechanical agent). Harvest would also exercise this path but is retired by v10.
      { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend', respondsToEmergencyWakes: true },
      { id: 'mean-rev', name: 'Coil', strategyId: 'mean-rev-rsi2' },
    ],
  };
  await fs.writeFile(configPath, JSON.stringify(fixture));
  await cfgStore.loadConfig();
  const byId = Object.fromEntries(cfgStore.getConfig().agents.map(a => [a.id, a]));
  assert.equal(byId['trend-prophet'].respondsToEmergencyWakes, true, 'user value preserved');
  assert.equal(byId['mean-rev'].respondsToEmergencyWakes, false, 'unset mechanical agent still defaulted');
});

// v6 → v7: Drift (earnings-drift) was added after the v5→v6 exempt backfill and
// was omitted from its set, so a config already at v6 keeps Drift responding to
// emergency wakes — burning a full LLM beat to conclude "outside my 17:00 window."
// The v6→v7 pass backfills the flag for already-persisted v6 configs.
test('v6→v7: Drift, omitted from the v6 exempt set, is backfilled to respondsToEmergencyWakes=false', async () => {
  const v6WithDrift = {
    ...v5AgentsFixture,
    schemaVersion: 6,
    agents: [
      { id: 'default', name: 'Prophet', strategyId: 'v2-options' },
      { id: 'harvest', name: 'Harvest', strategyId: 'harvest', respondsToEmergencyWakes: false },
      { id: 'mean-rev', name: 'Coil', strategyId: 'mean-rev-rsi2', respondsToEmergencyWakes: false },
      { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend', respondsToEmergencyWakes: false },
      { id: 'drift', name: 'Drift', strategyId: 'earnings-drift' }, // the v6 omission
      { id: 'penny-prophet', name: 'Spark', strategyId: 'penny-momentum' },
    ],
  };
  await fs.writeFile(configPath, JSON.stringify(v6WithDrift));
  await cfgStore.loadConfig();
  const cfg = cfgStore.getConfig();
  const byId = Object.fromEntries(cfg.agents.map(a => [a.id, a]));

  assert.equal(cfg.schemaVersion, 10, 'schemaVersion bumped to 10');
  assert.equal(byId['drift'].respondsToEmergencyWakes, false, 'Drift backfilled exempt');
  // Already-exempt agents stay exempt; news-reactive agents stay reactive.
  assert.equal(byId['harvest'], undefined, 'harvest retired by v10');
  assert.notEqual(byId['default'].respondsToEmergencyWakes, false);
  assert.equal(byId['penny-prophet'], undefined, 'penny-prophet retired by v9');
});

test('v6→v7: a user-set Drift respondsToEmergencyWakes=true is not clobbered', async () => {
  const fixture = {
    ...v5AgentsFixture,
    schemaVersion: 6,
    agents: [
      // User deliberately opted Drift back into emergency wakes.
      { id: 'drift', name: 'Drift', strategyId: 'earnings-drift', respondsToEmergencyWakes: true },
    ],
  };
  await fs.writeFile(configPath, JSON.stringify(fixture));
  await cfgStore.loadConfig();
  const byId = Object.fromEntries(cfgStore.getConfig().agents.map(a => [a.id, a]));
  assert.equal(byId['drift'].respondsToEmergencyWakes, true, 'user value preserved');
});

// v7→v8: pre-market wake schedule (Prophet + Harvest scheduledBeats /
// suppressPhaseSnaps / heartbeatOverrides.pre_market backfill).
// Required because mergeMissingDefaults only appends missing AGENT IDS — it
// does not update existing records. Without this migration, the new
// pre-market wake schedule silently does not apply on any existing sandbox.
test('v7→v8 backfills pre-market scheduledBeats and suppressPhaseSnaps on Prophet and Harvest', async () => {
  const raw = {
    schemaVersion: 7,
    agents: [
      // Prophet at v7 shape (no scheduledBeats, no suppressPhaseSnaps,
      // empty heartbeatOverrides)
      { id: 'default', name: 'Prophet', heartbeatOverrides: {} },
      // Harvest at v7 shape (pre_market: 3600, no scheduledBeats, no
      // suppressPhaseSnaps)
      {
        id: 'harvest',
        name: 'Harvest',
        heartbeatOverrides: {
          pre_market: 3600,
          market_open: 900,
          midday: 900,
          market_close: 900,
          after_hours: 7200,
          closed: 28800,
        },
      },
      // Other agents must NOT receive these fields
      { id: 'penny-prophet', name: 'PennyProphet', heartbeatOverrides: { pre_market: 900 } },
      { id: 'mean-rev', name: 'Coil', scheduledBeats: { times: ['15:45'], exclusive: true, weekdaysOnly: true, windowMinutes: 5 } },
    ],
    strategies: [],
  };
  await fs.writeFile(configPath, JSON.stringify(raw, null, 2));
  const cfg = await cfgStore.loadConfig();

  const prophet = cfg.agents.find(a => a.id === 'default');
  assert.equal(prophet.heartbeatOverrides?.pre_market, 86400, 'Prophet pre_market backfilled to 86400');
  assert.deepEqual(prophet.scheduledBeats?.times, ['09:15'], 'Prophet scheduledBeats backfilled');
  assert.equal(prophet.scheduledBeats?.exclusive, false, 'Prophet scheduledBeats is additive');
  assert.deepEqual(prophet.suppressPhaseSnaps, ['pre_market'], 'Prophet suppressPhaseSnaps backfilled');

  // Harvest is backfilled at v7→v8 but retired at v10 — it does not survive a full load.
  assert.equal(cfg.agents.find(a => a.id === 'harvest'), undefined, 'harvest retired by v10');

  // Penny agent retired by v9 migration
  assert.equal(cfg.agents.find(a => a.id === 'penny-prophet'), undefined, 'penny-prophet retired by v9');

  const coil = cfg.agents.find(a => a.id === 'mean-rev');
  assert.equal(coil.scheduledBeats?.exclusive, true, 'Coil exclusive scheduledBeats preserved');
  assert.equal(coil.suppressPhaseSnaps, undefined, 'Coil not touched');

  assert.equal(cfg.schemaVersion, 10, 'schemaVersion bumped to 10');
});

test('v7→v8 preserves user customizations on Prophet/Harvest pre_market fields', async () => {
  // If a user has manually set pre_market to a non-default value (or set
  // scheduledBeats with their own times), the migration must NOT overwrite it.
  const raw = {
    schemaVersion: 7,
    agents: [
      {
        id: 'default',
        name: 'Prophet',
        // User-customized: pre_market is 1200 (not the old default which was
        // undefined / inherited 900), so the migration should leave it alone.
        heartbeatOverrides: { pre_market: 1200 },
      },
      {
        id: 'harvest',
        name: 'Harvest',
        // User-customized scheduledBeats — must be preserved.
        scheduledBeats: { times: ['10:00'], weekdaysOnly: true, exclusive: false },
        heartbeatOverrides: { pre_market: 7200 },
      },
    ],
    strategies: [],
  };
  await fs.writeFile(configPath, JSON.stringify(raw, null, 2));
  const cfg = await cfgStore.loadConfig();

  const prophet = cfg.agents.find(a => a.id === 'default');
  assert.equal(prophet.heartbeatOverrides?.pre_market, 1200, 'Prophet user-set pre_market preserved');
  // scheduledBeats was undefined → backfilled
  assert.deepEqual(prophet.scheduledBeats?.times, ['09:15'], 'Prophet scheduledBeats backfilled (was undefined)');
  assert.deepEqual(prophet.suppressPhaseSnaps, ['pre_market'], 'Prophet suppressPhaseSnaps backfilled (was undefined)');

  // Harvest is retired by v10 — its customizations don't survive a full load.
  assert.equal(cfg.agents.find(a => a.id === 'harvest'), undefined, 'harvest retired by v10');
});
