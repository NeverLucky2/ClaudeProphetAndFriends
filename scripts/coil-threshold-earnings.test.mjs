import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earningsWithinNext5, fetchEarningsDates, fetchEarningsDatesPerSymbol } from './coil-threshold-earnings.mjs';

const barDates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-12', '2026-01-13'];

test('excludes entry when earnings falls in the next 5 trading bars', () => {
  // entry at idx 0 (2026-01-05); earnings 2026-01-08 is within (d0, d5]
  assert.equal(earningsWithinNext5(barDates, 0, ['2026-01-08']), true);
});

test('captures earnings on a non-trading day inside the forward window', () => {
  // 2026-01-10 is a Saturday; window (2026-01-05, 2026-01-12] still contains it
  assert.equal(earningsWithinNext5(barDates, 0, ['2026-01-10']), true);
});

test('does NOT exclude a PAST earnings date (Coil only skips forward earnings)', () => {
  assert.equal(earningsWithinNext5(barDates, 3, ['2026-01-05']), false);
});

test('does NOT exclude when the next earnings is beyond the 5-bar window', () => {
  // entry idx 0, window ends at idx 5 = 2026-01-12; earnings 2026-01-13 is outside
  assert.equal(earningsWithinNext5(barDates, 0, ['2026-01-13']), false);
});

test('fetchEarningsDates parses the FMP stable earnings-calendar shape', async () => {
  const stub = async () => ({
    ok: true, status: 200,
    json: async () => [
      { symbol: 'KO', date: '2026-02-10' }, { symbol: 'AAPL', date: '2026-02-01' },
      { symbol: 'KO', date: '2026-05-12' }, { symbol: 'ZZZZ', date: '2026-02-02' },
    ],
  });
  const out = await fetchEarningsDates({
    tickers: ['KO', 'AAPL'], from: '2026-01-01', to: '2026-06-01', apiKey: 'x', fetchImpl: stub,
  });
  assert.deepEqual(out.KO, ['2026-02-10', '2026-05-12']);
  assert.deepEqual(out.AAPL, ['2026-02-01']);
  assert.equal(out.ZZZZ, undefined); // not in requested universe
});

test('fetchEarningsDatesPerSymbol collects per-symbol dates (sorted unique) and tracks failures', async () => {
  const stub = async (url) => {
    if (url.includes('symbol=KO')) return { ok: true, status: 200, json: async () => [
      { symbol: 'KO', date: '2026-07-28', epsActual: null },
      { symbol: 'KO', date: '2026-04-29', epsActual: 0.9 },
      { symbol: 'KO', date: '2026-07-28' }, // duplicate
    ] };
    if (url.includes('symbol=BAD')) return { ok: false, status: 402, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => [] };
  };
  const { byTicker, failed } = await fetchEarningsDatesPerSymbol({ tickers: ['KO', 'BAD'], apiKey: 'x', fetchImpl: stub });
  assert.deepEqual(byTicker.KO, ['2026-04-29', '2026-07-28']); // sorted + deduped
  assert.deepEqual(failed, ['BAD']);
});
