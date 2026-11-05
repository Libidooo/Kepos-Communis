import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-gev-home-'));

const {
  publishEvidence, readGroupEvidence, renderPeerEvidence, clearGroupEvidence,
  evidenceRoot, groupEvidenceFor, EVIDENCE_DIR, MAX_EVIDENCE_CHARS,
} = await import('../dist/terminal/group-evidence.js');

const archive=()=>join(mkdtempSync(join(tmpdir(),'kepos-gev-')),'.kepos');
const OUTPUT_WITH_CONCLUSION=[
  '读了三处实现，鉴权走 bearer token。',
  '工具输出：auth.ts:42 使用 JWT。',
  '## 结论',
  '鉴权是安全的。',
  '## 证据',
  'auth.ts:42',
].join('\n');

// 这一条是整个功能的安全底线：共享事实，绝不共享判断。
test('the published evidence never contains the conclusion',()=>{
  const root=archive();
  publishEvidence({archiveRoot:root,groupId:'squad1',task:{id:'t1',agent:'审查官',output:OUTPUT_WITH_CONCLUSION,status:'完成'}});
  const file=join(evidenceRoot(root,'squad1'),'t1.md');
  const text=readFileSync(file,'utf8');
  assert.match(text,/auth\.ts:42 使用 JWT/,'evidence is kept');
  assert.doesNotMatch(text,/鉴权是安全的/,'the conclusion must not be published');
  assert.doesNotMatch(text,/## 结论/,'not even the heading');
});

// 没有契约标记时整段都是证据——宁可少给结论，也不把过程误当结论。
test('output without a conclusion heading is published whole as evidence',()=>{
  const root=archive();
  publishEvidence({archiveRoot:root,groupId:'g',task:{id:'t2',agent:'A',output:'只读了文件，没写结论。'}});
  const items=readGroupEvidence(root,'g','');
  assert.equal(items.length,1);
  assert.match(items[0].body,/没写结论/);
});

test('peers can read each other but not their own file',()=>{
  const root=archive();
  publishEvidence({archiveRoot:root,groupId:'g',task:{id:'mine',agent:'我',output:'我的证据'}});
  publishEvidence({archiveRoot:root,groupId:'g',task:{id:'theirs',agent:'他',output:'他的证据'}});
  const seenByThem=readGroupEvidence(root,'g','mine');
  assert.equal(seenByThem.length,1);
  assert.equal(seenByThem[0].agent,'他');
  // 自己那份不该重复出现在自己的注入里。
  assert.equal(readGroupEvidence(root,'g','theirs')[0].agent,'我');
});

test('evidence does not leak across groups',()=>{
  const root=archive();
  publishEvidence({archiveRoot:root,groupId:'g1',task:{id:'a',agent:'A',output:'一组的证据'}});
  publishEvidence({archiveRoot:root,groupId:'g2',task:{id:'b',agent:'B',output:'二组的证据'}});
  assert.equal(readGroupEvidence(root,'g1','x')[0].body,'一组的证据');
  assert.equal(readGroupEvidence(root,'g2','x')[0].body,'二组的证据');
  assert.deepEqual(readGroupEvidence(root,'g3','x'),[]);
});

test('a task with no output publishes nothing instead of an empty file',()=>{
  const root=archive();
  assert.equal(publishEvidence({archiveRoot:root,groupId:'g',task:{id:'t',agent:'A',output:''}}),false);
  assert.equal(publishEvidence({archiveRoot:root,groupId:'g',task:{id:'t',agent:'A',output:'   '}}),false);
  // 只有结论、没有证据段：同样不写。
  assert.equal(publishEvidence({archiveRoot:root,groupId:'g',task:{id:'t',agent:'A',output:'## 结论\n只有结论'}}),false);
});

test('a task with no group publishes nothing',()=>{
  const root=archive();
  assert.equal(publishEvidence({archiveRoot:root,groupId:'',task:{id:'t',agent:'A',output:'证据'}}),false);
});

test('long evidence is truncated rather than carrying the whole context',()=>{
  const root=archive();
  publishEvidence({archiveRoot:root,groupId:'g',task:{id:'t',agent:'A',output:'x'.repeat(MAX_EVIDENCE_CHARS*2)}});
  const body=readGroupEvidence(root,'g','')[0].body;
  assert.ok(body.length<MAX_EVIDENCE_CHARS+400,`bounded, got ${body.length}`);
  assert.match(body,/已截断/);
});

test('the injected block states that evidence is not a judgement',()=>{
  const root=archive();
  publishEvidence({archiveRoot:root,groupId:'g',task:{id:'t',agent:'审查官',output:'事实一\n事实二'}});
  const text=renderPeerEvidence(readGroupEvidence(root,'g',''));
  assert.match(text,/同组证据/);
  assert.match(text,/不含结论/);
  assert.match(text,/不要据此推断他们的判断/);
  assert.match(text,/事实一/);
  // 空集合不产生空标题。
  assert.equal(renderPeerEvidence([]),'');
});

test('clearing a group removes its evidence',()=>{
  const root=archive();
  publishEvidence({archiveRoot:root,groupId:'g',task:{id:'a',agent:'A',output:'证据'}});
  assert.equal(clearGroupEvidence(root,'g'),1);
  assert.deepEqual(readGroupEvidence(root,'g',''),[]);
});

// 既有的 workgroup.ts 切分逻辑此前从未被调用，这里把它接上同一条链。
test('groupEvidenceFor reuses the single evidence/conclusion split',()=>{
  const item=groupEvidenceFor({taskId:'t',agent:'A',state:'运行中',started:1},OUTPUT_WITH_CONCLUSION);
  assert.match(item.body,/JWT/);
  assert.doesNotMatch(item.body,/安全/);
  assert.equal(item.agent,'A');
});

test('a malformed file in the evidence directory is skipped, not fatal',()=>{
  const root=archive();
  publishEvidence({archiveRoot:root,groupId:'g',task:{id:'good',agent:'A',output:'好证据'}});
  mkdirSync(evidenceRoot(root,'g'),{recursive:true});
  writeFileSync(join(evidenceRoot(root,'g'),'weird.md'),'没有抬头');
  const items=readGroupEvidence(root,'g','');
  assert.ok(items.length>=1,'the good one still reads');
  assert.ok(readdirSync(evidenceRoot(root,'g')).includes('weird.md'));
  assert.equal(EVIDENCE_DIR,'evidence');
});
