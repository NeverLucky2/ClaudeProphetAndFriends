// Fixed-effects (entry-day) + cluster-robust (by name) regression for the Coil
// shadow eval. Uses the within transformation: demean y and every regressor by
// its day-group mean, so day fixed effects are absorbed and the design matrix
// stays small (fire_early + RSI-bucket dummies + sma5_gap + sma200_gap).
import { matT, matMul, matVec, invSPD } from './coil-shadow-matrix.mjs';

const Z_ONE_SIDED_90 = 1.2816;

// RSI(2) buckets over [5,15): [5,7),[7,9),[9,11),[11,13),[13,15). The first
// bucket is the dropped reference; returns 4 dummy values.
function rsiBuckets(rsi2) {
  const edges = [7, 9, 11, 13]; // dummies for buckets 2..5
  return edges.map((e, i) => (rsi2 >= e && rsi2 < (edges[i + 1] ?? 15) ? 1 : 0));
}

function designRow(r) {
  return [r.fireEarly, ...rsiBuckets(r.rsi2), r.sma5Gap, r.sma200Gap];
}

// demeanByGroup subtracts each row's day-group mean from y and every X column.
function demean(rows, ys, xs) {
  const sums = new Map(); // day -> {n, sy, sx[]}
  const K = xs[0].length;
  for (let i = 0; i < rows.length; i += 1) {
    const d = rows[i].day;
    if (!sums.has(d)) sums.set(d, { n: 0, sy: 0, sx: new Array(K).fill(0) });
    const g = sums.get(d);
    g.n += 1; g.sy += ys[i];
    for (let j = 0; j < K; j += 1) g.sx[j] += xs[i][j];
  }
  const yd = new Array(rows.length), xd = new Array(rows.length);
  const identifyingDays = new Set();
  for (let i = 0; i < rows.length; i += 1) {
    const g = sums.get(rows[i].day);
    yd[i] = ys[i] - g.sy / g.n;
    xd[i] = xs[i].map((v, j) => v - g.sx[j] / g.n);
    if (Math.abs(xd[i][0]) > 1e-12) identifyingDays.add(rows[i].day); // fire_early varies this day
  }
  return { yd, xd, nIdentifyingDays: identifyingDays.size };
}

export function fitWithinClustered(rows) {
  const ys = rows.map((r) => r.ret);
  const xsRaw = rows.map(designRow);
  const { yd, xd, nIdentifyingDays } = demean(rows, ys, xsRaw);
  const n = rows.length;
  const Kfull = xd[0].length;

  // Drop rank-deficient control columns (index >= 1) that are ~0 across every row
  // after demeaning: an empty RSI bucket, or a control with no within-day variation.
  // fire_early (col 0) is always retained. An empty bucket has no observations to
  // estimate, so dropping its all-zero dummy is a numerical necessity, not a change
  // to the pre-registered statistic. `keptCols` surfaces how many columns survived.
  const keep = [0];
  for (let j = 1; j < Kfull; j += 1) {
    if (xd.some((row) => Math.abs(row[j]) > 1e-12)) keep.push(j);
  }
  const xk = xd.map((row) => keep.map((j) => row[j]));
  const K = keep.length;

  const Xt = matT(xk);                 // K×n
  const XtX = matMul(Xt, xk);          // K×K
  const XtXinv = invSPD(XtX);
  const XtY = matVec(Xt, yd);          // K
  const beta = matVec(XtXinv, XtY);    // K coefficients; beta[0] is fire_early
  const resid = yd.map((y, i) => y - xk[i].reduce((s, v, j) => s + v * beta[j], 0));

  // Cluster-robust "meat": Σ_g (X_g' e_g)(X_g' e_g)'  clustered by name.
  const byCluster = new Map();
  for (let i = 0; i < n; i += 1) {
    const c = rows[i].name;
    if (!byCluster.has(c)) byCluster.set(c, new Array(K).fill(0));
    const s = byCluster.get(c);
    for (let j = 0; j < K; j += 1) s[j] += xk[i][j] * resid[i];
  }
  const meat = Array.from({ length: K }, () => new Array(K).fill(0));
  for (const s of byCluster.values())
    for (let a = 0; a < K; a += 1) for (let b = 0; b < K; b += 1) meat[a][b] += s[a] * s[b];

  const G = byCluster.size;
  // Sandwich with the standard finite-sample cluster correction.
  const dof = (G / (G - 1)) * ((n - 1) / (n - K));
  const mid = matMul(meat, XtXinv);
  const V = matMul(XtXinv, mid).map((row) => row.map((v) => v * dof));
  const se = Math.sqrt(V[0][0]);

  // Naive (independent-obs) SE for the diagnostic comparison.
  const s2 = resid.reduce((a, e) => a + e * e, 0) / (n - K);
  const naiveSe = Math.sqrt(s2 * XtXinv[0][0]);

  return {
    beta: beta[0], se, naiveSe,
    ciLower: beta[0] - Z_ONE_SIDED_90 * se,
    ciUpper: beta[0] + Z_ONE_SIDED_90 * se,
    n, nClusters: G, nIdentifyingDays, keptCols: K,
  };
}

// computeVerdict maps a fit to the pre-registered terminal decision.
// floor = the +1.0% effect-size floor (in return units).
export function computeVerdict(fit, { floor = 0.01 } = {}) {
  if (fit.ciLower > 0 && fit.beta >= floor) return 'KEEP';
  if (fit.ciUpper < floor) return 'REJECT';
  return 'INCONCLUSIVE';
}

// futilityGate is the ~8-week staged check: it can only early-REJECT (a
// worthwhile edge already ruled out) or continue. It NEVER emits KEEP, so it
// introduces no optional-stopping bias toward a false positive.
export function futilityGate(fit, { floor = 0.01 } = {}) {
  return fit.ciUpper < floor ? 'early-reject' : 'continue';
}
