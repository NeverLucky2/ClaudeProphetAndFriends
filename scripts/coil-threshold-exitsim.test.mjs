import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryFiresAt, simulateTrade } from './coil-threshold-exitsim.mjs';
import { entryFires } from './coil-meanrev-signal.mjs';

// Build a 220-bar series: long uptrend then a sharp multi-day pullback so RSI(2) is low
// and close sits below SMA5 but above SMA200 at the last bar.
function pullbackCloses() {
  const L = 220, closes = [];
  for (let i = 0; i <= L - 6; i += 1) closes[i] = 100 + 0.2 * i;
  const peak = closes[L - 6];
  for (let i = L - 5; i < L; i += 1) closes[i] = peak - 0.5 * (i - (L - 6));
  return closes;
}

test('entryFiresAt at rsiMax=5 equals the production entryFires', () => {
  const closes = pullbackCloses();
  const idx = closes.length - 1;
  assert.equal(entryFiresAt(closes, idx, 5), entryFires(closes, idx));
});

test('entryFiresAt is monotonic in rsiMax (15 is a superset of 5)', () => {
  const closes = pullbackCloses();
  const idx = closes.length - 1;
  if (entryFiresAt(closes, idx, 5)) assert.equal(entryFiresAt(closes, idx, 15), true);
});

test('entryFiresAt still enforces SMA gates regardless of rsiMax', () => {
  // close ABOVE sma5 must never fire, even at a very loose RSI bound.
  const L = 220, closes = [];
  for (let i = 0; i < L; i += 1) closes[i] = 100 + 0.2 * i; // pure uptrend, close>sma5
  assert.equal(entryFiresAt(closes, L - 1, 100), false);
});

test('entryFiresAt returns false before MIN_BARS history', () => {
  const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
  assert.equal(entryFiresAt(closes, 49, 15), false);
});

// bar helper
const B = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });

test('simulateTrade: -7% intraday stop fills at the stop price', () => {
  // entry close = 100; day+1 dips to low 92 (< 93 stop) but opens 99
  const bars = [B('d0', 100, 100, 100, 100), B('d1', 99, 99, 92, 95)];
  const t = simulateTrade(bars, 0);
  assert.equal(t.exitReason, 'stop');
  assert.equal(t.exit, 93);                 // entry*0.93
  assert.equal(t.daysHeld, 1);
  assert.ok(Math.abs(t.grossReturn - (-0.07)) < 1e-9);
});

test('simulateTrade: gap-through stop fills at the open', () => {
  const bars = [B('d0', 100, 100, 100, 100), B('d1', 90, 91, 89, 90)]; // opens below 93
  const t = simulateTrade(bars, 0);
  assert.equal(t.exitReason, 'stop');
  assert.equal(t.exit, 90);                 // filled at the gapped-down open
});

test('simulateTrade: close above SMA5 with RSI<=70 triggers sma5_cross exit', () => {
  // 6 flat bars, a +1 entry, then a small -0.5 pullback whose close still sits above the
  // 5-day SMA. RSI(2) ~= 50 here (a +1 then -0.5), so RSI>70 does NOT fire and the SMA5
  // cross is the trigger — exercising the secondary close-exit with RSI-first precedence.
  const base = [];
  for (let i = 0; i < 6; i += 1) base.push(B('b' + i, 100, 100, 100, 100));
  const bars = [...base, B('entry', 101, 101.5, 100.5, 101), B('d1', 100.7, 100.9, 100.3, 100.5)];
  const entryIdx = bars.length - 2;
  const t = simulateTrade(bars, entryIdx);
  assert.equal(t.exitReason, 'sma5_cross'); // close 100.5 > sma5 100.3; RSI(2) <= 70
  assert.equal(t.exit, 100.5);
});

test('simulateTrade: 5-day time stop exits at close[d+5]', () => {
  // Keep price below stop-trigger and below SMA5, RSI not >70, so only the timeout fires.
  const bars = [B('e', 100, 100, 100, 100)];
  for (let k = 1; k <= 5; k += 1) bars.push(B('d' + k, 96, 96.5, 95, 96)); // 96 > 93 stop, < entry
  const t = simulateTrade(bars, 0);
  assert.equal(t.exitReason, 'time_stop');
  assert.equal(t.daysHeld, 5);
  assert.equal(t.exit, 96);
});

test('simulateTrade: right-censored when data ends before any exit', () => {
  const bars = [B('e', 100, 100, 100, 100), B('d1', 96, 96, 95, 96)]; // only 1 bar after entry
  const t = simulateTrade(bars, 0);
  assert.equal(t.censored, true);
  assert.equal(t.grossReturn, null);
});
