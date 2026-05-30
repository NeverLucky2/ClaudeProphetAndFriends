// agent/tips-store.js
// Tip / candidate store for the Influence Ledger. JSON-array file with atomic
// writes serialized in-process (single-writer). Pure FS + validation.
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_SOURCES = ['self', 'dad'];

function tipsDir(projectRoot) { return path.join(projectRoot, 'data', 'tips'); }
function tipsFile(projectRoot) { return path.join(tipsDir(projectRoot), 'tips.json'); }
function sourcesFile(projectRoot) { return path.join(tipsDir(projectRoot), 'sources.json'); }
function universeFile(projectRoot) {
  return path.join(projectRoot, 'config', 'prophet_tradable_universe.txt');
}

// readUniverse mirrors the Go services.LoadTradableUniverse parser: one ticker
// per line, '#' starts a comment (inline trimmed), blanks dropped, upper-cased.
export async function readUniverse(projectRoot) {
  let raw;
  try {
    raw = await fs.readFile(universeFile(projectRoot), 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
  const out = new Set();
  for (let line of raw.split('\n')) {
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    const t = line.trim().toUpperCase();
    if (t) out.add(t);
  }
  return out;
}

export async function getSources(projectRoot) {
  try {
    const raw = await fs.readFile(sourcesFile(projectRoot), 'utf-8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return [...DEFAULT_SOURCES];
}

export async function readTips(projectRoot) {
  try {
    const raw = await fs.readFile(tipsFile(projectRoot), 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// In-process write serialization: every read-modify-write chains off the last,
// so concurrent createTip/dismissTip calls can't clobber each other.
let _writeChain = Promise.resolve();
function serialize(task) {
  const run = _writeChain.then(task, task);
  _writeChain = run.then(() => {}, () => {});
  return run;
}

async function _atomicWriteTips(projectRoot, tips) {
  const dir = tipsDir(projectRoot);
  await fs.mkdir(dir, { recursive: true });
  const tmp = tipsFile(projectRoot) + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(tips, null, 2));
  await fs.rename(tmp, tipsFile(projectRoot));
}

export async function createTip(projectRoot, { ticker, thesis, source } = {}) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.]*$/.test(t)) throw new Error('invalid ticker');
  const th = String(thesis || '').trim();
  if (!th) throw new Error('thesis is required');
  const sources = await getSources(projectRoot);
  if (!sources.includes(source)) throw new Error(`unknown source: ${source}`);

  const inUni = (await readUniverse(projectRoot)).has(t);
  const surfacedAt = new Date().toISOString();
  const tip = {
    id: `tip_${Date.now()}_${t}_${Math.random().toString(36).slice(2, 6)}`,
    ticker: t,
    thesis: th,
    source,
    phase: inUni ? 'active' : 'pending_candidate',
    origin: 'manual',
    surfacedAt,
    actionableAt: inUni ? surfacedAt : null,
    inUniverseAtLog: inUni,
    dismissed: false,
  };

  return serialize(async () => {
    const tips = await readTips(projectRoot);
    tips.push(tip);
    await _atomicWriteTips(projectRoot, tips);
    return tip;
  });
}

export async function dismissTip(projectRoot, id) {
  return serialize(async () => {
    const tips = await readTips(projectRoot);
    const tip = tips.find(t => t.id === id);
    if (!tip) return false;
    tip.dismissed = true;
    await _atomicWriteTips(projectRoot, tips);
    return true;
  });
}

// promoteCandidate: the D7 transition. An out-of-universe pending_candidate
// becomes active when a human adds its ticker to the universe; the scoring
// window anchors to add-time (actionableAt = now), not the original log time,
// so the tip is not penalised for the span the name was structurally untradable.
// Single-writer (D13): serialized like every other mutation.
export async function promoteCandidate(projectRoot, id) {
  return serialize(async () => {
    const tips = await readTips(projectRoot);
    const tip = tips.find(t => t.id === id);
    if (!tip) return { ok: false, reason: 'not_found' };
    if (tip.phase !== 'pending_candidate') return { ok: false, reason: 'not_a_candidate', tip };
    const now = new Date().toISOString();
    tip.phase = 'active';
    tip.actionableAt = now;
    tip.promotedAt = now;
    await _atomicWriteTips(projectRoot, tips);
    return { ok: true, tip };
  });
}
