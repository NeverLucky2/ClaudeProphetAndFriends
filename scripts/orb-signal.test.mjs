// scripts/orb-signal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orbSignal } from './orb-signal.mjs';

// helper: build a session with three OR bars then post-OR bars
function session(orBars, postBars) {
  const bars = [];
  const mins = [570, 575, 580];
  orBars.forEach((b, i) => bars.push({ minutes: mins[i], ...b }));
  let m = 585;
  for (const b of postBars) { bars.push({ minutes: m, ...b }); m += 5; }
  return { date: '2020-01-02', bars };
}
const flat = (c, v = 100) => ({ open: c, high: c, low: c, close: c, volume: v });

test('long: close breaks OR high + above VWAP → fills at NEXT bar open', () => {
  const s = session(
    [flat(100), flat(100), flat(100)],            // OR = [100,100]
    [{ open: 100, high: 101.5, low: 100, close: 101, volume: 100 }, // trigger: close 101 > 100, > vwap
     { open: 101.2, high: 102, low: 101, close: 101.8, volume: 100 }], // entry fills here at open 101.2
  );
  const sig = orbSignal(s);
  assert.equal(sig.direction, 1);
  assert.equal(sig.triggerMinutes, 585);
  assert.equal(sig.entryMinutes, 590);
  assert.equal(sig.entryFill, 101.2);   // next bar OPEN, not the trigger close
  assert.equal(sig.stop, 100);          // OR low
});

test('no trade when no post-OR close breaks the range', () => {
  const s = session([flat(100), flat(100), flat(100)], [flat(100), flat(100)]);
  assert.equal(orbSignal(s), null);
});

test('VWAP filter rejects a break that is on the wrong side of VWAP', () => {
  // huge early up-volume pulls VWAP above a marginal high-break close → long rejected
  const s = session(
    [{ open: 100, high: 105, low: 100, close: 105, volume: 100000 }, flat(100), flat(100)],
    [{ open: 100, high: 100.6, low: 100, close: 100.5, volume: 1 }, flat(100.5)],
  );
  assert.equal(orbSignal(s), null); // close 100.5 > OR high 100 but < session VWAP (~104) → no long
});

test('no entry if the trigger is the last bar of the session', () => {
  const s = session([flat(100), flat(100), flat(100)], [{ open: 100, high: 102, low: 100, close: 101, volume: 100 }]);
  assert.equal(orbSignal(s), null);
});
