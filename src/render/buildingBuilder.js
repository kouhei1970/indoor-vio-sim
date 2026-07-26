/**
 * 間取り (壁の線分 + 開口) から複数階建ての建物を組み立てる。
 *
 * 描画用のメッシュと物理用の当たり判定を同じ記述から生成するので、
 * 「見えている壁は必ずぶつかる」状態を保てる。
 *
 * 生成するもの
 *   - 床スラブ (階段室・吹抜の穴あき)
 *   - 壁 (ドア・窓の開口で分割)
 *   - 階段の段板
 *   - 各室の家具
 *   - 天井照明 (階ごと)
 *   - 点検対象 (圧力計・バルブ・電気盤など) と工場設備 (配管・タンク)
 */

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { getTexture } from './textures.js';
import { makeFurniture } from './furniture.js';
import { mergeByMaterial } from './geometryMerge.js';
import { BUILDING_PRESETS, ROOM_FURNITURE, rectMinusHoles, splitWall } from '../config/buildings.js';
import { LIGHTING_PRESETS } from '../config/rooms.js';
import { makeRng, v3 } from '../core/math.js';

// 間取りの幾何計算は three.js に依存しないので config 側に置いてある (Node からテストできる)
export { rectMinusHoles, splitWall };

RectAreaLightUniformsLib.init();

const PI = Math.PI;
const LIGHT_CALIBRATION = 0.18;   // roomBuilder と同じ較正係数

function pbr(params) {
  return new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.0, ...params });
}

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
  if (t.normalMap) m.normalScale = new THREE.Vector2(0.8, 0.8);
  return m;
}

/** 外形から穴を除いた平面形状 (スラブ・天井の押し出し用) */
function makeShape(outline, holes) {
  const shape = new THREE.Shape();
  shape.moveTo(outline.x0, outline.z0);
  shape.lineTo(outline.x1, outline.z0);
  shape.lineTo(outline.x1, outline.z1);
  shape.lineTo(outline.x0, outline.z1);
  shape.closePath();
  for (const v of holes) {
    const h = new THREE.Path();
    h.moveTo(v.x0, v.z0);
    h.lineTo(v.x1, v.z0);
    h.lineTo(v.x1, v.z1);
    h.lineTo(v.x0, v.z1);
    h.closePath();
    shape.holes.push(h);
  }
  return shape;
}

/** 点 (x,z) から線分 a-b までの距離 (XZ 平面) */
function distToSegXZ(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

export class BuildingBuilder {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'building';
    this.lightGroup = new THREE.Group();
    scene.add(this.group);
    scene.add(this.lightGroup);
    this.lights = [];
    this.floorInfo = [];
    this.targets = [];
    // 統合対象の開始位置 (group.children のインデックス)
    this.staticFrom = 0;
    // 階ごとの表示グループ
    this.floorGroups = [];
    // ジオメトリを統合するセルの大きさ [m] (0 で階ごとに 1 つ)
    this.cellSize = 8;
    // 離れた階を非表示にするか
    this.floorCull = true;
  }

  /**
   * 直前に markStatic() を呼んでから追加した静的メッシュを、
   * マテリアルごとに 1 つへ統合する。ドローコールが大きく減り、
   * 影のパス (光源ごとにシーンを再描画) も同じ比率で軽くなる。
   */
  markStatic() { this.staticFrom = this.group.children.length; }

  /**
   * @param {string} name 生成するメッシュの名前
   * @param {number|null} floorIndex 階に属するものはその階のグループへ入れる
   *   (階ごとに表示を切れるようにするため)
   */
  flushStatic(name, floorIndex = null) {
    const parent = floorIndex != null ? this.floorGroup(floorIndex) : this.group;
    const added = this.group.children.slice(this.staticFrom);
    this.staticFrom = this.group.children.length;
    if (!added.length) return;
    this.group.updateMatrixWorld(true);

    if (this.mergeStatic === false) {
      if (parent !== this.group) {
        for (const o of added) { this.group.remove(o); parent.add(o); }
        this.staticFrom = this.group.children.length;
      }
      return;
    }

    const meshes = [];
    for (const o of added) o.traverse((c) => { if (c.isMesh) meshes.push(c); });
    if (!meshes.length) return;
    for (const o of added) this.group.remove(o);
    // セルに区切ってまとめる。まとめすぎると視錐台カリングが効かなくなり、
    // 細かすぎるとドローコールが減らない。屋内なので 8m 角にしている。
    for (const m of mergeByMaterial(meshes, name, this.cellSize)) parent.add(m);
    this.staticFrom = this.group.children.length;
  }

  /** 階ごとの表示グループ (表示を切れるようにする) */
  floorGroup(i) {
    if (!this.floorGroups[i]) {
      const g = new THREE.Group();
      g.name = `floor-${i}`;
      this.floorGroups[i] = g;
      this.group.add(g);
      this.staticFrom = this.group.children.length;
    }
    return this.floorGroups[i];
  }

  /**
   * 高さ y から見えない階を非表示にする。
   *
   * 階と階はスラブで仕切られているので、2 つ以上離れた階は
   * 吹抜越しでもほぼ見えない。視錐台カリングは遮蔽を考えないため、
   * ここで明示的に落とさないと全階を描くことになる。
   */
  setVisibleFloorsByHeight(y) {
    if (!this.floorCull || !this.preset) return;
    const floors = this.preset.floors;
    let cur = 0;
    for (let i = 0; i < floors.length; i++) if (floors[i].elevation <= y + 0.5) cur = i;
    for (let i = 0; i < floors.length; i++) {
      const g = this.floorGroups[i];
      if (g) g.visible = Math.abs(i - cur) <= 1;
    }
  }

  /** すべての階を表示する (俯瞰や外観を見るとき) */
  showAllFloors() {
    for (const g of this.floorGroups) if (g) g.visible = true;
  }

  clear() {
    const dispose = (obj) => obj.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        // 使い回しているマテリアル (家具など) は捨てない
        for (const m of mats) if (!m.userData.shared) m.dispose();
      }
    });
    dispose(this.group); this.group.clear();
    dispose(this.lightGroup); this.lightGroup.clear();
    this.lights.length = 0;
    this.floorInfo.length = 0;
    this.targets.length = 0;
    this.staticFrom = 0;
    this.floorGroups.length = 0;
    this.world.clearObstacles();
  }

  /**
   * 建物を構築する。
   * @param {object} env 環境設定 (ENV_DEFAULTS 形式)
   */
  build(env) {
    this.clear();
    const preset = BUILDING_PRESETS[env.building] || BUILDING_PRESETS.school;
    this.preset = preset;
    this.env = env;
    const rng = makeRng(env.seed ?? 7);
    const detail = env.featureDensity ?? 1;

    const size = preset.size;
    // 物理の「部屋」は建物全体の外形。壁は障害物として登録する。
    this.size = { width: size.width + 1, height: size.height + 1.2, depth: size.depth + 1 };
    this.world.setRoom(this.size.width, this.size.height, this.size.depth);

    const mats = {
      floor: texturedMaterial(preset.materials.floor, { x: size.width / 2, y: size.depth / 2 }, detail),
      corridorFloor: texturedMaterial(preset.materials.corridorFloor || preset.materials.floor,
        { x: size.width / 2, y: size.depth / 2 }, detail),
      wall: texturedMaterial(preset.materials.wall, { x: 4, y: 2 }, detail),
      ceiling: texturedMaterial(preset.materials.ceiling, { x: size.width / 3, y: size.depth / 3 }, detail),
      exterior: texturedMaterial(preset.materials.exterior || preset.materials.wall, { x: 6, y: 3 }, detail),
    };
    this.materials = mats;

    // ルート沿いには家具を置かない (与えたルートが必ず飛べるようにする)
    this.routeSegments = [];
    for (const key of Object.keys(preset.routes || {})) {
      const pts = preset.routes[key] || [];
      for (let i = 1; i < pts.length; i++) this.routeSegments.push([pts[i - 1], pts[i]]);
    }

    preset.floors.forEach((floor, i) => {
      this.buildFloor(floor, mats, rng, env, detail, i);
    });
    this.markStatic();
    this.buildEquipment(preset, rng);
    this.buildTargets(preset);
    this.flushStatic('equipment');

    this.markStatic();
    this.buildLighting(preset, env);
    this.flushStatic('fixtures');
    return this.group;
  }

  /* ------------------------------------------------------------ */

  buildFloor(floor, mats, rng, env, detail, floorIndex = null) {
    const { outline, elevation, height } = floor;
    const slabT = floor.slabThickness ?? 0.22;
    const voids = floor.voids || [];

    // --- 床スラブ (吹抜の穴あき) ---
    const slabGeo = new THREE.ExtrudeGeometry(makeShape(outline, voids),
      { depth: slabT, bevelEnabled: false });
    slabGeo.rotateX(-PI / 2);           // XZ 平面へ
    const slab = new THREE.Mesh(slabGeo, mats.floor);
    slab.position.y = elevation;
    slab.receiveShadow = true;
    slab.castShadow = true;
    slab.name = `slab-${floor.name}`;
    if (floorIndex != null) this.floorGroup(floorIndex).add(slab);
    else this.group.add(slab);

    // 当たり判定は矩形に分割して登録
    for (const cell of rectMinusHoles(outline, voids)) {
      this.addBox((cell.x0 + cell.x1) / 2, elevation - slabT / 2, (cell.z0 + cell.z1) / 2,
        (cell.x1 - cell.x0) / 2, slabT / 2, (cell.z1 - cell.z0) / 2, 0, 'slab');
    }

    // --- 天井 (最上階は屋根、noCeiling の階は省く) ---
    //
    // 天井の穴はこの階の吹抜ではなく「真上に載る階のスラブの穴」と一致させる。
    // 自分の voids を使うと、階段室の吹抜が上階のスラブにしか開かず、
    // その下の天井で塞がって上階へ上がれなくなる。
    const idx = this.preset.floors.indexOf(floor);
    const above = this.preset.floors[idx + 1];
    const isTop = !above;
    // 真上に載っている階か (工場のように途中の高さに床がある場合は載っていない)
    const stacked = above && Math.abs(above.elevation - (elevation + height)) < 0.05;
    const ceilVoids = stacked ? (above.voids || []) : [];
    if (!floor.noCeiling) {
      const ceilShape = makeShape(outline, ceilVoids);
      const ceilGeo = new THREE.ExtrudeGeometry(ceilShape, { depth: 0.06, bevelEnabled: false });
      ceilGeo.rotateX(-PI / 2);
      const ceil = new THREE.Mesh(ceilGeo, isTop ? mats.exterior : mats.ceiling);
      ceil.name = `ceiling-${floor.name}`;
      ceil.position.y = elevation + height;
      ceil.receiveShadow = true;
      if (floorIndex != null) this.floorGroup(floorIndex).add(ceil);
      else this.group.add(ceil);
      for (const cell of rectMinusHoles(outline, ceilVoids)) {
        this.addBox((cell.x0 + cell.x1) / 2, elevation + height + 0.03, (cell.z0 + cell.z1) / 2,
          (cell.x1 - cell.x0) / 2, 0.03, (cell.z1 - cell.z0) / 2, 0, 'ceiling');
      }
    }

    // ここから先 (壁・階段・家具・掲示物) は動かないので、階ごとに統合する。
    // スラブと天井は 1 枚ずつなので対象外 (天井は名前で隠せるようにも残す)。
    this.markStatic();

    // --- 壁 (ここから先は階ごとにまとめる) ---
    for (const w of floor.walls) {
      this.buildWall(w, elevation, height, mats);
    }

    // --- 階段 ---
    for (const s of floor.stairs || []) {
      this.buildStairs(s, elevation, mats);
    }

    // --- 家具 ---
    for (const r of floor.rooms || []) {
      this.fillRoom(r, elevation, rng, env);
    }

    // --- 壁面の掲示物・マーカー (特徴点を増やす) ---
    this.decorateFloor(floor, rng, env, detail);

    this.flushStatic(`floor-${floor.name}`, floorIndex);

    this.floorInfo.push({
      name: floor.name, elevation, height,
      outline, voids,
      center: { x: (outline.x0 + outline.x1) / 2, z: (outline.z0 + outline.z1) / 2 },
    });
  }

  /** 壁 1 枚 (開口で分割して配置) */
  buildWall(w, elevation, floorHeight, mats) {
    const dx = w.x2 - w.x1, dz = w.z2 - w.z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const yaw = Math.atan2(dx, dz);            // +Z を基準にした回転
    const h = w.height ?? floorHeight;
    const mat = w.material === 'exterior' ? mats.exterior : mats.wall;
    const pieces = splitWall(len, h, w.base ?? 0, w.openings || []);

    for (const p of pieces) {
      const segLen = p.b - p.a;
      const segH = p.y1 - p.y0;
      const t = (p.a + p.b) / 2 / len;
      const cx = w.x1 + dx * t;
      const cz = w.z1 + dz * t;
      const cy = elevation + (p.y0 + p.y1) / 2;
      const geo = new THREE.BoxGeometry(w.thickness, segH, segLen);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, cy, cz);
      mesh.rotation.y = yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.addBox(cx, cy, cz, w.thickness / 2, segH / 2, segLen / 2, yaw, 'wall');
    }

    // 窓ガラス (発光させて外光の雰囲気を出す)
    for (const o of w.openings || []) {
      if (o.kind !== 'window') continue;
      const t = o.at / len;
      const cx = w.x1 + dx * t, cz = w.z1 + dz * t;
      const glass = new THREE.Mesh(
        new THREE.PlaneGeometry(o.width, o.height),
        new THREE.MeshStandardMaterial({
          color: 0xdfeeff, emissive: 0xcfe4ff, emissiveIntensity: 1.1,
          roughness: 0.08, side: THREE.DoubleSide,
        }));
      glass.position.set(cx, elevation + (o.sill ?? 0) + o.height / 2, cz);
      glass.rotation.y = yaw + PI / 2;
      this.group.add(glass);
    }
  }

  /** 階段の段板 */
  buildStairs(s, elevation, mats) {
    const steps = Math.max(4, Math.round(s.rise / 0.18));
    const tread = 0.27;
    const mat = pbr({ color: 0xb9b6ae, roughness: 0.7 });
    void mats;
    for (let i = 0; i < steps; i++) {
      const y = elevation + (i + 1) * (s.rise / steps);
      const z = s.z + s.dir * (i * tread - (steps * tread) / 2);
      const step = new THREE.Mesh(new THREE.BoxGeometry(s.width, 0.05, tread), mat);
      step.position.set(s.x, y, z);
      step.castShadow = true; step.receiveShadow = true;
      this.group.add(step);
      this.addBox(s.x, y - 0.025, z, s.width / 2, 0.025, tread / 2, 0, 'stair');
    }
  }

  /**
   * この場所に家具を置いてよいか (飛行ルートを塞がないか)。
   * ルートは絶対座標なので、その階を通っている区間だけを見る。
   */
  routeClear(x, z, elevation, margin = 0.9, floorHeight = 2.6) {
    for (const [a, b] of this.routeSegments || []) {
      // この階を通っていない区間は無視する
      const yLo = Math.min(a.y, b.y), yHi = Math.max(a.y, b.y);
      if (yHi < elevation || yLo > elevation + floorHeight) continue;
      if (distToSegXZ(x, z, a, b) < margin) return false;
    }
    return true;
  }

  /** 部屋に家具を置く */
  fillRoom(r, elevation, rng, env) {
    const kinds = ROOM_FURNITURE[r.kind] || ROOM_FURNITURE.generic;
    const area = Math.abs((r.x1 - r.x0) * (r.z1 - r.z0));
    const density = (env.furnitureDensity ?? 1) * (r.density ?? 1);
    const count = Math.round(area * 0.09 * density);
    const placed = [];
    for (let i = 0; i < count; i++) {
      const kind = rng.pick(kinds);
      let pos = null;
      for (let a = 0; a < 20; a++) {
        const x = rng.range(r.x0 + 0.6, r.x1 - 0.6);
        const z = rng.range(r.z0 + 0.6, r.z1 - 0.6);
        if (!this.routeClear(x, z, elevation)) continue;
        if (placed.every((p) => Math.hypot(p.x - x, p.z - z) > 1.0)) { pos = { x, z }; break; }
      }
      if (!pos) continue;
      placed.push(pos);
      const obj = makeFurniture(kind, rng);
      if (!obj) continue;
      const yaw = rng.pick([0, PI / 2, PI, -PI / 2]) + rng.range(-0.12, 0.12);
      obj.group.position.set(pos.x, elevation, pos.z);
      obj.group.rotation.y = yaw;
      obj.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(obj.group);
      for (const c of obj.colliders) {
        const cx = pos.x + c.center.x * Math.cos(yaw) + c.center.z * Math.sin(yaw);
        const cz = pos.z - c.center.x * Math.sin(yaw) + c.center.z * Math.cos(yaw);
        this.world.addBox(v3(cx, elevation + c.center.y, cz), c.half, yaw, kind,
          { friction: 0.6, restitution: 0.08 });
      }
    }
  }

  /** 掲示物・フィデューシャルマーカー (階ごと) */
  decorateFloor(floor, rng, env, detail) {
    void detail;
    const { outline, elevation, height } = floor;
    const nPoster = Math.round((env.posterCount ?? 6) / 2);
    const nMarker = Math.round((env.markerCount ?? 4) / 2);
    const pickWall = () => {
      const side = rng.int(0, 3);
      const y = elevation + rng.range(0.9, Math.min(height - 0.5, 2.2));
      const tx = rng.range(outline.x0 + 1, outline.x1 - 1);
      const tz = rng.range(outline.z0 + 1, outline.z1 - 1);
      switch (side) {
        case 0: return { pos: [tx, y, outline.z0 + 0.12], rot: [0, 0, 0] };
        case 1: return { pos: [tx, y, outline.z1 - 0.12], rot: [0, PI, 0] };
        case 2: return { pos: [outline.x0 + 0.12, y, tz], rot: [0, PI / 2, 0] };
        default: return { pos: [outline.x1 - 0.12, y, tz], rot: [0, -PI / 2, 0] };
      }
    };
    for (let i = 0; i < nPoster; i++) {
      const t = getTexture('poster', { seed: i + 1 + (env.seed ?? 0) + Math.round(elevation * 10) });
      const w = rng.range(0.4, 0.8), h = w * rng.range(1.0, 1.4);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), pbr({ map: t.map, roughness: 0.55 }));
      const p = pickWall();
      m.position.set(...p.pos); m.rotation.set(...p.rot);
      this.group.add(m);
    }
    for (let i = 0; i < nMarker; i++) {
      const id = i + 1 + Math.round(elevation);
      const t = getTexture('marker', { seed: id, bits: 6 });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), pbr({ map: t.map, roughness: 0.65 }));
      const p = pickWall();
      m.position.set(...p.pos); m.rotation.set(...p.rot);
      m.userData.markerId = id;
      this.group.add(m);
    }
  }

  /** 工場設備 (配管・タンク・クレーンレール) */
  buildEquipment(preset, rng) {
    for (const floor of preset.floors) {
      const eq = floor.equipment;
      if (!eq) continue;
      const steel = pbr({ color: 0x8f979f, roughness: 0.4, metalness: 0.75 });
      const insulated = pbr({ color: 0xd9d2c4, roughness: 0.8 });

      for (const p of eq.pipes || []) {
        const len = Math.hypot(p.x1 - p.x0, p.z1 - p.z0);
        const geo = new THREE.CylinderGeometry(p.r, p.r, len, 16);
        const mesh = new THREE.Mesh(geo, rng() > 0.5 ? steel : insulated);
        mesh.position.set((p.x0 + p.x1) / 2, p.y, (p.z0 + p.z1) / 2);
        // 円柱の軸 (ローカル +Y) を Z 回り 90° で X 軸へ倒し、Y 回りで水平方向へ向ける。
        // Y 回転は上から見て時計回りが正になるので、方位角の符号を反転する。
        mesh.rotation.z = PI / 2;
        mesh.rotation.y = -Math.atan2(p.z1 - p.z0, p.x1 - p.x0);
        mesh.castShadow = true; mesh.receiveShadow = true;
        this.group.add(mesh);
        this.addBox((p.x0 + p.x1) / 2, p.y, (p.z0 + p.z1) / 2,
          len / 2, p.r, p.r, -Math.atan2(p.z1 - p.z0, p.x1 - p.x0), 'pipe');
        // 支持金物
        const n = Math.max(2, Math.round(len / 5));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const hx = p.x0 + (p.x1 - p.x0) * t, hz = p.z0 + (p.z1 - p.z0) * t;
          const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.04), steel);
          hanger.position.set(hx, p.y + 0.35, hz);
          this.group.add(hanger);
        }
      }

      for (const t of eq.tanks || []) {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(t.r, t.r, t.h, 24), steel);
        body.position.set(t.x, t.h / 2, t.z);
        body.castShadow = true; body.receiveShadow = true;
        this.group.add(body);
        const top = new THREE.Mesh(new THREE.SphereGeometry(t.r, 20, 10, 0, PI * 2, 0, PI / 2), steel);
        top.position.set(t.x, t.h, t.z);
        this.group.add(top);
        this.world.addBox(v3(t.x, t.h / 2, t.z), v3(t.r, t.h / 2, t.r), 0, 'tank');
      }

      if (eq.craneRail) {
        const rail = pbr({ color: 0xf0a02a, roughness: 0.5, metalness: 0.6 });
        const { x0, x1, z0, z1 } = floor.outline;
        for (const z of [z0 + 3, z1 - 3]) {
          const beam = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 1, 0.35, 0.3), rail);
          beam.position.set((x0 + x1) / 2, eq.craneRail.y, z);
          beam.castShadow = true;
          this.group.add(beam);
          this.addBox((x0 + x1) / 2, eq.craneRail.y, z, (x1 - x0 - 1) / 2, 0.175, 0.15, 0, 'crane');
        }
        // 走行体
        const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, z1 - z0 - 5), rail);
        bridge.position.set((x0 + x1) / 2 + 4, eq.craneRail.y + 0.3, (z0 + z1) / 2);
        this.group.add(bridge);
      }
    }
  }

  /** 点検対象 (圧力計・バルブ・電気盤など) */
  buildTargets(preset) {
    if (!preset.targets) return;
    const steel = pbr({ color: 0x9aa1a8, roughness: 0.35, metalness: 0.8 });
    const red = pbr({ color: 0xd0392b, roughness: 0.45 });
    const dark = pbr({ color: 0x2a2e33, roughness: 0.5 });

    for (const t of preset.targets) {
      const g = new THREE.Group();
      g.position.set(t.x, t.y, t.z);
      g.rotation.y = t.yaw || 0;
      switch (t.kind) {
        case 'gauge': {
          // 圧力計: 文字盤を貼った円盤 (読み取り実験の対象になる)
          const face = getTexture('checker', { size: 128, cols: 6 });
          const body = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 20), steel);
          body.rotation.x = PI / 2;
          g.add(body);
          const dial = new THREE.Mesh(new THREE.CircleGeometry(0.062, 24),
            pbr({ map: face.map, roughness: 0.3 }));
          dial.position.z = 0.026;
          g.add(dial);
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 10), steel);
          stem.position.y = -0.09;
          g.add(stem);
          break;
        }
        case 'valve': {
          const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), steel);
          g.add(body);
          const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.016, 8, 20), red);
          wheel.position.y = 0.13;
          wheel.rotation.x = PI / 2;
          g.add(wheel);
          const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.14, 10), steel);
          stem.position.y = 0.07;
          g.add(stem);
          break;
        }
        case 'panel': {
          const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.2), pbr({ color: 0x9fb0bd, roughness: 0.4, metalness: 0.4 }));
          g.add(box);
          const label = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.18),
            pbr({ map: getTexture('marker', { seed: 200 + Math.round(t.x) }).map, roughness: 0.5 }));
          label.position.set(0, 0.28, 0.101);
          g.add(label);
          for (let i = 0; i < 3; i++) {
            const led = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6),
              new THREE.MeshStandardMaterial({
                color: 0x111111, emissive: [0x22ff66, 0xffcc22, 0xff3333][i], emissiveIntensity: 2,
              }));
            led.position.set(-0.15 + i * 0.15, -0.05, 0.105);
            g.add(led);
          }
          break;
        }
        case 'joint':
        default: {
          const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.12, 16), steel);
          body.rotation.z = PI / 2;
          g.add(body);
          for (let i = 0; i < 6; i++) {
            const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.14, 6), dark);
            const a = (i / 6) * PI * 2;
            bolt.position.set(0, Math.cos(a) * 0.12, Math.sin(a) * 0.12);
            bolt.rotation.z = PI / 2;
            g.add(bolt);
          }
        }
      }
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(g);
      this.targets.push({ name: t.name, kind: t.kind, position: { x: t.x, y: t.y, z: t.z } });
    }
  }

  /* ------------------------------------------------------------ */

  /**
   * 照明を作る。
   *
   * 天井を格子で埋めるやり方だと、廊下や階段室のように細長い場所が
   * 照明の間に落ちて真っ暗になる (実際に事務所ビルの中廊下がそうなった)。
   * そこで間取りの「部屋」「吹抜」「階段」を灯具の位置として使い、
   * 各空間に必ず 1 灯以上が入るようにしている。
   *
   * 光源は PointLight。RectAreaLight は見た目が良い代わりにシェーダが重く、
   * 3 階建ての建物で室ごとに置くと描画が実用的な速度でなくなる。
   */
  buildLighting(preset, env) {
    const cfg = LIGHTING_PRESETS[env.lighting || preset.lighting] || LIGHTING_PRESETS.fluorescent;
    const scale = (env.lightIntensity ?? 1) * LIGHT_CALIBRATION;

    // 相互反射の近似。室数が多いぶん直接光だけでは隅が沈むので、単室より強めにする。
    const hemi = new THREE.HemisphereLight(
      new THREE.Color(cfg.ambientColor), new THREE.Color(0x6b6a66), cfg.ambient * scale * 6);
    this.lightGroup.add(hemi);

    const fixtureMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: new THREE.Color(cfg.ceilingLights.color),
      emissiveIntensity: 2.2, roughness: 0.4,
    });

    // --- 灯具を置く区画を集める ---
    // 区画 = 部屋 + 吹抜 (階段室・アトリウム) + 階段まわり。
    // 部屋の指定が無い階 (工場のキャットウォークなど) は外形を格子で割る。
    const allZones = [];
    for (const floor of preset.floors) {
      const { outline, elevation, height } = floor;
      const zones = [];
      for (const r of floor.rooms || []) zones.push({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 });
      for (const v of floor.voids || []) zones.push({ x0: v.x0, z0: v.z0, x1: v.x1, z1: v.z1 });
      for (const st of floor.stairs || []) {
        zones.push({ x0: st.x - 1.5, z0: st.z - 1.5, x1: st.x + 1.5, z1: st.z + 1.5 });
      }
      if (!zones.length) {
        const g = preset.lightsPerFloor || { rows: 2, cols: 4 };
        const W = outline.x1 - outline.x0, D = outline.z1 - outline.z0;
        for (let r = 0; r < g.rows; r++) {
          for (let c = 0; c < g.cols; c++) {
            const cx = outline.x0 + W * ((c + 0.5) / g.cols);
            const cz = outline.z0 + D * ((r + 0.5) / g.rows);
            zones.push({ x0: cx - 1, z0: cz - 1, x1: cx + 1, z1: cz + 1 });
          }
        }
      }
      for (const zone of zones) {
        const w = zone.x1 - zone.x0, d = zone.z1 - zone.z0;
        // 細長い廊下は面積で数えると足りなくなるので、長手方向の長さでも見る
        const want = Math.max(Math.round(Math.max(w, d) / 7), Math.round((w * d) / 80), 1);
        allZones.push({ ...zone, y: elevation + height - 0.08, w, d, want: Math.min(4, want) });
      }
    }

    // 灯数の上限。多いほど均一に照らせるが、描画コストが線形に増える。
    const MAX_LAMPS = 28;
    const wanted = allZones.reduce((n, z) => n + z.want, 0);
    const ratio = wanted > MAX_LAMPS ? MAX_LAMPS / wanted : 1;

    let shadowLights = 0;
    for (const zone of allZones) {
      {
        const { w, d, y } = zone;
        const n = Math.max(1, Math.round(zone.want * ratio));
        const along = w >= d;
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          const x = along ? zone.x0 + w * t : (zone.x0 + zone.x1) / 2;
          const z = along ? (zone.z0 + zone.z1) / 2 : zone.z0 + d * t;

          const fw = 1.2, fd = 0.35;
          const panel = new THREE.Mesh(new THREE.BoxGeometry(fw, 0.05, fd), fixtureMat);
          panel.position.set(x, y, z);
          this.group.add(panel);

          // 到達距離は担当する範囲に合わせる (遠くまで無駄に照らさない)
          const reach = Math.max(4.0, Math.hypot(along ? w / n : w, along ? d : d / n) * 1.1);
          const power = cfg.ceilingLights.power * scale * 1.1;
          const lamp = new THREE.PointLight(new THREE.Color(cfg.ceilingLights.color),
            power, reach, 1.5);
          lamp.position.set(x, y - 0.06, z);
          this.lightGroup.add(lamp);
          this.lights.push({ light: lamp, base: power, flicker: cfg.flicker });
        }
      }
    }

    // 影付きの光源は負荷が高いので、階に 1 灯だけ (建物全体で 4 灯まで)
    for (const floor of preset.floors) {
      if (env.shadows === false || shadowLights >= 4) break;
      const { outline, elevation, height } = floor;
      const cx = (outline.x0 + outline.x1) / 2, cz = (outline.z0 + outline.z1) / 2;
      const spot = new THREE.SpotLight(new THREE.Color(cfg.ceilingLights.color),
        cfg.ceilingLights.power * scale * 1.6, height * 3, PI / 2.4, 0.6, 1.6);
      spot.position.set(cx, elevation + height - 0.08, cz);
      spot.target.position.set(cx, elevation, cz);
      spot.castShadow = true;
      spot.shadow.mapSize.width = env.shadowQuality ?? 2048;
      spot.shadow.mapSize.height = env.shadowQuality ?? 2048;
      spot.shadow.camera.near = 0.2;
      spot.shadow.camera.far = height * 2.5;
      spot.shadow.bias = -0.0012;
      spot.shadow.normalBias = 0.02;
      this.lightGroup.add(spot);
      this.lightGroup.add(spot.target);
      this.lights.push({ light: spot, base: cfg.ceilingLights.power * scale * 1.6, flicker: cfg.flicker });
      shadowLights++;
    }

    if (cfg.sun.enabled) {
      const el = cfg.sun.elevation * PI / 180;
      const az = cfg.sun.azimuth * PI / 180;
      const dir = new THREE.DirectionalLight(new THREE.Color(cfg.sun.color), cfg.sun.power * scale);
      const dist = Math.max(this.size.width, this.size.depth);
      dir.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
      dir.castShadow = env.shadows !== false;
      const s = dist * 0.7;
      dir.shadow.camera.left = -s; dir.shadow.camera.right = s;
      dir.shadow.camera.top = s; dir.shadow.camera.bottom = -s;
      dir.shadow.camera.near = 0.5; dir.shadow.camera.far = dist * 3;
      dir.shadow.mapSize.width = env.shadowQuality ?? 2048;
      dir.shadow.mapSize.height = env.shadowQuality ?? 2048;
      dir.shadow.bias = -0.0008; dir.shadow.normalBias = 0.03;
      this.lightGroup.add(dir);
      this.lights.push({ light: dir, base: cfg.sun.power * scale, flicker: 0 });
    }
  }

  update(time) {
    for (const l of this.lights) {
      if (!l.flicker) continue;
      const n = Math.sin(time * 37.7 + l.light.id) * Math.sin(time * 13.1);
      l.light.intensity = l.base * (1 + n * l.flicker * 3);
    }
  }

  /** 描画と当たり判定の両方に箱を追加する */
  addBox(x, y, z, hx, hy, hz, yaw, name) {
    this.world.addBox(v3(x, y, z), v3(hx, hy, hz), yaw, name, { friction: 0.5, restitution: 0.05 });
  }

  /**
   * 機体の初期位置 (1 階の空いている場所)。
   *
   * 家具はシードによって場所が変わるので、候補点が塞がっていたら
   * 周囲を螺旋状に探して空いている所へずらす。
   */
  spawnPoint() {
    const f = this.floorInfo[0];
    const y = (f ? f.elevation : 0) + 0.15;
    const p = this.preset || {};

    // 候補: プリセット指定 → 各ルートの始点 → 1 階の中心
    const cands = [];
    if (p.spawn) cands.push({ x: p.spawn.x, z: p.spawn.z });
    for (const key of Object.keys(p.routes || {})) {
      const r = p.routes[key];
      if (r && r.length) cands.push({ x: r[0].x, z: r[0].z });
    }
    if (f) cands.push({ x: f.center.x, z: f.center.z });

    // その場所に機体を置けるか (床スラブは無視、機体まわり 35cm を空ける)
    const clear = (x, z) => !this.world.boxes.some((b) => {
      if (b.name === 'slab') return false;
      if (b.center.y - b.half.y > y + 0.3 || b.center.y + b.half.y < y - 0.15) return false;
      const dx = x - b.center.x, dz = z - b.center.z;
      const lx = dx * b.cos + dz * b.sin, lz = -dx * b.sin + dz * b.cos;
      return Math.abs(lx) < b.half.x + 0.35 && Math.abs(lz) < b.half.z + 0.35;
    });

    for (const c of cands) {
      if (clear(c.x, c.z)) return v3(c.x, y, c.z);
      for (let r = 0.6; r <= 3.0; r += 0.6) {
        for (let a = 0; a < 12; a++) {
          const th = (a / 12) * PI * 2;
          const x = c.x + r * Math.cos(th), z = c.z + r * Math.sin(th);
          if (clear(x, z)) return v3(x, y, z);
        }
      }
    }
    return v3(f ? f.center.x : 0, y, f ? f.center.z : 0);
  }
}
