import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketAdjustedForward, chronoSplit, feasibility } from './coil-eventstudy-build.mjs';

test('marketAdjustedForward subtracts the SPY forward return over the same dates', () => {
  // ticker rises 10% open[d+1]->close[d+H]; SPY rises 4%; H=2.
  const tk = [{ date: 'a', open: 0, high: 0, low: 0, close: 0, volume: 1 },
              { date: 'b', open: 100, high: 0, low: 0, close: 0, volume: 1 },
              { date: 'c', open: 0, high: 0, low: 0, close: 110, volume: 1 }];
  const spy = [{ date: 'a', open: 0, close: 0 }, { date: 'b', open: 100, close: 0 }, { date: 'c', open: 0, close: 104 }];
  const r = marketAdjustedForward(tk, 0, spy, 2);
  assert.ok(Math.abs(r - (0.10 - 0.04)) < 1e-9);
});

test('marketAdjustedForward null when SPY lacks the aligned dates', () => {
  const tk = [{ date: 'a', open: 1, close: 1 }, { date: 'b', open: 1, close: 1 }, { date: 'c', open: 1, close: 1 }];
  assert.equal(marketAdjustedForward(tk, 0, [{ date: 'z', open: 1, close: 1 }], 2), null);
});

test('chronoSplit is 50/50 by date order', () => {
  const inst = [{ date: '2022-01-01' }, { date: '2022-02-01' }, { date: '2022-03-01' }, { date: '2022-04-01' }];
  const { train, holdout } = chronoSplit(inst);
  assert.equal(train.length, 2); assert.equal(holdout.length, 2);
  assert.equal(train.every(x => x.split === 'train'), true);
});

test('feasibility counts non-null market-adjusted returns per bucket', () => {
  const inst = [
    { bucket: 'catalyst', madj: { 5: 0.01 } }, { bucket: 'catalyst', madj: { 5: null } },
    { bucket: 'clean', madj: { 5: -0.02 } },
  ];
  const fc = feasibility(inst, 5);
  assert.equal(fc.catalyst, 1); assert.equal(fc.clean, 1);
});
