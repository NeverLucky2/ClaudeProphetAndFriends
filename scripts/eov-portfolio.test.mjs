import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardReturnOpenToOpen, dailySpread } from './eov-portfolio.mjs';

test('forwardReturnOpenToOpen is open(T+1+h)/open(T+1)-1', () => {
  const dates = ['D0', 'D1', 'D2', 'D3', 'D4'];
  const open = new Map([['D0', 10], ['D1', 11], ['D2', 12], ['D3', 13], ['D4', 14]]);
  // t=0 -> entry D1(11), exit D1+3=D4(14) -> 14/11-1
  assert.ok(Math.abs(forwardReturnOpenToOpen(open, dates, 0, 3) - (14 / 11 - 1)) < 1e-12);
  assert.equal(forwardReturnOpenToOpen(open, dates, 3, 3), null); // exit out of range
});

test('dailySpread = mean(top-k) - mean(bottom-k), null if too few names', () => {
  const rank = { A: 1.0, B: 0.8, C: 0.6, D: 0.4, E: 0.2, F: 0.0 };
  const ret = { A: 0.05, B: 0.04, C: 0.03, D: 0.02, E: 0.01, F: 0.00 };
  const r = dailySpread(rank, ret, 2);
  // top2 = A,B (0.045 mean); bottom2 = F,E (0.005 mean) -> 0.04
  assert.ok(Math.abs(r.spread - 0.04) < 1e-12);
  assert.deepEqual(r.top.sort(), ['A', 'B']);
  assert.deepEqual(r.bottom.sort(), ['E', 'F']);
  assert.equal(dailySpread({ A: 1, B: 0 }, { A: 0.1, B: 0 }, 2), null); // need 2*k=4
});
