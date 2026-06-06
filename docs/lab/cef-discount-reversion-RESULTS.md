# CEF Discount-Reversion — RESULTS

**Pre-registration hash (sha256):** `2f0ccb50b36d9a832fb60fa046dcab9c09bd04dc2a8c1b810f07e272abf352f5`
**VERDICT: REJECT** — edge gate FAIL (holdout net CI lower bound ≤ 0); equity-β too high (β=0.369); co-crashes (crisis-mean CI entirely < 0); redundant (|ρ| ≥ 0.3 to a lane)

> Reconstructed PAPER returns. **Return basis = price-change** (NAV-move + Δdiscount), friction-NET; **excludes distribution yield (conservative; yield unavailable from CEFConnect)**. Edge gate = holdout weekly sleeve, 8-week block bootstrap, 1× and 2× friction. Orthogonality reuses the S1 `fleet-correlate` engine.

> ⚠️ **Survivorship bias (upward / toward false-KEEP):** the universe is a 2026 current-snapshot; CEFs that liquidated/merged by 2026 — disproportionately distressed wide-discount names that did NOT recover — are invisible. ⚠️ **Regime caveat:** the train/holdout midpoint straddles the 2022–23 rate-regime break; the train half is reported alongside.

**Universe:** 46 CEFs with > 60 weekly bars. **Sleeve weeks:** 246 (split @ 2023-W49). **Trades:** 78. **Independent widening episodes (≥3 simultaneous entries):** 3.

## Edge gate (holdout)

| friction | n weeks | mean weekly | 95% CI | pass? |
|---|--:|--:|:--|:--|
| 1× (net) | 123 | 0.05% | [-0.10%, 0.20%] | no |
| 2× (stress) | 123 | -0.01% | [-0.18%, 0.13%] | no |
| train half (ref) | 123 | -0.03% | — | — |

## Orthogonality gate (vs QQQ + fleet lanes, weekly)

| metric | value | bar | pass? |
|---|--:|:--|:--|
| β to QQQ | 0.369 [0.286, 0.459] | CI brackets 0 or \|β\|<0.2 | no |
| ρ to QQQ | 0.637 | — | — |
| crisis mean (QQQ worst-quintile) | -1.79% [-2.28%, -1.32%] | CI not entirely <0 | no |
| ρ_crisis (vs rot band p5/p95) | 0.355 [-0.292, 0.312] | descriptive | — |
| ρ to Coil / Turtle / Drift | 0.296 / 0.115 / 0.366 | each \|ρ\|<0.3 | no |

## Return decomposition (per-trade means) + regime-chase

- Mean per-trade: **net 1.03%** = NAV-move 0.90% + Δdiscount 1.34% − friction. (If the edge is mostly NAV-move, it's underlying drift, not reversion.)
- Entries 2022: n=18, mean net -1.03%  ← rate-regime re-rating window (mean-reversion-into-a-break risk)
- Entries 2023: n=24, mean net 2.21%  ← rate-regime re-rating window (mean-reversion-into-a-break risk)
- Entries 2024: n=13, mean net 0.73%
- Entries 2025: n=22, mean net 1.27%
- Entries 2026: n=1, mean net 8.52%

