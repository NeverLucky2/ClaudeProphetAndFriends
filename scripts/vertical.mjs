// scripts/vertical.mjs
// Operator slash-command for Prophet's teaching debit verticals. Mirrors the
// four LLM MCP tools (propose/place/list/close_debit_vertical) by calling the
// SAME Go endpoints they do, so the numbers — including the cheap/fair/rich
// entry read — are byte-for-byte what Prophet itself would see.
//   propose <UNDERLYING> <call|put> [--exp YYYY-MM-DD] [--width N]
//   place   <PROPOSAL_ID>
//   list
//   close   <VERTICAL_ID>
// Requires the Go bot running with ENABLE_PROPHET_DEBIT_VERTICALS=true.
// See docs/superpowers/specs (debit-verticals) + the coil-preview.mjs pattern.

export const MIN_DTE_DAYS = 10;   // floor for the default expiration
export const DEFAULT_WIDTH = 5;   // default target spread width ($), overridable

// resolveBase mirrors agent/server.js: TRADING_BOT_URL, else localhost:PORT.
export function resolveBase(env = process.env) {
  return env.TRADING_BOT_URL || `http://localhost:${env.TRADING_BOT_PORT || '4534'}`;
}

// normalizeDirection maps friendly aliases to the engine's wire values.
export function normalizeDirection(s) {
  const v = String(s || '').trim().toLowerCase();
  if (['call', 'c', 'call_debit', 'bull', 'bullish'].includes(v)) return 'call_debit';
  if (['put', 'p', 'put_debit', 'bear', 'bearish'].includes(v)) return 'put_debit';
  throw new Error(`direction must be call|put (got "${s}")`);
}

// thirdFriday returns the third Friday of (year, month0) as a UTC date — the
// standard monthly opex, the most reliably-quoted expiry for any optionable name.
export function thirdFriday(year, month0) {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, month0, firstFriday + 14));
}

export function ymd(date) { return date.toISOString().slice(0, 10); }

// defaultExpiration picks this month's third Friday, rolling to next month's
// when it is closer than MIN_DTE_DAYS (so a default propose isn't near-0-DTE).
export function defaultExpiration(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let exp = thirdFriday(y, m);
  if (exp.getTime() - now.getTime() < MIN_DTE_DAYS * 86400000) {
    exp = thirdFriday(m === 11 ? y + 1 : y, m === 11 ? 0 : m + 1);
  }
  return ymd(exp);
}

// parseArgs: first token is the command, bare tokens are positionals, --k v and
// --k=v are flags. --expiration is aliased to --exp.
export function parseArgs(argv) {
  const out = { cmd: argv[0] || '', positionals: [], flags: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      let key = tok.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { val = argv[i + 1]; i += 1; }
      else { val = 'true'; }
      if (key === 'expiration') key = 'exp';
      out.flags[key] = val;
    } else {
      out.positionals.push(tok);
    }
  }
  return out;
}

// fetchJson does one GET/POST and normalizes the result. Never throws: a network
// error returns { ok:false, status:0 }.
export async function fetchJson(base, path, { method = 'GET', body } = {}, fetchImpl = globalThis.fetch) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetchImpl(`${base}${path}`, init);
  } catch (e) {
    return { ok: false, status: 0, error: e.message, data: null };
  }
  let data = null;
  try { data = await res.json(); } catch { /* leave null on non-JSON */ }
  return { ok: res.ok, status: res.status, data };
}

function errOf(r) {
  return (r.data && r.data.error) || (r.status === 0 ? `bot not reachable (${r.error || 'network error'})` : `HTTP ${r.status}`);
}

// ── command runners ──────────────────────────────────────────────────────────

export async function runPropose({ base, underlying, direction, expiration, width, fetchImpl }) {
  const body = {
    underlying: String(underlying).toUpperCase(),
    direction: normalizeDirection(direction),
    expiration,
    target_width: Number(width),
  };
  const r = await fetchJson(base, '/api/v1/options/verticals/propose', { method: 'POST', body }, fetchImpl);
  if (!r.ok) return { ok: false, status: r.status, error: errOf(r) };
  return { ok: true, proposalId: r.data.proposal_id, card: r.data.card };
}

export async function runPlace({ base, proposalId, fetchImpl }) {
  const r = await fetchJson(base, '/api/v1/options/verticals/place', { method: 'POST', body: { proposal_id: proposalId } }, fetchImpl);
  if (!r.ok) return { ok: false, status: r.status, error: errOf(r) };
  return { ok: true, verticalId: r.data.vertical_id };
}

export async function runList({ base, fetchImpl }) {
  const r = await fetchJson(base, '/api/v1/options/verticals', {}, fetchImpl);
  if (!r.ok) return { ok: false, status: r.status, error: errOf(r) };
  return { ok: true, rows: Array.isArray(r.data.verticals) ? r.data.verticals : [] };
}

export async function runClose({ base, verticalId, fetchImpl }) {
  const r = await fetchJson(base, '/api/v1/options/verticals/close', { method: 'POST', body: { vertical_id: verticalId } }, fetchImpl);
  if (!r.ok) return { ok: false, status: r.status, error: errOf(r) };
  return { ok: true, status: (r.data && r.data.status) || 'closed' };
}

// ── rendering ────────────────────────────────────────────────────────────────

function pct(x) { return `${(x * 100).toFixed(1)}%`; }

// renderCard turns a VerticalCard into the operator-facing teaching card. The
// cheapness read (skew + IV/RV) is advisory only — it does NOT gate placement.
export function renderCard(c) {
  const ivToRv = c.iv_to_rv > 0
    ? `${c.iv_to_rv.toFixed(2)} (≤1.10 cheap · ≥1.30 rich; implied vs 20d realized)`
    : 'RV unavailable (need ≥20 daily bars + positive long IV)';
  const lines = [
    `# Debit Vertical Proposal — ${c.underlying} ${c.direction}`,
    `Proposal \`${c.proposal_id}\` · expires ${c.expiration} (${c.dte} DTE)`,
    '',
    `**Structure:** long ${c.long_strike} / short ${c.short_strike} (width $${c.width.toFixed(2)})`,
    `- Legs: \`${c.long_symbol}\` (long) · \`${c.short_symbol}\` (short)`,
    `- Net debit $${c.net_debit.toFixed(2)}/sh → **max loss $${c.max_loss_usd.toFixed(0)}**, max profit $${c.max_profit_usd.toFixed(0)}`,
    `- Breakeven $${c.breakeven.toFixed(2)}`,
    `- IV: long ${pct(c.long_iv)} · short ${pct(c.short_iv)}`,
    '',
    `**Entry read — ${c.cheapness}**`,
    `- Skew (shortIV − longIV): ${c.skew_diff.toFixed(4)}  _(≥ −0.01 = favorable: not overpaying the long leg)_`,
    `- IV / 20d RV: ${ivToRv}`,
    '',
    `_To place this (real paper order): \`node scripts/vertical.mjs place ${c.proposal_id}\`. The cheapness read is **advisory only** — it does not gate placement, and the proposal re-prices on place (a >drift cancels)._`,
  ];
  return lines.join('\n');
}

// renderList renders the open-verticals table. Row keys are PascalCase because
// DBProphetVerticalSpread carries no json tags; value/value_ok/dte are tagged.
export function renderList(rows) {
  if (!rows || rows.length === 0) return '_No open verticals._';
  const lines = ['# Open Debit Verticals', ''];
  for (const e of rows) {
    const r = e.row || {};
    const live = e.value_ok ? `live $${Number(e.value).toFixed(2)}/sh` : 'live value n/a (unpriced)';
    lines.push(`- \`${r.VerticalID}\` — ${r.Underlying} ${r.Direction} ${r.LongStrike}/${r.ShortStrike} · ${r.Status} · ${e.dte} DTE`);
    lines.push(`  debit $${Number(r.TotalDebit).toFixed(0)} · max gain $${Number(r.MaxGain).toFixed(0)} · ${live}`);
  }
  lines.push('');
  lines.push('_To close one: `node scripts/vertical.mjs close <VERTICAL_ID>`._');
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  node scripts/vertical.mjs propose <UNDERLYING> <call|put> [--exp YYYY-MM-DD] [--width N]
  node scripts/vertical.mjs place <PROPOSAL_ID>
  node scripts/vertical.mjs list
  node scripts/vertical.mjs close <VERTICAL_ID>

Defaults: --exp = next monthly opex (3rd Friday, ≥${MIN_DTE_DAYS} DTE), --width = ${DEFAULT_WIDTH}.
Requires the Go bot running with ENABLE_PROPHET_DEBIT_VERTICALS=true.`;

function fail(label, r, base) {
  console.error(`${label} failed: ${r.error}`);
  if (r.status === 0) {
    console.error(`(tried ${base}. If the bot runs on another port — sandbox bots use 4536+ — set TRADING_BOT_URL or TRADING_BOT_PORT and retry.)`);
  }
  return 1;
}

async function main(argv) {
  const base = resolveBase();
  const { cmd, positionals, flags } = parseArgs(argv);

  if (cmd === 'propose') {
    const [underlying, direction] = positionals;
    if (!underlying || !direction) { console.error(USAGE); return 2; }
    const expiration = flags.exp || defaultExpiration();
    const width = flags.width || DEFAULT_WIDTH;
    const r = await runPropose({ base, underlying, direction, expiration, width });
    if (!r.ok) return fail('Propose', r, base);
    console.log(renderCard(r.card));
    return 0;
  }

  if (cmd === 'place') {
    const [proposalId] = positionals;
    if (!proposalId) { console.error(USAGE); return 2; }
    const r = await runPlace({ base, proposalId });
    if (!r.ok) return fail('Place', r, base);
    console.log(`Placed (paper). Vertical id: ${r.verticalId}\nTrack it: node scripts/vertical.mjs list`);
    return 0;
  }

  if (cmd === 'list') {
    const r = await runList({ base });
    if (!r.ok) return fail('List', r, base);
    console.log(renderList(r.rows));
    return 0;
  }

  if (cmd === 'close') {
    const [verticalId] = positionals;
    if (!verticalId) { console.error(USAGE); return 2; }
    const r = await runClose({ base, verticalId });
    if (!r.ok) return fail('Close', r, base);
    console.log(`Close requested for ${verticalId}: ${r.status}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

import { fileURLToPath } from 'node:url';
import path from 'node:path';
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { console.error(`vertical failed: ${e.message}`); process.exit(1); });
}
