/**
 * 依存ライブラリ無しの ZIP 書き出し (無圧縮 / store のみ)。
 *
 * データセットは PNG 画像が主なので、再圧縮しても縮まらない。
 * store 方式なら実装が数十行で済み、生成も速い。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

const encoder = new TextEncoder();

/** DOS 形式の日時に変換 */
function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5)
    | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9)
    | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

export class ZipWriter {
  constructor() {
    this.entries = [];
    this.parts = [];
    this.offset = 0;
  }

  /**
   * ファイルを追加する。
   * @param {string} name パス (フォルダは "dir/file.png" のように書く)
   * @param {Uint8Array|string} data
   * @param {Date} date
   */
  add(name, data, date = new Date(2024, 0, 1)) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const nameBytes = encoder.encode(name);
    const crc = crc32(bytes);
    const { time, day } = dosDateTime(date);

    const header = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true);   // ローカルファイルヘッダ
    dv.setUint16(4, 20, true);           // 必要バージョン
    dv.setUint16(6, 0, true);            // フラグ
    dv.setUint16(8, 0, true);            // 圧縮方式 = store
    dv.setUint16(10, time, true);
    dv.setUint16(12, day, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, bytes.length, true);
    dv.setUint32(22, bytes.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    this.parts.push(header, bytes);
    this.entries.push({ nameBytes, crc, size: bytes.length, offset: this.offset, time, day });
    this.offset += header.length + bytes.length;
    return this;
  }

  /** ZIP を Blob として書き出す */
  blob() {
    const central = [];
    let centralSize = 0;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.nameBytes.length);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 20, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, e.time, true);
      dv.setUint16(14, e.day, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.size, true);
      dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.nameBytes.length, true);
      dv.setUint32(42, e.offset, true);
      rec.set(e.nameBytes, 46);
      central.push(rec);
      centralSize += rec.length;
    }
    const end = new Uint8Array(22);
    const dv = new DataView(end.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, this.entries.length, true);
    dv.setUint16(10, this.entries.length, true);
    dv.setUint32(12, centralSize, true);
    dv.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...central, end], { type: 'application/zip' });
  }

  /** 概算サイズ [byte] */
  size() {
    return this.offset + this.entries.reduce((s, e) => s + 46 + e.nameBytes.length, 0) + 22;
  }
}

/** Blob をダウンロードさせる */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
