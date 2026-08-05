'use strict';

/**
 * main/index.js - Electron 主进程入口
 *
 * 启动流程（UI 已从后端解耦，界面外壳「秒开」）：
 * 1. app ready 后立即起本地 UI 服务器（http://localhost:{uiPort}）
 * 2. 主窗口导航到该 localhost 地址 —— 无需等待后端（秒开）
 * 3. 并行随机分配端口并启动 gourd-ai-agent.jar 子进程（serve 模式）
 * 4. 轮询 /web/chat/meta 等待后端就绪，就绪后放行 UI 服务器代理的 /web/** 请求
 * 5. 通过 IPC 通知渲染层 backend-ready（前端据此重连 WebSocket / 刷新数据）
 * 6. 应用退出时 kill 子进程 + 关闭 UI 服务器
 *
 * 关键点：UI（HTML/JS/CSS）由本地 HTTP 服务器从磁盘直接提供，仅 /web/**、
 * /chat/channel/** 与 WebSocket 反向代理到本地 jar。页面 origin 为
 * http://localhost:{uiPort}，是浏览器特判的可信来源，故摄像头 getUserMedia、
 * 语音识别、剪贴板等能力可用（自定义协议 app:// 会禁用这些）。详见 ui-server.js。
 */

const { app, BrowserWindow, screen, Menu, Tray, ipcMain, nativeImage, session } = require('electron');
const path = require('path');
const {
  findAvailablePort,
  startBackend,
  waitForBackend,
  stopBackend,
} = require('./backend');
const uiServer = require('./ui-server');
const { provisionCli } = require('./cli-provision');

// 单实例锁：防止多开
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
// Code 模式项目新窗体列表（与 mainWindow 分离：主窗口关闭是隐藏到托盘，项目窗口关闭则销毁）
const projectWindows = new Set();
let tray = null;
let backendPort = 0;
let uiOrigin = '';        // 本地 UI 服务器 origin：http://localhost:{uiPort}
let uiServerHandle = null;
let isQuitting = false;

// ─── 后端就绪状态（供 UI 服务器代理判断是否放行 /web/** 请求）─────────────
// backendReadyState: 'pending' | 'ready' | 'failed'
let backendReadyState = 'pending';
const backendReadyWaiters = [];

/**
 * 标记后端就绪结果，唤醒所有等待者，并通知渲染层。
 * @param {boolean} ok
 */
function settleBackendReady(ok) {
  if (backendReadyState !== 'pending') return;
  backendReadyState = ok ? 'ready' : 'failed';
  const waiters = backendReadyWaiters.splice(0);
  for (const w of waiters) w(ok);

  if (ok) {
    // 通知渲染层：后端已就绪（前端据此重连 WebSocket / 触发数据刷新 / 放行启动请求）。
    // 广播到所有窗口（主窗口 + 项目新窗体）；页面可能尚未加载完成，
    // sendToWindow 内部用 did-finish-load 兜底，避免事件丢失导致前端一直等待。
    broadcastToRenderer('backend-ready', { port: backendPort });
  }
}

/**
 * 向指定窗口发送 IPC 消息；页面仍在加载时等 did-finish-load 后再发，避免消息丢失。
 * @param {BrowserWindow|null} win
 * @param {string} channel
 * @param {object} payload
 */
function sendToWindow(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  const push = () => {
    if (win && !win.isDestroyed()) wc.send(channel, payload);
  };
  if (wc.isLoading()) {
    wc.once('did-finish-load', push);
  } else {
    push();
  }
}

/** 广播到所有窗口（主窗口 + 项目新窗体），供 backend-ready/failed 等全局事件使用。 */
function broadcastToRenderer(channel, payload) {
  const wins = [mainWindow].concat(Array.from(projectWindows));
  for (const w of wins) sendToWindow(w, channel, payload);
}

/** 解析窗口要加载的本地 UI 地址；options 作为 URL hash 传给前端。 */
function buildUiUrl(options) {
  if (!uiOrigin) return uiOrigin;
  return (options && options.project) ? `${uiOrigin}#project=${encodeURIComponent(options.project)}` : uiOrigin;
}

/**
 * 新建一个「项目窗体」（原生 BrowserWindow，非浏览器窗口）：
 * 加载同一本地 UI 服务器地址，并以 #project=<路径> 携带项目根，
 * 前端据此直达 code 模式并打开该项目。后端/UI 服务器为多窗口共享，无需重复启动。
 * 同一项目已开窗时聚焦该窗口，不重复开。
 * @param {{project: string}} options
 * @returns {BrowserWindow}
 */
function createProjectWindow(options) {
  const project = String((options && options.project) || '');
  for (const w of projectWindows) {
    if (!w.isDestroyed() && w.__projectPath === project) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      return w;
    }
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    title: 'Gourd AI',
    width: Math.min(1440, Math.max(1024, Math.floor(width * 0.8))),
    height: Math.min(900, Math.max(640, Math.floor(height * 0.85))),
    minWidth: 960,
    minHeight: 600,
    show: false,
    icon: getIconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#dcdde1',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.__projectPath = project;
  projectWindows.add(win);

  // 禁止页面 <title> 覆盖窗口标题（标题由前端经 window-title-update 定制）
  win.on('page-title-updated', (e) => e.preventDefault());
  win.loadURL(buildUiUrl({ project }));
  win.once('ready-to-show', () => win.show());

  // 后端若尚未就绪（极早触发的场景），就绪后补通知，确保前端门闸放行
  if (backendReadyState === 'ready') {
    sendToWindow(win, 'backend-ready', { port: backendPort });
  } else if (backendReadyState === 'failed') {
    sendToWindow(win, 'backend-failed', { message: 'backend failed' });
  }

  // 项目窗口关闭即销毁（不隐藏到托盘；主窗口仍在托盘逻辑里）
  win.on('close', () => {
    projectWindows.delete(win);
  });
  return win;
}

/**
 * 等待后端就绪。已定局立即返回；否则挂起直至 settle 或超时。
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} ready→true，failed/超时→false
 */
function awaitBackendReady(timeoutMs) {
  if (backendReadyState === 'ready') return Promise.resolve(true);
  if (backendReadyState === 'failed') return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const once = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    backendReadyWaiters.push(once);
    setTimeout(() => once(false), timeoutMs);
  });
}

/**
 * 创建主窗口
 */
function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    title: 'Gourd AI',
    width: Math.min(1440, width),
    height: Math.min(900, height),
    minWidth: 960,
    minHeight: 600,
    show: false,
    icon: getIconPath(),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#dcdde1',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 禁止页面 <title> 覆盖窗口标题
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  // 加载本地 UI 服务器（http://localhost:{uiPort}，秒开，无需等待后端）。
  // 界面里的 /web/** 接口请求与 WebSocket 由该服务器同源反向代理到本地 jar，
  // 后端就绪前这些请求会挂起等待（见 ui-server.js），外壳与静态资源不受影响。
  mainWindow.loadURL(uiOrigin);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 关闭窗口时隐藏到托盘，不退出程序
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

/**
 * 显示所有窗口（主窗口 + 项目新窗体）。
 */
function showAllWindows() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  for (const w of projectWindows) {
    if (!w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.show();
    }
  }
}

/**
 * 隐藏所有窗口（主窗口 + 项目新窗体），应用仍驻留托盘。
 */
function hideAllWindows() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  for (const w of projectWindows) {
    if (!w.isDestroyed()) w.hide();
  }
}

/**
 * 创建系统托盘
 */
function createTray() {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon);
  tray.setToolTip('Gourd AI');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        showAllWindows();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  // 单击托盘图标显示/隐藏窗口（多窗口场景下整体显示/隐藏）
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      hideAllWindows();
    } else {
      showAllWindows();
    }
  });
}

/**
 * 获取应用图标路径
 */
function getIconPath() {
  const ext = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icons', ext);
  }
  return path.join(__dirname, '..', 'resources', 'icons', ext);
}

/**
 * 引导后端启动。窗口与本地 UI 已由 createMainWindow 立即加载，
 * 此处只负责启动 jar 子进程并在就绪后放行 app:// 代理的接口请求。
 */
let bootstrapStarted = false;
async function bootstrap() {
  // 幂等：macOS activate 等场景可能重复触发，避免重复分配端口/重启后端
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  try {
    // 1. 分配后端 jar 端口
    if (!backendPort) {
      backendPort = await findAvailablePort();
      console.log(`[gourd-ai-desktop] 后端端口: ${backendPort}`);
    }

    // 2. 启动 Java 子进程
    const { pid } = await startBackend(backendPort);
    console.log(`[gourd-ai-desktop] 后端已启动, PID=${pid}`);

    // 3. 等待就绪（此期间界面外壳已可见，仅 /web/** 接口请求在 UI 服务器挂起等待）
    console.log('[gourd-ai-desktop] 等待后端就绪...');
    await waitForBackend(backendPort, 60000);
    console.log('[gourd-ai-desktop] 后端就绪');

    // 4. 放行代理请求并通知渲染层刷新
    settleBackendReady(true);
  } catch (err) {
    console.error('[gourd-ai-desktop] 启动失败:', err.message);
    // 让挂起中的 /web/** 代理请求尽快得到 503，而不是一直等到超时
    settleBackendReady(false);
    // 通知渲染层展示错误横幅（外壳已加载，直接注入提示即可）
    const errMsg = String(err.message || err).replace(/`/g, '\\`');
    broadcastToRenderer('backend-failed', { message: errMsg });
  }
}

// ─── Electron 生命周期 ──────────────────────────────────────────────────────

// 主题色映射，与 web 端 theme.css 保持一致
const THEME_COLORS = {
  light: { color: '#00000000', symbolColor: '#1a1a2e', height: 36 },
  dark:  { color: '#00000000', symbolColor: '#dcdde1', height: 36 },
};

ipcMain.on('theme-changed', (event, theme) => {
  // 同步发送方窗口的标题栏颜色（主窗口与项目新窗体都跟随主题）
  const sender = event && event.sender;
  const win = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : mainWindow;
  if (win && !win.isDestroyed()) {
    const colors = THEME_COLORS[theme] || THEME_COLORS.dark;
    win.setTitleBarOverlay(colors);
  }
});

// Code 模式：请求在新窗体中打开项目空间（原生 BrowserWindow，非浏览器窗口）
ipcMain.handle('open-project-window', (_event, options) => {
  const project = String((options && options.project) || '');
  if (!project) return false;
  createProjectWindow({ project });
  return true;
});

// 窗口启动时查询自己承载的项目根（主进程权威来源，避免 hash 被页面逻辑意外改写）
ipcMain.handle('get-window-project', (event) => {
  const sender = event && event.sender;
  const win = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null;
  return (win && win.__projectPath) || '';
});

// 渲染层定制窗口标题（如显示当前项目名；Electron 禁用了页面 title 覆盖）
ipcMain.on('window-title-update', (event, title) => {
  const sender = event && event.sender;
  const win = sender && !sender.isDestroyed() ? BrowserWindow.fromWebContents(sender) : null;
  if (win) win.setTitle(String(title || 'Gourd AI'));
});

// 渲染层主动查询后端就绪状态（'pending' | 'ready' | 'failed'）。
// 与 backend-ready/backend-failed 事件互补，消除“事件早于监听器注册”的启动竞态。
ipcMain.handle('get-backend-state', () => backendReadyState);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // 去掉原生菜单栏

  // 放行媒体权限（摄像头/麦克风）——Electron 默认拒绝，即使 localhost 也需显式允许。
  // 仅放行本地 UI origin 的 media 请求，其余照常。
  const allowMedia = (perm) => perm === 'media' || perm === 'mediaKeySystem'
      || perm === 'audioCapture' || perm === 'videoCapture';
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(allowMedia(perm));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowMedia(perm));

  // 起本地 UI 服务器（http://localhost:{uiPort}）——立即可提供静态外壳（秒开），
  // /web/** 与 WebSocket 反向代理到后端 jar（就绪前挂起等待）。
  try {
    uiServerHandle = await uiServer.start({
      getBackendPort: () => backendPort,
      awaitBackend: awaitBackendReady,
    });
    uiOrigin = uiServerHandle.origin;
    console.log(`[gourd-ai-desktop] UI 服务器: ${uiOrigin}`);
  } catch (e) {
    console.error('[gourd-ai-desktop] UI 服务器启动失败:', e && e.message);
  }

  createMainWindow();
  createTray();
  bootstrap();

  // 注册终端命令 `gourdai`（写启动器到安装目录的 .gourdai/bin 并加入 PATH，指向自带 JRE）。
  // 非阻塞、幂等、自愈；失败只告警不影响 App。仅打包版执行（dev 态无自带 JRE），
  // 可用 GOURDAI_PROVISION_CLI=1 在开发时强制启用以便调试。
  if (app.isPackaged || process.env.GOURDAI_PROVISION_CLI === '1') {
    provisionCli().catch((e) => console.warn('[gourd-ai-desktop] 终端命令注册异常:', e && e.message));
  }
});

// macOS 点击 dock 图标恢复窗口
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  } else {
    // 窗口被销毁后重建：重新加载本地 UI 服务器地址（服务器仍在运行）。
    // 后端若已就绪，bootstrap() 因幂等直接返回，UI 服务器照常代理接口。
    createMainWindow();
    bootstrap();
  }
});

// 窗口全部关闭时不退出（托盘仍在运行）
app.on('window-all-closed', () => {
  // do nothing — 通过托盘菜单"退出"才真正退出
});

// 退出前清理后端进程
app.on('before-quit', async (event) => {
  event.preventDefault();
  isQuitting = true;
  if (uiServerHandle) {
    try { uiServerHandle.close(); } catch (e) { /* ignore */ }
  }
  await stopBackend();
  app.exit(0);
});

// 第二个实例启动时显示已有窗口（多窗口场景：主窗口 + 项目新窗体整体恢复）
app.on('second-instance', () => {
  showAllWindows();
});
