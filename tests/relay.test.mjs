import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { slugify, relayEnvName, modelsJsonPath, readRelays, upsertRelay, removeRelay, resolveRelayKey, probeRelay, readCcSwitchProviders, importCcSwitchProvider, normalizeRelayBaseUrl } from '../dist/terminal/relay.js';

const agentDir = () => { const dir = mkdtempSync(join(tmpdir(), 'kepos-relay-')); mkdirSync(dir, { recursive: true }); return dir; };

test('relay ids slugging and env naming are stable and shell-safe',()=>{
 assert.equal(slugify('My Relay!'),'my_relay');
 assert.equal(relayEnvName('My Relay'),'KEPOS_RELAY_MY_RELAY');
 assert.equal(slugify('中文中转'),'relay');
});

test('openai-style base URLs gain /v1 automatically; anthropic and versioned URLs stay untouched',()=>{
 assert.equal(normalizeRelayBaseUrl('https://r.example','openai-completions').url,'https://r.example/v1');
 assert.equal(normalizeRelayBaseUrl('https://r.example','openai-responses').changed,true);
 assert.equal(normalizeRelayBaseUrl('https://r.example/','openai-completions').url,'https://r.example/v1');
 assert.equal(normalizeRelayBaseUrl('https://r.example/v1','openai-completions').changed,false);
 assert.equal(normalizeRelayBaseUrl('https://r.example/v2','openai-responses').url,'https://r.example/v2');
 assert.equal(normalizeRelayBaseUrl('https://r.example/api','anthropic-messages').url,'https://r.example/api');
});

test('upsert keeps unrelated providers and stores the key as an env reference only',()=>{
 const dir=agentDir();
 // Pre-existing unrelated provider must survive relay writes.
 mkdirSync(dir,{recursive:true});writeFileSync(modelsJsonPath(dir),JSON.stringify({providers:{anthropic:{apiKey:'keep'}}}));
 upsertRelay(dir,'relay_my',{name:'My',baseUrl:'https://relay.example/',api:'openai-completions',apiKey:'$KEPOS_RELAY_MY'},['gpt-x','gpt-y']);
 const relays=readRelays(dir);
 assert.equal(relays.relay_my.baseUrl,'https://relay.example');
 assert.deepEqual(relays.relay_my.models?.map(m=>m.id),['gpt-x','gpt-y']);
 const raw=JSON.parse(readFileSync(modelsJsonPath(dir),'utf8'));
 assert.equal(raw.providers.anthropic.apiKey,'keep');
 assert.equal(raw.providers.relay_my.apiKey,'$KEPOS_RELAY_MY');
 assert.ok(!raw.providers.relay_my.apiKey.includes('sk-'),'no plaintext key in models.json');
 assert.equal(removeRelay(dir,'relay_my'),true);
 assert.equal(existsSync(modelsJsonPath(dir)),true);
 assert.deepEqual(Object.keys(readRelays(dir)),[]);
});

test('relay keys resolve from the referenced environment variable',()=>{
 process.env.KEPOS_RELAY_TESTING='sk-live-123';
 const key=resolveRelayKey({name:'T',baseUrl:'https://x',api:'openai-completions',apiKey:'$KEPOS_RELAY_TESTING'});
 assert.equal(key,'sk-live-123');
 assert.equal(resolveRelayKey({name:'T',baseUrl:'https://x',api:'openai-completions',apiKey:'$KEPOS_RELAY_MISSING'}),undefined);
 assert.equal(resolveRelayKey({name:'T',baseUrl:'https://x',api:'openai-completions',apiKey:'$KEPOS_RELAY_MISSING'},'override'),'override');
 delete process.env.KEPOS_RELAY_TESTING;
});

test('probe classifies reachable, auth-failed and unreachable relays',async()=>{
 // Dedicated dispatcher with tiny keep-alive so the test process can exit cleanly.
 const {Agent, fetch: undiciFetch}=await import('undici');
 const agent=new Agent({keepAliveTimeout:10,keepAliveMaxTimeout:20});
 const clientFetch=(url,init)=>undiciFetch(url,{...init,dispatcher:agent});
 const listing=JSON.stringify({data:[{id:'gpt-x'},{id:'claude-y'}]});
 const server=createServer((request,response)=>{
  if(request.url==='/v1/models'&&request.headers['x-api-key']==='anthropic-key'){response.setHeader('content-type','application/json');response.end(listing);return;}
  if(request.url==='/models'){if(request.headers.authorization==='Bearer good'){response.setHeader('content-type','application/json');response.end(listing);}else{response.statusCode=401;response.end('{"error":"bad key"}');}return;}
  response.statusCode=404;response.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 try{
  const good=await probeRelay(`http://127.0.0.1:${port}`,'good',clientFetch);
  assert.equal(good.ok,true);assert.equal(good.api,'openai-completions');assert.deepEqual(good.models,['gpt-x','claude-y']);
  const bad=await probeRelay(`http://127.0.0.1:${port}`,'wrong',clientFetch);
  assert.equal(bad.ok,false);assert.equal(bad.status,401);assert.match(String(bad.error),/鉴权失败/);
  const dead=await probeRelay('http://127.0.0.1:1','',clientFetch,1500);
  assert.equal(dead.ok,false);assert.ok(dead.error);
  // A broken global proxy (fetch always throws) falls back to a raw direct request.
  const bypassed=await probeRelay(`http://127.0.0.1:${port}`,'good',async()=>{throw Error('proxy down');});
  assert.equal(bypassed.ok,true);assert.equal(bypassed.api,'openai-completions');assert.deepEqual(bypassed.models,['gpt-x','claude-y']);
  // Anthropic-style relay answers only the x-api-key endpoint; OpenAI attempts 404 first.
  const selective=createServer((request,response)=>{if(request.url==='/v1/models'&&request.headers['x-api-key']==='anthropic-key'){response.end(listing);}else{response.statusCode=404;response.end();}});
  await new Promise(resolve=>selective.listen(0,'127.0.0.1',resolve));
  const aport=selective.address().port;
  try{
   const claude=await probeRelay(`http://127.0.0.1:${aport}`,'anthropic-key',clientFetch);
   assert.equal(claude.ok,true);assert.equal(claude.api,'anthropic-messages');assert.deepEqual(claude.models,['gpt-x','claude-y']);
  }finally{selective.closeAllConnections();selective.close();}
 }finally{server.closeAllConnections();server.close();await agent.close();}
});

test('cc-switch providers are parsed tolerantly and imported as env references',()=>{
 const home=mkdtempSync(join(tmpdir(),'kepos-ccswitch-'));
 mkdirSync(join(home,'.cc-switch'),{recursive:true});
 writeFileSync(join(home,'.cc-switch','config.json'),JSON.stringify({claude:{providers:[
  {name:'中转A',settingsConfig:{env:{ANTHROPIC_BASE_URL:'https://a.example',ANTHROPIC_AUTH_TOKEN:'sk-a'}}},
  {name:'broken',settingsConfig:{env:{}}},
  {name:'中转B',settingsConfig:{env:{ANTHROPIC_BASE_URL:'https://b.example',ANTHROPIC_AUTH_TOKEN:'sk-b'}}},
 ]}}));
 const providers=readCcSwitchProviders(home);
 assert.deepEqual(providers.map(p=>p.name),['中转A','中转B']);
 const dir=agentDir();
 const id=importCcSwitchProvider(dir,providers[0]);
 assert.ok(id.startsWith('relay_ccswitch_'),'imported id is namespaced');
 const stored=readRelays(dir)[id];
 assert.equal(stored.baseUrl,'https://a.example');
 assert.equal(stored.api,'anthropic-messages');
 assert.equal(stored.apiKey,'$ANTHROPIC_AUTH_TOKEN');
 assert.ok(!JSON.stringify(readFileSync(modelsJsonPath(dir),'utf8')).includes('sk-a'),'cc-switch token must not be copied');
 // Empty store yields nothing.
 const empty=mkdtempSync(join(tmpdir(),'kepos-nocc-'));
 assert.deepEqual(readCcSwitchProviders(empty),[]);
});

test('relay add persists the effective (normalized) URL and probes that same value',async t=>{
 const { relayCommand } = await import('../dist/src/relay-cli.js');
 const { appPaths } = await import('../dist/src/config.js');
 const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'m1'},{id:'m2'}]}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const home=mkdtempSync(join(tmpdir(),'kepos-relay-cli-'));
 await relayCommand({args:['add','mock','http://127.0.0.1:'+server.address().port]},appPaths({KEPOS_HOME:home}));
 // 旧实现保存原始 URL（无 /v1），探活却可能经 /v1 候选通过，真实调用时 404。
 const relay=readRelays(appPaths({KEPOS_HOME:home}).agentDir)['relay_mock'];
 assert.equal(relay.baseUrl,'http://127.0.0.1:'+server.address().port+'/v1');
});
