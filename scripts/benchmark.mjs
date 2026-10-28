import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'kepos-render-bench-'));
process.env.ORBITAL_HOME=path.join(isolated,'orbital');
const {Desk}=await import('../dist/terminal/desk.js');
const {initTheme,Theme}=await import('@earendil-works/pi-coding-agent');
const {TimingWindow}=await import('../dist/terminal/metrics.js');
initTheme('dark');
const theme={fg:(_token,text)=>text,bg:(_token,text)=>text};
let reads=0;
const entries=Array.from({length:1000},(_,index)=>({type:'message',id:'m'+index,message:{role:index%2?'assistant':'user',timestamp:index+1,content:[{type:'text',text:`Entry ${index}\nImplementation evidence and a follow-up question.`}]}}));
const config={projects:[],agents:[],drafts:{},folded:[],sessionLinks:{}};
const ctx={cwd:isolated,isIdle:()=>true,model:{id:'fixture'},sessionManager:{getSessionFile:()=>path.join(isolated,'session.jsonl'),getSessionId:()=> 'benchmark',getSessionName:()=> 'benchmark',getBranch(){reads++;return entries;},getEntries:()=>entries}};
const desk=new Desk({terminal:{rows:45},requestRender(){}},theme,ctx,config,[],{tasks:[],children:new Map()},()=>{},()=>{});
const firstStart=performance.now();desk.render(150);const initialMs=performance.now()-firstStart;
const cached=new TimingWindow(500);for(let n=0;n<300;n++){const start=performance.now();desk.render(150);cached.observe(performance.now()-start);}
const streaming=new TimingWindow(200);for(let n=0;n<100;n++){
 desk.event({type:'message_update',message:{role:'assistant',timestamp:2000,content:[{type:'text',text:'Stream '+n}]}});
 const start=performance.now();desk.render(150);streaming.observe(performance.now()-start);
}
const report={created:new Date().toISOString(),node:process.versions.node,historyEntries:entries.length,initialRenderMs:initialMs,cachedRender:cached.snapshot(),streamingRender:streaming.snapshot(),historySourceReads:reads,modelCalls:0,note:'Synthetic local TUI timings; no provider/network/model TTFT is measured. Compare on the same machine and scenario.'};
console.log(JSON.stringify(report,null,2));
desk.dispose();
fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/render-benchmark.json',JSON.stringify(report,null,2)+'\n');
