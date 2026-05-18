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
  "version": "2026-05-17.1",
  "stocks": {
    "per_share_slippage_usd": 0.02,
    "stop_gap_through_pct": 0.003,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001
  },
  "penny_stocks": {
    "per_share_slippage_usd": 0.01,
    "slippage_pct_of_price_floor": 0.02,
    "stop_gap_through_pct": 0.015,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001,
    "_note": "Effective slippage per share = max(per_share_slippage_usd, slippage_pct_of_price_floor × price). This prevents under-modeling on sub-$1 names where 1¢ is a tiny fraction of the actual spread."
  },
  "single_leg_options": {
    "spread_crossing_pct_open": 0.60,
    "spread_crossing_pct_close": 0.65,
    "spread_crossing_pct_close_when_losing": 0.75,
    "assumed_spread_pct_of_mid": 0.04,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05,
    "_note": "Closes-at-loss use the higher crossing pct because the spread widens precisely when you most want out. Without this asymmetry, the adapter sees noisier-than-real winners and quieter-than-real losers, biasing toward strategies that look good on average but tail badly."
  },
  "iron_condor": {
    "spread_crossing_pct_open": 0.55,
    "spread_crossing_pct_close": 0.65,
    "spread_crossing_pct_close_when_losing": 0.80,
    "assumed_spread_pct_of_credit": 0.10,
    "leg_count": 4,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05,
    "_note": "assumed_spread_pct_of_credit is a blunt approximation — real iron-condor spread cost does not scale linearly with credit, especially when one side is tested. Acceptable for initial modeling; refine as live data accumulates."
  }
}
```

`version` is a date-stamped tag the user bumps when tuning. It's recorded in every `.friction.json`'s `friction_meta` alongside the content hash, so reproducing the exact friction state of a past adapt-strategy run is possible from the metadata alone.

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
         "close_was_losing": true,
         "haircut_total_usd": 55,
         "haircut_breakdown": {
           "spread_crossing": 48,
           "commissions": 5,
           "regulatory_fees": 2
         },
         "friction_config_version": "2026-05-17.1",
         "friction_config_hash": "<first 8 chars of sha256 of friction.json contents>"
       }
     }
     ```
5. **Atomic writes:** write to `<filename>.friction.json.tmp`, then `rename` to final name. Prevents corrupt files if the script crashes mid-write.
6. **Idempotent:** re-running produces byte-identical output (no embedded timestamps in the file body — see `friction_meta` block below). File mtime captures when it was generated.

**Haircut formulas (deducted from raw P&L):**

Define helper values used below:
- `mid_price` = `(entry_price + exit_price) / 2`
- `spread_dollars` = `assumed_spread_pct_of_mid × mid_price` (for options — converts the percentage config value to a dollar spread)
- `close_was_losing` = `exit_price < entry_price` (for long positions) — selects between `spread_crossing_pct_close` and `spread_crossing_pct_close_when_losing`

| Asset class | Formula |
|---|---|
| `stocks` | `(per_share_slippage + reg_fee) × shares × 2`; if stop-out detected, add `stop_gap_through_pct × entry_price × shares`. Note: `stop_gap_through_pct` is an average over-slippage assumption beyond the stop price, not derived from the actual stop level. |
| `penny_stocks` | Effective slippage = `max(per_share_slippage_usd, slippage_pct_of_price_floor × entry_price)`. Then same shape as stocks. |
| `single_leg_options` | `spread_dollars × (spread_crossing_pct_open + selected_close_pct) × contracts × 100 + (commission_per_contract + regulatory_fee_per_contract) × contracts × 2`. `selected_close_pct` switches on `close_was_losing`. |
| `iron_condor` | `assumed_spread_pct_of_credit × theoretical_credit × (1 + losing_close_multiplier) + (commission_per_contract + regulatory_fee_per_contract) × leg_count × 2 × contracts`. `losing_close_multiplier` = 0 normally, `(spread_crossing_pct_close_when_losing − spread_crossing_pct_close)` if `close_was_losing`. Theoretical credit comes from `market_data.theoretical_credit` if present, else estimated from `entry_price × contracts × 100`. |

Stop-out detection (broadened from initial design to reduce false negatives — flagged in review):

`reasoning` (case-insensitive) contains any of: `"stop hit"`, `"stopped out"`, `"stop triggered"`, `"hit my stop"`, `"hit stop"`, `"stop loss fired"`, `"sl hit"`, `"stop loss triggered"`, `"forced out"` — AND `market_data.unrealized_pct` is negative. New phrasings discovered later are added to this list with a test case each.

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

| Predicate | Params | Logic | Limitations |
|---|---|---|---|
| `max_position_size_pct` | `{ "limit": 0.15 }` | Flag any hold-out trade where `(entry_price × size) / portfolio_value > limit` | None — fully derivable from existing data |
| `stop_at_pct` | `{ "stop": -0.10 }` | For any hold-out trade whose **closing** `unrealized_pct` ≤ `stop`, score the difference between actual exit P&L and the P&L of an exit at `stop` | **Only sees trades that closed past the threshold.** Cannot detect trades that touched the stop mid-life and recovered, because the schema lacks an intra-trade low-watermark field. This systematically undercounts how often the rule would have fired — verdicts are biased toward APPROVED (the rule only "fires" on trades it can't make worse). Document this in the skill output. |
| `max_concurrent_positions` | `{ "limit": 10 }` | Flag any window in hold-out where concurrent open positions exceeded `limit` | Requires reconstructing concurrent open positions from BUY/SELL sequence |
| `no_reentry_within_hours` | `{ "hours": 2 }` | Flag any BUY within `hours` after a SELL of the same symbol in the hold-out set | None |
| `dte_bounds` | `{ "min": 50, "max": 120 }` | For OCC symbols in hold-out, flag any whose DTE at entry was outside bounds | None — DTE derivable from OCC symbol expiration |

**Output:** JSON to stdout:

```json
{
  "predicate": "stop_at_pct",
  "params": { "stop": -0.10 },
  "review_type": "mechanical",
  "holdout_size": 15,
  "trades_affected": 3,
  "net_pl_delta_usd": 145,
  "blocked_winners": 1,
  "blocked_losers": 2,
  "verdict": "APPROVED-BY-HOLDOUT",
  "limitation_notes": ["stop_at_pct only sees trades that CLOSED past threshold; true firing count likely higher"],
  "details": [
    { "symbol": "QQQ260515C00712000", "outcome_change": "+87 (would have cut earlier)" },
    "..."
  ]
}
```

`review_type` is always `"mechanical"` for predicate-scored output. The qualitative review path (Step 6.5 below) emits the same envelope but with `review_type: "qualitative"` so the skill never confuses the two when presenting verdicts to the user.

**Verdict rules (require minimum effect size to avoid noise verdicts on small samples):**

- `trades_affected == 0` → `INCONCLUSIVE` (rule doesn't apply to any held-out trade)
- `trades_affected < 3 AND |net_pl_delta_usd| < 200` → `INCONCLUSIVE` (effect size too small to distinguish from noise on a 12-15 trade slice)
- `net_pl_delta_usd > 0` AND above gate cleared → `APPROVED-BY-HOLDOUT`
- `net_pl_delta_usd < 0` AND above gate cleared → `REJECTED-BY-HOLDOUT`

The effect-size gate is calibrated for the current hold-out size (12-15 trades). If hold-out size grows substantially (e.g., past 50 trades), the thresholds should be tightened or replaced with a proper statistical test. Tracked as future work.

### 5. Skill markdown edits

Each adapt-strategy skill gets these inserted steps. Wording adapted to that skill's existing voice.

**Step 0 — Run friction post-processor:**
> Before reading any trade data, run `node scripts/apply-friction.mjs --agent <this-skill's-agent-id>`. Report any skipped files to the user. **If skipped files exceed 10% of total decisive actions, warn the user explicitly that the adapt set may be biased and offer to abort.** All subsequent data loading reads `*.friction.json` files, NOT raw `*.json`. **All P&L-derived metrics (win rate, average win/loss, profit factor, drawdown) MUST use `market_data.friction_adjusted_pl`. If that field is absent on a record (legacy/skipped), fall back to the original P&L field and tag the record in any output as "raw-pl-fallback".**

**Step 2.5 — Split into adapt set and hold-out set:**
> After loading the N most recent decisions, sort by timestamp ascending. Hold-out size = `ceil(N × 0.20)`. Adapt set = oldest `N − holdout_size`. Hold-out set = newest `holdout_size`. **If N is less than the configured read window because not enough trades exist, use what's available; if N < 20, warn explicitly that adaptation may be premature on this little data.** State adapt-set and hold-out-set counts, date ranges, AND symbol concentration of each (top 3 symbols and what % they represent) to the user before proceeding. Gap analysis and proposal generation use only the adapt set.

**Step 6.5 — Validate proposed edits against hold-out (READ-ONLY, NO ITERATION):**
> For each proposed edit: classify as mechanical (maps to a predicate in `score-rule-against-holdout.mjs`) or qualitative. For mechanical, invoke the scorer and capture the verdict envelope (including `review_type: "mechanical"`). For qualitative, read the hold-out trades and write a one-paragraph judgment citing specific trades; emit a parallel envelope with `review_type: "qualitative"` and a verdict bucket. Empty hold-out for that rule → `INCONCLUSIVE`.
>
> **Once hold-out data has been read in this step, no new proposals may be generated in the same skill invocation.** If the user wants to propose alternatives after seeing hold-out verdicts, that requires a new skill run with a fresh trade window. This prevents hold-out information from leaking into proposal generation.

**Step 6.6 — Decision flag:**
> Attach the hold-out verdict to each proposal: `APPROVED-BY-HOLDOUT`, `REJECTED-BY-HOLDOUT`, or `INCONCLUSIVE`. Include `review_type`, `trades_affected`, and effect size in the displayed verdict — a "+$145 APPROVED" from 1 affected trade reads very differently than the same delta across 5 trades. Application rules:
>
> - `APPROVED-BY-HOLDOUT`: user-approved proposals applied normally.
> - `REJECTED-BY-HOLDOUT`: requires explicit user override before being applied in Step 8.
> - `INCONCLUSIVE`: user decides as normal. Most proposals will land here at current sample size — that's honest, not a failure mode. Do not auto-reject or auto-approve INCONCLUSIVE proposals; just flag prominently.

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
- Stop-out near-miss phrasings: each broadened substring ("hit my stop", "SL hit", "stop loss fired", etc.) produces the extra gap-through haircut.
- Option round trip (winning close): expected spread deduction at `spread_crossing_pct_close`.
- Option round trip (losing close): expected spread deduction at the higher `spread_crossing_pct_close_when_losing`.
- Iron condor 4-leg compounding verified against hand-calculated value, both winning and losing close.
- Penny floor: $0.50 stock and a $0.05 stock both have effective slippage = `max(per_share_slippage_usd, pct_floor × price)`.
- Asset class detection: one test per branch in the detection table.
- Missing `market_data.entry_price` → skipped with stderr warning, no file written.
- Sign-flip warning: a small raw winner that flips to a loss under friction → warning emitted to stderr, file still written.
- Idempotency: two runs → byte-identical output (no `applied_at` field embedded in the body; file mtime carries time info).
- Atomic write: simulate a crash mid-write (mock `rename` to throw); assert no partial `.friction.json` exists, only the `.tmp` cleanup target.
- Custom friction profile loaded from fixture → overrides applied correctly.
- Version field propagation: friction.json `version: "2026-05-17.1"` → recorded in every output's `friction_meta.friction_config_version`.
- Side-effect tests (per verification-before-completion preference): mock FS, assert correct paths receive correct content. Test the executor that writes files, not only the pure transformer.

**`scripts/score-rule-against-holdout.test.mjs`:**
- `max_position_size_pct` against trade exceeding limit → flagged.
- `stop_at_pct` against trade that closed at -12% with stop=-10% → flagged net-positive (would have cut earlier).
- `stop_at_pct` against trade that closed at -5% → not flagged (didn't close past threshold; intra-trade trough is unknowable from schema, surfaced as limitation note).
- `stop_at_pct` output includes the `limitation_notes` array warning about intra-trade trough invisibility.
- Effect-size gate: 1 trade affected, $50 delta → `INCONCLUSIVE` (below both gates).
- Effect-size gate: 1 trade affected, $250 delta → `APPROVED-BY-HOLDOUT` (passes |delta| gate).
- Effect-size gate: 4 trades affected, $50 delta → `APPROVED-BY-HOLDOUT` (passes trades_affected gate).
- Empty hold-out → `INCONCLUSIVE`.
- Output envelope contains `review_type: "mechanical"`.
- Unknown predicate name → fail with clear error message naming the supported predicates.

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

1. **A 12-15 trade hold-out is a sanity check, not a hypothesis test.** APPROVED-BY-HOLDOUT does not mean the rule is statistically validated; it means it didn't blow up on the most recent slice the adapter never saw, AND it cleared a minimum effect-size gate. Skill output must label this verdict as a sanity-check signal, not a validated result. Most verdicts will be `INCONCLUSIVE` at this sample size, which is the honest answer.
2. **`stop_at_pct` undercounts stop firings by design.** The trade schema records P&L at close, not the intra-trade trough. A trade that touched -12% and recovered to -5% is invisible to the predicate as "would have stopped at -10%". The verdict is biased toward APPROVED because the rule can only fire on trades whose final outcome the rule cannot make worse. Surfacing the `limitation_notes` array in skill output mitigates this; eliminating it would require a Go agent change (out of scope).
3. **Asset class detection from symbol + reasoning is heuristic.** If the user adds new strategies (calendar spreads, diagonals, naked puts), the detection table needs new entries.
4. **The friction model is an estimate.** Real fills will diverge — sometimes better (resting limit orders that catch favorable moves), sometimes worse (fast markets, low-liquidity options). The model captures average expected drag, not per-trade truth. The losing-close asymmetry partially addresses the most important systematic bias, but is itself a coarse approximation.
5. **Predicate coverage is intentionally small at launch.** Rules outside the supported predicate set get qualitative review only. Predicate coverage grows as the user adds rules with hard thresholds.
6. **Hold-out doesn't help with rules whose impact is regime-dependent.** A "no entries during high VIX" rule needs regime data joined to each trade timestamp, not just trade outcomes. Future work.
7. **Friction parameters need ongoing tuning.** First live trades produce divergence data — bump `config/friction.json`'s `version` field and tune values as that data accumulates. Past `.friction.json` files retain their config hash so older adapt-strategy runs remain reproducible.
8. **Effect-size gates are calibrated for current hold-out size.** At 12-15 trades, `|delta| > 200 OR trades_affected >= 3` is a reasonable noise floor. Once trade counts grow past ~50 in the hold-out, these thresholds become too lax and should be replaced with a proper statistical test. Tracked as future work.

## Out of Scope (Explicit YAGNI)

- Random fast-market non-fill simulation.
- Backtester or historical replay.
- Go agent modifications (including a low-watermark field that would fully fix `stop_at_pct`).
- MCP / mcp-server / vectorDB changes.
- Live-vs-paper comparison reports.
- Regime-aware weighting of trades (item #3 in original conversation — deferred).
- Stress-testing against 2x worse friction (item #4 — deferred; can be done ad-hoc by editing `config/friction.json`).
- Anti-recent-loss-chasing logic (item #5 — deferred).
- mtime-based skip in `apply-friction.mjs` (a perf optimization that doesn't matter at 100 trades; will matter past ~1000).
- Config migration script that warns when an old `.friction.json`'s hash doesn't match current config (useful long-term, not needed at this scale).
- Extracting the asset class detection table into config (the table is small and edited rarely; pulling it out adds a second source of truth for no real benefit).
- Proper statistical hypothesis test for verdict thresholds (current effect-size gates are sized for ~15 trade hold-out; revisit if hold-out grows past ~50).
