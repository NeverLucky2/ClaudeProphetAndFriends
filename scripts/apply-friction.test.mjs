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

import { computePennyFriction } from './apply-friction.mjs';

const PENNY_PROFILE = {
  per_share_slippage_usd: 0.01,
  slippage_pct_of_price_floor: 0.02,
  stop_gap_through_pct: 0.015,
  commission_per_share: 0.0,
  regulatory_fee_per_share: 0.0001,
};

test('computePennyFriction: $0.50 stock uses pct floor (0.02 × 0.50 = 0.01 ties with usd floor)', () => {
  // size 1000. Effective per-share = max(0.01, 0.02 × 0.5) = 0.01.
  // Slippage: 0.01 × 1000 × 2 = 20. Reg fees: 0.0001 × 1000 × 2 = 0.2.
  const action = { market_data: { entry_price: 0.5, exit_price: 0.52, size: 1000 } };
  const result = computePennyFriction(action, PENNY_PROFILE, false);
  assert.equal(result.haircut_total_usd, 20.2);
});

test('computePennyFriction: $0.05 stock (pct floor 0.02 × 0.05 = 0.001 < 0.01, so usd 0.01 wins)', () => {
  // Effective = max(0.01, 0.001) = 0.01. Slippage: 0.01 × 1000 × 2 = 20.
  const action = { market_data: { entry_price: 0.05, exit_price: 0.06, size: 1000 } };
  const result = computePennyFriction(action, PENNY_PROFILE, false);
  assert.equal(result.haircut_breakdown.slippage, 20);
});

test('computePennyFriction: $2 stock — pct floor wins (0.02 × 2 = 0.04 > 0.01)', () => {
  // Effective = max(0.01, 0.04) = 0.04. Slippage: 0.04 × 1000 × 2 = 80.
  const action = { market_data: { entry_price: 2.0, exit_price: 2.1, size: 1000 } };
  const result = computePennyFriction(action, PENNY_PROFILE, false);
  assert.equal(result.haircut_breakdown.slippage, 80);
});

test('computePennyFriction: stop-out uses wider gap-through (0.015)', () => {
  const action = { market_data: { entry_price: 2.0, exit_price: 1.5, size: 1000 } };
  const result = computePennyFriction(action, PENNY_PROFILE, true);
  // Stop gap: 0.015 × 2.0 × 1000 = 30.
  assert.equal(result.haircut_breakdown.stop_gap_through, 30);
});

import { computeSingleLegOptionFriction } from './apply-friction.mjs';

const OPT_PROFILE = {
  spread_crossing_pct_open: 0.60,
  spread_crossing_pct_close: 0.65,
  spread_crossing_pct_close_when_losing: 0.75,
  assumed_spread_pct_of_mid: 0.04,
  commission_per_contract: 0.65,
  regulatory_fee_per_contract: 0.05,
};

test('computeSingleLegOptionFriction: winning close uses normal close pct', () => {
  // entry 7.50, exit 8.50, 6 contracts. mid = 8.0, spread_dollars = 0.04 × 8 = 0.32.
  // crossing = 0.60 + 0.65 = 1.25. spread_cost = 0.32 × 1.25 × 6 × 100 = 240.
  // fees = (0.65 + 0.05) × 6 × 2 = 8.4. Total = 248.4.
  const action = { market_data: { entry_price: 7.5, exit_price: 8.5, size: 6 } };
  const result = computeSingleLegOptionFriction(action, OPT_PROFILE);
  assert.equal(result.haircut_total_usd, 248.4);
  assert.equal(result.close_was_losing, false);
});

test('computeSingleLegOptionFriction: losing close uses higher close pct', () => {
  // entry 7.50, exit 6.80, 6 contracts. mid = 7.15. spread_dollars = 0.04 × 7.15 = 0.286.
  // crossing = 0.60 + 0.75 = 1.35. spread_cost = 0.286 × 1.35 × 6 × 100 = 231.66.
  // fees = 8.4. Total ≈ 240.06.
  const action = { market_data: { entry_price: 7.5, exit_price: 6.8, size: 6 } };
  const result = computeSingleLegOptionFriction(action, OPT_PROFILE);
  assert.ok(Math.abs(result.haircut_total_usd - 240.06) < 0.01, `got ${result.haircut_total_usd}`);
  assert.equal(result.close_was_losing, true);
});
