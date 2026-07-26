# StampFly 3D モデル (STL)

このディレクトリの STL ファイルは、公式の
[StampFly Ecosystem](https://github.com/M5Fly-kanazawa/stampfly_ecosystem)
(`landing/assets/model/`) から取得した実機 StampFly の 3D モデルです。

Copyright (c) 2026 Kouhei Ito — MIT License

## 内容

| ファイル | 部位 | 既定の色 |
|---|---|---|
| `frame.stl` | 外周フレーム (プロペラ保護構造) | `#ccd2db` |
| `pcb.stl` | メイン基板 | `#0e1014` |
| `m5stamps3.stl` | M5StampS3 (ESP32-S3) | `#ff6a00` |
| `battery.stl` | バッテリー | `#2a1d14` |
| `battery_adapter.stl` | バッテリーアダプタ | `#33312d` |
| `motor_fl/fr/rl/rr.stl` | 716 コアレスモータ 4 基 | `#b9c1cb` |

色は公式ランディングページの 3D ビューアと同じ値を既定にしていますが、
シミュレータの GUI (機体 → パーツ → 実機3Dモデル) から変更できます。

## 実寸 (STL のバウンディングボックス, 単位 mm)

```
全体              81.8 x 31.5 x 81.8      (カタログ値 82 x 82 x 30 と一致)
frame             81.8 x 24.5 x 81.8
pcb               41.9 x 14.5 x 59.5
m5stamps3         19.0 x  4.0 x 26.0
battery           12.0 x  6.0 x 67.0
motor (各)         7.0 x 21.0 x  7.0      中心 (±22.8, ±22.8)
```

プロペラは STL では平板なので、公式ランディングページと同様に
シミュレータ側で 3 枚羽根 (半径 14.99 mm) を生成しています。

STL の座標系は Y-up・+Z が前方・+X が左です。本シミュレータの機体座標
(x=右, y=上, z=後) へは Y 軸まわり 180° 回転で合わせています。
