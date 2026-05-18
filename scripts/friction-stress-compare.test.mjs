// scripts/friction-stress-compare.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareFrictionSets } from './friction-stress-compare.mjs';

test('compareFrictionSets: matches by base filename and computes totals + delta', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'AAA', timestamp: '2026-05-15T15:00:00Z',
      market_data: { friction_adjusted_pl: 100 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction.json', symbol: 'BBB', timestamp: '2026-05-15T15:01:00Z',
      market_data: { friction_adjusted_pl: 200 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'AAA', timestamp: '2026-05-15T15:00:00Z',
      market_data: { friction_adjusted_pl: 60 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction-stress.json', symbol: 'BBB', timestamp: '2026-05-15T15:01:00Z',
      market_data: { friction_adjusted_pl: 150 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.totals.trade_count, 2);
  assert.equal(result.totals.baseline_pl_usd, 300);
  assert.equal(result.totals.stress_pl_usd, 210);
  assert.equal(result.totals.total_delta_usd, -90);
  assert.equal(result.flips.length, 0);
  assert.deepEqual(result.unmatched, []);
});

test('compareFrictionSets: detects flip (positive baseline -> negative stress)', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'AAA', timestamp: '2026-05-15T15:00:00Z',
      market_data: { friction_adjusted_pl: 50 }, friction_meta: { profile_applied: 'single_leg_options' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'AAA', timestamp: '2026-05-15T15:00:00Z',
      market_data: { friction_adjusted_pl: -10 }, friction_meta: { profile_applied: 'single_leg_options' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.flips.length, 1);
  assert.equal(result.flips[0].symbol, 'AAA');
  assert.equal(result.flips[0].baseline_pl, 50);
  assert.equal(result.flips[0].stress_pl, -10);
});

test('compareFrictionSets: per-asset-class breakdown aggregates correctly', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 100 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: 200 }, friction_meta: { profile_applied: 'single_leg_options' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 80 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction-stress.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: -50 }, friction_meta: { profile_applied: 'single_leg_options' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.per_asset_class.stocks.trade_count, 1);
  assert.equal(result.per_asset_class.stocks.flips, 0);
  assert.equal(result.per_asset_class.single_leg_options.flips, 1);
});

test('compareFrictionSets: matched-count symmetry on well-formed input', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 100 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: 200 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 80 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction-stress.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: 180 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.totals.trade_count, 2);
  assert.equal(result.unmatched.length, 0);
});

test('compareFrictionSets: flip is symmetric across zero — baseline 0, stress -50', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 0 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: -50 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.flips.length, 1, 'breakeven → loser should be flagged as a flip');
});

test('compareFrictionSets: flip is symmetric across zero — baseline 0, stress +50', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 0 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 50 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.flips.length, 1, 'breakeven → winner should be flagged as a flip');
});

test('compareFrictionSets: flip is symmetric across zero — baseline -50, stress 0', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: -50 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 0 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.flips.length, 1, 'loser → breakeven should be flagged as a flip');
});

test('compareFrictionSets: flip is symmetric across zero — baseline +50, stress 0', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 50 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 0 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.flips.length, 1, 'winner → breakeven should be flagged as a flip');
});

test('compareFrictionSets: same-sign change is NOT flagged as flip (regression guard)', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 50 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 100 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.flips.length, 0, 'winner → bigger winner should not be a flip');
});

test('compareFrictionSets: unmatched listed when a side is missing a trade', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 100 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: 200 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 80 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.unmatched.length, 1);
  assert.match(result.unmatched[0].reason, /missing in stress/);
});
