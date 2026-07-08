#!/usr/bin/env node
// agent/veto-log.js
// CLI to log a Coil mirror veto. Usage:
//   node agent/veto-log.js --date 2026-07-07 --ticker AMAT --ref 552.30 --reason catalyst_driven --notes "..."
import { pathToFileURL } from 'node:url';
import { createVeto } from './veto-store.js';

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith('--')) throw new Error(`expected --flag, got: ${key}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const veto = await createVeto(process.cwd(), {
    date: a.date, ticker: a.ticker, coilEntryRef: a.ref, reason: a.reason, notes: a.notes,
  });
  console.log(`logged veto ${veto.id} (${veto.ticker}, ${veto.reason})`);
}

// Run main() only when invoked directly (robust on Windows via pathToFileURL).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
