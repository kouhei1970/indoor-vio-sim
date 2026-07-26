/**
 * コントロールアロケーション (ミキサ)。
 *
 * 制御入力 u = [F, Mx, My, Mz]
 *   F  : 機体上方 (+y_b) の合計推力 [N]
 *   Mx : ピッチトルク (+x_b 軸まわり, 機首上げ正) [Nm]
 *   My : ヨートルク   (+y_b 軸まわり, 左旋回正)   [Nm]
 *   Mz : -ロールトルク(+z_b 軸まわり)。ロール正 = 右下げ は -Mz。
 *
 * 配置行列 A は「ロータの位置・推力軸・回転方向」から自動生成されるので、
 * クアッド/ヘキサ/オクタ/X8/任意配置のいずれでも同じコードで動く。
 */

import { pinv, matvec, vcross, vdot, clamp, v3 } from './math.js';

/**
 * 配置行列 A (4 x n) を作る。thrusts t (各ロータ推力[N]) に対し u = A t。
 * @param {Array} rotors resolveLayout() の出力
 * @param {number} kQoverKT 反トルク係数比 Q/T [m]
 */
export function allocationMatrix(rotors, kQoverKT) {
  const rows = [[], [], [], []];
  for (const r of rotors) {
    const a = r.axis;
    const m = vcross(r.position, a);          // 推力による位置トルク
    const drag = -r.spin * kQoverKT;          // 反トルク (推力 1N あたり)
    rows[0].push(a.y * r.efficiency);
    rows[1].push((m.x + drag * a.x) * r.efficiency);
    rows[2].push((m.y + drag * a.y) * r.efficiency);
    rows[3].push((m.z + drag * a.z) * r.efficiency);
  }
  return rows;
}

/** ヨー要求を段階的に諦めるときの縮小率 */
const YAW_FALLBACK = [1, 0.5, 0.2, 0];

export class Mixer {
  /**
   * @param {Array} rotors
   * @param {number} kQoverKT
   * @param {number} tMax ロータ 1 基あたりの最大推力 [N]
   */
  constructor(rotors, kQoverKT, tMax, options = {}) {
    this.rotors = rotors;
    this.kQoverKT = kQoverKT;
    this.tMax = tMax;
    this.tMin = options.tMin ?? 0;
    this.airmode = options.airmode ?? true;
    // airmode で持ち上げてよい共通推力の上限 (tMax に対する割合)。
    // 大きすぎると姿勢維持のために意図しない上昇をしてしまう。
    this.airmodeBoost = options.airmodeBoost ?? 0.35;
    // 重み付き最小二乗の重み [F, Mx(ピッチ), My(ヨー), Mz(ロール)]。
    // ロータ故障などで全要求を満たせないとき、ヨーを優先的に諦める。
    this.weights = options.weights ?? [1, 1, 0.02, 1];
    this.failed = new Set();
    this.tailRotor = rotors.find((r) => r.tiltable) || null;
    this.servoAngle = 0;
    this.servoLimit = options.servoLimit ?? 0.6; // rad
    this.saturated = false;
    this.rebuildAllocation();
  }

  /** 配置行列と疑似逆行列を作り直す (故障設定の変更後に呼ぶ) */
  rebuildAllocation() {
    this.A = allocationMatrix(this.rotors, this.kQoverKT);
    const A = this.A.map((row) => row.slice());
    for (const i of this.failed) {
      for (let r = 0; r < 4; r++) A[r][i] = 0;   // 故障ロータは寄与しない
    }
    const W = this.weights;
    const WA = A.map((row, r) => row.map((v) => v * W[r]));
    this.Ainv = pinv(WA);                        // n x 4
  }

  /** ロータ故障を設定する。残ったロータだけで最適配分し直す。 */
  setFailed(index, failed) {
    if (failed) this.failed.add(index); else this.failed.delete(index);
    this.rebuildAllocation();
  }

  /** ロータ推力 → 力・トルク (機体座標) */
  wrench(thrusts) {
    let F = v3(0, 0, 0);
    let M = v3(0, 0, 0);
    this.rotors.forEach((r, i) => {
      const t = thrusts[i] * r.efficiency;
      const f = { x: r.axis.x * t, y: r.axis.y * t, z: r.axis.z * t };
      F = { x: F.x + f.x, y: F.y + f.y, z: F.z + f.z };
      const m = vcross(r.position, f);
      const q = -r.spin * this.kQoverKT * t;
      M = { x: M.x + m.x + q * r.axis.x, y: M.y + m.y + q * r.axis.y, z: M.z + m.z + q * r.axis.z };
    });
    return { force: F, torque: M };
  }

  /**
   * u = [F, Mx, My, Mz] からロータ推力配分を求める。
   *
   * 「再配分疑似逆行列法 (redistributed pseudo-inverse)」を使う:
   *   1. 生きているロータで重み付き最小二乗解を求める
   *   2. 上下限を超えたロータをその値で固定し、要求から寄与分を差し引く
   *   3. 残りのロータで解き直す (飽和が無くなるまで繰り返す)
   *
   * こうすると 1 基が飽和・故障しても、残りのロータで可能な限り
   * 要求トルクを実現できる。単純なクリップに比べて姿勢が崩れにくい。
   *
   * @returns {number[]} thrusts [N]
   */
  allocate(u) {
    // --- トライコプター: 3 基 + テールサーボ ---
    if (this.tailRotor) return this.allocateTri(u);

    let best = this.solve(u);
    this.saturated = best.clipped;
    const tol = this.torqueTolerance(u);
    if (!this.airmode || best.error <= tol) return best.thrusts;

    // --- airmode ---
    // 姿勢トルクが作れないのは「共通推力の位置が悪い」ことが原因なので、
    // 合計推力を上下にずらして姿勢トルクを実現できる点を二分探索で探す。
    // ずらす量は airmodeBoost で制限し、意図しない上昇/降下を防ぐ。
    const n = this.rotors.length;
    const bMax = this.tMax * this.airmodeBoost * n;
    const dir = best.low ? 1 : -1;
    let lo = 0, hi = bMax;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      const r = this.solve([u[0] + dir * mid, u[1], u[2], u[3]]);
      if (r.error < best.error) best = r;
      if (r.error <= tol) hi = mid; else lo = mid;
    }
    this.saturated = true;
    return best.thrusts;
  }

  /** 姿勢トルク誤差の許容量 (最大トルクの 2%) */
  torqueTolerance(u) {
    const tq = this.maxTorque();
    return 0.02 * (Math.abs(tq.x) + Math.abs(tq.z)) + 1e-6 * (1 + Math.abs(u[0]));
  }

  /**
   * 再配分疑似逆行列法で 1 回解く。
   * @returns {{thrusts:number[], error:number, clipped:boolean, low:boolean}}
   *   error: ロール/ピッチトルクの未達量、low: 下限側で詰まったか
   */
  solve(u) {
    const n = this.rotors.length;
    const W = this.weights;
    const A = this.A;
    const t = new Array(n).fill(0);
    const fixed = new Array(n).fill(false);
    for (const i of this.failed) { fixed[i] = true; t[i] = 0; }
    let clipped = false;
    let low = false;

    for (let iter = 0; iter <= n; iter++) {
      const free = [];
      for (let i = 0; i < n; i++) if (!fixed[i]) free.push(i);
      if (free.length === 0) break;

      // まず 4 自由度すべてを満たす解を試し、実現できなければ
      // ヨー要求を段階的に下げていく。屋内飛行では機首方位より
      // 姿勢・高度を保つほうが重要なので、ヨーから先に諦める。
      let x = null, worst = -1, worstErr = 0, worstVal = 0, worstLow = false;
      for (const yawScale of YAW_FALLBACK) {
        const rows = yawScale > 0 ? [0, 1, 2, 3] : [0, 1, 3];
        // 固定済みロータの寄与を要求から差し引く
        const res = rows.map((r) => {
          let s = r === 2 ? u[r] * yawScale : u[r];
          for (let i = 0; i < n; i++) if (fixed[i]) s -= A[r][i] * t[i];
          return s * W[r];
        });
        const useCache = iter === 0 && this.failed.size === 0 && yawScale === 1;
        const Af = rows.map((r) => free.map((j) => A[r][j] * W[r]));
        const inv = useCache ? this.Ainv : pinv(Af);
        x = matvec(inv, res);

        // 上下限を超えたロータを探す
        worst = -1; worstErr = 1e-9;
        for (let k = 0; k < free.length; k++) {
          if (x[k] < this.tMin - 1e-9 && this.tMin - x[k] > worstErr) {
            worst = free[k]; worstErr = this.tMin - x[k]; worstVal = this.tMin; worstLow = true;
          } else if (x[k] > this.tMax + 1e-9 && x[k] - this.tMax > worstErr) {
            worst = free[k]; worstErr = x[k] - this.tMax; worstVal = this.tMax; worstLow = false;
          }
        }
        if (worst < 0) break;         // 実現可能な解が見つかった
      }
      if (worst < 0) {
        free.forEach((j, k) => { t[j] = x[k]; });
        break;
      }
      clipped = true;
      low = worstLow;
      fixed[worst] = true;
      t[worst] = worstVal;
      free.forEach((j, k) => { if (!fixed[j]) t[j] = clamp(x[k], this.tMin, this.tMax); });
    }

    for (let i = 0; i < n; i++) {
      t[i] = this.failed.has(i) ? 0 : clamp(t[i], this.tMin, this.tMax);
    }
    // ロール/ピッチトルクの未達量を評価 (ヨーと推力は優先度が低い)
    const w = this.wrench(t);
    const error = Math.abs(w.torque.x - u[1]) + Math.abs(w.torque.z - u[3]);
    return { thrusts: t, error, clipped, low };
  }

  /**
   * トライコプター用: ロール/ピッチ/推力を 3 基で、ヨーをテールサーボで作る。
   *
   * 3 基のロータでは反トルクが打ち消せない (回転方向の合計が 0 にならない) ので、
   * テールロータを角度 α だけ傾け、その水平成分でヨートルクを作る。
   *   位置 r のロータをアームに直交する向きへ傾けたとき
   *   M_y = (r × f)_y = -T sinα L
   * したがって「残った反トルク + 指令ヨートルク」を打ち消す α を求める。
   */
  allocateTri(u) {
    const rotors = this.rotors;
    const A3 = [[], [], []];
    for (const r of rotors) {
      const m = vcross(r.position, v3(0, 1, 0));
      A3[0].push(1);
      A3[1].push(m.x);
      A3[2].push(m.z);
    }
    const inv = pinv(A3);
    let t = matvec(inv, [u[0], u[1], u[3]]);
    t = t.map((v) => clamp(v, this.tMin, this.tMax));

    // 3 基の反トルク合計 (ヨー軸まわり)
    let reaction = 0;
    rotors.forEach((r, i) => { reaction += -r.spin * this.kQoverKT * t[i] * r.efficiency; });

    const tail = this.tailRotor;
    const tT = t[rotors.indexOf(tail)];
    const L = Math.hypot(tail.position.x, tail.position.z);
    const need = u[2] - reaction;              // テールで作るべきヨートルク
    const denom = Math.max(tT * L, 1e-6);
    this.servoAngle = clamp(Math.asin(clamp(-need / denom, -1, 1)), -this.servoLimit, this.servoLimit);

    // 推力軸を更新 (アームに直交する水平方向へ傾ける)
    const ux = -tail.position.z / (L || 1), uz = tail.position.x / (L || 1);
    const s = Math.sin(this.servoAngle), c = Math.cos(this.servoAngle);
    tail.axis = v3(ux * s, c, uz * s);
    // 傾けた分だけ垂直成分が減るので推力指令を補正
    t[rotors.indexOf(tail)] = clamp(tT / Math.max(c, 0.3), this.tMin, this.tMax);
    this.A = allocationMatrix(rotors, this.kQoverKT);
    this.saturated = false;
    return t;
  }

  /**
   * 各軸に発生させられるトルクの目安 [Nm]。
   * 全ロータを最大にすると (対称機では) トルクは打ち消し合うので、
   * 「半数を最大・半数を最小にしたときの差分」を制御余力とみなす。
   * @returns {{x:number, y:number, z:number, thrust:number}}
   */
  maxTorque() {
    const half = this.tMax / 2;
    const sumAbs = (row) => row.reduce((s, v, i) => s + (this.failed.has(i) ? 0 : Math.abs(v)), 0);
    return {
      x: sumAbs(this.A[1]) * half,
      y: sumAbs(this.A[2]) * half,
      z: sumAbs(this.A[3]) * half,
      thrust: this.A[0].reduce((s, v, i) => s + (this.failed.has(i) ? 0 : v), 0) * this.tMax,
    };
  }

  /** 実効的な制御効き具合 (デバッグ表示用) */
  authority() {
    const t = new Array(this.rotors.length).fill(this.tMax);
    const w = this.wrench(t);
    return { maxThrust: w.force.y, torque: w.torque, vdot: vdot(w.force, v3(0, 1, 0)) };
  }
}
