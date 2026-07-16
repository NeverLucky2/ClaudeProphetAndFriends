import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignGroups } from './coil-shadow-groups.mjs';

const e = (name, day, tag, rsi) => ({ name, openDate: day, tag, rsi2AtEntry: rsi, ret: 0, outcome: 'bounce' });

test('A/B/C split and unknown excluded', () => {
  const eps = [e('A', 'd1', 'fire_early', 6), e('B', 'd1', 'declined', 7), e('C', 'd1', 'unknown', 8)];
  const g = assignGroups(eps);
  assert.deepEqual(g.A.map((x) => x.name), ['A']);
  assert.deepEqual(g.B.map((x) => x.name), ['B']);
  assert.deepEqual(g.C.map((x) => x.name).sort(), ['A', 'B']);
});

test('M picks the k lowest-RSI names per day, k = that day fire_early count', () => {
  // Day d1: 2 fire_early → M = 2 lowest-RSI of the tagged set {6,7,9,11}.
  const eps = [
    e('P', 'd1', 'fire_early', 11), e('Q', 'd1', 'fire_early', 9),
    e('R', 'd1', 'declined', 6), e('S', 'd1', 'declined', 7),
  ];
  const g = assignGroups(eps);
  assert.deepEqual(g.M.map((x) => x.name).sort(), ['R', 'S']); // lowest two RSI overall
});

test('M empty on a zero-fire day', () => {
  const g = assignGroups([e('A', 'd1', 'declined', 6), e('B', 'd1', 'declined', 7)]);
  assert.equal(g.M.length, 0);
});
