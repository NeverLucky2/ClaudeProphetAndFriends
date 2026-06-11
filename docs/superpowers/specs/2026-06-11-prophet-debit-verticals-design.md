# Prophet Debit Verticals — Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming) — pending implementation plan
**Owner:** Prophet (default agent)

## 1. Context & goal

Prophet (the LLM options agent) currently trades **single-leg** options only. This feature adds **debit vertical spreads** (call-debit for bullish, put-debit for bearish) as an additional capability.

The primary purpose is **educational**, not alpha. Prophet is kept deliberately as a low-priority "toy." The goals are:

1. Let the agent make the *best* options decision with a fuller toolbox — including choosing a defined-risk vertical over a naked single-leg when implied volatility is rich (the structural lesson: buying naked premium into high IV is a poor default).
2. Make the failure modes of long-premium options **visible** on paper — especially the "right on direction and still lost money" outcome — so the operator can watch first-hand why long-options trading is not a sustainable income method.

Debit verticals are the correct structure for this: max loss is bounded by the debit paid, so a losing trade shows up as a controlled, studyable bleed rather than a catastrophic naked-short blow-up.

## 2. Decisions (settled in brainstorming)

| # | Decision | Choice |
|---|---|---|
| 1 | Decision model | **Hybrid** — the LLM owns the thesis (underlying, direction, expiry, rough target/width); a deterministic helper snaps to real, liquid, tradable strikes and validates. |
| 2 | Relationship to single-legs | **Augment** — keep single-leg buying; add verticals; the LLM chooses structure per trade. |
| 3 | Instrumentation | **Decision card at entry + P&L attribution at exit** (direction vs theta vs IV). |
| 4 | Exit ownership | **LLM-managed exits + deterministic backstops** the LLM cannot override. |
| 5 | Lifecycle robustness | Extend the already-proven **fail-closed** close pattern to the options/multi-leg path (the equity `CloseManagedPosition` fail-open orphan bug is already fixed on main — commits `799ca35`→`e65201c`→`27b4e79` + orphan detector `232ac0f`). |

## 3. Architecture & components

A new **`prophet_vertical_*` Go quartet**, mirroring the proven `prophet_hedge_*` (DefensiveProphet) engine but **LLM-driven** instead of scheduler-driven, and generalized from put-only to call- and put-debit verticals.

| File | Kind | Responsibility |
|---|---|---|
| `services/prophet_vertical_structure.go` | pure | Strike-snapper: generalize `pickPutStrikes` to snap a long-leg moneyness + target width to real listed call/put strikes (return `ok=false` if no genuine debit spread exists — never half-build). Reuse `marketableLimitCapped` for the net-debit limit. Compute max-loss / max-gain / breakeven. |
| `services/prophet_vertical_lifecycle.go` | pure | Exit/backstop decision functions: `shouldTakeProfit`, `shouldStopLoss` (salvage floor), `shouldForceCloseBeforeExpiry` (DTE backstop), assignment-defense (analog of `shouldCloseITMShort`). |
| `services/prophet_vertical_executor.go` | I/O | Place via `mleg` (debit limit), register in ledger, manage on tick, **fail-closed close**. |
| `services/prophet_vertical_ledger.go` + `models.DBProphetVertical` | I/O | Persist the spread + decision card + exit-attribution fields. |

**Four thin MCP tools** (proxying new `OrderController` endpoints):
- `propose_debit_vertical` — read-only; returns the snapped structure + entry decision card.
- `place_debit_vertical` — confirm + submit.
- `list_debit_verticals` — open verticals with live value, P&L, DTE, backstop status, the card.
- `close_debit_vertical` — LLM-initiated close.

**Reused as-is:** `mleg.go` (execution), the trade guard's `CheckOptionsOpen` (universe/spread gate), the options-chain fetch, an IV snapshot from `alpaca_options_data`, and the hedge pricing helpers (`marketableLimitCapped`). The LLM keeps its existing single-leg `place_options_order`.

**Not touched:** the equity `PositionManager`. Verticals live in their own ledger/lifecycle, exactly as the hedge spreads do.

**Flag:** everything ships **default-OFF behind `ENABLE_PROPHET_DEBIT_VERTICALS`**, paper-first. Off ⇒ tools unregistered / endpoints reject ⇒ zero behavior change.

## 4. Data flow

1. **Propose** *(read-only)* — LLM calls `propose_debit_vertical(underlying, direction, expiry, target width)`. Go fetches the chain → snaps strikes → dry-run guard check → prices the net debit (1 contract) → takes an **entry IV snapshot** → **persists a short-lived proposal record** (proposal ID + TTL + the exact snapped OCC legs + quoted net debit + entry snapshot) → returns the proposal ID + structure + decision card. No order placed.
2. **Place** — LLM calls `place_debit_vertical(proposal_id)`. Go loads the proposal and **re-prices the exact stored OCC legs — it never re-derives the structure** — and **rejects** if the proposal aged past its TTL or the net debit drifted beyond tolerance (re-validation is a *check*, not a re-derivation; this protects the attribution data, since the card must describe the trade that was actually placed). On pass: re-runs the guard, builds the `MultiLegOrder` (long `buy_to_open` + short `sell_to_open`, debit limit, strategy-tagged) from the stored legs, submits via `mleg`, persists `DBProphetVertical` (`OPEN`) with card + entry snapshot, and writes `DBOrder` rows for audit.
3. **Manage** *(each tick)* — lifecycle fetches current spread value + spot + IV. The LLM may close on its beat; the deterministic backstops fire regardless.
4. **Close** *(fail-closed)* — atomic `mleg` combo (`buy_to_close` short + `sell_to_close` long). Mark `CLOSED` **only after the broker confirms both legs flat**; a leg mismatch raises an orphan alert.
5. **Attribute** — on confirmed close, take an **exit IV snapshot** and decompose realized P&L into direction / theta / IV; write to ledger/card.

## 5. Guardrails, lifecycle & fail-closed exit

**Entry guardrails** (all must pass; no parallel uncapped path):
- **Universe gate** — underlying ∈ `config/prophet_tradable_universe.txt`.
- **Spread/liquidity gate on *both* legs** — run `CheckOptionsOpen` per opening leg. *(Verified 2026-06-11: `CheckOptionsOpen` is side-agnostic and stateless — universe allowlist + bid/ask-width check, no buy-specific branch, no per-symbol mutation — so per-leg reuse on the `sell_to_open` short leg is safe, and the short-leg liquidity check is exactly what we want. It gates universe + liquidity ONLY, not exposure.)*
- **Size = 1 contract per vertical (v1)** — cleaner attribution, smaller numbers, simpler snapper/tests; reject the proposal if even one contract's net debit exceeds the per-vertical debit cap.
- **Exposure accounting rule** — a vertical's dollar-risk = **net debit = max loss** (used for the per-vertical debit cap and the per-trade notional cap). The delta-adjusted **sector**-exposure provider receives **both legs**, so their deltas net naturally (a spread's net delta < a single leg's). Reuse the existing Prophet sleeve guard + hard caps ([[risk-enforcement-pr-status]]); confirm the sleeve guard's options dollar cap uses net debit, not gross per-leg premium (§10).
- **Structure validity** — `structure.go` returns `ok=false` (skip, never half-build) when no genuine debit spread exists at snapped strikes.

**Deterministic backstops** (fire regardless of the LLM; **precedence: salvage stop → profit-capture → force-close** as the catch-all):
- **Salvage stop** — close early when residual value ≤ a floor.
- **Profit-capture / assignment-avoidance** (renamed from "assignment defense") — a short leg going ITM in a debit vertical means the spread is *winning* (the long leg is deeper ITM by construction), so this **captures the win and sidesteps assignment mechanics — it is not loss defense**, and the card must label a fired instance as a capture, not a failure. **Watch dividend-driven early assignment on short ITM calls** → close before ex-dividend.
- **Force-close before expiry** at DTE ≤ N (default 2 trading days). **Worthless-spread carve-out (for clean attribution):** if the **entire spread is OTM (both legs)** AND residual ≤ expected exit cost, let it **expire** rather than pay a bid/ask round-trip to close ~zero risk. The carve-out requires *both* legs OTM, not just the short leg — if the long leg is ITM, letting it ride auto-exercises into shares at expiry, the exact mess to avoid.
- **Roll frequency** — the LLM may close and re-propose further out; v1 does **not** cap roll count (YAGNI): every roll pays full friction, counts against the sleeve cap, and shows in the tally, so churn is self-evident (and itself an educational signal).

**Fail-closed exit:**
- Exit as an atomic `mleg` combo with a marketable limit.
- Mark `CLOSED` **only after both legs confirmed flat** (poll, analogous to the equity settle-wait).
- On partial/failed close: stay `OPEN`/`EXIT_FAILED`, **never** `CLOSED`; log `operator_review_required`; raise a leg-mismatch orphan alert (reusing the `232ac0f` detector concept). Double-close is an idempotent no-op.

**Coordination:** exclude vertical-owned legs from `prophet_options_stop_monitor.go` (single-leg stop monitor) by strategy tag, so the two don't fight over the same contracts.

## 6. Instrumentation: decision card + exit attribution

**Entry decision card** (on `DBProphetVertical`): underlying, direction, both legs (OCC + strikes), expiry/DTE; structure choice + the IV context that justified vertical-over-single (entry IV snapshot, IV-rank if available) + the LLM's thesis text; economics (net debit, max loss, max gain, breakeven, reward:risk); entry snapshot (per-leg IV, spot, time-to-expiry).

**Exit attribution** — pure, testable `attributeVerticalPnl(entrySnap, exitSnap) → {direction, theta, iv, residual}` via a small **Black-Scholes reprice walk** of the two legs:

| Step | Reprice | Captures |
|---|---|---|
| 0 | V(spot₀, IV₀, t₀) = entry debit | baseline |
| 1 | V(spot₀, IV₀, t₁) − step 0 | **theta** |
| 2 | V(spot₁, IV₀, t₁) − step 1 | **direction** |
| 3 | V(spot₁, IV₁, t₁) − step 2 | **IV** |

Components sum to the modeled total; reconcile to the **realized fill P&L** and book the difference as `residual`. A closed trade then reads: *"−$140: −$60 direction, −$35 theta, −$45 IV crush."*

**Honesty caveat (baked into the card):** Black-Scholes is an *instructional approximation* for American-style equity options, and IV snapshots carry noise. The realized fill P&L is the truth; the decomposition is an explanatory model reconciled to it, not a P&L audit. **Components are attributed in a fixed sequential order (theta → direction → IV); cross-effects are booked to the *later* step** — gamma (spot-move × time interaction) lands in `direction`, and the vega-spot interaction (net vega shrinks/flips as spot crosses between the strikes — not small for a vertical near the short strike) lands in `IV`. `residual` reconciles the model to realized P&L but does not isolate these cross-terms. Read "−$45 IV" as "≤ ~$45, with some gamma/vega-spot bleed," not a precise vega P&L.

**Apply attribution to single-legs too — the comparison is the point.** Goal #2 ("right on direction, still lost to theta/IV") lives on the **single-leg** sleeve, which verticals deliberately *mitigate* (bounded debit, reduced net vega). So the attribution engine is a **structure-agnostic shared service** that also runs on **single-leg closes**, and the sleeve tally **compares** single-leg vs vertical outcomes. (The full decision *card* stays vertical-only.) Cost note: single-legs aren't tracked with entry state today, so this needs a persisted **single-leg entry-IV snapshot at open + a close-attribution hook** — modestly more than "two snapshots," but without it the tally answers "are verticals sustainable income" (nobody asked) instead of demonstrating "naked premium into high IV is a poor default."

**Surfacing** (within "card + attribution," not a full dashboard): written to the ledger + per-trade JSON, emitted to the activity log, available via `list_debit_verticals`, feedable to `trade-grader`/reasoning-digest. The running **sleeve tally** (cumulative P&L, win rate, lost-to-theta + lost-to-IV, **single-leg vs vertical**) is the "is this sustainable income?" signal.

**Pre-registered expectation (locked before the first trade):** *long-premium options carry negative expectancy net of spreads over a meaningful N; a positive result at small N is noise, not edge.* Recorded up front so a lucky early run can't retro-fit the opposite lesson.

## 7. Testing

- **Pure functions — exhaustive unit tests (TDD):** strike-snapper (call & put, `ok=false` cases, width selection), lifecycle rules (take-profit, salvage stop, force-close-before-expiry, assignment-defense), debit cap/sizing, BS pricer + `attributeVerticalPnl`. **Headline test:** a pure-IV-crush case where `direction ≈ 0` yet the trade loses — attribution must book it to `iv`, and components must reconcile to realized P&L.
- **Executor / I/O with mocks** (mirror hedge-executor + `position_manager_close` tests): inject `PlaceMultiLegOrderFn` + broker reads. **Non-negotiable:** the fail-closed close — combo confirmed → `CLOSED`; partial/failed → stays `OPEN` + orphan alert, **never** `CLOSED` (test the executor, not just the predicate).
- **Guard integration:** per-leg `CheckOptionsOpen`, universe rejection, debit-cap rejection, and a **vertical + single-leg together breaching the exposure ceiling** (net-debit accounting).
- **Identity contract:** a **stale/drifted-proposal rejection** test — `place` rejects when the proposal aged past TTL or the net debit drifted beyond tolerance.
- **Single-leg attribution:** the structure-agnostic engine runs on a single-leg close and books theta/IV correctly.
- **JS proxies:** light `node:test` coverage.

## 8. Rollout

- **Default-OFF `ENABLE_PROPHET_DEBIT_VERTICALS`.**
- **New `DBProphetVertical` table** via the existing versioned-migration mechanism.
- **Paper-first**, single paper sandbox.
- **Deploy** = rebuild Go bot + restart Node, from local `main`.
- **Verification gate before "done":** a live paper smoke test of a full **propose → place → manage → close → attribute** cycle.

## 9. Out of scope (YAGNI)

Credit spreads; calendars/diagonals; >2 legs; the full teaching dashboard; real-money sizing automation; orphan **auto**-close (the `ENABLE_ORPHAN_AUTOCLOSE` seam stays future); **multi-contract sizing** (v1 = 1 contract); an explicit **roll-count cap** (v1 leaves rolls uncapped, friction-taxed + visible). Strike-snapper v1 is simple nearest-strike; regime/IV-conditional widths are a future drop-in (like the hedge engine's `selectStructure`). One underlying per vertical.

## 10. To verify / settle during planning

- Confirm the `prophet_hedge_executor.go` close path's exact failure handling, to decide reuse-vs-extend for the vertical close.
- `mleg.MultiLegOrder.LimitPrice` is documented as a net **credit** (positive = receive); a debit vertical submits a net **debit** — settle the sign convention.
- **Confirm the Prophet sleeve guard's options dollar cap uses net debit (= max loss), not gross per-leg premium.** (The sector-exposure provider already nets via delta; `CheckOptionsOpen` was verified side-agnostic on 2026-06-11 and is no longer open.)
- **Defaults to lock (pre-registered knobs):** size = **1 contract/vertical**; proposal **TTL** + net-debit **drift tolerance**; per-vertical **debit cap**; backstop **DTE** (default 2); **salvage floor**; worthless-spread **carve-out threshold**.
- Whether IV-rank/percentile is readily available from `alpaca_options_data` for the card (degrade gracefully if not).
