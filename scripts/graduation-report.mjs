// scripts/graduation-report.mjs
// 2c orchestrator: per-agent 2a ledger + 2b beta → 2c verdict → markdown. Read-only; never auto-acts.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSandboxDbPaths, readClosedManagedPositions, cutoffDateToMs, PART_A_DEPLOY_CUTOFF } from './managed-position-repair.mjs';
import { buildAgentLedger, buildStressConfig, readOpenManagedPositions } from './trade-ledger.mjs';
import { readSegmentDaily, computeDailyReturns, computeBeta } from './segment-beta.mjs';
import { fetchSpyDaily } from './alpaca-spy-daily.mjs';
import { trackOf, alphaVerdict, ballastVerdict } from './graduation-gate.mjs';
import { COIL_STRATEGY_IDS, COIL_PAPER_STRATEGY_ID, COIL_LIVE_STRATEGY_ID } from '../agent/coil-strategy-ids.js';

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
// matches on it). strategyId = the segment `strategy` column key the Go writer uses VERBATIM
// (services/segment_pnl_writer.go: DBSegmentPnL.Strategy = the `strat` loop variable, which comes
// straight from LocalStorage.ListManagedStrategies() — the distinct agent_strategy values on
// managed_positions, unmodified). There is no separate snake_case segment-key namespace anywhere
// in the Go pipeline (confirmed by reading segment_pnl_writer.go + database/storage.go directly);
// the old 'mean_rev' value here never matched a real row for paper Coil either — a pre-writer
// guess that was never reconciled once the real writer landed.
//
// strategyId may be an array: Coil trades under two agent_strategy values that share one
// activeAgentId ('mean-rev') — paper (COIL_PAPER_STRATEGY_ID) in the shared paper-account DB, and
// live (COIL_LIVE_STRATEGY_ID) in live's own dedicated DB. main() below tries every (dbPath,
// strategyId) pair resolveSandboxDbPaths(agentId) turns up and emits one row per pair that
// actually has segment data, so paper and live Coil graduate as separate, independently measured
// track records rather than being silently merged or dropped. Exported so
// agent/coil-strategy-registration.test.mjs can assert COIL_LIVE_STRATEGY_ID is present here and
// never silently dropped. Prophet's own 'default' sandbox is intentionally NOT a graduation
// candidate here.
export const AGENTS = [
  { agentId: 'mean-rev', strategyId: COIL_STRATEGY_IDS, name: 'Coil' },
  { agentId: 'trend-prophet', strategyId: 'trend', name: 'Turtle' },
  { agentId: 'drift', strategyId: 'drift', name: 'Drift' },
  { agentId: 'defensive-prophet', strategyId: 'prophet-defensive', name: 'DefensiveProphet' },
];

// Human-readable labels for Coil's two track records, used only when an AGENTS entry
// resolves to more than one strategyId (today, only Coil).
const MULTI_ID_LABELS = { [COIL_PAPER_STRATEGY_ID]: 'Coil (paper)', [COIL_LIVE_STRATEGY_ID]: 'Coil (live)' };

async function main() {
  const projectRoot = '.';
  const cutoffMs = cutoffDateToMs(PART_A_DEPLOY_CUTOFF);
  const baselineCfg = JSON.parse(readFileSync(join(projectRoot, 'config', 'friction.json'), 'utf8'));

  const rows = [];
  rows.push('| Agent | Track | Verdict | Reason |');
  rows.push('|-------|-------|---------|--------|');

  for (const { agentId, strategyId, name } of AGENTS) {
    // strategyId is usually a single string; Coil's is COIL_STRATEGY_IDS (an array),
    // since paper and live are two separate agent_strategy values sharing one
    // activeAgentId. Normalize to an array uniformly so the loop below is the same
    // shape for every agent — for single-id agents this is a 1-element array, so
    // dbPaths × strategyIds degenerates to exactly the old dbPaths[0] × strategyId
    // behavior.
    const strategyIds = Array.isArray(strategyId) ? strategyId : [strategyId];
    try {
      const dbPaths = resolveSandboxDbPaths(projectRoot, agentId);
      if (dbPaths.length === 0) { rows.push(`| ${name} | — | HOLD | no sandbox DB resolved for agentId '${agentId}' |`); continue; }

      // Try every (dbPath, strategyId) pair and emit a row for each one that actually
      // has segment data. For single-id agents there is exactly one pair (unchanged
      // behavior). For Coil there are up to 4 (2 dbPaths × 2 ids), but only the
      // correctly-matched pairs (paper db × paper id, live db × live id) ever have
      // data — the mismatched pairs are cheaply skipped by the segmentRows check
      // before any ledger/SPY work is done.
      let emittedAny = false;
      for (const dbPath of dbPaths) {
        for (const sid of strategyIds) {
          const label = strategyIds.length > 1 ? (MULTI_ID_LABELS[sid] || `${name} (${sid})`) : name;
          try {
            const segmentRows = readSegmentDaily(dbPath, sid);
            if (segmentRows.length === 0) continue; // wrong (db, id) pairing — try the next
            emittedAny = true;

            const closed = readClosedManagedPositions(dbPath);
            const open = readOpenManagedPositions(dbPath);
            const ledger = buildAgentLedger(closed, open, cutoffMs, agentId, baselineCfg, buildStressConfig(baselineCfg));

            // SPY daily closes; determine window from the earliest segment row
            const start = segmentRows[0].date;
            const end = new Date().toISOString().split('T')[0];
            const spy = await fetchSpyDaily(start, end);
            if (spy.dates.length === 0) {
              rows.push(`| ${label} | — | HOLD | SPY fetch failed, no data |`);
              continue;
            }

            // Compute returns + beta
            const stratReturns = computeDailyReturns(segmentRows, spy);
            const spyRetsByDate = Object.fromEntries(spy.dates.slice(1).map((d, i) => [d, spy.close[d] / spy.close[spy.dates[i]] - 1]));
            const beta = computeBeta(stratReturns, spyRetsByDate, { minDays: 30 });

            // Build verdict inputs
            let inputs = { ledger, beta, durationMonths: 0, adversityCleared: false };
            if (sid === 'prophet-defensive') {
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
            const verdict = assembleVerdict(sid, inputs, { N: 20, BETA_BAND: 0.6 });
            rows.push(`| ${label} | ${verdict.track} | ${verdict.verdict} | ${verdict.reason} |`);
          } catch (e) {
            rows.push(`| ${label} | — | ERROR | ${e.message} |`);
          }
        }
      }
      if (!emittedAny) {
        rows.push(`| ${name} | — | HOLD | insufficient data (no segment rows for ${strategyIds.join(' or ')}) |`);
      }
    } catch (e) {
      rows.push(`| ${name} | — | ERROR | ${e.message} |`);
    }
  }

  const md = rows.join('\n');
  writeFileSync(join(projectRoot, 'docs', 'lab', 'graduation-report.md'), md);
  console.log(md);
}

// CLI entry — only when invoked directly, never on import (matches trade-grades.mjs /
// managed-position-repair.mjs's convention). Previously unguarded: merely importing
// assembleVerdict (as graduation-report.test.mjs does) ran the full network-fetching
// main() as an import side effect on every test run, silently overwriting
// docs/lab/graduation-report.md — harmless by luck so far (each agent's fetch/read
// errors are caught per-iteration), but exactly the kind of hazard that breaks the
// moment a conformance test also imports AGENTS from this module.
if (process.argv[1] && process.argv[1].endsWith('graduation-report.mjs')) {
  main().catch((e) => {
    process.stderr.write(`graduation-report: ${e.message}\n`);
    process.exit(1);
  });
}
