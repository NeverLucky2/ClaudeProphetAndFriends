// scripts/stage1-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSplit } from './stage1-score.mjs';
import { buildPreregArtifact } from './stage1-prereg.mjs';

const artifact = buildPreregArtifact({ universeText: 'A\n', frictionText: '{}', splitDate: '2026-03-15' });

// helper: n firings across distinct dates with a target hit count
function firings(n, hitCount) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`, hit: i < hitCount, dIdx: i, ticker: 'A' });
  return out;
}

test('UNDERPOWERED when n < required', () => {
  const r = scoreSplit(firings(50, 40), artifact, { HR0Final: 0.55 });
  assert.equal(r.verdict, 'UNDERPOWERED');
});

test('FAIL when powered but HR not significantly above HR0', () => {
  // n=235, ~55% hits -> not above a 0.55 null
  const r = scoreSplit(firings(235, 129), artifact, { HR0Final: 0.55 });
  assert.equal(r.n, 235);
  assert.equal(r.verdict, 'FAIL');
});

test('PASS when powered and HR strongly above HR0 (binomial + bootstrap agree)', () => {
  // n=235, 70% hits -> p tiny, bootstrap p5 well above 0.55
  const r = scoreSplit(firings(235, 165), artifact, { HR0Final: 0.55 });
  assert.equal(r.verdict, 'PASS');
  assert.ok(r.binomial_p < 0.05);
  assert.ok(r.bootstrap_p5 > 0.55);
});

test('Bonferroni divides alpha by k', () => {
  const k3 = { ...artifact, variants: { ...artifact.variants, k: 3 } };
  const r = scoreSplit(firings(235, 150), k3, { HR0Final: 0.55 });
  assert.equal(r.alpha_effective, 0.05 / 3);
});
