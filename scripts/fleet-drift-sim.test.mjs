import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGapPct, grade, isContinuation, driftEntryQualifies, driftExit, simulateDrift } from './fleet-drift-sim.mjs';

test('computeGapPct: BMO = open[E]/close[E-1]-1; AMC = open[E+1]/close[E]-1', () => {
  const bars = [{ date: '2024-05-01', close: 100, open: 99 }, { date: '2024-05-02', close: 105, open: 103 }, { date: '2024-05-03', close: 108, open: 106 }];
  assert.ok(Math.abs(computeGapPct(bars, '2024-05-02', 'bmo') - (103 / 100 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(computeGapPct(bars, '2024-05-02', 'amc') - (106 / 105 - 1) * 100) < 1e-9);
});
test('grade thresholds A>=85 B>=70 C>=55 else D', () => {
  assert.equal(grade(85), 'A'); assert.equal(grade(70), 'B'); assert.equal(grade(55), 'C'); assert.equal(grade(54.9), 'D');
});
test('isContinuation: >=1 day after gap AND close>gapBarHigh AND close>priorHigh', () => {
  assert.equal(isContinuation({ daysAfterGap: 2, latestClose: 110, gapBarHigh: 105, priorHigh: 108 }), true);
  assert.equal(isContinuation({ daysAfterGap: 2, latestClose: 104, gapBarHigh: 105, priorHigh: 108 }), false);
});
test('entry filter: gap>=3 AND aboveMA200 AND aboveMA50 AND grade in {A,B} AND (continuation OR pead-ready)', () => {
  const base = { gapPct: 5, aboveMA200: true, aboveMA50: true, grade: 'B', continuation: true, peadStage: 'MONITORING' };
  assert.equal(driftEntryQualifies(base), true);
  assert.equal(driftEntryQualifies({ ...base, gapPct: 2 }), false);
  assert.equal(driftEntryQualifies({ ...base, continuation: false, peadStage: 'MONITORING' }), false);
  assert.equal(driftEntryQualifies({ ...base, continuation: false, peadStage: 'SIGNAL_READY' }), true);
});
test('exits: +20% target, -10% stop, 60-day time stop, MA50 break', () => {
  assert.equal(driftExit({ pnlPct: 0.21, daysHeld: 5, aboveMA50: true }).reason, 'target');
  assert.equal(driftExit({ pnlPct: -0.11, daysHeld: 5, aboveMA50: true }).reason, 'stop');
  assert.equal(driftExit({ pnlPct: 0.05, daysHeld: 60, aboveMA50: true }).reason, 'time_stop');
  assert.equal(driftExit({ pnlPct: 0.05, daysHeld: 5, aboveMA50: false }).reason, 'ma50_break');
  assert.equal(driftExit({ pnlPct: 0.05, daysHeld: 5, aboveMA50: true }).reason, '');
});

// Synthetic event: a strongly-trending name (above MA200/MA50), an 8% BMO earnings gap at bar 240,
// and a higher-high continuation close the next bar → a qualifying continuation entry.
function makeDriftEvent() {
  const dates = [];
  const d = new Date('2022-01-03T12:00:00Z');
  for (let i = 0; i < 260; i += 1) { dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  const bars = dates.map((date, i) => {
    const c = 100 * Math.pow(1.004, i);
    return { date, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1_000_000 };
  });
  const c239 = bars[239].close;
  bars[240] = { date: dates[240], open: c239 * 1.08, close: c239 * 1.085, high: c239 * 1.085 * 1.001, low: c239 * 1.08 * 0.999, volume: 2_000_000 };
  const c240 = bars[240].close;
  bars[241] = { date: dates[241], open: c240, close: c240 * 1.01, high: c240 * 1.01 * 1.001, low: c240 * 0.999, volume: 2_000_000 };
  for (let i = 242; i < 260; i += 1) { const c = bars[241].close * Math.pow(1.004, i - 241); bars[i] = { date: dates[i], open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1_000_000 }; }
  return { barsByTicker: new Map([['TESTCO', bars]]), earningsByTicker: { TESTCO: [{ date: dates[240], timing: 'bmo' }] } };
}

test('simulateDrift enters on a qualifying post-earnings continuation event and marks daily', () => {
  const ev = makeDriftEvent();
  const series = simulateDrift(ev.barsByTicker, ev.earningsByTicker, { start: '2022-01-01', end: '2026-06-06', portfolio: 100000 });
  assert.ok(series.length > 0);
  assert.ok(series.every(p => typeof p.ret === 'number' && typeof p.active === 'boolean'));
  assert.ok(series.some(p => p.active === true)); // the event produced a held position
});
