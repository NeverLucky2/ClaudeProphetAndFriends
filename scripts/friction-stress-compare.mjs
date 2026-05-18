// scripts/friction-stress-compare.mjs
// Baseline-vs-stress friction comparison. Spec:
// docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md

import { fileURLToPath } from 'node:url';
import { resolve as resolvePath, join, dirname } from 'node:path';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { processSandboxes, resolveSandboxesForAgent } from './apply-friction.mjs';

function baseKey(filename) {
  // 'a.friction.json' or 'a.friction-stress.json' both → 'a'
  return filename.replace(/\.friction(-stress)?\.json$/, '');
}

export function compareFrictionSets({ agent, baseline, stress, asOf = new Date().toISOString() }) {
  const baselineByKey = new Map(baseline.map(r => [baseKey(r.filename), r]));
  const stressByKey = new Map(stress.map(r => [baseKey(r.filename), r]));
  const unmatched = [];
  const flips = [];
  const perAsset = {};
  let baseline_pl_usd = 0;
  let stress_pl_usd = 0;
  let trade_count = 0;

  for (const [key, b] of baselineByKey) {
    const s = stressByKey.get(key);
    if (!s) {
      unmatched.push({ filename: b.filename, symbol: b.symbol, reason: 'missing in stress run' });
      continue;
    }
    trade_count += 1;
    const bPl = b.market_data?.friction_adjusted_pl ?? 0;
    const sPl = s.market_data?.friction_adjusted_pl ?? 0;
    baseline_pl_usd += bPl;
    stress_pl_usd += sPl;
    const flipped = Math.sign(bPl) !== Math.sign(sPl);
    if (flipped) flips.push({ symbol: b.symbol, timestamp: b.timestamp, baseline_pl: bPl, stress_pl: sPl });
    const asset = b.friction_meta?.profile_applied ?? 'unknown';
    perAsset[asset] = perAsset[asset] ?? { trade_count: 0, baseline_pl: 0, stress_pl: 0, flips: 0 };
    perAsset[asset].trade_count += 1;
    perAsset[asset].baseline_pl += bPl;
    perAsset[asset].stress_pl += sPl;
    if (flipped) perAsset[asset].flips += 1;
  }
  for (const [key, s] of stressByKey) {
    if (!baselineByKey.has(key)) {
      unmatched.push({ filename: s.filename, symbol: s.symbol, reason: 'missing in baseline run' });
    }
  }
  const total_delta_usd = +(stress_pl_usd - baseline_pl_usd).toFixed(4);
  const avg_per_trade_delta_usd = trade_count > 0 ? +(total_delta_usd / trade_count).toFixed(4) : 0;
  return {
    agent,
    as_of: asOf,
    totals: {
      trade_count,
      baseline_pl_usd: +baseline_pl_usd.toFixed(4),
      stress_pl_usd: +stress_pl_usd.toFixed(4),
      total_delta_usd,
      avg_per_trade_delta_usd,
    },
    flips,
    per_asset_class: perAsset,
    unmatched,
  };
}

function loadFrictionFiles(projectRoot, agentId, suffix) {
  const sandboxIds = resolveSandboxesForAgent(join(projectRoot, 'data', 'agent-config.json'), agentId);
  const out = [];
  for (const sb of sandboxIds) {
    const dir = join(projectRoot, 'data', 'sandboxes', sb, 'decisive_actions');
    if (!existsSync(dir)) continue;
    const target = `.${suffix}.json`;
    for (const f of readdirSync(dir).filter(n => n.endsWith(target))) {
      try {
        const content = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        out.push({ ...content, filename: f });
      } catch (err) {
        process.stderr.write(`friction-stress-compare: skipping malformed ${f}: ${err.message}\n`);
      }
    }
  }
  return out;
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, content);
  try { renameSync(tmp, path); }
  catch (err) { if (existsSync(tmp)) try { unlinkSync(tmp); } catch {} throw err; }
}

export async function runCompare({ agentId, projectRoot, outPath }) {
  // 1. Generate baseline friction (.friction.json)
  processSandboxes({ agentId, projectRoot });
  // 2. Generate stress friction (.friction-stress.json)
  processSandboxes({ agentId, projectRoot, frictionConfigPath: join(projectRoot, 'config', 'friction-stress.json') });
  const baseline = loadFrictionFiles(projectRoot, agentId, 'friction');
  const stress = loadFrictionFiles(projectRoot, agentId, 'friction-stress');
  const report = compareFrictionSets({ agent: agentId, baseline, stress });
  const defaultOut = join(projectRoot, 'data', 'reports', `friction_stress_${agentId}_${new Date().toISOString().slice(0,10).replace(/-/g,'')}.json`);
  const target = outPath ?? defaultOut;
  writeAtomic(target, JSON.stringify(report, null, 2));
  return { report, path: target };
}

// CLI
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const agentIdx = args.indexOf('--agent');
    const outIdx = args.indexOf('--out');
    if (agentIdx === -1) {
      process.stderr.write('Usage: node scripts/friction-stress-compare.mjs --agent <agent-id> [--out <path>]\n');
      process.exit(2);
    }
    const agentId = args[agentIdx + 1];
    const outPath = outIdx !== -1 ? args[outIdx + 1] : undefined;
    runCompare({ agentId, projectRoot: process.cwd(), outPath }).then(
      ({ path }) => { process.stdout.write(JSON.stringify({ written: path }) + '\n'); },
      (err) => { process.stderr.write(`friction-stress-compare: ${err.message}\n`); process.exit(1); },
    );
  }
}
