# Spark / PennyProphet Retirement — Design

**Date:** 2026-06-01
**Status:** Approved (brainstorming), pending spec review → implementation plan
**Branch:** `retire-spark-penny` (worktree off local `main` @ `834d335`)

## 1. Context & Goal

"Spark" is the penny-stock-momentum agent — config id `penny-prophet`, display name `Spark`,
strategy `penny-momentum`. It was a fun experiment but is far too volatile for paper, let alone
real cash. The owner is **permanently retiring penny trading** — Spark and any penny agent will
never run again. There is no further testing planned.

**Goal:** fully remove the penny pipeline from the live codebase, free its capital lane, and
de-register its sandbox — while leaving the other six agents (Prophet, Coil, Turtle, Drift,
Harvest, DefensiveProphet) and the shared paper account completely untouched.

**Decision:** Full code removal (option B). Reversibility is explicitly **not** required — penny
is not coming back, so leaving dead Go code dormant on disk has no upside. The only real cost of
full removal is deletion risk in shared capital-protection code; that is managed via TDD + a
green-build/green-test gate and a final residual-reference sweep.

### Verified live state (2026-06-01)

- Spark sandbox = `sbx_1b6dc838` (`agent.activeAgentId: penny-prophet`), runtime dir
  `data/sandboxes/sbx_1b6dc838/`, sharing the single paper account `6e4f26af` with all agents.
- **No open exposure:** Spark's `managed_positions` table holds 4 rows, all `CLOSED` — zero
  open/pending/active. Nothing to flatten before removal.
- Config `schemaVersion` is **8**. `mergeMissingDefaults` (config-store.js) only *appends* missing
  IDs and never removes, so deleting code defaults alone does **not** scrub the persisted
  `penny-prophet`/`penny-momentum` records or the Spark sandbox — a removal migration is required.

## 2. Surface Area — delete vs edit vs leave-frozen

The single most important boundary. Penny is woven through shared code, so this is a **surgical**
removal, not a clean file delete.

### 2a. Delete entirely (penny-exclusive)

Go services + their `_test.go` siblings:
- `services/penny_types.go` (penny-only types: `DecayEntry`/`UniverseSymbol`/`CandidateScore`)
- `services/penny_universe_service.go`
- `services/penny_intraday.go`
- `services/penny_screener_service.go`
- `services/penny_signal_aggregator.go`
- `services/penny_max_filter.go`
- `services/social_signal_service.go` — confirmed penny-exclusive (only the penny pipeline
  constructs `NewSocialSignalService`; depends on `pennyUniverseService`)
- `services/sec_edgar_service.go` — confirmed penny-exclusive (only the penny pipeline constructs
  `NewSECEdgarService`; consumes `positionManager.HeldPennyTickers`)

> **TRAP — do NOT delete `services/penny_earnings_service.go`.** Despite its name it defines the
> **shared** `EarningsCalendarService` (`NewEarningsCalendarService`), which Coil
> (`meanRevEarningsChecker`), Drift (`driftRecentReporter`), and `cmd/driftreplay` all depend on.
> Its file content contains zero "penny" references (only the filename), so it is kept and
> `git mv`-renamed to `earnings_calendar_service.go` (zero-build-risk — Go compiles by package, not
> filename) so no `penny_*` filename survives.

Controller:
- `controllers/penny_controller.go` (+ `controllers/penny_controller_test.go`)

Skills (4):
- `.claude/skills/adapt-strategy-penny/`
- `.claude/skills/agent-health-penny/`
- `.claude/skills/postmortem-penny/`
- `.claude/skills/review-performance-penny/`

Rules:
- `TRADING_RULES_PENNY.md`

### 2b. Surgically edit (shared code that merely references penny)

**Go:**
- `cmd/bot/main.go` — remove the penny wiring (the `pennyPipelineEnabled` var, penny service +
  controller construction ~298–308, `SetHeldTickersFn` ~310–311, the penny goroutine block
  ~313–323), the 6 penny routes (`/penny/candidates|signal|universe|scan|blacklist*`), and the
  `pennyController` router param/field. **KEEP the `earningsService` construction (line 290) and
  its Coil/Drift wiring (~419–420, 443–444)** — `EarningsCalendarService` is shared. The
  `earningsService.Start()`/`WaitForFirstRefresh` block (~291–296) was gated solely on
  `pennyPipelineEnabled`, so it goes with the gate; Coil/Drift already run without that background
  refresh in their penny-disabled bots today, so behavior is unchanged.
- `services/trade_guard.go` — remove `AgentPenny` const, the `"penny-momentum"` case in
  `agentFromStrategy`, `PennyMaxCapitalPct`/`PennyMaxPositionDollars` config fields, the cap
  checks (`checkPennyCapCap`, `currentPennyExposure`), the guard-summary fields
  (`PennySymbols`/`PennyExposure`/`PennyCapitalMax`), and the penny entries in the shared
  agent-iteration loops (e.g. `[]AgentSource{AgentMain, AgentPenny, ...}` and the `symbolsFor`
  map) — **without breaking those loops for the remaining agents.**
- `services/position_manager.go` — remove the **penny-only social-time-exit** logic only:
  `shouldFireSocialTimeExit`, `executeSocialTimeExit`, its call in `checkPositions`, the
  `DominantSignal` field, and `HeldPennyTickers()`.
- `config/config.go` — remove the `PennyMaxCapitalPct`/`PennyMaxPositionDollars` struct fields and
  their `PENNY_MAX_CAPITAL_PCT`/`PENNY_MAX_POSITION_DOLLARS` env parsing.
- `models/models.go`, `database/storage.go`, `services/segment_pnl_service.go`, plus incidental
  comment references in other services (`turtle_executor.go`, `meanrev_signal_service.go`,
  `economic_feeds.go`, `alpaca_*.go`, `shared_bar_cache.go`) — excise penny references; update
  comments to match.

**JS / Node:**
- `agent/config-store.js` — remove `penny-prophet` from `defaultAgents()`, `penny-momentum` from
  `defaultStrategies()`, the `penny_stock` heartbeat profile; add the v8→v9 migration (§4); bump
  `schemaVersion` to 9.
- `agent/orchestrator.js` — remove `pennyPipelineEnabled` + the `ENABLE_PENNY_PIPELINE` env gate.
- `agent/preflight.js` — remove `pennyPreflight`, `isPennyOwnedOrder`, the `'penny-momentum'`
  `PREFLIGHT_REGISTRY` entry, and penny helper predicates.
- `agent/tool-allowlists.js` — remove the `PENNY_SIGNALS` array (4 tools), its inclusion in the
  base/shared allowlists, and the `'penny-momentum'` allowlist entry.
- `agent/candidate-warmer-flags.js` — remove the penny entry.
- `mcp-server.js` — remove the 4 penny tool definitions (`get_penny_candidates`,
  `get_penny_signal_detail`, `get_penny_universe`, `scan_penny_universe_now`), their 4 handler
  cases, and the `dominant_signal` param description on `place_managed_position`.
- `mcp-tools/regime-and-guard.mjs` — excise the penny reference.
- `agent/analysis-scheduler.js` — excise the penny reference (line ~67).
- `agent/public/index.html` — remove the hardcoded penny reference (verify whether it's a
  Trades-tab agent filter option vs. a label; the picker itself is config-driven and updates
  automatically).

**Env:**
- root `.env` and `.env.example` — delete `PENNY_MAX_CAPITAL_PCT` and `PENNY_MAX_POSITION_DOLLARS`.

### 2c. Out of scope — left frozen as historical / audit

Per the `agent-name-id-split` memory, these are frozen records and are **not** touched:
- `docs/superpowers/specs/**` and `docs/superpowers/plans/**` (historical design records)
- `activity_logs/**`, `data/sandboxes/**` (audit trail — including Spark's runtime dir)
- `Claudes Notes/**`, `potential additions/**` (notes / staging area, not live code)
- Other `docs/*.md` background specs (e.g. `preflight-skip-spec.md`) — historical.

### 2d. Three risk flags designed around

1. **"sub-penny" is NOT PennyProphet.** `position_manager.go` has ~5 references to "sub-penny"
   price rounding (sub-$1 tick increments, Alpaca HTTP 422 `42210000`). These are general price
   math and **must be preserved**. Only the penny-*agent* logic is removed.
2. **`AgentSource` is shared attribution.** The field carries `"main"`/`"harvest"`/`"trend"`/etc.
   for all agents — only the `AgentPenny` *value* is removed, never the field.
3. **No destructive SQLite migration.** Removing Go-level usage of `DominantSignal` (and any
   penny-only columns) does **not** drop columns from `managed_positions`. Dropping columns on a
   OneDrive-synced SQLite file is risky and buys nothing; dormant columns are harmless. Storage
   round-trip tests confirm reads/writes still work for the remaining agents.

## 3. Mechanism — coordinated two-half removal

`mergeMissingDefaults` runs *before* `migrateLegacyConfig` and only appends. So:
- **Half 1 (code defaults):** once penny is removed from `defaultAgents()`/`defaultStrategies()`,
  it can never be re-appended.
- **Half 2 (migration):** the v8→v9 migration scrubs the already-persisted records from the live
  config. Both halves ship together via local `main`.

## 4. Config migration (v8 → v9)

First *removal* migration in `migrateLegacyConfig`, following the established add/modify pattern.
It is idempotent and guarded (no-op when the records are already absent):

- Delete the persisted `penny-prophet` **agent** record from `config.agents`.
- Delete the persisted `penny-momentum` **strategy** record from `config.strategies`.
- Delete any **sandbox** whose `agent.activeAgentId === 'penny-prophet'` from `config.sandboxes`
  (the `sbx_1b6dc838` Spark sandbox), so it disappears from the picker.
- Bump `config.schemaVersion` to 9.

**Live-state handling:** the migration only **de-registers** the sandbox config entry. Spark's
runtime dir `data/sandboxes/sbx_1b6dc838/` (its DB with 4 closed trades) is **left on disk as
frozen audit trail** — gitignored, zero cost, consistent with how other historical sandbox data is
treated. It is not deleted.

**Test:** new `agent/migration-v9.test.mjs` feeds a copy of the real config shape (7 agents incl.
penny, the Spark sandbox) through `normalizeConfig` and asserts: penny agent + strategy + sandbox
are gone, `schemaVersion === 9`, and the other six agents/strategies/sandboxes are byte-identical.
Idempotency: a second pass is a no-op.

It runs automatically when the Node orchestrator restarts after a rebuild from local `main` — the
same deploy path as every prior migration.

## 5. Capital reconciliation

Spark's freed 12% lane splits evenly (6/6) across the two recently-updated agents:

| Sleeve | Old lane | New lane |
|---|---|---|
| Prophet (V2) | 34% | 34% |
| Coil (mean-rev) | 18% | **24%** |
| Turtle (trend) | 14% | **20%** |
| Drift (PEAD) | 12% | 12% |
| ~~Spark (penny)~~ | ~~12%~~ | removed |
| Harvest (condor) | 10% | 10% |
| **Total** | 100% | **100%** |

Implementation is almost entirely **prose** — only Spark's lane was ever code-enforced:

- `.env` — delete `PENNY_MAX_CAPITAL_PCT`/`PENNY_MAX_POSITION_DOLLARS` (the only code-enforced cap
  being removed; the other five lanes are self-enforced via rules prose).
- `TRADING_RULES_MEANREV.md` — Coil lane 18% → 24%.
- `TRADING_RULES_TREND.md` — Turtle lane 14% → 20%.
- Every agent rules file carrying the six-lane segment table (`TRADING_RULES_V2.md`, `TREND`,
  `MEANREV`, `HARVEST`, `DRIFT`) — drop the Spark row and update Coil/Turtle so all copies agree
  and still sum to 100%.

Not touched: `MAX_DEPLOYED_PCT=1.0` stays (the 12% shifts between lanes, not into cash). Coil/Turtle
per-position sizing is only changed if their rules explicitly derive it from the lane; otherwise
only the lane ceiling moves.

## 6. Verification & phasing

Because this touches capital-protection code, the gate is: full Go build + test green, Node suite
green, and the other six agents provably untouched. Each phase ends green before the next.

1. **JS/config layer** — config-store defaults + v8→v9 migration (+ `migration-v9.test.mjs`),
   orchestrator, preflight, tool-allowlists, candidate-warmer-flags, mcp-server,
   regime-and-guard.mjs, analysis-scheduler, public/index.html. Update existing penny-touching JS
   tests (`config-store`, `preflight`, `tool-allowlists`, `candidate-warmer-flags`, `beat-context`,
   `cost-store`, `intraday-prompt`, `trade-reconciliation`, `skills-sanity`). Gate: `node --test`.
2. **Go layer** — delete penny services/controller + tests; surgical edits to `main.go`,
   `trade_guard.go`, `position_manager.go`, `config.go`, `models.go`, `storage.go`,
   `segment_pnl_service.go` + comment refs. Update `trade_guard_test.go` (heavy penny coverage) and
   storage/attribution tests. Gate: `go build ./...` + `go test ./...` green (pre-existing flaky
   `TestAggregator_Composite` is the only allowed exception).
3. **Skills + rules + env** — delete the 4 penny skills + `TRADING_RULES_PENNY.md`; apply capital
   prose edits across the rules tables; remove the `.env`/`.env.example` vars.
4. **Whole-branch verification** — full `go test ./...` + `node --test`; run v9 migration against a
   copy of the live `agent-config.json` and assert penny gone + six others intact; grep the live
   tree for residual `penny`/`Penny`/`AgentPenny` outside the frozen-historical dirs (§2c) to
   confirm nothing live was missed.

**Execution model:** subagent-driven TDD on Haiku (per `subagent-model-preference`), phase by
phase, with the diff for each phase reviewed before it lands.

## 7. Landing & activation

- Work in this worktree (`retire-spark-penny`, off local `main` @ `834d335`).
- Squash to one commit; rebase onto current local `main`; fast-forward `main` so the owner's
  rebuild-from-local-main picks it up (per `claude-commits-must-reach-local-main`). No GitHub push
  unless requested.
- **Activation on the owner's side:** rebuild the Go bot + restart the Node orchestrator (runs the
  v9 migration → Spark vanishes from the picker). No feature flag — removal is unconditional.

## 8. Out of scope / deferred

- Spark's runtime data dir is kept (not deleted).
- Historical docs/specs/plans, audit logs, notes, and the `potential additions/` staging area are
  left frozen.
- No SQLite column drops.

## 9. Follow-ups (post-merge)

- Update memory `capital-allocation-reconciled` (six → five lanes; Coil 24 / Turtle 20).
- Update memory `fleet-uncorrelated-ballast-pivot` (Spark retirement executed).
- Note in `managed-position-lifecycle-scope` that the penny-specific review-skill breakage is moot
  (skills deleted).
