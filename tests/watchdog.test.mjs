import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {KeposDatabase}=await import('../dist/terminal/database.js');
const {
  WatchdogStore, parseVerdict, shouldJudge, verdictNotice, watchdogPrompt,
  WATCHDOG_VERDICTS, MAX_REASON_CHARS,
}=await import('../dist/terminal/watchdog.js');
const {watchdogAccuracy, watchdogNotes}=await import('../dist/terminal/monitor.js');

function fresh(){
 const dir=mkdtempSync(join(tmpdir(),'kepos-watchdog-'));
 return new KeposDatabase(join(dir,'kepos.sqlite'));
}

test('a verdict is stored with the cursor that produced it',()=>{
 const db=fresh();
 try{
  const store=new WatchdogStore(db);
  const record=store.record({workerId:'w1',verdict:'looping',reason:'重复读取同一文件三次',evidenceCursor:42,model:'judge',at:1000});
  assert.equal(record.seq>0,true);
  assert.equal(store.state('w1').cursor,42);
  assert.equal(store.state('w1').count,1);
  // 落库可回溯：原因与游标都在，人类能重放证据。
  const list=store.list('w1');
  assert.equal(list[0].reason,'重复读取同一文件三次');
  assert.equal(list[0].evidenceCursor,42);
 }finally{db.close();}
});

test('a bad or unknown verdict falls back to progress with a stated reason',()=>{
 // 坏输入按 progress：误报会让这个通道被关掉，宁可漏一次。
 assert.deepEqual(parseVerdict('{not json'),{verdict:'progress',reason:'判定返回无法解析，按推进处理'});
 assert.equal(parseVerdict('{"verdict":"weird","reason":"x"}').verdict,'progress');
 assert.equal(parseVerdict('{"verdict":"LOOPING","reason":"重复"}').verdict,'looping','case-insensitive');
 // 带代码围栏
 assert.deepEqual(parseVerdict('```json\n{"verdict":"deviated","reason":"在做别的事"}\n```'),{verdict:'deviated',reason:'在做别的事'});
 // 缺原因也能用，但会明说
 assert.equal(parseVerdict('{"verdict":"noisy"}').reason,'（未给出原因）');
 assert.ok(parseVerdict(`{"verdict":"noisy","reason":"${'长'.repeat(500)}"}`).reason.length<=MAX_REASON_CHARS);
 assert.equal(WATCHDOG_VERDICTS.length,4);
});

test('a review with no new events never calls the judge again',()=>{
 // 没有新事件时答案不会变，重复问只是白花钱。
 assert.equal(shouldJudge({eventCount:3,cursor:10,lastCursor:10,outputTail:'something'}),false);
 assert.equal(shouldJudge({eventCount:3,cursor:11,lastCursor:10,outputTail:''}),true);
 // 刚启动、没有事件也没有产出：没有可判断的东西。
 assert.equal(shouldJudge({eventCount:0,cursor:5,lastCursor:0,outputTail:'   '}),false);
});

// 阶段①：observe 只提示，progress 与 noisy 都不打扰人。
test('progress and noisy stay silent; deviated and looping speak up',()=>{
 const base={seq:1,workerId:'w',at:0,evidenceCursor:1,model:'judge'};
 assert.equal(verdictNotice({...base,verdict:'progress',reason:'新结论'}),undefined);
 assert.equal(verdictNotice({...base,verdict:'noisy',reason:'废话很多'}),undefined,'noise alone is not grounds for intervention');
 const deviated=verdictNotice({...base,verdict:'deviated',reason:'在处理另一个模块'});
 assert.match(deviated,/偏离任务/);
 assert.match(deviated,/在处理另一个模块/,'the reason is visible, not a black box');
 assert.match(deviated,/由你决定/,'the human keeps the decision');
 assert.match(verdictNotice({...base,verdict:'looping',reason:'重复'}),/原地打转/);
});

test('the judge prompt asks for one verdict and defaults to progress when unsure',()=>{
 const prompt=watchdogPrompt({workerId:'w',cursor:0,goal:'审查鉴权中间件',events:[{type:'tool_start',tool:'read',at:1}],outputTail:'正在读文件',elapsedMs:120000});
 assert.match(prompt,/审查鉴权中间件/);
 assert.match(prompt,/progress\|deviated\|looping\|noisy/);
 assert.match(prompt,/看不出来就判 progress/);
 assert.match(prompt,/严格 JSON/);
});

test('false-positive rate only counts alarms that ended in success',()=>{
 const db=fresh();
 try{
  const now=Date.now();
  const task=(id,state)=>db.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,NULL)').run(id,'parent','corr-'+id,'hash','epoch',state,JSON.stringify({id,agent:'A',state,status:state,title:'t',cwd:'.',session:'s',parentSessionId:'parent',correlationId:'c',started:now,output:'',limit:60,model:'m',provider:'p',ownerPid:1,ownerEpoch:'e',tools:['read'],skills:[],mcp:false}));
  const store=new WatchdogStore(db);
  // 两次误报（判了空转但任务最终成功）+ 一次真报（判了空转且失败）+ 一次 progress
  task('a','SUCCEEDED');store.record({workerId:'a',verdict:'looping',reason:'x',evidenceCursor:1,model:'j'});
  task('b','SUCCEEDED');store.record({workerId:'b',verdict:'deviated',reason:'y',evidenceCursor:1,model:'j'});
  task('c','FAILED');store.record({workerId:'c',verdict:'looping',reason:'z',evidenceCursor:1,model:'j'});
  task('d','FAILED');store.record({workerId:'d',verdict:'progress',reason:'ok',evidenceCursor:1,model:'j'});
  const stats=watchdogAccuracy(db);
  assert.equal(stats.alarms,3,'progress is not an alarm');
  assert.equal(stats.wrong,2);
  assert.equal(stats.falsePositiveRate,0.667);
 }finally{db.close();}
});

test('the desk can read back why a task was flagged',()=>{
 const db=fresh();
 try{
  const store=new WatchdogStore(db);
  assert.deepEqual(watchdogNotes(db,'missing'),[]);
  store.record({workerId:'w',verdict:'looping',reason:'第三次读同一文件',evidenceCursor:7,model:'j'});
  const notes=watchdogNotes(db,'w');
  assert.equal(notes.length,1);
  assert.match(notes[0].reason,/第三次读同一文件/);
 }finally{db.close();}
});
