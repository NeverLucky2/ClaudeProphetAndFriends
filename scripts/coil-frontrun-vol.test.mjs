import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOL_WINDOW, realizedVolSeries, tercileBoundaries, tercileOf } from './coil-frontrun-vol.mjs';

const barsOf = (closes) => closes.map((c, i) => ({ date: `d${String(i).padStart(3, '0')}`, close: c }));

test('VOL_WINDOW is the pre-registered 20 sessions', () => {
  assert.equal(VOL_WINDOW, 20);
});

test('realizedVolSeries is empty until `window` returns exist', () => {
  const bars = barsOf(Array.from({ length: 10 }, (_, i) => 100 + i));
  assert.equal(realizedVolSeries(bars, 5).has('d004'), false);
  assert.equal(realizedVolSeries(bars, 5).has('d005'), true);
});

test('realizedVolSeries: a constant-growth series has ~zero volatility', () => {
  const bars = barsOf(Array.from({ length: 30 }, (_, i) => 100 * 1.01 ** i));
  const v = realizedVolSeries(bars, 5);
  assert.ok(v.get('d029') < 1e-9, 'constant log-return => zero stdev');
});

test('realizedVolSeries: a choppy series has higher vol than a smooth one', () => {
  const smooth = barsOf(Array.from({ length: 30 }, (_, i) => 100 + i));
  const choppy = barsOf(Array.from({ length: 30 }, (_, i) => 100 + i + (i % 2 ? 6 : -6)));
  assert.ok(realizedVolSeries(choppy, 10).get('d029') > realizedVolSeries(smooth, 10).get('d029'));
});

test('tercileBoundaries splits a uniform sample into thirds', () => {
  const vals = Array.from({ length: 300 }, (_, i) => i);
  const b = tercileBoundaries(vals);
  assert.equal(b.lo, 100);
  assert.equal(b.hi, 200);
});

test('tercileBoundaries returns null on a degenerate sample', () => {
  assert.equal(tercileBoundaries([1, 2]), null);
});

test('tercileOf assigns low/mid/high on the frozen boundaries', () => {
  const b = { lo: 10, hi: 20 };
  assert.equal(tercileOf(5, b), 'low');
  assert.equal(tercileOf(10, b), 'low');   // inclusive lower edge
  assert.equal(tercileOf(15, b), 'mid');
  assert.equal(tercileOf(20, b), 'mid');   // inclusive
  assert.equal(tercileOf(25, b), 'high');
  assert.equal(tercileOf(NaN, b), null);
  assert.equal(tercileOf(null, b), null);
});
