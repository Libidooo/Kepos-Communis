// 临时借调：跨组协作唯一被允许的路径。
//
// 规则（人类裁定）：
//   - 跨项目协作**只能**通过代理总代对接。普通代表不能自己去别的组拉人。
//   - 代理总代可以把另一个小组的成员临时加入自己组，用完再放回并收回权限。
//   - 这个操作需要总理评估批准，但**静默进行**——不经人类授意。
//
// 为什么静默是安全的：借调不产生新的权限，只是把一个人**已经有的**能力
// 临时借到另一个组。它不扩权、不新建席位、不改变模型与职责。人类需要亲自决定的
// 是"谁进编制""谁能写文件""谁能开 CLI"，这些借调一样都不碰。
//
// 但静默不等于不可见：每次借调与归还都记入配置，F2 可查，且必须自动到期。
// 一个能永久保持的"临时"借调，就是一次没有经过人类的编制变更。
import { randomUUID } from 'node:crypto';

/** 借调记录：谁从哪个组借来，什么时候必须还。 */
export type Secondment = {
  id: string;
  /** 被借调的代表配置 id。 */
  agentId: string;
  /** 代表名，便于显示（id 才是权威）。 */
  agent: string;
  /** 原本所属的组（来源）。 */
  fromGroup: string;
  /** 临时加入的组（目标）。 */
  toGroup: string;
  /** 借调原因：一句话说清为什么这次协作需要它。 */
  reason: string;
  /** 发起人：代理总代的任务 id 或名字。 */
  requestedBy: string;
  /** 总理批准时间。 */
  approvedAt: number;
  /** 到期时间：过了就自动失效，不需要人记得。 */
  expiresAt: number;
};

/** 借调默认时长：一小时内完成一次跨组协作绰绰有余，再长就该重新评估。 */
export const SECONDMENT_SECONDS = 3600;
/** 单组同时借调人数上限：借调是补充，不是把整组搬过来。 */
export const MAX_SECONDMENTS_PER_GROUP = 3;

/**
 * 借调是否仍然有效。
 *
 * 到期即失效，且这不是建议——读取方必须用它判断，而不是相信记录本身。
 * 一个"临时"权限如果靠人记得收回，它迟早会变成永久的。
 */
export function secondmentActive(secondment: Secondment | undefined, now = Date.now()): { active: boolean; reason: string } {
  if (!secondment) return { active: false, reason: '没有借调记录' };
  if (now >= secondment.expiresAt) return { active: false, reason: '借调已到期' };
  if (secondment.fromGroup === secondment.toGroup) return { active: false, reason: '借调与目标组相同' };
  return { active: true, reason: '' };
}

/**
 * 谁能发起借调。
 *
 * 只有代理总代。普通代表不能自己跨组拉人——那会绕开治理链，
 * 变成"谁需要谁自己借"，而没有人对全局的编制状态负责。
 *
 * 判定看的是执行者身份而不是任务 id：调用方手里有"这个任务由谁执行"，
 * 却未必持有代理总代的任务 id（它可能还没被派发）。
 */
export function canRequestSecondment(input: { requesterAgent?: string; deputyAgent?: string }): { allowed: boolean; reason: string } {
  if (!input.deputyAgent) return { allowed: false, reason: '没有在任的代理总代，跨组协作无处对接' };
  if (input.requesterAgent !== input.deputyAgent) return { allowed: false, reason: '只有代理总代可以发起跨组借调' };
  return { allowed: true, reason: '' };
}

/**
 * 借调申请的校验。
 *
 * 拒绝的四种情况都是"这件事根本不该发生"，而不是"参数写错了"：
 * 借自己被借、借到同一个组、组已满员、没有说明原因。
 */
export function validateSecondment(input: {
  agentId?: string;
  fromGroup?: string;
  toGroup?: string;
  reason?: string;
  existing: readonly Secondment[];
  /** 已在目标组里的人，避免重复借调同一个。 */
  alreadyInGroup?: boolean;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const from = String(input.fromGroup ?? '').trim();
  const to = String(input.toGroup ?? '').trim();
  const reason = String(input.reason ?? '').trim();
  // 借调按配置 id 记录，缺 id 的代表借出去也收不回来——它无处可归。
  if (!input.agentId) return { ok: false, reason: '缺少被借调的代表（该代表没有稳定配置 id，无法借调）' };
  if (!from || !to) return { ok: false, reason: '缺少来源组或目标组' };
  if (from === to) return { ok: false, reason: '来源组与目标组相同，无需借调' };
  if (!reason) return { ok: false, reason: '借调必须说明原因：为什么这次协作需要它' };
  if (input.alreadyInGroup) return { ok: false, reason: '该代表已在目标组中' };
  const now = input.now ?? Date.now();
  const active = input.existing.filter(item => secondmentActive(item, now).active);
  // 同一代表同时只能在一个借调里：两边都要它，等于两边都没有它。
  // 这条要在"按目标组过滤"之前判——否则换个目标组就能绕过去。
  const busy = active.find(item => item.agentId === input.agentId);
  if (busy) return { ok: false, reason: `该代表已在组 ${busy.toGroup} 的借调中` };
  const inTarget = active.filter(item => item.toGroup === to);
  if (inTarget.length >= MAX_SECONDMENTS_PER_GROUP) return { ok: false, reason: `目标组已借调 ${inTarget.length} 人，达到上限 ${MAX_SECONDMENTS_PER_GROUP}` };
  return { ok: true };
}

/** 构造一条借调记录（总理批准之后才调用）。 */
export function createSecondment(input: {
  agentId: string;
  agent: string;
  fromGroup: string;
  toGroup: string;
  reason: string;
  requestedBy: string;
  now?: number;
}): Secondment {
  const now = input.now ?? Date.now();
  return {
    id: `sc_${randomUUID().slice(0, 8)}`,
    agentId: input.agentId,
    agent: input.agent,
    fromGroup: input.fromGroup,
    toGroup: input.toGroup,
    reason: input.reason.trim().slice(0, 200),
    requestedBy: input.requestedBy,
    approvedAt: now,
    expiresAt: now + SECONDMENT_SECONDS * 1000,
  };
}

/** 该代表当下实际属于哪些组：原本的组 + 未到期的借调目标组。 */
export function effectiveGroups(input: { homeGroup?: string; secondments: readonly Secondment[]; agentId: string; now?: number }): string[] {
  const now = input.now ?? Date.now();
  const groups = new Set<string>();
  if (input.homeGroup) groups.add(input.homeGroup);
  for (const item of input.secondments) {
    if (item.agentId !== input.agentId) continue;
    if (!secondmentActive(item, now).active) continue;
    groups.add(item.toGroup);
  }
  return [...groups];
}

/**
 * 到期的借调：调用方据此把它们清理掉。
 *
 * 为什么返回而不是直接删：存储层不该自己决定什么时候写盘，
 * 而且"过期了"这件事本身要能被看见（界面可以说"借调已到期并收回"）。
 */
export function expiredSecondments(items: readonly Secondment[], now = Date.now()): Secondment[] {
  return items.filter(item => !secondmentActive(item, now).active);
}

/** 供总理评估时看的一句话：谁想从哪借谁、为什么、借多久。 */
export function describeSecondmentRequest(input: { agent: string; fromGroup: string; toGroup: string; reason: string; requestedBy: string }): string {
  return [
    `代理总代「${input.requestedBy}」申请跨组借调。`,
    '',
    `· 代表：${input.agent}`,
    `· 从：组 ${input.fromGroup}`,
    `· 到：组 ${input.toGroup}`,
    `· 原因：${input.reason}`,
    `· 时长：${Math.round(SECONDMENT_SECONDS / 60)} 分钟，到期自动收回`,
    '',
    '借调不扩权：被借调者保持原有工具、模型与只读边界，只是临时进入另一个组的通信频道。',
    '批准与否由你（总理）判断，无需上报人类。',
  ].join('\n');
}

/**
 * 借调记录的存储。
 *
 * 只做三件事：记一条、列出仍然有效的、标记归还。
 * 到期判断始终走 secondmentActive，不在这里重复——两处各算一次就会漂移。
 */
export class SecondmentStore {
  constructor(private readonly database: import('./database.ts').KeposDatabase) {}

  /**
   * 记一条借调。只在总理批准后调用。
   *
   * 这里也拒一次重复：校验函数只在调用方跑，而"一人只能有一个生效借调"
   * 是数据本身的约束。少了这道防线，两条记录会同时生效，
   * 于是这个人在两个组里都可见——而 forAgent 只会返回其中一条，另一条成了幽灵。
   */
  add(secondment: Secondment): Secondment {
    const existing = this.forAgent(secondment.agentId, secondment.approvedAt);
    if (existing) throw Error(`该代表已有生效借调（组 ${existing.toGroup}），不能同时加入组 ${secondment.toGroup}`);
    this.database.prepare('INSERT INTO secondments(id,agent_id,agent,from_group,to_group,reason,requested_by,approved_at,expires_at,released_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)')
      .run(secondment.id, secondment.agentId, secondment.agent, secondment.fromGroup, secondment.toGroup, secondment.reason, secondment.requestedBy, secondment.approvedAt, secondment.expiresAt);
    return secondment;
  }

  /** 未到期且未归还的全部借调。 */
  active(now = Date.now()): Secondment[] {
    const rows = this.database.prepare('SELECT id,agent_id,agent,from_group,to_group,reason,requested_by,approved_at,expires_at FROM secondments WHERE released_at IS NULL AND expires_at>? ORDER BY approved_at DESC').all(now) as any[];
    return rows.map(toSecondment);
  }

  /** 某位代表当前有效的借调（最多一条）。 */
  forAgent(agentId: string, now = Date.now()): Secondment | undefined {
    return this.active(now).find(item => item.agentId === agentId);
  }

  /**
   * 归还：标记 released_at，不删除。
   * 删掉的话，"这个人曾经被借到哪个组"就无从回溯了。
   */
  release(id: string, at = Date.now()): boolean {
    const result = this.database.prepare('UPDATE secondments SET released_at=? WHERE id=? AND released_at IS NULL').run(at, id);
    return Number(result.changes) > 0;
  }

  /** 把到期的全部标记归还，返回被收回的那些。 */
  reapExpired(now = Date.now()): Secondment[] {
    const rows = this.database.prepare('SELECT id,agent_id,agent,from_group,to_group,reason,requested_by,approved_at,expires_at FROM secondments WHERE released_at IS NULL AND expires_at<=?').all(now) as any[];
    const expired = rows.map(toSecondment);
    if (expired.length) {
      this.database.transaction(() => {
        for (const item of expired) this.database.prepare('UPDATE secondments SET released_at=? WHERE id=?').run(now, item.id);
      });
    }
    return expired;
  }
}

function toSecondment(row: any): Secondment {
  return {
    id: String(row.id), agentId: String(row.agent_id), agent: String(row.agent),
    fromGroup: String(row.from_group), toGroup: String(row.to_group), reason: String(row.reason),
    requestedBy: String(row.requested_by), approvedAt: Number(row.approved_at), expiresAt: Number(row.expires_at),
  };
}
