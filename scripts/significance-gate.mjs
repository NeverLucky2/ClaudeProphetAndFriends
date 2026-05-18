// scripts/significance-gate.mjs
// Per-asset-class significance gate for adapt-strategy. Spec:
// docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md

import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

export const WING_WIDTH_BY_UNDERLYING = { SPY: 5, QQQ: 5, IWM: 2, GLD: 2, TLT: 1 };
const OCC_RE = /^([A-Z]{1,6})\d{6}[CP]\d{8}$/;

function underlyingFromSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const m = OCC_RE.exec(symbol);
  if (m) return m[1];
  if (/^[A-Z]{1,5}$/.test(symbol)) return symbol;
  return null;
}

export function exposurePerTrade(trade) {
  const profile = trade?.friction_meta?.profile_applied;
  const md = trade?.market_data ?? {};
  const entry = Math.abs(md.entry_price ?? 0);
  const size = Math.abs(md.size ?? 0);
  if (profile === 'iron_condor') {
    if (typeof md.wing_width === 'number') return md.wing_width * size * 100;
    const u = underlyingFromSymbol(trade?.symbol);
    if (u && WING_WIDTH_BY_UNDERLYING[u] != null) {
      return WING_WIDTH_BY_UNDERLYING[u] * size * 100;
    }
    process.stderr.write(`significance-gate: iron_condor with unknown wing_width — falling back to crude 10x multiplier for ${trade?.symbol}\n`);
    return entry * size * 100 * 10;
  }
  if (profile === 'single_leg_options') return entry * size * 100;
  if (profile === 'stocks' || profile === 'penny_stocks') return entry * size;
  return entry * size;
}

export function gateForCategory(category, trades, params) {
  const { min_losing_trades, min_drawdown_pct } = params;
  const losses = trades.filter(t => (t.market_data?.friction_adjusted_pl ?? 0) < 0);
  const losing_pl_abs = Math.abs(losses.reduce((s, t) => s + (t.market_data?.friction_adjusted_pl ?? 0), 0));
  const gross_exposure = Math.max(trades.reduce((s, t) => s + exposurePerTrade(t), 0), 1);
  const drawdown_pct = losing_pl_abs / gross_exposure;
  const cleared = losses.length >= min_losing_trades || drawdown_pct >= min_drawdown_pct;
  return {
    category,
    trade_count: trades.length,
    losing_count: losses.length,
    drawdown_pct: +drawdown_pct.toFixed(6),
    threshold: params,
    cleared,
    reason: cleared
      ? null
      : `${losses.length} losses, ${(drawdown_pct * 100).toFixed(2)}% dd — below ${min_losing_trades} losses OR ${min_drawdown_pct * 100}% dd`,
  };
}

const DEFAULTS = { min_losing_trades: 5, min_drawdown_pct: 0.05 };

export function evaluateGate(trades, params = DEFAULTS) {
  const byCategoryTrades = {};
  for (const t of trades) {
    const key = t?.friction_meta?.profile_applied ?? 'unknown';
    (byCategoryTrades[key] ?? (byCategoryTrades[key] = [])).push(t);
  }
  const by_category = {};
  const cleared_categories = [];
  const blocked_categories = [];
  for (const [cat, list] of Object.entries(byCategoryTrades)) {
    const r = cat === 'unknown'
      ? { category: cat, trade_count: list.length, losing_count: 0, drawdown_pct: 0,
          threshold: params, cleared: false, reason: 'unknown asset class — gate never clears for this bucket by design' }
      : gateForCategory(cat, list, params);
    by_category[cat] = r;
    (r.cleared ? cleared_categories : blocked_categories).push(cat);
  }
  return {
    overall_trade_count: trades.length,
    by_category,
    cleared_categories,
    blocked_categories,
  };
}

// CLI
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const argFlag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const min_losing_trades = Number(argFlag('--min-losses') ?? DEFAULTS.min_losing_trades);
    const min_drawdown_pct = Number(argFlag('--min-drawdown') ?? DEFAULTS.min_drawdown_pct);
    let stdin = '';
    process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      let trades;
      try { trades = JSON.parse(stdin); } catch (err) {
        process.stderr.write(`stdin is not valid JSON: ${err.message}\n`);
        process.exit(6);
      }
      try {
        const result = evaluateGate(trades, { min_losing_trades, min_drawdown_pct });
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } catch (err) {
        process.stderr.write(`${err.message}\n`);
        process.exit(6);
      }
    });
  }
}
