// 度量：没有度量的优化只是换了一种说法。
//
// 五项指标对应调研报告里的 MAST 失败分类。每一项都必须是**能从库里算出来**的，
// 不是"感觉好多了"。全部只读，不做聚合缓存——数据量是几十到几百条任务，
// 每次现算比维护一份可能过期的快照可靠。
//
// 关于口径：每项都写明分子与分母。一个没有定义分母的比率，
// 在汇报时可以被解释成任何数字。
import type { KeposDatabase } from './database.ts';

export type MetricName = 'duplicate_delegation' | 'second_ask' | 'premature_done' | 'watchdog' | 'memory';

export type MetricResult = {
  name: MetricName;
  label: string;
  /** 分子与分母：比率类指标必须两个都有，否则无法复核。 */
  numerator: number;
  denominator: number;
  /** 可读结论。分母为 0 时明说样本不足，不返回 0% 假装健康。 */
  value: string;
  note?: string;
};

/** 任务标题指纹：去掉标点与空白，取前 40 字作为"同一件事"的判据。 */
function fingerprint(title: unknown): string {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、,.;:!?！？'"'（）()【】\[\]《》<>]/g, '')
    .slice(0, 40);
}

/**
 * 1. 重复委派：同一会话里，同一指纹的任务分给了 ≥2 个不同代表。
 *
 * 分母是任务组数（不是任务数）。对应 MAST 的规格类失败：
 * 同一目标派给多个代表，等于把预算花在互相不知道对方存在的搜索上。
 */
export function duplicateDelegation(database: KeposDatabase): MetricResult {
  const rows = database.prepare("SELECT json_extract(task,'$.parentSessionId') AS parent, json_extract(task,'$.title') AS title, json_extract(task,'$.agent') AS agent FROM workers").all() as any[];
  // 指纹 → 会话 → 代表集合。两侧都按会话分开，跨会话同标题不算重复。
  const groups = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    const key = fingerprint(row.title);
    if (!key) continue;
    const byParent = groups.get(key) || new Map<string, Set<string>>();
    const agents = byParent.get(String(row.parent)) || new Set<string>();
    agents.add(String(row.agent));
    byParent.set(String(row.parent), agents);
    groups.set(key, byParent);
  }
  let duplicated = 0;
  for (const byParent of groups.values()) if ([...byParent.values()].some(agents => agents.size >= 2)) duplicated++;
  const total = groups.size;
  return {
    name: 'duplicate_delegation', label: '重复委派', numerator: duplicated, denominator: total,
    value: total ? `${Math.round((duplicated / total) * 100)}%` : '样本不足',
    note: `${duplicated}/${total} 组同标题任务被分给多个代表（按任务组计，不是任务数）`,
  };
}

/**
 * 2. 二次追问：已完成任务的结果被重复读取。
 *
 * 代理间失配的信号：第一次没读到想要的东西，才会再问一遍。
 * 分母是已完成任务数——运行中的任务本来就会被反复查，计入会虚高。
 */
export function secondAsk(database: KeposDatabase): MetricResult {
  const reads = database.prepare(`SELECT e.worker_id AS id, COUNT(*) AS n
    FROM worker_events e JOIN workers w ON w.id=e.worker_id
    WHERE e.type IN ('result_read','wait_read') AND w.receipt IS NOT NULL
    GROUP BY e.worker_id`).all() as any[];
  const finished = Number((database.prepare('SELECT COUNT(*) AS n FROM workers WHERE receipt IS NOT NULL').get() as any)?.n ?? 0);
  if (!reads.length) return { name: 'second_ask', label: '二次追问', numerator: 0, denominator: finished, value: '暂无事件', note: '尚无结果读取事件；本指标从本版本起累积' };
  const asked = reads.filter(row => Number(row.n) >= 2).length;
  return {
    name: 'second_ask', label: '二次追问', numerator: asked, denominator: finished,
    value: finished ? `${Math.round((asked / finished) * 100)}%` : '样本不足',
    note: `${asked}/${finished} 个已完成任务被重复读取；重复读通常意味着摘要没说清`,
  };
}

/**
 * 3. 提前完成：成功但有未勾选验收条目的步骤比例。
 *
 * 只统计**带验收条目**的步骤——没写验收不等于糊弄，不进分母。
 */
export function prematureDone(database: KeposDatabase): MetricResult {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mission_jobs'").get())
    return { name: 'premature_done', label: '提前完成', numerator: 0, denominator: 0, value: '暂无计划', note: '尚未使用 kepos_plan，本指标无样本' };
  const jobs = database.prepare("SELECT acceptance FROM mission_jobs WHERE state='SUCCEEDED' AND acceptance IS NOT NULL").all() as any[];
  let total = 0, unmet = 0;
  for (const job of jobs) {
    let checks: any[];
    try { checks = JSON.parse(job.acceptance); } catch { continue; }
    if (!Array.isArray(checks) || !checks.length) continue;
    total++;
    if (checks.some(check => !check?.passes)) unmet++;
  }
  return {
    name: 'premature_done', label: '提前完成', numerator: unmet, denominator: total,
    value: total ? `${Math.round((unmet / total) * 100)}%` : '样本不足',
    note: `${unmet}/${total} 个成功步骤仍有未勾选的验收条目；无验收条目的步骤不计入`,
  };
}

/**
 * 4. Watchdog 误报率：判为 deviated/looping 里任务最终成功的比例。
 *
 * 分母是**告警次数**而不是任务数：同一任务被连判三次就是三次误报风险。
 * progress 不是告警，不进分母。这一项决定 watchdog 能否从 observe 升级。
 */
export function watchdogQuality(database: KeposDatabase): MetricResult {
  const rows = database.prepare(`SELECT v.verdict AS verdict, w.state AS state
    FROM watchdog_verdicts v JOIN workers w ON w.id=v.worker_id
    WHERE v.verdict IN ('deviated','looping')`).all() as any[];
  const wrong = rows.filter(row => row.state === 'SUCCEEDED').length;
  const total = rows.length;
  const stalls = Number((database.prepare("SELECT COUNT(*) AS n FROM workers WHERE json_extract(task,'$.stalled')=1").get() as any)?.n ?? 0);
  return {
    name: 'watchdog', label: 'Watchdog 误报', numerator: wrong, denominator: total,
    value: total ? `${Math.round((wrong / total) * 100)}%` : '暂无告警',
    note: `${wrong}/${total} 次告警对应的任务最终成功；stalled 标记样本 ${stalls} 个。观察期数据足够前不要升级为终止通道`,
  };
}

/**
 * 5. 记忆质量：注入过记忆的任务与未注入的完成率对比。
 *
 * 这必须是**相关性**，不是因果——完成率高的代表可能本来就更强，
 * 也可能正因为强才积累了更多记忆。结论里写明，避免被当成 A/B 结果。
 */
export function memoryQuality(database: KeposDatabase): MetricResult {
  const rows = database.prepare(`SELECT w.state AS state,
    EXISTS(SELECT 1 FROM worker_events e WHERE e.worker_id=w.id AND e.type='memory_injected') AS injected
    FROM workers w WHERE w.receipt IS NOT NULL`).all() as any[];
  const withMemory = rows.filter(row => Number(row.injected) === 1);
  const without = rows.filter(row => Number(row.injected) !== 1);
  const rate = (list: any[]) => list.length ? list.filter(row => row.state === 'SUCCEEDED').length / list.length : null;
  const a = rate(withMemory), b = rate(without);
  if (a === null || b === null) {
    return { name: 'memory', label: '记忆质量', numerator: withMemory.length, denominator: rows.length, value: '样本不足', note: '需要同时存在注入过与未注入过记忆的已完成任务才能对比' };
  }
  const delta = Math.round((a - b) * 100);
  return {
    name: 'memory', label: '记忆质量', numerator: withMemory.filter(row => row.state === 'SUCCEEDED').length, denominator: withMemory.length,
    value: `${delta >= 0 ? '+' : ''}${delta}pp`,
    note: `注入记忆完成率 ${Math.round(a * 100)}%（${withMemory.length} 个） vs 未注入 ${Math.round(b * 100)}%（${without.length} 个）；相关性，不是因果`,
  };
}

export const METRICS: Array<{ name: MetricName; label: string; run: (database: KeposDatabase) => MetricResult }> = [
  { name: 'duplicate_delegation', label: '重复委派', run: duplicateDelegation },
  { name: 'second_ask', label: '二次追问', run: secondAsk },
  { name: 'premature_done', label: '提前完成', run: prematureDone },
  { name: 'watchdog', label: 'Watchdog 误报', run: watchdogQuality },
  { name: 'memory', label: '记忆质量', run: memoryQuality },
];

/** 跑全部指标或指定的一项。未知名称报错，不静默返回空。 */
export function collectMetrics(database: KeposDatabase, only?: string): MetricResult[] {
  if (!only) return METRICS.map(metric => metric.run(database));
  const picked = METRICS.find(metric => metric.name === only || metric.label === only);
  if (!picked) throw Error(`未知指标：${only}；可选：${METRICS.map(metric => metric.name).join(', ')}`);
  return [picked.run(database)];
}

/** 一行摘要，供界面或提示直接显示。 */
export function formatMetrics(results: MetricResult[]): string {
  return results.map(result => `${result.label} ${result.value}（${result.note || ''}）`).join('\n');
}
