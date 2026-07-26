/**
 * 機体の 3D モデルをパーツ設定から組み立てる。
 *
 * ここで作る形状は、物理側 (airframe.js) が慣性計算に使う形状と同じ設定から
 * 生成されるので、見た目とパラメータが常に一致する。
 *
 * 対応している形状
 *   ボディ : box / rounded-box / cylinder / sphere / plate / wedge / dome
 *   アーム : tube / box / tapered / flat / truss
 *   モータ : bell / cylinder / box / coreless
 *   プロペラ: 2blade / 3blade / 4blade / disc / ducted
 *   ガード : ring / octagon / cage / duct / bumper
 *   脚     : skid / leg / tube / ring / pad
 *   カメラ : box / cylinder / dome / gimbal / stereo
 *
 * 各パーツは独立したマテリアル (色・金属度・粗さ・クリアコート・発光) を持つ。
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { resolveLayout } from '../core/airframe.js';
import { DEG } from '../core/math.js';

const PI = Math.PI;

/** 設定のマテリアル記述から three.js のマテリアルを作る */
export function makeMaterial(cfg, extra = {}) {
  const params = {
    color: new THREE.Color(cfg.color ?? '#888888'),
    metalness: cfg.metalness ?? 0.2,
    roughness: cfg.roughness ?? 0.5,
    transparent: cfg.transparent ?? false,
    opacity: cfg.opacity ?? 1,
    side: cfg.transparent ? THREE.DoubleSide : THREE.FrontSide,
    ...extra,
  };
  if (cfg.emissive && cfg.emissive !== '#000000') {
    params.emissive = new THREE.Color(cfg.emissive);
    params.emissiveIntensity = cfg.emissiveIntensity ?? 1;
  }
  if ((cfg.clearcoat ?? 0) > 0) {
    return new THREE.MeshPhysicalMaterial({
      ...params, clearcoat: cfg.clearcoat, clearcoatRoughness: 0.15,
    });
  }
  return new THREE.MeshStandardMaterial(params);
}

/**
 * プロペラブレード 1 枚のジオメトリ。
 * 半径方向にコード長とねじり角 (ピッチ) を変えた薄いリボンを作る。
 */
function bladeGeometry(radius, hubRadius, chord, pitch, segments = 14) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const thickness = chord * 0.09;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const r = hubRadius + (radius - hubRadius) * t;
    // 翼弦長: 根元は細く、中央で最大、先端で細くなる
    const c = chord * (0.45 + 0.75 * Math.sin(PI * Math.pow(t, 0.75)));
    // ねじり角: 根元ほど大きい (一定ピッチのプロペラ)
    const theta = Math.atan2(pitch, 2 * PI * Math.max(r, hubRadius));
    const ct = Math.cos(theta), st = Math.sin(theta);
    // 前縁・後縁 (機体座標では x が半径方向, z が翼弦方向, y が厚み方向)
    for (const s of [-0.5, 0.5]) {
      const zc = s * c;
      positions.push(r, zc * st, zc * ct);
      normals.push(0, ct, -st);
      uvs.push(t, s + 0.5);
    }
    // 厚みを持たせるため裏面も
    for (const s of [-0.5, 0.5]) {
      const zc = s * c;
      positions.push(r, zc * st - thickness * ct, zc * ct + thickness * st);
      normals.push(0, -ct, st);
      uvs.push(t, s + 0.5);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 4, b = (i + 1) * 4;
    indices.push(a, b, a + 1, b, b + 1, a + 1);          // 上面
    indices.push(a + 2, a + 3, b + 2, b + 2, a + 3, b + 3); // 下面
    indices.push(a, a + 2, b, b, a + 2, b + 2);          // 前縁
    indices.push(a + 1, b + 1, a + 3, b + 1, b + 3, a + 3); // 後縁
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export class DroneBuilder {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'drone';
    this.propAssemblies = [];
    this.leds = [];
    this.cameraMount = new THREE.Object3D();
    this.cameraMount.name = 'cameraMount';
    this.group.add(this.cameraMount);
    this.materials = [];
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
    this.group.clear();
    this.group.add(this.cameraMount);
    this.propAssemblies.length = 0;
    this.leds.length = 0;
  }

  /**
   * 機体設定からモデルを組み立てる。
   * @param {object} cfg 機体設定
   * @param {{x,y,z}} com 重心 (モデルを重心基準に配置するため)
   */
  build(cfg, com = { x: 0, y: 0, z: 0 }) {
    this.dispose();
    this.cfg = cfg;
    const rotors = resolveLayout(cfg.frame);
    const p = cfg.parts;

    // 全体を重心が原点に来るようにオフセットする
    const body = new THREE.Group();
    body.position.set(-com.x, -com.y, -com.z);
    this.group.add(body);
    this.bodyGroup = body;

    this.buildBody(body, p);
    this.buildArms(body, p, rotors, cfg.frame);
    this.buildMotorsAndProps(body, p, rotors);
    this.buildGuards(body, p, rotors);
    this.buildLandingGear(body, p);
    this.buildBattery(body, p);
    this.buildCamera(body, p, com);
    this.buildLeds(body, p);

    this.group.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return this.group;
  }

  /* ------------------------------------------------------------ */

  buildBody(parent, p) {
    const b = p.body;
    const mat = makeMaterial(b.material);
    const { x: sx, y: sy, z: sz } = b.size;
    let geo;
    switch (b.shape) {
      case 'rounded-box':
        geo = new RoundedBoxGeometry(sx, sy, sz, 3, Math.min(sx, sy, sz) * 0.28);
        break;
      case 'cylinder':
        geo = new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 28);
        break;
      case 'sphere':
        geo = new THREE.SphereGeometry(Math.max(sx, sz) / 2, 24, 16);
        geo.scale(1, sy / Math.max(sx, sz), 1);
        break;
      case 'plate':
        geo = new THREE.BoxGeometry(sx, sy, sz);
        break;
      case 'dome':
        geo = new THREE.SphereGeometry(sx / 2, 24, 12, 0, PI * 2, 0, PI / 2);
        geo.scale(1, (sy * 2) / sx, sz / sx);
        break;
      case 'wedge': {
        // 前方が低く後方が高いくさび形
        const shape = new THREE.Shape();
        shape.moveTo(-sz / 2, -sy / 2);
        shape.lineTo(sz / 2, -sy / 2);
        shape.lineTo(sz / 2, sy / 2);
        shape.lineTo(-sz / 2, sy * 0.05);
        shape.closePath();
        geo = new THREE.ExtrudeGeometry(shape, { depth: sx, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003, bevelSegments: 2 });
        geo.rotateY(PI / 2);
        geo.translate(sx / 2, 0, 0);
        break;
      }
      case 'box':
      default:
        geo = new THREE.BoxGeometry(sx, sy, sz);
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(b.offset.x, b.offset.y, b.offset.z);
    mesh.name = 'body';
    parent.add(mesh);
    this.bodyMesh = mesh;

    // アクセント (上面のキャノピー / ストライプ)
    if (b.accent && b.accentMaterial) {
      const am = makeMaterial(b.accentMaterial);
      const cap = new THREE.Mesh(
        new RoundedBoxGeometry(sx * 0.62, sy * 0.45, sz * 0.5, 2, Math.min(sx, sy) * 0.15), am);
      cap.position.set(b.offset.x, b.offset.y + sy * 0.5, b.offset.z - sz * 0.1);
      parent.add(cap);
      this.accentMesh = cap;
    }
  }

  buildArms(parent, p, rotors, frame) {
    const a = p.arm;
    const mat = makeMaterial(a.material);
    const seen = new Set();
    for (const r of rotors) {
      if (seen.has(r.arm)) continue;
      seen.add(r.arm);
      const len = r.armLength;
      const g = new THREE.Group();
      const th = a.thickness, w = a.width;
      let mesh;
      switch (a.shape) {
        case 'box':
          mesh = new THREE.Mesh(new THREE.BoxGeometry(w, th, len), mat);
          mesh.position.z = -len / 2;
          break;
        case 'flat':
          mesh = new THREE.Mesh(new THREE.BoxGeometry(w, th, len), mat);
          mesh.position.z = -len / 2;
          break;
        case 'tapered': {
          const geo = new THREE.CylinderGeometry(th / 2, (th / 2) * (a.taper ?? 0.7), len, 12);
          geo.rotateX(PI / 2);
          mesh = new THREE.Mesh(geo, mat);
          mesh.position.z = -len / 2;
          break;
        }
        case 'truss': {
          // 上下 2 本の桁 + 斜材
          const gg = new THREE.Group();
          for (const sy of [-1, 1]) {
            const bar = new THREE.Mesh(new THREE.BoxGeometry(w * 0.35, th * 0.5, len), mat);
            bar.position.set(0, sy * th * 0.6, -len / 2);
            gg.add(bar);
          }
          const n = Math.max(2, Math.round(len / 0.08));
          for (let i = 0; i < n; i++) {
            const d = new THREE.Mesh(new THREE.BoxGeometry(w * 0.2, th * 1.4, th * 0.35), mat);
            d.position.set(0, 0, -((i + 0.5) / n) * len);
            d.rotation.x = (i % 2 ? 1 : -1) * 0.6;
            gg.add(d);
          }
          mesh = gg;
          break;
        }
        case 'tube':
        default: {
          const geo = new THREE.CylinderGeometry(th / 2, th / 2, len, 14);
          geo.rotateX(PI / 2);
          mesh = new THREE.Mesh(geo, mat);
          mesh.position.z = -len / 2;
        }
      }
      g.add(mesh);
      g.position.y = a.offsetY ?? 0;
      // アームの向き: 方位角 psi の方向 (前方 -z を基準に反時計回り)
      g.rotation.y = r.azimuth;
      parent.add(g);
      void frame;
    }
  }

  buildMotorsAndProps(parent, p, rotors) {
    const m = p.motor;
    const motorMat = makeMaterial(m.material);
    const bellMat = makeMaterial(m.bellMaterial || m.material);
    const propMat = makeMaterial(p.prop.material);
    const tipMat = makeMaterial(p.prop.tipMaterial || p.prop.material);
    const R = p.prop.diameter / 2;

    for (const r of rotors) {
      const grp = new THREE.Group();
      grp.position.set(r.position.x, r.position.y, r.position.z);
      const flip = r.coaxLevel > 0 ? -1 : 1;   // 同軸下側は上下反転

      // --- モータ ---
      const md = m.diameter, mh = m.height;
      switch (m.shape) {
        case 'box':
          grp.add(new THREE.Mesh(new THREE.BoxGeometry(md, mh, md), motorMat));
          break;
        case 'coreless': {
          const c = new THREE.Mesh(new THREE.CylinderGeometry(md / 2, md / 2, mh, 14), motorMat);
          c.position.y = flip * mh / 2;
          grp.add(c);
          break;
        }
        case 'cylinder': {
          const c = new THREE.Mesh(new THREE.CylinderGeometry(md / 2, md / 2, mh, 20), motorMat);
          c.position.y = flip * mh / 2;
          grp.add(c);
          break;
        }
        case 'bell':
        default: {
          // ステータ (下) + ベル (上)
          const stator = new THREE.Mesh(new THREE.CylinderGeometry(md * 0.36, md * 0.4, mh * 0.45, 18), motorMat);
          stator.position.y = flip * mh * 0.22;
          grp.add(stator);
          const bell = new THREE.Mesh(new THREE.CylinderGeometry(md / 2, md * 0.46, mh * 0.62, 20), bellMat);
          bell.position.y = flip * mh * 0.7;
          grp.add(bell);
          // 冷却穴の表現 (細いリング)
          const ring = new THREE.Mesh(new THREE.TorusGeometry(md * 0.47, md * 0.03, 6, 20), motorMat);
          ring.rotation.x = PI / 2;
          ring.position.y = flip * mh * 0.7;
          grp.add(ring);
        }
      }

      // --- プロペラ (回転する部分) ---
      const propGroup = new THREE.Group();
      propGroup.position.y = flip * (mh * 1.05);
      const shape = p.prop.shape;
      const nBlades = shape === '3blade' ? 3 : shape === '4blade' ? 4
        : shape === 'ducted' ? 5 : 2;   // ダクテッドファンは多翼

      if (shape === 'disc') {
        const disc = new THREE.Mesh(
          new THREE.CylinderGeometry(R, R, 0.002, 32),
          makeMaterial({ ...p.prop.material, transparent: true, opacity: 0.35 }));
        propGroup.add(disc);
      } else {
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.10, R * 0.12, 0.008, 14), tipMat);
        propGroup.add(hub);
        for (let i = 0; i < nBlades; i++) {
          const geo = bladeGeometry(R, R * 0.11, p.prop.bladeWidth ?? R * 0.24,
            (p.prop.pitch ?? R) * (r.spin > 0 ? 1 : -1));
          const blade = new THREE.Mesh(geo, propMat);
          blade.rotation.y = (i / nBlades) * PI * 2;
          propGroup.add(blade);
          if (p.prop.tipMarker) {
            const tip = new THREE.Mesh(new THREE.SphereGeometry(R * 0.035, 8, 6), tipMat);
            tip.position.set(Math.cos(blade.rotation.y) * R * 0.97, 0, -Math.sin(blade.rotation.y) * R * 0.97);
            propGroup.add(tip);
          }
        }
      }
      propGroup.scale.y = flip;
      grp.add(propGroup);

      // 高速回転時に表示するブラーディスク
      const blur = new THREE.Mesh(
        new THREE.CylinderGeometry(R, R, 0.001, 40),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(p.prop.material.color),
          transparent: true, opacity: 0, roughness: 0.9, metalness: 0,
          side: THREE.DoubleSide, depthWrite: false,
        }));
      blur.position.y = flip * (mh * 1.05);
      grp.add(blur);

      parent.add(grp);
      this.propAssemblies.push({ group: propGroup, blur, spin: r.spin, index: r.index, flip });
    }
  }

  buildGuards(parent, p, rotors) {
    const g = p.guard;
    if (!g.enabled) return;
    const mat = makeMaterial(g.material);
    const R = (p.prop.diameter / 2) * (g.radiusScale ?? 1.15);
    const th = g.thickness ?? 0.005;
    for (const r of rotors) {
      if (r.coaxLevel > 0) continue;
      const grp = new THREE.Group();
      grp.position.set(r.position.x, r.position.y + (g.offsetY ?? 0.01), r.position.z);
      switch (g.shape) {
        case 'octagon': {
          const geo = new THREE.TorusGeometry(R, th, 5, 8);
          const ring = new THREE.Mesh(geo, mat);
          ring.rotation.x = PI / 2;
          grp.add(ring);
          break;
        }
        case 'cage': {
          for (const y of [-0.01, 0.012, 0.034]) {
            const ring = new THREE.Mesh(new THREE.TorusGeometry(R * (1 - Math.abs(y) * 2), th * 0.8, 6, 24), mat);
            ring.rotation.x = PI / 2;
            ring.position.y = y;
            grp.add(ring);
          }
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * PI * 2;
            const bar = new THREE.Mesh(new THREE.CylinderGeometry(th * 0.7, th * 0.7, 0.05, 6), mat);
            bar.position.set(Math.cos(a) * R, 0.012, Math.sin(a) * R);
            grp.add(bar);
          }
          break;
        }
        case 'duct': {
          // 全周ダクト (シネフープ)
          const geo = new THREE.CylinderGeometry(R, R * 1.02, p.prop.diameter * 0.26, 32, 1, true);
          const duct = new THREE.Mesh(geo, makeMaterial({ ...g.material }, { side: THREE.DoubleSide }));
          grp.add(duct);
          const lip = new THREE.Mesh(new THREE.TorusGeometry(R, th * 1.6, 8, 32), mat);
          lip.rotation.x = PI / 2;
          lip.position.y = p.prop.diameter * 0.13;
          grp.add(lip);
          break;
        }
        case 'bumper': {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(R, th * 2.2, 8, 24), mat);
          ring.rotation.x = PI / 2;
          grp.add(ring);
          break;
        }
        case 'ring':
        default: {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(R, th, 8, 32), mat);
          ring.rotation.x = PI / 2;
          grp.add(ring);
          // 支柱
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * PI * 2 + r.azimuth;
            const bar = new THREE.Mesh(new THREE.BoxGeometry(th * 1.5, th, R), mat);
            bar.position.set(Math.cos(a) * R / 2, 0, Math.sin(a) * R / 2);
            bar.rotation.y = -a + PI / 2;
            grp.add(bar);
          }
        }
      }
      parent.add(grp);
    }
  }

  buildLandingGear(parent, p) {
    const lg = p.landingGear;
    if (!lg.enabled) return;
    const mat = makeMaterial(lg.material);
    const h = lg.height, spread = lg.spread, th = lg.thickness ?? 0.006;
    const n = Math.max(2, lg.count ?? 4);
    const baseY = p.body.offset.y - p.body.size.y / 2;

    switch (lg.shape) {
      case 'skid': {
        for (const sx of [-1, 1]) {
          const skid = new THREE.Mesh(new THREE.CylinderGeometry(th, th, spread * 2.2, 10), mat);
          skid.rotation.x = PI / 2;
          skid.position.set(sx * spread, baseY - h, 0);
          parent.add(skid);
          for (const sz of [-1, 1]) {
            const leg = new THREE.Mesh(new THREE.CylinderGeometry(th * 0.8, th * 0.8, h, 8), mat);
            leg.position.set(sx * spread * 0.85, baseY - h / 2, sz * spread * 0.6);
            leg.rotation.z = -sx * 0.12;
            parent.add(leg);
          }
        }
        break;
      }
      case 'ring': {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(spread, th, 8, 24), mat);
        ring.rotation.x = PI / 2;
        ring.position.y = baseY - h;
        parent.add(ring);
        for (let i = 0; i < n; i++) {
          const a = (i / n) * PI * 2;
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(th * 0.8, th * 0.8, h, 8), mat);
          leg.position.set(Math.cos(a) * spread * 0.7, baseY - h / 2, Math.sin(a) * spread * 0.7);
          parent.add(leg);
        }
        break;
      }
      case 'pad': {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * PI * 2 + PI / n;
          const pad = new THREE.Mesh(new THREE.CylinderGeometry(th * 3, th * 3.4, h, 12), mat);
          pad.position.set(-Math.sin(a) * spread, baseY - h / 2, -Math.cos(a) * spread);
          parent.add(pad);
        }
        break;
      }
      case 'tube': {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * PI * 2 + PI / n;
          const x = -Math.sin(a) * spread, z = -Math.cos(a) * spread;
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(th, th, h, 10), mat);
          leg.position.set(x * 0.5, baseY - h / 2, z * 0.5);
          leg.lookAt(new THREE.Vector3(x, baseY - h, z));
          leg.rotateX(PI / 2);
          leg.position.set(x * 0.55, baseY - h / 2, z * 0.55);
          parent.add(leg);
          const foot = new THREE.Mesh(new THREE.SphereGeometry(th * 1.6, 8, 6), mat);
          foot.position.set(x, baseY - h, z);
          parent.add(foot);
        }
        break;
      }
      case 'leg':
      default: {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * PI * 2 + PI / n;
          const x = -Math.sin(a) * spread, z = -Math.cos(a) * spread;
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(th * 0.7, th, h, 8), mat);
          leg.position.set(x * 0.75, baseY - h / 2, z * 0.75);
          leg.rotation.set(z * 0.5, 0, -x * 0.5);
          parent.add(leg);
          const foot = new THREE.Mesh(new THREE.SphereGeometry(th * 1.5, 8, 6), mat);
          foot.position.set(x, baseY - h, z);
          parent.add(foot);
        }
      }
    }
  }

  buildBattery(parent, p) {
    const b = p.battery;
    if (!b.enabled) return;
    const mat = makeMaterial(b.material);
    const mesh = new THREE.Mesh(
      new RoundedBoxGeometry(b.size.x, b.size.y, b.size.z, 2, Math.min(b.size.x, b.size.y) * 0.12), mat);
    mesh.position.set(b.offset.x, b.offset.y, b.offset.z);
    parent.add(mesh);
    this.batteryMesh = mesh;
    if (b.labelMaterial) {
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(b.size.x * 0.8, b.size.z * 0.35),
        makeMaterial(b.labelMaterial));
      label.rotation.x = -PI / 2;
      label.position.set(b.offset.x, b.offset.y + b.size.y / 2 + 0.0005, b.offset.z);
      parent.add(label);
    }
  }

  buildCamera(parent, p, com) {
    const c = p.camera;
    if (!c.enabled) {
      this.cameraMount.position.set(0, 0, 0);
      return;
    }
    const mat = makeMaterial(c.material);
    const lensMat = makeMaterial(c.lensMaterial || { color: '#0a2540', metalness: 0.9, roughness: 0.05 });
    const grp = new THREE.Group();
    const s = c.size;
    const tilt = (c.tilt || 0) * DEG;

    switch (c.shape) {
      case 'cylinder': {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(s / 2, s / 2, s * 1.2, 18), mat);
        body.rotation.x = PI / 2;
        grp.add(body);
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.35, s * 0.4, s * 0.2, 18), lensMat);
        lens.rotation.x = PI / 2;
        lens.position.z = -s * 0.65;
        grp.add(lens);
        break;
      }
      case 'dome': {
        const dome = new THREE.Mesh(new THREE.SphereGeometry(s / 2, 20, 14), mat);
        grp.add(dome);
        const lens = new THREE.Mesh(new THREE.SphereGeometry(s * 0.32, 16, 12), lensMat);
        lens.position.z = -s * 0.3;
        grp.add(lens);
        break;
      }
      case 'gimbal': {
        // ジンバル: ヨー/ロールのフレーム + カメラ本体
        const yoke = new THREE.Mesh(new THREE.TorusGeometry(s * 0.55, s * 0.06, 8, 20, PI), mat);
        yoke.rotation.y = PI / 2;
        grp.add(yoke);
        const arm = new THREE.Mesh(new THREE.BoxGeometry(s * 1.2, s * 0.08, s * 0.08), mat);
        arm.position.y = s * 0.5;
        grp.add(arm);
        const body = new THREE.Mesh(new RoundedBoxGeometry(s * 0.8, s * 0.7, s * 0.9, 2, s * 0.08), mat);
        grp.add(body);
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.28, s * 0.32, s * 0.25, 18), lensMat);
        lens.rotation.x = PI / 2;
        lens.position.z = -s * 0.55;
        grp.add(lens);
        break;
      }
      case 'stereo': {
        const body = new THREE.Mesh(new RoundedBoxGeometry(s * 2.4, s * 0.7, s * 0.5, 2, s * 0.06), mat);
        grp.add(body);
        for (const sx of [-1, 1]) {
          const lens = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.22, s * 0.26, s * 0.2, 16), lensMat);
          lens.rotation.x = PI / 2;
          lens.position.set(sx * s * 0.9, 0, -s * 0.3);
          grp.add(lens);
        }
        break;
      }
      case 'box':
      default: {
        const body = new THREE.Mesh(new RoundedBoxGeometry(s, s * 0.8, s * 1.1, 2, s * 0.1), mat);
        grp.add(body);
        const lens = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.3, s * 0.34, s * 0.25, 16), lensMat);
        lens.rotation.x = PI / 2;
        lens.position.z = -s * 0.6;
        grp.add(lens);
      }
    }

    grp.position.set(c.offset.x, c.offset.y, c.offset.z);
    grp.rotation.x = -tilt;   // tilt 正 = 下向き (機体前方 -z を下へ回す)
    parent.add(grp);
    this.cameraHousing = grp;

    // オンボードカメラの取り付け位置 (重心基準の group 座標に変換)
    this.cameraMount.position.set(c.offset.x - com.x, c.offset.y - com.y, c.offset.z - com.z);
    this.cameraMount.rotation.set(-tilt, 0, 0);
  }

  buildLeds(parent, p) {
    const l = p.leds;
    if (!l || !l.enabled) return;
    const mk = (color, x, z) => {
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        emissive: new THREE.Color(color),
        emissiveIntensity: l.intensity ?? 2,
        roughness: 0.4,
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.004, 8, 6), mat);
      mesh.position.set(x, p.body.offset.y - p.body.size.y * 0.4, z);
      parent.add(mesh);
      this.leds.push({ mesh, material: mat, base: l.intensity ?? 2 });
    };
    const bz = p.body.size.z / 2;
    const bx = p.body.size.x / 2;
    mk(l.frontColor, -bx * 0.8, -bz);
    mk(l.frontColor, bx * 0.8, -bz);
    mk(l.rearColor, -bx * 0.8, bz);
    mk(l.rearColor, bx * 0.8, bz);
  }

  /* ------------------------------------------------------------ */

  /**
   * 毎フレームの更新 (プロペラ回転、LED 点滅)。
   * @param {number} dt
   * @param {number[]} speeds 各ロータの回転数 [rev/s]
   * @param {number} time
   */
  update(dt, speeds, time) {
    const spinLimit = this.cfg?.parts.prop.spinVisual ?? 900;
    for (const a of this.propAssemblies) {
      const n = speeds[a.index] ?? 0;
      const omega = n * 2 * PI * a.spin;
      // エイリアシングを避けるため見かけの回転速度に上限を設ける
      const shown = Math.max(-spinLimit, Math.min(spinLimit, omega));
      a.group.rotation.y += shown * dt;
      // 高速回転ではブレードを消してブラーディスクを出す
      const blur = Math.min(1, Math.max(0, (Math.abs(n) - 25) / 60));
      a.blur.material.opacity = blur * 0.30;
      a.blur.visible = blur > 0.01;
      a.group.visible = blur < 0.98;
      if (a.group.visible) {
        for (const child of a.group.children) {
          if (child.material && child.material.transparent) child.material.opacity = 1 - blur * 0.55;
        }
      }
    }
    const l = this.cfg?.parts.leds;
    if (l?.enabled && l.blink) {
      const on = (Math.sin(time * PI * 2 * (l.blinkHz || 2)) > 0) ? 1 : 0.12;
      for (const led of this.leds) led.material.emissiveIntensity = led.base * on;
    }
  }
}
