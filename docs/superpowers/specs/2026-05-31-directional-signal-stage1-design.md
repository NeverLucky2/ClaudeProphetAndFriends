# Two-Stage Signal/Options Experiment — Stage 1 Design & Pre-Registration

**Date:** 2026-05-31
**Status:** Design approved; pre-registration values frozen below. Stage 2 deliberately NOT designed yet.
**Type:** Lab study (pre-registered methodology), not a strategy to ship.

---

## 0. Framing & the one principle that governs everything

The question is whether a directional signal built from **news catalysts + market state** can predict
short-term equity direction, and — only if it can — whether **options** are a worthwhile way to express it.
The honest prior is **"no edge."** This experiment's job is to confirm or refute that prior cleanly, not to
manufacture a positive result. We pre-register every threshold *before* looking at the validation data so the
result cannot be reverse-engineered.

**The governing principle — do not collapse the two stages:**

- **Stage 1 tests the signal on the underlying (shares), with no options anywhere.** This strips spread, theta,
  strike, and expiry and isolates the only question that gates everything else: *does the signal predict
  direction better than chance, by enough to overcome options costs later?* Most candidate signals should die
  here, cheaply.
- **Stage 2 (deferred) tests the options expression, only if Stage 1 passes.** Its decisive comparison is **not**
  "are the options profitable" — it is "does the options expression beat trading the underlying directly, net of
  costs?" If the edge is purely directional, shares express it better; options only earn their place for a
  magnitude/timing/convexity view. **Stage 2 is not built until Stage 1 runs and passes.**

This document fully specifies Stage 1 and stubs Stage 2.

---

## 1. Reuse map (no new machinery where existing tooling fits)

| Need | Reuse | Notes |
|---|---|---|
| Daily bars (underlying + SPY) | `data/bar-cache` via `agent/bar-cache-reader` (Alpaca) | **From Alpaca, not FMP** — matches the "drop FMP eventually" goal. No new API wiring. |
| Replay pattern | `cmd/driftreplay` (Go) as a reference shape | Stage 1 lives in **Node** (`scripts/*.mjs`), because the signal is news/sentiment-driven (Python+Node skill world), not in-engine. Go replay is the wrong home here. |
| Train/holdout split mechanics + JSON/CLI envelope conventions | `scripts/score-rule-against-holdout.mjs` | We reuse its **conventions** (chronological split, verdict envelope, stdin→JSON CLI). Its `buildVerdict` is a heuristic P&L-delta gate, **not** a hypothesis test — see §1.1. |
| Friction (Stage 2 only) | `scripts/apply-friction.mjs` → `single_leg_options` profile | Already models spread-crossing + commissions + reg fees. **Optimistic for short-dated OTM** (see §9). Deferred. |
| Catalyst news fetch | `.claude/skills/catalyst-news` (Python) | Currently **last-24h only**; must be extended to a historical date range (§7). |
| Market regime labels (secondary, descriptive) | `scripts/build-regime-history.mjs` | Reused only for descriptive regime-bucket reporting. **Pull SPY from the Alpaca bar-cache, not FMP v3**, when wiring this in. |

### 1.1 The one genuinely-new piece (flagged honestly)

Neither `significance-gate.mjs` (a "do we have enough loss exposure to act" heuristic) nor
`score-rule-against-holdout.mjs`'s `buildVerdict` (a min-trades / min-P&L-delta heuristic) performs a real
**hypothesis test or power calculation**. Stage 1 needs an actual one-sided binomial test against a negative
null, with autocorrelation-robust inference. That test is new code (`scripts/binomial-power.mjs`,
`scripts/stage1-score.mjs`). We reuse the *conventions* of the existing tools, not their statistics.

### 1.2 Binding external constraint I cannot see — **you must verify**

The `catalyst-news` skill fetches the **last 24h** of news — it is a real-time daily-brief tool, not a historical
archive. Whether FMP's `/stable/news/stock` returns enough **timestamped historical** news to populate a TRAIN +
HOLDOUT window of the depth Stage 1 requires (§3) is **unknown to me and gates the whole experiment**. If history
is too shallow to reach the pre-registered n, the verdict is **UNDERPOWERED → STOP** (§6) — a legitimate finding,
not a reason to shrink the test. **Action for you: confirm FMP historical news depth on your tier before we run.**

---

## 2. Stage 1 — the prediction (lookahead-safe, precise)

A **firing** is a tuple `(ticker, day d, direction s ∈ {+1 long, −1 short})`:

- **Trigger (the "when"):** a catalyst flag is active on `(ticker, d)` — `ma` or `earnings` (earnings-whisper)
  per the `catalyst-news` classifier — on a name in the **56-name optionable universe**
  (`.claude/skills/analyst-actions/universe.txt`), using only news **timestamped ≤ d's close**.
- **Direction `s` (the "which way"):** set by **news-sentiment sign** AND **price-state**, which must agree:
  - `s = +1` if sentiment > 0 **and** price-state bullish;
  - `s = −1` if sentiment < 0 **and** price-state bearish;
  - **no fire** if they disagree, or either is neutral. *(This conjunction is the core hybrid rule: catalyst
    selects the sample, sentiment+state pick the direction, disagreement abstains.)*
- **Entry / exit (no lookahead):** `P_entry = open[d+1]`, `P_exit = close[d+3]` (3 sessions held: d+1, d+2, d+3).
  Signed forward return `R = s × (P_exit / P_entry − 1)`. **Hit = (R > 0).**
  - The 1-session gap between signal (≤ d close) and entry (d+1 open) makes the test fill-honest at Stage-1
    altitude; microstructure realism beyond that is Stage 2's job, not Stage 1's.

**Primary test statistic = directional hit rate `HR` = P(R > 0) over thinned firings.**
Mean signed `R` (and a bootstrap CI on it) is reported as a **secondary descriptive only** — it does **not** enter
the verdict gate, so the gate remains a single comparison.

### 2.1 Component definitions (pre-registered, deterministic)

- **Sentiment sign — `keyword_polarity_v1` (primary, hashable):** deterministic polarity from headline+snippet
  keyword classes. Positive: `to acquire / agrees to buy / takeover / raises guidance / beats/tops/crushes
  estimates / preannounces above`. Negative: `profit warning / cuts guidance / warns on / misses/trails
  estimates / preannounces below`. M&A-on-target = positive for the target. Net sign = sign(Σ positive −
  Σ negative) over items on `(ticker, d)`; ties → neutral → no fire. Chosen because a prereg artifact that gates
  a holdout **must be reproducible and leakage-free** — a pretrained model risks non-reproducibility and
  look-ahead if it saw data overlapping the test window (§4, variant rule).
- **Price-state (from bars):** bullish if `close[d] > SMA20[d]` **and** `ret5d[d] > 0`; bearish if
  `close[d] < SMA20[d]` **and** `ret5d[d] < 0`; else **neutral** (no fire). `ret5d[d] = close[d]/close[d−5] − 1`.

---

## 3. The negative null `HR₀` — the bar that is NOT a coin flip

> An options buyer pays the variance premium plus costs, so a Stage-1 pass must clear a bar high enough that the
> signal could *plausibly* survive Stage 2 — not merely beat 50/50.

**Pre-registered: `HR₀ = max(0.55, derived_breakeven_train)`.**

- **0.55 floor (operative bar).** Unambiguously above chance. For a *shares* read — which is exactly what `HR`
  tests — 0.55 over 3 days is already a strong signal; most real equity directional signals live at 0.51–0.53.
  Pushing the floor to 0.57–0.58 mostly makes the expected fail more certain while inflating n toward
  unreachability, so we hold at 0.55.
- **`derived_breakeven_train` (secondary, upward-only safeguard).** A Monte-Carlo break-even hit rate for a
  stylized 3-day ATM long call, priced over the **TRAIN-only** distribution of 3-day moves under the **locked**
  `config/friction.json` `single_leg_options` profile (find the HR at which the stylized option's expectancy = 0
  after friction). Computed before the holdout is touched. **If it exceeds 0.55, `HR₀` rises to it; it can only
  move the bar up.** This guard only bites if mega-cap 3-day moves are so small that even a 0.55 directional edge
  couldn't fund the option.
- **Honest limitation:** this is a deliberately conservative hurdle, **not** a precise Stage-2 break-even (that's
  Stage 2's job). Its only purpose is to ensure a Stage-1 pass isn't a coin flip that dies instantly on options
  costs. The asymmetry (floor fixed, derivation upward-only) is intentional: it can never *weaken* the bar.

---

## 4. Power calculation & sample size (locked before any results)

**Test:** one-sided binomial, `H₀: HR ≤ HR₀` vs `H₁: HR > HR₀`, `α = 0.05`.

**Effect size — pre-registered as a "large-edge-only" test:** detect a true `HR₁ = HR₀ + 0.08` at power
`1 − β = 0.80`. The anchor for `HR₁` is *the smallest edge we would actually act on through options* — and for an
options expression that edge is large, because small directional edges die on options friction regardless. We are
therefore **deliberately testing for a large directional edge; a small real edge would be missed, and that is
acceptable because a small edge is not options-viable.**

- **Recorded caveat (the shares exception):** if a found signal would be happily traded **as shares**, small
  edges *do* matter there, and `HR₁ = +0.05` would be defensible. We still choose `+0.08` because a `+0.05` test
  at achievable history almost certainly lands **UNDERPOWERED → STOP** (you learn nothing), whereas the `+0.08`
  test actually returns a verdict. The runnable experiment wins. *(If Stage 1 unexpectedly clears with depth to
  spare, a follow-on `+0.05` shares-only test is a clean future extension.)*

**Required sample size** (normal approx. to the binomial):

```
n ≈ ( z_{1−α}·√(HR₀(1−HR₀)) + z_{1−β}·√(HR₁(1−HR₁)) )² / (HR₁ − HR₀)²
```

For `HR₀ = 0.55`, `HR₁ = 0.63`, `α = 0.05` (z = 1.645), power 0.80 (z = 0.842):

```
( 1.645·√(0.2475) + 0.842·√(0.2331) )² / 0.08²
= ( 0.8184 + 0.4065 )² / 0.0064
= 1.5004 / 0.0064  ≈ 235 independent firings PER SPLIT
```

**`scripts/binomial-power.mjs` computes this once and writes it into the prereg artifact.** If `HR₀` is raised by
`derived_breakeven_train`, n is recomputed (still pre-holdout) and the higher n governs.

**This is most likely the decisive constraint.** ~235 *non-overlapping* catalyst firings in the holdout (and the
same in train) probably needs **2–4+ years** of timestamped catalyst news across 56 names. See §1.2 and §6.

---

## 5. Autocorrelation — overlapping H=3 windows AND market co-movement

Two distinct dependence problems, two pre-registered guards:

1. **Overlapping forward windows (per ticker).** Consecutive firings on the same ticker within 3 sessions share
   overlapping forward returns. **Thinning (primary):** per ticker, keep only firings **≥ H (=3) sessions apart**
   (greedy, earliest-first). The surviving count is the **"independent n"** used in both the power calc and the
   binomial test.
2. **Cross-sectional + multi-week clustering.** All 56 names co-move on a given day, and catalysts *cluster in
   calendar time* (earnings season packs correlated firings across many days). The binomial's independent-trial
   assumption is violated in both. **Robustness guard = date-block bootstrap:** resample **whole blocks of ~10
   consecutive trading sessions** (≈2 weeks), keeping every firing inside a block together, 10,000 iterations,
   fixed seed. Require the bootstrap **5th-percentile HR > HR₀**. If the binomial and the bootstrap disagree, the
   **conservative (bootstrap)** result governs.
   - **Recorded residual:** a 10-session block absorbs same-day co-movement and most earnings-season clustering
     but not arbitrarily long correlation; the bootstrap p is therefore **still slightly optimistic**. Noted, not
     blocking — a one-line honesty caveat in the artifact.

---

## 6. Train / holdout split & verdict gate (thresholds fixed before results)

**Split — single chronological 50/50.** Earliest 50% of the date range = **TRAIN** (develop & freeze everything
tunable: the `derived_breakeven_train` value, any sentiment-threshold tie-handling, the variant declarations).
Latest 50% = **HOLDOUT**, scored **exactly once**, at the very end. Chronological (not random) preserves temporal
independence across the H=3 window and lets regime non-stationarity show rather than hide.

> **Note — minimal tuning surface (a strength).** For the primary `k=1` signal, the fire rule is *fully
> pre-specified* (sentiment sign, price-state, the agreement conjunction, ties→neutral). There is essentially
> nothing to fit on TRAIN. TRAIN's job is therefore narrow: (a) compute `derived_breakeven_train` for `HR₀`, and
> (b) confirm the achievable independent firing count before committing to score the holdout. The smaller the
> thing we tune, the smaller the overfit surface — and here it is near zero by construction. **50/50 (vs 60/40)** is
chosen because holdout power is the binding constraint and development is less n-hungry than the powered test, so
the more n-efficient split lowers the total-firings hurdle (~235-firing holdout costs less total history at 50/50
than at 60/40). **Re-running the holdout after seeing results voids the pre-registration.** Walk-forward is noted
as a future extension *only* if data depth surprises upward.

**Verdict gate (on HOLDOUT, thinned firings):**

- **PASS → proceed to Stage 2** iff **all** of:
  (a) binomial `p < α` (Bonferroni-adjusted over `k` declared variants — see §4/§ below), **and**
  (b) date-block bootstrap 5th-percentile `HR > HR₀`, **and**
  (c) achievable independent `n ≥ required n`.
- **FAIL → STOP** iff binomial fails to reject at adequate power. *(Expected outcome. A clean negative result is a
  success for this experiment.)*
- **UNDERPOWERED → STOP** iff achievable independent `n < required n`. Report the gap. **Do not** relax `HR₀`,
  `HR₁`, or the thinning rule to manufacture a pass.
- **Overfit signature (recorded, non-gating):** if TRAIN passed but HOLDOUT `HR ≤ 0.5`. The holdout verdict
  governs regardless.
- **Regime-bucket HR (secondary, descriptive only):** never used to cherry-pick a passing sub-slice.

### Multiple-comparisons discipline (locked)

- **`k` (the count of pre-registered signal variants tested) is frozen in the prereg artifact.** The primary
  `keyword_polarity_v1` signal is `k = 1`. Any richer-model or alternative-threshold variant must be declared up
  front and raises `k`.
- **Abandoning a variant after peeking at TRAIN does NOT reduce `k`.** You still tested it, so it still pays its
  Bonferroni share (`α/k`). Otherwise the correction is theater.
- **Model-based sentiment variants** additionally require explicit verification that the pretrained model had
  **no training exposure to the HOLDOUT period** (leakage guard), recorded in the artifact.

---

## 7. Data flow & components (Node; mirrors your `scripts/*.mjs` lab)

1. **Bars** — `agent/bar-cache-reader` over `data/bar-cache` (Alpaca). No FMP, no new API wiring.
2. **Catalysts (historical)** — extend `catalyst-news` Python fetch to accept `--from/--to` (today: 24h only) →
   `data/lab/catalysts-<from>-<to>.json` as a per-`(ticker,date)` table with `event_type`, headline, snippet,
   published timestamp. **⚠ Gated on the §1.2 FMP-history verification.**
3. **Sentiment sign** — `keyword_polarity_v1` over the catalyst table (deterministic, reproducible).
4. **Price-state** — from bars (SMA20 + 5-day return), per §2.1.
5. **Signal assembly** — `scripts/stage1-build-signals.mjs`: join catalysts (trigger) × sentiment-sign ×
   price-state → fires `(ticker, d, s)`; apply per-ticker thinning; tag TRAIN/HOLDOUT by split date.
6. **Scoring** — `scripts/stage1-score.mjs`: compute forward returns from bars, hit/miss, `HR` per split;
   one-sided binomial (Bonferroni over `k`); 10-session date-block bootstrap (seeded); emit a verdict envelope in
   the `score-rule-against-holdout.mjs` JSON/CLI style. **Refuses to score the holdout unless the prereg artifact
   exists and its hash matches.**
7. **Power** — `scripts/binomial-power.mjs`: the §4 calc; run once; output frozen into the artifact.
8. **Pre-registration artifact** — `data/lab/stage1-preregistration.json`: freezes every threshold + a content
   hash, committed **before** holdout scoring. Schema:

```json
{
  "preregistration_version": "1.0",
  "created_utc": "<iso>",
  "horizon_sessions": 3,
  "entry": "open[d+1]", "exit": "close[d+3]",
  "universe_file": ".claude/skills/analyst-actions/universe.txt", "universe_hash": "<sha256-8>",
  "signal": {
    "trigger": "catalyst flag (ma|earnings) on (ticker,d), news <= d close",
    "sentiment_source": "keyword_polarity_v1",
    "price_state": "close>SMA20 & ret5d>0 => bull; mirror => bear; else no-fire",
    "fire_rule": "sentiment_sign == price_state_sign != 0; s = that sign"
  },
  "null": { "HR0_floor": 0.55, "HR0_rule": "max(0.55, derived_breakeven_train)",
            "derived_breakeven": "MC stylized 3d ATM call, TRAIN-only, upward-only", "HR0_final": null },
  "power": { "alpha": 0.05, "sided": "one", "HR1_rule": "HR0+0.08", "power": 0.80,
             "required_independent_n_per_split": 235 },
  "variants": { "k": 1, "declared": ["keyword_polarity_v1"],
                "rule_abandon": "peeking-then-abandoning does NOT reduce k",
                "rule_model_variant": "must verify no training exposure to holdout period" },
  "split": { "scheme": "chronological_50_50", "train_pct": 0.5, "holdout_pct": 0.5, "split_date": "<computed>" },
  "thinning": "per-ticker, keep firings >= 3 sessions apart (greedy earliest-first)",
  "bootstrap": { "method": "date_block", "block_sessions": 10, "iterations": 10000, "seed": 1234,
                 "require": "p5 HR > HR0_final", "residual_note": "long-horizon clustering uncaptured; p slightly optimistic" },
  "verdict": { "PASS": "binom p<alpha/k AND bootstrap_p5>HR0_final AND n>=required",
               "FAIL": "binom not rejected at power", "UNDERPOWERED": "achievable n < required n" },
  "friction_config_hash": "<sha256-8 of config/friction.json at prereg time>"
}
```

---

## 8. Testing (TDD, `node:test` — per workflow preference)

Unit tests, all with mocked bars/catalysts (no network):

- **Forward-return lookahead guard** — exit uses only bars ≤ d+H; signal uses only news ≤ d close.
- **Thinning** — no two kept firings within H sessions on a ticker; greedy earliest-first is deterministic.
- **Binomial p-value** — vs a known reference value.
- **Bootstrap determinism** — seeded; same seed → same p5; block keeps same-block firings together.
- **Verdict truth-table** — PASS / FAIL / UNDERPOWERED across boundary inputs.
- **Prereg-hash enforcement** — scorer refuses to run the holdout if the artifact is missing or its hash mismatches.
- **`keyword_polarity_v1`** — sign correctness on fixture headlines, tie → neutral → no fire.

---

## 9. Deferred — Stage 2 (NOT built now; stub only)

Built **only if Stage 1 PASSes.** Scope when reached:

- **Options friction realism.** `config/friction.json` `single_leg_options` currently assumes
  `assumed_spread_pct_of_mid = 0.04` — realistic for liquid mega-cap *near-the-money* options, **optimistic for
  short-dated OTM**, where the spread can be a large fraction of premium. Must verify/extend before any options
  backtest; optimistic fills make the Stage-2 result fiction.
- **Strike / expiry selection** for expressing a 3-day directional view.
- **The decisive benchmark: options-vs-shares, net of costs.** Conclude **shares** unless options *demonstrably*
  add magnitude/timing/convexity value beyond the directional edge. "Options are profitable" is **not** the bar.

---

## 10. Open items you must verify (claims I can't see)

1. **FMP historical news depth** on your tier for `/stable/news/stock` over the intended window (§1.2) — the
   single biggest gate on whether Stage 1 is even runnable.
2. **Achievable independent n** once catalysts are fetched + thinned — compare to the 235/split requirement before
   scoring the holdout; if short, the verdict is UNDERPOWERED and we stop.
3. **`config/friction.json` lock** — confirm the friction config is the version you want frozen into the prereg
   hash (it feeds `derived_breakeven_train`).
