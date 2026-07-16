import { fetchJson, resolveLiveBase } from './coil-preview.mjs';
import { weekdaysBetween } from './lib/coil-shadow-episodes.mjs';
import { scoreEpisode, HOLD_DAYS } from './lib/coil-shadow-score.mjs';
import { makeFsIo } from './lib/coil-shadow-io.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// runScorer scores every 'open' episode whose 5-trading-day window has elapsed,
// fetching just enough signal-series to cover its window. Reproducible; a missing
// window day yields 'unscorable' rather than a wrong score.
// fetchImpl is a fetchJson-shaped reader (in tests: an in-memory fake; in main(): coil-preview's fetchJson bound to the real fetch).
export async function runScorer({ base, fetchImpl, io, nowEtDate }) {
  const episodes = await io.readEpisodes();
  let scored = 0, unscorable = 0, pending = 0;

  for (const ep of episodes) {
    if (ep.status !== 'open') continue;
    const elapsed = weekdaysBetween(ep.openDate, nowEtDate);
    if (elapsed < HOLD_DAYS + 1) { pending += 1; continue; } // window not fully past
    const days = Math.min(14, elapsed + 2); // reach back to the entry day
    const r = await fetchImpl(base, `/api/v1/meanrev/signal-series/${ep.name}?days=${days}`);
    const series = r.ok && r.data && Array.isArray(r.data.series) ? r.data.series : [];
    const result = scoreEpisode(ep, series);
    Object.assign(ep, result);
    if (ep.status === 'unscorable' && ep.unscorableReason === 'entry day not in series' && elapsed + 2 > 14) {
      ep.unscorableReason = 'window exceeds endpoint reach (scheduler gap > 12 trading days)';
    }
    if (ep.status === 'closed') scored += 1; else unscorable += 1;
  }

  await io.writeEpisodes(episodes);
  return { scored, unscorable, pending };
}

async function main() {
  if (process.env.COIL_SHADOW_ENABLED !== 'true') return;
  const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { base } = await resolveLiveBase();
  const io = makeFsIo(path.join(PROJECT_ROOT, 'data', 'coil-shadow'));
  const nowEtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const fetchImpl = (b, p) => fetchJson(b, p, globalThis.fetch);
  const r = await runScorer({ base, fetchImpl, io, nowEtDate });
  console.log(`coil-shadow-score ${nowEtDate}: ${JSON.stringify(r)}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`coil-shadow-score failed: ${e.message}`); process.exit(1); });
}
