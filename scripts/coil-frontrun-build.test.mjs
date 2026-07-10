import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEpisodes, summarize } from './coil-frontrun-build.mjs';

const _roots = [];
async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frontrun-'));
  await fs.mkdir(path.join(root, 'data', 'bar-cache'), { recursive: true });
  _roots.push(root);
  return root;
}
after(async () => { await Promise.all(_roots.map(r => fs.rm(r, { recursive: true, force: true }))); });

// Sequential trading days starting 2021-01-04, as UTC timestamps at 05:00Z (=00:00 ET).
function isoDay(i) {
  const d = new Date(Date.UTC(2021, 0, 4 + i, 5, 0, 0));
  return d.toISOString();
}
async function writeBars(root, ticker, closes) {
  const bars = closes.map((c, i) => ({
    Timestamp: isoDay(i), Open: c, High: c * 1.01, Low: c * 0.99, Close: c, Volume: 1000,
  }));
  const file = path.join(root, 'data', 'bar-cache', `${ticker}_1Day_x.json`);
  await fs.writeFile(file, JSON.stringify({ written_at: '2026-07-09T00:00:00Z', bars }));
}
function upThenPullback(len = 260, drop = 1.2) {
  const closes = [];
  for (let i = 0; i < len - 8; i += 1) closes.push(100 + 0.2 * i);
  const peak = closes[closes.length - 1];
  for (let k = 1; k <= 8; k += 1) closes.push(peak - drop * k);
  return closes;
}

test('buildEpisodes returns [] when a ticker has too few bars', async () => {
  const root = await tmpRoot();
  await writeBars(root, 'AAA', [100, 101, 102]);
  assert.deepEqual(await buildEpisodes(root, { universe: ['AAA'] }), []);
});

test('buildEpisodes tags every episode with its ticker and a vol number', async () => {
  const root = await tmpRoot();
  const closes = upThenPullback();
  await writeBars(root, 'AAA', closes);
  await writeBars(root, 'SPY', closes);
  const eps = await buildEpisodes(root, { universe: ['AAA'] });
  assert.ok(eps.length >= 1, 'fixture must yield at least one episode');
  for (const e of eps) {
    assert.equal(e.ticker, 'AAA');
    assert.ok(Number.isFinite(e.vol), 'vol attached from the SPY series');
    assert.ok(['FIRE', 'BOUNCE', 'REGIME_EXIT', 'UNRESOLVED'].includes(e.outcome));
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Number.isFinite(e.idx), 'idx present');
    assert.ok(Number.isFinite(e.rsi2), 'rsi2 present');
    assert.ok(Number.isFinite(e.bars), 'bars present');
    assert.match(e.resolveDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('buildEpisodes sets vol=null when SPY has no bar for that date', async () => {
  const root = await tmpRoot();
  await writeBars(root, 'AAA', upThenPullback());
  // No SPY file at all.
  const eps = await buildEpisodes(root, { universe: ['AAA'] });
  assert.ok(eps.length >= 1);
  assert.equal(eps[0].vol, null);
});

test('buildEpisodes concatenates across tickers', async () => {
  const root = await tmpRoot();
  const closes = upThenPullback();
  await writeBars(root, 'AAA', closes);
  await writeBars(root, 'BBB', closes);
  await writeBars(root, 'SPY', closes);
  const eps = await buildEpisodes(root, { universe: ['AAA', 'BBB'] });
  assert.deepEqual([...new Set(eps.map(e => e.ticker))].sort(), ['AAA', 'BBB']);
});

test('summarize counts each outcome and sets resolved = fire + bounce', () => {
  const episodes = [
    { date: '2021-01-04', outcome: 'FIRE', vol: 0.2 },
    { date: '2021-01-05', outcome: 'FIRE', vol: 0.2 },
    { date: '2021-01-06', outcome: 'BOUNCE', vol: 0.2 },
    { date: '2021-01-07', outcome: 'REGIME_EXIT', vol: 0.2 },
    { date: '2021-01-08', outcome: 'UNRESOLVED', vol: 0.2 },
  ];
  const result = summarize(episodes);
  assert.equal(result.episodes, 5);
  assert.equal(result.fire, 2);
  assert.equal(result.bounce, 1);
  assert.equal(result.regime_exit, 1);
  assert.equal(result.unresolved, 1);
  assert.equal(result.resolved, 3);
});

test('summarize counts no_vol correctly', () => {
  const episodes = [
    { date: '2021-01-04', outcome: 'FIRE', vol: 0.2 },
    { date: '2021-01-05', outcome: 'FIRE', vol: null },
    { date: '2021-01-06', outcome: 'BOUNCE', vol: null },
  ];
  const result = summarize(episodes);
  assert.equal(result.no_vol, 2);
});

test('summarize computes resolved_per_full_year from FULL years only', () => {
  // First year (2021) has 2 resolved, middle year (2022) has 4 resolved, last year (2023) has 1 resolved.
  // We expect resolved_per_full_year to reflect only the middle year: 4 / 1 = 4
  const episodes = [
    { date: '2021-01-04', outcome: 'FIRE', vol: 0.2 },
    { date: '2021-06-05', outcome: 'BOUNCE', vol: 0.2 },
    { date: '2022-01-04', outcome: 'FIRE', vol: 0.2 },
    { date: '2022-02-05', outcome: 'FIRE', vol: 0.2 },
    { date: '2022-03-06', outcome: 'BOUNCE', vol: 0.2 },
    { date: '2022-04-07', outcome: 'BOUNCE', vol: 0.2 },
    { date: '2023-12-28', outcome: 'FIRE', vol: 0.2 },
  ];
  const result = summarize(episodes);
  assert.ok(result.years.length >= 3);
  assert.equal(result.resolved_per_full_year, 4);
});

test('summarize returns resolved_per_full_year === null when fewer than 3 distinct years', () => {
  const episodes = [
    { date: '2021-01-04', outcome: 'FIRE', vol: 0.2 },
    { date: '2021-06-05', outcome: 'BOUNCE', vol: 0.2 },
    { date: '2022-01-04', outcome: 'FIRE', vol: 0.2 },
  ];
  const result = summarize(episodes);
  assert.equal(result.years.length, 2);
  assert.equal(result.resolved_per_full_year, null);
});
