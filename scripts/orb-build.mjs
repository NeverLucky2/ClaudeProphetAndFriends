// scripts/orb-build.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orbSignal } from './orb-signal.mjs';
import { simulateOrbTrade } from './orb-exitsim.mjs';
import { loadOrbSessions } from './orb-bars.mjs';
import { ORB_ETF_UNIVERSE, ORB_LARGECAP_EXPLORATORY } from './orb-universe.mjs';
import { chronoSplit } from './coil-eventstudy-build.mjs';

export function enumerateOrbTrades(sessions, ticker, cut) {
  const out = [];
  for (const s of sessions) {
    const sig = orbSignal(s);
    if (!sig) continue;
    const t = simulateOrbTrade(s, sig);
    out.push({ ticker, cut, date: s.date, ...t });
  }
  return out;
}

// CLI: node scripts/orb-build.mjs [--out data/lab/orb-instances.json]
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const rows = [];
    for (const [cut, uni] of [['etf', ORB_ETF_UNIVERSE], ['largecap', ORB_LARGECAP_EXPLORATORY]]) {
      for (const t of uni) for (const tr of enumerateOrbTrades(loadOrbSessions(root, t), t, cut)) rows.push(tr);
    }
    const { all } = chronoSplit(rows);
    const out = flag('--out', join(root, 'data', 'lab', 'orb-instances.json'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(all, null, 2));
    const hist = {}; for (const r of rows) hist[r.entryMinutes] = (hist[r.entryMinutes] || 0) + 1;
    process.stdout.write(JSON.stringify({ out, trades: rows.length, entry_minute_hist: hist }, null, 2) + '\n');
  }
}
