import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanel } from './eov-build.mjs';

function synth() {
  const N = 60;
  const dates = Array.from({ length: N }, (_, i) => `2024-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`);
  const names = Array.from({ length: 12 }, (_, i) => `T${i}`);
  const callVolByName = {}, stockBarsByName = {}, splitsByName = {};
  names.forEach((nm, k) => {
    const cv = {}; const bars = [];
    for (let i = 0; i < N; i += 1) {
      cv[dates[i]] = 100 + ((i * (k + 1)) % 50);            // varies by name/day
      const px = 100 + i * 0.1 + k;                          // gentle uptrend
      bars.push({ date: dates[i], open: px, close: px + 0.05 });
    }
    callVolByName[nm] = cv; stockBarsByName[nm] = bars; splitsByName[nm] = [];
  });
  // benchmarks
  for (const b of ['QQQ', 'SPY']) {
    stockBarsByName[b] = dates.map((d, i) => ({ date: d, open: 200 + i * 0.1, close: 200 + i * 0.1 }));
  }
  return { callVolByName, stockBarsByName, splitsByName, universe: names, dates };
}

test('buildPanel yields warm-up-respecting panel with train/holdout split', () => {
  const s = synth();
  const b = buildPanel({ ...s, window: 21, horizons: [1, 3, 5], kLeg: 5, minNames: 12, splitFrac: 0.7 });
  // first 21 days are warm-up -> earliest valid formation date is at/after index 21
  assert.ok(b.meta.validDates[0] >= s.dates[21]);
  assert.ok(b.meta.trainN > 0 && b.meta.holdoutN > 0);
  assert.equal(b.meta.trainN + b.meta.holdoutN, b.meta.validDates.length);
  // every spread row has matched qqq window return + a split label
  for (const row of b.spread['3']) {
    assert.ok(Number.isFinite(row.grossSpread));
    assert.ok(Number.isFinite(row.qqqRet));
    assert.ok(row.split === 'train' || row.split === 'holdout');
  }
  // legs at h=3 carry 5 top + 5 bottom per formation date
  const oneDate = b.spread['3'][0].date;
  const legsThatDay = b.legs['3'].filter(r => r.date === oneDate);
  assert.equal(legsThatDay.filter(r => r.leg === 'top').length, 5);
  assert.equal(legsThatDay.filter(r => r.leg === 'bottom').length, 5);
});

test('buildPanel excludes a split window from the affected name only', () => {
  const s = synth();
  s.splitsByName['T0'] = [s.dates[25]]; // split mid-window
  const b = buildPanel({ ...s, window: 21, horizons: [3], kLeg: 5, minNames: 12, splitFrac: 0.7 });
  // T0 must not appear in any leg row whose date is in [dates[25], dates[25]+21]
  const excluded = new Set(s.dates.slice(25, 25 + 22));
  assert.ok(!b.legs['3'].some(r => r.ticker === 'T0' && excluded.has(r.date)));
});
