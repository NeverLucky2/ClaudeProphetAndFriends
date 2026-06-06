# Fleet Correlation Diagnostic — RESULTS

**Pre-registration hash (sha256):** `8116f9eb33319bc78a8e351a4ea93f65f1b03123e85b4d43125edca3dc3d7394`
**Reconstructed PAPER returns** — co-movement is the signal, absolute levels are not. β levels are **gross, not net-economic** (high-turnover Coil overstates net β most). Benchmark = QQQ (the tech-book proxy).

> **Crisis cut is a descriptive lens.** Crisis-conditional **mean return** (bootstrap CI) is the primary ballast read; ρ_crisis / downside β are shown beside a rotation **context band** (p5/p50/p95 of the same stat under no real dependence — how much the crisis selection manufactures), never a binary verdict. Cells with < 8 nonzero crisis weeks are flagged **insufficient_power**. **def-Prophet** is a structural-light **proxy** (QQQ<200DMA → BSM put-spread); it is excluded from the full-sample β table and appears only in the crisis table — no timing-coverage claim.

## Window: 4-way headline — 2022-01-01 → 2026-06-06 (231 weeks)

### Full-sample β to QQQ + classification

| Lane | n | β (gross) | β 95% CI | ρ | ρ 95% CI | Spearman | class | basis |
|---|--:|--:|:--|--:|:--|--:|:--|:--|
| Coil | 231 | 0.037 | [0.023, 0.049] | 0.373 | [0.250, 0.485] | 0.322 | **genuine_ballast** | full |
| Turtle | 231 | 0.002 | [-0.011, 0.014] | 0.016 | [-0.096, 0.144] | 0.061 | **genuine_ballast** | full |
| Drift | 231 | 0.022 | [0.014, 0.034] | 0.344 | [0.252, 0.464] | 0.334 | **genuine_ballast** | full |

### Crisis-conditional (QQQ worst-quintile weeks)

| Lane | crisis effN | mean ret | mean 95% CI | ρ_crisis | rot band [p5,p95] | downside β | tail note |
|---|--:|--:|:--|--:|:--|--:|:--|
| Coil | 45 | -0.19% | [-0.28%, -0.10%] | 0.245 | [-0.193, 0.225] | 0.056 | co_crashes_with_tail_comove |
| Turtle | 45 | -0.02% | [-0.11%, 0.10%] | 0.190 | [-0.217, 0.267] | 0.048 | tail_neutral |
| Drift | 25 | -0.06% | [-0.11%, -0.01%] | -0.028 | [-0.242, 0.258] | -0.003 | co_crashes |
| DefProxy | 28 | 0.77% | [0.36%, 1.40%] | -0.617 | [-0.253, 0.235] | -0.804 | cushions |

### Edge-lane pairwise weekly correlation (Coil / Turtle / Drift)

| Pair | Pearson | Spearman | n |
|---|--:|--:|--:|
| Coil × Turtle | 0.113 | 0.102 | 231 |
| Coil × Drift | 0.201 | 0.220 | 231 |
| Turtle × Drift | 0.055 | 0.142 | 231 |

### Synthesis

- **Coil** — full-sample β 0.04 (95% CI [0.02, 0.05]) → **genuine_ballast**; in QQQ's worst weeks: co_crashes_with_tail_comove (mean -0.19%, effN 45).
- **Turtle** — full-sample β 0.00 (95% CI [-0.01, 0.01]) → **genuine_ballast**; in QQQ's worst weeks: tail_neutral (mean -0.02%, effN 45).
- **Drift** — full-sample β 0.02 (95% CI [0.01, 0.03]) → **genuine_ballast**; in QQQ's worst weeks: co_crashes (mean -0.06%, effN 25).
- **DefProxy (structural proxy)** — crisis mean 0.77%, cushions; designed long-vol hedge, proxy trigger, no full-sample claim.
- **Ballast gap:** 0/3 edge lanes carry overt long-QQQ-β; in crisis weeks 2 co-crash vs 0 cushion. Equity-selloff protection is thin → Subproject 2 should target a non-equity / idiosyncratic premium.

## Window: 3-way crisis extension — 2016-01-01 → 2026-06-06 (544 weeks)

### Full-sample β to QQQ + classification

| Lane | n | β (gross) | β 95% CI | ρ | ρ 95% CI | Spearman | class | basis |
|---|--:|--:|:--|--:|:--|--:|:--|:--|
| Coil | 544 | 0.049 | [0.037, 0.062] | 0.451 | [0.356, 0.539] | 0.373 | **genuine_ballast** | full |
| Turtle | 544 | 0.011 | [0.002, 0.021] | 0.113 | [0.017, 0.221] | 0.120 | **genuine_ballast** | full |

### Crisis-conditional (QQQ worst-quintile weeks)

| Lane | crisis effN | mean ret | mean 95% CI | ρ_crisis | rot band [p5,p95] | downside β | tail note |
|---|--:|--:|:--|--:|:--|--:|:--|
| Coil | 103 | -0.21% | [-0.28%, -0.13%] | 0.499 | [-0.150, 0.161] | 0.107 | co_crashes_with_tail_comove |
| Turtle | 107 | -0.05% | [-0.11%, 0.01%] | 0.128 | [-0.156, 0.165] | 0.023 | tail_neutral |
| DefProxy | 44 | 0.49% | [0.24%, 0.81%] | -0.449 | [-0.163, 0.141] | -0.366 | cushions |

### Edge-lane pairwise weekly correlation (Coil / Turtle / Drift)

| Pair | Pearson | Spearman | n |
|---|--:|--:|--:|
| Coil × Turtle | 0.163 | 0.120 | 544 |

### Synthesis

- **Coil** — full-sample β 0.05 (95% CI [0.04, 0.06]) → **genuine_ballast**; in QQQ's worst weeks: co_crashes_with_tail_comove (mean -0.21%, effN 103).
- **Turtle** — full-sample β 0.01 (95% CI [0.00, 0.02]) → **genuine_ballast**; in QQQ's worst weeks: tail_neutral (mean -0.05%, effN 107).
- **DefProxy (structural proxy)** — crisis mean 0.49%, cushions; designed long-vol hedge, proxy trigger, no full-sample claim.
- **Ballast gap:** 0/2 edge lanes carry overt long-QQQ-β; in crisis weeks 1 co-crash vs 0 cushion. Equity-selloff protection is thin → Subproject 2 should target a non-equity / idiosyncratic premium.

