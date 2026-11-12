// 任务级权限：代表不再只是只读。
//
// 代表文件写权限默认关闭；宿主评估后才向该任务私有授权快照发放 edit/write。
// 路径必须留在项目内，不能覆盖 Kepos 数据、凭据、归档或 Git 元数据。
// 每次工具调用都重新读取授权快照并校验任务 id、有效期、工具和目标路径。
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
  /** 文件写权限的路径范围；仅允许项目目录内的 edit/write。 */
  paths?: string[];
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

export type ActiveWriteGrant = {
  version: 1;
  id: string;
  taskId: string;
  tools: Array<'edit' | 'write'>;
  paths: string[];
  /** Only these paths grant recursive descendants; all other entries are exact file targets. */
  directoryPaths: string[];
  projectRoot: string;
  protectedPaths: string[];
  issuedAt: number;
  expiresAt: number;
};

export function writeGrantSnapshotPath(dataRoot: string, taskId: string): string {
  const safeId = String(taskId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeId) throw Error('Invalid task id for write grant');
  return join(resolve(dataRoot), 'write-grants', `${safeId}.json`);
}

export function persistActiveWriteGrant(dataRoot: string, grant: ActiveWriteGrant): string {
  const path = writeGrantSnapshotPath(dataRoot, grant.taskId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(grant) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  return path;
}

export function revokeActiveWriteGrant(dataRoot: string, taskId: string): void {
  try { unlinkSync(writeGrantSnapshotPath(dataRoot, taskId)); } catch { /* already absent */ }
}

const FILE_WRITE_TOOLS = ['edit', 'write'] as const;
const ALWAYS_PROTECTED_SEGMENTS = new Set(['.kepos', '.git', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.gcloud']);
const PROTECTED_BASENAMES = new Set(['auth.json', 'credentials', 'id_rsa']);

/** Resolve existing symlinks, and preserve missing tail segments for new files. */
export function canonicalGrantPath(target: string): string {
  const absolute = resolve(target);
  try { return realpathSync(absolute); } catch {
    const tail: string[] = [];
    let cursor = absolute;
    for (let depth = 0; depth < 64; depth++) {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      tail.unshift(cursor.slice(parent.length).replace(/^[\\/]+/, ''));
      cursor = parent;
      try { return join(realpathSync(cursor), ...tail); } catch { /* keep walking */ }
    }
    return absolute;
  }
}

export function grantPathInside(target: string, base: string): boolean {
  const rel = relative(canonicalGrantPath(base), canonicalGrantPath(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function protectedWritePath(target: string): boolean {
  const normalized = canonicalGrantPath(target);
  const segments = normalized.split(/[\\/]/).map(part => part.toLowerCase());
  const name = basename(normalized).toLowerCase();
  return segments.some(part => ALWAYS_PROTECTED_SEGMENTS.has(part))
    || PROTECTED_BASENAMES.has(name)
    || name === '.env'
    || name.startsWith('.env.');
}

/** Validate a representative's file-only request; shell mutation is deliberately excluded. */
export function validateWriteAccessRequest(input: {
  tools?: unknown; paths?: unknown; reason?: unknown; cwd: string; dataRoot: string;
}): { ok: true; tools: Array<'edit' | 'write'>; paths: string[]; directoryPaths: string[]; reason: string } | { ok: false; reason: string } {
  const requested = Array.isArray(input.tools) ? input.tools.map(value => String(value).trim().toLowerCase()) : [];
  const tools = [...new Set(requested.filter((value): value is 'edit' | 'write' => (FILE_WRITE_TOOLS as readonly string[]).includes(value)))];
  if (!tools.length) return { ok: false, reason: '文件写权限只支持 edit / write；bash 与 powershell 不属于路径受限的文件授权' };
  if (requested.some(value => !(FILE_WRITE_TOOLS as readonly string[]).includes(value))) return { ok: false, reason: '申请包含不受支持的工具；代表文件写授权仅限 edit / write' };
  const reason = String(input.reason ?? '').trim();
  if (!reason) return { ok: false, reason: '权限申请必须说明要改什么、为什么必须写' };
  if (reason.length > 500) return { ok: false, reason: '理由过长（上限 500 字符）' };
  if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 8) return { ok: false, reason: '必须申请 1–8 个项目文件、目录或精确的新文件路径作为写入范围' };
  const cwd = canonicalGrantPath(input.cwd);
  const paths: string[] = [];
  const directoryPaths: string[] = [];
  for (const raw of input.paths) {
    const value = String(raw ?? '').trim();
    if (!value || value.length > 1000) return { ok: false, reason: '写入路径为空或过长' };
    let path: string;
    try { path = canonicalGrantPath(isAbsolute(value) ? value : join(cwd, value)); }
    catch { return { ok: false, reason: `无法解析写入范围：${value}` }; }
    if (!grantPathInside(path, cwd)) return { ok: false, reason: `写入范围必须位于项目目录内：${value}` };
    if (protectedWritePath(path) || grantPathInside(path, input.dataRoot)) return { ok: false, reason: `该路径属于受保护位置，不能授权：${value}` };
    try {
      const info = statSync(path);
      if (info.isDirectory()) directoryPaths.push(path);
      else if (!info.isFile()) return { ok: false, reason: `写入范围不是普通文件或目录：${value}` };
    } catch {
      // A new file may be authorized exactly, as long as its parent already exists.
      // Nonexistent directories are never treated as recursive scopes.
      if (existsSync(path)) return { ok: false, reason: `无法检查写入目标：${value}` };
      try {
        const parent = canonicalGrantPath(dirname(path));
        if (!statSync(parent).isDirectory() || !grantPathInside(parent, cwd)) return { ok: false, reason: `新文件必须直接位于已存在的项目目录中：${value}` };
      } catch { return { ok: false, reason: `写入范围不存在，且其父目录不可用：${value}` }; }
    }
    if (!paths.includes(path)) paths.push(path);
  }
  return { ok: true, tools, paths, directoryPaths, reason };
}

/** The principal may narrow, but can never enlarge, the representative's request. */
export function validateWriteAccessAssessment(input: unknown, request: { tools: readonly string[]; paths: readonly string[] }):
  | { approved: true; tools: Array<'edit' | 'write'>; paths: string[]; reason: string }
  | { approved: false; reason: string } {
  if (!input || typeof input !== 'object') return { approved: false, reason: '总理评估结果不是对象' };
  const value = input as any;
  const reason = String(value.reason ?? '').trim().slice(0, 500);
  if (value.approved !== true) return { approved: false, reason: reason || '总理评估后拒绝或未能确认必要性' };
  const tools: string[] = Array.isArray(value.tools) ? [...new Set<string>(value.tools.map((tool: unknown) => String(tool).toLowerCase()))] : [];
  const paths: string[] = Array.isArray(value.paths) ? [...new Set<string>(value.paths.map((path: unknown) => canonicalGrantPath(String(path))))] : [];
  if (!tools.length || tools.some((tool: string) => !(FILE_WRITE_TOOLS as readonly string[]).includes(tool) || !request.tools.includes(tool))) {
    return { approved: false, reason: '总理评估给出了未申请或无效的写工具；权限未授予' };
  }
  if (!paths.length || paths.some((path: string) => !request.paths.some(requested => canonicalGrantPath(requested) === path))) {
    return { approved: false, reason: '总理评估给出了未申请的路径；权限未授予' };
  }
  return { approved: true, tools: tools as Array<'edit' | 'write'>, paths, reason: reason || '总理评估认为该范围是完成任务所必需的' };
}

/** Guard edit/write calls inside the worker. The grant snapshot lives outside the project sandbox. */
export function writeAccessDenied(input: {
  toolName: string; input: unknown; grantFile?: string; taskId?: string; now?: number;
}): string | null {
  if (!(MUTATING_TOOLS as readonly string[]).includes(input.toolName)) return null;
  if (!(FILE_WRITE_TOOLS as readonly string[]).includes(input.toolName)) return `代表写授权不允许执行 ${input.toolName}；只支持路径受限的 edit / write`;
  if (!input.grantFile || !input.taskId || !existsSync(input.grantFile)) return '当前任务没有已批准的文件写权限';
  let grant: ActiveWriteGrant;
  try { grant = JSON.parse(readFileSync(input.grantFile, 'utf8')); }
  catch { return '当前任务的写权限记录不可读，已按无权限处理'; }
  if (!grant || typeof grant !== 'object' || grant.version !== 1 || grant.taskId !== input.taskId || !Array.isArray(grant.tools) || !grant.tools.includes(input.toolName as 'edit' | 'write') || !Array.isArray(grant.paths) || !grant.paths.length || !grant.paths.every(path => typeof path === 'string') || !Array.isArray(grant.directoryPaths) || !grant.directoryPaths.every(path => grant.paths.includes(path)) || typeof grant.projectRoot !== 'string' || !Array.isArray(grant.protectedPaths) || !grant.protectedPaths.every(path => typeof path === 'string') || !Number.isFinite(grant.expiresAt) || (input.now ?? Date.now()) >= grant.expiresAt) {
    return '当前任务的文件写授权不存在、已过期或不包含此工具';
  }
  const params = input.input && typeof input.input === 'object' ? input.input as Record<string, unknown> : {};
  const rawPath = params.path ?? params.filePath ?? params.file;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '写入工具缺少可检查的目标路径，已按无权限处理';
  let target: string;
  try { target = canonicalGrantPath(rawPath); } catch { return `无法解析写入目标路径：${rawPath}`; }
  try {
    if (protectedWritePath(target)) return `写入受保护位置被拒绝：${rawPath}`;
    if (!grant.projectRoot || !grantPathInside(target, grant.projectRoot)) return `写入目标已离开批准的项目目录：${rawPath}`;
    if (grant.protectedPaths.some(path => grantPathInside(target, path))) return `写入受保护位置被拒绝：${rawPath}`;
  } catch { return '无法安全核实写入目标，已按无权限处理'; }
  const allowed = grant.paths.some(scope => {
    try {
      const canonicalScope = canonicalGrantPath(scope);
      if (!grantPathInside(canonicalScope, grant.projectRoot)) return false;
      return grant.directoryPaths.includes(scope)
        ? statSync(canonicalScope).isDirectory() && grantPathInside(target, canonicalScope)
        : target === canonicalScope;
    }
    catch { return false; }
  });
  return allowed ? null : `目标超出总理批准的写入范围：${rawPath}`;
}

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
