# 研究での使い方

自己位置推定 (visual localization / VIO / SLAM) の実験に本シミュレータを使うときの、
具体的な手順とスクリプト例をまとめます。

真値 (ground truth) が完全に既知であることがシミュレータの一番の利点です。
実機では真値の取得にモーションキャプチャが要りますが、ここでは
位置・姿勢・IMU・深度がすべて誤差ゼロで得られます。

---

## 1. データセットを作る

### GUI から

1. 「環境」で部屋と照明を決める
2. 「機体」でカメラの取り付け位置と俯角を決める (真下なら俯角 90°)
3. 「搭載カメラ」で解像度・画角・歪み・ノイズを実機に合わせる
4. 「飛行」→ モードを **自動飛行**、軌道パターンを選ぶ
5. 「データセット記録」→ 記録 開始 → ZIP で書き出し

### コマンドラインから (条件を振るとき)

```bash
node tools/render_dataset.mjs --out ./datasets \
  --vehicle research-250 --room lab --pattern lawnmower \
  --frames 400 --fps 20 --speed 0.4 --altitude 1.2 --tilt 90 \
  --width 640 --height 480 --seed 1 --depth --name lab-down-baseline
```

刻み幅が固定なので、実行環境が違っても同じデータが出ます。

---

## 2. 実験レシピ

### 2.1 特徴点の量が推定精度に与える影響

視覚的な情報量だけを変え、他の条件を固定します。

```bash
for f in 0 0.25 0.5 1.0 1.5 2.0; do
  node tools/render_dataset.mjs --out ./exp-features \
    --room lab --features $f --frames 300 --fps 20 --seed 1 \
    --pattern lawnmower --name "features-$f"
done
```

`--features 0` は壁も床もほぼ無地になります。特徴点ベースの手法が
どこで破綻するかを定量的に示せます。家具の量も `--furniture` で
独立に変えられます。

### 2.2 照明条件に対するロバスト性

```bash
for l in fluorescent warm highbay single mixed dark; do
  node tools/render_dataset.mjs --out ./exp-light \
    --room lab --lighting $l --frames 300 --seed 1 --name "light-$l"
done
```

`dark` は低照度条件です。実機と同じく、暗いほど画像のノイズが
相対的に大きくなります (ショットノイズは輝度の平方根に比例)。

### 2.3 モーションブラーと露光時間

GUI の「搭載カメラ → モーションブラー」でシャッター速度を変えるか、
設定 JSON の `camera.exposureTime` を変えて生成します。
飛行速度 (`--speed`) と組み合わせると、
「速度 × 露光時間 = ブレ量」の関係を実験できます。

### 2.4 レンズ歪みの影響

`camera.distortion.k1` を 0 から -0.4 まで振ります。
出力される `camera.yaml` の係数は OpenCV の `radtan` としてそのまま使えるので、
「歪み補正あり / なし」の比較ができます。

### 2.5 NeRF / 3D Gaussian Splatting 用のデータ

物体や部屋を取り囲む視点が必要なので、周回パターンを使います。

```bash
node tools/render_dataset.mjs --out ./nerf \
  --pattern orbit --radius 2.0 --frames 300 --fps 30 \
  --yaw-mode look-at --tilt 20 --width 960 --height 720 \
  --room lab --name room-orbit
```

`transforms.json` がそのまま nerfstudio / instant-ngp で読めます
(OpenGL 規約の camera-to-world 行列)。ポーズが真値なので
COLMAP による事前推定は不要です。

---

## 3. 出力の読み方 (Python)

### 真値軌跡の読み込みと ATE の計算

```python
import numpy as np

def load_tum(path):
    """TUM 形式 (t tx ty tz qx qy qz qw) を読む"""
    rows = np.loadtxt(path, comments='#')
    return rows[:, 0], rows[:, 1:4], rows[:, 4:8]

t_gt, p_gt, q_gt = load_tum('groundtruth.txt')
t_es, p_es, q_es = load_tum('estimated.txt')   # 自分の手法の出力

# タイムスタンプで最近傍対応をとる
idx = np.abs(t_gt[:, None] - t_es[None, :]).argmin(axis=0)
err = np.linalg.norm(p_gt[idx] - p_es, axis=1)
print(f'ATE RMSE = {np.sqrt((err**2).mean()):.4f} m')
print(f'ATE 中央値 = {np.median(err):.4f} m')
```

単眼手法ではスケールが不定なので、Umeyama 法などで
相似変換を合わせてから比較してください。

### 画像とカメラパラメータ

```python
import cv2, yaml, numpy as np

cal = yaml.safe_load(open('camera.yaml'))['cam0']
fx, fy, cx, cy = cal['intrinsics']
K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]])
D = np.array(cal['distortion_coeffs'])      # k1, k2, p1, p2

img = cv2.imread('rgb/000000.png')
undistorted = cv2.undistort(img, K, D)      # 歪み補正
```

### 深度マップの復元

深度は 16bit を R,G チャンネルに分けて格納しています。

```python
import cv2, json
d = cv2.imread('depth/000000.png')          # BGR
far = json.load(open('camera.json'))['far']
hi = d[:, :, 2].astype(np.float32)          # R チャンネル
lo = d[:, :, 1].astype(np.float32)          # G チャンネル
depth_m = (hi * 256 + lo) / 65535.0 * far   # メートル
```

### IMU

`imu.csv` は EuRoC 形式 (ナノ秒, 角速度 rad/s, 加速度 m/s²) で、
座標系は FLU (前・左・上) です。静止時の加速度計出力は
`(0, 0, +9.81)` になります。

---

## 4. 座標系の注意

| ファイル | 規約 |
|---|---|
| `groundtruth.txt`, `groundtruth_camera.txt` | ENU ワールド / FLU 機体 (ROS REP-103) |
| `imu.csv` | FLU 機体 |
| `transforms.json` | OpenGL カメラ (x=右, y=上, z=後) の camera-to-world |
| `colmap/images.txt` | OpenCV カメラ (x=右, y=下, z=前) の world-to-camera |
| `telemetry.csv` | シミュレータ内部座標 (X=右, Y=上, Z=手前) |

`groundtruth.txt` は**機体**の姿勢、`groundtruth_camera.txt` は**カメラ**の姿勢です。
カメラと機体の相対姿勢 (extrinsics) は `metadata.json` の
`vehicle.parts.camera` (offset と tilt) に入っています。

---

## 5. 再現性

- `metadata.json` に生成時の全設定が入っています。
  GUI の「設定を読み込む」に渡せば同じ条件を復元できます。
- 乱数 (家具配置・IMU ノイズ・モータ個体差・乱流) はすべてシード管理です。
  `--seed` を固定すれば毎回同じデータになります。
- `--seed` だけ変えれば「同じ条件・違う配置」のバリエーションを作れます。

---

## 6. StampFly を使う場合

機体プリセット `stampfly` の物理パラメータは、公式の
[StampFly Ecosystem](https://github.com/M5Fly-kanazawa/stampfly_ecosystem)
のシミュレータ (`simulator/vpython/core/`) が使っている実測値をそのまま採用しています。

- 質量 0.035 kg、慣性テンソル diag(9.16e-6, 13.3e-6, 20.4e-6) kg·m²
- ロータ位置 (±23, ±23, 5) mm
- Ct = 6.7e-9、Cq = 4.10e-11 (2026-07-15 ベンチ実測)、κ = 6.12e-3
- Jmp = 1.375e-8 kg·m²、Rm = 0.63 Ω、Ke = 5.5e-4

推力重量比は 1.49 と低めなので、高度制御が推力を使い切らないよう
制御側で余裕 (18%) を確保しています。実機同様、急上昇と大きな姿勢変化を
同時に要求すると出力が飽和します。

```bash
node tools/render_dataset.mjs --out ./datasets --vehicle stampfly \
  --room lab --pattern lawnmower --speed 0.4 --altitude 1.0 \
  --frames 200 --fps 20 --tilt 0 --width 320 --height 240
```

実機に合わせるときの調整点:

- **カメラ** — 実機には無いので、既定では 0.9 g の小型カメラを機首上部に
  載せた構成にしています。質量・取り付け位置・俯角は
  「機体 → パーツ → カメラ (機体側)」で実際のモジュールに合わせてください。
  なお質量と慣性は実測値を直接指定しているので (`massMode`/`inertiaMode` = manual)、
  カメラを足しても合計質量は 0.035 kg のままです。カメラ込みで評価したい場合は
  「総質量」と「慣性テンソル」を実測し直した値に更新してください。
- **プロペラガード** — 別売りなので既定では付いていません。
  「パーツ → プロペラガード → 有効」で見た目と当たり判定が付きます。
  質量・慣性を反映するには `massMode` を「パーツ合計」に戻すか、実測値を入れ直します。
- **プロペラ直径** — 公表値が見つからなかったため 40 mm としています。
  変更する場合は推力が実測どおりになるよう
  `ct = Ct·4π²/(ρD⁴)`、`cq = Cq·4π²/(ρD⁵)` で換算してください
  (Ct = 6.7e-9、Cq = 4.10e-11)。
- **カメラ・ガードを載せた実機で再計測したら** — 「機体 → フレーム →
  慣性の決め方」を「実測値を指定」にして、慣性テンソルを直接入れられます。

搭載センサ (IMU / 気圧計 / ToF / オプティカルフロー / 磁気センサ) の
組み合わせは実機と同じなので、センサフュージョンの検討にもそのまま使えます。

---

## 7. 物理側の実験にも使えます

画像を使わない実験にも利用できます。

- **制御則の比較** — `src/core/controller.js` を差し替える
- **フォールトトレラント制御** — 「シミュレーション → 故障注入」でロータを停止
- **推定誤差の影響** — 「推定値で制御 (ノイズ有)」を有効にすると、
  真値ではなくノイズを載せた状態量で制御ループを回します
- **機体設計の検討** — アーム長・プロペラ径・KV 値を変え、
  推力重量比とホバリング時間の変化を見る

物理コア (`src/core/`) は three.js に依存しないので、
Node.js から直接呼んでバッチ実験もできます。

```js
import { Simulator } from './src/core/simulator.js';
import { CollisionWorld } from './src/core/collision.js';
import { buildVehicle, SIM_DEFAULTS, clone } from './src/config/vehicle.js';

const world = new CollisionWorld();
world.setRoom(8, 2.8, 10);
const sim = new Simulator(buildVehicle('research-250'), clone(SIM_DEFAULTS), world);
sim.setMode('position');
sim.controller.targetPos = { x: 1, y: 1.2, z: 0 };
for (let i = 0; i < 5000; i++) sim.stepOnce(1 / 500);
console.log(sim.snapshot());
```
