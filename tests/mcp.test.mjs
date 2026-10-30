import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredMcpServers, resolveMcpGrant } from '../dist/terminal/mcp.js';

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
 assert.deepEqual(resolveMcpGrant(true,configured,'human'),{servers:['deepl','search']});
 assert.deepEqual(resolveMcpGrant(['search'],configured,'human'),{servers:['search']});
 assert.match(resolveMcpGrant(['nope'],configured,'human').error,/未配置/);
 assert.match(resolveMcpGrant(true,configured,'readonly').error,/只读监督/);
 assert.match(resolveMcpGrant(true,[],'human').error,/没有任何已配置/);
});
