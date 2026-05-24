// scripts/segment-by-epoch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelTrade, currentEpochRate } from './segment-by-epoch.mjs';

const CUR = ['X'];

test('labelTrade: stamped matching version -> current', () => {
  assert.equal(labelTrade({ strategyVersion: 'X', timestamp: '2026-05-20T00:00:00Z' }, CUR, null), 'current');
});
test('labelTrade: stamped differing version -> prior', () => {
  assert.equal(labelTrade({ strategyVersion: 'W', timestamp: '2026-05-20T00:00:00Z' }, CUR, null), 'prior');
});
test('labelTrade: unstamped + updatedAt, ts after -> current', () => {
  assert.equal(labelTrade({ timestamp: '2026-05-20T00:00:00Z' }, CUR, '2026-05-15T00:00:00Z'), 'current');
});
test('labelTrade: unstamped + updatedAt, ts before -> prior', () => {
  assert.equal(labelTrade({ timestamp: '2026-05-10T00:00:00Z' }, CUR, '2026-05-15T00:00:00Z'), 'prior');
});
test('labelTrade: unstamped + no updatedAt -> unknown', () => {
  assert.equal(labelTrade({ timestamp: '2026-05-20T00:00:00Z' }, CUR, null), 'unknown');
});

test('currentEpochRate: trades/day over span', () => {
  const trades = [
    { timestamp: '2026-05-20T00:00:00Z' },
    { timestamp: '2026-05-22T00:00:00Z' },
    { timestamp: '2026-05-24T00:00:00Z' },
  ];
  const { rate_per_day } = currentEpochRate(trades);
  assert.equal(rate_per_day, 0.75);
});
test('currentEpochRate: empty -> null', () => {
  assert.equal(currentEpochRate([]).rate_per_day, null);
});

import { segment } from './segment-by-epoch.mjs';

const stamped = (v, ts) => ({ strategyVersion: v, timestamp: ts });
const cur = (ts) => stamped('X', ts);
const prior = (ts) => stamped('W', ts);

test('segment Case 1: single epoch -> recommended_case 1, full set kept', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), cur('2026-05-21T00:00:00Z')];
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null });
  assert.equal(r.recommended_case, 1);
  assert.equal(r.current_epoch_set.length, 2);
  assert.equal(r.mixed_provenance, false);
});

test('segment Case 2: straddled + cur>=min -> case 2, only current kept', () => {
  const trades = [];
  for (let i = 0; i < 20; i++) trades.push(cur(`2026-05-${10 + i % 10}T0${i % 9}:00:00Z`));
  trades.push(prior('2026-05-01T00:00:00Z'));
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null, minCurrent: 20 });
  assert.equal(r.recommended_case, 2);
  assert.equal(r.counts.current, 20);
  assert.equal(r.current_epoch_set.length, 20);
  assert.equal(r.drop.dropped, 1);
});

test('segment Case 3: straddled + cur<min -> case 3 (no proposals)', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), prior('2026-05-01T00:00:00Z')];
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null, minCurrent: 20 });
  assert.equal(r.recommended_case, 3);
  assert.equal(r.trades_needed, 19);
  assert.equal(r.low_confidence, false);
});

test('segment Case 3 + override -> case 2, low_confidence', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), cur('2026-05-21T00:00:00Z'), prior('2026-05-01T00:00:00Z')];
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null, minCurrent: 20, minCurrentOverride: 2 });
  assert.equal(r.recommended_case, 2);
  assert.equal(r.override_applied, true);
  assert.equal(r.low_confidence, true);
});

test('segment: mixed provenance flag when stamped + unstamped coexist in straddle', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), { timestamp: '2026-05-02T00:00:00Z' }]; // 2nd unstamped, no updatedAt -> unknown
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null, minCurrent: 20 });
  assert.equal(r.mixed_provenance, true);
  assert.equal(r.counts.unknown, 1);
});

test('segment: stamped_vs_fallback split counted', () => {
  const trades = [cur('2026-05-20T00:00:00Z'), { timestamp: '2026-05-19T00:00:00Z' }];
  const r = segment(trades, { currentVersions: ['X'], updatedAt: '2026-05-15T00:00:00Z', minCurrent: 20 });
  assert.equal(r.stamped_vs_fallback.stamped, 1);
  assert.equal(r.stamped_vs_fallback.fallback, 1);
});

test('labelTrade: unstamped + updatedAt + missing timestamp -> unknown', () => {
  assert.equal(labelTrade({}, CUR, '2026-05-15T00:00:00Z'), 'unknown');
});

test('labelTrade: unstamped + updatedAt + malformed timestamp -> unknown', () => {
  assert.equal(labelTrade({ timestamp: 'garbage' }, CUR, '2026-05-15T00:00:00Z'), 'unknown');
});

test('segment: unknown-only straddle (no updatedAt, no stamps) -> case 3', () => {
  const trades = [{ timestamp: '2026-05-20T00:00:00Z' }, { timestamp: '2026-05-19T00:00:00Z' }];
  const r = segment(trades, { currentVersions: ['X'], updatedAt: null, minCurrent: 20 });
  assert.equal(r.recommended_case, 3);
  assert.equal(r.counts.unknown, 2);
  assert.equal(r.straddled, true);
});
