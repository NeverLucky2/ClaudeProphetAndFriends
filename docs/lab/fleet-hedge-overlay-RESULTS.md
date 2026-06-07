# Fleet Hedge-Overlay — RESULTS

**Pre-registration hash (sha256):** `becb8eb8c5b7fbe75c6b073fffd62e7c6be31428c4db021ac6cdb2c0f8399f86`
**Lab-only, reconstructed returns.** Cost = **calm-period (non-crisis) drag**; benefit = crash-conditional **cushion** (paired-difference bootstrap CI) split lumped / rate-shock / growth-scare. Convex candidates (def-Prophet, VIXM) carry a stress grid + the §7 convexity guard. Recommendation read against the **conservative book-funded** drag bound.

## Task 0 — Data-wall provenance

- VIXM earliest: `2014-01-02` (covers 2016 window: yes)
- Treasury curve earliest: `2014-01-02` (covers window: yes)

| Year | dropped book weight |
|---|--:|
| 2016 | 1.89% |
| 2017 | 1.89% |
| 2018 | 1.89% |
| 2019 | 1.89% |
| 2020 | 0.94% |
| 2021 | 0.00% |
| 2022 | 0.00% |
| 2023 | 0.00% |
| 2024 | 0.00% |
| 2025 | 0.00% |
| 2026 | 0.00% |

## Target: Reconstructed Merrill book

| Candidate | size | calm drag/yr | cushion lumped | rate-shock | growth-scare | efficiency | regime |
|---|--:|--:|:--|:--|:--|--:|:--|
| def-Prophet proxy | 0.5% prem | 2.65% | 0.25% [0.12%,0.40%] (episodes 77) | 0.22% [0.08%,0.37%] (episodes 17) | 0.25% [0.11%,0.44%] (episodes 71) | 0.09 | robust |
| def-Prophet proxy | 1.0% prem | 5.32% | 0.49% [0.24%,0.81%] (episodes 77) | 0.43% [0.16%,0.74%] (episodes 17) | 0.50% [0.22%,0.89%] (episodes 71) | 0.09 | robust |
| def-Prophet proxy | 2.0% prem | 10.68% | 0.99% [0.48%,1.62%] (episodes 77) | 0.86% [0.32%,1.47%] (episodes 17) | 1.01% [0.44%,1.79%] (episodes 71) | 0.09 | robust |
| Static GLD | 2.5% | -0.39% | -0.00% [-0.01%,0.01%] (episodes 77) | -0.01% [-0.05%,0.01%] (episodes 17) | 0.00% [-0.01%,0.01%] (episodes 71) | -0.00 | ineffective |
| Static GLD | 5.0% | -0.79% | -0.00% [-0.03%,0.02%] (episodes 77) | -0.03% [-0.09%,0.03%] (episodes 17) | 0.00% [-0.03%,0.03%] (episodes 71) | -0.00 | ineffective |
| Static GLD | 10.0% | -1.57% | -0.01% [-0.05%,0.04%] (episodes 77) | -0.05% [-0.19%,0.06%] (episodes 17) | 0.00% [-0.05%,0.05%] (episodes 71) | -0.00 | ineffective |
| Static GLD | 15.0% | -2.36% | -0.01% [-0.08%,0.06%] (episodes 77) | -0.08% [-0.28%,0.09%] (episodes 17) | 0.00% [-0.08%,0.08%] (episodes 71) | -0.00 | ineffective |
| Static GLD | 20.0% | -3.14% | -0.01% [-0.10%,0.08%] (episodes 77) | -0.11% [-0.37%,0.12%] (episodes 17) | 0.01% [-0.10%,0.11%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 2.5% | 0.06% | -0.01% [-0.02%,0.00%] (episodes 77) | -0.09% [-0.10%,-0.07%] (episodes 17) | 0.01% [-0.00%,0.02%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 5.0% | 0.12% | -0.01% [-0.04%,0.01%] (episodes 77) | -0.17% [-0.21%,-0.14%] (episodes 17) | 0.02% [-0.00%,0.04%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 10.0% | 0.23% | -0.03% [-0.07%,0.02%] (episodes 77) | -0.35% [-0.42%,-0.29%] (episodes 17) | 0.04% [-0.00%,0.08%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 15.0% | 0.35% | -0.04% [-0.11%,0.02%] (episodes 77) | -0.52% [-0.63%,-0.43%] (episodes 17) | 0.06% [-0.00%,0.11%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 20.0% | 0.46% | -0.05% [-0.14%,0.03%] (episodes 77) | -0.69% [-0.83%,-0.57%] (episodes 17) | 0.07% [-0.00%,0.15%] (episodes 71) | -0.00 | ineffective |
| Static VIXM | 2.5% | 1.55% | 0.10% [0.07%,0.12%] (episodes 77) | 0.07% [0.02%,0.13%] (episodes 17) | 0.10% [0.08%,0.13%] (episodes 71) | 0.03 | robust |
| Static VIXM | 5.0% | 3.10% | 0.19% [0.15%,0.24%] (episodes 77) | 0.14% [0.04%,0.26%] (episodes 17) | 0.20% [0.15%,0.26%] (episodes 71) | 0.03 | robust |
| Static VIXM | 10.0% | 6.20% | 0.39% [0.30%,0.48%] (episodes 77) | 0.28% [0.09%,0.51%] (episodes 17) | 0.41% [0.31%,0.52%] (episodes 71) | 0.03 | robust |
| Static VIXM | 15.0% | 9.29% | 0.58% [0.44%,0.72%] (episodes 77) | 0.42% [0.13%,0.77%] (episodes 17) | 0.61% [0.46%,0.79%] (episodes 71) | 0.03 | robust |
| Static VIXM | 20.0% | 12.39% | 0.77% [0.59%,0.96%] (episodes 77) | 0.55% [0.18%,1.03%] (episodes 17) | 0.81% [0.62%,1.05%] (episodes 71) | 0.03 | robust |

### Stress-shock payoff (convex candidates, sample-independent)

| Candidate | −10% | −20% | −30% |
|---|--:|--:|--:|
| def-Prophet proxy | 5.000 | 10.000 | 10.000 |
| Static VIXM | 0.003 | 0.005 | 0.008 |

### Recommendation

**Branch b** — def-Prophet is the most cost-efficient regime-robust hedge — activate it as the primary hedge. No cheap static sleeve qualifies as robust: the only other regime-robust candidate is the convex long-vol sleeve (VIXM), which is far costlier per unit cushion. See the per-candidate table for which static sleeves are ineffective vs which actively hurt a regime cut.

## Target: QQQ

| Candidate | size | calm drag/yr | cushion lumped | rate-shock | growth-scare | efficiency | regime |
|---|--:|--:|:--|:--|:--|--:|:--|
| def-Prophet proxy | 0.5% prem | 2.65% | 0.25% [0.12%,0.40%] (episodes 77) | 0.22% [0.08%,0.37%] (episodes 17) | 0.25% [0.11%,0.44%] (episodes 71) | 0.09 | robust |
| def-Prophet proxy | 1.0% prem | 5.32% | 0.49% [0.24%,0.81%] (episodes 77) | 0.43% [0.16%,0.74%] (episodes 17) | 0.50% [0.22%,0.89%] (episodes 71) | 0.09 | robust |
| def-Prophet proxy | 2.0% prem | 10.68% | 0.99% [0.48%,1.62%] (episodes 77) | 0.86% [0.32%,1.47%] (episodes 17) | 1.01% [0.44%,1.79%] (episodes 71) | 0.09 | robust |
| Static GLD | 2.5% | -0.39% | -0.00% [-0.01%,0.01%] (episodes 77) | -0.01% [-0.05%,0.01%] (episodes 17) | 0.00% [-0.01%,0.01%] (episodes 71) | -0.00 | ineffective |
| Static GLD | 5.0% | -0.79% | -0.00% [-0.03%,0.02%] (episodes 77) | -0.03% [-0.09%,0.03%] (episodes 17) | 0.00% [-0.03%,0.03%] (episodes 71) | -0.00 | ineffective |
| Static GLD | 10.0% | -1.57% | -0.01% [-0.05%,0.04%] (episodes 77) | -0.05% [-0.19%,0.06%] (episodes 17) | 0.00% [-0.05%,0.05%] (episodes 71) | -0.00 | ineffective |
| Static GLD | 15.0% | -2.36% | -0.01% [-0.08%,0.06%] (episodes 77) | -0.08% [-0.28%,0.09%] (episodes 17) | 0.00% [-0.08%,0.08%] (episodes 71) | -0.00 | ineffective |
| Static GLD | 20.0% | -3.14% | -0.01% [-0.10%,0.08%] (episodes 77) | -0.11% [-0.37%,0.12%] (episodes 17) | 0.01% [-0.10%,0.11%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 2.5% | 0.06% | -0.01% [-0.02%,0.00%] (episodes 77) | -0.09% [-0.10%,-0.07%] (episodes 17) | 0.01% [-0.00%,0.02%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 5.0% | 0.12% | -0.01% [-0.04%,0.01%] (episodes 77) | -0.17% [-0.21%,-0.14%] (episodes 17) | 0.02% [-0.00%,0.04%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 10.0% | 0.23% | -0.03% [-0.07%,0.02%] (episodes 77) | -0.35% [-0.42%,-0.29%] (episodes 17) | 0.04% [-0.00%,0.08%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 15.0% | 0.35% | -0.04% [-0.11%,0.02%] (episodes 77) | -0.52% [-0.63%,-0.43%] (episodes 17) | 0.06% [-0.00%,0.11%] (episodes 71) | -0.00 | ineffective |
| Static TLT | 20.0% | 0.46% | -0.05% [-0.14%,0.03%] (episodes 77) | -0.69% [-0.83%,-0.57%] (episodes 17) | 0.07% [-0.00%,0.15%] (episodes 71) | -0.00 | ineffective |
| Static VIXM | 2.5% | 1.55% | 0.10% [0.07%,0.12%] (episodes 77) | 0.07% [0.02%,0.13%] (episodes 17) | 0.10% [0.08%,0.13%] (episodes 71) | 0.03 | robust |
| Static VIXM | 5.0% | 3.10% | 0.19% [0.15%,0.24%] (episodes 77) | 0.14% [0.04%,0.26%] (episodes 17) | 0.20% [0.15%,0.26%] (episodes 71) | 0.03 | robust |
| Static VIXM | 10.0% | 6.20% | 0.39% [0.30%,0.48%] (episodes 77) | 0.28% [0.09%,0.51%] (episodes 17) | 0.41% [0.31%,0.52%] (episodes 71) | 0.03 | robust |
| Static VIXM | 15.0% | 9.29% | 0.58% [0.44%,0.72%] (episodes 77) | 0.42% [0.13%,0.77%] (episodes 17) | 0.61% [0.46%,0.79%] (episodes 71) | 0.03 | robust |
| Static VIXM | 20.0% | 12.39% | 0.77% [0.59%,0.96%] (episodes 77) | 0.55% [0.18%,1.03%] (episodes 17) | 0.81% [0.62%,1.05%] (episodes 71) | 0.03 | robust |

### Stress-shock payoff (convex candidates, sample-independent)

| Candidate | −10% | −20% | −30% |
|---|--:|--:|--:|
| def-Prophet proxy | 5.000 | 10.000 | 10.000 |
| Static VIXM | 0.003 | 0.005 | 0.008 |

### Recommendation

**Branch b** — def-Prophet is the most cost-efficient regime-robust hedge — activate it as the primary hedge. No cheap static sleeve qualifies as robust: the only other regime-robust candidate is the convex long-vol sleeve (VIXM), which is far costlier per unit cushion. See the per-candidate table for which static sleeves are ineffective vs which actively hurt a regime cut.

