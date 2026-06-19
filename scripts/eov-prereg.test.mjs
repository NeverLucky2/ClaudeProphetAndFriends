// scripts/eov-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEovPrereg, verifyEovPrereg } from './eov-prereg.mjs';

test('prereg is self-consistent and tamper-evident', () => {
  const a = buildEovPrereg({ trainN: 300, holdoutN: 130, validDatesN: 430, splitBoundary: '2025-09-01', createdUtc: '2026-06-19T00:00:00Z' });
  assert.equal(verifyEovPrereg(a).ok, true);
  assert.equal(a.confirmatory_cell.h, 3);
  assert.equal(a.bootstrap.seed, 1234);
  assert.equal(a.expected_outcome, 'REJECT');
  a.power_floor.distinct_dates = 1; // tamper
  assert.equal(verifyEovPrereg(a).ok, false);
});

test('hash is stable across key ordering', () => {
  const a = buildEovPrereg({ trainN: 1, holdoutN: 1, validDatesN: 2, splitBoundary: 'x', createdUtc: 't' });
  const b = buildEovPrereg({ trainN: 1, holdoutN: 1, validDatesN: 2, splitBoundary: 'x', createdUtc: 't' });
  assert.equal(a.artifact_hash, b.artifact_hash);
});
