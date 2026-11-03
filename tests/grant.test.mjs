import test from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeRequestedTools, validateGrantRequest, canDelegate, grantActive,
  describeForHuman,
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
