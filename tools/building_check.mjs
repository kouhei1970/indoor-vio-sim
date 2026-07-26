/**
 * 建物プリセットの目視確認用スクリーンショットを撮る (開発用)。
 *
 *   node tools/building_check.mjs [出力先ディレクトリ]
 */

import { mkdir } from 'node:fs/promises';
import { startServer } from './serve.mjs';

const { chromium } = await import('playwright');

const OUT = process.argv[2] || './shots';
await mkdir(OUT, { recursive: true });

const srv = await startServer({ port: 0 });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`[例外] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

await page.goto(srv.url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.app != null, { timeout: 180000 });
await page.waitForTimeout(1500);

for (const key of ['school', 'community', 'factory', 'office']) {
  const t0 = Date.now();
  const info = await page.evaluate(async (k) => {
    const a = window.app;
    a.headless = true;
    const B = await import('/src/config/buildings.js');
    a.env.mode = 'building';
    a.env.building = k;
    a.env.lighting = B.BUILDING_PRESETS[k].lighting;
    a.rebuildRoom();
    a.sim.trajectory.cfg.pattern = 'route';
    a.sim.trajectory.cfg.route = a.sim.trajectory.routeNames()[0];
    a.applyTrajectory();
    const spawn = a.renderer.spawnPoint();
    a.sim.setMode('position');
    a.sim.controller.targetPos = { x: a.sim.state.p.x, y: spawn.y + 1.2, z: a.sim.state.p.z };
    // 物理だけ進める (ソフトウェア描画は 1 フレームが重いので、描画は最後に 1 回)
    for (let i = 0; i < 300; i++) a.sim.advance(1 / 150);
    const hoverY = a.sim.state.p.y;

    const meanLuma = () => {
      const img = a.renderer.sensor.readPixels();
      let sum = 0;
      const n = img.width * img.height;
      for (let i = 0; i < n; i++) {
        sum += 0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2];
      }
      return sum / n;
    };

    // ルート上の何点かで機体カメラの明るさを測る (階ごとの照明が効いているか)
    const luma = [];
    const pts = a.sim.trajectory.polyline();
    for (const f of [0.15, 0.5, 0.85]) {
      const p = pts[Math.floor(pts.length * f)];
      a.sim.reset({ position: p });
      a.sim.setMode('position');
      a.sim.controller.targetPos = { ...p };
      for (let i = 0; i < 60; i++) a.sim.advance(1 / 150);
      a.headlessStep(1 / 60);
      luma.push(Math.round(meanLuma()));
    }

    // 内部の様子 (追従視点)
    a.renderer.viewMode = 'chase';
    a.headlessStep(1 / 60);

    let meshes = 0;
    a.renderer.buildingBuilder.group.traverse((o) => { if (o.isMesh) meshes++; });
    return {
      meshes, colliders: a.world.boxes.length,
      routes: a.sim.trajectory.routeNames(),
      routePoints: pts.length,
      spawn, y: hoverY, crashed: a.sim.crashed, luma,
    };
  }, key);
  await page.screenshot({ path: `${OUT}/${key}-interior.png` });

  // 天井を消した俯瞰 (間取りの確認)
  await page.evaluate(() => {
    const a = window.app;
    a.renderer.buildingBuilder.group.traverse((o) => {
      if (o.name && o.name.startsWith('ceiling-')) o.visible = false;
    });
    const s = a.renderer.activeBuilder.size;
    const d = Math.max(s.width, s.depth);
    a.renderer.viewMode = 'orbit';
    a.renderer.camera.position.set(0.01, d * 0.85, 0.01);
    a.renderer.controls.target.set(0, 0, 0);
    a.renderer.controls.update();
    a.headlessStep(1 / 60);
  });
  await page.screenshot({ path: `${OUT}/${key}-plan.png` });
  console.log(key, JSON.stringify(info), `${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// 工場の点検ルートを実際に飛ばす
const fly = await page.evaluate(async () => {
  const a = window.app;
  a.env.mode = 'building';
  a.env.building = 'factory';
  a.rebuildRoom();
  Object.assign(a.sim.trajectory.cfg, { pattern: 'route', route: 'inspection', speed: 1.0 });
  a.applyTrajectory();
  const start = a.sim.trajectory.sample(0);
  a.sim.reset({ position: start.position, yaw: start.yaw });
  a.setFlightMode('auto');
  a.renderer.viewMode = 'chase';
  let maxErr = 0, hits = 0;
  const dur = a.sim.trajectory.duration;
  for (let i = 0; i < Math.round(dur * 150); i++) {
    a.sim.advance(1 / 150);
    const want = a.sim.trajectory.sample(a.sim.time).position;
    const p = a.sim.state.p;
    maxErr = Math.max(maxErr, Math.hypot(p.x - want.x, p.y - want.y, p.z - want.z));
    if (a.world.contacts(p, 0.15).length) hits++;
  }
  a.headlessStep(1 / 60);
  return { dur, maxErr, hits, crashed: a.sim.crashed, y: a.sim.state.p.y };
});
console.log('工場 点検ルート飛行:', JSON.stringify(fly));
await page.screenshot({ path: `${OUT}/factory-flight.png` });

await page.evaluate(() => {
  window.app.renderer.viewMode = 'onboard';
  window.app.headlessStep(1 / 60);
});
await page.screenshot({ path: `${OUT}/factory-onboard.png` });

console.log('errors:', errors.length ? errors.slice(0, 6) : 'なし');
await browser.close();
srv.server.close();
