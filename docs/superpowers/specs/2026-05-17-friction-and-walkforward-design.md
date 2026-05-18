# Friction Layer + Walk-Forward Hold-Out — Design Spec

**Date:** 2026-05-17
**Status:** Approved for planning
**Scope:** All 4 trading agents (Prophet, Spark/PennyProphet, Harvest, Turtle/TrendProphet)

## Problem

The agent learning loop (`adapt-strategy` family of skills) reads paper-trading P&L from `decisive_actions/*.json` and proposes rule changes. Two failure modes:

1. **Paper-to-live gap is invisible.** Paper fills assume midpoint execution and zero commissions. Live fills cost real money (spread crossing, gap-through slippage on stops, per-contract fees, multi-leg option spread compounding). Rules tuned to clean paper data will under-perform live, and the adapter has no way to know.
2. **Adapt-strategy overfits to recent noise.** With no held-out data, every proposed rule change is generated against the same trades it's evaluated on. A few unlucky losers can trigger a rule tweak that fits past noise but degrades future performance.

The user is at 50–100 trades on paper and considering eventual small-capital live deployment. The goal is to close as much of the paper-to-live gap as possible *before* going live, so the strategies in production aren't re-tuned from scratch under real-money conditions.

## Goals

1. Inject realistic friction (slippage + spread crossing + commissions/fees) into the data the adapt-strategy skills consume, without modifying the production Go agent or mutating raw trade records.
2. Add walk-forward hold-out validation to the 4 adapt-strategy skills so proposed rule changes are sanity-checked against trades the adapter did not see during proposal generation.
3. Make the friction model easy to tune over time as the user compares paper-adjusted estimates against eventual live fills.

## Non-Goals

- Random fast-market non-fill simulation. Without empirical calibration, this adds fictional noise the adapter would optimize against.
- Backtesting historical data with the new rules ("would this rule have worked over the last 6 months?"). Out of scope — that's a real backtester project, not part of friction modeling.
- Modifying the Go agent. Friction is a post-processing concern only.
- Changes to MCP tools, mcp-server, or vectorDB.
- Per-strategy comparison views, parallel live-vs-paper reports, or any UI work.

## High-Level Architecture

Three new artifacts and edits to 6 existing skill files. No changes to Go code.

```
data/sandboxes/<id>/decisive_actions/
    2026-05-11T...SELL_QQQ.json                (raw, paper midpoint, unchanged)
                          ↓ scripts/apply-friction.mjs
    2026-05-11T...SELL_QQQ.friction.json       (friction-adjusted, gitignored)
                          ↓ adapt-strategy skill reads
    proposed rule changes  ←─ Claude
                          ↓ scripts/score-rule-against-holdout.mjs
                            + Claude qualitative review on held-out trades
    APPROVED-BY-HOLDOUT / REJECTED-BY-HOLDOUT / INCONCLUSIVE flag per proposal
                          ↓
    User reviews flagged proposals, approves applies
```

## Components

### 1. `config/friction.json`

Single source of truth for friction parameters. Per-asset-class profiles. Version-controlled. Easy to tune as the user observes paper-vs-live divergence.

```json
{
  "stocks": {
    "per_share_slippage_usd": 0.02,
    "stop_gap_through_pct": 0.003,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001
  },
  "penny_stocks": {
    "per_share_slippage_usd": 0.01,
    "stop_gap_through_pct": 0.015,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001
  },
  "single_leg_options": {
    "spread_crossing_pct_open": 0.60,
    "spread_crossing_pct_close": 0.65,
    "assumed_spread_pct_of_mid": 0.04,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05
  },
  "iron_condor": {
    "spread_crossing_pct_open": 0.55,
    "spread_crossing_pct_close": 0.65,
    "assumed_spread_pct_of_credit": 0.10,
    "leg_count": 4,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05
  }
}
```

These are industry-reasonable starting points. The user will tune them as live data becomes available.

### 2. `scripts/apply-friction.mjs`

Pure-function Node.js post-processor.

**Invocation:** `node scripts/apply-friction.mjs --agent <agent-id>`

**Behavior:**

1. Load `config/friction.json`. Fail loud if missing or malformed.
2. Load `data/agent-config.json`. Resolve `<agent-id>` → strategyId, then iterate `sandboxes` for entries with `agent.activeAgentId === <agent-id>`. Collect their `accountId` values.
3. For each sandbox directory, glob `decisive_actions/*.json` (excluding `*.friction.json`).
4. For each decisive action:
   - Detect asset class (see Detection Rules below).
   - If asset class can't be determined or `market_data.entry_price` is missing, skip and log to stderr.
   - Compute friction-adjusted P&L using the appropriate profile.
   - Write `<original-filename>.friction.json` containing the raw action plus a `friction_meta` block:
     ```json
     {
       "...all original fields...": "...",
       "market_data": {
         "...all original market_data fields...": "...",
         "raw_pl": -432,
         "friction_adjusted_pl": -487
       },
       "friction_meta": {
         "profile_applied": "single_leg_options",
         "haircut_total_usd": 55,
         "haircut_breakdown": {
           "spread_crossing": 48,
           "commissions": 5,
           "regulatory_fees": 2
         },
         "applied_at": "2026-05-17T...",
         "friction_config_version": "<first 8 chars of sha256 of friction.json contents>"
       }
     }
     ```
5. Idempotent. Re-running overwrites cleanly.

**Haircut formulas (deducted from raw P&L):**

| Asset class | Formula |
|---|---|
| `stocks` | `(per_share_slippage + reg_fee) × shares × 2`; if stop-out, add `stop_gap_through_pct × entry_price × shares` |
| `penny_stocks` | Same as stocks, with penny profile values |
| `single_leg_options` | `assumed_spread × (open_pct + close_pct) × contracts × 100 + (commission + reg_fee) × contracts × 2` |
| `iron_condor` | `assumed_spread_pct_of_credit × theoretical_credit + (commission + reg_fee) × 4 × 2 × contracts` |

Stop-out detection: `reasoning` contains substring "stop hit", "stopped out", "stop triggered", AND `market_data.unrealized_pct` is negative.

### 3. Asset-class detection

Inferred from the decisive action's `symbol` and the invoking agent:

| Detection rule | Class |
|---|---|
| Agent is `harvest` | `iron_condor` (override — Harvest is iron-condor-only) |
| Symbol matches OCC format (`^[A-Z]{1,6}\d{6}[CP]\d{8}$`) AND `reasoning` contains "iron condor", "IC", or "4-leg" | `iron_condor` |
| Symbol matches OCC format (no IC marker) | `single_leg_options` |
| Plain ticker AND agent is `penny-prophet` | `penny_stocks` |
| Plain ticker, any other agent | `stocks` |
| None of the above | Skip, log warning, increment skipped-count |

Surface a count of skipped files at end of run.

### 4. `scripts/score-rule-against-holdout.mjs`

Programmatic predicate scorer for mechanical rules. Called by the adapt skills (or runnable standalone for debugging).

**Invocation:** `node scripts/score-rule-against-holdout.mjs --predicate <name> --params <json> --trades <holdout-file-list-or-stdin>`

**Supported predicates (starter set — grows over time):**

| Predicate | Params | Logic |
|---|---|---|
| `max_position_size_pct` | `{ "limit": 0.15 }` | Flag any hold-out trade where `(entry_price × size) / portfolio_value > limit` |
| `stop_at_pct` | `{ "stop": -0.10 }` | For any hold-out trade whose trough went past `stop`, score whether ending at `stop` would have been better or worse than actual outcome |
| `max_concurrent_positions` | `{ "limit": 10 }` | Flag any window in hold-out where concurrent open positions exceeded `limit` |
| `no_reentry_within_hours` | `{ "hours": 2 }` | Flag any BUY within `hours` after a SELL of the same symbol in the hold-out set |
| `dte_bounds` | `{ "min": 50, "max": 120 }` | For OCC symbols in hold-out, flag any whose DTE at entry was outside bounds |

**Output:** JSON to stdout:

```json
{
  "predicate": "stop_at_pct",
  "params": { "stop": -0.10 },
  "holdout_size": 12,
  "trades_affected": 3,
  "net_pl_delta_usd": 145,
  "blocked_winners": 1,
  "blocked_losers": 2,
  "verdict": "APPROVED-BY-HOLDOUT",
  "details": [
    { "symbol": "QQQ260515C00712000", "outcome_change": "+87 (would have cut earlier)" },
    "..."
  ]
}
```

**Verdict rules:**

- `net_pl_delta_usd > 0` → `APPROVED-BY-HOLDOUT`
- `net_pl_delta_usd < 0` → `REJECTED-BY-HOLDOUT`
- `trades_affected == 0` → `INCONCLUSIVE`

### 5. Skill markdown edits

Each adapt-strategy skill gets these inserted steps. Wording adapted to that skill's existing voice.

**Step 0 — Run friction post-processor:**
> Before reading any trade data, run `node scripts/apply-friction.mjs --agent <this-skill's-agent-id>`. Report any skipped files to the user. All subsequent data loading reads `*.friction.json` files, NOT raw `*.json`.

**Step 2.5 — Split into adapt set and hold-out set:**
> After loading the N most recent decisions, sort by timestamp ascending. Hold-out size = `ceil(N × 0.20)`. Adapt set = oldest `N − holdout_size`. Hold-out set = newest `holdout_size`. State both counts and date ranges to the user before proceeding. Gap analysis and proposal generation use only the adapt set.

**Step 6.5 — Validate proposed edits against hold-out:**
> For each proposed edit: classify as mechanical (maps to a predicate in `score-rule-against-holdout.mjs`) or qualitative. For mechanical, invoke the scorer and capture the verdict. For qualitative, read the hold-out trades and write a one-paragraph judgment citing specific trades. Empty hold-out for that rule → `INCONCLUSIVE`.

**Step 6.6 — Decision flag:**
> Attach the hold-out verdict to each proposal as `APPROVED-BY-HOLDOUT`, `REJECTED-BY-HOLDOUT`, or `INCONCLUSIVE`. Proposals flagged REJECTED require explicit user override before being applied in Step 8.

**Read-window bumps:** Per-skill increases so the 80% adapt slice retains meaningful sample size. `adapt-strategy` and `adapt-strategy-penny` currently read 60 trades (verified in `.claude/skills/adapt-strategy/SKILL.md` Step 3). `harvest-parameter-review` and `trend-parameter-review` read windows will be measured at implementation time by reading the current SKILL.md and adjusted by the same +25% factor; defaulting to 50 if the current value is below 40.

| Skill | Current read window | New read window |
|---|---|---|
| `adapt-strategy` | 60 | 75 |
| `adapt-strategy-penny` | 60 | 75 |
| `harvest-parameter-review` | measure at impl | max(current × 1.25, 50) |
| `trend-parameter-review` | measure at impl | max(current × 1.25, 50) |

`review-performance` and `review-performance-penny` get only the Step 0 edit (switch to `.friction.json` reads). They're reports, not adapters, so no hold-out logic.

## Data Flow Summary

1. User runs `/adapt-strategy` (or any of the 4 variants).
2. Skill's Step 0 invokes `apply-friction.mjs`, regenerating `.friction.json` files for the relevant agent.
3. Skill loads `.friction.json` files instead of raw `.json`.
4. Skill computes the 80/20 adapt/hold-out split.
5. Skill performs gap analysis and generates proposals using only the adapt slice.
6. For each proposal, skill invokes `score-rule-against-holdout.mjs` (mechanical) or performs qualitative review (soft rules).
7. Each proposal is presented to the user with its hold-out verdict.
8. User approves selected proposals; REJECTED-BY-HOLDOUT requires explicit override.
9. Approved proposals are applied to `customRules` in `data/agent-config.json` as today.

## Testing

`node:test` (per workflow preference).

**`scripts/apply-friction.test.mjs`:**
- Stock round trip: known input → expected friction deduction.
- Stock stop-out: reasoning "stop hit" + losing P&L → extra gap-through haircut.
- Option round trip: known credit, known spread assumption → expected deduction.
- Iron condor 4-leg compounding verified against hand-calculated value.
- Asset class detection: one test per branch in the detection table.
- Missing `market_data.entry_price` → skipped with stderr warning, no file written.
- Idempotency: two runs → byte-identical output.
- Custom friction profile loaded from fixture → overrides applied correctly.
- Side-effect tests (per verification-before-completion preference): mock FS, assert correct paths receive correct content. Test the executor that writes files, not only the pure transformer.

**`scripts/score-rule-against-holdout.test.mjs`:**
- `max_position_size_pct` against trade exceeding limit → flagged.
- `stop_at_pct` against trade that hit stop then recovered → flagged net-negative.
- `stop_at_pct` against trade that hit stop and went further → flagged net-positive.
- Empty hold-out → `INCONCLUSIVE`.
- Unknown predicate name → fail with clear error.

## Error Handling

| Scenario | Behavior |
|---|---|
| `config/friction.json` missing/malformed | Fail loud, point to docs. No silent fallback to defaults. |
| Malformed decisive action JSON | Stderr warning, skip file, continue. |
| Unknown asset class (no detection rule matches) | Stderr warning, skip file. Counted in skipped tally. |
| Friction-adjusted P&L flips sign from positive to negative | Stderr warning (not necessarily wrong — small winners can become losers under realistic friction — but worth surfacing). |
| Sandbox directory exists but has no decisive_actions | Silent no-op. |
| `score-rule-against-holdout.mjs` called with unknown predicate | Exit non-zero with clear error message naming supported predicates. |

## File Layout

```
config/
  friction.json                            (new)

scripts/
  apply-friction.mjs                       (new)
  apply-friction.test.mjs                  (new)
  score-rule-against-holdout.mjs           (new)
  score-rule-against-holdout.test.mjs      (new)

data/sandboxes/<id>/decisive_actions/
  <existing>.json                          (unchanged)
  <existing>.friction.json                 (generated, gitignored)

.claude/skills/adapt-strategy/SKILL.md             (edit)
.claude/skills/adapt-strategy-penny/SKILL.md       (edit)
.claude/skills/harvest-parameter-review/SKILL.md   (edit)
.claude/skills/trend-parameter-review/SKILL.md     (edit)
.claude/skills/review-performance/SKILL.md         (edit: Step 0 only)
.claude/skills/review-performance-penny/SKILL.md   (edit: Step 0 only)

docs/superpowers/specs/
  2026-05-17-friction-and-walkforward-design.md    (this file)

.gitignore                                 (edit: add data/sandboxes/**/*.friction.json)
```

## Limitations and Honest Caveats

1. **A 12-trade hold-out is a sanity check, not a hypothesis test.** APPROVED-BY-HOLDOUT does not mean the rule is statistically validated; it means it didn't blow up on the most recent slice the adapter never saw. Skill output must label it as such.
2. **Asset class detection from symbol + reasoning is heuristic.** If the user adds new strategies (e.g., calendar spreads, diagonals, naked puts), the detection table needs new entries.
3. **The friction model is an estimate.** Real fills will diverge — sometimes better (resting limit orders that catch favorable moves), sometimes worse (fast markets, low-liquidity options). The model captures the average expected drag, not the per-trade truth.
4. **Predicate coverage is intentionally small at launch.** Rules outside the supported predicate set get qualitative review only. As the user adds rules with hard thresholds, predicate coverage grows. No upfront attempt to cover every possible rule.
5. **Hold-out doesn't help with rules whose impact is regime-dependent.** A "no entries during high VIX" rule needs regime data, not just trade outcomes. Future work, if needed.
6. **Friction parameters need ongoing tuning.** The first live trades the user places will produce divergence data — `config/friction.json` should be updated as that data accumulates.

## Out of Scope (Explicit YAGNI)

- Random fast-market non-fill simulation.
- Backtester or historical replay.
- Go agent modifications.
- MCP / mcp-server / vectorDB changes.
- Live-vs-paper comparison reports.
- Regime-aware weighting of trades (item #3 in original conversation — deferred).
- Stress-testing against 2x worse friction (item #4 — deferred; can be done ad-hoc by editing `config/friction.json`).
- Anti-recent-loss-chasing logic (item #5 — deferred).
