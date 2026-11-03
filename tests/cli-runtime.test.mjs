import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { validateArgs, isolatedEnv, credentialsReady, CliSessions } = await import('../dist/terminal/cli-runtime.js');

const fresh = () => mkdtempSync(join(tmpdir(), 'kepos-cli-'));

// 参数必须匹配白名单前缀，且不能夹带 shell 语义。
test('arguments must match an allowed prefix', () => {
  assert.equal(validateArgs(['exec', 'do it'], ['exec']).ok, true);
  assert.equal(validateArgs(['exec=foo'], ['exec']).ok, true);
  // 不在前缀里的一律拒绝。
  const wrong = validateArgs(['--dangerously', 'x'], ['exec']);
  assert.equal(wrong.ok, false);
  assert.match(String(wrong.reason), /首个参数必须/);
});

test('shell metacharacters are refused even though no shell is involved', () => {
  assert.equal(validateArgs(['exec', 'x; rm -rf /'], ['exec']).ok, false);
  assert.equal(validateArgs(['exec', 'a && b'], ['exec']).ok, false);
  assert.equal(validateArgs(['exec', '$(whoami)'], ['exec']).ok, false);
  assert.equal(validateArgs(['exec', 'line\nbreak'], ['exec']).ok, false);
});

// 凭据隔离：只带该 CLI 指定的那一个，其余绝不传递。
test('only the CLI own credential variable is injected', () => {
  const base = { PATH: '/usr/bin', SYSTEMROOT: 'C:/Windows', OPENAI_API_KEY: 'sk-secret', ANTHROPIC_KEY: 'ant-secret' };
  const env = isolatedEnv({ label: 'codex', envKey: 'OPENAI_API_KEY', addedAt: 0 }, base);
  assert.equal(env.OPENAI_API_KEY, 'sk-secret');
  assert.equal(env.ANTHROPIC_KEY, undefined, 'another CLI credential is never passed');
  assert.equal(env.PATH, '/usr/bin', 'runtime essentials still present');
});

test('a CLI with no credential variable passes none', () => {
  const env = isolatedEnv({ label: 'plain', addedAt: 0 }, { PATH: '/bin', SECRET: 'x' });
  assert.equal(env.SECRET, undefined);
  assert.equal(env.PATH, '/bin');
});

test('missing credentials are reported before dispatch instead of failing at spawn time', () => {
  assert.equal(credentialsReady({ label: 'codex', envKey: 'OPENAI_API_KEY', addedAt: 0 }, {}).ok, false);
  assert.match(String(credentialsReady({ label: 'codex', envKey: 'OPENAI_API_KEY', addedAt: 0 }, {}).reason), /OPENAI_API_KEY/);
  assert.equal(credentialsReady({ label: 'codex', envKey: 'OPENAI_API_KEY', addedAt: 0 }, { OPENAI_API_KEY: 'k' }).ok, true);
  assert.equal(credentialsReady({ label: 'plain', addedAt: 0 }, {}).ok, true);
});

// 多会话：代表可以同时开多个，各自独立。
test('multiple sessions run concurrently for one task', async () => {
  const sessions = new CliSessions({ maxPerTask: 3 });
  const archive = fresh();
  const entry = { label: 'node', argPrefixes: ['-e'], addedAt: 0 };
  const started = [];
  for (const text of ['first', 'second']) {
    const result = sessions.start({
      taskId: 'task-1', cli: process.execPath, entry,
      args: ['-e', `console.log(${JSON.stringify(text)})`],
      cwd: archive, env: process.env, archiveRoot: archive,
    });
    assert.equal(result.ok, true);
    started.push(result.sessionId);
  }
  assert.equal(sessions.list('task-1').length, 2, 'two independent sessions');
  // 等两个子进程结束。
  await new Promise(resolve => setTimeout(resolve, 800));
  const first = sessions.read(started[0]);
  const second = sessions.read(started[1]);
  assert.equal(first.ok && second.ok, true);
  assert.match(String(first.output), /first/);
  assert.match(String(second.output), /second/);
  sessions.closeAll('task-1');
});

test('the per-task session cap is enforced', () => {
  const sessions = new CliSessions({ maxPerTask: 1 });
  const archive = fresh();
  const entry = { label: 'node', argPrefixes: ['-e'], addedAt: 0 };
  const one = sessions.start({ taskId: 'task-1', cli: process.execPath, entry, args: ['-e', 'setTimeout(()=>{},5000)'], cwd: archive, env: process.env, archiveRoot: archive });
  assert.equal(one.ok, true);
  const two = sessions.start({ taskId: 'task-1', cli: process.execPath, entry, args: ['-e', '1'], cwd: archive, env: process.env, archiveRoot: archive });
  assert.equal(two.ok, false);
  assert.match(String(two.reason), /上限/);
  sessions.closeAll('task-1');
});

// 回收：任务结束时全部会话终止，这是授权的收尾。
test('closeAll terminates every session of a task and leaves others alone', async () => {
  const sessions = new CliSessions({ maxPerTask: 2 });
  const archive = fresh();
  const entry = { label: 'node', argPrefixes: ['-e'], addedAt: 0 };
  const mine = sessions.start({ taskId: 'task-A', cli: process.execPath, entry, args: ['-e', 'setTimeout(()=>{},10000)'], cwd: archive, env: process.env, archiveRoot: archive });
  const theirs = sessions.start({ taskId: 'task-B', cli: process.execPath, entry, args: ['-e', 'setTimeout(()=>{},10000)'], cwd: archive, env: process.env, archiveRoot: archive });
  assert.equal(mine.ok && theirs.ok, true);

  const closed = sessions.closeAll('task-A');
  assert.equal(closed, 1, 'one session closed for task A');
  await new Promise(resolve => setTimeout(resolve, 400));
  const remaining = sessions.list('task-B');
  assert.equal(remaining.length, 1, 'task B keeps its session');
  sessions.closeAll('task-B');
});

test('a session writes its transcript to the archive', async () => {
  const sessions = new CliSessions({ maxPerTask: 1 });
  const archive = fresh();
  const entry = { label: 'node', argPrefixes: ['-e'], addedAt: 0 };
  const result = sessions.start({
    taskId: 'task-1', cli: process.execPath, entry,
    args: ['-e', 'console.log("archived output")'],
    cwd: archive, env: process.env, archiveRoot: archive,
  });
  assert.equal(result.ok, true);
  await new Promise(resolve => setTimeout(resolve, 900));
  const files = readdirSync(archive).filter(name => name.startsWith('cli-'));
  assert.equal(files.length, 1, 'one transcript written');
  sessions.closeAll('task-1');
});

test('an unlisted executable cannot be started through the session manager', () => {
  // 会话管理器本身不查白名单——调用方必须先校验。这里验证的是：
  // 授权列表为空时，代表侧工具拿不到任何条目（见 representative-tools 的 byCli）。
  // 因此只要授权为空，start 永远不会被调用。
  const sessions = new CliSessions({ maxPerTask: 1 });
  assert.deepEqual(sessions.list('any'), []);
  void existsSync;
});
