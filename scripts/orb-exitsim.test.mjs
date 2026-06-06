// scripts/orb-exitsim.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateOrbTrade } from './orb-exitsim.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);
function sess(bars) { return { date: 'd', bars }; }

test('long stops out gap-honest; R-multiple ≈ -1 on a clean stop', () => {
  const bars = [
    { minutes: 590, open: 101, high: 101.5, low: 100.9, close: 101 }, // entry bar, entryFill 101
    { minutes: 595, open: 100.2, high: 100.3, low: 99.5, close: 99.8 }, // low 99.5 ≤ stop 100 → stop
  ];
  const sig = { direction: 1, entryMinutes: 590, entryFill: 101, stop: 100 };
  const t = simulateOrbTrade(sess(bars), sig);
  assert.equal(t.exitReason, 'stop');
  approx(t.exit, 100);                 // intrabar touch fills at stop
  approx(t.R, 1);
  approx(t.rMultiple, (100 - 101) / 1); // -1
});

test('long gap-through stop fills at the bar open (worse than stop)', () => {
  const bars = [
    { minutes: 590, open: 101, high: 101, low: 101, close: 101 },
    { minutes: 595, open: 99, high: 99, low: 98, close: 98 },  // opens below stop 100
  ];
  const sig = { direction: 1, entryMinutes: 590, entryFill: 101, stop: 100 };
  const t = simulateOrbTrade(sess(bars), sig);
  assert.equal(t.exitReason, 'stop');
  approx(t.exit, 99);                  // gap-through → open
});

test('EOD exit at last bar close when stop never hit; positive R on a winner', () => {
  const bars = [
    { minutes: 590, open: 101, high: 101, low: 101, close: 101 },
    { minutes: 955, open: 104, high: 105, low: 103.9, close: 104.5 }, // last bar
  ];
  const sig = { direction: 1, entryMinutes: 590, entryFill: 101, stop: 100 };
  const t = simulateOrbTrade(sess(bars), sig);
  assert.equal(t.exitReason, 'eod');
  approx(t.exit, 104.5);
  approx(t.rMultiple, (104.5 - 101) / 1); // +3.5R
});

test('short winner: positive R when price falls to EOD', () => {
  const bars = [
    { minutes: 590, open: 99, high: 99, low: 99, close: 99 },
    { minutes: 955, open: 97, high: 97.5, low: 96, close: 96.5 },
  ];
  const sig = { direction: -1, entryMinutes: 590, entryFill: 99, stop: 100 }; // R=1
  const t = simulateOrbTrade(sess(bars), sig);
  assert.equal(t.exitReason, 'eod');
  approx(t.rMultiple, (-1) * (96.5 - 99) / 1); // +2.5R
});
