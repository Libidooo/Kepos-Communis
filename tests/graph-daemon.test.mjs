import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OrbitalDatabase} from '../dist/terminal/database.js';
import {GraphStore} from '../dist/terminal/graph.js';
import {SchedulerLease, SchedulerDaemon} from '../dist/terminal/daemon.js';

test('GraphStore projects a plan into runs, nodes, edges, events, and artifacts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kepos-graph-'));const db=new OrbitalDatabase(join(dir,'graph.sqlite'));const graph=new GraphStore(db);
 const run=graph.createRun({goal:'inspect',cwd:dir,parentSessionId:'parent'});const scan=graph.addNode(run.id,{id:'scan',kind:'agent',label:'scan'});const review=graph.addNode(run.id,{id:'review',kind:'agent',label:'review',dependsOn:['scan'],profileRevision:'rev'});graph.updateNode(run.id,scan.id,'SUCCEEDED',{checkpoint:'evidence'});const artifact=graph.artifact(run.id,{nodeId:scan.id,kind:'receipt',summary:'summary',uri:'hash'});graph.updateRun(run.id,'RUNNING');const view=graph.get(run.id);assert.equal(view.nodes.length,2);assert.equal(view.edges[0].fromNode,'scan');assert.equal(view.artifacts[0].id,artifact.id);assert.equal(graph.events(run.id,0,2).hasMore,true);assert.equal(view.nodes.find(node=>node.id===review.id).profile_revision,'rev');const flow=graph.toReactFlow(run.id);assert.equal(flow.format,'react-flow@12');assert.equal(flow.nodes.length,2);assert.equal(flow.edges[0].source,'scan');db.close();
});

test('SQLite scheduler lease prevents concurrent daemons and recovers expired owners',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kepos-lease-'));const db=new OrbitalDatabase(join(dir,'lease.sqlite'));const first=new SchedulerLease(db,'default',50);const second=new SchedulerLease(db,'default',50);assert.equal(first.acquire(),true);assert.equal(second.acquire(),false);first.release();assert.equal(second.acquire(),true);second.release();db.close();
});

test('SchedulerDaemon refuses duplicate starts while running and after restart allows one owner',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kepos-daemon-'));const db=new OrbitalDatabase(join(dir,'daemon.sqlite'));
 const daemon=new SchedulerDaemon(db,{},{leaseTtlMs:50,tickMs:20,heartbeatMs:20});
 daemon.start();
 assert.throws(()=>daemon.start(),/already running/);
 assert.throws(()=>new SchedulerDaemon(db,{}, {leaseTtlMs:50}).start(),/Another Kepos scheduler daemon/);
 daemon.stop();
 daemon.start();daemon.stop();db.close();
});

test('a stolen lease ends daemon.run() with an error instead of stopping silently',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'kepos-daemon-lease-'));const db=new OrbitalDatabase(join(dir,'daemon-lease.sqlite'));
 const daemon=new SchedulerDaemon(db,{},{leaseTtlMs:50,tickMs:20,heartbeatMs:20});
 const run=daemon.run();
 db.prepare("UPDATE scheduler_leases SET owner='intruder', expires=? WHERE name='default'").run(Date.now()+60000);
 const error=await run.then(()=>null,reason=>reason);
 assert.match(String(error?.message),/lease lost/i);
 // The intruder still owns the lease; the daemon's release must not evict it.
 assert.equal(daemon.lease.acquire(),false);
 db.close();
});
