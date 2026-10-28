import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
export function preparePaths(paths: AppPaths) {
 for (const directory of [paths.agentDir, paths.dataDir, paths.sessionDir, paths.themeDir]) mkdirSync(directory, { recursive: true });
 const themeSource = join(packageRoot, 'themes', 'orbital-76.json');
 const themeTarget = join(paths.themeDir, 'orbital-76.json');
 if (existsSync(themeSource) && !existsSync(themeTarget)) {
  try { copyFileSync(themeSource, themeTarget, 1); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
 }
 const settings = join(paths.agentDir, 'settings.json');
 if (!existsSync(settings)) {
  try { writeFileSync(settings, JSON.stringify({ theme: 'orbital-76', quietStartup: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
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
