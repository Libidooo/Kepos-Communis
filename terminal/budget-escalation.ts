// 预算截停的立案与审批链。
//
// 截停曾经只做一半：任务终止、给人一行警告，然后没有人管——
// 派单的总理不知道它的委派已经死了；"待处理"计数按构造排除终态任务，
// 恒为零；等待区声称的"F2 调预算重派"没有任何实现。
// 人看到的是一直报错、没人处理、也没有可批准的东西。
//
// 这条链补齐剩下的一半（人类的裁定：截停回传上级，最终总理呈报、人类审批；
// 直派任务与僚属同一逻辑）：
//   系统立案（不依赖模型行为）→ 回传上级（总理 steer；僚属另通知直属代表）
//   → 总理可用 kepos_budget 附额度评估 → 人类在 F2 批准并按新额度重派，或拒绝。
// 人类批准是唯一放行：加预算就是花钱，代理审批模式也不自动重派。
import type { KeposDatabase } from './database.ts';

/** 人类可见的一条立案。 */
export type BudgetEscalation = {
  id: string;
  at: number;
  taskId: string;
  parentSessionId: string;
  agent: string;
  agentId?: string;
  task: string;
  spent: number;
  cap: number;
  digest?: string;
  proposal?: number;
  proposedBy: 'system' | 'premier';
  note?: string;
  state: 'pending' | 'approved' | 'denied' | 'dispatched';
  decidedAt?: number;
};

/** 僚属派生请求的任务文本截到 600 字；立案沿用同一口径。 */
export const MAX_ESCALATION_TASK_CHARS = 600;
/** 检查点摘要进指令的长度：够读出思路，不至于把指令撑成账单。 */
export const MAX_ESCALATION_DIGEST_CHARS = 600;

const truncate = (value: string, max: number) => {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
};

/** 这类截停要不要立案：watch 自动派发没有上游意图，桌面通知已经覆盖它；
 *  内部任务（配置生成/记忆整理）不是人的委派，截停了换条路走即可——
 *  为它们立案会把人类拖进"批准→重派→再截停"的循环。 */
export function shouldEscalate(task: { purpose?: string }): boolean {
  return task.purpose !== 'watch' && task.purpose !== 'configuration';
}

/**
 * 给总理的呈报。它掌握全局目标，最有资格估额度；
 * 但批准权在人类——这段文字本身就是纪律：未批不得重派、不得声称已批。
 */
export function budgetStopReport(input: {
  escalationId: string; agent: string; taskId: string; spent: number; cap: number;
  title: string; digest?: string; owner?: string;
}): string {
  return [
    `## 预算截停（已立案 · 等待人类审批）`,
    `任务 ${input.agent}（${input.taskId}）到达 token 预算上限被截停：已耗 ${input.spent} / 上限 ${input.cap}。证据已保留。`,
    input.owner ? `它是「${input.owner}」的僚属，直属代表已被要求评估。` : '',
    `原任务：${truncate(input.title, 200)}`,
    input.digest ? `前次要点：${truncate(input.digest, 300)}` : '',
    `请用 kepos_budget(action='propose', escalationId='${input.escalationId}', suggestedTokens=…) 附上你的额度评估——估计要从宽：议会角色提示词本身已有数千 token。严格模式下人类会在 F2 → 预算追加审批 里决定；代理模式下你的建议（不超过单任务默认 2M 时）会自动生效并按新额度重派，留痕可查，超出该上限才呈报人类。在此之前不要重派该任务，也不要声称人类已批准。`,
  ].filter(Boolean).join('\n');
}

/** 给直属代表的 steer：僚属被截停，它对僚属负责，但重派与否由人类审批决定。 */
export function ownerSteerText(input: { agent: string; taskId: string; spent: number; cap: number }): string {
  return [
    `## 你的僚属被预算截停（已立案 · 等待人类审批）`,
    `僚属 ${input.agent}（${input.taskId}）到达 token 上限：已耗 ${input.spent} / ${input.cap}。证据已保留，系统已立案呈报人类。`,
    `你可以在产出中给出额度评估和是否值得继续的判断，供审批参考；不要自行重派同一任务——人类批准后系统会按新额度重派并挂回你名下。`,
  ].join('\n');
}

/** 批准后的重派指令：续接前次，不是重开一轮。 */
export function redispatchInstruction(input: {
  taskId: string; agent: string; spent: number; cap: number; newCap: number;
  title: string; digest?: string;
}): string {
  return [
    `前次任务（${input.taskId}）到达 token 预算被截停（已耗 ${input.spent} / 上限 ${input.cap}）。人类已批准追加预算至 ${input.newCap} tokens，请继续完成原任务，注意控制消耗：`,
    ``,
    input.title,
    ...(input.digest ? [``, `前次过程要点（供续接，不要从头再来）：`, input.digest] : []),
  ].join('\n');
}

/** 立案的落库。同一任务只立一案——重复截停不该把队列刷屏。 */
export class BudgetEscalations {
  constructor(private readonly database: KeposDatabase) {}

  /** 返回立案 id；该任务已有 pending 案时返回既有 id，不重复立案。 */
  raise(input: {
    taskId: string; parentSessionId: string; agent: string; agentId?: string;
    task: string; spent: number; cap: number; digest?: string; at?: number;
  }): string {
    const existing = this.database.prepare("SELECT id FROM budget_escalations WHERE task_id=? AND state='pending' LIMIT 1")
      .get(input.taskId) as { id?: string } | undefined;
    if (existing?.id) return String(existing.id);
    const id = `be_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.database.prepare(
      'INSERT INTO budget_escalations(id,at,task_id,parent_session,agent,agent_id,task,spent,cap,digest,state,proposed_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(id, input.at ?? Date.now(), input.taskId, input.parentSessionId, input.agent, input.agentId ?? null,
      truncate(input.task, MAX_ESCALATION_TASK_CHARS), input.spent, input.cap, input.digest ?? null, 'pending', 'system');
    return id;
  }

  pending(limit = 20): BudgetEscalation[] {
    const rows = this.database.prepare("SELECT * FROM budget_escalations WHERE state='pending' ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(Math.max(1, Math.min(100, limit))) as any[];
    return rows.map(row => this.hydrate(row));
  }

  /** 总理附评估：只对 pending 案有效，覆盖上一次评估。 */
  propose(id: string, suggestedTokens: number, note?: string): boolean {
    if (!Number.isInteger(suggestedTokens) || suggestedTokens < 1000) return false;
    const row = this.database.prepare("SELECT 1 FROM budget_escalations WHERE id=? AND state='pending'").get(id);
    if (!row) return false;
    this.database.prepare("UPDATE budget_escalations SET proposal=?, proposed_by='premier', note=? WHERE id=?")
      .run(suggestedTokens, note ?? null, id);
    return true;
  }

  decide(id: string, approved: boolean): boolean {
    const state = approved ? 'approved' : 'denied';
    const result = this.database.prepare("UPDATE budget_escalations SET state=?, decided_at=? WHERE id=? AND state='pending'")
      .run(state, Date.now(), id);
    return Number(result.changes ?? 0) > 0;
  }

  /** 取一案的完整记录（代理审批自动重派要用到任务字段）。 */
  byId(id: string): BudgetEscalation | undefined {
    const row = this.database.prepare('SELECT * FROM budget_escalations WHERE id=?').get(id) as any;
    return row ? this.hydrate(row) : undefined;
  }

  /** 一案的去向：propose 打到已决案时，总理该知道它去了哪，而不是"不存在"。 */
  stateOf(id: string): { state: string; decidedAt?: number } | undefined {
    const row = this.database.prepare('SELECT state, decided_at FROM budget_escalations WHERE id=?').get(id) as any;
    return row ? { state: String(row.state), ...(row.decided_at ? { decidedAt: Number(row.decided_at) } : {}) } : undefined;
  }

  /** 重派成功后才标记：launch 失败时人类的批准不蒸发，案件还在队列里。 */
  markDispatched(id: string): boolean {
    const result = this.database.prepare("UPDATE budget_escalations SET state='dispatched' WHERE id=? AND state='approved'")
      .run(id);
    return Number(result.changes ?? 0) > 0;
  }

  private hydrate(row: any): BudgetEscalation {
    return {
      id: String(row.id), at: Number(row.at), taskId: String(row.task_id),
      parentSessionId: String(row.parent_session ?? ''), agent: String(row.agent),
      agentId: row.agent_id ? String(row.agent_id) : undefined, task: String(row.task ?? ''),
      spent: Number(row.spent ?? 0), cap: Number(row.cap ?? 0),
      digest: row.digest ? String(row.digest) : undefined,
      proposal: row.proposal !== null && row.proposal !== undefined ? Number(row.proposal) : undefined,
      proposedBy: row.proposed_by === 'premier' ? 'premier' : 'system',
      note: row.note ? String(row.note) : undefined,
      state: row.state, decidedAt: row.decided_at ? Number(row.decided_at) : undefined,
    };
  }
}
