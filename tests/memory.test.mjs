import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { KeposDatabase } = await import('../dist/terminal/database.js');
const {
  RepresentativeMemory, renderMemoryIndex, parseConsolidationOps, consolidationPrompt,
  MAX_MEMORIES_PER_TASK, MAX_INJECTED_LINES, MAX_MEMORY_CHARS,
} = await import('../dist/terminal/memory.js');

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'kepos-memory-'));
  return new KeposDatabase(join(dir, 'kepos.sqlite'));
}

test('ADD stores a current-valid memory', () => {
  const db = fresh();
  try {
    const mem = new RepresentativeMemory(db);
    const row = mem.add({ agentId: 'agent-1', content: '项目用 pnpm 而不是 npm', now: 1000 });
    assert.equal(row.validTo, null);
    const active = mem.active('agent-1');
    assert.equal(active.length, 1);
    assert.match(active[0].content, /pnpm/);
  } finally { db.close(); }
});

// 核心不变量：永不物理删除。
test('UPDATE retires the old row instead of deleting it', () => {
  const db = fresh();
  try {
    const mem = new RepresentativeMemory(db);
    const first = mem.add({ agentId: 'a', content: '接口在 /v1/old', now: 1000 });
    mem.update(first.id, { agentId: 'a', content: '接口已迁到 /v2/new', now: 2000 });

    const active = mem.active('a');
    assert.equal(active.length, 1, 'only one row stays current');
    assert.match(active[0].content, /v2\/new/);

    // 旧行仍在库里，只是失效了。
    const all = db.prepare('SELECT id,content,valid_to FROM representative_memories WHERE agent_id=?').all('a');
    assert.equal(all.length, 2, 'history is preserved');
    assert.ok(all.some(row => row.content.includes('/v1/old') && row.valid_to === 2000));
  } finally { db.close(); }
});

test('bi-temporal query answers what we believed at a past moment', () => {
  const db = fresh();
  try {
    const mem = new RepresentativeMemory(db);
    const first = mem.add({ agentId: 'a', content: '旧事实', now: 1000 });
    mem.update(first.id, { agentId: 'a', content: '新事实', now: 2000 });

    assert.deepEqual(mem.asOf('a', 1500).map(row => row.content), ['旧事实']);
    assert.deepEqual(mem.asOf('a', 2500).map(row => row.content), ['新事实']);
    assert.deepEqual(mem.asOf('a', 500), [], 'nothing existed before it was learned');
  } finally { db.close(); }
});

test('invalidate retires without deleting', () => {
  const db = fresh();
  try {
    const mem = new RepresentativeMemory(db);
    const row = mem.add({ agentId: 'a', content: '过时结论', now: 1000 });
    assert.equal(mem.invalidate(row.id, 2000), true);
    assert.equal(mem.active('a').length, 0);
    assert.equal(mem.invalidate(row.id, 3000), false, 'already invalidated');
    const kept = db.prepare('SELECT COUNT(*) c FROM representative_memories').get();
    assert.equal(kept.c, 1, 'row still exists');
  } finally { db.close(); }
});

test('apply honours ADD / UPDATE / NOOP and caps the batch', () => {
  const db = fresh();
  try {
    const mem = new RepresentativeMemory(db);
    const existing = mem.add({ agentId: 'a', content: '旧值', now: 100 });

    const result = mem.apply('a', [
      { op: 'ADD', content: '新的稳定事实' },
      { op: 'UPDATE', replacesId: existing.id, content: '修正后的值' },
      { op: 'NOOP', content: '' },
    ], 'worker-1', 200);
    assert.equal(result.added, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.skipped, 1);

    // 超量批次被截断到上限。
    const many = Array.from({ length: 20 }, (_, i) => ({ op: 'ADD', content: `事实 ${i}` }));
    const capped = mem.apply('a', many, 'worker-2', 300);
    assert.equal(capped.added, MAX_MEMORIES_PER_TASK);
  } finally { db.close(); }
});

// 整理管道不能改别人的记忆。
test('UPDATE pointing at another agent memory falls back to ADD', () => {
  const db = fresh();
  try {
    const mem = new RepresentativeMemory(db);
    const theirs = mem.add({ agentId: 'agent-B', content: 'B 的记忆', now: 100 });
    const result = mem.apply('agent-A', [{ op: 'UPDATE', replacesId: theirs.id, content: '想覆盖 B' }], 'w', 200);
    assert.equal(result.added, 1, 'treated as new entry for A');
    assert.equal(result.updated, 0);
    // B 的记忆完全没被动。
    assert.equal(mem.active('agent-B').length, 1);
    assert.match(mem.active('agent-B')[0].content, /B 的记忆/);
  } finally { db.close(); }
});

test('consolidation is locked per worker so it never runs twice', () => {
  const db = fresh();
  try {
    const mem = new RepresentativeMemory(db);
    assert.equal(mem.consolidated('w1'), false);
    mem.markConsolidated('w1', 1000);
    assert.equal(mem.consolidated('w1'), true);
    // 重复标记不报错也不重复计数。
    mem.markConsolidated('w1', 2000);
    assert.equal(mem.consolidated('w1'), true);
  } finally { db.close(); }
});

test('the injected index is capped and states it is only reference', () => {
  const db = fresh();
  try {
    const mem = new RepresentativeMemory(db);
    for (let i = 0; i < 80; i++) mem.add({ agentId: 'a', content: `事实 ${i}`, now: 1000 + i });
    const index = renderMemoryIndex(mem.active('a', 80));
    const lines = index.split('\n');
    assert.ok(lines.length <= MAX_INJECTED_LINES, `stays within ${MAX_INJECTED_LINES} lines, got ${lines.length}`);
    assert.match(index, /仅供参考/);
    assert.match(index, /与本任务的实际证据冲突时，以本任务为准/);
  } finally { db.close(); }
});

test('an empty memory set injects nothing at all', () => {
  assert.equal(renderMemoryIndex([]), '');
});

test('consolidation JSON is parsed defensively', () => {
  // 带说明文字与代码围栏也能取出数组。
  const wrapped = '这是结果：\n```json\n[{"op":"ADD","content":"事实"}]\n```\n完成。';
  assert.deepEqual(parseConsolidationOps(wrapped), [{ op: 'ADD', content: '事实' }]);

  // 坏 JSON 返回空数组而不是抛出。
  assert.deepEqual(parseConsolidationOps('{not json'), []);
  // 未知 op 被丢弃。
  assert.deepEqual(parseConsolidationOps('[{"op":"DELETE","content":"x"}]'), []);
  // 空内容被丢弃（NOOP 除外）。
  assert.deepEqual(parseConsolidationOps('[{"op":"ADD","content":"  "}]'), []);
  // 截断到上限。
  const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ op: 'ADD', content: `f${i}` })));
  assert.equal(parseConsolidationOps(many).length, MAX_MEMORIES_PER_TASK);
});

test('the consolidation prompt asks for strict JSON and limits size', () => {
  const prompt = consolidationPrompt({ goal: '检查鉴权', outputTail: '发现两处', memories: [] });
  assert.match(prompt, /严格 JSON/);
  assert.match(prompt, /NOOP/);
  assert.match(prompt, new RegExp(String(MAX_MEMORY_CHARS)));
  assert.match(prompt, /（暂无）/);
});

test('a failed task is asked for a delegation lesson instead of conclusions', () => {
  const prompt = consolidationPrompt({ goal: '检查鉴权', outputTail: '超时', memories: [], failed: true });
  assert.match(prompt, /优先记录"哪个环节出错/);
});

test('procedure counts distinguish worker sources for the skill loop', () => {
  const db = fresh();
  try {
    const mem = new RepresentativeMemory(db);
    mem.add({ agentId: 'a', kind: 'procedure', content: '步骤 slug=fetch-build-log', sourceWorkerId: 'w1', now: 100 });
    mem.add({ agentId: 'a', kind: 'procedure', content: '步骤 slug=fetch-build-log', sourceWorkerId: 'w2', now: 200 });
    mem.add({ agentId: 'a', kind: 'procedure', content: '步骤 slug=fetch-build-log', sourceWorkerId: 'w2', now: 300 });
    assert.equal(mem.procedureCount('a', 'fetch-build-log'), 2, 'distinct workers, not rows');
    assert.equal(mem.procedureCount('a', 'other'), 0);
  } finally { db.close(); }
});

// 回归：内部任务（记忆整理/配置生成）绝不能再触发整理。
// 曾经的套娃链：整理任务失败 → 它自己也进整理队列 → 新提示词嵌着旧提示词 → 无限循环烧钱。
test('internal tasks never feed the consolidation pipeline', async () => {
  const { shouldConsolidate, candidateFromTask, ConsolidationPipeline } = await import('../dist/terminal/memory-pipeline.js');
  const done = () => false;
  assert.equal(shouldConsolidate({ id: 't1', agentId: 'a1', output: 'x', purpose: 'configuration' }, done), false, 'configuration purpose is refused');
  assert.equal(candidateFromTask({ id: 't1', agentId: 'a1', title: '你是记忆整理器…', output: 'x', status: '失败', purpose: 'configuration' }), null, 'candidateFromTask refuses internal tasks');
  assert.equal(shouldConsolidate({ id: 't2', agentId: 'a1', output: 'x' }, done), true, 'normal delegate tasks still consolidate');

  // 长标题截断：标题截自任务全文，不设限会把整段提示词带进下一轮。
  const long = candidateFromTask({ id: 't3', agentId: 'a1', title: '长'.repeat(5000), output: 'x' });
  assert.ok(long && long.goal.length <= 200, 'goal is capped at 200 chars');

  // 熔断：模型连败三次清空队列，不再无限重试。
  const { KeposDatabase } = await import('../dist/terminal/database.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const db = new KeposDatabase(join(mkdtempSync(join(tmpdir(), 'kepos-mem-')), 'k.sqlite'));
  try {
    const notices = [];
    const pipeline = new ConsolidationPipeline(db, async () => { throw Error('relay down'); }, m => notices.push(m));
    for (let i = 0; i < 5; i++) pipeline.enqueue({ workerId: 'w' + i, agentId: 'a1', goal: 'g', output: 'o', failed: false });
    await pipeline.drain();
    assert.ok(notices.some(text => text.includes('连续失败 3 次')), 'circuit breaker fires with a notice');
    assert.equal(pipeline.pending(), 0, 'queue is dropped after three consecutive failures');
  } finally { db.close(); }
});
