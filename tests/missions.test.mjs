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
