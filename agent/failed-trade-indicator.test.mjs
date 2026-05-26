import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOrderResult } from './harness.js';

// classifyOrderResult inspects a resolved opencode tool `part` and decides
// whether the order tool call errored/was rejected. Multi-signal so it is
// robust to however opencode surfaces an MCP isError result.

test('state.status === "error" is a failure, reason from state.error', () => {
  const part = { state: { status: 'error', error: 'order rejected by guard', input: {}, output: '' } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, true);
  assert.match(r.reason, /order rejected by guard/);
});

test('output text beginning with "Error:" is a failure (MCP error shape)', () => {
  const part = { state: { status: 'completed', input: {}, output: 'Error: Order value $999 exceeds max allowed $500. Reduce size or change permissions.' } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, true);
  assert.match(r.reason, /exceeds max allowed/);
});

test('output object with isError:true is a failure', () => {
  const part = { state: { status: 'completed', input: {}, output: { isError: true, content: [{ type: 'text', text: 'Error: Live trading is DISABLED' }] } } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, true);
  assert.match(r.reason, /Live trading is DISABLED/);
});

test('a clean order-confirmation output is NOT a failure', () => {
  const part = { state: { status: 'completed', input: {}, output: '{\n  "id": "abc-123",\n  "status": "accepted",\n  "symbol": "QQQ260717C00730000"\n}' } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, false);
  assert.equal(r.reason, '');
});

test('missing/empty state does not throw and is not a failure', () => {
  assert.deepEqual(classifyOrderResult({}), { failed: false, reason: '' });
  assert.deepEqual(classifyOrderResult({ state: {} }), { failed: false, reason: '' });
  assert.deepEqual(classifyOrderResult(null), { failed: false, reason: '' });
});

test('reason is trimmed and truncated to <= 200 chars', () => {
  const long = 'Error: ' + 'x'.repeat(400);
  const part = { state: { status: 'completed', input: {}, output: long } };
  const r = classifyOrderResult(part);
  assert.equal(r.failed, true);
  assert.ok(r.reason.length <= 200, `reason length ${r.reason.length} should be <= 200`);
});
