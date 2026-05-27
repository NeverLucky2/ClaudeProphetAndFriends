import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendSseKeepalive, KEEPALIVE_FRAME, SSE_KEEPALIVE_MS } from './sse-keepalive.js';

function mockClient() {
  const writes = [];
  return { writes, write(s) { writes.push(s); } };
}

test('the keepalive frame is an SSE comment EventSource ignores', () => {
  // Must start with ":" (comment line) and end with the blank-line terminator,
  // or it would be parsed as a real event / never flush.
  assert.ok(KEEPALIVE_FRAME.startsWith(':'), 'comment frames begin with ":"');
  assert.ok(KEEPALIVE_FRAME.endsWith('\n\n'), 'frames terminate with a blank line');
});

test('sendSseKeepalive writes the comment frame to every live client', () => {
  const a = mockClient();
  const b = mockClient();
  const clients = new Set([a, b]);
  const written = sendSseKeepalive(clients);
  assert.equal(written, 2);
  assert.deepEqual(a.writes, [KEEPALIVE_FRAME]);
  assert.deepEqual(b.writes, [KEEPALIVE_FRAME]);
  assert.equal(clients.size, 2, 'live clients are retained');
});

test('sendSseKeepalive prunes a client whose write throws (dead socket)', () => {
  const live = mockClient();
  const dead = { write() { throw new Error('EPIPE: socket destroyed'); } };
  const clients = new Set([live, dead]);
  const written = sendSseKeepalive(clients);
  assert.equal(written, 1, 'only the live client is counted');
  assert.deepEqual(live.writes, [KEEPALIVE_FRAME]);
  assert.ok(!clients.has(dead), 'the dead client is pruned from the set');
  assert.equal(clients.size, 1);
});

test('sendSseKeepalive is a no-op with no/empty/null clients', () => {
  assert.equal(sendSseKeepalive(new Set()), 0);
  assert.equal(sendSseKeepalive(null), 0);
  assert.equal(sendSseKeepalive(undefined), 0);
});

test('SSE_KEEPALIVE_MS is a positive cadence under common idle-drop windows', () => {
  assert.ok(Number.isFinite(SSE_KEEPALIVE_MS) && SSE_KEEPALIVE_MS > 0);
  assert.ok(SSE_KEEPALIVE_MS <= 30_000, 'stay under typical 30–60s proxy idle timeouts');
});
