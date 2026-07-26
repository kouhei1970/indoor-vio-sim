/**
 * ジオメトリ統合の前後で描画が変わらないかを、同一ページ内で比較する。
 *
 * 同じセッション・同じシードで「統合なし」と「統合あり」を描き分け、
 * 画素を読み出して差を測る。色や乱数の条件が完全に一致するので、
 * 統合そのものが描画に与える影響だけを取り出せる。
 *
 *   node tools/merge_check.mjs
 */

import { startServer } from './serve.mjs';

const { chromium } = await import('playwright');

const srv = await startServer({ port: 0 });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
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

const out = await page.evaluate(async (scenes) => {
  const a = window.app;
  a.headless = true;
  const rooms = await import('/src/config/rooms.js');
  const results = [];

  // 機体カメラの映像を画素で読めるので、それを比較に使う
  const shoot = (s, merge) => {
    a.renderer.roomBuilder.mergeStatic = merge;
    a.renderer.buildingBuilder.mergeStatic = merge;
    a.env.mode = s.mode;
    a.env.seed = 7;
    if (s.mode === 'building') a.env.building = s.key;
    else {
      a.env.preset = s.key;
      a.env.size = { ...rooms.ROOM_PRESETS[s.key].size };
      a.env.lighting = rooms.ROOM_PRESETS[s.key].lighting;
    }
    a.rebuildRoom();
    a.sim.reset({ position: { x: s.target[0], y: s.target[1], z: s.target[2] }, yaw: 0 });
    a.renderer.clearTrail();
    // 機体カメラの「前フレーム姿勢」を持ち越すと、モーションブラーの条件が
    // 統合あり/なしで揃わなくなる。毎回まっさらから始める。
    a.renderer.hasPrevCam = false;
    a.renderer.sensorAccum = Infinity;
    a.renderer.shadowAccum = Infinity;
    a.headlessStep(1 / 60);
    a.renderer.shadowAccum = Infinity;
    a.headlessStep(1 / 60);
    const img = a.renderer.sensor.readPixels();
    return { data: Array.from(img.data), w: img.width, h: img.height };
  };

  for (const s of scenes) {
    const A = shoot(s, false);
    const B = shoot(s, true);
    let mx = 0, sum = 0, big = 0;
    const n = A.w * A.h;
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[i * 4 + c] - B.data[i * 4 + c]));
      mx = Math.max(mx, d); sum += d; if (d > 2) big++;
    }
    results.push({ name: s.name, mx, mean: sum / n, big, pct: (100 * big) / n, px: n });
  }
  return results;
}, scenes);

console.log('同一ページ内で「統合なし」と「統合あり」を比較 (機体カメラの画素)\n');
console.log(`${'シーン'.padEnd(12)}${'最大差'.padStart(8)}${'平均差'.padStart(10)}${'差>2 の画素'.padStart(18)}${'判定'.padStart(12)}`);
for (const r of out) {
  const verdict = r.mx === 0 ? '完全一致' : (r.pct < 0.1 ? 'ほぼ同一' : '差あり');
  console.log(`${r.name.padEnd(12)}${String(r.mx).padStart(8)}${r.mean.toFixed(4).padStart(10)}`
    + `${String(r.big).padStart(12)} (${r.pct.toFixed(3).padStart(5)}%)${verdict.padStart(12)}`);
}

await browser.close();
srv.server.close();
