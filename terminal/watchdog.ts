// Watchdog：用模型判断"这个任务还在实质推进吗"。
//
// 为什么不是超时启发式：超时只看时间，看不出"在重复读同一个文件"或
// "跑得很起劲但方向已经偏了"。这两种才是真问题，而它们都不超时。
//
// 为什么 observe 先行（报告 §0 原则 4"渐进放开"）：
//   模型的判断会错。错的代价在这里不是"多一条提示"，而是"把一个正常任务判成空转"，
//   人可能因此终止它。所以第一阶段只落库 + 一行提示，不触发终止通道；
//   误报率用 verdicts 对照任务终态算出来，观察够了再决定要不要升级。
//
// 为什么不需要自己跑模型：由调用方注入 judge（与记忆整理同一模式），
// 这样测试不需要网络，生产也不需要为 watchdog 单开一个 worker 进程。
import type { KeposDatabase } from './database.ts';

/** 四种判定。progress 永远静默——它只作为误报率的分母存在。 */
export type WatchdogVerdict = 'progress' | 'deviated' | 'looping' | 'noisy';
export const WATCHDOG_VERDICTS: readonly WatchdogVerdict[] = ['progress', 'deviated', 'looping', 'noisy'];

/** 一段待判定的事件增量：只取复核点之后发生的事。 */
export type WatchdogEvidence = {
  workerId: string;
  /** 上次判定读到的事件游标；本次判定的证据从它之后开始。 */
  cursor: number;
  /** 任务目标，用来判断"是否偏离"。 */
  goal: string;
  /** 这段时间内的事件类型与检查点摘要。 */
  events: Array<{ type: string; tool?: string; checkpoint?: string; at: number }>;
  /** 当前阶段的产出末尾，模型据此判断是否在原地打转。 */
  outputTail: string;
  elapsedMs: number;
};

/** 注入的判定器：真实实现用便宜模型，测试用桩。 */
export type WatchdogJudge = (prompt: string) => Promise<string>;

/** 单条原因上限：提示要能一眼读完，不是另一篇报告。 */
export const MAX_REASON_CHARS = 200;
/** 给模型的证据上限，控制单次判定在 500 token 以内。 */
export const MAX_EVIDENCE_CHARS = 1600;

/**
 * 判定提示词：只问一件事——这些事件显示它在推进、偏离、打转，还是在刷噪声。
 * 明确给出"看不出来就说 progress"：默认怀疑会制造误报，误报会让人不信这个通道。
 */
export function watchdogPrompt(evidence: WatchdogEvidence): string {
  const events = evidence.events.slice(-40).map(event => `- ${event.type}${event.tool ? ` (${event.tool})` : ''}${event.checkpoint ? ` · ${event.checkpoint.slice(0, 160)}` : ''}`).join('\n');
  const output = evidence.outputTail.slice(-MAX_EVIDENCE_CHARS);
  return [
    '判断一个正在执行的委派任务是否仍在实质推进。',
    '',
    `## 任务目标`,
    evidence.goal.slice(0, 600),
    '',
    `## 已运行 ${Math.round(evidence.elapsedMs / 1000)}s，本次复核区间内的事件`,
    events || '（没有事件）',
    '',
    '## 产出末尾',
    output || '（尚无产出）',
    '',
    '## 判定',
    '只能选一个，输出严格 JSON：',
    '{"verdict":"progress|deviated|looping|noisy","reason":"一句话依据"}',
    '定义：',
    '- progress：有新信息、新文件、新结论在产生。',
    '- deviated：做的不是任务要求的事（范围跑偏、目标被替换）。',
    '- looping：反复做同一件事，没有新结果（重复读同一文件、重复同一命令）。',
    '- noisy：大量输出但没有可核对的内容（空转的思考、重复措辞）。',
    '看不出来就判 progress——误判空转的代价比漏判高得多。',
    `reason 不超过 ${MAX_REASON_CHARS} 字，必须指向上面看到的具体证据。`,
  ].join('\n');
}

/**
 * 解析判定结果。模型可能加围栏或解释文字，只认对象；坏输入按 progress 处理。
 *
 * 为什么坏输入按 progress：默认怀疑会让通道充满误报，
 * 而误报正是这个功能最容易被关掉的原因。宁可漏一次，不可错一次。
 */
export function parseVerdict(raw: string): { verdict: WatchdogVerdict; reason: string } {
  const text = String(raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { verdict: 'progress', reason: '判定返回无法解析，按推进处理' };
  let parsed: any;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return { verdict: 'progress', reason: '判定返回无法解析，按推进处理' }; }
  const verdict = String(parsed?.verdict ?? '').trim().toLowerCase();
  if (!WATCHDOG_VERDICTS.includes(verdict as WatchdogVerdict)) return { verdict: 'progress', reason: '判定值不在允许范围，按推进处理' };
  const reason = String(parsed?.reason ?? '').trim().slice(0, MAX_REASON_CHARS) || '（未给出原因）';
  return { verdict: verdict as WatchdogVerdict, reason };
}

export type VerdictRecord = { seq: number; workerId: string; at: number; verdict: WatchdogVerdict; reason: string; evidenceCursor: number; model: string };

/**
 * 判定存储与去重。
 *
 * 去重不是"同一任务只判一次"，而是"同一游标不重复判"：
 * 没有新事件时再问一遍模型只会得到同一个答案，白花钱。
 */
export class WatchdogStore {
  constructor(private readonly database: KeposDatabase) {}

  /** 上次判定的游标与该任务累计判定次数。没有记录时游标为 0。 */
  state(workerId: string): { cursor: number; count: number } {
    const row = this.database.prepare('SELECT evidence_cursor, COUNT(*) AS n FROM watchdog_verdicts WHERE worker_id=?').get(workerId) as any;
    return { cursor: Number(row?.evidence_cursor ?? 0), count: Number(row?.n ?? 0) };
  }

  /** 记录一次判定。返回新行；游标没前进时调用方不该走到这里。 */
  record(input: { workerId: string; verdict: WatchdogVerdict; reason: string; evidenceCursor: number; model: string; at?: number }): VerdictRecord {
    const at = input.at ?? Date.now();
    const reason = String(input.reason ?? '').trim().slice(0, MAX_REASON_CHARS);
    const result = this.database.prepare('INSERT INTO watchdog_verdicts(worker_id,at,verdict,reason,evidence_cursor,model) VALUES(?,?,?,?,?,?)')
      .run(input.workerId, at, input.verdict, reason, input.evidenceCursor, input.model);
    return { seq: Number(result.lastInsertRowid), workerId: input.workerId, at, verdict: input.verdict, reason, evidenceCursor: input.evidenceCursor, model: input.model };
  }

  /** 某任务的全部判定，最新的在前——界面要显示"为什么认为它空转"。 */
  list(workerId: string, limit = 20): VerdictRecord[] {
    const rows = this.database.prepare('SELECT seq,worker_id,at,verdict,reason,evidence_cursor,model FROM watchdog_verdicts WHERE worker_id=? ORDER BY seq DESC LIMIT ?').all(workerId, limit) as any[];
    return rows.map(row => ({ seq: Number(row.seq), workerId: row.worker_id, at: Number(row.at), verdict: row.verdict, reason: row.reason, evidenceCursor: Number(row.evidence_cursor), model: row.model }));
  }

  /** 全部判定，供 §6 误报率统计。 */
  all(limit = 500): VerdictRecord[] {
    const rows = this.database.prepare('SELECT seq,worker_id,at,verdict,reason,evidence_cursor,model FROM watchdog_verdicts ORDER BY seq DESC LIMIT ?').all(limit) as any[];
    return rows.map(row => ({ seq: Number(row.seq), workerId: row.worker_id, at: Number(row.at), verdict: row.verdict, reason: row.reason, evidenceCursor: Number(row.evidence_cursor), model: row.model }));
  }
}

/**
 * 是否值得对这次复核问一次模型。
 *
 * 只在已经有产出或事件、且游标前进时才判：一个刚启动的任务没有可判断的东西，
 * 每次复核都问一遍会把"启动慢"误标成空转。
 */
export function shouldJudge(input: { eventCount: number; cursor: number; lastCursor: number; outputTail: string }): boolean {
  if (input.cursor <= input.lastCursor) return false;      // 没有新事件，答案不会变
  if (!input.eventCount && !input.outputTail.trim()) return false;
  return true;
}

/**
 * 判定与人类可见动作之间的映射。
 *
 * 阶段①（observe）：只有 deviated/looping 会说出来，且只是提示；
 * progress 静默，noisy 也不说——噪声本身不足以让人介入。
 * 这个函数是唯一的地方：升级到任务终止通道时改这里，别散落在界面代码里。
 */
export function verdictNotice(record: VerdictRecord): string | undefined {
  if (record.verdict === 'progress') return undefined;
  if (record.verdict === 'noisy') return undefined;
  const label = record.verdict === 'deviated' ? '偏离任务' : '疑似原地打转';
  return `⚠ ${label}（模型判断）：${record.reason} · 是否终止由你决定`;
}
