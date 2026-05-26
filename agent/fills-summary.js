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
// share one anchor regardless of the server's own timezone. Pure for testing.
export function startOfEtTradingDayIso(now = new Date()) {
  const tz = 'America/New_York';
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now).split('-').map(Number);

  const wp = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce((a, p) => ((a[p.type] = p.value), a), {});

  // ET wall-clock for `now`, read as if it were UTC, minus the real instant =
  // ET's UTC offset (handles EDT/EST automatically).
  const wallAsUtc = Date.UTC(
    Number(wp.year), Number(wp.month) - 1, Number(wp.day),
    Number(wp.hour) % 24, Number(wp.minute), Number(wp.second),
  );
  const nowMs = Math.floor(now.getTime() / 1000) * 1000;
  const offsetMs = wallAsUtc - nowMs;
  const etMidnightAsUtc = Date.UTC(y, mo - 1, d, 0, 0, 0);
  return new Date(etMidnightAsUtc - offsetMs).toISOString();
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
