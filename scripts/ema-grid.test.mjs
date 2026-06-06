// scripts/ema-grid.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gridConfigs } from './ema-grid.mjs';

test('grid varies one knob at a time off the primary (no cartesian blowup)', () => {
  const primary = { fast: 25, slow: 75, W: 10, kStop: 1.5, kTarget: 1.5, maxHold: 10, cci: false, width_filter: false };
  const grid = { ema_pairs: [[10, 30], [20, 50], [50, 150]], W: [5, 20], kStop: [1.0, 2.0], kTarget: [1.0, 3.0], maxHold: [5, 20], width_filter: [true], cci: [true] };
  const cfgs = gridConfigs(primary, grid);
  // 3 ema pairs + 2 W + 2 kStop + 2 kTarget + 2 maxHold + 1 width + 1 cci + 1 primary = 14
  assert.equal(cfgs.length, 14);
  assert.ok(cfgs.some(c => c.label === 'primary'));
  assert.ok(cfgs.every(c => typeof c.fast === 'number'));
});
