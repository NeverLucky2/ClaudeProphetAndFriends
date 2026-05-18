import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVerdict, scoreMaxPositionSizePct } from './score-rule-against-holdout.mjs';

test('buildVerdict: trades_affected = 0 -> INCONCLUSIVE', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 0, net_pl_delta_usd: 0,
    blocked_winners: 0, blocked_losers: 0, details: [],
  });
  assert.equal(v.verdict, 'INCONCLUSIVE');
});

test('buildVerdict: 1 trade affected, small delta -> INCONCLUSIVE', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 1, net_pl_delta_usd: 50,
    blocked_winners: 0, blocked_losers: 1, details: [],
  });
  assert.equal(v.verdict, 'INCONCLUSIVE');
});

test('buildVerdict: 1 trade, large absolute delta -> APPROVED', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 1, net_pl_delta_usd: 250,
    blocked_winners: 0, blocked_losers: 1, details: [],
  });
  assert.equal(v.verdict, 'APPROVED-BY-HOLDOUT');
});

test('buildVerdict: 4 trades, small delta -> APPROVED (passes trade-count gate)', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 4, net_pl_delta_usd: 80,
    blocked_winners: 1, blocked_losers: 3, details: [],
  });
  assert.equal(v.verdict, 'APPROVED-BY-HOLDOUT');
});

test('buildVerdict: gate cleared with negative delta -> REJECTED', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 4, net_pl_delta_usd: -300,
    blocked_winners: 2, blocked_losers: 2, details: [],
  });
  assert.equal(v.verdict, 'REJECTED-BY-HOLDOUT');
});

test('buildVerdict: envelope always carries review_type "mechanical"', () => {
  const v = buildVerdict({
    predicate: 'max_position_size_pct', params: { limit: 0.15 },
    holdout_size: 15, trades_affected: 0, net_pl_delta_usd: 0,
    blocked_winners: 0, blocked_losers: 0, details: [],
  });
  assert.equal(v.review_type, 'mechanical');
});

test('buildVerdict: limitation_notes propagated when provided', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 2, net_pl_delta_usd: 150,
    blocked_winners: 0, blocked_losers: 2, details: [],
    limitation_notes: ['cannot see intra-trade trough'],
  });
  assert.deepEqual(v.limitation_notes, ['cannot see intra-trade trough']);
});

test('scoreMaxPositionSizePct: no holdout trades -> INCONCLUSIVE', () => {
  const v = scoreMaxPositionSizePct([], { limit: 0.15 });
  assert.equal(v.verdict, 'INCONCLUSIVE');
  assert.equal(v.trades_affected, 0);
});

test('scoreMaxPositionSizePct: trade within limit -> not flagged', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 500, size: 30, portfolio_value: 100000, friction_adjusted_pl: 200 },
  }]; // size/value = 0.15 exactly = not over.
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 0);
});

test('scoreMaxPositionSizePct: oversized winning trade -> flagged, delta is negative of pl', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: 800 },
  }]; // 0.25 > 0.15.
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, -800); // would have prevented an $800 winner
  assert.equal(v.blocked_winners, 1);
});

test('scoreMaxPositionSizePct: oversized losing trade -> flagged, delta is positive', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: -500 },
  }];
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 500); // would have prevented a $500 loss
  assert.equal(v.blocked_losers, 1);
});

test('scoreMaxPositionSizePct: mixed -> net delta is sum', () => {
  const trades = [
    { symbol: 'A', market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: 800 } },
    { symbol: 'B', market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: -500 } },
  ];
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 2);
  assert.equal(v.net_pl_delta_usd, -300);
});
