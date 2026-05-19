# Accounts tab redesign — real Alpaca accounts + dropdown sandbox creation

**Date:** 2026-05-18
**Branch (suggested):** `feat-accounts-tab-redesign` (off `main` after `fix-regime-stress-followups` lands)
**Schema bump:** v4 → v5

## Problem

`data/agent-config.json` currently lists 4 entries under `accounts[]` — "Paper (from .env)", "Harvest", "Turtle", "Spark" — but all four carry identical `publicKey`/`secretKey` values sourced from `.env`. They are sandbox identities masquerading as accounts. The Accounts tab reflects this fiction, and the only way to spin up a new sandbox today is to clone an "account" (`POST /api/accounts/:id/clone`), which creates another duplicate.

Real model: one Alpaca account can host multiple Prophet sandboxes (1-to-many). Today's data structure forces 1-to-1.

## Goals

1. **Accounts tab** lists real Alpaca accounts. Operator can add / edit / rotate-keys / delete via UI.
2. **Sandbox creation** picks an account from a dropdown. Multiple sandboxes per account is the supported case.
3. **Credential storage** splits secrets out of `agent-config.json` into a gitignored file behind a thin `CredentialStore` interface, so phase-2 Windows DPAPI encryption is a drop-in implementation swap.
4. **Migration** auto-dedups the 4 fake accounts to 1 on first boot after the change, with backup + idempotency.

## Out of scope

- `agents[]` config (LLM personality + strategyId) — separate concept, untouched.
- `strategies[]` config — untouched.
- Per-sandbox `TURTLE_SCHEDULER_ENABLED` gate in `agent/orchestrator.js` (load-bearing; added 2026-05-18 in the `fix-regime-stress-followups` branch). Must not regress.
- Dashboard auth/authz — local operator is trusted.
- Encryption-at-rest of secrets — that's phase 2. This design only sets up the interface seam.

## Pre-work

Commit (or rebase) the uncommitted `agent/orchestrator.js` Turtle-scheduler gate from the prior session before starting. The diff is small:

```js
const turtleSchedulerEnabled = resolvedAgent?.strategyId === 'trend'
  && process.env.TURTLE_SCHEDULER_ENABLED === 'true';
// ...
TURTLE_SCHEDULER_ENABLED: turtleSchedulerEnabled ? 'true' : 'false',
```

## Decisions (locked in during brainstorming)

| # | Decision |
|---|---|
| 1 | Credentials masked as `****<last-4>` in API responses (already true). Rotation requires full re-entry of both `publicKey` and `secretKey`. No reveal button. |
| 2 | Deleting an account with sandboxes attached **returns 409**. Operator must reassign or delete those sandboxes first. No cascade, no detach-to-unassigned. |
| 3 | `.env` seeding is **deprecated entirely**. No first-run seed, no `ALPACA_PUBLIC_KEY_2` boot re-seed. UI is the only creation path. Empty-state copy in the Accounts tab handles fresh installs. |
| 4 | Sandbox-create form additions: (a) soft warning when adding a 2nd sandbox to a live (`paper === false`) account; (b) account dropdown shows last-known equity inline. No auto-tightening of permission caps for live accounts. |
| 5 | Credential storage architecture: two-file split (metadata in `agent-config.json`, secrets in gitignored `accounts-secrets.json`) behind a thin `CredentialStore` interface. |
| 6 | Migration rekeys runtime dirs from `data/sandboxes/<accountId>/` to `data/sandboxes/<sandboxId>/`. Bigger blast radius than leaving them as-is, but the accountId-keyed layout is wrong under multi-sandbox-per-account. |

## Design

### 1. Data model & file layout

**`data/agent-config.json` (v5):**

```jsonc
{
  "schemaVersion": 5,
  "accounts": [
    {
      "id": "6e4f26af",
      "name": "Paper #1",
      "baseUrl": "https://paper-api.alpaca.markets",
      "paper": true,
      "createdAt": "2026-05-11T12:47:51.486Z"
      // publicKey, secretKey REMOVED — now in accounts-secrets.json
    }
  ],
  "sandboxes": { /* unchanged shape; accountId pointers rewritten by migration */ }
  // remaining fields (agents[], strategies[], manager, etc.) unchanged
}
```

**`data/accounts-secrets.json` (new, gitignored):**

```jsonc
{
  "6e4f26af": {
    "publicKey": "PKVXHXP7MFJ2THTCPDNXJDVNPD",
    "secretKey": "3L4vfn9VFZHPGP6YaPuc2jZAWtCtqemNwykdXENJjZrP"
  }
}
```

- Created on first credential write. `chmod 600` on POSIX (no-op on Windows; filesystem ACLs cover it).
- Added to `.gitignore` in the same PR. A `data/accounts-secrets.example.json` is checked in with placeholder values so the file shape is discoverable.
- Read once into memory at boot; rewritten on each credential mutation behind the same write-lock pattern `config-store.js` uses for the main config.

**`getAccountById(id)` contract preserved.** Returns the merged metadata + creds shape so callers (`orchestrator.js:181-184` env merge, `server.js:1024` masked GET) keep working. Missing creds return `publicKey: null`, `secretKey: null`; `orchestrator.startGoBackend` adds an explicit "missing credentials" error to name this failure clearly.

### 2. `CredentialStore` interface

New module `agent/credential-store.js`. Single responsibility; DPAPI swap-in target.

```js
export async function loadCredentialStore();          // read file once at boot, cache
export function getCredentials(accountId);            // → { publicKey, secretKey } | null  (sync, in-memory)
export async function setCredentials(accountId, { publicKey, secretKey });  // write + persist
export async function deleteCredentials(accountId);   // remove + persist
export function listAccountIds();                     // → string[]
```

**Semantics:**
- `loadCredentialStore()` is called once from `loadConfig()` after the config JSON is parsed, before `syncLegacyAliases`. Missing file → empty `{}` in memory; no write until first `setCredentials` call.
- `getCredentials` is sync because reads are hot-path (every Go-bot env build via `getAccountById`). Making it async would force orchestrator into an `await` chain through several call sites for no benefit.
- Writes go through the same `_writeLock` serialized-promise pattern as `saveConfig` to prevent JSON-rewrite races.
- `setCredentials` overwrites any existing entry (this is the rotation path too).

**Integration in `config-store.js`:**

- `getAccountById(id)`:
  ```js
  const meta = _config.accounts.find(a => a.id === id);
  if (!meta) return null;
  const creds = getCredentials(id) || { publicKey: null, secretKey: null };
  return { ...meta, ...creds };
  ```
- `addAccount({ name, publicKey, secretKey, baseUrl, paper })`: write metadata to `_config.accounts` + `saveConfig()`, then `await setCredentials(id, { publicKey, secretKey })`. On credential-write failure, pop the just-pushed account, `saveConfig()` again, and rethrow — so we never leave an account row without creds.
- `updateAccount(id, { name, baseUrl, paper, publicKey, secretKey })`: when both `publicKey` and `secretKey` are present, call `setCredentials`. If only one is present, throw (API layer returns 400). When neither is present, leave creds untouched.
- `removeAccount(id)`: `saveConfig()` + `await deleteCredentials(id)`.

### 3. Migration v4 → v5

Lives in `agent/config-store.js:477` `migrateLegacyConfig`. Runs once on boot when `rawSchemaVersion < 5`.

**Step 1 — Backup.** Before any mutation, write a timestamped copy of `data/agent-config.json` to `data/backups/agent-config.v4.<ISO>.json`. `mkdir -p` the backups dir. v5 is the first migration that destructively rewrites pointers, so backup is non-optional.

**Step 2 — Dedup accounts.** Group accounts by `(publicKey, baseUrl, paper)` triple. For each group of size ≥ 2:
- **Pick survivor (deterministic):** prefer the entry whose `name` matches `/\(from \.env\)$/`, else earliest `createdAt`, else lexicographically smallest `id`.
- **Rewrite pointers:** for every sandbox where `accountId` is in the duplicate set, set `accountId = survivor.id`. Sandbox `id` field is NOT changed (e.g., `sbx_449fedf6` stays `sbx_449fedf6`).
- **Drop duplicates** from `_config.accounts`.

**Step 3 — Rekey runtime dirs.** For every sandbox, if `data/sandboxes/<oldAccountId>/` exists and `data/sandboxes/<sandboxId>/` does not, rename the dir. Knock-on edits in the same PR:
- `agent/orchestrator.js:54-58` `getSandboxDbPath`: use `sandboxId` directly, drop the `account?.id || sandboxId` fallback.
- `agent/orchestrator.js:187` `ACTIVITY_LOG_DIR`: `path.join(this.projectRoot, 'data', 'sandboxes', sandboxId, 'activity_logs')`.
- `agent/data-migration.js`: rename `migrateLegacyDataForAccount(accountId)` → `migrateLegacyDataForSandbox(sandboxId)`, change the sandboxRoot path. The legacy migration becomes a no-op for v5+ installs but stays for any pre-v4 leftovers.
- `agent/server.js:63` and `agent/server.js:1059`: update both call sites that invoke `migrateLegacyDataForAccount`.

The Go bot is unaffected — it reads `DATABASE_PATH` and `ACTIVITY_LOG_DIR` from env vars, doesn't care about the path shape.

**Step 4 — Extract secrets.** For each surviving account, `await setCredentials(id, { publicKey, secretKey })`, then `delete meta.publicKey; delete meta.secretKey`. Run inside the migration before the final `saveConfig()`, so the v5 file is written without secrets.

**Step 5 — Bump `schemaVersion` to 5** and persist.

**Logging:** single boot-time line, e.g.:
`[migration] v4→v5: deduped 4 accounts → 1, rewrote 4 sandbox pointers, rekeyed 4 runtime dirs, extracted 1 credential set, backup at data/backups/agent-config.v4.2026-05-18T19-23-11.json`

**Idempotency:** re-running on a v5 config is a no-op (`rawSchemaVersion < 5` guard at the top). If migration crashes mid-write, the backup is the recovery path — no partial-state cleverness.

### 4. Server API surface

**New endpoint:**

```
POST /api/sandboxes
  body: { accountId, name, agentId? }
  → 200 { ok: true, sandbox }
  → 400 if accountId missing/unknown, or name missing
```

Handler calls new `createSandboxForAccount(accountId, { name, agentId })` in `config-store.js`. The new function uses the existing `createSandbox()` helper but assigns a fresh `sbx_<uuid8>` id (no longer derived from accountId) and persists.

**New endpoint:**

```
GET /api/accounts/:id/equity
  → 200 { equity, asOf } | { equity: null, error }
```

On-demand Alpaca `/api/v1/account` fetch. 60s in-memory cache keyed by accountId; cache hit returns immediately. Used by the Accounts tab on activation to populate equity badges (parallel-fetched per account) and by the sandbox-create dropdown (cache-only read, no network call).

**Modifications:**

| Endpoint | Change |
|---|---|
| `GET /api/accounts` | Add `equity` (last cached, nullable) and `sandboxCount` per account. |
| `POST /api/accounts` | No longer auto-creates a sandbox. Just creates account + writes creds. UI bundles a separate `POST /api/sandboxes` call when needed. |
| `PUT /api/accounts/:id` | Accept optional `publicKey` + `secretKey`. Both-or-neither; reject 400 if only one is sent. |
| `DELETE /api/accounts/:id` | Return **409** with `{ error, sandboxIds: [...] }` if any sandbox references this account. |
| `POST /api/accounts/:id/clone` | **Removed.** Replaced by `POST /api/sandboxes` against the same accountId. |
| `POST /api/accounts/:id/activate` | Sets `activeSandboxId` to the account's first sandbox (deterministic by `createdAt`); 400 if account has no sandboxes. The `activeAccountId` field in JSON continues to exist as a mirror, written by `syncLegacyAliases` from the active sandbox's `accountId` — not an independent source of truth. |

**Boot-time `.env` seed removal (Q3):**
- Delete `agent/config-store.js:566-595` — the `if (_config.accounts.length === 0) { ... seed from .env ... }` block.
- Delete `agent/server.js:69-85` — the `ALPACA_PUBLIC_KEY_2` re-seed block.
- Leave `agent/config-store.js:589-595` (the `envBaseUrl` sync for existing accounts named `(from .env)`) — it's a no-op for new installs and harmless for upgrades; removing it would be cleanup unrelated to this design.

### 5. UI changes

All in `agent/public/index.html` (single-file SPA).

**Accounts tab (`#panel-accounts`, ~line 1200) — card layout:**

```
┌─────────────────────────────────────────┐
│ Paper #1                    [Active ●]  │
│ paper • paper-api.alpaca.markets        │
│ Key: ****NPD                            │
│ Equity: $98,234 (asOf 14:32 ET)         │
│ In use by 2 sandboxes:                  │
│   • Harvest, Spark                      │
│                                         │
│ [Activate] [Edit] [Rotate Keys] [Delete]│
└─────────────────────────────────────────┘
```

- **Empty state** (`accounts.length === 0`): callout *"No trading accounts configured. Add your Alpaca paper or live keys to get started."* with prominent `[+ Add Account]` button. This is the first-run path now that `.env` seeding is gone.
- **Add Account modal:** fields `name`, `publicKey`, `secretKey`, `baseUrl` (default flips with `paper` toggle), `paper` checkbox. Submit → `POST /api/accounts`. No sandbox auto-created.
- **Edit modal:** edits `name`, `baseUrl`, `paper` only. Keys neither shown nor editable here.
- **Rotate Keys modal** (separate button): two fields `publicKey` + `secretKey`, both required, both blank (no pre-fill, no reveal). Submit → `PUT /api/accounts/:id` with both. Cancel discards.
- **Delete button:** on 409 response, modal lists blocking sandbox names with click-to-jump to each. No force-cascade option.

**Sandbox-create modal (`showModal('sandbox-create')`, ~line 3703):**

Replace both today's "from new account" and "clone existing" paths with one form:

```
New Sandbox
─────────────────────────────
Name:    [_____________________]
Account: [▾ Paper #1 — $98,234 equity        ]
                Paper #2 — $50,012 equity
                Live cash — $—    [⚠ live]
Agent:   [▾ Prophet (default)                ]
─────────────────────────────
⚠ Account "Live cash" is already attached to
  sandbox "Spark". Multiple sandboxes on one
  live account compete for buying power.
                              [Cancel] [Create]
```

- Dropdown options: `<name> — $<equity>` (or `— $—` if cache miss / equity null). Live accounts (`paper === false`) get a `⚠ live` suffix.
- **Soft warning** appears when selected account is `paper === false` AND already has ≥ 1 sandbox attached. Doesn't block submit. Paper accounts: no warning.
- Submit → `POST /api/sandboxes` with `{ accountId, name, agentId }`.

**Plumbing:**
- `renderAccounts()` reads `sandboxCount` + attached sandbox names from in-memory config — no extra fetch.
- New `fetchAccountEquity(accountId)` helper called on Accounts tab activation: parallel-fetches `/api/accounts/:id/equity` for each account, populates a module-level `equityCache` map, then re-renders cards.

## Test plan

Run via `node --test`. No live Alpaca calls.

### `agent/credential-store.test.js`
- `loadCredentialStore()` with no file → empty store, no write
- `loadCredentialStore()` with malformed JSON → throws (loud, not silent)
- `setCredentials` → `getCredentials` round-trip
- `setCredentials` twice for same id → second overwrites
- `deleteCredentials` removes; subsequent `getCredentials` returns null
- Concurrent `setCredentials` serialize — assert final file state equals last write
- `listAccountIds` returns current keys

### `agent/config-store.test.js`
- `addAccount` writes metadata + creds; `getAccountById` returns merged shape
- `addAccount` with credential-store write failure rolls back metadata push (mock store to throw)
- `updateAccount({ publicKey, secretKey })` calls `setCredentials` with both
- `updateAccount({ publicKey })` (only one) rejects
- `removeAccount` calls `deleteCredentials` and removes metadata
- `getAccountById` returns metadata with null creds when store has no entry
- `createSandboxForAccount(accountId, ...)` generates `sbx_<uuid8>` distinct from `sbx_<accountId>`; multiple calls produce distinct sandbox ids both pointing at same account

### `agent/data-migration.test.js` (or in-tree migration test)
- Synthesize a v4 config fixture matching today's real shape (4 sandboxes sharing one Alpaca account). Stub a real on-disk runtime tree under a temp dir for each `data/sandboxes/<accountId>/`. Run migration. Assert:
  - All sandbox `accountId` fields point at the survivor
  - Only the survivor remains in `accounts[]`
  - `accounts-secrets.json` contains exactly the survivor's creds
  - Runtime dirs moved from `data/sandboxes/<oldAccountId>/` to `data/sandboxes/<sandboxId>/`, no data loss
  - `schemaVersion === 5`
  - Backup file exists at `data/backups/agent-config.v4.<timestamp>.json`
- Re-run migration on the v5 output → no-op
- Migration with no duplicates (single account already): still extracts secrets, still rekeys dirs, no merge happens

### `agent/server.test.js`
- `DELETE /api/accounts/:id` with attached sandbox → 409 with sandboxIds list
- `POST /api/sandboxes` with unknown accountId → 400
- `POST /api/sandboxes` happy path → returns sandbox with distinct `sbx_<uuid8>` id
- `PUT /api/accounts/:id` with only publicKey → 400
- `POST /api/accounts` no longer creates a sandbox (sandboxes count unchanged after call)

### Manual smoke checklist (for executing-plans)
1. Boot with current v4 config → migration logs the dedup line, `agent-config.json` is v5 shape, `accounts-secrets.json` exists with one entry, all 4 sandboxes still start cleanly
2. Verify Turtle scheduler still only enabled on the Trend sandbox: `/api/v1/turtle/status` returns 200 with `scheduler_enabled:true` on Turtle's port, 404 elsewhere
3. UI: Accounts tab renders 1 card showing "in use by 4 sandboxes"
4. Add a second account via UI; create a new sandbox against it via dropdown; start it
5. Try to delete the first account → 409, lists the 4 attached sandboxes
6. Rotate keys on an account, restart its sandboxes, verify Go bot reads new env (check Go log: `ALPACA_API_KEY` last-4 changed)

**Mocking guidance** (per `feedback-verification.md` memory): mock the credential-store in config-store tests; mock `fs` in credential-store concurrency tests; for the migration test use real `fs` in a tmp dir so rename plumbing is actually exercised.

## File inventory

**New:**
- `agent/credential-store.js`
- `agent/credential-store.test.js`
- `data/accounts-secrets.example.json`
- (this spec)

**Modified:**
- `agent/config-store.js` — accounts helpers, migration v4→v5, `createSandboxForAccount`, drop .env seed
- `agent/orchestrator.js` — `getSandboxDbPath` and `ACTIVITY_LOG_DIR` rekey by sandboxId
- `agent/data-migration.js` — rename + rekey to sandboxId
- `agent/server.js` — new `POST /api/sandboxes`, new `GET /api/accounts/:id/equity`, modified DELETE/PUT/POST account endpoints, drop `ALPACA_PUBLIC_KEY_2` re-seed, drop clone endpoint
- `agent/public/index.html` — Accounts tab cards, Add/Edit/Rotate/Delete modals, sandbox-create modal rewrite, empty-state copy
- `.gitignore` — add `data/accounts-secrets.json` and `data/backups/`

**No changes:**
- Go bot (`cmd/bot`, `internal/*`) — reads env vars, doesn't care about JS-side path shape
- `agents[]`, `strategies[]` config — out of scope
- Per-sandbox `TURTLE_SCHEDULER_ENABLED` gate logic — preserved, regression-guarded by smoke step 2
