# Reduced-EOV Backtest — Results

**Verdict: INFEASIBLE (blocked on options-data access) — not REJECT.**

The reduced-EOV signal was never scored: the historical option-volume panel it requires
cannot be reconstructed on this account's market-data entitlement. The analytical engine is
complete and unit-tested (19/19); it is blocked solely on data, and would run as-is the moment
OPRA-grade historical option bars are available. Spec:
`docs/superpowers/specs/2026-06-19-reduced-eov-backtest-design.md`.

## The data wall (definitive)

The signal needs, per name per past day, `CallVol = Σ daily-bar volume over every call
contract trading that day` (spec §2). On Alpaca's free options feed:

- **Currently-active (unexpired) contracts** return full daily-bar history back to listing.
  Evidence: active 2027 LEAP `AAPL270115C00005000` → bars `2024-09-30 .. 2026-06-18`.
- **Expired (inactive) contracts** return **zero bars** (or HTTP 403 `"OPRA agreement is not
  signed"`). Evidence: every `AAPL2401…`-expiry contract → 0 bars; the full 20-name daily-bar
  pull (start 2024-01-01) → 403 on all names.

Historical daily CallVol is dominated by **short-dated calls that have since expired** — the
exact contracts that return nothing. The only-retrievable slice (contracts still alive today)
is survivorship-biased toward illiquid, long-dated LEAPs (the $5 2027 LEAP had 129 bars in
~1.7 yr), the opposite of the short-dated retail-call demand the paper describes. Reconstructed
CallVol from that slice would be meaningless, so the study was stopped rather than run on
biased inputs.

Full historical option bars require the **paid OPRA subscription**, which the standing
"don't buy options data" constraint rules out (see memory `coil-options-overlay-project`,
`barclays-retail-options-paper-evaluated`). This is the binding risk recorded in spec §7.1/§7.3.

## What was verified along the way

- Contract **enumeration** works (active + inactive), once `active` is queried with an
  `expiration_date_gte` bound — without it Alpaca returns 0 active rows. ~270k call contracts
  across the 20 names.
- The free bars feed **is** consolidated/OPRA-scale for the recent window it serves (a 300-
  contract AAPL sample showed 24k–179k contracts/day) — so the limitation is historical
  *depth/entitlement*, not feed quality.

## Honest note on the feasibility miss

The pre-build feasibility spike confirmed expired contracts are *enumerable* (`status=inactive`)
and that option bars *exist* — but it tested an **active** contract and never verified bar
**retrieval for an expired** contract. That single untested step is the entire gap: enumerable
≠ retrievable. A future options-data feasibility check must pull bars for a **long-expired**
contract before any build.

## Status of the machinery (reusable)

Complete, reviewed, and unit-tested (19/19): universe, signal math (trailing-mean / reducedEOV
/ split exclusion / cross-sectional rank), portfolio construction (open-to-open returns,
top-k/bottom-k spread), CallVol aggregation + integrity, panel build (warm-up, split exclusion,
train/holdout split), hash-locked pre-registration, and the train→holdout beta-neutral dual-gate
scorer. To run later with OPRA-grade data: backfill `data/lab/eov-volume-cache/` from a feed
that serves expired-contract bars, then `eov-build → eov-prereg → eov-score` per the RUNBOOK.

## Pre-registered design (unchanged; for the future run)

Confirmatory cell: long-short top-5 − bottom-5, h=3, beta-neutralized; direction fixed on
train, confirmed one-sided on holdout; Gate A (beta-neutral spread CI), Gate B (deployable
long-leg beta-adjusted alpha CI); UNDERPOWERED < 100 holdout dates or < 200 name-trades. Half-
signal proxy (no OI). Honest prior: REJECT. Lab-only; a KEEP would authorize only forward
paper-collection, never deployment.
