// 抓取各平台 fd/rg 到 tools/<plat>/bin/，供 publish:tools 发布与 vendor 同步。
// 需要可达 GitHub 的网络（或在配置了镜像/代理的环境运行）。
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const FD = { repo: 'sharkdp/fd', prefix: 'fd-v', os: { 'win32-x64': 'x86_64-pc-windows-msvc.zip', 'darwin-x64': 'x86_64-apple-darwin.tar.gz', 'darwin-arm64': 'aarch64-apple-darwin.tar.gz', 'linux-x64': 'x86_64-unknown-linux-gnu.tar.gz' } };
const RG = { repo: 'BurntSushi/ripgrep', prefix: 'ripgrep-', os: { 'win32-x64': 'x86_64-pc-windows-msvc.zip', 'darwin-x64': 'x86_64-apple-darwin.tar.gz', 'darwin-arm64': 'aarch64-apple-darwin.tar.gz', 'linux-x64': 'x86_64-unknown-linux-musl.tar.gz' } };

async function latest(repo) {
  const res = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', headers: { 'User-Agent': 'kepos-tools-fetch' } });
  const tag = res.headers.get('location')?.split('/').pop();
  if (!tag) throw Error(`无法解析 ${repo} 最新版本`);
  return tag;
}

const fdTag = await latest(FD.repo), rgTag = await latest(RG.repo);
for (const plat of Object.keys(FD.os)) {
  const dir = join(here, plat, 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(here, plat, 'package.json'), JSON.stringify({
    name: `kepos-tools-${plat}`, version: '0.1.0', description: 'Bundled fd & ripgrep for Kepos Communis (offline-friendly)',
    os: [plat.split('-')[0]], cpu: [plat.endsWith('x64') ? 'x64' : 'arm64'], license: 'SEE THIRD PARTY: MIT (fd), UNLICENSE (ripgrep)',
    files: ['bin/'],
  }, null, 2) + '\n');
  for (const spec of [[FD, fdTag], [RG, rgTag]]) {
    const [tool, tag] = spec;
    const url = `https://github.com/${tool.repo}/releases/download/${tag}/${tool.prefix}${tag.replace(/^v?/, 'v').replace(/^v/, '')}-${tool.os[plat]}`;
    const name = tool === FD ? 'fd' : 'rg';
    const dest = join(dir, name + (plat.startsWith('win32') ? '.exe' : ''));
    if (existsSync(dest)) { console.log(`${plat}/${name}: 已存在，跳过`); continue; }
    console.log(`${plat}/${name}: ${url}`);
    try {
      execFileSync('curl', ['-Lsf', '--retry', '3', '-o', dest + '.dl', url], { stdio: 'inherit' });
      // zip/tar 解包取单个二进制太繁琐；脚本只落原始资产由人工解包放入——发布前请确认 dest 是可执行文件。
      console.log(`  已下载原始资产 → ${dest}.dl（请解包并把 ${name} 放到 ${dest} 后删除 .dl）`);
    } catch { console.log(`  下载失败（网络不可达）：稍后重试，或手动放置 ${dest}`); }
  }
}
console.log('脚手架完成。win32-x64 可直接从 vendor/win32-x64 复制：cp vendor/win32-x64/*.exe tools/win32-x64/bin/');
void readdirSync;
