import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredMcpServers, resolveConfiguredMcpGrant, resolveMcpGrant, validateMcpAssessment } from '../dist/terminal/mcp.js';

test('configured servers come from the agent mcp.json plus the project mcp.json',()=>{
 const dir=mkdtempSync(join(tmpdir(),'kepos-mcp-'));
 assert.deepEqual(configuredMcpServers(dir),[]);
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'mcp.json'),JSON.stringify({mcpServers:{deepl:{command:'x'},search:{url:'https://x'}}}));
 assert.deepEqual(configuredMcpServers(dir),['deepl','search']);
 const project=join(mkdtempSync(join(tmpdir(),'kepos-mcpp-')),'proj');
 mkdirSync(join(project,'.pi'),{recursive:true});
 writeFileSync(join(project,'.pi','mcp.json'),JSON.stringify({mcpServers:{local:{command:'y'}}}));
 assert.deepEqual(configuredMcpServers(dir,project),['deepl','search','local']);
 // A broken config grants nothing instead of crashing the delegation path.
 writeFileSync(join(dir,'mcp.json'),'{broken');
 assert.deepEqual(configuredMcpServers(dir),[]);
});

test('mcp grants resolve against configured servers and approval policy',()=>{
 const configured=['deepl','search'];
 assert.deepEqual(resolveMcpGrant(undefined,configured,'human'),{servers:[]});
 assert.match(resolveMcpGrant(true,configured,'human').error,/严格审批模式/);
 assert.match(resolveMcpGrant(['search'],configured,'human').error,/严格审批模式/);
 assert.match(resolveMcpGrant(['nope'],configured,'proxy').error,/未配置/);
 assert.match(resolveMcpGrant(true,configured,'readonly').error,/只读监督/);
 assert.match(resolveMcpGrant(true,[],'proxy').error,/没有任何已配置/);
 assert.match(resolveMcpGrant(['search'],configured,'human').error,/严格审批模式/);
 assert.deepEqual(resolveMcpGrant(['search'],configured,'proxy'),{servers:['search']});
 assert.deepEqual(resolveConfiguredMcpGrant(['search'],configured),{servers:['search']});
 assert.match(resolveConfiguredMcpGrant(['missing'],configured).error,/未配置/);
 assert.deepEqual(validateMcpAssessment({approved:true,servers:['search','invented'],reason:'只需要检索'},['search']),{approved:true,servers:['search'],reason:'只需要检索'});
 assert.equal(validateMcpAssessment({approved:true,servers:['invented']},['search']).approved,false);
 assert.equal(validateMcpAssessment({approved:false,servers:['search'],reason:'不需要'},['search']).approved,false);
});
