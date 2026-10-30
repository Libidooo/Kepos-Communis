import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkerPool,MAX_CONCURRENT_CHILDREN,DEFAULT_TASK_SECONDS,configureWorkerBudget} from '../dist/terminal/workers.js';
import {OrbitalDatabase} from '../dist/terminal/database.js';

const crew={id:'expert',name:'Expert',role:'investigate',model:'fixture',provider:'fixture'};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('default worker policy exposes 48 slots and a five-minute review baseline',()=>{assert.equal(MAX_CONCURRENT_CHILDREN,48);assert.equal(DEFAULT_TASK_SECONDS,300);});
test('main-agent review acknowledgement is scoped to the worker handle',async t=>{const f=fixture(t);const handle=f.launch('review');await turn();const review=f.pool.review(handle,'a');assert.equal(review.state,'STARTING');assert.equal(review.reviewDue,false);assert.equal(f.pool.review(handle,'wrong').state,'UNKNOWN_HANDLE');});
test('copy delegation is one level and halves the parent budget',async t=>{const f=fixture(t);const parent=f.launch('parent','a',{seconds:5});assert.throws(()=>f.pool.launch(crew,'too long',t.name,'source',3,undefined,'a',[],[],false,1,parent.workerId),/half/);const child=f.pool.launch(crew,'copy',t.name,'source',2,undefined,'a',[],[],false,1,parent.workerId);assert.equal(f.pool.tasks.at(-1).delegationDepth,1);assert.equal(f.pool.tasks.at(-1).parentWorkerId,parent.workerId);f.pool.cancelHandle(child,'a');f.pool.cancelHandle(parent,'a');});
function fixture(t,concurrency=1){
 configureWorkerBudget(()=>({}));
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
   succeed(text='OK',usage){this.onEvent?.({type:'agent_start'});this.onEvent?.({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'stop',usage}});this.onEvent?.({type:'agent_settled'});},
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

test('dispatch rotates strictly across three parents instead of alternating two',async t=>{
 const f=fixture(t);f.launch('active','a');const a=f.launch('a-next','a');const b=f.launch('b-next','b');const c=f.launch('c-next','c');
 const stateOf=(handle,parent)=>f.pool.status(handle,parent).state;
 await turn();
 f.executors[0].succeed();await turn();
 assert.equal(stateOf(b,'b'),'STARTING','b follows a');assert.equal(stateOf(a,'a'),'QUEUED');assert.equal(stateOf(c,'c'),'QUEUED');
 f.executors[0].succeed();await turn();
 assert.equal(stateOf(c,'c'),'STARTING','c follows b');assert.equal(stateOf(a,'a'),'QUEUED');
 f.executors[0].succeed();await turn();
 assert.equal(stateOf(a,'a'),'STARTING','a wraps back after c');
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

test('per-task budget cap stops the spend and keeps the evidence queryable',async t=>{
 const f=fixture(t);configureWorkerBudget(()=>({perTaskTokens:150}));
 t.after(()=>configureWorkerBudget(()=>({})));
 const capped=f.launch('capped','a',{crew:{...crew,name:'Capped'}});
 await turn();f.executors[0].succeed('partial output',{input:100,output:90,cacheRead:20,cost:{total:0.4}});
 await turn();await turn();
 const receipt=f.pool.result(capped,'a');
 assert.equal(receipt.state,'CANCELLED');
 assert.match(String(receipt.error),/预算上限/);
 assert.ok(receipt.output.includes('partial output'),'evidence stays readable');
 // An explicit higher per-task cap lets the same usage run to completion.
 const wider=f.launch('wider','a',{crew:{...crew,name:'Wider'}}); f.pool.tasks.find(task=>task.id===wider.workerId).budgetTokens=500;
 await turn();f.executors.at(-1).succeed('done',{input:100,output:90,cacheRead:20,cost:{total:0.4}});
 await turn();await turn();
 assert.equal(f.pool.result(wider,'a').state,'SUCCEEDED');
});

test('daily budget refuses new dispatch after the limit is consumed',async t=>{
 const f=fixture(t);configureWorkerBudget(()=>({dailyTokens:100}));
 t.after(()=>configureWorkerBudget(()=>({})));
 const first=f.launch('first','a');
 await turn();f.executors[0].succeed('done',{input:80,output:60,cost:{total:0.1}});
 await turn();await turn();
 assert.equal(f.pool.result(first,'a').state,'SUCCEEDED');
 assert.throws(()=>f.launch('second','a'),/今日预算已用尽/);
});

test('a stalled task is flagged for review but never auto-killed',async t=>{
 const f=fixture(t);configureWorkerBudget(()=>({stallMinutes:0.01}));
 t.after(()=>configureWorkerBudget(()=>({})));
 const handle=f.launch('long-runner','a');
 await turn();
 f.executors[0].onEvent?.({type:'agent_start'});
 await turn();
 await new Promise(resolve=>setTimeout(resolve,1200));
 const task=f.pool.tasks.find(item=>item.id===handle.workerId);
 assert.equal(task.stalled,true,'system flags the stall');
 assert.equal(task.state,'RUNNING','the system does not kill it');
 assert.equal(task.reviewDue,true);
 f.executors[0].succeed('finally done');
 await turn();await turn();
 assert.equal(f.pool.result(handle,'a').state,'SUCCEEDED');
 assert.equal(f.pool.tasks.find(item=>item.id===handle.workerId).stalled,false,'progress clears the flag');
});

test('hardKill synchronously kills running executors, clears the queue, and is safe to repeat',async t=>{
 const f=fixture(t,2);f.launch('a','p1');f.launch('b','p2');f.launch('c','p1');await turn();
 const killed=[];
 // spy 如实模拟 SIGKILL：同步返回，进程随后死亡（close + onExit），让生命周期自然收敛。
 for(const e of f.executors)e.child.kill=sig=>{killed.push(sig);queueMicrotask(()=>{e.dead=true;e.child.emit('close',1);e.onExit?.(Error('killed'));});};
 f.pool.hardKill();f.pool.hardKill(); // 幂等：第二次必须是无操作
 assert.equal(killed.length,2,'each running executor killed exactly once (children map is the same process)');
 assert.ok(killed.every(sig=>sig==='SIGKILL'));
 await turn();
 assert.equal(f.pool.tasks[2].state,'QUEUED','closed pool never dispatches the queued task');
});

test('cancelling a task whose process already exited settles immediately instead of hanging',async t=>{
 const f=fixture(t);f.launch('x');await turn();
 const e=f.executors[0];e.dead=true;e.child.exitCode=1; // 进程已退出（如 pi 拒绝启动参数），永远不会再来 close 事件
 f.pool.cancel(f.pool.tasks[0].id);await turn();
 assert.equal(f.pool.tasks[0].state,'CANCELLED',`expected prompt CANCELLED, got ${f.pool.tasks[0].state} / ${f.pool.tasks[0].error||''}`);
});

test('startup sweeps tasks of silent owners even when their pid looks alive (PID reuse)',async t=>{
 const f=fixture(t);
 const h=f.launch('WAIT','a');await turn();
 const task=f.pool.tasks.find(x=>x.id===h.workerId);
 assert.equal(task.state,'STARTING');
 // 所有者心跳沉默一小时（进程已崩，PID 随后被本测试进程复用——旧判定会误认为还活着）
 if(f.pool.ownerHeartbeat)clearInterval(f.pool.ownerHeartbeat);
 f.database.prepare('UPDATE worker_owners SET last_seen=? WHERE epoch=?').run(Date.now()-3600000,task.ownerEpoch);
 const g=new WorkerPool(f.database,()=>{throw Error('must not spawn');},{concurrency:1});
 const swept=g.tasks.find(x=>x.id===h.workerId);
 assert.equal(swept.state,'INTERRUPTED','silent owner task is swept despite a reused pid');
 // 活跃所有者的任务保留：伪造一个心跳新鲜的 epoch 及其任务
 f.database.prepare('INSERT INTO worker_owners VALUES(?,?,?)').run('fresh-epoch',process.pid,Date.now());
 f.database.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,NULL)').run('w-fake','a','corr-fake','h','fresh-epoch','STARTING',JSON.stringify({id:'w-fake',agent:'X',state:'STARTING',status:'运行中',title:'fake',cwd:'.',session:'s',parentSessionId:'a',correlationId:'c-fake',started:Date.now(),output:'',limit:60,model:'m',provider:'p',ownerPid:process.pid,ownerEpoch:'fresh-epoch',tools:['read'],skills:[],mcp:false}));
 const kept=new WorkerPool(f.database,()=>{throw Error('must not spawn');},{concurrency:1});
 const keptTask=kept.tasks.find(x=>x.id==='w-fake');
 assert.equal(keptTask.state,'STARTING','fresh sibling owner task survives the sweep');
});
