import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const project=process.cwd();
const scratch=fs.mkdtempSync(path.join(project,'recovery','pack-test-'));
const npm=process.env.npm_execpath;
if(!npm)throw Error('Run this verification using npm run test:package');
try{
 const pack=spawnSync(process.execPath,[npm,'pack','--json','--ignore-scripts','--pack-destination',scratch],{encoding:'utf8',windowsHide:true,env:{...process.env,npm_config_cache:path.join(scratch,'npm-cache')}});
 assert.equal(pack.status,0,pack.stderr);
 const info=JSON.parse(pack.stdout)[0];
 const required=['bin/kepos.cjs','dist/src/cli.js','dist/src/runtime/app.js','dist/terminal/index.js','dist/terminal/workers.js','dist/terminal/worker-host.cjs','dist/terminal/scheduler.js','themes/orbital-76.json','LICENSE','THIRD_PARTY_NOTICES.md'];
 const names=info.files.map(file=>file.path);
 for(const name of required)assert.ok(names.includes(name),'Missing package file: '+name);
 assert.ok(names.every(name=>/^(bin\/|dist\/|themes\/|canvas\/|docs\/|package.json$|README.md$|SECURITY.md$|LICENSE$|THIRD_PARTY_NOTICES.md$)/.test(name)),'Unexpected packed file');
 const tar=createRequire(npm)('tar');
 await tar.x({file:path.join(scratch,info.filename),cwd:scratch});
 const result=spawnSync(process.execPath,[path.join(scratch,'package','bin','kepos.cjs'),'doctor','--home',path.join(scratch,'home'),'--json'],{encoding:'utf8',windowsHide:true,cwd:scratch});
 assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);assert.equal(data.architecture,'sdk');assert.equal(data.themeBundled,true);
 console.log(JSON.stringify({pass:true,version:info.version,packedFiles:names.length,packedBytes:info.size,architecture:data.architecture,dependencySource:'project node_modules (not a clean npm registry install)',modelCalls:0},null,2));
}finally{
 const resolved=path.resolve(scratch);
 if(path.dirname(resolved)!==path.resolve(project,'recovery')||!path.basename(resolved).startsWith('pack-test-'))throw Error('Unexpected package cleanup directory');
 fs.rmSync(resolved,{recursive:true,force:true});
}
