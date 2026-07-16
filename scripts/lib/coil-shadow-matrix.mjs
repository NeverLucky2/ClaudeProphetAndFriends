// Minimal linear algebra for the shadow-eval regression. Small dense matrices
// (K ~ 7), so plain Gaussian elimination with partial pivoting is ample.
export function matT(A) {
  const r = A.length, c = A[0].length;
  const out = Array.from({ length: c }, () => new Array(r));
  for (let i = 0; i < r; i += 1) for (let j = 0; j < c; j += 1) out[j][i] = A[i][j];
  return out;
}
export function matMul(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const out = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i += 1)
    for (let t = 0; t < k; t += 1) {
      const a = A[i][t];
      for (let j = 0; j < m; j += 1) out[i][j] += a * B[t][j];
    }
  return out;
}
export function matVec(A, x) {
  return A.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
}
// solveSPD: solve A x = b via Gaussian elimination with partial pivoting.
export function solveSPD(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new Error('singular matrix in solveSPD');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}
export function invSPD(A) {
  const n = A.length;
  const cols = [];
  for (let j = 0; j < n; j += 1) {
    const e = new Array(n).fill(0); e[j] = 1;
    cols.push(solveSPD(A, e));
  }
  // cols[j] is the j-th column of the inverse; transpose into row-major.
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]));
}
