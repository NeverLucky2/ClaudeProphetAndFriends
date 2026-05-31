# Foundation Part B — Measurement & Graduation

**Status:** Draft for operator review
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

1. **`DBSegmentPnL` already exists** (`models/models.go:56`): `Strategy, Date, RealizedPnL, UnrealizedPnL, DeployedPercent, PositionCount, PortfolioValue`. It was specced as Phase 2 of `docs/shared-account-backend-spec.md` but **the EOD writer was never built** — hence 0 rows. Part B *finishes* this, it does not invent it.
2. **The `trades` table is empty.** Realized-P&L truth lives only in **closed `managed_positions`** rows (P&L frozen at exit, tagged by `AgentStrategy`) plus closed `DBHarvestCondor.RealizedPnL`. The old spec's `SELECT SUM(pnl) FROM trades` is therefore not a valid source — Part B reads closed managed positions.
3. **Broker `unrealized_pl` is available per position** via `get_positions` (already consumed by `SegmentPnLService.GetSegmentPnL`), for **equity and options alike**. This is the daily-mark source — no dependency on the per-sandbox `bars` table.
4. **Each agent runs its own Go bot against its own sandbox DB**, knows its own `AgentStrategy`, and already runs an in-process `MonitorPositions` 10s loop. That loop is the natural home for a once-per-trading-day EOD writer step.

## 3. Architecture

Three components; the first is Go (writes the daily series), the second and third are Node (read it for the lab/graduation analysis), matching the existing split (live enforcement in Go, lab tooling in `scripts/*.mjs`).

```
Go bot (per sandbox)                     Node lab tooling (review-performance)
────────────────────                     ─────────────────────────────────────
MonitorPositions loop                    Component 2: measurement & graduation
  └─ Component 1: EOD daily-mark writer    ├─ per-trade ledger  ← closed managed_positions
       → upserts 1 DBSegmentPnL row/day    ├─ conditional/deployed beta ← DBSegmentPnL daily series + SPY (FMP)
         per strategy (realized + daily    └─ graduation bar (apply-friction + significance-gate)
         marked unrealized)                     → KEEP / HOLD / GRADUATE
                                         Component 3: one-time historical repair
                                           ├─ quarantine pre-A-fix records
                                           └─ retroactive exit-reason derivation
```

## 4. Component 1 — Go daily-marked EOD writer

**THE LOAD-BEARING REQUIREMENT (design pin): the writer persists a *daily mark-to-market* per-strategy row every trading day — not an exit-stamped realized series.** Snapshotting unrealized only on exit days would give one coarse observation per trade (no better than the per-trade approximation in §8), defeating the entire reason for building (a). A daily row turns a 4-day Coil hold into ~3–4 deployed-day observations — roughly triples the conditional-beta sample for a sparse, episodic trader, which is exactly the estimate that is otherwise too noisy to trust.

**Hook.** A time-gated step inside `MonitorPositions`: once per trading day, on the first tick after market close (e.g. ≥ 16:00 ET) for which no `DBSegmentPnL` row exists for `(strategy, today)`, compute and upsert the row. Running off the monitor loop (not the LLM beat) guarantees a row even on days the agent is idle — required for a clean daily return series.

**Row contents (per the existing schema):**
- `RealizedPnL` — sum of frozen exit P&L of this strategy's managed positions **closed today** (+ closed condors' `RealizedPnL` for Harvest).
- `UnrealizedPnL` — current sum of broker-reported `unrealized_pl` over this strategy's **open** positions (the daily mark; works for equity and options).
- `DeployedPercent`, `PositionCount`, `PortfolioValue` — as `SegmentPnLService` already computes them.

**Daily strategy return (computed in Node, not stored):**
`pnl_d = RealizedPnL_d + (UnrealizedPnL_d − UnrealizedPnL_{d−1})`, normalized by `PortfolioValue`. Differencing the daily unrealized snapshots *is* the mark-to-market — so the writer stays simple (snapshot, don't diff) and the analysis layer owns the return math.

**Reuse:** the realized and unrealized sums and the attribution map already exist in `SegmentPnLService`; Component 1 is largely wiring those into a daily upsert + the once-per-day gate, plus folding closed-managed-position realized P&L into the realized sum (the `v1 limitation` noted in `segment_pnl_service.go:16-19`).

**Options note (interpretation, not data):** daily marks are clean for options too (broker `unrealized_pl`). The asymmetry is that *linear beta is a poorly-behaved statistic for a convex hedge sleeve* (defensive-Prophet, paused Harvest) — its exposure is nonlinear. For those sleeves the orientation read leans on **downside-beta and crash-conditional payoff**, not linear beta. Mark all agents daily; interpret the equity agents' beta strictly and the convex sleeves' beta loosely.

## 5. Component 2 — Node measurement & graduation (extends `review-performance`)

- **Per-trade ledger** (win rate, profit factor, expectancy): read closed `managed_positions` per `AgentStrategy` directly — the per-trade truth. Friction-adjust via `apply-friction.mjs` (equity/ETF valid today; options deferred per §7).
- **Conditional / deployed beta:** regress the strategy's daily return series (§4) on SPY daily returns, computed **two ways and reported side by side**:
  - *deployed beta* — over days where `DeployedPercent > 0` only (the honest orientation read; stops a cash-heavy agent like Coil from being laundered into "uncorrelated"),
  - *unconditional beta* — all days (for comparison).
  - Plus **downside-beta** (regress over days SPY < 0) — the primary read for the convex/options sleeves.
  - SPY benchmark daily closes sourced from **FMP** (`FMP_API_KEY` in project-root `.env`), not the per-sandbox `bars` table.
- **Orientation band:** classify each strategy `long-beta` / `neutral` / `defensive` from deployed-beta (with downside-beta override for convex sleeves). Bands and thresholds defined in the implementation plan.
- **Graduation bar as code:** reuse `apply-friction.mjs` + `friction-stress-compare.mjs` (net-of-2×-friction) + `significance-gate.mjs`. Emit per-agent **KEEP / HOLD / GRADUATE** where GRADUATE requires **all** of: ≥ N closed trades (N pinned in plan), positive expectancy net of 2× friction, ≥ 3 months live, and orientation in the target band. Surface in the `review-performance` report; never auto-act.

## 6. Component 3 — One-time historical repair (Node)

- **Quarantine:** mark every closed record dated before the Part-A-fix landing date as **not-graduation-eligible**. Pre-fix data was written under the lifecycle bugs and cannot be trusted for a graduation call.
- **Retroactive exit-reason derivation (Fix-3 boundary tool):** for existing closed `managed_positions`, derive the true exit reason from stored entry/exit/stop/target prices (e.g. exit ≈ stop ⇒ stop-out; exit ≥ target ⇒ target; else signal/time), repairing legacy mislabels such as COST's false `STOPPED_OUT` (+1.5% exit, well above its stop). Going-forward labeling is already correct in `manageRiskOrders`; this only fixes history so it *displays* honestly. Quarantined records stay excluded from graduation regardless.

## 7. Deferred / named open items

- **Options friction model.** `apply-friction.mjs` drops options ("unrecognized asset class"). Equity/ETF agents (Coil, Turtle) reuse it as-is. Defensive-Prophet's graduation requires an instrument-aware options friction model — **built when defensive-Prophet is built**, not now.
- **Cross-sandbox read for the Node layer.** The review tooling already reads per-sandbox files; confirm it resolves each agent's sandbox DB by `AgentStrategy` (not hardcoded sandbox id), consistent with `review-performance`'s existing resolution.
- **EOD writer idempotency across restarts.** The once-per-day gate keys on `(strategy, date)` existence; a bot restart after close must not double-write or skip. Covered by tests in the plan.

## 8. Pre-registered decisions

- **D-B1 — daily mark, not exit-stamp.** Component 1 writes a `DBSegmentPnL` row every trading day with current marked unrealized; this is the requirement that makes conditional beta trustworthy for sparse traders. (§4)
- **D-B2 — quarantine + repair.** Pre-fix records are not graduation-eligible; Fix-3 derivation repairs their labels for display only. (§6)
- **D-B3 — paper clock counts.** The ≥3-month graduation clock counts paper time; the 2× friction gate is what makes paper-based graduation honest. Foundation delivers machinery + starts the clock, not verdicts.
- **D-B4 — (b) is validation-only.** The crude per-trade beta (each trade's return vs SPY over its hold) is kept solely as a one-time cross-check once 1–2 months of daily data exist: if daily-marked and per-trade betas diverge badly, that flags a daily-mark bug. It is never load-bearing for a graduation call.
- **D-B5 — convex-sleeve orientation.** For options sleeves, downside-beta and crash-conditional payoff are the orientation read; linear beta is reported but not trusted.

## 9. Testing

- **Component 1 (Go):** TDD against the existing position-manager mocks. Cases: writes one row/day; idempotent on a second post-close tick same day; realized folds closed-today managed positions; unrealized uses broker `unrealized_pl`; idle day still writes a row; restart-after-close does not double-write.
- **Components 2 & 3 (Node):** `node:test` (per workflow preference). Cases: daily-return differencing; deployed vs unconditional vs downside beta on a synthetic series; graduation bar gating each criterion independently; quarantine cutoff; exit-reason derivation incl. the COST false-`STOPPED_OUT` repair.

## 10. Out of scope

- Options friction model (deferred, §7).
- The new strategy builds themselves (Turtle-v2, defensive-Prophet) — separate specs.
- Any change to live circuit-breaker behavior — Component 1 only *adds* a historical daily row; the live segment-P&L path is untouched.
- Auto-acting on graduation verdicts — always operator-reviewed.
