#!/usr/bin/env node
// CLI shim: skill access path for per-agent daily cost data.
// Imports cost-store directly — no HTTP/server dependency.
import { readRange, buildCostsResponse, _etDate, aggregateByAgent } from '../agent/cost-store.js';
import { renderDailyReportMarkdown } from '../agent/cost-report-writer.js';

function parseArgs(argv) {
  const args = { days: 7, format: 'json', agent: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') args.days = parseInt(argv[++i], 10);
    else if (a === '--format') args.format = argv[++i];
    else if (a === '--agent') args.agent = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const HELP = `Usage: cost-report.mjs [--days N] [--format json|markdown] [--agent <agentId>]

Reads data/sandboxes/*/costs/ rollup files and emits an aggregated report.
Default --days 7, --format json. --agent filters output to one agent.
Project root is auto-detected; override with COST_REPORT_PROJECT_ROOT.`;

const args = parseArgs(process.argv);
if (args.help) { console.log(HELP); process.exit(0); }
if (!['json', 'markdown'].includes(args.format)) {
  console.error(`unknown --format: ${args.format}`);
  process.exit(2);
}
if (!Number.isFinite(args.days) || args.days < 1) {
  console.error('--days requires a positive integer');
  process.exit(2);
}

const projectRoot = process.env.COST_REPORT_PROJECT_ROOT || process.cwd();
const today = _etDate(new Date());
const fromDate = new Date(`${today}T00:00:00Z`);
fromDate.setUTCDate(fromDate.getUTCDate() - (args.days - 1));
const from = fromDate.toISOString().slice(0, 10);

const rangeData = await readRange(projectRoot, { from, to: today });

if (args.format === 'json') {
  const payload = buildCostsResponse(rangeData, args.days, today);
  if (args.agent) payload.agents = payload.agents.filter(a => a.agentId === args.agent);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
} else {
  const agg = aggregateByAgent(rangeData);
  if (args.agent) {
    for (const k of Object.keys(agg)) if (k !== args.agent) delete agg[k];
  }
  process.stdout.write(renderDailyReportMarkdown(agg, today) + '\n');
}
