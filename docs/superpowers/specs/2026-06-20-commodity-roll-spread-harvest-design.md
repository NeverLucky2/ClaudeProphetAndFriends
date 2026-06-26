# Study #1 — Commodity Roll-Spread Harvest (design)

**Date:** 2026-06-20
**Branch:** `commodity-roll-spread` (isolated worktree off local `main` @ `64c983a`)
**Status:** design approved (2026-06-20); **revised after fresh-eyes review (2026-06-20)** — Turtle-leg-overlap elevated to the decisive gate, "beta-neutral" corrected to a residual short-front tilt, USO/USL promoted to clean primary, demand/supply crash cut added, USO-mandate-change flagged; spec under user review before writing-plans
**Class:** pre-registered lab study, read-only, no deploy, no agent reads it, paper-only

## 0. Context & framing

This is the next candidate in the **fleet → uncorrelated-ballast** program (`[[fleet-uncorrelated-ballast-pivot]]`), arising from an external-session memo that ranked premium-selling candidates for the fleet. The binding constraint remains the fleet's correlation to the user's tech-heavy personal book **and to the existing lanes**, not any single sleeve's standalone edge.

**What changed since S1–S4:** the equity-selloff **hedge** gap is now closed operationally — **def-Prophet is live** (`[[defensive-prophet-project]]`, the QQQ put-spread sleeve the S4 hedge-overlay study recommended; `[[fleet-hedge-overlay-done]]`). So this study is **not** a hedge-gap filler. It is a standalone test of whether a **commodity roll premium** is a genuinely-orthogonal new ballast sleeve, graded crash-conditional / risk-adjusted like its predecessors.

**Prior subprojects (all lab-only, on local main):**
- **S1 fleet-correlation GATE** (`b0943f2`) — diagnostic engine (`scripts/fleet-correlate.mjs`): β+CI, crisis-mean+CI, rotation band, lane-ρ. Reused here (verified exports: `pearson`, `betaTo`, `crisisWeeks`, `crisisMean`, `crisisMeanCI`, `rhoCrisis`, `downsideBeta`, `rotationBand`, `effectiveN`, block-bootstrap).
- **S2 CEF discount-reversion** (`7fa4c26`) — REJECTED (β/ρ to QQQ, co-crashes, overlaps Drift).
- **S3 bond-carry / roll-down** (`05b6d54`) — REJECTED on the **"different hat" gate: ρ≈0.51 to Turtle's rates sleeve** because its instrument (IEF) is a Turtle holding. **This study faces the same wall, harder** — see §0.1. Left the reusable `carry-*` suite this study mirrors.
- **S4 hedge-overlay** (`35785d7`) — ranked equity-selloff hedges; verdict = activate def-Prophet (now done).

**Selection lineage:** the memo's literal candidate was **cross-sectional commodity carry** (rank N commodities by their own curve slope). A data-feasibility spike (§3, executed) found that **data-walled** — FMP exposes no futures term structure and paywalls the key continuous symbols. The reachable expression is a **roll-spread harvest** (long smart/laddered roll, short front-month, same underlying) — backtestable on ETF data already pulled. The study pivoted to it with the user's approval.

### 0.1 The orthogonality problem (the single most important design fact)

`models/trend_universe.go` — Turtle's source-of-truth basket — **already holds the spread's own instruments outright**: `USO, UNG` (energy cluster), `DBC, DBA, DBB` (commodity cluster), `GLD, SLV` (metals cluster). So every leg this study can short or buy is *already in a sibling lane*. This is precisely the configuration that killed bond-carry (IEF shared with Turtle-rates → ρ 0.51 → REJECT), and here the overlap is **more direct** (the traded instruments are identical, not just the asset class).

**The one way this sleeve escapes the bond-carry fate:** it is a **relative-value roll harvest** (long laddered / short front, dollar-neutral), whereas Turtle trades the **outright direction** (long USO/DBC on trend, flat otherwise). RV-roll and directional-trend on the *same* underlying can genuinely decorrelate — that is the entire bet, and it is an open, well-powered empirical question. **The decisive, well-powered gate is therefore Gate 2.4 (ρ to Turtle's commodity/energy/metals clusters), not the QQQ co-crash.** A REJECT there is trustworthy and informative: it would confirm Turtle already spans the commodity premium, closing this avenue exactly as bond-carry closed rates.

**Correcting the earlier "beta-neutral" claim:** a dollar-neutral long-laddered / short-front spread is **not** beta-neutral. Front-month funds (USO/UNG) have **higher spot-beta** than laddered funds (USL/UNL), so the dollar-neutral spread carries a **residual net-short-front-month tilt** — a small structural short-energy position. That residual is the co-crash channel (§4) and a second reason orthogonality must be *measured*, not assumed.

## 1. The strategy

**Premium harvested:** the **roll yield** front-month commodity-ETF holders forfeit to laddered/optimized-roll holders. In persistent contango (the financialized-era norm) the front leg bleeds as it rolls up the curve; the laddered leg bleeds less; the dollar-neutral spread pockets the difference. The counterparty (USO/UNG retail, hedgers wanting front exposure) pays it. The premium accrues **every monthly roll** — so the *edge* is well-sampled even though the *tail* is rare. **What the spread is NOT:** pure roll. It also carries the §0.1 residual short-front tilt, so its P&L = roll premium + a small short-energy-beta term. Disentangling these is what the construct (same-commodity legs) and the gates are for.

**Universe (dollar-neutral spreads, monthly rebalance, daily-bar marked):**

| Role | Long (laddered/smart) | Short (front-month) | Start | Leg in Turtle? | Notes |
|---|---|---|---|---|---|
| **PRIMARY — clean energy roll** | **USL** (12-mo laddered WTI) | **USO** (front WTI) | 2007-12 | USO ∈ energy | Same commodity → only roll + the front/laddered beta gap differ; the cleanest construct. **Caveat:** USO changed its mandate after **Apr-2020** to spread across months → front-purity degrades post-2020; **report pre-/post-2020 split** (§2). |
| **Energy breadth (2nd point)** | **UNL** (laddered natgas) | **UNG** (front natgas) | 2009-11 | UNG ∈ energy | **Reported-only, not traded** — ~250 bps borrow (§5) + a Turtle leg. Large roll, uncapturable: itself a finding. |
| **Broad-complex corroboration** | **DBC** (DB optimum-yield) | **GSG** (S&P GSCI front) | 2006-08 | DBC ∈ commodity; GSG ∉ | **Roll + composition mix, NOT clean** — DBC and GSG differ in weighting (DBC diversified vs GSG ~60% energy) as much as in roll, so this spread is partly an energy-concentration bet. Used only to ask "does the roll edge generalize beyond oil?" — never as the clean read. |
| **Turtle-free triangulation** | **USCI** (SummerHaven contango-min) | **GSG** | 2010-08 | neither ∈ Turtle | Uses **no Turtle instrument** → if the primary shows low Turtle-ρ *and* this shows the same-sign edge, it corroborates the orthogonality isn't a leg-overlap artifact. Composition-mixed, shorter history → corroboration only. |

**What is *traded / verdict-bearing* vs *corroborating*:** the verdict is on the **USL/USO primary**. DBC/GSG and USCI/GSG are **corroboration reads** (breadth + Turtle-free triangulation), not independently verdict-bearing. UNL/UNG is reported-only. **Cross-read consistency rule:** if the primary KEEPs but the broad corroboration shows the *opposite* sign, the "commodity roll premium" claim is downgraded to "oil-idiosyncratic" (a narrower KEEP at most). If the primary's low Turtle-ρ is contradicted by the construction (e.g. only USCI/GSG is orthogonal because it dodges the shared legs), that is flagged, not buried.

**Signal (primary — parameter-free):** **static, always-on, dollar-neutral.** Hold long-laddered / short-front at all times; rebalance monthly to equal dollar legs. Harvests the structurally-positive *average* roll and **eats the backwardation tail honestly**. No train-tuning.

**Signal (robustness variant — conditional):** hold only when the spread's own **trailing 3-month realized return > 0** (contango currently paying); flat otherwise. One pre-registered lookback (3 mo, not fit), reported **only as a variant**. Diagnostic: fraction of months the conditional rule changes the position vs always-on — if ≈0, the conditionality is a free pass and the verdict rests on the static premium, stated outright.

**Rebalance:** monthly, dollar-neutral re-set. Mechanical, backend-signal, daily-bar marked — within Coil's complexity ceiling.

## 2. Sample & holdout (pre-registered, hash-locked before results)

- **Execution window:** per-leg inception (§1) → 2026-06. The FMP 5000-row cap maps to a ~2006 ETF start; the binding primary start is **USL's 2007-12**, well inside the cap, so truncation does not bite.
- **Primary edge estimate uses the FULL sample for power** (the rule is parameter-free, so there is no overfitting to guard against; splitting only sheds power). The **2016–2026 window is a pre-registered stability/tail sub-period**, not an OOS gate in the usual sense — its job is to confirm the premium is not a pre-2016 relic and to contain the thesis-defining tails:
  - **2020 COVID super-contango** (negative WTI; front-month USO crushed) — the spread *should win big*; **demand-driven** crash (§4).
  - **2022 energy backwardation** (post-invasion supply shock; front spikes) — the spread *should lose*, and the **supply-driven** crash where it may co-crash with tech (§4, Gate 2.2).
- **USO mandate-change split:** report the primary's edge and tail behavior **pre-2020-04 vs post-2020-04** separately, because USO's front-purity degraded after April 2020. A premium that exists only pre-2020 (clean USO) or flips post-2020 is flagged, not averaged away.
- **2008** (DBC/GSG, USL/USO partial) — descriptive only.

## 3. Task 0 — data-feasibility spike (DONE 2026-06-20; gates the design)

Executed via `scripts/commodity-feasibility-probe.mjs` (throwaway; findings → RUNBOOK):

1. **FMP exposes no futures term structure.** `stable/commodities-list` returns 40 *single continuous front-month* series — no contract-month curve → the literal cross-sectional carry is unreachable.
2. **Key continuous symbols paywalled on this tier.** `CLUSD` (crude), `NGUSD` (natgas), `HGUSD` (copper) → **HTTP 402**. Only Brent/gold/silver return (5000-row cap from 2007-03).
3. **Commodity ETFs are deep and clean** via `stable/historical-price-eod/full` (the `carry-fetch` route; `fmpEodToBars` from `ema-bars.mjs` verified). Inceptions: GSG/DBC/GLD/SLV/USO 2006-08; USL 2007-12; UNG 2007-04; UNL 2009-11; USCI 2010-08; etc. Sufficient for §1.

**Conclusion:** the roll-spread harvest is fully backtestable on data already pulled; the literal cross-sectional carry would need a new **paid** futures-curve dependency (deferred, §7).

## 4. Pre-registered tail + crash-type cut (written before any result — method note #1)

**Regime expected to kill the sleeve:** a **sharp backwardation / supply shock**, where front prices rocket above laddered. The static long-laddered/short-front spread *loses* in backwardation, *wins* in contango. **Mechanism is twofold and must be separated:** (i) roll reverses (backwardation), and (ii) the §0.1 residual short-front tilt loses as energy spikes. Both fire together in a supply shock.

**Demand- vs supply-driven crash cut (the bond-carry bull/bear-steepening analogue — DESCRIPTIVE, see-it-don't-gate-it):** equity selloffs split into two worlds the static spread treats oppositely:
- **Demand-driven** (recession fear: 2008 H2, 2015–16, 2020 Mar) — energy *falls* into contango; short-front *wins*; the spread is **genuine ballast** (gains while tech falls).
- **Supply-driven** (2022 invasion; embargo-type shocks) — energy *spikes* into backwardation; short-front *loses*; the spread is **anti-ballast** (co-crashes with the inflation/rate-shock tech selloff).

Pre-registered: classify each QQQ-worst-week cluster as demand- vs supply-driven by the **sign of the contemporaneous front-energy (USO/WTI) move**, and report the sleeve's return conditional on each. **A KEEP whose "ballast" reading comes entirely from demand-driven crashes while supply-driven crashes co-crash is a regime-composition artifact of which crashes happened to land in-sample → downgrades confidence in any KEEP.** The 2022 supply case is in the stability window deliberately.

**Tail correlation, not average correlation (method note #2):** report the sleeve's return **conditional on QQQ's and Coil's worst weeks**, not full-sample ρ. The sign is **measured, not assumed** — 2020 (demand) was a spread *win* during a tech-relevant crash, 2022 (supply) likely a loss, so the net depends on the crash mix.

## 5. Verdict gates (pre-registered, hash-locked before any result is read)

### Gate 1 — Edge (well-powered, the genuine contrast with S1–S4)

1. **(a)** Friction-net **full-sample** return, block-bootstrap CI **> 0**, with the 2016–2026 sub-period reported alongside. **Well-powered** — the roll accrues over ~150+ monthly observations, not a handful of macro regimes. A REJECT or KEEP here is trustworthy.
2. **(b) — tail behavior, DESCRIPTIVE with a power flag.** §4 drawdown over named backwardation episodes + the demand/supply cut. The window holds only **~2 supply-shock spikes** (2022, lesser 2018), so any CI here describes ~2 events — power-flagged, never pass/fail. Decision content = the dated 2022 narrative.
3. **(c)** Survives **2× friction** including short-leg borrow. **Borrow is the central economic risk, not a footnote:** the short legs (USO/UNG/GSG) are the structurally-bleeding funds that sophisticated shorts crowd into, so realized borrow may exceed the base constants below — treat borrow as a sensitivity dimension, and lean the verdict on the stressed figure.

**Friction model (pre-registered, documented not fit; 2× for stress):**
- Per-leg round-trip half-spread/month: **5 bps** liquid (USO, UNG, GSG, DBC), **12 bps** thinner (USL, UNL, USCI).
- **Short-leg borrow** (annualized on short notional): **75 bps** oil/broad (USO, GSG — raised from a naive 50 bps; oil-ETF shorts are crowded), **250 bps** natgas (UNG). Natgas borrow is *why* UNL/UNG is reported-only. The primary's short leg (USO) is the borrow-sensitive one — the primary verdict must hold at **2×75 = 150 bps**.

Total return is explicitly secondary — a ballast sleeve may give up bull-market return for orthogonality.

### Gate 2 — Orthogonality (reuse `fleet-correlate`)

1. **|ρ| and β to QQQ < 0.3** (full-sample — well-powered).
2. **Crisis-conditional mean in QQQ worst-quintile weeks not significantly negative** — the co-crash check. **This gate is crisis-limited, NOT well-powered:** the ~22 worst weeks cluster into ~3–4 episodes (block-bootstrap CI, effective-n reported). Consistent with the program prior — full-series orthogonality is trustworthy; crisis-conditional reads are case studies. The §4 demand/supply cut is reported underneath it.
3. **|ρ| to each existing lane < 0.3** (Coil, Turtle, Drift, DefProxy) — full-sample, well-powered.
4. **DECISIVE — "different hat" vs Turtle's commodity exposure.** Build the comparator by restricting `fleet-turtle-sim` to Turtle's **energy + commodity + metals clusters** (`USO, UNG, DBC, DBA, DBB, GLD, SLV` from `trend_universe.go`). Report ρ **both all-weeks and co-active-weeks-only** (two mostly-flat series can show spuriously low all-weeks ρ from shared inactivity; co-active ρ is the real test). **This is the well-powered base-case kill (§0.1) — the bond-carry-precedent gate.** Because the spread's own legs (USO, UNG, DBC) are *in* this comparator, a low ρ here is the load-bearing evidence that RV-roll ≠ Turtle-trend; do not hand-wave it as "beta-neutral so naturally low" (it is not beta-neutral, §0.1).

### Verdict

- **REJECT** if any sub-gate fails — **base case: Gate 2.4 Turtle-overlap** (well-powered) or Gate 2.2 co-crash or the friction gate.
- **INCONCLUSIVE** if **(i)** the broad corroboration contradicts the primary's sign at the verdict level (premium is oil-idiosyncratic, not a commodity-complex premium → narrow at best), or **(ii)** the supply-shock-episode count is too thin to characterize 2022 beyond a case study (power flag on Gate 1(b)), or **(iii)** the orthogonality holds only for the Turtle-free construction (USCI/GSG) and not the shared-leg primary.
- **KEEP** only if Gate 1(a) CI > 0 (well-powered) **and** Gate 2.4 Turtle-ρ is low on **co-active** weeks **and** no co-crash **and** the demand/supply cut shows ballast is not purely demand-driven. **Asymmetry (pre-committed):** the *edge* and *full-sample orthogonality* reads are well-powered, so a REJECT (esp. Turtle-overlap) is trustworthy; the *crisis co-crash* read rests on ~3–4 episodes, so any KEEP is **provisional pending more supply-shock regimes**.

## 6. Honest priors (not cheerleading a KEEP)

Most probable outcomes, in order:
1. **Turtle-entanglement REJECT (Gate 2.4) — well-powered base case.** The legs (USO/UNG/DBC) *are* Turtle's holdings; bond-carry died on exactly this with IEF. The RV-vs-trend escape is real but unproven. This is both the most likely REJECT and the most trustworthy one.
2. **Supply-shock co-crash (Gate 2.2 / §4).** The 2022 residual-short-energy loss coincided with the rate-shock tech selloff. Crisis-limited evidence, but a real kill if the sign is clear.
3. **Friction REJECT (Gate 1c).** Crowded-short borrow on USO (and the thinner USCI 12 bps spread) eats a thin gross premium under 2× stress.
4. **Oil-idiosyncratic INCONCLUSIVE.** Clean USO/USL premium is real but the broad complex doesn't corroborate → a narrow oil-roll sleeve, not a "commodity roll premium."
5. **Genuine KEEP (provisional).** RV-roll is orthogonal to Turtle's trend on co-active weeks, friction-survivable, and ballast in more than just demand-driven crashes. A real but minority outcome.

**The generalizable lesson, stated up front:** Turtle-v2 was *designed* to span six macro drivers (rates, metals, energy, commodity, fx, intl-equity), so **any single-driver premium sleeve will overlap it by construction** — bond-carry hit this in rates, this study hits it in commodities. That is *why* the study is still worth running: its decisive question (does RV-roll decorrelate from directional-trend on shared instruments?) is the **well-powered** kind, so even the likely REJECT cleanly answers whether the fleet needs anything beyond Turtle in the commodity space. The *upside* (a KEEP) rests on the thinner crisis read and is graded provisional.

## 7. Why roll-spread, and what was rejected

- **Literal cross-sectional commodity carry — data-walled (§3).** Needs paid futures-curve data (Nasdaq Data Link / Barchart). Deferred, same shelf as merger-arb.
- **A composition-matched broad roll spread** — *unreachable via ETFs*: only oil (USL) and natgas (UNL) have laddered ETFs, so you cannot build a broad laddered basket. This is the fundamental limit that forces the clean construct to be energy-only (USO/USL) and the broad read (DBC/GSG) to be composition-contaminated. Stated plainly rather than papered over.
- **Outright commodity trend / long DBC** — rejected: that *is* Turtle's hat (long commodity beta, trend signal); §0.1.

## 8. Workflow & deliverables

- **Isolated worktree** off **local main** (`commodity-roll-spread`, from `64c983a`) — the reused S1–S3 modules live on local main only. **Re-assert the branch before any commit** (`[[shared-root-worktree-collision]]`; a concurrent session is active on this repo as of 2026-06-20 — re-verify HEAD before any git mutation).
- **Subagent-driven TDD**, **Haiku** implementers (`[[subagent-model-preference]]`). RED → GREEN → verify. `node:test`.
- **Pre-register + hash-lock** the spec (`commodity-prereg.mjs`) **before** any result is computed.
- **New `commodity-*.mjs` modules** (mirror `carry-*`, each TDD'd):
  - `commodity-universe.mjs` — spread legs/roles, the Turtle-cluster comparator list, friction/borrow constants, windows, the 2020-04 USO split date.
  - `commodity-fetch.mjs` — fetch §1 ETF bars → `data/lab/commodity-cache/` (gitignored); reuse `fmpEodToBars`.
  - `commodity-signal.mjs` — static dollar-neutral series + conditional-variant + the change-fraction diagnostic.
  - `commodity-sim.mjs` — dollar-neutral spread P&L, daily mark → weekly series, friction/borrow-net, pre/post-2020 split.
  - `commodity-friction.mjs` — half-spread + annualized short borrow; 2× stress (adapt `carry-friction.mjs`).
  - `commodity-prereg.mjs` — produce + hash-lock the prereg JSON (adapt `carry-prereg.mjs`).
  - `commodity-score.mjs` — the gates (§5) → verdict; QQQ-worst-week crisis cut, the **demand/supply crash cut**, the **Turtle commodity-cluster ρ (all-weeks + co-active)**, the broad-corroboration sign check, and the power/twin flags.
- **Reuse (do not reimplement):** `fleet-correlate.mjs`, `fleet-align.mjs`, `fleet-bars.mjs`, block-bootstrap, and `fleet-turtle-sim.mjs` restricted to the energy+commodity+metals clusters for Gate 2.4.
- `data/lab/*` **gitignored**. Commit only `scripts/commodity-*.mjs` (+ tests), `docs/lab/commodity-roll-spread-{RESULTS,RUNBOOK}.md`, this spec, and the plan. `commodity-feasibility-probe.mjs` is evolved into `commodity-fetch.mjs` or deleted — not committed as-is.
- **Squash-merge to local main** when complete (`[[workflow-preferences]]`).
- **Paper/lab only** — no `.env` change, no Go/Node rebuild, no live-agent touch.

## 9. Open questions (resolved defaults; flag if any should change at plan time)

- **Primary = USL/USO** (clean same-commodity roll), fixed — chosen on construct validity over the composition-contaminated DBC/GSG; broad reads are corroboration only (§1). No post-hoc primary-switching.
- **USO post-2020-04 mandate change** is handled by the pre/post split (§2), not by substituting a different fund (no clean front-month WTI alternative exists; DBO is smart-roll, the wrong side).
- **Static always-on is primary** (parameter-free; full-sample for power). Conditional trailing-3-month is the variant.
- **Dollar-neutral, equal-notional legs, monthly re-set — NOT beta-neutral** (residual short-front tilt is real and measured, §0.1). A beta-weighted variant (neutralize the front/laddered beta gap) is a possible robustness add only if the residual proves to dominate the P&L.
- **Block-bootstrap block length:** ~12–26 weeks (pre-registered in `commodity-prereg.mjs`). For Gate 1(b)/2.2 the bootstrap is decorative — block length does not rescue a ~2–4-episode sample.
- **Friction/borrow constants (§5)** are pre-registered estimates, documented not fit, stressed at 2×; the verdict leans on the stressed figure, especially USO borrow and USL/USCI spreads.
