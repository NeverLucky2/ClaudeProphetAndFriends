// Per-strategy MCP tool allowlists (config-as-code).
//
// Each trading agent should only see the MCP tools its strategy actually uses.
// The harness passes the resolved list as OPENPROPHET_TOOL_ALLOWLIST; the MCP
// server filters ListTools to those names (mcp-server.js:1513). Scoping here:
//   - prevents cross-strategy leakage (e.g. the penny agent seeing
//     get_mean_reversion_signal), and
//   - trims prompt tokens by not exposing schemas an agent never calls.
//
// Stored as a code map keyed by strategyId rather than on the strategy data
// object because mergeMissingDefaults (config-store.js) only appends missing
// rows — it does NOT backfill new fields onto already-persisted strategies, so
// a data-side default would be silently dropped on the live config.
//
// A non-empty per-sandbox permissions.allowedTools still overrides this map
// (see resolveAllowedTools). Unknown/absent strategyId resolves to [] = no
// filtering (backwards compatible).
//
// ALL_TOOLS must stay in sync with the live MCP catalog. tool-allowlists.test.mjs
// asserts it exactly matches the tool names defined in mcp-server.js plus
// regimeAndGuardTools — adding a server tool without updating this list fails CI.

export const ALL_TOOLS = [
  'aggregate_and_summarize_news',
  'analyze_stocks',
  'apply_heartbeat_profile',
  'assign_agent_to_sandbox',
  'cancel_order',
  'close_iron_condor',
  'close_managed_position',
  'create_agent',
  'create_strategy',
  'find_similar_setups',
  'get_account',
  'get_activity_log',
  'get_agent_config',
  'get_cleaned_news',
  'get_datetime',
  'get_defense_contracts',
  'get_earnings_drift_candidates',
  'get_earnings_drift_signal',
  'get_econ_blackout_status',
  'get_economic_indicators',
  'get_global_events',
  'get_global_trade_flows',
  'get_guard_status',
  'get_harvest_expirations',
  'get_harvest_fomc',
  'get_harvest_ivr',
  'get_harvest_state',
  'get_heartbeat_phases',
  'get_heartbeat_profiles',
  'get_historical_bars',
  'get_intraday_signals',
  'get_iv_rank',
  'get_latest_bar',
  'get_managed_position',
  'get_managed_positions',
  'get_market_news',
  'get_market_snapshot',
  'get_marketwatch_all',
  'get_marketwatch_bulletins',
  'get_marketwatch_marketpulse',
  'get_marketwatch_realtime',
  'get_marketwatch_topstories',
  'get_mean_reversion_candidates',
  'get_mean_reversion_signal',
  'get_news',
  'get_news_by_topic',
  'get_news_summary',
  'get_options_chain',
  'get_options_position',
  'get_options_positions',
  'get_orders',
  'get_penny_candidates',
  'get_penny_signal_detail',
  'get_penny_universe',
  'get_positions',
  'get_quick_market_intelligence',
  'get_quote',
  'get_regime_gate_status',
  'get_segment_pnl',
  'get_trade_stats',
  'get_treasury_data',
  'get_trend_signal',
  'list_news_summaries',
  'log_activity',
  'log_decision',
  'open_iron_condor',
  'openprophet',
  'place_buy_order',
  'place_managed_position',
  'place_options_order',
  'place_sell_order',
  'read_latest_report',
  'run_analyst_actions',
  'run_catalyst_news',
  'run_earnings_calendar',
  'run_economic_calendar',
  'run_ftd_check',
  'run_market_briefing',
  'run_market_top_check',
  'run_pead_screener',
  'run_vcp_screener',
  'scan_penny_universe_now',
  'search_news',
  'set_heartbeat',
  'set_session_mode',
  'store_trade_setup',
  'update_agent_prompt',
  'update_heartbeat_phase',
  'update_permissions',
  'update_strategy_rules',
  'wait',
];

const ALL_SET = new Set(ALL_TOOLS);

// Tools every trading agent needs: time/account/position reads, order list,
// quotes, P&L segmentation, the trading gates, logging, and wait.
const BASE = [
  'get_datetime',
  'get_account',
  'get_positions',
  'get_orders',
  'get_quote',
  'get_segment_pnl',
  'get_econ_blackout_status',
  'get_regime_gate_status',
  'get_guard_status',
  'log_activity',
  'log_decision',
  'get_activity_log',
  'wait',
];

// Stop+target managed-position lifecycle, shared by penny/mean-rev/drift.
const MANAGED = [
  'place_managed_position',
  'close_managed_position',
  'get_managed_positions',
  'get_managed_position',
];

// Strategy-signal/order endpoints exclusive to a single agent. Each set must
// appear on exactly one strategy's allowlist (enforced by tests) and is removed
// from the discretionary Prophet list below.
const PENNY_SIGNALS = ['get_penny_candidates', 'get_penny_signal_detail', 'get_penny_universe', 'scan_penny_universe_now'];
const HARVEST_TOOLS = ['get_harvest_state', 'get_harvest_ivr', 'get_harvest_fomc', 'get_harvest_expirations', 'open_iron_condor', 'close_iron_condor'];
const TREND_SIGNALS = ['get_trend_signal'];
const MEANREV_SIGNALS = ['get_mean_reversion_candidates', 'get_mean_reversion_signal'];
const DRIFT_SIGNALS = ['get_earnings_drift_candidates', 'get_earnings_drift_signal'];

// Manager/orchestration tools — agents reconfigure neither themselves nor peers.
export const MANAGER_TOOLS = [
  'create_agent',
  'create_strategy',
  'assign_agent_to_sandbox',
  'update_agent_prompt',
  'update_permissions',
  'update_strategy_rules',
  'get_agent_config',
  'openprophet',
];

function uniq(list) {
  return [...new Set(list)];
}

// Prophet (v2-options) is the broad discretionary agent: everything EXCEPT the
// five mechanical strategies' exclusive signal/condor endpoints and the manager
// tools. Computed (not enumerated) so any new generic server tool added to
// ALL_TOOLS flows to Prophet automatically.
const NON_PROPHET = new Set([
  ...PENNY_SIGNALS,
  ...HARVEST_TOOLS,
  ...TREND_SIGNALS,
  ...MEANREV_SIGNALS,
  ...DRIFT_SIGNALS,
  ...MANAGER_TOOLS,
]);

export const STRATEGY_TOOL_ALLOWLISTS = {
  'penny-momentum': uniq([
    ...BASE,
    ...PENNY_SIGNALS,
    ...MANAGED,
    'place_buy_order',
    'place_sell_order',
    'cancel_order',
    'get_latest_bar',
    'get_historical_bars',
  ]),
  'mean-rev-rsi2': uniq([...BASE, ...MEANREV_SIGNALS, ...MANAGED]),
  'earnings-drift': uniq([...BASE, ...DRIFT_SIGNALS, ...MANAGED]),
  'harvest': uniq([
    ...BASE,
    ...HARVEST_TOOLS,
    'get_options_chain',
    'get_options_positions',
    'get_options_position',
  ]),
  // analyze_stocks: trend reads its cross_asset block (5-day DXY/rate/credit
  // proxies) to confirm or pause a Donchian breakout (TRADING_RULES_TREND.md
  // "Cross-Asset Context"). Without it the agent silently loses macro confluence.
  'trend': uniq([...BASE, ...TREND_SIGNALS, 'analyze_stocks', 'place_buy_order', 'place_sell_order', 'cancel_order']),
  'v2-options': ALL_TOOLS.filter(t => !NON_PROPHET.has(t)),
};

// Resolve the effective MCP tool allowlist for a beat. A non-empty per-sandbox
// override wins wholesale (matching existing "non-empty = exact filter"
// semantics); otherwise the strategy default applies; otherwise [] (no filter).
export function resolveAllowedTools(sandboxAllow, strategyId) {
  const sb = Array.isArray(sandboxAllow) ? sandboxAllow.filter(Boolean) : [];
  if (sb.length > 0) return sb;
  return STRATEGY_TOOL_ALLOWLISTS[strategyId] || [];
}

// Exposed for tests: the exclusive per-strategy signal sets and base groups.
export const _internals = {
  BASE,
  MANAGED,
  PENNY_SIGNALS,
  HARVEST_TOOLS,
  TREND_SIGNALS,
  MEANREV_SIGNALS,
  DRIFT_SIGNALS,
  ALL_SET,
};
