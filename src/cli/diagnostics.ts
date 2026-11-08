import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageRoot, type AppPaths } from '../config.ts';

export function packageVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
}

/**
 * 终端环境体检：符号缺失/乱码/排线错位几乎都来自这里，而不是产品缺陷——
 * 传统 conhost 不走 ConPTY、代码页非 UTF-8 会把中文打散、字体不覆盖
 * ★◉╭┤ 会渲染成豆腐块。检测只报告，不阻断。
 */
export function terminalEnvironment() {
  const windows = process.platform === 'win32';
  // WT_SESSION：Windows Terminal 会注入；缺失多半是传统 conhost 或第三方终端。
  const windowsTerminal = Boolean(process.env.WT_SESSION);
  let codePage: number | undefined;
  if (windows) {
    try { codePage = Number((execFileSync('chcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/(\d+)/) || [])[1]); } catch { /* 读不到就算未知 */ }
  }
  const utf8 = !windows || codePage === undefined || codePage === 65001;
  const problems: string[] = [];
  if (windows && !windowsTerminal) problems.push('未检测到 Windows Terminal（WT_SESSION 缺失）：Kepos 的界面按 ConPTY 设计，请在 Windows Terminal 中运行 kepos');
  if (!utf8) problems.push(`代码页 ${codePage} 不是 UTF-8（65001）：中文会乱码。在 Windows Terminal 设置里启用，或先执行 chcp 65001`);
  problems.push('若符号（★ ◉ ╭ ┤）显示为方框或错位：把终端字体设为 Cascadia Mono/Code（Windows Terminal 自带）或 Sarasa Term SC');
  return { platform: process.platform, windowsTerminal, codePage, utf8, problems };
}

/** 工具供给体检：fd/rg 是否可用、来自哪里（随包内置 / 系统 PATH / 缺失待下载）。 */
export function bundledToolsStatus() {
  const source = process.env.KEPOS_BUNDLED_TOOLS
    ? `bundled (${process.env.KEPOS_BUNDLED_TOOLS})`
    : 'not bundled for this platform';
  const probe = (name: string) => {
    try { execFileSync(name, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; }
  };
  return { source, fd: probe('fd'), rg: probe('rg') };
}

export async function doctorCommand(paths: AppPaths, json = false): Promise<void> {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const terminal = terminalEnvironment();
  const tools = bundledToolsStatus();
  const result = {
    product: 'Kepos Communis', version: packageVersion(), node: process.versions.node,
    sdk: sdk.VERSION, architecture: 'sdk', ...paths, theme: 'kepos-dark',
    themeBundled: existsSync(join(packageRoot, 'themes/kepos-dark.json')), project: process.cwd(), terminal, tools,
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const theme = result.themeBundled ? 'kepos-dark ready' : 'missing';
  console.log(`Kepos ${result.version} · Node ${result.node} · Pi SDK ${result.sdk}\nProject: ${result.project}\nHome: ${paths.home}\nTheme: ${theme}`);
  console.log(`Tools: fd ${tools.fd ? '✓' : '✗'} · rg ${tools.rg ? '✓' : '✗'} · ${tools.source}`);
  const critical = terminal.problems.slice(0, terminal.utf8 && (terminal.windowsTerminal || terminal.platform !== 'win32') ? 1 : 2);
  for (const problem of critical) console.log(`提示: ${problem}`);
}
