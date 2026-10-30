import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'kepos-monitor-'));process.env.ORBITAL_HOME=join(home,'orbital');
const {Desk}=await import('../dist/terminal/desk.js');
const {OrbitalDatabase}=await import('../dist/terminal/database.js');
const {taskSummaries,taskEvidence}=await import('../dist/terminal/monitor.js');
const {initTheme}=await import('@earendil-works/pi-coding-agent');initTheme('dark');
const {visibleWidth}=await import('@earendil-works/pi-tui');
test('monitor list queries omit full output/profile while selected evidence remains available',()=>{
 const db=new OrbitalDatabase(join(home,'monitor.sqlite'));
 const task={id:'remote',agent:'Expert',title:'remote job',cwd:'project-b',parentSessionId:'other',status:'完成',started:100,limit:300,output:'FULL_EVIDENCE_SECRET_SENTINEL',profileSnapshot:{role:'LARGE_ROLE_SENTINEL'}};
 db.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,?)').run('remote','other','c','hash','e','SUCCEEDED',JSON.stringify(task),'{}');
 const list=taskSummaries(db);assert.equal(list.length,1);assert.ok(!JSON.stringify(list).includes('SENTINEL'));assert.equal(taskEvidence(db,'remote').output,task.output);db.close();
});
test('F8/F9 are human-only views and repeated renders reuse source history',()=>{
 let reads=0,sent=0;
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=> 'local',getSessionName:()=> 'fixture',getBranch(){reads++;return[];},getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>sent++,()=>{});
 desk.monitor={tasks:()=>[{id:'other',agent:'Expert',status:'完成',state:'SUCCEEDED',cwd:'project-b',parentSessionId:'other',title:'foreign',started:1,ended:2,limit:300}],evidence:()=>({agent:'Expert',status:'完成',cwd:'project-b',parentSessionId:'other',title:'foreign',started:1,ended:2,limit:300,output:'FOREIGN_EVIDENCE'}),plans:()=>[{id:'plan',state:'NEEDS_HUMAN',goal:'APPROVAL_REQUIRED',cwd:'project-b',completed:1,total:2}]};
 assert.ok(desk.render(150).join('\n').includes('/login'));
 for(let n=0;n<30;n++)desk.render(150);assert.equal(reads,1);
 desk.handleInput('\x1b[19~');assert.equal(desk.taskScope,'all');assert.ok(desk.render(150).join('\n').includes('FOREIGN_EVIDENCE'));
 desk.handleInput('\x1b[20~');assert.ok(desk.render(150).join('\n').includes('APPROVAL_REQUIRED'));desk.editor.setText('must not send');desk.send();assert.equal(sent,0);
 for(const width of [24,40,79,80,100,109,110,120,150])for(const line of desk.render(width))assert.ok(visibleWidth(line)<=width);
 desk.event({type:'agent_settled'});desk.render(150);assert.equal(reads,2);desk.dispose();
});
