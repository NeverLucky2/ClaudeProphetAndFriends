import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFrontrunPrereg, verifyFrontrunPrereg, conversionRate } from './coil-frontrun-prereg.mjs';

const ep = (date, outcome, vol) => ({ ticker: 'AAA', date, outcome, vol, rsi2: 9, bars: 2 });

test('conversionRate counts FIRE over (FIRE + BOUNCE), ignoring the rest', () => {
  const eps = [
    ep('2021-01-04', 'FIRE', 0.01), ep('2021-01-05', 'BOUNCE', 0.01),
    ep('2021-01-06', 'BOUNCE', 0.01), ep('2021-01-07', 'REGIME_EXIT', 0.01),
    ep('2021-01-08', 'UNRESOLVED', 0.01),
  ];
  assert.equal(conversionRate(eps), 1 / 3);
});

test('conversionRate returns null with no resolved episodes', () => {
  assert.equal(conversionRate([ep('2021-01-04', 'UNRESOLVED', 0.01)]), null);
});

test('buildFrontrunPrereg freezes the rule and self-hashes', () => {
  const eps = [ep('2021-01-04', 'FIRE', 0.01), ep('2021-01-05', 'BOUNCE', 0.02), ep('2021-01-06', 'BOUNCE', 0.03)];
  const a = buildFrontrunPrereg({
    episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z',
  });
  assert.equal(a.forward_window_start, '2026-07-09');
  assert.equal(a.n_gate, 200);
  assert.equal(a.near_miss_band[0], 5);
  assert.equal(a.near_miss_band[1], 15);
  assert.equal(a.fire_threshold, 5);
  assert.equal(a.resolution_cap, 10);
  assert.equal(a.bounce_definition, 'close > SMA5');
  assert.equal(a.expected_outcome, 'NOT_SUPPORTED');
  assert.equal(a.benchmark_conversion_rate, 1 / 3);
  assert.ok(a.vol_tercile_boundaries.lo <= a.vol_tercile_boundaries.hi);
  assert.ok(a.artifact_hash);
  assert.equal(verifyFrontrunPrereg(a).ok, true);
});

test('buildFrontrunPrereg uses ONLY pre-forward-window episodes for the benchmark', () => {
  const eps = [
    ep('2021-01-04', 'FIRE', 0.01),      // historical
    ep('2026-08-01', 'BOUNCE', 0.02),    // forward — must be excluded
    ep('2026-08-02', 'BOUNCE', 0.03),
  ];
  const a = buildFrontrunPrereg({
    episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z',
  });
  assert.equal(a.benchmark_conversion_rate, 1);   // the single historical episode fired
  assert.equal(a.counts.historical_resolved, 1);
});

test('verifyFrontrunPrereg detects a tampered artifact', () => {
  const eps = [ep('2021-01-04', 'FIRE', 0.01), ep('2021-01-05', 'BOUNCE', 0.02), ep('2021-01-06', 'BOUNCE', 0.03)];
  const a = buildFrontrunPrereg({
    episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z',
  });
  a.n_gate = 5;
  const v = verifyFrontrunPrereg(a);
  assert.equal(v.ok, false);
  assert.notEqual(v.expected, v.found);
});

test('buildFrontrunPrereg is deterministic for a fixed createdUtc', () => {
  const eps = [ep('2021-01-04', 'FIRE', 0.01), ep('2021-01-05', 'BOUNCE', 0.02), ep('2021-01-06', 'BOUNCE', 0.03)];
  const mk = () => buildFrontrunPrereg({ episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z' });
  assert.equal(mk().artifact_hash, mk().artifact_hash);
});
