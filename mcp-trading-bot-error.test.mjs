import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTradingBotError } from './mcp-trading-bot-error.js';

// The real incident: a 422 from the options spread gate. The reason lives in
// the response body's `error` field; the agent must see it, not just the status.
test('422 guard rejection: surfaces the body error message + status', () => {
  const err = {
    message: 'Request failed with status code 422',
    response: { status: 422, data: { error: 'guard: options spread gate — no usable quote for "QQQ260717C00730000" (fail closed)' } },
  };
  assert.equal(
    formatTradingBotError(err),
    'Trading bot error (422): guard: options spread gate — no usable quote for "QQQ260717C00730000" (fail closed)',
  );
});

// Spark's 500: HandlePlaceManagedPosition wraps the real cause in `details`.
test('500 with error + details: includes both', () => {
  const err = {
    message: 'Request failed with status code 500',
    response: { status: 500, data: { error: 'Failed to place managed position', details: 'failed to get current price: rate limited' } },
  };
  assert.equal(
    formatTradingBotError(err),
    'Trading bot error (500): Failed to place managed position (failed to get current price: rate limited)',
  );
});

test('string body: used verbatim with status', () => {
  const err = { message: 'x', response: { status: 400, data: 'bad request' } };
  assert.equal(formatTradingBotError(err), 'Trading bot error (400): bad request');
});

test('body with only message field: uses message', () => {
  const err = { message: 'x', response: { status: 404, data: { message: 'not found' } } };
  assert.equal(formatTradingBotError(err), 'Trading bot error (404): not found');
});

// No response object = network/transport failure (ECONNREFUSED, timeout).
// Nothing to surface from the server, so fall back to the axios message.
test('no response (network error): falls back to error.message', () => {
  const err = { message: 'connect ECONNREFUSED 127.0.0.1:4534' };
  assert.equal(formatTradingBotError(err), 'Trading bot error: connect ECONNREFUSED 127.0.0.1:4534');
});

test('response present but empty body: falls back to error.message', () => {
  const err = { message: 'Request failed with status code 502', response: { status: 502, data: '' } };
  assert.equal(formatTradingBotError(err), 'Trading bot error: Request failed with status code 502');
});
