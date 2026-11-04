import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { db } from './database.ts';
import { root } from './paths.ts';
import { ARCHIVE_DIR } from './archive.ts';
import { readProfiles, syncAgentsFile, syncProfiles } from './profile-file.ts';
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
  approvalPolicy?: import('./approval.ts').ApprovalPolicy;
  /** Default read scope for delegated workers; tasks and members may override. */
  workerReadScope?: import('./worker-sandbox.ts').ReadScope;
  /** Token/cost limits; unset fields mean unlimited. */
  budget?: import('./workers.ts').BudgetConfig;
  /** 轻微动效开关（如审批锤抖动）；false 时静态显示，符号语义不变。 */
  motion?: boolean;
  /** 代理总代：人类从现任代表中推选兼任，只存稳定 agentId，不占用代表编制。 */
  deputyAgentId?: string;
  /** 工具输出展开状态：默认折叠为一行摘要；true 表示展开完整输出。 */
  expandedTools?: boolean;
  /**
   * 外部 CLI 白名单：由人类决定，总理可通过工具增删。键是可执行名。
   * 不写死在源码里——人类加什么，总理就能用什么。
   */
  cliAllowlist?: Record<string, CliAllowEntry>;
  /**
   * Watchdog 判定用哪次模型调用。缺省复用主 Agent。
   * 单独立字段是为了让人类能把"判断是否空转"换成更便宜/更严的模型，
   * 而不必同时改主 Agent。阶段①只观察，不触发终止。
   */
  watchdogModel?: { provider?: string; model: string };
  /**
   * 事件驱动值守（观察期）。缺省关闭。
   * 开启后只把命中规则的变更记进候选表，不派任何任务——
   * 要等一张候选表被人看过一段时间，才谈自动执行。
   */
  watch?: { enabled: boolean; roots?: string[]; rules?: import('./watch.ts').WatchRule[] };
}

export type CliAllowEntry = {
  /** 显示名。 */
  label: string;
  /** 该 CLI 需要的环境变量名（只传这一个，不给全部）。 */
  envKey?: string;
  /** 允许的参数前缀，例如 -b / -P；空表示只允许该 CLI 的默认交互。 */
  argPrefixes?: string[];
  /** 人类审批时记录的说明。 */
  note?: string;
  addedAt: number;
};

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
  // previous 是这次保存前的快照：代表没变就不碰磁盘（草稿保存走的是同一条路径）。
  exportProfiles(config, previous.agents);
}

/**
 * 配置保存后同步导出档案文件。
 *
 * 两个约束来自实测教训：
 *
 * 1. **只在代表真的变了时导出。** saveConfig 在输入框里每 250ms 被调用一次
 *    （草稿自动保存），把磁盘扫描挂在这条路径上等于每敲一个字都重扫并重写
 *    所有项目目录。档案是给人读的视图，不值得这种开销。
 *
 * 2. **只导出当前工作区。** 之前遍历 config.projects 并往每个目录写 AGENTS.md，
 *    结果测试夹具把假代表写进了真实仓库根。配置属于整个工作区集合，
 *    但档案文件属于"你现在在的项目"，不该由保存动作往别人的目录里塞文件。
 */
function exportProfiles(config: Config, previous: readonly Crew[]): void {
  // 代表名单或其内容没变：草稿、折叠状态、主题之类的高频保存直接跳过。
  if (same(previous, config.agents)) return;
  const cwd = process.cwd();
  try {
    syncAgentsFile(cwd, { members: config.agents.map(agent => ({ name: agent.name, roleKey: agent.roleKey, model: agent.model })), archiveDir: ARCHIVE_DIR });
    // 档案目录只在已经存在归档区、或真有代表时才建立，避免空项目被塞进 .kepos。
    const archiveRoot = join(cwd, ARCHIVE_DIR);
    if (!config.agents.length && !existsSync(archiveRoot)) return;
    syncProfiles(archiveRoot, config.agents);
  } catch {
    // 导出是尽力而为：只读目录、磁盘满都不该影响配置保存本身。
  }
}

export function restoreProfile(config: Config, agentId: string, revision: string): Crew {  const member = config.agents.find(agent => agent.id === agentId);
  const saved = profileHistory().get(agentId, revision);
  if (!member || !saved) throw Error('Unknown profile revision');
  if (config.agents.some(agent => agent.id !== agentId && agent.name === saved.profile.name)) {
    throw Error('恢复后的名称与现有成员冲突，请先调整名称');
  }
  // Replace the whole profile: optional fields absent from the old revision must not survive the restore.
  for (const key of ['roleKey', 'skills', 'tools'] as const) delete member[key];
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

export type ProfileImportReport = {
  /** 实际改变的成员（按稳定 id 匹配）。 */
  updated: string[];
  /** 文件里有、配置里没有的 id：不自动新建，交给人决定。 */
  unknown: string[];
  /** 解析失败的文件与原因——不能静默丢弃，否则"改了没生效"最难查。 */
  errors: Array<{ file: string; error: string }>;
};

/**
 * 把档案目录里的手改结果导入配置。
 *
 * 三条克制：
 *   1. 只更新已存在的 id，不凭一个 md 文件新开代表——那等于让文件系统决定编制。
 *   2. 名称冲突整体拒绝：两份档案同名会让所有按名派发的逻辑失去确定答案。
 *   3. 全部校验通过再一次写入：坏文件不能造成"改了一半"的配置。
 */
export function importProfiles(config: Config, cwd: string): ProfileImportReport {
  const report: ProfileImportReport = { updated: [], unknown: [], errors: [] };
  const archiveRoot = join(cwd, ARCHIVE_DIR);
  const read = readProfiles(archiveRoot);
  report.errors.push(...read.errors);
  if (!read.profiles.length) return report;

  // 先做全部校验，再一次性落盘。
  const candidates: Array<{ member: Crew; file: AgentProfile }> = [];
  for (const file of read.profiles) {
    const member = config.agents.find(agent => agent.id === file.id);
    if (!member) { report.unknown.push(file.id); continue; }
    candidates.push({ member, file });
  }
  // 导入后的最终名单用于查重：不能只看新值之间是否冲突，还要看与未导入的成员是否冲突。
  const finalNames = new Map(config.agents.map(agent => [agent.id, agent.name]));
  for (const { member, file } of candidates) finalNames.set(member.id, file.name);
  const clash = [...finalNames.values()].filter((name, index, all) => all.indexOf(name) !== index);
  if (clash.length) throw Error(`导入后出现重名代表：${[...new Set(clash)].join('、')}；请先在档案里改名`);

  for (const { member, file } of candidates) {
    // 整份替换：档案里省略的可选字段必须消失，不能残留在旧配置里。
    for (const key of ['roleKey', 'tools', 'skills', 'readScope', 'readAllow', 'mcpServers'] as const) delete (member as any)[key];
    Object.assign(member, file);
    report.updated.push(member.name);
  }
  if (report.updated.length) saveConfig(config);
  return report;
}
