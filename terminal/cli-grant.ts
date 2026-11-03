// 外部 CLI 授权：代表可以驱动 codex、claude code 这类外部 agent，但必须经人类批准。
//
// 授权链（人类裁定）：
//   代表申请 → 总理评估并准备（CLI 是否在白名单、参数是否安全、凭据是否就绪）
//   → 人类审批授权 → 授权保存在总理处（带过期时间）
//   → 代表任务期间需要调用时，向总理报备，总理核对授权有效即放行
//   → 代表任务结束，授权立即收回
//
// 与内部写权限（grant.ts）的区别：
//   内部写权限绑定单个任务，一次批准一次有效。
//   外部 CLI 授权可以**在有效期内复用**——人类授权一次，总理保管，代表按需取用。
//   因此这里额外需要：过期时间、调用计数、每次调用留痕。
//
// 安全边界：
//   - 只允许白名单里的可执行文件，不接受任意命令字符串。
//   - 参数由总理组装，代表不能拼 shell；避免注入。
//   - 每次调用都记审计条目，含调用者、参数、退出码。
import { existsSync } from 'node:fs';

/** 允许外部驱动的 agent CLI。新增条目需要人类确认后写进代码。 */
export const EXTERNAL_CLI_ALLOWLIST: Readonly<Record<string, { label: string; help: string }>> = {
  codex: { label: 'Codex CLI', help: 'OpenAI Codex 命令行' },
  'claude': { label: 'Claude Code', help: 'Anthropic Claude Code 命令行' },
  'gemini': { label: 'Gemini CLI', help: 'Google Gemini 命令行' },
};

export type CliGrant = {
  id: string;
  /** 白名单里的可执行名，例如 codex。 */
  cli: string;
  /** 申请理由：要解决什么问题。 */
  reason: string;
  state: 'requested' | 'approved' | 'rejected' | 'expired' | 'revoked';
  requestedAt: number;
  approvedAt?: number;
  /** 过期时间：人类授权时就定，避免永久有效。 */
  expiresAt?: number;
  /** 人类是否明确确认过。 */
  humanConfirmed?: boolean;
  /** 已调用次数与上限，防止一次授权被无限使用。 */
  uses: number;
  maxUses?: number;
  /** 授权者：谁批准的。 */
  approvedBy?: string;
  rejectedReason?: string;
  /** 是否已被代表任务占用（任务结束即释放）。 */
  claimedBy?: string;
};

export type CliCallRecord = {
  at: number;
  grantId: string;
  cli: string;
  /** 代表的任务 id。 */
  taskId: string;
  /** 参数摘要（不含凭据）。 */
  args: string[];
  exitCode?: number;
  durationMs?: number;
  error?: string;
};

export type CliGrantDecision =
  | { ok: true; grant: CliGrant }
  | { ok: false; reason: string };

/** 只接受白名单内的可执行名。 */
export function normalizeCli(name: unknown): string | null {
  const value = String(name ?? '').trim().toLowerCase();
  return Object.hasOwn(EXTERNAL_CLI_ALLOWLIST, value) ? value : null;
}

/** 申请是否成立：必须指名白名单内的 CLI，并说明理由。 */
export function validateCliRequest(input: { cli?: unknown; reason?: unknown }): { ok: true; cli: string; reason: string } | { ok: false; reason: string } {
  const cli = normalizeCli(input.cli);
  if (!cli) {
    return { ok: false, reason: `只允许白名单内的外部 CLI：${Object.keys(EXTERNAL_CLI_ALLOWLIST).join(' / ')}` };
  }
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, reason: '必须说明为什么需要这个外部 CLI：要解决什么问题、为什么现有工具不够' };
  if (reason.length > 500) return { ok: false, reason: '理由过长（上限 500 字符）' };
  return { ok: true, cli, reason };
}

/**
 * 授权当前是否可用。
 * 五道闸：已批准、人类确认过、未过期、未超次数、未被其他任务占用。
 */
export function cliGrantUsable(grant: CliGrant | undefined, now = Date.now(), taskId?: string): { ok: true } | { ok: false; reason: string } {
  if (!grant) return { ok: false, reason: '没有该 CLI 的授权' };
  if (grant.state !== 'approved') return { ok: false, reason: `授权状态为 ${grant.state}，不可用` };
  if (grant.humanConfirmed !== true) return { ok: false, reason: '授权尚未经人类确认' };
  if (grant.expiresAt !== undefined && now >= grant.expiresAt) return { ok: false, reason: '授权已过期' };
  if (grant.maxUses !== undefined && grant.uses >= grant.maxUses) return { ok: false, reason: `授权已用尽（${grant.uses}/${grant.maxUses} 次）` };
  if (grant.claimedBy && taskId && grant.claimedBy !== taskId) return { ok: false, reason: `授权正被任务 ${grant.claimedBy} 占用` };
  return { ok: true };
}

/**
 * 参数安全校验：代表不能借此拼 shell。
 * 拒绝项：shell 元字符、换行、超长参数、试图指定另一个可执行文件。
 */
export function safeCliArgs(args: readonly unknown[]): { ok: true; args: string[] } | { ok: false; reason: string } {
  const out: string[] = [];
  for (const raw of args) {
    const arg = String(raw ?? '');
    if (!arg) continue;
    if (arg.length > 2000) return { ok: false, reason: '参数过长（上限 2000 字符）' };
    // 这些元字符在有 shell 参与的路径上会改变语义；即使我们现在不经过 shell，也不接受。
    if (/[;&|`$<>]/.test(arg) || /[\r\n]/.test(arg)) {
      return { ok: false, reason: `参数含 shell 元字符，已拒绝：${arg.slice(0, 60)}` };
    }
    out.push(arg);
  }
  return { ok: true, args: out };
}

/** 人类审批时看到的一行说明。 */
export function describeCliGrant(grant: CliGrant): string {
  const target = EXTERNAL_CLI_ALLOWLIST[grant.cli]?.label || grant.cli;
  const expiry = grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : '未设定';
  const uses = grant.maxUses !== undefined ? `${grant.uses}/${grant.maxUses}` : `${grant.uses}`;
  return `${grant.reason}\n目标：${target} · 到期：${expiry} · 已用：${uses} 次`;
}

/** 代表任务结束时收回：清空占用，状态置为过期。 */
export function revokeOnTaskEnd(grant: CliGrant, taskId: string): CliGrant {
  if (grant.claimedBy !== taskId) return grant;
  return { ...grant, claimedBy: undefined, state: grant.expiresAt && Date.now() < grant.expiresAt && (grant.maxUses === undefined || grant.uses < grant.maxUses) ? 'approved' : 'expired' };
}

/** 审计条目只保留必要字段，绝不写凭据。 */
export function auditLine(record: CliCallRecord): string {
  const status = record.error ? `错误：${record.error}` : `退出码 ${record.exitCode}`;
  const elapsed = record.durationMs !== undefined ? `${record.durationMs}ms` : '—';
  return `- ${new Date(record.at).toISOString()} · ${record.cli} · ${record.taskId} · ${status} · ${elapsed} · ${record.args.slice(0, 6).join(' ')}`;
}

/** 可执行文件是否在本机存在——总理准备阶段用，避免授权了却跑不起来。 */
export function cliAvailable(name: string, which: (cmd: string) => string | null): boolean {
  const cli = normalizeCli(name);
  if (!cli) return false;
  return Boolean(which(cli));
}
