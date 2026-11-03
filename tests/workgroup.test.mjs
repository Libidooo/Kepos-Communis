import test from 'node:test';
import assert from 'node:assert/strict';

const {
  splitEvidenceAndConclusion, extractVote, visibleToPeer, canReadPeer,
  debatePlan, debateNeedsHuman, DEBATE_ROUNDS, DEBATE_FINAL_ROUND,
} = await import('../dist/terminal/workgroup.js');

const structured = `working notes
read src/a.ts
ran tests

## 结论
发现三处越权读取。
## 证据
src/a.ts:42
## 置信度
高 — 本地已复现
## 需要
无`;

test('evidence and conclusion are split at the output contract heading', () => {
  const { evidence, conclusion } = splitEvidenceAndConclusion(structured);
  assert.match(evidence, /ran tests/);
  assert.equal(evidence.includes('## 结论'), false, 'conclusion is removed from evidence');
  assert.match(conclusion, /^## 结论/);
  assert.match(conclusion, /发现三处越权读取/);
});

test('output without the contract is treated entirely as evidence', () => {
  // 宁可少给结论，也不把工作过程误判成结论。
  const { evidence, conclusion } = splitEvidenceAndConclusion('plain notes only');
  assert.equal(conclusion, '');
  assert.equal(evidence, 'plain notes only');
});

test('votes are extracted from the conclusion block', () => {
  assert.deepEqual(extractVote('... VOTE: yes - 证据充分'), { vote: 'yes', reason: '证据充分' });
  assert.deepEqual(extractVote('VOTE: abstain'), { vote: 'abstain', reason: undefined });
  assert.deepEqual(extractVote('no vote here'), {});
});

// 核心约束：同组可见的是证据，结论必须各自独立形成。
test('a peer sees evidence but never the other side conclusion', () => {
  const member = { taskId: 't1', agent: '审查官', state: 'RUNNING', started: 1 };
  const view = visibleToPeer(member, structured, 1000);
  assert.equal(view.agent, '审查官');
  assert.match(view.evidence, /ran tests/);
  assert.equal(view.evidence.includes('发现三处越权读取'), false, 'conclusion text is withheld from peers');
  assert.equal(view.evidence.includes('## 结论'), false, 'headings are stripped along with the conclusion');
});

test('same-group reads allowed, cross-group requires escalation', () => {
  const peer = canReadPeer({ groupId: 'g1' }, { groupId: 'g1' });
  assert.equal(peer.allowed, true);
  assert.equal(peer.scope, 'group');

  const cross = canReadPeer({ groupId: 'g1' }, { groupId: 'g2' });
  assert.equal(cross.allowed, false);
  assert.match(cross.reason, /跨组/);

  // 授权后（canCrossGroup）才放行，且仍标记为跨组。
  const granted = canReadPeer({ groupId: 'g1', canCrossGroup: true }, { groupId: 'g2' });
  assert.equal(granted.allowed, true);
  assert.equal(granted.scope, 'cross-group');
});

test('a member without a group cannot be treated as a peer', () => {
  const result = canReadPeer({}, { groupId: 'g1' });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /工作小组/);
});

test('debate runs three exchanges then a full-group poll', () => {
  const plan = debatePlan('是否发布', ['正方', '反方']);
  assert.equal(plan.length, DEBATE_FINAL_ROUND);
  assert.deepEqual(plan.map(round => round.round), [1, 2, 3, 4]);
  assert.deepEqual(plan.map(round => round.kind), ['opening', 'rebuttal', 'closing', 'final-poll']);
  assert.equal(DEBATE_ROUNDS, 3);
  // 第四轮明确要求全组表态并带 VOTE 行，供上级汇总。
  assert.match(plan[3].instruction, /全组每位代表/);
  assert.match(plan[3].instruction, /VOTE:/);
  // 前三轮是交锋，不应要求投票。
  assert.equal(/VOTE:/.test(plan[0].instruction), false);
});

test('a hung branch is told which evidence would change its mind', () => {
  const plan = debatePlan('议题', ['A', 'B']);
  assert.match(plan[2].instruction, /什么证据会让我改变判断/);
});

test('the human is asked to watch the contentious rounds', () => {
  assert.equal(debateNeedsHuman('opening'), false);
  assert.equal(debateNeedsHuman('rebuttal'), true, 'cross-examination needs observation');
  assert.equal(debateNeedsHuman('final-poll'), true, 'the poll needs a human decision');
});
