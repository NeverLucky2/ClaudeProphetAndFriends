import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHeartbeatLine } from './heartbeat-line.js';

test('formats a processed-beat summary with phase + ET time', () => {
  assert.equal(
    formatHeartbeatLine({ phase: 'pre_market', etTime: '15:45', toolCalls: 7, trades: 0 }),
    '✓ heartbeat processed — 7 tool calls, 0 trades · pre_market 15:45 ET',
  );
});

test('pluralizes tool calls and trades correctly (singular)', () => {
  assert.equal(
    formatHeartbeatLine({ phase: 'post_market', etTime: '16:00', toolCalls: 1, trades: 1 }),
    '✓ heartbeat processed — 1 tool call, 1 trade · post_market 16:00 ET',
  );
});

test('prefixes the agent name when provided', () => {
  assert.equal(
    formatHeartbeatLine({ agent: 'Coil', phase: 'pre_market', etTime: '15:45', toolCalls: 3, trades: 0 }),
    'Coil ✓ heartbeat processed — 3 tool calls, 0 trades · pre_market 15:45 ET',
  );
});

test('omits the context suffix when phase and time are absent; defaults are zero', () => {
  assert.equal(formatHeartbeatLine(), '✓ heartbeat processed — 0 tool calls, 0 trades');
  assert.equal(
    formatHeartbeatLine({ toolCalls: 2 }),
    '✓ heartbeat processed — 2 tool calls, 0 trades',
  );
});
