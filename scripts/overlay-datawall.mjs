// scripts/overlay-datawall.mjs
// Task 0 (spec §13): pre-modeling data-wall verification — earliest dates, VIXM/curve coverage,
// and per-era dropped-weight gate for the reconstructed-Merrill target.

export function suppressedEras(droppedByYear, { threshold = 0.30 } = {}) {
  return Object.keys(droppedByYear).filter((y) => droppedByYear[y] > threshold).sort();
}

export function dataWallSummary({ earliest = {}, droppedByYear = {}, windowStart = '2016-01-01', threshold = 0.30 } = {}) {
  const vixm = earliest.VIXM || null;
  const curve = earliest.__curve || null;
  return {
    vixm, curve,
    vixmCoversWindow: vixm != null && vixm <= windowStart,
    curveCoversWindow: curve != null && curve <= windowStart,
    droppedByYear,
    suppressed: suppressedEras(droppedByYear, { threshold }),
  };
}
