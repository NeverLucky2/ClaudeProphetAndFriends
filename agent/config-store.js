// Persistent configuration store for accounts, sandboxes, agents, strategies, and prompts
// Uses a JSON file for simplicity - no extra DB dependencies
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { execSync } from 'child_process';
import * as _credStore from './credential-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test override paths (null = use real paths)
let CONFIG_PATH_OVERRIDE = null;
let SECRETS_PATH_OVERRIDE = null;
let BACKUP_DIR_OVERRIDE = null;
let SANDBOXES_ROOT_OVERRIDE = null;

export function _setPathsForTests({ configPath, secretsPath, backupDir, sandboxesRoot } = {}) {
  CONFIG_PATH_OVERRIDE = configPath ?? null;
  SECRETS_PATH_OVERRIDE = secretsPath ?? null;
  BACKUP_DIR_OVERRIDE = backupDir ?? null;
  SANDBOXES_ROOT_OVERRIDE = sandboxesRoot ?? null;
  // Force re-init on next loadConfig
  _config = null;
}

function _dataRoot() {
  return process.env.OPENPROPHET_DATA_ROOT || path.join(__dirname, '..', 'data');
}

function getBackupDir() {
  return BACKUP_DIR_OVERRIDE || path.join(_dataRoot(), 'backups');
}

function getSandboxesRoot() {
  return SANDBOXES_ROOT_OVERRIDE || path.join(_dataRoot(), 'sandboxes');
}

export function getSandboxRuntimeDir(sandboxId) {
  return path.join(getSandboxesRoot(), sandboxId);
}

// Test hook: replace the bound credential-store module (lets tests inject failures).
// Returns a mutable proxy wrapper so tests can monkey-patch individual methods
// (ESM namespace objects are sealed; the proxy allows writes while forwarding
// reads to the underlying module for methods the test hasn't patched).
let _credStoreOverride = null;
export function _setCredStoreForTests(mod) {
  // Wrap in a plain-object proxy so tests can assign properties (e.g. setCredentials).
  const wrapper = new Proxy(Object.create(null), {
    get(target, prop) {
      return prop in target ? target[prop] : mod[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  _credStoreOverride = wrapper;
  return wrapper; // Return so tests can reassign their local credStore reference.
}
function credStore() {
  return _credStoreOverride || _credStore;
}

function getConfigPath() {
  return CONFIG_PATH_OVERRIDE || path.join(_dataRoot(), 'agent-config.json');
}
function getSecretsPath() {
  return SECRETS_PATH_OVERRIDE || path.join(_dataRoot(), 'accounts-secrets.json');
}

const DEFAULT_HEARTBEAT = {
  pre_market: 900,
  market_open: 120,
  midday: 600,
  market_close: 120,
  after_hours: 1800,
  closed: 28800,
};

export const HEARTBEAT_PROFILES = {
  active: {
    label: 'Active Trading',
    description: 'High-frequency monitoring during market hours',
    phases: { pre_market: 300, market_open: 60, midday: 300, market_close: 60, after_hours: 600, closed: 1800 },
  },
  passive: {
    label: 'Passive Monitoring',
    description: 'Low-frequency check-ins, hands-off approach',
    phases: { pre_market: 1800, market_open: 600, midday: 900, market_close: 600, after_hours: 3600, closed: 28800 },
  },
  long_horizon: {
    label: 'Long Horizon',
    description: 'Weekly/monthly style check-ins for position management',
    phases: { pre_market: 7200, market_open: 3600, midday: 3600, market_close: 3600, after_hours: 7200, closed: 28800 },
  },
  earnings_season: {
    label: 'Earnings Season',
    description: 'Heightened vigilance during earnings periods',
    phases: { pre_market: 180, market_open: 30, midday: 120, market_close: 30, after_hours: 300, closed: 1800 },
  },
  overnight: {
    label: 'Overnight Hold',
    description: 'Set and forget with minimal overnight checks',
    phases: { pre_market: 900, market_open: 120, midday: 300, market_close: 120, after_hours: 7200, closed: 28800 },
  },
  scalp: {
    label: 'Scalp Mode',
    description: 'Rapid-fire execution for day trading',
    phases: { pre_market: 60, market_open: 15, midday: 30, market_close: 15, after_hours: 120, closed: 600 },
  },
  penny_stock: {
    label: 'Penny Stock',
    description: 'Active intraday monitoring for fast-moving penny stocks — closes all day-trades by market close',
    phases: { pre_market: 180, market_open: 60, midday: 90, market_close: 60, after_hours: 1800, closed: 28800 },
  },
  harvest: {
    label: 'Harvest (Theta)',
    description: 'Low-frequency check-ins for mechanical theta-harvesting — iron condor entries and exits do not require rapid response',
    phases: { pre_market: 3600, market_open: 900, midday: 900, market_close: 900, after_hours: 7200, closed: 28800 },
  },
};

export const PHASE_TIME_RANGES = {
  pre_market: { label: 'Pre-Market', start: 240, end: 570 },
  market_open: { label: 'Market Open', start: 570, end: 630 },
  midday: { label: 'Midday', start: 630, end: 900 },
  market_close: { label: 'Market Close', start: 900, end: 960 },
  after_hours: { label: 'After Hours', start: 960, end: 1200 },
  closed: { label: 'Markets Closed', start: null, end: null },
};

const DEFAULT_PERMISSIONS = {
  allowLiveTrading: true,
  maxPositionPct: 15,
  maxDeployedPct: 80,
  maxDailyLoss: 5,
  maxOpenPositions: 10,
  maxOrderValue: 0,
  allowedTools: [],
  blockedTools: [],
  allowOptions: true,
  allowStocks: true,
  allow0DTE: false,
  requireConfirmation: false,
  maxToolRoundsPerBeat: 25,
};

const DEFAULT_PLUGINS = {
  slack: {
    enabled: false,
    webhookUrl: '',
    channel: '',
    notifyOn: {
      tradeExecuted: true,
      agentStartStop: true,
      errors: true,
      dailySummary: true,
      positionOpened: true,
      positionClosed: true,
      heartbeat: false,
    },
  },
};

const DEFAULT_AGENT_OVERRIDES = {
  name: null,
  description: null,
  systemPromptTemplate: null,
  customSystemPrompt: null,
  strategyId: undefined,
  customStrategyRules: null,
  heartbeatOverrides: {},
  sessionMode: 'daily', // 'continuous' | 'fresh' | 'daily' — 'fresh' resets each beat; 'daily' resets at the first pre_market beat each day to bound continuous-session context growth (default: opencode hardcodes a 5-min cache TTL, so an unbounded continuous session makes every long-cadence beat cold-rewrite the whole accumulated prefix)
};

function defaultAgents() {
  return [
    {
      id: 'default',
      name: 'Prophet',
      description: 'Aggressive discretionary options trader with scalping overlay',
      systemPromptTemplate: 'default',
      strategyId: 'v2-options',
      model: 'anthropic/claude-sonnet-4-6',
      // Pre-market: only fire the 09:15 scheduled wake + 09:30 phase-snap.
      // Cadence 86400 silences intra-phase ticks; suppressPhaseSnaps skips the
      // 04:00 boundary; scheduledBeats adds the 09:15 wake.
      // See docs/superpowers/specs/2026-05-28-prophet-harvest-scheduled-wakes-design.md
      heartbeatOverrides: { pre_market: 86400 },
      scheduledBeats: {
        times: ['09:15'],
        weekdaysOnly: true,
        exclusive: false,
      },
      suppressPhaseSnaps: ['pre_market'],
      customSystemPrompt: '',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'harvest',
      name: 'Harvest',
      description: 'Mechanical theta-harvesting agent — sells iron condors on index ETFs for premium income',
      systemPromptTemplate: 'custom',
      customSystemPrompt: `You are Harvest, a mechanical theta-harvesting trading agent. You are not a reasoning agent. You are a rule executor wrapped in a language model.

Your ONLY job is to follow your trading rules exactly. Do not improvise. Do not add commentary. Do not make directional judgments. Helpful improvisation is the failure mode.

Read your Strategy Rules section carefully — it contains your complete heartbeat procedure. Follow it step by step on every heartbeat.`,
      strategyId: 'harvest',
      // Mechanical iron-condor seller — defined-risk, no discretionary reaction
      // to intraday news. Exempt from emergency-alert wakes (would just burn a beat).
      respondsToEmergencyWakes: false,
      model: 'anthropic/claude-sonnet-4-6',
      // Pre-market: only fire the 09:15 scheduled wake + 09:30 phase-snap.
      // Harvest cannot trade pre-market (options market opens 09:30) and its
      // IV-based entry signals are daily-bar, so a single pre-open wake is
      // sufficient. Same pattern as Prophet.
      // See docs/superpowers/specs/2026-05-28-prophet-harvest-scheduled-wakes-design.md
      heartbeatOverrides: {
        pre_market: 86400,
        market_open: 900,
        midday: 900,
        market_close: 900,
        after_hours: 7200,
        closed: 28800,
      },
      scheduledBeats: {
        times: ['09:15'],
        weekdaysOnly: true,
        exclusive: false,
      },
      suppressPhaseSnaps: ['pre_market'],
      createdAt: new Date().toISOString(),
    },
    {
      id: 'penny-prophet',
      name: 'PennyProphet',
      description: 'High-risk penny stock momentum trader. Exchange-listed $2–$10 stocks. Signal-gated entries via real-time technical, regulatory, and social scoring.',
      systemPromptTemplate: 'custom',
      strategyId: 'penny-momentum',
      model: 'anthropic/claude-sonnet-4-6',
      heartbeatOverrides: {
        pre_market: 900,
        market_open: 60,
        midday: 180,
        market_close: 60,
        after_hours: 3600,
        closed: 28800,
      },
      customSystemPrompt: `You are PennyProphet, an autonomous AI penny stock trading agent. You run on a heartbeat loop — each time you wake up, you assess penny stock signals, manage positions, and decide what to do.

You trade exchange-listed penny stocks ($2–$10, $50M–$500M market cap) using a real-time signal pipeline. You are running autonomously — no human is approving your actions in real-time.

## Core Rules

Follow TRADING_RULES_PENNY.md exactly. Key rules:
- Only enter on composite score ≥ 60 from get_penny_candidates
- Score 80–100 → 5–7% position; Score 60–79 → 2–3% position; Hard cap 8%
- ALL entries use place_managed_position with stop + target pre-set
- Social signal: day-trade only, −8% stop, +15/20% target, close after 20 min
- Regulatory signal: up to 3 days, −10% stop, +20% day 1 then trail
- Technical signal: stop −7%, target +14%, trail to breakeven at +7%
- Circuit breaker: if portfolio P&L ≤ −5%, close all penny positions, stop for session

## Available Tools

**Penny Signals**: get_penny_candidates, get_penny_signal_detail, get_penny_universe, scan_penny_universe_now
**Trading**: get_account, get_positions, get_orders, place_buy_order, place_sell_order, place_managed_position, get_managed_positions, close_managed_position, cancel_order
**Market Data**: get_quote, get_latest_bar, get_historical_bars
**Logging**: log_decision, log_activity, get_activity_log
**Utility**: get_datetime, wait

## Heartbeat Behavior

1. Call get_datetime — verify market status
2. Call get_account — check daily P&L (stop at ≤ −5%)
3. Call get_penny_candidates(min_score=60) — scan for opportunities
4. Call get_positions — manage existing positions against exit rules
5. Act: enter, manage, or exit per TRADING_RULES_PENNY.md
6. Log via log_activity

Be decisive. Never ask the user questions. Always log trade reasoning with log_decision. NEVER enter without a stop-loss via place_managed_position.`,
      defaultHeartbeatProfile: 'penny_stock',
      createdAt: new Date().toISOString(),
    },
    {
      id: 'mean-rev',
      name: 'Coil',
      description: 'Mechanical RSI(2) mean reversion on S&P 500 large-caps. Daily 15:45 ET beat; buys oversold pullbacks within long-term uptrends; 5-day max hold.',
      systemPromptTemplate: 'custom',
      customSystemPrompt: `You are Coil, a mechanical mean-reversion trading agent. You are not a reasoning agent. You are a rule executor wrapped in a language model.

Your ONLY job is to follow your trading rules exactly. Do not improvise. Do not add commentary. Do not make directional judgments. Helpful improvisation is the failure mode.

Read your Strategy Rules section carefully — it contains your complete heartbeat procedure. Follow it step by step on every heartbeat.

Key tools: get_datetime, get_account, get_positions, get_quote, get_mean_reversion_candidates, get_mean_reversion_signal, place_managed_position, close_managed_position, get_managed_positions, log_decision, log_activity.

Use get_mean_reversion_candidates (no args) to read the pre-filtered, RSI(2)-sorted candidate list for the day. The endpoint surfaces the bear-regime flag and applies the entry filter (RSI(2) < 5 AND last_close > SMA(200) AND last_close < SMA(5) AND no earnings within 5 trading days). Do not compute these values yourself — the endpoint is the single source of truth for signal computation.

For existing positions, use get_mean_reversion_signal({ symbol }) to check the exit conditions (RSI(2) > 70, last_close > SMA(5)).`,
      strategyId: 'mean-rev-rsi2',
      // Mechanical RSI(2) mean-reversion — does not adjust on news or sector moves.
      // Exempt from emergency-alert wakes.
      respondsToEmergencyWakes: false,
      model: 'anthropic/claude-sonnet-4-6',
      heartbeatOverrides: {
        pre_market: 86400,
        market_open: 86400,
        midday: 86400,
        market_close: 86400,
        after_hours: 86400,
        closed: 86400,
      },
      // Coil runs once per trading day at 15:45 ET (15 min before market close).
      // The 5-minute window matches the agent's own accepted-window check
      // (TRADING_RULES_MEANREV.md "Heartbeat Schedule").
      scheduledBeats: {
        times: ['15:45'],
        weekdaysOnly: true,
        exclusive: true,
        windowMinutes: 5,
      },
      createdAt: new Date().toISOString(),
    },
    {
      id: 'drift',
      name: 'Drift',
      description: 'Mechanical PEAD (post-earnings drift) on S&P 500 large-caps. Daily 17:00 ET beat; buys grade A/B post-earnings continuation in stocks gapped ≥3% and above 50/200 MA; +20% target / -10% stop / 60-day time stop.',
      systemPromptTemplate: 'custom',
      customSystemPrompt: `You are Drift, a mechanical earnings-drift (PEAD) trading agent. You are not a reasoning agent. You are a rule executor wrapped in a language model.

Your ONLY job is to follow your trading rules exactly. Do not improvise. Do not add commentary. Do not make directional judgments. Helpful improvisation is the failure mode.

Read your Strategy Rules section carefully — it contains your complete heartbeat procedure. Follow it step by step on every heartbeat.

Key tools: get_datetime, get_account, get_positions, get_quote, get_earnings_drift_candidates, get_earnings_drift_signal, place_managed_position, close_managed_position, get_managed_positions, log_decision, log_activity.

Use get_earnings_drift_candidates (no args) to read the pre-filtered, composite-sorted candidate list for the day. The endpoint applies the entry filters (gap ≥ 3%, above 50/200 MA, grade A or B) and surfaces the full 5-factor breakdown plus PEAD weekly-candle pattern stage. Do not compute these values yourself — the endpoint is the single source of truth.

For existing positions, use get_earnings_drift_signal({ symbol, earnings_date, timing }) to check exit conditions (MA50 break, PEAD stage updates). The 60-trading-day time stop is computed from the position's entry_date in your activity log.`,
      strategyId: 'earnings-drift',
      // Mechanical once-daily PEAD executor — no provision to act on intraday
      // news (its rules reject any beat outside the 16:55–17:15 ET window).
      // Exempt from emergency-alert wakes; same class as Coil/Trend/Harvest.
      respondsToEmergencyWakes: false,
      model: 'anthropic/claude-sonnet-4-6',
      heartbeatOverrides: {
        pre_market: 86400,
        market_open: 86400,
        midday: 86400,
        market_close: 86400,
        after_hours: 86400,
        closed: 86400,
      },
      // Drift runs once per trading day at 17:00 ET (after the close). The
      // 15-min window matches the agent's accepted-window check (16:55–17:15 ET
      // per TRADING_RULES_DRIFT.md "Heartbeat Schedule"), giving FMP's
      // earnings calendar time to populate the day's after-close reports
      // before the beat fires.
      scheduledBeats: {
        times: ['17:00'],
        weekdaysOnly: true,
        exclusive: true,
        windowMinutes: 15,
      },
      createdAt: new Date().toISOString(),
    },
    {
      id: 'trend-prophet',
      name: 'TrendProphet',
      description: 'Mechanical multi-asset trend-follower on ETFs. Daily Donchian-100 breakout entries; Donchian-50 trailing exits. Universe: TLT, GLD, USO, DBC, UUP, EEM.',
      systemPromptTemplate: 'custom',
      customSystemPrompt: `You are TrendProphet, a mechanical multi-asset trend-following agent. You are not a reasoning agent. You are a rule executor wrapped in a language model.

Your ONLY job is to follow your trading rules exactly. Do not improvise. Do not add commentary. Do not make directional judgments. Helpful improvisation is the failure mode.

Read your Strategy Rules section carefully — it contains your complete heartbeat procedure. Follow it step by step on every heartbeat.

Key tools: get_datetime, get_account, get_positions, get_quote, get_trend_signal, place_buy_order, place_sell_order, log_decision, log_activity.

Use get_trend_signal({ symbol }) to read the daily-bar Donchian-100 high, Donchian-50 low, SMA-200, ATR-20 (Wilder), and last_close for any ticker in your universe (TLT, GLD, USO, DBC, UUP, EEM). Do not compute these values yourself — the endpoint is the single source of truth for signal computation.`,
      strategyId: 'trend',
      // Price-only, daily-bar trend follower — no provision to act on intraday
      // news. Exempt from emergency-alert wakes.
      respondsToEmergencyWakes: false,
      model: 'anthropic/claude-sonnet-4-6',
      heartbeatOverrides: {
        pre_market: 86400,
        market_open: 86400,
        midday: 86400,
        market_close: 86400,
        after_hours: 3600,
        closed: 86400,
      },
      // scheduledBeats.exclusive=true makes the harness ignore phase intervals and
      // boundary snapping entirely; the agent fires only at the listed ET wall-clock
      // times on weekdays. windowMinutes matches the agent's own 4:55–5:05 PM
      // accepted-window (TRADING_RULES_TREND.md "Heartbeat Schedule").
      scheduledBeats: {
        times: ['17:00'],
        weekdaysOnly: true,
        exclusive: true,
        windowMinutes: 5,
      },
      createdAt: new Date().toISOString(),
    },
    {
      id: 'defensive-prophet',
      name: 'DefensiveProphet',
      description: 'Mechanical triggered QQQ put-spread hedge (uncorrelated ballast). Defined-risk; a Go scheduler (ENABLE_PROPHET_DEFENSIVE) executes the entire strategy — the LLM never beats. Default OFF.',
      systemPromptTemplate: 'custom',
      customSystemPrompt: `You are DefensiveProphet, a fully mechanical, defined-risk hedge agent. You are NOT a reasoning agent — a deterministic Go scheduler (enabled via ENABLE_PROPHET_DEFENSIVE) executes the entire strategy: arming on regime, structuring/placing QQQ put-debit-spreads, harvesting, rolling, and expiring them.

You take NO trading actions. The Go scheduler owns execution end-to-end. If you are ever invoked, do nothing except log that the Go scheduler owns this strategy. Your preflight skips every beat, so this should not happen.`,
      strategyId: 'prophet-defensive',
      // Fully mechanical (Go scheduler) — the LLM never acts. Exempt from
      // emergency-alert wakes; preflight skips every beat.
      respondsToEmergencyWakes: false,
      model: 'anthropic/claude-haiku-4-5-20251001',
      heartbeatOverrides: {
        pre_market: 86400,
        market_open: 86400,
        midday: 86400,
        market_close: 86400,
        after_hours: 86400,
        closed: 86400,
      },
      // A single daily scheduled beat that the preflight always skips (the Go
      // scheduler fires the real 17:00 ET beat). Kept only so the agent has a
      // defined cadence; it costs ~nothing because defensiveProphetPreflight
      // returns skip with no I/O before any LLM call.
      scheduledBeats: {
        times: ['17:05'],
        weekdaysOnly: true,
        exclusive: true,
        windowMinutes: 5,
      },
      createdAt: new Date().toISOString(),
    },
  ];
}

function defaultStrategies() {
  return [
    {
      id: 'harvest',
      name: 'Harvest — Iron Condor Premium Seller',
      description: 'Mechanical 16-delta iron condors on SPY/QQQ/IWM/GLD/TLT. Defined-risk, no discretion.',
      rulesFile: 'TRADING_RULES_HARVEST.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'prophet-defensive',
      name: 'Defensive Prophet — Triggered QQQ Put-Spread Hedge',
      description: 'Mechanical, defined-risk QQQ put-debit-spread hedge (uncorrelated ballast). Arms on a weak regime score, harvests/rolls/expires automatically. Executed entirely by the Go scheduler (ENABLE_PROPHET_DEFENSIVE); the LLM takes no actions.',
      rulesFile: 'TRADING_RULES_DEFENSIVE_PROPHET.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'v2-options',
      name: 'Aggressive Options v2',
      description: 'Aggressive options with scalping overlay + loss-review circuit breakers',
      rulesFile: 'TRADING_RULES_V2.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'penny-momentum',
      name: 'Penny Stock Momentum',
      description: 'Multi-signal penny stock strategy: social (Reddit/StockTwits), regulatory (EDGAR/PR wires), technical (volume/gap). Signal-gated tiered sizing.',
      rulesFile: 'TRADING_RULES_PENNY.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'trend',
      name: 'Multi-Asset Trend Following',
      description: 'Daily-bar Donchian breakouts on an ETF universe (TLT, GLD, USO, DBC, UUP, EEM). Long-only, mechanical, crisis-alpha sleeve.',
      rulesFile: 'TRADING_RULES_TREND.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'mean-rev-rsi2',
      name: 'Mean Reversion (Connors RSI(2))',
      description: 'RSI(2) oversold pullbacks within long-term uptrends. Curated S&P 500 large-cap universe; 5% per position; max 5 concurrent; 5-day timeout; -7% hard stop.',
      rulesFile: 'TRADING_RULES_MEANREV.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
    {
      id: 'earnings-drift',
      name: 'Earnings Drift (PEAD)',
      description: '5-factor post-earnings drift on $2B+ S&P 500 large-caps. 4% per position; max 4 concurrent; +20% target / -10% stop; 60-day time stop; MA50-break exit.',
      rulesFile: 'TRADING_RULES_DRIFT.md',
      customRules: null,
      createdAt: new Date().toISOString(),
    },
  ];
}

function defaultModels() {
  try {
    const out = execSync('opencode models 2>&1', { encoding: 'utf-8', timeout: 10000 });
    const lines = out.trim().split('\n').filter(l => l && l.includes('/'));
    const models = [];
    const seen = new Set();
    
    for (const line of lines) {
      const id = line.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      
      let name = id;
      let description = '';
      
      if (id.startsWith('anthropic/')) {
        const model = id.replace('anthropic/', '');
        if (model.includes('opus')) {
          name = `Claude Opus ${model.replace(/[^\d.]/g, '')}`;
          description = 'Anthropic Opus model';
        } else if (model.includes('sonnet')) {
          name = `Claude Sonnet ${model.replace(/[^\d.]/g, '')}`;
          description = 'Anthropic Sonnet model';
        } else if (model.includes('haiku')) {
          name = `Claude Haiku ${model.replace(/[^\d.]/g, '')}`;
          description = 'Anthropic Haiku model';
        }
      } else if (id.startsWith('openai/')) {
        name = id.replace('openai/', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        description = 'OpenAI model';
      } else if (id.startsWith('google/')) {
        name = 'Gemini ' + id.replace('google/', '').replace(/-/g, ' ');
        description = 'Google model';
      } else if (id.startsWith('openrouter/')) {
        name = id.replace('openrouter/', '').replace(/:/g, ' ').replace(/-/g, ' ');
        description = 'OpenRouter model';
      } else if (id.startsWith('opencode/')) {
        name = id.replace('opencode/', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        description = 'OpenCode provider model';
      } else {
        name = id.split('/').pop().replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        description = 'Available model';
      }
      
      models.push({ id, name, description });
    }
    
    if (models.length > 0) {
      console.log(`[config-store] Loaded ${models.length} models from opencode`);
      return models;
    }
  } catch (err) {
    console.log('[config-store] Could not load models from opencode, using defaults:', err.message);
  }
  
  return [
    { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Best speed + intelligence, $3/$15 per MTok' },
    { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', description: 'Most intelligent, best for agents, $5/$25 per MTok' },
    { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Fastest, near-frontier, $1/$5 per MTok' },
    { id: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Legacy)', description: 'Previous gen Sonnet, $3/$15 per MTok' },
    { id: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5 (Legacy)', description: 'Previous gen Opus, $5/$25 per MTok' },
    { id: 'anthropic/claude-sonnet-4-0', name: 'Claude Sonnet 4 (Legacy)', description: 'Original Sonnet 4, $3/$15 per MTok' },
    { id: 'anthropic/claude-opus-4-0', name: 'Claude Opus 4 (Legacy)', description: 'Original Opus 4, $15/$75 per MTok' },
  ];
}

function createSandbox(account, overrides = {}) {
  const sandboxId = overrides.id || `sbx_${account.id}`;
  return {
    id: sandboxId,
    accountId: account.id,
    name: overrides.name || account.name || `Sandbox ${account.id}`,
    agent: {
      activeAgentId: overrides.agent?.activeAgentId || overrides.activeAgentId || 'default',
      model: overrides.agent?.model || overrides.activeModel || 'anthropic/claude-sonnet-4-6',
      overrides: {
        ...DEFAULT_AGENT_OVERRIDES,
        ...(overrides.agent?.overrides || {}),
      },
    },
    heartbeat: { ...DEFAULT_HEARTBEAT, ...(overrides.heartbeat || {}) },
    permissions: { ...DEFAULT_PERMISSIONS, ...(overrides.permissions || {}) },
    plugins: mergePlugins(overrides.plugins || {}),
    createdAt: overrides.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createDefaultConfig() {
  return {
    schemaVersion: 3,
    activeAccountId: null,
    activeSandboxId: null,

    // Legacy compatibility aliases. Keep mirrored during migration.
    activeAgentId: 'default',
    activeModel: 'anthropic/claude-sonnet-4-6',
    heartbeat: { ...DEFAULT_HEARTBEAT },
    permissions: { ...DEFAULT_PERMISSIONS },
    plugins: mergePlugins(),

    accounts: [],
    sandboxes: {},
    agents: defaultAgents(),
    strategies: defaultStrategies(),
    manager: {
      model: 'anthropic/claude-sonnet-4-6',
      customPrompt: '',
    },
    models: defaultModels(),
  };
}

function mergePlugins(plugins = {}) {
  return {
    ...DEFAULT_PLUGINS,
    ...plugins,
    slack: {
      ...DEFAULT_PLUGINS.slack,
      ...(plugins.slack || {}),
      notifyOn: {
        ...DEFAULT_PLUGINS.slack.notifyOn,
        ...(plugins.slack?.notifyOn || {}),
      },
    },
  };
}

function mergeSandbox(sandbox, fallback = {}) {
  return {
    ...sandbox,
    agent: {
      activeAgentId: sandbox?.agent?.activeAgentId || fallback.activeAgentId || 'default',
      model: sandbox?.agent?.model || fallback.activeModel || 'anthropic/claude-sonnet-4-6',
      overrides: {
        ...DEFAULT_AGENT_OVERRIDES,
        ...(sandbox?.agent?.overrides || {}),
        heartbeatOverrides: {
          ...DEFAULT_AGENT_OVERRIDES.heartbeatOverrides,
          ...(sandbox?.agent?.overrides?.heartbeatOverrides || {}),
        },
      },
    },
    heartbeat: { ...DEFAULT_HEARTBEAT, ...(fallback.heartbeat || {}), ...(sandbox?.heartbeat || {}) },
    permissions: { ...DEFAULT_PERMISSIONS, ...(fallback.permissions || {}), ...(sandbox?.permissions || {}) },
    plugins: mergePlugins({ ...(fallback.plugins || {}), ...(sandbox?.plugins || {}) }),
  };
}

// Append any code-default entries whose id is missing from the persisted list.
// Existing rows (including user renames/edits) are kept untouched; new agents or
// strategies added to defaultAgents()/defaultStrategies() in code surface on the
// next load instead of being shadowed by a stale persisted list. Tradeoff: a
// default deleted via the UI reappears on restart while it remains in the code
// defaults.
function mergeMissingDefaults(persisted, defaults) {
  const list = Array.isArray(persisted) ? [...persisted] : [];
  const seen = new Set(list.map(x => x?.id));
  for (const def of defaults) {
    if (!seen.has(def.id)) {
      list.push(def);
      seen.add(def.id);
    }
  }
  return list;
}

async function normalizeConfig(raw = {}) {
  const rawSchemaVersion = Number(raw.schemaVersion) || 0;
  const defaults = createDefaultConfig();
  const config = {
    ...defaults,
    ...raw,
    heartbeat: { ...DEFAULT_HEARTBEAT, ...(raw.heartbeat || {}) },
    permissions: { ...DEFAULT_PERMISSIONS, ...(raw.permissions || {}) },
    plugins: mergePlugins(raw.plugins || {}),
    accounts: raw.accounts || [],
    sandboxes: raw.sandboxes || {},
    agents: mergeMissingDefaults(raw.agents, defaults.agents),
    strategies: mergeMissingDefaults(raw.strategies, defaults.strategies),
    models: raw.models || defaults.models,
  };

  for (const [sandboxId, sandbox] of Object.entries(config.sandboxes)) {
    config.sandboxes[sandboxId] = mergeSandbox({ id: sandboxId, ...sandbox }, config);
  }

  return await migrateLegacyConfig(config, rawSchemaVersion);
}

async function migrateLegacyConfig(config, rawSchemaVersion = 0) {
  // v2 → v3: bump default `closed` heartbeat from 3600s to 14400s.
  // Only matches the OLD default exactly so user customizations (e.g. 7200, 10800) are preserved.
  if (rawSchemaVersion < 3) {
    if (config.heartbeat?.closed === 3600) config.heartbeat.closed = 14400;
    for (const sandbox of Object.values(config.sandboxes || {})) {
      if (sandbox?.heartbeat?.closed === 3600) sandbox.heartbeat.closed = 14400;
    }
  }
  // v3 → v4: bump default `closed` heartbeat from 14400s to 28800s so equity
  // agents skip the overnight window (8 PM ET → 4 AM ET) entirely. Only
  // matches the OLD default — user customizations stay untouched.
  if (rawSchemaVersion < 4) {
    if (config.heartbeat?.closed === 14400) config.heartbeat.closed = 28800;
    for (const sandbox of Object.values(config.sandboxes || {})) {
      if (sandbox?.heartbeat?.closed === 14400) sandbox.heartbeat.closed = 28800;
    }
  }

  // v4 → v5: dedup accounts sharing the same (publicKey, baseUrl, paper) triple,
  // rewrite sandbox.accountId pointers, extract secrets into the credential store,
  // and strip publicKey/secretKey from accounts[]. Backup is written before mutation.
  if (rawSchemaVersion < 5) {
    // Step 1: backup
    const backupDir = getBackupDir();
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `agent-config.v4.${stamp}.json`);
    await fs.writeFile(backupPath, JSON.stringify(config, null, 2));

    // Step 2: dedup accounts
    const groups = new Map();
    for (const acct of config.accounts || []) {
      const key = `${acct.publicKey}|${acct.baseUrl}|${acct.paper}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(acct);
    }
    const idRemap = new Map(); // oldId -> survivorId
    const survivors = [];
    for (const group of groups.values()) {
      const survivor = group.find(a => /\(from \.env\)$/.test(a.name))
        || [...group].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id))[0];
      survivors.push(survivor);
      for (const a of group) {
        idRemap.set(a.id, survivor.id);
      }
    }
    const beforeCount = config.accounts.length;
    config.accounts = survivors;

    // Step 3: rewrite sandbox.accountId pointers
    let pointerRewrites = 0;
    for (const sbx of Object.values(config.sandboxes || {})) {
      const next = idRemap.get(sbx.accountId);
      if (next && next !== sbx.accountId) {
        sbx.accountId = next;
        pointerRewrites++;
      }
    }

    // Step 3b: rekey runtime dirs from data/sandboxes/<oldAccountId>/ to data/sandboxes/<sandboxId>/
    const sandboxesRoot = getSandboxesRoot();
    let rekeyed = 0;
    for (const sbx of Object.values(config.sandboxes || {})) {
      // The OLD dir is whatever accountId the sandbox pointed at BEFORE rewrite.
      // The reverse-map: find the original accountId via idRemap inverse (the sandbox's
      // current accountId is the survivor; the original is its sbx_<id> suffix when
      // ids were 1:1 in v4 — true for any sandbox the system created itself).
      const originalAccountIdFromSbxId = sbx.id.startsWith('sbx_') ? sbx.id.slice(4) : null;
      const candidates = [
        originalAccountIdFromSbxId,   // most common case under v4's 1:1 convention
        sbx.accountId,                 // post-rewrite survivor dir, if it exists
      ].filter(Boolean);
      const oldDir = (await Promise.all(candidates.map(async c => {
        const p = path.join(sandboxesRoot, c);
        try { await fs.access(p); return p; } catch { return null; }
      }))).find(Boolean);
      if (!oldDir) continue;  // nothing to move (sandbox never had a runtime dir yet)

      const newDir = path.join(sandboxesRoot, sbx.id);
      // Skip if target already populated — caller intentionally pre-staged it
      try {
        const entries = await fs.readdir(newDir);
        if (entries.length > 0) continue;
      } catch { /* newDir doesn't exist, good */ }

      if (oldDir === newDir) continue;  // already correctly keyed
      await fs.mkdir(path.dirname(newDir), { recursive: true });
      try {
        await fs.rename(oldDir, newDir);
        rekeyed++;
      } catch (renameErr) {
        throw new Error(
          `v4→v5 migration aborted: cannot rename ${oldDir} → ${newDir}: ${renameErr.message}. ` +
          `Likely causes: OneDrive sync is holding a file, or a Go bot is running. ` +
          `Stop any running agent processes, wait for OneDrive sync to settle, ` +
          `and restart the server. The pre-mutation backup is at ${backupPath}.`
        );
      }
    }
    console.log(`[migration] v4→v5 rekeyed ${rekeyed} runtime dirs`);

    // Step 4: extract secrets to credential store, strip from accounts[]
    let extracted = 0;
    for (const acct of config.accounts) {
      if (acct.publicKey && acct.secretKey) {
        await credStore().setCredentials(acct.id, { publicKey: acct.publicKey, secretKey: acct.secretKey });
        delete acct.publicKey;
        delete acct.secretKey;
        extracted++;
      }
    }

    console.log(`[migration] v4→v5: deduped ${beforeCount} accounts → ${survivors.length}, rewrote ${pointerRewrites} sandbox pointers, extracted ${extracted} credential sets, backup at ${backupPath}`);
  }

  // v5 → v6: exempt mechanical / price-only agents from emergency-alert wakes.
  // These strategies have no provision to act on intraday news, so an emergency
  // heartbeat just burns a full LLM beat to conclude "not relevant." Sets the
  // new respondsToEmergencyWakes flag to false, leaving any user-set value alone.
  if (rawSchemaVersion < 6) {
    const EMERGENCY_EXEMPT = new Set(['trend-prophet', 'mean-rev', 'harvest']);
    for (const agent of config.agents || []) {
      if (EMERGENCY_EXEMPT.has(agent.id) && agent.respondsToEmergencyWakes === undefined) {
        agent.respondsToEmergencyWakes = false;
      }
    }
  }

  // v6 → v7: Drift (earnings-drift) was added to the default roster after the
  // v5→v6 backfill and was omitted from its EMERGENCY_EXEMPT set, so configs
  // already at v6 left Drift responding to emergency-alert wakes — burning a
  // full LLM beat to conclude "outside my 17:00 ET window, ignored." Drift is
  // the same mechanical, news-insensitive class as the others; backfill the
  // flag for any still-undefined member of the (now complete) exempt set,
  // leaving any user-set value alone.
  if (rawSchemaVersion < 7) {
    const EMERGENCY_EXEMPT = new Set(['trend-prophet', 'mean-rev', 'harvest', 'drift']);
    for (const agent of config.agents || []) {
      if (EMERGENCY_EXEMPT.has(agent.id) && agent.respondsToEmergencyWakes === undefined) {
        agent.respondsToEmergencyWakes = false;
      }
    }
  }

  // v7 → v8: Prophet/Harvest pre-market wake schedule. Backfills three new
  // fields on the Prophet (id='default') and Harvest (id='harvest') records:
  // - heartbeatOverrides.pre_market: 86400 (silences intra-phase cadence)
  // - scheduledBeats: { times: ['09:15'], weekdaysOnly: true, exclusive: false }
  // - suppressPhaseSnaps: ['pre_market']
  // Required because mergeMissingDefaults only appends missing AGENT IDS — it
  // does not update existing records. Without this migration, the new
  // pre-market wake schedule silently does not apply on any existing sandbox.
  // Preserves user customizations:
  // - heartbeatOverrides.pre_market is only overwritten if currently undefined
  //   (Prophet had no override) or equal to the prior code default
  //   (Harvest had 3600). User-set values like 1200 or 7200 are preserved.
  // - scheduledBeats / suppressPhaseSnaps are only set if currently undefined.
  if (rawSchemaVersion < 8) {
    const PRIOR_PRE_MARKET_DEFAULTS = { default: undefined, harvest: 3600 };
    const NEW_SCHEDULED_BEATS = { times: ['09:15'], weekdaysOnly: true, exclusive: false };
    for (const agent of config.agents || []) {
      if (agent.id === 'default' || agent.id === 'harvest') {
        if (!agent.heartbeatOverrides) agent.heartbeatOverrides = {};
        const prior = PRIOR_PRE_MARKET_DEFAULTS[agent.id];
        if (agent.heartbeatOverrides.pre_market === prior) {
          agent.heartbeatOverrides.pre_market = 86400;
        }
        if (agent.scheduledBeats === undefined) {
          agent.scheduledBeats = { ...NEW_SCHEDULED_BEATS };
        }
        if (agent.suppressPhaseSnaps === undefined) {
          agent.suppressPhaseSnaps = ['pre_market'];
        }
      }
    }
  }

  config.schemaVersion = 8;  // was 7
  if (!config.sandboxes) config.sandboxes = {};

  // Only auto-create sbx_<accountId> sandboxes during the v4→v5 migration pass.
  // On v5+ boots this loop must NOT run: accounts added via the UI after migration
  // should not get ghost sandboxes (spec Decision 3: no auto-sandbox on addAccount).
  if (rawSchemaVersion < 5) {
    for (const account of config.accounts || []) {
      const sandboxId = `sbx_${account.id}`;
      if (!config.sandboxes[sandboxId]) {
        config.sandboxes[sandboxId] = createSandbox(account, {
          id: sandboxId,
          name: account.name,
          activeAgentId: config.activeAgentId,
          activeModel: config.activeModel,
          heartbeat: config.heartbeat,
          permissions: config.permissions,
          plugins: config.plugins,
        });
      } else {
        config.sandboxes[sandboxId] = mergeSandbox({
          ...config.sandboxes[sandboxId],
          id: sandboxId,
          accountId: account.id,
          name: config.sandboxes[sandboxId].name || account.name,
        }, config);
      }
    }
  }

  if (!config.activeAccountId) {
    config.activeAccountId = config.accounts[0]?.id || null;
  }
  if (!config.activeSandboxId && config.activeAccountId) {
    config.activeSandboxId = `sbx_${config.activeAccountId}`;
  }

  syncLegacyAliases(config);
  return config;
}

function syncLegacyAliases(config) {
  const sandbox = getActiveSandboxFromConfig(config);
  if (!sandbox) return;
  config.activeAccountId = sandbox.accountId;
  config.activeSandboxId = sandbox.id;
  config.activeAgentId = sandbox.agent.activeAgentId;
  config.activeModel = sandbox.agent.model;
  config.heartbeat = { ...sandbox.heartbeat };
  config.permissions = { ...sandbox.permissions };
  config.plugins = mergePlugins(sandbox.plugins || {});
}

function getActiveSandboxFromConfig(config) {
  if (!config) return null;
  if (config.activeSandboxId && config.sandboxes?.[config.activeSandboxId]) {
    return config.sandboxes[config.activeSandboxId];
  }
  if (config.activeAccountId) {
    return Object.values(config.sandboxes || {}).find(s => s.accountId === config.activeAccountId) || null;
  }
  return Object.values(config.sandboxes || {})[0] || null;
}

let _config = null;
let _writeLock = Promise.resolve();

export async function loadConfig() {
  await credStore().loadCredentialStore(getSecretsPath());
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf-8');
    _config = await normalizeConfig(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      _config = createDefaultConfig();
    } else {
      console.error('Failed to load config:', err.message);
      throw err;
    }
  }

  syncLegacyAliases(_config);
  await saveConfig();
  return _config;
}

export async function saveConfig() {
  _writeLock = _writeLock.then(async () => {
    syncLegacyAliases(_config);
    const cfgPath = getConfigPath();
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, JSON.stringify(_config, null, 2));
  }).catch(err => console.error('Config save error:', err.message));
  return _writeLock;
}

export function getConfig() {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

export function getSandboxes() {
  return Object.values(getConfig().sandboxes || {});
}

export function getSandbox(id) {
  return getConfig().sandboxes?.[id] || null;
}

export function getSandboxByAccountId(accountId) {
  return getSandboxes().find(s => s.accountId === accountId) || null;
}

export function getActiveSandbox() {
  return getActiveSandboxFromConfig(getConfig());
}

export async function setActiveSandbox(id) {
  const sandbox = getSandbox(id);
  if (!sandbox) throw new Error('Sandbox not found');
  _config.activeSandboxId = id;
  _config.activeAccountId = sandbox.accountId;
  syncLegacyAliases(_config);
  await saveConfig();
  return sandbox;
}

function updateSandbox(accountId, updater) {
  const sandbox = getSandboxByAccountId(accountId) || getActiveSandbox();
  if (!sandbox) throw new Error('Sandbox not found');
  const updated = updater({ ...sandbox });
  updated.updatedAt = new Date().toISOString();
  _config.sandboxes[sandbox.id] = mergeSandbox(updated, _config);
  if (_config.activeSandboxId === sandbox.id) syncLegacyAliases(_config);
  return _config.sandboxes[sandbox.id];
}

// ── Accounts ───────────────────────────────────────────────────────

export async function addAccount({ name, publicKey, secretKey, baseUrl, paper }) {
  if (!publicKey || !secretKey) throw new Error('publicKey and secretKey are required');
  const id = crypto.randomUUID().slice(0, 8);
  const account = {
    id,
    name: name || `Account ${_config.accounts.length + 1}`,
    baseUrl: baseUrl || (paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets'),
    paper: paper !== false,
    createdAt: new Date().toISOString(),
  };
  _config.accounts.push(account);
  await saveConfig();
  try {
    await credStore().setCredentials(id, { publicKey, secretKey });
  } catch (err) {
    // Roll back the metadata push so we never persist an account without creds.
    _config.accounts = _config.accounts.filter(a => a.id !== id);
    await saveConfig();
    throw err;
  }
  syncLegacyAliases(_config);
  await saveConfig();
  return { ...account, publicKey, secretKey };
}

export async function updateAccount(id, { name, baseUrl, paper, publicKey, secretKey }) {
  const account = _config.accounts.find(a => a.id === id);
  if (!account) throw new Error('Account not found');
  if (name !== undefined && name.trim()) account.name = name.trim();
  if (baseUrl !== undefined) account.baseUrl = baseUrl.trim() || (account.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets');
  if (paper !== undefined) account.paper = paper;

  const hasPk = publicKey !== undefined && publicKey !== '';
  const hasSk = secretKey !== undefined && secretKey !== '';
  if (hasPk !== hasSk) {
    throw new Error('Rotation requires both publicKey and secretKey (or neither)');
  }
  if (hasPk && hasSk) {
    await credStore().setCredentials(id, { publicKey, secretKey });
  }

  // Keep sandbox name in sync when account name changes — but only sandboxes
  // that still carry the legacy 1:1 default sandbox name.
  if (name !== undefined && name.trim()) {
    for (const sandbox of Object.values(_config.sandboxes || {})) {
      if (sandbox.accountId === id && sandbox.name === account.name) {
        sandbox.name = name.trim();
      }
    }
  }
  syncLegacyAliases(_config);
  await saveConfig();
  return account;
}

export async function removeAccount(id) {
  _config.accounts = _config.accounts.filter(a => a.id !== id);
  await credStore().deleteCredentials(id);
  // Sandbox cleanup is the API layer's job — under the new model, the API
  // returns 409 if any sandbox references this account, so we only get here
  // when no sandboxes remain. Defensive deletion of any sbx_<id> orphan:
  if (_config.sandboxes[`sbx_${id}`]) delete _config.sandboxes[`sbx_${id}`];
  if (_config.activeAccountId === id) {
    const next = _config.accounts[0]?.id || null;
    _config.activeAccountId = next;
    _config.activeSandboxId = next ? Object.values(_config.sandboxes).find(s => s.accountId === next)?.id || null : null;
  }
  syncLegacyAliases(_config);
  await saveConfig();
}

export async function setActiveAccount(id) {
  if (!_config.accounts.find(a => a.id === id)) throw new Error('Account not found');
  _config.activeAccountId = id;
  _config.activeSandboxId = `sbx_${id}`;
  syncLegacyAliases(_config);
  await saveConfig();
}

export async function createSandboxForAccount(accountId, { name, agentId } = {}) {
  const account = _config.accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');
  const sandboxId = `sbx_${crypto.randomUUID().slice(0, 8)}`;
  const sandbox = createSandbox(account, {
    id: sandboxId,
    name: name || account.name,
    activeAgentId: agentId || _config.activeAgentId,
    activeModel: _config.activeModel,
    heartbeat: _config.heartbeat,
    permissions: _config.permissions,
    plugins: _config.plugins,
  });
  _config.sandboxes[sandboxId] = sandbox;
  if (!_config.activeSandboxId) {
    _config.activeSandboxId = sandboxId;
    _config.activeAccountId = accountId;
  }
  syncLegacyAliases(_config);
  await saveConfig();
  return sandbox;
}

export function getActiveAccount() {
  return _config.accounts.find(a => a.id === _config.activeAccountId) || null;
}

export function getAccountById(id) {
  const meta = _config.accounts.find(a => a.id === id);
  if (!meta) return null;
  const creds = credStore().getCredentials(id) || { publicKey: null, secretKey: null };
  // Metadata may still carry publicKey/secretKey on a v4 config (pre-migration).
  // Spread order: meta first, creds second — credential-store wins when present.
  return { ...meta, ...creds };
}

// ── Agents ─────────────────────────────────────────────────────────

export async function addAgent(agent) {
  const id = crypto.randomUUID().slice(0, 8);
  const newAgent = {
    id,
    name: agent.name || 'New Agent',
    description: agent.description || '',
    systemPromptTemplate: agent.systemPromptTemplate || 'custom',
    customSystemPrompt: agent.customSystemPrompt || '',
    strategyId: agent.strategyId || null,
    model: agent.model || _config.activeModel,
    heartbeatOverrides: agent.heartbeatOverrides || {},
    createdAt: new Date().toISOString(),
  };
  _config.agents.push(newAgent);
  await saveConfig();
  return newAgent;
}

export async function updateAgent(id, updates) {
  const idx = _config.agents.findIndex(a => a.id === id);
  if (idx === -1) throw new Error('Agent not found');
  const oldAgent = _config.agents[idx];
  _config.agents[idx] = { ...oldAgent, ...updates, updatedAt: new Date().toISOString() };

  // Propagate model/strategy changes to all sandboxes using this agent
  const modelChanged = updates.model && updates.model !== oldAgent.model;
  const strategyChanged = updates.strategyId !== undefined && updates.strategyId !== oldAgent.strategyId;

  if (modelChanged || strategyChanged) {
    for (const sandbox of getSandboxes()) {
      if (sandbox.agent.activeAgentId !== id) continue;
      if (modelChanged) {
        _config.sandboxes[sandbox.id].agent.model = updates.model;
      }
      if (strategyChanged) {
        if (_config.sandboxes[sandbox.id].agent.overrides) {
          _config.sandboxes[sandbox.id].agent.overrides.customStrategyRules = null;
        }
      }
    }
    syncLegacyAliases(_config);
  }

  await saveConfig();
  return _config.agents[idx];
}

export async function removeAgent(id) {
  if (id === 'default') throw new Error('Cannot remove default agent');
  _config.agents = _config.agents.filter(a => a.id !== id);
  for (const sandbox of getSandboxes()) {
    if (sandbox.agent.activeAgentId === id) {
      _config.sandboxes[sandbox.id].agent.activeAgentId = 'default';
    }
  }
  syncLegacyAliases(_config);
  await saveConfig();
}

export async function setActiveAgent(id) {
  if (!_config.agents.find(a => a.id === id)) throw new Error('Agent not found');
  await updateSandboxAgentSelection(_config.activeSandboxId, { activeAgentId: id });
}

export function getActiveAgent() {
  return getResolvedAgentForSandbox(_config.activeSandboxId) || _config.agents[0];
}

export function getAgentById(id) {
  return _config.agents.find(a => a.id === id) || null;
}

export function getAgentForSandbox(sandboxId) {
  const sandbox = getSandbox(sandboxId);
  if (!sandbox) return null;
  return getAgentById(sandbox.agent.activeAgentId) || null;
}

export function getResolvedAgentForSandbox(sandboxId) {
  const sandbox = getSandbox(sandboxId);
  if (!sandbox) return null;

  const baseAgent = getAgentById(sandbox.agent.activeAgentId) || null;
  const overrides = sandbox.agent?.overrides || {};
  const resolved = {
    ...(baseAgent || {}),
    id: sandbox.agent.activeAgentId,
    model: sandbox.agent?.model || baseAgent?.model || _config.activeModel,
    heartbeatOverrides: {
      ...(baseAgent?.heartbeatOverrides || {}),
      ...(overrides.heartbeatOverrides || {}),
    },
    // Sandbox-level override replaces the agent default wholesale (vs. shallow-merging
    // a structured field like times[]/weekdaysOnly/exclusive partially, which would be
    // surprising). Empty {} from overrides is treated as "no override".
    scheduledBeats: (overrides.scheduledBeats && Object.keys(overrides.scheduledBeats).length > 0)
      ? overrides.scheduledBeats
      : (baseAgent?.scheduledBeats || null),
    sandboxId,
    accountId: sandbox.accountId,
    customStrategyRules: overrides.customStrategyRules ?? null,
  };

  if (overrides.name !== null) resolved.name = overrides.name;
  if (overrides.description !== null) resolved.description = overrides.description;
  if (overrides.systemPromptTemplate !== null) resolved.systemPromptTemplate = overrides.systemPromptTemplate;
  if (overrides.customSystemPrompt !== null) resolved.customSystemPrompt = overrides.customSystemPrompt;
  if (Object.prototype.hasOwnProperty.call(overrides, 'strategyId') && overrides.strategyId !== undefined) {
    resolved.strategyId = overrides.strategyId;
  }
  // sessionMode is read by the harness to decide whether to reset _sessionId
  // each beat ('fresh'), each pre_market boundary ('daily'), or never
  // ('continuous'). Sandbox override wins; otherwise inherit from the agent
  // definition; otherwise undefined (treated as 'continuous' by the harness).
  if (Object.prototype.hasOwnProperty.call(overrides, 'sessionMode') && overrides.sessionMode != null) {
    resolved.sessionMode = overrides.sessionMode;
  }

  return resolved;
}

export async function updateSandboxAgentOverrides(sandboxId, overrides) {
  const sandbox = getSandbox(sandboxId);
  if (!sandbox) throw new Error('Sandbox not found');

  _config.sandboxes[sandboxId] = mergeSandbox({
    ...sandbox,
    agent: {
      ...sandbox.agent,
      overrides: {
        ...(sandbox.agent?.overrides || {}),
        ...overrides,
        heartbeatOverrides: {
          ...(sandbox.agent?.overrides?.heartbeatOverrides || {}),
          ...(overrides.heartbeatOverrides || {}),
        },
      },
    },
    updatedAt: new Date().toISOString(),
  }, _config);

  if (_config.activeSandboxId === sandboxId) syncLegacyAliases(_config);
  await saveConfig();
  return _config.sandboxes[sandboxId];
}

export async function updateSandboxAgentSelection(sandboxId, updates) {
  const sandbox = getSandbox(sandboxId);
  if (!sandbox) throw new Error('Sandbox not found');
  const nextActiveAgentId = updates.activeAgentId ?? sandbox.agent.activeAgentId;
  const newAgent = _config.agents.find(a => a.id === nextActiveAgentId);
  if (!newAgent) throw new Error('Agent not found');

  const agentChanged = nextActiveAgentId !== sandbox.agent.activeAgentId;
  let mergedOverrides = {
    ...(sandbox.agent?.overrides || {}),
    ...(updates.overrides || {}),
    heartbeatOverrides: {
      ...(sandbox.agent?.overrides?.heartbeatOverrides || {}),
      ...(updates.overrides?.heartbeatOverrides || {}),
    },
  };
  if (agentChanged) {
    mergedOverrides.customStrategyRules = null;
    mergedOverrides.customSystemPrompt = null;
    mergedOverrides.systemPromptTemplate = null;
  }

  _config.sandboxes[sandboxId] = mergeSandbox({
    ...sandbox,
    agent: {
      ...sandbox.agent,
      ...updates,
      activeAgentId: nextActiveAgentId,
      model: agentChanged ? (newAgent.model || sandbox.agent.model) : (updates.model || sandbox.agent.model),
      overrides: mergedOverrides,
    },
    updatedAt: new Date().toISOString(),
  }, _config);

  if (_config.activeSandboxId === sandboxId) syncLegacyAliases(_config);
  await saveConfig();
  return _config.sandboxes[sandboxId];
}

export async function updateSandboxStrategyRules(sandboxId, rules) {
  return updateSandboxAgentOverrides(sandboxId, { customStrategyRules: rules });
}

// ── Strategies ─────────────────────────────────────────────────────

export async function addStrategy(strategy) {
  const id = crypto.randomUUID().slice(0, 8);
  const newStrategy = {
    id,
    name: strategy.name || 'New Strategy',
    description: strategy.description || '',
    rulesFile: null,
    customRules: strategy.customRules || '',
    createdAt: new Date().toISOString(),
  };
  _config.strategies.push(newStrategy);
  await saveConfig();
  return newStrategy;
}

export async function updateStrategy(id, updates) {
  const idx = _config.strategies.findIndex(s => s.id === id);
  if (idx === -1) throw new Error('Strategy not found');
  _config.strategies[idx] = { ..._config.strategies[idx], ...updates, updatedAt: new Date().toISOString() };
  await saveConfig();
  return _config.strategies[idx];
}

export async function removeStrategy(id) {
  if (id === 'v2-options') throw new Error('Cannot remove the canonical Prophet strategy (v2-options)');
  _config.strategies = _config.strategies.filter(s => s.id !== id);
  await saveConfig();
}

export function getStrategyById(id) {
  return _config.strategies.find(s => s.id === id) || null;
}

// ── Model ──────────────────────────────────────────────────────────

export async function setActiveModel(modelId) {
  await updateSandboxAgentSelection(_config.activeSandboxId, { model: modelId });
  _config.activeModel = modelId;
}

// ── Heartbeat ──────────────────────────────────────────────────────

export async function updateHeartbeat(phaseIntervals) {
  updateSandbox(_config.activeAccountId, sandbox => ({
    ...sandbox,
    heartbeat: { ...sandbox.heartbeat, ...phaseIntervals },
  }));
  await saveConfig();
}

export async function updateHeartbeatForSandbox(sandboxId, phaseIntervals) {
  const sandbox = getSandbox(sandboxId);
  if (!sandbox) throw new Error('Sandbox not found');
  _config.sandboxes[sandboxId] = mergeSandbox({
    ...sandbox,
    heartbeat: { ...sandbox.heartbeat, ...phaseIntervals },
    updatedAt: new Date().toISOString(),
  }, _config);
  if (_config.activeSandboxId === sandboxId) syncLegacyAliases(_config);
  await saveConfig();
}

export function getHeartbeatForPhase(phase) {
  const sandbox = getActiveSandbox();
  return sandbox?.heartbeat?.[phase] || _config.heartbeat?.[phase] || DEFAULT_HEARTBEAT[phase] || 600;
}

export function getHeartbeatForSandboxPhase(sandboxId, phase) {
  const sandbox = getSandbox(sandboxId);
  return sandbox?.heartbeat?.[phase] || DEFAULT_HEARTBEAT[phase] || 600;
}

export function getHeartbeatProfiles() {
  return HEARTBEAT_PROFILES;
}

export function getPhaseTimeRanges() {
  return PHASE_TIME_RANGES;
}

export async function applyHeartbeatProfile(sandboxId, profileKey) {
  const profile = HEARTBEAT_PROFILES[profileKey];
  if (!profile) throw new Error(`Unknown heartbeat profile: ${profileKey}`);
  await updateHeartbeatForSandbox(sandboxId, profile.phases);
}

export async function updatePhaseTimeRange(phase, range) {
  if (!PHASE_TIME_RANGES[phase]) throw new Error(`Unknown phase: ${phase}`);
  if (range.start !== undefined) PHASE_TIME_RANGES[phase].start = range.start;
  if (range.end !== undefined) PHASE_TIME_RANGES[phase].end = range.end;
}

// ── Permissions ───────────────────────────────────────────────────

export async function updatePermissions(perms) {
  updateSandbox(_config.activeAccountId, sandbox => ({
    ...sandbox,
    permissions: { ...sandbox.permissions, ...perms },
  }));
  await saveConfig();
}

export async function updatePermissionsForSandbox(sandboxId, perms) {
  const sandbox = getSandbox(sandboxId);
  if (!sandbox) throw new Error('Sandbox not found');
  _config.sandboxes[sandboxId] = mergeSandbox({
    ...sandbox,
    permissions: { ...sandbox.permissions, ...perms },
    updatedAt: new Date().toISOString(),
  }, _config);
  if (_config.activeSandboxId === sandboxId) syncLegacyAliases(_config);
  await saveConfig();
}

export function getPermissions() {
  const sandbox = getActiveSandbox();
  return sandbox?.permissions || _config.permissions || DEFAULT_PERMISSIONS;
}

export function getPermissionsForSandbox(sandboxId) {
  return getSandbox(sandboxId)?.permissions || DEFAULT_PERMISSIONS;
}

// ── Plugins ────────────────────────────────────────────────────────

export async function updatePlugin(pluginName, pluginConfig) {
  updateSandbox(_config.activeAccountId, sandbox => ({
    ...sandbox,
    plugins: {
      ...(sandbox.plugins || {}),
      [pluginName]: { ...((sandbox.plugins || {})[pluginName] || {}), ...pluginConfig },
    },
  }));
  await saveConfig();
}

export async function updatePluginForSandbox(sandboxId, pluginName, pluginConfig) {
  const sandbox = getSandbox(sandboxId);
  if (!sandbox) throw new Error('Sandbox not found');
  _config.sandboxes[sandboxId] = mergeSandbox({
    ...sandbox,
    plugins: {
      ...(sandbox.plugins || {}),
      [pluginName]: {
        ...((sandbox.plugins || {})[pluginName] || {}),
        ...pluginConfig,
      },
    },
    updatedAt: new Date().toISOString(),
  }, _config);
  if (_config.activeSandboxId === sandboxId) syncLegacyAliases(_config);
  await saveConfig();
}

export function getPlugin(pluginName) {
  const sandbox = getActiveSandbox();
  return sandbox?.plugins?.[pluginName] || _config.plugins?.[pluginName] || null;
}

export function getPluginForSandbox(sandboxId, pluginName) {
  return getSandbox(sandboxId)?.plugins?.[pluginName] || null;
}
