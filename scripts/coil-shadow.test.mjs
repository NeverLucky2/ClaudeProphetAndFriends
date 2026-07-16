import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDailyJob } from './coil-shadow.mjs';
import { fetchJson as previewFetchJson } from './coil-preview.mjs';

// In-memory io.
function memIo() {
  let episodes = []; const daily = new Map();
  return {
    _daily: daily,
    readEpisodes: async () => episodes,
    writeEpisodes: async (a) => { episodes = a; },
    dailyExists: async (d) => daily.has(d),
    writeDaily: async (d, o) => { daily.set(d, o); },
    listDailyDates: async () => [...daily.keys()].sort(),
  };
}

// Fake endpoint: 80-ish universe compressed to 3 names; AMGN is a WATCH candidate.
function fakeFetch(overrides = {}) {
  const sig = (t, rsi, close, sma5, sma200) => ({ ticker: t, rsi_2: rsi, last_close: close,
    sma_5: sma5, sma_200: sma200, entry_signal: false, earnings_within_5d: false,
    as_of: '2026-07-15T20:00:00Z' });
  const signals = {
    AMGN: sig('AMGN', 6, 98, 100, 90),   // WATCH candidate (below sma5, in regime)
    KO: sig('KO', 30, 100, 99, 90),      // not a pullback
    SPY: sig('SPY', 40, 500, 495, 480),  // regime healthy
    ...overrides.signals,
  };
  return async (_base, p) => {
    if (p === '/api/v1/meanrev/universe') return { ok: true, status: 200, data: { universe: ['AMGN', 'KO'] } };
    if (p === '/api/v1/meanrev/candidates') return { ok: true, status: 200, data: { candidates: [], bear_regime: overrides.bear || false, bear_mode: overrides.bearMode || 'halfsize' } };
    const m = p.match(/\/signal\/(\w+)/);
    if (m) return { ok: true, status: 200, data: signals[m[1]] };
    return { ok: false, status: 404, data: null };
  };
}

const tagger = { client: { messages: { create: async () => ({ content: [{ text: JSON.stringify({ per_name: [{ ticker: 'AMGN', fire_early: true, reason: 'x' }] }) }] }) } }, model: 'm' };

test('opens a WATCH candidate episode, tags it, writes the daily file', async () => {
  const io = memIo();
  const r = await runDailyJob({ base: 'x', fetchImpl: fakeFetch(), tagger, io, etDate: '2026-07-15' });
  assert.equal(r.opened, 1);
  const eps = await io.readEpisodes();
  assert.equal(eps[0].name, 'AMGN');
  assert.equal(eps[0].tag, 'fire_early');
  assert.ok(io._daily.has('2026-07-15'));
});

test('idempotent: second run same day is a no-op', async () => {
  const io = memIo();
  await runDailyJob({ base: 'x', fetchImpl: fakeFetch(), tagger, io, etDate: '2026-07-15' });
  const r2 = await runDailyJob({ base: 'x', fetchImpl: fakeFetch(), tagger, io, etDate: '2026-07-15' });
  assert.equal(r2.status, 'already-ran');
  assert.equal((await io.readEpisodes()).length, 1);
});

test('bear-halt day opens nothing but records the day', async () => {
  const io = memIo();
  const r = await runDailyJob({ base: 'x', fetchImpl: fakeFetch({ bear: true, bearMode: 'halt' }), tagger, io, etDate: '2026-07-16' });
  assert.equal(r.halted, true);
  assert.equal(r.opened, 0);
  assert.ok(io._daily.has('2026-07-16'));
});

test('LLM failure → candidates tagged unknown, still logged', async () => {
  const io = memIo();
  const badTagger = { client: { messages: { create: async () => { throw new Error('down'); } } }, model: 'm' };
  const r = await runDailyJob({ base: 'x', fetchImpl: fakeFetch(), tagger: badTagger, io, etDate: '2026-07-15' });
  assert.equal(r.opened, 1);
  assert.equal((await io.readEpisodes())[0].tag, 'unknown');
});

test('production wiring: raw fetch -> coil-preview fetchJson -> runDailyJob opens the candidate', async () => {
  // rawFetch mimics globalThis.fetch: one URL arg, returns a Response-like with .ok/.status/.json()
  const rawFetch = async (url) => {
    const p = String(url).replace('http://x', '');
    let data = null;
    if (p === '/api/v1/meanrev/universe') data = { universe: ['AMGN', 'KO'] };
    else if (p === '/api/v1/meanrev/candidates') data = { candidates: [], bear_regime: false, bear_mode: 'halfsize' };
    else if (p === '/api/v1/meanrev/signal/AMGN') data = { ticker: 'AMGN', rsi_2: 6, last_close: 98, sma_5: 100, sma_200: 90, entry_signal: false, earnings_within_5d: false, as_of: '2026-07-15T20:00:00Z' };
    else if (p === '/api/v1/meanrev/signal/KO') data = { ticker: 'KO', rsi_2: 30, last_close: 100, sma_5: 99, sma_200: 90, entry_signal: false, earnings_within_5d: false, as_of: '2026-07-15T20:00:00Z' };
    else if (p === '/api/v1/meanrev/signal/SPY') data = { ticker: 'SPY', rsi_2: 40, last_close: 500, sma_5: 495, sma_200: 480, entry_signal: false, earnings_within_5d: false, as_of: '2026-07-15T20:00:00Z' };
    return { ok: data !== null, status: data !== null ? 200 : 404, json: async () => data };
  };
  const fetchImpl = (b, p) => previewFetchJson(b, p, rawFetch);
  const io = memIo();
  const r = await runDailyJob({ base: 'http://x', fetchImpl, tagger, io, etDate: '2026-07-15' });
  assert.equal(r.opened, 1); // AMGN opens; proves base+path are concatenated correctly through the real fetchJson
});
