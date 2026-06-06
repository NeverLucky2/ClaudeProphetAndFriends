// scripts/orb-marketrel.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spyWindowReturn, netR, mktRelR } from './orb-marketrel.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('spyWindowReturn uses open@entry and close@exit on the same date', () => {
  const spy = new Map([['d|590', { open: 400, close: 400 }], ['d|955', { open: 404, close: 404 }]]);
  approx(spyWindowReturn(spy, 'd', 590, 955), 404 / 400 - 1);
});
test('netR subtracts friction in R-units (friction%/Rpct)', () => {
  const trade = { entry: 100, R: 1, rMultiple: 2, retPct: 0.02, direction: 1 };
  const Rpct = 1 / 100; // 0.01
  approx(netR(trade, 20), 2 - (20 / 10000) / Rpct); // 2 - 0.002/0.01 = 1.8
});
test('mktRelR hedges sign-aware then converts to R-units', () => {
  const trade = { entry: 100, R: 1, retPct: 0.02, direction: 1 };
  const Rpct = 0.01;
  // residual% = 0.02 - 1*1.0*0.012 = 0.008 ; net of 20bps = 0.006 ; /Rpct = 0.6
  approx(mktRelR(trade, 20, 1.0, 0.012), (0.02 - 1 * 1.0 * 0.012 - 20 / 10000) / Rpct);
});
