import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

/** Where a worker's read tools may look. 'project' confines to the task directory plus allow-list; 'machine' allows everything except the deny list. */
export type ReadScope = 'project' | 'machine';

export interface SandboxPolicy {
  mode: ReadScope;
  cwd: string;
  allow: string[];
  deny: string[];
  home: string;
}

// Always refused, project or not: credential stores and dotfile secrets.
const CREDENTIAL_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.gcloud'];
// Refused outside the task directory: provider auth files look like source when a repo has its own.
const CREDENTIAL_BASENAMES = ['auth.json', 'credentials', 'id_rsa', '.env'];

function inside(target: string, base: string): boolean {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The reason read/grep/find/ls must refuse this target, or null when allowed. Pure and testable. */
export function readDenied(rawTarget: string, policy: SandboxPolicy): string | null {
  const raw = String(rawTarget || '.');
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? resolve(policy.home, raw.slice(1).replace(/^[\\/]/, '')) : resolve(raw);
  const target = expanded.toLowerCase();
  const segments = expanded.split(/[\\/]/).map(segment => segment.toLowerCase());
  if (CREDENTIAL_SEGMENTS.some(segment => segments.includes(segment))) return `拒绝访问凭据位置（子 Agent 不可读）：${raw}`;
  for (const denied of policy.deny) if (inside(target, resolve(denied).toLowerCase())) return `拒绝访问 Kepos 数据目录（子 Agent 不可读）：${raw}`;
  if (CREDENTIAL_BASENAMES.includes(segments.at(-1) || '') && inside(target, resolve(policy.home).toLowerCase()) && !inside(target, resolve(policy.cwd).toLowerCase())) {
    return `拒绝访问凭据文件（子 Agent 不可读）：${raw}`;
  }
  if (policy.mode === 'machine') return null;
  if (inside(target, resolve(policy.cwd))) return null;
  for (const allowed of policy.allow) if (inside(target, resolve(allowed))) return null;
  return `只读范围限定在任务目录${policy.allow.length ? '与白名单目录' : ''}，不包含：${raw}。需要其他资料时请在分派时声明 readScope 或 readAllow。`;
}

/** Flags the parent passes to the worker so the sandbox extension can rebuild the policy. */
export function sandboxArgs(policy: { mode: ReadScope; allow: string[]; deny: string[] }, sandboxPath: string): string[] {
  return ['-e', sandboxPath, '--kepos-read-scope', policy.mode, '--kepos-read-allow', policy.allow.join(','), '--kepos-deny', policy.deny.join(',')];
}

export function argvPolicy(argv: string[], cwd: string): SandboxPolicy {
  const flag = (name: string) => { const index = argv.indexOf('--' + name); return index >= 0 ? argv[index + 1] : undefined; };
  const list = (value: string | undefined) => (value || '').split(',').map(item => item.trim()).filter(Boolean);
  return { mode: flag('kepos-read-scope') === 'machine' ? 'machine' : 'project', cwd, home: homedir(), allow: list(flag('kepos-read-allow')), deny: list(flag('kepos-deny')) };
}

/** Pi extension loaded inside worker processes: guard the read tools' targets. */
export default function workerSandbox(pi: any) {
  const policy = argvPolicy(process.argv, process.cwd());
  pi.on('tool_call' as any, async (event: any) => {
    if (!['read', 'grep', 'find', 'ls'].includes(String(event?.toolName))) return undefined;
    const reason = readDenied(String(event.input?.path || '.'), policy);
    return reason ? { block: true, reason } : undefined;
  });
}
