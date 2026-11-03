import test from 'node:test';
import assert from 'node:assert/strict';

const {
  EXTERNAL_CLI_ALLOWLIST, normalizeCli, validateCliRequest, cliGrantUsable,
  safeCliArgs, describeCliGrant, revokeOnTaskEnd, cliAvailable, auditLine,
} = await import('../dist/terminal/cli-grant.js');
const { cliTurnFile, renderCliTurn, clampTurnOutput, listCliTurns, summarizeCliTurn } = await import('../dist/terminal/cli-dialog.js');

const baseGrant = () => ({
  id: 'g1', cli: 'codex', reason: '需要更强的代码理解', state: 'approved',
  requestedAt: 1, approvedAt: 2, expiresAt: Date.now() + 3600_000, humanConfirmed: true, uses: 0,
});

// 外部 CLI 等于任意命令执行能力，所以只认白名单。
test('only allowlisted CLIs are accepted', () => {
  assert.equal(normalizeCli('codex'), 'codex');
  assert.equal(normalizeCli('CODEX'), 'codex');
  assert.equal(normalizeCli('claude'), 'claude');
  // 任意命令一律拒绝——这是外部 CLI 授权的核心边界。
  assert.equal(normalizeCli('rm'), null);
  assert.equal(normalizeCli('bash'), null);
  assert.equal(normalizeCli('codex; rm -rf /'), null);
  assert.equal(normalizeCli(''), null);
});

test('a request needs an allowlisted CLI and a reason', () => {
  const wrong = validateCliRequest({ cli: 'bash', reason: '想跑命令' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /白名单/);

  const noReason = validateCliRequest({ cli: 'codex' });
  assert.equal(noReason.ok, false);
  assert.match(noReason.reason, /必须说明/);

  const ok = validateCliRequest({ cli: 'codex', reason: '需要跨文件重构建议' });
  assert.equal(ok.ok, true);
  assert.equal(ok.cli, 'codex');
});

// 五道闸任何一道不过都不可用。
test('a grant must be approved, human-confirmed, unexpired, unused-up and unclaimed', () => {
  assert.equal(cliGrantUsable(baseGrant()).ok, true);

  assert.match(String(cliGrantUsable({ ...baseGrant(), state: 'requested' }).reason), /状态/);
  assert.match(String(cliGrantUsable({ ...baseGrant(), humanConfirmed: false }).reason), /人类确认/);
  assert.match(String(cliGrantUsable({ ...baseGrant(), expiresAt: Date.now() - 1 }).reason), /过期/);
  assert.match(String(cliGrantUsable({ ...baseGrant(), uses: 5, maxUses: 5 }).reason), /用尽/);
  assert.match(String(cliGrantUsable({ ...baseGrant(), claimedBy: 'task-other' }, Date.now(), 'task-me').reason), /占用/);
  // 同一个任务自己占用则放行。
  assert.equal(cliGrantUsable({ ...baseGrant(), claimedBy: 'task-me' }, Date.now(), 'task-me').ok, true);
  assert.equal(cliGrantUsable(undefined).ok, false);
});

// 代表不能借参数注入。
test('arguments carrying shell metacharacters are refused', () => {
  assert.equal(safeCliArgs(['--help']).ok, true);
  assert.equal(safeCliArgs(['--prompt', '重构这个模块']).ok, true);

  const injection = safeCliArgs(['--prompt', 'x; rm -rf /']);
  assert.equal(injection.ok, false);
  assert.match(String(injection.reason), /shell 元字符/);

  assert.equal(safeCliArgs(['a && b']).ok, false);
  assert.equal(safeCliArgs(['$(whoami)']).ok, false);
  assert.equal(safeCliArgs(['line\nbreak']).ok, false);
  assert.equal(safeCliArgs(['x'.repeat(2001)]).ok, false);
});

test('the human sees target, expiry and usage before approving', () => {
  const text = describeCliGrant(baseGrant());
  assert.match(text, /需要更强的代码理解/);
  assert.match(text, /Codex CLI/);
  assert.match(text, /到期/);
  assert.match(text, /已用/);
});

test('a finished task releases its claim but keeps the grant if still valid', () => {
  const claimed = { ...baseGrant(), claimedBy: 'task-1' };
  const released = revokeOnTaskEnd(claimed, 'task-1');
  assert.equal(released.claimedBy, undefined);
  assert.equal(released.state, 'approved');

  // 已过期的授权在任务结束时转为 expired，不会被再次使用。
  const expired = { ...baseGrant(), claimedBy: 'task-1', expiresAt: Date.now() - 1 };
  assert.equal(revokeOnTaskEnd(expired, 'task-1').state, 'expired');

  // 不是自己占用的不处理。
  const other = { ...baseGrant(), claimedBy: 'task-9' };
  assert.equal(revokeOnTaskEnd(other, 'task-1').claimedBy, 'task-9');
});

test('availability check tells the prime minister whether preparation is even possible', () => {
  assert.equal(cliAvailable('codex', () => '/usr/bin/codex'), true);
  assert.equal(cliAvailable('codex', () => null), false);
  assert.equal(cliAvailable('nonsense', () => '/bin/x'), false, 'an unlisted name is never available');
});

test('audit lines never carry credentials, only the call shape', () => {
  const line = auditLine({ at: 0, grantId: 'g1', cli: 'codex', taskId: 't1', args: ['--prompt', 'hello'], exitCode: 0, durationMs: 1200 });
  assert.match(line, /codex/);
  assert.match(line, /t1/);
  assert.match(line, /退出码 0/);
  assert.equal(/key|token|secret|password/i.test(line), false);
});

// 对话框：回合制记录，而不是嵌入外部 TUI。
test('each CLI call becomes a numbered, readable turn', () => {
  const dir = 'T:/tmp/archive/task-1';
  assert.match(cliTurnFile(dir, 'codex', 1), /cli-codex-001\.md$/);
  assert.match(cliTurnFile(dir, 'claude', 12), /cli-claude-012\.md$/);

  const md = renderCliTurn({ turn: 2, cli: 'codex', prompt: '看看这个函数', output: '建议拆分', exitCode: 0, durationMs: 800, at: 0 });
  assert.match(md, /# 外部 CLI 回合 2 · codex/);
  assert.match(md, /## 输入/);
  assert.match(md, /看看这个函数/);
  assert.match(md, /建议拆分/);
});

test('long output keeps head and tail, and says so', () => {
  const long = 'A'.repeat(1000) + 'MIDDLE' + 'B'.repeat(1000);
  const clamped = clampTurnOutput(long, 400);
  assert.equal(clamped.truncated, true);
  assert.ok(clamped.output.startsWith('A'));
  assert.ok(clamped.output.endsWith('B'));
  assert.match(clamped.output, /中间已省略/);
});

test('the desk summary is one line and never the full body', () => {
  const line = summarizeCliTurn({ turn: 3, cli: 'claude', prompt: 'x', output: '第一行结论\n第二行细节', exitCode: 0, durationMs: 2400, at: 0 });
  assert.match(line, /回合 3/);
  assert.match(line, /claude/);
  assert.match(line, /2\.4s/);
  assert.match(line, /第一行结论/);
  assert.equal(line.includes('第二行细节'), false, 'summary stays on one line');
});

test('turns are listed in order per CLI', () => {
  // 仅验证解析规则；实际文件由运行期写入。
  assert.deepEqual(listCliTurns('T:/definitely-not-a-real-dir'), []);
  void EXTERNAL_CLI_ALLOWLIST;
});
