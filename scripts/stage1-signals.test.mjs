// scripts/stage1-signals.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupCatalysts, buildFirings, thinFirings, splitByDate } from './stage1-signals.mjs';

function risingBars(n, startDate = 1) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const close = 100 + i;
    out.push({ date: `2026-02-${String(startDate + i).padStart(2, '0')}`, open: close - 0.5, high: close + 1, low: close - 1, close });
  }
  return out;
}

test('groupCatalysts sums polarity per (ticker,date)', () => {
  const cats = [
    { ticker: 'AAA', date: '2026-02-25', event_type: 'earnings', headline: 'beats estimates', snippet: '' },
    { ticker: 'AAA', date: '2026-02-25', event_type: 'earnings', headline: 'raises guidance', snippet: '' },
  ];
  const g = groupCatalysts(cats);
  assert.equal(g.length, 1);
  assert.equal(g[0].sentiment, 1); // two positive cues -> +1
});

test('buildFirings fires only when sentiment agrees with bullish price-state', () => {
  const bars = risingBars(28); // rising -> bullish price-state from idx 19+
  const barsByTicker = new Map([['AAA', bars]]);
  // positive catalyst on a bullish day with computable forward return
  const cats = [{ ticker: 'AAA', date: bars[20].date, event_type: 'earnings', headline: 'tops estimates', snippet: '' }];
  const f = buildFirings(cats, barsByTicker, 3);
  assert.equal(f.length, 1);
  assert.equal(f[0].s, 1);
  assert.equal(f[0].hit, true);
});

test('buildFirings: disagreement (negative news on bullish tape) does not fire', () => {
  const bars = risingBars(28);
  const barsByTicker = new Map([['AAA', bars]]);
  const cats = [{ ticker: 'AAA', date: bars[20].date, event_type: 'earnings', headline: 'cuts guidance', snippet: '' }];
  assert.equal(buildFirings(cats, barsByTicker, 3).length, 0);
});

test('buildFirings: neutral sentiment does not fire', () => {
  const bars = risingBars(28);
  const cats = [{ ticker: 'AAA', date: bars[20].date, event_type: 'earnings', headline: 'new product color', snippet: '' }];
  assert.equal(buildFirings(cats, new Map([['AAA', bars]]), 3).length, 0);
});

test('thinFirings keeps firings >= H sessions apart per ticker', () => {
  const firings = [
    { ticker: 'AAA', dIdx: 20, date: 'd20' },
    { ticker: 'AAA', dIdx: 21, date: 'd21' }, // within H=3 of 20 -> dropped
    { ticker: 'AAA', dIdx: 23, date: 'd23' }, // 23-20=3 -> kept
    { ticker: 'BBB', dIdx: 5, date: 'b5' },    // different ticker -> kept
  ];
  const kept = thinFirings(firings, 3);
  assert.deepEqual(kept.map(f => `${f.ticker}:${f.dIdx}`), ['AAA:20', 'AAA:23', 'BBB:5']);
});

test('splitByDate tags train/holdout by split date', () => {
  const firings = [{ date: '2026-02-10' }, { date: '2026-02-20' }];
  const tagged = splitByDate(firings, '2026-02-15');
  assert.deepEqual(tagged.map(f => f.split), ['train', 'holdout']);
});
