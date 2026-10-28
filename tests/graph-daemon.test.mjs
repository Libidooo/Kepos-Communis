import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OrbitalDatabase} from '../dist/terminal/database.js';
import {GraphStore} from '../dist/terminal/graph.js';
import {SchedulerLease} from '../dist/terminal/daemon.js';

test('GraphStore projects a plan into runs, nodes, edges, events, and artifacts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kepos-graph-'));const db=new OrbitalDatabase(join(dir,'graph.sqlite'));const graph=new GraphStore(db);
 const run=graph.createRun({goal:'inspect',cwd:dir,parentSessionId:'parent'});const scan=graph.addNode(run.id,{id:'scan',kind:'agent',label:'scan'});const review=graph.addNode(run.id,{id:'review',kind:'agent',label:'review',dependsOn:['scan'],profileRevision:'rev'});graph.updateNode(run.id,scan.id,'SUCCEEDED',{checkpoint:'evidence'});const artifact=graph.artifact(run.id,{nodeId:scan.id,kind:'receipt',summary:'summary',uri:'hash'});graph.updateRun(run.id,'RUNNING');const view=graph.get(run.id);assert.equal(view.nodes.length,2);assert.equal(view.edges[0].fromNode,'scan');assert.equal(view.artifacts[0].id,artifact.id);assert.equal(graph.events(run.id,0,2).hasMore,true);assert.equal(view.nodes.find(node=>node.id===review.id).profile_revision,'rev');const flow=graph.toReactFlow(run.id);assert.equal(flow.format,'react-flow@12');assert.equal(flow.nodes.length,2);assert.equal(flow.edges[0].source,'scan');db.close();
});

test('SQLite scheduler lease prevents concurrent daemons and recovers expired owners',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kepos-lease-'));const db=new OrbitalDatabase(join(dir,'lease.sqlite'));const first=new SchedulerLease(db,'default',50);const second=new SchedulerLease(db,'default',50);assert.equal(first.acquire(),true);assert.equal(second.acquire(),false);first.release();assert.equal(second.acquire(),true);second.release();db.close();
});
