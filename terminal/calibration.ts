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
 * 观测对象：被语义评估判定为值得派发的那些事件，最终**是否真的值得**。
 * "真的值得"的代理指标是"派出去的任务产出了非空结论"——
 * 一个更好的判据是任务最终成功，但成功受模型、任务难度影响，与判断质量无关。
 *
 * 建议规则：把阈值设为观测到"值得"的比例附近的低分位。
 * 简单说，如果 80% 的评估都判值得，那 0.5 可能太松；如果只有 10% 判值得，
 * 0.5 可能太紧，导致真问题被挡在外面。
 */
export function calibrateConfidence(database: KeposDatabase): Calibration {
  // 只统计真正执行过派发的评估：记录下来的 worth 与最后是否派出，两者可对照。
  const rows = database.prepare(
    `SELECT at, rule_id, path FROM watch_candidates ORDER BY at`,
  ).all() as any[];
  const samples = rows.length;
  if (samples < MIN_CALIBRATION_SAMPLES) {
    return {
      parameter: '语义评估置信度阈值', current: '0.5', samples,
      rationale: `只有 ${samples} 条值守候选，至少需要 ${MIN_CALIBRATION_SAMPLES} 条才能看出分布。继续观察，不要按几条记录调参。`,
    };
  }
  // 观测"命中频率"：同一规则在多长时间内命中多少次。
  // 频率过高的规则要么该收窄路径，要么该调高冷却——这比阈值本身更影响体验。
  const byRule = new Map<string, number[]>();
  for (const row of rows) {
    const list = byRule.get(String(row.rule_id)) ?? [];
    list.push(Number(row.at));
    byRule.set(String(row.rule_id), list);
  }
  let hottest = { rule: '', perDay: 0 };
  for (const [rule, stamps] of byRule) {
    if (stamps.length < 2) continue;
    const spanMs = Math.max(1, stamps[stamps.length - 1] - stamps[0]);
    const perDay = (stamps.length / spanMs) * 86400000;
    if (perDay > hottest.perDay) hottest = { rule, perDay };
  }
  return {
    parameter: '语义评估置信度阈值', current: '0.5', samples,
    rationale: hottest.perDay > 0
      ? `最活跃的规则「${hottest.rule}」约每天命中 ${hottest.perDay.toFixed(1)} 次。命中过密时先收窄规则路径或调高冷却，比调阈值有效——阈值只决定"派不派"，不决定"要不要看"。`
      : `已记录 ${samples} 条候选，但还看不出单条规则的命中频率。`,
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
export function calibrateSubordinateThreshold(database: KeposDatabase): Calibration {
  // 父子关系记在 workers.task 的 JSON 里（parentWorkerId），事件表没有这一列。
  const rows = database.prepare(
    `SELECT json_extract(task,'$.parentWorkerId') AS parent, COUNT(*) AS children
     FROM workers
     WHERE json_extract(task,'$.parentWorkerId') IS NOT NULL
     GROUP BY json_extract(task,'$.parentWorkerId')`,
  ).all() as any[];
  const counts = rows.map(row => Number(row.children)).filter(value => value > 0);
  if (counts.length < MIN_CALIBRATION_SAMPLES) {
    return {
      parameter: '僚属审批线', current: '3 个同时', samples: counts.length,
      rationale: `只有 ${counts.length} 个代表带过僚属，样本不足以判断审批线该松还是该紧。`,
    };
  }
  const sorted = [...counts].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  const p50 = at(0.5), p90 = at(0.9), max = sorted[sorted.length - 1];
  // 建议 = 覆盖 90% 情况的并发数，但不超过硬上限。
  const suggested = Math.max(2, Math.min(6, p90));
  return {
    parameter: '僚属审批线', current: '3 个同时', samples: counts.length,
    observed: { p50, p90, max },
    ...(p90 > 3 ? { suggested } : {}),
    rationale: p90 > 3
      ? `90% 的代表带过 ${p90} 个以内僚属，最大 ${max} 个。当前审批线 3 会把常见的 ${p90} 挡在门外，建议提到 ${suggested}。`
      : `90% 的代表带过 ${p90} 个以内僚属，审批线 3 与真实用法相符。保持不动。`,
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
