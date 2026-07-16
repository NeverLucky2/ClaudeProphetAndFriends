// Pure candidate-filter + episode-lifecycle logic for the Coil shadow eval.
import { classifyWatch, computeMargins, RSI_ENTRY_MAX } from '../coil-preview.mjs';

// isEvalCandidate: a WATCH name tightened to a real pullback (strictly below the
// 5-day), matching Coil's actual entry condition (close < SMA5). classifyWatch
// already enforces RSI(2) in [5,15), close>SMA200, no earnings, not-firing.
// DEVIATION: added sig.rsi_2 >= RSI_ENTRY_MAX guard to enforce the lower bound (5),
// ensuring firing-range names (rsi_2 < 5) are rejected even if classifyWatch passes.
export function isEvalCandidate(sig) {
  return classifyWatch(sig) && sig.rsi_2 >= RSI_ENTRY_MAX && sig.last_close < sig.sma_5;
}

// weekdaysBetween: trading-day approximation — count of weekdays strictly after
// isoA up to and including isoB (holidays ignored; a rare holiday only slightly
// extends a reopen window, which is harmless).
export function weekdaysBetween(isoA, isoB) {
  const a = new Date(`${isoA}T00:00:00Z`);
  const b = new Date(`${isoB}T00:00:00Z`);
  let n = 0;
  const cur = new Date(a.getTime());
  while (cur < b) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) n += 1;
  }
  return n;
}

// openEpisodes: given the active-name map, today's candidate sigs, their tags,
// and the ET date, expire elapsed actives and open one episode per fresh name.
// A name with a not-yet-elapsed (< 5 weekday) prior episode is skipped — the
// minimum-gap reopen rule, which also makes gaps harmless (blocking is by date,
// not by how many days the job ran).
export function openEpisodes({ active, candidates, tags, etDate }) {
  const nextActive = {};
  for (const [name, openDate] of Object.entries(active)) {
    if (weekdaysBetween(openDate, etDate) < 5) nextActive[name] = openDate; // still active
  }
  const episodes = [];
  for (const sig of candidates) {
    const name = sig.ticker;
    if (name in nextActive) continue; // prior episode still open
    const m = computeMargins(sig);
    episodes.push({
      name,
      openDate: etDate,
      entryRef: sig.last_close,
      tag: tags[name] || 'unknown',
      rsi2AtEntry: sig.rsi_2,
      sma5GapAtEntry: m.sma5_gap_pct,
      sma200GapAtEntry: m.sma200_gap_pct,
      status: 'open',
    });
    nextActive[name] = etDate;
  }
  return { episodes, active: nextActive };
}
