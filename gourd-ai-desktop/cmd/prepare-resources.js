'use strict';

/**
 * prepare-resources.js —— electron-builder 打包前置：确保前端 UI 已就位到 build/ui/
 *
 * 背景：builder-*.json 的 extraResources 会把 build/ui/ 复制进包内的 ui/。
 * 若打包时 build/ui/ 为空（例如直接跑 npm run build:win 而没走 build.ps1），
 * 包里就没有前端，运行时 ui-server 会返回 "not found: /index.html"。
 *
 * 因此在每次 build:win/mac/linux 前，都从单一来源（gourd-ai-agent 静态资源）
 * 重新同步到 build/ui/，杜绝“前端漏打包”。
 */

const fs = require('fs');
const path = require('path');

const UI_SOURCE = path.join(__dirname, '..', '..', 'gourd-ai-agent', 'src', 'main', 'resources', 'static');
const UI_DEST = path.join(__dirname, '..', 'build', 'ui');
const EXTRA = path.join(__dirname, '..', 'build', 'extraResources');

function fail(msg) {
  console.error('[prepare-resources] 错误: ' + msg);
  process.exit(1);
}

// ── 清理运行时污染：.gourdai 绝不能进安装包 ────────────────────────────────────
// 背景：开发模式下后端 Java 进程的 cwd 被设为 build/extraResources/（见 main/backend.js
// 的 getResourcesDir + 子进程 cwd），而 Java 侧配置按 user.dir 落盘，于是开发期产生的
// .gourdai/settings.json（模型、通用配置、会话、记忆等）会残留在此目录。extraResources
// 会把整个 build/extraResources/ 打进包，导致这份模板配置随包分发；重装时它进入卸载
// 清单被清除/覆盖 → 用户积累的模型配置、通用配置全部丢失。故打包前必须删除，确保
// .gourdai 只作为「运行时目录」存在（不入包的运行时文件重装反而会被保留）。
const POLLUTION = path.join(EXTRA, '.gourdai');
if (fs.existsSync(POLLUTION)) {
  fs.rmSync(POLLUTION, { recursive: true, force: true });
  console.log('[prepare-resources] 已移除打包污染目录: ' + POLLUTION);
}

if (!fs.existsSync(path.join(UI_SOURCE, 'index.html'))) {
  fail('前端源不存在: ' + path.join(UI_SOURCE, 'index.html'));
}

// 清空后重建，保证与源一致（避免残留旧文件）
fs.rmSync(UI_DEST, { recursive: true, force: true });
fs.mkdirSync(UI_DEST, { recursive: true });
fs.cpSync(UI_SOURCE, UI_DEST, { recursive: true });

if (!fs.existsSync(path.join(UI_DEST, 'index.html'))) {
  fail('复制后仍缺少 index.html: ' + UI_DEST);
}

const count = fs.readdirSync(UI_DEST).length;
console.log('[prepare-resources] 前端已就位: ' + UI_DEST + ' (' + count + ' 项)');

// ── 后端产物预检：JAR 与内置 JRE 必须就位，否则打包版无法启动后端 ──────────────
// 背景：内置 JRE 由 generate-jre.js 单独生成，不在构建链里。若忘记生成、或生成
// 不完整（只剩 legal/，缺 bin/java），打包版找不到 Java → 后端不启动 → 所有
// /web/** 接口失败（“加载模型连接列表失败”等）。这里在打包前快速失败并给出指引。
if (!fs.existsSync(path.join(EXTRA, 'gourd-ai-agent.jar'))) {
  fail('未找到后端 JAR: ' + path.join(EXTRA, 'gourd-ai-agent.jar')
    + '\n  请先 Maven 构建 gourd-ai-agent 再运行 `npm run generate-jre`');
}

const javaExe = process.platform === 'win32' ? 'javaw.exe' : 'java';
const jreJava = path.join(EXTRA, 'jre', 'bin', javaExe);
if (!fs.existsSync(jreJava)) {
  fail('内置 JRE 不完整或缺失（缺 bin/' + javaExe + '）: ' + path.join(EXTRA, 'jre')
    + '\n  请运行 `npm run generate-jre` 生成完整的内置 JRE 后再打包');
}
console.log('[prepare-resources] 后端产物已就位: JAR + 内置 JRE (' + jreJava + ')');
