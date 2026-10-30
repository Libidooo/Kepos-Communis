import { isAbsolute, relative, resolve } from 'node:path';

/** Approval posture for what the main agent may do to Kepos gates and its own data. */
export type ApprovalPolicy = 'human' | 'proxy' | 'readonly';
export const APPROVAL_POLICIES: ApprovalPolicy[] = ['human', 'proxy', 'readonly'];

export function normalizePolicy(value: unknown): ApprovalPolicy {
  return APPROVAL_POLICIES.includes(value as ApprovalPolicy) ? value as ApprovalPolicy : 'human';
}

export const policyLabel: Record<ApprovalPolicy, string> = {
  human: '严格（默认）：门禁和 Kepos 数据只有你能动，模型尝试需你逐次确认',
  proxy: '代理审批：允许模型自主批准门禁、改动 Kepos 数据，全部留痕提示',
  readonly: '只读监督：模型没有 bash/edit/write，只能查看和汇报',
};

export type Risk = 'gate' | 'data';

const WRITE_HINTS = ['rm ', 'rmdir', 'mv ', 'cp ', 'tee ', 'sed -i', 'truncate', 'del ', 'rd ', 'Remove-Item', 'Set-Content', 'Add-Content', 'Out-File', 'New-Item', '>', '>>', 'dd ', 'shred'];

/** Does this shell command try to approve a human gate or mutate Kepos's own store? */
export function commandRisk(command: string): Risk | null {
  const text = String(command || '');
  const lower = text.toLowerCase();
  if (!lower.trim()) return null;
  // 'kepos … approve' within one pipe-free segment; an approve BEFORE 'kepos' (commit
  // messages, grep patterns) or after a pipe is not an approval attempt.
  if (/\bkepos\b[^|;&]*\bapprove\b/.test(lower)) return 'gate';
  if (lower.includes('orbital.sqlite')) return 'data';
  const touchesKeposHome = lower.includes('.kepos') || lower.includes('kepos_home') || lower.includes('orbital_home');
  if (touchesKeposHome && (WRITE_HINTS.some(hint => lower.includes(hint)) || lower.includes('sqlite3'))) return 'data';
  return null;
}

/** Is this file inside the Kepos data directory (config, workspace.json, orbital.sqlite)? */
export function pathRisk(path: string, keposDataRoot: string): Risk | null {
  const candidate = resolve(String(path || ''));
  const base = resolve(keposDataRoot);
  const rel = relative(base, candidate);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return 'data';
  return null;
}

export function riskReason(risk: Risk): string {
  return risk === 'gate'
    ? '人工门禁只能由人类批准：请把待批准的步骤和证据汇报给人类，由人类在 Kepos 界面或终端批准；或由人类将审批模式切换为代理审批（F2 → 审批模式）。'
    : 'Kepos 自身的数据（配置/任务库）不受任务授权：请改为向人类汇报，由人类决定。';
}

/** Tools dropped from the main agent in readonly supervision mode. */
const MUTATING_TOOLS = ['bash', 'powershell', 'edit', 'write'];
export function restrictTools(names: string[]): string[] {
  return names.filter(name => !MUTATING_TOOLS.includes(name));
}
