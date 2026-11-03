import type {KeposDatabase} from './database.ts';
import {representativeRisk, type RepresentativeTaskHistory} from './representative-health.ts';
import {isTaskActive, isTaskTerminal, pendingReason, taskState, type PendingReason} from './task-state.ts';
export function taskSummaries(database:KeposDatabase,limit=100) {
 return database.prepare(`SELECT id,parent AS parentSessionId,state,
 json_extract(task,'$.agent') AS agent,json_extract(task,'$.agentId') AS agentId,json_extract(task,'$.purpose') AS purpose,json_extract(task,'$.cwd') AS cwd,
 json_extract(task,'$.title') AS title,json_extract(task,'$.status') AS status,
 json_extract(task,'$.started') AS started,json_extract(task,'$.ended') AS ended,
 json_extract(task,'$.model') AS model,json_extract(task,'$.provider') AS provider,
 json_extract(task,'$.limit') AS "limit",json_extract(task,'$.tool') AS tool,
 json_extract(task,'$.profileRevision') AS profileRevision,json_extract(task,'$.queueWaitMs') AS queueWaitMs,
 json_extract(task,'$.firstTextMs') AS firstTextMs,json_extract(task,'$.checkpoint') AS checkpoint,json_extract(task,'$.checkpointAt') AS checkpointAt,
 json_extract(task,'$.reviewAt') AS reviewAt,json_extract(task,'$.reviewCount') AS reviewCount,json_extract(task,'$.reviewDue') AS reviewDue,
 json_extract(task,'$.delegationDepth') AS delegationDepth,json_extract(task,'$.parentWorkerId') AS parentWorkerId
 FROM workers ORDER BY CASE WHEN receipt IS NULL THEN 0 ELSE 1 END, json_extract(task,'$.started') DESC LIMIT ?`).all(Math.max(1,Math.min(200,limit))) as any[];
}
export function taskEvidence(database:KeposDatabase,id:string) {
 const row=database.prepare('SELECT task FROM workers WHERE id=?').get(id) as any;
 return row?JSON.parse(row.task):undefined;
}
export function planSummaries(database:KeposDatabase) {
 // The monitor exposes no Worker capabilities or full evidence in a list query.
 if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='missions'").get())return [];
 return database.prepare(`SELECT m.id,m.goal,m.cwd,m.parent AS parentSessionId,m.state,m.updated,
 (SELECT COUNT(*) FROM mission_jobs j WHERE j.mission_id=m.id) AS total,
 (SELECT COUNT(*) FROM mission_jobs j WHERE j.mission_id=m.id AND j.state='SUCCEEDED') AS completed,
 (SELECT COUNT(*) FROM mission_jobs j WHERE j.mission_id=m.id AND j.state='NEEDS_HUMAN') AS attention
 FROM missions m ORDER BY CASE WHEN m.state='NEEDS_HUMAN' THEN 0 ELSE 1 END,m.updated DESC LIMIT 100`).all() as any[];
}

const PLAN_GLYPHS: Record<string, string> = { QUEUED: '○', RUNNING: '▶', NEEDS_HUMAN: '⚠', SUCCEEDED: '✓', FAILED: '✕', CANCELLED: '⨉' };
/** Depth-first plan tree with dependency indentation; orphans and cycles fall back to roots. */
export function planTree(jobs: { id: string; task: string; state: string; dependsOn?: string[] }[]): string[] {
 const byId = new Map(jobs.map(job => [job.id, job]));
 const children = new Map<string, string[]>();
 const roots: string[] = [];
 for (const job of jobs) {
  const deps = (job.dependsOn || []).filter(dep => byId.has(dep));
  if (!deps.length) { roots.push(job.id); continue; }
  const parent = deps[deps.length - 1];
  const list = children.get(parent) || []; list.push(job.id); children.set(parent, list);
 }
 const lines: string[] = [];
 const seen = new Set<string>();
 const walk = (id: string, depth: number) => {
  if (seen.has(id)) return;
  seen.add(id);
  const job = byId.get(id)!;
  const glyph = PLAN_GLYPHS[job.state] || '·';
  lines.push(`${'  '.repeat(depth)}${glyph} ${id} · ${job.task.slice(0, 60)}${job.state === 'NEEDS_HUMAN' ? ' · 等待人类审批' : ''}`);
  for (const child of children.get(id) || []) walk(child, depth + 1);
 };
 for (const root of roots) walk(root, 0);
 for (const job of jobs) if (!seen.has(job.id)) walk(job.id, 0);
 return lines;
}

/** Risk note for a configured member based on recent task outcomes; undefined when healthy. */
export function agentRisk(tasks:readonly RepresentativeTaskHistory[],name:string,agentId?:string):string|undefined{
 return representativeRisk(tasks,{id:agentId,name});
}

// ── Watchdog 判定的只读投影 ─────────────────────────────────────────────
// 界面上"为什么认为它空转"必须能查到，否则模型判定就是一个黑盒否决。
// 这一层只读：写入由 index.ts 的 judgeReview 负责。

/** 某任务最近的判定摘要，供书案与 F3 详情显示。 */
export function watchdogNotes(database:KeposDatabase,workerId:string,limit=3){
 try{
  const rows=database.prepare('SELECT seq,at,verdict,reason,model FROM watchdog_verdicts WHERE worker_id=? ORDER BY seq DESC LIMIT ?').all(workerId,limit) as any[];
  return rows.map(row=>({seq:Number(row.seq),at:Number(row.at),verdict:String(row.verdict),reason:String(row.reason),model:String(row.model)}));
 }catch{return[];}
}

/**
 * 误报率：被判为 deviated/looping 的任务里，最终真的失败/超时的比例。
 *
 * 只有这个数字能回答"这个 watchdog 值不值得信"。判成 progress 的一律不计——
 * 它不是"正确判断"，只是没有介入。
 */
export function watchdogAccuracy(database:KeposDatabase){
 const rows=database.prepare(`SELECT v.verdict AS verdict, json_extract(w.task,'$.state') AS state
  FROM watchdog_verdicts v JOIN workers w ON w.id=v.worker_id
  WHERE v.verdict IN ('deviated','looping')`).all() as any[];
 const total=rows.length;
 const wrong=rows.filter(row=>row.state==='SUCCEEDED').length;
 return {alarms:total,wrong,falsePositiveRate:total?Number((wrong/total).toFixed(3)):null};
}

// ── 「等你处理」的单一判定源 ────────────────────────────────────────────
// 环图的 ⚠、顶栏徽章、F3/F8 等待区三处曾各自计算"待处理"，口径一漂移就会出现
// "徽章说 2 个、打开列表只有 1 个"的矛盾。这里只留一个选择器，三处都调它。

export type AwaitingTask = { id?: string; agent?: string; state?: string; status?: string; title?: string; started?: number; ended?: number; stalled?: boolean; reviewDue?: boolean; error?: string };

/** 一条等待项：任务本身 + 为什么在等你 + 该按哪个键。 */
export type WaitingReason = PendingReason | 'failed' | 'budget';
export type WaitingItem<T extends AwaitingTask> = { task: T; reason: WaitingReason; action: string };

// 每个等待原因的直达动作与标签：界面只展示，不另存一份文案。
const WAITING_ACTION: Record<WaitingReason, string> = {
 approval: 'F2 审批',
 review: 'F2 复核 · Ctrl+X 终止',
 stalled: 'F2 复核 · Ctrl+X 终止',
 failed: 'Enter 已处理 · F2 重派',
 budget: 'Enter 已处理 · F2 调预算重派',
};
export const WAITING_LABEL: Record<WaitingReason, string> = {
 approval: '待审批', review: '待复核', stalled: '疑似空转', failed: '失败待决策', budget: '预算停止',
};
// 等待区排序：门禁最急，其次卡住，再是复核，最后是需要复盘的终态。
const WAITING_RANK: Record<WaitingReason, number> = { approval: 0, stalled: 1, review: 2, failed: 3, budget: 4 };

/**
 * 需要人类决策的活跃任务：门禁待批、空转待裁决、到了复核点。
 * 终态不算——环图 ⚠、顶栏徽章、议会筛选都读它，历史失败不能把徽章永久顶红。
 */
export function awaitingHuman<T extends AwaitingTask>(tasks: readonly T[]): WaitingItem<T>[] {
 const items: WaitingItem<T>[] = [];
 for (const task of tasks) {
  if (task.ended) continue;
  const reason = pendingReason(task as any);
  if (reason) items.push({ task, reason, action: WAITING_ACTION[reason] });
 }
 return items.sort((a, b) => WAITING_RANK[a.reason] - WAITING_RANK[b.reason] || (b.task.started ?? 0) - (a.task.started ?? 0));
}

/** 正在工作中的任务：排队、启动、运行。健康任务不占"等你处理"的位置。 */
export function workingTasks<T extends AwaitingTask>(tasks: readonly T[]): T[] {
 return tasks.filter(task => !task.ended && isTaskActive(task as any));
}

export type TaskBuckets<T extends AwaitingTask> = { waiting: WaitingItem<T>[]; working: T[]; finished: T[]; order: T[]; counts: { working: number; done: number; finished: number } };

/**
 * F3/F8 的两段式视图：等待区固定在顶部，其余按状态排。
 *
 * 失败是终态，但仍要人当场决定"修还是放弃"，所以只有**本次打开书案之后**才结算的
 * 失败才进等待区（`freshSince`）。更早的失败属于历史——重启或重开 F3 不把它重新挂出来，
 * 那正是"代表看起来一直在报错"的来源。`handled` 是本次会话里人工确认过的项，
 * 确认后落回历史，不再占位。
 */
export function taskBuckets<T extends AwaitingTask>(tasks: readonly T[], options: { freshSince?: number; handled?: ReadonlySet<string> } = {}): TaskBuckets<T> {
 const freshSince = options.freshSince ?? Date.now();
 const waiting = awaitingHuman(tasks);
 const waitingIds = new Set(waiting.map(item => String(item.task.id ?? '')));
 for (const task of tasks) {
  const id = String(task.id ?? '');
  if (!id || waitingIds.has(id) || options.handled?.has(id)) continue;
  if (!task.ended || task.ended < freshSince) continue;
  const state = taskState(task as any);
  // 预算停止以 CANCELLED 结算，错误文案是唯一可靠标记（与 workers.ts 结论文案同源）。
  const reason: WaitingReason | undefined = state === 'FAILED' ? 'failed' : state === 'CANCELLED' && /预算/.test(String(task.error ?? '')) ? 'budget' : undefined;
  if (!reason) continue;
  waiting.push({ task, reason, action: WAITING_ACTION[reason] });
  waitingIds.add(id);
 }
 waiting.sort((a, b) => WAITING_RANK[a.reason] - WAITING_RANK[b.reason] || (b.task.started ?? 0) - (a.task.started ?? 0));
 // 等待区里的空转任务仍在运行，但它属于"等你处理"，不再在"进行中"重复出现。
 const working = workingTasks(tasks).filter(task => !waitingIds.has(String(task.id ?? ''))).sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
 const workingIds = new Set(working.map(task => String(task.id ?? '')));
 const finished = tasks.filter(task => !waitingIds.has(String(task.id ?? '')) && !workingIds.has(String(task.id ?? ''))).sort((a, b) => (b.ended ?? b.started ?? 0) - (a.ended ?? a.started ?? 0));
 return { waiting, working, finished, order: [...waiting.map(item => item.task), ...working, ...finished], counts: taskCounts(tasks) };
}

/** 计数行口径：工作中 N · 已完成 M。历史失败不算"完成"。 */
export function taskCounts(tasks: readonly AwaitingTask[]): { working: number; done: number; finished: number } {
 let working = 0, done = 0, finished = 0;
 for (const task of tasks) {
  if (isTaskActive(task as any)) { working++; continue; }
  if (!isTaskTerminal(task as any)) continue;
  finished++;
  if (taskState(task as any) === 'SUCCEEDED') done++;
 }
 return { working, done, finished };
}
