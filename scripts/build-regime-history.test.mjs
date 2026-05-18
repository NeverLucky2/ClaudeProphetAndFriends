// scripts/build-regime-history.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRegime } from './build-regime-history.mjs';

test('classifyRegime: close > 50DMA AND 20d_ret > 0 -> bull-trend (full agreement)', () => {
  assert.equal(
    classifyRegime({ close: 510, sma50: 500, ret20d: 0.03, sma50_slope: 0.01 }),
    'bull-trend',
  );
});

test('classifyRegime: close < 50DMA AND 20d_ret < 0 -> bear-trend (full agreement)', () => {
  assert.equal(
    classifyRegime({ close: 480, sma50: 500, ret20d: -0.04, sma50_slope: -0.02 }),
    'bear-trend',
  );
});

test('classifyRegime: close > 50DMA, 20d_ret < 0, slope > 0 -> bull-trend (pullback in uptrend)', () => {
  assert.equal(
    classifyRegime({ close: 505, sma50: 500, ret20d: -0.01, sma50_slope: 0.015 }),
    'bull-trend',
  );
});

test('classifyRegime: close < 50DMA, 20d_ret > 0, slope < 0 -> bear-trend (bounce in downtrend)', () => {
  assert.equal(
    classifyRegime({ close: 495, sma50: 500, ret20d: 0.01, sma50_slope: -0.015 }),
    'bear-trend',
  );
});

test('classifyRegime: close > 50DMA, 20d_ret < 0, slope < 0 -> chop (genuine disagreement)', () => {
  assert.equal(
    classifyRegime({ close: 502, sma50: 500, ret20d: -0.01, sma50_slope: -0.005 }),
    'chop',
  );
});

test('classifyRegime: close < 50DMA, 20d_ret > 0, slope > 0 -> chop (genuine disagreement)', () => {
  assert.equal(
    classifyRegime({ close: 498, sma50: 500, ret20d: 0.01, sma50_slope: 0.005 }),
    'chop',
  );
});

test('classifyRegime: exactly equal values resolve to chop (no strict > satisfied)', () => {
  assert.equal(
    classifyRegime({ close: 500, sma50: 500, ret20d: 0, sma50_slope: 0 }),
    'chop',
  );
});

import { mostRecentSessionClose, isCacheFresh, CLASSIFIER_VERSION } from './build-regime-history.mjs';

test('mostRecentSessionClose: weekday before 5pm ET -> yesterday 4pm ET', () => {
  // Wed 2026-05-13 10:00 ET = 14:00Z (DST is on)
  const now = new Date('2026-05-13T14:00:00Z');
  const close = mostRecentSessionClose(now);
  // Yesterday Tuesday 2026-05-12 16:00 ET = 20:00Z
  assert.equal(close.toISOString(), '2026-05-12T20:00:00.000Z');
});

test('mostRecentSessionClose: weekday after 5pm ET -> today 4pm ET', () => {
  // Wed 2026-05-13 18:00 ET = 22:00Z
  const now = new Date('2026-05-13T22:00:00Z');
  const close = mostRecentSessionClose(now);
  assert.equal(close.toISOString(), '2026-05-13T20:00:00.000Z');
});

test('mostRecentSessionClose: Sunday -> last Friday 4pm ET', () => {
  // Sun 2026-05-17 12:00 ET = 16:00Z
  const now = new Date('2026-05-17T16:00:00Z');
  const close = mostRecentSessionClose(now);
  // Last Friday 2026-05-15 16:00 ET = 20:00Z
  assert.equal(close.toISOString(), '2026-05-15T20:00:00.000Z');
});

test('mostRecentSessionClose: day after Christmas (holiday) -> Dec 24 4pm ET', () => {
  // Sat 2026-12-26 09:00 ET = 14:00Z. Walk back: Fri Dec 25 = Christmas holiday (skip),
  // Thu Dec 24 = trading day, return its 4pm ET close.
  const now = new Date('2026-12-26T14:00:00Z');
  const close = mostRecentSessionClose(now);
  // 2026-12-24 16:00 ET = 21:00Z (standard time, UTC-5)
  assert.equal(close.toISOString(), '2026-12-24T21:00:00.000Z');
});

test('isCacheFresh: all conditions met -> true', () => {
  // Cache built at 5:30pm ET on a Friday, checking on Saturday morning
  const cache = {
    as_of: '2026-05-15T21:30:00.000Z',
    range: { from: '2026-02-01', to: '2026-05-15' },
    classifier: { version: CLASSIFIER_VERSION, rules: 'anything' },
  };
  const now = new Date('2026-05-16T14:00:00Z');
  const requested = { from: '2026-02-01', to: '2026-05-15' };
  assert.equal(isCacheFresh(cache, requested, now, false), true);
});

test('isCacheFresh: requested range exceeds cached range -> false', () => {
  const cache = {
    as_of: '2026-05-15T21:30:00.000Z',
    range: { from: '2026-04-01', to: '2026-05-15' },
    classifier: { version: CLASSIFIER_VERSION },
  };
  const now = new Date('2026-05-16T14:00:00Z');
  const requested = { from: '2026-02-01', to: '2026-05-15' };
  assert.equal(isCacheFresh(cache, requested, now, false), false);
});

test('isCacheFresh: as_of before session close + 1h -> false', () => {
  // Cache built at 10am ET Wednesday, checking at 5pm ET same day
  const cache = {
    as_of: '2026-05-13T14:00:00.000Z',
    range: { from: '2026-02-01', to: '2026-05-13' },
    classifier: { version: CLASSIFIER_VERSION },
  };
  const now = new Date('2026-05-13T21:30:00Z');  // 5:30pm ET
  const requested = { from: '2026-02-01', to: '2026-05-13' };
  assert.equal(isCacheFresh(cache, requested, now, false), false);
});

test('isCacheFresh: classifier version mismatch -> false', () => {
  const cache = {
    as_of: '2026-05-15T21:30:00.000Z',
    range: { from: '2026-02-01', to: '2026-05-15' },
    classifier: { version: 'wrong-version' },
  };
  const now = new Date('2026-05-16T14:00:00Z');
  const requested = { from: '2026-02-01', to: '2026-05-15' };
  assert.equal(isCacheFresh(cache, requested, now, false), false);
});

test('isCacheFresh: forceRebuild=true -> false even when everything else fresh', () => {
  const cache = {
    as_of: '2026-05-15T21:30:00.000Z',
    range: { from: '2026-02-01', to: '2026-05-15' },
    classifier: { version: CLASSIFIER_VERSION },
  };
  const now = new Date('2026-05-16T14:00:00Z');
  const requested = { from: '2026-02-01', to: '2026-05-15' };
  assert.equal(isCacheFresh(cache, requested, now, true), false);
});

import { deriveLabelsFromCloses } from './build-regime-history.mjs';

test('deriveLabelsFromCloses: produces a label per date in range, skipping dates that lack 50d history', () => {
  // 60 days of synthetic data: linear uptrend from 100 to 160.
  const closes = [];
  for (let i = 0; i < 60; i += 1) {
    const date = new Date(Date.UTC(2026, 1, 1 + i)); // 2026-02-01 + i days
    closes.push({ date: date.toISOString().slice(0, 10), close: 100 + i });
  }
  const labels = deriveLabelsFromCloses(closes, '2026-03-23', '2026-04-01');
  // Day 50 (2026-03-23) is the first valid classification day (needs 50d back).
  assert.ok(Object.keys(labels).length >= 9);
  for (const v of Object.values(labels)) {
    assert.equal(v, 'bull-trend', 'uptrend series should all classify as bull-trend');
  }
});

test('deriveLabelsFromCloses: throws on out-of-order input naming the bad index', () => {
  const closes = [];
  for (let i = 0; i < 60; i += 1) {
    const date = new Date(Date.UTC(2026, 1, 1 + i));
    closes.push({ date: date.toISOString().slice(0, 10), close: 100 + i });
  }
  const reversed = closes.slice().reverse();
  assert.throws(
    () => deriveLabelsFromCloses(reversed, '2026-03-23', '2026-04-01'),
    /index 1|out.?of.?order|ascending/i,
  );
});

test('deriveLabelsFromCloses: returns empty object when range falls entirely before 50d window', () => {
  const closes = [];
  for (let i = 0; i < 60; i += 1) {
    const date = new Date(Date.UTC(2026, 1, 1 + i));
    closes.push({ date: date.toISOString().slice(0, 10), close: 100 + i });
  }
  // Range entirely before day 49 (the earliest classifiable date)
  const labels = deriveLabelsFromCloses(closes, '2026-02-01', '2026-02-15');
  assert.equal(Object.keys(labels).length, 0);
});

test('fetchSpyHistorical: parses FMP /historical-price-full response', async () => {
  const { fetchSpyHistorical } = await import('./build-regime-history.mjs');
  const mockFetch = async (url) => {
    if (!url.includes('historical-price-full/SPY')) throw new Error(`unexpected url ${url}`);
    return {
      ok: true,
      json: async () => ({
        symbol: 'SPY',
        historical: [
          { date: '2026-05-15', close: 510.2 },
          { date: '2026-05-14', close: 508.1 },
          { date: '2026-05-13', close: 507.0 },
        ],
      }),
    };
  };
  const result = await fetchSpyHistorical({
    apiKey: 'dummy',
    from: '2026-05-13',
    to: '2026-05-15',
    fetchImpl: mockFetch,
  });
  // Result is sorted ascending by date.
  assert.deepEqual(result, [
    { date: '2026-05-13', close: 507.0 },
    { date: '2026-05-14', close: 508.1 },
    { date: '2026-05-15', close: 510.2 },
  ]);
});

test('fetchSpyHistorical: missing API key throws clear error', async () => {
  const { fetchSpyHistorical } = await import('./build-regime-history.mjs');
  await assert.rejects(
    fetchSpyHistorical({ apiKey: '', from: '2026-05-13', to: '2026-05-15', fetchImpl: () => {} }),
    /FMP_API_KEY/,
  );
});

test('fetchSpyHistorical: HTTP non-ok throws clear error', async () => {
  const { fetchSpyHistorical } = await import('./build-regime-history.mjs');
  const mockFetch = async () => ({ ok: false, status: 503, statusText: 'unavailable' });
  await assert.rejects(
    fetchSpyHistorical({ apiKey: 'dummy', from: '2026-05-13', to: '2026-05-15', fetchImpl: mockFetch }),
    /FMP.*503/,
  );
});

test('fetchSpyHistorical: malformed response (no historical array) throws clear error', async () => {
  const { fetchSpyHistorical } = await import('./build-regime-history.mjs');
  const mockFetch = async () => ({ ok: true, json: async () => ({ symbol: 'SPY' }) });
  await assert.rejects(
    fetchSpyHistorical({ apiKey: 'dummy', from: '2026-05-13', to: '2026-05-15', fetchImpl: mockFetch }),
    /malformed/i,
  );
});

test('fetchSpyHistorical: NaN close throws naming the bad row date', async () => {
  const { fetchSpyHistorical } = await import('./build-regime-history.mjs');
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      symbol: 'SPY',
      historical: [
        { date: '2026-05-15', close: NaN },
        { date: '2026-05-14', close: 508.1 },
      ],
    }),
  });
  await assert.rejects(
    fetchSpyHistorical({ apiKey: 'dummy', from: '2026-05-14', to: '2026-05-15', fetchImpl: mockFetch }),
    /2026-05-15/,
  );
});

test('fetchSpyHistorical: empty historical array for non-empty range throws naming the range', async () => {
  const { fetchSpyHistorical } = await import('./build-regime-history.mjs');
  const mockFetch = async () => ({ ok: true, json: async () => ({ symbol: 'SPY', historical: [] }) });
  await assert.rejects(
    fetchSpyHistorical({ apiKey: 'dummy', from: '2026-05-13', to: '2026-05-15', fetchImpl: mockFetch }),
    /2026-05-13.*2026-05-15|2026-05-15.*2026-05-13/,
  );
});

import { runBuild } from './build-regime-history.mjs';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname_t = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname_t, '__tmp_regime__');

test('runBuild: rebuilds when no cache exists, writes labels to disk', async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'data', 'reports'), { recursive: true });
  // 60 days of synthetic uptrend.
  const closes = [];
  for (let i = 0; i < 60; i += 1) {
    const date = new Date(Date.UTC(2026, 1, 1 + i));
    closes.push({ date: date.toISOString().slice(0, 10), close: 100 + i });
  }
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ symbol: 'SPY', historical: closes.slice().reverse() }),
  });
  const now = new Date('2026-05-16T14:00:00Z');
  const result = await runBuild({
    projectRoot: TMP, apiKey: 'dummy', fetchImpl: mockFetch,
    from: '2026-03-23', to: '2026-04-01', forceRebuild: false, now,
  });
  assert.equal(result.action, 'rebuilt');
  const onDisk = JSON.parse(readFileSync(join(TMP, 'data', 'reports', 'regime_history.json'), 'utf8'));
  assert.ok(Object.keys(onDisk.labels).length >= 9);
  assert.equal(onDisk.classifier.version, '2026-05-18.1');
  rmSync(TMP, { recursive: true, force: true });
});

test('runBuild: reuses cache when fresh + covers range', async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'data', 'reports'), { recursive: true });
  const fresh = {
    as_of: '2026-05-15T21:30:00.000Z',
    range: { from: '2026-02-01', to: '2026-05-15' },
    classifier: { version: '2026-05-18.1', rules: 'cached' },
    labels: { '2026-05-13': 'bull-trend' },
  };
  writeFileSync(
    join(TMP, 'data', 'reports', 'regime_history.json'),
    JSON.stringify(fresh, null, 2),
  );
  let fetchCalled = false;
  const mockFetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  const now = new Date('2026-05-16T14:00:00Z');
  const result = await runBuild({
    projectRoot: TMP, apiKey: 'dummy', fetchImpl: mockFetch,
    from: '2026-02-01', to: '2026-05-15', forceRebuild: false, now,
  });
  assert.equal(result.action, 'cache_hit');
  assert.equal(fetchCalled, false, 'must not call FMP when cache is fresh');
  rmSync(TMP, { recursive: true, force: true });
});

test('runBuild: forceRebuild=true triggers fetch even when cache fresh', async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, 'data', 'reports'), { recursive: true });
  const fresh = {
    as_of: '2026-05-15T21:30:00.000Z',
    range: { from: '2026-02-01', to: '2026-05-15' },
    classifier: { version: '2026-05-18.1' },
    labels: {},
  };
  writeFileSync(
    join(TMP, 'data', 'reports', 'regime_history.json'),
    JSON.stringify(fresh, null, 2),
  );
  let fetchCalled = false;
  const closes = [];
  for (let i = 0; i < 60; i += 1) {
    closes.push({ date: `2026-02-${String(1 + (i % 28)).padStart(2, '0')}`, close: 100 + i });
  }
  const mockFetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ symbol: 'SPY', historical: closes.slice().reverse() }) };
  };
  const now = new Date('2026-05-16T14:00:00Z');
  const result = await runBuild({
    projectRoot: TMP, apiKey: 'dummy', fetchImpl: mockFetch,
    from: '2026-02-01', to: '2026-05-15', forceRebuild: true, now,
  });
  assert.equal(result.action, 'rebuilt');
  assert.equal(fetchCalled, true);
  rmSync(TMP, { recursive: true, force: true });
});
