const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'kepos-lifecycle-'));
process.env.ORBITAL_HOME = path.join(isolated, 'orbital');
const { jiti, ext, root } = require('./test-loader.cjs');
const crew = { id: 'fixture', name: 'Fixture', role: 'Local test', model: 'fixture', provider: 'fixture' };

(async () => {
 const { WorkerPool } = await jiti.import(path.join(ext, 'workers.ts'));
 const { WarmExecutor } = await jiti.import(path.join(ext, 'warm-executor.ts'));
 const { db } = await jiti.import(path.join(ext, 'database.ts'));
 const { root: stateRoot } = await jiti.import(path.join(ext, 'store.ts'));
 const children = [];
 const factory = (mode = 'normal') => profile => new WarmExecutor(profile, () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'worker-rpc-fixture.cjs')], {
   cwd: isolated, env: { ...process.env, KEPOS_FIXTURE_MODE: mode },
   stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
  });
  children.push(child);
  return child;
 });
 const pools = [];
 const makePool = (create = factory()) => { const pool = new WorkerPool(db(), create); pools.push(pool); return pool; };
 const launch = (pool, text, parent = 'parent', seconds = 5) => pool.launch(crew, text, isolated, 'source', seconds, undefined, parent, []);
 let checks = 0;
 const check = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };
 try {
  const pool = makePool();
  await check('Cancel all releases confirmed processes and permits subsequent delegation', async () => {
   const handle = launch(pool, 'WAIT');
   pool.cancelAll();
   assert.equal((await pool.wait(handle, 'parent', 5)).state, 'CANCELLED');
   assert.equal(pool.children.size, 0);
   assert.equal((await pool.run(crew, 'AFTER_CANCEL', isolated, 'source', 5, undefined, 'parent', [])).output, 'AFTER_CANCEL');
  });
  await check('Warm PID reuse resets all prior context and enforces parent/capability', async () => {
   const handle = launch(pool, 'FRESH', 'other-parent');
   const child = pool.children.get(handle.workerId);
   const receipt = await pool.wait(handle, 'other-parent', 5);
   assert.equal(receipt.output, 'FRESH_CONTEXT');
   assert.equal(pool.tasks.find(task => task.id === handle.workerId).workerReused, true);
   assert.equal(pool.status(handle, 'parent').state, 'UNKNOWN');
   assert.equal(pool.result({ ...handle, capability: 'forged' }, 'other-parent').state, 'UNKNOWN_HANDLE');
   const again = launch(pool, 'SECOND');
   assert.equal(pool.children.get(again.workerId).pid, child.pid);
   await pool.wait(again, 'parent', 5);
   const reloaded = makePool();
   assert.deepEqual(reloaded.result(handle, 'other-parent'), receipt);
  });
  await check('Terminal result publication is atomic and emits once', async () => {
   let finished = 0, publicationError;
   const unsubscribe = pool.subscribe(event => {
    if (event.type !== 'task_finished') return;
    finished++;
    try {
    const row = db().sql.prepare('SELECT state,receipt FROM workers WHERE id=?').get(event.task.id);
    assert.equal(row.state, JSON.parse(row.receipt).state);
    assert.equal(db().sql.prepare("SELECT COUNT(*) AS n FROM worker_events WHERE worker_id=? AND type='task_finished'").get(event.task.id).n, 1);
    } catch (error) { publicationError = error; }
   });
   const handle = launch(pool, 'ATOMIC');
   const receipt = await pool.wait(handle, 'parent', 5);
   pool.cancelHandle(handle, 'parent');
   if (publicationError) throw publicationError;
   assert.equal(finished, 1);
   assert.deepEqual(pool.result(handle, 'parent'), receipt);
   unsubscribe();
  });
  await check('Failed receipt transaction rolls back state, receipt and final event together', async () => {
   const handle = launch(pool, 'WAIT');
   const task = pool.tasks.find(item => item.id === handle.workerId);
   const before = db().sql.prepare('SELECT state,receipt FROM workers WHERE id=?').get(task.id);
   db().sql.exec(`CREATE TEMP TRIGGER receipt_fault BEFORE INSERT ON worker_events WHEN NEW.worker_id='${task.id}' AND NEW.type='task_finished' BEGIN SELECT RAISE(ABORT,'injected publication failure'); END;`);
   try {
    assert.throws(() => pool.settle(task, 'FAILED', 'test fault'), /injected publication/);
    assert.deepEqual(db().sql.prepare('SELECT state,receipt FROM workers WHERE id=?').get(task.id), before);
    assert.equal(task.state, before.state);
   } finally { db().sql.exec('DROP TRIGGER receipt_fault'); }
   pool.cancelHandle(handle, 'parent');
   assert.equal((await pool.wait(handle, 'parent', 5)).state, 'CANCELLED');
  });
  await check('Deadline kills process and preserves TIMED_OUT receipt', async () => {
   const handle = launch(pool, 'WAIT', 'parent', 0.1);
   assert.equal((await pool.wait(handle, 'parent', 5)).state, 'TIMED_OUT');
   assert.equal(pool.children.size, 0);
  });
  await check('Failed assistant and handled-without-run prompts settle as failures', async () => {
   for (const text of ['FAIL', 'HANDLED']) {
    const handle = launch(pool, text);
    assert.equal((await pool.wait(handle, 'parent', 5)).state, 'FAILED');
   }
  });
  await check('Output truncation is explicit and preserves Unicode code points', async () => {
   const handle = launch(pool, 'UNICODE');
   const receipt = await pool.wait(handle, 'parent', 5);
   assert.equal(receipt.state, 'SUCCEEDED');
   assert.equal(receipt.outputTruncated, true);
   assert.ok(Buffer.byteLength(receipt.output) <= 32768);
   assert.ok(!receipt.output.includes('\ufffd'));
   assert.equal(receipt.output, Buffer.from(receipt.output).toString('utf8'));
  });
  await check('A retiring idle executor cannot be reused by a new task', async () => {
   const executor = [...pool.executors].find(item => !item.busy && !item.dead && !item.stopping);
   executor.kill();
   const handle = launch(pool, 'NEW_EXECUTOR');
   assert.notEqual(pool.children.get(handle.workerId).pid, executor.child.pid);
   assert.equal((await pool.wait(handle, 'parent', 5)).state, 'SUCCEEDED');
  });
  await check('Dirty/missing context and malformed JSON fail before a task can run', async () => {
   for (const mode of ['retained-tool', 'missing-messages', 'invalid-json']) {
    const dirty = makePool(factory(mode));
    const handle = launch(dirty, 'MUST_NOT_RUN');
    const receipt = await dirty.wait(handle, 'parent', 5);
    assert.equal(receipt.state, 'FAILED', mode);
    assert.ok(!receipt.output.includes('MUST_NOT_RUN'));
    assert.match(receipt.error, /retained conversation|invalid messages|Invalid RPC/);
   }
  });
  await check('Synchronous startup failure returns a durable queryable receipt', async () => {
   const broken = makePool(() => { throw Error('fixture spawn failed'); });
   const handle = launch(broken, 'START');
   assert.equal(broken.result(handle, 'parent').state, 'FAILED');
   assert.match(broken.result(handle, 'parent').error, /spawn failed/);
   assert.equal((await broken.run(crew, 'START', isolated, 's', 5, undefined, 'parent', [])).state, 'FAILED');
  });
  await check('Ten busy slots queue an eleventh and cancel without leaking processes', async () => {
   const full = makePool();
   const handles = Array.from({ length: 10 }, () => launch(full, 'WAIT'));
   const extra = launch(full, 'EXTRA'); assert.equal(full.status(extra, 'parent').state, 'QUEUED'); full.cancelHandle(extra, 'parent'); assert.equal((await full.wait(extra, 'parent', 2)).state, 'CANCELLED');
   full.cancelAll();
   const receipts = await Promise.all(handles.map(handle => full.wait(handle, 'parent', 5)));
   assert.ok(receipts.every(receipt => receipt.state === 'CANCELLED'));
   assert.equal(full.children.size, 0);
  });
  await check('Session switch retains subscriptions; Ctrl+X cancels without closing the pool', async () => {
   const extension = await jiti.import(path.join(ext, 'index.ts'));
   const sdk = await jiti.import(path.join(root, 'dist/index.js'));
   const bound = makePool();
   const key = Symbol.for('orbital.worker-pool:' + stateRoot);
   globalThis[key] = bound;
   const handlers = {}, commands = {}, tools = {};
   extension.default({ on: (name, handler) => handlers[name] = handler, registerCommand: (name, value) => commands[name] = value, registerTool: value => tools[value.name] = value, getCommands: () => [] });
   const manager = sdk.SessionManager.create(isolated, path.join(isolated, 'sessions'));
   const ctx = { mode: 'rpc', cwd: isolated, sessionManager: manager, isIdle: () => true, ui: { notify() {} } };
   await handlers.session_start({}, ctx);
   assert.equal(bound.listeners.size, 1);
   await handlers.session_shutdown({ reason: 'switch' });
   await handlers.session_start({}, ctx);
   assert.equal(bound.listeners.size, 1);
   let aborted = 0, cancelled = 0, calls = 0;
   const cancelAll = bound.cancelAll.bind(bound);
   bound.cancelAll = () => { cancelled++; cancelAll(); };
   const listAll = sdk.SessionManager.listAll;
   sdk.SessionManager.listAll = async () => [];
   try {
    await commands.kepos.handler('', { ...ctx, mode: 'tui', abort: () => aborted++, waitForIdle: async () => {}, ui: { notify() {}, custom: async () => calls++ === 0 ? { kind: 'abort' } : undefined } });
    assert.equal(aborted, 1);
    assert.equal(cancelled, 1);
    assert.equal((await bound.prewarm(crew, isolated, [])).ready, true);
    const count = bound.tasks.length;
    await assert.rejects(tools.orbital_delegate.execute('id', { background: true, tasks: [{ name: 'first', model: 'fixture', task: 'valid' }, { name: 'second', model: 'fixture', task: '  ' }] }, undefined, undefined, ctx), /不能为空/);
    assert.equal(bound.tasks.length, count, 'Invalid batch launched its first task');
    for (const seconds of [0, 301, NaN]) {
     await assert.rejects(tools.orbital_delegate.execute('id', { background: true, tasks: [{ name: 'first', model: 'fixture', task: 'valid' }, { name: 'second', model: 'fixture', task: 'valid', seconds }] }, undefined, undefined, ctx), /期限/);
     assert.equal(bound.tasks.length, count);
    }
    const abortedSignal = AbortSignal.abort();
    await assert.rejects(tools.orbital_delegate.execute('id', { background: true, tasks: [{ name: 'first', model: 'fixture', task: 'valid' }] }, abortedSignal, undefined, ctx), /cancelled/);
    assert.equal(bound.tasks.length, count);

   } finally { sdk.SessionManager.listAll = listAll; }
   await handlers.session_shutdown({ reason: 'quit' });
   assert.equal(bound.listeners.size, 0);
   await assert.rejects(bound.prewarm(crew, isolated, []), /closed/);
  });
  console.log(checks + ' lifecycle regressions passed (local subprocesses, no model calls)');
 } finally {
  for (const pool of pools) pool.close();
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : once(child, 'close')));
 }
})().catch(error => { console.error(error); process.exitCode = 1; });
