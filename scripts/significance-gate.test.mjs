// scripts/significance-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exposurePerTrade, WING_WIDTH_BY_UNDERLYING } from './significance-gate.mjs';

test('exposurePerTrade: stocks = |entry_price × size|', () => {
  const t = { friction_meta: { profile_applied: 'stocks' },
              market_data: { entry_price: 100, size: 50 } };
  assert.equal(exposurePerTrade(t), 5000);
});

test('exposurePerTrade: single_leg_options = |entry × size × 100|', () => {
  const t = { friction_meta: { profile_applied: 'single_leg_options' },
              market_data: { entry_price: 2.5, size: 6 } };
  assert.equal(exposurePerTrade(t), 1500);
});

test('exposurePerTrade: iron_condor uses explicit wing_width when present', () => {
  const t = { friction_meta: { profile_applied: 'iron_condor' },
              symbol: 'SPY',
              market_data: { entry_price: 0.5, size: 2, wing_width: 5 } };
  assert.equal(exposurePerTrade(t), 5 * 2 * 100); // 1000
});

test('exposurePerTrade: iron_condor falls back to underlying-symbol table', () => {
  const t = { friction_meta: { profile_applied: 'iron_condor' },
              symbol: 'SPY',
              market_data: { entry_price: 0.5, size: 2 } };
  assert.equal(WING_WIDTH_BY_UNDERLYING.SPY, 5);
  assert.equal(exposurePerTrade(t), 5 * 2 * 100);
});

test('exposurePerTrade: iron_condor underlying not in table -> 10x fallback + stderr', () => {
  const t = { friction_meta: { profile_applied: 'iron_condor' },
              symbol: 'SLV',
              market_data: { entry_price: 0.5, size: 2 } };
  assert.equal(exposurePerTrade(t), 0.5 * 2 * 100 * 10); // 1000
});

test('exposurePerTrade: unknown profile -> entry × size (defensive default)', () => {
  const t = { friction_meta: { profile_applied: 'unknown' },
              market_data: { entry_price: 100, size: 10 } };
  assert.equal(exposurePerTrade(t), 1000);
});

import { gateForCategory } from './significance-gate.mjs';

const STOCK_LOSER = (pl) => ({
  friction_meta: { profile_applied: 'stocks' },
  market_data: { entry_price: 100, size: 50, friction_adjusted_pl: pl },
});

test('gateForCategory: 5 losing trades but low drawdown -> CLEARED via losses gate', () => {
  const trades = [
    STOCK_LOSER(-50), STOCK_LOSER(-30), STOCK_LOSER(-20),
    STOCK_LOSER(-10), STOCK_LOSER(-5),
  ];
  const result = gateForCategory('stocks', trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.equal(result.cleared, true);
  assert.equal(result.losing_count, 5);
});

test('gateForCategory: 2 losses, dd above the configured threshold -> CLEARED via drawdown gate', () => {
  const trades = [
    STOCK_LOSER(-200), STOCK_LOSER(-100),
    { friction_meta: { profile_applied: 'stocks' }, market_data: { entry_price: 100, size: 50, friction_adjusted_pl: 50 } },
  ];
  // exposure: 3 × 5000 = 15000. Losses sum: 300. dd = 300/15000 = 0.02 (2%).
  // Configured gate at 1% so this clears via drawdown despite only 2 losses.
  const result = gateForCategory('stocks', trades, { min_losing_trades: 5, min_drawdown_pct: 0.01 });
  assert.equal(result.cleared, true);
});

test('gateForCategory: 3 losses with 2% drawdown -> BLOCKED', () => {
  const trades = [
    STOCK_LOSER(-50), STOCK_LOSER(-30), STOCK_LOSER(-20),
  ];
  // exposure: 3 × 5000 = 15000. losses: 100. dd = 0.0067.
  const result = gateForCategory('stocks', trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.equal(result.cleared, false);
  assert.match(result.reason, /below/i);
});

test('gateForCategory: empty category -> BLOCKED', () => {
  const result = gateForCategory('stocks', [], { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.equal(result.cleared, false);
});

test('gateForCategory: IC with explicit wing_width fires drawdown gate correctly', () => {
  // 1 IC, $500 max-loss, $100 loss = 20% loss-on-exposure
  const trades = [{
    friction_meta: { profile_applied: 'iron_condor' },
    symbol: 'SPY',
    market_data: { entry_price: 0.5, size: 1, wing_width: 5, friction_adjusted_pl: -100 },
  }];
  const result = gateForCategory('iron_condor', trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  // exposure: 5 × 1 × 100 = 500. losing_pl_abs: 100. dd: 0.20.
  assert.equal(result.cleared, true);
  assert.equal(+result.drawdown_pct.toFixed(2), 0.20);
});

test('gateForCategory: IC under OLD entry-price denominator would falsely clear on tiny losses', () => {
  // Demonstrates the bug being fixed: old denominator would be 0.5 × 1 × 100 = 50;
  // a $100 loss looks like 200% drawdown and trivially clears.
  // With wing_width-based denom: 500 → 20% — meaningful and correctly clears.
  const trades = [{
    friction_meta: { profile_applied: 'iron_condor' },
    symbol: 'SPY',
    market_data: { entry_price: 0.5, size: 1, wing_width: 5, friction_adjusted_pl: -10 }, // tiny loss
  }];
  const result = gateForCategory('iron_condor', trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  // dd = 10 / 500 = 0.02 < 0.05 AND losses (1) < 5 -> BLOCKED (correct)
  assert.equal(result.cleared, false);
});

import { evaluateGate } from './significance-gate.mjs';

test('evaluateGate: groups trades by friction_meta.profile_applied', () => {
  const trades = [
    { friction_meta: { profile_applied: 'stocks' }, market_data: { entry_price: 100, size: 10, friction_adjusted_pl: -50 } },
    { friction_meta: { profile_applied: 'stocks' }, market_data: { entry_price: 100, size: 10, friction_adjusted_pl: -80 } },
    { friction_meta: { profile_applied: 'single_leg_options' }, market_data: { entry_price: 5, size: 2, friction_adjusted_pl: 100 } },
  ];
  const result = evaluateGate(trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.ok(result.by_category.stocks);
  assert.ok(result.by_category.single_leg_options);
  assert.equal(result.by_category.stocks.trade_count, 2);
  assert.equal(result.by_category.single_leg_options.trade_count, 1);
});

test('evaluateGate: missing profile_applied -> unknown bucket, BLOCKED', () => {
  const trades = [
    { market_data: { entry_price: 100, size: 10, friction_adjusted_pl: -50 } },
  ];
  const result = evaluateGate(trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.ok(result.by_category.unknown);
  assert.equal(result.by_category.unknown.cleared, false);
});

test('evaluateGate: cleared_categories and blocked_categories populated', () => {
  const trades = [
    // 5 losing stocks → clears via losses gate
    ...[1,2,3,4,5].map(() => ({
      friction_meta: { profile_applied: 'stocks' },
      market_data: { entry_price: 100, size: 10, friction_adjusted_pl: -50 },
    })),
    // 1 option, no losses → blocked
    { friction_meta: { profile_applied: 'single_leg_options' },
      market_data: { entry_price: 5, size: 2, friction_adjusted_pl: 100 } },
  ];
  const result = evaluateGate(trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.ok(result.cleared_categories.includes('stocks'));
  assert.ok(result.blocked_categories.includes('single_leg_options'));
});
