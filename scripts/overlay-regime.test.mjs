// scripts/overlay-regime.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateShockWeeks, splitCrisis, countEpisodes, riskFreeDaily } from './overlay-regime.mjs';

test('rateShockWeeks flags top-decile weekly Δy10 indices', () => {
  // 10 weeks; week 5 has the biggest y10 jump.
  const weeklyY10 = [2.0, 2.0, 2.0, 2.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0]; // Δ at index 4 = +1.0
  const set = rateShockWeeks(weeklyY10, { topFrac: 0.1 });
  assert.ok(set.has(4));
  assert.equal(set.size, 1);
});

test('splitCrisis partitions crisis indices by rate-shock membership', () => {
  const { rateShockIdx, growthScareIdx } = splitCrisis([2, 4, 7], new Set([4]));
  assert.deepEqual(rateShockIdx, [4]);
  assert.deepEqual(growthScareIdx, [2, 7]);
});

test('countEpisodes counts contiguous runs', () => {
  assert.equal(countEpisodes([1, 2, 3, 7, 8, 20]), 3);
  assert.equal(countEpisodes([]), 0);
});

test('riskFreeDaily forward-fills m3 and accrues per-day', () => {
  const curve = [{ date: '2020-01-02', m3: 1.512 }, { date: '2020-01-06', m3: 2.52 }];
  const rf = riskFreeDaily(curve, ['2020-01-02', '2020-01-03', '2020-01-06']);
  assert.ok(Math.abs(rf.get('2020-01-03') - (1.512 / 100) / 252) < 1e-12); // ffilled from 01-02
  assert.ok(Math.abs(rf.get('2020-01-06') - (2.52 / 100) / 252) < 1e-12);
});
