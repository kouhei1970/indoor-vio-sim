/**
 * 手続き的 PBR テクスチャ生成。
 *
 * 外部アセットを一切使わずに、カラー / 法線 / ラフネス マップを生成する。
 * これにより
 *   - リポジトリを軽量に保てる (オフラインでも動く)
 *   - 解像度・特徴量 (模様の多さ) をパラメータで変えられる
 * という利点がある。
 *
 * 特徴量を変えられることは自己位置推定の研究では重要で、
 * 「テクスチャの少ない白い壁」と「模様の多い床」で
 * 特徴点ベースの手法がどう劣化するかを比較できる。
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* ノイズ                                                               */
/* ------------------------------------------------------------------ */

function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/** 周期的な値ノイズ (タイリングできるようにグリッドを折り返す) */
function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const wrap = (v) => ((v % period) + period) % period;
  const x0 = wrap(xi), x1 = wrap(xi + 1);
  const y0 = wrap(yi), y1 = wrap(yi + 1);
  const v00 = hash2(x0, y0, seed), v10 = hash2(x1, y0, seed);
  const v01 = hash2(x0, y1, seed), v11 = hash2(x1, y1, seed);
  const u = smooth(xf), v = smooth(yf);
  return (v00 * (1 - u) + v10 * u) * (1 - v) + (v01 * (1 - u) + v11 * u) * v;
}

/** フラクタルノイズ (タイリング可能) */
export function fbm(x, y, octaves, basePeriod, seed, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * period, y * period, period, seed + o * 17);
    norm += amp;
    amp *= gain;
    period *= 2;
  }
  return sum / norm;
}

/* ------------------------------------------------------------------ */
/* キャンバス補助                                                       */
/* ------------------------------------------------------------------ */

function makeCanvas(size) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  c.width = size; c.height = size;
  return c;
}

/** 高さマップ (Float32Array) から法線マップ Texture を作る */
function heightToNormalTexture(height, size, strength = 2.0) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // 法線 = normalize(-dx, -dy, 1)
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasToTexture(canvas, THREE.LinearSRGBColorSpace);
}

function dataToTexture(data, size, colorSpace) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return canvasToTexture(canvas, colorSpace);
}

function canvasToTexture(canvas, colorSpace = THREE.SRGBColorSpace) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = colorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

const mixRgb = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];

/**
 * ピクセルシェーダ風のジェネレータからマテリアル一式を作る。
 * @param {function} fn (x, y, u, v) => {rgb:[r,g,b], height:number, rough:number}
 */
function generate(size, fn) {
  const color = new Uint8ClampedArray(size * size * 4);
  const rough = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const r = fn(x, y, x / size, y / size);
      color[i * 4] = r.rgb[0]; color[i * 4 + 1] = r.rgb[1]; color[i * 4 + 2] = r.rgb[2]; color[i * 4 + 3] = 255;
      const rv = Math.round((r.rough ?? 0.5) * 255);
      rough[i * 4] = rv; rough[i * 4 + 1] = rv; rough[i * 4 + 2] = rv; rough[i * 4 + 3] = 255;
      height[i] = r.height ?? 0;
    }
  }
  return {
    map: dataToTexture(color, size, THREE.SRGBColorSpace),
    roughnessMap: dataToTexture(rough, size, THREE.LinearSRGBColorSpace),
    normalMap: heightToNormalTexture(height, size, 2.5),
  };
}

/* ------------------------------------------------------------------ */
/* 各種テクスチャ                                                       */
/* ------------------------------------------------------------------ */

/** フローリング (板目 + 目地) */
export function woodFloor(opts = {}) {
  const size = opts.size ?? 512;
  const planks = opts.planks ?? 6;
  const base = hexToRgb(opts.color ?? '#a97b4f');
  const dark = hexToRgb(opts.darkColor ?? '#6b4a2b');
  const detail = opts.detail ?? 1;
  const seed = opts.seed ?? 3;
  return generate(size, (x, y, u, v) => {
    const row = Math.floor(v * planks);
    const offset = (row % 2) * 0.5 + row * 0.17;
    const uu = (u + offset) % 1;
    const plankIdx = Math.floor(uu * (planks * 0.6));
    const tone = hash2(plankIdx, row, seed) * 0.35 - 0.12;
    // 木目
    const grain = fbm(u * 3 + plankIdx * 7, v * 26, 4, 8, seed + plankIdx) * detail;
    const rings = Math.sin((v * planks * 30) + grain * 9) * 0.5 + 0.5;
    let c = mixRgb(dark, base, 0.45 + tone + rings * 0.28 * detail);
    // 板の継ぎ目
    const seamY = Math.abs((v * planks) % 1 - 0.5) * 2;
    const seamX = Math.abs((uu * planks * 0.6) % 1 - 0.5) * 2;
    const seam = Math.max(seamY > 0.94 ? (seamY - 0.94) / 0.06 : 0, seamX > 0.985 ? (seamX - 0.985) / 0.015 : 0);
    c = mixRgb(c, [30, 20, 12], seam * 0.8);
    return {
      rgb: c,
      height: -seam * 0.6 + grain * 0.12,
      rough: 0.32 + grain * 0.18 + seam * 0.3,
    };
  });
}

/** タイル床 (目地付き) */
export function tileFloor(opts = {}) {
  const size = opts.size ?? 512;
  const tiles = opts.tiles ?? 4;
  const base = hexToRgb(opts.color ?? '#d8d5cd');
  const grout = hexToRgb(opts.groutColor ?? '#8f8c86');
  const detail = opts.detail ?? 1;
  const seed = opts.seed ?? 11;
  return generate(size, (x, y, u, v) => {
    const tu = u * tiles, tv = v * tiles;
    const iu = Math.floor(tu), iv = Math.floor(tv);
    const fu = tu - iu, fv = tv - iv;
    const edge = Math.min(Math.min(fu, 1 - fu), Math.min(fv, 1 - fv));
    const g = edge < 0.03 ? 1 : 0;
    const tone = (hash2(iu, iv, seed) - 0.5) * 0.10;
    const speck = fbm(u * 20, v * 20, 3, 32, seed) * 0.14 * detail;
    let c = mixRgb(base, [255, 255, 255], tone + speck - 0.05);
    c = mixRgb(c, grout, g);
    return { rgb: c, height: -g * 1.0, rough: g ? 0.85 : 0.18 + speck };
  });
}

/** カーペット / 布 */
export function carpet(opts = {}) {
  const size = opts.size ?? 512;
  const base = hexToRgb(opts.color ?? '#5b6470');
  const detail = opts.detail ?? 1;
  const seed = opts.seed ?? 21;
  return generate(size, (x, y, u, v) => {
    const fib = fbm(u * 8, v * 8, 5, 64, seed);
    const weave = (Math.sin(u * size * 0.7) * Math.sin(v * size * 0.7)) * 0.06;
    const c = mixRgb(base, [255, 255, 255], (fib - 0.5) * 0.35 * detail + weave);
    return { rgb: c, height: fib * 0.8 + weave * 2, rough: 0.9 - fib * 0.08 };
  });
}

/** 塗装壁 (ローラー跡と微細な凹凸) */
export function paintedWall(opts = {}) {
  const size = opts.size ?? 512;
  const base = hexToRgb(opts.color ?? '#e8e6e1');
  const detail = opts.detail ?? 1;
  const seed = opts.seed ?? 31;
  return generate(size, (x, y, u, v) => {
    const n = fbm(u * 4, v * 4, 5, 16, seed);
    const roller = Math.sin(v * 90 + n * 4) * 0.012;
    const stain = Math.max(0, fbm(u * 2, v * 2, 3, 4, seed + 5) - 0.62) * 0.5;
    const c = mixRgb(base, [190, 186, 178], ((n - 0.5) * 0.16 + roller + stain) * detail);
    return { rgb: c, height: n * 0.35 * detail, rough: 0.62 + n * 0.12 };
  });
}

/** コンクリート打ちっぱなし */
export function concrete(opts = {}) {
  const size = opts.size ?? 512;
  const base = hexToRgb(opts.color ?? '#b9b7b2');
  const detail = opts.detail ?? 1;
  const seed = opts.seed ?? 41;
  return generate(size, (x, y, u, v) => {
    const n = fbm(u * 6, v * 6, 6, 8, seed);
    const pores = Math.max(0, fbm(u * 40, v * 40, 2, 64, seed + 9) - 0.72) * 3;
    const stain = fbm(u * 1.5, v * 1.5, 3, 2, seed + 3);
    let c = mixRgb(base, [140, 138, 134], ((n - 0.5) * 0.5 + (stain - 0.5) * 0.3) * detail);
    c = mixRgb(c, [90, 88, 85], pores * 0.5);
    return { rgb: c, height: n * 0.5 - pores * 1.2, rough: 0.75 + n * 0.15 };
  });
}

/** 天井パネル (システム天井) */
export function ceilingPanel(opts = {}) {
  const size = opts.size ?? 512;
  const tiles = opts.tiles ?? 2;
  const base = hexToRgb(opts.color ?? '#f0efec');
  const seed = opts.seed ?? 51;
  return generate(size, (x, y, u, v) => {
    const tu = u * tiles, tv = v * tiles;
    const fu = tu - Math.floor(tu), fv = tv - Math.floor(tv);
    const edge = Math.min(Math.min(fu, 1 - fu), Math.min(fv, 1 - fv));
    const g = edge < 0.018 ? 1 : 0;
    const holes = Math.max(0, fbm(u * 60, v * 60, 2, 128, seed) - 0.58) * 2;
    let c = mixRgb(base, [220, 219, 214], holes * 0.5);
    c = mixRgb(c, [170, 170, 168], g);
    return { rgb: c, height: -g * 0.8 - holes * 0.5, rough: 0.9 };
  });
}

/** レンガ / タイル壁 */
export function brickWall(opts = {}) {
  const size = opts.size ?? 512;
  const rows = opts.rows ?? 8;
  const base = hexToRgb(opts.color ?? '#9c5a44');
  const grout = hexToRgb(opts.groutColor ?? '#cfc9bd');
  const seed = opts.seed ?? 61;
  return generate(size, (x, y, u, v) => {
    const rv = v * rows;
    const row = Math.floor(rv);
    const fv = rv - row;
    const uu = (u + (row % 2) * 0.5) * (rows / 2);
    const col = Math.floor(uu);
    const fu = uu - col;
    const g = (fv < 0.06 || fv > 0.94 || fu < 0.03 || fu > 0.97) ? 1 : 0;
    const tone = (hash2(col, row, seed) - 0.5) * 0.3;
    const n = fbm(u * 12, v * 12, 4, 16, seed);
    let c = mixRgb(base, [60, 35, 28], tone + (n - 0.5) * 0.2);
    c = mixRgb(c, grout, g);
    return { rgb: c, height: g ? -1.2 : n * 0.4, rough: g ? 0.95 : 0.7 + n * 0.15 };
  });
}

/** ホワイトボード / ガラス面 */
export function whiteboard(opts = {}) {
  const size = opts.size ?? 512;
  const seed = opts.seed ?? 71;
  return generate(size, (x, y, u, v) => {
    const n = fbm(u * 3, v * 3, 3, 8, seed);
    const smudge = Math.max(0, fbm(u * 5, v * 5, 4, 8, seed + 2) - 0.55) * 0.8;
    const frame = (u < 0.03 || u > 0.97 || v < 0.03 || v > 0.97) ? 1 : 0;
    let c = mixRgb([248, 249, 250], [225, 228, 230], smudge + (n - 0.5) * 0.05);
    c = mixRgb(c, [120, 124, 130], frame);
    return { rgb: c, height: frame ? 1.5 : 0, rough: frame ? 0.4 : 0.10 + smudge * 0.3 };
  });
}

/**
 * AprilTag 風のフィデューシャルマーカー。
 * 自己位置推定の基準や、既知ランドマークとして使える。
 * (実際の AprilTag のコードブックではなく、シード由来の擬似パターン)
 */
export function fiducialMarker(opts = {}) {
  const size = opts.size ?? 256;
  const bits = opts.bits ?? 6;
  const seed = opts.seed ?? 1;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  const cell = size / (bits + 4);
  ctx.fillStyle = '#000000';
  // 黒枠
  ctx.fillRect(cell, cell, size - 2 * cell, size - 2 * cell);
  // 内部ビット
  for (let by = 0; by < bits; by++) {
    for (let bx = 0; bx < bits; bx++) {
      if (hash2(bx, by, seed) > 0.5) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect((bx + 2) * cell, (by + 2) * cell, cell, cell);
      }
    }
  }
  // ID ラベル
  ctx.fillStyle = '#000000';
  ctx.font = `${Math.floor(cell * 0.8)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(`ID ${seed}`, size / 2, size - cell * 0.25);
  const map = canvasToTexture(canvas);
  return { map, roughnessMap: null, normalMap: null };
}

/** チェッカーボード (カメラキャリブレーション用) */
export function checkerboard(opts = {}) {
  const size = opts.size ?? 512;
  const cols = opts.cols ?? 8;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#101010';
  const c = size / cols;
  for (let y = 0; y < cols; y++) {
    for (let x = 0; x < cols; x++) {
      if ((x + y) % 2 === 0) ctx.fillRect(x * c, y * c, c, c);
    }
  }
  return { map: canvasToTexture(canvas), roughnessMap: null, normalMap: null };
}

/** ポスター / 掲示物 (特徴点を増やすための壁装飾) */
export function poster(opts = {}) {
  const size = opts.size ?? 256;
  const seed = opts.seed ?? 5;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const palette = [
    ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
    ['#1d3557', '#457b9d', '#a8dadc', '#f1faee', '#e63946'],
    ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'],
    ['#003049', '#d62828', '#f77f00', '#fcbf49', '#eae2b7'],
  ][Math.floor(hash2(seed, 7, 3) * 4)];
  ctx.fillStyle = palette[4];
  ctx.fillRect(0, 0, size, size);
  const kind = Math.floor(hash2(seed, 13, 9) * 3);
  if (kind === 0) {
    // 幾何学模様
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = palette[Math.floor(hash2(i, seed, 2) * 4)];
      const w = hash2(i, seed, 5) * size * 0.5 + 20;
      ctx.fillRect(hash2(i, seed, 6) * size, hash2(i, seed, 7) * size, w, hash2(i, seed, 8) * size * 0.3 + 10);
    }
  } else if (kind === 1) {
    // グラフ風
    ctx.strokeStyle = palette[0]; ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) {
      const px = (i / 20) * size;
      const py = size * (0.3 + 0.5 * fbm(i * 0.3, seed, 3, 8, seed));
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = palette[i % 4];
      ctx.fillRect(20 + i * (size - 40) / 6, size * 0.7, (size - 60) / 8, size * 0.25 * hash2(i, seed, 11));
    }
  } else {
    // 文字組み
    ctx.fillStyle = palette[0];
    ctx.fillRect(0, 0, size, size * 0.22);
    ctx.fillStyle = palette[4];
    ctx.font = `bold ${Math.floor(size * 0.12)}px sans-serif`;
    ctx.fillText('LAB', size * 0.08, size * 0.16);
    ctx.fillStyle = palette[1];
    for (let i = 0; i < 9; i++) {
      ctx.fillRect(size * 0.08, size * (0.3 + i * 0.07), size * (0.3 + hash2(i, seed, 3) * 0.55), size * 0.03);
    }
  }
  return { map: canvasToTexture(canvas), roughnessMap: null, normalMap: null };
}

/** 単色マテリアル用のわずかなノイズ (完全な平面を避ける) */
export function subtleNoise(opts = {}) {
  const size = opts.size ?? 256;
  const base = hexToRgb(opts.color ?? '#c8c8c8');
  const seed = opts.seed ?? 91;
  const amount = opts.amount ?? 0.06;
  return generate(size, (x, y, u, v) => {
    const n = fbm(u * 8, v * 8, 4, 16, seed);
    return {
      rgb: mixRgb(base, [255, 255, 255], (n - 0.5) * amount * 2),
      height: n * 0.2,
      rough: (opts.roughness ?? 0.6) + (n - 0.5) * 0.1,
    };
  });
}

/* ------------------------------------------------------------------ */
/* キャッシュ付きファクトリ                                             */
/* ------------------------------------------------------------------ */

const GENERATORS = {
  wood: woodFloor,
  tile: tileFloor,
  carpet,
  paint: paintedWall,
  concrete,
  ceiling: ceilingPanel,
  brick: brickWall,
  whiteboard,
  marker: fiducialMarker,
  checker: checkerboard,
  poster,
  plain: subtleNoise,
};

export const TEXTURE_KINDS = Object.keys(GENERATORS);

const cache = new Map();

/**
 * テクスチャを生成 (同じ設定ならキャッシュを返す)。
 * @param {string} kind TEXTURE_KINDS のいずれか
 * @param {object} opts
 * @param {{x:number,y:number}} repeat UV の繰り返し数
 */
export function getTexture(kind, opts = {}, repeat = null) {
  const key = kind + JSON.stringify(opts);
  let tex = cache.get(key);
  if (!tex) {
    const gen = GENERATORS[kind] || subtleNoise;
    tex = gen(opts);
    cache.set(key, tex);
  }
  if (repeat) {
    // 繰り返し数が違う場合はクローンして設定 (元のキャッシュは壊さない)
    const out = {};
    for (const [k, v] of Object.entries(tex)) {
      if (!v) { out[k] = v; continue; }
      const c = v.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(repeat.x, repeat.y);
      c.needsUpdate = true;
      out[k] = c;
    }
    return out;
  }
  return tex;
}

export function clearTextureCache() {
  for (const t of cache.values()) {
    for (const v of Object.values(t)) if (v && v.dispose) v.dispose();
  }
  cache.clear();
}
