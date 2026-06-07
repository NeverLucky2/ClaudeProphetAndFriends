# Subproject 3 — Curve-Aware Treasury Carry / Roll-Down Sleeve (design)

**Date:** 2026-06-06
**Branch:** `bond-carry-rolldown` (isolated worktree off local `main` @ 7fa4c26)
**Status:** design approved; **revised after external Claude review (2026-06-06)**; spec under user review before writing-plans
**Class:** pre-registered lab study, read-only, no deploy, no agent reads it, paper-only

## 0. Context & framing

This is the third subproject in the **fleet → uncorrelated-ballast** program (`[[fleet-uncorrelated-ballast-pivot]]`). The binding constraint is the fleet's correlation to the user's tech-heavy personal book, not any single agent's standalone edge.

- **Subproject 1 (the GATE, local main `b0943f2`)** reconstructed all four fleet lanes by backtest and ran a correlation/β + crisis-conditional diagnostic. Finding: the fleet's real hole is **equity-selloff protection** — Coil and Drift co-crash with the tech book in the tail; only Turtle is a genuine diversifier; only the def-Prophet hedge cushions. The reusable engine is `scripts/fleet-correlate.mjs` (β+CI, crisis-mean+CI, rotation band, lane-ρ) plus `fleet-align`, `fleet-prereg`, `fleet-bars`, and the lane builders (`fleet-turtle-sim`, etc.).
- **Subproject 2 (CEF discount-reversion, local main `7fa4c26`)** — REJECTED on all four gates: no friction-net edge, β 0.37 / ρ 0.64 to QQQ, co-crashes −1.79% in QQQ worst weeks, overlaps Drift. The equity-selloff gap **remains open**.

**This subproject** tests the next genuinely-orthogonal premium candidate to fill that gap: a **curve-aware Treasury carry / roll-down sleeve**. Selected over the raw "bond carry" default after the brainstorm surfaced two structural problems with naive bond carry — see §7.

### The orthogonality bet (the single most important design commitment)

The sleeve's signal is computed from the **yield-curve shape** (FMP `treasury-rates` constant-maturity series), **not** from the bond-ETF price. This is what could decorrelate it from Turtle, which trend-trades the same instruments (`TLT, IEF, TIP`) on a **price-breakout** signal. A fundamental curve-shape signal and a technical price-trend signal can diverge even on the same underlying. If they do not diverge, the candidate is "Turtle's rates-trend in a different hat" and must be REJECTED — this is an explicit, pre-registered gate (§5, Gate 2).

## 1. The strategy

**Premium harvested:** the bond **term premium + roll-down**, captured *conditionally*. Hold duration only when the curve shape rewards it; sit in cash otherwise. The conditionality is the entire thesis — it is what could fill the equity-selloff gap where *static* bonds cannot.

**Universe:**
- Duration leg: **`IEF`** (7–10y Treasury). Chosen deliberately over TLT — moderate duration is the defensible ballast instrument; TLT's higher-octane variant is **not** tested in primary (avoids multiple-testing / variant-shopping).
- "Out" leg: **cash**, earning the 3-month T-bill yield drawn from the same FMP curve (`month3`). Pure cash (zero duration) is the cleanest "off" state for a ballast sleeve and adds no inception-date gap (BIL only starts 2007). SHY-as-out-leg was considered and set aside (still carries front-end duration that lost in 2022; pure cash is the cleaner gap-fill). **Accrued, not marked:** the off-state earns ≈ `y3mo / 252` per day with **zero price volatility**; it is *never* marked to the changing 3mo yield (doing so would inject phantom volatility into the off-state and contaminate the sleeve's measured correlation across the cash-heavy post-2022 holdout).

**Signal (monthly):** expected excess carry + roll-down of the duration leg over cash:

```
signal = [ y10 + ModDur · (y10 − y_shorter) ] − y3mo
```

- `y10` = carry (income yield of the ~10y point).
- `ModDur · (y10 − y_shorter)` = roll-down: as a ~10y bond ages by the holding horizon it slides down the curve to a shorter maturity; the price gain ≈ modified duration × the yield decline along the curve. `y_shorter` is the curve point one roll-horizon down (e.g. `year7`); `ModDur` a representative IEF modified duration (~7.5, fixed constant — documented, not fit).
- `y3mo` = the cash opportunity cost.
- **Decision (primary, parameter-free):** if `signal > 0` → hold IEF for the next month; else → cash. In words: "hold duration only when the curve pays positive carry+roll over cash." This rule is set **without train-tuning and without reference to the holdout**, so the holdout is out-of-sample *by construction*. A positive-buffer **threshold grid** (`signal > {+25bp, +50bp}`) is run **only as a robustness variant**, never as the primary — see §9.

**Robustness twin (verdict-gating):** the **term spread `y10 − y3mo`** is near-collinear with carry+roll but uses **no `ModDur` constant**, so it is the clean check on the §9 `ModDur` distortion. Both signals must produce the **same verdict**. A verdict that flips on this near-collinear reformulation is **REJECT-grade fragility, not a footnote**: pre-registered rule — **twin disagreement at the verdict level downgrades a KEEP to INCONCLUSIVE** (this removes the write-up temptation to lead with whichever formula KEEPed). The twin is reported in full **especially around the 2021→2022 turn**, where the `ModDur`-constant bias is largest and where the thesis lives.

**Rebalance:** monthly. Signal from the month-end curve sets the next month's position. Mechanical, daily-bar marked, backend-signal — within Coil's complexity ceiling.

## 2. Sample & holdout (pre-registered, hash-locked before results)

- **Execution window:** 2002-07 (IEF inception) → 2026, subject to the §3 Task-0 data-depth check.
- **Train:** 2002–2014 — a **diagnostic window only**, since the primary rule is parameter-free (`signal > 0`; §1/§9). Used to report the threshold-binding fraction and confirm the sign rule and `ModDur`/roll-horizon choices are not degenerate — *not* to tune the primary decision.
- **Holdout:** 2015–2026 — all gate evaluation. This deliberately puts the two thesis-defining regimes in the holdout:
  - **2020 COVID** — growth-scare; duration *should* be held and *should* win.
  - **2022 rate-shock** — duration *should* be dodged (curve flattening/inverting → signal goes to cash).
- **Cash leg pre-2007:** the 3mo T-bill yield from the curve is the cash return throughout, so there is no BIL-inception discontinuity.

## 3. Task 0 — data-wall check (do this first, like CEF's CEFConnect probe)

Before any modeling, verify empirically:
1. FMP `stable/treasury-rates` actually returns history back to ~2002 with the needed maturities (`month3`, `year2`, `year5`, `year7`, `year10`, …). Record the true earliest date and the field names present.
2. If history is shallower than 2002 (e.g. only reaches 2010), **shrink the window and flag reduced power** in RESULTS — do not fabricate depth. Re-evaluate whether train/holdout split still leaves 2022 in holdout.
3. Confirm IEF daily bars are available over the chosen window via the existing `fleet-fetch-bars` path.

Findings go in the RUNBOOK and gate the rest of the build.

## 4. Engine (reuse-heavy)

**Reuse from S1/S2 (do not reimplement):**
- `scripts/fleet-bars.mjs` — bar loader (noon-UTC timestamps so `etDate` round-trips).
- `scripts/fleet-correlate.mjs` — β+CI, crisis-mean+CI, rotation band, lane-ρ (the orthogonality engine).
- `scripts/fleet-align.mjs` — return-series alignment.
- `scripts/fleet-prereg.mjs` — spec hash-lock.
- block-bootstrap (as used in `cef-*`).
- `scripts/fleet-turtle-sim.mjs` — to build the rates-only Turtle sleeve (§5).

**New `carry-*.mjs` modules (mirror the `cef-*` layout, each TDD'd):**
- `carry-universe.mjs` — tickers, curve maturities, constants (ModDur, roll-horizon), train/holdout dates.
- `carry-fetch.mjs` — fetch FMP `treasury-rates` curve + IEF bars → `data/lab/*` (gitignored).
- `carry-signal.mjs` — monthly carry+roll computation, **sign(signal) > 0 → on/off** series (+ buffer-grid robustness variant); the term-spread twin; emits the threshold-binding diagnostic.
- `carry-sim.mjs` — monthly IEF↔cash position sim, daily mark-to-market → weekly series for the correlate engine, friction-net.
- `carry-friction.mjs` — per-rebalance friction (spread + commission); 2× stress variant.
- `carry-prereg.mjs` — produce + hash-lock the prereg JSON.
- `carry-score.mjs` — apply the dual gate (§5) → verdict; computes the exogenous rate-shock week set (top-decile Δy10), the Gate 1(b) dated-episode narrative, the Gate 2b steepening-regime cut, and the co-active Turtle-rates ρ; enforces the twin-disagreement and Gate-1(b)-specific power flags.

## 5. Verdict gates (dual, pre-registered, hash-locked before any result is read)

### Gate 1 — Edge (ballast-graded, tail-first)

Consistent with the fleet pivot ("judged on crash-conditional / risk-adjusted return"), the sleeve is graded as ballast, not on raw return:

1. **(a)** Friction-net holdout return, block-bootstrap CI **> 0** — it does not lose money net of costs.
2. **(b) — the dodge check, DESCRIPTIVE not a CI gate.** The value-add to prove is "dodges duration in **rate-shock** weeks" — a *different* week set from QQQ-worst weeks. (QQQ-worst weeks include equity-only air-pockets where bonds *rallied* and passive IEF beats cash regardless of the signal → timing irrelevant → a CI there would fail for a reason unrelated to curve timing.) Rate-shock weeks are defined **exogenously and signal-independently** as the **top-decile weeks by weekly Δy10** (largest 10y-yield *increases*) over the holdout — deliberately *not* by IEF's own returns, which would make "cash beats falling IEF" near-tautological. In those weeks, report **(i)** the fraction the sleeve was in **cash** (the signal's dodge hit-rate) and **(ii)** sleeve vs buy-and-hold IEF return. The holdout holds only **~4 independent rate-shock episodes** (2018Q4, the 2022 grind, the 2025 tariff shock, …), so any bootstrap CI here **describes ~4 events, not a powered test** — it is reported as **decorative context behind an explicit power flag on Gate 1(b) specifically**, never as pass/fail. The **decision criterion is factual and dated**: pre-register that a KEEP-on-edge requires the sleeve to have been in **cash for the majority of the 2022 rate-shock drawdown** (the defining episode), reported as a dated episode narrative alongside 2018Q4 and 2025. This converts the most-important economic claim from false-precision inference into an honest case description.
3. **(c)** Survives **2× friction** stress: sub-gate (a) stays CI > 0.

Total return is explicitly secondary — a ballast sleeve may give up bull-market total return for tail protection, and that is the trade we want.

### Gate 2 — Orthogonality (reuse `fleet-correlate`)

1. **|ρ| to QQQ < 0.3** and low full-sample β to QQQ.
2. Crisis-conditional mean in QQQ **worst-quintile weeks** (the `fleet-correlate` crisis cut — a *distinct* week set from Gate 1(b)'s rate-shock cut: this measures the **equity-selloff ballast property**, that one measures the **bond-selloff dodge**) **not significantly negative** (does not co-crash — the gap-fill condition).
3. **|ρ| to each existing lane < 0.3** (Coil, Turtle, Drift, DefProxy).
4. **|ρ| to the Turtle-rates-only sleeve < 0.3** — built by running `fleet-turtle-sim` restricted to the rates cluster `{TLT, IEF, TIP}`. **This is the make-or-break "different hat" check** for this candidate. Report ρ **both** over all weeks **and over co-active weeks only** (weeks where at least one sleeve holds duration): two mostly-cash zero-return series can show a spuriously low all-weeks ρ purely from shared inactivity, so the **co-active ρ** is the one that actually tests "same bet, different signal."

### Gate 2b — Steepening-regime descriptive cut (see it, don't gate it)

The carry+roll signal says "hold duration when the curve is steep," but curves steepen in two opposite worlds the signal **cannot distinguish**: **bull steepening** (front end falls on Fed easing / growth scare → duration is genuine ballast, rallies as stocks fall) and **bear steepening** (long end rises on reflation → duration is *risk-on-correlated*). Whether the orthogonality result lands as "ballast" or "co-moves" can therefore be a **regime-composition artifact** of the ~4 holdout episodes, not a stable property of the signal — the bond-market analogue of the secret-long-beta trap that killed S2. **Pre-registered descriptive cut:** classify each duration-**held** episode as bull- vs bear-steepening by the **sign of the long-yield (`y10`) change during the hold**, and report tail behavior (return in QQQ-worst and in rate-shock weeks) **conditional on each**. The sample is too thin to *gate* on this, but it **must be visible**: a KEEP whose "ballast" reading comes entirely from bull-steepening holds while bear-steepening holds co-crash is a regime artifact, reported as such and **downgrading confidence in any KEEP**.

### Verdict

- **REJECT** if any sub-gate fails — including the make-or-break Gate 2.4 "different hat" check (the well-powered base case) or a co-crash in Gate 2.2.
- **INCONCLUSIVE** if **(i)** the independent rate-shock-episode count is too low to support the Gate 1(b) dodge claim beyond a case study — the power flag lives **on Gate 1(b) specifically**, mirroring S1's effective-n < 8 (here the binding constraint is **independent-regime count for a monthly signal**, which is smaller still than crisis-week count); **or (ii)** the §1 robustness twin disagrees at the verdict level.
- **KEEP** only if Gate 2 passes (well-powered) **and** the Gate 1(b) dated-episode narrative factually shows the dodge **and** the twin agrees. **Asymmetry of confidence (pre-committed):** Gate 2 / full-series correlation is well-powered, so a REJECT there is trustworthy; the Gate 1(b) edge confirmation is sample-starved, so any KEEP is **provisional pending more regimes**, not a strong graduation signal.

## 6. Honest priors (not cheerleading a KEEP)

Most probable outcomes, in order:
1. **ρ to Turtle-rates-only too high → "different hat" REJECT.** Same instruments; the curve signal may simply track the price trend. This is the base case.
2. **Too few independent regime episodes → INCONCLUSIVE.** A monthly curve-state signal flips rarely; 2002–2026 holds only a handful of genuinely independent curve regimes.
3. **Monthly signal lags the regime turn → fails the tail gate (b).** If the sleeve is still long duration into 2022, it co-crashes like passive bonds and adds nothing.

A KEEP requires the curve signal to be *both* genuinely different from price-trend *and* fast enough to have been in cash through 2022. That is a real but minority outcome. The REJECT/INCONCLUSIVE verdict is fully on the table and is itself informative (it would confirm Turtle already harvests the rates premium, closing this avenue).

**Program-level prior (across S1/S2/S3) and why this study is still worth running.** All three subprojects hit the same wall: independent-regime count (S1's effective-n < 8, S2's handful of discount-widening episodes, now S3's ~4 rate regimes). This is not a per-spec flaw — it says any macro-conditional ballast sleeve tested on 2002–2026 is **fundamentally sample-starved at the regime level**, and no bootstrap manufactures regimes that did not happen. The durable consequence: **orthogonality / full-series correlation gates are well-powered and trustworthy; crisis-conditional *edge* gates are, across the board, closer to case studies than tests.** This is *why* the study is worth running despite the wall — its **decisive** question for this candidate (Gate 2.4, "different hat?", the §6 base case) is the well-powered kind, so the most-probable verdict (REJECT) is trustworthy. It is only the *upside-confirmation* (the Gate 1(b) edge) that is a case study — which is exactly why a KEEP here is graded provisional, not promoted.

## 7. Why curve-aware, and what was rejected

Naive "own bonds for carry" was rejected in the brainstorm for two structural reasons:
1. **Overlaps Turtle by construction** — bond carry lives on TLT/IEF/SHY, and Turtle-v2 already trend-trades `TLT, IEF, TIP`. The candidate's universe is a subset of an existing lane's.
2. **Fails the regime that defines the gap** — the selloff that hurt a tech book worst (2022) was a rate-shock where stocks *and* bonds fell together. Static duration is long exactly when it co-crashes with equities.

The curve-aware version is the only framing with a shot at both gates: it is a *fundamental* (curve-shape) signal rather than a *price-trend* one (a path to Turtle-orthogonality), and it can be *out of duration* when the curve is flat/inverted (a path to dodging the 2022 co-crash). It is being tested precisely because it directly attacks both failure modes — with eyes open that it may still fail them.

Candidates set aside as weaker free options (documented for the record): gold-trend (Turtle already holds GLD/SLV), low-vol / defensive-equity factor (still long equity β → co-crashes), TIPS-breakeven inflation (thin). Data-walled and not revisited: merger-arb (needs deal terms), FX/commodity carry (needs futures term structure). CEF discount-reversion is done and rejected.

## 8. Workflow & deliverables

- **Isolated worktree** off **local main** (`bond-carry-rolldown`, branched from `7fa4c26`) — not origin; the reused S1/S2 modules live on local main only. Re-assert the branch before any commit (shared-root HEAD collision lesson).
- **Subagent-driven TDD**, **Haiku** implementers. RED → GREEN → verify. `node:test`.
- **Pre-register + hash-lock** the spec (`carry-prereg.mjs`) **before** any result is computed/read.
- `data/lab/*` **gitignored** (bar cache, curve cache). Commit only: `scripts/carry-*.mjs` (+ tests), `docs/lab/bond-carry-{RESULTS,RUNBOOK}.md`, this spec, and the plan.
- **Squash-merge to local main** when complete (one commit per the workflow convention).
- **Paper/lab only** — no `.env` change, no Go/Node rebuild, no live-agent touch.

## 9. Open questions (resolved defaults; flag if any should change at plan time)

- **Decision rule:** `signal > 0` is the **primary, parameter-free** rule (no train-tuning; holdout out-of-sample by construction — §1). The positive-buffer grid (`> {+25bp, +50bp}`) is a **robustness variant only**. Pre-registered diagnostic: report the **fraction of train (and holdout) months where a buffer threshold changes the decision vs sign-only** — if near zero, the threshold is a free pass and the verdict rests on the signal's **sign**, stated outright rather than dressed as a tuned parameter. (Train 2002–2014 includes the ZIRP era where carry+roll was structurally large and positive, so a level threshold rarely binds there — another reason sign-zero is the honest primary.)
- `ModDur` constant for IEF: 7.5 (representative; fixed, documented, **not fit**). Known distortion: true IEF modified duration *falls as yields rise*, so a constant 7.5 **overstates** roll-down in the high-rate holdout years and understates it in ZIRP train years → tilts the signal toward "hold" more in 2015–2021 and less in 2022+. This bias runs **against** the thesis (it makes the sleeve *slower* to reach cash before 2022 — the conservative/safe direction), and the term-spread twin (no `ModDur`) is the guard, reported around the 2021→2022 turn (§1). Roll-horizon / `y_shorter`: `year7` (one step down from `year10`); if FMP lacks `year7`, interpolate `year5`/`year10`.
- Block-bootstrap block length: ~6–12 months to capture regime persistence (exact value pre-registered). **Note:** for Gate 1(b) the bootstrap is decorative (§5) — block length does not rescue a ~4-episode sample.
