# Harvest Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently remove the Harvest iron-condor agent from the live codebase, free its 10% capital lane to Turtle, and de-register its sandbox — while preserving the shared IV/vol infrastructure that Prophet's options-entry gate depends on.

**Architecture:** Mirror the Spark/PennyProphet retirement (`bc8df39`). Two coordinated halves — remove `harvest` from code defaults so it can never be re-appended, and a v9→v10 config migration that scrubs the persisted records. The "Harvest" name covers two things: the condor *strategy* (deleted) and an IV/vol *service stack* (kept + renamed, because Prophet depends on it). Each phase ends with a green build/test gate before the next begins.

**Tech Stack:** Go 1.x (Gin + GORM/SQLite backend bot), Node.js (agent orchestrator + MCP server, `node:test`), Markdown trading-rules + JSON friction config.

**Spec:** `docs/superpowers/specs/2026-06-02-harvest-retirement-design.md`
**Branch:** `retire-harvest` (already created off local `main` @ `6640784`; the design spec is committed on it as `d49b8c3`).

---

## File Structure

### Delete entirely (condor-strategy-exclusive)
- `services/harvest_service.go` (+ `harvest_service_test.go`)
- `services/harvest_pricer.go` (+ `harvest_pricer_test.go`)
- `services/harvest_exit_monitor.go` (+ `harvest_exit_monitor_test.go`)
- `services/harvest_closer.go` (+ `harvest_closer_test.go`)
- `services/trade_guard_harvest_test.go`
- `controllers/harvest_controller.go` (+ `harvest_controller_test.go`)
- `database/storage_harvest_test.go`
- `.claude/skills/harvest-parameter-review/SKILL.md`
- `TRADING_RULES_HARVEST.md`

### Keep + rename (shared IV/vol infra — Prophet depends on it)
- `services/harvest_ivr_service.go` → `services/ivr_service.go` (`HarvestIVRService`→`IVRankService`)
- `services/harvest_ivr_service_test.go` → `services/ivr_service_test.go`
- `models/harvest_models.go` → split: keep `DBHarvestIVSnapshot`→`DBIVSnapshot` in new `models/iv_models.go` (table name unchanged); drop `DBHarvestCondor`
- `services/realized_vol_service.go` — keep as-is
- `controllers/iv_controller.go` — keep; update type reference

### Modify (shared code referencing Harvest)
- `agent/config-store.js`, `agent/preflight.js`, `agent/analysis-scheduler.js`, `agent/orchestrator.js`, `agent/tool-allowlists.js`, `agent/harness.js`, `agent/public/index.html`, `mcp-server.js`
- `cmd/bot/main.go`, `services/trade_guard.go`, `services/prophet_options_stop_monitor.go`, `services/segment_pnl_writer.go`, `database/storage.go`, `controllers/order_controller.go`, `config/config.go`
- `config/friction.json`, `config/friction-stress.json`, `.env.example`
- `TRADING_RULES_TREND.md`, `TRADING_RULES_V2.md`, `TRADING_RULES_MEANREV.md`, `TRADING_RULES_DRIFT.md`, `TRADING_RULES_DEFENSIVE_PROPHET.md`

### Create
- `agent/migration-v10.test.mjs`
- `models/iv_models.go`

### Leave frozen (do NOT touch)
- `docs/superpowers/specs|plans/**` historical harvest docs, `data/sandboxes/sbx_449fedf6/**`, `activity_logs/**`, `Claudes Notes/**`, `potential additions/**`, `.claude/worktrees/**`.

> **False-positive guard (applies to every grep/delete):** `shouldHarvest`, `hedgeHarvestFrac`, and `CloseReason "harvest"` inside `services/prophet_hedge_*.go` are DefensiveProphet's own "harvest the profit" concept. They have ZERO dependency on the Harvest agent. **Never touch them.**

---

## Phase 1 — JS / config layer

Gate for the phase: `npm test` green. (Use the repo's test runner, not `node --test agent/` directly — `normalizeConfig` is not exported; migration tests go through `loadConfig` + a temp file.)

### Task 1: v9→v10 config migration

**Files:**
- Create: `agent/migration-v10.test.mjs`
- Modify: `agent/config-store.js` (migration block near line 811-828; `schemaVersion` set at line 828)

- [ ] **Step 1: Write the failing test**

Create `agent/migration-v10.test.mjs` (mirrors `migration-v9.test.mjs`):

```javascript
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let cfgStore, credStore, tmpDir, configPath, secretsPath, backupDir, sandboxesRoot;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-v10-'));
  configPath = path.join(tmpDir, 'agent-config.json');
  secretsPath = path.join(tmpDir, 'accounts-secrets.json');
  backupDir = path.join(tmpDir, 'backups');
  sandboxesRoot = path.join(tmpDir, 'sandboxes');
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  credStore = await import('./credential-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot });
  credStore = cfgStore._setCredStoreForTests(credStore);
});

function v9WithHarvest() {
  return {
    schemaVersion: 9,
    accounts: [],
    agents: [
      { id: 'default', name: 'Prophet', strategyId: 'v2-options' },
      { id: 'harvest', name: 'Harvest', strategyId: 'harvest' },
      { id: 'mean-rev', name: 'Coil', strategyId: 'mean-rev-rsi2' },
      { id: 'trend-prophet', name: 'Turtle', strategyId: 'trend' },
      { id: 'drift', name: 'Drift', strategyId: 'earnings-drift' },
      { id: 'defensive-prophet', name: 'DefensiveProphet', strategyId: 'prophet-defensive' },
    ],
    strategies: [
      { id: 'v2-options', name: 'Aggressive Options v2' },
      { id: 'harvest', name: 'Harvest — Iron Condor Premium Seller' },
      { id: 'trend', name: 'Multi-Asset Trend Following' },
    ],
    sandboxes: {
      sbx_keep: { id: 'sbx_keep', accountId: 'acct', agent: { activeAgentId: 'default', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {} },
      sbx_449fedf6: { id: 'sbx_449fedf6', accountId: 'acct', agent: { activeAgentId: 'harvest', overrides: {} }, heartbeat: {}, permissions: {}, plugins: {} },
    },
    models: [],
  };
}

test('v9→v10 removes the harvest agent, strategy, and Harvest sandbox; bumps version', async () => {
  await fs.writeFile(configPath, JSON.stringify(v9WithHarvest()));
  const cfg = await cfgStore.loadConfig();
  assert.equal(cfg.schemaVersion, 10);
  assert.equal(cfg.agents.find(a => a.id === 'harvest'), undefined);
  assert.equal(cfg.strategies.find(s => s.id === 'harvest'), undefined);
  assert.equal(cfg.sandboxes.sbx_449fedf6, undefined);
});

test('v9→v10 leaves the five surviving agents + the non-harvest sandbox intact', async () => {
  await fs.writeFile(configPath, JSON.stringify(v9WithHarvest()));
  const cfg = await cfgStore.loadConfig();
  for (const id of ['default', 'mean-rev', 'trend-prophet', 'drift', 'defensive-prophet']) {
    assert.ok(cfg.agents.find(a => a.id === id), `${id} survives`);
  }
  assert.ok(cfg.sandboxes.sbx_keep, 'non-harvest sandbox survives');
});

test('v9→v10 does NOT re-add harvest from defaults via mergeMissingDefaults', async () => {
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 9, accounts: [], agents: [], strategies: [], sandboxes: {}, models: [] }));
  const cfg = await cfgStore.loadConfig();
  assert.equal(cfg.agents.find(a => a.id === 'harvest'), undefined);
  assert.equal(cfg.strategies.find(s => s.id === 'harvest'), undefined);
});

test('v9→v10 is idempotent — reloading a v10 config is a no-op', async () => {
  await fs.writeFile(configPath, JSON.stringify(v9WithHarvest()));
  await cfgStore.loadConfig();
  cfgStore = await import('./config-store.js?cachebust=' + Math.random());
  cfgStore._setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot });
  credStore = cfgStore._setCredStoreForTests(credStore);
  const cfg2 = await cfgStore.loadConfig();
  assert.equal(cfg2.schemaVersion, 10);
  assert.equal(cfg2.agents.find(a => a.id === 'harvest'), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- agent/migration-v10.test.mjs` (or the repo's documented single-file invocation)
Expected: FAIL — config still reports `schemaVersion: 9` / harvest agent still present.

- [ ] **Step 3: Add the migration block**

In `agent/config-store.js`, immediately after the v8→v9 block (ends ~line 826, before `config.schemaVersion = 9;`), insert:

```javascript
  // v9 → v10: retire the Harvest iron-condor agent. Per the fleet → uncorrelated-
  // ballast pivot, short-vol index condors conflict with the thesis; Harvest's
  // options/vol-sleeve role is taken over (with the correct long-vol orientation)
  // by DefensiveProphet. Because mergeMissingDefaults only appends, the persisted
  // harvest agent + strategy + the Harvest sandbox survive removal-from-defaults
  // and must be scrubbed here. Idempotent: a no-op once they're already gone.
  // The Harvest sandbox's runtime data dir is intentionally left on disk as frozen
  // audit trail — only its config entry is removed. The shared IV/vol service
  // (renamed IVRankService) is unaffected; Prophet still uses it.
  if (rawSchemaVersion < 10) {
    config.agents = (config.agents || []).filter(a => a.id !== 'harvest');
    config.strategies = (config.strategies || []).filter(s => s.id !== 'harvest');
    for (const [sbxId, sbx] of Object.entries(config.sandboxes || {})) {
      if (sbx?.agent?.activeAgentId === 'harvest') {
        delete config.sandboxes[sbxId];
      }
    }
  }
```

Then change line 828 from `config.schemaVersion = 9;  // was 8` to:

```javascript
  config.schemaVersion = 10;  // was 9
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- agent/migration-v10.test.mjs`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/migration-v10.test.mjs agent/config-store.js
git commit -m "feat(retire-harvest): v9->v10 migration scrubs the harvest agent/strategy/sandbox"
```

### Task 2: Remove harvest from config-store defaults

**Files:**
- Modify: `agent/config-store.js` — `HEARTBEAT_PROFILES.harvest` (lines 113-117), the `harvest` entry in `defaultAgents()` (begins line 196, `id: 'harvest'`), the `harvest` entry in `defaultStrategies()` (begins ~line 393, `id: 'harvest'`)
- Modify: `agent/config-store.test.mjs` (remove harvest assertions)

- [ ] **Step 1: Update the test first**

In `agent/config-store.test.mjs`, find every assertion that the default roster/strategies include `harvest` (e.g. `defaultAgents()` length, a `find(a => a.id === 'harvest')`, or a `HEARTBEAT_PROFILES.harvest` check) and change them to assert harvest is **absent** and the 5 survivors are present. (Grep the file for `harvest` to enumerate.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- agent/config-store.test.mjs`
Expected: FAIL (defaults still contain harvest).

- [ ] **Step 3: Delete the three default blocks**

In `agent/config-store.js`:
1. Delete the `harvest:` entry in `HEARTBEAT_PROFILES` (lines 113-117).
2. Delete the entire `harvest` agent object in `defaultAgents()` (the `{ id: 'harvest', ... }` block — from `{` before `id: 'harvest'` through its closing `},`).
3. Delete the entire `harvest` strategy object in `defaultStrategies()` (`{ id: 'harvest', name: 'Harvest — Iron Condor Premium Seller', ... }`).

Do NOT touch the historical v5/v6/v7/v8 migration blocks that reference the string `'harvest'` — they are frozen migration history and are harmless (they iterate `config.agents`, which no longer contains harvest after v10).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- agent/config-store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/config-store.js agent/config-store.test.mjs
git commit -m "refactor(retire-harvest): drop harvest from config-store defaults"
```

### Task 3: Remove harvestPreflight

**Files:**
- Modify: `agent/preflight.js` — delete `harvestPreflight` (lines ~357-~480, the full `async function harvestPreflight(...)` and its leading comment block from line 357) and its `PREFLIGHT_REGISTRY` entry `'harvest': harvestPreflight,` (line 590)
- Modify: `agent/preflight.test.mjs` — remove harvest preflight tests

- [ ] **Step 1: Update tests**

In `agent/preflight.test.mjs`, remove the `harvestPreflight` describe/test cases (grep for `harvest`). Keep all other agents' tests untouched.

- [ ] **Step 2: Run to verify it fails / errors**

Run: `npm test -- agent/preflight.test.mjs`
Expected: FAIL or reference error once the registry entry is removed in step 3; at this point the test file should still reference harvest → fails.

- [ ] **Step 3: Delete the function + registry entry**

In `agent/preflight.js`: delete the `MIN_IV_HISTORY_DAYS`-preceded comment + `async function harvestPreflight` through its closing brace, and remove the `'harvest': harvestPreflight,` line from `PREFLIGHT_REGISTRY` (line 590). If `MIN_IV_HISTORY_DAYS` (line 355) is referenced only by harvestPreflight, delete it too; if referenced elsewhere, keep it (grep to confirm).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- agent/preflight.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/preflight.js agent/preflight.test.mjs
git commit -m "refactor(retire-harvest): remove harvestPreflight predicate"
```

### Task 4: Remove the monthly harvest_parameter_review job

**Files:**
- Modify: `agent/analysis-scheduler.js` — remove all `harvest_parameter_review` / `_lastHarvestParamReviewMonth` references (lines ~6, ~19, ~296, ~336, ~351, ~389-391, ~624-630, ~779, ~889, ~918, ~1040-1042)

- [ ] **Step 1: Remove the job wiring**

In `agent/analysis-scheduler.js`, remove:
- the `_lastHarvestParamReviewMonth` field init (line ~296) and both persisted-state read/write lines (~889, ~918, ~336)
- the `'harvest_parameter_review'` entry in the job-name list (~351)
- the `else if (jobName === 'harvest_parameter_review')` branch (~389-391)
- the startup-trigger block (~624-630)
- the `_getLockKey` case for `harvest_parameter_review` (~779)
- the scheduled-time trigger (~1040-1042)
- the header doc-comment lines mentioning it (~6, ~19)

- [ ] **Step 2: Build/lint check**

Run: `node --check agent/analysis-scheduler.js`
Expected: no syntax error. If there is an `analysis-scheduler` test, run it: `npm test -- agent/analysis-scheduler.test.mjs` (skip if absent).

- [ ] **Step 3: Commit**

```bash
git add agent/analysis-scheduler.js
git commit -m "refactor(retire-harvest): remove monthly harvest_parameter_review job"
```

### Task 5: Remove harvest from orchestrator, tool-allowlists, harness, dashboard

**Files:**
- Modify: `agent/orchestrator.js`, `agent/tool-allowlists.js` (+ `tool-allowlists.test.mjs`), `agent/harness.js`, `agent/public/index.html`

- [ ] **Step 1: Update the tool-allowlists test**

In `agent/tool-allowlists.test.mjs`, remove the harvest allowlist assertions (grep `harvest`).

- [ ] **Step 2: Remove the references**

- `agent/tool-allowlists.js`: remove the harvest tool-allowlist array/entry (the 4 `get_harvest_*` tools + the `'harvest'` strategy key).
- `agent/orchestrator.js`: remove the harvest gating/branch (grep `harvest`).
- `agent/harness.js`: remove any harvest-specific handling (grep `harvest`; if it is only an incidental comment, update it).
- `agent/public/index.html`: remove the hardcoded harvest reference (grep `harvest`/`Harvest`; the agent picker itself is config-driven, so this is likely a Trades-tab filter option or a label).

- [ ] **Step 3: Run the affected tests + syntax check**

Run: `npm test -- agent/tool-allowlists.test.mjs` and `node --check agent/orchestrator.js agent/harness.js`
Expected: PASS / no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add agent/orchestrator.js agent/tool-allowlists.js agent/tool-allowlists.test.mjs agent/harness.js agent/public/index.html
git commit -m "refactor(retire-harvest): scrub harvest from orchestrator/allowlists/harness/dashboard"
```

### Task 6: Remove the 6 Harvest MCP tools

**Files:**
- Modify: `mcp-server.js` — tool definitions (lines ~1317-1460), the "Harvest condor check" block (~1525), and the handler cases (~2990-3090)

- [ ] **Step 1: Remove tool definitions + handlers**

In `mcp-server.js`, delete:
- the 6 tool definition objects: `get_harvest_state` (~1317), `get_harvest_ivr` (~1322), `get_harvest_expirations` (~1334), `get_harvest_fomc` (~1345), `open_iron_condor` (~1432), `close_iron_condor` (~1458)
- the "Harvest condor check" block (~1525)
- the 6 handler `case` blocks (`get_harvest_state` ~2990, `get_harvest_ivr` ~2995, `get_harvest_expirations` ~3001, `get_harvest_fomc` ~3048, the `open`/`close` condor handlers ~3054/~3076)

Note: `get_harvest_ivr` is Harvest-only; Prophet's IV access is the separate generic `/api/v1/iv/:symbol` (untouched). Do not remove any `get_iv_rank` / intraday tools.

- [ ] **Step 2: Syntax check**

Run: `node --check mcp-server.js`
Expected: no syntax error.

- [ ] **Step 3: Run the JS suite (Phase 1 gate)**

Run: `npm test`
Expected: PASS (the full Node suite). Fix any remaining harvest reference a test trips on (e.g. `skills-sanity.test.mjs` expecting the harvest skill — that skill is deleted in Phase 3; if `skills-sanity` enumerates skills from disk it will pass now and after, but if it hardcodes `harvest-parameter-review` update it here).

- [ ] **Step 4: Commit**

```bash
git add mcp-server.js
git commit -m "refactor(retire-harvest): remove 6 harvest MCP tools + handlers"
```

---

## Phase 2 — Go layer

Gate for the phase: `go build ./...` + `go test ./...` green (pre-existing flaky `TestAggregator_Composite` is the only allowed exception). **Trust the compiler, not the LSP panel** (diagnostics lag in this harness).

### Task 7: Keep + rename the IV/vol stack (do this FIRST, land it green)

This is the riskiest seam — Prophet depends on it. Rename only; behavior unchanged; **table name `harvest_iv_snapshots` preserved** (no data migration).

**Files:**
- Rename: `models/harvest_models.go` → split: new `models/iv_models.go` (kept model), delete the condor model in Task 8
- Rename: `services/harvest_ivr_service.go` → `services/ivr_service.go`; `services/harvest_ivr_service_test.go` → `services/ivr_service_test.go`
- Modify: `database/storage.go` (IV snapshot methods), `controllers/iv_controller.go`, `cmd/bot/main.go` (IV wiring), `services/realized_vol_service.go` (only if it names the type)

- [ ] **Step 1: Create `models/iv_models.go` with the renamed model**

```go
package models

import (
	"time"

	"gorm.io/gorm"
)

// DBIVSnapshot stores one ATM-IV reading per underlying per trading day. The
// table name is retained as "harvest_iv_snapshots" for historical-data
// continuity (the collector predates the Harvest retirement); the data is
// consumed by IVRankService for Prophet's IV-rank gate.
type DBIVSnapshot struct {
	gorm.Model
	Underlying string    `gorm:"uniqueIndex:idx_harvest_iv_under_date"`
	Date       time.Time `gorm:"uniqueIndex:idx_harvest_iv_under_date"`
	ATMIV      float64   // at-the-money implied volatility (average of nearest put+call)
}

func (DBIVSnapshot) TableName() string { return "harvest_iv_snapshots" }
```

- [ ] **Step 2: Rename the service file + symbols**

`git mv services/harvest_ivr_service.go services/ivr_service.go`, then in `services/ivr_service.go`:
- `harvestIVStore` → `ivSnapshotStore`
- `HarvestIVRService` → `IVRankService` (all method receivers + the struct)
- `NewHarvestIVRService` → `NewIVRankService`
- every `models.DBHarvestIVSnapshot` → `models.DBIVSnapshot`
- the interface methods `SaveHarvestIVSnapshot` / `GetHarvestIVSnapshots` — **keep these method names** (they are storage-layer names; renaming them is extra churn for no behavior gain). Only their parameter/return TYPE changes to `*models.DBIVSnapshot`.
- update the doc-comment reference `startHarvestIVCollection` → `startIVCollection`.

- [ ] **Step 3: Rename the test file + symbols**

`git mv services/harvest_ivr_service_test.go services/ivr_service_test.go`, then replace `NewHarvestIVRService` → `NewIVRankService` and `DBHarvestIVSnapshot` → `DBIVSnapshot` throughout. Keep the assertions (they verify real IV-rank math Prophet relies on).

- [ ] **Step 4: Update storage + controller + main wiring**

- `database/storage.go`: change the `SaveHarvestIVSnapshot` / `GetHarvestIVSnapshots` method signatures' type `*models.DBHarvestIVSnapshot` → `*models.DBIVSnapshot`; update the automigrate registration `&models.DBHarvestIVSnapshot{}` → `&models.DBIVSnapshot{}` (keep it — the table is kept).
- `controllers/iv_controller.go`: `*services.HarvestIVRService` → `*services.IVRankService` (field at line ~20 and ctor param at ~27); update the doc-comment.
- `cmd/bot/main.go`: `harvestIVRSvc := services.NewHarvestIVRService(...)` → `ivRankSvc := services.NewIVRankService(...)` (line 286); update its uses at lines 295 (`SetIVProvider`), 325 (passed to `harvestController` — this arg is removed in Task 8, ignore for now or keep building), 356/535. Rename `startHarvestIVCollection` → `startIVCollection` (def line 830, call line 356); trim the universe list to drop `IWM`, `GLD`, `TLT` (keep `SPY`, `QQQ`, `NVDA`, `AMD`, `TSLA`, `MSTR`); update the warn-log strings `"harvest IV collection:"` → `"IV collection:"` and the function doc-comment.

> At this step `harvestController` (line 325) still consumes `ivRankSvc`; that's fine — the controller is deleted in Task 8. To keep this task independently green, leave the `harvestController` construction intact for now (it still compiles against the renamed service). The rename and the condor delete are adjacent; if your executor prefers a single green checkpoint, fold Task 8 in here.

- [ ] **Step 5: Build + test**

Run: `go build ./... && go test ./services/... ./controllers/... ./database/... ./models/...`
Expected: PASS. Grep to confirm no stale type: `rg "DBHarvestIVSnapshot|HarvestIVRService" --type go` returns nothing outside frozen worktrees.

- [ ] **Step 6: Commit**

```bash
git add models/iv_models.go services/ivr_service.go services/ivr_service_test.go database/storage.go controllers/iv_controller.go cmd/bot/main.go
git rm services/harvest_ivr_service.go services/harvest_ivr_service_test.go
git commit -m "refactor(retire-harvest): rename HarvestIVRService->IVRankService (Prophet dep, table kept)"
```

### Task 8: Delete the condor strategy (Go) — coordinated, green at the end

Deleting `DBHarvestCondor` breaks every condor consumer at once, so this task removes producers + consumers together and reaches green at the end. Intermediate sub-steps will not compile — that is expected.

**Files:**
- Delete: `services/harvest_service.go`(+test), `harvest_pricer.go`(+test), `harvest_exit_monitor.go`(+test), `harvest_closer.go`(+test), `services/trade_guard_harvest_test.go`, `controllers/harvest_controller.go`(+test), `database/storage_harvest_test.go`
- Modify: `models/harvest_models.go` (delete the file — the kept model already moved to `iv_models.go`), `database/storage.go`, `cmd/bot/main.go`, `services/segment_pnl_writer.go`, `services/prophet_options_stop_monitor.go`, `controllers/order_controller.go`

- [ ] **Step 1: Delete the condor service/controller files**

```bash
git rm services/harvest_service.go services/harvest_service_test.go \
       services/harvest_pricer.go services/harvest_pricer_test.go \
       services/harvest_exit_monitor.go services/harvest_exit_monitor_test.go \
       services/harvest_closer.go services/harvest_closer_test.go \
       services/trade_guard_harvest_test.go \
       controllers/harvest_controller.go controllers/harvest_controller_test.go \
       database/storage_harvest_test.go \
       models/harvest_models.go
```

- [ ] **Step 2: Remove condor storage methods**

In `database/storage.go`, delete the condor methods (and any condor save/update method just above): `GetHarvestCondorByID` (464-470), `ListOpenHarvestCondors` (472-476), `GetHarvestClosedPnL` (478-486), plus the condor save/update method preceding line 460 (grep `DBHarvestCondor` to find all). Remove the `&models.DBHarvestCondor{}` entry from the automigrate list. **Keep** the `DBIVSnapshot` automigrate.

- [ ] **Step 3: Remove main.go condor wiring**

In `cmd/bot/main.go`, delete (from the block read at 285-364):
- `harvestSvc := services.NewHarvestService(...)` + `harvestSvc.SetEnforceUniverse(...)` (287-290)
- `harvestCloser := ...` (316), `harvestController := controllers.NewHarvestController(...)` (323-331)
- the entire exit-monitor block (333-353, the `HARVEST_EXIT_MONITOR_ENABLED` gate)
- `tradeGuard.SetOptionsExposureProvider(harvestSvc)` + its comment (358-363)
- the `logger.Debug("Harvest service initialized")` (364)
- the `harvestController` argument to `setupRouter(...)` (line 559) and its parameter in the `setupRouter` signature (line 628) + the `/harvest` route group (741-752)
- the stale `storageService, // ListOpenHarvestCondors` comment at line 509 → change to `storageService, // (condor-legs source, now always empty)` — see Task 10 for the full stop-monitor cleanup; minimally the comment must not reference a deleted method.

**Keep:** `ivRankSvc`, `stockAnalysisService.SetIVProvider(ivRankSvc)`, `realizedVolSvc`, `ivController`, `startIVCollection`, and the generic `OptionsExposureProvider` seam in `trade_guard.go`.

- [ ] **Step 4: Remove the segment-pnl harvest arm**

In `services/segment_pnl_writer.go`, delete the block (lines 109-113):

```go
		if strat == "harvest" {
			if h, herr := w.storage.GetHarvestClosedPnL(dayStart, dayEnd); herr == nil {
				realized += h
			}
		}
```

Keep the `prophet-defensive` arm (114-118). Update the doc-comment at line 59 (`+ closed condors for harvest`) to drop the harvest clause. Update `segment_pnl_writer_test.go` if it asserts the harvest arm.

- [ ] **Step 5: Remove the stop-monitor condor-leg dependency**

In `services/prophet_options_stop_monitor.go`, remove the `ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error)` method from the interface (line ~28) and the call + condor-leg exclusion logic at line ~139 (the monitor manages only v2-options longs; with no condors the exclusion set is always empty). Update `prophet_options_stop_monitor_test.go` `fakeCondorLegs` accordingly (remove it). In `cmd/bot/main.go`, the `storageService, // ListOpenHarvestCondors` argument to `NewProphetOptionsStopMonitor` (line 509) is removed along with its interface param.

- [ ] **Step 6: Remove order_controller condor refs**

In `controllers/order_controller.go`, remove harvest/condor references (grep `harvest`/`Harvest`/`condor`). Update `controllers/order_controller_test.go` and `controllers/beat_context_controller_test.go` where they reference harvest condors.

- [ ] **Step 7: Build + test (reaches green)**

Run: `go build ./... && go test ./...`
Expected: PASS (except pre-existing flaky `TestAggregator_Composite`). Fix any remaining compile error by removing the offending harvest reference (it will be a leftover from the lists above).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(retire-harvest): delete the condor strategy (Go services/controller/storage/wiring)"
```

### Task 9: trade_guard.go — remove AgentHarvest

**Files:**
- Modify: `services/trade_guard.go` (+ `trade_guard_test.go`)

- [ ] **Step 1: Update the guard test**

In `services/trade_guard_test.go`, remove cases asserting `AgentHarvest` behavior and remove `AgentHarvest` from any `[]AgentSource{...}` fixtures (grep `harvest`/`Harvest`). Keep coverage for the surviving agents.

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./services/ -run TestGuard`
Expected: FAIL (test references removed; or still-present const). Proceed to remove.

- [ ] **Step 3: Remove the const + references**

In `services/trade_guard.go`:
- delete `AgentHarvest AgentSource = "harvest"` (line 19)
- delete the `case "harvest": return AgentHarvest` arm in `agentFromStrategy` (lines 47-48)
- delete the `AgentHarvest: {}` entry in the caps map (line 267)
- remove `AgentHarvest` from the `heldByAnyOtherAgent` overlap loop slice (line 544): `[]AgentSource{AgentMain, AgentTrend, AgentMeanRev, AgentDrift}`
- scrub the "e.g. Harvest" / "Harvest's short-put book" mentions in the `OptionsExposureProvider` doc-comments (222, 426). **Keep** the `OptionsExposureProvider` interface + `SetOptionsExposureProvider` method (generic, nil-safe, retained for future options agents).

- [ ] **Step 4: Build + test**

Run: `go build ./... && go test ./services/ -run TestGuard`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/trade_guard.go services/trade_guard_test.go
git commit -m "refactor(retire-harvest): remove AgentHarvest from trade guard (keep generic options-exposure seam)"
```

### Task 10: Incidental Go comment/config scrubs

**Files:**
- Modify: `config/config.go`, `services/segment_pnl_service.go`, `services/meanrev_signal_service.go`, `services/earnings_calendar_service.go`, `interfaces/trading_test.go`, `database/storage_attribution_test.go`, `database/storage_managed_position_test.go`

- [ ] **Step 1: Scrub references**

Grep each file for `harvest`/`Harvest` and remove/refresh the references:
- `config/config.go` line 56 — drop the "Harvest condor underlyings" clause from the comment (keep `EnableAgentUniverseGate`).
- `services/segment_pnl_service.go`, `meanrev_signal_service.go`, `earnings_calendar_service.go` — comment-only refs; update wording.
- `interfaces/trading_test.go`, `database/storage_attribution_test.go`, `database/storage_managed_position_test.go` — remove harvest fixtures/cases; keep the surviving-agent coverage.

- [ ] **Step 2: Build + full test (Phase 2 gate)**

Run: `go build ./... && go test ./...`
Expected: PASS (except `TestAggregator_Composite`). Then residual grep:
`rg -i "harvest" --type go --glob '!.claude/**'` should return only the intentional `harvest_iv_snapshots` table name and the DefensiveProphet `shouldHarvest`/`hedgeHarvestFrac` identifiers.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(retire-harvest): scrub residual harvest comments/test fixtures (Go)"
```

---

## Phase 3 — Skills, rules, config, capital

Gate for the phase: `npm test` + `go test ./...` green.

### Task 11: Delete the skill + rules file

- [ ] **Step 1: Delete**

```bash
git rm -r .claude/skills/harvest-parameter-review
git rm TRADING_RULES_HARVEST.md
```

- [ ] **Step 2: Check the skills-sanity test**

Run: `npm test -- scripts/skills-sanity.test.mjs`
Expected: PASS. If it hardcodes `harvest-parameter-review` in an expected-skills list, remove that entry and re-run.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore(retire-harvest): delete harvest-parameter-review skill + TRADING_RULES_HARVEST.md"
```

### Task 12: Capital reconciliation + rules cross-reference scrub

**Files:**
- Modify: `TRADING_RULES_TREND.md` (Turtle lane 20%→30%), and every rules file carrying the lane segment table or a harvest mention: `TRADING_RULES_V2.md`, `TRADING_RULES_MEANREV.md`, `TRADING_RULES_DRIFT.md`, `TRADING_RULES_DEFENSIVE_PROPHET.md`

- [ ] **Step 1: Apply the capital edit**

In every rules file that contains the multi-lane allocation table, drop the Harvest row and set Turtle to **30%** so the lanes read **Prophet 34 / Coil 24 / Turtle 30 / Drift 12** and sum to 100. (Grep each file for `Harvest`, `10%`, `Turtle`, `condor` to locate the table.) Per the Spark precedent the carriers were `V2`, `TREND`, `MEANREV`, `DRIFT`; verify the exact current set rather than assume.

- [ ] **Step 2: Scrub remaining harvest mentions**

In any rules file that merely *mentions* Harvest (e.g. `TRADING_RULES_DEFENSIVE_PROPHET.md` may reference "Harvest's lifecycle as a template" or list Harvest among sibling agents), remove or rephrase those mentions so no live rules doc points at the retired agent. Do not touch DefensiveProphet's own `shouldHarvest`/profit-harvest wording if present (that is its mechanism, not a reference to the agent).

- [ ] **Step 3: Verify sums + commit**

Manually confirm each edited table sums to 100. Then:

```bash
git add TRADING_RULES_*.md
git commit -m "docs(retire-harvest): reallocate Harvest's 10% lane to Turtle (20->30); scrub rules cross-refs"
```

### Task 13: Friction profiles + env

**Files:**
- Modify: `config/friction.json` (`iron_condor` at line 17), `config/friction-stress.json` (`iron_condor` at line 18), `.env.example` (`HARVEST_EXIT_MONITOR_ENABLED`); check `scripts/apply-friction.mjs` (+ test)

- [ ] **Step 1: Remove the profiles**

Delete the `"iron_condor": { ... }` object from both `config/friction.json` and `config/friction-stress.json`. If `scripts/apply-friction.mjs` or `apply-friction.test.mjs` enumerates `iron_condor`, remove that reference.

- [ ] **Step 2: Remove the env var**

In `.env.example`, delete the `HARVEST_EXIT_MONITOR_ENABLED` line. (The live root `.env` keeps a now-dead copy — harmless; left for the owner to clean.)

- [ ] **Step 3: Run friction test + commit**

Run: `npm test -- scripts/apply-friction.test.mjs` (skip if absent)
Expected: PASS.

```bash
git add config/friction.json config/friction-stress.json .env.example scripts/apply-friction.mjs scripts/apply-friction.test.mjs
git commit -m "chore(retire-harvest): remove iron_condor friction profiles + HARVEST_EXIT_MONITOR_ENABLED"
```

---

## Phase 4 — Whole-branch verification & landing

### Task 14: Full verification

- [ ] **Step 1: Full suites**

Run: `go build ./... && go test ./...` (allow only `TestAggregator_Composite`) and `npm test`
Expected: both green.

- [ ] **Step 2: Migration dry-run against a copy of live config**

```bash
node -e "const fs=require('fs'); fs.copyFileSync('data/agent-config.json','/tmp/cfg-copy.json');"
```
Then load the copy through the test harness (or a throwaway `_setPathsForTests` script) and assert: `schemaVersion === 10`, no `harvest` agent/strategy, no `sbx_449fedf6`, and the 5 survivors (`default`, `mean-rev`, `trend-prophet`, `drift`, `defensive-prophet`) + their sandboxes intact. **Do not mutate the real `data/agent-config.json`.**

- [ ] **Step 3: IV-path smoke (Prophet's dependency)**

Confirm the renamed service still serves Prophet: grep that `cmd/bot/main.go` wires `ivRankSvc` into `stockAnalysisService.SetIVProvider` and `NewIVController`, and that the `harvest_iv_snapshots` table is still in the automigrate list (`rg "harvest_iv_snapshots|DBIVSnapshot" --type go`). If a running bot is available, hit `/api/v1/iv/SPY` and confirm a non-error response.

- [ ] **Step 4: Residual sweep**

Run: `rg -i "harvest" --glob '!.claude/worktrees/**' --glob '!docs/superpowers/**' --glob '!data/sandboxes/**' --glob '!activity_logs/**' --glob '!Claudes Notes/**'`
Expected: only intentional survivors — the `harvest_iv_snapshots` table name, the `DBIVSnapshot` comment, and DefensiveProphet's `shouldHarvest`/`hedgeHarvestFrac`. Anything else is a missed reference → fix + re-gate.

- [ ] **Step 5: Commit any verification fixes**

```bash
git add -A
git commit -m "test(retire-harvest): whole-branch verification fixes"
```

### Task 15: Land on local main

- [ ] **Step 1: Squash + rebase**

Squash the `retire-harvest` commits into one, rebase onto current local `main`, and fast-forward `main` (so the owner's rebuild-from-local-main picks it up, per `claude-commits-must-reach-local-main`). No GitHub push unless the owner asks.

- [ ] **Step 2: Final gate on main**

Run: `go build ./... && go test ./...` and `npm test` on `main`
Expected: green.

- [ ] **Step 3: Activation note for the owner**

Rebuild the Go bot + restart the Node orchestrator → the v10 migration runs, Harvest vanishes from the picker. Post-activation: confirm Prophet still gets IV-rank data (renamed `IVRankService`) and the 5 survivors are intact.

---

## Self-Review (completed during planning)

**Spec coverage:** every §2a delete, §2b keep+rename, §2c edit, §4 migration, §5 capital, §6 phasing, and §7 landing maps to a task above (Task 1=§4 migration; 2-6=§2c JS + §2a JS deletes; 7=§2b keep+rename; 8-10=§2a/§2c Go; 11-13=§2a/§2c skills/rules/config + §5 capital; 14-15=§6/§7).

**Placeholder scan:** deletions name exact symbols/line ranges + a build/test gate; the migration, the rename signatures, and the shared-code edits show full code. No "add error handling" / "TBD".

**Type consistency:** `DBHarvestIVSnapshot`→`DBIVSnapshot` (table `harvest_iv_snapshots` kept), `HarvestIVRService`→`IVRankService`, `NewHarvestIVRService`→`NewIVRankService`, `harvestIVStore`→`ivSnapshotStore`, `startHarvestIVCollection`→`startIVCollection`, `harvestIVRSvc`→`ivRankSvc` — used consistently across Tasks 7-8 and Phase 4. Storage method names `SaveHarvestIVSnapshot`/`GetHarvestIVSnapshots` intentionally retained (documented in Task 7 Step 2).
