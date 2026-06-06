// scripts/ema-indicators.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ema, atrWilder, cci } from './ema-indicators.mjs';

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('ema: null before seed, SMA seed at period-1, then recursive', () => {
  const c = [1, 2, 3, 4, 5];
  const e = ema(c, 3);
  assert.equal(e[0], null);
  assert.equal(e[1], null);
  approx(e[2], 2);                 // SMA(1,2,3)=2 seed
  const k = 2 / (3 + 1);
  approx(e[3], (4 - 2) * k + 2);   // 2.5
  approx(e[4], (5 - e[3]) * k + e[3]);
});

test('atrWilder: seed = SMA of first `period` true ranges at index period', () => {
  // TR uses prev close, so first TR is at index 1; ATR seed lands at index `period`.
  const bars = [
    { high: 10, low: 9, close: 9.5 }, { high: 11, low: 9.5, close: 10.5 },
    { high: 12, low: 10, close: 11 }, { high: 11.5, low: 10.5, close: 11 },
  ];
  const a = atrWilder(bars, 2);
  assert.equal(a[0], null);
  assert.equal(a[1], null);        // need `period` TRs first
  assert.ok(a[2] > 0 && a[3] > 0); // seeded then smoothed
});

test('cci: 0 at flat series midpoint, finite when dispersed', () => {
  const flat = Array.from({ length: 25 }, () => ({ high: 10, low: 10, close: 10 }));
  const cf = cci(flat, 20);
  assert.equal(cf[24], 0);         // mean deviation 0 → defined as 0
  const up = Array.from({ length: 25 }, (_, i) => ({ high: i + 1, low: i, close: i + 0.5 }));
  assert.ok(Number.isFinite(cci(up, 20)[24]));
});
