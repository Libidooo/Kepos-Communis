import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-bud-home-'));

const {KeposDatabase}=await import('../dist/terminal/database.js');
const {
  BudgetEscalations, shouldEscalate, budgetStopReport, ownerSteerText, redispatchInstruction,
  MAX_ESCALATION_TASK_CHARS,
} = await import('../dist/terminal/budget-escalation.js');

const fresh=()=>new KeposDatabase(join(mkdtempSync(join(tmpdir(),'kepos-bud-')),'k.sqlite'));
const raise=(db,over={})=>new BudgetEscalations(db).raise({taskId:'t1',parentSessionId:'s1',agent:'策略官',agentId:'a1',task:'核对结构与说明',spent:12000,cap:3000,digest:'第一步…',...over});

// 人类的裁定：截停必须立案回传，而不是留一行没人管的警告。
test('a budget stop files exactly one pending case per task',()=>{
  const db=fresh();
  try{
    const store=new BudgetEscalations(db);
    const first=raise(db);
    assert.equal(raise(db),first,'same task raises once');
    assert.equal(store.pending().length,1);
    raise(db,{taskId:'t2'});
    assert.equal(store.pending().length,2,'another task is another case');
  }finally{db.close();}
});

test('the premier proposes only on pending cases and only with a sane amount',()=>{
  const db=fresh();
  try{
    const store=new BudgetEscalations(db);
    const id=raise(db);
    assert.equal(store.propose(id,500),false,'below the 1000 floor');
    assert.equal(store.propose(id,30000,'议会提示词很大'),true);
    const item=store.pending()[0];
    assert.equal(item.proposal,30000);
    assert.equal(item.proposedBy,'premier');
    store.decide(id,true);
    assert.equal(store.propose(id,40000),false,'decided cases take no more proposals');
  }finally{db.close();}
});

// launch 失败时批准不蒸发：先 launch 后记账，失败案件仍待批。
test('approve then dispatch; a denial clears the queue',()=>{
  const db=fresh();
  try{
    const store=new BudgetEscalations(db);
    const id=raise(db);
    assert.equal(store.pending().length,1,'still pending before any decision');
    store.decide(id,false);
    assert.equal(store.pending().length,0,'denial clears the queue');
    const id2=raise(db,{taskId:'t3'});
    assert.equal(store.decide(id2,true),true);
    assert.equal(store.markDispatched(id2),true,'dispatched only after a successful launch');
    assert.equal(db.prepare("SELECT state FROM budget_escalations WHERE id=?").get(id2).state,'dispatched');
    assert.equal(store.markDispatched(id2),false,'cannot dispatch twice');
  }finally{db.close();}
});

test('watch auto-dispatches are not escalated',()=>{
  assert.equal(shouldEscalate({purpose:'watch'}),false);
  assert.equal(shouldEscalate({purpose:'delegation'}),true);
  assert.equal(shouldEscalate({}),true);
});

test('the premier report carries the facts and the discipline',()=>{
  const text=budgetStopReport({escalationId:'be_1',agent:'策略官',taskId:'t1',spent:12000,cap:3000,title:'核对结构',digest:'要点：a',owner:'工程官'});
  assert.match(text,/12000 \/ 上限 3000/);
  assert.match(text,/be_1/);
  assert.match(text,/kepos_budget/);
  assert.match(text,/「工程官」的僚属/);
  assert.match(text,/不要声称人类已批准/);
  const plain=budgetStopReport({escalationId:'be_2',agent:'策略官',taskId:'t2',spent:1,cap:2,title:'x'});
  assert.equal(/僚属/.test(plain),false,'no owner line for direct mandates');
});

test('the owner steer asks for assessment and forbids self-redispatch',()=>{
  const text=ownerSteerText({agent:'勘察官',taskId:'t9',spent:8000,cap:2000});
  assert.match(text,/勘察官/);
  assert.match(text,/不要自行重派/);
});

test('the redispatch instruction continues the old task instead of restarting',()=>{
  const text=redispatchInstruction({taskId:'t1',agent:'策略官',spent:12000,cap:3000,newCap:30000,title:'核对 README 与结构是否一致',digest:'已核对 3 节'});
  assert.match(text,/30000/);
  assert.match(text,/核对 README 与结构是否一致/);
  assert.match(text,/已核对 3 节/);
  assert.match(text,/不要从头再来/);
});

test('long task text is truncated at filing',()=>{
  const db=fresh();
  try{
    const store=new BudgetEscalations(db);
    store.raise({taskId:'tl',parentSessionId:'s',agent:'A',task:'x'.repeat(2000),spent:1,cap:1});
    const item=store.pending()[0];
    assert.ok(item.task.length<=MAX_ESCALATION_TASK_CHARS+1,'filing keeps the queue readable');
  }finally{db.close();}
});

// 0.5.1：演习反馈——立案被核销后 propose 只返回"不存在"，总理无从判断去向。
// stateOf 现在报出终态；propose 打到已决案时错误信息带上去向说明。
test('stateOf reports where a decided escalation went', () => {
  const db = fresh();
  try {
    const store = new BudgetEscalations(db);
    const id = raise(db);
    assert.equal(store.stateOf(id)?.state, 'pending');
    store.decide(id, false);
    assert.equal(store.stateOf(id)?.state, 'denied', 'denied is visible');
    assert.ok(store.stateOf(id)?.decidedAt, 'decision time is kept');
    assert.equal(store.propose(id, 50000), false, 'proposing to a decided case fails');
    assert.equal(store.stateOf('nope'), undefined, 'unknown ids are undefined');
  } finally { db.close(); }
});
