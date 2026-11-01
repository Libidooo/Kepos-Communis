import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const home=mkdtempSync(join(tmpdir(),'kepos-monitor-'));process.env.ORBITAL_HOME=join(home,'orbital');
const {Desk,KEY_HINTS,keyBytes}=await import('../dist/terminal/desk.js');
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
 assert.ok(frame.includes('Alice'));assert.ok(frame.includes('未分派'));assert.ok(frame.includes('gpt-x'),'member model visible but dimmed');
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
 const following=desk.render(120);
 assert.ok(following.some(l=>l.includes('▓')&&l.includes('│')),'thumb visible inside the transcript frame');
 desk.handleInput('\x1b[5~');
 const scrolled=desk.render(120).join('\n');
 assert.ok(scrolled.includes('已暂停跟随'));
 assert.ok(scrolled.includes('·'),'track dots visible while scrolled');
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
  const light = loadThemeFromPath(new URL('../themes/kepos-light.json', import.meta.url).pathname.replace(/^\//, ''), 'truecolor');
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
    assert.ok(out.some(line => line.includes('◆ 总理')), `${themeName}: 总理 label`);
    assert.ok(out.some(line => line.includes('◈ 审查员')), `${themeName}: delegate label names the agent`);
    assert.ok(out.some(line => line.includes('› 你')), `${themeName}: human label`);
    void speakerOf;
  }
});
