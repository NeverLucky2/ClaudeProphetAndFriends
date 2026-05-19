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
