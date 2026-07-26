import test from 'node:test';
import assert from 'node:assert/strict';
import {
  v3, qFromEuler, qToEuler, qrot, qrotInv, qToMat3, qFromMat3, qmul, qconj,
  qErrorVector, qnormalize, m3inverse, m3mul, m3identity, pinv, matvec,
  DEG, wrapPi, makeRng,
} from '../src/core/math.js';
import {
  toENU, toNED, S_ENU, T_FLU, applyM3,
} from '../src/core/frames.js';

const close = (a, b, eps = 1e-9, msg = '') =>
  assert.ok(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a}`);
const closeV = (a, b, eps = 1e-9, msg = '') => {
  close(a.x, b.x, eps, msg + '.x'); close(a.y, b.y, eps, msg + '.y'); close(a.z, b.z, eps, msg + '.z');
};

test('オイラー角 ⇔ クォータニオン の往復', () => {
  const cases = [
    [0, 0, 0], [0.3, -0.2, 1.1], [-0.9, 0.4, -2.5], [0.01, 0.02, 3.0],
  ];
  for (const [r, p, y] of cases) {
    const q = qFromEuler(r, p, y);
    const e = qToEuler(q);
    close(wrapPi(e.roll - r), 0, 1e-9, 'roll');
    close(wrapPi(e.pitch - p), 0, 1e-9, 'pitch');
    close(wrapPi(e.yaw - y), 0, 1e-9, 'yaw');
  }
});

test('ヨー回転は前方ベクトルを左へ回す (反時計回りが正)', () => {
  const q = qFromEuler(0, 0, 90 * DEG);
  const fwd = qrot(q, v3(0, 0, -1)); // 機体前方 = -z
  // ヨー +90deg で前方は「左」= -x 方向を向く
  closeV(fwd, v3(-1, 0, 0), 1e-9, 'forward');
});

test('ピッチ正で機首が上がる', () => {
  const q = qFromEuler(0, 20 * DEG, 0);
  const fwd = qrot(q, v3(0, 0, -1));
  assert.ok(fwd.y > 0.3, `nose up expected, got y=${fwd.y}`);
});

test('ロール正で右が下がる', () => {
  const q = qFromEuler(20 * DEG, 0, 0);
  const right = qrot(q, v3(1, 0, 0));
  assert.ok(right.y < -0.3, `right side down expected, got y=${right.y}`);
});

test('qrot と回転行列が一致する', () => {
  const q = qFromEuler(0.4, -0.7, 2.1);
  const m = qToMat3(q);
  const v = v3(0.3, -1.2, 0.8);
  const a = qrot(q, v);
  const b = v3(
    m[0] * v.x + m[3] * v.y + m[6] * v.z,
    m[1] * v.x + m[4] * v.y + m[7] * v.z,
    m[2] * v.x + m[5] * v.y + m[8] * v.z,
  );
  closeV(a, b, 1e-12);
});

test('回転行列 ⇔ クォータニオン の往復', () => {
  for (const e of [[0.2, 0.3, 0.4], [2.9, -1.2, 0.5], [0, 0, Math.PI - 1e-4]]) {
    const q = qFromEuler(...e);
    const q2 = qFromMat3(qToMat3(q));
    const dot = Math.abs(q.x * q2.x + q.y * q2.y + q.z * q2.z + q.w * q2.w);
    close(dot, 1, 1e-9, 'quaternion roundtrip');
  }
});

test('qrotInv は qrot の逆変換', () => {
  const q = qFromEuler(0.5, 0.2, -1.0);
  const v = v3(1, 2, 3);
  closeV(qrotInv(q, qrot(q, v)), v, 1e-12);
});

test('姿勢誤差ベクトルは機体座標の回転ベクトル', () => {
  const qCur = qFromEuler(0.0, 0.0, 0.3);
  const qDes = qFromEuler(0.0, 0.2, 0.3);
  const e = qErrorVector(qCur, qDes);
  // ピッチ (+x) 方向のみ誤差が出るはず
  assert.ok(Math.abs(e.x - 0.2) < 1e-6, `pitch error ${e.x}`);
  assert.ok(Math.abs(e.y) < 1e-6 && Math.abs(e.z) < 1e-6);
  // 誤差ゼロ
  const z = qErrorVector(qCur, qCur);
  closeV(z, v3(0, 0, 0), 1e-12);
});

test('3x3 逆行列', () => {
  const A = [2, 1, 0, 0, 3, 1, 1, 0, 4]; // 列優先
  const I = m3mul(A, m3inverse(A));
  const E = m3identity();
  for (let i = 0; i < 9; i++) close(I[i], E[i], 1e-12);
});

test('疑似逆行列は最小二乗解を与える', () => {
  const A = [[1, 1, 1, 1], [1, -1, -1, 1], [1, 1, -1, -1]];
  const P = pinv(A);
  const b = [4, 0, 0];
  const x = matvec(P, b);
  const Ax = A.map((row) => row.reduce((s, v, i) => s + v * x[i], 0));
  for (let i = 0; i < 3; i++) close(Ax[i], b[i], 1e-6);
});

test('ENU 変換: 前方 (-z) は北 (+y_ENU) を向く', () => {
  const q = qFromEuler(0, 0, 0);
  const enu = toENU(v3(1, 2, 3), q);
  // 位置: E=x=1, N=-z=-3, U=y=2
  closeV(enu.p, v3(1, -3, 2), 1e-12, 'position');
  // 姿勢: 内部の前方 (-z_B) は FLU の +x、ENU の北 = +y
  const fwdFlu = qrot(enu.q, v3(1, 0, 0));
  closeV(fwdFlu, v3(0, 1, 0), 1e-9, 'forward in ENU');
  const upFlu = qrot(enu.q, v3(0, 0, 1));
  closeV(upFlu, v3(0, 0, 1), 1e-9, 'up in ENU');
});

test('NED 変換: 上方向は -z_NED', () => {
  const q = qFromEuler(0, 0, 0);
  const ned = toNED(v3(1, 2, 3), q);
  closeV(ned.p, v3(-3, 1, -2), 1e-12, 'position');
  const upFrd = qrot(ned.q, v3(0, 0, -1)); // FRD の -z = 上
  closeV(upFrd, v3(0, 0, -1), 1e-9, 'up in NED');
});

test('ENU/FLU 軸変換行列は右手系を保つ (det = +1)', () => {
  const det = (m) =>
    m[0] * (m[4] * m[8] - m[7] * m[5]) -
    m[3] * (m[1] * m[8] - m[7] * m[2]) +
    m[6] * (m[1] * m[5] - m[4] * m[2]);
  close(det(S_ENU), 1, 1e-12, 'S_ENU');
  close(det(T_FLU), 1, 1e-12, 'T_FLU');
  closeV(applyM3(S_ENU, v3(0, 1, 0)), v3(0, 0, 1), 1e-12, 'up→U');
});

test('乱数はシードで再現する', () => {
  const a = makeRng(42), b = makeRng(42);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  const n = makeRng(7);
  let sum = 0, sum2 = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) { const x = n.normal(); sum += x; sum2 += x * x; }
  close(sum / N, 0, 0.05, 'mean');
  close(Math.sqrt(sum2 / N), 1, 0.05, 'stddev');
});

test('クォータニオンの正規化と共役', () => {
  const q = qnormalize({ x: 1, y: 2, z: 3, w: 4 });
  const p = qmul(q, qconj(q));
  close(p.w, 1, 1e-12); close(p.x, 0, 1e-12); close(p.y, 0, 1e-12); close(p.z, 0, 1e-12);
});
