// LLM-free fills recap. Fetches the current-ET-day filled-order summary for a
// strategy from the Go backend and renders a one-line terminal recap. Mirrors
// beat-context.js: split fetch + render so both are unit-testable without a live
// backend. Soft-fail throughout — a missing recap never blocks start or an SSE
// connect.

const MAX_LISTED = 10;

// fetchFillsSummary returns the parsed summary, or null on any error / missing
// inputs. 3000ms timeout matches beat-context.js's soft-fail fetch budget.
export async function fetchFillsSummary(goAxios, strategy, since) {
  if (!goAxios || !strategy) return null;
  try {
    const params = new URLSearchParams({ strategy });
    if (since) params.set('since', since);
    const resp = await goAxios.get(`/api/v1/fills/summary?${params.toString()}`, { timeout: 3000 });
    return resp?.data ?? null;
  } catch (_err) {
    return null;
  }
}

// renderFillsSummaryLine returns one terminal line, or '' when there is nothing
// to report (null summary or zero fills — quiet on no-fill days).
export function renderFillsSummaryLine(summary, agentName) {
  if (!summary || !Array.isArray(summary.fills) || !summary.count) return '';
  const name = agentName || 'Agent';
  const shown = summary.fills.slice(0, MAX_LISTED);
  const items = shown.map((f) => {
    const side = String(f.side || '').toUpperCase();
    const px = Number(f.avg_price) ? ` @ $${Number(f.avg_price).toFixed(2)}` : '';
    return `${side} ${formatQty(f.qty)} ${f.symbol}${px} (${formatEtTime(f.filled_at)} ET)`;
  });
  const extra = summary.count - shown.length;
  const tail = extra > 0 ? ` · +${extra} more` : '';
  const noun = summary.count === 1 ? 'fill' : 'fills';
  return `${name} — ${summary.count} ${noun} today (broker-side, no LLM beat): ${items.join(' · ')}${tail}`;
}

// startOfEtTradingDayIso returns the ISO instant for 00:00 America/New_York on
// the ET calendar date of `now`. Computed via Intl so the harness and SSE paths
// (and the reconciliation runner, which imports this) share one anchor
// regardless of the server's own timezone. Pure for testing.
export function startOfEtTradingDayIso(now = new Date()) {
  const tz = 'America/New_York';
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now).split('-').map(Number);

  // ET's UTC offset (ms) at a given instant: render that instant as ET
  // wall-clock, read it back as if it were UTC, and subtract the real instant.
  // Handles EDT/EST automatically.
  const etOffsetMsAt = (instantMs) => {
    const wp = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instantMs)).reduce((a, p) => ((a[p.type] = p.value), a), {});
    const wallAsUtc = Date.UTC(
      Number(wp.year), Number(wp.month) - 1, Number(wp.day),
      Number(wp.hour) % 24, Number(wp.minute), Number(wp.second),
    );
    return wallAsUtc - instantMs;
  };

  // Measure the offset *at midnight*, not at `now`: on a DST-transition day the
  // two differ by an hour, which would otherwise shift the boundary off
  // midnight (e.g. to 23:00 the prior day, or 01:00). Probe the offset at
  // midnight-read-as-UTC, then re-probe at the corrected instant so a probe
  // that landed on the wrong side of the transition still settles.
  const etMidnightAsUtc = Date.UTC(y, mo - 1, d, 0, 0, 0);
  let result = etMidnightAsUtc - etOffsetMsAt(etMidnightAsUtc);
  result = etMidnightAsUtc - etOffsetMsAt(result);
  return new Date(result).toISOString();
}

// claimConnectRecap decides whether the connect-time recap should be emitted to
// a freshly-connected SSE client, and atomically records the decision.
//
// The recap is meant to fire once per *dashboard viewing session*, not once per
// TCP connect. A single operator's tab reconnects to /api/events constantly —
// on every tab hide/show (visibilitychange tears down + rebuilds the stream),
// on idle-timeout drops the keepalive misses, on sleep/wake. Keying on a
// per-page-load session id (the client's `sid`) collapses all those reconnects
// to a single recap, while distinct page loads / second dashboards each still
// get their own. Returns true (and claims the slot) the first time a sid is
// seen, false thereafter. A missing sid (older cached client, curl) preserves
// the prior always-emit behavior and is never recorded. `servedSessions` is a
// process-lifetime Set; growth is one entry per page load — negligible for a
// single-operator localhost dashboard.
export function claimConnectRecap(servedSessions, sid) {
  if (!sid) return true;
  if (servedSessions.has(sid)) return false;
  servedSessions.add(sid);
  return true;
}

function formatQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return '?';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function formatEtTime(iso) {
  if (!iso) return '??:??';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '??:??';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}
