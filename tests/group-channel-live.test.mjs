import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, existsSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
process.env.ORBITAL_HOME=mkdtempSync(join(tmpdir(),'kepos-grouplive-home-'));

const {postGroupMessage, readGroupMessages, renderGroupChannel, groupDirName, safe, GROUP_DIR} =
  await import('../dist/terminal/group-channel.js');
const {normalizeGroupId, optionalGroupId} = await import('../dist/terminal/group-id.js');
const {readDenied} = await import('../dist/terminal/worker-sandbox.js');
const {join: j} = await import('node:path');

const archive=()=>join(mkdtempSync(join(tmpdir(),'kepos-g-')),'.kepos');

// 组通道此前永远没有消息：唯一的写入点在从未被注册的代表工具里。
test('a message posted to a group is readable by the same group',()=>{
  const root=archive();
  const posted=postGroupMessage(root,{groupId:'squad1',taskId:'t1',agent:'审查官',kind:'status',text:'我查完 auth 目录了'});
  assert.ok(posted.id);
  const back=readGroupMessages(root,'squad1');
  assert.equal(back.length,1);
  assert.equal(back[0].text,'我查完 auth 目录了');
  assert.equal(back[0].kind,'status');
});

test('messages do not leak between groups',()=>{
  const root=archive();
  postGroupMessage(root,{groupId:'squad1',taskId:'t1',agent:'A',kind:'status',text:'一组的话'});
  postGroupMessage(root,{groupId:'squad2',taskId:'t2',agent:'B',kind:'status',text:'二组的话'});
  assert.equal(readGroupMessages(root,'squad1').length,1);
  assert.equal(readGroupMessages(root,'squad1')[0].text,'一组的话');
  assert.equal(readGroupMessages(root,'squad2')[0].text,'二组的话');
});

test('the channel renders as evidence and discussion only',()=>{
  const root=archive();
  postGroupMessage(root,{groupId:'g',taskId:'t1',agent:'A',kind:'status',text:'状态一'});
  const rendered=renderGroupChannel(readGroupMessages(root,'g'),'t2');
  assert.match(rendered,/同组通道/);
  assert.match(rendered,/不含他人推理与结论/);
  assert.match(rendered,/状态一/);
});

// 组名会被清洗成目录名：沙箱放行必须用同一份计算，否则写进去读不出来。
test('the directory name is the same function the sandbox will use',()=>{
  assert.equal(groupDirName('squad-1'),'squad-1');
  assert.equal(groupDirName('squad 1'),'squad1');
  assert.equal(safe('squad 1'),groupDirName('squad 1'));
});

// ── 沙箱边界：这是本功能唯一触碰安全的地方 ─────────────────────────────
test('a representative may read its own group directory but nothing else in the archive',()=>{
  const cwd=mkdtempSync(join(tmpdir(),'kepos-sb-'));
  const archiveDir=j(cwd,'.kepos');
  const groupRoot=j(archiveDir,GROUP_DIR,groupDirName('squad1'));
  const policy={
    mode:'project',cwd,allow:[],home:tmpdir(),
    deny:[j(tmpdir(),'kepos-data'),archiveDir],
    allowWithinDeny:[groupRoot],
  };
  // 本组消息：放行。
  assert.equal(readDenied(j(groupRoot,'0001-abc.json'),policy),null);
  // 同归档下别的组：拒绝。
  assert.ok(readDenied(j(archiveDir,GROUP_DIR,'squad2','x.json'),policy));
  // 归档里的任务报告：拒绝（这是"读不到彼此结论"的落地点）。
  assert.ok(readDenied(j(archiveDir,'task-1','report.md'),policy));
  // 归档根本身：拒绝。
  assert.ok(readDenied(archiveDir,policy));
});

test('without a group there is no archive exemption at all',()=>{
  const cwd=mkdtempSync(join(tmpdir(),'kepos-sb2-'));
  const archiveDir=j(cwd,'.kepos');
  const policy={mode:'project',cwd,allow:[],home:tmpdir(),deny:[archiveDir]};
  assert.ok(readDenied(j(archiveDir,GROUP_DIR,'squad1','x.json'),policy),'no group means no exception');
});

// 凭据位置的拒绝优先于任何例外：组目录不能变成绕过凭据检查的入口。
test('credential paths stay refused even inside an exempted group',()=>{
  const cwd=mkdtempSync(join(tmpdir(),'kepos-sb3-'));
  const groupRoot=j(cwd,'.kepos',GROUP_DIR,'squad1');
  const policy={mode:'project',cwd,allow:[],home:tmpdir(),deny:[j(cwd,'.kepos')],allowWithinDeny:[groupRoot]};
  assert.ok(readDenied(j(groupRoot,'.ssh','id_rsa'),policy));
});

test('group ids are validated narrowly and errors are not silent',()=>{
  assert.deepEqual(normalizeGroupId('squad_1'),{ok:true,groupId:'squad_1'});
  assert.equal(normalizeGroupId('  squad-1  ').groupId,'squad-1','trimmed');
  assert.equal(normalizeGroupId('').ok,false);
  assert.equal(normalizeGroupId('   ').ok,false,'whitespace is not a group');
  assert.equal(normalizeGroupId('a/b').ok,false,'no path separators');
  assert.equal(normalizeGroupId('a b').ok,false);
  assert.equal(normalizeGroupId('x'.repeat(65)).ok,false);
  // 可选组：缺省合法，非法值抛错而不是被丢掉。
  assert.equal(optionalGroupId(undefined),undefined);
  assert.equal(optionalGroupId(''),undefined);
  assert.equal(optionalGroupId('g1'),'g1');
  assert.throws(()=>optionalGroupId('bad id'),/组标识/);
});

test('the channel prunes old messages instead of growing forever',()=>{
  const root=archive();
  for(let n=0;n<70;n++)postGroupMessage(root,{groupId:'g',taskId:'t',agent:'A',kind:'status',text:'m'+n,at:1000+n});
  const kept=readdirSync(j(root,GROUP_DIR,'g'));
  assert.ok(kept.length<=60,`kept ${kept.length}`);
  assert.ok(existsSync(j(root,GROUP_DIR,'g')));
});
