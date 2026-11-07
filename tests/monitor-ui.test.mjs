import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const home=mkdtempSync(join(tmpdir(),'kepos-monitor-'));process.env.ORBITAL_HOME=join(home,'orbital');
const {Desk,KEY_HINTS,keyBytes}=await import('../dist/terminal/desk.js');
const {KeposDatabase}=await import('../dist/terminal/database.js');
const {taskSummaries,taskEvidence,awaitingHuman}=await import('../dist/terminal/monitor.js');
const {countPending}=await import('../dist/terminal/graph-view.js');
const {initTheme}=await import('@earendil-works/pi-coding-agent');initTheme('dark');
const {visibleWidth}=await import('@earendil-works/pi-tui');
test('monitor list queries omit full output/profile while selected evidence remains available',()=>{
 const db=new KeposDatabase(join(home,'monitor.sqlite'));
 const task={id:'remote',agent:'Expert',title:'remote job',cwd:'project-b',parentSessionId:'other',status:'完成',started:100,limit:300,output:'FULL_EVIDENCE_SECRET_SENTINEL',profileSnapshot:{role:'LARGE_ROLE_SENTINEL'}};
 db.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,?)').run('remote','other','c','hash','e','SUCCEEDED',JSON.stringify(task),'{}');
 const list=taskSummaries(db);assert.equal(list.length,1);assert.ok(!JSON.stringify(list).includes('SENTINEL'));assert.equal(taskEvidence(db,'remote').output,task.output);db.close();
});

// 0.5.1：演习报告指出"token 消耗只能靠截停呈报反推"。任务档案现在逐条带 usage，
// 历史任务的书案直接可读，不用再猜。
test('task summaries carry per-task token usage for historical desks',()=>{
 const db=new KeposDatabase(join(home,'monitor-usage.sqlite'));
 const task={id:'u1',agent:'Expert',title:'with usage',cwd:'p',parentSessionId:'s',status:'完成',started:1,limit:60,output:'done',usage:{totalTokens:1234,input:1000,output:234}};
 db.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,?)').run('u1','s','c','hash','e','SUCCEEDED',JSON.stringify(task),'{}');
 const row=taskSummaries(db)[0];
 assert.equal(row.usage?.totalTokens,1234,'usage survives the list query');
 db.close();
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
 assert.ok(frame.includes('Alice'));assert.ok(frame.includes('未分派'));assert.ok(frame.includes('gpt-x'),'member model visible but dimmed');
 assert.ok(frame.includes('● 1 运行'),'header carries a running badge');
 desk.setFocus('crew');desk.crewIndex=0;
 desk.handleInput('\r');
 assert.equal(desk.taskView,true);assert.equal(desk.taskIndex,0);
 desk.taskView=false;
 desk.crewIndex=1; // Bob has no task -> Enter opens the seat profile desk; config stays on double click
 desk.handleInput('\r');
 assert.equal(desk.taskView,true);assert.ok(desk.memberProfile);
 assert.equal(desk.memberProfile.name,'Bob');
 desk.dispose();
});

// 发送后输入框与落盘草稿必须一起清空：setText 不触发 onChange，
// 草稿若留着已发送的原文，Desk 重建时会把发出去的话灌回输入框——"发出去了却没清空"。
test('sending clears the input and the persisted draft together',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const config={projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}};
 let submitted='';
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,config,[],{tasks:[],children:new Map()},text=>{submitted=text;},()=>{});
 desk.render(120);
 desk.editor.setText('你好，分派一个任务');
 desk.editor.onChange?.();
 const key=desk.sessionKey();
 assert.equal(config.drafts[key],'你好，分派一个任务','typing persists a draft');
 desk.send();
 assert.equal(submitted,'你好，分派一个任务','the text actually went out');
 assert.equal(desk.editor.getExpandedText(),'','the input is cleared');
 assert.equal(config.drafts[key],'','the persisted draft is cleared too — a rebuilt desk must not resurrect the sent text');
 desk.dispose();
});

// 单击代表席即在中栏打开该书案——右栏会话单击有中栏预览，左栏不该要求双击。// 没有本会话任务的代表回退到全局历史；从未分派过的代表单击只选中，配置编辑仍走双击。
test('a single click on a crew member opens their desk in the middle column',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const agents=[{id:'a',name:'Alice',model:'gpt-x'},{id:'b',name:'Bob',model:'claude-x'}];
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents,drafts:{},folded:[],sessionLinks:{}},[],{tasks:[{id:'t1',agent:'Alice',status:'运行中',state:'RUNNING',cwd:home,parentSessionId:'local',limit:300,started:Date.now(),usage:{totalTokens:120,input:100,output:20,cacheRead:60,cost:{total:0.01}}}],children:new Map()},()=>{},()=>{});
 desk.render(120); // 布局计算 leftWidth，否则点击落不进左栏判定
 desk.handleMouse({type:'press',x:2,y:6,button:'left',clickCount:1});
 assert.equal(desk.taskView,false,'press only selects');
 desk.handleMouse({type:'click',x:2,y:6,button:'left',clickCount:1});
 assert.equal(desk.taskView,true);assert.equal(desk.taskIndex,0);
 // 带 usage 的书案必须能渲染：cacheHitPercent 是导入函数而非 usage 的方法，写错就是渲染崩溃。
 const frame=desk.render(120).join('\n');
 assert.ok(frame.includes('缓存命中'),'cache share renders for a task with usage');
 desk.taskView=false;
 // Bob 本会话没有任务，但全局历史里有：单击回退到全局任务视图。
 desk.monitor={tasks:()=>[{id:'old',agentId:'b',agent:'Bob',status:'完成',state:'SUCCEEDED',cwd:home,parentSessionId:'other',limit:300,started:1,ended:2,title:'历史任务'}],evidence:()=>({agent:'Bob',status:'完成',state:'SUCCEEDED',cwd:home,parentSessionId:'other',limit:300,started:1,ended:2,output:'HISTORY'}),plans:()=>[]};
 desk.handleMouse({type:'click',x:2,y:9,button:'left',clickCount:1});
 assert.equal(desk.taskView,true,'global history opens for a member without session tasks');
 assert.equal(desk.taskScope,'all');
 desk.taskView=false;
 // 席位改名后旧名字的历史仍能按 agentId 寻回：monitor 里这条只带 agentId。
 desk.monitor={tasks:()=>[{id:'renamed',agentId:'b',agent:'旧名字',status:'完成',state:'SUCCEEDED',cwd:home,parentSessionId:'other',limit:300,started:1,ended:2}],evidence:()=>({agent:'旧名字',status:'完成',state:'SUCCEEDED',cwd:home,parentSessionId:'other',limit:300,started:1,ended:2,output:'RENAMED'}),plans:()=>[]};
 desk.handleMouse({type:'click',x:2,y:9,button:'left',clickCount:1});
 assert.equal(desk.taskView,true,'history follows the seat id across renames');
 desk.taskView=false;
 // 从未分派过的代表：单击同样跳到书案——显示席位基础信息，而不是沉默或只弹提示。
 desk.monitor={tasks:()=>[],evidence:()=>({}),plans:()=>[]};
 desk.handleMouse({type:'click',x:2,y:9,button:'left',clickCount:1});
 assert.equal(desk.taskView,true,'a never-dispatched seat still opens its desk');
 assert.ok(desk.memberProfile,'profile mode is active');
 const profileFrame=desk.render(120).join('\n');
 assert.match(profileFrame,/Bob · 代表席位/,'seat identity is shown');
 assert.match(profileFrame,/职责（配置原文）/,'the configured role text is shown');
 assert.match(profileFrame,/全局历史 0/,'task counts are shown');
 desk.handleInput('\x1b'); // Esc 返回议案
 assert.equal(desk.taskView,false);
 desk.dispose();
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
 assert.ok(rows.some(l=>l.includes('╔')&&l.includes('主案')),'focused transcript panel uses a double frame');
 assert.ok(rows.some(l=>l.includes('╭')&&l.includes('项目 / 对话')),'projects panel frame');
 assert.ok(rows.some(l=>l.includes('╭')&&l.includes('Kepos 议案')),'welcome card');
 assert.ok(rows.at(-2)?.includes('▓')&&rows.at(-2)?.includes('░'),'usage meter bar');
 desk.dispose();
});

test('side panels carry the card background while the transcript keeps the page background',()=>{
 const bgTheme={fg:(c,v)=>v,bg:(c,v)=>`[${c}]${v}`};
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},bgTheme,ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 const rows=desk.render(120);
 const top=rows.find(l=>l.includes('╭')&&l.includes('主案'));
 // 侧栏是 card 面（toolSuccessBg），正文是页面底（userMessageBg）：两者不同才有纵深。
 assert.equal((top.match(/\[toolSuccessBg\]/g)||[]).length,2,'left and right frames tinted as cards');
 assert.ok(top.includes('[userMessageBg]'),'the frame row sits on the page background');
 const content=rows.find(l=>l.includes('│')&&l.includes('│',20));
 assert.equal((content.match(/\[toolSuccessBg\]/g)||[]).length,2,'content rows tint the side panels only');
 // 整页铺页面底色：浅色主题靠它才是浅色，否则会沿用深色终端底而"大面积发黑"。
 assert.ok(content.includes('[userMessageBg]'),'content rows sit on the page background');
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

test('scrollbar thumb tracks reading position in the framed transcript',()=>{
 const entries=Array.from({length:80},(_,i)=>({id:'e'+i,type:'message',message:{role:'user',content:[{type:'text',text:'消息 '+i}]}}));
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>entries,getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 desk.render(120); // 先渲染一帧让布局就绪（真实 UI 恒先渲染后按键），再翻页
 desk.handleInput('\x1b[5~');
 const scrolled=desk.render(120).join('\n');
 assert.ok(scrolled.includes('已暂停跟随'),'reading state is announced in the status line');
 // 0.5.1 后滚动槽整条删除（· 轨道在右缘形成一列点，人类要求取消）：
 // · 是全界面通用的间隔号，断言瞄准轨道特征——紧贴边框的点位/拇指列；
 // "..." 只禁于带边框的正文区（状态行在窄终端下允许截断，那是 chrome 不是内容）。
 const plainLines=scrolled.split('\n').map(l=>l.replace(/\x1b\[[0-9;]*m/g,''));
 // 只约束中栏：侧栏截断长目录名是合法行为（› kepos-xxx...），中栏才是"严格显示"的对象。
 const center=plainLines.map(l=>{const parts=l.split('│');return parts.length>=4?parts[2]:'';});
 assert.ok(!center.some(c=>/[·▓]\s*$/.test(c)),'no glyph track hugging the centre border');
 assert.ok(!center.some(c=>c.includes('...')),'no truncation dots inside the centre column');
 desk.dispose();
});

test('transcript distinguishes user input, thinking and tool output',()=>{
 const entries=[
  {id:'u',type:'message',message:{role:'user',content:[{type:'text',text:'你好'}]}},
  {id:'t',type:'message',message:{role:'assistant',content:[{type:'thinking',thinking:'内心戏'},{type:'text',text:'回答正文'}]}},
  {id:'r',type:'message',message:{role:'toolResult',toolName:'read',content:[{type:'text',text:'工具输出'}]}}];
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>entries,getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(c,v)=>`[${c}]${v}`,bg:(c,v)=>`{${c}}${v}`},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 const frame=desk.render(120).join('\n');
 assert.ok(frame.includes('▎')&&frame.includes('内心戏'),'thinking block dimmed with bar');
 assert.ok(frame.includes('▏')&&frame.includes('工具输出'),'tool output muted with bar');
 assert.ok(frame.includes('{userMessageBg}'),'user lines carry a tint');
 assert.ok(frame.includes('┊ ▸ read'),'tool call line marked');
 desk.dispose();
});

test('urgent notices stick until Esc or a new send, and render with the warning mark',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 desk.urgent('✕ 子 Agent Alice 失败：超时');
 desk.notice='正在调用 bash';
 assert.equal(desk.notice,'✕ 子 Agent Alice 失败：超时','ordinary notices cannot clobber an urgent one');
 const row=desk.render(120).at(-1);
 assert.ok(row.includes('⚠ ')&&row.includes('子 Agent Alice 失败'),'urgent carries the warning mark');
 assert.ok(visibleWidth(row)<=120,'warning prefix stays inside the width budget');
 desk.handleInput('\x1b'); // Esc 先吃掉紧急通知
 assert.equal(desk.notice,'');
 desk.notice='普通提示恢复';
 assert.equal(desk.notice,'普通提示恢复','notice channel resumes after the urgent one is dismissed');
 desk.dispose();
});

test('sending a message clears the urgent notice so the channel resumes',()=>{
 let sent=0;
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>sent++,()=>{});
 desk.urgent('✕ 上一轮失败');
 desk.editor.setText('继续');
 desk.send();
 assert.equal(sent,1);
 assert.equal(desk.notice,'正在提交给主 Agent…','send resets the notice channel');
 desk.dispose();
});

test('footer hints are context filtered and every visible hint is clickable',()=>{
 const ctx={cwd:home,isIdle:()=>true,model:undefined,sessionManager:{getSessionFile:()=>'/fixture',getSessionId:()=>'local',getSessionName:()=>'fixture',getBranch:()=>[],getEntries:()=>[]}};
 const desk=new Desk({terminal:{rows:35},requestRender(){}},{fg:(_c,s)=>s},ctx,{projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}},[],{tasks:[],children:new Map()},()=>{},()=>{});
 for(const hint of KEY_HINTS)if(hint.footer)assert.ok(keyBytes[hint.key],'footer hint '+hint.key+' must be clickable');
 assert.ok(desk.render(120).at(-1).includes('Ctrl+X 中止'),'abort stays discoverable in the footer');
 desk.handleInput('\x1b[21~'); // F10 打开议会环
 assert.ok(desk.footerHints().some(h=>h.key==='tab'),'council scope surfaces the list toggle');
 desk.councilList=true;desk.graphFocus='list';
 const list=desk.footerHints().map(h=>h.key);
 assert.ok(list.includes('slash')&&list.includes('v'),'list scope surfaces filter hints');
 desk.dispose();
});

test('side-panel rows always set a foreground colour so tinted panels stay readable', async () => {
  // The panels sit on a tinted background; a row without an explicit foreground inherits the
  // terminal default and can disappear on a light theme.
  const { loadThemeFromPath } = await import(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js', import.meta.url));
  // 跨平台：必须用 fileURLToPath 转换；手动剥前导斜杠只在 Windows 上凑巧成立，
  // 在 Linux / macOS 上会把绝对路径变成相对路径，CI 直接 ENOENT。
  const light = loadThemeFromPath(fileURLToPath(new URL('../themes/kepos-light.json', import.meta.url)), 'truecolor');
  const ctx = { cwd: home, isIdle: () => true, model: { id: 'fixture' }, sessionManager: { getSessionFile: () => '/fixture', getSessionId: () => 'local', getSessionName: () => 'fixture', getBranch: () => [], getEntries: () => [] } };
  const sessions = [{ path: '/s1.jsonl', cwd: home, name: 'old chat' }];
  const desk = new Desk({ terminal: { rows: 30 }, requestRender() {} }, light, ctx,
    { projects: [], agents: [{ id: 'a', name: '审查员', model: 'gpt' }], drafts: {}, folded: [], sessionLinks: {} },
    sessions, { tasks: [], children: new Map() }, () => {}, () => {});
  for (const row of desk.render(120)) {
    if (!row.includes('[48;2;')) continue;                        // only tinted (side) rows
    const plain = row.replace(/\x1b\[[0-9;]*m/g, '').replace(/[─╭╮╰╯│╔╗╚╝═║ ]/g, '');
    if (plain.length < 6) continue;                                // frames only
    assert.ok(/38;2;\d+;\d+;\d+m/.test(row), `tinted row has text but no foreground: ${JSON.stringify(plain.slice(0, 40))}`);
  }
  desk.dispose();
});

test('the task view puts "waiting on you" above work, and healthy tasks never expand', () => {
  const ctx = { cwd: home, isIdle: () => true, model: undefined, sessionManager: { getSessionFile: () => '/fixture', getSessionId: () => 'local', getSessionName: () => 'fixture', getBranch: () => [], getEntries: () => [] } };
  const task = (id, state, extra = {}) => ({ id, agent: 'Agent-' + id, state, status: state, cwd: home, parentSessionId: 'local', title: 'TASK_' + id, started: 100, limit: 300, output: 'OUTPUT_' + id, ...extra });
  const tasks = [
    task('done', 'SUCCEEDED', { ended: 200 }),
    task('run', 'RUNNING'),
    task('gate', 'NEEDS_HUMAN'),
    task('stall', 'RUNNING', { stalled: true, reviewDue: true }),
    task('boom', 'FAILED', { ended: Date.now() + 1000, error: '认证失败' }),
  ];
  const desk = new Desk({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_c, s) => s }, ctx, { projects: [], agents: [], drafts: {}, folded: [], sessionLinks: {} }, [], { tasks, children: new Map() }, () => {}, () => {});
  desk.taskView = true;
  const frame = desk.render(120).join('\n');
  // 等待区在顶：门禁（最急）先于空转，空转先于失败。
  assert.ok(frame.indexOf('TASK_gate') < frame.indexOf('TASK_stall'), 'approval gate comes before a stall');
  assert.ok(frame.indexOf('TASK_stall') < frame.indexOf('TASK_boom'), 'a stall comes before a settled failure');
  assert.ok(frame.includes('等你处理 3'), 'the waiting section counts only pending items');
  assert.ok(frame.includes('F2 审批'), 'each waiting item carries its direct action');
  // 计数行只报工作中/已完成，健康任务不展开正文。
  assert.ok(frame.includes('工作中 2 · 已完成 1'), 'counts use the single口径');
  assert.ok(!frame.includes('OUTPUT_run') || desk.taskIndex === 1, 'the selected task expands, others do not');

  // 选中顺序：0 是门禁。Ctrl+→ 走到空转，再走到失败。
  desk.taskIndex = 0;
  assert.ok(desk.render(120).join('\n').includes('TASK_gate'), 'index 0 selects the approval gate');
  desk.handleInput('\x1b[1;5C');
  assert.ok(desk.render(120).join('\n').includes('TASK_stall'));
  // 确认失败项后它落回历史，不再占等待区。
  desk.taskIndex = 2;
  desk.handleInput('\r');
  const after = desk.render(120).join('\n');
  assert.ok(!after.includes('等你处理 3'), 'an acknowledged failure leaves the waiting section');
  assert.ok(after.includes('历史'), 'history remains reachable');
  desk.dispose();
});

test('settled failures from before the desk existed never re-raise as waiting', () => {
  const ctx = { cwd: home, isIdle: () => true, model: undefined, sessionManager: { getSessionFile: () => '/fixture', getSessionId: () => 'local', getSessionName: () => 'fixture', getBranch: () => [], getEntries: () => [] } };
  // 启动时加载的历史失败：ended 早于 Desk 创建时刻。
  const tasks = [{ id: 'old', agent: 'Agent-old', state: 'FAILED', status: '失败', cwd: home, parentSessionId: 'local', title: 'OLD_FAILURE', started: 1, ended: 2, limit: 300, output: 'OLD_OUTPUT' }];
  const desk = new Desk({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_c, s) => s }, ctx, { projects: [], agents: [], drafts: {}, folded: [], sessionLinks: {} }, [], { tasks, children: new Map() }, () => {}, () => {});
  desk.taskView = true;
  const frame = desk.render(120).join('\n');
  assert.ok(frame.includes('没有等你处理的事项'), 'old failures are history, not a pending gate');
  assert.ok(frame.includes('历史 1 条'), 'still counted, just not raised');
  desk.dispose();
});

test('the ring badge and the waiting section use one pending selector', () => {
  const tasks = [
    { id: 'gate', agent: 'A', state: 'NEEDS_HUMAN', status: '等待人类审批', title: 'g', started: 1 },
    { id: 'done', agent: 'B', state: 'SUCCEEDED', status: '完成', title: 'd', started: 1, ended: 2 },
    { id: 'fail', agent: 'C', state: 'FAILED', status: '失败', title: 'f', started: 1, ended: 2 },
  ];
  assert.equal(countPending(tasks), 1, 'settled tasks never count as pending');
  assert.equal(awaitingHuman(tasks).length, 1);
});

test('human, 总理 and delegate messages are visually distinct in every theme', async () => {
  const { loadThemeFromPath } = await import(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js', import.meta.url));
  const { historyLines } = await import('../dist/terminal/desk.js');
  const { fileURLToPath } = await import('node:url');
  for (const themeName of ['kepos-light', 'kepos-dark', 'kepos-default']) {
    const theme = loadThemeFromPath(fileURLToPath(new URL(`../themes/${themeName}.json`, import.meta.url)), 'truecolor');
    const entries = [
      { type: 'message', message: { role: 'user', content: 'HUMAN_LINE' } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'PM_LINE' }] } },
      { type: 'custom_message', customType: 'kepos-task-result', display: true, content: '子 Agent「审查员」DELEGATE_LINE' },
    ];
    const out = historyLines(entries, 60, false, theme);
    const find = keyword => out.find(line => line.includes(keyword));
    const human = find('HUMAN_LINE'), pm = find('PM_LINE'), delegate = find('DELEGATE_LINE');
    assert.ok(human && pm && delegate, `${themeName}: all three speakers render`);

    // Each speaker carries a distinct background: the human's block, the 总理's card, and the
    // delegate's rule-marked output (no fill). Identical fills mean no visual centre.
    const bgOf = line => (line.match(/48;2;[\d;]+m/g) || [])[0] || 'none';
    assert.equal(bgOf(delegate), 'none', `${themeName}: delegates use a rule, not a fill`);
    assert.ok(bgOf(human) !== 'none', `${themeName}: the human has a block`);
    assert.ok(bgOf(pm) !== 'none', `${themeName}: the 总理 has a card`);
    assert.notEqual(bgOf(human), bgOf(pm), `${themeName}: 总理 must not share the human's fill`);

    // Speaker labels differ in both wording and colour.
    const speakerOf = keyword => out.find(line => line.includes(keyword) && !line.includes('_LINE')) || '';
    assert.ok(out.some(line => line.includes('◆ Kepos 总理')), `${themeName}: 总理 label`);
    assert.ok(out.some(line => line.includes('◈ 审查员')), `${themeName}: delegate label names the agent`);
    assert.ok(out.some(line => line.includes('› 你')), `${themeName}: human label`);
    void speakerOf;
  }
});

// 工具信息默认折叠：40 行输出应压成一行摘要，但失败的工具必须强制展开，
// 否则错误会被折叠藏起来。F5 切到 full 后完整输出恢复。
test('tool output folds to one summary line but failures always stay expanded', async () => {
  const { historyLines } = await import('../dist/terminal/desk.js');
  const plainTheme = { fg: (_c, v) => v };
  const longOutput = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
  const ok = [{ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: longOutput }] } }];
  const failed = [{ type: 'message', message: { role: 'toolResult', toolName: 'bash', isError: true, content: [{ type: 'text', text: longOutput }] } }];

  const summary = historyLines(ok, 80, 'summary', plainTheme);
  const full = historyLines(ok, 80, 'full', plainTheme);
  assert.ok(summary.length < full.length, 'summary is more compact than full');
  assert.ok(summary.some(line => line.includes('F5 展开')), 'summary advertises how to expand');

  const failedSummary = historyLines(failed, 80, 'summary', plainTheme);
  assert.ok(failedSummary.length > summary.length, 'failed tool output is not collapsed');

// 思考默认展开，折叠后留一行占位作点击入口；占位与正文都以 ▎ 开头，是同一类点击目标。
test('thinking expands by default and collapses to a clickable placeholder', async () => {
  const { historyLines } = await import('../dist/terminal/desk.js');
  const plainTheme = { fg: (_c, v) => v };
  const entries = [{ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '长思考第一行\n长思考第二行' }, { type: 'text', text: '答案' }] } }];
  const shown = historyLines(entries, 80, 'summary', plainTheme);
  assert.ok(shown.some(line => line.includes('长思考第二行')), 'thinking is expanded by default');
  const hidden = historyLines(entries, 80, 'summary', plainTheme, { thinkingHidden: true });
  assert.ok(hidden.some(line => line.includes('思考已折叠')), 'placeholder row remains as the entry point');
  assert.ok(!hidden.some(line => line.includes('长思考第二行')), 'thinking body is hidden');
});

// 点击一条工具行/思考行 = 整类切换：点一处、全部生效（与 F5 同源）。
test('clicking a tool row or thinking row toggles the whole class', async () => {
  const { Desk } = await import('../dist/terminal/desk.js');
  const entries = [
    { type: 'message', message: { role: 'user', content: '查一下' } },
    { type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'line-1\nline-2\nline-3' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想想\n再想想' }, { type: 'text', text: '结论' }] } },
  ];
  const ctx = { cwd: home, isIdle: () => true, model: { id: 'fixture' }, sessionManager: { getSessionFile: () => '/fixture', getSessionId: () => 'local', getSessionName: () => 'fixture', getBranch: () => entries, getEntries: () => [] } };
  const desk = new Desk({ terminal: { rows: 35 }, requestRender() {} }, { fg: (_c, s) => s, bg: (_c, s) => s }, ctx, { projects: [], agents: [], drafts: {}, folded: [], sessionLinks: {} }, [], { tasks: [], children: new Map() }, () => {}, () => {});
  desk.render(120);
  const strip = line => line.replace(/\x1b\[[0-9;]*m/g, '');
  const toolRow = desk.visibleCenter.findIndex(line => strip(line).startsWith('▏'));
  const thinkRow = desk.visibleCenter.findIndex(line => strip(line).startsWith('▎'));
  assert.ok(toolRow >= 0, 'a collapsed tool row is on screen');
  assert.ok(thinkRow >= 0, 'a thinking row is on screen');
  const centerX = 22 + 3 + 2; // 左栏 22 + 分隔 3 + 边距 2
  desk.handleMouse({ type: 'click', x: centerX + 2, y: toolRow + 3, button: 'left', clickCount: 1 });
  assert.equal(desk.expandedTools, true, 'one click expands all tool output');
  desk.handleMouse({ type: 'click', x: centerX + 2, y: thinkRow + 3, button: 'left', clickCount: 1 });
  assert.equal(desk.thinkingHidden, true, 'one click collapses all thinking');
  const frame = desk.render(120).join('\n');
  assert.ok(frame.includes('思考已折叠'), 'placeholder replaces the thinking body');
  desk.dispose();
});
  assert.ok(failedSummary.some(line => line.includes('line-39')), 'failed output stays readable to the end');
});

// 审批模式必须常驻可见：此前只有在 F2 菜单里才能看到当前模式，
// 操作时根本不知道自己处在哪种授权下。三态用不同符号与颜色区分。
test('the approval mode is always visible in the status bar', () => {
  const ctx = { cwd: home, isIdle: () => true, model: undefined, sessionManager: { getSessionFile: () => '/fixture', getSessionId: () => 'local', getSessionName: () => 'fixture', getBranch: () => [], getEntries: () => [] } };
  const desk = new Desk({ terminal: { rows: 35 }, requestRender() {} }, { fg: (_c, s) => s, bg: (_c, s) => s }, ctx, { projects: [], agents: [], drafts: {}, folded: [], sessionLinks: {} }, [], { tasks: [], children: new Map() }, () => {}, () => {});
  const statusOf = () => desk.render(120).at(-2);
  desk.approvalPolicy = () => 'human';
  assert.ok(statusOf().includes('⛨ 严格'), 'strict mode is labelled');
  desk.approvalPolicy = () => 'proxy';
  assert.ok(statusOf().includes('⚖ 代理'), 'proxy mode is labelled');
  desk.approvalPolicy = () => 'readonly';
  assert.ok(statusOf().includes('⊙ 只读'), 'readonly mode is labelled');
  // 默认（未注入回调）按严格处理，绝不默认放宽。
  desk.approvalPolicy = undefined;
  assert.ok(statusOf().includes('⛨ 严格'), 'missing callback falls back to strict');
  desk.dispose();
});

// 规格要求书案显示验收进度 ▓▓░░░ 2/5。步骤数不等于验收数，
// 只显示前者会让 5/5 看起来已完成，而验收可能一条没勾。
test('the plan console shows acceptance progress beside the step count',()=>{
  const ctx = { cwd: home, isIdle: () => true, model: undefined, sessionManager: { getSessionFile: () => '/fixture', getSessionId: () => 'local', getSessionName: () => 'fixture', getBranch: () => [], getEntries: () => [] } };
  const desk = new Desk({ terminal: { rows: 35 }, requestRender() {} }, { fg: (_c, s) => s }, ctx, { projects: [], agents: [], drafts: {}, folded: [], sessionLinks: {} }, [], { tasks: [], children: new Map() }, () => {}, () => {});
  desk.monitor = { tasks: () => [], evidence: () => undefined, plans: () => [
    { id: 'm1', state: 'NEEDS_HUMAN', goal: '验收未勾满', cwd: home, completed: 2, total: 2, attention: 0, acceptance: { done: 2, total: 5 } },
    { id: 'm2', state: 'SUCCEEDED', goal: '没有验收条目', cwd: home, completed: 1, total: 1, attention: 0, acceptance: { done: 0, total: 0 } },
  ] };
  desk.missionView = true;
  const frame = desk.render(120).join('\n');
  assert.ok(frame.includes('2/2 步'), 'step progress still shown');
  assert.ok(frame.includes('2/5 验收'), 'acceptance progress shown separately');
  assert.ok(frame.includes('▓▓') && frame.includes('░░░'), 'a bar renders for partial acceptance');
  // 没有验收条目的计划不该显示 0/0 验空，那只是噪声。
  assert.ok(!frame.includes('0/0 验收'), 'a plan without acceptance shows no bar');
  desk.dispose();
});

// 右侧会话列表按 Enter 进入历史会话。Desk 只发出 {kind:'switch'} 并关闭自己，
// 真正的切换在外层做——那个分支曾缺失，导致回车毫无反应。
test('Enter on a session row emits a switch action for the outer layer', () => {
  let emitted;
  const ctx = { cwd: home, isIdle: () => true, model: undefined, sessionManager: { getSessionFile: () => '/current.jsonl', getSessionId: () => 'local', getSessionName: () => 'current', getBranch: () => [], getEntries: () => [] } };
  const sessions = [{ path: '/old.jsonl', cwd: home, name: '旧对话' }];
  const desk = new Desk({ terminal: { rows: 35 }, requestRender() {} }, { fg: (_c, s) => s }, ctx, { projects: [], agents: [], drafts: {}, folded: [], sessionLinks: {} }, sessions, { tasks: [], children: new Map() }, () => {}, a => { emitted = a; });
  desk.setFocus('projects');
  // 行 0 是项目本身，行 1 是会话。
  desk.selected = desk.rows().findIndex(r => r.kind === 'session');
  assert.ok(desk.selected >= 0, 'a session row exists to select');
  desk.handleInput('\r');
  assert.deepEqual(emitted, { kind: 'switch', path: '/old.jsonl' }, 'the outer layer receives the switch request');
  desk.dispose();
});

// 选中当前会话时不该"切换"到自己，只是把焦点交回输入区。
test('Enter on the current session hands focus back to the input', () => {
  let emitted;
  const ctx = { cwd: home, isIdle: () => true, model: undefined, sessionManager: { getSessionFile: () => '/current.jsonl', getSessionId: () => 'local', getSessionName: () => 'current', getBranch: () => [], getEntries: () => [] } };
  const sessions = [{ path: '/current.jsonl', cwd: home, name: '当前对话' }];
  const desk = new Desk({ terminal: { rows: 35 }, requestRender() {} }, { fg: (_c, s) => s }, ctx, { projects: [], agents: [], drafts: {}, folded: [], sessionLinks: {} }, sessions, { tasks: [], children: new Map() }, () => {}, a => { emitted = a; });
  desk.setFocus('projects');
  desk.selected = desk.rows().findIndex(r => r.kind === 'session');
  desk.handleInput('\r');
  assert.equal(emitted, undefined, 'no switch for the session already open');
  assert.equal(desk.focus, 'input');
  desk.dispose();
});
