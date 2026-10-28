import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkerPool} from '../dist/terminal/workers.js';
import {OrbitalDatabase} from '../dist/terminal/database.js';

const crew={id:'expert',name:'Expert',role:'investigate',model:'fixture',provider:'fixture'};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,concurrency=1){
 const dir=mkdtempSync(join(tmpdir(),'kepos-queue-'));
 const database=new OrbitalDatabase(join(dir,'state.sqlite'));
 const executors=[];let alive=0,peak=0;
 const create=profile=>{
  if(profile.role==='spawn-failure')throw Error('injected spawn failure');
  const child=new EventEmitter();child.pid=100+executors.length;
  const e={child,key:JSON.stringify(profile),profile,busy:false,dead:false,stopping:false,uses:0,messages:[],
   reserve(){this.busy=true;},release(){this.busy=false;this.onEvent=undefined;this.onExit=undefined;},
   async ready(){},async reset(){this.uses++;},async request(type,args){if(type==='prompt')this.messages.push(args.message);return{disposition:'started'};},
   kill(){if(this.dead||this.stopping)return;this.stopping=true;queueMicrotask(()=>{this.dead=true;alive--;child.emit('close',0);this.onExit?.(Error('closed'));});},
   succeed(text='OK'){this.onEvent?.({type:'agent_start'});this.onEvent?.({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop'}});this.onEvent?.({type:'agent_settled'});},
  };
  executors.push(e);alive++;peak=Math.max(peak,alive);return e;
 };
 const pool=new WorkerPool(database,create,{concurrency});
 const launch=(text,parent='a',extra={})=>pool.launch(extra.crew||crew,text,dir,'source',extra.seconds||5,extra.signal,parent,[],[],false);
 t.after(async()=>{pool.close();await turn();database.close();});
 return{pool,launch,executors,database,peak:()=>peak};
}

test('normal completion automatically dequeues and preserves the original run promise',async t=>{
 const f=fixture(t);const first=f.launch('first');const waiting=f.pool.run(crew,'second',t.name,'source',5,undefined,'a',[]);
 // Different cwd forces a retiring idle executor rather than reuse.
 const second=f.pool.tasks.at(-1);assert.equal(second.state,'QUEUED');await turn();
 f.executors[0].succeed('first-result');await turn();await turn();
 assert.ok(f.executors.length>=2);assert.equal(second.state,'STARTING');
 f.executors.at(-1).succeed('second-result');assert.equal((await waiting).output,'second-result');
 assert.equal(f.peak(),1,'retiring processes must count against capacity');
 assert.equal(f.pool.result(first,'a').state,'SUCCEEDED');
});

test('queue is FIFO per parent and round robin between projects',async t=>{
 const f=fixture(t);f.launch('active','a');const a=f.launch('a-next','a');const b=f.launch('b-next','b');
 await turn();f.executors[0].succeed();await turn();
 assert.equal(f.pool.status(b,'b').state,'STARTING');assert.equal(f.pool.status(a,'a').state,'QUEUED');
 f.executors[0].succeed();await turn();assert.equal(f.pool.status(a,'a').state,'STARTING');
 f.executors[0].succeed();await turn();assert.equal(f.pool.result(a,'a').state,'SUCCEEDED');
});

test('queued AbortSignal and deadline finish without spawning another executor',async t=>{
 const f=fixture(t);f.launch('active');const controller=new AbortController();const cancelled=f.launch('cancel','b',{signal:controller.signal});
 controller.abort();assert.equal(f.pool.result(cancelled,'b').state,'CANCELLED');
 const expired=f.launch('expire','b',{seconds:.03});await new Promise(r=>setTimeout(r,60));
 assert.equal(f.pool.result(expired,'b').state,'TIMED_OUT');assert.equal(f.executors.length,1);
});

test('queued configuration is a frozen snapshot and receipt keeps its revision',async t=>{
 const f=fixture(t);f.launch('active');const config={...crew};const h=f.launch('waiting','b',{crew:config});
 config.role='changed';config.model='changed';const queued=f.pool.tasks.at(-1);
 assert.equal(queued.profileSnapshot.role,'investigate');assert.ok(Object.isFrozen(queued.profileSnapshot));assert.ok(Object.isFrozen(queued.profileSnapshot.tools));
 await turn();f.executors[0].succeed();await turn();f.executors[0].succeed();await turn();
 const result=f.pool.result(h,'b');assert.equal(result.profileSnapshot.role,'investigate');assert.equal(result.profileRevision,queued.profileRevision);
});

test('close settles queued work and never dispatches it after active exit',async t=>{
 const f=fixture(t);f.launch('active');const h=f.launch('waiting','b');f.pool.close();await turn();await turn();
 assert.equal(f.pool.result(h,'b').state,'CANCELLED');assert.equal(f.executors.length,1);assert.equal(f.pool.children.size,0);
});

test('queued startup failure resolves waiters and dispatches the following task',async t=>{
 const f=fixture(t);f.launch('active');
 const bad=f.pool.run({...crew,role:'spawn-failure'},'bad',f.pool.tasks[0].cwd,'source',5,undefined,'b',[]);
 const good=f.launch('after-bad','c');await turn();f.executors[0].succeed();await turn();await turn();
 assert.equal((await bad).state,'FAILED');assert.equal(f.pool.status(good,'c').state,'STARTING');
 f.executors.at(-1).succeed('next');assert.equal((await f.pool.wait(good,'c',1)).output,'next');
});

test('mixed queued workload drains without loss, over-capacity or receipt replacement',async t=>{
 const f=fixture(t,3),handles=[];
 for(let n=0;n<90;n++){
  const h=f.launch('job-'+n,'parent-'+n%4,{crew:{...crew,role:'role-'+n%2},seconds:30});handles.push(h);
  if(n%11===0)f.pool.cancelHandle(h,h.parentSessionId);
 }
 for(let round=0;round<500;round++){
  await turn();
  for(const executor of f.executors)if(executor.busy&&!executor.dead&&!executor.stopping&&executor.messages.length)executor.succeed(executor.messages.at(-1));
  if(handles.every(h=>['SUCCEEDED','CANCELLED'].includes(f.pool.result(h,h.parentSessionId).state)))break;
 }
 const results=handles.map(h=>f.pool.result(h,h.parentSessionId));
 assert.equal(results.length,90);assert.ok(results.every(r=>['SUCCEEDED','CANCELLED'].includes(r.state)));assert.equal(f.pool.children.size,0);assert.ok(f.peak()<=3);
 for(const h of handles){const before=f.pool.result(h,h.parentSessionId);f.pool.cancelHandle(h,h.parentSessionId);assert.deepEqual(f.pool.result(h,h.parentSessionId),before);}
 assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM workers WHERE receipt IS NULL').get().n,0);
});
