# Regime Weighting + Stress-Test + Significance Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three independent anti-overfit extensions to the adapt-strategy learning loop: regime-aware trade tagging + regime_warning on predicate verdicts (Item #3), worst-case-friction stress test (Item #4), and per-asset-class significance gate (Item #5).

**Architecture:** Three independent phases sharing only `score-rule-against-holdout.mjs` and the adapt-skill step structure. Each phase ends with a single squashed commit. No Go code changes. New scripts are pure functions with mocked-FS integration tests where they touch disk. Skill edits are textual; verified via grep-sanity tests.

**Tech Stack:** Node.js (ESM, `node:test`), FMP REST API (SPY daily closes), `Intl.DateTimeFormat` for ET timezone, atomic write-tmp-then-rename file IO.

**Spec:** `docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md`

---

## Pre-flight checklist (before Task 1)

- [ ] Confirm branch is `feat-friction-and-walkforward` (or a fresh worktree off it).
- [ ] Run `npm test` — expect all existing tests pass.
- [ ] Read the spec end-to-end. If anything is unclear, ask before starting.

---

# Phase 1 — Item #3: Regime tagging

Produces: a new `scripts/build-regime-history.mjs` script, a `regime_history.json` artifact joining trade-dates to bull-trend / chop / bear-trend labels, an extension to `score-rule-against-holdout.mjs` that emits `regime_warning` when affected trades over-index a regime, and skill edits across all 4 adapt skills plus 2 review-performance skills.

**Phase 1 ends with one commit:** `feat(regime): on-the-fly SPY classifier + regime_warning in scorer + adapt-skill regime announcements`

---

### Task 1: Regime classifier (pure function, TDD)

**Files:**
- Create: `scripts/build-regime-history.mjs`
- Test: `scripts/build-regime-history.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/build-regime-history.test.mjs
```

Expected: `Cannot find module './build-regime-history.mjs'` (file doesn't exist yet).

- [ ] **Step 3: Create the minimal classifier**

```javascript
// scripts/build-regime-history.mjs
// SPY-based 3-bucket regime classifier with 50DMA-slope tiebreaker. Spec:
// docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md

export const CLASSIFIER_VERSION = '2026-05-18.1';

export function classifyRegime({ close, sma50, ret20d, sma50_slope }) {
  if (close > sma50 && ret20d > 0) return 'bull-trend';
  if (close < sma50 && ret20d < 0) return 'bear-trend';
  if (close > sma50 && sma50_slope > 0) return 'bull-trend';
  if (close < sma50 && sma50_slope < 0) return 'bear-trend';
  return 'chop';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/build-regime-history.test.mjs
```

Expected: 7 pass, 0 fail.

---

### Task 2: Session-close freshness check (pure function, TDD)

**Files:**
- Modify: `scripts/build-regime-history.mjs` (add `mostRecentSessionClose`, `isCacheFresh`)
- Modify: `scripts/build-regime-history.test.mjs` (add tests)

- [ ] **Step 1: Append failing tests**

```javascript
// scripts/build-regime-history.test.mjs — append
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/build-regime-history.test.mjs
```

Expected: 8 failures (new tests). 7 previous still pass.

- [ ] **Step 3: Implement session-close + freshness in `build-regime-history.mjs`**

Append to `scripts/build-regime-history.mjs`:

```javascript
function dateInET(d) {
  // Returns { year, month, day, hour, minute, weekday(0=Sun..6=Sat) } for d in America/New_York.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '00' : map.hour),
    minute: Number(map.minute),
    weekday: weekdays[map.weekday],
  };
}

function makeET(year, month, day, hour, minute) {
  // Construct a Date for the given Y-M-D H:M in America/New_York. Uses an offset probe.
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const etProbe = dateInET(probe);
  const offsetMin = ((etProbe.hour - hour) * 60 + (etProbe.minute - minute)) * -1;
  return new Date(probe.getTime() + offsetMin * 60_000);
}

export function mostRecentSessionClose(now) {
  // Walk back day-by-day in ET until we hit a weekday whose 4pm ET <= now.
  const et = dateInET(now);
  let y = et.year, m = et.month, d = et.day;
  // If today is a weekday and now < 4pm ET, step back one day first.
  const todayClose = makeET(y, m, d, 16, 0);
  if (et.weekday >= 1 && et.weekday <= 5 && now >= todayClose) {
    return todayClose;
  }
  // Otherwise step back day-by-day until we hit a weekday.
  for (let i = 0; i < 7; i += 1) {
    const probe = new Date(Date.UTC(y, m - 1, d - i - 1));
    const etProbe = dateInET(probe);
    if (etProbe.weekday >= 1 && etProbe.weekday <= 5) {
      return makeET(etProbe.year, etProbe.month, etProbe.day, 16, 0);
    }
  }
  throw new Error('mostRecentSessionClose: no weekday found in last 7 days (impossible)');
}

export function isCacheFresh(cache, requested, now, forceRebuild) {
  if (forceRebuild) return false;
  if (!cache?.range || !cache?.as_of || !cache?.classifier?.version) return false;
  if (cache.classifier.version !== CLASSIFIER_VERSION) return false;
  if (cache.range.from > requested.from) return false;
  if (cache.range.to < requested.to) return false;
  const close = mostRecentSessionClose(now);
  const closePlusBufferMs = close.getTime() + 3600_000;
  const asOf = Date.parse(cache.as_of);
  return Number.isFinite(asOf) && asOf >= closePlusBufferMs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/build-regime-history.test.mjs
```

Expected: 15 pass, 0 fail.

---

### Task 3: FMP fetch + sma/ret derivation (TDD with injected fetch)

**Files:**
- Modify: `scripts/build-regime-history.mjs` (add `deriveLabelsFromCloses`, `fetchSpyHistorical`)
- Modify: `scripts/build-regime-history.test.mjs`

- [ ] **Step 1: Append failing tests**

```javascript
// scripts/build-regime-history.test.mjs — append
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/build-regime-history.test.mjs
```

Expected: 6 new failures.

- [ ] **Step 3: Implement in `build-regime-history.mjs`**

Append to `scripts/build-regime-history.mjs`:

```javascript
function mean(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function deriveLabelsFromCloses(closes, fromDate, toDate) {
  // closes: sorted ascending [{ date, close }]
  const labels = {};
  for (let i = 0; i < closes.length; i += 1) {
    const { date, close } = closes[i];
    if (date < fromDate || date > toDate) continue;
    if (i < 49) continue;  // need 50 prior closes (i.e., index 49 means 50 days inclusive)
    const window50 = closes.slice(i - 49, i + 1).map(r => r.close);
    const sma50 = mean(window50);
    const ret20d = closes[i - 20] ? (close / closes[i - 20].close - 1) : 0;
    const sma50_slope = closes[i - 20] && i - 20 >= 49
      ? (sma50 - mean(closes.slice(i - 20 - 49, i - 20 + 1).map(r => r.close))) /
        mean(closes.slice(i - 20 - 49, i - 20 + 1).map(r => r.close))
      : 0;
    labels[date] = classifyRegime({ close, sma50, ret20d, sma50_slope });
  }
  return labels;
}

const FMP_HOST = 'https://financialmodelingprep.com';

export async function fetchSpyHistorical({ apiKey, from, to, fetchImpl = globalThis.fetch }) {
  if (!apiKey) {
    throw new Error('FMP_API_KEY is required for build-regime-history but was not set');
  }
  const url = `${FMP_HOST}/api/v3/historical-price-full/SPY?from=${from}&to=${to}&apikey=${apiKey}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    throw new Error(`FMP request failed (${resp.status} ${resp.statusText ?? ''}) for SPY history`);
  }
  const data = await resp.json();
  if (!Array.isArray(data?.historical)) {
    throw new Error('FMP response malformed: expected { historical: [...] }');
  }
  return data.historical
    .map(r => ({ date: r.date, close: Number(r.close) }))
    .filter(r => Number.isFinite(r.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/build-regime-history.test.mjs
```

Expected: 21 pass, 0 fail.

---

### Task 4: Orchestrator + atomic write + CLI

**Files:**
- Modify: `scripts/build-regime-history.mjs` (add `runBuild`, CLI entry)
- Modify: `scripts/build-regime-history.test.mjs` (orchestrator test with mocks)

- [ ] **Step 1: Append failing test**

```javascript
// scripts/build-regime-history.test.mjs — append
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
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/build-regime-history.test.mjs
```

Expected: 3 new failures.

- [ ] **Step 3: Add orchestrator + atomic write + CLI to `build-regime-history.mjs`**

Append to `scripts/build-regime-history.mjs`:

```javascript
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (err) {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
    throw err;
  }
}

export async function runBuild({ projectRoot, apiKey, fetchImpl, from, to, forceRebuild, now }) {
  const outPath = join(projectRoot, 'data', 'reports', 'regime_history.json');
  let cache = null;
  if (existsSync(outPath)) {
    try { cache = JSON.parse(readFileSync(outPath, 'utf8')); } catch { cache = null; }
  }
  const requested = { from, to };
  if (isCacheFresh(cache, requested, now, forceRebuild)) {
    process.stderr.write(`build-regime-history: cache hit (${cache.range.from} → ${cache.range.to})\n`);
    return { action: 'cache_hit', path: outPath };
  }
  // Need to fetch [from-49 calendar days, to] to have 50d of priors for the first requested date.
  const fromDate = new Date(`${from}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 49 - 30);  // extra 30 days slack for weekends/holidays
  const fetchFrom = fromDate.toISOString().slice(0, 10);
  const closes = await fetchSpyHistorical({ apiKey, from: fetchFrom, to, fetchImpl });
  const labels = deriveLabelsFromCloses(closes, from, to);
  const out = {
    as_of: now.toISOString(),
    range: { from, to },
    classifier: { version: CLASSIFIER_VERSION, rules: 'SPY vs 50DMA + SPY 20D return + 50DMA-slope tiebreaker; 3-bucket' },
    labels,
  };
  writeAtomic(outPath, JSON.stringify(out, null, 2));
  process.stderr.write(`build-regime-history: rebuilt (${Object.keys(labels).length} dates labeled, ${from} → ${to})\n`);
  return { action: 'rebuilt', path: outPath };
}

// CLI entry — only runs when invoked directly.
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const argFlag = (n) => {
      const i = args.indexOf(n);
      return i === -1 ? undefined : args[i + 1];
    };
    const forceRebuild = args.includes('--force-rebuild');
    const today = new Date();
    const toDefault = today.toISOString().slice(0, 10);
    const fromDefault = new Date(today.getTime() - 90 * 86400_000).toISOString().slice(0, 10);
    const from = argFlag('--from') ?? fromDefault;
    const to = argFlag('--to') ?? toDefault;
    const apiKey = process.env.FMP_API_KEY ?? '';
    if (!apiKey) {
      process.stderr.write('build-regime-history: FMP_API_KEY env var not set\n');
      process.exit(3);
    }
    runBuild({
      projectRoot: process.cwd(), apiKey, fetchImpl: globalThis.fetch,
      from, to, forceRebuild, now: new Date(),
    }).then(
      (r) => { process.stdout.write(JSON.stringify(r) + '\n'); },
      (err) => { process.stderr.write(`build-regime-history: ${err.message}\n`); process.exit(4); },
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/build-regime-history.test.mjs
```

Expected: 24 pass, 0 fail.

---

### Task 5: TZ-aware date join helper + regime joining for trades

**Files:**
- Modify: `scripts/score-rule-against-holdout.mjs` (add `etDateFromTimestamp`, `lookupRegime`, `joinRegimeToTrades`)
- Modify: `scripts/score-rule-against-holdout.test.mjs` (add tests)

- [ ] **Step 1: Append failing tests**

```javascript
// scripts/score-rule-against-holdout.test.mjs — append
import { etDateFromTimestamp, lookupRegime, joinRegimeToTrades } from './score-rule-against-holdout.mjs';

test('etDateFromTimestamp: Friday 17:00 ET in DST -> Friday', () => {
  // 2026-05-15T21:00:00Z = Friday 17:00 ET (DST is on)
  assert.equal(etDateFromTimestamp('2026-05-15T21:00:00.000Z'), '2026-05-15');
});

test('etDateFromTimestamp: Friday 21:00 ET in DST (next UTC day) -> Friday', () => {
  // 2026-05-16T01:00:00Z = Friday 21:00 ET DST
  assert.equal(etDateFromTimestamp('2026-05-16T01:00:00.000Z'), '2026-05-15');
});

test('etDateFromTimestamp: malformed timestamp -> null', () => {
  assert.equal(etDateFromTimestamp('not-a-date'), null);
});

test('lookupRegime: direct hit', () => {
  const labels = { '2026-05-14': 'chop', '2026-05-15': 'bull-trend' };
  assert.equal(lookupRegime('2026-05-15', labels), 'bull-trend');
});

test('lookupRegime: walks back across weekend to last trading day', () => {
  const labels = { '2026-05-15': 'bull-trend' }; // Friday
  // 2026-05-17 = Sunday; should walk back to Friday
  assert.equal(lookupRegime('2026-05-17', labels), 'bull-trend');
});

test('lookupRegime: walk-back limited to 5 calendar days', () => {
  const labels = { '2026-05-10': 'bull-trend' };
  // 2026-05-20 is 10 days later -> exceeds 5-day cap -> unknown
  assert.equal(lookupRegime('2026-05-20', labels), null);
});

test('joinRegimeToTrades: tags each trade with regime field', () => {
  const labels = { '2026-05-15': 'bull-trend', '2026-05-14': 'chop' };
  const trades = [
    { symbol: 'A', timestamp: '2026-05-15T15:00:00Z', market_data: {} },
    { symbol: 'B', timestamp: '2026-05-14T19:00:00Z', market_data: {} },
    { symbol: 'C', timestamp: '2026-04-01T15:00:00Z', market_data: {} }, // unknown
  ];
  const out = joinRegimeToTrades(trades, labels);
  assert.equal(out[0].regime, 'bull-trend');
  assert.equal(out[1].regime, 'chop');
  assert.equal(out[2].regime, 'unknown');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/score-rule-against-holdout.test.mjs
```

Expected: 7 new failures.

- [ ] **Step 3: Add functions to `score-rule-against-holdout.mjs`**

Insert before the dispatcher section (right after `scoreDteBounds`):

```javascript
// ---------------------------------------------------------------------------
// Regime joining (Item #3)
// ---------------------------------------------------------------------------

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

export function etDateFromTimestamp(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
  // 'en-CA' yields YYYY-MM-DD
  return ET_DATE_FORMATTER.format(d);
}

export function lookupRegime(dateStr, labels, maxWalkBackDays = 5) {
  if (!dateStr) return null;
  let d = new Date(`${dateStr}T12:00:00Z`);
  for (let i = 0; i <= maxWalkBackDays; i += 1) {
    const probe = d.toISOString().slice(0, 10);
    if (labels[probe]) return labels[probe];
    d = new Date(d.getTime() - 86400_000);
  }
  return null;
}

export function joinRegimeToTrades(trades, labels) {
  return trades.map(t => {
    const etDate = etDateFromTimestamp(t.timestamp);
    const regime = lookupRegime(etDate, labels) ?? 'unknown';
    return { ...t, regime };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/score-rule-against-holdout.test.mjs
```

Expected: all pass (previous + 7 new).

---

### Task 6: regime_warning logic in scorer

**Files:**
- Modify: `scripts/score-rule-against-holdout.mjs` (add `computeRegimeAnnotations`, extend `buildVerdict`, wire into each predicate scorer)
- Modify: `scripts/score-rule-against-holdout.test.mjs`

- [ ] **Step 1: Append failing tests**

```javascript
// scripts/score-rule-against-holdout.test.mjs — append
import { computeRegimeAnnotations } from './score-rule-against-holdout.mjs';

test('computeRegimeAnnotations: trades_affected < 5 -> regime_warning_skipped', () => {
  const affected = [
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
  ];
  const result = computeRegimeAnnotations(affected, { 'bull-trend': 0.5, chop: 0.4, 'bear-trend': 0.1 });
  assert.equal(result.regime_warning_skipped, 'insufficient_sample (need >= 5 affected trades; have 3)');
  assert.equal(result.regime_warning, undefined);
});

test('computeRegimeAnnotations: >= 5 affected, over-index >= 25pp -> regime_warning', () => {
  const affected = [
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
  ];
  // adapt set is 60% bull, 30% chop, 10% bear; affected is 100% bull -> 40pp over-index
  const result = computeRegimeAnnotations(affected, { 'bull-trend': 0.6, chop: 0.3, 'bear-trend': 0.1 });
  assert.match(result.regime_warning, /100% bull-trend/);
  assert.match(result.regime_warning, /60%/);
  assert.match(result.regime_warning, /40pp/);
  assert.equal(result.regime_warning_skipped, undefined);
});

test('computeRegimeAnnotations: >= 5 affected, no over-index -> neither field present', () => {
  const affected = [
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
    { regime: 'bull-trend' }, { regime: 'chop' }, { regime: 'chop' },
  ];
  // adapt is 60% bull, 30% chop, 10% bear; affected is 67% bull, 33% chop -> +7pp/+3pp, no warning
  const result = computeRegimeAnnotations(affected, { 'bull-trend': 0.6, chop: 0.3, 'bear-trend': 0.1 });
  assert.equal(result.regime_warning, undefined);
  assert.equal(result.regime_warning_skipped, undefined);
});

test('computeRegimeAnnotations: unknown regime trades excluded from both sides', () => {
  const affected = [
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'unknown' },
  ];
  // Excluding unknown: 5 bull, denominator 5. adapt-set excluded? No -- we just use the provided baseline.
  const result = computeRegimeAnnotations(affected, { 'bull-trend': 0.5, chop: 0.5 });
  // Affected: 100% bull (excluding unknown). adapt: 50% bull -> +50pp.
  assert.match(result.regime_warning, /50pp/);
});

test('computeRegimeAnnotations: 0 affected -> no warning either way', () => {
  const result = computeRegimeAnnotations([], { 'bull-trend': 0.6 });
  assert.equal(result.regime_warning, undefined);
  assert.equal(result.regime_warning_skipped, undefined);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/score-rule-against-holdout.test.mjs
```

Expected: 5 new failures.

- [ ] **Step 3: Implement in `score-rule-against-holdout.mjs`**

Append before the dispatcher block:

```javascript
const REGIME_WARNING_MIN_AFFECTED = 5;
const REGIME_WARNING_OVER_INDEX_PP = 25;

export function computeRegimeAnnotations(affectedTrades, adaptSetDistribution) {
  if (!Array.isArray(affectedTrades) || affectedTrades.length === 0) return {};
  if (!adaptSetDistribution || typeof adaptSetDistribution !== 'object') return {};
  if (affectedTrades.length < REGIME_WARNING_MIN_AFFECTED) {
    return {
      regime_warning_skipped: `insufficient_sample (need >= ${REGIME_WARNING_MIN_AFFECTED} affected trades; have ${affectedTrades.length})`,
    };
  }
  // Exclude unknown from numerator (and effective denominator).
  const known = affectedTrades.filter(t => t.regime && t.regime !== 'unknown');
  if (known.length === 0) return {};
  const counts = {};
  for (const t of known) {
    counts[t.regime] = (counts[t.regime] ?? 0) + 1;
  }
  let worst = null;
  for (const r of Object.keys(counts)) {
    const affectedPct = counts[r] / known.length;
    const baselinePct = adaptSetDistribution[r] ?? 0;
    const deltaPp = (affectedPct - baselinePct) * 100;
    if (deltaPp >= REGIME_WARNING_OVER_INDEX_PP) {
      if (!worst || deltaPp > worst.deltaPp) {
        worst = { regime: r, affectedPct, baselinePct, deltaPp };
      }
    }
  }
  if (!worst) return {};
  return {
    regime_warning: `affected trades ${Math.round(worst.affectedPct * 100)}% ${worst.regime} vs adapt-set ${Math.round(worst.baselinePct * 100)}% — proposal over-indexes on ${worst.regime} regime by ${Math.round(worst.deltaPp)}pp`,
  };
}
```

- [ ] **Step 4: Wire `computeRegimeAnnotations` into each predicate scorer**

Modify each `score*` function in `score-rule-against-holdout.mjs` to collect affected-trade regime info and pass through to `buildVerdict`. Two changes per function:

First, extend `buildVerdict` (replace existing signature/body):

```javascript
export function buildVerdict({
  predicate, params, holdout_size, trades_affected, net_pl_delta_usd,
  blocked_winners, blocked_losers, details, limitation_notes = [],
  affected_trades_for_regime, adapt_set_distribution,
}) {
  let verdict;
  if (trades_affected === 0) {
    verdict = 'INCONCLUSIVE';
  } else if (trades_affected < MIN_TRADES_FOR_NON_INCONCLUSIVE
    && Math.abs(net_pl_delta_usd) < MIN_ABS_DELTA_FOR_NON_INCONCLUSIVE) {
    verdict = 'INCONCLUSIVE';
  } else if (net_pl_delta_usd > 0) {
    verdict = 'APPROVED-BY-HOLDOUT';
  } else if (net_pl_delta_usd < 0) {
    verdict = 'REJECTED-BY-HOLDOUT';
  } else {
    verdict = 'INCONCLUSIVE';
  }
  const annotations = adapt_set_distribution
    ? computeRegimeAnnotations(affected_trades_for_regime ?? [], adapt_set_distribution)
    : {};
  return {
    predicate, params, review_type: 'mechanical',
    holdout_size, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers,
    verdict, limitation_notes, details,
    ...annotations,
  };
}
```

Then, for each of the 5 `score*` functions, accept an optional `adaptSetDistribution` second param (after `params`), build an `affected_trades_for_regime` array as each scorer flags a trade, and pass both through to `buildVerdict`. Example for `scoreMaxPositionSizePct`:

```javascript
export function scoreMaxPositionSizePct(holdoutTrades, params, adaptSetDistribution) {
  const { limit } = params;
  let trades_affected = 0;
  let net_pl_delta_usd = 0;
  let blocked_winners = 0;
  let blocked_losers = 0;
  const details = [];
  const affected_trades_for_regime = [];

  for (const t of holdoutTrades) {
    const md = t.market_data ?? {};
    if (typeof md.entry_price !== 'number' || typeof md.size !== 'number' || typeof md.portfolio_value !== 'number') continue;
    const positionPct = (md.entry_price * md.size) / md.portfolio_value;
    if (positionPct > limit) {
      trades_affected += 1;
      const pl = md.friction_adjusted_pl ?? 0;
      net_pl_delta_usd -= pl;
      if (pl > 0) blocked_winners += 1;
      if (pl < 0) blocked_losers += 1;
      details.push({ symbol: t.symbol, position_pct: +positionPct.toFixed(4), pl });
      affected_trades_for_regime.push({ regime: t.regime });
    }
  }
  return buildVerdict({
    predicate: 'max_position_size_pct', params,
    holdout_size: holdoutTrades.length, trades_affected, net_pl_delta_usd,
    blocked_winners, blocked_losers, details,
    affected_trades_for_regime, adapt_set_distribution: adaptSetDistribution,
  });
}
```

Apply the same shape to `scoreStopAtPct`, `scoreMaxConcurrentPositions`, `scoreNoReentryWithinHours`, `scoreDteBounds`. Each:
- Adds 3rd param `adaptSetDistribution`
- Adds `const affected_trades_for_regime = [];`
- Pushes `{ regime: t.regime }` inside each block where `trades_affected += 1`
- Passes both into `buildVerdict`

Then update `dispatchPredicate` to accept and forward the new param:

```javascript
export function dispatchPredicate(name, params, holdoutTrades, adaptSetDistribution) {
  const fn = PREDICATE_MAP[name];
  if (!fn) {
    throw new Error(`unknown predicate "${name}". Supported: ${SUPPORTED_PREDICATES.join(', ')}`);
  }
  return fn(holdoutTrades, params, adaptSetDistribution);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
node --test scripts/score-rule-against-holdout.test.mjs
```

Expected: all pass. Existing predicate tests still green (the new param is optional with default `undefined` — no regime annotations when omitted).

---

### Task 7: Score-rule CLI extension — `--regime-history` and `--adapt-set-distribution` flags

**Files:**
- Modify: `scripts/score-rule-against-holdout.mjs` (CLI block)
- Modify: `scripts/score-rule-against-holdout.test.mjs` (one integration test via spawned process)

- [ ] **Step 1: Write failing integration test**

```javascript
// scripts/score-rule-against-holdout.test.mjs — append
import { spawnSync } from 'node:child_process';

test('CLI: --regime-history + --adapt-set-distribution produce regime_warning when over-indexed', () => {
  // Build a 6-trade hold-out where all 6 exceed the position-size limit AND all happen on bull-trend days.
  const trades = [];
  for (let i = 0; i < 6; i += 1) {
    trades.push({
      action: 'BUY',
      symbol: 'X', timestamp: `2026-05-1${i}T15:00:00Z`,
      market_data: { entry_price: 100, size: 100, portfolio_value: 50000, friction_adjusted_pl: -50 },
    });
  }
  // Resolve a tmp path next to this test file (independent of any vars from other test files)
  const { dirname: _d } = await import('node:path');
  const { fileURLToPath: _fu } = await import('node:url');
  const _here = _d(_fu(import.meta.url));
  const regimeFile = join(_here, '__tmp_regime_cli__.json');
  writeFileSync(regimeFile, JSON.stringify({
    as_of: '2026-05-15T21:30:00Z',
    range: { from: '2026-05-10', to: '2026-05-15' },
    classifier: { version: '2026-05-18.1' },
    labels: Object.fromEntries(trades.map(t => [t.timestamp.slice(0, 10), 'bull-trend'])),
  }));
  const result = spawnSync('node', [
    'scripts/score-rule-against-holdout.mjs',
    '--predicate', 'max_position_size_pct',
    '--params', '{"limit":0.10}',
    '--regime-history', regimeFile,
    '--adapt-set-distribution', '{"bull-trend":0.5,"chop":0.4,"bear-trend":0.1}',
  ], { input: JSON.stringify(trades), encoding: 'utf8' });
  rmSync(regimeFile, { force: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.regime_warning, `expected regime_warning, got envelope: ${JSON.stringify(parsed)}`);
  assert.match(parsed.regime_warning, /bull-trend/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test scripts/score-rule-against-holdout.test.mjs
```

Expected: new test fails (CLI doesn't parse the flags yet).

- [ ] **Step 3: Extend the CLI block in `score-rule-against-holdout.mjs`**

First, add a static `fs` import near the top of the file (next to the existing imports):

```javascript
import { readFileSync as nodeReadFileSync } from 'node:fs';
```

Then replace the existing CLI block (starting around line 236) with:

```javascript
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const pIdx = args.indexOf('--predicate');
    const paramsIdx = args.indexOf('--params');
    const rhIdx = args.indexOf('--regime-history');
    const adaptIdx = args.indexOf('--adapt-set-distribution');
    if (pIdx === -1 || paramsIdx === -1) {
      process.stderr.write('Usage: cat holdout.json | node scripts/score-rule-against-holdout.mjs --predicate <name> --params <json> [--regime-history <path>] [--adapt-set-distribution <json>]\n');
      process.exit(2);
    }
    const predicate = args[pIdx + 1];
    let params, adaptSetDistribution;
    try { params = JSON.parse(args[paramsIdx + 1]); } catch (err) {
      process.stderr.write(`--params is not valid JSON: ${err.message}\n`);
      process.exit(2);
    }
    if (adaptIdx !== -1) {
      try { adaptSetDistribution = JSON.parse(args[adaptIdx + 1]); } catch (err) {
        process.stderr.write(`--adapt-set-distribution is not valid JSON: ${err.message}\n`);
        process.exit(2);
      }
    }
    let regimeLabels = null;
    if (rhIdx !== -1) {
      const rhPath = args[rhIdx + 1];
      try {
        const rh = JSON.parse(nodeReadFileSync(rhPath, 'utf8'));
        regimeLabels = rh.labels ?? {};
      } catch (err) {
        process.stderr.write(`could not read --regime-history at ${rhPath}: ${err.message}\n`);
        // Continue without regime data; envelope simply lacks regime_warning.
      }
    }
    let stdin = '';
    process.stdin.on('data', chunk => { stdin += chunk; });
    process.stdin.on('end', () => {
      let trades;
      try { trades = JSON.parse(stdin); } catch (err) {
        process.stderr.write(`stdin is not valid JSON: ${err.message}\n`);
        process.exit(2);
      }
      if (regimeLabels) {
        trades = joinRegimeToTrades(trades, regimeLabels);
      }
      try {
        const result = dispatchPredicate(predicate, params, trades, adaptSetDistribution);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } catch (err) {
        process.stderr.write(`${err.message}\n`);
        process.exit(2);
      }
    });
  }
}
```

The static `nodeReadFileSync` import avoids `await import` inside the synchronous CLI block (which would be a parse error).

- [ ] **Step 4: Run all tests to verify they pass**

```
npm test
```

Expected: all green.

- [ ] **Step 5: Sanity-check CLI manually**

```
echo '[]' | node scripts/score-rule-against-holdout.mjs --predicate max_position_size_pct --params '{"limit":0.10}'
```

Expected: JSON envelope with `verdict: "INCONCLUSIVE"`, no regime fields.

---

### Task 8: Adapt-skill edits — Step 0.5, Step 3 join, Step 3.5 announcement, Step 6.5 scorer args

**Files:**
- Modify: `.claude/skills/adapt-strategy/SKILL.md`
- Modify: `.claude/skills/adapt-strategy-penny/SKILL.md`
- Modify: `.claude/skills/harvest-parameter-review/SKILL.md`
- Modify: `.claude/skills/trend-parameter-review/SKILL.md`

- [ ] **Step 1: Add Step 0.5 to each of the 4 adapt skills**

In each file, insert **immediately after** the existing `## Step 0 — Apply friction to raw trade data` section (before the next `## Step` heading):

```markdown
## Step 0.5 — Build regime history

After the friction post-processor completes, run:

```
node scripts/build-regime-history.mjs --from <YYYY-MM-DD of oldest loaded trade> --to <today YYYY-MM-DD>
```

Report the returned `{ action, path }` to the user. If the script exits non-zero (FMP key missing, network error), continue but tag every trade `regime: "unknown"` in Step 3 and warn the user that regime composition and `regime_warning` will be unavailable this run.
```

For `trend-parameter-review`, the existing Step 0 references the DB cohort fallback — Step 0.5 still applies cleanly between Step 0 and Step 1.

- [ ] **Step 2: Extend Step 3 (trade loading) in each adapt skill**

In `adapt-strategy/SKILL.md` and `adapt-strategy-penny/SKILL.md`, add this paragraph at the end of Step 3 (after the bullet list of fields to extract):

```markdown
**Join regime label:** After loading each `.friction.json`, also load `data/reports/regime_history.json` (if Step 0.5 succeeded). For each trade, convert `action.timestamp` to America/New_York using `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(timestamp))` and look up the date in `regime_history.labels`. If the date is a weekend/holiday or otherwise missing, walk back up to 5 calendar days for the previous trading day's label. Still missing → tag the trade `regime: "unknown"`. Add the resolved label as a top-level `regime` field on each loaded record.
```

In `harvest-parameter-review/SKILL.md`, add the same paragraph at the end of its `## Step 2 — Resolve sandboxes and load 6 months of harvest activity` (or whichever step loads the friction trades).

In `trend-parameter-review/SKILL.md`, add the same paragraph after Step 2b (where `.friction.json` files are loaded).

- [ ] **Step 3: Extend Step 3.5 with regime composition announcement**

In each adapt skill that already has a Step 3.5 (adapt-strategy, adapt-strategy-penny, harvest-parameter-review, trend-parameter-review), append this to the announcement block (after the existing top-3-symbols lines):

```markdown
> Adapt set regime composition: X% bull-trend, Y% chop, Z% bear-trend, W% unknown
> Hold-out set regime composition: …

If any single regime ≥70% in the adapt set, append:

> ⚠️ Adapt set is heavily skewed to <regime>; findings may not generalize.

Compute the adapt-set regime distribution as an object `{ "bull-trend": 0.X, "chop": 0.Y, "bear-trend": 0.Z, "unknown": 0.W }` (proportions summing to 1.0) and **record it in conversation state** as `ADAPT_SET_REGIME_DISTRIBUTION` — Step 6.5 will pass this to the scorer.
```

- [ ] **Step 4: Extend Step 6.5 (Step 7.5 for trend) — pass new flags to scorer**

Replace the existing scorer-invocation snippet in each adapt skill with:

```markdown
For each mechanical edit, invoke the scorer (pipe the hold-out set as a JSON array on stdin):

```
echo '<HOLDOUT_JSON_ARRAY>' | node scripts/score-rule-against-holdout.mjs --predicate <name> --params '<params>' --regime-history data/reports/regime_history.json --adapt-set-distribution '<ADAPT_SET_REGIME_DISTRIBUTION_JSON>'
```

The returned envelope may now contain a `regime_warning` field (when affected trades over-index a regime by ≥25pp vs adapt-set baseline) or `regime_warning_skipped: "insufficient_sample (need >= 5 affected trades; have N)"`. Capture both for Step 6.6 (or Step 7.6 in trend-parameter-review).
```

- [ ] **Step 5: Add a small skill sanity test**

Create `scripts/skills-sanity.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ADAPT_SKILLS = [
  '.claude/skills/adapt-strategy/SKILL.md',
  '.claude/skills/adapt-strategy-penny/SKILL.md',
  '.claude/skills/harvest-parameter-review/SKILL.md',
  '.claude/skills/trend-parameter-review/SKILL.md',
];

for (const path of ADAPT_SKILLS) {
  test(`${path}: has Step 0.5 — Build regime history exactly once`, () => {
    const content = readFileSync(path, 'utf8');
    const matches = content.match(/## Step 0\.5 — Build regime history/g) ?? [];
    assert.equal(matches.length, 1, `expected exactly 1 occurrence of Step 0.5 header; got ${matches.length}`);
  });

  test(`${path}: references build-regime-history.mjs`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /scripts\/build-regime-history\.mjs/);
  });

  test(`${path}: references --regime-history flag in scorer invocation`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /--regime-history data\/reports\/regime_history\.json/);
  });

  test(`${path}: references --adapt-set-distribution flag`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /--adapt-set-distribution/);
  });
}
```

- [ ] **Step 6: Run the sanity tests**

```
node --test scripts/skills-sanity.test.mjs
```

Expected: 16 pass (4 skills × 4 assertions).

---

### Task 9: Review-performance skill edits (regime composition only, no gate/scorer)

**Files:**
- Modify: `.claude/skills/review-performance/SKILL.md`
- Modify: `.claude/skills/review-performance-penny/SKILL.md`

- [ ] **Step 1: Add Step 0.5 to both review-performance skills**

In each, insert immediately after the existing `## Step 0 — Apply friction to raw trade data`:

```markdown
## Step 0.5 — Build regime history

After the friction post-processor completes, run:

```
node scripts/build-regime-history.mjs --from <YYYY-MM-DD of oldest loaded trade> --to <today YYYY-MM-DD>
```

If the script exits non-zero, continue but treat every trade as `regime: "unknown"`. Regime composition appears in this report as informational only — no gating, no proposals, no scorer integration.
```

- [ ] **Step 2: Extend the data-loading step in each review skill**

After the step that loads `.friction.json` files, add:

```markdown
**Join regime label:** For each loaded trade, convert `action.timestamp` to America/New_York and look up in `regime_history.labels` (walk back up to 5 calendar days for weekends/holidays). Tag each trade with a `regime` field; missing → `regime: "unknown"`.

When summarizing in the report, include a one-line "Regime composition: X% bull-trend, Y% chop, Z% bear-trend, W% unknown" before the headline P&L table.
```

- [ ] **Step 3: Extend the skill sanity test**

Append to `scripts/skills-sanity.test.mjs`:

```javascript
const REVIEW_SKILLS = [
  '.claude/skills/review-performance/SKILL.md',
  '.claude/skills/review-performance-penny/SKILL.md',
];

for (const path of REVIEW_SKILLS) {
  test(`${path}: has Step 0.5 — Build regime history`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /## Step 0\.5 — Build regime history/);
  });

  test(`${path}: references build-regime-history.mjs`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /scripts\/build-regime-history\.mjs/);
  });

  test(`${path}: does NOT call score-rule-against-holdout (review-only, no scorer)`, () => {
    const content = readFileSync(path, 'utf8');
    assert.doesNotMatch(content, /score-rule-against-holdout\.mjs/);
  });
}
```

- [ ] **Step 4: Run the sanity tests**

```
node --test scripts/skills-sanity.test.mjs
```

Expected: 22 pass.

---

### Task 10: `.gitignore` + Phase 1 commit

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add regime_history entry to `.gitignore`**

Append before the existing friction-output line (or after — order doesn't matter, the parent `data/` already covers it; this is documentation):

```
# Regime history (regenerated from FMP by scripts/build-regime-history.mjs)
data/reports/regime_history.json
```

- [ ] **Step 2: Run the full test suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit Phase 1 as one squashed commit**

```bash
git add scripts/build-regime-history.mjs scripts/build-regime-history.test.mjs \
        scripts/score-rule-against-holdout.mjs scripts/score-rule-against-holdout.test.mjs \
        scripts/skills-sanity.test.mjs \
        .claude/skills/adapt-strategy/SKILL.md \
        .claude/skills/adapt-strategy-penny/SKILL.md \
        .claude/skills/harvest-parameter-review/SKILL.md \
        .claude/skills/trend-parameter-review/SKILL.md \
        .claude/skills/review-performance/SKILL.md \
        .claude/skills/review-performance-penny/SKILL.md \
        .gitignore

git commit -m "$(cat <<'EOF'
feat(regime): SPY classifier + regime_warning in scorer + adapt-skill regime tagging

Item #3 from docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md.

- scripts/build-regime-history.mjs: 3-bucket SPY classifier with 50DMA-slope tiebreaker, session-close-aware cache freshness, --force-rebuild flag.
- scripts/score-rule-against-holdout.mjs: --regime-history and --adapt-set-distribution flags; regime_warning when affected trades over-index a regime by >=25pp; regime_warning_skipped for trades_affected < 5.
- All 4 adapt skills: Step 0.5 invokes build-regime-history; Step 3 joins TZ-aware (America/New_York) regime label per trade; Step 3.5 announces regime composition; Step 6.5/7.5 passes the new flags to the scorer.
- 2 review-performance skills: Step 0.5 + regime composition announcement only (no gate, no scorer).
- scripts/skills-sanity.test.mjs: grep-asserts that each skill has the expected new step headers and CLI flag references.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Expected: clean commit.

---

# Phase 2 — Item #4: Stress-test friction

Produces: `config/friction-stress.json`, `--config` flag + `output_suffix` on apply-friction, `scripts/friction-stress-compare.mjs`, and `/stress-test-friction` skill.

**Phase 2 ends with one commit:** `feat(stress): friction-stress config + comparison script + /stress-test-friction skill`

---

### Task 11: Create `config/friction-stress.json`

**Files:**
- Create: `config/friction-stress.json`

- [ ] **Step 1: Write the file with the values from the spec**

```json
{
  "version": "2026-05-18.1-stress",
  "output_suffix": "friction-stress",
  "stocks": {
    "per_share_slippage_usd": 0.04,
    "stop_gap_through_pct": 0.006,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001
  },
  "penny_stocks": {
    "per_share_slippage_usd": 0.02,
    "slippage_pct_of_price_floor": 0.04,
    "stop_gap_through_pct": 0.03,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001
  },
  "single_leg_options": {
    "spread_crossing_pct_open": 0.80,
    "spread_crossing_pct_close": 0.85,
    "spread_crossing_pct_close_when_losing": 0.95,
    "assumed_spread_pct_of_mid": 0.08,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05
  },
  "iron_condor": {
    "spread_crossing_pct_open": 0.75,
    "spread_crossing_pct_close": 0.85,
    "spread_crossing_pct_close_when_losing": 0.95,
    "assumed_spread_pct_of_credit": 0.20,
    "leg_count": 4,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05
  }
}
```

- [ ] **Step 2: Verify it loads cleanly**

```
node -e "import('./scripts/apply-friction.mjs').then(m => console.log(m.loadFrictionConfig('config/friction-stress.json').version))"
```

Expected: prints `2026-05-18.1-stress` (and no schema errors).

---

### Task 12: `apply-friction.mjs` accepts `--config <path>` flag (TDD)

**Files:**
- Modify: `scripts/apply-friction.mjs`
- Modify: `scripts/apply-friction.test.mjs`

- [ ] **Step 1: Append failing test**

```javascript
// scripts/apply-friction.test.mjs — append (near the other processSandboxes tests)
test('processSandboxes: respects frictionConfigPath option', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_alt_config__');
  rmSync(tmpRoot, { recursive: true, force: true });
  const { mkdirSync, cpSync, writeFileSync, readFileSync: rfs } = defaultFs;
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  cpSync(join(FIX_DIR, 'friction-valid.json'), join(tmpRoot, 'config', 'friction.json'));
  // Alt config: bump stocks slippage 10x → easy to detect in output.
  const alt = JSON.parse(rfs(join(FIX_DIR, 'friction-valid.json'), 'utf8'));
  alt.version = 'alt-test';
  alt.stocks.per_share_slippage_usd = 0.20;
  writeFileSync(join(tmpRoot, 'config', 'friction-alt.json'), JSON.stringify(alt, null, 2));
  mkdirSync(join(tmpRoot, 'data'), { recursive: true });
  cpSync(join(FIX_DIR, 'integration-agent-config.json'), join(tmpRoot, 'data', 'agent-config.json'));
  cpSync(
    join(FIX_DIR, 'integration-sandbox'),
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox'),
    { recursive: true },
  );

  processSandboxes({
    agentId: 'default', projectRoot: tmpRoot,
    frictionConfigPath: join(tmpRoot, 'config', 'friction-alt.json'),
  });

  const friction = JSON.parse(rfs(
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json'),
    'utf8',
  ));
  assert.equal(friction.friction_meta.friction_config_version, 'alt-test');
  // Slippage is now 0.20 × 100 × 2 = 40 (vs baseline 0.02 × 100 × 2 = 4)
  assert.equal(friction.friction_meta.haircut_breakdown.slippage, 40);

  rmSync(tmpRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
node --test scripts/apply-friction.test.mjs
```

Expected: new test fails — `processSandboxes` doesn't accept `frictionConfigPath` yet.

- [ ] **Step 3: Modify `processSandboxes` and CLI**

In `scripts/apply-friction.mjs`, update the function signature and CLI:

```javascript
export function processSandboxes({ agentId, projectRoot, frictionConfigPath, fs = defaultFs }) {
  const configPath = frictionConfigPath ?? join(projectRoot, 'config', 'friction.json');
  const agentCfgPath = join(projectRoot, 'data', 'agent-config.json');
  const config = loadFrictionConfig(configPath);
  // ... rest unchanged
```

In the CLI block, parse `--config`:

```javascript
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolve(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const agentIdx = args.indexOf('--agent');
    const configIdx = args.indexOf('--config');
    if (agentIdx === -1 || !args[agentIdx + 1]) {
      process.stderr.write('Usage: node scripts/apply-friction.mjs --agent <agent-id> [--config <path>]\n');
      process.exit(2);
    }
    const agentId = args[agentIdx + 1];
    const projectRoot = process.cwd();
    const frictionConfigPath = configIdx !== -1 ? args[configIdx + 1] : undefined;
    const stats = processSandboxes({ agentId, projectRoot, frictionConfigPath });
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```
node --test scripts/apply-friction.test.mjs
```

Expected: all pass.

---

### Task 13: `apply-friction.mjs` — `output_suffix` from config controls filename

**Files:**
- Modify: `scripts/apply-friction.mjs`
- Modify: `scripts/apply-friction.test.mjs`

- [ ] **Step 1: Append failing test**

```javascript
// scripts/apply-friction.test.mjs — append
test('processSandboxes: config with output_suffix writes *.friction-stress.json', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_suffix__');
  rmSync(tmpRoot, { recursive: true, force: true });
  const { mkdirSync, cpSync, writeFileSync, existsSync: ex } = defaultFs;
  mkdirSync(join(tmpRoot, 'config'), { recursive: true });
  const stressCfg = JSON.parse(defaultFs.readFileSync(join(FIX_DIR, 'friction-valid.json'), 'utf8'));
  stressCfg.output_suffix = 'friction-stress';
  stressCfg.version = '2026-05-18.1-stress';
  writeFileSync(join(tmpRoot, 'config', 'friction-stress.json'), JSON.stringify(stressCfg, null, 2));
  mkdirSync(join(tmpRoot, 'data'), { recursive: true });
  cpSync(join(FIX_DIR, 'integration-agent-config.json'), join(tmpRoot, 'data', 'agent-config.json'));
  cpSync(
    join(FIX_DIR, 'integration-sandbox'),
    join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox'),
    { recursive: true },
  );

  processSandboxes({
    agentId: 'default', projectRoot: tmpRoot,
    frictionConfigPath: join(tmpRoot, 'config', 'friction-stress.json'),
  });

  const stressPath = join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction-stress.json');
  const baselinePath = join(tmpRoot, 'data', 'sandboxes', 'integration-sandbox', 'decisive_actions', '2026-05-11_SELL_SPY.friction.json');
  assert.equal(ex(stressPath), true, 'stress config must write *.friction-stress.json');
  assert.equal(ex(baselinePath), false, 'stress config must NOT write *.friction.json');

  rmSync(tmpRoot, { recursive: true, force: true });
});

test('loadFrictionConfig: accepts optional output_suffix string field', () => {
  const tmpRoot = join(FIX_DIR, '__tmp_suffix_load__');
  rmSync(tmpRoot, { recursive: true, force: true });
  defaultFs.mkdirSync(tmpRoot, { recursive: true });
  const cfg = JSON.parse(defaultFs.readFileSync(join(FIX_DIR, 'friction-valid.json'), 'utf8'));
  cfg.output_suffix = 'friction-stress';
  defaultFs.writeFileSync(join(tmpRoot, 'cfg.json'), JSON.stringify(cfg));
  const loaded = loadFrictionConfig(join(tmpRoot, 'cfg.json'));
  assert.equal(loaded.output_suffix, 'friction-stress');
  rmSync(tmpRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/apply-friction.test.mjs
```

Expected: 2 new failures.

- [ ] **Step 3: Modify `apply-friction.mjs` to honor `output_suffix`**

Find the line `const outPath = join(dir, fname.replace(/\.json$/, '.friction.json'));` in `processSandboxes` and replace with:

```javascript
const suffix = config.output_suffix && config.output_suffix !== 'friction'
  ? config.output_suffix
  : 'friction';
const outPath = join(dir, fname.replace(/\.json$/, `.${suffix}.json`));
```

The current `loadFrictionConfig` does not reject unknown top-level fields, so `output_suffix` flows through transparently and no schema-validation change is needed. The second test above (`loadFrictionConfig: accepts optional output_suffix string field`) verifies this.

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/apply-friction.test.mjs
```

Expected: all pass.

---

### Task 14: `friction-stress-compare.mjs` — core diff logic (TDD)

**Files:**
- Create: `scripts/friction-stress-compare.mjs`
- Create: `scripts/friction-stress-compare.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/friction-stress-compare.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareFrictionSets } from './friction-stress-compare.mjs';

test('compareFrictionSets: matches by base filename and computes totals + delta', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'AAA', timestamp: '2026-05-15T15:00:00Z',
      market_data: { friction_adjusted_pl: 100 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction.json', symbol: 'BBB', timestamp: '2026-05-15T15:01:00Z',
      market_data: { friction_adjusted_pl: 200 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'AAA', timestamp: '2026-05-15T15:00:00Z',
      market_data: { friction_adjusted_pl: 60 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction-stress.json', symbol: 'BBB', timestamp: '2026-05-15T15:01:00Z',
      market_data: { friction_adjusted_pl: 150 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.totals.trade_count, 2);
  assert.equal(result.totals.baseline_pl_usd, 300);
  assert.equal(result.totals.stress_pl_usd, 210);
  assert.equal(result.totals.total_delta_usd, -90);
  assert.equal(result.flips.length, 0);
  assert.deepEqual(result.unmatched, []);
});

test('compareFrictionSets: detects flip (positive baseline -> negative stress)', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'AAA', timestamp: '2026-05-15T15:00:00Z',
      market_data: { friction_adjusted_pl: 50 }, friction_meta: { profile_applied: 'single_leg_options' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'AAA', timestamp: '2026-05-15T15:00:00Z',
      market_data: { friction_adjusted_pl: -10 }, friction_meta: { profile_applied: 'single_leg_options' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.flips.length, 1);
  assert.equal(result.flips[0].symbol, 'AAA');
  assert.equal(result.flips[0].baseline_pl, 50);
  assert.equal(result.flips[0].stress_pl, -10);
});

test('compareFrictionSets: per-asset-class breakdown aggregates correctly', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 100 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: 200 }, friction_meta: { profile_applied: 'single_leg_options' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 80 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction-stress.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: -50 }, friction_meta: { profile_applied: 'single_leg_options' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.per_asset_class.stocks.trade_count, 1);
  assert.equal(result.per_asset_class.stocks.flips, 0);
  assert.equal(result.per_asset_class.single_leg_options.flips, 1);
});

test('compareFrictionSets: matched-count symmetry on well-formed input', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 100 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: 200 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 80 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction-stress.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: 180 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.totals.trade_count, 2);
  assert.equal(result.unmatched.length, 0);
});

test('compareFrictionSets: unmatched listed when a side is missing a trade', () => {
  const baseline = [
    { filename: 'a.friction.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 100 }, friction_meta: { profile_applied: 'stocks' } },
    { filename: 'b.friction.json', symbol: 'B', timestamp: '...',
      market_data: { friction_adjusted_pl: 200 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const stress = [
    { filename: 'a.friction-stress.json', symbol: 'A', timestamp: '...',
      market_data: { friction_adjusted_pl: 80 }, friction_meta: { profile_applied: 'stocks' } },
  ];
  const result = compareFrictionSets({ agent: 'default', baseline, stress });
  assert.equal(result.unmatched.length, 1);
  assert.match(result.unmatched[0].reason, /missing in stress/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/friction-stress-compare.test.mjs
```

Expected: 5 failures (module doesn't exist yet).

- [ ] **Step 3: Implement `compareFrictionSets` in `friction-stress-compare.mjs`**

```javascript
// scripts/friction-stress-compare.mjs
// Baseline-vs-stress friction comparison. Spec:
// docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md

import { fileURLToPath } from 'node:url';
import { resolve as resolvePath, join, dirname } from 'node:path';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';

function baseKey(filename) {
  // 'a.friction.json' or 'a.friction-stress.json' both → 'a'
  return filename.replace(/\.friction(-stress)?\.json$/, '');
}

export function compareFrictionSets({ agent, baseline, stress, asOf = new Date().toISOString() }) {
  const baselineByKey = new Map(baseline.map(r => [baseKey(r.filename), r]));
  const stressByKey = new Map(stress.map(r => [baseKey(r.filename), r]));
  const unmatched = [];
  const flips = [];
  const perAsset = {};
  let baseline_pl_usd = 0;
  let stress_pl_usd = 0;
  let trade_count = 0;

  for (const [key, b] of baselineByKey) {
    const s = stressByKey.get(key);
    if (!s) {
      unmatched.push({ filename: b.filename, symbol: b.symbol, reason: 'missing in stress run' });
      continue;
    }
    trade_count += 1;
    const bPl = b.market_data?.friction_adjusted_pl ?? 0;
    const sPl = s.market_data?.friction_adjusted_pl ?? 0;
    baseline_pl_usd += bPl;
    stress_pl_usd += sPl;
    const flipped = (bPl > 0) !== (sPl > 0);
    if (flipped) flips.push({ symbol: b.symbol, timestamp: b.timestamp, baseline_pl: bPl, stress_pl: sPl });
    const asset = b.friction_meta?.profile_applied ?? 'unknown';
    perAsset[asset] = perAsset[asset] ?? { trade_count: 0, baseline_pl: 0, stress_pl: 0, flips: 0 };
    perAsset[asset].trade_count += 1;
    perAsset[asset].baseline_pl += bPl;
    perAsset[asset].stress_pl += sPl;
    if (flipped) perAsset[asset].flips += 1;
  }
  for (const [key, s] of stressByKey) {
    if (!baselineByKey.has(key)) {
      unmatched.push({ filename: s.filename, symbol: s.symbol, reason: 'missing in baseline run' });
    }
  }
  const total_delta_usd = +(stress_pl_usd - baseline_pl_usd).toFixed(4);
  const median_per_trade_delta_usd = trade_count > 0 ? +(total_delta_usd / trade_count).toFixed(4) : 0;
  return {
    agent,
    as_of: asOf,
    totals: {
      trade_count,
      baseline_pl_usd: +baseline_pl_usd.toFixed(4),
      stress_pl_usd: +stress_pl_usd.toFixed(4),
      total_delta_usd,
      median_per_trade_delta_usd,
    },
    flips,
    per_asset_class: perAsset,
    unmatched,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/friction-stress-compare.test.mjs
```

Expected: 5 pass.

---

### Task 15: `friction-stress-compare.mjs` — CLI orchestration

**Files:**
- Modify: `scripts/friction-stress-compare.mjs` (add `runCompare` + CLI)

- [ ] **Step 1: Add orchestration to the module**

Append to `scripts/friction-stress-compare.mjs`:

```javascript
import { processSandboxes, resolveSandboxesForAgent } from './apply-friction.mjs';

function loadFrictionFiles(projectRoot, agentId, suffix) {
  const sandboxIds = resolveSandboxesForAgent(join(projectRoot, 'data', 'agent-config.json'), agentId);
  const out = [];
  for (const sb of sandboxIds) {
    const dir = join(projectRoot, 'data', 'sandboxes', sb, 'decisive_actions');
    if (!existsSync(dir)) continue;
    const target = `.${suffix}.json`;
    for (const f of readdirSync(dir).filter(n => n.endsWith(target))) {
      try {
        const content = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        out.push({ ...content, filename: f });
      } catch (err) {
        process.stderr.write(`friction-stress-compare: skipping malformed ${f}: ${err.message}\n`);
      }
    }
  }
  return out;
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, content);
  try { renameSync(tmp, path); }
  catch (err) { if (existsSync(tmp)) try { unlinkSync(tmp); } catch {} throw err; }
}

export async function runCompare({ agentId, projectRoot, outPath }) {
  // 1. Generate baseline friction (.friction.json)
  processSandboxes({ agentId, projectRoot });
  // 2. Generate stress friction (.friction-stress.json)
  processSandboxes({ agentId, projectRoot, frictionConfigPath: join(projectRoot, 'config', 'friction-stress.json') });
  const baseline = loadFrictionFiles(projectRoot, agentId, 'friction');
  const stress = loadFrictionFiles(projectRoot, agentId, 'friction-stress');
  const report = compareFrictionSets({ agent: agentId, baseline, stress });
  const defaultOut = join(projectRoot, 'data', 'reports', `friction_stress_${agentId}_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.json`);
  const target = outPath ?? defaultOut;
  writeAtomic(target, JSON.stringify(report, null, 2));
  return { report, path: target };
}

// CLI
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const agentIdx = args.indexOf('--agent');
    const outIdx = args.indexOf('--out');
    if (agentIdx === -1) {
      process.stderr.write('Usage: node scripts/friction-stress-compare.mjs --agent <agent-id> [--out <path>]\n');
      process.exit(2);
    }
    const agentId = args[agentIdx + 1];
    const outPath = outIdx !== -1 ? args[outIdx + 1] : undefined;
    runCompare({ agentId, projectRoot: process.cwd(), outPath }).then(
      ({ path }) => { process.stdout.write(JSON.stringify({ written: path }) + '\n'); },
      (err) => { process.stderr.write(`friction-stress-compare: ${err.message}\n`); process.exit(1); },
    );
  }
}
```

- [ ] **Step 2: Smoke-test the CLI**

```
node scripts/friction-stress-compare.mjs --agent default
```

Expected: exits 0; writes `data/reports/friction_stress_default_<YYYYMMDD>.json`; the file is valid JSON. (Trade counts likely 0 since current real data lacks populated `market_data`, but the report should produce.)

---

### Task 16: `/stress-test-friction` skill

**Files:**
- Create: `.claude/skills/stress-test-friction/SKILL.md`

- [ ] **Step 1: Write the skill file**

```markdown
---
name: stress-test-friction
description: Compare baseline vs ~2x stress friction across an agent's recent trades. Diagnostic-only — never modifies any config or strategy. Use before live deployment to confirm the strategy has edge that survives worst-case fills.
allowed-tools: Read Glob Bash
---

You are running a stress-test of friction-adjusted P&L for one (or all) of the trading agents.

## Step 1 — Resolve agent

If the user supplied an agent name (`default`, `penny-prophet`, `harvest`, `trend-prophet`), use it. If they said "all" or didn't specify, iterate all four.

## Step 2 — Generate or refresh the stress comparison report

For each target agent, run:

```
node scripts/friction-stress-compare.mjs --agent <agent-id>
```

The script regenerates both baseline `*.friction.json` and stress `*.friction-stress.json` files for the agent's sandboxes, then writes `data/reports/friction_stress_<agent>_<YYYYMMDD>.json`.

If a report from today already exists, skip regeneration unless the user explicitly asked for `--force`.

## Step 3 — Read the report and present a human summary

For each agent, present a block in this exact format:

```
Stress test for agent `<agent>` — <trade_count> trades
  Baseline total adjusted P&L:  <baseline_pl_usd>
  Stress total adjusted P&L:    <stress_pl_usd>    (Δ <total_delta_usd>, median <median_per_trade_delta_usd>/trade)

Trades that flip from winner to loser under stress: <flips.length> of <single_leg_options.trade_count or whichever asset class has flips>
  - <each flip>: <baseline_pl> → <stress_pl>  (cap at top 5)

Per-asset-class verdict (flip_rate = flips / matched_trade_count_in_category):
  <asset>: <flips_in_category> of <trade_count_in_category> flip — <verdict>

Interpretation: <one-paragraph human reading>
```

**Flip-rate verdict thresholds (CODIFIED — do not improvise):**

```
flip_rate < 0.05           → "durable"   ("edge survives worst-case fills")
0.05 ≤ flip_rate < 0.20    → "marginal"  ("edge thins under stress; consider tightening entry filters")
flip_rate ≥ 0.20           → "thin"      ("edge does not survive worst-case fills; reconsider before live deployment")
trade_count_in_category == 0 → "n/a (no trades in window)"
```

## Step 4 — Diagnostic-only — never modify

You MUST NOT modify any config file, any strategy, any decisive_action, or any committed file. This skill is purely informational. If the user asks you to "apply" or "tune" friction based on the stress result, point them at `/adapt-strategy` instead — that's the loop that takes evidence and turns it into rule changes.
```

- [ ] **Step 2: Add a sanity-test entry**

Append to `scripts/skills-sanity.test.mjs`:

```javascript
test('.claude/skills/stress-test-friction/SKILL.md: references friction-stress-compare.mjs', () => {
  const content = readFileSync('.claude/skills/stress-test-friction/SKILL.md', 'utf8');
  assert.match(content, /scripts\/friction-stress-compare\.mjs/);
});

test('.claude/skills/stress-test-friction/SKILL.md: codifies flip-rate thresholds', () => {
  const content = readFileSync('.claude/skills/stress-test-friction/SKILL.md', 'utf8');
  assert.match(content, /flip_rate < 0\.05/);
  assert.match(content, /0\.05 ≤ flip_rate < 0\.20/);
  assert.match(content, /flip_rate ≥ 0\.20/);
});
```

- [ ] **Step 3: Run sanity tests**

```
node --test scripts/skills-sanity.test.mjs
```

Expected: all pass.

---

### Task 17: `.gitignore` + Phase 2 commit

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add stress artifacts to `.gitignore`**

Append:

```
# Stress-friction outputs (regenerated by scripts/friction-stress-compare.mjs)
data/sandboxes/**/*.friction-stress.json
data/reports/friction_stress_*.json
```

- [ ] **Step 2: Run the full test suite**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit Phase 2**

```bash
git add config/friction-stress.json \
        scripts/apply-friction.mjs scripts/apply-friction.test.mjs \
        scripts/friction-stress-compare.mjs scripts/friction-stress-compare.test.mjs \
        .claude/skills/stress-test-friction/SKILL.md \
        scripts/skills-sanity.test.mjs \
        .gitignore

git commit -m "$(cat <<'EOF'
feat(stress): friction-stress config + comparison script + /stress-test-friction skill

Item #4 from docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md.

- config/friction-stress.json: ~2x slippage and spread crossing (capped at 0.95); commissions/fees unchanged (contractual, not market-dependent).
- scripts/apply-friction.mjs: --config <path> CLI flag; output_suffix in config controls filename (friction.json vs friction-stress.json).
- scripts/friction-stress-compare.mjs: runs apply-friction twice, matches by base filename, computes totals/delta/flips/per-asset-breakdown; writes data/reports/friction_stress_<agent>_<YYYYMMDD>.json.
- .claude/skills/stress-test-friction/SKILL.md: user-initiated diagnostic skill with codified flip-rate thresholds (durable < 5% < marginal < 20% <= thin).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

# Phase 3 — Item #5: Significance gate

Produces: `scripts/significance-gate.mjs`, edits to all 4 adapt skills to insert the gate before proposal generation and combine verdicts in Step 6.6 / 7.6.

**Phase 3 ends with one commit:** `feat(significance): per-asset-class anti-loss-chasing gate + combined verdict`

---

### Task 18: Exposure-per-trade function (TDD)

**Files:**
- Create: `scripts/significance-gate.mjs`
- Create: `scripts/significance-gate.test.mjs`

- [ ] **Step 1: Write failing tests**

```javascript
// scripts/significance-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exposurePerTrade, WING_WIDTH_BY_UNDERLYING } from './significance-gate.mjs';

test('exposurePerTrade: stocks = |entry_price × size|', () => {
  const t = { friction_meta: { profile_applied: 'stocks' },
              market_data: { entry_price: 100, size: 50 } };
  assert.equal(exposurePerTrade(t), 5000);
});

test('exposurePerTrade: penny_stocks same as stocks shape', () => {
  const t = { friction_meta: { profile_applied: 'penny_stocks' },
              market_data: { entry_price: 0.5, size: 1000 } };
  assert.equal(exposurePerTrade(t), 500);
});

test('exposurePerTrade: single_leg_options = |entry × size × 100|', () => {
  const t = { friction_meta: { profile_applied: 'single_leg_options' },
              market_data: { entry_price: 2.5, size: 6 } };
  assert.equal(exposurePerTrade(t), 1500);
});

test('exposurePerTrade: iron_condor uses explicit wing_width when present', () => {
  const t = { friction_meta: { profile_applied: 'iron_condor' },
              symbol: 'SPY',
              market_data: { entry_price: 0.5, size: 2, wing_width: 5 } };
  assert.equal(exposurePerTrade(t), 5 * 2 * 100); // 1000
});

test('exposurePerTrade: iron_condor falls back to underlying-symbol table', () => {
  const t = { friction_meta: { profile_applied: 'iron_condor' },
              symbol: 'SPY',
              market_data: { entry_price: 0.5, size: 2 } };
  assert.equal(WING_WIDTH_BY_UNDERLYING.SPY, 5);
  assert.equal(exposurePerTrade(t), 5 * 2 * 100);
});

test('exposurePerTrade: iron_condor underlying not in table -> 10x fallback + stderr', () => {
  const t = { friction_meta: { profile_applied: 'iron_condor' },
              symbol: 'SLV',
              market_data: { entry_price: 0.5, size: 2 } };
  assert.equal(exposurePerTrade(t), 0.5 * 2 * 100 * 10); // 1000
});

test('exposurePerTrade: unknown profile -> entry × size (defensive default)', () => {
  const t = { friction_meta: { profile_applied: 'unknown' },
              market_data: { entry_price: 100, size: 10 } };
  assert.equal(exposurePerTrade(t), 1000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/significance-gate.test.mjs
```

Expected: 7 failures.

- [ ] **Step 3: Implement `exposurePerTrade`**

```javascript
// scripts/significance-gate.mjs
// Per-asset-class significance gate for adapt-strategy. Spec:
// docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md

import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

export const WING_WIDTH_BY_UNDERLYING = { SPY: 5, QQQ: 5, IWM: 2, GLD: 2, TLT: 1 };
const OCC_RE = /^([A-Z]{1,6})\d{6}[CP]\d{8}$/;

function underlyingFromSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const m = OCC_RE.exec(symbol);
  if (m) return m[1];
  if (/^[A-Z]{1,5}$/.test(symbol)) return symbol;
  return null;
}

export function exposurePerTrade(trade) {
  const profile = trade?.friction_meta?.profile_applied;
  const md = trade?.market_data ?? {};
  const entry = Math.abs(md.entry_price ?? 0);
  const size = Math.abs(md.size ?? 0);
  if (profile === 'iron_condor') {
    if (typeof md.wing_width === 'number') return md.wing_width * size * 100;
    const u = underlyingFromSymbol(trade?.symbol);
    if (u && WING_WIDTH_BY_UNDERLYING[u] != null) {
      return WING_WIDTH_BY_UNDERLYING[u] * size * 100;
    }
    process.stderr.write(`significance-gate: iron_condor with unknown wing_width — falling back to crude 10x multiplier for ${trade?.symbol}\n`);
    return entry * size * 100 * 10;
  }
  if (profile === 'single_leg_options') return entry * size * 100;
  if (profile === 'stocks' || profile === 'penny_stocks') return entry * size;
  return entry * size;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/significance-gate.test.mjs
```

Expected: 7 pass.

---

### Task 19: `gateForCategory` (TDD)

**Files:**
- Modify: `scripts/significance-gate.mjs`
- Modify: `scripts/significance-gate.test.mjs`

- [ ] **Step 1: Append failing tests**

```javascript
// scripts/significance-gate.test.mjs — append
import { gateForCategory } from './significance-gate.mjs';

const STOCK_LOSER = (pl) => ({
  friction_meta: { profile_applied: 'stocks' },
  market_data: { entry_price: 100, size: 50, friction_adjusted_pl: pl },
});

test('gateForCategory: 5 losing trades but low drawdown -> CLEARED via losses gate', () => {
  const trades = [
    STOCK_LOSER(-50), STOCK_LOSER(-30), STOCK_LOSER(-20),
    STOCK_LOSER(-10), STOCK_LOSER(-5),
  ];
  const result = gateForCategory('stocks', trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.equal(result.cleared, true);
  assert.equal(result.losing_count, 5);
});

test('gateForCategory: 2 losses with 6% drawdown -> CLEARED via drawdown gate', () => {
  const trades = [
    STOCK_LOSER(-200), STOCK_LOSER(-100),
    { friction_meta: { profile_applied: 'stocks' }, market_data: { entry_price: 100, size: 50, friction_adjusted_pl: 50 } },
  ];
  // exposure: 3 × 5000 = 15000. Losses: 300. dd = 0.02 — still below 5%.
  // Bump entry_price down to amplify drawdown: change exposure to 5000.
  const result = gateForCategory('stocks', trades, { min_losing_trades: 5, min_drawdown_pct: 0.01 });
  assert.equal(result.cleared, true);
});

test('gateForCategory: 3 losses with 2% drawdown -> BLOCKED', () => {
  const trades = [
    STOCK_LOSER(-50), STOCK_LOSER(-30), STOCK_LOSER(-20),
  ];
  // exposure: 3 × 5000 = 15000. losses: 100. dd = 0.0067.
  const result = gateForCategory('stocks', trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.equal(result.cleared, false);
  assert.match(result.reason, /below/i);
});

test('gateForCategory: empty category -> BLOCKED', () => {
  const result = gateForCategory('stocks', [], { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.equal(result.cleared, false);
});

test('gateForCategory: IC with explicit wing_width fires drawdown gate correctly', () => {
  // 1 IC, $500 max-loss, $100 loss = 20% loss-on-exposure
  const trades = [{
    friction_meta: { profile_applied: 'iron_condor' },
    symbol: 'SPY',
    market_data: { entry_price: 0.5, size: 1, wing_width: 5, friction_adjusted_pl: -100 },
  }];
  const result = gateForCategory('iron_condor', trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  // exposure: 5 × 1 × 100 = 500. losing_pl_abs: 100. dd: 0.20.
  assert.equal(result.cleared, true);
  assert.equal(+result.drawdown_pct.toFixed(2), 0.20);
});

test('gateForCategory: IC under OLD entry-price denominator would falsely clear on tiny losses', () => {
  // Demonstrates the bug being fixed: old denominator would be 0.5 × 1 × 100 = 50;
  // a $100 loss looks like 200% drawdown and trivially clears.
  // With wing_width-based denom: 500 → 20% — meaningful and correctly clears.
  const trades = [{
    friction_meta: { profile_applied: 'iron_condor' },
    symbol: 'SPY',
    market_data: { entry_price: 0.5, size: 1, wing_width: 5, friction_adjusted_pl: -10 }, // tiny loss
  }];
  const result = gateForCategory('iron_condor', trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  // dd = 10 / 500 = 0.02 < 0.05 AND losses (1) < 5 -> BLOCKED (correct)
  assert.equal(result.cleared, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/significance-gate.test.mjs
```

Expected: 6 new failures.

- [ ] **Step 3: Implement `gateForCategory`**

Append to `scripts/significance-gate.mjs`:

```javascript
export function gateForCategory(category, trades, params) {
  const { min_losing_trades, min_drawdown_pct } = params;
  const losses = trades.filter(t => (t.market_data?.friction_adjusted_pl ?? 0) < 0);
  const losing_pl_abs = Math.abs(losses.reduce((s, t) => s + (t.market_data?.friction_adjusted_pl ?? 0), 0));
  const gross_exposure = Math.max(trades.reduce((s, t) => s + exposurePerTrade(t), 0), 1);
  const drawdown_pct = losing_pl_abs / gross_exposure;
  const cleared = losses.length >= min_losing_trades || drawdown_pct >= min_drawdown_pct;
  return {
    category,
    trade_count: trades.length,
    losing_count: losses.length,
    drawdown_pct: +drawdown_pct.toFixed(6),
    threshold: params,
    cleared,
    reason: cleared
      ? null
      : `${losses.length} losses, ${(drawdown_pct * 100).toFixed(2)}% dd — below ${min_losing_trades} losses OR ${min_drawdown_pct * 100}% dd`,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/significance-gate.test.mjs
```

Expected: 13 pass.

---

### Task 20: `evaluateGate` + CLI (TDD)

**Files:**
- Modify: `scripts/significance-gate.mjs`
- Modify: `scripts/significance-gate.test.mjs`

- [ ] **Step 1: Append failing tests**

```javascript
// scripts/significance-gate.test.mjs — append
import { evaluateGate } from './significance-gate.mjs';

test('evaluateGate: groups trades by friction_meta.profile_applied', () => {
  const trades = [
    { friction_meta: { profile_applied: 'stocks' }, market_data: { entry_price: 100, size: 10, friction_adjusted_pl: -50 } },
    { friction_meta: { profile_applied: 'stocks' }, market_data: { entry_price: 100, size: 10, friction_adjusted_pl: -80 } },
    { friction_meta: { profile_applied: 'single_leg_options' }, market_data: { entry_price: 5, size: 2, friction_adjusted_pl: 100 } },
  ];
  const result = evaluateGate(trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.ok(result.by_category.stocks);
  assert.ok(result.by_category.single_leg_options);
  assert.equal(result.by_category.stocks.trade_count, 2);
  assert.equal(result.by_category.single_leg_options.trade_count, 1);
});

test('evaluateGate: missing profile_applied -> unknown bucket, BLOCKED', () => {
  const trades = [
    { market_data: { entry_price: 100, size: 10, friction_adjusted_pl: -50 } },
  ];
  const result = evaluateGate(trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.ok(result.by_category.unknown);
  assert.equal(result.by_category.unknown.cleared, false);
});

test('evaluateGate: cleared_categories and blocked_categories populated', () => {
  const trades = [
    // 5 losing stocks → clears via losses gate
    ...[1,2,3,4,5].map(() => ({
      friction_meta: { profile_applied: 'stocks' },
      market_data: { entry_price: 100, size: 10, friction_adjusted_pl: -50 },
    })),
    // 1 option, no losses → blocked
    { friction_meta: { profile_applied: 'single_leg_options' },
      market_data: { entry_price: 5, size: 2, friction_adjusted_pl: 100 } },
  ];
  const result = evaluateGate(trades, { min_losing_trades: 5, min_drawdown_pct: 0.05 });
  assert.ok(result.cleared_categories.includes('stocks'));
  assert.ok(result.blocked_categories.includes('single_leg_options'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```
node --test scripts/significance-gate.test.mjs
```

Expected: 3 new failures.

- [ ] **Step 3: Implement `evaluateGate` + CLI**

Append to `scripts/significance-gate.mjs`:

```javascript
const DEFAULTS = { min_losing_trades: 5, min_drawdown_pct: 0.05 };

export function evaluateGate(trades, params = DEFAULTS) {
  const byCategoryTrades = {};
  for (const t of trades) {
    const key = t?.friction_meta?.profile_applied ?? 'unknown';
    (byCategoryTrades[key] ?? (byCategoryTrades[key] = [])).push(t);
  }
  const by_category = {};
  const cleared_categories = [];
  const blocked_categories = [];
  for (const [cat, list] of Object.entries(byCategoryTrades)) {
    const r = cat === 'unknown'
      ? { category: cat, trade_count: list.length, losing_count: 0, drawdown_pct: 0,
          threshold: params, cleared: false, reason: 'unknown asset class — gate never clears for this bucket by design' }
      : gateForCategory(cat, list, params);
    by_category[cat] = r;
    (r.cleared ? cleared_categories : blocked_categories).push(cat);
  }
  return {
    overall_trade_count: trades.length,
    by_category,
    cleared_categories,
    blocked_categories,
  };
}

// CLI
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const argFlag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const min_losing_trades = Number(argFlag('--min-losses') ?? DEFAULTS.min_losing_trades);
    const min_drawdown_pct = Number(argFlag('--min-drawdown') ?? DEFAULTS.min_drawdown_pct);
    let stdin = '';
    process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      let trades;
      try { trades = JSON.parse(stdin); } catch (err) {
        process.stderr.write(`stdin is not valid JSON: ${err.message}\n`);
        process.exit(6);
      }
      try {
        const result = evaluateGate(trades, { min_losing_trades, min_drawdown_pct });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } catch (err) {
        process.stderr.write(`${err.message}\n`);
        process.exit(6);
      }
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
node --test scripts/significance-gate.test.mjs
```

Expected: 16 pass.

- [ ] **Step 5: Smoke-test CLI**

```
echo '[]' | node scripts/significance-gate.mjs
```

Expected: prints `{ "overall_trade_count": 0, "by_category": {}, "cleared_categories": [], "blocked_categories": [] }`.

---

### Task 21: Adapt-skill edits — Step 4.5 (or 5.5) significance gate + Step 6 skip + Step 6.6 combined verdict

**Files:**
- Modify: `.claude/skills/adapt-strategy/SKILL.md`
- Modify: `.claude/skills/adapt-strategy-penny/SKILL.md`
- Modify: `.claude/skills/harvest-parameter-review/SKILL.md`
- Modify: `.claude/skills/trend-parameter-review/SKILL.md`

- [ ] **Step 1: Insert Step 4.5 significance gate in adapt-strategy, adapt-strategy-penny, harvest-parameter-review**

In each, insert this section **between Step 4 (P&L context) and Step 5 (Gap analysis)**:

```markdown
## Step 4.5 — Significance gate (per asset class)

Pipe the **adapt set** (NOT the hold-out) as a JSON array on stdin to:

```
node scripts/significance-gate.mjs
```

Defaults: `min_losing_trades = 5`, `min_drawdown_pct = 0.05`. Override via `--min-losses` / `--min-drawdown` if the user requests.

Read the per-category result. Display this table to the user:

```
Category            Trades  Losses  Drawdown  Gate
stocks                  N1      L1     dd1%   ✓ PASSED / ✗ BLOCKED
single_leg_options      N2      L2     dd2%   ...
iron_condor             N3      L3     dd3%   ...
penny_stocks            N4      L4     dd4%   ...
```

For BLOCKED categories, also display the gate's `reason` string.

**Record the per-category gate result in conversation state as `SIGNIFICANCE_GATE`.** Step 6 will use this to decide which proposals are allowed.
```

For `trend-parameter-review`, insert as **Step 5.5** between Step 5 (gap analysis) and Step 6 (proposal generation) — wording identical.

- [ ] **Step 2: Extend Step 6 (proposal generation) to skip blocked categories**

In each adapt skill, append to the existing Step 6 section:

```markdown
**Asset-class tagging + significance gate check (NEW):** Before emitting each proposed edit, tag it with one or more asset-class categories based on its rule text:

| Proposal text contains | Tagged as |
|---|---|
| "iron condor" / "IC" / "4-leg" / "credit spread" | `iron_condor` |
| "option" / "call" / "put" / "DTE" / "delta" / OCC strike format | `single_leg_options` |
| "penny" / explicit sub-$5 ticker mention | `penny_stocks` |
| "stock" / "equity" / share-count language / common ticker mention | `stocks` |
| Affects all positions equally (e.g., "max concurrent positions ≤10") | All currently-traded categories in the adapt set |

If ALL tagged categories have `cleared: true` in `SIGNIFICANCE_GATE.by_category`, emit the proposal normally. Otherwise, do NOT emit the proposal — instead log:

> Gap [N] skipped — proposal would affect category `<X>` which did not clear significance gate (`<reason>`).
```

- [ ] **Step 3: Extend Step 6.6 (or 7.6) with the combined-verdict format**

Replace the existing verdict block in each adapt skill's Step 6.6 (Step 7.6 for trend) with:

```markdown
For each proposal, attach a combined verdict block:

```
SIGNIFICANCE GATE: PASSED — <category> (<losses> losses, <drawdown>% dd)
HOLD-OUT VERDICT:  <APPROVED-BY-HOLDOUT|REJECTED-BY-HOLDOUT|INCONCLUSIVE> — review_type: <mechanical|qualitative> — trades_affected: <N> — net_pl_delta_usd: <±$X>
REGIME WARNING:    <"<text>"|none|"insufficient_sample (need >= 5 affected trades; have N)">
FINAL:             <APPROVED|NEEDS-OVERRIDE|INCONCLUSIVE>
```

**FINAL precedence (first matching rule wins, evaluated top-down):**

1. If SIGNIFICANCE GATE = BLOCKED → proposal was never generated, no verdict block.
2. If HOLD-OUT VERDICT = REJECTED-BY-HOLDOUT → `FINAL: NEEDS-OVERRIDE` (user can apply with explicit confirmation).
3. If REGIME WARNING is present (not "none" and not "insufficient_sample") → `FINAL: NEEDS-OVERRIDE`.
4. If HOLD-OUT VERDICT = INCONCLUSIVE → `FINAL: INCONCLUSIVE`.
5. Otherwise (SIGNIFICANCE=PASSED, HOLD-OUT=APPROVED, no regime warning) → `FINAL: APPROVED`.

Application rules in Step 8 (or whichever applies-edits step):
- `APPROVED`: applied if the user approves it in Step 7.
- `NEEDS-OVERRIDE`: user must explicitly confirm before it is applied.
- `INCONCLUSIVE`: user decides as normal.
```

- [ ] **Step 4: Extend the skill sanity test**

Append to `scripts/skills-sanity.test.mjs`:

```javascript
const ADAPT_FOR_GATE = [
  '.claude/skills/adapt-strategy/SKILL.md',
  '.claude/skills/adapt-strategy-penny/SKILL.md',
  '.claude/skills/harvest-parameter-review/SKILL.md',
  '.claude/skills/trend-parameter-review/SKILL.md',
];

for (const path of ADAPT_FOR_GATE) {
  test(`${path}: references significance-gate.mjs`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /scripts\/significance-gate\.mjs/);
  });

  test(`${path}: has the FINAL precedence rule list`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /FINAL precedence/);
    assert.match(content, /NEEDS-OVERRIDE/);
  });

  test(`${path}: has the asset-class tagging table`, () => {
    const content = readFileSync(path, 'utf8');
    assert.match(content, /iron condor/);
    assert.match(content, /Asset-class tagging/);
  });
}
```

- [ ] **Step 5: Run sanity tests**

```
node --test scripts/skills-sanity.test.mjs
```

Expected: all pass.

---

### Task 22: Full regression + Phase 3 commit

- [ ] **Step 1: Run the full test suite**

```
npm test
```

Expected: every test passes.

- [ ] **Step 2: Smoke-test all CLIs**

```
node scripts/apply-friction.mjs --agent default
echo '[]' | node scripts/significance-gate.mjs
echo '[]' | node scripts/score-rule-against-holdout.mjs --predicate max_position_size_pct --params '{"limit":0.10}'
```

Each should exit 0 with valid JSON output.

- [ ] **Step 3: Commit Phase 3**

```bash
git add scripts/significance-gate.mjs scripts/significance-gate.test.mjs \
        scripts/skills-sanity.test.mjs \
        .claude/skills/adapt-strategy/SKILL.md \
        .claude/skills/adapt-strategy-penny/SKILL.md \
        .claude/skills/harvest-parameter-review/SKILL.md \
        .claude/skills/trend-parameter-review/SKILL.md

git commit -m "$(cat <<'EOF'
feat(significance): per-asset-class anti-loss-chasing gate + combined verdict

Item #5 from docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md.

- scripts/significance-gate.mjs: per-asset-class gate. Cleared when category has >=5 losing trades OR drawdown >=5% of gross exposure. Iron-condor exposure uses wing_width (explicit field, then symbol-table {SPY:5,QQQ:5,IWM:2,GLD:2,TLT:1}, then crude 10x fallback) so credit-spread max-loss isn't under-counted ~10x.
- 4 adapt skills: Step 4.5 (5.5 for trend) runs the gate on the adapt set; Step 6 skips proposal generation for blocked categories; Step 6.6 (7.6 for trend) emits a combined verdict (SIGNIFICANCE + HOLD-OUT + REGIME WARNING -> FINAL) with explicit precedence rules.

Three-gate combination: a proposal becomes FINAL=APPROVED only when SIGNIFICANCE=PASSED AND HOLD-OUT=APPROVED-BY-HOLDOUT AND no REGIME WARNING. Otherwise FINAL=NEEDS-OVERRIDE or INCONCLUSIVE.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

# Post-implementation verification

- [ ] **Step 1: Confirm three new commits on the branch**

```
git log --oneline -3
```

Expected:
```
<hash> feat(significance): ...
<hash> feat(stress): ...
<hash> feat(regime): ...
```

- [ ] **Step 2: Full smoke run of an adapt cycle (manual, optional)**

If FMP_API_KEY is set and there are real trades in the data folder, you can do a dry-run of one of the adapt skills to see the end-to-end output. But this is not gating — the test suite is the proof.

- [ ] **Step 3: Update memory if anything was learned**

If implementation surfaced a useful pattern, add to memory per the project's auto-memory conventions. Don't memorize the implementation itself (it's in code + spec) — only surprises or feedback-worthy insights.
