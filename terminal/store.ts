import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { db } from './database.ts';
import { root } from './paths.ts';
import { ARCHIVE_DIR, syncRoleDocs } from './archive.ts';
import { councilRole } from './council-roles/index.ts';
import { readProfiles, syncAgentsFile, syncProfiles } from './profile-file.ts';
import { migrateAutomation } from './automation.ts';
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
  /**
   * 席位数量。缺省 48 是**默认配置**，不是固定编制——
   * 人类可以按任务流水线把它调成任意值，也可以跳过播种自己逐个添加代表。
   * 只在首次初始化时决定播种多少席；之后编制完全由 config.agents 决定。
   */
  councilSize?: number;
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
   * 自动化能力：系统在没人开口时自己干活。三项全默认关闭。
   *
   * 会启动任务的（dispatch / precheck）必须同时满足"开着"与"代理档"，
   * 判定集中在 automation.ts——界面、工具、事件三处都读那一份，
   * 否则"为什么它没跑"会变成最难查的那类问题。
   */
  automation?: import('./automation.ts').AutomationSettings;
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
    // 旧版把自动化拆成 watch.enabled / precheck.enabled 两组散字段。
    // 迁移时一律降级为"仅观察"：升级不该让人在没察觉的情况下开始花钱。
    if (!config.automation && ('watch' in saved || 'precheck' in saved)) {
      config.automation = migrateAutomation(saved as any);
      delete (config as any).watch;
      delete (config as any).precheck;
      database.set('workspace', config);
    }
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

/**
 * 把代表档案与 AGENTS.md 导出到指定工作区。
 *
 * **必须显式传目录**，这里刻意不读 process.cwd()。
 * 上一版从 saveConfig 里隐式触发并扫 process.cwd()，结果任何调用 saveConfig 的
 * 测试或子进程都会往真实仓库里写文件——包括一份假代表名单。
 * 导出的目标是"哪个工作区"，只有调用方知道；猜出来的目标迟早写错地方。
 */
export function exportWorkspaceFiles(config: Config, cwd: string): { agents: boolean; profiles: number; skipped: string[] } {
  const result = { agents: false, profiles: 0, skipped: [] as string[] };
  try {
    result.agents = syncAgentsFile(cwd, {
      members: config.agents.map(agent => ({ name: agent.name, roleKey: agent.roleKey, model: agent.model })),
      archiveDir: ARCHIVE_DIR,
    });
    const archiveRoot = join(cwd, ARCHIVE_DIR);
    // 没有代表、也没有既有归档区时不建目录：空项目不该被塞进 .kepos。
    if (!config.agents.length && !existsSync(archiveRoot)) return result;
    const synced = syncProfiles(archiveRoot, config.agents);
    result.profiles = synced.written;
    result.skipped.push(...synced.skipped);
    // 角色定义也落一份到 roles/：它此前只存在于代码里，
    // 人想核对"这个代表被要求做什么"只能读源码，换个 harness 也带不走。
    // 档案 md 里是"这位代表的具体职责"，角色 md 里是"这个角色的标准定义"，两者互补。
    const roleKeys = [...new Set(config.agents.map(agent => agent.roleKey).filter((key): key is string => !!key))];
    if (roleKeys.length) {
      const docs = roleKeys
        .map(key => councilRole(key as any))
        .filter((role): role is NonNullable<typeof role> => !!role)
        .map(role => ({
          key: role.key, zhName: role.zhName, enName: role.enName, scope: role.zhScope,
          method: role.zhMethod, deliverables: role.zhDeliverables, skillFocus: role.zhSkillFocus, skillHints: role.skillHints,
        }));
      if (docs.length) syncRoleDocs(cwd, docs);
    }
  } catch (error) {
    result.skipped.push(String(error));
  }
  return result;
}
export function restoreProfile(config: Config, agentId: string, revision: string): Crew {
  const member = config.agents.find(agent => agent.id === agentId);
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
