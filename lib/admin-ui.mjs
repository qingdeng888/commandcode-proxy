// ── 后台静态资源 ──────────────────────────────────────
// 前端是 Vite 构建产物（web/ -> web/dist），这里只做静态托管：
// 不引入任何静态服务依赖，因为需要控制的只有三件事 —— MIME、缓存头、路径穿越。
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, join, normalize, extname, sep } from 'path';
import { ROOT } from './store.mjs';

export const DIST_DIR = process.env.CC_WEB_DIST
  ? resolve(process.env.CC_WEB_DIST)
  : resolve(ROOT, 'web', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function distReady() {
  return existsSync(join(DIST_DIR, 'index.html'));
}

const NOT_BUILT_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理后台尚未构建</title>
<style>
:root{--bg:#0b0e17;--panel:rgba(148,163,184,.055);--border:rgba(148,163,184,.14);--text:#e6edf6;--text2:#8b98b4;--accent:#22d3ee;--radius:14px}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);
font-family:'Inter','Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif;padding:24px}
.card{max-width:640px;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);
padding:32px;backdrop-filter:blur(14px)}
h1{margin:0 0 12px;font-size:20px}
p{color:var(--text2);line-height:1.7;margin:10px 0}
code{background:rgba(148,163,184,.12);padding:2px 7px;border-radius:6px;color:var(--accent);
font-family:'JetBrains Mono',Consolas,monospace;font-size:13px}
pre{background:rgba(0,0,0,.35);border:1px solid var(--border);border-radius:9px;padding:14px;overflow:auto;
font-family:'JetBrains Mono',Consolas,monospace;font-size:13px;color:#cfe3f5}
</style></head><body>
<div class="card">
  <h1>⚡ 管理后台前端尚未构建</h1>
  <p>后端已经在运行，但找不到前端构建产物：<code>web/dist/index.html</code></p>
  <p>请先构建前端：</p>
  <pre>npm run build:web</pre>
  <p>使用 Docker 部署时不需要这一步 —— 镜像构建过程会自动完成前端构建。</p>
  <p>数据面接口（<code>/v1/*</code>）不受影响，可以正常调用。</p>
</div></body></html>`;

function sendNotBuilt(res) {
  res.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(NOT_BUILT_HTML);
}

function sendFile(res, filePath, { immutable = false } = {}) {
  let body;
  try {
    body = readFileSync(filePath);
  } catch {
    return false;
  }
  const ext = extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    // Vite 产物带内容哈希，可长缓存；index.html 绝不缓存，否则发新版本后用户拿到旧壳。
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(body);
  return true;
}

/**
 * 处理 /admin 与 /admin/*（不含 /admin/api/*）。
 * 返回 true 表示已处理。
 */
export function serveAdminAsset(req, res, pathname) {
  if (!distReady()) {
    sendNotBuilt(res);
    return true;
  }

  let rel = pathname.replace(/^\/admin\/?/, '');
  if (rel === '' || rel === 'login') rel = 'index.html';   // /admin/login 兼容参考项目的旧地址

  // 路径穿越防护：normalize 后必须仍在 DIST_DIR 之内
  const target = normalize(join(DIST_DIR, rel));
  if (target !== DIST_DIR && !target.startsWith(DIST_DIR + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }

  // 目录 / 不存在的路径 → 交给前端（hash 路由只有一个入口）
  let isFile = false;
  try { isFile = statSync(target).isFile(); } catch {}

  if (isFile && rel !== 'index.html') {
    // Vite 的内容哈希是 base64url 风格（如 index-CEUYi4lu.js），不是十六进制，
    // 因此这里按「-<8 位以上 base64url 字符>.<ext>」判定，别再只认 [0-9a-f]。
    const immutable = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|ttf|png|jpe?g|gif|svg)$/i.test(rel);
    if (sendFile(res, target, { immutable })) return true;
  }

  if (sendFile(res, join(DIST_DIR, 'index.html'))) return true;
  sendNotBuilt(res);
  return true;
}
