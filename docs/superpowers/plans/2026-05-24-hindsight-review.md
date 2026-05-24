# Hindsight-Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only `hindsight-review` skill (Prophet-only, v1) that ranks the session's biggest movers over the tradable floor, classifies each into a bias-firebreak bucket, and a `--scorecard` mode that aggregates the findings ledger into a self-retiring KEEP/REVIEW/RETIRE verdict.

**Architecture:** Two tested deterministic `.mjs` scripts own the arithmetic (`rank-floor-movers.mjs` = "the floor + a date → ranked moves + off-floor tally"; `hindsight-scorecard.mjs` = "ledger history → cloning verdict"). A prose `SKILL.md` owns the judgment (bucket classification, eyes-on-vs-T, catalyst attribution, foregone-P&L). The skill writes a per-run JSON ledger that the scorecard later reads.

**Tech Stack:** Node ES modules (`.mjs`), `node:test` + `node:assert/strict`, FMP REST (`historical-price-full`, `stock_market/gainers|losers`) with an injectable `fetchImpl`, the existing `scripts/apply-friction.mjs` exports (`resolveSandboxesForAgent`) reused for scope resolution.

**Spec:** `docs/superpowers/specs/2026-05-24-hindsight-review-design.md`

---

## Data source: FMP-only v1 (codified in spec §2)

`rank-floor-movers.mjs` fetches daily bars **directly from FMP** (`historical-price-full`, one small call per floor name). It does **not** reuse the Go `data/bar-cache/`: that cache keys files by the consuming agent's lookback window (`{sym}_1Day_{start}_{end}.json`), so an arbitrary hindsight date range essentially never hits, and the payload is a Go-owned shape with no JS reader. ~50 on-demand calls per run are within budget. This was a spec deviation during planning; the spec owner accepted it and it is now an explicit §2 non-goal — no action needed, just build FMP-only. Bar-cache reuse is a deferred optimization (Task 9 note).

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/rank-floor-movers.mjs` (new) | Pure helpers (`parseFloorFile`, `computeMovePct`) + FMP fetchers (`fetchDailyMove`, `fetchOffFloorMovers`) + `rankFloorMovers` orchestrator + CLI. Arithmetic only — no buckets, no judgment. |
| `scripts/rank-floor-movers.test.mjs` (new) | Unit tests for the above against mock `fetchImpl`. |
| `scripts/hindsight-scorecard.mjs` (new) | Pure `aggregateLedger` + `computeVerdict` (the five-state gate) + CLI that reads the ledger dir and resolves period realized P&L. |
| `scripts/hindsight-scorecard.test.mjs` (new) | Unit tests: aggregation + the full verdict matrix. |
| `.claude/skills/hindsight-review/SKILL.md` (new) | The judgment procedure: scope resolution, run the scripts, classify buckets, compute foregone P&L, write report + ledger, print verdict in `--scorecard` mode. |

All commits land on a feature branch `hindsight-review` (we are on `main`). Per-task commits below; squash at merge per the owner's one-commit-per-item workflow.

---

## Task 0: Create the feature branch

- [ ] **Step 1: Branch off main**

Run:
```bash
git checkout -b hindsight-review
```
Expected: `Switched to a new branch 'hindsight-review'`.

---

## Task 1: `parseFloorFile` — read the tradable-universe floor

**Files:**
- Create: `scripts/rank-floor-movers.mjs`
- Test: `scripts/rank-floor-movers.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/rank-floor-movers.test.mjs`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: FAIL — `Cannot find module './rank-floor-movers.mjs'` (or `parseFloorFile is not a function`).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/rank-floor-movers.mjs`:
```javascript
// scripts/rank-floor-movers.mjs
// Ranks the Prophet tradable floor's biggest daily movers for a given session,
// plus a passive off-floor "forbidden winners" tally. Arithmetic only — bucket
// classification and foregone-P&L are the skill's job.
// Spec: docs/superpowers/specs/2026-05-24-hindsight-review-design.md

export function parseFloorFile(text) {
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sym = line.toUpperCase();
    if (seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/rank-floor-movers.mjs scripts/rank-floor-movers.test.mjs
git commit -m "feat: parseFloorFile for hindsight-review floor loading"
```

---

## Task 2: `computeMovePct` — daily % move from ascending closes

**Files:**
- Modify: `scripts/rank-floor-movers.mjs`
- Test: `scripts/rank-floor-movers.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/rank-floor-movers.test.mjs`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: FAIL — `computeMovePct is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/rank-floor-movers.mjs`:
```javascript
export function computeMovePct(rowsAsc, targetDate) {
  // rowsAsc: ascending [{ date:'YYYY-MM-DD', close:number }]. Returns percent
  // move of the last row with date <= targetDate vs the row immediately before
  // it, or null if fewer than 2 usable rows exist.
  let i = -1;
  for (let k = 0; k < rowsAsc.length; k += 1) {
    if (rowsAsc[k].date <= targetDate) i = k; else break;
  }
  if (i < 1) return null;
  const cur = rowsAsc[i].close;
  const prev = rowsAsc[i - 1].close;
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || prev === 0) return null;
  return (cur / prev - 1) * 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/rank-floor-movers.mjs scripts/rank-floor-movers.test.mjs
git commit -m "feat: computeMovePct daily-move helper"
```

---

## Task 3: `fetchDailyMove` — per-symbol FMP fetch, soft-fail to null

**Files:**
- Modify: `scripts/rank-floor-movers.mjs`
- Test: `scripts/rank-floor-movers.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/rank-floor-movers.test.mjs`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: FAIL — `fetchDailyMove is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/rank-floor-movers.mjs` (add the host constant near the top of the file, below the header comment):
```javascript
const FMP_HOST = 'https://financialmodelingprep.com';

function addDays(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export async function fetchDailyMove({ symbol, date, apiKey, fetchImpl = globalThis.fetch }) {
  // Soft-fail: any error, non-ok status, or malformed/empty payload returns null.
  // The caller records nulls in `missing[]`; a name is never treated as flat.
  const from = addDays(date, -10); // ~7 calendar days back guarantees >=1 prior session
  const url = `${FMP_HOST}/api/v3/historical-price-full/${symbol}?from=${from}&to=${date}&apikey=${apiKey}`;
  try {
    const resp = await fetchImpl(url);
    if (!resp || !resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data?.historical) || data.historical.length === 0) return null;
    const rowsAsc = data.historical
      .map((r) => ({ date: r.date, close: Number(r.close) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const move = computeMovePct(rowsAsc, date);
    if (move === null) return null;
    return { symbol, move_pct: +move.toFixed(4) };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/rank-floor-movers.mjs scripts/rank-floor-movers.test.mjs
git commit -m "feat: fetchDailyMove FMP fetcher with per-name soft-fail"
```

---

## Task 4: `fetchOffFloorMovers` — passive off-floor "forbidden winners" tally

**Files:**
- Modify: `scripts/rank-floor-movers.mjs`
- Test: `scripts/rank-floor-movers.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/rank-floor-movers.test.mjs`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: FAIL — `fetchOffFloorMovers is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/rank-floor-movers.mjs`:
```javascript
export async function fetchOffFloorMovers({
  floorSet, apiKey, fetchImpl = globalThis.fetch, minPrice = 20, topN = 10,
}) {
  // Passive curation log (spec §6.1). Never enters the bucket analysis and never
  // throws — any failure yields an empty tally.
  const endpoints = ['stock_market/gainers', 'stock_market/losers'];
  const rows = [];
  for (const ep of endpoints) {
    try {
      const resp = await fetchImpl(`${FMP_HOST}/api/v3/${ep}?apikey=${apiKey}`);
      if (!resp || !resp.ok) continue;
      const data = await resp.json();
      if (!Array.isArray(data)) continue;
      for (const it of data) {
        const sym = String(it.symbol ?? '').toUpperCase();
        const move = Number(it.changesPercentage);
        const price = Number(it.price);
        if (!sym || !Number.isFinite(move)) continue;
        if (floorSet.has(sym)) continue;
        if (Number.isFinite(price) && price < minPrice) continue;
        rows.push({ symbol: sym, move_pct: +move.toFixed(4) });
      }
    } catch { /* soft-fail this endpoint */ }
  }
  rows.sort((a, b) => Math.abs(b.move_pct) - Math.abs(a.move_pct));
  return rows.slice(0, topN);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/rank-floor-movers.mjs scripts/rank-floor-movers.test.mjs
git commit -m "feat: fetchOffFloorMovers passive off-floor tally"
```

---

## Task 5: `rankFloorMovers` orchestrator + CLI

**Files:**
- Modify: `scripts/rank-floor-movers.mjs`
- Test: `scripts/rank-floor-movers.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `scripts/rank-floor-movers.test.mjs`:
```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: FAIL — `rankFloorMovers is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/rank-floor-movers.mjs` (the `*Impl` params allow the test to inject fakes; production defaults call the real fetchers):
```javascript
export async function rankFloorMovers({
  floor, date, apiKey, fetchImpl = globalThis.fetch,
  fetchDailyMoveImpl = fetchDailyMove, fetchOffFloorImpl = fetchOffFloorMovers,
}) {
  const floorSet = new Set(floor);
  const moves = [];
  const missing = [];
  for (const symbol of floor) {
    // Sequential to stay gentle on the shared FMP budget (on-demand skill, not a loop).
    const r = await fetchDailyMoveImpl({ symbol, date, apiKey, fetchImpl });
    if (r === null) missing.push(symbol);
    else moves.push(r);
  }
  moves.sort((a, b) => Math.abs(b.move_pct) - Math.abs(a.move_pct));
  const off = await fetchOffFloorImpl({ floorSet, apiKey, fetchImpl });
  return {
    date,
    floor_size: floor.length,
    movers_ranked: moves,
    missing,
    off_floor_forbidden_winners: off,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/rank-floor-movers.test.mjs`
Expected: PASS (12 tests total).

- [ ] **Step 5: Add the CLI entry (manual smoke, not unit-tested)**

Append to `scripts/rank-floor-movers.mjs`:
```javascript
// CLI entry — only runs when invoked directly.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const argFlag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const floorPath = argFlag('--floor') ?? 'config/prophet_tradable_universe.txt';
    const date = argFlag('--date') ?? new Date().toISOString().slice(0, 10);
    const apiKey = process.env.FMP_API_KEY ?? '';
    if (!apiKey) { process.stderr.write('rank-floor-movers: FMP_API_KEY not set\n'); process.exit(3); }
    const floor = parseFloorFile(readFileSync(floorPath, 'utf8'));
    rankFloorMovers({ floor, date, apiKey, fetchImpl: globalThis.fetch }).then(
      (r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); },
      (err) => { process.stderr.write(`rank-floor-movers: ${err.message}\n`); process.exit(4); },
    );
  }
}
```

- [ ] **Step 6: Smoke-run the CLI (requires FMP_API_KEY; if unset, skip and note it)**

Run (PowerShell): `node scripts/rank-floor-movers.mjs --date 2026-05-22`
Expected: a JSON object with `movers_ranked`, `missing`, `off_floor_forbidden_winners`. If `FMP_API_KEY` is unset, expect exit 3 with the clear message — that is acceptable; note it and move on.

- [ ] **Step 7: Commit**

```bash
git add scripts/rank-floor-movers.mjs scripts/rank-floor-movers.test.mjs
git commit -m "feat: rankFloorMovers orchestrator + CLI"
```

---

## Task 6: `aggregateLedger` — flatten the ledger window into metrics

**Files:**
- Create: `scripts/hindsight-scorecard.mjs`
- Test: `scripts/hindsight-scorecard.test.mjs`

Ledger record shape (one file per run, spec §6.2). `movers_ranked[]` entries carry `bucket` ∈ {`coverage_gap`,`timing_gap`,`discipline_gap`,`rules_silent`,`unforeseeable`}, plus on `discipline_gap`: `foregone_pl_usd`, `catalyst` (`"none-found"` etc.), `routed_outcome` (`null`|`"pending"`|`"survived-holdout"`|`"rejected-holdout"`).

- [ ] **Step 1: Write the failing test**

Create `scripts/hindsight-scorecard.test.mjs`:
```javascript
// scripts/hindsight-scorecard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLedger } from './hindsight-scorecard.mjs';

function disc(symbol, cost, { catalyst = 'found', routed = null } = {}) {
  return { symbol, bucket: 'discipline_gap', foregone_pl_usd: cost, catalyst, routed_outcome: routed };
}

test('aggregateLedger: counts buckets, sums discipline cost (bucket 2 only), and unverified subset', () => {
  const records = [
    { date: '2026-05-01', movers_ranked: [disc('NVDA', 400, { catalyst: 'none-found' }), { symbol: 'AVGO', bucket: 'coverage_gap' }] },
    { date: '2026-05-02', movers_ranked: [disc('NVDA', 200, { catalyst: 'found' }), { symbol: 'X', bucket: 'unforeseeable' }] },
  ];
  const agg = aggregateLedger(records);
  assert.equal(agg.sessions, 2);
  assert.equal(agg.buckets.discipline_gap, 2);
  assert.equal(agg.buckets.coverage_gap, 1);
  assert.equal(agg.buckets.unforeseeable, 1);
  assert.equal(agg.disciplineCostUsd, 600);
  assert.equal(agg.catalystUnverifiedUsd, 400); // only the none-found discipline gap
});

test('aggregateLedger: recurrence keyed by symbol:bucket; maxRecurrence is the highest', () => {
  const records = [
    { date: '2026-05-01', movers_ranked: [disc('NVDA', 100)] },
    { date: '2026-05-02', movers_ranked: [disc('NVDA', 100)] },
    { date: '2026-05-03', movers_ranked: [disc('NVDA', 100), { symbol: 'AVGO', bucket: 'coverage_gap' }] },
  ];
  const agg = aggregateLedger(records);
  assert.equal(agg.recurrence['NVDA:discipline_gap'], 3);
  assert.equal(agg.maxRecurrence, 3);
});

test('aggregateLedger: actionedSurvived counts only survived-holdout', () => {
  const records = [
    { date: '2026-05-01', movers_ranked: [disc('NVDA', 100, { routed: 'survived-holdout' })] },
    { date: '2026-05-02', movers_ranked: [disc('AMD', 100, { routed: 'rejected-holdout' })] },
    { date: '2026-05-03', movers_ranked: [disc('AMD', 100, { routed: 'pending' })] },
  ];
  assert.equal(aggregateLedger(records).actionedSurvived, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/hindsight-scorecard.test.mjs`
Expected: FAIL — `Cannot find module './hindsight-scorecard.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/hindsight-scorecard.mjs`:
```javascript
// scripts/hindsight-scorecard.mjs
// Aggregates the hindsight-review findings ledger over a trailing window and
// renders the five-state cloning verdict (spec §7).
// Spec: docs/superpowers/specs/2026-05-24-hindsight-review-design.md

const BUCKETS = ['coverage_gap', 'timing_gap', 'discipline_gap', 'rules_silent', 'unforeseeable'];

export function aggregateLedger(records) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const recurrence = {};
  let disciplineCostUsd = 0;
  let catalystUnverifiedUsd = 0;
  let actionedSurvived = 0;

  for (const rec of records) {
    for (const m of rec.movers_ranked ?? []) {
      if (m.bucket in buckets) buckets[m.bucket] += 1;
      const key = `${m.symbol}:${m.bucket}`;
      recurrence[key] = (recurrence[key] ?? 0) + 1;
      if (m.bucket === 'discipline_gap') {
        const cost = Number(m.foregone_pl_usd) || 0;
        disciplineCostUsd += cost;
        if (m.catalyst === 'none-found') catalystUnverifiedUsd += cost;
        if (m.routed_outcome === 'survived-holdout') actionedSurvived += 1;
      }
    }
  }
  const maxRecurrence = Object.values(recurrence).reduce((a, b) => Math.max(a, b), 0);
  return {
    sessions: records.length,
    buckets,
    recurrence,
    maxRecurrence,
    disciplineCostUsd: +disciplineCostUsd.toFixed(2),
    catalystUnverifiedUsd: +catalystUnverifiedUsd.toFixed(2),
    actionedSurvived,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/hindsight-scorecard.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/hindsight-scorecard.mjs scripts/hindsight-scorecard.test.mjs
git commit -m "feat: aggregateLedger for hindsight scorecard"
```

---

## Task 7: `computeVerdict` — the five-state cloning gate

**Files:**
- Modify: `scripts/hindsight-scorecard.mjs`
- Test: `scripts/hindsight-scorecard.test.mjs`

Verdict rules (spec §7):
- `INSUFFICIENT_DATA` if `sessions < minSessions` OR `buckets.discipline_gap < minDisciplineFindings`.
- `KEEP_STRONG` if `actionedSurvived >= 1`.
- Provisional path requires **both**: `disciplineCostUsd > costPctThreshold × realizedPlPeriod` (only when `realizedPlPeriod > 0`) **AND** `maxRecurrence >= recurrenceThreshold`.
  - If both hold and `reviewEnabled` and `unverifiedShare >= unverifiedShareThreshold` → `REVIEW`; else → `KEEP_PROVISIONAL`.
- else `RETIRE`. (`unverifiedShare = disciplineCostUsd > 0 ? catalystUnverifiedUsd/disciplineCostUsd : 0`.)

- [ ] **Step 1: Write the failing test**

Append to `scripts/hindsight-scorecard.test.mjs`:
```javascript
import { computeVerdict } from './hindsight-scorecard.mjs';

const TH = { minSessions: 15, minDisciplineFindings: 8, costPctThreshold: 0.25, recurrenceThreshold: 3, unverifiedShareThreshold: 0.5 };
// A baseline aggregate that clears the data floor; override fields per test.
function agg(over = {}) {
  return {
    sessions: 20, buckets: { discipline_gap: 10 }, maxRecurrence: 1,
    disciplineCostUsd: 0, catalystUnverifiedUsd: 0, actionedSurvived: 0, ...over,
  };
}

test('computeVerdict: below session floor -> INSUFFICIENT_DATA', () => {
  const v = computeVerdict({ agg: agg({ sessions: 14 }), realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true });
  assert.equal(v.verdict, 'INSUFFICIENT_DATA');
});

test('computeVerdict: below discipline-findings floor -> INSUFFICIENT_DATA', () => {
  const v = computeVerdict({ agg: agg({ buckets: { discipline_gap: 7 } }), realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true });
  assert.equal(v.verdict, 'INSUFFICIENT_DATA');
});

test('computeVerdict: actionedSurvived>=1 -> KEEP_STRONG regardless of cost/recurrence', () => {
  const v = computeVerdict({ agg: agg({ actionedSurvived: 1 }), realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true });
  assert.equal(v.verdict, 'KEEP_STRONG');
});

test('computeVerdict: cost>25% AND recurrence>=3 AND unverified<0.5 -> KEEP_PROVISIONAL', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 3000, catalystUnverifiedUsd: 500, maxRecurrence: 3 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'KEEP_PROVISIONAL');
});

test('computeVerdict: same but unverified>=0.5 -> REVIEW (not a block)', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 3000, catalystUnverifiedUsd: 2000, maxRecurrence: 3 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'REVIEW');
});

test('computeVerdict: reviewEnabled=false collapses REVIEW back to KEEP_PROVISIONAL', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 3000, catalystUnverifiedUsd: 2000, maxRecurrence: 3 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: false,
  });
  assert.equal(v.verdict, 'KEEP_PROVISIONAL');
});

test('computeVerdict: recurrence>=3 but cost<=25% -> RETIRE (recurrence alone cannot keep)', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 1000, maxRecurrence: 5 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'RETIRE');
});

test('computeVerdict: cost>25% but recurrence<3 -> RETIRE (cost alone cannot keep)', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 9000, maxRecurrence: 2 }),
    realizedPlPeriod: 10000, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'RETIRE');
});

test('computeVerdict: realizedPlPeriod<=0 disables provisional/REVIEW, leaves RETIRE here', () => {
  const v = computeVerdict({
    agg: agg({ disciplineCostUsd: 9000, catalystUnverifiedUsd: 0, maxRecurrence: 5 }),
    realizedPlPeriod: 0, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'RETIRE');
  assert.equal(v.conditions.costPathAvailable, false);
});

test('computeVerdict: realizedPlPeriod<=0 still allows KEEP_STRONG', () => {
  const v = computeVerdict({
    agg: agg({ actionedSurvived: 2 }), realizedPlPeriod: -500, thresholds: TH, reviewEnabled: true,
  });
  assert.equal(v.verdict, 'KEEP_STRONG');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/hindsight-scorecard.test.mjs`
Expected: FAIL — `computeVerdict is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/hindsight-scorecard.mjs`:
```javascript
export const DEFAULT_THRESHOLDS = {
  minSessions: 15,
  minDisciplineFindings: 8,
  costPctThreshold: 0.25,
  recurrenceThreshold: 3,
  unverifiedShareThreshold: 0.5,
};

export function computeVerdict({ agg, realizedPlPeriod, thresholds = DEFAULT_THRESHOLDS, reviewEnabled = true }) {
  const t = thresholds;
  const disciplineFindings = agg.buckets?.discipline_gap ?? 0;
  const costPathAvailable = Number(realizedPlPeriod) > 0;
  const costExceeds = costPathAvailable && agg.disciplineCostUsd > t.costPctThreshold * realizedPlPeriod;
  const hasRecurring = agg.maxRecurrence >= t.recurrenceThreshold;
  const unverifiedShare = agg.disciplineCostUsd > 0 ? agg.catalystUnverifiedUsd / agg.disciplineCostUsd : 0;

  const conditions = {
    sessions: agg.sessions,
    disciplineFindings,
    costPathAvailable,
    costExceeds,
    hasRecurring,
    unverifiedShare: +unverifiedShare.toFixed(3),
    actionedSurvived: agg.actionedSurvived,
  };

  let verdict;
  if (agg.sessions < t.minSessions || disciplineFindings < t.minDisciplineFindings) {
    verdict = 'INSUFFICIENT_DATA';
  } else if (agg.actionedSurvived >= 1) {
    verdict = 'KEEP_STRONG';
  } else if (costExceeds && hasRecurring) {
    verdict = (reviewEnabled && unverifiedShare >= t.unverifiedShareThreshold) ? 'REVIEW' : 'KEEP_PROVISIONAL';
  } else {
    verdict = 'RETIRE';
  }
  return { verdict, conditions };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/hindsight-scorecard.test.mjs`
Expected: PASS (13 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/hindsight-scorecard.mjs scripts/hindsight-scorecard.test.mjs
git commit -m "feat: computeVerdict five-state cloning gate"
```

---

## Task 8: scorecard CLI — read ledger window + resolve realized P&L

**Files:**
- Modify: `scripts/hindsight-scorecard.mjs`
- Test: `scripts/hindsight-scorecard.test.mjs`

Reuses `resolveSandboxesForAgent` from `scripts/apply-friction.mjs` (DRY) to find Prophet's sandbox dirs, then sums `summary.total_pnl` from `activity_logs` within the window. The window filter and P&L sum are a pure helper (`realizedPlFromActivity`) so they're unit-testable without FS.

- [ ] **Step 1: Write the failing test**

Append to `scripts/hindsight-scorecard.test.mjs`:
```javascript
import { realizedPlFromActivity, loadLedgerWindow } from './hindsight-scorecard.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('realizedPlFromActivity: sums total_pnl for dates within [from,to]', () => {
  const logs = [
    { date: '2026-05-01', summary: { total_pnl: 100 } },
    { date: '2026-05-10', summary: { total_pnl: -40 } },
    { date: '2026-04-01', summary: { total_pnl: 999 } }, // out of window
  ];
  assert.equal(realizedPlFromActivity(logs, '2026-05-01', '2026-05-31'), 60);
});

const __dirname_t = dirname(fileURLToPath(import.meta.url));
const TMP = join(__dirname_t, '__tmp_scorecard__');

test('loadLedgerWindow: reads hindsight_*.json within the window, sorted', () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, 'hindsight_2026-05-01.json'), JSON.stringify({ date: '2026-05-01', movers_ranked: [] }));
  writeFileSync(join(TMP, 'hindsight_2026-05-09.json'), JSON.stringify({ date: '2026-05-09', movers_ranked: [] }));
  writeFileSync(join(TMP, 'hindsight_2026-04-01.json'), JSON.stringify({ date: '2026-04-01', movers_ranked: [] }));
  writeFileSync(join(TMP, 'notes.txt'), 'ignore me');
  const recs = loadLedgerWindow(TMP, '2026-05-01', '2026-05-31');
  assert.deepEqual(recs.map((r) => r.date), ['2026-05-01', '2026-05-09']);
  rmSync(TMP, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/hindsight-scorecard.test.mjs`
Expected: FAIL — `realizedPlFromActivity is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/hindsight-scorecard.mjs`:
```javascript
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function realizedPlFromActivity(logs, from, to) {
  let sum = 0;
  for (const log of logs) {
    if (log?.date >= from && log?.date <= to) sum += Number(log?.summary?.total_pnl) || 0;
  }
  return +sum.toFixed(2);
}

export function loadLedgerWindow(ledgerDir, from, to) {
  let files;
  try { files = readdirSync(ledgerDir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = /^hindsight_(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (!m) continue;
    if (m[1] < from || m[1] > to) continue;
    try { out.push(JSON.parse(readFileSync(join(ledgerDir, f), 'utf8'))); } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/hindsight-scorecard.test.mjs`
Expected: PASS (15 tests total).

- [ ] **Step 5: Add the CLI entry (manual smoke)**

Append to `scripts/hindsight-scorecard.mjs`:
```javascript
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { resolveSandboxesForAgent } from './apply-friction.mjs';

export function realizedPlForAgent({ projectRoot, agentConfigPath, agentId, from, to }) {
  // Soft-fail to 0 (the verdict treats <=0 as "metric dark", which is correct here).
  let dirs = [];
  try { dirs = resolveSandboxesForAgent(agentConfigPath, agentId); } catch { return 0; }
  let total = 0;
  for (const dir of dirs) {
    const logDir = join(projectRoot, 'data', 'sandboxes', dir, 'activity_logs');
    let files = [];
    try { files = readdirSync(logDir); } catch { continue; }
    const logs = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { logs.push(JSON.parse(readFileSync(join(logDir, f), 'utf8'))); } catch { /* skip */ }
    }
    total += realizedPlFromActivity(logs, from, to);
  }
  return +total.toFixed(2);
}

{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const argFlag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const weeks = Number(argFlag('--weeks') ?? 4);
    const reviewEnabled = !args.includes('--no-review');
    const projectRoot = process.cwd();
    const ledgerDir = join(projectRoot, 'data', 'reports', 'hindsight');
    const to = argFlag('--to') ?? new Date().toISOString().slice(0, 10);
    const fromD = new Date(`${to}T00:00:00Z`);
    fromD.setUTCDate(fromD.getUTCDate() - weeks * 7);
    const from = fromD.toISOString().slice(0, 10);

    const records = loadLedgerWindow(ledgerDir, from, to);
    const agg = aggregateLedger(records);
    const realizedPlPeriod = realizedPlForAgent({
      projectRoot, agentConfigPath: join(projectRoot, 'data', 'agent-config.json'),
      agentId: 'default', from, to,
    });
    const { verdict, conditions } = computeVerdict({ agg, realizedPlPeriod, reviewEnabled });
    process.stdout.write(JSON.stringify({ window: { from, to }, realizedPlPeriod, agg, verdict, conditions }, null, 2) + '\n');
  }
}
```

- [ ] **Step 6: Smoke-run the CLI**

Run (PowerShell): `node scripts/hindsight-scorecard.mjs --weeks 4`
Expected: a JSON object with `window`, `agg`, `verdict`, `conditions`. With no ledger files yet, expect `sessions: 0` → `verdict: "INSUFFICIENT_DATA"`. That is the correct cold-start result.

- [ ] **Step 7: Commit**

```bash
git add scripts/hindsight-scorecard.mjs scripts/hindsight-scorecard.test.mjs
git commit -m "feat: hindsight-scorecard CLI with ledger window + realized P&L"
```

---

## Task 9: Write the `hindsight-review` SKILL.md (the judgment layer)

**Files:**
- Create: `.claude/skills/hindsight-review/SKILL.md`

This is a prose procedure (like `review-performance`/`postmortem`), not code — no TDD. It must encode the spec's judgment rules exactly.

- [ ] **Step 1: Write the skill file**

Create `.claude/skills/hindsight-review/SKILL.md` with this content:

````markdown
---
name: hindsight-review
description: Read-only hindsight report on the session's biggest movers across Prophet's tradable floor — classifies each into coverage/timing/discipline/rules-silent/unforeseeable buckets, estimates foregone P&L from rule-violations only, and (in --scorecard mode) renders a self-retiring KEEP/REVIEW/RETIRE verdict. Prophet only. Pass a date (YYYY-MM-DD), --days N, or --scorecard [--weeks N]. Never edits rules.
allowed-tools: Read Glob Bash
---

You are producing a **read-only** hindsight review for the Prophet trading agent. You never edit a strategy and never invent a new trading signal. The only "could we have caught it" question you ask is *would Prophet's current, already-deployed rules have fired* — measured only on mechanically-checkable conditions. Spec: `docs/superpowers/specs/2026-05-24-hindsight-review-design.md`.

**Input:** `$ARGUMENTS` — a date `YYYY-MM-DD` (target session), or `--days N`, or `--scorecard [--weeks N] [--no-review]`. Empty → the most recent completed trading session.

## Step 0 — Resolve scope by agent (always first)

1. Read `data/agent-config.json`.
2. In `agents[]`, find `id === 'default'` (fallback: name containing `"Prophet"`, excluding `"PennyProphet"`/`"TrendProphet"`). Note its `strategyId`.
3. In `strategies[]`, find that id; extract `customRules` — the rulebook you measure against. **Never** hardcode rules.
4. Iterate `sandboxes`, keep every entry where `agent.activeAgentId === 'default'`. Collect `accountId`s as `<PROPHET_DIRS>`. If empty, stop and tell the user no sandbox uses agent `default`.
5. Read the tradable floor: `config/prophet_tradable_universe.txt` (the universe is whatever this file says — never a hardcoded list).
6. Note the always-surfaced intraday watchlist from `agent/harness.js` (`PROPHET_INTRADAY_WATCHLIST`). These names are auto-pushed into every heartbeat, so they are "seen" at every heartbeat.

State the resolved sandbox list, the floor size, and the watchlist before continuing.

## --scorecard mode (branch here if `--scorecard` is present)

Run: `node scripts/hindsight-scorecard.mjs --weeks <N default 4>` (append `--no-review` if the user passed it).

Report the printed `verdict` and `conditions` verbatim, then translate for the user:
- `INSUFFICIENT_DATA` → "Not enough data yet (need ≥15 sessions and ≥8 discipline findings). Keep observing — no clone/retire decision."
- `KEEP_STRONG` → "A hindsight-sourced change survived the hold-out. Proven value — safe to clone per the §7 gate."
- `KEEP_PROVISIONAL` → "Costly AND systematic (cost >25% of realized P&L and a ≥3× recurring finding). Worth acting on; clone candidate."
- `REVIEW` → "Qualifies for keep, but the foregone cost leans on `none-found` discipline gaps (catalyst-recall risk). Spot-check those findings before trusting the keep." List the `discipline_gap` findings with `catalyst: none-found` so the user can eyeball them.
- `RETIRE` → "No edge demonstrated. Do not clone; retire the feature on Prophet."

Then STOP — `--scorecard` produces no per-session report.

## Step 1 — Determine the target session and rank movers

Resolve the target date: explicit `YYYY-MM-DD`, or the most recent completed session (you may reuse the trading-day logic the repo uses elsewhere; weekends/NYSE holidays are not sessions). For `--days N`, repeat Steps 1–5 per day and aggregate the reports.

Run: `node scripts/rank-floor-movers.mjs --date <YYYY-MM-DD>` and read the JSON (`movers_ranked`, `missing`, `off_floor_forbidden_winners`, `floor_size`). If it exits non-zero (e.g. `FMP_API_KEY` unset), stop and tell the user — there is no report without mover data.

Focus the analysis on the **biggest movers** — the top of `movers_ranked` by `|move_pct|`. A reasonable default is moves with `|move_pct| ≥ 4%`, owner-tunable; if none clear the bar, say so and write an empty-but-honest report.

## Step 2 — Load what the agent saw

For each `<DIR>` in `<PROPHET_DIRS>`: glob `data/sandboxes/<DIR>/decisive_actions/*.json` (the raw files — you need the `market_data` snapshots and timestamps) and the day's `activity_logs/activity_<date>.json`. Merge across sandboxes; tag each record with its sandbox.

For each big mover, gather every `decisive_actions` record that day whose `symbol` equals the mover OR whose `market_data`/`reasoning` mentions it. Record each such record's **timestamp**.

## Step 3 — Classify each big mover into exactly one bucket (spec §5.1)

Let **T** = the time the mechanically-checkable entry conditions were first met that session (Step 4 computes the verifiable conditions; T is the earliest moment they held). A mover with no such T cannot be a discipline gap.

- **coverage_gap (1a)** — a *non-watchlist* floor name with **no** `market_data`/`reasoning` mention all session. The agent never looked.
- **timing_gap (1b)** — the agent's only eyes-on the name predates T (its snapshots/mentions are all before T) and there's no evidence it looked again at/after T. Watchlist names rarely land here (re-surfaced every heartbeat). Accrues **no** foregone cost.
- **discipline_gap (2)** — the agent had eyes on the name **at or after T** (a watchlist name automatically qualifies via the heartbeat covering T; a non-watchlist name needs a snapshot timestamp ≥ T), the verifiable entry conditions were met, and it did not open. **Only this bucket accrues foregone cost.**
- **rules_silent (3)** — seen, but the verifiable entry conditions were never met. Not a miss.
- **unforeseeable (4)** — attributed to (or, per §5.5, *suspected* from) news not knowable at T. Takes precedence over bucket 2.

## Step 4 — Verifiable conditions + base rate + foregone P&L (spec §5.2–5.4)

For each candidate discipline_gap:
- Replay **only** mechanically-checkable conditions present in the data (within floor, RVOL/VWAP/spread thresholds, DTE/delta where applicable). **State explicitly** which conditions you could and could not verify. Never claim the agent's judgment would have said yes; if the only "fire" rests on unverifiable judgment, downgrade to rules_silent with a note.
- **Base-rate denominator (mandatory):** count how many *other* floor names showed the same verifiable setup that session and what happened to them. No computable denominator → suppress the discipline-gap claim entirely.
- **Foregone P&L (bias-free):** entry at T's price; exit at the **rule-defined** target/stop/EOD — **never the realized high/low**; size per the rule; then haircut with the friction model (reuse the logic in `scripts/apply-friction.mjs`; if unavailable tag `raw-pl-fallback`).

## Step 5 — Catalyst attribution + the §5.5 recall firebreak

Attribute each big mover's cause using the `catalyst-news` / `analyst-actions` skill outputs for the date. Then apply §5.5:
- If `none-found` **and** the move is dominated by an opening gap or a single bar (≈ ≥½ of the day's move in one discontinuity) → reclassify to **unforeseeable** (`catalyst: "suspected-unfound"`, `move_shape: "gap"|"single-bar"`). No foregone cost.
- If `none-found` **and** the move is continuous → keep as discipline_gap but set `catalyst_checked: true, catalyst: "none-found"`. Its cost is tracked separately as catalyst-unverified by the scorecard.

## Step 6 — Write the report and the ledger

Write the human report (sections per spec §6.1: Session movers table with bucket per name; Coverage gaps 1a+1b; Discipline gaps with verifiable-conditions, eyes-on-vs-T evidence, base rate, foregone P&L; Rules-silent brief; Unforeseeable with catalyst cited; **Off-floor forbidden winners — a passive curation log only**; Suggested follow-ups referencing finding `id`s). Never propose rule text.

Write the machine ledger to `data/reports/hindsight/hindsight_<YYYY-MM-DD>.json` per the spec §6.2 schema. Each `movers_ranked` entry gets a stable `id` of `"<date>:<symbol>"`, its `bucket`, `trigger_time_et`, `eyes_on_at_or_after_T`, `eyes_on_source`, `verifiable_conditions`, `base_rate`, and (discipline_gap only) `foregone_pl_usd`, `foregone_pl_basis`, `catalyst_checked`, `catalyst`, `move_shape`, `routed_to_adapt_strategy: false`, `routed_outcome: null`. Plus top-level `coverage_gaps_never_looked`, `timing_gaps`, `off_floor_forbidden_winners`, `missing`. Create the `data/reports/hindsight/` directory if absent.

`routed_to_adapt_strategy` / `routed_outcome` are the **only** fields a human edits later (when they route a finding to `/adapt-strategy` and learn whether it survived the hold-out). The scorecard reads `routed_outcome === "survived-holdout"` for the KEEP_STRONG path.

## Step 7 — Close

Remind the user: this report changed nothing. To act on a finding, route it to `/adapt-strategy` (which still applies its own hold-out + significance gate), then set that finding's `routed_outcome` in the ledger so the scorecard can credit it.
````

- [ ] **Step 2: Validate front-matter via the skills sanity test**

Run: `node --test scripts/skills-sanity.test.mjs`
Expected: PASS — the new skill's front-matter (`name`, `description`, `allowed-tools`) parses cleanly alongside the others. If the test enumerates skills and fails on the new directory, read its assertions and fix the front-matter to match the established shape (compare against `.claude/skills/postmortem/SKILL.md`).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/hindsight-review/SKILL.md
git commit -m "feat: hindsight-review SKILL.md judgment procedure"
```

> **Deferred (not v1):** bar-cache reuse in `rank-floor-movers.mjs` (see "Deviation from spec" above); a daily cron wrapper; auto-writeback of `routed_outcome` from `adapt-strategy`; pruning of old `hindsight_<date>.json` files. All flagged in the spec, none built here.

---

## Task 10: Full suite green + finish

- [ ] **Step 1: Run the whole Node test suite**

Run: `node --test scripts/`
Expected: all tests pass (the two new files plus the existing ones). No success claim without green output (project convention).

- [ ] **Step 2: Confirm no stray modifications**

Run: `git status` and `git diff --stat main`
Expected: only the five new files (two scripts + two tests + one SKILL.md). No edits to existing files (`rank-floor-movers.mjs` imports `resolveSandboxesForAgent` from `apply-friction.mjs` but does not modify it).

- [ ] **Step 3: Hand off**

Per the owner's workflow, offer to squash the per-task commits into one before opening a PR to `NeverLucky2/ClaudeProphetAndFriends`. Do not push or open the PR until the owner asks.

---

## Self-review notes (for the implementer)

- **Spec coverage:** §3 scope → SKILL Step 0; §4 data sources → SKILL Steps 1–2 + `rank-floor-movers.mjs` (FMP-only, bar-cache deferred — see Deviation); §5.1 buckets → SKILL Step 3; §5.2 verifiable boundary + §5.3 base rate + §5.4 foregone P&L → SKILL Step 4; §5.5 catalyst firebreak → SKILL Step 5; §6 output+ledger → SKILL Step 6; §7 verdict → `computeVerdict` (Task 7) + SKILL --scorecard; §8 component split → Tasks 1–9; §9 testing → Tasks 1–8 tests.
- **Type consistency:** bucket strings are identical across the scorecard (`BUCKETS`), the tests, and the SKILL ledger schema (`coverage_gap`, `timing_gap`, `discipline_gap`, `rules_silent`, `unforeseeable`). `routed_outcome === 'survived-holdout'` is the single string checked in `aggregateLedger` and written by the SKILL. `move_pct`, `foregone_pl_usd`, `catalyst` field names match between `rank-floor-movers.mjs`, `aggregateLedger`, and the ledger schema.
- **No placeholders:** every code step contains complete, runnable code; every run step states the exact command and expected result.
