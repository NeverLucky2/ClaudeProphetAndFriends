# Harvest Retirement — Design

**Date:** 2026-06-02
**Status:** Approved (brainstorming), pending spec review → implementation plan
**Branch:** `retire-harvest` (worktree off local `main` @ `6640784`)

## 1. Context & Goal

"Harvest" is the mechanical iron-condor / theta-harvesting agent — config id `harvest`, display
name `Harvest`, strategy `harvest`. It sells 16-delta iron condors on index ETFs (SPY/QQQ/IWM/GLD/
TLT) for premium income.

Per the **fleet → uncorrelated-ballast pivot** (2026-05-31), the fleet's job was redefined as
uncorrelated ballast to the owner's concentrated mega-cap-tech book. Harvest is **short volatility /
short gamma** — economically *long risk-appetite*, the same direction as that book. It pays off in
calm/range-bound markets and gets run over in a drawdown, which is the opposite of ballast. Its
former role (the fleet's options/vol sleeve) is now filled — with the thesis-correct orientation —
by **DefensiveProphet** (a long-vol QQQ put-debit-spread hedge). Harvest is therefore not redundant
*with* DefensiveProphet; it is thesis-*conflicting*, which is the reason to retire it.

**Goal:** fully remove the Harvest iron-condor agent from the live codebase, free its capital lane,
and de-register its sandbox — while leaving the other five agents (Prophet, Coil, Turtle, Drift,
DefensiveProphet) and the shared paper account completely untouched, **and preserving the IV/vol
infrastructure that lives under the "Harvest" name but is depended on by Prophet.**

**Decision:** Full code removal, mirroring the Spark/PennyProphet retirement (`bc8df39`).
Reversibility is explicitly **not** required — short-vol income was rejected twice by the pivot, so
Harvest is not coming back. The only real cost of full removal is deletion risk in shared
options/IV/capital-protection code; that is managed via TDD + a green-build/green-test gate and a
final residual-reference sweep.

### Verified live state (2026-06-02)

- Harvest sandbox = `sbx_449fedf6` (`agent.activeAgentId: 'harvest'`, name "Harvest"), runtime dir
  `data/sandboxes/sbx_449fedf6/`, sharing the single paper account `6e4f26af` with all agents.
- **No open exposure — and none ever:** the `harvest_condors` table is **empty in every sandbox DB**
  (open *and* closed counts are zero). Harvest never opened a single condor. Zero orphan risk;
  nothing to flatten; no realized condor P&L history to preserve.
- Config `schemaVersion` is **9** (Spark's v8→v9 migration already landed). `mergeMissingDefaults`
  only *appends* missing IDs and never removes, so deleting code defaults alone does **not** scrub
  the persisted `harvest` agent/strategy or the Harvest sandbox — a removal migration is required.

## 2. Surface Area — delete vs keep+rename vs edit vs leave-frozen

The single most important boundary. The "Harvest" name covers **two different things**: the condor
*strategy* (delete) and a shared *IV/vol service stack* that Prophet's options-entry gate depends on
(keep + rename). This is the exact `penny_earnings_service` trap from the Spark removal, in reverse —
here the shared code is *named* after the agent being removed.

### 2a. Delete entirely (condor-strategy-exclusive)

Go services + their `_test.go` siblings:
- `services/harvest_service.go` (condor open / sizing / state / circuit breaker)
- `services/harvest_pricer.go` (condor mark-to-market; only constructed inside the exit-monitor block)
- `services/harvest_exit_monitor.go` (condor exit-management goroutine)
- `services/harvest_closer.go` (condor close-orchestration)
- `services/trade_guard_harvest_test.go` (Harvest-specific guard coverage)

Controller:
- `controllers/harvest_controller.go` (+ `controllers/harvest_controller_test.go`)

Models:
- `DBHarvestCondor` (and its `TableName() "harvest_condors"`) — see §2b for the file split.

Skills (1):
- `.claude/skills/harvest-parameter-review/`

Rules:
- `TRADING_RULES_HARVEST.md`

### 2b. Keep + rename (shared IV/vol infra — Prophet depends on it)

> **TRAP — do NOT delete the IV/vol stack.** Despite the `Harvest`/`harvest_*` naming, this code is
> **shared**: Prophet's options-entry gate consumes it via `stockAnalysisService.SetIVProvider(...)`
> (the `analyze_stocks` IV-rank fields) and the generic `/api/v1/iv/:symbol` route (`IVController`),
> and the daily collector records IV for Prophet's equity underlyings (NVDA/AMD/TSLA/MSTR), not just
> Harvest's ETFs. Deleting it would break Prophet.

- `services/harvest_ivr_service.go` → `git mv` to `services/ivr_service.go`; rename
  `HarvestIVRService` → `IVRankService` (and `NewHarvestIVRService` → `NewIVRankService`, the
  `harvestIVStore` interface → `ivSnapshotStore`).
- `models/harvest_models.go` → **split**: delete `DBHarvestCondor`; keep `DBHarvestIVSnapshot`,
  rename it → `DBIVSnapshot`, and **preserve `TableName() "harvest_iv_snapshots"`** (no table rename
  → no data migration → Prophet's collected IV history survives intact). Relocate the kept model to
  `models/iv_models.go`.
- `services/realized_vol_service.go` — already generically named; keep as-is (consumed by
  `IVController`).
- `controllers/iv_controller.go` — keep; update the `*services.HarvestIVRService` type reference to
  `*services.IVRankService`.
- `cmd/bot/main.go` — keep the IV wiring; rename `startHarvestIVCollection` → `startIVCollection`.
  Trim the Harvest-only ETFs (IWM/GLD/TLT) from the daily collection list; **keep SPY/QQQ + the
  Prophet equity names** (SPY/QQQ are also used by regime/DefensiveProphet).

The `harvest_ivr_service_test.go` and any IV-snapshot storage tests are kept and updated to the new
type names (they assert real behavior Prophet relies on).

### 2c. Surgically edit (shared code that merely references Harvest)

**Go:**
- `cmd/bot/main.go` — remove the Harvest **strategy** wiring: `harvestSvc`/`harvestCloser`/
  `harvestController` construction, the `/harvest/*` route group and the `harvestController` router
  param/field, the exit-monitor block (`HARVEST_EXIT_MONITOR_ENABLED`, `NewHarvestPricer`,
  `NewHarvestExitMonitor`), and the `tradeGuard.SetOptionsExposureProvider(harvestSvc)` registration.
  **Keep** the IV wiring (§2b) and the generic `OptionsExposureProvider` seam (the provider simply
  returns to its prior nil default — the INDEX_BETA bucket behaves exactly as it did before Harvest
  was registered; the interface's doc-comment says "Pass nil to clear").
- `services/trade_guard.go` — remove the `AgentHarvest` const, the `"harvest"` case in
  `agentFromStrategy`, the `AgentHarvest: {}` entry in the per-agent caps map, and `AgentHarvest`
  from the `heldByAnyOtherAgent` overlap loop (`[]AgentSource{AgentMain, AgentHarvest, AgentTrend,
  AgentMeanRev, AgentDrift}`) — **without breaking those structures for the remaining agents.** Keep
  the `OptionsExposureProvider` interface + `SetOptionsExposureProvider` mechanism (generic,
  nil-safe; left for future options-agent use); scrub the "e.g. Harvest" mentions in its comments.
- `services/prophet_options_stop_monitor.go` — remove the `ListOpenHarvestCondors` condor-leg
  exclusion dependency (the monitor only manages v2-options longs; with condors gone the exclusion
  list is permanently empty). Update `prophet_options_stop_monitor_test.go` (`fakeCondorLegs`).
- `services/segment_pnl_writer.go` — remove the `if strat == "harvest" { ... GetHarvestClosedPnL }`
  arm. **Keep** the `prophet-defensive` arm. Update `segment_pnl_writer_test.go`.
- `database/storage.go` — remove `ListOpenHarvestCondors`, `GetHarvestClosedPnL`, and the
  `DBHarvestCondor` automigrate entry. **Keep** the `DBIVSnapshot` (`harvest_iv_snapshots`)
  automigrate. Delete `database/storage_harvest_test.go`; update `storage_attribution_test.go` and
  `storage_managed_position_test.go` where they reference Harvest.
- `controllers/order_controller.go` — remove the Harvest/condor references (e.g. the
  `ListOpenHarvestCondors` wiring path); update `order_controller_test.go` and
  `beat_context_controller_test.go`.
- `config/config.go` — remove the Harvest condor-underlyings comment (cosmetic). **Keep**
  `EnableAgentUniverseGate` (shared with Coil/Drift).
- Incidental comment references in `services/segment_pnl_service.go`,
  `services/meanrev_signal_service.go`, `services/earnings_calendar_service.go`, and
  `interfaces/trading_test.go` — excise the "harvest" mentions; update comments to match.

> **False-positive guard:** the local identifiers `shouldHarvest` / `hedgeHarvestFrac` /
> `CloseReason "harvest"` inside `services/prophet_hedge_*.go` are DefensiveProphet's own "harvest
> the profit spike" concept — **not** references to the Harvest agent. They must be preserved. (The
> hedge package has zero dependency on any `harvest_*` symbol; verified.)

**JS / Node:**
- `agent/config-store.js` — remove the `harvest` agent from `defaultAgents()`, the `harvest`
  strategy from `defaultStrategies()`, and the `harvest` heartbeat-cadence profile; add the v9→v10
  migration (§4); bump `schemaVersion` to 10. (Leave the historical v5–v8 migration blocks that
  mention `'harvest'` untouched — they are frozen migration history.)
- `agent/preflight.js` — remove `harvestPreflight` and its `'harvest'` `PREFLIGHT_REGISTRY` entry.
- `agent/analysis-scheduler.js` — remove the monthly `harvest_parameter_review` job: the
  `_lastHarvestParamReviewMonth` state field, the persisted-state read/write, the `_getLockKey`
  case, the auto-job entry, the startup trigger, and the scheduled-time trigger.
- `agent/orchestrator.js` — remove the Harvest gating entry.
- `agent/tool-allowlists.js` — remove the Harvest tool-allowlist entry/array.
- `agent/harness.js` — remove any Harvest-specific handling.
- `mcp-server.js` — remove the 6 Harvest tool definitions (`get_harvest_state`, `get_harvest_ivr`,
  `get_harvest_expirations`, `get_harvest_fomc`, `open_iron_condor`, `close_iron_condor`), their
  handler cases, and the "Harvest condor check" block. (`get_harvest_ivr` is Harvest-only; Prophet
  uses the generic `/api/v1/iv/:symbol` route, which is unaffected.)
- `agent/public/index.html` — remove the hardcoded Harvest reference (verify Trades-tab agent filter
  vs. label; the picker itself is config-driven and updates automatically).
- Update existing Harvest-touching JS tests: `config-store.test.mjs`, `preflight.test.mjs`,
  `tool-allowlists.test.mjs`, `orchestrator-emergency.test.mjs`, `intraday-prompt.test.mjs`,
  `scripts/skills-sanity.test.mjs`, `scripts/apply-friction.test.mjs`; add `migration-v10.test.mjs`.

**Config / env:**
- `config/friction.json` + `config/friction-stress.json` — remove the `iron_condor` profile.
  Update `scripts/apply-friction.mjs` / `apply-friction.test.mjs` if they enumerate it.
- `.env.example` — remove `HARVEST_EXIT_MONITOR_ENABLED`. (The live root `.env` keeps a now-dead
  `HARVEST_EXIT_MONITOR_ENABLED` — harmless, nothing reads it; cosmetic to clean.)

### 2d. Out of scope — left frozen as historical / audit

Per the `agent-name-id-split` memory, these are frozen records and are **not** touched:
- `docs/superpowers/specs/**` and `docs/superpowers/plans/**` historical Harvest design records
  (`2026-05-01-harvest-*`, `2026-05-16-harvest-exit-monitor`, `2026-05-21-harvest-preflight-*`,
  `2026-05-28-prophet-harvest-scheduled-wakes`).
- `activity_logs/**`, `data/sandboxes/**` (audit trail — including Harvest's runtime dir
  `sbx_449fedf6/`).
- `Claudes Notes/**`, `potential additions/**` (notes / staging area, not live code).
- `.claude/worktrees/**` (other in-flight worktrees mirror the old tree; ignored).

### 2e. Risk flags designed around

1. **The IV/vol stack is shared, not Harvest's.** Renaming preserves behavior; the table name is
   deliberately unchanged so no data migration touches the OneDrive-synced SQLite. The keep-list
   (§2b) is the hard boundary — anything that `IVController` / `stockAnalysisService` / the
   collector touch is kept.
2. **`AgentSource` is shared attribution.** The field carries `"main"`/`"trend"`/`"drift"`/etc. for
   all agents — only the `AgentHarvest` *value* is removed, never the field.
3. **`OptionsExposureProvider` is generic.** Only the Harvest *registration* is removed; the
   interface + setter remain (nil-safe), so a future options agent can feed the sector cap without
   re-plumbing.
4. **No destructive SQLite migration.** Removing Go-level usage of `DBHarvestCondor` does **not**
   drop the (empty) `harvest_condors` table. Dormant/empty tables are harmless; dropping tables on a
   synced SQLite file buys nothing.

## 3. Mechanism — coordinated two-half removal

`mergeMissingDefaults` runs *before* `migrateLegacyConfig` and only appends. So:
- **Half 1 (code defaults):** once `harvest` is removed from `defaultAgents()`/`defaultStrategies()`,
  it can never be re-appended.
- **Half 2 (migration):** the v9→v10 migration scrubs the already-persisted records from the live
  config. Both halves ship together via local `main`.

## 4. Config migration (v9 → v10)

Second *removal* migration in `migrateLegacyConfig` (after Spark's v8→v9), following the same
pattern. Idempotent and guarded (no-op when the records are already absent):

- Delete the persisted `harvest` **agent** record from `config.agents`.
- Delete the persisted `harvest` **strategy** record from `config.strategies`.
- Delete any **sandbox** whose `agent.activeAgentId === 'harvest'` from `config.sandboxes` (the
  `sbx_449fedf6` Harvest sandbox), so it disappears from the picker.
- Bump `config.schemaVersion` to 10.

**Live-state handling:** the migration only **de-registers** the sandbox config entry. Harvest's
runtime dir `data/sandboxes/sbx_449fedf6/` is **left on disk as frozen audit trail** — gitignored,
zero cost, consistent with how Spark's dir and other historical sandbox data are treated.

**Test:** new `agent/migration-v10.test.mjs` feeds a copy of the real config shape (6 agents incl.
harvest, the Harvest sandbox) through `loadConfig` (via a temp file — `normalizeConfig` is not
exported; pattern per `migration-v5.test.mjs`) and asserts: harvest agent + strategy + sandbox are
gone, `schemaVersion === 10`, and the other five agents/strategies/sandboxes are byte-identical.
Idempotency: a second pass is a no-op.

It runs automatically when the Node orchestrator restarts after a rebuild from local `main`.

## 5. Capital reconciliation

Harvest's freed 10% lane goes entirely to **Turtle** — the explicit uncorrelated-ballast pillar, the
exact role that motivated retiring short-vol Harvest:

| Sleeve | Old lane | New lane |
|---|---|---|
| Prophet (V2) | 34% | 34% |
| Coil (mean-rev) | 24% | 24% |
| Turtle (trend) | 20% | **30%** |
| Drift (PEAD) | 12% | 12% |
| ~~Harvest (condor)~~ | ~~10%~~ | removed |
| **Total** | 100% | **100%** |

Implementation is entirely **prose** — no Harvest lane was ever code-enforced (Spark's was the only
code-enforced cap, and it's already gone):

- `TRADING_RULES_TREND.md` — Turtle lane 20% → 30%.
- Every agent rules file that carries the lane segment table — drop the Harvest row and update Turtle
  so all copies agree and still sum to 100%. Per the Spark precedent the carriers were
  `TRADING_RULES_V2.md`, `TREND`, `MEANREV`, `DRIFT` (+ the now-deleted `HARVEST`); the plan must
  verify the exact current set rather than assume it.

This is distinct from the §2c/§3 cross-reference scrub: `TRADING_RULES_DEFENSIVE_PROPHET.md` (and any
other file) that merely *mentions* Harvest gets those mentions cleaned even if it carries no lane
table.

Not touched: `MAX_DEPLOYED_PCT` stays as-is (the 10% shifts between lanes, not into cash). Turtle
per-position sizing changes only if its rules explicitly derive it from the lane; otherwise only the
lane ceiling moves.

## 6. Verification & phasing

Because this touches options/IV and capital-protection code, the gate is: full Go build + test
green, Node suite green, and the other five agents (especially Prophet's IV path) provably
untouched. Each phase ends green before the next.

1. **JS/config layer** — config-store defaults + v9→v10 migration (+ `migration-v10.test.mjs`),
   preflight, analysis-scheduler, orchestrator, tool-allowlists, harness, mcp-server,
   public/index.html. Update the existing harvest-touching JS tests. Gate: `npm test` (the suite
   runner, not `node --test agent/` directly).
2. **Go layer** — keep+rename the IV/vol stack (§2b) first and prove it green (Prophet's IV path is
   the riskiest seam); then delete the condor services/controller + tests; then the surgical edits
   to `main.go`, `trade_guard.go`, `prophet_options_stop_monitor.go`, `segment_pnl_writer.go`,
   `storage.go`, `order_controller.go`, `config.go` + comment refs. Update `trade_guard_test.go` and
   storage/attribution/beat-context tests. Gate: `go build ./...` + `go test ./...` green
   (pre-existing flaky `TestAggregator_Composite` is the only allowed exception). Trust the
   compiler, not the LSP panel (diagnostics lag).
3. **Skills + rules + config** — delete the `harvest-parameter-review` skill + `TRADING_RULES_HARVEST.md`;
   scrub harvest cross-refs from the other rules files; apply the Turtle 20→30 capital prose edit;
   remove the `iron_condor` friction profiles; remove `HARVEST_EXIT_MONITOR_ENABLED` from
   `.env.example`.
4. **Whole-branch verification** — full `go test ./...` + `npm test`; run the v10 migration against a
   **copy** of the live `agent-config.json` and assert harvest gone + five others intact +
   `schemaVersion === 10`; confirm the `harvest_iv_snapshots` table still reads and `/api/v1/iv/:symbol`
   + `analyze_stocks` IV fields still resolve post-rename; grep the live tree for residual
   `harvest`/`Harvest`/`AgentHarvest`/`condor` outside the frozen-historical dirs (§2d) and the
   intentional DefensiveProphet `shouldHarvest`/`hedgeHarvestFrac` identifiers (§2c) to confirm
   nothing live was missed.

**Execution model:** subagent-driven TDD on Haiku (per `subagent-model-preference`), phase by phase,
with the diff for each phase reviewed before it lands.

## 7. Landing & activation

- Work in a worktree (`retire-harvest`, off local `main` @ `6640784`).
- Squash to one commit; rebase onto current local `main`; fast-forward `main` so the owner's
  rebuild-from-local-main picks it up (per `claude-commits-must-reach-local-main`). No GitHub push
  unless requested.
- **Activation on the owner's side:** rebuild the Go bot + restart the Node orchestrator (runs the
  v10 migration → Harvest vanishes from the picker). No feature flag — removal is unconditional.
- **Post-activation check:** confirm Prophet still gets IV-rank data (the renamed `IVRankService`),
  and that the 5 survivors (default / mean-rev / trend-prophet / drift / defensive-prophet) are
  intact in the picker.

## 8. Out of scope / deferred

- Harvest's runtime data dir is kept (not deleted).
- The empty `harvest_condors` table is not dropped; `harvest_iv_snapshots` is kept (renamed model,
  same table) because Prophet uses it.
- Historical docs/specs/plans, audit logs, notes, and the `potential additions/` staging area are
  left frozen.
- The dead `HARVEST_EXIT_MONITOR_ENABLED` var in the live root `.env` is left for the owner to clean
  (cosmetic).

## 9. Follow-ups (post-merge)

- Update memory `capital-allocation-reconciled` (Harvest lane removed; Turtle 20 → 30; four lanes).
- Update memory `fleet-uncorrelated-ballast-pivot` (Harvest "pause day-one" superseded by full
  retirement, executed).
- Add a memory for the Harvest retirement (mirroring `spark-penny-retirement`), capturing the
  shared-IV-infra keep+rename gotcha and the empty-condor-table finding.
