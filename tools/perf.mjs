/**
 * 描画コストの計測 (開発用)。
 *
 * 環境ごとに three.js の描画統計 (ドローコール・三角形数・シェーダ数) と
 * 1 フレームの所要時間を測る。ドローコール数とシェーダ数は GPU に依存しない
 * 指標なので、実機の速さに関係なくボトルネックの比較に使える。
 *
 *   node tools/perf.mjs
 */

import { startServer } from './serve.mjs';

const { chromium } = await import('playwright');

const srv = await startServer({ port: 0 });
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[例外]', e.message));

await page.goto(srv.url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.app != null, { timeout: 180000 });
await page.waitForTimeout(1500);

const targets = [
  { mode: 'room', key: 'lab' },
  { mode: 'room', key: 'warehouse' },
  { mode: 'building', key: 'community' },
  { mode: 'building', key: 'factory' },
  { mode: 'building', key: 'office' },
  { mode: 'building', key: 'school' },
];

const rows = [];
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
    let meshes = 0, lights = 0, shadowCasters = 0;
    a.renderer.scene.traverse((o) => {
      if (o.isMesh) meshes++;
      if (o.isLight) { lights++; if (o.castShadow) shadowCasters++; }
    });

    // 計測: 描画のみ (物理は進めない)
    const measure = (label, fn, n = 12) => {
      fn(); // ウォームアップ (シェーダのコンパイルを済ませる)
      gl.info.reset();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) fn();
      gl.finish?.();
      const ms = (performance.now() - t0) / n;
      return {
        label, ms,
        calls: gl.info.render.calls / (n + 0), // reset 後 n 回ぶん
        tris: gl.info.render.triangles / n,
      };
    };

    const drawMain = () => { gl.setRenderTarget(null); gl.render(a.renderer.scene, a.renderer.camera); };
    const drawMainNoShadow = () => {
      gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = false;
      drawMain();
    };
    const drawMainShadow = () => {
      gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = true;
      drawMain();
    };

    const noShadow = measure('影なし', drawMainNoShadow);
    const withShadow = measure('影あり', drawMainShadow);

    // 実際の描画ループ (renderer.render) を 60Hz 相当で回したときの 1 フレーム
    a.renderer.showPiP = true;
    a.renderer.viewMode = 'orbit';
    let clock = 0;
    const frame = () => {
      clock += 1 / 60;
      a.renderer.render(a.sim.state, { time: clock, dt: 1 / 60, speeds: a.sim.motors.speeds });
    };
    for (let i = 0; i < 10; i++) frame();          // ウォームアップ
    const tStart = performance.now();
    const N = 40;
    for (let i = 0; i < N; i++) frame();
    const realMs = (performance.now() - tStart) / N;

    // 1 フレームあたりのシーン全体パス数 (GPU に依存しない指標)。
    //   主描画 1 + 影 (影を落とす光源数 x 更新レート/60)
    //   + 機体カメラ (モーションブラーの枚数 x 更新レート/60)
    const shadowPasses = shadowCasters * Math.min(1, a.renderer.shadowRate / 60);
    const blur = a.cameraCfg.motionBlur ? Math.max(1, a.cameraCfg.blurSamples) : 1;
    const sensorPasses = blur * Math.min(1, a.renderer.sensorRate / 60);
    const passes = 1 + shadowPasses + sensorPasses;

    return {
      key: t.key, mode: t.mode,
      meshes, lights, shadowCasters,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      programs: gl.info.programs.length,
      noShadow, withShadow, realMs, passes, drawPerFrame: Math.round(passes * meshes),
    };
  }, t);
  rows.push(r);
  console.log(`${(r.mode === 'building' ? '建物 ' : '部屋 ') + r.key}`.padEnd(16)
    + `mesh ${String(r.meshes).padStart(4)}  光源 ${String(r.lights).padStart(2)}(影${r.shadowCasters})  `
    + `shader ${String(r.programs).padStart(3)}  geo ${String(r.geometries).padStart(4)}  tex ${String(r.textures).padStart(3)}`);
  console.log('                '
    + `影なし ${r.noShadow.ms.toFixed(1)}ms  影あり ${r.withShadow.ms.toFixed(1)}ms   `
    + `シーン走査 ${r.passes.toFixed(1)} 回/フレーム → 約 ${r.drawPerFrame} 描画/フレーム   `
    + `★実描画ループ ${r.realMs.toFixed(1)}ms (${(1000 / r.realMs).toFixed(0)} fps)`);
}

console.log('\n※ SwiftShader (ソフトウェア描画) の時間なので実機より遥かに遅い。');
console.log('   ドローコール数・シェーダ数・mesh 数は GPU に依存しない指標。');

await browser.close();
srv.server.close();
