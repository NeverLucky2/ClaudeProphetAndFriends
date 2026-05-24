# Trade Ruleset-Epoch Stamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp every new `decisive_actions/*.json` record with `strategyId` + `strategyVersion` (a hash of the resolved rules text), and write a per-agent marker file recording the version the live agent is stamping.

**Architecture:** A new shared ESM module (`scripts/strategy-version.mjs`) owns rule resolution, version hashing, and marker building/writing. `agent/harness.js` calls it at agent (re)load to compute the version, write the marker, and export `OPENPROPHET_STRATEGY_VERSION`. The MCP `log_decision` handler stamps the two fields via a small testable record-builder.

**Tech Stack:** Node ESM (`"type": "module"`), `node:test` + `node:assert/strict`, `node:crypto` SHA-256. Tests run via `npm test` (`node --test agent/**/*.test.mjs mcp-tools/**/*.test.mjs scripts/**/*.test.mjs`).

**Spec:** `docs/superpowers/specs/2026-05-23-trade-ruleset-epoch-stamp-design.md`

**Note on sequencing:** This plan creates `resolveStrategyRules` (the companion Spec C also depends on it). Plan C consumes it without re-creating it.

---

## File Structure

- `scripts/strategy-version.mjs` (NEW) — `computeStrategyVersion`, `resolveStrategyRules`, `buildVersionMarker`, `writeVersionMarker`.
- `scripts/strategy-version.test.mjs` (NEW) — unit tests for all four.
- `mcp-tools/decision-record.mjs` (NEW) — `buildDecisionRecord(args, ctx, now)` pure record builder.
- `mcp-tools/decision-record.test.mjs` (NEW) — unit tests.
- `agent/harness.js` (MODIFY) — import the shared module; refactor `buildSystemPrompt` resolution (103-120) to use `resolveStrategyRules`; in the reload method (389-392) compute `this._strategyVersion` + write marker; export env var (after 1054).
- `mcp-server.js` (MODIFY) — import + use `buildDecisionRecord` in `log_decision` (2211-2236).
- `.gitignore` (MODIFY) — ignore the marker file.

---

## Task 1: `computeStrategyVersion`

**Files:**
- Create: `scripts/strategy-version.mjs`
- Test: `scripts/strategy-version.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// scripts/strategy-version.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStrategyVersion } from './strategy-version.mjs';

test('computeStrategyVersion: stable for identical text', () => {
  assert.equal(computeStrategyVersion('rule A\nrule B'), computeStrategyVersion('rule A\nrule B'));
});

test('computeStrategyVersion: differs on substantive change', () => {
  assert.notEqual(computeStrategyVersion('rule A'), computeStrategyVersion('rule B'));
});

test('computeStrategyVersion: CRLF and trailing whitespace do not flip', () => {
  assert.equal(computeStrategyVersion('rule A\nrule B'), computeStrategyVersion('rule A  \r\nrule B\t'));
});

test('computeStrategyVersion: empty / whitespace / null -> null', () => {
  assert.equal(computeStrategyVersion(''), null);
  assert.equal(computeStrategyVersion('   \n  '), null);
  assert.equal(computeStrategyVersion(null), null);
});

test('computeStrategyVersion: 12 hex chars when non-null', () => {
  assert.match(computeStrategyVersion('anything'), /^[0-9a-f]{12}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/strategy-version.test.mjs`
Expected: FAIL — `Cannot find module './strategy-version.mjs'` (or export missing).

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/strategy-version.mjs
// Shared rule-resolution + epoch-version hashing for the learning loop.
// Spec: docs/superpowers/specs/2026-05-23-trade-ruleset-epoch-stamp-design.md
import { createHash } from 'node:crypto';

// Returns a stable 12-char hex epoch id for a ruleset, or null for empty rules.
// Normalizes CRLF->LF and strips trailing horizontal whitespace so cosmetic-only
// diffs do not spuriously create a new epoch.
export function computeStrategyVersion(rulesText) {
  if (!rulesText || !rulesText.trim()) return null;
  const normalized = rulesText.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/strategy-version.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/strategy-version.mjs scripts/strategy-version.test.mjs
git commit -m "feat(epoch): add computeStrategyVersion hash helper"
```

---

## Task 2: `resolveStrategyRules`

Resolves the effective rules text by walking the four sources in `buildSystemPrompt`'s order. `readFile`/`cwd` are injectable for testing.

**Files:**
- Modify: `scripts/strategy-version.mjs`
- Test: `scripts/strategy-version.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to scripts/strategy-version.test.mjs
import { resolveStrategyRules } from './strategy-version.mjs';

const noFiles = { readFile: async () => { throw new Error('ENOENT'); } };

test('resolveStrategyRules: agent.customStrategyRules wins', async () => {
  const rules = await resolveStrategyRules({ customStrategyRules: 'inline rules' }, { customRules: 'strat rules' }, noFiles);
  assert.equal(rules, 'inline rules');
});

test('resolveStrategyRules: strategy.rulesFile read via injected readFile', async () => {
  const readFile = async (p) => { assert.match(String(p), /MY_RULES\.md$/); return 'file rules'; };
  const rules = await resolveStrategyRules({ strategyId: 's1' }, { rulesFile: 'MY_RULES.md' }, { readFile });
  assert.equal(rules, 'file rules');
});

test('resolveStrategyRules: strategy.customRules when no rulesFile', async () => {
  const rules = await resolveStrategyRules({ strategyId: 's1' }, { customRules: 'strat rules' }, noFiles);
  assert.equal(rules, 'strat rules');
});

test('resolveStrategyRules: falls back to TRADING_RULES.md', async () => {
  const readFile = async (p) => { assert.match(String(p), /TRADING_RULES\.md$/); return 'fallback rules'; };
  const rules = await resolveStrategyRules({}, null, { readFile });
  assert.equal(rules, 'fallback rules');
});

test('resolveStrategyRules: empty string when nothing resolvable', async () => {
  const rules = await resolveStrategyRules({}, null, noFiles);
  assert.equal(rules, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/strategy-version.test.mjs`
Expected: FAIL — `resolveStrategyRules is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// add imports at top of scripts/strategy-version.mjs
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

// Resolve effective rules text, same precedence as buildSystemPrompt:
// agent.customStrategyRules -> strategy.rulesFile -> strategy.customRules -> TRADING_RULES.md.
// `strategy` is the already-looked-up strategy object (or null).
export async function resolveStrategyRules(agentConfig, strategy, opts = {}) {
  const { readFile = fsReadFile, cwd = process.cwd() } = opts;
  if (agentConfig?.customStrategyRules) return agentConfig.customStrategyRules;
  if (strategy) {
    if (strategy.rulesFile) {
      try { return await readFile(path.join(cwd, strategy.rulesFile), 'utf-8'); } catch { /* fall through */ }
    } else if (strategy.customRules) {
      return strategy.customRules;
    }
  }
  try { return await readFile(path.join(cwd, 'TRADING_RULES.md'), 'utf-8'); } catch { return ''; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/strategy-version.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/strategy-version.mjs scripts/strategy-version.test.mjs
git commit -m "feat(epoch): add resolveStrategyRules shared resolver"
```

---

## Task 3: `buildVersionMarker` + `writeVersionMarker`

**Files:**
- Modify: `scripts/strategy-version.mjs`
- Test: `scripts/strategy-version.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// append to scripts/strategy-version.test.mjs
import { buildVersionMarker, writeVersionMarker } from './strategy-version.mjs';

test('buildVersionMarker: shape with id, version, startedAt', () => {
  const m = buildVersionMarker({ strategyId: 'v2-options' }, 'a3f9c1d8e2b4', new Date('2026-05-23T00:00:00Z'));
  assert.deepEqual(m, { strategyId: 'v2-options', strategyVersion: 'a3f9c1d8e2b4', startedAt: '2026-05-23T00:00:00.000Z' });
});

test('buildVersionMarker: null id and version when absent', () => {
  const m = buildVersionMarker({}, null, new Date('2026-05-23T00:00:00Z'));
  assert.equal(m.strategyId, null);
  assert.equal(m.strategyVersion, null);
});

test('writeVersionMarker: mkdir + write to correct path with injected fs', async () => {
  const calls = {};
  const mkdir = async (d, o) => { calls.mkdir = { d, o }; };
  const writeFile = async (f, c) => { calls.writeFile = { f, c }; };
  const marker = { strategyId: 'x', strategyVersion: 'y', startedAt: 'z' };
  const file = await writeVersionMarker('6e4f26af', marker, { mkdir, writeFile, cwd: '/repo' });
  assert.match(file.replace(/\\/g, '/'), /\/repo\/data\/sandboxes\/6e4f26af\/\.current_strategy_version\.json$/);
  assert.deepEqual(calls.mkdir.o, { recursive: true });
  assert.equal(JSON.parse(calls.writeFile.c).strategyVersion, 'y');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/strategy-version.test.mjs`
Expected: FAIL — `buildVersionMarker is not a function`.

- [ ] **Step 3: Write minimal implementation**

```js
// extend the import at top of scripts/strategy-version.mjs:
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir } from 'node:fs/promises';

export function buildVersionMarker(agentConfig, strategyVersion, now = new Date()) {
  return {
    strategyId: agentConfig?.strategyId || null,
    strategyVersion: strategyVersion ?? null,
    startedAt: now.toISOString(),
  };
}

// Writes data/sandboxes/<accountDir>/.current_strategy_version.json. Returns the path.
export async function writeVersionMarker(accountDir, marker, opts = {}) {
  const { writeFile = fsWriteFile, mkdir = fsMkdir, cwd = process.cwd() } = opts;
  const dir = path.join(cwd, 'data', 'sandboxes', accountDir);
  const file = path.join(dir, '.current_strategy_version.json');
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(marker, null, 2));
  return file;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/strategy-version.test.mjs`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/strategy-version.mjs scripts/strategy-version.test.mjs
git commit -m "feat(epoch): add version marker build/write helpers"
```

---

## Task 4: `buildDecisionRecord` (record builder)

**Files:**
- Create: `mcp-tools/decision-record.mjs`
- Test: `mcp-tools/decision-record.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// mcp-tools/decision-record.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionRecord } from './decision-record.mjs';

const ctx = { sandboxId: 'sbx_6e4f26af', accountId: '6e4f26af', strategyId: 'v2-options', strategyVersion: 'a3f9c1d8e2b4' };
const now = new Date('2026-05-23T14:03:11.000Z');

test('buildDecisionRecord: stamps strategyId + strategyVersion', () => {
  const r = buildDecisionRecord({ action: 'BUY', symbol: 'SPY', reasoning: 'why', market_data: { x: 1 } }, ctx, now);
  assert.equal(r.strategyId, 'v2-options');
  assert.equal(r.strategyVersion, 'a3f9c1d8e2b4');
  assert.equal(r.action, 'BUY');
  assert.equal(r.symbol, 'SPY');
  assert.equal(r.sandbox_id, 'sbx_6e4f26af');
  assert.equal(r.timestamp, '2026-05-23T14:03:11.000Z');
});

test('buildDecisionRecord: null stamps when env unset, symbol/market_data defaults', () => {
  const r = buildDecisionRecord({ action: 'PASS', reasoning: 'why' }, { sandboxId: 's', accountId: 'a' }, now);
  assert.equal(r.strategyId, null);
  assert.equal(r.strategyVersion, null);
  assert.equal(r.symbol, null);
  assert.deepEqual(r.market_data, {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test mcp-tools/decision-record.test.mjs`
Expected: FAIL — `Cannot find module './decision-record.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// mcp-tools/decision-record.mjs
// Pure builder for decisive_actions records. Stamps the ruleset epoch.
// Spec: docs/superpowers/specs/2026-05-23-trade-ruleset-epoch-stamp-design.md
export function buildDecisionRecord(args, ctx, now = new Date()) {
  return {
    timestamp: now.toISOString(),
    sandbox_id: ctx.sandboxId,
    account_id: ctx.accountId,
    strategyId: ctx.strategyId || null,
    strategyVersion: ctx.strategyVersion || null,
    action: args.action,
    symbol: args.symbol || null,
    reasoning: args.reasoning,
    market_data: args.market_data || {},
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test mcp-tools/decision-record.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/decision-record.mjs mcp-tools/decision-record.test.mjs
git commit -m "feat(epoch): add buildDecisionRecord with epoch stamp"
```

---

## Task 5: Wire `buildDecisionRecord` into `log_decision`

**Files:**
- Modify: `mcp-server.js` (import near other `mcp-tools` imports ~line 18; `log_decision` handler 2211-2236)

- [ ] **Step 1: Add the import**

Near the existing `import { regimeAndGuardTools, ... } from './mcp-tools/regime-and-guard.mjs';` (line 18), add:

```js
import { buildDecisionRecord } from './mcp-tools/decision-record.mjs';
```

- [ ] **Step 2: Replace the inline record construction**

In the `log_decision` case, replace the object literal currently at lines 2216-2224:

```js
        const decision = {
          timestamp: new Date().toISOString(),
          sandbox_id: OPENPROPHET_SANDBOX_ID,
          account_id: OPENPROPHET_ACCOUNT_ID,
          action: args.action,
          symbol: args.symbol || null,
          reasoning: args.reasoning,
          market_data: args.market_data || {},
        };
```

with:

```js
        const decision = buildDecisionRecord(args, {
          sandboxId: OPENPROPHET_SANDBOX_ID,
          accountId: OPENPROPHET_ACCOUNT_ID,
          strategyId: process.env.OPENPROPHET_STRATEGY,
          strategyVersion: process.env.OPENPROPHET_STRATEGY_VERSION,
        });
```

- [ ] **Step 3: Verify nothing else in the suite broke**

Run: `npm test`
Expected: PASS — no regressions (the new `decision-record` test is included via the `mcp-tools/**` glob).

- [ ] **Step 4: Manual smoke check of the stamp**

Run:
```bash
OPENPROPHET_STRATEGY=v2-options OPENPROPHET_STRATEGY_VERSION=abc123abc123 node -e "import('./mcp-tools/decision-record.mjs').then(({buildDecisionRecord})=>console.log(buildDecisionRecord({action:'BUY',symbol:'SPY',reasoning:'r'},{sandboxId:'s',accountId:'a',strategyId:process.env.OPENPROPHET_STRATEGY,strategyVersion:process.env.OPENPROPHET_STRATEGY_VERSION})))"
```
Expected: printed record with `"strategyId": "v2-options"` and `"strategyVersion": "abc123abc123"`.

- [ ] **Step 5: Commit**

```bash
git add mcp-server.js
git commit -m "feat(epoch): stamp decisive_actions via buildDecisionRecord"
```

---

## Task 6: Harness — compute version, write marker, export env var

**Files:**
- Modify: `agent/harness.js` (import; `buildSystemPrompt` 101-121; reload method 389-392; spawn env 1042-1056)

- [ ] **Step 1: Add the import**

After the existing local imports (e.g. after line 13 `import { resolveAllowedTools } from './tool-allowlists.js';`), add:

```js
import { resolveStrategyRules, computeStrategyVersion, buildVersionMarker, writeVersionMarker } from '../scripts/strategy-version.mjs';
```

- [ ] **Step 2: Refactor `buildSystemPrompt` rule resolution to use the shared resolver**

Replace the resolution block at lines 103-120 (from `let strategyRules = '';` through the `TRADING_RULES.md` fallback that ends `tradingRules = '';`) with:

```js
  const strategy = agentConfig.strategyId && typeof getStrategyById === 'function'
    ? getStrategyById(agentConfig.strategyId)
    : null;
  const tradingRules = await resolveStrategyRules(agentConfig, strategy, { readFile: fs.readFile });
```

(Leave everything from `// Layer 1: Agent Identity` onward unchanged — it already consumes `tradingRules`.)

- [ ] **Step 3: Verify existing harness/prompt tests still pass**

Run: `npm test`
Expected: PASS — `buildSystemPrompt` behaves identically (same resolution order); any existing prompt tests are green.

- [ ] **Step 4: Compute version + write marker in the reload method**

Immediately after the `this.systemPrompt = await buildSystemPrompt(...)` block (ends line 392), insert:

```js
    // Epoch stamp: compute the version of the rules this agent is now running,
    // expose it for the MCP env (Step 5), and publish the marker Spec C reads
    // as its source of truth. Computed here — before any beat spawns the MCP
    // server — so no decision can be logged with a null stamp due to ordering.
    {
      const strategyForVersion = this._agentConfig?.strategyId && typeof this.getStrategyById === 'function'
        ? this.getStrategyById(this._agentConfig.strategyId)
        : null;
      const resolvedRules = await resolveStrategyRules(this._agentConfig, strategyForVersion, { readFile: fs.readFile });
      this._strategyVersion = computeStrategyVersion(resolvedRules);
      const accountDir = this.state.activeAccountId || this.accountId || '';
      if (accountDir) {
        try {
          await writeVersionMarker(accountDir, buildVersionMarker(this._agentConfig, this._strategyVersion));
        } catch (err) {
          this.state.emit('agent_log', { message: `Failed to write strategy-version marker: ${err.message}`, level: 'warn' });
        }
      }
    }
```

- [ ] **Step 5: Export the env var to the spawned MCP server**

In the spawn `env` block, immediately after line 1054 (`OPENPROPHET_STRATEGY: this._agentConfig?.strategyId || '',`), add:

```js
          OPENPROPHET_STRATEGY_VERSION: this._strategyVersion || '',
```

- [ ] **Step 6: Add the startup-ordering invariant guard**

Immediately before the `spawn(OPENCODE_BIN, ...)` call (line 1040), add:

```js
      // Invariant: _strategyVersion must be resolved before the MCP server spawns,
      // otherwise early decisions stamp null. It is set in the reload method that
      // runs before any beat. `null` is valid (no-rules agent); `undefined` is a bug.
      if (this._strategyVersion === undefined) {
        throw new Error('Harness invariant: _strategyVersion not computed before MCP spawn');
      }
```

Also initialize the field in the constructor (near the other `this._...` assignments, e.g. after line 276 `this._agentConfig = null;`):

```js
    this._strategyVersion = null;
```

- [ ] **Step 7: Verify**

Run: `npm test`
Expected: PASS. (Harness unit tests, if present, still green; no new failures.)

- [ ] **Step 8: Commit**

```bash
git add agent/harness.js
git commit -m "feat(epoch): harness computes version, writes marker, exports env"
```

---

## Task 7: Gitignore the marker

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add the ignore rule**

After the existing `data/sandboxes/**/*.friction.json` line (54-55 region), add:

```
# Per-agent current ruleset-version marker (regenerated by agent/harness.js on start)
data/sandboxes/**/.current_strategy_version.json
```

- [ ] **Step 2: Verify it is ignored**

Run: `git check-ignore data/sandboxes/6e4f26af/.current_strategy_version.json`
Expected: the path is printed (meaning it is ignored).

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(epoch): gitignore current-version marker"
```

---

## Self-Review

- **Spec coverage:** Goals 1-2 (stamp id+version) → Tasks 1,4,5,6. Goal 3 (shared hashing) → Task 1. Goal 4 (marker) → Tasks 3,6. Four-source resolution → Task 2. Edge cases (null stamp, legacy) → Tasks 1,2,4. Startup invariant → Task 6 Step 6. Marker gitignore → Task 7. All covered.
- **No placeholders:** every code/command step is concrete.
- **Type consistency:** `resolveStrategyRules(agentConfig, strategy, opts)`, `computeStrategyVersion(text)`, `buildVersionMarker(agentConfig, version, now)`, `writeVersionMarker(accountDir, marker, opts)`, `buildDecisionRecord(args, ctx, now)` — signatures identical across tasks and call sites.
