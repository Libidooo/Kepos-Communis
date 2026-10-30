import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizePolicy, commandRisk, pathRisk, policyLabel, restrictTools} from '../dist/terminal/approval.js';

test('unknown approval policies fall back to strict human mode',()=>{
 assert.equal(normalizePolicy(undefined),'human');
 assert.equal(normalizePolicy('proxy'),'proxy');
 assert.equal(normalizePolicy('readonly'),'readonly');
 assert.equal(normalizePolicy('yolo'),'human');
 assert.ok(Object.values(policyLabel).every(label=>label.includes('：')));
});

test('commands that approve gates or mutate Kepos data are flagged, ordinary work is not',()=>{
 assert.equal(commandRisk('kepos missions approve gate-1'),'gate');
 assert.equal(commandRisk('git commit -m "x" && kepos missions approve 9'),'gate');
 assert.equal(commandRisk('sqlite3 data/orbital.sqlite "UPDATE mission_jobs SET state"'),'data');
 assert.equal(commandRisk('rm -rf ~/.kepos'),'data');
 assert.equal(commandRisk('echo x > "$KEPOS_HOME/data/orbital.sqlite"'),'data');
 assert.equal(commandRisk('npm test'),null);
 assert.equal(commandRisk('kepos doctor --json'),null);
 assert.equal(commandRisk('grep approve docs/kepos-plan.md'),null);
 assert.equal(commandRisk('kepos missions list | grep approve'),null);
 assert.equal(commandRisk('cat ~/.kepos/config.json'),null);
 assert.equal(commandRisk(''),null);
});

test('file paths inside the Kepos data directory are flagged, project files are not',()=>{
 const base=join(mkdtempSync(join(tmpdir(),'kepos-approval-')),'data');
 assert.equal(pathRisk(join(base,'workspace.json'),base),'data');
 assert.equal(pathRisk(join(base,'nested','orbital.sqlite'),base),'data');
 assert.equal(pathRisk(join(base,'..','escape.txt'),base),null);
 assert.equal(pathRisk(join(tmpdir(),'project','src','app.ts'),base),null);
 assert.equal(pathRisk('',base),null);
});

test('readonly supervision keeps read tools and delegates but drops mutating tools',()=>{
 const kept=restrictTools(['read','bash','powershell','edit','write','grep','find','ls','orbital_delegate','orbital_events']);
 assert.deepEqual(kept,['read','grep','find','ls','orbital_delegate','orbital_events']);
});
