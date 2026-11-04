import test from 'node:test';
import assert from 'node:assert/strict';
const {
  assessmentPrompt, parseAssessment, gate, canAutoDispatch, dispatchInstruction,
  WATCH_DISPATCH_HEADER, AUTO_DISPATCH_PER_MINUTE, MAX_ASSESS_CHARS,
}=await import('../dist/terminal/watch-assess.js');

const candidate={id:'c1',at:1,ruleId:'readme-sync',kind:'file-changed',path:'/p/README.md',task:'核对 README',agent:'审查官',observeOnly:true};
const assessment=(worth,confidence)=>({worth,confidence,reason:'r'});

// M2 补的是 M1 答不了的问题：路径一样，改动轻重不同。
test('the prompt asks whether verifiable facts changed, not whether the file changed',()=>{
  const prompt=assessmentPrompt(candidate,'新的安装步骤：npm ci');
  assert.match(prompt,/readme-sync/);
  assert.match(prompt,/README\.md/);
  assert.match(prompt,/可验证的事实/);
  assert.match(prompt,/错别字、格式、空白、注释/,'trivial edits are named explicitly');
  assert.ok(prompt.length<3000,'this is a filter decision, not a review');
});

test('an unreadable assessment keeps the candidate instead of dropping it',()=>{
  // 过滤器失败应当退化成"仍然通知人"，不是悄悄吞掉事件。
  assert.equal(parseAssessment('garbage').worth,true);
  assert.equal(parseAssessment('{"confidence":0.9}').worth,true,'missing worth is not a no');
  assert.match(parseAssessment('{}').reason,/保留候选/);
  const ok=parseAssessment('{"worth":false,"confidence":0.9,"reason":"只改了错别字"}');
  assert.equal(ok.worth,false);
  assert.equal(ok.confidence,0.9);
  assert.match(ok.reason,/错别字/);
  // 越界置信度被丢弃而不是当成 1。
  assert.equal(parseAssessment('{"worth":true,"confidence":7}').confidence,undefined);
});

// 唯一决定花不花钱的函数：三件事都必须在这里。
test('only proxy mode with an assignable agent may dispatch',()=>{
  assert.equal(gate({candidate,policy:'human',assignable:true,assessment:assessment(true,1)}).action,'record');
  assert.equal(gate({candidate,policy:'readonly',assignable:true,assessment:assessment(true,1)}).action,'record');
  assert.match(gate({candidate,policy:'human',assignable:true}).reason,/需要人确认/);
  assert.equal(gate({candidate,policy:'proxy',assignable:true,assessment:assessment(true,0.9)}).action,'auto');
});

test('a candidate with no agent or an unavailable agent never auto-dispatches',()=>{
  const orphan={...candidate,agent:''};
  assert.equal(gate({candidate:orphan,policy:'proxy',assignable:true}).action,'record');
  assert.match(gate({candidate:orphan,policy:'proxy',assignable:true}).reason,/未指派代表/);
  assert.equal(gate({candidate,policy:'proxy',assignable:false}).action,'record');
});

test('the assessment can veto, and low confidence is a veto too',()=>{
  assert.equal(gate({candidate,policy:'proxy',assignable:true,assessment:assessment(false,0.95)}).action,'record');
  assert.match(gate({candidate,policy:'proxy',assignable:true,assessment:assessment(false,0.95)}).reason,/不必派人/);
  assert.equal(gate({candidate,policy:'proxy',assignable:true,assessment:assessment(true,0.3)}).action,'record');
  assert.match(gate({candidate,policy:'proxy',assignable:true,assessment:assessment(true,0.3)}).reason,/置信度不足/);
  // 没有评估时程序层准入就够了。
  assert.equal(gate({candidate,policy:'proxy',assignable:true}).action,'auto');
});

// 规则冷却防不住"一次重构改了两百个文件"。
test('auto dispatch is rate limited per minute',()=>{
  const window={stamps:[]};
  for(let n=0;n<AUTO_DISPATCH_PER_MINUTE;n++)assert.equal(canAutoDispatch(window,n*1000),true,`dispatch ${n+1}`);
  assert.equal(canAutoDispatch(window,1000),false,'over the limit in the same minute');
  // 一分钟后恢复。
  assert.equal(canAutoDispatch(window,61000),true);
});

test('the auto-dispatched task is unmistakably not a human instruction',()=>{
  const text=dispatchInstruction(candidate,'### 改了什么');
  assert.ok(text.startsWith(WATCH_DISPATCH_HEADER));
  assert.match(text,/非人类直接指令/);
  assert.match(text,/只读/);
  assert.match(text,/不要修改、创建或删除/);
  assert.match(text,/不要顺带审查整个项目/);
  // 允许代表说"没事"——否则它会为了显得有用而编问题。
  assert.match(text,/无需处理/);
  assert.match(text,/README\.md/);
  assert.ok(text.includes('### 改了什么'));
});

test('evidence passed to the dispatch is bounded',()=>{
  const text=dispatchInstruction(candidate,'x'.repeat(MAX_ASSESS_CHARS*3));
  assert.ok(text.length<MAX_ASSESS_CHARS*2,'the dispatch does not carry an unbounded blob');
});

// 值守派发的任务没有人类在场：给它派生权等于让一条误触发自行繁殖。
// 这里验证标记本身与 workers.ts 的判定条件——两者必须对上。
test('a watch dispatch is marked so it cannot spawn subordinates',async()=>{
  const {readonlyToolsForPurpose,canRepresent} =await import('../dist/terminal/watch-purpose.js');
  assert.equal(canRepresent(0,{purpose:'delegation'}),true,'an ordinary depth-0 task may spawn subordinates');
  assert.equal(canRepresent(0,{purpose:'watch'}),false,'a watcher-dispatched task may not');
  assert.equal(canRepresent(1,{purpose:'delegation'}),false,'subordinates never spawn');
  assert.equal(canRepresent(0,{}),true,'unmarked depth-0 keeps existing behaviour');
  assert.deepEqual(readonlyToolsForPurpose({purpose:'watch'}),['read']);
});
