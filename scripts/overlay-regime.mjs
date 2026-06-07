// scripts/overlay-regime.mjs
// Regime split for the hedge-overlay study: rate-shock weeks (top-decile weekly Δy10, S3 idiom),
// crisis-subset partition, contiguous-episode counting, and a forward-filled risk-free series.

// weeklyY10: array of week-end 10y yields (percent). Returns Set of week indices whose Δy10
// (vs prior week) is in the top `topFrac` of all weekly changes. Signal-independent of QQQ.
export function rateShockWeeks(weeklyY10, { topFrac = 0.1 } = {}) {
  const deltas = [];
  for (let i = 1; i < weeklyY10.length; i += 1) {
    if (weeklyY10[i] == null || weeklyY10[i - 1] == null) continue;
    deltas.push({ i, d: weeklyY10[i] - weeklyY10[i - 1] });
  }
  if (!deltas.length) return new Set();
  const k = Math.max(1, Math.floor(deltas.length * topFrac));
  return new Set(deltas.slice().sort((a, b) => b.d - a.d).slice(0, k).map((x) => x.i));
}

export function splitCrisis(crisisIdx, rateShockSet) {
  const rateShockIdx = crisisIdx.filter((i) => rateShockSet.has(i));
  const growthScareIdx = crisisIdx.filter((i) => !rateShockSet.has(i));
  return { rateShockIdx, growthScareIdx };
}

export function countEpisodes(idxArray) {
  const s = [...idxArray].sort((a, b) => a - b);
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (i === 0 || s[i] !== s[i - 1] + 1) n += 1;
  return n;
}

// curve: [{date, m3}] ascending; dates: target trading dates. Returns Map<date, dailyRf>.
export function riskFreeDaily(curve, dates) {
  const sorted = curve.slice().filter((r) => r.m3 != null).sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = new Map(); let j = 0; let cur = null;
  for (const d of dates) {
    while (j < sorted.length && sorted[j].date <= d) { cur = sorted[j].m3; j += 1; }
    out.set(d, cur == null ? 0 : (cur / 100) / 252);
  }
  return out;
}

// Week-end 10y yields aligned to a weekly index: pick the LAST curve y10 on/before each week's date.
export function weeklyY10ForWeeks(curve, weekEndDates) {
  const sorted = curve.slice().filter((r) => r.y10 != null).sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = []; let j = 0; let cur = null;
  for (const d of weekEndDates) {
    while (j < sorted.length && sorted[j].date <= d) { cur = sorted[j].y10; j += 1; }
    out.push(cur);
  }
  return out;
}
