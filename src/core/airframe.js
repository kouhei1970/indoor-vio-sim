/**
 * 機体構成 (フレーム形状 + パーツ) から
 *   - ロータ配置 (位置・回転方向・推力軸)
 *   - 質量・重心・慣性テンソル
 * を組み立てるモジュール。
 *
 * 見た目 (パーツの形・寸法) と物理パラメータが同じ設定から導かれるため、
 * 「アームを伸ばしたら慣性モーメントも増える」といった一貫した挙動になる。
 *
 * 機体座標 B: x = 右, y = 上, z = 後方 (前方 = -z)
 * 方位角 ψ  : 前方 (-z) を 0 とし、上から見て反時計回り (左) が正
 *             位置 = L * (-sinψ, 0, -cosψ)
 */

import { v3, m3diag, m3add, inertiaOffset, DEG, clamp } from './math.js';
import { cellMeanOcv } from './motor.js';

/** 上から見て 反時計回り = +1 (CCW), 時計回り = -1 (CW) */
export const CCW = 1;
export const CW = -1;

/**
 * レイアウト定義。angles は方位角[deg]、spins は各ロータの回転方向。
 * coax: true のとき各アームに上下2基 (X8/コアキシャル) を配置する。
 */
export const LAYOUTS = {
  'quad-x': { arms: 4, angles: [45, 135, 225, 315], spins: [CW, CCW, CW, CCW], label: 'クアッド X' },
  'quad-plus': { arms: 4, angles: [0, 90, 180, 270], spins: [CW, CCW, CW, CCW], label: 'クアッド +' },
  'quad-h': { arms: 4, angles: [35, 145, 215, 325], spins: [CW, CCW, CW, CCW], label: 'クアッド H' },
  'deadcat': { arms: 4, angles: [55, 125, 235, 305], spins: [CW, CCW, CW, CCW], label: 'デッドキャット' },
  'tri': { arms: 3, angles: [60, 180, 300], spins: [CW, CCW, CW], tailServo: 1, label: 'トライコプター' },
  'hexa-x': { arms: 6, angles: [30, 90, 150, 210, 270, 330], spins: [CW, CCW, CW, CCW, CW, CCW], label: 'ヘキサ X' },
  'hexa-plus': { arms: 6, angles: [0, 60, 120, 180, 240, 300], spins: [CW, CCW, CW, CCW, CW, CCW], label: 'ヘキサ +' },
  'octa-x': {
    arms: 8, angles: [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5],
    spins: [CW, CCW, CW, CCW, CW, CCW, CW, CCW], label: 'オクタ X',
  },
  'octa-coax': { arms: 4, angles: [45, 135, 225, 315], spins: [CW, CCW, CW, CCW], coax: true, label: 'X8 (同軸反転)' },
};

/**
 * ロータ配置を解決する。
 * @param {object} frame 機体設定の frame セクション
 * @returns {Array} rotors
 */
export function resolveLayout(frame) {
  const def = LAYOUTS[frame.layout] || LAYOUTS['quad-x'];
  const n = def.arms;
  const angles = frame.customAngles && frame.customAngles.length === n
    ? frame.customAngles
    : def.angles;
  const rotors = [];
  const armLen = frame.armLength;
  const yOff = frame.motorHeight ?? 0.01;

  for (let i = 0; i < n; i++) {
    const psi = (angles[i] + (frame.yawOffset || 0)) * DEG;
    // アーム毎の長さスケール (H フレームや非対称機体の表現に使う)
    const scale = frame.armScales && frame.armScales[i] != null ? frame.armScales[i] : 1;
    const L = armLen * scale;
    const pos = v3(-L * Math.sin(psi), yOff, -L * Math.cos(psi));
    const base = {
      index: rotors.length,
      arm: i,
      azimuth: psi,
      armLength: L,
      position: pos,
      spin: def.spins[i % def.spins.length] * (frame.reverseSpin ? -1 : 1),
      // 推力軸 (機体座標)。ロータ傾斜 (dihedral / cant) を反映
      cant: (frame.rotorCant || 0) * DEG,
      tiltable: def.tailServo != null && i === def.tailServo,
      coaxLevel: 0,
    };
    rotors.push(base);
    if (def.coax || frame.forceCoax) {
      rotors.push({
        ...base,
        index: rotors.length,
        position: v3(pos.x, pos.y - (frame.coaxSpacing ?? 0.06), pos.z),
        spin: -base.spin,
        coaxLevel: 1,
        // 下側ロータは上側の吹き下ろしの中にあるため効率が落ちる
        efficiency: frame.coaxEfficiency ?? 0.78,
      });
    }
  }
  // 推力軸を計算 (cant は機体中心から外向きに傾ける)
  for (const r of rotors) {
    const outward = v3(Math.sin(-r.azimuth), 0, -Math.cos(r.azimuth));
    // 実際には position 方向へ傾ける
    const px = r.position.x, pz = r.position.z;
    const pl = Math.hypot(px, pz) || 1;
    const ux = px / pl, uz = pz / pl;
    const c = Math.cos(r.cant), s = Math.sin(r.cant);
    r.axis = v3(ux * s, c, uz * s);
    void outward;
    if (r.efficiency == null) r.efficiency = 1;
  }
  return rotors;
}

/* ------------------------------------------------------------------ */
/* 慣性テンソル (機体座標, 重心まわり)                                   */
/* ------------------------------------------------------------------ */

/** 直方体 (幅x, 高さy, 奥行z) */
export const inertiaBox = (m, sx, sy, sz) => m3diag(
  (m / 12) * (sy * sy + sz * sz),
  (m / 12) * (sx * sx + sz * sz),
  (m / 12) * (sx * sx + sy * sy),
);

/** 円柱 (中心軸は y) */
export const inertiaCylinderY = (m, r, h) => m3diag(
  (m / 12) * (3 * r * r + h * h),
  0.5 * m * r * r,
  (m / 12) * (3 * r * r + h * h),
);

/** 円柱 (中心軸は水平方向、方位角 psi のアーム) */
export function inertiaRodAlongAzimuth(m, len, radius, psi) {
  // 長さ方向の慣性は 1/2 m r^2、直交方向は 1/12 m L^2
  const Ilong = 0.5 * m * radius * radius;
  const Iperp = (m / 12) * (len * len) + 0.25 * m * radius * radius;
  // 長手方向の単位ベクトル
  const ux = -Math.sin(psi), uz = -Math.cos(psi);
  // I = Iperp * E + (Ilong - Iperp) * u u^T
  const d = Ilong - Iperp;
  return [
    Iperp + d * ux * ux, 0, d * ux * uz,
    0, Iperp, 0,
    d * uz * ux, 0, Iperp + d * uz * uz,
  ];
}

/** 球 */
export const inertiaSphere = (m, r) => m3diag(0.4 * m * r * r, 0.4 * m * r * r, 0.4 * m * r * r);

/** 薄い円板 (プロペラ, 軸 y) */
export const inertiaDiscY = (m, r) => m3diag(0.25 * m * r * r, 0.5 * m * r * r, 0.25 * m * r * r);

/**
 * 全パーツから質量特性を計算する。
 * @returns {{mass, com, inertia, breakdown}}
 */
export function computeMassProperties(config) {
  const rotors = resolveLayout(config.frame);
  const p = config.parts;
  const items = []; // {name, mass, pos, I(重心まわり)}

  const push = (name, mass, pos, I) => {
    if (mass > 0) items.push({ name, mass, pos, I });
  };

  // 本体
  const b = p.body;
  const bodyPos = v3(b.offset.x, b.offset.y, b.offset.z);
  let bodyI;
  if (b.shape === 'cylinder' || b.shape === 'dome') {
    bodyI = inertiaCylinderY(b.mass, b.size.x / 2, b.size.y);
  } else if (b.shape === 'sphere') {
    bodyI = inertiaSphere(b.mass, Math.max(b.size.x, b.size.z) / 2);
  } else {
    bodyI = inertiaBox(b.mass, b.size.x, b.size.y, b.size.z);
  }
  push('body', b.mass, bodyPos, bodyI);

  // アーム (ロータ 1 本につき 1 本、コアキシャルは共有)
  const armsSeen = new Set();
  for (const r of rotors) {
    if (armsSeen.has(r.arm)) continue;
    armsSeen.add(r.arm);
    const len = r.armLength;
    const pos = v3(r.position.x / 2, p.arm.offsetY, r.position.z / 2);
    push(`arm${r.arm}`, p.arm.mass, pos,
      inertiaRodAlongAzimuth(p.arm.mass, len, Math.max(p.arm.thickness, p.arm.width) / 2, r.azimuth));
  }

  // モータ + プロペラ
  for (const r of rotors) {
    push(`motor${r.index}`, p.motor.mass, r.position,
      inertiaCylinderY(p.motor.mass, p.motor.diameter / 2, p.motor.height));
    push(`prop${r.index}`, p.prop.mass,
      v3(r.position.x, r.position.y + p.motor.height * 0.6, r.position.z),
      inertiaDiscY(p.prop.mass, p.prop.diameter / 2));
  }

  // バッテリー
  if (p.battery.enabled) {
    push('battery', p.battery.mass,
      v3(p.battery.offset.x, p.battery.offset.y, p.battery.offset.z),
      inertiaBox(p.battery.mass, p.battery.size.x, p.battery.size.y, p.battery.size.z));
  }

  // カメラ / センサ
  if (p.camera.enabled) {
    push('camera', p.camera.mass,
      v3(p.camera.offset.x, p.camera.offset.y, p.camera.offset.z),
      inertiaBox(p.camera.mass, p.camera.size, p.camera.size, p.camera.size));
  }

  // プロペラガード
  if (p.guard.enabled) {
    for (const r of rotors) {
      if (r.coaxLevel > 0) continue;
      const gr = (p.prop.diameter / 2) * (p.guard.radiusScale ?? 1.15);
      push(`guard${r.arm}`, p.guard.mass,
        v3(r.position.x, r.position.y + p.guard.offsetY, r.position.z),
        inertiaDiscY(p.guard.mass, gr)); // リングは円板より外周寄りだが近似
    }
  }

  // 脚
  if (p.landingGear.enabled) {
    const nLeg = Math.max(2, p.landingGear.count ?? 4);
    for (let i = 0; i < nLeg; i++) {
      const psi = (i / nLeg) * Math.PI * 2 + Math.PI / nLeg;
      const rr = p.landingGear.spread;
      push(`leg${i}`, p.landingGear.mass / nLeg,
        v3(-rr * Math.sin(psi), -p.landingGear.height / 2, -rr * Math.cos(psi)),
        inertiaBox(p.landingGear.mass / nLeg, 0.01, p.landingGear.height, 0.01));
    }
  }

  // その他 (FC, ESC, 配線などをまとめた「その他質量」)
  push('misc', p.misc.mass, v3(p.misc.offset.x, p.misc.offset.y, p.misc.offset.z),
    inertiaBox(p.misc.mass, 0.05, 0.02, 0.05));

  // ---- 合計 ----
  let mass = 0;
  let cx = 0, cy = 0, cz = 0;
  for (const it of items) {
    mass += it.mass;
    cx += it.mass * it.pos.x; cy += it.mass * it.pos.y; cz += it.mass * it.pos.z;
  }
  if (mass <= 0) mass = 1e-3;
  const com = v3(cx / mass, cy / mass, cz / mass);

  let I = m3diag(0, 0, 0);
  for (const it of items) {
    const r = v3(it.pos.x - com.x, it.pos.y - com.y, it.pos.z - com.z);
    I = m3add(I, it.I);
    I = m3add(I, inertiaOffset(it.mass, r));
  }

  // 質量スケーリング: 総質量を手動指定した場合はパーツ質量を比例配分
  let scale = 1;
  if (config.massMode === 'manual' && config.totalMass > 0) {
    scale = config.totalMass / mass;
    mass = config.totalMass;
    I = I.map((v) => v * scale);
  }

  // 慣性テンソルの手動指定。
  // 実機を振り子法などで計測した値がある場合は、パーツからの推定より
  // そちらを使ったほうが姿勢応答が実機に一致する。
  // inertia は機体の慣用的な軸 (ロール/ピッチ/ヨー) で与え、
  // ここで内部座標 (x=右, y=上, z=後) の対角成分へ並べ替える。
  let inertiaSource = 'parts';
  if (config.inertiaMode === 'manual' && config.inertia) {
    const { roll, pitch, yaw } = config.inertia;
    if (roll > 0 && pitch > 0 && yaw > 0) {
      I = m3diag(pitch, yaw, roll);
      inertiaSource = 'manual';
    }
  }

  return {
    mass,
    com,
    inertia: I,
    inertiaSource,
    breakdown: items.map((it) => ({ name: it.name, mass: it.mass * scale })),
    rotors,
  };
}

/**
 * ロータの空力係数と最大回転数を計算する。
 * 推力 T = ct * rho * n^2 * D^4   [N]   (n: rev/s, D: 直径[m])
 * 反トルク Q = cq * rho * n^2 * D^5 [Nm]
 */
export function rotorCoefficients(propCfg, powerCfg, air) {
  const D = propCfg.diameter;
  const rho = air.density;
  const kT = propCfg.ct * rho * Math.pow(D, 4);       // T = kT * n^2
  const kQ = propCfg.cq * rho * Math.pow(D, 5);       // Q = kQ * n^2
  const rpmMax = powerCfg.kv * powerCfg.voltage * (powerCfg.motorEfficiency ?? 0.85);
  const nMax = rpmMax / 60;
  return { kT, kQ, nMax, rpmMax, D };
}

/**
 * ホバリングに必要なスロットル比などの指標を返す (UI 表示・妥当性チェック用)。
 */
export function performanceSummary(config, massProps, air, g = 9.80665) {
  const { kT, nMax } = rotorCoefficients(config.parts.prop, config.power, air);
  const nRotors = massProps.rotors.length;
  const effSum = massProps.rotors.reduce((s, r) => s + r.efficiency, 0);
  const thrustMax = kT * nMax * nMax * effSum;
  const weight = massProps.mass * g;
  const twr = thrustMax / Math.max(weight, 1e-6);
  const hoverN = Math.sqrt(weight / Math.max(kT * effSum, 1e-9));
  const hoverThrottle = clamp(hoverN / Math.max(nMax, 1e-9), 0, 2);
  // 単純なホバリング時間推定 (電力 = トルク×角速度 / 効率)
  const { kQ } = rotorCoefficients(config.parts.prop, config.power, air);
  const hoverPower = nRotors * (kQ * hoverN * hoverN) * (2 * Math.PI * hoverN)
    / (config.power.systemEfficiency ?? 0.7) + (config.power.avionicsPower ?? 2.0);
  // 電池の定格は電荷 [Ah] なので、ホバリング電流で割って持続時間を出す。
  // 高電圧型 (LiHV) は同じ電力でも電流が小さくなり、そのぶん長く飛べる。
  const cells = config.power.cells ?? 1;
  const packOcv = cells * cellMeanOcv(config.power.cellFull);
  const R = (config.power.internalResistance ?? 0.03) * cells;
  const disc = packOcv * packOcv - 4 * R * hoverPower;
  const hoverCurrent = disc > 0 ? (packOcv - Math.sqrt(disc)) / (2 * R) : packOcv / (2 * R);
  const capacityAh = (config.power.capacityMah ?? 0) / 1000;
  const hoverMinutes = hoverCurrent > 0.01
    ? (capacityAh * (config.power.usableFraction ?? 0.8)) / hoverCurrent * 60 : 0;
  return {
    nRotors, thrustMax, weight, twr, hoverThrottle, hoverPower, hoverCurrent, hoverMinutes,
    diskLoading: weight / (nRotors * Math.PI * Math.pow(config.parts.prop.diameter / 2, 2)),
  };
}
