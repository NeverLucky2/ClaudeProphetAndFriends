# Fleet Correlation Diagnostic — Design Spec

**Date:** 2026-06-06
**Status:** Design approved (brainstorm); pending writing-plans.
**Type:** Pre-registered lab diagnostic (lightweight prereg, no holdout). Read-only. No runtime/deploy impact.
**Subproject:** 1 of 2 in the "uncorrelated ballast" arc. This is the GATE before any new premium (Subproject 2).

---

## 1. Purpose & one-line frame

The binding constraint on the agent fleet is **its correlation to the user's net worth** (a concentrated mega-cap tech book), not any single agent's standalone edge. The fleet's job is *uncorrelated ballast* to that book, judged on crash-conditional / risk-adjusted behavior — not on beating NVDA. (See memory `fleet-uncorrelated-ballast-pivot`.)

**This diagnostic measures whether the four current lanes are actually uncorrelated** — to each other and to the tech book (QQQ) — with special attention to the tail, because the EMA-pullback and ORB studies both taught the same lesson: a strategy can look uncorrelated/edge-positive on average while secretly carrying harvested equity beta that only shows up in the down-state.

**Deliverable:** a correlation matrix among the four lanes + each lane's β/correlation to QQQ + a **crisis-conditional cut** (QQQ worst-quintile weeks primary), yielding a per-lane classification (genuine_ballast / mild_overlap / overt_long_beta, from full-sample β + CI) plus a descriptive crisis tail-behavior note, and an explicit **ballast-gap finding** that tells Subproject 2 what shape of premium to go find. (NB: the crisis-cut statistic was reframed from a surrogate-gated "secret long-beta" label to a descriptive lens — see §6.3.)

**The fleet (four lanes):**
- **Coil** — RSI(2) short-horizon mean-reversion on large-cap equities (`sbx_mean_rev`). The one validated edge.
- **Turtle** — Donchian cross-asset trend on 15 macro ETFs (rates/metals/energy/commodity/fx/intl-equity).
- **Drift** — PEAD / post-earnings continuation on large-cap equities.
- **defensive-Prophet** — triggered defined-risk QQQ put-spread hedge (long-vol).

## 2. Critical data caveat (why we reconstruct, not measure)

Per-agent **live** P&L is unusable: the `DBSegmentPnL` daily-mark writer only merged ~2026-05-31 (≈1 week of series), the shared Alpaca account isn't per-agent-segmentable, and the earlier cross-agent-correlation diagnostic was BLOCKED for exactly this reason (memory `cross-agent-correlation-view-blocked`). 

**Approach: RECONSTRUCT each lane's return stream by backtesting its strategy logic** over a common multi-year window on the on-disk equity/ETF + FMP data we already have, then correlate the reconstructed streams. **No new data/API.**

## 3. Approved decisions (from the brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| **Return representation** | **Daily mark-to-market** per lane → aggregate to **weekly** for analysis | Realized-at-exit curves (Coil's current portfolio sim) lump a multi-day trade's P&L onto its exit day, destroying the day-to-day co-movement structure — the exact hidden beta we're hunting. Weekly grain matches the crisis definition, tames asynchronous-trading noise across four strategies that fire on different days, and still rests on an honest daily foundation. Daily-grain correlation reported as robustness. |
| **defensive-Prophet treatment** | **Structural-light** | Its real trigger (the 4-skill `regime_gate` composite of breadth/macro/top-risk/bubble) is not historically reconstructable (those skill inputs don't exist back-in-time), and it is the *one* lane diversifying *by construction*. A full proxy reconstruction would be dominated by an arbitrary proxy-trigger choice (low information, high assumption-variance). So: document its designed orientation; build a transparent price-only proxy (§5.5) used ONLY in the crisis-conditional cut as a structural payoff sanity check (no timing-coverage inference) — never a headline full-sample number. |
| **Window** | **Two-tier** | Headline 4-way matrix on the **2022–2026 common window** (no rebuild; covers the 2022 bear + 2025 tariff selloff). Separately extend Coil/Turtle/def-Prophet back to **2016** for the crisis-conditional tail cut so it sees 2018Q4 + 2020 COVID. Drift stays 2022+ (its earnings/catalyst data on disk starts 2022) and is flagged lower-confidence. Best tail coverage for modest extra work (the Coil-tape rebuild is just a wider start date). |
| **Benchmark** | **QQQ** primary, **SPY** reference | QQQ proxies the user's mega-cap tech book. |
| **Prereg weight** | **Lightweight** (like coil-options-overlay) | No parameter optimized, no edge graduated → no holdout/train-test. The spec IS the pre-registration: commit methodology (window, representation, crisis def, β/corr methods, per-lane simplifications) before computing any correlation; hash that block. |
| **Regime gate in reconstruction** | **Neutral** | `ENABLE_REGIME_GATE=false` live → sizing multiplier 1.0, no blocking. One less thing to historically fake. |
| **Friction** | **Gross daily marks** (Coil tape already net) | Friction is a *level* effect, not a *co-movement* effect — it does not change correlation structure, the deliverable. Out of scope, documented. |

## 4. Pipeline shape

```
per-lane daily-marked sim  ─┐
                            ├─► common daily index ─► weekly aggregation ─► { corr matrix, QQQ β (full+downside), crisis-conditional cut, rolling corr, bootstrap CIs } ─► RESULTS.md
QQQ/SPY benchmark returns ──┘
```

The per-lane sims are ~80% of the work (as predicted in the handoff). Each lane produces a **daily strategy return series** `r_t = ΔequityValue / equity_{t-1}`, marked at daily closes, with real per-lane sizing so magnitudes are honest (β needs real magnitudes). On days a lane holds nothing, `r_t = 0`.

## 5. Per-lane reconstruction

Each lane is modeled at its **return-generating core** faithfully, with **every simplification explicitly listed** — the goal is an honest return *shape*, not a bit-exact runtime P&L replay.

### 5.1 Turtle (TREND) — faithful mechanical port [easiest]
- **Source of truth:** `services/trend_signal_service.go` (Donchian/SMA/Wilder-ATR), `services/turtle_executor.go` (entry/exit/sizing/gates), `models/trend_universe.go` (15 ETFs + clusters).
- **Entry (long-only):** `last_close > Donchian100High` AND `last_close > SMA200` AND `ATR20/last_close ≥ 0.005`. (Donchian channels exclude the last bar, per the Go logic — replicate exactly.)
- **Exit:** `today_open ≤ Donchian50Low` (trailing stop) OR (`days_since_entry ≤ 20` AND `today_open ≤ entry − 2·ATR_at_entry`) (initial hard stop).
- **Sizing:** `position_$ = (portfolio·0.005) / (2·ATR / last_close)`, capped at `portfolio·0.04`. Non-compounding fixed base for the lab (consistent with Coil's fixed-fractional convention).
- **Gates modeled (correlation-relevant — they shape *which* positions are held):** position cap (6), one-position-per-cluster cap (6 clusters).
- **Gates SIMPLIFIED OUT (documented):** the 60-day return correlation-guard (ρ>0.70), the 2.5% aggregate-risk cap, the −2% segment circuit-breaker. These rarely bind and add disproportionate complexity; their omission is noted in RESULTS.
- **Universe:** TLT/IEF/TIP, GLD/SLV, USO/UNG, DBC/DBA/DBB, UUP/FXE/FXY, EEM/EFA. All 15 exist by ≤2011 → fine for a 2016 start.
- **Window:** 2016–2026.
- **Risk:** low.

### 5.2 Coil (MEANREV) — reuse + daily re-mark [easy-ish]
- **Source of truth:** `data/lab/coil-threshold-instances.json` (RSI(2) trade tape), `scripts/coil-threshold-build.mjs` (tape builder), `scripts/coil-threshold-portfolio.mjs` (sizing overlay).
- **Step 1:** rebuild the tape over **2016–2026** (wider start date on `coil-threshold-build`; current tape starts 2021-05 by config, not data limit).
- **Step 2:** **re-mark daily** — each open trade contributes daily P&L from the underlying's daily bars between `entryDate`→`exitDate`; overlay the real portfolio sizing (5%/pos, ≤4 positions, 24% deploy cap, most-oversold-first) from `coil-threshold-portfolio` but **daily-marked, not realized-at-exit**.
- **Entry-day mark convention (avoid a crisis-cut bias):** the day-0 mark uses the tape's `entry` fill price as the reference and close-to-close thereafter, matching the tape's `grossReturn` (entry→exit) definition exactly. RSI(2) entries cluster on sharp down days (which correlate with down-QQQ days), so a close/open mismatch on the entry bar would inject a systematic first-day bias straight into the crisis cut — the mark MUST use the tape's own entry reference, not the signal-day close.
- **Entry tape semantics (already in the tape):** RSI(2) deep-oversold + close>SMA200 + close<SMA5 + no earnings within 5 trading days. Exits: `rsi_mean_cross` / `time_stop`.
- **Window:** 2016–2026.
- **Risk:** low (only the accrual grain changes).

### 5.3 Drift (PEAD) — port the event sim [medium, lower-confidence]
- **Source of truth:** `services/drift_signal_service.go` (5-factor score + PEAD + continuation), `TRADING_RULES_DRIFT.md` (entry filter + exits + sizing).
- **Entry (long-only):** `gap_pct ≥ +3.0` AND `ma200.above_ma` AND `ma50.above_ma` AND `composite.grade ∈ {A,B}` AND (`continuation.is_continuation` OR `pead.stage ∈ {SIGNAL_READY, BREAKOUT}`). **Continuation ON** — matches the user's 2026-05-30 live `ENABLE_DRIFT_CONTINUATION=true` enable.
- **Exits (any fires):** +20% target / −10% stop / 60-trading-day time stop / MA50 break (`ma50.above_ma` becomes false).
- **Sizing:** 4%/pos, ≤3 open positions, 12% lane cap; one position per ticker per earnings cycle.
- **Event stream:** the 2022+ earnings/catalyst data on disk (`data/lab/catalysts/*` and/or FMP earnings calendar) + large-cap EOD bars. Universe = `DriftUniverse` (reuses the Coil large-cap universe).
- **Window:** **2022–2026 only** (earnings data floor). Drift correlations computed on this shorter overlap.
- **Risk: medium, inherently lower-confidence.** Drift is sparse (event-gated, ≤3 positions); its weekly series is mostly zeros punctuated by a handful of trades. Its β/correlation estimates carry wide error bars — **reported as such, not as false precision.** This is honest, not a defect.

### 5.4 Benchmark
- **QQQ** (primary) + **SPY** (reference). Daily→weekly returns on the same grid.

### 5.5 defensive-Prophet (proxy) — structural-light [most assumption-laden]
- **Designed identity (stated qualitatively):** triggered defined-risk QQQ put-spread, long-vol, negatively correlated to QQQ in tails *by construction* (reuses `regime_gate.json` trigger + `mleg` + Harvest lifecycle in production).
- **Proxy reconstruction (transparent, price-only):** trigger = **QQQ close < its 200-DMA**. While triggered, hold a defined-risk QQQ put-spread (e.g., ~5%-OTM long / ~15%-OTM short, ~1–2 month tenor); price it **daily via BSM** (reuse `coil-opt-*` BSM pricer with a trailing-RV IV estimate); close on trigger-off or expiry; daily-mark.
- **Usage constraint (revised — no timing inference):** the 200-DMA proxy is a *lagging, whipsaw-prone* trigger that can miss fast tail events (2020 COVID broke the 200-DMA in days; 2018Q4 was a slow grind), so its *trigger timing* is untrustworthy and we draw **NO** crisis-coverage conclusion from it. def-Prophet's contribution is therefore only: (a) a qualitative statement of its designed convexity (long-downside put-spread), and (b) an OPTIONAL conditional-payoff sanity check — *given* the spread is on, does its BSM-priced payoff behave convexly in down-QQQ weeks (a near-tautological check that the pricing mechanics are right). **Never** a headline full-sample number; **never** used to claim the hedge "covers" the same tails the other three co-move in.
- **Caveat (stated loudly in RESULTS):** the proxy ≠ the real 4-skill regime gate; trigger threshold, strike widths, tenor, and IV assumption all move it. It is a structural payoff sanity check — NOT a measurement and NOT a timing-coverage claim.
- **Window:** 2016–2026 (price-only, so unconstrained).

## 6. Analysis engine & deliverable

All on **weekly** returns off the daily-marked curves. Five outputs, ordered by importance:

1. **Full-sample correlation matrix** — the **three edge lanes (Coil / Turtle / Drift)** × each other + vs QQQ/SPY. **Pearson AND Spearman** (rank-corr is robust to the fat tails). **Each cell reports its own n (overlapping weeks)** — support is ragged (Drift cells 2022+ only). **def-Prophet is deliberately excluded from this full-sample headline matrix** (per the structural-light decision, §5.5) — it enters only at the crisis-conditional cut (output 3) with a proxy label. So the headline matrix is 3 edge lanes + 2 benchmarks; def-Prophet is the 4th lane but reported separately where it's meaningful.
2. **Beta to QQQ per lane — the accidental-long-beta detector.** OLS β + R² on weekly returns (reuse `ema-beta` `olsBeta`). β≈0 / low-R² = genuine ballast; positive β = the secret-long-beta failure mode the EMA/ORB studies kept catching. **Two interpretation guards:** (i) β levels are **gross, not net-economic** — friction leaves correlation ~invariant but compresses return magnitude asymmetrically (Coil's many small round-trips eat more friction per dollar of move than Turtle's few large trend trades), so a gross-β "low beta" reading must not be quietly treated as a net-economic statement; (ii) for **sparse lanes** the full-series β is mechanically attenuated toward zero by zero-inflation — read it via the active-week-conditional cut below, not the full series.
3. **Crisis-conditional cut — the centerpiece (descriptive lens; surrogate = context band, not a gate).** Crisis bucket **PRIMARY = QQQ worst-quintile weeks**; worst-decile as a secondary tail-sharpness check (interpreted only where effective n ≥ the §11 floor). Per lane:
   - **Crisis-conditional MEAN return** with a bootstrap CI — the PRIMARY, robust ballast metric (positive = cushions QQQ's worst weeks; CI entirely below 0 = co-crashes). This carries the read, not β.
   - **ρ_crisis and downside β** reported as DESCRIPTIVE numbers shown BESIDE a **rotation context band** — the p5/p50/p95 of the same stat when the lane is rotated against the fixed QQQ + fixed crisis weeks (how much the crisis selection manufactures under no real dependence). An observed value beyond [p5,p95] is *suggestive* of genuine tail co-movement, never a binary verdict.
   - An explicit **insufficient-power flag** wherever crisis effective-n is small (the rotation band widens → the diagnostic honestly can't distinguish from the selection artifact).
   - (def-Prophet enters here only as the §5.5 structural payoff sanity check — no timing claim.)

   **Why descriptive, not a surrogate-gated binary label (decided 2026-06-06 after a build-time empirical check).** The originally-specified downside-β-JUMP (Δ = downside β − full β) gated by a rotation surrogate proved underpowered: β over the crisis weeks divides by a tiny `var(QQQ|crisis)` → a leverage-explosive, non-centered null; and when crisis weeks dominate the full-sample variance, the jump shrinks toward zero for a genuine tail co-move. At our crisis-week counts (~22 weeks for the 2022–26 quintile, ~110 for 2016–26) a crisp binary tail-beta label is not supportable. The rotation surrogate is **KEPT** — but as a **context band** beside the descriptive crisis stats (its original purpose per the reviewer: prevent over-reading), not as a verdict generator. The full-sample β (output 2, with bootstrap CI) remains the primary accidental-long-beta detector.
4. **Rolling 26-week correlation to QQQ** (secondary) — spot regime-drift (more correlated post-2022?). Light.
5. **Synthesis — characterization, NOT a binary verdict.** Per-lane classification from the **full-sample β + its bootstrap CI** (output 2): **{genuine_ballast** (β small / CI brackets 0) **/ mild_overlap / overt_long_beta** (β meaningfully positive, CI clears 0)**}**, PLUS a **descriptive tail-behavior note** per lane — crisis-conditional mean sign, and whether ρ_crisis / downside β sit beyond their rotation band, carrying the insufficient-power flag where relevant. This surfaces the "looks like ballast on average but co-crashes in the tail" pattern as a *flagged caveat*, not a hard label. PLUS the **ballast-gap finding**: map each lane to its dominant risk driver (Coil=equity mean-rev, Turtle=cross-asset/non-equity trend, Drift=equity momentum, def-Prophet=long-vol hedge) and show where the fleet is concentrated vs spread. If all lanes cushion/co-move together in equity selloffs → that's the gap, and it tells Subproject 2 what to go find.

**Sparse-lane handling (Drift, def-Prophet proxy).** A lane that is flat in a large fraction of weeks (Drift is event-gated; the proxy is mostly off) has a full-series Pearson/Spearman correlation to QQQ that is **mechanically attenuated toward zero** — the zeros dominate the covariance terms and collapse the Spearman rank structure (ties). Reporting that attenuated number as "uncorrelated" would re-create the exact false-uncorrelated trap the diagnostic exists to catch, except as a *sparsity artifact* rather than harvested beta. So **for any lane with >40% zero-exposure weeks in a window, the active-week-conditional metric is PRIMARY**: correlation/β computed only over weeks the lane holds ≥1 position. The full-series number is still shown, explicitly flagged as zero-inflation-attenuated, never the basis for a "genuine ballast" call.

**Honesty guards (ORB/EMA discipline):**
- Block-bootstrap CIs on headline correlations/βs (reuse `coil-threshold-metrics`; blocks over weeks to respect autocorrelation).
- Report the matrix on **both** windows (4-way 2022+; 3-way-to-2016) so window-sensitivity is visible.
- Magnitude caveat stated loudly: reconstructed **paper** returns — co-movement is the signal, absolute levels are not.
- Pre-commit (and hash) the crisis definition / window / methods before scoring, so the narrative can't be p-hacked.

**Output:** `docs/lab/fleet-correlation-RESULTS.md` (committed) — the three tables (corr matrix, β table, crisis-conditional table) + rolling-corr summary + synthesis + ballast-gap call. Intermediates in `data/lab/*` (git-ignored).

## 7. Reuse map (local main only)

The reused lab modules live on **local main**, not origin — the worktree branches from local main.

- `ema-beta.mjs` → `olsBeta` / `dailyReturns` / `residual`
- `coil-threshold-metrics.mjs` → block-bootstrap CIs
- `coil-threshold-build.mjs` / `coil-threshold-portfolio.mjs` → Coil tape rebuild + sizing overlay
- `coil-opt-*.mjs` (BSM) → def-Prophet put-spread pricing
- `ema-fetch-bars.mjs` pattern → FMP EOD fetch/cache

## 8. New modules (TDD; pure-function core + controller-authored data-glue CLIs)

Per the ORB lesson, the fiddly data-coupled CLIs (SPY-map / per-name glue) are controller-authored verbatim; pure modules are built by Haiku subagents under TDD.

1. `fleet-fetch-bars` — EOD daily bars for 15 ETFs + Coil/Drift large-caps + QQQ/SPY (FMP).
2. `fleet-turtle-sim` — Donchian long-only sim → daily-marked return series.
3. `fleet-coil-marks` — daily re-mark of the Coil tape + portfolio overlay → daily return series.
4. `fleet-drift-sim` — PEAD event sim (continuation ON, 4 exits) → daily return series, 2022+.
5. `fleet-defensive-proxy` — QQQ<200DMA trigger + BSM put-spread daily marks → daily return series.
6. `fleet-align` — project all lanes + benchmark onto a common daily index; aggregate to weekly.
7. `fleet-correlate` — corr matrix (Pearson/Spearman; full-series + active-week-conditional for sparse lanes), β (full + crisis-bucket downside), crisis-conditional cut with the **circular-rotation surrogate null** + effective-n floor, rolling corr, block-bootstrap CIs.
8. `fleet-prereg` — write + hash the methodology block before scoring.
9. `fleet-report` — render `docs/lab/fleet-correlation-RESULTS.md`.

Each pure module ships with a `*.test.mjs` (node:test, RED-first).

## 9. Scope boundaries (YAGNI)

- **In:** reconstruct 4 lanes → weekly correlation/β/crisis cut → characterization + ballast-gap finding.
- **Out:** live P&L; new data/API; options-data purchase (def-Prophet uses BSM model pricing); PCA/factor-model decomposition (overkill for 4 lanes — β + crisis cut answers it; deferred if the fleet grows); friction (a level effect, not co-movement); ANY agent/runtime/deploy change.
- **Gross returns** (Coil tape already net); friction documented as out-of-scope (correlation is ~friction-invariant; reported **β levels are gross, not net-economic** — see output 2 guard (i)).
- def-Prophet **structural-light**, not full reconstruction.

## 10. Process

- **Isolated git worktree branched from LOCAL main** (not origin/main; reused modules live on local main only). Re-assert the branch before any git mutation (the shared-root-worktree-collision lesson).
- **Subagent-driven development**, **Haiku** implementers (memory `subagent-model-preference`); subagents need ABSOLUTE worktree paths.
- **TDD throughout** (RED first, verify failure, then GREEN), node:test.
- Source the project-root `.env` for `FMP_API_KEY` before any FMP script.
- **Squash-merge to local main** when done; `data/lab/*` git-ignored, only `docs/lab/fleet-correlation-RESULTS.md` committed.
- Everything stays paper/lab — do NOT touch live agents.

## 11. Pre-registration block (to be hashed by `fleet-prereg` before scoring)

Committed BEFORE any correlation is computed:
- **Windows:** headline 4-way = 2022-01-01→2026-06-06; crisis 3-way extension (Coil/Turtle/def-Prophet) = 2016-01-01→2026-06-06; Drift = 2022+ only.
- **Return representation:** daily mark-to-market → weekly aggregation; gross.
- **Benchmark:** QQQ primary, SPY reference.
- **Crisis definition:** PRIMARY bucket = QQQ **worst-quintile** weeks; worst-decile = secondary tail-sharpness check, interpreted only where the effective-n floor is met. Computed within each applicable window.
- **Effective-n floor:** effective n = count of **nonzero-exposure lane-weeks** within the crisis bucket. A crisis cell with effective n < **8** is reported as "insufficient support" — no point estimate, no CI. (Pre-committed so the decile→quintile choice is not a post-hoc researcher degree of freedom.)
- **Crisis primary metric:** crisis-conditional **mean return** with a bootstrap 95% CI (the robust ballast read — cushion vs co-crash). ρ_crisis and downside β are DESCRIPTIVE, reported beside a rotation context band.
- **Rotation context band (NOT a gate):** K=**1000** circular-rotation surrogates per lane (random offset vs the fixed QQQ week sequence + fixed crisis indices; preserves lane marginal + autocorrelation, destroys QQQ cross-dependence), recomputing the conditional stat (ρ_crisis or downside β) under no real dependence → {p5,p50,p95}. An observed stat beyond [p5,p95] is *suggestive* of genuine tail co-movement, paired with the effective-n flag; it does NOT mint a binary label. (The downside-β-jump-gated label was dropped 2026-06-06 as empirically underpowered.)
- **Sparse-lane rule:** any lane with **>40% zero-exposure weeks** in a window (expected: Drift, def-Prophet) is read PRIMARILY via **active-week-conditional** corr/β (computed only over weeks the lane holds ≥1 position); the full-series number is a zero-inflation-attenuated reference, flagged, never the basis for a "genuine ballast" call.
- **Methods:** Pearson + Spearman correlation; OLS β (full-sample with block-bootstrap CI = the primary accidental-long-beta detector; crisis-bucket downside β descriptive vs the rotation band); crisis-mean bootstrap CI.
- **Per-lane modeling simplifications:** as enumerated in §5 (Turtle's 3 omitted gates; def-Prophet proxy trigger/strikes/IV + no-timing-inference; Drift continuation-ON + 2022 floor + **continuation-path-only — the rarely-reachable weekly-PEAD-ready path is omitted** (the Go code notes `pead.stage` is "rarely reachable inside the current candidate window"); regime gate neutral; Coil entry-day mark = tape `entry` reference).
- **Pre-committed acceptable findings:** "fleet is secretly correlated to QQQ," "diversification evaporates in crisis weeks," and "large equity-selloff ballast gap" are all valid, expected-possible outcomes. The diagnostic may indict the fleet.

## 12. Open items for the implementation plan (writing-plans pins these)

- Exact earnings event-stream source for Drift (on-disk `data/lab/catalysts/*` schema vs an FMP earnings-calendar fetch) and how AMC/BMO timing is resolved historically.
- def-Prophet proxy: confirm strike widths / tenor / IV-estimate from the `coil-opt-*` BSM signatures.
- Whether `ema-fetch-bars` is generic enough to reuse directly for `fleet-fetch-bars` or needs a thin wrapper.
- FMP EOD row caps (`stable/historical-price-eod/full` ~5000 rows ≈ 20y daily — non-binding for a 2016 start, but confirm per-symbol coverage for the older ETFs).
- Surrogate mechanics: confirm circular-rotation seam handling (wrap-around discontinuity is acceptable at weekly grain; block-bootstrap is the fallback if it proves material) and that "active week" = ≥1 open position is the right exposure definition per lane (Coil/Turtle by open positions; def-Prophet by trigger-on).
