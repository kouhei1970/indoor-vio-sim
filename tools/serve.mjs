/**
 * 依存無しの静的ファイルサーバ。
 * ES モジュールは file:// から読み込めないので、ローカルサーバ経由で開く。
 *
 *   node tools/serve.mjs [--port 8080] [--host 127.0.0.1]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** 静的サーバを起動する (他のツールからも使えるよう関数として公開) */
export function startServer({ port = 8080, host = '127.0.0.1' } = {}) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: addr.port, host, url: `http://${host}:${addr.port}/` });
    });
  });
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    // ルート外へのアクセスを防ぐ
    const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(ROOT)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const info = await stat(full).catch(() => null);
    if (!info || info.isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // SharedArrayBuffer は使わないが、将来の WASM 物理エンジン用に緩めておく
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err.message}`);
  }
}

// 直接実行されたときだけサーバを起動する
if (process.argv[1] && process.argv[1].endsWith('serve.mjs')) {
  const args = process.argv.slice(2);
  const getArg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const port = Number(getArg('port', process.env.PORT || 8080));
  const host = getArg('host', '127.0.0.1');
  const info = await startServer({ port, host });
  console.log(`屋内ドローンシミュレータを起動しました:  ${info.url}`);
  console.log('終了するには Ctrl+C');
}
