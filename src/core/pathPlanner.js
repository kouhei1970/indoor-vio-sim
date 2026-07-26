/**
 * 障害物を避ける経路計画。
 *
 * === なぜこの構成か ===
 *
 * 本シミュレータの環境は「静的」で「完全に既知」(当たり判定の箱がそのまま
 * 地図になる)。実時間で再計画する必要も無い。したがって Fast-Planner
 * (Zhou et al. 2019) や EGO-Planner (Zhou et al. 2020) のような、局所再計画を
 * 前提とした ESDF + B-spline の勾配最適化は過剰である。
 * 古典的で保証のはっきりした次の構成を採る。
 *
 *   1. C 空間の占有格子   障害物を機体半径ぶん膨らませてボクセル化する。
 *                        以降は機体を点として扱える (Configuration space)。
 *   2. A* 探索            26 近傍のグリッド上で最短経路を探す。格子の分解能の
 *                        範囲で「経路があれば必ず見つかる」(完全性)。
 *   3. String pulling     見通し (line of sight) が通る中継点を飛ばして
 *                        経路を短くし、格子由来の階段状を直線化する。
 *                        Theta* (Daniel et al. 2010) と同じ見通し判定を、
 *                        後処理として使う形。
 *   4. 角の丸め           各コーナーを二次ベジェで丸める。丸め半径を縮めながら
 *                        衝突判定に通るものだけを採用するので、平滑化しても
 *                        安全性が崩れない。
 *
 * 3 と 4 は「A* の結果 (必ず安全) を出発点に、安全性を確認しながらだけ
 * 短く・滑らかにする」ので、失敗しても最悪 A* の経路に戻るだけで済む。
 *
 * === 参考 ===
 *   Daniel, Nash, Koenig, Felner (2010) "Theta*: Any-Angle Path Planning on Grids", JAIR
 *   Hernandez et al. (2020) "Toward a String-Pulling Approach to Path Smoothing on Grid Graphs", SoCS
 *   Mellinger & Kumar (2011) "Minimum snap trajectory generation and control for quadrotors", ICRA
 *   Zhou et al. (2019) "Robust and Efficient Quadrotor Trajectory Generation for Fast Autonomous Flight", RA-L
 *
 * 時間方向の割り当て (minimum snap など) は行わない。本シミュレータは
 * 弧長に沿った等速で追従する仕様で、速度は cfg.speed が決めるため。
 */

import { v3, vadd, vsub, vmul, vlen, clamp } from './math.js';

/** 構造体 (上を越えられないもの)。膨張量を分ける用途で使う。 */
const STRUCTURAL = new Set(['wall', 'slab', 'ceiling']);

/**
 * C 空間の占有格子。
 *
 * 障害物を「機体半径 + 余裕」だけ膨らませて刻む。こうしておくと以降は
 * 機体を大きさの無い点として扱えるので、探索も見通し判定も点で済む。
 */
export class OccupancyGrid {
  /**
   * @param {{min:{x,y,z}, max:{x,y,z}}} bounds 部屋の外形
   * @param {Array} boxes 当たり判定の箱 (CollisionWorld.boxes)
   * @param {object} opts {res: 格子の刻み [m], clearance: 機体半径 + 余裕 [m]}
   */
  constructor(bounds, boxes, opts = {}) {
    this.res = opts.res ?? 0.3;
    this.clearance = opts.clearance ?? 0.35;
    const m = this.clearance;
    // 壁の内側 clearance ぶんは飛べないので、最初から範囲を狭めておく
    this.min = v3(bounds.min.x + m, bounds.min.y + m, bounds.min.z + m);
    this.max = v3(bounds.max.x - m, bounds.max.y - m, bounds.max.z - m);
    this.nx = Math.max(1, Math.ceil((this.max.x - this.min.x) / this.res));
    this.ny = Math.max(1, Math.ceil((this.max.y - this.min.y) / this.res));
    this.nz = Math.max(1, Math.ceil((this.max.z - this.min.z) / this.res));
    this.data = new Uint8Array(this.nx * this.ny * this.nz);
    this.occupied = 0;
    // A* の作業配列。区間ごとに確保すると往復スキャンで数百 MB になるので
    // 格子に持たせて使い回す。stamp が今回の探索 id と違えば未訪問とみなす。
    this.gCost = new Float32Array(this.data.length);
    this.came = new Int32Array(this.data.length);
    this.stamp = new Int32Array(this.data.length);
    this.search = 0;
    for (const b of boxes || []) this.rasterize(b);
  }

  index(i, j, k) { return (k * this.ny + j) * this.nx + i; }

  /** ボクセルの中心座標 */
  center(i, j, k) {
    return v3(this.min.x + (i + 0.5) * this.res,
      this.min.y + (j + 0.5) * this.res,
      this.min.z + (k + 0.5) * this.res);
  }

  /** 座標 → ボクセル添字 (範囲外はクランプ) */
  cell(p) {
    return {
      i: clamp(Math.floor((p.x - this.min.x) / this.res), 0, this.nx - 1),
      j: clamp(Math.floor((p.y - this.min.y) / this.res), 0, this.ny - 1),
      k: clamp(Math.floor((p.z - this.min.z) / this.res), 0, this.nz - 1),
    };
  }

  /** 箱 1 個を、膨張させて格子へ焼く */
  rasterize(b) {
    const pad = this.clearance;
    // 回転を考慮した AABB で走査範囲を絞る
    const ex = Math.abs(b.half.x * b.cos) + Math.abs(b.half.z * b.sin) + pad;
    const ez = Math.abs(b.half.x * b.sin) + Math.abs(b.half.z * b.cos) + pad;
    const lo = this.cell(v3(b.center.x - ex, b.center.y - b.half.y - pad, b.center.z - ez));
    const hi = this.cell(v3(b.center.x + ex, b.center.y + b.half.y + pad, b.center.z + ez));
    for (let k = lo.k; k <= hi.k; k++) {
      for (let j = lo.j; j <= hi.j; j++) {
        for (let i = lo.i; i <= hi.i; i++) {
          const c = this.center(i, j, k);
          const dx = c.x - b.center.x, dz = c.z - b.center.z;
          const lx = dx * b.cos + dz * b.sin;
          const lz = -dx * b.sin + dz * b.cos;
          if (Math.abs(lx) > b.half.x + pad) continue;
          if (Math.abs(lz) > b.half.z + pad) continue;
          if (Math.abs(c.y - b.center.y) > b.half.y + pad) continue;
          const n = this.index(i, j, k);
          if (!this.data[n]) { this.data[n] = 1; this.occupied++; }
        }
      }
    }
  }

  freeCell(i, j, k) {
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return false;
    return this.data[this.index(i, j, k)] === 0;
  }

  /** その座標が空いているか */
  free(p) {
    if (p.x < this.min.x || p.x > this.max.x) return false;
    if (p.y < this.min.y || p.y > this.max.y) return false;
    if (p.z < this.min.z || p.z > this.max.z) return false;
    const c = this.cell(p);
    return this.data[this.index(c.i, c.j, c.k)] === 0;
  }

  /**
   * a → b が塞がれていないか (見通し判定)。
   *
   * 線分が通るボクセルを**すべて**列挙して調べる (Amanatides & Woo の
   * 3D DDA)。等間隔の標本化だと、ボクセルの角をかすめる線分を見落とすことが
   * あり、同じ線分でも刻み方によって判定が変わってしまう。走査なら
   * 「その線分が触れるボクセル」が一意に決まるので、部分区間の判定が
   * 元の区間と食い違うことがない。
   */
  lineOfSight(a, b) {
    if (!this.free(a) || !this.free(b)) return false;
    const res = this.res;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    let i = clamp(Math.floor((a.x - this.min.x) / res), 0, this.nx - 1);
    let j = clamp(Math.floor((a.y - this.min.y) / res), 0, this.ny - 1);
    let k = clamp(Math.floor((a.z - this.min.z) / res), 0, this.nz - 1);
    const ei = clamp(Math.floor((b.x - this.min.x) / res), 0, this.nx - 1);
    const ej = clamp(Math.floor((b.y - this.min.y) / res), 0, this.ny - 1);
    const ek = clamp(Math.floor((b.z - this.min.z) / res), 0, this.nz - 1);

    // 各軸の進む向きと、次の境界までの媒介変数 t (0→1 が線分全体)
    const setup = (d, p, idx, minV) => {
      if (Math.abs(d) < 1e-12) return { step: 0, tMax: Infinity, tDelta: Infinity };
      const step = d > 0 ? 1 : -1;
      const bound = minV + (idx + (d > 0 ? 1 : 0)) * res;
      return { step, tMax: (bound - p) / d, tDelta: Math.abs(res / d) };
    };
    const X = setup(dx, a.x, i, this.min.x);
    const Y = setup(dy, a.y, j, this.min.y);
    const Z = setup(dz, a.z, k, this.min.z);

    const limit = this.nx + this.ny + this.nz + 3;
    for (let n = 0; n <= limit; n++) {
      if (!this.freeCell(i, j, k)) return false;
      if (i === ei && j === ej && k === ek) return true;
      if (X.tMax <= Y.tMax && X.tMax <= Z.tMax) {
        if (X.tMax > 1) return true;
        i += X.step; X.tMax += X.tDelta;
      } else if (Y.tMax <= Z.tMax) {
        if (Y.tMax > 1) return true;
        j += Y.step; Y.tMax += Y.tDelta;
      } else {
        if (Z.tMax > 1) return true;
        k += Z.step; Z.tMax += Z.tDelta;
      }
    }
    return true;
  }

  /**
   * p に最も近い空きボクセルの中心を返す (p が既に空きならそのまま)。
   * ウェイポイントが家具の中に落ちている場合に使う。
   */
  nearestFree(p, maxRadius = 3.0) {
    if (this.free(p)) return p;
    const c = this.cell(p);
    const steps = Math.ceil(maxRadius / this.res);
    let best = null, bestD = Infinity;
    for (let r = 1; r <= steps; r++) {
      for (let dk = -r; dk <= r; dk++) {
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            // 立方体の殻だけ見る
            if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
            const i = c.i + di, j = c.j + dj, k = c.k + dk;
            if (!this.freeCell(i, j, k)) continue;
            const q = this.center(i, j, k);
            const d = vlen(vsub(q, p));
            if (d < bestD) { bestD = d; best = q; }
          }
        }
      }
      if (best) return best;      // 近い殻から順に見ているので最初に見つかったもので良い
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* A* 探索                                                             */
/* ------------------------------------------------------------------ */

/** 二分ヒープ (優先度付きキュー) */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node, f) {
    this.a.push({ node, f });
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].f <= this.a[i].f) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop() {
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < this.a.length && this.a[l].f < this.a[s].f) s = l;
        if (r < this.a.length && this.a[r].f < this.a[s].f) s = r;
        if (s === i) break;
        [this.a[s], this.a[i]] = [this.a[i], this.a[s]];
        i = s;
      }
    }
    return top;
  }
}

// 26 近傍 (斜めも含む)
const NEIGHBORS = (() => {
  const out = [];
  for (let dk = -1; dk <= 1; dk++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di || dj || dk) out.push([di, dj, dk, Math.sqrt(di * di + dj * dj + dk * dk)]);
      }
    }
  }
  return out;
})();

/**
 * 格子上の A* 探索。
 *
 * @returns {Array|null} 経路 (ボクセル中心の列)。見つからなければ null
 */
export function astar(grid, from, to, maxExpand = 200000) {
  const a = grid.cell(from), b = grid.cell(to);
  if (!grid.freeCell(a.i, a.j, a.k) || !grid.freeCell(b.i, b.j, b.k)) return null;
  const start = grid.index(a.i, a.j, a.k);
  const goal = grid.index(b.i, b.j, b.k);
  if (start === goal) return [grid.center(a.i, a.j, a.k)];

  const id = ++grid.search;
  const { gCost, came, stamp } = grid;
  const seen = (n) => stamp[n] === id;
  const h = (i, j, k) => Math.hypot(i - b.i, j - b.j, k - b.k);
  const closed = new Set();

  const open = new Heap();
  stamp[start] = id; gCost[start] = 0; came[start] = -1;
  open.push(start, h(a.i, a.j, a.k));
  let expanded = 0;

  let reached = false;
  while (open.size) {
    const { node } = open.pop();
    if (closed.has(node)) continue;
    closed.add(node);
    if (node === goal) { reached = true; break; }
    if (++expanded > maxExpand) return null;

    const i = node % grid.nx;
    const j = Math.floor(node / grid.nx) % grid.ny;
    const k = Math.floor(node / (grid.nx * grid.ny));
    for (const [di, dj, dk, cost] of NEIGHBORS) {
      const ni = i + di, nj = j + dj, nk = k + dk;
      if (!grid.freeCell(ni, nj, nk)) continue;
      // 角抜けの禁止: 斜めに動くとき、その成分ごとの隣も空いていること。
      // これが無いと、対角に並んだ障害物の「隙間」をすり抜ける経路が出る。
      if (di && !grid.freeCell(i + di, j, k)) continue;
      if (dj && !grid.freeCell(i, j + dj, k)) continue;
      if (dk && !grid.freeCell(i, j, k + dk)) continue;
      const n = grid.index(ni, nj, nk);
      if (closed.has(n)) continue;
      const ng = gCost[node] + cost;
      if (!seen(n) || ng < gCost[n]) {
        stamp[n] = id;
        gCost[n] = ng;
        came[n] = node;
        open.push(n, ng + h(ni, nj, nk));
      }
    }
  }
  if (!reached) return null;

  const path = [];
  for (let n = goal; n !== -1; n = came[n]) {
    const i = n % grid.nx;
    const j = Math.floor(n / grid.nx) % grid.ny;
    const k = Math.floor(n / (grid.nx * grid.ny));
    path.push(grid.center(i, j, k));
    if (n === start) break;
  }
  path.reverse();
  return path;
}

/* ------------------------------------------------------------------ */
/* 後処理                                                              */
/* ------------------------------------------------------------------ */

/**
 * String pulling — 見通しの通る点まで一気に飛ばして経路を短くする。
 *
 * 格子上の A* はどうしても階段状になるので、ここで直線化する。
 * 見通し判定は必ず占有格子に問うので、短くしても安全性は保たれる。
 */
export function stringPull(grid, path) {
  if (!path || path.length <= 2) return path || [];
  const out = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let j = path.length - 1;
    // 遠いほうから順に、見通しの通る点を探す
    while (j > i + 1 && !grid.lineOfSight(path[i], path[j])) j--;
    out.push(path[j]);
    i = j;
  }
  return out;
}

/**
 * 角を丸める。
 *
 * 折れ線のままだと機体が各点で止まりかけるので、コーナーを二次ベジェで
 * 丸める。丸め半径を大きいほうから試し、**衝突判定に通ったものだけ**
 * 採用するので、平滑化によって障害物に触れることはない。
 *
 * @param {number} radius 最大の丸め半径 [m]
 */
export function roundCorners(grid, path, radius = 0.8, samples = 8) {
  if (!path || path.length <= 2) return path || [];
  const out = [path[0]];

  /**
   * 直前の点から順に見通しを確認しながら継ぎ足す。
   * 1 区間でも通らなければ何も足さずに false を返すので、
   * 「出力に入った区間はすべて検査済み」が構成として保証される。
   */
  const tryAppend = (pts) => {
    let prev = out[out.length - 1];
    for (const q of pts) {
      if (!grid.lineOfSight(prev, q)) return false;
      prev = q;
    }
    out.push(...pts);
    return true;
  };

  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1], cur = path[i], next = path[i + 1];
    const dA = vsub(prev, cur), dB = vsub(next, cur);
    const lA = vlen(dA), lB = vlen(dB);
    let done = false;
    if (lA > 1e-6 && lB > 1e-6) {
      for (const r of [radius, radius * 0.5, radius * 0.25]) {
        const rr = Math.min(r, lA * 0.45, lB * 0.45);
        if (rr < 0.05) continue;
        const p0 = vadd(cur, vmul(dA, rr / lA));
        const p2 = vadd(cur, vmul(dB, rr / lB));
        const arc = [];
        for (let sIdx = 0; sIdx <= samples; sIdx++) {
          const t = sIdx / samples;
          const u = 1 - t;
          // 二次ベジェ p0 → cur → p2
          arc.push(v3(u * u * p0.x + 2 * u * t * cur.x + t * t * p2.x,
            u * u * p0.y + 2 * u * t * cur.y + t * t * p2.y,
            u * u * p0.z + 2 * u * t * cur.z + t * t * p2.z));
        }
        if (tryAppend(arc)) { done = true; break; }
      }
    }
    // 丸められない角はそのまま残す (安全側)
    if (!done && !tryAppend([cur])) out.push(cur);
  }
  if (!tryAppend([path[path.length - 1]])) out.push(path[path.length - 1]);
  return out;
}

/* ------------------------------------------------------------------ */

/**
 * ウェイポイント列を、障害物を避ける経路へ引き直す。
 *
 * 各区間について
 *   - 直線で見通しが通るならそのまま (パターンの形をできるだけ保つ)
 *   - 通らなければ A* → string pulling で迂回路を作る
 *   - A* でも見つからなければ直線のまま残す (行けない所は行けないと分かる)
 * とし、最後に角を丸める。
 *
 * @param {OccupancyGrid} grid
 * @param {Array} waypoints 元のウェイポイント列
 * @param {object} opts {corner: 丸め半径 [m]}
 * @returns {{points: Array, replanned: number, failed: number}}
 */
export function planThrough(grid, waypoints, opts = {}) {
  if (!waypoints || waypoints.length < 2) return { points: waypoints || [], replanned: 0, failed: 0 };

  // 障害物の中に落ちているウェイポイントは、いちばん近い空きへ寄せる
  const wps = [];
  for (const w of waypoints) {
    const q = grid.free(w) ? w : grid.nearestFree(w);
    if (q) wps.push(q);
  }
  if (wps.length < 2) return { points: waypoints, replanned: 0, failed: waypoints.length };

  const out = [wps[0]];
  let replanned = 0, failed = 0;
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i], b = wps[i + 1];
    if (grid.lineOfSight(a, b)) { out.push(b); continue; }
    const raw = astar(grid, a, b);
    if (!raw) { out.push(b); failed++; continue; }
    // A* の経路はボクセル中心の列なので、両端に本当のウェイポイントを足してから
    // 短縮する。こうしないと a → 最初のボクセル中心の区間が未検査のまま残る。
    const pulled = stringPull(grid, [a, ...raw, b]);
    for (let k = 1; k < pulled.length; k++) out.push(pulled[k]);
    replanned++;
  }
  // 最終検証: 全区間の見通しを確認し、通らない区間は A* で引き直す。
  // 平滑化 (角の丸め) の前に行い、丸めた結果は roundCorners が個別に検証する。
  const safe = [out[0]];
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i], b = out[i + 1];
    if (grid.lineOfSight(a, b)) { safe.push(b); continue; }
    const raw = astar(grid, a, b);
    if (raw) {
      const pulled = stringPull(grid, [a, ...raw, b]);
      for (let k = 1; k < pulled.length; k++) safe.push(pulled[k]);
      replanned++;
    } else { safe.push(b); failed++; }
  }

  const points = roundCorners(grid, safe, opts.corner ?? 0.8);
  // 自己検証 (開発用): 出力の全区間が本当に通れるか
  let badSafe = 0, badFinal = 0;
  for (let i = 0; i + 1 < safe.length; i++) if (!grid.lineOfSight(safe[i], safe[i + 1])) badSafe++;
  for (let i = 0; i + 1 < points.length; i++) if (!grid.lineOfSight(points[i], points[i + 1])) badFinal++;
  return { points, replanned, failed, badSafe, badFinal };
}

export { STRUCTURAL };
