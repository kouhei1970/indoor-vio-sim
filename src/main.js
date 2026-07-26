/**
 * アプリケーション本体。
 * 物理シミュレータ・描画・UI・入力・データ記録を接続する。
 */

import * as THREE from 'three';
import { Simulator } from './core/simulator.js';
import { CollisionWorld } from './core/collision.js';
import { buildVehicle, SIM_DEFAULTS, deepMerge, clone } from './config/vehicle.js';
import { ENV_DEFAULTS, ROOM_PRESETS } from './config/rooms.js';
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
    this.renderer.clearTrail();
    this.sim.controller.targetPos = { ...this.sim.state.p };
    this.updatePerf();
  }

  rebuildRoom() {
    this.renderer.buildRoom(this.env);
    this.sim.trajectory.setRoom(this.world.room);
    this.renderer.setPath(this.sim.trajectory.polyline());
    // 部屋が変わったら安全な初期位置へ
    const h = this.vehicle.parts.landingGear.enabled
      ? this.vehicle.parts.landingGear.height + 0.05 : 0.06;
    this.sim.reset({ position: v3(0, h, 0) });
    this.sim.setMode(this.state.flightMode);
    this.sim.controller.targetPos = { ...this.sim.state.p };
    this.renderer.clearTrail();
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

  toggleTakeoff() {
    const target = this.sim.controller.targetPos || { ...this.sim.state.p };
    const cruise = Math.min(this.env.size.height - 0.5, 1.2);
    if (this.sim.state.p.y < cruise * 0.5) {
      this.sim.controller.targetPos = { x: target.x, y: cruise, z: target.z };
    } else {
      this.sim.controller.targetPos = { x: this.sim.state.p.x, y: 0.02, z: this.sim.state.p.z };
    }
  }

  setMotorFailure(index) {
    const n = this.sim.rotors.length;
    for (let i = 0; i < n; i++) this.sim.setMotorFailure(i, false);
    if (index >= 0 && index < n) this.sim.setMotorFailure(index, true);
  }

  resetSim() {
    const h = this.vehicle.parts.landingGear.enabled
      ? this.vehicle.parts.landingGear.height + 0.05 : 0.06;
    this.sim.reset({ position: v3(0, h, 0) });
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

  animate() {
    requestAnimationFrame(() => this.animate());
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
    if (!this.state.paused) {
      this.recorder.update(dt, snapshot, this.renderer.sensor.camera);
    }

    // --- HUD ---
    if (this.state.showHud) {
      this.hud.update(snapshot, {
        fps: this.fps,
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

export { App, THREE, AIR_PRESETS, ROOM_PRESETS, qToEuler, RAD };
