# Coil Veto Ledger (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local store + CLI to log a Coil mirror veto (ticker, date, entry ref, reason, notes) so vetoes can be recorded now; reconciliation/scorecard is a later phase.

**Architecture:** Clone the proven `agent/tips-store.js` pattern into a *separate* `agent/veto-store.js` (JSON-array file, atomic tmp-rename writes, in-process write serialization, inline validation) backed by `data/coil-vetoes/vetoes.json`. A thin `agent/veto-log.js` CLI wraps `createVeto` so the operator can log from the terminal. No change to the Coil bot or the existing tips store. Zero LLM/network.

**Tech Stack:** Node.js (ESM), `node:fs/promises`, `node:path`, `node:url`; tests via `node:test` + `node:assert/strict`.

## Global Constraints

- Runtime: Node.js **ESM** (`import`/`export`), mirroring `agent/*.js`. No CommonJS.
- Tests: `node:test` + `node:assert/strict`; temp-dir roots via `fs.mkdtemp(path.join(os.tmpdir(), 'veto-'))`, cleaned in an `after` hook. Mirror `agent/tips-store.test.mjs`.
- Data file (EXACT): `data/coil-vetoes/vetoes.json`, created lazily via `fs.mkdir(dir, { recursive: true })`.
- Valid reasons (EXACT, only these two): `catalyst_driven`, `market_dislocation`.
- Ticker regex (EXACT): `/^[A-Z][A-Z.]*$/`, applied after `.trim().toUpperCase()`.
- Date format (EXACT): `YYYY-MM-DD`, validated by `/^\d{4}-\d{2}-\d{2}$/`.
- Atomic writes: write `<file>.tmp` then `fs.rename`; serialize all writes through one in-process promise chain (cloned from `tips-store.js`).
- No LLM, no network, no change to the Coil bot or the existing `agent/tips-store.js`.
- Commits: one per task on branch `feat/coil-veto-ledger`; squashed at merge per operator workflow. Each commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## Setup

- [ ] **Create the feature branch** (we are on `main`; branch first)

Run:
```bash
git checkout -b feat/coil-veto-ledger
```

---

### Task 1: `veto-store.js` scaffold — reasons + read side

**Files:**
- Create: `agent/veto-store.js`
- Create (test): `agent/veto-store.test.mjs`

**Interfaces:**
- Produces:
  - `VALID_REASONS: string[]` — the exact array `['catalyst_driven', 'market_dislocation']`
  - `getReasons(): string[]` — returns a copy of `VALID_REASONS`
  - `readVetoes(projectRoot: string): Promise<object[]>` — parsed array, `[]` when the file is missing

- [ ] **Step 1: Write the failing tests**

Create `agent/veto-store.test.mjs`:
```js
// agent/veto-store.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VALID_REASONS, getReasons, readVetoes } from './veto-store.js';

const _roots = [];
async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'veto-'));
  _roots.push(root);
  return root;
}

after(async () => {
  await Promise.all(_roots.map(r => fs.rm(r, { recursive: true, force: true })));
});

test('getReasons returns the two fixed reasons (copy, not the original)', () => {
  assert.deepEqual(getReasons(), ['catalyst_driven', 'market_dislocation']);
  const copy = getReasons();
  copy.push('mutated');
  assert.deepEqual(VALID_REASONS, ['catalyst_driven', 'market_dislocation']);
});

test('readVetoes returns [] when the file is missing', async () => {
  const root = await tmpRoot();
  assert.deepEqual(await readVetoes(root), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test agent/veto-store.test.mjs`
Expected: FAIL — `Cannot find module './veto-store.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `agent/veto-store.js`:
```js
// agent/veto-store.js
// Coil Veto Ledger store. JSON-array file with atomic writes serialized
// in-process (single-writer). Pure FS + validation. Cloned from tips-store.js.
import fs from 'node:fs/promises';
import path from 'node:path';

export const VALID_REASONS = ['catalyst_driven', 'market_dislocation'];

function vetoesDir(projectRoot) { return path.join(projectRoot, 'data', 'coil-vetoes'); }
function vetoesFile(projectRoot) { return path.join(vetoesDir(projectRoot), 'vetoes.json'); }

export function getReasons() { return [...VALID_REASONS]; }

export async function readVetoes(projectRoot) {
  try {
    const raw = await fs.readFile(vetoesFile(projectRoot), 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test agent/veto-store.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/veto-store.js agent/veto-store.test.mjs docs/superpowers/specs/2026-07-07-coil-veto-ledger-design.md docs/superpowers/plans/2026-07-07-coil-veto-ledger.md
git commit -m "feat(veto): scaffold Coil veto-store (reasons + read side)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `createVeto` — validation + atomic write + serialization

**Files:**
- Modify: `agent/veto-store.js`
- Modify (test): `agent/veto-store.test.mjs`

**Interfaces:**
- Consumes: `VALID_REASONS`, `readVetoes` (from Task 1)
- Produces:
  - `createVeto(projectRoot, { date, ticker, coilEntryRef, reason, notes }): Promise<object>` — validates input, appends a record, returns it. Record shape:
    `{ id, date, ticker, coilEntryRef: number, reason, notes, loggedAt, reconciled: false }`
    where `id` = `veto_{Date.now()}_{TICKER}_{4-char-rand}`.

- [ ] **Step 1: Write the failing tests**

Append to `agent/veto-store.test.mjs` (add `createVeto` to the import on line 7 so it reads
`import { VALID_REASONS, getReasons, readVetoes, createVeto } from './veto-store.js';`):
```js
test('createVeto stores a valid record and returns it', async () => {
  const root = await tmpRoot();
  const v = await createVeto(root, {
    date: '2026-07-07', ticker: 'amat', coilEntryRef: '552.30',
    reason: 'catalyst_driven', notes: 'Meta excess-capacity, semi capex crack',
  });
  assert.equal(v.ticker, 'AMAT');
  assert.equal(v.date, '2026-07-07');
  assert.equal(v.coilEntryRef, 552.3);          // coerced to number
  assert.equal(v.reason, 'catalyst_driven');
  assert.equal(v.reconciled, false);
  assert.ok(v.id.startsWith('veto_'));
  assert.ok(v.loggedAt);
  const all = await readVetoes(root);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, v.id);
});

test('createVeto rejects bad ticker, bad date, bad ref, and unlisted reason', async () => {
  const root = await tmpRoot();
  const ok = { date: '2026-07-07', ticker: 'AMAT', coilEntryRef: 552.3, reason: 'catalyst_driven' };
  await assert.rejects(() => createVeto(root, { ...ok, ticker: '123' }), /ticker/);
  await assert.rejects(() => createVeto(root, { ...ok, date: '07-07-2026' }), /date/);
  await assert.rejects(() => createVeto(root, { ...ok, coilEntryRef: 0 }), /coilEntryRef/);
  await assert.rejects(() => createVeto(root, { ...ok, coilEntryRef: 'abc' }), /coilEntryRef/);
  await assert.rejects(() => createVeto(root, { ...ok, reason: 'gut_feeling' }), /reason/);
  assert.deepEqual(await readVetoes(root), []); // nothing persisted on rejection
});

test('concurrent createVeto calls do not clobber each other', async () => {
  const root = await tmpRoot();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      createVeto(root, { date: '2026-07-07', ticker: 'AMAT', coilEntryRef: 500 + i, reason: 'market_dislocation' })),
  );
  assert.equal((await readVetoes(root)).length, 20);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test agent/veto-store.test.mjs`
Expected: FAIL — `createVeto is not a function` (not yet exported).

- [ ] **Step 3: Write the minimal implementation**

Append to `agent/veto-store.js`:
```js
// In-process write serialization: every read-modify-write chains off the last,
// so concurrent createVeto calls can't clobber each other. (Cloned from tips-store.)
let _writeChain = Promise.resolve();
function serialize(task) {
  const run = _writeChain.then(task, task);
  _writeChain = run.then(() => {}, () => {});
  return run;
}

async function _atomicWriteVetoes(projectRoot, vetoes) {
  const dir = vetoesDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const tmp = vetoesFile(projectRoot) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(vetoes, null, 2));
  await fs.rename(tmp, vetoesFile(projectRoot));
}

export async function createVeto(projectRoot, { date, ticker, coilEntryRef, reason, notes } = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]*$/.test(t)) throw new Error('invalid ticker');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('invalid date (expected YYYY-MM-DD)');
  const ref = Number(coilEntryRef);
  if (!Number.isFinite(ref) || ref <= 0) throw new Error('invalid coilEntryRef');
  if (!VALID_REASONS.includes(reason)) throw new Error(`invalid reason: ${reason}`);

  const veto = {
    id: `veto_${Date.now()}_${t}_${Math.random().toString(36).slice(2, 6)}`,
    date: String(date),
    ticker: t,
    coilEntryRef: ref,
    reason,
    notes: String(notes || '').trim(),
    loggedAt: new Date().toISOString(),
    reconciled: false,
  };

  return serialize(async () => {
    const vetoes = await readVetoes(projectRoot);
    vetoes.push(veto);
    await _atomicWriteVetoes(projectRoot, vetoes);
    return veto;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test agent/veto-store.test.mjs`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add agent/veto-store.js agent/veto-store.test.mjs
git commit -m "feat(veto): add createVeto with validation, atomic write, serialization

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `veto-log.js` CLI — log a veto from the terminal

**Files:**
- Create: `agent/veto-log.js`
- Create (test): `agent/veto-log.test.mjs`

**Interfaces:**
- Consumes: `createVeto` (Task 2)
- Produces:
  - `parseArgs(argv: string[]): object` — maps `--flag value` pairs to `{ flag: value }`; throws on a non-`--` token where a flag is expected.

- [ ] **Step 1: Write the failing test**

Create `agent/veto-log.test.mjs`:
```js
// agent/veto-log.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './veto-log.js';

test('parseArgs maps --flag value pairs', () => {
  const a = parseArgs(['--date', '2026-07-07', '--ticker', 'AMAT', '--ref', '552.30', '--reason', 'catalyst_driven']);
  assert.deepEqual(a, { date: '2026-07-07', ticker: 'AMAT', ref: '552.30', reason: 'catalyst_driven' });
});

test('parseArgs throws when a flag token is malformed', () => {
  assert.throws(() => parseArgs(['ticker', 'AMAT']), /--flag/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test agent/veto-log.test.mjs`
Expected: FAIL — `Cannot find module './veto-log.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `agent/veto-log.js`:
```js
#!/usr/bin/env node
// agent/veto-log.js
// CLI to log a Coil mirror veto. Usage:
//   node agent/veto-log.js --date 2026-07-07 --ticker AMAT --ref 552.30 --reason catalyst_driven --notes "..."
import { pathToFileURL } from 'node:url';
import { createVeto } from './veto-store.js';

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
  const veto = await createVeto(process.cwd(), {
    date: a.date, ticker: a.ticker, coilEntryRef: a.ref, reason: a.reason, notes: a.notes,
  });
  console.log(`logged veto ${veto.id} (${veto.ticker}, ${veto.reason})`);
}

// Run main() only when invoked directly (robust on Windows via pathToFileURL).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test agent/veto-log.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Smoke-test the CLI end-to-end, then commit**

Run (logs a real record into `data/coil-vetoes/vetoes.json`):
```bash
node agent/veto-log.js --date 2026-07-07 --ticker AMAT --ref 552.30 --reason catalyst_driven --notes "Meta excess-capacity; semi capex thesis crack; passed the Coil mirror"
```
Expected: prints `logged veto veto_..._AMAT_.... (AMAT, catalyst_driven)` and the file now contains one record.

```bash
git add agent/veto-log.js agent/veto-log.test.mjs
git commit -m "feat(veto): add veto-log CLI entry point

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- `node --test agent/veto-store.test.mjs agent/veto-log.test.mjs` is green (7 tests).
- `node agent/veto-log.js ...` writes a record to `data/coil-vetoes/vetoes.json`.
- The existing `agent/tips-store.js` and its tests are untouched.
- Phase 2 (reconciliation + scorecard against the bot's closed Coil paper trades) is deferred to its own spec/plan once ~5–10 vetoes exist.
