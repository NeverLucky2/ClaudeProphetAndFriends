// scripts/overlay-frontier.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regimeClass, recommend } from './overlay-frontier.mjs';

test('regimeClass: cushions (CI lo>0) in both subsets = robust', () => {
  assert.equal(regimeClass({ rateShock: { lo: 0.001 }, growthScare: { lo: 0.002 } }), 'robust');
  assert.equal(regimeClass({ rateShock: { lo: -0.001 }, growthScare: { lo: 0.002 } }), 'fragile');
  assert.equal(regimeClass({ rateShock: { lo: -0.001 }, growthScare: { lo: -0.002 } }), 'ineffective');
});

test('recommend: a static robust candidate dominates → branch a', () => {
  const cands = [
    { id: 'gld', convex: false, class: 'robust', lumpedLo: 0.001, drag: 1.0, cushion: 0.4, stressOk: true },
    { id: 'def_prophet', convex: true, class: 'fragile', lumpedLo: 0.001, drag: 0.5, cushion: 0.3, stressOk: true },
  ];
  const r = recommend(cands);
  assert.equal(r.branch, 'a');
  assert.equal(r.pick, 'gld');
});

test('recommend: only def-Prophet robust → branch b', () => {
  const cands = [
    { id: 'gld', convex: false, class: 'fragile', lumpedLo: 0.0, drag: 1.0, cushion: 0.2, stressOk: true },
    { id: 'def_prophet', convex: true, class: 'robust', lumpedLo: 0.001, drag: 0.5, cushion: 0.3, stressOk: true },
  ];
  assert.equal(recommend(cands).branch, 'b');
});

test('recommend: convex guard blocks a put-spread branch-a win without stress corroboration', () => {
  const cands = [
    { id: 'def_prophet', convex: true, class: 'robust', lumpedLo: 0.001, drag: 0.4, cushion: 0.9, stressOk: false },
    { id: 'gld', convex: false, class: 'fragile', lumpedLo: 0.0, drag: 1.0, cushion: 0.2, stressOk: true },
  ];
  // def_prophet would dominate on efficiency, but stressOk=false + convex → cannot win branch a;
  // it is still robust, so falls through to branch b (def-Prophet primary).
  assert.equal(recommend(cands).branch, 'b');
});

test('recommend: nothing robust → branch c (honest null)', () => {
  const cands = [{ id: 'gld', convex: false, class: 'ineffective', lumpedLo: -0.001, drag: 1, cushion: -0.1, stressOk: true }];
  assert.equal(recommend(cands).branch, 'c');
});
