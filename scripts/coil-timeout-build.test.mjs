import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enumeratePaired, enumeratePortfolio, boundaryFrom, tagSplit } from './coil-timeout-build.mjs';

// Tiny bars: 6 entries; dates only matter for ordering. open/high/low/close present so the
// real sim COULD run, but we inject stub entry/sim to control outcomes deterministically.
function bars(n) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2020-01-${String(i + 1).padStart(2, '0')}`,
    open: 100, high: 101, low: 99, close: 100,
  }));
}

test('enumeratePaired keeps only time_stop@5 entries and re-sims each under every T', () => {
  const b = bars(40);
  // entry fires at indices 10 and 20 only
  const entryFires = (_closes, i) => i === 10 || i === 20;
  // idx 10 → time_stop@5 (paired); idx 20 → sma5_cross@5 (NOT paired)
  const sim = (_b, idx, { maxHold = 5 } = {}) => {
    if (idx === 10) {
      if (maxHold === 5) return { exitReason: 'time_stop', daysHeld: 5, grossReturn: -0.02, censored: false };
      if (maxHold === 7) return { exitReason: 'stop', daysHeld: 6, grossReturn: -0.07, censored: false };
      return { exitReason: 'time_stop', daysHeld: maxHold, grossReturn: 0.01, censored: false };
    }
    return { exitReason: 'sma5_cross', daysHeld: 2, grossReturn: 0.03, censored: false };
  };
  const out = enumeratePaired(b, { variants: [7, 8, 10], minBars: 0, entryFires, sim });
  assert.equal(out.length, 1);              // only the time_stop@5 entry is paired
  assert.equal(out[0].idx, 10);
  assert.equal(out[0].gross5, -0.02);
  assert.equal(out[0].perT['7'].exitReason, 'stop');   // conversion at T=7
  assert.equal(out[0].perT['7'].gross, -0.07);
  assert.equal(out[0].perT['10'].exitReason, 'time_stop');
});

test('enumeratePortfolio advances openUntil by the variant hold (longer T suppresses a re-entry)', () => {
  const b = bars(40);
  const entryFires = (_closes, i) => i === 10 || i === 13 || i === 20;
  // a hold of `maxHold` days; never censored here
  const sim = (_b, idx, { maxHold = 5 } = {}) => ({ exitReason: 'time_stop', daysHeld: maxHold, grossReturn: 0.01, censored: false });
  // At T=5: entry@10 holds to 15, so 13 is suppressed; 20 is free → entries {10,20}
  const t5 = enumeratePortfolio(b, { T: 5, minBars: 0, entryFires, sim });
  assert.deepEqual(t5.map(r => r.idx), [10, 20]);
  // Same here at T=8 (10→18 still suppresses 13); entries {10,20}
  const t8 = enumeratePortfolio(b, { T: 8, minBars: 0, entryFires, sim });
  assert.deepEqual(t8.map(r => r.idx), [10, 20]);
  assert.equal(t5[0].exitDate, b[15].date);
  assert.equal(t8[0].exitDate, b[18].date);
});

test('enumeratePortfolio drops censored entries (no exitDate)', () => {
  const b = bars(40);
  const entryFires = (_closes, i) => i === 38;
  const sim = () => ({ exitReason: null, daysHeld: 1, grossReturn: null, censored: true });
  assert.deepEqual(enumeratePortfolio(b, { T: 5, minBars: 0, entryFires, sim }), []);
});

test('boundaryFrom returns the first holdout date (chrono 50/50)', () => {
  const recs = [{ date: '2020-01-04' }, { date: '2020-01-01' }, { date: '2020-01-03' }, { date: '2020-01-02' }];
  assert.equal(boundaryFrom(recs), '2020-01-03'); // sorted [01,02,03,04]; mid=2 → '2020-01-03'
});

test('tagSplit assigns train below the boundary, holdout at/above it', () => {
  const recs = [{ date: '2020-01-02' }, { date: '2020-01-03' }, { date: '2020-01-05' }];
  const tagged = tagSplit(recs, '2020-01-03');
  assert.deepEqual(tagged.map(r => r.split), ['train', 'holdout', 'holdout']);
});
