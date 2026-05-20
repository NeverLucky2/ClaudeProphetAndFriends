# Per-Agent MCP Tool Allowlist — Design

**Date:** 2026-05-20
**Status:** Approved (design)

## Problem

Every trading agent currently sees the union of all strategies' MCP tools. The
penny agent (Spark, `penny-momentum`) was observed calling `get_mean_reversion_signal`,
a tool that belongs to the Coil agent (`mean-rev-rsi2`). Adding a new agent leaks
its tools onto every other agent's menu, bloating prompts and inviting cross-strategy
misfires.

The filtering mechanism already exists and works — it is simply unconfigured:

- `harness.js:974,991` — when `perms.allowedTools` is non-empty, the harness passes it
  as `OPENPROPHET_TOOL_ALLOWLIST` to the opencode/MCP subprocess.
- `mcp-server.js:30-38, 1513-1515` — when that env var is set, `ListTools` is filtered
  to only those tool names.
- `config-store.js:141` — `DEFAULT_PERMISSIONS.allowedTools = []` (empty = no filter).

## Decision: per-strategy code map (config-as-code)

Allowlists are stored as a **code constant keyed by `strategyId`**, not written into
live sandbox data and not stored on the strategy data object.

Rationale:
- `mergeMissingDefaults` (config-store.js:587) only appends *missing* strategy/agent
  IDs — it does **not** backfill new fields onto already-persisted rows. So adding
  `allowedTools` to `defaultStrategies()` would be silently ignored on the live config
  (all 6 strategies are already persisted). A code map avoids this entirely.
- Config-as-code: lives in the repo, survives fresh installs, auto-applies to every
  sandbox running that agent's strategy. New agents inherit scoping via their `strategyId`.
- Per-sandbox override is preserved: a non-empty `sandbox.permissions.allowedTools`
  still wins, so power users keep manual control.

## Mechanism

New module `agent/tool-allowlists.js`:
- `ALL_TOOLS` — the full MCP catalog (91 tool names: 89 in `mcp-server.js` +
  `get_regime_gate_status`, `get_guard_status` from `mcp-tools/regime-and-guard.mjs`).
- `STRATEGY_TOOL_ALLOWLISTS` — `{ [strategyId]: string[] }`.
- `resolveAllowedTools(sandboxAllow, strategyId)` — pure resolver:
  `sandboxAllow.length > 0 ? sandboxAllow : (STRATEGY_TOOL_ALLOWLISTS[strategyId] || [])`.

`harness.js` (~line 974) imports the resolver and computes:

```js
const sandboxAllow = Array.isArray(perms.allowedTools) ? perms.allowedTools.filter(Boolean) : [];
const allowedTools = resolveAllowedTools(sandboxAllow, this._agentConfig?.strategyId);
```

Everything downstream is unchanged. Agents with no `strategyId` (or an unknown one)
resolve to `[]` = no filtering (backwards compatible).

## Derivation principle

The cost is asymmetric: hiding a tool the agent needs = silent breakage; including a
generic read it does not use = a few schema tokens. So scope **strictly** only on the
two things that actually leak, and **generously** on safe reads:

- **Strategy-signal endpoints** — each appears on exactly ONE agent.
- **Manager/orchestration tools** — excluded from all 6 trading agents.

### BASE (all 6 trading agents)
`get_datetime, get_account, get_positions, get_orders, get_quote, get_segment_pnl,
get_econ_blackout_status, get_regime_gate_status, get_guard_status, log_activity,
log_decision, get_activity_log, wait`

### Manager/orchestration tools (excluded from all trading agents)
`create_agent, create_strategy, assign_agent_to_sandbox, update_agent_prompt,
update_permissions, update_strategy_rules, get_agent_config, openprophet`

### Per-strategy specific tools (added on top of BASE)

| Strategy | Agent | Specific tools |
|---|---|---|
| `penny-momentum` | Spark | get_penny_candidates, get_penny_signal_detail, get_penny_universe, scan_penny_universe_now, place_buy_order, place_sell_order, place_managed_position, get_managed_positions, get_managed_position, close_managed_position, cancel_order, get_latest_bar, get_historical_bars |
| `mean-rev-rsi2` | Coil | get_mean_reversion_candidates, get_mean_reversion_signal, place_managed_position, close_managed_position, get_managed_positions, get_managed_position |
| `earnings-drift` | Drift | get_earnings_drift_candidates, get_earnings_drift_signal, place_managed_position, close_managed_position, get_managed_positions, get_managed_position |
| `harvest` | Harvest | open_iron_condor, close_iron_condor, get_harvest_state, get_harvest_ivr, get_harvest_fomc, get_harvest_expirations, get_options_chain, get_options_positions, get_options_position |
| `trend` | TrendProphet | get_trend_signal, place_buy_order, place_sell_order, cancel_order |
| `v2-options` | Prophet | **computed**: `ALL_TOOLS` minus the 5 strategies' signal/condor endpoints (15) minus the 8 manager tools = 68 tools. Keeps all news/options/scalping/report (`run_*`)/macro tools + `set_heartbeat`/`apply_heartbeat_profile`. |

Mechanical agents deliberately get **no** raw-bar or news tools — their rules state the
signal endpoint is the single source of truth and they must not compute values
themselves, so tight scoping reinforces the rules.

Judgment calls confirmed with user:
- Prophet keeps the heavy `run_*` report generators (safest against silent breakage).
- Harvest includes `get_options_positions` / `get_options_position` reads.

## Verification

1. **Catalog-sync test** — assert `ALL_TOOLS` exactly equals the live tool names parsed
   from `mcp-server.js` + `regimeAndGuardTools`. Catches typos and future drift (a new
   tool added to the server without updating the map fails the test).
2. **Resolver unit tests** — sandbox override wins; strategy fallback applies; unknown/absent
   strategyId → `[]`; every name in every list is a member of `ALL_TOOLS`; each
   strategy-signal endpoint appears on exactly its owning agent and is absent elsewhere.
3. **Live heartbeat smoke test** — spawn one beat per agent; confirm every tool it calls
   is present, and that `get_mean_reversion_* / get_earnings_drift_* / get_harvest_* /
   get_trend_signal / get_penny_*` are absent from non-owning agents.

## Out of scope
- No change to `blockedTools` (separate, enforced at call time in `mcp-server.js:1540`).
- No migration, no edits to live `agent-config.json`.
- No UI changes.
