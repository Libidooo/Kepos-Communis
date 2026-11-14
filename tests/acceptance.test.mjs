import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeAcceptance, freshAcceptance, acceptanceState, unmetChecks, markPasses,
  isPrematureDone, acceptanceReviewPrompt, parseReviewVerdict, adjudicateVerifiedAcceptance,
  MIN_ACCEPTANCE, MAX_ACCEPTANCE, MAX_CHECK_CHARS,
} from '../dist/terminal/acceptance.js';

test('acceptance items are normalised, de-duplicated and start unchecked', () => {
  const items = freshAcceptance(['测试通过', '无新增依赖', '测试通过']);
  assert.equal(items.length, 2, 'duplicates collapse');
  assert.deepEqual(items.map(item => item.passes), [false, false], 'a plan declares, it does not claim');
  // 对象形式与纯字符串都接受：模型更常写后者。
  assert.deepEqual(freshAcceptance([{ check: '接口返回 200', passes: true }]), [{ check: '接口返回 200', passes: false }]);
});

test('bad acceptance input is rejected before the plan is stored', () => {
  assert.throws(() => normalizeAcceptance('不是数组'), /数组/);
  assert.throws(() => normalizeAcceptance(['']), /不能为空/);
  assert.throws(() => normalizeAcceptance(Array.from({ length: MAX_ACCEPTANCE + 1 }, (_, i) => `条目 ${i}`)), /最多/);
  assert.throws(() => normalizeAcceptance(['长'.repeat(MAX_CHECK_CHARS + 1)]), /过长/);
  assert.deepEqual(normalizeAcceptance(undefined), [], 'acceptance is optional');
  assert.ok(MIN_ACCEPTANCE >= 1);
});

test('unchecked items keep the job from counting as verified', () => {
  const half = [{ check: 'a', passes: true }, { check: 'b', passes: false }];
  assert.equal(acceptanceState(half), 'pending');
  assert.equal(acceptanceState([{ check: 'a', passes: true }]), 'complete');
  // 没写验收不等于通过——这是最容易被冒充成完成的情况。
  assert.equal(acceptanceState(undefined), 'absent');
  assert.equal(acceptanceState([]), 'absent');
  assert.deepEqual(unmetChecks(half), ['b']);
});

test('marking passes takes named items, not a blanket "all done"', () => {
  const checks = [{ check: '测试通过', passes: false }, { check: '无新增依赖', passes: false }, { check: '文档更新', passes: false }];
  // 序号（1 起）
  assert.deepEqual(markPasses(checks, [1, 2]).checks.map(item => item.passes), [true, true, false]);
  assert.equal(markPasses(checks, [1, 2]).marked, 2);
  // 原文包含匹配
  assert.deepEqual(markPasses(checks, ['无新增依赖']).checks.map(item => item.passes), [false, true, false]);
  // 空数组不勾任何东西；越界序号被忽略。
  assert.equal(markPasses(checks, []).marked, 0);
  assert.equal(markPasses(checks, [99, 0, -1]).marked, 0);
  // 已勾选的不重复计数。
  const done = [{ check: 'a', passes: true }];
  assert.equal(markPasses(done, [1]).marked, 0);
});

// 核心可度量事件：模型说完成了，验收说没有。
test('premature_done is recorded when a step succeeds with unmet checks', () => {
  assert.equal(isPrematureDone([{ check: 'x', passes: false }], true), true);
  assert.equal(isPrematureDone([{ check: 'x', passes: true }], true), false);
  assert.equal(isPrematureDone([{ check: 'x', passes: false }], false), false, 'a failure is not premature completion');
  assert.equal(isPrematureDone(undefined, true), false, 'no acceptance means nothing to compare');
});

test('the review prompt demands evidence per item and rejects self-report', () => {
  const prompt = acceptanceReviewPrompt('迁移鉴权', [{ check: '旧路径无引用', passes: false }], '我已完成迁移');
  assert.match(prompt, /旧路径无引用/);
  assert.match(prompt, /未勾选/);
  assert.match(prompt, /不是证据/, 'self-reported completion is called out');
  assert.match(prompt, /严格 JSON/);
});

test('the review verdict parses defensively', () => {
  assert.deepEqual(parseReviewVerdict('{"passed":[1,3],"unmet":["缺测试"]}'), { passed: [1, 3], unmet: ['缺测试'] });
  // 带围栏与说明文字
  const wrapped = '结果如下：\n```json\n{"passed":[2]}\n```\n完成。';
  assert.deepEqual(parseReviewVerdict(wrapped).passed, [2]);
  // 坏输入与越界序号
  assert.deepEqual(parseReviewVerdict('{not json'), { passed: [], unmet: [] });
  assert.deepEqual(parseReviewVerdict('{"passed":[0,-2,"x"]}').passed, []);
  assert.deepEqual(parseReviewVerdict(JSON.stringify({ passed: [1, 1, 2] })).passed, [1, 2], 'de-duplicated');
});

// —— verify 绑定：验收条目的机器裁决（封住"自述通过"这个同类缺口）——

test('verify accepts a named check as string or object and rejects unknown names', () => {
  const items = normalizeAcceptance([
    { check: '测试套件通过', verify: 'test' },
    { check: '类型检查干净', verify: { check: 'typecheck', cwd: 'T:/elsewhere' } },
    '纯文本条目不需要验证',
  ]);
  assert.equal(items[0].verify.project, 'test');
  assert.equal(items[1].verify.project, 'typecheck');
  assert.equal(items[1].verify.cwd, 'T:/elsewhere');
  assert.equal(items[2].verify, undefined);
  assert.throws(() => normalizeAcceptance([{ check: 'x', verify: 'deploy' }]), /只支持具名项目检查/);
  assert.throws(() => normalizeAcceptance([{ check: 'x', verify: { check: '' } }]), /verify\.check 不能为空/);
});

test('fresh acceptance keeps the verify binding while resetting passes', () => {
  const fresh = freshAcceptance([{ check: '测试套件通过', verify: 'test', passes: true }]);
  assert.equal(fresh[0].passes, false, 'creation always starts unmet');
  assert.equal(fresh[0].verify.project, 'test', 'the binding survives plan creation');
});

test('self-attestation cannot tick a verify-bound item', () => {
  const items = normalizeAcceptance([{ check: '测试套件通过', verify: 'test' }, { check: '文档已更新' }]);
  const { checks, marked } = markPasses(items, [1, 2]);
  assert.equal(marked, 1, 'only the unbound item takes attestation');
  assert.equal(checks[0].passes, false, 'the exit code is the only adjudicator for verify items');
  assert.equal(checks[1].passes, true, 'unbound items still take attestation');
});

test('adjudication runs the named check for real and sets passes from the exit code', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kepos-acceptance-verify-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(3)"' } }));
    const items = normalizeAcceptance([
      { check: '测试套件通过', verify: 'test' },
      { check: 'lint 干净', verify: 'lint' },
      { check: '构建产物齐全' },
    ]);
    const adjudicated = await adjudicateVerifiedAcceptance(items, cwd);
    assert.equal(adjudicated[0].passes, true, 'exit 0 passes the item');
    assert.equal(adjudicated[1].passes, false, 'exit 3 fails the item despite any claim');
    assert.equal(adjudicated[2].passes, false, 'unbound items keep the attestation path');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('adjudication fails closed when the project has no such script', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kepos-acceptance-missing-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }));
    const items = normalizeAcceptance([{ check: 'lint 干净', verify: 'lint' }]);
    const adjudicated = await adjudicateVerifiedAcceptance(items, cwd);
    assert.equal(adjudicated[0].passes, false);
    assert.match(adjudicated[0].verifyError, /没有 scripts\.lint/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
