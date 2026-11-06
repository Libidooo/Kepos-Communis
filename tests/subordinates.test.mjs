import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-sub-home-'));

const {KeposDatabase}=await import('../dist/terminal/database.js');
const {
  subordinateGate, decideSpawn, SubordinateApprovals,
  MAX_SUBORDINATES_PER_REPRESENTATIVE, SUBORDINATE_APPROVAL_THRESHOLD,
} = await import('../dist/terminal/subordinates.js');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kepos-sub-'));
  const db = new KeposDatabase(join(dir, 'k.sqlite'));
  const add = (id, opts = {}) => db.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,NULL)').run(
    id, 'parent', 'c-' + id, 'h', 'e', opts.state || 'RUNNING',
    JSON.stringify({
      id, agent: '审查官', state: opts.state || 'RUNNING', status: '运行中', title: 't',
      cwd: '.', session: 's', parentSessionId: 'parent', correlationId: 'c', started: 1,
      output: '', limit: 60, model: 'm', provider: 'p', ownerPid: 1, ownerEpoch: 'e',
      tools: ['read'], skills: [], mcp: false, parentWorkerId: opts.parent || 'rep1',
    }));
  const finish = id => db.prepare("UPDATE workers SET receipt='{}', state='SUCCEEDED' WHERE id=?").run(id);
  return { db, add, finish };
}

test('under three subordinates a representative may spawn freely', () => {
  const { db, add } = fixture();
  try {
    for (let i = 0; i < SUBORDINATE_APPROVAL_THRESHOLD - 1; i++) add('s' + i);
    const gate = subordinateGate(db, 'rep1');
    assert.equal(gate.live, 2);
    assert.equal(gate.allowed, true);
    assert.equal(gate.approvalRequired, false);
    assert.equal(decideSpawn(db, 'rep1', { agent: '审查官', task: 'x' }).action, 'spawn');
  } finally { db.close(); }
});

// 三个人是一支小队；第四个代表它已经在另开一条工作线。
test('the fourth concurrent subordinate requires human approval', () => {
  const { db, add } = fixture();
  try {
    for (let i = 0; i < SUBORDINATE_APPROVAL_THRESHOLD; i++) add('s' + i);
    const gate = subordinateGate(db, 'rep1');
    assert.equal(gate.live, 3);
    assert.equal(gate.allowed, true, 'not refused outright');
    assert.equal(gate.approvalRequired, true);
    const decision = decideSpawn(db, 'rep1', { agent: '审查官', task: '第四条线' });
    assert.equal(decision.action, 'approve');
    assert.match(decision.reason, /需要人类批准/);
  } finally { db.close(); }
});

// 跑完的不占并发，也不占注意力：门槛按"同时"而不是"累计"。
test('finished subordinates do not count against the threshold', () => {
  const { db, add, finish } = fixture();
  try {
    for (let i = 0; i < 5; i++) add('s' + i);
    for (let i = 0; i < 4; i++) finish('s' + i);
    const gate = subordinateGate(db, 'rep1');
    assert.equal(gate.live, 1, 'only the unfinished one counts');
    assert.equal(gate.approvalRequired, false);
    assert.equal(decideSpawn(db, 'rep1', { agent: '审查官', task: 'x' }).action, 'spawn');
  } finally { db.close(); }
});

test('the hard cap refuses rather than asking for approval', () => {
  const { db, add } = fixture();
  try {
    for (let i = 0; i < MAX_SUBORDINATES_PER_REPRESENTATIVE; i++) add('s' + i);
    const gate = subordinateGate(db, 'rep1');
    assert.equal(gate.allowed, false, 'a sixth-plus is refused, not escalated');
    assert.equal(gate.approvalRequired, false, 'no point asking the human');
    const decision = decideSpawn(db, 'rep1', { agent: '审查官', task: 'x' });
    assert.equal(decision.action, 'refuse');
    assert.match(decision.reason, /最多/);
  } finally { db.close(); }
});

// 一个批准只放行一次派生，否则批一次就能无限派。
test('an approval is consumed by exactly one spawn', () => {
  const { db, add } = fixture();
  try {
    for (let i = 0; i < 3; i++) add('s' + i);
    assert.equal(decideSpawn(db, 'rep1', { agent: '审查官', task: 'a' }).action, 'approve');
    const approvals = new SubordinateApprovals(db);
    const pending = approvals.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].agent, '审查官');
    assert.equal(pending[0].live, 3);

    approvals.decide(pending[0].id, true);
    assert.equal(decideSpawn(db, 'rep1', { agent: '审查官', task: 'a' }).action, 'spawn', 'the grant is usable');
    // 批准在被消费前一直有效：派生失败（预算、槽位）也不吞掉人类的批准。
    assert.ok(approvals.approved('rep1'), 'grant survives until explicitly consumed');
    approvals.consume(approvals.approved('rep1').id);
    assert.equal(decideSpawn(db, 'rep1', { agent: '审查官', task: 'a' }).action, 'approve', 'and it is gone after consumption');
  } finally { db.close(); }
});

test('denying a request does not leave it pending forever', () => {
  const { db, add } = fixture();
  try {
    for (let i = 0; i < 3; i++) add('s' + i);
    decideSpawn(db, 'rep1', { agent: '审查官', task: 'a' });
    const approvals = new SubordinateApprovals(db);
    const pending = approvals.pending()[0];
    approvals.decide(pending.id, false);
    assert.equal(approvals.pending().length, 0, 'a denial clears the queue');
    assert.equal(approvals.approved('rep1'), undefined);
    // 拒绝之后可以重新提出——人可能只是想先看看第一个跑得怎么样。
    assert.equal(decideSpawn(db, 'rep1', { agent: '审查官', task: 'b' }).action, 'approve');
  } finally { db.close(); }
});

// 同一代表的重复请求不排队：否则一分钟轮询一次会积压几十条同样的请求。
test('repeated asks collapse into one pending request', () => {
  const { db, add } = fixture();
  try {
    for (let i = 0; i < 3; i++) add('s' + i);
    for (let n = 0; n < 5; n++) decideSpawn(db, 'rep1', { agent: '审查官', task: 'same' });
    const approvals = new SubordinateApprovals(db);
    assert.equal(approvals.pending().length, 1, 'one question, not five');
  } finally { db.close(); }
});

test('each representative has its own count', () => {
  const { db, add } = fixture();
  try {
    for (let i = 0; i < 3; i++) add('s' + i, { parent: 'rep1' });
    add('other1', { parent: 'rep2' });
    assert.equal(subordinateGate(db, 'rep1').live, 3);
    assert.equal(subordinateGate(db, 'rep2').live, 1);
    assert.equal(decideSpawn(db, 'rep2', { agent: '勘察官', task: 'x' }).action, 'spawn', 'rep2 is unaffected');
  } finally { db.close(); }
});
