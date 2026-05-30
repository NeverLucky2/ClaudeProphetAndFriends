// agent/news-candidates.js
// Read-only: derive out-of-universe catalyst SUGGESTIONS from the persisted daily
// briefs (data/reports/daily_brief_*.json) — the same JSON the catalyst-news /
// analyst-actions scans emit. In-universe hits get no lane entry (the agent
// already trades + news-scans those). Suggestions exclude names already tipped or
// suppressed. This NEVER triggers the agent and is NOT a scored tip (D14).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readUniverse, readTips, readSuppressed } from './tips-store.js';

export async function listNewsCandidates(projectRoot) {
  const dir = path.join(projectRoot, 'data', 'reports');
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const universe = await readUniverse(projectRoot);
  const tipped = new Set((await readTips(projectRoot)).filter(t => !t.dismissed).map(t => t.ticker));
  const suppressed = await readSuppressed(projectRoot);

  // newest brief date wins per ticker
  const byTicker = new Map();
  const consider = (ticker, catalyst, feed, feedAt) => {
    const t = String(ticker || '').toUpperCase();
    if (!t || universe.has(t) || tipped.has(t) || suppressed.has(t)) return;
    const prev = byTicker.get(t);
    if (!prev || String(feedAt) > String(prev.feedAt)) {
      byTicker.set(t, { ticker: t, catalyst: String(catalyst || ''), feed: String(feed || ''), feedAt: feedAt || '' });
    }
  };
  for (const f of files) {
    if (!/^daily_brief_\d{8}\.json$/.test(f)) continue;
    let b;
    try { b = JSON.parse(await fs.readFile(path.join(dir, f), 'utf-8')); } catch { continue; }
    for (const a of b.analyst_actions || []) {
      const cat = `${a.firm || 'analyst'} ${a.action || 'update'}${a.to != null ? ` PT→${a.to}` : ''}`;
      consider(a.ticker, cat, a.firm || 'analyst', a.date || b.date);
    }
    for (const c of b.ticker_catalysts || []) {
      consider(c.ticker, c.headline || c.event_type || 'catalyst', c.source || 'news', c.published || b.date);
    }
  }
  return [...byTicker.values()].sort((a, b) => String(b.feedAt).localeCompare(String(a.feedAt)));
}
