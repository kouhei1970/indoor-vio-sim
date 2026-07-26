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

/**
 * 描画品質の段 (自動調整で上下する)。
 *
 * 建物の規模や画面の大きさに関係なく目標 fps を守るために、描画コストの
 * 大きいものから順に上限を掛けていく。数値はすべて「上限」で、利用者が
 * GUI で設定した値より小さいほうが使われる。段 0 は上限なし = 設定のまま。
 *
 *   height     : 描画バッファの高さ [px] の上限。コストは概ねこの 2 乗
 *   lights     : 同時に点ける天井灯の数
 *   shadowRate : 影の焼き直しレート [Hz]
 *   blur       : モーションブラーの枚数 (機体カメラ)
 *   sensorRate : 機体カメラの更新レート [Hz]
 *
 * height は「利用者の設定に対する比率」ではなく**絶対値の上限**にしてある。
 * 比率だと元の設定が大きいときに下限が下がりきらず、目標 fps を保証できない。
 * 最下段 (240px x 4 灯) のコストは 720px x 32 灯の概ね 1/80 なので、
 * WebGL が動く環境ならまず 30fps に届く。
 *
 * 見た目の影響が小さいもの (影の間引き・ブラー枚数) から先に落とし、
 * いちばん目につく解像度は後回しにしてある。
 */
export const QUALITY_LEVELS = [
  { height: Infinity, lights: Infinity, shadowRate: Infinity, blur: Infinity, sensorRate: Infinity },
  { height: 720, lights: 16, shadowRate: 8, blur: 4, sensorRate: 30 },
  { height: 600, lights: 12, shadowRate: 8, blur: 3, sensorRate: 20 },
  { height: 480, lights: 10, shadowRate: 5, blur: 2, sensorRate: 15 },
  { height: 400, lights: 8, shadowRate: 4, blur: 1, sensorRate: 15 },
  { height: 320, lights: 6, shadowRate: 3, blur: 1, sensorRate: 10 },
  { height: 240, lights: 4, shadowRate: 2, blur: 1, sensorRate: 10 },
];

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
    // 描画解像度の決め方。
    //
    // 前方レンダリングでは光源をすべての画素で評価するので、画素数が
    // そのまま描画コストになる。ウィンドウを広げたぶんだけ重くなるのを
    // 避けたいので、既定では「画面上の大きさに関係なく、描画バッファの
    // 高さを renderHeight [px] に固定する」方式にしてある。
    // 縦横比は画面に合わせる (歪ませない) ので、コストは画面をどれだけ
    // 大きくしても変わらない。canvas は CSS で引き伸ばして表示される。
    //
    //   'fixed'   : 高さ renderHeight [px] に固定 (画面の DPI も無視する)
    //   'display' : 画面上の大きさ x 画素比 (従来の方式)
    this.resolutionMode = 'fixed';
    this.renderHeight = 720;
    // 'display' のときの画素比の上限。高 DPI の画面では devicePixelRatio が
    // 2 になり、画素数は 4 倍 = コストも約 4 倍になる。
    this.maxPixelRatio = 1.5;
    this.displayWidth = 1;
    this.displayHeight = 1;
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

    // 影の更新レート [Hz]。
    // 部屋も建物も静止していて、動くのは機体だけなので、影を毎フレーム
    // 焼き直す必要はない。影のパスは主描画の 10〜50 倍のコストがあり
    // (光源ごとにシーン全体をもう一度描くため)、ここが描画負荷の大半を占める。
    // 間引いても変わるのは自機の影の追従だけで、部屋の見た目は変わらない。
    this.shadowRate = 15;
    this.shadowAccum = Infinity;   // 最初のフレームは必ず焼く
    this.shadowFrames = Infinity;  // 前回焼いてからのフレーム数

    // --- 描画品質の自動調整 ---
    //
    // 建物の規模・画面の大きさ・GPU の速さに関係なく、目標 fps を下回らない
    // ようにする閉ループ。制御量は平滑化したフレーム時間、操作量は品質段。
    //
    //   目標周期 P = 1000 / targetFps [ms]
    //   T > P        なら段を 1 つ下げる (品質を落とす)
    //   T < 0.65 * P なら段を 1 つ上げる (品質を戻す)
    //
    // 0.65 の不感帯と、段を変えた直後の待ち時間 (cooldown) でハンチングを
    // 防ぐ。それでも 1 段あたりのコスト差が大きいと「上げる → 遅い →
    // 下げる → 速い → 上げる」の極限周期に入るので、下げた段を下限として
    // 覚えておき、指数バックオフで時々だけ上の段を試し直す。
    this.autoQuality = true;
    this.targetFps = 30;
    this.qualityLevel = 0;
    this.frameMs = 1000 / 60;      // 平滑化したフレーム時間 [ms]
    this.qualityCooldown = 0;      // 段を変えてから測り直すまでの残り時間 [s]
    this.qualityFloor = 0;         // ここより上の品質へは戻さない (段の番号の下限)
    this.qualityRetryDelay = 10;   // 上の段を試し直す間隔 [s] (失敗のたび倍)
    this.qualityRetry = 10;        // 次に試し直すまでの残り時間 [s]
    // 記録中は段を動かさない (1 本のデータセットの中で条件が変わらないように)
    this.qualityHold = false;

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

    // --- 既定の視点 ---
    //
    // 環境の外形に合わせて引くと、建物 (学校は幅 40m) では機体が点にしか
    // ならず、どこにいるのか分からない。機体の少し後ろ上から見る近景にする。
    // ただしそのままでは壁や天井の中に入ってしまうので、機体から視点の向きへ
    // レイを飛ばし、当たった手前で止める (当たり判定をそのまま使う)。
    const eye = { x: spawn.x, y: spawn.y + 0.35, z: spawn.z };
    this.controls.target.set(eye.x, eye.y, eye.z);
    const want = env.mode === 'building'
      ? 2.5                                              // 建物は常に近景
      : Math.min(Math.max(s.width, s.depth) * 0.5, 5.0); // 単室は部屋が入る程度
    // 斜め 4 方向を試して、いちばん空いている向きから見る。
    // 機体は階段室や部屋の隅に湧くことがあるので、決め打ちの 1 方向だと
    // 壁が近すぎて機体に寄りすぎる。
    let dir = null, dist = 0;
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i / 4) * Math.PI * 2;
      const cand = new THREE.Vector3(Math.sin(a) * 0.72, 0.5, Math.cos(a) * 0.72).normalize();
      const hit = this.world.raycast(eye, cand, want + 0.4);
      const d = hit.hit ? Math.min(want, Math.max(0.6, hit.distance - 0.3)) : want;
      if (d > dist) { dist = d; dir = cand; }
    }
    const cam = new THREE.Vector3(
      eye.x + dir.x * dist, eye.y + dir.y * dist, eye.z + dir.z * dist);

    // レイは窓やドアの開口をすり抜けるので、建物では機体のいる階の外形へ
    // 押し込む。壁の中や建物の外に視点が出るのを防ぐ。
    const f0 = next.floorInfo && next.floorInfo[0];
    if (f0) {
      const m = 0.6;
      const o = f0.outline;
      cam.x = Math.min(Math.max(cam.x, o.x0 + m), o.x1 - m);
      cam.z = Math.min(Math.max(cam.z, o.z0 + m), o.z1 - m);
      cam.y = Math.min(cam.y, f0.elevation + f0.height - 0.3);
    }
    this.camera.position.copy(cam);

    const d = Math.max(s.width, s.depth);
    this.camera.far = Math.max(300, d * 4);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.showColliders(env.showColliders);
    this.shadowAccum = Infinity;   // 形が変わったので影を焼き直す
    this.shadowFrames = Infinity;
    // 環境が変われば重さも変わるので、品質の下限と待ち時間を測り直しにする
    this.qualityFloor = 0;
    this.qualityRetryDelay = 10;
    this.qualityRetry = 3;
  }

  /** 機体の初期位置。単室なら原点、建物ならビルダに聞く。 */
  spawnPoint() {
    const b = this.activeBuilder;
    return b && b.spawnPoint ? b.spawnPoint() : { x: 0, y: 0, z: 0 };
  }

  buildDrone(vehicle, com) {
    this.droneBuilder.build(vehicle, com);
    this.applySelfVisibility();
    this.shadowAccum = Infinity;   // 形が変わったので影を焼き直す
    this.shadowFrames = Infinity;
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

  /** いま効いている品質の上限 (自動調整が切ってあれば上限なし) */
  get quality() {
    return QUALITY_LEVELS[this.autoQuality ? this.qualityLevel : 0];
  }

  /**
   * 品質段を更新する (毎フレーム呼ぶ)。
   * @param {number} dt 前フレームからの経過時間 [s]
   */
  updateQuality(dt) {
    // 1 フレームの外れ値で段を動かさないよう、時定数 tau で平滑化する。
    const tau = 0.5;
    const step = Math.min(dt, 0.5);
    this.frameMs += (step * 1000 - this.frameMs) * (1 - Math.exp(-step / tau));
    if (!this.autoQuality || this.qualityHold) return;

    // ときどき「1 つ上の品質でもう一度やってみる」。失敗するたび次の試行まで
    // の間隔を倍にする (指数バックオフ)。余裕があるうちは初期値へ戻す。
    if ((this.qualityRetry -= dt) <= 0) {
      if (this.qualityFloor > 0) {
        this.qualityFloor--;
        this.qualityRetryDelay = Math.min(120, this.qualityRetryDelay * 2);
      } else {
        this.qualityRetryDelay = 10;
      }
      this.qualityRetry = this.qualityRetryDelay;
    }
    if ((this.qualityCooldown -= dt) > 0) return;

    const period = 1000 / Math.max(1, this.targetFps);
    const last = QUALITY_LEVELS.length - 1;
    if (this.frameMs > period && this.qualityLevel < last) {
      // その段では目標に届かなかった。以後そこへは戻らない (試行まで)。
      this.qualityFloor = Math.max(this.qualityFloor, this.qualityLevel + 1);
      this.setQualityLevel(this.qualityLevel + 1, 0.5);
    } else if (this.frameMs < period * 0.65 && this.qualityLevel > this.qualityFloor) {
      this.setQualityLevel(this.qualityLevel - 1, 2.0);
    }
  }

  /**
   * 品質段を設定する。
   * @param {number} level 段 (0 = 設定のまま)
   * @param {number} cooldown 次に段を変えられるまでの待ち時間 [s]
   */
  setQualityLevel(level, cooldown = 1.0) {
    this.qualityLevel = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, Math.round(level)));
    this.qualityCooldown = cooldown;
    // 変更後の速さは未知なので、測り直すまでは目標を満たしている扱いにする
    // (古い値のまま次の判定に入って、段が一気に落ちるのを防ぐ)
    this.frameMs = (1000 / Math.max(1, this.targetFps)) * 0.8;
    this.applyResolution();
  }

  /** 実際に使う画素比 (画面の DPI と上限のうち小さいほう) */
  pixelRatio() {
    if (this.resolutionMode === 'fixed') return 1;   // 固定が目的なので DPI は見ない
    return Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
  }

  /** 描画解像度の上限を変える (GUI から) */
  setMaxPixelRatio(v) {
    this.maxPixelRatio = v;
    this.applyResolution();
  }

  /**
   * 画面上の大きさ (CSS 画素) を伝える。実際に描く画素数は
   * applyResolution() が決めるので、ここでは覚えておくだけ。
   */
  setSize(width, height) {
    this.displayWidth = Math.max(1, width);
    this.displayHeight = Math.max(1, height);
    this.applyResolution();
  }

  /**
   * 描画バッファの大きさを決めて反映する。
   *
   * 'fixed' では高さを renderHeight [px] に固定し、幅は画面の縦横比から
   * 決める (歪ませないため)。ウィンドウを広げても描く画素数は変わらないので、
   * 描画コストは画面の大きさに依存しなくなる。
   * canvas の CSS 寸法は触らない (setSize の第 3 引数 false) ので、
   * 表示はブラウザが引き伸ばして行う。
   */
  applyResolution() {
    const aspect = this.displayWidth / this.displayHeight;
    let w, h;
    const cap = this.quality.height;      // 自動調整による絶対上限 [px]
    const pr = this.pixelRatio();
    if (this.resolutionMode === 'fixed') {
      h = Math.max(64, Math.round(Math.min(this.renderHeight, cap)));
      w = Math.max(64, Math.round(h * aspect));
    } else {
      // setSize は内部で画素比を掛けるので、実バッファの高さが cap を
      // 超えないよう縮小率を先に求める。
      const s = Math.min(1, cap / Math.max(1, this.displayHeight * pr));
      w = Math.max(64, Math.round(this.displayWidth * s));
      h = Math.max(64, Math.round(this.displayHeight * s));
    }
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.width = w;
    this.height = h;
  }

  /**
   * 1 フレーム描画する。
   * @param {object} state 機体状態
   * @param {object} opts {time, dt, speeds, captureOnboard}
   */
  render(state, opts) {
    const { time = 0, dt = 0.016, speeds = [] } = opts;
    // データセット生成 (forceOnboard) では 1 フレーム = 1 枚で、実時間とは
    // 無関係に進むので、品質の自動調整は掛けない。
    const q = opts.forceOnboard ? QUALITY_LEVELS[0] : this.quality;
    if (!opts.forceOnboard) this.updateQuality(dt);
    this.droneBuilder.update(dt, speeds, time);
    this.activeBuilder.update(time);
    this.syncDrone(state);
    this.updateViewCamera(state, dt);

    // シャドウマップの更新。
    // 更新は必ず外部視点カメラで行う: three.js は影を落とす物体を
    // 「描画中のカメラのレイヤー」で選別するため、機体カメラで更新すると
    // (機体カメラから見えない) 自機の影が消えてしまう。
    //
    // 毎フレームではなく shadowRate [Hz] に間引く。データセット生成
    // (forceOnboard) では 1 フレーム = 1 枚なので必ず焼き直す。
    //
    // 時間だけで間引くと、描画が重くなって dt が周期 (1/shadowRate) を
    // 超えた瞬間に「毎フレーム焼き直し」になり、遅いほど更に遅くなる
    // 正帰還に陥る。そこで時間の周期に加えて最低フレーム間隔でも律速し、
    // 影の焼き直しに使うフレームの割合 (デューティ比) に上限を設ける。
    // 60fps で回っているときは従来と同じ間隔 (60/shadowRate フレームに 1 回)。
    this.shadowAccum += dt;
    this.shadowFrames++;
    const shadowPeriod = 1 / Math.max(1, Math.min(this.shadowRate, q.shadowRate));
    const minFrameGap = Math.max(1, Math.round(60 * shadowPeriod));
    const updateShadow = !!opts.forceOnboard
      || (this.shadowAccum >= shadowPeriod && this.shadowFrames >= minFrameGap);
    if (updateShadow) { this.shadowAccum = 0; this.shadowFrames = 0; }
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = updateShadow;

    const onboardFull = this.viewMode === 'onboard';
    const needSensor = this.showPiP || onboardFull || opts.forceOnboard;

    // 建物では、離れた階を描かないようにする。
    // 視錐台カリングは遮蔽を考えないので、スラブで隠れている上下階も
    // 「視界に入っている」扱いで描かれてしまう。ここで明示的に落とす。
    // 外部視点と機体カメラでは高さが違うので、描く直前にそれぞれ設定する。
    const building = this.activeBuilder === this.buildingBuilder ? this.buildingBuilder : null;
    const floorsFor = (y) => { if (building) building.setVisibleFloorsByHeight(y); };
    // 俯瞰では建物を上から見るので全階を出す
    const floorsAll = () => { if (building) building.showAllFloors(); };

    // 天井灯は基準点に近い一定数だけ点ける (buildingBuilder.setActiveLights を参照)。
    // 外部視点と機体カメラでは位置が違うので、描く直前にそれぞれ選び直す。
    // 灯数は変えないので、シェーダの作り直しは起きない。
    const lightsFor = (cam) => { if (building) building.setActiveLights(cam, q.lights); };

    // --- シャドウマップの焼き直し ---
    // 影は隠している階からも落ちてほしい (階段の吹抜など) ので、焼くときだけ
    // 全階を出す。ただし three.js は render() の中で影を焼くため、そのまま
    // 本描画まで全階を描いてしまう。極小の領域に 1 回描いて影だけ確定させ、
    // 本描画は階カリングを効かせた状態で行う。
    if (updateShadow) {
      floorsAll();
      lightsFor(this.camera);
      this.renderer.setRenderTarget(null);
      this.renderer.setScissor(0, 0, 2, 2);
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(0, 0, 2, 2);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setScissorTest(false);
      this.renderer.shadowMap.needsUpdate = false;
    }

    // --- メイン描画 ---
    if (this.viewMode === 'top') floorsAll();
    else floorsFor(this.camera.position.y);
    lightsFor(this.camera);
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
    const sensorPeriod = 1 / Math.max(1, Math.min(this.sensorRate, q.sensorRate));
    this.sensor.maxBlurSamples = Number.isFinite(q.blur) ? q.blur : 0;
    if (needSensor && (this.sensorAccum >= sensorPeriod || opts.forceOnboard || !this.hasPrevCam)) {
      this.sensorAccum = 0;
      floorsFor(state.p.y);          // 機体のいる階を基準にする
      this.sensor.camera.updateMatrixWorld(true);
      lightsFor(this.sensor.camera);
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
