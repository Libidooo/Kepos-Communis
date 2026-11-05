// 事件驱动值守 M1：监听文件变化，只记录"本会怎么做"，不动手。
//
// 为什么先只观察（报告 §0 原则 4"渐进放开"）：
//   事件触发比委派危险得多——一个误判会自己开出一批任务，人还没意识到就已经花了钱。
//   所以第一阶段产物是一张候选表：命中了什么、按规则会派谁去做什么。
//   人看着这张表运行一段时间，确认规则不误伤，才谈第二阶段自动执行。
//
// 为什么准入必须在程序层（不是提示词）：
//   监听器会在任何时候触发，没有"模型先想一想"的余地。谁的路径、什么事件类型、
//   有没有在冷却期，全是确定的规则，就该用代码写死，而不是交给一次模型调用去判断。
import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { KeposDatabase } from './database.ts';

/** 触发事件种类。目前只有文件系统；git hook 是同一种语义的另一个来源。 */
export type WatchEventKind = 'file-changed' | 'file-created' | 'file-deleted';

/** 一条准入规则：人可编辑，程序执行。 */
export type WatchRule = {
  /** 规则名，用于去重与展示。 */
  id: string;
  /** 人写的一句话：这条规则想抓什么情况。 */
  intent: string;
  /** 只关心这些后缀（空数组=不限制）。 */
  extensions?: string[];
  /** 只关心路径里含这些片段的变更（空数组=不限制）。 */
  pathIncludes?: string[];
  /** 这些路径片段一律忽略：构建产物、依赖目录、归档区自己。 */
  pathExcludes?: string[];
  /** 命中后建议派谁（代表名）。 */
  agent: string;
  /** 建议的只读任务，可以用 {file} 占位。 */
  task: string;
  /** 同一路径的冷却时间，防止一次保存触发一串任务。 */
  cooldownMs?: number;
};

/** 默认规则：保守、只读、只针对源码。人可以改。 */
export const DEFAULT_WATCH_RULES: WatchRule[] = [
  {
    id: 'readme-sync',
    intent: '项目结构变了但说明文件没跟上',
    extensions: ['.md'],
    pathIncludes: ['readme'],
    pathExcludes: ['node_modules', 'dist', '.kepos', '.git'],
    agent: '',
    task: '只读核对 {file} 是否与当前代码结构一致，列出已经过时的段落。不要修改文件。',
    cooldownMs: 120000,
  },
];

/** 永远不允许被监听或派发的路径片段：归档区、依赖、版本库元数据、凭据位置。 */
const ALWAYS_EXCLUDED = ['node_modules', '.git', '.kepos', 'dist', 'build', '.next', 'target', '__pycache__'];

export type WatchCandidate = {
  id: string;
  at: number;
  ruleId: string;
  kind: WatchEventKind;
  /** 变更的绝对路径。 */
  path: string;
  /** 按规则展开后的建议任务。 */
  task: string;
  /** 建议派给谁；空表示"还没决定由谁来"。 */
  agent: string;
  /** 观察期：永远为 true，记录"本会怎么做"而不执行。 */
  observeOnly: true;
};

/**
 * 路径归一化：统一分隔符并解析成绝对路径。
 * 不 resolve 符号链接——那是读取权限层的职责，这里只判归属。
 */
function normalize(path: string): string {
  return resolve(String(path ?? '')).split(sep).join('/');
}

/** 这条路径是否处在绝对禁区。 */
export function isExcludedPath(path: string): boolean {
  const normalized = normalize(path).toLowerCase();
  return ALWAYS_EXCLUDED.some(segment => normalized.split('/').includes(segment));
}

/**
 * 程序层准入：确定性的判断，不进模型。
 *
 * 返回命中的规则与展开后的任务；没有命中返回 undefined。
 * 顺序固定（数组顺序），所以同样的输入永远得到同样的结果——
 * 这一点是可测试的前提，也是"人会信任这条通道"的前提。
 */
export function matchRule(path: string, kind: WatchEventKind, rules: readonly WatchRule[]): { rule: WatchRule; task: string } | undefined {
  if (isExcludedPath(path)) return undefined;
  const normalized = normalize(path);
  const lower = normalized.toLowerCase();
  const extension = extname(lower);
  for (const rule of rules) {
    if (rule.extensions?.length && !rule.extensions.map(item => item.toLowerCase()).includes(extension)) continue;
    if (rule.pathIncludes?.length && !rule.pathIncludes.some(fragment => lower.includes(fragment.toLowerCase()))) continue;
    if (rule.pathExcludes?.some(fragment => lower.includes(fragment.toLowerCase()))) continue;
    // 删除事件不派任务：文件都不在了，让代表去读它是浪费一次调用。
    if (kind === 'file-deleted') return undefined;
    return { rule, task: rule.task.replace(/\{file\}/g, basename(normalized)) };
  }
  return undefined;
}

export type CandidateStore = {
  /** 记录一条候选；冷却期内同规则同路径返回 false，不重复记录。 */
  record(input: Omit<WatchCandidate, 'id' | 'at' | 'observeOnly'> & { at?: number; cooldownMs?: number }): boolean;
  /** 最近候选，最新在前。 */
  recent(limit?: number): WatchCandidate[];
  /** 某条规则在某路径上是否仍在冷却期。 */
  cooling(ruleId: string, path: string, cooldownMs: number, now?: number): boolean;
  clear(): number;
};

/**
 * 候选项的落库。
 *
 * 冷却按 (规则, 路径) 记：一次保存编辑器改一个文件往往连发多个事件，
 * 没有冷却就会记成一串同义候选，把真正不同的变更淹没。
 * 窗口由**规则**决定，不由存储层猜——规则知道它抓的是什么频度的事。
 */
export class WatchCandidates implements CandidateStore {
  constructor(private readonly database: KeposDatabase) {}

  cooling(ruleId: string, path: string, cooldownMs: number, now = Date.now()): boolean {
    if (cooldownMs <= 0) return false;
    const hit = this.database.prepare('SELECT 1 FROM watch_candidates WHERE rule_id=? AND path=? AND at>? LIMIT 1')
      .get(ruleId, normalize(path), now - cooldownMs);
    return Boolean(hit);
  }

  record(input: Omit<WatchCandidate, 'id' | 'at' | 'observeOnly'> & { at?: number; cooldownMs?: number }): boolean {
    const now = input.at ?? Date.now();
    const path = normalize(input.path);
    if (this.cooling(input.ruleId, path, input.cooldownMs ?? 0, now)) return false;
    this.database.prepare('INSERT INTO watch_candidates(id,at,rule_id,kind,path,task,agent,observe_only) VALUES(?,?,?,?,?,?,?,1)')
      .run(`${input.ruleId}:${path}:${now}`, now, input.ruleId, input.kind, path, input.task, input.agent);
    return true;
  }

  recent(limit = 20): WatchCandidate[] {
    const rows = this.database.prepare('SELECT id,at,rule_id,kind,path,task,agent FROM watch_candidates ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as any[];
    return rows.map(row => ({
      id: String(row.id), at: Number(row.at), ruleId: String(row.rule_id), kind: row.kind as WatchEventKind,
      path: String(row.path), task: String(row.task), agent: String(row.agent ?? ''), observeOnly: true as const,
    }));
  }

  clear(): number {
    const result = this.database.prepare('DELETE FROM watch_candidates').run();
    return Number(result.changes ?? 0);
  }

  /**
   * 只留最近 N 条。
   *
   * 观察期会持续积累候选，而这张表没有自然生命周期（不像任务会结算）。
   * 不裁剪的话，开一年观察就有一个无限增长的表。保留最近 500 条足够回答
   * "规则会不会误伤"；更早的候选没有判断价值。
   */
  prune(keep = 500): number {
    const result = this.database.prepare('DELETE FROM watch_candidates WHERE id NOT IN (SELECT id FROM watch_candidates ORDER BY at DESC, rowid DESC LIMIT ?)').run(Math.max(1, keep));
    return Number(result.changes ?? 0);
  }
}

/**
 * 目录扫描：用轮询而不是原生监听。
 *
 * 为什么：跨平台的可靠监听方案（chokidar / ReadDirectoryChangesW）要么引入依赖，
 * 要么在 Windows 上有已知的丢事件问题。观察期的目标是"看清规则会怎么触发"，
 * 每秒扫一次浅层目录足够，而且行为完全可预测——对一张要被人信任的表，
 * 可预测比实时重要。
 */
export class DirectoryWatcher {
  private timer?: ReturnType<typeof setInterval>;
  /** 路径 → 修改时间。首次扫描只建基线，不产生事件。 */
  private snapshot = new Map<string, number>();
  private primed = false;

  constructor(
    private readonly roots: readonly string[],
    private readonly options: { intervalMs?: number; maxDepth?: number; onEvent: (path: string, kind: WatchEventKind) => void },
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = Math.max(200, this.options.intervalMs ?? 1000);
    this.timer = setInterval(() => this.scan(), interval);
    this.timer.unref?.();
    this.scan();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.snapshot.clear();
    this.primed = false;
  }

  /** 扫一轮并派发差异。测试直接调它，不依赖定时器。 */
  scan(): { created: string[]; changed: string[]; deleted: string[] } {
    const seen = new Map<string, number>();
    for (const root of this.roots) this.walk(root, 0, seen);
    const created: string[] = [], changed: string[] = [], deleted: string[] = [];
    if (this.primed) {
      for (const [path, mtime] of seen) {
        const before = this.snapshot.get(path);
        if (before === undefined) created.push(path);
        else if (before !== mtime) changed.push(path);
      }
      for (const path of this.snapshot.keys()) if (!seen.has(path)) deleted.push(path);
    }
    this.snapshot = seen;
    this.primed = true;
    for (const path of created) this.options.onEvent(path, 'file-created');
    for (const path of changed) this.options.onEvent(path, 'file-changed');
    for (const path of deleted) this.options.onEvent(path, 'file-deleted');
    return { created, changed, deleted };
  }

  private walk(dir: string, depth: number, out: Map<string, number>): void {
    const maxDepth = this.options.maxDepth ?? 2;
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (isExcludedPath(full)) continue;
      try {
        const info = statSync(full);
        if (info.isDirectory()) { this.walk(full, depth + 1, out); continue; }
        out.set(normalize(full), info.mtimeMs);
      } catch { /* 扫描期间被删或没权限：跳过，下一轮自然处理 */ }
    }
  }
}

/** 候选表在界面上的摘要。 */
export function describeCandidate(candidate: WatchCandidate): string {
  const name = basename(candidate.path);
  const kind = candidate.kind === 'file-created' ? '新建' : candidate.kind === 'file-changed' ? '修改' : '删除';
  return `${kind} ${name} 会触发 ${candidate.ruleId}${candidate.agent ? ` → ${candidate.agent}` : '（未指派代表）'}`;
}

/** 规则目录是否可用：坏规则不应让整个监听器启动失败。 */
export function validRules(rules: readonly WatchRule[]): { usable: WatchRule[]; rejected: string[] } {
  const usable: WatchRule[] = [];
  const rejected: string[] = [];
  for (const rule of rules) {
    if (!rule?.id?.trim() || !rule?.task?.trim()) { rejected.push(rule?.id || '(无 id)'); continue; }
    usable.push(rule);
  }
  return { usable, rejected };
}
