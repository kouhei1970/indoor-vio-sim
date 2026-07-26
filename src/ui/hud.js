/**
 * 計器表示 (HUD)。飛行状態と機体諸元をリアルタイムに表示する。
 */

import { RAD } from '../core/math.js';

const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '--');

export class Hud {
  constructor(root) {
    this.root = root;
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-panel hud-flight">
        <div class="hud-title">飛行状態</div>
        <div class="hud-grid" id="hud-flight"></div>
      </div>
      <div class="hud-panel hud-motors">
        <div class="hud-title">ロータ出力</div>
        <div class="hud-bars" id="hud-bars"></div>
        <div class="hud-grid" id="hud-power"></div>
      </div>
      <div class="hud-panel hud-spec">
        <div class="hud-title">機体諸元</div>
        <div class="hud-grid" id="hud-spec"></div>
      </div>
    `;
    root.appendChild(this.el);
    this.flight = this.el.querySelector('#hud-flight');
    this.bars = this.el.querySelector('#hud-bars');
    this.power = this.el.querySelector('#hud-power');
    this.spec = this.el.querySelector('#hud-spec');
    this.barEls = [];
    this.lastSpecKey = '';

    this.status = document.createElement('div');
    this.status.className = 'hud-status';
    root.appendChild(this.status);
  }

  setVisible(v) {
    this.el.style.display = v ? '' : 'none';
  }

  rows(container, pairs) {
    if (container.childElementCount !== pairs.length * 2) {
      container.innerHTML = pairs
        .map(([k]) => `<span class="k">${k}</span><span class="v"></span>`).join('');
    }
    const vals = container.querySelectorAll('.v');
    pairs.forEach((p, i) => {
      const text = p[1];
      if (vals[i].textContent !== text) vals[i].textContent = text;
      if (p[2]) vals[i].className = `v ${p[2]}`;
      else if (vals[i].className !== 'v') vals[i].className = 'v';
    });
  }

  /**
   * @param {object} s シミュレータの snapshot()
   * @param {object} info 追加情報 {fps, perf, recording, frames, mode, sensorInfo}
   */
  update(s, info) {
    const e = s.euler;
    const speed = Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z);
    this.rows(this.flight, [
      ['時刻', `${f(s.t, 2)} s`],
      ['モード', info.modeLabel || s.mode],
      ['位置 XYZ', `${f(s.position.x)}, ${f(s.position.y)}, ${f(s.position.z)} m`],
      ['対地高度', `${f(s.agl, 2)} m`],
      ['速度', `${f(speed, 2)} m/s`],
      ['姿勢 R/P/Y', `${f(e.roll * RAD, 1)}, ${f(e.pitch * RAD, 1)}, ${f(e.yaw * RAD, 1)} °`],
      ['角速度', `${f(s.omega.x, 2)}, ${f(s.omega.y, 2)}, ${f(s.omega.z, 2)} rad/s`],
      ['風速', `${f(Math.hypot(s.wind.x, s.wind.y, s.wind.z), 2)} m/s`],
      ['接触', s.contact > 0 ? `${s.contact} 点` : 'なし', s.contact > 0 ? 'warn' : ''],
      ['状態', s.crashed ? '墜落' : (s.saturated ? '出力飽和' : '正常'),
        s.crashed ? 'bad' : (s.saturated ? 'warn' : 'good')],
      ['描画', `${f(info.fps, 0)} fps`],
    ]);

    // ロータ出力バー
    if (this.barEls.length !== s.motorCommands.length) {
      this.bars.innerHTML = s.motorCommands
        .map((_, i) => `<div class="bar"><div class="fill"></div><span>${i}</span></div>`).join('');
      this.barEls = [...this.bars.querySelectorAll('.fill')];
    }
    s.motorCommands.forEach((c, i) => {
      const pct = Math.max(0, Math.min(1, c)) * 100;
      this.barEls[i].style.height = `${pct}%`;
      this.barEls[i].className = `fill${c > 0.92 ? ' sat' : ''}${c <= 0.001 ? ' off' : ''}`;
    });

    const b = s.battery;
    this.rows(this.power, [
      ['電圧', `${f(b.voltage, 2)} V`],
      ['電流', `${f(b.current, 1)} A`],
      ['残量', `${f(b.soc * 100, 0)} %`, b.soc < 0.2 ? 'bad' : (b.soc < 0.4 ? 'warn' : 'good')],
      ['消費', `${f(b.energyWh, 2)} Wh`],
      ['回転数', `${f(Math.max(...s.rpm), 0)} rpm`],
    ]);

    // 機体諸元 (変わったときだけ更新)
    const p = info.perf;
    if (p) {
      const key = `${p.mass}|${p.twr}|${p.nRotors}`;
      if (key !== this.lastSpecKey) {
        this.lastSpecKey = key;
        this.rows(this.spec, [
          ['質量', `${f(p.mass * 1000, 0)} g`],
          ['ロータ数', `${p.nRotors}`],
          ['最大推力', `${f(p.thrustMax, 1)} N`],
          // 1.25 未満は離陸も難しい。1.25〜2.0 は飛べるが余力が少ない
          // (StampFly など実機でも 1.5 程度の機体はある)
          ['推力重量比', `${f(p.twr, 2)}`, p.twr < 1.25 ? 'bad' : (p.twr < 2 ? 'warn' : 'good')],
          ['ホバリング出力', `${f(p.hoverThrottle * 100, 0)} %`],
          ['ホバリング時間', `${f(p.hoverMinutes, 1)} 分`],
          ['ディスク荷重', `${f(p.diskLoading, 1)} N/m²`],
          ['慣性 (P/Y/R)', p.inertia],
          ['カメラ', info.cameraInfo || '--'],
        ]);
      }
    }

    // 記録状態
    if (info.recording) {
      this.status.className = 'hud-status recording';
      this.status.textContent = `● 記録中  ${info.frames} / ${info.maxFrames} 枚`;
    } else if (info.frames > 0) {
      this.status.className = 'hud-status ready';
      this.status.textContent = `記録済み ${info.frames} 枚 — 「ZIP で書き出し」で保存`;
    } else {
      this.status.className = 'hud-status';
      this.status.textContent = '';
    }
  }
}
