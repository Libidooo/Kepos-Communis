import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-cal-home-'));

const {KeposDatabase}=await import('../dist/terminal/database.js');
const {
  calibrateConfidence, calibrateDispatchRate, calibrateSubordinateThreshold,
  calibrateAll, formatCalibration, MIN_CALIBRATION_SAMPLES,
} = await import('../dist/terminal/calibration.js');

const fresh=()=>new KeposDatabase(join(mkdtempSync(join(tmpdir(),'kepos-cal-')),'k.sqlite'));
const candidate=(db,i,at,rule='r1')=>db.prepare('INSERT INTO watch_candidates(id,at,rule_id,kind,path,task,agent,observe_only) VALUES(?,?,?,?,?,?,?,1)').run(`c${i}`,at,rule,'file-changed',`/p/f${i}.md`,'t','A');
// worker_events 有指向 workers 的外键：先建任务行，再写事件。
// 只有 purpose='watch' 的任务才算值守自动派发；其余是普通委派或初始化播种。
const worker=(db,id,parent,purpose='watch')=>db.prepare('INSERT OR IGNORE INTO workers VALUES(?,?,?,?,?,?,?,NULL)').run(id,'p','corr-'+id,'hash','e','RUNNING',JSON.stringify({id,agent:'A',state:'RUNNING',status:'运行中',title:'t',cwd:'.',session:'s',parentSessionId:'p',correlationId:'c',started:1,output:'',limit:60,model:'m',provider:'p',ownerPid:1,ownerEpoch:'e',tools:['read'],skills:[],mcp:false,purpose,...(parent?{parentWorkerId:parent}:{})}));
const queued=(db,i,at,parent='p1',purpose='watch')=>{worker(db,'w'+i,parent==='p1'?undefined:parent,purpose);db.prepare('INSERT INTO worker_events(worker_id,type,created,payload) VALUES(?,?,?,?)').run('w'+i,'queued',at,JSON.stringify({state:'QUEUED',parent}));};

// 最重要的一条：样本不足时必须明说，不能拿三条记录给出一个看起来精确的建议。
test('every calibration refuses to advise below the sample floor',()=>{
  const db=fresh();
  try{
    for(const result of calibrateAll(db)){
      assert.equal(result.samples<MIN_CALIBRATION_SAMPLES,true);
      assert.equal(result.suggested,undefined,`${result.parameter} must not suggest on no data`);
      assert.match(result.rationale,/至少需要|不足以|才能校准/);
    }
  }finally{db.close();}
});

test('raw hits without assessments are not confidence samples',()=>{
  const db=fresh();
  try{
    // 只有候选命中、没有评估落库：置信度阈值无从校准，必须如实说。
    for(let i=0;i<MIN_CALIBRATION_SAMPLES+10;i++)candidate(db,i,1000+i*60000,'readme-sync');
    const result=calibrateConfidence(db);
    assert.equal(result.samples,0,'watch hits are not assessments');
    assert.match(result.rationale,/关联|watchPath/);
    assert.equal(result.suggested,undefined);
  }finally{db.close();}
});

test('dispatch rate stays put when it was never the constraint',()=>{
  const db=fresh();
  try{
    // 每次间隔十分钟：最密的一分钟只有 1 个。
    for(let i=0;i<MIN_CALIBRATION_SAMPLES;i++)queued(db,i,1000+i*600000);
    const result=calibrateDispatchRate(db);
    assert.equal(result.suggested,undefined,'never hit the cap, so no reason to change it');
    assert.match(result.rationale,/从未构成约束/);
  }finally{db.close();}
});

test('dispatch rate is raised only when the cap actually blocks work',()=>{
  const db=fresh();
  try{
    // 密集派发：同一分钟内 6 个。
    for(let i=0;i<6;i++)queued(db,i,1000+i*1000);
    for(let i=0;i<MIN_CALIBRATION_SAMPLES;i++)queued(db,100+i,200000+i*600000);
    const result=calibrateDispatchRate(db);
    assert.ok(result.suggested>2,`expected a raise, got ${result.suggested}`);
    assert.ok(result.suggested<=10,'never suggests an unbounded cap');
    assert.match(result.rationale,/会挡住正常工作/);
  }finally{db.close();}
});

test('the subordinate line follows the observed 90th percentile',()=>{
  const db=fresh();
  try{
    // 有的代表带 1-2 个，有的带 4 个：审批线 3 会挡住后者。
    for(let i=0;i<MIN_CALIBRATION_SAMPLES;i++){
      const children=i%5===0?4:1;
      for(let c=0;c<children;c++)queued(db,i*10+c,1000+i*10000,'parent-'+i);
    }
    const result=calibrateSubordinateThreshold(db);
    assert.ok(result.observed);
    assert.ok(result.observed.max>=4);
    assert.ok(result.suggested>=3,`suggested ${result.suggested}`);
    assert.ok(result.suggested<=6,'never exceeds the hard cap');
  }finally{db.close();}
});

test('a quiet workload leaves the subordinate line alone',()=>{
  const db=fresh();
  try{
    for(let i=0;i<MIN_CALIBRATION_SAMPLES;i++)queued(db,i,1000+i*10000,'parent-'+i);
    const result=calibrateSubordinateThreshold(db);
    assert.equal(result.suggested,undefined,'one subordinate each: line 3 fits');
    assert.match(result.rationale,/保持不动/);
  }finally{db.close();}
});

test('calibration is read-only: it never writes settings',()=>{
  const db=fresh();
  try{
    const before=db.prepare('SELECT COUNT(*) AS n FROM kv').get().n;
    calibrateAll(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kv').get().n,before,'no settings written');
  }finally{db.close();}
});

test('the summary states current value, samples and either advice or refusal',()=>{
  const db=fresh();
  try{
    const text=formatCalibration(calibrateAll(db));
    assert.match(text,/语义评估置信度阈值/);
    assert.match(text,/自动派发频率上限/);
    assert.match(text,/僚属审批线/);
    assert.match(text,/暂不建议改动/);
  }finally{db.close();}
});

// 回归：起初统计了所有 queued 事件，得到"最密一分钟 48 个"并建议放宽上限。
// 那 48 个是初始化编制时的一次性播种，与自动派发无关。
// 用错误的样本得出精确的数字，比不给建议更糟。
test('ordinary dispatches are not mistaken for automatic ones',()=>{
  const db=fresh();
  try{
    // 一次性播种：同一分钟内 48 个普通委派。
    for(let i=0;i<48;i++)queued(db,i,1000+i*10,'p1','delegation');
    const result=calibrateDispatchRate(db);
    assert.equal(result.samples,0,'seeding is not automation');
    assert.equal(result.suggested,undefined,'and must not move the cap');
    assert.match(result.rationale,/值守自动派发/);
  }finally{db.close();}
});

test('only watch-purpose dispatches count toward the rate',()=>{
  const db=fresh();
  try{
    for(let i=0;i<48;i++)queued(db,i,1000+i*10,'p1','delegation');
    // 真正的值守派发只有几个。
    for(let i=0;i<3;i++)queued(db,100+i,900000+i*600000,'p1','watch');
    assert.equal(calibrateDispatchRate(db).samples,3);
  }finally{db.close();}
});

// 回归：置信度校准必须有可关联的评估记录。
// 起初它读 watch_candidates（只有命中、没有判断），算出来的不是校准是噪声。
test('confidence calibration requires linked assessments, not raw hits',()=>{
  const db=fresh();
  try{
    // 只有候选命中，没有评估落库。
    for(let i=0;i<MIN_CALIBRATION_SAMPLES+5;i++)candidate(db,i,1000+i*60000,'readme-sync');
    const result=calibrateConfidence(db);
    assert.equal(result.samples,0,'raw hits are not assessments');
    assert.match(result.rationale,/watchPath|关联/);
    assert.equal(result.suggested,undefined);
  }finally{db.close();}
});

// 关联建立后的判据：派出去的值守任务成功率低 → 阈值放得太松。
test('low success rate of dispatched watch tasks raises the threshold',()=>{
  const db=fresh();
  try{
    const now=Date.now();
    // 20 个评估判值得且已派发；其中 15 个任务失败。
    for(let i=0;i<MIN_CALIBRATION_SAMPLES;i++){
      const ok=i<5?1:0;
      db.prepare('INSERT OR IGNORE INTO workers VALUES(?,?,?,?,?,?,?,NULL)').run(
        `wt${i}`,'p',`c-${i}`,'h','e',ok?'SUCCEEDED':'FAILED',
        JSON.stringify({id:`wt${i}`,agent:'A',state:ok?'SUCCEEDED':'FAILED',status:ok?'完成':'失败',title:'t',cwd:'.',session:'s',parentSessionId:'p',correlationId:'c',started:1,output:'',limit:60,model:'m',provider:'p',ownerPid:1,ownerEpoch:'e',tools:['read'],skills:[],mcp:false,watchPath:`/p/f${i%4}.md`}));
      db.prepare('INSERT INTO watch_assessments(at,rule_id,path,worth,confidence,reason,dispatched) VALUES(?,?,?,?,?,?,1)')
        .run(1000+i,'r1',`/p/f${i%4}.md`,1,0.9,'r');
    }
    const result=calibrateConfidence(db);
    assert.match(result.rationale,/放得太松|提高到 0.7/);
  }finally{db.close();}
});

test('a high success rate suggests the threshold could be loosened',()=>{
  const db=fresh();
  try{
    for(let i=0;i<MIN_CALIBRATION_SAMPLES;i++){
      db.prepare('INSERT OR IGNORE INTO workers VALUES(?,?,?,?,?,?,?,NULL)').run(
        `wt${i}`,'p',`c-${i}`,'h','e','SUCCEEDED',
        JSON.stringify({id:`wt${i}`,agent:'A',state:'SUCCEEDED',status:'完成',title:'t',cwd:'.',session:'s',parentSessionId:'p',correlationId:'c',started:1,output:'',limit:60,model:'m',provider:'p',ownerPid:1,ownerEpoch:'e',tools:['read'],skills:[],mcp:false,watchPath:`/p/f${i}.md`}));
      db.prepare('INSERT INTO watch_assessments(at,rule_id,path,worth,confidence,reason,dispatched) VALUES(?,?,?,?,?,?,1)')
        .run(1000+i,'r1',`/p/f${i}.md`,1,0.9,'r');
    }
    const result=calibrateConfidence(db);
    assert.match(result.rationale,/偏紧|降到 0.3/);
  }finally{db.close();}
});
