import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrereg, verifyPrereg, tercileThreshold } from './coil-eventstudy-prereg.mjs';

test('tercileThreshold = 66.667th percentile of train composites', () => {
  const train = [{ composite: 1 }, { composite: 2 }, { composite: 3 }, { composite: 9 }];
  const thr = tercileThreshold(train);
  assert.ok(thr >= 3 && thr <= 9); // top third boundary
});

test('artifact hash verifies and detects tampering', () => {
  const a = buildPrereg({ cutThreshold: 0.42, trainN: 500, holdoutN: 500 });
  assert.equal(verifyPrereg(a).ok, true);
  a.effect_size_mde = 0.5; // tamper
  assert.equal(verifyPrereg(a).ok, false);
});

test('prereg freezes the material constants', () => {
  const a = buildPrereg({ cutThreshold: 0.42, trainN: 1, holdoutN: 1 });
  assert.equal(a.effect_size_mde, 0.010);
  assert.deepEqual(a.horizons, [5, 10, 20]);
  assert.equal(a.benchmark, 'SPY');
  assert.equal(a.bootstrap.block_sessions, 10);
  assert.equal(a.verdict_rule.SIGNAL.includes('hi < 0'), true);
});
