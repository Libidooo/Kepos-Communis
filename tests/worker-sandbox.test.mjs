import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readDenied, argvPolicy, sandboxArgs} from '../dist/terminal/worker-sandbox.js';
import {workerEnv} from '../dist/terminal/warm-executor.js';

const project=join(mkdtempSync(join(tmpdir(),'kepos-sandbox-')),'project');
const home=mkdtempSync(join(tmpdir(),'kepos-sandbox-home-'));
const data=join(home,'data','orbital');
const base={mode:'project',cwd:project,allow:[],deny:[data],home};

test('project scope confines reads to the task directory plus allow-list',()=>{
 assert.equal(readDenied(join(project,'src','app.ts'),base),null);
 assert.equal(readDenied(project,base),null);
 assert.match(String(readDenied(join(project,'..','other','notes.md'),base)),/只读范围限定/);
 const widened={...base,allow:[join(project,'..','docs')]};
 assert.equal(readDenied(join(project,'..','docs','spec.md'),widened),null);
 assert.match(String(readDenied(join(project,'..','secrets.txt'),widened)),/只读范围限定/);
});

test('machine scope reads freely except Kepos data and credential locations',()=>{
 const loose={...base,mode:'machine'};
 assert.equal(readDenied(join(home,'documents','report.md'),loose),null);
 assert.match(String(readDenied(data,loose)),/Kepos 数据目录/);
 assert.match(String(readDenied(join(home,'.ssh','id_rsa'),loose)),/凭据位置/);
 assert.match(String(readDenied(join(home,'.aws','credentials'),loose)),/凭据位置/);
 assert.match(String(readDenied('~/.gnupg/keyring.gpg',loose)),/凭据位置/);
 assert.match(String(readDenied(join(home,'agent','auth.json'),loose)),/凭据文件/);
 assert.equal(readDenied(join(project,'src','auth.json'),loose),null);
});

test('the deny list wins even when a directory was explicitly allowed',()=>{
 const tricky={...base,allow:[home]};
 assert.match(String(readDenied(join(home,'agent','auth.json'),tricky)),/凭据文件/);
 assert.match(String(readDenied(join(home,'.ssh','config'),tricky)),/凭据位置/);
 assert.match(String(readDenied(join(data,'workspace.json'),tricky)),/Kepos 数据目录/);
 // The deny list is path-based: an unrelated file that happens to share a name stays readable.
 assert.equal(readDenied(join(home,'reports','summary.md'),tricky),null);
 assert.equal(readDenied(join(project,'fixtures','orbital.sqlite'),tricky),null);
});

test('sandbox flags round-trip through argv into the worker policy',()=>{
 const flags=sandboxArgs({mode:'machine',allow:['C:/refs'],deny:['C:/kepos-data']},'sandbox.js');
 assert.deepEqual(flags.slice(0,2),['-e','sandbox.js']);
 assert.deepEqual(flags.slice(2),['--kepos-read-scope','machine','--kepos-read-allow','C:/refs','--kepos-deny','C:/kepos-data']);
 const policy=argvPolicy(['node','cli',...flags],'C:/task');
 assert.equal(policy.mode,'machine');assert.deepEqual(policy.allow,['C:/refs']);assert.deepEqual(policy.deny,['C:/kepos-data']);
 assert.equal(argvPolicy(['node','cli'],'C:/task').mode,'project');
});

test('worker env whitelist drops shell secrets and honors explicit passthrough',()=>{
 const env=workerEnv({PATH:'a',HOME:'h',OPENAI_API_KEY:'sk-secret',AWS_ACCESS_KEY_ID:'aws',CORP_TOKEN:'corp',KEPOS_WORKER_ENV_PASSTHROUGH:'CORP_TOKEN',SYSTEMROOT:'C:/Windows'},4321);
 assert.equal(env.OPENAI_API_KEY,undefined);
 assert.equal(env.AWS_ACCESS_KEY_ID,undefined);
 assert.equal(env.PATH,'a');assert.equal(env.HOME,'h');assert.equal(env.SYSTEMROOT,'C:/Windows');
 assert.equal(env.CORP_TOKEN,'corp');
 assert.equal(env.ORBITAL_PARENT_PID,'4321');
});

test('the sandbox extension registers a tool_call guard that blocks outside reads',async()=>{
 const mod=await import('../dist/terminal/worker-sandbox.js');
 let guard;const pi={on:(name,handler)=>{assert.equal(name,'tool_call');guard=handler;}};
 mod.default(pi);
 assert.ok(guard,'extension must register the tool_call handler');
 const blocked=await guard({toolName:'read',input:{path:join(tmpdir(),'elsewhere.txt')}},{});
 assert.equal(blocked?.block,true);
 assert.match(String(blocked?.reason),/只读范围限定/);
 const allowed=await guard({toolName:'read',input:{path:'tests/worker-sandbox.test.mjs'}},{});
 assert.equal(allowed,undefined);
 const untouched=await guard({toolName:'edit',input:{path:join(tmpdir(),'elsewhere.txt')}},{});
 assert.equal(untouched,undefined,'read tools only; the pool already refuses mutating tools');
});
