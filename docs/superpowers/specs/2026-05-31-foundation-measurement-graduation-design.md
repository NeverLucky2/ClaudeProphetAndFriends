# Foundation Part B — Measurement & Graduation

**Status:** Draft for operator review (rev 2 — incorporates review round 2026-05-31)
**Created:** 2026-05-31
**Depends on:** Foundation Part A (managed-position lifecycle correctness — committed on branch `fix-managed-pending-timeout-and-partial-race`)
**Parent:** the uncorrelated-ballast fleet pivot (see memory `fleet-uncorrelated-ballast-pivot`)

---

## 1. Purpose

The entire fleet plan rests on being able to **measure each strategy's edge and orientation** so that anything graduating to real capital is filtered on *both*. Today neither is measurable:

- Per-agent **realized** P&L is not recorded anywhere usable (`db_segment_pn_ls` is empty; the live `SegmentPnLService` is unrealized-only; the `trades` table is empty).
- There is no per-strategy **beta / orientation** estimate, so "is this agent secretly long my tech book?" is unanswerable.
- There is no coded **graduation bar** — every "is it working?" is a judgment re-made by hand.

Part B builds the machinery and **starts the clock**. It does not produce verdicts: with the ≥3-month requirement (§5) nothing graduates for at least a quarter after this lands. The deliverable is the instrument, honestly calibrated, not a KEEP/GRADUATE call.

## 2. Grounded findings (verified 2026-05-31)

1. **`DBSegmentPnL` already exists** (`models/models.go:56`): `Strategy, Date, RealizedPnL, UnrealizedPnL, DeployedPercent, PositionCount, PortfolioValue`. Specced as Phase 2 of `docs/shared-account-backend-spec.md` but **the EOD writer was never built** — hence 0 rows. Part B *finishes* this.
2. **The `trades` table is empty.** Realized-P&L truth lives only in **closed `managed_positions`** rows (P&L frozen at exit, tagged by `AgentStrategy`) plus closed `DBHarvestCondor.RealizedPnL`. The old spec's `SELECT SUM(pnl) FROM trades` is not a valid source.
3. **Broker `unrealized_pl` is available per position** via `get_positions` (already consumed by `SegmentPnLService.GetSegmentPnL`), for **equity and options alike**. This is the daily-mark source — no dependency on the per-sandbox `bars` table.
4. **Each agent runs its own Go bot against its own sandbox DB**, knows its own `AgentStrategy`, and already runs an in-process `MonitorPositions` 10s loop — the natural home for a once-per-trading-day EOD writer step.

## 3. Architecture

Three components; the first is Go (writes the daily series), the second and third are Node (read it for lab/graduation), matching the existing split (live enforcement in Go, lab tooling in `scripts/*.mjs`).

```
Go bot (per sandbox)                     Node lab tooling (review-performance)
────────────────────                     ─────────────────────────────────────
MonitorPositions loop                    Component 2: measurement & graduation
  └─ Component 1: EOD daily-mark writer    ├─ per-trade ledger  ← closed managed_positions
       → upserts 1 DBSegmentPnL row/day    ├─ conditional/deployed beta ← DBSegmentPnL daily series + SPY (Alpaca)
         per strategy (realized + daily    └─ graduation bar (apply-friction + significance-gate)
         marked unrealized)                     → KEEP / HOLD / GRADUATE
                                         Component 3: one-time historical repair
                                           ├─ quarantine pre-fix records
                                           └─ retroactive exit-reason derivation
```

## 4. Component 1 — Go daily-marked EOD writer

**THE LOAD-BEARING REQUIREMENT (design pin): the writer persists a *daily mark-to-market* per-strategy row every trading day — not an exit-stamped realized series.** Snapshotting unrealized only on exit days gives one coarse observation per trade (no better than §8's per-trade approximation), defeating the reason for building (a). A daily row turns a 4-day Coil hold into ~3–4 deployed-day observations — roughly triples the conditional-beta sample for a sparse, episodic trader, which is exactly the estimate otherwise too noisy to trust.

**Hook.** A time-gated step inside `MonitorPositions`: once per trading day, on the first tick after market close (≥ 16:00 ET) for which no `DBSegmentPnL` row exists for `(strategy, today)`, compute and upsert the row. Running off the monitor loop (not the LLM beat) guarantees a row even on days the agent is idle.

**Row contents (existing schema):**
- `RealizedPnL` — sum of frozen exit P&L of this strategy's managed positions **closed today**, **including partial-exit realizations** (+ closed condors' `RealizedPnL` for Harvest). Including partial realizations is what makes the daily-return netting (below) hold for scale-out agents.
- `UnrealizedPnL` — current sum of broker-reported `unrealized_pl` over this strategy's **open** positions (the daily mark; equity and options).
- `DeployedPercent`, `PositionCount`, `PortfolioValue` — as `SegmentPnLService` already computes.

**Daily strategy return (computed in Node, not stored):**
`pnl_d = RealizedPnL_d + (UnrealizedPnL_d − UnrealizedPnL_{d−1})`, normalized by `PortfolioValue`. Differencing the daily unrealized snapshots *is* the mark-to-market.

- **Gap-aware (required):** the formula assumes `d−1` is the *prior trading day*. If a row is missing — bot down at close, plausible for a hobby bot not running 24/7 — then differencing spans two days of price move attributed to one day and misaligned against one day of SPY: a fabricated outlier that distorts the beta slope. The Node layer **must detect non-consecutive dates and drop (or flag) the spanning observation**, never silently difference across a gap. This is the dangerous *inverse* of the double-write case (§7) and the idle-day row only covers idle-but-running, not down-at-close.
- **Partial exits:** the netting holds only because `RealizedPnL_d` includes the partial-exit realized leg booked at the same day's marks; confirm which agents scale out (penny's exit ladder does; Coil/Turtle exit in one bracket) and cover it with a test (§9).

**Reuse:** the realized/unrealized sums and the attribution map already exist in `SegmentPnLService`; Component 1 is largely wiring those into a daily upsert + the once-per-day gate, plus folding closed-managed-position realized P&L into the realized sum (the `v1 limitation` at `segment_pnl_service.go:16-19`).

**Options note (interpretation, not data):** daily marks are clean for options too (broker `unrealized_pl`). The asymmetry is that *linear beta is poorly behaved for a convex hedge sleeve* — handled in §5 by classifying those sleeves structurally rather than by measured beta.

## 5. Component 2 — Node measurement & graduation (extends `review-performance`)

- **Per-trade ledger** (win rate, profit factor, expectancy): read closed `managed_positions` per `AgentStrategy` directly. Friction-adjust via `apply-friction.mjs` (equity/ETF valid today; options deferred per §7). **Known upward bias:** a closed-only ledger flatters a hold-losers agent (realizes winners, sits on unrealized losers). Coil's −7% stop + 5-day timeout largely force losers closed, so its bias is small — but report a **secondary marked-equity expectancy** (closed + open marks) alongside, so the "beta uses marks, edge uses closed-only" inconsistency is deliberate, not accidental.
- **Beta / orientation:** regress the strategy's gap-aware daily return series (§4) on SPY daily returns, reported three ways:
  - *deployed beta* — over `DeployedPercent > 0` days only (the honest orientation read; stops a cash-heavy agent like Coil from being laundered into "uncorrelated"),
  - *unconditional beta* — all days (comparison),
  - *downside-beta* — over SPY-down days (confirmation only; see below).
  - **SPY benchmark daily closes from the Alpaca data API** — the broker feed retained regardless. **Not FMP**: FMP's only surviving consumer is Drift and it is slated for cancellation when Drift retires, so permanent measurement infra must not depend on it. (Not the per-sandbox `bars` table either, which holds only each sandbox's own universe.)
- **Orientation gating differs by sleeve type:**
  - *Equity agents (Coil, Turtle):* gated on **measured deployed-beta** in-band.
  - *Convex/options sleeves (defensive-Prophet, paused Harvest):* gated on **structural classification** (buys put-spreads ⇒ defensive by construction); measured downside-beta is *confirmation-when-available, never the gate*. Downside-beta is underpowered for a long time — deployed ∩ SPY-down days over a quarter is a handful of points, and crash payoff lives in rare days that may not occur in-window at all. Gating a hedge on it would mean it can't graduate until a drawdown happens to land in-sample (possibly years).
- **Graduation bar as code:** reuse `apply-friction.mjs` + `friction-stress-compare.mjs` (net-of-2×-friction) + `significance-gate.mjs`. GRADUATE requires **all** of: ≥ N closed trades (N pinned in plan once Coil's cadence is known), positive expectancy net of 2× friction, ≥ 3 months live, and orientation in-band (measured for equity / structural for convex). Emit KEEP / HOLD / GRADUATE in the `review-performance` report; never auto-act.

## 6. Component 3 — One-time historical repair (Node)

- **Quarantine by whole lifecycle:** a record is graduation-eligible only if it was **entered on or after the Part-A-fix date**. Entry-side bugs (partial-fill qty/price) and exit-side bugs (orphan, false label) corrupt different ends of a position's life, so neither pure entry-date nor exit-date alone is safe; requiring entry ≥ fix-date makes the *whole* lifecycle post-fix (exits follow entries). Everything earlier is not-eligible.
- **Retroactive exit-reason derivation (Fix-3 boundary tool):** for existing closed `managed_positions`, derive the true exit reason from stored entry/exit/stop/target prices (exit ≈ stop ⇒ stop-out; exit ≥ target ⇒ target; else signal/time), repairing legacy mislabels such as COST's false `STOPPED_OUT` (+1.5% exit, above its stop). Display-only; quarantined records stay excluded from graduation regardless.

## 7. Deferred / named open items

- **Options friction model.** `apply-friction.mjs` drops options. Equity/ETF (Coil, Turtle) reuse it as-is. Defensive-Prophet's graduation needs an instrument-aware options friction model — **built with defensive-Prophet**, not now.
- **EOD writer day-boundary robustness.** Two failure modes: (a) *double-write* — a restart after close must not write twice (gate keys on `(strategy, date)`); (b) *missing row* — bot down at close writes no row, handled downstream by the gap-aware differencing in §4/§5. Both covered by tests.
- **Cross-sandbox read for the Node layer.** Confirm the review tooling resolves each agent's sandbox DB by `AgentStrategy` (not hardcoded sandbox id), consistent with `review-performance`'s existing resolution.

## 8. Pre-registered decisions

- **D-B1 — daily mark, not exit-stamp.** Component 1 writes a `DBSegmentPnL` row every trading day with current marked unrealized. (§4)
- **D-B2 — quarantine by entry date.** Graduation-eligible only if entered on/after the Part-A-fix date (whole lifecycle post-fix). Fix-3 derivation repairs legacy labels for display only. (§6)
- **D-B3 — paper clock counts.** The ≥3-month clock counts paper time; the 2× friction gate makes paper-based graduation honest. Foundation delivers machinery + starts the clock, not verdicts.
- **D-B4 — (b) is validation-only.** The crude per-trade beta (trade return vs SPY over its hold) is a one-time cross-check once 1–2 months of daily data exist: divergence from daily-marked beta flags a daily-mark bug. Never load-bearing for a graduation call.
- **D-B5 — convex sleeves gated structurally.** Options/hedge sleeves are classified by construction (put-spreads ⇒ defensive); measured downside-beta is confirmation-when-available, never the gate, because crash-payoff samples are too sparse over a quarter. Equity agents gate on measured deployed-beta.
- **D-B6 — SPY from Alpaca, not FMP.** Benchmark data comes from the broker feed retained regardless; measurement infra must not depend on FMP, which is slated for cancellation with Drift.
- **D-B7 — gap-aware differencing.** The daily-return series never differences across a missing day; non-consecutive observations are dropped/flagged.

## 9. Testing

- **Component 1 (Go):** TDD against the existing position-manager mocks. Cases: writes one row/day; idempotent on a second post-close tick same day; realized folds closed-today managed positions **incl. partial-exit realizations**; unrealized uses broker `unrealized_pl`; idle day still writes a row; restart-after-close does not double-write.
- **Components 2 & 3 (Node):** `node:test`. Cases: daily-return differencing; **gap-aware drop of a non-consecutive (missing-day) observation**; **partial-exit netting** (scale-out day nets price move vs qty reduction correctly); deployed vs unconditional vs downside beta on a synthetic series; structural-vs-measured gating per sleeve type; graduation bar gating each criterion independently; quarantine cutoff by entry date; exit-reason derivation incl. the COST false-`STOPPED_OUT` repair; secondary marked-equity expectancy.

## 10. Out of scope

- Options friction model (deferred, §7).
- The new strategy builds (Turtle-v2, defensive-Prophet) — separate specs.
- Any change to live circuit-breaker behavior — Component 1 only *adds* a historical daily row; the live segment-P&L path is untouched.
- Auto-acting on graduation verdicts — always operator-reviewed.
