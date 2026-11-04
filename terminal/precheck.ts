// 值守 M3：静默预检（投机执行）。
//
// 问题：一条 bug 报告到达时，最常见的情况是它根本复现不了——
// 环境不对、步骤漏了、描述的是旧版本。为人着想的做法不是立刻上报，
// 而是先花几次只读调用来试着复现，只有真的复现出来才占用人的注意力。
//
// 但"静默"不等于"隐瞒"。这一层的诚实要求比效率要求更高：
//   - 复现不了，也要把试过什么讲清楚，否则下次还是同一个报告再来一遍。
//   - 判断不清（unclear）绝不折算成"否"。报告写得含糊本身就是一条要反馈的信息。
//   - 只有拿到**具体复现证据**（命令与输出）才算确认。
//     代表说"我觉得能复现"跟没说一样。
//
// 为什么这是 Kepos 的结构优势：并行复现需要多个只读席位同时开工，
// 单 Worker 的 harness 只能串行试，代价高到不值得为此静默。

/** 预检结论。refuted 与 inconclusive 是两件不同的事，界面上不能合并。 */
export type PrecheckVerdict = 'reproduced' | 'refuted' | 'inconclusive';

/** 单个代表的复现结论。 */
export type Reproduction = {
  agent: string;
  /** 看到的判定；解析失败时为 unclear，绝不默认成 no。 */
  state: 'yes' | 'no' | 'unclear';
  /** 具体复现证据：命令、输出、文件行号。没有它，yes 不算数。 */
  evidence: string;
  reason: string;
};

/** 并行复现的默认席位数：三个角度足够区分"偶发"与"稳定复现"，再多是重复劳动。 */
export const DEFAULT_PRECHECK_AGENTS = 3;
/** 每个复现任务的 token 预算。预检本身必须便宜，否则它比 bug 还贵。 */
export const PRECHECK_BUDGET_TOKENS = 120_000;
/** 复现时限：卡住的任务由 deadline 收尾，不给人留一个悬着的预检。 */
export const PRECHECK_SECONDS = 240;

/**
 * 复现任务的角度。
 *
 * 为什么必须不同：三个代表用同一种方式试同一件事，付了三倍价钱只得到一次尝试。
 * 分工按"信息从哪来"划分——能不能从测试里看到、能不能从源码推出、能不能从运行行为看到。
 * 互不重叠才有并行的意义。
 */
export const PRECHECK_ANGLES = [
  { key: 'tests', angle: '从测试入手：找到覆盖相关行为的现有测试并运行它，看是否失败。不要新写测试。' },
  { key: 'source', angle: '从源码入手：读相关实现，判断报告描述的路径在代码里是否真的会走到那个分支。可以用 grep/find 定位。' },
  { key: 'runtime', angle: '从运行行为入手：用只读命令观察真实输出（日志、构建结果、命令回显），看现象是否符合报告。' },
] as const;

/**
 * 复现任务的正文。
 *
 * 三条硬要求：
 *   1. 只读，不许改任何东西——预检不能把现场弄脏，否则后续排查失去基准。
 *   2. 必须给出 REPRODUCED 行，值只有 yes / no / unclear。禁止犹豫性表述。
 *   3. 报 yes 必须带具体证据（命令与输出），否则不算确认。
 */
export function reproduceInstruction(input: { report: string; angle: string; index: number }): string {
  return [
    '## 静默预检 · 尝试复现（非人类直接指令）',
    '',
    '有人在报告一个问题。你要做的不是修它，也不是评价它，而是判断**能否按描述复现**。',
    '',
    '## 报告',
    input.report.trim().slice(0, 2000),
    '',
    '## 你这一路的角度',
    input.angle,
    '',
    '其他代表在从别的角度并行核查；你只走自己这一路，不要试图覆盖全部。',
    '',
    '## 边界',
    '',
    '- 只读：不要修改、创建、删除任何文件，不要提交、不要重装依赖。',
    '- 不要修问题，也不要提出修复方案——这一轮只回答"能不能复现"。',
    '- 时间不够就报 unclear，不要猜。',
    '',
    '## 输出要求',
    '',
    '在结论末尾单独一行，格式必须是：',
    'REPRODUCED: yes|no|unclear — <一句话依据>',
    '',
    '再单独一行写证据：',
    'EVIDENCE: <你实际执行的命令及其输出片段；报 no 时写你检查了什么；无法给出就留空>',
    '',
    '判定标准：',
    '- yes：你实际看到了报告描述的现象，并且能说出触发它的具体操作。',
    '- no：按描述做了，现象没有出现；或代码路径证明该现象不可能发生。',
    '- unclear：报告信息不足以判断，或缺环境。含糊时必须选这个，不要选 no。',
  ].join('\n');
}

/**
 * 解析单个代表的复现结论。
 *
 * 关键：**没有证据的 yes 降级为 unclear**。
 * 代表很容易说"是的能复现"然后给一段猜测；把它当确认等于让预检自己制造 bug。
 */
export function parseReproduction(agent: string, output: string): Reproduction {
  const text = String(output ?? '');
  const line = /REPRODUCED:\s*(yes|no|unclear)\s*(?:[-—:]\s*(.*))?/i.exec(text);
  if (!line) return { agent, state: 'unclear', evidence: '', reason: '未给出 REPRODUCED 判定' };
  const state = line[1].toLowerCase() as 'yes' | 'no' | 'unclear';
  const reason = String(line[2] ?? '').trim().slice(0, 200) || '（未说明依据）';
  const evidenceMatch = /EVIDENCE:\s*(.*)/i.exec(text);
  const evidence = String(evidenceMatch?.[1] ?? '').trim().slice(0, 800);
  if (state === 'yes' && !evidence) {
    // 没有证据的确认不算确认——它只会把一次猜测变成一次打扰。
    return { agent, state: 'unclear', evidence: '', reason: `声称可复现但未给证据：${reason}` };
  }
  return { agent, state, evidence, reason };
}

export type PrecheckResult = {
  verdict: PrecheckVerdict;
  /** 复现成功的代表（只在 verdict=reproduced 时非空）。 */
  reproducedBy: Reproduction[];
  /** 明确否定的数量。 */
  refuted: number;
  /** 判断不清的数量——这是"报告太含糊"的信号。 */
  unclear: number;
  /** 给人看的一句话。三种结论的措辞必须能区分开。 */
  summary: string;
};

/**
 * 汇总多个代表的结论。
 *
 * ≥1 个带证据的 yes 就是复现成立：偶发 bug 只需要一个可靠见证。
 * 全部 no 才是"复现不了"。其余一律 inconclusive——把它说成"复现不了"
 * 会让真实但难复现的问题被埋掉。
 */
export function aggregateReproductions(results: readonly Reproduction[]): PrecheckResult {
  const reproducedBy = results.filter(item => item.state === 'yes');
  const refuted = results.filter(item => item.state === 'no').length;
  const unclear = results.filter(item => item.state === 'unclear').length;
  if (reproducedBy.length) {
    const names = reproducedBy.map(item => item.agent).join('、');
    return {
      verdict: 'reproduced', reproducedBy, refuted, unclear,
      summary: `已复现（${names}）· ${reproducedBy[0].reason}`,
    };
  }
  if (results.length && refuted === results.length) {
    return {
      verdict: 'refuted', reproducedBy: [], refuted, unclear,
      summary: `${refuted} 个角度都未能复现；报告可能过时或缺少前提条件`,
    };
  }
  return {
    verdict: 'inconclusive', reproducedBy: [], refuted, unclear,
    summary: `${unclear} 个角度无法判断${refuted ? `、${refuted} 个未复现` : ''}；报告需要更具体的步骤或环境信息`,
  };
}

/**
 * 该不该打扰人。
 *
 * 只有 reproduced 才值得打断——那是唯一一个"人现在就该知道"的结论。
 * refuted 与 inconclusive 也一样要有去处，但它们不该用紧急通道：
 * 前者是给报告者的回复，后者是给报告者的追问。
 */
export function shouldInterrupt(result: PrecheckResult): boolean {
  return result.verdict === 'reproduced';
}

/**
 * 给人看的预检摘要。
 *
 * 三种结论都写出"试过什么"，因为即使没有复现，
 * 这份记录也能让人判断"是不是这条报告本身需要补充信息"。
 */
export function precheckReport(input: { report: string; result: PrecheckResult; attempts: readonly Reproduction[] }): string {
  const head = input.result.verdict === 'reproduced'
    ? '## 预检结果：已复现'
    : input.result.verdict === 'refuted'
      ? '## 预检结果：未能复现'
      : '## 预检结果：无法判断';
  const detail = input.attempts.map(item => `- ${item.agent}（${item.state}）：${item.reason}${item.evidence ? `\n  证据：${item.evidence}` : ''}`);
  return [
    head,
    '',
    '### 报告',
    input.report.trim().slice(0, 600) || '（空）',
    '',
    '### 结论',
    input.result.summary,
    '',
    '### 各角度的尝试',
    ...detail,
    '',
    input.result.verdict === 'reproduced'
      ? '### 下一步\n这条已经确认可复现，可以按正常流程派修复任务了。'
      : input.result.verdict === 'refuted'
        ? '### 下一步\n未能复现不等于不存在：如果报告者能补上环境与最小步骤，可以再试一次。'
        : '### 下一步\n请向报告者索取：确切的复现步骤、环境版本、以及在哪个提交上看到的。',
  ].join('\n');
}

/** 一条预检记录：用于避免同一条报告被反复预检。 */
export type PrecheckRecord = {
  id: string;
  at: number;
  /** 报告正文的指纹，用于去重。 */
  fingerprint: string;
  verdict: PrecheckVerdict;
  summary: string;
  attempts: number;
};

/** 报告指纹：去掉空白与标点，取前 60 字——同一句话的不同排版算同一条报告。 */
export function reportFingerprint(report: string): string {
  return String(report ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、,.;:!?！？'"'（）()【】\[\]《》<>]/g, '')
    .slice(0, 60);
}

/** 预检是否值得跑：太短的报告复现不了，也会浪费三个席位。 */
export function precheckable(report: string): { ok: boolean; reason?: string } {
  const text = String(report ?? '').trim();
  if (text.length < 10) return { ok: false, reason: '报告太短：至少需要一句能定位现象的描述' };
  if (text.length > 4000) return { ok: false, reason: '报告过长：请先提炼出最小可复现描述' };
  return { ok: true };
}

/** 候选表与预检共用的"这条走没走过"判断。 */
export function alreadyChecked(records: readonly PrecheckRecord[], report: string): PrecheckRecord | undefined {
  const fingerprint = reportFingerprint(report);
  return records.find(record => record.fingerprint === fingerprint);
}

/**
 * 预检记录的落库。
 *
 * 唯一目的：同一条报告不要被预检两次。
 * 重复报告的代价是双倍的——既浪费三席并行任务，又让人看到两条一样的"无法判断"。
 */
export class PrecheckStore {
  constructor(private readonly database: import('./database.ts').KeposDatabase) {}

  /** 这条报告是否已经预检过。 */
  find(report: string): PrecheckRecord | undefined {
    const fingerprint = reportFingerprint(report);
    if (!fingerprint) return undefined;
    const row = this.database.prepare('SELECT id,at,fingerprint,verdict,summary,attempts FROM precheck_runs WHERE fingerprint=? ORDER BY at DESC LIMIT 1')
      .get(fingerprint) as any;
    if (!row) return undefined;
    return { id: String(row.id), at: Number(row.at), fingerprint: String(row.fingerprint), verdict: row.verdict as PrecheckVerdict, summary: String(row.summary), attempts: Number(row.attempts) };
  }

  record(input: { report: string; result: PrecheckResult; attempts: number; at?: number }): PrecheckRecord {
    const fingerprint = reportFingerprint(input.report);
    const record: PrecheckRecord = {
      id: `pc_${input.at ?? Date.now()}_${fingerprint.slice(0, 12)}`,
      at: input.at ?? Date.now(),
      fingerprint,
      verdict: input.result.verdict,
      summary: input.result.summary,
      attempts: input.attempts,
    };
    this.database.prepare('INSERT INTO precheck_runs(id,at,fingerprint,verdict,summary,attempts) VALUES(?,?,?,?,?,?)')
      .run(record.id, record.at, record.fingerprint, record.verdict, record.summary, record.attempts);
    return record;
  }

  /** 最近的预检，最新在前——界面要能回答"这条报告为什么没上报"。 */
  recent(limit = 20): PrecheckRecord[] {
    const rows = this.database.prepare('SELECT id,at,fingerprint,verdict,summary,attempts FROM precheck_runs ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit))) as any[];
    return rows.map(row => ({ id: String(row.id), at: Number(row.at), fingerprint: String(row.fingerprint), verdict: row.verdict as PrecheckVerdict, summary: String(row.summary), attempts: Number(row.attempts) }));
  }
}
