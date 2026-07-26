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
 *   route      : 建物プリセットに書かれた点検・巡回ルートを追従
 *                (階段室や吹抜を通って上下階へ移動する。建物モード専用)
 *
 * ヨー制御は fixed / along-path / look-at / sweep から選べる。
 */

import { v3, vadd, vsub, vmul, vlen, vnorm, clamp, lerp, makeRng, wrapPi } from './math.js';
import { OccupancyGrid, planThrough } from './pathPlanner.js';

export const PATTERNS = ['hover', 'waypoints', 'lawnmower', 'spiral', 'orbit', 'figure8', 'perimeter', 'random', 'route'];
export const YAW_MODES = ['fixed', 'along-path', 'look-at', 'sweep'];

export class Trajectory {
  constructor(cfg, roomBounds) {
    this.cfg = cfg;
    this.bounds = roomBounds;
    this.building = null;
    this.rng = makeRng(cfg.seed ?? 2024);
    this.rebuild();
  }

  setRoom(bounds) { this.bounds = bounds; this.grid = null; this.rebuild(); }

  /**
   * 建物プリセットを渡す (単室なら null)。
   * pattern = 'route' のとき preset.routes から経路を取る。
   */
  setBuilding(preset) { this.building = preset || null; this.rebuild(); }

  /** 現在の建物で選べるルート名 */
  routeNames() { return this.building ? Object.keys(this.building.routes || {}) : []; }

  /**
   * 障害物を教える。以降、軌道はこれらを避けて引かれる
   * (経路計画の中身は core/pathPlanner.js を参照)。
   *
   * 壁・床・天井も含める。占有格子の上で A* を回すので、扉を通って
   * 隣室へ回り込むといった経路も出せる。
   *
   * @param {Array} boxes CollisionWorld.boxes
   */
  setObstacles(boxes) {
    this.obstacleBoxes = boxes || [];
    this.grid = null;          // 作り直す
    this.rebuild();
  }

  /** 占有格子 (環境が変わるまで使い回す) */
  ensureGrid() {
    if (this.grid !== null && this.grid !== undefined) return this.grid;
    if (!this.obstacleBoxes || !this.obstacleBoxes.length || !this.bounds) return null;
    this.grid = new OccupancyGrid(this.bounds, this.obstacleBoxes, {
      res: this.cfg.planResolution ?? 0.25,
      clearance: this.cfg.clearance ?? 0.25,
    });
    return this.grid;
  }

  /**
   * パターンが出したウェイポイント列を、障害物を避ける経路へ引き直す。
   * cfg.avoidObstacles を false にすると素の幾何パターンのまま使える
   * (再現性を優先したい実験用)。
   */
  planAround(pts) {
    this.planInfo = null;
    if (!this.cfg.avoidObstacles || !pts || pts.length < 2) return pts;
    const grid = this.ensureGrid();
    if (!grid) return pts;
    const r = planThrough(grid, pts, { corner: this.cfg.cornerRadius ?? 0.8 });
    this.planInfo = { replanned: r.replanned, failed: r.failed, points: r.points.length, badSafe: r.badSafe, badFinal: r.badFinal };
    return resample(r.points, this.cfg.resolution);
  }

  rebuild() {
    this.points = this.planAround(this.generatePoints());
    this.lengths = [];
    this.total = 0;
    for (let i = 1; i < this.points.length; i++) {
      const d = vlen(vsub(this.points[i], this.points[i - 1]));
      this.total += d;
      this.lengths.push(this.total);
    }
    this.buildSpeedProfile();
    this.randomState = null;
  }

  /**
   * 経路に沿った速度の割り当て (時間パラメータ化)。
   *
   * 経路が幾何的に安全でも、等速で追従すると鋭角で破綻する。半径 r の角を
   * 速度 v で曲がるには向心加速度 v^2/r が要るので、角が鋭いほど (r→0)
   * 必要な加速度が発散し、機体は曲がりきれずに外へ膨らんで衝突する。
   *
   * そこで経路の形はそのままに、速度のほうを実行可能な範囲へ落とす。
   * 経路が決まったあとに速度を割り当てるので、時間最適経路パラメータ化
   * (TOPP; Bobrow 1985 / Pham 2014) の最も簡単な形にあたる。
   *
   *   1. 各点の曲率 κ から横方向の上限   v ≤ √(a_lat / κ)
   *   2. 前向き走査で加速の上限          v[i+1]² ≤ v[i]² + 2 a_tan ds
   *   3. 後ろ向き走査で減速の上限        v[i]²   ≤ v[i+1]² + 2 a_tan ds
   *
   * a_lat はマルチコプタでは傾き角で決まる (a = g tanθ)。既定の 4.0 m/s² は
   * 傾き 22° 相当で、姿勢制御の追従遅れを見込んだ控えめな値。
   */
  buildSpeedProfile() {
    const c = this.cfg;
    const pts = this.points;
    const n = pts.length;
    this.speeds = new Array(Math.max(n, 1)).fill(0);
    this.times = new Array(Math.max(n, 1)).fill(0);
    if (n < 2 || this.total < 1e-6) { this.duration = 0; return; }

    const vMax = Math.max(0.05, c.speed);
    const aLat = Math.max(0.2, c.maxLateralAccel ?? 4.0);
    const aTan = Math.max(0.2, c.maxTangentialAccel ?? 2.0);
    const V_FLOOR = 0.05;                   // 完全停止で時間が発散しないように
    const v = new Array(n).fill(vMax);
    const ds = (i) => vlen(vsub(pts[i + 1], pts[i]));

    // 1) 曲率による上限 (Menger の曲率: 3 点を通る円の半径の逆数)
    for (let i = 1; i + 1 < n; i++) {
      const a = pts[i - 1], b = pts[i], d = pts[i + 1];
      const ab = vlen(vsub(b, a)), bc = vlen(vsub(d, b)), ac = vlen(vsub(d, a));
      if (ab < 1e-6 || bc < 1e-6 || ac < 1e-6) continue;
      // 三角形の面積 (外積の大きさ / 2)
      const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
      const wx = d.x - a.x, wy = d.y - a.y, wz = d.z - a.z;
      const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
      const area2 = Math.hypot(cx, cy, cz);          // = 2 x 面積
      const kappa = area2 / (ab * bc * ac);          // 曲率 = 4S/(abc) = 2*area2/(2abc)
      if (kappa > 1e-9) v[i] = Math.min(v[i], Math.sqrt(aLat / kappa));
    }

    // 端点。折り返し (loop = false) では停止して向きを変える
    if (!c.loop) { v[0] = 0; v[n - 1] = 0; }

    // 2) 前向き走査 (加速の上限)。周回では 2 周ぶん回して境目をなじませる
    const passes = c.loop ? 2 : 1;
    for (let r = 0; r < passes; r++) {
      for (let i = 0; i + 1 < n; i++) {
        v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] * v[i] + 2 * aTan * ds(i)));
      }
      if (c.loop) v[0] = Math.min(v[0], v[n - 1]);
    }
    // 3) 後ろ向き走査 (減速の上限)
    for (let r = 0; r < passes; r++) {
      for (let i = n - 2; i >= 0; i--) {
        v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * aTan * ds(i)));
      }
      if (c.loop) v[n - 1] = Math.min(v[n - 1], v[0]);
    }

    // 4) 時刻表 (区間内は等加速度とみなし、平均速度で時間を出す)
    this.speeds = v;
    this.times[0] = 0;
    for (let i = 0; i + 1 < n; i++) {
      const vm = Math.max(V_FLOOR, (v[i] + v[i + 1]) / 2);
      this.times[i + 1] = this.times[i] + ds(i) / vm;
    }
    this.duration = this.times[n - 1];
    this.buildYawProfile();
  }

  /**
   * 経路に沿った機首方位の割り当て。
   *
   * 'along-path' は進行方向を向くが、往復スキャンの折り返しのように経路が
   * 鋭角に曲がると**目標方位が不連続に反転する**。制御器はそれを追おうとして
   * 過大なヨー角速度を出し、ロール/ピッチと干渉して機体が転倒する
   * (実測: ヨー角速度 -564°/s、傾き 88° に達して墜落)。
   *
   * そこで速度と同じ考え方で、方位にも変化率の上限を掛ける。
   *   前向き走査  : 角を過ぎたあとゆっくり向き直る
   *   後ろ向き走査: 角の手前から向き始める (人が操縦するときと同じ)
   * 双方向にするのが要点で、前向きだけだと角に入ってから回り始めて間に合わない。
   */
  buildYawProfile() {
    const c = this.cfg;
    const pts = this.points;
    const n = pts.length;
    this.yaws = null;
    // 進行方向を向くモード以外は経路に依らないので表は要らない
    if (c.yawMode !== 'along-path' || n < 2) return;

    const maxRate = Math.max(0.1, (c.maxYawRate ?? 90) * Math.PI / 180);   // [rad/s]

    // 1) 各点の「向きたい方位」を連続化して並べる。
    //    ±π をまたぐ跳びを取り除いておかないと、平滑化が壊れる。
    const want = new Array(n);
    let prev = null;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      let y = (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9)
        ? (prev ?? c.yaw) : Math.atan2(-dx, -dz);
      if (prev !== null) y = prev + wrapPi(y - prev);    // 連続化 (unwrap)
      want[i] = y;
      prev = y;
    }

    // 2) 変化率が上限に収まるまで、対称な平滑化 (1/4, 1/2, 1/4) をくり返す。
    //    前向き/後ろ向きの速度制限と違い、方位は「行き過ぎて戻る」と機体が
    //    振られるので、左右対称にならす。対称なので角の手前から向き始め、
    //    角を過ぎてから向き終わる (人が操縦するときと同じ動き)。
    const yaw = want.slice();
    const dt = (i) => Math.max(1e-3, this.times[i + 1] - this.times[i]);
    const maxSlope = () => {
      let m = 0;
      for (let i = 0; i + 1 < n; i++) m = Math.max(m, Math.abs(yaw[i + 1] - yaw[i]) / dt(i));
      return m;
    };
    const tmp = new Array(n);
    for (let pass = 0; pass < 400 && maxSlope() > maxRate; pass++) {
      tmp[0] = yaw[0]; tmp[n - 1] = yaw[n - 1];
      for (let i = 1; i + 1 < n; i++) tmp[i] = 0.25 * yaw[i - 1] + 0.5 * yaw[i] + 0.25 * yaw[i + 1];
      for (let i = 0; i < n; i++) yaw[i] = tmp[i];
    }
    this.yaws = yaw;
  }

  /** 時刻 tt [s] における経路上の位置・速度 (0 ≤ tt ≤ duration) */
  stateAtTime(tt) {
    const times = this.times, pts = this.points, v = this.speeds;
    const n = pts.length;
    if (n < 2) return { position: pts[0], tangent: v3(0, 0, 1), speed: 0, index: 0, u: 0 };
    // 二分探索で区間を求める
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= tt) lo = mid; else hi = mid;
    }
    const i = clamp(lo, 0, n - 2);
    const dt = times[i + 1] - times[i];
    const u = dt > 1e-9 ? clamp((tt - times[i]) / dt, 0, 1) : 0;
    const a = pts[i], b = pts[i + 1];
    // ヨーは ±π をまたぐので、差を wrapPi してから補間する
    const yw = this.yaws
      ? wrapPi(this.yaws[i] + wrapPi(this.yaws[i + 1] - this.yaws[i]) * u)
      : null;
    return {
      position: v3(lerp(a.x, b.x, u), lerp(a.y, b.y, u), lerp(a.z, b.z, u)),
      tangent: vnorm(vsub(b, a)),
      speed: lerp(v[i], v[i + 1], u),
      yaw: yw,
      index: i,
      u,
    };
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

  /**
   * パターンの点列を作る。
   *
   * 周回 (loop = true) では、終点から始点へ戻る区間も経路に含める。
   * 閉じていないと、時刻が一周した瞬間に位置が飛ぶ。
   * 往復スキャンのように復路を明示的に作るパターンは、そちらで閉じている。
   */
  generatePoints() {
    const pts = this.generateRaw();
    if (!this.cfg.loop || pts.length < 2) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    if (vlen(vsub(b, a)) > 1e-3) pts.push(v3(a.x, a.y, a.z));
    return pts;
  }

  generateRaw() {
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
        // 往復スキャン。行を折り返しながら端から端まで舐める。
        const rows = Math.max(2, Math.round(c.rows));
        for (let i = 0; i < rows; i++) {
          const z = lerp(s.minZ, s.maxZ, rows === 1 ? 0.5 : i / (rows - 1));
          const x0 = i % 2 === 0 ? s.minX : s.maxX;
          const x1 = i % 2 === 0 ? s.maxX : s.minX;
          pts.push(v3(x0, alt, z), v3(x1, alt, z));
        }
        // --- 復路 (周回コース) ---
        //
        // loop = false のときは時間を折り返して同じ経路を逆にたどるため、
        // 機首は行きの向きのままで「後ろ向きに飛ぶ」ことになる。
        // そこで最後に始点へ戻る復路を継ぎ足して 1 本の周回コースにする。
        // 走査域の外側 (安全範囲の縁) を回るので、行のカバー範囲は変わらない。
        if (c.loop) {
          const first = pts[0];
          const last = pts[pts.length - 1];
          // 復路は**走査域の外側**を回す。行は安全範囲いっぱいに引いてあるので、
          // 安全範囲ではなく部屋の外形から測って、壁との間に残っている隙間を
          // 使う (安全マージン 0.9m のうち、経路計画の余裕 clearance を除いた分)。
          // ここを安全範囲でクランプすると、復路が最終行の上に重なって
          // 「行きの経路をなぞって戻る」ように見えてしまう。
          const b = this.bounds;
          const pad = (c.clearance ?? 0.25) + 0.25;   // 追従誤差ぶんの余裕も見る
          const off = c.returnOffset ?? 1.2;
          const outer = (v, lo, hi, dir) => clamp(v + dir * off, lo + pad, hi - pad);
          const zOut = outer(last.z, b.min.z, b.max.z, last.z >= first.z ? 1 : -1);
          const zIn = outer(first.z, b.min.z, b.max.z, first.z <= last.z ? -1 : 1);
          const xOut = outer(first.x, b.min.x, b.max.x, first.x <= last.x ? -1 : 1);
          // 最終行の端 → 外へ出る → 走査域の外を回る → 始点へ入る
          pts.push(v3(last.x, alt, zOut));
          pts.push(v3(xOut, alt, zOut));
          pts.push(v3(xOut, alt, zIn));
          pts.push(v3(first.x, alt, zIn));
          pts.push(v3(first.x, alt, first.z));      // 周回を閉じる
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
      case 'route': {
        // 建物のルートは絶対座標で書かれているので、部屋の安全範囲では丸めない
        // (階段室の吹抜を通って上下階へ移動するため、高度制限も掛けない)
        const routes = this.building && this.building.routes;
        const names = routes ? Object.keys(routes) : [];
        if (!names.length) return [v3(c.hover.x, clamp(c.hover.y, s.minY, s.maxY), c.hover.z)];
        const key = c.route && routes[c.route] ? c.route : names[0];
        const raw = routes[key];
        if (!raw || raw.length < 2) return [v3(c.hover.x, clamp(c.hover.y, s.minY, s.maxY), c.hover.z)];
        const wps = raw.map((p) => v3(p.x, p.y, p.z));
        // 平滑化しても制御点の外へは膨らませない (壁を突き抜けないように)
        return resample(c.smooth ? catmullRomLoop(wps, c.loop, 6, true) : wps, c.resolution);
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
  /** 外部時刻 t [s] を、経路上の時刻 tt (0..duration) へ写す */
  pathTime(t) {
    const T = this.duration;
    if (T < 1e-9) return 0;
    if (this.cfg.loop) return ((t % T) + T) % T;
    // 折り返し (往復)。端点では速度プロファイルが 0 なので、
    // 向きが変わっても位置は滑らかにつながる。
    const cycle = T * 2;
    const d = ((t % cycle) + cycle) % cycle;
    return d <= T ? d : cycle - d;
  }

  /** 外部時刻 t における経路上の位置 */
  positionAt(t) {
    return this.stateAtTime(this.pathTime(t)).position;
  }

  sample(t) {
    if (this.points.length === 1 || this.total < 1e-6 || this.duration < 1e-9) {
      const p = this.points[0];
      return {
        position: p, velocity: v3(0, 0, 0), acceleration: v3(0, 0, 0),
        yaw: this.yawFor(t, p, v3(0, 0, 0)), progress: 0,
      };
    }
    const tt = this.pathTime(t);
    const s0 = this.stateAtTime(tt);

    // 速度・加速度は位置の中心差分で求める。
    // 区間ごとの接線をそのまま使うと、折れ線の頂点で向きが不連続に跳び、
    // フィードフォワードとして与えたときに機体が振られる。
    const c = this.cfg;
    const h = Math.max(0.02, Math.min(0.15, this.duration * 0.01));
    const velocity = vmul(vsub(this.positionAt(t + h), this.positionAt(t - h)), 1 / (2 * h));

    // 加速度は二階差分なので、経路を折れ線で持っている以上どうしても
    // 頂点で突起が出る (二階差分の誤差は窓幅の 2 乗に反比例する)。
    // 窓を広めに取り、さらに計画した上限で頭打ちにする。加速度指令は
    // そのまま傾き指令になるので、突起を通すと機体が振られて破綻する。
    const ha = Math.max(0.12, Math.min(0.4, this.duration * 0.02));
    const am = this.positionAt(t - ha), ap = this.positionAt(t + ha);
    let acceleration = v3(
      (ap.x - 2 * s0.position.x + am.x) / (ha * ha),
      (ap.y - 2 * s0.position.y + am.y) / (ha * ha),
      (ap.z - 2 * s0.position.z + am.z) / (ha * ha),
    );
    const aMax = Math.hypot(c.maxLateralAccel ?? 1.5, c.maxTangentialAccel ?? 1.0) * 1.2;
    const aLen = vlen(acceleration);
    if (aLen > aMax) acceleration = vmul(acceleration, aMax / aLen);

    return {
      position: s0.position,
      velocity,
      acceleration,
      // 進行方向を向くモードは、変化率を制限した表を使う (buildYawProfile)
      yaw: s0.yaw != null ? s0.yaw : this.yawFor(t, s0.position, velocity),
      progress: clamp(tt / this.duration, 0, 1),
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

/**
 * Catmull-Rom スプラインで通過点を補間する。
 *
 * @param {boolean} bound 制御点の外側へ膨らませない (建物内の経路で使う)。
 *   Catmull-Rom は折り返しや急な角で制御点の外へオーバーシュートするため、
 *   壁のある建物ではそのまま使うと壁を突き抜ける。true にすると各補間点を
 *   その区間の制御点 4 点が張る直方体に丸め、角は落としつつ外へは出さない。
 */
export function catmullRomLoop(pts, loop = true, samplesPerSeg = 12, bound = false) {
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
    const box = bound ? controlBox(p0, p1, p2, p3) : null;
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const p = catmullRom(p0, p1, p2, p3, t);
      out.push(box ? v3(clamp(p.x, box.x0, box.x1), clamp(p.y, box.y0, box.y1),
        clamp(p.z, box.z0, box.z1)) : p);
    }
  }
  if (!loop) out.push(pts[n - 1]);
  return out;
}

/** 制御点 4 点を含む最小の直方体 */
function controlBox(...ps) {
  return {
    x0: Math.min(...ps.map((p) => p.x)), x1: Math.max(...ps.map((p) => p.x)),
    y0: Math.min(...ps.map((p) => p.y)), y1: Math.max(...ps.map((p) => p.y)),
    z0: Math.min(...ps.map((p) => p.z)), z1: Math.max(...ps.map((p) => p.z)),
  };
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
  // 追従できる速度に落とすための加速度の上限 (buildSpeedProfile を参照)。
  //
  // マルチコプタの横加速度は傾き角で決まる (a = g tanθ) ので、原理的には
  // 4 m/s² (22°) 程度まで出せる。しかし位置制御は姿勢ループを介するため
  // 遅れがあり、上限いっぱいで角を回ると追従が破綻して壁や家具に当たる。
  // 実測 (研究用 250mm・往復スキャンと壁沿い、4 条件):
  //   4.0 m/s² / 90°/s : 3/4 が墜落、平均誤差 2.11m
  //   2.0 m/s² / 50°/s : 1/4 が墜落、平均誤差 0.14m
  //   1.5 m/s² / 40°/s : 0/4          平均誤差 0.10m  ← 既定値
  // 速く飛ばしたい場合は上げられるが、追従誤差が増えるぶん障害物との
  // 余裕 (clearance) も広げること。
  maxLateralAccel: 1.5,
  maxTangentialAccel: 1.0,
  // 機首を振る速さの上限 [deg/s] (buildYawProfile を参照)。
  // 往復スキャンの折り返しでは方位が 180° 反転するので、ここを絞らないと
  // 制御が追いつかず、ロール/ピッチと干渉して機体が転倒する。
  maxYawRate: 40,
  // 障害物を避けて経路を引き直すか (core/pathPlanner.js)
  avoidObstacles: true,
  // 占有格子の刻み [m]。細かいほど扉のような狭い開口を通れるが、
  // 格子の確保量が刻みの 3 乗で増える。
  planResolution: 0.2,
  // 障害物から離す距離 [m]。ボクセルの中心で占有を判定するので、
  // 実際に保証されるクリアランスは clearance - 刻み x √3/2 になる
  // (0.35 - 0.17 ≒ 0.18m)。機体半径 (研究用 250mm で 0.15m 程度) より
  // 大きくなるように選ぶこと。
  clearance: 0.35,
  // 角を丸める最大半径 [m]。大きいほど曲率が緩み、速度を落とさずに回れる。
  cornerRadius: 1.2,
  rows: 5,
  // 往復スキャンの復路が走査域の外側へ出る量 [m] (loop = true のとき)
  returnOffset: 1.2,
  turns: 2,
  radius: 1.5,
  climb: 0.8,
  resolution: 0.3,
  smooth: true,
  loop: true,
  yaw: 0,
  yawRate: 0.35,
  route: 'patrol',
  hover: { x: 0, y: 1.2, z: 0 },
  lookAt: { x: 0, y: 0.9, z: 0 },
  waypoints: [],
  seed: 2024,
};
