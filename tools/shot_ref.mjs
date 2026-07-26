/**
 * 決まった視点で環境を 1 枚描いて PNG に保存する (描画の回帰確認用)。
 *
 *   node tools/shot_ref.mjs <出力先>
 *
 * 変更の前後で実行して画像を比較すれば、最適化で見た目が変わっていないかを
 * 客観的に確認できる。
 */

import { mkdir } from 'node:fs/promises';
import { startServer } from './serve.mjs';

const { chromium } = await import('playwright');
const OUT = process.argv[2] || './ref';
const NO_SHADOW = process.argv.includes('--no-shadow');
await mkdir(OUT, { recursive: true });

const srv = await startServer({ port: 0 });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('[例外]', e.message));
await page.goto(srv.url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.app != null, { timeout: 180000 });
await page.waitForTimeout(1500);

const scenes = [
  { name: 'lab', mode: 'room', key: 'lab', cam: [3.0, 2.0, 3.5], target: [0, 1.0, 0] },
  { name: 'warehouse', mode: 'room', key: 'warehouse', cam: [6, 3.5, 8], target: [0, 1.2, 0] },
  { name: 'school', mode: 'building', key: 'school', cam: [-14, 2.2, 0], target: [-2, 1.4, -3] },
  { name: 'factory', mode: 'building', key: 'factory', cam: [-10, 3.0, 6], target: [4, 1.6, -2] },
];

for (const s of scenes) {
  await page.evaluate(async (s) => {
    const a = window.app;
    a.headless = true;
    const rooms = await import('/src/config/rooms.js');
    a.env.mode = s.mode;
    a.env.seed = 7;
    if (s.noShadow) a.env.shadows = false;
    if (s.mode === 'building') a.env.building = s.key;
    else { a.env.preset = s.key; a.env.size = { ...rooms.ROOM_PRESETS[s.key].size };
      a.env.lighting = rooms.ROOM_PRESETS[s.key].lighting; }
    a.rebuildRoom();
    a.sim.reset({ position: { x: s.target[0], y: s.target[1], z: s.target[2] }, yaw: 0 });
    a.renderer.viewMode = 'orbit';
    a.renderer.camera.position.set(...s.cam);
    a.renderer.controls.target.set(...s.target);
    a.renderer.controls.update();
    a.renderer.showPiP = false;
    // 比較の邪魔になる補助表示 (軌道・飛行履歴・目標マーカー) を消す。
    // これらは実行ごとに内容が変わるので、描画の回帰判定に混ぜない。
    a.renderer.clearTrail();
    a.renderer.pathLine.visible = false;
    a.renderer.trailLine.visible = false;
    a.renderer.targetMarker.visible = false;
    // 影を必ず焼いてから描く
    a.renderer.shadowAccum = Infinity;
    a.headlessStep(1 / 60);
    a.renderer.clearTrail();
    a.renderer.shadowAccum = Infinity;
    a.headlessStep(1 / 60);
    a.renderer.clearTrail();
  }, { ...s, noShadow: NO_SHADOW });
  await page.locator('#view').screenshot({ path: `${OUT}/${s.name}.png` });
  console.log(`${OUT}/${s.name}.png`);
}

await browser.close();
srv.server.close();
