// Retrospective exit-rule replay for the Coil shadow eval. Deterministic and
// reproducible: reads entry AND exit from one adjusted series (single basis).
import { STOP_PCT } from '../coil-preview.mjs';

export const HOLD_DAYS = 5;
const GLITCH_MOVE = 0.5; // >50% single-day adjusted move ⇒ data glitch

function etDate(as_of) { return String(as_of).slice(0, 10); }

// scoreEpisode replays Coil's exits over the days AFTER the entry day. Returns a
// closed episode (with return/outcome) or an unscorable one (with a reason).
export function scoreEpisode(episode, series) {
  const entryIdx = series.findIndex((p) => etDate(p.as_of) === episode.openDate);
  if (entryIdx < 0) {
    return { ...episode, status: 'unscorable', unscorableReason: 'entry day not in series' };
  }
  const entryRef = series[entryIdx].last_close; // re-read: single adjustment basis
  const window = series.slice(entryIdx + 1, entryIdx + 1 + HOLD_DAYS);

  // Data-glitch guard: any >50% single-day move across entry→window.
  let prev = entryRef;
  for (const p of window) {
    if (Math.abs(p.last_close / prev - 1) > GLITCH_MOVE) {
      return { ...episode, status: 'unscorable', unscorableReason: 'implausible in-window move' };
    }
    prev = p.last_close;
  }

  const laterFired = window.some((p) => p.rsi_2 < 5);
  const stopLevel = entryRef * (1 - STOP_PCT);

  for (let i = 0; i < window.length; i += 1) {
    const p = window[i];
    let exitClose = null;
    if (p.last_close <= stopLevel) exitClose = p.last_close;            // 1. stop
    else if (p.rsi_2 > 70 || p.last_close > p.sma_5) exitClose = p.last_close; // 2. target
    else if (i === HOLD_DAYS - 1) exitClose = p.last_close;             // 4. timeout
    if (exitClose !== null) {
      const ret = (exitClose - entryRef) / entryRef;
      return { ...episode, status: 'closed', exitDate: etDate(p.as_of), exitClose,
        ret, outcome: ret > 0 ? 'bounce' : 'no-bounce', laterFired };
    }
  }
  // Window shorter than HOLD_DAYS with no exit ⇒ missing trading day(s).
  return { ...episode, status: 'unscorable', unscorableReason: 'incomplete window' };
}
