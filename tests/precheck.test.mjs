import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-precheck-home-'));

const {
  reproduceInstruction, parseReproduction, aggregateReproductions, shouldInterrupt,
  precheckReport, reportFingerprint, precheckable, alreadyChecked,
  PRECHECK_ANGLES, DEFAULT_PRECHECK_AGENTS,
}=await import('../dist/terminal/precheck.js');

const yes=(agent,evidence='$ npm test → 2 failures')=>({agent,state:'yes',evidence,reason:'测试失败'});
const no=(agent)=>({agent,state:'no',evidence:'检查了代码路径',reason:'该分支不可达'});
const unclear=(agent)=>({agent,state:'unclear',evidence:'',reason:'报告缺少步骤'});

test('each reproduction task gets a distinct angle instead of repeating the same attempt',()=>{
  const seen=new Set(PRECHECK_ANGLES.map(item=>item.key));
  assert.equal(seen.size,PRECHECK_ANGLES.length,'angles do not overlap');
  assert.equal(DEFAULT_PRECHECK_AGENTS,3,'three angles, one agent each');
  // 派给三个代表时，三份任务正文必须不同。
  const texts=PRECHECK_ANGLES.map(item=>reproduceInstruction({report:'登录后跳转到空白页',angle:item.angle,index:0}));
  assert.equal(new Set(texts).size,PRECHECK_ANGLES.length,'no two agents get the same instruction');
});

test('the task states the read-only bound and forbids fixing',()=>{
  const text=reproduceInstruction({report:'构建在 Windows 上失败',angle:PRECHECK_ANGLES[0].angle,index:0});
  assert.match(text,/只读/);
  assert.match(text,/不要修改、创建、删除/);
  assert.match(text,/不要修问题/,'precheck answers whether, not how');
  assert.match(text,/REPRODUCED: yes\|no\|unclear/);
  assert.match(text,/EVIDENCE:/);
  assert.match(text,/含糊时必须选这个，不要选 no/);
});

test('a yes without evidence degrades to unclear',()=>{
  // 代表很容易说"能复现"再给一段猜测。把它当确认等于让预检自己造 bug。
  const parsed=parseReproduction('审查官','## 结论\nREPRODUCED: yes — 我觉得可以');
  assert.equal(parsed.state,'unclear');
  assert.match(parsed.reason,/未给证据/);
  // 带证据才是 yes。
  assert.equal(parseReproduction('A','REPRODUCED: yes — 测试失败\nEVIDENCE: $ npm test → 2 failed').state,'yes');
});

test('an unparsable reply is unclear, never no',()=>{
  assert.equal(parseReproduction('A','什么都没说').state,'unclear');
  assert.equal(parseReproduction('A','').state,'unclear');
  // no 不需要证据——检查过什么本身就是结论。
  assert.equal(parseReproduction('A','REPRODUCED: no — 路径不可达').state,'no');
});

test('one evidenced yes is enough to call it reproduced',()=>{
  const result=aggregateReproductions([yes('审查官'),no('勘察官'),unclear('核验官')]);
  assert.equal(result.verdict,'reproduced');
  assert.equal(result.reproducedBy.length,1);
  assert.equal(result.refuted,1);
  assert.equal(result.unclear,1);
  assert.match(result.summary,/已复现（审查官）/);
});

test('all-no means refuted, but a mixed result does not',()=>{
  assert.equal(aggregateReproductions([no('A'),no('B'),no('C')]).verdict,'refuted');
  // 全部 no 才是"复现不了"；有 unclear 时不能这么说，否则难复现的真问题会被埋掉。
  const mixed=aggregateReproductions([no('A'),unclear('B'),unclear('C')]);
  assert.equal(mixed.verdict,'inconclusive');
  assert.match(mixed.summary,/无法判断/);
  assert.match(mixed.summary,/需要更具体的步骤/);
});

test('an empty result set is inconclusive rather than refuted',()=>{
  const result=aggregateReproductions([]);
  assert.equal(result.verdict,'inconclusive');
  assert.equal(result.refuted,0);
});

test('only a reproduced verdict interrupts the human',()=>{
  assert.equal(shouldInterrupt(aggregateReproductions([yes('A')])),true);
  assert.equal(shouldInterrupt(aggregateReproductions([no('A'),no('B')])),false,'refuted is a reply, not an interruption');
  assert.equal(shouldInterrupt(aggregateReproductions([unclear('A')])),false,'a vague report needs a question, not an alarm');
});

test('the report explains what was tried even when nothing was reproduced',()=>{
  const attempts=[no('审查官'),unclear('核验官')];
  const text=precheckReport({report:'保存后数据丢失',result:aggregateReproductions(attempts),attempts});
  assert.match(text,/未能复现|无法判断/);
  assert.match(text,/各角度的尝试/);
  assert.match(text,/审查官（no）/);
  // 三种结论的下一步建议必须不同：它们要求的行动不一样。
  const refuted=precheckReport({report:'x',result:aggregateReproductions([no('A')]),attempts:[no('A')]});
  const vague=precheckReport({report:'x',result:aggregateReproductions([unclear('A')]),attempts:[unclear('A')]});
  assert.notEqual(refuted,vague);
  assert.match(refuted,/未能复现不等于不存在/);
  assert.match(vague,/索取/);
});

test('a reproduced report carries the evidence through to the human',()=>{
  const attempts=[yes('审查官','$ npm test → AssertionError at auth.spec.ts:42')];
  const text=precheckReport({report:'测试挂了',result:aggregateReproductions(attempts),attempts});
  assert.match(text,/已复现/);
  assert.match(text,/auth\.spec\.ts:42/,'the human gets the actual evidence');
  assert.match(text,/可以按正常流程派修复任务/);
});

test('reports too short or too long are refused before spending three seats',()=>{
  assert.equal(precheckable('').ok,false);
  assert.match(precheckable('坏了').reason,/太短/);
  assert.equal(precheckable('登录后跳转到空白页，控制台报 500').ok,true);
  assert.match(precheckable('长'.repeat(5000)).reason,/过长/);
});

test('the same report in different punctuation counts as already checked',()=>{
  const fingerprint=reportFingerprint('保存后数据丢失！');
  assert.equal(fingerprint,reportFingerprint('保存后数据丢失'));
  assert.equal(fingerprint,reportFingerprint('  保存后 数据丢失。'));
  const records=[{id:'p1',at:1,fingerprint,verdict:'refuted',summary:'s',attempts:3}];
  assert.ok(alreadyChecked(records,'保存后数据丢失'));
  assert.equal(alreadyChecked(records,'完全不同的另一个问题'),undefined);
});

// 去重是这张表唯一的用途：重复报告不该再开三席。
test('the same report is never prechecked twice',async()=>{
  const {KeposDatabase}=await import('../dist/terminal/database.js');
  const {PrecheckStore}=await import('../dist/terminal/precheck.js');
  const dir=mkdtempSync(join(tmpdir(),'kepos-pc-'));
  const db=new KeposDatabase(join(dir,'k.sqlite'));
  try{
    const store=new PrecheckStore(db);
    assert.equal(store.find('保存后数据丢失'),undefined);
    const result=aggregateReproductions([no('审查官'),no('勘察官')]);
    store.record({report:'保存后数据丢失',result,attempts:2,at:1000});
    const found=store.find('保存后数据丢失。');
    assert.ok(found,'punctuation differences still match');
    assert.equal(found.verdict,'refuted');
    assert.equal(found.attempts,2);
    assert.equal(store.recent().length,1);
    // 不同的报告不互相命中。
    assert.equal(store.find('构建在 Windows 上失败'),undefined);
  }finally{db.close();}
});
