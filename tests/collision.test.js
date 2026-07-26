/**
 * 衝突判定のテスト。
 *
 * 特に「描画した箱と当たり判定の箱が同じ向きか」を確認する。
 * 描画側 (three.js) は mesh.rotation.y で回すので、
 * CollisionWorld.addBox の yaw もそれと同じ向きでなければならない。
 * (斜めに置いた家具や壁がすり抜けたり、見えない所でぶつかったりする)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CollisionWorld } from '../src/core/collision.js';
import { v3 } from '../src/core/math.js';

/** three.js の mesh.rotation.y = yaw と同じ回転 (ローカル → ワールド) */
function threeRotateY(local, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return v3(local.x * c + local.z * s, local.y, -local.x * s + local.z * c);
}

function worldWithBox(half, yaw) {
  const w = new CollisionWorld();
  w.setRoom(40, 20, 40);
  w.addBox(v3(0, 5, 0), half, yaw, 'test');
  return w;
}

test('回転した箱の向きが three.js の mesh.rotation.y と一致する', () => {
  const half = v3(2.0, 0.5, 0.15);      // 細長い板 (ローカル X が長辺)
  for (const yaw of [0.3, -0.7, 1.2, 2.5]) {
    const w = worldWithBox(half, yaw);
    // 長辺の方向 (three.js 規約) に沿った点は箱の中
    const inside = threeRotateY(v3(1.8, 0, 0), yaw);
    inside.y = 5;
    assert.ok(w.contacts(inside, 0.01).length > 0,
      `yaw=${yaw}: 長辺方向の点が箱の外になっている`);
    // 短辺の方向へ同じだけ離れた点は箱の外
    const outside = threeRotateY(v3(0, 0, 1.8), yaw);
    outside.y = 5;
    assert.equal(w.contacts(outside, 0.01).length, 0,
      `yaw=${yaw}: 短辺方向の点が箱の中になっている`);
  }
});

test('接触の法線が three.js 規約の面の向きと一致する', () => {
  const yaw = 0.6;
  const w = worldWithBox(v3(2.0, 0.5, 0.15), yaw);
  // 板の広い面 (ローカル +Z 側) のすぐ外から押し出される向きを見る
  const n = threeRotateY(v3(0, 0, 1), yaw);
  const p = v3(n.x * 0.2, 5, n.z * 0.2);
  const cs = w.contacts(p, 0.1);
  assert.equal(cs.length, 1);
  const dot = cs[0].normal.x * n.x + cs[0].normal.z * n.z;
  assert.ok(dot > 0.99, `法線が面の向きと合わない (dot=${dot.toFixed(3)})`);
});

test('レイキャストも同じ向きで箱に当たる', () => {
  const yaw = -0.9;
  const w = worldWithBox(v3(2.0, 0.5, 0.15), yaw);
  // 長辺方向の外側から中心へ撃つ
  const d = threeRotateY(v3(1, 0, 0), yaw);
  const origin = v3(d.x * 5, 5, d.z * 5);
  const dir = v3(-d.x, 0, -d.z);
  const hit = w.raycast(origin, dir, 10);
  assert.ok(hit.hit, '長辺方向から撃ったレイが当たらない');
  assert.ok(Math.abs(hit.distance - 3.0) < 0.05,
    `当たった距離 ${hit.distance.toFixed(3)} が想定 3.0 とずれている`);
});

test('yaw = 0 / ±90° では回転の向きによらず同じ箱になる', () => {
  // 軸に沿った向きは符号を間違えても同じ箱なので、退化していないことだけ見る
  const w = worldWithBox(v3(2.0, 0.5, 0.15), Math.PI / 2);
  assert.ok(w.contacts(v3(0, 5, 1.8), 0.01).length > 0);
  assert.equal(w.contacts(v3(1.8, 5, 0), 0.01).length, 0);
});
