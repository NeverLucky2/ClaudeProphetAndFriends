// scripts/rank-floor-movers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFloorFile } from './rank-floor-movers.mjs';

test('parseFloorFile: strips # comments and blank lines, returns tickers', () => {
  const text = [
    '# Prophet tradable universe',
    '',
    '# Index ETFs',
    'SPY',
    'QQQ',
    '   ',
    'NVDA   ', // trailing whitespace
    '# Crypto',
    'MSTR',
  ].join('\n');
  assert.deepEqual(parseFloorFile(text), ['SPY', 'QQQ', 'NVDA', 'MSTR']);
});

test('parseFloorFile: dedupes and uppercases', () => {
  assert.deepEqual(parseFloorFile('spy\nSPY\nqqq\n'), ['SPY', 'QQQ']);
});

import { computeMovePct } from './rank-floor-movers.mjs';

test('computeMovePct: uses target date close vs prior trading-day close', () => {
  const rows = [
    { date: '2026-05-11', close: 100 },
    { date: '2026-05-12', close: 102 },
    { date: '2026-05-13', close: 108 }, // target
  ];
  // 108/102 - 1 = +5.882...%
  assert.ok(Math.abs(computeMovePct(rows, '2026-05-13') - 5.8824) < 0.001);
});

test('computeMovePct: target on a gap day uses last close <= target', () => {
  const rows = [
    { date: '2026-05-12', close: 102 },
    { date: '2026-05-13', close: 108 },
  ];
  // target 2026-05-14 (holiday/no row) -> last <= is 05-13; prior 05-12; 108/102-1
  assert.ok(Math.abs(computeMovePct(rows, '2026-05-14') - 5.8824) < 0.001);
});

test('computeMovePct: fewer than 2 usable rows -> null', () => {
  assert.equal(computeMovePct([{ date: '2026-05-13', close: 108 }], '2026-05-13'), null);
  assert.equal(computeMovePct([], '2026-05-13'), null);
});

import { fetchDailyMove } from './rank-floor-movers.mjs';

test('fetchDailyMove: parses historical-price-full and returns {symbol, move_pct}', async () => {
  const mockFetch = async (url) => {
    assert.ok(url.includes('historical-price-full/NVDA'), `url was ${url}`);
    return {
      ok: true,
      json: async () => ({
        symbol: 'NVDA',
        historical: [
          { date: '2026-05-13', close: 108 },
          { date: '2026-05-12', close: 102 }, // FMP returns descending
        ],
      }),
    };
  };
  const r = await fetchDailyMove({ symbol: 'NVDA', date: '2026-05-13', apiKey: 'k', fetchImpl: mockFetch });
  assert.equal(r.symbol, 'NVDA');
  assert.ok(Math.abs(r.move_pct - 5.8824) < 0.001);
});

test('fetchDailyMove: HTTP error -> null (soft-fail, no throw)', async () => {
  const mockFetch = async () => ({ ok: false, status: 503 });
  assert.equal(await fetchDailyMove({ symbol: 'X', date: '2026-05-13', apiKey: 'k', fetchImpl: mockFetch }), null);
});

test('fetchDailyMove: empty/malformed historical -> null', async () => {
  const mockFetch = async () => ({ ok: true, json: async () => ({ symbol: 'X' }) });
  assert.equal(await fetchDailyMove({ symbol: 'X', date: '2026-05-13', apiKey: 'k', fetchImpl: mockFetch }), null);
});

test('fetchDailyMove: thrown fetch (network) -> null', async () => {
  const mockFetch = async () => { throw new Error('ECONNRESET'); };
  assert.equal(await fetchDailyMove({ symbol: 'X', date: '2026-05-13', apiKey: 'k', fetchImpl: mockFetch }), null);
});

import { fetchOffFloorMovers } from './rank-floor-movers.mjs';

test('fetchOffFloorMovers: excludes floor names, applies price floor, ranks by abs change, top N', async () => {
  const mockFetch = async (url) => {
    const list = url.includes('/gainers')
      ? [
          { symbol: 'SMCI', changesPercentage: 14.1, price: 42 },
          { symbol: 'NVDA', changesPercentage: 6.2, price: 1200 }, // on floor -> excluded
          { symbol: 'PENNY', changesPercentage: 30.0, price: 3 },  // price < 20 -> excluded
        ]
      : [ { symbol: 'XYZ', changesPercentage: -11.0, price: 55 } ]; // losers
    return { ok: true, json: async () => list };
  };
  const floorSet = new Set(['NVDA', 'SPY']);
  const r = await fetchOffFloorMovers({ floorSet, apiKey: 'k', fetchImpl: mockFetch, minPrice: 20, topN: 10 });
  assert.deepEqual(r, [
    { symbol: 'SMCI', move_pct: 14.1 },
    { symbol: 'XYZ', move_pct: -11.0 },
  ]);
});

test('fetchOffFloorMovers: any fetch failure -> [] (passive log, never blocks)', async () => {
  const mockFetch = async () => { throw new Error('boom'); };
  assert.deepEqual(await fetchOffFloorMovers({ floorSet: new Set(), apiKey: 'k', fetchImpl: mockFetch }), []);
});

test('fetchOffFloorMovers: unknown price fails the liquidity screen (excluded)', async () => {
  const mockFetch = async (url) => ({
    ok: true,
    json: async () => (url.includes('/gainers')
      ? [{ symbol: 'NOPRICE', changesPercentage: 20.0 /* price field absent */ }]
      : []),
  });
  assert.deepEqual(await fetchOffFloorMovers({ floorSet: new Set(), apiKey: 'k', fetchImpl: mockFetch }), []);
});

test('fetchOffFloorMovers: one endpoint throws, the other still contributes (per-endpoint soft-fail)', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/losers')) throw new Error('timeout');
    return { ok: true, json: async () => [{ symbol: 'SMCI', changesPercentage: 14.1, price: 42 }] };
  };
  assert.deepEqual(
    await fetchOffFloorMovers({ floorSet: new Set(), apiKey: 'k', fetchImpl: mockFetch }),
    [{ symbol: 'SMCI', move_pct: 14.1 }],
  );
});

import { rankFloorMovers } from './rank-floor-movers.mjs';

test('rankFloorMovers: ranks by abs(move) desc, collects nulls into missing[]', async () => {
  const floor = ['SPY', 'NVDA', 'ORCL'];
  const moves = { SPY: 1.2, NVDA: -6.2 /* ORCL -> null (missing) */ };
  const fakeFetchDailyMove = async ({ symbol }) =>
    symbol in moves ? { symbol, move_pct: moves[symbol] } : null;
  const fakeOffFloor = async () => [{ symbol: 'SMCI', move_pct: 14.1 }];
  const r = await rankFloorMovers({
    floor, date: '2026-05-13', apiKey: 'k',
    fetchDailyMoveImpl: fakeFetchDailyMove, fetchOffFloorImpl: fakeOffFloor,
  });
  assert.equal(r.date, '2026-05-13');
  assert.equal(r.floor_size, 3);
  assert.deepEqual(r.movers_ranked.map((m) => m.symbol), ['NVDA', 'SPY']); // |6.2| > |1.2|
  assert.deepEqual(r.missing, ['ORCL']);
  assert.deepEqual(r.off_floor_forbidden_winners, [{ symbol: 'SMCI', move_pct: 14.1 }]);
});
