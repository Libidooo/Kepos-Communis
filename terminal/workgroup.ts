// 临时工作小组：围绕某一个具体任务临时形成，随任务结束销毁。
//
// 设计依据（人与 AI 的差异）：
//   人类辩论靠立场异质避免群体极化，但同源模型互相读上下文会趋同。
//   因此这里把上下文分成两类：
//     evidence   —— 读到的文件、命令输出、数据。共享能减少重复劳动，允许同组直读。
//     conclusion —— 结论、判断、投票。共享会制造从众，禁止同组直读。
//   组是临时的（绑定 groupId，任务结束即失效），不做持久成员表。
//
// 跨组一律不直读：由代理总代上报总理，总理授权后由代理总代代为沟通。

/** 组上下文里允许同组共享的部分。 */
export type GroupEvidence = {
  taskId: string;
  agent: string;
  title: string;
  /** 工具调用与产出的证据段（不含结论）。 */
  evidence: string;
  checkpoint?: string;
  updatedAt: number;
  state: string;
};

export type GroupConclusion = {
  taskId: string;
  agent: string;
  /** 结论 / 置信度 / 需要 三段；投票单独记录。 */
  conclusion: string;
  vote?: 'yes' | 'no' | 'abstain';
  voteReason?: string;
};

export type GroupMember = {
  taskId: string;
  agent: string;
  agentId?: string;
  state: string;
  started: number;
  ended?: number;
};

/**
 * 从产出中切出「证据段」与「结论段」。
 * 代表按输出契约以 ## 结论 收尾；此前的内容视为工作过程与证据。
 * 没有契约标记时：全部算证据，结论为空——宁可少给结论，也不把过程误当结论。
 */
export function splitEvidenceAndConclusion(output: string): { evidence: string; conclusion: string } {
  const text = String(output ?? '');
  const at = text.indexOf('## 结论');
  if (at < 0) return { evidence: text, conclusion: '' };
  return { evidence: text.slice(0, at).trim(), conclusion: text.slice(at).trim() };
}

/** 从结论段里抽出 VOTE 约定行。 */
export function extractVote(conclusion: string): { vote?: 'yes' | 'no' | 'abstain'; reason?: string } {
  const match = String(conclusion ?? '').match(/VOTE:\s*(yes|no|abstain)\s*(?:[-—]\s*(.+))?/i);
  if (!match) return {};
  return { vote: match[1].toLowerCase() as 'yes' | 'no' | 'abstain', reason: match[2]?.trim() };
}

/**
 * 同组可见视图：只暴露证据，结论与投票一律剔除。
 * 这是他人在同组内能看到的全部内容——结论必须各自独立形成。
 */
export function visibleToPeer(member: GroupMember, output: string, now = Date.now()): GroupEvidence {
  const { evidence } = splitEvidenceAndConclusion(output);
  return {
    taskId: member.taskId,
    agent: member.agent,
    title: '',
    evidence: evidence.length > 4000 ? `${evidence.slice(0, 3000)}\n… [证据过长已截断] …\n${evidence.slice(-1000)}` : evidence,
    updatedAt: now,
    state: member.state,
  };
}

/**
 * 是否允许该成员读取另一成员的上下文。
 * 同组：允许读证据（结论仍被 visibleToPeer 剔除）。
 * 跨组：不允许，必须走上报—授权—代理总代沟通。
 */
export function canReadPeer(
  reader: { groupId?: string; canCrossGroup?: boolean },
  target: { groupId?: string },
): { allowed: boolean; scope: 'group' | 'cross-group'; reason?: string } {
  if (!reader.groupId || !target.groupId) {
    return { allowed: false, scope: 'cross-group', reason: '缺少工作小组标识：只有同一临时小组内的代表可互读' };
  }
  if (reader.groupId === target.groupId) return { allowed: true, scope: 'group' };
  if (reader.canCrossGroup === true) return { allowed: true, scope: 'cross-group' };
  return { allowed: false, scope: 'cross-group', reason: '跨组读取需要上级上报总理并由代理总代代为沟通' };
}

// ── 辩论：三轮交锋 + 第四轮全员表态 ───────────────────────────────────
export const DEBATE_ROUNDS = 3;
export const DEBATE_FINAL_ROUND = 4;

export type DebateRound = {
  round: number;
  kind: 'opening' | 'rebuttal' | 'closing' | 'final-poll';
  /** 本轮要执行的动作说明，直接发给代表。 */
  instruction: string;
};

/**
 * 辩论轮次计划：三轮交锋后，第四轮要求组内所有代表表态，最后上级决断。
 * 前三轮只让持不同意见的代表参与；第四轮扩大到全组，避免被少数人代表。
 */
export function debatePlan(topic: string, positions: string[]): DebateRound[] {
  const sides = positions.length ? positions : ['正方', '反方'];
  return [
    {
      round: 1,
      kind: 'opening',
      instruction: `辩论第 1 轮（立论）：就「${topic}」各自陈述立场与依据。${sides.join(' / ')}。只呈现证据与推理，不要评价对方。`,
    },
    {
      round: 2,
      kind: 'rebuttal',
      instruction: `辩论第 2 轮（交锋）：针对对方第 1 轮的论点逐条回应，指出证据缺口或推理错误。仍只使用可核实的证据。`,
    },
    {
      round: 3,
      kind: 'closing',
      instruction: `辩论第 3 轮（收束）：给出最终立场，并明确说出「什么证据会让我改变判断」。此轮结束后不再交锋。`,
    },
    {
      round: DEBATE_FINAL_ROUND,
      kind: 'final-poll',
      instruction: `辩论结束。全组每位代表就「${topic}」独立表态，末尾写 VOTE: yes|no|abstain - 一行理由。不要参考他人结论，只依据自己掌握的证据。表态由上级汇总后呈报人类裁决。`,
    },
  ];
}

/** 辩论是否应当提醒人类观察。 */
export function debateNeedsHuman(kind: DebateRound['kind']): boolean {
  // 交锋阶段与最终表态都要人类旁观：前者防跑偏，后者因为需要人类裁决。
  return kind === 'rebuttal' || kind === 'final-poll';
}
