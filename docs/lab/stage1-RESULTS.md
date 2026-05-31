# Stage 1 — Results: FAIL (no options-viable directional edge)

**Date:** 2026-05-31
**Verdict:** **FAIL → STOP.** Stage 2 (options) NOT built, per the pre-registered gate.
**Spec:** `docs/superpowers/specs/2026-05-31-directional-signal-stage1-design.md`
**Frozen pre-registration:** `data/lab/stage1-preregistration.json` (artifact_hash `555fe72b`), committed *before* the holdout was scored.

## What was tested
A catalyst-triggered, sentiment+price-state-directional signal's ability to predict the **sign of the 3-day forward return of the underlying** (shares — no options), over **2022-01 → 2026-05** across the 56-name optionable universe.
- **Trigger:** hardened `classify_catalyst_strict` (M&A / earnings-whisper), Alpaca news (FMP-free).
- **Direction:** `keyword_polarity_v1` sign must agree with price-state (close vs SMA20 + 5d return); disagreement / neutrality → no fire.
- **Entry/exit:** `open[d+1] → close[d+3]`, lookahead-safe (news at/after 16:00 ET → next session).

## Pre-registered gate (frozen before scoring)
| Parameter | Value |
|---|---|
| Negative null HR₀ | 0.55 (floor; derived_breakeven bump not applied — only raises the bar) |
| Alt HR₁ (large-edge) | 0.63 (HR₀ + 0.08) |
| Required independent n | 235 / split |
| Split | chronological 50/50 at **2024-09-25** |
| Multiple comparisons k | 1 |
| Test | one-sided binomial vs HR₀, α=0.05; date-block bootstrap p5 > HR₀ |

## Result
664 firings (rate 664/1892 catalyst-days ≈ 0.35) → **332 train / 332 holdout** (POWERED).

| | Holdout (verdict) | Train (context) |
|---|---|---|
| hit rate | 58.4% (194/332) | 55.7% (185/332) |
| binomial p vs 0.55 | 0.114 (need < 0.05) | 0.418 |
| bootstrap p5 | 0.515 (need > 0.55) | 0.488 |
| **verdict** | **FAIL** | FAIL |

## Interpretation
- The holdout point estimate (58.4%) is *above* chance and even above the 0.55 floor numerically — tempting. But it is **not statistically distinguishable from the options-viable negative null** (p=0.114), and the **autocorrelation-robust** bootstrap lower bound (51.5%) sits **below 0.55** once temporal clustering/co-movement is accounted for. The rigor specifically prevents a false-positive read of a noisy 58%.
- Train (55.7%) < holdout (58.4%), so this is **not overfitting** — it's a weak/absent edge that is consistent across periods.
- FAIL at the 0.55 floor is **robust** to the unapplied upward `derived_breakeven_train` bump (a higher HR₀ only fails harder).

## What this does and does not establish
- **Does:** rejects *this* pre-registered signal (catalyst + keyword-sentiment + price-state, H=3, this universe/window) as having a **large, options-viable** directional edge. Confirms the "no edge" prior. Options would express this signal *worse* than shares regardless, so Stage 2 is correctly never reached.
- **Does not:** prove no directional signal exists anywhere. A **small** edge (HR between ~0.50 and ~0.58) is not excluded — but a small edge is, by construction, not options-viable, which is exactly why the test targeted a large edge.

## Honesty caveats (recorded)
- **Survivorship/eligibility bias:** the *current* 56-name universe applied back to 2022 (COIN/PLTR/MARA/MSTR etc. were smaller/newer then). Biases discovery upward if anything — and it still failed.
- **IEX feed:** bars are IEX-only (thinner than consolidated SIP), affecting opens slightly; immaterial for mega-cap close-to-open returns at this altitude.
- **Strict trigger** leans to precision (drops some real catalysts); the firing set is the conservative, high-confidence subset.

## Reproducibility
Deterministic given the committed code + preserved data: `data/lab/stage1-preregistration.json`, `data/lab/firings.json`, `data/lab/catalysts-2022-2026.json` (force-committed despite the `data/lab` gitignore, as the immutable evidence record). Re-score: `cat data/lab/firings.json | node scripts/stage1-score.mjs --artifact data/lab/stage1-preregistration.json --split holdout --hr0-final 0.55`.
