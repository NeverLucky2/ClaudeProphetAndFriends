import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketStats, decide } from './coil-threshold-score.mjs';
import { bootstrapMeanCI } from './coil-threshold-metrics.mjs';

function trade(bucket, net, date, split) { return { bucket, grossReturn: net, date, split, censored: false }; }

test('bucketStats reports n and net metrics per bucket at 20bps', () => {
  const rows = [trade('[0,5)', 0.05, '2026-01-02', 'train'), trade('[0,5)', -0.03, '2026-01-03', 'train'), trade('[5,8)', 0.01, '2026-01-02', 'train')];
  const s = bucketStats(rows, { frictionBps: 20 });
  assert.equal(s['[0,5)'].n, 2);
  assert.equal(s['[5,8)'].n, 1);
  assert.ok(s['[0,5)'].meanNet < 0.05); // friction applied
});

test('decide returns KEEP when gate1 fails', () => {
  const v = decide({
    gate1: { lo: -0.01, mean: 0.0, hi: 0.02, n: 50 },
    portfolioBase: { totalNet: 0.10, maxDrawdown: -0.05 },
    portfolioT: { totalNet: 0.08, maxDrawdown: -0.06 },
    powerFloorN: 30,
  });
  assert.equal(v.verdict, 'KEEP');
});

test('decide returns UNDERPOWERED when marginal n is below the floor', () => {
  const v = decide({
    gate1: { lo: 0.001, mean: 0.02, hi: 0.05, n: 12 },
    portfolioBase: { totalNet: 0.10, maxDrawdown: -0.05 },
    portfolioT: { totalNet: 0.12, maxDrawdown: -0.05 },
    powerFloorN: 30,
  });
  assert.equal(v.verdict, 'UNDERPOWERED');
});

test('decide returns CONSIDER only when both gates pass with adequate n', () => {
  const v = decide({
    gate1: { lo: 0.005, mean: 0.02, hi: 0.05, n: 60 },
    portfolioBase: { totalNet: 0.10, maxDrawdown: -0.05 },
    portfolioT: { totalNet: 0.13, maxDrawdown: -0.052 }, // DD within 1.1x of -0.05
    powerFloorN: 30,
  });
  assert.equal(v.verdict, 'CONSIDER');
});

test('decide consumes bootstrapMeanCI output (field n) end-to-end', () => {
  // 40 positive-net marginal rows spread across dates → gate1.n = 40 (>= floor)
  const rows = Array.from({ length: 40 }, (_, i) => ({ date: `2026-03-${String(1 + (i % 28)).padStart(2, '0')}`, net: 0.02 }));
  const gate1 = bootstrapMeanCI(rows, { iterations: 1000, seed: 3, blockSessions: 15 });
  const v = decide({ gate1, portfolioBase: { totalNet: 0.10, maxDrawdown: -0.05 }, portfolioT: { totalNet: 0.13, maxDrawdown: -0.05 }, powerFloorN: 30 });
  assert.notEqual(v.verdict, 'UNDERPOWERED'); // n=40 must be recognized (would fail if reading nB)

  // a thin sample (n=10 < 30) must be UNDERPOWERED
  const thin = bootstrapMeanCI(rows.slice(0, 10), { iterations: 1000, seed: 3, blockSessions: 15 });
  const v2 = decide({ gate1: thin, portfolioBase: { totalNet: 0.10, maxDrawdown: -0.05 }, portfolioT: { totalNet: 0.20, maxDrawdown: -0.05 }, powerFloorN: 30 });
  assert.equal(v2.verdict, 'UNDERPOWERED');
});
