import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// 数据根必须隔离：否则 new KeposDatabase() 会落到真实库，把测试夹具写进用户配置。
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-watch-home-'));
const {KeposDatabase}=await import('../dist/terminal/database.js');
const {
  matchRule, isExcludedPath, WatchCandidates, DirectoryWatcher, describeCandidate,
  validRules, DEFAULT_WATCH_RULES,
}=await import('../dist/terminal/watch.js');

const fresh=()=>{
  const dir=mkdtempSync(join(tmpdir(),'kepos-watch-'));
  return{db:new KeposDatabase(join(dir,'k.sqlite')),dir};
};
const rule=(extra={})=>({id:'r1',intent:'t',agent:'审查官',task:'读 {file}',...extra});

// 观察期的第一道防线是准入：程序层判定，不经过模型。
test('a rule matches by extension and path fragment',()=>{
  const rules=[rule({extensions:['.md'],pathIncludes:['docs']})];
  assert.ok(matchRule('/p/docs/guide.md','file-changed',rules));
  assert.equal(matchRule('/p/src/main.ts','file-changed',rules),undefined,'wrong extension');
  assert.equal(matchRule('/p/other/guide.md','file-changed',rules),undefined,'wrong folder');
});

test('the task placeholder is filled with the file name',()=>{
  const hit=matchRule('/p/docs/guide.md','file-changed',[rule({extensions:['.md'],task:'核对 {file} 有没有过时'})]);
  assert.equal(hit.task,'核对 guide.md 有没有过时');
});

// 归档区、依赖、版本库元数据永远不该被监听：它们每天都在变，且不是源码。
test('forbidden paths are rejected before any rule is considered',()=>{
  for(const path of ['/p/node_modules/x/a.md','/p/.git/COMMIT_EDITMSG','/p/.kepos/tasks/a.md','/p/dist/a.md']){
    assert.equal(isExcludedPath(path),true,path);
    assert.equal(matchRule(path,'file-changed',[rule({})]),undefined,`${path} never matches`);
  }
  assert.equal(isExcludedPath('/p/src/a.ts'),false);
});

test('a deletion never produces a task',()=>{
  // 文件都不在了，派代表去读它是白花一次调用。
  assert.equal(matchRule('/p/docs/a.md','file-deleted',[rule({extensions:['.md']})]),undefined);
});

test('rules are evaluated in order, so the same input always gives the same answer',()=>{
  const rules=[rule({id:'first',extensions:['.md']}),rule({id:'second',extensions:['.md']})];
  const first=matchRule('/p/a.md','file-changed',rules);
  const again=matchRule('/p/a.md','file-changed',rules);
  assert.equal(first.rule.id,'first');
  assert.deepEqual(first,again);
});

test('a candidate is recorded once per cooldown window',()=>{
  const{db}=fresh();
  try{
    const store=new WatchCandidates(db);
    const base={ruleId:'r1',kind:'file-changed',path:'/p/a.md',task:'t',agent:'A',cooldownMs:60000};
    assert.equal(store.record({...base,at:1000}),true);
    assert.equal(store.record({...base,at:2000}),false,'inside the cooldown');
    assert.equal(store.record({...base,at:90000}),true,'after it');
    assert.equal(store.recent().length,2);
    // 不同规则互不影响。
    assert.equal(store.record({...base,ruleId:'r2',at:3000}),true);
  }finally{db.close();}
});

test('a zero cooldown never suppresses a real second change',()=>{
  const{db}=fresh();
  try{
    const store=new WatchCandidates(db);
    const base={ruleId:'r1',kind:'file-changed',path:'/p/a.md',task:'t',agent:'A',cooldownMs:0};
    assert.equal(store.record({...base,at:1000}),true);
    assert.equal(store.record({...base,at:1001}),true,'no cooldown means every change is recorded');
  }finally{db.close();}
});

test('every recorded candidate is marked observe-only',()=>{
  const{db}=fresh();
  try{
    const store=new WatchCandidates(db);
    store.record({ruleId:'r',kind:'file-changed',path:'/p/a.md',task:'t',agent:'A'});
    const [candidate]=store.recent();
    assert.equal(candidate.observeOnly,true,'the first phase never acts');
    assert.match(describeCandidate(candidate),/修改 a\.md 会触发 r/);
    assert.equal(store.clear(),1);
    assert.deepEqual(store.recent(),[]);
  }finally{db.close();}
});

test('the watcher reports changes only after the baseline scan',()=>{
  const{dir}=fresh();
  const nested=join(dir,'docs');
  mkdirSync(nested,{recursive:true});
  writeFileSync(join(nested,'a.md'),'one');
  const events=[];
  const watcher=new DirectoryWatcher([dir],{maxDepth:2,onEvent:(path,kind)=>events.push({path,kind})});
  try{
    const first=watcher.scan();
    assert.equal(events.length,0,'the first scan only establishes a baseline');
    assert.equal(first.created.length,0);
    // 改内容并推进 mtime（文件系统时间精度可能吞掉快速写入）。
    writeFileSync(join(nested,'a.md'),'two');
    utimesSync(join(nested,'a.md'),new Date(),new Date(Date.now()+2000));
    watcher.scan();
    assert.ok(events.some(event=>event.kind==='file-changed'&&event.path.endsWith('a.md')));
    // 新建与删除都能看到。
    writeFileSync(join(nested,'b.md'),'new');
    watcher.scan();
    assert.ok(events.some(event=>event.kind==='file-created'&&event.path.endsWith('b.md')));
    rmSync(join(nested,'b.md'));
    watcher.scan();
    assert.ok(events.some(event=>event.kind==='file-deleted'&&event.path.endsWith('b.md')));
  }finally{watcher.stop();}
});

test('the watcher never descends into excluded directories',()=>{
  const{dir}=fresh();
  mkdirSync(join(dir,'node_modules','pkg'),{recursive:true});
  writeFileSync(join(dir,'node_modules','pkg','a.md'),'x');
  mkdirSync(join(dir,'src'),{recursive:true});
  writeFileSync(join(dir,'src','b.md'),'y');
  const watcher=new DirectoryWatcher([dir],{maxDepth:3,onEvent:()=>{}});
  try{
    watcher.scan();
    // 通过改变两个文件后的事件集合来验证：依赖目录里的文件不产生事件。
    const events=[];
    const watched=new DirectoryWatcher([dir],{maxDepth:3,onEvent:(path,kind)=>events.push({path,kind})});
    watched.scan();
    writeFileSync(join(dir,'node_modules','pkg','a.md'),'changed');
    utimesSync(join(dir,'node_modules','pkg','a.md'),new Date(),new Date(Date.now()+2000));
    writeFileSync(join(dir,'src','b.md'),'changed');
    utimesSync(join(dir,'src','b.md'),new Date(),new Date(Date.now()+2000));
    watched.scan();
    assert.ok(events.some(event=>event.path.includes('src')),'source files are watched');
    assert.equal(events.some(event=>event.path.includes('node_modules')),false,'dependencies are not');
    watched.stop();
  }finally{watcher.stop();}
});

test('broken rules are set aside instead of stopping the watcher',()=>{
  const {usable,rejected}=validRules([{id:'ok',intent:'',agent:'A',task:'读'},{id:'',intent:'',agent:'A',task:'t'},{id:'no-task',intent:'',agent:'A',task:'  '}]);
  assert.equal(usable.length,1);
  assert.equal(usable[0].id,'ok');
  assert.equal(rejected.length,2);
});

test('the default rule is conservative and excludes build noise',()=>{
  assert.ok(DEFAULT_WATCH_RULES.length>=1);
  for(const rule of DEFAULT_WATCH_RULES){
    assert.ok(rule.pathExcludes?.includes('node_modules'),'dependencies excluded by default');
    assert.ok(rule.pathExcludes?.includes('.kepos'),'the archive excludes itself');
    assert.ok((rule.cooldownMs??0)>0,'a default rule has a cooldown');
    // 默认任务必须是只读的：它明说不要改文件，而不是含糊地说"检查一下"。
    assert.match(rule.task,/不要修改|只读/,'default tasks state the read-only bound explicitly');
  }
});

// 观察层的核心承诺：候选存在、可读、且从不自行执行。
test('a recorded candidate never causes a dispatch on its own',()=>{
  const{db}=fresh();
  try{
    const store=new WatchCandidates(db);
    const hit=matchRule('/p/README.md','file-changed',DEFAULT_WATCH_RULES);
    assert.ok(hit,'the default rule matches a README change');
    store.record({ruleId:hit.rule.id,kind:'file-changed',path:'/p/README.md',task:hit.task,agent:hit.rule.agent,cooldownMs:hit.rule.cooldownMs});
    const rows=store.recent();
    assert.equal(rows.length,1);
    // 唯一的产物是一行记录。没有队列、没有派发、没有"将被执行"的字段。
    assert.equal(rows[0].observeOnly,true);
    assert.deepEqual(Object.keys(rows[0]).sort(),['agent','at','id','kind','observeOnly','path','ruleId','task']);
  }finally{db.close();}
});

// 观察表没有自然生命周期（任务会结算，候选不会）。不裁剪就是一张无限增长的表。
test('the candidate table keeps only the most recent entries',()=>{
  const{db}=fresh();
  try{
    const store=new WatchCandidates(db);
    for(let n=0;n<20;n++)store.record({ruleId:'r',kind:'file-changed',path:`/p/f${n}.md`,task:'t',agent:'A',at:1000+n});
    assert.equal(store.recent(100).length,20);
    const removed=store.prune(5);
    assert.equal(removed,15);
    const left=store.recent(100);
    assert.equal(left.length,5);
    // 保留的是最新的那些。
    assert.ok(left.every(c=>/f1[5-9]\.md/.test(c.path)),'kept the newest');
  }finally{db.close();}
});
