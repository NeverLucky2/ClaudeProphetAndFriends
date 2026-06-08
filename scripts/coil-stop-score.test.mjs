import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopDeltas, saveWhipsawDecomp, frictionizeCandidates, decideStop } from './coil-stop-score.mjs';

// Two marginal entries at -5%: one SAVE (baseline went to the -7% stop, tightened locks -5%),
// one WHIPSAW (baseline reverted to +2% via sma5, tightened stopped at -5%).
const marginal = [
  { date: '2020-01-01', grossBase: -0.07, baseReason: 'stop',
    perS: { '0.05': { gross: -0.05, exitReason: 'stop' }, '0.03': { gross: -0.03, exitReason: 'stop' } } },
  { date: '2020-01-02', grossBase: 0.02, baseReason: 'sma5_cross',
    perS: { '0.05': { gross: -0.05, exitReason: 'stop' }, '0.03': { gross: -0.03, exitReason: 'stop' } } },
  { date: '2020-01-03', grossBase: 0.01, baseReason: 'sma5_cross',
    perS: { '0.05': { gross: 0.01, exitReason: 'sma5_cross' }, '0.03': { gross: -0.03, exitReason: 'stop' } } }, // NOT marginal at 0.05
];

test('stopDeltas computes the friction-net paired delta over only the entries marginal at s', () => {
  const rows = stopDeltas(marginal, 0.05, { frictionBps: 20 });
  assert.equal(rows.length, 2); // third entry is unchanged at 0.05 -> excluded
  // friction cancels at 20bps no-slip: delta = grossS - grossBase
  const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
  assert.ok(Math.abs(byDate['2020-01-01'].net - 0.02) < 1e-12);  // -0.05 - (-0.07) = +0.02 SAVE
  assert.equal(byDate['2020-01-01'].branch, 'save');
  assert.ok(Math.abs(byDate['2020-01-02'].net - (-0.07)) < 1e-12); // -0.05 - 0.02 = -0.07 WHIPSAW
  assert.equal(byDate['2020-01-02'].branch, 'whipsaw');
});

test('stopDeltas stop-slippage arm docks slip on stop legs only, worsening whipsaws', () => {
  const rows = stopDeltas(marginal, 0.05, { frictionBps: 20, stopSlipBps: 10 });
  const byDate = Object.fromEntries(rows.map(r => [r.date, r]));
  // SAVE: both legs are stops -> slip cancels -> unchanged at +0.02
  assert.ok(Math.abs(byDate['2020-01-01'].net - 0.02) < 1e-12);
  // WHIPSAW: only the -5% leg is a stop -> delta worsens by 10bps -> -0.07 - 0.001 = -0.071
  assert.ok(Math.abs(byDate['2020-01-02'].net - (-0.071)) < 1e-12);
});

test('saveWhipsawDecomp partitions by sign and sums each branch', () => {
  const d = saveWhipsawDecomp([{ net: 0.02 }, { net: -0.07 }, { net: 0.01 }]);
  assert.equal(d.n, 3);
  assert.equal(d.nSave, 2); assert.ok(Math.abs(d.saveSum - 0.03) < 1e-12);
  assert.equal(d.nWhipsaw, 1); assert.ok(Math.abs(d.dragSum - (-0.07)) < 1e-12);
  assert.ok(Math.abs(d.net - (-0.04)) < 1e-12);
});

test('frictionizeCandidates maps gross->net and docks stop-slip on stop exits only', () => {
  const cands = [
    { ticker: 'A', date: '2020-01-01', rsi2: 1, exitDate: '2020-01-03', exitReason: 'stop', gross: -0.05 },
    { ticker: 'B', date: '2020-01-01', rsi2: 2, exitDate: '2020-01-03', exitReason: 'sma5_cross', gross: 0.02 },
  ];
  const out = frictionizeCandidates(cands, { bps: 20, stopSlipBps: 10 });
  assert.ok(Math.abs(out[0].net - (-0.05 - 0.002 - 0.001)) < 1e-12); // 20bps + 10bps slip on the stop
  assert.ok(Math.abs(out[1].net - (0.02 - 0.002)) < 1e-12);          // 20bps only (not a stop)
});

test('decideStop: TIGHTEN only when both gates pass; labeled KEEPs otherwise; underpowered floor', () => {
  assert.equal(decideStop({ gateA: true, gateB: true, nMarginal: 50 }).verdict, 'TIGHTEN');
  assert.match(decideStop({ gateA: false, gateB: true, nMarginal: 50 }).reason, /no material risk reduction/);
  assert.match(decideStop({ gateA: true, gateB: false, nMarginal: 50 }).reason, /return give-up too large/);
  assert.match(decideStop({ gateA: false, gateB: false, nMarginal: 50 }).reason, /strictly dominated/);
  assert.equal(decideStop({ gateA: true, gateB: true, nMarginal: 12 }).verdict, 'UNDERPOWERED');
});
