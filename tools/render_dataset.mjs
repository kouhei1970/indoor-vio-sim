/**
 * ヘッドレスでデータセットを生成する CLI。
 *
 * ブラウザ (Chromium) を裏で動かしてシミュレータを実行し、
 * 画像・真値・IMU を含む ZIP を書き出す。
 * 画面上で操作するのと同じ描画パイプラインを使うので、
 * インタラクティブに確認した見た目とまったく同じ画像が得られる。
 *
 * 準備:
 *   npm install playwright        (ブラウザ本体は npx playwright install chromium)
 *
 * 使い方:
 *   node tools/render_dataset.mjs --out ./datasets --frames 300 --fps 10 \
 *        --vehicle research-250 --room lab --pattern lawnmower \
 *        --speed 0.5 --altitude 1.2 --width 640 --height 480 --seed 42
 *
 *   node tools/render_dataset.mjs --config my-config.json --out ./datasets
 *
 * よく使うオプション:
 *   --vehicle    機体プリセット (toy-90mm / nano-65mm / cinewhoop-3inch /
 *                freestyle-5inch / research-250 / hexa-inspection / x8-heavy / tricopter)
 *   --room       部屋 (lab / gym / corridor / warehouse / empty / livingroom / factory)
 *   --lighting   照明 (fluorescent / warm / highbay / corridor / single / mixed / dark)
 *   --pattern    軌道 (hover / waypoints / lawnmower / spiral / orbit / figure8 / perimeter / random)
 *   --tilt       カメラ俯角 [deg] (0=前方, 90=真下)
 *   --features   模様の多さ (0=のっぺり, 1=標準, 2=多い)
 *   --depth      深度マップも出力する
 *   --unzip      ZIP を展開して保存する
 *   --headed     ブラウザを表示する (デバッグ用)
 */

import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from './serve.mjs';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const get = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const num = (n, d) => (get(n) != null ? Number(get(n)) : d);

if (has('help') || has('h')) {
  console.log(await readFile(new URL(import.meta.url), 'utf8')
    .then((s) => s.slice(s.indexOf('/**'), s.indexOf('*/') + 2)));
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright が見つかりません。次を実行してください:\n'
    + '  npm install playwright && npx playwright install chromium');
  process.exit(1);
}

const options = {
  out: resolve(get('out', './datasets')),
  frames: num('frames', 200),
  fps: num('fps', 10),
  vehicle: get('vehicle', 'research-250'),
  room: get('room', 'lab'),
  lighting: get('lighting', null),
  pattern: get('pattern', 'lawnmower'),
  yawMode: get('yaw-mode', 'along-path'),
  speed: num('speed', 0.5),
  altitude: num('altitude', 1.2),
  radius: num('radius', 1.5),
  tilt: get('tilt') != null ? num('tilt', 0) : null,
  width: num('width', 640),
  height: num('height', 480),
  hfov: num('hfov', null),
  features: get('features') != null ? num('features', 1) : null,
  furniture: get('furniture') != null ? num('furniture', 1) : null,
  markers: get('markers') != null ? num('markers', null) : null,
  seed: num('seed', 42),
  name: get('name', null),
  depth: has('depth'),
  format: get('format', 'png'),
  config: get('config', null),
  unzip: has('unzip'),
  headed: has('headed'),
  warmup: num('warmup', 2.0),
};

const dt = 1 / options.fps;
const name = options.name
  || `${options.vehicle}-${options.room}-${options.pattern}-s${options.seed}`;

await mkdir(options.out, { recursive: true });

console.log('データセット生成を開始します');
console.log(`  機体: ${options.vehicle}   部屋: ${options.room}   軌道: ${options.pattern}`);
console.log(`  画像: ${options.width}x${options.height}  ${options.frames} 枚 @ ${options.fps} fps`
  + `  (シミュレーション時間 ${(options.frames * dt).toFixed(1)} 秒)`);

const srv = await startServer({ port: 0 });
const browser = await chromium.launch({
  headless: !options.headed,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(srv.url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.app != null, { timeout: 120000 });
  await page.waitForTimeout(500);

  const userConfig = options.config ? JSON.parse(await readFile(options.config, 'utf8')) : null;

  // --- 設定を適用 ---
  await page.evaluate(async ([o, cfg]) => {
    const a = window.app;
    a.headless = true;   // 自動描画ループを止める (刻み幅を完全に制御するため)

    const veh = await import('/src/config/vehicle.js');
    const rooms = await import('/src/config/rooms.js');

    if (cfg) {
      if (cfg.vehicle) a.vehicle = veh.deepMerge(a.vehicle, cfg.vehicle);
      if (cfg.environment) a.env = veh.deepMerge(a.env, cfg.environment);
      if (cfg.camera) a.cameraCfg = veh.deepMerge(a.cameraCfg, cfg.camera);
      if (cfg.simulation) Object.assign(a.simCfg, cfg.simulation);
      if (cfg.trajectory) Object.assign(a.sim.trajectory.cfg, cfg.trajectory);
    } else {
      a.vehicle = veh.buildVehicle(o.vehicle);
    }

    // --- 環境 ---
    const room = rooms.ROOM_PRESETS[o.room];
    if (room && !cfg) {
      a.env.preset = o.room;
      a.env.size = { ...room.size };
      a.env.lighting = o.lighting || room.lighting;
      a.env.markerCount = o.markers != null ? o.markers : room.decor.markers;
      a.env.posterCount = room.decor.posters;
      a.env.windows = room.decor.windows;
    }
    if (o.lighting) a.env.lighting = o.lighting;
    if (o.features != null) a.env.featureDensity = o.features;
    if (o.furniture != null) a.env.furnitureDensity = o.furniture;
    a.env.seed = o.seed;
    a.simCfg.seed = o.seed;

    // --- カメラ ---
    a.cameraCfg.width = o.width;
    a.cameraCfg.height = o.height;
    if (o.hfov) a.cameraCfg.hfov = o.hfov;
    a.cameraCfg.depth = o.depth;
    if (o.tilt != null) a.vehicle.parts.camera.tilt = o.tilt;

    // --- 軌道 ---
    Object.assign(a.sim.trajectory.cfg, {
      pattern: o.pattern, yawMode: o.yawMode, speed: o.speed,
      altitude: o.altitude, radius: o.radius, seed: o.seed,
    });

    // --- 記録設定 ---
    a.recorder.config.fps = o.fps;
    a.recorder.config.maxFrames = o.frames;
    a.recorder.config.saveDepth = o.depth;
    a.recorder.config.imageFormat = o.format;
    a.recorder.config.name = o.name;

    a.rebuildRoom();
    a.applyCamera();
    a.rebuildVehicle();
    a.applyTrajectory();

    // 軌道の開始点から飛ばす
    const start = a.sim.trajectory.sample(0);
    a.sim.reset({ position: start.position, yaw: start.yaw });
    a.setFlightMode('auto');
    a.renderer.showPiP = false;
    a.renderer.viewMode = 'orbit';
  }, [{ ...options, name }, userConfig]);

  // --- 助走 (姿勢を安定させてから記録を始める) ---
  const warmupSteps = Math.round(options.warmup / dt);
  for (let i = 0; i < warmupSteps; i++) {
    await page.evaluate((d) => window.app.headlessStep(d), dt);
  }

  // --- 記録 ---
  await page.evaluate(() => {
    window.app.sim.sensors.imuLog.length = 0;
    window.app.recorder.start(window.app.sim.time);
  });

  let last = Date.now();
  for (let i = 0; i < options.frames; i++) {
    const st = await page.evaluate((d) => window.app.headlessStep(d), dt);
    if (Date.now() - last > 2000) {
      last = Date.now();
      const pct = ((i + 1) / options.frames * 100).toFixed(0);
      process.stdout.write(`\r  ${i + 1}/${options.frames} 枚 (${pct}%)  `
        + `sim t=${st.t.toFixed(1)}s  位置 ${st.position.x.toFixed(2)}, `
        + `${st.position.y.toFixed(2)}, ${st.position.z.toFixed(2)}   `);
    }
    if (st.crashed) {
      console.log('\n  警告: 機体が墜落しました。軌道や機体設定を確認してください。');
      break;
    }
  }
  process.stdout.write('\n');

  // --- 書き出し ---
  console.log('  ZIP を生成しています...');
  const dlPromise = page.waitForEvent('download', { timeout: 300000 });
  await page.evaluate(() => window.app.exportDataset());
  const download = await dlPromise;
  const zipPath = join(options.out, download.suggestedFilename());
  await download.saveAs(zipPath);
  console.log(`  保存しました: ${zipPath}`);

  if (options.unzip) {
    const dir = zipPath.replace(/\.zip$/, '');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    try {
      await promisify(execFile)('unzip', ['-q', zipPath, '-d', dir]);
      console.log(`  展開しました: ${dir}`);
    } catch {
      console.log('  unzip コマンドが無いため展開はスキップしました');
    }
  }

  if (errors.length) {
    console.log('\n  ブラウザ側のエラー:');
    for (const e of errors.slice(0, 10)) console.log('   ', e);
  }
} finally {
  await browser.close();
  srv.server.close();
}

if (!existsSync(options.out)) process.exit(1);
console.log('完了しました。');
