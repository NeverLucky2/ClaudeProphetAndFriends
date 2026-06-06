# ORB Study — Runbook

Lab-only pre-registered backtest of a generic Opening-Range-Breakout strategy on liquid ETFs.
Read-only; no deployment. Sibling of the EMA study. Spec:
`docs/superpowers/specs/2026-06-06-orb-backtest-design.md`.

## Prereq

Alpaca creds (`ALPACA_PUBLIC_KEY` / `ALPACA_SECRET_KEY`) must be in a `.env` file in the
current working directory — `scripts/orb-fetch-bars.mjs` reads `.env` directly. (`.env` is
git-ignored; copy the project-root `.env` into the run directory if running from a worktree.)

## Pipeline (order matters)

```bash
node scripts/orb-fetch-bars.mjs   # 1. backfill Alpaca IEX 5-min bars → data/lab/orb-bar-cache/ (network)
node scripts/orb-build.mjs        # 2. enumerate one trade/session → data/lab/orb-instances.json
node scripts/orb-prereg.mjs       # 3. write + hash-lock data/lab/orb-prereg.json (MUST precede scoring)
node scripts/orb-score.mjs        # 4. score frozen holdout → docs/lab/orb-RESULTS.md (+ VERDICT)
```

`orb-score.mjs` refuses to run (exit 4) on a prereg hash mismatch. `data/lab/*` (bars,
instances, prereg) is git-ignored; only `docs/lab/orb-RESULTS.md` is committed (it carries the
prereg hash).

## Tests

```bash
node --test scripts/orb-*.test.mjs   # 31 unit tests
```

## Decision

Verdict on the **ETF cut only** (SPY/QQQ/IWM/DIA). KEEP-CANDIDATE requires holdout friction-net
R-multiple CI>0 AND per-name-β market-relative (ex-SPY) R-multiple CI>0 AND train sign-
consistency; UNDERPOWERED if holdout < 200 trades or < 100 distinct dates. The large-cap cut is
exploratory only (selected on the dependent variable). Honest prior: UNCERTAIN. Any KEEP must be
re-confirmed on the Alpaca SIP feed (IEX inward-OR-extrema bias flatters ORB).

## Not built (deferred)

- Grid CLI runner + width/CCI/buffer ablation wiring (the `orbGridConfigs` enumerator exists;
  exploratory-only, never gates).
