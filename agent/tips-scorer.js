// agent/tips-scorer.js
// Read-only Influence-Ledger scorer (spec D13: never mutates the tip store).
// Computes three never-merged views from existing files only. See the schema
// spike in docs/superpowers/plans/2026-05-30-tips-influence-scorecard-phase1b.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import { etDateString, addTradingDays, isTradingDay, nextTradingDay } from './market-calendar.js';
import { loadDailyCloses, forwardReturn } from './bar-cache-reader.js';
import { readTips } from './tips-store.js';

const OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

// underlyingOf: OCC option symbol -> underlying; plain ticker -> itself.
export function underlyingOf(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (OCC_SYMBOL.test(s)) return s.match(/^[A-Z]{1,6}/)[0];
  return s;
}

// resolveProphetSandboxes: from agent-config, every sandbox whose agent is the
// `default` (Prophet) agent. Returns [{ accountId (folder), sandboxId (filter) }].
export async function resolveProphetSandboxes(projectRoot) {
  const cfgPath = path.join(projectRoot, 'data', 'agent-config.json');
  const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
  const sandboxes = cfg.sandboxes || {};
  const out = [];
  for (const [key, sb] of Object.entries(sandboxes)) {
    if (sb && sb.agent && sb.agent.activeAgentId === 'default' && typeof sb.accountId === 'string') {
      out.push({ accountId: sb.accountId, sandboxId: key });
    }
  }
  return out;
}

// loadProphetActions: read decisive actions for the Prophet sandbox(es), filtered
// by inner sandbox_id (the account folder is co-mingled across agents). Prefers a
// sibling *.friction.json when present (forward-compat), else the raw *.json.
export async function loadProphetActions(projectRoot) {
  const sandboxes = await resolveProphetSandboxes(projectRoot);
  const wanted = new Set(sandboxes.map(s => s.sandboxId));
  const seenFolders = new Set();
  const actions = [];
  for (const { accountId } of sandboxes) {
    if (seenFolders.has(accountId)) continue; // shared accountId -> read once
    seenFolders.add(accountId);
    const dir = path.join(projectRoot, 'data', 'sandboxes', accountId, 'decisive_actions');
    let files;
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    const frictionStems = new Set(
      files.filter(f => f.endsWith('.friction.json')).map(f => f.slice(0, -('.friction.json'.length))),
    );
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const isFriction = f.endsWith('.friction.json');
      const stem = f.replace(/\.friction\.json$/, '').replace(/\.json$/, '');
      if (!isFriction && frictionStems.has(stem)) continue; // friction sibling wins
      let action;
      try {
        action = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
      } catch {
        continue;
      }
      if (!wanted.has(action.sandbox_id)) continue; // co-mingled folder filter
      actions.push(action);
    }
  }
  return actions;
}

// Signed dollar P&L fields, in priority order. Names are free-form per beat
// (schema spike finding 3). Each entry: [key, signRule] where signRule coerces
// magnitude-style fields: 'asis' keeps the value, 'loss' forces <=0, 'gain' forces >=0.
const DOLLAR_PNL_FIELDS = [
  ['option_pnl_dollars', 'asis'],
  ['pnl_dollars', 'asis'],
  ['realized_pl', 'asis'],
  ['unrealized_pl', 'asis'],
  ['option_gain_dollars', 'gain'],
  ['gain_dollars', 'gain'],
  ['option_loss_dollars', 'loss'],
  ['loss_dollars', 'loss'],
  ['total_session_loss', 'loss'],
];

function _coerceSign(value, rule) {
  if (rule === 'loss') return -Math.abs(value);
  if (rule === 'gain') return Math.abs(value);
  return value;
}

// extractRealizedPnl: realized dollar P&L for a close (SELL) action, with a
// tolerant fallback chain. Returns { pnl: number|null, source, confidence }.
// confidence: 'high' (canonical friction fields) | 'medium' (structured md) |
// 'low' (parsed from free-text reasoning) | 'none' (unresolved).
// `opts.contracts` (from the matched open) enables the price-compute fallback.
export function extractRealizedPnl(action, opts = {}) {
  const m = (action && action.market_data) || {};
  if (typeof m.friction_adjusted_pl === 'number') {
    return { pnl: m.friction_adjusted_pl, source: 'friction_adjusted_pl', confidence: 'high' };
  }
  if (typeof m.raw_pl === 'number') {
    return { pnl: m.raw_pl, source: 'raw_pl', confidence: 'high' };
  }
  for (const [key, rule] of DOLLAR_PNL_FIELDS) {
    if (typeof m[key] === 'number') {
      return { pnl: _coerceSign(m[key], rule), source: `md:${key}`, confidence: 'medium' };
    }
  }
  if (typeof m.option_cost_basis === 'number' && typeof m.option_current_price === 'number'
      && typeof opts.contracts === 'number') {
    const pnl = (m.option_current_price - m.option_cost_basis) * opts.contracts * 100;
    return { pnl: +pnl.toFixed(4), source: 'computed_from_prices', confidence: 'medium' };
  }
  // Last resort: a dollar figure in the free-text reasoning, e.g. "(-$795)" or
  // "loss of $312". Negatives may be written with a leading '-' inside parens.
  const reasoning = String((action && action.reasoning) || '');
  const m1 = reasoning.match(/\(\s*(-?)\$\s*([\d,]+(?:\.\d+)?)\s*\)/)
    || reasoning.match(/\b(loss|gain|profit|down|up)\b[^$]{0,20}\$\s*([\d,]+(?:\.\d+)?)/i);
  if (m1) {
    const raw = Number(m1[m1.length - 1].replace(/,/g, ''));
    if (Number.isFinite(raw)) {
      let pnl = raw;
      const ctx = (m1[1] || m1[0] || '').toLowerCase();
      if (m1[1] === '-' || /loss|down/.test(ctx)) pnl = -Math.abs(raw);
      else if (/gain|profit|up/.test(ctx)) pnl = Math.abs(raw);
      return { pnl, source: 'reasoning_regex', confidence: 'low' };
    }
  }
  return { pnl: null, source: 'unresolved', confidence: 'none' };
}

// loadAgentSurfacedIndex: build Map<TICKER, [etDate,...]> of every name the
// catalyst-news / analyst-actions scans flagged, from persisted daily briefs
// (data/reports/daily_brief_*.json). Source for the D9 agent-discoverable split.
export async function loadAgentSurfacedIndex(projectRoot) {
  const dir = path.join(projectRoot, 'data', 'reports');
  const idx = new Map();
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return idx;
    throw err;
  }
  const add = (ticker, dateStr) => {
    if (!ticker || !dateStr) return;
    const t = String(ticker).toUpperCase();
    const d = etDateString(new Date(dateStr));
    if (d === 'Invalid Date') return;
    if (!idx.has(t)) idx.set(t, []);
    if (!idx.get(t).includes(d)) idx.get(t).push(d);
  };
  for (const f of files) {
    if (!/^daily_brief_\d{8}\.json$/.test(f)) continue;
    let brief;
    try {
      brief = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8'));
    } catch {
      continue;
    }
    for (const a of brief.analyst_actions || []) add(a.ticker, a.date || brief.date);
    for (const c of brief.ticker_catalysts || []) add(c.ticker, c.published || brief.date);
  }
  return idx;
}

// agentSurfacedFor: did any scan flag of `ticker` land in [startEtDate, endEtDate]?
export function agentSurfacedFor(idx, ticker, startEtDate, endEtDate) {
  const dates = idx.get(String(ticker).toUpperCase());
  if (!dates) return false;
  return dates.some(d => d >= startEtDate && d <= endEtDate);
}

// computeViewA — the PRIMARY "is my advice good?" view (spec §5.2-A, D2/D10).
// For every ACTIVE tip (actionableAt set), the underlying's forward return over
// the window vs SPY over the same window. Pre-outcome manual tips make this
// unbiased. Tipped-but-not-traded names earn their keep here. Misses/pending are
// kept and shown (D12). Options inject `loadCloses`/`todayEtDate` for testing.
export async function computeViewA(tips, opts = {}) {
  const windowDays = opts.windowDays ?? 3;
  const todayEtDate = opts.todayEtDate ?? etDateString(new Date());
  const surfacedIndex = opts.surfacedIndex ?? new Map();
  const loadCloses = opts.loadCloses ?? (async (sym) => loadDailyCloses(opts.projectRoot, sym));

  const active = tips.filter(t => !t.dismissed && t.phase === 'active' && t.actionableAt);
  const spyCloses = await loadCloses('SPY');
  const rows = [];
  for (const tip of active) {
    const startEt = etDateString(new Date(tip.actionableAt));
    const anchored = isTradingDay(startEt) ? startEt : nextTradingDay(startEt);
    const endEt = addTradingDays(anchored, windowDays);
    const uCloses = await loadCloses(tip.ticker);
    const u = forwardReturn(uCloses, startEt, windowDays, todayEtDate);
    const spy = forwardReturn(spyCloses, startEt, windowDays, todayEtDate);
    const ok = u.status === 'ok' && spy.status === 'ok';
    rows.push({
      id: tip.id,
      ticker: tip.ticker,
      source: tip.source,
      thesis: tip.thesis,
      actionableAt: tip.actionableAt,
      windowStart: anchored,
      windowEnd: endEt,
      status: u.status === 'ok' ? spy.status : u.status, // 'ok' | 'pending' | 'no_data'
      underlyingReturn: ok ? u.ret : null,
      spyReturn: ok ? spy.ret : null,
      excessReturn: ok ? u.ret - spy.ret : null,
      agentSurfaced: agentSurfacedFor(surfacedIndex, tip.ticker, anchored, endEt),
    });
  }
  return { rows, windowDays };
}

// computeViewB — the entangled "what Prophet did with it" view (spec §5.2-B).
// Matches each tip's window to influenced option round-trips: a BUY (open) on
// the tip's underlying whose entry timestamp lands in [actionableAt, +window],
// paired to its closing SELL (exact option symbol). Realized P&L via the
// tolerant extractor; unresolved closes are kept as data-gaps (never $0).
// Synchronous: it operates on already-loaded actions, no FS.
export function computeViewB(tips, actions, opts = {}) {
  const windowDays = opts.windowDays ?? 3;
  const surfacedIndex = opts.surfacedIndex ?? new Map();
  const active = tips
    .filter(t => !t.dismissed && t.phase === 'active' && t.actionableAt)
    .sort((a, b) => String(a.actionableAt).localeCompare(String(b.actionableAt))); // earliest tip claims a shared trade first (spec §9)

  const opens = actions.filter(a => a.action === 'BUY');
  const closes = actions.filter(a => a.action === 'SELL');
  // Index closes by exact symbol, earliest-after-open chosen at match time.
  const closesBySymbol = new Map();
  for (const c of closes) {
    if (!closesBySymbol.has(c.symbol)) closesBySymbol.set(c.symbol, []);
    closesBySymbol.get(c.symbol).push(c);
  }
  for (const arr of closesBySymbol.values()) arr.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  const rows = [];
  const coverage = { resolved: 0, unresolved: 0 };
  const usedCloses = new Set();
  for (const tip of active) {
    const startEt = etDateString(new Date(tip.actionableAt));
    const anchored = isTradingDay(startEt) ? startEt : nextTradingDay(startEt);
    const endEt = addTradingDays(anchored, windowDays);
    for (const open of opens) {
      if (underlyingOf(open.symbol) !== tip.ticker) continue;
      const openEt = etDateString(new Date(open.timestamp));
      if (openEt < anchored || openEt > endEt) continue; // entry must be in-window
      // find the earliest unused close for this exact option symbol after the open
      const candidates = closesBySymbol.get(open.symbol) || [];
      const close = candidates.find(c => !usedCloses.has(c) && (c.timestamp || '') >= (open.timestamp || ''));
      if (!close) continue; // still open -> not a closed trade (closed-only)
      usedCloses.add(close);
      const contracts = open.market_data && open.market_data.contracts;
      const pnlInfo = extractRealizedPnl(close, { contracts });
      if (pnlInfo.pnl === null) coverage.unresolved += 1; else coverage.resolved += 1;
      rows.push({
        tipId: tip.id,
        source: tip.source,
        underlying: tip.ticker,
        optionSymbol: open.symbol,
        openAt: open.timestamp,
        closeAt: close.timestamp,
        pnl: pnlInfo.pnl,
        pnlSource: pnlInfo.source,
        pnlConfidence: pnlInfo.confidence,
        agentSurfaced: agentSurfacedFor(surfacedIndex, tip.ticker, anchored, endEt),
      });
    }
  }
  return { rows, coverage, windowDays };
}

// summarizeDistribution — small-n discipline (D11). Prefers the per-value
// distribution; profit factor is exposed ONLY at/above minSample, suppressed
// otherwise. No single headline score is ever produced.
export function summarizeDistribution(values, opts = {}) {
  const minSample = opts.minSample ?? 20;
  const xs = values.filter(v => typeof v === 'number');
  const n = xs.length;
  const sorted = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  const median = n === 0 ? null : (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2);
  const wins = xs.filter(v => v > 0).reduce((a, b) => a + b, 0);
  const losses = Math.abs(xs.filter(v => v < 0).reduce((a, b) => a + b, 0));
  const smallSample = n < minSample;
  const profitFactorSuppressed = smallSample || losses === 0;
  return {
    n,
    smallSample,
    sum: +sum.toFixed(4),
    median: median === null ? null : +median.toFixed(4),
    min: n ? sorted[0] : null,
    max: n ? sorted[n - 1] : null,
    winCount: xs.filter(v => v > 0).length,
    lossCount: xs.filter(v => v < 0).length,
    profitFactorSuppressed,
    profitFactor: profitFactorSuppressed ? null : +(wins / losses).toFixed(4),
    values: xs,
  };
}

function _perSource(rows, valueKey, minSample) {
  const bySource = new Map();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    if (typeof r[valueKey] === 'number') bySource.get(r.source).push(r[valueKey]);
  }
  const out = {};
  for (const [source, values] of bySource) {
    out[source] = summarizeDistribution(values, { minSample });
  }
  return out;
}

// scoreTips — top-level assembly. Read-only (D13). Emits the three never-merged
// views (D10), each split by agentSurfaced (D9), with per-source small-sample
// guards (D11) and explicit window/coverage meta. No leaderboard, no headline.
export async function scoreTips(projectRoot, opts = {}) {
  const windowDays = opts.windowDays ?? Number(process.env.TIPS_ATTRIBUTION_WINDOW_DAYS || 3);
  const minSample = opts.minSample ?? Number(process.env.TIPS_MIN_SAMPLE || 20);
  const todayEtDate = opts.todayEtDate ?? etDateString(new Date());

  const tips = await readTips(projectRoot);
  const surfacedIndex = await loadAgentSurfacedIndex(projectRoot);
  const actions = await loadProphetActions(projectRoot);

  const viewA = await computeViewA(tips, { projectRoot, windowDays, todayEtDate, surfacedIndex, loadCloses: opts.loadCloses });
  const viewB = computeViewB(tips, actions, { windowDays, surfacedIndex });

  // View C — context only (spec §5.2-C): catalyst (tip-influenced) option trades
  // vs all other closed Prophet option trades. Framed as trades-vs-rest, never
  // human-vs-agent. Demoted.
  const influencedSymbols = new Set(viewB.rows.map(r => r.optionSymbol));
  const allClosed = [];
  const closeBySym = new Map();
  for (const a of actions) {
    if (a.action !== 'BUY') continue;
    closeBySym.set(a.symbol, a.market_data && a.market_data.contracts);
  }
  for (const a of actions) {
    if (a.action !== 'SELL') continue;
    if (!OCC_SYMBOL.test(String(a.symbol))) continue; // option closes only
    const info = extractRealizedPnl(a, { contracts: closeBySym.get(a.symbol) });
    allClosed.push({ symbol: a.symbol, pnl: info.pnl, influenced: influencedSymbols.has(a.symbol) });
  }
  const influencedPnl = allClosed.filter(r => r.influenced && typeof r.pnl === 'number').map(r => r.pnl);
  const autonomousPnl = allClosed.filter(r => !r.influenced && typeof r.pnl === 'number').map(r => r.pnl);
  const viewC = {
    note: 'Context only — catalyst-influenced trades vs everything else, NOT human-vs-agent.',
    influenced: summarizeDistribution(influencedPnl, { minSample }),
    autonomous: summarizeDistribution(autonomousPnl, { minSample }),
  };

  // Per-source breakdowns with small-sample guards.
  const perSource = {
    viewA_excess: _perSource(viewA.rows.filter(r => r.status === 'ok'), 'excessReturn', minSample),
    viewB_pnl: _perSource(viewB.rows.filter(r => typeof r.pnl === 'number'), 'pnl', minSample),
  };

  return {
    viewA,
    viewB,
    viewC,
    perSource,
    meta: {
      windowDays,
      minSample,
      todayEtDate,
      tipCounts: {
        total: tips.filter(t => !t.dismissed).length,
        active: tips.filter(t => !t.dismissed && t.phase === 'active').length,
        pendingCandidate: tips.filter(t => !t.dismissed && t.phase === 'pending_candidate').length,
      },
      viewBCoverage: viewB.coverage,
      agentSurfacedCaveat: 'agentSurfaced is derived from persisted daily briefs (in-universe scan coverage only); absence is not proof the agent did not see it.',
    },
  };
}

// matchTippedTrades — for the Trades-tab badge. A trade is "influenced" iff it is
// a BUY whose underlying matches an active tip and whose timestamp is within that
// tip's window. Returns the matched trades' identity fields + the tip source.
// Read-only; operates on already-loaded tips + trades.
export function matchTippedTrades(tips, trades, opts = {}) {
  const windowDays = opts.windowDays ?? 3;
  const active = tips.filter(t => !t.dismissed && t.phase === 'active' && t.actionableAt);
  const out = [];
  for (const tr of trades) {
    if (String(tr.side || '').toLowerCase() !== 'buy') continue;
    const u = underlyingOf(tr.symbol);
    const tradeEt = tr.timestamp ? etDateString(new Date(tr.timestamp)) : null;
    if (!tradeEt) continue;
    let matchedSource = null;
    for (const tip of active) {
      if (tip.ticker !== u) continue;
      const startEt = etDateString(new Date(tip.actionableAt));
      const anchored = isTradingDay(startEt) ? startEt : nextTradingDay(startEt);
      const endEt = addTradingDays(anchored, windowDays);
      if (tradeEt >= anchored && tradeEt <= endEt) { matchedSource = tip.source; break; }
    }
    if (matchedSource) {
      out.push({ sandboxId: tr.sandboxId, timestamp: tr.timestamp, tool: tr.tool, symbol: tr.symbol, source: matchedSource });
    }
  }
  return out;
}
