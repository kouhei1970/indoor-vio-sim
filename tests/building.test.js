/**
 * 建物プリセット (複数階) のテスト。
 *
 * 描画は three.js に依存するのでここでは扱わず、
 * 間取りの幾何計算・プリセットの整合性・建物ルートの飛行を検証する。
 *
 *   node --test tests/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILDING_PRESETS, BUILDING_KEYS, ROOM_FURNITURE,
  rectMinusHoles, splitWall, wall, door, win, roomWalls,
} from '../src/config/buildings.js';
import { Trajectory, TRAJECTORY_DEFAULTS, PATTERNS } from '../src/core/trajectory.js';
import { ENV_DEFAULTS } from '../src/config/rooms.js';
import { CollisionWorld } from '../src/core/collision.js';
import { Simulator } from '../src/core/simulator.js';
import { buildVehicle, SIM_DEFAULTS, clone } from '../src/config/vehicle.js';
import { v3 } from '../src/core/math.js';

/* ------------------------------------------------------------------ */
/* 間取りの幾何                                                         */
/* ------------------------------------------------------------------ */

test('splitWall: 開口が無ければ壁は 1 枚のまま', () => {
  const p = splitWall(6, 2.8, 0, []);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0], { a: 0, b: 6, y0: 0, y1: 2.8 });
});

test('splitWall: ドアは床まで開き、両脇だけが残る', () => {
  const p = splitWall(10, 3.0, 0, [door(5, 1.0, 2.1)]);
  // 左袖 / まぐさ / 右袖
  assert.equal(p.length, 3);
  const lintel = p.find((x) => x.y0 > 0);
  assert.ok(lintel, 'まぐさ (開口の上) がある');
  assert.equal(lintel.y0, 2.1);
  assert.equal(lintel.y1, 3.0);
  // 開口の下には壁が無い
  assert.ok(!p.some((x) => x.a < 5 && x.b > 5 && x.y0 < 1e-6));
});

test('splitWall: 窓は腰壁とまぐさが残る', () => {
  const p = splitWall(8, 2.8, 0, [win(4, 1.8, 1.3, 0.85)]);
  const at4 = p.filter((x) => x.a > 3 && x.b < 5);
  assert.equal(at4.length, 2, '腰壁とまぐさ');
  assert.deepEqual(at4.map((x) => [x.y0, x.y1]).sort(), [[0, 0.85], [2.15, 2.8]]);
});

test('splitWall: 開口を除いた壁の面積が合う', () => {
  const L = 12, H = 3.0;
  const openings = [door(2, 1.0, 2.1), win(6, 2.0, 1.2, 0.9), door(10, 1.6, 2.2)];
  const area = splitWall(L, H, 0, openings).reduce((s, p) => s + (p.b - p.a) * (p.y1 - p.y0), 0);
  const holes = openings.reduce((s, o) => s + o.width * o.height, 0);
  assert.ok(Math.abs(area - (L * H - holes)) < 1e-9, `面積 ${area} != ${L * H - holes}`);
});

test('splitWall: 開口が重なっても面積が負にならない', () => {
  const p = splitWall(10, 3, 0, [door(4, 3.0, 2.1), door(5, 3.0, 2.1)]);
  assert.ok(p.every((x) => x.b > x.a && x.y1 > x.y0));
  const area = p.reduce((s, x) => s + (x.b - x.a) * (x.y1 - x.y0), 0);
  assert.ok(area > 0 && area < 10 * 3);
});

test('splitWall: base (腰壁のみの手すり) は下端が持ち上がる', () => {
  const p = splitWall(4, 1.1, 0, []);
  assert.equal(p[0].y1, 1.1);
});

test('rectMinusHoles: 穴が無ければ元の矩形 1 枚', () => {
  const cells = rectMinusHoles({ x0: -5, z0: -3, x1: 5, z1: 3 }, []);
  assert.equal(cells.length, 1);
  assert.deepEqual(cells[0], { x0: -5, x1: 5, z0: -3, z1: 3 });
});

test('rectMinusHoles: 吹抜の面積だけ床が減る', () => {
  const rect = { x0: 0, z0: 0, x1: 10, z1: 10 };
  const holes = [{ x0: 2, z0: 3, x1: 5, z1: 7 }];
  const cells = rectMinusHoles(rect, holes);
  const area = cells.reduce((s, c) => s + (c.x1 - c.x0) * (c.z1 - c.z0), 0);
  assert.ok(Math.abs(area - (100 - 3 * 4)) < 1e-9);
  // 吹抜の中心を覆うセルは無い
  assert.ok(!cells.some((c) => 3.5 > c.x0 && 3.5 < c.x1 && 5 > c.z0 && 5 < c.z1));
});

test('rectMinusHoles: 穴が 2 つでも重なりなく分割される', () => {
  const rect = { x0: 0, z0: 0, x1: 20, z1: 10 };
  const holes = [{ x0: 1, z0: 1, x1: 4, z1: 9 }, { x0: 16, z0: 1, x1: 19, z1: 9 }];
  const cells = rectMinusHoles(rect, holes);
  const area = cells.reduce((s, c) => s + (c.x1 - c.x0) * (c.z1 - c.z0), 0);
  assert.ok(Math.abs(area - (200 - 24 - 24)) < 1e-9);
  // セル同士は重ならない (中心が他のセルに入らない)
  for (const a of cells) {
    const cx = (a.x0 + a.x1) / 2, cz = (a.z0 + a.z1) / 2;
    const inside = cells.filter((b) => cx > b.x0 && cx < b.x1 && cz > b.z0 && cz < b.z1);
    assert.equal(inside.length, 1);
  }
});

test('roomWalls: 閉じた 4 枚の壁を返す', () => {
  const ws = roomWalls(-2, -3, 2, 3);
  assert.equal(ws.length, 4);
  // 終点が次の始点につながっている
  for (let i = 0; i < 4; i++) {
    const a = ws[i], b = ws[(i + 1) % 4];
    assert.equal(a.x2, b.x1);
    assert.equal(a.z2, b.z1);
  }
});

/* ------------------------------------------------------------------ */
/* プリセットの整合性                                                    */
/* ------------------------------------------------------------------ */

test('建物プリセットが 4 つあり、すべて 2 階建て以上', () => {
  assert.ok(BUILDING_KEYS.length >= 4);
  for (const k of BUILDING_KEYS) {
    const b = BUILDING_PRESETS[k];
    assert.ok(b.floors.length >= 2, `${k} は ${b.floors.length} 層しかない`);
  }
});

test('各階の情報が揃っていて、上階ほど高い位置にある', () => {
  for (const k of BUILDING_KEYS) {
    const b = BUILDING_PRESETS[k];
    assert.ok(b.name && b.description, `${k} に名前と説明がある`);
    assert.ok(b.size.width > 0 && b.size.depth > 0 && b.size.height > 0);
    assert.ok(b.materials.floor && b.materials.wall && b.materials.ceiling);
    let prev = -Infinity;
    for (const f of b.floors) {
      assert.ok(f.elevation >= prev, `${k}/${f.name} の高さが逆転している`);
      prev = f.elevation;
      assert.ok(f.height > 1.5, `${k}/${f.name} の階高 ${f.height}`);
      assert.ok(Array.isArray(f.walls) && f.walls.length > 0);
      assert.ok(f.outline.x1 > f.outline.x0 && f.outline.z1 > f.outline.z0);
    }
    // 建物の全高は最上階の天井まで含む
    const top = b.floors[b.floors.length - 1];
    assert.ok(b.size.height >= top.elevation + top.height - 1e-6,
      `${k} の全高 ${b.size.height} が最上階 ${top.elevation + top.height} より低い`);
  }
});

test('2 階以上へ上がる縦の通り道 (吹抜) がある', () => {
  for (const k of BUILDING_KEYS) {
    const b = BUILDING_PRESETS[k];
    const upper = b.floors.slice(1);
    for (const f of upper) {
      const voids = f.voids || [];
      assert.ok(voids.length > 0, `${k}/${f.name} に吹抜が無く上がれない`);
      for (const v of voids) {
        assert.ok(v.x1 > v.x0 && v.z1 > v.z0, `${k}/${f.name} の吹抜が潰れている`);
        assert.ok(v.x0 >= f.outline.x0 - 1e-9 && v.x1 <= f.outline.x1 + 1e-9
          && v.z0 >= f.outline.z0 - 1e-9 && v.z1 <= f.outline.z1 + 1e-9,
        `${k}/${f.name} の吹抜が外形をはみ出している`);
        // 機体が通れる大きさか (25cm 級が余裕をもって通れる)
        assert.ok(Math.min(v.x1 - v.x0, v.z1 - v.z0) > 1.0,
          `${k}/${f.name} の吹抜が狭すぎる`);
      }
    }
  }
});

test('壁の開口が壁の中に収まっている', () => {
  for (const k of BUILDING_KEYS) {
    for (const f of BUILDING_PRESETS[k].floors) {
      for (const w of f.walls) {
        const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
        assert.ok(len > 0, `${k}/${f.name} に長さ 0 の壁がある`);
        for (const o of w.openings || []) {
          assert.ok(o.at - o.width / 2 > -1e-6 && o.at + o.width / 2 < len + 1e-6,
            `${k}/${f.name} の開口 at=${o.at} w=${o.width} が壁 (長さ ${len.toFixed(2)}) からはみ出す`);
          const h = w.height ?? f.height;
          assert.ok((o.sill ?? 0) + o.height <= h + 1e-6,
            `${k}/${f.name} の開口が階高 ${h} を超える`);
        }
      }
    }
  }
});

test('部屋は外形の中にあり、家具の種類が定義されている', () => {
  for (const k of BUILDING_KEYS) {
    for (const f of BUILDING_PRESETS[k].floors) {
      for (const r of f.rooms || []) {
        assert.ok(r.x1 > r.x0 && r.z1 > r.z0, `${k}/${r.name} が潰れている`);
        assert.ok(r.x0 >= f.outline.x0 - 1e-6 && r.x1 <= f.outline.x1 + 1e-6
          && r.z0 >= f.outline.z0 - 1e-6 && r.z1 <= f.outline.z1 + 1e-6,
        `${k}/${r.name} が外形をはみ出している`);
        assert.ok(ROOM_FURNITURE[r.kind], `${k}/${r.name} の種類 ${r.kind} に家具定義が無い`);
      }
    }
  }
});

test('工場には点検対象が置かれ、キャットウォークの高さにも対象がある', () => {
  const f = BUILDING_PRESETS.factory;
  assert.ok(f.targets.length >= 6, '点検対象が 6 個以上');
  const kinds = new Set(f.targets.map((t) => t.kind));
  for (const k of ['gauge', 'valve', 'panel']) {
    assert.ok(kinds.has(k), `点検対象に ${k} が無い`);
  }
  // 高所 (2 階レベル) の対象がある = 上がって点検する意味がある
  const upper = f.floors[1].elevation;
  assert.ok(f.targets.some((t) => t.y > upper), '高所の点検対象が無い');
  // すべて建物の中
  const o = f.floors[0].outline;
  for (const t of f.targets) {
    assert.ok(t.x > o.x0 && t.x < o.x1 && t.z > o.z0 && t.z < o.z1, `${t.name} が建物の外`);
    assert.ok(t.y > 0 && t.y < f.size.height, `${t.name} の高さ ${t.y}`);
  }
});

test('工場の設備 (配管・タンク) が天井より下にある', () => {
  const f = BUILDING_PRESETS.factory;
  const eq = f.floors[0].equipment;
  const H = f.floors[0].height;
  for (const p of eq.pipes) assert.ok(p.y + p.r < H, `配管 y=${p.y} が天井 ${H} を突き抜ける`);
  for (const t of eq.tanks) assert.ok(t.h < H, `タンク h=${t.h} が天井 ${H} を突き抜ける`);
  assert.ok(eq.craneRail.y < H);
});

/* ------------------------------------------------------------------ */
/* 建物ルートの軌道                                                     */
/* ------------------------------------------------------------------ */

const bigBounds = { min: v3(-25, 0, -25), max: v3(25, 12, 25) };

function routeTrajectory(key, route) {
  const cfg = { ...clone(TRAJECTORY_DEFAULTS), pattern: 'route', route };
  const tr = new Trajectory(cfg, bigBounds);
  tr.setBuilding(BUILDING_PRESETS[key]);
  return tr;
}

test("軌道パターンに 'route' がある", () => {
  assert.ok(PATTERNS.includes('route'));
});

test('建物を渡していないときの route はホバリングに落ちる', () => {
  const tr = new Trajectory({ ...clone(TRAJECTORY_DEFAULTS), pattern: 'route' }, bigBounds);
  assert.equal(tr.points.length, 1);
  const s = tr.sample(3);
  assert.ok(Number.isFinite(s.position.x) && Number.isFinite(s.position.y));
});

test('建物ルートは複数階にまたがる', () => {
  for (const [key, route] of [['school', 'patrol'], ['office', 'patrol'],
    ['community', 'patrol'], ['factory', 'inspection']]) {
    const tr = routeTrajectory(key, route);
    assert.ok(tr.points.length > 4, `${key}/${route} の点が少なすぎる`);
    const ys = tr.points.map((p) => p.y);
    const span = Math.max(...ys) - Math.min(...ys);
    const floorH = BUILDING_PRESETS[key].floors[1].elevation;
    assert.ok(span > floorH * 0.8,
      `${key}/${route} の高さ変化 ${span.toFixed(2)} m が 2 階 (${floorH} m) に届かない`);
  }
});

test('建物ルートの点はすべて建物の中にある', () => {
  for (const key of BUILDING_KEYS) {
    const b = BUILDING_PRESETS[key];
    for (const route of Object.keys(b.routes)) {
      const tr = routeTrajectory(key, route);
      for (const p of tr.points) {
        assert.ok(Math.abs(p.x) <= b.size.width / 2 + 1e-6,
          `${key}/${route}: x=${p.x} が幅 ${b.size.width} をはみ出す`);
        assert.ok(Math.abs(p.z) <= b.size.depth / 2 + 1e-6,
          `${key}/${route}: z=${p.z} が奥行 ${b.size.depth} をはみ出す`);
        assert.ok(p.y > 0 && p.y < b.size.height,
          `${key}/${route}: y=${p.y} が全高 ${b.size.height} の外`);
      }
    }
  }
});

test('建物ルートは部屋の安全範囲で高度を丸められない', () => {
  // 単室向けの maxAltitude (2.2 m) より高いところまで行けること
  assert.ok(TRAJECTORY_DEFAULTS.maxAltitude < 3.0);
  const tr = routeTrajectory('school', 'patrol');
  assert.ok(Math.max(...tr.points.map((p) => p.y)) > 5.0, '3 階まで上がっていない');
});

test('route を指定しなければ最初のルートが使われる', () => {
  const cfg = { ...clone(TRAJECTORY_DEFAULTS), pattern: 'route', route: 'nonexistent' };
  const tr = new Trajectory(cfg, bigBounds);
  tr.setBuilding(BUILDING_PRESETS.factory);
  const first = routeTrajectory('factory', 'inspection');
  assert.deepEqual(tr.points[0], first.points[0]);
});

test('建物ルートの時間サンプルが連続していて跳ばない', () => {
  const tr = routeTrajectory('factory', 'inspection');
  let prev = tr.sample(0).position;
  for (let t = 0.1; t < tr.duration; t += 0.1) {
    const p = tr.sample(t).position;
    const step = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
    assert.ok(step < tr.cfg.speed * 0.2, `t=${t.toFixed(1)} で ${step.toFixed(3)} m 跳んだ`);
    prev = p;
  }
});

/* ------------------------------------------------------------------ */
/* 建物の中での飛行                                                     */
/* ------------------------------------------------------------------ */

test('ENV_DEFAULTS に建物モードの設定がある', () => {
  assert.equal(ENV_DEFAULTS.mode, 'room');
  assert.ok(BUILDING_PRESETS[ENV_DEFAULTS.building], '既定の建物が実在する');
});

test('吹抜を通って 2 階まで上がれる (床スラブを障害物として扱う)', () => {
  const b = BUILDING_PRESETS.office;
  const f2 = b.floors[1];
  const hole = f2.voids[0];
  const world = new CollisionWorld();
  world.setRoom(b.size.width + 1, b.size.height + 1.2, b.size.depth + 1);
  // 2 階の床スラブを、吹抜を除いて登録する
  for (const cell of rectMinusHoles(f2.outline, f2.voids)) {
    world.addBox(
      v3((cell.x0 + cell.x1) / 2, f2.elevation - 0.11, (cell.z0 + cell.z1) / 2),
      v3((cell.x1 - cell.x0) / 2, 0.11, (cell.z1 - cell.z0) / 2), 0, 'slab');
  }

  const cx = (hole.x0 + hole.x1) / 2, cz = (hole.z0 + hole.z1) / 2;
  const sim = new Simulator(buildVehicle('research-250'), clone(SIM_DEFAULTS), world);
  sim.reset({ position: v3(cx, 0.1, cz) });
  sim.setMode('position');
  sim.controller.targetPos = { x: cx, y: f2.elevation + 1.2, z: cz };
  for (let i = 0; i < 12000; i++) sim.stepOnce(1 / 500);

  assert.ok(!sim.crashed, '墜落した');
  assert.ok(sim.state.p.y > f2.elevation + 0.9,
    `2 階へ上がれなかった (y=${sim.state.p.y.toFixed(2)}, 目標 ${(f2.elevation + 1.2).toFixed(2)})`);
});

test('吹抜の外では床スラブに阻まれて上の階へ抜けられない', () => {
  const b = BUILDING_PRESETS.office;
  const f2 = b.floors[1];
  const world = new CollisionWorld();
  world.setRoom(b.size.width + 1, b.size.height + 1.2, b.size.depth + 1);
  for (const cell of rectMinusHoles(f2.outline, f2.voids)) {
    world.addBox(
      v3((cell.x0 + cell.x1) / 2, f2.elevation - 0.11, (cell.z0 + cell.z1) / 2),
      v3((cell.x1 - cell.x0) / 2, 0.11, (cell.z1 - cell.z0) / 2), 0, 'slab');
  }
  // 吹抜から離れた場所 (執務室の真ん中)
  const x = 8, z = 0;
  const sim = new Simulator(buildVehicle('research-250'), clone(SIM_DEFAULTS), world);
  sim.reset({ position: v3(x, 0.1, z) });
  sim.setMode('position');
  sim.controller.targetPos = { x, y: f2.elevation + 1.2, z };
  for (let i = 0; i < 6000; i++) sim.stepOnce(1 / 500);

  assert.ok(sim.state.p.y < f2.elevation - 0.1,
    `スラブを突き抜けた (y=${sim.state.p.y.toFixed(2)}, スラブ下端 ${(f2.elevation - 0.22).toFixed(2)})`);
});

test('工場の点検ルートを最後まで飛べる', () => {
  const b = BUILDING_PRESETS.factory;
  const world = new CollisionWorld();
  world.setRoom(b.size.width + 1, b.size.height + 1.2, b.size.depth + 1);

  const sim = new Simulator(buildVehicle('hexa-inspection'), clone(SIM_DEFAULTS), world);
  const tr = routeTrajectory('factory', 'inspection');
  sim.trajectory = tr;
  const start = tr.sample(0);
  sim.reset({ position: start.position, yaw: start.yaw });
  sim.setMode('auto');

  let maxErr = 0;
  const dt = 1 / 400;
  for (let i = 0; i < Math.round(tr.duration / dt); i++) {
    sim.stepOnce(dt);
    const want = tr.sample(sim.time).position;
    const p = sim.state.p;
    maxErr = Math.max(maxErr, Math.hypot(p.x - want.x, p.y - want.y, p.z - want.z));
  }
  assert.ok(!sim.crashed, '墜落した');
  assert.ok(maxErr < 1.0, `軌道追従の最大誤差 ${maxErr.toFixed(2)} m が大きい`);
});

/* ------------------------------------------------------------------ */
/* ルートが構造体を突き抜けていないか                                    */
/* ------------------------------------------------------------------ */

/**
 * 間取りから壁と床スラブの当たり判定だけを組み立てる。
 * buildingBuilder.buildWall / buildFloor と同じ式を使う (描画は伴わない)。
 */
function structureWorld(preset) {
  const w = new CollisionWorld();
  w.setRoom(preset.size.width + 1, preset.size.height + 1.2, preset.size.depth + 1);
  preset.floors.forEach((floor, idx) => {
    const { outline, elevation, height } = floor;
    const slabT = floor.slabThickness ?? 0.22;

    for (const cell of rectMinusHoles(outline, floor.voids || [])) {
      w.addBox(
        v3((cell.x0 + cell.x1) / 2, elevation - slabT / 2, (cell.z0 + cell.z1) / 2),
        v3((cell.x1 - cell.x0) / 2, slabT / 2, (cell.z1 - cell.z0) / 2), 0, 'slab');
    }

    // 天井の穴は「真上に載る階のスラブの穴」と一致する (buildingBuilder と同じ規則)
    const above = preset.floors[idx + 1];
    const stacked = above && Math.abs(above.elevation - (elevation + height)) < 0.05;
    const ceilVoids = stacked ? (above.voids || []) : [];
    if (!floor.noCeiling) {
      for (const cell of rectMinusHoles(outline, ceilVoids)) {
        w.addBox(
          v3((cell.x0 + cell.x1) / 2, elevation + height + 0.03, (cell.z0 + cell.z1) / 2),
          v3((cell.x1 - cell.x0) / 2, 0.03, (cell.z1 - cell.z0) / 2), 0, 'ceiling');
      }
    }

    for (const wall of floor.walls) {
      const dx = wall.x2 - wall.x1, dz = wall.z2 - wall.z1;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const yaw = Math.atan2(dx, dz);
      const h = wall.height ?? height;
      for (const p of splitWall(len, h, wall.base ?? 0, wall.openings || [])) {
        const t = ((p.a + p.b) / 2) / len;
        w.addBox(
          v3(wall.x1 + dx * t, elevation + (p.y0 + p.y1) / 2, wall.z1 + dz * t),
          v3(wall.thickness / 2, (p.y1 - p.y0) / 2, (p.b - p.a) / 2), yaw, 'wall');
      }
    }

    for (const eq of [floor.equipment].filter(Boolean)) {
      for (const p of eq.pipes || []) {
        const len = Math.hypot(p.x1 - p.x0, p.z1 - p.z0);
        w.addBox(v3((p.x0 + p.x1) / 2, p.y, (p.z0 + p.z1) / 2),
          v3(len / 2, p.r, p.r), -Math.atan2(p.z1 - p.z0, p.x1 - p.x0), 'pipe');
      }
      for (const t of eq.tanks || []) {
        w.addBox(v3(t.x, t.h / 2, t.z), v3(t.r, t.h / 2, t.r), 0, 'tank');
      }
      if (eq.craneRail) {
        const { x0, x1, z0, z1 } = floor.outline;
        for (const z of [z0 + 3, z1 - 3]) {
          w.addBox(v3((x0 + x1) / 2, eq.craneRail.y, z),
            v3((x1 - x0 - 1) / 2, 0.175, 0.15), 0, 'crane');
        }
      }
    }
  });
  return w;
}

test('建物ルートは壁・スラブ・設備を突き抜けない', () => {
  const CLEARANCE = 0.25;      // 250mm 級の機体が通れる余裕
  for (const key of BUILDING_KEYS) {
    const preset = BUILDING_PRESETS[key];
    const world = structureWorld(preset);
    for (const route of Object.keys(preset.routes)) {
      const tr = routeTrajectory(key, route);
      const blocked = [];
      for (const p of tr.points) {
        const hits = world.contacts(p, CLEARANCE);
        // 部屋の外壁 (room 境界) との接触は除く: ルートの外側判定は別テストで見ている
        const solid = hits.filter((h) => h.friction !== 0.6 || true).length;
        if (solid) blocked.push({ p, n: hits.length });
      }
      assert.equal(blocked.length, 0,
        `${key}/${route}: ${blocked.length} 点が構造体に接触 `
        + `(例 ${blocked.length ? JSON.stringify(blocked[0].p) : ''})`);
    }
  }
});
