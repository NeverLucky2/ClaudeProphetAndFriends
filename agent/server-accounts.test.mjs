import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';

// Helpers: spin up agent/server.js in a child process pointed at a tmp data dir.
// We pre-seed agent-config.json + accounts-secrets.json to skip the migration path.
const { fileURLToPath } = await import('url');
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(here, 'server.js');

let proc, port, baseUrl, tmpDir;

async function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + urlPath);
    const r = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let parsed;
        try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitForServer(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await req('GET', '/api/health'); if (r.status === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start in time');
}

const seedConfig = {
  schemaVersion: 5,
  activeAccountId: 'acc1',
  activeSandboxId: 'sbx_acc1aaaa',
  activeAgentId: 'default',
  activeModel: 'anthropic/claude-sonnet-4-6',
  heartbeat: { pre_market: 900, market_open: 120, midday: 300, market_close: 120, after_hours: 7200, closed: 28800 },
  permissions: { allowLiveTrading: true, maxPositionPct: 15, maxDeployedPct: 80, maxDailyLoss: 5, maxOpenPositions: 10, maxOrderValue: 0, allowedTools: [], blockedTools: [], allowOptions: true, allowStocks: true, allow0DTE: false, requireConfirmation: false, maxToolRoundsPerBeat: 25 },
  plugins: { slack: { enabled: false, webhookUrl: '', channel: '', notifyOn: {} } },
  accounts: [
    { id: 'acc1', name: 'Paper', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-11T00:00:00Z' },
  ],
  sandboxes: {
    sbx_acc1aaaa: { id: 'sbx_acc1aaaa', accountId: 'acc1', name: 'Default', agent: { activeAgentId: 'default', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-11T00:00:00Z' },
  },
  agents: [{ id: 'default', name: 'Prophet', strategyId: 'v2-options', model: 'anthropic/claude-sonnet-4-6' }],
  strategies: [],
  models: [],
};

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-test-'));
  await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'data', 'agent-config.json'), JSON.stringify(seedConfig));
  await fs.writeFile(path.join(tmpDir, 'data', 'accounts-secrets.json'), JSON.stringify({ acc1: { publicKey: 'PK', secretKey: 'SK' } }));
  port = 13700 + Math.floor(Math.random() * 100);
  baseUrl = `http://127.0.0.1:${port}`;
  const { spawn } = await import('child_process');
  proc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_PORT: String(port), OPENPROPHET_DATA_ROOT: path.join(tmpDir, 'data'), AGENT_AUTH_TOKEN: '' },
    cwd: tmpDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(baseUrl);
});

after(async () => {
  proc?.kill();
  // Give the OS a moment to release file handles after the process exits (Windows EBUSY).
  await new Promise(r => setTimeout(r, 300));
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

test('POST /api/sandboxes happy path returns new sandbox with distinct id', async () => {
  const r = await req('POST', '/api/sandboxes', { accountId: 'acc1', name: 'Second' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.sandbox.accountId, 'acc1');
  assert.notEqual(r.body.sandbox.id, 'sbx_acc1aaaa');
  assert.match(r.body.sandbox.id, /^sbx_[0-9a-f]{8}$/);
  assert.equal(r.body.sandbox.name, 'Second');
});

test('POST /api/sandboxes with unknown accountId returns 400', async () => {
  const r = await req('POST', '/api/sandboxes', { accountId: 'no-such', name: 'X' });
  assert.equal(r.status, 400);
});

test('POST /api/sandboxes without name returns 400', async () => {
  const r = await req('POST', '/api/sandboxes', { accountId: 'acc1' });
  assert.equal(r.status, 400);
});

test('POST /api/sandboxes without accountId returns 400', async () => {
  const r = await req('POST', '/api/sandboxes', { name: 'X' });
  assert.equal(r.status, 400);
});

test('GET /api/accounts/:id/equity returns equity or null+error', async () => {
  const r = await req('GET', '/api/accounts/acc1/equity');
  // With test creds PK/SK against real Alpaca, the call will fail with 401.
  // Either way, the endpoint shape is { equity, asOf } | { equity: null, error }.
  assert.equal(r.status, 200);
  assert.ok('equity' in r.body, 'response has equity field');
  // Equity is null (auth failed) — that's the expected response shape in this test
  assert.equal(r.body.equity, null);
  assert.ok(r.body.error, 'error field populated');
});

test('GET /api/accounts/:id/equity returns 404 for unknown account', async () => {
  const r = await req('GET', '/api/accounts/no-such/equity');
  assert.equal(r.status, 404);
});

test('GET /api/accounts/:id/equity is cached: 2nd call within 60s does not refetch', async () => {
  // First call populates cache; second call should return the same asOf timestamp.
  const r1 = await req('GET', '/api/accounts/acc1/equity');
  const r2 = await req('GET', '/api/accounts/acc1/equity');
  assert.equal(r1.body.asOf, r2.body.asOf);
});

test('GET /api/accounts includes sandboxCount per account', async () => {
  const r = await req('GET', '/api/accounts');
  assert.equal(r.status, 200);
  const acc1 = r.body.accounts.find(a => a.id === 'acc1');
  assert.ok(typeof acc1.sandboxCount === 'number', 'sandboxCount field present');
});

test('DELETE /api/accounts/:id with attached sandbox returns 409 with sandboxIds list', async () => {
  // acc1 has sbx_acc1aaaa attached from seed
  const r = await req('DELETE', '/api/accounts/acc1');
  assert.equal(r.status, 409);
  assert.ok(Array.isArray(r.body.sandboxIds));
  assert.ok(r.body.sandboxIds.includes('sbx_acc1aaaa'));
});

test('PUT /api/accounts/:id with only publicKey returns 400', async () => {
  const r = await req('PUT', '/api/accounts/acc1', { publicKey: 'NEW_PK' });
  assert.equal(r.status, 400);
});

test('PUT /api/accounts/:id with both publicKey + secretKey rotates', async () => {
  const r = await req('PUT', '/api/accounts/acc1', { publicKey: 'NEW_PK', secretKey: 'NEW_SK' });
  assert.equal(r.status, 200);
  // The masked-secret response should show last-4 of the NEW secret ('NEW_SK'.slice(-4) === 'W_SK')
  assert.match(r.body.account.secretKey, /W_SK$/);
});

test('POST /api/accounts/:id/clone is removed (returns 404)', async () => {
  const r = await req('POST', '/api/accounts/acc1/clone', { name: 'X' });
  assert.equal(r.status, 404);
});

test('POST /api/accounts no longer creates a sandbox', async () => {
  const before = await req('GET', '/api/sandboxes');
  const ar = await req('POST', '/api/accounts', { name: 'NoSandbox', publicKey: 'PK_NEW', secretKey: 'SK_NEW', baseUrl: 'https://paper-api.alpaca.markets', paper: true });
  assert.equal(ar.status, 200);
  const after = await req('GET', '/api/sandboxes');
  assert.equal(after.body.sandboxes.length, before.body.sandboxes.length, 'sandbox count unchanged');
});
