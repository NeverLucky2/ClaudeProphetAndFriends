// scripts/orb-indicators.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionVWAP } from './orb-indicators.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('sessionVWAP is cumulative Σ(tp·vol)/Σ(vol), aligned to bars', () => {
  const bars = [
    { high: 10, low: 10, close: 10, volume: 100 }, // tp 10
    { high: 12, low: 12, close: 12, volume: 300 }, // tp 12
  ];
  const v = sessionVWAP(bars);
  approx(v[0], 10);
  approx(v[1], (10 * 100 + 12 * 300) / 400); // 11.5
});
test('zero-volume bars do not divide-by-zero (carry prior vwap)', () => {
  const bars = [{ high: 5, low: 5, close: 5, volume: 0 }];
  assert.ok(Number.isFinite(sessionVWAP(bars)[0]));
});
