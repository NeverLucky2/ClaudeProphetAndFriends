// scripts/ema-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateEmaTrades } from './ema-build.mjs';

function bar(c) { return { date: `d${c}`, open: c, high: c + 1, low: c - 1, close: c }; }

test('enumerates non-overlapping trades with direction + exitDate', () => {
  const closes = [];
  for (let i = 0; i < 120; i += 1) closes.push(100 + i);
  closes.push(80); closes.push(225);          // coherent long setup ~ idx 121
  for (let i = 0; i < 10; i += 1) closes.push(226 + i);
  const bars = closes.map((c, i) => ({ date: `2008-${String(i).padStart(3, '0')}`, open: c, high: c + 1, low: c - 1, close: c }));
  const trades = enumerateEmaTrades(bars, { fast: 25, slow: 75, W: 10, kStop: 1.5, kTarget: 1.5, maxHold: 10, warmup: 80 });
  assert.ok(trades.length >= 1);
  for (const t of trades) {
    assert.ok(t.direction === 1 || t.direction === -1);
    assert.ok(t.idx >= 80);
    assert.ok(t.exitDate === null || t.exitDate > t.date);
  }
  // non-overlap: each trade starts after the prior one's exit index
  for (let i = 1; i < trades.length; i += 1) assert.ok(trades[i].idx > trades[i - 1].idx + trades[i - 1].daysHeld - 1);
});
