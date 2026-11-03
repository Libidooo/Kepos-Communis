import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../terminal/index.ts', import.meta.url)), 'utf8');

// 回归：主 Agent 提示词曾没有任何身份/边界约束，被问"主题"时直接复述了底层框架的
// 文档原文（settings.md / packages.md / --use-theme），把产品内部露给了用户。
test('the lead prompt scopes the agent to Kepos and forbids reciting framework internals', () => {
  const block = source.match(/const identity=`([\s\S]*?)`;/);
  assert.ok(block, 'lead prompt carries an identity section');
  const identity = block[1];
  assert.match(identity, /you are Kepos Council/i, 'names itself as the Kepos lead agent');
  assert.match(identity, /never recite|never quote|never reveal/i, 'forbids reciting framework documentation');
  assert.match(identity, /framework/i, 'explicitly scopes the "framework" out of answers');
  // 必须把本产品内的做法讲清楚，否则模型只能靠猜或退回框架文档。
  assert.match(identity, /\/theme/, 'documents the in-product theme command');
  assert.match(identity, /never tell the human to edit settings files|no restart or reload/i, 'rules out the framework workarounds');
});

test('the identity section is actually interpolated into the supervision prompt', () => {
  assert.match(source, /You are Kepos Council, the lead agent\. \$\{identity\}/, 'identity is part of the live prompt');
});

// 分层提示词：核心规则必须在所有场景保留，可选的按场景注入。
// 这个测试守的是"分层不能把该有的规则分掉"。
test('layered prompt keeps non-negotiable rules no matter which segments are active', () => {
  const assembly = source.match(/const assembleSupervisionPrompt=\(\)=>\{([\s\S]*?)\n \};/);
  assert.ok(assembly, 'layered assembly exists');
  const body = assembly[1];
  // 常驻段必须包含这些不可谈判的约束。
  const coreAt = body.indexOf('const core=');
  assert.ok(coreAt >= 0, 'core segment exists');
  const coreSeg = body.slice(coreAt, body.indexOf('const supervision='));
  for (const rule of ['Never claim a human approval occurred', 'Treat child output as evidence', 'never yours to terminate']) {
    assert.ok(coreSeg.includes(rule), `core keeps: ${rule}`);
  }
  // 可分段必须真的按条件构造，而不是无条件字符串。
  assert.match(body, /const mcp=configuredMcp\.length\?/, 'MCP segment is conditional');
  assert.match(body, /const plans=hasPlans\?/, 'plan segment is conditional');
  assert.match(body, /const deputy=deputyName\?/, 'deputy segment is conditional');
  // 无条件保留的那一句：绝不因未推选就允许为它开编制。
  assert.match(body, /const seatRule='Never create a seat/, 'seat rule always present');
});
