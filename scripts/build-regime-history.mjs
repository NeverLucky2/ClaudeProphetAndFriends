// scripts/build-regime-history.mjs
// SPY-based 3-bucket regime classifier with 50DMA-slope tiebreaker. Spec:
// docs/superpowers/specs/2026-05-18-regime-stress-significance-design.md

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLASSIFIER_VERSION = '2026-05-18.1';

export function classifyRegime({ close, sma50, ret20d, sma50_slope }) {
  if (close > sma50 && ret20d > 0) return 'bull-trend';
  if (close < sma50 && ret20d < 0) return 'bear-trend';
  if (close > sma50 && sma50_slope > 0) return 'bull-trend';
  if (close < sma50 && sma50_slope < 0) return 'bear-trend';
  return 'chop';
}

function dateInET(d) {
  // Returns { year, month, day, hour, minute, weekday(0=Sun..6=Sat) } for d in America/New_York.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '00' : map.hour),
    minute: Number(map.minute),
    weekday: weekdays[map.weekday],
  };
}

function makeET(year, month, day, hour, minute) {
  // Construct a Date for the given Y-M-D H:M in America/New_York. Uses an offset probe.
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const etProbe = dateInET(probe);
  const offsetMin = ((etProbe.hour - hour) * 60 + (etProbe.minute - minute)) * -1;
  return new Date(probe.getTime() + offsetMin * 60_000);
}

// NYSE full-day market closures for 2026. Intentionally scoped to a single year —
// when 2027 arrives, extend or replace this set. Not a perpetual calendar.
const NYSE_HOLIDAYS_2026 = new Set([
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed; Jul 4 falls on Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
]);

function isoDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function mostRecentSessionClose(now) {
  // Walk back day-by-day in ET until we hit a trading day (weekday, not a holiday) whose 4pm ET <= now.
  const et = dateInET(now);
  let y = et.year, m = et.month, d = et.day;
  // If today is a trading day and now >= 4pm ET, return today's close.
  const todayClose = makeET(y, m, d, 16, 0);
  const todayIso = isoDate(et.year, et.month, et.day);
  if (
    et.weekday >= 1 && et.weekday <= 5 &&
    !NYSE_HOLIDAYS_2026.has(todayIso) &&
    now >= todayClose
  ) {
    return todayClose;
  }
  // Otherwise step back day-by-day (using ET noon as anchor) until we hit a trading day.
  for (let i = 1; i <= 14; i += 1) {
    // Use UTC noon of (ET calendar date - i days) as a safe anchor to stay on the right ET date.
    const probe = makeET(y, m, d - i, 12, 0);
    const etProbe = dateInET(probe);
    if (etProbe.weekday < 1 || etProbe.weekday > 5) continue;
    const probeIso = isoDate(etProbe.year, etProbe.month, etProbe.day);
    if (NYSE_HOLIDAYS_2026.has(probeIso)) continue;
    return makeET(etProbe.year, etProbe.month, etProbe.day, 16, 0);
  }
  throw new Error('mostRecentSessionClose: no trading day found in last 14 days (impossible)');
}

export function isCacheFresh(cache, requested, now, forceRebuild) {
  if (forceRebuild) return false;
  if (!cache?.range || !cache?.as_of || !cache?.classifier?.version) return false;
  if (cache.classifier.version !== CLASSIFIER_VERSION) return false;
  if (cache.range.from > requested.from) return false;
  if (cache.range.to < requested.to) return false;
  const close = mostRecentSessionClose(now);
  const closePlusBufferMs = close.getTime() + 3600_000;
  const asOf = Date.parse(cache.as_of);
  return Number.isFinite(asOf) && asOf >= closePlusBufferMs;
}

function mean(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function deriveLabelsFromCloses(closes, fromDate, toDate) {
  // closes: sorted ascending [{ date, close }]
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i].date < closes[i - 1].date) {
      throw new Error(`deriveLabelsFromCloses: closes not in ascending order at index ${i} (${closes[i - 1].date} > ${closes[i].date})`);
    }
  }
  const labels = {};
  for (let i = 0; i < closes.length; i += 1) {
    const { date, close } = closes[i];
    if (date < fromDate || date > toDate) continue;
    if (i < 49) continue;  // need 50 prior closes (i.e., index 49 means 50 days inclusive)
    const window50 = closes.slice(i - 49, i + 1).map(r => r.close);
    const sma50 = mean(window50);
    const ret20d = closes[i - 20] ? (close / closes[i - 20].close - 1) : 0;
    const sma50_slope = closes[i - 20] && i - 20 >= 49
      ? (sma50 - mean(closes.slice(i - 20 - 49, i - 20 + 1).map(r => r.close))) /
        mean(closes.slice(i - 20 - 49, i - 20 + 1).map(r => r.close))
      : 0;
    labels[date] = classifyRegime({ close, sma50, ret20d, sma50_slope });
  }
  return labels;
}

const FMP_HOST = 'https://financialmodelingprep.com';

export async function fetchSpyHistorical({ apiKey, from, to, fetchImpl = globalThis.fetch }) {
  if (!apiKey) {
    throw new Error('FMP_API_KEY is required for build-regime-history but was not set');
  }
  const url = `${FMP_HOST}/api/v3/historical-price-full/SPY?from=${from}&to=${to}&apikey=${apiKey}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    throw new Error(`FMP request failed (${resp.status} ${resp.statusText ?? ''}) for SPY history`);
  }
  const data = await resp.json();
  if (!Array.isArray(data?.historical)) {
    throw new Error('FMP response malformed: expected { historical: [...] }');
  }
  if (data.historical.length === 0) {
    throw new Error(`FMP returned 0 historical rows for SPY in range ${from}..${to} — check date range or FMP status`);
  }
  const rows = data.historical.map(r => ({ date: r.date, close: Number(r.close) }));
  for (const r of rows) {
    if (!Number.isFinite(r.close)) {
      throw new Error(`FMP returned non-finite close for SPY on ${r.date}`);
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

function writeAtomic(path, content) {
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (err) {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
    throw err;
  }
}

export async function runBuild({ projectRoot, apiKey, fetchImpl, from, to, forceRebuild, now }) {
  const outPath = join(projectRoot, 'data', 'reports', 'regime_history.json');
  let cache = null;
  if (existsSync(outPath)) {
    try { cache = JSON.parse(readFileSync(outPath, 'utf8')); } catch { cache = null; }
  }
  const requested = { from, to };
  if (isCacheFresh(cache, requested, now, forceRebuild)) {
    process.stderr.write(`build-regime-history: cache hit (${cache.range.from} → ${cache.range.to})\n`);
    return { action: 'cache_hit', path: outPath };
  }
  // Need to fetch [from-49 calendar days, to] to have 50d of priors for the first requested date.
  const fromDate = new Date(`${from}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 49 - 30);  // extra 30 days slack for weekends/holidays
  const fetchFrom = fromDate.toISOString().slice(0, 10);
  const closes = await fetchSpyHistorical({ apiKey, from: fetchFrom, to, fetchImpl });
  const labels = deriveLabelsFromCloses(closes, from, to);
  const out = {
    as_of: now.toISOString(),
    range: { from, to },
    classifier: { version: CLASSIFIER_VERSION, rules: 'SPY vs 50DMA + SPY 20D return + 50DMA-slope tiebreaker; 3-bucket' },
    labels,
  };
  writeAtomic(outPath, JSON.stringify(out, null, 2));
  process.stderr.write(`build-regime-history: rebuilt (${Object.keys(labels).length} dates labeled, ${from} → ${to})\n`);
  return { action: 'rebuilt', path: outPath };
}

// CLI entry — only runs when invoked directly.
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const argFlag = (n) => {
      const i = args.indexOf(n);
      return i === -1 ? undefined : args[i + 1];
    };
    const forceRebuild = args.includes('--force-rebuild');
    const today = new Date();
    const toDefault = today.toISOString().slice(0, 10);
    const fromDefault = new Date(today.getTime() - 90 * 86400_000).toISOString().slice(0, 10);
    const from = argFlag('--from') ?? fromDefault;
    const to = argFlag('--to') ?? toDefault;
    const apiKey = process.env.FMP_API_KEY ?? '';
    if (!apiKey) {
      process.stderr.write('build-regime-history: FMP_API_KEY env var not set\n');
      process.exit(3);
    }
    runBuild({
      projectRoot: process.cwd(), apiKey, fetchImpl: globalThis.fetch,
      from, to, forceRebuild, now: new Date(),
    }).then(
      (r) => { process.stdout.write(JSON.stringify(r) + '\n'); },
      (err) => { process.stderr.write(`build-regime-history: ${err.message}\n`); process.exit(4); },
    );
  }
}
