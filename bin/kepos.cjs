#!/usr/bin/env node
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { ensureBuild } = require('./build-support.cjs');

// 中文 Windows 的 cmd 配置默认 GBK 代码页：Node 输出 UTF-8 字节会被按 GBK
// 解码，中文与制表符全部乱码（开机动画尤其明显）。启动前把控制台输出代码页
// 切到 UTF-8；尽力而为——非 Windows、无控制台或失败时静默跳过，doctor 会提示。
function ensureUtf8Console() {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return;
  try {
    const out = execFileSync('chcp', ['65001'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (!/65001/.test(out)) throw Error('chcp did not switch');
  } catch { /* 保持现状 */ }
}

/**
 * 一键可用性的核心：传统 conhost 不支持 ConPTY、字体缺字形、代码页 GBK——
 * 三个环境问题在 Windows Terminal 里同时消失（自带 Cascadia、ConPTY、UTF-8）。
 * 检测到旧控制台且装有 wt.exe 时，把本次命令搬进 Windows Terminal 重开，
 * 用户只管输入 kepos，窗口自己跳过去。跳不过去（没装 WT）就一句话指路。
 */
function hopIntoWindowsTerminal(args) {
  if (process.platform !== 'win32') return false;
  if (!process.stdout.isTTY) return false;                    // 管道/CI：别跳
  if (process.env.KEPOS_IN_WT) return false;                  // 已在 WT（防循环）
  if (process.env.WT_SESSION) return false;                   // 本来就在 WT
  if (process.env.TERM_PROGRAM || process.env.TERM) return false; // VS Code/WezTerm 等自有终端渲染正常
  let wt;
  try { wt = require('node:fs').existsSync(require('node:path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wt.exe')); }
  catch { wt = false; }
  if (!wt) {
    console.log('检测到传统控制台：Kepos 的界面需要 Windows Terminal（Win11 自带）。');
    console.log('安装：ms-windows-store://pdp/?productid=9N0DX20HK701 或 Microsoft Store 搜索 "Windows Terminal"，装好后在其中运行 kepos。');
    return false; // 继续尽力渲染，doctor 会给出同样提示
  }
  try {
    // wt -d <目录> kepos <参数>：新开 Windows Terminal 标签页运行同一条命令。
    // 跳进去后 WT_SESSION 必然存在，上面的闸保证不会二次跳转。
    const { spawn } = require('node:child_process');
    const child = spawn('wt.exe', ['-d', process.cwd(), 'kepos', ...args], { detached: true, stdio: 'ignore' });
    child.unref();
    process.exit(0);
  } catch { /* 跳转失败：留在当前窗口继续 */ }
  return false;
}

/**
 * 文件搜索工具（fd/rg）的就地供给：Pi 首启会从 GitHub Releases 下载它们，
 * 国内网络常超时。这里按 esbuild/swc 的 per-OS 思路解析本地二进制——
 * 优先已发布的平台子包（node_modules/kepos-tools-<plat>-<arch>/bin），
 * 其次主包自带的 vendor/<plat>-<arch>——把目录前置进 PATH 即可：
 * Pi 的工具解析在自有目录之后就会查 PATH，命中即不再下载。
 */
function prependBundledTools() {
  const plat = process.platform + '-' + process.arch; // win32-x64 / darwin-arm64 / linux-x64
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'kepos-tools-' + plat, 'bin'),
    path.join(__dirname, '..', 'vendor', plat),
  ];
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const dir = candidates.find(function (dir) {
    try { return require('node:fs').existsSync(path.join(dir, 'fd' + suffix)) && require('node:fs').existsSync(path.join(dir, 'rg' + suffix)); }
    catch { return false; }
  });
  if (dir) process.env.PATH = dir + path.delimiter + process.env.PATH;
  return dir || null;
}

async function start() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Kepos requires Node.js 24 or newer.');
  const args = process.argv.slice(2);
  if (args[0] !== 'doctor' && args[0] !== '--version' && args[0] !== 'setup') hopIntoWindowsTerminal(args);
  ensureUtf8Console();
  const bundledTools = prependBundledTools();
  if (bundledTools) process.env.KEPOS_BUNDLED_TOOLS = bundledTools; // doctor 据此报告来源
  const root = path.resolve(__dirname, '..');
  const entry = ensureBuild(root);
  const { main } = await import(pathToFileURL(entry).href);
  await main(process.argv.slice(2));
}

start().catch(function reportFailure(error) {
  console.error('Kepos: ' + (error?.message || String(error)));
  process.exitCode = 1;
});
