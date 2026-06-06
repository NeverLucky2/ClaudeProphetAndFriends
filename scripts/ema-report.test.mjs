// scripts/ema-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alphaByYear, sliceFrom, sliceBefore } from './ema-report.mjs';

test('alphaByYear groups residual rows by calendar year', () => {
  const rows = [
    { date: '2018-03-01', net: 0.01 }, { date: '2018-09-01', net: 0.03 },
    { date: '2020-05-01', net: -0.02 },
  ];
  const a = alphaByYear(rows);
  assert.equal(a.length, 2);
  assert.deepEqual(a[0], { year: '2018', n: 2, mean: 0.02 });
  assert.deepEqual(a[1], { year: '2020', n: 1, mean: -0.02 });
});

test('sliceFrom / sliceBefore split on the author-window boundary', () => {
  const rows = [{ date: '2023-01-01', net: 1 }, { date: '2024-06-01', net: 2 }, { date: '2025-01-01', net: 3 }];
  assert.deepEqual(sliceFrom(rows, '2024-06-01').map(r => r.net), [2, 3]);
  assert.deepEqual(sliceBefore(rows, '2024-06-01').map(r => r.net), [1]);
});
