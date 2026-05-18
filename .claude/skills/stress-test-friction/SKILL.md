---
name: stress-test-friction
description: Compare baseline vs ~2x stress friction across an agent's recent trades. Diagnostic-only — never modifies any config or strategy. Use before live deployment to confirm the strategy has edge that survives worst-case fills.
allowed-tools: Read Glob Bash
---

You are running a stress-test of friction-adjusted P&L for one (or all) of the trading agents.

## Step 1 — Resolve agent

If the user supplied an agent name (`default`, `penny-prophet`, `harvest`, `trend-prophet`), use it. If they said "all" or didn't specify, iterate all four.

## Step 2 — Generate or refresh the stress comparison report

For each target agent, run:

```
node scripts/friction-stress-compare.mjs --agent <agent-id>
```

The script regenerates both baseline `*.friction.json` and stress `*.friction-stress.json` files for the agent's sandboxes, then writes `data/reports/friction_stress_<agent>_<YYYYMMDD>.json`.

If a report from today already exists, skip regeneration unless the user explicitly asked for `--force`.

## Step 3 — Read the report and present a human summary

For each agent, present a block in this exact format:

```
Stress test for agent `<agent>` — <trade_count> trades
  Baseline total adjusted P&L:  <baseline_pl_usd>
  Stress total adjusted P&L:    <stress_pl_usd>    (Δ <total_delta_usd>, avg <avg_per_trade_delta_usd>/trade)

Trades that flip from winner to loser under stress: <flips.length> of <single_leg_options.trade_count or whichever asset class has flips>
  - <each flip>: <baseline_pl> → <stress_pl>  (cap at top 5)

Per-asset-class verdict (flip_rate = flips / matched_trade_count_in_category):
  <asset>: <flips_in_category> of <trade_count_in_category> flip — <verdict>

Interpretation: <one-paragraph human reading>
```

**Flip-rate verdict thresholds (CODIFIED — do not improvise):**

```
flip_rate < 0.05           → "durable"   ("edge survives worst-case fills")
0.05 ≤ flip_rate < 0.20    → "marginal"  ("edge thins under stress; consider tightening entry filters")
flip_rate ≥ 0.20           → "thin"      ("edge does not survive worst-case fills; reconsider before live deployment")
trade_count_in_category == 0 → "n/a (no trades in window)"
```

## Step 4 — Diagnostic-only — never modify

You MUST NOT modify any config file, any strategy, any decisive_action, or any committed file. This skill is purely informational. If the user asks you to "apply" or "tune" friction based on the stress result, point them at `/adapt-strategy` instead — that's the loop that takes evidence and turns it into rule changes.
