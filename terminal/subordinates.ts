// 派生僚属的上限与审批门槛。
//
// 代表能派生僚属（0.4 起），但"能派生"不等于"可以无限派生"。
// 三件事必须由代码保证，不能靠提示词：
//
//   1. 硬上限。一个代表同时带的僚属数量有天花板，
//      否则一次误判能长出一棵几个层级的树。
//   2. 审批门槛。超过三名要人类点头——三个人是一支小队，
//      四个以上代表已经不再是"帮自己看一眼"，而是在另开一条工作线。
//   3. 一层到底。僚属不能再派生。这条在 worker pool 里由 delegationDepth 强制，
//      这里只负责把理由写清楚，避免两个地方各说一套。
import type { KeposDatabase } from './database.ts';

/** 同时存活的僚属上限。超过就不是委派，是另起炉灶。 */
export const MAX_SUBORDINATES_PER_REPRESENTATIVE = 6;
/** 超过这个数需要人类批准——三支子任务还能一个人看住，再多就看不住了。 */
export const SUBORDINATE_APPROVAL_THRESHOLD = 3;

export type SubordinateGate = {
  /** 是否可以不经审批直接派生。 */
  allowed: boolean;
  /** 需要人类审批时非空，说的是"为什么要问人"。 */
  approvalRequired: boolean;
  reason: string;
  /** 当前该代表名下存活的僚属数。 */
  live: number;
};

/**
 * 判断某个代表此刻能否再派生一个僚属。
 *
 * `live` 只数**未结束**的僚属：已经跑完的不占并发，也不占注意力。
 * 这也是为什么门槛按"同时"而不是"累计"计算——累计超过三名很正常，
 * 同时带四个才是需要看一眼的事。
 */
export function subordinateGate(database: KeposDatabase, parentTaskId: string): SubordinateGate {
  const row = database.prepare(
    `SELECT COUNT(*) AS n FROM workers
     WHERE receipt IS NULL
       AND json_extract(task,'$.parentWorkerId')=?`,
  ).get(parentTaskId) as any;
  const live = Number(row?.n ?? 0);
  if (live >= MAX_SUBORDINATES_PER_REPRESENTATIVE) {
    return { allowed: false, approvalRequired: false, live, reason: `同时最多 ${MAX_SUBORDINATES_PER_REPRESENTATIVE} 个僚属；请等现有任务结束后再派` };
  }
  // 已有 3 个时再派就是第 4 个，落在审批线之后。
  if (live >= SUBORDINATE_APPROVAL_THRESHOLD) {
    return { allowed: true, approvalRequired: true, live, reason: `该代表已有 ${live} 个僚属在跑，再派生第 ${live + 1} 个需要人类批准` };
  }
  return { allowed: true, approvalRequired: false, live, reason: '' };
}

/**
 * 人类对"再派生一个"的决定，落库以便回溯。
 *
 * 不批准也要留一条：否则同一个请求会每分钟重试一次，
 * 而人看到的是"它一直想派，但什么也没发生"。
 */
export type SubordinateApproval = {
  id: string;
  at: number;
  parentTaskId: string;
  /** 代表名，界面显示用。 */
  agent: string;
  /** 请求派生的任务描述，供人判断要不要批。 */
  task: string;
  state: 'pending' | 'approved' | 'denied';
  /** 已存活僚属数，记录当时的状态。 */
  live: number;
};

export class SubordinateApprovals {
  constructor(private readonly database: KeposDatabase) {}

  /** 发起一个待批请求。同一代表同一时刻只保留一条待批。 */
  request(input: { parentTaskId: string; agent: string; task: string; live: number; at?: number }): SubordinateApproval | undefined {
    const existing = this.database.prepare("SELECT id FROM subordinate_approvals WHERE parent_task_id=? AND state='pending'").get(input.parentTaskId) as any;
    if (existing) return undefined;                 // 已有待批，不重复排队
    const record: SubordinateApproval = {
      id: `sa_${input.at ?? Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      at: input.at ?? Date.now(),
      parentTaskId: input.parentTaskId,
      agent: input.agent,
      task: String(input.task).slice(0, 600),
      state: 'pending',
      live: input.live,
    };
    this.database.prepare('INSERT INTO subordinate_approvals(id,at,parent_task_id,agent,task,state,live) VALUES(?,?,?,?,?,?,?)')
      .run(record.id, record.at, record.parentTaskId, record.agent, record.task, record.state, record.live);
    return record;
  }

  /** 人作出决定。返回更新后的记录，找不到时 undefined。 */
  decide(id: string, approved: boolean): SubordinateApproval | undefined {
    const row = this.database.prepare('SELECT * FROM subordinate_approvals WHERE id=?').get(id) as any;
    if (!row || row.state !== 'pending') return undefined;
    this.database.prepare('UPDATE subordinate_approvals SET state=? WHERE id=?').run(approved ? 'approved' : 'denied', id);
    return this.toRecord({ ...row, state: approved ? 'approved' : 'denied' });
  }

  /** 该代表是否有一条已批准、尚未消费的请求。 */
  approved(parentTaskId: string): SubordinateApproval | undefined {
    const row = this.database.prepare("SELECT * FROM subordinate_approvals WHERE parent_task_id=? AND state='approved' ORDER BY at LIMIT 1").get(parentTaskId) as any;
    return row ? this.toRecord(row) : undefined;
  }

  /** 消费掉一条批准：一个批准只放行一次派生。 */
  consume(id: string): void {
    this.database.prepare("UPDATE subordinate_approvals SET state='consumed' WHERE id=?").run(id);
  }

  pending(limit = 20): SubordinateApproval[] {
    const rows = this.database.prepare("SELECT * FROM subordinate_approvals WHERE state='pending' ORDER BY at LIMIT ?").all(limit) as any[];
    return rows.map(row => this.toRecord(row));
  }

  /** 某任务的全部请求，任务详情里要能看到"它想派人但被拦过"。 */
  forTask(parentTaskId: string): SubordinateApproval[] {
    const rows = this.database.prepare('SELECT * FROM subordinate_approvals WHERE parent_task_id=? ORDER BY at DESC').all(parentTaskId) as any[];
    return rows.map(row => this.toRecord(row));
  }

  private toRecord(row: any): SubordinateApproval {
    return { id: row.id, at: Number(row.at), parentTaskId: row.parent_task_id, agent: row.agent, task: row.task, state: row.state, live: Number(row.live) };
  }
}

/**
 * 派生请求的处理结论。
 *
 * 三种结果必须分清，因为代表对它们的反应不同：
 *   spawn   —— 直接派
 *   approve —— 已提交人类审批，这次不派（代表不该重试）
 *   refuse  —— 连审批都不必提，硬上限或层级限制
 */
export type SpawnDecision =
  | { action: 'spawn'; approvalId?: string }
  | { action: 'approve'; reason: string }
  | { action: 'refuse'; reason: string };

/** 结合上限、审批门槛与已批记录，决定这次派生请求怎么处理。 */
export function decideSpawn(database: KeposDatabase, parentTaskId: string, request: { agent: string; task: string }): SpawnDecision {
  const gate = subordinateGate(database, parentTaskId);
  if (!gate.allowed) return { action: 'refuse', reason: gate.reason };
  if (!gate.approvalRequired) return { action: 'spawn' };
  const approvals = new SubordinateApprovals(database);
  // 已批准未消费的批准直接可用——否则人批了之后还要再等一次轮询。
  const granted = approvals.approved(parentTaskId);
  if (granted) return { action: 'spawn', approvalId: granted.id };
  const created = approvals.request({ parentTaskId, agent: request.agent, task: request.task, live: gate.live });
  return { action: 'approve', reason: created ? gate.reason : `${gate.reason}（已有待批请求，请先处理）` };
}
