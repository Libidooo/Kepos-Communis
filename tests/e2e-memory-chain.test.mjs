// 端到端验证：用假执行器走完"派发 → 结算 → 整理 → 记忆落库 → 再派发时注入"整条链路。
//
// 这不是单测：它不直接调用 memory.apply，而是像生产代码那样从 worker 事件出发，
// 只把最外层的模型调用换成桩（真实模型需要网络，这里不可达）。
// 目的是证明链路真的连得上，而不是各段各自能跑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'kepos-e2e-'));
process.env.ORBITAL_HOME = join(home, 'orbital');

const {KeposDatabase} = await import('../dist/terminal/database.js');
const {WorkerPool} = await import('../dist/terminal/workers.js');
const {ConsolidationPipeline, candidateFromTask} = await import('../dist/terminal/memory-pipeline.js');
const {renderMemoryIndex} = await import('../dist/terminal/memory.js');

const turn = () => new Promise(resolve => setImmediate(resolve));
const crew = {id: 'agent-1', name: '审查官', role: 'audit', model: 'fixture', provider: 'fixture'};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kepos-e2e-db-'));
  const database = new KeposDatabase(join(dir, 'k.sqlite'));
  const executors = [];
  const create = profile => {
    const child = new EventEmitter();
    child.pid = 100 + executors.length;
    const e = {
      child, key: JSON.stringify(profile), profile, busy: false, dead: false, stopping: false, uses: 0,
      reserve() { this.busy = true; },
      release() { this.busy = false; this.onEvent = undefined; this.onExit = undefined; },
      async ready() {}, async reset() { this.uses++; },
      async request() { return {disposition: 'started'}; },
      kill() { if (this.dead) return; this.stopping = true; queueMicrotask(() => { this.dead = true; child.emit('close', 0); this.onExit?.(Error('closed')); }); },
      succeed(text) { this.onEvent?.({type: 'agent_start'}); this.onEvent?.({type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text}], stopReason: 'stop'}}); this.onEvent?.({type: 'agent_settled'}); },
    };
    executors.push(e);
    return e;
  };
  const pool = new WorkerPool(database, create, {concurrency: 2});
  return {dir, database, pool, executors};
}

// 整条链路：派发 → 结算 → 候选 → 整理 → 记忆 → 注入。
test('a finished task turns into memory that the next dispatch actually carries', async () => {
  const f = fixture();
  const prompts = [];
  // 只替换最外层模型调用：它模拟"整理器返回 ADD"。
  const pipeline = new ConsolidationPipeline(f.database, async prompt => {
    prompts.push(prompt);
    return JSON.stringify([
      {op: 'ADD', content: '该项目的鉴权走 OAuth，不要找 session 表'},
      {op: 'ADD', kind: 'procedure', content: 'slug=fetch-auth-config 步骤：1) 读 config/auth.ts 2) 核对 issuer'},
    ]);
  });

  try {
    // ① 第一次派发：此时该代表没有任何记忆，所以不该注入。
    const first = f.pool.launch(crew, '审查鉴权实现', f.dir, 'session', 30, undefined, 'parent');
    await turn();
    const firstTask = f.pool.tasks.find(t => t.id === first.workerId);
    assert.equal(firstTask.agentId, 'agent-1', 'the task must carry a stable agent id, or memory has nowhere to go');
    f.executors[0].succeed('## 结论\n鉴权走 OAuth。\n## 证据\nconfig/auth.ts:12');
    await turn(); await turn();

    // ② 结算后：生产代码会在 task_finished 里构造候选项并入队。
    const settled = f.pool.tasks.find(t => t.id === first.workerId);
    assert.equal(settled.ended > 0, true, 'the task really reached a terminal state');
    const candidate = candidateFromTask(settled);
    assert.ok(candidate, 'a finished task with an agent id produces a consolidation candidate');
    assert.equal(pipeline.enqueue(candidate), true, 'the candidate enters the queue');

    // ③ 整理：这是真实链路里会被调用的那一段。
    const drained = await pipeline.drain();
    assert.equal(drained.processed, 1, 'one task was consolidated');
    assert.equal(prompts.length, 1, 'the model was actually asked');
    assert.match(prompts[0], /审查鉴权实现/, 'the prompt carries the task goal');

    // ④ 记忆真的落库了。
    const memories = pipeline.list('agent-1');
    assert.equal(memories.length, 2, 'both facts were stored');
    assert.ok(memories.some(m => /OAuth/.test(m.content)));
    assert.ok(memories.some(m => m.kind === 'procedure'), 'a slugged procedure is stored as a procedure');
    assert.equal(memories.every(m => m.sourceWorkerId === first.workerId), true, 'each memory points back to its task');

    // ⑤ 下次派发的注入文本里能读到它们。
    const index = renderMemoryIndex(pipeline.list('agent-1'));
    assert.match(index, /OAuth/, 'the next dispatch would carry this fact');
    assert.match(index, /过程/, 'procedure memories are labelled');
    assert.match(index, /仅供参考/, 'and it still says the memory yields to this task');

    // ⑥ 同一个任务不会整理第二次。
    assert.equal(pipeline.enqueue(candidate), false, 'the same task is not consolidated again');
  } finally {
    f.pool.close();
    f.database.close();
  }
});

// 失败任务也要产生复盘：这是 B3 的要求，此前因为"空产出就跳过"而从未发生。
test('a failed task with only an error still produces a retrospective note', async () => {
  const f = fixture();
  const prompts = [];
  const pipeline = new ConsolidationPipeline(f.database, async prompt => {
    prompts.push(prompt);
    return JSON.stringify([{op: 'ADD', content: '带凭据的任务要先确认环境变量存在，否则必然 401'}]);
  });
  try {
    const handle = f.pool.launch(crew, '审查私有仓库', f.dir, 'session', 30, undefined, 'parent');
    await turn();
    // 让任务失败：执行器直接报错退出。
    f.executors[0].onExit?.(Error('认证失败：401'));
    await turn(); await turn();
    const task = f.pool.tasks.find(t => t.id === handle.workerId);
    assert.equal(task.status, '失败');
    const candidate = candidateFromTask(task);
    assert.ok(candidate, 'a failure is still worth reviewing');
    assert.equal(candidate.failed, true);
    assert.match(candidate.error, /401/, 'the error travels into the candidate');
    pipeline.enqueue(candidate);
    await pipeline.drain();
    assert.match(prompts[0], /失败原因/, 'the consolidator is asked about the failure');
    assert.equal(pipeline.list('agent-1').length, 1);
  } finally {
    f.pool.close();
    f.database.close();
  }
});

// 注入标记：度量"注入过记忆的任务是否更容易成功"必须能分辨两组。
test('dispatch records whether memory was injected', async () => {
  const f = fixture();
  try {
    f.pool.launch(crew, '带记忆', f.dir, 'session', 30, undefined, 'parent', [], [], false, 0, undefined, undefined, {memoryInjected: true});
    f.pool.launch(crew, '不带记忆', f.dir, 'session', 30, undefined, 'parent', [], [], false, 0, undefined, undefined, {});
    await turn();
    const rows = f.database.prepare("SELECT worker_id FROM worker_events WHERE type='memory_injected'").all();
    assert.equal(rows.length, 1, 'exactly the injected dispatch carries the marker');
    const marked = f.pool.tasks.find(t => t.id === rows[0].worker_id);
    assert.equal(marked.title, '带记忆');
  } finally {
    f.pool.close();
    f.database.close();
  }
});
