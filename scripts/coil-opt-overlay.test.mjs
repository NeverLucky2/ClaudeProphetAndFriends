// scripts/coil-opt-overlay.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitIV, callPnl, putPnlMirror, putPnlHoldToExpiry } from './coil-opt-overlay.mjs';
const approx = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('exitIV crushes on bounce, spikes on loser', () => {
  approx(exitIV(0.4, 100, 105, 0.2, 0.3), 0.4 * 0.8);   // S1>=S0 → crush
  approx(exitIV(0.4, 100, 95, 0.2, 0.3), 0.4 * 1.3);    // S1<S0 → spike
});
test('long call profits on a clean bounce (return on premium > 0)', () => {
  const r = callPnl({ S0: 100, S1: 106, daysHeld: 2, ivEntry: 0.4, dte: 14, r: 0.04, crush: 0, spike: 0.3, spreadPct: 0.10 });
  assert.ok(r > 0);
});
test('CSP hold-to-expiry keeps full premium when S_exp >= S0; loses big on a deep drop', () => {
  const win = putPnlHoldToExpiry({ S0: 100, S_exp: 103, ivEntry: 0.4, dte: 14, r: 0.04, spreadPct: 0.10 });
  const lose = putPnlHoldToExpiry({ S0: 100, S_exp: 80, ivEntry: 0.4, dte: 14, r: 0.04, spreadPct: 0.10 });
  assert.ok(win > 0 && lose < 0 && lose < -0.1);  // -20% intrinsic dwarfs premium
});
test('CSP mirror-exit: loser spike makes the buy-back more expensive (worse) than no spike', () => {
  const noSpike = putPnlMirror({ S0: 100, S1: 96, daysHeld: 2, ivEntry: 0.4, dte: 14, r: 0.04, crush: 0.2, spike: 0, spreadPct: 0.10 });
  const withSpike = putPnlMirror({ S0: 100, S1: 96, daysHeld: 2, ivEntry: 0.4, dte: 14, r: 0.04, crush: 0.2, spike: 0.6, spreadPct: 0.10 });
  assert.ok(withSpike < noSpike); // spike on the loser hurts the short put
});
