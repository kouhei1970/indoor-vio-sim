/**
 * 操縦入力 (キーボード / ゲームパッド)。
 *
 * キー配置 (Mode 2 プロポ相当)
 *   W / S      : スロットル (上昇 / 下降)
 *   A / D      : ヨー (左 / 右)
 *   ↑ / ↓      : ピッチ (前進 / 後退)
 *   ← / →      : ロール (左 / 右)
 *   Shift      : 微速モード
 *   Space      : 離陸 / 着陸
 *   R          : リセット   M: フライトモード切替   V: 視点切替
 *   P          : 一時停止   G: データ記録の開始/停止
 */

import { shapeStick } from '../core/controller.js';
import { clamp } from '../core/math.js';

const KEY_MAP = {
  KeyW: ['throttle', 1], KeyS: ['throttle', -1],
  KeyA: ['yaw', 1], KeyD: ['yaw', -1],
  ArrowUp: ['pitch', 1], ArrowDown: ['pitch', -1],
  ArrowLeft: ['roll', -1], ArrowRight: ['roll', 1],
  KeyI: ['pitch', 1], KeyK: ['pitch', -1],
  KeyJ: ['roll', -1], KeyL: ['roll', 1],
};

export const AXIS_NAMES = ['throttle', 'roll', 'pitch', 'yaw'];

/**
 * ゲームパッドのプロファイル (どの軸がどの操作か・向きはどちらか)。
 *
 * ブラウザの Gamepad API は軸を -1..+1 で返すが、その並び順は機器の
 * HID レポートディスクリプタの順で決まる。機種ごとに違うので表にしてある。
 *
 * invert が true の軸は符号を反転する。本シミュレータの向きの約束は
 *   throttle +1 = 上昇 / roll +1 = 右へ / pitch +1 = 前進 / yaw +1 = 左旋回
 * (キーボードの W / → / ↑ / A と同じ)。
 */
export const PAD_PROFILES = {
  standard: {
    name: '汎用ゲームパッド (Mode 2)',
    axes: { throttle: 1, roll: 2, pitch: 3, yaw: 0 },
    invert: { throttle: true, roll: false, pitch: true, yaw: true },
  },
  stampfly: {
    name: 'StampFly コントローラ (USB HID)',
    // HID レポートは throttle, roll, pitch, yaw の順に 0..255 の 4 軸
    // (stampfly_ecosystem: firmware/controller/components/usb_hid/include/usb_hid.hpp)。
    // ブラウザはこれを -1..+1 に正規化するので、中央 128 が 0 になる。
    //
    // throttle はファーム側で 4095 - 生値 として送っているので、
    // 上に倒すと +1 になる (反転不要)。roll/pitch/yaw の向きは実機の
    // 配線に依存して確定できなかったので、下の既定値は推定である。
    // 逆に動く軸は「操縦 → スティック」で反転できる。
    axes: { throttle: 0, roll: 1, pitch: 2, yaw: 3 },
    invert: { throttle: false, roll: false, pitch: true, yaw: true },
  },
};

/** ゲームパッドの id からプロファイルを推定する */
export function detectProfile(id = '') {
  const s = id.toLowerCase();
  // Espressif VID 303a / StampFly コントローラ PID 8001、または製品名
  if ((s.includes('303a') && s.includes('8001')) || s.includes('stampfly')) return 'stampfly';
  return 'standard';
}

export class InputManager {
  constructor(options = {}) {
    this.keys = new Set();
    this.axes = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    this.raw = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    this.expo = options.expo ?? 0.3;
    this.rate = options.rate ?? 4.0;     // キー入力の立ち上がり速度 [1/s]
    this.slowFactor = 0.35;
    this.gamepadIndex = null;
    this.gamepadDeadzone = 0.08;
    this.handlers = options.handlers || {};
    // ゲームパッドのボタンを押したときに呼ぶ処理 (ボタン番号 → 関数)
    this.padHandlers = options.padHandlers || {};
    this.padButtonsEnabled = true;
    this.enabled = true;

    // --- ゲームパッドの設定 ---
    // 'auto' は接続時に id から推定する (detectProfile)
    this.padProfile = 'auto';
    this.padName = '';
    this.padAxes = { ...PAD_PROFILES.standard.axes };
    this.padInvert = { ...PAD_PROFILES.standard.invert };
    // 表示用: 生の軸の値と、割り当て後の値
    this.padRaw = [];
    this.padValues = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
    this.prevButtons = [];

    this.bind();
  }

  /** プロファイルを適用する (軸の割り当てと向きを差し替える) */
  applyPadProfile(key) {
    const p = PAD_PROFILES[key];
    if (!p) return;
    this.padAxes = { ...p.axes };
    this.padInvert = { ...p.invert };
  }

  bind() {
    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      this.keys.add(e.code);
      const h = this.handlers[e.code];
      if (h) { e.preventDefault(); h(); }
      if (KEY_MAP[e.code] || e.code === 'Space') e.preventDefault();
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);
    this._onBlur = () => this.keys.clear();
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      this.padName = e.gamepad.id || '';
      // 'auto' のときだけ、機種に合わせて軸の割り当てを入れ替える
      if (this.padProfile === 'auto') this.applyPadProfile(detectProfile(this.padName));
      this.prevButtons = [];
    });
    window.addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = null;
      this.padName = '';
    });
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }

  /**
   * ゲームパッドの軸を読む。
   *
   * どの軸がどの操作かはプロファイル (padAxes / padInvert) で決まる。
   * 汎用ゲームパッドは Mode 2 (左スティック = スロットル/ヨー)、
   * StampFly コントローラは USB HID モードの並び (throttle/roll/pitch/yaw)。
   */
  readGamepad() {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return null;
    const dz = (v) => (Math.abs(v) < this.gamepadDeadzone ? 0
      : (v - Math.sign(v) * this.gamepadDeadzone) / (1 - this.gamepadDeadzone));
    this.padRaw = Array.from(gp.axes);
    const out = { buttons: gp.buttons.map((b) => b.pressed) };
    for (const k of AXIS_NAMES) {
      const v = dz(gp.axes[this.padAxes[k]] ?? 0);
      out[k] = this.padInvert[k] ? -v : v;
      this.padValues[k] = out[k];
    }
    return out;
  }

  /** ゲームパッドのボタンの立ち上がりで処理を呼ぶ */
  handlePadButtons(buttons) {
    if (!this.padButtonsEnabled) { this.prevButtons = buttons; return; }
    for (let i = 0; i < buttons.length; i++) {
      if (buttons[i] && !this.prevButtons[i]) this.padHandlers[i]?.();
    }
    this.prevButtons = buttons;
  }

  /**
   * 入力を更新して操縦コマンドを返す。
   * @param {number} dt
   */
  update(dt) {
    const gp = this.readGamepad();
    const target = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
    if (gp) {
      target.roll = gp.roll; target.pitch = gp.pitch;
      target.yaw = gp.yaw; target.throttle = gp.throttle;
      this.handlePadButtons(gp.buttons);
    }
    for (const [code, [axis, dir]] of Object.entries(KEY_MAP)) {
      if (this.keys.has(code)) target[axis] += dir;
    }
    const slow = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const scale = slow ? this.slowFactor : 1;

    for (const k of ['roll', 'pitch', 'yaw', 'throttle']) {
      const t = clamp(target[k], -1, 1) * scale;
      // キー入力は滑らかに立ち上げる (プロポのスティックに近い感触)
      const a = gp ? 1 : Math.min(1, dt * this.rate * 3);
      this.raw[k] += (t - this.raw[k]) * a;
      if (Math.abs(this.raw[k]) < 1e-4) this.raw[k] = 0;
      this.axes[k] = shapeStick(this.raw[k], this.expo, 0.02);
    }
    return { ...this.axes, gamepad: !!gp };
  }

  /** 表示用: どのキーが押されているか */
  activeKeys() { return [...this.keys]; }
}
