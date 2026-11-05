import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {
  postGroupMessage, readGroupMessages, renderGroupChannel, groupDir,
  MAX_MESSAGE_CHARS, MAX_MESSAGES_PER_GROUP,
}=await import('../dist/terminal/group-channel.js');
const {tallyElection, electionOutcome, coordinatorBrief, MIN_ELECTORATE}=await import('../dist/terminal/group-election.js');

const fresh=()=>mkdtempSync(join(tmpdir(),'kepos-group-'));
const msg=(over={})=>({groupId:'g1',taskId:'t1',agent:'审查官',kind:'status',text:'查完 auth 目录',...over});

// 组通道只承载三种内容：状态、讨论、异议。
// 推理与结论不在此列——那是各自独立形成的东西。
test('the channel carries status, discussion and dissent',()=>{
  const root=fresh();
  for(const kind of ['status','discuss','challenge'])postGroupMessage(root,msg({kind,text:`${kind} 的内容`}));
  const messages=readGroupMessages(root,'g1');
  assert.equal(messages.length,3);
  assert.deepEqual(new Set(messages.map(m=>m.kind)),new Set(['status','discuss','challenge']));
});

test('messages are bounded and pruned so the channel never becomes a second context',()=>{
  const root=fresh();
  const long=postGroupMessage(root,msg({text:'长'.repeat(MAX_MESSAGE_CHARS+500)}));
  assert.equal(long.text.length,MAX_MESSAGE_CHARS);
  // 超出上限后只留最近的那些：组内关心当下，不是完整纪要。
  for(let n=0;n<MAX_MESSAGES_PER_GROUP+10;n++)postGroupMessage(root,msg({text:`消息 ${n}`,at:1000+n}));
  const files=readdirSync(groupDir(root,'g1')).filter(f=>f.endsWith('.json'));
  assert.ok(files.length<=MAX_MESSAGES_PER_GROUP,`kept ${files.length}`);
  const messages=readGroupMessages(root,'g1',200);
  assert.ok(messages.some(m=>/消息 69$/.test(m.text)),'the newest survives');
  assert.ok(!messages.some(m=>/消息 0$/.test(m.text)),'the oldest is dropped');
});

test('a group without messages reads as empty rather than failing',()=>{
  assert.deepEqual(readGroupMessages(fresh(),'nobody'),[]);
  assert.equal(renderGroupChannel([],'t1'),'');
});

test('the rendered channel labels kinds and marks the reader as 你',()=>{
  const root=fresh();
  postGroupMessage(root,msg({taskId:'me',agent:'自己',kind:'status',text:'我在查 auth'}));
  postGroupMessage(root,msg({taskId:'other',agent:'勘察官',kind:'challenge',text:'你的依据不成立'}));
  const text=renderGroupChannel(readGroupMessages(root,'g1'),'me');
  assert.match(text,/只含状态与讨论/);
  assert.match(text,/\[状态\] 你：我在查 auth/);
  assert.match(text,/\[异议\] 勘察官：你的依据不成立/);
});

test('an empty message is refused instead of posted',()=>{
  const root=fresh();
  assert.throws(()=>postGroupMessage(root,msg({text:'   '})),/不能为空/);
  assert.throws(()=>postGroupMessage(root,msg({groupId:''})),/groupId/);
});

// 推举：组内协作的牵头人由组员推举，结果是候选。
test('votes are counted only from explicit nominations by discuss messages',()=>{
  const members=[{taskId:'a',agent:'审查官'},{taskId:'b',agent:'勘察官'},{taskId:'c',agent:'核验官'}];
  const messages=[
    msg({taskId:'a',agent:'审查官',kind:'discuss',text:'推举：勘察官牵头'}),
    msg({taskId:'c',agent:'核验官',kind:'discuss',text:'推举：勘察官'}),
    // 状态消息里的"推举"字样不算票。
    msg({taskId:'a',agent:'审查官',kind:'status',text:'推举：核验官'}),
  ];
  const result=tallyElection(messages,members);
  assert.equal(result.ballots,2);
  assert.equal(result.winner.agent,'勘察官');
});

test('self-nomination is not a vote',()=>{
  const members=[{taskId:'a',agent:'审查官'},{taskId:'b',agent:'勘察官'}];
  const result=tallyElection([msg({taskId:'a',agent:'审查官',kind:'discuss',text:'推举：审查官'})],members);
  assert.equal(result.ballots,0);
  assert.equal(result.winner,undefined);
});

test('a tie stays a tie instead of being broken silently',()=>{
  const members=[{taskId:'a',agent:'审查官'},{taskId:'b',agent:'勘察官'},{taskId:'c',agent:'核验官'}];
  const messages=[
    msg({taskId:'a',agent:'审查官',kind:'discuss',text:'推举：勘察官'}),
    msg({taskId:'b',agent:'勘察官',kind:'discuss',text:'推举：审查官'}),
  ];
  const result=tallyElection(messages,members);
  assert.equal(result.tied,true);
  assert.equal(result.winner,undefined);
  const outcome=electionOutcome(result,members.length);
  assert.equal(outcome.decided,false);
  assert.match(outcome.reason,/平票/);
});

test('an election needs people, ballots and a clear leader',()=>{
  const members=[{taskId:'a',agent:'审查官'},{taskId:'b',agent:'勘察官'}];
  // 没人投票。
  assert.match(electionOutcome(tallyElection([],members),members.length).reason,/还没有推举/);
  // 只有一个人。
  assert.match(electionOutcome(tallyElection([],members.slice(0,1)),1).reason,/无需推举/);
  assert.equal(MIN_ELECTORATE,2);
  // 有明确领先者。
  const decided=electionOutcome(tallyElection([msg({taskId:'b',agent:'勘察官',kind:'discuss',text:'推举：审查官'})],members),2);
  assert.equal(decided.decided,true);
  assert.match(decided.reason,/审查官/);
});

// 被推举者不是上级：协调让信息流动，不是替人做判断。
test('the coordinator brief forbids acting like a superior',()=>{
  const text=coordinatorBrief('审查官','g1',['审查官','勘察官']);
  assert.match(text,/你不是上级/);
  assert.match(text,/不能给别人派任务/);
  assert.match(text,/不能代替别人判断/);
  assert.match(text,/不要要求组员汇报思考过程/);
  assert.match(text,/结论必须各自独立形成/);
});
