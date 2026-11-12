import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { Type } from '@earendil-works/pi-ai';
import { registerWebResearchTools } from './web-research.ts';
import { registerResearchLoop } from './research-loop.ts';
import { registerFileSearchTool } from './file-search.ts';
import { loadAttachment, isAttached, paginateAttachmentText } from './attachments.ts';
import { dataRoot } from './paths.ts';
import { writeAccessDenied } from './grant.ts';

/** Where a worker's read tools may look. 'project' confines to the task directory plus allow-list; 'machine' allows everything except the deny list. */
export type ReadScope = 'project' | 'machine';

export interface SandboxPolicy {
  mode: ReadScope;
  cwd: string;
  allow: string[];
  deny: string[];
  home: string;
  /**
   * deny 的精确例外：落在这些路径内时即使处于 deny 之下也放行。
   *
   * 存在的理由只有一个：**归档是档案馆**。代表需要能读自己和自己僚属的
   * 历史档案，才能知道自己干过什么、遇到什么问题、怎么解决的。
   * 而 deny 是整目录拒绝，所以需要能指名放行特定的归档子目录。
   *
   * 例外只对 deny 生效，不改变 mode='project' 的边界——它不扩大读取范围，
   * 只是把一个被 deny 覆盖、但按设计应当可读的位置还原回来。
   * 凭据位置的拒绝不受此影响：那条检查在 deny 之前，且永远生效。
   */
  allowWithinDeny?: string[];
}

// Always refused, project or not: credential stores and dotfile secrets.
const CREDENTIAL_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.gcloud'];
// Refused outside the task directory: provider auth files look like source when a repo has its own.
const CREDENTIAL_BASENAMES = ['auth.json', 'credentials', 'id_rsa', '.env'];

// macOS 上 /tmp 与 /var 是指向 /private/* 的符号链接，只用 resolve() 规范化会让
// 同一目录出现两种写法，包含判断随即失效（沙箱把合法路径当越界）。
// 这里按 realpath 归一；目标尚不存在时，逐级向上找到最近的已存在祖先，
// 把剩下的相对段拼回去——只回退一层不够，测试与真实场景都可能有深层的不存在路径。
function canonical(target: string): string {
  const resolved = resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    const tail: string[] = [];
    let cursor = resolved;
    for (let depth = 0; depth < 64; depth++) {
      const parent = dirname(cursor);
      if (parent === cursor) break;              // 已到根
      tail.unshift(basename(cursor));
      cursor = parent;
      try {
        return join(realpathSync(cursor), ...tail);
      } catch { /* 继续向上 */ }
    }
    return resolved;
  }
}

function inside(target: string, base: string): boolean {
  const rel = relative(canonical(base), canonical(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The reason read/grep/find/ls must refuse this target, or null when allowed. Pure and testable. */
export function readDenied(rawTarget: string, policy: SandboxPolicy): string | null {
  const raw = String(rawTarget || '.');
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? resolve(policy.home, raw.slice(1).replace(/^[\\/]/, '')) : resolve(raw);
  // 凭据段用原文切分（大小写无关），但包含判断必须交原始路径给 inside()：
  // macOS 的 /var/folders/... 含大小写混合的随机段，lowercase 之后再 realpath
  // 会与真实路径永远对不上，合法文件被误判越界。Windows 的大小写差异由 inside
  // 内部的 realpath 归一处理，不需要提前降格。
  const segments = expanded.split(/[\\/]/).map(segment => segment.toLowerCase());
  if (CREDENTIAL_SEGMENTS.some(segment => segments.includes(segment))) return `拒绝访问凭据位置（子 Agent 不可读）：${raw}`;
  // 档案例外先判：它只还原"本应可读但被整目录 deny 覆盖"的位置。
  const exempt = (policy.allowWithinDeny || []).some(allowed => inside(expanded, resolve(allowed)));
  if (!exempt) for (const denied of policy.deny) if (inside(expanded, resolve(denied))) return `拒绝访问 Kepos 数据目录（子 Agent 不可读）：${raw}`;
  if (CREDENTIAL_BASENAMES.includes(segments.at(-1) || '') && inside(expanded, resolve(policy.home)) && !inside(expanded, resolve(policy.cwd))) {
    return `拒绝访问凭据文件（子 Agent 不可读）：${raw}`;
  }
  if (policy.mode === 'machine') return null;
  if (inside(expanded, resolve(policy.cwd))) return null;
  for (const allowed of policy.allow) if (inside(expanded, resolve(allowed))) return null;
  return `只读范围限定在任务目录${policy.allow.length ? '与白名单目录' : ''}，不包含：${raw}。需要其他资料时请在分派时声明 readScope 或 readAllow。`;
}

/** Sandbox config travels via environment variables: Pi's CLI rejects unknown options. */
export function sandboxEnv(policy: { mode: ReadScope; allow: string[]; deny: string[]; allowWithinDeny?: string[] }): Record<string, string> {
  return {
    KEPOS_READ_SCOPE: policy.mode,
    KEPOS_READ_ALLOW: policy.allow.join(','),
    KEPOS_DENY: policy.deny.join(','),
    ...(policy.allowWithinDeny?.length ? { KEPOS_ALLOW_WITHIN_DENY: policy.allowWithinDeny.join(',') } : {}),
  };
}

export function envPolicy(env: NodeJS.ProcessEnv, cwd: string): SandboxPolicy {
  const list = (value: string | undefined) => (value || '').split(',').map(item => item.trim()).filter(Boolean);
  return {
    mode: env.KEPOS_READ_SCOPE === 'machine' ? 'machine' : 'project',
    cwd, home: homedir(),
    allow: list(env.KEPOS_READ_ALLOW),
    deny: list(env.KEPOS_DENY),
    allowWithinDeny: list(env.KEPOS_ALLOW_WITHIN_DENY),
  };
}

/** Pi extension loaded inside worker processes: guard the read tools' targets. */
export default function workerSandbox(pi: any) {
  const policy = envPolicy(process.env, process.cwd());
  registerWebResearchTools(pi);
  if (process.env.KEPOS_DISABLE_RESEARCH_LOOP !== '1') registerResearchLoop(pi);
  registerFileSearchTool(pi, policy, path => readDenied(path, policy));
  pi.registerTool({
    name: 'kepos_attach', label: '读取附件',
    description: '读取已授权范围内的本地文件并提取文档或文本内容。文件名请先用 kepos_find_file 定位；拒绝凭据文件和 Kepos 数据。',
    parameters: Type.Object({
      paths: Type.Array(Type.String({ maxLength: 1000 }), { minItems: 1, maxItems: 8 }),
      cursor: Type.Optional(Type.Integer({ minimum: 0 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 120000 })),
    }),
    async execute(_id: string, params: any) {
      const results: any[] = [];
      for (const path of params.paths) {
        const loaded = await loadAttachment(path, { cwd: process.cwd(), policy, deny: [dataRoot] });
        if (!isAttached(loaded)) { results.push({ ok: false, path, reason: loaded.reason }); continue; }
        const page = loaded.attachment.kind === 'image' ? null : paginateAttachmentText(loaded.attachment.text || '', params.cursor ?? 0, params.maxChars ?? 20000);
        results.push({ ok: true, name: loaded.attachment.name, path: loaded.attachment.path, kind: loaded.attachment.kind,
          content: loaded.attachment.kind === 'image' ? `[图片 ${loaded.attachment.name} · 已作为图像附件]` : page!.text,
          ...(page ? { cursor: page.cursor, nextCursor: page.nextCursor, total: page.total, page: page.page, pages: page.pages } : {}) });
      }
      return { content: [{ type: 'text', text: results.map(item => item.ok ? `<file name="${item.name}" kind="${item.kind}">\n${item.content}\n</file>` : `<file-error path="${item.path}">${item.reason}</file-error>`).join('\n\n') }], details: { results } };
    },
  });
  pi.on('tool_call' as any, async (event: any) => {
    const toolName = String(event?.toolName || '');
    // Only representatives receive the edit/write tool definitions at launch. Their
    // task id is a host-injected marker; ordinary subordinate workers stay read-only.
    if (process.env.KEPOS_TASK_ID && ['bash', 'powershell', 'edit', 'write'].includes(toolName)) {
      const reason = writeAccessDenied({ toolName, input: event.input, grantFile: process.env.KEPOS_WRITE_GRANT_FILE, taskId: process.env.KEPOS_TASK_ID });
      if (reason) return { block: true, reason };
    }
    if (!['read', 'grep', 'find', 'ls'].includes(toolName)) return undefined;
    const reason = readDenied(String(event.input?.path || '.'), policy);
    return reason ? { block: true, reason } : undefined;
  });
}
