// End-to-end check that the keepalive timer is actually wired into the live
// /api/events stream (the unit test in sse-keepalive.test.mjs covers the
// write+prune logic; this guards the setInterval wiring in server.js). Boots
// server.js as a child process with a short SSE_KEEPALIVE_MS, opens a real SSE
// connection, and asserts a comment frame arrives — pattern borrowed from
// server-accounts.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(here, 'server.js');

let proc, port, baseUrl, tmpDir;

const seedConfig = {
  schemaVersion: 5,
  activeAccountId: 'acc1',
  activeSandboxId: 'sbx_acc1aaaa',
  activeAgentId: 'default',
  activeModel: 'anthropic/claude-sonnet-4-6',
  heartbeat: { pre_market: 900, market_open: 120, midday: 300, market_close: 120, after_hours: 7200, closed: 28800 },
  permissions: { allowLiveTrading: false, maxPositionPct: 15, maxDeployedPct: 80, maxDailyLoss: 5, maxOpenPositions: 10, maxOrderValue: 0, allowedTools: [], blockedTools: [], allowOptions: true, allowStocks: true, allow0DTE: false, requireConfirmation: false, maxToolRoundsPerBeat: 25 },
  plugins: { slack: { enabled: false, webhookUrl: '', channel: '', notifyOn: {} } },
  accounts: [{ id: 'acc1', name: 'Paper', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-11T00:00:00Z' }],
  sandboxes: {
    sbx_acc1aaaa: { id: 'sbx_acc1aaaa', accountId: 'acc1', name: 'Default', agent: { activeAgentId: 'default', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-11T00:00:00Z' },
  },
  agents: [{ id: 'default', name: 'Prophet', strategyId: 'v2-options', model: 'anthropic/claude-sonnet-4-6' }],
  strategies: [],
  models: [],
};

async function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const r = http.get(`${baseUrl}/api/health`, (res) => { res.resume(); resolve(res.statusCode === 200); });
      r.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start in time');
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sse-keepalive-test-'));
  await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'data', 'agent-config.json'), JSON.stringify(seedConfig));
  await fs.writeFile(path.join(tmpDir, 'data', 'accounts-secrets.json'), JSON.stringify({ acc1: { publicKey: 'PK', secretKey: 'SK' } }));
  port = 13800 + Math.floor(Math.random() * 100);
  baseUrl = `http://127.0.0.1:${port}`;
  const { spawn } = await import('child_process');
  proc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_PORT: String(port), OPENPROPHET_DATA_ROOT: path.join(tmpDir, 'data'), AGENT_AUTH_TOKEN: '', SSE_KEEPALIVE_MS: '250' },
    cwd: tmpDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer();
});

after(async () => {
  proc?.kill();
  await new Promise(r => setTimeout(r, 300));
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

test('/api/events emits a keepalive comment frame on cadence', async (t) => {
  const started = Date.now();
  const { buf, elapsed } = await new Promise((resolve, reject) => {
    let timer;
    const r = http.get(`${baseUrl}/api/events`, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        // The endpoint opens with `event: state` / `event: config` frames; the
        // keepalive is the only line that starts with ":" (an SSE comment).
        if (buf.split('\n').some(line => line.startsWith(':'))) {
          clearTimeout(timer);
          res.destroy();
          resolve({ buf, elapsed: Date.now() - started });
        }
      });
      res.on('error', () => {}); // destroy() surfaces here on some platforms
    });
    r.on('error', reject);
    timer = setTimeout(() => { r.destroy(); reject(new Error('no keepalive frame within 3s')); }, 3000);
  });
  t.diagnostic(`time-to-first-keepalive: ${elapsed}ms (cadence 250ms)`);
  assert.match(buf, /^:.*$/m, 'a comment line (": ...") appeared on the stream');
  // 250ms cadence (set via SSE_KEEPALIVE_MS in before()). Asserting well under a
  // second proves the timer fired periodically, not that we squeaked in at the
  // fallback timeout.
  assert.ok(elapsed < 1500, `keepalive arrived in ${elapsed}ms (expected ≈250ms)`);
});
