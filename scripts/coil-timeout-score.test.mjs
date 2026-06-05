import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairedDeltas, classifyBranch, winsorizeUpside, tailDecomp, decideTimeout, ddPlacement } from './coil-timeout-score.mjs';

test('classifyBranch maps exit reasons to branches', () => {
  assert.equal(classifyBranch('rsi_mean_cross'), 'bounce');
  assert.equal(classifyBranch('sma5_cross'), 'bounce');
  assert.equal(classifyBranch('time_stop'), 'meander');
  assert.equal(classifyBranch('stop'), 'conversion');
});

test('pairedDeltas computes friction-cancelling delta and skips censored', () => {
  const paired = [
    { date: '2020-01-01', gross5: -0.02, perT: { '7': { gross: 0.02, exitReason: 'sma5_cross', censored: false } } },
    { date: '2020-01-02', gross5: -0.02, perT: { '7': { gross: -0.07, exitReason: 'stop', censored: false } } },
    { date: '2020-01-03', gross5: -0.02, perT: { '7': { gross: null, exitReason: null, censored: true } } }, // skipped
  ];
  const rows = pairedDeltas(paired, 7, { frictionBps: 20 });
  assert.equal(rows.length, 2);
  assert.ok(Math.abs(rows[0].net - 0.04) < 1e-12);   // 0.02 - (-0.02); friction cancels
  assert.equal(rows[0].branch, 'bounce');
  assert.ok(Math.abs(rows[1].net - (-0.05)) < 1e-12); // -0.07 - (-0.02) conversion drag
  assert.equal(rows[1].branch, 'conversion');
});

test('winsorizeUpside caps values above the p90 threshold', () => {
  const xs = [0, 0, 0, 0, 0, 0, 0, 0, 0, 100]; // p90 cap (idx floor(0.9*10)=9 → value 100) ⇒ nothing capped
  assert.deepEqual(winsorizeUpside(xs, 90), xs);
  const ys = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 50]; // 11 values; cap idx floor(0.9*11)=9 → sorted[9]=1 ⇒ 50→1
  assert.equal(Math.max(...winsorizeUpside(ys, 90)), 1);
});

test('tailDecomp sums each branch and isolates conversion drag', () => {
  const rows = [
    { net: 0.03, branch: 'bounce' }, { net: 0.02, branch: 'bounce' },
    { net: -0.01, branch: 'meander' },
    { net: -0.05, branch: 'conversion' }, { net: -0.05, branch: 'conversion' },
  ];
  const d = tailDecomp(rows);
  assert.equal(d.nConvert, 2);
  assert.ok(Math.abs(d.dragSum - (-0.10)) < 1e-12);
  assert.equal(d.nBounce, 2);
  assert.equal(d.n, 5);
});

const passCI = { lo: 0.01, hi: 0.05, mean: 0.03 };
const failCI = { lo: -0.02, hi: 0.04, mean: 0.01 };

test('EXTEND only when all three gates pass', () => {
  assert.equal(decideTimeout({ gate1a: passCI, gate1b: passCI, gate2: true, nDelta: 50 }).verdict, 'EXTEND');
});
test('underpowered takes precedence', () => {
  assert.equal(decideTimeout({ gate1a: passCI, gate1b: passCI, gate2: true, nDelta: 10 }).verdict, 'UNDERPOWERED');
});
test('no edge → KEEP (1a)', () => {
  assert.equal(decideTimeout({ gate1a: failCI, gate1b: passCI, gate2: true, nDelta: 50 }).reason.includes('gate1a'), true);
});
test('tail-funded → KEEP (1b)', () => {
  const r = decideTimeout({ gate1a: passCI, gate1b: failCI, gate2: true, nDelta: 50 });
  assert.equal(r.verdict, 'KEEP');
  assert.equal(r.reason.includes('tail-funded'), true);
});
test('opportunity cost → KEEP (2)', () => {
  const r = decideTimeout({ gate1a: passCI, gate1b: passCI, gate2: false, nDelta: 50 });
  assert.equal(r.reason.includes('opportunity cost'), true);
});

test('ddPlacement flags untested when the holdout segment is comparatively calm', () => {
  // train segment has a deep DD (0.10 -> 0.00), holdout segment shallow (0.12 -> 0.11)
  const curve = [
    { date: '2020-01-01', cum: 0.10 }, { date: '2020-02-01', cum: 0.00 }, // train (deep)
    { date: '2025-01-01', cum: 0.12 }, { date: '2025-02-01', cum: 0.11 }, // holdout (shallow)
  ];
  const r = ddPlacement(curve, '2024-01-01', 0.5);
  assert.ok(Math.abs(r.trainDD.dd - (-0.10)) < 1e-12);
  assert.ok(Math.abs(r.holdoutDD.dd - (-0.01)) < 1e-12);
  assert.equal(r.untested, true); // |0.01| < 0.5 * |0.10|
});
