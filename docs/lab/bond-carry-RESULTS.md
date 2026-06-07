# Bond-Carry / Roll-Down Sleeve — RESULTS

**Pre-registration hash (sha256):** `bfa33356d0bd1086d82c4bc4fba3800a52a5f13286cc3fb18912d63066614719`
**VERDICT: REJECT** — different hat: ρ(co-active) to Turtle-rates 0.513 ≥ 0.3

> Reconstructed PAPER returns, lab-only. Signal = **yield-curve shape** (FMP treasury constant-maturity), NOT ETF price — the orthogonality bet vs Turtle. Sleeve = hold IEF when `y10 + 7.5·(y10−y7) − m3 > 0`, else **cash accrued at `m3` (zero price vol)**. Monthly rebalance, friction-net (round-trip on exit, 1× and 2× stress).

> ⚠️ **Data wall:** FMP caps EOD bars at 5000 rows → ETF execution window is **2006-07 → 2026** (curve reaches 2002). **Holdout 2015–2026 (incl. 2020 COVID + 2022 rate-shock) intact**; train 2006–2014 is diagnostic-only (the primary rule is parameter-free). ⚠️ **Gate 1b is DESCRIPTIVE, not a powered test** — only ~a handful of independent rate-shock regimes exist; its bootstrap would describe a few events, so the dodge is graded as a **dated fact** (cash through 2022?), not a CI. Any KEEP is **provisional pending more regimes**; a REJECT on the full-series orthogonality gate is trustworthy.

**Holdout common weeks (orthogonality, intersected with fleet lanes):** 428; **holdout sleeve weeks (edge gate):** 597. **Distinct duration-hold episodes (full sim 2006-07+):** 5 — the signal rarely goes to cash, so the 2022-dodge question rests on ~1–2 datable events (a case study, not a powered test).

## Gate 1 — Edge (ballast-graded, holdout)

| friction | n weeks | mean weekly | 95% CI | pass (CI>0)? |
|---|--:|--:|:--|:--|
| 1× (net) | 597 | 0.01% | [-0.07%, 0.08%] | no |
| 2× (stress) | 597 | 0.01% | [-0.07%, 0.08%] | no |
> Gate 1a is a floor ("does not lose money net of costs"), not an edge proof — a cash-heavy sleeve earns T-bills by construction. The value-add is the dodge (Gate 1b) + orthogonality (Gate 2).

## Gate 1b — Rate-shock DODGE (descriptive, dated)

Rate-shock weeks = top-decile weekly Δy10 in the holdout (signal-independent). Bootstrap intentionally omitted: the holdout holds only a handful of independent macro rate-regimes, so the dodge is graded as a **dated fact** (was the sleeve in cash through 2022?), not a CI.

| window | shock weeks | sleeve in CASH | sleeve mean | buy-hold IEF mean |
|---|--:|--:|--:|--:|
| all holdout | 59 | 25.42% | -1.21% | -1.66% |
| **2022 only** | 17 | **23.53%** | -1.30% | -1.72% |

**Dodge criterion (cash for the majority of 2022 rate-shock weeks): no** (2022 cash fraction 23.53%).

Per-year shock-week dodge:

- 2015: 7 shock weeks, sleeve in cash 0.00%
- 2016: 4 shock weeks, sleeve in cash 0.00%
- 2017: 3 shock weeks, sleeve in cash 0.00%
- 2018: 4 shock weeks, sleeve in cash 0.00%
- 2019: 3 shock weeks, sleeve in cash 33.33%
- 2020: 2 shock weeks, sleeve in cash 0.00%
- 2021: 2 shock weeks, sleeve in cash 0.00%
- 2022: 17 shock weeks, sleeve in cash 23.53%
- 2023: 6 shock weeks, sleeve in cash 100.00%
- 2024: 7 shock weeks, sleeve in cash 57.14%
- 2025: 2 shock weeks, sleeve in cash 0.00%
- 2026: 2 shock weeks, sleeve in cash 0.00%

## Gate 2 — Orthogonality (holdout, weekly)

| metric | value | bar | pass? |
|---|--:|:--|:--|
| β to QQQ | -0.034 [-0.072, 0.002] | CI brackets 0 or \|β\|<0.2 | YES |
| ρ to QQQ | -0.123 | \|ρ\|<0.3 | YES |
| crisis mean (QQQ worst-quintile) | 0.13% [-0.04%, 0.30%] | CI not entirely <0 | YES |
| ρ_crisis (vs rot band p5/p95) | -0.251 [-0.162, 0.203] | descriptive | — |
| ρ to Coil / Turtle / Drift / DefProxy | -0.180 / 0.023 / -0.103 / 0.107 | each \|ρ\|<0.3 | YES |
| **ρ to Turtle-rates (all weeks)** | 0.513 | context | — |
| **ρ to Turtle-rates (CO-ACTIVE — decisive)** | **0.513** | \|ρ\|<0.3 (the "different hat" check) | no |

## Gate 2b — Steepening-regime cut (descriptive)

Each duration-held episode classified by sign of Δy10 over the hold (bull = y10 fell → genuine ballast; bear = y10 rose → risk-on-correlated).

- Duration-hold episodes ending in/after the 2015 holdout: 3 — bull-steepening 1, bear-steepening 2, unknown 0. (Episode boundaries span the full 2006-07+ sim; the signal rarely flips, so episodes are multi-year.)
  - 2007-04-02 → 2019-08-30: Δy10 -3.15pp → bull_steepening
  - 2019-10-01 → 2022-08-31: Δy10 1.50pp → bear_steepening
  - 2024-10-01 → 2026-06-05: Δy10 0.81pp → bear_steepening
> Bear-steepening holds (sleeve LONG duration while y10 ROSE) are the risk-on bond exposure this cut exists to expose — here the dominant holds are bear-steepening, including the one spanning the 2022 selloff, so the sleeve carries the bad kind of rate exposure, not clean ballast.

## Robustness twin (term-spread, no ModDur) + threshold-binding diagnostic

- Twin verdict-level agreement: **agree** (primary keep=false, twin keep=false).
- Twin gate2 pass no | twin edge no | twin ρ(co-active) Turtle-rates 0.376 | twin 2022 cash 5.88%.
- Threshold-binding: a +25bp buffer flips the sign-only decision in 2.43% of months (near 0 ⇒ verdict rests on the signal's sign, not a tuned threshold).
- Threshold-binding: a +50bp buffer flips the sign-only decision in 4.51% of months (near 0 ⇒ verdict rests on the signal's sign, not a tuned threshold).

