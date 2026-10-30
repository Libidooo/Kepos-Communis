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
 assert.equal(roleOptions('en')[0].label.includes('Deputy Chair'), true);
assert.equal(roleOptions('en')[1].label.includes('Strategist'), true);
assert.equal(roleOptions('en')[9].label.includes('Archivist'), true);
});

test('deputy_chair is the first seeded council role with approval-governance duties',()=>{
 assert.equal(COUNCIL_ROLES[0].key,'deputy_chair');
 const role=councilRole('deputy_chair');
 assert.equal(role.zhName,'代理总代');
 assert.equal(role.enName,'Deputy Chair');
 const prompt=rolePrompt(role,'zh-CN');
 assert.match(prompt,/VOTE/);
 assert.match(prompt,/mcp\.json|升级给人类/);
});
