// scripts/ema-signal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalContext, emaPullbackFiresAt, isStalePair } from './ema-signal.mjs';

// Build a long uptrend, force a single coherent dip-then-reclaim, assert it fires once.
function bar(c) { return { high: c + 0.5, low: c - 0.5, close: c, open: c }; }

test('long fires on coherent dip-below-both then first reclaim of fast', () => {
  // rising series → fast>slow; insert a dip below both, then a reclaim close above fast.
  const closes = [];
  for (let i = 0; i < 120; i += 1) closes.push(100 + i);          // strong uptrend
  closes.push(80);                                                 // dip below both EMAs (one bar)
  closes.push(225);                                                // reclaim: close back above fast
  const bars = closes.map(bar);
  const ctx = signalContext(bars, 25, 75);
  const reclaimIdx = bars.length - 1;
  assert.equal(emaPullbackFiresAt(bars, reclaimIdx, { fast: 25, slow: 75, W: 10, direction: 1, ctx }), true);
});

test('does NOT fire on a stale dip with an intervening reclaim', () => {
  const closes = [];
  for (let i = 0; i < 120; i += 1) closes.push(100 + i);
  closes.push(80);    // dip (idx 120)
  closes.push(225);   // intervening reclaim (idx 121) — consumes the dip
  closes.push(190);   // chop/dip again (idx 122)
  closes.push(230);   // today: another reclaim (idx 123) but stale (consumes pierce from 120, not 122)
  const bars = closes.map(bar);
  const ctx = signalContext(bars, 25, 75);
  const today = bars.length - 1;
  assert.equal(emaPullbackFiresAt(bars, today, { fast: 25, slow: 75, W: 10, direction: 1, ctx }), false);
  assert.equal(isStalePair(bars, today, { fast: 25, slow: 75, W: 10, direction: 1, ctx }), true);
});

test('does not fire when trend is not intact (fast<=slow)', () => {
  const closes = Array.from({ length: 120 }, (_, i) => 200 - i); // downtrend → fast<slow
  const bars = closes.map(bar);
  const ctx = signalContext(bars, 25, 75);
  assert.equal(emaPullbackFiresAt(bars, 119, { fast: 25, slow: 75, W: 10, direction: 1, ctx }), false);
});

test('short mirrors: fires on pop-above-both then first close back below fast', () => {
  const closes = [];
  for (let i = 0; i < 120; i += 1) closes.push(300 - i);          // downtrend → fast<slow
  closes.push(260);                                                // pop above both
  closes.push(150);                                                // close back below fast
  const bars = closes.map(bar);
  const ctx = signalContext(bars, 25, 75);
  assert.equal(emaPullbackFiresAt(bars, bars.length - 1, { fast: 25, slow: 75, W: 10, direction: -1, ctx }), true);
});
