import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderFillsSummaryLine,
  fetchFillsSummary,
  startOfEtTradingDayIso,
} from './fills-summary.js';

const mk = (overrides = {}) => ({
  strategy: 'mean-rev-rsi2',
  count: 1,
  fills: [{ symbol: 'AAPL', side: 'buy', qty: 12, avg_price: 184.2, filled_at: '2026-05-26T14:14:00Z' }],
  ...overrides,
});

test('renderFillsSummaryLine returns empty for null / zero', () => {
  assert.equal(renderFillsSummaryLine(null, 'Coil'), '');
  assert.equal(renderFillsSummaryLine(mk({ count: 0, fills: [] }), 'Coil'), '');
});

test('renderFillsSummaryLine renders a single fill', () => {
  const line = renderFillsSummaryLine(mk(), 'Coil');
  assert.match(line, /^Coil — 1 fill today \(broker-side, no LLM beat\): BUY 12 AAPL @ \$184\.20 \(\d{2}:\d{2} ET\)$/);
});

test('renderFillsSummaryLine pluralizes and joins multiple', () => {
  const summary = mk({
    count: 2,
    fills: [
      { symbol: 'AAPL', side: 'buy', qty: 12, avg_price: 184.2, filled_at: '2026-05-26T14:14:00Z' },
      { symbol: 'NKE', side: 'sell', qty: 15, avg_price: 0, filled_at: '2026-05-26T17:40:00Z' },
    ],
  });
  const line = renderFillsSummaryLine(summary, 'Coil');
  assert.match(line, /2 fills today/);
  assert.match(line, /BUY 12 AAPL @ \$184\.20/);
  assert.match(line, /SELL 15 NKE \(\d{2}:\d{2} ET\)/); // avg_price 0 → no price
  assert.match(line, / · /);
});

test('renderFillsSummaryLine caps the list at 10 with "+N more"', () => {
  const fills = Array.from({ length: 13 }, (_, i) => ({
    symbol: `S${i}`, side: 'buy', qty: 1, avg_price: 1, filled_at: '2026-05-26T14:14:00Z',
  }));
  const line = renderFillsSummaryLine(mk({ count: 13, fills }), 'Turtle');
  assert.match(line, /13 fills today/);
  assert.match(line, /\+3 more$/);
});

test('fetchFillsSummary returns null on missing goAxios or strategy', async () => {
  assert.equal(await fetchFillsSummary(null, 'x', 'since'), null);
  assert.equal(await fetchFillsSummary({ get: async () => ({ data: {} }) }, '', 'since'), null);
});

test('fetchFillsSummary returns data on success and null on throw', async () => {
  const ok = { get: async () => ({ data: mk() }) };
  assert.deepEqual(await fetchFillsSummary(ok, 'mean-rev-rsi2', 'since'), mk());
  const bad = { get: async () => { throw new Error('boom'); } };
  assert.equal(await fetchFillsSummary(bad, 'mean-rev-rsi2', 'since'), null);
});

test('startOfEtTradingDayIso is midnight ET for the date (EDT and EST)', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const check = (utcInput, expectDate) => {
    const iso = startOfEtTradingDayIso(new Date(utcInput));
    const p = fmt.formatToParts(new Date(iso)).reduce((a, x) => ((a[x.type] = x.value), a), {});
    assert.equal(`${p.year}-${p.month}-${p.day}`, expectDate);
    assert.equal(Number(p.hour) % 24, 0, `hour should be midnight ET, got ${p.hour}`);
    assert.equal(p.minute, '00');
  };
  check('2026-05-26T18:30:00Z', '2026-05-26'); // EDT (UTC-4): 14:30 ET
  check('2026-01-15T18:30:00Z', '2026-01-15'); // EST (UTC-5): 13:30 ET
  // DST-transition days: `now` is after the 2 AM switch, so its offset differs
  // from midnight's. The boundary must still land on midnight ET, not 23:00 the
  // prior day (spring fwd) or 01:00 (fall back).
  check('2026-03-08T14:00:00Z', '2026-03-08'); // spring forward (2 AM EST→3 AM EDT)
  check('2026-11-01T15:00:00Z', '2026-11-01'); // fall back (2 AM EDT→1 AM EST)
});

test('startOfEtTradingDayIso pins the exact UTC instant across the DST seam', () => {
  // Midnight ET in UTC shifts by an hour across the transition: regression lock.
  assert.equal(startOfEtTradingDayIso(new Date('2026-03-08T14:00:00Z')), '2026-03-08T05:00:00.000Z'); // EST anchor
  assert.equal(startOfEtTradingDayIso(new Date('2026-11-01T15:00:00Z')), '2026-11-01T04:00:00.000Z'); // EDT anchor
  assert.equal(startOfEtTradingDayIso(new Date('2026-05-26T18:30:00Z')), '2026-05-26T04:00:00.000Z'); // EDT mid-season
  assert.equal(startOfEtTradingDayIso(new Date('2026-01-15T18:30:00Z')), '2026-01-15T05:00:00.000Z'); // EST mid-season
});
