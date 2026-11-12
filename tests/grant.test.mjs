import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  normalizeRequestedTools, validateGrantRequest, canDelegate, grantActive,
  describeForHuman, validateWriteAccessRequest, validateWriteAccessAssessment,
  persistActiveWriteGrant, revokeActiveWriteGrant, writeGrantSnapshotPath, writeAccessDenied,
} = await import('../dist/terminal/grant.js');

test('only real mutating tool names survive normalisation', () => {
  assert.deepEqual(normalizeRequestedTools(['bash', 'write']), ['bash', 'write']);
  // 拼写变体、未知工具、非数组一律剔除，防止用别名绕过白名单。
  assert.deepEqual(normalizeRequestedTools(['BASH', 'rm', 'Write']), ['bash', 'write']);
  assert.deepEqual(normalizeRequestedTools('bash'), []);
  assert.deepEqual(normalizeRequestedTools(undefined), []);
});

test('a request needs real tools and a stated reason', () => {
  const empty = validateGrantRequest({ tools: [], reason: '想改点东西' });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /未申请任何有效写权限/);

  const noReason = validateGrantRequest({ tools: ['edit'] });
  assert.equal(noReason.ok, false);
  assert.match(noReason.reason, /必须说明理由/);

  const tooLong = validateGrantRequest({ tools: ['edit'], reason: 'x'.repeat(501) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.reason, /过长/);

  const ok = validateGrantRequest({ tools: ['edit', 'write'], reason: '需要修正三处 typo' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.tools, ['edit', 'write']);
  assert.equal(ok.reason, '需要修正三处 typo');
});

// 核心约束：僚属永远不可能比它的直属代表权限更大。
test('a representative can only delegate permissions it already holds', () => {
  const ok = canDelegate(['edit', 'write'], ['edit']);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.tools, ['edit']);

  const escalate = canDelegate(['edit'], ['edit', 'bash']);
  assert.equal(escalate.ok, false);
  assert.match(escalate.reason, /不能转授自身没有的权限：bash/);

  const nothing = canDelegate([], ['write']);
  assert.equal(nothing.ok, false);
  assert.match(nothing.reason, /代表当前持有：无/);
});

test('grants expire with the task even when approved', () => {
  const approved = { id: 'g', taskId: 't', agent: '审查官', tools: ['edit'], reason: 'fix', state: 'approved', requestedAt: 1 };
  assert.equal(grantActive(approved, false), true, 'active while the task runs');
  assert.equal(grantActive(approved, true), false, 'a finished task drops the grant');
  assert.equal(grantActive(undefined, false), false, 'no grant means no permission');
  const pending = { ...approved, state: 'requested' };
  assert.equal(grantActive(pending, false), false, 'an unapproved request grants nothing');
  const expired = { ...approved, expiresAt: 1000 };
  assert.equal(grantActive(expired, false, 2000), false, 'expiry is honoured');
});

test('the human sees what is being asked before approving', () => {
  const grant = {
    id: 'g', taskId: 't', agent: '审查官', tools: ['edit', 'write'],
    reason: '需要修正配置项', state: 'requested', requestedAt: 1, humanConfirmed: false,
  };
  const text = describeForHuman(grant);
  assert.match(text, /审查官/);
  assert.match(text, /edit \/ write/);
  assert.match(text, /需要修正配置项/);
  assert.match(text, /待代理总代转呈/);
  assert.match(text, /尚未经人类确认/);
});

test('representative write requests are scoped to project files and exact new-file targets', () => {
  const temp = mkdtempSync(join(tmpdir(), 'kepos-write-request-'));
  try {
    const project = join(temp, 'project');
    const data = join(temp, 'private-data');
    const source = join(project, 'src');
    mkdirSync(source, { recursive: true });
    mkdirSync(data, { recursive: true });
    writeFileSync(join(source, 'app.ts'), 'export const app = true;');

    const directory = validateWriteAccessRequest({
      tools: ['edit', 'write'], paths: ['src'], reason: '实现指定功能并复核源文件', cwd: project, dataRoot: data,
    });
    assert.equal(directory.ok, true);
    assert.deepEqual(directory.directoryPaths, [realpathSync(source)]);

    const newFile = validateWriteAccessRequest({
      tools: ['write'], paths: ['src/new.ts'], reason: '新增任务要求的模块', cwd: project, dataRoot: data,
    });
    assert.equal(newFile.ok, true, 'an exact new file may be requested under an existing directory');
    assert.deepEqual(newFile.paths, [join(realpathSync(source), 'new.ts')]);
    assert.deepEqual(newFile.directoryPaths, [], 'a new file never becomes a recursive scope');

    const outside = validateWriteAccessRequest({
      tools: ['write'], paths: ['../outside.ts'], reason: '越界', cwd: project, dataRoot: data,
    });
    assert.equal(outside.ok, false);
    assert.match(outside.reason, /项目目录内/);

    for (const protectedPath of ['.kepos', '.env']) {
      const denied = validateWriteAccessRequest({
        tools: ['write'], paths: [protectedPath], reason: '尝试写受保护文件', cwd: project, dataRoot: data,
      });
      assert.equal(denied.ok, false, `${protectedPath} must not be grantable`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('the principal can only narrow the representative request', () => {
  const temp = mkdtempSync(join(tmpdir(), 'kepos-write-assessment-'));
  try {
    const project = join(temp, 'project');
    mkdirSync(project, { recursive: true });
    const target = join(project, 'app.ts');
    writeFileSync(target, 'export const app = true;');
    const request = { tools: ['edit', 'write'], paths: [target] };

    const narrowed = validateWriteAccessAssessment({
      approved: true, tools: ['edit'], paths: [target], reason: '只需精确修改该文件',
    }, request);
    assert.equal(narrowed.approved, true);
    assert.deepEqual(narrowed.tools, ['edit']);
    assert.deepEqual(narrowed.paths, [realpathSync(target)]);

    const broadenedTool = validateWriteAccessAssessment({
      approved: true, tools: ['bash'], paths: [target], reason: '不安全',
    }, request);
    assert.equal(broadenedTool.approved, false);

    const broadenedPath = validateWriteAccessAssessment({
      approved: true, tools: ['write'], paths: [project], reason: '不安全',
    }, request);
    assert.equal(broadenedPath.approved, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('an active write snapshot enforces task, tool, path, expiry, and revocation', () => {
  const temp = mkdtempSync(join(tmpdir(), 'kepos-write-guard-'));
  try {
    const project = join(temp, 'project');
    const source = join(project, 'src');
    const data = join(temp, 'private-data');
    const archive = join(project, '.kepos');
    mkdirSync(source, { recursive: true });
    mkdirSync(data, { recursive: true });
    mkdirSync(archive, { recursive: true });
    const approvedFile = join(source, 'app.ts');
    writeFileSync(approvedFile, 'export const app = true;');
    const grant = {
      version: 1, id: 'request-1', taskId: 'task-1', tools: ['edit'], paths: [approvedFile],
      directoryPaths: [], projectRoot: project, protectedPaths: [data, archive], issuedAt: 100, expiresAt: 10_000,
    };
    const grantFile = persistActiveWriteGrant(data, grant);
    const base = { toolName: 'edit', grantFile, taskId: 'task-1', now: 200 };

    assert.equal(writeAccessDenied({ ...base, input: { path: approvedFile } }), null);
    assert.match(String(writeAccessDenied({ ...base, input: { path: join(source, 'other.ts') } })), /超出总理批准/);
    assert.match(String(writeAccessDenied({ ...base, taskId: 'task-2', input: { path: approvedFile } })), /授权不存在/);
    assert.match(String(writeAccessDenied({ ...base, toolName: 'bash', input: { command: 'touch x' } })), /不允许执行 bash/);
    assert.match(String(writeAccessDenied({ ...base, now: 10_000, input: { path: approvedFile } })), /已过期/);
    assert.match(String(writeAccessDenied({ ...base, input: { path: join(archive, 'report.md') } })), /受保护位置/);

    revokeActiveWriteGrant(data, 'task-1');
    assert.equal(existsSync(grantFile), false);
    assert.match(String(writeAccessDenied({ ...base, input: { path: approvedFile } })), /没有已批准/);
    assert.equal(writeGrantSnapshotPath(data, 'task-1'), grantFile);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
