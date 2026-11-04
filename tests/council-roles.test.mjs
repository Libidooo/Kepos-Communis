import test from 'node:test';
import assert from 'node:assert/strict';

const { COUNCIL_ROLES, councilRole, councilLocale, roleName, rolePrompt, roleOptions } = await import('../dist/terminal/council-roles.js');

test('Council catalog has stable core, academic, product, engineering, and operations roles', () => {
 assert.ok(COUNCIL_ROLES.length >= 50);
 assert.equal(new Set(COUNCIL_ROLES.map(role => role.key)).size, COUNCIL_ROLES.length);
 assert.equal(new Set(COUNCIL_ROLES.map(role => role.zhName)).size, COUNCIL_ROLES.length);
 assert.equal(new Set(COUNCIL_ROLES.map(role => role.enName)).size, COUNCIL_ROLES.length);
 assert.equal(councilRole('auditor').enName, 'Auditor');
 assert.equal(roleName(councilRole('auditor'), 'zh-CN'), '审查官');
 assert.equal(roleName(councilRole('auditor'), 'en'), 'Auditor');
});

test('Council prompts preserve evidence, Skill, and read-only boundaries in both locales', () => {
 for (const role of COUNCIL_ROLES) {
  const zh = rolePrompt(role, 'zh-CN');
  const en = rolePrompt(role, 'en');
  assert.match(zh, /Skill/);
  assert.match(zh, /不得修改文件/);
  assert.match(zh, /置信度/);
  assert.match(en, /Skill policy/);
  assert.match(en, /do not modify files/);
  assert.match(en, /confidence/);
 }
 assert.match(rolePrompt(councilRole('integrity_gatekeeper'), 'zh-CN'), /academic-pipeline/);
 assert.match(rolePrompt(councilRole('research_architect'), 'en'), /deep-research/);
});

test('Council locale defaults to Chinese and role options remain compact labels', () => {
 assert.equal(councilLocale(undefined), 'zh-CN');
 assert.equal(councilLocale('zh-CN'), 'zh-CN');
 assert.equal(councilLocale('en-US'), 'en');
 assert.equal(roleOptions('zh-CN').length, COUNCIL_ROLES.length);
 assert.equal(roleOptions('en', 'academic').length >= 10, true);
 assert.equal(roleOptions('zh-CN', 'policy').length >= 6, true);
 assert.equal(roleOptions('zh-CN', 'publication').length >= 6, true);
 assert.equal(roleOptions('zh-CN', 'code').length >= 10, true);
 assert.equal(roleOptions('en')[0].label.includes('Strategist'), true);
 assert.equal(roleOptions('en')[8].label.includes('Archivist'), true);
});

// 代理总代是推选兼任职务，不是代表角色编制：目录里不能有它，免得又被播种成一个席位。
test('deputy chair is an elected duty, not a council role seat',()=>{
 assert.equal(COUNCIL_ROLES.some(role=>role.key==='deputy_chair'),false);
 assert.equal(councilRole('deputy_chair'),undefined);
 assert.equal(COUNCIL_ROLES[0].key,'strategist');
 // 目录里没有任何角色自称治理审批（那是推选职责，不是岗位）。
 assert.equal(COUNCIL_ROLES.some(role=>/代理总代|Deputy Chair/.test(role.zhName+role.enName)),false);
});

// B1 规格要求角色提示词带开局三步与收尾纪律。这两条不随角色变化，
// 所以必须每个角色都有——漏一个就等于那个角色会凭印象继续。
test('every role prompt carries the opening and closing discipline',async()=>{
 const {COUNCIL_ROLES,rolePrompt}=await import('../dist/terminal/council-roles/index.js');
 for(const role of COUNCIL_ROLES){
  for(const locale of ['zh-CN','en']){
   const text=rolePrompt(role,locale);
   if(locale==='zh-CN'){
    assert.match(text,/开局：先读检查点/,'开局纪律缺失：'+role.key);
    assert.match(text,/一次只做一项/,'增量纪律缺失：'+role.key);
    assert.match(text,/收尾：结构化地更新检查点/,'收尾纪律缺失：'+role.key);
   }else{
    assert.match(text,/Opening: read the checkpoint/,'opening discipline missing: '+role.key);
    assert.match(text,/Do one at a time/,'one-at-a-time missing: '+role.key);
    assert.match(text,/Closing: update the checkpoint structurally/,'closing discipline missing: '+role.key);
   }
  }
 }
});
