# Coil Catalyst-Dip Event Study — B1 (Price-Signature) RESULTS

**Run:** 2026-06-03 · branch `coil-catalyst-dip-event-study`
**Spec:** `docs/superpowers/specs/2026-06-03-coil-catalyst-dip-event-study-design.md`
**Plan:** `docs/superpowers/plans/2026-06-03-coil-catalyst-dip-event-study-b1.md`
**Prereg artifact:** `data/lab/coil-prereg.json` (hash `70a97f0a`, frozen before scoring)

## One-line verdict

**NO material effect.** Among Coil's oversold-dip entries, a *price-signature catalyst footprint*
(big gap × volume spike) does **not** predict worse market-adjusted forward returns. At Coil's
actual 5-day hold horizon the result is **NO_EFFECT on both train and holdout** (equivalence-
confirmed inside ±1%). **A price-signature catalyst gate is not warranted.**

## Method (as pre-registered)

- **Firing base:** every bar in Coil's 80-name `MeanRevUniverse` over 2021-11→2026-05 where Coil's
  entry fired (RSI(2)<5 ∧ close>SMA200 ∧ close<SMA5). **2,861 instances** (full unconditional base).
- **Label:** composite `= volume_ratio × |gap_pct|`; top tercile of the **TRAIN** distribution
  (threshold **0.00916**, frozen) = "catalyst-like", rest = "clean".
- **Outcome:** market-adjusted (minus SPY) lookahead-safe forward return at +5/+10/+20 sessions,
  entry `open[d+1]` → exit `close[d+H]`, **independent of Coil's −7%/5-day exit**.
- **Test:** two-sample mean-difference (catalyst − clean), date-block bootstrap (10-session blocks,
  10,000 iters, seed 1234), one-sided hypothesis (catalyst *worse*). MDE = 1.0% of forward return.
- **Split:** chronological 50/50; holdout scored once, gated by the prereg self-hash.

## Results

Mean-difference = (catalyst mean − clean mean) market-adjusted forward return. Negative ⇒ catalyst worse.

**TRAIN** (n_catalyst 477 / n_clean 953):

| H | meanDiff | 95% CI | verdict |
|---|---|---|---|
| 5 | +0.0026 | [−0.0017, +0.0066] | **NO_EFFECT** |
| 10 | +0.0064 | [+0.0009, +0.0127] | INSUFFICIENT |
| 20 | +0.0072 | [−0.0018, +0.0170] | INSUFFICIENT |

**HOLDOUT** (n_catalyst 409 / n_clean 1001):

| H | meanDiff | 95% CI | verdict |
|---|---|---|---|
| 5 | −0.0018 | [−0.0065, +0.0028] | **NO_EFFECT** |
| 10 | −0.0023 | [−0.0101, +0.0047] | INSUFFICIENT |
| 20 | −0.0029 | [−0.0167, +0.0103] | INSUFFICIENT |

## Interpretation

1. **No SIGNAL on any horizon or split.** The catalyst bucket never shows a materially-worse
   (≤ −1%) forward return with a CI excluding zero. Effect sizes are sub-0.3% at H=5 and the **sign
   flips** between train (+) and holdout (−) — the fingerprint of noise, not a stable effect.
2. **H=5 is the decision-relevant horizon** (Coil holds ≤5 sessions). There, both splits are
   **NO_EFFECT by equivalence**: with ~1,400 instances per split the CI is tight enough to *rule out*
   a ±1% effect. This is a genuine "no material effect" conclusion, not mere underpower.
3. **Entry-vs-exit read (the +5/+10/+20 contrast):** there is no underperformance to attribute to
   either an entry signal or the exit rule. At longer horizons train catalyst dips did slightly
   *better* and holdout slightly *worse* — no consistent "catalyst dips revert slower" story. So
   **neither an entry gate nor an exit-rule change is indicated.**
4. **Bearing on the GOOGL case (the motivation):** GOOGL's 2026-06-02 drop (~4% gap on a volume
   spike) sits firmly in the catalyst bucket. Catalyst-bucket dips do not underperform ⇒ the GOOGL
   loss was within the strategy's normal noise, **not** a systematic edge leak a filter would fix.
   This vindicates the original skepticism (sample-of-one; mean reversion's best returns come from
   the scariest dips; don't shave the right tail).

## Honest caveats

- **This is the PRICE-signature half (B1) only.** The "clean" bucket is a **lower bound** on true
  catalyst presence — a fundamental catalyst with *no* price footprint (e.g., a quiet equity-raise
  headline that doesn't gap the stock) would be mislabeled clean. So NO_EFFECT here means
  *"the price footprint of a dip doesn't predict worse returns,"* **not** "no fundamental catalyst
  ever matters." That said, the motivating GOOGL event *did* have a large price footprint and is
  captured — which lowers the prior that the news-only half (B2) finds something the price half missed.
- **Window partly burned** by the earlier stage1 program (2022–2026). A SIGNAL would have required
  forward confirmation (the live instrument, A) before any gate. Since there is no signal, A is moot.
- **MMC** had truncated data (1,053 bars ending 2026-01-13); negligible against 2,861 instances.

## Decision

- **Do NOT build a price-signature catalyst gate** (B-spec decision tree: NO_EFFECT ⇒ do not gate).
- **A (live instrument) is NOT triggered** (built only on a SIGNAL).
- **B2 (news split)** remains the one open increment, but its expected value is **lowered** by this
  null (the price half already captures gap-on-volume catalysts, including the GOOGL archetype).
  Recommend B2 only if there is independent interest in *price-quiet* fundamental catalysts.
