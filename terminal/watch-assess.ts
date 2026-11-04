// 值守 M2：语义层评估。
//
// M1 的准入是确定性的（后缀、路径片段、冷却），它只会问"这条路径归不归我管"。
// 但它答不了"这次改动值不值得派人看"——README 改一个错别字和 README 整段重写
// 在路径上完全一样。M2 补的就是这一层：给候选打分，低分的直接丢弃，
// 高分的才可能进入执行。
//
// 为什么这一层可以"不做"：程序层已经过滤掉绝大部分噪声，
// 语义层只是减少人工审阅量。所以它是可选的，缺了它系统仍能工作——
// 这一点决定了它失败时必须降级为"保留候选给人看"，而不是丢弃。
import type { WatchCandidate } from './watch.ts';

/** 语义评估的结论。 */
export type Assessment = {
  /** 值不值得派人。false 表示这次改动太轻，记下来但不必看。 */
  worth: boolean;
  /** 0-1 的置信度；未评估时为 undefined，与"评估后不通过"区分开。 */
  confidence?: number;
  /** 一句话理由，人类要能读懂"为什么建议不去管它"。 */
  reason: string;
};

/** 注入的评估器：真实实现用便宜模型，测试用桩。 */
export type Assessor = (prompt: string) => Promise<string>;

/** 给模型看的证据上限：这是"要不要看一眼"的判断，不是审阅。 */
export const MAX_ASSESS_CHARS = 1200;

/**
 * 评估提示词。
 *
 * 只问一件事：这次改动是否改变了项目的可验证事实。
 * 明确允许说"不值得"——一个好用的过滤器必须能拒绝，
 * 否则它只是给所有事件加了一层延迟。
 */
export function assessmentPrompt(candidate: WatchCandidate, contentTail: string): string {
  return [
    '判断一次文件改动是否值得派一位只读代表去核对。',
    '',
    '## 触发规则',
    `规则 ${candidate.ruleId}：会建议「${candidate.task}」`,
    '',
    '## 改动',
    `${candidate.kind} · ${candidate.path}`,
    '',
    '## 改动后的内容末尾',
    contentTail.slice(-MAX_ASSESS_CHARS) || '（无内容可读）',
    '',
    '## 判定',
    '输出严格 JSON：',
    '{"worth":true|false,"confidence":0-1,"reason":"一句话依据"}',
    '判 true 的情况：内容变化改变了可验证的事实（结构、接口、约定、命令、路径）。',
    '判 false 的情况：错别字、格式、空白、注释、措辞微调——读一遍也不会得出新结论。',
    '看不出来就判 true，并降低 confidence：漏掉一次真变化比多看一眼代价高。',
  ].join('\n');
}

/**
 * 解析评估结果。
 *
 * 坏输入一律 worth:true——与 watchdog 同一个理由：
 * 过滤器失败时应当退化成"仍然通知人"，而不是悄悄吞掉事件。
 */
export function parseAssessment(raw: string): Assessment {
  const text = String(raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { worth: true, reason: '评估返回无法解析，保留候选' };
  let parsed: any;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return { worth: true, reason: '评估返回无法解析，保留候选' }; }
  if (typeof parsed?.worth !== 'boolean') return { worth: true, reason: '评估缺少 worth 字段，保留候选' };
  const confidence = Number(parsed.confidence);
  return {
    worth: parsed.worth,
    reason: String(parsed.reason ?? '').trim().slice(0, 200) || (parsed.worth ? '值得核对' : '改动太轻'),
    ...(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? { confidence } : {}),
  };
}

/**
 * 执行闸门：候选在什么条件下可以真的派人。
 *
 * 这是整个 M2 里唯一决定"花不花钱"的函数，所以三件事都在这里、且只在这里：
 *   1. 只有 proxy 档自动执行。strict / readonly 永远只记录——
 *      自动花钱的权限不该由一次保存或一次模型判断悄悄取得。
 *   2. 语义评估明确不通过就不执行（评估缺失时视为通过）。
 *   3. 必须指到了具体代表：没指派的候选无从执行，也不该猜一个。
 */
export type GateInput = {
  candidate: WatchCandidate;
  policy: 'human' | 'proxy' | 'readonly';
  assessment?: Assessment;
  /** 该代表当前是否可派（存在、且没有超预算之类）。 */
  assignable: boolean;
};

export type GateDecision = {
  /** auto = 立刻派人；record = 只记录待人工处理。 */
  action: 'auto' | 'record';
  /** 为什么是这个结论，给界面与日志看。 */
  reason: string;
};

export function gate(input: GateInput): GateDecision {
  const { candidate, policy, assessment, assignable } = input;
  if (policy !== 'proxy') return { action: 'record', reason: policy === 'readonly' ? '只读档：值守只记录' : '严格档：值守只记录，需要人确认' };
  if (!candidate.agent) return { action: 'record', reason: '规则未指派代表' };
  if (!assignable) return { action: 'record', reason: `代表「${candidate.agent}」当前不可派发` };
  if (assessment && !assessment.worth) return { action: 'record', reason: `评估认为不必派人：${assessment.reason}` };
  if (assessment?.confidence !== undefined && assessment.confidence < 0.5) return { action: 'record', reason: `评估置信度不足（${assessment.confidence}）：${assessment.reason}` };
  return { action: 'auto', reason: assessment ? `评估通过（${assessment.confidence ?? '—'}）：${assessment.reason}` : '程序层准入通过' };
}

/**
 * 自动派发的频率上限。
 *
 * 为什么需要：规则的冷却只防同一文件反复触发，防不住"一次重构改了两百个文件"。
 * 没有这个上限，proxy 档会在几分钟内花掉一整天的预算。
 * 计数按分钟窗口，超出就降级为记录——超出本身也是值得人知道的事实。
 */
export const AUTO_DISPATCH_PER_MINUTE = 2;

export type RateWindow = { stamps: number[] };

export function canAutoDispatch(window: RateWindow, now = Date.now()): boolean {
  // 只保留最近一分钟内的派发记录。
  window.stamps = window.stamps.filter(stamp => now - stamp < 60000);
  if (window.stamps.length >= AUTO_DISPATCH_PER_MINUTE) return false;
  window.stamps.push(now);
  return true;
}

/** 自动派发的任务抬头：让人一眼看出它不是人下的指令。 */
export const WATCH_DISPATCH_HEADER = '## 值守自动派发（非人类直接指令）';

/**
 * 自动派发的任务正文。
 *
 * 强调"只读"与"不要扩大范围"：这条任务没有人类在场，
 * 代表把它当成一个可以自由发挥的差事就会出事。
 */
export function dispatchInstruction(candidate: WatchCandidate, evidence: string): string {
  return [
    WATCH_DISPATCH_HEADER,
    '',
    `值守规则「${candidate.ruleId}」检测到文件变化，按规则派你核对。`,
    '',
    '## 要你做的',
    candidate.task,
    '',
    '## 触发它的改动',
    `${candidate.kind} · ${candidate.path}`,
    '',
    ...(evidence.trim() ? ['## 改动内容末尾', evidence.slice(-MAX_ASSESS_CHARS), ''] : []),
    '## 边界',
    '',
    '- 只读：不要修改、创建或删除任何文件。',
    '- 只看这条改动相关的内容，不要顺带审查整个项目。',
    '- 如果这次改动其实无关紧要，直接说"无需处理"，不要为了显得有用而编造问题。',
  ].join('\n');
}
