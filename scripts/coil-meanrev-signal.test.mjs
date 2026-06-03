import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilderRSI, sma, entryFires, enumerateInstances } from './coil-meanrev-signal.mjs';

test('wilderRSI(2) matches the hand-computed value', () => {
  // closes [10,11,12,11,10]: seed gains 1,1 -> after recursion RS=0.25/0.75 -> RSI=25
  assert.ok(Math.abs(wilderRSI([10, 11, 12, 11, 10], 2) - 25) < 1e-9);
});
test('wilderRSI edge cases', () => {
  assert.equal(wilderRSI([1, 2, 3], 2), 100);   // all gains
  assert.equal(wilderRSI([3, 2, 1], 2), 0);     // all losses
});
test('sma includes the current bar', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 4, 5), 3); // mean of all 5 through idx 4
});
test('entryFires requires rsi2<5 AND close>sma200 AND close<sma5', () => {
  // 210 bars: start at 200, drop to 50 at bar 50, recover gradually to bar 195 (~165),
  // then dip linearly from 165 to 140 over bars 195-209.
  // RSI2: many early losses (200->50 at bar 50), then mostly gains (50->165), then losses at end (165->140)
  // -> RSI2 = 0 (final period is all losses)
  // sma200: mean of all 200 bars ≈ 130.01
  // sma5: mean of last 5 (160,155,150,145,140) = 150
  // close(209) = 140 > 130.01? Yes. 140 < 150? Yes.
  const closes = new Array(210);
  for (let i = 0; i < 50; i++) closes[i] = 200;
  for (let i = 50; i < 195; i++) closes[i] = 50 + (i - 50) * 0.8;
  for (let i = 195; i < 205; i++) closes[i] = 165;
  closes[205] = 160; closes[206] = 155; closes[207] = 150; closes[208] = 145; closes[209] = 140;
  const i = 209;
  assert.equal(entryFires(closes, i), true);
});
test('enumerateInstances returns firing indices with >=210 bars of history', () => {
  const closes = new Array(210);
  for (let i = 0; i < 50; i++) closes[i] = 200;
  for (let i = 50; i < 195; i++) closes[i] = 50 + (i - 50) * 0.8;
  for (let i = 195; i < 205; i++) closes[i] = 165;
  closes[205] = 160; closes[206] = 155; closes[207] = 150; closes[208] = 145; closes[209] = 140;
  const bars = closes.map((c, k) => ({ date: `d${k}`, close: c, open: c, high: c, low: c, volume: 1 }));
  const idxs = enumerateInstances(bars).map(x => x.idx);
  assert.deepEqual(idxs, [209]);
});
