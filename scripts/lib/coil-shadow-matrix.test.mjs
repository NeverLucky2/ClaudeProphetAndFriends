import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matMul, matT, solveSPD, invSPD } from './coil-shadow-matrix.mjs';

test('matMul and transpose', () => {
  const A = [[1, 2], [3, 4]];
  assert.deepEqual(matT(A), [[1, 3], [2, 4]]);
  assert.deepEqual(matMul(A, [[1, 0], [0, 1]]), A);
});

test('solveSPD solves A x = b for symmetric positive-definite A', () => {
  const A = [[4, 1], [1, 3]];
  const b = [1, 2];
  const x = solveSPD(A, b);
  assert.ok(Math.abs(4 * x[0] + 1 * x[1] - 1) < 1e-9);
  assert.ok(Math.abs(1 * x[0] + 3 * x[1] - 2) < 1e-9);
});

test('invSPD inverts', () => {
  const A = [[4, 1], [1, 3]];
  const Inv = invSPD(A);
  const I = matMul(A, Inv);
  assert.ok(Math.abs(I[0][0] - 1) < 1e-9 && Math.abs(I[1][1] - 1) < 1e-9);
  assert.ok(Math.abs(I[0][1]) < 1e-9 && Math.abs(I[1][0]) < 1e-9);
});
