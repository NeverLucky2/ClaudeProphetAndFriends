import { classifyBand, normalizePnlPct, loadSkipConfig } from './prophet-beat-decision.js';

// Renders the beat-context block injected into every heartbeat prompt.
// Output is read-only context, NOT a checklist — agents are told to call
// the underlying MCP tools only when they need fresher data than the snapshot.
export function renderBeatContextBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines = [];
  if (ctx.account && typeof ctx.account.portfolio_value === 'number') {
    const a = ctx.account;
    lines.push(`Portfolio: $${a.portfolio_value.toLocaleString()} | Cash: $${(a.cash ?? 0).toLocaleString()} | Buying Power: $${(a.buying_power ?? 0).toLocaleString()}`);
  }
  // When a strategy filter was applied to the request (segment_pnl.strategy
  // present), label the positions header so the agent knows the list is
  // YOUR strategy's positions, not all broker positions. On 2026-05-18 Spark
  // saw LAND under an unlabeled "Positions:" header, assumed it was a foreign
  // broker position because get_managed_positions had returned 0 (separate
  // PENDING/ACTIVE bug), and walked away from a position it should have
  // managed. Explicit attribution closes that reasoning gap.
  const strategyTag = ctx.segment_pnl && ctx.segment_pnl.strategy ? ctx.segment_pnl.strategy : '';
  const positionsHeader = strategyTag
    ? `Positions (your ${strategyTag} positions, attributed via order tag):`
    : 'Positions:';
  if (Array.isArray(ctx.positions) && ctx.positions.length > 0) {
    lines.push(positionsHeader);
    const { thresholds } = loadSkipConfig();
    for (const p of ctx.positions) {
      const sign = p.unrealized_pnl_pct >= 0 ? '+' : '';
      const band = classifyBand(normalizePnlPct(Number(p.unrealized_pnl_pct)), thresholds);
      lines.push(`  - ${p.symbol}: ${p.qty} sh, P&L ${sign}${(p.unrealized_pnl_pct ?? 0).toFixed(1)}% ($${(p.unrealized_pnl ?? 0).toFixed(2)}) [${band}]`);
    }
  } else if (Array.isArray(ctx.positions)) {
    lines.push(strategyTag ? `Positions (your ${strategyTag} positions): none` : 'Positions: none');
  }
  if (ctx.econ_blackout) {
    lines.push(`Econ Blackout: ${ctx.econ_blackout.is_blackout ? 'YES — ' + (ctx.econ_blackout.reason || 'unspecified') : 'no'}`);
  }
  if (ctx.regime_gate) {
    const rg = ctx.regime_gate;
    lines.push(`Regime: ${rg.tier} (score ${rg.score}, size ${rg.sizing_multiplier}×, block=${rg.block_new_entries})`);
  }
  if (ctx.segment_pnl) {
    const sp = ctx.segment_pnl;
    lines.push(`Segment ${sp.strategy}: P&L ${sp.unrealized_pnl_percent.toFixed(2)}%, deployed ${sp.deployed_percent.toFixed(1)}%`);
  }
  if (Array.isArray(ctx.errors) && ctx.errors.length > 0) {
    lines.push(`errors: ${ctx.errors.join('; ')}`);
  }
  if (lines.length === 0) return '';
  return '## Beat Context (read-only snapshot)\n' + lines.join('\n');
}

// fetchBeatContext returns the parsed payload or null on any error / timeout.
// The 3000ms timeout matches agent/harness.js's intraday-blob fetch — same
// soft-fail philosophy: a missing block does not block the beat, the LLM can
// fetch fresh via the underlying MCP tools. 3000ms gives generous headroom
// for cold paths (account/positions/regime aggregation) without becoming
// visible at the 10-min midday beat cadence.
export async function fetchBeatContext(goAxios, strategyId) {
  if (!goAxios) return null;
  try {
    const url = strategyId
      ? `/api/v1/beat-context?strategy=${encodeURIComponent(strategyId)}`
      : '/api/v1/beat-context';
    const resp = await goAxios.get(url, { timeout: 3000 });
    return resp?.data ?? null;
  } catch (_err) {
    return null;
  }
}
