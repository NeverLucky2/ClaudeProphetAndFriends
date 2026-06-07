import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthPlan, simulateCarry } from './carry-sim.mjs';
import { roundTripCost } from './carry-friction.mjs';

// month-end curve rows (ascending) + monthly decisions aligned to them.
const ME = [
  { date: '2021-12-31', m3: 1.20 }, // sets month plan for 2022-01
  { date: '2022-01-31', m3: 2.40 }, // sets month plan for 2022-02
];
const DEC = [
  { month: '2021-12', hold: true },  // → 2022-01 holds IEF
  { month: '2022-01', hold: false }, // → 2022-02 cash
];

test('buildMonthPlan shifts each month-end decision to the NEXT month, carrying its cash rate', () => {
  const plan = buildMonthPlan(ME, DEC);
  assert.deepEqual(plan.get('2022-01'), { hold: true, cashRate: 1.20 });
  assert.deepEqual(plan.get('2022-02'), { hold: false, cashRate: 2.40 });
});

const IEF = [
  { date: '2022-01-03', close: 100 },
  { date: '2022-01-04', close: 101 }, // +1% holding day (Jan → hold)
  { date: '2022-02-01', close: 99 },  // first cash day (Feb → cash): exit charged here
  { date: '2022-02-02', close: 98 },  // cash day
];

test('holding days take IEF price return + active=true', () => {
  const plan = buildMonthPlan(ME, DEC);
  const { daily } = simulateCarry(IEF, plan, { stressMult: 1, start: '2022-01-01', end: '2022-12-31' });
  const jan4 = daily.find((d) => d.date === '2022-01-04');
  assert.ok(Math.abs(jan4.ret - 0.01) < 1e-9);
  assert.equal(jan4.active, true);
});
test('cash days accrue m3/100/252 with zero price vol + active=false; exit day pays the round trip', () => {
  const plan = buildMonthPlan(ME, DEC);
  const { daily, episodes } = simulateCarry(IEF, plan, { stressMult: 1, start: '2022-01-01', end: '2022-12-31' });
  const feb1 = daily.find((d) => d.date === '2022-02-01'); // exit day (was holding, now cash)
  const expectedAccrual = (2.40 / 100) / 252;
  assert.ok(Math.abs(feb1.ret - (expectedAccrual - roundTripCost(1))) < 1e-12);
  assert.equal(feb1.active, false);
  const feb2 = daily.find((d) => d.date === '2022-02-02'); // pure cash day, no friction
  assert.ok(Math.abs(feb2.ret - expectedAccrual) < 1e-12);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].start, '2022-01-04'); // first holding day with a return
  assert.equal(episodes[0].end, '2022-01-04');   // last holding day before exit
});
