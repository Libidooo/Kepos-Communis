import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCli } from '../dist/src/cli.js';
import { appPaths, preparePaths, deviceId } from '../dist/src/config.js';
import { AuthService } from '../dist/src/auth/service.js';
import { OrbitalDatabase } from '../dist/terminal/database.js';
import { MissionScheduler } from '../dist/terminal/scheduler.js';

test('portable CLI and private paths', () => {
 const options=parseCli(['login','openai','--method','oauth','--home','C:/kepos']);
 assert.equal(options.command,'login'); assert.equal(options.args[0],'openai'); assert.equal(options.method,'oauth'); assert.equal(options.home,'C:/kepos');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'kepos-core-')); const paths=appPaths({KEPOS_HOME:home}); preparePaths(paths); assert.ok(fs.existsSync(path.join(paths.agentDir,'settings.json'))); assert.match(deviceId(paths),/^[0-9a-f-]{36}$/); assert.equal(deviceId(paths),deviceId(paths));
});

test('auth service exposes safe provider metadata and rejects unsupported methods', async () => {
 const calls=[]; const runtime={ getProviders:()=>[{id:'fixture',name:'Fixture',auth:{apiKey:{login:async()=>({key:'secret'})}}}], getProviderAuthStatus:()=>({configured:false}), getProvider:id=>id==='fixture'?{}:undefined, login:async(...args)=>calls.push(args), logout:async()=>{} };
 const auth=new AuthService(runtime); assert.deepEqual(auth.providers(),[{id:'fixture',name:'Fixture',methods:['api_key'],configured:false}]); await assert.rejects(auth.login('fixture','oauth',{prompt:async()=>'',notify(){}}),/Unsupported/); await auth.login('fixture','api_key',{prompt:async()=>'',notify(){}}); assert.equal(calls[0][0],'fixture'); assert.equal(calls[0][1],'api_key');
});

test('agent profile revisions are deterministic and immutable snapshots differ on config changes', async () => {
 const { profileRevision } = await import('../dist/terminal/workers.js');
 const base={name:'researcher',role:'read only',model:'fixture',provider:'fixture',tools:['read','grep'],skills:[],mcp:false};
 assert.equal(profileRevision(base),profileRevision({...base,tools:['grep','read']}));
 assert.notEqual(profileRevision(base),profileRevision({...base,role:'review only'}));
});

test('worker events are cursor-paginated, scoped, and secret-free', async () => {
 const { readWorkerEvents } = await import('../dist/terminal/events.js');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kepos-events-')); const db=new OrbitalDatabase(path.join(root,'state.sqlite'));
 db.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,?)').run('w1','parent','corr','hash','epoch','RUNNING',JSON.stringify({id:'w1',cwd:root}),null);
 db.prepare("INSERT INTO worker_events(worker_id,type,created,payload) VALUES(?,?,?,?)").run('w1','state',100,JSON.stringify({state:'RUNNING',tool:'read',secret:'do-not-return'}));
 db.prepare("INSERT INTO worker_events(worker_id,type,created,payload) VALUES(?,?,?,?)").run('w1','tool_start',101,JSON.stringify({tool:'grep',profileRevision:'rev1'}));
 const page=readWorkerEvents(db,{parentSessionId:'parent',limit:1}); assert.equal(page.events.length,1); assert.equal(page.hasMore,true); assert.equal(page.events[0].payload.secret,undefined); const next=readWorkerEvents(db,{parentSessionId:'parent',cursor:page.nextCursor}); assert.equal(next.events.length,1); assert.equal(next.events[0].payload.profileRevision,'rev1'); db.close();
});

test('mission scheduler validates DAG and persists mission records', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kepos-mission-')); const db=new OrbitalDatabase(path.join(root,'state.sqlite')); const pool={children:new Map(),launch(){throw Error('not started')},result(){return {state:'RUNNING'}},cancelHandle(){}}; const scheduler=new MissionScheduler(db,pool,{concurrency:1});
 const mission=scheduler.enqueue({goal:'fixture',cwd:root,parentSessionId:'parent',jobs:[{id:'a',agent:{name:'A',model:'fixture',provider:'fixture',role:'test'},task:'one',seconds:300},{id:'b',agent:{name:'B',model:'fixture',provider:'fixture',role:'test'},task:'two',dependsOn:['a']}]}); assert.equal(mission.jobs.length,2); assert.equal(scheduler.get(mission.id,'parent').state,'QUEUED'); assert.throws(()=>scheduler.enqueue({goal:'cycle',cwd:root,parentSessionId:'parent',jobs:[{id:'a',agent:{name:'A',model:'fixture'},task:'a',dependsOn:['b']},{id:'b',agent:{name:'B',model:'fixture'},task:'b',dependsOn:['a']}]}),/cycle/); db.close();
});

test('nested transactions isolate failed savepoints and retain outer changes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kepos-tx-'));const db=new OrbitalDatabase(path.join(dir,'state.sqlite'));
 db.transaction(()=>{db.set('outer',1);assert.throws(()=>db.transaction(()=>{db.set('inner',2);throw Error('rollback inner');}),/rollback inner/);db.set('after',3);});
 assert.equal(db.get('outer'),1);assert.equal(db.get('inner'),undefined);assert.equal(db.get('after'),3);
 assert.throws(()=>db.transaction(()=>{db.set('outer',9);db.transaction(()=>db.set('after',9));throw Error('rollback all');}),/rollback all/);
 assert.equal(db.get('outer'),1);assert.equal(db.get('after'),3);db.close();
});
