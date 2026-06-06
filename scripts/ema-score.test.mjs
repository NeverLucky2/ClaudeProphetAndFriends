// scripts/ema-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideEma } from './ema-score.mjs';

const floor = { trades: 100, distinct_dates: 40 };

test('KEEP-CANDIDATE only when both benchmarks pass AND train alpha positive', () => {
  const v = decideEma({
    alphaSPY: { lo: 0.001, n: 200 }, alphaQQQ: { lo: 0.0005, n: 200 },
    trainAlpha: 0.0008, nTrades: 200, distinctDates: 60, powerFloor: floor });
  assert.equal(v.verdict, 'KEEP-CANDIDATE');
});

test('REJECT if either benchmark CI includes zero', () => {
  const v = decideEma({
    alphaSPY: { lo: 0.001, n: 200 }, alphaQQQ: { lo: -0.0002, n: 200 },
    trainAlpha: 0.0008, nTrades: 200, distinctDates: 60, powerFloor: floor });
  assert.equal(v.verdict, 'REJECT');
});

test('REJECT if train alpha not positive (no sign-consistency)', () => {
  const v = decideEma({
    alphaSPY: { lo: 0.001, n: 200 }, alphaQQQ: { lo: 0.001, n: 200 },
    trainAlpha: -0.0001, nTrades: 200, distinctDates: 60, powerFloor: floor });
  assert.equal(v.verdict, 'REJECT');
});

test('UNDERPOWERED takes precedence on thin samples', () => {
  const v = decideEma({
    alphaSPY: { lo: 0.01, n: 50 }, alphaQQQ: { lo: 0.01, n: 50 },
    trainAlpha: 0.01, nTrades: 50, distinctDates: 10, powerFloor: floor });
  assert.equal(v.verdict, 'UNDERPOWERED');
});
