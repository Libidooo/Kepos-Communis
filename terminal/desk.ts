import { Editor, Markdown, CombinedAutocompleteProvider, matchesKey, Key, truncateToWidth, visibleWidth, wrapTextWithAnsi, sliceByColumn } from '@earendil-works/pi-tui';
import { SessionManager, getSelectListTheme, getMarkdownTheme, copyToClipboard } from '@earendil-works/pi-coding-agent';
import { basename } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { clean, saveConfig, type Config } from './store.ts';
import { terminalStates, type WorkerPool } from './workers.ts';
import { routeCommand, localCommands } from './command-routing.ts';
import { TimingWindow } from './metrics.ts';
import { PRODUCT_NAME, sessionUsage, usageText, formatTokens, cacheHitPercent } from './presentation.ts';
import { loadAttachment, attachmentToPrompt, looksLikeFilePaths, isAttached } from './attachments.ts';
import { dataRoot } from './paths.ts';
import { renderGraph, renderCouncilList, councilTasks, countActive, countPending, stateColor, stateMark, type CouncilFilter, type CouncilView, type GraphHit, type GraphViewSnapshot } from './graph-view.ts';
 // pi-tui 的省略号被 \x1b[0m 包裹，会打断铺底背景（红框 bug 根因）：自行截断并追加无装饰省略号。
 const truncateFit=(text:string,width:number)=>{const w=Math.max(1,width);if(visibleWidth(text)<=w)return truncateToWidth(text,w);return truncateToWidth(text,w-3,'').replace(/\x1b\[0m/g,'')+'...';};
 export const fit=(text:string,width:number)=>{const s=truncateFit(text,width);return s+' '.repeat(Math.max(0,width-visibleWidth(s)));};
 export const fitRight=(text:string,width:number)=>{const s=truncateFit(text,width);return ' '.repeat(Math.max(0,width-visibleWidth(s)))+s;};
// stateColor 会返回 approval/queue/teal 等 Pi theme.fg 不认的色（graph-view 直出 SGR）；desk 侧映射到安全语义色。
const safeStateColor=(color:string)=>color==='approval'?'warning':color==='queue'?'accent':['teal','blue','mauve','idle'].includes(color)?'muted':color;
export function historyLines(entries:any[],width:number,expanded:boolean|'summary'|'full'=false,theme?:any):string[]{
 const F=(color:string,value:string)=>theme?.fg?theme.fg(color,value):value;
 // 斜体辅助：工具调用与模型正文/用户输入在字形上也分层。
 const I=(value:string)=>`\x1b[3m${value}\x1b[23m`;
 // 工具展示三档（布尔仍兼容旧调用方）：
 //   summary —— 默认。每次工具调用压成一行摘要，输出不展开。
 //   full    —— F5 展开。完整输出。
 //   false   —— 旧行为（长输出折头尾），保留给预览等场景。
 const toolMode:'summary'|'full'|'legacy'=expanded===true?'full':expanded==='summary'?'summary':expanded==='full'?'full':'legacy';
 const lines:string[]=[];for(const entry of entries){if(entry.type==='compaction'||entry.type==='branch_summary'){lines.push(entry.type==='compaction'?'[上下文已压缩 / 以下为摘要]':'[分支背景摘要]',...wrapTextWithAnsi(clean(entry.summary),width),'');continue;}if(entry.type==='custom_message'&&entry.display===false)continue;if(entry.type!=='message'&&entry.type!=='custom_message')continue;const m=entry.message||{role:'custom',content:entry.content};if(m.role==='custom'&&m.display===false)continue;if(!['user','assistant','toolResult','custom'].includes(m.role))continue;
 // 错误必须可见：工具失败或工具结果带错误标记时，即使处于 summary 档也要展开。
 const failedTool=m.role==='toolResult'&&(m.isError===true||Boolean(m.errorMessage)||/^\s*(error|错误|✕)/i.test(String(typeof m.content==='string'?m.content:'')));
 // 发言者分级：用户 accent ›、助手 accent Kepos、工具 muted ▸、自定义 muted ·。
 // Each speaker gets its own colour AND glyph: the human, the 总理, a 代表 and tool noise must
 // be distinguishable at a glance, not by reading the text.
 const fromDelegate=m.role==='custom'&&String(entry.customType||'').startsWith('kepos-');
 const delegateName=(String(typeof m.content==='string'?m.content:'').match(/「([^」]+)」/)||[])[1];
 lines.push(
  m.role==='user'?F('accent','› 你')
  :m.role==='assistant'?F('accent','◆ Kepos 总理')
  :fromDelegate?F('toolTitle',`◈ ${delegateName||'代表'}`)
  :m.role==='custom'?F('muted','·')
  :I(F('muted',`┊ ▸ ${clean(m.toolName)}`)));
 const blocks=typeof m.content==='string'?[{type:'text',text:m.content}]:m.content||[];
 for(const b of blocks){if(b.type==='text'&&fromDelegate&&b.text){const raw=String(b.text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');
  // Delegate output is tinted and rule-marked so it never reads as the 总理 speaking.
  for(const l of raw.split('\n'))lines.push(...wrapTextWithAnsi(l,Math.max(4,width-2)).map(w=>F('toolTitle','▏ '+w)));}
  else if(b.type==='text'&&theme?.bg&&['assistant','user'].includes(m.role)){const text=String(b.text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');// The 总理 is the visual centre: its reply sits on its own card, distinct from the
  // human's tinted block and from the delegates' rule-marked output.
  const rendered=m.role==='assistant'
   ?new Markdown(text,0,0,getMarkdownTheme(),{color:(s:string)=>theme.fg('text',s)}).render(width).map(line=>theme.bg('customMessageBg',line+' '.repeat(Math.max(0,width-visibleWidth(line)))))
   :wrapTextWithAnsi(text,width).map(line=>theme.bg('userMessageBg',theme.fg('userMessageText',fit(line,width))));lines.push(...rendered);}else if(b.type==='text'){
   const raw=String(b.text).split('\n');
   // summary 档：工具输出整体压成一行（首行摘要 + 行数），失败时强制展开。
   const collapse=m.role==='toolResult'&&toolMode==='summary'&&!failedTool;
   const legacyFold=m.role==='toolResult'&&toolMode==='legacy'&&raw.length>12;
   const selected=collapse
    ?[`${raw[0]?.trim().slice(0,Math.max(20,width-24))||'(无输出)'}${raw.length>1?` … ${raw.length-1} 行`:''} · F5 展开`]
    :legacyFold?[...raw.slice(0,5),`… 已折叠 ${raw.length-10} 行 · F5 展开工具输出`,...raw.slice(-5)]:raw;
  // 工具产出：muted + 左侧 ▏ 竖线，与模型回答明确分层。失败用 error 色标出，避免被折叠掩盖。
  const outColor=failedTool?'error':'muted';
  for(const l of selected)lines.push(...wrapTextWithAnsi(l.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,''),Math.max(4,width-2)).map(w=>F(outColor,'▏ '+w)));}else if(b.type==='toolCall')lines.push(I(F('muted','┊ ▸ '+clean(b.name))));
  // 思考过程：dim + ▎ 竖线，与回答正文区分。
  else if(b.type==='thinking'){const raw=String((b as any).thinking??b.text??'');for(const l of raw.split('\n'))lines.push(...wrapTextWithAnsi(l.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,''),Math.max(4,width-2)).map(w=>F('dim','▎ ')+F('syntaxOperator',w)));}else if(b.type==='image')lines.push('[图片附件]');}
 if(m.errorMessage)lines.push('错误：'+clean(m.errorMessage));lines.push('');}
 return lines.length?lines:['尚无消息。直接在下方输入，Enter 发送给主 Agent。'];
}
// 键位表：footer、F1 帮助、鼠标点击区三处都由这一份数据生成，不再各自手写。
// `when` 决定该键在当前上下文是否可见；`footer` 标记是否进底栏。
// 注意：这张表只管"显示"与"可点击"；按键行为仍在 handleInput 的 if 链里。
type Scope = 'council' | 'councilDesk' | 'list' | 'task' | 'input' | 'projects' | 'crew';
export type KeyHint = { key: string; label: string; help: string; when: Scope | 'always'; footer?: boolean };
export const KEY_HINTS: readonly KeyHint[] = [
 { key: 'f10', label: 'F10 议会', help: 'F10：打开 / 关闭 48 席议会', when: 'always', footer: true },
 { key: 'f1', label: 'F1 帮助', help: 'F1：打开 / 关闭本帮助', when: 'always', footer: true },
 { key: 'f2', label: 'F2 操作', help: 'F2：新项目 / 新对话 / 配置代表 / 推选代理总代 / 手动分派 / 审批模式（状态栏常驻显示：⛨ 严格 / ◐ 代理 / ○ 只读）', when: 'always', footer: true },
 { key: 'f3', label: 'F3 任务', help: 'F3：当前会话的任务与书案详情', when: 'always', footer: true },
 { key: 'f8', label: 'F8 全局', help: 'F8：跨项目任务监控；议会内切换筛选', when: 'always', footer: true },
 { key: 'f11', label: 'F11 专注', help: 'F11：专注阅读（中栏最大化）', when: 'always', footer: true },
 { key: 'f4', label: 'F4 模型', help: 'F4：切换当前主 Agent 模型', when: 'always' },
 { key: 'f5', label: 'F5 工具输出', help: 'F5：展开 / 折叠完整工具输出', when: 'always' },
 { key: 'f6', label: 'F6 面板', help: 'F6：议案内在 输入 → 项目 → 代表席 间切换；议会内在 席位 → 列表 → 输入 间切换', when: 'always' },
 { key: 'f7', label: 'F7 复制', help: 'F7 或 Ctrl+Shift+C：复制完整最新回答', when: 'always' },
 { key: 'f9', label: 'F9 计划', help: 'F9：长程计划监控台', when: 'always' },
 { key: 'ctrl+k', label: 'Ctrl+K 命令面板', help: 'Ctrl+K：命令面板', when: 'always' },
 { key: 'ctrl+x', label: 'Ctrl+X 中止', help: 'Ctrl+X：议案中中止整轮；议会中取消选中任务', when: 'always', footer: true },
 { key: 'escape', label: 'Esc 返回', help: 'Esc：逐层返回（书案 → 详情 → 列表 → 席位 → 议案）', when: 'always' },
 { key: 'tab', label: 'Tab 列表', help: 'Tab：议会内切换席位图与任务列表', when: 'council', footer: true },
 { key: 'slash', label: '/ 过滤', help: '议会列表内按 / 输入关键词过滤，Esc 结束', when: 'list', footer: true },
 { key: 'v', label: 'v 完整产出', help: '议会列表内按 v 打开该任务的完整产出', when: 'list', footer: true },
 { key: 'ctrl+left', label: 'Ctrl+← 上一任务', help: '任务视图内 Ctrl+← / Ctrl+→ 切换任务', when: 'task', footer: true },
 { key: 'ctrl+right', label: 'Ctrl+→ 下一任务', help: '任务视图内 Ctrl+← / Ctrl+→ 切换任务', when: 'task', footer: true },
 { key: 'pgup', label: 'PgUp/PgDn', help: 'PgUp/PgDn 或滚轮：滚动历史与产出；Ctrl+End 回到最新', when: 'always', footer: true },
];
// 底栏每个可见键都必须能点：footerHints 里的 key 必须在这张表里有条目。
export const keyBytes: Record<string, string> = {
 f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~',
 f8: '\x1b[19~', f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', escape: '\x1b',
 'ctrl+x': '\x18', tab: '\t', slash: '/', v: 'v', pgup: '\x1b[5~',
 'ctrl+left': '\x1b[1;5D', 'ctrl+right': '\x1b[1;5C',
};
 // 拆分用户输入的多个路径：支持引号包裹的含空格路径，也支持一行一个。
 function splitPaths(input:string):string[]{
  const text=String(input||'').trim();
  if(!text)return[];
  const result:string[]=[];
  // 先按引号抓取，再处理剩余的无引号片段。
  const quoted=/["']([^"']+)["']/g;
  const leftovers=text.replace(quoted,(_all,inner)=>{result.push(inner);return' ';});
  for(const piece of leftovers.split(/\s+/)){
   const trimmed=piece.trim().replace(/,$/,'');
   if(trimmed)result.push(trimmed);
  }
  return result.filter(Boolean);
 }
type Action={kind:string;path?:string;text?:string;id?:string;draft?:string};
export class Desk {
 // 工具展示模式：默认 summary（一行摘要），F5 切到 full。
 get toolMode():'summary'|'full'{return this.expandedTools?'full':'summary';}
 editor:Editor; attachments:any[]=[]; attachBusy=false; focus:'input'|'projects'|'crew'='input'; focused=true; alive=true; selected=0; crewIndex=0; crewOffset=0; rightOffset=0; readStart:number|null=null; lastSubmitted='';savedDraftBeforeCommand=''; sawStart=false; requestStartedAt=0; firstTokenAt=0; lastTurnMetrics:{ttftMs:number;totalMs:number}|null=null; expandedTools=false; _notice='直接输入即可对话 · F10 议会 · F2 操作菜单 · F1 帮助';noticeAt=0;maximize=false; help=false; taskView=false; taskIndex=0; live:any; sending=false; lastPreview=''; previewCache=new Map<string,any[]>(); latestEntries:any[]=[]; width=120; bodyHeight=20; headerHeight=3; inputY=0; leftWidth=24; centerWidth=60; rightWidth=30; inputWidth=60; editorHeight=4; narrow=false; pulse=0; activity:string[]=[]; thinking=false; displayLines:string[]=[]; historyCacheKey=''; historyCache:string[]=[]; footerRegions:{start:number;end:number;key:string}[]=[]; folded:Set<string>; draftTimer:any; completionTimer:any; renderTimer:any; renderPending=false; actionBusy=false;selection:{anchor:{row:number;col:number};end:{row:number;col:number};lines:string[];active:boolean}|null=null;visibleCenter:string[]=[];metricsDirty=true;metrics=sessionUsage([]);spinnerTimer:any;_noticeUrgent=false;
 // notice 统一走 setter 盖时间戳。urgent 消息（失败 / 需人工 / 预算停止）粘住，
 // 只有 Esc 或用户下一个动作才清掉；普通消息 4 秒后让位给按键提示。
 // urgent 在场时普通通知一律丢弃：失败/门禁/预算必须被人看见，不能被"正在调用 X"顶掉。
 get notice(){return this._notice;}
 set notice(value:string){if(this._noticeUrgent)return;this._notice=value;this.noticeAt=Date.now();}
 // 紧急通知：粘性，只有 Esc 或用户真正发出新消息才清除。
 urgent(value:string){this._notice=value;this.noticeAt=Date.now();this._noticeUrgent=true;}
 readonly renderMetrics=new TimingWindow();
 private entriesCache:any[]|undefined;private entriesKey='';private entriesDirty=true;private rowCache:any[]|undefined;private liveBaseCache:string[]=[];private liveBaseCacheKey='';
 taskScope:'session'|'all'='session';
 missionView=false;graphView=false;graphDetail=false;graphSelected=-1;graphSelectedId:string|null=null;graphZoom=1;graphFocus:'ring'|'list'|'input'='ring';graphHits:GraphHit[]=[];graphOffsets:Record<string,{x:number;y:number}>={};graphDrag?:{id:string;lastX:number;lastY:number};graphWidth=0;councilList=false;councilFilter:CouncilFilter='active';councilIndex=0;councilQuery='';councilSearch=false;pendingSeen=0;councilDesk=false;councilDeskTaskId:string|null=null;deskOffset=0;deskX=0;deskWidth=0;deskOutputTotal=0;deskOutputVisible=0;deskWrapKey='';deskWrapCache:string[]|null=null;graph?:{snapshot:()=>GraphViewSnapshot};
 monitor?:{tasks:()=>any[];evidence:(id:string)=>any;plans:()=>any[]};
 /** 当前审批模式，用于状态栏常驻显示；由 index.ts 注入。 */
 approvalPolicy?:()=>'human'|'proxy'|'readonly';
 private monitorAt=0;private monitorTasksCache:any[]=[];private monitorPlansCache:any[]=[];
 private evidenceAt=0;
 private evidenceCache:{id:string;ended:any;output:any;value:any}|undefined;
 private monitorData(){if(Date.now()-this.monitorAt>1000){this.monitorAt=Date.now();try{this.monitorTasksCache=this.monitor?.tasks()||this.pool.tasks;this.monitorPlansCache=this.monitor?.plans()||[];}catch(error){this.notice='监控读取暂不可用：'+clean(error);}}return{tasks:this.monitorTasksCache,plans:this.monitorPlansCache};}
 panelTasks(){return this.taskScope==='all'?this.monitorData().tasks:this.sessionTasks();}
 constructor(public tui:any,public theme:any,public ctx:any,public config:Config,public sessions:any[],public pool:WorkerPool,public submit:(text:string,images?:any[])=>void|Promise<void>,public done:(action?:Action)=>void,public commands:any[]=[],public clipboard:(text:string)=>Promise<void>=copyToClipboard,public onAction?:(action:Action)=>Promise<void>){
 this.sending=!ctx.isIdle();this.folded=new Set(config.folded);this.expandedTools=config.expandedTools===true;this.editor=new Editor(tui,{borderColor:(s:string)=>theme.fg('borderMuted',s),selectList:getSelectListTheme()},{paddingX:1});
 this.savedDraftBeforeCommand=config.drafts[this.sessionKey()]||'';this.editor.setText(this.savedDraftBeforeCommand);this.editor.focused=true;
 this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...localCommands,...commands.filter((c:any)=>!localCommands.some(l=>l.name===c.name)).map((c:any)=>({name:c.name,description:c.description||''}))],ctx.cwd));
 this.editor.onChange=()=>{const draft=this.editor.getExpandedText();if(draft&&!draft.startsWith('/'))this.savedDraftBeforeCommand=draft;config.drafts[this.sessionKey()]=this.editor.getExpandedText();clearTimeout(this.draftTimer);this.draftTimer=setTimeout(()=>{try{saveConfig(config)}catch(error){this.notice='草稿保存失败：'+clean(error);this.refresh();}},250);};
 this.editor.onSubmit=text=>this.send(text);
 }
 sessionTasks(){return this.pool.tasks.filter(t=>t.cwd===this.ctx.cwd&&t.parentSessionId===this.ctx.sessionManager.getSessionId());}
 sessionKey(){return this.ctx.sessionManager.getSessionFile()||this.ctx.sessionManager.getSessionId();}
 // ── 附件 ──────────────────────────────────────────────────────────────
 // 附件随会话保存（切走再切回还在），但发送后即清空——它属于"这一轮"而非长期上下文。
 attachKey(){return 'attach:'+this.sessionKey();}
 loadAttachments(){const saved=this.config.drafts[this.attachKey()];if(saved){try{this.attachments=JSON.parse(saved);}catch{this.attachments=[];}}}
 saveAttachments(){this.config.drafts[this.attachKey()]=JSON.stringify(this.attachments);}
 // 附件条：输入框上方一行，显示已附加项与移除提示。
 attachmentBar(width:number):string[]{
  if(!this.attachments.length)return[];
  // 单项可移除：`/attach remove 2` 只移除第 2 项，`/attach remove` 全部清除。
  // 同时标出体积与被截断标记，避免用户以为读到的是全文。
  const size=(bytes:number)=>bytes>=1048576?`${(bytes/1048576).toFixed(1)}M`:`${Math.max(1,Math.round(bytes/1024))}K`;
  const items=this.attachments.map((a:any,index:number)=>{
   const mark=a.truncated?'⁂':a.kind==='image'?'▣':'▤';
   return `${index+1}.${mark}${a.name}(${size(a.bytes)})`;
  });
  const head='📎 '+items.join(' ');
  const tail=this.attachments.length===1?'   /attach remove':'   /attach remove <序号> · remove 全清';
  const line=visibleWidth(head+tail)<=width?head+tail:head;
  return [this.theme.fg('toolTitle',truncateToWidth(line,width))];
 }
 // 提交时把附件拼成 Pi 需要的形状：图片走 ImageContent，文档/文本注入正文。
 composeSubmit(text:string):{payload:string;images:any[]}{
  const images=this.attachments.filter((a:any)=>a.kind==='image').map((a:any)=>({type:'image',data:a.data,mimeType:a.mimeType}));
  const docs=this.attachments.filter((a:any)=>a.kind!=='image');
  if(!docs.length)return{payload:text,images};
  const blocks=docs.map((a:any)=>attachmentToPrompt(a)).join('\n\n');
  return{payload:(text?text+'\n\n':'')+blocks,images};
 }
 clearAttachments(){this.attachments=[];try{delete this.config.drafts[this.attachKey()];saveConfig(this.config);}catch{}}
 // /attach 的处理：无参弹文件选择器，有参直接加载，ask 交给外层打开对话框。
 async attachCommand(argument:string,ask:(title:string,placeholder:string)=>Promise<string|undefined>){
  const arg=argument.trim();
  // `/attach remove` 全清；`/attach remove 2` 只移除第 2 项（附件条上标了序号）。
  const removeMatch=arg.match(/^(?:remove|clear|清除)\s*(\d+)?$/i);
  if(removeMatch){
   const at=removeMatch[1]?Number(removeMatch[1]):0;
   if(!at){this.clearAttachments();this.notice='已清除全部附件';this.refresh();return;}
   if(at<1||at>this.attachments.length){this.notice=`没有第 ${at} 项附件（当前 ${this.attachments.length} 项）`;this.refresh();return;}
   const removed=this.attachments.splice(at-1,1)[0];
   this.saveAttachments();
   this.notice=`已移除附件 ${removed?.name||at}（剩 ${this.attachments.length} 项）`;
   this.refresh();return;
  }
  const paths=arg?splitPaths(arg):[];
  if(!paths.length){
   const picked=await ask('附加文件 · 输入路径（docx/pdf/pptx/xlsx/epub/zip/图片/文本）',this.ctx.cwd);
   if(!picked||!picked.trim())return;
   paths.push(...splitPaths(picked));
  }
  if(!paths.length)return;
  if(this.attachBusy)return;
  this.attachBusy=true;this.notice='正在读取附件…';this.refresh();
  try{
   // 读取策略与子 Agent 一致：默认只允许项目目录，凭据位置一律拒绝。
   const policy={mode:(this.config.workerReadScope==='machine'?'machine':'project') as any,cwd:this.ctx.cwd,allow:[],deny:[],home:process.env.HOME||process.env.USERPROFILE||''};
   const added:string[]=[];const failed:string[]=[];
   for(const path of paths){
    const result=await loadAttachment(path,{policy,deny:[dataRoot],cwd:this.ctx.cwd});
    // 早返回式收窄：联合类型在 continue 之后能正确推断，不需要额外的守卫函数。
    if(!isAttached(result)){failed.push(result.reason);continue;}
    const attachment=result.attachment;
    // 同一个文件重复附加只保留一份。
    if(!this.attachments.some((a:any)=>a.path===attachment.path))this.attachments.push(attachment);
    added.push(attachment.name);
   }
   this.saveAttachments();
   if(added.length&&failed.length)this.notice=`已附加 ${added.join('、')}；${failed.length} 项失败：${failed[0]}`;
   else if(added.length)this.notice=`已附加 ${added.join('、')}（共 ${this.attachments.length} 项）`;
   else this.urgent('附件读取失败：'+failed.join('；'));
   this.refresh();
  }catch(error){this.urgent('附件读取失败：'+clean(error));this.refresh();}
  finally{this.attachBusy=false;}
 }
 refresh(){if(!this.alive||this.renderPending)return;this.renderPending=true;clearTimeout(this.renderTimer);this.renderTimer=setTimeout(()=>{this.renderPending=false;if(this.alive)this.tui.requestRender();},50);}
 invalidate(){this.editor.invalidate();this.historyCacheKey='';this.liveBaseCacheKey='';this.metricsDirty=true;this.entriesDirty=true;this.rowCache=undefined;}
 setFocus(f:'input'|'projects'|'crew'){this.focus=f;this.editor.focused=this.focused&&f==='input';this.refresh();}
 rows(){if(this.rowCache)return this.rowCache;const dirs=[...new Set([this.ctx.cwd,...this.config.projects,...this.sessions.map(s=>s.cwd).filter(Boolean)])];return this.rowCache=dirs.flatMap(path=>[{kind:'project',path,label:(basename(path)||path)+(this.pool.tasks.some(t=>t.cwd===path&&!terminalStates.has(t.status))?' · 有任务':'')},...(this.folded.has(path)?[]:this.sessions.filter(s=>s.cwd===path).map(s=>({kind:'session',path:s.path,label:s.name||s.firstMessage||'未命名会话',session:s})))]);}
 selectedRow(){return this.rows()[this.selected];}
 preview(){const row:any=this.focus==='projects'?this.selectedRow():null;return row?.kind==='session'&&row.path!==this.ctx.sessionManager.getSessionFile()?row:null;}
 send(submitted?:string){const text=(submitted??this.editor.getExpandedText()).trim();if(!text)return;if(this.preview()){this.editor.setText(text);this.notice='这是只读预览：在会话列表按 Enter 进入后再发送。';this.refresh();return;}
 if(this.help||this.taskView||this.missionView){this.editor.setText(text);this.notice='当前为阅读模式。先按 F1/F3/F9 返回会话，再 Enter 发送。';this.refresh();return;}
 if(this.sending||!this.ctx.isIdle()){
  // Pi queues submissions made mid-turn (followUp); hand the text over and say so.
  this.editor.addToHistory(text);this.editor.setText('');this.savedDraftBeforeCommand='';
  const result=this.submit(text);
  if(result&&typeof result.catch==='function')result.catch(error=>{if(!this.alive)return;this.editor.setText(text);this.notice='排队失败（原稿已恢复）：'+clean(error);this.refresh();});
  this.notice='已排队：当前回合结束后自动发送；Ctrl+X 中止。';this.refresh();return;}
 const route=routeCommand(text,this.commands);if(route.kind==='unknown'){this.editor.setText(text);this.notice='未知命令 /'+route.name+'，未发送给模型。输入 / 选择；发送字面斜线请用 //。';this.refresh();return;}
 if(route.kind==='native'||route.kind==='registered'&&route.source==='extension'){this.editor.setText(this.savedDraftBeforeCommand);this.finish({kind:route.kind==='native'?'native-command':'dispatch-command',text});return;}
 if(route.kind==='local'){this.editor.setText(route.name==='reload'||route.name==='pi'?this.savedDraftBeforeCommand:'');switch(route.name){case 'help':this.help=true;break;case 'copy':void this.copyAnswer();break;case 'tasks':this.taskView=true;this.readStart=null;break;case 'attach':{const argument=text.trim().slice('/attach'.length).trim();this.finish({kind:'attach',text:argument});return;}case 'pi':this.finish({kind:'pi'});return;default:this.finish({kind:route.name});return;}this.refresh();return;}
 const payload=route.text;
 // 附件只在真正的 chat 分支附加：命令路由永不携带附件。
 const composed=this.composeSubmit(payload);
 const sentAttachments=this.attachments.length;
 this.lastSubmitted=composed.payload;this.requestStartedAt=Date.now();this.savedDraftBeforeCommand='';this.sawStart=false;this.sending=true;this.live={role:'user',content:payload,timestamp:Date.now()};this.readStart=null;this.editor.addToHistory(text);this.editor.setText('');this._noticeUrgent=false;
 if(sentAttachments)this.clearAttachments();
 this.notice=sentAttachments?`正在提交给主 Agent…（含 ${sentAttachments} 项附件）`:'正在提交给主 Agent…';
 try{const result=this.submit(composed.payload,composed.images);if(result&&typeof result.catch==='function')result.catch(error=>{if(!this.alive)return;this.sending=false;this.live=undefined;if(!this.editor.getExpandedText())this.editor.setText(text);this.notice='提交失败（原稿已保留）：'+clean(error);this.refresh();});}catch(error){this.sending=false;this.live=undefined;this.editor.setText(text);this.notice='提交失败：'+clean(error);}
 // A synchronous extension-command response might emit no agent lifecycle event.
 clearTimeout(this.completionTimer);this.completionTimer=setTimeout(()=>{if(this.alive&&this.ctx.isIdle()){this.sending=false;if(!this.sawStart){if(!this.editor.getExpandedText())this.editor.setText(text);this.live=undefined;this.notice='请求未启动，原稿已保留。输入 /pi 查看 Pi 命令行，或重试。';}this.refresh();}},1500);this.refresh();
 }
 event(e:any){if(!this.alive)return;if(['message_end','agent_settled'].includes(e.type))this.entriesDirty=true;
 // 内核日志风秒戳：活动流每行带相对本回合起点的 +s 时间。
 const stamp=()=>`+${((Date.now()-(this.requestStartedAt||Date.now()))/1000).toFixed(1)}s`;
 if(e.type==='agent_start'){clearInterval(this.spinnerTimer);this.spinnerTimer=setInterval(()=>this.refresh(),150);if(!this.requestStartedAt)this.requestStartedAt=Date.now();this.firstTokenAt=0;this.sawStart=true;this.sending=true;this.activity=[];this.notice='Kepos 正在执行 · 输入并 Enter 即排队 · Ctrl+X 中止';}
 if(e.type==='tool_execution_start'){this.activity.push(`▸ ${stamp()} ${clean(e.toolName)}${e.args?' '+clean(JSON.stringify(e.args)).slice(0,120):''}`);this.activity=this.activity.slice(-8);this.thinking=false;this.notice='正在调用 '+clean(e.toolName);}
 if(e.type==='tool_execution_update'){this.activity.push(`┊ … ${clean(e.toolName)} 返回中`);this.activity=this.activity.slice(-8);}
 if(e.type==='tool_execution_end'){this.activity.push(`${e.isError?'✕':'✓'} ${stamp()} ${clean(e.toolName)}${e.durationMs?' · '+Math.round(e.durationMs/100)/10+'s':''}`);this.activity=this.activity.slice(-8);}
 if(e.type==='message_update'&&e.assistantMessageEvent?.type==='text_delta'&&!this.firstTokenAt){this.firstTokenAt=Date.now();this.activity.push(`· ${stamp()} 首文本`);}
 if(e.type==='message_start'||e.type==='message_update'||e.type==='message_end'){ if(e.type==='message_update'&&e.assistantMessageEvent?.type?.startsWith('thinking')){this.thinking=true;this.notice='Kepos 正在整理思路…';}if(e.type==='message_end'&&e.message?.role==='assistant')this.thinking=false;if(e.message)this.live=e.message;if(e.type==='message_end'&&e.message?.role==='assistant'&&(e.message.stopReason==='error'||e.message.errorMessage)){if(!this.editor.getExpandedText())this.editor.setText(this.lastSubmitted);this.notice='模型请求失败，原稿已保留：'+clean(e.message.errorMessage||'未知错误');}}
 if(e.type==='message_end')this.metricsDirty=true;
 if(e.type==='agent_settled'){clearInterval(this.spinnerTimer);this.metricsDirty=true;if(this.requestStartedAt){this.lastTurnMetrics={ttftMs:this.firstTokenAt?this.firstTokenAt-this.requestStartedAt:0,totalMs:Date.now()-this.requestStartedAt};this.activity.push(`· 回合完成 · ${this.lastTurnMetrics.totalMs}ms`);}this.sending=false;this.live=undefined;this.notice=e.aborted?'任务已中止。':this.editor.getExpandedText()===this.lastSubmitted?'本次请求未成功，原稿已保留；可重试或调整后发送。':'Kepos 已完成。可继续对话。';}
 if(e.type==='tool_execution_start')this.notice='正在调用 '+clean(e.toolName);
 if(e.type==='tool_execution_end'&&e.isError)this.notice='工具失败：'+clean(e.toolName);
 this.refresh();}
 finish(action?:Action){if(!this.alive||this.actionBusy)return;if(action&&this.onAction&&!['switch','reload','abort','native-exit','pi'].includes(action.kind)){this.actionBusy=true;this.config.drafts[this.sessionKey()]=this.editor.getExpandedText();try{saveConfig(this.config);}catch{}void this.onAction(action).catch(error=>{this.notice='操作失败：'+clean(error);this.refresh();}).finally(()=>{this.actionBusy=false;this.refresh();});return;}this.alive=false;clearTimeout(this.draftTimer);clearTimeout(this.completionTimer);clearTimeout(this.renderTimer);clearInterval(this.spinnerTimer);this.config.drafts[this.sessionKey()]=this.editor.getExpandedText();try{saveConfig(this.config)}catch{}this.done(action);}
 dispose(){if(this.alive){this.alive=false;clearTimeout(this.draftTimer);clearTimeout(this.completionTimer);clearTimeout(this.renderTimer);clearInterval(this.spinnerTimer);try{saveConfig(this.config)}catch{}}}
 history(width:number){const preview=this.preview();let entries:any[];
 try{if(preview){if(!this.previewCache.has(preview.path))this.previewCache.set(preview.path,SessionManager.open(preview.path).getBranch());entries=this.previewCache.get(preview.path)!;}else{const key=this.sessionKey();if(this.entriesDirty||!this.entriesCache||key!==this.entriesKey){this.entriesCache=this.ctx.sessionManager.getBranch();this.entriesKey=key;this.entriesDirty=false;}entries=this.entriesCache!;}}catch(e){return ['读取历史失败：'+clean(e)];}
 const key=[preview?.path||this.sessionKey(),width,entries.length,this.toolMode,entries[entries.length-1]?.id||entries[entries.length-1]?.message?.timestamp||''].join('|');
 if(key!==this.historyCacheKey){this.historyCache=historyLines(entries,width,this.toolMode,this.theme);this.historyCacheKey=key;}
 // While the assistant reply streams, its message mutates in place inside the branch.
 // The cached lines would keep the stale (often empty) snapshot, and the fallback
 // below skips messages already present in the branch — together that hid all
 // streaming text until message_end. Render the in-flight message fresh each frame.
 if(!preview&&this.sending&&this.live?.role==='assistant'){
  const liveEntry=entries.find(e=>e.message===this.live||(e.message?.role===this.live.role&&e.message?.timestamp===this.live.timestamp));
  if(liveEntry){
   const baseKey='live|'+key;
   if(baseKey!==this.liveBaseCacheKey){this.liveBaseCache=historyLines(entries.filter(e=>e!==liveEntry&&e.message!==this.live),width,this.toolMode,this.theme);this.liveBaseCacheKey=baseKey;}
   const base=this.liveBaseCache[0]?.startsWith('尚无消息。')?[]:this.liveBaseCache;
   return [...base,...historyLines([{type:'message',message:this.live}],width,this.toolMode,this.theme)];
  }
 }
 if(!preview&&this.live&&!(this.live.role==='custom'&&this.live.display===false)&&!entries.some(e=>e.message===this.live||(e.message?.role===this.live.role&&e.message?.timestamp===this.live.timestamp))){const base=this.historyCache[0]?.startsWith('尚无消息。')?[]:this.historyCache;return [...base,...historyLines([{type:'message',message:this.live}],width,this.toolMode,this.theme)];}
 return this.historyCache;
 }
 render(width:number):string[]{const begin=performance.now();try{return this.paintPage(this.renderFrame(width),width);}catch(error){
  // Pi does not guard overlay rendering; a thrown frame would end the whole process.
  if(this.graphView){this.graphView=false;this.graphDetail=false;}
  const message=clean(error instanceof Error?error.message:error);this.notice='界面渲染出错：'+message;
  return [fit('Kepos 界面渲染出错，已退回议案：'+message,Math.max(1,width)),fit('按任意键重绘；问题持续时请报告此行。',Math.max(1,width))];
 }finally{this.renderMetrics.observe(performance.now()-begin);}}
 // 铺页面底色：Kepos 此前从不画背景，浅色主题只在深色终端底上把文字变深，
 // 于是"浅色主题"看起来大面积发黑。让页面底色由主题决定，而不是由终端决定。
 // 关键：行内每个 theme.bg() 都以 \x1b[49m（恢复终端默认背景）结尾，内层一闭合，
 // 后面的空隙就掉回终端黑底。做法是取出页面底色的开序列，把行内所有 \x1b[49m
 // 替换成它，再在行首补一次——每格都有明确背景，不依赖终端默认值。
 private paintPage(lines:string[],width:number):string[]{
  const theme=this.theme;if(!theme?.bg)return lines;
  const probe=theme.bg('userMessageBg','\u0000');
  const open=probe.slice(0,probe.indexOf('\u0000'));
  if(!open)return lines;
  const w=Math.max(1,width);
  return lines.map(line=>{
   const pad=' '.repeat(Math.max(0,w-visibleWidth(line)));
   const restored=(line+pad).replace(/\x1b\[49m/g,open);
   return open+restored;
  });
 }
 // 书案预算条：双色，空余段 dim，避免 0% 被读成满格。终态无 ended 的旧记录冻结在上限，绝不拿当前时间继续累计。
 budgetBar(task:any){const done=terminalStates.has(task.status||'');const end=task.ended||(done?task.started+Math.max(1,task.limit||300)*1000:Date.now());const pct=Math.max(0,Math.min(100,Math.round((end-task.started)/Math.max(1,(task.limit||300)*1000)*100)));const filled=Math.max(0,Math.min(10,Math.round(pct/10)));return this.theme.fg(task.stalled?'warning':'accent','▓'.repeat(filled))+this.theme.fg('dim','░'.repeat(10-filled))+' '+pct+'%';}
 // 模型绑定：一律读议案配置（分派时冻结的 task.model，缺席时回退代表配置），代表自述不作为来源。
 boundModel(task:any){const agents:any[]=this.config.agents||[];const agent=task?(agents.find(a=>a.id===task.agentId)||agents.find(a=>a.name===task.agent)):undefined;return clean(task?.model||agent?.model||'—');}
 // 书案花费行：已用 token / 预算上限 + 估算费用 + 上下文缓存命中。
 // 预算按单个任务计，任务结束即冻结——不会跨任务累计。
 spendText(task:any){
  const u=task?.usage;
  if(!u||!(u.totalTokens||u.input||u.output))return '尚未产生用量';
  const used=Number(u.totalTokens)||((Number(u.input)||0)+(Number(u.output)||0)+(Number(u.cacheRead)||0));
  const cap=Number(task?.budgetTokens)||0;
  const parts=[`${formatTokens(used)}${cap?` / ${formatTokens(cap)}`:''} tokens`];
  if(cap){
   const pct=Math.max(0,Math.min(100,Math.round(used/cap*100)));
   parts.push(`${pct}%`);
  }
  const cost=Number(u.cost?.total);
  if(cost>0)parts.push(`~$${cost.toFixed(4)}`);
  const cache=Number(u.cacheRead)||0;
  if(cache>0)parts.push(`缓存命中 ${Math.round(cache/Math.max(1,cache+(Number(u.input)||0))*100)}%`);
  return parts.join(' · ');
 }
 // 书案与议案同源：优先读 pool 全量任务，跨会话走 monitor evidence，快照（审批行）只作兜底。
 // 环图快照的 output 曾被砍到 160 字符，议会因此看不到真实产出——数据必须与 F3 同一来源。
 private deskTask(snapshot:GraphViewSnapshot):any{
  const taskId=this.councilDeskTaskId;
  const live=(this.pool.tasks as any[]).find(t=>t.id===taskId);
  if(live)return live;
  const global=this.monitorData().tasks.find((t:any)=>t.id===taskId);
  if(global){const evidence=this.monitor?.evidence(global.id);return evidence||global;}
  return snapshot.tasks.find((t:any)=>t.id===taskId);
 }
 // 书案内嵌输入：选中即输入，Enter 直达该代表（运行中转发；已结束按原配置开新一轮）。
 deskSend(){
  const text=this.editor.getExpandedText().trim();if(!text){this.refresh();return;}
  const hit=this.graphHits.find(item=>item.index===this.graphSelected);
  const taskId=hit?.taskId??this.councilDeskTaskId;
  const task=this.pool.tasks.find(t=>t.id===taskId)||this.monitorData().tasks.find((t:any)=>t.id===taskId);
  const agentKey=task?.agentId||task?.agent||(hit?.id?.startsWith('agent:')?hit.id.slice(6):undefined);
  const parent=this.ctx.sessionManager.getSessionId();
  const handle=taskId?this.pool.liveHandle?.(taskId,parent):undefined;
  if(handle){
   void this.pool.sendMessage(handle,parent,text).then((outcome:any)=>{
    if(outcome.delivered){this.editor.setText('');this.savedDraftBeforeCommand='';this.notice=`已送达 ${outcome.agent||task?.agent||taskId}${outcome.queued?'（排队中）':''}`;}
    else this.notice='转发失败：'+(outcome.error||'未知原因')+'（原稿保留）';
    this.refresh();
   });
   this.refresh();return;
  }
  if(agentKey){this.finish({kind:'message-agent',id:String(agentKey),text});return;}
  this.notice='该席位没有可用的代表，无法送达';this.refresh();
 }
 // 右侧书案面板：不跳页，嵌在议会右侧；输入框嵌在面板底部，模型读议案配置绑定。
 private deskPanel(snapshot:GraphViewSnapshot,width:number,height:number,editorLines:string[]):string[]{
  const w=Math.max(30,width),inner=Math.max(8,w-4);
  const task=this.deskTask(snapshot);
  const agentName=task?.agent||this.councilDeskTaskId?.slice(0,8)||'—';
  // 乱码防线：进展/工具/状态可能混入 ANSI 残片和控制符（含换行），统一压成单行纯文本。
  const plainText=(value:any)=>stripVTControlCharacters(String(value??'')).replace(/\x1b\[[0-9;]*[A-Za-z]/g,' ').replace(/[\x00-\x1f\x7f-\x9f]+/g,' ').trim();
  const F=(color:string,s:string)=>this.theme.fg(color,s);
  const row=(content:string,color='text')=>F('borderAccent','│ ')+F(color,fit(content,inner))+F('borderAccent',' │');
  const lines:string[]=[];
  const titlePrefix=`╭─ 书案 · ${plainText(agentName)} `;
  lines.push(F('borderAccent',titlePrefix+'─'.repeat(Math.max(1,w-visibleWidth(titlePrefix)-1))+'╮'));
  if(!task){
   lines.push(row('该席位暂无书案 · 分派后此处实时更新','dim'));
   lines.push(row('模型 — · 议案绑定','dim'));
  }else{
   lines.push(row(`状态 ${stateMark(task)} ${plainText(task.status||task.state||'—')}${task.reviewDue?' · ⚠ 需复核':''}`,safeStateColor(stateColor(task,0))));
   lines.push(row(`模型 ${this.boundModel(task)} · 议案绑定`));
   // 花费：本任务已用 token / 预算上限，外加估算费用。预算是单任务额度，
   // 新任务从 0 重新计，所以这里读到的永远是"这一轮花了多少"。
   lines.push(row(`花费 ${this.spendText(task)}`,`text`));
   if(task.tool)lines.push(row(`工具 ${plainText(task.tool)}`,'dim'));
   if(task.checkpoint)lines.push(row(`进展 ${plainText(task.checkpoint)}`,'dim'));
   if(task.error)for(const l of wrapTextWithAnsi('错误：'+plainText(task.error),inner).slice(0,2))lines.push(row(l,'error'));
  }
  // 产出区高度 = 面板高 - 头部 - 分隔线 - 输入框 - 底框；放不下就整体让给输入框。
  const cap=Math.max(0,height-lines.length-editorLines.length-2);
  if(cap>0){
   lines.push(F('borderAccent','├'+'─'.repeat(w-2)+'┤'));
   const fingerprint=task?`${task.id}|${String(task.output||'').length}|${inner}|${String(task.output||'').slice(-40)}`:'';
   if(fingerprint!==this.deskWrapKey){this.deskWrapKey=fingerprint;this.deskWrapCache=task?String(task.output||'等待输出…').split('\n').flatMap(s=>wrapTextWithAnsi(plainText(s)||' ',inner)).slice(-400):[];}
   const out=this.deskWrapCache||[];
   this.deskOutputTotal=out.length;this.deskOutputVisible=cap;
   const maxOffset=Math.max(0,out.length-cap);
   this.deskOffset=Math.max(0,Math.min(this.deskOffset,maxOffset));
   const end=out.length-this.deskOffset;
   const shown=out.slice(Math.max(0,end-cap),end);
   for(const l of shown)lines.push(row(l));
   while(lines.length<height-editorLines.length-1)lines.push(row(''));
  }else{this.deskOutputTotal=0;this.deskOutputVisible=0;}
  for(const l of editorLines)lines.push(F('borderAccent','│ ')+fit(l,inner)+F('borderAccent',' │'));
  const hint=this.deskOffset>0?` ↑ 已上滚 ${this.deskOffset}/${Math.max(0,this.deskOutputTotal-this.deskOutputVisible)} 行 · 滚轮下滚回底 `:' Enter 直达该代表 · Esc 关书案 ';
  const hintPrefix='╰─ ';
  lines.push(F('borderAccent',hintPrefix)+F('dim',hint)+F('borderAccent','─'.repeat(Math.max(1,w-visibleWidth(hintPrefix)-visibleWidth(hint)-1))+'╯'));
  return lines.slice(0,height);
 }
 // 当前上下文：决定哪些键位提示可见（footer 与 F1 帮助共用同一判定）。
 ctxScope():Scope|'always'{
  if(this.graphView){if(this.councilDesk)return 'councilDesk';return this.graphFocus==='list'?'list':'council';}
  if(this.taskView||this.missionView)return 'task';
  return this.focus==='projects'?'projects':this.focus==='crew'?'crew':'input';
 }
 hintVisible(hint:KeyHint):boolean{
  const scope=this.ctxScope();
  if(hint.when==='always')return true;
  if(hint.when===scope)return true;
  // 议会是父上下文：书案/列表里仍保留议会级基础提示（Tab 等）。
  if(hint.when==='council')return scope==='councilDesk'||scope==='list';
  return false;
 }
 // 底栏：只取标记了 footer 的键位，按上下文裁剪；点击区域与标签同一份来源。
 footerHints(){return KEY_HINTS.filter(hint=>hint.footer&&this.hintVisible(hint));}
 helpLines(){return ['操作指南','','/ 输入：命令/Skill补全，未知命令不发送','/reload 真重载 · 原生命令必要时转交Pi','/pi 进入 Pi 命令行；输入 /kepos 重新打开议案','/theme 切换主题（默认 / 深色 / 浅色，即时生效）','F7 或 /copy：复制完整最新回答','正文拖选：松开自动复制；Shift拖选用终端','输入区：直接打字，Enter 发送','Shift+Enter：换行（依赖终端协议）','F6：输入 → 项目 → 代表席；议会内 席位 → 列表 → 输入','F10：打开 48 席议会','议会内：↑↓ 选席 · Enter 打开右侧书案（不跳页） · Esc 关书案 · Ctrl+X 取消选中任务','书案：选中即可直接输入，Enter 送达该代表（任务已结束则按原配置开新一轮）；滚轮滚动产出','议会输入（未开书案）：F6 切到输入后，选中席位时消息直达该代表 · 未选中发主 Agent','议会列表：Tab 或 F8 打开 · F8 换筛选（活跃/待处理/全部）','议会列表：/ 过滤关键词 · Enter 定位详情 · v 查看完整产出','F11：专注阅读（中栏最大化）','鼠标：点项目选择，双击会话进入','双击代表：查看其任务或配置','项目区：↑↓ 选择，Enter 展开/进入','PgUp/PgDn/滚轮：滚动历史（上滚即暂停跟随），Ctrl+End 回最新并恢复','F2：新项目 / 新对话 / 配置 / 推选代理总代 / 手动分派','Ctrl+K：命令面板（可搜索）','F3 当前会话 · F8 跨项目 · F9 长程计划','Ctrl+←/→：切换任务','F5：展开 / 折叠完整工具输出','F4：切换当前主 Agent 模型','Ctrl+X：议案中止整轮；议会取消选中任务','Esc：逐层返回：详情 → 列表 → 席位 → 议案','','代表：只读，默认每项 5 分钟、每 5 分钟复核，最多并行 48 个','超过 20 分钟必须由人类批准长程计划','配置不是任务，分派后才启动进程；48 个 Worker 槽位按队列调度','代理总代是推选兼任职务（F2 → 推选代理总代），不占代表席位','切换项目将切换真实工作目录','','/attach 附加文件：docx / pdf / pptx / xlsx / epub / zip / 图片 / 文本','/attach <路径> 直接附加；粘贴文件路径也会自动识别。发送后附件自动清空。','再次按 F1 关闭帮助。','','用量详情 '+usageText(this.metrics,this.ctx.getContextUsage?.(),this.ctx.model)];}
 private graphSnapshot():GraphViewSnapshot{return this.graph?.snapshot()||{agents:this.config.agents,tasks:this.pool.tasks as any};}
 private renderGraphFrame(width:number,rows:number):string[]{
  this.graphWidth=width;
  // 书案内嵌输入：选中即可输入，无需 F6 换焦点。
  this.editor.focused=this.focused&&(this.councilDesk||this.graphFocus==='input');
  // 书案在右：≥100 列时环图让出右侧面板宽，不再整屏跳转；输入框嵌在书案面板底部。
  const deskW=this.councilDesk?Math.max(34,Math.min(56,Math.floor(width*0.38))):0;
  const input=this.editor.render(deskW?Math.max(10,deskW-8):Math.max(8,width-2));
  const snapshot=this.graph?.snapshot()||{agents:this.config.agents,tasks:this.pool.tasks as any};
  const active=countActive(snapshot.tasks);const attention=countPending(snapshot.tasks);
  if(attention>this.pendingSeen&&this.graphView)this.notice=`有 ${attention} 项待处理 · F8 打开列表`;
  this.pendingSeen=attention;
  const councilMode=this.councilDesk?'书案':this.graphFocus==='ring'?'席位':this.graphFocus==='list'?'列表':'输入';
  const header=this.theme.fg('accent',fit(`-- ${councilMode} --  Kepos Communis · 议会  48席 · 活跃${active} · 待处理${attention} · ${Math.round(this.graphZoom*100)}% · ${this.councilDesk?'Esc 关书案 · 输入后 Enter 直达':this.help?'F1 关闭帮助':this.graphFocus==='input'?'F6 回席位 · F10 返回':this.graphFocus==='list'?'F6 席位 · Tab 回图 · F10 返回':'F6 输入 · Tab 列表 · F10 返回'}`,width));
  if(this.councilDesk&&width<100){
   // 窄屏放不下右侧面板：退回整屏书案（历史回退路径）。
   const task=snapshot.tasks.find((t:any)=>t.id===this.councilDeskTaskId);
   const agentName=task?.agent||this.councilDeskTaskId?.slice(0,8)||'—';
   const lines:string[]=[];
   lines.push(this.theme.fg('accent',fit(`── ${agentName} 书案 ──`,width)));
   lines.push(this.theme.fg('dim',fit(`状态 ${task?.status||task?.state||'—'} · 模型 ${this.boundModel(task)}（议案绑定） · 工具 ${task?.tool||'—'}`,width)));
   if(task?.error)lines.push(this.theme.fg('error',fit('错误：'+clean(task.error),width)));
   if(task?.checkpoint)lines.push(this.theme.fg('muted',fit('检查点：'+clean(task.checkpoint),width)));
   if(task?.output){lines.push('');for(const l of String(task.output).split('\n').slice(-20))lines.push(fit(l,width));}
   return lines.slice(0,rows);
  }
  if(this.help){this.graphHits=[];const help=this.helpLines();const avail=Math.max(1,rows-input.length-3);this.inputY=1+avail;
   return [header,...help.slice(0,avail),...input.map(line=>'› '+fit(line,Math.max(1,width-2))),this.theme.fg('muted',fit(this.notice,width))].slice(0,rows);}
  const graphHeight=deskW?Math.max(8,rows-5):Math.max(8,rows-input.length-4);
  // 窄屏放不下 sidebar：列表+详情占满，Tab 主动回环图。
  if(width<120&&this.councilList&&this.graphFocus!=='ring'){
   const filtered=councilTasks(snapshot,this.councilFilter,this.councilQuery);
   this.councilIndex=Math.max(0,Math.min(this.councilIndex,Math.max(0,filtered.length-1)));
   const list=renderCouncilList(filtered,width,graphHeight,this.councilIndex,this.theme);
   this.graphHits=[];this.inputY=1+list.rows.length;
   return [header,...list.rows,...input.map(line=>'› '+fit(line,Math.max(1,width-2))),this.theme.fg('muted',fit(this.notice,width))].slice(0,rows);}
  const council:CouncilView={list:this.councilList,filter:this.councilFilter,query:this.councilQuery,index:this.councilIndex,focus:this.graphFocus,desk:this.councilDesk};
  // 书案在右：环图让出右侧面板宽，且书案打开时环图内部 sidebar 让位。
  const graphArea=Math.max(24,width-deskW-(deskW?1:0));
  // motion 关闭时冻结时钟：审批锤等动效静态化，符号语义不变。
  const graph=renderGraph(snapshot,graphArea,graphHeight,this.graphSelected,this.graphZoom,this.theme,this.graphDetail,this.graphOffsets,this.config.motion===false?0:Date.now(),council);
  this.graphHits=graph.hits;
  // 稳定选中：以稳定节点 id 对准，快照里节点增删时选中不漂移。
  if(this.graphSelectedId){const at=this.graphHits.findIndex(item=>item.id===this.graphSelectedId);if(at>=0)this.graphSelected=at-1;else this.graphSelectedId=this.graphHits[this.graphSelected+1]?.id??null;}
  else this.graphSelectedId=this.graphHits[this.graphSelected+1]?.id??null;
  this.inputY=1+graph.lines.length;
  const noticeLine=this.theme.fg('muted',fit(this.notice,width));
  if(deskW){
   this.deskX=graphArea+1;this.deskWidth=deskW;
   const deskLines=this.deskPanel(snapshot,deskW,graph.lines.length,input);
   const merged:string[]=[];for(let i=0;i<deskLines.length;i++)merged.push(fit(graph.lines[i]||'',graphArea)+' '+deskLines[i]);
   // 书案模式下不渲染底部输入框：输入框已嵌入书案面板。
   return [header,...merged,noticeLine].slice(0,rows);
  }
  this.deskWidth=0;
  return [header,...graph.lines,...input.map(line=>'› '+fit(line,Math.max(1,width-2))),noticeLine].slice(0,rows);
 }
 private renderFrame(width:number):string[]{
 this.width=width;const strong=(s:string)=>this.theme.style?this.theme.style(s,{fg:'accent',bold:true}):this.theme.fg('accent',s);const rows=Math.max(1,this.tui.terminal.rows||30);if(this.graphView)return this.renderGraphFrame(width,rows);
 // 断点由正文最小宽度驱动：≥150 左24/中w-60/右30；120~149 左22/中w-70/右24；100~119 右24+单分隔；<100 单栏。
 // 正文宽度随窗口单调不减（109→110 列不再从 72 跳到 43）。maximize（F11）临时收起两侧。
 const roomy=width>=150;const wide=width>=120;const medium=width>=100;
 this.leftWidth=this.maximize?0:roomy?24:wide?22:0;this.rightWidth=this.maximize?0:roomy?30:wide?24:medium?24:0;this.centerWidth=Math.max(12,width-this.leftWidth-this.rightWidth-(this.leftWidth&&this.rightWidth?6:this.rightWidth?3:0));this.inputWidth=this.centerWidth;
 this.editor.focused=this.focused&&this.focus==='input';const editorLines=this.editor.render(Math.max(8,this.centerWidth-4));this.editorHeight=editorLines.length;const inputLines=editorLines;
 if(rows<18||width<24){const compact=this.editor.render(width);const block=[this.theme.fg('accent',fit(`${PRODUCT_NAME} · Enter发送 · Esc返回`,width)),...compact,this.theme.fg('muted',fit('扩大窗口可显示三栏 / F1帮助',width))];const padLines=Math.max(0,Math.floor((rows-block.length)/2));return [...Array(padLines).fill(' '.repeat(Math.max(1,width))),...block].slice(0,rows);}
 const headerHeight=2;this.bodyHeight=Math.max(1,rows-headerHeight-this.editorHeight-2);this.inputY=headerHeight+this.bodyHeight;this.narrow=!medium;
 const row:any=this.selectedRow();const preview=this.help||this.taskView||this.missionView?null:this.preview();const previewKey=preview?.path||this.sessionKey();if(previewKey!==this.lastPreview){this.readStart=null;this.lastPreview=previewKey;}
 const context=`${clean(basename(this.ctx.cwd))} / ${clean(this.ctx.sessionManager.getSessionName()||'未命名对话')}`;const modelLabel=(this.ctx.model?.provider&&this.ctx.model.id!=='unknown'?clean(this.ctx.model.provider)+'/':'')+clean(this.ctx.model?.id&&this.ctx.model.id!=='unknown'?this.ctx.model.id:'请先 /login');const model=`${modelLabel} · ${this.sending?'执行中':this.ctx.model?.id&&this.ctx.model.id!=='unknown'?'已配置 · 空闲':'待连接'}`;
 const badgeTasks=this.monitorData().tasks;const badgeRun=countActive(badgeTasks),badgePend=countPending(badgeTasks);const badgesRaw=(badgeRun?`  ● ${badgeRun} 运行`:'')+(badgePend?`  ⚠ ${badgePend} 待处理`:'');const badges=this.theme.fg('accent',badgeRun?`  ● ${badgeRun} 运行`:'')+this.theme.fg('warning',badgePend?`  ⚠ ${badgePend} 待处理`:'');
 // braille 发送指示，比原 ·:* 更有"进行中"的动感；motion 关闭时仍随时间转动（指示器而非动画装饰）。
 const frame=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'][Math.floor(Date.now()/120)%10];const brand=strong(` ${PRODUCT_NAME} `)+(this.sending?this.theme.fg('accent',frame+' 执行中 '+((Date.now()-this.requestStartedAt)/1000).toFixed(1)+'s '):'');const gap=Math.max(1,width-visibleWidth(brand)-visibleWidth(context)-visibleWidth(model)-visibleWidth(badgesRaw)-4);const header=[truncateToWidth(brand+' '.repeat(gap)+this.theme.fg('muted',context)+'  '+this.theme.fg(this.sending?'accent':'success',model)+badges,width),this.theme.fg('borderMuted','─'.repeat(width))];
 let history=this.history(Math.max(8,this.centerWidth-4));
 if(history.length===1&&history[0].startsWith('尚无消息。')&&!this.live){const inner=['',PRODUCT_NAME+' · 议案','把目标交给主 Agent，把执行过程掌握在手里。','', '项目  '+clean(this.ctx.cwd),this.ctx.model?.id&&this.ctx.model.id!=='unknown'?'模型  '+clean(this.ctx.model.id):'尚未连接模型 · 输入 /login 开始','', '直接输入目标，Enter 开始','F2 配置专家与任务 · F3 当前会话','F8 跨项目监控 · F9 长程计划','F10 打开议会：48 席协作一目了然','', '子任务默认 5 分钟；超过 20 分钟需进入计划并经你批准。'];const bw=Math.max(8,this.centerWidth-4);const fill=Math.max(1,bw-visibleWidth('─ Kepos 议案 ')-2);history=[this.theme.fg('borderMuted','╭─ '+strong('Kepos 议案')+' '+'─'.repeat(fill)+'╮'),...inner.map(l=>this.theme.fg('borderMuted','│ ')+fit(l,bw-4)+this.theme.fg('borderMuted',' │')),this.theme.fg('borderMuted','╰'+'─'.repeat(Math.max(1,bw-2))+'╯')];}

 if((this.sending||this.activity.length||this.thinking)&&!this.help&&!this.taskView&&!this.missionView)history=[...history,'',...(this.thinking?['┊ 正在整理思路…']:[]),...this.activity];
 if(this.help)history=this.helpLines();
 if(this.taskView&&!this.help){const tasks=this.panelTasks();this.taskIndex=Math.max(0,Math.min(this.taskIndex,Math.max(0,tasks.length-1)));let task=tasks[Math.min(this.taskIndex,Math.max(0,tasks.length-1))];
 if(task&&this.taskScope==='all'&&this.monitor){if(!this.evidenceCache||this.evidenceCache.id!==task.id||this.evidenceCache.ended!==task.ended||(!task.ended&&Date.now()-this.evidenceAt>1000)){this.evidenceAt=Date.now();this.evidenceCache={id:task.id,ended:task.ended,output:task.output,value:this.monitor.evidence(task.id)};}task=this.evidenceCache.value||task;}
 history=task?[`${clean(task.agent)}书案 / `+(this.taskIndex+1)+' / '+tasks.length,`${clean(task.agent)} · ${task.status}`, '项目：'+clean(task.cwd), '父会话：'+clean(task.parentSessionId), '配置版本：'+String(task.profileRevision||'旧记录').slice(0,12), '工具：'+clean(task.tool||'—'),...(task.reviewAt?['复核：'+(task.reviewDue?'现在需要主 Agent 检查':'下一次 '+new Date(task.reviewAt).toLocaleTimeString())+' · 已复核 '+String(task.reviewCount||0)+' 次']:[]),...(task.stalled?['⚠ 疑似空转：是否终止由人类决定（F2 → 查看/取消运行中任务）']:[]),...(task.budgetTokens?['Token 预算上限：'+formatTokens(task.budgetTokens)]:[]),...(task.checkpoint?['最近检查点：',...wrapTextWithAnsi(clean(task.checkpoint),Math.max(8,this.centerWidth-4))]:[]), ...(task.queueWaitMs!==undefined?['排队 '+task.queueWaitMs+'ms · 首文本 '+(task.firstTextMs??'待返回')+'ms']:[]),`⏳ ${this.budgetBar(task)} · ${task.ended?Math.round((task.ended-task.started)/1000)+'s':terminalStates.has(task.status||'')?'耗时未记录':Math.round((Date.now()-task.started)/1000)+'s'} / 上限 ${task.limit}s`,`${clean(task.provider)} / ${clean(task.model)}`,...(task.usage?.totalTokens?[`Token ↑${formatTokens(task.usage.input)} ↓${formatTokens(task.usage.output)}${task.usage.cacheHitPercent(task.usage)>0?' · 缓存命中'+cacheHitPercent(task.usage)+'%':''}${task.usage.cost?.total?' · ~$'+Number(task.usage.cost.total).toFixed(4):''}`]:[]),...wrapTextWithAnsi(clean(task.title),Math.max(8,this.centerWidth-4)),'',...(task.error?wrapTextWithAnsi('错误：'+clean(task.error),Math.max(8,this.centerWidth-4)):[]),task.outputTruncated?'任务产出（已截断，保留末尾约32 KiB）：':'任务产出：',...String(task.output||'等待输出…').split('\n').flatMap(s=>wrapTextWithAnsi(clean(s),Math.max(8,this.centerWidth-4)))]:[this.taskScope==='all'?'全局任务 · 暂无子 Agent 任务':'本会话暂无子 Agent 任务。','F2 → 分派只读任务，或让主 Agent 自动分派。'];}
 if(this.missionView&&!this.help){const plans=this.monitorData().plans;history=['长程计划 · 人类控制台','F9 返回 · F2 → 管理长程计划','',...plans.flatMap(plan=>[`${plan.state} · ${plan.completed}/${plan.total} · ${plan.goal}`, '  '+plan.id+' · '+clean(plan.cwd),''])];if(!plans.length)history.push('暂无计划。主 Agent 可以用 kepos_plan 拆解并提交。');}
 this.displayLines=history;
 // 框线面板：body 含顶底两行框，内容行 bodyHeight-2；标题嵌入顶框，焦点面板用 borderAccent。
 const contentRows=Math.max(1,this.bodyHeight-2);const historyHeight=Math.max(1,contentRows-(preview?2:0));
 if(this.readStart===null)this.latestEntries=history.slice(-historyHeight);else{this.readStart=Math.max(0,Math.min(this.readStart,Math.max(0,history.length-historyHeight)));this.latestEntries=history.slice(this.readStart,this.readStart+historyHeight);}
 const crewVisibleCount=Math.max(1,Math.floor(Math.max(1,contentRows-5)/3));this.crewOffset=Math.max(0,Math.min(this.crewOffset,Math.max(0,this.config.agents.length-crewVisibleCount)));if(this.crewIndex<this.crewOffset)this.crewOffset=this.crewIndex;if(this.crewIndex>=this.crewOffset+crewVisibleCount)this.crewOffset=this.crewIndex-crewVisibleCount+1;const visibleCrew=this.config.agents.slice(this.crewOffset,this.crewOffset+crewVisibleCount);const dividerLeft=this.theme.fg('dim','┄'.repeat(Math.max(1,this.leftWidth-4)));const dividerRight=this.theme.fg('dim','┄'.repeat(Math.max(1,this.rightWidth-4)));const left=[this.theme.fg('accent',`● 议会 · ${this.sending?'工作中':'就绪'}`),this.theme.fg('dim',this.ctx.model?.id&&this.ctx.model.id!=='unknown'?(this.ctx.model?.provider?clean(this.ctx.model.provider)+'/':'')+clean(this.ctx.model.id):'尚未登录'),dividerLeft,...visibleCrew.flatMap((a,i)=>{const index=this.crewOffset+i;const task=[...this.sessionTasks()].reverse().find(t=>t.agent===a.name);const running=task&&!terminalStates.has(task.status||'');const color=task?safeStateColor(stateColor(task as any,0)):'muted';const mark=task?stateMark(task as any):'○';const picked=this.focus==='crew'&&this.crewIndex===index;return [this.theme.fg(picked?'accent':color,picked?'›':mark)+' '+clean(a.name)+(running&&task?.started?this.theme.fg('dim',` · ${Math.max(1,Math.round((Date.now()-task.started)/1000))}s`):''),this.theme.fg(task?color:'dim',`  ${task?.status||'未分派'}${task?.title?' · '+clean(task.title):''}`),this.theme.fg('toolTitle',`    ${clean((a.model||'').split('/').pop()||'未配置模型')}`)];}),...(this.config.agents.length>crewVisibleCount?[this.theme.fg('dim',`  代表 ${this.crewOffset+1}-${Math.min(this.config.agents.length,this.crewOffset+crewVisibleCount)} / ${this.config.agents.length}`)]:[]),this.theme.fg('dim','F2 添加/编辑/分派')];
 const list=this.rows();this.selected=Math.max(0,Math.min(this.selected,list.length-1));const available=Math.max(1,contentRows-2);if(this.selected<this.rightOffset)this.rightOffset=this.selected;if(this.selected>=this.rightOffset+available)this.rightOffset=this.selected-available+1;
 // Every row needs an explicit colour: the side panels are tinted, so a bare string inherits
 // the terminal default and can vanish on a light background.
 const right=[this.theme.fg('dim','F2 新项目 · 新对话'),dividerRight,...list.slice(this.rightOffset,this.rightOffset+available).map((r:any,i)=>{const selected=this.selected===this.rightOffset+i;const active=r.kind==='session'&&r.path===this.ctx.sessionManager.getSessionFile();const marker=r.kind==='project'?(this.folded.has(r.path)?'▸ ':'▾ '):active?'● ':'○ ';return this.theme.fg(selected?'accent':active?'success':'text',`${selected?'›':' '} ${marker}${clean(r.label)}`);})];
 this.visibleCenter=[];const body:string[]=[];const frameColor=(focused:boolean)=>focused?'borderAccent':'borderMuted';
 // 侧栏铺 card 底色（kepos-dark 的 toolSuccessBg 值等于 export.cardBg），中栏保持深底突出正文。
 const sideBg=(s:string)=>this.theme.bg?this.theme.bg('toolSuccessBg',s):s;
 // 焦点面板用双线框 + ◆ 标记，非焦点单线：视觉权重随焦点分级（btop 手法）。
 const frameLine=(w:number,title:string,top:boolean,focused:boolean)=>{const label=top?`${focused?'◆ ':'─ '}${title} `:'';const fill=Math.max(1,w-visibleWidth(label)-2);const c=frameColor(focused);const h=focused?'═':'─';
  if(top)return this.theme.fg(c,focused?'╔':'╭')+(label?this.theme.fg('accent',label):'')+this.theme.fg(c,h.repeat(fill)+(focused?'╗':'╮'));
  return this.theme.fg(c,(focused?'╚':'╰')+h.repeat(Math.max(1,w-2))+(focused?'╝':'╯'));};
 const panel=(w:number,content:string,focused:boolean)=>this.theme.fg(frameColor(focused),'│ ')+fit(content,Math.max(1,w-4))+this.theme.fg(frameColor(focused),' │');
 const tops=()=>this.leftWidth?sideBg(frameLine(this.leftWidth,`代表席 // ${this.config.agents.length}`,true,this.focus==='crew'))+'   '+frameLine(this.centerWidth,'主案',true,this.focus==='input')+'   '+sideBg(frameLine(this.rightWidth,`项目 / 对话 // ${this.rows().length}`,true,this.focus==='projects')):this.rightWidth?frameLine(this.centerWidth,this.focus==='crew'?`代表席 // ${this.config.agents.length}`:'主案',true,this.focus!=='projects')+'   '+sideBg(frameLine(this.rightWidth,`项目 / 对话 // ${this.rows().length}`,true,this.focus==='projects')):frameLine(width,this.focus==='projects'?'项目 / 对话':this.focus==='crew'?'代表席':'主案',true,true);
 const bottoms=()=>this.leftWidth?sideBg(frameLine(this.leftWidth,'',false,this.focus==='crew'))+'   '+frameLine(this.centerWidth,'',false,this.focus==='input')+'   '+sideBg(frameLine(this.rightWidth,'',false,this.focus==='projects')):this.rightWidth?frameLine(this.centerWidth,'',false,this.focus!=='projects')+'   '+sideBg(frameLine(this.rightWidth,'',false,this.focus==='projects')):frameLine(width,'',false,true);
 // 阅读位置可见：内容超高时在主案右内侧画比例滚动条（拇指 ▓ / 轨道 ·）。
 const totalLines=history.length;const hasScroll=totalLines>contentRows;const scrollPos=this.readStart===null?Math.max(0,totalLines-contentRows):this.readStart;const thumbH=Math.max(1,Math.round(contentRows*Math.min(1,contentRows/totalLines)));const thumbTop=Math.round((scrollPos/Math.max(1,totalLines-contentRows))*Math.max(0,contentRows-thumbH));
 const scrollGlyph=(j:number)=>j>=thumbTop&&j<thumbTop+thumbH?this.theme.fg('accent','▓'):this.theme.fg('dim','·');
 for(let i=0;i<this.bodyHeight;i++){
  if(i===0){body.push(tops());continue;}
  if(i===this.bodyHeight-1){body.push(bottoms());continue;}
  const j=i-1;const previewNote=!!preview&&j===contentRows-1;
  let center=preview?(j===0?'[只读预览] '+clean(preview.label):previewNote?'发送目标仍是当前会话 · 预览只读 · Enter 进入后才在此会话发送':this.latestEntries[j-1]||''):this.latestEntries[j]||'';
  if(this.selection?.active)center=this.selection.lines[j]||'';
  this.visibleCenter.push(center);
  const innerWidth=Math.max(1,this.centerWidth-4);
  const activityLine=/^(NEEDS_HUMAN|FAILED|SUCCEEDED|RUNNING|QUEUED|▸|✓|✕|  .*返回中|Kepos 正在)/.test(center);
  let centerStyled=previewNote?this.theme.fg('warning',fit(center,innerWidth)):activityLine?this.theme.fg(center.startsWith('NEEDS_HUMAN')?'warning':center.startsWith('✕')||center.startsWith('FAILED')?'error':center.startsWith('✓')||center.startsWith('SUCCEEDED')?'success':'accent',fit(center,innerWidth)):center==='Kepos'?strong(fit(center,innerWidth)):this.theme.fg('text',fit(center,innerWidth));
  if(this.selection&&this.theme.bg){const {anchor,end}=this.selection;const [a,b]=anchor.row<end.row||anchor.row===end.row&&anchor.col<=end.col?[anchor,end]:[end,anchor];if(j>=a.row&&j<=b.row){const start=j===a.row?a.col:0,stop=j===b.row?b.col:visibleWidth(center),plain=fit(center,innerWidth);centerStyled=this.theme.fg('text',sliceByColumn(plain,0,start))+this.theme.bg('selectedBg',this.theme.fg('text',sliceByColumn(plain,start,Math.max(0,stop-start))))+this.theme.fg('text',sliceByColumn(plain,stop,Math.max(0,innerWidth-stop)));}}
  const gap='   ';
  const centerBody=hasScroll?fit(centerStyled,innerWidth-2)+' '+scrollGlyph(j):centerStyled;
  if(this.leftWidth)body.push(sideBg(panel(this.leftWidth,left[j]||'',this.focus==='crew'))+gap+panel(this.centerWidth,centerBody,this.focus==='input')+gap+sideBg(panel(this.rightWidth,right[j]||'',this.focus==='projects')));
  else if(this.rightWidth)body.push(panel(this.centerWidth,this.focus==='crew'?this.theme.fg(j===0?'accent':'muted',fit(left[j]||'',innerWidth)):centerBody,this.focus!=='projects')+gap+sideBg(panel(this.rightWidth,right[j]||'',this.focus==='projects')));
  else{const narrowContent=this.focus==='projects'?right[j]||'':this.focus==='crew'?left[j]||'':center;const narrowBody=hasScroll?fit(narrowContent,Math.max(1,width-6))+' '+scrollGlyph(j):narrowContent;body.push(panel(width,narrowBody,true));}}
 // 附件条：有附件时压在输入框上方，随输入区同宽对齐，不打断主案阅读区。
 const attachBar=this.attachmentBar(Math.max(8,(this.leftWidth||this.rightWidth?this.centerWidth:width)-4))
  .map(line=>this.leftWidth?' '.repeat(this.leftWidth+3)+line+' '.repeat(this.rightWidth+3):this.rightWidth?line+' '.repeat(this.rightWidth+3):line);
 const input=[...attachBar,...inputLines.map(line=>this.theme.fg('borderMuted','│ ')+fit(line,Math.max(1,(this.leftWidth||this.rightWidth?this.centerWidth:width)-4))+this.theme.fg('borderMuted',' │')).map(line=>this.leftWidth?' '.repeat(this.leftWidth+3)+line+' '.repeat(this.rightWidth+3):this.rightWidth?line+' '.repeat(this.rightWidth+3):line)];
 // 底栏由键位表按上下文生成：标签与可点击区域同一份来源，不再手写第二遍。
 this.footerRegions=[];let footerText='';
 for(const hint of this.footerHints()){const start=visibleWidth(footerText);footerText+=hint.label+'   ';this.footerRegions.push({start,end:visibleWidth(footerText),key:hint.key});}
 footerText+=this.taskView?'Ctrl+←/→ 切换任务':'Ctrl+X 中止';
 const status=this.missionView?'计划监控 · F9 返回 · F2 管理与审批':this.help?'帮助 / 阅读模式 · F1 关闭 · F6 切换面板':this.taskView?'任务详情 · F8 切换全局/会话 · Ctrl+←/→ 切任务 · PgUp/PgDn 滚动产出 · F3 返回会话':preview?'只读预览 · 发送目标见正文提示 · F6 返回当前对话输入':this.maximize?'专注阅读 · F11 或 Esc 恢复面板':this.readStart!==null?'阅读历史 · 已暂停跟随 · Ctrl+End 回最新':this.focus==='input'?'输入区 · Enter 发送 · F10 议会 · F6 管项目':this.focus==='projects'?'项目区 · Enter 折叠/切换 · '+clean((row as any)?.session?.cwd||row?.path||this.ctx.cwd):'代表席 · ↑↓ 选择 · Enter 任务/配置 · F2 分派任务';
 if(this.metricsDirty){this.metrics=sessionUsage(this.ctx.sessionManager.getEntries?.()||this.ctx.sessionManager.getBranch());this.metricsDirty=false;}const contextUsage=this.ctx.getContextUsage?.();
 // 底栏两行：状态+短用量一行；临时 notice（4 秒自动退出）与按键提示一行。完整用量移入 F1 帮助。
 if(this._notice&&!this._noticeUrgent&&Date.now()-this.noticeAt>4000)this._notice='';
 // 双色进度条：已用段 accent/warning，空余段 dim——0% 时整条呈暗色，不会误读成满格。
 const pctKnown=!!contextUsage&&contextUsage.percent!==null&&contextUsage.percent!==undefined&&Number.isFinite(contextUsage.percent);const pct=pctKnown?Math.max(0,Math.min(100,Math.round(contextUsage.percent))):0;const pctFilled=pctKnown?Math.max(0,Math.min(10,Math.round(pct/10))):0;
 const usageBar=pctKnown?this.theme.fg(contextUsage.percent>=80?'warning':'accent','▓'.repeat(pctFilled))+this.theme.fg('dim','░'.repeat(10-pctFilled)):'';
 const usageShort=`上下文 ${pctKnown?usageBar+' '+pct+'%':'—'}${this.metrics.estimatedCost>0?' · ~$'+this.metrics.estimatedCost.toFixed(2):''}`;
 const statusLine=truncateToWidth(status,Math.max(1,width-visibleWidth(usageShort)-2))+'  '+usageShort;
 // 紧急通知要留出 "⚠ " 前缀的位置，否则加前缀后整行会超出宽度预算被硬裁。
 const noticeBudget=Math.max(8,Math.floor(width/2))-(this._noticeUrgent?2:0);
 const noticePart=this._notice?truncateToWidth(this._notice,Math.max(6,noticeBudget))+' · ':'';
 // 模式芯片（vim 风）：一眼看清当前面板/视图，CineTTY 同款状态栏语汇。
 const modeText='-- '+(this.missionView?'计划':this.help?'帮助':this.taskView?'书案':preview?'预览':this.maximize?'专注':this.readStart!==null?'阅读':this.focus==='input'?'输入':this.focus==='projects'?'项目':'代表')+' --';
 const modeChip=this.theme.style?this.theme.style(modeText,{fg:'accent',bold:true}):this.theme.fg('accent',modeText);
 // 审批模式常驻显示：此前只在 F2 菜单里能看到，操作时根本不知道自己处在哪种授权下。
 // 三态用不同的符号与颜色，缩小终端里也能一眼分辨：
 //   ⛨ 严格（默认，需要你逐次确认）  ◐ 代理（模型自主但留痕）  ○ 只读（模型不能改动）
 const policy=this.approvalPolicy?.()||'human';
 const policyChip=policy==='readonly'
  ?this.theme.fg('warning','○ 只读')
  :policy==='proxy'
   ?this.theme.fg('accent','◐ 代理')
   :this.theme.fg('success','⛨ 严格');
 const row1=modeChip+' '+policyChip+' '+this.theme.fg(contextUsage?.percent>=80?'warning':'accent',fitRight(statusLine,Math.max(1,width-visibleWidth(modeText)-visibleWidth('○ 只读')-4)));
 const prefixWidth=this._noticeUrgent&&noticePart?2:0;
 const row2=(noticePart?(this._noticeUrgent?this.theme.fg('warning','⚠ '+noticePart):this.theme.fg('muted',noticePart)):'')+this.theme.fg('dim',fit(footerText,Math.max(1,width-visibleWidth(noticePart)-prefixWidth)));
 return [...header,...body,...input,row1,row2];
 }
 async copyAnswer(){const entries=this.preview()?SessionManager.open(this.preview()!.path).getBranch():this.ctx.sessionManager.getBranch();const message=[...entries].reverse().find((e:any)=>e.type==='message'&&e.message?.role==='assistant'&&(typeof e.message.content==='string'?e.message.content:e.message.content?.some((b:any)=>b.type==='text')))?.message;const text=typeof message?.content==='string'?message.content:(message?.content||[]).filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('\n');if(!text){this.notice='暂无可复制的 Kepos 回答';this.refresh();return;}await this.copyText(text);}
 async copyText(text:string){try{await this.clipboard(text);if(this.alive){this.notice=`已复制 ${text.length} 字符到系统剪贴板`;this.refresh();}}catch(error){if(this.alive){this.notice='复制失败：'+clean(error)+'；可使用 Shift+拖选调用终端选择。';this.refresh();}}}
 selectedText(){if(!this.selection)return'';const {anchor,end,lines}=this.selection;const [a,b]=anchor.row<end.row||anchor.row===end.row&&anchor.col<=end.col?[anchor,end]:[end,anchor];return stripVTControlCharacters(lines.slice(a.row,b.row+1).map((line,i)=>sliceByColumn(line,i===0?a.col:0,Math.max(0,(a.row+i===b.row?b.col:visibleWidth(line))-(i===0?a.col:0))).trimEnd()).join('\n'));}
 handleInput(data:string){
 if(matchesKey(data,Key.f7)||matchesKey(data,'ctrl+shift+c')){void this.copyAnswer();return;}
 // 议会列表过滤输入：仅在该模式捕获键入，避免抢聊天输入。
 if(this.graphView&&this.councilSearch){if(matchesKey(data,Key.escape)){this.councilSearch=false;this.refresh();return;}if(matchesKey(data,Key.backspace)||data==='\x7f'||data==='\b'){this.councilQuery=this.councilQuery.slice(0,-1);this.councilIndex=0;this.refresh();return;}if(data.length===1&&data>=' '){this.councilQuery+=data;this.councilIndex=0;}this.refresh();return;}
 if(matchesKey(data,'f10')){this.graphView=!this.graphView;this.graphDetail=false;this.graphSelected=-1;this.graphZoom=1;this.graphFocus='ring';this.councilList=false;this.councilSearch=false;this.councilDesk=false;this.councilDeskTaskId=null;this.deskOffset=0;this.deskWrapKey='';this.focus='input';this.readStart=null;this.refresh();return;}
 if(matchesKey(data,'f11')){this.maximize=!this.maximize;this.notice=this.maximize?'专注阅读：中栏最大化 · F11 或 Esc 恢复':'已恢复面板';this.refresh();return;}
 if(matchesKey(data,Key.escape)&&this.focus==='input'&&this.editor.isShowingAutocomplete()){this.editor.handleInput(data);this.refresh();return;}
 if(matchesKey(data,Key.escape)){if(this.actionBusy)return;
  // 紧急通知优先吃掉这一次 Esc：先让你看清它，再按一次才继续逐层返回。
  if(this._noticeUrgent){this._noticeUrgent=false;this._notice='';this.refresh();return;}
  if(this.graphView){if(this.councilDesk){this.councilDesk=false;this.councilDeskTaskId=null;this.deskOffset=0;this.deskWrapKey='';this.notice='书案已关闭 · Enter 席位重新打开';this.refresh();return;}if(this.graphDetail){this.graphDetail=false;this.refresh();return;}if(this.graphFocus==='input'){this.graphFocus='ring';this.editor.focused=false;this.notice='议会席位焦点 · ↑↓ 选择 · Enter 书案 · F6 切面板';this.refresh();return;}if(this.graphFocus==='list'){this.graphFocus='ring';this.notice='议会席位焦点 · Tab 回列表';this.refresh();return;}if(this.councilList){this.councilList=false;this.notice='已关闭任务列表 · Tab 重新打开';this.refresh();return;}this.graphView=false;this.setFocus('input');this.notice='已回到议案';this.refresh();return;}if(this.maximize){this.maximize=false;this.notice='已恢复面板';this.refresh();return;}if(this.help||this.missionView||this.taskView||this.focus!=='input'){this.help=false;this.missionView=false;this.taskView=false;this.readStart=null;this.setFocus('input');this.notice='已回到议案';}else this.notice='已在议案；输入 /pi 进入 Pi 命令行';this.refresh();return;}
 if(matchesKey(data,'ctrl+c')){const selected=this.selectedText();if(selected){void this.copyText(selected);return;}this.notice='进入 Pi 命令行请使用 /pi；中止任务请按 Ctrl+X。';this.refresh();return;}
 if(matchesKey(data,'ctrl+x')&&this.graphView){const hit=this.graphHits.find(item=>item.index===this.graphSelected);if(hit?.taskId)this.finish({kind:'cancel-selected',id:hit.taskId});else{this.notice='选中席位没有可取消的任务 · 审批请用 F2 · Enter 查看详情';this.refresh();}return;}
 if(matchesKey(data,'ctrl+x')){this.finish({kind:'abort'});return;}
 // Tab 在席位图与任务列表间切换；F8 循环列表筛选并直达待处理。放在议案同名键之前。
 // 书案打开时右侧被占用：先关书案再切列表，避免出现不可见的列表焦点。
 if(this.graphView&&this.councilDesk&&(matchesKey(data,Key.tab)||matchesKey(data,Key.f8))){this.councilDesk=false;this.councilDeskTaskId=null;this.deskOffset=0;this.deskWrapKey='';this.notice='书案已关闭';}
 if(this.graphView&&matchesKey(data,Key.tab)){this.councilList=!this.councilList;this.graphFocus=this.councilList?'list':'ring';this.editor.focused=false;this.notice=this.councilList?'议会任务列表 · Tab 回环图':'议会席位图 · Tab 开列表';this.refresh();return;}
 if(this.graphView&&matchesKey(data,Key.f8)){this.councilList=true;this.graphFocus='list';this.councilFilter=this.councilFilter==='active'?'pending':this.councilFilter==='pending'?'all':'active';this.councilIndex=0;this.editor.focused=false;this.notice='议会列表 · 筛选：'+(this.councilFilter==='active'?'活跃':this.councilFilter==='pending'?'待处理':'全部')+' · / 过滤 · Enter 详情';this.refresh();return;}
 if(matchesKey(data,Key.f1)){this.help=!this.help;this.readStart=null;this.refresh();return;}
 if(matchesKey(data,Key.f2)){this.finish({kind:'menu'});return;}
 if(matchesKey(data,'ctrl+k')){this.finish({kind:'palette'});return;}
 if(matchesKey(data,Key.f3)){this.missionView=false;this.taskScope='session';this.taskView=!this.taskView;if(this.taskView)this.taskIndex=Math.max(0,this.sessionTasks().length-1);this.readStart=null;this.refresh();return;}
 if(matchesKey(data,Key.f8)){this.missionView=false;this.taskScope=this.taskScope==='all'?'session':'all';this.taskView=true;this.taskIndex=0;this.monitorAt=0;this.readStart=0;this.refresh();return;}
 if(matchesKey(data,Key.f9)){this.missionView=!this.missionView;this.taskView=false;this.help=false;this.monitorAt=0;this.readStart=0;this.refresh();return;}
 if(matchesKey(data,Key.f5)){this.expandedTools=!this.expandedTools;this.config.expandedTools=this.expandedTools;this.historyCacheKey='';try{saveConfig(this.config);}catch{}this.notice=this.expandedTools?'工具完整输出已展开（F5 收起）':'工具输出已折叠为一行摘要（F5 展开）';this.refresh();return;}
 if(matchesKey(data,Key.f4)){this.finish({kind:'model'});return;}
 if(matchesKey(data,Key.f6)){if(this.graphView&&this.councilDesk){this.graphFocus=this.graphFocus==='input'?'ring':'input';this.editor.focused=this.focused&&this.graphFocus!=='ring';this.notice=this.graphFocus==='input'?'书案输入 · Enter 直达该代表':'议会席位 · ↑↓ 选择 · Esc 关书案';this.refresh();return;}if(this.graphView){if(this.graphFocus==='ring'){this.graphFocus='list';this.councilList=true;this.editor.focused=false;this.councilIndex=Math.max(0,Math.min(this.councilIndex,Math.max(0,councilTasks(this.graphSnapshot(),this.councilFilter,this.councilQuery).length-1)));this.notice='议会任务列表 · ↑↓ 选择 · Enter 详情 · / 过滤';}
   else if(this.graphFocus==='list'){this.graphFocus='input';this.editor.focused=this.focused;this.notice='议会输入 · Enter 发送给主 Agent · Esc 回席位';}
   else{this.graphFocus='ring';this.editor.focused=false;this.notice='议会席位 · ↑↓ 选择 · Enter 详情 · Ctrl+X 取消任务';}
   this.refresh();return;}this.setFocus(this.focus==='input'?'projects':this.focus==='projects'?'crew':'input');this.readStart=null;return;}
 if(this.graphView&&this.graphFocus==='ring'&&matchesKey(data,Key.up)){this.graphSelected=Math.max(-1,this.graphSelected-1);this.graphSelectedId=this.graphHits[this.graphSelected+1]?.id??null;this.graphDetail=false;if(this.councilDesk){this.councilDeskTaskId=this.graphHits[this.graphSelected+1]?.taskId??null;this.deskOffset=0;this.deskWrapKey='';}this.refresh();return;}
 if(this.graphView&&this.graphFocus==='ring'&&matchesKey(data,Key.down)){const last=Math.max(0,this.graphHits.filter(hit=>hit.kind!=='main').length-1);this.graphSelected=Math.min(last,this.graphSelected+1);this.graphSelectedId=this.graphHits[this.graphSelected+1]?.id??null;this.graphDetail=false;if(this.councilDesk){this.councilDeskTaskId=this.graphHits[this.graphSelected+1]?.taskId??null;this.deskOffset=0;this.deskWrapKey='';}this.refresh();return;}
 if(this.graphView&&this.graphFocus==='list'&&matchesKey(data,Key.up)){this.councilIndex=Math.max(0,this.councilIndex-1);this.refresh();return;}
 if(this.graphView&&this.graphFocus==='list'&&matchesKey(data,Key.down)){this.councilIndex=Math.min(councilTasks(this.graphSnapshot(),this.councilFilter,this.councilQuery).length-1,this.councilIndex+1);this.refresh();return;}
 if(this.graphView&&this.graphFocus==='list'&&data==='/'&&!this.councilSearch){this.councilSearch=true;this.notice='列表过滤：输入关键词 · Esc 结束';this.refresh();return;}
 // 列表 Enter 定位到图上对应坐席并打开详情；v 进入完整产出阅读层。
 if(this.graphView&&this.graphFocus==='list'&&matchesKey(data,Key.enter)){const filtered=councilTasks(this.graphSnapshot(),this.councilFilter,this.councilQuery);const task=filtered[this.councilIndex];const hit=task?this.graphHits.find(item=>item.taskId===task.id):undefined;if(hit){this.graphSelected=hit.index;this.graphSelectedId=hit.id;this.graphDetail=true;this.refresh();}else{this.notice='当前画面没有这个坐席 · 窄屏请 Tab 回环图';this.refresh();}return;}
 if(this.graphView&&this.graphFocus==='list'&&data==='v'){const filtered=councilTasks(this.graphSnapshot(),this.councilFilter,this.councilQuery);const task=filtered[this.councilIndex];const at=task?this.panelTasks().findIndex(item=>item.id===task.id):-1;if(at>=0){this.graphView=false;this.graphDetail=false;this.taskScope='all';this.monitorAt=0;this.taskView=true;this.taskIndex=at;this.readStart=null;this.refresh();return;}this.notice='未找到该任务的完整产出';this.refresh();return;}
 // 议会内 Enter 只按焦点行事：席位焦点开详情（草稿不发送），输入焦点才发送。
 if(this.graphView&&this.graphFocus==='ring'&&matchesKey(data,Key.enter)){const hit=this.graphHits.find(item=>item.index===this.graphSelected&&item.taskId);if(hit?.taskId){this.councilDesk=true;this.councilDeskTaskId=hit.taskId;this.deskOffset=0;this.deskWrapKey='';this.graphDetail=false;this.councilList=false;this.graphFocus='input';this.editor.focused=this.focused;this.refresh();}else this.graphDetail=true;this.refresh();return;}
 // 书案 Enter：直接发给该代表（运行中转发；已结束按原配置开新一轮）。补全菜单打开时先让编辑器选词。
 if(this.graphView&&this.councilDesk&&matchesKey(data,Key.enter)){
  if(this.editor.isShowingAutocomplete()){this.editor.handleInput(data);this.refresh();return;}
  this.deskSend();return;
 }
 if(this.graphView&&this.graphFocus==='input'&&matchesKey(data,Key.enter)){
  // 选中运行中的席位时，消息直达该代表（Pi 把流式中的新消息排队）；未选中则发给主 Agent。
  const hit=this.graphHits.find(item=>item.index===this.graphSelected&&item.taskId);
  const text=this.editor.getExpandedText().trim();
  if(text&&hit){
   const parent=this.ctx.sessionManager.getSessionId();
   // sendMessage 是异步且需真实 capability（authorize 按哈希校验）：句柄必须向 pool 取活凭据。
   const handle=this.pool.liveHandle?.(hit.taskId,parent);
   if(!handle){this.notice='无法转发：拿不到该任务的活句柄（可能已结束）';this.refresh();return;}
   void this.pool.sendMessage(handle,parent,text).then((outcome:any)=>{
    if(outcome.delivered){this.editor.setText('');this.notice=`已转发给 ${outcome.agent||hit.taskId}${outcome.queued?'（排队中）':''}`;}
    else{this.notice='转发失败：'+(outcome.error||'未知原因')+'（原稿保留）';}
    this.refresh();
   });
   this.refresh();return;
  }
  this.send();return;
 }
 if(this.graphView&&this.graphFocus==='ring'&&(matchesKey(data,Key.pageUp)||matchesKey(data,Key.pageDown))){this.graphZoom=Math.max(.85,Math.min(1.6,this.graphZoom+(matchesKey(data,Key.pageUp)?0.1:-0.1)));this.refresh();return;}
 if(matchesKey(data,Key.pageUp)||matchesKey(data,Key.pageDown)){const lines=this.displayLines.length?this.displayLines:this.history(Math.max(8,this.centerWidth-4));this.readStart=Math.max(0,(this.readStart===null?Math.max(0,lines.length-this.bodyHeight):this.readStart)+(matchesKey(data,Key.pageUp)?-Math.max(1,this.bodyHeight-2):Math.max(1,this.bodyHeight-2)));if(this.readStart>=lines.length-this.bodyHeight)this.readStart=null;this.refresh();return;}
 if(matchesKey(data,'ctrl+end')){this.readStart=null;this.refresh();return;}
 if(this.taskView&&matchesKey(data,'ctrl+right')){this.taskIndex++;this.readStart=null;this.refresh();return;}
 if(this.taskView&&matchesKey(data,'ctrl+left')){this.taskIndex=Math.max(0,this.taskIndex-1);this.readStart=null;this.refresh();return;}
 // 粘贴文件路径自动识别：终端把拖入/粘贴的文件路径作为 bracketed paste 送来。
 // 只有当整段内容全是"存在的文件路径"时才转成附件——混入普通文字时保持文本，
 // 否则会把正常输入吞掉。
 if(this.focus==='input'&&!this.graphView&&!this.sending){
  const pasted=/^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
  if(pasted){
   const found=looksLikeFilePaths(pasted[1],this.ctx.cwd);
   if(found&&found.length){
    void this.attachCommand(found.map(path=>JSON.stringify(path)).join(' '),async()=>undefined);
    return;
   }
  }
 }
 if(this.graphView?(this.councilDesk||this.graphFocus==='input'):this.focus==='input'){this.editor.focused=this.focused;this.editor.handleInput(data);return;}
 if(matchesKey(data,Key.up)){if(this.focus==='projects')this.selected=Math.max(0,this.selected-1);else this.crewIndex=Math.max(0,this.crewIndex-1);this.readStart=null;}
 if(matchesKey(data,Key.down)){if(this.focus==='projects')this.selected=Math.min(this.rows().length-1,this.selected+1);else this.crewIndex=Math.min(this.config.agents.length-1,this.crewIndex+1);this.readStart=null;}
 if(matchesKey(data,Key.enter)){if(this.focus==='crew'){const agent=this.config.agents[this.crewIndex];const tasks=this.sessionTasks();let last=-1;tasks.forEach((t,i)=>{if(t.agent===agent?.name)last=i;});if(last>=0){this.taskView=true;this.taskIndex=last;this.readStart=null;this.refresh();return;}this.finish({kind:'crew',id:agent?.id});return;}const row=this.selectedRow();if(row?.kind==='project'){this.folded.has(row.path)?this.folded.delete(row.path):this.folded.add(row.path);this.config.folded=[...this.folded];this.rowCache=undefined;try{saveConfig(this.config)}catch(error){this.notice='配置保存失败：'+clean(error);}}else if(row?.kind==='session'){if(this.sending||!this.ctx.isIdle()){this.notice='先等待任务结束或 Ctrl+X 中止，再切换会话。';}else if(row.path===this.ctx.sessionManager.getSessionFile())this.setFocus('input');else{this.finish({kind:'switch',path:row.path});return;}}}
 this.refresh();
 }
 handleMouse(e:any){if(e.shift)return;
 if(this.graphView&&this.councilList&&this.graphWidth>=120&&e.x>=this.graphWidth-38){this.councilIndex=Math.max(0,this.councilIndex+Math.sign(e.wheelDelta||0));this.refresh();return{handled:true};}
 // 书案区滚轮：滚动产出（上滚看历史，下滚回底部），不触发环图缩放。
 if(this.graphView&&this.councilDesk&&this.deskWidth&&e.x>=this.deskX&&e.type==='wheel'){this.deskOffset=Math.max(0,this.deskOffset+(e.wheelDelta>0?3:-3));this.refresh();return{handled:true};}
 if(this.graphView&&e.type==='wheel'){this.graphZoom=Math.max(.85,Math.min(1.6,this.graphZoom+(e.wheelDelta>0?.1:-.1)));this.refresh();return{handled:true};}
 if(this.graphView&&this.graphDrag&&(e.type==='drag'||e.type==='release')){const deltaX=e.x-this.graphDrag.lastX,deltaY=(e.y-1)-this.graphDrag.lastY;const offset=this.graphOffsets[this.graphDrag.id]||{x:0,y:0};this.graphOffsets[this.graphDrag.id]={x:offset.x+deltaX,y:offset.y+deltaY};this.graphDrag.lastX=e.x;this.graphDrag.lastY=e.y-1;if(e.type==='release')this.graphDrag=undefined;this.refresh();return{handled:true,focus:true};}
 if(this.graphView&&e.y>=this.inputY&&e.type==='press'){this.graphFocus='input';this.setFocus('input');return{handled:true,focus:true};}
 if(this.graphView&&this.councilList&&this.graphWidth>=120&&e.x>=this.graphWidth-38&&e.type==='press'){this.graphFocus='list';this.editor.focused=false;this.refresh();return{handled:true,focus:true};}
 if(this.graphView&&(e.type==='click'||e.type==='press')){const hit=this.graphHits.find(item=>Math.abs(item.x-e.x)<=2&&Math.abs(item.y-(e.y-1))<=1);if(hit){this.graphFocus='ring';this.graphSelected=hit.kind==='main'?-1:hit.index;this.graphSelectedId=hit.id;if(this.councilDesk){this.councilDeskTaskId=hit.taskId??null;this.deskOffset=0;this.deskWrapKey='';this.graphDetail=false;this.graphFocus='input';this.editor.focused=this.focused;}else this.graphDetail=e.clickCount>=2;if(e.type==='press'&&hit.kind!=='main')this.graphDrag={id:hit.id,lastX:e.x,lastY:e.y-1};this.refresh();return{handled:true,focus:true,capture:e.type==='press'};}}
 // 点书案面板即聚焦输入：输入后 Enter 直达该代表。
 if(this.graphView&&this.councilDesk&&this.deskWidth&&e.x>=this.deskX&&e.type==='press'){this.graphFocus='input';this.setFocus('input');this.refresh();return{handled:true,focus:true};}
 const centerX=(this.leftWidth?this.leftWidth+3:0)+2;const inTranscript=e.y>=3&&e.y<this.inputY&&e.x>=centerX&&e.x<centerX+Math.max(1,this.centerWidth-4)&&this.focus!=='crew';
 if(e.type==='press'&&inTranscript&&e.button==='left'){this.selection={anchor:{row:e.y-3,col:e.x-centerX},end:{row:e.y-3,col:e.x-centerX},lines:[...this.visibleCenter],active:true};return{handled:true,capture:true};}
 if(this.selection?.active&&(e.type==='drag'||e.type==='release')){this.selection.end={row:Math.max(0,Math.min(this.bodyHeight-3,e.y-3)),col:Math.max(0,Math.min(Math.max(1,this.centerWidth-4),e.x-centerX))};if(e.type==='release'){this.selection.active=false;const text=this.selectedText();if(text)void this.copyText(text);}this.refresh();return{handled:true};}
 if((e.type==='click'||e.type==='press')&&e.y===(this.tui.terminal.rows||30)-1){const region=this.footerRegions.find(r=>e.x>=r.start&&e.x<r.end);if(region){if(e.type==='press')return{handled:true};const bytes=keyBytes[region.key];if(bytes)this.handleInput(bytes);return{handled:true};}}
 if(e.type==='wheel'&&this.leftWidth&&e.x<this.leftWidth){const visible=Math.max(1,Math.floor(Math.max(1,this.bodyHeight-7)/3));const maxOffset=Math.max(0,this.config.agents.length-visible);this.crewOffset=Math.max(0,Math.min(maxOffset,this.crewOffset+Math.sign(e.wheelDelta||0)));this.crewIndex=this.crewOffset;this.setFocus('crew');this.refresh();return{handled:true};}
 if(e.type==='wheel'){const lines=this.displayLines.length?this.displayLines:this.history(Math.max(8,this.centerWidth-4));this.readStart=Math.max(0,(this.readStart===null?Math.max(0,lines.length-this.bodyHeight):this.readStart)+(e.wheelDelta||0)*3);if(this.readStart>=lines.length-this.bodyHeight)this.readStart=null;this.refresh();return{handled:true};}
 if(e.type!=='press'&&e.type!=='click')return;
 if(e.y>=this.inputY&&e.y<this.inputY+this.editorHeight){this.setFocus('input');if(e.x>=this.leftWidth+(this.leftWidth?3:0)&&e.x<this.leftWidth+(this.leftWidth?3:0)+this.centerWidth)this.editor.handleMouse({...e,x:e.x-this.leftWidth-(this.leftWidth?3:0),y:e.y-this.inputY,width:this.centerWidth,height:this.editorHeight});return{handled:true,focus:true};}
 if(e.y>=3&&((this.rightWidth&&e.x>=this.width-this.rightWidth)||(!this.rightWidth&&this.focus==='projects'))){this.setFocus('projects');const index=e.y-5+this.rightOffset;if(index>=0&&index<this.rows().length){this.selected=index;if(e.type==='click'&&e.clickCount>=2)this.handleInput('\r');}this.refresh();return{handled:true,focus:true};}
 if(e.y>=3&&((this.leftWidth&&e.x<this.leftWidth)||(!this.leftWidth&&this.focus==='crew'))){this.setFocus('crew');const member=this.crewOffset+Math.floor((e.y-6)/3);if(member>=0&&member<this.config.agents.length){this.crewIndex=member;if(e.type==='click'&&e.clickCount>=2){const agent=this.config.agents[member];const tasks=this.sessionTasks();let last=-1;tasks.forEach((t,i)=>{if(t.agent===agent.name)last=i;});if(last>=0){this.taskView=true;this.taskIndex=last;this.readStart=null;this.refresh();}else this.finish({kind:'crew',id:agent.id});}}return{handled:true,focus:true};}this.setFocus('input');return{handled:true,focus:true};
 }
}
