// agent/veto-store.js
// Coil Veto Ledger store. JSON-array file with atomic writes serialized
// in-process (single-writer). Pure FS + validation. Cloned from tips-store.js.
import fs from 'node:fs/promises';
import path from 'node:path';

export const VALID_REASONS = ['catalyst_driven', 'market_dislocation'];

function vetoesDir(projectRoot) { return path.join(projectRoot, 'data', 'coil-vetoes'); }
function vetoesFile(projectRoot) { return path.join(vetoesDir(projectRoot), 'vetoes.json'); }

export function getReasons() { return [...VALID_REASONS]; }

export async function readVetoes(projectRoot) {
  try {
    const raw = await fs.readFile(vetoesFile(projectRoot), 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// In-process write serialization: every read-modify-write chains off the last,
// so concurrent createVeto calls can't clobber each other. (Cloned from tips-store.)
let _writeChain = Promise.resolve();
function serialize(task) {
  const run = _writeChain.then(task, task);
  _writeChain = run.then(() => {}, () => {});
  return run;
}

async function _atomicWriteVetoes(projectRoot, vetoes) {
  const dir = vetoesDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const tmp = vetoesFile(projectRoot) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(vetoes, null, 2));
  await fs.rename(tmp, vetoesFile(projectRoot));
}

export async function createVeto(projectRoot, { date, ticker, coilEntryRef, reason, notes } = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]*$/.test(t)) throw new Error('invalid ticker');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('invalid date (expected YYYY-MM-DD)');
  const ref = Number(coilEntryRef);
  if (!Number.isFinite(ref) || ref <= 0) throw new Error('invalid coilEntryRef');
  if (!VALID_REASONS.includes(reason)) throw new Error(`invalid reason: ${reason}`);

  const veto = {
    id: `veto_${Date.now()}_${t}_${Math.random().toString(36).slice(2, 6)}`,
    date: String(date),
    ticker: t,
    coilEntryRef: ref,
    reason,
    notes: String(notes || '').trim(),
    loggedAt: new Date().toISOString(),
    reconciled: false,
  };

  return serialize(async () => {
    const vetoes = await readVetoes(projectRoot);
    vetoes.push(veto);
    await _atomicWriteVetoes(projectRoot, vetoes);
    return veto;
  });
}
