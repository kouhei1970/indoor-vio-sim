/**
 * 空力モデル。屋内飛行で効いてくる現象を中心にまとめている。
 *
 *  - 地面効果 (Ground Effect)      : 床に近いと推力が増える
 *  - 天井効果 (Ceiling Effect)     : 天井に近いと吸い寄せられる
 *  - 壁効果   (Wall Effect)        : 壁際で横方向に引き込まれる
 *  - 機体抗力 (Body Drag)          : 並進速度に対する抗力
 *  - ロータ抗力 (H-force / blade flapping) : 水平移動時の抗力・姿勢モーメント
 *  - 並進揚力 (Translational lift) : 水平移動で誘導速度が下がり推力が増える
 *  - VRS 近似 (Vortex Ring State)  : 急降下時の推力損失
 *  - 室内気流 (空調・換気) と乱流
 */

import { v3, vadd, vmul, vsub, vlen, clamp, makeRng } from './math.js';

export const AIR_PRESETS = {
  standard: { density: 1.225, temperature: 20, pressure: 101325, label: '標準大気 (20°C)' },
  warmRoom: { density: 1.184, temperature: 25, pressure: 101325, label: '暖かい室内 (25°C)' },
  highland: { density: 1.06, temperature: 15, pressure: 89875, label: '高地 (1000m)' },
};

/** 高度 z [m] (ロータ面から床まで) における地面効果係数 */
export function groundEffectFactor(height, rotorRadius, enabled = true, maxGain = 1.35) {
  if (!enabled) return 1;
  const z = Math.max(height, 1e-3);
  const ratio = rotorRadius / (4 * z);
  if (ratio >= 0.99) return maxGain;
  const f = 1 / (1 - ratio * ratio);
  return clamp(f, 1, maxGain);
}

/** 天井までの距離 d [m] における天井効果係数 */
export function ceilingEffectFactor(distToCeiling, rotorRadius, enabled = true, maxGain = 1.5) {
  if (!enabled) return 1;
  const d = Math.max(distToCeiling, 1e-3);
  // Sanchez-Cuevas et al. の近似形
  const r = rotorRadius / d;
  const f = 1 / (1 - (r * r) / 6.25);
  return clamp(f, 1, maxGain);
}

/** 降下時の推力損失 (VRS 近似)。vz < 0 が降下。 */
export function vrsFactor(vz, inducedVelocity, enabled = true) {
  if (!enabled || vz >= 0) return 1;
  const r = -vz / Math.max(inducedVelocity, 0.1);
  if (r < 0.5) return 1;
  if (r > 2.0) return 1; // 十分速い降下では風車ブレーキ状態に抜ける
  // r = 1 付近で最大 25% の推力損失 + 不安定化
  const x = (r - 1.25) / 0.75;
  return 1 - 0.25 * Math.max(0, 1 - x * x);
}

/** ホバリング誘導速度 v_i = sqrt(T / (2 rho A)) */
export function inducedVelocity(thrust, rotorRadius, rho) {
  const A = Math.PI * rotorRadius * rotorRadius;
  return Math.sqrt(Math.max(thrust, 0) / (2 * rho * A) + 1e-9);
}

/** 並進揚力: 前進速度により誘導速度が減り推力がわずかに増える */
export function translationalLift(vHoriz, vi, enabled = true) {
  if (!enabled) return 1;
  const mu = vHoriz / Math.max(vi, 0.1);
  return 1 + 0.06 * clamp(mu, 0, 3);
}

/**
 * 室内気流モデル。
 * 空調吹き出し口からの定常流 + Ornstein-Uhlenbeck 過程による乱流。
 */
export class WindField {
  constructor(cfg, seed = 7) {
    this.cfg = cfg;
    this.rng = makeRng(seed);
    this.turb = v3(0, 0, 0);
    this.t = 0;
  }

  reset() {
    this.turb = v3(0, 0, 0);
    this.t = 0;
  }

  /**
   * @param {number} dt
   * @param {{x,y,z}} pos ワールド座標の機体位置
   * @param {number} altitudeAgl 床からの高さ
   * @returns {{x,y,z}} ワールド座標の風速 [m/s]
   */
  sample(dt, pos, altitudeAgl) {
    const c = this.cfg;
    this.t += dt;
    if (!c.enabled) return v3(0, 0, 0);

    // --- 乱流 (OU 過程) ---
    const tau = Math.max(c.turbulenceTimeConstant, 1e-3);
    const sigma = c.turbulence;
    const a = Math.exp(-dt / tau);
    const b = sigma * Math.sqrt(1 - a * a);
    this.turb = v3(
      this.turb.x * a + b * this.rng.normal(),
      this.turb.y * a * 0.6 + b * 0.5 * this.rng.normal(),
      this.turb.z * a + b * this.rng.normal(),
    );

    // --- 定常流 (方位角と強さ) ---
    const dir = c.direction * Math.PI / 180;
    let steady = v3(Math.sin(dir) * c.speed, 0, -Math.cos(dir) * c.speed);

    // --- 空調吹き出し口 (点源) ---
    if (c.vents) {
      for (const vent of c.vents) {
        const d = vsub(pos, vent.position);
        const dist = vlen(d);
        const g = Math.exp(-(dist * dist) / (2 * vent.radius * vent.radius));
        steady = vadd(steady, vmul(vent.direction, vent.speed * g));
      }
    }

    // --- 地面付近の境界層 (床に近いと風が弱まる) ---
    const bl = clamp(altitudeAgl / Math.max(c.boundaryLayer, 1e-3), 0.15, 1);

    return vadd(vmul(steady, bl), this.turb);
  }
}

/**
 * 機体抗力 (機体座標)。3 軸それぞれに投影面積と Cd を持つ。
 * @param {{x,y,z}} vBody 対気速度 (機体座標)
 */
export function bodyDrag(vBody, cfg, rho) {
  const q = 0.5 * rho;
  const sx = Math.sign(vBody.x), sy = Math.sign(vBody.y), sz = Math.sign(vBody.z);
  return v3(
    -sx * q * cfg.cdX * cfg.areaX * vBody.x * vBody.x,
    -sy * q * cfg.cdY * cfg.areaY * vBody.y * vBody.y,
    -sz * q * cfg.cdZ * cfg.areaZ * vBody.z * vBody.z,
  );
}

/**
 * ロータ抗力 (H-force)。水平方向の対気速度に比例した抗力を発生する。
 * ブレードフラッピングによるモーメントも近似的に含める。
 */
export function rotorDrag(vBody, totalRotorSpeed, kh) {
  const f = -kh * totalRotorSpeed;
  return v3(f * vBody.x, 0, f * vBody.z);
}

/**
 * 壁効果。近接する壁面から受ける横方向の力 (吸い込み) を返す。
 * @param {Array<{normal:{x,y,z}, distance:number}>} walls 壁の法線と距離
 */
export function wallEffect(walls, thrust, rotorRadius, enabled = true, gain = 0.06) {
  let f = v3(0, 0, 0);
  if (!enabled) return f;
  for (const w of walls) {
    const d = w.distance;
    if (d > 3 * rotorRadius) continue;
    const k = gain * Math.exp(-(d - rotorRadius) / Math.max(rotorRadius, 1e-3));
    // 壁に向かって引き寄せられる (法線は壁から機体向き)
    f = vadd(f, vmul(w.normal, -k * thrust));
  }
  return f;
}
