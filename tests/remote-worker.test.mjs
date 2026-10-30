import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect, createServer} from 'node:net';
import {OrbitalDatabase} from '../dist/terminal/database.js';
import {RemoteWorkerServer,RemoteWorkerClient} from '../dist/terminal/remote-worker.js';
function fakePool(){return{active:()=>[],launch(){return{version:1,workerId:'w',parentSessionId:'p',capability:'c'}},status(){return{state:'QUEUED'}},result(){return{state:'QUEUED'}},cancelHandle(){return{state:'CANCELLED'}},eventsSince(){return{cursor:0,events:[]}}};}
test('remote worker requires token and uses TLS for non-loopback binds',async()=>{const dir=mkdtempSync(join(tmpdir(),'kepos-remote-'));const db=new OrbitalDatabase(join(dir,'remote.sqlite'));const server=new RemoteWorkerServer(fakePool(),{host:'127.0.0.1',port:0,token:'secret'});const address=await server.listen();const client=new RemoteWorkerClient({host:address.host,port:address.port,token:'secret'});assert.equal((await client.health()).ok,true);const wrong=new RemoteWorkerClient({host:address.host,port:address.port,token:'wrong'});await assert.rejects(wrong.health(),/Unauthorized/);await server.close();db.close();});
test('remote worker refuses plaintext exposure beyond loopback',async()=>{const dir=mkdtempSync(join(tmpdir(),'kepos-remote-bind-'));const db=new OrbitalDatabase(join(dir,'remote.sqlite'));const server=new RemoteWorkerServer(fakePool(),{host:'0.0.0.0',port:0,token:'secret'});await assert.rejects(server.listen(),/TLS/);db.close();});

test('remote pool adapter routes a job asynchronously and never fabricates a success',async()=>{
 const {RemoteWorkerPool}=await import('../dist/terminal/remote-worker.js');let submitted, polls=0;const client={submit:async input=>{submitted=input;return{remoteId:'rw1',state:'QUEUED'}},result:async id=>{polls++;return polls>1?{state:'SUCCEEDED',output:'remote evidence',resultHash:'h'}:{state:'RUNNING'}},cancel:async()=>({state:'CANCELLED'})};const pool=new RemoteWorkerPool(client);const crew={name:'Remote',model:'fixture',provider:'fixture',role:'read'};const h=pool.launch(crew,'inspect','C:/remote','session',5,undefined,'parent',[]);assert.equal(pool.result(h,'parent').state,'QUEUED');await new Promise(r=>setTimeout(r,30));const first=pool.result(h,'parent');assert.ok(['QUEUED','RUNNING','SUCCEEDED'].includes(first.state));await new Promise(r=>setTimeout(r,600));assert.equal(pool.result(h,'parent').state,'SUCCEEDED');assert.equal(submitted.parentSessionId,'parent');assert.equal(pool.result({...h,parentSessionId:'other'},'other').state,'UNKNOWN_HANDLE');await pool.shutdown();
});

test('remote worker drops connections whose buffered line exceeds the wire limit',async()=>{
 const server=new RemoteWorkerServer(fakePool(),{host:'127.0.0.1',port:0,token:'secret'});const address=await server.listen();
 const raw=connect({host:address.host,port:address.port});await new Promise(resolve=>raw.once('connect',resolve));
 raw.write('x'.repeat(1024*1024+64));
 const closed=await Promise.race([new Promise(resolve=>raw.once('close',()=>resolve(true))),new Promise(resolve=>setTimeout(()=>resolve(false),3000))]);
 assert.equal(closed,true,'server should destroy sockets flooding the buffer');
 raw.destroy();await server.close();
});

test('remote events require a parentSessionId and are filtered by it',async()=>{
 let seenFilter;
 const pool={...fakePool(),eventsSince:(cursor,options)=>{seenFilter={cursor,options};return{cursor:0,events:[{seq:1}]}}};
 const server=new RemoteWorkerServer(pool,{host:'127.0.0.1',port:0,token:'secret'});const address=await server.listen();
 const client=new RemoteWorkerClient({host:address.host,port:address.port,token:'secret'});
 await assert.rejects(client.request('events',{cursor:0}),/parentSessionId/);
 const page=await client.request('events',{cursor:5,parentSessionId:'parent'});
 assert.deepEqual(seenFilter,{cursor:5,options:{parentSessionId:'parent',limit:100}});
 assert.deepEqual(page.events,[{seq:1}]);
 await server.close();
});

test('remote submit rejects durations past the 20 minute human gate',async()=>{
 const server=new RemoteWorkerServer(fakePool(),{host:'127.0.0.1',port:0,token:'secret'});const address=await server.listen();
 const client=new RemoteWorkerClient({host:address.host,port:address.port,token:'secret'});
 const crew={name:'Remote',model:'fixture',provider:'fixture',role:'read'};
 await assert.rejects(client.submit({crew,instruction:'long run',cwd:'.',parentSessionId:'p',seconds:3600}),/missions for longer runs/);
 await server.close();
});

test('remote client rejects unparsable or mismatched responses instead of hanging',async()=>{
 const start=handler=>new Promise(resolve=>{const raw=createServer(socket=>socket.on('data',()=>handler(socket)));raw.listen(0,'127.0.0.1',()=>resolve({raw,port:raw.address().port}))});
 const bad=await start(socket=>socket.write('NOT_JSON\n'));
 await assert.rejects(new RemoteWorkerClient({host:'127.0.0.1',port:bad.port,token:'secret'}).health(),/unparsable/);
 bad.raw.close();
 const wrong=await start(socket=>socket.write('{"id":"other","success":true,"data":{}}\n'));
 await assert.rejects(new RemoteWorkerClient({host:'127.0.0.1',port:wrong.port,token:'secret'}).health(),/id mismatch/);
 wrong.raw.close();
 assert.throws(()=>new RemoteWorkerClient({host:'remote.example',port:7788,token:'secret'}).health(),/requires TLS beyond loopback/);
});
