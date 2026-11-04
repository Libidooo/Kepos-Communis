import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const {
  renderProfile, parseProfile, summarizeRole, profileFileName,
  syncProfiles, readProfiles, profilesRoot,
  renderAgentsFile, syncAgentsFile, PROFILES_DIR, AGENTS_FILE,
}=await import('../dist/terminal/profile-file.js');

const fresh=()=>mkdtempSync(join(tmpdir(),'kepos-profile-'));
const base={id:'a1',name:'审查官',model:'relay/x',provider:'relay',role:'审查鉴权与依赖。仅只读，不修改任何文件。'};

// 往返保真是一切的前提：渲染→解析→再渲染必须逐字节相同。
test('a profile survives the round trip byte for byte',()=>{
  const profiles=[
    base,
    {...base,id:'b',name:'B',roleKey:'auditor',tools:['read','grep'],skills:['academic-paper'],readScope:'project',readAllow:['/tmp/x'],mcpServers:['fs']},
    {...base,id:'c',name:'C',provider:'',skills:Array.from({length:12},(_,i)=>`skill-${i}-long-name`)},
    {...base,id:'d',name:'D',role:'第一段\n---\n第二段：正文里的分隔线不该被当成 frontmatter 结束'},
    {...base,id:'e',name:'E',skills:['a,b','c'],tools:['read']},
  ];
  for(const profile of profiles){
    const text=renderProfile(profile);
    const parsed=parseProfile(text);
    assert.ok(parsed.profile,`${profile.id}: parses`);
    assert.equal(renderProfile(parsed.profile),text,`${profile.id}: second render is identical`);
    assert.equal(parsed.profile.role,profile.role,`${profile.id}: body is the role prompt, untouched`);
    assert.equal(parsed.profile.id,profile.id);
    assert.equal(parsed.profile.name,profile.name);
    assert.equal(parsed.profile.model,profile.model);
  }
});

test('optional fields disappear when absent instead of lingering',()=>{
  const text=renderProfile({...base,id:'x',name:'X'});
  const parsed=parseProfile(text);
  assert.equal(parsed.profile.roleKey,undefined);
  assert.equal(parsed.profile.skills,undefined);
  assert.equal(parsed.profile.readScope,undefined);
  // tools 缺省时补齐只读全集，而不是留空让代表什么都读不到。
  assert.ok(parsed.profile.tools.length>=5);
});

test('the description is the role first sentence and never becomes the role',()=>{
  assert.equal(summarizeRole('审查鉴权与依赖。仅只读。'),'审查鉴权与依赖。');
  assert.equal(summarizeRole('没有句号的一段很长的职责描述'),'没有句号的一段很长的职责描述');
  const long=summarizeRole('长'.repeat(300));
  assert.ok(long.length<=120);
  assert.ok(long.endsWith('…'));
  // description 只是索引信息，改它不该改变行为。
  const text=renderProfile(base).replace(/^description: .*$/m,'description: 完全不同的一句话');
  const parsed=parseProfile(text);
  assert.equal(parsed.profile.role,base.role);
});

test('a broken file reports why instead of vanishing',()=>{
  assert.match(parseProfile('没有 frontmatter').error,/frontmatter/);
  assert.match(parseProfile('---\nname: A\nmodel: m\n---\n职责正文').error,/缺少 id/);
  assert.match(parseProfile('---\nid: a\nmodel: m\n---\n职责').error,/缺少 name/);
  assert.match(parseProfile('---\nid: a\nname: A\n---\n职责').error,/缺少 model/);
  assert.match(parseProfile('---\nid: a\nname: A\nmodel: m\n---\n  \n').error,/正文为空/);
});

// 未知工具被丢弃：档案里写错工具名不该让代表越权。
test('tools named in a file are filtered to the read-only set',()=>{
  const text=renderProfile({...base,id:'t',name:'T',tools:['read','grep']})
    .replace(/^tools:.*$/m,'tools: [read, bash, write]');
  const parsed=parseProfile(text);
  assert.deepEqual(parsed.profile.tools,['read'],'bash and write are not read-only and get dropped');
});

test('sync writes one file per profile and leaves unchanged ones untouched',()=>{
  const dir=fresh();
  const first=syncProfiles(dir,[base,{...base,id:'b',name:'B'}]);
  assert.equal(first.written,2);
  const second=syncProfiles(dir,[base,{...base,id:'b',name:'B'}]);
  assert.equal(second.written,0,'identical content is not rewritten');
  const path=join(profilesRoot(dir),profileFileName(base));
  assert.ok(existsSync(path));
  const before=readFileSync(path,'utf8');
  // 改一个字段才写。
  syncProfiles(dir,[{...base,model:'relay/y'},{...base,id:'b',name:'B'}]);
  assert.notEqual(readFileSync(path,'utf8'),before);
  assert.match(readFileSync(path,'utf8'),/relay\/y/);
});

test('a removed representative loses its file instead of leaving an orphan',()=>{
  const dir=fresh();
  syncProfiles(dir,[base,{...base,id:'b',name:'B'}]);
  const result=syncProfiles(dir,[base]);
  assert.equal(result.removed,1);
  const files=readdirSync(profilesRoot(dir));
  assert.equal(files.length,1);
  assert.equal(files[0],profileFileName(base));
});

test('readProfiles returns good files and reports bad ones alongside',()=>{
  const dir=fresh();
  syncProfiles(dir,[base]);
  writeFileSync(join(profilesRoot(dir),'broken.md'),'not a profile');
  const read=readProfiles(dir);
  assert.equal(read.profiles.length,1);
  assert.equal(read.profiles[0].id,'a1');
  assert.equal(read.errors.length,1);
  assert.equal(read.errors[0].file,'broken.md');
  // 目录不存在时是空结果，不是异常。
  assert.deepEqual(readProfiles(join(dir,'nope')),{profiles:[],errors:[]});
});

test('file names are safe and stable, derived from the id',()=>{
  assert.equal(profileFileName({...base,id:'a1'}),'a1.md');
  // 非法字符被替换，不会产生路径穿越。
  assert.equal(profileFileName({...base,id:'../evil'}),'evil.md');
  assert.equal(profileFileName({...base,id:''}),'agent.md');
});

test('AGENTS.md states where things live and what the rules are',()=>{
  const text=renderAgentsFile({workspace:'/proj',members:[{name:'审查官',roleKey:'auditor',model:'relay/x'}],archiveDir:'.kepos'});
  assert.match(text,/本工作区如何运转/);
  assert.match(text,/审查官/);
  assert.match(text,/auditor/);
  for(const path of ['profiles/','brief.md','transcript.md','report.md','decision.md','index.json'])assert.ok(text.includes(path),`mentions ${path}`);
  // 约定必须写清只读边界与验收语义——这是接手者最容易误解的两点。
  assert.match(text,/代表只读/);
  assert.match(text,/完成不等于验收通过/);
  assert.match(text,/不互读/);
  // 不写运行命令：命令会变，约定不会。
  assert.doesNotMatch(text,/npm |node |kepos run/);
});

test('AGENTS.md is only rewritten when its content changes',()=>{
  const dir=fresh();
  const input={members:[{name:'A',model:'m'}],archiveDir:'.kepos'};
  assert.equal(syncAgentsFile(dir,input),true,'first write');
  assert.equal(syncAgentsFile(dir,input),false,'unchanged content is not rewritten');
  assert.equal(syncAgentsFile(dir,{...input,members:[{name:'B',model:'m'}]}),true);
  assert.match(readFileSync(join(dir,AGENTS_FILE),'utf8'),/B/);
});

test('an unconfigured workspace still produces a readable AGENTS.md',()=>{
  const text=renderAgentsFile({workspace:'/p',members:[],archiveDir:'.kepos'});
  assert.match(text,/尚未配置代表/);
  assert.ok(PROFILES_DIR.length>0);
});

test('sync reports a skipped directory instead of throwing',()=>{
  // 归档根是一个文件时，mkdir 会失败；导出必须降级为"跳过"而不是让配置保存失败。
  const dir=fresh();
  const blocked=join(dir,'blocked');
  writeFileSync(blocked,'not a directory');
  const result=syncProfiles(blocked,[base]);
  assert.equal(result.written,0);
  assert.equal(result.skipped.length,1);
  assert.match(result.skipped[0],/不可写/);
});
