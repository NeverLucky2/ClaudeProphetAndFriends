import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, enumerateFreshTrades } from './coil-threshold-build.mjs';

test('bucketOf maps RSI to the pre-registered buckets', () => {
  assert.equal(bucketOf(2), '[0,5)');
  assert.equal(bucketOf(5), '[5,8)');
  assert.equal(bucketOf(8), '[8,10)');
  assert.equal(bucketOf(10), '[10,15)');
  assert.equal(bucketOf(15), null);
});

// Build 230 bars: uptrend, then engineer two separate pullback dips far enough apart
// that a fresh trade can close before the second. We assert one-per-ticker dedup: while a
// simulated position is open, intervening signals do NOT create extra trades.
function seriesWithTwoDips() {
  const L = 230, c = [];
  for (let i = 0; i < L; i += 1) c[i] = 100 + 0.2 * i;
  // dip A around idx 212-214, dip B around idx 224-226
  for (const base of [212, 224]) for (let k = 0; k < 3; k += 1) c[base + k] = c[base - 1] - 1.5 * (k + 1);
  return c.map((close, i) => ({ date: `2026-${String(1 + Math.floor(i / 31)).padStart(2, '0')}-${String(1 + (i % 31)).padStart(2, '0')}`, open: close, high: close + 0.5, low: close - 0.5, close }));
}

test('enumerateFreshTrades dedups overlapping same-name signals (one open at a time)', () => {
  const bars = seriesWithTwoDips();
  const trades = enumerateFreshTrades(bars, { rsiMax: 15, earningsDates: [] });
  // Every trade's entry idx must be strictly after the prior trade's exit bar.
  for (let i = 1; i < trades.length; i += 1) {
    assert.ok(trades[i].idx > trades[i - 1].idx + trades[i - 1].daysHeld,
      `trade ${i} entered before prior exit`);
  }
  assert.ok(trades.length >= 1);
  for (const t of trades) assert.ok(['[0,5)', '[5,8)', '[8,10)', '[10,15)'].includes(t.bucket));
});

test('enumerateFreshTrades drops entries with forward earnings', () => {
  const bars = seriesWithTwoDips();
  const all = enumerateFreshTrades(bars, { rsiMax: 15, earningsDates: [] });
  assert.ok(all.length >= 1);
  // Put an earnings date within 5 bars after the first trade's entry → that entry is skipped.
  const firstIdx = all[0].idx;
  const earnings = [bars[firstIdx + 2].date];
  const filtered = enumerateFreshTrades(bars, { rsiMax: 15, earningsDates: earnings });
  assert.ok(!filtered.some(t => t.idx === firstIdx), 'pre-earnings entry should be dropped');
});

test('enumerateFreshTrades records exitDate at idx+daysHeld', () => {
  const bars = seriesWithTwoDips();
  for (const tr of enumerateFreshTrades(bars, { rsiMax: 15, earningsDates: [] })) {
    if (!tr.censored) assert.equal(tr.exitDate, bars[tr.idx + tr.daysHeld].date);
  }
});
