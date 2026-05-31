// scripts/keyword-polarity.mjs
// keyword_polarity_v1: deterministic, hashable news polarity from headline+snippet.
// Reproducibility + leakage-freedom are why a model is NOT the primary (spec §2.1).
// Returns sign(#positive cues - #negative cues): -1 | 0 | +1.

const POSITIVE = [
  /\bto acquire\b/, /\bagrees to buy\b/, /\bacquires?\b/, /\bacquisition\b/,
  /\btakeover\b/, /\btender offer\b/, /\braises? guidance\b/, /\braised guidance\b/,
  /\bbeats?\b/, /\btops?\b/, /\bcrushes?\b/, /\bpreannounces? (above|strong)\b/,
  /\bupgrade[sd]?\b/,
];
const NEGATIVE = [
  /\bprofit warning\b/, /\bcuts? guidance\b/, /\bcut guidance\b/, /\bwarns? (on|about)\b/,
  /\bmisses?\b/, /\btrails?\b/, /\bpreannounces? (below|weak)\b/, /\bdowngrade[sd]?\b/,
  /\bprobe\b/, /\binvestigation\b/,
];

export function keywordPolarityV1(text) {
  const t = String(text ?? '').toLowerCase();
  let pos = 0, neg = 0;
  for (const re of POSITIVE) if (re.test(t)) pos += 1;
  for (const re of NEGATIVE) if (re.test(t)) neg += 1;
  return Math.sign(pos - neg);
}
