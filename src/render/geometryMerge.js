/**
 * 静的メッシュの統合。
 *
 * 壁・階段・家具のように動かないメッシュを、マテリアルごとに 1 つの
 * ジオメトリへまとめる。描画されるものは同じだが、ドローコールが
 * メッシュ数から マテリアル数 まで減る。
 *
 * 影のパスは光源ごとにシーンをもう一度描くので、ドローコールを減らすと
 * 主描画と影の両方が同じ比率で軽くなる。
 *
 * 制限:
 *   - 統合後は個々のメッシュを動かせない (静的なものだけに使う)
 *   - まとめた範囲が視錐台カリングの単位になるので、建物では階ごとに分ける
 */

import * as THREE from 'three';

/** インデックス付きジオメトリを展開して、素の position/normal/uv を返す */
function expand(geometry) {
  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  if (!pos) return null;
  const index = geometry.getIndex();
  const n = index ? index.count : pos.count;
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  const U = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = index ? index.getX(i) : i;
    P[i * 3] = pos.getX(j); P[i * 3 + 1] = pos.getY(j); P[i * 3 + 2] = pos.getZ(j);
    if (nrm) { N[i * 3] = nrm.getX(j); N[i * 3 + 1] = nrm.getY(j); N[i * 3 + 2] = nrm.getZ(j); }
    if (uv) { U[i * 2] = uv.getX(j); U[i * 2 + 1] = uv.getY(j); }
  }
  return { P, N, U, count: n };
}

/**
 * 同じマテリアルを使う静的メッシュを 1 つに統合する。
 *
 * ワールド行列を頂点に焼き込むので、戻り値は原点に置いたまま使う。
 *
 * @param {THREE.Mesh[]} meshes 統合したいメッシュ (updateMatrixWorld 済み)
 * @param {string} name 生成するメッシュの名前 (デバッグ用)
 * @returns {THREE.Mesh[]} マテリアルごとに 1 つずつのメッシュ
 */
export function mergeByMaterial(meshes, name = 'merged') {
  const buckets = new Map();
  for (const m of meshes) {
    if (!m.isMesh || !m.geometry || Array.isArray(m.material)) continue;
    let b = buckets.get(m.material);
    if (!b) { b = []; buckets.set(m.material, b); }
    b.push(m);
  }

  const out = [];
  let bucketIndex = 0;
  for (const [material, group] of buckets) {
    const parts = [];
    let total = 0;
    const mat3 = new THREE.Matrix3();
    for (const m of group) {
      const e = expand(m.geometry);
      if (!e) continue;
      // ワールド行列を頂点へ焼き込む (家具のようにグループの下にある
      // メッシュでも正しい位置になる)。呼ぶ側で updateMatrixWorld 済みのこと。
      const mat = m.matrixWorld;
      mat3.getNormalMatrix(mat);
      const v = new THREE.Vector3();
      for (let i = 0; i < e.count; i++) {
        v.set(e.P[i * 3], e.P[i * 3 + 1], e.P[i * 3 + 2]).applyMatrix4(mat);
        e.P[i * 3] = v.x; e.P[i * 3 + 1] = v.y; e.P[i * 3 + 2] = v.z;
        v.set(e.N[i * 3], e.N[i * 3 + 1], e.N[i * 3 + 2]).applyMatrix3(mat3).normalize();
        e.N[i * 3] = v.x; e.N[i * 3 + 1] = v.y; e.N[i * 3 + 2] = v.z;
      }
      parts.push(e);
      total += e.count;
    }
    if (!total) continue;

    const P = new Float32Array(total * 3);
    const N = new Float32Array(total * 3);
    const U = new Float32Array(total * 2);
    let o = 0;
    for (const e of parts) {
      P.set(e.P, o * 3); N.set(e.N, o * 3); U.set(e.U, o * 2);
      o += e.count;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `${name}-${bucketIndex++}`;
    // 影の設定は元のメッシュに合わせる (1 つでも落とすなら落とす)
    mesh.castShadow = group.some((m) => m.castShadow);
    mesh.receiveShadow = group.some((m) => m.receiveShadow);
    out.push(mesh);

    // 元のジオメトリはもう使わない
    for (const m of group) m.geometry.dispose();
  }
  return out;
}
