/**
 * 6 自由度剛体ダイナミクスと積分器。
 *
 * 状態量
 *   p     : 位置 (ワールド座標) [m]
 *   v     : 速度 (ワールド座標) [m/s]
 *   q     : 姿勢クォータニオン (機体 → ワールド)
 *   omega : 角速度 (機体座標) [rad/s]
 *
 * 運動方程式
 *   dp/dt = v
 *   dv/dt = F_world / m
 *   dq/dt = 0.5 * q ⊗ (0, omega)
 *   dω/dt = I^-1 (M_body - ω × (I ω) - M_gyro)
 */

import {
  v3, vadd, vsub, vmul, vcross, qmul, qnormalize, qcopy, vcopy,
  m3mulv, m3inverse,
} from './math.js';

export const G = 9.80665;

export function makeState(p = v3(0, 0, 0), v = v3(0, 0, 0), q = { x: 0, y: 0, z: 0, w: 1 }, omega = v3(0, 0, 0)) {
  return { p: vcopy(p), v: vcopy(v), q: { ...q }, omega: vcopy(omega) };
}

export const cloneState = (s) => ({
  p: vcopy(s.p), v: vcopy(s.v), q: qcopy(s.q), omega: vcopy(s.omega),
});

/**
 * 状態微分。
 * @param {object} s 状態
 * @param {{force:{x,y,z}, torque:{x,y,z}}} w force はワールド座標、torque は機体座標
 * @param {number} mass
 * @param {number[]} I 慣性テンソル (機体座標, 列優先)
 * @param {number[]} Iinv その逆行列
 */
export function derivative(s, w, mass, I, Iinv) {
  const dp = vcopy(s.v);
  const dv = vmul(w.force, 1 / mass);
  const wq = { x: s.omega.x, y: s.omega.y, z: s.omega.z, w: 0 };
  const dqRaw = qmul(s.q, wq);
  const dq = { x: dqRaw.x * 0.5, y: dqRaw.y * 0.5, z: dqRaw.z * 0.5, w: dqRaw.w * 0.5 };
  const Iw = m3mulv(I, s.omega);
  const gyro = vcross(s.omega, Iw);
  const domega = m3mulv(Iinv, vsub(w.torque, gyro));
  return { dp, dv, dq, domega };
}

const addScaled = (s, d, h) => ({
  p: vadd(s.p, vmul(d.dp, h)),
  v: vadd(s.v, vmul(d.dv, h)),
  q: qnormalize({
    x: s.q.x + d.dq.x * h, y: s.q.y + d.dq.y * h,
    z: s.q.z + d.dq.z * h, w: s.q.w + d.dq.w * h,
  }),
  omega: vadd(s.omega, vmul(d.domega, h)),
});

/**
 * 古典的 4 次ルンゲ・クッタ法。
 * @param {function} wrenchFn (state, tOffset) => {force, torque}
 */
export function rk4(state, dt, wrenchFn, mass, I, Iinv) {
  const k1 = derivative(state, wrenchFn(state, 0), mass, I, Iinv);
  const s2 = addScaled(state, k1, dt / 2);
  const k2 = derivative(s2, wrenchFn(s2, dt / 2), mass, I, Iinv);
  const s3 = addScaled(state, k2, dt / 2);
  const k3 = derivative(s3, wrenchFn(s3, dt / 2), mass, I, Iinv);
  const s4 = addScaled(state, k3, dt);
  const k4 = derivative(s4, wrenchFn(s4, dt), mass, I, Iinv);

  const comb = (a, b, c, d) => (a + 2 * b + 2 * c + d) / 6;
  const d = {
    dp: v3(comb(k1.dp.x, k2.dp.x, k3.dp.x, k4.dp.x), comb(k1.dp.y, k2.dp.y, k3.dp.y, k4.dp.y), comb(k1.dp.z, k2.dp.z, k3.dp.z, k4.dp.z)),
    dv: v3(comb(k1.dv.x, k2.dv.x, k3.dv.x, k4.dv.x), comb(k1.dv.y, k2.dv.y, k3.dv.y, k4.dv.y), comb(k1.dv.z, k2.dv.z, k3.dv.z, k4.dv.z)),
    dq: {
      x: comb(k1.dq.x, k2.dq.x, k3.dq.x, k4.dq.x), y: comb(k1.dq.y, k2.dq.y, k3.dq.y, k4.dq.y),
      z: comb(k1.dq.z, k2.dq.z, k3.dq.z, k4.dq.z), w: comb(k1.dq.w, k2.dq.w, k3.dq.w, k4.dq.w),
    },
    domega: v3(comb(k1.domega.x, k2.domega.x, k3.domega.x, k4.domega.x), comb(k1.domega.y, k2.domega.y, k3.domega.y, k4.domega.y), comb(k1.domega.z, k2.domega.z, k3.domega.z, k4.domega.z)),
  };
  return addScaled(state, d, dt);
}

/** 半陰的オイラー法 (高速モード用) */
export function semiImplicitEuler(state, dt, wrenchFn, mass, I, Iinv) {
  const d = derivative(state, wrenchFn(state, 0), mass, I, Iinv);
  const omega = vadd(state.omega, vmul(d.domega, dt));
  const v = vadd(state.v, vmul(d.dv, dt));
  const wq = { x: omega.x, y: omega.y, z: omega.z, w: 0 };
  const dq = qmul(state.q, wq);
  return {
    p: vadd(state.p, vmul(v, dt)),
    v,
    q: qnormalize({
      x: state.q.x + dq.x * 0.5 * dt, y: state.q.y + dq.y * 0.5 * dt,
      z: state.q.z + dq.z * 0.5 * dt, w: state.q.w + dq.w * 0.5 * dt,
    }),
    omega,
  };
}

/** ロータの回転による角運動量に起因するジャイロモーメント (機体座標) */
export function gyroscopicTorque(rotors, speeds, rotorInertia, omega) {
  let h = v3(0, 0, 0);
  for (let i = 0; i < rotors.length; i++) {
    const r = rotors[i];
    const hi = rotorInertia * speeds[i] * 2 * Math.PI * r.spin;
    h = vadd(h, vmul(r.axis, hi));
  }
  // M = -ω × h
  return vmul(vcross(omega, h), -1);
}

export const inertiaInverse = (I) => m3inverse(I);
