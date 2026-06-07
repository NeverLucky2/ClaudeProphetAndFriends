// scripts/overlay-book.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookDaily, droppedWeightByYear } from './overlay-book.mjs';

// Two holdings; B has no bar on day 2 → that day weights 100% A (renormalized).
const bars = new Map([
  ['A', [{ date: '2020-01-02', close: 100 }, { date: '2020-01-03', close: 110 }, { date: '2020-01-06', close: 121 }]],
  ['B', [{ date: '2020-01-02', close: 50 }, { date: '2020-01-06', close: 60 }]],
]);
const holdings = [{ symbol: 'A', value: 50 }, { symbol: 'B', value: 50 }];

test('bookDaily renormalizes over available names each day', () => {
  const s = bookDaily(holdings, bars, { start: '2020-01-01', end: '2020-12-31' });
  // 2020-01-03: only A has prior+today bar → ret = 110/100-1 = 0.10
  const d3 = s.find((p) => p.date === '2020-01-03');
  assert.ok(Math.abs(d3.ret - 0.10) < 1e-9);
  // 2020-01-06: A ret = 121/110-1=0.10 (prior day 01-03), B ret = 60/50-1=0.20 (prior available bar 01-02).
  // Equal weight 0.5/0.5 → 0.5*0.10 + 0.5*0.20 = 0.15
  const d6 = s.find((p) => p.date === '2020-01-06');
  assert.ok(Math.abs(d6.ret - 0.15) < 1e-9);
});

test('droppedWeightByYear reports fraction of book value with no bar that year', () => {
  const dw = droppedWeightByYear(holdings, bars, { start: '2020-01-01', end: '2020-12-31' });
  assert.ok(dw['2020'] >= 0 && dw['2020'] <= 1);
});
