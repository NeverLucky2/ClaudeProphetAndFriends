// scripts/orb-grid.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orbGridConfigs } from './orb-grid.mjs';

test('grid varies one knob at a time off the primary', () => {
  const primary = { or_minutes: 15, target: 'none', ema21_filter: false, vwap_filter: true, breakout_buffer_or_frac: 0 };
  const grid = { or_minutes: [5, 30], target: ['1R', '2R'], ema21_filter: [true], vwap_filter: [false], breakout_buffer_or_frac: [0.05] };
  const cfgs = orbGridConfigs(primary, grid);
  // 1 primary + 2 or + 2 target + 1 ema + 1 vwap + 1 buffer = 8
  assert.equal(cfgs.length, 8);
  assert.ok(cfgs.some(c => c.label === 'primary'));
});
