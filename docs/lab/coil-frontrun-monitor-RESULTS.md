# Coil Front-Run Monitor — Results

**Verdict: UNDERPOWERED** — n=0 < 200

Pre-registered rule, hash `9d30c81c`. Forward window opens `2026-07-10`.
Benchmark (historical) conversion rate: **35.3%**. Expected outcome: NOT_SUPPORTED.

## Forward window

- resolved forward episodes: **0** (gate: n ≥ 200)
- forward conversion rate: **n/a**
- pooled diff (forward − historical): n/a, 95% CI [n/a, n/a]
- realized MDE at this n: n/a

## Vol-tercile decomposition (gate 3: ≥2 of 3 with hi < 0)

| tercile | diff | 95% CI | passes |
|---|---|---|---|
| low | n/a | [n/a, n/a] | no |
| mid | n/a | [n/a, n/a] | no |
| high | n/a | [n/a, n/a] | no |

## Secondary — forward vs trailing-12-month history (never decision-gating)

- trailing-12-month historical conversion rate: **35.5%**
- pooled benchmark conversion rate: **35.3%**
- diff (forward − trailing-12m): n/a, 95% CI [n/a, n/a]

If the pooled benchmark sits well **above** the trailing-12-month rate, the primary test can be
satisfied by trend continuation alone. Compare the two before believing a SUPPORTED verdict.

## How to read this

- A SUPPORTED verdict licenses **one** thing: proposing a separate, pre-registered threshold
  study with a fresh holdout. It does **not** license changing Coil.
- **It does not mean "enter earlier."** Adverse selection predicts the same conversion decline
  while the deep-band edge decays. Read C2/C3 in the diagnostic to tell the stories apart.
- **Trend continuation is the live risk.** If the historical yearly series was already
  declining, "forward < pooled historical" can be satisfied by a pre-existing trend that has
  nothing to do with AI adoption. Check the yearly series in
  `docs/lab/coil-frontrun-diag-RESULTS.md` against the secondary comparison above.