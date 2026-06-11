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
| 1 | Management trigger | **Go scheduler** (mirror hedge/Turtle) — a `prophet_vertical_scheduler` runs `RunManageTick` on a market-hours cadence; reconcile + deterministic backstops fire **independently of the LLM heartbeat**. Opens are LLM-triggered (Phase 3); the scheduler only manages. |
| 2 | Engine shape | Mirror `prophet_hedge_*` (ledger façade + executor + scheduler + gorm model). |
| 3 | Stop-monitor exclusion | **Free** via a distinct strategy tag `"v2-vertical"` — `prophet_options_stop_monitor` only acts on orders tagged exactly `"v2-options"`, so vertical legs are ignored with no new code. |
| 4 | Flag | `ENABLE_PROPHET_DEBIT_VERTICALS` → `cfg.EnableProphetDebitVerticals`, default **OFF** (mirror `EnableProphetDefensive`). |
| 5 | Attribution baseline | The **fill-time** snapshot (captured when the open combo fills), not the propose-time reading — so the baseline matches the real entry price. |

## 3. Architecture & components

Each piece mirrors its `prophet_hedge_*` / Turtle counterpart.

| New / changed | Mirrors | Responsibility |
|---|---|---|
| `models/prophet_vertical_models.go` | `prophet_hedge_models.go` | `DBProphetVerticalSpread` (gorm.Model + Direction, both legs+strikes, `Contracts`, `NetDebitPerContract`, `TotalDebit`, `MaxGain`, `Breakeven`, entry-snapshot fields `EntrySpot`/`EntryLongVol`/`EntryShortVol`/`EntryTimeToExpiry`, status `pending_fill\|open\|closing\|closed\|failed`, `CloseReason`, `RealizedPnL`, attribution fields `AttribDirection`/`AttribTheta`/`AttribIV`/`AttribResidual`, `CloseRequested bool`, `OpenedAt`/`ClosedAt`) + `DBProphetVerticalSession` singleton; both with `TableName()`. |
| `database/storage.go` | hedge storage (`:580–623`) + `AutoMigrate` (`:42`) | Register the model in `AutoMigrate(...)`; add `SaveProphetVerticalSpread` / `ListOpenProphetVerticalSpreads` / `GetProphetVerticalSpreadByID` / session getter+setter. |
| `services/prophet_vertical_ledger.go` | `prophet_hedge_ledger.go` | Thin façade over a `verticalLedgerStore` interface (implemented by `*database.LocalStorage`, faked in tests). |
| `services/prophet_vertical_executor.go` | `prophet_hedge_executor.go` | The engine: `Place`, `RunManageTick`, `RequestClose`, plus internal `reconcilePending`/`reconcileClosing`/`closeVertical` (§4). Consumes Phase 1's `verticalDebitLimit`, `selectVerticalExit`, `attributeVerticalPnl`. |
| `services/prophet_vertical_scheduler.go` | `prophet_hedge_scheduler.go` | Thin loop driving `RunManageTick` on a market-hours cadence (holiday/window-aware like the hedge scheduler). |
| `config/config.go` (+ `config_test.go`) | `EnableProphetDefensive` | `EnableProphetDebitVerticals` ← `ENABLE_PROPHET_DEBIT_VERTICALS`, default OFF. |
| `cmd/bot/main.go` (`~:419`) | hedge scheduler startup | Gated start of the vertical scheduler when the flag is on and `tradingService != nil`. |

**Falls out for free:** the migration (AutoMigrate creates the table) and the stop-monitor exclusion (the `"v2-vertical"` tag).

## 4. Manage-tick & fail-closed close

`RunManageTick(ctx, now)` — invoked by the scheduler each cadence; for every non-terminal vertical in the ledger:

1. **Reconcile first** (mirrors hedge `reconcilePending`/`reconcileClosing`; mleg combos are **atomic** — a fill is N complete spreads, never a half-spread, so the ledger can never hold a single leg):
   - `pending_fill` → filled: set `open`, record fill economics, **capture the entry snapshot** (spot + per-leg IV + time-to-expiry). Canceled/rejected → `failed`.
   - `closing` → filled: set `closed`, compute `RealizedPnL`, compute **attribution** via `attributeVerticalPnl(entry, exit, realized)`. Canceled/rejected → **revert to `open`** (retry next tick) — never strand.
2. **For each `open` vertical:** snapshot current spread value + spot + leg IVs → if `CloseRequested` (set by `RequestClose`) close `llm_requested`; else build `VerticalState`, call `selectVerticalExit` → if `act`, close with that reason; `let_expire` holds.

`closeVertical(sp, reason)` — places the reverse atomic mleg combo (`sell_to_close` long + `buy_to_close` short, marketable limit, `"v2-vertical"` tag), flips the row to `closing`, stores `CloseOrderID`+reason. **Fail-closed: only `reconcileClosing` marks the row `closed`, after the broker confirms the fill** — the carry-forward applied to the options path.

`Place(ctx, structure)` (called by Phase 3; tested here with a mock trader) — builds the opening combo (`buy_to_open` long + `sell_to_open` short, debit limit from `verticalDebitLimit`, `"v2-vertical"` tag), runs **per-leg `CheckOptionsOpen`**, submits, persists `pending_fill` + `EntryOrderID`.

`RequestClose(ctx, id)` — sets `CloseRequested=true`. **One close path:** both the LLM request and the deterministic backstops converge on `closeVertical`, so every exit is consistently fail-closed. The Phase-3 endpoint may fire an immediate tick for responsiveness.

## 5. Phase-2/3 boundary & snapshot capture

**Phase 2 exposes** (the only surface Phase 3 touches): `Place(ctx, structure) (verticalID, err)`, `RequestClose(ctx, verticalID) error`, and the ledger reads (`ListOpen`, get-by-ID).

**Phase 2 does NOT build** (all Phase 3): the proposal record/TTL + identity contract, the MCP tools, the HTTP endpoints, the propose-time decision card.

**Snapshot capture:**
- **Entry baseline** captured at **fill** (`reconcilePending`→open) from the two leg `GetOptionSnapshot`s (each carries `ImpliedVolatility`) + `GetLatestBar(underlying)` for spot. `EntryTimeToExpiry` = (Expiration − fillTime)/365y.
- **Exit snapshot** captured the same way at the close fill, then fed with the entry snapshot to `attributeVerticalPnl`.
- *Deliberate split:* Phase 3's propose-time IV reading is for the **card's** "why a vertical" context; the **attribution** uses the fill-time snapshot. Two readings, two purposes.
- **Graceful degradation:** missing/zero IV → `bsPrice` falls back to intrinsic, so attribution still produces (lower-confidence) numbers rather than failing.

## 6. Testing (TDD)

Mirror the hedge-executor and `position_manager` fail-closed-close suites.
- **Ledger:** in-memory fake `verticalLedgerStore` round-trips; a DB-backed `LocalStorage` test mirroring `storage_prophet_hedge_test.go`.
- **Executor (mocks: mleg trader `PlaceMultiLegOrder`+`GetOrder`, chain `GetOptionSnapshot`/`GetLatestBar`, guard):**
  - `Place` builds the correct opening combo + runs per-leg guard + persists `pending_fill`; a guard rejection blocks the open.
  - `reconcilePending`: filled → `open` with entry snapshot captured; canceled → `failed`.
  - **Non-negotiable — fail-closed close:** `closeVertical`→`closing`; reconcile filled → `closed` + `RealizedPnL` + attribution; **canceled/rejected close → reverts to `open`, never stranded**.
  - `RunManageTick`: a seeded vertical tripping a backstop (DTE ≤ forceDTE) closes with the right reason; a `CloseRequested` one closes `llm_requested`; a `let_expire` carve-out state holds.
- **Config:** `config_test` asserts `EnableProphetDebitVerticals` defaults OFF.

## 7. Rollout

- Flag default **OFF**; `cmd/bot/main.go` starts the scheduler only when on. New table auto-created by AutoMigrate (no data migration). Deploy = rebuild Go + restart from local main.
- **Safe to merge with the flag in either state:** with no Phase-3 tools, nothing opens — the scheduler manages an empty ledger. Phase 2 goes live only when Phase 3 ships the tools.
- **Verification before "done":** executor unit tests (esp. fail-closed close) green; `go build ./...` + `go vet ./services/` clean; the config-default-off test. A live smoke test waits for Phase 3.

## 8. Out of scope (Phase 2)

The tools / endpoints / proposal record + identity contract (Phase 3); single-leg attribution + the sleeve tally (Phase 4); multi-contract sizing (Phase 1 = 1 contract); roll automation.

## 9. To verify / settle during planning

- The exact `mleg.MultiLegOrder.LimitPrice` sign for the **opening debit** (documented as net "credit"/positive=receive) vs the **closing credit** — confirm both directions against the hedge usage (hedge close uses `LimitPrice 0` = market; opening uses a positive `marketableLimitCapped` debit).
- The scheduler cadence + market-hours/holiday window (reuse the hedge scheduler's `nyLoc` + `usMarketHolidays2026` helpers vs a vertical-specific window).
- Whether `DBProphetVerticalSession` is needed at all (the hedge uses it for a once-daily duplicate-heartbeat guard; a manage-tick that runs every N minutes may not need it — decide during planning).
- Backstop config knob wiring (`VerticalExitConfig` values: `ForceDTE`, `SalvageFloorFrac`, `CaptureDTE`, `ExpectedExitCost`) — source from config/flags with the Phase-1 defaults.
