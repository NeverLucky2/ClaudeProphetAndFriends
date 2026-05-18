import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectAssetClass } from './apply-friction.mjs';

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
