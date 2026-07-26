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
    const out = { presets: [], shapes: [], layouts: [], rooms: [] };

    const meshCount = (g) => { let n = 0; g.traverse((o) => { if (o.isMesh) n++; }); return n; };

    for (const key of veh.PRESET_KEYS) {
      a.vehicle = veh.buildVehicle(key);
      a.rebuildVehicle();
      out.presets.push({ key, meshes: meshCount(a.renderer.droneBuilder.group),
        mass: a.sim.massProps.mass, twr: a.sim.perf.twr });
    }
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

  const zeroMesh = [...report.presets, ...report.shapes, ...report.layouts, ...report.rooms]
    .filter((r) => r.meshes === 0);
  check(report.presets.length === 8, '機体プリセット', `${report.presets.length} 種`);
  check(report.shapes.length >= 35, 'パーツ形状', `${report.shapes.length} 通り`);
  check(report.layouts.length === 9, 'ロータ配置', `${report.layouts.length} 種`);
  check(report.rooms.length === 7, '部屋プリセット', `${report.rooms.length} 種`);
  check(zeroMesh.length === 0, 'すべての構成でメッシュが生成される',
    zeroMesh.length ? JSON.stringify(zeroMesh) : '');
  check(report.presets.every((p) => p.twr > 1.4 && p.twr < 12), '全機体の推力重量比が妥当',
    report.presets.map((p) => `${p.key}:${p.twr.toFixed(1)}`).join(' '));
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
