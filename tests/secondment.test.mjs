import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-secondment-home-'));

const {
  SECONDMENT_SECONDS, MAX_SECONDMENTS_PER_GROUP,
  secondmentActive, canRequestSecondment, validateSecondment, createSecondment,
  effectiveGroups, expiredSecondments, describeSecondmentRequest, SecondmentStore,
}=await import('../dist/terminal/secondment.js');
const {KeposDatabase}=await import('../dist/terminal/database.js');

const fresh=()=>new KeposDatabase(join(mkdtempSync(join(tmpdir(),'kepos-sc-')),'k.sqlite'));
const make=(over={})=>createSecondment({agentId:'a1',agent:'审查官',fromGroup:'g-project-b',toGroup:'g-project-a',reason:'需要鉴权审查经验',requestedBy:'总代甲',now:1000,...over});

// 只有代理总代能发起跨组借调：普通代表自己拉人会绕开治理链。
test('only the deputy chair may request a cross-group secondment',()=>{
  assert.equal(canRequestSecondment({}).allowed,false);
  assert.match(canRequestSecondment({}).reason,/没有在任的代理总代/);
  assert.equal(canRequestSecondment({requesterTaskId:'t1',deputyTaskId:'t2'}).allowed,false);
  assert.match(canRequestSecondment({requesterTaskId:'t1',deputyTaskId:'t2'}).reason,/只有代理总代/);
  assert.equal(canRequestSecondment({requesterTaskId:'t2',deputyTaskId:'t2'}).allowed,true);
});

test('a secondment requires a real reason and a different target group',()=>{
  const base={agentId:'a1',fromGroup:'b',toGroup:'a',reason:'需要它',existing:[]};
  assert.equal(validateSecondment(base).ok,true);
  assert.match(validateSecondment({...base,reason:'  '}).reason,/必须说明原因/);
  assert.match(validateSecondment({...base,toGroup:'b'}).reason,/相同/);
  assert.match(validateSecondment({...base,agentId:''}).reason,/缺少被借调的代表/);
});

test('a group cannot accumulate borrowed people without limit',()=>{
  const live=[1,2,3].map(n=>make({agentId:`a${n}`,agent:`人${n}`}));
  const result=validateSecondment({agentId:'a4',fromGroup:'b',toGroup:'g-project-a',reason:'x',existing:live,now:2000});
  assert.equal(result.ok,false);
  assert.match(result.reason,new RegExp(String(MAX_SECONDMENTS_PER_GROUP)));
});

test('the same person cannot be borrowed into two groups at once',()=>{
  const live=[make({agentId:'a1',toGroup:'g-project-a'})];
  const result=validateSecondment({agentId:'a1',fromGroup:'b',toGroup:'g-project-c',reason:'x',existing:live,now:2000});
  assert.equal(result.ok,false);
  assert.match(result.reason,/已在组/);
});

// "临时"不能靠人记得收回：到期即失效，判断只有一处。
test('a secondment expires on its own',()=>{
  const item=make();
  assert.equal(secondmentActive(item,1000).active,true);
  const justBefore=item.expiresAt-1;
  assert.equal(secondmentActive(item,justBefore).active,true);
  assert.equal(secondmentActive(item,item.expiresAt).active,false);
  assert.match(secondmentActive(item,item.expiresAt).reason,/到期/);
  assert.equal(SECONDMENT_SECONDS,3600);
});

test('effective groups include the borrowed group only while it is live',()=>{
  const item=make();
  assert.deepEqual(effectiveGroups({homeGroup:'g-project-b',secondments:[item],agentId:'a1',now:2000}),['g-project-b','g-project-a']);
  // 到期后回到原本的组。
  assert.deepEqual(effectiveGroups({homeGroup:'g-project-b',secondments:[item],agentId:'a1',now:item.expiresAt}),['g-project-b']);
  // 别的代表的借调不影响它。
  assert.deepEqual(effectiveGroups({homeGroup:'x',secondments:[item],agentId:'a2',now:2000}),['x']);
});

test('expired entries are reported so they can be reclaimed',()=>{
  const live=make({agentId:'a1'});
  const stale=make({agentId:'a2',now:0});
  const expired=expiredSecondments([live,stale],live.expiresAt+1);
  assert.deepEqual(expired.map(item=>item.agentId),['a1','a2']);
  assert.deepEqual(expiredSecondments([live],1000),[]);
});

test('the request description states it grants no extra power',()=>{
  const text=describeSecondmentRequest({agent:'审查官',fromGroup:'g-b',toGroup:'g-a',reason:'需要鉴权经验',requestedBy:'总代甲'});
  assert.match(text,/代理总代「总代甲」/);
  assert.match(text,/组 g-b/);
  assert.match(text,/组 g-a/);
  assert.match(text,/借调不扩权/);
  assert.match(text,/无需上报人类/,'the approval stops at the prime minister');
});

// 收回用标记而不是删除：这个人曾经被借到哪，事后要能回溯。
test('releasing keeps the record',()=>{
  const db=fresh();
  try{
    const store=new SecondmentStore(db);
    const item=make();
    store.add(item);
    assert.equal(store.active(2000).length,1);
    assert.equal(store.forAgent('a1',2000)?.id,item.id);
    assert.equal(store.release(item.id,3000),true);
    assert.equal(store.active(4000).length,0,'released secondments are no longer active');
    assert.equal(store.release(item.id,5000),false,'releasing twice is a no-op');
    // 行还在，便于回溯。
    const rows=db.prepare('SELECT COUNT(*) c FROM secondments').get();
    assert.equal(rows.c,1);
  }finally{db.close();}
});

test('reaping marks every expired row and reports them once',()=>{
  const db=fresh();
  try{
    const store=new SecondmentStore(db);
    const live=make({agentId:'a1',now:Date.now()});
    const stale=make({agentId:'a2',now:1000});
    store.add(live);store.add(stale);
    const reaped=store.reapExpired(Date.now());
    assert.equal(reaped.length,1,'only the expired one is reclaimed');
    assert.equal(reaped[0].agentId,'a2');
    assert.equal(store.active().length,1,'the live one survives');
    assert.deepEqual(store.reapExpired(Date.now()),[],'reaping twice returns nothing');
  }finally{db.close();}
});
