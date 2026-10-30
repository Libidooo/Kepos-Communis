import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {OrbitalDatabase} from '../dist/terminal/database.js';
import {MissionScheduler} from '../dist/terminal/scheduler.js';
const agent={name:'Expert',model:'fixture',provider:'fixture',role:'read only'};
function fixture(t,options={}){
 const cwd=mkdtempSync(join(tmpdir(),'kepos-dag-'));const db=new OrbitalDatabase(join(cwd,'state.sqlite'));
 const records=new Map(),dispatch=[],cancelled=[];
 const pool={children:new Map(),launch(a,text,dir,session,seconds,signal,parent,tools){const id='w'+(dispatch.length+1);const h={version:1,workerId:id,parentSessionId:parent,capability:'fake'};dispatch.push({a,text,dir,parent,seconds,tools,h});records.set(id,{state:'RUNNING'});return h;},result(h,p){assert.equal(h.parentSessionId,p);return records.get(h.workerId)||{state:'UNKNOWN_HANDLE'};},cancelHandle(h){cancelled.push(h.workerId);records.set(h.workerId,{state:'CANCELLED'});return{state:'CANCELLED'};}};
 const scheduler=new MissionScheduler(db,pool,options);t.after(()=>{scheduler.stop();db.close();});
 const enqueue=(jobs,goal='fixture')=>scheduler.enqueue({goal,cwd,parentSessionId:'parent',jobs});
 return{cwd,db,pool,scheduler,enqueue,records,dispatch,cancelled,done(index,output='evidence'){records.set(dispatch[index].h.workerId,{state:'SUCCEEDED',output,resultHash:'hash'});}};
}

test('same local job ID works in different plans; repeated ticks do not duplicate launches',async t=>{
 const f=fixture(t,{concurrency:2});const a=f.enqueue([{id:'scan',agent,task:'one'}]);const b=f.enqueue([{id:'scan',agent,task:'two'}]);
 await Promise.all([f.scheduler.tick(),f.scheduler.tick()]);await f.scheduler.tick();assert.equal(f.dispatch.length,2);assert.equal(f.scheduler.get(a.id).jobs[0].id,'scan');assert.notEqual(f.scheduler.get(a.id).jobs[0].key,f.scheduler.get(b.id).jobs[0].key);
});
test('DAG waits for dependencies and passes bounded evidence to the next step',async t=>{
 const f=fixture(t);const m=f.enqueue([{id:'scan',agent,task:'scan'},{id:'review',agent,task:'review',dependsOn:['scan']}]);
 await f.scheduler.tick();assert.equal(f.dispatch.length,1);f.done(0,'evidence-123');await f.scheduler.tick();assert.equal(f.dispatch.length,2);assert.match(f.dispatch[1].text,/evidence-123/);
 f.done(1);await f.scheduler.tick();assert.equal(f.scheduler.get(m.id).state,'SUCCEEDED');await f.scheduler.tick();assert.equal(f.dispatch.length,2);
});
test('human gate never starts until explicitly approved, and failure cannot be approved as a retry',async t=>{
 const f=fixture(t);const m=f.enqueue([{id:'approval',agent,task:'check',requiresHuman:true}]);await f.scheduler.tick();assert.equal(f.dispatch.length,0);assert.equal(f.scheduler.get(m.id).state,'NEEDS_HUMAN');
 assert.throws(()=>f.scheduler.approve(m.id,'foreign'),/Unknown/);f.scheduler.approve(m.id,'parent','approval');await f.scheduler.tick();assert.equal(f.dispatch.length,1);
 f.records.set(f.dispatch[0].h.workerId,{state:'FAILED',error:'bad'});await f.scheduler.tick();assert.equal(f.scheduler.get(m.id).state,'NEEDS_HUMAN');assert.throws(()=>f.scheduler.approve(m.id,'parent'),/explicit new/);await f.scheduler.tick();assert.equal(f.dispatch.length,1);
});
test('steps longer than twenty minutes are automatically placed behind a human gate',async t=>{
 const f=fixture(t);const m=f.enqueue([{id:'long',agent,task:'long running review',seconds:1201}]);await f.scheduler.tick();assert.equal(f.dispatch.length,0);assert.equal(f.scheduler.get(m.id).jobs[0].state,'NEEDS_HUMAN');assert.equal(f.scheduler.get(m.id).jobs[0].requiresHuman,true);
});
test('paused mission drains its active job and dispatches no dependent work',async t=>{
 const f=fixture(t);const m=f.enqueue([{id:'a',agent,task:'a'},{id:'b',agent,task:'b',dependsOn:['a']}]);await f.scheduler.tick();f.scheduler.pause(m.id,'parent');f.done(0);await f.scheduler.tick();assert.equal(f.dispatch.length,1);assert.equal(f.scheduler.get(m.id).jobs[0].state,'SUCCEEDED');assert.equal(f.scheduler.get(m.id).state,'PAUSED');
 f.scheduler.resume(m.id,'parent');await f.scheduler.tick();assert.equal(f.dispatch.length,2);
});
test('global scheduler budget holds across missions and rotates plans',async t=>{
 const f=fixture(t,{concurrency:1});const a=f.enqueue([{id:'a',agent,task:'A1'},{id:'b',agent,task:'A2'}]);const b=f.enqueue([{id:'a',agent,task:'B1'}]);
 await f.scheduler.tick();assert.equal(f.dispatch.length,1);f.done(0);await f.scheduler.tick();assert.equal(f.dispatch.length,2);assert.match(f.dispatch[1].text,/B1/);f.done(1);await f.scheduler.tick();assert.match(f.dispatch[2].text,/A2/);
});
test('queued worker result is not mistaken for job failure',async t=>{
 const f=fixture(t);const m=f.enqueue([{agent,task:'queued at worker'}]);await f.scheduler.tick();f.records.set(f.dispatch[0].h.workerId,{state:'QUEUED'});await f.scheduler.tick();assert.equal(f.scheduler.get(m.id).state,'RUNNING');assert.equal(f.dispatch.length,1);
});
test('cancel and deadline stop future work and preserve successful output',async t=>{
 const f=fixture(t);const m=f.enqueue([{id:'a',agent,task:'a'},{id:'b',agent,task:'b',dependsOn:['a']}]);await f.scheduler.tick();f.scheduler.cancel(m.id,'parent');assert.equal(f.cancelled.length,1);await f.scheduler.tick();assert.equal(f.dispatch.length,1);assert.equal(f.scheduler.get(m.id).state,'CANCELLED');
 const timed=f.scheduler.enqueue({goal:'deadline',cwd:f.cwd,parentSessionId:'parent',deadlineSeconds:.01,jobs:[{agent,task:'time'}]});await new Promise(r=>setTimeout(r,20));await f.scheduler.tick();assert.equal(f.scheduler.get(timed.id).state,'NEEDS_HUMAN');assert.equal(f.dispatch.length,1);
});
test('unknown dispatch outcome after recovery requires a human instead of replay',async t=>{
 const f=fixture(t);const m=f.enqueue([{id:'a',agent,task:'a'}]);f.db.prepare("UPDATE mission_jobs SET state='RUNNING',handle=NULL WHERE mission_id=?").run(m.id);await f.scheduler.tick();assert.equal(f.dispatch.length,0);assert.equal(f.scheduler.get(m.id).state,'NEEDS_HUMAN');
});
test('another live scheduler cannot launch the same plan',async t=>{
 const f=fixture(t);const m=f.enqueue([{agent,task:'one'}]);await f.scheduler.tick();const other=new MissionScheduler(f.db,f.pool);try{await other.tick();assert.equal(f.dispatch.length,1);}finally{other.stop();}
 assert.throws(()=>f.scheduler.events(m.id,'wrong'),/Unknown/);const first=f.scheduler.events(m.id,'parent',0,1);assert.equal(first.events.length,1);assert.equal(first.hasMore,true);assert.ok(f.scheduler.events(m.id,'parent',first.nextCursor).events.every(event=>event.seq>first.nextCursor));
});

test('stopping a drained scheduler permits a new runner to continue a human-approved plan',async t=>{
 const f=fixture(t);const m=f.enqueue([{id:'gate',agent,task:'gate',requiresHuman:true}]);await f.scheduler.tick();f.scheduler.stop();
 const later=new MissionScheduler(f.db,f.pool);try{later.approve(m.id,'parent');await later.tick();assert.equal(f.dispatch.length,1);}finally{later.cancel(m.id,'parent');await later.tick();later.stop();}
});
test('mission scope only starts the explicitly selected plan',async t=>{
 const f=fixture(t);const a=f.enqueue([{agent,task:'A'}]);const b=f.enqueue([{agent,task:'B'}]);
 const scoped=new MissionScheduler(f.db,f.pool,{missionIds:[a.id]});try{await scoped.tick();assert.equal(f.dispatch.length,1);assert.match(f.dispatch[0].text,/Assigned step: A/);assert.equal(f.scheduler.get(b.id).state,'QUEUED');}finally{scoped.cancel(a.id,'parent');await scoped.tick();scoped.stop();}
});

test('dispatch persists a hashed capability, not the live one',async t=>{
 const f=fixture(t);const agentWithScope={...agent,readScope:'machine',readAllow:['C:/refs']};const m=f.enqueue([{id:'scan',agent:agentWithScope,task:'scan'}]);
 await f.scheduler.tick();assert.equal(f.dispatch.length,1);
 const row=f.db.prepare('SELECT handle FROM mission_jobs WHERE mission_id=?').get(m.id);
 const stored=JSON.parse(row.handle);
 assert.equal(stored.capability,createHash('sha256').update('fake').digest('hex'));
 assert.notEqual(stored.capability,f.dispatch[0].h.capability);
 // The dispatched worker keeps read-scope metadata for the sandbox flags.
 assert.equal(f.dispatch[0].a.readScope,'machine');
 assert.deepEqual(f.dispatch[0].a.readAllow,['C:/refs']);
});

test('reschedule adjusts queued step limits but never clears an existing gate',async t=>{
 const f=fixture(t);const m=f.enqueue([{id:'quick',agent,task:'quick',seconds:100},{id:'long',agent,task:'long',seconds:2400,requiresHuman:true}]);
 const plan=f.scheduler.get(m.id);
 const updated=f.scheduler.reschedule(m.id,'parent','quick',1800);
 assert.equal(updated.jobs.find(j=>j.id==='quick').seconds,1800);
 assert.equal(updated.jobs.find(j=>j.id==='quick').requiresHuman,true,'1800s is above the 20 minute gate');
 const lowered=f.scheduler.reschedule(m.id,'parent','quick',60);
 assert.equal(lowered.jobs.find(j=>j.id==='quick').seconds,60);
 assert.equal(lowered.jobs.find(j=>j.id==='quick').requiresHuman,true,'original explicit gate stays');
 assert.throws(()=>f.scheduler.reschedule(m.id,'parent','quick',0),/1-3600/);
 assert.throws(()=>f.scheduler.reschedule(m.id,'parent','missing',60),/未知步骤/);
});

test('planTree renders depth-first dependency order with state glyphs',async()=>{
 const {planTree}=await import('../dist/terminal/monitor.js');
 const jobs=[
  {id:'review',task:'review findings',state:'QUEUED',dependsOn:['scan']},
  {id:'scan',task:'scan sources',state:'SUCCEEDED',dependsOn:[]},
  {id:'gate',task:'await human',state:'NEEDS_HUMAN',dependsOn:['review']},
 ];
 const lines=planTree(jobs);
 assert.deepEqual(lines,[
  '✓ scan · scan sources',
  '  ○ review · review findings',
  '    ⚠ gate · await human · 等待人类审批',
 ]);
 // Orphans (unknown deps) and cycles degrade to roots instead of vanishing.
 const messy=planTree([
  {id:'a',task:'loop a',state:'RUNNING',dependsOn:['b']},
  {id:'b',task:'loop b',state:'RUNNING',dependsOn:['a']},
  {id:'c',task:'orphan',state:'FAILED',dependsOn:['ghost']},
 ]);
 assert.equal(messy.length,3);
 assert.match(messy.join('|'),/✕ c · orphan/);
});

// 与真实 WorkerPool 相同的授权契约：呈上的 capability 必须是原始值（池内哈希后比对）。
function secureFixture(t,options={}){
 const cwd=mkdtempSync(join(tmpdir(),'kepos-sec-'));const db=new OrbitalDatabase(join(cwd,'state.sqlite'));
 const raw=new Map(),records=new Map(),cancelled=[],dispatch=[];
 let next=0;
 const authorize=(h,p)=>{if(!h||h.parentSessionId!==p)return false;const stored=raw.get(h.workerId);return !!stored&&h.capability===stored;};
 const pool={children:new Map(),launch(a,text,dir,session,seconds,signal,parent){const id='w'+(++next);const capability='cap-'+id;const h={version:1,workerId:id,parentSessionId:parent,capability};raw.set(id,capability);records.set(id,{state:'RUNNING'});dispatch.push(h);return h;},result(h,p){return authorize(h,p)?(records.get(h.workerId)||{state:'UNKNOWN_HANDLE'}):{state:'UNKNOWN_HANDLE'};},cancelHandle(h,p){if(!authorize(h,p))return{state:'UNKNOWN_HANDLE'};cancelled.push(h.workerId);records.set(h.workerId,{state:'CANCELLED'});return{state:'CANCELLED'};}};
 const scheduler=new MissionScheduler(db,pool,options);t.after(()=>{scheduler.stop();db.close();});
 const enqueue=(jobs,goal='fixture')=>scheduler.enqueue({goal,cwd,parentSessionId:'parent',jobs});
 return{cwd,db,pool,scheduler,enqueue,raw,records,dispatch,cancelled};
}

test('mission steps present the raw capability to the pool and store only its hash',async t=>{
 const f=secureFixture(t);const m=f.enqueue([{id:'a',agent,task:'a'}]);
 await f.scheduler.tick();assert.equal(f.dispatch.length,1);
 const stored=JSON.parse(f.db.prepare('SELECT handle FROM mission_jobs WHERE id=?').get(m.id+':a').handle);
 const raw=f.raw.get(f.dispatch[0].workerId);
 assert.notEqual(stored.capability,raw,'the database never holds the live capability');
 assert.equal(stored.capability,createHash('sha256').update(raw).digest('hex'));
 f.records.set(f.dispatch[0].workerId,{state:'SUCCEEDED',output:'evidence',resultHash:'h'});
 await f.scheduler.tick();
 // 呈上原始 capability 才能通过真实授权；旧实现把哈希当 capability 呈上，任务被误判 FAILED。
 assert.equal(f.scheduler.get(m.id).jobs[0].state,'SUCCEEDED');
 assert.equal(f.scheduler.get(m.id).state,'SUCCEEDED');
});

test('cancel reaches the worker with the raw capability and settles the job',async t=>{
 const f=secureFixture(t);const m=f.enqueue([{id:'a',agent,task:'a'}]);
 await f.scheduler.tick();f.scheduler.cancel(m.id,'parent');
 assert.deepEqual(f.cancelled,[f.dispatch[0].workerId]);
 assert.equal(f.scheduler.get(m.id).jobs[0].state,'CANCELLED');
 assert.equal(f.scheduler.get(m.id).state,'CANCELLED');
});

test('a scheduler without the raw capability asks a human instead of faking a worker failure',async t=>{
 const f=secureFixture(t);const m=f.enqueue([{id:'a',agent,task:'a'}]);
 await f.scheduler.tick();
 f.scheduler.liveHandles.clear(); // 模拟重启后内存句柄丢失（库里的 handle 只有哈希）
 await f.scheduler.tick();
 const job=f.scheduler.get(m.id).jobs[0];
 assert.equal(job.state,'NEEDS_HUMAN');
 assert.match(job.error,/capability is not held/);
});

test('a fresh scheduler in the same process cancels through the pool live handle',async t=>{
 const f=secureFixture(t);const m=f.enqueue([{id:'a',agent,task:'a'}]);
 await f.scheduler.tick();
 // 真实 WorkerPool 提供 liveHandle：同进程内重建的 scheduler 靠它恢复句柄。
 f.pool.liveHandle=(workerId,parent)=>f.records.get(workerId)?.state==='CANCELLED'?undefined:{version:1,workerId,parentSessionId:parent,capability:f.raw.get(workerId)};
 const other=new MissionScheduler(f.db,f.pool);
 try{other.cancel(m.id,'parent');}finally{other.stop();}
 assert.deepEqual(f.cancelled,[f.dispatch[0].workerId]);
});
