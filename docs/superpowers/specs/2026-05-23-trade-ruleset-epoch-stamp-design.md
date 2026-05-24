# Trade Ruleset-Epoch Stamp — Design Spec

**Date:** 2026-05-23
**Status:** Approved for planning
**Scope:** Data-layer change. Every new `decisive_actions/*.json` record gets stamped with the ruleset epoch in effect when the decision was made. Affects the decision write path (`mcp-server.js`), the agent harness (`agent/harness.js`), and adds one shared helper module. Applies to every agent that logs decisions (Prophet, PennyProphet, Harvest, TrendProphet, and any future agent), because the stamp is derived generically from the resolved rules text.
**Companion spec:** `docs/superpowers/specs/2026-05-23-adapt-strategy-epoch-conditional-split-design.md` (Spec C — the consumer of this stamp).

## Problem

The learning loop (`adapt-strategy`) reads recent decisive actions, splits them chronologically into an adapt set (oldest 80%) and a hold-out set (newest 20%), proposes rule edits from the adapt set, and validates them against the hold-out. This is sound **only when every loaded trade was generated under the same ruleset.**

When the strategy's rules change mid-window — which happens constantly during active iteration — the split silently mixes rulesets:

- The adapt set (oldest 80%) is dominated by behavior under the *old* rules.
- The hold-out (newest 20%) is the only data reflecting *current* rules, yet it is used only to validate, never to learn from.

So the loop can propose edits from stale behavior and "validate" them against a different data-generating process, producing clean-looking but meaningless verdicts.

The root cause is that **a decisive-action record carries no reference to the ruleset that produced it.** Confirmed record schema today: `timestamp, sandbox_id, account_id, action, symbol, reasoning, market_data` — no strategy id, no version. The only after-the-fact signal is comparing a trade's timestamp to `strategies[].updatedAt`, which is `undefined` on most strategies and is bumped only by `adapt-strategy` itself (not by manual edits or `rulesFile` edits).

This spec fixes the root cause: stamp the epoch at write time.

## Goals

1. Stamp every new decisive-action record with `strategyId` (human-readable) and `strategyVersion` (a stable hash of the exact rules text the agent was prompted with).
2. Make `strategyVersion` change **if and only if** the agent's effective instructions change — covering all four rule sources (`agent.customStrategyRules`, `strategy.customRules`, `strategy.rulesFile`, fallback `TRADING_RULES.md`).
3. Provide a single shared hashing implementation so a future consumer (Spec C) can recompute the identical hash for the current ruleset.
4. Publish the running agent's live `strategyVersion` to a durable per-agent marker file, so a consumer can read **what the live agent is actually stamping** rather than re-deriving it from a config file that may have been edited since the agent started. This is what makes Spec C robust against edit-vs-run time drift (see Spec C §"Determining the current epoch").

## Non-Goals

- **No backfill.** The ~66 existing un-stamped records stay as-is. Spec C handles missing stamps via a fallback. Stamping is purely forward-looking.
- **No change to existing consumers.** The two new fields are additive; every current reader of decisive actions ignores unknown keys.
- **No new version history store.** We stamp the version onto each trade; we do not build a changelog of strategy versions. Git history of `agent-config.json` already serves that need if anyone wants it.
- **No consumption logic.** This spec only *produces* the signal. Acting on it lives entirely in Spec C.

## High-Level Architecture

One new shared module, plus small additive edits to two existing files.

```
scripts/
  strategy-version.mjs            (NEW — computeStrategyVersion(rulesText) -> string|null)
  strategy-version.test.mjs       (NEW)

agent/
  harness.js                      (edit: hash resolved rules at agent start; export OPENPROPHET_STRATEGY_VERSION;
                                    write the per-agent current-version marker)

mcp-server.js                     (edit: log_decision writes strategyId + strategyVersion)

data/sandboxes/<accountId>/
  .current_strategy_version.json  (NEW — written by harness at start; gitignored;
                                    the version the live agent is currently stamping)
```

### Data flow

```
agent-config.json ──┐
                    ▼
   harness buildSystemPrompt() resolves effective rules text
   (agent.customStrategyRules ▸ strategy.customRules ▸ strategy.rulesFile ▸ TRADING_RULES.md)
                    ▼
   computeStrategyVersion(rulesText) ──▶ "a3f9c1d8e2b4"  (12-char sha256 prefix)
                    ├──▶ write data/sandboxes/<accountId>/.current_strategy_version.json
                    │      { strategyId, strategyVersion, startedAt }   ← Spec C reads this as source of truth
                    ▼
   harness exports env: OPENPROPHET_STRATEGY (id) + OPENPROPHET_STRATEGY_VERSION (hash)
                    ▼
   MCP server log_decision reads both env vars
                    ▼
   decisive_actions/<ts>_<action>_<sym>.json:
     { ..., "strategyId": "v2-options", "strategyVersion": "a3f9c1d8e2b4", ... }
```

## Detailed Design

### 1. Shared helper — `scripts/strategy-version.mjs`

The contract between producer (this spec) and consumer (Spec C). Both sides MUST hash identically, so the logic lives in exactly one place.

```js
import { createHash } from 'node:crypto';

// Returns a stable 12-char hex epoch id for a ruleset, or null for empty rules.
// Normalizes trailing whitespace / line endings so cosmetic-only diffs do not
// spuriously create a new epoch.
export function computeStrategyVersion(rulesText) {
  if (!rulesText || !rulesText.trim()) return null;
  const normalized = rulesText.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
}
```

Normalization decision: collapse CRLF→LF and strip trailing horizontal whitespace before hashing, then trim. This prevents an epoch flip from a pure line-ending or trailing-space change while still flipping on any substantive edit. (Spec C's parity test pins this exact normalization.)

**Known cost of a conservative hash (deliberate, not a defect):** any *substantive* byte change flips the epoch — including a semantically-neutral edit like reordering two rules or fixing a typo in a comment. This is the safe failure direction: an over-flip just starts a new epoch (costing Spec C its current-epoch trade count, which then rebuilds), whereas under-flipping would silently merge two genuinely different rulesets — the exact contamination bug this whole effort exists to kill. The cost is that frequent cosmetic edits during active iteration repeatedly reset Spec C's current-epoch count (it compounds with Spec C's `cur ≥ 20` floor — see Spec C §2 interaction note). A manual "this edit doesn't count, keep the epoch" escape hatch is **deliberately deferred, not built in v1**: a manual override is a footgun — forget to bump it and you silently merge epochs, reintroducing the bug. The accepted v1 tradeoff is conservative-over-flip plus actionable messaging in Spec C, not a manual lever.

### 2. `agent/harness.js`

`buildSystemPrompt` (`harness.js:101-115`) already resolves the effective rules into a local `tradingRules` string by walking the four sources in priority order. Two changes:

1. Have `buildSystemPrompt` return the resolved rules text alongside the prompt (e.g. return `{ prompt, resolvedRules }`, or set it on a field the caller can read). The caller at `harness.js:389` keeps using the prompt exactly as today; it additionally captures `resolvedRules`.
2. At agent start, compute `this._strategyVersion = computeStrategyVersion(resolvedRules)` once, and export it where the MCP server env is assembled (`harness.js:~1046-1056`), immediately after the existing `OPENPROPHET_STRATEGY` line (1054):

```js
OPENPROPHET_STRATEGY: this._agentConfig?.strategyId || '',
OPENPROPHET_STRATEGY_VERSION: this._strategyVersion || '',
```

3. After computing `_strategyVersion`, write the per-agent marker `data/sandboxes/<accountId>/.current_strategy_version.json`:

```json
{ "strategyId": "v2-options", "strategyVersion": "a3f9c1d8e2b4", "startedAt": "2026-05-23T15:04:11.000Z" }
```

This is overwritten on every agent start and is the authoritative record of "what this live agent is currently stamping." Spec C reads it instead of re-deriving the version from `agent-config.json`, which is what closes the edit-vs-run time-drift hole. Gitignore the marker (`.current_strategy_version.json`) alongside other generated sandbox artifacts.

Computed once per agent run (rules do not change mid-run; a rule edit takes effect on the next heartbeat, which is a fresh harness/prompt build), so there is no per-decision cost.

**Startup-ordering invariant (prevents a null-stamp race):** `_strategyVersion` MUST be computed before the MCP server is spawned. In the current code that ordering already holds — `buildSystemPrompt` runs at `harness.js:389`, well before the MCP env is assembled and the server is spawned at `~1046-1056`, and the agent can only reach `log_decision` after the server is up. The spec pins this as an explicit invariant with a guard: assert `_strategyVersion` has been set (to a hash, or to `null` for a genuinely no-rules agent) before the spawn, so a future refactor can't reorder computation after spawn and silently stamp `null` on early decisions.

### 3. `mcp-server.js`

The `log_decision` handler (`mcp-server.js:2211-2236`) builds the record at line 2216. Add two fields:

```js
const decision = {
  timestamp: new Date().toISOString(),
  sandbox_id: OPENPROPHET_SANDBOX_ID,
  account_id: OPENPROPHET_ACCOUNT_ID,
  strategyId: process.env.OPENPROPHET_STRATEGY || null,
  strategyVersion: process.env.OPENPROPHET_STRATEGY_VERSION || null,
  action: args.action,
  symbol: args.symbol || null,
  reasoning: args.reasoning,
  market_data: args.market_data || {},
};
```

No other change to the handler. The MCP server does not resolve rules or read `agent-config.json`; it only copies the two env vars the harness already computed.

## Edge Cases

| Case | Behavior |
|---|---|
| Legacy / inline-rules agent (`strategyId` unset) | `strategyId: null`, but `strategyVersion` is still the hash of the resolved rules text → epochs remain distinguishable even without an id. |
| Agent uses `customStrategyRules` inline on the agent | Resolved text comes from `agent.customStrategyRules`; hash reflects it. `strategyId: null`. |
| Strategy uses an external `rulesFile` | Resolved text is the file contents; editing the file flips the hash (which `updatedAt` would NOT catch). |
| No rules resolvable at all (empty) | `computeStrategyVersion` returns `null`; `strategyVersion: null`. |
| Env var absent (older harness, manual MCP launch) | `process.env.OPENPROPHET_STRATEGY_VERSION` is undefined → `strategyVersion: null`. Record is still valid; Spec C treats it as un-stamped. |

## Testing

`scripts/strategy-version.test.mjs` (node:test):
- Same text → same hash (stability).
- Substantively different text → different hash.
- CRLF vs LF, and trailing-whitespace-only diffs → same hash (normalization).
- Empty / whitespace-only / null input → `null`.
- Output is always 12 hex chars when non-null.

`mcp-server` log_decision (extend existing test harness if present; otherwise a focused test):
- With both env vars set → record contains matching `strategyId` and `strategyVersion`.
- With env vars unset → both fields are `null`, rest of record unchanged.

Harness parity + marker (lightweight):
- For a known agent+strategy fixture, the value exported as `OPENPROPHET_STRATEGY_VERSION` equals `computeStrategyVersion(resolvedRules)` for the same fixture. (Spec C adds the stronger end-to-end parity test against the skill's recompute.)
- On agent start, the marker file is written with `strategyVersion` equal to the exported env value (same source).
- Startup invariant: `_strategyVersion` is set (hash or explicit `null`) before the MCP-spawn step — guard fails the start otherwise.

## Rollout

Forward-only. The moment this ships, new trades carry stamps and the marker is written on the next agent start; old trades remain un-stamped. Spec C is designed to degrade gracefully on the un-stamped backlog and become fully precise as stamped trades accumulate. No data migration, no downtime, fully reversible (revert the edits and delete the marker files; extra fields on already-written records are harmless).
