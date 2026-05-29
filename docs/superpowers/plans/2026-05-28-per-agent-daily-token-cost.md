# Per-Agent Daily Token Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-beat opencode token usage + cost into per-day rollup files keyed on (sandboxId, agentId, phase), and surface aggregated daily totals through a new dashboard tab, a markdown daily report, and a CLI shim for skill access. Default ON via `COST_TRACKING_ENABLED`; soft-fail on write errors; no per-beat retention.

**Architecture:** New `agent/cost-store.js` owns `data/sandboxes/{accountId}/costs/{YYYY-MM-DD}.json` files with atomic writes. Harness calls `recordBeat` once at end-of-beat where `formatBeatCostLine` already emits. Four read consumers (HTTP endpoint, dashboard tab, daily-report writer, CLI shim) share `aggregateByAgent` and a `cost-report-writer.js` markdown helper.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict`, `fs/promises`, vanilla HTML/JS in `agent/public/index.html`, no new dependencies.

---

## File Structure

**Create:**
- `agent/cost-store.js` — recordBeat, readDay, readRange, aggregateByAgent, internal _etDate
- `agent/cost-store.test.mjs` — pure unit + I/O tests
- `agent/cost-report-writer.js` — markdown rendering (notable shifts, per-agent table, per-phase table)
- `agent/cost-report-writer.test.mjs` — snapshot/format tests
- `scripts/cost-report.mjs` — CLI shim importing cost-store
- `scripts/cost-report.test.mjs` — CLI integration test

**Modify:**
- `agent/harness.js` — Add `reasoning` to `tok` accumulator; add fire-and-forget `costStore.recordBeat(...)` call after the existing cost-line emit; guard with `COST_TRACKING_ENABLED !== 'false'`
- `agent/server.js` — Add `GET /api/v1/costs?days=N` endpoint (returns 404 when disabled)
- `agent/analysis-scheduler.js` — Add post-close hook firing once per ET trading day at ~16:30 ET to write the daily report
- `agent/public/index.html` — Add Costs tab button, tab body, render JS

---

## Task 1: Cost-store scaffold + `_etDate` helper

**Files:**
- Create: `agent/cost-store.js`
- Create: `agent/cost-store.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `agent/cost-store.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _etDate } from './cost-store.js';

test('_etDate returns YYYY-MM-DD in America/New_York', () => {
  // 2026-05-28 14:32:11 UTC is 2026-05-28 10:32 EDT
  assert.equal(_etDate(new Date('2026-05-28T14:32:11.000Z')), '2026-05-28');
});

test('_etDate handles UTC-midnight that is still previous ET day', () => {
  // 2026-05-29 00:30 UTC is 2026-05-28 20:30 EDT
  assert.equal(_etDate(new Date('2026-05-29T00:30:00.000Z')), '2026-05-28');
});

test('_etDate handles UTC-noon that is morning ET (no boundary)', () => {
  // 2026-01-15 17:00 UTC is 2026-01-15 12:00 EST (DST off)
  assert.equal(_etDate(new Date('2026-01-15T17:00:00.000Z')), '2026-01-15');
});

test('_etDate handles DST spring-forward day', () => {
  // 2026-03-08 07:00 UTC is 2026-03-08 02:00 EST → spring forward at 02:00 → 03:00 EDT
  // The date is unambiguously 2026-03-08
  assert.equal(_etDate(new Date('2026-03-08T07:00:00.000Z')), '2026-03-08');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: FAIL with `Cannot find module './cost-store.js'`

- [ ] **Step 3: Write minimal implementation**

Create `agent/cost-store.js`:

```js
// Per-day rollup store for opencode beat cost + token usage. Each beat's
// (sandboxId, agentId, phase) row is upserted into a per-account per-day
// JSON file at data/sandboxes/{accountId}/costs/{YYYY-MM-DD}.json.
// Schema documented in docs/superpowers/specs/2026-05-28-per-agent-daily-token-cost-design.md.
import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;

// _etDate returns YYYY-MM-DD for the given Date in America/New_York.
// Internal; exported for tests. Mirrors the same helper in trades-store.js
// and the startOfEtTradingDayIso helper in fills-summary.js — extracting
// to a shared util is a separate cleanup PR.
const _etFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

export function _etDate(date) {
  return _etFormatter.format(date);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add agent/cost-store.js agent/cost-store.test.mjs
git commit -m "feat(cost-store): scaffold + _etDate helper (ET trading day)"
```

---

## Task 2: `recordBeat` — first write creates file

**Files:**
- Modify: `agent/cost-store.js`
- Modify: `agent/cost-store.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `agent/cost-store.test.mjs`:

```js
import { recordBeat, readDay } from './cost-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function tmpRoot() {
  return await mkdtemp(path.join(tmpdir(), 'cost-store-test-'));
}

test('recordBeat first write creates directory + file with one row', async () => {
  const root = await tmpRoot();
  try {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1',
      agentId: 'default', agentName: 'Prophet', model: 'sonnet',
      phase: 'midday',
      cost: 1.2345, input: 1000, output: 500, reasoning: 0,
      cacheRead: 4000, cacheWrite: 100,
      beatStartAt: '2026-05-28T14:32:11.000Z',
    });
    const day = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(day.schemaVersion, 1);
    assert.equal(day.date, '2026-05-28');
    assert.equal(day.rows.length, 1);
    const row = day.rows[0];
    assert.equal(row.sandboxId, 'sbx1');
    assert.equal(row.agentId, 'default');
    assert.equal(row.agentName, 'Prophet');
    assert.equal(row.model, 'sonnet');
    assert.equal(row.phase, 'midday');
    assert.equal(row.cost, 1.2345);
    assert.equal(row.input, 1000);
    assert.equal(row.output, 500);
    assert.equal(row.reasoning, 0);
    assert.equal(row.cacheRead, 4000);
    assert.equal(row.cacheWrite, 100);
    assert.equal(row.beatCount, 1);
    assert.equal(row.firstBeatAt, '2026-05-28T14:32:11.000Z');
    assert.equal(row.lastBeatAt, '2026-05-28T14:32:11.000Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: FAIL with `recordBeat is not a function` / `readDay is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `agent/cost-store.js`:

```js
function costsDir(projectRoot, accountId) {
  return path.join(projectRoot, 'data', 'sandboxes', accountId, 'costs');
}

function costsFile(projectRoot, accountId, ymd) {
  return path.join(costsDir(projectRoot, accountId), `${ymd}.json`);
}

function emptyDay(date) {
  return { schemaVersion: SCHEMA_VERSION, date, rows: [] };
}

// readDay returns { schemaVersion, date, rows } for one (accountId, date)
// pair, or null if missing. Corruption/schema-mismatch handling added in
// Task 5 — for now treat any read error as missing.
export async function readDay(projectRoot, accountId, date) {
  try {
    const raw = await fs.readFile(costsFile(projectRoot, accountId, date), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

// recordBeat upserts the (sandboxId, agentId, phase) row in the per-day
// file. ET-date is derived from beatStartAt. Caller wraps in try/catch
// for soft-fail behavior; this function does not swallow I/O errors.
export async function recordBeat(projectRoot, {
  accountId, sandboxId, agentId, agentName, model, phase,
  cost, input, output, reasoning, cacheRead, cacheWrite,
  beatStartAt,
}) {
  const date = _etDate(new Date(beatStartAt));
  const dir = costsDir(projectRoot, accountId);
  await fs.mkdir(dir, { recursive: true });
  const existing = await readDay(projectRoot, accountId, date);
  const day = existing || emptyDay(date);

  const nowIso = new Date().toISOString();
  const newRow = {
    sandboxId, agentId, agentName, model, phase,
    cost, input, output, reasoning, cacheRead, cacheWrite,
    beatCount: 1,
    firstBeatAt: beatStartAt,
    lastBeatAt: nowIso,
  };
  day.rows.push(newRow);

  await fs.writeFile(costsFile(projectRoot, accountId, date), JSON.stringify(day, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: PASS (5 tests total)

- [ ] **Step 5: Commit**

```bash
git add agent/cost-store.js agent/cost-store.test.mjs
git commit -m "feat(cost-store): recordBeat creates per-day file with first row"
```

---

## Task 3: `recordBeat` — upsert accumulation + multi-row independence

**Files:**
- Modify: `agent/cost-store.js`
- Modify: `agent/cost-store.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `agent/cost-store.test.mjs`:

```js
test('recordBeat second beat accumulates into existing row', async () => {
  const root = await tmpRoot();
  try {
    const beat1 = {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'default',
      agentName: 'Prophet', model: 'sonnet', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 200, cacheWrite: 10,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    };
    const beat2 = { ...beat1,
      cost: 0.5, input: 50, output: 25, reasoning: 0, cacheRead: 100, cacheWrite: 5,
      beatStartAt: '2026-05-28T14:05:00.000Z',
    };
    await recordBeat(root, beat1);
    await recordBeat(root, beat2);
    const day = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(day.rows.length, 1, 'should upsert, not append');
    const row = day.rows[0];
    assert.equal(row.cost, 1.5);
    assert.equal(row.input, 150);
    assert.equal(row.output, 75);
    assert.equal(row.cacheRead, 300);
    assert.equal(row.cacheWrite, 15);
    assert.equal(row.beatCount, 2);
    assert.equal(row.firstBeatAt, '2026-05-28T14:00:00.000Z', 'firstBeatAt preserved');
    // lastBeatAt is "now" — assert it advanced past firstBeatAt
    assert.ok(row.lastBeatAt > row.firstBeatAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordBeat different phases on same sandbox are independent rows', async () => {
  const root = await tmpRoot();
  try {
    const base = {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'default',
      agentName: 'Prophet', model: 'sonnet',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    };
    await recordBeat(root, { ...base, phase: 'midday' });
    await recordBeat(root, { ...base, phase: 'pre_market' });
    const day = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(day.rows.length, 2);
    const phases = day.rows.map(r => r.phase).sort();
    assert.deepEqual(phases, ['midday', 'pre_market']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recordBeat different sandboxes on same day are independent rows', async () => {
  const root = await tmpRoot();
  try {
    const base = {
      accountId: 'acc1', agentId: 'default', agentName: 'Prophet',
      model: 'sonnet', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    };
    await recordBeat(root, { ...base, sandboxId: 'sbx1' });
    await recordBeat(root, { ...base, sandboxId: 'sbx2' });
    const day = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(day.rows.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: FAIL on the upsert test (currently `recordBeat` always pushes, so `rows.length === 2`)

- [ ] **Step 3: Replace `recordBeat` with upsert logic**

Replace the body of `recordBeat` in `agent/cost-store.js`:

```js
export async function recordBeat(projectRoot, {
  accountId, sandboxId, agentId, agentName, model, phase,
  cost, input, output, reasoning, cacheRead, cacheWrite,
  beatStartAt,
}) {
  const date = _etDate(new Date(beatStartAt));
  const dir = costsDir(projectRoot, accountId);
  await fs.mkdir(dir, { recursive: true });
  const existing = await readDay(projectRoot, accountId, date);
  const day = existing || emptyDay(date);

  const nowIso = new Date().toISOString();
  const existingRow = day.rows.find(r =>
    r.sandboxId === sandboxId && r.agentId === agentId && r.phase === phase
  );

  if (existingRow) {
    existingRow.cost += cost;
    existingRow.input += input;
    existingRow.output += output;
    existingRow.reasoning += reasoning;
    existingRow.cacheRead += cacheRead;
    existingRow.cacheWrite += cacheWrite;
    existingRow.beatCount += 1;
    existingRow.lastBeatAt = nowIso;
    // Refresh display fields in case agentName/model changed mid-day.
    existingRow.agentName = agentName;
    existingRow.model = model;
  } else {
    day.rows.push({
      sandboxId, agentId, agentName, model, phase,
      cost, input, output, reasoning, cacheRead, cacheWrite,
      beatCount: 1,
      firstBeatAt: beatStartAt,
      lastBeatAt: nowIso,
    });
  }

  await fs.writeFile(costsFile(projectRoot, accountId, date), JSON.stringify(day, null, 2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: PASS (8 tests total)

- [ ] **Step 5: Commit**

```bash
git add agent/cost-store.js agent/cost-store.test.mjs
git commit -m "feat(cost-store): upsert by (sandboxId, agentId, phase)"
```

---

## Task 4: `recordBeat` — atomic write + stable row sort

**Files:**
- Modify: `agent/cost-store.js`
- Modify: `agent/cost-store.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `agent/cost-store.test.mjs`:

```js
test('recordBeat sorts rows by (sandboxId, agentId, phase) on every write', async () => {
  const root = await tmpRoot();
  try {
    const base = {
      accountId: 'acc1', agentName: 'X', model: 'sonnet',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    };
    // Insert out of order
    await recordBeat(root, { ...base, sandboxId: 'sbx_z', agentId: 'b', phase: 'midday' });
    await recordBeat(root, { ...base, sandboxId: 'sbx_a', agentId: 'a', phase: 'pre_market' });
    await recordBeat(root, { ...base, sandboxId: 'sbx_a', agentId: 'a', phase: 'midday' });
    const day = await readDay(root, 'acc1', '2026-05-28');
    const keys = day.rows.map(r => `${r.sandboxId}|${r.agentId}|${r.phase}`);
    assert.deepEqual(keys, [
      'sbx_a|a|midday',
      'sbx_a|a|pre_market',
      'sbx_z|b|midday',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic write: simulated rename failure leaves existing file intact', async () => {
  const root = await tmpRoot();
  try {
    // First beat lands successfully
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'a', agentName: 'A',
      model: 'm', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T14:00:00.000Z',
    });
    const before = await readDay(root, 'acc1', '2026-05-28');

    // Patch fs.rename to throw, then attempt a second beat
    const fsmod = await import('node:fs/promises');
    const realRename = fsmod.default.rename;
    fsmod.default.rename = async () => { throw new Error('simulated EIO'); };
    let threw = false;
    try {
      await recordBeat(root, {
        accountId: 'acc1', sandboxId: 'sbx1', agentId: 'a', agentName: 'A',
        model: 'm', phase: 'midday',
        cost: 99.0, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0,
        beatStartAt: '2026-05-28T14:05:00.000Z',
      });
    } catch { threw = true; }
    fsmod.default.rename = realRename;

    assert.ok(threw, 'recordBeat should propagate write errors');
    const after = await readDay(root, 'acc1', '2026-05-28');
    assert.equal(after.rows[0].cost, before.rows[0].cost, 'existing file unchanged on rename failure');
    assert.equal(after.rows[0].beatCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: FAIL — sort test fails (rows are in insertion order); atomic-write test fails (currently `fs.writeFile` directly, so a write that throws may leave a partial file)

- [ ] **Step 3: Add stable sort + atomic write**

In `agent/cost-store.js`, replace the final `await fs.writeFile(...)` line of `recordBeat` with an atomic-write helper and add a sort step. The full updated body:

```js
export async function recordBeat(projectRoot, {
  accountId, sandboxId, agentId, agentName, model, phase,
  cost, input, output, reasoning, cacheRead, cacheWrite,
  beatStartAt,
}) {
  const date = _etDate(new Date(beatStartAt));
  const dir = costsDir(projectRoot, accountId);
  await fs.mkdir(dir, { recursive: true });
  const existing = await readDay(projectRoot, accountId, date);
  const day = existing || emptyDay(date);

  const nowIso = new Date().toISOString();
  const existingRow = day.rows.find(r =>
    r.sandboxId === sandboxId && r.agentId === agentId && r.phase === phase
  );

  if (existingRow) {
    existingRow.cost += cost;
    existingRow.input += input;
    existingRow.output += output;
    existingRow.reasoning += reasoning;
    existingRow.cacheRead += cacheRead;
    existingRow.cacheWrite += cacheWrite;
    existingRow.beatCount += 1;
    existingRow.lastBeatAt = nowIso;
    existingRow.agentName = agentName;
    existingRow.model = model;
  } else {
    day.rows.push({
      sandboxId, agentId, agentName, model, phase,
      cost, input, output, reasoning, cacheRead, cacheWrite,
      beatCount: 1,
      firstBeatAt: beatStartAt,
      lastBeatAt: nowIso,
    });
  }

  // Stable sort: (sandboxId, agentId, phase). Cost is negligible (≤ ~30 rows)
  // and stable file diffs help when the operator inspects a file by hand.
  day.rows.sort((a, b) =>
    a.sandboxId.localeCompare(b.sandboxId) ||
    a.agentId.localeCompare(b.agentId) ||
    a.phase.localeCompare(b.phase)
  );

  await _atomicWrite(costsFile(projectRoot, accountId, date), JSON.stringify(day, null, 2));
}

// _atomicWrite: write to tmp then rename. fs.rename is atomic within one
// filesystem on POSIX and NTFS. Caller is responsible for ensuring the
// parent directory exists.
async function _atomicWrite(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, filePath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: PASS (10 tests total)

- [ ] **Step 5: Commit**

```bash
git add agent/cost-store.js agent/cost-store.test.mjs
git commit -m "feat(cost-store): atomic write + stable (sandbox,agent,phase) row sort"
```

---

## Task 5: `readDay` — missing / corrupt / unknown-schema handling

**Files:**
- Modify: `agent/cost-store.js`
- Modify: `agent/cost-store.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `agent/cost-store.test.mjs`:

```js
import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';

test('readDay returns null for missing file', async () => {
  const root = await tmpRoot();
  try {
    const day = await readDay(root, 'noacc', '2026-05-28');
    assert.equal(day, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readDay returns null and warns once for corrupt JSON', async () => {
  const root = await tmpRoot();
  try {
    const dir = path.join(root, 'data', 'sandboxes', 'acc1', 'costs');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2026-05-28.json'), '{not json');

    const warnings = [];
    const logger = (msg) => warnings.push(msg);

    const r1 = await readDay(root, 'acc1', '2026-05-28', { logger });
    const r2 = await readDay(root, 'acc1', '2026-05-28', { logger });
    assert.equal(r1, null);
    assert.equal(r2, null);
    assert.equal(warnings.length, 1, 'warn exactly once per file per process');
    assert.match(warnings[0], /corrupt/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readDay returns null and warns for unknown schemaVersion', async () => {
  const root = await tmpRoot();
  try {
    const dir = path.join(root, 'data', 'sandboxes', 'acc1', 'costs');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '2026-05-28.json'),
      JSON.stringify({ schemaVersion: 999, date: '2026-05-28', rows: [] }));
    const warnings = [];
    const r = await readDay(root, 'acc1', '2026-05-28', { logger: (m) => warnings.push(m) });
    assert.equal(r, null);
    assert.match(warnings[0], /schema/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: missing-file test PASSES already; corrupt test FAILS (currently throws on `JSON.parse`); schema test FAILS (no version check).

- [ ] **Step 3: Replace `readDay` with full error handling**

In `agent/cost-store.js`, replace `readDay` with:

```js
// Module-level Set so we warn once per file path per process lifetime.
const _warnedFiles = new Set();

export async function readDay(projectRoot, accountId, date, { logger = console.warn } = {}) {
  const file = costsFile(projectRoot, accountId, date);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (!_warnedFiles.has(file)) {
      _warnedFiles.add(file);
      logger(`cost-store: corrupt JSON at ${file} — returning null`);
    }
    return null;
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    if (!_warnedFiles.has(file)) {
      _warnedFiles.add(file);
      logger(`cost-store: unknown schemaVersion ${parsed.schemaVersion} at ${file} — returning null`);
    }
    return null;
  }

  return parsed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: PASS (13 tests total)

- [ ] **Step 5: Commit**

```bash
git add agent/cost-store.js agent/cost-store.test.mjs
git commit -m "feat(cost-store): readDay handles missing, corrupt, and unknown-schema files"
```

---

## Task 6: `readRange` — multi-day + filters

**Files:**
- Modify: `agent/cost-store.js`
- Modify: `agent/cost-store.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `agent/cost-store.test.mjs`:

```js
import { readRange } from './cost-store.js';

async function seedThreeDays(root) {
  for (const [date, sbx] of [
    ['2026-05-26', 'sbx1'],
    ['2026-05-27', 'sbx1'],
    ['2026-05-27', 'sbx2'],
    ['2026-05-28', 'sbx1'],
  ]) {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: sbx, agentId: 'a', agentName: 'A',
      model: 'm', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: `${date}T18:00:00.000Z`,  // 18:00Z = 14:00 EDT
    });
  }
}

test('readRange returns days inclusive, newest last', async () => {
  const root = await tmpRoot();
  try {
    await seedThreeDays(root);
    const result = await readRange(root, { from: '2026-05-26', to: '2026-05-28' });
    const dates = result.map(d => d.date);
    assert.deepEqual(dates, ['2026-05-26', '2026-05-27', '2026-05-28']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readRange skips missing days entirely (no empty entry)', async () => {
  const root = await tmpRoot();
  try {
    // Only seed 2026-05-28
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'a', agentName: 'A',
      model: 'm', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T18:00:00.000Z',
    });
    const result = await readRange(root, { from: '2026-05-26', to: '2026-05-28' });
    assert.equal(result.length, 1);
    assert.equal(result[0].date, '2026-05-28');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readRange sandboxId filter limits returned rows', async () => {
  const root = await tmpRoot();
  try {
    await seedThreeDays(root);
    const result = await readRange(root, {
      from: '2026-05-26', to: '2026-05-28', sandboxId: 'sbx2',
    });
    const sandboxIds = result.flatMap(d => d.rows.map(r => r.sandboxId));
    assert.deepEqual(new Set(sandboxIds), new Set(['sbx2']));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readRange iterates all accounts when accountId not specified', async () => {
  const root = await tmpRoot();
  try {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'a', agentName: 'A',
      model: 'm', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T18:00:00.000Z',
    });
    await recordBeat(root, {
      accountId: 'acc2', sandboxId: 'sbx9', agentId: 'b', agentName: 'B',
      model: 'm', phase: 'midday',
      cost: 2.0, input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      beatStartAt: '2026-05-28T18:00:00.000Z',
    });
    const result = await readRange(root, { from: '2026-05-28', to: '2026-05-28' });
    assert.equal(result.length, 1);
    assert.equal(result[0].rows.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: FAIL with `readRange is not a function`

- [ ] **Step 3: Implement `readRange`**

Append to `agent/cost-store.js`:

```js
// _enumerateDates returns YYYY-MM-DD strings from `from` to `to` inclusive.
// Throws if from > to.
function _enumerateDates(from, to) {
  if (from > to) throw new Error(`readRange: from (${from}) > to (${to})`);
  const out = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    const ymd = cur.toISOString().slice(0, 10);
    out.push(ymd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// readRange returns array of { date, rows } for [from, to] inclusive,
// optionally filtered by accountId or sandboxId. Newest date last.
// Missing days produce NO entry (not an empty-row entry).
export async function readRange(projectRoot, { from, to, accountId, sandboxId } = {}) {
  if (!from || !to) throw new Error('readRange: from and to are required (YYYY-MM-DD)');
  const dates = _enumerateDates(from, to);

  const sandboxesRoot = path.join(projectRoot, 'data', 'sandboxes');
  let accountIds;
  if (accountId) {
    accountIds = [accountId];
  } else {
    try {
      accountIds = await fs.readdir(sandboxesRoot);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // Merge per-date across all accounts: { date → { rows: [...] } }
  const byDate = new Map();
  for (const acc of accountIds) {
    for (const ymd of dates) {
      const day = await readDay(projectRoot, acc, ymd);
      if (!day) continue;
      const rows = sandboxId
        ? day.rows.filter(r => r.sandboxId === sandboxId)
        : day.rows;
      if (!rows.length) continue;
      const entry = byDate.get(ymd) || { date: ymd, rows: [] };
      entry.rows.push(...rows);
      byDate.set(ymd, entry);
    }
  }

  return dates.flatMap(d => byDate.get(d) ? [byDate.get(d)] : []);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: PASS (17 tests total)

- [ ] **Step 5: Commit**

```bash
git add agent/cost-store.js agent/cost-store.test.mjs
git commit -m "feat(cost-store): readRange with date enumeration, account+sandbox filters"
```

---

## Task 7: `aggregateByAgent` — pure transform

**Files:**
- Modify: `agent/cost-store.js`
- Modify: `agent/cost-store.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to `agent/cost-store.test.mjs`:

```js
import { aggregateByAgent } from './cost-store.js';

test('aggregateByAgent empty input returns empty object', () => {
  assert.deepEqual(aggregateByAgent([]), {});
});

test('aggregateByAgent groups by agentId, preserves agentName + model', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'sonnet',
        phase: 'midday', cost: 1.0, input: 100, output: 50, reasoning: 0,
        cacheRead: 200, cacheWrite: 10, beatCount: 2 },
    ]},
  ];
  const agg = aggregateByAgent(rangeData);
  assert.ok(agg.default, 'agent key present');
  assert.equal(agg.default.agentName, 'Prophet');
  assert.equal(agg.default.model, 'sonnet');
  assert.ok(agg.default.dates['2026-05-28']);
  assert.equal(agg.default.dates['2026-05-28'].cost, 1.0);
  assert.equal(agg.default.dates['2026-05-28'].tokens, 100 + 50 + 200 + 10);
  assert.equal(agg.default.dates['2026-05-28'].beatCount, 2);
  assert.equal(agg.default.dates['2026-05-28'].phases.midday.cost, 1.0);
});

test('aggregateByAgent sums phases within an agent-day and across days', () => {
  const rangeData = [
    { date: '2026-05-27', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 1.0, input: 100, output: 50, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'pre_market', cost: 0.5, input: 50, output: 25, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
    ]},
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 2.0, input: 200, output: 100, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 2 },
    ]},
  ];
  const agg = aggregateByAgent(rangeData);
  assert.equal(agg.default.dates['2026-05-27'].cost, 1.5);
  assert.equal(agg.default.dates['2026-05-27'].beatCount, 2);
  assert.equal(Object.keys(agg.default.dates['2026-05-27'].phases).length, 2);
  assert.equal(agg.default.dates['2026-05-28'].cost, 2.0);
});

test('aggregateByAgent groups multiple agents separately', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 1.0, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
      { sandboxId: 'sbx2', agentId: 'penny-prophet', agentName: 'Spark', model: 'm',
        phase: 'midday', cost: 0.5, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
    ]},
  ];
  const agg = aggregateByAgent(rangeData);
  assert.deepEqual(Object.keys(agg).sort(), ['default', 'penny-prophet']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: FAIL with `aggregateByAgent is not a function`

- [ ] **Step 3: Implement `aggregateByAgent`**

Append to `agent/cost-store.js`:

```js
// aggregateByAgent — pure transform. Input is readRange output. Output:
// { agentId → { agentName, model, dates: { ymd → { cost, tokens,
//   beatCount, phases: { phase → { cost, tokens, beatCount } } } } } }.
export function aggregateByAgent(rangeData) {
  const out = {};
  for (const dayEntry of rangeData) {
    const ymd = dayEntry.date;
    for (const row of dayEntry.rows) {
      const agent = out[row.agentId] || (out[row.agentId] = {
        agentName: row.agentName, model: row.model, dates: {},
      });
      // Most recent display fields win on conflict
      agent.agentName = row.agentName;
      agent.model = row.model;

      const dayAgg = agent.dates[ymd] || (agent.dates[ymd] = {
        cost: 0, tokens: 0, beatCount: 0, phases: {},
      });
      const tokens = row.input + row.output + row.cacheRead + row.cacheWrite;
      dayAgg.cost += row.cost;
      dayAgg.tokens += tokens;
      dayAgg.beatCount += row.beatCount;

      const phaseAgg = dayAgg.phases[row.phase] || (dayAgg.phases[row.phase] = {
        cost: 0, tokens: 0, beatCount: 0,
      });
      phaseAgg.cost += row.cost;
      phaseAgg.tokens += tokens;
      phaseAgg.beatCount += row.beatCount;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- agent/cost-store.test.mjs`
Expected: PASS (21 tests total)

- [ ] **Step 5: Commit**

```bash
git add agent/cost-store.js agent/cost-store.test.mjs
git commit -m "feat(cost-store): aggregateByAgent pure transform"
```

---

## Task 8: `cost-report-writer.js` — markdown rendering + notable shifts

**Files:**
- Create: `agent/cost-report-writer.js`
- Create: `agent/cost-report-writer.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `agent/cost-report-writer.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePerAgentSummary,
  computeNotableShifts,
  renderDailyReportMarkdown,
} from './cost-report-writer.js';

const fixtureAgg = {
  default: {
    agentName: 'Prophet', model: 'sonnet',
    dates: {
      '2026-05-22': { cost: 4.50, tokens: 500000, beatCount: 100,
        phases: { midday: { cost: 2.0, tokens: 250000, beatCount: 50 },
                  pre_market: { cost: 0.7, tokens: 60000, beatCount: 12 } } },
      '2026-05-23': { cost: 4.20, tokens: 480000, beatCount: 95,
        phases: { midday: { cost: 1.9, tokens: 240000, beatCount: 48 } } },
      '2026-05-28': { cost: 3.18, tokens: 412000, beatCount: 95,
        phases: { midday: { cost: 1.34, tokens: 180000, beatCount: 42 },
                  pre_market: { cost: 0.42, tokens: 38000, beatCount: 12 } } },
    },
  },
};

test('computePerAgentSummary derives today, 7d avg, delta %', () => {
  const summary = computePerAgentSummary(fixtureAgg, '2026-05-28');
  const prophet = summary.find(s => s.agentId === 'default');
  assert.equal(prophet.today.cost, 3.18);
  assert.equal(prophet.today.beatCount, 95);
  // 7-day basis includes 2026-05-22..2026-05-27. Only 22, 23 have data;
  // missing days count as 0 toward the average over 7 days.
  // Sum = 4.50 + 4.20 = 8.70; avg = 8.70 / 7 ≈ 1.2429
  assert.ok(Math.abs(prophet.sevenDayAvg.cost - (8.70 / 7)) < 0.001);
  // delta = (3.18 - 1.2429) / 1.2429 * 100 ≈ 156%
  assert.ok(prophet.delta.costPct > 100);
});

test('computePerAgentSummary delta is null when basis is zero', () => {
  const noHistory = {
    default: { agentName: 'Prophet', model: 'm', dates: {
      '2026-05-28': { cost: 1.0, tokens: 0, beatCount: 1, phases: {} },
    }},
  };
  const summary = computePerAgentSummary(noHistory, '2026-05-28');
  assert.equal(summary[0].delta.costPct, null);
});

test('computeNotableShifts flags phases with |delta| >= threshold', () => {
  const shifts = computeNotableShifts(fixtureAgg, '2026-05-28', { thresholdPct: 15 });
  // Prophet midday today $1.34 vs 7-day-avg (sum 2.0 + 1.9 = 3.9 over 7 days)
  // = $0.557. delta = (1.34 - 0.557) / 0.557 = +140%. Should flag.
  assert.ok(shifts.some(s => s.agentId === 'default' && s.phase === 'midday'));
});

test('renderDailyReportMarkdown produces sections with table + notable shifts', () => {
  const md = renderDailyReportMarkdown(fixtureAgg, '2026-05-28', { thresholdPct: 15 });
  assert.match(md, /# Daily Cost Report — 2026-05-28/);
  assert.match(md, /## Per-agent totals/);
  assert.match(md, /\| Prophet \|/);
  assert.match(md, /\| \*\*TOTAL\*\* \|/);
  assert.match(md, /## Notable shifts/);
  assert.match(md, /## Per-phase × per-agent breakdown/);
});

test('renderDailyReportMarkdown emits explanatory placeholder when no shifts found', () => {
  const flat = {
    default: { agentName: 'Prophet', model: 'm', dates: {
      '2026-05-28': { cost: 1.0, tokens: 0, beatCount: 1,
        phases: { midday: { cost: 1.0, tokens: 0, beatCount: 1 } } },
    }},
  };
  const md = renderDailyReportMarkdown(flat, '2026-05-28', { thresholdPct: 15 });
  assert.match(md, /No shifts above the .* threshold/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- agent/cost-report-writer.test.mjs`
Expected: FAIL with `Cannot find module './cost-report-writer.js'`

- [ ] **Step 3: Implement the writer**

Create `agent/cost-report-writer.js`:

```js
// cost-report-writer: pure markdown rendering for the daily cost report
// (data/reports/cost_YYYY-MM-DD.md) and the --format markdown CLI output.
// All inputs are aggregateByAgent() output; no I/O lives here.

const DEFAULT_THRESHOLD_PCT = 15;

// daysBefore returns YYYY-MM-DD strings for the N calendar days strictly
// before `today` (today excluded). Newest last.
function daysBefore(today, n) {
  const out = [];
  const d = new Date(`${today}T00:00:00Z`);
  for (let i = n; i >= 1; i--) {
    const c = new Date(d);
    c.setUTCDate(c.getUTCDate() - i);
    out.push(c.toISOString().slice(0, 10));
  }
  return out;
}

function pctDelta(today, basis) {
  if (!basis || basis === 0) return null;
  return Math.round(((today - basis) / basis) * 100);
}

// computePerAgentSummary — for each agent in `agg`, returns
// { agentId, agentName, model, today: {cost, tokens, beatCount},
//   sevenDayAvg: {cost, tokens}, delta: {costPct, tokensPct} }.
// Missing days within the 7-day window count as 0.
export function computePerAgentSummary(agg, today) {
  const window = daysBefore(today, 7);
  const out = [];
  for (const [agentId, info] of Object.entries(agg)) {
    const todayCell = info.dates[today] || { cost: 0, tokens: 0, beatCount: 0 };
    const basisCells = window.map(d => info.dates[d] || { cost: 0, tokens: 0 });
    const basisCost = basisCells.reduce((s, c) => s + c.cost, 0) / 7;
    const basisTokens = basisCells.reduce((s, c) => s + c.tokens, 0) / 7;
    out.push({
      agentId,
      agentName: info.agentName,
      model: info.model,
      today: { cost: todayCell.cost, tokens: todayCell.tokens, beatCount: todayCell.beatCount },
      sevenDayAvg: { cost: basisCost, tokens: basisTokens },
      delta: { costPct: pctDelta(todayCell.cost, basisCost), tokensPct: pctDelta(todayCell.tokens, basisTokens) },
    });
  }
  return out;
}

// computeNotableShifts — finds (agent, phase) cells where today's cost
// has shifted |delta| >= thresholdPct vs 7-day-avg. Returns sorted by
// |delta| descending.
export function computeNotableShifts(agg, today, { thresholdPct = DEFAULT_THRESHOLD_PCT } = {}) {
  const window = daysBefore(today, 7);
  const shifts = [];
  for (const [agentId, info] of Object.entries(agg)) {
    const todayCell = info.dates[today];
    if (!todayCell) continue;
    const allPhases = new Set();
    for (const d of [today, ...window]) {
      const cell = info.dates[d];
      if (cell) for (const p of Object.keys(cell.phases)) allPhases.add(p);
    }
    for (const phase of allPhases) {
      const todayCost = (todayCell.phases[phase] || { cost: 0 }).cost;
      const basis = window.map(d => {
        const c = info.dates[d];
        return c && c.phases[phase] ? c.phases[phase].cost : 0;
      }).reduce((s, x) => s + x, 0) / 7;
      const delta = pctDelta(todayCost, basis);
      if (delta === null) continue;
      if (Math.abs(delta) >= thresholdPct) {
        shifts.push({ agentId, agentName: info.agentName, phase, todayCost, basis, deltaPct: delta });
      }
    }
  }
  shifts.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  return shifts;
}

function fmtMoney(n) { return `$${(n || 0).toFixed(2)}`; }
function fmtDelta(p) { return p === null ? '—' : (p >= 0 ? `+${p}%` : `−${Math.abs(p)}%`); }

export function renderDailyReportMarkdown(agg, today, { thresholdPct = DEFAULT_THRESHOLD_PCT } = {}) {
  const summary = computePerAgentSummary(agg, today)
    .sort((a, b) => b.today.cost - a.today.cost);
  const shifts = computeNotableShifts(agg, today, { thresholdPct });

  const totalToday = summary.reduce((s, x) => s + x.today.cost, 0);
  const totalBasis = summary.reduce((s, x) => s + x.sevenDayAvg.cost, 0);
  const totalDelta = pctDelta(totalToday, totalBasis);
  const totalBeats = summary.reduce((s, x) => s + x.today.beatCount, 0);

  let md = `# Daily Cost Report — ${today}\n\n`;
  md += `## Per-agent totals\n\n`;
  md += `| Agent | Today | 7d avg | Δ | Beats |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const s of summary) {
    md += `| ${s.agentName} | ${fmtMoney(s.today.cost)} | ${fmtMoney(s.sevenDayAvg.cost)} | ${fmtDelta(s.delta.costPct)} | ${s.today.beatCount} |\n`;
  }
  md += `| **TOTAL** | ${fmtMoney(totalToday)} | ${fmtMoney(totalBasis)} | ${fmtDelta(totalDelta)} | ${totalBeats} |\n\n`;

  md += `## Notable shifts (|Δ| ≥ ${thresholdPct}% vs 7-day avg)\n\n`;
  if (!shifts.length) {
    md += `No shifts above the ${thresholdPct}% threshold today.\n\n`;
  } else {
    for (const sh of shifts) {
      md += `- ${sh.agentName} ${sh.phase}: ${fmtDelta(sh.deltaPct)} (today ${fmtMoney(sh.todayCost)}, 7d avg ${fmtMoney(sh.basis)})\n`;
    }
    md += `\n`;
  }

  md += `## Per-phase × per-agent breakdown\n\n`;
  md += `| Agent | Phase | Cost | Beats |\n|---|---|---|---|\n`;
  for (const [agentId, info] of Object.entries(agg)) {
    const cell = info.dates[today];
    if (!cell) continue;
    for (const [phase, p] of Object.entries(cell.phases)) {
      md += `| ${info.agentName} | ${phase} | ${fmtMoney(p.cost)} | ${p.beatCount} |\n`;
    }
  }
  md += `\n`;
  return md;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- agent/cost-report-writer.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add agent/cost-report-writer.js agent/cost-report-writer.test.mjs
git commit -m "feat(cost-report-writer): markdown report + notable-shifts detector"
```

---

## Task 9: Harness wiring — add `reasoning` accumulator + soft-fail `recordBeat` call

**Files:**
- Modify: `agent/harness.js`

This task is integration-only and does not introduce a new function. The test is a manual smoke (full agent run), so no `.test.mjs` file is added; verification happens at the live-checklist step in Rollout.

- [ ] **Step 1: Add `reasoning` to the `tok` accumulator**

In `agent/harness.js` around line 1234, change:

```js
const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
```

to:

```js
const tok = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
```

And in the `addTokenDelta` closure around line 1242-1244, change:

```js
addTokenDelta: (d) => {
  tok.input += d.input; tok.output += d.output;
  tok.cacheRead += d.cacheRead; tok.cacheWrite += d.cacheWrite;
},
```

to:

```js
addTokenDelta: (d) => {
  tok.input += d.input; tok.output += d.output; tok.reasoning += d.reasoning;
  tok.cacheRead += d.cacheRead; tok.cacheWrite += d.cacheWrite;
},
```

- [ ] **Step 2: Import `recordBeat` at top of `agent/harness.js`**

Find the existing line:

```js
import { extractTokenDelta, formatBeatCostLine } from './beat-cost.js';
```

Add immediately below:

```js
import { recordBeat as recordCostBeat } from './cost-store.js';
```

- [ ] **Step 3: Add the guarded fire-and-forget `recordBeat` call after the existing cost log emit**

Around line 1289-1297, the current block reads:

```js
const tokenTotal = tok.input + tok.output + tok.cacheRead + tok.cacheWrite;
if (totalCost > 0 || tokenTotal > 0) {
  this.state.emit('agent_log', {
    message: formatBeatCostLine({
      cost: totalCost, input: tok.input, output: tok.output,
      cacheRead: tok.cacheRead, cacheWrite: tok.cacheWrite,
    }),
    level: 'info',
  });
}
```

Replace with:

```js
const tokenTotal = tok.input + tok.output + tok.cacheRead + tok.cacheWrite;
if (totalCost > 0 || tokenTotal > 0) {
  this.state.emit('agent_log', {
    message: formatBeatCostLine({
      cost: totalCost, input: tok.input, output: tok.output,
      cacheRead: tok.cacheRead, cacheWrite: tok.cacheWrite,
    }),
    level: 'info',
  });

  // Persist for daily rollup. Fire-and-forget — cost tracking is
  // observability and must never block beat completion. Soft-fail
  // via .catch; matches the existing fs.unlink fire-and-forget pattern
  // above. Default ON; COST_TRACKING_ENABLED=false disables.
  if (process.env.COST_TRACKING_ENABLED !== 'false') {
    const beatStartAt = this.state.lastBeatTime instanceof Date
      ? this.state.lastBeatTime.toISOString()
      : new Date(this.state.lastBeatTime || Date.now()).toISOString();
    recordCostBeat(this.projectRoot, {
      accountId: this.state.activeAccountId || this.accountId || '',
      sandboxId: this.sandboxId || '',
      agentId: this._agentConfig?.id || '',
      agentName: this._agentConfig?.name || '',
      model: ocModel,
      phase: this.getCurrentPhaseFn ? this.getCurrentPhaseFn() : 'unknown',
      cost: totalCost,
      input: tok.input, output: tok.output, reasoning: tok.reasoning,
      cacheRead: tok.cacheRead, cacheWrite: tok.cacheWrite,
      beatStartAt,
    }).catch(err => {
      this.state.emit('agent_log', {
        message: `cost-store write failed: ${err.message}`,
        level: 'warn',
      });
    });
  }
}
```

Note: `ocModel` is defined earlier at line ~1151 (`const ocModel = model?.includes('/') ? model : ...`) and is in scope at the exit-handler. `this.projectRoot` must exist on the harness — verify before this step. If it does not, use `process.cwd()` as the fallback (the rest of `harness.js` uses `process.cwd()` for `cwd` of spawn at line 1202).

- [ ] **Step 4: Verify the existing test suite still passes (no regressions)**

Run: `npm test`
Expected: All existing tests PASS (no new tests added in this task; cost-store tests from previous tasks still pass).

- [ ] **Step 5: Commit**

```bash
git add agent/harness.js
git commit -m "feat(harness): persist per-beat cost via cost-store (default ON, soft-fail)"
```

---

## Task 10: HTTP endpoint — `GET /api/v1/costs?days=N`

**Files:**
- Modify: `agent/server.js`
- Create: `agent/server-costs.test.mjs` (focused endpoint test that loads only the endpoint factory, not the full server)

Strategy: rather than fixture-loading the entire Express/HTTP server, extract a small pure handler function `buildCostsResponse(rangeData, days, today)` and unit-test it. The endpoint wiring in `server.js` is a thin wrapper around it.

- [ ] **Step 1: Write the failing test**

Create `agent/server-costs.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCostsResponse } from './cost-store.js';

test('buildCostsResponse shape: from/to/agents/totals', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 3.18, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 95 },
    ]},
  ];
  const res = buildCostsResponse(rangeData, 7, '2026-05-28');
  assert.equal(res.from, '2026-05-22');
  assert.equal(res.to, '2026-05-28');
  assert.equal(res.agents.length, 1);
  assert.equal(res.agents[0].agentId, 'default');
  assert.equal(res.agents[0].today.cost, 3.18);
  assert.equal(res.agents[0].sparkline.length, 7, 'sparkline length matches days');
  assert.equal(res.agents[0].sparkline[6], 3.18, 'last sparkline entry is today');
  assert.equal(res.agents[0].sparkline[0], 0, 'missing pre-history day is 0');
  assert.ok(res.totals.today.cost > 0);
});

test('buildCostsResponse delta is null when 7d avg is 0', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 1.0, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
    ]},
  ];
  const res = buildCostsResponse(rangeData, 7, '2026-05-28');
  assert.equal(res.agents[0].delta.costPct, null);
});

test('buildCostsResponse phasesToday has all phases with cost > 0 today', () => {
  const rangeData = [
    { date: '2026-05-28', rows: [
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'midday', cost: 1.0, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
      { sandboxId: 'sbx1', agentId: 'default', agentName: 'Prophet', model: 'm',
        phase: 'pre_market', cost: 0.5, input: 0, output: 0, reasoning: 0,
        cacheRead: 0, cacheWrite: 0, beatCount: 1 },
    ]},
  ];
  const res = buildCostsResponse(rangeData, 7, '2026-05-28');
  assert.deepEqual(
    new Set(Object.keys(res.agents[0].phasesToday)),
    new Set(['midday', 'pre_market']),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent/server-costs.test.mjs`
Expected: FAIL with `buildCostsResponse is not exported`

- [ ] **Step 3: Implement `buildCostsResponse` in `cost-store.js`**

Append to `agent/cost-store.js`:

```js
// buildCostsResponse — produces the HTTP endpoint's payload from
// readRange() output. `today` is the YYYY-MM-DD anchor for "today";
// the response spans `days` days ending at `today`.
export function buildCostsResponse(rangeData, days, today) {
  const agg = aggregateByAgent(rangeData);
  const dates = [];
  {
    const d = new Date(`${today}T00:00:00Z`);
    for (let i = days - 1; i >= 0; i--) {
      const c = new Date(d);
      c.setUTCDate(c.getUTCDate() - i);
      dates.push(c.toISOString().slice(0, 10));
    }
  }
  const from = dates[0];
  const to = dates[dates.length - 1];

  const pctDelta = (n, basis) => (!basis || basis === 0) ? null : Math.round(((n - basis) / basis) * 100);

  const agents = [];
  for (const [agentId, info] of Object.entries(agg)) {
    const sparkline = dates.map(d => info.dates[d] ? info.dates[d].cost : 0);
    const todayCell = info.dates[today] || { cost: 0, tokens: 0, beatCount: 0, phases: {} };
    const basisDates = dates.slice(0, -1); // exclude today
    const basisCost = basisDates.reduce((s, d) => s + (info.dates[d] ? info.dates[d].cost : 0), 0) / Math.max(basisDates.length, 1);
    const basisTokens = basisDates.reduce((s, d) => s + (info.dates[d] ? info.dates[d].tokens : 0), 0) / Math.max(basisDates.length, 1);
    const phasesToday = {};
    for (const [phase, p] of Object.entries(todayCell.phases)) {
      const phaseBasis = basisDates.reduce((s, d) => {
        const c = info.dates[d];
        return s + (c && c.phases[phase] ? c.phases[phase].cost : 0);
      }, 0) / Math.max(basisDates.length, 1);
      phasesToday[phase] = {
        cost: p.cost, beatCount: p.beatCount,
        deltaPct: pctDelta(p.cost, phaseBasis),
      };
    }
    agents.push({
      agentId, agentName: info.agentName, model: info.model,
      today: { cost: todayCell.cost, tokens: todayCell.tokens, beatCount: todayCell.beatCount },
      sevenDayAvg: { cost: basisCost, tokens: basisTokens },
      delta: { costPct: pctDelta(todayCell.cost, basisCost), tokensPct: pctDelta(todayCell.tokens, basisTokens) },
      sparkline,
      phasesToday,
    });
  }
  agents.sort((a, b) => b.today.cost - a.today.cost);

  const totalsToday = agents.reduce((s, a) => s + a.today.cost, 0);
  const totalsBasis = agents.reduce((s, a) => s + a.sevenDayAvg.cost, 0);
  const totalsTokensToday = agents.reduce((s, a) => s + a.today.tokens, 0);

  return {
    from, to,
    agents,
    totals: {
      today: { cost: totalsToday, tokens: totalsTokensToday },
      sevenDayAvg: { cost: totalsBasis },
      delta: { costPct: pctDelta(totalsToday, totalsBasis) },
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- agent/server-costs.test.mjs agent/cost-store.test.mjs`
Expected: PASS (24 tests total across the two files)

- [ ] **Step 5: Wire the endpoint into `agent/server.js`**

Locate the existing `/api/v1/...` route definitions in `agent/server.js` (search for `app.get('/api/v1/` to find the pattern). Add this new endpoint near the others:

```js
import { readRange, buildCostsResponse, _etDate as _etDateCS } from './cost-store.js';

// GET /api/v1/costs?days=N — returns aggregated per-agent cost data.
// Returns 404 when COST_TRACKING_ENABLED=false. Default days=7, max 90.
app.get('/api/v1/costs', async (req, res) => {
  if (process.env.COST_TRACKING_ENABLED === 'false') {
    return res.status(404).json({ error: 'cost tracking disabled' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const today = _etDateCS(new Date());
  const fromDate = new Date(`${today}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  const from = fromDate.toISOString().slice(0, 10);
  try {
    const rangeData = await readRange(process.cwd(), { from, to: today });
    res.json(buildCostsResponse(rangeData, days, today));
  } catch (err) {
    res.status(500).json({ error: `cost endpoint failed: ${err.message}` });
  }
});
```

If `agent/server.js` does not already import from `cost-store.js`, add the import at the top with the other imports. If the file imports differently (e.g., CommonJS `require`), adapt accordingly — match the existing pattern in that file.

- [ ] **Step 6: Smoke-test the endpoint manually**

Start the agent server (`npm run agent`) in one terminal, then in another:

```bash
curl -s http://localhost:3000/api/v1/costs?days=7 | head
```

Expected (with no data yet): `{"from":"…","to":"…","agents":[],"totals":{…}}`. With `COST_TRACKING_ENABLED=false`: a 404.

If `localhost:3000` is wrong, the actual port lives in `agent/server.js`; adjust.

- [ ] **Step 7: Commit**

```bash
git add agent/cost-store.js agent/server.js agent/server-costs.test.mjs
git commit -m "feat(server): GET /api/v1/costs endpoint with buildCostsResponse helper"
```

---

## Task 11: Dashboard Costs tab — HTML scaffold + render JS

**Files:**
- Modify: `agent/public/index.html`

This task is UI-only and has no automated test; the verification is opening the tab in the browser. Keep the JS small enough to read inline.

- [ ] **Step 1: Add the tab button**

In `agent/public/index.html` around line 1147, the current tab row is:

```html
<button class="tab" data-tab="trades" onclick="switchTab('trades')">Trades</button>
<button class="tab" data-tab="history" onclick="switchTab('history')">History</button>
```

Insert immediately after the History tab:

```html
<button class="tab" data-tab="costs" onclick="switchTab('costs')">Costs</button>
```

- [ ] **Step 2: Add the tab body**

Locate where other tab bodies live (search for `<div id="tab-trades"` or `<div id="tab-history"`). Add a new tab body next to them:

```html
<div id="tab-costs" class="tab-content" style="display:none;">
  <div style="display:flex; gap:8px; margin-bottom:10px; align-items:center;">
    <button class="costs-range-btn" data-range="7" onclick="setCostsRange(7)">Last 7d</button>
    <button class="costs-range-btn" data-range="30" onclick="setCostsRange(30)">30d</button>
    <button class="costs-range-btn" data-range="90" onclick="setCostsRange(90)">90d</button>
    <span id="costs-anchor-date" style="margin-left:auto; opacity:0.7;"></span>
  </div>
  <div id="costs-tab-body"><div style="padding:24px; opacity:0.6;">Loading…</div></div>
</div>
```

- [ ] **Step 3: Add the render JS**

In the `<script>` block near the bottom of `index.html` where other tab render functions live, add:

```js
const COSTS_SPARKLINE_CHARS = ['▁','▂','▃','▄','▅','▆','▇','█'];
let costsCurrentRange = 7;

function sparkline(values) {
  const max = Math.max(...values, 0.0001);
  return values.map(v => {
    const idx = Math.min(
      Math.floor((v / max) * COSTS_SPARKLINE_CHARS.length),
      COSTS_SPARKLINE_CHARS.length - 1
    );
    return COSTS_SPARKLINE_CHARS[v === 0 ? 0 : idx];
  }).join('');
}

function fmtMoneyJs(n) { return `$${(n || 0).toFixed(2)}`; }
function fmtDeltaJs(p) {
  if (p === null || p === undefined) return '—';
  if (p === 0) return '0%';
  return p > 0 ? `+${p}%` : `−${Math.abs(p)}%`;
}
function deltaColor(p) {
  if (p === null || p === undefined || Math.abs(p) < 5) return '';
  return p < 0 ? 'color:#7dd87d;' : 'color:#e89090;';
}

async function renderCostsTab() {
  const body = document.getElementById('costs-tab-body');
  if (!body) return;
  body.innerHTML = '<div style="padding:24px; opacity:0.6;">Loading…</div>';

  let res;
  try {
    res = await fetch(`/api/v1/costs?days=${costsCurrentRange}`);
  } catch {
    body.innerHTML = '<div style="padding:24px;">Cost data unavailable. <button onclick="renderCostsTab()">Retry</button></div>';
    return;
  }
  if (res.status === 404) {
    body.innerHTML = '<div style="padding:24px;">Cost tracking is disabled — set <code>COST_TRACKING_ENABLED=true</code> and restart to enable.</div>';
    return;
  }
  if (!res.ok) {
    body.innerHTML = `<div style="padding:24px;">Cost data unavailable (HTTP ${res.status}). <button onclick="renderCostsTab()">Retry</button></div>`;
    return;
  }
  const data = await res.json();

  document.getElementById('costs-anchor-date').textContent = data.to;

  if (!data.agents.length) {
    body.innerHTML = '<div style="padding:24px; opacity:0.6;">No cost data yet — collecting from now forward.</div>';
    return;
  }

  let html = `
    <table style="width:100%; border-collapse:collapse;">
      <thead>
        <tr style="text-align:left; opacity:0.6; font-size:11px; text-transform:uppercase;">
          <th style="padding:6px 8px;">Agent</th>
          <th style="padding:6px 8px; text-align:right;">Today</th>
          <th style="padding:6px 8px; text-align:right;">7d avg</th>
          <th style="padding:6px 8px; text-align:right;">Δ</th>
          <th style="padding:6px 8px;">Last ${costsCurrentRange}d</th>
        </tr>
      </thead>
      <tbody>
  `;
  for (const a of data.agents) {
    html += `
      <tr style="border-top:1px solid rgba(255,255,255,0.08); cursor:pointer;" onclick="toggleCostsPhases('${a.agentId}')">
        <td style="padding:6px 8px;"><b>${a.agentName}</b><br/><span style="opacity:0.5; font-size:10px;">${a.model || ''}</span></td>
        <td style="padding:6px 8px; text-align:right;">${fmtMoneyJs(a.today.cost)}</td>
        <td style="padding:6px 8px; text-align:right;">${fmtMoneyJs(a.sevenDayAvg.cost)}</td>
        <td style="padding:6px 8px; text-align:right; ${deltaColor(a.delta.costPct)}">${fmtDeltaJs(a.delta.costPct)}</td>
        <td style="padding:6px 8px; font-family: ui-monospace, Menlo, Consolas, monospace;">${sparkline(a.sparkline)}</td>
      </tr>
      <tr id="costs-phases-${a.agentId}" style="display:none;">
        <td colspan="5" style="padding:8px 12px; background:rgba(255,255,255,0.04);">
          <div style="opacity:0.5; font-size:10px; text-transform:uppercase; margin-bottom:6px;">▾ ${a.agentName} — today's phase breakdown</div>
          <table style="width:100%; font-size:12px;">
            ${Object.entries(a.phasesToday).map(([phase, p]) => `
              <tr style="opacity:0.85;">
                <td>${phase}</td>
                <td style="text-align:right;">${fmtMoneyJs(p.cost)}</td>
                <td style="text-align:right;">${p.beatCount} beats</td>
                <td style="text-align:right; ${deltaColor(p.deltaPct)}">${fmtDeltaJs(p.deltaPct)}</td>
              </tr>
            `).join('')}
          </table>
        </td>
      </tr>
    `;
  }
  html += `
        <tr style="border-top:2px solid rgba(255,255,255,0.2); font-weight:bold;">
          <td style="padding:8px;">TOTAL</td>
          <td style="padding:8px; text-align:right;">${fmtMoneyJs(data.totals.today.cost)}</td>
          <td style="padding:8px; text-align:right;">${fmtMoneyJs(data.totals.sevenDayAvg.cost)}</td>
          <td style="padding:8px; text-align:right; ${deltaColor(data.totals.delta.costPct)}">${fmtDeltaJs(data.totals.delta.costPct)}</td>
          <td>&nbsp;</td>
        </tr>
      </tbody>
    </table>
  `;
  body.innerHTML = html;
}

function toggleCostsPhases(agentId) {
  const row = document.getElementById(`costs-phases-${agentId}`);
  if (row) row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
}

function setCostsRange(days) {
  costsCurrentRange = days;
  renderCostsTab();
}
```

- [ ] **Step 4: Hook the tab activation**

Find the existing `switchTab(name)` function in the same `<script>` block. After the existing logic that hides/shows tab bodies, add:

```js
if (name === 'costs') renderCostsTab();
```

(If `switchTab` uses a different idiom — a switch statement, a per-tab callback map — fit the call into the existing pattern. The intent is: render runs every time the user lands on the Costs tab.)

- [ ] **Step 5: Smoke-test in the browser**

1. Start the agent server (`npm run agent`).
2. Open the dashboard in a browser at the configured port.
3. Click the new Costs tab. Expected (no data yet): "No cost data yet — collecting from now forward."
4. With `COST_TRACKING_ENABLED=false` and a restart: the tab shows the "Cost tracking is disabled — set …" message.
5. Click the range buttons (7d/30d/90d): no errors in the console.

- [ ] **Step 6: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(dashboard): Costs tab with agent-row table + sparkline + phase drilldown"
```

---

## Task 12: Daily report — `analysis-scheduler.js` post-close hook

**Files:**
- Modify: `agent/analysis-scheduler.js`
- Create: `agent/analysis-scheduler-costs.test.mjs` (focused: invokes the new helper directly, not the full scheduler loop)

Strategy: extract the report-writing as a small helper inside (or imported into) `analysis-scheduler.js`. Unit-test the helper. Then wire the helper into whichever scheduled callback in `analysis-scheduler.js` fires after market close.

- [ ] **Step 1: Read `analysis-scheduler.js` to find the post-close scheduling pattern**

Run: `grep -n "schedule\|cron\|after_hours\|market_close\|setTimeout\|setInterval" agent/analysis-scheduler.js | head -30`

Locate the spot where post-close-triggered tasks are scheduled. Pattern-match against an existing post-close task if one exists.

- [ ] **Step 2: Write the failing test**

Create `agent/analysis-scheduler-costs.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeDailyCostReport } from './analysis-scheduler.js';
import { recordBeat } from './cost-store.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('writeDailyCostReport produces data/reports/cost_{date}.md from seeded data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cost-report-test-'));
  try {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'default',
      agentName: 'Prophet', model: 'sonnet', phase: 'midday',
      cost: 3.18, input: 100000, output: 50000, reasoning: 0,
      cacheRead: 200000, cacheWrite: 5000,
      beatStartAt: '2026-05-28T18:00:00.000Z',
    });
    await writeDailyCostReport(root, '2026-05-28');
    const md = await readFile(path.join(root, 'data', 'reports', 'cost_2026-05-28.md'), 'utf-8');
    assert.match(md, /Daily Cost Report — 2026-05-28/);
    assert.match(md, /Prophet/);
    assert.match(md, /\$3\.18/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeDailyCostReport still writes file when there is no data (empty totals)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cost-report-test-empty-'));
  try {
    await writeDailyCostReport(root, '2026-05-28');
    const md = await readFile(path.join(root, 'data', 'reports', 'cost_2026-05-28.md'), 'utf-8');
    assert.match(md, /Daily Cost Report — 2026-05-28/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- agent/analysis-scheduler-costs.test.mjs`
Expected: FAIL with `writeDailyCostReport is not exported`

- [ ] **Step 4: Implement and export `writeDailyCostReport`**

Add to `agent/analysis-scheduler.js` (near other helpers, or at the top after existing imports):

```js
import fs from 'node:fs/promises';
import path from 'node:path';
import { readRange, aggregateByAgent, _etDate as _etDateCS } from './cost-store.js';
import { renderDailyReportMarkdown } from './cost-report-writer.js';

// writeDailyCostReport renders the daily markdown report and writes it to
// data/reports/cost_{date}.md. Pure helper that does the I/O; the
// scheduling decision (when to fire it) is in startCostReportScheduler.
export async function writeDailyCostReport(projectRoot, date) {
  // 7-day window ending on `date` (inclusive). aggregateByAgent +
  // renderDailyReportMarkdown derive the today vs 7d-avg basis.
  const fromDate = new Date(`${date}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 7);
  const from = fromDate.toISOString().slice(0, 10);
  const rangeData = await readRange(projectRoot, { from, to: date });
  const agg = aggregateByAgent(rangeData);
  const md = renderDailyReportMarkdown(agg, date);
  const reportsDir = path.join(projectRoot, 'data', 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.join(reportsDir, `cost_${date}.md`), md, 'utf-8');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- agent/analysis-scheduler-costs.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 6: Wire the post-close trigger**

In `agent/analysis-scheduler.js`, locate the scheduling block from Step 1. Add a hook so `writeDailyCostReport(process.cwd(), todayEt)` fires once per ET trading day at ~16:30 ET. The exact wiring depends on the existing patterns:

- **If the file uses cron-style scheduling**: add a `0 30 16 * * 1-5` entry that calls `writeDailyCostReport`.
- **If the file uses a polling loop checking time**: add a guard `if (phase === 'after_hours' && et.minute === 30 && !writtenToday)` and call.
- **If the file uses a setTimeout-until-time pattern**: schedule a 16:30 ET timer that fires the function and reschedules for the next day.

Wrap the call in:

```js
if (process.env.COST_TRACKING_ENABLED !== 'false') {
  try {
    await writeDailyCostReport(process.cwd(), _etDateCS(new Date()));
  } catch (err) {
    console.warn(`cost daily report write failed: ${err.message}`);
  }
}
```

Where `_etDateCS` is imported from `./cost-store.js` as in Task 10.

- [ ] **Step 7: Verify the full test suite passes**

Run: `npm test`
Expected: ALL tests pass.

- [ ] **Step 8: Commit**

```bash
git add agent/analysis-scheduler.js agent/analysis-scheduler-costs.test.mjs
git commit -m "feat(scheduler): post-close hook writes data/reports/cost_{date}.md"
```

---

## Task 13: CLI shim — `scripts/cost-report.mjs`

**Files:**
- Create: `scripts/cost-report.mjs`
- Create: `scripts/cost-report.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/cost-report.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordBeat } from '../agent/cost-store.js';

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath,
      ['scripts/cost-report.mjs', ...args],
      { env: { ...process.env, ...env } }
    );
    let out = '', err = '';
    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { err += c; });
    proc.on('exit', code => resolve({ code, out, err }));
    proc.on('error', reject);
  });
}

test('cost-report.mjs --format json emits valid JSON', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cost-cli-test-'));
  try {
    await recordBeat(root, {
      accountId: 'acc1', sandboxId: 'sbx1', agentId: 'default',
      agentName: 'Prophet', model: 'sonnet', phase: 'midday',
      cost: 1.0, input: 100, output: 50, reasoning: 0,
      cacheRead: 200, cacheWrite: 10,
      beatStartAt: new Date().toISOString(),
    });
    const { code, out } = await runCli(['--days', '7', '--format', 'json'],
      { COST_REPORT_PROJECT_ROOT: root });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.ok(parsed.agents);
    assert.ok(parsed.from);
    assert.ok(parsed.to);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cost-report.mjs --format markdown emits a markdown header', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cost-cli-md-test-'));
  try {
    const { code, out } = await runCli(['--days', '7', '--format', 'markdown'],
      { COST_REPORT_PROJECT_ROOT: root });
    assert.equal(code, 0);
    assert.match(out, /# Daily Cost Report/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scripts/cost-report.test.mjs`
Expected: FAIL with cannot spawn / file not found.

- [ ] **Step 3: Implement the CLI**

Create `scripts/cost-report.mjs`:

```js
#!/usr/bin/env node
// CLI shim: skill access path for per-agent daily cost data.
// Imports cost-store directly — no HTTP/server dependency.
import { readRange, buildCostsResponse, _etDate, aggregateByAgent } from '../agent/cost-store.js';
import { renderDailyReportMarkdown } from '../agent/cost-report-writer.js';

function parseArgs(argv) {
  const args = { days: 7, format: 'json', agent: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') args.days = parseInt(argv[++i], 10);
    else if (a === '--format') args.format = argv[++i];
    else if (a === '--agent') args.agent = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `Usage: cost-report.mjs [--days N] [--format json|markdown] [--agent <agentId>]

Reads data/sandboxes/*/costs/ rollup files and emits an aggregated report.
Default --days 7, --format json. --agent filters output to one agent.
Project root is auto-detected; override with COST_REPORT_PROJECT_ROOT.`;

const args = parseArgs(process.argv);
if (args.help) { console.log(HELP); process.exit(0); }
if (!['json', 'markdown'].includes(args.format)) {
  console.error(`unknown --format: ${args.format}`);
  process.exit(2);
}

const projectRoot = process.env.COST_REPORT_PROJECT_ROOT || process.cwd();
const today = _etDate(new Date());
const fromDate = new Date(`${today}T00:00:00Z`);
fromDate.setUTCDate(fromDate.getUTCDate() - (args.days - 1));
const from = fromDate.toISOString().slice(0, 10);

const rangeData = await readRange(projectRoot, { from, to: today });

if (args.format === 'json') {
  const payload = buildCostsResponse(rangeData, args.days, today);
  if (args.agent) payload.agents = payload.agents.filter(a => a.agentId === args.agent);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  const agg = aggregateByAgent(rangeData);
  if (args.agent) {
    for (const k of Object.keys(agg)) if (k !== args.agent) delete agg[k];
  }
  process.stdout.write(renderDailyReportMarkdown(agg, today));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- scripts/cost-report.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Smoke the CLI manually**

```bash
node scripts/cost-report.mjs --help
node scripts/cost-report.mjs --days 7 --format markdown
```

Expected: help text on first; an empty-data markdown report on second (no data yet).

- [ ] **Step 6: Commit**

```bash
git add scripts/cost-report.mjs scripts/cost-report.test.mjs
git commit -m "feat(scripts): cost-report.mjs CLI shim (--days, --format, --agent)"
```

---

## Final verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: All tests PASS, including any pre-existing tests.

- [ ] **Step 2: Smoke the full feature locally**

1. Restart the agent server.
2. Let at least one beat with cost > 0 fire.
3. Verify the per-day file exists:
   ```bash
   ls data/sandboxes/*/costs/
   ```
4. Open the dashboard → click the Costs tab → confirm the agent appears with a today value.
5. Manually invoke the daily-report writer:
   ```bash
   node -e "import('./agent/analysis-scheduler.js').then(m => m.writeDailyCostReport(process.cwd(), new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York'}).format(new Date())))"
   ```
   Confirm `data/reports/cost_{today}.md` exists with a header.
6. Toggle `COST_TRACKING_ENABLED=false`, restart, confirm:
   - No new writes to per-day files
   - Dashboard tab shows "tracking disabled" message
   - `GET /api/v1/costs` returns 404
   - `node scripts/cost-report.mjs` still works (reads historical data)

- [ ] **Step 3: Live verification kick-off**

Per the spec's rollout step, plan to:
- Run for one full ET trading day.
- After 7 full days, recheck the dashboard — delta column should be populated with real values (not "—").
- Spot-check a delta calculation against the raw per-day sparkline values to confirm the math.

---

## Self-Review

**1. Spec coverage** — walked each spec section, mapped to tasks:
- `agent/cost-store.js` module API (recordBeat, readDay, readRange, aggregateByAgent): Tasks 1–7 ✓
- Schema (per-day JSON with rows): Task 2 ✓
- Atomic write + sort order: Task 4 ✓
- readDay error cases (missing/corrupt/schema): Task 5 ✓
- `extractTokenDelta` field naming preserved: Task 2 (recordBeat signature) ✓
- Harness wiring + flag + soft-fail + reasoning accumulator: Task 9 ✓
- HTTP endpoint shape (from/to/agents/totals/sparkline/phasesToday): Task 10 ✓
- Dashboard tab Layout A: Task 11 ✓
- Empty + disabled + error states for dashboard: Task 11 Step 3 ✓
- Daily report markdown + notable shifts: Task 8 + Task 12 ✓
- CLI shim with --days/--format/--agent: Task 13 ✓
- Default ON via COST_TRACKING_ENABLED: Tasks 9, 10, 12 ✓
- No backfill: spec out-of-scope; no task needed ✓
- Skill integrations (review-performance etc): spec marks as "small follow-ups", not in this PR ✓

**2. Placeholder scan** — no "TBD", "TODO", "implement later", or vague "handle edge cases" instructions. Each step is concrete.

**3. Type consistency** — `recordBeat`, `readDay`, `readRange`, `aggregateByAgent`, `buildCostsResponse`, `renderDailyReportMarkdown`, `writeDailyCostReport`, `computePerAgentSummary`, `computeNotableShifts` names are consistent across tasks. Field names match schema (sandboxId, agentId, agentName, model, phase, cost, input, output, reasoning, cacheRead, cacheWrite, beatCount, firstBeatAt, lastBeatAt).

**4. Outstanding implementation-time decisions** that the spec didn't pin and the engineer will face:
- `agent/analysis-scheduler.js` post-close scheduling shape (cron vs polling vs setTimeout). Task 12 Step 1 + Step 6 instructs the engineer to match the existing pattern in that file. If no post-close hook exists yet, the engineer must add the scheduling infra — that risk is real and the task acknowledges it.
- `this.projectRoot` may not exist on the harness. Task 9 Step 3 notes the fallback to `process.cwd()`.

Both are intentionally flagged inline, not silently assumed.
