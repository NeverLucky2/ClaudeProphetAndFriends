// scripts/coil-opt-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tailRiskRatio, decideCallKill, decidePutGate } from './coil-opt-score.mjs';
const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('tailRiskRatio = mean / |worst-decile mean|', () => {
  const pnls = Array.from({ length: 10 }, (_, i) => i - 4.5); // -4.5..4.5, mean 0
  approx(tailRiskRatio(pnls), 0);
  const p2 = [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, -0.20];
  approx(tailRiskRatio(p2), (p2.reduce((a, b) => a + b, 0) / 10) / 0.20);
});
test('decideCallKill: KILLED iff best-cell mean <= 0', () => {
  assert.equal(decideCallKill(-0.01).killed, true);
  assert.equal(decideCallKill(0.05).killed, false);
});
test('decidePutGate requires all band CI los > 0, spike on, and tailRatio beats the stock', () => {
  assert.equal(decidePutGate({ bandCIlos: [0.01, 0.005], spikeOn: true, tailRatio: 0.2, stockTailRatio: 0.08 }).pass, true);
  assert.equal(decidePutGate({ bandCIlos: [0.01, -0.001], spikeOn: true, tailRatio: 0.2, stockTailRatio: 0.08 }).pass, false); // a band cell crosses 0
  assert.equal(decidePutGate({ bandCIlos: [0.01], spikeOn: false, tailRatio: 0.2, stockTailRatio: 0.08 }).pass, false); // spike off
  assert.equal(decidePutGate({ bandCIlos: [0.01], spikeOn: true, tailRatio: 0.05, stockTailRatio: 0.08 }).pass, false); // worse than stock
});
