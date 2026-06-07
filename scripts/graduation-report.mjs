// scripts/graduation-report.mjs
// 2c orchestrator: per-agent 2a ledger + 2b beta → 2c verdict → markdown. Read-only; never auto-acts.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSandboxDbPaths, readClosedManagedPositions, cutoffDateToMs, PART_A_DEPLOY_CUTOFF } from './managed-position-repair.mjs';
import { buildAgentLedger, buildStressConfig, readOpenManagedPositions } from './trade-ledger.mjs';
import { readSegmentDaily, computeDailyReturns, computeBeta } from './segment-beta.mjs';
import { fetchSpyDaily } from './alpaca-spy-daily.mjs';
import { trackOf, alphaVerdict, ballastVerdict } from './graduation-gate.mjs';

// Pure: given the assembled per-agent inputs, pick the track + verdict. m carries ledger/beta/etc.
export function assembleVerdict(strategyId, m, params) {
  const track = trackOf(strategyId);
  if (track === 'ballast') {
    return {
      track, ...ballastVerdict({
        structurallyConvex: m.structurallyConvex, expectancy: m.expectancy,
        bleedBudgetPerTrade: m.bleedBudgetPerTrade, downsideBeta: m.beta?.downside, durationMonths: m.durationMonths,
      }, params),
    };
  }
  return {
    track, ...alphaVerdict({
      eligibleTrades: m.ledger?.eligible?.count ?? 0, edgeCI: m.ledger?.edgeCI ?? {},
      adversityCleared: !!m.adversityCleared, durationMonths: m.durationMonths ?? 0, deployedBeta: m.beta?.deployed ?? {},
    }, params),
  };
}

// CLI: node scripts/graduation-report.mjs [--root .]  (agents resolved per Component 3)
// NOTE: data-coupled; left as the live entry point. The per-agent assembly reuses the imports above:
//   closed = readClosedManagedPositions(dbPath); open = readOpenManagedPositions(dbPath);
//   ledger = buildAgentLedger(closed, open, cutoffMs, agentId, baselineCfg, buildStressConfig(baselineCfg));
//   spy = await fetchSpyDaily(start, end); rows = readSegmentDaily(dbPath, strategyId);
//   beta = computeBeta(computeDailyReturns(rows, spy), Object.fromEntries(spy.dates.slice(1).map((d,i)=>[d, spy.close[d]/spy.close[spy.dates[i]]-1])), { minDays: 30 });
//   verdict = assembleVerdict(strategyId, { ledger, beta, ... }, { N: 20, BETA_BAND: 0.6 });
// Emit a markdown table of {agent, track, verdict, blocking reason} to docs/lab/graduation-report.md.

// agentId = sandbox activeAgentId (confirmed in data/agent-config.json — resolveSandboxDbPaths
// matches on it). strategyId = the segment `strategy` column key the Go writer uses (AgentStrategy);
// inert until the db_segment_pn_ls writer has produced rows (Go rebuild) — confirm against the table
// once rows exist. Prophet's own 'default' sandbox is intentionally NOT a graduation candidate here.
const AGENTS = [
  { agentId: 'mean-rev', strategyId: 'mean_rev', name: 'Coil' },
  { agentId: 'trend-prophet', strategyId: 'trend', name: 'Turtle' },
  { agentId: 'drift', strategyId: 'drift', name: 'Drift' },
  { agentId: 'defensive-prophet', strategyId: 'prophet-defensive', name: 'DefensiveProphet' },
];

async function main() {
  const projectRoot = '.';
  const cutoffMs = cutoffDateToMs(PART_A_DEPLOY_CUTOFF);
  const baselineCfg = JSON.parse(readFileSync(join(projectRoot, 'config', 'friction.json'), 'utf8'));

  const rows = [];
  rows.push('| Agent | Track | Verdict | Reason |');
  rows.push('|-------|-------|---------|--------|');

  for (const { agentId, strategyId, name } of AGENTS) {
    try {
      const dbPaths = resolveSandboxDbPaths(projectRoot, agentId);
      if (dbPaths.length === 0) { rows.push(`| ${name} | — | HOLD | no sandbox DB resolved for agentId '${agentId}' |`); continue; }
      const dbPath = dbPaths[0];
      const closed = readClosedManagedPositions(dbPath);
      const open = readOpenManagedPositions(dbPath);
      const ledger = buildAgentLedger(closed, open, cutoffMs, agentId, baselineCfg, buildStressConfig(baselineCfg));

      // SPY daily closes; determine window from the earliest segment row
      const segmentRows = readSegmentDaily(dbPath, strategyId);
      if (segmentRows.length === 0) {
        rows.push(`| ${name} | — | HOLD | insufficient data (no segment rows) |`);
        continue;
      }
      const start = segmentRows[0].date;
      const end = new Date().toISOString().split('T')[0];
      const spy = await fetchSpyDaily(start, end);
      if (spy.dates.length === 0) {
        rows.push(`| ${name} | — | HOLD | SPY fetch failed, no data |`);
        continue;
      }

      // Compute returns + beta
      const stratReturns = computeDailyReturns(segmentRows, spy);
      const spyRetsByDate = Object.fromEntries(spy.dates.slice(1).map((d, i) => [d, spy.close[d] / spy.close[spy.dates[i]] - 1]));
      const beta = computeBeta(stratReturns, spyRetsByDate, { minDays: 30 });

      // Build verdict inputs
      let inputs = { ledger, beta, durationMonths: 0, adversityCleared: false };
      if (strategyId === 'prophet-defensive') {
        inputs = {
          ...inputs,
          structurallyConvex: true,
          expectancy: ledger?.eligible?.expectancy ?? 0,
          bleedBudgetPerTrade: -100, // TBD: options friction model + dollar bleed budget, per spec §8
        };
      } else {
        // Alpha track: compute duration in months from the earliest closed/open position
        const allPositions = [...closed, ...open];
        if (allPositions.length > 0) {
          const earliest = allPositions.reduce((a, b) => (new Date(a.createdAt) < new Date(b.createdAt) ? a : b));
          const ageMs = Date.now() - new Date(earliest.createdAt).getTime();
          inputs.durationMonths = ageMs / (30 * 24 * 3600 * 1000);
        }
        // Adversity floor: >=5 eligible losing trades (the significance-gate losses arm; the
        // drawdown arm needs per-trade exposure not exposed by the ledger aggregate).
        inputs.adversityCleared = (ledger?.eligible?.losers ?? 0) >= 5;
      }

      // Verdict
      const verdict = assembleVerdict(strategyId, inputs, { N: 20, BETA_BAND: 0.6 });
      rows.push(`| ${name} | ${verdict.track} | ${verdict.verdict} | ${verdict.reason} |`);
    } catch (e) {
      rows.push(`| ${name} | — | ERROR | ${e.message} |`);
    }
  }

  const md = rows.join('\n');
  writeFileSync(join(projectRoot, 'docs', 'lab', 'graduation-report.md'), md);
  console.log(md);
}

main().catch((e) => {
  process.stderr.write(`graduation-report: ${e.message}\n`);
  process.exit(1);
});
