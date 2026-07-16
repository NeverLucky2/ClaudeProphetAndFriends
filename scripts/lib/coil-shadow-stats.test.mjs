import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitWithinClustered, computeVerdict, futilityGate } from './coil-shadow-stats.mjs';

// T1 — recover a planted fire-early effect WITH all controls present (non-degenerate).
// 6 names/day: RSI spans [5,15) so every bucket is populated; gaps vary across days
// so the pooled within design is full column rank; day shock absorbed by the FE.
// ret = dayShock + beta*fire EXACTLY (no noise) => residual 0 => beta recovered exactly.
function synthEffect(beta, days = 40) {
  const g = (a, b) => { const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return x - Math.floor(x); };
  const rows = [];
  for (let d = 0; d < days; d += 1) {
    const dayShock = (d % 5) * 0.01;
    for (let i = 0; i < 6; i += 1) {
      const fire = d % 2 === 0 ? (i < 3 ? 1 : 0) : (i >= 3 ? 1 : 0); // varies within day, decoupled from RSI
      rows.push({ ret: dayShock + (fire ? beta : 0), fireEarly: fire, rsi2: 5 + i * 1.6,
        sma5Gap: -2 + 2 * g(i, d), sma200Gap: 2 + 8 * g(i + 7, d + 3), day: `d${d}`, name: `N${i}` });
    }
  }
  return rows;
}

test('within estimator recovers the planted effect with controls present; FE absorbs the day shock', () => {
  const fit = fitWithinClustered(synthEffect(0.02));
  assert.ok(Math.abs(fit.beta - 0.02) < 1e-9, `beta=${fit.beta}`);
  assert.equal(fit.keptCols, 7); // fire + 4 RSI buckets + 2 gaps, none dropped
  assert.equal(fit.nClusters, 6);
  assert.ok(fit.ciLower > 0);
});

// T2 — null effect. Symmetric, fire-orthogonal residual noise on the NON-fire names
// only (+d on one, -d on another per day) leaves beta exactly 0 but gives SE>0, so the
// one-sided CI straddles 0. Controls are constant here => zero-variance => dropped, leaving
// the clean fire-only fit (exercises the drop path).
function synthNull(days = 40) {
  const rows = [];
  for (let d = 0; d < days; d += 1) {
    const dayShock = (d % 5) * 0.01;
    const bump = [0, 0, 0.01, -0.01]; // N0,N1 fire (0); N2,N3 not-fire carry +/-d
    for (let i = 0; i < 4; i += 1) {
      const fire = i < 2 ? 1 : 0;
      rows.push({ ret: dayShock + bump[i], fireEarly: fire, rsi2: 6, sma5Gap: -1, sma200Gap: 5,
        day: `d${d}`, name: `N${i}` });
    }
  }
  return rows;
}

test('null effect -> beta ~ 0 and the CI straddles 0', () => {
  const fit = fitWithinClustered(synthNull());
  assert.ok(Math.abs(fit.beta) < 1e-9, `beta=${fit.beta}`);
  assert.equal(fit.keptCols, 1); // constant controls dropped, only fire remains
  assert.ok(fit.ciLower < 0 && fit.ciUpper > 0);
});

// T3 — clustered SE exceeds the naive i.i.d. SE. Names are persistently fire or not
// (a name's fire status and its return offset are the SAME every day), so within-name
// scores accumulate coherently => the by-name cluster-robust SE must exceed the naive one.
function synthClustered(days = 40) {
  const rows = [];
  const offset = { N0: 0.04, N1: 0.03, N2: 0.05, N3: 0, N4: 0, N5: 0 }; // persistent per name
  const g = (a, b) => { const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return x - Math.floor(x); };
  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < 6; i += 1) {
      const name = `N${i}`;
      const fire = i < 3 ? 1 : 0; // N0-2 ALWAYS fire, N3-5 NEVER
      rows.push({ ret: offset[name] + (fire ? 0.01 : 0) + (g(i, d) - 0.5) * 0.004,
        fireEarly: fire, rsi2: 6, sma5Gap: -1, sma200Gap: 5, day: `d${d}`, name });
    }
  }
  return rows;
}

test('clustered SE exceeds the naive i.i.d. SE under persistent within-name correlation', () => {
  const fit = fitWithinClustered(synthClustered());
  assert.ok(fit.se > fit.naiveSe, `clustered ${fit.se} should exceed naive ${fit.naiveSe}`);
});

test('verdict: KEEP needs lower bound > 0 AND beta ≥ floor', () => {
  assert.equal(computeVerdict({ beta: 0.015, ciLower: 0.004, ciUpper: 0.026 }), 'KEEP');
  assert.equal(computeVerdict({ beta: 0.015, ciLower: -0.001, ciUpper: 0.03 }), 'INCONCLUSIVE'); // lower≤0
  assert.equal(computeVerdict({ beta: 0.008, ciLower: 0.002, ciUpper: 0.014 }), 'INCONCLUSIVE'); // beta<floor
});

test('verdict: REJECT when upper bound < floor', () => {
  assert.equal(computeVerdict({ beta: 0.002, ciLower: -0.004, ciUpper: 0.008 }), 'REJECT');
});

test('futility gate early-rejects when a worthwhile edge is already ruled out, never KEEPs', () => {
  assert.equal(futilityGate({ beta: 0.001, ciLower: -0.005, ciUpper: 0.006 }), 'early-reject');
  assert.equal(futilityGate({ beta: 0.02, ciLower: 0.01, ciUpper: 0.03 }), 'continue'); // strong → continue, not KEEP
});
