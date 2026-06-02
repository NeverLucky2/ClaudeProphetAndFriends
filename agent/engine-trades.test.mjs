import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_AGENTS, normalizeEngineOrder, filterEngineTrades } from './engine-trades.js';

// Go-engine orders (trend, prophet-defensive) are included and mapped to their agent.
test('includes Go-engine tags and maps agent names', () => {
  const raw = [
    { Symbol: 'EEM', Side: 'buy', Qty: 59, Type: 'limit', Status: 'filled', FilledQty: 59, SubmittedAt: '2026-05-26T21:00:00Z', Strategy: 'trend' },
    { Symbol: 'QQQ260X', Side: 'buy', Qty: 1, Type: 'limit', Status: 'filled', FilledQty: 1, SubmittedAt: '2026-06-01T21:00:00Z', Strategy: 'prophet-defensive' },
  ];
  const rows = filterEngineTrades(raw);
  assert.equal(rows.length, 2);
  const byStrat = Object.fromEntries(rows.map((r) => [r.strategy, r.agentName]));
  assert.equal(byStrat['trend'], 'Turtle');
  assert.equal(byStrat['prophet-defensive'], 'DefensiveProphet');
});

// LLM-agent and untagged orders are excluded so the view never double-counts the
// LLM Trades tab.
test('excludes LLM-agent and untagged orders', () => {
  const raw = [
    { Symbol: 'AAPL', Side: 'buy', Status: 'filled', SubmittedAt: '2026-06-01T15:00:00Z', Strategy: 'mean-rev' },
    { Symbol: 'NVDA260821C00210000', Side: 'sell', Status: 'canceled', SubmittedAt: '2026-06-01T19:06:00Z', Strategy: 'v2-options' },
    { Symbol: 'X', Side: 'buy', Status: 'filled', SubmittedAt: '2026-06-01T15:00:00Z', Strategy: 'drift' },
    { Symbol: 'Y', Side: 'buy', Status: 'filled', SubmittedAt: '2026-06-01T15:00:00Z', Strategy: '' },
  ];
  assert.deepEqual(filterEngineTrades(raw), []);
});

// Rows are newest-first by submittedAt.
test('sorts newest-first by submittedAt', () => {
  const raw = [
    { Symbol: 'EEM', Side: 'buy', Status: 'filled', SubmittedAt: '2026-05-26T21:00:00Z', Strategy: 'trend' },
    { Symbol: 'DBB', Side: 'buy', Status: 'filled', SubmittedAt: '2026-06-01T21:00:00Z', Strategy: 'trend' },
  ];
  const rows = filterEngineTrades(raw);
  assert.deepEqual(rows.map((r) => r.symbol), ['DBB', 'EEM']);
});

// Missing optional fields must not throw and get null/0 defaults.
test('tolerates missing optional fields', () => {
  const rows = filterEngineTrades([{ Symbol: 'EEM', Side: 'buy', Status: 'filled', Strategy: 'trend' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].limitPrice, null);
  assert.equal(rows[0].filledAvgPrice, null);
  assert.equal(rows[0].qty, 0);
});

// Non-array / nullish input is handled.
test('handles non-array input', () => {
  assert.deepEqual(filterEngineTrades(null), []);
  assert.deepEqual(filterEngineTrades(undefined), []);
});

// normalizeEngineOrder maps PascalCase with lowercase fallback.
test('normalizeEngineOrder maps PascalCase and lowercase', () => {
  assert.equal(normalizeEngineOrder({ Symbol: 'EEM' }).symbol, 'EEM');
  assert.equal(normalizeEngineOrder({ symbol: 'eem' }).symbol, 'eem');
  assert.equal(ENGINE_AGENTS['trend'], 'Turtle');
});
