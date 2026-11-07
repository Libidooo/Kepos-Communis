import test from 'node:test';
import assert from 'node:assert/strict';
const {verbFor, latticeCells, formatElapsed, stepDetail, stepLabel, renderActivityBlock}=await import('../dist/terminal/activity-block.js');

// 动词表：状态行说的必须是总理此刻真正在做的事——按 Kepos 的议会语汇命名。
test('the verb follows what the premier is actually doing',()=>{
  assert.equal(verbFor(undefined),'正在梳理思路');
  assert.equal(verbFor({kind:'think'}),'正在梳理思路');
  assert.equal(verbFor({kind:'text'}),'正在起草结论');
  assert.equal(verbFor({kind:'tool',tool:'Read'}),'正在翻阅案卷');
  assert.equal(verbFor({kind:'tool',tool:'grep'}),'正在翻阅案卷');
  assert.equal(verbFor({kind:'tool',tool:'bash'}),'正在执行操作');
  assert.equal(verbFor({kind:'tool',tool:'edit'}),'正在落笔成文');
  assert.equal(verbFor({kind:'tool',tool:'kepos_delegate'}),'正在分派议事');
  assert.equal(verbFor({kind:'tool',tool:'kepos_vote'}),'正在征询意见');
  assert.equal(verbFor({kind:'tool',tool:'mystery'}),'正在办理事务');
});

// LatticeLoader 的动效移植：ripple 随节拍流动；settle 点阵化作定格符；motion 关闭即静止。
test('the lattice ripples center-out and freezes into the settle mark',()=>{
  const run=phase=>latticeCells('working',1000+phase*150,1000,true).text;
  assert.ok(/●/.test(run(0)),'at least one cell stays lit');
  assert.notEqual(run(0),run(2),'the wave actually moves');
  assert.equal(latticeCells('working',0,0,false).text,'●·●','motion off keeps the dots static');
  assert.equal(latticeCells('done',0,0).text,'✓');
  assert.equal(latticeCells('done',0,0).token,'success');
  assert.equal(latticeCells('error',0,0).text,'✕');
  assert.equal(latticeCells('aborted',0,0).text,'◼');
});

test('elapsed reads like a stopwatch, minute digits padded',()=>{
  assert.equal(formatElapsed(3200),'3.2s');
  assert.equal(formatElapsed(64300),'1m04.3s');
});

test('step detail reduces args to a glanceable summary',()=>{
  assert.equal(stepDetail('read',{path:'T:/Kepos/README.md'}),'README.md');
  assert.equal(stepDetail('bash',{command:'npm test -- --watch'}),'npm test -- --watch');
  assert.equal(stepDetail('grep',{pattern:'预算上限'}),'「预算上限」');
  const fallback=stepDetail('mystery',{foo:1});
  assert.ok(typeof fallback==='string'&&fallback.length<=40);
  assert.equal(stepDetail('read',{}),undefined);
});

test('step labels speak completed verbs',()=>{
  assert.equal(stepLabel({kind:'think',started:0,ended:1}),'思路已整理');
  assert.equal(stepLabel({kind:'think',started:0}),'正在梳理思路');
  assert.equal(stepLabel({kind:'tool',tool:'read',started:0,detail:'README.md'}),'翻阅案卷 README.md');
});

// 渲染契约：工作中不带计时器（头部的"执行中"才是计时器）；settle 冻结时长；
// 折叠只占一行；展开上限 6 步 + 溢出提示。
test('the block renders working, settled and folded states',()=>{
  const steps=Array.from({length:8},(_,i)=>({kind:'tool',tool:'read',started:i*1000,ended:i*1000+800,detail:'f'+i}));
  const working=renderActivityBlock({state:'working',signal:{kind:'tool',tool:'read'},steps,open:false,width:120,now:1000,startedAt:0});
  assert.equal(working.length,1,'collapsed is one line');
  assert.match(working[0],/[●·]/);
  assert.doesNotMatch(working[0],/\d+\.\ds/,'no timer while working');
  assert.match(working[0],/▸ 8 步/);
  const done=renderActivityBlock({state:'done',ms:12300,steps,open:false,width:120,now:0,startedAt:0});
  assert.match(done[0],/✓ 已完成 · 12\.3s/);
  assert.match(done[0],/▸ 8 步/);
  const open=renderActivityBlock({state:'done',ms:12300,steps,open:true,width:120,now:0,startedAt:0});
  assert.equal(open.length,8,'head + overflow hint + 6 steps');
  assert.match(open[1],/共 8 步/);
  assert.match(open[7],/翻阅案卷 f7 · 0\.8s/,'newest steps survive the window');
  const aborted=renderActivityBlock({state:'aborted',ms:8000,steps:[],open:false,width:120,now:0,startedAt:0});
  assert.match(aborted[0],/◼ 已中止 · 8\.0s/);
});
