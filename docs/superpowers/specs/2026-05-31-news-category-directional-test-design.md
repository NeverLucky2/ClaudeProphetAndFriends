# Per-Category Directional Test — Design (Sub-project 2)

**Date:** 2026-05-31
**Status:** ⛔ **NOT IMPLEMENTED — program STOPPED 2026-05-31** (deliberate call: low expected yield — Stage 1 FAILed, 4/6 categories are arbitraged analyst signals, and even a PASS would need a separate forward-confirmation study to be actionable). This design is retained as a record. **If ever revisited, apply the corrections in the box below FIRST** — the original §3/§8 below contain a known methodological error.
**Type:** Pre-registered hypothesis test (real verdicts, on untouched data).
**Parent program:** "Which news *types* genuinely predict short-term direction?" SP1 (`docs/lab/category-frequencies-RESULTS.md`) found ~8 categories testable at power. SP2 *would* test whether each actually predicts. Program summary: `docs/lab/news-prediction-program-SUMMARY.md`.

---

## ⚠ Required corrections if this is ever revisited (cross-session review, 2026-05-31)

1. **Market-adjust the returns (load-bearing).** §8 below claims survivorship "biases discovery upward, so a FAIL is strong" — **this is WRONG and direction-asymmetric.** Today's 56 names are survivors that drifted up over 2016–2021. Up-bets (`upgrade`↑, `pt_raise`↑) are inflated by the drift (PASS suspect, FAIL strong); **down-bets (`downgrade`↓, `pt_cut`↓, `legal_action`↓, `antitrust`↓) are deflated** (FAIL suspect, **PASS strong**). Fix: `R = s·[(P_exit/P_entry − 1) − (SPY_exit/SPY_entry − 1)]` over the same d+1→d+3 window (SPY bars already cached). Without this the down-half measures the names' secular rise, not the news.
2. **Drop to K=6.** Remove `product_launch` and `restructuring` from the Bonferroni family — they are pre-declared direction-uncertain (`restructuring`↑ is near a coin flip; "could be distress" is the opposite sign), and spending two corrected-α slots on un-predictable directions taxes the six with real theory (α/6≈0.0083 vs α/8=0.00625). Report the two **descriptively**, not gated. (Value concentrates in `legal_action` + `antitrust` — the least-arbitraged; the four analyst variants are near-efficient calibration/negative-control.)
3. **Align the bootstrap to the binomial.** The guard `p5 > 0.55` is a 5% lower bound while the binomial runs at α/K≈0.0063 — looser than the headline on the shared dimension. Use the bootstrap one-sided p-value (fraction of resamples with HR ≤ 0.55) `< α/K`, with enough resamples (~50k) to resolve that level.
4. **Regime-concentration flag (diagnostic).** 2016–2021 contains COVID; flag any category whose firings concentrate in a single regime window (e.g. >X% in 2020) — it can clear n and even the 10-session bootstrap while measuring one extraordinary regime. Parallel to Stage 1's overfit signature; not gating.
5. **Forward confirmation is MANDATORY before any action, not optional.** Pre-burned-period data is weaker than forward out-of-sample on two axes the untouched window does not fix: lived-prior (strong priors about these exact mega-caps in 2016–2021) and stale-regime (ZIRP/pre-inflation/COVID may not generalize to now). A PASS means "this held then," not "tradeable today." The real protection is theory-driven directions + outcome-blind category selection + forward confirmation.

_Everything below is the original design as-approved-then-superseded. Read it through the corrections above._

---

---

## 0. Framing & the rules carried forward

SP1 (frequency count) was outcome-blind and gave a **qualified GO**. SP2 now scores price outcomes, so the Stage-1 discipline applies in full:

- **Hit rate over the FULL unconditional firing base.** For each category we measure: *of all times the category fired (move or no move), what fraction were followed by the pre-registered direction.* We **never** scan for big moves and look back at co-occurring news — that selects on the outcome and inflates every category into a false predictor.
- **Pre-register everything before scoring;** freeze in a hash-locked artifact; score **once**.
- **Untouched data.** 2022–2026 outcomes are burned (Stage 1 + are where the categorizer was face-validated). SP2 runs on **2016–2021**, which has never had outcomes scored.
- **"Testable" ≠ "predictive."** SP1 showed the question is *answerable at power*; the honest prior (Stage 1) is that **most categories will FAIL**. Clean per-category negatives are the expected, valuable result.

---

## 1. Pre-registered category → direction map (the core registration)

Eight categories, each with a theory-driven direction fixed **before** scoring. `analyst_pt` is split by direction (it is not directional as one bucket).

| Category | Direction | Rationale | Confidence |
|---|---|---|---|
| `analyst_upgrade` | ↑ (+1) | upgrade = positive re-rating | clear |
| `analyst_downgrade` | ↓ (−1) | downgrade = negative re-rating | clear |
| `analyst_pt_raise` | ↑ (+1) | price-target raised | clear |
| `analyst_pt_cut` | ↓ (−1) | price-target cut | clear |
| `legal_action` | ↓ (−1) | lawsuits/probes/fines are adverse | clear |
| `antitrust` | ↓ (−1) | antitrust action constrains the business | clear |
| `product_launch` | ↑ (+1) | positive product news | **direction-uncertain** |
| `restructuring` | ↑ (+1) | layoffs read as cost discipline (could be distress) | **direction-uncertain** |

**`tariff` is excluded** (SP1 found it macro-inflated: one headline tagged to up to 36/57 tickers).
**Direction-uncertain flag:** a FAIL on `product_launch`/`restructuring` is reported as *"no UP-signal"* — it does **not** rule out an opposite-direction signal. This is honest about the weaker prior; we do not get to flip the sign after seeing results.

**K = 8** (the number of categories committed to testing) → **Bonferroni α/K = 0.05/8 = 0.00625**. K is fixed here, outcome-blind. Abandoning a category after seeing results does not reduce K.

---

## 2. The test (per category)

- **Firings:** every **distinct cluster-initiation** of the category in 2016–2021 — per `(ticker, category)`, collapse coverage waves within **W=5 calendar days** to the first date (a follow-up article post-dates the move it would "predict"). The W=5 spacing also supplies the ≥3-session independence the H=3 forward window needs.
- **Direction:** `s` = the pre-registered sign for that category (same for every firing in the category).
- **Entry/exit (lookahead-safe):** news mapped to its first tradable ET session `d` (news at/after 16:00 ET → next session); `P_entry = open[d+1]`, `P_exit = close[d+3]`. Signed forward return `R = s · (P_exit/P_entry − 1)`; **hit = R > 0**.
- **Statistic:** directional hit rate `HR` over the category's firings.
- **No train/holdout split.** Nothing is fit on 2016–2021 (categories from SP1's outcome-blind counts; directions from theory; categorizer from 2024 face-validity). With zero degrees of freedom on the test data, a holdout buys nothing and halves power, so each category is **one clean test on the full window**.

---

## 3. Null, power, verdict gate

One-sided binomial, `H₀: HR ≤ 0.55` vs `H₁: HR > 0.55` (same options-viable null as Stage 1; it is also the bar SP1's counts were sized against). Detect `HR₁ = 0.63` at 80% power.

- **Required n per category** (single test, no split): uncorrected α=0.05 → **235**; corrected **α/K=0.00625 → ~426**. (The scorer recomputes exactly.) SP1's 2022–2026 distinct counts (all SP2 categories ≫ 426) suggest every category clears over 6 years of 2016–2021 — **confirmed at fetch time**; any that falls short is **UNDERPOWERED**, not FAIL.
- **Per-category verdict (frozen thresholds):**
  - **PASS** iff binomial `p < α/K` **and** date-block bootstrap (10-session blocks, seed 1234) `p5 > 0.55` **and** `n ≥ required_n`.
  - **FAIL** iff binomial fails to reject at adequate power.
  - **UNDERPOWERED** iff `n < required_n` (report, do not relax).
- Cross-ticker/time clustering handled by the date-block bootstrap (same as Stage 1); the binomial is the headline, the bootstrap the conservative guard; on disagreement the bootstrap governs.

---

## 4. Components & reuse

| Need | Component | Status |
|---|---|---|
| Categorizer (split `analyst_pt`→`_raise`/`_cut`) | `scripts/stage1_news_categories.py` | modify (2 new patterns replace `analyst_pt`) |
| Historical news 2016–2021 | `scripts/stage1_fetch_catalysts.py` pattern | new resumable fetch over the new window, categorized → per-category event table |
| Daily bars 2015–2021 (all 56 names) | `scripts/stage1_backfill_bars.mjs` | extend `START`/symbol list; IEX adjusted |
| Per-category firing build | `scripts/sp2-build-category-firings.mjs` (new) | reuses bar-load + news→session + forwardReturn from `stage1-build-signals.mjs`; assigns the pre-registered direction per category + cluster-dedup; emits per-category firings |
| Scoring | `scripts/stage1-score.mjs` + `binomial-stats.mjs` + `stage1-bootstrap.mjs` | reuse; run per category at α/K |
| Pre-registration | `scripts/sp2-prereg.mjs` (new, mirrors `stage1-prereg.mjs`) | freezes the direction map + K + window + categorizer hash + per-category firing hashes |

**Boundaries:** the new `sp2-build-category-firings.mjs` is the one genuinely new unit — it replaces Stage 1's sentiment×price-state agreement with a fixed per-category direction, and emits one firing set per category. Everything else is reuse or a small extension.

---

## 5. Pre-registration artifact (frozen before any scoring)

`data/lab/sp2-preregistration.json`, committed before scoring, self-hashed; the scorer refuses to run a category on mismatch. Contents: the §1 direction map (verbatim), `K=8`, `corrected_alpha`, `required_n`, window `2016-01-01..2021-12-31`, `horizon=3`, entry/exit convention, dedup `W=5`, bootstrap params, the categorizer **code hash**, and a **per-category firings file hash** (locks each category's exact firing set). Direction-uncertain flags recorded per category.

---

## 6. Data preparation (live, one-time, resumable)

1. **Bars:** backfill IEX adjusted daily bars `2015-11-01 → 2021-12-31` for all 56 names (warmup before 2016-01 for SMA/return context is unused here — price-state isn't a filter in SP2 — but the H=3 forward window needs bars through early 2022, so fetch `2015-11 → 2022-02`). Names that didn't trade early (COIN/PLTR/MARA/MSTR) simply contribute fewer firings.
2. **News:** fetch Alpaca news `2016-01 → 2021-12`, categorize with the split categorizer, attribute to universe symbols → per-`(ticker, date, category)` table (resumable per-month checkpoints).
3. **Build:** per category, dedup → distinct firings → forward returns → `data/lab/sp2-firings-<category>.json`.

---

## 7. Verdict reporting

A per-category table: `category | direction | n | HR | binomial_p | bootstrap_p5 | verdict`, plus a family roll-up (analyst / legal-regulatory / corporate-action) and a one-paragraph honest summary. PASS categories (if any) are candidates for a *shares-only* follow-up; the program makes **no options claim** (Stage 1 settled that shares express any directional edge better).

---

## 8. Honesty caveats (pre-recorded)

- **Survivorship/eligibility:** the *current* 56 names back-applied to 2016 — today's winners. Biases discovery upward; a FAIL is therefore strong.
- **Regime drift:** 2016–2021 spans the 2018 selloff and COVID crash/recovery; a category's behavior may be regime-specific. The test asks the across-regime average, by design.
- **IEX feed:** thinner than consolidated SIP; immaterial for mega-cap close/open returns.
- **Categorizer is the instrument:** precision-leaning keyword matcher, frozen by hash but imperfect; mislabeled firings add noise (bias toward HR=0.5, i.e. toward FAIL — conservative).
- **Direction-uncertain categories:** `product_launch`/`restructuring` FAILs mean "no UP-signal," not "no signal."
- **Multiple comparisons:** controlled by fixed-K Bonferroni; even so, with 8 tests at α/8, an isolated PASS warrants a confirmatory forward/out-of-window check before belief.

---

## 9. Testing (TDD)

- Categorizer split: `analyst_pt_raise` tags "raises/boosts price target", `analyst_pt_cut` tags "cuts/lowers price target", neither tags the other; multi-label preserved.
- `sp2-build-category-firings.mjs`: pure helpers (per-category direction assignment, cluster-dedup parity with the Python version, forward-return sign by direction) unit-tested with mock catalysts+bars; lookahead guard (exit uses only ≤ d+H).
- `sp2-prereg.mjs`: artifact build + self-hash + tamper-rejection (mirrors Stage 1 prereg tests).
- Scoring reuse is already tested (Stage 1).
