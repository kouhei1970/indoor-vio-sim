import test from 'node:test';
import assert from 'node:assert/strict';
import { v3, vlen, vsub, qToEuler, DEG } from '../src/core/math.js';
import { resolveLayout, computeMassProperties, rotorCoefficients, performanceSummary, LAYOUTS } from '../src/core/airframe.js';
import { Mixer } from '../src/core/mixer.js';
import { MotorSystem, cellOcv } from '../src/core/motor.js';
import { buildVehicle, SIM_DEFAULTS, PRESET_KEYS, deepMerge, clone } from '../src/config/vehicle.js';
import { Simulator } from '../src/core/simulator.js';
import { CollisionWorld } from '../src/core/collision.js';
import { AIR_PRESETS, groundEffectFactor, ceilingEffectFactor } from '../src/core/aero.js';
import { G } from '../src/core/dynamics.js';

const makeWorld = (w = 10, h = 6, d = 10) => {
  const world = new CollisionWorld();
  world.setRoom(w, h, d);
  return world;
};

const makeSim = (presetKey = 'freestyle-5inch', overrides = {}) => {
  const vehicle = buildVehicle(presetKey);
  const sim = deepMerge(SIM_DEFAULTS, overrides);
  return new Simulator(vehicle, sim, makeWorld());
};

test('クアッド X のロータ配置は対称で回転方向が交互', () => {
  const rotors = resolveLayout({ ...buildVehicle('freestyle-5inch').frame });
  assert.equal(rotors.length, 4);
  let sx = 0, sz = 0, spin = 0;
  for (const r of rotors) {
    sx += r.position.x; sz += r.position.z; spin += r.spin;
    const d = Math.hypot(r.position.x, r.position.z);
    assert.ok(Math.abs(d - 0.125) < 1e-9, `arm length ${d}`);
  }
  assert.ok(Math.abs(sx) < 1e-12 && Math.abs(sz) < 1e-12, '配置が対称でない');
  assert.equal(spin, 0, '回転方向の合計が 0 でない (反トルクが釣り合わない)');
});

test('全レイアウトが正しいロータ本数を返す', () => {
  const expected = { 'quad-x': 4, 'quad-plus': 4, 'quad-h': 4, deadcat: 4, tri: 3, 'hexa-x': 6, 'hexa-plus': 6, 'octa-x': 8, 'octa-coax': 8 };
  for (const [key, n] of Object.entries(expected)) {
    const v = buildVehicle('freestyle-5inch');
    v.frame.layout = key;
    assert.equal(resolveLayout(v.frame).length, n, key);
    assert.ok(LAYOUTS[key].label.length > 0);
  }
});

test('質量特性: 慣性テンソルは対称かつ正定値', () => {
  for (const key of PRESET_KEYS) {
    const v = buildVehicle(key);
    const mp = computeMassProperties(v);
    assert.ok(mp.mass > 0, `${key} mass`);
    const I = mp.inertia;
    assert.ok(Math.abs(I[1] - I[3]) < 1e-12 && Math.abs(I[2] - I[6]) < 1e-12 && Math.abs(I[5] - I[7]) < 1e-12,
      `${key} inertia not symmetric`);
    assert.ok(I[0] > 0 && I[4] > 0 && I[8] > 0, `${key} inertia diagonal`);
    // ヨー慣性はロール/ピッチ慣性の和にほぼ等しい (平面的な機体の性質)
    assert.ok(I[4] > 0.3 * (I[0] + I[8]), `${key} yaw inertia too small`);
  }
});

test('アームを長くすると慣性モーメントが増える', () => {
  const a = buildVehicle('freestyle-5inch');
  const b = buildVehicle('freestyle-5inch');
  b.frame.armLength = a.frame.armLength * 2;
  const Ia = computeMassProperties(a).inertia;
  const Ib = computeMassProperties(b).inertia;
  assert.ok(Ib[0] > Ia[0] * 1.5, 'ピッチ慣性が増えていない');
  assert.ok(Ib[4] > Ia[4] * 1.5, 'ヨー慣性が増えていない');
});

test('全プリセットの推力重量比が現実的な範囲に入る', () => {
  for (const key of PRESET_KEYS) {
    const v = buildVehicle(key);
    const mp = computeMassProperties(v);
    const perf = performanceSummary(v, mp, AIR_PRESETS.standard);
    assert.ok(perf.twr > 1.4, `${key}: TWR=${perf.twr.toFixed(2)} が低すぎる (浮上できない)`);
    assert.ok(perf.twr < 12, `${key}: TWR=${perf.twr.toFixed(2)} が高すぎる`);
    assert.ok(perf.hoverThrottle > 0.15 && perf.hoverThrottle < 0.85,
      `${key}: ホバリングスロットル ${perf.hoverThrottle.toFixed(2)} が不自然`);
  }
});

test('ミキサ: ホバリング指令では全ロータが等推力', () => {
  const v = buildVehicle('freestyle-5inch');
  const mp = computeMassProperties(v);
  const coef = rotorCoefficients(v.parts.prop, v.power, AIR_PRESETS.standard);
  const mixer = new Mixer(mp.rotors, coef.kQ / coef.kT, 20);
  const t = mixer.allocate([mp.mass * G, 0, 0, 0]);
  const mean = t.reduce((a, b) => a + b, 0) / t.length;
  for (const x of t) assert.ok(Math.abs(x - mean) < 1e-9, `不均等な配分: ${t}`);
  assert.ok(Math.abs(mean * 4 - mp.mass * G) < 1e-6, '合計推力が一致しない');
});

test('ミキサ: 配分した推力から元の指令が再現される', () => {
  for (const layout of ['quad-x', 'hexa-x', 'octa-x', 'quad-plus']) {
    const v = buildVehicle('freestyle-5inch');
    v.frame.layout = layout;
    const mp = computeMassProperties(v);
    const coef = rotorCoefficients(v.parts.prop, v.power, AIR_PRESETS.standard);
    const mixer = new Mixer(mp.rotors, coef.kQ / coef.kT, 50);
    const u = [mp.mass * G, 0.05, 0.02, -0.03];
    const t = mixer.allocate(u);
    const w = mixer.wrench(t);
    assert.ok(Math.abs(w.force.y - u[0]) < 1e-6, `${layout} 推力 ${w.force.y} != ${u[0]}`);
    assert.ok(Math.abs(w.torque.x - u[1]) < 1e-6, `${layout} Mx`);
    assert.ok(Math.abs(w.torque.y - u[2]) < 1e-6, `${layout} My`);
    assert.ok(Math.abs(w.torque.z - u[3]) < 1e-6, `${layout} Mz`);
  }
});

test('ミキサ: 飽和時も姿勢トルクを優先する', () => {
  const v = buildVehicle('freestyle-5inch');
  const mp = computeMassProperties(v);
  const coef = rotorCoefficients(v.parts.prop, v.power, AIR_PRESETS.standard);
  const tMax = 4;
  const mixer = new Mixer(mp.rotors, coef.kQ / coef.kT, tMax);
  const t = mixer.allocate([tMax * 4, 0.3, 0, 0]); // 全開 + ピッチトルク
  for (const x of t) assert.ok(x >= -1e-9 && x <= tMax + 1e-9, `範囲外: ${x}`);
  const w = mixer.wrench(t);
  assert.ok(Math.abs(w.torque.x) > 0.05, 'ピッチトルクが失われている');
});

test('地面効果・天井効果の係数', () => {
  assert.ok(groundEffectFactor(0.05, 0.0635) > 1.1, '地面近くで推力が増えない');
  assert.ok(Math.abs(groundEffectFactor(3.0, 0.0635) - 1) < 0.01, '高高度で地面効果が残っている');
  assert.equal(groundEffectFactor(0.05, 0.0635, false), 1);
  assert.ok(ceilingEffectFactor(0.08, 0.0635) > 1.05, '天井近くで吸い寄せが起きない');
});

test('自由落下: 推力ゼロなら重力加速度で落ちる', () => {
  const sim = makeSim();
  sim.reset({ position: v3(0, 4, 0) });
  sim.armed = false;
  sim.vehicle.aero.groundEffect = false;
  const t = 0.5;
  for (let i = 0; i < 250; i++) sim.stepOnce(t / 250);
  const expected = -G * t;
  assert.ok(Math.abs(sim.state.v.y - expected) < 0.15,
    `落下速度 ${sim.state.v.y.toFixed(3)} != ${expected.toFixed(3)}`);
});

test('着陸: 地面に置くと沈み込まず静止する', () => {
  const sim = makeSim();
  sim.reset({ position: v3(0, 0.5, 0) });
  sim.armed = false;
  for (let i = 0; i < 3000; i++) sim.stepOnce(1 / 500);
  assert.ok(sim.state.p.y > -0.02, `床を突き抜けた: y=${sim.state.p.y}`);
  assert.ok(Math.abs(sim.state.v.y) < 0.2, `静止していない: vy=${sim.state.v.y}`);
  const e = qToEuler(sim.state.q);
  assert.ok(Math.abs(e.roll) < 0.3 && Math.abs(e.pitch) < 0.3, '着陸姿勢が崩れている');
});

test('ホバリング: position モードで目標位置に収束する', () => {
  for (const key of PRESET_KEYS) {
    const sim = makeSim(key, { wind: { enabled: false }, sensors: { logImu: false } });
    sim.reset({ position: v3(0, 1.0, 0) });
    sim.setMode('position');
    sim.controller.targetPos = v3(0, 1.0, 0);
    sim.setCommand({ roll: 0, pitch: 0, yaw: 0, throttle: 0 });
    for (let i = 0; i < 500 * 8; i++) sim.stepOnce(1 / 500);
    const err = vlen(vsub(sim.state.p, v3(0, 1.0, 0)));
    assert.ok(err < 0.12, `${key}: ホバリング位置誤差 ${err.toFixed(3)} m`);
    assert.ok(!sim.crashed, `${key}: 墜落した`);
    const e = qToEuler(sim.state.q);
    assert.ok(Math.abs(e.roll) < 8 * DEG && Math.abs(e.pitch) < 8 * DEG,
      `${key}: 姿勢が傾いている roll=${(e.roll / DEG).toFixed(1)} pitch=${(e.pitch / DEG).toFixed(1)}`);
  }
});

test('位置指令に追従して移動する', () => {
  const sim = makeSim('research-250', { wind: { enabled: false } });
  sim.reset({ position: v3(0, 1.0, 0) });
  sim.setMode('position');
  sim.controller.targetPos = v3(1.5, 1.4, -1.0);
  for (let i = 0; i < 500 * 12; i++) sim.stepOnce(1 / 500);
  const err = vlen(vsub(sim.state.p, v3(1.5, 1.4, -1.0)));
  assert.ok(err < 0.15, `移動後の位置誤差 ${err.toFixed(3)} m`);
});

test('auto モードで軌道に追従する', () => {
  const sim = makeSim('research-250', {
    wind: { enabled: false },
    trajectory: { pattern: 'lawnmower', speed: 0.5, altitude: 1.2, rows: 3, margin: 1.5 },
  });
  sim.reset({ position: sim.trajectory.sample(0).position });
  sim.setMode('auto');
  let maxErr = 0;
  for (let i = 0; i < 500 * 20; i++) {
    sim.stepOnce(1 / 500);
    if (i > 500 * 2) {
      const target = sim.trajectory.sample(sim.time).position;
      maxErr = Math.max(maxErr, vlen(vsub(sim.state.p, target)));
    }
  }
  assert.ok(maxErr < 0.5, `軌道追従誤差が大きい: ${maxErr.toFixed(3)} m`);
});

test('ヨー指令に追従する', () => {
  const sim = makeSim('research-250', { wind: { enabled: false } });
  sim.reset({ position: v3(0, 1.2, 0) });
  sim.setMode('position');
  sim.controller.targetPos = v3(0, 1.2, 0);
  sim.controller.targetYaw = 90 * DEG;
  for (let i = 0; i < 500 * 8; i++) sim.stepOnce(1 / 500);
  const yaw = qToEuler(sim.state.q).yaw;
  assert.ok(Math.abs(yaw - 90 * DEG) < 5 * DEG, `ヨー角 ${(yaw / DEG).toFixed(1)}deg`);
});

test('バッテリーは消費され電圧が下がる', () => {
  const sim = makeSim('freestyle-5inch');
  sim.reset({ position: v3(0, 1.0, 0) });
  sim.setMode('position');
  const v0 = sim.motors.voltage;
  for (let i = 0; i < 500 * 10; i++) sim.stepOnce(1 / 500);
  assert.ok(sim.motors.soc < 1.0, 'SOC が減っていない');
  assert.ok(sim.motors.voltage < v0, '電圧が下がっていない');
  assert.ok(sim.motors.current > 0.5, `電流が小さすぎる: ${sim.motors.current}`);
});

/** 指定の満充電電圧でモータ系だけを組む (機体の飛行は挟まず電池だけを見る) */
const makeMotors = (cellFull) => {
  const v = buildVehicle('stampfly');
  v.power = { ...v.power, cellFull };
  const coef = rotorCoefficients(v.parts.prop, v.power, AIR_PRESETS.standard);
  return { motors: new MotorSystem(4, v.power, coef), coef, capAh: v.power.capacityMah / 1000 };
};

test('バッテリー: 高電圧型 (LiHV) は 4.35V まで上がり、空では標準リポに収束する', () => {
  assert.ok(Math.abs(cellOcv(1, 4.20) - 4.20) < 1e-9, '標準リポの満充電が 4.20V でない');
  assert.ok(Math.abs(cellOcv(1, 4.35) - 4.35) < 1e-9, '高電圧型の満充電が 4.35V でない');
  // 使い切ったところでは電池の種類によらず同じ電圧 (差は満充電側に効く)
  assert.ok(Math.abs(cellOcv(0, 4.35) - cellOcv(0, 4.20)) < 1e-9);
  let prev = -1;
  for (let s = 0; s <= 1.0001; s += 0.02) {
    const hv = cellOcv(s, 4.35), std = cellOcv(s, 4.20);
    assert.ok(hv >= std - 1e-12, `SOC ${s.toFixed(2)} で高電圧型が下回っている`);
    assert.ok(hv > prev, `SOC ${s.toFixed(2)} で単調増加でない`);
    prev = hv;
  }
});

test('バッテリー: 残量は電荷 (クーロンカウント) で減る', () => {
  // 電池の定格 mAh は電荷なので、SOC の減りは ∫I dt / 容量 に一致するはず。
  const { motors, coef, capAh } = makeMotors(4.20);
  const dt = 1 / 500;
  const cmd = new Array(4).fill(coef.kT * Math.pow(coef.nMax * 0.7, 2));
  let ah = 0;
  for (let i = 0; i < 500 * 20; i++) {
    motors.step(dt, cmd);
    ah += (motors.current * dt) / 3600;
  }
  const used = (1 - motors.soc) * capAh;
  assert.ok(ah > 0.01, `電流が流れていない (${ah} Ah)`);
  assert.ok(Math.abs(used - ah) < 1e-9, `SOC が電荷と一致しない (${used} vs ${ah} Ah)`);
});

test('バッテリー: 高電圧型のほうが同じ負荷で長く保つ', () => {
  // 同じ電力を出し続けたとき、電圧が高いぶん電流が小さくなり残量が長持ちする。
  const dt = 1 / 500;
  // 残量が半分になるまでの時間で比べる
  const drain = (cellFull) => {
    const { motors, coef } = makeMotors(cellFull);
    const cmd = new Array(4).fill(coef.kT * Math.pow(coef.nMax * 0.7, 2));
    for (let i = 0; i < 500 * 600; i++) {
      motors.step(dt, cmd);
      if (motors.soc <= 0.5) return { t: i * dt, motors };
    }
    return { t: Infinity, motors };
  };
  const std = drain(4.20), hv = drain(4.35);
  assert.ok(Number.isFinite(hv.t) && Number.isFinite(std.t), '残量が減っていない');
  assert.ok(hv.t > std.t * 1.02,
    `高電圧型が長持ちしていない (${hv.t.toFixed(1)} s vs ${std.t.toFixed(1)} s)`);
  assert.ok(hv.motors.current < std.motors.current,
    '同じ推力指令なのに電流が減っていない (電圧が高ければ電流は小さくなるはず)');
  // 電圧が高い = 同じ推力指令でも回転数の余裕が大きい
  assert.ok(hv.motors.maxSpeed() > std.motors.maxSpeed(), '高電圧型の最大回転数が大きくない');
});

test('ロータ故障時はヨーを犠牲にして高度と姿勢を保つ (ヘキサ)', () => {
  // 標準的なヘキサコプターは 1 基を失うとヨートルクの釣り合いが崩れ、
  // 4 自由度すべては制御できなくなる。ミキサはヨーを段階的に諦めることで
  // 高度・姿勢を維持する (実機の motor-out 挙動と同じ)。
  const sim = makeSim('hexa-inspection', { wind: { enabled: false } });
  sim.reset({ position: v3(0, 2.0, 0) });
  sim.setMode('position');
  sim.controller.targetPos = v3(0, 2.0, 0);
  for (let i = 0; i < 500 * 4; i++) sim.stepOnce(1 / 500);
  const yaw0 = qToEuler(sim.state.q).yaw;

  let maxTilt = 0;
  for (let i = 0; i < 500 * 1.5; i++) {
    if (i === 0) sim.setMotorFailure(0, true);
    sim.stepOnce(1 / 500);
    const e = qToEuler(sim.state.q);
    maxTilt = Math.max(maxTilt, Math.abs(e.roll), Math.abs(e.pitch));
  }
  assert.ok(sim.thrusts[0] < 1e-3 && sim.thrustCmd[0] === 0, '故障ロータに推力が配分されている');
  assert.ok(Math.abs(sim.state.p.y - 2.0) < 0.3, `高度を維持できていない: ${sim.state.p.y.toFixed(2)} m`);
  assert.ok(maxTilt < 20 * DEG, `姿勢が崩れている: ${(maxTilt / DEG).toFixed(1)}deg`);
  // ヨーは制御を諦めるので回り始めるのが正しい挙動
  const yawDrift = Math.abs(qToEuler(sim.state.q).yaw - yaw0);
  assert.ok(yawDrift > 5 * DEG, 'ヨーが動いていない (テスト条件を確認)');
});

test('IMU 出力: 静止ホバリング時の比力は約 +9.8 m/s^2 (機体上方)', () => {
  const sim = makeSim('research-250', { wind: { enabled: false } });
  sim.reset({ position: v3(0, 1.2, 0) });
  sim.setMode('position');
  for (let i = 0; i < 500 * 6; i++) sim.stepOnce(1 / 500);
  const imu = sim.sensors.latest.imu;
  assert.ok(imu, 'IMU 出力が無い');
  assert.ok(Math.abs(imu.accel.y - G) < 0.6, `加速度計 y = ${imu.accel.y.toFixed(2)}`);
  assert.ok(Math.abs(imu.gyro.x) < 0.5 && Math.abs(imu.gyro.z) < 0.5, 'ジャイロ出力が大きい');
});

test('風を強くすると位置誤差が増える', () => {
  const run = (windSpeed) => {
    const sim = makeSim('research-250', {
      wind: { enabled: true, speed: windSpeed, turbulence: windSpeed * 0.5, direction: 90 },
    });
    sim.reset({ position: v3(0, 1.2, 0) });
    sim.setMode('position');
    sim.controller.targetPos = v3(0, 1.2, 0);
    let acc = 0, n = 0;
    for (let i = 0; i < 500 * 10; i++) {
      sim.stepOnce(1 / 500);
      if (i > 500 * 4) { acc += vlen(vsub(sim.state.p, v3(0, 1.2, 0))); n++; }
    }
    return acc / n;
  };
  const calm = run(0.0);
  const windy = run(2.5);
  assert.ok(windy > calm, `風で誤差が増えていない (calm=${calm.toFixed(4)}, windy=${windy.toFixed(4)})`);
});

test('決定論性: 同じシードなら同じ軌跡になる', () => {
  const run = () => {
    const sim = makeSim('research-250');
    sim.reset({ position: v3(0, 1.0, 0) });
    sim.setMode('position');
    for (let i = 0; i < 2000; i++) sim.stepOnce(1 / 500);
    return sim.state.p;
  };
  const a = run(), b = run();
  assert.equal(a.x, b.x); assert.equal(a.y, b.y); assert.equal(a.z, b.z);
});

/* ------------------------------------------------------------------ */
/* StampFly: 公式 StampFly Ecosystem の実測値と一致していることを確認    */
/* (M5Fly-kanazawa/stampfly_ecosystem の simulator/vpython/core より)   */
/* ------------------------------------------------------------------ */

test('StampFly: 質量・慣性テンソルが実測値と一致する', () => {
  const v = buildVehicle('stampfly');
  const mp = computeMassProperties(v);
  assert.equal(mp.inertiaSource, 'manual', '実測の慣性テンソルが使われていない');
  assert.ok(Math.abs(mp.mass - 0.035) < 1e-9, `質量 ${mp.mass}`);
  // 内部座標 (x=右, y=上, z=後) の対角成分 = (ピッチ, ヨー, ロール)
  assert.ok(Math.abs(mp.inertia[0] - 13.3e-6) < 1e-12, `ピッチ慣性 ${mp.inertia[0]}`);
  assert.ok(Math.abs(mp.inertia[4] - 20.4e-6) < 1e-12, `ヨー慣性 ${mp.inertia[4]}`);
  assert.ok(Math.abs(mp.inertia[8] - 9.16e-6) < 1e-12, `ロール慣性 ${mp.inertia[8]}`);
  // 非対角成分はゼロ
  for (const i of [1, 2, 3, 5, 6, 7]) assert.equal(mp.inertia[i], 0);
});

test('StampFly: ロータ配置が実測値 (±23mm) と一致する', () => {
  const v = buildVehicle('stampfly');
  const rotors = resolveLayout(v.frame);
  assert.equal(rotors.length, 4);
  for (const r of rotors) {
    assert.ok(Math.abs(Math.abs(r.position.x) - 0.023) < 1e-6, `x = ${r.position.x}`);
    assert.ok(Math.abs(Math.abs(r.position.z) - 0.023) < 1e-6, `z = ${r.position.z}`);
  }
  // ファームウェアと同じ回転方向: 前左=CW, 後左=CCW, 後右=CW, 前右=CCW
  const at = (x, z) => rotors.find((r) => Math.abs(r.position.x - x) < 1e-6
    && Math.abs(r.position.z - z) < 1e-6);
  assert.equal(at(-0.023, -0.023).spin, -1, '前左 (4_FL) が CW でない');
  assert.equal(at(-0.023, 0.023).spin, 1, '後左 (3_RL) が CCW でない');
  assert.equal(at(0.023, 0.023).spin, -1, '後右 (2_RR) が CW でない');
  assert.equal(at(0.023, -0.023).spin, 1, '前右 (1_FR) が CCW でない');
});

test('StampFly: 推力・トルク係数が実測値と一致する', () => {
  const v = buildVehicle('stampfly');
  const coef = rotorCoefficients(v.parts.prop, v.power, AIR_PRESETS.standard);
  // 本シミュレータは T = kT n² (n [rev/s])。実測は T = Ct ω² (ω [rad/s])。
  const Ct = coef.kT / (4 * Math.PI * Math.PI);
  const Cq = coef.kQ / (4 * Math.PI * Math.PI);
  assert.ok(Math.abs(Ct - 6.7e-9) / 6.7e-9 < 1e-3, `Ct = ${Ct.toExponential(4)} (実測 6.7e-9)`);
  assert.ok(Math.abs(Cq - 4.10e-11) / 4.10e-11 < 1e-3, `Cq = ${Cq.toExponential(4)} (実測 4.10e-11)`);
  // κ = Cq/Ct はファームのミキサ定数と一致していなければならない
  const kappa = Cq / Ct;
  assert.ok(Math.abs(kappa - 6.12e-3) / 6.12e-3 < 2e-3, `κ = ${kappa.toExponential(4)} (実測 6.12e-3)`);
});

test('StampFly: 最大回転数と推力重量比が実測モデルと一致する', () => {
  const v = buildVehicle('stampfly');
  const mp = computeMassProperties(v);
  const coef = rotorCoefficients(v.parts.prop, v.power, AIR_PRESETS.standard);
  const perf = performanceSummary(v, mp, AIR_PRESETS.standard);
  // 実測の電気モデル (Rm=0.63, Ke=5.5e-4, Cq, Dm, Qf) の 3.8V 平衡点
  assert.ok(Math.abs(coef.rpmMax - 41637) / 41637 < 0.01,
    `最大回転数 ${coef.rpmMax.toFixed(0)} rpm (実測モデル 41,637)`);
  assert.ok(Math.abs(perf.twr - 1.485) < 0.02, `推力重量比 ${perf.twr.toFixed(3)} (実測モデル 1.485)`);
  // ホバリング回転数
  const nHover = Math.sqrt((mp.mass * G / 4) / coef.kT) * 60;
  assert.ok(Math.abs(nHover - 34192) / 34192 < 0.01,
    `ホバリング回転数 ${nHover.toFixed(0)} rpm (実測モデル 34,192)`);
});

test('StampFly: 推力重量比が低くても位置保持できる', () => {
  // 推力重量比 1.5 程度の機体は、高度制御が推力を使い切ると
  // 姿勢制御の余力が無くなる。制御側が余裕を残せているかの確認。
  const sim = makeSim('stampfly', { wind: { enabled: false } });
  sim.reset({ position: v3(0, 1.0, 0) });
  sim.setMode('position');
  sim.controller.targetPos = v3(0, 1.0, 0);
  let maxTilt = 0;
  for (let i = 0; i < 500 * 10; i++) {
    sim.stepOnce(1 / 500);
    if (i > 500) {
      const e = qToEuler(sim.state.q);
      maxTilt = Math.max(maxTilt, Math.abs(e.roll), Math.abs(e.pitch));
    }
  }
  const err = vlen(vsub(sim.state.p, v3(0, 1.0, 0)));
  assert.ok(err < 0.1, `位置誤差 ${err.toFixed(3)} m`);
  assert.ok(maxTilt < 10 * DEG, `姿勢の振れ ${(maxTilt / DEG).toFixed(1)} deg`);
  assert.ok(!sim.crashed, '墜落した');
});

/* ------------------------------------------------------------------ */
/* 機体の差し替え                                                       */
/* ------------------------------------------------------------------ */

test('ロータ数の違う機体へ差し替えても発散しない', () => {
  // GUI でプリセットを切り替えたときと同じ流れ。
  // 差し替え前の推力指令が残っているとモータ数と長さが合わず、
  // 制御則が次に走るまでの数ステップで NaN になる。
  const world = new CollisionWorld();
  world.setRoom(20, 6, 20);

  for (const from of PRESET_KEYS) {
    for (const to of PRESET_KEYS) {
      const sim = new Simulator(buildVehicle(from), clone(SIM_DEFAULTS), world);
      sim.setMode('position');
      sim.controller.targetPos = { x: 0, y: 1.0, z: 0 };
      for (let i = 0; i < 200; i++) sim.stepOnce(1 / 500);

      sim.setVehicle(buildVehicle(to));
      assert.equal(sim.thrustCmd.length, sim.rotors.length,
        `${from} → ${to}: 推力指令の長さ ${sim.thrustCmd.length} がロータ数 ${sim.rotors.length} と違う`);

      sim.reset({ position: v3(0, 1.0, 0), yaw: 0 });
      sim.setMode('position');
      sim.controller.targetPos = { x: 0, y: 1.0, z: 0 };
      // 制御則が走る前 (controlRate 未満) のステップを必ず含める
      for (let i = 0; i < 500; i++) {
        sim.stepOnce(1 / 500);
        assert.ok(Number.isFinite(sim.state.p.x) && Number.isFinite(sim.state.p.y)
          && Number.isFinite(sim.state.p.z),
        `${from} → ${to}: step ${i} で発散した`);
      }
    }
  }
});

test('機体を差し替えても前の機体の状態が残らない', () => {
  const world = new CollisionWorld();
  world.setRoom(20, 6, 20);
  const sim = new Simulator(buildVehicle('tricopter'), clone(SIM_DEFAULTS), world);
  sim.setMode('position');
  sim.controller.targetPos = { x: 0, y: 1.2, z: 0 };
  for (let i = 0; i < 1000; i++) sim.stepOnce(1 / 500);
  assert.ok(sim.thrusts.some((t) => t > 0), '飛んでいる状態を作れている');

  sim.setVehicle(buildVehicle('x8-heavy'));
  sim.reset();
  for (const arr of [sim.thrustCmd, sim.thrusts, sim.torquesQ]) {
    assert.equal(arr.length, sim.rotors.length);
    assert.ok(arr.every((x) => x === 0), 'リセット後は 0 から始まる');
  }
  assert.equal(sim.lastTarget, null, '前の機体の軌道目標が残らない');
});
