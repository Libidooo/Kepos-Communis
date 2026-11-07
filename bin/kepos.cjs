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

async function start() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Kepos requires Node.js 24 or newer.');
  ensureUtf8Console();
  const root = path.resolve(__dirname, '..');
  const entry = ensureBuild(root);
  const { main } = await import(pathToFileURL(entry).href);
  await main(process.argv.slice(2));
}

start().catch(function reportFailure(error) {
  console.error('Kepos: ' + (error?.message || String(error)));
  process.exitCode = 1;
});
