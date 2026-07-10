import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFrontrun, monitor, renderMonitor } from './coil-frontrun-monitor.mjs';
import { buildFrontrunPrereg } from './coil-frontrun-prereg.mjs';

const CI = (lo, hi) => ({ lo, hi, mean: (lo + hi) / 2, nA: 100, nB: 100 });

test('decideFrontrun: UNDERPOWERED below the n gate, regardless of the CI', () => {
  const d = decideFrontrun({
    nForward: 10, pooled: CI(-0.30, -0.10),
    byTercile: { low: CI(-0.3, -0.1), mid: CI(-0.3, -0.1), high: CI(-0.3, -0.1) }, nGate: 200,
  });
  assert.equal(d.verdict, 'UNDERPOWERED');
  assert.match(d.reason, /n=10/);
});

test('decideFrontrun: SUPPORTED needs pooled hi<0 AND >=2 of 3 terciles hi<0', () => {
  const d = decideFrontrun({
    nForward: 500, pooled: CI(-0.20, -0.05),
    byTercile: { low: CI(-0.3, -0.1), mid: CI(-0.3, -0.05), high: CI(-0.1, 0.2) }, nGate: 200,
  });
  assert.equal(d.verdict, 'SUPPORTED');
  assert.equal(d.gate3, true);
});

test('decideFrontrun: a pooled effect confined to ONE tercile is NOT_SUPPORTED', () => {
  const d = decideFrontrun({
    nForward: 500, pooled: CI(-0.20, -0.02),
    byTercile: { low: CI(-0.4, -0.2), mid: CI(-0.1, 0.1), high: CI(-0.1, 0.2) }, nGate: 200,
  });
  assert.equal(d.verdict, 'NOT_SUPPORTED');
  assert.equal(d.gate3, false);
});

test('decideFrontrun: a pooled CI straddling zero is NOT_SUPPORTED', () => {
  const d = decideFrontrun({
    nForward: 500, pooled: CI(-0.20, 0.05),
    byTercile: { low: CI(-0.3, -0.1), mid: CI(-0.3, -0.1), high: CI(-0.3, -0.1) }, nGate: 200,
  });
  assert.equal(d.verdict, 'NOT_SUPPORTED');
  assert.equal(d.gate2, false);
});

test('decideFrontrun: a null tercile CI counts as not-passing, never as passing', () => {
  const d = decideFrontrun({
    nForward: 500, pooled: CI(-0.20, -0.05),
    byTercile: { low: CI(-0.3, -0.1), mid: { lo: null, hi: null }, high: { lo: null, hi: null } }, nGate: 200,
  });
  assert.equal(d.verdict, 'NOT_SUPPORTED');
});

test('monitor refuses to run on a tampered prereg', () => {
  const eps = [
    { ticker: 'A', date: '2021-01-04', outcome: 'FIRE', vol: 0.01 },
    { ticker: 'A', date: '2021-01-05', outcome: 'BOUNCE', vol: 0.02 },
    { ticker: 'A', date: '2021-01-06', outcome: 'BOUNCE', vol: 0.03 },
  ];
  const p = buildFrontrunPrereg({ episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z' });
  p.n_gate = 5;
  assert.throws(() => monitor(eps, p), /prereg hash mismatch/);
});

test('monitor splits at forward_window_start and reports nForward', () => {
  const eps = [];
  for (let i = 0; i < 40; i += 1) eps.push({ ticker: 'A', date: `2021-02-${String((i % 27) + 1).padStart(2, '0')}`, outcome: i % 2 ? 'FIRE' : 'BOUNCE', vol: 0.01 });
  const p = buildFrontrunPrereg({ episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z' });
  const fwd = [{ ticker: 'A', date: '2026-08-01', outcome: 'BOUNCE', vol: 0.01 }];
  const r = monitor([...eps, ...fwd], p);
  assert.equal(r.nForward, 1);
  assert.equal(r.decision.verdict, 'UNDERPOWERED');
});

test('monitor reports a trailing-12-month rate distinct from the pooled benchmark', () => {
  const eps = [];
  // Old history: all FIRE (high conversion).
  for (let i = 0; i < 20; i += 1) eps.push({ ticker: 'A', date: `2022-03-${String(i + 1).padStart(2, '0')}`, outcome: 'FIRE', vol: 0.01 });
  // The 12 months before the window: all BOUNCE (rate already 0).
  for (let i = 0; i < 20; i += 1) eps.push({ ticker: 'A', date: `2026-03-${String(i + 1).padStart(2, '0')}`, outcome: 'BOUNCE', vol: 0.01 });
  const p = buildFrontrunPrereg({ episodes: eps, forwardWindowStart: '2026-07-09', nGate: 200, createdUtc: '2026-07-09T00:00:00Z' });
  assert.equal(p.benchmark_conversion_rate, 0.5);        // pooled benchmark
  const fwd = [{ ticker: 'A', date: '2026-08-01', outcome: 'BOUNCE', vol: 0.01 }];
  const r = monitor([...eps, ...fwd], p);
  // The decline is entirely pre-existing: the trailing-12m rate is already 0, so a "forward < pooled"
  // result would be pure trend continuation. This is exactly what the secondary comparison surfaces.
  assert.equal(r.trailing12Rate, 0);
  assert.notEqual(r.trailing12Rate, p.benchmark_conversion_rate);
  assert.ok(r.trailing12);
});

test('renderMonitor states the verdict, the n gate, and the trend-continuation caveat', () => {
  const md = renderMonitor({
    prereg: { artifact_hash: 'abc12345', n_gate: 200, benchmark_conversion_rate: 0.2, forward_window_start: '2026-07-09' },
    result: {
      nForward: 5, nHistorical: 40, forwardRate: 0.2,
      pooled: { lo: -0.1, hi: 0.1, mean: 0 },
      byTercile: { low: { lo: null, hi: null }, mid: { lo: null, hi: null }, high: { lo: null, hi: null } },
      trailing12: { lo: null, hi: null, mean: null }, trailing12Rate: 0.1,
      decision: { verdict: 'UNDERPOWERED', reason: 'n=5 < 200', gate1: false, gate2: false, gate3: false },
      mde: 0.05,
    },
  });
  assert.match(md, /UNDERPOWERED/);
  assert.match(md, /trend continuation/i);
  assert.match(md, /trailing-12-month/i);
  assert.match(md, /abc12345/);
});
