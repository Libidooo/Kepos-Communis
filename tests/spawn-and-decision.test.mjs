import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { archivePaths, ensureArchive } = await import('../dist/terminal/archive.js');
const { writeSpawnRequest, readSpawnRequest, clearSpawnRequest, writeDecision, readDecision, readProjectCheckRequest, readProjectCheckResult } = await import('../dist/terminal/representative-tools.js');
const { SpawnRequestPoller } = await import('../dist/terminal/spawn-poller.js');
const { canReadArchive, archiveTaskIdOf } = await import('../dist/terminal/archive-access.js');

const fresh = () => mkdtempSync(join(tmpdir(), 'kepos-spawn-'));

test('a representative writes a spawn request that the parent can read', () => {
  const cwd = fresh();
  ensureArchive(cwd);
  const root = archivePaths(cwd).task('rep-1').dir;
  writeSpawnRequest(root, { id: 'r1', task: '扫描鉴权路径', seconds: 60, mcp: ['search'], mcpReason: '需要查询供应商文档', requestedAt: Date.now() });
  const read = readSpawnRequest(root);
  assert.equal(read?.task, '扫描鉴权路径');
  assert.equal(read?.seconds, 60);
  assert.deepEqual(read?.mcp, ['search']);
  assert.equal(read?.mcpReason, '需要查询供应商文档');
});

test('an empty task is refused rather than dispatched as a no-op', () => {
  const cwd = fresh();
  ensureArchive(cwd);
  const root = archivePaths(cwd).task('rep-2').dir;
  writeSpawnRequest(root, { id: 'r2', task: '   ', requestedAt: Date.now() });
  assert.equal(readSpawnRequest(root), null);
});

test('the poller hands one request to the handler then marks it handled', async () => {
  const cwd = fresh();
  ensureArchive(cwd);
  const root = archivePaths(cwd).task('rep-3').dir;
  writeSpawnRequest(root, { id: 'r3', task: '子任务', requestedAt: Date.now() });

  const seen = [];
  const poller = new SpawnRequestPoller({ onSpawn: async (taskId, request) => { seen.push({ taskId, task: request.task }); return { ok: true }; } });
  await poller.tick(['rep-3'], cwd);
  assert.deepEqual(seen, [{ taskId: 'rep-3', task: '子任务' }]);

  // 第二轮不应重复执行同一请求。
  await poller.tick(['rep-3'], cwd);
  assert.equal(seen.length, 1, 'a handled request is not replayed');
});

test('a failed spawn is recorded back for the representative to read', async () => {
  const cwd = fresh();
  ensureArchive(cwd);
  const root = archivePaths(cwd).task('rep-4').dir;
  writeSpawnRequest(root, { id: 'r4', task: '会失败的任务', requestedAt: Date.now() });
  const poller = new SpawnRequestPoller({ onSpawn: async () => ({ ok: false, reason: '配额已满' }) });
  await poller.tick(['rep-4'], cwd);
  const failure = join(root, 'spawn-failed.md');
  assert.ok(existsSync(failure), 'failure is written where the representative can see it');
  assert.match(readFileSync(failure, 'utf8'), /配额已满/);
});

test('the poller handles a named project-check request and writes its bound result', async () => {
  const cwd = fresh();
  ensureArchive(cwd);
  const root = archivePaths(cwd).task('rep-check').dir;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'project-check-request.json'), JSON.stringify({ id: 'check-1', taskId: 'rep-check', check: 'test', reason: '验证修复', requestedAt: Date.now() }));
  const received = [];
  const poller = new SpawnRequestPoller({
    onSpawn: async () => ({ ok: true }),
    onProjectCheck: async (taskId, request) => {
      received.push({ taskId, request });
      return { id: request.id, taskId, approved: true, check: request.check, command: 'npm run --ignore-scripts test', exitCode: 0, output: 'PASS' };
    },
  });
  await poller.tick(['rep-check'], cwd);
  assert.equal(received.length, 1);
  assert.equal(received[0].request.check, 'test');
  assert.equal(readProjectCheckRequest(root), null, 'handled request is removed');
  assert.equal(readProjectCheckResult(root)?.id, 'check-1');
  assert.equal(readProjectCheckResult(root)?.taskId, 'rep-check');
  assert.equal(readProjectCheckResult(root)?.output, 'PASS');
  await poller.tick(['rep-check'], cwd);
  assert.equal(received.length, 1, 'a handled check is not replayed');
});

test('a decision is written and read back', () => {
  const cwd = fresh();
  ensureArchive(cwd);
  const root = archivePaths(cwd).task('sub-1').dir;
  writeDecision(root, { adopted: false, note: '证据不足，缺文件行号', rework: '补上引用后重报' }, '审查官');
  const back = readDecision(root);
  assert.equal(back.adopted, false);
  assert.match(String(back.note), /证据不足/);
  const text = readFileSync(join(root, 'decision.md'), 'utf8');
  assert.match(text, /不采纳/);
  assert.match(text, /重派要求/);
  assert.match(text, /审查官/);
});

// 权限边界：代表只能读自己僚属的归档，不能读总理的。
test('a representative reads its own subordinates but not the premier records', () => {
  const rep = { role: 'representative', taskId: 'rep-1' };
  assert.equal(canReadArchive(rep, { taskId: 'sub-1', parentWorkerId: 'rep-1' }).allowed, true, 'own subordinate');
  assert.equal(canReadArchive(rep, { taskId: 'rep-1' }).allowed, true, 'own archive');

  const otherRep = canReadArchive(rep, { taskId: 'sub-9', parentWorkerId: 'rep-9' });
  assert.equal(otherRep.allowed, false);
  assert.match(String(otherRep.reason), /其他代表/);

  const premierTask = canReadArchive(rep, { taskId: 'direct-1' });
  assert.equal(premierTask.allowed, false);
  assert.match(String(premierTask.reason), /总理直接派发/);
});

test('a subordinate cannot read any archive at all', () => {
  const sub = { role: 'subordinate', taskId: 'sub-1' };
  assert.equal(canReadArchive(sub, { taskId: 'sub-2', parentWorkerId: 'rep-1' }).allowed, false);
});

test('the premier reads everything', () => {
  const premier = { role: 'premier' };
  assert.equal(canReadArchive(premier, { taskId: 'any' }).allowed, true);
  assert.equal(canReadArchive({ role: 'human' }, { taskId: 'any' }).allowed, true);
});

test('archive ownership is derived from the path, not trusted from the caller', () => {
  const cwd = fresh();
  const file = join(cwd, '.kepos', 'task-7', 'report.md');
  mkdirSync(join(cwd, '.kepos', 'task-7'), { recursive: true });
  writeFileSync(file, 'x');
  assert.equal(archiveTaskIdOf(cwd, file), 'task-7');
  // 项目外的路径不属于任何归档。
  assert.equal(archiveTaskIdOf(cwd, join(cwd, 'src.ts')), null);
  assert.equal(archiveTaskIdOf(cwd, join(cwd, '.kepos', 'roles', 'a.md')), null);
});
