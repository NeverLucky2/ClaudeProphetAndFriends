// Daily-brief freshness contract.
//
// The daily brief is the LLM-generated pre-market macro snapshot agents read
// at the start of each trading day. Without a freshness contract, a silently-
// failed regenerate would let agents trade Monday using Friday's brief and
// never know — the lexicographic-newest-file pattern in mcp-server.js has no
// staleness gate of its own.
//
// This module owns:
//   - the stable filename (so writer + reader can't drift),
//   - the staleness window (kept equal to regime_gate's 29h for consistency),
//   - the pure helpers the scheduler uses to inject freshness fields and the
//     MCP reader uses to detect stale reads.
//
// All helpers are pure: they accept a `now: Date` parameter so tests are
// deterministic and the scheduler/reader share one implementation.

// Must match scripts/compute_daily_regime_score.py STALE_AFTER_HOURS = 29.
// Briefs are generated weekday mornings ~6 AM ET (≈10/11 UTC). 29h covers
// the longest weekday gap with a small slack for slow generation; the
// Friday→Monday gap is intentionally beyond the window so a Monday-morning
// read of a Friday brief is correctly flagged stale.
export const STALE_AFTER_HOURS = 29;

export const DAILY_BRIEF_FILENAME = 'daily_brief.json';

// injectFreshnessFields returns a shallow copy of `brief` with `as_of` and
// `stale_after` set from `now`. The scheduler — never the LLM — is the source
// of truth for these timestamps, so any pre-existing values are overwritten.
export function injectFreshnessFields(brief, now) {
  const asOf = now.toISOString();
  const staleAfter = new Date(now.getTime() + STALE_AFTER_HOURS * 3600 * 1000).toISOString();
  return { ...brief, as_of: asOf, stale_after: staleAfter };
}

// parseBriefStaleness inspects a parsed brief JSON object and returns the
// freshness verdict. Missing or malformed freshness fields are treated as
// stale on purpose — a brief that can't prove it's fresh isn't trusted.
export function parseBriefStaleness(brief, now) {
  const asOfRaw = brief && typeof brief === 'object' ? brief.as_of : undefined;
  const staleAfterRaw = brief && typeof brief === 'object' ? brief.stale_after : undefined;
  const staleAfterDate = staleAfterRaw ? new Date(staleAfterRaw) : null;
  const hasFields =
    typeof asOfRaw === 'string' &&
    typeof staleAfterRaw === 'string' &&
    staleAfterDate !== null &&
    !Number.isNaN(staleAfterDate.getTime());

  if (!hasFields) {
    return { asOf: null, staleAfter: null, isStale: true, hasFields: false };
  }
  return {
    asOf: asOfRaw,
    staleAfter: staleAfterRaw,
    isStale: now.getTime() > staleAfterDate.getTime(),
    hasFields: true,
  };
}

// briefAsOfETDate returns the America/New_York calendar date (YYYY-MM-DD) of
// `as_of`. The scheduler's "have we run today?" check uses ET-local dates
// throughout (lock keys, _lastFooDate trackers), so this must match — using
// the UTC date instead would mis-compare on manual reruns after 8 PM ET
// (which roll into the next UTC day) and on pre-dawn restarts. Returns null
// on any parse failure so the scheduler treats it as "no brief today" and
// triggers a fresh run.
export function briefAsOfETDate(brief) {
  const asOf = brief && typeof brief === 'object' ? brief.as_of : undefined;
  if (typeof asOf !== 'string') return null;
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
