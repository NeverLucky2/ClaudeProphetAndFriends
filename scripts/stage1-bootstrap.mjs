// scripts/stage1-bootstrap.mjs
// Moving-block bootstrap of hit rate over ordered unique firing dates. Block length
// in sessions (~10 = ~2 weeks) absorbs same-day co-movement + most earnings-season
// clustering; residual long-horizon clustering is uncaptured (spec §5). Seeded.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dateBlockBootstrapHR(firings, { blockSessions = 10, iterations = 10000, seed = 1234, percentile = 5 } = {}) {
  if (!firings.length) return { percentileHR: null, iterations: 0 };
  const byDate = new Map();
  for (const f of firings) (byDate.get(f.date) ?? byDate.set(f.date, []).get(f.date)).push(f);
  const dates = [...byDate.keys()].sort();
  const block = Math.min(blockSessions, dates.length);
  const nBlocks = Math.ceil(dates.length / block);
  const maxStart = dates.length - block; // inclusive
  const rng = mulberry32(seed);
  const hrs = [];
  for (let it = 0; it < iterations; it += 1) {
    let hits = 0, total = 0;
    for (let b = 0; b < nBlocks; b += 1) {
      const start = Math.floor(rng() * (maxStart + 1));
      for (let k = 0; k < block; k += 1) {
        const dayFirings = byDate.get(dates[start + k]);
        for (const f of dayFirings) { total += 1; if (f.hit) hits += 1; }
      }
    }
    hrs.push(total ? hits / total : 0);
  }
  hrs.sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(hrs.length - 1, Math.floor((percentile / 100) * hrs.length)));
  return { percentileHR: hrs[idx], iterations };
}
