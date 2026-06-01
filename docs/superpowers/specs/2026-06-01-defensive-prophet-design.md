# Defensive-Prophet — Triggered, Defined-Risk QQQ Put-Spread Hedge

**Status:** design approved 2026-06-01, pre-implementation
**Strategy tag:** `prophet-defensive`
**Flag:** `ENABLE_PROPHET_DEFENSIVE` (default OFF)
**Pivot context:** the second and final repurpose of the uncorrelated-ballast pivot (sibling = Turtle-v2, shipped). See memory `fleet-uncorrelated-ballast-pivot`, `foundation-measurement-lifecycle-status`, `turtle-v2-broaden-basket-project`.

---

## 1. Purpose & scope

A flag-gated, default-OFF **Go backend executor** that buys triggered, defined-risk **QQQ put-debit-spreads** as a **capped correction hedge** for the user's concentrated, *external* mega-cap-tech book (held at Merrill, separate from the Alpaca paper account — no cross-broker hedge is possible, so we hedge a **QQQ proxy**).

**Framing honesty (per review T3.2):** the v1 long-~5%/short-~15%-OTM structure pays across a **5–15% correction and *caps* at the 15% level** — it is a cheap-carry *correction* hedge, **not deep-tail insurance**. A −25%/−35% crash (the scenario a concentrated tech book most fears) hits the cap and pays nothing beyond. This is a deliberate carry tradeoff; v1 grading **will show the payoff cap on any large event**. Uncapped deep-tail convexity is the job of the deferred long-vol sleeve (VIXM/VXZ) and the v2 `selectStructure` seam (§10) — not v1.

The reframe that makes this worth building: Prophet's only plausible edge is **defense-timing** (*when* to buy protection), not directional alpha — an insurance-buyer, not a coin-flip long-call gambler. It is graded on **tail contribution** (P&L conditional on a tech drawdown), **not** standalone P&L.

**In scope:** mechanical arm/disarm, fixed defined-risk put-spread structuring & placement, active lifecycle management (harvest / roll / expire), sizing, risk-guard routing, and the measurement wiring into Foundation B's ballast graduation track.

**Out of scope (deferred, designed-in seams only):** regime/IV-conditional structure selection; the LLM catalyst-acceleration layer; long-vol ETF sleeve (VIXM/VXZ); SPY/broad-market coverage. See §10.

**Hard constraint:** additive only. **Does NOT touch the existing discretionary long-call Prophet ("Prophet-toy")**, which remains an ungraded paper plaything.

---

## 2. Grounded findings (verified against code 2026-06-01)

The build is plumbing-complete; this is assembly, not greenfield.

- **The mechanical trigger already exists as a backend signal.** `scripts/compute_daily_regime_score.py` consolidates breadth + macro-regime + **market-top** + bubble into one 0–100 score written daily to `data/reports/regime_gate.json`:
  `score = 0.35·breadth + 0.30·(100−macro) + 0.20·(100−top) + 0.15·(100−bubble)` — **low score = bad regime.**
  `services/regime_gate_service.go::GetStatus()` reads it and maps to tiers: RED `<20` / DEFENSIVE `<40` / NORMAL `<70` / GREEN `≥70`, plus `IsStale` and a fail-soft `Tier=UNKNOWN` (with `Score=0`) when the file is missing/unparseable. The Turtle executor already consumes it via `regimeGate.GetStatus()`. **Breadth and market-top are folded in — no new signal plumbing.** The hedge's trigger is the *inverse* of Turtle's: Turtle cuts size when the score is low; the hedge **arms** when the score is low.
- **Multi-leg options placement exists.** `services/alpaca_trading.go::PlaceMultiLegOrder(ctx, MultiLegOrder)` posts an atomic `mleg` combo order; legs carry `Side` + `PositionIntent` (`buy_to_open`/`sell_to_open`/…); `LimitPrice` is net per-contract; the owning strategy is encoded into `client_order_id` as `"{strategy}:{uuid}"` so reconciliation recovers it from fills. `MultiLegOrder`/`MultiLegOrderLeg` live in `services/harvest_service.go:285`.
- **A defined-risk multi-leg lifecycle template exists.** Harvest (`harvest_service.go`, `harvest_exit_monitor.go`, `harvest_closer.go`) persists combos in a **dedicated table** `DBHarvestCondor` (multi-leg positions don't fit the single-symbol `managed_positions` model). Defensive-Prophet mirrors this with its own table.
- **OCC helpers exist.** `services/occ.go::ParseOCCUnderlying` / `IsOptionSymbol` (all-letter root assumption — fine for `QQQ`).
- **Options chain data exists.** `services/alpaca_options_data.go` (`GetOptionChain`, `GetOptionSnapshot`) for strike selection by % OTM + DTE window.
- **Risk enforcement exists.** `services/trade_guard.go` (options through-guard / spread gate) — reused as the pre-submit gate.
- **Segment-P&L grading exists, but strategy discovery is `managed_positions`-only.** `services/segment_pnl_writer.go::WriteDailyMarks` loops over `database/storage.go::ListManagedStrategies()` (DISTINCT non-empty `agent_strategy` on `managed_positions`) and writes one daily mark-to-market `DBSegmentPnL` row per strategy. Realized P&L is summed from closed `managed_positions`, with a **special-case** `if strat == "harvest"` adding closed-condor P&L. **Two gaps for defensive-Prophet** (D-DP9): (1) it writes to its *own* spread table, never `managed_positions`, so it would **not appear in `ListManagedStrategies()` at all** → the writer must be taught to include `prophet-defensive` in its per-day loop regardless; (2) it needs a realized-P&L special-case analogous to `harvest`.

---

## 3. Decided parameters (from the 2026-06-01 brainstorm)

| Knob | v1 value | Why / source |
|---|---|---|
| **Universe** | **QQQ only**, put debit spreads | Pre-decided: tightest mega-cap-tech match, deepest options, one carry stream, no discretion-reintroducing menu. |
| **Arm trigger** | regime `Score < 50` (RED + DEFENSIVE + lower-NORMAL) | Looser bar chosen to **maximize graded episodes during the paper phase** (`user-risk-philosophy-paper-phase`: prefer information). The arm threshold is the master carry/bleed knob. |
| **Disarm** | regime `Score ≥ 50` | Stops *opening* new spreads; does not force-close. |
| **Structure (v1, fixed)** | long put **~5% OTM**, short put **~15% OTM**, nearest monthly in **45–60 DTE** | Tail-targeted: convex payoff across a real 5–15% correction (the tail a concentrated tech book faces); short leg finances the long → low debit. |
| **Profit-harvest** | close at **≥ ~60% of max payoff** | "A hedge that pays should be harvested, not held hoping for more." Banks vol spikes. |
| **Roll** | at **DTE ≤ ~21** while armed → close + reopen | Keeps the live hedge in the 45–60 DTE band while the regime stays risk-off. |
| **Sizing** | net debit **≤ 1% of account / spread**, **max 3 concurrent** (≤ ~3% at risk at once) | Moderate / paper-phase-aggressive (`user-risk-philosophy`). **Tighten to 0.5% / max-2 for live money.** |
| **Max loss** | net debit (defined by construction) | No protective stop leg needed. |
| **Cadence** | once-daily backend beat | The regime score is daily; intraday catalyst response is the deferred LLM layer (§10). |

**Carry/bleed interaction (the central challenge):** looser arm (on more often) × per-spread debit = total carry. With the looser arm chosen, **small per-spread size is what keeps cumulative bleed bounded** over the observation quarter — and *bounded bleed* is the literal ballast-track graduation criterion (§7). The two knobs trade off; v1 accepts more carry deliberately for more paper-phase observations.

---

## 4. Architecture & components

A new dedicated Go executor modeled on `TurtleExecutor` (mechanical / defined-risk / daily-bar / backend-signal — the Coil/Turtle complexity ceiling). Rejected alternatives: extending `HarvestService` (Harvest is *short*-vol, the thesis-opposite — being paused in the pivot — and coupling them muddies grading); a Node/LLM agent beat (defeats the mechanical, deterministic, cheap, behavior-trap-free intent).

```
ProphetHedgeExecutor.RunHeartbeat(ctx, now)         (services/prophet_hedge_executor.go)
  ├─ preloopCheck            window + duplicate-heartbeat short-circuit   (Turtle pattern)
  ├─ reconcilePendingFills   pending mleg orders → open / failed          (Turtle pattern)
  ├─ armState = deriveArm(regimeGate.GetStatus())    §5 — UNKNOWN/stale ⇒ NOT armed
  ├─ manageOpenSpreads       harvest / roll / expire each open spread     §5
  └─ if armed && under caps && guard ok:
        profile = selectStructure(regime, iv)        v1 → fixed tail-targeted profile
        legs    = chooseStrikes(chain, profile)      §6
        PlaceMultiLegOrder(... Strategy="prophet-defensive")
        ledger.Save(pending_fill spread row)

Persistence:  DBProphetHedgeSpread  (new table; long+short put OCC symbols, debit,
              contracts, expiry, status, order IDs, regime_score_at_entry, max_payoff)
Session:      DBProphetHedgeSession (singleton: LastHeartbeatDate, ColdStart, breaker date)

Reused deps (interfaces, mockable):
  regimeGateFetcher   → RegimeGateService.GetStatus()
  optionsChainFetcher → AlpacaOptionsData.GetOptionChain / GetOptionSnapshot
  mlegPlacer          → AlpacaTradingService.PlaceMultiLegOrder
  guard               → TradeGuard (options through-guard / spread gate)
  account             → AlpacaTradingService.GetAccount (portfolio value for sizing)
  segment writer      → SegmentPnLWriter (grading; D-DP9 special-case)
```

**Pure, unit-testable functions** (no I/O — the core logic):
- `deriveArm(status RegimeGateStatus) (armed bool, reason string)` — §5.
- `selectStructure(regime RegimeGateStatus, iv float64) SpreadProfile` — v1 returns the fixed profile; the v2 seam.
- `chooseStrikes(chain, profile, spot) (longSym, shortSym string, debit float64, ok bool)` — §6.
- `sizeSpread(portfolio, debitPerContract float64) (contracts int)` — debit cap.
- `shouldHarvest(spread, markValue) bool`, `shouldRoll(spread, now) bool`, `shouldExpire(spread, now, armed) bool` — §5.

---

## 5. Trigger & lifecycle state machine

**Arm derivation (`deriveArm`) — correctness pin (D-DP1).**
`RegimeGateService.GetStatus()` returns `Score=0, Tier=UNKNOWN` when the regime file is missing/unparseable, and sets `IsStale` past the freshness window. A naive `Score < 50` test would therefore **arm on blind data** (0 < 50). Required logic:

```
armed = (status.Tier != "UNKNOWN") && (!status.IsStale) && (status.Score < 50)
```

- **UNKNOWN or stale ⇒ NOT armed** → do not *open* new spreads (don't bleed on blind data)…
- …but **never force-close** existing spreads on UNKNOWN/stale (if the data goes dark mid-crash, the hedge must stay on). Open spreads always ride their own harvest/roll/expire rules.

**Per-beat lifecycle of each OPEN spread (evaluated before opening anything new):**

| Condition | Action |
|---|---|
| current mark ≥ ~60% of max payoff | **harvest** — close to bank the spike |
| **short leg ITM near expiry** (DTE ≤ ~7 **and** QQQ ≤ short strike) | **close** — assignment defense (D-DP-T2.4); see note |
| DTE ≤ ~21 **and** armed | **roll** — close, then open a fresh spread this beat |
| DTE ≤ ~21 **and** disarmed | **let expire** (or close if near-worthless, to avoid pin/assignment risk) |
| else | hold |

Max loss is the net debit (defined); there is no separate catastrophe stop.

**Assignment defense (review T2.4).** QQQ ETF options are American-style; a deep-ITM short put can be assigned early, leaving the paper account long QQQ shares and distorting the segment P&L the grade depends on. The harvest rule **preempts most cases** — the short leg is the *lower / more-OTM* strike, so by the time QQQ approaches it the spread is near max value and we've already harvested at ≥60%. The explicit "short-ITM-near-expiry" rule above covers the residual (overnight gap through both strikes; a slow disarmed grind to expiry).

**Opening a new spread (only if armed):** all must hold — `armed` (above) · open-spread count `< 3` (see roll exemption) · projected net debit `≤ 1% × portfolio` **and `contracts ≥ 1`** · `chooseStrikes` returns `ok` · `TradeGuard` approves. Then place the `mleg` order tagged `prophet-defensive` as a **marketable limit** (§6), persist a `pending_fill` row; reconcile to `open`/`failed` next beat (Turtle pattern).

**Unaffordable arm (review T2.1) — must NOT be a silent no-op.** A single realistic QQQ spread (QQQ ~$500 × 100, ~50-wide) can run a net debit near or above 1% of a $100k account, so `sizeSpread` may return `contracts = 0`. When armed-but-unaffordable, the executor emits a **distinct, grade-visible skip** (`"armed but unaffordable at 1% cap"`) — not a silent skip — so grading can tell *"the hedge couldn't fire"* from *"the hedge chose not to fire."* Feasibility flag for the observe phase: if 1 contract routinely exceeds the cap at the live account size, the per-spread cap (or the structure width) needs revisiting (D-DP16).

**Roll vs. the 3-cap (review T2.3).** A roll is close + reopen; the close is a pending `mleg` that won't reconcile until the next beat. Rule (D-DP17): a spread **in the `closing`/`rolling` state does NOT count toward the `< 3` open cap for its replacement** — close and reopen happen in the same beat, and the brief broker-side overlap (closing + replacement coexisting for one reconcile cycle) is acceptable because each leg is defined-risk and small. Rolling all three at once therefore opens three replacements, never a 4th net new. This avoids leaving the book unhedged for a beat mid-regime.

**Same-beat concurrency:** a freshly-*opened* (net new) spread counts toward the `< 3` cap for the rest of the beat; a *replacement* from a roll does not (it nets against the spread it replaces).

**Disarm (Score ≥ 50):** opening is gated off; open spreads are unaffected and continue to harvest/roll/expire.

---

## 6. Structuring & placement detail

- **Strike selection (`chooseStrikes`):** from the QQQ option chain for the chosen expiry, pick the **long put** nearest to `spot × 0.95` and the **short put** nearest to `spot × 0.85` (both at-or-below those targets, snapped to listed strikes). Net debit = long mid − short mid (use bid/ask mids; a configurable max-debit / min-width sanity check rejects degenerate chains, returns `ok=false`). Max payoff per contract = (long strike − short strike) − debit, ×100.
- **Expiry selection:** nearest standard monthly expiration whose DTE ∈ [45, 60]; if none, the nearest monthly **≥ 45 DTE** (never < 45). Reuse Harvest's monthly-expiration helper pattern.
- **Placement:** `PlaceMultiLegOrder` with two legs — `{long put, buy, buy_to_open}` and `{short put, sell, sell_to_open}` — `LimitPrice` = the net debit (sign/encoding to match Alpaca's `mleg` convention; **verify debit vs. credit sign in the build**, the existing helper comments assume a net *credit* condor). `TimeInForce="day"`, `Strategy="prophet-defensive"`.
- **Marketable limit, not bare mid (review T2.2).** A mid-price `day` limit is *least* likely to fill in a fast risk-off move — exactly when we want to arm — because spreads widen and makers pull. Use a **marketable limit**: net-debit-at-mid **+ a width-based buffer** (e.g. a fraction of the bid/ask width), capped so we never pay above the spread's intrinsic ceiling. An arm whose order does not fill by EOD is recorded as a **distinct unfilled-arm event** (Turtle's `MissedEntry` pattern) so grading separates *"didn't want to arm"* from *"wanted to but couldn't fill."* Mirrors Turtle's marketable buy (`LastClose × 1.005`).
- **Atomicity contract (review T1.4).** `mleg` combos fill **entirely or not at all — no partial leg fills** (documented: `alpaca_trading.go:734`, `2026-05-01-harvest-premium-seller-design.md:30`). A multi-contract combo may `partially_filled` into *fewer complete spreads*, never a half-spread. Reconcile takes `FilledQty` = number of complete spreads (Turtle pattern). **Leg-out defense** (Harvest design §152): if the broker ever reports a single-leg fill, immediately close the orphaned leg at market and log `partial fill cleanup` — the ledger must **never persist a single-leg position** (enforced by a test, §12).
- **Closing (harvest/roll/expire):** reverse combo — `{long put, sell, sell_to_close}` + `{short put, buy, buy_to_close}`, also as a marketable limit.

---

## 7. Measurement & grading — the part that makes it worth building

Graded on **tail contribution**, not standalone P&L, via Foundation B's **BALLAST graduation track**, which already exists in `docs/superpowers/specs/2026-05-31-foundation-b-component2-measurement-design.md` §5.2 / `D-C8`: **structural convexity** (by classification), **bounded bleed** (`expectancy ≥ −budget/trades-per-yr`), **stress payoff** (downside-beta CI upper bound ≤ 0, else structural-only per `D-B5`). Expectancy is explicitly **not** a gate — a structurally-defensive hedge can graduate with negative standalone expectancy.

- **Bounded-bleed budget — PINNED HERE (review T1.1).** 2c pins the *form* of the bleed gate and defers the *dollar* budget to "when defensive-Prophet is built" = now. Pinned a-priori: **annual hedge budget = 5% of account/year** (a deliberate insurance-premium ceiling — ~$5k/yr on a ~$100k book; if realized bleed exceeds it the bounded-bleed gate fails → REJECT). The per-trade expectancy floor 2c needs is `−(5% ÷ TradesPerYear)`, where **TradesPerYear is re-estimated from the observed tuning-window arm frequency** (not frozen blind — under the looser arm an initial estimate is ~15–25 spread-trades/yr). Tightening sizing for live (0.5%/max-2) lowers realized bleed against the same budget.
- **Synthetic stress-payoff — the calm-quarter answer (review T1.2, the deepest measurement problem).** A crash hedge proven only by a crash is unprovable in calm, and a single observation quarter can contain **zero meaningful QQQ-down days**, leaving realized stress-payoff unmeasurable. So in addition to realized conditional P&L, compute a **synthetic stress-payoff every day**: reprice each open spread under hypothetical QQQ shocks (**−10%, −20%**) using **terminal intrinsic value at the shocked spot** as a conservative, model-light floor (`max(0, longK − shockedSpot) − max(0, shortK − shockedSpot)` per share, ×100×contracts, minus debit) — no greeks/IV model required. This measures **payoff *capacity*** independent of whether a drawdown actually occurred. **Pre-registered no-drawdown-window behavior:** grade on `realized bleed` + `synthetic stress-payoff capacity`; defer realized-payoff *confirmation* to the first real down-cluster; **never REJECT for absence of crash data** (HOLD, per `D-B5`).
- **Conditioning variable: QQQ primary, SPY for Foundation-B-native beta (review T3.1 + benchmark reconciliation).** This hedge is graded against **QQQ-down days** (the tech proxy that matches the book). But 2c's stress-payoff machinery computes downside-beta against **SPY**. Reconciliation: defensive-Prophet's *primary* conditioning series is **QQQ**, so **2b must fetch QQQ alongside SPY** (both from the Alpaca data API, not FMP — `D-B2`); the SPY downside-beta remains as the Foundation-B-native *confirmation* read. Both benchmark series use the **same adjustment convention as 2b's SPY** (pin split-vs-total-return to match how segment daily returns are computed — review T3.5).
- **One-time book-β calibration (review T3.1).** The grade rides on QQQ being a good proxy for the *actual* book, which is concentrated and **not pure tech** (TSLA/NVDA/TSM but also GS/COST/MCD/V/LLY — see `user-portfolio-holdings`). Measure the book's historical correlation/β to QQQ **once** from the latest `Holdings_*.csv` (a static input, cheap) so we know how much the proxy grade transfers — and whether a SPY/QQQ blend or SPY is the better conditioning variable / future second underlying.
- **Roll friction in the bleed model (review T3.3).** A persistent sub-50 regime means rolling every ~24–39 days, each a **four-leg** bid/ask round-trip. The options/multi-leg friction model this build owns (per 2c §143 — `apply-friction` currently drops options) **must count multi-leg roll friction**, or the bounded-bleed grade understates true carry.
- **Data source:** the daily `DBSegmentPnL` series (one mark-to-market row per day, once D-DP9 wires `prophet-defensive` into the writer's loop). Live unrealized/deployed marks come from broker option positions via `SegmentPnLService` (valid for options).
- **Observe-first, but tuning ≠ grading (review T1.3, see §9):** real grading needs the daily series to accrue (~a quarter) and must run on **frozen, forward** config — not the same data the parameters were tuned on. **Not backtest-gated to ship.**

---

## 8. Risk enforcement & guardrails

- Every open routed through the existing **options through-guard / spread gate** (`trade_guard.go`) — the same enforcement Prophet-toy and Harvest use.
- Defined-risk by construction: worst case per spread = net debit (≤ 1% account); worst case total ≤ 3 concurrent × 1% = ~3% at risk simultaneously.
- Segment circuit-breaker + deployed-cap pattern available from Turtle (`applyGates`) if a per-segment loss breaker is wanted; v1 leans on the defined-risk + concurrency cap as the primary bound. (Open question for the plan: do we add a segment-level daily-loss breaker, or is defined-risk sufficient? Lean: defined-risk + 3-cap is sufficient for v1; revisit on observation.)
- Capital lane: defensive-Prophet is its own **small** self-enforced lane, **separate from Prophet-toy's 34%**. The six reconciled lanes currently sum to 100% (`capital-allocation-reconciled`); adding a hedge lane needs a small carve. On paper with self-enforcement this is **non-blocking**; flag for lane reconciliation before live.

---

## 9. Rollout

- **Flag-gated** `ENABLE_PROPHET_DEFENSIVE`, **default OFF**. Wired Go-side with strict `== "true"` parsing (keep the comment on its own line — inline `#` may not be stripped → silent false; see `capital-allocation-reconciled`).
- **Two separated windows — tuning ≠ grading (review T1.3).** Tuning the arm threshold (by §3 "the master carry/bleed knob") on the same data you grade bleed on is circular — you could lower the arm until bleed *looks* bounded and trivially pass. (The circularity is *partly* self-limiting — a lower arm also cuts coverage and stress-payoff capacity, so it's a tradeoff, not a free pass — but the split is still required.) So:
  - **Tuning window** (early paper): freely adjust arm threshold, structure, sizing, harvest %, roll DTE; observe. Nothing graded.
  - **Graded window** (later paper, ~a quarter): **config frozen**, graded on **fresh forward data** only. This is the data Foundation B's ballast gate reads.
- **Live arm threshold PRE-REGISTERED from principle now (not chosen after seeing paper bleed):** **paper = `Score < 50`** (learning-max); **live = `Score < 35`** — arm only when the regime is genuinely elevated (DEFENSIVE+), accepting more lag for materially lower carry, because the live default flips to capital-preservation (`user-risk-philosophy-paper-phase`). Sizing likewise pre-registered: live = 0.5%/spread, max 2.
- **Activation:** rebuild the Go bot from local main to load the flag/executor (`claude-commits-must-reach-local-main`). A `prophet-defensive` scheduler/cadence hook is needed (mirror the Turtle scheduler wiring). **Holiday-gating (review T3.5):** the daily beat window AND the DTE roll/expire math both depend on a trading calendar — tie both to the **same trading-calendar source as Foundation B's SPY benchmark calendar**, not a weekday-only check (cf. `holiday-aware-phase-project`; Turtle's Go scheduler holiday-gating is still TODO).
- **Workspace caveat:** built in an isolated worktree on branch `defensive-prophet` off current local main (concurrent session rewrites HEAD on the shared dir).

---

## 10. Deferred (designed-in seams, NOT built now)

| Deferred item | Seam | Trigger to build |
|---|---|---|
| **Regime/IV-conditional structure** | `selectStructure(regime, iv)` is already the choke point; v1 returns the fixed profile, a conditional policy drops in flag-gated with zero rework | once the v1 baseline has a clean graded record |
| **LLM catalyst-acceleration** | a narrow pre-open hook that may only **accelerate arming** on a fast qualitative risk-off catalyst — **never veto a mechanical arm**, fires only in elevated-risk windows | only if observation shows the mechanical (daily) trigger lagging fast catalysts; token cost justified only vs. the mechanical baseline |
| **Long-vol ETF sleeve** (VIXM/VXZ, never VXX/UVXY) | separate sleeve, not the put-spread path | after the core hedge is proven |
| **SPY / broad-market coverage** | second underlying in the universe constant | only if broader-than-tech coverage is later wanted |

---

## 11. Decisions

- **D-DP1** Arm requires a *valid, fresh* tier: `Tier != UNKNOWN && !IsStale && Score < 50`. UNKNOWN/stale ⇒ do not open new (don't bleed blind), but never force-close (stay hedged if data goes dark). *(Correctness pin — guards the `Score=0`-on-missing trap.)*
- **D-DP2** Arm threshold = `Score < 50` (looser bar), chosen to maximize paper-phase graded episodes. Live value pre-registered as `<35` (see D-DP14) — not tuned post-hoc.
- **D-DP3** Disarm (`Score ≥ 50`) gates *opening* only; open spreads ride their own rules.
- **D-DP4** v1 structure is a single fixed tail-targeted profile (long ~5% OTM / short ~15% OTM, 45–60 DTE) behind a pluggable `selectStructure` seam; conditional structure is deferred v2.
- **D-DP5** Active management: harvest at ~60% max payoff; roll at DTE ≤ 21 while armed; let expire while disarmed. Max loss = net debit (no stop leg).
- **D-DP6** Sizing = net debit ≤ 1% account/spread, max 3 concurrent (paper-phase moderate). Tighten to 0.5%/max-2 for live.
- **D-DP7** Dedicated Go executor + dedicated `DBProphetHedgeSpread` table (multi-leg doesn't fit single-symbol `managed_positions`); modeled on Turtle/Harvest. Not an extension of Harvest (opposite thesis).
- **D-DP8** Graded on tail contribution via Foundation B BALLAST track, conditioned on QQQ daily return; benchmark from Alpaca data API (not FMP). Observe-first, not backtest-gated.
- **D-DP9** Segment-P&L integration has **two** required changes: (a) `SegmentPnLWriter`'s per-day loop must **include `prophet-defensive` independently of `ListManagedStrategies()`** — the hedge never writes `managed_positions` rows, so it would otherwise never be marked (write a 0/0 row even on flat/no-open days so the return series is continuous from day one); (b) a `prophet-defensive` realized-P&L special-case analogous to the existing `harvest` one (closed-spread P&L lives in the new spread table). The live unrealized/deployed marks come from broker option positions via `SegmentPnLService` (valid for options) — confirm it attributes `prophet-defensive` option legs to the strategy (via the `client_order_id` tag), or special-case it too. **Scope (review T3.4):** this fixes continuity for `prophet-defensive` only. The equity agents (Coil/Turtle) already get daily rows via Component 1 (they write `managed_positions`, so they appear in `ListManagedStrategies()`); the separate fleet-wide question of gap-aware differencing on their flat days is a Foundation B concern, **not** resolved by D-DP9.
- **D-DP10** Strategy tag `prophet-defensive`; flag `ENABLE_PROPHET_DEFENSIVE` default OFF; additive only; **Prophet-toy untouched**.
- **D-DP11** LLM layer deferred and *bounded*: accelerate-only, never veto a mechanical arm, elevated-risk windows only — built only if the mechanical trigger demonstrably lags catalysts.

### Review-driven decisions (2026-06-01, external-review round)
- **D-DP12** Bounded-bleed **dollar budget pinned here** (2c delegates it to this build): **annual hedge budget = 5% of account/year**; per-trade expectancy floor = `−(5% ÷ TradesPerYear)`, with TradesPerYear re-estimated from the observed tuning-window arm frequency (initial ~15–25/yr).
- **D-DP13** **Synthetic stress-payoff** computed daily — reprice each open spread under −10%/−20% QQQ shocks via terminal-intrinsic floor (no greeks) to measure payoff *capacity* in calm quarters. Pre-registered no-drawdown behavior: grade bleed + synthetic capacity, defer realized-payoff confirmation, **never REJECT for absence of crash data** (HOLD per `D-B5`).
- **D-DP14** **Tuning window (free) and graded window (frozen config, fresh forward data) are separated** to avoid grading on tuned data / a circular bleed gate. Live arm threshold **pre-registered from principle now**: paper `<50`, live `<35`; live sizing 0.5%/max-2.
- **D-DP15** `mleg` is **atomic (fills whole or not at all)** — the documented contract. Leg-out defense: orphaned single leg → close at market + log `partial fill cleanup`; the ledger **never persists a single-leg position** (test-enforced).
- **D-DP16** Armed-but-unaffordable (`sizeSpread` → 0 contracts under the 1% cap) emits a **distinct, grade-visible skip**, never a silent no-op. Feasibility of 1 contract at the live account size is an observe-phase flag (revisit cap/width if 1 contract routinely exceeds the cap).
- **D-DP17** Roll = close + reopen same beat; a **closing/rolling spread is exempt from the `<3` open cap** for its replacement (transient broker-side overlap accepted — defined-risk). Avoids a beat unhedged mid-regime.
- **D-DP18** Conditioning variable **QQQ primary** (matches the tech book) + **SPY** for Foundation-B-native downside-beta confirmation ⇒ **2b fetches QQQ alongside SPY** (Alpaca, not FMP). One-time **book-β-to-QQQ calibration** from the holdings CSV measures proxy transfer. Both benchmark series share 2b's SPY adjustment convention. Multi-leg **roll friction** counted in the options friction model this build owns.
- **D-DP19** v1 is a **capped correction hedge** (pays 5→15%, caps at 15%), **not deep-tail insurance** — a deliberate cheap-carry choice; deep-tail convexity is the deferred long-vol sleeve + v2 `selectStructure`.

---

## 12. Testing (Go, TDD — for the build)

- **Pure functions, isolated unit tests:** `deriveArm` (UNKNOWN/stale/score boundaries incl. the `Score=0` trap), `selectStructure` (returns fixed profile), `chooseStrikes` (strike snapping, degenerate-chain `ok=false`, debit/width sanity), `sizeSpread` (1% cap; **`contracts==0` when 1 contract exceeds the cap** — D-DP16), `shouldHarvest`/`shouldRoll`/`shouldExpire`/`shouldCloseITMShort` (60% / DTE-21 / armed-vs-disarmed / short-ITM-near-expiry boundaries), `syntheticStressPayoff` (terminal-intrinsic floor at −10%/−20% shock, incl. shock below short strike = capped at max payoff — D-DP13), `marketableLimit` (mid + width buffer, capped at intrinsic ceiling — T2.2).
- **Executor against mocks** (Turtle/Harvest pattern — assert *side effects*, not just predicates): mocked regime, chain, mleg placer, guard, account, ledger. Cases: armed+room → places a correctly-structured marketable-limit `mleg` order tagged `prophet-defensive` + persists pending row; disarmed → no open, open spreads still managed; UNKNOWN/stale → no open + no force-close; concurrency cap; debit cap; **armed-but-unaffordable → distinct grade-visible skip, no order** (D-DP16); harvest/roll/expire/ITM-short transitions; **roll → replacement opens same beat without breaching the 3-cap** (D-DP17); pending-fill reconcile (filled / `partially_filled` = N complete spreads / canceled / nil avg-price).
- **Safety-critical, test-enforced (D-DP15):** the ledger **can never persist a single-leg position** — a simulated broker leg-out triggers orphan-close + `partial fill cleanup`, not a saved naked short.
- **Mock-based tests for side-effecting paths are non-negotiable before "done"** (`feedback-verification`): test the executor placing/closing orders, not only the predicate helpers.
- Full `services` + `database` packages green; deterministic tests.
