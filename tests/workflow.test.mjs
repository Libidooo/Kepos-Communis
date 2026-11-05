import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-wf-home-'));

const {
  validateWorkflow, instantiateWorkflow, seatsFromAgents, subst, describeWorkflow,
  renderWorkflow, syncWorkflows, workflowsRoot, newWorkflowId,
  MAX_WORKFLOW_STEPS, WORKFLOWS_DIR,
} = await import('../dist/terminal/workflow.js');

const step=(id,extra={})=>({id,task:`做 ${id}`,roleKey:'auditor',...extra});
const wf=(extra={})=>({
  id:'wf_test', name:'测试工作流', seats:[], steps:[step('a')],
  createdAt:1, updatedAt:1, ...extra,
});

test('a minimal workflow validates',()=>{
  assert.deepEqual(validateWorkflow(wf()),{ok:true,errors:[]});
});

// 编排错误往往成片出现，逐条试错会让人反复往返。
test('validation reports every problem at once',()=>{
  const bad=wf({name:'',steps:[step('a',{task:''}),step('a'),step('b',{dependsOn:['missing']})]});
  const result=validateWorkflow(bad);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(e=>/名称/.test(e)));
  assert.ok(result.errors.some(e=>/缺少任务描述/.test(e)));
  assert.ok(result.errors.some(e=>/id 重复/.test(e)));
  assert.ok(result.errors.some(e=>/不存在的步骤/.test(e)));
});

test('a dependency cycle is refused because it never starts',()=>{
  const cyclic=wf({steps:[step('a',{dependsOn:['b']}),step('b',{dependsOn:['a']})]});
  const result=validateWorkflow(cyclic);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(e=>/成环/.test(e)));
});

test('a step with no target cannot be instantiated',()=>{
  const result=validateWorkflow(wf({steps:[{id:'a',task:'x'}]}));
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(e=>/没有指定派给谁/.test(e)));
});

test('unknown role keys are refused rather than silently ignored',()=>{
  const result=validateWorkflow(wf({steps:[step('a',{roleKey:'not_a_role'})]}));
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(e=>/角色不存在/.test(e)));
});

test('too many steps is refused: a workflow is a process, not a script',()=>{
  const steps=Array.from({length:MAX_WORKFLOW_STEPS+1},(_,i)=>step('s'+i));
  assert.equal(validateWorkflow(wf({steps})).ok,false);
});

// {goal} 是唯一占位符：多几个就会变成没人记得住的模板语言。
test('only {goal} is substituted, and everywhere it appears',()=>{
  assert.equal(subst('审查 {goal} 的鉴权，并记录 {goal} 的风险','登录模块'),'审查 登录模块 的鉴权，并记录 登录模块 的风险');
  assert.equal(subst('没有占位符','x'),'没有占位符');
  assert.equal(subst('{other} 不动','x'),'{other} 不动');
});

test('existing seats are never duplicated by instantiation',()=>{
  const workflow=wf({
    seats:[{name:'审查官',roleKey:'auditor'},{name:'核验官',roleKey:'verifier'}],
    steps:[step('a',{seat:'审查官'})],
  });
  const existing=[{id:'x',name:'审查官',roleKey:'auditor',model:'m',provider:'',role:'r'}];
  const result=instantiateWorkflow(workflow,{goal:'g',defaultModel:'m',existingAgents:existing});
  assert.ok(result.ok);
  // auditor 已存在 → 不新建；verifier 缺 → 新建一个。
  assert.equal(result.seats.length,1);
  assert.equal(result.seats[0].roleKey,'verifier');
});

test('a seat name collision is reported instead of overwriting the member',()=>{
  const workflow=wf({seats:[{name:'审查官',roleKey:'verifier'}],steps:[step('a',{roleKey:'auditor'})]});
  const existing=[{id:'x',name:'审查官',roleKey:'auditor',model:'m',provider:'',role:'r'}];
  const result=instantiateWorkflow(workflow,{goal:'g',defaultModel:'m',existingAgents:existing});
  assert.ok(result.ok);
  assert.equal(result.seats.length,0,'must not replace an existing member');
  assert.ok(result.warnings.some((w)=>w.includes('审查官')),'the collision is surfaced');
});

test('steps resolve by seat name first, then by role key',()=>{
  const workflow=wf({
    seats:[{name:'合规审查官',roleKey:'compliance_officer'}],
    steps:[step('a',{seat:'合规审查官'}),step('b',{roleKey:'auditor'})],
  });
  const existing=[{id:'y',name:'审查官',roleKey:'auditor',model:'m',provider:'',role:'r'}];
  const result=instantiateWorkflow(workflow,{goal:'目标',defaultModel:'m',existingAgents:existing});
  assert.ok(result.ok);
  assert.equal(result.mission.jobs[0].agent.name,'合规审查官');
  assert.equal(result.mission.jobs[0].task,'做 a');
  assert.equal(result.mission.jobs[1].agent.name,'审查官');
});

// 找不到人就整体失败：工作流不该在没人可用时静默跳过某一步。
test('an unresolvable step fails the whole instantiation',()=>{
  const workflow=wf({steps:[step('a'),step('b',{roleKey:'verifier'})]});
  const result=instantiateWorkflow(workflow,{goal:'g',defaultModel:'m',existingAgents:[{id:'y',name:'审查官',roleKey:'auditor',model:'m',provider:'',role:'r'}]});
  assert.equal(result.ok,false);
  assert.ok(result.errors[0].includes('b'));
});

test('acceptance items enter unchecked and are substituted',()=>{
  const workflow=wf({steps:[step('a',{task:'检查 {goal}',acceptance:['{goal} 的测试通过','无新增依赖']})]});
  const result=instantiateWorkflow(workflow,{goal:'鉴权',defaultModel:'m',existingAgents:[{id:'y',name:'审查官',roleKey:'auditor',model:'m',provider:'',role:'r'}]});
  assert.ok(result.ok);
  const acceptance=result.mission.jobs[0].acceptance;
  assert.equal(acceptance.length,2);
  assert.ok(acceptance.every(item=>item.passes===false),'a plan declares conditions, it does not claim them');
  assert.equal(acceptance[0].check,'鉴权 的测试通过');
});

test('groupId flows from the step to the job',()=>{
  const workflow=wf({steps:[step('a',{groupId:'squad1'})]});
  const result=instantiateWorkflow(workflow,{goal:'g',defaultModel:'m',existingAgents:[{id:'y',name:'审查官',roleKey:'auditor',model:'m',provider:'',role:'r'}]});
  assert.ok(result.ok);
  assert.equal(result.mission.jobs[0].groupId,'squad1');
});

test('an empty goal is refused',()=>{
  const result=instantiateWorkflow(wf(),{goal:'   ',defaultModel:'m',existingAgents:[{id:'y',name:'审查官',roleKey:'auditor',model:'m',provider:'',role:'r'}]});
  assert.equal(result.ok,false);
});

test('seatsFromAgents keeps structure and drops history',()=>{
  const seats=seatsFromAgents([
    {id:'1',name:'审查官',roleKey:'auditor',model:'relay/x',provider:'relay',role:'r',skills:['s1']},
    {id:'2',name:'临时',roleKey:undefined,model:'m',provider:'',role:'r'},
  ]);
  // 没有 roleKey 的席位无法被模板复用，跳过。
  assert.equal(seats.length,1);
  assert.deepEqual(seats[0],{name:'审查官',roleKey:'auditor',model:'relay/x',provider:'relay',skills:['s1']});
});

test('describing a workflow states steps, seats and groups',()=>{
  assert.match(describeWorkflow(wf({seats:[{roleKey:'auditor'}],steps:[step('a',{groupId:'g1'}),step('b')]})),/2 步 · 1 席 · 1 个组/);
  assert.match(describeWorkflow(wf()),/1 步 · 沿用现有编制/);
});

test('rendering writes frontmatter, seats and steps in order',()=>{
  const text=renderWorkflow(wf({seats:[{name:'审查官',roleKey:'auditor'}],steps:[step('a',{groupId:'g1',dependsOn:[]} ),step('b',{dependsOn:['a'],acceptance:['通过']})]}));
  assert.match(text,/^---\nid: wf_test\nname: 测试工作流/);
  assert.ok(text.includes('## 席位'));
  assert.ok(text.includes('## 步骤'));
  assert.ok(text.indexOf('### a')<text.indexOf('### b'),'order preserved');
  assert.match(text,/依赖 a/);
  assert.match(text,/\[组 g1\]/);
  assert.match(text,/验收：/);
});

test('sync writes one file per workflow and removes orphans',()=>{
  const dir=mkdtempSync(join(tmpdir(),'kepos-wf-'));
  const archive=join(dir,'.kepos');
  assert.equal(syncWorkflows(archive,[wf(),wf({id:'wf_two',name:'第二个'})]),2);
  const files=readdirSync(workflowsRoot(archive));
  assert.equal(files.length,2);
  // 内容不变不重写。
  assert.equal(syncWorkflows(archive,[wf(),wf({id:'wf_two',name:'第二个'})]),0);
  // 删掉一个 → 文件消失。
  syncWorkflows(archive,[wf()]);
  assert.equal(readdirSync(workflowsRoot(archive)).length,1);
  assert.ok(existsSync(join(workflowsRoot(archive),'wf_test.md')));
  assert.match(readFileSync(join(workflowsRoot(archive),'wf_test.md'),'utf8'),/测试工作流/);
  assert.equal(WORKFLOWS_DIR,'workflows');
});

test('workflow ids are unique and file-safe',()=>{
  const a=newWorkflowId(), b=newWorkflowId();
  assert.notEqual(a,b);
  assert.match(a,/^wf_[a-f0-9]{16}$/);
});
