import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {KeposDatabase}=await import('../dist/terminal/database.js');
const {
  premierBriefing, representativeBriefing, upwardReport, briefingIssued, BriefingStore, deliveryNote,
  BRIEFING_HEADER, MAX_BRIEFING_CHARS,
}=await import('../dist/terminal/briefing.js');

function fresh(){
  const dir=mkdtempSync(join(tmpdir(),'kepos-briefing-'));
  return{db:new KeposDatabase(join(dir,'k.sqlite'))};
}

// 加急指令必须和普通补充信息区分开，否则模型会把"改需求"当成"多做一点"。
test('both briefings carry an urgent header the model can key on',()=>{
  const toPremier=premierBriefing('把鉴权换成 OAuth');
  const toAgent=representativeBriefing('把鉴权换成 OAuth',{name:'总理',role:'premier'});
  assert.ok(toPremier.startsWith(BRIEFING_HEADER));
  assert.ok(toAgent.startsWith(BRIEFING_HEADER));
  assert.match(BRIEFING_HEADER,/加急/);
});

// 0.5.1 后总理的加急只带人类原话：重排纪律常驻在监督提示词里，
// 不随每条加急整段注入——人类说一句，界面不该刷一篇檄文。
test('the premier briefing is the human words plus the urgent mark, nothing else',()=>{
  const text=premierBriefing('策略官呢');
  assert.equal(text,[BRIEFING_HEADER,'','策略官呢'].join('\n'));
  assert.ok(!text.includes('## 你需要做的'),'no injected checklist');
  assert.ok(!text.includes('任务运行中'),'no injected scale report');
  const long=premierBriefing('x'.repeat(MAX_BRIEFING_CHARS+50));
  assert.ok(long.length<MAX_BRIEFING_CHARS+100,'still bounded');
});

// 代表这条路径的要点是"停下"，不是"注意"。
test('a representative is told to stop the current goal, not to finish it first',()=>{
  const text=representativeBriefing('先别审查鉴权，改为检查依赖',{name:'总代乙',role:'deputy'});
  assert.match(text,/停下/);
  assert.match(text,/不要再推进原来的任务/);
  assert.match(text,/不要为了"做完手头这步"而延迟/);
  assert.match(text,/已完成的产出保留/);
  assert.match(text,/转给代理总代「总代乙」/);
  // 没有总代时报给总理。
  assert.match(representativeBriefing('x',{name:'总理',role:'premier'}),/转给总理/);
  assert.match(text,/不要自行扩大范围/);
});

test('the upward report names the agent, the change and the conclusion',()=>{
  const report=upwardReport({agent:'审查官',taskId:'w1',briefing:'改为检查依赖',conclusion:'已完成鉴权扫描的 2/3，按新安排停下'});
  assert.match(report,/代表汇报/);
  assert.match(report,/因人类变更而改道/);
  assert.match(report,/审查官/);
  assert.match(report,/w1/);
  assert.match(report,/改为检查依赖/);
  assert.match(report,/2\/3/);
  assert.match(report,/需要你决定的/);
  // 空结论也要明说，不能静默留白。
  assert.match(upwardReport({agent:'A',taskId:'t',briefing:'',conclusion:''}),/代表未给出结论/);
});

test('briefings are recorded so "已加急" corresponds to a real delivery',()=>{
  const{db}=fresh();
  try{
    const store=new BriefingStore(db);
    const record=store.record({target:'representative',targetName:'审查官',taskId:'w1',text:'改为检查依赖',delivery:'forwarded',note:'上级：总理'});
    assert.ok(record.id);
    const recent=store.recent();
    assert.equal(recent.length,1);
    assert.equal(recent[0].delivery,'forwarded');
    assert.equal(recent[0].taskId,'w1');
    // 按任务查：任务详情要能显示"它为什么改了方向"。
    assert.equal(store.forTask('w1').length,1);
    assert.equal(store.forTask('other').length,0);
    // 发给总理的整盘重排没有 taskId。
    store.record({target:'premier',targetName:'总理',text:'目标改为多租户',delivery:'queued'});
    assert.equal(store.recent().length,2);
    assert.equal(store.recent()[0].taskId,undefined);
  }finally{db.close();}
});

test('the record refuses to grow past the size limit and states each delivery plainly',()=>{
  const{db}=fresh();
  try{
    const store=new BriefingStore(db);
    store.record({target:'premier',targetName:'总理',text:'长'.repeat(MAX_BRIEFING_CHARS+500),delivery:'queued'});
    assert.equal(store.recent()[0].text.length,MAX_BRIEFING_CHARS);
    assert.match(deliveryNote('queued','总理'),/工具调用结束后立刻处理/);
    assert.match(deliveryNote('forwarded','审查官'),/当前工具批次结束后停下/);
    // 排队中的任务被唤醒与"已在跑的代表改道"是两件不同的事，文案不能共用。
    assert.match(deliveryNote('woken','审查官'),/还没轮到的任务现在开始跑/);
    assert.notEqual(deliveryNote('woken','审查官'),deliveryNote('queued','审查官'));
    assert.match(deliveryNote('new-task','审查官'),/开新任务/);
    assert.match(deliveryNote('failed','审查官'),/未能送达/);
  }finally{db.close();}
});

// 两段式上报：变更下达时先报"结论待补"，结算后再报真实结论。
// 只发第一段会把旧 checkpoint 冒充成结论——那是谎报进度。
test('the immediate notice says the conclusion is still pending, not a stale one',()=>{
  const notice=briefingIssued({agent:'审查官',taskId:'w1',briefing:'改为检查依赖'});
  assert.match(notice,/代表改道通知（结论待补）/);
  assert.match(notice,/正在停止原目标/);
  assert.match(notice,/审查官/);
  assert.match(notice,/改为检查依赖/);
  // 关键：明确告诉上级不要按旧方向继续安排。
  assert.match(notice,/不要基于它的旧方向继续安排/);
  // 它不含"结论"小节——因为此刻还没有结论，编一个出来就是谎报。
  assert.doesNotMatch(notice,/### 代表的结论/);
});

test('the follow-up report carries the real conclusion once the task settles',()=>{
  const immediate=briefingIssued({agent:'审查官',taskId:'w1',briefing:'改为检查依赖'});
  const final=upwardReport({agent:'审查官',taskId:'w1',briefing:'改为检查依赖',conclusion:'原任务完成 2/3 后停下；依赖检查已完成 4 处'});
  assert.match(final,/### 代表的结论/);
  assert.match(final,/2\/3/);
  assert.notEqual(immediate,final,'the two phases are distinct messages');
});
