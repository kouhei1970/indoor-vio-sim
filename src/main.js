/**
 * アプリケーション本体。
 * 物理シミュレータ・描画・UI・入力・データ記録を接続する。
 */

import * as THREE from 'three';
import { Simulator } from './core/simulator.js';
import { CollisionWorld } from './core/collision.js';
import { buildVehicle, SIM_DEFAULTS, deepMerge, clone } from './config/vehicle.js';
import { ENV_DEFAULTS, ROOM_PRESETS } from './config/rooms.js';
import { BUILDING_PRESETS } from './config/buildings.js';
import { SceneRenderer } from './render/renderer.js';
import { CAMERA_DEFAULTS } from './render/cameraSensor.js';
import { DatasetRecorder } from './io/dataset.js';
import { InputManager } from './io/input.js';
import { createGui } from './ui/gui.js';
import { Hud } from './ui/hud.js';
import { v3, qToEuler, RAD } from './core/math.js';
import { AIR_PRESETS } from './core/aero.js';

const MODE_LABELS = {
  position: '位置保持', auto: '自動飛行', altitude: '高度保持',
  angle: '姿勢', rate: 'アクロ',
};

class App {
  constructor() {
    this.canvas = document.getElementById('view');
    this.world = new CollisionWorld();

    this.vehicle = buildVehicle('research-250');
    this.simCfg = clone(SIM_DEFAULTS);
    this.env = clone(ENV_DEFAULTS);
    this.cameraCfg = clone(CAMERA_DEFAULTS);

    this.state = {
      vehiclePreset: 'research-250',
      cameraPreset: 'global-shutter-vio',
      flightMode: 'position',
      viewMode: 'orbit',
      airPreset: 'standard',
      exposure: 1.0,
      envIntensity: 0.05,
      showPath: true,
      showTrail: true,
      showHud: true,
      failedMotor: -1,
      paused: false,
    };

    this.sim = new Simulator(this.vehicle, this.simCfg, this.world);
    this.renderer = new SceneRenderer(this.canvas, this.world);
    this.recorder = new DatasetRecorder(this.renderer.sensor);
    this.hud = new Hud(document.getElementById('overlay'));

    this.input = new InputManager({
      handlers: {
        Space: () => this.toggleTakeoff(),
        KeyR: () => this.resetSim(),
        KeyM: () => this.cycleFlightMode(),
        KeyV: () => this.cycleView(),
        KeyP: () => this.togglePause(),
        KeyG: () => this.toggleRecording(),
        KeyH: () => this.toggleHelp(),
      },
      // ゲームパッドのボタン。StampFly コントローラ (USB HID モード) の
      // 割り当てに合わせてある: 0=[A]Arm 1=[F]Flip 2=[M]Mode 3=[O]Option
      // (stampfly_ecosystem: firmware/controller/components/usb_hid/include/usb_hid.hpp)
      padHandlers: {
        0: () => this.toggleTakeoff(),      // [A] 離陸 / 着陸
        1: () => this.cycleView(),          // [F] 視点切替
        2: () => this.cycleFlightMode(),    // [M] フライトモード切替
      },
    });

    this.rebuildRoom();
    this.applyCamera();
    this.rebuildVehicle();
    this.sim.setMode('position');
    this.sim.controller.targetPos = { ...this.sim.state.p };

    this.guiHandle = createGui(this, document.getElementById('gui'));
    this.setupResize();
    this.setupButtons();

    this.lastTime = performance.now();
    this.fps = 60;
    this.trailAccum = 0;
    this.animate();
  }

  /* ------------------------------------------------------------ */
  /* 再構築                                                        */
  /* ------------------------------------------------------------ */

  rebuildVehicle() {
    // 物理側 (質量・慣性・ミキサ・制御ゲイン) を作り直す
    this.sim.setVehicle(this.vehicle);
    // 描画側のモデルを作り直す
    this.renderer.buildDrone(this.vehicle, this.sim.massProps.com);
    // 当たり判定の接地面を、実際に描かれるモデルの最下点へ合わせる
    // (球の集まりで近似しているため、そのままだと床にめり込む / 浮く)。
    // 実機 CAD (STL) は非同期に届くので、届いた時点でもう一度合わせ直す
    // (onBoundsChanged は droneBuilder が呼ぶ)。
    this.renderer.droneBuilder.onBoundsChanged = (b) => this.sim.setModelBottom(b.min.y);
    this.sim.setModelBottom(this.renderer.droneBuilder.bounds?.min.y);
    this.renderer.clearTrail();
    this.sim.controller.targetPos = { ...this.sim.state.p };
    this.updatePerf();
  }

  rebuildRoom() {
    this.renderer.buildRoom(this.env);
    // 建物モードなら「建物ルート」の軌道が使えるようにプリセットを渡す
    this.sim.trajectory.setBuilding(
      this.env.mode === 'building' ? BUILDING_PRESETS[this.env.building] : null);
    this.sim.trajectory.setRoom(this.world.room);
    this.renderer.setPath(this.sim.trajectory.polyline());
    // 環境が変わったら安全な初期位置へ
    this.sim.reset({ position: this.spawnPosition() });
    this.sim.setMode(this.state.flightMode);
    this.sim.controller.targetPos = { ...this.sim.state.p };
    this.renderer.clearTrail();
  }

  /** 着地状態の初期位置 (脚の高さぶん浮かせる) */
  spawnPosition() {
    const h = this.vehicle.parts.landingGear.enabled
      ? this.vehicle.parts.landingGear.height + 0.05 : 0.06;
    const s = this.renderer.spawnPoint();
    return v3(s.x, (s.y || 0) + h, s.z);
  }

  applyCamera() {
    this.renderer.sensor.applyConfig(this.cameraCfg);
    this.updatePerf();
  }

  applyTrajectory() {
    this.sim.trajectory.rebuild();
    this.renderer.setPath(this.sim.trajectory.polyline());
  }

  updatePerf() {
    const p = this.sim.perf;
    const I = this.sim.massProps.inertia;
    this.perfInfo = {
      ...p,
      mass: this.sim.massProps.mass,
      inertia: `${I[0].toExponential(2)} / ${I[4].toExponential(2)} / ${I[8].toExponential(2)}`,
    };
    const c = this.renderer.sensor.intrinsics;
    this.cameraInfo = `${c.width}x${c.height} fx=${c.fx.toFixed(1)}`;
  }

  /* ------------------------------------------------------------ */
  /* 操作                                                          */
  /* ------------------------------------------------------------ */

  setFlightMode(mode) {
    this.state.flightMode = mode;
    this.sim.setMode(mode);
    if (mode === 'auto') this.sim.time = 0;
  }

  cycleFlightMode() {
    const modes = ['position', 'auto', 'altitude', 'angle', 'rate'];
    const i = modes.indexOf(this.state.flightMode);
    this.setFlightMode(modes[(i + 1) % modes.length]);
  }

  cycleView() {
    const modes = ['orbit', 'chase', 'onboard', 'top', 'cockpit'];
    const i = modes.indexOf(this.state.viewMode);
    this.state.viewMode = modes[(i + 1) % modes.length];
    this.renderer.viewMode = this.state.viewMode;
  }

  togglePause() { this.state.paused = !this.state.paused; }

  /** 今いる階の床の高さと階高。単室モードは床 = 0。 */
  currentFloor() {
    const b = this.renderer.buildingBuilder;
    if (this.renderer.activeBuilder !== b) return { y: 0, height: this.env.size.height };
    let best = { y: 0, height: 3.0 };
    for (const f of b.floorInfo) {
      if (f.elevation <= this.sim.state.p.y + 0.3) best = { y: f.elevation, height: f.height };
    }
    return best;
  }

  toggleTakeoff() {
    const target = this.sim.controller.targetPos || { ...this.sim.state.p };
    // 建物モードでは今いる階の床を基準にする
    const fl = this.currentFloor();
    const cruise = fl.y + Math.min(fl.height - 0.6, 1.2);
    if (this.sim.state.p.y < fl.y + (cruise - fl.y) * 0.5) {
      this.sim.controller.targetPos = { x: target.x, y: cruise, z: target.z };
    } else {
      this.sim.controller.targetPos = { x: this.sim.state.p.x, y: fl.y + 0.02, z: this.sim.state.p.z };
    }
  }

  setMotorFailure(index) {
    const n = this.sim.rotors.length;
    for (let i = 0; i < n; i++) this.sim.setMotorFailure(i, false);
    if (index >= 0 && index < n) this.sim.setMotorFailure(index, true);
  }

  resetSim() {
    this.sim.reset({ position: this.spawnPosition() });
    this.sim.setMode(this.state.flightMode);
    this.sim.controller.targetPos = { ...this.sim.state.p };
    this.renderer.clearTrail();
    this.state.failedMotor = -1;
  }

  toggleRecording() {
    if (this.recorder.recording) {
      this.recorder.stop();
    } else {
      this.recorder.start(this.sim.time);
      this.sim.sensors.imuLog.length = 0;
    }
  }

  async exportDataset() {
    if (!this.recorder.frameCount) {
      this.notify('記録されたフレームがありません (G キーまたは「記録 開始」で記録します)');
      return;
    }
    this.recorder.stop();
    this.recorder.setImuLog(this.sim.sensors.imuLog);
    this.notify('ZIP を生成しています...');
    await this.recorder.export({
      vehicle: this.vehicle,
      environment: this.env,
      simulation: this.simCfg,
      trajectory: this.sim.trajectory.cfg,
      performance: this.sim.perf,
      mass_properties: {
        mass_kg: this.sim.massProps.mass,
        com: this.sim.massProps.com,
        inertia_kgm2: this.sim.massProps.inertia,
      },
    });
    this.notify('ZIP を書き出しました');
  }

  saveConfig() {
    const data = {
      version: 1,
      vehicle: this.vehicle,
      environment: this.env,
      camera: this.cameraCfg,
      simulation: this.simCfg,
      trajectory: this.sim.trajectory.cfg,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `drone-config-${this.vehicle.name || 'custom'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  loadConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.vehicle) this.vehicle = deepMerge(this.vehicle, data.vehicle);
        if (data.environment) this.env = deepMerge(this.env, data.environment);
        if (data.camera) this.cameraCfg = deepMerge(this.cameraCfg, data.camera);
        if (data.simulation) Object.assign(this.simCfg, data.simulation);
        if (data.trajectory) Object.assign(this.sim.trajectory.cfg, data.trajectory);
        this.rebuildRoom();
        this.applyCamera();
        this.rebuildVehicle();
        this.applyTrajectory();
        this.guiHandle.rebuildGuiVehicle();
        this.guiHandle.refresh();
        this.notify(`設定を読み込みました: ${file.name}`);
      } catch (err) {
        this.notify(`読み込みに失敗しました: ${err.message}`);
      }
    };
    input.click();
  }

  notify(text) {
    const el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  toggleHelp() {
    document.getElementById('help').classList.toggle('open');
  }

  /* ------------------------------------------------------------ */

  setupResize() {
    const resize = () => {
      const w = this.canvas.clientWidth || window.innerWidth;
      const h = this.canvas.clientHeight || window.innerHeight;
      this.renderer.setSize(w, h);
    };
    window.addEventListener('resize', resize);
    const ro = new ResizeObserver(resize);
    ro.observe(this.canvas.parentElement);
    resize();
  }

  setupButtons() {
    document.getElementById('btn-help')?.addEventListener('click', () => this.toggleHelp());
    document.getElementById('btn-close-help')?.addEventListener('click', () => this.toggleHelp());
    document.getElementById('btn-record')?.addEventListener('click', () => this.toggleRecording());
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportDataset());
    document.getElementById('btn-reset')?.addEventListener('click', () => this.resetSim());
    document.getElementById('btn-pause')?.addEventListener('click', () => this.togglePause());
    document.getElementById('btn-view')?.addEventListener('click', () => this.cycleView());
    document.getElementById('btn-gui')?.addEventListener('click', () => {
      document.body.classList.toggle('gui-hidden');
    });
  }

  /* ------------------------------------------------------------ */

  /**
   * ヘッドレス実行用: 決まった刻み幅で 1 ステップ進めて 1 フレーム記録する。
   *
   * 画面の更新速度に依存せず、指定した dt どおりに時間が進むので、
   * 実行環境が違っても同じデータセットが得られる (再現性の確保)。
   * tools/render_dataset.mjs から呼ばれる。
   */
  /**
   * 実機での描画コストの内訳を測る。ブラウザのコンソールから呼ぶ:
   *
   *     await app.profile()
   *
   * どの段が重いのかは GPU・解像度・環境で変わるので、
   * 手元の環境で測った値をもとに「表示」の設定を詰める。
   */
  async profile(frames = 20) {
    const gl = this.renderer.renderer;
    const scene = this.renderer.scene;
    const cam = this.renderer.camera;
    const wasHeadless = this.headless;
    this.headless = true;                       // 自動ループを止めて測定に専念する
    await new Promise((r) => requestAnimationFrame(r));

    let meshes = 0, lights = 0, shadowLights = 0;
    scene.traverse((o) => {
      if (o.isMesh) meshes++;
      if (o.isLight) { lights++; if (o.castShadow) shadowLights++; }
    });

    // GPU の完了を待つ (readPixels は同期する)
    const sync = () => {
      gl.setRenderTarget(null);
      const ctx = gl.getContext();
      ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, new Uint8Array(4));
    };

    const mainOnly = () => {
      gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = false;
      gl.setRenderTarget(null); gl.render(scene, cam);
    };
    const mainShadow = () => {
      gl.shadowMap.autoUpdate = false; gl.shadowMap.needsUpdate = true;
      gl.setRenderTarget(null); gl.render(scene, cam);
    };
    this.renderer.sensor.camera.updateMatrixWorld(true);
    const prevCam = this.renderer.sensor.camera.matrixWorld.clone();
    // ブラーが効くよう、前フレーム姿勢を少しずらしたものを渡す
    const moved = prevCam.clone();
    moved.elements[12] += 0.05;
    const sensorPlain = () => this.renderer.sensor.render(scene, 0, null, 1 / 30);
    const sensorBlur = () => this.renderer.sensor.render(scene, 0, moved, 1 / 30);

    // --- ウォームアップ ---
    // シェーダのコンパイルとシャドウマップの確保は初回だけ非常に重い。
    // 全経路を数回ずつ通してから測らないと、最初に測った段に全部乗ってしまう。
    for (let i = 0; i < 3; i++) { mainOnly(); mainShadow(); sensorPlain(); sensorBlur(); }
    sync();
    await new Promise((r) => requestAnimationFrame(r));

    const time = (label, fn) => {
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) fn();
      sync();
      return { label, ms: (performance.now() - t0) / frames };
    };

    const rows = [];
    rows.push(time('主描画 (影なし)', mainOnly));
    mainOnly();
    const tris = gl.info.render.triangles;        // 主描画 1 回ぶんの三角形数
    rows.push(time('主描画 + 影の焼き直し', mainShadow));
    rows.push(time('機体カメラ (ブラーなし)', sensorPlain));
    rows.push(time('機体カメラ (ブラーあり)', sensorBlur));

    this.headless = wasHeadless;
    const c = this.renderer.sensor.intrinsics;
    const info = {
      環境: this.env.mode === 'building' ? `建物 ${this.env.building}` : `部屋 ${this.env.preset}`,
      画面: `${this.renderer.width}x${this.renderer.height}`,
      機体カメラ: `${c.width}x${c.height}`,
      mesh: meshes, 三角形: tris, 光源: lights, 影を落とす光源: shadowLights,
      影の更新レート: this.renderer.shadowRate, カメラ更新レート: this.renderer.sensorRate,
      ブラー枚数: this.cameraCfg.motionBlur ? this.cameraCfg.blurSamples : 0,
    };
    const shadowMs = Math.max(0, rows[1].ms - rows[0].ms);
    const perFrame = rows[0].ms
      + shadowMs * Math.min(1, this.renderer.shadowRate / 60)
      + rows[3].ms * Math.min(1, this.renderer.sensorRate / 60);

    console.table(info);
    console.table(rows.map((r) => ({ 段: r.label, 'ms/回': Number(r.ms.toFixed(2)) })));
    console.log(`影の焼き直しだけのコスト: ${shadowMs.toFixed(2)} ms/回`);
    console.log(`60fps 時の 1 フレーム見込み: ${perFrame.toFixed(2)} ms `
      + `(${(1000 / perFrame).toFixed(0)} fps 相当)`);
    return { info, rows, shadowMs, perFrame };
  }

  headlessStep(dt) {
    this.sim.setCommand({ roll: 0, pitch: 0, yaw: 0, throttle: 0 });
    this.sim.advance(dt);
    const snapshot = this.sim.snapshot();
    this.renderer.render(this.sim.state, {
      time: this.sim.time, dt, speeds: this.sim.motors.speeds, forceOnboard: true,
    });
    this.renderer.pushTrail(this.sim.state.p);
    if (this.recorder.recording) {
      // update() ではなく直接取り込む (1 ステップ = 1 フレーム)
      this.recorder.capture(snapshot, this.renderer.sensor.camera);
      if (this.recorder.frameCount >= this.recorder.config.maxFrames) this.recorder.stop();
    }
    return {
      t: this.sim.time,
      frames: this.recorder.frameCount,
      recording: this.recorder.recording,
      crashed: this.sim.crashed,
      position: this.sim.state.p,
    };
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    if (this.headless) return;   // ヘッドレス実行中は自動ループを止める
    const now = performance.now();
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    dt = Math.min(dt, 0.1);
    this.fps = this.fps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;

    // --- 入力 ---
    const cmd = this.input.update(dt);
    this.sim.setCommand({
      roll: cmd.roll, pitch: cmd.pitch, yaw: cmd.yaw,
      throttle: this.state.flightMode === 'rate' || this.state.flightMode === 'angle'
        ? (cmd.throttle + 1) / 2 : cmd.throttle,
    });

    // --- 物理 ---
    if (!this.state.paused) this.sim.advance(dt);

    // --- 描画 ---
    const snapshot = this.sim.snapshot();
    this.renderer.render(this.sim.state, {
      time: this.sim.time,
      dt,
      speeds: this.sim.motors.speeds,
    });

    // 飛行履歴
    this.trailAccum += dt;
    if (this.trailAccum > 0.05 && !this.state.paused) {
      this.trailAccum = 0;
      this.renderer.pushTrail(this.sim.state.p);
    }
    if (this.state.flightMode === 'auto' && this.sim.lastTarget) {
      const t = this.sim.lastTarget.position;
      this.renderer.targetMarker.position.set(t.x, t.y, t.z);
      this.renderer.targetMarker.visible = this.state.showPath;
    } else if (this.sim.controller.targetPos) {
      const t = this.sim.controller.targetPos;
      this.renderer.targetMarker.position.set(t.x, t.y, t.z);
      this.renderer.targetMarker.visible = this.state.showPath;
    }

    // --- データ記録 ---
    // 記録中は描画品質の段を固定する (1 本のデータセットの中で条件を変えない)
    this.renderer.qualityHold = this.recorder.recording;
    if (!this.state.paused) {
      this.recorder.update(dt, snapshot, this.renderer.sensor.camera);
    }

    // --- HUD ---
    if (this.state.showHud) {
      const q = this.renderer;
      this.hud.update(snapshot, {
        fps: this.fps,
        quality: q.autoQuality && q.qualityLevel > 0
          ? ` (品質 L${q.qualityLevel}${q.qualityHold ? ' 固定' : ''})` : '',
        perf: this.perfInfo,
        modeLabel: MODE_LABELS[this.state.flightMode] + (this.state.paused ? ' (一時停止)' : ''),
        recording: this.recorder.recording,
        frames: this.recorder.frameCount,
        maxFrames: this.recorder.config.maxFrames,
        cameraInfo: this.cameraInfo,
      });
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    window.app = new App();
  } catch (err) {
    console.error(err);
    const el = document.getElementById('toast');
    if (el) {
      el.textContent = `初期化に失敗しました: ${err.message}`;
      el.classList.add('show', 'error');
    }
    throw err;
  }
});

export { App, THREE, AIR_PRESETS, ROOM_PRESETS, BUILDING_PRESETS, qToEuler, RAD };
