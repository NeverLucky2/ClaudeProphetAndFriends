# Reduced-EOV Study — Runbook

Lab-only pre-registered backtest of reduced-EOV (call-volume intensity) forward power on 20
heavily-optioned mega-caps. Read-only; no deployment. Spec:
`docs/superpowers/specs/2026-06-19-reduced-eov-backtest-design.md`. Plan:
`docs/superpowers/plans/2026-06-19-reduced-eov-backtest.md`.

## ⛔ DATA WALL — read before running (status: INFEASIBLE on free Alpaca options data)

The study is currently **blocked on data**, not on code (see `eov-RESULTS.md`). Alpaca's free
options feed serves daily bars **only for currently-active contracts**; **expired/inactive
contracts return zero bars / HTTP 403 `"OPRA agreement is not signed"`**. Historical CallVol is
dominated by since-expired short-dated calls, so it cannot be reconstructed. Re-running the
pipeline below will reproduce the INFEASIBLE result until a feed that serves **expired-contract
historical bars (paid OPRA)** is available.

**Before attempting again:** verify bar *retrieval* (not just enumeration) for a **long-expired**
contract, e.g.:
```bash
# expect non-empty bars for a 2024-expiry contract; today this returns [] on the free feed
curl -s -H "APCA-API-KEY-ID: $K" -H "APCA-API-SECRET-KEY: $S" \
  "https://data.alpaca.markets/v1beta1/options/bars?symbols=AAPL240105C00050000&timeframe=1Day&start=2024-01-01&end=2024-02-01"
```

## Prereq
Alpaca creds (`ALPACA_PUBLIC_KEY` / `ALPACA_SECRET_KEY`) in `.env` in the run directory
(copy project-root `.env` into the worktree; `.env` is git-ignored). Remove it when done.

## Pipeline (order matters)
```bash
node scripts/eov-fetch-contracts.mjs   # 1. enumerate call contracts (active w/ exp-bound + inactive) -> data/lab/eov-contracts/
node scripts/eov-fetch-bars.mjs        # 2. option daily bars -> per-name CallVol -> data/lab/eov-volume-cache/  [BLOCKED: 403 on expired contracts]
node scripts/eov-fetch-stockbars.mjs   # 3. adjusted daily stock bars (20+QQQ+SPY) -> data/lab/eov-stockbars/
node scripts/eov-fetch-corpactions.mjs # 4. splits -> data/lab/eov-splits.json
node scripts/eov-build.mjs             # 5. EOV panel + forward returns -> data/lab/eov-instances.json
node scripts/eov-prereg.mjs            # 6. write + hash-lock data/lab/eov-prereg.json (MUST precede scoring)
node scripts/eov-score.mjs             # 7. score frozen holdout -> docs/lab/eov-RESULTS.md (+ VERDICT)
```
`eov-score.mjs` refuses (exit 4) on a prereg hash mismatch. `data/lab/*` is git-ignored;
only `docs/lab/eov-RESULTS.md` (carries the prereg hash) is committed.

Note on step 1: Alpaca returns 0 `active` contracts unless `expiration_date_gte` is set; the
fetcher passes `TODAY` for active and the window start for inactive (see comment in the script).

## Tests
```bash
node --test scripts/eov-*.test.mjs   # 19 unit tests, pure analytical core
```

## Decision
Confirmatory cell: long-short top5−bottom5, h=3, beta-neutral, direction fixed on train.
KEEP-CANDIDATE requires train signal (oriented CI lo>0) AND Gate A (holdout oriented
spread_resid CI lo>0) AND Gate B (held-leg per-name beta-adjusted alpha CI lo>0); UNDERPOWERED
if holdout < 100 dates or held leg < 200 name-trades. Half-signal proxy (no OI). Honest prior:
REJECT. A KEEP authorizes only forward paper-collection — never deployment.
