# Foundation Part B — Component 3: Historical Repair (quarantine + exit-reason derivation)

**Status:** Draft for operator review
**Created:** 2026-05-31
**Parent spec:** `docs/superpowers/specs/2026-05-31-foundation-measurement-graduation-design.md` (§6, D-B2)
**Depends on:** nothing buildable-blocking. Reads closed `managed_positions`; the cutoff *value* tracks the Part-A deploy but the code ships independently.
**Consumed by:** Component 2 (imports the pure functions: eligibility predicate, exit-reason derivation, the closed-position reader).

---

## 1. Purpose

Two one-time, **read-only, display-only** jobs over historical closed `managed_positions`:

1. **Quarantine by entry date** — a closed position is graduation-*eligible* only if it was entered on/after the Part-A deploy boundary, so the whole lifecycle (entry *and* exit) was produced by trustworthy post-fix code. Everything earlier is excluded from the graduation universe.
2. **Exit-reason derivation (repair)** — for each closed position, derive a best-effort exit reason from stored prices and flag rows whose stored `status` contradicts the derivation (e.g. Coil's COST, stored `STOPPED_OUT` but exited +1.5% *above* its stop). **Repaired labels are reported, never written back** to the DB or surfaced on the dashboard.

This component never edits the database, never auto-acts, and emits no verdicts. It produces (a) a one-time operator report and (b) three pure functions Component 2 imports.

## 2. Grounded findings (verified 2026-05-31 against code + a real DB)

1. **Terminal status set** (`position_manager.go:53`): `PENDING, ACTIVE, PARTIAL, CLOSED, STOPPED_OUT, FAILED`. Closed-*trade* set = `{CLOSED, STOPPED_OUT}`. `FAILED` (entry never became a real position — D2 PENDING timeout / entry failure) is terminal but **excluded** — it is not a trade. `PARTIAL` is non-terminal (still open with reduced qty).
2. **Exit reason is *not* directly stored.** `STOPPED_OUT` is set only when the stop order fills (`:891`); a take-profit fill (`:904`), a manual/signal close (`:1168`), **and a broker-reconcile close** (`:451`) all store `CLOSED`. Reconcile-closes are distinguishable: they stamp `notes += "reconciled_closed:broker_flat"` and place no exit order — their true exit reason is broker-side/unknown.
3. **`current_price` is the last monitor mark, not the exit fill.** Every terminal transition sets `status`+`closed_at` and saves *without* refreshing price; price is written only by the 10s monitor tick (`updatePositionPrice`, `:991-998`). `current_price` and `unrealized_plpc` are written *together* (so mutually consistent), and `unrealized_plpc = ((current_price − entry_price)/entry_price)·100` for a long — a per-share %, **qty-independent**. After a partial fill, `unrealized_pl` (dollars) is recomputed on `remaining_qty` (`:994`) and loses the realized partial leg, but the per-share price/% stays consistent. **⇒ classify on price-vs-level (per share), never on dollar P&L.**
4. **`managed_positions` schema** (real DB, gorm snake_case): `created_at, closed_at` typed `datetime`; key columns `position_id, symbol, side, status, agent_strategy, entry_price, stop_loss_price, take_profit_price, current_price, unrealized_pl, unrealized_plpc, remaining_qty, quantity, allocation_dollars, entry_order_id, notes`.
5. **`created_at` storage format** is Go `time.Time.String()`: `"2026-05-20 14:41:11.1594068-05:00"` — space (not `T`), 7-digit fractional seconds, embedded machine-local offset. `new Date()` does **not** parse this reliably; a normalize-then-parse step is required and unit-tested.
6. **DB access: `node:sqlite` (`DatabaseSync`), not `better-sqlite3`.** The installed `better-sqlite3` is ABI-compiled for Node 20 (MODULE_VERSION 115) and fails to load under the environment's Node 24 (137). `node:sqlite` (Node ≥ 22.5, experimental warning to stderr) has zero native deps and is verified working `{ readOnly: true }` against the real DBs.
7. **DB path** per sandbox: `data/sandboxes/<accountId>/prophet_trader.db`. Sandboxes resolved from `data/agent-config.json` by agent (same pattern as `review-performance` / `apply-friction`), never hardcoded.

## 3. Module

One module `scripts/managed-position-repair.mjs` (+ co-located `managed-position-repair.test.mjs`, `node:test`). The two jobs share the DB read and sandbox resolution, so one cohesive module avoids duplicating the reader. Exported pure functions are individually testable and re-imported by Component 2. CLI guard at the bottom (only runs when invoked directly), matching `apply-friction.mjs`.

### 3.1 `readClosedManagedPositions(dbPath)` — closed-trade reader (the realized/closed leg)

Opens the DB with `node:sqlite` `DatabaseSync({ readOnly: true })` (readonly enforces no-mutation at the driver level — a structural guarantee for "display-only"). Selects `status IN ('CLOSED','STOPPED_OUT')` and returns normalized objects with a **deliberately wide interface** so Component 2 never re-touches this landed module:

```
{ positionId, symbol, side, agentStrategy,
  entryPrice, stopLossPrice, takeProfitPrice,
  exitPrice: current_price,            // last-mark proxy (finding §2.3)
  realizedPnlPct: unrealized_plpc,     // per-share %, consistent w/ exitPrice
  realizedPnl: unrealized_pl,          // dollars; partial-blended (finding §2.3) — provided, flagged
  quantity, remainingQty, allocationDollars, entryOrderId,
  storedStatus: status, notes,
  createdAt, closedAt }                // raw Go-format strings; parsed by callers
```

**Necessary-but-insufficient for Component 2.** This reader is the *closed-trade ledger* leg only. Component 2's daily mark-to-market beta series does **not** come from here — it comes from **Component 1** (the merged Go writer) via the `DBSegmentPnL` daily rows. This reader cannot feed a daily series (closed-only, one frozen mark per trade). The daily-MTM pin is satisfied in Go, not here.

### 3.2 `parseManagedTimestamp(s)` — Go-format datetime → epoch ms

Normalizes the Go `time.Time.String()` form (finding §2.5): replace the date/time space with `T`, truncate fractional seconds to 3 digits, keep the embedded offset, then `Date.parse`. Returns `null` on unparseable/empty input (callers treat `null` createdAt as not-eligible and surface it). Unit-tested on the real format incl. the 7-digit fractional and the offset — the comparison is meaningless if the parse is wrong.

### 3.3 `isGraduationEligible(createdAtMs, cutoffMs)` — quarantine predicate

Pure: `createdAtMs != null && createdAtMs >= cutoffMs`. Boundary is inclusive (entry exactly at cutoff is eligible).

**Cutoff semantics + default.** Named constant `PART_A_DEPLOY_CUTOFF = '2026-05-31'` — the boundary at which the data-generating process became trustworthy (the Part-A-corrected bot going live), **not** "today by convenience." Until the operator rebuilds/redeploys the Part-A bot the true boundary is in the future, so the placeholder default correctly quarantines ~all current history (consistent with the parent spec: nothing graduates for ≥ a quarter). The operator bumps the constant to the real rebuild date at deploy.

**Cutoff is parsed at midnight `America/New_York`** (market calendar day). The 1-hour machine-local-vs-ET difference is immaterial for managed-position entries (all occur mid-session, far from midnight) but is pinned for determinism.

**Override is loud.** A `--cutoff YYYY-MM-DD` override emits a stderr warning *and* is stamped in the report header (`cutoff: 2026-05-31 (DEFAULT)` vs `cutoff: 2026-04-23 (OVERRIDE)`), so the boundary can't be silently slid after seeing which rows land on which side.

### 3.4 `deriveExitReason(position, tolPct = EXIT_MATCH_TOL_PCT)` — exit-reason + mislabel flag

Returns `{ derived, mislabeled, basis }` where `derived ∈ {stop, target, signal_or_time, reconciled, indeterminate}`.

**Order of checks (precedence explicit):**
1. `notes` contains `reconciled_closed` ⇒ `derived = reconciled` (broker-side exit; reason genuinely unknown). Not mislabel-eligible.
2. Required level missing/≤0 for the relevant side, **or degenerate/overlapping bands** (`stopBand ≥ targetBand`, plausible for tight mean-reversion levels) ⇒ `derived = indeterminate`. Not mislabel-eligible. (Missing data must not manufacture a false mislabel.)
3. Price-vs-level, **side-aware**, per-share, with band `tolPct`:
   - LONG: `stop` if `exitPrice ≤ stopLossPrice·(1+tol)`; else `target` if `exitPrice ≥ takeProfitPrice·(1−tol)`; else `signal_or_time`.
   - SHORT inverts both comparisons.

**Band `EXIT_MATCH_TOL_PCT = 0.0025` (0.25%), configurable.** Grounded independently of COST: it absorbs (a) ≤10s monitor-mark staleness vs the true fill (finding §2.3) and (b) stop slippage-through on a liquid large-cap. COST's +150 bp above its stop clears this band ~6×, so the detector is not tuned to its one known target. **Deliberately tight** because the residual `signal_or_time` is the *common, important* bucket for discretionary/batch closers (real data: Coil's ADI/UNH closed in the same millisecond — a batch signal-close, not independent target/stop fills), and this is an eyeballed display tool — over-flagging for human review is the safe asymmetry. **Known blind spot:** a genuine signal exit landing within 0.25% of a level is absorbed into stop/target; acceptable for a report.

**`mislabeled` — full {derived}×{storedStatus} truth table** (only `stop` and `STOPPED_OUT` are the bot's "stop" bucket; `CLOSED` is its bucket for target/signal/time):

| derived \ stored | `STOPPED_OUT` | `CLOSED` |
|---|---|---|
| `stop` | consistent | **mislabeled** (priced as stop, stored non-stop) |
| `target` | **mislabeled** (stored stop, priced as target) | consistent |
| `signal_or_time` | **mislabeled** (← the COST case) | consistent |
| `reconciled` | excluded | excluded |
| `indeterminate` | excluded | excluded |

i.e. `mislabeled = (stored==STOPPED_OUT && derived∉{stop,reconciled,indeterminate}) || (stored==CLOSED && derived==stop)`.

### 3.5 `buildRepairReport(positions, cutoffMs)` — pure aggregator

```
{ cutoff: { date, source: 'DEFAULT'|'OVERRIDE' },
  perStrategy: { <agentStrategy>: { eligible, quarantined } },
  mislabeled: [ {symbol, strategy, storedStatus, derived, entry, stop, target, exit, notes} ],
  indeterminate: [ {symbol, strategy, reason: 'missing_levels'|'degenerate_bands'} ] }
```
Fully unit-testable with synthetic rows, no DB.

### 3.6 CLI guard — one-time operator run

`node scripts/managed-position-repair.mjs [--agent <id>] [--cutoff YYYY-MM-DD]`. Resolves sandboxes from `data/agent-config.json` (default: all sandboxes; `--agent` scopes to one), reads each DB via §3.1, merges rows by `agent_strategy`, and prints a **markdown** report: the cutoff header (with DEFAULT/OVERRIDE), per-strategy eligible/quarantined counts, the mislabeled-exit table, and the indeterminate list. No file writes, no DB writes.

## 4. Testing (TDD, `node:test`)

- `parseManagedTimestamp`: real Go format incl. 7-digit fractional + offset; bad/empty ⇒ `null`.
- `isGraduationEligible`: entry == cutoff eligible; day-before not; `null` createdAt not eligible.
- `deriveExitReason`: long stop / long target / long signal / **COST repair (stored STOPPED_OUT, exit +1.5% above stop ⇒ signal_or_time, mislabeled)** / inverse (stored STOPPED_OUT, priced target ⇒ mislabeled) / short inversion / missing stop ⇒ indeterminate / missing target ⇒ indeterminate / degenerate overlapping bands ⇒ indeterminate / `reconciled_closed` note ⇒ reconciled+not-mislabeled / exit exactly on each band edge.
- `buildRepairReport`: per-strategy bucketing, mislabeled aggregation, indeterminate aggregation, cutoff source stamp.
- **Integration:** seed a temp SQLite file with the **real snake_case schema** (`unrealized_plpc`, `agent_strategy`, `datetime` columns storing the Go-format string) via `node:sqlite`; assert `readClosedManagedPositions` maps `current_price→exitPrice` / `unrealized_plpc→realizedPnlPct` correctly and filters to `CLOSED`/`STOPPED_OUT` (excludes `ACTIVE`/`FAILED`).

## 5. Parent-spec pin (added as D-B8)

Component 2 must key **every exit-reason-dependent number off the *derived* reason** from `deriveExitReason`, never off `storedStatus`. This is the condition that makes the display-only, no-write-back design safe: one source of truth, no persisted-vs-recomputed drift. (For eligible/post-fix rows derived ≈ stored anyway, since post-fix code labels via bracket-fill detection; the repair chiefly serves quarantined display.)

## 6. Out of scope / deferred

- Any DB mutation or dashboard relabel (display-only, by design).
- Beta, gap-aware differencing, friction, graduation verdicts, daily-return series — Component 2.
- Options/Harvest exit-reason (different table `harvest_condors`; not managed_positions).
- **WAL stale-when-quiesced** (a readonly read after the bot stops but before a checkpoint can miss the day's last writes): irrelevant to this one-time operator run; a note for Component 2's *scheduled* read (checkpoint-before-read or read-while-writer-attached).
