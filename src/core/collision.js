/**
 * 衝突判定と幾何クエリ。
 *
 * 室内環境を「部屋 (内側から見た直方体)」+「障害物 (ヨー回転付き直方体 OBB)」で表現し、
 *   - 接触力 (バネ・ダンパ + クーロン摩擦) による着陸/衝突
 *   - ToF / 測距センサ用のレイキャスト
 *   - 地面効果・壁効果のための距離クエリ
 * を提供する。物理コアなので three.js には依存しない。
 */

import { v3, vadd, vsub, vmul, vdot, vlen, vcross, qrot, qrotInv, clamp } from './math.js';

export class CollisionWorld {
  constructor() {
    this.room = { min: v3(-3, 0, -3), max: v3(3, 2.7, 3) };
    this.boxes = [];       // {center, half, yaw, name, restitution, friction}
    this.enabled = true;
  }

  setRoom(width, height, depth, center = v3(0, 0, 0)) {
    this.room = {
      min: v3(center.x - width / 2, center.y, center.z - depth / 2),
      max: v3(center.x + width / 2, center.y + height, center.z + depth / 2),
    };
  }

  clearObstacles() { this.boxes = []; }

  /**
   * 直方体の障害物を追加する。
   *
   * yaw は描画側 (three.js の `mesh.rotation.y`) と同じ向き:
   * Y 軸まわりの回転で、箱のローカル +Z が世界の (sin yaw, 0, cos yaw) を向く。
   * 呼び出し側はメッシュに与えたのと同じ yaw をそのまま渡せる。
   *
   * 内部の変換式は「ローカル +Z が (-sin, 0, cos)」の形なので、
   * ここで sin の符号を反転して保持する (以降 cos/sin を使う箇所は
   * すべてこの反転済みの値で一貫している)。
   */
  addBox(center, half, yaw = 0, name = 'obstacle', props = {}) {
    this.boxes.push({
      center, half, yaw, name,
      friction: props.friction ?? 0.6,
      restitution: props.restitution ?? 0.05,
      cos: Math.cos(yaw), sin: -Math.sin(yaw),
    });
    return this.boxes[this.boxes.length - 1];
  }

  /** ワールド座標 → 箱ローカル座標 */
  toLocal(box, p) {
    const d = vsub(p, box.center);
    return v3(d.x * box.cos + d.z * box.sin, d.y, -d.x * box.sin + d.z * box.cos);
  }

  /** 箱ローカル座標 → ワールド座標 (方向ベクトル用) */
  toWorldDir(box, d) {
    return v3(d.x * box.cos - d.z * box.sin, d.y, d.x * box.sin + d.z * box.cos);
  }

  /**
   * 半径 r の球と環境との接触を列挙する。
   * @returns {Array<{normal, depth, point}>} normal は球を押し出す向き
   */
  contacts(p, r) {
    const out = [];
    if (!this.enabled) return out;
    const { min, max } = this.room;

    // --- 部屋の内壁 (内側から接触) ---
    const walls = [
      { n: v3(1, 0, 0), d: p.x - min.x },
      { n: v3(-1, 0, 0), d: max.x - p.x },
      { n: v3(0, 1, 0), d: p.y - min.y },
      { n: v3(0, -1, 0), d: max.y - p.y },
      { n: v3(0, 0, 1), d: p.z - min.z },
      { n: v3(0, 0, -1), d: max.z - p.z },
    ];
    for (const w of walls) {
      if (w.d < r) {
        out.push({
          normal: w.n,
          depth: r - w.d,
          point: vadd(p, vmul(w.n, -w.d)),
          friction: 0.6, restitution: 0.05,
        });
      }
    }

    // --- 障害物 (OBB) ---
    for (const b of this.boxes) {
      const l = this.toLocal(b, p);
      const cx = clamp(l.x, -b.half.x, b.half.x);
      const cy = clamp(l.y, -b.half.y, b.half.y);
      const cz = clamp(l.z, -b.half.z, b.half.z);
      const dx = l.x - cx, dy = l.y - cy, dz = l.z - cz;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 > r * r) continue;
      let nLocal, depth;
      if (dist2 > 1e-12) {
        const dist = Math.sqrt(dist2);
        nLocal = v3(dx / dist, dy / dist, dz / dist);
        depth = r - dist;
      } else {
        // 中心が箱の内部: 最も近い面へ押し出す
        const ex = b.half.x - Math.abs(l.x);
        const ey = b.half.y - Math.abs(l.y);
        const ez = b.half.z - Math.abs(l.z);
        if (ex < ey && ex < ez) { nLocal = v3(Math.sign(l.x) || 1, 0, 0); depth = r + ex; }
        else if (ey < ez) { nLocal = v3(0, Math.sign(l.y) || 1, 0); depth = r + ey; }
        else { nLocal = v3(0, 0, Math.sign(l.z) || 1); depth = r + ez; }
      }
      out.push({
        normal: this.toWorldDir(b, nLocal),
        depth,
        point: vadd(p, vmul(this.toWorldDir(b, nLocal), -(r - depth))),
        friction: b.friction, restitution: b.restitution,
      });
    }
    return out;
  }

  /**
   * レイキャスト。最も近い交点までの距離を返す (無ければ maxDist)。
   * @returns {{distance:number, normal:{x,y,z}, hit:boolean}}
   */
  raycast(origin, dir, maxDist = 50) {
    let best = { distance: maxDist, normal: v3(0, 1, 0), hit: false };
    const { min, max } = this.room;

    // 部屋 (内側から): 各平面との交差
    const planes = [
      { axis: 'x', val: min.x, n: v3(1, 0, 0) }, { axis: 'x', val: max.x, n: v3(-1, 0, 0) },
      { axis: 'y', val: min.y, n: v3(0, 1, 0) }, { axis: 'y', val: max.y, n: v3(0, -1, 0) },
      { axis: 'z', val: min.z, n: v3(0, 0, 1) }, { axis: 'z', val: max.z, n: v3(0, 0, -1) },
    ];
    for (const pl of planes) {
      const o = origin[pl.axis], d = dir[pl.axis];
      if (Math.abs(d) < 1e-9) continue;
      const t = (pl.val - o) / d;
      if (t <= 1e-6 || t >= best.distance) continue;
      const hit = vadd(origin, vmul(dir, t));
      const eps = 1e-4;
      if (hit.x < min.x - eps || hit.x > max.x + eps) continue;
      if (hit.y < min.y - eps || hit.y > max.y + eps) continue;
      if (hit.z < min.z - eps || hit.z > max.z + eps) continue;
      best = { distance: t, normal: pl.n, hit: true };
    }

    // 障害物 (OBB: ローカル空間の slab test)
    for (const b of this.boxes) {
      const o = this.toLocal(b, origin);
      const d = v3(
        dir.x * b.cos + dir.z * b.sin,
        dir.y,
        -dir.x * b.sin + dir.z * b.cos,
      );
      let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 1;
      const comp = [['x', b.half.x], ['y', b.half.y], ['z', b.half.z]];
      let ok = true;
      for (let i = 0; i < 3; i++) {
        const [k, h] = comp[i];
        if (Math.abs(d[k]) < 1e-9) {
          if (o[k] < -h || o[k] > h) { ok = false; break; }
          continue;
        }
        let t1 = (-h - o[k]) / d[k];
        let t2 = (h - o[k]) / d[k];
        let s = -1;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { ok = false; break; }
      }
      if (!ok || tmin <= 1e-6 || tmin >= best.distance) continue;
      const nLocal = v3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
      best = { distance: tmin, normal: this.toWorldDir(b, nLocal), hit: true };
    }
    return best;
  }

  /** 床 (または障害物の上面) までの高さ */
  heightAboveGround(p) {
    return this.raycast(p, v3(0, -1, 0), 60).distance;
  }

  /** 天井までの距離 */
  distanceToCeiling(p) {
    return this.raycast(p, v3(0, 1, 0), 60).distance;
  }

  /** 近接する壁 (水平 4 方向 + 障害物) の法線と距離 */
  nearbyWalls(p, maxDist = 1.0) {
    const dirs = [v3(1, 0, 0), v3(-1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)];
    const out = [];
    for (const d of dirs) {
      const r = this.raycast(p, d, maxDist);
      if (r.hit && r.distance < maxDist) {
        out.push({ normal: vmul(d, -1), distance: r.distance }); // 壁 → 機体向き
      }
    }
    return out;
  }
}

/**
 * 機体の衝突形状。ロータ位置・脚位置に球を配置し、
 * 接触時にトルクも発生するようにする (壁にぶつかると傾く)。
 */
export function buildCollisionShape(config, massProps) {
  const spheres = [];
  const p = config.parts;
  spheres.push({ offset: v3(p.body.offset.x, p.body.offset.y, p.body.offset.z),
    radius: Math.max(p.body.size.x, p.body.size.z) * 0.5 });
  const propR = (p.prop.diameter / 2) * (p.guard.enabled ? (p.guard.radiusScale ?? 1.15) : 1);
  for (const r of massProps.rotors) {
    if (r.coaxLevel > 0) continue;
    spheres.push({ offset: v3(r.position.x, r.position.y, r.position.z), radius: propR * 0.55 });
    // プロペラ外周にも小球を置いて円盤に近い形にする
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      spheres.push({
        offset: v3(r.position.x + Math.cos(a) * propR * 0.55, r.position.y,
          r.position.z + Math.sin(a) * propR * 0.55),
        radius: propR * 0.45,
      });
    }
  }
  if (p.landingGear.enabled) {
    const nLeg = Math.max(2, p.landingGear.count ?? 4);
    for (let i = 0; i < nLeg; i++) {
      const psi = (i / nLeg) * Math.PI * 2 + Math.PI / nLeg;
      spheres.push({
        offset: v3(-p.landingGear.spread * Math.sin(psi),
          p.body.offset.y - p.landingGear.height,
          -p.landingGear.spread * Math.cos(psi)),
        radius: 0.012,
      });
    }
  }
  // 重心基準に変換
  for (const s of spheres) s.offset = vsub(s.offset, massProps.com);
  return spheres;
}

/**
 * 当たり判定の最下点を、描画モデルの最下点に合わせる。
 *
 * 衝突形状は球の集まりなので、実際に描かれる形 (薄い円盤のプロペラ、
 * 細い脚) とは必ずずれる。とくに脚は
 *
 *   描画の脚先 = 胴体の下面 - 脚長 - 足の丸み
 *   判定の脚先 = 胴体の中心 - 脚長 - 12mm (固定)
 *
 * と定義が違っていたため、胴体の高さの半分ぶんだけ判定が浅く、
 * 機体が床にめり込んで見えた (X8 で 59mm、ヘキサで 30mm)。
 * 逆に脚の無い機体では、胴体の外接球が下へ張り出して浮いて見えた。
 *
 * ここで「いちばん下の球の底 = 描画モデルの最下点」に揃えることで、
 * 見えている接地面と物理の接地面を一致させる。横方向の当たりは
 * 球の水平方向の広がりで決まるので、この上下の調整では変わらない。
 *
 * @param {Array} shape buildCollisionShape() の戻り値 (重心基準)
 * @param {number} modelBottomY 描画モデルの最下点 (重心基準) [m]
 */
export function fitShapeToModel(shape, modelBottomY) {
  if (!shape || !shape.length || !Number.isFinite(modelBottomY)) return shape;
  let low = Infinity;
  for (const s of shape) low = Math.min(low, s.offset.y - s.radius);
  const d = modelBottomY - low;
  if (Math.abs(d) < 1e-4) return shape;
  if (d > 0) {
    // 球がモデルより下へ出ている (浮いて見える) → はみ出した球を引っ込める
    for (const s of shape) {
      if (s.offset.y - s.radius < modelBottomY) s.offset.y = modelBottomY + s.radius;
    }
  } else {
    // モデルが球より下にある (めり込んで見える) → 最下の球を接地面まで下げる
    for (const s of shape) {
      if (s.offset.y - s.radius < low + 1e-4) s.offset.y += d;
    }
  }
  return shape;
}

/**
 * 接触力の計算 (バネ・ダンパ + 摩擦)。
 * @returns {{force, torque, contactCount, maxDepth}} 機体重心まわりのワールド座標の力・トルク
 */
export function contactForces(world, state, shape, params, mass = 0, dt = 0) {
  let force = v3(0, 0, 0);
  let torque = v3(0, 0, 0);
  let contactCount = 0;
  let maxDepth = 0;

  // --- 接触点をいったん集める ---
  // 減衰係数の上限を決めるのに接触点の数が要るため、2 段階にしている。
  const hits = [];
  for (const s of shape) {
    const rW = qrot(state.q, s.offset);          // 重心からのオフセット (ワールド)
    const pW = vadd(state.p, rW);
    for (const c of world.contacts(pW, s.radius)) hits.push({ rW, c });
  }

  // --- 減衰係数の安定化 ---
  //
  // 接触は陽解法 (前進オイラー) で積分するので、減衰力が大きすぎると
  // 1 ステップで速度が行き過ぎて符号が反転し、跳ね返るたびに増幅して発散する。
  // 1 自由度で見ると、安定条件は
  //
  //     c_total · dt / m < 2
  //
  // で、接触点が N 個あると実効的な減衰は N 倍になる。安全率 2 を見て
  // c_total · dt / m ≦ 1 に収まるよう、1 点あたりの減衰を頭打ちにする。
  //
  // これが無いと、軽い機体 (ナノ機 37g) が着地した瞬間に 8m/s で跳ね返り、
  // 数ステップで NaN になっていた。重い機体では上限に掛からないので、
  // 着地の感触は変わらない。
  let cn = params.damping;
  if (mass > 0 && dt > 0 && hits.length > 0) {
    cn = Math.min(cn, mass / (dt * hits.length));
  }

  for (const { rW, c } of hits) {
    contactCount++;
    maxDepth = Math.max(maxDepth, c.depth);
    // 接触点速度
    const vPoint = vadd(state.v, vcross(qrot(state.q, state.omega), rW));
    const vn = vdot(vPoint, c.normal);
    const kn = params.stiffness;
    let fn = kn * c.depth - cn * Math.min(vn, 0);
    fn = Math.max(fn, 0);
    const fNormal = vmul(c.normal, fn);
    // 摩擦 (接線方向)
    const vT = vsub(vPoint, vmul(c.normal, vn));
    const vTlen = vlen(vT);
    const mu = c.friction ?? 0.6;
    const fT = vTlen > 1e-6
      ? vmul(vT, -Math.min(mu * fn, params.tangentDamping * vTlen) / vTlen)
      : v3(0, 0, 0);
    const f = vadd(fNormal, fT);
    force = vadd(force, f);
    torque = vadd(torque, vcross(rW, f));
  }
  // トルクは機体座標へ
  return {
    force,
    torque: qrotInv(state.q, torque),
    contactCount,
    maxDepth,
  };
}
