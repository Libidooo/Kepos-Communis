import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {KeposDatabase}=await import('../dist/terminal/database.js');
const {RepresentativeMemory, parseConsolidationOps}=await import('../dist/terminal/memory.js');
const {
  slugOf, procedureOf, renderSkill, writeProposal, listProposals, adoptProposal,
  discardProposal, candidatesFromProcedures, SKILL_TRIGGER_WORKERS, MAX_SKILL_BODY_CHARS,
}=await import('../dist/terminal/skill-proposal.js');

const freshDir=()=>mkdtempSync(join(tmpdir(),'kepos-skill-'));

test('a procedure memory carries a slug and the steps read back cleanly',()=>{
  assert.equal(slugOf('slug=fetch-build-log 步骤：1) 取日志 2) 过滤'),'fetch-build-log');
  assert.equal(slugOf('步骤 slug: fetch-build-log'),'fetch-build-log');
  assert.equal(slugOf('普通事实，没有 slug'),undefined);
  // 形状不规范的 slug 被规范化成合法目录名，而不是整条丢弃。
  assert.equal(slugOf('slug=Bad_Slug!'),'bad-slug');
  // 规范化后仍然不合法（太短）才丢弃。
  assert.equal(slugOf('slug=a!'),undefined);
  assert.match(procedureOf('slug=fetch-build-log 步骤：1) 取日志'),/^步骤：1\) 取日志/);
});

test('the procedure kind is only kept when the slug is present',()=>{
  // 没有 slug 的"过程"只是散文，无法跨任务归并，按普通事实存。
  const ops=parseConsolidationOps('[{"op":"ADD","kind":"procedure","content":"slug=deploy-check 步骤：1) 构建"},{"op":"ADD","kind":"procedure","content":"没有 slug 的步骤"}]');
  assert.equal(ops[0].kind,'procedure');
  assert.equal(ops[1].kind,'procedure','parsing keeps what the model said');
  // apply 才决定是否真的当作 procedure。
  const dir=freshDir();const db=new KeposDatabase(join(dir,'k.sqlite'));
  try{
    const mem=new RepresentativeMemory(db);
    mem.apply('a',ops,'w1',1000);
    const rows=mem.active('a');
    assert.equal(rows.find(row=>/deploy-check/.test(row.content)).kind,'procedure');
    assert.equal(rows.find(row=>/没有 slug/.test(row.content)).kind,'semantic','a slugless procedure cannot be grouped');
  }finally{db.close();}
});

test('three distinct workers on the same slug make a skill candidate; two do not',()=>{
  const dir=freshDir();const db=new KeposDatabase(join(dir,'k.sqlite'));
  try{
    const mem=new RepresentativeMemory(db);
    const slug='fetch-build-log';
    for(const worker of ['w1','w2']){
      mem.add({agentId:'a',kind:'procedure',content:`slug=${slug} 步骤：${worker} 取出构建日志`,sourceWorkerId:worker,now:100});
    }
    assert.deepEqual(candidatesFromProcedures(mem.active('a').filter(r=>r.kind==='procedure').map(r=>({content:r.content,workerId:r.sourceWorkerId})), s=>mem.procedureCount('a',s)),[],
      `two workers is below the trigger of ${SKILL_TRIGGER_WORKERS}`);
    mem.add({agentId:'a',kind:'procedure',content:`slug=${slug} 步骤：w3 过滤错误行`,sourceWorkerId:'w3',now:200});
    const candidates=candidatesFromProcedures(mem.active('a').filter(r=>r.kind==='procedure').map(r=>({content:r.content,workerId:r.sourceWorkerId})), s=>mem.procedureCount('a',s));
    assert.equal(candidates.length,1);
    assert.equal(candidates[0].slug,slug);
    assert.equal(candidates[0].steps.length,3,'steps from all three tasks are collected');
  }finally{db.close();}
});

test('the same worker repeating a procedure never triggers a skill',()=>{
  const dir=freshDir();const db=new KeposDatabase(join(dir,'k.sqlite'));
  try{
    const mem=new RepresentativeMemory(db);
    // 同一个任务里重复三遍只是没写好，不是可复用流程。
    for(let n=0;n<3;n++)mem.add({agentId:'a',kind:'procedure',content:'slug=loop 步骤：同一任务内重复',sourceWorkerId:'w1',now:100+n});
    assert.equal(mem.procedureCount('a','loop'),1);
    assert.deepEqual(candidatesFromProcedures(mem.active('a').map(r=>({content:r.content})), s=>mem.procedureCount('a',s)),[]);
  }finally{db.close();}
});

test('a proposal is written to skills-proposed and never to skills',()=>{
  const agentDir=freshDir();
  const proposal=writeProposal(agentDir,{slug:'fetch-build-log',description:'取出构建日志并过滤错误行',steps:['取日志','过滤错误行'],agent:'审查官'});
  assert.ok(existsSync(join(agentDir,'skills-proposed','fetch-build-log','SKILL.md')),'proposed, not installed');
  assert.equal(existsSync(join(agentDir,'skills','fetch-build-log')),false,'nothing lands in the live skill directory');
  const text=readFileSync(proposal.path,'utf8');
  // frontmatter 两个字段是 agentskills 的标准形状。
  assert.match(text,/^---\nname: fetch-build-log\ndescription: /);
  assert.match(text,/1\. 取日志/);
  assert.match(text,/## 边界/,'boundaries travel with the skill');
  assert.ok(text.length<=MAX_SKILL_BODY_CHARS);
  // 列表能读回
  const list=listProposals(agentDir);
  assert.equal(list.length,1);
  assert.deepEqual(list[0].steps,['取日志','过滤错误行']);
});

test('adopting moves the proposal into skills and old names are never clobbered',()=>{
  const agentDir=freshDir();
  writeProposal(agentDir,{slug:'a-skill',description:'x',steps:['s'],});
  const installed=adoptProposal(agentDir,'a-skill');
  assert.equal(installed,join(agentDir,'skills','a-skill'));
  assert.ok(existsSync(join(installed,'SKILL.md')));
  assert.equal(listProposals(agentDir).length,0,'an adopted proposal leaves the review list');
  // 人的安装优先：同名再次采纳会被拒绝，不覆盖。
  writeProposal(agentDir,{slug:'a-skill',description:'y',steps:['s2'],});
  assert.throws(()=>adoptProposal(agentDir,'a-skill'),/已经安装过/);
  assert.match(readFileSync(join(installed,'SKILL.md'),'utf8'),/1\. s\n/,'the installed copy is untouched');
});

test('discarding removes a proposal and bad slugs are refused',()=>{
  const agentDir=freshDir();
  writeProposal(agentDir,{slug:'gone',description:'x',steps:[],});
  assert.equal(discardProposal(agentDir,'gone'),true);
  assert.equal(discardProposal(agentDir,'gone'),false);
  assert.throws(()=>writeProposal(agentDir,{slug:'../escape',description:'x',steps:[],}),/非法/);
  assert.throws(()=>adoptProposal(agentDir,'../escape'),/非法/);
});

test('a hand-broken proposal file does not break the whole list',()=>{
  const agentDir=freshDir();
  writeProposal(agentDir,{slug:'good',description:'ok',steps:['one'],});
  const broken=join(agentDir,'skills-proposed','bad');
  mkdirSync(broken,{recursive:true});
  writeFileSync(join(broken,'SKILL.md'),'not a skill at all');
  const list=listProposals(agentDir);
  assert.ok(list.some(item=>item.slug==='good'),'the readable proposal still lists');
});

test('renderSkill bounds an over-long body and always states the boundary',()=>{
  const text=renderSkill({slug:'big',description:'d',steps:Array(200).fill('很长的步骤'.repeat(20))});
  assert.ok(text.length<=MAX_SKILL_BODY_CHARS);
  assert.match(text,/## 边界/);
});

// 采纳必须含两步：移文件 + 写进代表 skills[]。只移文件等于装了没人用。
test('a proposal records which representative it came from',()=>{
  const agentDir=freshDir();
  writeProposal(agentDir,{slug:'from-agent',description:'d',steps:['s'],agent:'审查官'});
  const [proposal]=listProposals(agentDir);
  assert.equal(proposal.agent,'审查官','adoption needs to know who to bind the skill to');
});

test('an older proposal without an author reads back with an empty agent',()=>{
  const agentDir=freshDir();
  // 手写一份没有来源句的提议：不能因此读不出这条提议。
  const dir=join(agentDir,'skills-proposed','legacy');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'SKILL.md'),'---\nname: legacy\ndescription: old\n---\n\n## 步骤\n\n1. step\n\n## 边界\n\n- x\n');
  const [proposal]=listProposals(agentDir);
  assert.equal(proposal.slug,'legacy');
  assert.equal(proposal.agent,'');
});
