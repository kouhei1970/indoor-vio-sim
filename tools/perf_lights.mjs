/**
 * 光源の数が描画コストに与える影響を測る (開発用)。
 *
 * three.js の前方レンダリングでは、光源はすべての画素で評価されるので、
 * 「画面がシーンでどれだけ埋まっているか」で効き方がまったく違う。
 * ここではカメラを室内に置いて画面を埋めた状態で測る。
 *
 *   node tools/perf_lights.mjs [環境キー]
 */

import { startServer } from './serve.mjs';

const { chromium } = await import('playwright');
const KEY = process.argv[2] || null;

const srv = await startServer({ port: 0 });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
// 光源は画素ごとに評価されるので、画素数を増やすと影響が見えやすい
const W = Number(process.env.PERF_W || 1600), H = Number(process.env.PERF_H || 1000);
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('[例外]', e.message));
await page.goto(srv.url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.app != null, { timeout: 180000 });
await page.waitForTimeout(1500);

const targets = KEY
  ? [{ mode: 'building', key: KEY, cam: [-14, 1.6, 0], look: [4, 1.5, -2] }]
  : [
    { mode: 'room', key: 'lab', cam: [-2.5, 1.5, -3.5], look: [2, 1.2, 3] },
    { mode: 'building', key: 'school', cam: [-14, 1.6, 0], look: [4, 1.5, -2] },
    { mode: 'building', key: 'office', cam: [-9, 1.6, 0], look: [6, 1.4, 0] },
  ];

for (const t of targets) {
  const r = await page.evaluate(async (t) => {
    const a = window.app;
    a.headless = true;
    const rooms = await import('/src/config/rooms.js');
    a.env.mode = t.mode;
    if (t.mode === 'building') a.env.building = t.key;
    else { a.env.preset = t.key; a.env.size = { ...rooms.ROOM_PRESETS[t.key].size }; }
    a.rebuildRoom();

    const gl = a.renderer.renderer;
    const cam = a.renderer.camera;
    cam.position.set(...t.cam);
    cam.lookAt(...t.look);
    cam.updateMatrixWorld(true);

    // 影を落とさない光源 (点光源・面光源) が対象
    const pts = [];
    a.renderer.scene.traverse((o) => {
      if ((o.isPointLight || o.isRectAreaLight) && !o.castShadow) pts.push(o);
    });

    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = false;

    // 画面がどれだけシーンで埋まっているか (背景色でない画素の割合)
    gl.setRenderTarget(null);
    gl.render(a.renderer.scene, cam);

    // WebGL のコマンドは積まれるだけで、そのままでは描画の完了を待たない。
    // 1 画素読み出して同期しないと、CPU 側の発行時間しか測れない。
    const ctx = gl.getContext();
    const px = new Uint8Array(4);
    const sync = () => {
      gl.setRenderTarget(null);
      ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    };
    const measure = (n = 6) => {
      // 光源数が変わるとシェーダを作り直すので、十分にウォームアップする
      for (let i = 0; i < 8; i++) { gl.setRenderTarget(null); gl.render(a.renderer.scene, cam); }
      sync();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { gl.setRenderTarget(null); gl.render(a.renderer.scene, cam); }
      sync();
      return (performance.now() - t0) / n;
    };

    const res = [];
    for (const k of [pts.length, Math.round(pts.length / 2), 8, 4, 0]) {
      if (res.length && k === res[res.length - 1].k) continue;
      pts.forEach((l, i) => { l.visible = i < k; });
      res.push({ k, ms: measure() });
    }
    pts.forEach((l) => { l.visible = true; });

    let tris = 0;
    tris = gl.info.render.triangles;
    return { key: t.key, mode: t.mode, points: pts.length, tris, res };
  }, t);

  console.log(`${(r.mode === 'building' ? '建物 ' : '部屋 ') + r.key}  `
    + `光源 ${r.points}  三角形 ${r.tris}  ${W}x${H}`);
  const base = r.res[0].ms;
  for (const x of r.res) {
    console.log(`    光源 ${String(x.k).padStart(2)}: ${x.ms.toFixed(1).padStart(7)} ms`
      + `   (全点灯比 ${(x.ms / base * 100).toFixed(0)}%)`);
  }
  console.log('');
}

await browser.close();
srv.server.close();
