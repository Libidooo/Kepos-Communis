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

/**
 * 白名单来自 config.cliAllowlist（人类决定，总理可增删），不再写死在源码里。
 * 这里只保留一个用于提示的内置推荐清单——真正是否允许由配置决定。
 */
export const SUGGESTED_CLIS: Readonly<Record<string, string>> = {
  codex: 'OpenAI Codex 命令行',
  claude: 'Anthropic Claude Code 命令行',
  gemini: 'Google Gemini 命令行',
};

/** 从配置里取白名单键名。配置为空时返回空数组——不内置任何默认权限。 */
export function allowlistedClis(allowlist: Readonly<Record<string, unknown>> | undefined): string[] {
  return Object.keys(allowlist || {}).map(name => name.toLowerCase()).sort();
}

/** 校验一个名字是否在配置的白名单里。 */
export function cliAllowed(name: unknown, allowlist: Readonly<Record<string, unknown>> | undefined): string | null {
  const value = String(name ?? '').trim().toLowerCase();
  if (!value) return null;
  const keys = allowlistedClis(allowlist);
  return keys.includes(value) ? value : null;
}

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

/** 只接受配置白名单内的可执行名。 */
export function normalizeCli(name: unknown, allowlist: Readonly<Record<string, unknown>> | undefined): string | null {
  return cliAllowed(name, allowlist);
}

/** 申请是否成立：必须指名配置白名单内的 CLI，并说明理由。 */
export function validateCliRequest(input: { cli?: unknown; reason?: unknown; allowlist?: Readonly<Record<string, unknown>> }): { ok: true; cli: string; reason: string } | { ok: false; reason: string } {
  const cli = normalizeCli(input.cli, input.allowlist);
  if (!cli) {
    const known = allowlistedClis(input.allowlist);
    return { ok: false, reason: known.length ? `只允许配置白名单内的外部 CLI：${known.join(' / ')}` : '白名单为空：请先在设置里添加允许的 CLI' };
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


/** 人类审批时看到的一行说明。 */
export function describeCliGrant(grant: CliGrant): string {
  const description = SUGGESTED_CLIS[grant.cli];
  const target = description ? `${grant.cli}（${description}）` : grant.cli;
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
export function cliAvailable(name: string, allowlist: Readonly<Record<string, unknown>> | undefined, which: (cmd: string) => string | null): boolean {
  const cli = normalizeCli(name, allowlist);
  if (!cli) return false;
  return Boolean(which(cli));
}
