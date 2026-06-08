import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumerateMarginal, enumeratePortfolioStop, MARGINAL_PROBE } from './coil-stop-build.mjs';

// Synthetic bars: ascending dates, controllable OHLC. A long flat warmup keeps idx >= MIN_BARS-1
// reachable in tests by passing minBars:2 and stubbed entryFires/sim.
function bars(rows) {
  return rows.map((r, i) => ({ date: `2020-01-${String(i + 1).padStart(2, '0')}`, open: r.o, high: r.h, low: r.l, close: r.c }));
}

test('enumerateMarginal keeps only entries a tighter stop changes (marginal at the 0.03 probe)', () => {
  const b = bars([{ o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }]);
  // entryFires only at idx 0. Baseline (0.07) sim = a time_stop at +0 (flat). A variant sim that
  // returns a DIFFERENT gross at the 0.03 probe makes the entry marginal; identical gross drops it.
  const baseRes = { entry: 100, exit: 100, exitReason: 'time_stop', daysHeld: 1, grossReturn: 0, censored: false };
  const stub = (which) => (bb, i, opts) => {
    if (opts.stopPct === 0.07) return baseRes;
    if (which === 'changed') return { ...baseRes, exit: 97, exitReason: 'stop', grossReturn: -0.03 };
    return baseRes; // unchanged
  };
  const kept = enumerateMarginal(b, { minBars: 2, variants: [0.03, 0.04, 0.05, 0.06], entryFires: (c, i) => i === 0, sim: stub('changed') });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].grossBase, 0);
  assert.equal(kept[0].baseReason, 'time_stop');
  assert.equal(kept[0].perS['0.03'].gross, -0.03);

  const dropped = enumerateMarginal(b, { minBars: 2, variants: [0.03, 0.04, 0.05, 0.06], entryFires: (c, i) => i === 0, sim: stub('unchanged') });
  assert.equal(dropped.length, 0); // not marginal anywhere -> dropped
});

test('MARGINAL_PROBE is the shallowest tighter stop in the variant set', () => {
  assert.equal(MARGINAL_PROBE, 0.03);
});

test('enumeratePortfolioStop emits one fresh trade per non-overlapping signal with exitDate + exitReason', () => {
  const b = bars([{ o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }]);
  const sim = (bb, i, opts) => ({ entry: 100, exit: 102, exitReason: 'sma5_cross', daysHeld: 1, grossReturn: 0.02, censored: false });
  const out = enumeratePortfolioStop(b, { stopPct: 0.05, minBars: 2, entryFires: (c, i) => i === 0, sim });
  assert.equal(out.length, 1);
  assert.equal(out[0].exitDate, b[1].date);
  assert.equal(out[0].exitReason, 'sma5_cross');
  assert.equal(out[0].gross, 0.02);
});

test('enumeratePortfolioStop stops at a censored trade (no exit within the data)', () => {
  const b = bars([{ o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 100, l: 100, c: 100 }]);
  const sim = () => ({ entry: 100, exit: null, exitReason: null, daysHeld: 1, grossReturn: null, censored: true });
  const out = enumeratePortfolioStop(b, { stopPct: 0.05, minBars: 1, entryFires: () => true, sim });
  assert.equal(out.length, 0);
});
