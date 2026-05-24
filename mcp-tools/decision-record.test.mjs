import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionRecord } from './decision-record.mjs';

const ctx = { sandboxId: 'sbx_6e4f26af', accountId: '6e4f26af', strategyId: 'v2-options', strategyVersion: 'a3f9c1d8e2b4' };
const now = new Date('2026-05-23T14:03:11.000Z');

test('buildDecisionRecord: stamps strategyId + strategyVersion', () => {
  const r = buildDecisionRecord({ action: 'BUY', symbol: 'SPY', reasoning: 'why', market_data: { x: 1 } }, ctx, now);
  assert.equal(r.strategyId, 'v2-options');
  assert.equal(r.strategyVersion, 'a3f9c1d8e2b4');
  assert.equal(r.action, 'BUY');
  assert.equal(r.symbol, 'SPY');
  assert.equal(r.sandbox_id, 'sbx_6e4f26af');
  assert.equal(r.timestamp, '2026-05-23T14:03:11.000Z');
  assert.deepEqual(r.market_data, { x: 1 });
});

test('buildDecisionRecord: null stamps when env unset, symbol/market_data defaults', () => {
  const r = buildDecisionRecord({ action: 'PASS', reasoning: 'why' }, { sandboxId: 's', accountId: 'a' }, now);
  assert.equal(r.strategyId, null);
  assert.equal(r.strategyVersion, null);
  assert.equal(r.symbol, null);
  assert.deepEqual(r.market_data, {});
});

test('buildDecisionRecord: strategyId set but strategyVersion absent -> null version', () => {
  const r = buildDecisionRecord(
    { action: 'BUY', reasoning: 'r' },
    { sandboxId: 's', accountId: 'a', strategyId: 'v2-options' },
    now
  );
  assert.equal(r.strategyId, 'v2-options');
  assert.equal(r.strategyVersion, null);
});
