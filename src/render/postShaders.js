/**
 * オンボードカメラ用のポストプロセス。
 *
 * 実カメラで撮った画像に近づけるため、以下を GPU 上で再現する:
 *   - レンズ歪み (Brown-Conrady モデル: k1, k2, p1, p2)
 *   - 周辺減光 (ビネッティング, cos^4 則)
 *   - 色収差 (倍率色収差)
 *   - センサノイズ (ショットノイズ + 読み出しノイズ)
 *   - 露出 / ホワイトバランス
 *   - ローリングシャッタ的な行方向スキュー (任意)
 *
 * 歪み係数はデータセットと一緒に出力されるので、
 * 「歪みを含む画像 + 正解のカメラ内部パラメータ」という
 * 実機に近い条件で自己位置推定を評価できる。
 */

export const CameraRealismShader = {
  name: 'CameraRealismShader',
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: [640, 480] },
    // 出力画像の内部パラメータ (正規化: fx/W, fy/H, cx/W, cy/H)
    focal: { value: [0.9, 0.9] },
    principal: { value: [0.5, 0.5] },
    // 描画に使ったピンホールカメラの内部パラメータ (歪みで画角が広がる分を含む)
    focalRender: { value: [0.9, 0.9] },
    principalRender: { value: [0.5, 0.5] },
    distortion: { value: [0.0, 0.0, 0.0, 0.0] },   // k1, k2, p1, p2
    vignette: { value: 0.35 },
    chromatic: { value: 0.0015 },
    shotNoise: { value: 0.012 },
    readNoise: { value: 0.004 },
    exposure: { value: 1.0 },
    whiteBalance: { value: [1.0, 1.0, 1.0] },
    contrast: { value: 1.0 },
    saturation: { value: 1.0 },
    time: { value: 0 },
    rollingShutter: { value: 0.0 },
    rollingSkew: { value: [0, 0] },
    grain: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform vec2 focal;
    uniform vec2 principal;
    uniform vec2 focalRender;
    uniform vec2 principalRender;
    uniform vec4 distortion;
    uniform float vignette;
    uniform float chromatic;
    uniform float shotNoise;
    uniform float readNoise;
    uniform float exposure;
    uniform vec3 whiteBalance;
    uniform float contrast;
    uniform float saturation;
    uniform float time;
    uniform float rollingShutter;
    uniform vec2 rollingSkew;
    uniform float grain;
    varying vec2 vUv;

    // 出力画素 (歪んだ画像) に対応する「歪みの無い理想光線」を求め、
    // その光線が描画画像のどこに写っているかを返す。
    //
    // 投影モデル:  x_d = x_u (1 + k1 r^2 + k2 r^4) + 接線歪み   (r = |x_u|)
    // ここでは x_d が既知なので x_u を不動点反復で解く (5 回で十分収束する)。
    vec2 distortUv(vec2 uv, float scale) {
      vec2 xd = (uv - principal) / focal;     // 出力画像の正規化座標
      vec2 x = xd;
      for (int i = 0; i < 5; i++) {
        float r2 = dot(x, x);
        float radial = 1.0 + distortion.x * r2 + distortion.y * r2 * r2;
        vec2 tangential = vec2(
          2.0 * distortion.z * x.x * x.y + distortion.w * (r2 + 2.0 * x.x * x.x),
          distortion.z * (r2 + 2.0 * x.y * x.y) + 2.0 * distortion.w * x.x * x.y
        );
        x = (xd - tangential) / max(radial, 0.05);
      }
      // 倍率色収差: 波長ごとに焦点距離がわずかに違う
      x *= scale;
      return x * focalRender + principalRender;
    }

    float hash13(vec3 p) {
      p = fract(p * vec3(443.897, 441.423, 437.195));
      p += dot(p, p.yzx + 19.19);
      return fract((p.x + p.y) * p.z);
    }

    void main() {
      vec2 uv = vUv;

      // ローリングシャッタ: 行ごとに露光タイミングがずれる
      if (rollingShutter > 0.0) {
        uv += rollingSkew * (uv.y - 0.5) * rollingShutter;
      }

      // 色収差 (波長ごとに倍率が変わる) + レンズ歪み
      vec2 uvR = distortUv(uv, 1.0 + chromatic);
      vec2 uvG = distortUv(uv, 1.0);
      vec2 uvB = distortUv(uv, 1.0 - chromatic);

      vec3 color;
      color.r = texture2D(tDiffuse, uvR).r;
      color.g = texture2D(tDiffuse, uvG).g;
      color.b = texture2D(tDiffuse, uvB).b;

      // 画面外を参照したら黒 (実機のレンズ外と同じ)
      vec2 clampTest = step(vec2(0.0), uvG) * step(uvG, vec2(1.0));
      color *= clampTest.x * clampTest.y;

      // 露出とホワイトバランス
      color *= exposure * whiteBalance;

      // 周辺減光 (cos^4 則の近似)
      vec2 d = (vUv - principal) / focal;
      float cos4 = 1.0 / pow(1.0 + dot(d, d), 2.0);
      color *= mix(1.0, cos4, vignette);

      // センサノイズ: ショットノイズは輝度の平方根に比例、読み出しノイズは一定
      float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
      float n1 = hash13(vec3(gl_FragCoord.xy, time)) - 0.5;
      float n2 = hash13(vec3(gl_FragCoord.yx, time + 7.13)) - 0.5;
      float n3 = hash13(vec3(gl_FragCoord.xy * 1.7, time + 3.71)) - 0.5;
      float sigma = shotNoise * sqrt(max(lum, 0.0)) + readNoise;
      color += vec3(n1, n2, n3) * sigma * 3.4;

      // 固定パターンノイズ (粒状感)
      if (grain > 0.0) {
        float g = hash13(vec3(gl_FragCoord.xy, 0.5)) - 0.5;
        color += g * grain;
      }

      // コントラストと彩度
      color = (color - 0.18) * contrast + 0.18;
      float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(l), color, saturation);

      gl_FragColor = vec4(max(color, 0.0), 1.0);
    }
  `,
};

/** 深度を可視化 / 出力するためのシェーダ (深度データセット用) */
export const DepthEncodeShader = {
  name: 'DepthEncodeShader',
  uniforms: {
    tDepth: { value: null },
    cameraNear: { value: 0.05 },
    cameraFar: { value: 50 },
    maxDepth: { value: 20 },
    mode: { value: 0 },   // 0 = 16bit エンコード, 1 = グレースケール可視化
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    #include <packing>
    uniform sampler2D tDepth;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float maxDepth;
    uniform int mode;
    varying vec2 vUv;

    void main() {
      float frag = texture2D(tDepth, vUv).x;
      float viewZ = perspectiveDepthToViewZ(frag, cameraNear, cameraFar);
      float depth = -viewZ;   // カメラからの距離 [m]
      float norm = clamp(depth / maxDepth, 0.0, 1.0);
      if (mode == 1) {
        gl_FragColor = vec4(vec3(1.0 - norm), 1.0);
      } else {
        // 16bit を R,G の 2 チャンネルに分けて格納する
        float v = norm * 65535.0;
        float hi = floor(v / 256.0);
        float lo = v - hi * 256.0;
        gl_FragColor = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);
      }
    }
  `,
};
