# Coil Front-Run Diagnostic — Results

> **EXPLORATORY.** This sample's holdout was already spent on the RSI-threshold study
> (`08a17a3`). These results set a prior. They are **not** a confirmatory test and
> must not drive a live Coil change. The confirmatory test is the forward monitor
> (`coil-frontrun-monitor.mjs`), whose rule is frozen in prereg hash
> `9d30c81c` with benchmark conversion rate 35.3%.

## C1 — conversion rate by year

`conversion = FIRE / (FIRE + BOUNCE)`. A **declining** rate is the front-run signature.

| year | n resolved | fire | bounce | rate | 95% CI |
|---|---|---|---|---|---|
| 2021 | 582 | 191 | 391 | 32.8% | [24.4%, 40.1%] |
| 2022 | 440 | 173 | 267 | 39.3% | [29.2%, 50.0%] |
| 2023 | 747 | 260 | 487 | 34.8% | [28.8%, 40.2%] |
| 2024 | 923 | 331 | 592 | 35.9% | [29.6%, 42.3%] |
| 2025 | 639 | 218 | 421 | 34.1% | [29.3%, 38.9%] |
| 2026 | 304 | 111 | 193 | 36.5% | [32.3%, 41.5%] |

## C1 — conversion rate by SPY volatility tercile

Low-vol regimes produce fewer deep-oversold events regardless of crowding. A decline that
appears **only** in one tercile is a volatility artifact, not front-running.

| tercile | n resolved | fire | bounce | rate | 95% CI |
|---|---|---|---|---|---|
| low | 1236 | 482 | 754 | 39.0% | [34.2%, 43.8%] |
| mid | 1229 | 418 | 811 | 34.0% | [29.5%, 39.0%] |
| high | 1170 | 384 | 786 | 32.8% | [28.8%, 37.4%] |

## C2 / C3 — shallow and deep friction-net edge by year

**Underpowered by construction** (per-trade σ ≈ 4–5%; MDE ≈ 1.6–2.0%/trade). Read the
*directions*, never the point estimates. Story discrimination:

- shallow ↑, deep flat → operator's story (crowd front-runs; entering earlier would pay)
- shallow flat, deep ↓ → adverse selection (only toxic dips reach RSI<5; do **not** enter earlier)
- both flat → mechanism-only (front-running real, edge already competed away; change nothing)

| year | deep n | deep net | shallow n | shallow net | gap (shallow−deep) | 95% CI |
|---|---|---|---|---|---|---|
| 2021 | 69 | 0.62% | 572 | 0.38% | -0.24% | [-1.05%, 0.54%] |
| 2022 | 64 | -0.87% | 454 | -0.49% | 0.38% | [-0.92%, 1.05%] |
| 2023 | 80 | 0.20% | 703 | 0.10% | -0.10% | [-0.56%, 0.31%] |
| 2024 | 121 | 0.99% | 896 | 0.12% | -0.86% | [-1.62%, -0.12%] |
| 2025 | 89 | -0.12% | 645 | -0.12% | -0.00% | [-0.66%, 0.78%] |
| 2026 | 45 | 0.44% | 260 | 0.28% | -0.17% | [-1.17%, 0.95%] |

## Limitations

- Exploratory: this sample's holdout is spent. No verdict is drawn here.
- Survivorship: today's 80-name universe only.
- Conversion uses **no earnings filter** (price-dynamics question); the return metrics do
  (they mirror Coil's tradeable set). The two populations therefore differ.
- Conversion measures **signal** conversion, not Coil fills — the ≤4-position cap means a
  converted signal need not become a Coil trade.
- Yearly deep-bucket n is ~80. Those CIs are wide. Do not over-read a single cell.