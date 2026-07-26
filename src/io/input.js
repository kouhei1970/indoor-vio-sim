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
    this.enabled = true;
    this.bind();
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
    });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }

  /** ゲームパッドの軸を読む (Mode 2: 左スティック = スロットル/ヨー) */
  readGamepad() {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    const gp = navigator.getGamepads()[this.gamepadIndex];
    if (!gp) return null;
    const dz = (v) => (Math.abs(v) < this.gamepadDeadzone ? 0
      : (v - Math.sign(v) * this.gamepadDeadzone) / (1 - this.gamepadDeadzone));
    return {
      yaw: -dz(gp.axes[0] ?? 0),
      throttle: -dz(gp.axes[1] ?? 0),
      roll: dz(gp.axes[2] ?? 0),
      pitch: -dz(gp.axes[3] ?? 0),
      buttons: gp.buttons.map((b) => b.pressed),
    };
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
