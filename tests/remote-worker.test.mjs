import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OrbitalDatabase} from '../dist/terminal/database.js';
import {RemoteWorkerServer,RemoteWorkerClient} from '../dist/terminal/remote-worker.js';
function fakePool(){return{active:()=>[],launch(){return{version:1,workerId:'w',parentSessionId:'p',capability:'c'}},status(){return{state:'QUEUED'}},result(){return{state:'QUEUED'}},cancelHandle(){return{state:'CANCELLED'}},eventsSince(){return{cursor:0,events:[]}}};}
test('remote worker requires token and uses TLS for non-loopback binds',async()=>{const dir=mkdtempSync(join(tmpdir(),'kepos-remote-'));const db=new OrbitalDatabase(join(dir,'remote.sqlite'));const server=new RemoteWorkerServer(fakePool(),{host:'127.0.0.1',port:0,token:'secret'});const address=await server.listen();const client=new RemoteWorkerClient({host:address.host,port:address.port,token:'secret'});assert.equal((await client.health()).ok,true);const wrong=new RemoteWorkerClient({host:address.host,port:address.port,token:'wrong'});await assert.rejects(wrong.health(),/Unauthorized/);await server.close();db.close();});
test('remote worker refuses plaintext exposure beyond loopback',async()=>{const dir=mkdtempSync(join(tmpdir(),'kepos-remote-bind-'));const db=new OrbitalDatabase(join(dir,'remote.sqlite'));const server=new RemoteWorkerServer(fakePool(),{host:'0.0.0.0',port:0,token:'secret'});await assert.rejects(server.listen(),/TLS/);db.close();});

test('remote pool adapter routes a job asynchronously and never fabricates a success',async()=>{
 const {RemoteWorkerPool}=await import('../dist/terminal/remote-worker.js');let submitted, polls=0;const client={submit:async input=>{submitted=input;return{remoteId:'rw1',state:'QUEUED'}},result:async id=>{polls++;return polls>1?{state:'SUCCEEDED',output:'remote evidence',resultHash:'h'}:{state:'RUNNING'}},cancel:async()=>({state:'CANCELLED'})};const pool=new RemoteWorkerPool(client);const crew={name:'Remote',model:'fixture',provider:'fixture',role:'read'};const h=pool.launch(crew,'inspect','C:/remote','session',5,undefined,'parent',[]);assert.equal(pool.result(h,'parent').state,'QUEUED');await new Promise(r=>setTimeout(r,30));const first=pool.result(h,'parent');assert.ok(['QUEUED','RUNNING','SUCCEEDED'].includes(first.state));await new Promise(r=>setTimeout(r,600));assert.equal(pool.result(h,'parent').state,'SUCCEEDED');assert.equal(submitted.parentSessionId,'parent');assert.equal(pool.result({...h,parentSessionId:'other'},'other').state,'UNKNOWN_HANDLE');await pool.shutdown();
});
