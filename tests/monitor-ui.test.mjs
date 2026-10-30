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

test('desk column widths follow the body-first breakpoint table and F11 maximizes',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 desk.render(120);assert.equal(desk.leftWidth,22);assert.equal(desk.rightWidth,24);assert.equal(desk.centerWidth,68);
 desk.render(150);assert.equal(desk.leftWidth,24);assert.equal(desk.rightWidth,30);assert.equal(desk.centerWidth,90);
 desk.render(160);assert.equal(desk.centerWidth,100);
 desk.render(110);assert.equal(desk.leftWidth,0);assert.equal(desk.rightWidth,24);assert.equal(desk.centerWidth,83);
 desk.render(109);assert.equal(desk.centerWidth,82);
 desk.render(99);assert.equal(desk.rightWidth,0);assert.equal(desk.centerWidth,99);
 desk.render(120);desk.handleInput('\x1b[23~');assert.equal(desk.maximize,true);
 desk.render(120);assert.equal(desk.leftWidth,0);assert.equal(desk.rightWidth,0);assert.equal(desk.centerWidth,120);
 desk.handleInput('\x1b');assert.equal(desk.maximize,false);
 desk.render(120);assert.equal(desk.centerWidth,68);
 desk.dispose();
});

test('crew list is two lines per member and Enter opens the member task first',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const agents=[{id:'a',name:'Alice',model:'gpt-x'},{id:'b',name:'Bob',model:'claude-x'}];
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents,drafts:{},folded:[],sessionLinks:{}},[],{tasks:[{id:'t1',agent:'Alice',status:'运行中',state:'RUNNING',cwd:home,parentSessionId:'local'}],children:new Map()},()=>{},()=>{});
 const frame=desk.render(120).join('\n');
 assert.ok(frame.includes('Alice'));assert.ok(frame.includes('未分派'));assert.ok(!frame.includes('gpt-x'),'per-member model moved out of the list');
 assert.ok(frame.includes('● 1 运行'),'header carries a running badge');
 desk.setFocus('crew');desk.crewIndex=0;
 desk.handleInput('\r');
 assert.equal(desk.taskView,true);assert.equal(desk.taskIndex,0);
 desk.taskView=false;
 desk.crewIndex=1; // Bob has no task -> Enter falls back to the config editor action
 let action;const desk2=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents,drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},a=>{action=a;});
 desk2.setFocus('crew');desk2.crewIndex=1;desk2.handleInput('\r');
 assert.deepEqual(action,{kind:'crew',id:'b'});
 desk.dispose();desk2.dispose();
});

test('bottom bar is two rows: status with short usage, notice plus hints',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 const rows=desk.render(120);
 assert.ok(rows[rows.length-2].includes('上下文'),'short usage merged into the status row');
 assert.ok(rows[rows.length-1].includes('F10 议会'));
 desk.notice='临时提示';
 assert.ok(desk.render(120).at(-1).includes('临时提示'));
 desk.dispose();
});

test('read-only preview labels the real send target inside the body',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[{cwd:home,path:'/other/session.jsonl',name:'old chat'}],{tasks:[],children:new Map()},()=>{},()=>{});
 desk.setFocus('projects');desk.selected=1;
 const frame=desk.render(120).join('\n');
 assert.ok(frame.includes('[只读预览] old chat'));
 assert.ok(frame.includes('发送目标仍是当前会话'));
 desk.dispose();
});

test('scrolling back pauses follow and says so until Ctrl+End resumes',()=>{
 const entries=Array.from({length:60},(_,i)=>({id:'e'+i,type:'message',message:{role:'user',content:[{type:'text',text:'消息 '+i}]}}));
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>entries,getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 desk.render(120); // initial paint settles the preview key before scrolling
 desk.handleInput('\x1b[5~'); // PageUp into history
 assert.equal(desk.readStart!==null,true);
 assert.ok(desk.render(120).at(-2).includes('已暂停跟随'));
 desk.readStart=null;
 assert.ok(!desk.render(120).at(-2).includes('已暂停跟随'));
 desk.dispose();
});

test('three-column body is framed with embedded titles, welcome card and usage bar',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,getContextUsage:()=>({tokens:4200,contextWindow:10000,percent:42}),sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 const rows=desk.render(120);
 assert.ok(rows.some(l=>l.includes('╭')&&l.includes('代表席')),'crew panel frame');
 assert.ok(rows.some(l=>l.includes('╭')&&l.includes('主案')),'transcript panel frame');
 assert.ok(rows.some(l=>l.includes('╭')&&l.includes('项目 / 对话')),'projects panel frame');
 assert.ok(rows.some(l=>l.includes('╭')&&l.includes('Kepos 议案')),'welcome card');
 assert.ok(rows.at(-2)?.includes('▓')&&rows.at(-2)?.includes('░'),'usage meter bar');
 desk.dispose();
});

test('side panels carry the card background while the transcript stays untinted',()=>{
 const bgTheme={fg:(c,v)=>v,bg:(c,v)=>`[${c}]${v}`};
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},bgTheme,ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 const rows=desk.render(120);
 const top=rows.find(l=>l.includes('╭')&&l.includes('主案'));
 assert.equal((top.match(/\[toolSuccessBg\]/g)||[]).length,2,'left and right frames tinted, transcript clean');
 const content=rows.find(l=>l.includes('│')&&l.includes('│',20));
 assert.equal((content.match(/\[toolSuccessBg\]/g)||[]).length,2,'content rows tint the side panels only');
 desk.dispose();
});

test('mode chip, panel subtitles and stamped activity stream render',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[{id:'a',name:'Alice',model:'m'}],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 const rows=desk.render(120);
 assert.ok(rows.at(-2)?.includes('-- 输入 --'),'vim-style mode chip');
 assert.ok(rows.some(l=>l.includes('代表席 // 1')),'crew panel subtitle');
 desk.event({type:'agent_start'});
 desk.event({type:'tool_execution_start',toolName:'read'});
 assert.ok(desk.render(120).join('\n').includes('▸ +0.0s read'),'stamped activity line');
 desk.dispose();
});
