// Foundation B Component 2a — per-agent friction-adjusted closed-trade ledger.
// Reuses Component 3 (managed-position-repair.mjs) + apply-friction.mjs. Read-only.
// Spec: docs/superpowers/specs/2026-05-31-foundation-b-component2-measurement-design.md

import {
  deriveExitReason, isGraduationEligible, parseManagedTimestamp,
  readClosedManagedPositions, resolveSandboxDbPaths, cutoffDateToMs, PART_A_DEPLOY_CUTOFF,
} from './managed-position-repair.mjs';
import { applyFriction, loadFrictionConfig } from './apply-friction.mjs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Map a Component-3 closed-position object to the action shape applyFriction
// consumes. The stop-out flag is driven by Component 3's derived classification
// (D-B8), so apply-friction's stop-gap-through haircut fires on a derived losing
// stop — note isStopOut also requires unrealized_pct < 0 (a profitable trailing
// stop gets base friction only).
export function toFrictionAction(position, agentId) {
  const isStop = deriveExitReason(position).derived === 'stop';
  return {
    symbol: position.symbol,
    reasoning: isStop ? 'stopped out' : (position.notes ?? ''),
    market_data: {
      entry_price: position.entryPrice,
      exit_price: position.exitPrice,
      size: position.quantity,
      unrealized_pl: position.realizedPnl,
      unrealized_pct: position.realizedPnlPct,
    },
  };
}

// Build a 2× stress friction config by doubling ONLY the genuinely uncertain
// frictions (slippage, gap-through, assumed spread). Deterministic fees
// (commission, regulatory) are exact known costs with no worse-than-modeled
// tail — doubling them would inflate the gate with fictional cost.
const STRESS_KEYS = [
  'per_share_slippage_usd', 'slippage_pct_of_price_floor', 'stop_gap_through_pct',
  'assumed_spread_pct_of_mid', 'assumed_spread_pct_of_credit',
];
const FRICTION_PROFILES = ['stocks', 'single_leg_options', 'iron_condor'];

export function buildStressConfig(baseline) {
  const out = structuredClone(baseline);
  for (const profileKey of FRICTION_PROFILES) {
    const p = out[profileKey];
    if (!p) continue;
    for (const k of STRESS_KEYS) {
      if (typeof p[k] === 'number') p[k] *= 2;
    }
  }
  out.version = `${baseline.version ?? 'v?'}-stress2x`;
  return out;
}

// Open managed positions (ACTIVE + PARTIAL = still-open, possibly reduced qty),
// read-only. Mirror of Component 3's closed reader for the marked-equity leg.
export function readOpenManagedPositions(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT symbol, side, agent_strategy, entry_price, quantity,
              current_price, unrealized_pl, unrealized_plpc, remaining_qty,
              created_at
       FROM managed_positions
       WHERE status IN ('ACTIVE', 'PARTIAL')`
    ).all();
    return rows.map(r => ({
      symbol: r.symbol,
      side: r.side,
      agentStrategy: r.agent_strategy,
      entryPrice: r.entry_price,
      quantity: r.quantity,
      currentPrice: r.current_price,
      unrealizedPl: r.unrealized_pl,
      unrealizedPlPct: r.unrealized_plpc,
      remainingQty: r.remaining_qty,
      createdAt: r.created_at,
    }));
  } finally {
    db.close();
  }
}

// Friction-adjusted realized P&L for one closed position, or null if the
// asset class isn't recognized by apply-friction.
export function frictionAdjustedPnl(position, agentId, config) {
  const out = applyFriction(toFrictionAction(position, agentId), agentId, config);
  if (out.skip) return null;
  return out.action.market_data.friction_adjusted_pl;
}

// Summary metrics over an array of (friction-adjusted) per-trade P&L numbers.
// Profit factor is null (undefined), never Infinity, when there are no losses.
export function metricsFromPnls(pnls) {
  const n = pnls.length;
  const winners = pnls.filter(p => p > 0);
  const losers = pnls.filter(p => p < 0);
  const sumWin = winners.reduce((s, x) => s + x, 0);
  const sumLossAbs = Math.abs(losers.reduce((s, x) => s + x, 0));
  return {
    count: n,
    winners: winners.length,
    losers: losers.length,
    winRate: n ? winners.length / n : 0,
    profitFactor: losers.length === 0 ? null : sumWin / sumLossAbs,
    avgWin: winners.length ? sumWin / winners.length : 0,
    avgLoss: losers.length ? -sumLossAbs / losers.length : 0,
    expectancy: n ? pnls.reduce((s, x) => s + x, 0) / n : 0,
  };
}

// Small seeded PRNG (mulberry32) so bootstrap CIs are reproducible in tests.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Percentile bootstrap CI on the mean per-trade P&L — the demonstrated-edge
// statistic 2c gates on (a count floor can't tell edge from luck).
export function bootstrapExpectancyCI(pnls, { B = 10000, alpha = 0.05, seed = 12345 } = {}) {
  const n = pnls.length;
  if (n === 0) return { mean: null, lo: null, hi: null, n: 0 };
  const rng = mulberry32(seed);
  const means = new Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += pnls[(rng() * n) | 0];
    means[b] = s / n;
  }
  means.sort((x, y) => x - y);
  return {
    mean: pnls.reduce((s, x) => s + x, 0) / n,
    lo: means[Math.floor((alpha / 2) * B)],
    hi: means[Math.floor((1 - alpha / 2) * B)],
    n,
  };
}

// One-side (entry) stock friction estimate — the friction already paid to be in
// an open position. Half of apply-friction's round-trip stock haircut, minus the
// stop-gap term (no exit yet).
function entrySideStockFriction(qty, profile) {
  const perShare = (profile.per_share_slippage_usd ?? 0)
    + (profile.regulatory_fee_per_share ?? 0)
    + (profile.commission_per_share ?? 0);
  return perShare * qty;
}

// Secondary marked-equity expectancy (hold-losers bias check): eligible closed
// friction-adjusted realized P&L + eligible open marks with entry-side friction
// subtracted, over aligned (eligible-closed + eligible-open) populations.
export function markedEquityExpectancy(eligibleClosedPnls, eligibleOpen, config) {
  const stocks = config.stocks ?? {};
  const closedSum = eligibleClosedPnls.reduce((s, x) => s + x, 0);
  const openSum = eligibleOpen.reduce(
    (s, p) => s + (p.unrealizedPl - entrySideStockFriction(p.quantity, stocks)), 0);
  const count = eligibleClosedPnls.length + eligibleOpen.length;
  const value = closedSum + openSum;
  return { count, value, perTrade: count ? value / count : null };
}

// Full per-agent ledger: eligible/quarantined/all-closed metric blocks,
// expectancy at 1× and 2× friction, the demonstrated-edge bootstrap CI (on the
// eligible 2×-friction per-trade P&L), and the marked-equity bias check.
export function buildAgentLedger(closed, open, cutoffMs, agentId, baselineCfg, stressCfg) {
  const isElig = (p) => isGraduationEligible(parseManagedTimestamp(p.createdAt), cutoffMs);
  const eligibleClosed = closed.filter(isElig);
  const quarantinedClosed = closed.filter(p => !isElig(p));
  const eligibleOpen = open.filter(isElig);

  const adj = (list, cfg) => list.map(p => frictionAdjustedPnl(p, agentId, cfg)).filter(v => v !== null);
  const eligPnls1x = adj(eligibleClosed, baselineCfg);
  const eligPnls2x = adj(eligibleClosed, stressCfg);
  const allClosedPnls1x = adj(closed, baselineCfg);
  const quarPnls1x = adj(quarantinedClosed, baselineCfg);

  return {
    agentStrategy: agentId,
    eligible: metricsFromPnls(eligPnls1x),
    eligibleExpectancy2x: eligPnls2x.length ? eligPnls2x.reduce((s, x) => s + x, 0) / eligPnls2x.length : 0,
    edgeCI: bootstrapExpectancyCI(eligPnls2x),
    quarantined: metricsFromPnls(quarPnls1x),
    allClosed: metricsFromPnls(allClosedPnls1x),
    markedEquity: markedEquityExpectancy(eligPnls1x, eligibleOpen, baselineCfg),
  };
}

const fmt = (v) => (v === null || v === undefined ? '—' : (typeof v === 'number' ? +v.toFixed(2) : v));

export function buildLedgerReport(perAgent) {
  return { agents: perAgent };
}

export function renderLedgerMarkdown(report) {
  const lines = ['# Per-agent trade ledger (friction-adjusted, display-only)', ''];
  for (const [agent, l] of Object.entries(report.agents).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${agent}`, '');
    lines.push('| block | n | win% | profit factor | expectancy |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    lines.push(`| eligible | ${l.eligible.count} | ${fmt((l.eligible.winRate ?? 0) * 100)} | ${fmt(l.eligible.profitFactor)} | ${fmt(l.eligible.expectancy)} |`);
    lines.push(`| all-closed (incl. quarantined) | ${l.allClosed.count} | ${fmt((l.allClosed.winRate ?? 0) * 100)} | ${fmt(l.allClosed.profitFactor)} | ${fmt(l.allClosed.expectancy)} |`);
    lines.push('');
    lines.push(`- expectancy @2× friction: **${fmt(l.eligibleExpectancy2x)}**`);
    lines.push(`- edge CI (eligible, net 2× friction, n=${l.edgeCI.n}): [${fmt(l.edgeCI.lo)}, ${fmt(l.edgeCI.hi)}] mean ${fmt(l.edgeCI.mean)}`);
    lines.push(`- marked-equity expectancy (eligible closed+open, entry-friction): ${fmt(l.markedEquity.perTrade)} over ${l.markedEquity.count}`);
    lines.push('');
  }
  return lines.join('\n');
}

// CLI entry — only when invoked directly (matches apply-friction.mjs / Component 3).
{
  const argv1abs = process.argv[1] ? resolve(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1abs) {
    const args = process.argv.slice(2);
    const agentIdx = args.indexOf('--agent');
    const agentFilter = agentIdx !== -1 ? args[agentIdx + 1] : undefined;
    const projectRoot = process.cwd();
    const baselineCfg = loadFrictionConfig(join(projectRoot, 'config', 'friction.json'));
    const stressCfg = buildStressConfig(baselineCfg);
    const cutoffMs = cutoffDateToMs(PART_A_DEPLOY_CUTOFF);

    const byAgent = {}; // strat → { closed:[], open:[] }
    for (const dbPath of resolveSandboxDbPaths(projectRoot, agentFilter)) {
      try {
        for (const p of readClosedManagedPositions(dbPath)) {
          (byAgent[p.agentStrategy] ??= { closed: [], open: [] }).closed.push(p);
        }
        for (const p of readOpenManagedPositions(dbPath)) {
          (byAgent[p.agentStrategy] ??= { closed: [], open: [] }).open.push(p);
        }
      } catch (err) {
        process.stderr.write(`skip ${dbPath}: ${err.message}\n`);
      }
    }
    const perAgent = {};
    for (const [strat, { closed, open }] of Object.entries(byAgent)) {
      if (!strat) continue; // skip untagged
      perAgent[strat] = buildAgentLedger(closed, open, cutoffMs, strat, baselineCfg, stressCfg);
    }
    process.stdout.write(renderLedgerMarkdown(buildLedgerReport(perAgent)) + '\n');
  }
}
