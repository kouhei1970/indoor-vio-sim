/**
 * パラメータ編集 UI (lil-gui)。
 *
 * 機体・環境・カメラ・飛行・記録のすべての設定をここから変更できる。
 * 値を変えると必要な部分だけ再構築される (機体形状を変えたら
 * メッシュと慣性テンソルの両方が作り直される)。
 */

import GUI from 'lil-gui';
import { PRESETS, PRESET_KEYS, PART_SHAPES, buildVehicle } from '../config/vehicle.js';
import { LAYOUTS } from '../core/airframe.js';
import { ROOM_PRESETS, ROOM_KEYS, LIGHTING_PRESETS, LIGHTING_KEYS } from '../config/rooms.js';
import { CAMERA_PRESETS } from '../render/cameraSensor.js';
import { PATTERNS, YAW_MODES } from '../core/trajectory.js';
import { AIR_PRESETS } from '../core/aero.js';
import { VIEW_MODES } from '../render/renderer.js';

const nameMap = (obj, labelKey = 'label') => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[v[labelKey] || v.name || k] = k;
  return out;
};

const listMap = (arr, labels = {}) => {
  const out = {};
  for (const k of arr) out[labels[k] || k] = k;
  return out;
};

export function createGui(app, container) {
  const gui = new GUI({ container, title: '設定', width: 320 });
  gui.domElement.classList.add('sim-gui');

  const rebuildVehicle = () => app.rebuildVehicle();
  const rebuildRoom = () => app.rebuildRoom();
  const applyCamera = () => app.applyCamera();
  const applyTrajectory = () => app.applyTrajectory();

  /* ============================================================ */
  /* 機体                                                          */
  /* ============================================================ */
  const fVehicle = gui.addFolder('機体');
  const presetLabels = {};
  for (const k of PRESET_KEYS) presetLabels[PRESETS[k].name || k] = k;
  fVehicle.add(app.state, 'vehiclePreset', presetLabels).name('プリセット')
    .onChange((key) => {
      app.vehicle = buildVehicle(key);
      app.rebuildVehicle();
      rebuildGuiVehicle();
    });

  const vehicleFolders = [];
  const clearVehicleFolders = () => {
    for (const f of vehicleFolders) f.destroy();
    vehicleFolders.length = 0;
  };

  function rebuildGuiVehicle() {
    clearVehicleFolders();
    const v = app.vehicle;

    /* --- フレーム --- */
    const fFrame = fVehicle.addFolder('フレーム');
    vehicleFolders.push(fFrame);
    fFrame.add(v.frame, 'layout', nameMap(LAYOUTS)).name('配置').onChange(rebuildVehicle);
    fFrame.add(v.frame, 'armLength', 0.02, 0.6, 0.001).name('アーム長 [m]').onChange(rebuildVehicle);
    fFrame.add(v.frame, 'motorHeight', -0.05, 0.1, 0.001).name('モータ高さ [m]').onChange(rebuildVehicle);
    fFrame.add(v.frame, 'rotorCant', -15, 15, 0.5).name('ロータ傾斜 [deg]').onChange(rebuildVehicle);
    fFrame.add(v.frame, 'yawOffset', -90, 90, 1).name('配置回転 [deg]').onChange(rebuildVehicle);
    fFrame.add(v.frame, 'reverseSpin').name('回転方向を反転').onChange(rebuildVehicle);
    fFrame.add(v, 'massMode', { 'パーツ合計': 'auto', '総質量を指定': 'manual' })
      .name('質量の決め方').onChange(rebuildVehicle);
    fFrame.add(v, 'totalMass', 0.01, 10, 0.001).name('総質量 [kg]').onChange(rebuildVehicle);

    /* --- 各パーツ --- */
    const partDefs = [
      ['body', 'ボディ', (f, p) => {
        f.add(p, 'shape', PART_SHAPES.body).name('形状').onChange(rebuildVehicle);
        f.add(p.size, 'x', 0.01, 0.5, 0.001).name('幅 [m]').onChange(rebuildVehicle);
        f.add(p.size, 'y', 0.005, 0.3, 0.001).name('高さ [m]').onChange(rebuildVehicle);
        f.add(p.size, 'z', 0.01, 0.5, 0.001).name('奥行 [m]').onChange(rebuildVehicle);
        f.add(p, 'mass', 0.001, 3, 0.001).name('質量 [kg]').onChange(rebuildVehicle);
        addMaterial(f, p.material, '本体');
        f.add(p, 'accent').name('アクセント形状').onChange(rebuildVehicle);
        addMaterial(f, p.accentMaterial, 'アクセント');
      }],
      ['arm', 'アーム', (f, p) => {
        f.add(p, 'shape', PART_SHAPES.arm).name('形状').onChange(rebuildVehicle);
        f.add(p, 'thickness', 0.002, 0.05, 0.0005).name('太さ [m]').onChange(rebuildVehicle);
        f.add(p, 'width', 0.002, 0.06, 0.0005).name('幅 [m]').onChange(rebuildVehicle);
        f.add(p, 'mass', 0.0001, 0.5, 0.0001).name('質量/本 [kg]').onChange(rebuildVehicle);
        addMaterial(f, p.material, 'アーム');
      }],
      ['motor', 'モータ', (f, p) => {
        f.add(p, 'shape', PART_SHAPES.motor).name('形状').onChange(rebuildVehicle);
        f.add(p, 'diameter', 0.004, 0.08, 0.0005).name('直径 [m]').onChange(rebuildVehicle);
        f.add(p, 'height', 0.004, 0.06, 0.0005).name('高さ [m]').onChange(rebuildVehicle);
        f.add(p, 'mass', 0.0005, 0.5, 0.0005).name('質量/基 [kg]').onChange(rebuildVehicle);
        addMaterial(f, p.material, 'ステータ');
        addMaterial(f, p.bellMaterial, 'ベル');
      }],
      ['prop', 'プロペラ', (f, p) => {
        f.add(p, 'shape', PART_SHAPES.prop).name('形状').onChange(rebuildVehicle);
        f.add(p, 'diameter', 0.02, 0.6, 0.001).name('直径 [m]').onChange(rebuildVehicle);
        f.add(p, 'pitch', 0.005, 0.3, 0.001).name('ピッチ [m]').onChange(rebuildVehicle);
        f.add(p, 'bladeWidth', 0.003, 0.06, 0.0005).name('翼弦長 [m]').onChange(rebuildVehicle);
        f.add(p, 'mass', 0.0001, 0.1, 0.0001).name('質量/枚 [kg]').onChange(rebuildVehicle);
        f.add(p, 'ct', 0.05, 0.2, 0.001).name('推力係数 Ct').onChange(rebuildVehicle);
        f.add(p, 'cq', 0.002, 0.03, 0.0001).name('トルク係数 Cq').onChange(rebuildVehicle);
        f.add(p, 'tipMarker').name('翼端マーカー').onChange(rebuildVehicle);
        addMaterial(f, p.material, 'ブレード');
        addMaterial(f, p.tipMaterial, '翼端');
      }],
      ['guard', 'プロペラガード', (f, p) => {
        f.add(p, 'enabled').name('有効').onChange(rebuildVehicle);
        f.add(p, 'shape', PART_SHAPES.guard).name('形状').onChange(rebuildVehicle);
        f.add(p, 'radiusScale', 1.0, 1.6, 0.01).name('半径倍率').onChange(rebuildVehicle);
        f.add(p, 'thickness', 0.001, 0.02, 0.0005).name('太さ [m]').onChange(rebuildVehicle);
        f.add(p, 'mass', 0.0001, 0.2, 0.0001).name('質量/個 [kg]').onChange(rebuildVehicle);
        addMaterial(f, p.material, 'ガード');
      }],
      ['landingGear', '脚', (f, p) => {
        f.add(p, 'enabled').name('有効').onChange(rebuildVehicle);
        f.add(p, 'shape', PART_SHAPES.landingGear).name('形状').onChange(rebuildVehicle);
        f.add(p, 'height', 0.005, 0.4, 0.001).name('高さ [m]').onChange(rebuildVehicle);
        f.add(p, 'spread', 0.01, 0.4, 0.001).name('広がり [m]').onChange(rebuildVehicle);
        f.add(p, 'count', 2, 6, 1).name('本数').onChange(rebuildVehicle);
        f.add(p, 'mass', 0.0005, 0.5, 0.0005).name('質量 [kg]').onChange(rebuildVehicle);
        addMaterial(f, p.material, '脚');
      }],
      ['battery', 'バッテリー', (f, p) => {
        f.add(p, 'enabled').name('有効').onChange(rebuildVehicle);
        f.add(p.size, 'x', 0.01, 0.2, 0.001).name('幅 [m]').onChange(rebuildVehicle);
        f.add(p.size, 'y', 0.005, 0.12, 0.001).name('高さ [m]').onChange(rebuildVehicle);
        f.add(p.size, 'z', 0.01, 0.3, 0.001).name('奥行 [m]').onChange(rebuildVehicle);
        f.add(p.offset, 'y', -0.15, 0.15, 0.001).name('取付高さ [m]').onChange(rebuildVehicle);
        f.add(p.offset, 'z', -0.15, 0.15, 0.001).name('前後位置 [m]').onChange(rebuildVehicle);
        f.add(p, 'mass', 0.001, 3, 0.001).name('質量 [kg]').onChange(rebuildVehicle);
        addMaterial(f, p.material, 'バッテリー');
      }],
      ['camera', 'カメラ (機体側)', (f, p) => {
        f.add(p, 'enabled').name('有効').onChange(rebuildVehicle);
        f.add(p, 'shape', PART_SHAPES.camera).name('形状').onChange(rebuildVehicle);
        f.add(p, 'size', 0.005, 0.12, 0.001).name('大きさ [m]').onChange(rebuildVehicle);
        f.add(p, 'tilt', -20, 90, 1).name('俯角 [deg] (90=真下)').onChange(rebuildVehicle);
        f.add(p.offset, 'x', -0.2, 0.2, 0.001).name('左右位置 [m]').onChange(rebuildVehicle);
        f.add(p.offset, 'y', -0.2, 0.2, 0.001).name('上下位置 [m]').onChange(rebuildVehicle);
        f.add(p.offset, 'z', -0.3, 0.3, 0.001).name('前後位置 [m]').onChange(rebuildVehicle);
        f.add(p, 'mass', 0.0005, 0.5, 0.0005).name('質量 [kg]').onChange(rebuildVehicle);
        addMaterial(f, p.material, '筐体');
        addMaterial(f, p.lensMaterial, 'レンズ');
      }],
      ['leds', 'LED', (f, p) => {
        f.add(p, 'enabled').name('有効').onChange(rebuildVehicle);
        f.addColor(p, 'frontColor').name('前方色').onChange(rebuildVehicle);
        f.addColor(p, 'rearColor').name('後方色').onChange(rebuildVehicle);
        f.add(p, 'intensity', 0, 10, 0.1).name('明るさ').onChange(rebuildVehicle);
        f.add(p, 'blink').name('点滅');
        f.add(p, 'blinkHz', 0.2, 10, 0.1).name('点滅周期 [Hz]');
      }],
    ];

    const fParts = fVehicle.addFolder('パーツ (形状・色・質量)');
    vehicleFolders.push(fParts);
    for (const [key, label, builder] of partDefs) {
      const p = v.parts[key];
      if (!p) continue;
      const f = fParts.addFolder(label);
      f.close();
      builder(f, p);
    }

    /* --- 動力系 --- */
    const fPower = fVehicle.addFolder('動力系');
    vehicleFolders.push(fPower);
    fPower.close();
    fPower.add(v.power, 'cells', 1, 12, 1).name('セル数 (S)').onChange(() => {
      v.power.voltage = v.power.cells * 3.7; rebuildVehicle(); gui.controllersRecursive().forEach((c) => c.updateDisplay());
    });
    fPower.add(v.power, 'voltage', 3, 60, 0.1).name('公称電圧 [V]').onChange(rebuildVehicle);
    fPower.add(v.power, 'kv', 100, 20000, 10).name('KV [rpm/V]').onChange(rebuildVehicle);
    fPower.add(v.power, 'capacityMah', 100, 20000, 50).name('容量 [mAh]').onChange(rebuildVehicle);
    fPower.add(v.power, 'tauUp', 0.005, 0.3, 0.001).name('モータ時定数↑ [s]').onChange(rebuildVehicle);
    fPower.add(v.power, 'tauDown', 0.005, 0.4, 0.001).name('モータ時定数↓ [s]').onChange(rebuildVehicle);
    fPower.add(v.power, 'motorVariation', 0, 0.2, 0.005).name('モータ個体差').onChange(rebuildVehicle);
    fPower.add(v.power, 'internalResistance', 0.001, 0.3, 0.001).name('内部抵抗 [Ω/cell]').onChange(rebuildVehicle);
    fPower.add(v.power, 'systemEfficiency', 0.3, 0.95, 0.01).name('システム効率').onChange(rebuildVehicle);

    /* --- 空力 --- */
    const fAero = fVehicle.addFolder('空力');
    vehicleFolders.push(fAero);
    fAero.close();
    fAero.add(v.aero, 'groundEffect').name('地面効果');
    fAero.add(v.aero, 'ceilingEffect').name('天井効果');
    fAero.add(v.aero, 'wallEffect').name('壁効果');
    fAero.add(v.aero, 'translationalLift').name('並進揚力');
    fAero.add(v.aero, 'vrs').name('ボルテックスリングステート');
    fAero.add(v.aero, 'kh', 0, 2e-4, 1e-6).name('ロータ抗力係数');
    fAero.add(v.aero, 'cdX', 0.2, 2.5, 0.05).name('抗力係数 (横)');
    fAero.add(v.aero, 'cdY', 0.2, 2.5, 0.05).name('抗力係数 (上下)');

    /* --- 制御 --- */
    const fCtrl = fVehicle.addFolder('制御');
    vehicleFolders.push(fCtrl);
    fCtrl.close();
    fCtrl.add(v.controller, 'autoTune').name('ゲイン自動調整').onChange(rebuildVehicle);
    fCtrl.add(v.controller, 'tuningScale', 0.3, 2.5, 0.05).name('応答の機敏さ').onChange(rebuildVehicle);
    fCtrl.add(v.controller, 'maxTilt', 0.05, 1.2, 0.01).name('最大傾斜 [rad]').onChange(rebuildVehicle);
    fCtrl.add(v.controller, 'maxSpeedXY', 0.2, 8, 0.1).name('最大水平速度 [m/s]').onChange(rebuildVehicle);
    fCtrl.add(v.controller, 'maxClimbRate', 0.1, 6, 0.1).name('最大上昇速度 [m/s]').onChange(rebuildVehicle);
    fCtrl.add(v.controller, 'maxYawRate', 0.2, 8, 0.1).name('最大ヨー速度 [rad/s]').onChange(rebuildVehicle);
  }

  function addMaterial(folder, m, label) {
    if (!m) return;
    const f = folder.addFolder(`${label} マテリアル`);
    f.close();
    f.addColor(m, 'color').name('色').onChange(rebuildVehicle);
    f.add(m, 'metalness', 0, 1, 0.01).name('金属度').onChange(rebuildVehicle);
    f.add(m, 'roughness', 0, 1, 0.01).name('粗さ').onChange(rebuildVehicle);
    f.add(m, 'clearcoat', 0, 1, 0.01).name('クリアコート').onChange(rebuildVehicle);
    f.addColor(m, 'emissive').name('発光色').onChange(rebuildVehicle);
    f.add(m, 'emissiveIntensity', 0, 5, 0.05).name('発光強度').onChange(rebuildVehicle);
    f.add(m, 'opacity', 0, 1, 0.01).name('不透明度').onChange(rebuildVehicle);
    f.add(m, 'transparent').name('半透明').onChange(rebuildVehicle);
  }

  rebuildGuiVehicle();

  /* ============================================================ */
  /* 環境                                                          */
  /* ============================================================ */
  const fEnv = gui.addFolder('環境');
  fEnv.close();
  const roomLabels = {};
  for (const k of ROOM_KEYS) roomLabels[ROOM_PRESETS[k].name] = k;
  fEnv.add(app.env, 'preset', roomLabels).name('部屋').onChange((key) => {
    const p = ROOM_PRESETS[key];
    app.env.size = { ...p.size };
    app.env.lighting = p.lighting;
    app.env.markerCount = p.decor.markers;
    app.env.posterCount = p.decor.posters;
    app.env.windows = p.decor.windows;
    rebuildRoom();
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  });
  fEnv.add(app.env.size, 'width', 2, 40, 0.1).name('幅 [m]').onChange(rebuildRoom);
  fEnv.add(app.env.size, 'depth', 2, 40, 0.1).name('奥行 [m]').onChange(rebuildRoom);
  fEnv.add(app.env.size, 'height', 1.8, 12, 0.1).name('天井高 [m]').onChange(rebuildRoom);
  fEnv.add(app.env, 'featureDensity', 0, 2, 0.05).name('模様の多さ').onChange(rebuildRoom);
  fEnv.add(app.env, 'furnitureDensity', 0, 3, 0.05).name('家具の量').onChange(rebuildRoom);
  fEnv.add(app.env, 'markerCount', 0, 24, 1).name('マーカー枚数').onChange(rebuildRoom);
  fEnv.add(app.env, 'posterCount', 0, 20, 1).name('ポスター枚数').onChange(rebuildRoom);
  fEnv.add(app.env, 'windows', 0, 8, 1).name('窓の数').onChange(rebuildRoom);
  fEnv.add(app.env, 'seed', 1, 999, 1).name('乱数シード').onChange(rebuildRoom);

  const fLight = fEnv.addFolder('照明');
  const lightLabels = {};
  for (const k of LIGHTING_KEYS) lightLabels[LIGHTING_PRESETS[k].name] = k;
  fLight.add(app.env, 'lighting', lightLabels).name('照明条件').onChange(rebuildRoom);
  fLight.add(app.env, 'lightIntensity', 0.05, 3, 0.05).name('明るさ倍率').onChange(rebuildRoom);
  fLight.add(app.env, 'shadows').name('影を落とす').onChange(rebuildRoom);
  fLight.add(app.env, 'shadowQuality', { 低: 1024, 中: 2048, 高: 4096 }).name('影の解像度').onChange(rebuildRoom);
  fLight.add(app.state, 'exposure', 0.1, 3, 0.05).name('露出 (表示)')
    .onChange((v) => { app.renderer.renderer.toneMappingExposure = v; });
  fLight.add(app.state, 'envIntensity', 0, 2, 0.05).name('環境光の強さ')
    .onChange((v) => { app.renderer.scene.environmentIntensity = v; });

  /* ============================================================ */
  /* カメラ (センサ)                                               */
  /* ============================================================ */
  const fCam = gui.addFolder('搭載カメラ (画像生成)');
  fCam.close();
  const camLabels = {};
  for (const [k, v] of Object.entries(CAMERA_PRESETS)) camLabels[v.label] = k;
  fCam.add(app.state, 'cameraPreset', camLabels).name('プリセット').onChange((key) => {
    Object.assign(app.cameraCfg, CAMERA_PRESETS[key]);
    if (CAMERA_PRESETS[key].distortion) {
      app.cameraCfg.distortion = { ...app.cameraCfg.distortion, ...CAMERA_PRESETS[key].distortion };
    }
    applyCamera();
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
  });
  fCam.add(app.cameraCfg, 'width', 160, 1920, 16).name('横 [px]').onChange(applyCamera);
  fCam.add(app.cameraCfg, 'height', 120, 1080, 8).name('縦 [px]').onChange(applyCamera);
  fCam.add(app.cameraCfg, 'hfov', 20, 160, 1).name('水平画角 [deg]').onChange(applyCamera);
  fCam.add(app.cameraCfg, 'supersample', 1, 3, 0.25).name('スーパーサンプリング').onChange(applyCamera);

  const fDist = fCam.addFolder('レンズ歪み');
  fDist.add(app.cameraCfg.distortion, 'k1', -0.6, 0.4, 0.005).name('k1 (半径方向)').onChange(applyCamera);
  fDist.add(app.cameraCfg.distortion, 'k2', -0.3, 0.4, 0.005).name('k2').onChange(applyCamera);
  fDist.add(app.cameraCfg.distortion, 'p1', -0.01, 0.01, 0.0001).name('p1 (接線方向)').onChange(applyCamera);
  fDist.add(app.cameraCfg.distortion, 'p2', -0.01, 0.01, 0.0001).name('p2').onChange(applyCamera);

  const fSensor = fCam.addFolder('センサ特性');
  fSensor.add(app.cameraCfg, 'vignette', 0, 1, 0.01).name('周辺減光').onChange(applyCamera);
  fSensor.add(app.cameraCfg, 'chromatic', 0, 0.01, 0.0002).name('色収差').onChange(applyCamera);
  fSensor.add(app.cameraCfg, 'shotNoise', 0, 0.1, 0.001).name('ショットノイズ').onChange(applyCamera);
  fSensor.add(app.cameraCfg, 'readNoise', 0, 0.05, 0.001).name('読み出しノイズ').onChange(applyCamera);
  fSensor.add(app.cameraCfg, 'grain', 0, 0.05, 0.001).name('固定パターンノイズ').onChange(applyCamera);
  fSensor.add(app.cameraCfg, 'exposure', 0.1, 4, 0.05).name('露出').onChange(applyCamera);
  fSensor.add(app.cameraCfg, 'contrast', 0.4, 2, 0.02).name('コントラスト').onChange(applyCamera);
  fSensor.add(app.cameraCfg, 'saturation', 0, 2, 0.02).name('彩度').onChange(applyCamera);
  fSensor.add(app.cameraCfg, 'rollingShutter', 0, 0.1, 0.002).name('ローリングシャッタ').onChange(applyCamera);

  const fBlur = fCam.addFolder('モーションブラー');
  fBlur.add(app.cameraCfg, 'motionBlur').name('有効').onChange(applyCamera);
  fBlur.add(app.cameraCfg, 'blurSamples', 2, 16, 1).name('サンプル数').onChange(applyCamera);
  fBlur.add(app.cameraCfg, 'exposureTime', 0.0005, 0.05, 0.0005).name('シャッター速度 [s]').onChange(applyCamera);
  fCam.add(app.cameraCfg, 'depth').name('深度も生成').onChange(applyCamera);

  /* ============================================================ */
  /* 飛行                                                          */
  /* ============================================================ */
  const fFlight = gui.addFolder('飛行');
  fFlight.add(app.state, 'flightMode', {
    '位置保持 (position)': 'position',
    '自動飛行 (auto)': 'auto',
    '高度保持 (altitude)': 'altitude',
    '姿勢 (angle)': 'angle',
    'アクロ (rate)': 'rate',
  }).name('モード').onChange((m) => app.setFlightMode(m)).listen();

  const fTraj = fFlight.addFolder('自動飛行の軌道');
  const patternLabels = {
    hover: 'ホバリング', waypoints: 'ウェイポイント', lawnmower: '往復スキャン',
    spiral: '螺旋', orbit: '周回 (注視点あり)', figure8: '8 の字',
    perimeter: '壁沿い一周', random: 'ランダムウォーク',
  };
  fTraj.add(app.sim.trajectory.cfg, 'pattern', listMap(PATTERNS, patternLabels))
    .name('パターン').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'yawMode', listMap(YAW_MODES, {
    fixed: '固定', 'along-path': '進行方向', 'look-at': '注視点を向く', sweep: '連続旋回',
  })).name('機首の向き').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'speed', 0.05, 4, 0.05).name('速度 [m/s]').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'altitude', 0.2, 8, 0.05).name('高度 [m]').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'rows', 2, 20, 1).name('往復回数').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'turns', 1, 8, 0.5).name('周回数').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'radius', 0.2, 8, 0.1).name('半径 [m]').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'climb', 0, 4, 0.05).name('高度変化 [m]').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'margin', 0.3, 4, 0.05).name('壁からの余裕 [m]').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'yawRate', -2, 2, 0.05).name('旋回速度 [rad/s]').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg, 'loop').name('周回する').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg.lookAt, 'x', -10, 10, 0.1).name('注視点 X').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg.lookAt, 'y', 0, 6, 0.1).name('注視点 Y').onChange(applyTrajectory);
  fTraj.add(app.sim.trajectory.cfg.lookAt, 'z', -10, 10, 0.1).name('注視点 Z').onChange(applyTrajectory);

  /* ============================================================ */
  /* シミュレーション                                              */
  /* ============================================================ */
  const fSim = gui.addFolder('シミュレーション');
  fSim.close();
  fSim.add(app.simCfg, 'timeScale', 0.05, 3, 0.05).name('時間倍率');
  fSim.add(app.simCfg, 'physicsRate', 100, 2000, 50).name('物理レート [Hz]');
  fSim.add(app.simCfg, 'controlRate', 50, 1000, 10).name('制御レート [Hz]');
  fSim.add(app.simCfg, 'integrator', { 'RK4 (高精度)': 'rk4', 'オイラー (高速)': 'euler' }).name('積分法');
  fSim.add(app.simCfg, 'useEstimatedState').name('推定値で制御 (ノイズ有)');
  fSim.add(app.state, 'airPreset', nameMap(AIR_PRESETS)).name('大気条件')
    .onChange((k) => app.sim.setAir(AIR_PRESETS[k]));

  const fWind = fSim.addFolder('室内気流');
  fWind.add(app.simCfg.wind, 'enabled').name('有効');
  fWind.add(app.simCfg.wind, 'speed', 0, 4, 0.05).name('定常風 [m/s]');
  fWind.add(app.simCfg.wind, 'direction', 0, 360, 5).name('風向 [deg]');
  fWind.add(app.simCfg.wind, 'turbulence', 0, 2, 0.02).name('乱流強度');
  fWind.add(app.simCfg.wind, 'turbulenceTimeConstant', 0.1, 5, 0.1).name('乱流の時定数 [s]');

  const fFault = fSim.addFolder('故障注入');
  app.state.failedMotor = -1;
  fFault.add(app.state, 'failedMotor', -1, 7, 1).name('停止させるロータ (-1=なし)')
    .onChange((i) => app.setMotorFailure(Math.round(i)));

  /* ============================================================ */
  /* 記録                                                          */
  /* ============================================================ */
  const fRec = gui.addFolder('データセット記録');
  fRec.add(app.recorder.config, 'fps', 1, 60, 1).name('記録レート [fps]');
  fRec.add(app.recorder.config, 'maxFrames', 10, 5000, 10).name('最大枚数');
  fRec.add(app.recorder.config, 'imageFormat', { PNG: 'png', JPEG: 'jpeg' }).name('画像形式');
  fRec.add(app.recorder.config, 'saveDepth').name('深度も保存').onChange((v) => {
    app.cameraCfg.depth = v; applyCamera();
  });
  fRec.add(app.recorder.config, 'saveImu').name('IMU も保存');
  fRec.add(app.recorder.config, 'name').name('データセット名');
  fRec.add(app, 'toggleRecording').name('記録 開始 / 停止');
  fRec.add(app, 'exportDataset').name('ZIP で書き出し');

  /* ============================================================ */
  /* 表示                                                          */
  /* ============================================================ */
  const fView = gui.addFolder('表示');
  fView.add(app.state, 'viewMode', Object.fromEntries(
    Object.entries(VIEW_MODES).map(([k, v]) => [v, k])))
    .name('視点').onChange((m) => { app.renderer.viewMode = m; }).listen();
  fView.add(app.renderer, 'showPiP').name('カメラ映像を重ねる');
  fView.add(app.renderer, 'pipScale', 0.12, 0.6, 0.01).name('カメラ映像の大きさ');
  fView.add(app.renderer, 'sensorRate', 5, 120, 5).name('カメラ更新レート [Hz]');
  fView.add(app.renderer, 'selfVisibleToCamera').name('自機を映す (機体カメラ)')
    .onChange(() => app.renderer.applySelfVisibility());
  fView.add(app.state, 'showPath').name('目標軌道を表示')
    .onChange((v) => { app.renderer.pathLine.visible = v; });
  fView.add(app.state, 'showTrail').name('飛行履歴を表示')
    .onChange((v) => { app.renderer.trailLine.visible = v; });
  fView.add(app.env, 'showColliders').name('当たり判定を表示')
    .onChange((v) => app.renderer.showColliders(v));
  fView.add(app.state, 'showHud').name('計器表示')
    .onChange((v) => app.hud.setVisible(v));

  /* ============================================================ */
  /* 保存・読み込み                                                */
  /* ============================================================ */
  const fIo = gui.addFolder('設定の保存 / 読み込み');
  fIo.close();
  fIo.add(app, 'saveConfig').name('設定を JSON で保存');
  fIo.add(app, 'loadConfig').name('設定を読み込む');
  fIo.add(app, 'resetSim').name('機体をリセット');

  return { gui, refresh: () => gui.controllersRecursive().forEach((c) => c.updateDisplay()), rebuildGuiVehicle };
}
