# Accounts Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Accounts tab from sandbox-identities-as-accounts to real Alpaca accounts with multi-sandbox-per-account support, splitting secrets into a gitignored file behind a `CredentialStore` interface.

**Architecture:** Two-file split — `data/agent-config.json` (metadata, schemaVersion 5) + `data/accounts-secrets.json` (gitignored). All credential I/O goes through `agent/credential-store.js`. Migration v4→v5 dedups env-seeded accounts, rewrites sandbox.accountId pointers, rekeys runtime dirs from `data/sandboxes/<accountId>/` to `data/sandboxes/<sandboxId>/`, extracts secrets to the new store. UI gains a `POST /api/sandboxes` endpoint for dropdown-based sandbox creation.

**Tech Stack:** Node.js ESM, Express, vanilla-JS single-file SPA (`agent/public/index.html`), `node --test` for testing.

**Spec:** `docs/superpowers/specs/2026-05-18-accounts-tab-redesign-design.md` — read first for decisions and rationale.

---

## Pre-flight (already complete)

- ✅ `agent/orchestrator.js` Turtle-scheduler gate committed (user confirmed 2026-05-18).
- ✅ Spec committed to `docs/superpowers/specs/2026-05-18-accounts-tab-redesign-design.md`.

## Branch setup (before Task 1)

Create the implementation branch off `main` (NOT off `fix-regime-stress-followups` — that branch is a separate PR). The spec doc was committed on `fix-regime-stress-followups`, which is fine — it'll come along when that PR merges.

```bash
git fetch origin
git checkout -b feat-accounts-tab-redesign origin/main
# If fix-regime-stress-followups has merged, the spec doc is already in main.
# If not, cherry-pick it (one commit) so this branch has the spec for reference:
#   git cherry-pick <spec-commit-sha>
```

---

### Task 1: .gitignore + accounts-secrets example file

**Files:**
- Modify: `.gitignore`
- Create: `data/accounts-secrets.example.json`

The umbrella `data/` rule in `.gitignore` (line 38) already covers `data/accounts-secrets.json` and `data/backups/` — no new ignore rules needed for them. But the example file lives under `data/` too, so it needs an explicit un-ignore (`!`) rule to be tracked.

- [ ] **Step 1: Add the un-ignore rule to `.gitignore`**

Append below the existing `data/` line (after line 38), under a clarifying comment:

```
# Force-include the example file so the secrets-file shape is discoverable
!data/accounts-secrets.example.json
```

- [ ] **Step 2: Create the example file**

Write `data/accounts-secrets.example.json`:

```json
{
  "EXAMPLE_ACCOUNT_ID": {
    "publicKey": "PK_PUT_YOUR_ALPACA_KEY_HERE",
    "secretKey": "PUT_YOUR_ALPACA_SECRET_HERE"
  }
}
```

- [ ] **Step 3: Verify .gitignore behavior**

Run: `git check-ignore -v data/accounts-secrets.example.json`
Expected: empty output, exit code 1 (file is NOT ignored).

Run: `git check-ignore -v data/accounts-secrets.json`
Expected: matches `data/` rule.

- [ ] **Step 4: Commit**

```bash
git add .gitignore data/accounts-secrets.example.json
git commit -m "chore: track accounts-secrets.example.json template"
```

---

### Task 2: CredentialStore module (TDD)

**Files:**
- Create: `agent/credential-store.js`
- Create: `agent/credential-store.test.mjs`

**Reading first:** `agent/config-store.js:602-609` for the `_writeLock` serialized-promise pattern to copy.

- [ ] **Step 1: Write the failing tests**

Create `agent/credential-store.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function withTempFile(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-store-'));
  const file = path.join(dir, 'accounts-secrets.json');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('loadCredentialStore with no file: empty store, no write happens', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    assert.equal(store.getCredentials('anything'), null);
    assert.deepEqual(store.listAccountIds(), []);
    // Should NOT have created the file just from a read
    await assert.rejects(fs.access(file), /ENOENT/);
  });
});

test('loadCredentialStore with malformed JSON: throws loud', async () => {
  await withTempFile(async (file) => {
    await fs.writeFile(file, '{not valid json');
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await assert.rejects(
      () => store.loadCredentialStore(file),
      /credential store.*parse|JSON/i
    );
  });
});

test('setCredentials then getCredentials round-trips', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    await store.setCredentials('acct-1', { publicKey: 'PK1', secretKey: 'SK1' });
    assert.deepEqual(store.getCredentials('acct-1'), { publicKey: 'PK1', secretKey: 'SK1' });
  });
});

test('setCredentials twice for same id: second overwrites (rotation)', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    await store.setCredentials('acct-1', { publicKey: 'PK1', secretKey: 'SK1' });
    await store.setCredentials('acct-1', { publicKey: 'PK2', secretKey: 'SK2' });
    assert.deepEqual(store.getCredentials('acct-1'), { publicKey: 'PK2', secretKey: 'SK2' });
  });
});

test('deleteCredentials removes entry', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    await store.setCredentials('acct-1', { publicKey: 'PK', secretKey: 'SK' });
    await store.deleteCredentials('acct-1');
    assert.equal(store.getCredentials('acct-1'), null);
  });
});

test('listAccountIds returns current keys', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    await store.setCredentials('a', { publicKey: 'P', secretKey: 'S' });
    await store.setCredentials('b', { publicKey: 'P', secretKey: 'S' });
    assert.deepEqual(store.listAccountIds().sort(), ['a', 'b']);
  });
});

test('concurrent setCredentials calls serialize (final state = last write)', async () => {
  await withTempFile(async (file) => {
    const store = await import('./credential-store.js?cachebust=' + Date.now());
    await store.loadCredentialStore(file);
    // Kick off 5 writes in parallel; the last to be queued wins.
    const writes = [];
    for (let i = 0; i < 5; i++) {
      writes.push(store.setCredentials('a', { publicKey: 'PK' + i, secretKey: 'SK' + i }));
    }
    await Promise.all(writes);
    // The file on disk should match the in-memory state — no torn write
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'));
    assert.deepEqual(onDisk['a'], store.getCredentials('a'));
  });
});

test('persistence: load → set → re-load round-trips through disk', async () => {
  await withTempFile(async (file) => {
    const store1 = await import('./credential-store.js?cachebust=A' + Date.now());
    await store1.loadCredentialStore(file);
    await store1.setCredentials('acct-1', { publicKey: 'PK', secretKey: 'SK' });

    // Fresh module load reading the same file
    const store2 = await import('./credential-store.js?cachebust=B' + Date.now());
    await store2.loadCredentialStore(file);
    assert.deepEqual(store2.getCredentials('acct-1'), { publicKey: 'PK', secretKey: 'SK' });
  });
});
```

The `?cachebust=` query trick gives each test a fresh module instance so they don't share the module-level `_store` state. This is a node-test idiom for testing modules that hold private state.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/credential-store.test.mjs`
Expected: All fail with `Cannot find module './credential-store.js'`.

- [ ] **Step 3: Write the implementation**

Create `agent/credential-store.js`:

```js
// Per-account Alpaca credential storage.
// Lives outside agent-config.json so secrets stay out of the file most
// operators copy around when debugging. Phase 2: swap this implementation
// for one backed by Windows DPAPI without changing the public interface.
import fs from 'fs/promises';
import path from 'path';

let _store = {};
let _filePath = null;
let _writeLock = Promise.resolve();
let _loaded = false;

export async function loadCredentialStore(filePath) {
  _filePath = filePath;
  _store = {};
  _loaded = true;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    try {
      _store = JSON.parse(raw);
    } catch (parseErr) {
      throw new Error(`credential store parse failed at ${filePath}: ${parseErr.message}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No file yet — empty store, no write until first setCredentials.
      return;
    }
    throw err;
  }
}

function assertLoaded() {
  if (!_loaded) throw new Error('credential store not loaded — call loadCredentialStore(filePath) first');
}

export function getCredentials(accountId) {
  assertLoaded();
  const entry = _store[accountId];
  if (!entry) return null;
  return { publicKey: entry.publicKey, secretKey: entry.secretKey };
}

export function listAccountIds() {
  assertLoaded();
  return Object.keys(_store);
}

export async function setCredentials(accountId, { publicKey, secretKey }) {
  assertLoaded();
  if (!publicKey || !secretKey) {
    throw new Error('setCredentials requires both publicKey and secretKey');
  }
  _store[accountId] = { publicKey, secretKey };
  await _persist();
}

export async function deleteCredentials(accountId) {
  assertLoaded();
  if (!(accountId in _store)) return;
  delete _store[accountId];
  await _persist();
}

function _persist() {
  // Serialize file writes via the same chained-promise lock pattern config-store uses.
  // The chain captures the CURRENT _store snapshot value at the moment the write
  // actually runs, so concurrent setCredentials calls produce a consistent final state.
  _writeLock = _writeLock.then(async () => {
    await fs.mkdir(path.dirname(_filePath), { recursive: true });
    await fs.writeFile(_filePath, JSON.stringify(_store, null, 2));
  }).catch(err => {
    console.error('credential-store persist error:', err.message);
    throw err;
  });
  return _writeLock;
}

// Test-only: reset internal state. Used by integration tests that re-init.
export function _resetForTests() {
  _store = {};
  _filePath = null;
  _writeLock = Promise.resolve();
  _loaded = false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test agent/credential-store.test.mjs`
Expected: All 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/credential-store.js agent/credential-store.test.mjs
git commit -m "feat(credential-store): add JSON-file-backed credential store with locking"
```

---

### Task 3: Integrate CredentialStore into config-store

**Files:**
- Modify: `agent/config-store.js`
- Create: `agent/config-store.test.mjs`

**What changes in `agent/config-store.js`:**
- `loadConfig()` calls `loadCredentialStore(path.join(__dirname, '..', 'data', 'accounts-secrets.json'))` after the config JSON is parsed, before `syncLegacyAliases`.
- `getAccountById(id)` merges metadata + creds at read time.
- `addAccount({ name, publicKey, secretKey, baseUrl, paper })` writes metadata via `saveConfig`, then `setCredentials`. On credential-write failure, pop the just-pushed account, `saveConfig` again, rethrow.
- `updateAccount(id, { name, baseUrl, paper, publicKey, secretKey })` accepts optional `publicKey` + `secretKey`. Both-or-neither; otherwise throw.
- `removeAccount(id)` calls `deleteCredentials`.
- `addAccount` no longer auto-creates a sandbox (moved to Task 4).

This task does the credential split but keeps the existing on-disk shape with `publicKey`/`secretKey` still inside `accounts[]` — the migration in Task 5 removes them. This keeps Task 3 a pure refactor that any existing v4 config continues to work with.

- [ ] **Step 1: Write the failing tests**

Create `agent/config-store.test.mjs`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// We need to control where config-store reads/writes from. The module hard-codes
// path.join(__dirname, '..', 'data', 'agent-config.json') and the parallel
// secrets file. The cleanest test setup is: build a temp project root, chdir
// into it, then dynamic-import config-store with a cachebust so it picks up
// the new __dirname-relative paths. But __dirname in the module is fixed at
// load time. Instead, we use the module's existing CONFIG_PATH constant by
// pre-populating data/agent-config.json under the real project root in a way
// the test cleans up after — too risky. We expose test hooks.
//
// Decision: add a tiny test-only setter `_setPathsForTests({ configPath, secretsPath })`
// to config-store. Tests use it; production code never calls it.

let cfgStore;
let credStore;
let tmpDir;
let configPath;
let secretsPath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfg-store-'));
  configPath = path.join(tmpDir, 'agent-config.json');
  secretsPath = path.join(tmpDir, 'accounts-secrets.json');
  // Fresh module instances per test. The cachebust query forces Node's ESM
  // loader to give us a NEW module instance so module-level state (the _store,
  // _config, etc.) doesn't leak between tests.
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  credStore = await import('./credential-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath });
  // Critical: tell cfgStore to use the SAME credential-store instance the test
  // reads from. Without this, cfgStore's internally-bound _credStore is a
  // different instance and writes/reads diverge.
  cfgStore._setCredStoreForTests(credStore);
});

test('addAccount: writes metadata to config and creds to credential store', async () => {
  await cfgStore.loadConfig();
  const account = await cfgStore.addAccount({
    name: 'Test',
    publicKey: 'PK_TEST',
    secretKey: 'SK_TEST',
    baseUrl: 'https://paper-api.alpaca.markets',
    paper: true,
  });

  const onDiskCfg = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  const acct = onDiskCfg.accounts.find(a => a.id === account.id);
  assert.ok(acct, 'account row exists in config');
  assert.equal(acct.publicKey, 'PK_TEST', 'config still carries publicKey until migration v5');
  // Creds also written to secrets file via credential store
  const onDiskSecrets = JSON.parse(await fs.readFile(secretsPath, 'utf-8'));
  assert.deepEqual(onDiskSecrets[account.id], { publicKey: 'PK_TEST', secretKey: 'SK_TEST' });
});

test('getAccountById returns merged metadata + creds shape', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({
    name: 'M', publicKey: 'PK', secretKey: 'SK', baseUrl: 'x', paper: true,
  });
  const got = cfgStore.getAccountById(a.id);
  assert.equal(got.publicKey, 'PK');
  assert.equal(got.secretKey, 'SK');
  assert.equal(got.name, 'M');
});

test('addAccount rolls back metadata when credential write fails', async () => {
  await cfgStore.loadConfig();
  // Monkey-patch setCredentials to throw
  const origSet = credStore.setCredentials;
  credStore.setCredentials = async () => { throw new Error('disk full'); };
  cfgStore._setCredStoreForTests(credStore);

  await assert.rejects(
    () => cfgStore.addAccount({ name: 'X', publicKey: 'PK', secretKey: 'SK', baseUrl: 'x', paper: true }),
    /disk full/
  );

  const cfg = cfgStore.getConfig();
  assert.equal(cfg.accounts.length, 0, 'account row was rolled back');

  credStore.setCredentials = origSet;
});

test('updateAccount with both publicKey + secretKey rotates via credential store', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'X', publicKey: 'OLD_PK', secretKey: 'OLD_SK', baseUrl: 'x', paper: true });
  await cfgStore.updateAccount(a.id, { publicKey: 'NEW_PK', secretKey: 'NEW_SK' });
  assert.deepEqual(credStore.getCredentials(a.id), { publicKey: 'NEW_PK', secretKey: 'NEW_SK' });
});

test('updateAccount with only publicKey throws (both-or-neither)', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'X', publicKey: 'PK', secretKey: 'SK', baseUrl: 'x', paper: true });
  await assert.rejects(
    () => cfgStore.updateAccount(a.id, { publicKey: 'NEW_PK_ONLY' }),
    /both publicKey and secretKey/i
  );
});

test('updateAccount with neither key leaves credentials untouched', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'X', publicKey: 'PK', secretKey: 'SK', baseUrl: 'x', paper: true });
  await cfgStore.updateAccount(a.id, { name: 'Renamed' });
  assert.deepEqual(credStore.getCredentials(a.id), { publicKey: 'PK', secretKey: 'SK' });
});

test('removeAccount deletes both the metadata row and the credentials', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'X', publicKey: 'PK', secretKey: 'SK', baseUrl: 'x', paper: true });
  await cfgStore.removeAccount(a.id);
  assert.equal(cfgStore.getAccountById(a.id), null);
  assert.equal(credStore.getCredentials(a.id), null);
});

test('getAccountById returns null creds when secrets are missing for that id', async () => {
  await cfgStore.loadConfig();
  // Synthesize an orphan: write a metadata-only account directly
  const cfg = cfgStore.getConfig();
  cfg.accounts.push({ id: 'orphan', name: 'O', baseUrl: 'x', paper: true, createdAt: new Date().toISOString() });
  const got = cfgStore.getAccountById('orphan');
  assert.equal(got.publicKey, null);
  assert.equal(got.secretKey, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/config-store.test.mjs`
Expected: Fails immediately because `_setPathsForTests` doesn't exist yet.

- [ ] **Step 3: Modify `agent/config-store.js` — add test hooks**

At the top of `agent/config-store.js` (after the existing constants around line 10), add:

```js
let CONFIG_PATH_OVERRIDE = null;
let SECRETS_PATH_OVERRIDE = null;

export function _setPathsForTests({ configPath, secretsPath }) {
  CONFIG_PATH_OVERRIDE = configPath;
  SECRETS_PATH_OVERRIDE = secretsPath;
  // Force re-init on next loadConfig
  _config = null;
}

// Test hook: replace the bound credential-store module (lets tests inject failures)
let _credStoreOverride = null;
export function _setCredStoreForTests(mod) { _credStoreOverride = mod; }
function credStore() {
  return _credStoreOverride || _credStore;
}
```

And replace the bare `CONFIG_PATH` constant with a getter:

```js
function getConfigPath() {
  return CONFIG_PATH_OVERRIDE || path.join(__dirname, '..', 'data', 'agent-config.json');
}
function getSecretsPath() {
  return SECRETS_PATH_OVERRIDE || path.join(__dirname, '..', 'data', 'accounts-secrets.json');
}
```

Update `loadConfig()` and `saveConfig()` (lines 557-609 in the current file) to call `getConfigPath()` instead of the constant.

- [ ] **Step 4: Modify `agent/config-store.js` — wire up the credential store**

At the top of `agent/config-store.js`, add the import:

```js
import * as _credStore from './credential-store.js';
```

Inside `loadConfig()`, after `_config = normalizeConfig(...)` and before the env-seed block, add:

```js
await credStore().loadCredentialStore(getSecretsPath());
```

(The env-seed block gets deleted entirely in Task 7. Leave it for now, but make it idempotent against multiple calls.)

Modify `getAccountById(id)` (currently `agent/config-store.js:720-722`) to merge:

```js
export function getAccountById(id) {
  const meta = _config.accounts.find(a => a.id === id);
  if (!meta) return null;
  const creds = credStore().getCredentials(id) || { publicKey: null, secretKey: null };
  // Metadata may still carry publicKey/secretKey on a v4 config (pre-migration).
  // Spread order: meta first, creds second — credential-store wins when present.
  return { ...meta, ...creds };
}
```

Modify `addAccount(...)` (currently `agent/config-store.js:654-680`) to split metadata + creds, no longer auto-create a sandbox (Task 4 adds the helper), and rollback on credential failure:

```js
export async function addAccount({ name, publicKey, secretKey, baseUrl, paper }) {
  if (!publicKey || !secretKey) throw new Error('publicKey and secretKey are required');
  const id = crypto.randomUUID().slice(0, 8);
  const account = {
    id,
    name: name || `Account ${_config.accounts.length + 1}`,
    baseUrl: baseUrl || (paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'),
    paper: paper !== false,
    createdAt: new Date().toISOString(),
  };
  _config.accounts.push(account);
  await saveConfig();
  try {
    await credStore().setCredentials(id, { publicKey, secretKey });
  } catch (err) {
    // Roll back the metadata push so we never persist an account without creds.
    _config.accounts = _config.accounts.filter(a => a.id !== id);
    await saveConfig();
    throw err;
  }
  syncLegacyAliases(_config);
  return { ...account, publicKey, secretKey };
}
```

Modify `updateAccount(id, ...)` (currently `agent/config-store.js:682-694`):

```js
export async function updateAccount(id, { name, baseUrl, paper, publicKey, secretKey }) {
  const account = _config.accounts.find(a => a.id === id);
  if (!account) throw new Error('Account not found');
  if (name !== undefined && name.trim()) account.name = name.trim();
  if (baseUrl !== undefined) account.baseUrl = baseUrl.trim() || (account.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets');
  if (paper !== undefined) account.paper = paper;

  const hasPk = publicKey !== undefined && publicKey !== '';
  const hasSk = secretKey !== undefined && secretKey !== '';
  if (hasPk !== hasSk) {
    throw new Error('Rotation requires both publicKey and secretKey (or neither)');
  }
  if (hasPk && hasSk) {
    await credStore().setCredentials(id, { publicKey, secretKey });
  }

  // Keep sandbox name in sync when account name changes — but only sandboxes
  // that still carry the legacy 1:1 default sandbox name.
  if (name !== undefined && name.trim()) {
    for (const sandbox of Object.values(_config.sandboxes || {})) {
      if (sandbox.accountId === id && sandbox.name === account.name) {
        sandbox.name = name.trim();
      }
    }
  }
  syncLegacyAliases(_config);
  await saveConfig();
  return account;
}
```

Modify `removeAccount(id)` (currently `agent/config-store.js:696-706`). Note: this task makes it credential-aware; Task 10 adds the 409-on-attached-sandboxes guard at the API layer.

```js
export async function removeAccount(id) {
  _config.accounts = _config.accounts.filter(a => a.id !== id);
  await credStore().deleteCredentials(id);
  // Sandbox cleanup is the API layer's job — under the new model, the API
  // returns 409 if any sandbox references this account, so we only get here
  // when no sandboxes remain. Defensive deletion of any sbx_<id> orphan:
  if (_config.sandboxes[`sbx_${id}`]) delete _config.sandboxes[`sbx_${id}`];
  if (_config.activeAccountId === id) {
    const next = _config.accounts[0]?.id || null;
    _config.activeAccountId = next;
    _config.activeSandboxId = next ? Object.values(_config.sandboxes).find(s => s.accountId === next)?.id || null : null;
  }
  syncLegacyAliases(_config);
  await saveConfig();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test agent/config-store.test.mjs`
Expected: All 8 tests pass.

- [ ] **Step 6: Run the full existing test suite to catch regressions**

Run: `npm test`
Expected: pre-existing tests still pass. (If any test was relying on the old `addAccount` auto-creating a sandbox, fix the test or note it for Task 4.)

- [ ] **Step 7: Commit**

```bash
git add agent/config-store.js agent/config-store.test.mjs
git commit -m "feat(config-store): split account credentials into credential-store"
```

---

### Task 4: createSandboxForAccount helper

**Files:**
- Modify: `agent/config-store.js`
- Modify: `agent/config-store.test.mjs` (extend)

Today, sandbox creation happens implicitly inside `addAccount` (1:1) and inside `clone`. With multi-sandbox-per-account, we need an explicit `createSandboxForAccount` helper. The existing `createSandbox(account, overrides)` private helper (line 371) still does the object construction; we just need a public wrapper that picks a unique sandbox id, registers it, and persists.

- [ ] **Step 1: Write the failing tests** (append to `agent/config-store.test.mjs`)

```js
test('createSandboxForAccount: generates sbx_<uuid8> distinct from sbx_<accountId>', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'A', publicKey: 'PK', secretKey: 'SK', baseUrl: 'x', paper: true });
  const sbx = await cfgStore.createSandboxForAccount(a.id, { name: 'First' });
  assert.equal(sbx.accountId, a.id);
  assert.notEqual(sbx.id, `sbx_${a.id}`, 'sandbox id is no longer derived from accountId');
  assert.match(sbx.id, /^sbx_[0-9a-f]{8}$/);
  assert.equal(sbx.name, 'First');
});

test('createSandboxForAccount: two calls produce distinct sandboxes pointing at same account', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'A', publicKey: 'PK', secretKey: 'SK', baseUrl: 'x', paper: true });
  const sbx1 = await cfgStore.createSandboxForAccount(a.id, { name: 'One' });
  const sbx2 = await cfgStore.createSandboxForAccount(a.id, { name: 'Two' });
  assert.notEqual(sbx1.id, sbx2.id);
  assert.equal(sbx1.accountId, a.id);
  assert.equal(sbx2.accountId, a.id);
});

test('createSandboxForAccount: throws if accountId unknown', async () => {
  await cfgStore.loadConfig();
  await assert.rejects(
    () => cfgStore.createSandboxForAccount('nope', { name: 'X' }),
    /account not found/i
  );
});

test('createSandboxForAccount: applies agentId override when provided', async () => {
  await cfgStore.loadConfig();
  const a = await cfgStore.addAccount({ name: 'A', publicKey: 'PK', secretKey: 'SK', baseUrl: 'x', paper: true });
  const sbx = await cfgStore.createSandboxForAccount(a.id, { name: 'Harvest sbx', agentId: 'harvest' });
  assert.equal(sbx.agent.activeAgentId, 'harvest');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/config-store.test.mjs`
Expected: 4 new tests fail with `cfgStore.createSandboxForAccount is not a function`.

- [ ] **Step 3: Implement `createSandboxForAccount`**

Add to `agent/config-store.js` (placement: after `setActiveAccount`, near the existing sandbox helpers around line 632):

```js
export async function createSandboxForAccount(accountId, { name, agentId } = {}) {
  const account = _config.accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');
  const sandboxId = `sbx_${crypto.randomUUID().slice(0, 8)}`;
  const sandbox = createSandbox(account, {
    id: sandboxId,
    name: name || account.name,
    activeAgentId: agentId || _config.activeAgentId,
    activeModel: _config.activeModel,
    heartbeat: _config.heartbeat,
    permissions: _config.permissions,
    plugins: _config.plugins,
  });
  _config.sandboxes[sandboxId] = sandbox;
  if (!_config.activeSandboxId) {
    _config.activeSandboxId = sandboxId;
    _config.activeAccountId = accountId;
  }
  syncLegacyAliases(_config);
  await saveConfig();
  return sandbox;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test agent/config-store.test.mjs`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/config-store.js agent/config-store.test.mjs
git commit -m "feat(config-store): add createSandboxForAccount for multi-sandbox-per-account"
```

---

### Task 5: Migration v4→v5 — account dedup + secrets extraction + backup

**Files:**
- Modify: `agent/config-store.js` (extend `migrateLegacyConfig` at line 477)
- Create: `agent/migration-v5.test.mjs`

This task handles the config-side migration (dedup + secrets extraction + schemaVersion bump + backup). Task 6 handles the on-disk runtime-dir rekey.

- [ ] **Step 1: Write the failing tests**

Create `agent/migration-v5.test.mjs`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let cfgStore, credStore, tmpDir, configPath, secretsPath, backupDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-v5-'));
  configPath = path.join(tmpDir, 'agent-config.json');
  secretsPath = path.join(tmpDir, 'accounts-secrets.json');
  backupDir = path.join(tmpDir, 'backups');
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  credStore = await import('./credential-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir });
  // See note in config-store.test.mjs about why this matters
  cfgStore._setCredStoreForTests(credStore);
});

const v4Fixture = {
  schemaVersion: 4,
  activeAccountId: '6e4f26af',
  activeSandboxId: 'sbx_6e4f26af',
  activeAgentId: 'default',
  activeModel: 'anthropic/claude-sonnet-4-6',
  heartbeat: { pre_market: 900, market_open: 120, midday: 300, market_close: 120, after_hours: 7200, closed: 28800 },
  permissions: { allowLiveTrading: true, maxPositionPct: 15, maxDeployedPct: 80, maxDailyLoss: 5, maxOpenPositions: 10, maxOrderValue: 0, allowedTools: [], blockedTools: [], allowOptions: true, allowStocks: true, allow0DTE: false, requireConfirmation: false, maxToolRoundsPerBeat: 25 },
  plugins: { slack: { enabled: false, webhookUrl: '', channel: '', notifyOn: {} } },
  accounts: [
    { id: '6e4f26af', name: 'Paper (from .env)', publicKey: 'PK_SHARED', secretKey: 'SK_SHARED', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-11T12:47:51.486Z' },
    { id: '449fedf6', name: 'Harvest', publicKey: 'PK_SHARED', secretKey: 'SK_SHARED', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-13T14:17:33.497Z' },
    { id: 'f015e4df', name: 'Turtle', publicKey: 'PK_SHARED', secretKey: 'SK_SHARED', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-13T14:17:47.770Z' },
    { id: '1b6dc838', name: 'Spark', publicKey: 'PK_SHARED', secretKey: 'SK_SHARED', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-15T16:36:32.194Z' },
  ],
  sandboxes: {
    sbx_6e4f26af: { id: 'sbx_6e4f26af', accountId: '6e4f26af', name: 'Paper (from .env)', agent: { activeAgentId: 'default', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-11T12:47:51.486Z' },
    sbx_449fedf6: { id: 'sbx_449fedf6', accountId: '449fedf6', name: 'Harvest', agent: { activeAgentId: 'harvest', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-13T14:17:33.497Z' },
    sbx_f015e4df: { id: 'sbx_f015e4df', accountId: 'f015e4df', name: 'Turtle', agent: { activeAgentId: 'trend-prophet', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-13T14:17:47.770Z' },
    sbx_1b6dc838: { id: 'sbx_1b6dc838', accountId: '1b6dc838', name: 'Spark', agent: { activeAgentId: 'penny-prophet', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-15T16:36:32.194Z' },
  },
  agents: [
    { id: 'default', name: 'Prophet', strategyId: 'v2-options', model: 'anthropic/claude-sonnet-4-6' },
    { id: 'harvest', name: 'Harvest', strategyId: 'harvest', model: 'anthropic/claude-sonnet-4-6' },
    { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend', model: 'anthropic/claude-sonnet-4-6' },
    { id: 'penny-prophet', name: 'Spark', strategyId: 'penny-momentum', model: 'anthropic/claude-sonnet-4-6' },
  ],
  strategies: [],
  models: [],
};

test('v4→v5: 4 duplicate accounts dedup to 1 survivor, sandbox pointers rewritten', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const cfg = cfgStore.getConfig();

  assert.equal(cfg.schemaVersion, 5);
  assert.equal(cfg.accounts.length, 1, 'deduped to one account');
  const survivorId = cfg.accounts[0].id;
  assert.equal(cfg.accounts[0].name, 'Paper (from .env)', 'env-seeded account is survivor by name match');

  for (const sbx of Object.values(cfg.sandboxes)) {
    assert.equal(sbx.accountId, survivorId, `sandbox ${sbx.id} repointed at survivor`);
  }
});

test('v4→v5: surviving account row has NO publicKey/secretKey fields', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  assert.equal(onDisk.accounts[0].publicKey, undefined);
  assert.equal(onDisk.accounts[0].secretKey, undefined);
});

test('v4→v5: accounts-secrets.json contains survivor creds', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const onDisk = JSON.parse(await fs.readFile(secretsPath, 'utf-8'));
  const ids = Object.keys(onDisk);
  assert.equal(ids.length, 1);
  assert.deepEqual(onDisk[ids[0]], { publicKey: 'PK_SHARED', secretKey: 'SK_SHARED' });
});

test('v4→v5: backup file is written under backups/ before mutation', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const backups = await fs.readdir(backupDir);
  const v4Backup = backups.find(f => /^agent-config\.v4\.[0-9TZ:-]+\.json$/.test(f));
  assert.ok(v4Backup, `expected a v4 backup, got: ${backups.join(', ')}`);
  const backupContents = JSON.parse(await fs.readFile(path.join(backupDir, v4Backup), 'utf-8'));
  assert.equal(backupContents.schemaVersion, 4);
  assert.equal(backupContents.accounts.length, 4);
});

test('v4→v5: idempotent — re-running on v5 config is a no-op', async () => {
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();
  const afterFirst = await fs.readFile(configPath, 'utf-8');

  // Re-init module + re-load
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir });
  await cfgStore.loadConfig();
  const afterSecond = await fs.readFile(configPath, 'utf-8');

  assert.equal(JSON.parse(afterFirst).schemaVersion, 5);
  assert.equal(JSON.parse(afterSecond).schemaVersion, 5);

  // No second backup file written on the no-op migration
  const backups = await fs.readdir(backupDir);
  const v4Backups = backups.filter(f => /^agent-config\.v4\./.test(f));
  assert.equal(v4Backups.length, 1, 'only one backup, from the original v4→v5 migration');
});

test('v4→v5: single-account v4 config still extracts secrets, no merge happens', async () => {
  const single = { ...v4Fixture, accounts: [v4Fixture.accounts[0]], sandboxes: { sbx_6e4f26af: v4Fixture.sandboxes.sbx_6e4f26af } };
  await fs.writeFile(configPath, JSON.stringify(single));
  await cfgStore.loadConfig();
  const cfg = cfgStore.getConfig();
  assert.equal(cfg.accounts.length, 1);
  assert.equal(cfg.accounts[0].publicKey, undefined);
  const onDiskSecrets = JSON.parse(await fs.readFile(secretsPath, 'utf-8'));
  assert.deepEqual(onDiskSecrets['6e4f26af'], { publicKey: 'PK_SHARED', secretKey: 'SK_SHARED' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/migration-v5.test.mjs`
Expected: All fail — `schemaVersion` is still 4 after `loadConfig`, no backup, etc.

- [ ] **Step 3: Extend `_setPathsForTests` to accept `backupDir`**

In `agent/config-store.js`, update the test hook from Task 3:

```js
let BACKUP_DIR_OVERRIDE = null;
export function _setPathsForTests({ configPath, secretsPath, backupDir } = {}) {
  CONFIG_PATH_OVERRIDE = configPath ?? null;
  SECRETS_PATH_OVERRIDE = secretsPath ?? null;
  BACKUP_DIR_OVERRIDE = backupDir ?? null;
  _config = null;
}
function getBackupDir() {
  return BACKUP_DIR_OVERRIDE || path.join(__dirname, '..', 'data', 'backups');
}
```

- [ ] **Step 4: Extend `migrateLegacyConfig` for v4→v5**

Modify `agent/config-store.js:477-529` `migrateLegacyConfig`. After the existing v3→v4 block, add the v4→v5 block:

```js
async function migrateLegacyConfig(config, rawSchemaVersion = 0) {
  // ... existing v2→v3 and v3→v4 blocks unchanged ...

  // v4 → v5: dedup accounts sharing the same (publicKey, baseUrl, paper) triple,
  // rewrite sandbox.accountId pointers, extract secrets into the credential store,
  // and strip publicKey/secretKey from accounts[]. Backup is written before mutation.
  if (rawSchemaVersion < 5) {
    // Step 1: backup
    const backupDir = getBackupDir();
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `agent-config.v4.${stamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(config, null, 2));

    // Step 2: dedup accounts
    const groups = new Map();
    for (const acct of config.accounts || []) {
      const key = `${acct.publicKey}|${acct.baseUrl}|${acct.paper}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(acct);
    }
    const idRemap = new Map(); // oldId -> survivorId
    const survivors = [];
    for (const group of groups.values()) {
      const survivor = group.find(a => /\(from \.env\)$/.test(a.name))
        || [...group].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id))[0];
      survivors.push(survivor);
      for (const a of group) {
        idRemap.set(a.id, survivor.id);
      }
    }
    config.accounts = survivors;

    // Step 3: rewrite sandbox.accountId pointers
    let pointerRewrites = 0;
    for (const sbx of Object.values(config.sandboxes || {})) {
      const next = idRemap.get(sbx.accountId);
      if (next && next !== sbx.accountId) {
        sbx.accountId = next;
        pointerRewrites++;
      }
    }

    // Step 4: extract secrets to credential store, strip from accounts[]
    let extracted = 0;
    for (const acct of config.accounts) {
      if (acct.publicKey && acct.secretKey) {
        await credStore().setCredentials(acct.id, { publicKey: acct.publicKey, secretKey: acct.secretKey });
        delete acct.publicKey;
        delete acct.secretKey;
        extracted++;
      }
    }

    const groupCount = groups.size;
    const totalBefore = (rawSchemaVersion === 4 || rawSchemaVersion === 0) ? (config.accounts.length + (groups.size === survivors.length ? 0 : 0)) : '?';
    // Pull a more accurate "before count" from the backup we just wrote
    const beforeCount = JSON.parse(await fs.readFile(backupPath, 'utf-8')).accounts.length;
    console.log(`[migration] v4→v5: deduped ${beforeCount} accounts → ${survivors.length}, rewrote ${pointerRewrites} sandbox pointers, extracted ${extracted} credential sets, backup at ${backupPath}`);
  }

  config.schemaVersion = 5;

  // ... existing sandbox-bootstrap, activeAccountId default, syncLegacyAliases unchanged ...
}
```

Important: `migrateLegacyConfig` is currently synchronous, but the v5 step needs to be async (credential-store writes, file writes). Change the signature to `async function migrateLegacyConfig(...)`. The single caller is in `normalizeConfig` (line 474), which must also be awaited; `loadConfig` (line 557) already does:

```js
_config = normalizeConfig(JSON.parse(raw));
```

Change `normalizeConfig` to `async function normalizeConfig` and the call site in `loadConfig` to `_config = await normalizeConfig(JSON.parse(raw));`. The other `_config = createDefaultConfig();` call site in `loadConfig` (line 564) is synchronous and fine — `normalizeConfig` is only called on the raw-JSON path.

Make sure `credStore().loadCredentialStore(getSecretsPath())` runs BEFORE `normalizeConfig` is called, so the migration's `credStore().setCredentials(...)` calls have a loaded store. In `loadConfig`:

```js
export async function loadConfig() {
  await credStore().loadCredentialStore(getSecretsPath());  // <-- move this to top
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf-8');
    _config = await normalizeConfig(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Warning: Failed to parse config file:', err.message);
    _config = createDefaultConfig();
  }
  // ... rest of loadConfig unchanged for now (env-seed block deleted in Task 7) ...
}
```

- [ ] **Step 5: Run migration tests to verify they pass**

Run: `node --test agent/migration-v5.test.mjs`
Expected: All 6 tests pass.

- [ ] **Step 6: Run the full suite again**

Run: `npm test`
Expected: pre-existing tests still pass; Task 3 + Task 4 + Task 5 tests pass.

- [ ] **Step 7: Commit**

```bash
git add agent/config-store.js agent/migration-v5.test.mjs
git commit -m "feat(migration): v4→v5 dedup accounts + extract secrets + backup"
```

---

### Task 6: Migration v4→v5 — runtime dir rekey

**Files:**
- Modify: `agent/config-store.js` (extend the v4→v5 migration block)
- Modify: `agent/orchestrator.js` (use sandboxId for paths, not accountId)
- Modify: `agent/data-migration.js` (rename function, change parameter)
- Modify: `agent/server.js` (update two call sites of the renamed function)
- Modify: `agent/migration-v5.test.mjs` (add rekey tests)

This is the load-bearing rekey. Strategy: do the on-disk rename inside `migrateLegacyConfig` *after* the in-memory dedup completes, walking `config.sandboxes` and renaming `data/sandboxes/<oldAccountId>/` to `data/sandboxes/<sandboxId>/` for each one. Then update the path consumers.

- [ ] **Step 1: Add the rekey tests (extend `agent/migration-v5.test.mjs`)**

```js
test('v4→v5: runtime dirs rekey from accountId to sandboxId', async () => {
  // Pre-create one runtime dir per old accountId
  for (const acctId of ['6e4f26af', '449fedf6', 'f015e4df', '1b6dc838']) {
    const dir = path.join(tmpDir, 'sandboxes', acctId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'prophet_trader.db'), `db for ${acctId}`);
    await fs.mkdir(path.join(dir, 'activity_logs'), { recursive: true });
    await fs.writeFile(path.join(dir, 'activity_logs', 'sample.log'), `log for ${acctId}`);
  }

  cfgStore._setPathsForTests({
    configPath, secretsPath, backupDir,
    sandboxesRoot: path.join(tmpDir, 'sandboxes'),
  });
  await fs.writeFile(configPath, JSON.stringify(v4Fixture));
  await cfgStore.loadConfig();

  // After rekey, dirs live under sandboxId
  for (const sbxId of ['sbx_6e4f26af', 'sbx_449fedf6', 'sbx_f015e4df', 'sbx_1b6dc838']) {
    const newDir = path.join(tmpDir, 'sandboxes', sbxId);
    await fs.access(newDir);  // throws if missing
    const dbContents = await fs.readFile(path.join(newDir, 'prophet_trader.db'), 'utf-8');
    assert.ok(dbContents.startsWith('db for '), 'db file was moved, not overwritten');
  }

  // Old dirs no longer exist
  for (const acctId of ['6e4f26af', '449fedf6', 'f015e4df', '1b6dc838']) {
    await assert.rejects(
      fs.access(path.join(tmpDir, 'sandboxes', acctId)),
      /ENOENT/,
      `old dir for ${acctId} should be gone`
    );
  }
});

test('v4→v5: rekey is a no-op when target dir already exists (idempotency safety)', async () => {
  await fs.mkdir(path.join(tmpDir, 'sandboxes', 'sbx_6e4f26af'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'sandboxes', 'sbx_6e4f26af', 'marker'), 'preexisting');
  await fs.mkdir(path.join(tmpDir, 'sandboxes', '6e4f26af'), { recursive: true });

  cfgStore._setPathsForTests({
    configPath, secretsPath, backupDir,
    sandboxesRoot: path.join(tmpDir, 'sandboxes'),
  });
  const single = { ...v4Fixture, accounts: [v4Fixture.accounts[0]], sandboxes: { sbx_6e4f26af: v4Fixture.sandboxes.sbx_6e4f26af } };
  await fs.writeFile(configPath, JSON.stringify(single));
  await cfgStore.loadConfig();

  // Pre-existing marker survives — rekey skipped because target already populated
  const marker = await fs.readFile(path.join(tmpDir, 'sandboxes', 'sbx_6e4f26af', 'marker'), 'utf-8');
  assert.equal(marker, 'preexisting');
});
```

- [ ] **Step 2: Extend `_setPathsForTests` for `sandboxesRoot`**

In `agent/config-store.js`:

```js
let SANDBOXES_ROOT_OVERRIDE = null;
export function _setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot } = {}) {
  CONFIG_PATH_OVERRIDE = configPath ?? null;
  SECRETS_PATH_OVERRIDE = secretsPath ?? null;
  BACKUP_DIR_OVERRIDE = backupDir ?? null;
  SANDBOXES_ROOT_OVERRIDE = sandboxesRoot ?? null;
  _config = null;
}
function getSandboxesRoot() {
  return SANDBOXES_ROOT_OVERRIDE || path.join(__dirname, '..', 'data', 'sandboxes');
}
```

- [ ] **Step 3: Add the rekey step to the v4→v5 migration**

In the v4→v5 block of `migrateLegacyConfig`, after pointer rewrite and before/parallel to secret extraction, add:

```js
// Step 3b: rekey runtime dirs from data/sandboxes/<oldAccountId>/ to data/sandboxes/<sandboxId>/
const sandboxesRoot = getSandboxesRoot();
let rekeyed = 0;
for (const sbx of Object.values(config.sandboxes || {})) {
  // The OLD dir is whatever accountId the sandbox pointed at BEFORE rewrite.
  // The reverse-map: find the original accountId via idRemap inverse (the sandbox's
  // current accountId is the survivor; the original is its sbx_<id> suffix when
  // ids were 1:1 in v4 — true for any sandbox the system created itself).
  const originalAccountIdFromSbxId = sbx.id.startsWith('sbx_') ? sbx.id.slice(4) : null;
  const candidates = [
    originalAccountIdFromSbxId,   // most common case under v4's 1:1 convention
    sbx.accountId,                 // post-rewrite survivor dir, if it exists
  ].filter(Boolean);
  const oldDir = (await Promise.all(candidates.map(async c => {
    const p = path.join(sandboxesRoot, c);
    try { await fs.access(p); return p; } catch { return null; }
  }))).find(Boolean);
  if (!oldDir) continue;  // nothing to move (sandbox never had a runtime dir yet)

  const newDir = path.join(sandboxesRoot, sbx.id);
  // Skip if target already populated — caller intentionally pre-staged it
  try {
    const entries = await fs.readdir(newDir);
    if (entries.length > 0) continue;
  } catch { /* newDir doesn't exist, good */ }

  if (oldDir === newDir) continue;  // already correctly keyed
  await fs.mkdir(path.dirname(newDir), { recursive: true });
  await fs.rename(oldDir, newDir);
  rekeyed++;
}
console.log(`[migration] v4→v5 rekeyed ${rekeyed} runtime dirs`);
```

The candidate lookup handles both: (a) the common case where the runtime dir was at `data/sandboxes/<accountId>/` and the sandbox id was `sbx_<accountId>` (everything we have today), and (b) post-rewrite where the dir might already be at `data/sandboxes/<survivorAccountId>/`.

- [ ] **Step 4: Update `agent/orchestrator.js` to key paths by sandboxId**

Modify `agent/orchestrator.js:54-58`:

```js
getSandboxDbPath(sandboxId) {
  return path.join(this.projectRoot, 'data', 'sandboxes', sandboxId, 'prophet_trader.db');
}
```

Modify `agent/orchestrator.js:187` (inside the env build inside `startGoBackend`):

```js
ACTIVITY_LOG_DIR: path.join(this.projectRoot, 'data', 'sandboxes', sandboxId, 'activity_logs'),
```

- [ ] **Step 5: Update `agent/data-migration.js`**

Rename `migrateLegacyDataForAccount(accountId)` to `migrateLegacyDataForSandbox(sandboxId)` and change the sandbox root path. The function originally moved root-level `activity_logs/`, `decisive_actions/`, `news_summaries/`, and `prophet_trader.db` into the per-account dir. Under v5+, the per-sandbox dir is the target.

Full replacement for `agent/data-migration.js` lines 42-78:

```js
export async function migrateLegacyDataForSandbox(sandboxId) {
  if (!sandboxId) return { migrated: false, copied: [] };

  const sandboxRoot = path.join(PROJECT_ROOT, 'data', 'sandboxes', sandboxId);
  const markerPath = path.join(sandboxRoot, '.migrated-from-root.json');
  if (await exists(markerPath)) {
    return { migrated: false, copied: [] };
  }

  const copied = [];
  const dirMappings = [
    ['activity_logs', path.join(sandboxRoot, 'activity_logs')],
    ['decisive_actions', path.join(sandboxRoot, 'decisive_actions')],
    ['news_summaries', path.join(sandboxRoot, 'news_summaries')],
  ];

  for (const [sourceName, targetDir] of dirMappings) {
    const sourceDir = path.join(PROJECT_ROOT, sourceName);
    if (await copyDirIfNeeded(sourceDir, targetDir)) {
      copied.push(sourceName);
    }
  }

  const dbSource = path.join(PROJECT_ROOT, 'data', 'prophet_trader.db');
  const dbTarget = path.join(sandboxRoot, 'prophet_trader.db');
  if (await copyFileIfNeeded(dbSource, dbTarget)) copied.push('prophet_trader.db');
  if (await copyFileIfNeeded(`${dbSource}-wal`, `${dbTarget}-wal`)) copied.push('prophet_trader.db-wal');
  if (await copyFileIfNeeded(`${dbSource}-shm`, `${dbTarget}-shm`)) copied.push('prophet_trader.db-shm');

  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify({
    migratedAt: new Date().toISOString(),
    copied,
  }, null, 2));

  return { migrated: copied.length > 0, copied };
}

export default {
  migrateLegacyDataForSandbox,
};
```

- [ ] **Step 6: Update `agent/server.js` call sites**

Find both call sites:

```bash
grep -n "migrateLegacyDataForAccount" agent/server.js
```

Two call sites today: `server.js:18` (the import) and call sites at `server.js:63` and `server.js:1059`.

Replace the import (`server.js:18`):

```js
import { migrateLegacyDataForSandbox } from './data-migration.js';
```

Replace the boot-time call (currently around `server.js:63`):

```js
const initialActiveSandbox = getActiveSandbox();
if (initialActiveSandbox?.id) {
  const migration = await migrateLegacyDataForSandbox(initialActiveSandbox.id);
  if (migration.migrated) {
    console.log(`  Migrated legacy data into sandbox ${initialActiveSandbox.id}: ${migration.copied.join(', ')}`);
  }
}
```

Replace the activate-handler call (currently around `server.js:1059`):

```js
// Inside POST /api/accounts/:id/activate, after setActiveAccount
const activeSandbox = getActiveSandbox();
if (activeSandbox?.id) {
  await migrateLegacyDataForSandbox(activeSandbox.id);
}
```

- [ ] **Step 7: Run rekey tests to verify they pass**

Run: `node --test agent/migration-v5.test.mjs`
Expected: All tests pass including the 2 new rekey tests.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add agent/config-store.js agent/orchestrator.js agent/data-migration.js agent/server.js agent/migration-v5.test.mjs
git commit -m "feat(migration): rekey runtime dirs by sandboxId, update path consumers"
```

---

### Task 7: Remove .env account-seed mechanisms

**Files:**
- Modify: `agent/config-store.js` (delete the env-seed block in `loadConfig`)
- Modify: `agent/server.js` (delete the ALPACA_PUBLIC_KEY_2 boot re-seed block)

Per spec decision Q3: `.env` is no longer a creation path. UI is the only way.

- [ ] **Step 1: Delete `agent/config-store.js` env-seed block**

Remove lines `566-595` (the entire block from `const envPk = process.env.ALPACA_PUBLIC_KEY` through `await saveConfig();`). The final `await saveConfig();` was inside this block; the function continues with `syncLegacyAliases(_config); await saveConfig(); return _config;` — keep those.

Final shape of `loadConfig` after this task:

```js
export async function loadConfig() {
  await credStore().loadCredentialStore(getSecretsPath());
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf-8');
    _config = await normalizeConfig(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Warning: Failed to parse config file:', err.message);
    _config = createDefaultConfig();
  }
  syncLegacyAliases(_config);
  await saveConfig();
  return _config;
}
```

- [ ] **Step 2: Delete `agent/server.js` ALPACA_PUBLIC_KEY_2 re-seed block**

Remove the entire block at `agent/server.js:69-85` (the `// Seed second account from env vars if configured` block).

- [ ] **Step 3: Manually verify on a real boot**

Run: `node agent/server.js`
Expected: server starts. Console does NOT log `Auto-imported Alpaca account from .env` or `Seeded second account ... from env vars`. With an existing v4 config, the migration line still logs. With an empty config and no `.env` keys, server starts with 0 accounts.

`Ctrl+C` to stop.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add agent/config-store.js agent/server.js
git commit -m "refactor: drop .env account-seed mechanisms (UI is sole creation path)"
```

---

### Task 8: New API — POST /api/sandboxes

**Files:**
- Modify: `agent/server.js` (add new endpoint near the existing sandbox endpoints around line 691)
- Create: `agent/server-accounts.test.mjs`

`agent/server.js` is a long single file with no existing test harness. We create a minimal supertest-style harness that boots an in-process Express app with overridden paths.

- [ ] **Step 1: Write the failing tests**

Create `agent/server-accounts.test.mjs`:

```js
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';

// Helpers: spin up agent/server.js in a child process pointed at a tmp data dir.
// We pre-seed agent-config.json + accounts-secrets.json to skip the migration path.
const { fileURLToPath } = await import('url');
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(here, 'server.js');

let proc, port, baseUrl, tmpDir;

async function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + urlPath);
    const r = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let parsed;
        try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function waitForServer(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await req('GET', '/api/health'); if (r.status === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start in time');
}

const seedConfig = {
  schemaVersion: 5,
  activeAccountId: 'acc1',
  activeSandboxId: 'sbx_acc1aaaa',
  activeAgentId: 'default',
  activeModel: 'anthropic/claude-sonnet-4-6',
  heartbeat: { pre_market: 900, market_open: 120, midday: 300, market_close: 120, after_hours: 7200, closed: 28800 },
  permissions: { allowLiveTrading: true, maxPositionPct: 15, maxDeployedPct: 80, maxDailyLoss: 5, maxOpenPositions: 10, maxOrderValue: 0, allowedTools: [], blockedTools: [], allowOptions: true, allowStocks: true, allow0DTE: false, requireConfirmation: false, maxToolRoundsPerBeat: 25 },
  plugins: { slack: { enabled: false, webhookUrl: '', channel: '', notifyOn: {} } },
  accounts: [
    { id: 'acc1', name: 'Paper', baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-05-11T00:00:00Z' },
  ],
  sandboxes: {
    sbx_acc1aaaa: { id: 'sbx_acc1aaaa', accountId: 'acc1', name: 'Default', agent: { activeAgentId: 'default', model: 'anthropic/claude-sonnet-4-6', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {}, createdAt: '2026-05-11T00:00:00Z' },
  },
  agents: [{ id: 'default', name: 'Prophet', strategyId: 'v2-options', model: 'anthropic/claude-sonnet-4-6' }],
  strategies: [],
  models: [],
};

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-test-'));
  await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'data', 'agent-config.json'), JSON.stringify(seedConfig));
  await fs.writeFile(path.join(tmpDir, 'data', 'accounts-secrets.json'), JSON.stringify({ acc1: { publicKey: 'PK', secretKey: 'SK' } }));
  port = 13700 + Math.floor(Math.random() * 100);
  baseUrl = `http://127.0.0.1:${port}`;
  const { spawn } = await import('child_process');
  proc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_PORT: String(port), OPENPROPHET_DATA_ROOT: path.join(tmpDir, 'data') },
    cwd: tmpDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(baseUrl);
});

after(async () => {
  proc?.kill();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('POST /api/sandboxes happy path returns new sandbox with distinct id', async () => {
  const r = await req('POST', '/api/sandboxes', { accountId: 'acc1', name: 'Second' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.sandbox.accountId, 'acc1');
  assert.notEqual(r.body.sandbox.id, 'sbx_acc1aaaa');
  assert.match(r.body.sandbox.id, /^sbx_[0-9a-f]{8}$/);
  assert.equal(r.body.sandbox.name, 'Second');
});

test('POST /api/sandboxes with unknown accountId returns 400', async () => {
  const r = await req('POST', '/api/sandboxes', { accountId: 'no-such', name: 'X' });
  assert.equal(r.status, 400);
});

test('POST /api/sandboxes without name returns 400', async () => {
  const r = await req('POST', '/api/sandboxes', { accountId: 'acc1' });
  assert.equal(r.status, 400);
});

test('POST /api/sandboxes without accountId returns 400', async () => {
  const r = await req('POST', '/api/sandboxes', { name: 'X' });
  assert.equal(r.status, 400);
});
```

The test boots the real `agent/server.js` in a child process. For this to work, the server must read its config paths from env vars when `OPENPROPHET_DATA_ROOT` is set.

- [ ] **Step 2: Wire `OPENPROPHET_DATA_ROOT` into config-store path resolution**

In `agent/config-store.js`, update `getConfigPath`, `getSecretsPath`, `getSandboxesRoot`, `getBackupDir` to honor the env var:

```js
function _dataRoot() {
  return process.env.OPENPROPHET_DATA_ROOT || path.join(__dirname, '..', 'data');
}
function getConfigPath() {
  return CONFIG_PATH_OVERRIDE || path.join(_dataRoot(), 'agent-config.json');
}
function getSecretsPath() {
  return SECRETS_PATH_OVERRIDE || path.join(_dataRoot(), 'accounts-secrets.json');
}
function getSandboxesRoot() {
  return SANDBOXES_ROOT_OVERRIDE || path.join(_dataRoot(), 'sandboxes');
}
function getBackupDir() {
  return BACKUP_DIR_OVERRIDE || path.join(_dataRoot(), 'backups');
}
```

`agent/orchestrator.js` also writes `data/sandboxes/...` paths from `this.projectRoot`. For the integration test to work cleanly, orchestrator should also honor `OPENPROPHET_DATA_ROOT`:

In `agent/orchestrator.js`, find where `this.projectRoot` is used to build sandbox paths (the two spots from Task 6). Either:
- (a) Add a `dataRoot` field that prefers `process.env.OPENPROPHET_DATA_ROOT`, OR
- (b) Set `OPENPROPHET_DATA_ROOT=<projectRoot>/data` in the test only and rely on config-store's resolver.

Option (b) is less invasive. The test already sets `OPENPROPHET_DATA_ROOT`. Just make sure orchestrator imports the path helpers from config-store rather than computing them itself.

Actually orchestrator's `getSandboxDbPath` builds the path inline. Easier fix: export a `getSandboxRuntimeDir(sandboxId)` helper from `config-store.js` and have orchestrator call it.

Add to `agent/config-store.js`:

```js
export function getSandboxRuntimeDir(sandboxId) {
  return path.join(getSandboxesRoot(), sandboxId);
}
```

Update `agent/orchestrator.js`:

```js
import { getSandboxRuntimeDir, /* ... existing imports */ } from './config-store.js';

getSandboxDbPath(sandboxId) {
  return path.join(getSandboxRuntimeDir(sandboxId), 'prophet_trader.db');
}

// And in startGoBackend env block:
ACTIVITY_LOG_DIR: path.join(getSandboxRuntimeDir(sandboxId), 'activity_logs'),
```

- [ ] **Step 3: Add the new `POST /api/sandboxes` endpoint**

In `agent/server.js`, add the import:

```js
import { /* ... existing ... */, createSandboxForAccount } from './config-store.js';
```

Add the endpoint right after the `GET /api/sandboxes` handler around line 702:

```js
app.post('/api/sandboxes', async (req, res) => {
  try {
    const { accountId, name, agentId } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const sandbox = await createSandboxForAccount(accountId, { name: String(name).trim(), agentId });
    broadcast('config', safeConfig());
    res.json({ ok: true, sandbox });
  } catch (err) {
    const code = /account not found/i.test(err.message) ? 400 : 500;
    res.status(code).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test agent/server-accounts.test.mjs`
Expected: All 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/config-store.js agent/orchestrator.js agent/server.js agent/server-accounts.test.mjs
git commit -m "feat(api): add POST /api/sandboxes for dropdown-driven sandbox creation"
```

---

### Task 9: New API — GET /api/accounts/:id/equity (with 60s cache)

**Files:**
- Modify: `agent/server.js`
- Modify: `agent/server-accounts.test.mjs`

- [ ] **Step 1: Write the failing test (append to `agent/server-accounts.test.mjs`)**

```js
test('GET /api/accounts/:id/equity returns equity or null+error', async () => {
  const r = await req('GET', '/api/accounts/acc1/equity');
  // With test creds PK/SK against real Alpaca, the call will fail with 401.
  // Either way, the endpoint shape is { equity, asOf } | { equity: null, error }.
  assert.equal(r.status, 200);
  assert.ok('equity' in r.body, 'response has equity field');
  // Equity is null (auth failed) — that's the expected response shape in this test
  assert.equal(r.body.equity, null);
  assert.ok(r.body.error, 'error field populated');
});

test('GET /api/accounts/:id/equity returns 404 for unknown account', async () => {
  const r = await req('GET', '/api/accounts/no-such/equity');
  assert.equal(r.status, 404);
});

test('GET /api/accounts/:id/equity is cached: 2nd call within 60s does not refetch', async () => {
  // First call populates cache; second call should return the same asOf timestamp.
  const r1 = await req('GET', '/api/accounts/acc1/equity');
  const r2 = await req('GET', '/api/accounts/acc1/equity');
  assert.equal(r1.body.asOf, r2.body.asOf);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test agent/server-accounts.test.mjs`
Expected: 3 new tests fail with 404 / undefined error.

- [ ] **Step 3: Add the endpoint to `agent/server.js`**

Near the other account endpoints (around line 1020), add:

```js
const _equityCache = new Map();  // accountId -> { equity, asOf, fetchedAtMs, error }
const EQUITY_CACHE_MS = 60_000;

app.get('/api/accounts/:id/equity', async (req, res) => {
  const account = getAccountById(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const cached = _equityCache.get(account.id);
  if (cached && (Date.now() - cached.fetchedAtMs) < EQUITY_CACHE_MS) {
    return res.json({ equity: cached.equity, asOf: cached.asOf, error: cached.error || null });
  }

  try {
    const baseUrl = account.baseUrl || (account.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets');
    const client = axios.create({
      baseURL: baseUrl,
      headers: {
        'APCA-API-KEY-ID': account.publicKey,
        'APCA-API-SECRET-KEY': account.secretKey,
      },
      timeout: 3000,
    });
    const { data } = await client.get('/v2/account');
    const entry = {
      equity: Number(data.equity),
      asOf: new Date().toISOString(),
      fetchedAtMs: Date.now(),
      error: null,
    };
    _equityCache.set(account.id, entry);
    res.json({ equity: entry.equity, asOf: entry.asOf, error: null });
  } catch (err) {
    const entry = {
      equity: null,
      asOf: new Date().toISOString(),
      fetchedAtMs: Date.now(),
      error: err.response?.status ? `Alpaca ${err.response.status}` : err.message,
    };
    _equityCache.set(account.id, entry);
    res.json({ equity: null, asOf: entry.asOf, error: entry.error });
  }
});
```

(Note: `/v2/account` not `/api/v1/account` — Alpaca's REST root differs from the project's internal `/api/v1/*` proxy paths. Cross-check the existing call at `agent/server.js:1357` if uncertain.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test agent/server-accounts.test.mjs`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add agent/server.js agent/server-accounts.test.mjs
git commit -m "feat(api): add GET /api/accounts/:id/equity with 60s cache"
```

---

### Task 10: Modify existing account endpoints (DELETE 409, PUT rotation, POST no-sandbox, drop clone)

**Files:**
- Modify: `agent/server.js`
- Modify: `agent/server-accounts.test.mjs`

Changes per spec Section 4:
- `GET /api/accounts`: include `equity` (from cache) and `sandboxCount`
- `POST /api/accounts`: no longer auto-creates a sandbox (`addAccount` already doesn't, post-Task 3 — verify no leftover sandbox-creation code in the handler)
- `PUT /api/accounts/:id`: pass through optional `publicKey`+`secretKey` to `updateAccount` (which already enforces both-or-neither, post-Task 3)
- `DELETE /api/accounts/:id`: 409 if any sandbox has `accountId === id`
- `POST /api/accounts/:id/clone`: removed
- `POST /api/accounts/:id/activate`: set `activeSandboxId` to the account's first sandbox by createdAt; 400 if account has no sandboxes

- [ ] **Step 1: Write the failing tests (append to `agent/server-accounts.test.mjs`)**

```js
test('GET /api/accounts includes sandboxCount per account', async () => {
  const r = await req('GET', '/api/accounts');
  assert.equal(r.status, 200);
  const acc1 = r.body.accounts.find(a => a.id === 'acc1');
  assert.ok(typeof acc1.sandboxCount === 'number', 'sandboxCount field present');
});

test('DELETE /api/accounts/:id with attached sandbox returns 409 with sandboxIds list', async () => {
  // acc1 has sbx_acc1aaaa attached from seed
  const r = await req('DELETE', '/api/accounts/acc1');
  assert.equal(r.status, 409);
  assert.ok(Array.isArray(r.body.sandboxIds));
  assert.ok(r.body.sandboxIds.includes('sbx_acc1aaaa'));
});

test('PUT /api/accounts/:id with only publicKey returns 400', async () => {
  const r = await req('PUT', '/api/accounts/acc1', { publicKey: 'NEW_PK' });
  assert.equal(r.status, 400);
});

test('PUT /api/accounts/:id with both publicKey + secretKey rotates', async () => {
  const r = await req('PUT', '/api/accounts/acc1', { publicKey: 'NEW_PK', secretKey: 'NEW_SK' });
  assert.equal(r.status, 200);
  // The masked-secret response should show last-4 of the NEW secret
  assert.match(r.body.account.secretKey, /N_SK$/);
});

test('POST /api/accounts/:id/clone is removed (returns 404)', async () => {
  const r = await req('POST', '/api/accounts/acc1/clone', { name: 'X' });
  assert.equal(r.status, 404);
});

test('POST /api/accounts no longer creates a sandbox', async () => {
  const before = await req('GET', '/api/sandboxes');
  const ar = await req('POST', '/api/accounts', { name: 'NoSandbox', publicKey: 'PK_NEW', secretKey: 'SK_NEW', baseUrl: 'https://paper-api.alpaca.markets', paper: true });
  assert.equal(ar.status, 200);
  const after = await req('GET', '/api/sandboxes');
  assert.equal(after.body.sandboxes.length, before.body.sandboxes.length, 'sandbox count unchanged');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test agent/server-accounts.test.mjs`
Expected: 6 new tests fail.

- [ ] **Step 3: Modify `agent/server.js` GET /api/accounts** (currently line 1021)

```js
app.get('/api/accounts', (req, res) => {
  const config = getConfig();
  const sandboxesByAccount = new Map();
  for (const s of Object.values(config.sandboxes || {})) {
    if (!sandboxesByAccount.has(s.accountId)) sandboxesByAccount.set(s.accountId, []);
    sandboxesByAccount.get(s.accountId).push(s);
  }
  const safe = config.accounts.map(a => {
    const cached = _equityCache.get(a.id);
    const sbxs = sandboxesByAccount.get(a.id) || [];
    const creds = getAccountById(a.id);
    return {
      ...a,
      secretKey: creds.secretKey ? '****' + creds.secretKey.slice(-4) : '****',
      publicKey: creds.publicKey || null,
      equity: cached?.equity ?? null,
      equityAsOf: cached?.asOf ?? null,
      sandboxCount: sbxs.length,
      sandboxNames: sbxs.map(s => s.name),
    };
  });
  res.json({ accounts: safe, activeId: config.activeAccountId });
});
```

- [ ] **Step 4: Modify `agent/server.js` POST /api/accounts** (currently line 1028)

Just make sure the response includes the same masked shape:

```js
app.post('/api/accounts', async (req, res) => {
  try {
    const account = await addAccount(req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true, account: { ...account, secretKey: '****' + (account.secretKey || '').slice(-4) } });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
```

- [ ] **Step 5: Modify `agent/server.js` PUT /api/accounts/:id** (currently line 1036)

Already accepts the full body, but `updateAccount` now consumes optional `publicKey`/`secretKey`. Make the error path return 400 for the both-or-neither rejection. Update response to mask the new secret:

```js
app.put('/api/accounts/:id', async (req, res) => {
  try {
    const account = await updateAccount(req.params.id, req.body);
    const creds = getAccountById(req.params.id);
    broadcast('config', safeConfig());
    res.json({ ok: true, account: { ...account, secretKey: '****' + (creds.secretKey || '').slice(-4) } });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
```

- [ ] **Step 6: Modify `agent/server.js` DELETE /api/accounts/:id** (currently line 1044)

```js
app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const cfg = getConfig();
    const attached = Object.values(cfg.sandboxes || {})
      .filter(s => s.accountId === req.params.id);
    if (attached.length > 0) {
      return res.status(409).json({
        error: `Account has ${attached.length} sandbox(es) attached. Detach or delete them before removing the account.`,
        sandboxIds: attached.map(s => s.id),
        sandboxNames: attached.map(s => s.name),
      });
    }
    await removeAccount(req.params.id);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
```

- [ ] **Step 7: Remove the clone endpoint** (currently line 1074-1090)

Delete the entire `app.post('/api/accounts/:id/clone', ...)` block.

- [ ] **Step 8: Modify `agent/server.js` POST /api/accounts/:id/activate** (currently line 1052)

```js
app.post('/api/accounts/:id/activate', async (req, res) => {
  try {
    const cfg = getConfig();
    const sandboxes = Object.values(cfg.sandboxes || {})
      .filter(s => s.accountId === req.params.id)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    if (sandboxes.length === 0) {
      return res.status(400).json({ error: 'Account has no sandboxes — create one first' });
    }
    await setActiveAccount(req.params.id);
    await setActiveSandbox(sandboxes[0].id);
    const activeSandbox = getActiveSandbox();
    broadcast('config', safeConfig());
    if (activeSandbox?.id) {
      await migrateLegacyDataForSandbox(activeSandbox.id);
      broadcast('agent_log', {
        message: `Switching to account "${getActiveAccount()?.name}"... ensuring trading backend.`,
        level: 'info',
        timestamp: new Date().toISOString(),
      });
      const runtime = getRuntimeForSandbox(activeSandbox.id);
      if (runtime && !runtime.goReady) {
        await orchestrator.startGoBackend(activeSandbox.id);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `node --test agent/server-accounts.test.mjs`
Expected: All tests pass.

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add agent/server.js agent/server-accounts.test.mjs
git commit -m "feat(api): account endpoints — 409 on delete-with-sandboxes, rotation, drop clone"
```

---

### Task 11: UI — Accounts tab card rewrite + Add/Edit/Rotate/Delete modals

**Files:**
- Modify: `agent/public/index.html`

Single-file SPA; vanilla JS. Existing landmarks:
- Accounts tab panel: line 1200 (`#panel-accounts`)
- `renderAccounts()`: line 3585
- `showModal('account-edit', ...)`: line 3617 (existing)
- `deleteAccount(id)`: line 3682 (existing — minimal `confirm()` + DELETE)
- `activateAccount(id)`: line 3679 (existing)

- [ ] **Step 1: Replace `renderAccounts()`**

Find the existing `function renderAccounts()` around `agent/public/index.html:3585` and replace its body. New version renders the spec's card layout:

```js
function renderAccounts() {
  const el = document.getElementById('accounts-grid');
  if (!el) return;
  if (!config.accounts?.length) {
    el.innerHTML = `
      <div class="no-data" style="grid-column: 1 / -1;">
        <h3>No trading accounts configured</h3>
        <p>Add your Alpaca paper or live API keys to get started.</p>
        <button class="btn primary" onclick="showModal('account-add')">+ Add Account</button>
      </div>`;
    return;
  }
  el.innerHTML = config.accounts.map(a => {
    const sbxLine = a.sandboxCount > 0
      ? `In use by ${a.sandboxCount} sandbox(es): ${(a.sandboxNames || []).join(', ')}`
      : `<span style="color: var(--muted)">No sandboxes attached</span>`;
    const equityLine = a.equity != null
      ? `Equity: $${Number(a.equity).toLocaleString()} <span class="muted">(asOf ${new Date(a.equityAsOf).toLocaleTimeString()})</span>`
      : (a.equity === null && a.equityAsOf ? `Equity: <span class="muted">unavailable</span>` : `Equity: <span class="muted">loading…</span>`);
    const activeBadge = config.activeAccountId === a.id ? '<span class="badge">Active ●</span>' : '';
    const liveTag = a.paper ? '<span class="muted">paper</span>' : '<span class="badge live">⚠ live</span>';
    return `
      <div class="account-card">
        <div class="account-head">
          <h3>${escapeHtml(a.name)}</h3>${activeBadge}
        </div>
        <div class="account-meta">${liveTag} • ${escapeHtml(a.baseUrl || '')}</div>
        <div class="account-key">Key: ${a.secretKey || '****'}</div>
        <div class="account-equity">${equityLine}</div>
        <div class="account-sandboxes">${sbxLine}</div>
        <div class="account-actions">
          <button class="btn sm" onclick="activateAccount('${a.id}')" ${a.sandboxCount === 0 ? 'disabled title="Account has no sandboxes"' : ''}>Activate</button>
          <button class="btn sm" onclick="showModal('account-edit', config.accounts.find(x=>x.id==='${a.id}'))">Edit</button>
          <button class="btn sm" onclick="showModal('account-rotate', config.accounts.find(x=>x.id==='${a.id}'))">Rotate Keys</button>
          <button class="btn sm danger" onclick="deleteAccount('${a.id}')">Delete</button>
        </div>
      </div>`;
  }).join('');

  // Lazy-fetch equity for any account without a cached value (cache lives server-side too).
  for (const a of config.accounts) {
    if (a.equity == null && !a.equityAsOf) fetchAccountEquity(a.id);
  }
}

async function fetchAccountEquity(accountId) {
  try {
    const r = await fetch('/api/accounts/' + encodeURIComponent(accountId) + '/equity');
    if (!r.ok) return;
    const data = await r.json();
    const acct = config.accounts.find(a => a.id === accountId);
    if (acct) {
      acct.equity = data.equity;
      acct.equityAsOf = data.asOf;
      renderAccounts();
    }
  } catch { /* swallow — equity is best-effort */ }
}

function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
```

(If `escapeHtml` already exists elsewhere in the SPA — grep first — skip the helper definition.)

- [ ] **Step 2: Add minimal CSS for the new card classes**

Add to the existing `<style>` block in `agent/public/index.html` (search for `#accounts-grid` to find the right area, around line 1013):

```css
.account-card { background: var(--panel-bg); border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.account-head { display: flex; justify-content: space-between; align-items: center; }
.account-head h3 { margin: 0; font-size: 1rem; }
.account-meta, .account-key, .account-equity, .account-sandboxes { font-size: 0.9rem; color: var(--text); }
.account-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.badge { font-size: 0.75rem; padding: 2px 6px; border-radius: 4px; background: var(--accent); color: white; }
.badge.live { background: #c84a4a; }
.muted { color: var(--muted); font-size: 0.85em; }
```

(Color variables `--panel-bg`, `--text`, `--muted`, `--accent` exist in the file — search to confirm.)

- [ ] **Step 3: Update the `showModal('account-edit')` modal**

Find the existing `account-edit` branch in `showModal` (around line 3703-3760 — grep for `'account-edit'`). Replace its inner-HTML to drop the key fields (no longer editable here per spec):

```js
} else if (type === 'account-edit') {
  const a = data || {};
  modal.innerHTML = `
    <h3>Edit Account</h3>
    <div class="modal-body">
      <label>Name<input id="m-name" value="${escapeHtml(a.name || '')}"></label>
      <label>Base URL<input id="m-base" value="${escapeHtml(a.baseUrl || '')}"></label>
      <label><input type="checkbox" id="m-paper" ${a.paper ? 'checked' : ''}> Paper trading</label>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitAccountEdit('${a.id}')">Save</button>
    </div>`;
}
```

Add the new `account-add` and `account-rotate` cases (somewhere in the same `showModal` if/else chain):

```js
} else if (type === 'account-add') {
  modal.innerHTML = `
    <h3>Add Account</h3>
    <div class="modal-body">
      <label>Name<input id="m-name" placeholder="e.g. Paper #1"></label>
      <label>Public Key<input id="m-pk" placeholder="PK..."></label>
      <label>Secret Key<input id="m-sk" type="password" placeholder="..."></label>
      <label>Base URL<input id="m-base" value="https://paper-api.alpaca.markets"></label>
      <label><input type="checkbox" id="m-paper" checked onchange="document.getElementById('m-base').value = this.checked ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'"> Paper trading</label>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitAccountAdd()">Add Account</button>
    </div>`;
} else if (type === 'account-rotate') {
  const a = data || {};
  modal.innerHTML = `
    <h3>Rotate Keys — ${escapeHtml(a.name || '')}</h3>
    <div class="modal-body">
      <p class="muted">Enter the new full publicKey and secretKey. Both required.</p>
      <label>Public Key<input id="m-pk" placeholder="PK..."></label>
      <label>Secret Key<input id="m-sk" type="password" placeholder="..."></label>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitAccountRotate('${a.id}')">Rotate</button>
    </div>`;
}
```

- [ ] **Step 4: Add the submit handlers**

In the script section (around the existing `submitSandboxCreate`):

```js
async function submitAccountAdd() {
  const body = {
    name: document.getElementById('m-name').value.trim(),
    publicKey: document.getElementById('m-pk').value.trim(),
    secretKey: document.getElementById('m-sk').value.trim(),
    baseUrl: document.getElementById('m-base').value.trim(),
    paper: document.getElementById('m-paper').checked,
  };
  if (!body.name || !body.publicKey || !body.secretKey) {
    return showToast('Name, publicKey, and secretKey are required', 'error');
  }
  const r = await fetch('/api/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) return showToast(j.error || 'Failed to add account', 'error');
  closeModal();
  showToast('Account added', 'success');
}

async function submitAccountEdit(id) {
  const body = {
    name: document.getElementById('m-name').value.trim(),
    baseUrl: document.getElementById('m-base').value.trim(),
    paper: document.getElementById('m-paper').checked,
  };
  const r = await fetch('/api/accounts/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) return showToast(j.error || 'Failed to save', 'error');
  closeModal();
  showToast('Account updated', 'success');
}

async function submitAccountRotate(id) {
  const pk = document.getElementById('m-pk').value.trim();
  const sk = document.getElementById('m-sk').value.trim();
  if (!pk || !sk) return showToast('Both publicKey and secretKey are required', 'error');
  const r = await fetch('/api/accounts/' + encodeURIComponent(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: pk, secretKey: sk }) });
  const j = await r.json();
  if (!r.ok) return showToast(j.error || 'Failed to rotate', 'error');
  closeModal();
  showToast('Keys rotated', 'success');
}
```

- [ ] **Step 5: Replace `deleteAccount` to handle the 409 response**

Find `async function deleteAccount(id)` around `agent/public/index.html:3682` and replace:

```js
async function deleteAccount(id) {
  const account = (config.accounts || []).find(a => a.id === id);
  if (!confirm(`Delete account "${account?.name || id}"?`)) return;
  const r = await fetch('/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' });
  const j = await r.json();
  if (r.status === 409) {
    alert(`Cannot delete: account has ${j.sandboxIds.length} sandbox(es) attached:\n\n  - ${j.sandboxNames.join('\n  - ')}\n\nDetach or delete them first.`);
    return;
  }
  if (!r.ok) return showToast(j.error || 'Failed to delete', 'error');
  showToast('Account deleted', 'success');
}
```

- [ ] **Step 6: Add the "+ Add Account" button to the Accounts tab header**

Find the existing `<h2>Trading Accounts</h2>` block at line 1202 and add the button beside it:

```html
<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
  <h2 style="margin: 0;">Trading Accounts</h2>
  <button class="btn primary sm" onclick="showModal('account-add')">+ Add Account</button>
</div>
```

(Adjust nesting to match existing markup.)

- [ ] **Step 7: Manual smoke test**

Run: `node agent/server.js`
Open `http://localhost:3737`, navigate to Accounts tab.
Expected: Cards render in new layout. Equity loads after a moment (or shows "unavailable" if Alpaca rejects test creds). Add/Edit/Rotate/Delete modals open. Delete on the one account with the sole sandbox shows the alert; if you create a second account and delete it, it succeeds.

- [ ] **Step 8: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(ui): Accounts tab redesign with rotate + 409-aware delete"
```

---

### Task 12: UI — sandbox-create modal rewrite + dropdown

**Files:**
- Modify: `agent/public/index.html`

Landmarks:
- Sandbox-create modal: `showModal('sandbox-create')` around line 3703
- `submitSandboxCreate()`: around line 2700

- [ ] **Step 1: Replace the `sandbox-create` branch in `showModal`**

```js
} else if (type === 'sandbox-create') {
  const accounts = config.accounts || [];
  if (accounts.length === 0) {
    modal.innerHTML = `
      <h3>New Sandbox</h3>
      <div class="modal-body">
        <p>You need to add a trading account first.</p>
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn primary" onclick="closeModal(); showModal('account-add')">+ Add Account</button>
      </div>`;
    return;
  }

  // Sandbox count per account, for the "already has N attached" warning
  const sbxByAcct = {};
  for (const s of Object.values(config.sandboxes || {})) {
    sbxByAcct[s.accountId] = (sbxByAcct[s.accountId] || 0) + 1;
  }

  const acctOpts = accounts.map(a => {
    const equityStr = a.equity != null ? `$${Number(a.equity).toLocaleString()}` : '$—';
    const liveTag = a.paper ? '' : ' ⚠ live';
    return `<option value="${a.id}" data-paper="${a.paper}" data-attached="${sbxByAcct[a.id] || 0}">${escapeHtml(a.name)} — ${equityStr}${liveTag}</option>`;
  }).join('');

  const agentOpts = (config.agents || []).map(ag => `<option value="${ag.id}">${escapeHtml(ag.name)}</option>`).join('');

  modal.innerHTML = `
    <h3>New Sandbox</h3>
    <div class="modal-body">
      <label>Name<input id="m-name" placeholder="e.g. Harvest #2"></label>
      <label>Account
        <select id="m-account" onchange="updateSandboxCreateWarning()">${acctOpts}</select>
      </label>
      <label>Agent<select id="m-agent">${agentOpts}</select></label>
      <div id="m-warning" style="display: none; padding: 8px; background: #fff8c4; color: #5c4d00; border-radius: 4px; margin-top: 8px; font-size: 0.9em;"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" onclick="submitSandboxCreate()">Create</button>
    </div>`;
  updateSandboxCreateWarning();
}
```

- [ ] **Step 2: Add the warning helper**

```js
function updateSandboxCreateWarning() {
  const sel = document.getElementById('m-account');
  const warn = document.getElementById('m-warning');
  if (!sel || !warn) return;
  const opt = sel.options[sel.selectedIndex];
  const isPaper = opt.dataset.paper === 'true';
  const attached = Number(opt.dataset.attached || 0);
  if (!isPaper && attached > 0) {
    const acct = config.accounts.find(a => a.id === sel.value);
    const sbxes = Object.values(config.sandboxes || {}).filter(s => s.accountId === sel.value).map(s => s.name).join(', ');
    warn.innerHTML = `⚠ Account "${escapeHtml(acct?.name || '')}" is already attached to sandbox(es): ${escapeHtml(sbxes)}. Multiple sandboxes on one live account compete for buying power.`;
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
}
```

- [ ] **Step 3: Replace `submitSandboxCreate()`** (currently around line 2700)

```js
async function submitSandboxCreate() {
  const body = {
    name: document.getElementById('m-name').value.trim(),
    accountId: document.getElementById('m-account').value,
    agentId: document.getElementById('m-agent').value,
  };
  if (!body.name) return showToast('Name is required', 'error');
  if (!body.accountId) return showToast('Account is required', 'error');
  const r = await fetch('/api/sandboxes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) return showToast(j.error || 'Failed to create sandbox', 'error');
  closeModal();
  showToast('Sandbox created', 'success');
}
```

- [ ] **Step 4: Delete the old "from new account" UI affordances**

Search for `btnFromAccount` (around line 2533) and the related buttons in the sandbox header (around line 1191). The current header probably has two buttons: "New Sandbox (from new account)" and "New Sandbox (clone)". Reduce to a single "New Sandbox" button:

```html
<button class="btn primary sm" onclick="showModal('sandbox-create')">+ New Sandbox</button>
```

Remove `btnFromAccount` references and its `disabled` toggle.

- [ ] **Step 5: Manual smoke test**

Run: `node agent/server.js`. Open dashboard, click "+ New Sandbox":
- With one account: dropdown shows it with equity (or "$—"). Submit creates a new sandbox attached to that account.
- Verify two sandboxes now appear under the same account.
- Try the same modal with a live account (toggle paper:false on one): warning banner appears when selected (if that account already has a sandbox).
- With zero accounts (delete all sandboxes + accounts): modal shows the "you need to add an account first" copy with the jump button.

- [ ] **Step 6: Commit**

```bash
git add agent/public/index.html
git commit -m "feat(ui): sandbox-create dropdown + live-account-warning"
```

---

### Task 13: End-to-end smoke verification (per spec checklist)

**Files:** none modified — this is the verification gate before merging.

Per the spec's "Manual smoke checklist", run these in order. If any fails, file as a bug against the most recent task that touched the relevant code path; do NOT proceed to merge.

- [ ] **Step 1: Snapshot the v4 state and back up**

```bash
cp data/agent-config.json data/backups/manual-v4-snapshot-$(date -u +%Y%m%dT%H%M%SZ).json
```

- [ ] **Step 2: Boot with current v4 config → migration runs**

Stop any running agent server. Then:

```bash
node agent/server.js
```

Expected console line:
```
[migration] v4→v5: deduped 4 accounts → 1, rewrote 4 sandbox pointers, extracted 1 credential sets, backup at data/backups/agent-config.v4.<timestamp>.json
[migration] v4→v5 rekeyed 4 runtime dirs
```

Verify:
```bash
grep '"schemaVersion"' data/agent-config.json   # → "schemaVersion": 5
ls data/accounts-secrets.json                    # exists
ls data/backups/                                 # contains agent-config.v4.<ts>.json
ls data/sandboxes/                               # entries are sbx_<id>, not raw <id>
```

- [ ] **Step 3: Sandboxes start cleanly**

Hit `/api/sandboxes` from the browser network tab or:

```bash
curl http://localhost:3737/api/sandboxes
```

All 4 sandboxes present, each pointing at the survivor accountId.

- [ ] **Step 4: Turtle scheduler regression guard**

```bash
# Find Turtle's bot port from the sandboxes response, then:
curl http://localhost:<turtle-port>/api/v1/turtle/status   # → 200, scheduler_enabled:true
curl http://localhost:<prophet-port>/api/v1/turtle/status  # → 404
```

If Turtle returns 404 or Prophet returns 200, the per-sandbox `TURTLE_SCHEDULER_ENABLED` gate has regressed. Stop here.

- [ ] **Step 5: Accounts tab shows the deduped state**

Open `http://localhost:3737`, click Accounts. Expected: 1 card, name "Paper (from .env)" (or whatever the survivor name was), "In use by 4 sandboxes: Paper (from .env), Harvest, Turtle, Spark".

- [ ] **Step 6: Add a second account via UI**

Click "+ Add Account", enter throwaway test keys (e.g. publicKey `TEST_PK`, secretKey `TEST_SK`, paper checked). Submit. New card appears with "No sandboxes attached".

- [ ] **Step 7: Create a sandbox against the new account**

Click "+ New Sandbox", select the new account, name "Test Sandbox", agent "default". Submit. New sandbox appears. The Accounts card for the new account now reads "In use by 1 sandbox: Test Sandbox".

- [ ] **Step 8: Try deleting the original account → 409**

In the dashboard, click Delete on the original "Paper (from .env)" card. Expected: alert listing 4 sandbox names, account not deleted.

- [ ] **Step 9: Rotate keys on the new test account**

Click Rotate Keys on the test account. Enter new test keys (e.g. `TEST_PK_2` / `TEST_SK_2`). Submit. Verify on disk:

```bash
cat data/accounts-secrets.json   # entry for the new account shows TEST_PK_2 / TEST_SK_2
```

Restart the test sandbox (Sandboxes panel → Stop → Start). Check the Go bot log line for `ALPACA_API_KEY` (or whatever it logs — confirm the bot picked up the new value).

- [ ] **Step 10: Cleanup**

Delete the test sandbox, then delete the test account (now 200, not 409). Verify the on-disk `data/accounts-secrets.json` no longer contains the test account's entry.

- [ ] **Step 11: Commit the manual-verification snapshot for audit**

```bash
git add data/backups/manual-v4-snapshot-*.json 2>$null || true
# data/ is gitignored — this won't actually stage anything. That's correct.
# Instead, just note completion in the next commit message:
git commit --allow-empty -m "verify: end-to-end smoke pass for accounts tab redesign"
```

---

## Final review checklist

Before opening the PR, run through:

- [ ] `npm test` → all green
- [ ] `data/agent-config.json` is v5 shape (no `publicKey`/`secretKey` in `accounts[]`)
- [ ] `data/accounts-secrets.json` exists and contains the survivor account's creds
- [ ] `data/backups/agent-config.v4.<ts>.json` exists (rollback path)
- [ ] All 4 sandboxes start; Turtle scheduler gate intact
- [ ] Accounts tab renders new cards; Add/Edit/Rotate/Delete all work; 409 path tested
- [ ] Sandbox-create modal uses the dropdown; live-account warning shows correctly
- [ ] `.env` no longer auto-seeds an account on boot (delete `ALPACA_PUBLIC_KEY` from `.env` temporarily and verify boot doesn't create an account)
- [ ] No `migrateLegacyDataForAccount` references remain (`grep -rn migrateLegacyDataForAccount agent/`)
- [ ] No `POST /api/accounts/:id/clone` references in JS or HTML

If all green, open PR to `NeverLucky2/ClaudeProphetAndFriends` (per [[github-repo-target]] memory). Squash to one commit at merge time per [[workflow-preferences]].
