import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { Desk, fit, historyLines } from './desk.ts';
import { loadConfig, saveConfig, createSessionFile, projectPath, clean, root, profileHistory, restoreProfile, type Crew } from './store.ts';
import { orbitalSessionStore } from './session-store.ts';
import { db } from './database.ts';
import { ownedUI } from './dialogs.ts';
import { boundedJson, boundedText } from './presentation.ts';
import { outputPage, receiptView } from './result-view.ts';
import { agentRevision } from './profiles.ts';
import { COUNCIL_ROLES, councilLocale, councilRole, roleName, roleScope, roleOptions, rolePrompt, roleDomain, domainName, type CouncilRoleKey } from './council-roles.ts';
import { MissionScheduler } from './scheduler.ts';
import { taskSummaries, taskEvidence, planSummaries } from './monitor.ts';
import { readWorkerEvents } from './events.ts';
import { WorkerPool, terminalStates, mergeUsage, DEFAULT_TASK_SECONDS, HUMAN_APPROVAL_THRESHOLD_SECONDS, MAX_CONCURRENT_CHILDREN, MAX_TASK_SECONDS, READ_ONLY_TOOLS, SUPERVISION_INTERVAL_SECONDS, type WorkerHandle } from './workers.ts';
import { APPROVAL_POLICIES, commandRisk, normalizePolicy, pathRisk, policyLabel, restrictTools, riskReason } from './approval.ts';
import { dataRoot } from './paths.ts';
export { fit, historyLines };
export interface KeposHost {login?:(ctx:any,provider?:string)=>Promise<void>;logout?:(ctx:any,provider?:string)=>Promise<void>;authStatus?:()=>unknown;}
const DEFAULT_COUNCIL_ROLE_COUNT = 10;
export default function orbital(pi: ExtensionAPI, host:KeposHost={}) {
 const config=loadConfig();const poolKey=Symbol.for('orbital.worker-pool:'+root);const globalStore=globalThis as any;const pool:WorkerPool=globalStore[poolKey]||(globalStore[poolKey]=new WorkerPool());let valid=true;let generation=0;let desk:Desk|undefined;let current:any;let busy=false;let tool='';let pulse=0;let pulseTimer:any;let repaintTimer:any;let reloadNotice='';
 const missionKey=Symbol.for('kepos.mission-scheduler:'+root);
 const scheduler:MissionScheduler=globalStore[missionKey]||(globalStore[missionKey]=new MissionScheduler(db(),pool));
 const planSummary=(m:any)=>({id:m.id,goal:m.goal,state:m.state,cwd:m.cwd,jobs:m.jobs.map((j:any)=>({id:j.id,state:j.state,task:j.task.slice(0,300),agent:j.agent.name,requiresHuman:j.requiresHuman,checkpoint:j.checkpoint?.slice(0,500),error:j.error}))});
 const save=()=>{saveConfig(config);refreshSupervisionPrompt?.();desk?.invalidate();};
 const currentPolicy=()=>normalizePolicy(config.approvalPolicy);
 let baselineTools:string[]=[];
 const applyApprovalPolicy=()=>{if(!baselineTools.length)return;try{pi.setActiveTools(currentPolicy()==='readonly'?restrictTools(baselineTools):baselineTools);}catch(error){desk&&(desk.notice='审批模式切换失败：'+clean(error));scheduleRepaint();}};
 function initializeCrew(ctx:any){
  if(ctx.mode!=='tui'||!ctx.model?.id||ctx.model.id==='unknown')return;
  // Seed the ten council seats exactly once; afterwards deleted members stay deleted.
  if(config.initialized)return;
  const locale=councilLocale(process.env.KEPOS_LOCALE);const existingKeys=new Set(config.agents.map(agent=>agent.roleKey).filter(Boolean));const existingNames=new Set(config.agents.map(agent=>agent.name));let changed=false;
  for(const role of COUNCIL_ROLES){if(config.agents.length>=DEFAULT_COUNCIL_ROLE_COUNT)break;if(existingKeys.has(role.key))continue;const name=roleName(role,locale);if(existingNames.has(name))continue;config.agents.push({id:randomUUID(),name,roleKey:role.key,role:rolePrompt(role,locale),model:ctx.model.id,provider:ctx.model.provider});existingKeys.add(role.key);existingNames.add(name);changed=true;}
  if(!config.initialized||changed){config.initialized=true;save();}
 }
 const createLinkedSession=(ctx:any,cwd:string,title:string)=>{const piPath=createSessionFile(cwd,title,sessionDir(ctx));const logical=orbitalSessionStore.createSession({cwd,title,piSessionFile:piPath});config.sessionLinks[piPath]=logical.logicalSessionId;save();return piPath;};
 const repaint=()=>desk?.refresh();const scheduleRepaint=()=>{if(repaintTimer)return;repaintTimer=setTimeout(()=>{repaintTimer=undefined;repaint();},75);};pool.change=scheduleRepaint;
 let unsubscribePool:()=>void=()=>{};let unsubscribeMissions:()=>void=()=>{};
 const bindPool=()=>{unsubscribePool();unsubscribeMissions();unsubscribeMissions=scheduler.subscribe(event=>{if(!desk)return;if(event.state==='NEEDS_HUMAN'&&process.stdout.isTTY)process.stdout.write('\x07');if(['NEEDS_HUMAN','SUCCEEDED','FAILED'].includes(event.state)){desk.notice=`${event.state==='NEEDS_HUMAN'?'需要人类处理':'计划状态更新'}：${event.goal} · ${event.cwd} · F9查看`;desk.refresh();}});unsubscribePool=pool.subscribe(event=>{
  if(!desk)return;
  if(event.type!=='task_progress')desk.invalidate();
  if(event.task.cwd===desk.ctx.cwd&&event.task.parentSessionId===desk.ctx.sessionManager.getSessionId())desk.notice=event.type==='task_finished'?`子 Agent ${event.task.agent}：${event.task.status}`:event.type==='task_review_due'?`子 Agent ${event.task.agent} 到达 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核点 · 请主 Agent 检查`:desk.notice;
  scheduleRepaint();
 });};bindPool();
 function install(ctx:any){current=ctx;if(ctx.mode!=='tui'||process.env.KEPOS_APP!=='1')return;
 ctx.ui.setTitle('Kepos Communis');ctx.ui.setHeader((_tui:any,theme:any)=>({invalidate(){},render(width:number){const title='  Kepos Communis';const line=(s:string,color:any)=>theme.fg(color,fit(s,width));return [line(title,'accent')];}}));
 ctx.ui.setWidget('orbital-model',(_tui:any,theme:any)=>({invalidate(){},render(width:number){const live=busy?'accent':current?.model?'success':'warning';return[theme.fg(live,fit(`  · ${clean(current?.model?.id||'请先 /login')} · ${busy?'执行中':current?.model?'空闲':'待连接'}`,width))];}}));}
 for(const name of ['agent_start','agent_settled','message_start','message_update','message_end','tool_execution_start','tool_execution_update','tool_execution_end'] as const)pi.on(name as any,async(e:any,ctx:any)=>{current=ctx;if(name==='agent_start')busy=true;if(name==='agent_settled'){busy=false;tool='';}if(name==='tool_execution_start')tool=e.toolName;if(name==='tool_execution_end')tool='';if(name==='agent_settled'){const path=ctx.sessionManager.getSessionFile();const logical=path&&config.sessionLinks[path];if(logical){try{orbitalSessionStore.syncPi(logical,ctx.sessionManager.getEntries(),ctx.sessionManager.buildContextEntries(),ctx.sessionManager.getSessionId());}catch(error){ctx.ui.notify('历史镜像失败（Pi 原始记录仍保留）：'+clean(error),'warning');}}}desk?.event(e);});
 pi.on('session_start',async(_e,ctx)=>{valid=true;generation++;bindPool();pool.change=scheduleRepaint;const sessionFile=ctx.sessionManager.getSessionFile();if(sessionFile&&!config.sessionLinks[sessionFile]){const linked=orbitalSessionStore.createSession({cwd:ctx.cwd,title:ctx.sessionManager.getSessionName()||'未命名对话',piSessionFile:sessionFile});config.sessionLinks[sessionFile]=linked.logicalSessionId;save();}if(sessionFile&&config.sessionLinks[sessionFile]){const logical=config.sessionLinks[sessionFile];try{orbitalSessionStore.syncPi(logical,ctx.sessionManager.getEntries(),ctx.sessionManager.buildContextEntries(),ctx.sessionManager.getSessionId());}catch(error){ctx.ui.notify('历史镜像同步失败，原始会话未修改：'+clean(error),'warning');}}initializeCrew(ctx);install(ctx);try{baselineTools=pi.getActiveTools();}catch{}applyApprovalPolicy();const pending=db().get<any>('ui_reload');if(pending?.pid===process.pid&&pending.sessionId===ctx.sessionManager.getSessionId()&&Date.now()-pending.at<30000){db().set('ui_reload',null);setTimeout(()=>{if(valid){reloadNotice=`扩展已重载 · ${config.agents.length} 位已配置成员 · 当前会话和草稿保留`;ctx.ui.notify(reloadNotice,'info');pi.sendUserMessage('/kepos',{expandPromptTemplates:true});}},100);}});pi.on('model_select',async(_e,ctx)=>{current=ctx;initializeCrew(ctx);if(desk)desk.ctx=ctx;repaint();});
 for(const eventName of ['session_compact','session_tree'] as const)pi.on(eventName as any,async(_event:any,ctx:any)=>{desk?.invalidate();const path=ctx.sessionManager.getSessionFile();const logical=path&&config.sessionLinks[path];if(logical)try{orbitalSessionStore.syncPi(logical,ctx.sessionManager.getEntries(),ctx.sessionManager.buildContextEntries(),ctx.sessionManager.getSessionId());}catch(error){ctx.ui.notify('历史代际同步失败：'+clean(error),'warning');}});
 const gateRiskOf=(event:any)=>event?.toolName==='bash'||event?.toolName==='powershell'?commandRisk(String(event.input?.command||'')):event?.input&&typeof event.input.path==='string'?pathRisk(event.input.path,dataRoot):null;
 // Human gates and Kepos's own store are the human's to mutate. Strict mode asks per call,
 // proxy mode lets the model proceed with an audit trail, readonly mode removes the tools.
 pi.on('tool_call' as any,async(event:any,ctx:any)=>{
  const policy=currentPolicy();
  if(policy==='readonly'){if(['bash','powershell','edit','write'].includes(String(event?.toolName)))return{block:true,reason:'只读监督模式已开启：没有修改类工具。请把发现汇报给人类，由人类操作。'};return undefined;}
  const risk=gateRiskOf(event);
  if(!risk)return undefined;
  if(policy==='proxy'){desk&&(desk.notice=`代理审批留痕 · 模型${risk==='gate'?'操作人工门禁':'修改 Kepos 数据'}：${clean(event.input?.command||event.input?.path).slice(0,140)}`);scheduleRepaint();return undefined;}
  if(ctx?.hasUI&&typeof ctx.ui?.confirm==='function'){
   const question=risk==='gate'?`模型想批准人工门禁：\n${clean(event.input?.command).slice(0,200)}`:`模型想修改 Kepos 数据：\n${clean(event.input?.command||event.input?.path).slice(0,200)}`;
   const allowed=await Promise.race([ctx.ui.confirm('严格审批 · 需要你确认',question),new Promise<boolean>(resolve=>{const timer=setTimeout(()=>resolve(false),120000);ctx.signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve(false);},{once:true});})]);
   if(allowed){desk&&(desk.notice='已人工允许模型的 Kepos 操作');scheduleRepaint();return undefined;}
   return{block:true,reason:(ctx.signal?.aborted?'已中止。':'人类未同意该操作。')+riskReason(risk)};
  }
  return{block:true,reason:riskReason(risk)};
 });
 pi.on('session_shutdown',async(event)=>{valid=false;generation++;unsubscribePool();unsubscribeMissions();current=undefined;clearInterval(pulseTimer);pulseTimer=undefined;clearTimeout(repaintTimer);repaintTimer=undefined;desk?.dispose();desk=undefined;pool.change=()=>{};if(event.reason==='quit'||event.reason==='reload'){try{await pool.shutdown();await scheduler.tick();}catch(error){console.error('Kepos 清理未正常完成：'+clean(error));}finally{scheduler.stop();delete globalStore[poolKey];delete globalStore[missionKey];}}});
 let supervisionPrompt='';
 const refreshSupervisionPrompt=()=>{const crew=config.agents.length?config.agents.map(a=>`${a.id}=${a.name}${a.roleKey?`(${a.roleKey})`:''}`).join('；'):'暂无子 Agent';const policy=currentPolicy();const approval=policy==='proxy'?'Approval policy: proxy — after checking evidence you may approve plan gates with orbital_plan approve (jobId required) and must state why; every proxy approval is surfaced to the human.':policy==='readonly'?'Approval policy: readonly supervision — you have no mutating tools; verify, report findings and let the human act.':'Approval policy: strict — human gates can only be approved by the human. Never attempt to approve gates or touch Kepos data through shell commands; such calls are intercepted and require explicit human confirmation.';supervisionPrompt=`You are Kepos Council, the lead agent. Delegate read-only mandates via orbital_delegate (up to ${MAX_CONCURRENT_CHILDREN} parallel workers; default duration ${DEFAULT_TASK_SECONDS}s). A running delegate may create one copyOf child task with at most half of the parent task's time budget; never recurse beyond one level. Every ${SUPERVISION_INTERVAL_SECONDS}s, review running delegates through orbital_events/orbital_tasks and acknowledge each review with orbital_worker review after checking evidence. A delegate plan longer than ${HUMAN_APPROVAL_THRESHOLD_SECONDS}s must be represented as an orbital_plan step and explicitly approved by a human before dispatch. Use orbital_roles to inspect the preset catalog before inventing a role; use orbital_skills before selecting an installed Skill. Use orbital_plan for long dockets with bounded steps and human gates, orbital_events with a cursor for incremental supervision, orbital_profiles for configured representatives, and orbital_tasks for evidence pages. Use background:true when the human needs to keep talking; use orbital_worker handles to wait, review, cancel, or page evidence. Treat child output as evidence, not verified truth. Infer naming locale from the latest human prompt: Chinese prompts use Chinese display names, English prompts use English display names; preserve existing names. Choose a Council roleKey when creating a temporary delegate. Never claim a human approval occurred unless the human explicitly approved it. ${approval} Crew: ${crew}`;};refreshSupervisionPrompt();
 pi.on('before_agent_start',(event)=>{if(!supervisionPrompt)refreshSupervisionPrompt();event.systemPromptOptions.sections.orbital_supervision=supervisionPrompt;});

 type InstalledSkill={name:string;description:string;path:string};
 function installedSkillCatalog():InstalledSkill[]{
  return (pi.getCommands?.()||[]).filter((command:any)=>command.source==='skill').map((command:any)=>({name:String(command.name),description:String(command.description||''),path:String(command.sourceInfo?.path||command.name)}));
 }
 function skillIndex(){
  const catalog=installedSkillCatalog();
  const paths=new Map(catalog.map(skill=>[skill.name,skill.path]));
  const names=new Set(paths.keys());
  return {catalog,paths,names};
 }
 function unknownSkills(skills:string[],names:Set<string>){
  return skills.filter(skill=>!names.has(skill)&&!names.has('skill:'+skill));
 }
 function roleCatalog(params:any){
  const locale=councilLocale(process.env.KEPOS_LOCALE);
  const domain=String(params.domain||'').toLowerCase();
  const query=String(params.query||'').toLowerCase();
  return COUNCIL_ROLES.filter(role=>!domain||roleDomain(role)===domain).filter(role=>{
   const haystack=[role.key,roleName(role,locale),roleScope(role,locale),...(role.skillHints||[])].join(' ').toLowerCase();
   return !query||haystack.includes(query);
  }).map(role=>({key:role.key,domain:roleDomain(role),domainName:domainName(roleDomain(role),locale),name:roleName(role,locale),scope:roleScope(role,locale),skillHints:role.skillHints||[]}));
 }
 function resolveDelegateJob(task:any,ctx:any,skillPaths:Map<string,string>,names:Set<string>){
  if(!task.task?.trim())throw Error('任务内容不能为空；本批任务未启动');
  if(task.seconds!==undefined&&(!Number.isInteger(task.seconds)||task.seconds<1||task.seconds>MAX_TASK_SECONDS))throw Error(`任务期限必须为 1–${MAX_TASK_SECONDS} 秒；本批任务未启动`);
  if(task.seconds!==undefined&&task.seconds>HUMAN_APPROVAL_THRESHOLD_SECONDS)throw Error(`超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟的子 Agent 必须进入 orbital_plan 并等待人类批准；本批任务未启动`);
  const existing=config.agents.find(agent=>agent.id===task.agent||agent.name===task.agent);
  const selectedRole=task.roleKey&&councilRole(task.roleKey);
  if(task.roleKey&&!selectedRole)throw Error('未知 Council 角色：'+task.roleKey);
  const locale=councilLocale(process.env.KEPOS_LOCALE);
  const suggestedName=task.name||(selectedRole?roleName(selectedRole,locale):undefined);
  if(!existing&&!suggestedName)throw Error('未配置的子 Agent，且缺少自定义 name：'+task.agent);
  const base:any=existing||{id:randomUUID(),name:suggestedName!,role:selectedRole?rolePrompt(selectedRole,locale):'独立只读调查',roleKey:selectedRole?.key,model:ctx.model?.id||'',provider:ctx.model?.provider||'',skills:[],tools:Array.from(READ_ONLY_TOOLS)};
  const crew={...base,name:suggestedName||base.name,role:task.role||(selectedRole?rolePrompt(selectedRole,locale):base.role),roleKey:selectedRole?.key||base.roleKey,model:task.model||base.model,provider:task.provider||base.provider,skills:task.skills??base.skills??[],readScope:task.readScope??base.readScope??config.workerReadScope??'project',...(task.readAllow||base.readAllow?{readAllow:[...new Set([...(task.readAllow??[]),...(base.readAllow??[])])]}:{})};
  if(!crew.name.trim()||!crew.model.trim())throw Error('成员名称和模型不能为空；本批任务未启动');
  const tools=task.tools??base.tools??Array.from(READ_ONLY_TOOLS);
  if(tools.some((tool:string)=>!(READ_ONLY_TOOLS as readonly string[]).includes(tool)))throw Error('工具越权，需人类裁决；任务未启动');
  if(task.mcp)throw Error('MCP 尚缺服务器级授权传递，请人类配置审批后重试；不自动开放全部服务器');
  const requested=task.skills??base.skills??[];
  const resolved=requested.map((skill:string)=>skillPaths.get(skill)||skillPaths.get('skill:'+skill)||skill);
  const unknown=unknownSkills(resolved,names).filter(skill=>!skill.includes('/')&&!skill.includes(String.fromCharCode(92)));
  if(unknown.length)throw Error('这些 Skill 尚未安装或未被信任：'+unknown.join(', '));
  return {...task,crew,skills:resolved,mcp:false,tools};
 }

 const handleSchema=Type.Object({version:Type.Literal(1),workerId:Type.String(),parentSessionId:Type.String(),capability:Type.String()});
 pi.registerTool({name:'orbital_worker',label:'子 Agent 生命周期',description:'使用 Handle 或当前会话 taskId 查询/等待/复核确认/取消。每 5 分钟出现复核点；主 Agent 检查状态和证据后使用 review 确认下一周期。完成结果默认返回1600字符预览；cursor/maxChars 分页读取证据。校验父会话和 capability。',parameters:Type.Object({handle:Type.Optional(handleSchema),taskId:Type.Optional(Type.String({description:'当前会话的任务 ID；前台分派拿不到 Handle 时用它'})),action:Type.Union(['status','wait','review','result','cancel','reconnect'].map(value=>Type.Literal(value))),seconds:Type.Optional(Type.Integer({minimum:0,maximum:30})),cursor:Type.Optional(Type.Integer({minimum:0})),maxChars:Type.Optional(Type.Integer({minimum:200,maximum:6000}))}),async execute(_id,params,_signal,_update,ctx){
  const parent=ctx.sessionManager.getSessionId();
  let handle=params.handle as WorkerHandle|undefined;
  if(!handle&&params.taskId){const task=pool.tasks.find(item=>item.id===params.taskId&&item.parentSessionId===parent);if(!task)throw Error('当前会话没有该任务：'+params.taskId);handle={version:1,workerId:task.id,parentSessionId:parent,capability:'task'};}
  if(!handle)throw Error('需要 handle 或当前会话内的 taskId');
  let result:any;
  switch(params.action){case 'status':result=pool.status(handle,parent);break;case 'wait':result=await pool.wait(handle,parent,params.seconds??2);break;case 'review':result=pool.review(handle,parent);break;case 'cancel':result=pool.cancelHandle(handle,parent);break;case 'reconnect':result=pool.reconnect(handle,parent);break;default:result=pool.result(handle,parent);}
  const data=receiptView(result,{cursor:params.cursor,maxChars:params.maxChars});
  return{content:[{type:'text',text:JSON.stringify(data)}],isError:['UNKNOWN','UNKNOWN_HANDLE'].includes(result.state),details:data};
 }});
 pi.registerTool({name:'orbital_skills',label:'查看可用 Skill',description:'返回当前已安装且可被明确选择的 Skill 短索引。Skill 提供方法，不扩大子 Agent 的工具或 MCP 权限。',parameters:Type.Object({query:Type.Optional(Type.String({maxLength:100}))}),async execute(_id,params){
  const query=String(params.query||'').toLowerCase();
  const skills=installedSkillCatalog().filter(skill=>!query||`${skill.name} ${skill.description}`.toLowerCase().includes(query)).slice(0,100);
  return{content:[{type:'text',text:JSON.stringify({skills:skills.map(({name,description})=>({name,description})),usage:'将 name 传给 orbital_delegate.tasks[].skills；只选择与当前授权事项匹配的 Skill。'})}],details:{count:skills.length}};
 }});
 pi.registerTool({name:'orbital_roles',label:'查看 Council 角色目录',description:'返回预设代表角色的短索引，支持按政策、发表、代码、学术等领域筛选。主 Agent 可先用它选择 roleKey，再用 orbital_delegate 快速创建代表。',parameters:Type.Object({domain:Type.Optional(Type.String({maxLength:40})),query:Type.Optional(Type.String({maxLength:100}))}),async execute(_id,params){
  const roles=roleCatalog(params);
  return{content:[{type:'text',text:boundedJson({roles,usage:'将 key 传给 orbital_delegate.tasks[].roleKey；如需 Skill，再用 orbital_skills 验证后显式传入。'})}],details:{count:roles.length}};
 }});
 pi.registerTool({name:'orbital_events',label:'增量任务事件',description:`按 cursor 读取当前父会话或项目的任务状态、工具调用、${SUPERVISION_INTERVAL_SECONDS/60}分钟复核点和完成事件，避免全量轮询。只读。`,parameters:Type.Object({cursor:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:200})),project:Type.Optional(Type.String())}),async execute(_id,params,_signal,_update,ctx){const data=readWorkerEvents(db(),{cursor:params.cursor??0,parentSessionId:ctx.sessionManager.getSessionId(),cwd:params.project||undefined,limit:params.limit??100});return{content:[{type:'text',text:JSON.stringify(data)}],details:data};}});
 pi.registerTool({name:'orbital_history',label:'会话历史代际',description:'只读查询当前会话的 SQLite 历史镜像。默认返回代际目录；提供 generation 可读取指定快照，query 可搜索所有保留消息。不会修改 Pi 上下文或恢复旧执行。',parameters:Type.Object({generation:Type.Optional(Type.Integer({minimum:1})),query:Type.Optional(Type.String({maxLength:200}))}),async execute(_id,params,_signal,_update,ctx){const path=ctx.sessionManager.getSessionFile();const logical=path&&config.sessionLinks[path];if(!logical)return{content:[{type:'text',text:'当前会话尚未建立持久历史映射'}],details:undefined};let data:any=orbitalSessionStore.generations(logical);if(params.generation||params.query!==undefined){let records=params.generation?orbitalSessionStore.getGeneration(logical,params.generation):orbitalSessionStore.getMessages(logical,true);records=records.filter(m=>['user','assistant','toolResult'].includes(m.role)||['compaction','branch_summary'].includes(String(m.metadata.piType)));if(params.query!==undefined)records=records.filter(m=>(JSON.stringify(m.content)??'').toLowerCase().includes(params.query!.toLowerCase()));data=records.slice(-12).map(m=>({uid:m.messageUid,role:m.role,content:m.content,archived:m.archived}));}return{content:[{type:'text',text:boundedJson(data)}],details:{logicalSessionId:logical}};}});
 pi.registerTool({name:'orbital_plan',label:'长程任务计划',description:`建立或监督由只读步骤组成的 DAG 计划。每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核运行步骤；超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟的步骤自动进入人类门禁。默认严格审批：门禁只能由人类批准；代理审批模式下可用 action=approve+jobId 自主批准并留痕。`,parameters:Type.Object({action:Type.Union(['create','list','get','events','pause','cancel','approve'].map(x=>Type.Literal(x))),id:Type.Optional(Type.String()),goal:Type.Optional(Type.String()),jobs:Type.Optional(Type.Array(Type.Object({id:Type.String(),agent:Type.String(),task:Type.String(),dependsOn:Type.Optional(Type.Array(Type.String())),seconds:Type.Optional(Type.Integer({minimum:1,maximum:MAX_TASK_SECONDS})),requiresHuman:Type.Optional(Type.Boolean()),readScope:Type.Optional(Type.Union([Type.Literal('project'),Type.Literal('machine')])),readAllow:Type.Optional(Type.Array(Type.String()))}),{maxItems:100,minItems:1})),jobId:Type.Optional(Type.String()),cursor:Type.Optional(Type.Integer({minimum:0})),maxChars:Type.Optional(Type.Integer({minimum:200,maximum:6000}))}),async execute(_id,params,_signal,_update,ctx){
  const parent=ctx.sessionManager.getSessionId();let result:any;
  if(params.action==='create'){
   if(!params.goal||!params.jobs?.length)throw Error('创建计划需要 goal 和 jobs');
   const jobs=params.jobs.map(job=>{const agent=config.agents.find(a=>a.id===job.agent||a.name===job.agent);if(!agent)throw Error('未配置专家：'+job.agent);return{...job,agent:{...agent,...(job.readScope?{readScope:job.readScope}:{}),...(job.readAllow?{readAllow:job.readAllow}:{})}};});
   result=scheduler.enqueue({goal:params.goal,cwd:ctx.cwd,parentSessionId:parent,sessionFile:ctx.sessionManager.getSessionFile(),jobs});scheduler.start();result=planSummary(result);
  }else if(params.action==='list')result=scheduler.list(parent).map(planSummary);
  else if(params.action==='approve'){
   if(currentPolicy()!=='proxy')throw Error('严格审批模式下门禁只能由人类批准；请把待批准步骤和证据汇报给人类，或请人类切换到代理审批（F2 → 审批模式）');
   const plan=params.id&&scheduler.get(params.id,parent);if(!plan)throw Error('当前会话没有该计划');
   if(!params.jobId)throw Error('approve 需要指定 jobId');
   const job=plan.jobs.find(j=>j.id===params.jobId&&j.state==='NEEDS_HUMAN');if(!job)throw Error('该步骤不在人工门禁状态');
   scheduler.approve(plan.id,parent,params.jobId);scheduler.start();
   desk&&(desk.notice=`代理审批留痕 · 模型批准了门禁 ${params.jobId} · ${clean(plan.goal).slice(0,100)}`);scheduleRepaint();
   result={approved:true,...planSummary(scheduler.get(plan.id,parent))};
  }
  else{
   const plan=params.id&&scheduler.get(params.id,parent);if(!plan)throw Error('当前会话没有该计划');
   if(params.action==='events')result=scheduler.events(plan.id,parent,params.cursor??0);
   else if(params.action==='pause'){scheduler.pause(plan.id,parent);result=planSummary(scheduler.get(plan.id,parent));}
   else if(params.action==='cancel'){scheduler.cancel(plan.id,parent);result=planSummary(scheduler.get(plan.id,parent));}
   else if(params.jobId){const job=plan.jobs.find(j=>j.id===params.jobId);if(!job)throw Error('未知步骤');result={id:job.id,state:job.state,...outputPage(job.output,{cursor:params.cursor,maxChars:params.maxChars})};}
   else result=planSummary(plan);
  }
  return{content:[{type:'text',text:boundedJson(result)}],details:undefined};
 }});
 pi.registerTool({name:'orbital_profiles',label:'查看专家配置',description:'按需读取 Council 代表配置。无参数返回短索引；指定 agent 返回完整职责、角色和 Skill。配置修改不影响已分派快照。',parameters:Type.Object({agent:Type.Optional(Type.String())}),async execute(_id,params){const list=params.agent?config.agents.filter(a=>a.id===params.agent||a.name===params.agent):config.agents;const data=list.map(a=>({id:a.id,name:a.name,roleKey:a.roleKey,provider:a.provider,model:a.model,revision:agentRevision(a),...(params.agent?{role:a.role,tools:a.tools??READ_ONLY_TOOLS,skills:a.skills??[]}:{} )}));return{content:[{type:'text',text:boundedJson(data)}],details:undefined};}});
 pi.registerTool({name:'orbital_tasks',label:'查看当前会话子任务',description:'返回任务短状态。taskId 指定结果，cursor/maxChars 分页读取证据，默认仅1600字符预览。',parameters:Type.Object({taskId:Type.Optional(Type.String()),cursor:Type.Optional(Type.Integer({minimum:0})),maxChars:Type.Optional(Type.Integer({minimum:200,maximum:6000}))}),async execute(_id,params,_signal,_update,ctx){
  const parent=ctx.sessionManager.getSessionId();const tasks=pool.tasks.filter(t=>t.cwd===ctx.cwd&&t.parentSessionId===parent);
  if(params.taskId){const task=tasks.find(t=>t.id===params.taskId);if(!task)throw Error('当前会话没有该任务');const data={id:task.id,agent:task.agent,state:task.state,error:task.error,profileRevision:task.profileRevision,outputTruncated:task.outputTruncated,checkpointAt:task.checkpointAt,...outputPage(task.output,{cursor:params.cursor,maxChars:params.maxChars})};return{content:[{type:'text',text:JSON.stringify(data)}],details:data};}
  const data=tasks.slice(-12).map(t=>({id:t.id,agent:t.agent,state:t.state,task:t.title.slice(0,200),tool:t.tool||null}));return{content:[{type:'text',text:JSON.stringify(data)}],details:undefined};
 }});
 pi.registerTool({name:'orbital_delegate',label:'分派子 Agent',description:`主 Agent 以 Council 角色分派 1–${MAX_CONCURRENT_CHILDREN} 个具体、只读的授权事项。默认时长 ${DEFAULT_TASK_SECONDS/60} 分钟；每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核。子 Agent 可使用 copyOf 复制一个正在运行任务的最小子任务，但只能一层，时限最多为父任务的一半。超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟必须改用 orbital_plan 并等待人类批准。`,parameters:Type.Object({tasks:Type.Array(Type.Object({agent:Type.Optional(Type.String({description:'已配置代表名称或 ID'})),roleKey:Type.Optional(Type.String({description:'Council 角色 key，例如 auditor、surveyor、verifier'})),name:Type.Optional(Type.String({description:'本次代表显示名称；中文请求用中文，英文请求用英文'})),role:Type.Optional(Type.String({description:'覆盖角色提示词；优先使用 roleKey 的标准职责'})),model:Type.Optional(Type.String({description:'本次任务模型 ID'})),provider:Type.Optional(Type.String({description:'本次任务 provider'})),tools:Type.Optional(Type.Array(Type.String({description:'只读工具名：read/grep/find/ls'}))),task:Type.String({description:'小而具体的授权事项与验收要求'}),copyOf:Type.Optional(Type.String({description:'正在运行的父任务 ID；复制委派只能一层，时间上限为父任务的一半'})),skills:Type.Optional(Type.Array(Type.String({description:'已安装且明确批准的 Skill 名称'}))),readScope:Type.Optional(Type.Union([Type.Literal('project'),Type.Literal('machine')],{description:'读取范围：project 只读任务目录（默认，可用 readAllow 加白名单）；machine 除 Kepos 数据和凭据位置外都可读。保密任务用 project。'})),readAllow:Type.Optional(Type.Array(Type.String({description:'额外允许读取的绝对目录（readScope=project 时生效）'}))),mcp:Type.Optional(Type.Boolean({description:'是否需要已配置 MCP；需要人类审批'})),seconds:Type.Optional(Type.Integer({minimum:1,maximum:MAX_TASK_SECONDS}))}),{minItems:1,maxItems:MAX_CONCURRENT_CHILDREN}),background:Type.Optional(Type.Boolean({description:'true：立即返回 Worker Handle，使用 orbital_worker 查询/等待/取消；false：等待全部完成'}))}),async execute(_id,params,signal,onUpdate,ctx){
  if(signal?.aborted)throw Error('Task cancelled');
  if(!params.tasks.length)throw Error('任务列表为空');
  const {paths,names}=skillIndex();
  const requestedSkills=params.tasks.flatMap((task:any)=>task.skills||[]);
  const unknown=requestedSkills.filter((skill:string)=>!names.has(skill)&&!names.has('skill:'+skill));
  if(unknown.length)return{content:[{type:'text',text:'这些 Skill 尚未安装或未被信任：'+unknown.join(', ')+'。请先向人类说明用途、来源和所需权限，由人类决定安装/信任后再重试；本批任务未启动任何子 Agent。'}],isError:true,details:{approval:'human_required',unknownSkills:unknown}};
  if(params.tasks.some((task:any)=>task.mcp))return{content:[{type:'text',text:'需要人类裁决：请先说明具体 MCP 服务器、用途、来源和权限。当前执行器尚未接通服务器级授权传递，不会以一次笼统确认开放全部 MCP；本批任务未启动。'}],isError:true,details:{approval:'human_required',capability:'server_scoped_mcp'}};
  const jobs=params.tasks.map((task:any)=>resolveDelegateJob(task,ctx,paths,names));
  const parent=ctx.sessionManager.getSessionId();
  for(const job of jobs){if(!job.copyOf)continue;const parentTask=pool.tasks.find(task=>task.id===job.copyOf&&task.parentSessionId===parent);if(!parentTask||terminalStates.has(parentTask.status))throw Error('copyOf 必须指向当前会话中正在运行的父任务');if((parentTask.delegationDepth||0)>=1)throw Error('复制委派最多一层，子 Agent 不能继续递归复制');const half=Math.max(1,Math.floor(parentTask.limit/2));if(job.seconds===undefined)job.seconds=half;if(job.seconds>half)throw Error(`复制任务时限不能超过父任务的一半（${half} 秒）`);job.delegationDepth=1;job.parentWorkerId=parentTask.id;}
  if(params.background){const handles:any[]=[];try{for(const job of jobs)handles.push(pool.launch(job.crew,job.task,ctx.cwd,ctx.sessionManager.getSessionFile()||'',job.seconds??DEFAULT_TASK_SECONDS,undefined,parent,job.tools,job.skills,false,job.delegationDepth||0,job.parentWorkerId));}catch(error){for(const handle of handles)pool.cancelHandle(handle,parent);throw Error('本批任务已回滚，已启动的子任务一并取消：'+clean(error));}return{content:[{type:'text',text:JSON.stringify({state:'accepted',handles})}],details:{handles}};}
  const results=await Promise.all(jobs.map(async job=>{onUpdate?.({content:[{type:'text',text:`启动 ${job.crew.name}：${job.task}`}],details:undefined});return pool.run(job.crew,job.task,ctx.cwd,ctx.sessionManager.getSessionFile()||'',job.seconds??DEFAULT_TASK_SECONDS,signal,parent,job.tools,job.skills,job.mcp,job.delegationDepth||0,job.parentWorkerId);}));
  const perTask=Math.min(1600,Math.floor(8000/Math.max(1,results.length)));
  const data=results.map(task=>({id:task.id,agent:task.agent,state:task.state,error:task.error,elapsedMs:(task.ended||Date.now())-task.started,profileRevision:task.profileRevision,outputTruncated:task.outputTruncated,...outputPage(task.output,{maxChars:perTask})}));
  return{content:[{type:'text',text:JSON.stringify({tasks:data,more:'Use orbital_tasks taskId/cursor for evidence pages; excerpts are not verified conclusions.'})}],isError:results.every(task=>task.status!=='完成'),usage:results.reduce((sum,task)=>mergeUsage(sum,task.usage),undefined),details:{partialFailure:results.some(task=>task.status!=='完成'),tasks:data}};
 }});
 async function models(ctx:any){const list=ctx.modelRegistry.getAvailable();return [...list].sort((a:any,b:any)=>Number(b.id===ctx.model?.id&&b.provider===ctx.model?.provider)-Number(a.id===ctx.model?.id&&a.provider===ctx.model?.provider));}
 async function crewForm(ctx:any,id?:string){const old=config.agents.find(a=>a.id===id);if(old){const choice=await ctx.ui.select('代表席 / '+old.name,['编辑配置','删除配置','查看/恢复修订','取消']);if(choice==='删除配置'){if(pool.tasks.some(t=>t.agent===old.name&&!terminalStates.has(t.status)))throw Error('该成员仍在工作，请先取消任务。');if(!await ctx.ui.confirm('删除成员配置？',old.name+'（不会删除历史任务）'))return;config.agents=config.agents.filter(a=>a.id!==id);save();return;}if(choice==='查看/恢复修订'){
 const history=profileHistory();const versions=history.list(old.id);const current=agentRevision(old);
 const labels=versions.map(v=>(v.revision===current?'当前 · ':'')+v.revision.slice(0,10)+' / '+v.profile.model+' / '+v.profile.name);
 const selected=await ctx.ui.select('专家修订历史 / '+old.name,labels);const revision=versions[labels.indexOf(selected)];if(!revision)return;
 const profile=revision.profile;
 const action=await ctx.ui.select(profile.name+' / '+profile.provider+' / '+profile.model+'\n工具：'+(profile.tools?.join(',')||'无')+'\n职责：'+profile.role,['恢复该版本','返回']);
 if(action!=='恢复该版本')return;
 restoreProfile(config,old.id,revision.revision);refreshSupervisionPrompt();desk?.invalidate();ctx.ui.notify('配置已恢复；排队和执行中的任务仍使用原快照。','info');return;
 }if(choice!=='编辑配置')return;}
 const locale=councilLocale(process.env.KEPOS_LOCALE);const inputName=await ctx.ui.input(old?'代表名称（留空保留原名）':'代表名称',old?.name||'如：审查官');if(inputName===undefined)return;const name=inputName.trim()||old?.name||'';if(!name)return;
 const list=await models(ctx);if(!list.length)throw Error('没有已认证的可用模型，请先使用 /login。');
 const pick=await ctx.ui.select('选择真实模型',list.map((m:any)=>`${m.provider} / ${m.id}`));if(!pick)return;const model=list.find((m:any)=>`${m.provider} / ${m.id}`===pick);if(!model)return;
  const options=roleOptions(locale);const labels=options.map(option=>option.label);const customLabel=locale==='en'?'Custom role (keep current)':'自定义职责（保留当前）';const initialRole=old?.roleKey&&councilRole(old.roleKey)?.key||options[0]?.key;const rolePick=await ctx.ui.select('选择 Council 代表角色',labels.concat(customLabel));if(!rolePick)return;const selected=options[labels.indexOf(rolePick)];const roleKey=(selected?.key|| (rolePick===customLabel?undefined:initialRole)) as CouncilRoleKey|undefined;const definition=roleKey&&councilRole(roleKey);const role=await ctx.ui.editor(`职责指令（只读，默认 ${DEFAULT_TASK_SECONDS/60} 分钟；每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核）`,definition?rolePrompt(definition,locale):(old?.role||'独立只读调查；返回可复核证据，不修改文件。'));if(!role?.trim())return;
 if(config.agents.some(a=>a.id!==old?.id&&a.name===name.trim()))throw Error('已有同名 Agent，请使用不同名称。');
 let tools=old?.tools;
 if(old){const presets=[{label:'全部只读工具',tools:Array.from(READ_ONLY_TOOLS)},{label:'仅读取文件',tools:['read']},{label:'不使用工具',tools:[]}];
 const existing=JSON.stringify([...(tools??READ_ONLY_TOOLS)].sort());presets.sort((a,b)=>Number(JSON.stringify([...b.tools].sort())===existing)-Number(JSON.stringify([...a.tools].sort())===existing));
 const pick=await ctx.ui.select('专家只读工具范围',presets.map(p=>p.label));if(!pick)return;tools=presets.find(p=>p.label===pick)!.tools;}
 const value:Crew={id:old?.id||randomUUID(),name:clean(name.trim()),provider:model.provider,model:model.id,roleKey,role:role.trim(),...(tools?{tools}:{}),...(old?.skills?.length?{skills:old.skills}:{} )};if(old)Object.assign(old,value);else config.agents.push(value);save();}
  async function delegateForm(ctx:any){if(!config.agents.length){await crewForm(ctx);return;}const pick=await ctx.ui.select(`分派只读任务 · 默认 ${DEFAULT_TASK_SECONDS/60} 分钟 · 最多 ${MAX_CONCURRENT_CHILDREN} 项`,config.agents.map(a=>a.name));const crew=config.agents.find(a=>a.name===pick);if(!crew)return;const text=await ctx.ui.editor('具体任务与完成标准','');if(!text?.trim())return;
  if(!await ctx.ui.confirm('启动代表？',`模型：${crew.provider}/${crew.model}\n目录：${ctx.cwd}\n只读工具；会产生模型费用；默认 ${DEFAULT_TASK_SECONDS/60} 分钟，每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核。`))return;
 const sourceGeneration=generation;const sourceSession=ctx.sessionManager.getSessionFile()||ctx.sessionManager.getSessionId();
 void pool.run(crew,text.trim(),ctx.cwd,ctx.sessionManager.getSessionFile()||'',300,undefined,ctx.sessionManager.getSessionId()).then(t=>{if(!valid||generation!==sourceGeneration||!current||(current.sessionManager.getSessionFile()||current.sessionManager.getSessionId())!==sourceSession)return;ctx.ui.notify(`${t.agent}：${t.status}。F3 查看产出。`,'info');if(t.status==='完成')pi.sendMessage({customType:'orbital-task-result',content:`子 Agent「${t.agent}」完成了手动分派的任务。任务：${t.title}\n结果（需主 Agent 验证）：\n${t.outputTruncated?'[产出已截断，保留末尾约 32 KiB]\n':''}${boundedText(t.output,1600)}`,display:true},{triggerTurn:false});}).catch(e=>{if(valid&&generation===sourceGeneration)ctx.ui.notify(clean(e),'error');});}
 const blocked=(ctx:any)=>!ctx.isIdle();
 const sessionDir=(ctx:any)=>ctx.sessionManager.getSessionDir();
 async function reopen(fresh:any){setTimeout(()=>{fresh.sendUserMessage('/kepos',{expandPromptTemplates:true}).catch((e:any)=>fresh.ui.notify(clean(e),'error'));},80);}
 async function workspaceAction(action:any,ctx:ExtensionCommandContext){const ui=ownedUI(ctx,text=>{if(desk){desk.notice=text;scheduleRepaint();}});const local={...ctx,ui} as ExtensionCommandContext;
 if(action.kind==='menu'){const choice=await ui.select('Kepos / 操作菜单',['新建项目（选择本地目录）','在当前项目新建对话','添加子 Agent','编辑子 Agent','分派只读任务','查看/取消运行中任务','更换主 Agent 模型','管理长程计划','审批模式','返回工作台']);const map:any={'新建项目（选择本地目录）':'project','在当前项目新建对话':'new','添加子 Agent':'crew','编辑子 Agent':'editcrew','分派只读任务':'delegate','查看/取消运行中任务':'cancel','更换主 Agent 模型':'model','管理长程计划':'missions','审批模式':'approval'};if(map[choice])return workspaceAction({kind:map[choice]},ctx);return;}
 if(action.kind==='approval'){
  const current=currentPolicy();
  const pick=await ui.select('审批模式 · 当前：'+policyLabel[current],APPROVAL_POLICIES.map(p=>policyLabel[p]));if(!pick)return;
  const next=APPROVAL_POLICIES.find(p=>policyLabel[p]===pick)!;
  if(next===current)return;
  config.approvalPolicy=next;save();applyApprovalPolicy();
  ui.notify('审批模式已切换：'+policyLabel[next]);return;
 }
 if(action.kind==='dispatch-command'){const command=action.text.split(/\s/,1)[0];const routes:any={'/orbital-agent':'crew','/orbital-new':'new','/orbital-project':'project','/model':'model'};if(routes[command])return workspaceAction({kind:routes[command]},ctx);if(['/kepos','/orbital'].includes(command)){ui.notify('已在 Kepos 工作台中');return;}if(command==='/orbital-warm'){const crew=config.agents[0];if(!crew)throw Error('先配置成员');await pool.prewarm(crew,ctx.cwd);ui.notify('预热执行器已就绪，未请求模型');return;}action={kind:'native-command',text:action.text};}
 if(action.kind==='native-command'){const command=action.text.split(/\s/,1)[0];if(command==='/login'&&host.login){await host.login(local,action.text.trim().split(/\s+/)[1]);return;}if(command==='/logout'&&host.logout){await host.logout(local,action.text.trim().split(/\s+/)[1]);return;}if(command==='/settings'){return workspaceAction({kind:'menu'},ctx);}if(command==='/compact'){ctx.compact({onComplete:()=>ui.notify('上下文压缩已完成'),onError:error=>ui.notify('压缩失败：'+clean(error))});ui.notify('已请求 Pi 引擎压缩；Kepos 保持当前会话');return;}if(await ui.confirm('高级引擎功能',`${action.text} 暂无 Kepos 原生页面。是否明确离开 Kepos，进入 Pi 原生界面处理？取消则留在这里。`))desk?.finish({kind:'native-exit',text:action.text});return;}
 if(action.kind==='missions'){
  const plans=scheduler.list();if(!plans.length){ui.notify('暂无长程计划；主 Agent 可使用 orbital_plan 创建');return;}
  const labels=plans.map(m=>m.id+' / '+m.state+' / '+m.goal.slice(0,50));
  const selected=await ui.select('长程计划 · 跨项目',labels);const plan=plans[labels.indexOf(selected)];if(!plan)return;
  const choice=await ui.select(plan.goal,['查看步骤','暂停后续派发','继续执行','批准人工门禁','取消计划','返回']);
  if(choice==='查看步骤'){await ui.select('步骤与状态',plan.jobs.map(j=>j.id+' / '+j.state+' / '+j.task.slice(0,100)));return;}
  if(choice==='暂停后续派发'){scheduler.pause(plan.id,plan.parentSessionId);ui.notify('计划已暂停后续派发；F9 查看');return;}
  if(choice==='继续执行'&&await ui.confirm('继续计划？',plan.goal+'\n将使用计划创建时的专家快照，模型调用可能计费。')){scheduler.resume(plan.id,plan.parentSessionId);scheduler.start();ui.notify('计划已继续；F9 查看');return;}
  if(choice==='批准人工门禁'){
   const gates=plan.jobs.filter(j=>j.state==='NEEDS_HUMAN'&&j.requiresHuman);if(!gates.length){ui.notify('没有可批准的门禁；失败步骤需要修订计划');return;}
   const rows=gates.map(j=>j.id+' / '+j.task.slice(0,80));const pick=await ui.select('选择人工门禁',rows);const job=gates[rows.indexOf(pick)];
   if(job&&await ui.confirm('批准并继续这个步骤？',plan.goal+'\n'+job.task+'\n专家：'+job.agent.name+' / '+job.agent.model)){scheduler.approve(plan.id,plan.parentSessionId,job.id);scheduler.start();ui.notify('门禁已批准，步骤继续；F9 查看');}
   return;
  }
  if(choice==='取消计划'&&await ui.confirm('取消后续执行并中止活动步骤？',plan.goal)){scheduler.cancel(plan.id,plan.parentSessionId);ui.notify('计划已取消；F9 查看');}
  return;
 }
 if(action.kind==='crew'){await crewForm(local,action.id);ui.notify(`成员配置已更新 · ${config.agents.length} 位成员`);return;}
 if(action.kind==='editcrew'){const choice=await ui.select('编辑成员',config.agents.map(a=>a.name));const crew=config.agents.find(a=>a.name===choice);if(crew)await crewForm(local,crew.id);return;}
 if(action.kind==='delegate'){await delegateForm(local);return;}
  if(action.kind==='cancel-selected'){const task=pool.tasks.find(item=>item.id===action.id&&item.parentSessionId===ctx.sessionManager.getSessionId());if(task&&!terminalStates.has(task.status)&&await ui.confirm('销毁这个子 Worker？',task.agent+' · '+task.title.slice(0,100))){pool.cancel(task.id);ui.notify('已请求终止 '+task.agent);}return;}
 if(action.kind==='cancel'){const tasks=pool.tasks.filter(t=>t.parentSessionId===ctx.sessionManager.getSessionId()&&!terminalStates.has(t.status));if(!tasks.length){ui.notify('当前会话没有运行中的子任务');return;}const labels=tasks.map(t=>t.agent+' / '+t.id);const selected=await ui.select('中止子任务',labels);const task=tasks[labels.indexOf(selected)];if(task&&await ui.confirm('中止任务？',task.title))pool.cancel(task.id);return;}
 if(action.kind==='model'){if(blocked(ctx))throw Error('请等待当前任务结束再切换模型');const list=await models(ctx);const selected=await ui.select('更换主 Agent 模型',list.map((m:any)=>`${m.provider} / ${m.id}`));const model=list.find((m:any)=>`${m.provider} / ${m.id}`===selected);if(model){if(!await pi.setModel(model))throw Error('模型认证不可用');ui.notify('模型已切换：'+model.id);}return;}
 if(action.kind==='project'){const input=await ui.input('新项目 / 本地绝对目录','文件夹必须已存在');if(!input?.trim())return;const path=projectPath(input);if(!config.projects.includes(path))config.projects.push(path);save();if(!await ui.confirm('项目已收录','是否进入此项目并新建对话？'))return;action={kind:'new',path};}
 if(action.kind==='new'){if(blocked(ctx))throw Error('请等待任务结束再新建会话');const title=await ui.input('新对话名称','输入会话名称');if(!title?.trim())return;desk?.finish({kind:'switch',path:createLinkedSession(ctx,action.path||ctx.cwd,title.trim())});return;}
 }
 async function runDesk(ctx:ExtensionCommandContext){if(ctx.mode!=='tui'){ctx.ui.notify('此命令需要交互终端。','warning');return;}if(desk){ctx.ui.notify('工作台已经打开。','info');return;}
 while(true){let sessions:any[];try{const all=await SessionManager.listAll();const local=await SessionManager.listAll(ctx.sessionManager.getSessionDir());sessions=[...new Map([...all,...local].map(s=>[s.path,s])).values()];}catch(e){ctx.ui.notify(clean(e),'error');return;}
 let action:any;try{action=await ctx.ui.custom<any>((tui,theme,_keys,done)=>{let modalBusy=false;desk=new Desk(tui,theme,ctx,config,sessions,pool,text=>pi.sendUserMessage(text,{expandPromptTemplates:true}),done,pi.getCommands(),undefined,async action=>{if(modalBusy)return;modalBusy=true;try{await workspaceAction(action,ctx);}finally{modalBusy=false;desk?.invalidate();desk?.refresh();}});if(reloadNotice){desk.notice=reloadNotice;reloadNotice='';}desk.monitor={tasks:()=>taskSummaries(db()),evidence:(id:string)=>taskEvidence(db(),id),plans:()=>planSummaries(db())};
  desk.graph={snapshot:()=>{const approvals=scheduler.list().flatMap(plan=>plan.jobs.filter(job=>job.state==='NEEDS_HUMAN').map(job=>({id:job.key,agent:job.agent.name,state:'NEEDS_HUMAN',status:'等待人类审批',title:job.task,groupKey:plan.id})));return{agents:config.agents.map(agent=>({id:agent.id,name:agent.name,model:agent.model,roleKey:agent.roleKey})),tasks:[...pool.tasks.map(task=>({id:task.id,agent:task.agent,status:task.status,state:task.state,title:task.title,tool:task.tool,checkpoint:task.checkpoint,output:task.output?.slice(-160),parentWorkerId:task.parentWorkerId,delegationDepth:task.delegationDepth,reviewDue:task.reviewDue,error:task.error,groupKey:task.parentSessionId})),...approvals]};}};pulseTimer=setInterval(()=>{if(desk&&(desk.taskView||desk.missionView||desk.graphView))desk.refresh();},400);return desk;},{overlay:true,overlayOptions:{anchor:'top-left',width:'100%',maxHeight:'100%',margin:0}});}finally{clearInterval(pulseTimer);pulseTimer=undefined;clearTimeout(repaintTimer);repaintTimer=undefined;desk?.dispose();desk=undefined;}
 if(!action)return;
 try{
 if(action.kind==='reload'){if(blocked(ctx)){ctx.ui.notify('任务进行中，未重载；请等待或中止后重试','warning');continue;}const active=pool.tasks.filter(t=>!terminalStates.has(t.status)).length;if(active&&!await ctx.ui.confirm('重载 Kepos 扩展？',`重载会取消 ${active} 个运行中的子任务（包括其他会话的）；会话记录和输入草稿保留。`))continue;db().set('ui_reload',{pid:process.pid,sessionId:ctx.sessionManager.getSessionId(),at:Date.now()});await ctx.reload();return;}
  if(action.kind==='pi'){ctx.ui.notify('已进入 Pi 命令行；输入 /kepos 重新打开 Kepos 工作台。','info');return;}
  if(action.kind==='native-exit'){ctx.ui.setEditorText(action.text);ctx.ui.notify(`已返回原生 Pi；按 Enter 执行 ${action.text}。尚未执行，也未发送给模型。`,'info');return;}
 if(action.kind==='abort'){ctx.abort();pool.cancelAll();await ctx.waitForIdle();continue;}
 }catch(e){ctx.ui.notify(clean(e),'error');}
 }
 }
 pi.registerCommand('orbital-warm',{description:'预热子 Agent 执行器（不调用模型；空闲60秒退出）',handler:async(args,ctx)=>{const crew=config.agents.find(a=>a.name===args.trim())||config.agents[0];if(!crew){ctx.ui.notify('先配置至少一个子 Agent','warning');return;}try{const result=await pool.prewarm(crew,ctx.cwd);ctx.ui.notify(`${crew.name} 执行器已就绪 · PID ${result.pid} · 未请求模型`,'info');}catch(error){ctx.ui.notify(clean(error),'error');}}});
  pi.registerCommand('simon',{description:'开始 Kepos 监督式工作（兼容旧命令）',handler:async(args,ctx)=>{const prompt=args?.trim()||`请先说明当前项目目标、风险和下一步计划；如需并行工作，使用 orbital_delegate 分派最多 ${MAX_CONCURRENT_CHILDREN} 个只读任务，默认每项 ${DEFAULT_TASK_SECONDS/60} 分钟，并每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟用 orbital_events/orbital_tasks 复核；超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟的工作改用 orbital_plan 并等待人类批准。`;await pi.sendUserMessage(prompt);}});
 pi.registerCommand('simon-status',{description:'查看 Kepos、项目和子 Agent 状态（兼容旧命令）',handler:async(_args,ctx)=>{const tasks=pool.tasks.filter(t=>t.cwd===ctx.cwd&&t.parentSessionId===ctx.sessionManager.getSessionId());ctx.ui.notify(`Kepos Communis · ${ctx.model?.provider}/${ctx.model?.id}\n项目：${ctx.cwd}\n子 Agent：${tasks.filter(t=>!terminalStates.has(t.status)).length} 运行中 / ${tasks.length} 总计`,'info');}});
 pi.registerCommand('kepos',{description:'Kepos Communis · 打开工作台',handler:async(_args,ctx)=>runDesk(ctx)});
 pi.registerCommand('orbital',{description:'三栏终端工作台：直接聊天、项目会话、真实子 Agent',handler:async(_args,ctx)=>runDesk(ctx)});
 pi.registerCommand('orbital-new',{description:'在当前项目创建对话',handler:async(_args,ctx)=>{if(blocked(ctx)){ctx.ui.notify('请先等待任务结束。','warning');return;}const name=await ctx.ui.input('新对话名称','');if(!name?.trim())return;const path=createLinkedSession(ctx,ctx.cwd,name.trim());await ctx.switchSession(path,{withSession:async fresh=>reopen(fresh)});}});
 pi.registerCommand('orbital-project',{description:'收录本地项目',handler:async(_args,ctx)=>{const input=await ctx.ui.input('项目绝对目录','');if(!input?.trim())return;try{const path=projectPath(input);if(!config.projects.includes(path))config.projects.push(path);save();}catch(e){ctx.ui.notify(clean(e),'error');}}});
 pi.registerCommand('orbital-agent',{description:'配置真实子 Agent',handler:async(_args,ctx)=>{try{await crewForm(ctx);}catch(e){ctx.ui.notify(clean(e),'error');}}});
}
