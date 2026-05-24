---
name: hindsight-review
description: Read-only hindsight report on the session's biggest movers across Prophet's tradable floor — classifies each into coverage/timing/discipline/rules-silent/unforeseeable buckets, estimates foregone P&L from rule-violations only, and (in --scorecard mode) renders a self-retiring KEEP/REVIEW/RETIRE verdict. Prophet only. Pass a date (YYYY-MM-DD), --days N, or --scorecard [--weeks N]. Never edits rules.
allowed-tools: Read Glob Bash
---

You are producing a **read-only** hindsight review for the Prophet trading agent. You never edit a strategy and never invent a new trading signal. The only "could we have caught it" question you ask is *would Prophet's current, already-deployed rules have fired* — measured only on mechanically-checkable conditions. Spec: `docs/superpowers/specs/2026-05-24-hindsight-review-design.md`.

**Input:** `$ARGUMENTS` — a date `YYYY-MM-DD` (target session), or `--days N`, or `--scorecard [--weeks N] [--no-review]`. Empty → the most recent completed trading session.

## Step 0 — Resolve scope by agent (always first)

1. Read `data/agent-config.json`.
2. In `agents[]`, find `id === 'default'` (fallback: name containing `"Prophet"`, excluding `"PennyProphet"`/`"TrendProphet"`). Note its `strategyId`.
3. In `strategies[]`, find that id; extract `customRules` — the rulebook you measure against. **Never** hardcode rules.
4. Iterate `sandboxes`, keep every entry where `agent.activeAgentId === 'default'`. Collect `accountId`s as `<PROPHET_DIRS>`. If empty, stop and tell the user no sandbox uses agent `default`.
5. Read the tradable floor: `config/prophet_tradable_universe.txt` (the universe is whatever this file says — never a hardcoded list).
6. Note the always-surfaced intraday watchlist from `agent/harness.js` (`PROPHET_INTRADAY_WATCHLIST`). These names are auto-pushed into every heartbeat, so they are "seen" at every heartbeat.

State the resolved sandbox list, the floor size, and the watchlist before continuing.

## --scorecard mode (branch here if `--scorecard` is present)

Run: `node scripts/hindsight-scorecard.mjs --weeks <N default 4>` (append `--no-review` if the user passed it).

Report the printed `verdict` and `conditions` verbatim, then translate for the user:
- `INSUFFICIENT_DATA` → "Not enough data yet (need ≥15 sessions and ≥8 discipline findings). Keep observing — no clone/retire decision."
- `KEEP_STRONG` → "A hindsight-sourced change survived the hold-out. Proven value — safe to clone per the §7 gate."
- `KEEP_PROVISIONAL` → "Costly AND systematic (cost >25% of realized P&L and a ≥3× recurring finding). Worth acting on; clone candidate."
- `REVIEW` → "Qualifies for keep, but the foregone cost leans on `none-found` discipline gaps (catalyst-recall risk). Spot-check those findings before trusting the keep." List the `discipline_gap` findings with `catalyst: none-found` so the user can eyeball them.
- `RETIRE` → "No edge demonstrated. Do not clone; retire the feature on Prophet."

Then STOP — `--scorecard` produces no per-session report.

## Step 1 — Determine the target session and rank movers

Resolve the target date: explicit `YYYY-MM-DD`, or the most recent completed session (you may reuse the trading-day logic the repo uses elsewhere; weekends/NYSE holidays are not sessions). For `--days N`, repeat Steps 1–5 per day and aggregate the reports.

Run: `node scripts/rank-floor-movers.mjs --date <YYYY-MM-DD>` and read the JSON (`movers_ranked`, `missing`, `off_floor_forbidden_winners`, `floor_size`). If it exits non-zero (e.g. `FMP_API_KEY` unset), stop and tell the user — there is no report without mover data.

Focus the analysis on the **biggest movers** — the top of `movers_ranked` by `|move_pct|`. A reasonable default is moves with `|move_pct| ≥ 4%`, owner-tunable; if none clear the bar, say so and write an empty-but-honest report.

## Step 2 — Load what the agent saw

For each `<DIR>` in `<PROPHET_DIRS>`: glob `data/sandboxes/<DIR>/decisive_actions/*.json` (the raw files — you need the `market_data` snapshots and timestamps) and the day's `activity_logs/activity_<date>.json`. Merge across sandboxes; tag each record with its sandbox.

For each big mover, gather every `decisive_actions` record that day whose `symbol` equals the mover OR whose `market_data`/`reasoning` mentions it. Record each such record's **timestamp**.

## Step 3 — Classify each big mover into exactly one bucket (spec §5.1)

Let **T** = the time the mechanically-checkable entry conditions were first met that session (Step 4 computes the verifiable conditions; T is the earliest moment they held). A mover with no such T cannot be a discipline gap.

- **coverage_gap (1a)** — a *non-watchlist* floor name with **no** `market_data`/`reasoning` mention all session. The agent never looked.
- **timing_gap (1b)** — the agent's only eyes-on the name predates T (its snapshots/mentions are all before T) and there's no evidence it looked again at/after T. Watchlist names rarely land here (re-surfaced every heartbeat). Accrues **no** foregone cost.
- **discipline_gap (2)** — the agent had eyes on the name **at or after T** (a watchlist name automatically qualifies via the heartbeat covering T; a non-watchlist name needs a snapshot timestamp ≥ T), the verifiable entry conditions were met, and it did not open. **Only this bucket accrues foregone cost.**
- **rules_silent (3)** — seen, but the verifiable entry conditions were never met. Not a miss.
- **unforeseeable (4)** — attributed to (or, per §5.5, *suspected* from) news not knowable at T. Takes precedence over bucket 2.

## Step 4 — Verifiable conditions + base rate + foregone P&L (spec §5.2–5.4)

For each candidate discipline_gap:
- Replay **only** mechanically-checkable conditions present in the data (within floor, RVOL/VWAP/spread thresholds, DTE/delta where applicable). **State explicitly** which conditions you could and could not verify. Never claim the agent's judgment would have said yes; if the only "fire" rests on unverifiable judgment, downgrade to rules_silent with a note.
- **Base-rate denominator (mandatory):** count how many *other* floor names showed the same verifiable setup that session and what happened to them. No computable denominator → suppress the discipline-gap claim entirely.
- **Foregone P&L (bias-free):** entry at T's price; exit at the **rule-defined** target/stop/EOD — **never the realized high/low**; size per the rule; then haircut with the friction model (reuse the logic in `scripts/apply-friction.mjs`; if unavailable tag `raw-pl-fallback`).

## Step 5 — Catalyst attribution + the §5.5 recall firebreak

Attribute each big mover's cause using the `catalyst-news` / `analyst-actions` skill outputs for the date. Then apply §5.5:
- If `none-found` **and** the move is dominated by an opening gap or a single bar (≈ ≥½ of the day's move in one discontinuity) → reclassify to **unforeseeable** (`catalyst: "suspected-unfound"`, `move_shape: "gap"|"single-bar"`). No foregone cost.
- If `none-found` **and** the move is continuous → keep as discipline_gap but set `catalyst_checked: true, catalyst: "none-found"`. Its cost is tracked separately as catalyst-unverified by the scorecard.

## Step 6 — Write the report and the ledger

Write the human report (sections per spec §6.1: Session movers table with bucket per name; Coverage gaps 1a+1b; Discipline gaps with verifiable-conditions, eyes-on-vs-T evidence, base rate, foregone P&L; Rules-silent brief; Unforeseeable with catalyst cited; **Off-floor forbidden winners — a passive curation log only**; Suggested follow-ups referencing finding `id`s). Never propose rule text.

Write the machine ledger to `data/reports/hindsight/hindsight_<YYYY-MM-DD>.json` per the spec §6.2 schema. Each `movers_ranked` entry gets a stable `id` of `"<date>:<symbol>"`, its `bucket`, `trigger_time_et`, `eyes_on_at_or_after_T`, `eyes_on_source`, `verifiable_conditions`, `base_rate`, and (discipline_gap only) `foregone_pl_usd`, `foregone_pl_basis`, `catalyst_checked`, `catalyst`, `move_shape`, `routed_to_adapt_strategy: false`, `routed_outcome: null`. Plus top-level `coverage_gaps_never_looked`, `timing_gaps`, `off_floor_forbidden_winners`, `missing`. Create the `data/reports/hindsight/` directory if absent.

`routed_to_adapt_strategy` / `routed_outcome` are the **only** fields a human edits later (when they route a finding to `/adapt-strategy` and learn whether it survived the hold-out). The scorecard reads `routed_outcome === "survived-holdout"` for the KEEP_STRONG path.

## Step 7 — Close

Remind the user: this report changed nothing. To act on a finding, route it to `/adapt-strategy` (which still applies its own hold-out + significance gate), then set that finding's `routed_outcome` in the ledger so the scorecard can credit it.
