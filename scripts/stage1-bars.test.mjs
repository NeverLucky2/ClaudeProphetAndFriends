// scripts/stage1-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ret, priceState, forwardReturn } from './stage1-bars.mjs';

// 30 bars, close = 100,101,...,129; open = close - 0.5
function mkBars(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const close = 100 + i;
    out.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: close - 0.5, high: close + 1, low: close - 1, close });
  }
  return out;
}

test('sma + ret over trailing window', () => {
  const bars = mkBars(30);
  // SMA20 ending at idx 25 = mean(close[6..25]) = mean(106..125) = 115.5
  assert.equal(sma(bars, 25, 20), 115.5);
  // ret5d at idx 25 = 125/120 - 1
  assert.ok(Math.abs(ret(bars, 25, 5) - (125 / 120 - 1)) < 1e-12);
});

test('priceState: rising series is bullish (+1), insufficient history is 0', () => {
  const bars = mkBars(30);
  assert.equal(priceState(bars, 25), 1);   // close>SMA20 and ret5d>0
  assert.equal(priceState(bars, 10), 0);   // idx<19, not enough for SMA20 -> neutral
});

test('forwardReturn: long captures up-move, uses entry=open[d+1], exit=close[d+H]', () => {
  const bars = mkBars(30);
  const d = 20;
  const r = forwardReturn(bars, d, 3, +1);
  const expected = bars[23].close / bars[21].open - 1;
  assert.ok(Math.abs(r.R - expected) < 1e-12);
  assert.equal(r.hit, true);
  assert.equal(r.entryIdx, 21);
  assert.equal(r.exitIdx, 23);
});

test('forwardReturn short flips sign', () => {
  const bars = mkBars(30);
  const r = forwardReturn(bars, 20, 3, -1);
  assert.equal(r.hit, false); // up-move, short loses
});

test('forwardReturn lookahead guard: null when fewer than H future bars', () => {
  const bars = mkBars(23); // last index 22
  assert.equal(forwardReturn(bars, 20, 3, +1), null); // needs idx 23 -> unavailable
});
