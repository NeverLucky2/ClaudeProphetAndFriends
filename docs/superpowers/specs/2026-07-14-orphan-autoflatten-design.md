# Orphan Surfacing + Auto-Flatten: Design Spec

**Date:** 2026-07-14
**Status:** Design — approved, pending spec review
**Scope:** Make the *already-existing* stuck-exit (orphan) detection visible to the operator, and add an opt-in active auto-flatten that liquidates a confirmed orphan. **Surfacing (Layer A) is generically safe; auto-flatten (Layer B) is constrained to single-agent (dedicated) accounts — see §"The shared-account constraint".** The live Coil account is dedicated by construction, which is what makes auto-flatten safe there.

---

## Motivation

The Coil live-funding final review flagged stuck-exit / failed-close detection as "NOT built," citing the **Node** reconciliation's scope note (`agent/trade-reconciliation.js:135`): *"Covers order placements (opens/adds). Does NOT verify closes/exits or live position state — a logged-success close that did not execute will not be caught here."*

That scope note is true **of the Node reconciliation** and misleading about the system as a whole. The **Go** side already detects this exact condition:

- **`CloseManagedPosition` is fail-closed** (`services/position_manager.go:1163`). A failed liquidation never marks the position CLOSED, re-places the protective stop if the bracket was torn down, and logs `operator_review_required`. The stranded-long-with-no-stop scenario is defended at the source.
- **`reconcileWithBroker`** runs every ~60s (`position_manager.go:406`, `reconcileEveryTicks = 6`) and closes ledger positions the broker no longer holds.
- **`findOrphans` + `OrphanReporter`** (`position_manager.go:1432`, `services/orphan_reporter.go`) detect *precisely* the stuck-exit case — the `OrphanAlert` doc reads: *"a broker position whose managed record this agent has marked terminal while the broker still holds the shares — a close that never actually flattened the broker side."* It is wired at `main.go:438`, runs inside the reconcile loop via `detectOrphans` (`position_manager.go:529`), and writes `reports/orphans.json`.

So **detection exists and runs.** The real gaps are:

1. **It surfaces nowhere the operator will see.** `orphans.json` is a file in the DB directory — no HTTP endpoint, no dashboard, no alert. The `OrphanReporter` comment even concedes it exists because "the Go bot's console logs are not reliably retained," yet a JSON file nobody opens has the same problem.
2. **Detection-only, no remediation.** An orphan is a real-money long with no stop and no manager. Today the bot notices and does nothing but write a file.
3. **The two reconciliation systems don't know about each other.** The Node scope note actively misleads (it made the final review conclude nothing covered closes) while the Go detector silently does the work.

This spec closes all three, without building a second detector.

## The shared-account constraint (the central safety boundary)

`AlpacaTradingService.GetPositions()` returns the **entire Alpaca account**, unfiltered by agent (`services/alpaca_trading.go` — it maps `s.client.GetPositions()` verbatim). Each bot's `PositionManager` sees only **its own** ledger (separate per-sandbox `DATABASE_PATH`), but sees **every agent's** broker shares.

`findOrphans` flags a symbol when: the broker holds it, this bot has a **terminal** record for it, and this bot has **no live** record for it. On a **shared** account that admits a false positive: if bot X closed its position in AAPL (terminal record) while bot Y legitimately holds AAPL live, X has no live record for AAPL and flags it as an "orphan" — but those shares are **Y's live position**, not a stuck exit.

- For **Layer A (report-only)** this is a tolerable imprecision: the operator sees a spurious entry and ignores it. It changes nothing about broker state.
- For **Layer B (auto-flatten)** it is **fatal**: the bot would submit a market sell of **another agent's live position**.

Therefore **auto-flatten is only correct on a single-agent (dedicated) account**, where every broker share the bot sees is unambiguously its own. **Nothing in the code structurally enforces "dedicated"** — the account/sandbox model permits multiple sandboxes to point at one account (the paper account has five). So the constraint is enforced operationally, and made deliberate rather than implicit:

- The live Coil account is dedicated by construction (the live-funding spec created a *new* Alpaca account with a single sandbox, `sbx_mean_rev_live`).
- Enabling Layer B requires the operator to set **both** `ENABLE_COIL_ORPHAN_AUTOFLATTEN=true` **and** a separate affirmation flag `ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED=true`. The auto-flatten path **fails closed** (never acts, logs why) unless the affirmation flag is set — so turning on auto-flatten without consciously asserting the account is single-agent does nothing. This mirrors the fun-sleeve gate's "a money gate's safe state is block" posture.
- The runbook states the constraint in one line: *never enable auto-flatten on an account more than one bot trades.*

This is the one boundary that, if crossed, turns a safety feature into a cross-agent liquidation. It is called out here so it cannot be reduced to a footnote.

## Non-goals

- **No new detection logic.** `findOrphans` remains the single source of truth. Re-implementing it would create a second, divergent detector — the exact hazard the strategy-id registry work in the live-funding branch was about avoiding.
- **No new alert *transport*.** A Slack push channel already exists (`notifySlack` in `agent/server.js:268`, gated per-event by `notifyOn`, e.g. `tradeExecuted`, `positionOpened`). This spec *reuses* it by adding orphan events — it does not build a new channel. (An earlier draft of this spec wrongly claimed no push channel existed; it does.)
- **No change to `CloseManagedPosition`'s own retry logic.** Auto-flatten is a *backstop for orphans that already escaped that path*, not a replacement for it. The two handle **disjoint** ledger states and cannot conflict: `CloseManagedPosition` re-places the stop and leaves a position **ACTIVE** (non-terminal) on a failed close, so that position is never an orphan; auto-flatten only ever acts on positions that reached a **terminal** status while the broker still holds shares.

---

## Design

Two layers on top of the existing detector.

### Layer A — Surface + alert (ALWAYS ON, no flag)

The gap the final review actually found. Ships regardless of whether auto-flatten is ever enabled.

- **`PositionManager.OrphanStatus()`** — a new read-only method returning the current orphan set plus the auto-flatten state (enabled, dedicated-affirmed, streak-per-symbol, latched-per-symbol, last action + result). Pure snapshot, but it reads `pm.positions`, `orphanStreak`, and `flattenLatched`, all mutated by the reconcile loop under `pm.mu` — so it **must take `pm.mu`** (read lock) to snapshot. (This is the same class of bug as the −15% halt's `Status()` racing `hwmMem`, caught in that review; do not repeat it.) Follows the shape of `ProphetSleeveGuard.Status()`.
- **`OrphanController`** exposing `GET /api/v1/orphans/status`, mirroring `controllers/sleeve_controller.go` (503 when the PM/feature is unavailable, `c.JSON(200, pm.OrphanStatus())` otherwise). Wired in `main.go` next to the other controllers.
- **Node poller + dashboard surface.** The harness already sweeps all running sandboxes per-`goAxios` for reconciliation (`agent/server.js:195-235`) and exposes `/api/reconciliation`, which the dashboard polls. Add a sibling sweep that GETs `/api/v1/orphans/status`, aggregates across sandboxes, and exposes `/api/orphans` for the dashboard to show an orphan view **alongside the existing reconciliation view** (no new dashboard framework — the same pattern).
- **Push alert, reusing the existing Slack path.** Add orphan events to the existing `notifyOn` gating (`agent/server.js`): `orphanDetected`, `orphanFlattened`, `orphanFlattenFailed`. When the operator has enabled the event, `notifySlack` pushes it. **Dedup is mandatory:** the loud alert (Slack push + the `operator_review_required` log) fires **once per newly-detected orphan symbol**, cleared when the symbol resolves — mirroring the Go side's existing `orphanAlerted` dedup (`position_manager.go:1497`) and the analysis-scheduler's fingerprint suppression. Re-alerting every ~60s poll is itself a safety failure (an operator who learns to ignore the alert is worse off than one who never had it). The `/api/orphans` status endpoint, by contrast, always reflects current state.
- **Fix the misleading Node scope note.** `agent/trade-reconciliation.js:135` `SCOPE_NOTE` is rewritten to state that closes/exits are covered by the Go-side orphan detector (`/api/v1/orphans/status`), not left unverified. The Node reconciliation still covers opens; it simply stops *claiming* nothing covers closes.

`OrphanReporter` keeps writing `orphans.json` unchanged — it is the retained on-disk record; the endpoint is the live view; Slack is the push.

### Layer B — Auto-flatten (FLAG-GATED, default OFF)

Runs inside the existing reconcile loop, immediately after `detectOrphans`, reusing the broker positions already read that pass. Off by default; when off, Layer A still runs (observe-before-enforce, matching the regime/universe/position-cap gates).

**Precondition — the action does nothing unless BOTH gates are set:** `EnableOrphanAutoFlatten` **and** `OrphanAutoFlattenAccountIsDedicated` (see §"The shared-account constraint"). If auto-flatten is enabled without the dedicated affirmation, the bot logs once at startup ("auto-flatten enabled but account not affirmed dedicated — refusing to act") and behaves as if Layer B were off. Fail-closed: the safe state of an un-affirmed money action is inaction.

State tracked on `PositionManager`, keyed by symbol (both **in-memory**, reset on process restart — see "Restart behavior" below):
- `orphanStreak map[string]int` — consecutive reconcile passes the symbol has been an orphan.
- `flattenLatched map[string]bool` — an auto-flatten has been attempted for this symbol; do not re-submit.

Per reconcile pass, for the current orphan set:

1. For each orphan symbol, increment `orphanStreak[symbol]`.
2. For each symbol **no longer** in the orphan set, delete its `orphanStreak` and `flattenLatched` entries (natural resolution — see below).
3. For each orphan symbol where `flattenLatched[symbol]` is already true → skip (already acted; awaiting resolution or operator).
4. For each orphan symbol where `orphanStreak[symbol] >= autoFlattenStreak` (default **3**) and not latched:
   a. **Long-only guard.** Only act on a **long** orphan (broker qty > 0). Coil is long-only; a short/negative-qty orphan is an anomaly that should never exist, and auto-*buying* to cover is a materially different risk. A short orphan is alerted (`operator_review_required`) and **never auto-flattened**.
   b. **Market-open gate.** If the market is not open (injected `marketIsOpen func() bool`, the pattern used by `ProphetOptionsStopMonitor` / `ProphetVerticalScheduler`), do NOT fire. Hold the streak; retry next pass. Rationale: a market liquidation into a closed market rejects, which would latch and strand the position until the operator manually clears the latch.
   c. **Fresh re-confirm.** Re-read broker positions (`GetPositions`) right before acting. Confirm the symbol is still held long at qty > 0 **and** still an orphan (no live managed record has appeared for it). If either fails → clear the streak and skip. This is the guard against acting on a stale snapshot. **Fail-closed:** if the re-read itself errors, do NOT sell — skip and retry next pass.
   d. Submit `ClosePosition(ctx, symbol, brokerQty)` — the broker's canonical flatten primitive (`services/alpaca_trading.go:295`), one attempt, for the qty confirmed in (c).
   e. Set `flattenLatched[symbol] = true` **regardless of the call's result**, so the sell is never re-submitted (this process; see "Restart behavior").
   f. **Success** → append an audit note to the symbol's terminal ledger record (`"orphan_autoflattened:<qty>@<order_id>"`, mirroring the existing `reconciled_closed:broker_flat` note convention) and persist it, so a real-money sell is never left with no ledger trace; log "auto-flattened orphan" + fire the `orphanFlattened` alert. The next reconcile sees the broker flat, the symbol drops out of the orphan set, and step 2 clears both its streak and latch. Natural resolution.
   g. **Failure/rejection** → log `operator_review_required` "auto-flatten FAILED" + fire the `orphanFlattenFailed` alert. The latch stays set, so it is never retried; the symbol remains an orphan until the operator resolves it (which removes the broker shares and clears the latch via step 2).

**Restart behavior (deliberate).** `orphanStreak` and `flattenLatched` are in-memory (like the existing `orphanAlerted`), so a process restart resets them: a still-present orphan re-accrues its streak and, after 3 passes, is re-attempted. This is a conscious choice, and the *opposite* of the −15% halt's file-backed latch — because the failure directions differ. The halt's latch had to survive restart because clearing it *removed a loss bound*; here, re-attempting a flatten *re-tries the correct action* on shares that are still genuinely stuck, and a restart may itself have cleared whatever transient condition caused the first failure. The safety cost of a restart-triggered re-attempt is bounded by the same gates as the first (dedicated-account, long-only, fresh re-read, one-attempt-per-process), so it cannot become a tight loop within a process. The persistent record of *what happened* lives in `orphans.json` and the ledger audit note, both file-backed.

### Safety properties (each gets an explicit test)

1. **On a dedicated account, it can only ever sell shares this bot's own ledger already marked terminal.** `findOrphans` excludes any symbol with a live (non-terminal) record in this bot's ledger, so flattening *this bot's own* live position is structurally impossible. The remaining exposure — selling *another agent's* live position — exists only on a shared account and is closed by the dedicated-account precondition (see §"The shared-account constraint"). The two together are what make the action safe; neither alone is sufficient.
2. **Two gates, both required.** `EnableOrphanAutoFlatten` AND `OrphanAutoFlattenAccountIsDedicated`. Enabling the action without affirming the account is dedicated is inert.
3. **Long-only.** Only long orphans (qty > 0) are auto-flattened; a short orphan is alerted, never covered.
4. **Market-open gate.** No liquidation is submitted into a closed market.
5. **Fail-closed re-read.** If the pre-flatten broker re-read fails, no sell happens.
6. **The −15% halt never interferes.** Auto-flatten is a sell via `ClosePosition`, which does not pass through `TradeGuard.CheckBuy`. Exits stay structurally unblockable — consistent with the live-funding halt's core invariant.
7. **Idempotent latch.** A slow broker settle (shares still showing held on the pass after a successful flatten) cannot trigger a second submit, because the latch is set the moment the first attempt is made.
8. **`OrphanStatus()` is race-free.** It snapshots all mutable state under `pm.mu`; the reconcile loop mutates that state under the same lock.

### Config

- `ENABLE_COIL_ORPHAN_AUTOFLATTEN` — default `false`. Gates Layer B only; Layer A is unconditional.
- `ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED` — default `false`. The operator's affirmation that this account is single-agent. Layer B is inert unless this is `true` (see §"The shared-account constraint"). Kept as a **separate** flag, not folded into the enable flag, precisely so that turning auto-flatten on is not the same keystroke as asserting the account is safe for it.
- `ORPHAN_AUTOFLATTEN_STREAK` — default `3`.
- All three read in `config/config.go` (`EnableOrphanAutoFlatten`, `OrphanAutoFlattenAccountIsDedicated`, `OrphanAutoFlattenStreak`), and the two boolean gates are **scoped per-bot in `agent/orchestrator.js`** exactly like the `ENABLE_COIL_LIVE_HALT` flags landed in the live-funding branch: only the bot whose resolved `strategyId` is `mean-rev-rsi2-live` receives `'true'`; every other bot gets an explicit `'false'` so none inherits a shared-`.env` value. Extend `agent/coil-halt-flags.js`'s shape (which already scopes `ENABLE_COIL_LIVE_HALT`) rather than inventing a new module.
- Documented in `.env.example` and `docs/runbooks/coil-live-funding.md`.

---

## Components & interfaces

| Unit | File | Responsibility |
|---|---|---|
| `findOrphans` (unchanged) | `services/position_manager.go:1432` | Pure orphan detection — the single source of truth |
| Auto-flatten step | `services/position_manager.go` (new, in the reconcile path) | Streak/latch state machine + guarded `ClosePosition` call; long-only; dedicated-account + market-open + fresh-re-read gates; audit note on success |
| `OrphanStatus()` | `services/position_manager.go` (new method) | Read-only snapshot under `pm.mu`: orphan set + auto-flatten state |
| `OrphanController` | `controllers/orphan_controller.go` (new) | `GET /api/v1/orphans/status` |
| Config flags | `config/config.go` | `EnableOrphanAutoFlatten`, `OrphanAutoFlattenAccountIsDedicated`, `OrphanAutoFlattenStreak` |
| Wiring | `cmd/bot/main.go` | Inject the two gates + streak + `marketIsOpen` into the PM; register the controller/route; startup log if enabled-but-not-affirmed |
| Flag scoping | `agent/orchestrator.js`, `agent/coil-halt-flags.js` | Per-bot `ENABLE_COIL_ORPHAN_AUTOFLATTEN` + `ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED` |
| Node poller + `/api/orphans` | `agent/server.js` (new sweep) | Poll `/api/v1/orphans/status`, aggregate, expose for the dashboard |
| Slack orphan events | `agent/server.js` (`notifyOn` + `notifySlack`) | `orphanDetected` / `orphanFlattened` / `orphanFlattenFailed`, dedup once-per-symbol |
| Scope-note fix | `agent/trade-reconciliation.js:135` | Stop claiming closes are unverified |

## Testing

Go, using the existing orphan-test fakes (`reconcileStubTrading{stubTrading, positions}` in `services/position_manager_orphan_test.go`), extended with a `ClosePosition` seam that records calls and can be made to fail:

- Streak counts correctly; fires at 3, does **not** fire at 2.
- One attempt then latch: after a fire, no second `ClosePosition` for that symbol on subsequent passes.
- Failure → latch → never retried within the process (assert exactly one `ClosePosition` call across many passes).
- Success → the symbol leaves the orphan set → streak + latch cleared; **an audit note is appended to the terminal record and persisted.**
- **Catastrophic case:** a symbol with a live (non-terminal) record is NEVER passed to `ClosePosition`; a symbol that gains a live record mid-streak has its streak cleared.
- **Dedicated-account gate:** enabled but NOT affirmed dedicated → zero `ClosePosition` calls (and the startup refusal is logged); enabled AND affirmed → fires normally.
- **Long-only:** a short orphan (qty < 0) is alerted but NEVER passed to `ClosePosition`.
- **Restart re-attempt:** a fresh PM instance (simulating restart) with the orphan still present re-accrues the streak and re-fires — pinning the in-memory/reset behavior as intended, not accidental.
- Fresh re-read fails → no `ClosePosition` call.
- Market closed (`marketIsOpen` returns false) → no `ClosePosition` call; streak preserved.
- Flag off → detection + `OrphanStatus()` still populated, zero `ClosePosition` calls.
- `OrphanStatus()` returns the expected orphan set + state shape (snapshot correctness).

Node (`node:test`):
- The new poller surfaces a non-empty orphan set (mock `goAxios` returning an orphan) and exposes it via `/api/orphans`.
- **Alert dedup:** a persistent orphan across multiple polls fires the Slack/`operator_review_required` alert **once**, not once per poll; a resolved-then-recurring orphan re-alerts.
- The Slack `notifyOn` gate: with the orphan event disabled, no push; enabled, one push.
- The `SCOPE_NOTE` no longer claims closes are unverified (assert the new text; assert it references the orphan endpoint).

## Build order

Layer A before Layer B (auto-flatten's alerts depend on the surfacing being in place). One implementation plan, ordered tasks.

## Open risks accepted

| Risk | Status |
|---|---|
| **Auto-flatten sells another agent's live position (shared account)** | **Closed by the dedicated-account precondition** (both gates required, fails closed when un-affirmed). The live Coil account is dedicated by construction. This is the central boundary; it is NOT code-enforceable (a bot cannot see other bots' ledgers), so it is an operator affirmation + runbook constraint. |
| Auto-flatten fires on this bot's own false orphan | Mitigated by structural exclusion in `findOrphans` (live record wins) + 3-pass streak + fresh re-read + long-only; each is tested |
| A failed flatten strands the position | Accepted — one attempt then latch + loud alert; operator resolves. Matches the −15% halt's "don't loop on a real-money action" philosophy |
| Auto-flatten realizes P&L the ledger already booked | Accepted + traced — the terminal record was booked at the (phantom) close price; the market flatten realizes a *different* price, so a small real-money delta is uncaptured by segment P&L. Bounded (~a few $ on a $600 position at $5k); an audit note records the actual fill for later reconciliation. Flagged for the Foundation B measurement layer. |
| An orphan detected near/after the close | Accepted — cannot be market-flattened until the next open (market-open gate), so it sits exposed overnight; Layer A still alerts immediately so the operator can act manually. |
| No push alert channel | **Void — a Slack channel exists** (`notifySlack`/`notifyOn`); this spec adds orphan events to it. |
