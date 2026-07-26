/**
 * ブラウザ側の動作確認 (スモークテスト)。
 *
 * 実際に Chromium で読み込み、全プリセット・全パーツ形状・全レイアウト・
 * 全部屋を一巡させて、例外やコンソールエラーが出ないことを確認する。
 * さらに 1 枚だけ画像を取り込み、露出が妥当な範囲かを見る。
 *
 *   npm install playwright && npx playwright install chromium
 *   node tools/smoke.mjs
 */

import { startServer } from './serve.mjs';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright が見つかりません:  npm install playwright && npx playwright install chromium');
  process.exit(1);
}

const srv = await startServer({ port: 0 });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`[例外] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' NG   '} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed++;
};

try {
  await page.goto(srv.url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.app != null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  check(true, 'アプリの初期化');

  const report = await page.evaluate(async () => {
    const a = window.app;
    a.headless = true;
    const veh = await import('/src/config/vehicle.js');
    const rooms = await import('/src/config/rooms.js');
    const { LAYOUTS } = await import('/src/core/airframe.js');
    const out = { presets: [], shapes: [], layouts: [], rooms: [], buildings: [] };

    const meshCount = (g) => { let n = 0; g.traverse((o) => { if (o.isMesh) n++; }); return n; };

    for (const key of veh.PRESET_KEYS) {
      a.vehicle = veh.buildVehicle(key);
      a.rebuildVehicle();
      // 着地させて、描画モデルの最下点が床とどれだけずれるかを測る。
      // 当たり判定 (球の集まり) と描画モデルの定義がずれると、機体が床に
      // めり込んだり浮いたりする。ここで見ておかないと静かに壊れる。
      a.resetSim();
      a.sim.setMode('rate');
      a.sim.setCommand({ roll: 0, pitch: 0, yaw: 0, throttle: 0 });
      a.sim.state.p.y = 0.4;
      for (let i = 0; i < 1200; i++) a.sim.advance(1 / 400);
      a.renderer.syncDrone(a.sim.state);
      const box = a.renderer.droneBuilder.measureBounds().clone();
      out.presets.push({ key, meshes: meshCount(a.renderer.droneBuilder.group),
        mass: a.sim.massProps.mass, twr: a.sim.perf.twr,
        // 接地時のモデル最下点 [m] (負 = 床にめり込んでいる)
        landed: a.sim.state.p.y + box.min.y,
        finite: Number.isFinite(a.sim.state.p.y) });
    }
    a.sim.setMode('position');
    a.vehicle = veh.buildVehicle('freestyle-5inch');
    for (const [part, shapes] of Object.entries(veh.PART_SHAPES)) {
      for (const shape of shapes) {
        a.vehicle.parts[part].shape = shape;
        if (a.vehicle.parts[part].enabled === false) a.vehicle.parts[part].enabled = true;
        a.rebuildVehicle();
        out.shapes.push({ key: `${part}:${shape}`, meshes: meshCount(a.renderer.droneBuilder.group) });
      }
    }
    for (const key of Object.keys(LAYOUTS)) {
      a.vehicle = veh.buildVehicle('freestyle-5inch');
      a.vehicle.frame.layout = key;
      a.rebuildVehicle();
      out.layouts.push({ key, rotors: a.sim.rotors.length,
        meshes: meshCount(a.renderer.droneBuilder.group) });
    }
    a.vehicle = veh.buildVehicle('research-250');
    a.rebuildVehicle();
    for (const key of rooms.ROOM_KEYS) {
      a.env.preset = key;
      a.env.size = { ...rooms.ROOM_PRESETS[key].size };
      a.env.lighting = rooms.ROOM_PRESETS[key].lighting;
      a.rebuildRoom();
      out.rooms.push({ key, meshes: meshCount(a.renderer.roomBuilder.group),
        colliders: a.world.boxes.length });
    }

    // --- 建物プリセット (複数階) ---
    const buildings = await import('/src/config/buildings.js');
    for (const key of buildings.BUILDING_KEYS) {
      const preset = buildings.BUILDING_PRESETS[key];
      a.env.mode = 'building';
      a.env.building = key;
      a.env.lighting = preset.lighting;
      a.rebuildRoom();
      // 建物ルートを一通り生成できるか
      const routes = [];
      for (const r of a.sim.trajectory.routeNames()) {
        a.sim.trajectory.cfg.pattern = 'route';
        a.sim.trajectory.cfg.route = r;
        a.applyTrajectory();
        routes.push({ name: r, points: a.sim.trajectory.polyline().length });
      }
      // 初期位置が障害物に埋まっていないか (1 秒ホバリングして墜落しないこと)
      a.sim.setMode('position');
      a.sim.controller.targetPos = { ...a.sim.state.p, y: a.sim.state.p.y + 1.0 };
      // 建物は描画が重いので物理だけ進め、描画の確認は 1 フレームだけにする
      for (let i = 0; i < 300; i++) a.sim.advance(1 / 150);
      a.headlessStep(1 / 60);
      out.buildings.push({
        key,
        floors: preset.floors.length,
        meshes: meshCount(a.renderer.buildingBuilder.group),
        colliders: a.world.boxes.length,
        routes,
        spawn: a.renderer.spawnPoint(),
        y: a.sim.state.p.y,
        crashed: a.sim.crashed,
      });
    }
    a.env.mode = 'room';
    a.sim.trajectory.cfg.pattern = 'lawnmower';

    // 標準的な条件で 1 フレーム描画して露出を確認する
    a.env.preset = 'lab';
    a.env.size = { ...rooms.ROOM_PRESETS.lab.size };
    a.env.lighting = 'fluorescent';
    a.rebuildRoom();
    a.sim.reset({ position: { x: 0, y: 1.3, z: 1.5 } });
    a.sim.controller.targetPos = { x: 0, y: 1.3, z: 1.5 };
    for (let i = 0; i < 60; i++) a.headlessStep(1 / 60);
    const img = a.renderer.sensor.readPixels();
    let sum = 0, clip = 0;
    const n = img.width * img.height;
    for (let i = 0; i < n; i++) {
      const l = 0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2];
      sum += l; if (l > 250) clip++;
    }
    out.image = { mean: sum / n, clipPct: (100 * clip) / n, w: img.width, h: img.height };
    out.flight = { y: a.sim.state.p.y, crashed: a.sim.crashed };
    return out;
  });

  const zeroMesh = [...report.presets, ...report.shapes, ...report.layouts, ...report.rooms,
    ...report.buildings]
    .filter((r) => r.meshes === 0);
  check(report.presets.length === 9, '機体プリセット', `${report.presets.length} 種`);
  check(report.shapes.length >= 35, 'パーツ形状', `${report.shapes.length} 通り`);
  check(report.layouts.length === 9, 'ロータ配置', `${report.layouts.length} 種`);
  check(report.rooms.length === 7, '部屋プリセット', `${report.rooms.length} 種`);
  check(report.buildings.length === 4, '建物プリセット',
    report.buildings.map((b) => `${b.key}(${b.floors}層)`).join(' '));
  // 静的メッシュはマテリアルごとに統合するので、mesh 数は間取りの規模ではなく
  // 使っているマテリアルの数で決まる。ここでは「生成されているか」だけを見る。
  check(report.buildings.every((b) => b.meshes > 20), '建物のメッシュが生成される',
    report.buildings.map((b) => `${b.key}:${b.meshes}`).join(' '));
  check(report.buildings.every((b) => b.colliders > 50), '建物の当たり判定が登録される',
    report.buildings.map((b) => `${b.key}:${b.colliders}`).join(' '));
  check(report.buildings.every((b) => b.routes.length > 0 && b.routes.every((r) => r.points > 4)),
    '建物ルートが生成される',
    report.buildings.map((b) => `${b.key}:${b.routes.map((r) => r.name).join(',')}`).join(' '));
  check(report.buildings.every((b) => !b.crashed && b.y > b.spawn.y + 0.5),
    '建物の初期位置から離陸できる',
    report.buildings.map((b) => `${b.key}:${b.y.toFixed(2)}m`).join(' '));
  check(zeroMesh.length === 0, 'すべての構成でメッシュが生成される',
    zeroMesh.length ? JSON.stringify(zeroMesh) : '');
  check(report.presets.every((p) => p.twr > 1.4 && p.twr < 12), '全機体の推力重量比が妥当',
    report.presets.map((p) => `${p.key}:${p.twr.toFixed(1)}`).join(' '));
  check(report.presets.every((p) => p.finite), '全機体が着地しても発散しない',
    report.presets.filter((p) => !p.finite).map((p) => p.key).join(' ') || '');
  // 許容 8mm: 接触バネの沈み込み m*g/k (X8 3.6kg で約 4mm) を見込んだ値。
  // これを超えるのは当たり判定と描画モデルの定義がずれている合図。
  check(report.presets.every((p) => Math.abs(p.landed) < 0.008),
    '全機体が床にめり込まず接地する',
    report.presets.map((p) => `${p.key}:${(p.landed * 1000).toFixed(1)}mm`).join(' '));
  check(report.image.mean > 60 && report.image.mean < 190, '搭載カメラの露出',
    `平均輝度 ${report.image.mean.toFixed(0)}/255, 白飛び ${report.image.clipPct.toFixed(1)}%`);
  check(report.image.clipPct < 15, '白飛びが過大でない');
  check(Math.abs(report.flight.y - 1.3) < 0.25 && !report.flight.crashed,
    '1 秒間のホバリング', `高度 ${report.flight.y.toFixed(2)} m`);
  check(errors.length === 0, 'ブラウザのエラーが無い',
    errors.length ? errors.slice(0, 5).join(' | ') : '');
} catch (err) {
  console.error('スモークテストが失敗しました:', err.message);
  failed++;
} finally {
  await browser.close();
  srv.server.close();
}

console.log(failed === 0 ? '\nすべて成功しました。' : `\n${failed} 件失敗しました。`);
process.exit(failed === 0 ? 0 : 1);
