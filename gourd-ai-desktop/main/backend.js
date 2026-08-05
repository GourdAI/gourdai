'use strict';

/**
 * backend.js - gourd-ai-agent JAR 子进程管理
 *
 * 参考 electron-egg 的 CrossProcess 设计：
 * - 通过 child_process.spawn 启动外部可执行程序（此处为 java -jar）
 * - 轮询 HTTP 健康检查等待后端就绪
 * - 应用退出时通过 tree-kill 清理子进程树
 */

const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const tkill = require('tree-kill');
const { app } = require('electron');

// 子进程句柄
let child = null;
let childPid = 0;

/**
 * 获取内置资源目录（extraResources）
 * - 开发环境：项目根目录下的 build/extraResources/
 * - 打包后：process.resourcesPath/extraResources/（electron-builder extraResources 目标）
 */
function getResourcesDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'extraResources');
  }
  return path.join(__dirname, '..', 'build', 'extraResources');
}

/**
 * 定位 Java 可执行文件
 * 查找顺序：
 * 1. 内置 JRE（build/extraResources/jre/bin/java）——必须是「完整」的 JRE（含 bin/java）
 * 2. 环境变量 JAVA_EXEC（直接指定 java 路径）
 * 3. 环境变量 JAVA_HOME/bin/java
 * 4. 系统 PATH 中的 java
 * 5. 常见回退位置：IntelliJ 下载的 JDK（~/.jdks）、常见安装目录
 *
 * 注意：内置 JRE 若生成不完整（只有 legal/，缺 bin/），必须继续往后找，
 * 否则打包版找不到 Java → 后端不启动 → 所有 /web/** 接口失败。
 */
function findJava() {
  const fs = require('fs');
  const os = require('os');
  // Windows 用 javaw.exe（无控制台窗口），其他平台用 java
  const javaName = process.platform === 'win32' ? 'javaw.exe' : 'java';
  const javaConsole = process.platform === 'win32' ? 'java.exe' : 'java';

  // 在某个 java home 下找可执行文件（优先无窗口的 javaw，回退到 java）
  const javaInHome = (home) => {
    if (!home) return null;
    const a = path.join(home, 'bin', javaName);
    if (fs.existsSync(a)) return a;
    const b = path.join(home, 'bin', javaConsole);
    if (fs.existsSync(b)) return b;
    return null;
  };

  // 1. 内置 JRE（打包首选）
  const resDir = getResourcesDir();
  const bundledJava = javaInHome(path.join(resDir, 'jre'));
  if (bundledJava) {
    return bundledJava;
  }
  console.warn('[gourd-ai-desktop] 内置 JRE 不可用（缺 bin/java），尝试系统 Java…');

  // 2. JAVA_EXEC 环境变量
  if (process.env.JAVA_EXEC && fs.existsSync(process.env.JAVA_EXEC)) {
    return process.env.JAVA_EXEC;
  }

  // 3. JAVA_HOME/bin/java
  const jhJava = javaInHome(process.env.JAVA_HOME);
  if (jhJava) {
    return jhJava;
  }

  // 4. 系统 PATH 搜索
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, javaName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const candidate2 = path.join(dir, javaConsole);
    if (fs.existsSync(candidate2)) {
      return candidate2;
    }
  }

  // 5. 常见回退位置（含 IntelliJ 下载的 JDK/JBR）
  const searchRoots = [];
  searchRoots.push(path.join(os.homedir(), '.jdks')); // IntelliJ
  if (process.platform === 'win32') {
    searchRoots.push('C:\\Program Files\\Eclipse Adoptium');
    searchRoots.push('C:\\Program Files\\Java');
    searchRoots.push('C:\\Program Files\\Microsoft');
    searchRoots.push('C:\\Program Files\\Zulu');
    searchRoots.push('C:\\Program Files\\Amazon Corretto');
  } else if (process.platform === 'darwin') {
    searchRoots.push('/Library/Java/JavaVirtualMachines');
  } else {
    searchRoots.push('/usr/lib/jvm');
  }

  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    let entries;
    try {
      entries = fs.readdirSync(root).sort().reverse(); // 高版本优先
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const home = path.join(root, entry);
      // macOS 的 .jdk 常见结构：<home>/Contents/Home/bin/java
      const found = javaInHome(home)
        || javaInHome(path.join(home, 'Contents', 'Home'));
      if (found) {
        console.log(`[gourd-ai-desktop] 使用系统 Java: ${found}`);
        return found;
      }
    }
  }

  return null;
}

/**
 * 定位内置 gourd-ai-agent.jar
 */
function findJar() {
  const resDir = getResourcesDir();
  const jarPath = path.join(resDir, 'gourd-ai-agent.jar');

  const fs = require('fs');
  if (fs.existsSync(jarPath)) {
    return jarPath;
  }
  return null;
}

/**
 * 在 127.0.0.1 随机分配一个可用端口（绑定 :0 后立即释放）
 * @returns {Promise<number>}
 */
function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

/**
 * 轮询 GET /web/chat/meta 等待后端 HTTP 服务就绪
 * @param {number} port
 * @param {number} timeoutMs - 最大等待毫秒数
 * @returns {Promise<void>}
 */
function waitForBackend(port, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const intervalMs = 300;

    function check() {
      if (Date.now() > deadline) {
        return reject(new Error(`后端启动超时（${timeoutMs / 1000}秒）`));
      }

      const req = http.get(`http://127.0.0.1:${port}/web/chat/meta`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(check, intervalMs);
        }
        // 消费掉响应体，避免 socket hang
        res.resume();
      });

      req.on('error', () => setTimeout(check, intervalMs));
      req.setTimeout(500, () => {
        req.destroy();
        setTimeout(check, intervalMs);
      });
    }

    check();
  });
}

/**
 * 启动 gourd-ai-agent JAR 子进程
 * @param {number} port
 * @returns {Promise<{pid: number, port: number}>}
 */
async function startBackend(port) {
  // 若已有存活进程，直接复用
  if (child && childPid > 0) {
    return { pid: childPid, port };
  }

  const java = findJava();
  const jar = findJar();

  if (!java) {
    throw new Error(
      `未找到可用的 Java 运行时\n` +
      `已尝试：内置 JRE(${path.join(getResourcesDir(), 'jre', 'bin')})、JAVA_EXEC、JAVA_HOME、系统 PATH、~/.jdks 及常见安装目录\n` +
      `请重新运行构建脚本生成内置 JRE（npm run generate-jre），或在系统安装 Java 17+ 并加入 PATH`
    );
  }
  if (!jar) {
    throw new Error(
      `未找到 gourd-ai-agent.jar\n预期路径: ${getResourcesDir()}\n` +
      `请先运行构建脚本复制 JAR 文件`
    );
  }

  const args = [
    '-Dfile.encoding=UTF-8',
    '-Dsolon.boot.openBrowser=false',  // 禁止自动打开浏览器
    '-Dgourdai.home=' + getResourcesDir(),  // 全局配置区根（与 ACP 子进程一致，保证读同一份全局配置）
    '-jar', jar,
    'web', String(port),  // web 模式：完整注册 WebController + /web/gate + WebSocket
  ];

  // 日志文件：<安装目录>/.gourdai/logs/gourd-ai-desktop-server.log
  const logPath = getServerLogPath();
  const fs = require('fs');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // 使用 fs.openSync 获取文件描述符，可直接传给 stdio
  const logFd = fs.openSync(logPath, 'a');

  const stdio = ['ignore', logFd, logFd];

  console.log(`[gourd-ai-desktop] 启动后端: ${java} ${args.join(' ')}`);

  // 显式清除可能影响 JVM classloader 的环境变量
  const cleanEnv = { ...process.env };
  delete cleanEnv.JAVA_TOOL_OPTIONS;

  child = spawn(java, args, {
    stdio,
    detached: false,
    windowsHide: true,
    cwd: getResourcesDir(),
    env: cleanEnv,
  });

  // 子进程启动后即可关闭父进程的 fd 副本（子进程已继承）
  try { fs.closeSync(logFd); } catch (e) { /* ignore */ }

  childPid = child.pid;
  console.log(`[gourd-ai-desktop] 后端进程 PID=${childPid}`);

  child.on('exit', (code, signal) => {
    console.log(`[gourd-ai-desktop] 后端进程退出 code=${code} signal=${signal}`);
    child = null;
    childPid = 0;
  });

  child.on('error', (err) => {
    console.error(`[gourd-ai-desktop] 后端进程错误: ${err.message}`);
    child = null;
    childPid = 0;
  });

  return { pid: childPid, port };
}

/**
 * 停止后端进程（通过 tree-kill 清理整个进程树）
 * 等待进程真正退出后再 resolve，避免重启时资源冲突
 * @returns {Promise<void>}
 */
function stopBackend() {
  return new Promise((resolve) => {
    if (!child || childPid === 0) {
      return resolve();
    }

    const pid = childPid;
    const proc = child;
    child = null;
    childPid = 0;

    console.log(`[gourd-ai-desktop] 停止后端进程 PID=${pid}`);

    // 等待进程真正退出
    let exited = false;
    const onExit = () => {
      exited = true;
      resolve();
    };
    proc.once('exit', onExit);

    // 先发 SIGTERM
    tkill(pid, 'SIGTERM', (err) => {
      if (err) {
        tkill(pid, 'SIGKILL', () => {});
      }
    });

    // 最多等 3 秒，超时强制 SIGKILL 并继续
    setTimeout(() => {
      if (!exited) {
        proc.removeListener('exit', onExit);
        tkill(pid, 'SIGKILL', () => {});
        setTimeout(resolve, 500);
      }
    }, 3000);
  });
}

/**
 * 服务端日志路径
 * <p>与后端 Java 侧一致：统一落<b>安装目录</b>（extraResources）下的 .gourdai/logs，
 * 不再写用户主目录 ~/.gourdai。</p>
 */
function getServerLogPath() {
  return path.join(getResourcesDir(), '.gourdai', 'logs', 'gourd-ai-desktop-server.log');
}

module.exports = {
  findAvailablePort,
  startBackend,
  waitForBackend,
  stopBackend,
  getServerLogPath,
  getResourcesDir,
};
