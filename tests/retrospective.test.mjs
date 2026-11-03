import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {KeposDatabase}=await import('../dist/terminal/database.js');
const {shouldConsolidate, candidateFromTask, ConsolidationPipeline}=await import('../dist/terminal/memory-pipeline.js');
const {consolidationPrompt}=await import('../dist/terminal/memory.js');

function fresh(){
 const dir=mkdtempSync(join(tmpdir(),'kepos-retro-'));
 return new KeposDatabase(join(dir,'kepos.sqlite'));
}

// 失败任务常常只有错误、没有产出——正是这类最需要留下教训。
test('a failed task with only an error message is still worth reviewing',()=>{
 const never=()=>false;
 assert.equal(shouldConsolidate({id:'w',agentId:'a',status:'失败',error:'认证失败：401'},never),true);
 assert.equal(shouldConsolidate({id:'w',agentId:'a',status:'超时',error:'deadline'},never),true);
 assert.equal(shouldConsolidate({id:'w',agentId:'a',status:'已中断',error:'owner exited'},never),true);
 // 没有错误的空任务仍然跳过：没有可复盘的内容。
 assert.equal(shouldConsolidate({id:'w',agentId:'a',status:'失败'},never),false);
 assert.equal(shouldConsolidate({id:'w',agentId:'a',status:'完成'},never),false,'a successful empty task has nothing either');
 // 已整理过的不重复。
 assert.equal(shouldConsolidate({id:'w',agentId:'a',status:'失败',error:'x'},()=>true),false);
});

test('the candidate carries the error and marks the task failed',()=>{
 const ok=candidateFromTask({id:'w',agentId:'a',title:'审查鉴权',status:'完成',output:'发现两处'});
 assert.equal(ok.failed,false);
 assert.equal(ok.error,undefined);
 const bad=candidateFromTask({id:'w',agentId:'a',title:'审查鉴权',status:'超时',error:'deadline reached after 300s'});
 assert.equal(bad.failed,true);
 assert.match(bad.error,/deadline/);
 // 临时代表（无 agentId）不产生候选：记忆无处归属。
 assert.equal(candidateFromTask({id:'w',title:'x',output:'y'}),null);
});

// 复盘问的是"下次怎么委派"，不是"这次怎么失败的"。
test('the failed-task prompt asks for a delegation lesson, not a retelling',()=>{
 const prompt=consolidationPrompt({goal:'审查鉴权',outputTail:'',memories:[],failed:true,error:'认证失败：401'});
 assert.match(prompt,/## 失败原因/);
 assert.match(prompt,/认证失败：401/);
 assert.match(prompt,/下次同类任务该怎么委派/);
 assert.match(prompt,/不要复述失败经过/);
 assert.match(prompt,/（无产出）/,'an empty result is stated, not faked');
 // 成功任务的问法保持原样。
 assert.doesNotMatch(consolidationPrompt({goal:'x',outputTail:'y',memories:[]}),/失败原因/);
});

test('a failed task with no output is queued and consolidated into lessons',async () => {
 const db=fresh();
 const modelCalls=[];
 const pipeline=new ConsolidationPipeline(db,async(prompt)=>{
  modelCalls.push(prompt);
  return '[{"op":"ADD","content":"鉴权任务需要先提供有效凭据；无凭据时直接要求人类配置"}]';
 });
 try{
  const candidate=candidateFromTask({id:'w1',agentId:'agent-a',title:'审查鉴权',status:'失败',error:'认证失败：401'});
  assert.equal(pipeline.enqueue(candidate),true,'an error-only failure enters the queue');
  const result=await pipeline.drain();
  assert.equal(result.processed,1);
  assert.equal(modelCalls.length,1);
  assert.match(modelCalls[0],/认证失败：401/,'the error is what the model sees');
  const lessons=pipeline.list('agent-a');
  assert.equal(lessons.length,1);
  assert.equal(lessons[0].sourceWorkerId,'w1');
  assert.match(lessons[0].content,/凭据/);
 }finally{db.close();}
});

test('a successful task does not produce a delegation lesson',()=>{
 // 成功任务的整理走原路径，不触发"失败原因"分支；这里验证候选本身不标记失败。
 const good=candidateFromTask({id:'w',agentId:'a',title:'x',status:'完成',output:'done'});
 assert.equal(good.failed,false);
 assert.doesNotMatch(consolidationPrompt({goal:'x',outputTail:'done',memories:[],failed:good.failed}),/## 失败原因/);
});
