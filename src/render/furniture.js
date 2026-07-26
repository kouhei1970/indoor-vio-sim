/**
 * 家具 1 点を作る (部屋・建物の両方から使う共通部品)。
 *
 * 見た目と当たり判定を同時に返すので、描画と物理がずれない。
 * kind を増やせば、部屋プリセット・建物プリセットの双方で使えるようになる。
 */

import * as THREE from 'three';
import { getTexture } from './textures.js';
import { v3 } from '../core/math.js';

function pbr(params) {
  return new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.0, ...params });
}

/**
 * マテリアルの使い回し。
 *
 * 家具 1 点ごとに新しいマテリアルを作ると、同じ見た目でも別マテリアル扱いに
 * なってジオメトリを統合できず、ドローコールが家具の数だけ増える。
 * 同じ指定なら同じインスタンスを返すことで、geometryMerge.js が
 * まとめられるようにする。
 */
const matCache = new Map();
function shared(key, params) {
  let m = matCache.get(key);
  if (!m) {
    m = pbr(params);
    // 部屋・建物を作り直すときに破棄されないよう印を付ける
    m.userData.shared = true;
    matCache.set(key, m);
  }
  return m;
}

/** 使い回すマテリアルを捨てる (テクスチャを作り直すときに呼ぶ) */
export function disposeFurnitureMaterials() {
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
}

/** 色をいくつかに離散化する (無限に増やさず、見た目の多様性は保つ) */
const quantize = (t, n) => Math.floor(Math.min(0.999, Math.max(0, t)) * n) / n;

/** 使える家具の種類 */
export const FURNITURE_KINDS = [
  'desk', 'chair', 'shelf', 'cabinet', 'monitor', 'box', 'crate', 'pallet',
  'pillar', 'plant', 'sofa', 'table', 'bench', 'machine',
];

/** 上に物を置ける家具 (天板の高さを surface で返す) */
export const TABLETOP_KINDS = ['desk', 'table', 'cabinet', 'bench'];
/** 机などの上に置く家具 (床に直接置くと浮いて見える) */
export const ON_TABLE_KINDS = ['monitor'];

export function makeFurniture(kind, rng) {
  const g = new THREE.Group();
  const colliders = [];
  // 上に物を置ける家具は天板の高さを返す (null = 置けない)
  let surface = null;
  const woodTex = getTexture('wood', { color: '#8a6440', detail: 0.8, seed: 9 }, { x: 2, y: 2 });
  const wood = shared('wood', { map: woodTex.map, normalMap: woodTex.normalMap, roughness: 0.45 });
  const metal = shared('metal', { color: 0x8a9099, roughness: 0.35, metalness: 0.85 });
  const dark = shared('dark', { color: 0x2b2f36, roughness: 0.6 });
  const ph = quantize(rng(), 8);
  const plastic = shared(`plastic${ph}`,
    { color: new THREE.Color().setHSL(ph, 0.4, 0.45), roughness: 0.55 });
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
      surface = h + 0.04;
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
          (() => { const h = quantize(rng(), 8);
            return shared(`file${h}`, { color: new THREE.Color().setHSL(h, 0.5, 0.4), roughness: 0.7 }); })(),
          rng.range(-w / 2 + 0.1, w / 2 - 0.1),
          (Math.floor(i / 2 + 1) / (shelves + 1)) * h + 0.12, 0);
      }
      addCollider(w, h, d);
      break;
    }
    case 'cabinet': {
      const w = rng.range(0.8, 1.0), d = 0.45, h = rng.range(0.8, 1.2);
      box(w, h, d, shared('cabinet', { color: 0xb9bcc0, roughness: 0.4, metalness: 0.3 }), 0, h / 2, 0);
      for (let i = 0; i < 3; i++) {
        box(w * 0.8, 0.02, 0.01, dark, 0, h * (0.25 + i * 0.25), d / 2 + 0.005);
      }
      addCollider(w, h, d);
      surface = h;
      break;
    }
    case 'monitor': {
      // 原点は台座の底。机やキャビネットの天板の高さに置いて使う
      // (床に直接置くと宙に浮いて見えるので、配置側が surface を見て載せる)。
      box(0.24, 0.02, 0.16, metal, 0, 0.01, 0);        // 台座
      cyl(0.03, 0.22, metal, 0, 0.13, 0);              // 支柱
      box(0.5, 0.32, 0.03, dark, 0, 0.40, 0);          // 筐体
      box(0.46, 0.28, 0.005,
        shared('screen', { color: 0x0a1520, emissive: 0x1b3a5c, emissiveIntensity: 0.8, roughness: 0.15 }),
        0, 0.40, 0.02);                                // 画面
      addCollider(0.5, 0.56, 0.2);
      surface = null;
      break;
    }
    case 'box': case 'crate': {
      const s = rng.range(0.3, 0.55);
      const m = kind === 'crate' ? wood : shared('carton', { color: 0xb08c5c, roughness: 0.85 });
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
      box(w * 0.85, hh, d * 0.85, shared('load', { color: 0xa8895f, roughness: 0.8 }), 0, 0.16 + hh / 2, 0);
      addCollider(w, 0.16 + hh, d);
      break;
    }
    case 'pillar': {
      const r = rng.range(0.18, 0.3), h = 6;
      cyl(r, h, shared('concrete', { color: 0xa5a3a0, roughness: 0.8 }), 0, h / 2, 0);
      colliders.push({ center: v3(0, h / 2, 0), half: v3(r, h / 2, r) });
      break;
    }
    case 'plant': {
      cyl(0.16, 0.3, shared('pot', { color: 0x8b5a3c, roughness: 0.7 }), 0, 0.15, 0);
      const leafMat = shared('leaf', { color: 0x2f6b3a, roughness: 0.75 });
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
      const fh = quantize(rng() * 0.15 + 0.05, 24);
      const fab = shared(`fabric${fh}`,
        { color: new THREE.Color().setHSL(fh, 0.25, 0.42), roughness: 0.9 });
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
      surface = 0.47;
      break;
    }
    case 'bench': {
      const w = rng.range(1.4, 2.2);
      box(w, 0.06, 0.35, wood, 0, 0.45, 0);
      for (const sx of [-1, 1]) box(0.06, 0.45, 0.3, metal, sx * (w / 2 - 0.1), 0.22, 0);
      addCollider(w, 0.5, 0.35);
      surface = 0.51;
      break;
    }
    case 'machine': {
      const w = rng.range(0.9, 1.6), d = rng.range(0.7, 1.1), h = rng.range(1.0, 1.8);
      box(w, h, d, shared('machine', { color: 0x4b6b8a, roughness: 0.45, metalness: 0.5 }), 0, h / 2, 0);
      box(w * 0.4, 0.25, 0.05,
        shared('panelLed', { color: 0x101820, emissive: 0x22ff88, emissiveIntensity: 0.6, roughness: 0.2 }),
        0, h * 0.75, d / 2 + 0.03);
      cyl(0.06, 0.6, metal, w * 0.3, h + 0.3, 0);
      addCollider(w, h, d);
      break;
    }
    default:
      return null;
  }
  return { group: g, colliders, surface };
}
