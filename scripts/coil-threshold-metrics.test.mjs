import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFriction, winRate, profitFactor, mean, median, bootstrapMeanCI, bootstrapDiffCI, cvar } from './coil-threshold-metrics.mjs';

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

test('cvar averages the worst alpha-fraction of returns', () => {
  // 5 returns, alpha 0.4 -> ceil(0.4*5)=2 worst = [-0.5,-0.3] -> mean -0.4
  assert.equal(cvar([0.1, 0.2, -0.3, -0.5, 0.05], 0.4), -0.4);
});

test('cvar returns the single worst trade for a tiny sample at 5%', () => {
  assert.equal(cvar([-0.07], 0.05), -0.07);          // k = max(1, ceil(0.05*1)) = 1
  assert.equal(cvar([0.02, -0.04, 0.01], 0.05), -0.04); // k=1 -> worst single
});

test('cvar is monotonic: a deeper tail lowers it; empty -> null', () => {
  const a = cvar([0.01, -0.05, 0.02, -0.10, 0.03], 0.4);
  const b = cvar([0.01, -0.05, 0.02, -0.30, 0.03], 0.4);
  assert.ok(b < a);
  assert.equal(cvar([], 0.05), null);
  assert.equal(cvar([NaN, Infinity], 0.05), null);
});
