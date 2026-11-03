import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {KeposDatabase}=await import('../dist/terminal/database.js');
const {
  duplicateDelegation, secondAsk, prematureDone, watchdogQuality, memoryQuality,
  collectMetrics, formatMetrics, METRICS,
}=await import('../dist/terminal/kpi.js');
const {MissionScheduler}=await import('../dist/terminal/scheduler.js');

function fresh(){
 const dir=mkdtempSync(join(tmpdir(),'kepos-kpi-'));
 return{db:new KeposDatabase(join(dir,'k.sqlite')),dir};
}
const agent={name:'A',model:'m',provider:'p',role:'r'};

// 写一条带终态 receipt 的任务，供比率类指标使用。
function task(db,{id,title,agent='A',parent='s1',state='SUCCEEDED',receipt=true}){
 db.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,?)').run(
  id,parent,'corr-'+id,'hash','epoch',state,
  JSON.stringify({id,agent,state,status:state,title,cwd:'.',session:'s',parentSessionId:parent,correlationId:'c-'+id,started:1,output:'',limit:60,model:'m',provider:'p',ownerPid:1,ownerEpoch:'e',tools:['read'],skills:[],mcp:false}),
  receipt?'{}':null);
}

test('duplicate delegation counts a title split across agents, per session',()=>{
 const{db}=fresh();
 try{
  // 同一会话同一目标派给两个代表 → 重复
  task(db,{id:'1',title:'审查鉴权中间件',agent:'A',parent:'s1'});
  task(db,{id:'2',title:'审查鉴权中间件',agent:'B',parent:'s1'});
  // 另一个标题只派给一个代表 → 不算
  task(db,{id:'3',title:'统计依赖数量',agent:'A',parent:'s1'});
  const result=duplicateDelegation(db);
  assert.equal(result.denominator,2,'two distinct titles');
  assert.equal(result.numerator,1,'one of them was duplicated');
  assert.match(result.note,/按任务组计/);
 }finally{db.close();}
});

test('the same title in two different sessions is not a duplicate delegation',()=>{
 const{db}=fresh();
 try{
  task(db,{id:'1',title:'审查鉴权',agent:'A',parent:'s1'});
  task(db,{id:'2',title:'审查鉴权',agent:'B',parent:'s2'});
  assert.equal(duplicateDelegation(db).numerator,0,'different sessions are independent work');
 }finally{db.close();}
});

test('second ask counts only finished tasks read twice',()=>{
 const{db}=fresh();
 try{
  task(db,{id:'1',title:'a'});
  task(db,{id:'2',title:'b'});
  task(db,{id:'3',title:'running',receipt:false});
  const read=(id,n)=>{for(let i=0;i<n;i++)db.prepare('INSERT INTO worker_events(worker_id,type,created,payload) VALUES(?,?,?,?)').run(id,'result_read',1,'{}');};
  read('1',2);read('2',1);read('3',5);   // 运行中的任务读再多次也不计入
  const result=secondAsk(db);
  assert.equal(result.denominator,2,'only tasks with a receipt');
  assert.equal(result.numerator,1);
 }finally{db.close();}
});

test('with no read events the metric says so instead of reporting a healthy 0%',()=>{
 const{db}=fresh();
 try{
  task(db,{id:'1',title:'a'});
  const result=secondAsk(db);
  assert.equal(result.value,'暂无事件');
  assert.match(result.note,/本版本起累积/);
 }finally{db.close();}
});

test('premature done only counts succeeded steps that actually carry acceptance',async()=>{
 const{db,dir}=fresh();
 const pool={children:new Map(),launch(a,text,dir2,session,seconds,signal,parent){return{version:1,workerId:'w1',parentSessionId:parent,capability:'f'};},result(){return{state:'SUCCEEDED',output:'done',resultHash:'h'};},cancelHandle(){return{state:'CANCELLED'};}};
 const scheduler=new MissionScheduler(db,pool);
 try{
  const withChecks=scheduler.enqueue({goal:'g',cwd:dir,parentSessionId:'p',jobs:[{id:'a',agent,task:'a',acceptance:['测试通过','无新增依赖']}]});
  const withoutChecks=scheduler.enqueue({goal:'g',cwd:dir,parentSessionId:'p',jobs:[{id:'b',agent,task:'b'}]});
  await scheduler.tick();
  await scheduler.tick();   // 第二拍才结算：第一拍派发，第二拍读回 receipt
  const result=prematureDone(db);
  assert.equal(result.denominator,1,'the step with no acceptance is not counted');
  assert.equal(result.numerator,1,'the succeeded step still has unmet items');
  assert.equal(result.value,'100%');
  // 勾满之后降为 0。
  scheduler.checkAcceptance(withChecks.id,'p','a',[1,2]);
  assert.equal(prematureDone(db).numerator,0);
  void withoutChecks;
 }finally{scheduler.stop();db.close();}
});

test('watchdog quality divides alarms, not tasks, and ignores progress',()=>{
 const{db}=fresh();
 try{
  task(db,{id:'1',title:'a',state:'SUCCEEDED'});
  task(db,{id:'2',title:'b',state:'FAILED'});
  const record=(id,verdict)=>db.prepare('INSERT INTO watchdog_verdicts(worker_id,at,verdict,reason,evidence_cursor,model) VALUES(?,?,?,?,?,?)').run(id,1,verdict,'r',1,'j');
  record('1','looping');record('1','looping');   // 同一任务两次告警 = 两次误报风险
  record('2','deviated');
  record('2','progress');                        // progress 不是告警
  const result=watchdogQuality(db);
  assert.equal(result.denominator,3);
  assert.equal(result.numerator,2);
 }finally{db.close();}
});

test('memory quality compares injected against never-injected and states it is correlation',()=>{
 const{db}=fresh();
 try{
  task(db,{id:'1',title:'a',state:'SUCCEEDED'});
  task(db,{id:'2',title:'b',state:'SUCCEEDED'});
  task(db,{id:'3',title:'c',state:'FAILED'});
  task(db,{id:'4',title:'d',state:'FAILED'});
  const mark=id=>db.prepare('INSERT INTO worker_events(worker_id,type,created,payload) VALUES(?,?,?,?)').run(id,'memory_injected',1,'{}');
  mark('1');mark('2');
  const result=memoryQuality(db);
  // 注入组 2/2 成功，未注入组 0/2 成功 → +100pp
  assert.equal(result.value,'+100pp');
  assert.match(result.note,/相关性，不是因果/);
 }finally{db.close();}
});

test('a metric with no samples admits it rather than reporting zero',()=>{
 const{db}=fresh();
 try{
  assert.equal(memoryQuality(db).value,'样本不足');
  assert.equal(duplicateDelegation(db).value,'样本不足');
  assert.equal(prematureDone(db).value,'暂无计划');
 }finally{db.close();}
});

test('collectMetrics runs all five and refuses an unknown name',()=>{
 const{db}=fresh();
 try{
  assert.equal(collectMetrics(db).length,5);
  assert.equal(METRICS.length,5);
  assert.equal(collectMetrics(db,'watchdog').length,1);
  assert.equal(collectMetrics(db,'Watchdog 误报')[0].name,'watchdog','labels work too');
  assert.throws(()=>collectMetrics(db,'nope'),/未知指标/);
  assert.match(formatMetrics(collectMetrics(db)),/重复委派/);
 }finally{db.close();}
});
