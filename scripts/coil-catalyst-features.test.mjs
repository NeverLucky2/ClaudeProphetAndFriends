import { test } from 'node:test';
import assert from 'node:assert/strict';
import { features, composite } from './coil-catalyst-features.mjs';

function bar(o, h, l, c, v) { return { open: o, high: h, low: l, close: c, volume: v }; }

test('features compute gap, prior-day return, 5d drawdown, volume ratio', () => {
  // 31 near-flat bars (close 100, vol 1000) with a small alternating high/low so the
  // trailing true-range distribution has nonzero variance (range_zscore is then finite),
  // then a gap-down high-volume bar at idx 31.
  const bars = [];
  for (let i = 0; i < 31; i += 1) bars.push(bar(100, 101 + (i % 2), 99 - (i % 2), 100, 1000));
  bars.push(bar(95, 96, 90, 92, 5000)); // idx 31: opens 95 vs prev close 100
  const f = features(bars, 31);
  assert.ok(Math.abs(f.gap_pct - (95 / 100 - 1)) < 1e-9);          // -0.05
  assert.ok(Math.abs(f.prior_day_return - (92 / 100 - 1)) < 1e-9); // -0.08
  assert.ok(f.drawdown_5d < 0);                                    // below recent high
  assert.ok(Math.abs(f.volume_ratio - 5) < 1e-9);                  // 5000 / mean(prev 30 = 1000)
  assert.equal(Number.isFinite(f.range_zscore), true);
});

test('features return null fields on insufficient history', () => {
  const bars = [bar(100, 101, 99, 100, 1000), bar(100, 101, 99, 100, 1000)];
  const f = features(bars, 1);
  assert.equal(f.volume_ratio, null); // <30 prior bars
});

test('composite = volume_ratio * |gap_pct|', () => {
  assert.ok(Math.abs(composite({ volume_ratio: 5, gap_pct: -0.05 }) - 0.25) < 1e-9);
  assert.equal(composite({ volume_ratio: null, gap_pct: -0.05 }), null);
});
