import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

export interface AppPaths { home: string; agentDir: string; dataDir: string; sessionDir: string; themeDir: string; }
export function appPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
 const home = resolve(env.KEPOS_HOME || join(homedir(), '.kepos'));
 const agentDir = resolve(env.KEPOS_AGENT_DIR || join(home, 'agent'));
 const dataDir = resolve(env.KEPOS_DATA_DIR || (env.ORBITAL_HOME?dirname(resolve(env.ORBITAL_HOME)):env.ORBITAL_DATA_DIR) || join(home, 'data'));
 return { home, agentDir, dataDir, sessionDir: join(dataDir, 'sessions'), themeDir: join(agentDir, 'themes') };
}
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function activatePaths(paths: AppPaths) {
 process.env.KEPOS_HOME = paths.home;
 process.env.KEPOS_AGENT_DIR = paths.agentDir;
 process.env.KEPOS_DATA_DIR = paths.dataDir;
 process.env.PI_CODING_AGENT_DIR = paths.agentDir;
 process.env.KEPOS_APP = '1';
}
// 品牌主题随应用升级：内容不同就刷新到用户目录。
// 旧实现只在目标不存在时复制，仓库里改进过的主题永远到不了用户目录（看到的一直是旧配色）。
// 判据是“用户文件是否与上一次发布的主题一致”：一致=未被自定义，可安全覆盖；
// 不一致=用户自己改过，保留用户版本不动。
const THEME_MANIFEST = join('themes', '.brand-theme-hashes.json');
// 三套品牌主题：default（出厂默认）+ dark + light。三者都要注册到 /theme，
// 否则切走默认主题后就无法切回。
export function brandThemeFiles(): string[] {
 return ['kepos-default.json', 'kepos-dark.json', 'kepos-light.json'];
}
export function brandThemePaths(paths: AppPaths): string[] {
 return brandThemeFiles().map(name => join(paths.themeDir, name));
}
function syncBrandThemes(paths: AppPaths) {
 const manifestPath = join(packageRoot, THEME_MANIFEST);
 let published: Record<string, string> = {};
 try { published = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { published = {}; }
 const hashOf = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
 const next: Record<string, string> = {};
 for (const name of brandThemeFiles()) {
  const source = join(packageRoot, 'themes', name);
  if (!existsSync(source)) continue;
  const target = join(paths.themeDir, name);
  const sourceHash = hashOf(source);
  next[name] = sourceHash;
  if (!existsSync(target)) {
   try { copyFileSync(source, target, 1); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
   continue;
  }
  // 只有用户文件仍是“上次发布的那一版”才刷新，避免覆盖自定义。
  // 清单缺失（首次运行/升级到本机制）时无法判断，按品牌主题的旧版本处理：
  // 若目标文件的 name 与源一致，说明它来自我们而非用户另写，可以直接升级。
  const samePublished = published[name] ? hashOf(target) === published[name] : (() => {
   try { return JSON.parse(readFileSync(target, 'utf8'))?.name === JSON.parse(readFileSync(source, 'utf8'))?.name; } catch { return false; }
  })();
  if (samePublished && hashOf(target) !== sourceHash) {
   try { copyFileSync(source, target); } catch { /* 保持可用：刷新失败不回滚运行 */ }
  }
 }
 // 记录本次发布的指纹，供下次升级判定。
 try { writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n'); } catch { /* 只读安装目录时忽略 */ }
}
export function preparePaths(paths: AppPaths) {
 for (const directory of [paths.agentDir, paths.dataDir, paths.sessionDir, paths.themeDir]) mkdirSync(directory, { recursive: true });
 syncBrandThemes(paths);
 const settings = join(paths.agentDir, 'settings.json');
 if (!existsSync(settings)) {
  try { writeFileSync(settings, JSON.stringify({ theme: 'kepos-dark', quietStartup: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error: any) { if (error.code !== 'EEXIST') throw error; }
 }
}
export function deviceId(paths: AppPaths): string {
 mkdirSync(paths.agentDir, { recursive: true });
 const file = join(paths.agentDir, 'device-id');
 try { return readFileSync(file, 'utf8').trim(); }
 catch (error: any) {
  if (error.code !== 'ENOENT') throw error;
  const id = randomUUID();
  try { writeFileSync(file, id + '\n', { flag: 'wx', mode: 0o600 }); return id; }
  catch (writeError: any) { if (writeError.code === 'EEXIST') return readFileSync(file, 'utf8').trim(); throw writeError; }
 }
}
