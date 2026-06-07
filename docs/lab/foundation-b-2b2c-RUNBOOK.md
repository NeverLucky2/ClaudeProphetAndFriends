# Foundation B 2b/2c — RUNBOOK

Beta/orientation (2b) + two-track graduation gate (2c) for the fleet measurement layer. Read-only, operator-reviewed, never auto-acts. Spec: `docs/superpowers/specs/2026-05-31-foundation-b-component2-measurement-design.md`.

## Run

```bash
export $(grep -E '^(ALPACA_PUBLIC_KEY|ALPACA_SECRET_KEY)=' .env | xargs)
node scripts/graduation-report.mjs --root .     # → docs/lab/graduation-report.md
node --test scripts/{alpaca-spy-daily,segment-beta,graduation-gate,graduation-report}.test.mjs
```

## Dependencies / data clock

- Consumes the Go `db_segment_pn_ls` daily series (Component 1). **That writer only runs once the Go
  bot is rebuilt from local main** — until then the series is empty and every verdict is
  `HOLD: insufficient data` (correct, not a bug). Verdicts mature automatically as rows accrue
  (~a quarter for the 3-month clock + MIN_BETA_DAYS=30 deployed days).
- SPY from Alpaca (split-adjusted), not FMP (D-B6).

## Pinned params (a-priori, spec §7)

- N=20 (min eligible trades for alpha GRADUATE)
- BETA_BAND=0.6 (deployed-beta CI must fit within ±0.6 for alpha GRADUATE)
- MIN_BETA_DAYS=30 (deployed-beta sample minimum)
- retire=6mo (HOLD→RETIRE gate)
- bootstrap B=10000 (seeded, for CI computation)

## Tracks

- **ALPHA** (Coil, Turtle): edge-CI>0 + adversity + ≥3mo + deployed-beta CI within ±0.6.
- **BALLAST** (DefensiveProphet): structural convexity + bounded bleed + downside-beta CI ≤ 0;
  expectancy is NOT a gate. The options friction model + dollar bleed budget are the one open
  seam (spec §8) — finalize when def-Prophet's ballast graduation approaches (~3mo out).

## Verdicts

- **GRADUATE**: all criteria cleared (passed to operator for review).
- **HOLD**: gathering data or a criterion hasn't cleared yet (monitor and rerun).
- **REJECT**: a hard criterion failed (e.g., no edge, wrong beta, adds crash risk); retire if >6mo HOLD.
- **RETIRE**: HOLD exceeded 6-month deadline.

Operator-reviewed; never auto-acted.
