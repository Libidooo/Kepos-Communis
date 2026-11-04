import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-automation-home-'));

const {
  AUTOMATION_DEFAULTS, AUTOMATION_LABEL, automationAllowed, automationSnapshot,
  confirmText, dispatchReady, isActingCapability, migrateAutomation, toggleAutomation, automationPrompt,
}=await import('../dist/terminal/automation.js');

const off={};
const all={observe:true,dispatch:true,precheck:true};

// 这类能力的默认值只有一个可接受的取值：关。
test('every automation capability is off unless someone turns it on',()=>{
  assert.deepEqual(AUTOMATION_DEFAULTS,{observe:false,dispatch:false,precheck:false});
  for(const capability of ['observe','dispatch','precheck']){
    assert.equal(automationAllowed('proxy',undefined,capability).allowed,false,'no settings means off');
    assert.equal(automationAllowed('proxy',off,capability).allowed,false,'empty settings means off');
  }
});

// 观察只写数据库：不启动进程、不花钱、不改文件。它不需要行动权限。
test('observation needs no approval policy because it does not act',()=>{
  for(const policy of ['human','proxy','readonly']){
    assert.equal(automationAllowed(policy,{observe:true},'observe').allowed,true,`observe works in ${policy}`);
  }
  assert.equal(isActingCapability('observe'),false);
});

// 会启动任务的两项必须在代理档下。
test('acting capabilities require proxy mode',()=>{
  for(const capability of ['dispatch','precheck']){
    assert.equal(isActingCapability(capability),true);
    assert.equal(automationAllowed('proxy',all,capability).allowed,true,`${capability} runs in proxy`);
    assert.equal(automationAllowed('human',all,capability).allowed,false,`${capability} is paused in strict`);
    assert.equal(automationAllowed('readonly',all,capability).allowed,false,`${capability} is paused in readonly`);
  }
});

// "为什么没跑"必须能分辨是没开、还是被档位挡住。
test('a paused capability says so instead of looking switched off',()=>{
  const paused=automationAllowed('human',{dispatch:true},'dispatch');
  assert.match(paused.reason,/已开启/);
  assert.match(paused.reason,/严格/);
  assert.match(paused.reason,/代理档/);
  const never=automationAllowed('human',off,'dispatch');
  assert.match(never.reason,/未开启/);
  assert.notEqual(paused.reason,never.reason);
  // 只读档的理由要指向"没有行动能力"，不是笼统的"需要授权"。
  assert.match(automationAllowed('readonly',{precheck:true},'precheck').reason,/只读档没有行动能力/);
});

// 不监听就没有候选可派。
test('dispatch cannot run without observation',()=>{
  assert.equal(dispatchReady({dispatch:true}).allowed,false);
  assert.match(dispatchReady({dispatch:true}).reason,/先开启值守观察/);
  assert.equal(dispatchReady({observe:true,dispatch:true}).allowed,true);
  // snapshot 把这条依赖也反映出来：开关与档位都满足，但仍不允许。
  const row=automationSnapshot('proxy',{dispatch:true}).find(item=>item.capability==='dispatch');
  assert.equal(row.enabled,true);
  assert.equal(row.allowed,false);
});

test('the snapshot lists capabilities in ascending order of danger',()=>{
  const rows=automationSnapshot('proxy',all);
  assert.deepEqual(rows.map(row=>row.capability),['observe','dispatch','precheck']);
  assert.deepEqual(rows.map(row=>row.acting),[false,true,true]);
  // 代理档下三项全开 → 全部可用。
  assert.ok(rows.every(row=>row.allowed));
  // 严格档下只有观察可用。
  const strict=automationSnapshot('human',all);
  assert.equal(strict.find(row=>row.capability==='observe').allowed,true);
  assert.equal(strict.find(row=>row.capability==='dispatch').allowed,false);
  assert.equal(strict.find(row=>row.capability==='precheck').allowed,false);
});

// 关闭不需要确认；打开会行动的能力需要确认。
test('only turning something on asks for confirmation',()=>{
  assert.equal(toggleAutomation(off,'observe',true).needsConfirm,false,'observation is harmless');
  assert.equal(toggleAutomation(off,'dispatch',true).needsConfirm,true);
  assert.equal(toggleAutomation(off,'precheck',true).needsConfirm,true);
  assert.equal(toggleAutomation(all,'dispatch',false).needsConfirm,false,'turning off never asks');
  assert.equal(toggleAutomation(all,'precheck',false).needsConfirm,false);
});

// 打开派发时补上观察，否则它永远跑不起来，人会以为开关坏了。
test('enabling dispatch implies observation',()=>{
  assert.equal(toggleAutomation(off,'dispatch',true).settings.observe,true);
  // 已有的观察设置不被覆盖。
  assert.equal(toggleAutomation({observe:true},'dispatch',true).settings.observe,true);
  // 关掉派发不连带关掉观察——人可能还想继续收集候选。
  assert.equal(toggleAutomation(all,'dispatch',false).settings.observe,true);
});

test('confirmation text states the concrete consequence, not "are you sure"',()=>{
  const dispatch=confirmText('dispatch',{rules:3,agents:48,maxPerMinute:2});
  assert.match(dispatch,/3 条规则/);
  assert.match(dispatch,/每分钟 2 个/);
  assert.match(dispatch,/不能派生僚属/);
  assert.match(dispatch,/消耗预算/);
  assert.match(dispatch,/先只开「值守观察」/,'the safe path is suggested');
  const precheck=confirmText('precheck',{rules:1,agents:3,maxPerMinute:2});
  assert.match(precheck,/3 个只读任务/);
  assert.match(precheck,/只预检一次/);
  assert.match(precheck,/不会自己跑/,'precheck is invoked, not spontaneous');
});

// 升级不能让人在没察觉时开始花钱。
test('legacy watch/precheck fields migrate to observation only',()=>{
  const migrated=migrateAutomation({watch:{enabled:true,rules:[]},precheck:{enabled:true}});
  assert.equal(migrated.observe,true,'the old enabled flag maps to observation');
  assert.equal(migrated.dispatch,false,'never auto-enabled by migration');
  // 预检是会被调用的工具，沿用旧的开启状态是安全的——它不自己跑。
  assert.equal(migrated.precheck,true);
  // 旧版只开 watch 时，同样只映射到观察。
  assert.equal(migrateAutomation({watch:{enabled:true}}).dispatch,false);
  assert.equal(migrateAutomation({watch:{enabled:false}}).observe,undefined);
  assert.equal(migrateAutomation({}),undefined,'nothing to migrate');
});

test('the labels describe what each capability actually does',()=>{
  assert.match(AUTOMATION_LABEL.observe.what,/不派任务/);
  assert.match(AUTOMATION_LABEL.dispatch.what,/真的开任务/);
  assert.match(AUTOMATION_LABEL.precheck.what,/确认可复现才上报/);
  // 三项的名称必须互不相同，否则菜单里分不清。
  const names=new Set(Object.values(AUTOMATION_LABEL).map(item=>item.name));
  assert.equal(names.size,3);
});

// 提示里不该提到用不了的能力：模型会反复尝试然后失败，每次都是真实调用。
test('the prompt stays silent when nothing is enabled',()=>{
  assert.equal(automationPrompt('proxy',undefined),'');
  assert.equal(automationPrompt('proxy',off),'');
});

test('the prompt names only what is actually usable',()=>{
  const text=automationPrompt('proxy',{observe:true,precheck:true});
  assert.match(text,/Automation available: 值守观察, 静默预检/);
  assert.match(text,/kepos_precheck/);
  // 没开的派发不能被提到。
  assert.doesNotMatch(text,/值守自动派发/);
});

// 被档位暂停的能力要明说"别重试"，否则模型会换种说法再试一遍。
test('a paused capability says do not retry',()=>{
  const text=automationPrompt('human',{observe:true,dispatch:true,precheck:true});
  assert.match(text,/paused/);
  assert.match(text,/Do not retry/);
  assert.match(text,/值守自动派发/);
  // 可用的观察仍然要报出来。
  assert.match(text,/Automation available: 值守观察/);
});

test('the precheck hint appears only when precheck is usable',()=>{
  assert.doesNotMatch(automationPrompt('proxy',{observe:true}),/kepos_precheck/);
  assert.match(automationPrompt('proxy',{precheck:true}),/kepos_precheck/);
});
