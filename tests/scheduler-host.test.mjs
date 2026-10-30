import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { SchedulerHost, SchedulerClient, readSchedulerEndpoint, schedulerEndpointPaths } from '../dist/terminal/scheduler-host.js';

function fakePool() {
 const tasks = [];
 let launched = 0;
 return {
  tasks,
  active() { return tasks.filter(task => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(task.state)); },
  launch(crew, instruction, cwd, session, seconds, signal, parent) {
   launched++;
   const handle = { version: 1, workerId: 'w' + launched, parentSessionId: parent, capability: 'cap' + launched };
   tasks.push({ id: handle.workerId, agent: crew.name, state: 'RUNNING', status: '运行中', title: instruction, parentSessionId: parent, mcpServers: crew.mcpServers });
   return handle;
  },
  status(h, p) { return h.parentSessionId === p ? { state: 'RUNNING' } : { state: 'UNKNOWN_HANDLE' }; },
  result(h, p) { return h.parentSessionId === p ? { state: 'SUCCEEDED', output: 'evidence' } : { state: 'UNKNOWN_HANDLE' }; },
  async wait(h, p) { return this.result(h, p); },
  review(h, p) { return h.parentSessionId === p ? { state: 'RUNNING', reviewDue: false } : { state: 'UNKNOWN_HANDLE' }; },
  cancelHandle(h, p) { return h.parentSessionId === p ? { state: 'CANCELLED' } : { state: 'UNKNOWN_HANDLE' }; },
  cancelAll() {},
  eventsSince(cursor, options) { return { cursor, events: [{ seq: cursor + 1, parent: options.parentSessionId || null }], hasMore: false }; },
 };
}
function fakeScheduler() {
 const calls = [];
 return {
  calls,
  list(parent) { return [{ id: 'p1', goal: 'g', state: 'RUNNING', cwd: '.', jobs: [{ state: 'SUCCEEDED' }, { state: 'NEEDS_HUMAN' }] }]; },
  get(id, parent) { return id === 'p1' ? { id: 'p1', jobs: [] } : null; },
  pause(id, parent) { calls.push(['pause', id]); },
  resume(id, parent) { calls.push(['resume', id]); },
  start() { calls.push(['start']); },
  cancel(id, parent) { calls.push(['cancel', id]); },
  approve(id, parent, jobId) { calls.push(['approve', jobId]); },
 };
}

test('daemon RPC surface: endpoint files persist, full lifecycle round-trips, close clears',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'kepos-rpc-'));
 const host=new SchedulerHost(fakePool(),fakeScheduler(),{port:0,dataDir});
 const address=await host.listen();
 t.after(async()=>{await host.close();});
 assert.ok(existsSync(schedulerEndpointPaths(dataDir).token));
 assert.equal(readSchedulerEndpoint(dataDir).port,address.port);
 const client=new SchedulerClient({port:address.port,token:host.token});
 const fromDisk=SchedulerClient.fromDataDir(dataDir);
 assert.ok(fromDisk,'clients can discover the daemon from the data directory');
 assert.equal((await fromDisk.health()).ok,true);
 const handle=await client.launch({crew:{name:'Relay',mcpServers:['search']},instruction:'inspect',cwd:'.',parentSessionId:'p'});
 assert.equal(handle.workerId,'w1');
 assert.equal((await client.status(handle)).state,'RUNNING');
 assert.equal((await client.result(handle)).output,'evidence');
 assert.equal((await client.review(handle)).state,'RUNNING');
 assert.equal((await client.cancel(handle)).state,'CANCELLED');
 const tasks=await client.tasks('p');
 assert.equal(tasks.length,1);assert.deepEqual(tasks[0].mcpServers,['search']);
 const plans=await client.plans('p');
 assert.equal(plans[0].total,2);assert.equal(plans[0].attention,1);
 const calls=fakeScheduler(); // separate instance guard
 await host.close();
 assert.equal(existsSync(schedulerEndpointPaths(dataDir).port),false,'port file is cleared on close');
});

test('plans pause/approve actions reach the scheduler; unknown actions are rejected',async t=>{
 const scheduler=fakeScheduler();
 const host=new SchedulerHost(fakePool(),scheduler,{port:0});
 const address=await host.listen();
 t.after(async()=>{await host.close();});
 const client=new SchedulerClient({port:address.port,token:host.token});
 await client.plan('p1','p','pause');
 await client.plan('p1','p','approve','job-9');
 assert.deepEqual(scheduler.calls,[['pause','p1'],['approve','job-9'],['start']],'approve also starts the scheduler');
 await assert.rejects(client.plan('p1','p','destroy'),/Unknown plan action/);
 await assert.rejects(client.request('teleport'),/Unknown scheduler action/);
});

test('wrong tokens are rejected and oversized lines drop the connection',async t=>{
 const host=new SchedulerHost(fakePool(),fakeScheduler(),{port:0});
 const address=await host.listen();
 t.after(async()=>{await host.close();});
 await assert.rejects(new SchedulerClient({port:address.port,token:'wrong'}).health(),/Unauthorized/);
 const raw=connect({host:address.host,port:address.port});
 await new Promise(resolve=>raw.once('connect',resolve));
 raw.write('x'.repeat(1024*1024+64));
 const closed=await Promise.race([new Promise(resolve=>raw.once('close',()=>resolve(true))),new Promise(resolve=>setTimeout(()=>resolve(false),3000))]);
 assert.equal(closed,true,'flooding sockets are destroyed');
 raw.destroy();
 // Two clients share the same host: both get healthy responses.
 const a=new SchedulerClient({port:address.port,token:host.token});
 const b=new SchedulerClient({port:address.port,token:host.token});
 assert.equal((await a.health()).ok,true);
 assert.equal((await b.health()).ok,true);
});
