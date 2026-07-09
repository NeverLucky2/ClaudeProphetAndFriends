// scripts/coil-preview.mjs
// Read-only pre-close scouting report for the Coil mean-reversion agent.
// Calls Coil's own HTTP endpoints so the numbers are byte-for-byte Coil's.
// See docs/superpowers/specs/2026-06-04-coil-preview-design.md.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const RSI_ENTRY_MAX = 5;        // Coil's entry trigger (rsi_2 < 5)
export const WATCH_RSI_MAX = 15;       // WATCH band: oversold-ish but not yet firing
export const WATCH_SMA5_BAND = 0.005;  // WATCH band: at most 0.5% above the 5-day
export const WATCH_MAX_NAMES = 10;     // cap on the WATCH list
export const STOP_PCT = 0.07;          // Coil's -7% hard stop
export const THIN_REGIME_PCT = 1.0;    // soft-warn when 0 < sma200_gap_pct < this

// computeMargins returns the distance of each gate from its threshold.
//   rsi2_margin  : rsi_2 - 5      (<=0 means past the trigger)
//   sma5_gap_pct : % above/below the 5-day  (negative = pullback condition met)
//   sma200_gap_pct: % above/below the 200-day (positive = in uptrend regime)
export function computeMargins(sig) {
  return {
    rsi2_margin: sig.rsi_2 - RSI_ENTRY_MAX,
    sma5_gap_pct: ((sig.last_close - sig.sma_5) / sig.sma_5) * 100,
    sma200_gap_pct: ((sig.last_close - sig.sma_200) / sig.sma_200) * 100,
  };
}

// classifyWatch: a non-firing name worth watching. Relaxes ONLY the two
// intraday-moving conditions (RSI and close-vs-5-day); regime and earnings stay hard.
export function classifyWatch(sig) {
  if (sig.entry_signal) return false;                 // already firing
  if (sig.earnings_within_5d) return false;           // disqualified
  if (!(sig.last_close > sig.sma_200)) return false;  // out of regime
  if (!(sig.rsi_2 < WATCH_RSI_MAX)) return false;
  if (!(sig.last_close < sig.sma_5 * (1 + WATCH_SMA5_BAND))) return false;
  return true;
}

function round2(x) { return Math.round(x * 100) / 100; }

// buildMirror: everything the operator needs to replicate the full trade.
// The stop is expressed as a RULE relative to the actual fill, not a fixed
// number anchored to the (provisional) preview price.
export function buildMirror(sig) {
  return {
    entry_ref: sig.last_close,
    entry_ref_note: 'provisional midday reference, not your expected fill',
    illustrative_stop: round2(sig.last_close * (1 - STOP_PCT)),
    stop_rule: 'Set your stop at your actual fill × 0.93 (−7%). The number above is illustrative only.',
    exit_rules: 'Exit when RSI(2)>70, OR close above the 5-day SMA, OR 5 trading days elapse (whichever first).',
    timing: 'To match Coil, place near its 15:45 ET beat (same-day). Next-morning entry adds overnight gap risk.',
    sizing_note: 'Coil sizes ~5% of its book, max 4 concurrent — size your own account.',
  };
}

// buildBanner maps Coil's (bear_regime, bear_mode) into an operator-facing line
// and a halt flag. halt=true means Coil will place NO new entries today.
export function buildBanner(bearRegime, bearMode) {
  if (!bearRegime) return { text: 'Normal regime — Coil sizes full.', halt: false };
  const mode = String(bearMode || 'halfsize').toLowerCase();
  if (mode === 'halt') {
    return { text: '⛔ Bear regime + HALT — Coil will place NO new entries today.', halt: true };
  }
  if (mode === 'normal') {
    return { text: '⚠️ Bear regime (mode=normal) — Coil still sizes full despite SPY<200d.', halt: false };
  }
  return { text: '⚠️ Bear regime — Coil halves size today.', halt: false };
}

// ET date/time helpers (America/New_York), matching the convention used by the
// other coil-*.mjs scripts.
const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function etDateStr(d = new Date()) {
  const p = {};
  for (const x of ET_DATE_FMT.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
const ET_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
});
export function etTimeStr(d = new Date()) { return ET_TIME_FMT.format(d); } // "HH:MM"

// enrichSignal turns a raw MeanRevSignal into a render-ready row.
export function enrichSignal(sig) {
  const m = computeMargins(sig);
  return {
    ticker: sig.ticker,
    last_close: sig.last_close,
    rsi_2: sig.rsi_2,
    sma_5: sig.sma_5,
    sma_200: sig.sma_200,
    rsi2_margin: m.rsi2_margin,
    sma5_gap_pct: m.sma5_gap_pct,
    sma200_gap_pct: m.sma200_gap_pct,
    thin_regime: m.sma200_gap_pct > 0 && m.sma200_gap_pct < THIN_REGIME_PCT,
    earnings_within_5d: !!sig.earnings_within_5d,
    mirror: buildMirror(sig),
  };
}

// assembleReport builds the full report object from the three endpoint results.
//   firing : from /candidates (authoritative, already entry_signal=true, rsi-sorted)
//   watch  : non-firing names from per-symbol /signal that pass classifyWatch
//   failed : tickers whose /signal fetch errored (drives the INCOMPLETE warning)
export function assembleReport({ universe, candidatesResp, signals, failed, now = new Date() }) {
  const bearRegime = !!candidatesResp.bear_regime;
  const bearMode = candidatesResp.bear_mode || 'halfsize';
  const banner = buildBanner(bearRegime, bearMode);

  const firingRaw = Array.isArray(candidatesResp.candidates) ? candidatesResp.candidates : [];
  const firing = firingRaw.map(enrichSignal);
  const firingSet = new Set(firingRaw.map((c) => c.ticker));

  const watchAll = [];
  for (const [ticker, sig] of signals) {
    if (firingSet.has(ticker)) continue;
    if (classifyWatch(sig)) watchAll.push(enrichSignal(sig));
  }
  watchAll.sort((a, b) => a.rsi_2 - b.rsi_2);

  return {
    as_of: candidatesResp.as_of || null,
    preview_time_et: etTimeStr(now),
    preview_date_et: etDateStr(now),
    bot_ok: true,
    spy: { bear_regime: bearRegime, bear_mode: bearMode, banner: banner.text },
    halt: banner.halt,
    firing,
    watch: watchAll.slice(0, WATCH_MAX_NAMES),
    watch_truncated: watchAll.length > WATCH_MAX_NAMES,
    incomplete: { failed: (failed || []).length, total: (universe || []).length, names: failed || [] },
  };
}

function renderName(c) {
  const out = [];
  const thin = c.thin_regime ? '  ⚠️ thin regime margin' : '';
  out.push(`### ${c.ticker} — $${c.last_close.toFixed(2)}`);
  out.push(`- RSI(2) ${c.rsi_2.toFixed(1)} (margin ${c.rsi2_margin.toFixed(1)}) · vs 5-day ${c.sma5_gap_pct.toFixed(2)}% · vs 200-day ${c.sma200_gap_pct.toFixed(2)}%${thin}`);
  if (c.earnings_within_5d) out.push('- ⚠️ earnings within 5 trading days');
  out.push(`- **Mirror:** entry ref $${c.mirror.entry_ref.toFixed(2)} (${c.mirror.entry_ref_note}). ${c.mirror.stop_rule} (illustrative: $${c.mirror.illustrative_stop.toFixed(2)})`);
  out.push(`- ${c.mirror.exit_rules}`);
  out.push(`- _${c.mirror.timing} ${c.mirror.sizing_note}_`);
  out.push('');
  return out;
}

// renderReport produces the full operator-facing markdown report.
export function renderReport(r) {
  const lines = [];
  lines.push('# Coil Scouting Report');
  lines.push('');
  lines.push(`> **Provisional read as of ${r.preview_time_et} ET (${r.preview_date_et})** — names can drop off or appear by Coil's 15:45 ET beat. Regime can flip too if SPY crosses its 200-day.`);
  lines.push('');
  lines.push(`**Regime:** ${r.spy.banner}`);
  lines.push('');
  if (r.incomplete.failed > 0) {
    lines.push(`> ⚠️ **${r.incomplete.failed} of ${r.incomplete.total} universe names failed to fetch — WATCH list is INCOMPLETE.** (${r.incomplete.names.join(', ')})`);
    lines.push('');
  }

  if (r.halt) {
    lines.push(`## 🟢 FIRING (${r.firing.length}) — ⛔ reference only`);
    lines.push('');
    lines.push('_Coil is HALTED today — it will NOT enter these. Shown for reference only._');
  } else {
    lines.push(`## 🟢 FIRING (${r.firing.length}) — likely Coil buys at 15:45`);
  }
  lines.push('');
  if (r.firing.length === 0) lines.push('_None firing right now._');
  for (const c of r.firing) lines.push(...renderName(c));
  lines.push('');

  const cap = r.watch_truncated ? ` — capped at ${WATCH_MAX_NAMES}` : '';
  lines.push(`## 🟡 WATCH (${r.watch.length})${cap} — near, could flip by close`);
  lines.push('');
  if (r.watch.length === 0) lines.push('_No near-misses._');
  for (const c of r.watch) lines.push(...renderName(c));

  return lines.join('\n');
}

// fetchJson does one GET and normalizes the result. Never throws: a network
// error returns { ok:false, status:0 }.
export async function fetchJson(base, path, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(`${base}${path}`);
  } catch (e) {
    return { ok: false, status: 0, error: e.message, data: null };
  }
  let data = null;
  try { data = await res.json(); } catch { /* leave null on non-JSON */ }
  return { ok: res.ok, status: res.status, data };
}

// runPreview orchestrates the three endpoint reads and returns a report object.
// On a missing universe/candidates endpoint it returns { bot_ok:false, error }.
export async function runPreview({ base, fetchImpl = globalThis.fetch, now = new Date() }) {
  const uni = await fetchJson(base, '/api/v1/meanrev/universe', fetchImpl);
  if (!uni.ok || !uni.data || !Array.isArray(uni.data.universe)) {
    return { bot_ok: false, error: `universe fetch failed (status ${uni.status})` };
  }
  const universe = uni.data.universe;

  const cand = await fetchJson(base, '/api/v1/meanrev/candidates', fetchImpl);
  if (!cand.ok || !cand.data) {
    return { bot_ok: false, error: `candidates fetch failed (status ${cand.status})` };
  }
  const candidatesResp = cand.data;
  const firingSet = new Set((candidatesResp.candidates || []).map((c) => c.ticker));

  const signals = new Map();
  const failed = [];
  for (const ticker of universe) {
    if (firingSet.has(ticker)) continue;
    const r = await fetchJson(base, `/api/v1/meanrev/signal/${ticker}`, fetchImpl);
    if (r.ok && r.data && typeof r.data.rsi_2 === 'number') {
      signals.set(ticker, r.data);
    } else if (r.status === 422) {
      // insufficient history — Coil drops these too; not a failure
    } else {
      failed.push(ticker);
    }
  }

  return assembleReport({ universe, candidatesResp, signals, failed, now });
}

// Ports to scan when neither TRADING_BOT_URL nor TRADING_BOT_PORT is set. The Go
// bot's default is 4534, but the multi-sandbox layout gives each sandbox its own
// port (4535+), and Coil's mean-rev engine lives on whichever sandbox runs it.
export const PROBE_PORT_LOW = 4534;
export const PROBE_PORT_HIGH = 4544;

// resolveBase mirrors agent/server.js: TRADING_BOT_URL, else localhost:PORT.
export function resolveBase(env = process.env) {
  return env.TRADING_BOT_URL || `http://localhost:${env.TRADING_BOT_PORT || String(PROBE_PORT_LOW)}`;
}

// isLiveMeanRevBase: true when this base serves a working mean-rev engine. The
// /universe endpoint answers on every sandbox, so it can't tell them apart —
// /candidates only returns a real payload (an object with a candidates array) on
// the sandbox actually running Coil, so that's the discriminator. Never throws:
// fetchJson turns a dead/refused port into { ok:false }, which reads as not-live.
export async function isLiveMeanRevBase(base, fetchImpl = globalThis.fetch) {
  const cand = await fetchJson(base, '/api/v1/meanrev/candidates', fetchImpl);
  return !!(cand.ok && cand.data && Array.isArray(cand.data.candidates));
}

// resolveLiveBase decides which bot URL to hit.
//   - If TRADING_BOT_URL or TRADING_BOT_PORT is set, honor it verbatim and do NOT
//     probe. This is the program-window path: the agent injects the live port
//     (agent/analysis-scheduler.js sets TRADING_BOT_URL), and we must not
//     second-guess it — so this branch is byte-for-byte the pre-patch behavior.
//   - Otherwise (a bare CLI shell), scan localhost:LOW..HIGH and return the first
//     port whose mean-rev engine is live. If none answers, fall back to the
//     default base so the caller still prints its usual "not reachable" message.
export async function resolveLiveBase({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.TRADING_BOT_URL || env.TRADING_BOT_PORT) {
    return { base: resolveBase(env), probed: false, scanned: false };
  }
  for (let port = PROBE_PORT_LOW; port <= PROBE_PORT_HIGH; port += 1) {
    const base = `http://localhost:${port}`;
    if (await isLiveMeanRevBase(base, fetchImpl)) {
      return { base, probed: true, scanned: true };
    }
  }
  return { base: resolveBase(env), probed: false, scanned: true };
}

async function main() {
  const { base, probed, scanned } = await resolveLiveBase();
  if (probed) console.error(`(auto-discovered Coil mean-rev engine at ${base})`);
  const report = await runPreview({ base });
  if (report.bot_ok === false) {
    if (scanned && !probed) {
      console.error(`No live Coil mean-rev engine found on localhost:${PROBE_PORT_LOW}-${PROBE_PORT_HIGH} — cannot preview.`);
    } else {
      console.error(`Coil bot not reachable at ${base} — cannot preview. (${report.error || 'unknown error'})`);
    }
    console.error('If the bot is down, Coil is not trading, so there is nothing to mirror.');
    process.exit(1);
  }
  const dir = path.join(PROJECT_ROOT, 'data', 'coil-preview');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${report.preview_date_et}.json`), JSON.stringify(report, null, 2), 'utf8');
  } catch (e) {
    console.error(`(warning: could not write cache file: ${e.message})`);
  }
  console.log(renderReport(report));
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`coil-preview failed: ${e.message}`);
    process.exit(1);
  });
}
