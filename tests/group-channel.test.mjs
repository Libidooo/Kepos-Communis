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
const {KeposDatabase}=await import('../dist/terminal/database.js');

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

// ── 推举呈报 ────────────────────────────────────────────────────────────
const { assessCandidate, buildElectionReport, rankAssessments, renderElectionReport, ElectionStore } =
  await import('../dist/terminal/election-report.js');

const profile = (over = {}) => ({ id: 'a1', name: '审查官', model: 'relay/x', provider: 'relay', role: '审查鉴权与依赖。只读。', roleKey: 'auditor', ...over });
const task = (over = {}) => ({ id: 'w1', agent: '审查官', agentId: 'a1', state: 'SUCCEEDED', started: 100, ended: 200, profileRevision: 'r1', ...over });

// 评估的优先级是"健康度 → 职责 → 票数"，不是反过来。
test('a candidate with a clean history is ready, and the rationale points at the numbers', () => {
  const a = assessCandidate({ candidate: { taskId: 't1', agent: '审查官', votes: 3 }, profile: profile(), tasks: [task(), task({ id: 'w2' })] });
  assert.equal(a.verdict, 'ready');
  assert.match(a.rationale, /近 2 轮完成 2 轮/);
  assert.equal(a.roleKey, 'auditor');
});

test('consecutive failures make a candidate unsuitable no matter how many votes it has', () => {
  const failing = [task({ id: 'w1', state: 'FAILED', error: 'boom' }), task({ id: 'w2', state: 'FAILED', error: 'boom' }), task({ id: 'w3', state: 'FAILED', error: 'boom' })];
  const a = assessCandidate({ candidate: { taskId: 't1', agent: '审查官', votes: 9 }, profile: profile(), tasks: failing });
  assert.equal(a.verdict, 'avoid');
  assert.match(a.rationale, /连续 3 轮/);
  assert.ok(a.issues.length > 0, 'the evidence is attached');
  // 被全组推举但连续失败，排名仍应靠后。
  const ready = assessCandidate({ candidate: { taskId: 't2', agent: '勘察官', votes: 1 }, profile: profile({ name: '勘察官' }), tasks: [task({ agentId: 'a2', agent: '勘察官' })] });
  assert.equal(rankAssessments([a, ready])[0].name, '勘察官', 'a reliable candidate outranks a popular failing one');
});

test('no history is caution, not ready — an unknown is not a clean record', () => {
  const a = assessCandidate({ candidate: { taskId: 't1', agent: '审查官', votes: 2 }, profile: profile(), tasks: [] });
  assert.equal(a.verdict, 'caution');
  assert.match(a.rationale, /还没有足够的完成记录/);
});

test('the report recommends conditionally and never declares a winner', () => {
  const a = assessCandidate({ candidate: { taskId: 't1', agent: '审查官', votes: 2 }, profile: profile(), tasks: [task()] });
  const report = buildElectionReport({ groupId: 'g1', goal: '审查鉴权', electorate: 3, ballots: 2, tied: false, assessments: [a] });
  assert.match(report.recommendation, /若无异议，建议推举/);
  assert.match(report.approvalLine, /推举「审查官」兼任代理总代/);
  assert.doesNotMatch(report.recommendation, /最佳人选/, 'the system does not make the judgement');
});

test('a tie is handed to the human instead of being resolved', () => {
  const mk = (name) => assessCandidate({ candidate: { taskId: 't', agent: name, votes: 2 }, profile: profile({ name }), tasks: [task({ agent: name, agentId: name })] });
  const report = buildElectionReport({ groupId: 'g1', electorate: 3, ballots: 4, tied: true, assessments: [mk('审查官'), mk('勘察官')] });
  assert.match(report.recommendation, /请人类在候选之间指定/);
  assert.match(report.recommendation, /系统不代为裁定/);
});

test('the rendered report leads with the decision and keeps evidence attached', () => {
  const a = assessCandidate({ candidate: { taskId: 't1', agent: '审查官', votes: 2 }, profile: profile(), tasks: [task({ state: 'FAILED', error: 'boom' })] });
  const text = renderElectionReport(buildElectionReport({ groupId: 'g1', electorate: 3, ballots: 2, tied: false, assessments: [a] }));
  assert.match(text, /# 推举代理总代 · 组 g1/);
  assert.match(text, /## 建议/);
    assert.match(text, /· 审查官/, 'candidates are one line each');
    assert.match(text, /批准即推举该代表兼任代理总代/);
});

test('an approved coordinator is recorded and returned for the group', () => {
  const db = new KeposDatabase(join(fresh(), 'k.sqlite'));
  try {
    const store = new ElectionStore(db);
    const a = assessCandidate({ candidate: { taskId: 't1', agent: '审查官', votes: 2 }, profile: profile(), tasks: [task()] });
    const report = buildElectionReport({ groupId: 'g1', electorate: 2, ballots: 2, tied: false, assessments: [a] });
    const record = store.submit(report, 1000);
    assert.equal(store.pending().length, 1);
    assert.equal(store.coordinator('g1'), undefined, 'nothing is decided before a human approves');
    assert.equal(store.approve(record.id, '审查官', 2000), true);
    assert.equal(store.coordinator('g1'), '审查官');
    assert.equal(store.pending().length, 0);
    // 重复批准无效：决定只做一次。
    assert.equal(store.approve(record.id, '别人', 3000), false);
  } finally { db.close(); }
});

test('a newer submission makes the older pending one stale', () => {
  const db = new KeposDatabase(join(fresh(), 'k2.sqlite'));
  try {
    const store = new ElectionStore(db);
    const a = assessCandidate({ candidate: { taskId: 't', agent: '审查官', votes: 1 }, profile: profile(), tasks: [task()] });
    const report = buildElectionReport({ groupId: 'g1', electorate: 2, ballots: 1, tied: false, assessments: [a] });
    store.submit(report, 1000);
    store.submit(report, 2000);
    assert.equal(store.pending().length, 1, 'only the newest stays pending');
  } finally { db.close(); }
});

// 票可能投给已删除或改名的代表。这种情况不是"首次牵头"，
// 而是"这个人不存在"——给不存在的人安排工作是最糟的静默失败。
test('a candidate with no configuration is rejected, not treated as a newcomer', () => {
  const a = assessCandidate({ candidate: { taskId: 't', agent: '已删除的人', votes: 3 }, tasks: [] });
  assert.equal(a.verdict, 'avoid');
  assert.match(a.rationale, /找不到该代表的配置/);
  assert.doesNotMatch(a.rationale, /首次/);
  // 它也不该因为票数高就排到前面。
  const ready = assessCandidate({ candidate: { taskId: 't2', agent: '审查官', votes: 1 }, profile: profile(), tasks: [task()] });
  assert.equal(rankAssessments([a, ready])[0].name, '审查官');
});

// 建议与"待批准"必须指向同一个人（或都说没有）。
// 建议说"暂不推举"而待批准写着某人名字，只看后者的人会批错。
test('the approval line never names someone the recommendation rejected', () => {
  const failing = [task({ id: 'w1', state: 'FAILED', error: 'x' }), task({ id: 'w2', state: 'FAILED', error: 'x' }), task({ id: 'w3', state: 'FAILED', error: 'x' })];
  const avoid = assessCandidate({ candidate: { taskId: 't', agent: '审查官', votes: 9 }, profile: profile(), tasks: failing });
  const report = buildElectionReport({ groupId: 'g1', electorate: 3, ballots: 9, tied: false, assessments: [avoid] });
  assert.match(report.recommendation, /建议暂不推举/);
  assert.doesNotMatch(report.approvalLine, /推举「审查官」/, 'the approval line must not name a rejected candidate');
  assert.match(report.approvalLine, /暂无合适的推举人选/);
});

test('an empty candidate list says so instead of naming nobody', () => {
  const report = buildElectionReport({ groupId: 'g1', electorate: 2, ballots: 0, tied: false, assessments: [] });
  assert.match(report.recommendation, /没有可评估的候选人/);
  assert.match(report.approvalLine, /还没有推举表态/);
});

// 注释说"不猜意图"，正则此前却在猜：否定句和疑问句都被算成支持票。
test('a denial or a question is not a nomination',()=>{
  const members=[{taskId:'a',agent:'审查官'},{taskId:'b',agent:'勘察官'}];
  const say=(text)=>({groupId:'g',taskId:'a',agent:'审查官',kind:'discuss',text,at:1});
  for(const text of ['我不同意推举：勘察官','反对推举：勘察官','要不要推举：勘察官？','是否推举：勘察官','不必推举：勘察官','do not nominate: 勘察官']){
    assert.equal(tallyElection([say(text)],members).ballots,0,`counted a ballot from: ${text}`);
  }
  // 正常表态仍然算票，包括句中带標点的写法。
  assert.equal(tallyElection([say('推举：勘察官')],members).ballots,1);
  assert.equal(tallyElection([say('另外，推举：勘察官')],members).ballots,1);
});
