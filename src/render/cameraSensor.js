/**
 * オンボードカメラ (機体搭載カメラ) のレンダリング。
 *
 *  - 指定した解像度・内部パラメータ (fx, fy, cx, cy) で描画する
 *  - レンズ歪みを考慮して少し広い画角で描画し、ポスト処理で歪ませる
 *  - 露光時間中の機体の動きを複数サブフレームの平均としてモーションブラーにする
 *  - 深度マップも同時に取得できる (深度教師付きデータセット用)
 *
 * データセット出力用に、その時点の内部パラメータ・歪み係数を JSON で取り出せる。
 */

import * as THREE from 'three';
import { CameraRealismShader, DepthEncodeShader } from './postShaders.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const DEG = Math.PI / 180;

export const CAMERA_DEFAULTS = {
  width: 640,
  height: 480,
  hfov: 82,              // 水平画角 [deg] (fx, fy はここから決まる)
  cxRatio: 0.5,
  cyRatio: 0.5,
  aspectRatioPixel: 1.0, // fy/fx (正方画素なら 1)
  near: 0.03,
  far: 60,
  distortion: { k1: -0.28, k2: 0.09, p1: 0.0006, p2: -0.0004 },
  vignette: 0.35,
  chromatic: 0.0012,
  shotNoise: 0.012,
  readNoise: 0.004,
  exposure: 1.0,
  contrast: 1.0,
  saturation: 1.0,
  grain: 0.006,
  whiteBalance: { r: 1.0, g: 1.0, b: 1.0 },
  motionBlur: true,
  exposureTime: 0.008,   // シャッター速度 [s]
  blurSamples: 6,
  rollingShutter: 0.0,
  depth: false,
  supersample: 1.5,      // 描画解像度の倍率 (エイリアシング低減)
};

export class CameraSensor {
  constructor(renderer, cfg = {}) {
    this.renderer = renderer;
    this.cfg = { ...CAMERA_DEFAULTS, ...cfg };
    this.camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.03, 60);
    this.camera.name = 'onboardCamera';

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CameraRealismShader.uniforms),
      vertexShader: CameraRealismShader.vertexShader,
      fragmentShader: CameraRealismShader.fragmentShader,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    // モータブラー積算用のブレンド材質
    this.accumMaterial = new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.accumQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.accumMaterial);
    this.accumQuad.frustumCulled = false;
    this.accumScene = new THREE.Scene();
    this.accumScene.add(this.accumQuad);

    this.depthMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(DepthEncodeShader.uniforms),
      vertexShader: DepthEncodeShader.vertexShader,
      fragmentShader: DepthEncodeShader.fragmentShader,
      toneMapped: false, depthTest: false, depthWrite: false,
    });

    this.prevMatrix = new THREE.Matrix4();
    this.hasPrev = false;
    this.applyConfig(this.cfg);
  }

  /** 設定を適用してレンダーターゲットを作り直す */
  applyConfig(cfg) {
    this.cfg = { ...this.cfg, ...cfg };
    const c = this.cfg;
    const W = Math.max(16, Math.round(c.width));
    const H = Math.max(16, Math.round(c.height));

    // --- 内部パラメータ ---
    // 水平画角から fx を決め、画素アスペクト比から fy を決める
    const fx = (W / 2) / Math.tan((c.hfov * DEG) / 2);
    const fy = fx * (c.aspectRatioPixel ?? 1);
    const cx = W * (c.cxRatio ?? 0.5);
    const cy = H * (c.cyRatio ?? 0.5);
    this.intrinsics = { width: W, height: H, fx, fy, cx, cy, ...c.distortion };

    // --- 歪みを考慮した描画画角 ---
    // 出力画像の四隅に対応する理想光線の広がりを求め、その分だけ広く描画する
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0, 0.5]];
    let maxX = 0, maxY = 0;
    for (const [u, v] of corners) {
      const xd = (u * W - cx) / fx;
      const yd = (v * H - cy) / fy;
      const [x, y] = invertDistortion(xd, yd, c.distortion);
      maxX = Math.max(maxX, Math.abs(x));
      maxY = Math.max(maxY, Math.abs(y));
    }
    const margin = 1.04;
    const tanX = Math.max(maxX * margin, 1e-3);
    const tanY = Math.max(maxY * margin, 1e-3);
    this.renderTan = { x: tanX, y: tanY };

    this.camera.fov = 2 * Math.atan(tanY) / DEG;
    this.camera.aspect = tanX / tanY;
    this.camera.near = c.near;
    this.camera.far = c.far;
    this.camera.updateProjectionMatrix();

    // --- レンダーターゲット ---
    const ss = c.supersample ?? 1;
    const rw = Math.round(W * ss * (tanX / tanY) / (W / H));
    const rh = Math.round(H * ss);
    const renderW = Math.max(16, Math.round(rw));
    const renderH = Math.max(16, rh);

    this.disposeTargets();
    const opts = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.LinearSRGBColorSpace,
    };
    this.rtScene = new THREE.WebGLRenderTarget(renderW, renderH, {
      ...opts, depthTexture: new THREE.DepthTexture(renderW, renderH),
    });
    this.rtScene.depthTexture.type = THREE.UnsignedIntType;
    this.rtAccum = new THREE.WebGLRenderTarget(renderW, renderH, opts);
    this.rtOut = new THREE.WebGLRenderTarget(W, H, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
    });
    this.rtDepth = c.depth ? new THREE.WebGLRenderTarget(W, H, {
      type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      colorSpace: THREE.LinearSRGBColorSpace,
    }) : null;

    // --- ポスト処理のユニフォーム ---
    const u = this.postMaterial.uniforms;
    u.resolution.value = [W, H];
    u.focal.value = [fx / W, fy / H];
    u.principal.value = [cx / W, cy / H];
    u.focalRender.value = [1 / (2 * tanX), 1 / (2 * tanY)];
    u.principalRender.value = [0.5, 0.5];
    u.distortion.value = [c.distortion.k1, c.distortion.k2, c.distortion.p1, c.distortion.p2];
    u.vignette.value = c.vignette;
    u.chromatic.value = c.chromatic;
    u.shotNoise.value = c.shotNoise;
    u.readNoise.value = c.readNoise;
    u.exposure.value = c.exposure;
    u.contrast.value = c.contrast;
    u.saturation.value = c.saturation;
    u.grain.value = c.grain;
    u.whiteBalance.value = [c.whiteBalance.r, c.whiteBalance.g, c.whiteBalance.b];
    u.rollingShutter.value = c.rollingShutter;

    const d = this.depthMaterial.uniforms;
    d.cameraNear.value = c.near;
    d.cameraFar.value = c.far;
  }

  disposeTargets() {
    for (const k of ['rtScene', 'rtAccum', 'rtOut', 'rtDepth']) {
      if (this[k]) { this[k].dispose(); this[k] = null; }
    }
  }

  dispose() {
    this.disposeTargets();
    this.postMaterial.dispose();
    this.depthMaterial.dispose();
    this.quad.geometry.dispose();
    this.accumQuad.geometry.dispose();
  }

  /**
   * 1 フレーム描画する。
   * @param {THREE.Scene} scene
   * @param {number} time シミュレーション時刻 (ノイズのシードに使う)
   * @param {THREE.Matrix4|null} prevMatrix 前フレームのカメラ姿勢 (モーションブラー用)
   * @param {number} frameDt 前フレームからの経過時間 [s]
   * @returns {THREE.WebGLRenderTarget} ポスト処理済みの出力
   */
  render(scene, time, prevMatrix = null, frameDt = 1 / 60) {
    const r = this.renderer;
    const c = this.cfg;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;

    this.camera.updateMatrixWorld();
    const curMatrix = this.camera.matrixWorld.clone();

    const samples = (c.motionBlur && prevMatrix && c.blurSamples > 1) ? Math.round(c.blurSamples) : 1;

    if (samples === 1) {
      r.setRenderTarget(this.rtScene);
      r.clear();
      r.render(scene, this.camera);
      this.postMaterial.uniforms.tDiffuse.value = this.rtScene.texture;
    } else {
      // 露光時間中の姿勢を補間しながら複数回描画し、加算平均する。
      //
      // カメラは機体 (シーングラフ) の子なので、ローカル変換をいじると
      // 取り付け位置が壊れてしまう。ここではワールド行列を直接差し替え、
      // three.js 側の自動更新を一時的に止める。
      r.setRenderTarget(this.rtAccum);
      r.setClearColor(0x000000, 1);
      r.clear();
      this.accumMaterial.opacity = 1 / samples;
      const posA = new THREE.Vector3(), posB = new THREE.Vector3();
      const quatA = new THREE.Quaternion(), quatB = new THREE.Quaternion();
      const sclA = new THREE.Vector3(), sclB = new THREE.Vector3();
      prevMatrix.decompose(posA, quatA, sclA);
      curMatrix.decompose(posB, quatB, sclB);
      const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
      const tmp = new THREE.Matrix4();
      // ブラーはシャッターが開いている間だけの動きを積分する。
      // フレーム間隔 dt のうち、末尾の exposureTime 分だけを使う。
      const span = clamp((c.exposureTime ?? 0.008) / Math.max(frameDt, 1e-4), 0.02, 1);
      const t0 = 1 - span;

      const prevWorldAuto = this.camera.matrixWorldAutoUpdate;
      this.camera.matrixWorldAutoUpdate = false;

      for (let i = 0; i < samples; i++) {
        const t = t0 + (samples === 1 ? span : (i / (samples - 1)) * span);
        pos.lerpVectors(posA, posB, t);
        quat.slerpQuaternions(quatA, quatB, t);
        tmp.compose(pos, quat, sclB);
        this.camera.matrixWorld.copy(tmp);
        this.camera.matrixWorldInverse.copy(tmp).invert();

        r.setRenderTarget(this.rtScene);
        r.clear();
        r.render(scene, this.camera);

        this.accumMaterial.map = this.rtScene.texture;
        this.accumMaterial.needsUpdate = true;
        r.setRenderTarget(this.rtAccum);
        r.autoClear = false;
        r.render(this.accumScene, this.quadCamera);
        r.autoClear = prevAutoClear;
      }
      // ワールド行列を露光終了時の値に戻し、自動更新を再開する
      this.camera.matrixWorld.copy(curMatrix);
      this.camera.matrixWorldInverse.copy(curMatrix).invert();
      this.camera.matrixWorldAutoUpdate = prevWorldAuto;
      this.postMaterial.uniforms.tDiffuse.value = this.rtAccum.texture;
    }

    // ポスト処理 (歪み・ノイズ・ビネット)
    this.postMaterial.uniforms.time.value = time;
    r.setRenderTarget(this.rtOut);
    r.clear();
    r.render(this.quadScene, this.quadCamera);

    // 深度マップ
    if (this.rtDepth) {
      this.quad.material = this.depthMaterial;
      this.depthMaterial.uniforms.tDepth.value = this.rtScene.depthTexture;
      this.depthMaterial.uniforms.maxDepth.value = this.cfg.far;
      r.setRenderTarget(this.rtDepth);
      r.clear();
      r.render(this.quadScene, this.quadCamera);
      this.quad.material = this.postMaterial;
    }

    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    this.prevMatrix.copy(curMatrix);
    this.hasPrev = true;
    return this.rtOut;
  }

  /** 出力画像のピクセルを読み出す (RGBA, 上下反転済み) */
  readPixels(target = null) {
    const rt = target || this.rtOut;
    const w = rt.width, h = rt.height;
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    // WebGL は左下原点なので上下を反転する
    const flipped = new Uint8ClampedArray(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      flipped.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    }
    return { data: flipped, width: w, height: h };
  }

  /** データセットに添付するカメラパラメータ */
  calibration() {
    const c = this.cfg;
    const i = this.intrinsics;
    return {
      model: 'pinhole-radtan',
      width: i.width, height: i.height,
      fx: i.fx, fy: i.fy, cx: i.cx, cy: i.cy,
      distortion: [c.distortion.k1, c.distortion.k2, c.distortion.p1, c.distortion.p2],
      distortion_model: 'brown-conrady (k1,k2,p1,p2)',
      hfov_deg: c.hfov,
      vfov_deg: 2 * Math.atan((i.height / 2) / i.fy) / DEG,
      exposure_time_s: c.exposureTime,
      rolling_shutter: c.rollingShutter,
      near: c.near, far: c.far,
    };
  }
}

/** CPU 側での歪み逆変換 (描画画角の決定に使う) */
export function invertDistortion(xd, yd, d, iterations = 12) {
  let x = xd, y = yd;
  for (let i = 0; i < iterations; i++) {
    const r2 = x * x + y * y;
    const radial = 1 + d.k1 * r2 + d.k2 * r2 * r2;
    const tx = 2 * d.p1 * x * y + d.p2 * (r2 + 2 * x * x);
    const ty = d.p1 * (r2 + 2 * y * y) + 2 * d.p2 * x * y;
    const nx = (xd - tx) / Math.max(radial, 0.05);
    const ny = (yd - ty) / Math.max(radial, 0.05);
    x = nx; y = ny;
  }
  return [x, y];
}

/** カメラプリセット */
export const CAMERA_PRESETS = {
  'fpv-wide': {
    label: 'FPV 広角 (魚眼寄り)',
    width: 640, height: 480, hfov: 120,
    distortion: { k1: -0.32, k2: 0.11, p1: 0.0008, p2: -0.0005 },
    vignette: 0.5, chromatic: 0.002,
  },
  'realsense-d435': {
    label: 'RealSense D435 相当',
    width: 848, height: 480, hfov: 87,
    distortion: { k1: -0.05, k2: 0.02, p1: 0.0002, p2: 0.0001 },
    vignette: 0.2, chromatic: 0.0006,
  },
  'global-shutter-vio': {
    label: 'VIO 用グローバルシャッタ (単眼)',
    width: 752, height: 480, hfov: 90,
    distortion: { k1: -0.28, k2: 0.07, p1: 0.0003, p2: -0.0002 },
    vignette: 0.3, chromatic: 0.0008, rollingShutter: 0,
    shotNoise: 0.010, readNoise: 0.004,
  },
  'rolling-shutter-phone': {
    label: 'スマホ相当 (ローリングシャッタ)',
    width: 960, height: 540, hfov: 70,
    distortion: { k1: -0.12, k2: 0.03, p1: 0.0001, p2: 0.0001 },
    vignette: 0.28, chromatic: 0.0015, rollingShutter: 0.02,
    shotNoise: 0.02, readNoise: 0.008,
  },
  'hd-clean': {
    label: '高画質 (歪み・ノイズ最小)',
    width: 1280, height: 720, hfov: 75,
    distortion: { k1: 0, k2: 0, p1: 0, p2: 0 },
    vignette: 0.08, chromatic: 0.0, shotNoise: 0.002, readNoise: 0.001, grain: 0,
  },
  'downward-nav': {
    label: '下向きナビカメラ (低解像度)',
    width: 320, height: 240, hfov: 65,
    distortion: { k1: -0.18, k2: 0.05, p1: 0, p2: 0 },
    vignette: 0.35, chromatic: 0.001, shotNoise: 0.025, readNoise: 0.01,
  },
};
