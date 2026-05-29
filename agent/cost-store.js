// Per-day rollup store for opencode beat cost + token usage. Each beat's
// (sandboxId, agentId, phase) row is upserted into a per-account per-day
// JSON file at data/sandboxes/{accountId}/costs/{YYYY-MM-DD}.json.
// Schema documented in docs/superpowers/specs/2026-05-28-per-agent-daily-token-cost-design.md.
import fs from 'node:fs/promises';
import path from 'node:path';

const SCHEMA_VERSION = 1;

// _etDate returns YYYY-MM-DD for the given Date in America/New_York.
// Internal; exported for tests. Mirrors the same helper in trades-store.js
// and the startOfEtTradingDayIso helper in fills-summary.js — extracting
// to a shared util is a separate cleanup PR.
const _etFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

export function _etDate(date) {
  return _etFormatter.format(date);
}

function costsDir(projectRoot, accountId) {
  return path.join(projectRoot, 'data', 'sandboxes', accountId, 'costs');
}

function costsFile(projectRoot, accountId, ymd) {
  return path.join(costsDir(projectRoot, accountId), `${ymd}.json`);
}

function emptyDay(date) {
  return { schemaVersion: SCHEMA_VERSION, date, rows: [] };
}

// Module-level Set so we warn once per file path per process lifetime.
const _warnedFiles = new Set();

// readDay returns { schemaVersion, date, rows } for one (accountId, date)
// pair, or null if missing. Handles corrupt JSON and unknown schemaVersion
// by logging a warning (once per file path per process) and returning null.
export async function readDay(projectRoot, accountId, date, { logger = console.warn } = {}) {
  const file = costsFile(projectRoot, accountId, date);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (!_warnedFiles.has(file)) {
      _warnedFiles.add(file);
      logger(`cost-store: corrupt JSON at ${file} — returning null`);
    }
    return null;
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    if (!_warnedFiles.has(file)) {
      _warnedFiles.add(file);
      logger(`cost-store: unknown schemaVersion ${parsed.schemaVersion} at ${file} — returning null`);
    }
    return null;
  }

  return parsed;
}

// recordBeat upserts the (sandboxId, agentId, phase) row in the per-day
// file. ET-date is derived from beatStartAt. Caller wraps in try/catch
// for soft-fail behavior; this function does not swallow I/O errors.
export async function recordBeat(projectRoot, {
  accountId, sandboxId, agentId, agentName, model, phase,
  cost, input, output, reasoning, cacheRead, cacheWrite,
  beatStartAt,
}) {
  const parsedAt = new Date(beatStartAt);
  if (isNaN(parsedAt.getTime())) {
    throw new Error(`recordBeat: invalid beatStartAt: ${JSON.stringify(beatStartAt)}`);
  }
  const date = _etDate(parsedAt);
  const dir = costsDir(projectRoot, accountId);
  await fs.mkdir(dir, { recursive: true });
  const existing = await readDay(projectRoot, accountId, date);
  const day = existing || emptyDay(date);

  const nowIso = new Date().toISOString();
  const existingRow = day.rows.find(r =>
    r.sandboxId === sandboxId && r.agentId === agentId && r.phase === phase
  );

  if (existingRow) {
    existingRow.cost += cost;
    existingRow.input += input;
    existingRow.output += output;
    existingRow.reasoning += reasoning;
    existingRow.cacheRead += cacheRead;
    existingRow.cacheWrite += cacheWrite;
    existingRow.beatCount += 1;
    existingRow.lastBeatAt = nowIso;
    // Refresh display fields in case agentName/model changed mid-day.
    existingRow.agentName = agentName;
    existingRow.model = model;
  } else {
    day.rows.push({
      sandboxId, agentId, agentName, model, phase,
      cost, input, output, reasoning, cacheRead, cacheWrite,
      beatCount: 1,
      firstBeatAt: beatStartAt,
      lastBeatAt: nowIso,
    });
  }

  // Stable sort: (sandboxId, agentId, phase). Cost is negligible (≤ ~30 rows)
  // and stable file diffs help when the operator inspects a file by hand.
  day.rows.sort((a, b) =>
    a.sandboxId.localeCompare(b.sandboxId) ||
    a.agentId.localeCompare(b.agentId) ||
    a.phase.localeCompare(b.phase)
  );

  await _atomicWrite(costsFile(projectRoot, accountId, date), JSON.stringify(day, null, 2));
}

// _atomicWrite: write to tmp then rename. fs.rename is atomic within one
// filesystem on POSIX and NTFS. Caller is responsible for ensuring the
// parent directory exists.
async function _atomicWrite(filePath, content) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, filePath);
}

// _enumerateDates returns YYYY-MM-DD strings from `from` to `to` inclusive.
// Throws if from > to.
function _enumerateDates(from, to) {
  if (from > to) throw new Error(`readRange: from (${from}) > to (${to})`);
  const out = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cur <= end) {
    const ymd = cur.toISOString().slice(0, 10);
    out.push(ymd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// readRange returns array of { date, rows } for [from, to] inclusive,
// optionally filtered by accountId or sandboxId. Newest date last.
// Missing days produce NO entry (not an empty-row entry).
export async function readRange(projectRoot, { from, to, accountId, sandboxId } = {}) {
  if (!from || !to) throw new Error('readRange: from and to are required (YYYY-MM-DD)');
  const dates = _enumerateDates(from, to);

  const sandboxesRoot = path.join(projectRoot, 'data', 'sandboxes');
  let accountIds;
  if (accountId) {
    accountIds = [accountId];
  } else {
    try {
      accountIds = await fs.readdir(sandboxesRoot);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // Merge per-date across all accounts: { date → { rows: [...] } }
  const byDate = new Map();
  for (const acc of accountIds) {
    for (const ymd of dates) {
      const day = await readDay(projectRoot, acc, ymd);
      if (!day) continue;
      const rows = sandboxId
        ? day.rows.filter(r => r.sandboxId === sandboxId)
        : day.rows;
      if (!rows.length) continue;
      const entry = byDate.get(ymd) || { date: ymd, rows: [] };
      entry.rows.push(...rows);
      byDate.set(ymd, entry);
    }
  }

  return dates.flatMap(d => byDate.get(d) ? [byDate.get(d)] : []);
}

// aggregateByAgent — pure transform. Input is readRange output. Output:
// { agentId → { agentName, model, dates: { ymd → { cost, tokens,
//   beatCount, phases: { phase → { cost, tokens, beatCount } } } } } }.
export function aggregateByAgent(rangeData) {
  const out = {};
  for (const dayEntry of rangeData) {
    const ymd = dayEntry.date;
    for (const row of dayEntry.rows) {
      const agent = out[row.agentId] || (out[row.agentId] = {
        agentName: row.agentName, model: row.model, dates: {},
      });
      // Most recent display fields win on conflict
      agent.agentName = row.agentName;
      agent.model = row.model;

      const dayAgg = agent.dates[ymd] || (agent.dates[ymd] = {
        cost: 0, tokens: 0, beatCount: 0, phases: {},
      });
      const tokens = row.input + row.output + row.cacheRead + row.cacheWrite;
      dayAgg.cost += row.cost;
      dayAgg.tokens += tokens;
      dayAgg.beatCount += row.beatCount;

      const phaseAgg = dayAgg.phases[row.phase] || (dayAgg.phases[row.phase] = {
        cost: 0, tokens: 0, beatCount: 0,
      });
      phaseAgg.cost += row.cost;
      phaseAgg.tokens += tokens;
      phaseAgg.beatCount += row.beatCount;
    }
  }
  return out;
}

// buildCostsResponse — produces the HTTP endpoint's payload from
// readRange() output. `today` is the YYYY-MM-DD anchor for "today";
// the response spans `days` days ending at `today`.
export function buildCostsResponse(rangeData, days, today) {
  const agg = aggregateByAgent(rangeData);
  const dates = [];
  {
    const d = new Date(`${today}T00:00:00Z`);
    for (let i = days - 1; i >= 0; i--) {
      const c = new Date(d);
      c.setUTCDate(c.getUTCDate() - i);
      dates.push(c.toISOString().slice(0, 10));
    }
  }
  const from = dates[0];
  const to = dates[dates.length - 1];

  const pctDelta = (n, basis) => (!basis || basis === 0) ? null : Math.round(((n - basis) / basis) * 100);

  const agents = [];
  for (const [agentId, info] of Object.entries(agg)) {
    const sparkline = dates.map(d => info.dates[d] ? info.dates[d].cost : 0);
    const todayCell = info.dates[today] || { cost: 0, tokens: 0, beatCount: 0, phases: {} };
    const basisDates = dates.slice(0, -1); // exclude today
    const basisCost = basisDates.reduce((s, d) => s + (info.dates[d] ? info.dates[d].cost : 0), 0) / Math.max(basisDates.length, 1);
    const basisTokens = basisDates.reduce((s, d) => s + (info.dates[d] ? info.dates[d].tokens : 0), 0) / Math.max(basisDates.length, 1);
    const phasesToday = {};
    for (const [phase, p] of Object.entries(todayCell.phases)) {
      const phaseBasis = basisDates.reduce((s, d) => {
        const c = info.dates[d];
        return s + (c && c.phases[phase] ? c.phases[phase].cost : 0);
      }, 0) / Math.max(basisDates.length, 1);
      phasesToday[phase] = {
        cost: p.cost, beatCount: p.beatCount,
        deltaPct: pctDelta(p.cost, phaseBasis),
      };
    }
    agents.push({
      agentId, agentName: info.agentName, model: info.model,
      today: { cost: todayCell.cost, tokens: todayCell.tokens, beatCount: todayCell.beatCount },
      sevenDayAvg: { cost: basisCost, tokens: basisTokens },
      delta: { costPct: pctDelta(todayCell.cost, basisCost), tokensPct: pctDelta(todayCell.tokens, basisTokens) },
      sparkline,
      phasesToday,
    });
  }
  agents.sort((a, b) => b.today.cost - a.today.cost);

  const totalsToday = agents.reduce((s, a) => s + a.today.cost, 0);
  const totalsBasis = agents.reduce((s, a) => s + a.sevenDayAvg.cost, 0);
  const totalsTokensToday = agents.reduce((s, a) => s + a.today.tokens, 0);

  return {
    from, to,
    agents,
    totals: {
      today: { cost: totalsToday, tokens: totalsTokensToday },
      sevenDayAvg: { cost: totalsBasis },
      delta: { costPct: pctDelta(totalsToday, totalsBasis) },
    },
  };
}
