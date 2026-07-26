/**
 * データセット記録・書き出し。
 *
 * 自己位置推定の研究でそのまま使えるよう、広く使われている形式で出力する:
 *
 *   rgb/000000.png ...        画像 (歪みを含む)
 *   depth/000000.png          深度 (16bit を R,G チャンネルに分割)
 *   groundtruth.txt           TUM 形式  timestamp tx ty tz qx qy qz qw  (ENU/FLU)
 *   rgb.txt                   TUM 形式のタイムスタンプ ↔ 画像の対応
 *   imu.csv                   EuRoC 形式 (ns, wx,wy,wz, ax,ay,az)  (FLU)
 *   camera.json / camera.yaml カメラ内部パラメータと歪み係数
 *   transforms.json           NeRF / 3DGS 用 (OpenGL 規約, camera-to-world)
 *   colmap/cameras.txt,images.txt  COLMAP 形式 (OpenCV 規約, world-to-camera)
 *   telemetry.csv             機体の全状態量 (速度・角速度・モータ回転数など)
 *   metadata.json             機体・環境・カメラの設定一式 (再現用)
 *
 * 座標系は frames.js で内部座標から変換している。
 */

import * as THREE from 'three';
import { ZipWriter, downloadBlob } from './zip.js';
import { toENU, bodyVecToFLU, camGLtoCV, worldToCamera, cameraToWorldMatrix } from '../core/frames.js';

const pad = (n, w = 6) => String(n).padStart(w, '0');
const f = (x, d = 6) => (Number.isFinite(x) ? x.toFixed(d) : '0');

export class DatasetRecorder {
  constructor(sensor) {
    this.sensor = sensor;
    this.reset();
    this.config = {
      fps: 10,
      maxFrames: 600,
      saveDepth: false,
      saveImu: true,
      imageFormat: 'png',
      jpegQuality: 0.92,
      name: 'indoor-drone',
    };
  }

  reset() {
    this.frames = [];       // {index, t, blob, depthBlob, pose, camPose}
    this.imu = [];
    this.telemetry = [];
    this.recording = false;
    this.accum = 0;
    this.pending = 0;
    this.startTime = 0;
    this.droppedFrames = 0;
  }

  start(simTime) {
    this.reset();
    this.recording = true;
    this.startTime = simTime;
  }

  stop() {
    this.recording = false;
  }

  get frameCount() { return this.frames.length; }

  /**
   * 毎フレーム呼ぶ。必要なタイミングで画像を取り込む。
   * @param {number} dt
   * @param {object} snapshot シミュレータのテレメトリ
   * @param {THREE.Camera} camera 機体カメラ (ワールド姿勢を読む)
   */
  update(dt, snapshot, camera) {
    if (!this.recording) return false;
    this.accum += dt;
    const period = 1 / this.config.fps;
    if (this.accum < period) return false;
    this.accum -= period;
    if (this.frames.length >= this.config.maxFrames) {
      this.recording = false;
      return false;
    }
    this.capture(snapshot, camera);
    return true;
  }

  /** 現在のフレームを取り込む */
  capture(snapshot, camera) {
    const index = this.frames.length;
    const t = snapshot.t;
    const img = this.sensor.readPixels();
    const entry = {
      index, t,
      pose: { p: { ...snapshot.position }, q: { ...snapshot.quaternion } },
      camera: this.readCameraPose(camera),
      blob: null,
    };
    this.frames.push(entry);
    this.telemetry.push(snapshotToRow(snapshot));

    // PNG 化は非同期で行う (描画をブロックしない)
    this.pending++;
    encodeImage(img, this.config.imageFormat, this.config.jpegQuality).then((blob) => {
      entry.blob = blob;
      this.pending--;
    }).catch(() => { this.pending--; this.droppedFrames++; });

    if (this.config.saveDepth && this.sensor.rtDepth) {
      const d = this.sensor.readPixels(this.sensor.rtDepth);
      this.pending++;
      encodeImage(d, 'png').then((blob) => {
        entry.depthBlob = blob;
        this.pending--;
      }).catch(() => { this.pending--; });
    }
  }

  readCameraPose(camera) {
    camera.updateMatrixWorld(true);
    const p = camera.getWorldPosition(new THREE.Vector3());
    const q = camera.getWorldQuaternion(new THREE.Quaternion());
    return { p: { x: p.x, y: p.y, z: p.z }, q: { x: q.x, y: q.y, z: q.z, w: q.w } };
  }

  /** IMU ログを取り込む (SensorSuite の imuLog をそのまま使う) */
  setImuLog(log) { this.imu = log; }

  /**
   * ZIP を生成してダウンロードする。
   * @param {object} meta 機体・環境などの設定
   */
  async export(meta = {}) {
    // 画像のエンコード完了を待つ
    let guard = 0;
    while (this.pending > 0 && guard < 2000) {
      await new Promise((r) => setTimeout(r, 20));
      guard++;
    }

    const zip = new ZipWriter();
    const name = this.config.name;
    const ext = this.config.imageFormat === 'jpeg' ? 'jpg' : 'png';

    const rgbLines = ['# color images', '# timestamp filename'];
    const gtLines = [
      '# ground truth trajectory (body frame, ENU world / FLU body)',
      '# timestamp tx ty tz qx qy qz qw',
    ];
    const camGtLines = [
      '# ground truth trajectory (camera frame, ENU world / FLU-like camera)',
      '# timestamp tx ty tz qx qy qz qw',
    ];
    const depthLines = ['# depth images', '# timestamp filename'];

    // NeRF / 3DGS 用
    const cal = this.sensor.calibration();
    const transforms = {
      camera_model: 'OPENCV',
      fl_x: cal.fx, fl_y: cal.fy, cx: cal.cx, cy: cal.cy,
      w: cal.width, h: cal.height,
      k1: cal.distortion[0], k2: cal.distortion[1],
      p1: cal.distortion[2], p2: cal.distortion[3],
      frames: [],
    };
    // COLMAP 用
    const colmapImages = [
      '# Image list with two lines of data per image:',
      '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',
      '#   POINTS2D[] as (X, Y, POINT3D_ID)',
    ];

    for (const fr of this.frames) {
      const file = `rgb/${pad(fr.index)}.${ext}`;
      if (fr.blob) {
        zip.add(file, new Uint8Array(await fr.blob.arrayBuffer()));
      }
      const ts = f(fr.t, 6);
      rgbLines.push(`${ts} ${file}`);

      // 機体ポーズ (ENU/FLU)
      const b = toENU(fr.pose.p, fr.pose.q);
      gtLines.push(`${ts} ${f(b.p.x)} ${f(b.p.y)} ${f(b.p.z)} ${f(b.q.x)} ${f(b.q.y)} ${f(b.q.z)} ${f(b.q.w)}`);

      // カメラポーズ
      const c = toENU(fr.camera.p, fr.camera.q);
      camGtLines.push(`${ts} ${f(c.p.x)} ${f(c.p.y)} ${f(c.p.z)} ${f(c.q.x)} ${f(c.q.y)} ${f(c.q.z)} ${f(c.q.w)}`);

      // NeRF: OpenGL 規約の camera-to-world (内部座標系そのまま = Y-up 右手系)
      transforms.frames.push({
        file_path: file,
        transform_matrix: cameraToWorldMatrix(fr.camera.p, fr.camera.q),
        time: fr.t,
      });

      // COLMAP: OpenCV 規約の world-to-camera
      const qcv = camGLtoCV(fr.camera.q);
      const wc = worldToCamera(fr.camera.p, qcv);
      colmapImages.push(
        `${fr.index + 1} ${f(wc.q.w)} ${f(wc.q.x)} ${f(wc.q.y)} ${f(wc.q.z)} `
        + `${f(wc.t.x)} ${f(wc.t.y)} ${f(wc.t.z)} 1 ${file}`);
      colmapImages.push('');

      if (fr.depthBlob) {
        const df = `depth/${pad(fr.index)}.png`;
        zip.add(df, new Uint8Array(await fr.depthBlob.arrayBuffer()));
        depthLines.push(`${ts} ${df}`);
      }
    }

    zip.add('rgb.txt', rgbLines.join('\n') + '\n');
    zip.add('groundtruth.txt', gtLines.join('\n') + '\n');
    zip.add('groundtruth_camera.txt', camGtLines.join('\n') + '\n');
    if (this.config.saveDepth) zip.add('depth.txt', depthLines.join('\n') + '\n');
    zip.add('transforms.json', JSON.stringify(transforms, null, 2));
    zip.add('colmap/images.txt', colmapImages.join('\n') + '\n');
    zip.add('colmap/cameras.txt',
      '# Camera list with one line of data per camera:\n'
      + '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n'
      + `1 OPENCV ${cal.width} ${cal.height} ${f(cal.fx)} ${f(cal.fy)} ${f(cal.cx)} ${f(cal.cy)} `
      + `${cal.distortion.map((x) => f(x, 8)).join(' ')}\n`);
    zip.add('colmap/points3D.txt', '# 3D point list (empty; poses are ground truth)\n');
    zip.add('camera.json', JSON.stringify(cal, null, 2));
    zip.add('camera.yaml', toYaml(cal));

    if (this.config.saveImu && this.imu.length) {
      const lines = ['#timestamp [ns],w_RS_S_x [rad s^-1],w_RS_S_y [rad s^-1],w_RS_S_z [rad s^-1],'
        + 'a_RS_S_x [m s^-2],a_RS_S_y [m s^-2],a_RS_S_z [m s^-2]'];
      for (const row of this.imu) {
        const [t, gx, gy, gz, ax, ay, az] = row;
        // 内部の機体座標 (右, 上, 後) → FLU (前, 左, 上)
        const g = bodyVecToFLU({ x: gx, y: gy, z: gz });
        const a = bodyVecToFLU({ x: ax, y: ay, z: az });
        lines.push(`${Math.round(t * 1e9)},${f(g.x, 9)},${f(g.y, 9)},${f(g.z, 9)},`
          + `${f(a.x, 9)},${f(a.y, 9)},${f(a.z, 9)}`);
      }
      zip.add('imu.csv', lines.join('\n') + '\n');
    }

    if (this.telemetry.length) {
      zip.add('telemetry.csv', telemetryCsv(this.telemetry));
    }

    zip.add('metadata.json', JSON.stringify({
      generator: 'realmulticoptersimulator',
      created: new Date().toISOString(),
      frames: this.frames.length,
      fps: this.config.fps,
      duration_s: this.frames.length ? this.frames[this.frames.length - 1].t - this.frames[0].t : 0,
      coordinate_frames: {
        groundtruth: 'ENU world / FLU body (ROS REP-103)',
        transforms_json: 'OpenGL camera-to-world (Y-up, right-handed) — NeRF/3DGS 用',
        colmap: 'OpenCV world-to-camera',
        imu: 'FLU body frame',
      },
      camera: cal,
      ...meta,
    }, null, 2));

    zip.add('README.txt', readmeText(this.frames.length, cal, this.config));

    const blob = zip.blob();
    downloadBlob(blob, `${name}-${this.frames.length}frames.zip`);
    return blob;
  }
}

/* ------------------------------------------------------------------ */

/** ImageData 相当のバッファを PNG/JPEG Blob へ */
export async function encodeImage(img, format = 'png', quality = 0.92) {
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(img.width, img.height)
    : Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  const data = new ImageData(img.data, img.width, img.height);
  ctx.putImageData(data, 0, 0);
  const type = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function snapshotToRow(s) {
  const e = s.euler;
  return [
    s.t, s.position.x, s.position.y, s.position.z,
    s.velocity.x, s.velocity.y, s.velocity.z,
    e.roll, e.pitch, e.yaw,
    s.omega.x, s.omega.y, s.omega.z,
    s.battery.voltage, s.battery.current, s.battery.soc,
    s.agl, s.contact, ...s.rpm,
  ];
}

function telemetryCsv(rows) {
  const nRotor = rows[0].length - 18;
  const header = ['t', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'roll', 'pitch', 'yaw',
    'wx', 'wy', 'wz', 'voltage', 'current', 'soc', 'agl', 'contact',
    ...Array.from({ length: nRotor }, (_, i) => `rpm${i}`)];
  const lines = [
    '# 内部座標系 (X=右/東, Y=上, Z=手前). ENU への変換は metadata.json を参照',
    header.join(','),
  ];
  for (const r of rows) lines.push(r.map((v) => f(v, 6)).join(','));
  return lines.join('\n') + '\n';
}

function toYaml(cal) {
  return [
    '# カメラ内部パラメータ (Kalibr / OpenCV 互換)',
    'cam0:',
    '  camera_model: pinhole',
    `  intrinsics: [${f(cal.fx)}, ${f(cal.fy)}, ${f(cal.cx)}, ${f(cal.cy)}]`,
    '  distortion_model: radtan',
    `  distortion_coeffs: [${cal.distortion.map((x) => f(x, 8)).join(', ')}]`,
    `  resolution: [${cal.width}, ${cal.height}]`,
    `  hfov_deg: ${f(cal.hfov_deg, 3)}`,
    `  vfov_deg: ${f(cal.vfov_deg, 3)}`,
    `  exposure_time_s: ${cal.exposure_time_s}`,
    '',
  ].join('\n');
}

function readmeText(n, cal, cfg) {
  return [
    '屋内ドローンシミュレータ データセット',
    '=====================================',
    '',
    `画像枚数 : ${n}`,
    `解像度   : ${cal.width} x ${cal.height}`,
    `フレーム率: ${cfg.fps} fps`,
    `内部パラメータ: fx=${f(cal.fx, 3)} fy=${f(cal.fy, 3)} cx=${f(cal.cx, 3)} cy=${f(cal.cy, 3)}`,
    `歪み係数 (k1,k2,p1,p2): ${cal.distortion.map((x) => f(x, 6)).join(', ')}`,
    '',
    'ファイル構成',
    '  rgb/            : 画像 (レンズ歪み・ノイズを含む「実機に近い」画像)',
    '  groundtruth.txt : 機体の真値軌跡 (TUM 形式, ENU ワールド / FLU 機体座標)',
    '  groundtruth_camera.txt : カメラの真値軌跡',
    '  rgb.txt         : タイムスタンプと画像の対応 (TUM 形式)',
    '  imu.csv         : IMU の観測値 (EuRoC 形式, FLU)',
    '  camera.yaml     : Kalibr 互換のカメラパラメータ',
    '  transforms.json : NeRF / 3D Gaussian Splatting 用のポーズ',
    '  colmap/         : COLMAP 形式のカメラ・ポーズ (真値なので SfM 不要)',
    '  telemetry.csv   : 機体の全状態量',
    '  metadata.json   : 生成条件 (機体・環境・カメラの設定すべて)',
    '',
    '注意',
    '  - 画像には歪みが入っています。歪み補正が必要な場合は camera.yaml の係数を使ってください。',
    '  - groundtruth は真値です (推定ではありません)。評価の基準として使えます。',
    '  - metadata.json の設定を読み込めば同じデータを再生成できます。',
    '',
  ].join('\n');
}
