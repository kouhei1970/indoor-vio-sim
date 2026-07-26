/**
 * モータ・ESC・バッテリのモデル。
 *
 *  - ESC の指令 → 目標回転数 (電圧サグを反映)
 *  - モータの一次遅れ (加速側/減速側で時定数が異なる)
 *  - 個体差 (推力係数・時定数のばらつき) — ロバスト性評価に使える
 *  - バッテリ: SOC 曲線 + 内部抵抗による電圧降下、消費電力積算
 */

import { clamp, makeRng } from './math.js';

/** 標準リポ (満充電 4.20V) の開放電圧曲線 (セルあたり, SOC 1→0) */
const LIPO_OCV = [
  [0.0, 3.30], [0.05, 3.50], [0.15, 3.65], [0.3, 3.75],
  [0.5, 3.83], [0.7, 3.93], [0.85, 4.05], [1.0, 4.20],
];

/** 標準リポの満充電電圧 [V/cell] — 曲線の基準 */
export const LIPO_FULL = 4.20;

/** 使い切ってから電圧が落ちきるまでの超過放電量 (容量比)。3% ≒ 十数秒 */
const OVERDRAW_COLLAPSE = 0.03;

/**
 * バッテリの開放電圧 (セルあたり)。
 * Open-circuit voltage of one cell.
 *
 * 標準リポは満充電 4.20V だが、高電圧型 (LiHV / HV リポ。StampFly の
 * 純正電池がこれ) は 4.35V まで充電できる。差の 0.15V は満充電側で最も
 * 大きく、空に近づくと両者はほぼ同じ電圧へ収束する。実測の HV セル曲線に
 * 合わせて、重み √soc で持ち上げる。
 *
 * @param {number} soc 残量 0..1
 * @param {number} full 満充電電圧 [V/cell] (標準リポ 4.20 / LiHV 4.35)
 */
export function cellOcv(soc, full = LIPO_FULL) {
  const s = clamp(soc, 0, 1);
  let base = LIPO_OCV[LIPO_OCV.length - 1][1];
  for (let i = 1; i < LIPO_OCV.length; i++) {
    if (s <= LIPO_OCV[i][0]) {
      const [x0, y0] = LIPO_OCV[i - 1], [x1, y1] = LIPO_OCV[i];
      base = y0 + (y1 - y0) * ((s - x0) / (x1 - x0));
      break;
    }
  }
  return base + (full - LIPO_FULL) * Math.sqrt(s);
}

/** 放電中の平均開放電圧 [V/cell] — 容量 [mAh] を電力量 [Wh] へ換算するときに使う */
export function cellMeanOcv(full = LIPO_FULL) {
  const n = 200;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += cellOcv((i + 0.5) / n, full);
  return sum / n;
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
    // 満充電電圧 [V/cell]。標準リポ 4.20 / 高電圧型 (LiHV) 4.35
    this.cellFull = cfg.cellFull ?? LIPO_FULL;
    this.soc = clamp(cfg.initialSoc ?? 1, 0, 1);
    this.overdraw = 0;   // 使い切った後に更に引き出した量 (容量比)
    this.voltage = cellOcv(this.soc, this.cellFull) * cfg.cells;
    this.current = 0;
    this.energyWh = 0;
  }

  reset() {
    this.speeds.fill(0);
    this.commands.fill(0);
    this.cellFull = this.cfg.cellFull ?? LIPO_FULL;
    this.soc = clamp(this.cfg.initialSoc ?? 1, 0, 1);
    this.overdraw = 0;
    this.voltage = cellOcv(this.soc, this.cellFull) * this.cfg.cells;
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
    // 使い切った後 (SOC 0) は、膝 (knee) を過ぎて電圧が一気に落ちる。これを
    // 入れないと、残量ゼロのまま永久に飛べてしまう。
    const collapse = Math.max(0, 1 - this.overdraw / OVERDRAW_COLLAPSE);
    const ocv = cellOcv(this.soc, this.cellFull) * this.cfg.cells * collapse;
    const R = (this.cfg.internalResistance ?? 0.03) * this.cfg.cells;
    // P = V*I,  V = OCV - I*R  →  I を二次方程式で解く
    const disc = ocv * ocv - 4 * R * elecPower;
    this.current = disc > 0 ? (ocv - Math.sqrt(disc)) / (2 * R) : ocv / (2 * R);
    this.voltage = Math.max(ocv - this.current * R, 0);
    this.energyWh += (this.voltage * this.current * dt) / 3600;
    // 残量は電荷 [Ah] で数える (クーロンカウント)。電池の定格 mAh は電荷なので、
    // 同じ電力でも電圧が高いほど電流が減り、その分だけ長く飛べる — 高電圧型
    // (4.35V) が有利になる理由がそのまま出る。
    const capAh = this.cfg.capacityMah / 1000;
    if (capAh > 0) {
      const drain = (this.current * dt) / 3600 / capAh;
      if (this.soc > 0) this.soc = clamp(this.soc - drain, 0, 1);
      else this.overdraw = Math.min(1, this.overdraw + drain);
    }

    return { thrusts, torques, speeds: this.speeds };
  }

  /** モータ故障を注入する (index, true/false) */
  setFailure(index, failed) {
    if (index >= 0 && index < this.n) this.failed[index] = failed;
  }
}
