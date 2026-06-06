import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unionDates, alignDaily, toWeekly } from './fleet-align.mjs';

test('unionDates merges + sorts + dedupes lane date indices', () => {
  const a = [{ date: '2016-01-04', ret: 0.1, active: true }];
  const b = [{ date: '2016-01-05', ret: -0.1, active: true }, { date: '2016-01-04', ret: 0, active: false }];
  assert.deepEqual(unionDates({ A: a, B: b }), ['2016-01-04', '2016-01-05']);
});

test('alignDaily zero-fills missing lane days and carries active flag', () => {
  const lanes = { A: [{ date: '2016-01-05', ret: 0.2, active: true }] };
  const aligned = alignDaily(lanes, ['2016-01-04', '2016-01-05']);
  assert.deepEqual(aligned.A[0], { date: '2016-01-04', ret: 0, active: false });
  assert.deepEqual(aligned.A[1], { date: '2016-01-05', ret: 0.2, active: true });
});

test('toWeekly compounds daily returns within an ISO week and ORs the active flag', () => {
  const daily = [
    { date: '2016-01-04', ret: 0.1, active: true },  // Mon
    { date: '2016-01-05', ret: 0.1, active: false }, // Tue, same ISO week
  ];
  const w = toWeekly(daily);
  assert.equal(w.length, 1);
  assert.ok(Math.abs(w[0].ret - ((1.1 * 1.1) - 1)) < 1e-9);
  assert.equal(w[0].active, true);
});

test('toWeekly splits across ISO week boundaries', () => {
  const daily = [
    { date: '2016-01-08', ret: 0.0, active: false }, // Fri W01
    { date: '2016-01-11', ret: 0.0, active: false }, // Mon W02
  ];
  assert.equal(toWeekly(daily).length, 2);
});
