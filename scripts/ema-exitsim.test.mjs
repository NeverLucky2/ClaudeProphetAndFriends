// scripts/ema-exitsim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateEmaTrade, netWithCosts } from './ema-exitsim.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('long stop gap-through fills at the open (worse than stop)', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },     // entry idx 0
    { open: 90, high: 91, low: 89, close: 90 }];                    // gaps below stop(=97)
  const t = simulateEmaTrade(bars, 0, { direction: 1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 5 });
  assert.equal(t.exitReason, 'stop');
  approx(t.exit, 90);                       // open, not the 97 stop
  approx(t.grossReturn, (90 - 100) / 100);
});

test('long target gap-up fills at the target, NOT the better open', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },
    { open: 110, high: 111, low: 109, close: 110 }];                // gaps above target(=103)
  const t = simulateEmaTrade(bars, 0, { direction: 1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 5 });
  assert.equal(t.exitReason, 'target');
  approx(t.exit, 103);                       // capped at target, not 110
  approx(t.grossReturn, (103 - 100) / 100);
});

test('same-bar both touched → booked as loss + flagged', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },
    { open: 100, high: 104, low: 96, close: 100 }];                 // hits target(103) AND stop(97)
  const t = simulateEmaTrade(bars, 0, { direction: 1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 5 });
  assert.equal(t.exitReason, 'stop');
  assert.equal(t.sameBarBoth, true);
  assert.ok(t.grossReturn < 0);
});

test('short profit is positive grossReturn (direction-signed)', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },
    { open: 97, high: 98, low: 96, close: 97 }];                    // short target(=97) hit
  const t = simulateEmaTrade(bars, 0, { direction: -1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 5 });
  assert.equal(t.exitReason, 'target');
  approx(t.grossReturn, (100 - 97) / 100);   // positive: price fell
});

test('time stop exits at close when no bracket hit', () => {
  const bars = [{ open: 100, high: 100, low: 100, close: 100 },
    { open: 100, high: 100.5, low: 99.5, close: 100.2 }];
  const t = simulateEmaTrade(bars, 0, { direction: 1, atr: 2, kStop: 1.5, kTarget: 1.5, maxHold: 1 });
  assert.equal(t.exitReason, 'time_stop');
  approx(t.exit, 100.2);
});

test('netWithCosts: shorts pay borrow, longs do not', () => {
  const g = 0.01;
  approx(netWithCosts(g, { direction: 1, daysHeld: 10, frictionBps: 20, borrowBpsAnnual: 200 }), g - 0.002);
  approx(netWithCosts(g, { direction: -1, daysHeld: 10, frictionBps: 20, borrowBpsAnnual: 200 }),
    g - 0.002 - (0.02 * 10 / 252));
});
