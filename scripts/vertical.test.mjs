import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_DTE_DAYS, DEFAULT_WIDTH,
  resolveBase, normalizeDirection, thirdFriday, defaultExpiration, ymd,
  parseArgs, fetchJson, renderCard, renderList,
  runPropose, runPlace, runList, runClose,
} from './vertical.mjs';

// ── pure helpers ───────────────────────────────────────────────────────────

test('resolveBase: TRADING_BOT_URL wins, else localhost:port', () => {
  assert.equal(resolveBase({ TRADING_BOT_URL: 'http://bot:9' }), 'http://bot:9');
  assert.equal(resolveBase({ TRADING_BOT_PORT: '5000' }), 'http://localhost:5000');
  assert.equal(resolveBase({}), 'http://localhost:4534');
});

test('normalizeDirection accepts call/put aliases', () => {
  for (const s of ['call', 'CALL', 'c', 'call_debit', 'bull']) {
    assert.equal(normalizeDirection(s), 'call_debit');
  }
  for (const s of ['put', 'PUT', 'p', 'put_debit', 'bear']) {
    assert.equal(normalizeDirection(s), 'put_debit');
  }
});

test('normalizeDirection throws on garbage', () => {
  assert.throws(() => normalizeDirection('sideways'), /direction/i);
  assert.throws(() => normalizeDirection(''), /direction/i);
});

test('thirdFriday lands on a Friday, in the third week', () => {
  const d = thirdFriday(2026, 5); // June 2026
  assert.equal(d.getUTCDay(), 5);          // Friday
  assert.ok(d.getUTCDate() >= 15 && d.getUTCDate() <= 21);
});

test('defaultExpiration returns a Friday at least MIN_DTE_DAYS out', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const exp = defaultExpiration(now);
  const d = new Date(`${exp}T00:00:00Z`);
  assert.equal(d.getUTCDay(), 5);
  assert.ok((d.getTime() - now.getTime()) >= MIN_DTE_DAYS * 86400000);
});

test('defaultExpiration rolls to next month when this month is too close', () => {
  const juneThird = thirdFriday(2026, 5);
  // "now" sitting exactly on June's third Friday → 0 DTE → must roll to July.
  assert.equal(defaultExpiration(juneThird), ymd(thirdFriday(2026, 6)));
});

test('defaultExpiration keeps this month when comfortably far out', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  assert.equal(defaultExpiration(now), ymd(thirdFriday(2026, 5)));
});

test('parseArgs splits command, positionals, and flags (space and = forms)', () => {
  const a = parseArgs(['propose', 'QQQ', 'call', '--exp', '2026-07-17', '--width=5']);
  assert.equal(a.cmd, 'propose');
  assert.deepEqual(a.positionals, ['QQQ', 'call']);
  assert.equal(a.flags.exp, '2026-07-17');
  assert.equal(a.flags.width, '5');
});

test('parseArgs aliases --expiration to exp', () => {
  const a = parseArgs(['propose', 'QQQ', 'put', '--expiration', '2026-08-21']);
  assert.equal(a.flags.exp, '2026-08-21');
});

// ── fetch plumbing (mocked) ──────────────────────────────────────────────────

// Route table stub: key "METHOD path" → { status, body }. Missing → throws (network error).
function stubFetch(routes) {
  return async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const entry = routes[`${method} ${path}`];
    if (!entry) throw new Error(`no route: ${method} ${path}`);
    return { ok: entry.status >= 200 && entry.status < 300, status: entry.status, json: async () => entry.body };
  };
}

test('fetchJson GET returns parsed body; network error is soft', async () => {
  const ok = await fetchJson('http://x', '/api/v1/options/verticals', {},
    stubFetch({ 'GET /api/v1/options/verticals': { status: 200, body: { verticals: [] } } }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, { verticals: [] });

  const down = await fetchJson('http://x', '/anything', {}, async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(down.ok, false);
  assert.equal(down.status, 0);
});

test('fetchJson POST forwards method and JSON body', async () => {
  let seen = null;
  const impl = async (url, init) => { seen = init; return { ok: true, status: 200, json: async () => ({}) }; };
  await fetchJson('http://x', '/p', { method: 'POST', body: { a: 1 } }, impl);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.body), { a: 1 });
});

// ── command runners ──────────────────────────────────────────────────────────

const SAMPLE_CARD = {
  proposal_id: 'vp-abc', underlying: 'QQQ', direction: 'call_debit',
  expiration: '2026-07-17', dte: 26, long_symbol: 'QQQ260717C00560000',
  short_symbol: 'QQQ260717C00565000', long_strike: 560, short_strike: 565,
  width: 5, net_debit: 1.85, max_loss_usd: 185, max_profit_usd: 315,
  breakeven: 561.85, long_iv: 0.182, short_iv: 0.179,
  cheapness: 'cheap: call_debit, favorable skew, IV<=RV', skew_diff: -0.003, iv_to_rv: 0.83,
};

test('runPropose happy path returns proposal id + card', async () => {
  const routes = { 'POST /api/v1/options/verticals/propose': { status: 200, body: { proposal_id: 'vp-abc', card: SAMPLE_CARD } } };
  const r = await runPropose({ base: 'http://x', underlying: 'QQQ', direction: 'call', expiration: '2026-07-17', width: 5, fetchImpl: stubFetch(routes) });
  assert.equal(r.ok, true);
  assert.equal(r.proposalId, 'vp-abc');
  assert.equal(r.card.cheapness, SAMPLE_CARD.cheapness);
});

test('runPropose surfaces the disabled-flag 403', async () => {
  const routes = { 'POST /api/v1/options/verticals/propose': { status: 403, body: { error: 'debit verticals disabled' } } };
  const r = await runPropose({ base: 'http://x', underlying: 'QQQ', direction: 'call', expiration: '2026-07-17', width: 5, fetchImpl: stubFetch(routes) });
  assert.equal(r.ok, false);
  assert.match(r.error, /disabled/i);
});

test('runPropose surfaces a 422 validation error', async () => {
  const routes = { 'POST /api/v1/options/verticals/propose': { status: 422, body: { error: 'no liquid call_debit strikes' } } };
  const r = await runPropose({ base: 'http://x', underlying: 'QQQ', direction: 'call', expiration: '2026-07-17', width: 5, fetchImpl: stubFetch(routes) });
  assert.equal(r.ok, false);
  assert.match(r.error, /no liquid/);
});

test('runPlace happy path returns vertical id', async () => {
  const routes = { 'POST /api/v1/options/verticals/place': { status: 200, body: { vertical_id: 'vert-1' } } };
  const r = await runPlace({ base: 'http://x', proposalId: 'vp-abc', fetchImpl: stubFetch(routes) });
  assert.equal(r.ok, true);
  assert.equal(r.verticalId, 'vert-1');
});

test('runPlace surfaces drift/expiry 422', async () => {
  const routes = { 'POST /api/v1/options/verticals/place': { status: 422, body: { error: 'proposal expired or not found — re-propose' } } };
  const r = await runPlace({ base: 'http://x', proposalId: 'vp-stale', fetchImpl: stubFetch(routes) });
  assert.equal(r.ok, false);
  assert.match(r.error, /re-propose/);
});

test('runList returns enriched rows', async () => {
  const rows = [{ row: { VerticalID: 'vert-1', Underlying: 'QQQ', Direction: 'call_debit', LongStrike: 560, ShortStrike: 565, Status: 'open', TotalDebit: 185, MaxGain: 315 }, value: 2.1, value_ok: true, dte: 26 }];
  const routes = { 'GET /api/v1/options/verticals': { status: 200, body: { verticals: rows } } };
  const r = await runList({ base: 'http://x', fetchImpl: stubFetch(routes) });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].row.VerticalID, 'vert-1');
});

test('runClose returns the status string', async () => {
  const routes = { 'POST /api/v1/options/verticals/close': { status: 200, body: { status: 'close requested' } } };
  const r = await runClose({ base: 'http://x', verticalId: 'vert-1', fetchImpl: stubFetch(routes) });
  assert.equal(r.ok, true);
  assert.match(r.status, /close requested/);
});

// ── rendering ────────────────────────────────────────────────────────────────

test('renderCard shows structure, economics, and the cheapness read', () => {
  const out = renderCard(SAMPLE_CARD);
  assert.match(out, /QQQ/);
  assert.match(out, /call_debit/);
  assert.match(out, /vp-abc/);                 // proposal id surfaced
  assert.match(out, /560/);                    // long strike
  assert.match(out, /565/);                    // short strike
  assert.match(out, /\$185/);                  // max loss usd
  assert.match(out, /\$315/);                  // max profit usd
  assert.match(out, /561\.85/);                // breakeven
  assert.match(out, /cheap: call_debit/);      // cheapness label verbatim
  assert.match(out, /-0\.003/);                // skew_diff
  assert.match(out, /0\.83/);                  // iv_to_rv
  assert.match(out, /place vp-abc/);           // how-to-place hint
  assert.match(out, /advisory/i);              // advisory-only framing
});

test('renderCard notes when RV is unavailable (iv_to_rv == 0)', () => {
  const out = renderCard({ ...SAMPLE_CARD, iv_to_rv: 0 });
  assert.match(out, /RV unavailable/i);
});

test('renderList: empty case is explicit', () => {
  assert.match(renderList([]), /No open verticals/i);
});

test('renderList renders a row with live value, dte, and status', () => {
  const rows = [{ row: { VerticalID: 'vert-1', Underlying: 'QQQ', Direction: 'call_debit', LongStrike: 560, ShortStrike: 565, Status: 'open', TotalDebit: 185, MaxGain: 315 }, value: 2.1, value_ok: true, dte: 26 }];
  const out = renderList(rows);
  assert.match(out, /vert-1/);
  assert.match(out, /QQQ/);
  assert.match(out, /open/);
  assert.match(out, /26/);            // dte
});

test('renderList marks a row whose live value could not be priced', () => {
  const rows = [{ row: { VerticalID: 'v2', Underlying: 'SPY', Direction: 'put_debit', LongStrike: 500, ShortStrike: 495, Status: 'open', TotalDebit: 200, MaxGain: 300 }, value: 0, value_ok: false, dte: 10 }];
  assert.match(renderList(rows), /n\/a|not priced|unpriced/i);
});

assert.equal(DEFAULT_WIDTH, 5); // documented default surfaced for the help text
