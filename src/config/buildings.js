/**
 * 複数階建ての建物プリセットと、間取りの記述形式。
 *
 * 間取りは「壁の線分 + 開口 (ドア/窓)」で書く。実在する建物の平面図が
 * 手元にあれば、寸法をそのまま入力すれば再現できる形式にしてある。
 *
 * === 座標系 ===
 * 平面は X (右/東) と Z (奥行、-Z が北) の 2 次元、Y が高さ。
 * 建物の原点は建物中心。壁は始点 (x1,z1) から終点 (x2,z2) への線分で表す。
 *
 * === 壁と開口 ===
 *   wall(x1, z1, x2, z2, { t: 厚み, h: 高さ, o: [開口...] })
 *   開口は壁の始点からの距離 at [m] を中心とする:
 *     door(at, width, height)          出入口 (床から)
 *     win(at, width, height, sill)     窓 (床から sill の高さ)
 *     pass(at, width, height)          開放部 (ホールへの開口など)
 *
 * === 階と縦動線 ===
 * floors[] に各階を書く。elevation は床スラブ上面の高さ。
 * voids[] はスラブに開ける穴 (階段室・吹抜) で、ここを通って上下階へ移動できる。
 * stairs[] は実際の段板を生成する (ドローンは通常吹抜/階段室を上下する)。
 *
 * === 飛行ルート ===
 * routes に点検ルートを書いておくと、自動飛行の「建物ルート」で追従できる。
 * 壁のある建物では経路計画が必要になるため、あらかじめ通れる線を与える方式にしている。
 */

import { clamp } from '../core/math.js';

/* ------------------------------------------------------------------ */
/* 記述用ヘルパ                                                         */
/* ------------------------------------------------------------------ */

/** 壁 (線分) */
export const wall = (x1, z1, x2, z2, opts = {}) => ({
  x1, z1, x2, z2,
  thickness: opts.t ?? 0.12,
  height: opts.h ?? null,          // null = 階高いっぱい
  base: opts.base ?? 0,            // 床からの立ち上がり (腰壁など)
  openings: opts.o ?? [],
  material: opts.mat ?? 'wall',
});

/** 出入口 */
export const door = (at, width = 0.95, height = 2.05) =>
  ({ at, width, height, sill: 0, kind: 'door' });

/** 窓 */
export const win = (at, width = 1.8, height = 1.3, sill = 0.85) =>
  ({ at, width, height, sill, kind: 'window' });

/** 開放部 (壁を抜いた開口) */
export const pass = (at, width = 2.4, height = 2.3) =>
  ({ at, width, height, sill: 0, kind: 'pass' });

/** 矩形の部屋を囲む 4 枚の壁を作る (opts.skip で省く辺を指定) */
export function roomWalls(x0, z0, x1, z1, opts = {}) {
  const skip = opts.skip || [];
  const out = [];
  if (!skip.includes('n')) out.push(wall(x0, z0, x1, z0, opts.n || opts));
  if (!skip.includes('e')) out.push(wall(x1, z0, x1, z1, opts.e || opts));
  if (!skip.includes('s')) out.push(wall(x1, z1, x0, z1, opts.s || opts));
  if (!skip.includes('w')) out.push(wall(x0, z1, x0, z0, opts.w || opts));
  return out;
}

/** 部屋 (家具の自動配置と、名前表示に使う) */
export const room = (name, x0, z0, x1, z1, kind = 'generic', opts = {}) =>
  ({ name, x0, z0, x1, z1, kind, density: opts.density ?? 1, ...opts });

/* ------------------------------------------------------------------ */
/* 床の白線 (体育館のコートなど)                                        */
/* ------------------------------------------------------------------ */
//
// 床に描く線。見た目だけでなく、自己位置推定にとっては「床にしか無い
// 幾何的な特徴」になるので、視覚 SLAM の評価に効く。

/** 直線 */
export const line = (x1, z1, x2, z2, w = 0.05) => ({ kind: 'line', x1, z1, x2, z2, w });
/** 円 */
export const circle = (x, z, r, w = 0.05) => ({ kind: 'arc', x, z, r, a0: 0, a1: Math.PI * 2, w });
/** 円弧 (a0 → a1 [rad]) */
export const arc = (x, z, r, a0, a1, w = 0.05) => ({ kind: 'arc', x, z, r, a0, a1, w });

/** 矩形 (4 本の直線) */
export const rectLines = (x0, z0, x1, z1, w = 0.05) => [
  line(x0, z0, x1, z0, w), line(x1, z0, x1, z1, w),
  line(x1, z1, x0, z1, w), line(x0, z1, x0, z0, w),
];

/**
 * バスケットボールのコート 1 面ぶんの白線。
 *
 * 公式寸法 (FIBA): 28 x 15 m、センターサークル半径 1.8 m、
 * 制限区域 5.8 x 4.9 m、フリースローライン 5.8 m、3 ポイント 6.75 m
 * (サイドラインから 0.9 m の直線部を持つ)。
 * コートの長手は X 方向、中心は (cx, cz)。
 */
export function basketCourt(cx, cz) {
  const L = 28, W = 15;
  const out = [...rectLines(cx - L / 2, cz - W / 2, cx + L / 2, cz + W / 2)];
  out.push(line(cx, cz - W / 2, cx, cz + W / 2));   // センターライン
  out.push(circle(cx, cz, 1.8));                    // センターサークル

  for (const s of [-1, 1]) {                        // 両エンド
    const end = cx + s * L / 2;
    const ft = end - s * 5.8;                       // フリースローライン
    const hoop = end - s * 1.575;                   // リングの中心
    // 制限区域 (キー)
    out.push(line(end, cz - 2.45, ft, cz - 2.45));
    out.push(line(end, cz + 2.45, ft, cz + 2.45));
    out.push(line(ft, cz - 2.45, ft, cz + 2.45));
    out.push(circle(ft, cz, 1.8));                  // フリースローサークル
    // 3 ポイントライン: サイドラインから 0.9m の直線 + 半径 6.75m の円弧
    const zEdge = W / 2 - 0.9;                      // 直線部の z
    const th = Math.asin(zEdge / 6.75);             // 円弧が直線に接する角
    const xTan = hoop - s * 6.75 * Math.cos(th);
    for (const sz of [-1, 1]) {
      out.push(line(end, cz + sz * zEdge, xTan, cz + sz * zEdge));
    }
    // 円弧 (エンドライン側から見て内側へ膨らむ)
    const base = s > 0 ? 0 : Math.PI;
    out.push(arc(hoop, cz, 6.75, base - (s > 0 ? th : -th), base + (s > 0 ? th : -th)));
  }
  return out;
}

/** 点検対象 (工場などの設備。視覚的なランドマークにもなる) */
export const target = (name, x, y, z, kind = 'gauge', opts = {}) =>
  ({ name, x, y, z, kind, yaw: opts.yaw ?? 0, ...opts });

const P = (x, y, z, yaw) => ({ x, y, z, yaw });

/**
 * 矩形から穴 (吹抜) を除いた領域を、格子状に分割した矩形の集合として返す。
 * 当たり判定用のスラブを作るのに使う。
 */
export function rectMinusHoles(rect, holes) {
  const xs = new Set([rect.x0, rect.x1]);
  const zs = new Set([rect.z0, rect.z1]);
  for (const h of holes) {
    for (const x of [h.x0, h.x1]) if (x > rect.x0 && x < rect.x1) xs.add(x);
    for (const z of [h.z0, h.z1]) if (z > rect.z0 && z < rect.z1) zs.add(z);
  }
  const xa = [...xs].sort((a, b) => a - b);
  const za = [...zs].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < xa.length - 1; i++) {
    for (let j = 0; j < za.length - 1; j++) {
      const cell = { x0: xa[i], x1: xa[i + 1], z0: za[j], z1: za[j + 1] };
      const cx = (cell.x0 + cell.x1) / 2, cz = (cell.z0 + cell.z1) / 2;
      const inHole = holes.some((h) => cx > h.x0 && cx < h.x1 && cz > h.z0 && cz < h.z1);
      if (!inHole && cell.x1 - cell.x0 > 1e-6 && cell.z1 - cell.z0 > 1e-6) out.push(cell);
    }
  }
  return out;
}

/**
 * 開口 (ドア・窓) で分割した壁の断片を返す。
 * 各断片は壁に沿った区間 [a, b] と高さ範囲 [y0, y1] を持つ。
 */
export function splitWall(length, height, base, openings) {
  const pieces = [];
  const sorted = [...openings]
    .map((o) => ({ ...o, a: o.at - o.width / 2, b: o.at + o.width / 2 }))
    .filter((o) => o.b > 0 && o.a < length)
    .sort((x, y) => x.a - y.a);

  let cursor = 0;
  for (const o of sorted) {
    const a = clamp(o.a, 0, length);
    const b = clamp(o.b, 0, length);
    if (a > cursor) pieces.push({ a: cursor, b: a, y0: base, y1: height });
    // 開口の下 (窓の腰壁) と上 (まぐさ)
    const sill = base + (o.sill ?? 0);
    const head = Math.min(height, sill + o.height);
    if (sill > base + 1e-6) pieces.push({ a, b, y0: base, y1: sill });
    if (head < height - 1e-6) pieces.push({ a, b, y0: head, y1: height });
    cursor = Math.max(cursor, b);
  }
  if (cursor < length) pieces.push({ a: cursor, b: length, y0: base, y1: height });
  return pieces.filter((p) => p.b - p.a > 1e-6 && p.y1 - p.y0 > 1e-6);
}

/* ------------------------------------------------------------------ */
/* 建物プリセット                                                       */
/* ------------------------------------------------------------------ */

/**
 * 学校校舎 (3 階建・片廊下型)。
 *
 * 日本の学校でもっとも一般的な形式。南側に普通教室を並べ、北側に廊下、
 * 両端に階段室を置く。寸法は標準的な値 (教室 8.0 x 8.0 m、廊下幅 2.5 m、
 * 階高 3.5 m) にしてある。実際の校舎の平面図があれば、
 * 教室の数と寸法を差し替えるだけで再現できる。
 */
function schoolBuilding() {
  const nClass = 4;
  const cw = 8.0;          // 教室の幅
  const cd = 8.0;          // 教室の奥行
  const corridor = 2.5;    // 廊下幅
  const stairW = 4.0;      // 階段室の幅
  const W = stairW * 2 + cw * nClass;      // 40 m
  const D = cd + corridor;                 // 10.5 m
  const x0 = -W / 2, z0 = -D / 2;
  const zCorr = z0 + corridor;             // 廊下と教室の境界
  const zEnd = z0 + D;
  const H = 3.5;

  const floors = [];
  for (let f = 0; f < 3; f++) {
    const walls = [];
    // 外周
    walls.push(wall(x0, z0, x0 + W, z0, { t: 0.2, o: [win(6, 2.0, 1.4, 1.0), win(14, 2.0, 1.4, 1.0), win(26, 2.0, 1.4, 1.0), win(34, 2.0, 1.4, 1.0)] }));
    walls.push(wall(x0 + W, z0, x0 + W, zEnd, { t: 0.2 }));
    // 南面は教室の大きな窓
    const southOpenings = [];
    for (let i = 0; i < nClass; i++) {
      const cx = stairW + i * cw + cw / 2;
      southOpenings.push(win(W - cx - 2.0, 2.2, 1.5, 0.85));
      southOpenings.push(win(W - cx + 2.0, 2.2, 1.5, 0.85));
    }
    walls.push(wall(x0 + W, zEnd, x0, zEnd, { t: 0.2, o: southOpenings }));
    walls.push(wall(x0, zEnd, x0, z0, { t: 0.2 }));

    // 廊下と教室を仕切る壁 (教室ごとに引戸)
    for (let i = 0; i < nClass; i++) {
      const sx = x0 + stairW + i * cw;
      walls.push(wall(sx, zCorr, sx + cw, zCorr, {
        t: 0.1, o: [door(1.2, 1.6, 2.1), win(4.5, 2.4, 1.0, 1.1), door(6.8, 1.6, 2.1)],
      }));
      // 教室間の間仕切り
      if (i > 0) walls.push(wall(sx, zCorr, sx, zEnd, { t: 0.1 }));
    }
    // 階段室の仕切り
    walls.push(wall(x0 + stairW, z0, x0 + stairW, zEnd, { t: 0.15, o: [pass(1.2, 1.8, 2.2)] }));
    walls.push(wall(x0 + W - stairW, z0, x0 + W - stairW, zEnd, { t: 0.15, o: [pass(1.2, 1.8, 2.2)] }));
    // 教室の南端 (廊下側から見て奥) の仕切りは外壁で兼ねる

    const rooms = [];
    for (let i = 0; i < nClass; i++) {
      const sx = x0 + stairW + i * cw;
      rooms.push(room(`${f + 1}F 教室${i + 1}`, sx + 0.2, zCorr + 0.2, sx + cw - 0.2, zEnd - 0.2,
        'classroom', { density: 1.0 }));
    }
    rooms.push(room(`${f + 1}F 廊下`, x0 + stairW, z0 + 0.2, x0 + W - stairW, zCorr - 0.1, 'corridor', { density: 0.25 }));

    floors.push({
      name: `${f + 1}F`,
      elevation: f * H,
      height: H,
      outline: { x0, z0, x1: x0 + W, z1: zEnd },
      walls,
      rooms,
      // 両端の階段室をスラブの穴にして上下移動できるようにする
      voids: f === 0 ? [] : [
        { x0: x0 + 0.3, z0: z0 + 0.3, x1: x0 + stairW - 0.3, z1: zEnd - 0.3 },
        { x0: x0 + W - stairW + 0.3, z0: z0 + 0.3, x1: x0 + W - 0.3, z1: zEnd - 0.3 },
      ],
      stairs: f < 2 ? [
        { x: x0 + stairW / 2, z: 0, width: 1.4, dir: 1, rise: H },
        { x: x0 + W - stairW / 2, z: 0, width: 1.4, dir: -1, rise: H },
      ] : [],
    });
  }

  const routes = {
    // 各階の廊下を往復し、西側の階段室で上階へ移動する点検ルート
    patrol: (() => {
      const pts = [];
      const xW = x0 + stairW / 2, xE = x0 + W - stairW / 2;
      const zc = z0 + corridor / 2;
      for (let f = 0; f < 3; f++) {
        const y = f * H + 1.4;
        pts.push(P(xW, y, zc, 0));
        pts.push(P(xE, y, zc, 0));
        pts.push(P(xE, y, zc, 0));
        pts.push(P(xW, y, zc, 0));
        if (f < 2) pts.push(P(xW, y + H, zc, 0));   // 階段室を上昇
      }
      return pts;
    })(),
    // 1 階の教室内を見て回るルート
    classroom: (() => {
      const pts = [];
      const zc = z0 + corridor / 2;
      for (let i = 0; i < nClass; i++) {
        const cx = x0 + 4 + i * cw + cw / 2;
        pts.push(P(cx, 1.4, zc, 0));
        pts.push(P(cx, 1.4, zCorr + 3.0, 0));
        pts.push(P(cx, 1.4, zEnd - 1.5, 0));
        pts.push(P(cx, 1.4, zCorr + 3.0, 0));
        pts.push(P(cx, 1.4, zc, 0));
      }
      return pts;
    })(),
  };

  return {
    name: '学校校舎 (3階建・片廊下型)',
    description: '普通教室 4 室 + 廊下 + 両端の階段室を 3 層。'
      + '階段室の吹抜を通って上下階を移動できる。日本の校舎で最も一般的な形式。',
    size: { width: W, depth: D, height: H * 3 },
    // 初期位置は西側の階段室 (階段板を避けた北寄り)
    spawn: { x: x0 + stairW / 2, z: z0 + 0.8 },
    floors,
    routes,
    materials: {
      floor: { kind: 'wood', color: '#c19a6b', repeat: 8, roughness: 0.35 },
      corridorFloor: { kind: 'tile', color: '#d6d3cb', repeat: 10, roughness: 0.3 },
      wall: { kind: 'paint', color: '#e8e5de', repeat: 4, roughness: 0.7 },
      ceiling: { kind: 'ceiling', color: '#f2f1ee', repeat: 5, roughness: 0.9 },
      exterior: { kind: 'concrete', color: '#c8c5be', repeat: 6, roughness: 0.8 },
    },
    lighting: 'fluorescent',
    lightsPerFloor: { rows: 2, cols: 6 },
  };
}

/**
 * 公民館 / 庁舎 (2 階建・吹抜ロビー)。
 *
 * 1 階にエントランスホール (2 層吹抜)、事務室、和室、調理室。
 * 2 階に大会議室と小会議室。吹抜を通って上下階を行き来できる。
 */
function communityBuilding() {
  const W = 24, D = 16, H = 3.6;
  const x0 = -W / 2, z0 = -D / 2, x1 = W / 2, z1 = D / 2;

  // 公共施設なので出入口は両開き相当の広さにする。
  // ルートはこのドアの中心を通るように組み立てる (routes を参照)。
  const dW = 1.8, dH = 2.2;
  const doorOffice = { x: x0 + 8, z: z0 + 3 };     // 事務室の入口
  const doorTatami = { x: x0 + 16, z: z0 + 3 };    // 和室の入口

  // 1F
  const f1Walls = [
    ...roomWalls(x0, z0, x1, z1, { t: 0.25 }),
    // ロビー (中央) と各室の仕切り
    wall(x0 + 8, z0, x0 + 8, z1 - 4, { t: 0.12, o: [door(3.0, dW, dH), win(7.5, 2.0, 1.2, 1.0)] }),
    wall(x0 + 16, z0, x0 + 16, z1 - 4, { t: 0.12, o: [door(3.0, dW, dH), win(7.5, 2.0, 1.2, 1.0)] }),
    wall(x0, z1 - 4, x0 + 8, z1 - 4, { t: 0.12, o: [door(4.0, dW, dH)] }),
    wall(x0 + 16, z1 - 4, x1, z1 - 4, { t: 0.12, o: [door(4.0, dW, dH)] }),
  ];
  f1Walls[0].openings = [pass(12, 3.6, 2.4)];        // 正面エントランス
  f1Walls[2].openings = [win(6, 3.0, 1.6, 1.0), win(18, 3.0, 1.6, 1.0)];

  // 2F: 吹抜の周りに会議室
  const f2Walls = [
    ...roomWalls(x0, z0, x1, z1, { t: 0.25 }),
    wall(x0 + 8, z0, x0 + 8, z1, { t: 0.12, o: [door(4.0, dW, dH)] }),
    wall(x0 + 16, z0, x0 + 16, z1, { t: 0.12, o: [door(4.0, dW, dH)] }),
    // 吹抜の手すり (腰壁)
    wall(x0 + 8, z0 + 4, x0 + 16, z0 + 4, { t: 0.08, h: 1.1 }),
    wall(x0 + 16, z0 + 4, x0 + 16, z0 + 12, { t: 0.08, h: 1.1 }),
    wall(x0 + 16, z0 + 12, x0 + 8, z0 + 12, { t: 0.08, h: 1.1 }),
    wall(x0 + 8, z0 + 12, x0 + 8, z0 + 4, { t: 0.08, h: 1.1 }),
  ];

  const atrium = { x0: x0 + 8.2, z0: z0 + 4.2, x1: x0 + 15.8, z1: z0 + 11.8 };

  return {
    name: '公民館 (2階建・吹抜ロビー)',
    description: '1 階にエントランスホール (2 層吹抜)・事務室・和室、2 階に会議室。'
      + '吹抜を通って上下階を移動できる。公共施設の典型的な構成。',
    size: { width: W, depth: D, height: H * 2 },
    spawn: { x: 0, z: z1 - 1.4 },          // エントランス入ってすぐ
    floors: [
      {
        name: '1F', elevation: 0, height: H,
        outline: { x0, z0, x1, z1 },
        walls: f1Walls,
        rooms: [
          room('事務室', x0 + 0.3, z0 + 0.3, x0 + 7.7, z1 - 4.3, 'office'),
          room('エントランスホール', x0 + 8.3, z0 + 0.3, x0 + 15.7, z1 - 0.3, 'lobby', { density: 0.4 }),
          room('和室', x0 + 16.3, z0 + 0.3, x1 - 0.3, z1 - 4.3, 'meeting'),
          room('調理室', x0 + 0.3, z1 - 3.7, x0 + 7.7, z1 - 0.3, 'kitchen'),
          room('倉庫', x0 + 16.3, z1 - 3.7, x1 - 0.3, z1 - 0.3, 'storage'),
        ],
        voids: [],
        stairs: [{ x: x0 + 12, z: z0 + 13.5, width: 1.6, dir: -1, rise: H }],
      },
      {
        name: '2F', elevation: H, height: H,
        outline: { x0, z0, x1, z1 },
        walls: f2Walls,
        rooms: [
          room('大会議室', x0 + 0.3, z0 + 0.3, x0 + 7.7, z1 - 0.3, 'meeting'),
          room('小会議室', x0 + 16.3, z0 + 0.3, x1 - 0.3, z1 - 0.3, 'meeting'),
          room('2F 回廊', x0 + 8.3, z0 + 12.2, x0 + 15.7, z1 - 0.3, 'corridor', { density: 0.3 }),
        ],
        voids: [atrium],
        stairs: [],
      },
    ],
    routes: {
      // ロビー → 事務室 → 吹抜を上昇 → 2F 大会議室 → 小会議室 → 降りる。
      // 仕切りはドアの中心を通る (壁を抜けないことは tests/building.test.js で検査)。
      patrol: [
        P(0, 1.5, z1 - 2, 0),                            // ロビー南
        P(0, 1.5, doorOffice.z, 0),                      // 事務室ドアの正面
        P(doorOffice.x, 1.5, doorOffice.z, 0),           // ドア通過
        P(x0 + 4, 1.5, doorOffice.z, 0),                 // 事務室
        P(doorOffice.x, 1.5, doorOffice.z, 0),
        P(0, 1.5, doorTatami.z, 0),
        P(doorTatami.x, 1.5, doorTatami.z, 0),           // 和室ドア通過
        P(x1 - 4, 1.5, doorTatami.z, 0),                 // 和室
        P(doorTatami.x, 1.5, doorTatami.z, 0),
        P(0, 1.5, 0, 0),                                 // 吹抜の真下
        P(0, H + 1.5, 0, 0),                             // 吹抜を上昇 (手すり天端 H+1.1 より上)
        P(0, H + 1.5, z0 + 4, 0),                        // 2F ドアの正面
        P(x0 + 8, H + 1.5, z0 + 4, 0),                   // 大会議室ドア通過
        P(x0 + 4, H + 1.5, z0 + 4, 0),                   // 大会議室
        P(x0 + 8, H + 1.5, z0 + 4, 0),
        P(0, H + 1.5, z0 + 4, 0),
        P(x0 + 16, H + 1.5, z0 + 4, 0),                  // 小会議室ドア通過
        P(x1 - 4, H + 1.5, z0 + 4, 0),                   // 小会議室
        P(x0 + 16, H + 1.5, z0 + 4, 0),
        P(0, H + 1.5, z0 + 4, 0),
        P(0, H + 1.5, 0, 0), P(0, 1.5, 0, 0),            // 吹抜を降りる
      ],
    },
    materials: {
      floor: { kind: 'tile', color: '#d9d5cc', repeat: 6, roughness: 0.3 },
      corridorFloor: { kind: 'tile', color: '#d9d5cc', repeat: 6, roughness: 0.3 },
      wall: { kind: 'paint', color: '#efece5', repeat: 3, roughness: 0.7 },
      ceiling: { kind: 'ceiling', color: '#f6f5f2', repeat: 4, roughness: 0.9 },
      exterior: { kind: 'concrete', color: '#bfbcb5', repeat: 5, roughness: 0.8 },
    },
    lighting: 'fluorescent',
    lightsPerFloor: { rows: 2, cols: 4 },
  };
}

/**
 * 工場 (生産棟 + 2 階メザニン)。設備点検の飛行を想定した環境。
 *
 * 1 階は高天井 (9 m) の生産エリアで、機械・配管・タンクが並ぶ。
 * 2 階はキャットウォーク (点検通路) が生産エリアを見下ろす形で回っていて、
 * 制御室もここにある。配管・圧力計・バルブ・電気盤を点検対象として配置する。
 */
function factoryBuilding() {
  const W = 30, D = 20, H1 = 9.0, H2 = 3.2;
  const x0 = -W / 2, z0 = -D / 2, x1 = W / 2, z1 = D / 2;
  const catwalkY = 4.5;        // キャットウォークの高さ
  const catwalkW = 2.0;

  // 1F 外周 (大きなシャッターと明かり取り)
  const f1Walls = [
    wall(x0, z0, x1, z0, { t: 0.3, o: [win(6, 4, 2, 5.5), win(15, 4, 2, 5.5), win(24, 4, 2, 5.5)] }),
    wall(x1, z0, x1, z1, { t: 0.3, o: [pass(10, 5.0, 4.5)] }),        // 搬入口
    wall(x1, z1, x0, z1, { t: 0.3, o: [win(6, 4, 2, 5.5), win(15, 4, 2, 5.5), win(24, 4, 2, 5.5)] }),
    wall(x0, z1, x0, z0, { t: 0.3, o: [door(10, 1.2, 2.1)] }),
    // 制御室 (北西の一角、2 層分の壁)
    wall(x0 + 8, z0, x0 + 8, z0 + 6, { t: 0.15, h: H1, o: [door(3, 1.0, 2.1)] }),
    wall(x0, z0 + 6, x0 + 8, z0 + 6, { t: 0.15, h: H1, o: [win(4, 3.0, 1.5, 1.0)] }),
  ];

  // 2F: キャットウォーク (生産エリアの周囲を巡る通路) + 制御室上部
  const f2Walls = [
    // 手すり (内側)
    wall(x0 + catwalkW, z0 + catwalkW, x1 - catwalkW, z0 + catwalkW, { t: 0.06, h: 1.1 }),
    wall(x1 - catwalkW, z0 + catwalkW, x1 - catwalkW, z1 - catwalkW, { t: 0.06, h: 1.1 }),
    wall(x1 - catwalkW, z1 - catwalkW, x0 + catwalkW, z1 - catwalkW, { t: 0.06, h: 1.1 }),
    wall(x0 + catwalkW, z1 - catwalkW, x0 + catwalkW, z0 + catwalkW, { t: 0.06, h: 1.1 }),
  ];

  const targets = [
    target('圧力計 P-101', x0 + 6, 1.6, z0 + 12, 'gauge'),
    target('圧力計 P-102', x0 + 14, 1.6, z0 + 12, 'gauge'),
    target('バルブ V-201', x0 + 20, 2.2, z0 + 4, 'valve'),
    target('バルブ V-202', x0 + 24, 2.2, z0 + 4, 'valve'),
    target('電気盤 EP-1', x0 + 2.5, 1.8, z0 + 14, 'panel', { yaw: Math.PI / 2 }),
    target('タンク T-1 液面計', x0 + 18.3, 3.2, z0 + 14, 'gauge', { yaw: -Math.PI / 2 }),
    target('配管継手 J-12', x0 + 10, catwalkY + 1.2, z0 + 3, 'joint'),
    target('配管継手 J-13', x0 + 18, catwalkY + 1.2, z0 + 3, 'joint'),
  ];

  return {
    name: '工場 (生産棟 + 点検キャットウォーク)',
    description: '高天井 9 m の生産エリアに機械・配管・タンクを配置し、'
      + '高さ 4.5 m のキャットウォークが周囲を巡る。'
      + '圧力計・バルブ・電気盤などの点検対象を置いてあり、施設点検の飛行に使える。',
    size: { width: W, depth: D, height: H1 },
    spawn: { x: x0 + 10, z: z0 + 17.5 },   // 搬入口まわりの空きスペース
    floors: [
      {
        name: '1F 生産エリア', elevation: 0, height: H1,
        outline: { x0, z0, x1, z1 },
        walls: f1Walls,
        rooms: [
          room('制御室', x0 + 0.3, z0 + 0.3, x0 + 7.7, z0 + 5.7, 'office'),
          room('生産エリア 北', x0 + 8.5, z0 + 0.5, x1 - 0.5, z0 + 9, 'factory', { density: 1.2 }),
          room('生産エリア 南', x0 + 0.5, z0 + 10, x1 - 0.5, z1 - 0.5, 'factory', { density: 1.4 }),
        ],
        voids: [],
        stairs: [{ x: x0 + 4, z: z1 - 3, width: 1.2, dir: 1, rise: catwalkY }],
        // 生産エリア特有の設備
        equipment: {
          pipes: [
            { x0: x0 + 2, y: 6.5, z0: z0 + 2, x1: x1 - 2, z1: z0 + 2, r: 0.25 },
            { x0: x0 + 2, y: 7.2, z0: z0 + 3, x1: x1 - 2, z1: z0 + 3, r: 0.18 },
            { x0: x0 + 2, y: 6.0, z0: z1 - 2, x1: x1 - 2, z1: z1 - 2, r: 0.3 },
          ],
          tanks: [
            { x: x0 + 20, z: z0 + 14, r: 1.6, h: 4.5 },
            { x: x0 + 23, z: z0 + 14, r: 1.0, h: 3.0 },
          ],
          craneRail: { y: H1 - 0.9 },
        },
      },
      {
        name: '2F キャットウォーク', elevation: catwalkY, height: H2,
        outline: { x0, z0, x1, z1 },
        walls: f2Walls,
        rooms: [],
        // 中央は吹抜 (通路の内側は床が無い)
        voids: [{ x0: x0 + catwalkW, z0: z0 + catwalkW, x1: x1 - catwalkW, z1: z1 - catwalkW }],
        stairs: [],
        noCeiling: true,
      },
    ],
    targets,
    routes: {
      // 生産エリアを低空で見て回り、キャットウォークの高さまで上がって配管を点検する
      inspection: [
        P(x0 + 6, 1.6, z0 + 12, 0), P(x0 + 14, 1.6, z0 + 12, 0),
        P(x0 + 20, 2.2, z0 + 6, 0), P(x0 + 24, 2.2, z0 + 4, 0),
        P(x0 + 24, 2.4, z0 + 10, 0),                     // タンクの北を回り込む
        P(x0 + 15, 3.2, z0 + 10, 0),
        P(x0 + 15, 3.2, z0 + 14, 0),
        P(x0 + 17.4, 3.2, z0 + 14, 0),                   // T-1 液面計の手前 (胴体から 2.6 m)
        P(x0 + 17.4, catwalkY + 1.3, z0 + 14, 0),        // キャットウォークの高さまで上昇
        P(x0 + 18, catwalkY + 1.3, z0 + 3.2, 0), P(x0 + 10, catwalkY + 1.3, z0 + 3.2, 0),
        // 制御室 (x0〜x0+8, z0〜z0+6) は 2 層ぶんの壁なので上を通り抜けられない。
        // いったん南へ回り込んでから電気盤の高さへ降りる。
        P(x0 + 10, catwalkY + 1.3, z0 + 10, 0),
        P(x0 + 3, catwalkY + 1.3, z0 + 10, 0),
        P(x0 + 3, 1.8, z0 + 14, 0),
      ],
      // 生産エリアを一周してからキャットウォークの高さで同じ経路をたどる。
      // 北西の制御室 (x0〜x0+8, z0〜z0+6) は 2 層ぶんの壁なので、その東側を通る。
      patrol: [
        P(x0 + 10, 2.0, z0 + 4, 0), P(x1 - 4, 2.0, z0 + 4, 0),
        P(x1 - 4, 2.0, z1 - 4, 0), P(x0 + 4, 2.0, z1 - 4, 0),
        P(x0 + 4, catwalkY + 1.3, z1 - 4, 0), P(x1 - 4, catwalkY + 1.3, z1 - 4, 0),
        P(x1 - 4, catwalkY + 1.3, z0 + 4, 0), P(x0 + 10, catwalkY + 1.3, z0 + 4, 0),
      ],
    },
    materials: {
      floor: { kind: 'concrete', color: '#9fa3a0', repeat: 10, roughness: 0.75 },
      corridorFloor: { kind: 'plain', color: '#6e7378', repeat: 8, roughness: 0.6, metalness: 0.4 },
      wall: { kind: 'concrete', color: '#b0aea9', repeat: 6, roughness: 0.85 },
      ceiling: { kind: 'plain', color: '#7d8287', repeat: 6, roughness: 0.9 },
      exterior: { kind: 'concrete', color: '#a8a6a1', repeat: 6, roughness: 0.85 },
    },
    lighting: 'highbay',
    lightsPerFloor: { rows: 3, cols: 4 },
  };
}

/**
 * 事務所ビル (3 階建・中廊下型)。
 * 中央に廊下、その両側に居室。エレベータシャフトと階段室で上下移動。
 */
function officeBuilding() {
  const W = 28, D = 14, H = 3.3;
  const x0 = -W / 2, z0 = -D / 2, x1 = W / 2, z1 = D / 2;
  const corridor = 2.2;
  const zc0 = -corridor / 2, zc1 = corridor / 2;
  const coreX = x0 + 4;      // 階段室 + EV シャフト

  const floors = [];
  for (let f = 0; f < 3; f++) {
    const walls = [
      wall(x0, z0, x1, z0, { t: 0.25, o: [win(6, 2.4, 1.5, 0.9), win(12, 2.4, 1.5, 0.9), win(18, 2.4, 1.5, 0.9), win(24, 2.4, 1.5, 0.9)] }),
      wall(x1, z0, x1, z1, { t: 0.25, o: [win(7, 2.4, 1.5, 0.9)] }),
      wall(x1, z1, x0, z1, { t: 0.25, o: [win(6, 2.4, 1.5, 0.9), win(12, 2.4, 1.5, 0.9), win(18, 2.4, 1.5, 0.9), win(24, 2.4, 1.5, 0.9)] }),
      wall(x0, z1, x0, z0, { t: 0.25 }),
      // 廊下の両側
      wall(x0 + 8, zc0, x1, zc0, { t: 0.1, o: [door(4), door(12), door(18)] }),
      wall(x0 + 8, zc1, x1, zc1, { t: 0.1, o: [door(4), door(12), door(18)] }),
      // 居室の間仕切り
      wall(x0 + 15, z0, x0 + 15, zc0, { t: 0.1 }),
      wall(x0 + 21, z0, x0 + 21, zc0, { t: 0.1 }),
      wall(x0 + 15, zc1, x0 + 15, z1, { t: 0.1 }),
      wall(x0 + 21, zc1, x0 + 21, z1, { t: 0.1 }),
      // コア (階段室) の壁
      wall(x0 + 8, z0, x0 + 8, z1, { t: 0.15, o: [pass(7, 2.0, 2.2)] }),
    ];
    floors.push({
      name: `${f + 1}F`,
      elevation: f * H,
      height: H,
      outline: { x0, z0, x1, z1 },
      walls,
      rooms: [
        room(`${f + 1}F 執務室 北A`, x0 + 8.3, z0 + 0.3, x0 + 14.7, zc0 - 0.2, 'office'),
        room(`${f + 1}F 執務室 北B`, x0 + 15.3, z0 + 0.3, x0 + 20.7, zc0 - 0.2, 'office'),
        room(`${f + 1}F 執務室 北C`, x0 + 21.3, z0 + 0.3, x1 - 0.3, zc0 - 0.2, 'office'),
        room(`${f + 1}F 執務室 南A`, x0 + 8.3, zc1 + 0.2, x0 + 14.7, z1 - 0.3, 'office'),
        room(`${f + 1}F 執務室 南B`, x0 + 15.3, zc1 + 0.2, x0 + 20.7, z1 - 0.3, 'office'),
        room(`${f + 1}F 執務室 南C`, x0 + 21.3, zc1 + 0.2, x1 - 0.3, z1 - 0.3, 'office'),
        room(`${f + 1}F 廊下`, x0 + 8.3, zc0, x1 - 0.3, zc1, 'corridor', { density: 0.2 }),
      ],
      voids: f === 0 ? [] : [{ x0: x0 + 0.3, z0: z0 + 0.3, x1: x0 + 7.7, z1: z1 - 0.3 }],
      stairs: f < 2 ? [{ x: coreX, z: 0, width: 1.4, dir: 1, rise: H }] : [],
    });
  }

  return {
    name: '事務所ビル (3階建・中廊下型)',
    description: '中央に廊下、両側に執務室。西側のコア (階段室) の吹抜で上下階を移動する。',
    size: { width: W, depth: D, height: H * 3 },
    spawn: { x: coreX, z: z1 - 1.2 },      // 1F コア (階段室) の南端
    floors,
    routes: {
      patrol: (() => {
        const pts = [];
        for (let f = 0; f < 3; f++) {
          const y = f * H + 1.4;
          pts.push(P(coreX, y, 0, 0));
          pts.push(P(x1 - 2, y, 0, 0));
          pts.push(P(coreX, y, 0, 0));
          if (f < 2) pts.push(P(coreX, y + H, 0, 0));
        }
        return pts;
      })(),
    },
    materials: {
      floor: { kind: 'carpet', color: '#5b6470', repeat: 8, roughness: 0.9 },
      corridorFloor: { kind: 'carpet', color: '#4d5560', repeat: 8, roughness: 0.9 },
      wall: { kind: 'paint', color: '#eceae5', repeat: 4, roughness: 0.7 },
      ceiling: { kind: 'ceiling', color: '#f4f3f0', repeat: 5, roughness: 0.9 },
      exterior: { kind: 'concrete', color: '#c2bfb8', repeat: 6, roughness: 0.8 },
    },
    lighting: 'fluorescent',
    lightsPerFloor: { rows: 2, cols: 5 },
  };
}

/**
 * 体育館 (バスケットコート 2 面・高天井)。
 *
 * 日本の学校・公共施設によくある「2 面取れるアリーナ」。
 * 34 x 36 m・天井高 12 m の一室空間に、コート 2 面ぶんの白線を引き、
 * 高さ 5 m にギャラリー (回廊) を回してある。
 *
 * この環境が効くところ:
 *   - **広くて特徴の乏しい空間** — 壁が遠く、床の白線とゴールくらいしか
 *     手掛かりが無い。視覚 SLAM がスケールを見失いやすい条件を作れる。
 *   - **高い天井** — 高度方向に大きく動ける。気圧計・ToF の評価に。
 *   - **ギャラリー** — 上下 2 層の飛行と、俯瞰からの観測が試せる。
 */
function gymBuilding() {
  const W = 34, D = 36, H = 12;          // アリーナ (天井高 12m)
  const x0 = -W / 2, z0 = -D / 2, x1 = W / 2, z1 = D / 2;
  const galleryY = 5.0;                  // ギャラリー (回廊) の高さ
  const galleryW = 2.2;                  // 回廊の幅
  const courtZ = 8.0;                    // 2 面のコート中心 (z = ±8)
  const stage = { x0: x0 + 6, z0: z1 - 4.5, x1: x1 - 6, z1, h: 0.9 };

  // 1F 外周。高い位置に明かり取りの窓を並べる (体育館らしい採光)。
  const highWin = (n, len) => {
    const o = [];
    for (let i = 0; i < n; i++) o.push(win(len * (i + 0.5) / n, 3.2, 2.4, 6.4));
    return o;
  };
  const f1Walls = [
    wall(x0, z0, x1, z0, { t: 0.3, o: [...highWin(4, W), pass(W / 2 - 2.4, 2.4, 2.4)] }),
    wall(x1, z0, x1, z1, { t: 0.3, o: highWin(4, D) }),
    wall(x1, z1, x0, z1, { t: 0.3, o: highWin(4, W) }),
    wall(x0, z1, x0, z0, { t: 0.3, o: [...highWin(4, D), door(D - 3, 1.6, 2.2)] }),
    // 器具庫 (南西の一角)
    wall(x0 + 6, z0, x0 + 6, z0 + 5, { t: 0.15, h: 3.0, o: [door(2.5, 1.6, 2.2)] }),
    wall(x0, z0 + 5, x0 + 6, z0 + 5, { t: 0.15, h: 3.0 }),
  ];

  // 2F ギャラリー: 内側に手すり (腰壁)
  const gi = { x0: x0 + galleryW, z0: z0 + galleryW, x1: x1 - galleryW, z1: z1 - galleryW };
  const f2Walls = [
    wall(gi.x0, gi.z0, gi.x1, gi.z0, { t: 0.06, h: 1.1 }),
    wall(gi.x1, gi.z0, gi.x1, gi.z1, { t: 0.06, h: 1.1 }),
    wall(gi.x1, gi.z1, gi.x0, gi.z1, { t: 0.06, h: 1.1 }),
    wall(gi.x0, gi.z1, gi.x0, gi.z0, { t: 0.06, h: 1.1 }),
  ];

  // バスケットゴール 4 基 (コート 2 面 x 両エンド)。リング中心は床から 3.05m。
  const goals = [];
  for (const cz of [-courtZ, courtZ]) {
    for (const s of [-1, 1]) {
      // yaw はコート中央 (x=0) を向く向き。ローカル +z がリング側。
      goals.push(target(`ゴール ${cz < 0 ? 'A' : 'B'}${s < 0 ? '西' : '東'}`,
        s * (14 - 1.575), 3.05, cz, 'hoop',
        { yaw: s > 0 ? -Math.PI / 2 : Math.PI / 2, arm: W / 2 - (14 - 1.575) - 0.2 }));
    }
  }

  return {
    name: '体育館 (バスケットコート 2 面・高天井)',
    description: '34 x 36 m・天井高 12 m のアリーナにコート 2 面ぶんの白線とゴール 4 基。'
      + '高さ 5 m のギャラリー (回廊) が周囲を巡る。壁が遠く手掛かりの乏しい'
      + '広い空間なので、視覚 SLAM がスケールを見失う条件の評価に向く。',
    size: { width: W, depth: D, height: H },
    spawn: { x: 0, z: z0 + 2.0 },          // 正面入口の内側
    floors: [
      {
        name: '1F アリーナ', elevation: 0, height: H,
        outline: { x0, z0, x1, z1 },
        walls: f1Walls,
        rooms: [
          // 広いので 2 面ぶんに分けて灯具を配る (lights で灯数を指定)
          room('アリーナ (A コート)', x0 + 0.5, z0 + 0.5, x1 - 0.5, -0.5, 'gym',
            { density: 0.12, lights: 6 }),
          room('アリーナ (B コート)', x0 + 0.5, 0.5, x1 - 0.5, z1 - 5.0, 'gym',
            { density: 0.12, lights: 6 }),
          room('器具庫', x0 + 0.4, z0 + 0.4, x0 + 5.6, z0 + 4.6, 'storage', { density: 1.2 }),
        ],
        voids: [],
        stairs: [{ x: x0 + 1.1, z: z1 - 8, width: 1.2, dir: -1, rise: galleryY }],
        markings: [...basketCourt(0, -courtZ), ...basketCourt(0, courtZ)],
        equipment: {
          // ステージ (舞台) と、天井の鉄骨トラス
          platforms: [stage],
          trusses: { y: H - 1.1, count: 5, axis: 'x' },
        },
      },
      {
        name: '2F ギャラリー', elevation: galleryY, height: H - galleryY,
        outline: { x0, z0, x1, z1 },
        walls: f2Walls,
        rooms: [],
        voids: [gi],                      // 中央はアリーナの吹抜
        stairs: [],
        noCeiling: true,                  // 屋根は 1F 側で張る
      },
    ],
    targets: goals,
    routes: {
      // アリーナを低空で一周 → ギャラリーへ上がってもう一周
      patrol: [
        P(0, 1.6, z0 + 4, 0), P(x1 - 4, 1.6, z0 + 4, 0),
        P(x1 - 4, 1.6, z1 - 6, 0), P(x0 + 4, 1.6, z1 - 6, 0),
        P(x0 + 4, galleryY + 1.4, z1 - 6, 0), P(x1 - 4, galleryY + 1.4, z1 - 6, 0),
        P(x1 - 4, galleryY + 1.4, z0 + 4, 0), P(x0 + 4, galleryY + 1.4, z0 + 4, 0),
        P(0, galleryY + 1.4, z0 + 4, 0), P(0, 1.6, z0 + 4, 0),
      ],
      // 4 基のゴールを順に正面から見る (高さ 3m のランドマーク)
      goals: [
        P(0, 3.2, -courtZ, 0),
        P(14 - 4.5, 3.2, -courtZ, 0), P(0, 3.2, -courtZ, 0),
        P(-(14 - 4.5), 3.2, -courtZ, 0), P(0, 3.2, 0, 0),
        P(0, 3.2, courtZ, 0),
        P(14 - 4.5, 3.2, courtZ, 0), P(0, 3.2, courtZ, 0),
        P(-(14 - 4.5), 3.2, courtZ, 0), P(0, 3.2, 0, 0),
      ],
      // 天井付近をなめるように飛ぶ (高度方向の評価用)
      ceiling: [
        P(x0 + 5, H - 2.2, z0 + 5, 0), P(x1 - 5, H - 2.2, z0 + 5, 0),
        P(x1 - 5, H - 2.2, z1 - 5, 0), P(x0 + 5, H - 2.2, z1 - 5, 0),
        P(x0 + 5, 1.6, z1 - 6, 0),
      ],
    },
    materials: {
      floor: { kind: 'wood', color: '#d2a464', repeat: 14, roughness: 0.28 },
      corridorFloor: { kind: 'wood', color: '#d2a464', repeat: 14, roughness: 0.28 },
      wall: { kind: 'paint', color: '#e3e6e2', repeat: 8, roughness: 0.75 },
      ceiling: { kind: 'plain', color: '#8d939a', repeat: 8, roughness: 0.9 },
      exterior: { kind: 'plain', color: '#9aa1a8', repeat: 8, roughness: 0.85 },
      marking: { color: '#f4f6f8' },
    },
    lighting: 'highbay',
    lightsPerFloor: { rows: 2, cols: 5 },
  };
}

export const BUILDING_PRESETS = {
  school: schoolBuilding(),
  gym: gymBuilding(),
  community: communityBuilding(),
  factory: factoryBuilding(),
  office: officeBuilding(),
};

export const BUILDING_KEYS = Object.keys(BUILDING_PRESETS);

/** 部屋の種類ごとに置く家具 */
export const ROOM_FURNITURE = {
  classroom: ['desk', 'chair', 'chair', 'cabinet', 'monitor'],
  office: ['desk', 'chair', 'cabinet', 'monitor', 'shelf', 'plant'],
  meeting: ['table', 'chair', 'chair', 'chair', 'monitor'],
  lobby: ['sofa', 'plant', 'bench', 'table'],
  corridor: ['cabinet', 'plant', 'box'],
  kitchen: ['cabinet', 'table', 'shelf'],
  storage: ['box', 'crate', 'shelf', 'pallet'],
  factory: ['machine', 'crate', 'pallet', 'shelf', 'box'],
  gym: ['bench', 'box', 'crate'],
  generic: ['box', 'shelf', 'chair'],
};
