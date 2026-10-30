import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const listing = JSON.stringify({data:[{id:'gpt-x'},{id:'claude-y'},{id:'deepseek-z'}]});
const server = createServer((request,response)=>{
  if((request.url==='/models'||request.url==='/v1/models')&&request.headers.authorization==='Bearer good'){
    response.setHeader('content-type','application/json');response.end(listing);return;
  }
  response.statusCode=401;response.end('{}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port = server.address().port;
const home = mkdtempSync(join(tmpdir(),'kepos-relay-e2e4-'));
const env = {...process.env};
const run = (args,e=env)=>new Promise(resolve=>{
  const child = spawn('node',['bin/kepos.cjs','relay',...args,'--home',home],{encoding:'utf8',env:e});
  let out='',err='';
  child.stdout.on('data',d=>out+=d);
  child.stderr.on('data',d=>err+=d);
  child.on('close',code=>resolve({status:code,out,err}));
});

let r = await run(['add','demo','http://127.0.0.1:'+port,'--key','good']);
console.log('add status',r.status,'|',r.out.trim().split('\n').pop());
if(r.err.trim())console.log('ERR:',r.err.trim());
r = await run(['models','demo','--all','--key','good']);
console.log('models status',r.status,'|',r.out.trim().split('\n').pop(),r.err.trim()?('ERR:'+r.err.trim()):'');
r = await run(['test','demo'],{...env,KEPOS_RELAY_DEMO:'good'});
console.log('test env status',r.status,'|',r.out.trim().split('\n')[0]);
r = await run(['test','demo'],{...env,KEPOS_RELAY_DEMO:'bad'});
console.log('test bad status',r.status,'|',r.err.trim().split('\n')[0]);

server.closeAllConnections();server.close();
process.exit(0);
