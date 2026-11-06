// 推举呈报：组内推举只是提名，真正决定要人来做。
//
// 流程（人类裁定）：
//   组内推举 → 代理总代核实并呈报总理 → 总理核阅候选人的档案、职责与历史
//   → 出一份给人类的评估报告 → 人类批准
//
// 为什么中间要经过两级而不是直接给人：
//   组内推举看的是"谁在这次协作里最合适"，那是局部视角；
//   总理看的是"这个人一贯怎么样"——履历、失败模式、配置变更之后的表现。
//   两者都要，但必须分开呈现：局部共识不能替代长期观察，反之亦然。
//
// 报告必须**可核对**：每条结论都要能指回具体依据（哪条任务、哪个失败类别、
// 哪个配置修订）。一份只有印象没有依据的评估，会让人只能凭感觉批准。
import type { AgentProfile } from './profiles.ts';
import { representativeHealth, type RepresentativeTaskHistory } from './representative-health.ts';
import type { Candidate } from './group-election.ts';

/** 一个候选人的完整评估。 */
export type CandidateAssessment = {
  /** 代表名。 */
  name: string;
  /** 稳定配置 id。 */
  agentId?: string;
  /** 组内得票。 */
  votes: number;
  /** 职责摘要：这一位被配置成做什么。 */
  role: string;
  /** 角色 key（用于指出"这是标准角色"还是"自定义职责"）。 */
  roleKey?: string;
  /** 模型与供应商：协作期间整个组最好一致，否则速度差异会变成进度瓶颈。 */
  model: string;
  provider: string;
  /** 已完成任务的观察：样本量、失败数、连续失败。 */
  history: { sampleSize: number; failureCount: number; consecutiveFailures: number; needsDiagnosis: boolean };
  /** 历史里出现过的失败类别与建议，最多几条。 */
  issues: Array<{ taskId: string; category: string; reason: string }>;
  /** 一句话建议：可推举 / 可推举但需留意 / 不建议。 */
  verdict: 'ready' | 'caution' | 'avoid';
  /** 为什么是这个结论，必须指向上面的字段。 */
  rationale: string;
};

/**
 * 评估一位候选人。
 *
 * 判断优先级刻意是"健康度 → 职责相关性 → 票数"，而不是反过来：
 * 票数只说明组内偏好，说明不了这个人是否可靠。一个被全组推举但连续失败的
 * 协调者，会让整个协作一起烂掉。
 */
export function assessCandidate(input: {
  candidate: Candidate;
  profile?: AgentProfile;
  tasks: readonly RepresentativeTaskHistory[];
  /** 这一组在做什么，用于判断职责是否相关。 */
  goal?: string;
}): CandidateAssessment {
  const { candidate, profile, tasks, goal } = input;
  const health = representativeHealth(tasks, { id: profile?.id, name: candidate.agent });
  const history = {
    sampleSize: health.sampleSize,
    failureCount: health.failureCount,
    consecutiveFailures: health.consecutiveFailures,
    needsDiagnosis: health.needsDiagnosis,
  };
  const issues = health.issues.slice(0, 3).map(issue => ({ taskId: issue.taskId, category: issue.category, reason: issue.reason }));

  let verdict: CandidateAssessment['verdict'] = 'ready';
  let rationale = `近 ${history.sampleSize} 轮完成 ${history.sampleSize - history.failureCount} 轮，历史正常`;
  // 没有配置就没有候选人：票可能投给了一个已删除或改名的代表。
  // 这种情况不能说"首次牵头"——那是给一个不存在的人安排工作。
  if (!profile) {
    return {
      name: candidate.agent, votes: candidate.votes, role: '（未找到配置）', model: '—', provider: '',
      history, issues: [], verdict: 'avoid',
      rationale: '找不到该代表的配置：可能已删除或改名，重新推举前先确认',
    };
  }
  // 连续失败是最强的负面信号：它说明最近的状态有问题，而协作正要开始。
  if (history.consecutiveFailures >= 3) {
    verdict = 'avoid';
    rationale = `连续 ${history.consecutiveFailures} 轮未完成，先诊断再考虑让它牵头`;
  } else if (history.needsDiagnosis) {
    verdict = 'caution';
    rationale = `近 ${history.sampleSize} 轮有 ${history.failureCount} 轮未完成，需要留意`;
  } else if (history.sampleSize === 0) {
    // 没有历史不等于差，但也不能说它"历史正常"。
    verdict = 'caution';
    rationale = '还没有足够的完成记录可评估；首次牵头需要更密的复核';
  }

  // 职责与目标的字面相关性只是提示，不参与裁决：
  // 措辞不重合不代表不合适，措辞重合也不代表做得好。
  const relevant = goal && profile?.role ? overlaps(profile.role, goal) : true;

  return {
    name: candidate.agent,
    agentId: profile?.id,
    votes: candidate.votes,
    role: String(profile?.role ?? '（未找到配置）').slice(0, 400),
    ...(profile?.roleKey ? { roleKey: profile.roleKey } : {}),
    model: String(profile?.model ?? '—'),
    provider: String(profile?.provider ?? ''),
    history,
    issues,
    verdict,
    rationale: relevant ? rationale : `${rationale}；职责描述与本次目标字面重合度低，确认是否合适`,
  };
}

/** 粗略的用词重合：只看长度≥2 的词，够用来提示"可能不相关"。 */
function overlaps(role: string, goal: string): boolean {
  const words = (text: string) => new Set(String(text || '').toLowerCase().split(/[^\p{Script=Han}a-zA-Z0-9]+/u).filter(word => word.length >= 2));
  const goalWords = words(goal);
  if (!goalWords.size) return true;
  for (const word of words(role)) if (goalWords.has(word)) return true;
  return false;
}

/** 排序：不建议的排最后，其余按票数降序——人先看到最可能被批准的。 */
export function rankAssessments(items: readonly CandidateAssessment[]): CandidateAssessment[] {
  const weight = { ready: 0, caution: 1, avoid: 2 } as const;
  return [...items].sort((a, b) => weight[a.verdict] - weight[b.verdict] || b.votes - a.votes || a.name.localeCompare(b.name));
}

export type ElectionReport = {
  groupId: string;
  goal?: string;
  electorate: number;
  ballots: number;
  tied: boolean;
  candidates: CandidateAssessment[];
  /** 建议：有人可推举时给出首选；平票或全部不建议时说明需要人定。 */
  recommendation: string;
  /** 人类批准时要看到的那一句：批的是谁、在哪个组、做什么。 */
  approvalLine: string;
};

/**
 * 生成呈报给人类的报告。
 *
 * 措辞上有一条要求：结论不能比证据更强。
 * 所以"建议"永远写成条件句（"若无异议，建议由 X 牵头"），
 * 而不是"X 是最佳人选"——后者是系统替人做了判断。
 */
export function buildElectionReport(input: {
  groupId: string;
  goal?: string;
  electorate: number;
  ballots: number;
  tied: boolean;
  assessments: readonly CandidateAssessment[];
}): ElectionReport {
  const ranked = rankAssessments(input.assessments);
  const ready = ranked.filter(item => item.verdict === 'ready');
  let recommendation: string;
  if (!ranked.length) recommendation = '没有可评估的候选人：组内还没有推举表态。';
  else if (input.tied) recommendation = `得票并列（${ranked[0]?.votes} 票）：请人类在候选之间指定，系统不代为裁定。`;
  else if (input.tied === false && ready.length) recommendation = `若无异议，建议推举「${ready[0].name}」兼任代理总代（${ready[0].votes} 票，${ready[0].rationale}）。`;
  else if (ranked.some(item => item.verdict === 'caution')) recommendation = `候选人都有需要留意的地方：建议先诊断再决定；若必须现在推举，可考虑「${ranked[0].name}」并加强复核。`;
  else recommendation = '所有候选人都存在未解决的失败记录，建议暂不推举。';

  // 待批准那一行必须和建议一致：只有确实可推举的人才写进"待批准"。
  // 否则建议说"暂不推举"、待批准却写着某人的名字，只看后者的人会批错。
  const top = input.tied ? undefined : ready[0];
  const approvalLine = top
    ? `推举「${top.name}」兼任代理总代${input.goal ? `（组 ${input.groupId}：${input.goal.slice(0, 80)}）` : `（组 ${input.groupId}）`}`
    : ranked.length
      ? `组 ${input.groupId} 暂无合适的推举人选：${input.tied ? '得票并列，请指定' : '候选人都有未解决的记录，先诊断'}`
      : `组 ${input.groupId} 还没有推举表态`;
  return { groupId: input.groupId, goal: input.goal, electorate: input.electorate, ballots: input.ballots, tied: input.tied, candidates: ranked, recommendation, approvalLine };
}

/**
 * 渲染成给人读的文字。
 *
 * 顺序刻意是"结论 → 依据 → 各候选细节"：
 * 人要先知道要批什么，再决定要不要往下看细节。
 */
export function renderElectionReport(report: ElectionReport): string {
  const lines = [
    `# 推举代理总代 · 组 ${report.groupId}`,
    '',
    ...(report.goal ? [`任务：${report.goal.slice(0, 120)}`] : []),
    `参与 ${report.electorate} 人，${report.ballots} 票${report.tied ? '（并列）' : ''}`,
    '',
  ];
  // 候选人一行一个：票数、健康度、结论。人第一眼只需要这些。
  for (const item of report.candidates) {
    const flag = item.verdict === 'ready' ? '可推举' : item.verdict === 'caution' ? '需留意' : '不建议';
    const h = item.history.sampleSize
      ? `${item.history.sampleSize} 轮中 ${item.history.failureCount} 未完成`
      : '无完成记录';
    lines.push(`· ${item.name}　${item.votes} 票　${flag}　${h}`);
  }
  lines.push('', '## 建议', report.recommendation, '');
  // 只展开有问题的候选：健康的候选不需要解释。
  const troubled = report.candidates.filter(item => item.issues.length || item.verdict !== 'ready');
  if (troubled.length) {
    lines.push('## 依据');
    for (const item of troubled) {
      lines.push(`- ${item.name}：${item.rationale}`);
      for (const issue of item.issues) lines.push(`  · ${issue.taskId} ${issue.category}：${issue.reason}`);
    }
    lines.push('');
  }
  lines.push('---', '批准即推举该代表兼任代理总代；不新增席位、不改其职责与模型。');
  return lines.join('\n');
}

/** 一条待人类批准的推举呈报。 */
export type ElectionRecord = {
  id: string;
  at: number;
  groupId: string;
  /** pending = 等人类批准；approved = 已批准；rejected = 已驳回。 */
  state: 'pending' | 'approved' | 'rejected';
  goal?: string;
  report: ElectionReport;
  approvedAgent?: string;
  decidedAt?: number;
};

/**
 * 推报表的落库。
 *
 * 为什么必须落库：批准的是"谁在哪个组牵头"，事后一定有人问"当初凭什么"。
 * 报告里带着当时的票数与健康度快照，这些数字过几周就会变，
 * 所以快照必须和决定存在一起，而不是每次重新计算。
 */
export class ElectionStore {
  constructor(private readonly database: import('./database.ts').KeposDatabase) {}

  /** 登记一份待批报告。同一组只保留最新一份待批——旧的推举已经被新的事实覆盖。 */
  submit(report: ElectionReport, at = Date.now()): ElectionRecord {
    const id = `el_${at}_${report.groupId.replace(/[^A-Za-z0-9_-]/g, '')}`;
    this.database.transaction(() => {
      this.database.prepare("UPDATE election_reports SET state='rejected',decided_at=? WHERE group_id=? AND state='pending'").run(at, report.groupId);
      this.database.prepare('INSERT INTO election_reports(id,at,group_id,state,goal,report,approved_agent,decided_at) VALUES(?,?,?,?,?,?,NULL,NULL)')
        .run(id, at, report.groupId, 'pending', report.goal ?? null, JSON.stringify(report));
    });
    return { id, at, groupId: report.groupId, state: 'pending', ...(report.goal ? { goal: report.goal } : {}), report };
  }

  /**
   * 待批列表，最新的在前。
   *
   * `groupAlive` 可选：组解散后，它那份推举已经没有决定可做，
   * 继续挂在待批列表里只会让人以为还有事要处理。
   * 记录本身保留（历史要能回溯），只是不再出现在待批。
   */
  pending(groupAlive?: (groupId: string) => boolean): ElectionRecord[] {
    const rows = this.database.prepare("SELECT id,at,group_id,state,goal,report,approved_agent,decided_at FROM election_reports WHERE state='pending' ORDER BY at DESC").all() as any[];
    const records = rows.map(toRecord);
    return groupAlive ? records.filter(record => groupAlive(record.groupId)) : records;
  }

  /** 人类批准：记下批的是谁，报告保留。 */
  approve(id: string, agent: string, at = Date.now()): boolean {
    const result = this.database.prepare("UPDATE election_reports SET state='approved',approved_agent=?,decided_at=? WHERE id=? AND state='pending'").run(agent, at, id);
    return Number(result.changes) > 0;
  }

  /** 人类驳回。 */
  reject(id: string, at = Date.now()): boolean {
    const result = this.database.prepare("UPDATE election_reports SET state='rejected',decided_at=? WHERE id=? AND state='pending'").run(at, id);
    return Number(result.changes) > 0;
  }

  /**
   * 某组当前已批准的协调者，供派发时注入职责说明。
   *
   * `stillDeputy` 是必须的：组内推举批的是"兼任代理总代的那个人"。
   * 人类一旦撤销或换人，旧的批准就失去了依附——继续认它，
   * 等于让一个已经不是总代的人仍然拿着协调职责。
   */
  coordinator(groupId: string, stillDeputy: (agent: string) => boolean = () => true): string | undefined {
    const row = this.database.prepare("SELECT approved_agent FROM election_reports WHERE group_id=? AND state='approved' ORDER BY decided_at DESC LIMIT 1").get(groupId) as any;
    const agent = row?.approved_agent;
    if (!agent) return undefined;
    return stillDeputy(agent) ? agent : undefined;
  }
}

function toRecord(row: any): ElectionRecord {
  return {
    id: String(row.id), at: Number(row.at), groupId: String(row.group_id), state: row.state,
    ...(row.goal ? { goal: String(row.goal) } : {}),
    report: JSON.parse(row.report),
    ...(row.approved_agent ? { approvedAgent: String(row.approved_agent) } : {}),
    ...(row.decided_at ? { decidedAt: Number(row.decided_at) } : {}),
  };
}
