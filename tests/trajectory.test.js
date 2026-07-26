/**
 * 軌道の時間割り当て (速度・方位のプロファイル) の検査。
 *
 * 経路が幾何的に安全でも、等速で追従すると鋭角で破綻する。
 * 曲率に応じて減速し、方位の変化率も抑えられているかを確かめる。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Trajectory, TRAJECTORY_DEFAULTS } from '../src/core/trajectory.js';

const ROOM = { min: { x: -6, y: 0, z: -6 }, max: { x: 6, y: 3, z: 6 } };

const makeTrajectory = (over = {}) => {
  const cfg = { ...TRAJECTORY_DEFAULTS, ...over };
  return new Trajectory(cfg, ROOM);
};

/**
 * 時系列を刻んで、制御へ渡る指令の大きさを測る。
 *
 * 見るのは sample() が返す加速度そのもの (そのまま傾き指令になる) と、
 * 方位の変化率。速度を再微分すると、経路を折れ線で持っていることによる
 * 頂点の突起を測ってしまい、制御が実際に受け取る量とはずれる。
 */
function profile(traj, dt = 0.02) {
  let maxAcc = 0, maxLat = 0, maxYawRate = 0, prevYaw = null;
  const n = Math.ceil(traj.duration / dt);
  for (let i = 0; i <= n; i++) {
    const s = traj.sample(i * dt);
    const a = s.acceleration;
    const aLen = Math.hypot(a.x, a.y, a.z);
    maxAcc = Math.max(maxAcc, aLen);
    // 速度に垂直な成分 = 横方向 (向心) の加速度
    const v = Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z);
    if (v > 1e-3) {
      const along = (a.x * s.velocity.x + a.y * s.velocity.y + a.z * s.velocity.z) / v;
      maxLat = Math.max(maxLat, Math.sqrt(Math.max(0, aLen * aLen - along * along)));
    }
    if (prevYaw !== null) {
      let d = s.yaw - prevYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      maxYawRate = Math.max(maxYawRate, Math.abs(d) / dt);
    }
    prevYaw = s.yaw;
  }
  return { maxAcc, maxLat, maxYawRate };
}

test('速度プロファイル: 角で減速する', () => {
  // 往復スキャンは折り返しで 180° 曲がる
  const t = makeTrajectory({ pattern: 'lawnmower', speed: 1.5, rows: 4, loop: false });
  const speeds = t.speeds;
  assert.ok(speeds.length > 10);
  const vmax = Math.max(...speeds);
  const vmin = Math.min(...speeds.slice(1, -1));   // 端点は停止するので除く
  assert.ok(vmax <= 1.5 + 1e-6, `指定速度を超えている (${vmax})`);
  assert.ok(vmin < vmax * 0.9, '角で減速していない');
});

test('加速度指令が計画した上限を超えない', () => {
  const aLat = 1.5, aTan = 1.0;
  const t = makeTrajectory({
    pattern: 'lawnmower', speed: 2.0, rows: 4, loop: false,
    maxLateralAccel: aLat, maxTangentialAccel: aTan,
  });
  const p = profile(t);
  // sample() 側で上限 (合成値 x1.2) に頭打ちしている
  const cap = Math.hypot(aLat, aTan) * 1.2;
  assert.ok(p.maxAcc <= cap + 1e-6,
    `加速度指令が上限を超えている (${p.maxAcc.toFixed(2)} > ${cap.toFixed(2)})`);
  assert.ok(p.maxLat <= cap + 1e-6, `横加速度が上限を超えている (${p.maxLat.toFixed(2)})`);
});

test('速度プロファイル: 上限を下げると所要時間が伸びる', () => {
  const fast = makeTrajectory({ pattern: 'lawnmower', speed: 1.5, rows: 4, maxLateralAccel: 6 });
  const slow = makeTrajectory({ pattern: 'lawnmower', speed: 1.5, rows: 4, maxLateralAccel: 0.8 });
  assert.ok(slow.duration > fast.duration, '減速しても所要時間が変わっていない');
});

test('方位プロファイル: 変化率の上限を守る', () => {
  // 往復スキャンの折り返しでは、進行方向が 180° 反転する
  const t = makeTrajectory({
    pattern: 'lawnmower', speed: 1.2, rows: 4, loop: false,
    yawMode: 'along-path', maxYawRate: 40,
  });
  const p = profile(t);
  const limit = (40 * Math.PI) / 180;
  assert.ok(p.maxYawRate < limit * 1.6,
    `方位の変化率が上限を大きく超えている (${(p.maxYawRate * 57.3).toFixed(0)} °/s)`);
});

test('方位プロファイル: 折り返しでも目標方位が跳ばない', () => {
  const t = makeTrajectory({
    pattern: 'lawnmower', speed: 1.2, rows: 4, loop: false,
    yawMode: 'along-path', maxYawRate: 40,
  });
  let prev = null, maxJump = 0;
  for (let x = 0; x <= t.duration; x += 0.05) {
    const y = t.sample(x).yaw;
    if (prev !== null) {
      let d = y - prev;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      maxJump = Math.max(maxJump, Math.abs(d));
    }
    prev = y;
  }
  // 0.05 秒あたり 40°/s なら 2° 程度。跳びがあれば桁が変わる
  assert.ok(maxJump * 57.3 < 8, `目標方位が跳んでいる (${(maxJump * 57.3).toFixed(1)}°)`);
});

test('方位プロファイル: 進行方向を向くモード以外は従来どおり', () => {
  const t = makeTrajectory({ pattern: 'lawnmower', yawMode: 'fixed', yaw: 0.5 });
  assert.equal(t.yaws, null);
  assert.ok(Math.abs(t.sample(1.0).yaw - 0.5) < 1e-9);
});

test('端点で停止する (折り返しの向き反転で加速度が跳ねない)', () => {
  const t = makeTrajectory({ pattern: 'lawnmower', speed: 1.5, rows: 3, loop: false });
  assert.ok(t.speeds[0] < 1e-6);
  assert.ok(t.speeds[t.speeds.length - 1] < 1e-6);
});
