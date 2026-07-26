/**
 * モータ・ESC・バッテリのモデル。
 *
 *  - ESC の指令 → 目標回転数 (電圧サグを反映)
 *  - モータの一次遅れ (加速側/減速側で時定数が異なる)
 *  - 個体差 (推力係数・時定数のばらつき) — ロバスト性評価に使える
 *  - バッテリ: SOC 曲線 + 内部抵抗による電圧降下、消費電力積算
 */

import { clamp, makeRng } from './math.js';

/** リポバッテリの開放電圧曲線 (セルあたり, SOC 1→0) */
function cellOcv(soc) {
  const s = clamp(soc, 0, 1);
  // 4.2V(満充電) → 3.85V(中間) → 3.5V(残量僅か) → 3.2V(空)
  const pts = [
    [0.0, 3.30], [0.05, 3.50], [0.15, 3.65], [0.3, 3.75],
    [0.5, 3.83], [0.7, 3.93], [0.85, 4.05], [1.0, 4.20],
  ];
  for (let i = 1; i < pts.length; i++) {
    if (s <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const t = (s - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return 4.2;
}

export class MotorSystem {
  /**
   * @param {number} n ロータ本数
   * @param {object} cfg power セクション設定
   * @param {{kT:number,kQ:number,nMax:number}} coef ロータ係数
   */
  constructor(n, cfg, coef, seed = 4242) {
    this.n = n;
    this.cfg = cfg;
    this.coef = coef;
    const rng = makeRng(seed);
    // 個体差 (±variation)
    const v = cfg.motorVariation ?? 0;
    this.kScale = Array.from({ length: n }, () => 1 + v * rng.normal());
    this.tauScale = Array.from({ length: n }, () => 1 + v * rng.normal());
    this.speeds = new Array(n).fill(0);      // 回転数 [rev/s]
    this.commands = new Array(n).fill(0);    // 指令 [0..1]
    this.failed = new Array(n).fill(false);  // 故障注入
    this.soc = clamp(cfg.initialSoc ?? 1, 0, 1);
    this.voltage = cellOcv(this.soc) * cfg.cells;
    this.current = 0;
    this.energyWh = 0;
  }

  reset() {
    this.speeds.fill(0);
    this.commands.fill(0);
    this.soc = clamp(this.cfg.initialSoc ?? 1, 0, 1);
    this.voltage = cellOcv(this.soc) * this.cfg.cells;
    this.current = 0;
    this.energyWh = 0;
    this.failed.fill(false);
  }

  /** 現在の電圧で到達できる最大回転数 [rev/s] */
  maxSpeed() {
    const rpm = this.cfg.kv * this.voltage * (this.cfg.motorEfficiency ?? 0.85);
    return rpm / 60;
  }

  /** ロータ 1 基あたりの最大推力 [N] (ミキサの飽和判定に使う) */
  maxThrust() {
    const n = this.maxSpeed();
    return this.coef.kT * n * n;
  }

  /**
   * 1 ステップ進める。
   * @param {number} dt
   * @param {number[]} thrustCmd 各ロータへの推力指令 [N]
   * @returns {{thrusts:number[], torques:number[], speeds:number[]}}
   */
  step(dt, thrustCmd) {
    const { kT, kQ } = this.coef;
    const nMax = this.maxSpeed();
    const thrusts = new Array(this.n);
    const torques = new Array(this.n);
    let mechPower = 0;

    for (let i = 0; i < this.n; i++) {
      // 推力指令 → 目標回転数
      let target = Math.sqrt(Math.max(thrustCmd[i], 0) / Math.max(kT, 1e-12));
      if (this.failed[i]) target = 0;
      target = clamp(target, 0, nMax);
      this.commands[i] = nMax > 0 ? target / nMax : 0;

      // 一次遅れ (加速と減速で時定数が異なる)
      const rising = target > this.speeds[i];
      const tau = Math.max(1e-4,
        (rising ? this.cfg.tauUp : this.cfg.tauDown) * this.tauScale[i]);
      const a = 1 - Math.exp(-dt / tau);
      this.speeds[i] += (target - this.speeds[i]) * a;

      const nn = this.speeds[i] * this.speeds[i];
      thrusts[i] = kT * nn * this.kScale[i];
      torques[i] = kQ * nn * this.kScale[i];
      mechPower += torques[i] * 2 * Math.PI * this.speeds[i];
    }

    // --- バッテリ ---
    const eff = this.cfg.systemEfficiency ?? 0.7;
    const elecPower = mechPower / eff + (this.cfg.avionicsPower ?? 2.0);
    const ocv = cellOcv(this.soc) * this.cfg.cells;
    const R = (this.cfg.internalResistance ?? 0.03) * this.cfg.cells;
    // P = V*I,  V = OCV - I*R  →  I を二次方程式で解く
    const disc = ocv * ocv - 4 * R * elecPower;
    this.current = disc > 0 ? (ocv - Math.sqrt(disc)) / (2 * R) : ocv / (2 * R);
    this.voltage = Math.max(ocv - this.current * R, this.cfg.cells * 2.8);
    const wh = (this.voltage * this.current * dt) / 3600;
    this.energyWh += wh;
    const capWh = (this.cfg.capacityMah / 1000) * this.cfg.cells * 3.85;
    if (capWh > 0) this.soc = clamp(this.soc - wh / capWh, 0, 1);

    return { thrusts, torques, speeds: this.speeds };
  }

  /** モータ故障を注入する (index, true/false) */
  setFailure(index, failed) {
    if (index >= 0 && index < this.n) this.failed[index] = failed;
  }
}
