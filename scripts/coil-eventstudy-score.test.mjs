import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignBuckets, meanDiff, dateBlockBootstrapDiff, scoreSplit } from './coil-eventstudy-score.mjs';

test('assignBuckets splits by the frozen threshold', () => {
  const inst = [{ composite: 0.5 }, { composite: 0.1 }];
  const out = assignBuckets(inst, 0.3);
  assert.equal(out[0].bucket, 'catalyst'); assert.equal(out[1].bucket, 'clean');
});

test('meanDiff = mean(catalyst) - mean(clean) over non-null returns at H', () => {
  const inst = [
    { bucket: 'catalyst', madj: { 5: -0.03 } }, { bucket: 'catalyst', madj: { 5: -0.01 } },
    { bucket: 'clean', madj: { 5: 0.02 } }, { bucket: 'clean', madj: { 5: 0.00 } },
  ];
  assert.ok(Math.abs(meanDiff(inst, 5) - (-0.02 - 0.01)) < 1e-9); // -0.02 vs +0.01 => -0.03
});

test('bootstrap CI brackets the point estimate and is reproducible', () => {
  const inst = [];
  for (let i = 0; i < 200; i += 1) inst.push({ date: `2022-01-${(i % 28) + 1}`, bucket: 'catalyst', madj: { 5: -0.02 } });
  for (let i = 0; i < 200; i += 1) inst.push({ date: `2022-02-${(i % 28) + 1}`, bucket: 'clean', madj: { 5: 0.00 } });
  const a = dateBlockBootstrapDiff(inst, 5, { blockSessions: 10, iterations: 500, seed: 1234 });
  const b = dateBlockBootstrapDiff(inst, 5, { blockSessions: 10, iterations: 500, seed: 1234 });
  assert.deepEqual(a, b);                 // reproducible
  assert.ok(a.lo <= a.meanDiff && a.meanDiff <= a.hi);
});

test('verdict mapping: SIGNAL / NO_EFFECT / INSUFFICIENT', () => {
  const art = { effect_size_mde: 0.01, bootstrap: { block_sessions: 10, iterations: 300, seed: 1 } };
  // strongly negative catalyst returns -> SIGNAL
  const sig = [];
  for (let i = 0; i < 150; i += 1) sig.push({ date: `2022-01-${(i % 28) + 1}`, bucket: 'catalyst', madj: { 5: -0.05 } });
  for (let i = 0; i < 150; i += 1) sig.push({ date: `2022-03-${(i % 28) + 1}`, bucket: 'clean', madj: { 5: 0.00 } });
  assert.equal(scoreSplit(sig, 5, art).verdict, 'SIGNAL');
  // near-identical buckets -> NO_EFFECT (equivalence)
  const noeff = [];
  for (let i = 0; i < 400; i += 1) noeff.push({ date: `2022-01-${(i % 28) + 1}`, bucket: 'catalyst', madj: { 5: 0.0001 } });
  for (let i = 0; i < 400; i += 1) noeff.push({ date: `2022-02-${(i % 28) + 1}`, bucket: 'clean', madj: { 5: 0.0 } });
  assert.equal(scoreSplit(noeff, 5, art).verdict, 'NO_EFFECT');
});
