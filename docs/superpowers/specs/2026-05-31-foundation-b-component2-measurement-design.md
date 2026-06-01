# Foundation Part B — Component 2: Measurement & Graduation

**Status:** Draft for operator review (rev 2 — incorporates review round 2026-05-31)
**Created:** 2026-05-31
**Parent spec:** `docs/superpowers/specs/2026-05-31-foundation-measurement-graduation-design.md` (§5, D-B1..D-B8)
**Depends on:** Component 3 (`scripts/managed-position-repair.mjs` — `node:sqlite` reader, eligibility, `deriveExitReason`) and Component 1 (Go `DBSegmentPnL` daily writer, for 2b).
**This effort builds 2a only; 2b and 2c are specified here for a focused follow-up.**

---

## 1. Purpose & scope

Turn the measurement machinery into a per-agent **edge + orientation** read and a coded **graduation bar**, so anything reaching real capital is filtered on both (the binding constraint of the uncorrelated-ballast pivot). Three sub-pieces with different real-data readiness:

- **2a — per-trade ledger (BUILD NOW):** friction-adjusted win rate / profit factor / expectancy + per-trade-P&L bootstrap CI, per agent, from closed `managed_positions`. Real-data testable today (plumbing; see §3.6 caveat).
- **2b — beta / orientation (SPEC ONLY):** deployed / unconditional / downside beta (with CIs) from Component 1's `DBSegmentPnL` daily series vs SPY. Synthetic-only until the daily series accrues (~a quarter); needs a new Alpaca SPY fetcher.
- **2c — graduation bar (SPEC ONLY):** combine 2a + 2b on **two tracks** (alpha vs ballast) → GRADUATE / HOLD / REJECT / RETIRE. Depends on both.

Standalone, agent-agnostic Node lab tooling in `scripts/*.mjs`. **Does not edit the Prophet-only `review-performance` skill** — it *reuses that skill's building blocks* (`apply-friction.mjs`, `significance-gate.mjs`). Never auto-acts; emits reports only.

## 2. Module structure (isolation)

| File | Piece | This effort |
|---|---|---|
| `scripts/trade-ledger.mjs` (+ `.test.mjs`) | 2a | **build** |
| `scripts/segment-beta.mjs` (+ `.test.mjs`) | 2b | spec only |
| `scripts/alpaca-spy-daily.mjs` (+ `.test.mjs`) | 2b | spec only |
| `scripts/graduation-gate.mjs` (+ `.test.mjs`) | 2c | spec only |

Each imports Component 3's pure functions from `scripts/managed-position-repair.mjs`. **Component 3 already reads via built-in `node:sqlite` (`{ readOnly: true }`) and returns a wide row** (`quantity`, `realizedPnl` dollars, `realizedPnlPct`, `allocationDollars`, `entryOrderId`, `closedAt`, …) — so there is **one shared reader** and 2a's friction inputs already exist; no second reader, no drift. Test runner: `node:test`.

**Status enum (verified in Component 3):** `PENDING, ACTIVE, PARTIAL, CLOSED, STOPPED_OUT, FAILED`. Closed-trade set `{CLOSED, STOPPED_OUT}`; open set `{ACTIVE, PARTIAL}` (`PARTIAL` = partial *exit* — still open at reduced qty, its `unrealized_pl` a sound mark on `remaining_qty`). `PENDING` (never entered) and `FAILED` (entry never became a position) are **non-trades, excluded from both readers** — complete coverage, no silent drop.

## 3. Component 2a — per-trade ledger (BUILD)

### 3.1 Friction adapter — `toFrictionAction(position, agentId)`
`apply-friction.mjs` was built for `decisive_actions` JSON, not `managed_positions`. A pure adapter maps a Component-3 closed-position object → the action shape `applyFriction` consumes:
```
{ symbol, reasoning,
  market_data: { entry_price: entryPrice, exit_price: exitPrice, size: quantity,
                 unrealized_pl: realizedPnl, unrealized_pct: realizedPnlPct } }
```
**Stop-out friction is driven by Component 3's classification, with one honest caveat.** `apply-friction`'s `isStopOut` requires **both** `market_data.unrealized_pct < 0` **and** a stop substring in `reasoning`. The adapter sets `reasoning = 'stopped out'` exactly when `deriveExitReason(position).derived === 'stop'`. So the stop-gap-through haircut fires on a derived **losing** stop — a profitable trailing-stop exit (derived `stop`, `pct ≥ 0`) gets base friction only. Two known limitations, noted not hidden: (a) `stop_gap_through_pct` is a **flat** %-of-notional haircut, not gap-magnitude-aware (understates deep-gap tail friction); (b) the `pct < 0` co-condition above. Both are acceptable for an equity ledger and partially covered by the 2× stress (§3.2); the options/convex friction model is deferred to defensive-Prophet.

### 3.2 Friction at 1× and 2× (stress only the uncertain components)
Load `config/friction.json` (baseline → expectancy@1×). Build the 2× **stress** config by cloning and doubling **only the genuinely uncertain frictions** — `per_share_slippage_usd`, `slippage_pct_of_price_floor`, `stop_gap_through_pct`, and the options `assumed_spread_*` — **leaving deterministic fees at 1×** (`commission_per_share`, `regulatory_fee_per_share`, `commission_per_contract`, `regulatory_fee_per_contract` are known exact costs with no "worse-than-modeled" tail; doubling them inflates the gate with fictional cost). → expectancy@2×. Reuses `apply-friction`'s tested model.

### 3.3 Ledger — `buildAgentLedger(closed, open, cutoffMs, agentId, frictionCfg)`
Pure. Partition `closed` by `isGraduationEligible(parseManagedTimestamp(createdAt), cutoffMs)` into **eligible** vs **quarantined**. For each partition, on friction-adjusted P&L:
- trade count, winners/losers, **win rate**, **profit factor**, avg win, avg loss,
- **expectancy** (mean `friction_adjusted_pl`) at **1×** and **2×**,
- the **per-trade friction-adjusted P&L array** (so 2c can bootstrap — §5).

**Profit factor with zero losses is `null` (undefined), never `Infinity`** — 2c treats `null` as "not yet demonstrable," never as a pass.

Graduation-relevant metrics use the **eligible** partition; an **all-closed (incl. quarantined)** block runs alongside so the report is non-empty today (all current trades are pre-cutoff → quarantined; the eligible block is empty until post-deploy entries accrue).

**Secondary marked-equity expectancy** (spec §5 hold-losers bias) — honestly constructed: over **eligible** closed + **eligible** open (`createdAt ≥ cutoff`) positions only (aligned populations), summing eligible friction-adjusted realized + open marks with **entry-side friction subtracted** from the open leg (you have already paid to be in). Labeled "marked-equity expectancy (eligible, open leg entry-friction-only)" so it is never mistaken for the realized closed-only number. Needs `readOpenManagedPositions(dbPath)` — a `status IN ('ACTIVE','PARTIAL')` mirror of Component 3's closed reader returning `unrealizedPl, entryPrice, quantity, agentStrategy, createdAt`.

### 3.4 Bootstrap edge CI — `bootstrapExpectancyCI(perTradePnl, { B = 10000, alpha = 0.05 })`
Pure. Resamples the per-trade friction-adjusted P&L array with replacement, returns `{ mean, lo, hi, n }` (percentile 95% CI). This is the **demonstrated-edge** statistic 2c gates on — a count floor cannot tell edge from luck. Seeded RNG for deterministic tests.

### 3.5 Output
`buildLedgerReport(perAgent)` → JSON (the shape 2c consumes: per-agent eligible/all-closed blocks, expectancy@1×/@2×, per-trade array, bootstrap CI, marked-equity) + `renderLedgerMarkdown(report)` (per-agent table). CLI: `node scripts/trade-ledger.mjs [--agent <id>]`, resolves sandboxes via Component 3's `resolveSandboxDbPaths`, prints markdown.

### 3.6 Tests (real + synthetic)
Adapter maps fields + sets `reasoning='stopped out'` iff derived stop; **2× stress leaves deterministic fees unchanged** (assert commission identical at 1×/2×, slippage doubled); expectancy/win-rate/profit-factor on synthetic trades; **profit-factor `null` on zero losses**; **expectancy@2× ≤ expectancy@1×**; eligible/quarantined partition; marked-equity aligns populations + subtracts entry-side friction; `readOpenManagedPositions` filters ACTIVE/PARTIAL (temp-DB, real schema); seeded `bootstrapExpectancyCI` reproducible + widens with smaller n. **Real-data smoke on the Coil sandbox** (`sbx_mean_rev`) — **note (D-C14): with the eligible set empty pre-deploy, this validates the *plumbing* and the all-closed/quarantined block, NOT the eligible computation that feeds graduation.**

## 4. Component 2b — beta / orientation (SPEC ONLY)

### 4.1 `alpaca-spy-daily.mjs` — SPY daily closes from Alpaca
- `GET https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Day&start=<ISO>&end=<ISO>&adjustment=split`; headers `APCA-API-KEY-ID: $ALPACA_PUBLIC_KEY`, `APCA-API-SECRET-KEY: $ALPACA_SECRET_KEY` (project-root `.env`, sourced — not exported to shell). **Alpaca not FMP** (D-B6). **`adjustment=split`** (not `all`): split-only keeps SPY a *price* return, matching the strat P&L series (total-return SPY would bias beta).
- **Re-fetch the full window every run** (a quarter ≈ 60 daily bars — cheap), rather than "fetch only missing dates." This avoids the corporate-action restatement trap (adjusted bars re-state history; a partial cache mixes stale and fresh closes at the boundary and silently bends beta). The on-disk cache (`data/cache/spy_daily.json`) is an **offline fallback only**; on fetch failure, return cache and **set a per-date `gap` flag**.
- Paginate via `next_page_token`. Return `{ dates: ['YYYY-MM-DD'(ET) ordered], close: {date→close}, gaps: Set<date> }`.
- Tests (mocked fetch): pagination assembly; ET-date bucketing; full-window re-fetch; soft-fail returns cache + flags gaps; `adjustment=split` in the request.

### 4.2 `segment-beta.mjs` — daily returns + beta (with CIs)
- `readSegmentDaily(dbPath, strategy)` — `node:sqlite` read-only over the `DBSegmentPnL` table (**gorm table name to confirm at build — likely `db_segment_pn_ls`**); columns `strategy, date, realized_pnl, unrealized_pnl, deployed_percent, portfolio_value`, ordered by date.
- **Component-1 contract (verified in `segment_pnl_writer.go`):**
  - `realized_pnl` is the **day's realized increment** (`GetManagedClosedPnL` over `closed_at ∈ [dayStart,dayEnd)`), **not cumulative** → it is *added*, not differenced. A `assertNotCumulative(rows)` guard **fails loudly** if the realized series looks monotone/cumulative (cheap insurance against a future writer change).
  - A row is written **every weekday for every known strategy even when flat (0/0)** → the prior-day `unrealized_pnl` needed for differencing exists on idle days. (Writer gates on weekday, not holiday; a holiday row harmlessly fails to align with SPY.)
  - `portfolio_value`/`unrealized_pnl` are **EoD** (read post-16:00 ET) and `portfolio_value` is the **shared whole-account** value → the series is the strategy's *contribution-to-account* return (a valid orientation read).
- `computeDailyReturns(rows, spy)` — **`r_d = (realized_pnl_d + (unrealized_pnl_d − unrealized_pnl_{d−1})) / portfolio_value_{d−1}`** (divide by **prior-day** EoD equity = start-of-day-d, the time-weighted convention). **Gap-aware (D-B7):** emit `r_d` only when `date_{d−1}` is the immediately-preceding entry in `spy.dates` **and neither date is in `spy.gaps`**; drop/flag otherwise — distinguishing "real non-trading day" from "SPY data outage" so an outage doesn't silently delete real observations.
- `computeBeta(stratReturns, spyReturns, filterFn)` — OLS slope `cov/var` over filtered date-aligned pairs **plus a bootstrap 95% CI** on the slope. Three reports: **deployed** (`deployed_percent > 0` days), **unconditional** (all), **downside** (`spy_return < 0`; confirmation-only per D-B5). Below `MIN_BETA_DAYS` (§7) → `{ insufficient: true, n }`.
- Tests (synthetic): gap-aware drop of a spanning observation **and** of an SPY-gap observation (distinct flags); `pv_{d−1}` denominator; deployed/unconditional/downside on a known-slope series + CI width vs n; insufficient-sample guard; `assertNotCumulative` fails on a monotone series.

## 5. Component 2c — graduation bar, two tracks (SPEC ONLY)

`graduation-gate.mjs` first assigns each agent a **track by structural classification** (declared a-priori, not measured):
- **ALPHA track** — directional edge agents (Coil mean-reversion, Turtle-v2 trend). Value = a positive-expectancy edge that is also low-beta.
- **BALLAST track** — convex hedge sleeves (defensive-Prophet triggered put-spreads, optional slow long-vol ETF). Value = crisis-conditional payoff; **negative expectancy is expected and is NOT disqualifying.**

### 5.1 ALPHA-track criteria (all must clear)
1. **Volume:** ≥ `N` eligible closed trades.
2. **Demonstrated edge:** the §3.4 **bootstrap CI lower bound on per-trade friction-adjusted P&L (net of 2× friction) > 0** — edge distinguishable from luck, not merely positive in sample.
3. **Adversity present:** `significance-gate.evaluateGate` cleared (≥5 losses OR ≥5% drawdown per class) — a sanity floor that the sample *contains* downside, complementary to (2), not a substitute.
4. **Duration:** ≥ 3 months from earliest to latest eligible entry.
5. **Orientation in-band (on the CI, not the point):** the **deployed-beta 95% CI is entirely within ±`BETA_BAND`** (graduate); **REJECT only if the CI lower bound on |β| exceeds `BETA_BAND`** (demonstrably a closet-beta play); otherwise HOLD (too wide to tell). Report n + point + CI.

### 5.2 BALLAST-track criteria (expectancy is NOT a gate)
1. **Structural convexity:** defined-risk long-premium/put-spread construction (by classification) — verified, not measured.
2. **Bounded bleed:** expectancy ≥ −(annual hedge budget ÷ trades-per-year) — the hedge may bleed, but no more than its allocated budget (dollar budget set at defensive-Prophet sizing; the *form* of the test is pinned here).
3. **Stress payoff:** **downside-beta CI upper bound ≤ 0** (pays or neutral on SPY-down days) **when** deployed∩down-day sample suffices; **else structural-only** (D-B5 — crash samples are too sparse to gate on, so absence of a reading is HOLD, never REJECT).
4. **Duration:** ≥ 3 months.

### 5.3 Verdicts
- **GRADUATE** — all track criteria clear.
- **HOLD** — still accruing (volume/duration/sample) with nothing failed, **and within the retire deadline**.
- **REJECT** — a hard criterion fails (alpha: edge-CI ≤ 0, or orientation CI-lower-bound out-of-band; ballast: unbounded bleed, or downside-beta CI lower bound > 0 i.e. it *adds* crash risk).
- **RETIRE** — HOLD past the pre-registered deadline (§7) without a graduation case — a low-cadence strategy cannot sit in HOLD forever.

Report lists each criterion's pass/fail + the blocking reason. **Never auto-acts** — operator-reviewed.

## 6. Pre-registered decisions

- **D-C1 — 2a now, 2b/2c spec-only** (real-data readiness; 2b unvalidatable for ~a quarter).
- **D-C2 — friction via adapter reusing `apply-friction`; stop-out from Component 3's derived reason** (D-B8), with the `pct<0` co-condition and flat-gap-haircut limitations noted (§3.1).
- **D-C3 — ledger partitions eligible vs quarantined;** graduation uses eligible-only; all-closed shown for context.
- **D-C4 — SPY from Alpaca data REST, `adjustment=split`, full-window re-fetch each run** (D-B6; avoids restatement staleness), keys sourced from `.env`.
- **D-C5 — the SPY date sequence (minus SPY gaps) is the trading-day calendar** for gap-aware differencing (D-B7); SPY-gap vs non-trading-day are distinct flags.
- **D-C6 — secondary marked-equity expectancy** with aligned eligibility + entry-side friction on the open leg (hold-losers bias, spec §5).
- **D-C7 — standalone agent-agnostic scripts**, reusing `review-performance`'s building blocks; the Prophet skill is not modified.
- **D-C8 — two graduation tracks** (alpha = positive-expectancy edge; ballast = convex + bounded-bleed + stress-payoff). Expectancy is not a gate on the ballast track; hedges reach capital by graduating the ballast track, not by fiat.
- **D-C9 — orientation and edge gate on bootstrap CIs, not point estimates** (the binding-constraint legs get real error bars).
- **D-C10 — demonstrated edge = bootstrap CI lower bound > 0**; `evaluateGate` retained only as an adversity-present floor.
- **D-C11 — 2× stress doubles only uncertain frictions** (slippage/gap-through/spread), never deterministic fees.
- **D-C12 — daily return denominator is `pv_{d−1}`** (verified `portfolio_value` is EoD whole-account).
- **D-C13 — `realized_pnl` is a daily increment** (verified) → added not differenced; guarded by `assertNotCumulative`.
- **D-C14 — today's Coil smoke validates plumbing, not the eligible/graduation math** (eligible set empty pre-deploy).
- **D-C15 — cutoff is Component 3's pinned `PART_A_DEPLOY_CUTOFF = 2026-05-31`** (the Part-A trustworthiness boundary, justified there) — not re-pinned here.

## 7. Pinned parameters (a-priori, set NOW before any data exists)

Pre-registered while there is **no beta/edge data to tune to** — the correct time to fix them.
- **`N` (min eligible closed trades) = 20.** ~3 months at Coil's ~10 trades/month ≈ 30, so 20 is reachable; the bootstrap edge test (5.1.2) carries the demonstrated-edge weight, so `N` is only a volume floor, not the rigor.
- **`BETA_BAND` (alpha deployed-beta) = 0.6** (operator-set 2026-05-31). An "uncorrelated-ballast" equity agent must not be a closet long-beta play; 0.6 sits between a strict 0.5 and a permissive 0.7 — comfortably below market beta (1.0) while not punishing a low-but-nonzero directional tilt. Pinned a-priori (no beta data exists to tune to).
- **`MIN_BETA_DAYS` = 30 deployed days.** Below ~6 weeks of deployed observations even a CI is too wide to inform; report `insufficient` rather than a gated beta.
- **Retire deadline = 6 months** from the first eligible trade (2× the 3-month minimum) without a graduation case → RETIRE.
- **Ballast bleed budget** — *form* pinned (expectancy ≥ −budget/trades-per-yr); the *dollar* budget is a sizing decision set when defensive-Prophet is built.
- **Bootstrap** `B = 10000`, 95% percentile CI, seeded.

## 8. Out of scope
- Options/convex friction model (`apply-friction` drops options; flat stop-gap haircut) — built with defensive-Prophet, per parent §7.
- Editing the `review-performance` skill or any live Go path.
- Auto-acting on verdicts — always operator-reviewed.
- 2b/2c implementation — this effort builds 2a; 2b/2c are this spec's follow-up.
