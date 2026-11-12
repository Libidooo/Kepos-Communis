import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';

const MAX_VERIFY_BYTES = 32 * 1024 * 1024;

export type WriteVerification = {
  status: 'verified' | 'unverified';
  method?: 'sha256_readback';
  assertion?: 'stable_readback_only' | 'exact_write_payload' | 'edit_replacements_present';
  checkedAt: string;
  sha256?: string;
  bytes?: number;
  modifiedAt?: string;
  reason?: string;
};

export type WriteExpectation = { content: string } | { edits: Array<{ oldText: string; newText: string }> };

export type WriteAuditEvent = {
  at: string;
  taskId: string;
  tool: 'edit' | 'write';
  status: 'written' | 'blocked' | 'failed';
  path: string;
  reason?: string;
  verification?: WriteVerification;
};

/** Read the file back after a successful write tool call and record a content digest, never its contents. */
export function verifyWriteAfter(projectRoot: string, target: string, expectation?: WriteExpectation, now = new Date()): WriteVerification {
  const checkedAt = now.toISOString();
  try {
    const root = realpathSync(resolve(projectRoot));
    const requested = resolve(root, target);
    const path = realpathSync(requested);
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { status: 'unverified', checkedAt, reason: '写后回读目标解析到项目目录之外' };
    }
    const before = statSync(path);
    if (!before.isFile()) return { status: 'unverified', checkedAt, reason: '写后回读目标不是普通文件' };
    if (before.size > MAX_VERIFY_BYTES) return { status: 'unverified', checkedAt, reason: `文件超过 ${MAX_VERIFY_BYTES} 字节回读上限` };
    const contents = readFileSync(path);
    const after = statSync(path);
    if (contents.length !== after.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || (before.ino && after.ino && before.ino !== after.ino)) {
      return { status: 'unverified', checkedAt, reason: '回读期间文件仍在变化，无法确认稳定内容' };
    }
    const sha256 = createHash('sha256').update(contents).digest('hex');
    let assertion: WriteVerification['assertion'] = 'stable_readback_only';
    if (expectation && 'content' in expectation) {
      assertion = 'exact_write_payload';
      const expectedHash = createHash('sha256').update(expectation.content, 'utf8').digest('hex');
      if (sha256 !== expectedHash) return { status: 'unverified', method: 'sha256_readback', assertion, checkedAt, sha256, bytes: contents.length, reason: '回读文件与 write 工具请求的内容不一致' };
    } else if (expectation && 'edits' in expectation) {
      assertion = 'edit_replacements_present';
      const normalize = (value: string) => value.replace(/\r\n?/g, '\n');
      const actual = normalize(contents.toString('utf8'));
      for (const edit of expectation.edits) {
        const replacement = normalize(edit.newText);
        const original = normalize(edit.oldText);
        if (replacement ? !actual.includes(replacement) : actual.includes(original)) {
          return { status: 'unverified', method: 'sha256_readback', assertion, checkedAt, sha256, bytes: contents.length, reason: '回读文件未能确认 edit 请求中的替换内容' };
        }
      }
    }
    return {
      status: 'verified', method: 'sha256_readback', assertion, checkedAt,
      sha256,
      bytes: contents.length,
      modifiedAt: after.mtime.toISOString(),
    };
  } catch (error) {
    return { status: 'unverified', checkedAt, reason: String((error as Error)?.message || error).slice(0, 500) };
  }
}

const MAX_EVENTS = 500;
const MAX_BYTES = 1024 * 1024;

export function writeAuditFile(archiveRoot: string, taskId: string): string {
  const safeId = String(taskId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeId) throw Error('Invalid task id');
  return join(resolve(archiveRoot), safeId, 'write-events.jsonl');
}

/** Persist metadata only; file contents never enter the audit log. */
export function appendWriteAudit(archiveRoot: string, projectRoot: string, event: Omit<WriteAuditEvent, 'at'> & { at?: string }): boolean {
  let file: string;
  try { file = writeAuditFile(archiveRoot, event.taskId); } catch { return false; }
  try {
    const info = existsSync(file) ? statSync(file) : undefined;
    if (info && info.size >= MAX_BYTES) return false;
    const existing = info ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
    if (existing >= MAX_EVENTS) return false;
    const absolute = resolve(String(event.path || '').slice(0, 2000));
    const rel = relative(resolve(projectRoot), absolute);
    const displayPath = rel === '' ? '.' : !rel.startsWith('..') && !resolve(rel).startsWith('..')
      ? rel.split(sep).join('/')
      : String(event.path || '').slice(0, 1000);
    const record: WriteAuditEvent = {
      at: event.at || new Date().toISOString(),
      taskId: event.taskId,
      tool: event.tool,
      status: event.status,
      path: displayPath,
      ...(event.reason ? { reason: String(event.reason).slice(0, 500) } : {}),
      ...(event.verification ? { verification: {
        status: event.verification.status === 'verified' ? 'verified' : 'unverified',
        checkedAt: String(event.verification.checkedAt || '').slice(0, 64),
        ...(event.verification.method === 'sha256_readback' ? { method: 'sha256_readback' as const } : {}),
        ...(event.verification.assertion && ['stable_readback_only', 'exact_write_payload', 'edit_replacements_present'].includes(event.verification.assertion) ? { assertion: event.verification.assertion } : {}),
        ...(typeof event.verification.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(event.verification.sha256) ? { sha256: event.verification.sha256.toLowerCase() } : {}),
        ...(Number.isSafeInteger(event.verification.bytes) && Number(event.verification.bytes) >= 0 ? { bytes: Number(event.verification.bytes) } : {}),
        ...(typeof event.verification.modifiedAt === 'string' ? { modifiedAt: event.verification.modifiedAt.slice(0, 64) } : {}),
        ...(typeof event.verification.reason === 'string' ? { reason: event.verification.reason.slice(0, 500) } : {}),
      } } : {}),
    };
    mkdirSync(resolve(file, '..'), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch { return false; }
}

export function readWriteAudit(archiveRoot: string, taskId: string): WriteAuditEvent[] {
  try {
    return readFileSync(writeAuditFile(archiveRoot, taskId), 'utf8').split('\n').filter(Boolean).slice(-MAX_EVENTS).flatMap(line => {
      try {
        const value = JSON.parse(line);
        if (value?.taskId !== taskId || !['edit', 'write'].includes(value.tool) || !['written', 'blocked', 'failed'].includes(value.status) || typeof value.path !== 'string') return [];
        const verification = value.verification && typeof value.verification === 'object' && ['verified', 'unverified'].includes(value.verification.status)
          ? {
            status: value.verification.status as WriteVerification['status'],
            checkedAt: String(value.verification.checkedAt || '').slice(0, 64),
            ...(value.verification.method === 'sha256_readback' ? { method: 'sha256_readback' as const } : {}),
            ...(value.verification.assertion && ['stable_readback_only', 'exact_write_payload', 'edit_replacements_present'].includes(value.verification.assertion) ? { assertion: value.verification.assertion as WriteVerification['assertion'] } : {}),
            ...(typeof value.verification.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.verification.sha256) ? { sha256: value.verification.sha256.toLowerCase() } : {}),
            ...(Number.isSafeInteger(value.verification.bytes) && Number(value.verification.bytes) >= 0 ? { bytes: Number(value.verification.bytes) } : {}),
            ...(typeof value.verification.modifiedAt === 'string' ? { modifiedAt: String(value.verification.modifiedAt).slice(0, 64) } : {}),
            ...(typeof value.verification.reason === 'string' ? { reason: String(value.verification.reason).slice(0, 500) } : {}),
          } satisfies WriteVerification
          : undefined;
        return [{ at: String(value.at || ''), taskId, tool: value.tool, status: value.status, path: value.path, ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 500) } : {}), ...(verification ? { verification } : {}) } as WriteAuditEvent];
      } catch { return []; }
    });
  } catch { return []; }
}

export function changedFilesFromAudit(events: readonly WriteAuditEvent[]): string[] {
  return [...new Set(events.filter(event => event.status === 'written').map(event => event.path))].sort();
}

export function writeAuditCounts(events: readonly WriteAuditEvent[]) {
  const writes = events.filter(event => event.status === 'written');
  return {
    written: writes.length,
    verified: writes.filter(event => event.verification?.status === 'verified').length,
    unverified: writes.filter(event => event.verification?.status !== 'verified').length,
    failed: events.filter(event => event.status === 'failed').length,
    blocked: events.filter(event => event.status === 'blocked').length,
  };
}
