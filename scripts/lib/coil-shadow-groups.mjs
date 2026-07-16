// Group assignment for the Coil shadow eval. M is the same-rate mechanical
// benchmark: each day's k lowest-RSI candidates, k = that day's fire_early count.
export function assignGroups(episodes) {
  const C = episodes.filter((e) => e.tag === 'fire_early' || e.tag === 'declined');
  const A = C.filter((e) => e.tag === 'fire_early');
  const B = C.filter((e) => e.tag === 'declined');

  const byDay = new Map();
  for (const e of C) {
    if (!byDay.has(e.openDate)) byDay.set(e.openDate, []);
    byDay.get(e.openDate).push(e);
  }
  const M = [];
  for (const dayEps of byDay.values()) {
    const k = dayEps.filter((e) => e.tag === 'fire_early').length;
    if (k === 0) continue;
    const sorted = [...dayEps].sort((a, b) => a.rsi2AtEntry - b.rsi2AtEntry);
    M.push(...sorted.slice(0, k));
  }
  return { A, B, C, M };
}
