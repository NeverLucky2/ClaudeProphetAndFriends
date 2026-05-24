# Adapt-Strategy Epoch-Conditional Split — Design Spec

**Date:** 2026-05-23
**Status:** Approved for planning
**Scope:** Make `adapt-strategy` (and its mirror `adapt-strategy-penny`) learn only from trades generated under the *current* ruleset. Consumes the per-trade stamp from Spec A; falls back to a `strategies[].updatedAt` heuristic (this is the "B" idea, documented here) for un-stamped trades.
**Depends on:** `docs/superpowers/specs/2026-05-23-trade-ruleset-epoch-stamp-design.md` (Spec A — produces the per-trade `strategyVersion` stamp **and** the per-agent current-version marker C reads as its source of truth). C functions without A by degrading to a config recompute + `updatedAt` heuristic, but is only *drift-resistant and precise* once A's marker and stamps exist.

## Problem

`adapt-strategy` splits a loaded window of decisions chronologically — oldest 80% to adapt, newest 20% to hold out — then proposes rule edits from the adapt set and validates them against the hold-out. The integrity of that hold-out depends on adapt and hold-out trades coming from the **same data-generating process**. A mid-window rule change breaks that assumption: the adapt set is mostly old-ruleset behavior, the hold-out is current-ruleset behavior, and verdicts compare apples to oranges while looking clean.

The skill currently has no concept of which ruleset produced a trade. It treats a wall-clock window as one homogeneous population.

## Goals

1. Label each loaded trade with its ruleset epoch (current vs prior vs unknown).
2. When the window spans more than one epoch, never learn from anything but the current epoch.
3. When there is too little current-epoch data to adapt safely, stand down (review only, no proposals) rather than curve-fit to a handful of trades.
4. Preserve today's exact behavior in the common steady-state case (single epoch).
5. Make the skill's notion of "current epoch" track **what the running agent is actually stamping** (read from Spec A's marker file), not what `agent-config.json` happens to imply at adapt-run time. Editing config between an agent's start and an adapt run must NOT silently reclassify valid current-epoch trades as `prior`.

## Non-Goals

- **No new behavior in the single-epoch case.** When all loaded trades are current epoch, the split, significance gate, hold-out scorer, and regime logic are byte-for-byte unchanged.
- **No change to the significance gate, friction layer, regime history, or hold-out scorer.** They simply receive a cleaner (single-epoch) input set.
- **No epoch gating in `review-performance`.** Labeling its report by epoch is a recommended follow-up, explicitly out of scope here (this spec covers only the adapt loop, which is where proposals — the dangerous output — are generated).
- **No auto-application.** Straddle handling changes *which* proposals are generated; the existing Step 7 user-confirmation gate is untouched.

## High-Level Architecture

Edits to two skill files, plus one small extension to Spec A's shared module so the skill can recompute the current hash exactly as the harness did.

```
scripts/
  strategy-version.mjs            (extend: also export resolveStrategyRules(agentConfig, strategy, {readFile}))
  strategy-version.test.mjs       (extend: resolver cases + parity)
  segment-by-epoch.mjs            (NEW — labels trades, returns counts, recommended case, mixed-provenance
                                    flag, drop accounting, and Case-3 rate/ETA; honors --min-current override)
  segment-by-epoch.test.mjs       (NEW — table-driven policy tests)

agent/
  harness.js                      (refactor: buildSystemPrompt uses the shared resolveStrategyRules,
                                    so harness and skill share ONE resolution+hash path)

.claude/skills/adapt-strategy/SKILL.md         (edit: Step 1, Step 3, NEW Step 3.4, Step 3.5)
.claude/skills/adapt-strategy-penny/SKILL.md   (edit: mirror the same Step 1 / 3 / 3.4 changes)
```

Segmentation is a piped script, not inline skill prose — matching the established pattern (`significance-gate.mjs`, `score-rule-against-holdout.mjs`). This keeps the skill markdown thin (pipe trades in, read the recommended case, act) and makes the entire epoch policy unit-testable.

### Source of truth: the marker, not a recompute

The naive design recomputes `CURRENT_VERSION` from `agent-config.json` at adapt-run time. That has a catastrophic failure mode: if config was edited between the running agent's start and the adapt run, the recomputed version matches **no** trade's stamp, so every valid current-epoch trade labels `prior` — routing the skill into Case 2/3 (drop data / stand down) exactly when there is plenty of good current-epoch data. And because labeling keyed off the recompute, the failure is total and silent.

So the **source of truth for `CURRENT_VERSION` is Spec A's marker file** — `data/sandboxes/<accountId>/.current_strategy_version.json`, which records the version the live agent is actually stamping. Labeling keys off the marker + the per-trade stamps. The config recompute is demoted to a **consistency check** (does config imply the same version the agent is running?) and a last-resort fallback. This structurally removes the catastrophic mode: a config edit can no longer flip the whole epoch, because labeling never depended on re-deriving from config.

### Why the resolver is still extracted

The recompute path (consistency check + last-resort fallback) must produce a version *comparable* to the marker/stamps, so it has to resolve and hash rules **identically** to the harness. Resolution therefore moves into Spec A's shared module as `resolveStrategyRules(agentConfig, strategy, { readFile })` — same four sources, same order — and `buildSystemPrompt` is refactored to call it. This is the only place C reaches into A's files; it is an extraction, not a rewrite. Its role is narrower now (powering the consistency warning), so a drift here degrades the *warning's* accuracy, not the core labeling.

## Detailed Design — `adapt-strategy/SKILL.md`

### Step 1 (addition) — determine the current epoch

`CURRENT_VERSION` is resolved by this precedence, **not** by recomputing from config:

1. **Marker (source of truth):** read `data/sandboxes/<accountId>/.current_strategy_version.json` for each sandbox in `<PROPHET_DIRS>`. Use its `strategyVersion`. This is the version the live agent is actually stamping.
2. **Newest stamped trade (fallback):** if no marker exists (older harness, agent not currently running), use the `strategyVersion` of the most recent stamped trade in the loaded window.
3. **Config recompute (last resort):** if neither exists (pre-Spec-A, nothing stamped), resolve current rules via `resolveStrategyRules` and `computeStrategyVersion`, and **warn** that `CURRENT_VERSION` is inferred from config and may not match what any trade was stamped with.

Record `CURRENT_STRATEGY_ID` and read the strategy's `updatedAt` (may be `undefined`) for the un-stamped `updatedAt` fallback in Step 3.4.

**Consistency check (catches un-deployed edits):** independently recompute the config-implied version via `resolveStrategyRules` + `computeStrategyVersion`. If it differs from the marker's `CURRENT_VERSION`, the config has been edited but not yet redeployed (the change takes effect on the next heartbeat). Surface this prominently:

> ⚠️ Config implies version `<config_version>` but the running agent is still stamping `<CURRENT_VERSION>`. You have an un-deployed rule change. The trades below reflect the **running** rules; findings may not transfer to the edited rules. Deploy the change (restart / next heartbeat), let trades accumulate, then adapt — or proceed knowing you're adapting the *running* ruleset, not the edited one.

State to the user:

> Current ruleset: `<CURRENT_STRATEGY_ID>` @ version `<CURRENT_VERSION>` (source: marker | newest-trade | config-inferred; last updatedAt: `<updatedAt|none>`).

**Multi-sandbox divergence:** when several sandboxes run this agent, their markers can differ (one started before a rule edit, one after). Treat **every** live-marker version as `current`, and surface the divergence as a finding ("sandboxes are running divergent rulesets: …") — it is itself worth the user's attention.

If `CURRENT_VERSION` cannot be resolved by any of the three means (no marker, no stamped trades, and config yields `null` rules) — abort with a clear message; there is nothing coherent to adapt toward.

### Step 3 (addition) — load the stamp fields

When loading each `*.friction.json` record, also read `strategyId` and `strategyVersion` (both may be absent on pre-Spec-A records).

### Step 3.4 (NEW) — Epoch segmentation

Pipe the loaded trades (JSON array on stdin) plus `CURRENT_VERSION`, `CURRENT_STRATEGY_ID`, and the strategy's `updatedAt` (flags) to `scripts/segment-by-epoch.mjs`. It labels every trade, returns `{ labeled[], counts: {current, prior, unknown}, stamped_vs_fallback: {...}, recommended_case: 1|2|3, current_epoch_set[] }`. The skill reads `recommended_case` and acts. Insert between load (Step 3) and split (Step 3.5).

**Per-trade epoch label (implemented inside `segment-by-epoch.mjs`):**

1. **Primary (stamped):** if `trade.strategyVersion` is present → `current` iff it is in the set of live-marker versions (`CURRENT_VERSION`, plus any divergent sibling-sandbox markers), else `prior`.
2. **Fallback (un-stamped) — the "B" heuristic:** if `trade.strategyVersion` is absent, compare `trade.timestamp` to the current strategy's `updatedAt`:
   - `updatedAt` present **and** `trade.timestamp ≥ updatedAt` → `current`.
   - `updatedAt` present **and** `trade.timestamp < updatedAt` → `prior`.
   - `updatedAt` **absent** → `unknown`.

> **B's known blind spots (stated for honesty):** `updatedAt` is bumped only by `adapt-strategy` itself. Manual edits to `agent-config.json` and edits to an external `rulesFile` do **not** move it, so a trade made under hand-edited rules can be mislabeled `current`. This is acceptable only as a transitional fallback for trades that predate Spec A's stamps; stamped trades are never subject to it.
>
> **The two mechanisms can actively disagree, not merely differ in precision.** Spec A's `strategyVersion` *does* detect a `rulesFile` edit (it hashes resolved text); the `updatedAt` fallback is blind to it. So if a `rulesFile` edit lands mid-window, the stamped trades correctly split into two epochs while the un-stamped trades all get lumped by the timestamp heuristic — a window can simultaneously hold stamped-`current`, stamped-`prior`, and fallback-mislabeled trades. When a straddled window contains both stamped and un-stamped trades, `segment-by-epoch.mjs` flags **"mixed-provenance window — un-stamped labels are heuristic and may disagree with stamped neighbors near the boundary."** This self-heals as stamps replace the un-stamped backlog, but during the transition the disagreement is real, not cosmetic.

Compute counts: `cur` (current), `prior`, `unknown`.

**Straddle policy:**

| Case | Condition | Behavior |
|---|---|---|
| **1. Single-epoch** | `prior == 0` and `unknown == 0` | **Unchanged.** Proceed to Step 3.5 with the full loaded set, exactly as today. |
| **2. Straddled, enough data** | (`prior > 0` or `unknown > 0`) and `cur ≥ 20` | Filter the universe to `current`-epoch trades only. Drop `prior` and `unknown` from both adapt and hold-out. Proceed to Step 3.5 on the filtered subset. |
| **3. Straddled, too little data** | `cur < 20` | **Observation mode.** Run Step 5 gap analysis for the user's information but generate **no proposals** (skip Steps 6–8). |

The `20` floor reuses `adapt-strategy`'s existing "fewer than 20 → adaptation may be premature" threshold, re-targeted from the raw count to the **current-epoch** count.

**Known interaction (deliberate, surfaced — not silently smoothed):** the old threshold gated on *total* trades, which is easy to clear; re-targeting it to *current-epoch* trades is a much stiffer gate during active iteration. Right after any rule change, `cur` is near zero (Case 3), and it takes 20 same-epoch trades to escape observation mode — for a low-frequency agent, possibly weeks. Changing rules again before 20 accumulate resets `cur` to zero, so rapid iteration can park the skill in Case 3 indefinitely. **This is mostly working as intended:** adapting on <20 same-ruleset trades is exactly the overfitting the hold-out machinery exists to prevent, so Case 3 firing is the system honestly reporting "you're iterating faster than you can measure." The default floor stays conservative. Two mitigations make it non-punishing rather than a dead end:

- The Case 3 message is **actionable** (reports the gap to the threshold, the recent trade rate, and an ETA — see below).
- An explicit opt-in override (`--min-current <N>`, or a typed confirmation) lets the user generate proposals on a thinner current-epoch set. Such proposals are tagged **low-confidence**; the hold-out validation still runs on whatever current-epoch data exists. Default behavior is unchanged; the override is never implicit.

**Mandatory user-facing report from Step 3.4:**

- Case 1:
  > Single ruleset across all N loaded trades (version `<CURRENT_VERSION>`). Proceeding normally.
- Case 2:
  > ⚠️ Window straddles a rule change. Adapting on `cur` current-epoch trades (date1 → date2). **Dropped `prior` prior-epoch + `unknown` unknown-epoch (= M of N total, P%).** Hold-out will be drawn only from the current epoch.
  >
  > When the dropped fraction is large (common soon after Spec A ships, when most of the window predates stamping), append: *"Most dropped trades are `unknown` (pre-stamp); this is expected this soon after epoch-stamping rollout, not a bug."* — so a near-total drop never reads as a failure.
- Case 3:
  > 🛑 Only `cur` trades under the current ruleset (version `<CURRENT_VERSION>`); need ≥20 to adapt safely. Showing read-only gap analysis; **no proposals this run.**
  > You are `20 − cur` trades short. At the recent rate (`<R>` current-epoch trades/day over the last `<W>` days) that's ≈ `<ETA>` days. To escape sooner: iterate on the rules less often, or re-run with `--min-current <N>` to force low-confidence proposals on the thin set.

Always also print the raw breakdown prominently: `current=cur, prior=prior, unknown=unknown`, plus the stamped-vs-fallback split (how many labels came from a real stamp vs the `updatedAt` heuristic), so the user can judge how much to trust the segmentation and see at a glance whether a large drop is `unknown` (expected) or `prior` (a real rule change).

### Step 3.5 (change) — split consumes the filtered subset

The chronological 80/20 split now runs on the Step 3.4 output set (full set in Case 1; current-epoch subset in Case 2; not reached in Case 3). Everything downstream — symbol-concentration report, regime composition, significance gate (Step 4.5), proposal generation (Step 6), hold-out scoring (Step 6.5) — is unchanged and simply receives a single-epoch set.

**The deeper win:** because the split operates on one epoch, the hold-out (newest 20%) is guaranteed to be the same ruleset as the adapt set. Train and test finally share one data-generating process — the integrity property the hold-out machinery was always meant to provide.

## Mirror — `adapt-strategy-penny/SKILL.md`

Apply the identical Step 1 / Step 3 / Step 3.4 / Step 3.5 changes to the penny skill, so PennyProphet does not silently retain the cross-epoch bug. Same shared module, same policy, same thresholds. Mechanical duplication; called out explicitly so it is not forgotten.

## Testing

Current-epoch resolution (the part that actually prevents the catastrophic failure):

- **Post-mutation (the important one):** stamp a set of trades with version X; write a marker with version X; then mutate `agent-config.json` to imply version Y; run resolution. Assert `CURRENT_VERSION` resolves to **X** (from the marker), the X-stamped trades stay `current` (NOT reclassified `prior`), and the consistency check **warns** about the un-deployed edit. This is the test that pins Goal 5.
- **Marker precedence:** marker present → used; marker absent but stamped trades present → newest stamped version used; neither → config recompute used and the "inferred" warning fires.
- **Multi-sandbox divergence:** two markers with different versions → both treated as `current`; divergence surfaced.

Shared module (cheap regression guards, no longer the critical path):

- **Parity:** for an identical agent+strategy config, `computeStrategyVersion(resolveStrategyRules(...))` equals the harness's stamp. Now a guard against someone re-implementing resolution in the skill or skipping a rule source — its failure degrades the *consistency warning*, not core labeling.
- **Resolver:** correct source precedence (`customStrategyRules` ▸ `customRules` ▸ `rulesFile` ▸ `TRADING_RULES.md`); reads `rulesFile` via injected `readFile`.

Segmentation + policy (`segment-by-epoch.test.mjs`, table-driven):

- Stamped trade with matching version → `current`; differing version → `prior`.
- Un-stamped + `updatedAt` present, timestamp after → `current`; before → `prior`.
- Un-stamped + `updatedAt` absent → `unknown`.
- **Case 1** (all current): downstream receives the full set unchanged; proposals can be generated.
- **Case 2** (`prior>0`, `cur≥20`): downstream receives only current-epoch trades; `prior`/`unknown` excluded from both adapt and hold-out.
- **Case 3** (`cur<20` with straddle): no proposals emitted; gap analysis still produced; message includes gap-to-threshold, recent rate, and ETA.
- **Case 3 + override** (`--min-current` set below `cur`): proposals ARE emitted, tagged low-confidence; hold-out still runs.
- **Mixed-provenance flag:** a straddled window containing both stamped and un-stamped trades sets the mixed-provenance warning; an all-stamped or all-un-stamped window does not.
- **Case 2 drop accounting:** report includes dropped count, total, and percentage; the "expected post-rollout" note fires when the dropped majority is `unknown` rather than `prior`.
- Report strings include the `current/prior/unknown` breakdown and the stamped-vs-fallback split.

## Rollout & Interaction with Spec A timing

The day Spec A ships there are **zero** stamped trades, so C runs almost entirely on the `updatedAt` fallback (B), and `CURRENT_VERSION` comes from the marker (or, until an agent has restarted under Spec A, the config-inferred last resort). That is a real improvement over no epoch awareness, but be honest about the transition: while stamped and un-stamped trades coexist in a window, the stamp and the fallback can **actively disagree** on the same window (the stamp sees `rulesFile`/manual edits the fallback can't), not merely differ in precision — hence the mixed-provenance warning. The disagreement self-heals as stamped trades replace the un-stamped backlog and age through the window.

C's *robust* path (marker-as-source-of-truth + per-trade stamps) is only fully active once agents have started under Spec A and stamped trades exist; before then it degrades to the config recompute and `updatedAt` heuristic. So C can ship before, with, or after A, but its drift-resistance and precision both track A's deployment. No flag-day, no migration.
