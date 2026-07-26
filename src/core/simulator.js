/**
 * シミュレータ本体。物理・制御・センサをまとめて時間発展させる。
 *
 * 1 ステップの流れ:
 *   1. 制御則 (指定レート)     → u = [F, Mx, My, Mz]
 *   2. ミキサ                  → 各ロータの推力指令
 *   3. モータ/バッテリ         → 実際の推力・トルク (一次遅れ + 電圧サグ)
 *   4. 空力・接触・風          → 合力/合トルク
 *   5. 剛体積分 (RK4)          → 状態更新
 *   6. センサ                  → IMU/気圧/測距/フローの観測値
 */

import {
  v3, vadd, vsub, vmul, vlen, vcross, qrot, qrotInv, qToEuler, qFromEuler,
  m3inverse, makeRng, clamp,
} from './math.js';
import { computeMassProperties, rotorCoefficients, performanceSummary } from './airframe.js';
import { Mixer } from './mixer.js';
import { MotorSystem } from './motor.js';
import { FlightController, autoTuneController } from './controller.js';
import { SensorSuite, noisyState } from './sensors.js';
import { CollisionWorld, buildCollisionShape, contactForces, fitShapeToModel } from './collision.js';
import {
  WindField, AIR_PRESETS, groundEffectFactor, ceilingEffectFactor,
  inducedVelocity, translationalLift, vrsFactor, bodyDrag, rotorDrag, wallEffect,
} from './aero.js';
import { rk4, semiImplicitEuler, makeState, G, gyroscopicTorque } from './dynamics.js';
import { Trajectory } from './trajectory.js';

export class Simulator {
  constructor(vehicle, sim, world = new CollisionWorld()) {
    this.vehicle = vehicle;
    this.sim = sim;
    this.world = world;
    this.air = { ...AIR_PRESETS.standard };
    this.time = 0;
    this.stepCount = 0;
    this.rng = makeRng(sim.seed);
    this.wind = new WindField(sim.wind, sim.seed + 11);
    this.sensors = new SensorSuite(sim.sensors, sim.seed + 22);
    this.trajectory = new Trajectory(sim.trajectory, world.room);
    this.command = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    this.events = [];
    this.rebuild();
    this.reset();
  }

  /** 機体設定が変わったときに再構築する */
  rebuild() {
    const v = this.vehicle;
    this.massProps = computeMassProperties(v);
    this.coef = rotorCoefficients(v.parts.prop, v.power, this.air);
    this.rotors = this.massProps.rotors;
    // 重心基準にロータ位置を補正
    for (const r of this.rotors) {
      r.positionCg = vsub(r.position, this.massProps.com);
    }
    this.rotorsCg = this.rotors.map((r) => ({ ...r, position: r.positionCg }));
    this.motors = new MotorSystem(this.rotors.length, v.power, this.coef, this.sim.seed + 33);
    const tMax = this.motors.maxThrust();
    this.mixer = new Mixer(this.rotorsCg, this.coef.kQ / this.coef.kT, tMax, { airmode: true });

    // 制御ゲイン: 既定では機体の慣性・モータ時定数から自動算出する。
    // (手動で詰めたい場合は controller.autoTune = false にして各ゲインを直接指定)
    let ctrlCfg = v.controller;
    if (v.controller.autoTune !== false) {
      const tq = this.mixer.maxTorque();
      ctrlCfg = autoTuneController(v.controller, this.massProps.inertia, v.power.tauUp, {
        torqueMax: tq,
        thrustMax: tq.thrust,
        mass: this.massProps.mass,
        scale: v.controller.tuningScale ?? 1.0,
      });
      this.tunedController = ctrlCfg;
    }
    this.controller = new FlightController(ctrlCfg);
    this.shape = buildCollisionShape(v, this.massProps);
    // 描画モデルの最下点が分かっていれば、当たり判定の接地面をそこへ揃える
    // (見えている接地面と物理の接地面を一致させる)
    fitShapeToModel(this.shape, this.modelBottom);
    this.inertia = this.massProps.inertia;
    this.inertiaInv = m3inverse(this.inertia);
    this.perf = performanceSummary(v, this.massProps, this.air);
    this.thrusts = new Array(this.rotors.length).fill(0);
    this.torquesQ = new Array(this.rotors.length).fill(0);
    // ロータ数が変わる差し替え (クアッド → ヘキサなど) では、前の機体の
    // 推力指令が残っているとモータ数と長さが合わず undefined を読んで NaN になる。
    // 制御則は controlRate ごとにしか走らないので、差し替え直後の数ステップは
    // ここで用意した配列がそのまま使われる。
    this.thrustCmd = new Array(this.rotors.length).fill(0);
  }

  reset(pose = null) {
    const p = pose?.position || v3(0, 0.06, 0);
    const yaw = pose?.yaw ?? 0;
    this.state = makeState(p, v3(0, 0, 0), qFromEuler(0, 0, yaw), v3(0, 0, 0));
    this.motors.reset();
    this.controller.reset();
    this.sensors.reset();
    this.wind.reset();
    this.time = 0;
    this.stepCount = 0;
    this.accelWorld = v3(0, 0, 0);
    this.events.length = 0;
    this.crashed = false;
    this.contactInfo = { contactCount: 0, maxDepth: 0 };
    this.lastWind = v3(0, 0, 0);
    this.armed = true;
    this.controlAccum = 0;
    this.lastU = [0, 0, 0, 0];
    this.thrustCmd = new Array(this.rotors.length).fill(0);
    this.thrusts = new Array(this.rotors.length).fill(0);
    this.torquesQ = new Array(this.rotors.length).fill(0);
    this.lastTarget = null;
  }

  setVehicle(vehicle) {
    const prev = this.state ? { position: this.state.p, yaw: qToEuler(this.state.q).yaw } : null;
    this.vehicle = vehicle;
    this.rebuild();
    this.reset(prev);
  }

  setAir(air) { this.air = { ...air }; this.rebuild(); }

  /**
   * 描画モデルの最下点 (重心基準) を教える。
   *
   * 当たり判定は球の集まりなので、そのままでは実際に描かれる形とずれる。
   * ここで受け取った値に接地面を合わせることで、機体が床にめり込んだり
   * 浮いたりして見えるのを防ぐ (collision.js の fitShapeToModel を参照)。
   * 描画を持たない環境 (Node のテスト) では呼ばれず、従来どおりの形状になる。
   *
   * @param {number} y 最下点の高さ [m] (重心を原点とする機体座標)
   */
  setModelBottom(y) {
    if (!Number.isFinite(y)) return;
    this.modelBottom = y;
    // 素の形状から作り直してから合わせる。STL の読み込み完了などで
    // 二度呼ばれても、前回の調整が積み重ならないようにするため。
    this.shape = buildCollisionShape(this.vehicle, this.massProps);
    fitShapeToModel(this.shape, y);
  }

  /**
   * 現在状態における力とトルクを計算する。
   * @param {object} s 状態
   * @returns {{force:{x,y,z}, torque:{x,y,z}}} force: ワールド座標, torque: 機体座標
   */
  computeWrench(s) {
    const v = this.vehicle;
    const rho = this.air.density;
    const propR = v.parts.prop.diameter / 2;

    // --- 重力 ---
    let force = v3(0, -this.massProps.mass * G, 0);
    let torque = v3(0, 0, 0);

    // --- 対気速度 (機体座標) ---
    const vRel = vsub(s.v, this.lastWind);
    const vBody = qrotInv(s.q, vRel);

    // --- ロータ推力 (地面効果・天井効果などの補正込み) ---
    const agl = this.world.heightAboveGround(s.p);
    const ceil = this.world.distanceToCeiling(s.p);
    const geFactor = groundEffectFactor(agl, propR, v.aero.groundEffect);
    const ceFactor = ceilingEffectFactor(ceil, propR, v.aero.ceilingEffect);
    const thrustSum0 = this.thrusts.reduce((a, b) => a + b, 0);
    const vi = inducedVelocity(thrustSum0 / Math.max(this.rotors.length, 1), propR, rho);
    const vHoriz = Math.hypot(vBody.x, vBody.z);
    const tlFactor = translationalLift(vHoriz, vi, v.aero.translationalLift);
    const vrs = vrsFactor(vRel.y, vi, v.aero.vrs);
    const factor = geFactor * ceFactor * tlFactor * vrs;

    let fBody = v3(0, 0, 0);
    let mBody = v3(0, 0, 0);
    for (let i = 0; i < this.rotorsCg.length; i++) {
      const r = this.rotorsCg[i];
      const t = this.thrusts[i] * r.efficiency * factor;
      const f = vmul(r.axis, t);
      fBody = vadd(fBody, f);
      mBody = vadd(mBody, vcross(r.position, f));
      // 反トルク
      const q = -r.spin * this.torquesQ[i] * r.efficiency;
      mBody = vadd(mBody, vmul(r.axis, q));

      // ロータ抗力 (H-force)。ロータ位置での局所的な対気速度を使うので、
      // 機体の回転による速度成分も含まれ、角速度に対する減衰が自然に生じる
      // (ヨー回転の減衰やロール/ピッチのダンピングはこれが主因)。
      const vLocal = vadd(vBody, vcross(s.omega, r.position));
      const h = rotorDrag(vLocal, this.motors.speeds[i], v.aero.kh);
      fBody = vadd(fBody, h);
      mBody = vadd(mBody, vcross(r.position, h));
    }

    // --- 機体抗力 ---
    const bDrag = bodyDrag(vBody, v.aero, rho);
    fBody = vadd(fBody, bDrag);

    force = vadd(force, qrot(s.q, fBody));
    torque = vadd(torque, mBody);

    // --- 壁効果 ---
    if (v.aero.wallEffect) {
      const walls = this.world.nearbyWalls(s.p, propR * 3);
      const wf = wallEffect(walls, thrustSum0, propR, true, v.aero.wallEffectGain);
      force = vadd(force, wf);
    }

    // --- ジャイロモーメント ---
    torque = vadd(torque, gyroscopicTorque(this.rotorsCg, this.motors.speeds, v.power.rotorInertia, s.omega));

    // --- 接触 ---
    // 質量と刻み幅を渡して、陽解法で発散しない範囲に減衰を抑えてもらう
    const c = contactForces(this.world, s, this.shape, v.contact,
      this.massProps.mass, this.stepDt || 1 / (this.sim.physicsRate || 500));
    force = vadd(force, c.force);
    torque = vadd(torque, c.torque);
    this.contactInfo = c;

    return { force, torque };
  }

  /** 操縦入力を設定 (-1..1, throttle は 0..1 もしくは -1..1) */
  setCommand(cmd) { this.command = { ...this.command, ...cmd }; }

  setMode(mode) { this.controller.setMode(mode, this.state); }

  /**
   * dtWall [s] 分だけ進める。内部では physicsRate 固定ステップで分割する。
   */
  advance(dtWall) {
    const scaled = dtWall * this.sim.timeScale;
    const h = 1 / this.sim.physicsRate;
    let remaining = Math.min(scaled, 0.25); // スパイク保護
    let steps = 0;
    while (remaining > 1e-9 && steps < 2000) {
      const dt = Math.min(h, remaining);
      this.stepOnce(dt);
      remaining -= dt;
      steps++;
    }
    return steps;
  }

  stepOnce(dt) {
    const v = this.vehicle;
    const s = this.state;
    this.stepDt = dt;      // 接触力の安定化に使う (contactForces を参照)

    // --- 風 ---
    const agl = this.world.heightAboveGround(s.p);
    this.lastWind = this.wind.sample(dt, s.p, agl);

    // --- 制御 (制御レートでダウンサンプル) ---
    this.controlAccum += dt;
    const ctrlPeriod = 1 / (this.sim.controlRate || 250);
    if (this.controlAccum >= ctrlPeriod) {
      const cdt = this.controlAccum;
      this.controlAccum = 0;
      const ctrlState = this.sim.useEstimatedState
        ? noisyState(s, this.rng, this.sim.estimator)
        : s;
      let cmd = this.command;
      if (this.controller.mode === 'auto') {
        const target = this.trajectory.sample(this.time);
        cmd = { ...this.command, target };
        this.lastTarget = target;
      }
      const u = this.controller.update(ctrlState, cmd, cdt, { mass: this.massProps.mass });
      this.lastU = u;
      this.mixer.tMax = this.motors.maxThrust();
      this.thrustCmd = this.armed ? this.mixer.allocate(u) : new Array(this.rotors.length).fill(0);
    }
    if (!this.thrustCmd) this.thrustCmd = new Array(this.rotors.length).fill(0);

    // --- モータ ---
    const m = this.motors.step(dt, this.thrustCmd);
    this.thrusts = m.thrusts;
    this.torquesQ = m.torques;

    // --- 積分 ---
    const wrenchFn = (st) => this.computeWrench(st);
    const before = this.state;
    const integrator = this.sim.integrator === 'euler' ? semiImplicitEuler : rk4;
    this.state = integrator(before, dt, wrenchFn, this.massProps.mass, this.inertia, this.inertiaInv);
    this.accelWorld = vmul(vsub(this.state.v, before.v), 1 / Math.max(dt, 1e-9));

    // --- センサ ---
    this.sensors.update(dt, this.time, this.state, this.accelWorld, this.world,
      this.sim.textureQuality ?? 1);

    // --- 破損判定 ---
    const impact = vlen(vsub(this.state.v, before.v)) / Math.max(dt, 1e-9);
    if (this.contactInfo.contactCount > 0 && impact > (this.sim.crashAccel ?? 120)) {
      if (!this.crashed) {
        this.crashed = true;
        this.events.push({ t: this.time, type: 'crash', accel: impact });
      }
    }

    this.time += dt;
    this.stepCount++;
  }

  /** 現在のテレメトリ (UI 表示・記録用) */
  snapshot() {
    const e = qToEuler(this.state.q);
    const vBody = qrotInv(this.state.q, this.state.v);
    return {
      t: this.time,
      position: { ...this.state.p },
      velocity: { ...this.state.v },
      velocityBody: vBody,
      quaternion: { ...this.state.q },
      euler: e,
      omega: { ...this.state.omega },
      accel: { ...this.accelWorld },
      thrusts: [...this.thrusts],
      motorCommands: [...this.motors.commands],
      rpm: this.motors.speeds.map((n) => n * 60),
      battery: {
        voltage: this.motors.voltage, current: this.motors.current,
        soc: this.motors.soc, energyWh: this.motors.energyWh,
      },
      agl: this.world.heightAboveGround(this.state.p),
      wind: { ...this.lastWind },
      contact: this.contactInfo.contactCount,
      crashed: this.crashed,
      mode: this.controller.mode,
      saturated: this.mixer.saturated,
      sensors: this.sensors.latest,
      u: this.lastU,
    };
  }

  /**
   * ロータ故障を注入する。ミキサも残ったロータで配分し直す
   * (フォールトトレラント制御の実験に使える)。
   */
  setMotorFailure(index, failed) {
    this.motors.setFailure(index, failed);
    this.mixer.setFailed(index, failed);
    this.events.push({ t: this.time, type: failed ? 'motor-fail' : 'motor-restore', index });
  }

  /** 機体を安全な位置へ戻す */
  respawn(position = null) {
    const p = position || v3(0, this.vehicle.parts.landingGear.height + 0.03, 0);
    this.reset({ position: p, yaw: qToEuler(this.state.q).yaw });
  }
}

export { CollisionWorld };
