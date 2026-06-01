# Spark / PennyProphet Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fully remove the penny-stock-momentum ("Spark" / PennyProphet) agent and its entire pipeline from the live codebase, free its 12% capital lane (split to Coil + Turtle), and de-register its sandbox — without touching the other six agents or the shared paper account.

**Architecture:** A surgical removal. Penny-exclusive Go services/controller/skills/rules are deleted whole; shared code that merely references penny (`trade_guard.go`, `position_manager.go`, `main.go`, `config.go`, config-store/orchestrator/preflight/mcp-server) is edited to excise only the penny parts. A first-of-its-kind v8→v9 config-store *removal* migration scrubs the persisted `penny-prophet` agent, `penny-momentum` strategy, and the `sbx_1b6dc838` sandbox from the live config. Capital reconciliation is prose-only (only Spark's lane was code-enforced). Three preservation traps: sub-penny price math is NOT PennyProphet, `AgentSource` is shared attribution, and no SQLite columns are dropped.

**Tech Stack:** Go (services/controllers, `go test`), Node.js ESM (`node --test`), Markdown rules/skills, dotenv.

**Spec:** `docs/superpowers/specs/2026-06-01-spark-penny-retirement-design.md`

**Execution model:** subagent-driven TDD on **Haiku** (per `subagent-model-preference`), phase by phase, reviewing each phase's diff before it lands. Removal is unconditional (no feature flag).

---

## Baseline (do this once, before Task 1)

- [x] **Establish green baseline.** Recorded 2026-06-01 on `retire-spark-penny` @ `35bcd62`:
  - `npm test` → **835 pass / 0 fail** (the `sse-keepalive` flaky passed this run).
  - `go build ./...` → **exit 0**.
  - `go test ./...` → **all packages `ok`, exit 0** (the `TestAggregator_Composite` flaky passed this run).

  Fully green baseline. Every phase gate compares against this: JS should end at `835 − (removed penny tests)` pass / 0 fail; Go must stay all-`ok`.

---

## Phase 1 — JS / config / skills layer (gate: `node --test`)

### Task 1: v8→v9 removal migration + drop penny from config defaults

**Files:**
- Modify: `agent/config-store.js` (remove penny default agent/strategy/profile; add migration; bump schemaVersion)
- Create: `agent/migration-v9.test.mjs`
- Modify: `agent/migration-v5.test.mjs` (bump 6× `schemaVersion === 8` → 9; flip 3 penny-survival assertions to penny-absent)
- Modify: `agent/config-store.test.mjs` (penny no longer a default; repoint the rename test to Turtle)

> **Why the test goes through `loadConfig`, not `normalizeConfig`:** `normalizeConfig`/`migrateLegacyConfig` are **internal** (not exported). The proven pattern (see `agent/migration-v5.test.mjs`) writes a config JSON to a temp file, calls the exported `loadConfig()`, and reads `getConfig()`/the return value. Because `loadConfig` runs the **entire** migration chain, any config — regardless of starting `schemaVersion` — ends at **v9**, so penny is always stripped by the time it returns.

- [ ] **Step 1: Write the failing migration test.** Create `agent/migration-v9.test.mjs`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let cfgStore, credStore, tmpDir, configPath, secretsPath, backupDir, sandboxesRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-v9-'));
  configPath = path.join(tmpDir, 'agent-config.json');
  secretsPath = path.join(tmpDir, 'accounts-secrets.json');
  backupDir = path.join(tmpDir, 'backups');
  sandboxesRoot = path.join(tmpDir, 'sandboxes');
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  credStore = await import('./credential-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot });
  credStore = cfgStore._setCredStoreForTests(credStore);
});

// A v8 config carrying the penny artifacts plus the six live survivors and the
// Spark sandbox (agent.activeAgentId === 'penny-prophet').
function v8WithPenny() {
  return {
    schemaVersion: 8,
    accounts: [],
    agents: [
      { id: 'default', name: 'Prophet', strategyId: 'v2-options' },
      { id: 'harvest', name: 'Harvest', strategyId: 'harvest' },
      { id: 'penny-prophet', name: 'Spark', strategyId: 'penny-momentum' },
      { id: 'mean-rev', name: 'Coil', strategyId: 'mean-rev-rsi2' },
      { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend' },
      { id: 'drift', name: 'Drift', strategyId: 'earnings-drift' },
      { id: 'defensive-prophet', name: 'DefensiveProphet', strategyId: 'prophet-defensive' },
    ],
    strategies: [
      { id: 'v2-options', name: 'Aggressive Options v2' },
      { id: 'penny-momentum', name: 'Penny Stock Momentum' },
      { id: 'trend', name: 'Multi-Asset Trend Following' },
    ],
    sandboxes: {
      sbx_keep: { id: 'sbx_keep', accountId: 'acct', agent: { activeAgentId: 'default', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {} },
      sbx_1b6dc838: { id: 'sbx_1b6dc838', accountId: 'acct', agent: { activeAgentId: 'penny-prophet', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {} },
    },
    models: [],
  };
}

test('v8→v9 removes the penny agent, strategy, and Spark sandbox; bumps version', async () => {
  await fs.writeFile(configPath, JSON.stringify(v8WithPenny()));
  const cfg = await cfgStore.loadConfig();
  assert.equal(cfg.schemaVersion, 9);
  assert.equal(cfg.agents.find(a => a.id === 'penny-prophet'), undefined);
  assert.equal(cfg.strategies.find(s => s.id === 'penny-momentum'), undefined);
  assert.equal(cfg.sandboxes.sbx_1b6dc838, undefined);
});

test('v8→v9 leaves the six surviving agents + the non-penny sandbox intact', async () => {
  await fs.writeFile(configPath, JSON.stringify(v8WithPenny()));
  const cfg = await cfgStore.loadConfig();
  for (const id of ['default', 'harvest', 'mean-rev', 'trend-prophet', 'drift', 'defensive-prophet']) {
    assert.ok(cfg.agents.find(a => a.id === id), `${id} survives`);
  }
  assert.ok(cfg.sandboxes.sbx_keep, 'non-penny sandbox survives');
});

test('v8→v9 does NOT re-add penny from defaults via mergeMissingDefaults', async () => {
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 8, accounts: [], agents: [], strategies: [], sandboxes: {}, models: [] }));
  const cfg = await cfgStore.loadConfig();
  assert.equal(cfg.agents.find(a => a.id === 'penny-prophet'), undefined);
  assert.equal(cfg.strategies.find(s => s.id === 'penny-momentum'), undefined);
});

test('v8→v9 is idempotent — reloading a v9 config is a no-op', async () => {
  await fs.writeFile(configPath, JSON.stringify(v8WithPenny()));
  await cfgStore.loadConfig();
  const afterFirst = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  assert.equal(afterFirst.schemaVersion, 9);
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot });
  credStore = cfgStore._setCredStoreForTests(credStore);
  const cfg2 = await cfgStore.loadConfig();
  assert.equal(cfg2.schemaVersion, 9);
  assert.equal(cfg2.agents.find(a => a.id === 'penny-prophet'), undefined);
});
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `node --test agent/migration-v9.test.mjs`
Expected: FAIL — `schemaVersion` is 8 not 9, and penny records survive (migration doesn't exist yet; defaults still include penny so `mergeMissingDefaults` keeps it).

- [ ] **Step 3: Remove penny from `defaultAgents()`.** In `agent/config-store.js`, delete the entire `penny-prophet` agent object (the block `{ id: 'penny-prophet', ... createdAt: ... },` spanning ~lines 237–287). Leave the surrounding `default`/`mean-rev` entries and array commas valid.

- [ ] **Step 4: Remove penny from `defaultStrategies()`.** Delete the `penny-momentum` strategy object (~lines 472–479):

```js
    {
      id: 'penny-momentum',
      name: 'Penny Stock Momentum',
      description: '...',
      rulesFile: 'TRADING_RULES_PENNY.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
```

- [ ] **Step 5: Remove the `penny_stock` heartbeat profile** (~lines 113–117), since the penny agent was its only consumer:

```js
  penny_stock: {
    label: 'Penny Stock',
    description: '...',
    phases: { pre_market: 180, market_open: 60, midday: 90, market_close: 60, after_hours: 1800, closed: 28800 },
  },
```

- [ ] **Step 6: Add the v8→v9 migration.** In `migrateLegacyConfig`, immediately after the `if (rawSchemaVersion < 8) { ... }` block and before `config.schemaVersion = 8;`, insert:

```js
  // v8 → v9: retire the penny-momentum agent (Spark / PennyProphet). The strategy
  // was permanently discontinued — too volatile for paper or live. Because
  // mergeMissingDefaults only appends, the persisted penny-prophet agent,
  // penny-momentum strategy, and the Spark sandbox survive removal-from-defaults
  // and must be scrubbed here. Idempotent: a no-op once they're already gone.
  // The Spark sandbox's runtime data dir is intentionally left on disk as frozen
  // audit trail — only its config entry is removed.
  if (rawSchemaVersion < 9) {
    config.agents = (config.agents || []).filter(a => a.id !== 'penny-prophet');
    config.strategies = (config.strategies || []).filter(s => s.id !== 'penny-momentum');
    for (const [sbxId, sbx] of Object.entries(config.sandboxes || {})) {
      if (sbx?.agent?.activeAgentId === 'penny-prophet') {
        delete config.sandboxes[sbxId];
      }
    }
  }
```

- [ ] **Step 7: Bump the schema version.** Change `config.schemaVersion = 8;  // was 7` to `config.schemaVersion = 9;  // was 8`.

- [ ] **Step 8: Fix `migration-v5.test.mjs` for the v9 endpoint.** Because `loadConfig` now runs through v9, every config ends at v9 and penny is stripped:
  - Change all six `assert.equal(..., 8 ...)` schemaVersion assertions to `9` (lines ~60, 110, 111, 256, 306, 385; also update the `'schemaVersion bumped to 8'` message strings to `9`).
  - Replace the two `assert.notEqual(byId['penny-prophet'].respondsToEmergencyWakes, false)` (lines ~265, 311) with `assert.equal(byId['penny-prophet'], undefined, 'penny-prophet retired by v9');`.
  - Replace the v7→v8 penny "not touched" block (lines ~377-379: `const penny = ...` + the two `penny.scheduledBeats`/`penny.suppressPhaseSnaps` assertions) with a single `assert.equal(cfg.agents.find(a => a.id === 'penny-prophet'), undefined, 'penny-prophet retired by v9');`.
  - **Leave the INPUT fixtures unchanged** (penny in `v4Fixture`/`v5AgentsFixture`/the v6/v7 fixtures) — they model realistic historical configs and exercise that v9 cleans them up.

- [ ] **Step 9: Fix `config-store.test.mjs`.**
  - Lines ~219-220: flip `const penny = agents.find(a => a.id === 'penny-prophet'); assert.ok(penny, 'PennyProphet should exist');` to `assert.equal(agents.find(a => a.id === 'penny-prophet'), undefined, 'PennyProphet retired');`.
  - The "user rename preserved" test (fixture line ~167 `{ id: 'penny-prophet', name: 'Spark', ... }` and assertion lines ~182-183): **repoint to a surviving renamed agent** so the test still proves rename-preservation. Change the fixture entry to `{ id: 'trend-prophet', name: 'Turtle', strategyId: 'trend' }` and the assertion to `assert.equal(cfg.agents.find(a => a.id === 'trend-prophet').name, 'Turtle', 'user rename preserved');` (Turtle is also a user rename per `agent-name-id-split`).
  - Search the rest of the file for `penny` and remove/adjust any remaining default-includes-penny assertion. Do NOT weaken unrelated assertions.

- [ ] **Step 10: Run the migration + config-store tests — expect PASS.**

Run: `node --test agent/migration-v9.test.mjs agent/migration-v5.test.mjs agent/config-store.test.mjs`
Expected: PASS (all).

- [ ] **Step 11: Commit.**

```bash
git add agent/config-store.js agent/migration-v9.test.mjs agent/migration-v5.test.mjs agent/config-store.test.mjs
git commit -m "feat(retire-penny): v8->v9 migration scrubs penny agent/strategy/sandbox; drop from defaults"
```

### Task 2: Orchestrator — remove the penny pipeline gate

**Files:**
- Modify: `agent/orchestrator.js:165-201` (the penny-pipeline comment + `pennyPipelineEnabled` + the `ENABLE_PENNY_PIPELINE` spread)

- [ ] **Step 1: Delete the penny gate.** Remove the comment block (~165–169), the line `const pennyPipelineEnabled = resolvedAgent?.strategyId === 'penny-momentum';` (~171), and the env spread `...(pennyPipelineEnabled ? { ENABLE_PENNY_PIPELINE: 'true' } : {}),` (~198). Leave the Turtle/DefensiveProphet gates and `candidateWarmerFlags(...)` call intact.

- [ ] **Step 2: Verify no other reference.**

Run: `rg -n "pennyPipelineEnabled|ENABLE_PENNY_PIPELINE" agent/`
Expected: no matches.

- [ ] **Step 3: Run the orchestrator-adjacent tests — expect PASS.**

Run: `npm test`
Expected: PASS except already-noted baseline flakies and any still-pending penny test files handled in later tasks. (If `candidate-warmer-flags.test.mjs` references `'penny-momentum'` as an arbitrary input, it still passes — both warmers return `'false'`; leave it unless it asserts penny membership, in which case change the input string to `'v2-options'`.)

- [ ] **Step 4: Commit.**

```bash
git add agent/orchestrator.js
git commit -m "feat(retire-penny): remove ENABLE_PENNY_PIPELINE orchestrator gate"
```

### Task 3: Preflight — remove pennyPreflight + registry + predicates

**Files:**
- Modify: `agent/preflight.js` (remove `isPennyOwnedOrder` ~121-139, `pennyPreflight` ~142-215+, the `'penny-momentum': pennyPreflight` registry entry ~708, and any penny-only helper)
- Modify: `agent/preflight.test.mjs` (remove penny test cases)

- [ ] **Step 1: Remove the registry entry.** In `PREFLIGHT_REGISTRY`, delete the line `'penny-momentum':   pennyPreflight,`.

- [ ] **Step 2: Remove `pennyPreflight` and `isPennyOwnedOrder`.** Delete the full `async function pennyPreflight(...)` body and the `export function isPennyOwnedOrder(order)` function plus their doc-comments. Confirm no other function calls them.

Run: `rg -n "pennyPreflight|isPennyOwnedOrder" agent/`
Expected: matches only inside `preflight.test.mjs` (handled next).

- [ ] **Step 3: Fix `preflight.test.mjs`.** Remove ALL penny test blocks: the `isPennyOwnedOrder` tests (~108-127) and every `resolvePreflight('penny-momentum', ...)` case (~283-446) — these exercise the now-deleted functions/registry entry and will otherwise error or hit the wrong handler. Search `penny` and remove each block. Keep all other-agent preflight tests intact.

- [ ] **Step 4: Run preflight tests — expect PASS.**

Run: `node --test agent/preflight.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add agent/preflight.js agent/preflight.test.mjs
git commit -m "feat(retire-penny): remove pennyPreflight, isPennyOwnedOrder, and registry entry"
```

### Task 4: Tool-allowlists — remove PENNY_SIGNALS + penny-momentum allowlist

**Files:**
- Modify: `agent/tool-allowlists.js` (remove `PENNY_SIGNALS` const ~149, its inclusion in shared lists ~212/261, and the `'penny-momentum': uniq([...])` allowlist ~222-225)
- Modify: `agent/tool-allowlists.test.mjs` (remove penny assertions)

- [ ] **Step 1: Remove penny from the allowlists.** Delete the four `get_penny_*` entries (~75-77, 106), the `PENNY_SIGNALS` const (~149), every `...PENNY_SIGNALS` spread (~212, 261), and the entire `'penny-momentum': uniq([ ... ]),` strategy allowlist (~222-225). Update the comment at ~138 ("shared by penny/mean-rev/drift") to drop "penny/".

- [ ] **Step 2: Verify.**

Run: `rg -n "penny|PENNY" agent/tool-allowlists.js`
Expected: no matches.

- [ ] **Step 3: Fix `tool-allowlists.test.mjs`.** Remove the `'penny-momentum': _internals.PENNY_SIGNALS` mapping (~line 34) and the `STRATEGY_TOOL_ALLOWLISTS['penny-momentum']` test (~line 104) — both reference deleted symbols. For the override-respecting test (~line 140, `resolveAllowedTools(override, 'penny-momentum')`), **swap the example strategy** `'penny-momentum'` → `'v2-options'` so the coverage survives. Keep the other-strategy allowlist assertions.

- [ ] **Step 4: Run — expect PASS.**

Run: `node --test agent/tool-allowlists.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add agent/tool-allowlists.js agent/tool-allowlists.test.mjs
git commit -m "feat(retire-penny): drop penny signals + penny-momentum from tool allowlists"
```

### Task 5: MCP server + remaining JS refs

**Files:**
- Modify: `mcp-server.js` (remove 4 penny tool defs ~1322-1530, their 4 handler `case` blocks ~3041-3180, and the `dominant_signal` param on `place_managed_position` ~422)
- Modify: `mcp-tools/regime-and-guard.mjs` (remove the penny reference)
- Modify: `agent/analysis-scheduler.js:67` (remove the penny reference)
- Modify: `agent/public/index.html` (remove the hardcoded penny reference)
- Modify (only if they fail): `agent/beat-context.test.mjs`, `agent/cost-store.test.mjs`, `agent/intraday-prompt.test.mjs`, `agent/trade-reconciliation.test.mjs`

- [ ] **Step 1: Remove the penny MCP tools.** In `mcp-server.js`, delete the tool definitions `get_penny_candidates`, `get_penny_signal_detail`, `get_penny_universe`, `scan_penny_universe_now` and their handler `case` blocks. Remove the `dominant_signal` parameter description from the `place_managed_position` tool (that param exists only to drive the penny social-time exit being removed in Task 10).

- [ ] **Step 2: Remove the smaller refs.** Edit `mcp-tools/regime-and-guard.mjs`, `agent/analysis-scheduler.js` (~67), and `agent/public/index.html` to delete penny references. For `index.html`, inspect first: if it's a Trades-tab agent-filter `<option>` for Spark/penny, remove that option; if it's only a comment, remove the comment. The picker itself is config-driven and needs no HTML change.

Run: `rg -n "penny|Penny|PENNY" mcp-server.js mcp-tools/ agent/analysis-scheduler.js agent/public/index.html`
Expected: no matches.

- [ ] **Step 3: Run the JS suite — expect PASS.**

Run: `npm test`
Expected: PASS. Note: `beat-context.test.mjs` (line ~29 uses `strategy: 'penny-momentum'` as generic data), `candidate-warmer-flags.test.mjs` (line ~20 has `'penny-momentum'` in an input array), `cost-store.test.mjs` (lines ~406/412 use `penny-prophet` as a cost-grouping key), `intraday-prompt.test.mjs` (line ~113), and `trade-reconciliation.test.mjs` (line ~183 `Strategy: 'penny'`) all use penny only as **arbitrary test data** against generic code — they keep passing and are NOT required to change (the Task 7 residual grep excludes `*.test.mjs`). Optional cosmetic cleanup: swap those literals to a surviving strategy (e.g. `mean-rev-rsi2`). If any unexpectedly fails, remove/adjust that penny case and re-run.

- [ ] **Step 4: Commit.**

```bash
git add mcp-server.js mcp-tools/ agent/analysis-scheduler.js agent/public/index.html agent/*.test.mjs
git commit -m "feat(retire-penny): remove penny MCP tools, dominant_signal param, and stray JS refs"
```

### Task 6: Delete penny skills + rules + fix skills-sanity

**Files:**
- Delete: `.claude/skills/adapt-strategy-penny/`, `.claude/skills/agent-health-penny/`, `.claude/skills/postmortem-penny/`, `.claude/skills/review-performance-penny/`
- Delete: `TRADING_RULES_PENNY.md`
- Modify: `scripts/skills-sanity.test.mjs` (drop the 4 penny skills from expectations)

- [ ] **Step 1: Inspect `scripts/skills-sanity.test.mjs`.** Determine how it enumerates skills (a hardcoded expected list vs. globbing the dir). Note whether deleting the dirs alone satisfies it or an expected-list edit is also needed.

- [ ] **Step 2: Delete the skills + rules file.**

```bash
git rm -r ".claude/skills/adapt-strategy-penny" ".claude/skills/agent-health-penny" ".claude/skills/postmortem-penny" ".claude/skills/review-performance-penny"
git rm TRADING_RULES_PENNY.md
```

- [ ] **Step 3: Update `skills-sanity.test.mjs`** to remove the 4 penny skills from any expected list (search `penny`).

- [ ] **Step 4: Run — expect PASS.**

Run: `node --test scripts/skills-sanity.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add scripts/skills-sanity.test.mjs
git commit -m "feat(retire-penny): delete 4 penny skills + TRADING_RULES_PENNY.md"
```

### Task 7: Phase 1 gate — full JS suite green

- [ ] **Step 1: Run the entire Node suite.**

Run: `npm test`
Expected: pass count ≥ baseline minus the removed penny tests; only the pre-noted `sse-keepalive` flaky may fail. No penny-related failures.

- [ ] **Step 2: Residual JS grep.**

Run: `rg -n "penny|Penny|PENNY|PennyProphet" agent/ scripts/ mcp-server.js mcp-tools/ --glob '!*.test.mjs'`
Expected: no matches in live JS (test files already cleaned; historical docs excluded).

---

## Phase 2 — Go layer (gate: `go build ./...` + `go test ./...`)

### Task 8: Delete penny services/controller + unwire from main.go

**Files:**
- Delete: `services/penny_types.go`, `services/penny_universe_service.go` (+`_test.go`), `services/penny_intraday.go` (+`_test.go`), `services/penny_screener_service.go` (+`_test.go`), `services/penny_signal_aggregator.go` (+`_test.go`), `services/penny_max_filter.go` (+`_test.go`), `services/social_signal_service.go` (+`_test.go`), `services/sec_edgar_service.go` (+`_test.go`)
- Delete: `controllers/penny_controller.go` (+`controllers/penny_controller_test.go`)
- **KEEP (but rename): `services/penny_earnings_service.go` (+`_test.go`)** — misnamed; it defines the shared `EarningsCalendarService` used by Coil, Drift, and `cmd/driftreplay`. Do NOT delete its contents; `git mv` it to `earnings_calendar_service.go` (Step 2c) so no `penny_*` filename survives.
- Modify: `cmd/bot/main.go` (remove penny construction + routes + controller param; KEEP `earningsService` + its Coil/Drift wiring)

> **CRITICAL TRAP:** `penny_earnings_service.go` defines `NewEarningsCalendarService`/`EarningsCalendarService` — **shared** infrastructure consumed by Coil (`meanRevEarningsChecker`, main.go ~419-420), Drift (`driftRecentReporter`, main.go ~443-444), and `cmd/driftreplay/main.go:58`. Deleting it breaks the build and those agents. It is in the "penny" namespace by filename only; its file content has **zero** "penny" references. KEEP IT.

- [ ] **Step 1: Remove the penny wiring from `cmd/bot/main.go`, preserving `earningsService`.** Delete ONLY:
  - the `pennyPipelineEnabled := os.Getenv("ENABLE_PENNY_PIPELINE") == "true"` line (~288) and its leading comment (~283-287);
  - the `if pennyPipelineEnabled { go earningsService.Start(ctx); ... WaitForFirstRefresh ... }` block (~291-296) — `earningsService.Start` had no other caller, and Coil/Drift already run without it in their penny-disabled bots;
  - the penny service + controller construction (~298-308: `NewPennyUniverseService`, `NewPennyIntradayCache`, `NewPennyScreenerService`, `NewSECEdgarService`, `NewSocialSignalService`, `NewPennyMaxFilterService`, `NewPennySignalAggregator`, `NewPennyController`);
  - the `secEdgarService.SetHeldTickersFn(positionManager.HeldPennyTickers)` line (~310-311);
  - the penny goroutine block (~313-323: the `if pennyPipelineEnabled { go ...Start(ctx) ... }` / else log);
  - the `pennyController` argument passed into the router (~589) + its parameter in the router signature (~659);
  - the 6 penny routes (~767-773).

  **KEEP** the `earningsService := services.NewEarningsCalendarService(...)` line (~290) and the Coil (`meanRevEarningsChecker`, ~419-420) and Drift (`driftRecentReporter`, ~443-444) blocks unchanged. Note: after removal `earningsService` is still referenced (by Coil/Drift), so Go won't complain about an unused variable. If, in some build, it reports `earningsService declared and not used`, that means a Coil/Drift consumer was accidentally touched — restore it.

- [ ] **Step 2: Delete the penny source/test files (NOT penny_earnings).**

```bash
git rm services/penny_types.go services/penny_universe_service.go services/penny_universe_service_test.go \
  services/penny_intraday.go services/penny_intraday_test.go \
  services/penny_screener_service.go services/penny_screener_service_test.go \
  services/penny_signal_aggregator.go services/penny_signal_aggregator_test.go \
  services/penny_max_filter.go services/penny_max_filter_test.go \
  services/social_signal_service.go services/social_signal_service_test.go \
  services/sec_edgar_service.go services/sec_edgar_service_test.go \
  controllers/penny_controller.go controllers/penny_controller_test.go
```
(If `git rm` reports a path that doesn't exist, drop it from the list and continue. **Do NOT add `penny_earnings_service.go` to this list.**)

- [ ] **Step 2b: Find any stragglers** the deletions referenced (constructors, types):

Run: `rg -n "NewPenny|NewSECEdgar|NewSocialSignal|PennyController|SetHeldTickersFn|HeldPennyTickers" cmd/ controllers/ services/`
Expected: matches only inside `position_manager.go` (`HeldPennyTickers`, removed in Task 10). Then confirm the shared earnings service is still referenced (proves it wasn't deleted): `rg -n "NewEarningsCalendarService|EarningsCalendarService" cmd/bot/main.go services/penny_earnings_service.go cmd/driftreplay/` → must show matches.

- [ ] **Step 2c: Rename the (kept) earnings service so no `penny_*` filename remains.**

```bash
git mv services/penny_earnings_service.go services/earnings_calendar_service.go
git mv services/penny_earnings_service_test.go services/earnings_calendar_service_test.go
```
(Go compiles by package, not filename, and nothing imports a filename, so this is zero-build-risk. The `EarningsCalendarService` type/constructor names are unchanged.)

- [ ] **Step 3: Build.**

Run: `go build ./...`
Expected: build still fails ONLY on `HeldPennyTickers`/`DominantSignal`/`AgentPenny`/`PennyMaxCapitalPct` references in `trade_guard.go`, `position_manager.go`, `config.go` (cleaned in Tasks 9–11). If it fails on anything else (a missed `main.go` reference, or an accidental `earningsService` break), fix it now.

- [ ] **Step 4: Commit (build may be red until Task 11 — that's expected; this commit is the file-deletion checkpoint).**

```bash
git add -A
git commit -m "feat(retire-penny): delete penny services/controller + unwire main.go"
```

### Task 9: trade_guard.go — excise AgentPenny + caps

**Files:**
- Modify: `services/trade_guard.go`
- Modify: `services/trade_guard_test.go`, `services/trade_guard_harvest_test.go` (drop penny cases)

- [ ] **Step 1: Remove the penny guard surface in `trade_guard.go`.** Delete: `AgentPenny AgentSource = "penny"` const (~19); the `case "penny-momentum": return AgentPenny` in `agentFromStrategy` (~48-49); the `PennyMaxCapitalPct`/`PennyMaxPositionDollars` config-struct fields (~67-72); the `AgentPenny: {}` map entry (~279); the penny branch in the buy check (~350-357, `if agent == AgentPenny { ... checkPennyCapCap ... }`); the `PennySymbols`/`PennyExposure`/`PennyCapitalMax` summary-struct fields (~502-504) and their assignment (~520-545); the `checkPennyCapCap` function (~678-705) and `currentPennyExposure` function (~825-860); and remove `AgentPenny` from the agent-iteration slice (~579: `[]AgentSource{AgentMain, AgentPenny, AgentHarvest, AgentTrend, AgentMeanRev, AgentDrift}` → drop `AgentPenny`). Update comments mentioning penny caps (~244-245, 295, 310, 648, 799) to drop penny.

- [ ] **Step 2: Fix the guard tests.** In `trade_guard_test.go` (heavy penny coverage — ~50 refs) and `trade_guard_harvest_test.go`, remove every test exercising `AgentPenny`, `PennyMaxCapitalPct`, `PennyMaxPositionDollars`, `checkPennyCapCap`, `currentPennyExposure`, or the penny summary fields. Keep all other-agent guard tests.

Run: `rg -n "penny|Penny" services/trade_guard.go`
Expected: no matches.

- [ ] **Step 3: Build + test the guard.**

Run: `go build ./services/ && go test ./services/ -run TradeGuard`
Expected: PASS (guard tests green; the package may still not fully build if `config.go`/`position_manager.go` are pending — if so, this run reports those, which is fine; the focused `-run TradeGuard` is the intent once the package compiles in Task 11).

- [ ] **Step 4: Commit.**

```bash
git add services/trade_guard.go services/trade_guard_test.go services/trade_guard_harvest_test.go
git commit -m "feat(retire-penny): excise AgentPenny + penny caps from trade_guard"
```

### Task 10: position_manager.go — remove penny social-time-exit only

**Files:**
- Modify: `services/position_manager.go`
- Modify: `services/position_manager_social_exit_executor_test.go` (delete — penny-exclusive), plus penny cases in other `position_manager_*_test.go`

- [ ] **Step 1: Remove ONLY the penny-agent logic.** Delete from `position_manager.go`: `shouldFireSocialTimeExit` (~1407-1447), `executeSocialTimeExit` (~1449-1545), the call site in `checkPositions` (~502-512), the `DominantSignal` struct field (~64-67) and any read of it, and `HeldPennyTickers()` (~1050-1075). **PRESERVE every "sub-penny" line** (price-rounding for sub-$1 tick increments at ~661, 677, 781, 1289, 1525 — these are Alpaca tick math, NOT PennyProphet). **PRESERVE `AgentStrategy`/`AgentSource`** fields (shared attribution). At ~1525-1529 a fallback hardcodes `strategyTag = "penny-momentum"` inside `executeSocialTimeExit` — it goes when that function is deleted.

- [ ] **Step 2: Storage / struct check.** If `DominantSignal` is read/written in `database/storage.go`, leave the physical DB column in any `CREATE TABLE` (no column drop — risk flag 3) but stop selecting/scanning it into the now-removed field. Confirm `managed_positions` round-trips without `DominantSignal`.

- [ ] **Step 3: Delete/trim penny position tests.**

```bash
git rm services/position_manager_social_exit_executor_test.go
```
Then remove penny-specific cases from `position_manager_rounding_test.go`, `position_manager_partial_fill_test.go`, `position_manager_persistence_test.go`, `position_manager_reconcile_test.go` ONLY where they assert `DominantSignal`/social-time-exit/`HeldPennyTickers` (search `penny`/`DominantSignal`/`social`). Do NOT delete sub-penny rounding tests — those stay.

Run: `rg -n "DominantSignal|HeldPennyTickers|shouldFireSocialTimeExit|executeSocialTimeExit" services/`
Expected: no matches.

- [ ] **Step 4: Build + test.**

Run: `go build ./services/ && go test ./services/ -run PositionManager`
Expected: PASS once `config.go` (Task 11) is also done; if the package still references `PennyMaxCapitalPct`, that's Task 11.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "feat(retire-penny): remove penny social-time-exit from position_manager (keep sub-penny math + AgentSource)"
```

### Task 11: config.go + models + storage + segment_pnl + comment refs

**Files:**
- Modify: `config/config.go`, `models/models.go`, `database/storage.go` (+ its penny tests), `services/segment_pnl_service.go`, and incidental comment refs in `services/{turtle_executor,meanrev_signal_service,economic_feeds,alpaca_trading,alpaca_data,shared_bar_cache}.go` and `interfaces/`.

- [ ] **Step 1: config.go.** Delete the `PennyMaxCapitalPct`/`PennyMaxPositionDollars` struct fields (~34-35) and their env parsing (~118-119, `PENNY_MAX_CAPITAL_PCT`/`PENNY_MAX_POSITION_DOLLARS`).

- [ ] **Step 2: models.go / storage.go / segment_pnl_service.go.** Remove penny references. For `storage.go` + `storage_attribution_test.go` + `storage_managed_position_test.go`, excise penny attribution cases but keep the shared attribution machinery. For `segment_pnl_service.go`, if there's a penny special-case in `ListManagedStrategies`/writer, remove it.

- [ ] **Step 3: Comment-only refs.** In `turtle_executor.go`, `meanrev_signal_service.go`, `economic_feeds.go`, `alpaca_trading.go`, `alpaca_data.go`, `shared_bar_cache.go`, `interfaces/trading*.go`, update comments that name penny as an example (e.g. "shared by penny/mean-rev" → drop penny). These are comments — no behavior change.

Run: `rg -n "penny|Penny|PENNY|AgentPenny" config/ models/ database/ services/ controllers/ cmd/ interfaces/`
Expected: no matches (all live Go penny references gone).

- [ ] **Step 4: Build + full Go test.**

Run: `go build ./... && go test ./...`
Expected: PASS. Only `TestAggregator_Composite` (pre-existing flaky) may fail. No penny/compile failures.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "feat(retire-penny): remove penny from config/models/storage/segment_pnl + comment refs"
```

### Task 12: Phase 2 gate — full Go build + test green

- [ ] **Step 1: Clean build + test.**

Run: `go build ./... && go test ./...`
Expected: green except the noted `TestAggregator_Composite` flaky.

- [ ] **Step 2: Residual Go grep + filename check.**

Run: `rg -n "penny|Penny|PENNY|AgentPenny|PennyMax" --glob '*.go'`
Expected: no matches anywhere in `.go` files.

Run: `git ls-files 'services/penny_*' 'controllers/penny_*'`
Expected: empty (the only kept file was renamed to `earnings_calendar_service.go`; no `penny_*` Go file remains).

---

## Phase 3 — capital reconciliation + env (prose)

### Task 13: Remove dead penny env vars

**Files:**
- Modify: root `.env`, `.env.example`

- [ ] **Step 1: Delete the penny env vars.** Remove `PENNY_MAX_CAPITAL_PCT` and `PENNY_MAX_POSITION_DOLLARS` (and any adjacent penny comment lines) from both `.env` and `.env.example`. (Nothing reads them now — `config.go` no longer parses them.)

Run: `rg -n "PENNY" .env .env.example`
Expected: no matches.

- [ ] **Step 2: Commit.**

```bash
git add .env.example
git commit -m "feat(retire-penny): remove dead PENNY_MAX_* env vars"
```
(Note: root `.env` is gitignored — edit it on disk for the live runtime, but it won't appear in the commit. Confirm with `git status` that only `.env.example` is staged.)

### Task 14: Capital reconciliation — split Spark's 12% to Coil + Turtle

**Files:**
- Modify: `TRADING_RULES_MEANREV.md` (Coil 18%→24%), `TRADING_RULES_TREND.md` (Turtle 14%→20%), and the six-lane segment table wherever it appears: `TRADING_RULES_V2.md`, `TRADING_RULES_TREND.md`, `TRADING_RULES_MEANREV.md`, `TRADING_RULES_HARVEST.md`, `TRADING_RULES_DRIFT.md`.

- [ ] **Step 1: Find every copy of the lane table.**

Run: `rg -n "Spark|penny|12%|18%|14%" TRADING_RULES_*.md`
Expected: locates the segment/allocation tables and any Spark row.

- [ ] **Step 2: Edit each table** to the reconciled five-lane allocation: Prophet 34% / **Coil 24%** / **Turtle 20%** / Drift 12% / Harvest 10% (sum 100%). Delete the Spark/penny row everywhere. In `TRADING_RULES_MEANREV.md` set Coil's lane to 24%; in `TRADING_RULES_TREND.md` set Turtle's lane to 20%. Only change per-position/max-count numbers if a rules file explicitly derives them from the lane ceiling; otherwise leave position-level knobs untouched (move only the lane %).

- [ ] **Step 3: Verify the math + no stray Spark.**

Run: `rg -n "Spark|penny|Penny" TRADING_RULES_*.md`
Expected: no matches. Manually confirm each table sums to 100%.

- [ ] **Step 4: Commit.**

```bash
git add TRADING_RULES_*.md
git commit -m "feat(retire-penny): reconcile capital — split Spark 12% to Coil (24%) + Turtle (20%)"
```

---

## Phase 4 — whole-branch verification

### Task 15: Final verification

- [ ] **Step 1: Full suites green.**

Run: `go build ./... && go test ./...` then `npm test`
Expected: green except pre-noted flakies (`TestAggregator_Composite`, `sse-keepalive`).

- [ ] **Step 2: Residual sweep across the LIVE tree** (frozen-historical dirs excluded):

Run:
```bash
rg -n "penny|Penny|PENNY|PennyProphet|AgentPenny" \
  --glob '!docs/superpowers/**' --glob '!activity_logs/**' --glob '!data/**' \
  --glob '!Claudes Notes/**' --glob '!potential additions/**' --glob '!**/*.test.*'
```
Expected: no matches. (Any hit is a missed live reference — fix before finishing.)

- [ ] **Step 3: Migration against a COPY of the LIVE config.** Copy the real repo-root config to a temp dir and run it through the exported `loadConfig` (via the test-path hooks) to prove the live Spark sandbox + penny records get scrubbed and the other six agents survive. This reads the live config but writes only to the temp copy — the real `data/agent-config.json` is untouched (the real migration runs when the orchestrator restarts).

Run from the **worktree root** (so `./agent/...` resolves), pointing `LIVE_CONFIG` at the repo-root config:

```bash
LIVE_CONFIG="$(git rev-parse --show-toplevel)/../../data/agent-config.json" \
node --input-type=module -e '
import fs from "fs/promises";
import path from "path";
import os from "os";
const cfgStore = await import("./agent/config-store.js");
const credStore = await import("./agent/credential-store.js");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "penny-live-"));
await fs.copyFile(process.env.LIVE_CONFIG, path.join(tmp, "agent-config.json"));
cfgStore._setPathsForTests({
  configPath: path.join(tmp, "agent-config.json"),
  secretsPath: path.join(tmp, "accounts-secrets.json"),
  backupDir: path.join(tmp, "backups"),
  sandboxesRoot: path.join(tmp, "sandboxes"),
});
cfgStore._setCredStoreForTests(credStore);
const cfg = await cfgStore.loadConfig();
const ids = cfg.agents.map(a => a.id);
console.log("schemaVersion:", cfg.schemaVersion);
console.log("has penny-prophet:", ids.includes("penny-prophet"));
console.log("has penny-momentum strat:", cfg.strategies.some(s => s.id === "penny-momentum"));
console.log("has sbx_1b6dc838:", !!cfg.sandboxes["sbx_1b6dc838"]);
console.log("surviving agents:", ids.join(", "));
'
```
(The repo root is the parent-of-parent of `.claude/worktrees/<branch>`; adjust the `LIVE_CONFIG` path if your layout differs — it must point at the real `data/agent-config.json`.) Expected: `schemaVersion: 9`, `has penny-prophet: false`, `has penny-momentum strat: false`, `has sbx_1b6dc838: false`, surviving agents include `default, harvest, mean-rev, trend-prophet, drift, defensive-prophet`.

- [ ] **Step 4: Confirm the other six agents are untouched.**

Run: `rg -n "default|harvest|mean-rev|trend|earnings-drift|prophet-defensive" agent/config-store.js | rg -n "id:"`
Expected: all six agent/strategy ids still present in defaults.

---

## Landing (after Task 15 — use superpowers:finishing-a-development-branch)

- Squash the branch to a single commit.
- Rebase onto current local `main` (re-verify `main` HEAD first — concurrent sessions may have advanced it).
- Fast-forward local `main` so the owner's rebuild-from-local-main picks it up (per `claude-commits-must-reach-local-main`). No GitHub push unless requested.
- **Owner activation:** rebuild the Go bot + restart the Node orchestrator (runs the v9 migration → Spark vanishes from the picker).
- **Post-merge memory updates:** `capital-allocation-reconciled` (five lanes; Coil 24 / Turtle 20), `fleet-uncorrelated-ballast-pivot` (Spark retirement executed), `managed-position-lifecycle-scope` (penny review-skill breakage now moot — skills deleted).
