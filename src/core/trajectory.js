/**
 * 自動飛行の軌道生成。データセット収集で使うスキャンパターンを揃えている。
 *
 *   hover      : その場ホバリング
 *   waypoints  : 任意のウェイポイント列 (Catmull-Rom で平滑化)
 *   lawnmower  : 往復スキャン (地図作成・床面撮影向け)
 *   spiral     : 螺旋上昇 (部屋全体を広くカバー)
 *   orbit      : 注視点まわりの周回 (物体中心の撮影, NeRF/3DGS 向け)
 *   figure8    : 8 の字 (加減速と旋回が入るので VIO の評価に向く)
 *   perimeter  : 壁沿い一周 + ヨー掃引
 *   random     : ランダムウォーク (学習データの多様性確保)
 *
 * ヨー制御は fixed / along-path / look-at / sweep から選べる。
 */

import { v3, vadd, vsub, vmul, vlen, vnorm, clamp, lerp, makeRng, wrapPi } from './math.js';

export const PATTERNS = ['hover', 'waypoints', 'lawnmower', 'spiral', 'orbit', 'figure8', 'perimeter', 'random'];
export const YAW_MODES = ['fixed', 'along-path', 'look-at', 'sweep'];

export class Trajectory {
  constructor(cfg, roomBounds) {
    this.cfg = cfg;
    this.bounds = roomBounds;
    this.rng = makeRng(cfg.seed ?? 2024);
    this.rebuild();
  }

  setRoom(bounds) { this.bounds = bounds; this.rebuild(); }

  rebuild() {
    this.points = this.generatePoints();
    this.lengths = [];
    this.total = 0;
    for (let i = 1; i < this.points.length; i++) {
      const d = vlen(vsub(this.points[i], this.points[i - 1]));
      this.total += d;
      this.lengths.push(this.total);
    }
    this.duration = this.total / Math.max(this.cfg.speed, 1e-3);
    this.randomState = null;
  }

  /** 部屋の内側に安全マージンを取った範囲 */
  safeBounds() {
    const m = this.cfg.margin;
    const b = this.bounds;
    return {
      minX: b.min.x + m, maxX: b.max.x - m,
      minZ: b.min.z + m, maxZ: b.max.z - m,
      minY: b.min.y + this.cfg.minAltitude, maxY: Math.min(b.max.y - m, b.min.y + this.cfg.maxAltitude),
    };
  }

  generatePoints() {
    const c = this.cfg;
    const s = this.safeBounds();
    const alt = clamp(c.altitude, s.minY, s.maxY);
    const pts = [];
    switch (c.pattern) {
      case 'waypoints': {
        const wps = c.waypoints && c.waypoints.length >= 2
          ? c.waypoints.map((w) => v3(w.x, w.y, w.z))
          : [v3(s.minX, alt, s.minZ), v3(s.maxX, alt, s.minZ), v3(s.maxX, alt, s.maxZ), v3(s.minX, alt, s.maxZ)];
        return c.smooth ? resample(catmullRomLoop(wps, c.loop), c.resolution) : wps;
      }
      case 'lawnmower': {
        const rows = Math.max(2, Math.round(c.rows));
        for (let i = 0; i < rows; i++) {
          const z = lerp(s.minZ, s.maxZ, rows === 1 ? 0.5 : i / (rows - 1));
          const x0 = i % 2 === 0 ? s.minX : s.maxX;
          const x1 = i % 2 === 0 ? s.maxX : s.minX;
          pts.push(v3(x0, alt, z), v3(x1, alt, z));
        }
        return resample(pts, c.resolution);
      }
      case 'spiral': {
        const turns = Math.max(1, c.turns);
        const n = Math.max(16, Math.round(turns * 48));
        const rMax = Math.min((s.maxX - s.minX), (s.maxZ - s.minZ)) / 2;
        const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const ang = t * turns * Math.PI * 2;
          const r = lerp(c.radius * 0.2, Math.min(c.radius, rMax), t);
          pts.push(v3(cx + r * Math.cos(ang), lerp(s.minY, Math.min(s.maxY, alt), t), cz + r * Math.sin(ang)));
        }
        return pts;
      }
      case 'orbit': {
        const n = 128;
        const ctr = c.lookAt;
        for (let i = 0; i <= n; i++) {
          const ang = (i / n) * Math.PI * 2 * Math.max(1, c.turns);
          const t = i / n;
          const y = c.turns > 1
            ? lerp(alt, clamp(alt + c.climb, s.minY, s.maxY), t)  // 螺旋状に高度を変えて多視点を稼ぐ
            : alt;
          pts.push(v3(
            clamp(ctr.x + c.radius * Math.cos(ang), s.minX, s.maxX),
            y,
            clamp(ctr.z + c.radius * Math.sin(ang), s.minZ, s.maxZ),
          ));
        }
        return pts;
      }
      case 'figure8': {
        const n = 160;
        const cx = (s.minX + s.maxX) / 2, cz = (s.minZ + s.maxZ) / 2;
        const a = Math.min(c.radius, (s.maxX - s.minX) / 2);
        const b = Math.min(c.radius * 0.6, (s.maxZ - s.minZ) / 2);
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * Math.PI * 2;
          pts.push(v3(cx + a * Math.sin(t), alt + c.climb * 0.5 * Math.sin(2 * t), cz + b * Math.sin(2 * t)));
        }
        return pts;
      }
      case 'perimeter': {
        const corners = [
          v3(s.minX, alt, s.minZ), v3(s.maxX, alt, s.minZ),
          v3(s.maxX, alt, s.maxZ), v3(s.minX, alt, s.maxZ), v3(s.minX, alt, s.minZ),
        ];
        return resample(corners, c.resolution);
      }
      case 'random': {
        const n = Math.max(4, Math.round(c.rows * 4));
        let cur = v3((s.minX + s.maxX) / 2, alt, (s.minZ + s.maxZ) / 2);
        pts.push(cur);
        for (let i = 0; i < n; i++) {
          cur = v3(
            clamp(cur.x + this.rng.range(-1, 1) * c.radius, s.minX, s.maxX),
            clamp(cur.y + this.rng.range(-0.5, 0.5) * c.climb, s.minY, s.maxY),
            clamp(cur.z + this.rng.range(-1, 1) * c.radius, s.minZ, s.maxZ),
          );
          pts.push(cur);
        }
        return c.smooth ? resample(catmullRomLoop(pts, false), c.resolution) : pts;
      }
      case 'hover':
      default:
        return [v3(c.hover.x, clamp(c.hover.y, s.minY, s.maxY), c.hover.z)];
    }
  }

  /**
   * 時刻 t における目標を返す。
   * @returns {{position, velocity, acceleration, yaw, progress}}
   */
  sample(t) {
    const c = this.cfg;
    if (this.points.length === 1 || this.total < 1e-6) {
      const p = this.points[0];
      return {
        position: p, velocity: v3(0, 0, 0), acceleration: v3(0, 0, 0),
        yaw: this.yawFor(t, p, v3(0, 0, 0)), progress: 0,
      };
    }
    const speed = c.speed;
    let dist = speed * t;
    let progress = dist / this.total;
    if (c.loop) {
      dist = ((dist % this.total) + this.total) % this.total;
    } else {
      // 往復
      const cycle = this.total * 2;
      let d = ((dist % cycle) + cycle) % cycle;
      dist = d <= this.total ? d : cycle - d;
    }
    const { position, tangent } = this.pointAt(dist);
    // 速度ベクトルは接線 × 速度 (端点で減速する台形プロファイル)
    const ramp = c.loop ? 1 : smoothEnds(dist / this.total, 0.08);
    const velocity = vmul(tangent, speed * ramp);
    // 加速度は数値微分
    const ahead = this.pointAt(clamp(dist + 0.05, 0, this.total));
    const acceleration = vmul(vsub(ahead.tangent, tangent), (speed * speed) / 0.05 * 0.5);
    return {
      position, velocity, acceleration,
      yaw: this.yawFor(t, position, velocity),
      progress: clamp(progress, 0, 1e9),
    };
  }

  pointAt(dist) {
    const pts = this.points;
    let i = 0;
    while (i < this.lengths.length - 1 && this.lengths[i] < dist) i++;
    const d0 = i === 0 ? 0 : this.lengths[i - 1];
    const seg = this.lengths[i] - d0;
    const u = seg > 1e-9 ? clamp((dist - d0) / seg, 0, 1) : 0;
    const a = pts[i], b = pts[i + 1] || pts[i];
    return {
      position: v3(lerp(a.x, b.x, u), lerp(a.y, b.y, u), lerp(a.z, b.z, u)),
      tangent: vnorm(vsub(b, a)),
    };
  }

  yawFor(t, pos, vel) {
    const c = this.cfg;
    switch (c.yawMode) {
      case 'along-path': {
        if (vlen(vel) < 1e-3) return c.yaw;
        // 前方 = -z。ヨー ψ は上から見て反時計回り正。
        return Math.atan2(-vel.x, -vel.z);
      }
      case 'look-at': {
        const d = vsub(c.lookAt, pos);
        return Math.atan2(-d.x, -d.z);
      }
      case 'sweep':
        return wrapPi(c.yaw + t * c.yawRate);
      case 'fixed':
      default:
        return c.yaw;
    }
  }

  /** 描画用のポリライン */
  polyline() { return this.points; }
}

/** 端点で滑らかに減速させる係数 */
function smoothEnds(u, w) {
  const a = clamp(u / w, 0, 1);
  const b = clamp((1 - u) / w, 0, 1);
  const s = (x) => x * x * (3 - 2 * x);
  return Math.min(s(a), s(b)) * 0.9 + 0.1;
}

/** Catmull-Rom スプラインで通過点を補間 */
export function catmullRomLoop(pts, loop = true, samplesPerSeg = 12) {
  if (pts.length < 3) return pts.slice();
  const out = [];
  const n = pts.length;
  const get = (i) => {
    if (loop) return pts[((i % n) + n) % n];
    return pts[clamp(i, 0, n - 1)];
  };
  const segs = loop ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      out.push(catmullRom(p0, p1, p2, p3, t));
    }
  }
  if (!loop) out.push(pts[n - 1]);
  return out;
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return v3(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z));
}

/** 等間隔リサンプリング */
export function resample(pts, step = 0.25) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = vlen(vsub(b, a));
    const n = Math.max(1, Math.round(d / step));
    for (let k = 1; k <= n; k++) out.push(vadd(a, vmul(vsub(b, a), k / n)));
  }
  return out;
}

export const TRAJECTORY_DEFAULTS = {
  pattern: 'lawnmower',
  yawMode: 'along-path',
  speed: 0.6,
  altitude: 1.2,
  minAltitude: 0.4,
  maxAltitude: 2.2,
  margin: 0.9,
  rows: 5,
  turns: 2,
  radius: 1.5,
  climb: 0.8,
  resolution: 0.3,
  smooth: true,
  loop: false,
  yaw: 0,
  yawRate: 0.35,
  hover: { x: 0, y: 1.2, z: 0 },
  lookAt: { x: 0, y: 0.9, z: 0 },
  waypoints: [],
  seed: 2024,
};
