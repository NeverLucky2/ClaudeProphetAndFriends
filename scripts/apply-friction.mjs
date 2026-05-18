// Friction post-processor. Reads raw decisive_actions JSON, applies asset-class-specific
// friction estimates, writes parallel *.friction.json files. Spec:
// docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as defaultFs from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const IC_MARKERS = ['iron condor', 'ic ', ' ic', '4-leg', '4 leg'];
const STOP_OUT_SUBSTRINGS = [
  'stop hit',
  'stopped out',
  'stop triggered',
  'hit my stop',
  'hit stop',
  'stop loss fired',
  'sl hit',
  'stop loss triggered',
  'forced out',
];

export function detectAssetClass(action, agentId) {
  if (agentId === 'harvest') return 'iron_condor';
  const symbol = action?.symbol;
  if (typeof symbol !== 'string' || symbol.length === 0) return null;

  if (OCC_SYMBOL.test(symbol)) {
    const reasoning = (action.reasoning ?? '').toLowerCase();
    const hasMarker = IC_MARKERS.some(m => reasoning.includes(m));
    return hasMarker ? 'iron_condor' : 'single_leg_options';
  }

  // Plain ticker heuristic: 1-5 uppercase letters
  if (/^[A-Z]{1,5}$/.test(symbol)) {
    return agentId === 'penny-prophet' ? 'penny_stocks' : 'stocks';
  }

  return null;
}

export function isStopOut(action) {
  const unrealizedPct = action?.market_data?.unrealized_pct;
  if (typeof unrealizedPct !== 'number' || unrealizedPct >= 0) return false;
  const reasoning = (action?.reasoning ?? '').toLowerCase();
  return STOP_OUT_SUBSTRINGS.some(s => reasoning.includes(s));
}

export function computeStockFriction(action, profile, stopOut) {
  const md = action?.market_data ?? {};
  const { entry_price, size } = md;
  if (typeof size !== 'number') {
    throw new Error(`computeStockFriction: missing market_data.size on action ${action?.symbol}`);
  }

  const slippage = profile.per_share_slippage_usd * size * 2;
  const regulatory_fees = profile.regulatory_fee_per_share * size * 2;
  const commissions = (profile.commission_per_share ?? 0) * size * 2;
  const stop_gap_through = stopOut
    ? profile.stop_gap_through_pct * entry_price * size
    : 0;

  const haircut_total_usd = +(slippage + regulatory_fees + commissions + stop_gap_through).toFixed(4);
  return {
    haircut_total_usd,
    haircut_breakdown: { slippage, regulatory_fees, commissions, stop_gap_through },
  };
}

export function computePennyFriction(action, profile, stopOut) {
  const md = action?.market_data ?? {};
  const { entry_price, size } = md;
  if (typeof size !== 'number') {
    throw new Error(`computePennyFriction: missing market_data.size on action ${action?.symbol}`);
  }
  if (typeof entry_price !== 'number') {
    throw new Error(`computePennyFriction: missing market_data.entry_price on action ${action?.symbol}`);
  }

  const effectiveSlippagePerShare = Math.max(
    profile.per_share_slippage_usd,
    profile.slippage_pct_of_price_floor * entry_price,
  );
  const slippage = effectiveSlippagePerShare * size * 2;
  const regulatory_fees = profile.regulatory_fee_per_share * size * 2;
  const commissions = (profile.commission_per_share ?? 0) * size * 2;
  const stop_gap_through = stopOut
    ? profile.stop_gap_through_pct * entry_price * size
    : 0;

  const haircut_total_usd = +(slippage + regulatory_fees + commissions + stop_gap_through).toFixed(4);
  return {
    haircut_total_usd,
    haircut_breakdown: { slippage, regulatory_fees, commissions, stop_gap_through },
  };
}

export function computeSingleLegOptionFriction(action, profile) {
  const md = action?.market_data ?? {};
  const { entry_price, exit_price, size } = md;
  if (typeof entry_price !== 'number' || typeof exit_price !== 'number' || typeof size !== 'number') {
    throw new Error(`computeSingleLegOptionFriction: missing entry_price/exit_price/size on ${action?.symbol}`);
  }

  const mid_price = (entry_price + exit_price) / 2;
  const spread_dollars = profile.assumed_spread_pct_of_mid * mid_price;
  const close_was_losing = exit_price < entry_price;
  const selected_close_pct = close_was_losing
    ? profile.spread_crossing_pct_close_when_losing
    : profile.spread_crossing_pct_close;

  const spread_crossing = spread_dollars * (profile.spread_crossing_pct_open + selected_close_pct) * size * 100;
  const commissions = profile.commission_per_contract * size * 2;
  const regulatory_fees = profile.regulatory_fee_per_contract * size * 2;

  const haircut_total_usd = +(spread_crossing + commissions + regulatory_fees).toFixed(4);
  return {
    haircut_total_usd,
    close_was_losing,
    haircut_breakdown: { spread_crossing, commissions, regulatory_fees },
  };
}

export function computeIronCondorFriction(action, profile) {
  const md = action?.market_data ?? {};
  const { entry_price, exit_price, size } = md;
  if (typeof entry_price !== 'number' || typeof exit_price !== 'number' || typeof size !== 'number') {
    throw new Error(`computeIronCondorFriction: missing entry_price/exit_price/size on ${action?.symbol}`);
  }

  const theoretical_credit = typeof md.theoretical_credit === 'number'
    ? md.theoretical_credit
    : entry_price * size * 100;

  const close_was_losing = exit_price < entry_price;
  const base_spread_cost = profile.assumed_spread_pct_of_credit * theoretical_credit;
  const losing_close_multiplier = close_was_losing
    ? (profile.spread_crossing_pct_close_when_losing - profile.spread_crossing_pct_close)
    : 0;
  const spread_crossing = base_spread_cost * (1 + losing_close_multiplier);

  const commissions = profile.commission_per_contract * profile.leg_count * 2 * size;
  const regulatory_fees = profile.regulatory_fee_per_contract * profile.leg_count * 2 * size;

  const haircut_total_usd = +(spread_crossing + commissions + regulatory_fees).toFixed(4);
  return {
    haircut_total_usd,
    close_was_losing,
    haircut_breakdown: { spread_crossing, commissions, regulatory_fees },
  };
}

const CALCULATORS = {
  stocks: (action, profile) => {
    const stopOut = isStopOut(action);
    const r = computeStockFriction(action, profile, stopOut);
    return { ...r, close_was_losing: action.market_data.exit_price < action.market_data.entry_price };
  },
  penny_stocks: (action, profile) => {
    const stopOut = isStopOut(action);
    const r = computePennyFriction(action, profile, stopOut);
    return { ...r, close_was_losing: action.market_data.exit_price < action.market_data.entry_price };
  },
  single_leg_options: (action, profile) => computeSingleLegOptionFriction(action, profile),
  iron_condor: (action, profile) => computeIronCondorFriction(action, profile),
};

function configHashShort(config) {
  // Stable JSON for hashing (sorted keys).
  const json = JSON.stringify(config, Object.keys(config).sort());
  return createHash('sha256').update(json).digest('hex').slice(0, 8);
}

function deriveRawPl(action, profileKey) {
  const md = action.market_data;
  if (typeof md.unrealized_pl === 'number') return md.unrealized_pl;
  const isOption = profileKey === 'single_leg_options' || profileKey === 'iron_condor';
  const multiplier = isOption ? 100 : 1;
  return (md.exit_price - md.entry_price) * md.size * multiplier;
}

export function applyFriction(action, agentId, config) {
  const profileKey = detectAssetClass(action, agentId);
  if (!profileKey) return { skip: true, reason: 'unrecognized asset class' };

  const md = action?.market_data;
  if (!md || typeof md.entry_price !== 'number' || typeof md.exit_price !== 'number') {
    return { skip: true, reason: 'missing market_data.entry_price or exit_price' };
  }

  const profile = config[profileKey];
  if (!profile) return { skip: true, reason: `no friction profile for ${profileKey}` };

  const calc = CALCULATORS[profileKey](action, profile);
  const raw_pl = deriveRawPl(action, profileKey);
  const friction_adjusted_pl = +(raw_pl - calc.haircut_total_usd).toFixed(4);

  const augmented = {
    ...action,
    market_data: {
      ...md,
      raw_pl,
      friction_adjusted_pl,
    },
    friction_meta: {
      profile_applied: profileKey,
      close_was_losing: calc.close_was_losing,
      haircut_total_usd: calc.haircut_total_usd,
      haircut_breakdown: calc.haircut_breakdown,
      friction_config_version: config.version,
      friction_config_hash: configHashShort(config),
    },
  };

  const sign_flip_warning = raw_pl > 0 && friction_adjusted_pl < 0;
  return sign_flip_warning ? { action: augmented, sign_flip_warning: true } : { action: augmented };
}

const REQUIRED_PROFILES = ['stocks', 'penny_stocks', 'single_leg_options', 'iron_condor'];

export function loadFrictionConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`friction config not found at ${path}. See docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md for the required schema.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`friction config at ${path} is not valid JSON: ${err.message}`);
  }
  if (typeof parsed.version !== 'string') {
    throw new Error(`friction config at ${path} is missing required string field "version"`);
  }
  for (const key of REQUIRED_PROFILES) {
    if (!parsed[key] || typeof parsed[key] !== 'object') {
      throw new Error(`friction config at ${path} is missing required profile "${key}"`);
    }
  }
  return parsed;
}

export function writeAtomic(path, content, fsImpl = defaultFs) {
  const tmp = `${path}.tmp`;
  fsImpl.writeFileSync(tmp, content);
  try {
    fsImpl.renameSync(tmp, path);
  } catch (err) {
    if (fsImpl.existsSync(tmp)) {
      try { fsImpl.unlinkSync(tmp); } catch { /* best effort */ }
    }
    throw err;
  }
}

export function resolveSandboxesForAgent(agentConfigPath, agentId) {
  if (!existsSync(agentConfigPath)) {
    throw new Error(`agent-config not found at ${agentConfigPath}`);
  }
  const cfg = JSON.parse(readFileSync(agentConfigPath, 'utf8'));
  const sandboxes = cfg.sandboxes ?? {};
  const ids = [];
  for (const sb of Object.values(sandboxes)) {
    if (sb?.agent?.activeAgentId === agentId && typeof sb.accountId === 'string') {
      ids.push(sb.accountId);
    }
  }
  return ids;
}

export function processSandboxes({ agentId, projectRoot, fs = defaultFs }) {
  const configPath = join(projectRoot, 'config', 'friction.json');
  const agentCfgPath = join(projectRoot, 'data', 'agent-config.json');
  const config = loadFrictionConfig(configPath);
  const sandboxIds = resolveSandboxesForAgent(agentCfgPath, agentId);

  const stats = { processed: 0, skipped: 0, sign_flips: 0, skip_reasons: {} };

  for (const sbId of sandboxIds) {
    const dir = join(projectRoot, 'data', 'sandboxes', sbId, 'decisive_actions');
    if (!fs.existsSync(dir)) continue;
    const entries = readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.friction.json'));
    for (const fname of entries) {
      const fullPath = join(dir, fname);
      let action;
      try {
        action = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch (err) {
        process.stderr.write(`apply-friction: malformed JSON at ${fullPath}: ${err.message}\n`);
        stats.skipped += 1;
        stats.skip_reasons['malformed_json'] = (stats.skip_reasons['malformed_json'] ?? 0) + 1;
        continue;
      }
      let out;
      try {
        out = applyFriction(action, agentId, config);
      } catch (err) {
        process.stderr.write(`apply-friction: calculator error at ${fullPath}: ${err.message}\n`);
        stats.skipped += 1;
        stats.skip_reasons['calculator_error'] = (stats.skip_reasons['calculator_error'] ?? 0) + 1;
        continue;
      }
      if (out.skip) {
        process.stderr.write(`apply-friction: skipped ${fullPath}: ${out.reason}\n`);
        stats.skipped += 1;
        stats.skip_reasons[out.reason] = (stats.skip_reasons[out.reason] ?? 0) + 1;
        continue;
      }
      if (out.sign_flip_warning) {
        process.stderr.write(`apply-friction: sign-flip on ${fullPath} (raw ${out.action.market_data.raw_pl} -> adjusted ${out.action.market_data.friction_adjusted_pl})\n`);
        stats.sign_flips += 1;
      }
      const outPath = join(dir, fname.replace(/\.json$/, '.friction.json'));
      const content = JSON.stringify(out.action, null, 2);
      writeAtomic(outPath, content, fs);
      stats.processed += 1;
    }
  }

  return stats;
}

// CLI entry — only runs when invoked directly, not when imported.
// On Windows, import.meta.url uses forward slashes and file:///C:/... triple-slash form,
// while process.argv[1] may be a relative or backslash path. Resolve both to absolute OS paths.
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolve(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const agentIdx = args.indexOf('--agent');
    if (agentIdx === -1 || !args[agentIdx + 1]) {
      process.stderr.write('Usage: node scripts/apply-friction.mjs --agent <agent-id>\n');
      process.exit(2);
    }
    const agentId = args[agentIdx + 1];
    const projectRoot = process.cwd();
    const stats = processSandboxes({ agentId, projectRoot });
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  }
}
