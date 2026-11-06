// 参数校准：把"我估的数字"换成"数据支持的区间"。
//
// 现状是：自动化三级的门槛（置信度 0.5、每分钟 2 次、僚属审批线 3）
// 全部是我按推理定的。推理能给出量级，给不出刻度——
// 而刻度错了，要么误报泛滥让人关掉通道，要么过度保守等于没开。
//
// 这个模块不自动改参数。它做三件事：
//   1. 从真实记录里算出每个参数的**观测分布**（不是平均值，是分布）。
//   2. 给出建议区间，并说明依据。
//   3. 数据不足时明说"还没有样本"，不拿三条记录给出一个看起来精确的建议。
//
// 为什么不自动应用：调参是判断题。阈值放宽会让误报变多，
// 收紧会让真问题漏掉——哪个更糟取决于你在做什么。人来决定。
import type { KeposDatabase } from './database.ts';

/** 一个可校准参数的观测结果。 */
export type Calibration = {
  parameter: string;
  /** 当前生效的硬编码值。 */
  current: string;
  /** 样本量。低于 minSamples 时不出建议。 */
  samples: number;
  /** 观测到的分布；样本不足时为 undefined。 */
  observed?: { p50: number; p90: number; max: number };
  /** 建议值。样本不足或数据不支持改动时为 undefined。 */
  suggested?: number;
  /** 依据，人读得懂。 */
  rationale: string;
};

/** 样本少于这个数就不给建议：五条记录算出来的分位数只是噪声。 */
export const MIN_CALIBRATION_SAMPLES = 20;

/**
 * 评估置信度阈值。
 *
 * **必须先说实话：评估结果此前没有落库。** watch_candidates 只记录命中，
 * 语义评估的 worth / confidence 在闸门里用完就丢——从这张表算不出阈值该多少。
 * `watch_assessments` 表（M2 起记录）补上了这一环；样本够了之后，
 * 校准的判据是"派出去的值守任务有多少真的成功"：成功率低说明阈值放得太松。
 */
export function calibrateConfidence(database: KeposDatabase): Calibration {
  const linked = database.prepare(
    `SELECT a.rule_id AS rule, a.worth AS worth,
            CASE WHEN json_extract(w.task,'$.state')='SUCCEEDED' THEN 1 ELSE 0 END AS ok
     FROM watch_assessments a
     JOIN workers w ON json_extract(w.task,'$.watchPath')=a.path
     WHERE a.dispatched=1`,
  ).all() as any[];
  const samples = linked.length;
  if (samples < MIN_CALIBRATION_SAMPLES) {
    return {
      parameter: '语义评估置信度阈值', current: '0.5', samples,
      rationale: `只有 ${samples} 条已派发的评估记录（需 ${MIN_CALIBRATION_SAMPLES} 条）。评估必须通过 watchPath 关联到任务结果才能校准——在此之前，靠命中频率调阈值只会让通道变松或变严，都没有依据。`,
    };
  }
  const ok = linked.filter(row => Number(row.ok) === 1).length;
  const rate = ok / samples;
  let verdict: string;
  if (rate < 0.5) verdict = `成功率仅 ${Math.round(rate * 100)}%，阈值 0.5 放得太松：建议提高到 0.7，或先收窄最活跃规则的路径`;
  else if (rate >= 0.9) verdict = `成功率 ${Math.round(rate * 100)}%，阈值 0.5 可能偏紧：可以试着降到 0.3 多放行一些，观察一轮`;
  else verdict = `成功率 ${Math.round(rate * 100)}%，阈值 0.5 与结果相符，保持不动`;
  return {
    parameter: '语义评估置信度阈值', current: '0.5', samples,
    observed: { p50: Math.round(rate * 100), p90: Math.round(rate * 100), max: Math.round(rate * 100) },
    rationale: `${ok}/${samples} 个已派发的评估最终任务成功。${verdict}。`,
  };
}

/**
 * 评估自动派发频率上限。
 *
 * 观测对象：实际发生过的派发节奏。当前上限 2 次/分钟是估的；
 * 如果真实使用中从未接近过它，说明它不构成约束，无需改；
 * 如果频繁触顶，说明要么规则太宽，要么上限该提高。
 */
export function calibrateDispatchRate(database: KeposDatabase): Calibration {
  // 只统计**值守自动派发**产生的任务。
  //
  // 这里踩过一个坑：起初我统计所有 queued 事件，得到"最密一分钟 48 个"，
  // 于是建议把上限从 2 放宽到 10。但那一批是初始化 48 席时的一次性播种，
  // 与自动派发毫无关系。用错误的样本得出精确的数字，比不给建议更糟。
  //
  // 判据是任务记录的 purpose 字段：watch 表示由值守触发。
  const rows = database.prepare(
    `SELECT e.created AS at
     FROM worker_events e JOIN workers w ON w.id=e.worker_id
     WHERE e.type='queued' AND json_extract(w.task,'$.purpose')='watch'
     ORDER BY e.created`,
  ).all() as any[];
  const stamps = rows.map(row => Number(row.at)).filter(value => Number.isFinite(value));
  if (stamps.length < MIN_CALIBRATION_SAMPLES) {
    return {
      parameter: '自动派发频率上限', current: '2 / 分钟', samples: stamps.length,
      rationale: stalls(stamps.length),
    };
  }
  // 滑动一分钟窗口内的最大派发数：这是"最密的一分钟"实际长什么样。
  let peak = 0;
  for (let i = 0; i < stamps.length; i++) {
    let count = 0;
    for (let j = i; j < stamps.length && stamps[j] - stamps[i] < 60000; j++) count++;
    if (count > peak) peak = count;
  }
  const suggested = Math.max(2, Math.min(10, Math.ceil(peak * 1.5)));
  return {
    parameter: '自动派发频率上限', current: '2 / 分钟', samples: stamps.length,
    observed: { p50: peak, p90: peak, max: peak },
    ...(peak > 2 ? { suggested } : {}),
    rationale: peak > 2
      ? `最密的一分钟里实际派出过 ${peak} 个任务，当前上限 ${2} 会挡住正常工作。建议放宽到 ${suggested}（实际峰值的 1.5 倍），并确认这些派发不是同一条过宽的规则造成的。`
      : `最密的一分钟里只派出过 ${peak} 个任务，上限 2 从未构成约束。保持不动——现在调它没有依据。`,
  };
}

/**
 * 评估僚属审批线。
 *
 * 观测对象：每个代表同时存活僚属数的分布。
 * 如果绝大多数代表从不超过 2 个，审批线 3 就是合理的；
 * 如果经常顶到 3 并被挡下，说明真实工作需要更多并发。
 */
/**
 * 评估僚属审批线。
 *
 * 观测对象：每个代表的**峰值并发**僚属数——不是累计派生数。
 * 串行带 10 个僚属的代表一次只带 1 个，审批线 3 对它毫无影响；
 * 只有真正同时带过 4 个以上才说明这条线挡住了真实工作。
 * 历史并发从子任务的 started/ended 区间重建：`started` 必有，`ended` 未结束的用当前时间。
 */
export function calibrateSubordinateThreshold(database: KeposDatabase): Calibration {
  // 父子关系记在 workers.task 的 JSON 里（parentWorkerId），事件表没有这一列。
  const rows = database.prepare(
    `SELECT json_extract(task,'$.parentWorkerId') AS parent,
            json_extract(task,'$.started') AS started,
            CASE WHEN json_extract(task,'$.ended') IS NOT NULL
                 THEN json_extract(task,'$.ended') ELSE CAST(strftime('%s','now') AS INTEGER)*1000 END AS ended
     FROM workers
     WHERE json_extract(task,'$.parentWorkerId') IS NOT NULL`,
  ).all() as any[];
  // 按父任务聚合区间，扫描出每个父任务的峰值并发。
  const byParent = new Map<string, Array<{ start: number; end: number }>>();
  for (const row of rows) {
    const parent = String(row.parent ?? '');
    if (!parent) continue;
    const list = byParent.get(parent) ?? [];
    list.push({ start: Number(row.started ?? 0), end: Number(row.ended ?? Date.now()) });
    byParent.set(parent, list);
  }
  // 峰值并发：任一时刻最多有多少个区间重叠。
  const peaks: number[] = [];
  for (const [, intervals] of byParent) {
    const events: Array<{ at: number; delta: number }> = [];
    for (const item of intervals) {
      events.push({ at: item.start, delta: 1 }, { at: item.end + 1, delta: -1 });
    }
    events.sort((a, b) => a.at - b.at || a.delta - b.delta);
    let live = 0, peak = 0;
    for (const event of events) {
      live += event.delta;
      if (live > peak) peak = live;
    }
    if (peak > 0) peaks.push(peak);
  }
  if (peaks.length < MIN_CALIBRATION_SAMPLES) {
    return {
      parameter: '僚属审批线', current: '3 个同时', samples: peaks.length,
      rationale: `只有 ${peaks.length} 个代表带过僚属，样本不足以判断审批线该松还是该紧。`,
    };
  }
  const sorted = [...peaks].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  const p50 = at(0.5), p90 = at(0.9), max = sorted[sorted.length - 1];
  // 建议 = 覆盖 90% 情况的峰值并发，但不超过硬上限 6。
  const suggested = Math.max(2, Math.min(6, p90));
  return {
    parameter: '僚属审批线', current: '3 个同时', samples: peaks.length,
    observed: { p50, p90, max },
    ...(p90 > 3 ? { suggested } : {}),
    rationale: p90 > 3
      ? `90% 的代表峰值并发在 ${p90} 以内，最大 ${max}。当前审批线 3 会把常见的 ${p90} 挡在门外，建议提到 ${suggested}。`
      : `90% 的代表峰值并发在 ${p90} 以内，审批线 3 与真实用法相符。保持不动。`,
  };
}

/** 一次算出全部校准结果。 */
export function calibrateAll(database: KeposDatabase): Calibration[] {
  return [
    calibrateConfidence(database),
    calibrateDispatchRate(database),
    calibrateSubordinateThreshold(database),
  ];
}

/** 一行摘要，供工具输出。 */
export function formatCalibration(items: readonly Calibration[]): string {
  return items.map(item => {
    const head = `${item.parameter} · 当前 ${item.current} · ${item.samples} 个样本`;
    const advice = item.suggested !== undefined ? `建议改为 ${item.suggested}` : '暂不建议改动';
    return `${head}\n  ${advice}：${item.rationale}`;
  }).join('\n\n');
}

/** 样本不足时的统一说明。把"还没有数据"和"数据不支持改动"分开说。 */
function stalls(samples: number): string {
  return `只有 ${samples} 次值守自动派发记录，至少需要 ${MIN_CALIBRATION_SAMPLES} 次才能看出真实节奏。在此之前调这个上限没有依据。`;
}
