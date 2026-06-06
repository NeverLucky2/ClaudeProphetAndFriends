# EMA-Pullback Study — Runbook

Lab-only pre-registered backtest of a daily mechanical EMA-pullback strategy. Read-only; no
deployment. Mirrors the Coil studies. See `docs/superpowers/specs/2026-06-06-ema-pullback-backtest-design.md`.

## Prereq

Source the project-root `.env` so `FMP_API_KEY` is in the environment (it is not exported by
default — see memory `fmp-api-key-location`):

```bash
set -a; source .env; set +a   # bash
```

## Pipeline (order matters)

```bash
node scripts/ema-fetch-bars.mjs   # 1. backfill bars → data/lab/ema-bar-cache/{TICKER}.json (network)
node scripts/ema-build.mjs        # 2. enumerate trades → data/lab/ema-instances.json
node scripts/ema-prereg.mjs       # 3. write + hash-lock data/lab/ema-prereg.json (MUST precede scoring)
node scripts/ema-score.mjs        # 4. score frozen holdout → docs/lab/ema-pullback-RESULTS.md (+ VERDICT)
```

`ema-score.mjs` refuses to run (exit 4) on a prereg hash mismatch. Changing any locked param
requires deleting + regenerating the prereg. Re-running score on unchanged inputs is
deterministic.

`data/lab/*` (bars, instances, prereg) is git-ignored; only `docs/lab/ema-pullback-RESULTS.md`
is committed (it carries the prereg hash).

## Tests

```bash
node --test scripts/ema-*.test.mjs   # 32 unit tests
```

## Result (run 2026-06-06)

**VERDICT: REJECT** (prereg hash `83a5ea75`). 7,364 trades; beta-adjusted holdout alpha −0.27%/
trade vs SPY (CI [−0.38%, −0.16%]) and −0.31% vs QQQ — both CIs entirely negative; negative in
every year and on the train split. Mechanical daily win rate 50.7% (the author's ~68% claim did
not replicate on daily bars). The long side's ~flat raw return is harvested equity beta, not
alpha. A daily REJECT does not debunk the author's intraday/tick regime, which is out of scope.

## Not built (deferred)

- Grid CLI runner + the width-filter / CCI-divergence ablation flags (the `gridConfigs`
  enumerator exists in `ema-grid.mjs`; exploratory-only, never gates the verdict).
- §6 downside/conditional-beta ballast lens (needs a strategy equity-curve return series; only
  relevant on a KEEP-CANDIDATE verdict — moot given REJECT).
