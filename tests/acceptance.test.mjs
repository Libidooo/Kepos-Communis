import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAcceptance, freshAcceptance, acceptanceState, unmetChecks, markPasses,
  isPrematureDone, acceptanceReviewPrompt, parseReviewVerdict,
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
