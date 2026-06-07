# Fleet Hedge-Overlay Lab Study (Subproject 4) — Design

**Date:** 2026-06-06
**Status:** Design approved; revised after external Claude review (pre-implementation, pre-hash)
**Type:** Pre-registered, lab-only, read-only quant study. No runtime, no deploy, no live-agent impact.
**Lineage:** Subproject 4 of the fleet uncorrelated-ballast program. Follows S1 (fleet-correlation
diagnostic — the GATE), S2 (CEF discount-reversion — REJECT), S3 (bond carry / curve roll-down —
REJECT). After three premium REJECTs on the same structural wall, the user chose the **hedge-gap
reframe (fork A)**: stop hunting an orthogonal *premium* for the equity-selloff gap and instead
*measure* which **hedge** most cheaply fills it. See memories `fleet-uncorrelated-ballast-pivot`,
`fleet-correlation-diagnostic-done`, `cef-discount-reversion-rejected`, `bond-carry-rolldown-rejected`,
`next-session-handoff`, `defensive-prophet-project`.

---

## 1. Purpose & the decision this feeds

**One sentence:** Rank four candidate equity-selloff hedges by **cost-adjusted crash efficiency**,
split by crisis regime, against both the user's reconstructed Merrill book and QQQ — to identify the
*cheapest effective* hedge (and its size), or to conclude honestly that none beats simply activating
the already-built def-Prophet.

**Why a hedge study, not a premium study.** S1 reframed the fleet's real hole as *equity-selloff
protection*. That gap is hedge-shaped: a thing that pays **when equities fall** has **negative**
expected carry by construction. No orthogonal *premium* can fill it (a true ρ≈0 premium just sits
there in the crash), and the premia that do pay (CEF discounts S2, bond carry S3, and paid options
merger-arb / FX-commodity carry) pay precisely **because** they bear risk-off risk — which is why
S2/S3 co-crashed or duplicated existing lanes. So this subproject explicitly switches grading
frameworks: from the premium **dual gate** (friction-net edge AND orthogonality) to the FdnB
**BALLAST track** (crash-conditional contribution + bounded bleed). A hedge is *supposed* to have
negative edge and negative tail-correlation; the question is **which one buys the most crash
protection per unit of calm-period cost.**

**What it feeds (and what it does NOT do).** Output is a **recommendation document**
(`docs/lab/fleet-hedge-overlay-RESULTS.md`). It feeds a *separate, user-driven* operational step —
flip `ENABLE_PROPHET_DEFENSIVE` ON and/or add a small static sleeve — graded later by Foundation B's
BALLAST track once a quarter of daily series accrues. **This study deploys nothing, touches no live
agent, and changes no runtime config.** Everything stays paper/lab.

## 2. Non-goals

- Not a live deployment, config change, or agent edit. (The operational activation is a later,
  explicitly user-approved step, out of scope here.)
- Not a premium hunt and not a dual-gate study. Negative carry and negative tail-correlation are the
  *point* of a hedge, not disqualifiers.
- Not a market-timing or trigger-tuning study. The def-Prophet proxy keeps its existing
  structural-light trigger; we do not optimize entry timing.
- Not a re-derivation of S1's lane diagnostics. We reuse the S1 engine; we do not re-run lane corr.
- Not an options-pricing research effort. The def-Prophet proxy reuses the existing BSM put-spread
  approximation as-is, with its documented caveats.

## 3. Targets (two, co-equal)

Both reported as co-equal headline targets so the hedge-sizing sensitivity to book composition is
visible.

### 3.1 Reconstructed Merrill book (primary honest target)
- Source: latest `data/portfolio/Holdings_*.csv` (latest COB date wins). Parse `Symbol`, `Quantity`,
  `Value ($)`.
- Weights: `w_i = Value_i / Σ Value` over included equity holdings.
- **Dynamic weekly renormalization:** for each week, include only the holdings that have bar data
  that week, renormalized to sum to 1. This keeps the book complete in the recent crisis-rich years
  (2020+, where 2022 rate shock and 2025 drawdowns live) while degrading gracefully before late-IPO
  names exist (PLTR 2020, COIN 2021, FOUR 2020). The mean and max dropped-weight fraction per era is
  reported in RESULTS.
- Exclusions / proxies: cash row (`ML DIRECT DEPOSIT PROGRM`, no symbol) excluded; `VFIAX` (mutual
  fund, no clean FMP daily bar) proxied by `VOO`; any holding with no FMP daily history dropped and
  its weight disclosed. Tiny dollar weights are *kept* (harmless), not dropped for size.
- **Disclosed approximation:** static current weights applied over history (ignores that past
  composition differed — e.g. TSLA was not always the largest position). This is a standard,
  acknowledged limitation, recorded in the prereg and RESULTS.
- Returns: daily close-to-close per holding → portfolio daily return = Σ wᵢ·rᵢ → weekly aggregation
  via `fleet-align`.

### 3.2 QQQ (continuity reference)
- The S1 book proxy, retained as a co-equal reference column so results tie back to S1 and to make
  the diversification gap between QQQ and the real book explicit.

### 3.3 Window
- **2016-01-01 → present** (matches S1's extension window). Captures the 2022 rate shock, 2020 COVID
  crash, and 2025 drawdowns. Weekly returns throughout (reuses `fleet-align` + `crisisWeeks`).

## 4. Candidates (four)

Each candidate produces a **daily return-contribution series** (return per $1 of book notional at a
given size `w`), combined as an **overlay**: `combined = book + w·(hedge − funding)`.

**Funding convention (revised — frictionless was wrong).** The hedge's capital is not free. Primary
model = **cash-funded at the risk-free rate**: `combined = book + w·(hedge_ret − r_f)`, with `r_f`
from the cached treasury `month3` (the fleet is cash-heavy and allocates its own capital, so the
honest opportunity cost of a hedge sleeve is the cash rate it displaces, not zero). Conservative
sensitivity bracket = **book-funded reallocation**: `combined = (1−w)·book + w·hedge_ret` (cost if the
sleeve were funded by selling book exposure — over a bull, tech-heavy window this is a *large*
opportunity cost). Both reported; the recommendation is read against the **conservative bound**. The
def-Prophet put-spread's capital cost is its premium itself (small notional), already in `costPct`, so
it carries no separate funding charge.

The grid parameter differs per candidate — **premium-at-risk** for the put-spread, **notional
fraction** for the static sleeves — and both map onto the common (drag, cushion) axes (§5). **Caveat
(convexity):** the put-spread is a capped, path-dependent, *convex* payoff and VIXM is convex with
roll, whereas GLD/TLT are ~linear — so their points on the common plane are **not equally
sample-robust** (a convex payoff's in-sample cushion depends on whether the observed crashes were
fast/deep enough to pierce the strikes). §5 adds a standardized **stress-shock payoff grid** for the
convex candidates so their structure is visible independent of in-sample crash shape, and §7 forbids
branch 4(a) from being won *by the put-spread* on in-sample cushion alone.

| # | Candidate | Construction | Size grid |
|---|---|---|---|
| 1 | **def-Prophet proxy** | Reuse `simulateDefensiveProxy` (QQQ<200DMA → BSM put-debit-spread, trailing-RV IV). Native triggered structure, unchanged. Convex, capped, path-dependent. | premium 0.5 / 1 / 2% of book |
| 2 | **Static GLD** | Buy-and-hold **real ETF EOD** daily returns (cached). ~Linear. | 2.5 / 5 / 10 / 15 / 20% of book |
| 3 | **Static TLT** | Buy-and-hold **real ETF EOD** daily returns (cached). Long duration, ~linear — its 2022 failure is a *finding*, surfaced by the regime split, not a trap. | 2.5 / 5 / 10 / 15 / 20% |
| 4 | **Static VIXM** (long-vol anchor) | Buy-and-hold **real VIXM EOD** daily returns (one FMP fetch). The ETF NAV embeds the roll yield / term-structure path — **no synthetic constant-bleed proxy**, so the brutal regime-dependent negative carry is captured correctly. Robust-but-costly ceiling: pays in any equity crash, heavy contango bleed. | 2.5 / 5 / 10 / 15 / 20% |

Combined-portfolio rescaling is linear in `w` for static sleeves and contract-count-scaled for the
spread, so the full grid is near-zero extra compute.

## 5. Metrics

Computed for every (candidate × size × target):

- **Cost = calm-period drag** (the critical revision). Drag is the annualized return difference of
  `combined` vs book-only computed **on the NON-crisis subsample only** (the ~80% of weeks not in the
  crisis set), under the §4 funding convention. This isolates the genuine carrying cost of the hedge
  in normal times. **Why non-crisis, not full-period:** full-period drag pulls the hedge's in-sample
  crash payoffs into the cost term while §5's cushion counts those same payoffs as benefit — circular
  double-counting that most rewards the convex put-spread that got luckiest in-sample (two crashes
  "paying for" years of premium would show as negative drag = fake `free_ballast`). Cost (non-crisis
  weeks) and cushion (crisis weeks) are now on **disjoint** week sets.
- **Benefit** = crash-conditional **cushion** = crisis-mean(combined) − crisis-mean(book-only), with
  a **paired-difference resample bootstrap CI** (resample the crisis-week index set with replacement,
  recompute the *difference* per draw — NOT the single-lane `crisisMeanCI` applied to the difference,
  which would mis-state the variance; built on the same resample idiom). Reported in **three crisis
  cuts** (§6), each annotated with its **distinct-episode count** (see §6 — the CI is decorative when
  ≤2 independent episodes, regardless of weekly effN).
- **Stress-shock payoff grid (convex candidates).** For def-Prophet and VIXM, additionally report the
  modeled payoff at standardized **−10 / −20 / −30% QQQ** shocks (def-Prophet: **terminal-intrinsic**
  spread payoff `max(Klong−S,0)−max(Kshort−S,0)` at the shocked spot — D-DP13's no-greeks idiom, not a
  new BSM reprice; VIXM: a conservative beta-to-shock estimate from its observed crisis-week response).
  This shows the convex
  payoff structure **independent of which crashes happened in-sample**, the sample-robust complement
  to the in-sample cushion. (Crash-*shape* decomposition of the in-sample crises was considered and
  rejected — it over-fragments the ~4-episode sample, contradicting the episode-count concern in §6.)
- **Efficiency** = cushion per 1%/yr **calm-period drag**. Computed only when drag > 0; when drag ≤ 0
  the candidate has genuine positive calm-period carry → flagged `free_ballast` and ranked on raw
  cushion + (negative) drag on a separate axis (avoids divide-by-≈0). Note: with drag now measured on
  non-crisis weeks, `free_ballast` is an honest property (e.g. GLD appreciating in calm windows), not
  a crash-luck artifact.
- **Secondary context:** combined-portfolio **max drawdown** and **Sharpe** (full-period).
- **Frontier:** for each candidate, the cushion-vs-(calm-drag) curve across the size grid → dominance
  read (which candidate gives the most cushion at a given calm-drag budget) + a **recommended size**
  where marginal cushion-per-drag flattens. The dominance read carries the §4 convexity caveat.

## 6. Regime-split crisis cut

Rate-shock weeks are defined **signal-independently over the full window** (S3 idiom): the top decile
of weekly Δy10 (10-year Treasury yield change), from the cached FMP `treasury-rates` curve — *not*
the top decile among crisis weeks only. Crisis weeks = QQQ worst-quintile weeks (reuse `crisisWeeks`),
then split by intersection:
- **Rate-shock subset** — crisis weeks ∩ rate-shock weeks.
- **Growth-scare subset** — crisis weeks not in the rate-shock set.
- **Lumped** — all crisis weeks (the S1-style cut), reported alongside for continuity.

Each cut reports the cushion + bootstrap CI per candidate. Sub-cuts with **effective-n < 8** nonzero
hedge-active weeks are flagged `insufficient_power` (reuse S1's floor) — a flag, not a verdict.

**Episode count, not just week count (sharpened S3 lesson).** Each cut also reports its number of
**distinct crisis episodes** (contiguous runs of crisis weeks), and RESULTS states it plainly — the
rate-shock subset is **2022-dominant**, so it is essentially one episode resampled. A
paired-difference bootstrap over a single contiguous crash resamples autocorrelated weeks and
**manufactures false precision** even when the weekly effN clears 8. Pre-registered rule: a
regime-subset cushion resting on **≤ 2 independent episodes is a single-/few-episode descriptive
read; its CI is decorative regardless of weekly effN.** Consequently the `robust` classification
(cushions in both subsets) rests on only **~3 events total** (≈2 growth-scare + 1 rate-shock) — RESULTS
must frame `robust` as exactly that, not as statistically strong.

This split is the core diagnostic: static GLD/TLT are expected to cushion growth-scares but **fail in
rate-shock** (2022), while def-Prophet/VIXM pay in any equity crash. Without the split, a
regime-fragile hedge can look fine on the lumped average — exactly the S3 "didn't dodge 2022" trap.

## 7. Pre-registered decision rule (honest null on the table)

Hash-locked before scoring (reuse the `fleet-prereg` hashing idiom).

1. **Cushions at all?** A candidate cushions if its crisis-mean contribution CI **lower bound > 0**
   in the **lumped** cut (at its recommended size).
2. **Regime class:**
   - `robust` — cushions (CI lo > 0) in **both** rate-shock **and** growth-scare subsets;
   - `fragile` — cushions in one subset only (other straddles 0 / negative);
   - `ineffective` — cushions in neither.
   (effN<8 in a subset → `insufficient_power`, not a verdict.)
3. **Cost reference:** **calm-period (non-crisis) annualized drag** under the §4 funding convention,
   read against the **conservative book-funded bound**; reference bleed budget **≤ 2%/yr** for static
   sleeves (an annotation line on the frontier, **not** a hard gate). def-Prophet is shown at its
   native sizing as well.
4. **Convexity guard (pre-registered).** Branch 4(a) — "a `robust` cheap candidate dominates" — may be
   won by a *static* sleeve (GLD/TLT) on the in-sample frontier, but it **may NOT be won by the
   convex put-spread on in-sample cushion alone**: a put-spread "win" additionally requires
   corroboration from the §5 stress-shock payoff grid (it must show structural payoff at the −10/−20%
   shocks, not just a sample-lucky cushion). Same guard logic applies to VIXM. This prevents the
   ranking from being decided by which crash shapes happened to occur in 2016–2026.
5. **Recommendation = exactly one of:**
   - **(a)** A `robust`, cheap candidate dominates the frontier (subject to the §4 convexity guard) →
     recommend it + recommended size.
   - **(b)** Only def-Prophet is `robust` (the expected base case — put-spreads pay in any equity
     crash) → recommend **def-Prophet activation as the primary hedge**; static sleeves recommended
     only as cheap regime-specific complements where they genuinely help.
   - **(c)** **Honest null** — nothing clears `robust` + cheap → recommend **no static hedge; rely on
     the already-built def-Prophet and accept the residual gap.** A null is a legitimate, expected,
     **decision-relevant** outcome (it establishes the gap is unfillable by premium *and* adequately
     filled by the hedge already built) and must be reported plainly if reached.
6. The study **deploys nothing**; the recommendation is decision-support for a later user-driven step.

## 8. Architecture (new `overlay-*.mjs`; reuse the S1 engine)

All new modules are small, single-purpose, pure where possible (testable without I/O), mirroring the
`fleet-*`/`cef-*`/`carry-*` templates.

| Module | Role | Reuses |
|---|---|---|
| `overlay-book.mjs` | Holdings CSV → value-weights → dynamic-renormalized weekly book return series; VFIAX→VOO proxy; dropped-weight accounting (per-era). | `fleet-bars`, `fleet-align` |
| `overlay-candidates.mjs` | Build each candidate's daily return-contribution series, parameterized by size; applies the §4 funding convention (cash-funded `r_f` primary + book-funded bracket). | `fleet-defensive-proxy` (`simulateDefensiveProxy`), `fleet-bars`, treasury `month3` for `r_f` |
| `overlay-regime.mjs` | Rate-shock weeks = top-decile weekly Δy10 over the full window; intersect with crisis weeks → rate-shock / growth-scare subsets; **count distinct contiguous episodes per cut**. | S3 carry treasury-curve loader idiom |
| `overlay-combine.mjs` | `book + w·(hedge−funding)` overlay → **calm-period (non-crisis) drag**, cushion (3 cuts) + **paired-difference** bootstrap CI + episode count, maxDD, Sharpe, efficiency (drag≤0 → honest `free_ballast`). | `fleet-correlate` (`crisisWeeks`,`crisisMean`; paired-diff CI on the `crisisMeanCI` resample idiom) |
| `overlay-stress.mjs` | Standardized −10/−20/−30% QQQ shock payoff for the convex candidates (put-spread **terminal-intrinsic** `max(Klong−S,0)−max(Kshort−S,0)`, no-greeks; VIXM shock-beta). | reuses def-Prophet strike geometry (D-DP13 idiom) |
| `overlay-frontier.mjs` | Sizing grid → cushion-vs-(calm-drag) frontier, dominance (with convexity guard), recommended size, decision-rule evaluation. | `overlay-combine`, `overlay-stress` |
| `overlay-prereg.mjs` | Hashed pre-registration block written before scoring. | `fleet-prereg` idiom |
| `overlay-report.mjs` | RESULTS renderer (per-target tables, 3 crisis cuts + episode counts, stress grid, frontier, recommendation, Task-0 data-wall summary). | `fleet-report` idiom |
| `overlay-score.mjs` | Orchestrator (**Task-0 data-wall check** → prereg → book → candidates → regime → combine/stress/frontier → report). | all of the above |
| `overlay-fetch.mjs` | One-time FMP backfill CLI: book tickers + VIXM + treasury curve → isolated cache; records true earliest date per ticker (feeds Task 0). | FMP `historical-price-eod/full`, `treasury-rates` |

## 9. Data & caching

- One-time **free** FMP backfill (starter tier) of: book holding tickers (those not already cached),
  **VIXM** (real EOD bars — NAV embeds the roll; no synthetic proxy), and the treasury-rates curve
  (supplies both Δy10 for the regime split and `month3` for the `r_f` funding charge).
- **Isolated** cache dir `data/lab/overlay-cache/` (the S3 lesson: do not collide with
  `fleet-bar-cache` or `carry-cache`). Bars fetched 2014→now (covers 2016 window + warmups like the
  200-DMA). Noon-UTC timestamps so `etDate` round-trips the calendar date (S1 alignment invariant).
- **Task 0 (§13) gates modeling on a data-wall check** of this cache before any scoring.
- `data/lab/*` is git-ignored. Committed artifacts: only
  `docs/lab/fleet-hedge-overlay-RESULTS.md` and `docs/lab/fleet-hedge-overlay-RUNBOOK.md`.
- `FMP_API_KEY` sourced from project-root `.env` (memory `fmp-api-key-location`).

## 10. Testing & workflow

- **TDD throughout** (RED → GREEN → verify), `node:test`. Each pure module gets unit tests
  (weights/renormalization, drag/cushion math, regime split, efficiency guard for drag≤0, decision
  rule branches incl. the null).
- **Subagent-driven** implementation with **Haiku** implementers (memory `subagent-model-preference`),
  controller-authored orchestrator + an independent reviewer pass.
- **Isolated git worktree branched off LOCAL `main`** (memory `shared-root-worktree-collision`); the
  reused lab modules live on local main only.
- **Hashed pre-registration** written before any scoring; **honest REJECT / null** always available.
- **Squash-merge to local `main`** when done, **unpushed, lab-only** (memory
  `claude-commits-must-reach-local-main`). No `.env`/Go/Node changes; nothing deploys.

## 11. Pinned defaults (open to change before implementation)

- VFIAX → VOO proxy.
- Dynamic weekly renormalization for the reconstructed book.
- **Cost = calm-period (non-crisis) drag**, not full-period.
- **Funding:** cash-funded at `r_f` (treasury `month3`) primary; book-funded reallocation as the
  conservative bracket; recommendation read against the conservative bound.
- 2%/yr static-sleeve calm-bleed **reference** (annotation, not a gate).
- **Stress shocks:** −10 / −20 / −30% QQQ (terminal-intrinsic) for the convex candidates.
- **Episode rule:** regime-subset cushion with ≤2 independent episodes → descriptive, CI decorative.
- Window 2016-01-01 → present.
- Size grids: static 2.5/5/10/15/20% of book; def-Prophet premium 0.5/1/2%.
- Treasury sleeve = TLT (long duration).
- Long-vol anchor = VIXM (intermediate-term VIX futures), real EOD bars.

## 12. Risks & limitations (disclosed in prereg + RESULTS)

- **Two biases of OPPOSITE sign that do NOT cancel** (they act on different parts of the estimate):
  - *Static current-weights book* (§3.1) applies today's elevated TSLA/PLTR/COIN weights backward →
    the reconstructed book crashes *deeper* in 2020–2022 than the real historical book did → overstated
    crash depth → overstated cushion → biases toward **over-recommending** the hedge. Acts on the
    *crash-depth / cushion* estimate. (QQQ co-target is a partial guard.)
  - *Bull-favorable window* — 2016–2026 was net bull with few crashes and much calm bleed → biases
    toward **under-recommending**. Acts on the *calm-period cost / benefit balance*.
  These are stated explicitly so they are not assumed to net out — they don't.
- **Funding model is bracketed, not point-identified** — cash-funded (`r_f`) is the optimistic bound,
  book-funded reallocation the conservative bound; true cost depends on what the fleet capital would
  otherwise earn. Recommendation read against the conservative bound (§4, §7).
- **def-Prophet proxy is a proxy** — lagging/whipsaw-prone QQQ<200DMA trigger + BSM put-spread
  approximation; no crisis-timing-coverage claim is drawn (inherited S1 caveat). Its convex,
  path-dependent cushion is sample-fragile → the §5 stress grid + §7 convexity guard are required.
- **Few independent crisis episodes** — after the §6 split the rate-shock subset is ~1 episode (2022);
  `robust` rests on ~3 events total. Regime-subset CIs are decorative at ≤2 episodes regardless of
  weekly effN (§6). The regime read is *dated descriptive*, not a high-power test.
- **VIXM** — real EOD bars embed the roll-yield path (the bleed is the strategy, captured correctly,
  not a synthetic constant); inception ~2011 covers the 2016 window — *verified in Task 0 (§13)*.
- **Static-sleeve trading friction** is negligible (buy-and-hold, no rebalance) — disclosed; the
  material cost is the funding/opportunity charge above, not commissions.

## 13. Task 0 — data-wall verification gate (run before any scoring)

Mirrors S3's pre-modeling data probe. `overlay-fetch` records, and `overlay-score` checks-and-reports,
the following BEFORE prereg/scoring; a failure is surfaced loudly, not silently worked around:

1. **Per-ticker true earliest bar date** for every book holding, the 4 candidate instruments, and
   QQQ — so the dynamic-renormalization (§3.1) knows which names exist in which weeks.
2. **VIXM coverage** — confirm continuous EOD bars spanning ≥ 2016-01-01 (with the 2014 warmup), no
   multi-week gaps.
3. **Treasury-curve depth** — confirm `year10` (Δy10) and `month3` (`r_f`) present back through the
   warmup, no gaps.
4. **Dropped-weight fraction per era** — report the mean/max fraction of book value with no bar data
   per calendar year. **Gate:** if a given era's dropped-weight fraction exceeds a pre-registered
   threshold (default **30%**), the reconstructed-Merrill crisis cuts for that era are marked
   **low-confidence / suppressed** in RESULTS (the QQQ target is unaffected). This ensures we know
   *before* scoring whether the early-window (pre-2020) Merrill cuts are meaningful, rather than
   discovering it after.

Task 0 output is committed to RESULTS as a short data-provenance table so the reader can see exactly
what the study could and could not measure.
