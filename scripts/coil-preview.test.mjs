import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCH_RSI_MAX, WATCH_SMA5_BAND, THIN_REGIME_PCT, WATCH_MAX_NAMES, STOP_PCT,
  PROBE_PORT_LOW, PROBE_PORT_HIGH,
  computeMargins, classifyWatch, buildMirror, buildBanner,
  enrichSignal, assembleReport, renderReport, runPreview,
  resolveBase, resolveLiveBase, isLiveMeanRevBase,
} from './coil-preview.mjs';

// A non-firing, in-regime, oversold-ish signal that qualifies as WATCH.
function watchSig(over = {}) {
  return {
    ticker: 'AAPL', last_close: 99, rsi_2: 10, sma_5: 100, sma_200: 90,
    earnings_within_5d: false, entry_signal: false, ...over,
  };
}

test('computeMargins arithmetic', () => {
  const m = computeMargins({ last_close: 99, rsi_2: 10, sma_5: 100, sma_200: 90 });
  assert.equal(m.rsi2_margin, 5);                 // 10 - 5
  assert.ok(Math.abs(m.sma5_gap_pct - (-1)) < 1e-9);   // (99-100)/100*100
  assert.ok(Math.abs(m.sma200_gap_pct - (10)) < 1e-9); // (99-90)/90*100
});

test('classifyWatch accepts a near-miss', () => {
  assert.equal(classifyWatch(watchSig()), true);
});

test('classifyWatch rejects firing signals', () => {
  assert.equal(classifyWatch(watchSig({ entry_signal: true })), false);
});

test('classifyWatch rejects earnings-within-5d', () => {
  assert.equal(classifyWatch(watchSig({ earnings_within_5d: true })), false);
});

test('classifyWatch rejects out-of-regime (at/below 200-day)', () => {
  assert.equal(classifyWatch(watchSig({ last_close: 90, sma_200: 90 })), false);
});

test('classifyWatch RSI band is exclusive at the max', () => {
  assert.equal(classifyWatch(watchSig({ rsi_2: WATCH_RSI_MAX })), false);
  assert.equal(classifyWatch(watchSig({ rsi_2: WATCH_RSI_MAX - 0.01 })), true);
});

test('classifyWatch SMA5 band edge: just inside vs just outside +0.5%', () => {
  // band = sma_5 * (1 + 0.005) = 100.5; strictly less-than required
  assert.equal(classifyWatch(watchSig({ last_close: 100.5 })), false);
  assert.equal(classifyWatch(watchSig({ last_close: 100.49 })), true);
});

test('buildMirror: fill-relative stop rule + illustrative number + exit rules', () => {
  const m = buildMirror({ last_close: 100 });
  assert.equal(m.entry_ref, 100);
  assert.match(m.entry_ref_note, /provisional/i);
  assert.equal(m.illustrative_stop, 93);                 // round(100 * 0.93, 2)
  assert.match(m.stop_rule, /fill/i);
  assert.match(m.stop_rule, /0\.93/);
  assert.match(m.stop_rule, /illustrative/i);
  assert.match(m.exit_rules, /RSI\(2\)>70/);
  assert.match(m.exit_rules, /5-day SMA/);
  assert.match(m.exit_rules, /5 trading days/);
});

test('buildMirror rounds the illustrative stop to 2dp', () => {
  assert.equal(buildMirror({ last_close: 123.456 }).illustrative_stop, 114.81); // 123.456*0.93=114.81408
});

test('buildBanner: normal regime', () => {
  const b = buildBanner(false, 'halfsize');
  assert.equal(b.halt, false);
  assert.match(b.text, /Normal regime/i);
});

test('buildBanner: bear + halfsize', () => {
  const b = buildBanner(true, 'halfsize');
  assert.equal(b.halt, false);
  assert.match(b.text, /halves size/i);
});

test('buildBanner: bear + halt sets halt flag', () => {
  const b = buildBanner(true, 'halt');
  assert.equal(b.halt, true);
  assert.match(b.text, /HALT/);
});

test('buildBanner: bear + normal mode (SPY<200d but operator chose normal)', () => {
  const b = buildBanner(true, 'normal');
  assert.equal(b.halt, false);
  assert.match(b.text, /Bear regime/i);
});

test('buildBanner defaults missing mode to halfsize', () => {
  assert.match(buildBanner(true, undefined).text, /halves size/i);
});

function sig(over = {}) {
  return {
    ticker: 'XYZ', last_close: 99, rsi_2: 10, sma_5: 100, sma_200: 90,
    earnings_within_5d: false, entry_signal: false, ...over,
  };
}

test('enrichSignal attaches margins, thin_regime, and a mirror block', () => {
  const e = enrichSignal(sig({ last_close: 90.5, sma_200: 90 })); // 0.56% over 200d -> thin
  assert.equal(e.ticker, 'XYZ');
  assert.ok(e.thin_regime, 'thin regime margin should be flagged');
  assert.ok(e.mirror && e.mirror.exit_rules);
  assert.ok(typeof e.rsi2_margin === 'number');
});

test('enrichSignal: comfortable regime is not thin', () => {
  assert.equal(enrichSignal(sig({ last_close: 99, sma_200: 90 })).thin_regime, false);
});

test('assembleReport: firing from candidates, watch from signals, sorted + capped', () => {
  const candidatesResp = {
    as_of: '2026-06-04T19:45:00Z', bear_regime: false, bear_mode: 'halfsize',
    candidates: [sig({ ticker: 'AAA', rsi_2: 2, entry_signal: true })],
  };
  const signals = new Map();
  // 12 watch-qualifying names with varying rsi to test sort + cap
  for (let i = 0; i < 12; i += 1) {
    const t = `W${i}`;
    signals.set(t, sig({ ticker: t, rsi_2: 14 - i * 0.5 })); // W11 most oversold
  }
  // one non-qualifying (out of regime) name that must be excluded
  signals.set('OUT', sig({ ticker: 'OUT', last_close: 80, sma_200: 90 }));

  const r = assembleReport({
    universe: ['AAA', ...[...signals.keys()]],
    candidatesResp, signals, failed: [], now: new Date('2026-06-04T16:30:00Z'),
  });

  assert.equal(r.bot_ok, true);
  assert.equal(r.firing.length, 1);
  assert.equal(r.firing[0].ticker, 'AAA');
  assert.equal(r.watch.length, WATCH_MAX_NAMES);            // capped at 10
  assert.equal(r.watch_truncated, true);
  assert.equal(r.watch[0].ticker, 'W11');                   // most oversold first
  assert.equal(r.halt, false);
  assert.ok(!r.watch.some((w) => w.ticker === 'OUT'));      // out-of-regime excluded
});

test('assembleReport: halt regime sets halt flag', () => {
  const r = assembleReport({
    universe: ['AAA'],
    candidatesResp: { bear_regime: true, bear_mode: 'halt', candidates: [] },
    signals: new Map(), failed: [],
  });
  assert.equal(r.halt, true);
  assert.match(r.spy.banner, /HALT/);
});

test('assembleReport: incomplete counts failed names', () => {
  const r = assembleReport({
    universe: ['A', 'B', 'C'],
    candidatesResp: { bear_regime: false, bear_mode: 'halfsize', candidates: [] },
    signals: new Map(), failed: ['B', 'C'],
  });
  assert.equal(r.incomplete.failed, 2);
  assert.equal(r.incomplete.total, 3);
  assert.deepEqual(r.incomplete.names, ['B', 'C']);
});

function baseReport(over = {}) {
  return {
    as_of: '2026-06-04T19:45:00Z', preview_time_et: '12:30', preview_date_et: '2026-06-04',
    bot_ok: true, spy: { bear_regime: false, bear_mode: 'halfsize', banner: 'Normal regime — Coil sizes full.' },
    halt: false, firing: [], watch: [], watch_truncated: false,
    incomplete: { failed: 0, total: 80, names: [] }, ...over,
  };
}

test('renderReport always shows the provisional caveat header and regime', () => {
  const out = renderReport(baseReport());
  assert.match(out, /Provisional read as of 12:30 ET/);
  assert.match(out, /Normal regime/);
  assert.match(out, /FIRING/);
  assert.match(out, /WATCH/);
});

test('renderReport renders a firing name with its mirror block', () => {
  const out = renderReport(baseReport({ firing: [enrichSignal({
    ticker: 'NVDA', last_close: 100, rsi_2: 3, sma_5: 102, sma_200: 80,
    earnings_within_5d: false, entry_signal: true,
  })] }));
  assert.match(out, /NVDA/);
  assert.match(out, /0\.93/);            // stop rule wording
  assert.match(out, /RSI\(2\)>70/);      // exit rules
});

test('renderReport greys FIRING and notes HALT when halted', () => {
  const out = renderReport(baseReport({ halt: true, spy: { bear_regime: true, bear_mode: 'halt', banner: '⛔ Bear regime + HALT — Coil will place NO new entries today.' } }));
  assert.match(out, /HALTED/);
  assert.match(out, /reference only/i);
});

test('renderReport shows a loud INCOMPLETE warning', () => {
  const out = renderReport(baseReport({ incomplete: { failed: 3, total: 80, names: ['A', 'B', 'C'] } }));
  assert.match(out, /INCOMPLETE/);
  assert.match(out, /3 of 80/);
});

test('renderReport notes the WATCH cap when truncated', () => {
  const out = renderReport(baseReport({ watch_truncated: true }));
  assert.match(out, /capped at 10/);
});

// Build a stub fetch over a route table. Each value is { status, body } or a
// function (path) => { status, body }. Missing routes -> network error (throws).
function stubFetch(routes) {
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    let entry = routes[path];
    if (typeof entry === 'function') entry = entry(path);
    if (!entry) throw new Error(`no route: ${path}`);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      json: async () => entry.body,
    };
  };
}

function rawSig(t, over = {}) {
  return {
    ticker: t, last_close: 99, rsi_2: 10, sma_5: 100, sma_200: 90,
    earnings_within_5d: false, entry_signal: false, ...over,
  };
}

test('runPreview: happy path buckets firing vs watch', async () => {
  const routes = {
    '/api/v1/meanrev/universe': { status: 200, body: { count: 3, universe: ['AAA', 'BBB', 'CCC'] } },
    '/api/v1/meanrev/candidates': { status: 200, body: {
      as_of: 'x', bear_regime: false, bear_mode: 'halfsize',
      candidates: [rawSig('AAA', { rsi_2: 2, entry_signal: true })],
    } },
    '/api/v1/meanrev/signal/BBB': { status: 200, body: rawSig('BBB', { rsi_2: 8 }) },   // watch
    '/api/v1/meanrev/signal/CCC': { status: 200, body: rawSig('CCC', { rsi_2: 50, last_close: 130 }) }, // not watch
  };
  const r = await runPreview({ base: 'http://localhost:4534', fetchImpl: stubFetch(routes) });
  assert.equal(r.bot_ok, true);
  assert.deepEqual(r.firing.map((f) => f.ticker), ['AAA']);
  assert.deepEqual(r.watch.map((w) => w.ticker), ['BBB']);
  assert.equal(r.incomplete.failed, 0);
});

test('runPreview: 422 (insufficient history) is skipped, not a failure', async () => {
  const routes = {
    '/api/v1/meanrev/universe': { status: 200, body: { universe: ['AAA', 'BBB'] } },
    '/api/v1/meanrev/candidates': { status: 200, body: { bear_regime: false, bear_mode: 'halfsize', candidates: [] } },
    '/api/v1/meanrev/signal/AAA': { status: 422, body: { error: 'insufficient history' } },
    '/api/v1/meanrev/signal/BBB': { status: 200, body: rawSig('BBB', { rsi_2: 8 }) },
  };
  const r = await runPreview({ base: 'http://x', fetchImpl: stubFetch(routes) });
  assert.equal(r.incomplete.failed, 0);
  assert.deepEqual(r.watch.map((w) => w.ticker), ['BBB']);
});

test('runPreview: a per-symbol network error lands in incomplete', async () => {
  const routes = {
    '/api/v1/meanrev/universe': { status: 200, body: { universe: ['AAA', 'BBB'] } },
    '/api/v1/meanrev/candidates': { status: 200, body: { bear_regime: false, bear_mode: 'halfsize', candidates: [] } },
    '/api/v1/meanrev/signal/AAA': { status: 200, body: rawSig('AAA', { rsi_2: 8 }) },
    // BBB intentionally absent -> stub throws -> network error
  };
  const r = await runPreview({ base: 'http://x', fetchImpl: stubFetch(routes) });
  assert.equal(r.incomplete.failed, 1);
  assert.deepEqual(r.incomplete.names, ['BBB']);
});

test('runPreview: candidates failure aborts with bot_ok false', async () => {
  const routes = {
    '/api/v1/meanrev/universe': { status: 200, body: { universe: ['AAA'] } },
    '/api/v1/meanrev/candidates': { status: 500, body: { error: 'boom' } },
  };
  const r = await runPreview({ base: 'http://x', fetchImpl: stubFetch(routes) });
  assert.equal(r.bot_ok, false);
  assert.match(r.error, /candidates/);
});

test('runPreview: unreachable bot (universe throws) aborts', async () => {
  const r = await runPreview({ base: 'http://x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(r.bot_ok, false);
});

test('renderReport surfaces the thin-regime warning for a thin firing name', () => {
  const out = renderReport(baseReport({ firing: [enrichSignal({
    ticker: 'THIN', last_close: 90.4, rsi_2: 3, sma_5: 95, sma_200: 90,
    earnings_within_5d: false, entry_signal: true,
  })] }));
  assert.match(out, /THIN/);
  assert.match(out, /thin regime margin/);
});

test('renderReport shows the earnings-within-5d line when flagged', () => {
  const out = renderReport(baseReport({ firing: [enrichSignal({
    ticker: 'ERN', last_close: 95, rsi_2: 3, sma_5: 100, sma_200: 80,
    earnings_within_5d: true, entry_signal: true,
  })] }));
  assert.match(out, /earnings within 5 trading days/);
});

// --- port resolution / auto-discovery -------------------------------------
// A fetch stub that keys on the FULL url (host+port matter for probing). An
// unmatched url throws, which fetchJson turns into a { ok:false } (dead port).
function stubFetchUrls(routes) {
  return async (url) => {
    const entry = routes[url];
    if (!entry) throw new Error(`no route: ${url}`);
    return { ok: entry.status >= 200 && entry.status < 300, status: entry.status, json: async () => entry.body };
  };
}
const CAND = '/api/v1/meanrev/candidates';

test('resolveBase default port is the low end of the probe range', () => {
  assert.equal(resolveBase({}), `http://localhost:${PROBE_PORT_LOW}`);
});

test('resolveLiveBase honors TRADING_BOT_URL and never probes (program-window path)', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('must not fetch'); };
  const r = await resolveLiveBase({ env: { TRADING_BOT_URL: 'http://localhost:9999' }, fetchImpl });
  assert.equal(r.base, 'http://localhost:9999');
  assert.equal(r.probed, false);
  assert.equal(r.scanned, false);
  assert.equal(called, false, 'the probe must not run when TRADING_BOT_URL is set');
});

test('resolveLiveBase honors TRADING_BOT_PORT and never probes', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('must not fetch'); };
  const r = await resolveLiveBase({ env: { TRADING_BOT_PORT: '4600' }, fetchImpl });
  assert.equal(r.base, 'http://localhost:4600');
  assert.equal(called, false);
});

test('resolveLiveBase probes and returns the first live mean-rev port', async () => {
  const live = 'http://localhost:4537';
  const fetchImpl = stubFetchUrls({ [`${live}${CAND}`]: { status: 200, body: { bear_regime: false, candidates: [] } } });
  const r = await resolveLiveBase({ env: {}, fetchImpl });
  assert.equal(r.base, live);
  assert.equal(r.probed, true);
  assert.equal(r.scanned, true);
});

test('resolveLiveBase prefers the lowest live port when several answer', async () => {
  const fetchImpl = stubFetchUrls({
    [`http://localhost:4537${CAND}`]: { status: 200, body: { candidates: [] } },
    [`http://localhost:4539${CAND}`]: { status: 200, body: { candidates: [] } },
  });
  const r = await resolveLiveBase({ env: {}, fetchImpl });
  assert.equal(r.base, 'http://localhost:4537');
});

test('resolveLiveBase falls back to the default base when nothing is live', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const r = await resolveLiveBase({ env: {}, fetchImpl });
  assert.equal(r.base, `http://localhost:${PROBE_PORT_LOW}`);
  assert.equal(r.probed, false);
  assert.equal(r.scanned, true);
});

test('resolveLiveBase ignores a non-mean-rev port that answers without a candidates array', async () => {
  // e.g. a sandbox running another agent: /candidates returns 200 but no array.
  const fetchImpl = stubFetchUrls({
    [`http://localhost:4535${CAND}`]: { status: 200, body: { some: 'other-agent' } },
    [`http://localhost:4538${CAND}`]: { status: 200, body: { candidates: [] } },
  });
  const r = await resolveLiveBase({ env: {}, fetchImpl });
  assert.equal(r.base, 'http://localhost:4538');
});

test('isLiveMeanRevBase: valid payload true; missing array / dead port false', async () => {
  const liveFetch = stubFetchUrls({ [`http://x${CAND}`]: { status: 200, body: { candidates: [] } } });
  assert.equal(await isLiveMeanRevBase('http://x', liveFetch), true);
  const noArr = stubFetchUrls({ [`http://x${CAND}`]: { status: 200, body: { foo: 1 } } });
  assert.equal(await isLiveMeanRevBase('http://x', noArr), false);
  assert.equal(await isLiveMeanRevBase('http://x', async () => { throw new Error('refused'); }), false);
});
