# Fleet Correlation Diagnostic — RUNBOOK

Reconstructs each fleet lane's return stream by backtesting its strategy logic, then measures
co-movement to QQQ (the tech-book proxy) and to each other, full-sample + crisis-conditional.
Lab-only, read-only, no runtime/deploy impact. Spec: `docs/superpowers/specs/2026-06-06-fleet-correlation-diagnostic-design.md`.

## Re-run

```bash
# from the repo root, with FMP_API_KEY in the environment (source the project-root .env)
export $(grep -E '^FMP_API_KEY=' .env | xargs)
node scripts/fleet-fetch-bars.mjs       # ~97 tickers (15 ETFs + MeanRev universe + QQQ/SPY), 2014→now → data/lab/fleet-bar-cache/
node scripts/fleet-fetch-earnings.mjs   # earnings report dates for the equity universe → data/lab/fleet-earnings.json
node scripts/fleet-score.mjs --root .   # prereg → lane sims → align/weekly → corr/β + crisis cut → docs/lab/fleet-correlation-RESULTS.md
node --test scripts/fleet-*.test.mjs    # 53 unit tests
```

`data/lab/*` is git-ignored (bar cache, earnings JSON, prereg JSON). Only `docs/lab/fleet-correlation-RESULTS.md` and this RUNBOOK are committed.

## Module map

| Module | Role |
|---|---|
| `fleet-universe.mjs` | ticker source of truth (15 Turtle ETFs + clusters, MeanRev/Drift universe, QQQ/SPY) |
| `fleet-bars.mjs` | lab bar-cache loader (noon-UTC timestamps round-trip the calendar date — see the alignment-invariant test) |
| `fleet-fetch-bars.mjs` / `fleet-fetch-earnings.mjs` | FMP backfill CLIs (controller-authored) |
| `fleet-turtle-sim.mjs` | Turtle Donchian long-only sim → daily marks |
| `fleet-coil-marks.mjs` | Coil RSI(2)<5 tape rebuild + entry-anchored daily re-mark + portfolio overlay |
| `fleet-drift-sim.mjs` | Drift PEAD event sim (continuation-path only) → daily marks |
| `fleet-defensive-proxy.mjs` | def-Prophet structural-light proxy (QQQ<200DMA → BSM put-spread) |
| `fleet-align.mjs` | common daily index + weekly aggregation |
| `fleet-correlate.mjs` | Pearson/Spearman, β + bootstrap CI, crisis cut (mean+CI, ρ_crisis, downside β, rotation band, n-floor) |
| `fleet-prereg.mjs` | hashed pre-registration block (written before scoring) |
| `fleet-report.mjs` | per-lane classifier + descriptive tail note + RESULTS renderer |
| `fleet-score.mjs` | orchestrator (controller-authored) |

## How to read it

- **Full-sample β to QQQ** (with bootstrap CI) is the primary accidental-long-β detector. β levels are **gross, not net-economic**. A low β with a moderate ρ means low-magnitude directional co-movement (mean-reversion makes small moves) — read both columns.
- **Crisis cut is a descriptive lens, not a verdict.** Crisis-conditional **mean return** (bootstrap CI) is the primary ballast read (cushion vs co-crash). ρ_crisis / downside β are shown beside a **rotation context band** (p5/p50/p95 of the same stat under no real QQQ dependence). A ρ_crisis beyond [p5,p95] is *suggestive* of genuine tail co-movement; cells with < 8 nonzero crisis weeks are flagged `insufficient_power`.
- **tail notes:** `cushions` / `co_crashes` / `co_crashes_with_tail_comove` / `tail_comove_only` / `tail_neutral` / `insufficient_power`.

## Key limits & documented simplifications (also in the hashed prereg)

- Reconstructed **paper** returns; co-movement is the signal, absolute levels are not.
- **Turtle** omits the rarely-binding corr-guard / aggregate-risk cap / segment breaker; regime gate neutral (off live).
- **Coil** day-0 mark anchored to the tape `entry` fill (matches `grossReturn`).
- **Drift** is continuation-path only (the rarely-reachable weekly-PEAD-ready path is omitted), 2022+ floor (earnings-data window), BMO/AMC timing inferred when the vendor omits it; inherently sparse → lower confidence.
- **def-Prophet** is a **proxy** (QQQ<200DMA price-only trigger + BSM put-spread with trailing-RV IV); the trigger is lagging/whipsaw-prone, so NO crisis-timing-coverage inference is drawn — it appears only in the crisis table, never as a headline full-sample number.

## Methodology note (2026-06-06)

The crisis centerpiece originally specified a downside-β-**jump** (crisis − full) gated by a rotation
surrogate. A build-time empirical check found it **underpowered**: β over crisis weeks divides by a
near-degenerate `var(QQQ|crisis)` → leverage-explosive, non-centered null; and when crisis weeks
dominate the full-sample variance, the jump collapses toward zero for a genuine tail co-move. It was
replaced with the descriptive lens above (crisis mean + CI primary; rotation surrogate kept as a
context band, not a gate). Full-sample β + its CI is the primary accidental-long-β detector.

## Deferred

- PCA / factor-model decomposition (overkill for 4 lanes; β + crisis cut answers the question).
- Real `regime_gate` reconstruction for def-Prophet (its 4-skill inputs have no multi-year history).
- Re-confirming Coil's tail co-movement (the one non-trivial finding) on net-of-friction returns.
