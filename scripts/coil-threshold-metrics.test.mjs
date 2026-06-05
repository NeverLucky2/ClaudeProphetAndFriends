import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFriction, winRate, profitFactor, mean, median, bootstrapMeanCI, bootstrapDiffCI } from './coil-threshold-metrics.mjs';

test('applyFriction subtracts round-trip bps from gross', () => {
  assert.ok(Math.abs(applyFriction(0.05, 20) - (0.05 - 0.002)) < 1e-12); // 20bps = 0.002
});

test('winRate / profitFactor / mean / median', () => {
  const r = [0.10, -0.05, 0.20, -0.10];
  assert.equal(winRate(r), 0.5);
  assert.ok(Math.abs(profitFactor(r) - (0.30 / 0.15)) < 1e-9);
  assert.ok(Math.abs(mean(r) - 0.0375) < 1e-9);
  assert.equal(median([1, 3, 2]), 2);
});

test('bootstrapMeanCI is deterministic under a fixed seed and brackets the mean', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ date: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, net: (i % 5) - 2 }));
  const a = bootstrapMeanCI(rows, { iterations: 2000, seed: 7, blockSessions: 15 });
  const b = bootstrapMeanCI(rows, { iterations: 2000, seed: 7, blockSessions: 15 });
  assert.deepEqual(a, b);
  assert.ok(a.lo <= a.mean && a.mean <= a.hi);
});

test('bootstrapDiffCI returns a CI on (groupB - groupA) mean net', () => {
  const A = Array.from({ length: 100 }, (_, i) => ({ date: `2026-02-${String(1 + (i % 28)).padStart(2, '0')}`, net: 0.00 }));
  const B = Array.from({ length: 100 }, (_, i) => ({ date: `2026-02-${String(1 + (i % 28)).padStart(2, '0')}`, net: 0.05 }));
  const ci = bootstrapDiffCI(A, B, { iterations: 2000, seed: 1, blockSessions: 15 });
  assert.ok(ci.lo > 0 && ci.mean > 0); // B clearly higher
});
