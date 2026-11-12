import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { appendWriteAudit, changedFilesFromAudit, readWriteAudit, verifyWriteAfter, writeAuditCounts, writeAuditFile } = await import('../dist/terminal/write-audit.js');

test('write audit records tool outcomes and exposes only files successfully changed', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kepos-write-audit-'));
  try {
    const archive = join(cwd, '.kepos');
    assert.equal(appendWriteAudit(archive, cwd, { taskId: 'task-1', tool: 'write', status: 'written', path: join(cwd, 'src', 'new.ts') }), true);
    assert.equal(appendWriteAudit(archive, cwd, { taskId: 'task-1', tool: 'edit', status: 'failed', path: join(cwd, 'src', 'broken.ts'), reason: 'write failed' }), true);
    assert.equal(appendWriteAudit(archive, cwd, { taskId: 'task-1', tool: 'edit', status: 'blocked', path: join(cwd, '.kepos', 'index.json'), reason: 'protected' }), true);
    const events = readWriteAudit(archive, 'task-1');
    assert.equal(events.length, 3);
    assert.equal(events[0].path, 'src/new.ts');
    assert.deepEqual(changedFilesFromAudit(events), ['src/new.ts']);
    assert.deepEqual(writeAuditCounts(events), { written: 1, verified: 0, unverified: 1, failed: 1, blocked: 1 });
    assert.equal(writeAuditFile(archive, '../../task-1').includes('..'), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('write-after verification reads back stable bytes and records only digest metadata', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kepos-write-verify-'));
  try {
    const file = join(cwd, 'result.txt');
    const contents = 'verified output\n';
    writeFileSync(file, contents);
    const verification = verifyWriteAfter(cwd, file);
    assert.equal(verification.status, 'verified');
    assert.equal(verification.method, 'sha256_readback');
    assert.equal(verification.assertion, 'stable_readback_only');
    assert.equal(verification.bytes, Buffer.byteLength(contents));
    assert.equal(verification.sha256, createHash('sha256').update(contents).digest('hex'));
    assert.ok(verification.modifiedAt);
    assert.equal(JSON.stringify(verification).includes(contents), false);

    assert.equal(verifyWriteAfter(cwd, file, { content: contents }).assertion, 'exact_write_payload');
    const mismatch = verifyWriteAfter(cwd, file, { content: 'different requested content' });
    assert.equal(mismatch.status, 'unverified');
    assert.match(mismatch.reason, /内容不一致/);
    const editCheck = verifyWriteAfter(cwd, file, { edits: [{ oldText: 'old text', newText: 'verified output' }] });
    assert.equal(editCheck.status, 'verified');
    assert.equal(editCheck.assertion, 'edit_replacements_present');
    const missingEdit = verifyWriteAfter(cwd, file, { edits: [{ oldText: 'absent old', newText: 'absent replacement' }] });
    assert.equal(missingEdit.status, 'unverified');

    const archive = join(cwd, '.kepos');
    assert.equal(appendWriteAudit(archive, cwd, { taskId: 'verified-task', tool: 'write', status: 'written', path: file, verification }), true);
    const [event] = readWriteAudit(archive, 'verified-task');
    assert.deepEqual(event.verification, verification);
    assert.deepEqual(writeAuditCounts([event]), { written: 1, verified: 1, unverified: 0, failed: 0, blocked: 0 });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('write-after verification reports missing and out-of-project targets without claiming success', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kepos-write-verify-boundary-'));
  const outside = mkdtempSync(join(tmpdir(), 'kepos-write-verify-outside-'));
  try {
    const missing = verifyWriteAfter(cwd, join(cwd, 'missing.txt'));
    assert.equal(missing.status, 'unverified');
    assert.match(missing.reason, /ENOENT|no such file/i);
    const externalFile = join(outside, 'secret.txt');
    writeFileSync(externalFile, 'outside');
    const outsideResult = verifyWriteAfter(cwd, externalFile);
    assert.equal(outsideResult.status, 'unverified');
    assert.match(outsideResult.reason, /项目目录之外/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('write audit ignores malformed and cross-task records', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kepos-write-audit-'));
  try {
    assert.equal(appendWriteAudit(join(cwd, '.kepos'), cwd, { taskId: 'task-a', tool: 'write', status: 'written', path: join(cwd, 'a.ts') }), true);
    assert.deepEqual(readWriteAudit(join(cwd, '.kepos'), 'task-b'), []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('worker tool lifecycle persists a post-write readback digest to the task archive', async () => {
  const workerRoot = join(process.cwd(), `.kepos-write-hook-${randomUUID()}`);
  const archiveRoot = mkdtempSync(join(tmpdir(), 'kepos-write-hook-archive-'));
  mkdirSync(workerRoot);
  const target = join(workerRoot, 'generated.txt');
  const taskId = `write-hook-${randomUUID()}`;
  const grantFile = join(archiveRoot, 'grant.json');
  writeFileSync(grantFile, JSON.stringify({
    version: 1, id: randomUUID(), taskId, tools: ['write'], paths: [target], directoryPaths: [],
    projectRoot: process.cwd(), protectedPaths: [], issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
  }));
  const envKeys = ['KEPOS_TASK_ID', 'KEPOS_ARCHIVE_ROOT', 'KEPOS_WRITE_GRANT_FILE'];
  const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.KEPOS_TASK_ID = taskId;
  process.env.KEPOS_ARCHIVE_ROOT = archiveRoot;
  process.env.KEPOS_WRITE_GRANT_FILE = grantFile;
  try {
    const { default: workerSandbox } = await import('../dist/terminal/worker-sandbox.js');
    const handlers = new Map();
    const pi = { registerTool() {}, on(name, handler) { handlers.set(name, handler); } };
    workerSandbox(pi);
    const gate = await handlers.get('tool_call')({ toolName: 'write', input: { path: target } });
    assert.equal(gate, undefined, gate?.reason);
    const contents = 'written by worker tool';
    writeFileSync(target, contents);
    handlers.get('tool_execution_end')({ toolName: 'write', args: { path: target, content: contents }, result: { content: [{ type: 'text', text: 'Wrote file' }] } });
    const [event] = readWriteAudit(archiveRoot, taskId);
    assert.equal(event.status, 'written');
    assert.equal(event.verification.status, 'verified');
    assert.equal(event.verification.assertion, 'exact_write_payload');
    assert.equal(event.verification.sha256, createHash('sha256').update(contents).digest('hex'));
  } finally {
    for (const key of envKeys) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    rmSync(workerRoot, { recursive: true, force: true });
    rmSync(archiveRoot, { recursive: true, force: true });
  }
});
