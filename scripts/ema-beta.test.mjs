// scripts/ema-beta.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { olsBeta, benchReturnOverWindow, residual } from './ema-beta.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('olsBeta recovers a known slope', () => {
  const bench = [0.01, -0.02, 0.03, -0.01, 0.02];
  const asset = bench.map(x => 2 * x + 0.001);   // beta 2
  approx(olsBeta(asset, bench), 2, 1e-6);
});

test('benchReturnOverWindow uses entry/exit closes', () => {
  const byDate = new Map([['2020-01-02', { close: 100 }], ['2020-01-10', { close: 110 }]]);
  approx(benchReturnOverWindow(byDate, '2020-01-02', '2020-01-10'), 0.1);
});

test('residual subtracts sign-aware market exposure', () => {
  approx(residual(0.05, { direction: 1, beta: 1.2, benchRet: 0.03 }), 0.05 - 1.2 * 0.03);
  // short: gains when market falls → exposure is -beta → residual = net + beta*benchRet
  approx(residual(0.05, { direction: -1, beta: 1.2, benchRet: 0.03 }), 0.05 + 1.2 * 0.03);
});
