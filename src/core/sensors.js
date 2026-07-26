/**
 * センサモデル。自己位置推定の研究では「画像 + IMU」の同期データが要になるため、
 * IMU は VIO でよく使われるモデル (白色雑音 + バイアスランダムウォーク) を実装する。
 *
 *   ジャイロ  : ω_meas = S ω + b_g + n_g,     ḃ_g = n_bg
 *   加速度計  : a_meas = S (R^T(a_w + g)) + b_a + n_a,  ḃ_a = n_ba
 *
 * ノイズ密度は EuRoC / ADIS などのデータシートに合わせて設定できる。
 */

import {
  v3, vadd, vmul, qrot, qrotInv, qToEuler, makeRng, clamp,
} from './math.js';
import { G } from './dynamics.js';

export class Imu {
  constructor(cfg, seed = 1234) {
    this.cfg = cfg;
    this.rng = makeRng(seed);
    this.reset();
  }

  reset() {
    const c = this.cfg;
    const r = this.rng;
    this.biasGyro = vmul(r.normal3(), c.gyroBiasInit);
    this.biasAccel = vmul(r.normal3(), c.accelBiasInit);
    this.lastMeas = null;
    this.accum = 0;
  }

  /**
   * @param {number} dt
   * @param {object} state
   * @param {{x,y,z}} accelWorld 慣性加速度 (重力を含まない実加速度)
   */
  sample(dt, state, accelWorld) {
    const c = this.cfg;
    const r = this.rng;
    // バイアスランダムウォーク
    const sq = Math.sqrt(Math.max(dt, 1e-9));
    this.biasGyro = vadd(this.biasGyro, vmul(r.normal3(), c.gyroRandomWalk * sq));
    this.biasAccel = vadd(this.biasAccel, vmul(r.normal3(), c.accelRandomWalk * sq));

    // 比力 (specific force) = R^T (a_world + g)
    const f = qrotInv(state.q, v3(accelWorld.x, accelWorld.y + G, accelWorld.z));
    const nAccel = c.accelNoiseDensity / sq;
    const nGyro = c.gyroNoiseDensity / sq;

    const accel = v3(
      f.x * c.accelScale + this.biasAccel.x + r.normal() * nAccel,
      f.y * c.accelScale + this.biasAccel.y + r.normal() * nAccel,
      f.z * c.accelScale + this.biasAccel.z + r.normal() * nAccel,
    );
    const gyro = v3(
      state.omega.x * c.gyroScale + this.biasGyro.x + r.normal() * nGyro,
      state.omega.y * c.gyroScale + this.biasGyro.y + r.normal() * nGyro,
      state.omega.z * c.gyroScale + this.biasGyro.z + r.normal() * nGyro,
    );
    // レンジ飽和
    const sat = (v, lim) => v3(clamp(v.x, -lim, lim), clamp(v.y, -lim, lim), clamp(v.z, -lim, lim));
    this.lastMeas = {
      accel: sat(accel, c.accelRange * G),
      gyro: sat(gyro, c.gyroRange),
      biasGyro: { ...this.biasGyro },
      biasAccel: { ...this.biasAccel },
    };
    return this.lastMeas;
  }
}

export class Barometer {
  constructor(cfg, seed = 555) {
    this.cfg = cfg; this.rng = makeRng(seed); this.drift = 0; this.value = 0;
  }
  sample(dt, altitude) {
    const c = this.cfg;
    this.drift += (this.rng.normal() * c.driftRate - this.drift * 0.02) * dt;
    this.value = altitude + this.drift + this.rng.normal() * c.noise;
    return this.value;
  }
}

/** 下向き ToF 測距センサ (VL53L1X 等を想定) */
export class Rangefinder {
  constructor(cfg, seed = 777) { this.cfg = cfg; this.rng = makeRng(seed); this.value = 0; this.valid = false; }
  sample(world, state) {
    const c = this.cfg;
    const dir = qrot(state.q, v3(0, -1, 0));
    const hit = world.raycast(state.p, dir, c.maxRange);
    const noise = this.rng.normal() * c.noise;
    this.valid = hit.hit && hit.distance <= c.maxRange;
    this.value = this.valid ? Math.max(0, hit.distance + noise) : c.maxRange;
    return { distance: this.value, valid: this.valid };
  }
}

/** オプティカルフローセンサ (PMW3901 等)。高さとテクスチャ品質に依存する。 */
export class OpticalFlow {
  constructor(cfg, seed = 999) { this.cfg = cfg; this.rng = makeRng(seed); }
  sample(state, height, textureQuality = 1) {
    const c = this.cfg;
    const vBody = qrotInv(state.q, state.v);
    // 画素流量 = 速度/高度 - 角速度
    const h = Math.max(height, 0.05);
    const flowX = vBody.x / h - state.omega.z * 0;
    const flowZ = vBody.z / h;
    const q = clamp(textureQuality * clamp(2.5 / h, 0.2, 1), 0, 1);
    const n = c.noise / Math.max(q, 0.05);
    return {
      flow: v3(flowX + this.rng.normal() * n, 0, flowZ + this.rng.normal() * n),
      quality: q,
      velocity: v3((flowX + this.rng.normal() * n) * h, 0, (flowZ + this.rng.normal() * n) * h),
    };
  }
}

/** 磁気センサ (屋内は鉄骨などで乱れる) */
export class Magnetometer {
  constructor(cfg, seed = 321) { this.cfg = cfg; this.rng = makeRng(seed); }
  sample(state, pos) {
    const c = this.cfg;
    const yaw = qToEuler(state.q).yaw;
    // 位置に依存した緩やかな磁気外乱
    const dist = c.disturbance * Math.sin(pos.x * 1.7) * Math.cos(pos.z * 1.3);
    return { heading: yaw + dist + this.rng.normal() * c.noise };
  }
}

/**
 * センサ一式をまとめて管理する。
 * サンプリング周波数ごとにダウンサンプルし、タイムスタンプ付きで出力する。
 */
export class SensorSuite {
  constructor(cfg, seed = 20240101) {
    this.cfg = cfg;
    this.imu = new Imu(cfg.imu, seed);
    this.baro = new Barometer(cfg.barometer, seed + 1);
    this.range = new Rangefinder(cfg.rangefinder, seed + 2);
    this.flow = new OpticalFlow(cfg.opticalFlow, seed + 3);
    this.mag = new Magnetometer(cfg.magnetometer, seed + 4);
    this.imuLog = [];
    this.tImu = 0;
    this.tSlow = 0;
    this.latest = {};
  }

  reset() {
    this.imu.reset();
    this.imuLog.length = 0;
    this.tImu = 0; this.tSlow = 0;
  }

  /**
   * @param {number} dt シミュレーションステップ
   * @param {number} time シミュレーション時刻
   */
  update(dt, time, state, accelWorld, world, textureQuality) {
    const c = this.cfg;
    this.tImu += dt;
    const imuPeriod = 1 / c.imu.rate;
    let imuOut = null;
    while (this.tImu >= imuPeriod) {
      this.tImu -= imuPeriod;
      imuOut = this.imu.sample(imuPeriod, state, accelWorld);
      imuOut.t = time - this.tImu;
      if (c.logImu) {
        this.imuLog.push([imuOut.t, imuOut.gyro.x, imuOut.gyro.y, imuOut.gyro.z,
          imuOut.accel.x, imuOut.accel.y, imuOut.accel.z]);
        if (this.imuLog.length > c.imuLogLimit) this.imuLog.shift();
      }
    }

    this.tSlow += dt;
    const slowPeriod = 1 / c.slowRate;
    if (this.tSlow >= slowPeriod) {
      const d = this.tSlow;
      this.tSlow = 0;
      this.latest = {
        baro: this.baro.sample(d, state.p.y),
        range: this.range.sample(world, state),
        flow: this.flow.sample(state, world.heightAboveGround(state.p), textureQuality),
        mag: this.mag.sample(state, state.p),
        t: time,
      };
    }
    if (imuOut) this.latest.imu = imuOut;
    return this.latest;
  }
}

export const SENSOR_DEFAULTS = {
  imu: {
    rate: 200,
    gyroNoiseDensity: 0.00016,   // [rad/s/√Hz]  (EuRoC ADIS16448 相当)
    gyroRandomWalk: 0.000022,    // [rad/s²/√Hz]
    gyroBiasInit: 0.005,
    gyroScale: 1.0,
    gyroRange: 34.9,             // ±2000 dps
    accelNoiseDensity: 0.0020,   // [m/s²/√Hz]
    accelRandomWalk: 0.0003,     // [m/s³/√Hz]
    accelBiasInit: 0.02,
    accelScale: 1.0,
    accelRange: 16,              // ±16 g
  },
  barometer: { noise: 0.12, driftRate: 0.02 },
  rangefinder: { maxRange: 4.0, noise: 0.008 },
  opticalFlow: { noise: 0.02 },
  magnetometer: { noise: 0.02, disturbance: 0.15 },
  slowRate: 50,
  logImu: true,
  imuLogLimit: 200000,
};

/** ノイズを含む「推定状態」を作る (制御を真値ではなく推定値で回したい場合に使う) */
export function noisyState(state, rng, cfg) {
  return {
    p: vadd(state.p, vmul(rng.normal3(), cfg.posNoise)),
    v: vadd(state.v, vmul(rng.normal3(), cfg.velNoise)),
    q: state.q,
    omega: vadd(state.omega, vmul(rng.normal3(), cfg.gyroNoise)),
  };
}
