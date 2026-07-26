/**
 * シーン全体の描画管理。
 *
 *  - PBR + ACES トーンマッピング + ソフトシャドウ + IBL (RoomEnvironment)
 *  - 外部視点カメラ (自由/追従/俯瞰) と機体搭載カメラの切り替え
 *  - 機体搭載カメラのピクチャ・イン・ピクチャ表示
 *  - 軌道 (目標経路) と飛行履歴の可視化
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoomBuilder } from './roomBuilder.js';
import { BuildingBuilder } from './buildingBuilder.js';
import { DroneBuilder } from './droneBuilder.js';
import { CameraSensor } from './cameraSensor.js';

export const VIEW_MODES = {
  orbit: '自由視点',
  chase: '追従 (三人称)',
  onboard: '機体カメラ',
  top: '俯瞰',
  cockpit: 'コックピット',
};

export class SceneRenderer {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.world = world;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d10);

    // 間接光 (イメージベースドライティング)
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.05;   // 間接光は控えめに (照明との合計で適正露出になるよう較正)
    pmrem.dispose();

    // 外部視点カメラ
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 300);
    this.camera.position.set(3.5, 2.4, 4.5);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 1, 0);

    this.roomBuilder = new RoomBuilder(this.scene, world);
    this.buildingBuilder = new BuildingBuilder(this.scene, world);
    // 単室と建物は排他。実際に使っている方を activeBuilder が指す。
    this.activeBuilder = this.roomBuilder;
    this.droneBuilder = new DroneBuilder();
    this.scene.add(this.droneBuilder.group);

    this.sensor = new CameraSensor(this.renderer);
    this.droneBuilder.cameraMount.add(this.sensor.camera);
    // three.js のカメラは -z を向くので、機体前方 (-z) と一致する
    this.sensor.camera.rotation.set(0, 0, 0);

    this.viewMode = 'orbit';
    this.showPiP = true;
    this.pipScale = 0.28;
    // 機体カメラの更新レート [Hz]。描画負荷を抑えるため画面の更新とは分けている。
    this.sensorRate = 30;
    this.sensorAccum = 0;
    // 機体カメラに自機を写すか。既定では写さない (筐体の内側が見えてしまうため)。
    // 影は光源側で計算されるので、写さなくても自機の影は地面に落ちる。
    this.selfVisibleToCamera = false;
    // レイヤー構成
    //   0: シーン本体 (部屋・家具) — すべてのカメラから見える
    //   1: 自機のモデル            — 外部視点のみ (既定)
    //   2: 補助表示 (軌道・履歴・当たり判定) — 外部視点のみ。
    //      データセットの画像に線が写り込まないよう、機体カメラからは必ず除外する。
    this.DRONE_LAYER = 1;
    this.OVERLAY_LAYER = 2;
    this.camera.layers.enable(this.DRONE_LAYER);
    this.camera.layers.enable(this.OVERLAY_LAYER);
    this.sensor.camera.layers.disable(this.DRONE_LAYER);
    this.sensor.camera.layers.disable(this.OVERLAY_LAYER);

    this.buildOverlays();
    this.prevCamMatrix = new THREE.Matrix4();
    this.hasPrevCam = false;
  }

  /* ------------------------------------------------------------ */
  /* オーバーレイ (軌道・履歴・当たり判定)                            */
  /* ------------------------------------------------------------ */

  buildOverlays() {
    this.overlay = new THREE.Group();
    this.overlay.name = 'overlay';
    this.scene.add(this.overlay);

    // 目標軌道
    this.pathGeometry = new THREE.BufferGeometry();
    this.pathLine = new THREE.Line(this.pathGeometry,
      new THREE.LineBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.75 }));
    this.pathLine.frustumCulled = false;
    this.overlay.add(this.pathLine);

    // 飛行履歴
    this.trailPositions = new Float32Array(30000 * 3);
    this.trailCount = 0;
    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trailGeometry.setDrawRange(0, 0);
    this.trailLine = new THREE.Line(this.trailGeometry,
      new THREE.LineBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.9 }));
    this.trailLine.frustumCulled = false;
    this.overlay.add(this.trailLine);

    // 目標位置マーカー (大きさは機体の寸法に合わせて buildDrone で調整する)
    this.targetMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.45 }));
    this.targetMarker.scale.setScalar(0.03);
    this.overlay.add(this.targetMarker);

    // PiP 表示用
    this.pipScene = new THREE.Scene();
    this.pipCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.pipMaterial = new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false });
    this.pipQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.pipMaterial);
    this.pipQuad.frustumCulled = false;
    this.pipScene.add(this.pipQuad);

    this.applyOverlayLayer();
  }

  /** 補助表示を機体カメラから除外する */
  applyOverlayLayer() {
    this.overlay.traverse((o) => o.layers.set(this.OVERLAY_LAYER));
  }

  setPath(points) {
    if (!points || points.length < 2) {
      this.pathLine.visible = false;
      return;
    }
    this.pathLine.visible = true;
    const arr = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
    });
    this.pathGeometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.pathGeometry.computeBoundingSphere();
  }

  clearTrail() {
    this.trailCount = 0;
    this.trailGeometry.setDrawRange(0, 0);
  }

  pushTrail(p) {
    const max = this.trailPositions.length / 3;
    if (this.trailCount >= max) {
      // 古い点を捨てて詰める
      this.trailPositions.copyWithin(0, 3000);
      this.trailCount -= 1000;
    }
    const i = this.trailCount * 3;
    this.trailPositions[i] = p.x;
    this.trailPositions[i + 1] = p.y;
    this.trailPositions[i + 2] = p.z;
    this.trailCount++;
    this.trailGeometry.attributes.position.needsUpdate = true;
    this.trailGeometry.setDrawRange(0, this.trailCount);
  }

  /* ------------------------------------------------------------ */

  /**
   * 環境を作り直す。env.mode で単室 (room) と建物 (building) を切り替える。
   * どちらのビルダも world.clearObstacles() を呼ぶので、
   * 使わない方は先に clear() してメッシュを消しておく。
   */
  buildRoom(env) {
    const next = env.mode === 'building' ? this.buildingBuilder : this.roomBuilder;
    if (this.activeBuilder && this.activeBuilder !== next) this.activeBuilder.clear();
    this.activeBuilder = next;
    next.build(env);

    const s = next.size;
    const spawn = this.spawnPoint();
    this.controls.target.set(spawn.x, Math.min(1.2, s.height / 2), spawn.z);
    // 建物は大きいので、外形から見渡せる距離に引く
    const d = Math.max(s.width, s.depth);
    this.camera.position.set(spawn.x + d * 0.45, Math.max(s.height * 0.55, 2.2), spawn.z + d * 0.5);
    this.camera.far = Math.max(300, d * 4);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.showColliders(env.showColliders);
  }

  /** 機体の初期位置。単室なら原点、建物ならビルダに聞く。 */
  spawnPoint() {
    const b = this.activeBuilder;
    return b && b.spawnPoint ? b.spawnPoint() : { x: 0, y: 0, z: 0 };
  }

  buildDrone(vehicle, com) {
    this.droneBuilder.build(vehicle, com);
    this.applySelfVisibility();
    // 目標位置マーカーが機体より大きく見えないよう、機体寸法に比例させる
    const r = Math.min(Math.max(vehicle.frame.armLength * 0.22, 0.006), 0.07);
    this.targetMarker.scale.setScalar(r);
    // カメラマウントの位置が変わるのでセンサを付け直す
    if (this.sensor.camera.parent !== this.droneBuilder.cameraMount) {
      this.droneBuilder.cameraMount.add(this.sensor.camera);
    }
  }

  /** 自機を機体カメラに写すかどうかをレイヤーで切り替える */
  applySelfVisibility() {
    const layer = this.selfVisibleToCamera ? 0 : this.DRONE_LAYER;
    this.droneBuilder.group.traverse((o) => {
      o.layers.set(layer);
      // 影は常に落とす (レイヤーはカメラの可視判定にのみ影響する)
    });
    this.sensor.camera.layers.set(0);
    if (this.selfVisibleToCamera) this.sensor.camera.layers.enable(this.DRONE_LAYER);
    this.camera.layers.enable(this.DRONE_LAYER);
    this.camera.layers.enable(this.OVERLAY_LAYER);
  }

  showColliders(show) {
    if (this.colliderHelper) {
      this.overlay.remove(this.colliderHelper);
      this.colliderHelper.geometry.dispose();
      this.colliderHelper.material.dispose();
      this.colliderHelper = null;
    }
    if (!show) return;
    const geo = new THREE.BufferGeometry();
    const verts = [];
    for (const b of this.world.boxes) {
      const { center, half, cos, sin } = b;
      const corners = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const lx = sx * half.x, ly = sy * half.y, lz = sz * half.z;
        corners.push([
          center.x + lx * cos - lz * sin,
          center.y + ly,
          center.z + lx * sin + lz * cos,
        ]);
      }
      const edges = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
      for (const [a, c] of edges) verts.push(...corners[a], ...corners[c]);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.colliderHelper = new THREE.LineSegments(geo,
      new THREE.LineBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 0.5 }));
    this.colliderHelper.frustumCulled = false;
    this.colliderHelper.layers.set(this.OVERLAY_LAYER);
    this.overlay.add(this.colliderHelper);
  }

  /** 機体の姿勢をシーンへ反映する */
  syncDrone(state) {
    const g = this.droneBuilder.group;
    g.position.set(state.p.x, state.p.y, state.p.z);
    g.quaternion.set(state.q.x, state.q.y, state.q.z, state.q.w);
    g.updateMatrixWorld(true);
  }

  /** 外部視点カメラを更新する */
  updateViewCamera(state, dt) {
    const g = this.droneBuilder.group;
    const pos = new THREE.Vector3(state.p.x, state.p.y, state.p.z);
    switch (this.viewMode) {
      case 'chase': {
        const back = new THREE.Vector3(0, 0.55, 1.9).applyQuaternion(
          new THREE.Quaternion(0, g.quaternion.y, 0, g.quaternion.w).normalize());
        const want = pos.clone().add(back);
        this.camera.position.lerp(want, Math.min(1, dt * 4));
        this.controls.target.lerp(pos, Math.min(1, dt * 6));
        this.controls.update();
        break;
      }
      case 'top': {
        const h = this.activeBuilder?.size ? this.activeBuilder.size.height * 1.6 : 6;
        this.camera.position.lerp(new THREE.Vector3(pos.x, h, pos.z + 0.01), Math.min(1, dt * 3));
        this.controls.target.lerp(pos, Math.min(1, dt * 5));
        this.controls.update();
        break;
      }
      case 'cockpit': {
        // 機体後方 30cm から見る (操縦しやすい視点)
        const off = new THREE.Vector3(0, 0.12, 0.35).applyQuaternion(g.quaternion);
        this.camera.position.copy(pos).add(off);
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.quaternion);
        this.controls.target.copy(pos).add(fwd.multiplyScalar(3));
        this.controls.update();
        break;
      }
      case 'orbit':
      default:
        this.controls.update();
    }
  }

  setSize(width, height) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.width = width;
    this.height = height;
  }

  /**
   * 1 フレーム描画する。
   * @param {object} state 機体状態
   * @param {object} opts {time, dt, speeds, captureOnboard}
   */
  render(state, opts) {
    const { time = 0, dt = 0.016, speeds = [] } = opts;
    this.droneBuilder.update(dt, speeds, time);
    this.activeBuilder.update(time);
    this.syncDrone(state);
    this.updateViewCamera(state, dt);

    // シャドウマップは 1 フレームに 1 回だけ更新する。
    // 更新は必ず外部視点カメラで行う: three.js は影を落とす物体を
    // 「描画中のカメラのレイヤー」で選別するため、機体カメラで更新すると
    // (機体カメラから見えない) 自機の影が消えてしまう。
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;

    const onboardFull = this.viewMode === 'onboard';
    const needSensor = this.showPiP || onboardFull || opts.forceOnboard;

    // --- メイン描画 (先に描いてシャドウマップを確定させる) ---
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, this.width, this.height);
    this.renderer.setScissorTest(false);
    if (onboardFull) {
      // 一人称表示でも影の計算だけは外部視点カメラで行いたいので、
      // ごく小さな領域に外部視点を描いてシャドウマップを更新する
      this.renderer.setScissor(0, 0, 2, 2);
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(0, 0, 2, 2);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.width, this.height);
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    // --- 機体カメラ ---
    // 必要なとき (PiP 表示 / 一人称視点 / データ記録) だけ、指定レートで描画する
    this.sensorAccum += dt;
    const sensorPeriod = 1 / Math.max(1, this.sensorRate);
    if (needSensor && (this.sensorAccum >= sensorPeriod || opts.forceOnboard || !this.hasPrevCam)) {
      this.sensorAccum = 0;
      this.sensor.camera.updateMatrixWorld(true);
      const prev = this.hasPrevCam ? this.prevCamMatrix.clone() : null;
      this.sensor.render(this.scene, time, prev, Math.max(dt, sensorPeriod));
      this.prevCamMatrix.copy(this.sensor.camera.matrixWorld);
      this.hasPrevCam = true;
    }
    const sensorTarget = needSensor && this.hasPrevCam ? this.sensor.rtOut : null;

    // --- 機体カメラ映像の合成 ---
    this.renderer.setRenderTarget(null);
    if (onboardFull && sensorTarget) {
      const ar = this.sensor.intrinsics.width / this.sensor.intrinsics.height;
      const screenAr = this.width / this.height;
      let w = this.width, h = this.height;
      if (screenAr > ar) w = this.height * ar; else h = this.width / ar;
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
      this.drawTexture(sensorTarget.texture, (this.width - w) / 2, (this.height - h) / 2, w, h);
    } else if (this.showPiP && sensorTarget) {
      const pw = Math.round(this.width * this.pipScale);
      const ph = Math.round(pw * this.sensor.intrinsics.height / this.sensor.intrinsics.width);
      this.drawTexture(sensorTarget.texture, this.width - pw - 16, 16, pw, ph, true);
    }
    return sensorTarget;
  }

  /** テクスチャを画面の指定領域へ描画する (左下原点) */
  drawTexture(texture, x, y, w, h, border = false) {
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    if (border) {
      r.setViewport(x - 2, y - 2, w + 4, h + 4);
      r.setScissor(x - 2, y - 2, w + 4, h + 4);
      r.setScissorTest(true);
      this.pipMaterial.map = null;
      this.pipMaterial.color.set(0x36d399);
      r.render(this.pipScene, this.pipCamera);
      this.pipMaterial.color.set(0xffffff);
    }
    r.setViewport(x, y, w, h);
    r.setScissor(x, y, w, h);
    r.setScissorTest(true);
    this.pipMaterial.map = texture;
    this.pipMaterial.needsUpdate = true;
    r.render(this.pipScene, this.pipCamera);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    r.autoClear = prevAutoClear;
  }

  dispose() {
    this.sensor.dispose();
    this.roomBuilder.clear();
    this.buildingBuilder.clear();
    this.droneBuilder.dispose();
    this.renderer.dispose();
  }
}
