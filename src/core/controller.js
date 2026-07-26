/**
 * 飛行制御 (カスケード PID)。
 *
 *   位置 → 速度 → 加速度 → 目標姿勢/推力 → 角速度 → トルク
 *
 * フライトモード
 *   rate     : アクロ。スティック = 角速度指令
 *   angle    : スタビライズ。スティック = 姿勢角指令
 *   altitude : angle + 高度保持
 *   position : 位置・速度保持 (屋内のデータ収集向け)
 *   auto     : 軌道追従 (trajectory.js が生成する目標を追う)
 */

import {
  v3, vadd, vsub, vmul, vlen, vnorm, vclampLen, qrot, qrotInv, qToEuler, qFromEuler,
  qErrorVector, qFromAxisAngle, qmul, clamp, wrapPi, DEG,
} from './math.js';
import { G } from './dynamics.js';

export class PID {
  constructor(kp = 0, ki = 0, kd = 0, opts = {}) {
    this.set(kp, ki, kd, opts);
    this.reset();
  }

  set(kp, ki, kd, opts = {}) {
    this.kp = kp; this.ki = ki; this.kd = kd;
    this.iLimit = opts.iLimit ?? 1e9;
    this.outLimit = opts.outLimit ?? 1e9;
    this.dCutoff = opts.dCutoff ?? 30; // [Hz]
  }

  reset() { this.i = 0; this.dFiltered = 0; this.prevMeas = null; }

  /**
   * @param {number} err 目標 - 実測
   * @param {number} dt
   * @param {number} meas 実測値 (微分先行のため)
   * @param {number} ff フィードフォワード項
   */
  update(err, dt, meas = null, ff = 0) {
    let d = 0;
    if (meas !== null) {
      if (this.prevMeas !== null && dt > 0) d = -(meas - this.prevMeas) / dt;
      this.prevMeas = meas;
    }
    const a = dt > 0 ? 1 - Math.exp(-2 * Math.PI * this.dCutoff * dt) : 1;
    this.dFiltered += (d - this.dFiltered) * a;

    const pTerm = this.kp * err;
    const dTerm = this.kd * this.dFiltered;
    let out = pTerm + dTerm + this.i + ff;

    // 条件付き積分 (出力飽和時は積分を止める)
    if (Math.abs(out) < this.outLimit || err * out < 0) {
      this.i = clamp(this.i + this.ki * err * dt, -this.iLimit, this.iLimit);
      out = pTerm + dTerm + this.i + ff;
    }
    return clamp(out, -this.outLimit, this.outLimit);
  }
}

export class FlightController {
  constructor(cfg) {
    this.cfg = cfg;
    this.mode = cfg.defaultMode || 'position';
    this.buildPids();
    this.reset();
  }

  buildPids() {
    const c = this.cfg;
    const mk = (g, opts) => new PID(g.kp, g.ki, g.kd, opts);
    // torqueLimit / rateILimit は数値でも軸別オブジェクト {x,y,z} でもよい
    const perAxis = (v, k) => (typeof v === 'object' && v !== null ? v[k] : v);
    this.rate = {
      x: mk(c.ratePitch, { iLimit: perAxis(c.rateILimit, 'x'), outLimit: perAxis(c.torqueLimit, 'x'), dCutoff: c.dCutoff }),
      y: mk(c.rateYaw, { iLimit: perAxis(c.rateILimit, 'y'), outLimit: perAxis(c.torqueLimit, 'y'), dCutoff: c.dCutoff }),
      z: mk(c.rateRoll, { iLimit: perAxis(c.rateILimit, 'z'), outLimit: perAxis(c.torqueLimit, 'z'), dCutoff: c.dCutoff }),
    };
    this.vel = {
      x: mk(c.velXY, { iLimit: c.velILimit, outLimit: c.accelLimit }),
      y: mk(c.velZ, { iLimit: c.velZILimit, outLimit: c.accelLimitZ }),
      z: mk(c.velXY, { iLimit: c.velILimit, outLimit: c.accelLimit }),
    };
    this.posGain = c.posGain;
    this.attGain = c.attGain;
    this.yawGain = c.yawGain;
  }

  reset() {
    for (const k of ['x', 'y', 'z']) { this.rate[k].reset(); this.vel[k].reset(); }
    this.targetPos = null;
    this.targetYaw = null;
    this.hoverThrottleEst = 0.5;
    this.lastDesiredAcc = v3(0, 0, 0);
    this.armed = false;
  }

  setMode(mode, state) {
    if (mode === this.mode) return;
    this.mode = mode;
    for (const k of ['x', 'y', 'z']) { this.rate[k].reset(); this.vel[k].reset(); }
    if (state) {
      this.targetPos = { ...state.p };
      this.targetYaw = qToEuler(state.q).yaw;
    }
  }

  /**
   * 制御則を 1 ステップ実行し、制御入力 u = [F, Mx, My, Mz] を返す。
   * @param {object} state 機体状態 (真値もしくは推定値)
   * @param {object} cmd 操縦入力 {roll,pitch,yaw,throttle} または軌道目標
   * @param {number} dt
   * @param {{mass:number}} veh
   */
  update(state, cmd, dt, veh) {
    const c = this.cfg;
    const euler = qToEuler(state.q);
    let desiredRates = v3(0, 0, 0);
    let thrust = 0;

    if (this.mode === 'rate') {
      desiredRates = v3(
        cmd.pitch * c.maxRate,          // +x_b: 機首上げ
        cmd.yaw * c.maxYawRate,         // +y_b: 左旋回
        -cmd.roll * c.maxRate,          // +z_b: ロール正 = 右下げ = -z 回り
      );
      thrust = cmd.throttle * c.maxThrustN;
    } else {
      // --- 目標姿勢と推力を決める ---
      let desiredAcc;    // ワールド座標の目標加速度 (重力を除く)
      let yawRateCmd = cmd.yaw * c.maxYawRate;
      let yawTarget = null;

      if (this.mode === 'angle' || this.mode === 'altitude') {
        const rollDes = cmd.roll * c.maxTilt;
        const pitchDes = cmd.pitch * c.maxTilt;
        // 目標姿勢から必要な水平加速度を逆算
        const tiltAcc = v3(
          Math.tan(clamp(rollDes, -1.2, 1.2)) * G,
          0,
          -Math.tan(clamp(pitchDes, -1.2, 1.2)) * G,
        );
        // ヨー方向に回す
        const yaw = euler.yaw;
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        desiredAcc = v3(tiltAcc.x * cy + tiltAcc.z * sy, 0, -tiltAcc.x * sy + tiltAcc.z * cy);
        if (this.mode === 'altitude') {
          const vzDes = cmd.throttle * c.maxClimbRate;
          if (this.targetPos == null) this.targetPos = { ...state.p };
          if (Math.abs(cmd.throttle) > 0.02) this.targetPos.y = state.p.y;
          const vzTarget = Math.abs(cmd.throttle) > 0.02
            ? vzDes
            : clamp((this.targetPos.y - state.p.y) * this.posGain, -c.maxClimbRate, c.maxClimbRate);
          desiredAcc.y = this.vel.y.update(vzTarget - state.v.y, dt, state.v.y);
        } else {
          desiredAcc.y = (cmd.throttle * 2 - 1) * c.accelLimitZ;
        }
      } else {
        // position / auto
        let posTarget, velFF = v3(0, 0, 0), accFF = v3(0, 0, 0);
        if (this.mode === 'auto' && cmd.target) {
          posTarget = cmd.target.position;
          velFF = cmd.target.velocity || v3(0, 0, 0);
          accFF = cmd.target.acceleration || v3(0, 0, 0);
          if (cmd.target.yaw != null) yawTarget = cmd.target.yaw;
        } else {
          // スティック入力を速度指令として扱い、中立で位置を保持
          if (this.targetPos == null) this.targetPos = { ...state.p };
          const yaw = euler.yaw;
          const cy = Math.cos(yaw), sy = Math.sin(yaw);
          const bodyCmd = v3(cmd.roll * c.maxSpeedXY, cmd.throttle * c.maxClimbRate, -cmd.pitch * c.maxSpeedXY);
          const worldCmd = v3(bodyCmd.x * cy + bodyCmd.z * sy, bodyCmd.y, -bodyCmd.x * sy + bodyCmd.z * cy);
          const moving = vlen(worldCmd) > 1e-3;
          if (moving) {
            this.targetPos = vadd(state.p, vmul(vnorm(worldCmd), 0.15));
            velFF = worldCmd;
          }
          posTarget = this.targetPos;
          if (!moving) velFF = v3(0, 0, 0);
        }
        const posErr = vsub(posTarget, state.p);
        const velDes = vclampLen(
          vadd(vmul(v3(posErr.x, 0, posErr.z), this.posGain), v3(velFF.x, 0, velFF.z)),
          c.maxSpeedXY,
        );
        velDes.y = clamp(posErr.y * this.posGain + velFF.y, -c.maxClimbRate, c.maxClimbRate);
        desiredAcc = v3(
          this.vel.x.update(velDes.x - state.v.x, dt, state.v.x, accFF.x),
          this.vel.y.update(velDes.y - state.v.y, dt, state.v.y, accFF.y),
          this.vel.z.update(velDes.z - state.v.z, dt, state.v.z, accFF.z),
        );
      }

      this.lastDesiredAcc = desiredAcc;

      // --- 目標推力ベクトル (ワールド) → 姿勢と推力 ---
      const accTotal = v3(desiredAcc.x, desiredAcc.y + G, desiredAcc.z);
      const tiltLimit = Math.tan(c.maxTilt);
      const horiz = Math.hypot(accTotal.x, accTotal.z);
      const maxHoriz = Math.max(accTotal.y, 0.5) * tiltLimit;
      if (horiz > maxHoriz && horiz > 1e-6) {
        const k = maxHoriz / horiz;
        accTotal.x *= k; accTotal.z *= k;
      }
      const zBodyDes = vnorm(accTotal);             // 機体上方向の目標
      // 推力は「目標加速度を実際の機体上方向へ射影した成分」= m * (a・z_b)
      // こうすると姿勢が追従途中でも高度が暴れにくい。
      const zBody = qrot(state.q, v3(0, 1, 0));
      const proj = accTotal.x * zBody.x + accTotal.y * zBody.y + accTotal.z * zBody.z;
      thrust = veh.mass * Math.max(proj, 0);

      // ヨー目標
      if (yawTarget == null) {
        if (this.targetYaw == null) this.targetYaw = euler.yaw;
        if (Math.abs(yawRateCmd) > 1e-4) this.targetYaw = wrapPi(this.targetYaw + yawRateCmd * dt);
        yawTarget = this.targetYaw;
      } else {
        this.targetYaw = yawTarget;
      }

      // 目標姿勢クォータニオン: 上方向 zBodyDes + ヨー yawTarget
      const qDes = attitudeFromThrustAndYaw(zBodyDes, yawTarget);
      const errVec = qErrorVector(state.q, qDes);   // 機体座標の回転誤差
      desiredRates = v3(
        clamp(errVec.x * this.attGain, -c.maxRate, c.maxRate),
        clamp(errVec.y * this.yawGain, -c.maxYawRate, c.maxYawRate),
        clamp(errVec.z * this.attGain, -c.maxRate, c.maxRate),
      );
    }

    // --- 角速度ループ ---
    const torque = v3(
      this.rate.x.update(desiredRates.x - state.omega.x, dt, state.omega.x),
      this.rate.y.update(desiredRates.y - state.omega.y, dt, state.omega.y),
      this.rate.z.update(desiredRates.z - state.omega.z, dt, state.omega.z),
    );

    this.debug = { desiredRates, euler, thrust };
    return [clamp(thrust, 0, c.maxThrustN), torque.x, torque.y, torque.z];
  }
}

/**
 * 目標推力方向 (ワールドの機体上方向) とヨー角から目標姿勢を作る。
 */
export function attitudeFromThrustAndYaw(zDes, yaw) {
  // ヨーのみの姿勢
  const qYaw = qFromEuler(0, 0, yaw);
  const zYaw = qrot(qYaw, v3(0, 1, 0)); // = (0,1,0)
  // (0,1,0) から zDes への最短回転
  const dot = clamp(zYaw.x * zDes.x + zYaw.y * zDes.y + zYaw.z * zDes.z, -1, 1);
  let qTilt;
  if (dot > 0.999999) {
    qTilt = { x: 0, y: 0, z: 0, w: 1 };
  } else if (dot < -0.999999) {
    qTilt = { x: 1, y: 0, z: 0, w: 0 };
  } else {
    const axis = vnorm(v3(
      zYaw.y * zDes.z - zYaw.z * zDes.y,
      zYaw.z * zDes.x - zYaw.x * zDes.z,
      zYaw.x * zDes.y - zYaw.y * zDes.x,
    ));
    qTilt = qFromAxisAngle(axis, Math.acos(dot));
  }
  return qmul(qTilt, qYaw);
}

/**
 * 機体の物理パラメータから制御ゲインを自動算出する。
 *
 * 角速度ループの開ループ伝達関数は  L(s) = kp / (I s) * 1 / (1 + τ_m s)
 * (I: 慣性モーメント, τ_m: モータの時定数)。
 * 交差周波数を 1/T = 1/(3 τ_m) に置くと位相余裕は約 72deg 確保でき、
 * 機体の大小によらず同じ応答特性が得られる。
 *
 * これにより、ユーザがアーム長・質量・プロペラを変更しても
 * 制御ゲインを手で調整し直す必要がない。
 *
 * @param {number[]} inertia 慣性テンソル (列優先)
 * @param {number} tauMotor モータ時定数 [s]
 * @param {{torqueMax:{x,y,z}, thrustMax:number, scale:number}} limits
 */
export function autoTuneController(base, inertia, tauMotor, limits) {
  const scale = limits.scale ?? 1.0;      // >1 で機敏、<1 で穏やか
  const tau = Math.max(tauMotor, 5e-3);

  // --- 角速度ループ ---
  // kd = kp * τ_m とすることでモータの極を相殺でき、開ループは kp/(I s) になる。
  // 交差角周波数 ωc はモータ時定数から決める (未モデル化ダイナミクスへの余裕を残す)。
  const wRate = clamp((1 / (1.5 * tau)) * scale, 3, 120);
  const Ix = inertia[0], Iy = inertia[4], Iz = inertia[8];
  const axis = (I, w) => ({
    kp: I * w,
    ki: I * w * w / 4,     // 積分時間 = 4/ω
    kd: I * w * tau,       // モータ極の相殺
  });
  // ヨーは制御トルクが小さいので帯域を落とす
  const wYaw = wRate * 0.5;

  // --- 上位ループ (帯域を 1/3 ずつ落として干渉を避ける) ---
  const wAtt = wRate / 2.5;
  const wVel = wAtt / 2.5;
  const wPos = wVel / 2;
  // 高度は姿勢を介さず推力へ直結するので、水平より速くできる
  const wVelZ = clamp(wRate / 2.5, 1, 12);

  const tq = limits.torqueMax;
  const lim = { x: Math.max(tq.x * 0.5, 1e-5), y: Math.max(tq.y * 0.5, 1e-6), z: Math.max(tq.z * 0.5, 1e-5) };

  return {
    ...base,
    ratePitch: axis(Ix, wRate),
    rateRoll: axis(Iz, wRate),
    rateYaw: axis(Iy, wYaw),
    torqueLimit: lim,
    rateILimit: { x: lim.x * 0.5, y: lim.y * 0.5, z: lim.z * 0.5 },
    attGain: wAtt,
    yawGain: wYaw / 3,
    velXY: { kp: wVel, ki: wVel * wVel / 3, kd: 0 },
    velZ: { kp: wVelZ, ki: wVelZ * wVelZ / 3, kd: 0 },
    posGain: wPos,
    maxThrustN: limits.thrustMax * 1.05,
    dCutoff: clamp(0.35 / tau, 15, 80),
    tuned: { wRate, wAtt, wVel, wPos, wVelZ, wYaw },
  };
}

/** 操縦スティックの入力整形 (エクスポ + デッドバンド) */
export function shapeStick(x, expo = 0.3, deadband = 0.03) {
  let v = clamp(x, -1, 1);
  if (Math.abs(v) < deadband) return 0;
  v = (v - Math.sign(v) * deadband) / (1 - deadband);
  return (1 - expo) * v + expo * v * v * v;
}

export const CONTROLLER_DEFAULTS = {
  defaultMode: 'position',
  ratePitch: { kp: 0.035, ki: 0.04, kd: 0.0009 },
  rateRoll: { kp: 0.035, ki: 0.04, kd: 0.0009 },
  rateYaw: { kp: 0.06, ki: 0.05, kd: 0.0 },
  rateILimit: 0.05,
  torqueLimit: 0.6,
  dCutoff: 40,
  velXY: { kp: 2.2, ki: 0.9, kd: 0.05 },
  velZ: { kp: 4.5, ki: 2.5, kd: 0.1 },
  velILimit: 4,
  velZILimit: 8,
  accelLimit: 6,
  accelLimitZ: 8,
  posGain: 1.8,
  attGain: 9.0,
  yawGain: 4.0,
  maxRate: 8.0,          // [rad/s]
  maxYawRate: 3.0,
  maxTilt: 35 * DEG,
  maxSpeedXY: 2.0,
  maxClimbRate: 1.5,
  maxThrustN: 20,
};
