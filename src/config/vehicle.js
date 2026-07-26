/**
 * 機体設定のデフォルト値とプリセット。
 *
 * ここでの「パーツ」は見た目と物理の両方を決める。
 *   parts.*.shape     … 形状 (描画とおおよその慣性計算に使う)
 *   parts.*.size/mass … 寸法と質量 (慣性テンソルが自動計算される)
 *   parts.*.material  … 色・金属度・粗さ (PBR マテリアル)
 *
 * 新しい機体を作るときは PRESETS に部分的な上書き (deep merge) を書けばよい。
 */

import { CONTROLLER_DEFAULTS } from '../core/controller.js';
import { SENSOR_DEFAULTS } from '../core/sensors.js';
import { TRAJECTORY_DEFAULTS } from '../core/trajectory.js';

export const PART_SHAPES = {
  body: ['box', 'rounded-box', 'cylinder', 'sphere', 'plate', 'wedge', 'dome'],
  arm: ['tube', 'box', 'tapered', 'flat', 'truss'],
  motor: ['bell', 'cylinder', 'box', 'coreless'],
  prop: ['2blade', '3blade', '4blade', 'disc', 'ducted'],
  guard: ['ring', 'octagon', 'cage', 'duct', 'bumper'],
  landingGear: ['skid', 'leg', 'tube', 'ring', 'pad'],
  camera: ['box', 'cylinder', 'dome', 'gimbal', 'stereo'],
};

const mat = (color, metalness = 0.15, roughness = 0.55, extra = {}) => ({
  color, metalness, roughness,
  clearcoat: extra.clearcoat ?? 0,
  emissive: extra.emissive ?? '#000000',
  emissiveIntensity: extra.emissiveIntensity ?? 0,
  opacity: extra.opacity ?? 1,
  transparent: extra.transparent ?? false,
});

/** すべての機体設定のベース。プリセットはこれを部分的に上書きする。 */
export const DEFAULT_VEHICLE = {
  name: 'カスタム機体',
  description: '',
  massMode: 'auto',        // 'auto' = パーツ質量の合計, 'manual' = totalMass を使う
  totalMass: 0.628,

  frame: {
    layout: 'quad-x',
    armLength: 0.125,      // 中心 → ロータ軸 [m]
    motorHeight: 0.012,    // 機体中心からモータ取付面までの高さ
    rotorCant: 0,          // ロータの外向き傾斜 [deg]
    yawOffset: 0,          // レイアウト全体の回転 [deg]
    armScales: null,       // アームごとの長さ倍率 (非対称機体用)
    reverseSpin: false,
    coaxSpacing: 0.06,
    coaxEfficiency: 0.78,
    forceCoax: false,
    customAngles: null,
  },

  parts: {
    body: {
      shape: 'rounded-box',
      size: { x: 0.075, y: 0.032, z: 0.105 },
      offset: { x: 0, y: 0, z: 0 },
      mass: 0.16,
      material: mat('#23262b', 0.35, 0.42, { clearcoat: 0.5 }),
      accentMaterial: mat('#e0473c', 0.2, 0.4),
      accent: true,
    },
    arm: {
      shape: 'tube',
      thickness: 0.012,
      width: 0.014,
      offsetY: 0.002,
      taper: 0.7,
      mass: 0.018,
      material: mat('#1b1d21', 0.25, 0.35, { clearcoat: 0.6 }),
    },
    motor: {
      shape: 'bell',
      diameter: 0.028,
      height: 0.018,
      mass: 0.032,
      material: mat('#8d9299', 0.85, 0.28),
      bellMaterial: mat('#c8362f', 0.75, 0.3),
    },
    prop: {
      shape: '2blade',
      diameter: 0.127,       // 5 インチ
      pitch: 0.114,
      bladeWidth: 0.016,
      mass: 0.004,
      ct: 0.11,              // 推力係数
      cq: 0.0075,            // トルク係数
      spinVisual: 900,       // 見かけの回転速度上限 [rad/s] (描画のみ)
      material: mat('#d8dde3', 0.05, 0.5, { opacity: 0.85, transparent: true }),
      tipMaterial: mat('#ff6a00', 0.05, 0.5),
      tipMarker: true,
    },
    guard: {
      enabled: false,
      shape: 'ring',
      radiusScale: 1.12,
      thickness: 0.005,
      offsetY: 0.012,
      mass: 0.006,
      material: mat('#2f333a', 0.1, 0.6),
    },
    landingGear: {
      enabled: true,
      shape: 'leg',
      height: 0.045,
      spread: 0.075,
      count: 4,
      thickness: 0.006,
      mass: 0.02,
      material: mat('#16181b', 0.1, 0.7),
    },
    battery: {
      enabled: true,
      size: { x: 0.035, y: 0.022, z: 0.075 },
      offset: { x: 0, y: -0.022, z: 0.01 },
      mass: 0.19,
      material: mat('#12141a', 0.05, 0.35),
      labelMaterial: mat('#f2c200', 0.0, 0.6),
    },
    camera: {
      enabled: true,
      shape: 'box',
      size: 0.024,
      offset: { x: 0, y: 0.012, z: -0.055 },
      tilt: 0,               // 下向き正 [deg] (0 = 水平前方, 90 = 真下)
      mass: 0.012,
      material: mat('#0d0f12', 0.3, 0.35),
      lensMaterial: mat('#0a2540', 0.9, 0.08),
    },
    leds: {
      enabled: true,
      frontColor: '#ff2d2d',
      rearColor: '#27e04a',
      intensity: 2.5,
      blink: true,
      blinkHz: 2,
    },
    misc: {
      mass: 0.03,
      offset: { x: 0, y: 0.01, z: 0.02 },
    },
  },

  power: {
    cells: 4,
    voltage: 14.8,             // 公称電圧 (cells から自動計算も可)
    kv: 2400,                  // [rpm/V]
    capacityMah: 1300,
    internalResistance: 0.012, // [Ω/cell]
    motorEfficiency: 0.85,
    systemEfficiency: 0.72,
    avionicsPower: 3.0,
    usableFraction: 0.8,
    initialSoc: 1.0,
    tauUp: 0.045,              // モータ加速の時定数 [s]
    tauDown: 0.07,
    motorVariation: 0.02,      // 個体差 (標準偏差)
    rotorInertia: 6e-6,        // ロータ 1 基の慣性 [kg m^2] (ジャイロ効果用)
  },

  aero: {
    cdX: 1.1, cdY: 1.3, cdZ: 1.1,
    areaX: 0.010, areaY: 0.028, areaZ: 0.010,
    kh: 1.2e-5,              // ロータ抗力係数
    groundEffect: true,
    ceilingEffect: true,
    wallEffect: true,
    wallEffectGain: 0.05,
    translationalLift: true,
    vrs: true,
  },

  contact: {
    stiffness: 2400,
    damping: 55,
    tangentDamping: 40,
  },

  controller: { ...CONTROLLER_DEFAULTS, autoTune: true, tuningScale: 1.0 },
};

/** 深いマージ (配列と null はそのまま置き換え) */
export function deepMerge(base, override) {
  if (override === undefined) return clone(base);
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return clone(override);
  const out = Array.isArray(base) ? [] : { ...clone(base) };
  for (const k of Object.keys(override)) {
    const b = base ? base[k] : undefined;
    out[k] = (b && typeof b === 'object' && !Array.isArray(b))
      ? deepMerge(b, override[k])
      : clone(override[k]);
  }
  return out;
}

export function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const o = {};
  for (const k of Object.keys(v)) o[k] = clone(v[k]);
  return o;
}

/* ------------------------------------------------------------------ */
/* プリセット                                                           */
/* ------------------------------------------------------------------ */

export const PRESETS = {
  'toy-90mm': {
    name: 'トイドローン 90mm (ガード付き)',
    description: 'Tello クラス。87g・プロペラガード付きで屋内飛行の定番。カメラは前方固定。',
    totalMass: 0.101,
    frame: { layout: 'quad-x', armLength: 0.048, motorHeight: 0.006 },
    parts: {
      body: {
        shape: 'rounded-box', size: { x: 0.062, y: 0.020, z: 0.088 }, mass: 0.026,
        material: mat('#eceff3', 0.05, 0.45, { clearcoat: 0.7 }),
        accentMaterial: mat('#3d4450', 0.1, 0.5),
      },
      arm: { shape: 'flat', thickness: 0.005, width: 0.014, mass: 0.002, material: mat('#e6e9ee', 0.05, 0.5) },
      motor: { shape: 'coreless', diameter: 0.0085, height: 0.020, mass: 0.0045, material: mat('#2b2f36', 0.4, 0.4), bellMaterial: mat('#c9ccd2', 0.6, 0.35) },
      prop: {
        shape: '2blade', diameter: 0.076, pitch: 0.03, bladeWidth: 0.010, mass: 0.0009,
        ct: 0.105, cq: 0.009, material: mat('#20242a', 0.05, 0.55, { opacity: 0.9, transparent: true }),
        tipMaterial: mat('#f5f7fa', 0.05, 0.5),
      },
      guard: { enabled: true, shape: 'ring', radiusScale: 1.18, thickness: 0.004, mass: 0.0016, material: mat('#dfe3e8', 0.05, 0.55) },
      landingGear: { enabled: true, shape: 'pad', height: 0.012, spread: 0.03, count: 4, mass: 0.002, material: mat('#3a3f47', 0.05, 0.7) },
      battery: { enabled: true, size: { x: 0.03, y: 0.011, z: 0.048 }, offset: { x: 0, y: -0.014, z: 0.008 }, mass: 0.0245, material: mat('#23262c', 0.05, 0.4) },
      camera: { enabled: true, shape: 'box', size: 0.016, offset: { x: 0, y: 0.004, z: -0.042 }, tilt: 0, mass: 0.004, material: mat('#15181d', 0.2, 0.4) },
      misc: { mass: 0.008, offset: { x: 0, y: 0.006, z: 0 } },
    },
    power: { cells: 1, voltage: 3.8, kv: 8200, capacityMah: 1100, internalResistance: 0.09, tauUp: 0.03, tauDown: 0.05, rotorInertia: 3e-7 },
    aero: { areaX: 0.004, areaY: 0.010, areaZ: 0.004, kh: 3e-6 },
    controller: { maxSpeedXY: 1.2, maxClimbRate: 1.0, maxTilt: 25 * Math.PI / 180, maxThrustN: 2.5,
      ratePitch: { kp: 0.0035, ki: 0.004, kd: 0.00006 }, rateRoll: { kp: 0.0035, ki: 0.004, kd: 0.00006 },
      rateYaw: { kp: 0.005, ki: 0.004, kd: 0 }, torqueLimit: 0.05, rateILimit: 0.01 },
  },

  'nano-65mm': {
    name: 'ナノ機 65mm (Crazyflie クラス)',
    description: '27g の超小型機。狭い室内・群制御実験向け。慣性が小さく応答が速い。',
    totalMass: 0.037,
    frame: { layout: 'quad-x', armLength: 0.0325, motorHeight: 0.004 },
    parts: {
      body: { shape: 'plate', size: { x: 0.030, y: 0.006, z: 0.030 }, mass: 0.008, material: mat('#12331f', 0.1, 0.6), accentMaterial: mat('#d4af37', 0.9, 0.25) },
      arm: { shape: 'flat', thickness: 0.0025, width: 0.008, mass: 0.0008, material: mat('#12331f', 0.1, 0.6) },
      motor: { shape: 'coreless', diameter: 0.007, height: 0.016, mass: 0.0027, material: mat('#26292e', 0.4, 0.45), bellMaterial: mat('#b8bcc2', 0.7, 0.3) },
      prop: { shape: '2blade', diameter: 0.045, pitch: 0.02, bladeWidth: 0.007, mass: 0.0003, ct: 0.10, cq: 0.010,
        material: mat('#1c1f24', 0.05, 0.55, { opacity: 0.9, transparent: true }), tipMaterial: mat('#8ecbff', 0.05, 0.4) },
      guard: { enabled: false },
      landingGear: { enabled: true, shape: 'leg', height: 0.012, spread: 0.02, count: 4, thickness: 0.002, mass: 0.001, material: mat('#2b2e33', 0.05, 0.7) },
      battery: { enabled: true, size: { x: 0.018, y: 0.007, z: 0.026 }, offset: { x: 0, y: -0.008, z: 0 }, mass: 0.0075, material: mat('#1b1e24', 0.05, 0.4) },
      camera: { enabled: true, shape: 'cylinder', size: 0.010, offset: { x: 0, y: 0.006, z: -0.016 }, tilt: 0, mass: 0.002, material: mat('#0e1013', 0.2, 0.4) },
      leds: { enabled: true, frontColor: '#3aa0ff', rearColor: '#ff3a3a', intensity: 3, blink: true, blinkHz: 3 },
      misc: { mass: 0.003, offset: { x: 0, y: 0.004, z: 0 } },
    },
    power: { cells: 1, voltage: 3.7, kv: 14000, capacityMah: 250, internalResistance: 0.25, tauUp: 0.02, tauDown: 0.035, rotorInertia: 6e-8 },
    aero: { areaX: 0.0015, areaY: 0.004, areaZ: 0.0015, kh: 8e-7 },
    controller: { maxSpeedXY: 1.0, maxClimbRate: 0.8, maxTilt: 22 * Math.PI / 180, maxThrustN: 0.8,
      ratePitch: { kp: 0.0009, ki: 0.0012, kd: 0.000012 }, rateRoll: { kp: 0.0009, ki: 0.0012, kd: 0.000012 },
      rateYaw: { kp: 0.0012, ki: 0.001, kd: 0 }, torqueLimit: 0.012, rateILimit: 0.003, attGain: 12, posGain: 2.0 },
  },

  'cinewhoop-3inch': {
    name: 'シネフープ 3インチ (ダクテッド)',
    description: '全周ダクトで屋内でも安全。350g・重心が低く、映像取得に向く。',
    totalMass: 0.421,
    frame: { layout: 'quad-x', armLength: 0.077, motorHeight: 0.010 },
    parts: {
      body: { shape: 'rounded-box', size: { x: 0.060, y: 0.030, z: 0.080 }, mass: 0.075, material: mat('#101215', 0.2, 0.4, { clearcoat: 0.4 }), accentMaterial: mat('#00c2a8', 0.3, 0.35) },
      arm: { shape: 'box', thickness: 0.010, width: 0.020, mass: 0.008, material: mat('#101215', 0.2, 0.45) },
      motor: { shape: 'bell', diameter: 0.0225, height: 0.014, mass: 0.023, material: mat('#7f858d', 0.85, 0.3), bellMaterial: mat('#00c2a8', 0.7, 0.3) },
      prop: { shape: '3blade', diameter: 0.0762, pitch: 0.04, bladeWidth: 0.014, mass: 0.0022, ct: 0.125, cq: 0.011,
        material: mat('#e8ebef', 0.05, 0.5, { opacity: 0.9, transparent: true }), tipMaterial: mat('#00c2a8', 0.05, 0.4) },
      guard: { enabled: true, shape: 'duct', radiusScale: 1.10, thickness: 0.010, offsetY: 0.0, mass: 0.012, material: mat('#181b1f', 0.1, 0.65) },
      landingGear: { enabled: true, shape: 'skid', height: 0.028, spread: 0.055, count: 4, thickness: 0.005, mass: 0.012, material: mat('#0c0e11', 0.05, 0.75) },
      battery: { enabled: true, size: { x: 0.034, y: 0.024, z: 0.070 }, offset: { x: 0, y: -0.026, z: 0.006 }, mass: 0.105, material: mat('#0a0c10', 0.05, 0.35), labelMaterial: mat('#ff7a00', 0, 0.6) },
      camera: { enabled: true, shape: 'gimbal', size: 0.030, offset: { x: 0, y: -0.004, z: -0.048 }, tilt: 10, mass: 0.028, material: mat('#0d0f12', 0.3, 0.3) },
      misc: { mass: 0.02, offset: { x: 0, y: 0.012, z: 0.01 } },
    },
    power: { cells: 4, voltage: 14.8, kv: 3800, capacityMah: 850, internalResistance: 0.02, tauUp: 0.035, tauDown: 0.055, rotorInertia: 1.5e-6 },
    aero: { areaX: 0.008, areaY: 0.020, areaZ: 0.008, kh: 8e-6 },
    controller: { maxSpeedXY: 2.0, maxClimbRate: 1.5, maxTilt: 30 * Math.PI / 180, maxThrustN: 12,
      ratePitch: { kp: 0.018, ki: 0.02, kd: 0.0004 }, rateRoll: { kp: 0.018, ki: 0.02, kd: 0.0004 },
      rateYaw: { kp: 0.03, ki: 0.02, kd: 0 }, torqueLimit: 0.25 },
  },

  'freestyle-5inch': {
    name: 'フリースタイル 5インチ',
    description: '650g の一般的な FPV 機。推力重量比が高く俊敏。屋内では広めの空間向き。',
    // DEFAULT_VEHICLE がこの機体そのもの
  },

  'research-250': {
    name: '研究用 250mm (下向きカメラ)',
    description: '自己位置推定の実験機。下向きカメラ + ToF + オプティカルフローを想定した構成。',
    totalMass: 0.774,
    frame: { layout: 'quad-x', armLength: 0.125, motorHeight: 0.014 },
    parts: {
      body: { shape: 'box', size: { x: 0.090, y: 0.045, z: 0.110 }, mass: 0.18, material: mat('#2c3138', 0.4, 0.5), accentMaterial: mat('#f5a623', 0.2, 0.4) },
      arm: { shape: 'tapered', thickness: 0.014, width: 0.018, mass: 0.022, material: mat('#0f1114', 0.3, 0.35, { clearcoat: 0.5 }) },
      motor: { shape: 'bell', diameter: 0.030, height: 0.020, mass: 0.034, material: mat('#9aa0a7', 0.9, 0.25), bellMaterial: mat('#1f6feb', 0.8, 0.28) },
      prop: { shape: '3blade', diameter: 0.127, pitch: 0.114, bladeWidth: 0.015, mass: 0.005, ct: 0.115, cq: 0.0085,
        material: mat('#20242a', 0.05, 0.5, { opacity: 0.88, transparent: true }), tipMaterial: mat('#f5a623', 0.05, 0.45) },
      guard: { enabled: true, shape: 'octagon', radiusScale: 1.15, thickness: 0.006, mass: 0.010, material: mat('#3a4049', 0.1, 0.6) },
      landingGear: { enabled: true, shape: 'tube', height: 0.070, spread: 0.085, count: 4, thickness: 0.007, mass: 0.030, material: mat('#15181c', 0.1, 0.7) },
      battery: { enabled: true, size: { x: 0.036, y: 0.026, z: 0.080 }, offset: { x: 0, y: -0.034, z: 0.012 }, mass: 0.20, material: mat('#0d1014', 0.05, 0.35), labelMaterial: mat('#1f6feb', 0, 0.55) },
      camera: { enabled: true, shape: 'stereo', size: 0.028, offset: { x: 0, y: -0.022, z: 0.0 }, tilt: 90, mass: 0.030, material: mat('#101317', 0.3, 0.3) },
      leds: { enabled: true, frontColor: '#ffffff', rearColor: '#ff2d2d', intensity: 2, blink: false, blinkHz: 1 },
      misc: { mass: 0.05, offset: { x: 0, y: 0.02, z: 0.01 } },
    },
    power: { cells: 4, voltage: 14.8, kv: 2000, capacityMah: 2200, internalResistance: 0.012, tauUp: 0.05, tauDown: 0.08, rotorInertia: 8e-6 },
    controller: { maxSpeedXY: 1.5, maxClimbRate: 1.2, maxTilt: 25 * Math.PI / 180, maxThrustN: 22 },
  },

  'hexa-inspection': {
    name: 'ヘキサコプター 点検機',
    description: '1.8kg・6 発。1 基が停止しても飛行を継続できる冗長構成。',
    totalMass: 2.114,
    frame: { layout: 'hexa-x', armLength: 0.28, motorHeight: 0.018, rotorCant: 2 },
    parts: {
      body: { shape: 'cylinder', size: { x: 0.16, y: 0.06, z: 0.16 }, mass: 0.42, material: mat('#3b4048', 0.5, 0.4, { clearcoat: 0.3 }), accentMaterial: mat('#ffffff', 0.1, 0.4) },
      arm: { shape: 'tube', thickness: 0.018, width: 0.018, mass: 0.055, material: mat('#101216', 0.35, 0.3, { clearcoat: 0.6 }) },
      motor: { shape: 'bell', diameter: 0.042, height: 0.028, mass: 0.075, material: mat('#8f959c', 0.9, 0.25), bellMaterial: mat('#e03a3a', 0.85, 0.25) },
      prop: { shape: '2blade', diameter: 0.254, pitch: 0.114, bladeWidth: 0.024, mass: 0.014, ct: 0.10, cq: 0.007,
        material: mat('#101318', 0.05, 0.5, { opacity: 0.9, transparent: true }), tipMaterial: mat('#ffd400', 0.05, 0.45) },
      guard: { enabled: false, shape: 'ring', radiusScale: 1.08, thickness: 0.008, mass: 0.03, material: mat('#2b2f36', 0.1, 0.6) },
      landingGear: { enabled: true, shape: 'skid', height: 0.13, spread: 0.16, count: 4, thickness: 0.012, mass: 0.11, material: mat('#14171b', 0.1, 0.7) },
      battery: { enabled: true, size: { x: 0.07, y: 0.045, z: 0.14 }, offset: { x: 0, y: -0.05, z: 0 }, mass: 0.48, material: mat('#0b0d11', 0.05, 0.35), labelMaterial: mat('#e03a3a', 0, 0.55) },
      camera: { enabled: true, shape: 'gimbal', size: 0.055, offset: { x: 0, y: -0.055, z: -0.06 }, tilt: 25, mass: 0.12, material: mat('#0f1114', 0.3, 0.3) },
      misc: { mass: 0.12, offset: { x: 0, y: 0.02, z: 0 } },
    },
    power: { cells: 6, voltage: 22.2, kv: 420, capacityMah: 6000, internalResistance: 0.008, tauUp: 0.09, tauDown: 0.13, rotorInertia: 6e-5 },
    aero: { areaX: 0.045, areaY: 0.11, areaZ: 0.045, kh: 4e-5 },
    controller: { maxSpeedXY: 2.5, maxClimbRate: 2.0, maxTilt: 28 * Math.PI / 180, maxThrustN: 60,
      ratePitch: { kp: 0.35, ki: 0.35, kd: 0.012 }, rateRoll: { kp: 0.35, ki: 0.35, kd: 0.012 },
      rateYaw: { kp: 0.6, ki: 0.4, kd: 0 }, torqueLimit: 6, rateILimit: 1.0, attGain: 7 },
  },

  'x8-heavy': {
    name: 'X8 同軸反転 (重量物運搬)',
    description: '3.2kg・8 発の同軸反転機。コンパクトな寸法で大きな推力を得る構成。',
    totalMass: 3.62,
    frame: { layout: 'octa-coax', armLength: 0.30, motorHeight: 0.02, coaxSpacing: 0.09, coaxEfficiency: 0.78 },
    parts: {
      body: { shape: 'rounded-box', size: { x: 0.20, y: 0.09, z: 0.24 }, mass: 0.70, material: mat('#1a1d22', 0.4, 0.4), accentMaterial: mat('#ff9500', 0.2, 0.4) },
      arm: { shape: 'truss', thickness: 0.022, width: 0.030, mass: 0.09, material: mat('#0e1013', 0.35, 0.3, { clearcoat: 0.5 }) },
      motor: { shape: 'cylinder', diameter: 0.050, height: 0.030, mass: 0.11, material: mat('#7d838a', 0.9, 0.25), bellMaterial: mat('#ff9500', 0.8, 0.3) },
      prop: { shape: '2blade', diameter: 0.33, pitch: 0.14, bladeWidth: 0.030, mass: 0.020, ct: 0.098, cq: 0.0072,
        material: mat('#0d1015', 0.05, 0.5, { opacity: 0.9, transparent: true }), tipMaterial: mat('#ff9500', 0.05, 0.45) },
      landingGear: { enabled: true, shape: 'tube', height: 0.20, spread: 0.20, count: 4, thickness: 0.016, mass: 0.22, material: mat('#0e1013', 0.1, 0.7) },
      battery: { enabled: true, size: { x: 0.09, y: 0.06, z: 0.18 }, offset: { x: 0, y: -0.07, z: 0 }, mass: 0.95, material: mat('#08090c', 0.05, 0.35) },
      camera: { enabled: true, shape: 'dome', size: 0.07, offset: { x: 0, y: -0.075, z: -0.05 }, tilt: 30, mass: 0.15, material: mat('#101317', 0.3, 0.3) },
      misc: { mass: 0.2, offset: { x: 0, y: 0.02, z: 0 } },
    },
    power: { cells: 6, voltage: 22.2, kv: 340, capacityMah: 10000, internalResistance: 0.006, tauUp: 0.11, tauDown: 0.16, rotorInertia: 1.4e-4 },
    aero: { areaX: 0.07, areaY: 0.16, areaZ: 0.07, kh: 7e-5 },
    controller: { maxSpeedXY: 2.5, maxClimbRate: 2.0, maxTilt: 25 * Math.PI / 180, maxThrustN: 110,
      ratePitch: { kp: 0.9, ki: 0.9, kd: 0.03 }, rateRoll: { kp: 0.9, ki: 0.9, kd: 0.03 },
      rateYaw: { kp: 1.4, ki: 1.0, kd: 0 }, torqueLimit: 14, rateILimit: 2.5, attGain: 6 },
  },

  'tricopter': {
    name: 'トライコプター (テールサーボ)',
    description: '3 発 + テールサーボでヨーを作る構成。非対称機体の推定実験に。',
    totalMass: 0.539,
    frame: { layout: 'tri', armLength: 0.16, motorHeight: 0.012 },
    parts: {
      body: { shape: 'wedge', size: { x: 0.07, y: 0.035, z: 0.12 }, mass: 0.13, material: mat('#4a2f6b', 0.3, 0.45), accentMaterial: mat('#c9a7ff', 0.2, 0.4) },
      arm: { shape: 'box', thickness: 0.012, width: 0.016, mass: 0.02, material: mat('#241735', 0.25, 0.45) },
      motor: { shape: 'bell', diameter: 0.028, height: 0.018, mass: 0.032, material: mat('#9aa0a7', 0.85, 0.3), bellMaterial: mat('#8a5cf6', 0.75, 0.3) },
      prop: { shape: '2blade', diameter: 0.203, pitch: 0.10, bladeWidth: 0.020, mass: 0.007, ct: 0.105, cq: 0.0078,
        material: mat('#1a1d24', 0.05, 0.5, { opacity: 0.88, transparent: true }), tipMaterial: mat('#c9a7ff', 0.05, 0.45) },
      landingGear: { enabled: true, shape: 'leg', height: 0.06, spread: 0.09, count: 3, thickness: 0.006, mass: 0.02, material: mat('#1b1226', 0.1, 0.7) },
      battery: { enabled: true, size: { x: 0.034, y: 0.024, z: 0.075 }, offset: { x: 0, y: -0.028, z: 0.01 }, mass: 0.16, material: mat('#0d0a12', 0.05, 0.35) },
      camera: { enabled: true, shape: 'box', size: 0.024, offset: { x: 0, y: 0.008, z: -0.055 }, tilt: 5, mass: 0.012, material: mat('#0d0f12', 0.3, 0.35) },
      misc: { mass: 0.04, offset: { x: 0, y: 0.012, z: 0.02 } },
    },
    power: { cells: 3, voltage: 11.1, kv: 1200, capacityMah: 1800, internalResistance: 0.02, tauUp: 0.055, tauDown: 0.085, rotorInertia: 1.6e-5 },
    controller: { maxSpeedXY: 1.8, maxClimbRate: 1.4, maxTilt: 28 * Math.PI / 180, maxThrustN: 16,
      ratePitch: { kp: 0.05, ki: 0.05, kd: 0.0015 }, rateRoll: { kp: 0.05, ki: 0.05, kd: 0.0015 },
      rateYaw: { kp: 0.09, ki: 0.05, kd: 0 }, torqueLimit: 0.8 },
  },
};

/** プリセット名から完全な機体設定を作る */
export function buildVehicle(presetKey) {
  const preset = PRESETS[presetKey] || {};
  const v = deepMerge(DEFAULT_VEHICLE, preset);
  v.preset = presetKey;
  // セル数から公称電圧を更新 (プリセットが明示していれば尊重)
  if (preset.power && preset.power.voltage == null && preset.power.cells != null) {
    v.power.voltage = preset.power.cells * 3.7;
  }
  return v;
}

export const PRESET_KEYS = Object.keys(PRESETS);

/** その他の設定 (シミュレーション全体) のデフォルト */
export const SIM_DEFAULTS = {
  physicsRate: 500,        // [Hz] 物理ステップ
  controlRate: 250,        // [Hz] 制御則の実行レート
  integrator: 'rk4',       // 'rk4' | 'euler'
  timeScale: 1.0,
  seed: 20240101,
  crashAccel: 150,         // [m/s^2] これを超える衝撃で墜落判定
  textureQuality: 1.0,     // オプティカルフローの効き (床のテクスチャ量)
  useEstimatedState: false, // true にすると推定 (ノイズ入り) 状態で制御する
  estimator: { posNoise: 0.02, velNoise: 0.05, gyroNoise: 0.01 },
  wind: {
    enabled: true,
    speed: 0.12,
    direction: 45,
    turbulence: 0.10,
    turbulenceTimeConstant: 1.2,
    boundaryLayer: 0.6,
    vents: [],
  },
  sensors: { ...SENSOR_DEFAULTS },
  trajectory: { ...TRAJECTORY_DEFAULTS },
};
