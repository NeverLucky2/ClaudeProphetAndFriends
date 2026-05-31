// scripts/binomial-stats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invNorm, binomialPowerN, binomialUpperTailP } from './binomial-stats.mjs';

test('invNorm matches known quantiles', () => {
  assert.ok(Math.abs(invNorm(0.95) - 1.6448536) < 1e-4);
  assert.ok(Math.abs(invNorm(0.80) - 0.8416212) < 1e-4);
  assert.ok(Math.abs(invNorm(0.5) - 0) < 1e-6);
});

test('binomialPowerN: HR0=0.55 HR1=0.63 alpha=0.05 power=0.80 -> 235', () => {
  assert.equal(binomialPowerN(0.55, 0.63, 0.05, 0.80), 235);
});

test('binomialPowerN rejects p1 <= p0', () => {
  assert.throws(() => binomialPowerN(0.55, 0.55, 0.05, 0.80));
});

test('binomialUpperTailP matches exact reference P(X>=8 | n=10, p=0.5)=0.0546875', () => {
  // exact: (C(10,8)+C(10,9)+C(10,10))/1024 = 56/1024
  assert.ok(Math.abs(binomialUpperTailP(8, 10, 0.5) - 0.0546875) < 1e-6);
});

test('binomialUpperTailP edge cases', () => {
  assert.equal(binomialUpperTailP(0, 10, 0.5), 1);          // P(X>=0) = 1
  assert.ok(Math.abs(binomialUpperTailP(10, 10, 0.5) - Math.pow(0.5, 10)) < 1e-9);
});
