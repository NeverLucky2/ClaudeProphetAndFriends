# Fleet Hedge-Overlay — RUNBOOK

Ranks four equity-selloff hedges (def-Prophet put-spread proxy, static GLD/TLT/VIXM) by cost-adjusted
crash efficiency vs the reconstructed Merrill book + QQQ. Lab-only, read-only, no deploy. Spec:
`docs/superpowers/specs/2026-06-06-fleet-hedge-overlay-design.md`. Subproject 4 of the fleet
uncorrelated-ballast program (sibling of S1 fleet-correlation, S2 CEF, S3 bond-carry).

## Re-run

```bash
export $(grep -E '^FMP_API_KEY=' .env | xargs)   # project-root .env (key is not exported by default)
node scripts/overlay-fetch.mjs                   # book tickers + GLD/TLT/VIXM + QQQ + treasury → data/lab/overlay-cache/
node scripts/overlay-score.mjs --root .          # Task0 → prereg → frontier → docs/lab/fleet-hedge-overlay-RESULTS.md
node --test scripts/overlay-*.test.mjs           # 27 unit tests
```

`data/lab/*` and `data/portfolio/*` are gitignored; only `docs/lab/fleet-hedge-overlay-RESULTS.md`
and this RUNBOOK are committed. `overlay-fetch` reads the latest `data/portfolio/Holdings_*.csv` for
the reconstructed-book tickers (a private file — copy it into the checkout if absent).

## How to read it

- **Cost = calm-period (non-crisis) drag**, under the §4 funding convention. Read the recommendation
  against the **conservative book-funded** drag bound. (Cash-funded `r_f` is the optimistic bound.)
- **Cushion** = crisis-conditional contribution (paired-difference bootstrap CI), split **lumped /
  rate-shock / growth-scare**, each annotated with its **episode count** — a ≤2-episode CI is
  decorative (descriptive only). `robust` rests on ~3 events total; do not over-read it.
- **`efficiency`** is a dimensionless ratio (cushion ÷ calm-drag) used only to pick the flat-region
  size; the verdict (regime class + branch) uses the cushion CIs and cushion/drag directly.
- **Convex candidates** (def-Prophet, VIXM) also show a −10/−20/−30% stress grid; branch (a) cannot
  be won by a convex candidate without stress corroboration (convexity guard).
- **Recommendation branches:** (a) robust cheap *static* sleeve dominates / (b) def-Prophet primary /
  (c) honest null.

## Result (run 2026-06-06, prereg `becb8eb8…`)

**Branch (b) on both targets — activate the already-built def-Prophet.** The only regime-robust
hedges are the two convex ones (def-Prophet, most efficient; VIXM, robust but ~3× costlier). The cheap
static sleeves do NOT fill the gap: **GLD is ineffective** (cushion ≈ 0 in every cut — it just sits
there in crashes), and **TLT is ineffective overall and actively HURTS in the rate-shock cut** (its
rate-shock cushion CI is entirely negative — the 2022 stock-bond-correlation flip, the exact trap S3
fell into — while its growth-scare cushion is not statistically significant). This confirms the
hedge-gap thesis: a ρ≈0 static premium can't fill a hedge-shaped gap; the convex hedge already built
is the answer.

**De-scoped (honest):** spec §5 lists max-drawdown and Sharpe as *secondary context*; they are not
surfaced in RESULTS (non-decision-relevant — the verdict rests on the cushion CIs + calm-drag). The
`maxDrawdown`/`sharpe` helpers exist and are unit-tested in `overlay-combine.mjs` for future use.
Minor known cosmetic: the branch-(a) eligibility filter treats the 2%/yr budget as a soft gate, while
the rare branch-(a) fallback path does not — consistent with spec §7's "budget is an annotation, not a
hard gate," and inert here (verdict is branch b).

## Key limits (also in the hashed prereg)

- Reconstructed PAPER returns; static current-weights book; bull-favorable window; ~3 crisis episodes
  total (rate-shock ≈ 2022 only — its CI is decorative). def-Prophet is a structural-light proxy
  (QQQ<200DMA → BSM put-spread). See spec §12. The study deploys nothing; activation is a separate,
  user-driven step.
