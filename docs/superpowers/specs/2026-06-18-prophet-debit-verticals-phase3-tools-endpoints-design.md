# Prophet debit verticals — Phase 3 (LLM tools + endpoints + proposal identity contract)

- **Date:** 2026-06-18 (revised after an adversarial fresh-context review)
- **Status:** Design approved (awaiting spec re-review)
- **Component:** Go `OrderController` + new `services/prophet_vertical_proposals.go`; Node `mcp-server.js` + `agent/tool-allowlists.js` + `agent/harness.js`; `cmd/bot/main.go` wiring
- **Flag:** `ENABLE_PROPHET_DEBIT_VERTICALS` (default OFF — already exists from Phase 2)
- **Related:** [[prophet-debit-verticals]] (master design + Phases 1–2), `docs/superpowers/specs/2026-06-11-prophet-debit-verticals-design.md` (§§39–130), the Phase 2 spec, [[prophet-options-stop-ownership-scoping]] (stop-monitor exclusion, prerequisite, landed), [[fun-sleeve-budget-killswitch]] (the sleeve guard this phase wires into).

## Problem / goal

Phases 1 (pure core) and 2 (executor + ledger + scheduler) are built and **dormant** on local `main`: flag OFF, and even ON the scheduler only manages an empty ledger because **no open path exists**. Phase 3 adds the layer that lets Prophet's LLM propose, place, watch, and close defined-risk debit verticals — preserving the entry decision card's honesty against the eventual fill (the **propose→place identity contract**: `place` submits the exact strikes `propose` snapped, never a re-derived structure).

## Non-goals

- **Phase 4** (single-leg entry-IV snapshot + close hook, and the single-leg-vs-vertical sleeve tally) — separate follow-on cycle.
- **No changes to `executor.Place`** (Phase 2). It already fail-closed re-fetches quotes, re-prices the net debit capped at width, runs the **per-leg** `CheckOptionsOpen` + debit cap, and submits the mleg combo. Phase 3 wraps it and adds the **account-level** opening guards around it (see Guard parity), exactly as the single-leg controller path does — it does not modify the executor.
- Single **1 contract/vertical**. No multi-contract sizing, no new dashboard (`list` is the surfacing).

## Architecture — three thin layers

Mirrors Prophet's existing single-leg options path (Node MCP tool → Go controller endpoint → service), with the gating/wiring corrected to the real mechanisms.

**1. Node — 4 MCP tools, defined inline in `mcp-server.js`** (a tool entry in the `ListToolsRequestSchema` array + a case in the call-handler `switch`), each a thin HTTP proxy to a Go endpoint. Two registration facts the review surfaced:
- The 4 names must be added to `ALL_TOOLS` in `agent/tool-allowlists.js` — `tool-allowlists.test.mjs` asserts `ALL_TOOLS` exactly matches the server catalog, so omitting them fails CI.
- **Gating = hide-when-off (chosen).** There is no env-flag→tool mechanism today; the allowlist is strategy-based (`resolveAllowedTools`). So `harness.js` gains a read of `process.env.ENABLE_PROPHET_DEBIT_VERTICALS` and only appends the 4 tool names to Prophet's (`v2-options`) resolved allowlist when ON. OFF ⇒ the tools are absent from the catalog the LLM sees ⇒ zero token cost, nothing callable. (The Go endpoints still reject when OFF as defense-in-depth.)

**2. Go — 4 `OrderController` endpoints** (`propose`/`place`/`list`/`close` for verticals), registered near the existing options routes. The controller gains an `enableVerticals bool` field plus references to the vertical executor, ledger, and proposal store (injected from `main.go`). Endpoints reject with 4xx when `enableVerticals` is false.

**3. Go — new `services/prophet_vertical_proposals.go`**: the in-memory TTL proposal store + the propose/place glue, plus an exported list-enrichment method. Reuses Phase 1 (strike-snapper, pricer) and Phase 2 (`executor.Place`, `executor.RequestClose`, `ledger.ListOpen`/`GetByID`, and the unexported valuation helpers via a new exported method — see I2 fix).

## Wiring (`cmd/bot/main.go`)

Today the `verticalExecutor` + `verticalLedger` are constructed **inside** the `if cfg.EnableProphetDebitVerticals` block and handed only to the scheduler. To let the endpoints reach them: construct the executor, ledger, and the new proposal store **unconditionally** (cheap, inert objects), build them into both the scheduler (as today, still flag-gated to *run*) and the `OrderController` (via constructor arg or a `SetVerticals(executor, ledger, store, enabled)` setter, mirroring the existing `SetGuard`/`SetSleeveGuard` injection idiom), passing `cfg.EnableProphetDebitVerticals` as the `enableVerticals` flag. The scheduler still only ticks when the flag is ON; the endpoints still reject when OFF.

## The proposal record + in-memory TTL store

```
proposalId   string
expiresAt    time.Time              // now + verticalProposalTTL
req          PlaceVerticalRequest   // Underlying, Expiration, Direction, Long/Short Symbol+Strike — the exact OCC legs
quotedDebit  float64                // net debit priced at propose (per-contract, Alpaca-positive); guaranteed > 0 (propose rejects non-positive before storing)
entrySnap    {long, short *interfaces.OptionContract}  // propose-time IV + greeks + bid/ask
```

Mutex-guarded `map[string]*proposal`. **Expiry: lazy on access AND a sweep at the top of every `propose`** (bounds retention of never-placed proposals — the review noted lazy-only would leak them for the process lifetime). No DB table (proposals are ephemeral; Phase 2 dropped session state). **Restart between propose and place ⇒ proposal gone ⇒ `place` rejects "not found" ⇒ LLM re-proposes** (the in-memory tradeoff, chosen).

## The four operations

**`propose_debit_vertical(underlying, direction, expiry, target_width)` — read-only.**
Fetch chain (`GetOptionsChain` → `[]*OptionContract`) → **convert to `map[string]*OptionContract` keyed by OCC symbol** (the snapper takes a map) → snap strikes (Phase 1) → dry-run `CheckOptionsOpen` per leg (verified stateless) → price 1-contract net debit (`verticalDebitLimit` on propose quotes) → **reject non-positive debit and cap breach now** (mirror `executor.Place`, so `quotedDebit > 0` is guaranteed before storing) → capture entry snapshot → store → return `{proposalId, structure, decisionCard}`. No order; a rejected propose stores nothing. A chain-fetch 429 (`RateLimitedError`) surfaces as a 429 from the endpoint.

**`place_debit_vertical(proposal_id)` — submit (controller orchestrates the account-level guards, mirroring the single-leg path).**
1. Look up; reject if missing/expired (TTL).
2. Re-price the **stored** legs (fresh quotes); reject if `|fresh − quotedDebit| / quotedDebit > verticalDebitDriftTolerance`, reporting both numbers.
3. From the fresh debit, compute net-debit notional, then run the **same opening guards single-legs get**: `guard.CheckBuy(agent, …, notional)` (daily-loss breaker + dollar/sector caps) and, if set, `sleeveGuard.EvaluateOpen(notional, now)` (loss-budget disarm + manual kill + deadline + PDT). Reject on either.
4. `executor.Place(ctx, proposal.req, now)` — independently re-prices the **same stored legs**, re-runs per-leg `CheckOptionsOpen` + debit cap, submits fail-closed. **`place` never calls the strike-snapper** — the identity contract, enforced because it only ever passes `proposal.req`.
5. On success, **fire an immediate manage-tick** (`RunManageTick`) so the new open is reconciled without waiting up to `verticalTickInterval` (5 min). Return the vertical id / fail-closed error.

> Multi-fetch note (accepted): propose, the drift check, and `executor.Place` each fetch quotes — three reads across propose→place, two inside `place` ms apart. The price actually submitted is `executor.Place`'s; the drift number shown to the LLM is from step 2's fetch and can differ slightly. Acceptable; the drift gate is advisory-before-submit.

**`list_debit_verticals` — read-only.** Calls a **new exported** `ListOpenVerticalsEnriched(ctx)` (on the executor or store) that owns the assembly: `ledger.ListOpen()` + live value / unrealized P&L / DTE / backstop status (using the existing unexported `verticalValue`/`verticalDTE`, which are in-package) + the stored entry card. The controller (package `controllers`) calls this method rather than reaching unexported helpers.

**`close_debit_vertical(vertical_id)`.** `executor.RequestClose(ctx, id)` (Phase 2 marks the row; the two-phase fail-closed close runs on a tick), then **fire an immediate manage-tick** so the close submits promptly. Return accepted/error.

## Guard parity (I3 — chosen: add now)

`executor.Place` enforces only per-leg `CheckOptionsOpen` + the per-vertical debit cap. The single-leg open path additionally enforces `guard.CheckBuy` (daily-loss breaker + caps, `order_controller.go:644`) and `sleeveGuard.EvaluateOpen` (live real-money loss-budget/kill-switch, `:664-670`). Phase 3 closes this asymmetry by running both in the `place` endpoint (step 3 above) on the net-debit notional, **before** `executor.Place`. The per-leg `CheckOptionsOpen` stays inside the executor (it has the leg quotes); the account-level guards live at the endpoint (they need only the notional) — the same split of responsibilities the single-leg path uses.

## Decision card (returned by propose, stored, echoed by list)

Direction; underlying; expiration/DTE; long & short OCC symbols + strikes; width; **net debit = max loss** ($ and per-contract); **breakeven**; max profit (= width − debit); per-leg **entry IV** + greeks + bid/ask; IV-rank if available (degrade gracefully — the paper feed may zero IV). Labeled an instructional approximation.

## Error handling

- **Flag OFF:** tools absent from the LLM's catalog (harness) + endpoints 4xx ⇒ zero behavior change, zero token cost.
- **Expired/missing proposal:** explicit "proposal expired or not found — re-propose."
- **Debit drift:** reject with quoted vs fresh (an **attribution-fidelity** gate — it intentionally rejects *favorable* drift too, because the card must match the placed trade; it is not a risk gate).
- **Account-guard rejection** (`CheckBuy`/`EvaluateOpen`): surfaced verbatim (no order).
- **Per-leg guard / non-positive debit / cap breach:** surfaced from `executor.Place` (fail-closed).
- **Chain/quote unavailable at propose:** clear error, nothing stored; 429 surfaced as 429.

## Knob defaults (compile-time, in `prophet_vertical_constants.go`)

- `verticalProposalTTL = 3 * time.Minute`
- `verticalDebitDriftTolerance = 0.15` (15% of quoted debit) — **flag for smoke-test tuning**: on a small per-contract debit ($0.40 ⇒ $0.06/share) and with the bid/ask buffer term in `marketableLimit`, ordinary requote noise could bounce this; validate against real paper requotes and loosen if it over-rejects.

## Testing (TDD)

Identity contract (headline): `place` rejects past-TTL; `place` rejects debit-drift (reports quoted vs fresh); `place` submits the **exact stored** `PlaceVerticalRequest` to a fake executor and the **snapper is never called** during place; `propose` stores a complete record + returns a card, and a doomed propose (non-positive/cap/no-chain) stores nothing.

Guard parity: `place` rejects when `CheckBuy` trips (daily-loss) and when `sleeveGuard.EvaluateOpen` trips (loss-budget/kill) — before any order.

Store: TTL expiry, sweep-on-propose bounds retention, concurrent access.

Wiring/gating: Node — the 4 tools are **absent** from Prophet's resolved allowlist when `ENABLE_PROPHET_DEBIT_VERTICALS` is unset and **present** when set (`harness` test); `ALL_TOOLS` matches the catalog (existing CI test extended). Go — endpoint flag-off rejection; input validation; JSON shape; `list` enrichment; immediate-tick fired on place/close.

## File structure

- **Create** `services/prophet_vertical_proposals.go` (store + `ProposeVertical`/`PlaceProposedVertical` glue) + `…_test.go`. Add `ListOpenVerticalsEnriched` (here or on the executor).
- **Modify** `controllers/order_controller.go` — 4 endpoints + `enableVerticals` field + vertical deps; handler tests.
- **Modify** `cmd/bot/main.go` — construct executor/ledger/store unconditionally, inject into controller + scheduler.
- **Modify** `services/prophet_vertical_constants.go` — 2 new knobs.
- **Modify** `mcp-server.js` (4 inline tools), `agent/tool-allowlists.js` (`ALL_TOOLS`), `agent/harness.js` (flag-read append); `.test.mjs` for tool list + gating.

## Verification items for planning

1. Confirm the Node harness process actually sees `process.env.ENABLE_PROPHET_DEBIT_VERTICALS` (same env as the Go bot; if the Node side loads its own `.env`, ensure the var is there).
2. Exact `OrderController` constructor/setter idiom for injecting the vertical deps + flag (mirror `SetGuard`/`SetSleeveGuard`); exact route-registration site.
3. Phase-1 snapper input shape + key (`map[string]*OptionContract`) and `verticalDebitLimit` signature; the chain entry point (`GetOptionsChain`) and its 429 surfacing.
4. `CheckBuy` notional semantics for an options open (the single-leg path passes `optionsNotional(order, quote)`; the vertical passes net-debit×100×contracts — confirm units match what `CheckBuy`/`EvaluateOpen` expect).
5. Whether `interfaces.OptionContract` from the chain reliably carries IV + greeks for the entry snapshot (degrade gracefully if absent).
6. `RunManageTick` is safe to call ad-hoc from an endpoint (concurrent with the scheduler's own ticks — confirm it's idempotent / guarded, else the immediate-tick needs the scheduler's lock).
