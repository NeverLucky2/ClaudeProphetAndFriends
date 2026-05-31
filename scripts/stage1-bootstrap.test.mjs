// scripts/stage1-bootstrap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, dateBlockBootstrapHR } from './stage1-bootstrap.mjs';

test('mulberry32 is deterministic for a seed', () => {
  const a = mulberry32(1234), b = mulberry32(1234);
  assert.equal(a(), b());
  assert.equal(a(), b());
});

function mkFirings() {
  // 40 dates, 1 firing each, all hits -> HR must be 1 regardless of resample
  const out = [];
  for (let i = 0; i < 40; i += 1) out.push({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, hit: true });
  return out;
}

test('all-hit data -> bootstrap p5 = 1', () => {
  const r = dateBlockBootstrapHR(mkFirings(), { blockSessions: 10, iterations: 500, seed: 7, percentile: 5 });
  assert.equal(r.percentileHR, 1);
});

test('deterministic: same seed -> identical percentile', () => {
  const mixed = mkFirings().map((f, i) => ({ ...f, hit: i % 2 === 0 }));
  const r1 = dateBlockBootstrapHR(mixed, { blockSessions: 10, iterations: 1000, seed: 99, percentile: 5 });
  const r2 = dateBlockBootstrapHR(mixed, { blockSessions: 10, iterations: 1000, seed: 99, percentile: 5 });
  assert.equal(r1.percentileHR, r2.percentileHR);
});

test('empty input -> null percentile, does not throw', () => {
  const r = dateBlockBootstrapHR([], { blockSessions: 10, iterations: 100, seed: 1, percentile: 5 });
  assert.equal(r.percentileHR, null);
});
