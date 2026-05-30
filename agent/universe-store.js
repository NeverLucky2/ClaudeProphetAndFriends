// agent/universe-store.js
// The single sanctioned, human-gated writer to config/prophet_tradable_universe.txt
// (spec §5.5). Append-only and idempotent. Distinct from the automated catalyst
// top-up the file header forbids — this write happens only on an explicit human
// "Add to universe" click through the server. Takes effect on the next agent
// restart (the Go guard reads the file at startup).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readUniverse } from './tips-store.js';

function universeFile(projectRoot) {
  return path.join(projectRoot, 'config', 'prophet_tradable_universe.txt');
}

export async function addToUniverse(projectRoot, ticker, opts = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]*$/.test(t)) throw new Error('invalid ticker');
  if ((await readUniverse(projectRoot)).has(t)) {
    return { added: false, alreadyPresent: true, ticker: t };
  }
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const file = universeFile(projectRoot);
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const needsNL = raw.length > 0 && !raw.endsWith('\n');
  await fs.appendFile(file, `${needsNL ? '\n' : ''}${t}  # added via tips ledger ${today}\n`);
  return { added: true, alreadyPresent: false, ticker: t };
}
