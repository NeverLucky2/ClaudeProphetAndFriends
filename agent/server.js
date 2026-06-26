#!/usr/bin/env node

// Prophet Agent Web Server - SSE streaming dashboard + agent control
import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';

const OPENCODE_BIN = process.platform === 'win32' ? 'cmd.exe' : 'opencode';
const OPENCODE_WIN_PREFIX = process.platform === 'win32' ? ['/c', 'opencode.cmd'] : [];
import axios from 'axios';
import { buildSystemPrompt } from './harness.js';
import { formatHeartbeatLine } from './heartbeat-line.js';
import { AnalysisScheduler } from './analysis-scheduler.js';
import ChatStore from './chat-store.js';
import AgentOrchestrator from './orchestrator.js';
import { migrateLegacyDataForSandbox } from './data-migration.js';
import {
  loadConfig, getConfig, saveConfig,
  addAccount, updateAccount, removeAccount, setActiveAccount, setActiveSandbox, getActiveAccount, getAccountById,
  addAgent, updateAgent, removeAgent, setActiveAgent, getActiveAgent, getAgentById, getResolvedAgentForSandbox,
  addStrategy, updateStrategy, removeStrategy,
  setActiveModel, getStrategyById,
  updateSandboxAgentOverrides, updateSandboxAgentSelection, updateSandboxStrategyRules,
  updateHeartbeat, updateHeartbeatForSandbox, getHeartbeatForPhase,
  updatePermissions, updatePermissionsForSandbox, getPermissions, getPermissionsForSandbox,
  updatePlugin, updatePluginForSandbox, getPlugin, getPluginForSandbox,
  getActiveSandbox, getSandbox, getHeartbeatForSandboxPhase, getSandboxes,
  getHeartbeatProfiles, getPhaseTimeRanges, applyHeartbeatProfile, updatePhaseTimeRange,
  createSandboxForAccount,
} from './config-store.js';
import { appendTrade, readTrades } from './trades-store.js';
import { filterEngineTrades } from './engine-trades.js';
import { readTips, createTip, dismissTip, getSources } from './tips-store.js';
import { scoreTips } from './tips-scorer.js';
import { promoteCandidate } from './tips-store.js';
import { addToUniverse } from './universe-store.js';
import { evaluateCandidate } from './options-eligibility.js';
import { addSource, removeSource, approveSuggestion, suppressSuggestion } from './tips-store.js';
import { listNewsCandidates } from './news-candidates.js';
import { matchTippedTrades } from './tips-scorer.js';
import { fetchFillsSummary, renderFillsSummaryLine, startOfEtTradingDayIso, claimConnectRecap } from './fills-summary.js';
import { SSE_KEEPALIVE_MS, sendSseKeepalive } from './sse-keepalive.js';
import { createLogBuffer, formatSseLogFrame, broadcastBufferedLine } from './log-buffer.js';
import { runReconciliationForSandbox, readReconciliationSummary } from './trade-reconciliation.js';
import { runReasoningDigestForSandbox, readReasoningDigestSummary } from './reasoning-digest.js';
import { readTradeGradesSummary } from '../scripts/trade-grades.mjs';
import { readRange, buildCostsResponse, _etDate as _etDateCS } from './cost-store.js';
import nodeFs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const PORT = process.env.AGENT_PORT || 3737;
const TRADING_BOT_PORT = process.env.TRADING_BOT_PORT || '4534';
const TRADING_BOT_URL = process.env.TRADING_BOT_URL || `http://localhost:${TRADING_BOT_PORT}`;

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Auth Middleware ────────────────────────────────────────────────
// Token-based auth. Set AGENT_AUTH_TOKEN env var to enable.
// Without it, server is open (for local dev). With it, all API routes require the token.
const AUTH_TOKEN = process.env.AGENT_AUTH_TOKEN || '';
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next(); // no token configured = open access
  // Allow health check unauthenticated
  if (req.path === '/api/health') return next();
  // Check Authorization header or query param
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (token === AUTH_TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <token> header.' });
}
app.use('/api', authMiddleware);

// ── Load Config ────────────────────────────────────────────────────
await loadConfig();
const initialActiveSandbox = getActiveSandbox();
if (initialActiveSandbox?.id) {
  const migration = await migrateLegacyDataForSandbox(initialActiveSandbox.id);
  if (migration.migrated) {
    console.log(`  Migrated legacy data into sandbox ${initialActiveSandbox.id}: ${migration.copied.join(', ')}`);
  }
}

// ── Agent Instance ─────────────────────────────────────────────────
const chatStore = new ChatStore();
const orchestrator = new AgentOrchestrator({
  chatStore,
  agentUrl: `http://localhost:${PORT}`,
  tradingBotBasePort: Number(TRADING_BOT_PORT),
});
const sseClients = new Set();
// Dashboard viewing sessions (client `sid`) that have already received the
// connect-time fills recap. A single tab reconnects to /api/events on every
// visibility toggle / idle drop / sleep-wake; keying the recap on the
// per-page-load sid collapses those reconnects to one recap. See claimConnectRecap.
const servedRecapSessions = new Set();
const boundOperationalHarnesses = new WeakSet();
const dailySummaryTimers = new Map();

// Every sandbox flows through the orchestrator. The "active sandbox" is purely
// a UI focus pointer (which sandbox the dashboard highlights, and which is the
// default when an API endpoint receives no sandboxId) — it does not select a
// different code path.
function getRuntimeForSandbox(sandboxId) {
  const id = sandboxId || getActiveSandbox()?.id;
  if (!id) return null;
  try {
    const runtime = orchestrator.ensureRuntime(id);
    bindOperationalHooks(runtime.harness);
    return runtime;
  } catch {
    return null;
  }
}

function getHarnessForSandbox(sandboxId) {
  return getRuntimeForSandbox(sandboxId)?.harness || null;
}

function getGoClientForSandbox(sandboxId) {
  return getRuntimeForSandbox(sandboxId)?.goAxios || null;
}

async function refreshHarnessConfigForSandbox(sandboxId, options = {}) {
  const targetHarness = getHarnessForSandbox(sandboxId);
  if (!targetHarness) return;
  await targetHarness.reloadConfig(options);
}

async function refreshAllHarnessConfigs(options = {}) {
  const tasks = [];
  for (const runtime of orchestrator.runtimes.values()) {
    if (runtime.harness) tasks.push(runtime.harness.reloadConfig(options));
  }
  await Promise.allSettled(tasks);
}

// Replay buffer for the console stream. The console renders two ephemeral event
// types — agent_log (the cost / heartbeat lines) and agent_text (the beat's actual
// report) — and neither can be reconstructed on reconnect (state/config are re-sent
// fresh in /api/events). Buffering both — and stamping each frame with a monotonic
// id — lets a reconnecting client backfill the lines it missed while the SSE stream
// was down (screen-off, sleep/wake, idle drop, tab hide). See log-buffer.js.
const logBuffer = createLogBuffer();

// Console-rendered events that must survive a reconnect. agent_text was the bug:
// it streams the beat's report but used to fall through to the fire-and-forget
// path, so a tab-hide mid-beat dropped the report while keeping the cost lines.
const BUFFERED_LOG_EVENTS = new Set(['agent_log', 'agent_text']);

function broadcast(event, data) {
  // Buffered events must be retained even when nobody is connected — that
  // disconnected window is exactly the gap the buffer exists to fill. The shared
  // helper stamps each frame's id/event so the live stream and the reconnect
  // backfill can never disagree on event type. See log-buffer.js (unit-tested).
  if (BUFFERED_LOG_EVENTS.has(event)) {
    broadcastBufferedLine(sseClients, logBuffer, event, data);
    return;
  }
  if (sseClients.size === 0) return; // skip serialization when no clients connected
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(msg);
  }
}

// Keep idle SSE connections warm. A quiet agent (the steady state after the
// regime / beat cost reductions) sends no events, so the browser/OS/proxy drops
// the idle stream and the dashboard reconnects. Fewer reconnects means less
// state/config re-send churn. (Reconnects no longer re-fire the fills recap —
// the duplicate "N fills today" lines — that is now guarded by per-session
// dedup at the /api/events handler; see claimConnectRecap. The keepalive can't
// stop visibility-driven reconnects, which were the dominant cause.) See
// sse-keepalive.js. unref() so the timer never keeps the process alive during
// shutdown.
const _sseKeepaliveTimer = setInterval(() => sendSseKeepalive(sseClients), SSE_KEEPALIVE_MS);
_sseKeepaliveTimer.unref?.();

const EVENTS = [
  'status', 'agent_log', 'agent_text', 'beat_start', 'beat_end',
  'tool_call', 'tool_result', 'heartbeat_change', 'schedule', 'trade',
];

for (const evt of EVENTS) {
  orchestrator.on(evt, (data) => {
    broadcast(evt, { ...data, timestamp: new Date().toISOString() });
  });
}

// Cross-sandbox reconciliation runner injected into the scheduler. Iterates
// running sandboxes, resolves each one's strategy tag + goAxios, and reconciles
// its trade log against the broker. Untagged agents (no strategyId) are skipped
// — their orders carry no tag to attribute. Soft-fail per sandbox.
async function runTradeReconciliationAllSandboxes(isoDate) {
  if (process.env.TRADE_RECONCILIATION_ENABLED === 'false') return; // default ON; kill switch
  const dayStartIso = startOfEtTradingDayIso();
  for (const runtime of orchestrator.runtimes.values()) {
    try {
      const sandboxId = runtime?.harness?.sandboxId;
      if (!sandboxId) continue;
      const resolved = getResolvedAgentForSandbox(sandboxId);
      const strategy = resolved?.strategyId;
      const goAxios = runtime.goAxios;
      if (!strategy || !goAxios) continue;
      await runReconciliationForSandbox({
        goAxios, sandboxId, strategy, agentName: resolved?.name,
        isoDate, dayStartIso, projectRoot: PROJECT_ROOT,
        readTradesFn: readTrades, fsImpl: nodeFs,
      });
    } catch {
      // soft-fail per sandbox — one bot down must not abort the rest
    }
  }
}

// Cross-sandbox reasoning-digest runner injected into the scheduler. Iterates
// running sandboxes, resolves each one's strategy + goAxios, and writes a daily
// teaching digest for the mechanical agents (Turtle, Coil). Other strategies are
// skipped by runReasoningDigestForSandbox. Gated by REASONING_DIGEST_ENABLED
// (default OFF). Soft-fail per sandbox.
async function runReasoningDigestAllSandboxes(isoDate) {
  if (process.env.REASONING_DIGEST_ENABLED !== 'true') return; // default OFF
  for (const runtime of orchestrator.runtimes.values()) {
    try {
      const sandboxId = runtime?.harness?.sandboxId;
      if (!sandboxId) continue;
      const resolved = getResolvedAgentForSandbox(sandboxId);
      const strategy = resolved?.strategyId;
      const goAxios = runtime.goAxios;
      if (!strategy || !goAxios) continue;
      await runReasoningDigestForSandbox({
        goAxios, sandboxId, strategy, agentName: resolved?.name,
        isoDate, projectRoot: PROJECT_ROOT, fsImpl: nodeFs,
      });
    } catch {
      // soft-fail per sandbox — one bot down must not abort the rest
    }
  }
}

// ── Analysis Scheduler ─────────────────────────────────────────────
const scheduler = new AnalysisScheduler({
  model: getConfig().activeModel || 'anthropic/claude-sonnet-4-6',
  onEmergencyWake: (reason) => orchestrator.triggerEmergencyHeartbeat(reason),
  getHealthySandboxUrl: () => {
    const runtime = orchestrator.listRuntimes().find(r => r.goReady && r.port);
    return runtime ? `http://localhost:${runtime.port}` : null;
  },
  runTradeReconciliation: runTradeReconciliationAllSandboxes,
  runReasoningDigest: runReasoningDigestAllSandboxes,
});
scheduler.on('agent_log', (data) => broadcast('agent_log', data));
scheduler.on('scheduler_job_start', ({ job, date }) => broadcast('agent_log', {
  message: `[Scheduler] Job started: ${job} for ${date}`, level: 'info', timestamp: new Date().toISOString(),
}));
scheduler.on('scheduler_job_end', ({ job, date, output }) => broadcast('agent_log', {
  message: `[Scheduler] Job complete: ${job} → ${output}`, level: 'success', timestamp: new Date().toISOString(),
}));

// ── Slack Notification Dispatcher ──────────────────────────────────
async function notifySlack(text, sandboxId) {
  try {
    const slack = sandboxId ? getPluginForSandbox(sandboxId, 'slack') : getPlugin('slack');
    if (!slack?.enabled || !slack?.webhookUrl) return;
    await axios.post(slack.webhookUrl, {
      text,
      channel: slack.channel || undefined,
    }, { timeout: 5000 });
  } catch (err) {
    console.error('Slack notification failed:', err.message);
  }
}

function slackEnabled(event, sandboxId) {
  const slack = sandboxId ? getPluginForSandbox(sandboxId, 'slack') : getPlugin('slack');
  return slack?.enabled && slack?.webhookUrl && slack?.notifyOn?.[event];
}

// Daily summary — schedule at 4:30 PM ET
function scheduleDailySummaryForHarness(targetHarness) {
  const sandboxId = targetHarness.sandboxId;
  const existing = dailySummaryTimers.get(sandboxId);
  if (existing) clearTimeout(existing);
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const target = new Date(et);
  target.setHours(16, 30, 0, 0);
  if (et >= target) target.setDate(target.getDate() + 1);
  const ms = target.getTime() - et.getTime();
  const timer = setTimeout(async () => {
    if (slackEnabled('dailySummary', sandboxId)) {
      try {
        const client = getGoClientForSandbox(sandboxId);
        if (!client) return;
        const { data: acc } = await client.get('/api/v1/account');
        const equity = Number(acc.PortfolioValue || acc.portfolio_value || acc.Equity || acc.equity || 0);
        const lastEquity = Number(acc.LastEquity || acc.last_equity || 0);
        const pnl = equity - lastEquity;
        const pnlPct = lastEquity ? ((pnl / lastEquity) * 100).toFixed(2) : '0.00';
        const emoji = pnl >= 0 ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
        notifySlack(`${emoji} *Daily Summary*\nP&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)\nPortfolio: $${equity.toFixed(2)}\nBeats: ${targetHarness.state.stats.totalBeats} | Trades: ${targetHarness.state.stats.trades} | Errors: ${targetHarness.state.stats.errors}`, sandboxId);
      } catch {}
    }
    scheduleDailySummaryForHarness(targetHarness);
  }, ms);
  dailySummaryTimers.set(sandboxId, timer);
}

function bindOperationalHooks(targetHarness) {
  if (!targetHarness || boundOperationalHarnesses.has(targetHarness)) return;
  boundOperationalHarnesses.add(targetHarness);

  targetHarness.state.on('status', (data) => {
    const sandboxId = targetHarness.sandboxId;
    if (!slackEnabled('agentStartStop', sandboxId)) return;
    if (data.status === 'started') {
      notifySlack(`:rocket: *Prophet Agent Started*\nAgent: ${data.agent || 'Unknown'}\nModel: ${data.model || 'Unknown'}\nAccount: ${data.account || 'N/A'}`, sandboxId);
    } else if (data.status === 'stopped') {
      notifySlack(`:octagonal_sign: *Prophet Agent Stopped*`, sandboxId);
    }
  });

  targetHarness.state.on('trade', async (trade) => {
    const sandboxId = targetHarness.sandboxId;

    // Persist before the Slack notifications so a slow webhook doesn't delay
    // the disk write. Errors are soft-fail: log and continue, never throw.
    try {
      const sandbox = getSandbox(sandboxId);
      const accountId = sandbox?.accountId;
      const resolved = getResolvedAgentForSandbox(sandboxId);
      if (accountId) {
        await appendTrade(PROJECT_ROOT, accountId, {
          ...trade,
          sandboxId,
          agentId: resolved?.id || null,
          agentName: resolved?.name || null,
        });
      }
    } catch (err) {
      broadcast('agent_log', {
        message: `appendTrade failed: ${err.message}`,
        level: 'warning',
        sandboxId,
        timestamp: new Date().toISOString(),
      });
    }

    if (slackEnabled('tradeExecuted', sandboxId)) {
      const side = (trade.side || '').toUpperCase();
      const emoji = side === 'BUY' ? ':chart_with_upwards_trend:' : ':chart_with_downwards_trend:';
      notifySlack(`${emoji} *Trade Executed*\n${side} ${trade.quantity || '?'}x ${trade.symbol || '??'}${trade.price ? ' @ $' + trade.price : ''}\nTool: ${trade.tool || 'unknown'}`, sandboxId);
    }
    const sideLower = (trade.side || '').toLowerCase();
    if (sideLower === 'buy' && slackEnabled('positionOpened', sandboxId)) {
      notifySlack(`:new: *Position Opened*\n${trade.symbol || '??'} | ${trade.quantity || '?'} contracts${trade.price ? ' @ $' + trade.price : ''}`, sandboxId);
    }
    if (sideLower === 'sell' && slackEnabled('positionClosed', sandboxId)) {
      notifySlack(`:checkered_flag: *Position Closed*\n${trade.symbol || '??'} | ${trade.quantity || '?'} contracts${trade.price ? ' @ $' + trade.price : ''}`, sandboxId);
    }
  });

  targetHarness.state.on('agent_log', (data) => {
    const sandboxId = targetHarness.sandboxId;
    if (data.level !== 'error' || !slackEnabled('errors', sandboxId)) return;
    notifySlack(`:warning: *Prophet Error*\n${data.message}`, sandboxId);
  });

  targetHarness.state.on('beat_start', (data) => {
    const sandboxId = targetHarness.sandboxId;
    if (!slackEnabled('heartbeat', sandboxId)) return;
    notifySlack(`:heartbeat: Beat #${data.beat} | Phase: ${data.phase}`, sandboxId);
  });

  targetHarness.state.on('beat_end', async () => {
    try {
      const sandboxId = targetHarness.sandboxId;
      const perms = getPermissionsForSandbox(sandboxId);
      if (!perms.maxDailyLoss || perms.maxDailyLoss <= 0) return;
      const client = getGoClientForSandbox(sandboxId);
      if (!client) return;
      const { data: acc } = await client.get('/api/v1/account', { timeout: 3000 });
      const equity = Number(acc.PortfolioValue || acc.portfolio_value || acc.Equity || acc.equity || 0);
      const lastEquity = Number(acc.LastEquity || acc.last_equity || 0);
      if (!lastEquity) return;
      const dayLossPct = ((equity - lastEquity) / lastEquity) * 100;
      if (dayLossPct <= -perms.maxDailyLoss && !targetHarness.state.paused) {
        targetHarness.pause();
        const msg = `CIRCUIT BREAKER: Daily loss ${dayLossPct.toFixed(2)}% exceeds -${perms.maxDailyLoss}% limit. Agent auto-paused.`;
        broadcast('agent_log', { message: msg, level: 'error', sandboxId, timestamp: new Date().toISOString() });
        if (slackEnabled('errors', sandboxId)) notifySlack(`:rotating_light: ${msg}`, sandboxId);
      }
    } catch { /* silently skip if account unavailable */ }
  });

  // Heartbeat console line — a one-line "heartbeat processed" confirmation in the agent's dashboard
  // console on each PROCESSED beat (preflight-skipped beats stay quiet; they already log their own
  // skip line). Tool calls + trades are counted from THIS beat's own events, reset at beat_start —
  // sidesteps the cumulative-stats double-increment. Default on; HEARTBEAT_CONSOLE=false disables.
  // Go-scheduled agents (Turtle/def-Prophet) emit their own line from the Go scheduler, carried to
  // the Go console by the existing stdout→goLog forwarder.
  let hbToolCalls = 0;
  let hbTrades = 0;
  targetHarness.state.on('beat_start', () => { hbToolCalls = 0; hbTrades = 0; });
  targetHarness.state.on('tool_call', () => { hbToolCalls += 1; });
  targetHarness.state.on('trade', () => { hbTrades += 1; });
  targetHarness.state.on('beat_end', (data) => {
    if (process.env.HEARTBEAT_CONSOLE === 'false') return;
    if (data?.skipped) return;
    const sandboxId = targetHarness.sandboxId;
    const resolved = getResolvedAgentForSandbox(sandboxId);
    const etTime = new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    broadcast('agent_log', {
      message: formatHeartbeatLine({
        agent: resolved?.name, phase: data?.phase, etTime, toolCalls: hbToolCalls, trades: hbTrades,
      }),
      level: 'info',
      sandboxId,
      timestamp: new Date().toISOString(),
    });
  });

  scheduleDailySummaryForHarness(targetHarness);
}

// Write a per-agent fills recap to a single freshly-connected SSE client. Not a
// broadcast — opening a second dashboard must not re-spam everyone. Mirrors the
// harness start-path recap so a mid-day dashboard open surfaces the same
// broker-side fills. Soft-fail per sandbox.
async function emitConnectFillsSummaries(res) {
  for (const runtime of orchestrator.runtimes.values()) {
    try {
      const harness = runtime?.harness;
      if (!harness?.state?.running) continue;
      const sandboxId = harness.sandboxId;
      const resolved = getResolvedAgentForSandbox(sandboxId);
      const strategy = resolved?.strategyId;
      const goAxios = runtime.goAxios;
      if (!strategy || !goAxios) continue;
      const summary = await fetchFillsSummary(goAxios, strategy, startOfEtTradingDayIso());
      const line = renderFillsSummaryLine(summary, resolved?.name);
      if (line && sseClients.has(res)) {
        const data = { message: line, level: 'success', sandboxId, timestamp: new Date().toISOString() };
        res.write(`event: agent_log\ndata: ${JSON.stringify(data)}\n\n`);
      }
    } catch {
      // soft-fail: best-effort recap per sandbox
    }
  }
}

// ── SSE Endpoint ───────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const activeId = getActiveSandbox()?.id || null;
  const activeRuntime = activeId ? orchestrator.getSandboxRuntime(activeId) : null;
  const state = activeRuntime ? activeRuntime.harness.state.toJSON() : { running: false };
  res.write(`event: state\ndata: ${JSON.stringify({ ...state, sandboxId: activeId })}\n\n`);
  res.write(`event: config\ndata: ${JSON.stringify(safeConfig())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));

  // Backfill the console: replay the console lines this client missed while its SSE
  // stream was down. The client passes the highest id it has rendered as ?since=;
  // the browser also sends it as Last-Event-ID on a native auto-reconnect. A
  // fresh page load (no cursor) replays nothing — the live stream + fills recap
  // cover it, and dumping the whole window would double-render. Replaying after
  // add()ing to sseClients means a line broadcast mid-replay is never dropped;
  // the client dedupes by id so any overlap renders once. See log-buffer.js.
  const sinceCursor = req.query?.since ?? req.headers['last-event-id'];
  if (sinceCursor != null && sinceCursor !== '') {
    for (const entry of logBuffer.since(sinceCursor)) {
      res.write(formatSseLogFrame(entry));
    }
  }

  // Trigger B: surface each running agent's day fills to this client only, and
  // only on the first connect of a given dashboard viewing session. The client
  // tears down + rebuilds this stream on every tab hide/show (visibilitychange),
  // so without per-session dedup the recap re-fires repeatedly — the duplicate
  // "N fills today" lines. claimConnectRecap returns false for a sid we've
  // already served (a reconnect); a missing sid falls back to always-emit.
  if (process.env.FILLS_SUMMARY_ENABLED !== 'false'
      && claimConnectRecap(servedRecapSessions, req.query?.sid)) {
    void emitConnectFillsSummaries(res);
  }
});

// ── Agent Control ──────────────────────────────────────────────────
// These operate on the currently-active sandbox (UI focus). For explicit
// per-sandbox control, see /api/sandboxes/:id/start|stop|pause|resume.
app.post('/api/agent/start', async (req, res) => {
  try {
    const id = getActiveSandbox()?.id;
    if (!id) return res.status(404).json({ error: 'No active sandbox' });
    await orchestrator.startSandbox(id);
    res.json({ ok: true, status: 'started' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/stop', async (req, res) => {
  const id = getActiveSandbox()?.id;
  if (id) await orchestrator.stopSandbox(id);
  res.json({ ok: true, status: 'stopped' });
});

app.post('/api/agent/pause', (req, res) => {
  const id = getActiveSandbox()?.id;
  if (id) orchestrator.pauseSandbox(id);
  res.json({ ok: true, status: 'paused' });
});

app.post('/api/agent/resume', (req, res) => {
  const id = getActiveSandbox()?.id;
  if (id) orchestrator.resumeSandbox(id);
  res.json({ ok: true, status: 'resumed' });
});

// ── Manager Chat ───────────────────────────────────────────────────
let _managerSessionId = null;
let _managerProc = null;
const _managerSessions = []; // { id, startTime, messageCount }

app.get('/api/manager/config', (req, res) => {
  const config = getConfig();
  const mgr = config.manager || { model: config.activeModel, customPrompt: '' };
  res.json({ model: mgr.model, customPrompt: mgr.customPrompt || '', sessions: _managerSessions, activeSessionId: _managerSessionId });
});

app.put('/api/manager/config', async (req, res) => {
  try {
    const config = getConfig();
    if (!config.manager) config.manager = {};
    if (req.body.model !== undefined) config.manager.model = req.body.model;
    if (req.body.customPrompt !== undefined) config.manager.customPrompt = req.body.customPrompt;
    await saveConfig();
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/manager/new-session', (req, res) => {
  if (_managerProc) { try { _managerProc.kill('SIGTERM'); } catch {} _managerProc = null; }
  _managerSessionId = null;
  res.json({ ok: true });
});

app.post('/api/manager/stop', (req, res) => {
  if (_managerProc) {
    try { _managerProc.kill('SIGTERM'); } catch {}
    _managerProc = null;
    broadcast('manager_done', {});
  }
  res.json({ ok: true });
});

app.get('/api/manager/sessions', (req, res) => {
  res.json({ sessions: _managerSessions, activeSessionId: _managerSessionId });
});

app.post('/api/manager/message', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    const config = getConfig();
    const mgr = config.manager || {};
    const model = mgr.model || config.activeModel || 'anthropic/claude-sonnet-4-6';
    const ocModel = model.includes('/') ? model : `anthropic/${model}`;
    const customPromptAddition = mgr.customPrompt ? `\n\n## Custom Instructions\n${mgr.customPrompt}` : '';
    
    const managerPrompt = `You are the OpenProphet Manager — a configuration and research assistant.

## CRITICAL: You do NOT trade. You NEVER place orders, buy, or sell anything.

You help the user:
- Create and configure trading agents (their personality and model)
- Create and edit strategies (the rules agents follow)
- Assign agents and strategies to accounts
- Research markets, analyze stocks, gather news
- Configure heartbeats, permissions, and session modes

## Your Available Tools

**Configuration** (your primary tools):
- create_agent: Create a new agent with name, description, model, and optional custom identity prompt
- create_strategy: Create a new strategy with name, description, and trading rules (markdown)
- assign_agent_to_sandbox: Assign an agent to an account to activate it
- update_agent_prompt: Update the current account's agent identity prompt
- update_strategy_rules: Update the current account's strategy rules
- get_agent_config: View current configuration

**Research** (for helping users make informed decisions):
- analyze_stocks: Technical analysis with RSI, trend, support/resistance
- get_quote, get_latest_bar, get_historical_bars: Price data
- search_news, get_market_news, get_quick_market_intelligence: News
- find_similar_setups, get_trade_stats: Historical trade patterns

**System**:
- get_heartbeat_profiles, apply_heartbeat_profile, set_heartbeat: Heartbeat config
- update_permissions: Update trading permissions/guardrails
- get_datetime: Current time and market status

## How Agents and Strategies Work

An **Agent** is a personality — it has a name, description, model choice, and optionally a custom identity prompt that defines how it thinks and approaches trading.

A **Strategy** is a set of hard rules — position sizes, stop losses, what instruments to trade, risk limits, exit criteria. Written in markdown.

The final instructions sent to the AI = Agent Identity + Strategy Rules + System Tools/Heartbeat.

When creating an agent:
1. First create_strategy with the trading rules
2. Then create_agent with the personality, linking the strategy
3. Then assign_agent_to_sandbox to activate it on an account

## Instructions
- Be direct and actionable
- If the user describes an agent, create both the strategy and agent immediately
- Don't ask unnecessary questions — use reasonable defaults
- When creating strategies, write comprehensive markdown rules covering: what to trade, position sizing, risk management, entry/exit criteria, and any special instructions

## Current Time
${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET

## User Message
${message.trim()}${customPromptAddition}`;

    const args = ['run', '--format', 'json', '--model', ocModel];
    if (_managerSessionId) args.push('--session', _managerSessionId);

    const isNewSession = !_managerSessionId;
    const fullPrompt = isNewSession 
      ? managerPrompt
      : `[Manager] User message:\n${message.trim()}`;
    
    // Track session
    if (isNewSession) {
      _managerSessions.push({ id: null, startTime: new Date().toISOString(), messageCount: 1, model: ocModel });
    } else {
      const last = _managerSessions[_managerSessions.length - 1];
      if (last) last.messageCount++;
    }

    // Kill any existing manager process
    if (_managerProc) { try { _managerProc.kill('SIGTERM'); } catch {} }

    // On Windows, cmd.exe cannot handle multiline prompts as CLI args — write to temp file
    let tempPromptFile = null;
    if (process.platform === 'win32') {
      const os = await import('os');
      tempPromptFile = path.join(os.tmpdir(), `prophet_mgr_${Date.now()}.txt`);
      await fs.writeFile(tempPromptFile, fullPrompt, 'utf-8');
      args.push('Process the full prompt from the attached file.', '--file', tempPromptFile);
    }

    const proc = spawn(OPENCODE_BIN, [...OPENCODE_WIN_PREFIX, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.CLAUDE_API_KEY || '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    _managerProc = proc;

    if (process.platform !== 'win32') {
      proc.stdin.write(fullPrompt);
    }
    proc.stdin.end();

    // Return immediately - streaming happens via SSE
    res.json({ ok: true, streaming: true, model: ocModel });

    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          const part = evt.part || {};
          
          if (evt.type === 'text') {
            const text = part.text || evt.text || '';
            if (text) broadcast('manager_text', { text });
          } else if (evt.type === 'tool_call') {
            const name = part.name || part.tool || evt.name || '?';
            const args = part.args || part.input || {};
            broadcast('manager_tool', { name, args });
          } else if (evt.type === 'tool_result') {
            const name = part.name || '?';
            const result = String(part.result || part.output || '').substring(0, 200);
            broadcast('manager_tool_result', { name, result });
          }
          
          // Capture session ID
          if (evt.sessionID) {
            _managerSessionId = evt.sessionID;
          }
        } catch {}
      }
    });

    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      if (_managerProc === proc) _managerProc = null;
      if (tempPromptFile) fs.unlink(tempPromptFile).catch(() => {});
      const last = _managerSessions[_managerSessions.length - 1];
      if (last && !last.id && _managerSessionId) last.id = _managerSessionId;
      broadcast('manager_done', {});
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/agent/message', async (req, res) => {
  try {
    const { message, sandboxId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    // Check for commands
    const trimmed = message.trim();
    const config = getConfig();
    
    // /help - show available commands
    if (trimmed === '/help' || trimmed === '/?') {
      const helpText = `Available commands:

/newagent - Create a new agent
/editagent <id> - Edit an existing agent
/agents - List all agents
/sandboxes - List all sandboxes (portfolios)
/start <sandboxId> - Start agent on a sandbox
/stop <sandboxId> - Stop agent on a sandbox
/status - Show status of all portfolios
/portfolios - Show status of all portfolios

Models: ${(config.models || []).length} available
Providers: ${[...new Set((config.models || []).map(m => m.id.split('/')[0]))].join(', ')}

Use /newagent to open the agent builder!`;
      return res.json({ ok: true, text: helpText });
    }
    
    // /newagent - open agent builder
    if (trimmed === '/newagent' || trimmed.startsWith('/newagent ')) {
      const models = config.models || [];
      const strategies = config.strategies || [];
      broadcast('agent_builder', {
        mode: 'create',
        models,
        strategies,
        sandboxId: sandboxId || getActiveSandbox()?.id,
      });
      return res.json({ ok: true, builder: true });
    }
    
    // /editagent - open agent editor
    const editMatch = trimmed.match(/^\/editagent\s+(\S+)/);
    if (editMatch) {
      const agentId = editMatch[1];
      const agent = getAgentById(agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const models = config.models || [];
      const strategies = config.strategies || [];
      broadcast('agent_builder', {
        mode: 'edit',
        agent,
        models,
        strategies,
        sandboxId: sandboxId || getActiveSandbox()?.id,
      });
      return res.json({ ok: true, builder: true });
    }
    
    // /agents - list agents
    if (trimmed === '/agents') {
      const agents = config.agents || [];
      let msg = 'Available agents:\n';
      for (const a of agents) {
        msg += `\n- ${a.name} (${a.id})\n  Model: ${a.model || 'default'}\n  Strategy: ${a.strategyId || 'none'}\n`;
      }
      msg += '\nUse /editagent <id> to edit an agent';
      return res.json({ ok: true, text: msg });
    }
    
    // /sandboxes - list sandboxes and their status
    if (trimmed === '/sandboxes') {
      const sandboxes = getSandboxes();
      let msg = 'Available sandboxes (portfolios):\n';
      for (const s of sandboxes) {
        const runtime = orchestrator.getSandboxRuntime(s.id);
        const running = runtime ? runtime.harness.state.running : false;
        msg += `\n- ${s.name} (${s.id})\n  Account: ${s.accountId}\n  Status: ${running ? 'running' : 'stopped'}\n  Agent: ${s.agent?.activeAgentId || 'default'}\n`;
      }
      msg += '\nUse /start <sandboxId> or /stop <sandboxId> to control';
      return res.json({ ok: true, text: msg });
    }

    // /start <sandboxId> - start agent on a specific sandbox
    const startMatch = trimmed.match(/^\/start\s+(\S+)/);
    if (startMatch) {
      const sbxId = startMatch[1];
      const sandbox = getSandbox(sbxId);
      if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });
      await orchestrator.startSandbox(sbxId);
      return res.json({ ok: true, text: `Started agent on sandbox ${sandbox.name}` });
    }

    // /stop <sandboxId> - stop agent on a specific sandbox
    const stopMatch = trimmed.match(/^\/stop\s+(\S+)/);
    if (stopMatch) {
      const sbxId = stopMatch[1];
      const sandbox = getSandbox(sbxId);
      if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });
      await orchestrator.stopSandbox(sbxId);
      return res.json({ ok: true, text: `Stopped agent on sandbox ${sandbox.name}` });
    }

    // /status - show status of all sandboxes
    if (trimmed === '/status' || trimmed === '/portfolio' || trimmed === '/portfolios') {
      const sandboxes = getSandboxes();
      const account = getActiveAccount();
      let msg = 'Portfolio Status:\n';
      msg += `\nActive: ${account?.name || 'none'} (${account?.paper ? 'paper' : 'live'})\n`;
      msg += '\nSandbox Status:\n';
      for (const s of sandboxes) {
        const runtime = orchestrator.getSandboxRuntime(s.id);
        const state = runtime ? runtime.harness.state.toJSON() : { running: false, beat: 0 };
        msg += `\n${s.name}: ${state.running ? 'running' : 'stopped'} (beat #${state.beat || 0})`;
      }
      return res.json({ ok: true, text: msg });
    }

    const activeId = getActiveSandbox()?.id;
    if (!activeId) return res.status(404).json({ error: 'No active sandbox' });
    const result = await orchestrator.sendMessage(activeId, trimmed);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/agent/state', (req, res) => {
  const id = getActiveSandbox()?.id;
  const runtime = id ? orchestrator.getSandboxRuntime(id) : null;
  res.json(runtime ? runtime.harness.state.toJSON() : { running: false });
});

// Multi-sandbox orchestration
app.get('/api/sandboxes', (req, res) => {
  const activeId = getActiveSandbox()?.id || null;
  const sandboxes = getSandboxes().map(sandbox => {
    const runtime = orchestrator.getSandboxRuntime(sandbox.id);
    return {
      ...sandbox,
      runtime: runtime ? runtime.harness.state.toJSON() : null,
      isActive: activeId === sandbox.id,
    };
  });
  res.json({ sandboxes });
});

app.post('/api/sandboxes', async (req, res) => {
  try {
    const { accountId, name, agentId } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const sandbox = await createSandboxForAccount(accountId, { name: String(name).trim(), agentId });
    broadcast('config', safeConfig());
    res.json({ ok: true, sandbox });
  } catch (err) {
    const code = /account not found/i.test(err.message) ? 400 : 500;
    res.status(code).json({ error: err.message });
  }
});

// ── Trade history ──────────────────────────────────────────────────
// Reads NDJSON files written by the per-runtime trade listener. Defaults to
// today (ET). Hard caps: max 90-day range, max 2000 trades returned.
app.get('/api/trades', async (req, res) => {
  const _etFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = _etFmt.format(new Date());
  const from = String(req.query.from || today);
  const to = String(req.query.to || today);
  const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;

  const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymdRe.test(from) || !ymdRe.test(to)) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  }
  if (from > to) {
    return res.status(400).json({ error: 'from must be <= to' });
  }
  const fromMs = Date.parse(from + 'T00:00:00Z');
  const toMs = Date.parse(to + 'T00:00:00Z');
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return res.status(400).json({ error: 'unparseable date' });
  }
  const days = (toMs - fromMs) / 86400000 + 1;
  if (days > 90) {
    return res.status(400).json({ error: 'range exceeds 90 days' });
  }

  try {
    const { trades, truncated } = await readTrades(PROJECT_ROOT, { from, to, sandboxId });
    res.json({ from, to, count: trades.length, truncated, trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tips & Influence Ledger (flag-gated, default OFF) ───────────────────────
// All routes 404 when ENABLE_TIPS_SCORECARD !== 'true', mirroring /api/v1/costs.
function tipsEnabled() { return process.env.ENABLE_TIPS_SCORECARD === 'true'; }

app.get('/api/tips/sources', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    res.json({ sources: await getSources(PROJECT_ROOT) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tips', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const all = await readTips(PROJECT_ROOT);
    const tips = req.query.includeDismissed === 'true' ? all : all.filter(t => !t.dismissed);
    tips.sort((a, b) => (b.surfacedAt || '').localeCompare(a.surfacedAt || ''));
    res.json({ count: tips.length, tips });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tips', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  const { ticker, thesis, source } = req.body || {};
  try {
    const tip = await createTip(PROJECT_ROOT, { ticker, thesis, source });
    res.status(201).json({ tip });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/tips/:id/dismiss', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const ok = await dismissTip(PROJECT_ROOT, req.params.id);
    if (!ok) return res.status(404).json({ error: 'tip not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tips/ledger', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const ledger = await scoreTips(PROJECT_ROOT, {});
    res.json({ ledger });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Standalone candidate eligibility (D6/D15) — read-only, options-liquidity-first.
app.get('/api/tips/candidates/:id/evaluate', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const tip = (await readTips(PROJECT_ROOT)).find(t => t.id === req.params.id);
    if (!tip) return res.status(404).json({ error: 'tip not found' });
    if (tip.phase !== 'pending_candidate') return res.status(400).json({ error: 'not a pending candidate' });
    const evaluation = await evaluateCandidate(PROJECT_ROOT, tip.ticker, {});
    res.json({ evaluation });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add-to-universe + promote (D7) — the sanctioned, human-gated write. Appends to
// the universe file (effective next restart) and flips the tip to active.
app.post('/api/tips/:id/promote', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const tip = (await readTips(PROJECT_ROOT)).find(t => t.id === req.params.id);
    if (!tip) return res.status(404).json({ error: 'tip not found' });
    if (tip.phase !== 'pending_candidate') return res.status(400).json({ error: 'not a pending candidate' });
    const universe = await addToUniverse(PROJECT_ROOT, tip.ticker, {});
    const promoted = await promoteCandidate(PROJECT_ROOT, tip.id);
    if (!promoted.ok) return res.status(409).json({ error: promoted.reason, universe });
    res.json({ ok: true, tip: promoted.tip, universe, note: 'Universe add takes effect on next agent restart.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Editable tip-source list (news reserved). GET already exists from Phase 1a.
app.post('/api/tips/sources', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const r = await addSource(PROJECT_ROOT, (req.body || {}).name);
    res.status(r.ok ? 201 : 409).json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.delete('/api/tips/sources/:name', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const r = await removeSource(PROJECT_ROOT, req.params.name);
    res.status(r.ok ? 200 : 409).json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// News-candidate feed (D14) — OOU suggestions only; approve -> candidate queue;
// dismiss -> suppress. Never triggers the agent, never a scored tip.
app.get('/api/tips/news-candidates', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try { res.json({ candidates: await listNewsCandidates(PROJECT_ROOT) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/tips/news-candidates/approve', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const { ticker, catalyst, feed, feedAt } = req.body || {};
    const tip = await approveSuggestion(PROJECT_ROOT, { ticker, catalyst, feed, feedAt });
    res.status(201).json({ tip });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/api/tips/news-candidates/dismiss', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const r = await suppressSuggestion(PROJECT_ROOT, (req.body || {}).ticker);
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Influenced trades for the Trades-tab badge.
app.get('/api/tips/influenced', async (req, res) => {
  if (!tipsEnabled()) return res.status(404).json({ error: 'tips ledger disabled' });
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const tips = await readTips(PROJECT_ROOT);
    const { trades } = await readTrades(PROJECT_ROOT, { from: String(from), to: String(to) });
    res.json({ influenced: matchTippedTrades(tips, trades, {}) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reconciliation summary for a date (default: today ET). Aggregates across
// sandboxes unless ?sandboxId= is given. Returns { date, mismatchCount, items }.
app.get('/api/reconciliation', async (req, res) => {
  const _etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = _etFmt.format(new Date());
  const date = String(req.query.date || today);
  const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const summary = await readReconciliationSummary(PROJECT_ROOT, { date, sandboxId }, { fs: nodeFs });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reasoning-digest?date=&sandboxId= — the day's Coil/Turtle teaching
// digest. Silent (empty items) when no report exists. Report-only.
app.get('/api/reasoning-digest', async (req, res) => {
  const _etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = _etFmt.format(new Date());
  const date = String(req.query.date || today);
  const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const summary = await readReasoningDigestSummary(PROJECT_ROOT, { date, sandboxId }, { fs: nodeFs });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/trade-grades?date=&sandboxId= — per-trade thesis-vs-outcome grades. Silent
// (empty items) when no report exists. Report-only.
app.get('/api/trade-grades', async (req, res) => {
  const _etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = _etFmt.format(new Date());
  const date = String(req.query.date || today);
  const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  try {
    const summary = await readTradeGradesSummary(PROJECT_ROOT, { date, sandboxId }, { fs: nodeFs });
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/engine-trades — trades placed directly by Go-scheduler agents (Turtle,
// DefensiveProphet), which bypass the LLM trade log. Sourced from broker order history
// (the shared account → any sandbox's Go client returns all of it). Soft-fails to an
// empty list with unavailable:true when the bot is unreachable, so the page never breaks.
app.get('/api/engine-trades', async (req, res) => {
  const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;
  const goAxios = getGoClientForSandbox(sandboxId);
  if (!goAxios) return res.json({ trades: [], unavailable: true });
  try {
    const resp = await goAxios.get('/api/v1/orders?status=all', { timeout: 5000 });
    const raw = Array.isArray(resp?.data) ? resp.data : [];
    res.json({ trades: filterEngineTrades(raw) });
  } catch {
    res.json({ trades: [], unavailable: true });
  }
});

// GET /api/v1/costs?days=N — returns aggregated per-agent cost data.
// Returns 404 when COST_TRACKING_ENABLED=false. Default days=7, max 90.
app.get('/api/v1/costs', async (req, res) => {
  if (process.env.COST_TRACKING_ENABLED === 'false') {
    return res.status(404).json({ error: 'cost tracking disabled' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const today = _etDateCS(new Date());
  const fromDate = new Date(`${today}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1));
  const from = fromDate.toISOString().slice(0, 10);
  try {
    const rangeData = await readRange(PROJECT_ROOT, { from, to: today });
    res.json(buildCostsResponse(rangeData, days, today));
  } catch (err) {
    res.status(500).json({ error: `cost endpoint failed: ${err.message}` });
  }
});

app.get('/api/sandboxes/:id/state', (req, res) => {
  try {
    res.json(orchestrator.getState(req.params.id));
  } catch (err) { res.status(404).json({ error: err.message }); }
});

app.post('/api/sandboxes/:id/start', async (req, res) => {
  try {
    await orchestrator.startSandbox(req.params.id);
    res.json({ ok: true, status: 'started', sandboxId: req.params.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/sandboxes/:id/stop', async (req, res) => {
  try {
    await orchestrator.stopSandbox(req.params.id);
    res.json({ ok: true, status: 'stopped', sandboxId: req.params.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/sandboxes/:id/pause', (req, res) => {
  try {
    orchestrator.pauseSandbox(req.params.id);
    res.json({ ok: true, status: 'paused', sandboxId: req.params.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/sandboxes/:id/resume', (req, res) => {
  try {
    orchestrator.resumeSandbox(req.params.id);
    res.json({ ok: true, status: 'resumed', sandboxId: req.params.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/sandboxes/:id/message', async (req, res) => {
  try {
    const { message } = req.body;
    const sandboxId = req.params.id;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    const config = getConfig();
    const trimmed = message.trim();
    
    // /newagent command
    if (trimmed === '/newagent') {
      broadcast('agent_builder', {
        mode: 'create',
        models: config.models || [],
        strategies: config.strategies || [],
        sandboxId,
      });
      const providers = [...new Set((config.models || []).map(m => m.id.split('/')[0]))].join(', ');
      return res.json({ ok: true, builder: true, text: 
        'Agent Builder opened! You can also describe what you want here:\n\n' +
        '- What should it trade? (options, stocks, both)\n' +
        '- What trading style? (aggressive, conservative, scalping, swing, long-term)\n' +
        '- Any timeframe rules? (day trading, multi-day holds, weekly)\n' +
        '- Risk tolerance? (max position size, stop loss %)\n' +
        '- Which model? (' + providers + ')\n' +
        '- Any specific rules?\n\n' +
        'Example: "Create a conservative tech options agent with 30-day holds, max 10% per position, using claude-sonnet-4-6"'
      });
    }
    
    // /editagent command
    const editMatch = trimmed.match(/^\/editagent\s+(\S+)/);
    if (editMatch) {
      const agent = getAgentById(editMatch[1]);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      broadcast('agent_builder', {
        mode: 'edit',
        agent,
        models: config.models || [],
        strategies: config.strategies || [],
        sandboxId,
      });
      return res.json({ ok: true, builder: true });
    }
    
    // /agents command
    if (trimmed === '/agents') {
      const agents = config.agents || [];
      let msg = 'Available agents:\n' + agents.map(a => `- ${a.name} (${a.id})`).join('\n');
      return res.json({ ok: true, text: msg });
    }

    const result = await orchestrator.sendMessage(sandboxId, trimmed);
    res.json({ ok: true, sandboxId, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/sandboxes/:id/config', (req, res) => {
  try {
    const sandbox = getSandbox(req.params.id);
    if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });
    const agent = getResolvedAgentForSandbox(req.params.id);
    res.json({ sandbox, agent });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/sandboxes/:id/dashboard', (req, res) => {
  try {
    const sandbox = getSandbox(req.params.id);
    if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });

    const agent = getResolvedAgentForSandbox(req.params.id);
    const heartbeat = getSandbox(req.params.id)?.heartbeat || {};
    const permissions = getPermissionsForSandbox(req.params.id);
    const slack = getPluginForSandbox(req.params.id, 'slack');
    const runtime = orchestrator.getSandboxRuntime(req.params.id);
    const state = runtime ? runtime.harness.state.toJSON() : { running: false, status: 'stopped', beat: 0 };

    const config = getConfig();
    const providers = [...new Set((config.models || []).map(m => m.id.split('/')[0]))];

    res.json({
      sandbox,
      agent,
      models: config.models,
      providers,
      heartbeat,
      heartbeatProfiles: getHeartbeatProfiles(),
      heartbeatPhases: getPhaseTimeRanges(),
      permissions,
      slack: slack || {},
      state,
    });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/sandboxes/:id/activate', async (req, res) => {
  try {
    const sandbox = getSandbox(req.params.id);
    if (!sandbox) return res.status(404).json({ error: 'Sandbox not found' });

    // Activation is a UI focus switch. Sandboxes run independently — we do
    // not stop any harness here. We just ensure the newly-focused sandbox
    // has a runtime and its Go backend is up so the dashboard renders data.
    await setActiveSandbox(req.params.id);
    const activeSandbox = getActiveSandbox();
    if (activeSandbox?.id) {
      await migrateLegacyDataForSandbox(activeSandbox.id);
      const runtime = getRuntimeForSandbox(req.params.id);
      if (runtime && !runtime.goReady) {
        await orchestrator.startGoBackend(req.params.id);
      }
    }
    broadcast('config', safeConfig());
    res.json({ ok: true, sandboxId: req.params.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/sandboxes/:id/agent', async (req, res) => {
  try {
    const { activeAgentId, model, overrides = {} } = req.body || {};
    const updates = {};
    if (activeAgentId !== undefined) updates.activeAgentId = activeAgentId;
    if (model !== undefined) updates.model = model;
    if (Object.keys(overrides).length) updates.overrides = overrides;
    const sandbox = await updateSandboxAgentSelection(req.params.id, updates);
    // Apply the agent's default heartbeat profile when the agent changes
    if (activeAgentId !== undefined) {
      const agent = getAgentById(activeAgentId);
      if (agent?.defaultHeartbeatProfile) {
        await applyHeartbeatProfile(req.params.id, agent.defaultHeartbeatProfile).catch(() => {});
        const targetHarness = getHarnessForSandbox(req.params.id);
        if (targetHarness?.state.running) targetHarness._scheduleNext();
      }
    }
    await refreshHarnessConfigForSandbox(req.params.id, { resetSession: true });
    broadcast('config', safeConfig());
    res.json({ ok: true, sandbox, agent: getResolvedAgentForSandbox(req.params.id) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/sandboxes/:id/agent/overrides', async (req, res) => {
  try {
    const sandbox = await updateSandboxAgentOverrides(req.params.id, req.body || {});
    await refreshHarnessConfigForSandbox(req.params.id, { resetSession: true });
    broadcast('config', safeConfig());
    res.json({ ok: true, sandbox, agent: getResolvedAgentForSandbox(req.params.id) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/sandboxes/:id/strategy-rules', async (req, res) => {
  try {
    if (typeof req.body?.rules !== 'string') {
      return res.status(400).json({ error: 'rules is required' });
    }
    const sandbox = await updateSandboxStrategyRules(req.params.id, req.body.rules);
    await refreshHarnessConfigForSandbox(req.params.id, { resetSession: true });
    broadcast('config', safeConfig());
    res.json({ ok: true, sandbox, agent: getResolvedAgentForSandbox(req.params.id) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Order Confirmation ─────────────────────────────────────────────
// When requireConfirmation is enabled, the MCP server checks /api/permissions
// and returns an error asking the agent to wait. The operator must approve via UI.
// This is enforced at the MCP permission layer (enforcePermissions function).
// The UI can show a confirmation prompt — for now, requireConfirmation
// makes the MCP server reject orders with a "requires confirmation" error.
// The agent will see this error and should report it to the operator.

app.post('/api/agent/heartbeat', (req, res) => {
  const { seconds, reason, sandboxId } = req.body;
  if (!seconds || seconds < 30 || seconds > 28800) return res.status(400).json({ error: 'seconds must be 30-28800' });
  const targetHarness = getHarnessForSandbox(sandboxId);
  if (!targetHarness) return res.status(404).json({ error: 'Sandbox harness not found' });
  // Route through setHeartbeatOverride so the override is tagged with the phase
  // it was set in and auto-expires at the next phase boundary.
  targetHarness.setHeartbeatOverride(seconds, reason);
  targetHarness.state.emit('heartbeat_change', { seconds, reason: reason || 'Manual override from UI', sandboxId: sandboxId || targetHarness.sandboxId });
  res.json({ ok: true, seconds });
});

// ── Safe Config (strip secrets) ────────────────────────────────────
function safeConfig() {
  const cfg = { ...getConfig() };
  // Strip secret keys from accounts
  cfg.accounts = (cfg.accounts || []).map(a => {
    const full = getAccountById(a.id) || {};
    return { ...a, secretKey: full.secretKey ? '****' + full.secretKey.slice(-4) : '****' };
  });
  return cfg;
}

// ── Config CRUD ────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json(safeConfig());
});

// System prompt preview
app.get('/api/agent/prompt-preview', async (req, res) => {
  try {
    const sandboxId = req.query.sandboxId || getActiveSandbox()?.id;
    const agentConfig = sandboxId ? getResolvedAgentForSandbox(sandboxId) : getActiveAgent();
    const prompt = await buildSystemPrompt(agentConfig, { getStrategyById });
    res.json({ prompt, agentName: agentConfig.name, sandboxId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Chat history
app.get('/api/chats', async (req, res) => {
  try {
    const accountId = req.query.accountId || getActiveAccount()?.id;
    if (!accountId) return res.json({ sessions: [] });
    const limit = Number(req.query.limit || 50);
    const sessions = await chatStore.listSessions(accountId, limit);
    res.json({ accountId, sessions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats/all', async (req, res) => {
  try {
    const limit = Number(req.query.limit || 100);
    const sessions = await chatStore.listAllSessions(limit);
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats/:sessionId', async (req, res) => {
  try {
    const accountId = req.query.accountId || getActiveAccount()?.id;
    if (!accountId) return res.status(400).json({ error: 'No active account' });
    const session = await chatStore.getSession(accountId, req.params.sessionId);
    const messages = await chatStore.getSessionMessages(accountId, req.params.sessionId, {
      offset: Number(req.query.offset || 0),
      limit: Number(req.query.limit || 500),
    });
    res.json({ accountId, session, messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/chats/:sessionId', async (req, res) => {
  try {
    const accountId = req.query.accountId || getActiveAccount()?.id;
    if (!accountId) return res.status(400).json({ error: 'No active account' });
    await chatStore.deleteSession(accountId, req.params.sessionId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Accounts
const _equityCache = new Map();  // accountId -> { equity, asOf, fetchedAtMs, error }
const EQUITY_CACHE_MS = 60_000;

app.get('/api/accounts', (req, res) => {
  const config = getConfig();
  const sandboxesByAccount = new Map();
  for (const s of Object.values(config.sandboxes || {})) {
    if (!sandboxesByAccount.has(s.accountId)) sandboxesByAccount.set(s.accountId, []);
    sandboxesByAccount.get(s.accountId).push(s);
  }
  const safe = config.accounts.map(a => {
    const cached = _equityCache.get(a.id);
    const sbxs = sandboxesByAccount.get(a.id) || [];
    const creds = getAccountById(a.id);
    return {
      ...a,
      secretKey: creds?.secretKey ? '****' + creds.secretKey.slice(-4) : '****',
      publicKey: creds?.publicKey || null,
      equity: cached?.equity ?? null,
      equityAsOf: cached?.asOf ?? null,
      sandboxCount: sbxs.length,
      sandboxNames: sbxs.map(s => s.name),
    };
  });
  res.json({ accounts: safe, activeId: config.activeAccountId });
});

app.post('/api/accounts', async (req, res) => {
  try {
    const account = await addAccount(req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true, account: { ...account, secretKey: '****' + (account.secretKey || '').slice(-4) } });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/accounts/:id', async (req, res) => {
  try {
    const account = await updateAccount(req.params.id, req.body);
    const creds = getAccountById(req.params.id);
    broadcast('config', safeConfig());
    res.json({ ok: true, account: { ...account, secretKey: '****' + (creds?.secretKey || '').slice(-4) } });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const cfg = getConfig();
    const attached = Object.values(cfg.sandboxes || {})
      .filter(s => s.accountId === req.params.id);
    if (attached.length > 0) {
      return res.status(409).json({
        error: `Account has ${attached.length} sandbox(es) attached. Detach or delete them before removing the account.`,
        sandboxIds: attached.map(s => s.id),
        sandboxNames: attached.map(s => s.name),
      });
    }
    await removeAccount(req.params.id);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/accounts/:id/activate', async (req, res) => {
  try {
    const cfg = getConfig();
    const sandboxes = Object.values(cfg.sandboxes || {})
      .filter(s => s.accountId === req.params.id)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    if (sandboxes.length === 0) {
      return res.status(400).json({ error: 'Account has no sandboxes — create one first' });
    }
    await setActiveAccount(req.params.id);
    await setActiveSandbox(sandboxes[0].id);
    const activeSandbox = getActiveSandbox();
    broadcast('config', safeConfig());
    if (activeSandbox?.id) {
      await migrateLegacyDataForSandbox(activeSandbox.id);
      broadcast('agent_log', {
        message: `Switching to account "${getActiveAccount()?.name}"... ensuring trading backend.`,
        level: 'info',
        timestamp: new Date().toISOString(),
      });
      const runtime = getRuntimeForSandbox(activeSandbox.id);
      if (runtime && !runtime.goReady) {
        await orchestrator.startGoBackend(activeSandbox.id);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/accounts/:id/equity', async (req, res) => {
  const account = getAccountById(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const cached = _equityCache.get(account.id);
  if (cached && (Date.now() - cached.fetchedAtMs) < EQUITY_CACHE_MS) {
    return res.json({ equity: cached.equity, asOf: cached.asOf, error: cached.error || null });
  }

  try {
    const baseUrl = account.baseUrl || (account.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets');
    const client = axios.create({
      baseURL: baseUrl,
      headers: {
        'APCA-API-KEY-ID': account.publicKey,
        'APCA-API-SECRET-KEY': account.secretKey,
      },
      timeout: 3000,
    });
    const { data } = await client.get('/v2/account');
    const entry = {
      equity: Number(data.equity),
      asOf: new Date().toISOString(),
      fetchedAtMs: Date.now(),
      error: null,
    };
    _equityCache.set(account.id, entry);
    res.json({ equity: entry.equity, asOf: entry.asOf, error: null });
  } catch (err) {
    const entry = {
      equity: null,
      asOf: new Date().toISOString(),
      fetchedAtMs: Date.now(),
      error: err.response?.status ? `Alpaca ${err.response.status}` : err.message,
    };
    _equityCache.set(account.id, entry);
    res.json({ equity: null, asOf: entry.asOf, error: entry.error });
  }
});

// Market data: latest price + daily change for watchlist symbols (Alpaca snapshots).
// Uses the active account's Alpaca keys; the data API works with paper keys (IEX feed).
const _quotesCache = { ts: 0, key: '', data: null };
const QUOTES_CACHE_MS = 10000;
app.get('/api/quotes', async (req, res) => {
  const raw = String(req.query.symbols || '').trim();
  if (!raw) return res.json({ quotes: {}, error: null });
  const symbols = raw.toUpperCase().split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (!symbols.length) return res.json({ quotes: {}, error: null });
  const key = symbols.join(',');
  if (_quotesCache.data && _quotesCache.key === key && (Date.now() - _quotesCache.ts) < QUOTES_CACHE_MS) {
    return res.json({ quotes: _quotesCache.data, error: null });
  }
  const account = getActiveAccount();
  if (!account || !account.publicKey) return res.json({ quotes: {}, error: 'no_account' });
  try {
    const client = axios.create({
      baseURL: 'https://data.alpaca.markets',
      headers: {
        'APCA-API-KEY-ID': account.publicKey,
        'APCA-API-SECRET-KEY': account.secretKey,
      },
      timeout: 4000,
    });
    const { data } = await client.get('/v2/stocks/snapshots', { params: { symbols: key, feed: 'iex' } });
    const snaps = data && data.snapshots ? data.snapshots : data;
    const quotes = {};
    for (const sym of symbols) {
      const snap = snaps ? snaps[sym] : null;
      const last = snap ? ((snap.latestTrade && snap.latestTrade.p) ?? (snap.dailyBar && snap.dailyBar.c) ?? null) : null;
      const prevClose = snap && snap.prevDailyBar ? snap.prevDailyBar.c : null;
      let change = null, changePct = null;
      if (last != null && prevClose != null && prevClose !== 0) {
        change = last - prevClose;
        changePct = (change / prevClose) * 100;
      }
      quotes[sym] = { price: last, change, changePct };
    }
    _quotesCache.ts = Date.now();
    _quotesCache.key = key;
    _quotesCache.data = quotes;
    res.json({ quotes, error: null });
  } catch (err) {
    res.json({ quotes: {}, error: err.response?.status ? `Alpaca ${err.response.status}` : err.message });
  }
});

// Agents
app.get('/api/agents', (req, res) => {
  const config = getConfig();
  res.json({ agents: config.agents, activeId: config.activeAgentId });
});

app.post('/api/agents', async (req, res) => {
  try {
    const agent = await addAgent(req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true, agent });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/agents/:id', async (req, res) => {
  try {
    const agent = await updateAgent(req.params.id, req.body);
    await refreshAllHarnessConfigs({ resetSession: true });
    broadcast('config', safeConfig());
    res.json({ ok: true, agent });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/agents/:id', async (req, res) => {
  try {
    await removeAgent(req.params.id);
    await refreshAllHarnessConfigs({ resetSession: true });
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/agents/:id/activate', async (req, res) => {
  try {
    await setActiveAgent(req.params.id);
    await refreshHarnessConfigForSandbox(getActiveSandbox()?.id, { resetSession: true });
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Strategies
app.get('/api/strategies', (req, res) => {
  const config = getConfig();
  res.json({ strategies: config.strategies });
});

app.post('/api/strategies', async (req, res) => {
  try {
    const strategy = await addStrategy(req.body);
    broadcast('config', safeConfig());
    res.json({ ok: true, strategy });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/strategies/:id', async (req, res) => {
  try {
    const strategy = await updateStrategy(req.params.id, req.body);
    await refreshAllHarnessConfigs({ resetSession: true });
    broadcast('config', safeConfig());
    res.json({ ok: true, strategy });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/strategies/:id', async (req, res) => {
  try {
    await removeStrategy(req.params.id);
    await refreshAllHarnessConfigs({ resetSession: true });
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Model selection
app.get('/api/models', (req, res) => {
  const config = getConfig();
  const allModels = config.models || [];
  const provider = req.query.provider;
  const models = provider ? allModels.filter(m => m.id.startsWith(provider + '/')) : allModels;
  const allProviders = [...new Set(allModels.map(m => m.id.split('/')[0]))];
  const filteredProviders = provider ? [provider] : allProviders;
  res.json({ models, activeModel: config.activeModel, providers: filteredProviders, allProviders });
});

app.post('/api/models/activate', async (req, res) => {
  try {
    await setActiveModel(req.body.model);
    await refreshHarnessConfigForSandbox(getActiveSandbox()?.id, { resetSession: true });
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/models/refresh', async (req, res) => {
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
    
    const config = getConfig();
    config.models = models;
    await saveConfig();
    broadcast('config', safeConfig());
    res.json({ ok: true, count: models.length });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Heartbeat Config ───────────────────────────────────────────────
app.get('/api/heartbeat', (req, res) => {
  const sandboxId = req.query.sandboxId;
  if (sandboxId) {
    return res.json(getSandbox(sandboxId)?.heartbeat || {});
  }
  const config = getConfig();
  res.json(config.heartbeat || {});
});

app.put('/api/heartbeat', async (req, res) => {
  try {
    const { sandboxId, ...heartbeatBody } = req.body || {};
    if (sandboxId) {
      await updateHeartbeatForSandbox(sandboxId, heartbeatBody);
    } else {
      await updateHeartbeat(heartbeatBody);
    }
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/heartbeat/profiles', (req, res) => {
  res.json({ profiles: getHeartbeatProfiles() });
});

app.post('/api/heartbeat/apply-profile', async (req, res) => {
  try {
    const { sandboxId, profile } = req.body || {};
    const targetSandbox = sandboxId || getActiveSandbox()?.id;
    if (!targetSandbox) throw new Error('No active sandbox');
    await applyHeartbeatProfile(targetSandbox, profile);
    // Reschedule the live harness immediately so the new interval takes effect now
    // rather than waiting for the current timer to expire naturally.
    const targetHarness = getHarnessForSandbox(targetSandbox);
    if (targetHarness?.state.running) targetHarness._scheduleNext();
    broadcast('config', safeConfig());
    res.json({ ok: true, profile, sandboxId: targetSandbox });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/heartbeat/phases', (req, res) => {
  res.json({ phases: getPhaseTimeRanges() });
});

app.put('/api/heartbeat/phases', async (req, res) => {
  try {
    const { phase, start, end } = req.body || {};
    if (!phase) throw new Error('Phase is required');
    await updatePhaseTimeRange(phase, { start, end });
    broadcast('config', safeConfig());
    res.json({ ok: true, phases: getPhaseTimeRanges() });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Permissions / Guardrails ───────────────────────────────────────
app.get('/api/permissions', (req, res) => {
  const sandboxId = req.query.sandboxId;
  if (sandboxId) return res.json(getPermissionsForSandbox(sandboxId));
  res.json(getPermissions());
});

app.put('/api/permissions', async (req, res) => {
  try {
    const { sandboxId, ...permBody } = req.body || {};
    if (sandboxId) {
      await updatePermissionsForSandbox(sandboxId, permBody);
    } else {
      await updatePermissions(permBody);
    }
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Plugins ────────────────────────────────────────────────────────
app.get('/api/plugins', (req, res) => {
  const config = getConfig();
  res.json(config.plugins || {});
});

app.get('/api/plugins/:name', (req, res) => {
  const sandboxId = req.query.sandboxId;
  const plugin = sandboxId ? getPluginForSandbox(sandboxId, req.params.name) : getPlugin(req.params.name);
  res.json(plugin || {});
});

app.put('/api/plugins/:name', async (req, res) => {
  try {
    const { sandboxId, ...pluginBody } = req.body || {};
    if (sandboxId) await updatePluginForSandbox(sandboxId, req.params.name, pluginBody);
    else await updatePlugin(req.params.name, pluginBody);
    broadcast('config', safeConfig());
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/plugins/slack/test', async (req, res) => {
  try {
    const sandboxId = req.body?.sandboxId || req.query.sandboxId;
    const slack = sandboxId ? getPluginForSandbox(sandboxId, 'slack') : getPlugin('slack');
    if (!slack?.webhookUrl) return res.status(400).json({ error: 'No Slack webhook URL configured' });
    const { default: axios } = await import('axios');
    await axios.post(slack.webhookUrl, {
      text: ':robot_face: *Prophet Agent* - Test notification\nSlack integration is working!',
      channel: slack.channel || undefined,
    }, { timeout: 5000 });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to send test message: ' + err.message }); }
});

// ── Portfolio Proxy ────────────────────────────────────────────────
app.get('/api/portfolio/account', async (req, res) => {
  try {
    const client = getGoClientForSandbox(req.query.sandboxId);
    if (!client) return res.status(404).json({ error: 'Sandbox trading backend unavailable' });
    const { data } = await client.get('/api/v1/account');
    res.json(data);
  } catch { res.status(502).json({ error: 'Trading bot unavailable' }); }
});

app.get('/api/portfolio/positions', async (req, res) => {
  try {
    const client = getGoClientForSandbox(req.query.sandboxId);
    if (!client) return res.status(404).json({ error: 'Sandbox trading backend unavailable' });
    const { data } = await client.get('/api/v1/positions');
    res.json(data);
  } catch { res.status(502).json({ error: 'Trading bot unavailable' }); }
});

app.get('/api/portfolio/orders', async (req, res) => {
  try {
    const client = getGoClientForSandbox(req.query.sandboxId);
    if (!client) return res.status(404).json({ error: 'Sandbox trading backend unavailable' });
    const { data } = await client.get('/api/v1/orders');
    res.json(data);
  } catch { res.status(502).json({ error: 'Trading bot unavailable' }); }
});

// ── Auth (OpenCode) ────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
  // API key in env is the fastest check
  if (process.env.CLAUDE_API_KEY) {
    return res.json({
      loggedIn: true,
      authMethod: 'api_key',
      provider: 'opencode',
      raw: 'CLAUDE_API_KEY set in environment',
    });
  }
  try {
    const out = execSync('opencode auth list 2>&1', { timeout: 5000, encoding: 'utf-8' });
    // Parse the table output - look for "Anthropic" with "oauth" or any credential
    const hasAnthropicAuth = out.includes('Anthropic') && (out.includes('oauth') || out.includes('api-key'));
    res.json({
      loggedIn: hasAnthropicAuth,
      authMethod: hasAnthropicAuth ? 'opencode_oauth' : 'none',
      provider: 'opencode',
      raw: out.replace(/\x1b\[[0-9;]*m/g, '').trim(), // strip ANSI codes
    });
  } catch (err) {
    const output = (err.stdout || err.stderr || err.message || '').replace(/\x1b\[[0-9;]*m/g, '');
    res.json({ loggedIn: false, provider: 'opencode', raw: output.substring(0, 200) });
  }
});

app.post('/api/auth/login', (req, res) => {
  // Spawn opencode auth login and capture the URL
  const proc = spawn(OPENCODE_BIN, [...OPENCODE_WIN_PREFIX, 'auth', 'login'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'echo' }, // prevent auto-opening browser
  });

  let output = '';
  let urlSent = false;

  const sendUrl = (data) => {
    output += data.toString();
    // Look for any OAuth/auth URL
    const match = output.match(/(https:\/\/[^\s]+authorize[^\s]*)/);
    if (match && !urlSent) {
      urlSent = true;
      res.json({ ok: true, url: match[1] });
      proc.on('exit', (code) => {
        broadcast('agent_log', {
          message: code === 0 ? 'OpenCode authenticated successfully!' : 'Auth flow ended (code: ' + code + ')',
          level: code === 0 ? 'success' : 'warning',
          timestamp: new Date().toISOString(),
        });
      });
    }
  };

  proc.stdout.on('data', sendUrl);
  proc.stderr.on('data', sendUrl);

  // Also handle interactive prompts - pipe newline to accept defaults
  setTimeout(() => {
    try { proc.stdin.write('\n'); } catch {}
  }, 2000);

  // Timeout - if no URL found in 15s, return error
  setTimeout(() => {
    if (!urlSent) {
      proc.kill();
      res.status(500).json({ error: 'Timed out waiting for auth URL', output: output.substring(0, 500) });
    }
  }, 15000);
});

app.post('/api/auth/logout', (req, res) => {
  try {
    execSync('opencode auth logout 2>&1', { timeout: 10000, encoding: 'utf-8' });
    broadcast('agent_log', {
      message: 'OpenCode logged out.',
      level: 'info',
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) {
    const output = err.stdout || err.stderr || err.message || '';
    res.status(500).json({ error: 'Logout failed: ' + output.substring(0, 200) });
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const account = getActiveAccount();
  const activeId = getActiveSandbox()?.id || null;
  const activeRuntime = activeId ? orchestrator.getSandboxRuntime(activeId) : null;

  // trading_bot health reflects the active sandbox's Go backend (the one the
  // dashboard is currently focused on). Per-sandbox health is in sandboxes[].
  let botHealthy = false;
  if (activeRuntime?.goAxios) {
    try {
      await activeRuntime.goAxios.get('/health', { timeout: 3000 });
      botHealthy = true;
    } catch {}
  }

  const sandboxStates = getSandboxes().map(sandbox => {
    const runtime = orchestrator.getSandboxRuntime(sandbox.id);
    return {
      sandboxId: sandbox.id,
      port: runtime?.port || null,
      goReady: runtime?.goReady || false,
      goPid: runtime?.goProc?.pid || null,
      state: runtime ? runtime.harness.state.toJSON() : null,
    };
  });
  res.json({
    agent: 'healthy',
    trading_bot: botHealthy ? 'healthy' : 'unavailable',
    trading_bot_managed: !!activeRuntime?.goProc,
    activeAccount: account ? { name: account.name, paper: account.paper } : null,
    uptime: process.uptime(),
    state: activeRuntime ? activeRuntime.harness.state.toJSON() : null,
    sandboxes: sandboxStates,
    scheduler: scheduler.getStatus(),
  });
});

app.post('/api/scheduler/trigger', async (req, res) => {
  const { job, date } = req.body || {};
  if (!job) return res.status(400).json({ error: 'job is required (daily_briefing or weekly_screeners)' });
  const result = await scheduler.triggerJob(job, date || null);
  if (result?.error) return res.status(400).json(result);
  res.json(result);
});

// Serve static files (after API routes)
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback - serve index.html for non-API routes
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && req.method === 'GET') {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

// ── Start Server ───────────────────────────────────────────────────

// Every sandbox gets an orchestrator-managed runtime up front so heartbeats,
// preflight, and dashboard endpoints have something to read from on boot.
await orchestrator.ensureAllRuntimes();
for (const runtime of orchestrator.runtimes.values()) {
  bindOperationalHooks(runtime.harness);
}

// Auto-start the Go backend for the active sandbox so the dashboard renders
// portfolio data immediately. Other sandboxes start their Go backend lazily
// when the user opens or starts them.
const activeAccount = getActiveAccount();
const startupActiveSandboxId = getActiveSandbox()?.id;
if (startupActiveSandboxId && activeAccount) {
  await orchestrator.startGoBackend(startupActiveSandboxId);
} else {
  console.log('  No active sandbox/account configured — trading backend not started');
}

await scheduler.start();
scheduler.runStartupChecks().catch(() => {});

// Graceful shutdown — orchestrator.shutdown() stops every runtime's harness
// and Go backend, so a single call replaces the old singleton teardown.
process.on('SIGTERM', async () => {
  console.log('\n  Shutting down...');
  scheduler.stop();
  await orchestrator.shutdown();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('\n  Shutting down...');
  scheduler.stop();
  await orchestrator.shutdown();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Prophet Agent Dashboard: http://localhost:${PORT}`);
  console.log(`  Network:                http://0.0.0.0:${PORT}`);
  console.log(`  Trading Bot Backend:    ${TRADING_BOT_URL}`);
  console.log(`  Active Account:         ${activeAccount?.name || 'none'}\n`);
});
