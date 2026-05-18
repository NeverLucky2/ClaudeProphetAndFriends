# Regime Weighting + Stress-Test + Significance Gate — Design Spec

**Date:** 2026-05-18
**Status:** Approved for planning
**Scope:** Items #3, #4, #5 from the 2026-05-17 friction-and-walkforward "Out of Scope" backlog. All 4 trading agents (Prophet, Spark/PennyProphet, Harvest, Turtle/TrendProphet).
**Builds on:** `docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md`

## Problem

The friction layer + 80/20 hold-out shipped on 2026-05-17 closes two failure modes (paper-to-live gap, no held-out validation) but leaves three deferred anti-overfit gaps in the adapt-strategy loop:

1. **No regime awareness.** If 80 of 100 trades happened in a low-vol uptrend, "findings" from adapt-strategy collapse to "long-biased momentum works in bull markets" — a non-finding that fails the moment regime flips.
2. **Friction model is a single estimate.** A strategy that's marginally profitable under baseline friction may lose money under realistic worst-case fills. No way to see this before going live.
3. **Adapt-strategy can chase recent-loss noise.** A few unlucky losers trigger a rule tweak. Next week, a few more trigger more tweaks. The adapter curve-fits to short-term noise instead of converging on signal.

## Goals

1. Tag each trade with the market regime active on its trade-date. Surface regime composition of adapt and hold-out sets. Flag predicate verdicts when affected trades are concentrated in one regime.
2. Provide an alternate friction profile ~2x worse than baseline and a comparison tool that makes it visually obvious whether the strategy has enough edge to survive worst-case fills.
3. Block proposal generation in any asset-class category that lacks sufficient losing-trade signal to warrant a rule change.

## Non-Goals

- Replacing the existing macro-regime-detector skill with this on-the-fly classifier. The classifier here is a lightweight reproducible label, not a macro analysis.
- Backfilling historical `macro_regime_*.json` snapshots.
- Auto-rejecting proposals based on REGIME WARNING — the warning only annotates the verdict; user still decides.
- Per-strategy threshold tuning for the significance gate (single global default at v1).
- Statistical hypothesis testing in place of the gross-exposure drawdown gate (revisit if trade counts grow past ~50 per category).
- Go agent or MCP server changes. All work is script-and-skill side.

## High-Level Architecture

Three new scripts, one extension to two existing scripts, edits to the four adapt skills + two review skills, and one new skill.

```
config/
  friction.json                                (existing — baseline, unchanged)
  friction-stress.json                         (NEW — Item #4, ~2x slippage + spread crossing)

scripts/
  apply-friction.mjs                           (extend: --config flag, output_suffix from config)
  apply-friction.test.mjs                      (extend: new flag/suffix tests)
  score-rule-against-holdout.mjs               (extend: --regime-history flag, regime_warning in envelope)
  score-rule-against-holdout.test.mjs          (extend: regime_warning tests)
  build-regime-history.mjs                     (NEW — Item #3, SPY → date→label JSON)
  build-regime-history.test.mjs                (NEW)
  friction-stress-compare.mjs                  (NEW — Item #4, baseline vs stress diff)
  friction-stress-compare.test.mjs             (NEW)
  significance-gate.mjs                        (NEW — Item #5, per-category gate)
  significance-gate.test.mjs                   (NEW)

data/reports/
  regime_history.json                          (generated, gitignored)
  friction_stress_<agent>_<YYYYMMDD>.json      (generated, gitignored)

data/sandboxes/<id>/decisive_actions/
  *.friction.json                              (existing, unchanged)
  *.friction-stress.json                       (NEW — generated when stress config applied, gitignored)

.claude/skills/adapt-strategy/SKILL.md             (edit: Step 0.5, Step 3 join, Step 3.5, Step 4.5, Step 6, Step 6.5, Step 6.6)
.claude/skills/adapt-strategy-penny/SKILL.md       (edit: same)
.claude/skills/harvest-parameter-review/SKILL.md   (edit: same; numbering already matches)
.claude/skills/trend-parameter-review/SKILL.md     (edit: same; numbering offset due to existing DB-cohort Step 2c)
.claude/skills/review-performance/SKILL.md         (edit: regime composition announcement only)
.claude/skills/review-performance-penny/SKILL.md   (edit: same)
.claude/skills/stress-test-friction/SKILL.md       (NEW)

.gitignore                                      (edit: add data/sandboxes/**/*.friction-stress.json
                                                       and data/reports/regime_history.json
                                                       and data/reports/friction_stress_*.json)

docs/superpowers/specs/
  2026-05-18-regime-stress-significance-design.md  (this file)
```

## Components

### Item #3 — Regime tagging

#### 1. `scripts/build-regime-history.mjs`

Pure-function Node.js script. Pulls SPY daily closes from FMP, classifies each US trading date into one of three labels, writes a date-keyed JSON map.

**Invocation:** `node scripts/build-regime-history.mjs [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>]`

If `--from`/`--to` are omitted, defaults are `--from` 90 days back and `--to` today. The adapt skills supply explicit `--from` matching their oldest trade-date.

**Classifier (3-bucket SPY-only with 50DMA-slope tiebreaker):**

```
For each trading date D in [from, to]:
  spy_close[D]       = SPY adjusted close that day
  spy_50dma[D]       = mean(spy_close[D-49..D])  (requires 50 days of prior data → fetch range starts from-49 days)
  spy_20d_return[D]  = (spy_close[D] / spy_close[D-20]) - 1
  spy_50dma_slope[D] = (spy_50dma[D] - spy_50dma[D-20]) / spy_50dma[D-20]

  if spy_close[D] > spy_50dma[D] AND spy_20d_return[D] > 0:
      regime[D] = "bull-trend"                              # full agreement
  elif spy_close[D] < spy_50dma[D] AND spy_20d_return[D] < 0:
      regime[D] = "bear-trend"                              # full agreement
  elif spy_close[D] > spy_50dma[D] AND spy_50dma_slope[D] > 0:
      regime[D] = "bull-trend"                              # pullback inside uptrend
  elif spy_close[D] < spy_50dma[D] AND spy_50dma_slope[D] < 0:
      regime[D] = "bear-trend"                              # bounce inside downtrend
  else:
      regime[D] = "chop"                                    # genuine non-trending day
```

The slope tiebreaker keeps "chop" reserved for days where price and 50DMA-trend genuinely disagree. Without it, every pullback inside an uptrend gets labeled chop, polluting the bucket with trend-day behavior and making the regime-skew warning under-fire.

**Output schema (`data/reports/regime_history.json`):**

```json
{
  "as_of": "2026-05-18T14:00:00Z",
  "range": { "from": "2026-02-01", "to": "2026-05-18" },
  "classifier": {
    "version": "2026-05-18.1",
    "rules": "SPY vs 50DMA + SPY 20D return; 3-bucket"
  },
  "labels": {
    "2026-02-03": "bull-trend",
    "2026-02-04": "chop",
    "...": "..."
  }
}
```

**Rebuild policy (idempotency):**

The script reads any existing `regime_history.json` first. Cache is reused only when ALL of these hold:

1. `range` covers every date in the requested window.
2. `as_of` is after the most recent NYSE session close + 1-hour buffer. **Specifically:** if the current time is before 5pm ET on a US trading day, the latest valid session close is yesterday's 4pm ET. If current time is after 5pm ET on a US trading day, today's 4pm ET. On weekends/holidays, the most recent prior trading day's 4pm ET. Cache is fresh only when `as_of >= that session-close + 1h`.
3. `classifier.version` matches the current script's classifier version.
4. `--force-rebuild` flag is NOT set.

If all four hold, reuse and exit 0 with a "cache hit" stderr message and no rewrite. Otherwise, fetch SPY data covering [from-49, to], compute, and write atomically (write-to-tmp-then-rename, mirror of `writeAtomic` in `apply-friction.mjs`).

**Why session-close + buffer instead of "< 24 hours":** A naive 24h freshness check passes at 10am on the same calendar day even though today's SPY close doesn't exist yet — the cache built at 10am will keep being reused all afternoon and the script will never pick up today's close. Tying freshness to NYSE session close + 1h ensures the cache is only "fresh" once today's data is actually queryable from FMP.

**CLI flags summary:** `--from <YYYY-MM-DD>` (default: 90 days ago), `--to <YYYY-MM-DD>` (default: today in ET), `--force-rebuild` (skip cache check, always fetch + write).

**Error handling:**

| Scenario | Behavior |
|---|---|
| `FMP_API_KEY` env var missing | Exit code 3, clear message naming the env var, no file changes. Skill catches non-zero, falls back to `regime: "unknown"` on every trade. |
| FMP network error / 5xx / timeout | Exit code 4, message includes upstream error. Skill behaves same as missing key. |
| Returned data is malformed (no close field, NaN closes) | Exit code 5, message points to the bad row. |
| Computed cache range falls short of `--from` (insufficient historical data) | Write what's available, set `range.from` accordingly, exit 0 with stderr warning. |

#### 2. `scripts/score-rule-against-holdout.mjs` extension

**New optional CLI flags:** `--regime-history <path>` and `--adapt-set-distribution <json>`.

When provided together, the scorer reads the regime history and, for any predicate that produces a `trades_affected ≥ 5` result, computes the regime composition of those specific affected trades AND compares to the adapt-set baseline distribution. If any single regime is over-represented in the affected trades by ≥25 percentage points relative to its share in the adapt set, append a `regime_warning` to the envelope.

**Two-stage gate (avoids fragile thresholds at small sample size):**

```
if trades_affected < 5:
    regime_warning_skipped = "insufficient_sample (need >= 5 affected trades; have <trades_affected>)"
else:
    for each regime r:
        affected_pct = (affected_trades where regime == r).count / trades_affected
        baseline_pct = adapt_set_distribution[r] (or 0 if absent)
        if affected_pct - baseline_pct >= 0.25:
            regime_warning = "affected trades <affected_pct%> <r> vs adapt-set <baseline_pct%> — proposal over-indexes on <r> regime by <delta_pp>pp"
            break
```

**Why relative-to-adapt-set, not absolute ≥70%:** If the adapt set itself is 80% bull-trend (small sample, recent bull market), any predicate firing on bull-trend trades would trip an absolute threshold spuriously — the bias is in the data, not the proposal. The relative comparison flags only proposals that over-index on a regime *beyond what the underlying data does*.

**Example envelope:**
```json
{
  "predicate": "stop_at_pct",
  "params": { "stop": -0.10 },
  "review_type": "mechanical",
  "trades_affected": 6,
  "net_pl_delta_usd": 145,
  "verdict": "APPROVED-BY-HOLDOUT",
  "regime_warning": "affected trades 100% bull-trend vs adapt-set 62% — proposal over-indexes on bull-trend regime by 38pp",
  "...": "..."
}
```

When `--regime-history` or `--adapt-set-distribution` is omitted (or the regime path doesn't exist), the envelope simply has no `regime_warning` field. No silent fallback.

Joining regime label to a held-out trade: convert `trade.timestamp` to America/New_York timezone, slice `YYYY-MM-DD`, lookup in `regime_history.labels`. If absent (weekend / holiday / late ET trade tipping into next UTC day), walk back up to 5 calendar days for the previous trading day's label. Still absent → that trade is excluded from both the `affected_pct` and `baseline_pct` calculations (excluded from numerator and denominator alike — does not count as its own regime).

#### 3. Skill edits for regime tagging

See "Skill markdown edits" below.

### Item #4 — Stress-test friction

#### 1. `config/friction-stress.json`

```json
{
  "version": "2026-05-18.1-stress",
  "output_suffix": "friction-stress",
  "stocks": {
    "per_share_slippage_usd": 0.04,
    "stop_gap_through_pct": 0.006,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001
  },
  "penny_stocks": {
    "per_share_slippage_usd": 0.02,
    "slippage_pct_of_price_floor": 0.04,
    "stop_gap_through_pct": 0.03,
    "commission_per_share": 0.0,
    "regulatory_fee_per_share": 0.0001
  },
  "single_leg_options": {
    "spread_crossing_pct_open": 0.80,
    "spread_crossing_pct_close": 0.85,
    "spread_crossing_pct_close_when_losing": 0.95,
    "assumed_spread_pct_of_mid": 0.08,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05
  },
  "iron_condor": {
    "spread_crossing_pct_open": 0.75,
    "spread_crossing_pct_close": 0.85,
    "spread_crossing_pct_close_when_losing": 0.95,
    "assumed_spread_pct_of_credit": 0.20,
    "leg_count": 4,
    "commission_per_contract": 0.65,
    "regulatory_fee_per_contract": 0.05
  }
}
```

**Calibration rationale:**

- Slippage components (`per_share_slippage_usd`, `slippage_pct_of_price_floor`, `assumed_spread_pct_of_mid`, `assumed_spread_pct_of_credit`, `stop_gap_through_pct`) are exactly 2x baseline.
- Spread-crossing percentages are increased toward — but capped at — 0.95. A literal 2x would push some past 1.0, which would model "paying more than the entire spread", physically possible at the worst tick but already over-modeled at 0.95 for normal fast-market conditions.
- Commissions and regulatory fees are unchanged. They are contractual, not subject to market conditions, so stress-testing them has no informational content.

#### 2. `scripts/apply-friction.mjs` extension

Two minimal changes:

1. **CLI accepts `--config <path>`** (default `config/friction.json`).
2. **`processSandboxes` accepts an optional `frictionConfigPath`** parameter (default same).
3. **Output filename suffix is driven by `output_suffix` in the config**:
   - If `output_suffix` is omitted or equals `"friction"`, writes `*.friction.json` (current behavior — back-compat).
   - If `output_suffix` is set (e.g., `"friction-stress"`), writes `*.friction-stress.json`.

`applyFriction` itself, the calculator functions, asset-class detection, and stop-out detection are all unchanged. The config schema validation in `loadFrictionConfig` is extended to accept the optional `output_suffix` string field.

#### 3. `scripts/friction-stress-compare.mjs`

**Invocation:** `node scripts/friction-stress-compare.mjs --agent <agent-id> [--out <path>]`

**Behavior:**

1. Run `processSandboxes({ agentId, frictionConfigPath: 'config/friction.json' })` to ensure baseline `.friction.json` files exist.
2. Run `processSandboxes({ agentId, frictionConfigPath: 'config/friction-stress.json' })` to ensure `.friction-stress.json` files exist.
3. For each sandbox running the agent, glob both file types.
4. Match by base filename. Unmatched (skipped under one config but not the other) → appended to `unmatched[]`.
5. For matched pairs, compute baseline_pl, stress_pl, delta, flip (sign change).
6. Aggregate per agent: totals, flips array, per-asset-class breakdown.
7. Write `data/reports/friction_stress_<agent>_<YYYYMMDD>.json` (or `--out` path) atomically.

**Output schema:**

```json
{
  "agent": "default",
  "as_of": "2026-05-18T14:00:00Z",
  "baseline_config_hash": "abc12345",
  "stress_config_hash": "def67890",
  "totals": {
    "trade_count": 47,
    "baseline_pl_usd": 1240.50,
    "stress_pl_usd": -85.20,
    "total_delta_usd": -1325.70,
    "median_per_trade_delta_usd": -28.15
  },
  "flips": [
    { "symbol": "QQQ260515C00712000", "timestamp": "2026-05-11T...",
      "baseline_pl": 87.0, "stress_pl": -12.3 }
  ],
  "per_asset_class": {
    "single_leg_options": { "trade_count": 18, "baseline_pl": 920, "stress_pl": -210, "flips": 5 },
    "stocks": { "trade_count": 24, "baseline_pl": 320, "stress_pl": 125, "flips": 0 }
  },
  "unmatched": []
}
```

#### 4. `/stress-test-friction` skill (new)

User-initiated. Steps:

1. Resolve agent — if no arg, iterate all 4 agents.
2. Generate report via `scripts/friction-stress-compare.mjs` if missing or stale (>24h).
3. Read report, present human-readable summary with per-asset-class verdict using the codified flip-rate thresholds below.
4. **Never modify any config or strategy file.** Diagnostic-only.

**Flip-rate verdict thresholds (codified to keep skill output consistent across runs):**

```
flip_rate = flips_in_category / matched_trade_count_in_category

  flip_rate < 0.05   → "durable"     ("edge survives worst-case fills")
  0.05 ≤ flip_rate < 0.20  → "marginal"   ("edge thins under stress; tighten entry filters")
  flip_rate ≥ 0.20   → "thin"        ("edge does not survive worst-case fills; reconsider before live deployment")

  matched_trade_count_in_category == 0 → "n/a (no trades in window)"
```

Without codified thresholds, the same data could yield differently-worded verdicts across runs depending on prompt-by-prompt interpretation. Encoding the thresholds in the skill ensures the same numbers always produce the same verdict.

Example output:

```
Stress test for agent `default` — 47 trades
  Baseline total adjusted P&L:  +$1,240
  Stress total adjusted P&L:    -$85    (Δ -$1,325, median -$28/trade)

Trades that flip from winner to loser under stress: 5 of 18 option trades
  - QQQ260515C00712000 (2026-05-11): +$87 → -$12
  - ... (4 more)

Per-asset-class verdict:
  single_leg_options: 5 of 18 flip — edge is thin
  stocks:             0 of 24 flip — edge is durable
  iron_condor:        n/a (no trades in window)

Interpretation: option strategy may not survive worst-case fills. Consider
either tightening entry filters or testing in smaller size before live deployment.
```

### Item #5 — Significance gate

#### 1. `scripts/significance-gate.mjs`

**Invocation:** `cat <adapt-set-json-array> | node scripts/significance-gate.mjs [--min-losses N] [--min-drawdown D]`

Defaults: `--min-losses 5`, `--min-drawdown 0.05`.

**Logic:**

```
gateForCategory(trades, params):
  losses = trades.filter(t => t.market_data.friction_adjusted_pl < 0)
  losing_pl_abs = |sum of losses' friction_adjusted_pl|

  # Gross dollar exposure denominator (per-asset formulas — see table above)
  WING_WIDTH_BY_UNDERLYING = { SPY: 5, QQQ: 5, IWM: 2, GLD: 2, TLT: 1 }

  exposure_per_trade(t):
    profile = t.friction_meta.profile_applied
    if profile == "iron_condor":
        wing_width = t.market_data.wing_width
                  ?? WING_WIDTH_BY_UNDERLYING[underlying_from_symbol(t.symbol)]
                  ?? (t.market_data.entry_price * 10)   # fallback, log stderr
        return |wing_width × t.market_data.size × 100|
    elif profile == "single_leg_options":
        return |t.market_data.entry_price × t.market_data.size × 100|
    else:  # stocks or penny_stocks
        return |t.market_data.entry_price × t.market_data.size|
  gross_exposure = max(sum of exposure_per_trade for all trades in category, 1.0)

  drawdown_pct = losing_pl_abs / gross_exposure

  cleared = losses.length >= params.min_losing_trades
         OR drawdown_pct >= params.min_drawdown_pct

  return {
    category: <profile_applied>,
    trade_count: trades.length,
    losing_count: losses.length,
    drawdown_pct,
    threshold: params,
    cleared,
    reason: cleared ? null : `${losses.length} losses, ${(drawdown_pct*100).toFixed(2)}% dd — below ${params.min_losing_trades} losses OR ${params.min_drawdown_pct*100}% dd`
  }

evaluateGate(adaptSetTrades, params):
  by_class = group trades by friction_meta.profile_applied
  return {
    overall_trade_count: adaptSetTrades.length,
    by_category: { stocks: gateForCategory(...), single_leg_options: gateForCategory(...), iron_condor: ..., penny_stocks: ... },
    cleared_categories: [...],
    blocked_categories: [...]
  }
```

**Drawdown denominator choice:**

Gross dollar exposure (Σ exposure_per_trade) rather than starting account equity. Reasoning: equity-denominated drawdown ties the gate to account size, making the same trade pattern clear the gate in one sandbox and fail in another. Gross-exposure measures damage-per-dollar-deployed, which is the actually-relevant quantity for "does this signal warrant a rule change?" Capped at minimum of $1 to avoid divide-by-zero on empty categories.

**Per-asset exposure formulas:**

| profile_applied | exposure_per_trade |
|---|---|
| `stocks`, `penny_stocks` | `|entry_price × size|` |
| `single_leg_options` | `|entry_price × size × 100|` (long-premium; max loss = premium paid) |
| `iron_condor` | `wing_width × size × 100` where `wing_width` resolves in this order: (1) `market_data.wing_width` if present, (2) symbol-table lookup from the underlying ticker — `{SPY:5, QQQ:5, IWM:2, GLD:2, TLT:1}` matching `TRADING_RULES_HARVEST.md`, (3) fallback `entry_price × size × 100 × 10` (crude — emit a stderr warning when this path is hit). |

**Why the IC formula matters:** the buying-power requirement and worst-case loss for a defined-risk credit spread is the wing width, not the credit collected. A $0.50 credit on a $5-wide SPY IC has max loss `($5 − $0.50) × 100 = $450` per contract, not $50 per contract. Using credit-as-exposure under-counts true exposure by ~10x, which would let a single losing IC trip the 5% drawdown gate trivially and clear it for trivial losses. The wing-width formula gives the gate something meaningful to fire on.

**Implementation note (out of scope for this spec):** the Go agent should be asked to write `wing_width` (and `theoretical_credit`) into `market_data` when Harvest opens an IC. That's a future Go change; the symbol-table fallback covers current Harvest semantics in the meantime.

**Trades with `profile_applied` missing or `unknown` (legacy / raw-pl-fallback):**

Assigned to an `unknown` bucket. The `unknown` bucket never clears the gate by design — these trades shouldn't drive rule changes since we don't know what asset class they represent.

#### 2. Asset-class tagging of proposals

The adapt skill, after generating a proposal, must explicitly tag it with one or more asset-class categories. Heuristic table (skill-side, prompt instructions):

| Proposal text contains | Tagged as |
|---|---|
| "iron condor" / "IC" / "4-leg" / "credit spread" | `iron_condor` |
| "option" / "call" / "put" / "DTE" / "delta" / OCC strike format | `single_leg_options` |
| "penny" / explicit sub-$5 ticker mention | `penny_stocks` |
| "stock" / "equity" / share-count language / common ticker mention | `stocks` |
| Affects all positions equally (e.g., "max concurrent positions ≤10") | All currently-traded categories in the adapt set |

For each proposal: if ALL its tagged categories cleared the gate, allow it. If any tagged category is blocked, suppress the proposal and log an explicit skip message.

#### 3. Combined verdict in Step 6.6

Each proposal display now includes three signals:

```
SIGNIFICANCE GATE: PASSED — single_leg_options (8 losses, 7.2% drawdown)
HOLD-OUT VERDICT:  APPROVED-BY-HOLDOUT — trades_affected: 3 — net_pl_delta_usd: +$145
REGIME WARNING:    none
FINAL:             APPROVED — both gates cleared
```

`FINAL` precedence (first matching rule wins, evaluated top-down):

1. SIGNIFICANCE=BLOCKED → proposal never generated, no display.
2. HOLD-OUT=REJECTED → `FINAL: NEEDS-OVERRIDE` — user can still apply with explicit confirmation in Step 8.
3. REGIME WARNING present (regardless of HOLD-OUT outcome other than REJECTED) → `FINAL: NEEDS-OVERRIDE`.
4. HOLD-OUT=INCONCLUSIVE → `FINAL: INCONCLUSIVE` — user decides as normal.
5. SIGNIFICANCE=PASSED AND HOLD-OUT=APPROVED-BY-HOLDOUT AND no REGIME WARNING → `FINAL: APPROVED`.

**Rationale for the asymmetry:** INCONCLUSIVE-with-warning is treated as structurally weaker evidence than plain INCONCLUSIVE. Both share the noise-floor problem (too few affected trades to distinguish signal from noise), but a regime-skewed inconclusive additionally fails the generalization test — the proposal's evidence is concentrated in a regime that may not recur. The override path exists for the user to apply anyway when they have outside context (e.g., "I know option premium is structurally too low this quarter regardless of regime"). This asymmetry is intentional, not an oversight.

## Skill Markdown Edits

Each step below is described by its *logical position* in the existing skill flow, since the existing skills have slightly different step numbering. The plan will translate to concrete step numbers per skill:

| Logical position | adapt-strategy / adapt-strategy-penny / harvest-parameter-review | trend-parameter-review |
|---|---|---|
| Build regime history | Step 0.5 | Step 0.5 (between existing Step 0 and Step 1) |
| Join regime label | inline in Step 3 | inline in Step 2b |
| Regime composition in announcement | Step 3.5 (extends existing) | Step 3.5 (extends existing) |
| Significance gate | Step 4.5 (NEW) | Step 5.5 (NEW — between gap analysis and proposal generation) |
| Skip blocked categories | Step 6 (extends existing) | Step 6 (extends existing) |
| Pass `--regime-history` to scorer | Step 6.5 (extends existing) | Step 7.5 (extends existing) |
| Combined verdict | Step 6.6 (extends existing) | Step 7.6 (extends existing) |

### Step 0.5 — Build regime history (NEW, after Step 0 friction)

> After the friction post-processor completes, run `node scripts/build-regime-history.mjs --from <oldest-trade-date> --to <today>`. Report its `as_of` and date `range` to the user. If the script exits non-zero, continue but tag every trade `regime: "unknown"` and warn that regime composition and `regime_warning` will be unavailable this run.

### Step 3 extension — Join regime label

> For each loaded `.friction.json`, convert `action.timestamp` to America/New_York timezone (use `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(...)` to extract `YYYY-MM-DD`), then look up in `regime_history.labels`. Holiday/weekend dates and late-ET trades that would tip into the next UTC day: walk back up to 5 calendar days for the previous trading day's label. Still missing → `regime: "unknown"`.
>
> **TZ-conversion rationale:** raw `action.timestamp` is UTC. A trade at 21:00 ET (5pm ET in winter) is `02:00Z` the next day. Using UTC date directly would tag it with tomorrow's regime (frequently a weekend → walk back to today, which works) but a 21:00 ET trade on a Thursday becomes Friday in UTC and would tag with Friday's regime instead of Thursday's. The ET conversion makes the tag deterministic and tied to the actual session date.

### Step 3.5 extension — Regime composition in announcement

> Add to the existing adapt/hold-out announcement:
>
> > Adapt set regime composition: X% bull-trend, Y% chop, Z% bear-trend, W% unknown
> > Hold-out set regime composition: …
>
> If any single regime ≥70% in the adapt set, append:
>
> > ⚠️ Adapt set is heavily skewed to \<regime\>; findings may not generalize.

### Step 4.5 — Significance gate (NEW, between Step 4 and Step 5)

> Pipe the adapt set as a JSON array on stdin to `node scripts/significance-gate.mjs`. Read the per-category result. Display a table:
>
> ```
> Category            Trades  Losses  Drawdown  Gate
> stocks                  24       8     7.2%   ✓ PASSED
> single_leg_options      18       3     1.8%   ✗ BLOCKED
> iron_condor              0       0      n/a   —
> ```
>
> Categories with `cleared: false` will NOT receive proposals in Step 6. Surface this explicitly to the user before continuing. Record the gate result in conversation state for use in Step 6.

### Step 6 extension — Proposal generation skips blocked categories

> For each gap from Step 5, identify which asset-class category(ies) it pertains to using the tagging table. If ALL tagged categories cleared the significance gate, generate the proposal normally. Otherwise, log:
>
> > Gap [N] skipped — proposal would affect category \<X\> which did not clear significance gate.

### Step 6.5 extension — Pass `--regime-history` AND `--adapt-set-distribution` to scorer

> When invoking `score-rule-against-holdout.mjs` for mechanical predicates, add both:
> - `--regime-history data/reports/regime_history.json`
> - `--adapt-set-distribution '<json>'` where `<json>` is the adapt-set regime composition computed in Step 3.5 (e.g., `{"bull-trend":0.62,"chop":0.27,"bear-trend":0.09,"unknown":0.02}`)
>
> The envelope may now contain `regime_warning` (proposal over-indexes a regime by ≥25pp relative to adapt set) or `regime_warning_skipped` (`trades_affected < 5`). Capture both for Step 6.6.

### Step 6.6 extension — Combined verdict

> Update verdict block to display all three signals (significance, hold-out, regime warning) and a FINAL line. FINAL is APPROVED only when SIGNIFICANCE=PASSED AND HOLD-OUT=APPROVED-BY-HOLDOUT AND no REGIME WARNING.

### `/stress-test-friction` skill (new)

New file `.claude/skills/stress-test-friction/SKILL.md`. Steps drafted in plan; key shape covered in Item #4 above.

### `review-performance` and `review-performance-penny`

Get only the Step 0.5 regime build and the regime composition announcement in their data-loading step. No gate, no scorer integration, no hold-out logic — those are adapt-only.

## Data Flow Summary

Per `/adapt-strategy` (or any of the 4 adapt variants):

1. Step 0 — apply-friction (unchanged).
2. **Step 0.5 (NEW)** — build-regime-history (idempotent cache).
3. Step 1–3 — load `.friction.json`, **join regime label by trade-date**.
4. Step 3.5 — adapt/hold-out split; **announcement now includes regime composition**.
5. Step 4 — P&L context (unchanged).
6. **Step 4.5 (NEW)** — significance gate per asset class; record gate status.
7. Step 5 — gap analysis (unchanged).
8. Step 6 — proposal generation, **skipping blocked categories**.
9. Step 6.5 — hold-out validation; scorer **also returns `regime_warning`** when affected trades are regime-concentrated ≥70%.
10. Step 6.6 — **combined verdict (significance + hold-out + regime warning + FINAL)**.
11. Step 7–8 — present, confirm, apply (unchanged except verdict semantics).

## Testing

`node:test` (per workflow preference).

### `scripts/build-regime-history.test.mjs`

- Classifier — bull-trend: SPY > 50DMA AND 20D return > 0 → `bull-trend`.
- Classifier — bear-trend: SPY < 50DMA AND 20D return < 0 → `bear-trend`.
- Classifier — chop: any other combination → `chop`.
- Cache reuse: existing `regime_history.json` with covering range, `as_of` after most recent session close + 1h, matching classifier version, no `--force-rebuild` → no FMP call, exit 0.
- Cache rebuild: range gap → fetch and rewrite.
- Cache rebuild: `as_of` before most recent session close + 1h → fetch and rewrite (covers the "built at 10am, re-run at 5pm" intra-day staleness case).
- Cache rebuild: classifier version mismatch → fetch and rewrite.
- Cache rebuild: `--force-rebuild` flag → fetch and rewrite regardless of other freshness signals.
- Session-close logic: fixture clock at 10am ET on a trading day → most-recent-close is yesterday 4pm ET. At 5pm ET → today 4pm ET. On Sunday → last Friday 4pm ET.
- Holiday backfill: requested date is a weekend → consumer (skill or scorer) walks back to previous trading day, verified via direct fixture lookup.
- FMP failure: missing API key → exit code 3 with clear message.
- FMP failure: network error → exit code 4.
- Malformed data: NaN close → exit code 5.
- Atomic write: simulate crash mid-write; partial `.tmp` cleaned up.

### `scripts/apply-friction.test.mjs` (extension)

- `--config <path>` CLI flag routes to specified config.
- `output_suffix` in config controls output filename (`friction` → `.friction.json`, `friction-stress` → `.friction-stress.json`).
- Baseline call (no flag, no `output_suffix`) → still writes `.friction.json` (back-compat).
- `loadFrictionConfig` accepts optional `output_suffix` string field; rejects non-string.

### `scripts/score-rule-against-holdout.test.mjs` (extension)

- `--regime-history` + `--adapt-set-distribution` flags: parsed and applied correctly.
- `regime_warning` emitted when `trades_affected ≥ 5` AND some regime over-indexed by ≥25pp vs adapt-set baseline.
- `regime_warning` omitted when over-index < 25pp (data and proposal are similarly skewed).
- `regime_warning_skipped: "insufficient_sample"` when `trades_affected < 5`.
- `regime_warning` omitted when `--regime-history` or `--adapt-set-distribution` not provided.
- `regime_warning` omitted when `trades_affected == 0`.
- `unknown` regime trades excluded from both numerator (affected count) and denominator (baseline).
- Holiday backfill: trade on Saturday gets Friday's regime label after walking back.
- **TZ-aware date join:** trade with timestamp `2026-05-15T21:00:00.000Z` (Friday 5pm ET) → `2026-05-15` (Friday).
- **TZ-aware date join:** trade with timestamp `2026-05-16T01:00:00.000Z` (Friday 9pm ET in summer DST) → `2026-05-15` (Friday) via ET conversion, NOT 2026-05-16 → walked back.

### `scripts/friction-stress-compare.test.mjs`

- Totals: hand-calculated fixture; baseline + stress sums match expected.
- Delta: stress − baseline equals expected on every matched pair.
- Flip detection: `(baseline > 0) !== (stress > 0)` correctly identifies sign change.
- Per-asset-class breakdown: mixed-asset fixture aggregates correctly.
- **Matched-count symmetry (defensive):** on a fixture where every trade has full `market_data`, matched count under baseline equals matched count under stress AND equals total trade count. `unmatched[]` is empty. Document via test that non-empty `unmatched[]` indicates a code bug (asset-class detection diverging between configs), not a normal data condition — apply-friction's detection logic doesn't depend on config values.
- Unmatched handling (failure surface): when a fixture is forced to produce diverging coverage (mock the detector to return null under one config), `unmatched[]` lists the affected trade with reason.
- Idempotency: running twice produces identical content (modulo `as_of`).
- Atomic write of report.

### `scripts/significance-gate.test.mjs`

- gateForCategory: 5 losses, low drawdown → CLEARED (losses gate).
- gateForCategory: 2 losses, 6% drawdown → CLEARED (drawdown gate).
- gateForCategory: 3 losses, 2% drawdown → BLOCKED (neither gate).
- gateForCategory: 5 losses, 6% drawdown → CLEARED (both gates).
- Gross-exposure denominator (stocks): entry_price × size.
- Gross-exposure denominator (single_leg_options): entry_price × size × 100.
- **Gross-exposure denominator (iron_condor) — explicit `wing_width`:** trade with `market_data.wing_width: 5.0` and size 2 → exposure 1000 per trade.
- **Gross-exposure denominator (iron_condor) — symbol-table lookup:** SPY IC with no explicit `wing_width` → falls back to table value 5.
- **Gross-exposure denominator (iron_condor) — fallback path:** unknown underlying, no `wing_width` → uses `entry_price × size × 100 × 10` and emits a stderr warning.
- **Significance gate fires correctly for IC:** an IC with $500 max-loss losing $100 represents 20% loss-on-exposure — clears the 5% drawdown gate. The OLD entry-price denominator would have shown $50 exposure and a 200% loss, trivially clearing. Test ensures the new formula gives the right answer.
- Empty category → BLOCKED with explicit reason.
- evaluateGate: trades grouped by `friction_meta.profile_applied` correctly.
- evaluateGate: trade with missing `profile_applied` → `unknown` bucket, BLOCKED.
- CLI: `--min-losses` and `--min-drawdown` override defaults.

### Integration / regression

- All existing tests continue to pass (run the full `npm test` suite at each phase boundary; the count grows with each phase's new test files).
- **Defensive `processSandboxes` test (already added in this branch in `apply-friction.test.mjs`):** stale pre-existing `.friction.json` is always overwritten by `processSandboxes`. This dead-ends any future reviewer concern about "old friction files without `profile_applied` blocking the significance gate" — the design assumes friction files are regenerated every adapt run.
- `adapt-strategy` SKILL.md and friends — sanity check that file-level grep for each new step heading returns exactly one match.

## Error Handling

| Scenario | Behavior |
|---|---|
| `build-regime-history.mjs` exits non-zero | Skill warns, tags every trade `regime: "unknown"`, continues. Regime composition shows 100% unknown. `regime_warning` never appears. |
| `regime_history.json` malformed | Same as above; scorer treats as missing. |
| `friction-stress.json` missing | `/stress-test-friction` skill exits with clear message. Adapt skills unaffected (don't read stress config). |
| `friction-stress.json` malformed | Same as baseline: fail loud via `loadFrictionConfig`. |
| `significance-gate.mjs` malformed input | Exit code 6, clear message naming bad record. Skill continues but flags all categories as BLOCKED (defensive). |
| Adapt set has zero trades in a category | That category is BLOCKED with reason "no trades". Other categories proceed normally. |
| Hold-out has zero trades | Existing behavior preserved: predicate verdict INCONCLUSIVE. No regime warning. |

## File Layout

(See "High-Level Architecture" above for full layout.)

## Limitations and Honest Caveats

1. **3-bucket SPY-only classifier is still crude even with the slope tiebreaker.** A genuinely two-sided volatile market (large moves up and down within the same week) gets labeled by the dominant 20-day return rather than the volatility itself. Adding VIX or a vol-spike overlay is mechanical when needed.
2. **Classifier may disagree with `macro-regime-detector` skill.** They use different inputs and different taxonomies. This is by design — the on-the-fly classifier is for reproducible trade-tagging across history, not macro analysis.
3. **Heuristic asset-class tagging of proposals can misfire.** Some rules genuinely span asset classes ("no entries on FOMC day"). The catch-all rule ("affects all currently traded") is conservative — proposal blocked unless ALL tagged categories clear. May be too strict in edge cases; tune as we observe.
4. **Significance gate is "category-local" but proposals can have cross-category effects.** A "max concurrent positions = 8" rule affects every category but is tagged with whichever is currently traded. If only options are traded but a stock category opens later, the rule still applies. Documented in tagging table.
5. **Iron-condor exposure depends on `wing_width` being either written by Harvest or derivable from a symbol table.** If Harvest later trades a non-table underlying (e.g., adds SLV to the universe) without writing `wing_width` to `market_data`, the fallback path applies a crude 10x multiplier on entry price and emits a stderr warning. Production tuning: ask the Go agent to write `wing_width` and `theoretical_credit` into `market_data` (small follow-up, not gating this spec).
6. **Three new failure modes during adapt runs** (FMP outage, regime cache corruption, stress-config malformed). Each fails-soft into a clearly-tagged degraded mode rather than blocking the whole adapt cycle.
7. **Stress test is read-only.** It doesn't feed into the adapt verdicts — a strategy can fail stress and still pass hold-out and get APPROVED. A future "stress hold-out verdict" extension would tighten this further.
8. **REGIME WARNING only annotates, never auto-rejects.** At current sample size, auto-rejection would be too restrictive. Revisit if trade counts grow.
9. **`regime_warning` requires `trades_affected ≥ 5` to fire.** Below this floor, the affected/baseline comparison is itself too noisy to be reliable, so the envelope emits `regime_warning_skipped: "insufficient_sample"` instead. This means many small-sample proposals (typical at current hold-out size of 12-15 trades) won't get a regime signal at all — explicit absence of signal is more honest than a misleading false positive.

## Out of Scope (Explicit YAGNI)

- VIX-overlay regime classifier (3-bucket SPY-only at v1).
- Stress-tested hold-out scoring (a separate stress hold-out verdict).
- Backfilling `macro_regime_*.json` snapshots.
- Per-strategy threshold overrides (single global default for the significance gate at v1).
- Statistical hypothesis test in place of the drawdown gate.
- FMP response caching across runs of `build-regime-history.mjs` (single SPY-history call per rebuild is cheap).
- Auto-rejection on REGIME WARNING (annotation only at v1).
- Extracting the asset-class tagging table into config (skill-prompt table is small and rarely edited).
- Surfacing regime composition in `review-performance` skills *as a gating signal* (informational only at v1).
- Bringing the Go agent into the loop for live regime tagging at trade time (out of scope; classifier here is post-hoc).
- Asking Harvest to write `wing_width` and `theoretical_credit` into `market_data` for iron condors (small Go-side follow-up that would let us drop the symbol-table fallback; tracked as a separate task).
