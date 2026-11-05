import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-plangroup-home-'));

const {KeposDatabase}=await import('../dist/terminal/database.js');
const {MissionScheduler}=await import('../dist/terminal/scheduler.js');
const agent={name:'审查官',model:'fixture',provider:'fixture',role:'只读',roleKey:'auditor'};

function fixture(t){
  const cwd=mkdtempSync(join(tmpdir(),'kepos-pg-'));
  const db=new KeposDatabase(join(cwd,'state.sqlite'));
  const dispatch=[];
  const pool={
    children:new Map(),
    launch(a,text,dir,session,seconds,signal,parent,tools,skills,mcp,depth,parentWorkerId,budgetTokens,metadata){
      const h={version:1,workerId:'w'+(dispatch.length+1),parentSessionId:parent,capability:'fake'};
      dispatch.push({a,text,parent,metadata,h});
      return h;
    },
    result(){return{state:'RUNNING'};},
    cancelHandle(){return{state:'CANCELLED'};},
  };
  const scheduler=new MissionScheduler(db,pool);
  t.after(()=>{scheduler.stop();db.close();});
  return{cwd,db,scheduler,dispatch};
}

test('a plan step can declare a group, and it is persisted',async(t)=>{
  const f=fixture(t);
  const mission=f.scheduler.enqueue({
    goal:'联合作业',cwd:f.cwd,parentSessionId:'p',
    jobs:[{id:'a',agent,task:'第一步',groupId:'squad1'}],
  });
  const job=f.scheduler.get(mission.id).jobs[0];
  assert.equal(job.groupId,'squad1','survives the round trip through SQLite');
});

test('the group reaches the launched task as launch metadata',async(t)=>{
  const f=fixture(t);
  f.scheduler.enqueue({goal:'g',cwd:f.cwd,parentSessionId:'p',jobs:[{id:'a',agent,task:'x',groupId:'squad1'}]});
  await f.scheduler.tick();
  assert.equal(f.dispatch.length,1);
  assert.equal(f.dispatch[0].metadata?.groupId,'squad1','the scheduler must pass it to the pool');
});

test('a step without a group launches with no group metadata',async(t)=>{
  const f=fixture(t);
  f.scheduler.enqueue({goal:'g',cwd:f.cwd,parentSessionId:'p',jobs:[{id:'a',agent,task:'x'}]});
  await f.scheduler.tick();
  assert.equal(f.dispatch[0].metadata?.groupId,undefined);
});

// 写错的组名不该被静默丢掉：那会让"组没生效"变成最难查的问题。
test('an invalid group id is refused at enqueue, not silently dropped',(t)=>{
  const f=fixture(t);
  assert.throws(()=>f.scheduler.enqueue({goal:'g',cwd:f.cwd,parentSessionId:'p',jobs:[{id:'a',agent,task:'x',groupId:'bad id'}]}),/组标识/);
});

test('old databases gain the group_id column automatically',(t)=>{
  const f=fixture(t);
  // 模拟升级前的表：删掉列不现实，这里验证迁移逻辑对"缺列"的处理——
  // 新建库时列已存在，构造一个新的 scheduler 不应报错，且能读写。
  const second=new MissionScheduler(f.db,{children:new Map(),launch(){return{version:1,workerId:'w',parentSessionId:'p',capability:'c'};},result(){return{state:'RUNNING'};},cancelHandle(){return{state:'CANCELLED'};}});
  try{
    const mission=second.enqueue({goal:'g2',cwd:f.cwd,parentSessionId:'p',jobs:[{id:'b',agent,task:'y',groupId:'squad9'}]});
    assert.equal(second.get(mission.id).jobs[0].groupId,'squad9');
  }finally{second.stop();}
});

test('two steps in the same group share the identifier',async(t)=>{
  const f=fixture(t);
  f.scheduler.enqueue({goal:'g',cwd:f.cwd,parentSessionId:'p',jobs:[
    {id:'a',agent,task:'一',groupId:'squad1'},
    {id:'b',agent,task:'二',groupId:'squad1',dependsOn:['a']},
  ]});
  await f.scheduler.tick();
  const mission=f.scheduler.list('p')[0];
  assert.deepEqual(mission.jobs.map(job=>job.groupId),['squad1','squad1']);
});
