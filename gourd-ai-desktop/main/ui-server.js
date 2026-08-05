'use strict';

/**
 * ui-server.js —— 本地 UI 服务器（http://localhost:{uiPort}）：本地 UI + 后端代理
 *
 * 设计目标：把 UI（HTML/JS/CSS）从后端 jar 中解耦，改为由 Electron 主进程
 * 起一个轻量 HTTP 服务立即提供，使界面外壳「秒开」，不必等待 JVM+Solon 启动。
 *
 * 为什么是 http://localhost 而不是自定义 app:// 协议：
 *   - 摄像头 getUserMedia、语音识别 SpeechRecognition、剪贴板等「可信来源」能力
 *     取决于【页面自身的 origin】。自定义协议（app://）不被浏览器视为可信来源，
 *     这些能力会被禁用；而 http://localhost 是浏览器特判的可信来源，全部可用。
 *   - 页面 origin 固定为 http://localhost:{uiPort}，所有 /web/**、WebSocket 都
 *     走同一 origin 同源代理，不涉及 CORS，也不混用 127.0.0.1 / localhost。
 *
 * 路由规则（页面加载于 http://localhost:{uiPort}/）：
 *   - /web/**、/chat/channel/**  → 反向代理到 http://127.0.0.1:{backendPort}（jar）
 *   - WebSocket 升级（/web/gate） → 透传到后端 WebSocket
 *   - 其它路径                    → 从本地 UI 目录读取静态文件
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');

/**
 * 后端未就绪时，代理请求的最长宽限等待（毫秒）。
 * 只为兜住“就绪前一瞬间抵达”的请求；超过即快速 503，绝不长时间占用浏览器连接。
 * 前端已将启动期 /web 请求延后到 backend-ready 之后再发，正常不会命中此宽限。
 */
const PROXY_GRACE_MS = 1500;

/** 需要转发到后端 jar 的路径前缀（其余按本地静态文件处理）。 */
function isBackendPath(pathname) {
  return pathname.startsWith('/web/')
      || pathname === '/web'
      || pathname.startsWith('/chat/channel/');
}

/** 扩展名 → Content-Type 映射（覆盖 UI 目录出现的全部资源类型）。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 本地 UI 目录：
 * - 打包后：process.resourcesPath/ui（electron-builder extraResources）
 * - 开发环境：直接指向 gourd-ai-agent 的静态资源源目录，改 UI 无需重新构建
 */
function getUiDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'ui');
  }
  return path.join(__dirname, '..', '..', 'gourd-ai-agent', 'src', 'main', 'resources', 'static');
}

/**
 * 启动本地 UI 服务器。
 *
 * @param {object} ctx
 * @param {() => number} ctx.getBackendPort 返回后端 jar 端口（0 表示未就绪）
 * @param {(timeoutMs:number)=>Promise<boolean>} ctx.awaitBackend
 *        等待后端就绪：ready→true，failed/超时→false
 * @returns {Promise<{port:number, origin:string, close:()=>void}>}
 *          解析为监听端口与 origin（http://localhost:{port}）
 */
function start(ctx) {
  const uiDir = path.resolve(getUiDir());

  const server = http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = decodeURI(new URL(req.url, 'http://localhost').pathname) || '/';
    } catch (e) {
      pathname = req.url.split('?')[0] || '/';
    }

    if (isBackendPath(pathname)) {
      proxyHttp(ctx, req, res);
    } else {
      serveFile(uiDir, pathname, res);
    }
  });

  // WebSocket 升级透传（/web/gate 等）：与后端建立裸 TCP 并双向 pipe
  server.on('upgrade', (req, clientSocket, head) => {
    proxyUpgrade(ctx, req, clientSocket, head);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // 绑定 localhost，使页面 origin 为 http://localhost:{port}
    server.listen(0, 'localhost', () => {
      const port = server.address().port;
      resolve({
        port,
        origin: `http://localhost:${port}`,
        close: () => { try { server.close(); } catch (e) { /* ignore */ } },
      });
    });
  });
}

/** 反向代理普通 HTTP 请求到后端 jar。 */
async function proxyHttp(ctx, req, res) {
  // 后端未就绪时【快速失败】(503)，不再长时间挂起。
  // 早期设计会 await 到 65s：桌面端冷启动数秒内，前端解析期发起的 /web 请求全被挂起，
  // 占满浏览器对同源的 ~6 个并发连接，导致静态的 app-code.js 都下载不下来、启动遮罩不消失。
  // 现在前端已改为等 backend-ready IPC 后再发这些请求（见 app-bootstrap.js 的门闸），
  // 故这里只需给一个很短的宽限（应对“就绪前一刻抵达”的请求），随后立即 503。
  const ready = await ctx.awaitBackend(PROXY_GRACE_MS);
  if (!ready) {
    res.statusCode = 503;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('retry-after', '1');
    res.end('后端启动中，请稍候…');
    return;
  }

  const backendPort = ctx.getBackendPort();
  const options = {
    host: '127.0.0.1',
    port: backendPort,
    method: req.method,
    path: req.url, // 保留原始 path + query
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + backendPort }),
  };

  const upstream = http.request(options, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });

  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    res.end('代理后端失败: ' + (err && err.message ? err.message : err));
  });

  // 透传请求体（POST/PUT/multipart 等）
  req.pipe(upstream);
}

/** 透传 WebSocket 升级握手：本地 socket ↔ 后端 socket 双向 pipe。 */
async function proxyUpgrade(ctx, req, clientSocket, head) {
  // 与 proxyHttp 同理：未就绪时短暂宽限后即拒绝。前端 WebSocket 有自动重连退避，
  // 且后端就绪时主进程会经 IPC 通知前端立即重连（见 app-streaming.js），无需在此久等。
  const ready = await ctx.awaitBackend(PROXY_GRACE_MS);
  if (!ready) {
    clientSocket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }

  const backendPort = ctx.getBackendPort();
  const upstream = net.connect(backendPort, '127.0.0.1', () => {
    // 重建升级请求行 + 头，转发给后端
    const headers = Object.assign({}, req.headers, { host: '127.0.0.1:' + backendPort });
    let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
    for (const k of Object.keys(headers)) {
      const v = headers[k];
      if (Array.isArray(v)) {
        for (const vv of v) raw += k + ': ' + vv + '\r\n';
      } else {
        raw += k + ': ' + v + '\r\n';
      }
    }
    raw += '\r\n';
    upstream.write(raw);
    if (head && head.length) upstream.write(head);

    // 双向透传（后端的 101 响应也会原样回给客户端）
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const onErr = () => { try { clientSocket.destroy(); } catch (e) {} try { upstream.destroy(); } catch (e) {} };
  upstream.on('error', onErr);
  clientSocket.on('error', onErr);
}

/**
 * 从本地 UI 目录读取并返回静态文件；根路径回退到 index.html。
 * 做路径穿越防护，越界一律 403。
 */
function serveFile(uiDir, pathname, res) {
  let rel = pathname;
  if (rel === '/' || rel === '') {
    rel = '/index.html';
  }

  const filePath = path.resolve(path.join(uiDir, '.' + rel));
  // 防路径穿越：解析结果必须仍在 uiDir 内
  if (filePath !== uiDir && !filePath.startsWith(uiDir + path.sep)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.statusCode = 404;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('not found: ' + rel);
      } else if (err.code === 'EISDIR') {
        // 目录：回退到其 index.html
        serveFile(uiDir, path.posix.join(rel, 'index.html'), res);
      } else {
        res.statusCode = 500;
        res.end('read error: ' + (err.message || err));
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    res.end(data);
  });
}

module.exports = {
  start,
  getUiDir,
  isBackendPath,
};
