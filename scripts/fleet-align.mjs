// scripts/fleet-align.mjs
// Align per-lane daily return series onto a common index (zero-fill gaps), then aggregate
// daily -> weekly (ISO week: compound returns, OR the active flag).

export function unionDates(lanesByName) {
  const s = new Set();
  for (const arr of Object.values(lanesByName)) for (const p of arr) s.add(p.date);
  return [...s].sort();
}

export function alignDaily(lanesByName, dates) {
  const out = {};
  for (const [name, arr] of Object.entries(lanesByName)) {
    const byDate = new Map(arr.map(p => [p.date, p]));
    out[name] = dates.map(d => {
      const p = byDate.get(d);
      return p ? { date: d, ret: p.ret, active: !!p.active } : { date: d, ret: 0, active: false };
    });
  }
  return out;
}

// ISO-8601 week key (YYYY-Www) for a YYYY-MM-DD date, computed in UTC.
export function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;      // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3);    // move to Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const firstThu = new Date(Date.UTC(isoYear, 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function toWeekly(daily) {
  const groups = new Map(); const order = [];
  for (const p of daily) {
    const k = isoWeekKey(p.date);
    if (!groups.has(k)) { groups.set(k, []); order.push(k); }
    groups.get(k).push(p);
  }
  return order.map(k => {
    const ps = groups.get(k);
    let comp = 1; let active = false;
    for (const p of ps) { comp *= (1 + p.ret); active = active || p.active; }
    return { week: k, date: ps[ps.length - 1].date, ret: comp - 1, active };
  });
}
