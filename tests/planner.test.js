/**
 * 経路計画 (src/core/pathPlanner.js) の検査。
 *
 * 「障害物を避ける」だけでなく、途中の区間まで含めて通れることを確かめる。
 * 経路計画は幾何だけで完結するので、描画なしで Node から直接試験できる。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { OccupancyGrid, astar, stringPull, roundCorners, planThrough } from '../src/core/pathPlanner.js';

/** 軸に平行な箱 (当たり判定と同じ形式) */
const box = (x, y, z, hx, hy, hz) => ({
  center: { x, y, z }, half: { x: hx, y: hy, z: hz }, cos: 1, sin: 0, name: 'obstacle',
});

const ROOM = { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 3, z: 5 } };

/** 経路が「実際の箱 + 機体半径」に触れていないか (区間の途中も見る) */
function collides(boxes, pts, radius = 0.15, step = 0.02) {
  const hit = (p) => boxes.some((b) => Math.abs(p.x - b.center.x) < b.half.x + radius
    && Math.abs(p.y - b.center.y) < b.half.y + radius
    && Math.abs(p.z - b.center.z) < b.half.z + radius);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (hit({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })) {
        return true;
      }
    }
  }
  return false;
}

test('占有格子: 箱の中は塞がり、外は空いている', () => {
  const boxes = [box(0, 1.5, 0, 0.5, 1.5, 0.5)];
  const g = new OccupancyGrid(ROOM, boxes, { res: 0.2, clearance: 0.3 });
  assert.equal(g.free({ x: 0, y: 1.5, z: 0 }), false);
  assert.equal(g.free({ x: 3, y: 1.5, z: 3 }), true);
  // 膨張しているので、箱のすぐ外も塞がっている
  assert.equal(g.free({ x: 0.6, y: 1.5, z: 0 }), false);
  // 部屋の外は塞がり扱い
  assert.equal(g.free({ x: 10, y: 1.5, z: 0 }), false);
});

test('見通し判定: 箱を貫く線は通らず、脇を抜ける線は通る', () => {
  const boxes = [box(0, 1.5, 0, 0.5, 1.5, 0.5)];
  const g = new OccupancyGrid(ROOM, boxes, { res: 0.2, clearance: 0.3 });
  assert.equal(g.lineOfSight({ x: -3, y: 1.5, z: 0 }, { x: 3, y: 1.5, z: 0 }), false);
  assert.equal(g.lineOfSight({ x: -3, y: 1.5, z: 3 }, { x: 3, y: 1.5, z: 3 }), true);
});

test('見通し判定: 部分区間は元の区間と矛盾しない', () => {
  // 等間隔の標本化だと、刻み方によって判定が変わることがある。
  // ボクセル走査 (DDA) なら、通れる区間の部分区間は必ず通れる。
  const boxes = [box(0, 1.5, 0, 0.5, 1.5, 0.5), box(1.4, 1.5, 1.4, 0.3, 1.5, 0.3)];
  const g = new OccupancyGrid(ROOM, boxes, { res: 0.2, clearance: 0.3 });
  const a = { x: -4, y: 1.35, z: 2.6 }, b = { x: 4, y: 1.35, z: 2.6 };
  assert.equal(g.lineOfSight(a, b), true);
  for (let t = 0; t < 1; t += 0.02) {
    const p = { x: a.x + (b.x - a.x) * t, y: a.y, z: a.z };
    const q = { x: a.x + (b.x - a.x) * (t + 0.02), y: a.y, z: a.z };
    assert.equal(g.lineOfSight(p, q), true, `部分区間 t=${t.toFixed(2)} が通らない`);
  }
});

test('A*: 壁を回り込む経路を見つける', () => {
  // z = 0 に壁。x が 1.0〜2.0 のところだけ開口 (扉)
  const boxes = [];
  for (let x = -5; x < 5; x += 0.5) {
    if (x > 0.9 && x < 2.1) continue;
    boxes.push(box(x + 0.25, 1.5, 0, 0.25, 1.5, 0.1));
  }
  const g = new OccupancyGrid(ROOM, boxes, { res: 0.15, clearance: 0.22 });
  const path = astar(g, { x: -3, y: 1.2, z: -3 }, { x: -3, y: 1.2, z: 3 });
  assert.ok(path, '経路が見つからない');
  // 扉の位置 (x ≒ 1.5) を通っているはず
  assert.ok(path.some((p) => p.x > 0.9 && p.x < 2.1 && Math.abs(p.z) < 0.5),
    '扉を通っていない');
  assert.equal(collides(boxes, path, 0.05), false, '経路が壁に触れている');
});

test('A*: 通れないときは null を返す', () => {
  // 開口の無い壁で部屋を二分する
  const boxes = [box(0, 1.5, 0, 5, 1.5, 0.2)];
  const g = new OccupancyGrid(ROOM, boxes, { res: 0.2, clearance: 0.25 });
  assert.equal(astar(g, { x: 0, y: 1.5, z: -3 }, { x: 0, y: 1.5, z: 3 }), null);
});

test('String pulling: 見通しが通る区間だけを残す', () => {
  const g = new OccupancyGrid(ROOM, [], { res: 0.2, clearance: 0.2 });
  const zig = [];
  for (let i = 0; i <= 10; i++) zig.push({ x: -3 + i * 0.6, y: 1.5, z: i % 2 ? 0.1 : -0.1 });
  const pulled = stringPull(g, zig);
  // 障害物が無いので、始点と終点だけになるはず
  assert.equal(pulled.length, 2);
  assert.deepEqual(pulled[0], zig[0]);
});

test('角の丸め: 出力の全区間が通れる', () => {
  const boxes = [box(0, 1.5, 0, 0.6, 1.5, 0.6)];
  const g = new OccupancyGrid(ROOM, boxes, { res: 0.2, clearance: 0.3 });
  const path = [{ x: -3, y: 1.5, z: -2 }, { x: -3, y: 1.5, z: 2 }, { x: 3, y: 1.5, z: 2 }];
  const out = roundCorners(g, path, 0.8);
  assert.ok(out.length > path.length, '丸められていない');
  for (let i = 0; i + 1 < out.length; i++) {
    assert.equal(g.lineOfSight(out[i], out[i + 1]), true, `区間 ${i} が通らない`);
  }
});

test('角の丸め: 短い区間が続く所でも半径が潰れない', () => {
  // A* の迂回では 0.1〜0.3m 間隔の頂点が並ぶ。隣の頂点までで丸め半径を
  // 制限すると 1〜6cm の角になり、そこを曲がるのに要る向心加速度 v²/r が
  // 上限を超えて、速度プロファイルが 0.2 m/s 以下まで落ちてしまう。
  const g = new OccupancyGrid(ROOM, [], { res: 0.2, clearance: 0.2 });
  // 0.25m 刻みでゆるく曲がる折れ線 (迂回路を模したもの)
  const path = [];
  for (let i = 0; i <= 12; i++) {
    const t = i * 0.25;
    path.push({ x: -2 + t, y: 1.5, z: (i % 2 ? 0.06 : -0.06) + t * 0.2 });
  }
  const out = roundCorners(g, path, 1.2);
  // 出力の曲率半径 = 隣り合う 3 点を通る円の半径
  let minR = Infinity;
  for (let i = 1; i + 1 < out.length; i++) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const ab = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.y - b.y, c.z - b.z);
    const ac = Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z);
    if (ab < 1e-6 || bc < 1e-6 || ac < 1e-6) continue;
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
    const area2 = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    if (area2 < 1e-12) continue;                      // まっすぐな所
    minR = Math.min(minR, (ab * bc * ac) / area2);
  }
  // 横加速度 1.5 m/s²・速度 0.6 m/s で回れる半径は 0.24m。それを下回らないこと
  assert.ok(minR > 0.24, `丸め半径が潰れている (最小 ${minR.toFixed(3)} m)`);
  for (let i = 0; i + 1 < out.length; i++) {
    assert.equal(g.lineOfSight(out[i], out[i + 1]), true, `区間 ${i} が通らない`);
  }
});

test('角の丸め: 元の経路から離れすぎない', () => {
  // 離れても衝突はしない (見通しは確認する) が、離れすぎると往復スキャンの
  // 行が短くなるなど、走査パターンそのものが変わってしまう。
  const g = new OccupancyGrid(ROOM, [], { res: 0.2, clearance: 0.2 });
  const path = [{ x: -3, y: 1.5, z: -3 }, { x: -3, y: 1.5, z: 3 }, { x: 3, y: 1.5, z: 3 }];
  const out = roundCorners(g, path, 1.2, 8, 0.35);
  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const l2 = dx * dx + dy * dy + dz * dz;
    const t = Math.max(0, Math.min(1, l2 > 1e-18
      ? ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2 : 0));
    return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t, p.z - a.z - dz * t);
  };
  for (const q of out) {
    let best = Infinity;
    for (let i = 0; i + 1 < path.length; i++) best = Math.min(best, segDist(q, path[i], path[i + 1]));
    assert.ok(best <= 0.35 + 1e-9, `元の経路から ${best.toFixed(3)} m 離れている`);
  }
});

test('planThrough: 障害物を避け、全区間が通れる', () => {
  const boxes = [
    box(0, 1.0, 0, 0.6, 1.0, 0.6),
    box(-2, 1.0, 1.5, 0.5, 1.0, 0.5),
    box(2.2, 0.6, -1.2, 0.4, 0.6, 0.4),
  ];
  const g = new OccupancyGrid(ROOM, boxes, { res: 0.15, clearance: 0.3 });
  // 障害物を突き抜ける往復スキャン
  const wps = [];
  for (let i = 0; i < 5; i++) {
    const z = -3 + i * 1.5;
    wps.push({ x: i % 2 ? 3.5 : -3.5, y: 1.2, z });
    wps.push({ x: i % 2 ? -3.5 : 3.5, y: 1.2, z });
  }
  assert.equal(collides(boxes, wps), true, '元のパターンは障害物を通るはず');
  const r = planThrough(g, wps, { corner: 0.6 });
  assert.equal(collides(boxes, r.points), false, '計画後も障害物に触れている');
  assert.equal(r.failed, 0);
  assert.ok(r.replanned > 0, '迂回が発生していない');
});

test('planThrough: 障害物の中に落ちたウェイポイントは近くの空きへ寄せる', () => {
  const boxes = [box(0, 1.0, 0, 0.8, 1.0, 0.8)];
  const g = new OccupancyGrid(ROOM, boxes, { res: 0.15, clearance: 0.25 });
  const wps = [{ x: -3, y: 1.0, z: 0 }, { x: 0, y: 1.0, z: 0 }, { x: 3, y: 1.0, z: 0 }];
  const r = planThrough(g, wps, { corner: 0.5 });
  assert.equal(collides(boxes, r.points), false);
  assert.ok(r.points.length >= 3);
});

test('planThrough: 障害物が無ければ元の形をほぼ保つ', () => {
  const g = new OccupancyGrid(ROOM, [], { res: 0.2, clearance: 0.2 });
  const wps = [{ x: -3, y: 1.5, z: -3 }, { x: 3, y: 1.5, z: -3 }, { x: 3, y: 1.5, z: 3 }];
  const r = planThrough(g, wps, { corner: 0.5 });
  assert.equal(r.replanned, 0);
  const len = (ps) => ps.reduce((L, p, i) => (i ? L + Math.hypot(p.x - ps[i - 1].x,
    p.y - ps[i - 1].y, p.z - ps[i - 1].z) : 0), 0);
  // 角を丸めたぶんだけ僅かに短くなる程度
  assert.ok(Math.abs(len(r.points) / len(wps) - 1) < 0.05);
});
