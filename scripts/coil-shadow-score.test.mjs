import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScorer } from './coil-shadow-score.mjs';
import { fetchJson as previewFetchJson } from './coil-preview.mjs';

function memIo(episodes) {
  return { readEpisodes: async () => episodes, writeEpisodes: async (a) => { episodes = a; return a; }, _get: () => episodes };
}

function seriesFetch(closesByName) {
  return async (base, p) => {
    const m = p.match(/signal-series\/(\w+)/);
    if (!m) return { ok: false, status: 404, data: null };
    return { ok: true, status: 200, data: { series: closesByName[m[1]] } };
  };
}

test('scores an elapsed episode and leaves an un-elapsed one pending', async () => {
  const episodes = [
    { name: 'AMGN', openDate: '2026-07-01', entryRef: 98, tag: 'fire_early', status: 'open' },
    { name: 'VRTX', openDate: '2026-07-14', entryRef: 100, tag: 'declined', status: 'open' },
  ];
  const pt = (d, c, rsi = 20, sma5 = 100) => ({ as_of: `2026-07-${d}T20:00:00Z`, last_close: c, rsi_2: rsi, sma_5: sma5 });
  const io = memIo(episodes);
  const fetchImpl = seriesFetch({
    AMGN: [pt('01', 98), pt('02', 99), pt('03', 101, 20, 100)], // target → bounce
  });
  const r = await runScorer({ base: 'x', fetchImpl, io, nowEtDate: '2026-07-15' });
  assert.equal(r.scored, 1);
  assert.equal(r.pending, 1); // VRTX opened 2026-07-14, < 5 weekdays before 07-15
  const amgn = io._get().find((e) => e.name === 'AMGN');
  assert.equal(amgn.status, 'closed');
  assert.equal(amgn.outcome, 'bounce');
});

test('production wiring: raw fetch -> coil-preview fetchJson -> runScorer scores an elapsed episode', async () => {
  const episodes = [{ name: 'AMGN', openDate: '2026-07-01', entryRef: 98, tag: 'fire_early', status: 'open' }];
  const io = memIo(episodes);
  const rawFetch = async (url) => {
    // coil-preview fetchJson calls rawFetch(`${base}${path}`); return a Response-like with .json()
    const series = [
      { as_of: '2026-07-01T20:00:00Z', last_close: 98, rsi_2: 20, sma_5: 100 },
      { as_of: '2026-07-02T20:00:00Z', last_close: 99, rsi_2: 20, sma_5: 100 },
      { as_of: '2026-07-03T20:00:00Z', last_close: 101, rsi_2: 20, sma_5: 100 },
    ];
    return { ok: true, status: 200, json: async () => ({ series }) };
  };
  const fetchImpl = (b, p) => previewFetchJson(b, p, rawFetch);
  const r = await runScorer({ base: 'http://x', fetchImpl, io, nowEtDate: '2026-07-15' });
  assert.equal(r.scored, 1);
  assert.equal(io._get().find((e) => e.name === 'AMGN').outcome, 'bounce');
});

test('scheduler-gap episode whose window cannot reach the entry day gets a distinct auditable reason', async () => {
  const episodes = [{ name: 'ZZZ', openDate: '2026-05-01', entryRef: 100, tag: 'fire_early', status: 'open' }];
  const io = memIo(episodes);
  const fetchImpl = seriesFetch({}); // ZZZ absent → empty series → entry day not present
  const r = await runScorer({ base: 'x', fetchImpl, io, nowEtDate: '2026-07-15' });
  assert.equal(r.unscorable, 1);
  const zzz = io._get().find((e) => e.name === 'ZZZ');
  assert.equal(zzz.status, 'unscorable');
  assert.match(zzz.unscorableReason, /window exceeds endpoint reach/);
});
