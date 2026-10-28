import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { db } from './database.ts';
import { root } from './paths.ts';
import { ProfileHistory, type AgentProfile } from './profiles.ts';
export { root, sessionRoot } from './paths.ts';

export type Crew = AgentProfile;
export interface Config {
  projects: string[];
  agents: Crew[];
  folded: string[];
  drafts: Record<string, string>;
  sessionLinks: Record<string, string>;
  initialized?: boolean;
}

const snapshots = new WeakMap<Config, Config>();
const histories = new WeakMap<object, ProfileHistory>();

export function clean(value: unknown): string {
  return String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1000);
}

export function atomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(data, null, 2));
  renameSync(temporary, file);
}

export function profileHistory(): ProfileHistory {
  const database = db();
  let history = histories.get(database);
  if (!history) {
    history = new ProfileHistory(database);
    histories.set(database, history);
  }
  return history;
}

function defaults(): Config {
  return { projects: [], agents: [], folded: [], drafts: {}, sessionLinks: {} };
}

function remember(config: Config): Config {
  snapshots.set(config, structuredClone(config));
  return config;
}

function legacyConfig(): Config {
  let data: any;
  try {
    data = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8'));
  } catch (error: any) {
    if (error.code === 'ENOENT') return defaults();
    throw Error('Workspace migration failed; original kept: ' + error.message);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.projects) || !Array.isArray(data.agents)) {
    throw Error('Invalid legacy workspace; not overwriting');
  }
  const agents = data.agents
    .filter((agent: any) => agent && typeof agent.name === 'string' && typeof agent.model === 'string' && typeof agent.role === 'string')
    .map((agent: any) => ({ ...agent, id: agent.id || randomUUID(), provider: agent.provider || '' }));
  return {
    projects: data.projects.filter((value: any) => typeof value === 'string'), agents,
    folded: Array.isArray(data.folded) ? data.folded : [], drafts: data.drafts || {},
    sessionLinks: data.sessionLinks || {}, initialized: data.initialized === true || data.agents.length > 0,
  };
}

export function loadConfig(): Config {
  const database = db();
  return database.transaction(() => {
    let saved = database.get<Config>('workspace');
    if (!saved) {
      saved = legacyConfig();
      database.set('workspace', saved);
    }
    const config = { ...defaults(), ...saved };
    for (const agent of config.agents) profileHistory().record(agent);
    return remember(config);
  });
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeRecord(previous: Record<string, any>, local: Record<string, any>, remote: Record<string, any>): Record<string, any> {
  const result = { ...remote };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(local)])) {
    if (same(previous[key], local[key])) continue;
    if (key in local) result[key] = local[key];
    else delete result[key];
  }
  return result;
}

function agentsById(agents: Crew[]): Record<string, Crew> {
  return Object.fromEntries(agents.map(agent => [agent.id, agent]));
}

export function saveConfig(config: Config): void {
  const database = db();
  const previous = snapshots.get(config) || defaults();
  database.transaction(() => {
    const remote = { ...defaults(), ...database.get<Config>('workspace') };
    const merged: Config = { ...remote };
    for (const key of ['drafts', 'sessionLinks'] as const) {
      merged[key] = mergeRecord(previous[key], config[key], remote[key]);
    }
    for (const key of ['projects', 'folded'] as const) {
      const removed = previous[key].filter(value => !config[key].includes(value));
      const added = config[key].filter(value => !previous[key].includes(value));
      merged[key] = [...new Set([...remote[key].filter(value => !removed.includes(value)), ...added])];
    }
    merged.agents = Object.values(mergeRecord(agentsById(previous.agents), agentsById(config.agents), agentsById(remote.agents)));
    if (config.initialized !== previous.initialized) merged.initialized = config.initialized;
    for (const agent of merged.agents) profileHistory().record(agent);
    database.set('workspace', merged);
    Object.assign(config, merged);
  });
  remember(config);
}

export function restoreProfile(config: Config, agentId: string, revision: string): Crew {
  const member = config.agents.find(agent => agent.id === agentId);
  const saved = profileHistory().get(agentId, revision);
  if (!member || !saved) throw Error('Unknown profile revision');
  if (config.agents.some(agent => agent.id !== agentId && agent.name === saved.profile.name)) {
    throw Error('恢复后的名称与现有成员冲突，请先调整名称');
  }
  Object.assign(member, structuredClone(saved.profile));
  saveConfig(config);
  return member;
}

export function projectPath(input: string): string {
  const directory = resolve(input.trim());
  if (!statSync(directory).isDirectory()) throw Error('项目路径不是文件夹');
  return directory;
}

export function createSessionFile(cwd: string, name: string, sessionDir?: string): string {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.appendSessionInfo(clean(name));
  const file = manager.getSessionFile();
  if (!file) throw Error('无法创建持久会话');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const records = [manager.getHeader(), ...manager.getEntries()];
    writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n', { flag: 'wx' });
  }
  return file;
}
