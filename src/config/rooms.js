/**
 * 室内環境のプリセット。
 *
 * 自己位置推定の研究では「見た目の情報量」が結果を大きく左右するため、
 * テクスチャの豊富さ (featureDensity)、家具の量、照明条件、
 * マーカーの有無を独立に変えられるようにしている。
 */

export const ROOM_PRESETS = {
  lab: {
    name: '研究室',
    size: { width: 8, depth: 10, height: 2.8 },
    floor: { kind: 'tile', color: '#d9d6ce', repeat: 5, roughness: 0.35, metalness: 0.0 },
    walls: { kind: 'paint', color: '#e9e7e2', repeat: 3, roughness: 0.7 },
    ceiling: { kind: 'ceiling', color: '#f2f1ee', repeat: 4, roughness: 0.9 },
    furniture: { density: 1.0, kinds: ['desk', 'chair', 'shelf', 'cabinet', 'monitor', 'box', 'plant'] },
    decor: { posters: 6, markers: 4, whiteboard: true, windows: 2 },
    lighting: 'fluorescent',
    clutterSeed: 7,
  },
  gym: {
    name: '体育館',
    size: { width: 20, depth: 30, height: 8 },
    floor: { kind: 'wood', color: '#c89a63', repeat: 10, roughness: 0.28, metalness: 0.0 },
    walls: { kind: 'paint', color: '#dfe3e6', repeat: 6, roughness: 0.75 },
    ceiling: { kind: 'plain', color: '#9aa0a6', repeat: 8, roughness: 0.85 },
    furniture: { density: 0.25, kinds: ['box', 'pillar', 'bench'] },
    decor: { posters: 4, markers: 8, whiteboard: false, windows: 6 },
    lighting: 'highbay',
    clutterSeed: 13,
  },
  corridor: {
    name: '廊下',
    size: { width: 2.4, depth: 24, height: 2.6 },
    floor: { kind: 'tile', color: '#c9c6bf', repeat: 12, roughness: 0.3 },
    walls: { kind: 'paint', color: '#dcd9d2', repeat: 8, roughness: 0.65 },
    ceiling: { kind: 'ceiling', color: '#f0efec', repeat: 10, roughness: 0.9 },
    furniture: { density: 0.3, kinds: ['cabinet', 'plant', 'box'] },
    decor: { posters: 10, markers: 10, whiteboard: false, windows: 0 },
    lighting: 'corridor',
    clutterSeed: 23,
  },
  warehouse: {
    name: '倉庫',
    size: { width: 16, depth: 22, height: 7 },
    floor: { kind: 'concrete', color: '#b2b0ab', repeat: 8, roughness: 0.8 },
    walls: { kind: 'concrete', color: '#a8a6a1', repeat: 6, roughness: 0.85 },
    ceiling: { kind: 'plain', color: '#8b8f94', repeat: 6, roughness: 0.9 },
    furniture: { density: 1.4, kinds: ['shelf', 'pallet', 'box', 'pillar', 'crate'] },
    decor: { posters: 2, markers: 12, whiteboard: false, windows: 3 },
    lighting: 'highbay',
    clutterSeed: 31,
  },
  empty: {
    name: '空室 (テクスチャ少)',
    size: { width: 6, depth: 6, height: 2.7 },
    floor: { kind: 'plain', color: '#cfcdc8', repeat: 2, roughness: 0.5 },
    walls: { kind: 'plain', color: '#e6e4e0', repeat: 2, roughness: 0.75 },
    ceiling: { kind: 'plain', color: '#f0efec', repeat: 2, roughness: 0.9 },
    furniture: { density: 0, kinds: [] },
    decor: { posters: 0, markers: 0, whiteboard: false, windows: 1 },
    lighting: 'single',
    clutterSeed: 3,
    note: '特徴点が乏しい環境。視覚 SLAM が破綻する条件の評価に。',
  },
  livingroom: {
    name: 'リビング',
    size: { width: 7, depth: 8, height: 2.6 },
    floor: { kind: 'wood', color: '#a9784a', repeat: 6, roughness: 0.3 },
    walls: { kind: 'paint', color: '#efe9df', repeat: 3, roughness: 0.7 },
    ceiling: { kind: 'plain', color: '#faf8f4', repeat: 3, roughness: 0.9 },
    furniture: { density: 1.2, kinds: ['sofa', 'table', 'shelf', 'plant', 'monitor', 'chair'] },
    decor: { posters: 4, markers: 2, whiteboard: false, windows: 3 },
    lighting: 'warm',
    clutterSeed: 41,
  },
  factory: {
    name: '工場フロア',
    size: { width: 14, depth: 18, height: 6 },
    floor: { kind: 'concrete', color: '#9fa3a0', repeat: 7, roughness: 0.7 },
    walls: { kind: 'brick', color: '#8c6a58', repeat: 4, roughness: 0.85 },
    ceiling: { kind: 'plain', color: '#7d8287', repeat: 5, roughness: 0.9 },
    furniture: { density: 1.6, kinds: ['machine', 'pillar', 'crate', 'shelf', 'pallet'] },
    decor: { posters: 5, markers: 10, whiteboard: false, windows: 4 },
    lighting: 'mixed',
    clutterSeed: 53,
  },
};

export const ROOM_KEYS = Object.keys(ROOM_PRESETS);

/** 照明プリセット */
export const LIGHTING_PRESETS = {
  fluorescent: {
    name: '蛍光灯 (グリッド)',
    ambient: 0.28, ambientColor: '#c9d6e5',
    ceilingLights: { rows: 2, cols: 3, power: 45, color: '#f2f6ff', size: 1.1 },
    sun: { enabled: true, power: 0.8, color: '#fff4e0', elevation: 42, azimuth: 130 },
    flicker: 0.0,
  },
  warm: {
    name: '暖色 (住宅)',
    ambient: 0.22, ambientColor: '#f2d9bd',
    ceilingLights: { rows: 1, cols: 2, power: 32, color: '#ffd9a8', size: 0.5 },
    sun: { enabled: true, power: 1.4, color: '#ffe6c0', elevation: 25, azimuth: 200 },
    flicker: 0.0,
  },
  highbay: {
    name: '高天井灯',
    ambient: 0.20, ambientColor: '#bcc9d8',
    ceilingLights: { rows: 3, cols: 3, power: 95, color: '#ffffff', size: 0.6 },
    sun: { enabled: true, power: 1.1, color: '#ffffff', elevation: 60, azimuth: 90 },
    flicker: 0.0,
  },
  corridor: {
    name: '廊下灯',
    ambient: 0.18, ambientColor: '#c5cdd8',
    ceilingLights: { rows: 6, cols: 1, power: 26, color: '#eef4ff', size: 0.8 },
    sun: { enabled: false, power: 0, color: '#ffffff', elevation: 30, azimuth: 0 },
    flicker: 0.02,
  },
  single: {
    name: '単灯 (影が強い)',
    ambient: 0.12, ambientColor: '#aab4c2',
    ceilingLights: { rows: 1, cols: 1, power: 40, color: '#fff6e8', size: 0.3 },
    sun: { enabled: false, power: 0, color: '#ffffff', elevation: 30, azimuth: 0 },
    flicker: 0.0,
  },
  mixed: {
    name: '混合光源 (色温度差)',
    ambient: 0.2, ambientColor: '#c0cad8',
    ceilingLights: { rows: 2, cols: 2, power: 70, color: '#e8f0ff', size: 0.7 },
    sun: { enabled: true, power: 1.2, color: '#ffd9a0', elevation: 20, azimuth: 250 },
    flicker: 0.01,
  },
  dark: {
    name: '薄暗い (夜間・低照度)',
    ambient: 0.05, ambientColor: '#3b4a63',
    ceilingLights: { rows: 1, cols: 2, power: 8, color: '#ffe9c8', size: 0.5 },
    sun: { enabled: false, power: 0, color: '#ffffff', elevation: 10, azimuth: 0 },
    flicker: 0.03,
    note: '低照度環境。露光時間が伸びてモーションブラーとノイズが増える。',
  },
};

export const LIGHTING_KEYS = Object.keys(LIGHTING_PRESETS);

/** 環境設定のデフォルト (UI から編集される) */
export const ENV_DEFAULTS = {
  // 'room'     : 単室プリセット (ROOM_PRESETS)
  // 'building' : 複数階の建物プリセット (BUILDING_PRESETS)
  mode: 'room',
  preset: 'lab',
  building: 'school',
  size: { width: 8, depth: 10, height: 2.8 },
  featureDensity: 1.0,     // テクスチャの模様の強さ (0 = のっぺり)
  furnitureDensity: 1.0,   // 家具の量
  markerCount: 4,          // フィデューシャルマーカーの枚数
  posterCount: 6,
  windows: 2,
  lighting: 'fluorescent',
  lightIntensity: 1.0,
  shadows: true,
  shadowQuality: 2048,
  seed: 7,
  showTrajectory: true,
  showColliders: false,
};
