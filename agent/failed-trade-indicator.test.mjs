import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOrderResult, AgentHarness } from './harness.js';

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

// Executor-level: drive the real _handleOpenCodeEvent tool_use path and assert
// the recorded/emitted trade carries the right status. Tests the side-effecting
// path (state.addTrade -> emit('trade')), not just the predicate.
function captureTrade(event) {
  const harness = new AgentHarness();
  const trades = [];
  harness.state.on('trade', (t) => trades.push(t));
  const ctx = { addToolCall() {}, setSession() {} };
  harness._handleOpenCodeEvent(event, ctx);
  return trades;
}

function toolUseEvent({ tool, input, status = 'completed', output = '', error }) {
  return { type: 'tool_use', part: { tool, state: { status, input, output, ...(error ? { error } : {}) } } };
}

test('a failed options order is recorded with status "failed" + reason', () => {
  const trades = captureTrade(toolUseEvent({
    tool: 'prophet_place_options_order',
    input: { symbol: 'QQQ260717C00730000', side: 'buy', quantity: 4, limit_price: 22 },
    output: 'Error: Order value $8800 exceeds max allowed $5000. Reduce size or change permissions.',
  }));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'failed');
  assert.equal(trades[0].symbol, 'QQQ260717C00730000');
  assert.match(trades[0].errorReason, /exceeds max allowed/);
});

test('a successful options order is recorded with status "success" and no errorReason', () => {
  const trades = captureTrade(toolUseEvent({
    tool: 'prophet_place_options_order',
    input: { symbol: 'AMD260717C00510000', side: 'buy', quantity: 2, limit_price: 41.62 },
    output: '{ "id": "ord_1", "status": "accepted" }',
  }));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].status, 'success');
  assert.equal(trades[0].errorReason, undefined);
});

test('a failed close_managed_position is recorded with status "failed"', () => {
  const trades = captureTrade(toolUseEvent({
    tool: 'prophet_close_managed_position',
    input: { position_id: 'pos_17793060' },
    status: 'error',
    error: 'position not found',
  }));
  assert.equal(trades.length, 1);
  assert.equal(trades[0].type, 'close');
  assert.equal(trades[0].status, 'failed');
  assert.match(trades[0].errorReason, /position not found/);
});

test('a non-order read tool does not record a trade', () => {
  const trades = captureTrade(toolUseEvent({
    tool: 'prophet_get_account',
    input: {},
    output: '{ "cash": 100000 }',
  }));
  assert.equal(trades.length, 0);
});
