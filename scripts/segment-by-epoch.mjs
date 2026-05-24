// scripts/segment-by-epoch.mjs
// Label loaded trades by ruleset epoch and apply the straddle policy for
// adapt-strategy. Pure functions + stdin CLI.
// Spec: docs/superpowers/specs/2026-05-23-adapt-strategy-epoch-conditional-split-design.md
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

export function labelTrade(trade, currentVersions, updatedAt) {
  if (trade.strategyVersion) {
    return currentVersions.includes(trade.strategyVersion) ? 'current' : 'prior';
  }
  // Un-stamped: fall back to the updatedAt heuristic. A missing/malformed
  // timestamp or updatedAt means the epoch is genuinely unknown (NOT 'prior').
  if (!updatedAt) return 'unknown';
  const tsMs = new Date(trade.timestamp).getTime();
  const cutMs = new Date(updatedAt).getTime();
  if (Number.isNaN(tsMs) || Number.isNaN(cutMs)) return 'unknown';
  return tsMs >= cutMs ? 'current' : 'prior';
}

export function currentEpochRate(currentTrades) {
  // <2 trades or a sub-hour span can't yield a meaningful rate — report null
  // rather than a floor artifact (a single trade would otherwise read ~24/day).
  if (currentTrades.length < 2) return { rate_per_day: null, span_days: 0 };
  const times = currentTrades.map(t => new Date(t.timestamp).getTime()).sort((a, b) => a - b);
  const rawSpanDays = (times[times.length - 1] - times[0]) / 86400000;
  if (!(rawSpanDays >= 1 / 24)) return { rate_per_day: null, span_days: 0 };
  return { rate_per_day: +(currentTrades.length / rawSpanDays).toFixed(3), span_days: +rawSpanDays.toFixed(3) };
}

export function segment(trades, opts = {}) {
  const { currentVersions = [], updatedAt = null, minCurrent = 20, minCurrentOverride = null } = opts;
  const labeled = trades.map(t => ({ ...t, epoch: labelTrade(t, currentVersions, updatedAt) }));
  const counts = { current: 0, prior: 0, unknown: 0 };
  let stamped = 0, fallback = 0;
  for (const t of labeled) {
    counts[t.epoch]++;
    if (t.strategyVersion) stamped++; else fallback++;
  }
  const cur = counts.current;
  const straddled = counts.prior > 0 || counts.unknown > 0;
  const current_epoch_set = labeled.filter(t => t.epoch === 'current');

  let recommended_case, override_applied = false, low_confidence = false;
  if (!straddled) {
    recommended_case = 1;
  } else if (cur >= minCurrent) {
    recommended_case = 2;
  } else if (minCurrentOverride != null && cur >= minCurrentOverride) {
    recommended_case = 2; override_applied = true; low_confidence = true;
  } else {
    recommended_case = 3;
  }

  const dropped = counts.prior + counts.unknown;
  const { rate_per_day } = currentEpochRate(current_epoch_set);
  const trades_needed = Math.max(0, minCurrent - cur);
  const eta_days = rate_per_day && rate_per_day > 0 ? Math.ceil(trades_needed / rate_per_day) : null;

  return {
    labeled,
    counts,
    stamped_vs_fallback: { stamped, fallback },
    current_epoch_set,
    straddled,
    recommended_case,
    override_applied,
    low_confidence,
    mixed_provenance: straddled && stamped > 0 && fallback > 0,
    drop: { dropped, total: trades.length, pct: trades.length ? +(dropped / trades.length).toFixed(3) : 0 },
    rate_per_day,
    trades_needed,
    eta_days,
  };
}

// CLI: trades JSON array on stdin; flags configure the policy.
//   --current-versions X,W   --updated-at <ISO>   --min-current 20   --min-current-override <N>
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const currentVersions = (flag('--current-versions') || '').split(',').map(s => s.trim()).filter(Boolean);
    const updatedAt = flag('--updated-at') || null;
    const minCurrent = Number(flag('--min-current') ?? 20);
    const ov = flag('--min-current-override');
    const minCurrentOverride = ov == null ? null : Number(ov);
    let stdin = '';
    process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      let trades;
      try { trades = JSON.parse(stdin); } catch (err) {
        process.stderr.write(`stdin is not valid JSON: ${err.message}\n`); process.exit(6);
      }
      process.stdout.write(JSON.stringify(segment(trades, { currentVersions, updatedAt, minCurrent, minCurrentOverride }), null, 2) + '\n');
    });
  }
}
