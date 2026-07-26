/**
 * 室内シーンの構築。
 *
 * 部屋 (床・壁・天井) + 家具 + 装飾 (ポスター/マーカー/窓) + 照明を生成し、
 * 同時に物理側の CollisionWorld にも同じ形状を登録する。
 * 見た目と当たり判定が一致するので、壁への接触や着陸が正しく再現される。
 */

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { getTexture } from './textures.js';
import { ROOM_PRESETS, LIGHTING_PRESETS } from '../config/rooms.js';
import { makeRng, v3 } from '../core/math.js';

RectAreaLightUniformsLib.init();

const PI = Math.PI;

/**
 * 照明の較正係数。
 *
 * three.js の物理ベース照明では光源の強さがカンデラ相当の値になるため、
 * プリセットに書いた「相対的な明るさ」をそのまま使うと露出オーバーになる。
 * 実写に近い露出 (平均輝度 ≒ 110/255, 白飛び ≒ 2%) になるよう、
 * 実測して決めた係数をここで一括して掛ける。
 */
const LIGHT_CALIBRATION = 0.18;

function pbr(params) {
  return new THREE.MeshStandardMaterial({
    roughness: 0.7, metalness: 0.0, ...params,
  });
}

/** テクスチャ付きマテリアルを作る */
function texturedMaterial(cfg, repeat, detail) {
  const t = getTexture(cfg.kind, { color: cfg.color, detail, seed: cfg.seed ?? 1 },
    { x: repeat.x, y: repeat.y });
  const m = new THREE.MeshStandardMaterial({
    map: t.map,
    normalMap: t.normalMap || null,
    roughnessMap: t.roughnessMap || null,
    roughness: cfg.roughness ?? 0.7,
    metalness: cfg.metalness ?? 0.0,
  });
  if (t.normalMap) m.normalScale = new THREE.Vector2(cfg.normalScale ?? 0.8, cfg.normalScale ?? 0.8);
  return m;
}

export class RoomBuilder {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'room';
    this.lightGroup = new THREE.Group();
    this.scene.add(this.group);
    this.scene.add(this.lightGroup);
    this.lights = [];
  }

  clear() {
    const dispose = (obj) => {
      obj.traverse?.((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) m.dispose();
        }
      });
    };
    dispose(this.group);
    this.group.clear();
    dispose(this.lightGroup);
    this.lightGroup.clear();
    this.lights.length = 0;
    this.world.clearObstacles();
  }

  /**
   * 環境を構築する。
   * @param {object} env ENV_DEFAULTS 形式の設定
   */
  build(env) {
    this.clear();
    const preset = ROOM_PRESETS[env.preset] || ROOM_PRESETS.lab;
    const size = env.size || preset.size;
    const rng = makeRng(env.seed ?? preset.clutterSeed ?? 7);
    this.size = size;
    this.env = env;
    this.preset = preset;

    this.world.setRoom(size.width, size.height, size.depth);
    this.buildShell(preset, size, env);
    this.buildDecor(preset, size, env, rng);
    this.buildFurniture(preset, size, env, rng);
    this.buildLighting(preset, size, env);
    return this.group;
  }

  /* ------------------------------------------------------------ */
  /* 床・壁・天井                                                   */
  /* ------------------------------------------------------------ */

  buildShell(preset, size, env) {
    const d = env.featureDensity ?? 1;
    const { width: W, depth: D, height: H } = size;

    // --- 床 ---
    const floorMat = texturedMaterial(preset.floor, { x: preset.floor.repeat * W / 8, y: preset.floor.repeat * D / 8 }, d);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
    floor.rotation.x = -PI / 2;
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.group.add(floor);

    // --- 天井 ---
    const ceilMat = texturedMaterial(preset.ceiling, { x: preset.ceiling.repeat * W / 8, y: preset.ceiling.repeat * D / 8 }, d);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilMat);
    ceil.rotation.x = PI / 2;
    ceil.position.y = H;
    ceil.receiveShadow = true;
    this.group.add(ceil);

    // --- 壁 (内側を向く 4 面) ---
    const wallCfg = preset.walls;
    const mk = (w, h, repX) => {
      const m = texturedMaterial(wallCfg, { x: wallCfg.repeat * w / 8, y: wallCfg.repeat * h / 3 }, d);
      void repX;
      return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    };
    const walls = [
      { mesh: mk(W, H), pos: [0, H / 2, -D / 2], rot: [0, 0, 0] },          // 奥 (北)
      { mesh: mk(W, H), pos: [0, H / 2, D / 2], rot: [0, PI, 0] },          // 手前 (南)
      { mesh: mk(D, H), pos: [-W / 2, H / 2, 0], rot: [0, PI / 2, 0] },     // 左 (西)
      { mesh: mk(D, H), pos: [W / 2, H / 2, 0], rot: [0, -PI / 2, 0] },     // 右 (東)
    ];
    for (const w of walls) {
      w.mesh.position.set(...w.pos);
      w.mesh.rotation.set(...w.rot);
      w.mesh.receiveShadow = true;
      w.mesh.name = 'wall';
      this.group.add(w.mesh);
    }

    // 幅木 (床と壁の境界。単調な壁面に水平特徴を与える)
    const skirtMat = pbr({ color: 0xd9d5cc, roughness: 0.5 });
    const skirtH = 0.08;
    const addSkirt = (w, x, z, ry) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, skirtH, 0.02), skirtMat);
      m.position.set(x, skirtH / 2, z);
      m.rotation.y = ry;
      m.castShadow = false; m.receiveShadow = true;
      this.group.add(m);
    };
    addSkirt(W, 0, -D / 2 + 0.01, 0);
    addSkirt(W, 0, D / 2 - 0.01, 0);
    addSkirt(D, -W / 2 + 0.01, 0, PI / 2);
    addSkirt(D, W / 2 - 0.01, 0, PI / 2);
  }

  /* ------------------------------------------------------------ */
  /* 装飾 (ポスター・マーカー・窓・ホワイトボード)                    */
  /* ------------------------------------------------------------ */

  buildDecor(preset, size, env, rng) {
    const { width: W, depth: D, height: H } = size;
    const decor = preset.decor;

    /** 壁面上の位置と向きをランダムに選ぶ */
    const pickWall = () => {
      const side = rng.int(0, 3);
      const t = rng.range(-0.4, 0.4);
      const y = rng.range(0.9, Math.min(H - 0.6, 2.2));
      switch (side) {
        case 0: return { pos: [t * W, y, -D / 2 + 0.02], rot: [0, 0, 0] };
        case 1: return { pos: [t * W, y, D / 2 - 0.02], rot: [0, PI, 0] };
        case 2: return { pos: [-W / 2 + 0.02, y, t * D], rot: [0, PI / 2, 0] };
        default: return { pos: [W / 2 - 0.02, y, t * D], rot: [0, -PI / 2, 0] };
      }
    };

    // --- ポスター ---
    const nPoster = env.posterCount ?? decor.posters;
    for (let i = 0; i < nPoster; i++) {
      const t = getTexture('poster', { seed: i + 1 + (env.seed ?? 0) });
      const w = rng.range(0.4, 0.8);
      const h = w * rng.range(1.0, 1.5);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        pbr({ map: t.map, roughness: 0.55 }));
      const p = pickWall();
      mesh.position.set(...p.pos);
      mesh.rotation.set(...p.rot);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // --- フィデューシャルマーカー (既知ランドマーク) ---
    const nMarker = env.markerCount ?? decor.markers;
    this.markers = [];
    for (let i = 0; i < nMarker; i++) {
      const t = getTexture('marker', { seed: i + 1, bits: 6 });
      const s = 0.3;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s, s),
        pbr({ map: t.map, roughness: 0.65 }));
      const p = pickWall();
      mesh.position.set(...p.pos);
      mesh.rotation.set(...p.rot);
      mesh.name = `marker-${i}`;
      mesh.userData.markerId = i;
      this.group.add(mesh);
      this.markers.push({ id: i, position: { x: p.pos[0], y: p.pos[1], z: p.pos[2] }, size: s });
    }

    // 床にもマーカーを置く (下向きカメラの実験用)
    const nFloorMarker = Math.floor(nMarker / 2);
    for (let i = 0; i < nFloorMarker; i++) {
      const t = getTexture('marker', { seed: 100 + i, bits: 6 });
      const s = 0.4;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(s, s),
        pbr({ map: t.map, roughness: 0.6 }));
      mesh.rotation.x = -PI / 2;
      mesh.position.set(rng.range(-0.4, 0.4) * W, 0.002, rng.range(-0.4, 0.4) * D);
      mesh.rotation.z = rng.range(0, PI * 2);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.markers.push({ id: 100 + i, position: { x: mesh.position.x, y: 0, z: mesh.position.z }, size: s });
    }

    // --- ホワイトボード ---
    if (decor.whiteboard) {
      const t = getTexture('whiteboard', { seed: 3 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 0.03),
        pbr({ map: t.map, roughnessMap: t.roughnessMap, roughness: 0.2 }));
      mesh.position.set(0, 1.4, -size.depth / 2 + 0.03);
      mesh.castShadow = true; mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // --- 窓 (発光面 + 枠) ---
    const nWin = env.windows ?? decor.windows;
    const frameMat = pbr({ color: 0x9aa0a6, roughness: 0.35, metalness: 0.6 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xdfeeff, emissive: 0xcfe4ff, emissiveIntensity: 1.35,
      roughness: 0.08, metalness: 0.0,
    });
    this.windowMaterial = glassMat;
    for (let i = 0; i < nWin; i++) {
      const w = 1.2, h = 1.3;
      const side = i % 2 === 0 ? -1 : 1;
      const z = ((i / Math.max(1, nWin - 1)) - 0.5) * D * 0.7;
      const grp = new THREE.Group();
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glassMat);
      grp.add(glass);
      // 桟
      const bar = (bw, bh, x, y) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.04), frameMat);
        m.position.set(x, y, 0.01);
        grp.add(m);
      };
      bar(w + 0.08, 0.06, 0, h / 2);
      bar(w + 0.08, 0.06, 0, -h / 2);
      bar(0.06, h, -w / 2, 0);
      bar(0.06, h, w / 2, 0);
      bar(0.04, h, 0, 0);
      grp.position.set(side * (W / 2 - 0.05), 1.35, z);
      grp.rotation.y = side < 0 ? PI / 2 : -PI / 2;
      this.group.add(grp);
    }
  }

  /* ------------------------------------------------------------ */
  /* 家具                                                          */
  /* ------------------------------------------------------------ */

  buildFurniture(preset, size, env, rng) {
    const density = (env.furnitureDensity ?? 1) * (preset.furniture.density ?? 1);
    const kinds = preset.furniture.kinds;
    if (!kinds.length || density <= 0) return;
    const { width: W, depth: D } = size;
    const area = W * D;
    const count = Math.round(area * 0.12 * density);
    const placed = [];

    for (let i = 0; i < count; i++) {
      const kind = rng.pick(kinds);
      // 重ならない位置を探す
      let pos = null;
      for (let attempt = 0; attempt < 24; attempt++) {
        const x = rng.range(-W / 2 + 0.8, W / 2 - 0.8);
        const z = rng.range(-D / 2 + 0.8, D / 2 - 0.8);
        // 中央付近は飛行空間として空けておく
        if (Math.hypot(x, z) < Math.min(W, D) * 0.16) continue;
        const ok = placed.every((p) => Math.hypot(p.x - x, p.z - z) > 1.1);
        if (ok) { pos = { x, z }; break; }
      }
      if (!pos) continue;
      placed.push(pos);
      const yaw = rng.pick([0, PI / 2, PI, -PI / 2]) + rng.range(-0.15, 0.15);
      const obj = this.makeFurniture(kind, rng);
      if (!obj) continue;
      obj.group.position.set(pos.x, 0, pos.z);
      obj.group.rotation.y = yaw;
      obj.group.traverse((o) => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      });
      this.group.add(obj.group);
      // 当たり判定
      for (const c of obj.colliders) {
        const cx = pos.x + c.center.x * Math.cos(yaw) + c.center.z * Math.sin(yaw);
        const cz = pos.z - c.center.x * Math.sin(yaw) + c.center.z * Math.cos(yaw);
        this.world.addBox(v3(cx, c.center.y, cz), c.half, yaw, kind,
          { friction: 0.6, restitution: 0.08 });
      }
    }
  }

  /** 家具 1 点を作る。{group, colliders} を返す */
  makeFurniture(kind, rng) {
    const g = new THREE.Group();
    const colliders = [];
    const woodTex = getTexture('wood', { color: '#8a6440', detail: 0.8, seed: 9 }, { x: 2, y: 2 });
    const wood = pbr({ map: woodTex.map, normalMap: woodTex.normalMap, roughness: 0.45 });
    const metal = pbr({ color: 0x8a9099, roughness: 0.35, metalness: 0.85 });
    const dark = pbr({ color: 0x2b2f36, roughness: 0.6 });
    const plastic = pbr({ color: new THREE.Color().setHSL(rng(), 0.4, 0.45), roughness: 0.55 });
    const box = (w, h, d, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    const cyl = (r, h, mat, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    const addCollider = (w, h, d, x = 0, y = 0, z = 0) => {
      colliders.push({ center: v3(x, y + h / 2, z), half: v3(w / 2, h / 2, d / 2) });
    };

    switch (kind) {
      case 'desk': {
        const w = rng.range(1.1, 1.6), d = rng.range(0.6, 0.8), h = 0.72;
        box(w, 0.04, d, wood, 0, h, 0);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          box(0.05, h, 0.05, metal, sx * (w / 2 - 0.06), h / 2, sz * (d / 2 - 0.06));
        }
        addCollider(w, h + 0.04, d);
        break;
      }
      case 'chair': {
        const s = 0.45;
        box(s, 0.05, s, plastic, 0, 0.45, 0);
        box(s, 0.5, 0.05, plastic, 0, 0.72, -s / 2 + 0.03);
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
          box(0.04, 0.45, 0.04, metal, sx * (s / 2 - 0.05), 0.22, sz * (s / 2 - 0.05));
        }
        addCollider(s, 0.95, s);
        break;
      }
      case 'shelf': {
        const w = rng.range(0.8, 1.2), d = 0.4, h = rng.range(1.4, 2.0);
        box(w, h, 0.03, wood, 0, h / 2, -d / 2);
        for (const sx of [-1, 1]) box(0.03, h, d, wood, sx * w / 2, h / 2, 0);
        const shelves = Math.floor(h / 0.4);
        for (let i = 1; i <= shelves; i++) box(w, 0.025, d, wood, 0, (i / (shelves + 1)) * h, 0);
        // 中身
        for (let i = 0; i < shelves * 2; i++) {
          const bw = rng.range(0.06, 0.16);
          box(bw, rng.range(0.15, 0.28), 0.25,
            pbr({ color: new THREE.Color().setHSL(rng(), 0.5, 0.4), roughness: 0.7 }),
            rng.range(-w / 2 + 0.1, w / 2 - 0.1),
            (Math.floor(i / 2 + 1) / (shelves + 1)) * h + 0.12, 0);
        }
        addCollider(w, h, d);
        break;
      }
      case 'cabinet': {
        const w = rng.range(0.8, 1.0), d = 0.45, h = rng.range(0.8, 1.2);
        box(w, h, d, pbr({ color: 0xb9bcc0, roughness: 0.4, metalness: 0.3 }), 0, h / 2, 0);
        for (let i = 0; i < 3; i++) {
          box(w * 0.8, 0.02, 0.01, dark, 0, h * (0.25 + i * 0.25), d / 2 + 0.005);
        }
        addCollider(w, h, d);
        break;
      }
      case 'monitor': {
        box(0.5, 0.32, 0.03, dark, 0, 1.0, 0);
        box(0.46, 0.28, 0.005,
          pbr({ color: 0x0a1520, emissive: 0x1b3a5c, emissiveIntensity: 0.8, roughness: 0.15 }),
          0, 1.0, 0.02);
        cyl(0.03, 0.22, metal, 0, 0.85, 0);
        box(0.24, 0.02, 0.16, metal, 0, 0.74, 0);
        box(0.6, 0.72, 0.5, new THREE.MeshStandardMaterial({ visible: false }), 0, 0.36, 0);
        addCollider(0.6, 1.2, 0.5);
        break;
      }
      case 'box': case 'crate': {
        const s = rng.range(0.3, 0.55);
        const m = kind === 'crate' ? wood : pbr({ color: 0xb08c5c, roughness: 0.85 });
        box(s, s * rng.range(0.6, 1.1), s, m, 0, s / 2, 0);
        addCollider(s, s, s);
        break;
      }
      case 'pallet': {
        const w = 1.1, d = 0.9;
        for (let i = 0; i < 5; i++) box(w, 0.03, 0.12, wood, 0, 0.14, (i / 4 - 0.5) * d);
        for (const sx of [-1, 0, 1]) box(0.1, 0.12, d, wood, sx * w / 2 * 0.8, 0.06, 0);
        // 積荷
        const hh = rng.range(0.3, 0.8);
        box(w * 0.85, hh, d * 0.85, pbr({ color: 0xa8895f, roughness: 0.8 }), 0, 0.16 + hh / 2, 0);
        addCollider(w, 0.16 + hh, d);
        break;
      }
      case 'pillar': {
        const r = rng.range(0.18, 0.3), h = 6;
        cyl(r, h, pbr({ color: 0xa5a3a0, roughness: 0.8 }), 0, h / 2, 0);
        colliders.push({ center: v3(0, h / 2, 0), half: v3(r, h / 2, r) });
        break;
      }
      case 'plant': {
        cyl(0.16, 0.3, pbr({ color: 0x8b5a3c, roughness: 0.7 }), 0, 0.15, 0);
        const leafMat = pbr({ color: 0x2f6b3a, roughness: 0.75 });
        for (let i = 0; i < 9; i++) {
          const m = new THREE.Mesh(new THREE.SphereGeometry(rng.range(0.10, 0.20), 8, 6), leafMat);
          m.position.set(rng.range(-0.2, 0.2), rng.range(0.4, 0.9), rng.range(-0.2, 0.2));
          m.scale.y = 0.7;
          g.add(m);
        }
        addCollider(0.5, 1.0, 0.5);
        break;
      }
      case 'sofa': {
        const w = rng.range(1.6, 2.0), d = 0.85;
        const fab = pbr({ color: new THREE.Color().setHSL(rng() * 0.15 + 0.05, 0.25, 0.42), roughness: 0.9 });
        box(w, 0.35, d, fab, 0, 0.25, 0);
        box(w, 0.5, 0.22, fab, 0, 0.6, -d / 2 + 0.11);
        for (const sx of [-1, 1]) box(0.2, 0.45, d, fab, sx * (w / 2 - 0.1), 0.5, 0);
        addCollider(w, 0.9, d);
        break;
      }
      case 'table': {
        const r = rng.range(0.4, 0.6);
        cyl(r, 0.04, wood, 0, 0.45, 0);
        cyl(0.05, 0.45, metal, 0, 0.22, 0);
        cyl(r * 0.6, 0.02, metal, 0, 0.01, 0);
        addCollider(r * 2, 0.5, r * 2);
        break;
      }
      case 'bench': {
        const w = rng.range(1.4, 2.2);
        box(w, 0.06, 0.35, wood, 0, 0.45, 0);
        for (const sx of [-1, 1]) box(0.06, 0.45, 0.3, metal, sx * (w / 2 - 0.1), 0.22, 0);
        addCollider(w, 0.5, 0.35);
        break;
      }
      case 'machine': {
        const w = rng.range(0.9, 1.6), d = rng.range(0.7, 1.1), h = rng.range(1.0, 1.8);
        box(w, h, d, pbr({ color: 0x4b6b8a, roughness: 0.45, metalness: 0.5 }), 0, h / 2, 0);
        box(w * 0.4, 0.25, 0.05,
          pbr({ color: 0x101820, emissive: 0x22ff88, emissiveIntensity: 0.6, roughness: 0.2 }),
          0, h * 0.75, d / 2 + 0.03);
        cyl(0.06, 0.6, metal, w * 0.3, h + 0.3, 0);
        addCollider(w, h, d);
        break;
      }
      default:
        return null;
    }
    return { group: g, colliders };
  }

  /* ------------------------------------------------------------ */
  /* 照明                                                          */
  /* ------------------------------------------------------------ */

  buildLighting(preset, size, env) {
    const cfg = LIGHTING_PRESETS[env.lighting || preset.lighting] || LIGHTING_PRESETS.fluorescent;
    const scale = (env.lightIntensity ?? 1) * LIGHT_CALIBRATION;
    const { width: W, depth: D, height: H } = size;

    // --- 環境光 (間接光の近似) ---
    const hemi = new THREE.HemisphereLight(
      new THREE.Color(cfg.ambientColor), new THREE.Color(0x6b6a66), cfg.ambient * scale * 3);
    this.lightGroup.add(hemi);
    this.hemi = hemi;

    // --- 天井照明 (面光源 + 発光パネル) ---
    const { rows, cols, power, color, size: fixtureSize } = cfg.ceilingLights;
    const fixtureMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: new THREE.Color(color), emissiveIntensity: 2.2,
      roughness: 0.4,
    });
    this.fixtureMaterial = fixtureMat;
    let shadowLights = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = cols === 1 ? 0 : ((c / (cols - 1)) - 0.5) * W * 0.62;
        const z = rows === 1 ? 0 : ((r / (rows - 1)) - 0.5) * D * 0.62;

        // 発光する器具本体
        const fw = fixtureSize * 1.2, fd = fixtureSize * 0.35;
        const panel = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.05, fd), fixtureMat);
        panel.position.set(x, H - 0.04, z);
        this.group.add(panel);

        // 面光源 (柔らかい照明。影は落とさない)
        const area = new THREE.RectAreaLight(new THREE.Color(color), power * scale * 0.35, fw, fd);
        area.position.set(x, H - 0.08, z);
        area.rotation.x = -PI / 2;
        this.lightGroup.add(area);
        this.lights.push({ light: area, base: power * scale * 0.35, flicker: cfg.flicker });

        // 影付きのスポットライト (数を絞って負荷を抑える)
        if (env.shadows !== false && shadowLights < 3) {
          const spot = new THREE.SpotLight(new THREE.Color(color), power * scale * 1.6,
            H * 3, PI / 2.6, 0.6, 1.6);
          spot.position.set(x, H - 0.12, z);
          spot.target.position.set(x, 0, z);
          spot.castShadow = true;
          spot.shadow.mapSize.width = env.shadowQuality ?? 2048;
          spot.shadow.mapSize.height = env.shadowQuality ?? 2048;
          spot.shadow.camera.near = 0.2;
          spot.shadow.camera.far = H * 2.5;
          spot.shadow.bias = -0.0012;
          spot.shadow.normalBias = 0.02;
          this.lightGroup.add(spot);
          this.lightGroup.add(spot.target);
          this.lights.push({ light: spot, base: power * scale * 1.6, flicker: cfg.flicker });
          shadowLights++;
        }
      }
    }

    // --- 窓からの太陽光 ---
    if (cfg.sun.enabled) {
      const el = cfg.sun.elevation * PI / 180;
      const az = cfg.sun.azimuth * PI / 180;
      const dir = new THREE.DirectionalLight(new THREE.Color(cfg.sun.color), cfg.sun.power * scale);
      const dist = Math.max(W, D);
      dir.position.set(
        Math.sin(az) * Math.cos(el) * dist,
        Math.sin(el) * dist,
        Math.cos(az) * Math.cos(el) * dist,
      );
      dir.castShadow = env.shadows !== false;
      const s = Math.max(W, D) * 0.7;
      dir.shadow.camera.left = -s; dir.shadow.camera.right = s;
      dir.shadow.camera.top = s; dir.shadow.camera.bottom = -s;
      dir.shadow.camera.near = 0.5;
      dir.shadow.camera.far = dist * 3;
      dir.shadow.mapSize.width = env.shadowQuality ?? 2048;
      dir.shadow.mapSize.height = env.shadowQuality ?? 2048;
      dir.shadow.bias = -0.0008;
      dir.shadow.normalBias = 0.03;
      this.lightGroup.add(dir);
      this.sun = dir;
      this.lights.push({ light: dir, base: cfg.sun.power * scale, flicker: 0 });
    } else {
      this.sun = null;
    }
    this.lightConfig = cfg;
  }

  /** 蛍光灯のちらつきなど、時間変化する照明を更新する */
  update(time) {
    for (const l of this.lights) {
      if (!l.flicker) continue;
      const n = Math.sin(time * 37.7 + l.light.id) * Math.sin(time * 13.1);
      l.light.intensity = l.base * (1 + n * l.flicker * 3);
    }
  }
}
