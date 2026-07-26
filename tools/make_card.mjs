/**
 * SNS 用のカード画像 (OGP / GitHub のソーシャルプレビュー) を作る。
 *
 *   node tools/make_card.mjs        → assets/social-card.png (1920x960)
 *
 * シミュレータを実際に動かして撮った 2 枚を合成する。
 *   1. 外部視点の画面 (学校の廊下でホバリングする StampFly)
 *   2. 機体カメラの映像 (レンズ歪み込み = 書き出されるデータセット画像)
 *
 * 見た目を変えたいときは CARD_HTML と SHOT の設定をいじって撮り直す。
 * playwright が要る (npm install playwright)。同梱ブラウザの版がずれている
 * ときは CHROMIUM_PATH でシステムの Chrome を指す。
 */

import { mkdtemp, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'assets', 'social-card.png');

// カードの寸法。GitHub のソーシャルプレビューは 1280x640 推奨。
// 1.5 倍で描いて 1920x960 にしておくと、X / Slack でも粗く見えない。
const W = 1280, H = 640, SCALE = 1.5;

// 撮影する場面 (学校 1F の廊下、機首は東向き)
const SHOT = {
  building: 'school',
  vehicle: 'stampfly',
  drone: { x: -7.5, y: 1.35, z: -4.0 },
  yaw: -Math.PI / 2,                       // 機首 +x
  camOffset: { x: -0.62, y: 0.15, z: 0.14 },
  camTarget: { x: 8.0, y: 0.02, z: -0.10 },
};

const CARD_HTML = `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:${W}px; height:${H}px; overflow:hidden; }
body { display:flex; background:#0b0d10; color:#eef2f6; -webkit-font-smoothing:antialiased;
  font-family:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP",system-ui,sans-serif; }
.panel { position:relative; width:47%; padding:58px 44px 44px 56px; z-index:2;
  display:flex; flex-direction:column; justify-content:center;
  background: radial-gradient(120% 90% at 0% 0%, rgba(54,211,153,.14), transparent 62%),
              linear-gradient(160deg,#12161b 0%,#0b0d10 70%); }
.panel::after { content:""; position:absolute; top:0; right:-70px; bottom:0; width:70px;
  background:linear-gradient(90deg,#0b0d10,rgba(11,13,16,0)); }
.eyebrow { display:flex; align-items:center; gap:10px; margin-bottom:20px;
  font-size:15px; letter-spacing:.16em; font-weight:700; color:#36d399; text-transform:uppercase; }
.eyebrow .dot { width:9px; height:9px; border-radius:50%; background:#36d399;
  box-shadow:0 0 14px rgba(54,211,153,.9); }
h1 { font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace;
  font-size:58px; font-weight:700; line-height:1; letter-spacing:-.02em; margin-bottom:22px; }
h1 .sep { color:#36d399; }
.jp { font-size:25px; font-weight:700; line-height:1.5; margin-bottom:12px; }
.en { font-size:15.5px; line-height:1.6; color:#9fb0bd; margin-bottom:30px; }
.chips { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:34px; }
.chip { font-size:13.5px; font-weight:600; padding:7px 13px; border-radius:999px;
  border:1px solid rgba(54,211,153,.34); background:rgba(54,211,153,.09); color:#b6f0d8; }
.foot { font-size:15px; padding-top:18px; border-top:1px solid rgba(255,255,255,.09); }
.foot .url { color:#dbe4ea; font-weight:600; }
.shot { position:relative; flex:1; overflow:hidden; }
.shot > img { width:100%; height:100%; object-fit:cover; object-position:44% 50%; display:block; }
.shot::after { content:""; position:absolute; inset:0;
  background:linear-gradient(180deg,rgba(11,13,16,.30),rgba(11,13,16,0) 22%,
             rgba(11,13,16,0) 74%,rgba(11,13,16,.34)); }
.inset { position:absolute; right:26px; bottom:26px; z-index:3; width:252px; }
.inset img { width:100%; display:block; border-radius:4px; border:2px solid #36d399;
  box-shadow:0 12px 34px rgba(0,0,0,.62); }
.inset .cap { display:flex; align-items:center; gap:7px; margin-bottom:7px;
  font-size:12px; font-weight:700; color:#cfe9dd; text-shadow:0 1px 6px rgba(0,0,0,.9); }
.inset .cap .rec { width:8px; height:8px; border-radius:50%; background:#ff4d6d;
  box-shadow:0 0 10px rgba(255,77,109,.95); }
</style></head><body>
<div class="panel">
  <div class="eyebrow"><span class="dot"></span>Browser-only &middot; No build</div>
  <h1>indoor<span class="sep">-</span>vio<span class="sep">-</span>sim</h1>
  <div class="jp">屋内マルチコプタ<br>フォトリアル飛行シミュレータ</div>
  <div class="en">Photorealistic indoor multicopter simulator —<br>
    generate VIO / SLAM datasets straight from your browser.</div>
  <div class="chips">
    <span class="chip">TUM / EuRoC</span><span class="chip">COLMAP / NeRF</span>
    <span class="chip">レンズ歪み・ノイズ</span><span class="chip">複数階の建物</span>
    <span class="chip">実機 StampFly</span>
  </div>
  <div class="foot"><span class="url">kouhei1970.github.io/indoor-vio-sim</span></div>
</div>
<div class="shot">
  <img src="./scene.png" alt="">
  <div class="inset">
    <div class="cap"><span class="rec"></span>機体カメラ = 書き出される画像</div>
    <img src="./onboard.png" alt="">
  </div>
</div></body></html>`;

/** 撮影前に毎回やる下ごしらえ (UI を消す・機体と環境を決める) */
const SETUP = (s) => `async () => {
  const a = window.app;
  const veh = await import('./src/config/vehicle.js');
  a.hud.setVisible(false);
  document.getElementById('gui').style.display = 'none';
  document.getElementById('toolbar').style.display = 'none';
  a.vehicle = veh.buildVehicle('${s.vehicle}');
  a.rebuildVehicle();
  await a.renderer.droneBuilder.meshReady;      // STL を待つ
  a.env.mode = 'building'; a.env.building = '${s.building}';
  a.rebuildRoom(); a.resetSim();
  a.renderer.autoQuality = false;
  a.renderer.buildingBuilder.lightBudget = 0;   // 見栄え優先で全灯
  a.renderer.pathLine.visible = false;
  a.renderer.trailLine.visible = false;
  a.renderer.targetMarker.visible = false;
  a.sim.setMode('position');
  a.sim.state.p = ${JSON.stringify(s.drone)};
  a.sim.state.v = { x: 0, y: 0, z: 0 };
  a.sim.state.q = { x: 0, y: ${Math.sin(s.yaw / 2)}, z: 0, w: ${Math.cos(s.yaw / 2)} };
  a.sim.controller.targetPos = { ...a.sim.state.p };
  a.sim.controller.targetYaw = ${s.yaw};
  for (let i = 0; i < 300; i++) a.sim.advance(0.01);
}`;

const launch = async (chromium) => chromium.launch({
  headless: false,   // 実 GPU で描かせる (headless だとソフトウェア描画になる)
  args: ['--use-angle=metal', '--enable-gpu', '--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

const open = async (browser, url, viewport, scale) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
  page.on('pageerror', (e) => console.log('[例外]', e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction(() => window.app != null, { timeout: 300000 });
  await page.waitForTimeout(3000);
  return page;
};

const { chromium } = await import('playwright');
const srv = await startServer({ port: 0 });
const browser = await launch(chromium);
const work = await mkdtemp(join(tmpdir(), 'card-'));

// --- 1. 外部視点 ---
const scene = await open(browser, srv.url, { width: W, height: H }, 2);
await scene.evaluate(`(${SETUP(SHOT)})()`);
await scene.evaluate(([off, tgt]) => {
  const a = window.app;
  const p = a.sim.state.p;
  a.renderer.showPiP = false;          // 機体カメラは別撮りして合成する
  a.renderer.renderHeight = 1280;
  a.renderer.applyResolution();
  a.renderer.viewMode = 'orbit';
  a.renderer.camera.position.set(p.x + off.x, p.y + off.y, p.z + off.z);
  a.renderer.controls.target.set(p.x + tgt.x, p.y + tgt.y, p.z + tgt.z);
  a.renderer.controls.update();
}, [SHOT.camOffset, SHOT.camTarget]);
await scene.waitForTimeout(3000);
await scene.screenshot({ path: join(work, 'scene.png') });
console.log('外部視点を撮影');

// --- 2. 機体カメラ ---
const cam = await open(browser, srv.url, { width: 640, height: 480 }, 2);
await cam.evaluate(`(${SETUP(SHOT)})()`);
await cam.evaluate(() => { window.app.renderer.viewMode = 'onboard'; });
await cam.waitForTimeout(2500);
await cam.screenshot({ path: join(work, 'onboard.png') });
console.log('機体カメラを撮影');

// --- 3. 合成 ---
await writeFile(join(work, 'card.html'), CARD_HTML);
const card = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
await card.goto(`file://${work}/card.html`, { waitUntil: 'networkidle' });
await card.waitForTimeout(800);
await mkdir(join(ROOT, 'assets'), { recursive: true });
await card.screenshot({ path: join(work, 'card.png') });
await copyFile(join(work, 'card.png'), OUT);
console.log(`カードを書き出しました: ${OUT}  (${W * SCALE}x${H * SCALE})`);

await browser.close();
srv.server.close();
