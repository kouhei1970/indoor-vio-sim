/**
 * 座標系変換ユーティリティ。
 *
 * 内部座標系 (シミュレータ / three.js と共通)
 *   ワールド W : X = 右(東), Y = 上, Z = 手前(南)
 *   機体     B : x = 右,    y = 上, z = 後方  (前方 = -z, 推力 = +y)
 *
 * 研究データセットで一般的な座標系
 *   ENU / FLU  : ROS (REP-103)。World: X=東 Y=北 Z=上, Body: x=前 y=左 z=上
 *   NED / FRD  : 航空宇宙標準。World: X=北 Y=東 Z=下, Body: x=前 y=右 z=下
 *   OpenCV cam : x=右 y=下 z=前 (COLMAP, OpenCV)
 *   OpenGL cam : x=右 y=上 z=後 (three.js, NeRF/transforms.json)
 *
 * すべての変換は「回転行列の相似変換」で表される:
 *   R_new = S * R_internal * T^T   (S: ワールド軸変換, T: 機体軸変換)
 */

import { qFromMat3, qToMat3, qmul, qconj, v3 } from './math.js';

/* 列優先 3x3 (m[col*3 + row]) で軸変換行列を定義する。
 * 行 = 出力軸を内部座標成分で表したもの。 */

// v_ENU = S_ENU * v_W :  E=x, N=-z, U=y
export const S_ENU = colMajorFromRows([
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
]);

// v_FLU = T_FLU * v_B :  f=-z, l=-x, u=y
export const T_FLU = colMajorFromRows([
  [0, 0, -1],
  [-1, 0, 0],
  [0, 1, 0],
]);

// v_NED = S_NED * v_W :  N=-z, E=x, D=-y
export const S_NED = colMajorFromRows([
  [0, 0, -1],
  [1, 0, 0],
  [0, -1, 0],
]);

// v_FRD = T_FRD * v_B :  f=-z, r=x, d=-y
export const T_FRD = colMajorFromRows([
  [0, 0, -1],
  [1, 0, 0],
  [0, -1, 0],
]);

export function colMajorFromRows(rows) {
  const m = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 3 + r] = rows[r][c];
  return m;
}

export function applyM3(m, v) {
  return v3(
    m[0] * v.x + m[3] * v.y + m[6] * v.z,
    m[1] * v.x + m[4] * v.y + m[7] * v.z,
    m[2] * v.x + m[5] * v.y + m[8] * v.z,
  );
}

function m3mul(A, B) {
  const C = new Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      C[c * 3 + r] = A[r] * B[c * 3] + A[3 + r] * B[c * 3 + 1] + A[6 + r] * B[c * 3 + 2];
    }
  }
  return C;
}
const m3T = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];

/**
 * 内部座標のポーズ {p, q} を、指定した規約のポーズへ変換する。
 * @param {{x,y,z}} p 位置 (内部ワールド)
 * @param {{x,y,z,w}} q 姿勢 (機体→ワールド, 内部)
 * @param {number[]} S ワールド軸変換
 * @param {number[]} T 機体軸変換
 */
export function convertPose(p, q, S, T) {
  const R = qToMat3(q);
  const Rn = m3mul(m3mul(S, R), m3T(T));
  return { p: applyM3(S, p), q: qFromMat3(Rn) };
}

export const toENU = (p, q) => convertPose(p, q, S_ENU, T_FLU);
export const toNED = (p, q) => convertPose(p, q, S_NED, T_FRD);

/** ベクトル (速度・角速度など) の変換 */
export const vecToENU = (v) => applyM3(S_ENU, v);
export const vecToNED = (v) => applyM3(S_NED, v);
/** 機体座標のベクトル (IMU 出力など) の変換 */
export const bodyVecToFLU = (v) => applyM3(T_FLU, v);
export const bodyVecToFRD = (v) => applyM3(T_FRD, v);

/**
 * OpenGL(three.js) カメラ姿勢 → OpenCV カメラ姿勢。
 * カメラのローカル軸を x→x, y→-y, z→-z に付け替える (180deg X 回転)。
 */
const Q_GL2CV = { x: 1, y: 0, z: 0, w: 0 };
export const camGLtoCV = (q) => qmul(q, Q_GL2CV);

/**
 * カメラの world→camera 変換 (COLMAP 形式) を返す。
 * @returns {{q:{x,y,z,w}, t:{x,y,z}}} q: R_cw のクォータニオン, t: 並進
 */
export function worldToCamera(pCam, qCamCV) {
  const qcw = qconj(qCamCV);
  const R = qToMat3(qcw);
  const t = applyM3(R, { x: -pCam.x, y: -pCam.y, z: -pCam.z });
  return { q: qcw, t };
}

/** 4x4 行列 (行優先の配列の配列) を camera-to-world として生成 (NeRF transforms.json 用) */
export function cameraToWorldMatrix(p, q) {
  const R = qToMat3(q);
  return [
    [R[0], R[3], R[6], p.x],
    [R[1], R[4], R[7], p.y],
    [R[2], R[5], R[8], p.z],
    [0, 0, 0, 1],
  ];
}
