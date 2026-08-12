'use strict';

/**
 * obfuscate-ui.js —— 打包前混淆 build/ui/ 下的自有前端脚本
 *
 * 背景：桌面包把 gourd-ai-agent/src/main/resources/static 原样复制到包内 ui/，
 * 安装后可直接阅读全部业务 JS。此脚本在 electron-builder 打包前对 build/ui/ 做
 * <b>原位混淆</b>（源码目录不受影响，dev 模式仍读明文，便于调试）。
 *
 * 范围与安全性：
 * - 仅混淆自有业务脚本：js/app-*.js 与 js/message-queue.js；
 * - 第三方库（*.min.js、layui、codemirror、highlight）一律不动（已压缩，且混淆可能破坏其自校验逻辑）；
 * - 业务脚本是经典 <script> 全局变量互相引用的写法，故 renameGlobals=false、
 *   selfDefending=false、disableConsoleOutput=false，只改局部标识符/字符串/控制流，
 *   保证跨文件全局引用不被破坏；
 * - 混淆后对每个产物做语法校验（new Function 解析），失败即中断构建。
 *
 * HTML 内联脚本不在本期处理范围（核心逻辑均在外部 js 文件中）。
 */

const fs = require('fs');
const path = require('path');

let JavaScriptObfuscator;
try {
  JavaScriptObfuscator = require('javascript-obfuscator');
} catch (e) {
  console.error('[obfuscate-ui] 缺少依赖 javascript-obfuscator，请先运行: npm install');
  process.exit(1);
}

const UI_DIR = path.join(__dirname, '..', 'build', 'ui');
const JS_DIR = path.join(UI_DIR, 'js');

function fail(msg) {
  console.error('[obfuscate-ui] 错误: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(UI_DIR)) {
  fail('build/ui/ 不存在，请先运行 npm run prepare-resources');
}

// 自有业务脚本：app-*.js 与 message-queue.js；其余（*.min.js 等第三方）跳过
const targets = fs.readdirSync(JS_DIR)
  .filter((f) => /^app-.*\.js$/.test(f) || f === 'message-queue.js')
  .map((f) => path.join(JS_DIR, f));

if (targets.length === 0) {
  fail('未在 ' + JS_DIR + ' 下找到任何 app-*.js');
}

const options = {
  compact: true,
  target: 'browser',
  // —— 标识符：局部变量十六进制化；全局名一律保留（跨文件引用的基石） ——
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  // —— 字符串数组 + base64 编码：把可读字符串（URL、DOM 类名、文案）抽走 ——
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ['base64'],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  // —— 控制流平坦化（中等强度，兼顾启动速度）——
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  // —— 明确关闭的高风险项 ——
  deadCodeInjection: false,        // 体积膨胀大，收益低
  splitStrings: false,             // 避免触碰模板字符串/拼接边界
  selfDefending: false,            // 与格式化工具链冲突风险
  disableConsoleOutput: false,     // 前端仍需 console 调试
  unicodeEscapeSequence: false,    // 中文文案不做 unicode 转义（体积）
};

let totalIn = 0;
let totalOut = 0;
for (const file of targets) {
  const src = fs.readFileSync(file, 'utf8');
  totalIn += src.length;
  let result;
  try {
    result = JavaScriptObfuscator.obfuscate(src, options).getObfuscatedCode();
  } catch (e) {
    fail('混淆失败 ' + path.basename(file) + ': ' + (e && e.message));
  }
  // 语法自检：混淆产物必须可被 JS 引擎解析
  try {
    // 注：app-*.js 为浏览器脚本，这里仅做语法级校验，不执行
    new Function(result);
  } catch (e) {
    fail('混淆产物语法校验失败 ' + path.basename(file) + ': ' + (e && e.message));
  }
  fs.writeFileSync(file, result, 'utf8');
  totalOut += result.length;
}

console.log('[obfuscate-ui] 已混淆 ' + targets.length + ' 个业务脚本 ('
  + (totalIn / 1024).toFixed(0) + ' KB → ' + (totalOut / 1024).toFixed(0) + ' KB)');
