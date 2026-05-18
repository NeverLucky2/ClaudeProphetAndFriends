import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectAssetClass, isStopOut } from './apply-friction.mjs';

test('detectAssetClass: harvest agent always returns iron_condor', () => {
  assert.equal(detectAssetClass({ symbol: 'SPY', reasoning: '' }, 'harvest'), 'iron_condor');
  assert.equal(detectAssetClass({ symbol: 'QQQ260515C00712000', reasoning: '' }, 'harvest'), 'iron_condor');
});

test('detectAssetClass: OCC + IC marker in reasoning -> iron_condor', () => {
  const action = { symbol: 'SPY260620P00400000', reasoning: 'opened iron condor on SPY' };
  assert.equal(detectAssetClass(action, 'default'), 'iron_condor');
});

test('detectAssetClass: OCC + "IC" abbreviation -> iron_condor', () => {
  const action = { symbol: 'SPY260620P00400000', reasoning: 'IC at 400/410/430/440' };
  assert.equal(detectAssetClass(action, 'default'), 'iron_condor');
});

test('detectAssetClass: OCC + "4-leg" -> iron_condor', () => {
  const action = { symbol: 'SPY260620P00400000', reasoning: '4-leg structure' };
  assert.equal(detectAssetClass(action, 'default'), 'iron_condor');
});

test('detectAssetClass: OCC without IC marker -> single_leg_options', () => {
  const action = { symbol: 'QQQ260515C00712000', reasoning: 'long call' };
  assert.equal(detectAssetClass(action, 'default'), 'single_leg_options');
});

test('detectAssetClass: plain ticker + penny-prophet -> penny_stocks', () => {
  assert.equal(detectAssetClass({ symbol: 'ABCD', reasoning: '' }, 'penny-prophet'), 'penny_stocks');
});

test('detectAssetClass: plain ticker + default agent -> stocks', () => {
  assert.equal(detectAssetClass({ symbol: 'SPY', reasoning: '' }, 'default'), 'stocks');
});

test('detectAssetClass: plain ticker + trend-prophet -> stocks', () => {
  assert.equal(detectAssetClass({ symbol: 'AAPL', reasoning: '' }, 'trend-prophet'), 'stocks');
});

test('detectAssetClass: unrecognized symbol shape -> null (skip)', () => {
  assert.equal(detectAssetClass({ symbol: 'weird-thing-not-a-ticker-or-occ', reasoning: '' }, 'default'), null);
});

test('detectAssetClass: missing symbol -> null', () => {
  assert.equal(detectAssetClass({ reasoning: '' }, 'default'), null);
});

test('isStopOut: "stop hit" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stop hit at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "stopped out" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stopped out at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "stop triggered" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stop triggered at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "hit my stop" + losing P&L -> true', () => {
  const action = { reasoning: 'Position hit my stop at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "hit stop" + losing P&L -> true', () => {
  const action = { reasoning: 'Position hit stop at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "stop loss fired" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stop loss fired at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "SL hit" + losing P&L -> true', () => {
  const action = { reasoning: 'Position SL hit at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "stop loss triggered" + losing P&L -> true', () => {
  const action = { reasoning: 'Position stop loss triggered at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: "forced out" + losing P&L -> true', () => {
  const action = { reasoning: 'Position forced out at -12%', market_data: { unrealized_pct: -12 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: stop phrase but POSITIVE P&L -> false (not really a stop)', () => {
  const action = { reasoning: 'stop hit but ended up positive', market_data: { unrealized_pct: 2 } };
  assert.equal(isStopOut(action), false);
});

test('isStopOut: no stop phrase -> false', () => {
  const action = { reasoning: 'closing for profit', market_data: { unrealized_pct: -5 } };
  assert.equal(isStopOut(action), false);
});

test('isStopOut: case-insensitive matching', () => {
  const action = { reasoning: 'STOPPED OUT at the low', market_data: { unrealized_pct: -8 } };
  assert.equal(isStopOut(action), true);
});

test('isStopOut: missing market_data -> false (cannot confirm losing P&L)', () => {
  assert.equal(isStopOut({ reasoning: 'stop hit' }), false);
});

import { computeStockFriction } from './apply-friction.mjs';

const STOCK_PROFILE = {
  per_share_slippage_usd: 0.02,
  stop_gap_through_pct: 0.003,
  commission_per_share: 0.0,
  regulatory_fee_per_share: 0.0001,
};

test('computeStockFriction: round trip with no stop-out', () => {
  // 100 shares, no stop. Per-side: (0.02 + 0.0001) × 100 = 2.01. Round trip = 4.02.
  const action = { market_data: { entry_price: 100, exit_price: 102, size: 100 } };
  const result = computeStockFriction(action, STOCK_PROFILE, false);
  assert.equal(result.haircut_total_usd, 4.02);
  assert.equal(result.haircut_breakdown.slippage, 4.0);
  assert.equal(result.haircut_breakdown.regulatory_fees, 0.02);
});

test('computeStockFriction: stop-out adds gap-through extra', () => {
  // Base haircut 4.02 (above). Stop adds 0.003 × 100 × 100 = 30.
  const action = { market_data: { entry_price: 100, exit_price: 88, size: 100 } };
  const result = computeStockFriction(action, STOCK_PROFILE, true);
  assert.equal(result.haircut_total_usd, 34.02);
  assert.equal(result.haircut_breakdown.stop_gap_through, 30);
});

test('computeStockFriction: missing size -> throws clear error', () => {
  const action = { market_data: { entry_price: 100, exit_price: 102 } };
  assert.throws(() => computeStockFriction(action, STOCK_PROFILE, false), /size/);
});
