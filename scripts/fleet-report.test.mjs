import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLane, tailNote } from './fleet-report.mjs';

test('classifyLane: large positive beta with CI clear of 0 → overt_long_beta', () => {
  assert.equal(classifyLane({ fullBeta: 0.7, betaLo: 0.5, betaHi: 0.9 }), 'overt_long_beta');
});
test('classifyLane: small beta, CI brackets 0 → genuine_ballast', () => {
  assert.equal(classifyLane({ fullBeta: 0.05, betaLo: -0.1, betaHi: 0.2 }), 'genuine_ballast');
});
test('classifyLane: significantly negative beta (hedge) → genuine_ballast', () => {
  assert.equal(classifyLane({ fullBeta: -0.5, betaLo: -0.8, betaHi: -0.2 }), 'genuine_ballast');
});
test('classifyLane: moderate positive beta → mild_overlap', () => {
  assert.equal(classifyLane({ fullBeta: 0.3, betaLo: 0.1, betaHi: 0.5 }), 'mild_overlap');
  assert.equal(classifyLane({ fullBeta: 0.25, betaLo: -0.05, betaHi: 0.55 }), 'mild_overlap');
});

test('tailNote: below the effective-n floor → insufficient_power', () => {
  assert.equal(tailNote({ effN: 3 }), 'insufficient_power');
});
test('tailNote: crisis-mean CI below 0 + rho beyond band → co_crashes_with_tail_comove', () => {
  assert.equal(tailNote({ effN: 20, crisisMeanHi: -0.01, crisisMeanLo: -0.05, rhoCrisis: 0.8, rhoBandP95: 0.5 }), 'co_crashes_with_tail_comove');
});
test('tailNote: crisis-mean CI above 0 → cushions', () => {
  assert.equal(tailNote({ effN: 20, crisisMeanLo: 0.01, crisisMeanHi: 0.05 }), 'cushions');
});
test('tailNote: straddles 0, rho within band → tail_neutral', () => {
  assert.equal(tailNote({ effN: 20, crisisMeanLo: -0.02, crisisMeanHi: 0.02, rhoCrisis: 0.1, rhoBandP95: 0.5 }), 'tail_neutral');
});
