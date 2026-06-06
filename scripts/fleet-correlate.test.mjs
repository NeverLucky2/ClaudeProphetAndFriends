import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pearson, spearman, zeroFraction, conditionalSeries, betaTo, bootstrapCorrCI, bootstrapBetaCI, crisisWeeks, effectiveN, crisisMean, crisisMeanCI, rhoCrisis, downsideBeta, rotationBand, rollingCorr } from './fleet-correlate.mjs';

test('pearson is exact on a perfectly linear series', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-12);
});

test('spearman uses ranks (monotone but nonlinear -> 1)', () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [1, 4, 9, 16]) - 1) < 1e-12);
});

test('zeroFraction + conditionalSeries drive the >40% sparse-lane rule', () => {
  const lane = [{ ret: 0, active: false }, { ret: 0, active: false }, { ret: 0.1, active: true }];
  assert.ok(Math.abs(zeroFraction(lane) - 2 / 3) < 1e-9);
  const { x, y } = conditionalSeries(lane, [{ ret: 0.01 }, { ret: 0.02 }, { ret: 0.03 }]);
  assert.deepEqual(x, [0.1]); assert.deepEqual(y, [0.03]); // only the active week survives
});

test('betaTo reuses olsBeta', () => {
  assert.ok(Math.abs(betaTo([2, 4, 6], [1, 2, 3]) - 2) < 1e-12);
});

test('bootstrapCorrCI is deterministic for a fixed seed and brackets the point estimate', () => {
  const x = Array.from({ length: 120 }, (_, i) => Math.sin(i));
  const y = x.map(v => v + 0.01);
  const a = bootstrapCorrCI(x, y, { seed: 42 });
  const b = bootstrapCorrCI(x, y, { seed: 42 });
  assert.deepEqual(a, b);
  assert.ok(a.lo <= a.point && a.point <= a.hi);
});

test('bootstrapBetaCI is deterministic and brackets the point beta', () => {
  const x = Array.from({ length: 120 }, (_, i) => Math.sin(i) / 50);
  const y = x.map(v => 1.5 * v + Math.cos(v) / 1e6);
  const a = bootstrapBetaCI(y, x, { seed: 9 });
  const b = bootstrapBetaCI(y, x, { seed: 9 });
  assert.deepEqual(a, b);
  assert.ok(a.lo <= a.point && a.point <= a.hi);
  assert.ok(Math.abs(a.point - 1.5) < 0.01);
});

test('crisisWeeks selects the worst-quintile (primary) and worst-decile (secondary) QQQ weeks', () => {
  const qqq = Array.from({ length: 100 }, (_, i) => ({ ret: (i - 50) / 1000 }));
  const q = crisisWeeks(qqq, 'quintile'); const d = crisisWeeks(qqq, 'decile');
  assert.equal(q.length, 20); assert.equal(d.length, 10);
  const inQ = new Set(q);
  assert.ok(Math.max(...q.map(i => qqq[i].ret)) <= Math.min(...qqq.map((b, i) => [b, i]).filter(([, i]) => !inQ.has(i)).map(([b]) => b.ret)));
});

test('effectiveN counts nonzero lane-weeks within a crisis index set', () => {
  const lane = [{ ret: 0 }, { ret: 0.1 }, { ret: 0 }, { ret: -0.2 }];
  assert.equal(effectiveN(lane, [0, 1, 3]), 2);
});

test('rhoCrisis / downsideBeta restrict to the crisis index set', () => {
  const lane = [{ ret: 0 }, { ret: 0.2 }, { ret: 0.4 }];
  const qqq = [{ ret: 0 }, { ret: 0.1 }, { ret: 0.2 }];
  assert.ok(Math.abs(downsideBeta(lane, qqq, [0, 1, 2]) - 2) < 1e-12);
  assert.ok(Math.abs(rhoCrisis(lane, qqq, [0, 1, 2]) - 1) < 1e-12); // perfectly linear -> rho 1
});

test('crisisMean + crisisMeanCI detect a co-crash (CI entirely below zero)', () => {
  const lane = Array.from({ length: 30 }, () => ({ ret: -0.05 }));
  const idx = lane.map((_, i) => i);
  assert.ok(Math.abs(crisisMean(lane, idx) + 0.05) < 1e-12);
  const ci = crisisMeanCI(lane, idx, { seed: 1 });
  assert.ok(ci.hi < 0); // co-crash is detectable: the whole CI sits below zero
});

test('rotationBand is deterministic; its median ~0 for an independent lane (rotation kills dependence)', () => {
  const n = 300;
  const qqq = Array.from({ length: n }, (_, i) => ({ ret: Math.sin(i) / 50 }));
  const lane = Array.from({ length: n }, (_, i) => ({ ret: Math.cos(i * 0.7) / 50, active: true }));
  const crisis = crisisWeeks(qqq, 'quintile');
  const a = rotationBand(lane, qqq, crisis, 'rho', { K: 500, seed: 7 });
  const b = rotationBand(lane, qqq, crisis, 'rho', { K: 500, seed: 7 });
  assert.deepEqual(a, b);                  // deterministic
  assert.ok(Math.abs(a.p50) < 0.2);        // centered near zero — rotation destroys real dependence
  assert.ok(a.p5 < a.p50 && a.p50 < a.p95);
});

test('a perfect crisis co-move sits beyond the rotation band (band is context, not a jump-gate)', () => {
  // lane EQUALS QQQ in crisis weeks (rho_crisis = 1) and is independent noise elsewhere.
  const n = 300;
  const qqq = Array.from({ length: n }, (_, i) => ({ ret: ((i * 37) % 100 - 50) / 1000 }));
  const crisis = crisisWeeks(qqq, 'quintile');
  const cset = new Set(crisis);
  const lane = qqq.map((w, i) => ({ ret: cset.has(i) ? w.ret : ((i % 11) - 5) / 1000, active: true }));
  const obs = rhoCrisis(lane, qqq, crisis);
  assert.ok(Math.abs(obs - 1) < 1e-9);     // perfect crisis correlation
  const band = rotationBand(lane, qqq, crisis, 'rho', { K: 1000, seed: 3 });
  assert.ok(obs > band.p95);               // a genuine strong tail co-move is beyond the selection artifact
});
