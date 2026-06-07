# Bond-Carry / Roll-Down Sleeve — RUNBOOK

Lab-only, paper, no deploy, no agent reads it. `data/lab/*` is gitignored; only this RUNBOOK, the RESULTS, the scripts, the spec, and the plan are committed.

## Reproduce
1. `export FMP_API_KEY=$(grep -E '^FMP_API_KEY=' /path/to/project-root/.env | cut -d= -f2-)`
2. `node scripts/carry-fetch.mjs`            # treasury curve + IEF/TLT/TIP/QQQ/SPY → data/lab/carry-cache
3. `node scripts/fleet-fetch-bars.mjs && node scripts/fleet-fetch-earnings.mjs`  # S1 lanes (Coil/Turtle/Drift/DefProxy)
4. `node --test scripts/carry-*.test.mjs`    # unit tests
5. `node scripts/carry-score.mjs --root .`   # prereg → sim → gates → docs/lab/bond-carry-RESULTS.md

## Task-0 data-wall findings (2026-06-06)
Probe run **before** any scoring (it is a data-availability check, not a result). Pre-registration hash `bfa33356d0bd1086d82c4bc4fba3800a52a5f13286cc3fb18912d63066614719` was locked before this.

- **Treasury curve** (`stable/treasury-rates`): 5988 rows, **earliest 2002-07-01**, latest 2026-06-05; fields `month1,month2,month3,month6,year1,year2,year3,year5,year7,year10,year20,year30`. **`year7` IS present** → no `y7` interpolation needed; `month3` (cash) present; values in percent. Full range returned in one call.
- **ETF EOD bars** (`stable/historical-price-eod/full`): **capped at 5000 rows by FMP**, so IEF/TLT/TIP/QQQ/SPY bars start **2006-07-21** (not 2002). This is the binding window constraint.
- **Action taken:** accept the **2006-07 → 2026 execution window** (no `y7` interpolation, no signal change). Per spec §3, the **holdout (2015–2026) is unchanged and still contains the thesis-defining regimes (2018Q4, 2020 COVID, 2022 rate-shock, 2025 tariff)**; the **train window shrinks to 2006–2014** (still includes the 2008 GFC growth-scare + 2013 taper), and train is **diagnostic-only** (the primary rule is parameter-free), so no gate is affected. The lost 2002–2006 stretch carries no stock-bond co-crash regime. Reduced-train-depth is flagged in RESULTS. The prereg `window.fetch_from='2002-07'` records the *request*; the realized ETF-execution start (2006-07) is this finding.

## Notes
- Curve `m3` = cash accrual rate; signal = `y10 + 7.5*(y10-y7) - m3` (percent), sign-zero primary.
- Turtle-rates-only comparator = `simulateTurtle({TLT,IEF,TIP})` (its cluster cap → one rates position).
- **VERDICT: REJECT** (prereg `bfa33356…`). Decisive "different hat" gate failed: ρ(co-active) to the Turtle-rates sleeve = **0.513** (≥0.3) — the curve-aware carry sleeve is Turtle's rates-trend in a different hat. Doubly confirmed: it did **not** dodge 2022 (23.5% cash; long duration through the bear-steepening — the monthly carry signal stayed positive through the whole 2015→2022 run-up, only going to cash after the 2023 inversion). Genuinely low-β to QQQ (−0.03), doesn't co-crash equities, orthogonal to the other lanes — but duplicates Turtle + carries bond-bear risk, so it doesn't fill the equity-selloff gap as an orthogonal sleeve. Twin (term-spread) agrees; threshold doesn't bind (param-free sign rule honest). **The equity-selloff ballast gap remains OPEN.**
