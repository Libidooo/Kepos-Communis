// 任务级权限：代表不再只是只读。
//
// 职责链（人类 → 总理 → 代理总代 → 代表 → 僚属）：
//   1. 代表默认只读。
//   2. 代表需要写权限时，向代理总代申请，代理总代转呈总理，总理呈报人类批准。
//   3. 批准后该权限绑定在**这一次任务的进程**上：任务结束即失效，不跨任务保留。
//   4. 持有权限的代表可以把**自己持有的子集**转授给它的僚属——不能授出自己没有的。
//
// 三条硬约束：
//   - 不可扩大：转授的工具集必须是自身权限的子集。
//   - 不可跨任务：授权记录挂在 taskId 上，任务终态即视为失效。
//   - 不可跨代表：僚属只认自己直属代表，不能向别的代表申请或借用。
import { MUTATING_TOOLS } from './approval.ts';

export type GrantState = 'requested' | 'approved' | 'rejected' | 'expired';

/** 一次权限申请。审批链上每一环留痕，人类批准是最后一环。 */
export type GrantRequest = {
  id: string;
  /** 申请者：代表的任务 id。 */
  taskId: string;
  /** 申请者显示名，用于人类审批时辨认。 */
  agent: string;
  /** 申请的写权限工具。只接受 MUTATING_TOOLS 中的名字。 */
  tools: string[];
  /** 申请理由：要改什么、为什么必须写。 */
  reason: string;
  state: GrantState;
  requestedAt: number;
  /** 代理总代转呈时间。 */
  escalatedAt?: number;
  /** 总理批准时间（人类确认后）。 */
  approvedAt?: number;
  /** 人类是否明确确认过。strict 模式下这是必要条件。 */
  humanConfirmed?: boolean;
  rejectedReason?: string;
  expiresAt?: number;
};

export type GrantDecision =
  | { state: 'approved'; tools: string[] }
  | { state: 'rejected'; reason: string };

/** 只接受真实的写工具名，防止用拼写变体绕过。 */
export function normalizeRequestedTools(requested: unknown): string[] {
  const list = Array.isArray(requested) ? requested : [];
  const valid = list
    .map(name => String(name).trim().toLowerCase())
    .filter(name => (MUTATING_TOOLS as readonly string[]).includes(name));
  return [...new Set(valid)];
}

/**
 * 校验一次权限申请是否成立。返回拒绝原因或规范化的工具集。
 * 空申请、含未知工具名、缺理由都不成立——宁可拒绝也不猜。
 */
export function validateGrantRequest(input: { tools?: unknown; reason?: unknown }): { ok: true; tools: string[]; reason: string } | { ok: false; reason: string } {
  const tools = normalizeRequestedTools(input.tools);
  if (!tools.length) return { ok: false, reason: `未申请任何有效写权限；可用：${MUTATING_TOOLS.join(' / ')}` };
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, reason: '权限申请必须说明理由：要改什么、为什么必须写' };
  if (reason.length > 500) return { ok: false, reason: '理由过长（上限 500 字符）' };
  return { ok: true, tools, reason };
}

/**
 * 转授校验：代表只能把**自己持有的子集**给僚属。
 * 这是防止权限在层级间被放大的关键——僚属永远不可能比它的直属代表权限更大。
 */
export function canDelegate(granted: readonly string[], requested: readonly string[]): { ok: true; tools: string[] } | { ok: false; reason: string } {
  const wanted = normalizeRequestedTools(requested);
  if (!wanted.length) return { ok: false, reason: '未指定要转授的权限' };
  const missing = wanted.filter(tool => !granted.includes(tool));
  if (missing.length) {
    return { ok: false, reason: `不能转授自身没有的权限：${missing.join(', ')}。代表当前持有：${granted.length ? granted.join(', ') : '无'}` };
  }
  return { ok: true, tools: wanted };
}

/** 授权是否仍然有效：必须已批准，且所属任务还没结束。 */
export function grantActive(grant: GrantRequest | undefined, taskEnded: boolean, now = Date.now()): boolean {
  if (!grant || grant.state !== 'approved') return false;
  if (taskEnded) return false;
  if (grant.expiresAt !== undefined && now >= grant.expiresAt) return false;
  return true;
}

/** 人类审批时必须看到的一句话，避免在没读懂的情况下点同意。 */
export function describeForHuman(grant: GrantRequest): string {
  const tools = grant.tools.join(' / ');
  const chain = grant.escalatedAt ? '代理总代已转呈' : '待代理总代转呈';
  const confirmed = grant.humanConfirmed === false ? ' · 尚未经人类确认' : '';
  return `${grant.agent} 申请写权限：${tools}\n理由：${grant.reason}\n${chain}${confirmed}`;
}
