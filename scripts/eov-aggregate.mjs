export function aggregateCallVol(barsByContract) {
  const out = {};
  for (const bars of Object.values(barsByContract)) {
    for (const b of bars) {
      if (!Number.isFinite(b.v)) continue;
      out[b.date] = (out[b.date] ?? 0) + b.v;
    }
  }
  return out;
}

export function contractCountByMonth(barsByContract) {
  const byMonth = {};
  for (const [sym, bars] of Object.entries(barsByContract)) {
    const months = new Set();
    for (const b of bars) if (Number.isFinite(b.v)) months.add(b.date.slice(0, 7));
    for (const m of months) { byMonth[m] = byMonth[m] ?? new Set(); byMonth[m].add(sym); }
  }
  const out = {};
  for (const [m, set] of Object.entries(byMonth)) out[m] = set.size;
  return out;
}
