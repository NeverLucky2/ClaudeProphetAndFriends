# Coil Inverse-Veto Ledger — Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the operator's judgment that Coil should have fired on a WATCH near-miss but didn't, and answer — five trading days later — whether that specific call was right.

**Architecture:** A separate JSON store cloned from the proven `agent/veto-store.js` (atomic tmp-rename writes, in-process write serialization). Three guardrails make each flag falsifiable: the ticker must be in `MEANREV_UNIVERSE`, the flag must be backed by that date's `coil-preview` snapshot, and it must be logged before Coil's 15:45 ET beat. A scorer reuses the existing `simulateTrade` to compute what the trade *would* have returned, and compares the operator's flags against the **contemporaneous** near-miss population.

**Tech Stack:** Node 20+ ESM (`"type": "module"`), `node:test` + `node:assert/strict`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-coil-inverse-veto-design.md` (Part 3).

**Depends on:** Plan 1 Task 1 (`scripts/coil-nearmiss-enum.mjs`) must exist. Nothing else from Plan 1 is required — this plan is independent of the diagnostic's *result*.

## Global Constraints

- **Never modify live Coil**, and **never edit `agent/veto-store.js` / `agent/veto-log.js`.** This is a sibling store, not an extension.
- **No new dependencies.**
- **`crowd_frontrun` is the only accepted reason.** Any other value is rejected. A subjective second reason was considered and deliberately rejected as an escape hatch.
- **Coil's beat is 15:45 ET.** A flag logged at or after that instant on its own `date` is `hindsight`.
- **Friction is 20 bps** round-trip, matching `08a17a3`, so flag returns are comparable to its bucket table.
- **Δ carries no verdict at any n.** Per-trade σ ≈ 4–5%; at n=30 the MDE is ≈1.8%/trade. The scorer reports Δ, its CI, n, and the realized MDE, labelled *descriptive*. It must never print SUPPORTED / NOT_SUPPORTED.
- **Run all commands from the repo root:** `C:\Users\mtzuo\OneDrive\Documents\Projects\ClaudeProphetAndFriends`.
- **Test command:** `node --test agent/<file>.test.mjs` for one file; `npm test` for all.

---

### Task 1: The store

Cloned from `agent/veto-store.js`. Owns `data/coil-inverse-vetoes/inverse-vetoes.json`.

**Files:**
- Create: `agent/inverse-veto-store.js`
- Test: `agent/inverse-veto-store.test.mjs`

**Interfaces:**
- Consumes: `MEANREV_UNIVERSE` from `scripts/coil-eventstudy-build.mjs`.
- Produces:
  - `VALID_REASONS = ['crowd_frontrun']`, `getReasons() -> string[]`
  - `COIL_BEAT_ET = '15:45'`
  - `etParts(iso) -> {date: 'YYYY-MM-DD', time: 'HH:MM'}`
  - `isPreBeat(loggedAtIso, date) -> boolean`
  - `readInverseVetoes(projectRoot) -> Promise<Array>`
  - `readWatchSnapshot(projectRoot, date) -> Promise<Array|null>` — that date's WATCH list, or null when absent
  - `createInverseVeto(projectRoot, {date, ticker, reason, notes, watchEntryRef, watchRsi2, loggedAt}) -> Promise<record>`

Snapshot shape (`data/coil-preview/<date>.json`): `{ preview_time_et, watch: [{ticker, last_close, rsi_2, ...}] }`.

- [ ] **Step 1: Write the failing test**

Create `agent/inverse-veto-store.test.mjs`:

```js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  VALID_REASONS, getReasons, COIL_BEAT_ET, etParts, isPreBeat,
  readInverseVetoes, readWatchSnapshot, createInverseVeto,
} from './inverse-veto-store.js';

const _roots = [];
async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iveto-'));
  _roots.push(root);
  return root;
}
after(async () => { await Promise.all(_roots.map(r => fs.rm(r, { recursive: true, force: true }))); });

async function writeSnapshot(root, date, watch, previewTimeEt = '14:02') {
  const dir = path.join(root, 'data', 'coil-preview');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${date}.json`), JSON.stringify({
    preview_date_et: date, preview_time_et: previewTimeEt, firing: [], watch,
  }));
}
const watchRow = (ticker, last_close, rsi_2) => ({ ticker, last_close, rsi_2 });

// 2026-07-07 is EDT (UTC-4). 19:00Z = 15:00 ET (pre-beat). 20:00Z = 16:00 ET (post-beat).
const PRE_BEAT = '2026-07-07T19:00:00Z';
const POST_BEAT = '2026-07-07T20:00:00Z';

test('crowd_frontrun is the only reason, and getReasons returns a copy', () => {
  assert.deepEqual(getReasons(), ['crowd_frontrun']);
  assert.equal(COIL_BEAT_ET, '15:45');
  const copy = getReasons();
  copy.push('mutated');
  assert.deepEqual(VALID_REASONS, ['crowd_frontrun']);
});

test('etParts converts a UTC instant into ET date and time', () => {
  assert.deepEqual(etParts('2026-07-07T19:00:00Z'), { date: '2026-07-07', time: '15:00' });
  // 03:00Z on the 8th is 23:00 ET on the 7th — the ET date rolls back.
  assert.deepEqual(etParts('2026-07-08T03:00:00Z'), { date: '2026-07-07', time: '23:00' });
});

test('isPreBeat is true strictly before 15:45 ET on the flag date', () => {
  assert.equal(isPreBeat('2026-07-07T19:44:00Z', '2026-07-07'), true);   // 15:44 ET
  assert.equal(isPreBeat('2026-07-07T19:45:00Z', '2026-07-07'), false);  // 15:45 ET exactly
  assert.equal(isPreBeat('2026-07-07T20:00:00Z', '2026-07-07'), false);  // 16:00 ET
  assert.equal(isPreBeat('2026-07-08T03:00:00Z', '2026-07-07'), false);  // 23:00 ET same ET date
  assert.equal(isPreBeat('2026-07-08T14:00:00Z', '2026-07-07'), false);  // a later ET date entirely
});

test('isPreBeat handles a winter (EST, UTC-5) date', () => {
  assert.equal(isPreBeat('2026-01-15T20:44:00Z', '2026-01-15'), true);   // 15:44 EST
  assert.equal(isPreBeat('2026-01-15T20:45:00Z', '2026-01-15'), false);  // 15:45 EST
});

test('readInverseVetoes returns [] when the file is missing', async () => {
  assert.deepEqual(await readInverseVetoes(await tmpRoot()), []);
});

test('readWatchSnapshot returns null when absent, the watch list when present', async () => {
  const root = await tmpRoot();
  assert.equal(await readWatchSnapshot(root, '2026-07-07'), null);
  await writeSnapshot(root, '2026-07-07', [watchRow('AMAT', 552.30, 8.29)]);
  const w = await readWatchSnapshot(root, '2026-07-07');
  assert.equal(w.length, 1);
  assert.equal(w[0].ticker, 'AMAT');
});

test('createInverseVeto auto-populates ref/rsi2/previewTime from the snapshot', async () => {
  const root = await tmpRoot();
  await writeSnapshot(root, '2026-07-07', [watchRow('AMAT', 552.30, 8.29)], '14:02');
  const v = await createInverseVeto(root, {
    date: '2026-07-07', ticker: 'amat', reason: 'crowd_frontrun',
    notes: 'semis bid before the trigger', loggedAt: PRE_BEAT,
  });
  assert.equal(v.ticker, 'AMAT');
  assert.equal(v.watchEntryRef, 552.30);
  assert.equal(v.watchRsi2, 8.29);
  assert.equal(v.snapshotPreviewTimeEt, '14:02');
  assert.equal(v.snapshotBacked, true);
  assert.equal(v.preBeat, true);
  assert.equal(v.hindsight, false);
  assert.equal(v.reconciled, false);
  assert.ok(v.id.startsWith('iveto_'));
  assert.equal((await readInverseVetoes(root)).length, 1);
});

test('createInverseVeto rejects a ticker outside MEANREV_UNIVERSE', async () => {
  const root = await tmpRoot();
  await writeSnapshot(root, '2026-07-07', [watchRow('KLAC', 900, 8.0)]);
  await assert.rejects(
    () => createInverseVeto(root, { date: '2026-07-07', ticker: 'KLAC', reason: 'crowd_frontrun', loggedAt: PRE_BEAT }),
    /universe/i,
  );
  assert.deepEqual(await readInverseVetoes(root), []);
});

test('createInverseVeto rejects a ticker absent from that date\'s WATCH list', async () => {
  const root = await tmpRoot();
  await writeSnapshot(root, '2026-07-07', [watchRow('GE', 355.95, 5.11)]);
  await assert.rejects(
    () => createInverseVeto(root, { date: '2026-07-07', ticker: 'AMAT', reason: 'crowd_frontrun', loggedAt: PRE_BEAT }),
    /not in the WATCH list/i,
  );
});

test('createInverseVeto rejects any reason but crowd_frontrun', async () => {
  const root = await tmpRoot();
  await writeSnapshot(root, '2026-07-07', [watchRow('AMAT', 552.30, 8.29)]);
  await assert.rejects(
    () => createInverseVeto(root, { date: '2026-07-07', ticker: 'AMAT', reason: 'quality_oversold', loggedAt: PRE_BEAT }),
    /reason/,
  );
});

test('createInverseVeto rejects a bad date', async () => {
  const root = await tmpRoot();
  await assert.rejects(
    () => createInverseVeto(root, { date: '07-07-2026', ticker: 'AMAT', reason: 'crowd_frontrun', watchEntryRef: 1, watchRsi2: 8, loggedAt: PRE_BEAT }),
    /date/,
  );
});

test('a post-beat flag is accepted but marked hindsight', async () => {
  const root = await tmpRoot();
  await writeSnapshot(root, '2026-07-07', [watchRow('AMAT', 552.30, 8.29)]);
  const v = await createInverseVeto(root, {
    date: '2026-07-07', ticker: 'AMAT', reason: 'crowd_frontrun', loggedAt: POST_BEAT,
  });
  assert.equal(v.preBeat, false);
  assert.equal(v.hindsight, true);
});

test('with no snapshot, explicit ref+rsi2 are required and snapshotBacked is false', async () => {
  const root = await tmpRoot();
  await assert.rejects(
    () => createInverseVeto(root, { date: '2026-07-07', ticker: 'AMAT', reason: 'crowd_frontrun', loggedAt: PRE_BEAT }),
    /watchEntryRef/,
  );
  const v = await createInverseVeto(root, {
    date: '2026-07-07', ticker: 'AMAT', reason: 'crowd_frontrun',
    watchEntryRef: 552.30, watchRsi2: 8.29, loggedAt: PRE_BEAT,
  });
  assert.equal(v.snapshotBacked, false);
  assert.equal(v.snapshotPreviewTimeEt, null);
});

test('createInverseVeto rejects an rsi2 outside the near-miss band', async () => {
  const root = await tmpRoot();
  await assert.rejects(
    () => createInverseVeto(root, { date: '2026-07-07', ticker: 'AMAT', reason: 'crowd_frontrun', watchEntryRef: 552, watchRsi2: 3.0, loggedAt: PRE_BEAT }),
    /watchRsi2/,
  );
  await assert.rejects(
    () => createInverseVeto(root, { date: '2026-07-07', ticker: 'AMAT', reason: 'crowd_frontrun', watchEntryRef: 552, watchRsi2: 20, loggedAt: PRE_BEAT }),
    /watchRsi2/,
  );
});

test('concurrent createInverseVeto calls do not clobber each other', async () => {
  const root = await tmpRoot();
  await writeSnapshot(root, '2026-07-07', [watchRow('AMAT', 552.30, 8.29)]);
  await Promise.all(Array.from({ length: 20 }, () => createInverseVeto(root, {
    date: '2026-07-07', ticker: 'AMAT', reason: 'crowd_frontrun', loggedAt: PRE_BEAT,
  })));
  assert.equal((await readInverseVetoes(root)).length, 20);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/inverse-veto-store.test.mjs`
Expected: FAIL — `Cannot find module './inverse-veto-store.js'`

- [ ] **Step 3: Write minimal implementation**

Create `agent/inverse-veto-store.js`:

```js
// agent/inverse-veto-store.js
// Coil Inverse-Veto Ledger store — the mirror of veto-store.js.
//
// A veto says "Coil fired, I passed"; its counterfactual is the bot's own paper trade.
// An INVERSE veto says "Coil passed, I'd have taken it"; the bot took nothing, so the
// counterfactual must be SIMULATED (see inverse-veto-scorer.js).
//
// Three guardrails make a flag falsifiable rather than a feeling:
//   1. the ticker must be in MEANREV_UNIVERSE (Coil could actually have fired on it),
//   2. it must appear in that date's coil-preview WATCH snapshot (a contemporaneous artifact),
//   3. it must be logged before Coil's 15:45 ET beat (otherwise you already know the close).
//
// JSON-array file with atomic writes serialized in-process. Cloned from veto-store.js;
// that module is NOT modified.
import fs from 'node:fs/promises';
import path from 'node:path';
import { MEANREV_UNIVERSE } from '../scripts/coil-eventstudy-build.mjs';

export const VALID_REASONS = ['crowd_frontrun'];
export const COIL_BEAT_ET = '15:45';
const NEAR_MISS_LO = 5, NEAR_MISS_HI = 15;

const UNIVERSE = new Set(MEANREV_UNIVERSE);

function dir(projectRoot) { return path.join(projectRoot, 'data', 'coil-inverse-vetoes'); }
function file(projectRoot) { return path.join(dir(projectRoot), 'inverse-vetoes.json'); }
function snapshotFile(projectRoot, date) { return path.join(projectRoot, 'data', 'coil-preview', `${date}.json`); }

export function getReasons() { return [...VALID_REASONS]; }

const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// etParts: the ET calendar date and wall-clock time of a UTC instant.
export function etParts(iso) {
  const p = {};
  for (const x of ET_FMT.formatToParts(new Date(iso))) p[x.type] = x.value;
  const hour = p.hour === '24' ? '00' : p.hour;   // en-CA can emit 24 for midnight
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
}

// isPreBeat: logged strictly before Coil's beat, on the flag's own ET date.
export function isPreBeat(loggedAtIso, date) {
  const { date: etDate, time } = etParts(loggedAtIso);
  if (etDate !== date) return false;
  return time < COIL_BEAT_ET;   // 'HH:MM' strings compare lexicographically
}

export async function readInverseVetoes(projectRoot) {
  try {
    const arr = JSON.parse(await fs.readFile(file(projectRoot), 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// readWatchSnapshot: that ET date's WATCH list, or null when the preview was not run.
export async function readWatchSnapshot(projectRoot, date) {
  try {
    const obj = JSON.parse(await fs.readFile(snapshotFile(projectRoot, date), 'utf-8'));
    return Array.isArray(obj.watch) ? obj.watch : [];
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

let _writeChain = Promise.resolve();
function serialize(task) {
  const run = _writeChain.then(task, task);
  _writeChain = run.then(() => {}, () => {});
  return run;
}

async function _atomicWrite(projectRoot, rows) {
  await fs.mkdir(dir(projectRoot), { recursive: true });
  const tmp = file(projectRoot) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(rows, null, 2));
  await fs.rename(tmp, file(projectRoot));
}

export async function createInverseVeto(projectRoot, {
  date, ticker, reason, notes, watchEntryRef, watchRsi2, loggedAt,
} = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]*$/.test(t)) throw new Error('invalid ticker');
  if (!UNIVERSE.has(t)) throw new Error(`${t} is not in Coil's MEANREV_UNIVERSE — Coil could never have fired on it`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('invalid date (expected YYYY-MM-DD)');
  if (!VALID_REASONS.includes(reason)) throw new Error(`invalid reason: ${reason} (only crowd_frontrun)`);

  const at = loggedAt ? new Date(loggedAt).toISOString() : new Date().toISOString();

  // Snapshot-backing: prefer the contemporaneous artifact over operator-typed numbers.
  const watch = await readWatchSnapshot(projectRoot, date);
  let ref = watchEntryRef, rsi2 = watchRsi2, previewTime = null, backed = false;
  if (watch !== null) {
    const row = watch.find(w => String(w.ticker).toUpperCase() === t);
    if (!row) throw new Error(`${t} is not in the WATCH list of data/coil-preview/${date}.json`);
    ref = row.last_close;
    rsi2 = row.rsi_2;
    backed = true;
    try {
      const obj = JSON.parse(await fs.readFile(snapshotFile(projectRoot, date), 'utf-8'));
      previewTime = obj.preview_time_et ?? null;
    } catch { previewTime = null; }
  }

  const refNum = Number(ref);
  if (!Number.isFinite(refNum) || refNum <= 0) throw new Error('invalid watchEntryRef');
  const rsiNum = Number(rsi2);
  if (!Number.isFinite(rsiNum) || rsiNum < NEAR_MISS_LO || rsiNum >= NEAR_MISS_HI) {
    throw new Error(`invalid watchRsi2: ${rsi2} (must be in [${NEAR_MISS_LO}, ${NEAR_MISS_HI}) — a near-miss, not a fire)`);
  }

  const preBeat = isPreBeat(at, date);
  const rec = {
    id: `iveto_${Date.now()}_${t}_${Math.random().toString(36).slice(2, 6)}`,
    date: String(date),
    ticker: t,
    watchEntryRef: refNum,
    watchRsi2: rsiNum,
    snapshotPreviewTimeEt: previewTime,
    snapshotBacked: backed,
    reason,
    notes: String(notes || '').trim(),
    loggedAt: at,
    preBeat,
    hindsight: !preBeat,
    reconciled: false,
  };

  return serialize(async () => {
    const rows = await readInverseVetoes(projectRoot);
    rows.push(rec);
    await _atomicWrite(projectRoot, rows);
    return rec;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/inverse-veto-store.test.mjs`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/inverse-veto-store.js agent/inverse-veto-store.test.mjs
git commit -m "feat(inverse-veto): store with universe, snapshot-backing and pre-beat guardrails"
```

---

### Task 2: The logging CLI

**Files:**
- Create: `agent/inverse-veto-log.js`
- Test: `agent/inverse-veto-log.test.mjs`

**Interfaces:**
- Consumes: `createInverseVeto` (Task 1).
- Produces: `parseArgs(argv) -> object`; a CLI entry point.

`veto-log.js` parses flags in strict `--key value` pairs. Reuse that shape so the two ledgers feel identical to operate.

- [ ] **Step 1: Write the failing test**

Create `agent/inverse-veto-log.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './inverse-veto-log.js';

test('parseArgs reads --key value pairs', () => {
  assert.deepEqual(
    parseArgs(['--date', '2026-07-07', '--ticker', 'AMAT', '--reason', 'crowd_frontrun']),
    { date: '2026-07-07', ticker: 'AMAT', reason: 'crowd_frontrun' },
  );
});

test('parseArgs returns {} for no args', () => {
  assert.deepEqual(parseArgs([]), {});
});

test('parseArgs throws on a bare token where a flag was expected', () => {
  assert.throws(() => parseArgs(['date', '2026-07-07']), /expected --flag/);
});

test('parseArgs accepts optional ref and rsi2 for the no-snapshot path', () => {
  const a = parseArgs(['--date', '2026-07-07', '--ticker', 'AMAT', '--reason', 'crowd_frontrun', '--ref', '552.30', '--rsi2', '8.29']);
  assert.equal(a.ref, '552.30');
  assert.equal(a.rsi2, '8.29');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/inverse-veto-log.test.mjs`
Expected: FAIL — `Cannot find module './inverse-veto-log.js'`

- [ ] **Step 3: Write minimal implementation**

Create `agent/inverse-veto-log.js`:

```js
#!/usr/bin/env node
// agent/inverse-veto-log.js
// CLI to log a Coil inverse veto — "Coil passed on this WATCH name, I'd have taken it".
//
//   node agent/inverse-veto-log.js --date 2026-07-07 --ticker AMAT --reason crowd_frontrun --notes "..."
//
// With that date's coil-preview snapshot present, --ref and --rsi2 are read from it and must
// be omitted. Without a snapshot they are required, and the flag is quarantined from the headline.
import { pathToFileURL } from 'node:url';
import { createInverseVeto } from './inverse-veto-store.js';

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith('--')) throw new Error(`expected --flag, got: ${key}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const v = await createInverseVeto(process.cwd(), {
    date: a.date, ticker: a.ticker, reason: a.reason, notes: a.notes,
    watchEntryRef: a.ref, watchRsi2: a.rsi2,
  });
  const flags = [
    v.snapshotBacked ? 'snapshot-backed' : 'NOT snapshot-backed',
    v.hindsight ? 'HINDSIGHT (excluded from the headline)' : 'pre-beat',
  ].join(', ');
  console.log(`logged inverse veto ${v.id} (${v.ticker} @ RSI ${v.watchRsi2.toFixed(2)}, ref ${v.watchEntryRef}) — ${flags}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/inverse-veto-log.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/inverse-veto-log.js agent/inverse-veto-log.test.mjs
git commit -m "feat(inverse-veto): logging CLI"
```

---

### Task 3: The scorer

Simulates each flag with the existing `simulateTrade`, and compares the flagged set against the **contemporaneous** near-miss population — never against `08a17a3`'s historical bucket means, which would confound operator skill with a time-varying band.

**Files:**
- Create: `agent/inverse-veto-scorer.js`
- Test: `agent/inverse-veto-scorer.test.mjs`

**Interfaces:**
- Consumes:
  - `readInverseVetoes` (Task 1)
  - `simulateTrade` from `scripts/coil-threshold-exitsim.mjs`
  - `loadBars`, `indexByDate` from `scripts/coil-eventstudy-bars.mjs`
  - `bucketOf` from `scripts/coil-threshold-build.mjs`
  - `applyFriction`, `mean`, `bootstrapDiffCI` from `scripts/coil-threshold-metrics.mjs`
  - `enumerateEpisodes` from `scripts/coil-nearmiss-enum.mjs` *(Plan 1, Task 1)*
- Produces:
  - `FRICTION_BPS = 20`, `ASSUMED_NOTIONAL_PER_TRADE = 10000`
  - `scoreFlag(bars, flag) -> {...flag, simEntryClose, simExit, simExitReason, simDaysHeld, simGrossReturn, simNetReturn, simNetReturnFromRef, censored, reconciled}`
  - `headlineSet(flags) -> Array` — pre-beat, snapshot-backed, reconciled, non-censored
  - `bucketMatchedBaseline(flags, baselineRows) -> number|null`
  - `mdeOf(ci) -> number|null`
  - `scoreAll({flags, barsByTicker, baselineRows}) -> report object`

**Sign convention:** inverse-veto value is `+simNetReturn`. Positive → flagging was right, Coil's strictness cost you. Negative → **waiting for Coil was right.**

- [ ] **Step 1: Write the failing test**

Create `agent/inverse-veto-scorer.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRICTION_BPS, scoreFlag, headlineSet, bucketMatchedBaseline, mdeOf, scoreAll,
} from './inverse-veto-scorer.js';

const B = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });
const flag = (over = {}) => ({
  id: 'iveto_1', date: 'd0', ticker: 'AMAT', watchEntryRef: 100, watchRsi2: 8.5,
  reason: 'crowd_frontrun', preBeat: true, hindsight: false, snapshotBacked: true,
  reconciled: false, ...over,
});

test('friction matches the study so flags compare to its buckets', () => {
  assert.equal(FRICTION_BPS, 20);
});

test('scoreFlag: a losing simulated trade yields a NEGATIVE value (waiting was right)', () => {
  // entry close 100; day+1 gaps to 90, below the 93 stop -> fills at the open.
  const bars = [B('d0', 100, 100, 100, 100), B('d1', 90, 91, 89, 90)];
  const r = scoreFlag(bars, flag());
  assert.equal(r.censored, false);
  assert.equal(r.reconciled, true);
  assert.equal(r.simExitReason, 'stop');
  assert.equal(r.simEntryClose, 100);
  assert.ok(r.simGrossReturn < 0);
  assert.ok(r.simNetReturn < r.simGrossReturn, 'friction makes it worse');
  assert.ok(Math.abs(r.simNetReturn - (-0.10 - 0.002)) < 1e-12);
});

test('scoreFlag: simNetReturnFromRef differs when the ref is not the close', () => {
  const bars = [B('d0', 100, 100, 100, 100), B('d1', 90, 91, 89, 90)];
  const r = scoreFlag(bars, flag({ watchEntryRef: 102 }));   // paid more than the close
  assert.ok(r.simNetReturnFromRef < r.simNetReturn, 'a worse entry price means a worse return');
  // (90 - 102)/102 - 0.002
  assert.ok(Math.abs(r.simNetReturnFromRef - ((90 - 102) / 102 - 0.002)) < 1e-12);
});

test('scoreFlag: censored when too few forward bars exist', () => {
  const bars = [B('d0', 100, 100, 100, 100), B('d1', 96, 96, 95, 96)];
  const r = scoreFlag(bars, flag());
  assert.equal(r.censored, true);
  assert.equal(r.reconciled, false);
  assert.equal(r.simNetReturn, null);
});

test('scoreFlag: an unknown date returns an unreconciled flag, not a throw', () => {
  const bars = [B('dX', 100, 100, 100, 100)];
  const r = scoreFlag(bars, flag({ date: 'nope' }));
  assert.equal(r.reconciled, false);
  assert.equal(r.simNetReturn, null);
});

test('headlineSet keeps only pre-beat, snapshot-backed, reconciled, uncensored flags', () => {
  const rows = [
    { preBeat: true, snapshotBacked: true, reconciled: true, censored: false, id: 'keep' },
    { preBeat: false, snapshotBacked: true, reconciled: true, censored: false, id: 'hindsight' },
    { preBeat: true, snapshotBacked: false, reconciled: true, censored: false, id: 'unbacked' },
    { preBeat: true, snapshotBacked: true, reconciled: false, censored: false, id: 'pending' },
    { preBeat: true, snapshotBacked: true, reconciled: true, censored: true, id: 'censored' },
  ];
  assert.deepEqual(headlineSet(rows).map(r => r.id), ['keep']);
});

test('bucketMatchedBaseline weights baseline buckets by the flags\' own bucket mix', () => {
  // Two flags in [8,10), one in [5,8). Baseline means: [8,10)=+0.03, [5,8)=0.00.
  const flags = [{ watchRsi2: 8.5 }, { watchRsi2: 9.5 }, { watchRsi2: 6.0 }];
  const baselineRows = [
    { date: 'a', bucket: '[8,10)', net: 0.02 }, { date: 'b', bucket: '[8,10)', net: 0.04 },
    { date: 'c', bucket: '[5,8)', net: -0.01 }, { date: 'd', bucket: '[5,8)', net: 0.01 },
  ];
  // expected = (2 * 0.03 + 1 * 0.00) / 3 = 0.02
  assert.ok(Math.abs(bucketMatchedBaseline(flags, baselineRows) - 0.02) < 1e-12);
});

test('bucketMatchedBaseline returns null when a flag bucket has no baseline rows', () => {
  assert.equal(bucketMatchedBaseline([{ watchRsi2: 8.5 }], [{ date: 'a', bucket: '[5,8)', net: 0.01 }]), null);
});

test('mdeOf is half the CI width', () => {
  assert.ok(Math.abs(mdeOf({ lo: -0.02, hi: 0.03 }) - 0.025) < 1e-12);
  assert.equal(mdeOf({ lo: null, hi: null }), null);
});

test('scoreAll never emits a verdict, and reports n, delta, MDE and the flag rate', () => {
  const bars = [B('d0', 100, 100, 100, 100), B('d1', 90, 91, 89, 90)];
  const flags = [flag()];
  const baselineRows = [
    { date: 'd0', bucket: '[8,10)', net: 0.01 }, { date: 'd0', bucket: '[8,10)', net: -0.01 },
  ];
  const rep = scoreAll({ flags, barsByTicker: { AMAT: bars }, baselineRows, nEpisodes: 50 });
  assert.equal(rep.headline.n, 1);
  assert.ok(rep.headline.flaggedMean < 0);
  assert.equal(rep.headline.baseline, 0);
  assert.ok(Number.isFinite(rep.headline.delta));
  assert.equal(rep.flagRate, 1 / 50);
  assert.equal(rep.verdict, undefined, 'the scorer must never emit a verdict');
  assert.match(rep.note, /descriptive/i);
});

test('scoreAll counts quarantined flags separately from the headline', () => {
  const bars = [B('d0', 100, 100, 100, 100), B('d1', 90, 91, 89, 90)];
  const flags = [flag(), flag({ id: 'iveto_2', hindsight: true, preBeat: false })];
  const rep = scoreAll({
    flags, barsByTicker: { AMAT: bars },
    baselineRows: [{ date: 'd0', bucket: '[8,10)', net: 0.0 }], nEpisodes: 10,
  });
  assert.equal(rep.headline.n, 1);
  assert.equal(rep.quarantined.hindsight, 1);
  assert.equal(rep.quarantined.notSnapshotBacked, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/inverse-veto-scorer.test.mjs`
Expected: FAIL — `Cannot find module './inverse-veto-scorer.js'`

- [ ] **Step 3: Write minimal implementation**

Create `agent/inverse-veto-scorer.js`:

```js
// agent/inverse-veto-scorer.js
// Reconcile inverse-veto flags against a SIMULATED trade, and compare the operator's flags
// against the CONTEMPORANEOUS near-miss population.
//
// Why contemporaneous: if the near-miss band's edge is genuinely time-varying (the whole
// front-run thesis), then comparing forward flags against 08a17a3's 2021-2026 bucket means
// cannot distinguish "your picks are good" from "the whole band improved".
//
// This module NEVER emits a verdict. Per-trade sigma is ~4-5%, so at n=30 the minimum
// detectable effect is ~1.8%/trade. A verdict gate there would be theatre. Report delta,
// its CI, n, and the realized MDE; label it descriptive.
import { pathToFileURL } from 'node:url';
import { simulateTrade } from '../scripts/coil-threshold-exitsim.mjs';
import { loadBars, indexByDate } from '../scripts/coil-eventstudy-bars.mjs';
import { bucketOf } from '../scripts/coil-threshold-build.mjs';
import { applyFriction, mean, bootstrapDiffCI } from '../scripts/coil-threshold-metrics.mjs';
import { readInverseVetoes } from './inverse-veto-store.js';

export const FRICTION_BPS = 20;
export const ASSUMED_NOTIONAL_PER_TRADE = 10000;
const BOOT = { blockSessions: 15, iterations: 10000, seed: 1234 };

// scoreFlag: simulate Coil's real exits from a fill at the signal-day close.
// PRIMARY convention = signal-day close (identical to 08a17a3, so it is comparable to the
// baseline). SECONDARY = the operator's midday watchEntryRef (what they'd actually have paid).
export function scoreFlag(bars, flag) {
  const idx = indexByDate(bars).get(flag.date);
  const pending = {
    ...flag, simEntryClose: null, simExit: null, simExitReason: null, simDaysHeld: null,
    simGrossReturn: null, simNetReturn: null, simNetReturnFromRef: null,
    censored: true, reconciled: false,
  };
  if (idx == null) return pending;

  const t = simulateTrade(bars, idx);
  if (t.censored) return { ...pending, simEntryClose: t.entry, simDaysHeld: t.daysHeld };

  const netFromClose = applyFriction(t.grossReturn, FRICTION_BPS);
  const grossFromRef = (t.exit - flag.watchEntryRef) / flag.watchEntryRef;
  return {
    ...flag,
    simEntryClose: t.entry,
    simExit: t.exit,
    simExitReason: t.exitReason,
    simDaysHeld: t.daysHeld,
    simGrossReturn: t.grossReturn,
    simNetReturn: netFromClose,
    simNetReturnFromRef: applyFriction(grossFromRef, FRICTION_BPS),
    censored: false,
    reconciled: true,
    reconciledAt: new Date().toISOString(),
  };
}

// headlineSet: only flags that survive all three guardrails and have actually resolved.
export function headlineSet(rows) {
  return rows.filter(r => r.preBeat && r.snapshotBacked && r.reconciled && !r.censored);
}

// bucketMatchedBaseline: the n-weighted contemporaneous baseline mean across the flags' OWN
// RSI buckets. Isolates discretion from bucket mix — an operator who only flags [8,10) names
// gets no credit for that bucket's higher unconditional mean.
export function bucketMatchedBaseline(flags, baselineRows) {
  if (!flags.length) return null;
  let acc = 0;
  for (const f of flags) {
    const b = bucketOf(f.watchRsi2);
    const rows = baselineRows.filter(r => r.bucket === b);
    if (!rows.length) return null;
    acc += mean(rows.map(r => r.net));
  }
  return acc / flags.length;
}

export function mdeOf(ci) {
  if (!ci || ci.lo == null || ci.hi == null) return null;
  return (ci.hi - ci.lo) / 2;
}

// scoreAll: the descriptive report. `baselineRows` are contemporaneous near-miss episodes,
// each simulated the same way: {date, bucket, net}. `nEpisodes` is how many near-miss
// episodes were observed over the ledger window (the flag-rate denominator).
export function scoreAll({ flags, barsByTicker, baselineRows, nEpisodes }) {
  const scored = flags.map(f => scoreFlag(barsByTicker[f.ticker] || [], f));
  const head = headlineSet(scored);

  const flaggedRows = head.map(r => ({ date: r.date, net: r.simNetReturn }));
  const matchedRows = baselineRows.filter(r => head.some(h => bucketOf(h.watchRsi2) === r.bucket));
  const baseline = bucketMatchedBaseline(head, baselineRows);
  const flaggedMean = flaggedRows.length ? mean(flaggedRows.map(r => r.net)) : null;

  const ci = (flaggedRows.length && matchedRows.length)
    ? bootstrapDiffCI(matchedRows, flaggedRows, BOOT)   // CI on (flagged - baseline)
    : { lo: null, hi: null, mean: null };

  const wins = head.filter(r => r.simNetReturn > 0).length;
  return {
    scored,
    headline: {
      n: head.length,
      flaggedMean,
      baseline,
      delta: (flaggedMean != null && baseline != null) ? flaggedMean - baseline : null,
      deltaCi: { lo: ci.lo, hi: ci.hi },
      mde: mdeOf(ci),
      hitRate: head.length ? wins / head.length : null,
      sumNet: flaggedRows.reduce((a, r) => a + r.net, 0),
      sumUsd: flaggedRows.reduce((a, r) => a + r.net, 0) * ASSUMED_NOTIONAL_PER_TRADE,
      meanFromRef: head.length ? mean(head.map(r => r.simNetReturnFromRef)) : null,
    },
    quarantined: {
      hindsight: scored.filter(r => r.hindsight).length,
      notSnapshotBacked: scored.filter(r => !r.snapshotBacked).length,
      pending: scored.filter(r => !r.reconciled).length,
    },
    flagRate: nEpisodes ? flags.length / nEpisodes : null,
    note:
      'DESCRIPTIVE ONLY. No verdict is drawn at any n. Per-trade sigma is ~4-5%, so the ' +
      'minimum detectable effect at n=30 is ~1.8%/trade. Read delta alongside its CI and the ' +
      'realized MDE. A flag rate near 1.0 means you flagged everything, in which case delta ' +
      'tends to 0 by construction and the ledger tests nothing.',
  };
}

// CLI: node agent/inverse-veto-scorer.js
// Baseline construction (contemporaneous near-miss episodes, simulated) is wired here.
async function main() {
  const root = process.cwd();
  const flags = await readInverseVetoes(root);
  if (!flags.length) { console.log('no inverse vetoes logged yet'); return; }

  const { enumerateEpisodes } = await import('../scripts/coil-nearmiss-enum.mjs');
  const { MEANREV_UNIVERSE } = await import('../scripts/coil-eventstudy-build.mjs');

  const barsByTicker = {};
  for (const t of new Set(flags.map(f => f.ticker))) barsByTicker[t] = loadBars(root, t);

  // Contemporaneous baseline: every near-miss episode from the first flag date onward,
  // simulated with the same exit engine and the same friction.
  const since = flags.map(f => f.date).sort()[0];
  const baselineRows = [];
  let nEpisodes = 0;
  for (const t of MEANREV_UNIVERSE) {
    const bars = loadBars(root, t);
    if (!bars.length) continue;
    for (const e of enumerateEpisodes(bars)) {
      if (e.date < since) continue;
      nEpisodes += 1;
      const sim = simulateTrade(bars, e.idx);   // enumerateEpisodes already carries the bar index
      if (sim.censored) continue;
      baselineRows.push({ date: e.date, bucket: bucketOf(e.rsi2), net: applyFriction(sim.grossReturn, FRICTION_BPS) });
    }
  }

  const rep = scoreAll({ flags, barsByTicker, baselineRows, nEpisodes });
  const h = rep.headline;
  const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%');
  console.log(`inverse-veto scorecard (DESCRIPTIVE — no verdict)`);
  console.log(`  headline n:        ${h.n}   (hindsight ${rep.quarantined.hindsight}, unbacked ${rep.quarantined.notSnapshotBacked}, pending ${rep.quarantined.pending})`);
  console.log(`  flagged mean net:  ${pct(h.flaggedMean)}   (at your ref price: ${pct(h.meanFromRef)})`);
  console.log(`  contemporaneous baseline: ${pct(h.baseline)}`);
  console.log(`  delta:             ${pct(h.delta)}  95% CI [${pct(h.deltaCi.lo)}, ${pct(h.deltaCi.hi)}]`);
  console.log(`  realized MDE:      ${pct(h.mde)}`);
  console.log(`  hit rate:          ${pct(h.hitRate)}   sum: ${pct(h.sumNet)} (${h.sumUsd.toFixed(0)} USD @ ${ASSUMED_NOTIONAL_PER_TRADE})`);
  console.log(`  flag rate:         ${rep.flagRate == null ? 'n/a' : rep.flagRate.toFixed(4)} (flags / near-miss episodes since ${since})`);
  console.log(`\n${rep.note}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/inverse-veto-scorer.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. No previously-passing test may regress — in particular `agent/veto-store.test.mjs`, which this plan must not have touched.

- [ ] **Step 6: Commit**

```bash
git add agent/inverse-veto-scorer.js agent/inverse-veto-scorer.test.mjs
git commit -m "feat(inverse-veto): scorer with contemporaneous bucket-matched baseline; no verdict"
```

---

### Task 4: Operator usage note, and the first flag

**Files:**
- Create: `Claudes Notes/coil-inverse-veto-usage.md`

- [ ] **Step 1: Write the usage note**

Create `Claudes Notes/coil-inverse-veto-usage.md`:

```markdown
# Coil Inverse-Veto Ledger — how to flag a near-miss

Log a WATCH name that Coil did **not** fire on, but which you'd have taken.
The mirror of the veto ledger: a veto is "Coil fired, I passed"; this is "Coil passed, I'd have taken it".

## Run it in a TERMINAL, from the repo root

```
node agent/inverse-veto-log.js --date YYYY-MM-DD --ticker XXX --reason crowd_frontrun --notes "..."
```

Inside a Claude Code session, prefix with `!` (it runs in the repo dir):

```
!node agent/inverse-veto-log.js --date 2026-07-07 --ticker AMAT --reason crowd_frontrun --notes "semis bid before the trigger"
```

## The only accepted reason

- `crowd_frontrun` — "this will bounce before it reaches RSI(2)<5, because others are buying the dip early."

There is no second reason, on purpose. If you can't claim front-run, you respect Coil's pass.

## Three things will reject or quarantine your flag

1. **Not in Coil's universe** → rejected outright. Coil watches 80 mega-caps. `KLAC`, `LRCX`, and
   `MU` are **not** among them — Coil could never have fired on those, so there is nothing to
   inverse-veto. `AMAT` *is* in the universe.
2. **Not in that date's WATCH snapshot** → rejected. Run `/coil-preview` first; the flag is anchored
   to that contemporaneous artifact, and `--ref` / `--rsi2` are read from it automatically.
   If the preview wasn't run that day, pass `--ref` and `--rsi2` yourself — the flag is accepted but
   marked *not snapshot-backed* and kept out of the headline.
3. **Logged at or after 15:45 ET** (Coil's beat) → accepted but marked `hindsight`, and excluded from
   the headline. Same-day is not good enough: by the close you already know whether it jumped.

**Flag it when you see the preview, before the beat.** That is the whole point.

## Reading the score

```
node agent/inverse-veto-scorer.js
```

A flag becomes scorable ~5 trading days after its date (Coil's time stop forces an exit).

> **Inverse-veto value = +simNetReturn.**
> Positive → flagging was right; Coil's strictness cost you that.
> Negative → **waiting for Coil was right.**

The scorer reports **Δ = your flagged mean − the contemporaneous near-miss baseline**, i.e. *did your
discretion beat taking every near-miss?* — not merely *did it make money*.

## What this ledger will and won't tell you

It answers the per-flag question honestly within a week. It will **not** deliver a statistical verdict
for years: per-trade σ is ~4–5%, so at n=30 the minimum detectable effect is ~1.8%/trade. The scorer
deliberately never prints SUPPORTED or NOT_SUPPORTED. Watch the **flag rate** — if you flag every WATCH
name, Δ goes to 0 by construction and the ledger tests nothing.

The thesis itself is tested elsewhere, with real power and no operator input:
`node scripts/coil-frontrun-monitor.mjs`.

## Prior worth knowing before you flag

The pre-registered study `08a17a3` found the near-miss band nets **≈ +0.06%/trade** after 20bps,
against **+0.59%** for the band Coil actually trades. On 2021–2026, **waiting for Coil was right.**
```

- [ ] **Step 2: Log the AMAT flag that motivated this feature**

Run:

```bash
node agent/inverse-veto-log.js --date 2026-07-07 --ticker AMAT --reason crowd_frontrun --notes "semis bid before the trigger; on WATCH 07-07, gone by 07-08"
```

Expected output contains `HINDSIGHT (excluded from the headline)`.

**This is correct, and it is the point.** The flag is being made after the bounce was observed, so it
cannot count toward the discretion test. The guardrail fires on the very case that motivated the
feature. Do not work around it.

If instead it errors with *"AMAT is not in the WATCH list"*, the `2026-07-07` snapshot has been
overwritten by a later preview run. Pass `--ref 552.30 --rsi2 8.29` explicitly; the flag will be
recorded as *not snapshot-backed* and quarantined for that reason too.

- [ ] **Step 3: Commit**

```bash
git add "Claudes Notes/coil-inverse-veto-usage.md"
git commit -m "docs(inverse-veto): operator usage note"
```

`data/coil-inverse-vetoes/inverse-vetoes.json` is gitignored (`data/**`), exactly as `vetoes.json` is.
The ledger is not backed up by git.

---

## What this plan deliberately does not do

- It does not change Coil's RSI threshold, universe, or exits.
- It does not modify `agent/veto-store.js` or `agent/veto-log.js`.
- It does not emit a verdict on operator discretion, at any sample size.
- It does not test the front-run thesis. That is Plan 1's monitor, which has real power and needs no
  flags at all. **Confirming front-running would not imply "enter earlier"** — adverse selection
  predicts the same conversion decline while the deep-band edge decays.
