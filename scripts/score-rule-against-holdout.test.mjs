import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVerdict, scoreMaxPositionSizePct, scoreStopAtPct, scoreMaxConcurrentPositions, scoreNoReentryWithinHours } from './score-rule-against-holdout.mjs';

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

test('scoreStopAtPct: includes limitation_notes always', () => {
  const v = scoreStopAtPct([], { stop: -0.10 });
  assert.ok(v.limitation_notes.length > 0);
  assert.match(v.limitation_notes[0], /intra-trade trough/);
});

test('scoreStopAtPct: trade that closed at -5% with stop -10% -> not flagged', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 100, size: 100, friction_adjusted_pl: -500, unrealized_pct: -5 },
  }];
  const v = scoreStopAtPct(trades, { stop: -0.10 });
  assert.equal(v.trades_affected, 0);
});

test('scoreStopAtPct: trade that closed at -15% with stop -10% -> flagged, positive delta (rule cuts earlier)', () => {
  // entry_value = 100 × 100 = 10000. Stop at -10% → -1000 exit. Actual pl = -1500.
  // Delta = -1000 - (-1500) = +500 (rule would save $500).
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 100, size: 100, friction_adjusted_pl: -1500, unrealized_pct: -15 },
  }];
  const v = scoreStopAtPct(trades, { stop: -0.10 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 500);
});

test('scoreMaxConcurrentPositions: never exceeds limit -> 0 affected', () => {
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 100 } },
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 100 } },
    { action: 'BUY', symbol: 'B', timestamp: '2026-05-01T12:00:00Z', market_data: { friction_adjusted_pl: 50 } },
  ];
  const v = scoreMaxConcurrentPositions(trades, { limit: 3 });
  assert.equal(v.trades_affected, 0);
});

test('scoreMaxConcurrentPositions: exceeds limit -> flagged', () => {
  // Limit 2. Three BUYs in a row without SELLs.
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 100 } },
    { action: 'BUY', symbol: 'B', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'C', timestamp: '2026-05-01T12:00:00Z', market_data: { friction_adjusted_pl: -200 } },
  ];
  const v = scoreMaxConcurrentPositions(trades, { limit: 2 });
  assert.equal(v.trades_affected, 1); // only the 3rd BUY pushes count to 3 (>2)
  assert.equal(v.net_pl_delta_usd, 200); // -1 × (-200), preventing the loser saves $200
});

test('scoreNoReentryWithinHours: no reentries -> 0 affected', () => {
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'B', timestamp: '2026-05-01T12:30:00Z', market_data: { friction_adjusted_pl: 100 } },
  ];
  const v = scoreNoReentryWithinHours(trades, { hours: 2 });
  assert.equal(v.trades_affected, 0);
});

test('scoreNoReentryWithinHours: reentry within window -> flagged', () => {
  // SELL at 11:00, BUY at 12:30 → 1.5h gap, under 2h window.
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T12:30:00Z', market_data: { friction_adjusted_pl: -75 } },
  ];
  const v = scoreNoReentryWithinHours(trades, { hours: 2 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 75); // prevents a $75 loss
});

test('scoreNoReentryWithinHours: reentry past window -> not flagged', () => {
  const trades = [
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T14:00:00Z', market_data: { friction_adjusted_pl: -75 } },
  ];
  const v = scoreNoReentryWithinHours(trades, { hours: 2 });
  assert.equal(v.trades_affected, 0);
});
