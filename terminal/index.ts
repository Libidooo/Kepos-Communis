import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import { Desk, fit, historyLines } from './desk.ts';
import { playSplash } from './splash.ts';
import { loadConfig, saveConfig, createSessionFile, projectPath, clean, root, profileHistory, restoreProfile, importProfiles, exportWorkspaceFiles, type Crew } from './store.ts';
import { keposSessionStore } from './session-store.ts';
import { db } from './database.ts';
import { ownedUI } from './dialogs.ts';
import { boundedJson, boundedText, formatTokens } from './presentation.ts';
import { outputPage, receiptView } from './result-view.ts';
import { agentRevision } from './profiles.ts';
import { summarizeRole } from './profile-file.ts';
import { COUNCIL_ROLES, councilLocale, councilRole, roleName, roleScope, roleOptions, rolePrompt, roleDomain, domainName, type CouncilRoleKey } from './council-roles.ts';
import { MissionScheduler } from './scheduler.ts';
import { taskSummaries, taskEvidence, planSummaries, planTree, agentRisk, awaitingHuman } from './monitor.ts';
import { readRelays } from './relay.ts';
import { configuredMcpServers, resolveMcpGrant } from './mcp.ts';
import { matchLocalSkills, skillsShSearch, resolveSkillOnline, installSkill } from './skill-source.ts';
import { readWorkerEvents } from './events.ts';
import { WorkerPool, configureWorkerDeputy, terminalStates, mergeUsage, spentTokens, DEFAULT_TASK_SECONDS, HUMAN_APPROVAL_THRESHOLD_SECONDS, MAX_CONCURRENT_CHILDREN, MAX_TASK_SECONDS, READ_ONLY_TOOLS, SUPERVISION_INTERVAL_SECONDS, STALL_REVIEW_CYCLES, configureWorkerBudget, type WorkerHandle } from './workers.ts';
import { SpawnRequestPoller } from './spawn-poller.ts';
import { credentialsReady } from './cli-runtime.ts';
import { cliGrantUsable } from './cli-grant.ts';
import { ConsolidationPipeline, candidateFromTask } from './memory-pipeline.ts';
import { renderMemoryIndex } from './memory.ts';
import { postGroupMessage, readGroupMessages, renderGroupChannel } from './group-channel.ts';
import { publishEvidence, readGroupEvidence, renderPeerEvidence, retireGroupIfDone } from './group-evidence.ts';
import { normalizeGroupId, optionalGroupId } from './group-id.ts';
import { ARCHIVE_DIR } from './archive.ts';
import { coordinatorBrief, electionOutcome, tallyElection } from './group-election.ts';
import { ElectionStore, assessCandidate, buildElectionReport, renderElectionReport } from './election-report.ts';
import { SECONDMENT_SECONDS, SecondmentStore, canRequestSecondment, createSecondment, describeSecondmentRequest, effectiveGroups, validateSecondment } from './secondment.ts';
import { checkMandate, EFFORT_GUIDE, OPENING_STEPS } from './mandate.ts';
import { acceptanceReviewPrompt, acceptanceState } from './acceptance.ts';
import { WatchdogStore, parseVerdict, shouldJudge, verdictNotice, watchdogPrompt, type WatchdogJudge } from './watchdog.ts';
import { adoptProposal, discardProposal, listProposals, writeProposal } from './skill-proposal.ts';
import { collectMetrics, formatMetrics } from './kpi.ts';
import { calibrateAll, formatCalibration } from './calibration.ts';
import { DEFAULT_WATCH_RULES, DirectoryWatcher, WatchCandidates, describeCandidate, matchRule, validRules } from './watch.ts';
import { AUTO_DISPATCH_PER_MINUTE, assessmentPrompt, canAutoDispatch, dispatchInstruction, gate, parseAssessment } from './watch-assess.ts';
import { AUTOMATION_LABEL, automationAllowed, automationPrompt, automationSnapshot, confirmText, isActingCapability, toggleAutomation } from './automation.ts';
import { SubordinateApprovals, decideSpawn } from './subordinates.ts';
import { BudgetEscalations, MAX_ESCALATION_DIGEST_CHARS, budgetStopReport, ownerSteerText, redispatchInstruction, shouldEscalate } from './budget-escalation.ts';
import { MAX_STEP_CHARS, describeWorkflow, instantiateWorkflow, newWorkflowId, renderWorkflow, seatsFromAgents, validateWorkflow } from './workflow.ts';
import { DEFAULT_PRECHECK_AGENTS, PRECHECK_ANGLES, PRECHECK_BUDGET_TOKENS, PRECHECK_SECONDS, PrecheckStore, aggregateReproductions, parseReproduction, precheckReport, precheckable, reproduceInstruction, shouldInterrupt } from './precheck.ts';
import { BriefingStore, briefingIssued, premierBriefing, upwardReport } from './briefing.ts';
import { APPROVAL_POLICIES, commandRisk, normalizePolicy, pathRisk, policyLabel, restrictTools, riskReason } from './approval.ts';
import { dataRoot } from './paths.ts';
import { loadAttachment, isAttached, paginateAttachmentText } from './attachments.ts';
import { validateGrantRequest, canDelegate, grantActive, describeForHuman, type GrantRequest } from './grant.ts';
export { fit, historyLines };
/** 存在 cli_grants 里的一条授权记录。 */
type CliGrantRecord={id:string;taskId:string;cli:string;envKey?:string;argPrefixes?:string[];note?:string;grantedAt:number;expiresAt?:number;uses?:number;maxUses?:number};
export interface KeposHost {login?:(ctx:any,provider?:string)=>Promise<void>;logout?:(ctx:any,provider?:string)=>Promise<void>;authStatus?:()=>unknown;}
/**
 * 默认编制席位数。这是**默认值，不是上限**：人类可以改 `config.councilSize`
 * 把它调大或调小，也可以完全不依赖播种、自己逐个添加代表——
 * 席位数量应当由任务流水线决定，不由常量决定。
 */
const DEFAULT_COUNCIL_ROLE_COUNT = 48;
/** 下限：低于一席不成其为议会。 */
const MIN_COUNCIL_SIZE = 1;
/** 上限受 Worker 并发池约束：席位多于槽位只会变成排队。 */
const MAX_COUNCIL_SIZE = MAX_CONCURRENT_CHILDREN;
// 48 席默认种子：覆盖治理、代码、法律合规、文书、学术、政策、工具操作与产品。
//
// 这是**默认配置**，不是固定编制。三条规则：
//   1. 顺序决定初始化时的席位顺序；排序靠前的优先占席。
//   2. 只在首次初始化时播种。之后编制完全属于人类——删席、改数、自建代表都留存。
//   3. 人类可以用 config.councilSize 改席位数，也可以跳过播种自己逐个添加。
//
// 领域配额的取舍：产品与需求澄清排在学术专精之前，因为"从一句模糊目标开始"
// 时最先需要的是把目标问清楚，而不是论文层面的方法论审查。学术角色保留到
// 能覆盖完整写作流程，减少的是细分旁支（revision_coach 等仍可按需从 65 个里补）。
// 代理总代不在编制内：它是人类从现任代表中推选的兼任职责（config.deputyAgentId）。
const COUNCIL_SEED: readonly CouncilRoleKey[] = [
  // 治理与核心（6）
  'strategist', 'mediator', 'archivist', 'scribe', 'cartographer', 'integrity_gatekeeper',
  // 产品与需求（4）——从模糊目标出发时，这一步比任何专精都靠前
  'product_manager', 'requirements_analyst', 'ux_researcher', 'market_researcher',
  // 代码与工程（11）
  'surveyor', 'engineer', 'software_architect', 'code_reviewer', 'test_strategist', 'qa_engineer',
  'security_engineer', 'devops_engineer', 'performance_engineer', 'refactoring_planner',
  'api_contract_analyst',
  // 法律合规（5）
  'legal_counsel', 'contract_reviewer', 'compliance_officer', 'privacy_officer', 'ip_officer',
  // 文书与发表（4）
  'academic_editor', 'publication_readiness_auditor', 'submission_editor', 'policy_brief_editor',
  // 学术研究（7）
  'research_architect', 'literature_strategist', 'source_verifier', 'methodologist',
  'statistical_reviewer', 'devils_advocate', 'reproducibility_auditor',
  // 政策（5）
  'policy_researcher', 'policy_analyst', 'regulatory_monitor', 'impact_assessor', 'stakeholder_mapper',
  // 核验与工具操作（6）
  'auditor', 'verifier', 'sentinel', 'toolsmith', 'data_analyst', 'incident_investigator',
];
export default function kepos(pi: ExtensionAPI, host:KeposHost={}) {
 const config=loadConfig();const poolKey=Symbol.for('kepos.worker-pool:'+root);const globalStore=globalThis as any;const pool:WorkerPool=globalStore[poolKey]||(globalStore[poolKey]=new WorkerPool());let valid=true;let generation=0;let desk:Desk|undefined;let current:any;let busy=false;let pulseTimer:any;let repaintTimer:any;let reloadNotice='';let spawnPoller:SpawnRequestPoller|undefined;let watcher:any;let internalGeneration=0;
 const missionKey=Symbol.for('kepos.mission-scheduler:'+root);
 // Windows console close kills the process without Pi's graceful shutdown (SIGHUP is
 // handled POSIX-only there), so session_shutdown never runs and warm executors would
 // linger until their heartbeat notices. A process-level last-gasp kill covers every
 // exit path; registered once per process so /reload cannot stack handlers.
 const cleanupKey=Symbol.for('kepos.exit-cleanup:'+root);
 if(!globalStore[cleanupKey]){globalStore[cleanupKey]=true;
  const hardExit=()=>{try{globalStore[poolKey]?.hardKill();}catch{}};
  process.on('exit',hardExit);
  if(process.platform==='win32')process.prependListener('SIGHUP',()=>{hardExit();process.exit(0);});
 }
 const scheduler:MissionScheduler=globalStore[missionKey]||(globalStore[missionKey]=new MissionScheduler(db(),pool));
 const planSummary=(m:any)=>({id:m.id,goal:m.goal,state:m.state,cwd:m.cwd,jobs:m.jobs.map((j:any)=>({id:j.id,state:j.state,task:j.task.slice(0,300),agent:j.agent.name,requiresHuman:j.requiresHuman,dependsOn:j.dependsOn||[],checkpoint:j.checkpoint?.slice(0,500),error:j.error,...(j.acceptance?.length?{acceptance:j.acceptance,acceptanceState:acceptanceState(j.acceptance)}:{})}))});
 /**
  * 所有配置改动的唯一出口：存库、刷新提示、重绘。
  *
  * 代表名单真的变化时顺带导出档案文件（C1 要求"配置保存后生成 md"）。
  * 判据是前后快照比较而不是无条件写：草稿保存每 250ms 走同一条路径，
  * 无条件的目录扫描会把打字变成磁盘操作。导出失败不影响保存本身。
  */
 const save=()=>{
  const before=JSON.stringify(config.agents);
  saveConfig(config);
  refreshSupervisionPrompt?.();
  desk?.invalidate();
  if(JSON.stringify(config.agents)===before)return;
  // 目标目录显式给出：导出不能从 process.cwd() 猜，那会把文件写到别人的项目里。
  try{exportWorkspaceFiles(config,current?.cwd||process.cwd());}catch{}
 };
 const currentPolicy=()=>normalizePolicy(config.approvalPolicy);
 // 每个代表任务默认 200 万 token 预算（未显式配置时）。预算是"单个任务"的额度，
 // 每开一个新任务 / 新对话都从 0 重新计算——不存在跨任务累计。
 const DEFAULT_TASK_TOKEN_BUDGET = 2_000_000;
 configureWorkerBudget(()=>({perTaskTokens:DEFAULT_TASK_TOKEN_BUDGET,...(config.budget||{})}));
 // 在任代理总代由配置决定；代表进程靠这个标记决定是否注册跨组借调工具。
 configureWorkerDeputy(()=>config.deputyAgentId);
 /**
 * 一次最小生成：记忆整理、watchdog 判定、语义评估共用。
 *
 * 这三条链路此前调用 `current.generateCompletion`，而那个方法在 SDK 里并不存在。
 * 可选链让它安静地返回 undefined，后续解析拿到空字符串再返回空数组——
 * 于是三条链路在真实运行时全部无事发生，测试却因为注入了桩而全绿。
 * 真实数据库里 representative_memories / watchdog_verdicts 长期 0 行就是这个原因。
 *
 * 现在走唯一真实可用的路径：派一个极小的只读任务。代价是每次都要起一个 worker，
 * 所以调用方必须真的需要结果才调它。
 */
 const minimalCompletion=async(prompt:string,options:{budgetTokens?:number}={}):Promise<string>=>{
  const crew=config.agents[0];
  if(!crew?.model)throw Error('没有可用的代表配置，无法执行内部生成');
  // 内部生成自己会产生 task_finished 事件，那条事件又会触发记忆整理——
  // 而记忆整理再调本函数。没有这道闸，一条任务能繁殖出无限条内部任务。
  if(internalGeneration>0)throw Error('内部生成正在进行，跳过以避免递归');
  const session=current?.sessionManager?.getSessionFile?.()||'';
  const parent=current?.sessionManager?.getSessionId?.()||'';
  const cwd=current?.cwd||process.cwd();
  if(!parent)throw Error('没有活跃会话，无法执行内部生成');
  internalGeneration++;
  try{
   // purpose=configuration：内部生成不是委派，审计时要能与真正派给代表的工作区分。
   // 预算给足：生成器要读工作区与角色文档，几千 token 必截停，截停一轮就白跑。
   const task=await pool.run(crew,prompt,cwd,session,60,undefined,parent,['read'],[],false,0,undefined,options.budgetTokens??50_000,{purpose:'configuration'});
   return String(task.output||'');
  }finally{internalGeneration--;}
 };
 // 记忆整理管道：整理只是一次短摘要。
 const memoryPipeline=new ConsolidationPipeline(db(),minimalCompletion,
  message=>{if(desk){desk.notice='记忆整理：'+message;scheduleRepaint();}});
 /**
  * 记忆 → 技能：整理后检查该代表是否有够格的过程记忆（同一 slug 来自 ≥3 个不同任务）。
  * 只写提议，不装进 skills/——一份 SKILL.md 会改变后续每次分派的提示词，采纳必须是人。
  */
 const skillAgentDir=()=>process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent');
 const proposeSkills=(agentId:string)=>{
  try{
   const member=config.agents.find(agent=>agent.id===agentId);
   if(!member)return;
   for(const candidate of memoryPipeline.skillCandidates(agentId)){
    // 已有同名提议就跳过：重复写只会反复覆盖同一份文件，提示一次就够。
    const existing=listProposals(skillAgentDir()).find(item=>item.slug===candidate.slug);
    if(existing)continue;
    writeProposal(skillAgentDir(),{slug:candidate.slug,description:candidate.steps[0]?.slice(0,120)||candidate.slug,steps:candidate.steps,agent:member.name});
    const total=listProposals(skillAgentDir()).length;
    if(desk){desk.notice=`${member.name} 的过程已重复到可固化为技能：${candidate.slug} · 共 ${total} 条提议技能待审阅（F2 → 审阅提议技能）`;scheduleRepaint();}
   }
  }catch{/* 提议失败不影响记忆本身 */}
 };
 // Watchdog 判定器：与记忆整理共用同一次最小生成，不额外开进程。
 // 阶段① 只落库 + 一行提示；progress 静默，绝不终止任务。
 const watchdogStore=new WatchdogStore(db());
 // 人类在执行途中改变需求的记录：界面显示"已加急"必须有对应的真实送达。
 const briefingStore=new BriefingStore(db());
 // 事件驱动值守的候选表：观察期只记录，不执行。
 const watchCandidates=new WatchCandidates(db());
 // 静默预检的判定记录：同一条报告只跑一次三席并行。
 const precheckStore=new PrecheckStore(db());
 // 组内推举的呈报：组内推举只是提名，批准由人类做。
 const electionStore=new ElectionStore(db());
 // 跨组临时借调：代理总代发起、总理批准、到期自动收回。
 const secondmentStore=new SecondmentStore(db());
 /**
  * 静默预检：一条 bug 报告进来，先派几名代表从不同角度试着复现。
  * 只有真的复现出来才打扰人——这是 M3 的全部意义。
  *
  * 为什么值得：报告里大多数是"复现不了"或"描述不够"，
  * 让人自己分辨这些会把注意力耗在分诊上。而并行复现正是 Kepos 的结构优势：
  * 单 Worker 只能串行试三个角度，代价高到不值得为此静默。
  */
 const runPrecheck=async(report:string,ctx:any)=>{
  // 能力判定只有一处：开关 + 档位（+ 派发的前置观察）。这里只问"能不能用"，
  // 不自己判断档位——那样两处判定迟早不一致。
  const permission=automationAllowed(currentPolicy(),config.automation,'precheck');
  if(!permission.allowed)throw Error(permission.reason);
  const usable=precheckable(report);
  if(!usable.ok){if(desk)desk.notice=`未预检：${usable.reason}`;return;}
  const previous=precheckStore.find(report);
  if(previous){if(desk)desk.notice=`这条报告已预检过（${previous.verdict}）：${previous.summary}`;return;}
  // 代表选择：优先配置指定的，否则按角度顺序取已配置的前几个。
  const wanted=config.automation?.precheckAgents?.length
   ?config.automation.precheckAgents.map(name=>config.agents.find(agent=>agent.name===name||agent.id===name)).filter(Boolean)
   :config.agents.slice(0,DEFAULT_PRECHECK_AGENTS);
  if(!wanted.length){if(desk)desk.notice='未预检：没有可用的代表';return;}
  if(desk)desk.notice=`静默预检中：${wanted.length} 名代表并行尝试复现…`;scheduleRepaint();
  const parent=ctx.sessionManager.getSessionId();
  const sessionFile=ctx.sessionManager.getSessionFile()||'';
  // 并行派发：每个角度一个只读任务，预算与时限都压得很低——
  // 预检本身必须便宜，否则它比 bug 还贵。
  const attempts=await Promise.all(wanted.map(async(crew:any,index:number)=>{
   const angle=PRECHECK_ANGLES[index%PRECHECK_ANGLES.length];
   try{
    const task=await pool.run(crew,reproduceInstruction({report,angle:angle.angle,index}),ctx.cwd,sessionFile,PRECHECK_SECONDS,undefined,parent,['read'],[],false,0,undefined,PRECHECK_BUDGET_TOKENS,{purpose:'watch'});
    return parseReproduction(crew.name,String(task.output||''));
   }catch(error){
    // 一位代表失败不该让整次预检作废：记成 unclear，其余角度仍有意义。
    return {agent:crew.name,state:'unclear' as const,evidence:'',reason:'预检任务失败：'+clean(error)};
   }
  }));
  const result=aggregateReproductions(attempts);
  precheckStore.record({report,result,attempts:attempts.length});
  const outcome={result,attempts};
  // 只有 reproduced 走紧急通道。refuted 与 inconclusive 用普通通知：
  // 它们要的是"回复报告者"，不是"打断现在的你"。
  if(shouldInterrupt(result)){
   if(process.stdout.isTTY)process.stdout.write('\x07');
   desk?.urgent(`预检确认可复现 · ${result.summary}`);
  }else if(desk)desk.notice=`预检：${result.summary}`;
  // 完整记录交给总理——它是这条报告的处置人。
  void pi.sendUserMessage(precheckReport({report,result,attempts}),{deliverAs:'steer'});
  scheduleRepaint();
  return outcome;
 };
 // ── 代表改道后的两段式上报 ─────────────────────────────────────────────
 // 上级判定只有这一处：有代理总代就是总代，否则是总理。
 const superiorOf=():{name:string;role:'deputy'|'premier'}=>{
  const deputy=config.agents.find(agent=>agent.id===config.deputyAgentId);
  return deputy?{name:deputy.name,role:'deputy'}:{name:'总理',role:'premier'};
 };
 // 待补的收尾结论：变更下达时记一笔，任务结算时补报。
 const pendingUpward=new Map<string,{agent:string;briefing:string;superior:{name:string;role:'deputy'|'premier'}}>();
 /** 把一段汇报交给上级：总代没有自己的会话，只能通过执行任务"听到"。 */
 const deliverUpward=(report:string,superior:{name:string;role:'deputy'|'premier'},prefix:string)=>{
  try{
   if(superior.role==='deputy'){
    const deputy=config.agents.find(agent=>agent.id===config.deputyAgentId);
    const instruction=`你是代理总代「${superior.name}」。${report}\n\n请用两三句话给出处置意见（是否同意改道、原计划哪一步需要调整），然后转呈总理。不要自行派发新任务。`;
    if(deputy){const session=current?.sessionManager?.getSessionFile?.()||'';const parent=current?.sessionManager?.getSessionId?.()||'';if(parent)pool.launch({...deputy},instruction,current.cwd,session,140,undefined,parent,['read'],[],false);}
    if(desk){desk.notice=`${prefix}代理总代「${superior.name}」转呈`;scheduleRepaint();}
   }else{
    void pi.sendUserMessage(report,{deliverAs:'steer'});
    if(desk){desk.notice=`${prefix}总理`;scheduleRepaint();}
   }
  }catch(error){desk&&(desk.notice='改道汇报失败：'+clean(error));}
 };
 /** 任务结算时补报改道代表的真实结论。他人任务不受影响。 */
 const flushUpward=(task:any)=>{
  const pending=pendingUpward.get(String(task?.id));
  if(!pending)return;
  pendingUpward.delete(String(task.id));
  deliverUpward(upwardReport({agent:pending.agent,taskId:String(task.id),briefing:pending.briefing,conclusion:String(task.output||task.checkpoint||'')}),pending.superior,`${pending.agent} 改道结论 · 已报`);
 };
 // 预算截停的立案与回传（人类的裁定：截停回传上级，最终总理呈报、人类审批；僚属同链）。
 // 截停曾经只留一行警告：总理不知道委派已死，"待处理"恒为零，等待区的"F2 调预算重派"
 // 没有实现。现在系统先立案（不依赖模型行为），再沿链上报——批准权始终在人类手里。
 const escalateBudgetStop=(task:any)=>{
  try{
   if(!shouldEscalate(task))return;
   const spent=spentTokens(task.usage);
   const cap=Number(task.budgetTokens)||2_000_000;
   const digest=String(task.checkpoint||'').slice(0,MAX_ESCALATION_DIGEST_CHARS);
   const escalationId=new BudgetEscalations(db()).raise({taskId:String(task.id),parentSessionId:String(task.parentSessionId||''),agent:String(task.agent),agentId:task.agentId?String(task.agentId):undefined,task:String(task.title||''),spent,cap,digest});
   // 僚属：直属代表对僚属全权负责，先让它知道并给评估；是否重派由人类审批决定。
   let ownerName:string|undefined;
   if(task.parentWorkerId){
    const owner=pool.tasks.find(t=>t.id===task.parentWorkerId);
    const handle=owner&&!terminalStates.has(owner.status||'')?pool.liveHandle(String(task.parentWorkerId),String(task.parentSessionId||'')):undefined;
    if(handle){void pool.sendMessage(handle,String(task.parentSessionId||''),ownerSteerText({agent:String(task.agent),taskId:String(task.id),spent,cap}));ownerName=String(owner.agent);}
   }
   // 呈报总理：它掌握全局目标，可用 kepos_budget 附额度评估；批准权在人类。
   void pi.sendUserMessage(budgetStopReport({escalationId,agent:String(task.agent),taskId:String(task.id),spent,cap,title:String(task.title||''),digest:digest.slice(0,300),owner:ownerName}),{deliverAs:'steer'});
   // 铃声在后台段响：人关着书案也该被叫醒（同门禁铃声的考量）。
   if(process.stdout.isTTY)process.stdout.write('\x07');
   if(desk){desk.notice=`预算截停已立案 · ${task.agent} · 审批即将弹出`;scheduleRepaint();queueBudgetApproval(escalationId);}
  }catch{/* 立案失败不影响截停本身：任务已停，证据在归档里 */}
 };
 // ── 预算审批的前置通道 ──
 // 审批不该藏在 F2 五层菜单后面：立案或总理附议一到，直接把审批对话推到最前。
 // 一键批准（总理建议或 50k 兜底）/ 自定义额度 / 拒绝；按"稍后"就记账不再打扰，
 // F2 队列永远完整可用。同刻多案按队列逐案弹，一案一点。
 const budgetApprovalSeen=new Set<string>();
 let budgetDialogBusy=false;
 async function runBudgetApprovals(ctx:any,fromAuto:boolean):Promise<void>{
  if(!ctx||ctx.mode!=='tui'||budgetDialogBusy)return;
  budgetDialogBusy=true;
  try{
   const ui=ownedUI(ctx,text=>{if(desk){desk.notice=text;scheduleRepaint();}});
   for(;;){
    const pending=new BudgetEscalations(db()).pending();
    if(!pending.length){if(!fromAuto)ui.notify('没有待审批的预算追加。','info');return;}
    // 自动通道只弹没被搁下过的立案；F2 通道从队首开始全部列出。
    const item=fromAuto?pending.find(entry=>!budgetApprovalSeen.has(entry.id)):pending[0];
    if(!item)return;
    const result=await budgetApprovalDialog(ui,ctx,item);
    if(result==='skipped'){
     if(fromAuto){for(const entry of pending)budgetApprovalSeen.add(entry.id);if(desk){desk.notice='预算审批已搁置 · F2 → 预算追加审批 随时可处理';scheduleRepaint();}}
     return;
    }
   }
  }finally{budgetDialogBusy=false;}
 }
 /** 一案一屏：批准（建议额度）/ 自定义额度 / 拒绝 / 稍后。返回是否了结了此案。 */
 async function budgetApprovalDialog(ui:any,ctx:any,item:any):Promise<'decided'|'skipped'>{
  // 兜底从宽：总理没附议时按已耗两倍且不低于 5 万预填——几千 token 的"建议"只够再截停一次。
  const suggestion=item.proposal??Math.max(50_000,Math.ceil(item.spent*2/1000)*1000);
  const proposalLine=item.proposal
   ?`\n总理建议：${formatTokens(item.proposal)} tokens${item.note?`（${clean(item.note).slice(0,120)}）`:''}`
   :'\n（总理尚未附评估 · 预填为已耗两倍且不低于 50k）';
  const approve=`批准 · ${formatTokens(suggestion)} tokens 续接重派`;
  const decision=await ui.select(`预算追加 · ${item.agent}\n已耗 ${formatTokens(item.spent)} / 上限 ${formatTokens(item.cap)} tokens\n原任务：${clean(item.task).slice(0,120)}${proposalLine}`,[approve,'批准 · 自定义额度','拒绝（保持截停）','稍后再说（F2 → 预算追加审批）']);
  if(!decision||decision.startsWith('稍后'))return 'skipped';
  if(decision==='拒绝（保持截停）'){new BudgetEscalations(db()).decide(item.id,false);ui.notify(`已拒绝 ${item.agent} 的预算追加；任务保持截停。`,'info');return 'decided';}
  let newCap=suggestion;
  if(decision==='批准 · 自定义额度'){
   const input=await ui.input('新额度（tokens，不少于 1000）',String(suggestion));
   if(input===undefined||!input.trim())return 'skipped';
   newCap=Number(input.trim());
   if(!Number.isInteger(newCap)||newCap<1000){ui.notify('额度必须是不少于 1000 的整数','warning');return 'skipped';}
  }
  // 原任务全文与父链从 workers 表读回：立案里只存了截断版。
  let parsed:any;try{const row=db().prepare('SELECT task FROM workers WHERE id=?').get(item.taskId) as any;parsed=row?.task?JSON.parse(row.task):undefined;}catch{/* 记录缺失就退回立案里的截断版 */}
  const originalTitle=String(parsed?.title||item.task||'');
  const crew=config.agents.find(agent=>agent.id===item.agentId)||config.agents.find(agent=>agent.name===item.agent);
  if(!crew){new BudgetEscalations(db()).decide(item.id,false);ui.notify(`代表「${item.agent}」已不存在，无法重派；本案已驳回。`,'warning');return 'decided';}
  // 原直属代表还在跑就挂回它名下（delegationDepth=1），责任链不断；否则作直派任务。
  const owner=parsed?.parentWorkerId?pool.tasks.find(t=>t.id===String(parsed.parentWorkerId)&&!terminalStates.has(t.status||'')):undefined;
  const instruction=redispatchInstruction({taskId:item.taskId,agent:item.agent,spent:item.spent,cap:item.cap,newCap,title:originalTitle,digest:item.digest??(parsed?.checkpoint?String(parsed.checkpoint).slice(0,MAX_ESCALATION_DIGEST_CHARS):undefined)});
  try{
   pool.launch({...crew},instruction,ctx.cwd,ctx.sessionManager.getSessionFile()||'',DEFAULT_TASK_SECONDS,undefined,ctx.sessionManager.getSessionId(),Array.from(READ_ONLY_TOOLS),crew.skills??[],false,owner?1:0,owner?.id,newCap,{purpose:'delegation'});
  }catch(error){ui.notify('重派失败：'+clean(error)+'；本案仍在队列，可重试或拒绝','warning');return 'skipped';}
  // 先 launch 后记账：launch 失败时案件还在队列里，人类的批准不会蒸发。
  const escalations=new BudgetEscalations(db());
  escalations.decide(item.id,true);
  escalations.markDispatched(item.id);
  ui.notify(`已按 ${formatTokens(newCap)} tokens 重派 ${item.agent}${owner?`（挂回「${owner.agent}」名下）`:''}`,'info');
  return 'decided';
 }
 /** 新立案（或总理附议）自动弹审批：只弹没被搁下过的；搁下过的等 F2。 */
 function queueBudgetApproval(id:string){
  if(budgetApprovalSeen.has(id))return;
  setTimeout(()=>{void runBudgetApprovals(current,true);},150);
 }
 const watchdogJudge:WatchdogJudge=minimalCompletion;
 /** 对一次"到复核点"的任务做一次模型判定。失败静默——watchdog 不能影响任务本身。 */
 const judgeReview=async(task:any)=>{
  try{
   // 证据只取上次判定之后的事件：重复判同一段没有意义，也白花钱。
   const before=watchdogStore.state(task.id);
   const page=readWorkerEvents(db(),{cursor:before.cursor,parentSessionId:task.parentSessionId,limit:200});
   const mine=page.events.filter(event=>event.workerId===task.id);
   const cursor=mine.length?mine[mine.length-1].seq:page.nextCursor;
   if(!shouldJudge({eventCount:mine.length,cursor,lastCursor:before.cursor,outputTail:String(task.output||'')}))return;
   const raw=await watchdogJudge(watchdogPrompt({
    workerId:task.id,cursor:before.cursor,goal:String(task.title||''),
    events:mine.map(event=>({type:event.type,tool:typeof event.payload.tool==='string'?event.payload.tool:undefined,checkpoint:typeof event.payload.checkpoint==='string'?event.payload.checkpoint:undefined,at:event.created})),
    outputTail:String(task.output||''),elapsedMs:Date.now()-(task.started||Date.now()),
   }));
   const {verdict,reason}=parseVerdict(raw);
   const record=watchdogStore.record({workerId:task.id,verdict,reason,evidenceCursor:cursor,model:config.watchdogModel?.model||current?.model?.id||'principal'});
   const notice=verdictNotice(record);
   // 阶段① observe：只提示，不进 urgent，不触发任何终止。
   if(notice&&desk){desk.notice=`${task.agent} ${notice}`;scheduleRepaint();}
  }catch{/* 判定失败不影响任务；下一次复核会再试 */}
 };
 let baselineTools:string[]=[];
 const applyApprovalPolicy=()=>{if(!baselineTools.length)return;try{pi.setActiveTools(currentPolicy()==='readonly'?restrictTools(baselineTools):baselineTools);}catch(error){desk&&(desk.notice='审批模式切换失败：'+clean(error));scheduleRepaint();}};
 function initializeCrew(ctx:any){
  if(ctx.mode!=='tui'||!ctx.model?.id||ctx.model.id==='unknown')return;
  // 播种只在**从没初始化过**时发生：席位是默认配置，不是每次启动都要凑齐的名单。
  // 一旦初始化过，编制就是人类的东西——他删掉一席、改成 5 席、或者自己造 30 席，
  // 下次启动都不该被"补回来"。这条规则是"用户创造的配置会留存"的实现前提。
  if(config.initialized){return;}
  const locale=councilLocale(process.env.KEPOS_LOCALE);
  const existingKeys=new Set(config.agents.map(agent=>agent.roleKey).filter((key):key is CouncilRoleKey=>!!key));
  const existingNames=new Set(config.agents.map(agent=>agent.name));
  // 席位数量可配置：默认 48，人类可以调成任意值。已有代表永远先占名额。
  const target=Math.max(MIN_COUNCIL_SIZE,Math.min(MAX_COUNCIL_SIZE,Math.floor(config.councilSize??DEFAULT_COUNCIL_ROLE_COUNT)));
  const seedOrder=COUNCIL_SEED.map(key=>councilRole(key)).filter((role):role is NonNullable<typeof role>=>!!role);
  for(const role of [...seedOrder,...COUNCIL_ROLES.filter(role=>!COUNCIL_SEED.includes(role.key))]){
   if(config.agents.length>=target)break;
   if(existingKeys.has(role.key))continue;
   const name=roleName(role,locale);if(existingNames.has(name))continue;
   config.agents.push({id:randomUUID(),name,roleKey:role.key,role:rolePrompt(role,locale),model:ctx.model.id,provider:ctx.model.provider});
   existingKeys.add(role.key);existingNames.add(name);
  }
  config.initialized=true;save();
 }
 const createLinkedSession=(ctx:any,cwd:string,title:string)=>{const piPath=createSessionFile(cwd,title,sessionDir(ctx));const logical=keposSessionStore.createSession({cwd,title,piSessionFile:piPath});config.sessionLinks[piPath]=logical.logicalSessionId;save();return piPath;};
 const repaint=()=>desk?.refresh();const scheduleRepaint=()=>{if(repaintTimer)return;repaintTimer=setTimeout(()=>{repaintTimer=undefined;repaint();},75);};pool.change=scheduleRepaint;
 let unsubscribePool:()=>void=()=>{};let unsubscribeMissions:()=>void=()=>{};
 const bindPool=()=>{unsubscribePool();unsubscribeMissions();unsubscribeMissions=scheduler.subscribe(event=>{
  // 门禁提醒的铃声不依赖界面：计划在后台进入待审批时，人该被叫醒。
  if(event.state==='NEEDS_HUMAN'&&process.stdout.isTTY)process.stdout.write('\x07');
  if(!desk)return;
  if(['NEEDS_HUMAN','SUCCEEDED','FAILED'].includes(event.state)){const text=`${event.state==='NEEDS_HUMAN'?'需要人类处理':'计划状态更新'}：${event.goal} · ${event.cwd} · F9查看`;if(event.state==='NEEDS_HUMAN')desk.urgent(text);else desk.notice=text;desk.refresh();}});unsubscribePool=pool.subscribe(event=>{
  // ── 后台记账：不依赖界面是否打开 ──────────────────────────────────────
  // 书案关掉后任务仍在跑。这三件事都是关于任务的事实，不是界面装饰：
  // 改道结论的补报、记忆整理、watchdog 判定。放在 `if(!desk)` 之后，
  // 等于"人一关面板，代表的经验就不再沉淀、上级也收不到结论"。
  if(event.type==='task_review_due')void judgeReview(event.task);
  if(event.type==='task_finished'){
   flushUpward(event.task);
   // 同组证据：任务结束时把它产出里"## 结论"之前的部分写进组内可见目录。
   // 结论不写入——切分在源头完成，读取方就无从读到别人的判断。
   if(event.task.groupId){
    const archiveRoot=join(event.task.cwd||'',ARCHIVE_DIR);
    try{
     publishEvidence({archiveRoot,groupId:event.task.groupId,task:event.task as any});
     // 组收尾：组内最后一个任务结算后清掉证据目录。
     // 必须等全部结束——还有同伴在跑时删掉，它会突然读不到刚发布的进展。
     // 经验不在这里：记忆按代表存库、技能按 slug 存盘、工作流存结构，都不受影响。
     const live=pool.tasks.filter(task=>task.groupId===event.task.groupId&&!terminalStates.has(task.status||'')).length;
     if(retireGroupIfDone({archiveRoot,groupId:event.task.groupId,liveTasks:live})&&desk){
      desk.notice=`组 ${event.task.groupId} 已收尾 · 证据已清理（经验留在代表记忆与技能提议里）`;
      scheduleRepaint();
     }
    }catch{}
   }
   const candidate=candidateFromTask(event.task as any);
   if(candidate&&memoryPipeline.enqueue(candidate)){void memoryPipeline.drain().then(()=>{if(event.task.agentId)proposeSkills(event.task.agentId);}).catch(()=>{});}
  }
  // 预算截停的立案与回传必须在后台段：人关着书案时，总理照样该收到呈报。
  if(event.type==='task_budget_stop')escalateBudgetStop(event.task);
  if(!desk)return;
  if(event.type!=='task_progress')desk.invalidate();
  if(event.task.cwd===desk.ctx.cwd&&event.task.parentSessionId===desk.ctx.sessionManager.getSessionId()){
   // 失败类终态与要求人类介入的事件必须"听得见"：此前失败只留一条 4 秒 notice，
   // 委派秒败时用户毫无感知（报错无阻拦）。错误原因带进 notice，不用翻任务详情。
   const failed=event.type==='task_finished'&&['失败','超时','已中断'].includes(event.task.status||'');
   // 预算截停的铃声已在后台立案段响过一次；这里只负责把粘性提示指向审批入口。
   const budgetStop=event.type==='task_budget_stop';
   const urgent=failed||event.type==='task_stalled';
   if(urgent&&process.stdout.isTTY)process.stdout.write('\x07');
   // 僚属失败时把责任归到直属代表：代表对该僚属全权负责，必须由它去修或重派。
   // 主环不显示僚属，所以这条通知是发现问题的唯一入口，必须写明"谁该负责"。
   const parentTask=event.task.parentWorkerId?pool.tasks.find(t=>t.id===event.task.parentWorkerId):undefined;
   const blame=parentTask?` · 由代表「${parentTask.agent}」负责修复或重派`:' · F3 看完整产出';
   // 失败 / 空转 / 预算停止走粘性 urgent：不会被下一条普通进度消息顶掉。
   const text=event.type==='task_finished'
    ?(failed?`✕ ${parentTask?'僚属':'僚属'} ${event.task.agent} ${event.task.status}：${clean(event.task.error||'无错误信息').slice(0,140)}${blame}`:`${parentTask?'僚属':'僚属'} ${event.task.agent}：${event.task.status}`)
    :event.type==='task_review_due'?`僚属 ${event.task.agent} 到达 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核点 · 请主 Agent 检查`
    :event.type==='task_stalled'?`⚠ ${parentTask?'僚属':'僚属'} ${event.task.agent} 疑似空转，已要求复核；是否终止由你决定`
    :budgetStop?`⚠ 任务 ${event.task.agent} 到达预算上限，已停止消耗 · 已立案呈报总理，待你审批（F2 → 预算追加审批）`:'';
   if(text){if(urgent||budgetStop)desk.urgent(text);else desk.notice=text;}
  }
  scheduleRepaint();
 });};bindPool();
 // Pi rewrites the window title from its own constant ("π - <session>") on every session
 // change, so a one-shot setTitle is not enough: take over the OSC 0 sequence itself.
 let titleHooked=false;
 function ownTerminalTitle(title:string){
  if(titleHooked||process.env.KEPOS_APP!=='1')return;
  titleHooked=true;
  const ESC=String.fromCharCode(27), BEL=String.fromCharCode(7);
  const OSC=ESC+']0;';
  const write=(process.stdout.write as any).bind(process.stdout);
  // Pi rewrites the title from its own constant on every session change, so intercept the
  // OSC 0 payload itself. Scanned by hand: a regex here kept mangling the control chars.
  const retitle=(text:string):string=>{
   let out='', from=0;
   for(;;){
    const at=text.indexOf(OSC,from);
    if(at<0)return out+text.slice(from);
    const bel=text.indexOf(BEL,at+OSC.length);
    if(bel<0)return out+text.slice(from);
    out+=text.slice(from,at)+OSC+title+BEL;
    from=bel+1;
   }
  };
  (process.stdout as any).write=(chunk:any,...rest:any[])=>{
   if(typeof chunk==='string'&&chunk.indexOf(OSC)>=0)chunk=retitle(chunk);
   return write(chunk,...rest);
  };
 }
 function install(ctx:any){current=ctx;if(ctx.mode!=='tui'||process.env.KEPOS_APP!=='1')return;
 ownTerminalTitle('Kepos Communis');ctx.ui.setHeader((_tui:any,theme:any)=>({invalidate(){},render(width:number){const title='  Kepos Communis';const line=(s:string,color:any)=>theme.fg(color,fit(s,width));return [line(title,'accent')];}}));
 ctx.ui.setWidget('kepos-model',(_tui:any,theme:any)=>({invalidate(){},render(width:number){const live=busy?'accent':current?.model?'success':'warning';const model=current?.model;const label=model?.id&&model.id!=='unknown'?`${model.provider?clean(model.provider)+'/':''}${clean(model.id)}`:'请先 /login';return[theme.fg(live,fit(`  · ${label} · ${busy?'执行中':model?'空闲':'待连接'}`,width))];}}));}
 for(const name of ['agent_start','agent_settled','message_start','message_update','message_end','tool_execution_start','tool_execution_update','tool_execution_end'] as const)pi.on(name as any,async(e:any,ctx:any)=>{current=ctx;if(name==='agent_start')busy=true;if(name==='agent_settled')busy=false;if(name==='agent_settled'){const path=ctx.sessionManager.getSessionFile();const logical=path&&config.sessionLinks[path];if(logical){try{keposSessionStore.syncPi(logical,ctx.sessionManager.getEntries(),ctx.sessionManager.buildContextEntries(),ctx.sessionManager.getSessionId());}catch(error){ctx.ui.notify('历史镜像失败（Pi 原始记录仍保留）：'+clean(error),'warning');}}}desk?.event(e);});
 pi.on('session_start',async(_e,ctx)=>{valid=true;generation++;bindPool();pool.change=scheduleRepaint;
 // 主模型记忆：F4 的选择写进了配置，重启后在此恢复——Pi 的默认模型是运行时设置，不会自己跟过来。
 try{
  const desired=config.mainModel;
  if(desired?.id&&ctx.model&&ctx.model.id!=='unknown'&&(ctx.model.id!==desired.id||ctx.model.provider!==desired.provider)){
   const available:any[]=await ctx.modelRegistry?.getAvailable?.()??[];
   const match=available.find(m=>m.id===desired.id&&m.provider===desired.provider);
   if(match&&!await pi.setModel(match))ctx.ui.notify(`记住的主模型 ${desired.provider}/${desired.id} 认证不可用，沿用当前默认`,'warning');
  }
 }catch{/* 恢复失败不阻断启动 */}const sessionFile=ctx.sessionManager.getSessionFile();if(sessionFile&&!config.sessionLinks[sessionFile]){const linked=keposSessionStore.createSession({cwd:ctx.cwd,title:ctx.sessionManager.getSessionName()||'未命名对话',piSessionFile:sessionFile});config.sessionLinks[sessionFile]=linked.logicalSessionId;save();}if(sessionFile&&config.sessionLinks[sessionFile]){const logical=config.sessionLinks[sessionFile];try{keposSessionStore.syncPi(logical,ctx.sessionManager.getEntries(),ctx.sessionManager.buildContextEntries(),ctx.sessionManager.getSessionId());}catch(error){ctx.ui.notify('历史镜像同步失败，原始会话未修改：'+clean(error),'warning');}}initializeCrew(ctx);install(ctx);try{baselineTools=pi.getActiveTools();}catch{}applyApprovalPolicy();const pending=db().get<any>('ui_reload');if(pending?.pid===process.pid&&pending.sessionId===ctx.sessionManager.getSessionId()&&Date.now()-pending.at<30000){db().set('ui_reload',null);setTimeout(()=>{if(valid){reloadNotice=`扩展已重载 · ${config.agents.length} 位已配置成员 · 当前会话和草稿保留`;ctx.ui.notify(reloadNotice,'info');pi.sendUserMessage("/kepos",{expandPromptTemplates:true});}},100);}});pi.on('model_select',async(_e,ctx)=>{current=ctx;initializeCrew(ctx);if(desk)desk.ctx=ctx;repaint();});
 for(const eventName of ['session_compact','session_tree'] as const)pi.on(eventName as any,async(_event:any,ctx:any)=>{desk?.invalidate();const path=ctx.sessionManager.getSessionFile();const logical=path&&config.sessionLinks[path];if(logical)try{keposSessionStore.syncPi(logical,ctx.sessionManager.getEntries(),ctx.sessionManager.buildContextEntries(),ctx.sessionManager.getSessionId());}catch(error){ctx.ui.notify('历史代际同步失败：'+clean(error),'warning');}});
 const gateRiskOf=(event:any)=>event?.toolName==='bash'||event?.toolName==='powershell'?commandRisk(String(event.input?.command||'')):event?.input&&typeof event.input.path==='string'?pathRisk(event.input.path,dataRoot):null;
 // Human gates and Kepos's own store are the human's to mutate. Strict mode asks per call,
 // proxy mode lets the model proceed with an audit trail, readonly mode removes the tools.
 pi.on('tool_call' as any,async(event:any,ctx:any)=>{
  const policy=currentPolicy();
  if(policy==='readonly'){if(['bash','powershell','edit','write'].includes(String(event?.toolName)))return{block:true,reason:'只读监督模式已开启：没有修改类工具。请把发现汇报给人类，由人类操作。'};return undefined;}
  // Terminating a stalled task is the human's call: confirm before the model cancels one.
  if(String(event?.toolName)==='kepos_worker'&&String(event.input?.action)==='cancel'){
   const parent=ctx?.sessionManager?.getSessionId();
   const workerId=event.input?.taskId||event.input?.handle?.workerId;
   const target=pool.tasks.find(item=>item.id===workerId&&item.parentSessionId===parent);
   if(target?.stalled){
    if(policy==='proxy'){desk&&desk.urgent(`代理审批留痕 · 模型终止疑似空转任务：${clean(target.agent+' · '+target.title).slice(0,120)}`);scheduleRepaint();return undefined;}
    if(ctx?.hasUI&&typeof ctx.ui?.confirm==='function'){
     const allowed=await ctx.ui.confirm('终止疑似空转的子任务？',`${target.agent} · ${clean(target.title).slice(0,120)}\n系统已标记空转并要求复核；是否终止由你决定。`);
     if(allowed){desk&&(desk.notice='已人工允许终止空转任务：'+clean(target.agent));scheduleRepaint();return undefined;}
     return{block:true,reason:'人类未同意终止该任务。请继续复核流程并把情况呈报人类。'};
    }
    return{block:true,reason:'该任务疑似空转，是否终止由人类决定。请把复核情况和表决结果呈报人类，由人类在议案终止或明确同意后重试。'};
   }
  }
  const risk=gateRiskOf(event);
  if(!risk)return undefined;
  if(policy==='proxy'){desk&&desk.urgent(`代理审批留痕 · 模型${risk==='gate'?'操作人工门禁':'修改 Kepos 数据'}：${clean(event.input?.command||event.input?.path).slice(0,140)}`);scheduleRepaint();return undefined;}
  if(ctx?.hasUI&&typeof ctx.ui?.confirm==='function'){
   const question=risk==='gate'?`模型想批准人工门禁：\n${clean(event.input?.command).slice(0,200)}`:`模型想修改 Kepos 数据：\n${clean(event.input?.command||event.input?.path).slice(0,200)}`;
   const allowed=await Promise.race([ctx.ui.confirm('严格审批 · 需要你确认',question),new Promise<boolean>(resolve=>{const timer=setTimeout(()=>resolve(false),120000);ctx.signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve(false);},{once:true});})]);
   if(allowed){desk&&(desk.notice='已人工允许模型的 Kepos 操作');scheduleRepaint();return undefined;}
   return{block:true,reason:(ctx.signal?.aborted?'已中止。':'人类未同意该操作。')+riskReason(risk)};
  }
  return{block:true,reason:riskReason(risk)};
 });
 pi.on('session_shutdown',async(event)=>{valid=false;generation++;unsubscribePool();unsubscribeMissions();spawnPoller?.stop();spawnPoller=undefined;watcher?.stop();watcher=undefined;current=undefined;clearInterval(pulseTimer);pulseTimer=undefined;clearTimeout(repaintTimer);repaintTimer=undefined;desk?.dispose();desk=undefined;pool.change=()=>{};if(event.reason==='quit'||event.reason==='reload'){try{await pool.shutdown();await scheduler.tick();}catch(error){console.error('Kepos 清理未正常完成：'+clean(error));}finally{scheduler.stop();delete globalStore[poolKey];delete globalStore[missionKey];}}});
 let supervisionPrompt='';
 // 分层提示词：核心规则常驻，其余按场景注入。
 // 每轮都全量塞入 MCP 治理、表决、计划门禁的规则，会白烧约 600 tokens——
 // 大多数对话用不到这些。分层的判据是"这次会不会真用到"，宁可多注入不可少。
 const assembleSupervisionPrompt=()=>{
  // 议会花名册：总理必须随时知道自己有多少部下、各管什么——不知道就会像没头苍蝇
  // 一样自造 "frontend-developer" 这类不存在的席。名字 + 角色键 + 职责首句，ID 不进提示词（kepos_profiles 可查）。
  const locale=councilLocale(process.env.KEPOS_LOCALE);
  // councilRole 可能返回 undefined（配置残留失效 roleKey），绝不能非空断言——
  // 这里一崩，整段监督提示词组不出来，等于每个会话启动都炸。
  const dutyOf=(a:any)=>{const def=a.roleKey?councilRole(a.roleKey):undefined;return summarizeRole(String(def?roleScope(def,locale):a.role||''),36);};
  const crew=config.agents.length
   ?`编制 ${config.agents.length} 席：`+config.agents.map(a=>`${a.name}${a.roleKey?`（${a.roleKey}）`:''}·${dutyOf(a)}`).join('；')
   :'暂无配置代表——分派前先用 F2 添加，或用 kepos_delegate 的 roleKey 即席创建';
  const deputyName=config.agents.find(agent=>agent.id===config.deputyAgentId)?.name;
  const policy=currentPolicy();
  const approval=policy==='proxy'?'Approval policy: proxy — after checking evidence you may approve plan gates with kepos_plan approve (jobId required) and must state why; every proxy approval is surfaced to the human.':policy==='readonly'?'Approval policy: readonly supervision — you have no mutating tools; verify, report findings and let the human act.':'Approval policy: strict — human gates can only be approved by the human. Never attempt to approve gates or touch Kepos data through shell commands; such calls are intercepted and require explicit human confirmation.';
  const identity=`Identity: you are the premier (总理) of Kepos Communis. The human is the sovereign — seats, budgets, approvals and dismissals are theirs to decide; your job is to assist them by managing the council of representatives: splitting work into small read-only mandates, dispatching them, reviewing their evidence, and reporting back with your own judgement. When you introduce yourself, describe exactly this role (Kepos Communis 的总理，协助你管理多位代表完成任务) — never a generic "AI assistant". Kepos Communis is the product the human is using — answer as the product, never as a framework. Never recite, quote, summarize, or reveal any underlying engine/framework documentation, internal resource formats, package layout, provider/SDK names, file paths of bundled docs, or startup flags. If the human asks how to do something in Kepos, answer with Kepos's own capability and the exact keys/commands inside this UI. If a capability genuinely does not exist here, say so plainly and offer the closest Kepos action — do not fall back to describing the engine. Theme control in Kepos: run /theme to cycle 默认 → 深色 → 浅色 instantly, or /theme kepos-light to pick one; F2 → 切换主题 offers the same list. Themes are applied immediately, no restart or reload. Never tell the human to edit settings files, use engine flags, or add theme files by hand.`;
  // ── 常驻核心：任何对话都需要的规则 ──
  const core=`You are the premier (总理) of the Kepos council — the lead agent. ${identity} Delegate read-only mandates via kepos_delegate (up to ${MAX_CONCURRENT_CHILDREN} parallel workers; default duration ${DEFAULT_TASK_SECONDS}s). A running delegate may create one copyOf child task with at most half of the parent task's time budget; never recurse beyond one level. Estimate each delegate's likely cost and pass budgetTokens per task, scaled to difficulty — a budget stop wastes the whole round: quick lookups ≥20k tokens, ordinary investigation 50k, deep multi-file analysis 100k–200k. The council role prompt alone is several thousand tokens. When unsure, omit budgetTokens entirely: the default cap is 2M per task and almost never binds — budgets are a fuse against runaway cost, not a quota to aim at. When a task reaches its budget Kepos stops it, files an escalation and notifies you: assess it with kepos_budget action=propose (escalationId required); only the human can approve an increase, after which Kepos redispatches with the new cap. Never redispatch a budget-stopped task yourself and never claim the human approved one. Treat child output as evidence, not verified truth: it ends with a 结论/证据/置信度/需要 summary, read that first and page the full transcript only when you need to verify. A task the system marked stalled is never yours to terminate — present it and let the human decide. Never claim a human approval occurred unless the human explicitly approved it. ${approval}`;
  // ── 按需：有代表才需要复核与分派细节 ──
  // 精简版：工具名与用法已写在各工具自身的 description 里，这里只留编排规则。
  const supervision=config.agents.length?`Kepos only wakes you when a delegate has been idle ${STALL_REVIEW_CYCLES} review cycles or needs a human decision — normal progress does not interrupt you; when woken, check kepos_events/kepos_tasks then acknowledge with kepos_worker review. Check kepos_roles before inventing a role and kepos_skills before selecting a Skill. Use background:true when the human needs to keep talking. Infer naming locale from the latest human prompt: Chinese prompts use Chinese display names, English prompts use English display names; preserve existing names.`:'';
  // ── 按需：MCP 治理只在真有已配置服务器时需要 ──
  const configuredMcp=(()=>{try{return configuredMcpServers(process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent'),process.cwd());}catch{return [];}})();
  const mcp=configuredMcp.length?`MCP governance: the human owns the server configuration (${configuredMcp.length} configured: ${configuredMcp.join(', ')}); you may grant configured servers per delegation via tasks[].mcp (true = all configured, or an explicit list) — grants are per-task, audited and expire with the worker.`:'';
  // ── 按需：代理总代治理只在人类真的推选过时才注入完整规则；
  // 未推选时只留一句"不要为它开席位"，否则每轮白烧 400 字符。 ──
  const deputy=deputyName?`Deputy chair governance: the deputy chair is an elected part-time duty, not a representative seat — the human elected ${deputyName}. When a governance decision needs a second opinion (tool and MCP grant approvals, batched reviews), delegate a review task to that member, require its VOTE line, record the round with kepos_vote, then set tasks[].mcp accordingly. When the human changes requirements mid-flight and re-briefing means touching many representatives at once, hand the dispatch work to the deputy chair and keep the judgement and the report to the human yourself — holding 48 re-briefings in your own context crowds out the judgement the human is actually asking for. Never create a seat or a role for the deputy chair.`:'';
  // 人类加急改变需求：重排纪律单列，因为它与"再来一个任务"是相反的次序。
  const automationState=automationPrompt(policy,config.automation);
  const replan=`When the human changes requirements or goals while work is in flight, the message arrives marked as an urgent human change. Do not treat it as an additional request: first read what is already finished and keep it, then work out which planned steps the change makes unnecessary, then re-plan. Explicitly cancel tasks the change replaced instead of letting them run to completion and discarding the result. Finish by telling the human in one sentence which steps continue, which stopped, and what changed.`;
  // ── 按需：计划门禁与表决只在确实存在长程计划时才注入。 ──
  const hasPlans=(()=>{try{return scheduler.list().length>0;}catch{return false;}})();
  const plans=hasPlans?`A delegate plan longer than ${HUMAN_APPROVAL_THRESHOLD_SECONDS}s must be represented as an kepos_plan step and explicitly approved by a human before dispatch. Use kepos_plan for long dockets with bounded steps and human gates, and kepos_events with a cursor for incremental supervision. When the council must decide, have each delegate end its output with a VOTE: yes|no|abstain - one-line reason, then record the round with kepos_vote including your own recommendation in main, and relay the tally to the human.`:'';
  // 恒定的一句：无论是否推选过，都不该为代理总代创建编制。
  const seatRule='Never create a seat or a role for the deputy chair; it is an elected duty, not a representative seat.';
  supervisionPrompt=[core,supervision,mcp,deputy,replan,automationState,plans,seatRule,config.agents.length?OPENING_STEPS:'',config.agents.length?EFFORT_GUIDE:'',`Crew: ${crew}`].filter(Boolean).join(' ');
 };
 const refreshSupervisionPrompt=()=>assembleSupervisionPrompt();refreshSupervisionPrompt();
 pi.on('before_agent_start',(event)=>{if(!supervisionPrompt)refreshSupervisionPrompt();event.systemPromptOptions.sections.kepos_supervision=supervisionPrompt;});

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
 // 已批准的 CLI 授权：按当前会话过滤，下发给代表进程。
 // 代表只能启动这里列出的 CLI；任务结束父进程终止其全部会话。
 /**
  * 已生效的外部 CLI 授权：只有当授权仍然有效时才下发给代表。
  * 有效性由 cliGrantUsable 判定——已批准、人类确认、未过期、次数未用尽、
  * 且所属任务仍在运行。任何一条不满足都不下发。
  */
 function activeCliGrants(){
  const all:Array<CliGrantRecord>=(db() as any).get?.('cli_grants')||[];
  const parent=current?.sessionManager?.getSessionId?.();
  const visible=new Set(pool.tasks.filter(t=>!parent||t.parentSessionId===parent).map(t=>t.id));
  const seen=new Set<string>();
  const out:Array<{cli:string;envKey?:string;argPrefixes?:string[]}>=[];
  for(const record of all){
   if(seen.has(record.cli))continue;
   if(!visible.has(record.taskId))continue;
   const task=pool.tasks.find(t=>t.id===record.taskId);
   // 任务已结束，授权视为失效。
   if(!task||terminalStates.has(task.status||''))continue;
   const usable=cliGrantUsable({
    id:record.id,cli:record.cli,reason:record.note||'',state:'approved',
    requestedAt:record.grantedAt,approvedAt:record.grantedAt,
    expiresAt:record.expiresAt,humanConfirmed:true,uses:record.uses||0,maxUses:record.maxUses,
   });
   if(usable.ok!==true)continue;
   seen.add(record.cli);
   out.push({cli:record.cli,envKey:record.envKey,argPrefixes:record.argPrefixes});
  }
  return out;
 }
 async function resolveDelegateJob(task:any,ctx:any,skillPaths:Map<string,string>,names:Set<string>){
  if(!task.task?.trim())throw Error('任务内容不能为空；本批任务未启动');
  // 委派四件套：缺项默认只警告（不阻断），KEPOS_MANDATE_STRICT=1 时硬拒绝。
  // 规则下沉到校验层而非提示词——报告实测纯提示词约束时 5 次会漏 1 次。
  const mandate=checkMandate(String(task.task),{strict:process.env.KEPOS_MANDATE_STRICT==='1'});
  if(mandate.ok!==true)throw Error((mandate as {reason:string}).reason);
  if(task.seconds!==undefined&&(!Number.isInteger(task.seconds)||task.seconds<1||task.seconds>MAX_TASK_SECONDS))throw Error(`任务期限必须为 1–${MAX_TASK_SECONDS} 秒；本批任务未启动`);
  if(task.seconds!==undefined&&task.seconds>HUMAN_APPROVAL_THRESHOLD_SECONDS)throw Error(`超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟的僚属 必须进入 kepos_plan 并等待人类批准；本批任务未启动`);
  if(task.budgetTokens!==undefined&&(!Number.isInteger(task.budgetTokens)||task.budgetTokens<1000))throw Error('budgetTokens 必须是不少于 1000 的整数；本批任务未启动');
  const existing=config.agents.find(agent=>agent.id===task.agent||agent.name===task.agent);
  const selectedRole=task.roleKey&&councilRole(task.roleKey);
  if(task.roleKey&&!selectedRole)throw Error(`未知 Council 角色：${task.roleKey}。有效领域：${[...new Set(COUNCIL_ROLES.map(role=>roleDomain(role)))].join('、')}；kepos_roles 不带参数返回全部 ${COUNCIL_ROLES.length} 个角色键`);
  const locale=councilLocale(process.env.KEPOS_LOCALE);
  const suggestedName=task.name||(selectedRole?roleName(selectedRole,locale):undefined);
  // 报错自带花名册：模型不知道现有席位就会自造 "frontend-developer" 这种名字再失败一轮。
  if(!existing&&!suggestedName)throw Error(`未配置的僚属「${task.agent}」。现有代表：${config.agents.map(a=>a.name).join('、')||'（空编制）'}；分派优先用这些席位，新角色请传 roleKey（kepos_roles 可查全部）或自定义 name`);
  const base:any=existing||{id:randomUUID(),name:suggestedName!,role:selectedRole?rolePrompt(selectedRole,locale):'独立只读调查',roleKey:selectedRole?.key,model:ctx.model?.id||'',provider:ctx.model?.provider||'',skills:[],tools:Array.from(READ_ONLY_TOOLS)};
  // MCP temporary grants: the human owns the configuration (mcp.json); the main agent
  // may grant configured servers per task. The grant dies with the worker process.
  // MCP 临时授权的解析顺序：task 显式指定 > 成员默认（mcpServers）> 不授权。
  const grant=resolveMcpGrant(task.mcp??(base.mcpServers?.length?base.mcpServers:undefined),configuredMcpServers(process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent'),ctx.cwd),currentPolicy());
  if('error' in grant)throw Error(grant.error);
  const mcpServers=grant.servers.length?grant.servers:undefined;
  const crew={...base,name:suggestedName||base.name,role:task.role||(selectedRole?rolePrompt(selectedRole,locale):base.role),roleKey:selectedRole?.key||base.roleKey,model:task.model||base.model,provider:task.provider||base.provider,skills:task.skills??base.skills??[],readScope:task.readScope??base.readScope??config.workerReadScope??'project',...(task.readAllow||base.readAllow?{readAllow:[...new Set([...(task.readAllow??[]),...(base.readAllow??[])])]}:{})};if(mcpServers)crew.mcpServers=mcpServers;
  if(!crew.name.trim()||!crew.model.trim())throw Error('成员名称和模型不能为空；本批任务未启动');
  const tools=task.tools??base.tools??Array.from(READ_ONLY_TOOLS);
  if(tools.some((tool:string)=>!(READ_ONLY_TOOLS as readonly string[]).includes(tool)))throw Error('工具越权，需人类裁决；任务未启动');
  const requested=task.skills??base.skills??[];
  const resolved=requested.map((skill:string)=>skillPaths.get(skill)||skillPaths.get('skill:'+skill)||skill);
  const unknown=unknownSkills(resolved,names).filter(skill=>!skill.includes('/')&&!skill.includes(String.fromCharCode(92)));
  if(unknown.length){
   // 与 F2 的 AI 生成同一管道：本地未命中时，从 skills.sh 检索、安装并绑定（只读监督模式不联网）。
   if(currentPolicy()==='readonly')throw Error('只读监督模式不联网获取 Skill。缺失：'+unknown.join(', ')+'。请人工安装后重试；本批任务未启动');
   const agentDir=process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent');
   const overrides=new Map<string,string>();const bound:string[]=[];const failed:string[]=[];
   for(const raw of unknown){
    const hit=await resolveSkillOnline(raw.replace(/^skill:/,''),agentDir).catch(()=>null);
    if(hit){overrides.set(raw,hit.path);bound.push(raw.replace(/^skill:/,''));}
    else failed.push(raw);
   }
   if(failed.length)throw Error('这些 Skill 未安装，且 skills.sh 无匹配：'+failed.join(', ')+'。可人工安装后重试；本批任务未启动');
   if(bound.length){desk&&(desk.notice='已从 skills.sh 安装并绑定 Skill：'+bound.join('、'));scheduleRepaint();}
   for(let index=0;index<resolved.length;index++){const override=overrides.get(resolved[index]);if(override)resolved[index]=override;}
  }
  // 记忆注入：把该代表此前有效记忆拼成索引，附在任务文本前面。
  // 硬上限 200 行；结尾声明仅供参考——旧记忆不能覆盖本任务的实际证据。
  const memoryIndex=renderMemoryIndex(memoryPipeline.list(crew.id||crew.name));
  // 同组通道：把已有的组内消息一并带上。声明"只含状态与讨论"不是客套——
  // 通道里确实不走推理与结论，代表要据此知道这些内容不构成对判断的引导。
  // 该代表这次实际属于哪些组：原本的组 + 未到期的借调目标组。
  // 借调成员因此能收到目标组的频道，而到期后自动退回原组——
  // "临时"不靠人记得收回，靠 effectiveGroups 每个读取方都算一次。
  // 组标识统一校验：非法值在这里就报错，而不是变成"组没生效"。
  // 分派时组是可选的，缺省即不进组。
  const homeGroup=optionalGroupId(task.groupId);
  const groups=effectiveGroups({homeGroup,secondments:secondmentStore.active(),agentId:crew.id});
  // 派发阶段任务 id 尚未生成，所以没有"自己"可标记：所有消息都按发言者显示。
  const channelFor=groups.length
   ?groups.map(id=>renderGroupChannel(readGroupMessages(join(ctx.cwd,ARCHIVE_DIR),id,8),'')).filter(Boolean).join('\n\n')
   :'';
  const groupChannel=channelFor;
  const groupId=homeGroup;
  // 已批准的协调者告知全组：协调职责不是权限，是"信息从这里汇总"。
  // 协调者必须仍是现任代理总代：组内推举批的是"兼任总代的那个人"，
  // 人类撤销或换人之后，旧的批准失去依附，不该继续生效。
  const incumbentDeputy=config.agents.find(agent=>agent.id===config.deputyAgentId)?.name;
  const coordinator=groupId?electionStore.coordinator(groupId,name=>name===incumbentDeputy):undefined;
  // 成员名单直接用这次实际有效的组员：包含借调进来的人，
  // 也不再用嵌套 some() 反查——那既慢又会漏掉没有本会话任务的人。
  const groupMembers=pool.tasks.filter(item=>item.groupId===groupId).map(item=>item.agent);
  const coordinatorNote=!coordinator?''
   :crew.name===coordinator
    ?coordinatorBrief(crew.name,groupId as string,[...new Set(groupMembers)])
    :`组内协调由「${coordinator}」牵头：把状态与证据发到组通道，不要直接把判断交给它。`;
  // 同组证据：拿到的是别人产出里"## 结论"之前的段落，事实可以共享，判断不行。
  // 这一步让"同组可读彼此证据"从文档承诺变成运行时行为——此前它只写在 CHANGELOG 里。
  // selfTaskId 传空：任务此刻还没有 id（派发前组装），而组内已发布的证据
  // 都来自别的任务，不存在"读到自己"的问题。
  const peerEvidence=homeGroup
   ?renderPeerEvidence(readGroupEvidence(join(ctx.cwd,ARCHIVE_DIR),homeGroup,''))
   :'';
  const groupPreamble=[groupChannel,peerEvidence,coordinatorNote].filter(Boolean).join('\n\n');
  const preamble=[memoryIndex,groupPreamble].filter(Boolean).join('\n\n');
  const launched=preamble?{...task,task:`${preamble}\n\n---\n\n${String(task.task||'')}`}:task;
  // memoryInjected 只用于度量分组：哪一组任务在派发时看过该代表的历史记忆。
  return {...launched,crew,skills:resolved,mcp:false,mcpServers,tools,memoryInjected:Boolean(memoryIndex)};
 }

 const handleSchema=Type.Object({version:Type.Literal(1),workerId:Type.String(),parentSessionId:Type.String(),capability:Type.String()});
 pi.registerTool({name:'kepos_worker',label:'僚属 生命周期',description:'使用 Handle 或当前会话 taskId 查询/等待/复核确认/取消。每 5 分钟出现复核点；主 Agent 检查状态和证据后使用 review 确认下一周期。完成结果默认返回1600字符预览；cursor/maxChars 分页读取证据。校验父会话和 capability。',parameters:Type.Object({handle:Type.Optional(handleSchema),taskId:Type.Optional(Type.String({description:'当前会话的任务 ID；前台分派拿不到 Handle 时用它'})),action:Type.Union(['status','wait','review','result','cancel','reconnect','message'].map(value=>Type.Literal(value))),text:Type.Optional(Type.String({maxLength:4000,description:'message 动作转发的追加消息；只对运行中的任务有效，任务结束即收回'})),seconds:Type.Optional(Type.Integer({minimum:0,maximum:30})),cursor:Type.Optional(Type.Integer({minimum:0})),maxChars:Type.Optional(Type.Integer({minimum:200,maximum:6000}))}),async execute(_id,params,_signal,_update,ctx){
  const parent=ctx.sessionManager.getSessionId();
  let handle=params.handle as WorkerHandle|undefined;
  if(!handle&&params.taskId){const task=pool.tasks.find(item=>item.id===params.taskId&&item.parentSessionId===parent);if(!task)throw Error('当前会话没有该任务：'+params.taskId);handle={version:1,workerId:task.id,parentSessionId:parent,capability:'task'};}
  if(!handle)throw Error('需要 handle 或当前会话内的 taskId');
  let result:any;
  switch(params.action){
   case 'message':{
    if(!params.text?.trim())throw Error('message 需要 text');
    // 人类不直接指挥僚属：责任链会断在中间。这条限制落在工具层，
    // 不只是界面层——总理也不该绕过代表去改下属的方向。
    const target=pool.tasks.find(t=>t.id===handle.workerId);
    if(target?.parentWorkerId)throw Error(`taskId ${handle.workerId} 是僚属任务，不接受直接指令。请改为向其直属代表「${pool.tasks.find(t=>t.id===target.parentWorkerId)?.agent||'—'}」下达。`);
    const outcome=await pool.sendMessage(handle,parent,params.text.trim());
    if(!outcome.delivered)throw Error(outcome.error||'转发失败');
    result={state:outcome.state,delivered:true,agent:outcome.agent};break;
   }
   case 'status':result=pool.status(handle,parent);break;
   case 'wait':result=await pool.wait(handle,parent,params.seconds??2);break;
   case 'review':result=pool.review(handle,parent);break;
   case 'cancel':result=pool.cancelHandle(handle,parent);break;
   case 'reconnect':result=pool.reconnect(handle,parent);break;
   default:result=pool.result(handle,parent);
  }
  // 结果被读取的事件：kepos_metrics 的"二次追问率"分子只能从这里来。
  // 写在这里而不是 pool 内部，因为"被读过"是调用方的行为，不是任务的属性。
  if(['result','wait'].includes(params.action)){
   try{db().prepare('INSERT INTO worker_events(worker_id,type,created,payload) VALUES(?,?,?,?)').run(handle.workerId,params.action==='wait'?'wait_read':'result_read',Date.now(),JSON.stringify({state:String(result?.state??'')}));}catch{}
  }
  const data=receiptView(result,{cursor:params.cursor,maxChars:params.maxChars});
  return{content:[{type:'text',text:JSON.stringify(data)}],isError:['UNKNOWN','UNKNOWN_HANDLE'].includes(result.state),details:data};
 }});
 const VOTE_LABELS:{[key:string]:string}={yes:'赞成',no:'反对',abstain:'弃权'};
 // 组内推举：围绕一个任务的协作要有人牵头。
 // 结果是**候选**，人类在 F2 确认后才生效——自主推举省的是协调成本，
 // 不是编制决定权。
 pi.registerTool({name:'kepos_group',label:'同组协作与推举',description:'读取、发言或统计一个工作小组的通信与推举。同组代表可交换状态、就具体问题讨论、明确表达异议；通道内不含推理过程与结论（那两样必须各自独立形成）。action=status 看组内消息与当前推举结果；action=post 由总理代发一条消息（代表自己用进程内的 kepos_group 工具发）；action=elect 统计推举（组员在 discuss 消息里写「推举：某某」）。推举结果是候选，需要人类确认。',parameters:Type.Object({groupId:Type.String({maxLength:64}),action:Type.Union([Type.Literal('status'),Type.Literal('post'),Type.Literal('elect')]),kind:Type.Optional(Type.Union([Type.Literal('status'),Type.Literal('discuss'),Type.Literal('challenge')],{description:'post 时的消息种类'})),text:Type.Optional(Type.String({maxLength:1200,description:'post 的正文'})),limit:Type.Optional(Type.Integer({minimum:1,maximum:60}))}),async execute(_id,params,_signal,_update,ctx){
  const archiveRoot=join(ctx.cwd,ARCHIVE_DIR);
  // 组标识统一校验：写错的组名会变成"组没生效"，那是最难查的一类问题。
  const groupResult=normalizeGroupId(params.groupId);
  if(groupResult.ok!==true)throw Error(groupResult.reason);
  const groupId=groupResult.groupId;
  // 代发消息：总理本人也可以是组里的一个声音（例如转达人类的决定）。
  // 代表的 groupId 校验必须放在用之前——否则非法 id 会走进后面按组过滤的逻辑。
  if(params.action==='post'){
   if(!params.text?.trim())throw Error('post 需要 text');
   const kind:any=params.kind||'status';
   const message=postGroupMessage(archiveRoot,{groupId,taskId:'premier',agent:'总理',kind,text:params.text});
   return{content:[{type:'text',text:`已发到组 ${groupId}（${kind}）：${message.id}`}],details:message};
  }
  const messages=readGroupMessages(archiveRoot,groupId,params.limit??20);
  // 组成员来自当前会话的任务，按 groupId 过滤——不信任消息里自称的身份。
  // 组成员 = 本会话里属于该组的任务 + 被借调进该组的代表。
  // 少了后半段，借调进来的人虽然能看到频道，票却不被计入、也选不上——
  // 那让借调只剩"旁听"，与它"临时成为组员"的用意不符。
  const memberMap=new Map<string,{taskId:string;agent:string}>();
  for(const task of pool.tasks){
   if(task.groupId===groupId&&task.parentSessionId===ctx.sessionManager.getSessionId())memberMap.set(task.id,{taskId:task.id,agent:task.agent});
  }
  for(const loan of secondmentStore.active()){
   if(loan.toGroup!==groupId)continue;
   // 借调成员可能还没有本会话的任务：用它的配置 id 作为稳定标识。
   if(![...memberMap.values()].some(item=>item.agent===loan.agent))memberMap.set(loan.id,{taskId:loan.agentId,agent:loan.agent});
  }
  const members=[...memberMap.values()];
  // 组内消息与推举结果对两个动作都一样，只算一次。
  const result=tallyElection(messages,members);
  const outcome=electionOutcome(result,members.length);
  if(params.action==='status'){
   const data={groupId,members:members.map(m=>m.agent),messages:messages.length,election:{ballots:result.ballots,candidates:result.candidates,...outcome},channel:renderGroupChannel(messages,'premier')};
   return{content:[{type:'text',text:boundedJson(data)}],details:data};
  }
  // 评估每位候选人：档案（职责/模型）+ 历史（完成率/失败类别）。
  // 报告只给依据与条件式建议，批准与否由人类决定。
  const goal=pool.tasks.find(task=>task.groupId===groupId&&task.parentSessionId===ctx.sessionManager.getSessionId())?.title;
  const assessments=result.candidates.map(candidate=>assessCandidate({
   candidate,
   profile:config.agents.find(agent=>agent.name===candidate.agent),
   tasks:pool.tasks,
   goal,
  }));
  const report=buildElectionReport({groupId,goal,electorate:members.length,ballots:result.ballots,tied:result.tied,assessments});
  // 登记为待批：人类在 F2 里看报告并决定。
  // 只有真有人可推举时才提交——全都不合适时提交一份"建议不要批"的报告，
  // 只会让待批列表里堆着没有决定可做的项。
  const viable=report.candidates.filter(item=>item.verdict!=='avoid');
  const submitted=viable.length?electionStore.submit(report):undefined;
  // 没提交时必须说清为什么：只给 submitted:undefined，调用方分不清
  // "没人合适"和"推举失败"——那会让它重试一个注定失败的推举。
  const notSubmittedReason=viable.length?undefined
   :!report.candidates.length?'组内还没有推举表态'
   :'所有候选人都存在未解决的记录，先诊断再推举';
  if(desk&&submitted){desk.notice=`推举呈报待批准 · 组 ${groupId} · F2 → 推举呈报`;scheduleRepaint();}
  else if(desk&&notSubmittedReason){desk.notice=`未呈报：${notSubmittedReason}`;scheduleRepaint();}
  const data={groupId,electorate:members.length,ballots:result.ballots,tied:result.tied,decided:outcome.decided,reason:outcome.reason,report,submitted:submitted?.id,...(notSubmittedReason?{notSubmittedReason}:{})};
  return{content:[{type:'text',text:renderElectionReport(report)}],details:data};
 }});
 pi.registerTool({name:'kepos_vote',label:'代表团表决',description:'汇总一次代表团表决并呈报人类。代表票来自各任务产出末尾的约定行 VOTE: yes|no|abstain - 理由；主 Agent 自己的票用 main 传入，展示时标注（分派方，注意利益关联）。是否终止空转/预算任务、是否改变方向等重大决定由人类裁决，本工具只汇总呈现。',parameters:Type.Object({question:Type.String({maxLength:300}),votes:Type.Array(Type.Object({agent:Type.String(),choice:Type.Union(['yes','no','abstain'].map(x=>Type.Literal(x))),reason:Type.Optional(Type.String({maxLength:200}))}),{maxItems:48,minItems:1}),main:Type.Optional(Type.Object({choice:Type.Union(['yes','no','abstain'].map(x=>Type.Literal(x))),reason:Type.Optional(Type.String({maxLength:200}))}))}),async execute(_id,params){
  const tally:any={yes:0,no:0,abstain:0};for(const vote of params.votes)tally[vote.choice]++;
  const record={at:Date.now(),question:params.question,votes:params.votes,main:params.main,tally};
  const history=db().get<any[]>('votes')||[];history.push(record);db().set('votes',history.slice(-50));
  const lines=params.votes.map(vote=>`${vote.agent}：${VOTE_LABELS[vote.choice]}${vote.reason?`（${vote.reason}）`:''}`);
  if(params.main)lines.unshift(`主 Agent（分派方，需注意利益关联）：${VOTE_LABELS[params.main.choice]}${params.main.reason?`（${params.main.reason}）`:''}`);
  lines.push(`表决汇总：赞成 ${tally.yes} · 反对 ${tally.no} · 弃权 ${tally.abstain}`);
  lines.push('请把以上结果原样转述给人类；是否执行（含是否终止任务）由人类决定。');
  if(desk){desk.notice=`表决 · ${params.question.slice(0,80)}：赞成${tally.yes} 反对${tally.no} 弃权${tally.abstain}${params.main?` · 主Agent（分派方）：${VOTE_LABELS[params.main.choice]}`:''}`;scheduleRepaint();}
  return{content:[{type:'text',text:boundedText(lines.join('\n'),1600)}],details:record};
 }});
 pi.registerTool({name:'kepos_memory',label:'代表记忆与复盘笔记',description:'查询或管理代表记忆。记忆由任务结束后自动整理产生，双时态保存：失效只标记不删除，可回溯历史上某个时刻相信什么。list 查当前有效记忆；search 按关键词检索；asof 查历史；invalidate 手动失效一条（不删除）。失败/超时任务的记忆即"复盘笔记"：哪个环节出错、下次该怎么委派。',parameters:Type.Object({action:Type.Union(['list','search','asof','invalidate','lessons'].map(value=>Type.Literal(value))),agent:Type.Optional(Type.String({maxLength:120,description:'代表名称或 ID'})),query:Type.Optional(Type.String({maxLength:200,description:'search 的关键词'})),at:Type.Optional(Type.Integer({description:'asof 的时间戳（毫秒）'})),id:Type.Optional(Type.String({maxLength:80,description:'invalidate 时的记忆 id'})),limit:Type.Optional(Type.Integer({minimum:1,maximum:200}))}),async execute(_id,params){
  const limit=params.limit??50;
  if(params.action==='invalidate'){
   if(!params.id)throw Error('invalidate 需要 id');
   const ok=memoryPipeline.invalidate(String(params.id));
   const detail={id:params.id,invalidated:ok,memories:[] as any[]};
   return{content:[{type:'text',text:ok?'已标记失效（记录保留，可回溯）':'该记忆已是失效状态或不存在'}],details:detail};
  }
  const member=config.agents.find(a=>a.id===params.agent||a.name===params.agent);
  if(!member)throw Error('找不到该代表：'+(params.agent||'(未指定)'));
  let rows;
  if(params.action==='asof'){
   if(!Number.isFinite(params.at))throw Error('asof 需要时间戳 at');
   rows=memoryPipeline.asOf(member.id,Number(params.at));
  }else if(params.action==='search'){
   rows=memoryPipeline.search(member.id,String(params.query||''));
  }else if(params.action==='lessons'){
   // 复盘笔记来自失败任务的整理：按来源任务是否失败无法从记忆行判断，
   // 所以用来源任务状态在读取时过滤——比在记忆里多存一个布尔可靠（状态是权威）。
   rows=memoryPipeline.list(member.id).filter(row=>{
    if(!row.sourceWorkerId)return false;
    const task=pool.tasks.find(item=>item.id===row.sourceWorkerId);
    return !!task&&['失败','超时','已中断'].includes(String(task.status||''));
   });
  }else{
   rows=memoryPipeline.list(member.id);
  }
  const data=rows.slice(0,limit).map(row=>({id:row.id,kind:row.kind,content:row.content,sourceWorkerId:row.sourceWorkerId,validFrom:row.validFrom,validTo:row.validTo}));
  const empty=params.action==='lessons'?'该代表暂无复盘笔记；失败/超时任务结束后会自动整理。':'该代表暂无记忆；任务完成后会自动整理。';
  return{content:[{type:'text',text:JSON.stringify({agent:member.name,total:rows.length,memories:data,note:data.length?'':empty})}],details:{memories:data}};
 }});
 pi.registerTool({name:'kepos_cli_grant',label:'外部 CLI 白名单与授权',description:'管理外部 agent CLI（codex / claude 等）的白名单与任务级授权。白名单存 config.json，由人类决定。授权绑定到某次任务，任务结束自动回收。代表只能在授权范围内启动 CLI。',parameters:Type.Object({action:Type.Union(['list','allow','remove','grant','status'].map(value=>Type.Literal(value))),cli:Type.Optional(Type.String({maxLength:40,description:'CLI 可执行名，如 codex'})),label:Type.Optional(Type.String({maxLength:60,description:'allow 时的显示名'})),envKey:Type.Optional(Type.String({maxLength:80,description:'该 CLI 需要的凭据环境变量名；只传这一个'})),argPrefixes:Type.Optional(Type.Array(Type.String({maxLength:40}),{description:'允许的首参数前缀，如 exec / -b / -P'})),taskId:Type.Optional(Type.String({description:'grant 时把授权绑定到该任务'})),note:Type.Optional(Type.String({maxLength:300}))}),async execute(_id,params,_signal,_update,ctx){
  const allowlist=config.cliAllowlist||{};
  if(params.action==='list'){
   const entries=Object.entries(allowlist).map(([name,entry])=>({cli:name,...entry}));
   return{content:[{type:'text',text:JSON.stringify({allowlist:entries,note:entries.length?'':'白名单为空：请先用 allow 添加，再由人类确认。'})}],details:{allowlist:entries}};
  }
  if(params.action==='allow'){
   const name=String(params.cli||'').trim().toLowerCase();
   if(!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name))throw Error('CLI 名只能含字母数字与 ._-，长度 1-40');
   const existing=allowlist[name];
   config.cliAllowlist={...allowlist,[name]:{label:String(params.label||existing?.label||name),...(params.envKey?{envKey:String(params.envKey)}:existing?.envKey?{envKey:existing.envKey}:{}),...(params.argPrefixes?{argPrefixes:params.argPrefixes.map(String)}:existing?.argPrefixes?{argPrefixes:existing.argPrefixes}:{}),...(params.note?{note:String(params.note)}:existing?.note?{note:existing.note}:{}),addedAt:existing?.addedAt??Date.now()}};
   save();
   return{content:[{type:'text',text:`已加入白名单：${name}${params.envKey?`（凭据变量 ${params.envKey}）`:''}。代表只能在授权后使用它。`}],details:{cli:name}};
  }
  if(params.action==='remove'){
   const name=String(params.cli||'').trim().toLowerCase();
   if(!allowlist[name])throw Error('白名单里没有该 CLI：'+name);
   const next={...allowlist};delete next[name];
   config.cliAllowlist=next;save();
   return{content:[{type:'text',text:`已移出白名单：${name}。进行中的会话不受影响，新的启动会被拒绝。`}],details:{cli:name}};
  }
  if(params.action==='grant'){
   // 授权：把白名单条目下发给指定任务。任务结束时父进程回收。
   const name=String(params.cli||'').trim().toLowerCase();
   const entry=allowlist[name];
   if(!entry)throw Error(`白名单里没有 ${name}：先 allow，再由人类确认`);
   const ready=credentialsReady(entry,process.env);
   if(!ready.ok)throw Error(String(ready.reason));
   if(!params.taskId)throw Error('grant 需要 taskId：授权绑定到具体任务');
   const grants:any[]=(db() as any).get?.('cli_grants')||[];
   // 授权带过期时间：默认 30 分钟，不得超过任务剩余时间太多，避免长期有效的隐性权限。
   const grantedAt=Date.now();const expiresAt=grantedAt+30*60*1000;
   grants.push({id:randomUUID(),taskId:String(params.taskId),cli:name,envKey:entry.envKey,argPrefixes:entry.argPrefixes,note:params.note?String(params.note):undefined,grantedAt,expiresAt,uses:0});
   db().set('cli_grants',grants.slice(-200));
   if(desk){desk.notice=`已授权 ${name} 给任务 ${String(params.taskId).slice(0,8)}（任务结束回收）`;scheduleRepaint();}
   return{content:[{type:'text',text:`已授权 ${name} 给任务 ${params.taskId}。代表可在该任务内启动该 CLI 的多个会话；任务结束全部终止。`}],details:{cli:name,taskId:params.taskId}};
  }
  // status：列出授权与对应任务状态。
  const grants:any[]=(db() as any).get?.('cli_grants')||[];
  const parent=ctx.sessionManager.getSessionId();
  const ids=new Set(pool.tasks.filter(t=>t.parentSessionId===parent).map(t=>t.id));
  const view=grants.filter(g=>ids.has(g.taskId)).map(g=>({id:g.id,taskId:g.taskId,cli:g.cli,active:!terminalStates.has(pool.tasks.find(t=>t.id===g.taskId)?.status||'')}));
  return{content:[{type:'text',text:JSON.stringify({grants:view,allowlist:Object.keys(allowlist)})}],details:{grants:view}};
 }});
 pi.registerTool({name:'kepos_budget',label:'预算追加评估',description:'预算截停的呈报通道。任务到达 token 预算被截停时，系统会立案并通知你；用 action=propose 附上你的额度评估（suggestedTokens 为不少于 1000 的整数）。是否追加由人类在 F2 → 预算追加审批 决定，批准后系统按新额度重派。在人类批准之前不得自行重派该任务，也不得声称已获批准。action=status 查看待批立案。',parameters:Type.Object({action:Type.Union(['propose','status'].map(value=>Type.Literal(value))),escalationId:Type.Optional(Type.String({description:'propose 必填：立案 id（来自截停呈报）'})),suggestedTokens:Type.Optional(Type.Integer({minimum:1000,description:'propose 必填：建议的新额度'})),note:Type.Optional(Type.String({maxLength:300,description:'一句话依据，会显示给人类'}))}),async execute(_id,params,_signal,_update,_ctx){
  const store=new BudgetEscalations(db());
  if(params.action==='status'){
   const rows=store.pending(10);
   if(!rows.length)return{content:[{type:'text',text:'当前没有待审批的预算追加立案。'}],details:{pending:[]}};
   return{content:[{type:'text',text:rows.map(row=>`${row.id} · ${row.agent} · 已耗 ${row.spent}/${row.cap}${row.proposal?` · 你已建议 ${row.proposal}`:''} · ${row.task.slice(0,80)}`).join('\n')}],details:{pending:rows}};
  }
  if(!params.escalationId||params.suggestedTokens===undefined)throw Error('propose 需要 escalationId 与 suggestedTokens');
  if(!store.propose(params.escalationId,params.suggestedTokens,params.note))throw Error('立案不存在或已不在待批状态');
  if(desk){desk.notice=`总理建议 ${formatTokens(params.suggestedTokens)} tokens · 审批即将弹出`;scheduleRepaint();queueBudgetApproval(String(params.escalationId));}
  return{content:[{type:'text',text:`评估已登记。人类将在 F2 → 预算追加审批 中决定；批准后系统按新额度重派。在此之前请勿重派或声称已获批。`}],details:{escalationId:params.escalationId,proposal:params.suggestedTokens}};
 }});
 pi.registerTool({name:'kepos_grant',label:'权限申请与转授',description:'代表申请写权限，或把自身持有的权限转授给僚属。审批链：代表申请 → 代理总代转呈 → 总理批准 → 人类确认。授权绑定在这一次任务的进程上，任务结束即失效。转授不能超过自身持有范围。',parameters:Type.Object({action:Type.Union(['request','grant','status'].map(value=>Type.Literal(value))),tools:Type.Optional(Type.Array(Type.String({maxLength:40}),{description:'request: 申请的写权限（bash/powershell/edit/write）；grant: 要转授给僚属的子集'})),reason:Type.Optional(Type.String({maxLength:500,description:'request 必填：要改什么、为什么必须写'})),taskId:Type.Optional(Type.String({description:'申请者任务 id；缺省取当前会话最近的任务'})),member:Type.Optional(Type.String({description:'grant 时指定僚属名称或任务 id'})),grantId:Type.Optional(Type.String({description:'status/approve 时指定授权 id'})),approve:Type.Optional(Type.Boolean({description:'true 表示人类确认批准（严格模式下必须显式传）'})),note:Type.Optional(Type.String({maxLength:300,description:'批准或驳回的理由，写入审计'})),text:Type.Optional(Type.String({maxLength:300}))}),async execute(_id,params,_signal,_update,ctx){
  // 授权表：按任务 id 记，任务终态时由 sweepGrants 清掉，绝不跨任务保留。
  const grants:any[]=(db() as any).get?.('grants')||[];
  const saveGrants=()=>db().set('grants',grants.slice(-200));
  if(params.action==='request'){
   const checked=validateGrantRequest({tools:params.tools,reason:params.reason});
   if(!checked.ok)throw Error(checked.reason);
   const parent=ctx.sessionManager.getSessionId();
   const taskId=params.taskId||pool.tasks.filter(t=>t.parentSessionId===parent&&!terminalStates.has(t.status)).at(-1)?.id;
   if(!taskId)throw Error('找不到可申请的任务：请指定 taskId');
   const request:GrantRequest={id:randomUUID(),taskId,agent:pool.tasks.find(t=>t.id===taskId)?.agent||'代表',tools:checked.tools,reason:checked.reason,state:'requested',requestedAt:Date.now()};
   grants.push(request);saveGrants();
   // 严格模式下必须人类确认；这里只登记申请，批准走 approve。
   if(desk){desk.urgent(`权限申请待批准：${describeForHuman(request)}`);scheduleRepaint();}
   return{content:[{type:'text',text:`已登记权限申请 ${request.id}\n${describeForHuman(request)}\n严格模式下需要人类确认后才会生效。`}],details:{request}};
  }
  if(params.action==='grant'){
   // 代表当前持有的权限：来自已批准且任务未结束的授权。
   const holder=params.grantId?grants.find(g=>g.id===params.grantId):grants.filter(g=>g.state==='approved'&&!terminalStates.has(pool.tasks.find(t=>t.id===g.taskId)?.status||'')).at(-1);
   if(!holder)throw Error('没有可用的已批准权限：先 request 并通过批准');
   const liveTask=pool.tasks.find(t=>t.id===holder.taskId);
   if(!liveTask||terminalStates.has(liveTask.status))throw Error('该权限所属任务已结束，授权已失效');
   const checked=canDelegate(holder.tools,params.tools||[]);
   // strict:false 下联合类型不会按 !ok 收窄，用显式分支取值。
   if(checked.ok!==true)throw Error((checked as {reason:string}).reason);
   // 转授记录：绑定到僚属任务，同样随任务结束失效。
   const target=params.member?pool.tasks.find(t=>t.id===params.member||t.agent===params.member):undefined;
   if(!target)throw Error('找不到该僚属：请指定名称或任务 id');
   grants.push({id:randomUUID(),taskId:target.id,agent:target.agent,tools:checked.tools,reason:`转授自 ${holder.agent}`,state:'approved',requestedAt:Date.now(),approvedAt:Date.now(),humanConfirmed:true,delegatedFrom:holder.id});
   saveGrants();
   return{content:[{type:'text',text:`已把 ${checked.tools.join(' / ')} 转授给僚属 ${target.agent}（任务 ${target.id}）。随该任务结束失效。`}],details:{tools:checked.tools,taskId:target.id}};
  }
  // status：列出本会话相关的授权。
  const parent=ctx.sessionManager.getSessionId();
  const ids=new Set(pool.tasks.filter(t=>t.parentSessionId===parent).map(t=>t.id));
  const view=grants.filter(g=>ids.has(g.taskId)).map(g=>({id:g.id,taskId:g.taskId,agent:g.agent,tools:g.tools,state:g.state,active:grantActive(g,terminalStates.has(pool.tasks.find(t=>t.id===g.taskId)?.status||''))}));
  return{content:[{type:'text',text:JSON.stringify(view)}],details:{grants:view}};
 }});
 pi.registerTool({name:'kepos_attach',label:'读取附件',description:'读取本地文件并把内容作为证据返回：docx / pptx / xlsx / epub / zip 自动提取文本，pdf 需要可选解析器，图片返回为图像附件，纯文本直接读取。人类说"读一下某个文件"时用它，不要凭空猜测文件内容。凭据文件与 Kepos 数据目录会被拒绝。',parameters:Type.Object({paths:Type.Array(Type.String({maxLength:1000}),{minItems:1,maxItems:8,description:'要读取的绝对路径或相对项目根的路径'}),cwd:Type.Optional(Type.String({maxLength:1000,description:'解析相对路径的基准目录；默认当前项目'})),cursor:Type.Optional(Type.Integer({minimum:0,description:'上一页返回的 nextCursor；用于读取超长附件的后续段落'})),maxChars:Type.Optional(Type.Integer({minimum:500,maximum:120000,description:'每个文件返回的最大字符数，默认 20000'}))}),async execute(_id,params,_signal,_update,ctx){
  const base=params.cwd||ctx?.cwd||process.cwd();
  const results:any[]=[];
  for(const path of params.paths){
   const loaded=await loadAttachment(path,{cwd:base,deny:[dataRoot]});
   // 早返回式收窄，避免为联合类型维护额外的守卫函数。
   if(!isAttached(loaded)){results.push({ok:false,path,reason:loaded.reason});continue;}
   const limit=params.maxChars??20000;
   // 超长附件按游标分页：模型读一段后可用 nextCursor 继续，
   // 而不是永远只能看到头尾、中段永远读不到。
   const page=loaded.attachment.kind==='image'?null:paginateAttachmentText(loaded.attachment.text||'',params.cursor??0,limit);
   const body=loaded.attachment.kind==='image'
    ? `[图片 ${loaded.attachment.name} · ${loaded.attachment.mimeType} · 已作为图像附件]`
    : page!.text;
   results.push({ok:true,name:loaded.attachment.name,path:loaded.attachment.path,kind:loaded.attachment.kind,bytes:loaded.attachment.bytes,note:loaded.attachment.note,truncated:!!loaded.attachment.truncated,content:body,
    ...(page?{cursor:page.cursor,nextCursor:page.nextCursor,total:page.total,page:page.page,pages:page.pages}:{})});
  }
  const text=results.map(item=>item.ok?`<file name="${item.name}" kind="${item.kind}"${item.note?` note="${item.note}"`:''}>\n${item.content}\n</file>`:`<file-error path="${item.path}">${item.reason}</file-error>`).join('\n\n');
  return{content:[{type:'text',text}],details:{results}};
 }});
 pi.registerTool({name:'kepos_skills',label:'查看可用 Skill',description:'返回当前已安装且可被明确选择的 Skill 短索引。Skill 提供方法，不扩大僚属 的工具或 MCP 权限。',parameters:Type.Object({query:Type.Optional(Type.String({maxLength:100}))}),async execute(_id,params){
  const query=String(params.query||'').toLowerCase();
  const skills=installedSkillCatalog().filter(skill=>!query||`${skill.name} ${skill.description}`.toLowerCase().includes(query)).slice(0,100);
  return{content:[{type:'text',text:JSON.stringify({skills:skills.map(({name,description})=>({name,description})),usage:'将 name 传给 kepos_delegate.tasks[].skills；只选择与当前授权事项匹配的 Skill。'})}],details:{count:skills.length}};
 }});
 pi.registerTool({name:'kepos_roles',label:'查看 Council 角色目录',description:'返回预设代表角色的短索引。不带参数返回全部角色；支持按领域筛选或关键词搜索。主 Agent 可先用它选择 roleKey，再用 kepos_delegate 快速创建代表。',parameters:Type.Object({domain:Type.Optional(Type.String({maxLength:40})),query:Type.Optional(Type.String({maxLength:100}))}),async execute(_id,params){
  const roles=roleCatalog(params);
  const domains=[...new Set(COUNCIL_ROLES.map(role=>roleDomain(role)))];
  // 空结果必须自带纠错信息：猜错 domain 就返回空数组，模型只能再瞎猜一轮。
  const hint=!roles.length&&(params.domain||params.query!==undefined)
   ?`没有匹配。有效的 domain：${domains.join('、')}；把 domain/query 去掉即返回全部 ${COUNCIL_ROLES.length} 个角色。`
   :undefined;
  return{content:[{type:'text',text:boundedJson({roles,domains,hint,usage:'将 key 传给 kepos_delegate.tasks[].roleKey；如需 Skill，再用 kepos_skills 验证后显式传入。'})}],details:{count:roles.length}};
 }});
 pi.registerTool({name:'kepos_precheck',label:'静默预检',description:'【自动化能力 · 需人类开启且处于代理档】拿到 bug 报告时先并行试着复现，只有确认可复现才打断人。派几名只读代表从不同角度（测试 / 源码 / 运行行为）各试一次；结论分「已复现 / 未能复现 / 无法判断」三种，后两种不打扰人但都会留记录。同一份报告只预检一次。开销：每席 12 万 token、4 分钟上限。未开启或被档位停用时调用会报错并说明原因。',parameters:Type.Object({report:Type.String({maxLength:4000,description:'要预检的问题描述：现象、触发步骤、环境'})}),async execute(_id,params,_signal,_update,ctx){
  const outcome=await runPrecheck(params.report,ctx);
  if(!outcome)return{content:[{type:'text',text:'未执行预检（报告不满足条件或已预检过）'}],details:undefined};
  return{content:[{type:'text',text:precheckReport({report:params.report,result:outcome.result,attempts:outcome.attempts})}],details:outcome.result};
 }});
 pi.registerTool({name:'kepos_workflow',label:'工作流',description:'把"这套团队按这个顺序做这类任务"存成可复用的工作流：席位配方（名字/角色/模型）+ 计划模板（步骤/依赖/组/验收）。action=list 列出；get 看细节；create 把当前编制与给定步骤存成新工作流；run 按某个工作流开始一次任务（需要 goal，会把 {goal} 替换进去并补齐缺失席位）。实例化不会重建已存在的代表。',parameters:Type.Object({
  action:Type.Union(['list','get','create','run'].map(value=>Type.Literal(value))),
  id:Type.Optional(Type.String({maxLength:80,description:'工作流 id（get / run 时需要）'})),
  name:Type.Optional(Type.String({maxLength:80,description:'create 时的名称'})),
  description:Type.Optional(Type.String({maxLength:300})),
  goal:Type.Optional(Type.String({maxLength:2000,description:'run 时本次任务的目标；会替换步骤里的 {goal}'})),
  steps:Type.Optional(Type.Array(Type.Object({
   id:Type.String(),task:Type.String({description:'步骤描述，可用 {goal} 占位'}),
   seat:Type.Optional(Type.String({description:'派给哪个席位（按名匹配）'})),
   roleKey:Type.Optional(Type.String({description:'或按角色匹配'})) ,
   dependsOn:Type.Optional(Type.Array(Type.String())),
   groupId:Type.Optional(Type.String({maxLength:64,description:'本步骤所属组：同组步骤共享组通道'})),
   acceptance:Type.Optional(Type.Array(Type.String())),
   seconds:Type.Optional(Type.Integer({minimum:1})),
   requiresHuman:Type.Optional(Type.Boolean()),
  }),{maxItems:40,description:'create 时的计划模板；run 时忽略'}))
 }),async execute(_id,params,_signal,_update,ctx){
  const list=config.workflows||[];
  if(params.action==='list'){
   const data=list.map(workflow=>({id:workflow.id,name:workflow.name,description:workflow.description,...{summary:describeWorkflow(workflow)}}));
   return{content:[{type:'text',text:boundedJson(data)}],details:{workflows:data}};
  }
  if(params.action==='get'){
   const workflow=list.find(item=>item.id===params.id);
   if(!workflow)throw Error('没有这个工作流：'+(params.id||'(未指定)'));
   return{content:[{type:'text',text:renderWorkflow(workflow)}],details:workflow};
  }
  if(params.action==='create'){
   if(!params.name?.trim())throw Error('create 需要 name');
   if(!params.steps?.length)throw Error('create 需要至少一个步骤');
   const workflow:any={
    id:newWorkflowId(),name:params.name.trim(),
    ...(params.description?{description:params.description}:{}),
    // 席位取自当前编制：模板记录的是团队形状，不是它的历史。
    seats:seatsFromAgents(config.agents),
    steps:params.steps,
    createdAt:Date.now(),updatedAt:Date.now(),source:'premier',
   };
   const check=validateWorkflow(workflow);
   if(!check.ok)throw Error('工作流不合法：'+check.errors.join('；'));
   config.workflows=[...list,workflow];save();
   return{content:[{type:'text',text:`已保存工作流「${workflow.name}」（${describeWorkflow(workflow)}）：${workflow.id}`}],details:workflow};
  }
  // run
  const workflow=list.find(item=>item.id===params.id);
  if(!workflow)throw Error('没有这个工作流：'+(params.id||'(未指定)'));
  if(!params.goal?.trim())throw Error('run 需要 goal');
  const instantiated=instantiateWorkflow(workflow,{
   goal:params.goal,defaultModel:ctx.model?.id||'',defaultProvider:ctx.model?.provider,
   locale:councilLocale(process.env.KEPOS_LOCALE),existingAgents:config.agents,
  });
  if(instantiated.ok!==true)throw Error('实例化失败：'+instantiated.errors.join('；'));
  // 席位与计划一起落：先补席位再提交，失败时编制不会停在半个状态。
  if(instantiated.seats.length){config.agents.push(...instantiated.seats);save();refreshSupervisionPrompt();}
  const mission=scheduler.enqueue({...instantiated.mission,cwd:ctx.cwd,parentSessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile()});
  scheduler.start();
  const data={workflow:workflow.id,plan:planSummary(mission),addedSeats:instantiated.seats.map(seat=>seat.name),warnings:instantiated.warnings};
  return{content:[{type:'text',text:boundedJson(data)}],details:data};
 }});
 pi.registerTool({name:'kepos_metrics',label:'运行度量与参数校准',description:'只读指标：重复委派、二次追问、提前完成、Watchdog 误报、记忆质量。每项都给出分子/分母与口径说明；样本不足时明说，不返回 0% 假装健康。metric=calibration 时给出三个硬编码参数的观测分布与建议值（置信度阈值 / 派发频率上限 / 僚属审批线）——只建议，不自动改，因为放宽或收紧哪个更糟取决于你在做什么。',parameters:Type.Object({metric:Type.Optional(Type.String({maxLength:40,description:'duplicate_delegation / second_ask / premature_done / watchdog / memory / calibration；缺省全部五项指标'}))}),async execute(_id,params){
  if(params.metric==='calibration'){
   const items=calibrateAll(db());
   return{content:[{type:'text',text:formatCalibration(items)}],details:{calibration:items} as any};
  }
  const results=collectMetrics(db(),params.metric);
  return{content:[{type:'text',text:formatMetrics(results)}],details:{metrics:results} as any};
 }});
 pi.registerTool({name:'kepos_events',label:'增量任务事件',description:`按 cursor 读取当前父会话或项目的任务状态、工具调用、${SUPERVISION_INTERVAL_SECONDS/60}分钟复核点和完成事件，避免全量轮询。只读。`,parameters:Type.Object({cursor:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:200})),project:Type.Optional(Type.String())}),async execute(_id,params,_signal,_update,ctx){const data=readWorkerEvents(db(),{cursor:params.cursor??0,parentSessionId:ctx.sessionManager.getSessionId(),cwd:params.project||undefined,limit:params.limit??100});return{content:[{type:'text',text:JSON.stringify(data)}],details:data};}});
 pi.registerTool({name:'kepos_history',label:'会话历史代际',description:'只读查询当前会话的 SQLite 历史镜像。默认返回代际目录；提供 generation 可读取指定快照，query 可搜索所有保留消息。不会修改 Pi 上下文或恢复旧执行。',parameters:Type.Object({generation:Type.Optional(Type.Integer({minimum:1})),query:Type.Optional(Type.String({maxLength:200}))}),async execute(_id,params,_signal,_update,ctx){const path=ctx.sessionManager.getSessionFile();const logical=path&&config.sessionLinks[path];if(!logical)return{content:[{type:'text',text:'当前会话尚未建立持久历史映射'}],details:undefined};let data:any=keposSessionStore.generations(logical);if(params.generation||params.query!==undefined){let records=params.generation?keposSessionStore.getGeneration(logical,params.generation):keposSessionStore.getMessages(logical,true);records=records.filter(m=>['user','assistant','toolResult'].includes(m.role)||['compaction','branch_summary'].includes(String(m.metadata.piType)));if(params.query!==undefined)records=records.filter(m=>(JSON.stringify(m.content)??'').toLowerCase().includes(params.query!.toLowerCase()));data=records.slice(-12).map(m=>({uid:m.messageUid,role:m.role,content:m.content,archived:m.archived}));}return{content:[{type:'text',text:boundedJson(data)}],details:{logicalSessionId:logical}};}});
 pi.registerTool({name:'kepos_plan',label:'长程任务计划',description:`建立或监督由只读步骤组成的 DAG 计划。每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核运行步骤；超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟的步骤自动进入人类门禁。默认严格审批：门禁只能由人类批准；代理审批模式下可用 action=approve+jobId 自主批准并留痕。步骤应带 acceptance（1-8 条可验证条目）：完成 ≠ 通过，用 action=check 逐条勾选，未勾满时完成会记为 premature_done。`,parameters:Type.Object({action:Type.Union(['create','list','get','events','pause','cancel','approve','check'].map(x=>Type.Literal(x))),id:Type.Optional(Type.String()),goal:Type.Optional(Type.String()),jobs:Type.Optional(Type.Array(Type.Object({id:Type.String(),agent:Type.String(),task:Type.String(),dependsOn:Type.Optional(Type.Array(Type.String())),seconds:Type.Optional(Type.Integer({minimum:1,maximum:MAX_TASK_SECONDS})),requiresHuman:Type.Optional(Type.Boolean()),acceptance:Type.Optional(Type.Array(Type.Union([Type.String(),Type.Object({check:Type.String(),passes:Type.Optional(Type.Boolean())})]),{description:'1-8 条可在只读前提下验证的验收标准。完成不说完成，逐条拿出证据。',minItems:1,maxItems:8})),groupId:Type.Optional(Type.String({maxLength:64,description:'本步骤所属的工作小组：同组步骤共享组通道，可交换状态与证据，但仍读不到彼此的结论'})),readScope:Type.Optional(Type.Union([Type.Literal('project'),Type.Literal('machine')])),readAllow:Type.Optional(Type.Array(Type.String()))}),{maxItems:100,minItems:1})),jobId:Type.Optional(Type.String()),passed:Type.Optional(Type.Array(Type.Union([Type.String(),Type.Integer({minimum:1})]),{description:'action=check 时勾选的条目：序号（1 起）或条目原文；必须逐条点名'})),cursor:Type.Optional(Type.Integer({minimum:0})),maxChars:Type.Optional(Type.Integer({minimum:200,maximum:6000}))}),async execute(_id,params,_signal,_update,ctx){
  const parent=ctx.sessionManager.getSessionId();let result:any;
  if(params.action==='create'){
   if(!params.goal||!params.jobs?.length)throw Error('创建计划需要 goal 和 jobs');
   const jobs=params.jobs.map(job=>{const agent=config.agents.find(a=>a.id===job.agent||a.name===job.agent);if(!agent)throw Error(`未配置专家「${job.agent}」。现有代表：${config.agents.map(a=>a.name).join('、')||'（空编制）'}`);return{...job,agent:{...agent,...(job.readScope?{readScope:job.readScope}:{}),...(job.readAllow?{readAllow:job.readAllow}:{})}};});
   result=scheduler.enqueue({goal:params.goal,cwd:ctx.cwd,parentSessionId:parent,sessionFile:ctx.sessionManager.getSessionFile(),jobs});scheduler.start();result=planSummary(result);
  }else if(params.action==='list')result=scheduler.list(parent).map(planSummary);
  else if(params.action==='approve'){
   if(currentPolicy()!=='proxy')throw Error('严格审批模式下门禁只能由人类批准；请把待批准步骤和证据汇报给人类，或请人类切换到代理审批（F2 → 审批模式）');
   const plan=params.id&&scheduler.get(params.id,parent);if(!plan)throw Error('当前会话没有该计划');
   if(!params.jobId)throw Error('approve 需要指定 jobId');
   const job=plan.jobs.find(j=>j.id===params.jobId&&j.state==='NEEDS_HUMAN');if(!job)throw Error('该步骤不在人工门禁状态');
   scheduler.approve(plan.id,parent,params.jobId);scheduler.start();
   desk&&desk.urgent(`代理审批留痕 · 模型批准了门禁 ${params.jobId} · ${clean(plan.goal).slice(0,100)}`);scheduleRepaint();
   result={approved:true,...planSummary(scheduler.get(plan.id,parent))};
  }else if(params.action==='check'){
   const plan=params.id&&scheduler.get(params.id,parent);if(!plan)throw Error('当前会话没有该计划');
   if(!params.jobId)throw Error('check 需要指定 jobId');
   const job=plan.jobs.find(j=>j.id===params.jobId);if(!job)throw Error('未知步骤');
   // 勾选只能基于证据：没有产出就没有可对照的东西。
   if(!job.output?.trim())throw Error('该步骤还没有产出，无法勾选验收条目');
   // passed 逐条点名（序号或原文）；空数组不表示"全过"，只表示没勾。
   const {marked,state}=scheduler.checkAcceptance(plan.id,parent,params.jobId,params.passed||[]);
   result={jobId:params.jobId,marked,acceptanceState:state,acceptance:scheduler.get(plan.id,parent)?.jobs.find(j=>j.id===params.jobId)?.acceptance};
   if(!marked)result.note='没有勾选任何条目：passed 需要逐条点名（序号或条目原文），"都完成了"不构成勾选。';
  }
  else{
   const plan=params.id&&scheduler.get(params.id,parent);if(!plan)throw Error('当前会话没有该计划');
   if(params.action==='events')result=scheduler.events(plan.id,parent,params.cursor??0);
   else if(params.action==='pause'){scheduler.pause(plan.id,parent);result=planSummary(scheduler.get(plan.id,parent));}
   else if(params.action==='cancel'){scheduler.cancel(plan.id,parent);result=planSummary(scheduler.get(plan.id,parent));}
   else if(params.jobId){const job=plan.jobs.find(j=>j.id===params.jobId);if(!job)throw Error('未知步骤');result={id:job.id,state:job.state,...(job.acceptance?.length?{acceptance:job.acceptance,acceptanceState:acceptanceState(job.acceptance)}:{}),...(job.acceptance?.some(item=>!item.passes)&&job.state==='SUCCEEDED'?{prematureDone:true,reviewPrompt:acceptanceReviewPrompt(plan.goal,job.acceptance,String(job.output||'').slice(-2000))}:{}),...outputPage(job.output,{cursor:params.cursor,maxChars:params.maxChars})};}
   else result={...planSummary(plan),acceptance:scheduler.acceptanceProgress(plan.id,parent)};
  }
  return{content:[{type:'text',text:boundedJson(result)}],details:undefined};
 }});
 pi.registerTool({name:'kepos_profiles',label:'查看专家配置',description:'按需读取 Council 代表配置。无参数返回短索引；指定 agent 返回完整职责、角色和 Skill。配置修改不影响已分派快照。',parameters:Type.Object({agent:Type.Optional(Type.String())}),async execute(_id,params){const list=params.agent?config.agents.filter(a=>a.id===params.agent||a.name===params.agent):config.agents;const data=list.map(a=>({id:a.id,name:a.name,roleKey:a.roleKey,provider:a.provider,model:a.model,revision:agentRevision(a),...(agentRisk(pool.tasks,a.name)?{risk:agentRisk(pool.tasks,a.name)}:{}),...(params.agent?{role:a.role,tools:a.tools??READ_ONLY_TOOLS,skills:a.skills??[]}:{} )}));return{content:[{type:'text',text:boundedJson(data)}],details:undefined};}});
 pi.registerTool({name:'kepos_tasks',label:'查看当前会话子任务',description:'返回任务短状态。taskId 指定结果，cursor/maxChars 分页读取证据，默认仅1600字符预览。',parameters:Type.Object({taskId:Type.Optional(Type.String()),cursor:Type.Optional(Type.Integer({minimum:0})),maxChars:Type.Optional(Type.Integer({minimum:200,maximum:6000}))}),async execute(_id,params,_signal,_update,ctx){
  const parent=ctx.sessionManager.getSessionId();const tasks=pool.tasks.filter(t=>t.cwd===ctx.cwd&&t.parentSessionId===parent);
  if(params.taskId){const task=tasks.find(t=>t.id===params.taskId);if(!task)throw Error('当前会话没有该任务');const data={id:task.id,agent:task.agent,state:task.state,error:task.error,profileRevision:task.profileRevision,outputTruncated:task.outputTruncated,checkpointAt:task.checkpointAt,stalled:task.stalled||undefined,mcpServers:task.mcpServers,budgetTokens:task.budgetTokens,...outputPage(task.output,{cursor:params.cursor,maxChars:params.maxChars})};return{content:[{type:'text',text:JSON.stringify(data)}],details:data};}
  const data=tasks.slice(-12).map(t=>({id:t.id,agent:t.agent,state:t.state,task:t.title.slice(0,200),tool:t.tool||null}));return{content:[{type:'text',text:JSON.stringify(data)}],details:undefined};
 }});
 pi.registerTool({name:'kepos_models',label:'模型目录与批量换模',description:'列出可用模型（标注官方/中转来源）；或按模糊名称批量更换代表的模型。匹配规则：对模型 id、名称、供应商做大小写不敏感子串匹配；唯一命中自动应用，多个命中返回候选让你确认，无命中明确报错。只影响后续新派发，不触碰运行中任务。',parameters:Type.Object({action:Type.Union(['list','apply'].map(x=>Type.Literal(x))),query:Type.Optional(Type.String({description:'模糊匹配片段，如 relay 名、glm、claude'})),targets:Type.Optional(Type.Union([Type.Literal('all'),Type.Array(Type.String({description:'代表名或 ID'}))],{description:'要更换的代表：all=全部；缺省=仅列出候选'})),model:Type.Optional(Type.String({description:'apply 时的目标模型 id；须在候选中唯一'}))}),async execute(_id,params,_signal,_update,ctx){
  const available=await ctx.modelRegistry.getAvailable();
  const needle=String(params.query||'').trim().toLowerCase();
  const matches=needle?available.filter((m:any)=>[m.id,m.name,m.provider].some(field=>String(field||'').toLowerCase().includes(needle))):available;
  if(params.action==='list'||params.targets===undefined&&params.model===undefined){
   const text=matches.length?matches.map((m:any)=>`${m.provider} / ${m.id}${m.name&&m.name!==m.id?` (${m.name})`:''}`).join('\n'):'无匹配模型。';
   return{content:[{type:'text',text:text||'（空）'}],details:{count:matches.length}};
  }
  if(params.action==='apply'){
   if(!params.model)throw Error('apply 需要 model（目标模型 id）');
   const exact=available.find((m:any)=>m.id===params.model||`${m.provider}/${m.id}`===params.model);
   if(!exact)throw Error(`可用模型中没有 "${params.model}"；先用 action=list 查看可用模型。`);
   // 目标集合：all / 按名或 ID
   const wanted=params.targets==='all'||params.targets===undefined||Array.isArray(params.targets)&&!params.targets.length
    ?config.agents.slice()
    :(Array.isArray(params.targets)?params.targets:[params.targets]).map((name:string)=>config.agents.find(a=>a.id===name||a.name===name)).filter(Boolean);
   if(!wanted.length)throw Error('没有匹配的代表可更换。');
   const before=wanted.map(a=>({name:a.name,from:`${a.provider}/${a.model}`}));
   for(const agent of wanted){agent.provider=exact.provider;agent.model=exact.id;}
   save();refreshSupervisionPrompt?.();
   return{content:[{type:'text',text:`已为 ${wanted.length} 位代表更换模型 → ${exact.provider}/${exact.id}：\n${before.map(b=>'· '+b.name+'：'+b.from).join('\n')}\n新分派生效；运行中任务不变。`}],details:{changed:wanted.length,model:`${exact.provider}/${exact.id}`}};
  }
  throw Error('Unknown action');
 }});
 pi.registerTool({name:'kepos_delegate',label:'分派僚属',description:`主 Agent 以 Council 角色分派 1–${MAX_CONCURRENT_CHILDREN} 个具体、只读的授权事项。默认时长 ${DEFAULT_TASK_SECONDS/60} 分钟；每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核。僚属 可使用 copyOf 复制一个正在运行任务的最小子任务，但只能一层，时限最多为父任务的一半。超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟必须改用 kepos_plan 并等待人类批准。`,parameters:Type.Object({tasks:Type.Array(Type.Object({agent:Type.Optional(Type.String({description:'已配置代表名称或 ID'})),roleKey:Type.Optional(Type.String({description:'Council 角色 key，例如 auditor、surveyor、verifier'})),name:Type.Optional(Type.String({description:'本次代表显示名称；中文请求用中文，英文请求用英文'})),role:Type.Optional(Type.String({description:'覆盖角色提示词；优先使用 roleKey 的标准职责'})),model:Type.Optional(Type.String({description:'本次任务模型 ID'})),provider:Type.Optional(Type.String({description:'本次任务 provider'})),tools:Type.Optional(Type.Array(Type.String({description:'只读工具名：read/grep/find/ls'}))),task:Type.String({description:'小而具体的授权事项与验收要求'}),copyOf:Type.Optional(Type.String({description:'正在运行的父任务 ID；复制委派只能一层，时间上限为父任务的一半'})),skills:Type.Optional(Type.Array(Type.String({description:'已安装且明确批准的 Skill 名称'}))),readScope:Type.Optional(Type.Union([Type.Literal('project'),Type.Literal('machine')],{description:'读取范围：project 只读任务目录（默认，可用 readAllow 加白名单）；machine 除 Kepos 数据和凭据位置外都可读。保密任务用 project。'})),readAllow:Type.Optional(Type.Array(Type.String({description:'额外允许读取的绝对目录（readScope=project 时生效）'}))),budgetTokens:Type.Optional(Type.Integer({minimum:1000,description:'本任务 token 预算上限；到达即停止消耗并呈报人类'})),mcp:Type.Optional(Type.Union([Type.Boolean(),Type.Array(Type.String({description:'服务器名'}))],{description:'临时 MCP 授权（任务结束即收回）：true=授予全部已配置服务器；数组=仅列出的服务器。只能授予人类已在 mcp.json 配置的服务器'})),groupId:Type.Optional(Type.String({maxLength:64,description:'临时工作小组标识：同组代表在环图上归入同一圈层，共享组通道，可交换状态与证据，但仍读不到彼此的结论与归档正文——结论必须各自独立形成。不传则各自独立'})),seconds:Type.Optional(Type.Integer({minimum:1,maximum:MAX_TASK_SECONDS}))}),{minItems:1,maxItems:MAX_CONCURRENT_CHILDREN}),background:Type.Optional(Type.Boolean({description:'true：立即返回 Worker Handle，使用 kepos_worker 查询/等待/取消；false：等待全部完成'}))}),async execute(_id,params,signal,onUpdate,ctx){
  if(signal?.aborted)throw Error('Task cancelled');
  if(!params.tasks.length)throw Error('任务列表为空');
  const {paths,names}=skillIndex();
  const requestedSkills=params.tasks.flatMap((task:any)=>task.skills||[]);
  const unknown=requestedSkills.filter((skill:string)=>!names.has(skill)&&!names.has('skill:'+skill));
  if(unknown.length)return{content:[{type:'text',text:'这些 Skill 尚未安装或未被信任：'+unknown.join(', ')+'。请先向人类说明用途、来源和所需权限，由人类决定安装/信任后再重试；本批任务未启动任何僚属。'}],isError:true,details:{approval:'human_required',unknownSkills:unknown}};
  // MCP grants are validated per task in resolveDelegateJob against the human's mcp.json.
  const jobs=await Promise.all(params.tasks.map(async(task:any)=>resolveDelegateJob(task,ctx,paths,names)));
  const parent=ctx.sessionManager.getSessionId();
  for(const job of jobs){if(!job.copyOf)continue;const parentTask=pool.tasks.find(task=>task.id===job.copyOf&&task.parentSessionId===parent);if(!parentTask||terminalStates.has(parentTask.status))throw Error('copyOf 必须指向当前会话中正在运行的父任务');if((parentTask.delegationDepth||0)>=1)throw Error('复制委派最多一层，僚属 不能继续递归复制');const half=Math.max(1,Math.floor(parentTask.limit/2));if(job.seconds===undefined)job.seconds=half;if(job.seconds>half)throw Error(`复制任务时限不能超过父任务的一半（${half} 秒）`);job.delegationDepth=1;job.parentWorkerId=parentTask.id;}
  if(params.background){const handles:any[]=[];try{for(const job of jobs)handles.push(pool.launch(job.crew,job.task,ctx.cwd,ctx.sessionManager.getSessionFile()||'',job.seconds??DEFAULT_TASK_SECONDS,undefined,parent,job.tools,job.skills,false,job.delegationDepth||0,job.parentWorkerId,job.budgetTokens,{groupId:job.groupId,cliGrants:activeCliGrants(),memoryInjected:job.memoryInjected}));}catch(error){for(const handle of handles)pool.cancelHandle(handle,parent);throw Error('本批任务已回滚，已启动的子任务一并取消：'+clean(error));}return{content:[{type:'text',text:JSON.stringify({state:'accepted',handles})}],details:{handles}};}
  const results=await Promise.all(jobs.map(async job=>{onUpdate?.({content:[{type:'text',text:`启动 ${job.crew.name}：${job.task}`}],details:undefined});return pool.run(job.crew,job.task,ctx.cwd,ctx.sessionManager.getSessionFile()||'',job.seconds??DEFAULT_TASK_SECONDS,signal,parent,job.tools,job.skills,job.mcp,job.delegationDepth||0,job.parentWorkerId,job.budgetTokens,{groupId:job.groupId,cliGrants:activeCliGrants(),memoryInjected:job.memoryInjected});}));
  const perTask=Math.min(1600,Math.floor(8000/Math.max(1,results.length)));
  const data=results.map(task=>({id:task.id,agent:task.agent,state:task.state,error:task.error,elapsedMs:(task.ended||Date.now())-task.started,profileRevision:task.profileRevision,outputTruncated:task.outputTruncated,...outputPage(task.output,{maxChars:perTask})}));
  return{content:[{type:'text',text:JSON.stringify({tasks:data,more:'Use kepos_tasks taskId/cursor for evidence pages; excerpts are not verified conclusions.'})}],isError:results.every(task=>task.status!=='完成'),usage:results.reduce((sum,task)=>mergeUsage(sum,task.usage),undefined),details:{partialFailure:results.some(task=>task.status!=='完成'),tasks:data}};
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
  const options=roleOptions(locale);const labels=options.map(option=>option.label);
  const aiLabel=locale==='en'?'AI 生成职责 · 输入目标自动起草':'AI 生成职责 · 输入目标自动起草';
  const customLabel=locale==='en'?'Custom role · manual input':'自定义职责 · 手动输入';
  const initialRole=old?.roleKey&&councilRole(old.roleKey)?.key||options[0]?.key;
  let skills=old?.skills;let aiSkills=false;
  const rolePick=await ctx.ui.select('选择 Council 代表角色',[aiLabel,customLabel,...labels]);if(!rolePick)return;
  let roleKey: CouncilRoleKey|undefined;
  let roleText=old?.role||'独立只读调查；返回可复核证据，不修改文件。';
  const editorTitle=`职责指令（只读，默认 ${DEFAULT_TASK_SECONDS/60} 分钟；每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核）`;
  if(rolePick===aiLabel){
   // 三步：GitHub 找同类 Skill 学习 → 主 Agent 结合已装目录起草 → 人类定稿。
   const idea=await ctx.ui.input('描述这位代表的目标/想法','如：盯住项目风险，每天汇总成清单');
   if(!idea?.trim())return;
   // 本地优先：先匹配已安装 Skill；本地无命中才联网（skills.sh）查找下载并绑定。
   const {catalog}=skillIndex();
   const localHits=matchLocalSkills(idea.trim(),catalog);
   let learn='';const installedNow:string[]=[];
   if(localHits.length){
    skills=localHits;aiSkills=true;
    ctx.ui.notify('命中本地 Skill：'+localHits.join('、')+'（无需联网）');
    learn=`本地已命中的 Skill（职责指令应安排这些 Skill 的使用时机与边界）：${localHits.join('、')}。`;
   } else {
    ctx.ui.notify('本地无匹配，正在检索 skills.sh 并起草职责…（一次模型调用，约 1-2 分钟）');
    const agentDir=process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent');
    const found=await skillsShSearch(idea.trim(),3).catch(()=>[]);
    if(!found.length){
     // skills.sh 无匹配时退回 GitHub 仓库检索，只取方法论作为起草参考。
     try{
      const search=await fetch('https://api.github.com/search/repositories?q='+encodeURIComponent(idea.trim().slice(0,60))+'+skill&sort=stars&per_page=3',{headers:{'user-agent':'kepos'},signal:AbortSignal.timeout(8000)}).then((r:any)=>r.json());
      for(const repo of ((search?.items||[]) as any[]).slice(0,3)){
       const readme=await fetch('https://api.github.com/repos/'+repo.full_name+'/readme',{headers:{'user-agent':'kepos',accept:'application/vnd.github.raw'},signal:AbortSignal.timeout(8000)}).then((r:any)=>r.text()).catch(()=>'');
       found.push({id:repo.full_name,source:repo.full_name,skillId:'',installs:repo.stargazers_count||0,md:String(readme||'').replace(/\s+/g,' ').slice(0,1100)});
      }
     }catch{}
    }
    for(const item of found){
     if(!item.md)continue;
     learn+=`\nSkill ${item.id}（热度 ${item.installs}）：\n${item.md.replace(/\s+/g,' ').slice(0,1100)}\n`;
    }
    const top=found.find(item=>item.skillId&&item.md);
    if(top&&await ctx.ui.confirm('发现匹配的 Skill',`\`${top.id}\`（热度 ${top.installs}）。\n安装到本地 skills 目录，供这位代表（以及所有代表）直接引用？`)){
     try{
      installSkill(top,agentDir);
      installedNow.push(top.skillId);
      ctx.ui.notify(`已安装 Skill ${top.skillId}（重启后对所有代表生效）`);
     }catch(error){ctx.ui.notify('安装失败：'+clean(error),'warning');}
    }
   }
   if(!learn)learn='（无检索结果，仅依据已安装 Skill 目录起草）';
   try{
    const installedList=catalog.slice(0,40).map(skill=>`${skill.name}：${String(skill.description||'').slice(0,80)}`).join('\n')||'（无已安装 Skill）';
    const installedNowNote=installedNow.length?`\n本次已安装（skills 可直接引用）：${installedNow.join(', ')}`:'';
    const localNote=localHits.length?`\n本地已命中的 Skill（skills 字段优先引用它们）：${localHits.join(', ')}`:'';
    const generator={id:'config-generator',name:'配置生成器',model:ctx.model?.id||'',provider:ctx.model?.provider||'',role:'Kepos 代表配置生成助手',tools:['read']};
    const instruction=`根据人类目标，为一位 Kepos 只读代表生成配置（JSON）。\n\n人类目标：${idea.trim()}\n${localNote}\n已安装 Skill 目录（skills 字段只能从这里选，0-3 个）：\n${installedList}${installedNowNote}\n${learn?`\n检索到的同类 Skill 原文（学习其方法论；对应 Skill 未安装时，把方法要点写进 role 正文，并在 role 末尾加一行"可参考：来源链接"）：${learn}\n`:''}\n输出要求：只输出一个 JSON 对象，格式：\n{"role":"职责指令正文，300 字内：只读边界、证据优先、复核节奏、交付物；若引用了 Skill，写明何时用哪个","skills":["已安装 Skill 名"]}`;
    const task=await pool.run(generator,instruction,ctx.cwd,ctx.sessionManager.getSessionFile()||'',180,undefined,ctx.sessionManager.getSessionId(),['read']);
    const cleaned=String(task.output||'').replace(/```(?:json)?/g,'').trim();
    const parsed=JSON.parse(cleaned.slice(cleaned.indexOf('{'),cleaned.lastIndexOf('}')+1));
    if(typeof parsed.role==='string'&&parsed.role.trim())roleText=parsed.role.trim();
    const {names}=skillIndex();
    const allowed=new Set([...names,...installedNow]);
    const referenced=(Array.isArray(parsed.skills)?parsed.skills:[]).map((s:string)=>String(s)).filter((s:string)=>allowed.has(s)||allowed.has('skill:'+s));
    if(referenced.length){skills=referenced;aiSkills=true;ctx.ui.notify('已引用 Skill：'+referenced.join('、'));}
   }catch(error){ctx.ui.notify('生成失败，请改用下方自定义职责手动填写：'+clean(error),'warning');}
   const edited=await ctx.ui.editor(`职责指令（AI 已起草，可修改。${editorTitle}）`,roleText);
   if(!edited?.trim())return;roleText=edited;
  } else if(rolePick===customLabel){
   const edited=await ctx.ui.editor(editorTitle,roleText);
   if(!edited?.trim())return;roleText=edited;
  } else {
   const selected=options[labels.indexOf(rolePick)];roleKey=(selected?.key||initialRole) as CouncilRoleKey|undefined;
   const definition=roleKey&&councilRole(roleKey);
   const edited=await ctx.ui.editor(editorTitle,definition?rolePrompt(definition,locale):roleText);
   if(!edited?.trim())return;roleText=edited;
  }
  const role=roleText;
 if(config.agents.some(a=>a.id!==old?.id&&a.name===name.trim()))throw Error('已有同名 Agent，请使用不同名称。');
 let tools=old?.tools;
 if(old){const presets=[{label:'全部只读工具',tools:Array.from(READ_ONLY_TOOLS)},{label:'仅读取文件',tools:['read']},{label:'不使用工具',tools:[]}];
 const existing=JSON.stringify([...(tools??READ_ONLY_TOOLS)].sort());presets.sort((a,b)=>Number(JSON.stringify([...b.tools].sort())===existing)-Number(JSON.stringify([...a.tools].sort())===existing));
 const pick=await ctx.ui.select('专家只读工具范围',presets.map(p=>p.label));if(!pick)return;tools=presets.find(p=>p.label===pick)!.tools;}
 // 成员级默认：读取范围与 MCP 临时授权清单（分派时可被 task 覆盖）。
 const scopePick=await ctx.ui.select('读取范围（readScope）',['跟随分派（默认 project）','project · 仅任务目录','machine · 除敏感位置外可读']);if(scopePick===undefined)return;
 const memberScope=scopePick.startsWith('project')?'project':scopePick.startsWith('machine')?'machine':undefined;
 let memberMcp:string[]|undefined;
 if(old){skillIndex();
  const mcpInput=await ctx.ui.input('默认授权的 MCP 服务器（逗号分隔；须已在 mcp.json 配置；留空=不授权）',(old.mcpServers??[]).join(','));
  if(mcpInput===undefined)return;
  const requestedMcp=mcpInput.split(/[,，]/).map(s=>s.trim()).filter(Boolean);
  if(requestedMcp.length){
   const configured=configuredMcpServers(process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent'),ctx.cwd);
   const unknownMcp=requestedMcp.filter(s=>!configured.includes(s));
   if(unknownMcp.length)throw Error('这些 MCP 服务器未配置：'+unknownMcp.join(', ')+'（已配置：'+configured.join(', ')||'无'+'）');
   memberMcp=requestedMcp;
  }
 }
 if(old&&!aiSkills){
  const {names}=skillIndex();
  const input=await ctx.ui.input('已装 Skill（逗号分隔；留空保留现有）',(old.skills??[]).join(','));
  if(input===undefined)return;
  const requested=input.split(/[,，]/).map(s=>s.trim()).filter(Boolean);
  if(requested.length){
   const unknown=requested.filter(s=>!names.has(s)&&!names.has('skill:'+s));
   if(unknown.length)throw Error('这些 Skill 尚未安装或未被信任：'+unknown.join(', '));
   skills=requested;
  }
 }
 const value:Crew={id:old?.id||randomUUID(),name:clean(name.trim()),provider:model.provider,model:model.id,roleKey,role:role.trim(),...(tools?{tools}:{}),...(skills?.length?{skills}:{}),...(memberScope?{readScope:memberScope}:{}),...(memberMcp?.length?{mcpServers:memberMcp}:{})};if(old)Object.assign(old,value);else config.agents.push(value);save();}
  async function delegateForm(ctx:any){if(!config.agents.length){await crewForm(ctx);return;}const pick=await ctx.ui.select(`分派只读任务 · 默认 ${DEFAULT_TASK_SECONDS/60} 分钟 · 最多 ${MAX_CONCURRENT_CHILDREN} 项`,config.agents.map(a=>a.name));const crew=config.agents.find(a=>a.name===pick);if(!crew)return;const text=await ctx.ui.editor('具体任务与完成标准','');if(!text?.trim())return;
  if(!await ctx.ui.confirm('启动代表？',`模型：${crew.provider}/${crew.model}\n目录：${ctx.cwd}\n只读工具；会产生模型费用；默认 ${DEFAULT_TASK_SECONDS/60} 分钟，每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟复核。`))return;
 const sourceGeneration=generation;const sourceSession=ctx.sessionManager.getSessionFile()||ctx.sessionManager.getSessionId();
 void pool.run(crew,text.trim(),ctx.cwd,ctx.sessionManager.getSessionFile()||'',300,undefined,ctx.sessionManager.getSessionId()).then(t=>{if(!valid||generation!==sourceGeneration||!current||(current.sessionManager.getSessionFile()||current.sessionManager.getSessionId())!==sourceSession)return;ctx.ui.notify(`${t.agent}：${t.status}。F3 查看产出。`,'info');if(t.status==='完成')pi.sendMessage({customType:'kepos-task-result',content:`僚属「${t.agent}」完成了手动分派的任务。任务：${t.title}\n结果（需主 Agent 验证）：\n${t.outputTruncated?'[产出已截断，保留末尾约 32 KiB]\n':''}${boundedText(t.output,1600)}`,display:true},{triggerTurn:false});}).catch(e=>{if(valid&&generation===sourceGeneration)ctx.ui.notify(clean(e),'error');});}
 const blocked=(ctx:any)=>!ctx.isIdle();
 const sessionDir=(ctx:any)=>ctx.sessionManager.getSessionDir();
 async function reopen(fresh:any){setTimeout(()=>{fresh.sendUserMessage('/kepos',{expandPromptTemplates:true}).catch((e:any)=>fresh.ui.notify(clean(e),'error'));},80);}
 async function workspaceAction(action:any,ctx:ExtensionCommandContext){const ui=ownedUI(ctx,text=>{if(desk){desk.notice=text;scheduleRepaint();}});const local={...ctx,ui} as ExtensionCommandContext;
 if(action.kind==='attach'){
  // /attach：无参时用 Kepos 自己的输入框问路径，有参时直接读。
  // 附件缓存在 Desk 上，随会话保存、发送后清空。
  if(!desk){ui.notify('附件只能在议案中使用','warning');return;}
  await desk.attachCommand(String(action.text||''),async(title:string,placeholder:string)=>{
   const input=await ui.input(title,placeholder);
   return input;
  });
  scheduleRepaint();
  return;
 }
 if(action.kind==='theme'){
  // Kepos 原生主题选择：不必离开议案。列出品牌主题（固定 default/dark/light 顺序）并热切换。
  const choices=themeChoices(ctx);
  if(!choices.length){ui.notify('没有可用主题','warning');return;}
  const currentName=(()=>{try{return ctx.ui.theme?.name;}catch{return undefined;}})();
  // 选项文案用中文简称；主题名通过索引回查，避免文案与主题名耦合。
  const labels:Record<string,string>={'kepos-default':'默认','kepos-dark':'深色','kepos-light':'浅色'};
  const options=choices.map((name:string)=>({label:`${labels[name]||name}${name===currentName?'  · 当前':''}`,name}));
  const picked=await ui.select(`切换主题 · 当前 ${labels[currentName||'']||currentName||'未设置'}`,options.map(option=>option.label));
  if(!picked||picked==='（取消）')return;
  const target=options.find(option=>option.label===picked)?.name;
  if(!target){ui.notify('未识别的主题选项','warning');return;}
  const result=await applyTheme(target,ctx);
  ui.notify(result.ok?`主题已切换为 ${target}（即时生效）`:result.reason||'主题切换失败',result.ok?'info':'warning');
  return;
 }
 if(action.kind==='menu'){
  // F2 两级分组：23 项平铺找不到东西，同类聚拢后一眼定位。
  // 待办计数挂在类目上（有案才显示），进入类目后各项保持原有动作不变。
  const proposals=listProposals(process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent'));
  const pendingEscalations=new BudgetEscalations(db()).pending();
  const groups:[string,[string,string][]][]=[
   ['对话与项目',[['新建项目（选择本地目录）','project'],['在当前项目新建对话','new'],['移除已收录项目','project-remove'],['切换主题','theme']]],
   ['代表与编制',[['添加僚属','crew'],['编辑僚属','editcrew'],['刷新角色提示词','refresh-roles'],['从档案导入代表','profiles-import'],['代表复盘笔记','lessons'],['工作流','workflows'],['推举代理总代','elections'],['直接推选代理总代','deputy'],['跨组借调','secondments']]],
   [`任务与审批${pendingEscalations.length?`（待批 ${pendingEscalations.length}）`:''}`,[['分派只读任务','delegate'],['查看/取消运行中任务','cancel'],['管理长程计划','missions'],['待批僚属派生','subordinate-approvals'],['预算追加审批','budget-escalations']]],
   [`系统与外观${proposals.length?`（技能 ${proposals.length}）`:''}`,[['更换主 Agent 模型','model'],['自动化能力','automation'],['审阅提议技能','skills-review'],['审批模式','approval'],['命令面板','palette']]],
  ];
  const category=await ui.select('Kepos / 操作',[...groups.map(([label])=>label),'返回议案']);
  const found=groups.find(([label])=>label===category);
  if(!found)return;
  const choice=await ui.select('Kepos / '+category,found[1].map(([label])=>label).concat('返回'));
  const picked=found[1].find(([label])=>label===choice);
  if(picked)return workspaceAction({kind:picked[1]},ctx);
  return;}
 // 提议技能审阅：重复到第三次的流程会出现在这里。采纳才写入 skills/，安装前不生效。
 if(action.kind==='skills-review'){
  const agentDir=process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent');
  const proposals=listProposals(agentDir);
  if(!proposals.length){ui.notify('暂无提议技能。同一代表的同一套做法出现在 3 个不同任务里才会提议。','info');return;}
  const nameOf=(item:any)=>`${item.description.slice(0,70)} · ${item.slug}`;
  const pick=await ui.select('提议技能 · 采纳后才会进入代表可引用的 Skill 目录',proposals.map(nameOf));
  const proposal=proposals.find(item=>nameOf(item)===pick);
  if(!proposal)return;
  const steps=proposal.steps.length?proposal.steps.map((step,index)=>`${index+1}. ${step}`).join('\n'):'（未记录步骤）';
  const decision=await ui.select(`${proposal.slug}\n\n${steps}\n\n边界：仅在同类任务中套用；执行前核对路径与命令。`,['采纳并安装','丢弃这份提议','返回']);
  if(decision==='采纳并安装'){
   // 采纳包含两步：把文件移进 skills/，并真的加进代表的 skills[]。
   // 顺序很重要：先确认绑给谁，再移动文件。反过来一旦移动后才发现没有可绑定的代表，
   // 提议已经离开 skills-proposed，人就再也找不到它，而技能实际没人用。
   const owner=config.agents.find(agent=>agent.name===proposal.agent)||config.agents[0];
   if(!owner){ui.notify(`没有可绑定的代表：无法安装 ${proposal.slug}`,'warning');return;}
   try{
    adoptProposal(agentDir,proposal.slug);
    owner.skills=[...new Set([...(owner.skills||[]),proposal.slug])];
    refreshSupervisionPrompt();save();
    ui.notify(`已安装技能 ${proposal.slug} 并加入「${owner.name}」的 skills · 下次派发生效`);
   }catch(error){ui.notify('安装失败：'+clean(error),'warning');}
   return;
  }
  if(decision==='丢弃这份提议'){discardProposal(agentDir,proposal.slug);ui.notify('已丢弃提议 '+proposal.slug);}
  return;
 }
 if(action.kind==='project-remove'){
  if(!config.projects.length){ui.notify('还没有收录任何项目');return;}
  const pick=await ui.select('移除哪个项目？（只移出列表，不删除文件和会话）',config.projects);if(!pick)return;
  if(!await ui.confirm('移除项目？',pick+'\n仅从 Kepos 列表移除；磁盘文件与历史会话保留。'))return;
  config.projects=config.projects.filter(path=>path!==pick);config.folded=config.folded.filter(path=>path!==pick);save();desk?.invalidate();
  ui.notify('已移除：'+pick);return;
 }
 if(action.kind==='palette'){
  const menuEntries:[string,any][]=[['新建项目','project'],['新对话','new'],['移除项目','project-remove'],['添加僚属','crew'],['编辑僚属','editcrew'],['刷新角色提示词','refresh-roles'],['从档案导入代表','profiles-import'],['代表复盘笔记','lessons'],['推举代理总代','elections'],['直接推选代理总代','deputy'],['跨组借调','secondments'],['分派只读任务','delegate'],['查看/取消任务','cancel'],['更换主 Agent 模型','model'],['切换主题','theme'],['管理长程计划','missions'],['工作流','workflows'],['自动化能力','automation'],['审批模式','approval']];
  const commandEntries=(pi.getCommands?.()||[]).filter((command:any)=>!['kepos','kepos'].includes(String(command.name)));
  const entries:string[]=[...menuEntries.map(([label])=>'操作 · '+label),...commandEntries.map((command:any)=>'命令 · /'+command.name+(command.description?' · '+command.description:'')),'会话 · /reload 重载扩展','会话 · /pi 进入 Pi 命令行'];
  const pick=await ui.select('命令面板 · 输入筛选',entries);if(!pick)return;
  if(pick.startsWith('操作 · ')){const label=pick.slice(4);return workspaceAction({kind:menuEntries.find(([labelKey])=>labelKey===label)?.[1]||'menu'},ctx);}
  const name=pick.startsWith('命令 · ')?pick.slice(4).split(/\s/)[0].replace(/^\//,''):pick.startsWith('会话 · /')?pick.slice(7).split(/\s/)[0]:undefined;
  if(name==='reload'){desk?.finish({kind:'reload'});return;}
  if(name==='pi'){desk?.finish({kind:'pi'});return;}
  if(name)return workspaceAction({kind:'dispatch-command',text:'/'+name},ctx);
  return;
 }
 if(action.kind==='approval'){
  const current=currentPolicy();
  const pick=await ui.select('审批模式 · 当前：'+policyLabel[current],APPROVAL_POLICIES.map(p=>policyLabel[p]));if(!pick)return;
  const next=APPROVAL_POLICIES.find(p=>policyLabel[p]===pick)!;
  if(next===current)return;
  config.approvalPolicy=next;save();applyApprovalPolicy();
  ui.notify('审批模式已切换：'+policyLabel[next]);return;
 }
 if(action.kind==='dispatch-command'){const command=action.text.split(/\s/,1)[0];const routes:any={"/kepos-agent":'crew',"/kepos-new":'new',"/kepos-project":'project','/model':'model','/theme':'theme'};if(routes[command])return workspaceAction({kind:routes[command],text:action.text},ctx);if(['/kepos',"/kepos"].includes(command)){ui.notify('已在议案中');return;}if(command==="/kepos-warm"){const crew=config.agents[0];if(!crew)throw Error('先配置成员');await pool.prewarm(crew,ctx.cwd);ui.notify('预热执行器已就绪，未请求模型');return;}action={kind:'native-command',text:action.text};}
 if(action.kind==='native-command'){const command=action.text.split(/\s/,1)[0];if(command==='/login'&&host.login){await host.login(local,action.text.trim().split(/\s+/)[1]);return;}if(command==='/logout'&&host.logout){await host.logout(local,action.text.trim().split(/\s+/)[1]);return;}if(command==='/settings'){return workspaceAction({kind:'menu'},ctx);}if(command==='/compact'){ctx.compact({onComplete:()=>ui.notify('上下文压缩已完成'),onError:error=>ui.notify('压缩失败：'+clean(error))});ui.notify('已请求 Pi 引擎压缩；Kepos 保持当前会话');return;}if(await ui.confirm('高级引擎功能',`${action.text} 暂无 Kepos 原生页面。是否明确离开 Kepos，进入 Pi 原生界面处理？取消则留在这里。`))desk?.finish({kind:'native-exit',text:action.text});return;}
 if(action.kind==='missions'){
  const plans=scheduler.list();if(!plans.length){ui.notify('暂无长程计划；主 Agent 可使用 kepos_plan 创建');return;}
  const labels=plans.map(m=>m.id+' / '+m.state+' / '+m.goal.slice(0,50));
  const selected=await ui.select('长程计划 · 跨项目',labels);const plan=plans[labels.indexOf(selected)];if(!plan)return;
  const choice=await ui.select(plan.goal,['查看步骤树','调整步骤时限','暂停后续派发','继续执行','批准人工门禁','否决门禁（取消计划）','返回']);
  if(choice==='查看步骤树'){await ui.select('步骤依赖树 · '+plan.state,planTree(plan.jobs));return;}
  if(choice==='调整步骤时限'){
   const editable=plan.jobs.filter(j=>['QUEUED','NEEDS_HUMAN'].includes(j.state));if(!editable.length){ui.notify('没有可调整的步骤：已派发或已完成的步骤不能改');return;}
   const rows=editable.map(j=>j.id+' / '+j.seconds+'s / '+j.task.slice(0,50));const pick=await ui.select('选择步骤',rows);const job=editable[rows.indexOf(pick)];if(!job)return;
   const input=await ui.input('新的时限（秒，1-'+MAX_TASK_SECONDS+'）',String(job.seconds));if(!input?.trim())return;
   const seconds=Number(input);if(!Number.isInteger(seconds)||seconds<1||seconds>MAX_TASK_SECONDS){ui.notify('时限必须是整数秒（1-'+MAX_TASK_SECONDS+'）');return;}
   const message=job.requiresHuman?`${job.id}：${job.seconds}s → ${seconds}s。超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟的步骤仍需人工门禁；原有门禁不会被解除，批准后方可执行。`:`${job.id}：${job.seconds}s → ${seconds}s`+(seconds>HUMAN_APPROVAL_THRESHOLD_SECONDS?`（超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟将进入人工门禁）`:'');
   if(!await ui.confirm('确认调整？',message))return;
   scheduler.reschedule(plan.id,plan.parentSessionId,job.id,seconds);ui.notify('步骤已调整；F9 查看');return;
  }
  if(choice==='暂停后续派发'){scheduler.pause(plan.id,plan.parentSessionId);ui.notify('计划已暂停后续派发；F9 查看');return;}
  if(choice==='继续执行'&&await ui.confirm('继续计划？',plan.goal+'\n将使用计划创建时的专家快照，模型调用可能计费。')){scheduler.resume(plan.id,plan.parentSessionId);scheduler.start();ui.notify('计划已继续；F9 查看');return;}
  if(choice==='批准人工门禁'){
   const gates=plan.jobs.filter(j=>j.state==='NEEDS_HUMAN'&&j.requiresHuman);if(!gates.length){ui.notify('没有可批准的门禁；失败步骤需要修订计划');return;}
   const rows=gates.map(j=>j.id+' / '+j.task.slice(0,80));const pick=await ui.select('选择人工门禁',rows);const job=gates[rows.indexOf(pick)];
   if(job&&await ui.confirm('批准并继续这个步骤？',plan.goal+'\n'+job.task+'\n专家：'+job.agent.name+' / '+job.agent.model)){scheduler.approve(plan.id,plan.parentSessionId,job.id);scheduler.start();ui.notify('门禁已批准，步骤继续；F9 查看');}
   return;
  }
  if(choice==='否决门禁（取消计划）'){
   const gates=plan.jobs.filter(j=>j.state==='NEEDS_HUMAN');
   if(!gates.length){ui.notify('当前没有等待审批的门禁；取消整个计划请用主菜单');return;}
   if(await ui.confirm('否决门禁并取消整个计划？',plan.goal+'\n所有未完成步骤将中止，已完成的产出保留。')){scheduler.cancel(plan.id,plan.parentSessionId);ui.notify('计划已否决取消；F9 查看');}
   return;
  }
  if(choice==='取消计划'&&await ui.confirm('取消后续执行并中止活动步骤？',plan.goal)){scheduler.cancel(plan.id,plan.parentSessionId);ui.notify('计划已取消；F9 查看');}
  return;
 }
 if(action.kind==='crew'){await crewForm(local,action.id);ui.notify(`成员配置已更新 · ${config.agents.length} 位成员`);return;}
 // 角色提示词刷新：把内置角色更新到当前版本。
 // 显式动作而非自动——有人会手工改 role 文本，自动覆盖等于抹掉他的编辑。
 if(action.kind==='refresh-roles'){
  const locale=councilLocale(process.env.KEPOS_LOCALE);
  const candidates=config.agents.filter(agent=>{
   const role=agent.roleKey&&councilRole(agent.roleKey);
   // 只处理"文案还是内置版本"的席位：人工改过的（与内置文本不一致）不动。
   return role&&typeof agent.role==='string'&&agent.role.trim();
  });
  if(!candidates.length){ui.notify('没有可刷新的内置角色席位。','info');return;}
  const preview=candidates.slice(0,6).map(agent=>`· ${agent.name}（${agent.roleKey}）`).join('\n');
  const ok=await ui.confirm('刷新角色提示词',
   `${candidates.length} 个席位将改用当前版本的角色说明（含历史记忆、派生僚属、验收纪律）。\n\n${preview}${candidates.length>6?`\n… 另有 ${candidates.length-6} 个`:''}\n\n手工改过职责文本的席位会被一并覆盖。名称、模型、Skill、权限都不变。`);
  if(!ok)return;
  let changed=0;
  for(const agent of candidates){
   const role=councilRole(agent.roleKey);
   if(!role)continue;
   const next=rolePrompt(role,locale);
   if(agent.role===next)continue;
   agent.role=next;changed++;
  }
  if(changed){save();refreshSupervisionPrompt();ui.notify(`已刷新 ${changed} 个席位的角色说明。排队的任务会使用新版本；正在运行的任务保持原快照。`,'info');}
  else ui.notify('所有席位的角色说明都已是最新版本。','info');
  return;
 }
 // 僚属派生超过三名时的审批队列：一个批准只放行一次派生。
 // 单独一个入口而不是塞进自动化菜单——它是具体的待办事项，不是能力开关。
 if(action.kind==='subordinate-approvals'){
  const approvals=new SubordinateApprovals(db());
  const pending=approvals.pending();
  if(!pending.length){ui.notify('没有待批的僚属派生请求。','info');return;}
  const label=(item:any)=>`${item.agent} 已有 ${item.live} 个僚属 · ${clean(item.task).slice(0,70)}`;
  const pick=await ui.select(`待批僚属派生（${pending.length}）`,[...pending.map(label),'返回']);
  const item=pending.find(entry=>label(entry)===pick);
  if(!item)return;
  const decision=await ui.select(`${item.agent} · 已有 ${item.live} 个僚属在跑\n\n${item.task}\n\n再派生一个需要你的批准。`,['批准这一次','拒绝','返回']);
  if(decision==='批准这一次'){
   approvals.decide(item.id,true);
   // 代表下一轮轮询会读到这条批准并立刻派出去。
   ui.notify(`已批准 ${item.agent} 再派生一个僚属；它会在下一轮轮询时派出。`,'info');
  }else if(decision==='拒绝'){
   approvals.decide(item.id,false);
   ui.notify(`已拒绝 ${item.agent} 的派生请求。`,'info');
  }
  return;
 }
 // 预算截停的审批队列（人类的裁定：截停立案、总理呈报、人类批准后按新额度重派）。
 // F2 入口与自动前置通道共用同一对话：批一审一，直到队列清空或按了稍后。
 if(action.kind==='budget-escalations'){
  await runBudgetApprovals(local,false);
  return;
 }
 // 自动化能力：三项独立开关，全部默认关闭。
 // 工作流：席位配方 + 计划模板，与总理的工具共用同一个实例化函数。
 // 从环图上把某个组存成工作流：组内成员变成席位配方，组内任务变成步骤模板。
 // 这是"模板从哪里来"的答案——不是凭空设计，而是把一次真实协作固化成形状。
 if(action.kind==='workflow-from-group'){
  const groupId=String(action.id||'').trim();
  if(!groupId){ui.notify('缺少组标识','warning');return;}
  const members=pool.tasks.filter(task=>task.groupId===groupId);
  if(!members.length){ui.notify(`组 ${groupId} 没有任务，无法生成工作流`,'warning');return;}
  const name=await ui.input('工作流名称',`组 ${groupId} 的做法`);
  if(!name?.trim())return;
  // 席位取自已配置代表：只记录角色与模型，不记录历史。
  const seatAgents=config.agents.filter(agent=>members.some(task=>task.agent===agent.name));
  // 步骤按任务顺序，任务描述沿用原标题；组关系不复用（新实例自带同一个组）。
  // roleKey 从已配置代表取：Task 上没有这个字段，只有 profileSnapshot 里有。
  const steps=members.map((task,index)=>{
   const seat=seatAgents.find(agent=>agent.name===task.agent);
   return {
    id:`step-${index+1}`,
    seat:task.agent,
    ...(seat?.roleKey?{roleKey:seat.roleKey}:{}),
    task:String(task.title||'').slice(0,MAX_STEP_CHARS),
    ...(index>0?{dependsOn:[`step-${index}`]}:{}),
   };
  });
  const workflow:any={
   id:newWorkflowId(),name:name.trim(),
   description:`由组 ${groupId} 的实际协作生成 · ${members.length} 个任务`,
   seats:seatsFromAgents(seatAgents),
   steps,createdAt:Date.now(),updatedAt:Date.now(),source:'human',
  };
  const check=validateWorkflow(workflow);
  if(!check.ok){ui.notify('生成的工作流不合法：'+check.errors.join('；'),'warning');return;}
  config.workflows=[...(config.workflows||[]),workflow];save();
  ui.notify(`已存成工作流「${workflow.name}」· ${describeWorkflow(workflow)}\n它只记录形状，不含这次的证据与结论。`,'info');
  return;
 }
 if(action.kind==='workflows'){
  const list=config.workflows||[];
  if(!list.length){
   // 空列表不弹一个只有"返回"的框：直接说清怎么创建。
   ui.notify('还没有工作流。可以先用「把当前编制存成工作流」把现在的 48 席与步骤存成模板，或让总理用 kepos_workflow create。','info');
   return;
  }
  const label=(item:any)=>`${item.name} · ${describeWorkflow(item)}`;
  const pick=await ui.select(`工作流（${list.length}）`,[...list.map(label),'返回']);
  const workflow=list.find(item=>label(item)===pick);
  if(!workflow)return;
  const detail=renderWorkflow(workflow);
  const decision=await ui.select(detail.slice(0,900),['按此工作流开始','删除这个工作流','返回']);
  if(decision==='按此工作流开始'){
   const goal=await ui.input('本次目标','例如：给登录模块加多因子认证');
   if(!goal?.trim())return;
   const instantiated=instantiateWorkflow(workflow,{
    goal:goal.trim(),defaultModel:ctx.model?.id||'',defaultProvider:ctx.model?.provider,
    locale:councilLocale(process.env.KEPOS_LOCALE),existingAgents:config.agents,
   });
   if(instantiated.ok!==true){ui.notify('实例化失败：'+instantiated.errors.join('；'),'warning');return;}
   if(instantiated.seats.length){config.agents.push(...instantiated.seats);save();refreshSupervisionPrompt();}
   const mission=scheduler.enqueue({...instantiated.mission,cwd:ctx.cwd,parentSessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile()});
   scheduler.start();
   ui.notify(`已按「${workflow.name}」开始 · ${mission.jobs.length} 步${instantiated.seats.length?` · 新增 ${instantiated.seats.length} 席`:''}${instantiated.warnings.length?` · ${instantiated.warnings[0]}`:''}`,'info');
   return;
  }
  if(decision==='删除这个工作流'){
   const ok=await ui.confirm('删除工作流',`「${workflow.name}」将被移除。已经按它启动的计划与代表不受影响。`);
   if(!ok)return;
   config.workflows=list.filter(item=>item.id!==workflow.id);save();
   ui.notify('已删除工作流 '+workflow.name,'info');
  }
  return;
 }
 // 会启动任务的（派发 / 预检）在 automation.ts 里与审批档绑定：
 // 只有代理档才放行，严格与只读档一律停用。这里只负责呈现与切换。
 if(action.kind==='automation'){
  const rules=config.automation?.rules?.length?config.automation.rules:DEFAULT_WATCH_RULES;
  const snapshot=automationSnapshot(currentPolicy(),config.automation);
  const labels=snapshot.map(item=>{
   const mark=item.enabled?(item.allowed?'● 开':'◐ 开（被档位暂停）'):'○ 关';
   return `${mark} ${item.name}：${AUTOMATION_LABEL[item.capability].what}`;
  });
  const choice=await ui.select(`自动化 · 当前 ${policyLabel[currentPolicy()].split('：')[0]} · ${rules.length} 条规则`,[...labels,'查看规则','清除候选记录','返回']);
  const at=labels.indexOf(choice);
  if(at>=0){
   const item=snapshot[at];
   const on=!item.enabled;
   // 关闭永不需确认：让刹车和油门一样难踩是最糟的设计。
   if(on&&isActingCapability(item.capability)){
    const ok=await ui.confirm('确认开启自动化能力',confirmText(item.capability,{rules:rules.length,agents:Math.min(3,config.agents.length),maxPerMinute:AUTO_DISPATCH_PER_MINUTE}));
    if(!ok)return;
   }
   const result=toggleAutomation(config.automation,item.capability,on);
   config.automation=result.settings;
   if(!config.automation.rules?.length)config.automation.rules=rules;
   save();
   const after=automationAllowed(currentPolicy(),config.automation,item.capability);
   const state=on?'已开启':'已关闭';
   ui.notify(after.allowed?`${item.name}：${state}`:`${item.name}：${state} · ${after.reason}`,on&&!after.allowed?'warning':'info');
   return;
  }
  if(choice==='查看规则'){
   // 规则内容是给人读的，用 notify 直接展开；再弹一个只有"返回"的选择框只是多一次按键。
   const lines=rules.map((rule:any)=>`${rule.id} → ${rule.agent||'（未指派）'}\n  ${rule.intent}\n  抓：${[...(rule.extensions||[]),...(rule.pathIncludes||[])].join(' ')||'任意'} · 冷却 ${Math.round((rule.cooldownMs||0)/1000)}s`);
   ui.notify(lines.join('\n\n')||'没有规则；开启观察时会使用默认规则。','info');
   return;
  }
  if(choice==='清除候选记录'){
   const removed=watchCandidates.clear();
   ui.notify(`已清除 ${removed} 条值守候选记录`,'info');
   return;
  }
  return;
 }
 // 档案文件是给人改的接口：改完由人显式导回，冲突当场看得见。
 // 不做"文件变了就自动生效"——那会让一次手滑直接改变正在运行的编制。
 // 复盘笔记：失败任务整理出来的"下次该怎么委派"。
 // 这些记忆会自动注入该代表的下一次派发，所以这里只是让人能看见并手动作废。
 // 跨组借调：只有代理总代能发起，总理静默批准，到期自动收回。
 // 这里同时是"收回"的触发点：过期记录在打开菜单时被清理并告知。
 if(action.kind==='secondments'){
  const reaped=secondmentStore.reapExpired();
  if(reaped.length){
   // 说清"下一轮生效"：借调标记在派发时注入，已经在跑的任务不会立即失去频道。
   // 含糊地说"已收回"会让人以为那个人此刻已经读不到了。
   ui.notify(`已收回 ${reaped.length} 项到期借调：${reaped.map(item=>item.agent).join('、')}\n已在运行的任务仍在旧组里，它们的下一次派发才会退回原组。`,'info');
  }
  const live=secondmentStore.active();
  if(!live.length){ui.notify('当前没有生效中的跨组借调。\n代理总代可以在任务中用 kepos_secondment 发起，请求会静默转呈总理评估。','info');return;}
  const label=(item:any)=>`${item.agent}　组 ${item.fromGroup} → ${item.toGroup}　剩 ${Math.max(0,Math.round((item.expiresAt-Date.now())/60000))} 分钟`;
  const pick=await ui.select(`跨组借调（${live.length} 生效中）`,live.map(label));
  const chosen=live[live.map(label).indexOf(pick)];
  if(!chosen)return;
  if(await ui.confirm('提前归还？',`${chosen.agent}

原因：${chosen.reason}

归还后该代表立即退出组 ${chosen.toGroup} 的通信频道。`)){
   secondmentStore.release(chosen.id);
   ui.notify(`已归还 ${chosen.agent} 到组 ${chosen.fromGroup}`,'info');
  }
  return;
 }
 // 推举呈报：组内推举只是提名，这里是人类批准的地方。
 // 报告带着当时的票数与健康度快照——那些数字过几周就会变，
 // 所以批准时要看的是"当时凭什么"，而不是重新算一遍。
 if(action.kind==='elections'){
  // 组已解散的报告不再列在待批：它没有决定可做，记录仍保留供回溯。
  const pending=electionStore.pending(groupId=>pool.tasks.some(task=>task.groupId===groupId&&task.parentSessionId===ctx.sessionManager.getSessionId()));
  if(!pending.length){ui.notify('没有待批准的推举。组内推举后会自动呈报。','info');return;}
  const label=(record:any)=>`组 ${record.groupId} · ${record.report.ballots} 票 · ${record.report.recommendation.slice(0,60)}`;
  const pick=await ui.select(`推举呈报（${pending.length} 待批）`,pending.map(label));
  const record=pending[pending.map(label).indexOf(pick)];
  if(!record)return;
  const decision=await ui.select(renderElectionReport(record.report),['批准','驳回','返回']);
  if(decision==='批准'){
   // 批准谁：默认按建议，平票时让人点名。
   const recommended=record.report.tied?undefined:record.report.candidates[0]?.name;
   const names=record.report.candidates.map((item:any)=>item.name);
   const chosen=recommended??await ui.select('批准哪位承担协调职责？',names);
   if(!chosen||!names.includes(chosen))return;
   electionStore.approve(record.id,chosen);
   // 批准即推举为代理总代：这是兼任职务，不新增席位、不改该代表的职责与模型。
   const member=config.agents.find(agent=>agent.name===chosen);
   if(member){config.deputyAgentId=member.id;save();refreshSupervisionPrompt();}
   ui.notify(`已推举「${chosen}」为代理总代（兼任，不占席位）`,'info');
   return;
  }
  if(decision==='驳回'){electionStore.reject(record.id);ui.notify('已驳回该推举呈报','info');}
  return;
 }
 if(action.kind==='lessons'){
  const failed=new Set(pool.tasks.filter(task=>['失败','超时','已中断'].includes(String(task.status||''))).map(task=>task.id));
  const rows:any[]=[];
  for(const member of config.agents){
   for(const row of memoryPipeline.list(member.id)){
    if(row.sourceWorkerId&&failed.has(row.sourceWorkerId))rows.push({member:member.name,...row});
   }
  }
  if(!rows.length){ui.notify('暂无复盘笔记：失败或超时的任务结束后会自动整理。','info');return;}
  const label=(row:any)=>`${row.member} · ${new Date(row.validFrom).toLocaleDateString()} · ${row.content.slice(0,80)}`;
  const pick=await ui.select(`代表复盘笔记（${rows.length}）`,rows.map(label));
  const chosen=rows[rows.map(label).indexOf(pick)];
  if(!chosen)return;
  if(await ui.confirm('作废这条笔记？',`${chosen.member}\n\n${chosen.content}\n\n作废后它不会再注入该代表的下一次派发；记录本身保留，可回溯。`)){
   memoryPipeline.invalidate(chosen.id);
   ui.notify('已作废该复盘笔记（记录保留）','info');
  }
  return;
 }
 if(action.kind==='profiles-import'){
  let report:any;
  try{report=importProfiles(config,ctx.cwd);}catch(error){ui.notify(clean(error),'warning');return;}
  refreshSupervisionPrompt();save();
  // 导入之后把文件重新导出一次：手写的简写会被规范化回标准形态。
  // 目标目录由这次操作显式给出——导出不再从 process.cwd() 猜。
  const exported=exportWorkspaceFiles(config,ctx.cwd);
  if(exported.skipped.length)ui.notify('档案导出有跳过项：'+exported.skipped.slice(0,3).join('；'),'warning');
  const lines=[`已导入 ${report.updated.length} 位代表的档案`,...report.updated.map((name:string)=>`· ${name}`)];
  if(report.unknown.length)lines.push(`文件里这些 id 不在配置中，未新建：${report.unknown.join('、')}`);
  if(report.errors.length)lines.push(`有 ${report.errors.length} 个文件没能读取：`,...report.errors.map((item:any)=>`· ${item.file}：${item.error}`));
  if(!report.updated.length&&!report.errors.length)lines.push('没有可导入的变化。');
  ui.notify(lines.join('\n'),report.errors.length?'warning':'info');
  return;
 }
 if(action.kind==='editcrew'){const choice=await ui.select('编辑成员',config.agents.map(a=>a.name));const crew=config.agents.find(a=>a.name===choice);if(crew)await crewForm(local,crew.id);return;}
 if(action.kind==='deputy'){
  // 代理总代是兼任职务：人类从现任代表中推选，不新增席位、不改该代表的职责与模型。
  const current=config.agents.find(agent=>agent.id===config.deputyAgentId);
  const options=['（撤销代理总代）',...config.agents.map(agent=>`${agent.name}${agent.id===config.deputyAgentId?' · 现任':''}`)];
  const pick=await ui.select(`推选代理总代 · 现任 ${current?.name||'无'}\n兼任治理复核：MCP/工具授权审批、批量复核、升级人类`,options);
  if(!pick)return;
  const chosen=config.agents.find(agent=>pick.startsWith(agent.name+' · ')||pick===agent.name);
  if(pick.startsWith('（撤销')){delete config.deputyAgentId;}else if(chosen){config.deputyAgentId=chosen.id;}
  save();ui.notify(chosen?`${chosen.name} 已推选为代理总代（兼任，不占席位）`:'已撤销代理总代');return;
 }
 if(action.kind==='delegate'){await delegateForm(local);return;}
  if(action.kind==='cancel-selected'){const task=pool.tasks.find(item=>item.id===action.id&&item.parentSessionId===ctx.sessionManager.getSessionId());if(!task){ui.notify('该席位当前没有可销毁的子 Worker；等待审批的门禁请用 F2 处理','warning');return;}if(terminalStates.has(task.status)){ui.notify(task.agent+' 的任务已结束（'+task.status+'），无需取消','info');return;}if(await ui.confirm('销毁这个子 Worker？',task.agent+' · '+task.title.slice(0,100))){pool.cancel(task.id);ui.notify('已请求终止 '+task.agent);}return;}
 if(action.kind==='message-agent'){
  // 书案直达：给代表留言。任务在跑就转发进它的会话；已结束就按原配置开新一轮。
  const crew=config.agents.find(a=>a.id===action.id)||config.agents.find(a=>a.name===action.id);
  if(!crew){ui.notify('找不到该代表；可能已被移除或重命名','warning');return;}
  if(desk){desk.editor.setText('');desk.savedDraftBeforeCommand='';}
  const sourceSession=ctx.sessionManager.getSessionFile()||ctx.sessionManager.getSessionId();
  void pool.run(crew,action.text,ctx.cwd,sourceSession,DEFAULT_TASK_SECONDS,undefined,ctx.sessionManager.getSessionId()).then(t=>{ui.notify(`${t.agent}：${t.status}。F10 书案查看产出`,'info');}).catch(error=>{ui.notify('派发失败：'+clean(error),'error');if(desk){desk.editor.setText(action.text);desk.savedDraftBeforeCommand=action.text;}});
  ui.notify(`正在唤醒 ${crew.name}（${crew.model}）…`);return;
 }
 if(action.kind==='cancel'){const tasks=pool.tasks.filter(t=>t.parentSessionId===ctx.sessionManager.getSessionId()&&!terminalStates.has(t.status));if(!tasks.length){ui.notify('当前会话没有运行中的子任务');return;}const labels=tasks.map(t=>t.agent+' / '+t.id);const selected=await ui.select('中止子任务',labels);const task=tasks[labels.indexOf(selected)];if(task&&await ui.confirm('中止任务？',task.title))pool.cancel(task.id);return;}
 if(action.kind==='model'){if(blocked(ctx))throw Error('请等待当前任务结束再切换模型');const list=await models(ctx);const currentModel=ctx.model?.id&&ctx.model.id!=='unknown'?`${ctx.model?.provider||'—'} / ${ctx.model.id}`:'尚未登录';
  const relays=readRelays(process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent'));
  const origin=(providerId:any)=>{const pid=String(providerId||'');return pid.startsWith('relay_')?`中转 · ${relays[pid]?.name||pid.slice(6)}`:'官方';};
  const rowWidth=Math.max(40,(process.stdout.columns||110)-4);
  const rowOf=(m:any)=>{const label=`${m.provider} / ${m.id}`;const tag=` · ${origin(m.provider)}`;return fit(label,Math.max(20,rowWidth-visibleWidth(tag)))+tag;};
  const selected=await ui.select(`更换主 Agent 模型 · 当前 ${currentModel}`,list.map(rowOf));
  const model=list.find((m:any)=>rowOf(m)===selected);
  if(model){if(!await pi.setModel(model))throw Error('模型认证不可用');config.mainModel={provider:String(model.provider||''),id:String(model.id||'')};save();ui.notify('模型已切换：'+model.provider+' / '+model.id+'（已记住，重启后沿用）');}return;}
 if(action.kind==='project'){const input=await ui.input('新项目 / 本地绝对目录','文件夹必须已存在');if(!input?.trim())return;const path=projectPath(input);if(!config.projects.includes(path))config.projects.push(path);save();if(!await ui.confirm('项目已收录','是否进入此项目并新建对话？'))return;action={kind:'new',path};}
 if(action.kind==='new'){if(blocked(ctx))throw Error('请等待任务结束再新建会话');const title=await ui.input('新对话名称','输入会话名称');if(!title?.trim())return;desk?.finish({kind:'switch',path:createLinkedSession(ctx,action.path||ctx.cwd,title.trim())});return;}
 }
 async function runDesk(ctx:ExtensionCommandContext){if(ctx.mode!=='tui'){ctx.ui.notify('此命令需要交互终端。','warning');return;}if(desk){ctx.ui.notify('议案已经打开。','info');return;}
 const loadSessions=async()=>{const [all,local]=await Promise.all([SessionManager.listAll(),SessionManager.listAll(ctx.sessionManager.getSessionDir())]);return [...new Map([...all,...local].map(s=>[s.path,s])).values()];};
 // Prepare the first desk while the splash is visible, avoiding a loading gap between overlays.
 let firstSessions:any[]|undefined;let initialError:unknown;let initialFailed=false;
 const ready=loadSessions().then(sessions=>{firstSessions=sessions;},error=>{initialFailed=true;initialError=error;});
 try{await playSplash(ctx,config,ready);}catch{}
 await ready;if(initialFailed){ctx.ui.notify(clean(initialError),'error');return;}
 while(true){let sessions:any[];try{sessions=firstSessions??await loadSessions();firstSessions=undefined;}catch(e){ctx.ui.notify(clean(e),'error');return;}
 let action:any;try{action=await ctx.ui.custom<any>((tui,theme,_keys,done)=>{let modalBusy=false;desk=new Desk(tui,theme,ctx,config,sessions,pool,(text,images,options)=>pi.sendUserMessage(images&&images.length?[{type:"text",text},...images]:text,{expandPromptTemplates:true,...options}),done,pi.getCommands(),undefined,async action=>{if(modalBusy)return;modalBusy=true;try{await workspaceAction(action,ctx);}finally{modalBusy=false;desk?.invalidate();desk?.refresh();}});if(reloadNotice){desk.notice=reloadNotice;reloadNotice='';}desk.approvalPolicy=()=>currentPolicy();desk.monitor={tasks:()=>taskSummaries(db()),evidence:(id:string)=>taskEvidence(db(),id),plans:()=>planSummaries(db()),watchdog:(id:string)=>watchdogStore.list(id,3),watch:()=>watchCandidates.recent(20)};
  // 代表派生请求：代表进程写文件，这里轮询接手。僚属由代表发起、代表负责，
  // 但实际 spawn 必须在本进程执行——子进程没有创建同级进程的能力。
  spawnPoller=new SpawnRequestPoller({
   // 跨组借调：代理总代发起 → 总理评估 → 批准后生效。
   // 这一步**静默进行**，不经人类：借调不扩权（被借调者保持原有工具、模型与只读边界），
   // 只是临时进入另一个组的通信频道，到期自动收回。
   onSecondment:async(taskId,request)=>{
    try{
     const deputy=config.agents.find(agent=>agent.id===config.deputyAgentId);
     const applicant=pool.tasks.find(task=>task.id===taskId);
     // 只有代理总代能发起：普通代表跨组拉人会绕开治理链。
     const permission=canRequestSecondment({requesterAgent:applicant?.agent,deputyAgent:deputy?.name});
     if(permission.allowed!==true)return{ok:false,reason:permission.reason};
     const target=config.agents.find(agent=>agent.id===request.agent||agent.name===request.agent);
     if(!target)return{ok:false,reason:'找不到被借调的代表'};
     // 目标组必须是发起者自己所在的组：代表自己填的 toGroup 不能凭空造一个组，
     // 否则借调会把一个人塞进一个没有主人、也没有通道的组。
     const applicantGroup=String(applicant.groupId||'').trim();
     if(!applicantGroup||request.toGroup!==applicantGroup)return{ok:false,reason:`目标组必须是发起者所在的组（${applicantGroup||'未在组中'}）`};
     const existing=secondmentStore.active();
     const check=validateSecondment({agentId:target.id,fromGroup:request.fromGroup,toGroup:request.toGroup,reason:request.reason,existing});
     if(check.ok!==true)return{ok:false,reason:(check as {reason:string}).reason};
     // 总理评估：条件都是确定的（组不同、未重复、未超上限、有原因），所以不需要模型调用。
     // 但评估结论要留下完整依据——只在通知栏闪一行，事后无从判断当初批了什么。
     const summary=describeSecondmentRequest({agent:target.name,fromGroup:request.fromGroup,toGroup:request.toGroup,reason:request.reason,requestedBy:deputy.name});
     try{briefingStore.record({target:'premier',targetName:deputy.name,text:summary,delivery:'queued',note:'跨组借调（静默批准，无需人类）'});}catch{}
     const record=createSecondment({agentId:target.id,agent:target.name,fromGroup:request.fromGroup,toGroup:request.toGroup,reason:request.reason,requestedBy:deputy.name});
     secondmentStore.add(record);
     if(desk){desk.notice=`跨组借调已批准 · ${target.name}：组 ${request.fromGroup} → ${request.toGroup} · ${Math.round(SECONDMENT_SECONDS/60)} 分钟后自动收回`;scheduleRepaint();}
     return{ok:true};
    }catch(error){return{ok:false,reason:clean(error)};}
   },
   onSpawn:async(taskId,request)=>{
   try{
    const rep=pool.tasks.find(t=>t.id===taskId);
    if(!rep)return{ok:false,reason:'找不到发起请求的代表任务'};
    // 派生门槛：硬上限、以及"同时超过三名需要人类审批"。
    // 这条必须在真正开进程之前判定——批不批是人的决定，不是代表的。
    const decision=decideSpawn(db(),taskId,{agent:rep.agent,task:request.task});
    if(decision.action==='refuse')return{ok:false,reason:decision.reason};
    if(decision.action==='approve'){
     // 不派，但要让人类看得见：走紧急通道并进 F2 待批列表。
     if(desk){desk.urgent(`僚属派生待批 · ${rep.agent} · ${clean(request.task).slice(0,80)}`);scheduleRepaint();}
     if(process.stdout.isTTY)process.stdout.write('\x07');
     return{ok:false,reason:'已提交人类审批：'+decision.reason};
    }
    const crew=config.agents.find(a=>a.name===rep.agent)||{id:rep.agentId,name:rep.agent,model:rep.model,provider:rep.provider,role:rep.role||'代表'};
    const seconds=Math.max(1,Math.min(request.seconds??Math.floor(rep.limit/2),Math.floor((rep.limit-(Date.now()-rep.started)/1000)/2)));
    pool.launch(crew,request.task,rep.cwd,rep.session,seconds,undefined,rep.parentSessionId,Array.from(READ_ONLY_TOOLS),request.skills||[],false,1,rep.id,request.budgetTokens,{});
    // 批准在成功派生之后才消费：launch 失败（预算、槽位）不该吞掉人类的批准，
    // 否则人批了一次、任务却没跑，还得再批第二次。
    if(decision.approvalId)new SubordinateApprovals(db()).consume(decision.approvalId);
    return{ok:true};
   }catch(error){return{ok:false,reason:clean(error)};}
  }});
  spawnPoller.start(()=>pool.tasks.filter(t=>!terminalStates.has(t.status||'')).map(t=>t.id),ctx.cwd);
  // 事件驱动值守：M1 只记录候选，M2 在 proxy 档 + 语义评估通过时才自动派发。
  // 关闭是默认——监听器在没人看的时候自己开任务，是这一层最危险的可能。
  // 观察是派发的前提：只开派发而不开观察，监听器根本不会启动。
  if(config.automation?.observe===true){
   const {usable}=validRules(config.automation.rules?.length?config.automation.rules:DEFAULT_WATCH_RULES);
   const rules=usable;
   const rateWindow={stamps:[] as number[]};
   watcher=new DirectoryWatcher(config.automation.roots?.length?config.automation.roots:[ctx.cwd],{
    intervalMs:1500,maxDepth:2,
    onEvent:(path,kind)=>{
     const hit=matchRule(path,kind,rules);
     if(!hit)return;
     const recorded=watchCandidates.record({ruleId:hit.rule.id,kind,path,task:hit.task,agent:hit.rule.agent,cooldownMs:hit.rule.cooldownMs});
     if(!recorded)return;
     // 观察表没有自然生命周期：每记一条就裁一次，保留最近 500 条。
     try{watchCandidates.prune();}catch{}
     const candidate={id:'',at:Date.now(),ruleId:hit.rule.id,kind,path,task:hit.task,agent:hit.rule.agent,observeOnly:true as const};
     // 观察永远记录；要不要真的派人由统一判定决定。
     // 严格/只读档、或自动派发没开，到此为止：候选进表，等人来看。
     const permission=automationAllowed(currentPolicy(),config.automation,'dispatch');
     if(!permission.allowed){
      if(desk){desk.notice=`值守观察：${describeCandidate(candidate)}`;scheduleRepaint();}
      return;
     }
     // 派发已放行：先做语义评估，再由闸门决定这一次是否花钱。
     void (async()=>{
      let text='';
      try{text=await readFile(path,'utf8');}catch{/* 读不到就按"没有内容"评估，闸门会据此决定 */}
      let verdict:any;
      try{verdict=parseAssessment(await minimalCompletion(assessmentPrompt(candidate,text)));}
      catch{/* 评估失败按"保留候选"处理，闸门会记录而非派发 */}
      const crew=config.agents.find(agent=>agent.name===candidate.agent||agent.id===candidate.agent);
      const decision=gate({candidate,policy:currentPolicy(),assessment:verdict,assignable:Boolean(crew)});
      // 评估落库：置信度阈值能否校准，取决于这些判断有没有被记录。
      // dispatched 在真正派出后才置 1——记录判断与记录结果同样重要。
      try{
       db().prepare('INSERT INTO watch_assessments(at,rule_id,path,worth,confidence,reason,dispatched) VALUES(?,?,?,?,?,?,?)')
        .run(Date.now(),hit.rule.id,path,verdict?.worth?1:0,verdict?.confidence??null,verdict?.reason??null,0);
      }catch{}
      if(decision.action!=='auto'){if(desk){desk.notice=`值守：${describeCandidate(candidate)} · ${decision.reason}`;scheduleRepaint();}return;}
      if(!canAutoDispatch(rateWindow)){
       // 超出频率上限本身就是值得人知道的事实：规则可能太宽。
       if(desk){desk.urgent(`值守自动派发已达每分钟上限 · ${basename(path)} 改为记录待人工处理`);scheduleRepaint();}
       return;
      }
      try{
       pool.launch({...crew!},dispatchInstruction(candidate,text),ctx.cwd,ctx.sessionManager.getSessionFile()||'',DEFAULT_TASK_SECONDS,undefined,ctx.sessionManager.getSessionId(),['read'],[],false,0,undefined,config.budget?.perTaskTokens,{purpose:'watch',watchPath:path});
       // 派出后把该评估标记为已派发：成功率只统计真的跑起来的那些。
       try{db().prepare('UPDATE watch_assessments SET dispatched=1 WHERE path=?').run(path);}catch{}
       if(desk){desk.notice=`值守自动派发 · ${candidate.agent} 核对 ${basename(path)}`;scheduleRepaint();}
      }catch(error){if(desk){desk.urgent('值守自动派发失败：'+clean(error));scheduleRepaint();}}
     })();
    },
   });
   watcher.start();
  }
  // 给总理的加急指令：带上当前规模与"先看进度再重排"的顺序要求。
  // 人多时明确交给代理总代分担派发——那是治理规则，不是建议。
  // 这里只拼文案，不落库：拼装和在途统计都可能被反复调用，落库只在真的送达时做。
  desk.briefingForPremier=(text:string)=>{
   const running=pool.tasks.filter(t=>!terminalStates.has(t.status||'')).length;
   // "待处理"读全库唯一的判定源：这里自己数 reviewDue||stalled 会漏掉门禁，
   // 于是通知里说的规模和徽章上的数字对不上。
   const waiting=awaitingHuman(pool.tasks).length;
   const deputy=config.agents.find(agent=>agent.id===config.deputyAgentId);
   return premierBriefing(text,{running,waiting,hasDeputy:Boolean(deputy),deputyName:deputy?.name});
  };
  desk.superiorOf=superiorOf;
  // 送达确认：只有进队成功才记 queued；失败也记下来，别让「已加急」变成没有出处的提示。
  desk.briefingDelivered=(delivery,text)=>{
   try{briefingStore.record({target:'premier',targetName:'总理',text,delivery});}catch{}
  };
  // 代表因人类变更而改道：**两段式**上报。
  //
  // 第一段在变更下达时立刻发：上级手里的计划此刻已经过期，晚报一小时，
  // 它就多按旧方向安排一小时。这一段只说"变更已下达、结论待补"。
  // 第二段在任务真正结算后补：那时才有代表的真实结论可转。
  // 只发第一段等于把旧 checkpoint 冒充成结论；只发第二段等于让上级干等。
  desk.briefingSent=(taskId:string,text:string)=>{
   try{
    const task=pool.tasks.find(t=>t.id===taskId);
    const superior=superiorOf();
    briefingStore.record({target:'representative',targetName:task?.agent||taskId,taskId,text,delivery:'forwarded',note:`上级：${superior.role==='deputy'?`代理总代 ${superior.name}`:'总理'}`});
    if(!task?.agent)return;
    deliverUpward(briefingIssued({agent:task.agent,taskId,briefing:text}),superior,`${task.agent} 已改道 · 已报`);
    pendingUpward.set(taskId,{agent:task.agent,briefing:text,superior});
   }catch(error){desk&&(desk.notice='改道汇报失败：'+clean(error));}
  };
  desk.graph={snapshot:()=>{const approvals=scheduler.list().flatMap(plan=>plan.jobs.filter(job=>job.state==='NEEDS_HUMAN').map(job=>({id:job.key,agent:job.agent.name,state:'NEEDS_HUMAN',status:'等待人类审批',title:job.task,groupKey:plan.id})));
  // 预算截停的立案以伪任务进图：state NEEDS_HUMAN 让它点亮 ⚠、计入"待处理"、进 F8 筛选。
  // 终态任务被计数排除是刻意的（历史失败不能永久顶红徽章），但立案是活的待办，必须被看见。
  const budgetCases=new BudgetEscalations(db()).pending().map(escalation=>({id:escalation.id,agent:escalation.agent,state:'NEEDS_HUMAN',status:'预算停止 · 待你审批',title:escalation.task,error:`已耗 ${formatTokens(escalation.spent)} / 上限 ${formatTokens(escalation.cap)}${escalation.proposal?` · 总理建议 ${formatTokens(escalation.proposal)}`:''} · F2 → 预算追加审批`,groupKey:escalation.parentSessionId||escalation.taskId}));
  return{agents:config.agents.map(agent=>({id:agent.id,name:agent.name,model:agent.model,roleKey:agent.roleKey,deputy:agent.id===config.deputyAgentId})),tasks:[...pool.tasks.map(task=>({id:task.id,agent:task.agent,status:task.status,state:task.state,title:task.title,tool:task.tool,checkpoint:task.checkpoint,output:task.output?.slice(-160),parentWorkerId:task.parentWorkerId,delegationDepth:task.delegationDepth,groupId:(task as any).groupId,reviewDue:task.reviewDue,error:task.error,groupKey:task.parentSessionId,started:task.started,ended:task.ended})),...approvals,...budgetCases]};}};pulseTimer=setInterval(()=>{if(desk&&(desk.taskView||desk.missionView||desk.graphView))desk.refresh();},400);return desk;},{overlay:true,overlayOptions:{anchor:'top-left',width:'100%',maxHeight:'100%',margin:0}});}finally{clearInterval(pulseTimer);pulseTimer=undefined;clearTimeout(repaintTimer);repaintTimer=undefined;watcher?.stop();watcher=undefined;desk?.dispose();desk=undefined;}
 if(!action)return;
 try{
 if(action.kind==='reload'){if(blocked(ctx)){ctx.ui.notify('任务进行中，未重载；请等待或中止后重试','warning');continue;}const active=pool.tasks.filter(t=>!terminalStates.has(t.status)).length;if(active&&!await ctx.ui.confirm('重载 Kepos 扩展？',`重载会取消 ${active} 个运行中的子任务（包括其他会话的）；会话记录和输入草稿保留。`))continue;db().set('ui_reload',{pid:process.pid,sessionId:ctx.sessionManager.getSessionId(),at:Date.now()});await ctx.reload();return;}
  if(action.kind==='pi'){ctx.ui.notify('已进入 Pi 命令行；输入 /kepos 重新打开议案。','info');return;}
  if(action.kind==='native-exit'){ctx.ui.setEditorText(action.text);ctx.ui.notify(`已返回原生 Pi；按 Enter 执行 ${action.text}。尚未执行，也未发送给模型。`,'info');return;}
 if(action.kind==='abort'){ctx.abort();pool.cancelAll();await ctx.waitForIdle();continue;}
 // 右侧项目/会话列表按 Enter 进入历史会话。
 // Desk 只会 finish({kind:'switch'}) 并关闭自己；真正的切换必须在这里做——
 // 这个分支此前缺失，于是回车没有任何反应，看起来像"列表不能进"。
 if(action.kind==='switch'){
  if(!action.path){ctx.ui.notify('该会话没有可用路径','warning');continue;}
  // 这里不查 blocked(ctx)：Desk 在发出这个动作之前已经确认过"可以切换"
  // （它自己的 sending/isIdle 判定更贴近实际状态）。再拦一次只会造成
  // "列表里按回车没反应，还不知道为什么"——而这个提示在 overlay 关闭后
  // 往往一闪而过，等于没有。
  await ctx.switchSession(action.path,{withSession:async fresh=>reopen(fresh)});
  return;
 }
 }catch(e){ctx.ui.notify(clean(e),'error');}
 }
 }
 pi.registerCommand('kepos-warm',{description:'预热僚属 执行器（不调用模型；空闲60秒退出）',handler:async(args,ctx)=>{const crew=config.agents.find(a=>a.name===args.trim())||config.agents[0];if(!crew){ctx.ui.notify('先配置至少一个僚属','warning');return;}try{const result=await pool.prewarm(crew,ctx.cwd);ctx.ui.notify(`${crew.name} 执行器已就绪 · PID ${result.pid} · 未请求模型`,'info');}catch(error){ctx.ui.notify(clean(error),'error');}}});
 // 主题切换的唯一实现：/theme 命令、F2 菜单与命令面板都走这里，避免两套逻辑漂移。
 // 先试 Pi 的 setTheme 热切换（同时更新设置与已加载 Theme 实例）；
 // 拿不到该接口时才回退到写 settings.json 并提示重载。
 const applyTheme=async(wanted:string|undefined,ctx:any):Promise<{ok:boolean;name?:string;reason?:string}>=>{
  const available=(()=>{try{return (ctx.ui as any).getAllThemes?.()||[];}catch{return [];}})();
  const names=available.map((entry:any)=>String(entry.name));
  const preferred=wanted?.trim();
  // 品牌主题按固定顺序轮换（default → dark → light），不依赖 getAllThemes 的返回顺序；
  // 这样每次 /theme 的切换路径可预期，且三套主题都能循环到。
  const BRAND_ORDER=['kepos-default','kepos-dark','kepos-light'];
  const present=new Set(names);
  const brand=BRAND_ORDER.filter(name=>present.size===0||present.has(name));
  const candidates=brand.length?brand:names;
  const current=(()=>{try{return ctx.ui.theme?.name;}catch{return undefined;}})();
  // 未设置主题时从第一个开始选，而不是 indexOf('') = -1 后停在第 0 个。
  const at=current?candidates.indexOf(current):-1;
  const next=preferred||candidates[(at+1)%Math.max(1,candidates.length)];
  if(!next)return{ok:false,reason:'没有可用主题'};
  if(preferred&&names.length&&!names.includes(preferred))return{ok:false,reason:`未知主题 ${preferred}；可用：${names.join('、')}`};
  const applied=(()=>{try{const result=(ctx.ui as any).setTheme?.(next);return result?.success!==false;}catch{return false;}})();
  if(applied){
   // 主题换了以后，desk 缓存的旧 theme 对象要一并替换，否则底栏与书案仍是旧配色。
   if(desk){try{desk.theme=ctx.ui.theme;}catch{}desk.invalidate();desk.refresh();}
   return{ok:true,name:next};
  }
  const settingsFile=join(process.env.KEPOS_AGENT_DIR||join(homedir(),'.kepos','agent'),'settings.json');
  let settings:any={};try{settings=JSON.parse(readFileSync(settingsFile,'utf8'));}catch{}
  settings.theme=next;
  writeFileSync(settingsFile,JSON.stringify(settings,null,2)+'\n');
  return{ok:false,name:next,reason:`主题已写入 ${next}；当前 Pi 不支持热切换，/reload 生效。`};
 };
 const themeChoices=(ctx:any):string[]=>{
  const names=(()=>{try{return ((ctx?.ui as any)?.getAllThemes?.()||[]).map((entry:any)=>String(entry.name));}catch{return [];}})();
  const present=new Set(names);
  const ordered=['kepos-default','kepos-dark','kepos-light'].filter(name=>present.size===0||present.has(name));
  return ordered.length?ordered:names;
 };
 pi.registerCommand('theme',{description:'切换主题（default / dark / light；即时生效，也可 /theme kepos-light）',handler:async(args,ctx)=>{
  const result=await applyTheme(args,ctx);
  if(result.ok){ctx.ui.notify(`主题已切换为 ${result.name}（即时生效）`,'info');return;}
  ctx.ui.notify(result.reason||'主题切换失败','warning');
 }});
 pi.registerCommand('simon',{description:'开始 Kepos 监督式工作（兼容旧命令）',handler:async(args,ctx)=>{const prompt=args?.trim()||`请先说明当前项目目标、风险和下一步计划；如需并行工作，使用 kepos_delegate 分派最多 ${MAX_CONCURRENT_CHILDREN} 个只读任务，默认每项 ${DEFAULT_TASK_SECONDS/60} 分钟，并每 ${SUPERVISION_INTERVAL_SECONDS/60} 分钟用 kepos_events/kepos_tasks 复核；超过 ${HUMAN_APPROVAL_THRESHOLD_SECONDS/60} 分钟的工作改用 kepos_plan 并等待人类批准。`;await pi.sendUserMessage(prompt);}});
 pi.registerCommand('simon-status',{description:'查看 Kepos、项目和僚属 状态（兼容旧命令）',handler:async(_args,ctx)=>{const tasks=pool.tasks.filter(t=>t.cwd===ctx.cwd&&t.parentSessionId===ctx.sessionManager.getSessionId());ctx.ui.notify(`Kepos Communis · ${ctx.model?.provider}/${ctx.model?.id}\n项目：${ctx.cwd}\n僚属：${tasks.filter(t=>!terminalStates.has(t.status)).length} 运行中 / ${tasks.length} 总计`,'info');}});
 pi.registerCommand('kepos',{description:'Kepos Communis · 打开议案',handler:async(_args,ctx)=>runDesk(ctx)});
 pi.registerCommand('kepos-new',{description:'在当前项目创建对话',handler:async(_args,ctx)=>{if(blocked(ctx)){ctx.ui.notify('请先等待任务结束。','warning');return;}const name=await ctx.ui.input('新对话名称','');if(!name?.trim())return;const path=createLinkedSession(ctx,ctx.cwd,name.trim());await ctx.switchSession(path,{withSession:async fresh=>reopen(fresh)});}});
 pi.registerCommand('kepos-project',{description:'收录本地项目',handler:async(_args,ctx)=>{const input=await ctx.ui.input('项目绝对目录','');if(!input?.trim())return;try{const path=projectPath(input);if(!config.projects.includes(path))config.projects.push(path);save();}catch(e){ctx.ui.notify(clean(e),'error');}}});
 pi.registerCommand('kepos-agent',{description:'配置真实僚属',handler:async(_args,ctx)=>{try{await crewForm(ctx);}catch(e){ctx.ui.notify(clean(e),'error');}}});
}
