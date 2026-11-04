import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, readFileSync, writeFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// 配置保存是核心路径：档案导出接在它后面，绝不能改变它的并发合并语义。
// 这里用独立的 home 与工作目录，不碰真实配置。
const home=mkdtempSync(join(tmpdir(),'kepos-c1-home-'));
const workspace=mkdtempSync(join(tmpdir(),'kepos-c1-work-'));
process.env.ORBITAL_HOME=join(home,'orbital');
process.chdir(workspace);

const {loadConfig, saveConfig, importProfiles, exportWorkspaceFiles}=await import('../dist/terminal/store.js');
const {profilesRoot, AGENTS_FILE, PROFILES_DIR}=await import('../dist/terminal/profile-file.js');
const {readdirSync,unlinkSync}=await import('node:fs');
/** 清掉用例自己造的非常规档案，避免彼此串味。 */
const clearOdd=()=>{const dir=profilesRoot(join(workspace,'.kepos'));if(!existsSync(dir))return;for(const f of readdirSync(dir))if(f==='ghost.md'||f==='broken.md')unlinkSync(join(dir,f));};

const crew=(id,name,extra={})=>({id,name,model:'relay/x',provider:'relay',role:`${name}的职责。只读。`,...extra});

test('saving config exports a profile file per representative',()=>{
  const config=loadConfig();
  config.agents=[crew('a1','审查官'),crew('a2','研究员')];
  saveConfig(config); exportWorkspaceFiles(config,workspace);
  const dir=profilesRoot(join(workspace,'.kepos'));
  assert.ok(existsSync(join(dir,'a1.md')),'one file per stable id');
  assert.ok(existsSync(join(dir,'a2.md')));
  const text=readFileSync(join(dir,'a1.md'),'utf8');
  assert.match(text,/^---\nid: a1\nname: 审查官/);
  assert.match(text,/审查官的职责/,'the body is the role prompt');
});

test('the workspace root gains an AGENTS.md describing how it runs',()=>{
  const file=join(workspace,AGENTS_FILE);
  assert.ok(existsSync(file),'written on the same save');
  const text=readFileSync(file,'utf8');
  assert.match(text,/审查官/);
  assert.ok(text.includes(PROFILES_DIR));
});

test('export does not disturb the concurrent merge in saveConfig',()=>{
  // 两个实例各自改不同的代表：合并语义必须与导出前完全一致。
  const mine=loadConfig();
  mine.agents=[crew('a1','审查官'),crew('a2','研究员'),crew('a3','书记官')];
  saveConfig(mine);
  const theirs=loadConfig();
  const theirsView={...theirs,agents:theirs.agents.map(agent=>agent.id==='a3'?{...agent,name:'新书记官'}:agent)};
  saveConfig(theirsView);
  const final=loadConfig();
  assert.equal(final.agents.length,3,'no member lost');
  assert.equal(final.agents.find(agent=>agent.id==='a3').name,'新书记官','the other session wins its own edit');
  assert.equal(final.agents.find(agent=>agent.id==='a1').name,'审查官','untouched members survive');
});

test('a representative removed from config loses its file on the next save',()=>{
  const config=loadConfig();
  config.agents=config.agents.filter(agent=>agent.id!=='a2');
  saveConfig(config); exportWorkspaceFiles(config,workspace);
  const dir=profilesRoot(join(workspace,'.kepos'));
  assert.equal(existsSync(join(dir,'a2.md')),false,'no orphan file for a deleted member');
  assert.ok(existsSync(join(dir,'a1.md')),'the rest stay');
});

test('a hand-edited profile imports back, and only for known ids',()=>{
  clearOdd();
  // 显式重设前置：前一个用例改过 a3 的名字，用例之间不该继承彼此的副作用。
  const setup=loadConfig();
  setup.agents=[crew('a1','审查官'),crew('a2','研究员'),crew('a3','书记官')];
  saveConfig(setup); exportWorkspaceFiles(setup,workspace);
  const dir=profilesRoot(join(workspace,'.kepos'));
  // 人改：把 a1 的模型与职责换掉。
  const text=readFileSync(join(dir,'a1.md'),'utf8').replace(/^model: .*$/m,'model: relay/y').replace(/审查官的职责。只读。/,'新的职责：只做合规审查。');
  writeFileSync(join(dir,'a1.md'),text,'utf8');
  // 再造一个不存在的 id：不应自动新建代表。
  writeFileSync(join(dir,'ghost.md'),'---\nid: ghost\nname: 幽灵\nmodel: m\n---\n职责\n','utf8');

  const config=loadConfig();
  const report=importProfiles(config,workspace);
  // 导出即一致，所以三份档案都会被读回写回；真正要断言的是内容确实来自文件、
  // 且幽灵 id 没有被建成代表。
  assert.ok(report.updated.includes('审查官'));
  assert.deepEqual(report.unknown,['ghost'],'unknown ids are reported, not created');
  assert.equal(config.agents.length,3,'no member invented by a file');
  const imported=config.agents.find(agent=>agent.id==='a1');
  assert.equal(imported.model,'relay/y');
  assert.match(imported.role,/合规审查/);
});

test('importing a file that omits optional fields clears them, not merges them',()=>{
  clearOdd();
  const dir=profilesRoot(join(workspace,'.kepos'));
  // 先给 a1 加上可选字段并保存，让它真的存在。
  let config=loadConfig();
  config.agents=config.agents.map(agent=>agent.id==='a1'?{...agent,skills:['academic-paper'],roleKey:'auditor'}:agent);
  saveConfig(config); exportWorkspaceFiles(config,workspace);
  assert.match(readFileSync(join(dir,'a1.md'),'utf8'),/academic-paper/);
  // 人把 skills 与 roleKey 整行删掉。
  const stripped=readFileSync(join(dir,'a1.md'),'utf8').split('\n').filter(line=>!/^(skills|roleKey):/.test(line)).join('\n');
  writeFileSync(join(dir,'a1.md'),stripped,'utf8');
  config=loadConfig();
  importProfiles(config,workspace);
  const after=config.agents.find(agent=>agent.id==='a1');
  assert.equal(after.skills,undefined,'a removed line means removed, not retained');
  assert.equal(after.roleKey,undefined);
});

test('a broken profile blocks nothing but is reported',()=>{
  clearOdd();
  const dir=profilesRoot(join(workspace,'.kepos'));
  writeFileSync(join(dir,'broken.md'),'not a profile at all','utf8');
  const config=loadConfig();
  const report=importProfiles(config,workspace);
  assert.equal(report.errors.length,1);
  assert.match(report.errors[0].error,/frontmatter/);
  // 好档案照常导入。
  assert.ok(report.updated.length>=1);
});

test('duplicate names are rejected before anything is written',()=>{
  clearOdd();
  // 自带前置：三个互不重名的代表，再让其中一个与另一个同名。
  const setup=loadConfig();
  setup.agents=[crew('a1','审查官'),crew('a2','研究员'),crew('a3','书记官')];
  saveConfig(setup); exportWorkspaceFiles(setup,workspace);
  const dir=profilesRoot(join(workspace,'.kepos'));
  const text=readFileSync(join(dir,'a1.md'),'utf8').replace(/^name: .*$/m,'name: 书记官');
  writeFileSync(join(dir,'a1.md'),text,'utf8');
  const before=loadConfig();
  assert.throws(()=>importProfiles(before,workspace),/重名/);
  // 拒绝之后配置必须原封不动。
  const after=loadConfig();
  assert.deepEqual(after.agents.map(agent=>agent.name),before.agents.map(agent=>agent.name));
});

test('an unconfigured workspace does not scatter .kepos directories',()=>{
  const clean=mkdtempSync(join(tmpdir(),'kepos-c1-empty-'));
  process.chdir(clean);
  const config=loadConfig();
  config.agents=[];
  saveConfig(config); exportWorkspaceFiles(config,workspace);
  // 没有代表、也没有既有归档区时，不建档案目录；但 AGENTS.md 仍然写出来说明本工作区。
  assert.equal(existsSync(join(clean,'.kepos',PROFILES_DIR)),false);
});

test.after(()=>{process.chdir(home);});

// 回归：草稿自动保存每 250ms 调一次 saveConfig。档案导出挂在这条热路径上
// 会导致每敲一个字就重扫并重写磁盘——这是实测踩到的。
test('saving a draft does not touch profile files',()=>{
  const setup=loadConfig();
  setup.agents=[crew('a1','审查官')];
  saveConfig(setup); exportWorkspaceFiles(setup,workspace);
  const dir=profilesRoot(join(workspace,'.kepos'));
  const file=join(dir,'a1.md');
  const before=readFileSync(file,'utf8');
  const mtime=statSync(file).mtimeMs;
  // 模拟打字：只改草稿，代表不动。
  for(let n=0;n<5;n++){
    const current=loadConfig();
    current.drafts['draft:test']='打'.repeat(n+1);
    saveConfig(current);
  }
  assert.equal(readFileSync(file,'utf8'),before,'profile content untouched');
  const after=statSync(file).mtimeMs;
  assert.equal(after,mtime,'the file is not even rewritten');
});

// 回归：曾经遍历 config.projects 往每个项目根写 AGENTS.md，
// 于是测试夹具把假代表写进了真实仓库。档案只属于当前工作区。
test('export never writes into other projects',()=>{
  const other=mkdtempSync(join(tmpdir(),'kepos-c1-other-'));
  const setup=loadConfig();
  setup.projects=[other];
  setup.agents=[crew('a1','审查官')];
  saveConfig(setup); exportWorkspaceFiles(setup,workspace);
  assert.equal(existsSync(join(other,AGENTS_FILE)),false,'no AGENTS.md in an unrelated project');
  assert.equal(existsSync(join(other,'.kepos',PROFILES_DIR)),false,'no profiles directory either');
});

// 这次污染的根因：saveConfig 会去写 process.cwd() 下的文件。
// 任何调用 saveConfig 的测试或子进程都可能写错地方。导出现在必须显式给目录。
test('saveConfig itself never touches the filesystem',()=>{
  const clean=mkdtempSync(join(tmpdir(),'kepos-c1-pure-'));
  process.chdir(clean);
  const config=loadConfig();
  config.agents=[crew('a1','审查官')];
  saveConfig(config);
  // 保存只写数据库；这个目录里不该出现任何文件。
  assert.equal(existsSync(join(clean,AGENTS_FILE)),false,'save does not write AGENTS.md');
  assert.equal(existsSync(join(clean,'.kepos')),false,'save does not create .kepos');
  // 由调用方显式导出，才产生文件。
  exportWorkspaceFiles(config,clean);
  assert.equal(existsSync(join(clean,AGENTS_FILE)),true,'the explicit call does write it');
});
