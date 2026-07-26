/**
 * 依存ゼロの軽量ベクトル/クォータニオン/行列ユーティリティ。
 *
 * 物理コア (`src/core/`) は three.js に依存しない。これにより
 *   - Node.js 上で単体テストできる
 *   - 描画エンジンを差し替えても物理はそのまま使える
 * という利点がある。
 *
 * === 座標系の定義 (重要) ===
 * ワールド座標 W: X = 右(東), Y = 上, Z = 手前(南)  … three.js と同じ右手系 Y-up
 * 機体座標   B: x_b = 右, y_b = 上, z_b = 後方       … three.js のローカル系と同じ
 *   前方ベクトルは -z_b。推力は +y_b 方向。
 *   ロール φ : 前方軸 (-z_b) 回り、右下げが正
 *   ピッチ θ : 右軸 (+x_b) 回り、機首上げが正
 *   ヨー   ψ : 上軸 (+y_b) 回り、上から見て反時計回り (左旋回) が正
 * オイラー角の合成順序は intrinsic Y-X-Z (ヨー→ピッチ→ロール)。
 *
 * 研究用途で一般的な ENU/FLU (ROS) や NED/FRD への変換は frames.js を参照。
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrapPi = (a) => {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
};

/* ------------------------------------------------------------------ */
/* Vec3 : プレーンオブジェクト {x,y,z} を使う (JSON 化しやすいため)       */
/* ------------------------------------------------------------------ */

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const vcopy = (a) => ({ x: a.x, y: a.y, z: a.z });
export const vset = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const vadd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const vsub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const vmul = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const vmulv = (a, b) => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z });
export const vdot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const vcross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const vlen = (a) => Math.hypot(a.x, a.y, a.z);
export const vlen2 = (a) => a.x * a.x + a.y * a.y + a.z * a.z;
export const vnorm = (a) => {
  const l = vlen(a);
  return l > 1e-12 ? vmul(a, 1 / l) : v3(0, 0, 0);
};
export const vlerp = (a, b, t) => ({
  x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t),
});
export const vaddInPlace = (a, b) => { a.x += b.x; a.y += b.y; a.z += b.z; return a; };
export const vclampLen = (a, maxLen) => {
  const l = vlen(a);
  return l > maxLen && l > 1e-12 ? vmul(a, maxLen / l) : vcopy(a);
};

/* ------------------------------------------------------------------ */
/* Quaternion : {x,y,z,w} (Hamilton, 単位クォータニオン)                */
/* ------------------------------------------------------------------ */

export const q4 = (x = 0, y = 0, z = 0, w = 1) => ({ x, y, z, w });
export const qcopy = (q) => ({ x: q.x, y: q.y, z: q.z, w: q.w });

export const qmul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});

export const qconj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

export const qnormalize = (q) => {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  if (l < 1e-12) return q4();
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
};

/** 機体座標のベクトルをワールド座標へ (v_W = q * v_B * q^-1) */
export const qrot = (q, v) => {
  const { x, y, z, w } = q;
  // t = 2 * (q_vec x v)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
};

/** ワールド座標のベクトルを機体座標へ */
export const qrotInv = (q, v) => qrot(qconj(q), v);

/** 軸(単位ベクトル)と角度からクォータニオン */
export const qFromAxisAngle = (axis, angle) => {
  const h = angle * 0.5;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
};

/** intrinsic Y-X-Z (ヨー→ピッチ→ロール) のオイラー角からクォータニオン
 *  roll: 前方軸(-z_b)回り, pitch: +x_b 回り, yaw: +y_b 回り */
export const qFromEuler = (roll, pitch, yaw) => {
  // three.js の Euler('YXZ') と等価。ただし roll は -z 軸回りなので符号反転。
  const ez = -roll;
  const c1 = Math.cos(pitch / 2), s1 = Math.sin(pitch / 2); // X
  const c2 = Math.cos(yaw / 2), s2 = Math.sin(yaw / 2);     // Y
  const c3 = Math.cos(ez / 2), s3 = Math.sin(ez / 2);       // Z
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  };
};

/** クォータニオン → {roll, pitch, yaw} (intrinsic Y-X-Z, three.js Euler('YXZ') と等価) */
export const qToEuler = (q) => {
  const m = qToMat3(q); // 列優先: m[col*3 + row]
  const m11 = m[0], m21 = m[1], m31 = m[2];
  const m22 = m[4];
  const m13 = m[6], m23 = m[7], m33 = m[8];
  const pitch = Math.asin(-clamp(m23, -1, 1));
  let yaw, ez;
  if (Math.abs(m23) < 0.9999999) {
    yaw = Math.atan2(m13, m33);
    ez = Math.atan2(m21, m22);
  } else {
    yaw = Math.atan2(-m31, m11);
    ez = 0;
  }
  return { roll: -ez, pitch, yaw };
};

/** クォータニオン → 3x3 回転行列 (列優先: m[col*3 + row], v_W = M * v_B) */
export const qToMat3 = (q) => {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy,
    xy - wz, 1 - (xx + zz), yz + wx,
    xz + wy, yz - wx, 1 - (xx + yy),
  ];
};

/** 3x3 回転行列 (列優先) → クォータニオン */
export const qFromMat3 = (m) => {
  const m11 = m[0], m21 = m[1], m31 = m[2];
  const m12 = m[3], m22 = m[4], m32 = m[5];
  const m13 = m[6], m23 = m[7], m33 = m[8];
  const tr = m11 + m22 + m33;
  let q;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1.0);
    q = { w: 0.25 / s, x: (m32 - m23) * s, y: (m13 - m31) * s, z: (m21 - m12) * s };
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    q = { w: (m32 - m23) / s, x: 0.25 * s, y: (m12 + m21) / s, z: (m13 + m31) / s };
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    q = { w: (m13 - m31) / s, x: (m12 + m21) / s, y: 0.25 * s, z: (m23 + m32) / s };
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    q = { w: (m21 - m12) / s, x: (m13 + m31) / s, y: (m23 + m32) / s, z: 0.25 * s };
  }
  return qnormalize(q);
};

/** 球面線形補間 */
export const qslerp = (a, b, t) => {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bb = b;
  if (cos < 0) { cos = -cos; bb = { x: -b.x, y: -b.y, z: -b.z, w: -b.w }; }
  if (cos > 0.9995) {
    return qnormalize({
      x: lerp(a.x, bb.x, t), y: lerp(a.y, bb.y, t),
      z: lerp(a.z, bb.z, t), w: lerp(a.w, bb.w, t),
    });
  }
  const theta = Math.acos(clamp(cos, -1, 1));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return {
    x: a.x * wa + bb.x * wb, y: a.y * wa + bb.y * wb,
    z: a.z * wa + bb.z * wb, w: a.w * wa + bb.w * wb,
  };
};

/** 2つの姿勢の差を回転ベクトル (軸*角, ラジアン) で返す。制御則で使用。 */
export const qErrorVector = (qCur, qDes) => {
  const qe = qnormalize(qmul(qconj(qCur), qDes)); // 機体座標での誤差
  const w = clamp(qe.w, -1, 1);
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  const sign = qe.w < 0 ? -1 : 1; // 最短回り
  if (s < 1e-8) return v3(0, 0, 0);
  const angle = 2 * Math.atan2(s, Math.abs(w));
  const k = (sign * angle) / s;
  return v3(qe.x * k, qe.y * k, qe.z * k);
};

/* ------------------------------------------------------------------ */
/* 3x3 行列 (慣性テンソル用, 列優先)                                     */
/* ------------------------------------------------------------------ */

export const m3identity = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const m3diag = (a, b, c) => [a, 0, 0, 0, b, 0, 0, 0, c];
export const m3add = (A, B) => A.map((v, i) => v + B[i]);
export const m3scale = (A, s) => A.map((v) => v * s);

export const m3mulv = (A, v) => ({
  x: A[0] * v.x + A[3] * v.y + A[6] * v.z,
  y: A[1] * v.x + A[4] * v.y + A[7] * v.z,
  z: A[2] * v.x + A[5] * v.y + A[8] * v.z,
});

export const m3mul = (A, B) => {
  const C = new Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      C[c * 3 + r] = A[r] * B[c * 3] + A[3 + r] * B[c * 3 + 1] + A[6 + r] * B[c * 3 + 2];
    }
  }
  return C;
};

export const m3transpose = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];

export const m3inverse = (A) => {
  // 列優先配列を行優先として読むと転置行列 B = M^T になる。
  // B の逆行列を余因子で求め、最後に転置して M^-1 (列優先) を返す。
  const [a, b, c, d, e, f, g, h, i] = A;
  const A11 = e * i - f * h;
  const A12 = f * g - d * i;
  const A13 = d * h - e * g;
  const det = a * A11 + b * A12 + c * A13;
  if (Math.abs(det) < 1e-18) return m3identity();
  const id = 1 / det;
  return [
    A11 * id, (c * h - b * i) * id, (b * f - c * e) * id,
    A12 * id, (a * i - c * g) * id, (c * d - a * f) * id,
    A13 * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ];
};

/** 平行軸の定理: 質点 m を位置 r に置いたときの慣性テンソル寄与 */
export const inertiaOffset = (m, r) => {
  const { x, y, z } = r;
  return [
    m * (y * y + z * z), -m * x * y, -m * x * z,
    -m * x * y, m * (x * x + z * z), -m * y * z,
    -m * x * z, -m * y * z, m * (x * x + y * y),
  ];
};

/* ------------------------------------------------------------------ */
/* 疑似逆行列 (mixer 用, 任意サイズ)                                     */
/* ------------------------------------------------------------------ */

/** 行列 A (rows x cols, 行優先の配列の配列) の Moore-Penrose 疑似逆行列。
 *  行フルランクなら A^T (A A^T)^-1、列フルランクなら (A^T A)^-1 A^T。
 *  正則化項は行列のスケールに比例させる (行ごとに桁が大きく違っても偏らないように)。 */
export function pinv(A, lambda = 1e-12) {
  const rows = A.length, cols = A[0].length;
  const At = transpose(A);
  const reg = (M, n) => {
    let tr = 0;
    for (let i = 0; i < n; i++) tr += M[i][i];
    const eps = lambda * Math.max(tr / n, 1e-30);
    for (let i = 0; i < n; i++) M[i][i] += eps;
    return M;
  };
  if (rows <= cols) {
    const AAt = reg(matmul(A, At), rows);            // rows x rows
    return matmul(At, invertSquare(AAt));            // cols x rows
  }
  const AtA = reg(matmul(At, A), cols);              // cols x cols
  return matmul(invertSquare(AtA), At);              // cols x rows
}

export function transpose(A) {
  const rows = A.length, cols = A[0].length;
  const T = Array.from({ length: cols }, () => new Array(rows).fill(0));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) T[c][r] = A[r][c];
  return T;
}

export function matmul(A, B) {
  const n = A.length, m = B[0].length, k = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let x = 0; x < k; x++) s += A[i][x] * B[x][j];
      C[i][j] = s;
    }
  }
  return C;
}

export function matvec(A, v) {
  return A.map((row) => row.reduce((s, a, i) => s + a * v[i], 0));
}

/** ガウス・ジョルダン法による正方行列の逆行列 */
export function invertSquare(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-14) continue;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    for (let c = 0; c < 2 * n; c++) A[col][c] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = 0; c < 2 * n; c++) A[r][c] -= f * A[col][c];
    }
  }
  return A.map((row) => row.slice(n));
}

/* ------------------------------------------------------------------ */
/* 乱数 (再現性のためシード付き)                                         */
/* ------------------------------------------------------------------ */

/** mulberry32: 高速で十分な品質の決定論的 PRNG */
export function makeRng(seed = 12345) {
  let a = seed >>> 0;
  const rand = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  rand.normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0, s = 0;
    do {
      u = rand() * 2 - 1; v = rand() * 2 - 1; s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * f;
    return u * f;
  };
  rand.range = (lo, hi) => lo + rand() * (hi - lo);
  rand.int = (lo, hi) => Math.floor(rand.range(lo, hi + 1));
  rand.pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rand() * arr.length))];
  rand.normal3 = () => v3(rand.normal(), rand.normal(), rand.normal());
  return rand;
}
