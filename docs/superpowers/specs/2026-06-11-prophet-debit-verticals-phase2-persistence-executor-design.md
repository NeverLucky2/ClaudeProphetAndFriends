# Prophet Debit Verticals — Phase 2 (Persistence & Executor) Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — pending implementation plan
**Owner:** Prophet (default agent)
**Builds on:** Phase 1 (pure core), merged to main `9d8ef42`. Feature spec: `docs/superpowers/specs/2026-06-11-prophet-debit-verticals-design.md`.

## 1. Context & goal

Phase 1 delivered the pure, I/O-free core (strike-snapper, economics, exit resolver, Black-Scholes pricer, attribution walk). Phase 2 adds the **persistence and execution layer** that turns those functions into a managed lifecycle: a DB model, a ledger, an executor (place via `mleg`, two-phase fail-closed close, reconcile, deterministic backstops), a Go scheduler that drives management, and the feature flag.

Phase 2 is a near-exact mirror of the existing, tested **`prophet_hedge_*` (DefensiveProphet) engine** — the same structure that already builds, submits, manages, and records defined-risk QQQ put-debit spreads — generalized to the LLM-driven, call-or-put verticals from Phase 1.

Phase 2 builds **no LLM-facing surface** (no tools, endpoints, or proposal record — those are Phase 3). With the flag on but Phase 3 absent, the scheduler manages an empty ledger (a no-op), so Phase 2 is independently testable and safe to merge with the flag in either state.

## 2. Decisions (settled in brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Management trigger | **Go intraday loop** — a `prophet_vertical_scheduler` runs `RunManageTick` on a market-hours cadence; reconcile + deterministic backstops fire **independently of the LLM heartbeat**. Opens are LLM-triggered (Phase 3); the scheduler only manages. ⚠️ Loop shape mirrors **`ProphetOptionsStopMonitor.Start(ctx, interval, idleInterval, marketIsOpen)`** (see `cmd/bot/main.go:479`: 1m active / 5m idle / `stopMarketOpen` gate) — NOT the hedge scheduler, which is a once-daily 17:00 ET fire (`nextFireTime`) and the wrong shape for intraday management. Keep the hedge scheduler's `LastResult()` caching pattern for a future status endpoint. |
| 2 | Engine shape | Mirror `prophet_hedge_*` (ledger façade + executor + gorm model + constants file). |
| 3 | Stop-monitor exclusion | **Free** via a distinct strategy tag `"v2-vertical"` — `prophet_options_stop_monitor` only acts on orders tagged exactly `"v2-options"` (it already ignores `"prophet-defensive"` and `"v2-options-stop"`), so vertical legs are ignored with no new code. |
| 4 | Flag | `ENABLE_PROPHET_DEBIT_VERTICALS` → `cfg.EnableProphetDebitVerticals`, default **OFF** (mirror `EnableProphetDefensive`). |
| 5 | Attribution baseline | The **fill-detection** snapshot — captured on the first manage-tick that observes the open combo filled (within one tick of the actual fill; ≤ the active cadence of drift, acceptable for an instructional decomposition). Not the propose-time reading, so the baseline tracks the real entry. |
| 6 | mleg sign convention — **RESOLVED** | Per [Alpaca's Options Level 3 docs](https://docs.alpaca.markets/docs/options-level-3-trading): **positive `limit_price` = net debit (we pay), negative = net credit (we receive)**; `PlaceMultiLegOrder` passes the value through unmodified, and `LimitPrice == 0` sends a **market** combo (existing code path, used by hedge closes). The `mleg.go` struct comment ("positive = we receive credit") is stale Harvest-era legacy that contradicts both the docs and the hedge engine's actual usage (positive limits on debit opens) — fix the comment during implementation. Consequences: our **open** submits a positive `verticalDebitLimit` (correct as-is); our **close** must NOT use a positive "marketable limit" (a close *receives* credit — positive would mean "willing to pay") → v1 closes at **market** (`LimitPrice 0`), exactly like hedge `closeSpread`. A negative credit-floor limit on closes is future work. |
| 7 | Session row | **Dropped** (YAGNI). The hedge's `DBProphetHedgeSession` exists only to dedupe its once-daily heartbeat; an idempotent intraday manage-tick needs no daily dedup, and verticals themselves are the durable state. No session model, no session storage methods. |

## 3. Architecture & components

Each piece mirrors its `prophet_hedge_*` / Turtle counterpart.

| New / changed | Mirrors | Responsibility |
|---|---|---|
| `models/prophet_vertical_models.go` | `prophet_hedge_models.go` | `DBProphetVerticalSpread` (gorm.Model + Direction, both legs+strikes, `Contracts`, `NetDebitPerContract`, `TotalDebit`, `MaxGain`, `Breakeven`, entry-snapshot fields `EntrySpot`/`EntryLongVol`/`EntryShortVol`/`EntryTimeToExpiry`, status `pending_fill\|open\|closing\|closed\|failed`, `CloseReason`, `RealizedPnL`, attribution fields `AttribDirection`/`AttribTheta`/`AttribIV`/`AttribResidual`, `CloseRequested bool`, `OpenedAt`/`ClosedAt`) with `TableName()`. **No session model** (decision #7). |
| `database/storage.go` | hedge storage (`:580–623`) + `AutoMigrate` (`:42`) | Register the model in `AutoMigrate(...)`; add `SaveProphetVerticalSpread` / `ListOpenProphetVerticalSpreads` / `GetProphetVerticalSpreadByID`. No session methods. |
| `services/prophet_vertical_constants.go` | `prophet_hedge_constants.go` | Compile-time tuning constants (the established pattern — the hedge engine uses constants, not env knobs): `verticalStrategyTag = "v2-vertical"`, `verticalForceDTE = 2`, `verticalCaptureDTE = 3`, `verticalSalvageFloorFrac = 0.20`, `verticalExpectedExitCost = 5.0` (per-contract $), `verticalTickInterval = 5min` / `verticalIdleInterval = 30min` (gentler than the stop monitor's 1m/5m — day-scale backstops don't need minute-scale polling, and the shared account has 429 history). These are the pre-registered knobs from the feature spec §10. |
| `services/prophet_vertical_ledger.go` | `prophet_hedge_ledger.go` | Thin façade over a `verticalLedgerStore` interface (implemented by `*database.LocalStorage`, faked in tests). |
| `services/prophet_vertical_executor.go` | `prophet_hedge_executor.go` | The engine: `Place`, `RunManageTick`, `RequestClose`, plus internal `reconcilePending`/`reconcileClosing`/`closeVertical` (§4). Consumes Phase 1's `verticalDebitLimit`, `selectVerticalExit`, `attributeVerticalPnl`. Depends on small consumer-defined interfaces mirroring the hedge's split (`verticalChainFetcher` for `GetOptionSnapshot`, `verticalBarFetcher` for `GetLatestBar`, `verticalMlegTrader` for `PlaceMultiLegOrder`+`GetOrder`, `verticalGuard` for `CheckOptionsOpen`). |
| `services/prophet_vertical_scheduler.go` | `ProphetOptionsStopMonitor.Start` loop shape | Timer loop: every `verticalTickInterval` while `marketIsOpen()`, else `verticalIdleInterval`; calls `RunManageTick`; caches a `LastResult()` like the hedge scheduler for a future status endpoint. |
| `config/config.go` (+ `config_test.go`) | `EnableProphetDefensive` | `EnableProphetDebitVerticals` ← `ENABLE_PROPHET_DEBIT_VERTICALS`, default OFF. |
| `cmd/bot/main.go` (stop-monitor wiring at `:479` is the closer anchor; hedge startup at `~:419` for the flag-gate idiom) | both | Gated start of the vertical scheduler when the flag is on and `tradingService != nil`; reuse the same `marketIsOpen`-style gate the stop monitor uses. |

**Falls out for free:** the migration (AutoMigrate creates the table) and the stop-monitor exclusion (the `"v2-vertical"` tag).

## 4. Manage-tick & fail-closed close

`RunManageTick(ctx, now)` — invoked by the scheduler each cadence; for every non-terminal vertical in the ledger:

1. **Reconcile first** (mirrors hedge `reconcilePending`/`reconcileClosing`; mleg combos are **atomic** — a fill is N complete spreads, never a half-spread, so the ledger can never hold a single leg):
   - `pending_fill` → filled: set `open`, record fill economics, **capture the entry snapshot** (spot + per-leg IV + time-to-expiry). Canceled/rejected → `failed`.
   - `closing` → filled: set `closed`, compute `RealizedPnL`, compute **attribution** via `attributeVerticalPnl(entry, exit, realized)`. Canceled/rejected → **revert to `open`** (retry next tick) — never strand.
2. **For each `open` vertical:** snapshot current spread value + spot + leg IVs → if `CloseRequested` (set by `RequestClose`) close `llm_requested`; else build `VerticalState`, call `selectVerticalExit` → if `act`, close with that reason; `let_expire` holds.

`closeVertical(sp, reason)` — places the reverse atomic mleg combo (`sell_to_close` long + `buy_to_close` short, **market close: `LimitPrice 0`**, `"v2-vertical"` tag), flips the row to `closing`, stores `CloseOrderID`+reason. Market close mirrors hedge `closeSpread` exactly and sidesteps the sign hazard (decision #6): a close *receives* credit, so a positive "marketable limit" would mean "willing to pay" — wrong. **Fail-closed: only `reconcileClosing` marks the row `closed`, after the broker confirms the fill** — the carry-forward applied to the options path.

`Place(ctx, structure)` (called by Phase 3; tested here with a mock trader) — builds the opening combo (`buy_to_open` long + `sell_to_open` short, debit limit from `verticalDebitLimit`, `"v2-vertical"` tag), runs **per-leg `CheckOptionsOpen`**, submits, persists `pending_fill` + `EntryOrderID`.

`RequestClose(ctx, id)` — sets `CloseRequested=true`. **One close path:** both the LLM request and the deterministic backstops converge on `closeVertical`, so every exit is consistently fail-closed. The Phase-3 endpoint may fire an immediate tick for responsiveness.

## 5. Phase-2/3 boundary & snapshot capture

**Phase 2 exposes** (the only surface Phase 3 touches): `Place(ctx, structure) (verticalID, err)`, `RequestClose(ctx, verticalID) error`, and the ledger reads (`ListOpen`, get-by-ID).

**Phase 2 does NOT build** (all Phase 3): the proposal record/TTL + identity contract, the MCP tools, the HTTP endpoints, the propose-time decision card.

**Snapshot capture:**
- **Entry baseline** captured at **fill-detection** (`reconcilePending`→open, i.e. the first manage-tick that observes the fill — within one `verticalTickInterval` of the actual fill) from the two leg `GetOptionSnapshot`s (each carries `ImpliedVolatility`) + `GetLatestBar(underlying)` for spot. `EntryTimeToExpiry` = (Expiration − detectionTime)/365y. The ≤ one-tick drift is acceptable for an instructional decomposition and is part of why `Residual` exists.
- **Exit snapshot** captured the same way at the close fill, then fed with the entry snapshot to `attributeVerticalPnl`.
- *Deliberate split:* Phase 3's propose-time IV reading is for the **card's** "why a vertical" context; the **attribution** uses the fill-time snapshot. Two readings, two purposes.
- **Graceful degradation:** missing/zero IV → `bsPrice` falls back to intrinsic, so attribution still produces (lower-confidence) numbers rather than failing.

## 6. Testing (TDD)

Mirror the hedge-executor and `position_manager` fail-closed-close suites.
- **Ledger:** in-memory fake `verticalLedgerStore` round-trips; a DB-backed `LocalStorage` test mirroring `storage_prophet_hedge_test.go`.
- **Executor (mocks implementing the four consumer interfaces: `verticalMlegTrader`, `verticalChainFetcher`, `verticalBarFetcher`, `verticalGuard`):**
  - `Place` builds the correct opening combo (positive debit `LimitPrice`, `"v2-vertical"` tag) + runs per-leg guard + persists `pending_fill`; a guard rejection blocks the open.
  - `reconcilePending`: filled → `open` with entry snapshot captured; canceled → `failed`.
  - **Non-negotiable — fail-closed close:** `closeVertical` submits the reverse combo **at market (`LimitPrice == 0`) — assert this in the test** (sign-hazard guard) → `closing`; reconcile filled → `closed` + `RealizedPnL` + attribution; **canceled/rejected close → reverts to `open`, never stranded**.
  - `RunManageTick`: a seeded vertical tripping a backstop (DTE ≤ forceDTE) closes with the right reason; a `CloseRequested` one closes `llm_requested`; a `let_expire` carve-out state holds.
- **Config:** `config_test` asserts `EnableProphetDebitVerticals` defaults OFF.

## 7. Rollout

- Flag default **OFF**; `cmd/bot/main.go` starts the scheduler only when on. New table auto-created by AutoMigrate (no data migration). Deploy = rebuild Go + restart from local main.
- **Safe to merge with the flag in either state:** with no Phase-3 tools, nothing opens — the scheduler manages an empty ledger. Phase 2 goes live only when Phase 3 ships the tools.
- **Verification before "done":** executor unit tests (esp. fail-closed close) green; `go build ./...` + `go vet ./services/` clean; the config-default-off test. A live smoke test waits for Phase 3.

## 8. Out of scope (Phase 2)

The tools / endpoints / proposal record + identity contract (Phase 3); single-leg attribution + the sleeve tally (Phase 4); multi-contract sizing (Phase 1 = 1 contract); roll automation.

## 9. To verify / settle during planning

*(Resolved during spec review 2026-06-11: the mleg sign convention → decision #6, positive=debit/negative=credit per Alpaca docs, close at market; the session-row question → decision #7, dropped; backstop knobs → `prophet_vertical_constants.go`, decision in §3.)*

Remaining:
- **Fix the stale `mleg.go` comment** while in there: `LimitPrice` is documented in code as "net credit (positive = we receive)" but Alpaca's convention (and the hedge's actual usage) is positive = net **debit**. One-line doc fix, prevents the next reader from inverting a sign.
- The exact `marketIsOpen` gate to pass the scheduler (reuse the stop monitor's `stopMarketOpen` from `cmd/bot/main.go:479`, or its underlying helper — name it during planning).
- Confirm `GetOptionSnapshot`'s `ImpliedVolatility` is populated on the paper feed for the legs we trade (the field exists on `interfaces.OptionContract`; degradation path already designed if it's zero).
- Whether Phase 3 wants the scheduler's `LastResult()` surfaced on a status endpoint now or later (build the method regardless — it's ~10 lines and mirrors the hedge scheduler).
