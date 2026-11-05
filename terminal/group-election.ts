// 组内推选：围绕一个任务的协作要有人牵头。
//
// 为什么需要：一组代表在做同一件事，却没有明确谁是协调者，
// 就会各自埋头、重复劳动、或者互相等对方先动。代理总代在全局层承担这个角色
// （人类从现任代表中推选，兼任）；在组内层，同样的需要由**组内推举**满足。
//
// 两条与全局一致的原则：
//   1. 这是**兼职务**，不是新席位。被推举者仍然是一名普通代表，只是多了协调职责。
//   2. 人类保留否决权。组的推举结果只是候选，最终由人类在界面上确认——
//      自主推举可以让协作启动得更快，但不能让编制决定绕开人。
//
// 与全局代理总代的区别：组内推举随组解散而失效，不写入持久配置；
// 全局那个是人类明确推选的长期职务。
import type { GroupMessage } from './group-channel.ts';

/** 推举的最小规模：一个人不需要被协调。 */
export const MIN_ELECTORATE = 2;

/** 一位候选人的得票。 */
export type Candidate = { taskId: string; agent: string; votes: number };

/**
 * 从组内消息里数出推举结果。
 *
 * 只认明确表态：消息种类必须是 discuss，且正文里出现推举标记。
 * 不猜意图——把"我觉得 B 挺合适"当成投票会让结果充满解释空间。
 */
// 推举标记必须是一句中明确的表态。
// 此前只匹配"推举：某某"，于是「我不同意推举：勘察官」和「要不要推举：勘察官？」
// 都被算成支持票——注释说"不猜意图"，正则却在猜。
// 现在要求：标记在句首或标点之后、紧跟冒号与被推举者，且该句不含否定/征询词。
const NOMINATE = /(?:^|[\u3000-\u303f\uff00-\uffef,;:\s])(?:\u6211)?(?:\u63a8\u4e3e|\u63a8\u9009|elect|nominate)\s*[:\uff1a]\s*([^\n,\u3001\uff0c\u3002;\uff1b?!\uff1f]{1,40})/iu;
/** 出现这些词说明该句不是表态，而是否定或征询。 */
const NOT_A_BALLOT = /(不同意|反对|不赞成|不必|不要|无需|是否|要不要|该不该|不如|maybe|should we|do not|don't)/i;

/**
 * 统计推举结果。
 *
 * members 提供 taskId → agent 的映射：投票写的是人名的片段，
 * 必须落回具体任务才不会把票投给不存在的人。
 */
export function tallyElection(messages: readonly GroupMessage[], members: ReadonlyArray<{ taskId: string; agent: string }>): {
  candidates: Candidate[];
  /** 票数相同且为最高时的全部候选——平票不硬选一个。 */
  tied: boolean;
  winner?: Candidate;
  ballots: number;
} {
  const byName = new Map(members.map(member => [member.agent, member]));
  const tally = new Map<string, Candidate>();
  let ballots = 0;
  for (const message of messages) {
    if (message.kind !== 'discuss') continue;
    const match = NOMINATE.exec(message.text);
    if (!match) continue;
    // 整句含否定或征询词就不算票：「我不同意推举 X」和「要不要推举 X」
    // 都不是支持，把它们算成票等于系统替发言人表了态。
    if (NOT_A_BALLOT.test(message.text)) continue;
    const wanted = match[1].trim();
    // 精确名优先，其次唯一前缀匹配；多个可能就丢弃这张票，不猜。
    let target = byName.get(wanted);
    if (!target) {
      const hits = members.filter(member => member.agent.startsWith(wanted) || wanted.startsWith(member.agent));
      if (hits.length === 1) target = hits[0];
    }
    if (!target) continue;
    // 不能推举自己：那不是协调，是自封。
    if (target.taskId === message.taskId) continue;
    ballots++;
    const existing = tally.get(target.taskId) || { taskId: target.taskId, agent: target.agent, votes: 0 };
    existing.votes++;
    tally.set(target.taskId, existing);
  }
  const candidates = [...tally.values()].sort((a, b) => b.votes - a.votes);
  if (!candidates.length) return { candidates: [], tied: false, ballots };
  const top = candidates[0].votes;
  const leaders = candidates.filter(candidate => candidate.votes === top);
  return { candidates, tied: leaders.length > 1, ...(leaders.length === 1 ? { winner: leaders[0] } : {}), ballots };
}

/**
 * 能否得出结果。
 *
 * 三个条件缺一不可：参与人数够、有实际选票、没有平票。
 * 缺任何一个都返回"需要人定"——自主推举的意义是省事，不是替人做决定。
 */
export function electionOutcome(result: ReturnType<typeof tallyElection>, electorate: number): { decided: boolean; reason: string } {
  if (electorate < MIN_ELECTORATE) return { decided: false, reason: `组内只有 ${electorate} 人，无需推举` };
  if (!result.ballots) return { decided: false, reason: '组内还没有推举表态' };
  if (result.tied) return { decided: false, reason: `平票（${result.candidates[0]?.votes} 票）：由人类裁定` };
  if (!result.winner) return { decided: false, reason: '没有明确领先者' };
  return { decided: true, reason: `${result.winner.agent} 以 ${result.winner.votes} 票领先` };
}

/**
 * 协调者的职责说明：注入给被推举者的任务提示。
 *
 * 明确"你仍然只是代表之一"——否则被推举者容易把自己当成上级，
 * 开始代替别人下判断。协调是让信息流动，不是替人做结论。
 */
export function coordinatorBrief(agent: string, groupId: string, members: readonly string[]): string {
  return [
    `## 组内协调职责（${groupId}）`,
    '',
    `同组代表推举了「${agent}」在本次协作中牵头。成员：${members.join('、')}。`,
    '',
    '你要做的：',
    '- 汇总组内已发出的状态，指出哪些部分可能重复、哪些还没人认领。',
    '- 组内出现分歧时把双方依据并列出来，不要替他们裁定——结论必须各自独立形成。',
    '',
    '你不做的：',
    '- 你不是上级：不能给别人派任务、不能改别人的结论、不能代替别人判断。',
    '- 不要要求组员汇报思考过程，只需状态与证据。',
  ].join('\n');
}
