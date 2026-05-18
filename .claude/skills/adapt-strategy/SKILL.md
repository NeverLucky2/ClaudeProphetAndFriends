---
name: adapt-strategy
description: Analyze recent trading performance across every sandbox running the Prophet agent (`default`), identify what rules are drifting or broken, and propose + apply targeted edits to whatever strategy that agent currently points at. This is the primary learning loop — run it weekly or after any bad stretch.
allowed-tools: Read Glob
---

You are closing the learning loop for the Prophet trading agent. Your job is to read what the agent actually did, compare it to what the strategy says it should do, find the gaps, and propose concrete rule changes — then apply the ones the user approves.

## Step 0 — Apply friction to raw trade data

Before reading any trade data, run:

`node scripts/apply-friction.mjs --agent default`

Report the resulting `{ processed, skipped, sign_flips, skip_reasons }` stats to the user. **If `skipped` exceeds 10% of `processed + skipped`, warn the user that the adapt set may be biased and offer to abort.**

All subsequent data loading reads `*.friction.json` files in each sandbox's `decisive_actions/` directory, NOT the raw `*.json` files. **All P&L-derived metrics (win rate, average win/loss, profit factor) MUST use `market_data.friction_adjusted_pl`. If that field is absent on a record, fall back to the original P&L field and tag the record in any output as "raw-pl-fallback".**

## Step 1 — Resolve target agent, strategy, and sandboxes

This skill targets the **`default`** agent (name "Prophet"). Sandboxes are resolved by agent — never by sandbox name. Activity from every sandbox running this agent is aggregated so the strategy is tuned against the full history.

1. Read `data/agent-config.json`.
2. In `agents[]`, find the entry with `id === 'default'` (fallback: `name` containing `"Prophet"` case-insensitive, excluding `"PennyProphet"` and `"TrendProphet"`). Take its `strategyId` — this is the strategy this skill will edit.
3. In `strategies[]`, find the entry with that `id`. Extract `id`, `name`, and the full `customRules` text. State the strategy name + id in one line before continuing — this is the ground truth you will be editing.
4. Iterate `sandboxes` (object map). Keep every entry whose `agent.activeAgentId === 'default'`. For each kept entry, record `(name, accountId)`. Call this list `<PROPHET_DIRS>`.
5. If `<PROPHET_DIRS>` is empty, stop and tell the user: "No sandbox currently uses agent `default`. Assign it to a sandbox first." Do not proceed.

State the resolved sandbox list (sandbox name → accountId directory) before continuing. Steps 3 and 4 below glob across **every** directory in `<PROPHET_DIRS>` and merge results.

## Step 3 — Load recent decisions (last 30 days, all Prophet sandboxes)

For each `<DIR>` in `<PROPHET_DIRS>`: glob `data/sandboxes/<DIR>/decisive_actions/*.friction.json`. Merge all matched files into one list, sort by file mtime descending, read the **75 most recent overall** (not 75 per sandbox). If fewer than 75 `.friction.json` files exist across all sandboxes, use what's available; if fewer than 20 exist in total, warn the user explicitly that adaptation may be premature on this little data and offer to abort. For each, extract:
- `timestamp`
- `sandboxId` (record which directory it came from — useful for gap analysis if a pattern is sandbox-specific)
- `action` (BUY / SELL / HOLD / etc.)
- `symbol`
- `reasoning` (full text)

## Step 3.5 — Split into adapt set and hold-out set

Sort all loaded decisions by timestamp ascending. Compute `holdout_size = ceil(N × 0.20)` where N is the number of loaded decisions. The **adapt set** is the oldest `N − holdout_size` decisions; the **hold-out set** is the newest `holdout_size`.

State both counts and date ranges to the user explicitly, plus symbol concentration:

> Adapting on N1 decisions (date1 → date2). Holding out N2 decisions (date3 → date4) for validation.
> Adapt-set top 3 symbols: SYM1 (X%), SYM2 (Y%), SYM3 (Z%).
> Hold-out-set top 3 symbols: SYM1 (X%), SYM2 (Y%), SYM3 (Z%).

**Gap analysis (Step 5) and proposal generation (Step 6) use ONLY the adapt set.** Do not peek at the hold-out set during these steps — it is reserved for Step 6.5 validation.

## Step 4 — Load recent P&L context (all Prophet sandboxes)

For each `<DIR>` in `<PROPHET_DIRS>`: glob `data/sandboxes/<DIR>/activity_logs/activity_*.json`. Read the **8 most recent per sandbox**. From each `summary`:
- winning_trades, losing_trades, total_pnl, largest_win, largest_loss
- Tag the row with its sandbox name

Compute aggregate profit factor across all loaded days from all sandboxes combined. Also note per-sandbox profit factor — large divergences (one sandbox profitable, another deeply red) are themselves a finding worth surfacing in Step 5.

## Step 5 — Gap analysis

For each section of the strategy rules, ask: does the agent's actual behavior match the rule?

Work through these categories:

**Entry discipline**
- Are positions being sized within 15%?
- Are scalps truly ≤5 DTE?
- Are swing positions in the 50–120 DTE / delta 0.40–0.70 band?
- Is the agent using limit orders? (Look for "limit" vs. absence of it in reasoning)

**Exit discipline**
- Are losers being cut at -15%? Or are stops being moved?
- Are scalps being closed EOD?
- Are profits being taken at +25–50%?

**Loss-review protocol**
- After a bad stretch, does the agent pause entries and run stats?
- Is it re-entering same symbols within 2 hours (revenge trading)?

**Position concentration**
- Any sector exceeding 40%?
- More than 10 simultaneous positions?

**Behavioral drift**
- Reasoning that sounds emotional ("hoping", "giving it more time", "should bounce")
- Thesis changes mid-hold without acknowledging the shift

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

```
echo '<HOLDOUT_JSON_ARRAY>' | node scripts/score-rule-against-holdout.mjs --predicate <name> --params '<params>'
```

Capture the returned envelope including `verdict`, `trades_affected`, `net_pl_delta_usd`, and any `limitation_notes`.

For each qualitative edit, read the hold-out trades and write a one-paragraph judgment citing specific held-out trades by symbol and timestamp. Emit a parallel envelope with `review_type: "qualitative"` and a `verdict` of APPROVED-BY-HOLDOUT, REJECTED-BY-HOLDOUT, or INCONCLUSIVE based on your judgment.

**Once hold-out data has been read in this step, no new proposals may be generated in the same skill invocation.** If the user wants to propose alternatives after seeing hold-out verdicts, that requires a new skill run with a fresh trade window. This prevents hold-out information from leaking into proposal generation.

## Step 6.6 — Attach hold-out verdicts to proposals

For each proposal, attach a verdict block to its display:

> **HOLD-OUT VERDICT:** APPROVED-BY-HOLDOUT — `review_type: mechanical` — trades_affected: 3 — net_pl_delta_usd: +$145
> Limitations: (any `limitation_notes` from the scorer)
> ⚠️ A 12-15 trade hold-out is a sanity check, not a hypothesis test.

Application rules to apply in Step 8:
- **APPROVED-BY-HOLDOUT**: user-approved proposals applied normally.
- **REJECTED-BY-HOLDOUT**: requires explicit user override before being applied.
- **INCONCLUSIVE**: user decides as normal — most proposals will land here at current sample size. Do not auto-reject or auto-approve.

## Step 7 — Present and confirm

Show the user all proposed edits clearly. Ask which ones to apply. Do not modify any file until the user confirms specific edits.

## Step 8 — Apply approved edits

For each approved edit:
1. Re-read `data/agent-config.json` to get the freshest version.
2. In the `strategies` array, find the entry by **the `id` you resolved in Step 1** (do NOT look up by name — names can drift, the id is the link from the agent to the strategy).
3. Edit `customRules` — replace the old rule text with the new rule text exactly as proposed. Preserve all surrounding content.
4. Update `updatedAt` on the strategy entry to now (ISO string).
5. Write the file back.

After all edits are applied, show the final diff of what changed in the strategy's `customRules`. Remind the user the changes take effect on the next heartbeat of **every** sandbox using agent `default` — all of them share this strategy.
