---
name: adapt-strategy-penny
description: Analyze recent PennyProphet trading performance, identify what penny-momentum rules are drifting or broken, and propose + apply targeted edits to the Penny Stock Momentum strategy. This is the primary learning loop for PennyProphet — run it weekly or after any bad stretch.
allowed-tools: Read Glob
---

You are closing the learning loop for the PennyProphet trading agent. Your job is to read what the agent actually did, compare it to what the strategy says it should do, find the gaps, and propose concrete rule changes — then apply the ones the user approves.

## Step 0 — Apply friction to raw trade data

Before reading any trade data, run:

`node scripts/apply-friction.mjs --agent penny-prophet`

Report the resulting `{ processed, skipped, sign_flips, skip_reasons }` stats to the user. **If `skipped` exceeds 10% of `processed + skipped`, warn the user that the adapt set may be biased and offer to abort.**

All subsequent data loading reads `*.friction.json` files in each sandbox's `decisive_actions/` directory, NOT the raw `*.json` files. **All P&L-derived metrics (win rate, average win/loss, profit factor) MUST use `market_data.friction_adjusted_pl`. If that field is absent on a record, fall back to the original P&L field and tag the record in any output as "raw-pl-fallback".**

## Step 0.5 — Build regime history

After the friction post-processor completes, run:

`node scripts/build-regime-history.mjs --from <YYYY-MM-DD of oldest loaded trade> --to <today YYYY-MM-DD>`

Report the returned `{ action, path }` to the user. If the script exits non-zero (FMP key missing, network error), continue but tag every trade `regime: "unknown"` during trade loading and warn the user that regime composition and `regime_warning` will be unavailable this run.

## Step 1 — Resolve target agent, strategy, and sandboxes

This skill targets the **`penny-prophet`** agent (name "PennyProphet"). Sandboxes are resolved by agent — never by sandbox name. Activity from every sandbox running this agent is aggregated so the strategy is tuned against the full history.

1. Read `data/agent-config.json`.
2. In `agents[]`, find the entry with `id === 'penny-prophet'` (fallback: `name` matching `/penny/i`). Take its `strategyId` — this is the strategy this skill will edit (expected: `penny-momentum`).
3. In `strategies[]`, find the entry with that `id`. Extract `id`, `name`, and the full `customRules` text. State the strategy name + id in one line before continuing — this is the ground truth you will be editing.
4. Iterate `sandboxes` (object map). Keep every entry whose `agent.activeAgentId === 'penny-prophet'`. For each kept entry, record `(name, accountId)`. Call this list `<PENNY_DIRS>`.
5. If `<PENNY_DIRS>` is empty, stop and tell the user: "No sandbox currently uses agent `penny-prophet`. Assign it to a sandbox first." Do not proceed.

State the resolved sandbox list (sandbox name → accountId directory) before continuing. Steps 3 and 4 below glob across **every** directory in `<PENNY_DIRS>` and merge results.

6. **Determine the current epoch.** Build the input for `scripts/resolve-current-epoch.mjs`:
   - `markers`: for each `<DIR>` in `<PENNY_DIRS>`, read `data/sandboxes/<DIR>/.current_strategy_version.json` if it exists; collect the objects.
   - `newestStampedVersion`: pass `null` here — markers are the primary source and are already available from this step. ONLY if the result returns `source: "config-inferred"` AND Step 3 later loads at least one trade carrying a `strategyVersion`, re-run this step with that trade's `strategyVersion` as `newestStampedVersion` before proceeding to Step 3.4.
   - `configVersion`: resolve the strategy's current rules with `resolveStrategyRules` (from `scripts/strategy-version.mjs`) and hash with `computeStrategyVersion`.

   Pipe that JSON to `node scripts/resolve-current-epoch.mjs`. Record the returned `currentVersions` (call it `CURRENT_VERSIONS`), `source`, `consistencyWarning`, and `divergent`. Also read the strategy's `updatedAt` (may be absent) for the Step 3.4 fallback.

   State to the user:
   > Current ruleset: `<CURRENT_STRATEGY_ID>` @ `<CURRENT_VERSIONS>` (source: `<source>`; updatedAt: `<updatedAt|none>`).

   If `consistencyWarning` is non-null, surface it prominently (the config has an un-deployed edit; loaded trades reflect the running rules). If `divergent` is true, note that sandboxes are running different rulesets. If `source === 'none'` (no marker, no stamped trades, config rules empty), stop — there is nothing coherent to adapt toward.

## Step 3 — Load recent decisions (last 30 days, all Penny sandboxes)

For each `<DIR>` in `<PENNY_DIRS>`: glob `data/sandboxes/<DIR>/decisive_actions/*.friction.json`. Merge all matched files into one list, sort by file mtime descending, read the **100 most recent overall** (not 100 per sandbox). If fewer than 100 `.friction.json` files exist across all sandboxes, use what's available; if fewer than 20 exist in total, warn the user explicitly that adaptation may be premature on this little data and offer to abort. For each, extract:
- `timestamp`
- `sandboxId` (record which directory it came from — useful for spotting sandbox-specific drift)
- `action` (BUY / SELL / HOLD / SKIP / CIRCUIT_BREAKER / etc.)
- `symbol`
- `reasoning` (full text)
- Any `details` fields containing `composite_score`, `dominant_signal`, `position_size_pct`, `stop_pct`, `target_pct`
- `strategyId` and `strategyVersion` (both may be absent on pre-stamp records)

Penny generates more decisions per day than Prophet, so 100 files across one sandbox typically covers ~2–4 weeks. Across multiple sandboxes it'll be tighter; that's fine — recency matters more than depth.

**Join regime label:** After loading each `.friction.json`, also load `data/reports/regime_history.json` (if Step 0.5 succeeded). For each trade, convert `action.timestamp` to America/New_York using `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(timestamp))` and look up the date in `regime_history.labels`. If the date is a weekend/holiday or otherwise missing, walk back up to 5 calendar days for the previous trading day's label. Still missing → tag the trade `regime: "unknown"`. Add the resolved label as a top-level `regime` field on each loaded record.

## Step 3.4 — Epoch segmentation

Pipe the loaded trades (JSON array) on stdin to `scripts/segment-by-epoch.mjs` (e.g. `echo '<TRADES_JSON>' | node scripts/segment-by-epoch.mjs ...`) with flags:

```
node scripts/segment-by-epoch.mjs --current-versions <CURRENT_VERSIONS joined by commas> --updated-at <updatedAt or omit> --min-current 20 [--min-current-override <N> only if the user explicitly opts in]
```

Read `recommended_case` and act:

- **Case 1 (single epoch):** proceed to Step 3.5 on the **full** loaded set, unchanged.
  > Single ruleset across all N loaded trades. Proceeding normally.
- **Case 2 (straddled, enough current-epoch data):** proceed to Step 3.5 on `current_epoch_set` only.
  > ⚠️ Window straddles a rule change. Adapting on `counts.current` current-epoch trades. Dropped `drop.dropped` of `drop.total` (`drop.pct` is a fraction — render as a percent via `drop.pct × 100`, e.g. 0.333 → 33.3%). Hold-out drawn only from the current epoch.
  > If `counts.unknown > counts.prior` (the drop is mostly pre-stamp `unknown`, not a prior epoch): "Most dropped trades are pre-stamp `unknown` — expected this soon after epoch-stamping rollout, not a bug."
- **Case 3 (too little current-epoch data):** run Step 5 gap analysis for information, then **STOP — emit no proposals** (skip Steps 6-8).
  > 🛑 Only `counts.current` trades under the current ruleset; need ≥20. You are `trades_needed` short. If `rate_per_day` is non-null, append "at ~`rate_per_day`/day that's ≈ `eta_days` days"; if `rate_per_day` is null (fewer than 2 current-epoch trades), omit the rate/ETA clause entirely. To escape sooner: iterate less often, or re-run with `--min-current-override <N>` for low-confidence proposals.

Always print the breakdown prominently: `current=<counts.current>, prior=<counts.prior>, unknown=<counts.unknown>` and the `stamped_vs_fallback` split. If `mixed_provenance` is true, warn: "Mixed-provenance window — un-stamped labels are heuristic and may disagree with stamped neighbors near the boundary." If `override_applied`, tag every resulting proposal **low-confidence**.

**Steps 5-6 operate ONLY on the set Step 3.4 forwards** (full set in Case 1, `current_epoch_set` in Case 2).

## Step 3.5 — Split into adapt set and hold-out set

Operate on the set forwarded by Step 3.4 (the full loaded set in Case 1, or `current_epoch_set` in Case 2). Step 3.5 is not reached in Case 3. The 80/20 split, significance gate, and hold-out scorer are otherwise unchanged — they now receive a single-epoch set, so the hold-out is guaranteed the same ruleset as the adapt set.

Sort all loaded decisions by timestamp ascending. Compute `holdout_size = ceil(N × 0.20)` where N is the number of loaded decisions. The **adapt set** is the oldest `N − holdout_size` decisions; the **hold-out set** is the newest `holdout_size`.

State both counts and date ranges to the user explicitly, plus symbol concentration:

> Adapting on N1 decisions (date1 → date2). Holding out N2 decisions (date3 → date4) for validation.
> Adapt-set top 3 symbols: SYM1 (X%), SYM2 (Y%), SYM3 (Z%).
> Hold-out-set top 3 symbols: SYM1 (X%), SYM2 (Y%), SYM3 (Z%).

> Adapt set regime composition: X% bull-trend, Y% chop, Z% bear-trend, W% unknown
> Hold-out set regime composition: …

If any single regime ≥70% in the adapt set, append:

> ⚠️ Adapt set is heavily skewed to <regime>; findings may not generalize.

Compute the adapt-set regime distribution as an object `{ "bull-trend": 0.X, "chop": 0.Y, "bear-trend": 0.Z, "unknown": 0.W }` (proportions summing to 1.0) and **record it in conversation state** as `ADAPT_SET_REGIME_DISTRIBUTION` — Step 6.5 will pass this to the scorer.

**Gap analysis (Step 5) and proposal generation (Step 6) use ONLY the adapt set.** Do not peek at the hold-out set during these steps — it is reserved for Step 6.5 validation.

## Step 4 — Load recent P&L context (all Penny sandboxes)

For each `<DIR>` in `<PENNY_DIRS>`: glob `data/sandboxes/<DIR>/activity_logs/activity_*.json`. Read the **7 most recent per sandbox**. From each `summary`:
- winning_trades, losing_trades, total_pnl, largest_win, largest_loss
- capital_deployed (segment-cap utilization)
- positions_opened, positions_closed
- Tag the row with its sandbox name

Compute aggregate profit factor across all loaded days from all sandboxes combined. Also note per-sandbox profit factor — large divergences (one sandbox profitable, another deeply red) are themselves a finding worth surfacing in Step 5.

## Step 4.5 — Significance gate (per asset class)

Pipe the **adapt set** (NOT the hold-out) as a JSON array on stdin to:

```
node scripts/significance-gate.mjs
```

Defaults: `min_losing_trades = 5`, `min_drawdown_pct = 0.05`. Override via `--min-losses` / `--min-drawdown` if the user requests.

Read the per-category result. Display this table to the user:

```
Category            Trades  Losses  Drawdown  Gate
stocks                  N1      L1     dd1%   ✓ PASSED / ✗ BLOCKED
single_leg_options      N2      L2     dd2%   ...
iron_condor             N3      L3     dd3%   ...
penny_stocks            N4      L4     dd4%   ...
```

For BLOCKED categories, also display the gate's `reason` string.

**Record the per-category gate result in conversation state as `SIGNIFICANCE_GATE`.** Step 6 will use this to decide which proposals are allowed.

## Step 5 — Gap analysis

For each section of the strategy rules, ask: does the agent's actual behavior match the rule?

Work through these penny-specific categories:

**Composite-score discipline**
- Are entries gated at composite score ≥ 60? Look for any BUY where `composite_score` in details is < 60 or unstated.
- Are sub-60 candidates being silently entered ("score was 58 but momentum looked strong")?

**Tiered position sizing**
- Score ≥ 80: position size 5–7% of portfolio?
- Score 60–79: position size 2–3% of portfolio?
- Hard cap 8% of portfolio in any single penny position — any breaches?
- Are tier boundaries being respected, or is sizing converging to a single default size regardless of score?

**`place_managed_position` usage with stop+target pre-set**
- Every entry must use `place_managed_position` with both stop and target. Search for any entries that used `place_order` / market entry without bracket protection, or where the bracket failed and the agent still entered.

**Signal-type-correct stops/targets**
Read `dominant_signal` from each entry's details and confirm the stop/target match:
- `social`: stop −8%, target +15% (50% scale) then +20% (remainder)
- `regulatory`: stop −10%, target +20% day 1, trailing from day 2
- `technical`: stop −7%, target +14% (1R), trail to breakeven at +7%

Flag any entry where stop or target deviates from the rule for that dominant signal.

**Social-signal time-window discipline**
- Social entries must be exited within 20 minutes of entry (or 15 min before close, whichever is first), per the cancel-bracket-then-market-sell protocol.
- Are any social positions being held past the 20-minute window?
- Are social entries being placed within 30 minutes of market close (forbidden)?

**Daily circuit breaker enforcement**
- Was portfolio P&L ≤ −5% intraday on any logged day? If so, did the agent cancel brackets, market-sell all penny positions, and cease new entries for the rest of the session?
- Any entries after a circuit-breaker trip?

**Segment cap (30% of portfolio in penny)**
- Was capital_deployed_in_penny > 30% at any point? If so, were further entries skipped?
- Are entries being skipped with `segment_cap_reached` reasoning, or is the cap being breached?

**Position concentration / count**
- More than 10 simultaneous penny positions?
- Multiple positions on the same ticker (correlated re-entry)?

**Behavioral drift / improvisation**
PennyProphet's rules explicitly forbid "helpful improvisation". Look for:
- Reasoning that overrides exit rules ("position looks like it might recover")
- Reasoning that overrides entry filters ("score is 58 but candidate looks promising")
- Suggestions about its own rules during a session
- Free-form market commentary that goes beyond logging the rule applied

For each gap you find, write:
> **Gap [N]**: [category] — [what the rule says] vs. [what the agent actually did, with timestamp and quote]

## Step 6 — Propose specific rule edits

For each significant gap (ignore one-offs; focus on patterns appearing 2+ times), propose a rule change using this format:

---
**Proposed Edit [N]** — [Category]

**Current rule:**
> [exact quote from customRules]

**Proposed replacement:**
> [your revised text]

**Rationale:** [1–2 sentences explaining what behavior this fixes and what evidence from the decision log supports it]

---

If a gap suggests adding a *new* rule rather than changing an existing one, say so explicitly and write the full new rule text.

**Asset-class tagging + significance gate check (NEW):** Before emitting each proposed edit, tag it with one or more asset-class categories based on its rule text:

| Proposal text contains | Tagged as |
|---|---|
| "iron condor" / "IC" / "4-leg" / "credit spread" | `iron_condor` |
| "option" / "call" / "put" / "DTE" / "delta" / OCC strike format | `single_leg_options` |
| "penny" / explicit sub-$5 ticker mention | `penny_stocks` |
| "stock" / "equity" / share-count language / common ticker mention | `stocks` |
| Affects all positions equally (e.g., "max concurrent positions ≤10") | All currently-traded categories in the adapt set |

If ALL tagged categories have `cleared: true` in `SIGNIFICANCE_GATE.by_category`, emit the proposal normally. Otherwise, do NOT emit the proposal — instead log:

> Gap [N] skipped — proposal would affect category `<X>` which did not clear significance gate (`<reason>`).

## Step 6.5 — Validate proposed edits against hold-out (READ-ONLY, NO ITERATION)

For each proposed edit from Step 6, classify it as **mechanical** (the rule maps to a supported predicate) or **qualitative** (everything else).

**Mechanical predicates currently supported:**

| Rule shape | Predicate name | Params |
|---|---|---|
| Position size ≤ X% | `max_position_size_pct` | `{ "limit": X }` |
| Stop at -X% | `stop_at_pct` | `{ "stop": -X }` |
| Max N concurrent positions | `max_concurrent_positions` | `{ "limit": N }` |
| No re-entry within N hours | `no_reentry_within_hours` | `{ "hours": N }` |
| DTE between min and max | `dte_bounds` | `{ "min": M, "max": X }` |

For each mechanical edit, invoke the scorer (pipe the hold-out set as a JSON array on stdin):

`echo '<HOLDOUT_JSON_ARRAY>' | node scripts/score-rule-against-holdout.mjs --predicate <name> --params '<params>' --regime-history data/reports/regime_history.json --adapt-set-distribution '<ADAPT_SET_REGIME_DISTRIBUTION_JSON>'`

The returned envelope may now contain a `regime_warning` field (when affected trades over-index a regime by ≥25pp vs adapt-set baseline) or `regime_warning_skipped: "insufficient_sample (need >= 5 affected trades; have N)"`. Capture both for Step 6.6.

Capture the returned envelope including `verdict`, `trades_affected`, `net_pl_delta_usd`, and any `limitation_notes`.

For each qualitative edit, read the hold-out trades and write a one-paragraph judgment citing specific held-out trades by symbol and timestamp. Emit a parallel envelope with `review_type: "qualitative"` and a `verdict` of APPROVED-BY-HOLDOUT, REJECTED-BY-HOLDOUT, or INCONCLUSIVE based on your judgment.

**Once hold-out data has been read in this step, no new proposals may be generated in the same skill invocation.** If the user wants to propose alternatives after seeing hold-out verdicts, that requires a new skill run with a fresh trade window. This prevents hold-out information from leaking into proposal generation.

## Step 6.6 — Attach hold-out verdicts to proposals

For each proposal, attach a combined verdict block:

```
SIGNIFICANCE GATE: PASSED — <category> (<losses> losses, <drawdown>% dd)
HOLD-OUT VERDICT:  <APPROVED-BY-HOLDOUT|REJECTED-BY-HOLDOUT|INCONCLUSIVE> — review_type: <mechanical|qualitative> — trades_affected: <N> — net_pl_delta_usd: <±$X>
REGIME WARNING:    <"<text>"|none|"insufficient_sample (need >= 5 affected trades; have N)">
FINAL:             <APPROVED|NEEDS-OVERRIDE|INCONCLUSIVE>
```

**FINAL precedence (first matching rule wins, evaluated top-down):**

1. If SIGNIFICANCE GATE = BLOCKED → proposal was never generated, no verdict block.
2. If HOLD-OUT VERDICT = REJECTED-BY-HOLDOUT → `FINAL: NEEDS-OVERRIDE` (user can apply with explicit confirmation).
3. If REGIME WARNING is present (not "none" and not "insufficient_sample") → `FINAL: NEEDS-OVERRIDE`.
4. If HOLD-OUT VERDICT = INCONCLUSIVE → `FINAL: INCONCLUSIVE`.
5. Otherwise (SIGNIFICANCE=PASSED, HOLD-OUT=APPROVED, no regime warning) → `FINAL: APPROVED`.

Application rules in Step 8:
- `APPROVED`: applied if the user approves it in Step 7.
- `NEEDS-OVERRIDE`: user must explicitly confirm before it is applied.
- `INCONCLUSIVE`: user decides as normal.

## Step 7 — Present and confirm

Show the user all proposed edits clearly. Ask which ones to apply. Do not modify any file until the user confirms specific edits.

## Step 8 — Apply approved edits

For each approved edit:
1. Re-read `data/agent-config.json` to get the freshest version.
2. In the `strategies` array, find the entry by **the `id` you resolved in Step 1** (do NOT look up by name — names can drift, the id is the link from the agent to the strategy).
3. Edit `customRules` — replace the old rule text with the new rule text exactly as proposed. Preserve all surrounding content.
4. Update `updatedAt` on the strategy entry to now (ISO string).
5. Write the file back.

After all edits are applied, show the final diff of what changed in the strategy's `customRules`. Remind the user the changes take effect on the next heartbeat of **every** sandbox using agent `penny-prophet` — all of them share this strategy.

Note: `TRADING_RULES_PENNY.md` is a stale read-only mirror with a deprecation header. Do NOT edit it — the inline `customRules` in `data/agent-config.json` is the live source of truth.
