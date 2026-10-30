import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { root, type Crew } from './store.ts';
import { db, type OrbitalDatabase } from './database.ts';
import { readWorkerEvents } from './events.ts';
import { WarmExecutor, killTree, type WorkerProfile, type WorkerExecutor } from './warm-executor.ts';
export { killTree };
import {DEFAULT_TASK_SECONDS,MAX_CONCURRENT_CHILDREN,MAX_TASK_SECONDS,MAX_OUTPUT_BYTES,READ_ONLY_TOOLS,SUPERVISION_INTERVAL_SECONDS,profileRevision,type WorkerState,type WorkerHandle,type AgentProfileSnapshot} from './worker-contract.ts';
export * from './worker-contract.ts';
export type Task = { id: string; agent: string; role?: string; title: string; cwd: string; session: string; parentSessionId: string; correlationId: string; status: string; state: WorkerState; started: number; dispatchedAt?: number; queueWaitMs?: number; checkpoint?: string; checkpointAt?: number; reviewAt?: number; reviewCount?: number; reviewDue?: boolean; delegationDepth?: number; parentWorkerId?: string; ended?: number; tool?: string; output: string; profileSnapshot?: AgentProfileSnapshot; profileRevision?: string; outputTruncated?: boolean; error?: string; limit: number; model: string; provider: string; usage?: any; ownerPid: number; ownerEpoch: string; tools: string[]; skills: string[]; mcp: boolean; firstTextMs?: number; workerReused?: boolean };
export type Receipt = { version: 1; workerId: string; parentSessionId: string; correlationId: string; state: WorkerState; started: number; ended: number; output: string; profileSnapshot?: AgentProfileSnapshot; profileRevision?: string; outputTruncated?: boolean; error?: string; resultHash: string; usage?: any };
export const terminalStates = new Set(['完成', '失败', '已取消', '超时', '已中断']);
const labels: Record<WorkerState, string> = { QUEUED: '排队中', STARTING: '启动中', RUNNING: '运行中', SUCCEEDED: '完成', FAILED: '失败', INTERRUPTED: '已中断', CANCEL_REQUESTED: '正在终止', CANCELLED: '已取消', TIMED_OUT: '超时' };
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
// Retain a UTF-8 tail without splitting a code point.
const bounded = (text: string, max = 32768) => {
 const bytes = Buffer.from(text);
 if (bytes.length <= max) return text;
 let start = bytes.length - max;
 while ((bytes[start] & 0xc0) === 0x80) start++;
 return bytes.subarray(start).toString('utf8');
};
export function mergeUsage(a: any, b: any) {
 if (!b) return a;
 const result: any = { cost: {} };
 for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) result[key] = (a?.[key] || 0) + (b[key] || 0);
 for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) result.cost[key] = (a?.cost?.[key] || 0) + (b.cost?.[key] || 0);
 return result;
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; } }

export class WorkerPool {
 tasks: Task[] = [];
 children = new Map<string, ChildProcess>();
 cancelCallbacks = new Map<string, () => void>();
 listeners = new Set<(event: any) => void>();
 change: () => void = () => {};
 readonly epoch = randomUUID();
 readonly executors = new Set<WorkerExecutor>();
 private completions = new Map<string, Promise<Task>>();
 private closed = false;
 private queued = new Map<string, { task: Task; handle: WorkerHandle; profile: WorkerProfile; instruction: string; signal?: AbortSignal; timer: ReturnType<typeof setTimeout>; abort: () => void }>();
 private resolvers = new Map<string, (task: Task) => void>();
 private pumping = false;
 private pumpScheduled = false;
 private cancelling = false;
 private lastParent = '';
 private parentRotation: string[] = [];
 readonly concurrency: number;

 constructor(readonly database: OrbitalDatabase = db(), private readonly createExecutor: (profile: WorkerProfile) => WorkerExecutor = profile => new WarmExecutor(profile), options: { concurrency?: number } = {}) {
  this.concurrency = Math.min(MAX_CONCURRENT_CHILDREN, Math.max(1, Math.floor(options.concurrency || MAX_CONCURRENT_CHILDREN)));
  this.importLegacy();
  this.tasks = (database.prepare("SELECT task FROM workers ORDER BY json_extract(task,'$.started')").all() as any[]).map(row => JSON.parse(row.task));
  for (const task of this.tasks) {
   if (!terminalStates.has(task.status) && (!task.ownerPid || !alive(task.ownerPid))) {
    this.settle(task, 'INTERRUPTED', 'Owner process exited; task is not replayed');
   }
  }
 }
 private importLegacy() {
  const database = this.database;
  if (database.get('json_tasks_imported')) return;
  const file = join(root, '..', 'tasks', 'tasks.json');
  const records = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  if (!Array.isArray(records)) throw Error('Invalid legacy tasks');
  database.transaction(() => {
   for (const record of records) {
    if (!record?.id) continue;
    const state = (Object.keys(labels) as WorkerState[]).find(key => labels[key] === record.status && terminalStates.has(record.status)) || 'INTERRUPTED';
    const task = { ...record, state, status: labels[state], parentSessionId: record.parentSessionId || '', ownerEpoch: 'legacy' };
    database.prepare('INSERT OR IGNORE INTO workers VALUES(?,?,?,?,?,?,?,NULL)').run(task.id, task.parentSessionId, task.correlationId || task.id, '', task.ownerEpoch, state, JSON.stringify(task));
   }
   database.set('json_tasks_imported', true);
  });
 }
 subscribe(listener: (event: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
 emit(event: any) {
  for (const listener of this.listeners) { try { listener(event); } catch {} }
  try { this.change(); } catch {} // Rendering must not interrupt task cleanup.
 }
 active() { return this.tasks.filter(task => !terminalStates.has(task.status)); }
 eventsSince(cursor=0, options:{parentSessionId?:string;cwd?:string;limit?:number}={}) {
  return readWorkerEvents(this.database, {cursor, ...options});
 }
 private persist(task: Task, event: string) {
  this.database.transaction(() => {
   const update = this.database.prepare('UPDATE workers SET state=?,task=? WHERE id=? AND receipt IS NULL').run(task.state, JSON.stringify(task), task.id);
   if (update.changes) this.database.prepare('INSERT INTO worker_events(worker_id,type,created,payload) VALUES(?,?,?,?)').run(task.id, event, Date.now(), JSON.stringify({ state: task.state, tool: task.tool || null, profileRevision: task.profileRevision || null, queueWaitMs: task.queueWaitMs ?? null, checkpoint: task.checkpoint || null, checkpointAt: task.checkpointAt ?? null }));
  });
 }
 private transition(task: Task, state: WorkerState) {
  if (terminalStates.has(task.status) || task.state === state) return;
  task.state = state;
  task.status = labels[state];
  this.persist(task, 'state');
  this.emit({ type: 'task_status', task: { ...task } });
 }
 private settle(task: Task, state: WorkerState, error?: string): Receipt {
  const ended = Date.now();
  const complete = { ...task, state, status: labels[state], ended, tool: '', error, output: bounded(task.output), outputTruncated: task.outputTruncated || Buffer.byteLength(task.output) > 32768 };
  const receipt: Receipt = { version: 1, workerId: task.id, parentSessionId: task.parentSessionId, correlationId: task.correlationId, state, started: task.started, ended, output: complete.output, profileSnapshot: task.profileSnapshot, profileRevision: task.profileRevision, outputTruncated: complete.outputTruncated, error, resultHash: hash(complete.output), usage: task.usage };
  // Publish the terminal state, result and event together; crashes cannot leave a
  // terminal task with no receipt between separate UPDATE statements.
  const existing = this.database.transaction(() => {
   const row = this.database.prepare('SELECT receipt,task FROM workers WHERE id=?').get(task.id) as any;
   if (row.receipt) return row;
   this.database.prepare('UPDATE workers SET state=?,task=?,receipt=? WHERE id=? AND receipt IS NULL').run(state, JSON.stringify(complete), JSON.stringify(receipt), task.id);
   this.database.prepare('INSERT INTO worker_events(worker_id,type,created,payload) VALUES(?,?,?,?)').run(task.id, 'task_finished', ended, JSON.stringify({ state }));
   return null;
  });
  Object.assign(task, existing ? JSON.parse(existing.task) : complete);
  if (!existing) this.emit({ type: 'task_finished', task: { ...task } });
  this.resolvers.get(task.id)?.(structuredClone(task));
  this.resolvers.delete(task.id);
  this.completions.delete(task.id);
  return existing ? JSON.parse(existing.receipt) : receipt;
 }
 private authorize(handle: unknown, parent: string) {
  const value = handle as WorkerHandle;
  if (!value || value.version !== 1 || typeof value.workerId !== 'string' || typeof value.capability !== 'string' || value.parentSessionId !== parent || !parent) return null;
  const row = this.database.prepare('SELECT * FROM workers WHERE id=? AND parent=?').get(value.workerId, parent) as any;
  if (!row?.capability_hash) return null;
  const expected = Buffer.from(row.capability_hash, 'hex'), actual = Buffer.from(hash(value.capability), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? row : null;
 }
 status(handle: WorkerHandle, parent: string) {
  const row = this.authorize(handle, parent);
  if (!row) return { state: 'UNKNOWN' };
  const task = this.tasks.find(task => task.id === handle.workerId && task.ownerEpoch === this.epoch) || JSON.parse(row.task);
  return { workerId: task.id, state: row.state, agent: task.agent, elapsedMs: (task.ended || Date.now()) - task.started, limitSeconds: task.limit, tool: task.tool || null, firstTextMs: task.firstTextMs ?? null, queueWaitMs: task.queueWaitMs ?? null, queued: task.state === 'QUEUED' };
 }
 result(handle: WorkerHandle, parent: string): Receipt | { state: string } {
  const row = this.authorize(handle, parent);
  return !row ? { state: 'UNKNOWN_HANDLE' } : row.receipt ? JSON.parse(row.receipt) : { state: row.state };
 }
 async wait(handle: WorkerHandle, parent: string, seconds = 2) {
  if (!this.authorize(handle, parent)) return { state: 'UNKNOWN_HANDLE' };
  const pending = this.completions.get(handle.workerId);
  if (pending) {
   let timer: ReturnType<typeof setTimeout> | undefined;
   try { await Promise.race([pending, new Promise(resolve => timer = setTimeout(resolve, Math.max(0, Math.min(seconds, 30)) * 1000))]); }
   finally { clearTimeout(timer); }
  }
  return this.result(handle, parent);
 }
 reconnect(handle: WorkerHandle, parent: string) {
  const row = this.authorize(handle, parent);
  if (!row) return { state: 'UNKNOWN_HANDLE' };
  if (row.receipt) return JSON.parse(row.receipt);
  return (this.children.has(handle.workerId) || this.queued.has(handle.workerId)) ? this.status(handle, parent) : { state: 'RECONNECT_UNAVAILABLE' };
 }
 cancelHandle(handle: WorkerHandle, parent: string) {
  if (!this.authorize(handle, parent)) return { state: 'UNKNOWN_HANDLE' };
  this.cancel(handle.workerId);
  return this.status(handle, parent);
 }
 review(handle: WorkerHandle, parent: string) {
  const task = this.tasks.find(item => item.id === handle.workerId);
  if (!task || !this.authorize(handle, parent)) return { state: 'UNKNOWN_HANDLE' };
  if (!terminalStates.has(task.status)) {
   task.reviewDue = false;
   task.reviewAt = Date.now() + SUPERVISION_INTERVAL_SECONDS * 1000;
   this.persist(task, 'review_ack');
   this.emit({ type: 'task_review_ack', task: { ...task } });
  }
  return { state: task.state, reviewDue: !!task.reviewDue, reviewAt: task.reviewAt, reviewCount: task.reviewCount || 0 };
 }
 cancel(id: string) {
  const pending = this.queued.get(id);
  if (pending) {
   this.removeQueued(id);
   this.settle(pending.task, 'CANCELLED', 'Cancelled while queued');
   this.schedulePump();
   return;
  }
  this.cancelCallbacks.get(id)?.();
 }
 cancelAll() {
  this.cancelling = true;
  try {
   for (const id of [...this.queued.keys()]) this.cancel(id);
   for (const cancel of [...this.cancelCallbacks.values()]) cancel();
  } finally { this.cancelling = false; }
 }
 close() {
  if (this.closed) return;
  this.closed = true;
  this.cancelAll();
  for (const executor of this.executors) executor.kill();
 }
 async shutdown(timeoutMs=5000) {
  this.close();
  if (!this.children.size && !this.completions.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   await Promise.race([
    Promise.all([...this.completions.values(), ...[...this.executors].filter(e=>!e.dead).map(e=>new Promise<void>(resolve=>e.child.once('close',()=>resolve())))]),
    new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Worker shutdown is still pending')),timeoutMs)),
   ]);
  } finally {clearTimeout(timer);}
 }
 private removeQueued(id: string) {
  const entry = this.queued.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.signal?.removeEventListener('abort', entry.abort);
  this.queued.delete(id);
  return entry;
 }
 private schedulePump() {
  if (this.closed || this.cancelling || this.pumpScheduled) return;
  this.pumpScheduled = true;
  queueMicrotask(() => { this.pumpScheduled = false; this.pump(); });
 }
 private profile(crew: Crew, cwd: string, tools: string[], skills: string[], mcp: boolean): WorkerProfile {
  if (!crew.model?.trim()) throw Error('Worker model is empty');
  if (tools.some(tool => !(READ_ONLY_TOOLS as readonly string[]).includes(tool))) throw Error('Unapproved tool; no child started');
  if (mcp) throw Error('MCP server-scoped approval is not implemented; request human setup rather than broad access');
  return { cwd, model: crew.model, provider: crew.provider, tools: [...new Set(tools)].sort(), skills: [...new Set(skills)].sort(), mcp, role: crew.role, readScope: crew.readScope, readAllow: crew.readAllow };
 }
 private executor(profile: WorkerProfile): WorkerExecutor | undefined {
  const key = JSON.stringify(profile);
  for (const executor of this.executors) {
   // A terminating process occupies a slot until its close event is confirmed.
   if (executor.dead) { this.executors.delete(executor); continue; }
   if (!executor.busy && !executor.stopping && executor.key === key) { executor.reserve(); return executor; }
  }
  if (this.executors.size >= this.concurrency) {
   const idle = [...this.executors].find(executor => !executor.busy && !executor.stopping);
   if (idle) idle.kill();
   return undefined;
  }
  const executor = this.createExecutor(profile);
  executor.reserve();
  this.executors.add(executor);
  // Independent from per-task callbacks; idle eviction also wakes pending work.
  executor.child.once('close', () => {
   this.executors.delete(executor);
   this.schedulePump();
  });
  return executor;
 }
 async prewarm(crew: Crew, cwd: string, tools: string[] = crew.tools ?? Array.from(READ_ONLY_TOOLS), skills: string[] = crew.skills ?? []) {
  if (this.closed) throw Error('Pool closed');
  if (this.children.size >= this.concurrency) throw Error('All worker slots busy');
  const executor = this.executor(this.profile(crew, cwd, tools, skills, false));
  if (!executor) throw Error('All worker slots busy or retiring');
  try {
   await executor.ready();
   if (this.closed || executor.stopping || executor.dead) throw Error('Worker closed during prewarm');
   return { ready: true, pid: executor.child.pid, model: crew.model };
  } catch (error) { executor.kill(); throw error; }
  finally { if (!this.closed) executor.release(); this.schedulePump(); }
 }
 private startTask(task: Task, handle: WorkerHandle, executor: WorkerExecutor, instruction: string, signal?: AbortSignal) {
  const id = handle.workerId;
  task.dispatchedAt = Date.now();
  task.queueWaitMs = task.dispatchedAt - task.started;
  task.workerReused = executor.uses > 0;
  this.children.set(id, executor.child);
  this.transition(task, 'STARTING');
  {

   let finished = false, stopping = false, usage: any, final: any;let checkpointAt=0;
   let timer: ReturnType<typeof setTimeout>, reviewTimer: ReturnType<typeof setTimeout> | undefined, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
   const scheduleReview = () => {
    if (finished) return;
    const delay = Math.max(1000, (task.reviewAt || Date.now() + SUPERVISION_INTERVAL_SECONDS * 1000) - Date.now());
    reviewTimer = setTimeout(() => {
     if (finished) return;
     task.reviewCount = (task.reviewCount || 0) + 1;
     task.reviewDue = true;
     task.reviewAt = Date.now() + SUPERVISION_INTERVAL_SECONDS * 1000;
     this.persist(task, 'review_due');
     this.emit({ type: 'task_review_due', task: { ...task } });
     scheduleReview();
    }, delay);
    reviewTimer.unref?.();
   };
   const finish = (state: WorkerState, error?: string, exitConfirmed = true) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    clearTimeout(reviewTimer);
    clearTimeout(cleanupTimer);
    signal?.removeEventListener('abort', cancel);
    this.cancelCallbacks.delete(id);
    this.children.delete(id);
    executor.onEvent = undefined;
    executor.onExit = undefined;
    task.usage = usage;
    this.settle(task, state, error);
    if (!exitConfirmed) {
     // A result may be terminal while a stuck process is still being reaped.
     this.children.set(id, executor.child);
     this.cancelCallbacks.set(id, () => executor.kill());
     const reaper = setInterval(() => executor.kill(), 3000);
     reaper.unref?.();
     executor.onExit = () => { clearInterval(reaper); this.children.delete(id); this.cancelCallbacks.delete(id); this.schedulePump(); };
    }
    if (!stopping && !executor.dead && !executor.stopping && state === 'SUCCEEDED' && !this.closed) executor.release();
    else executor.kill();
    this.schedulePump();
   };
   const terminate = (state: WorkerState, error: string) => {
    if (finished || stopping) return;
    stopping = true;
    this.transition(task, 'CANCEL_REQUESTED');
    executor.onExit = () => finish(state, error);
    executor.kill();
    cleanupTimer = setTimeout(() => { executor.kill(); finish('FAILED', error + '; cleanup pending: process exit not confirmed within 3 seconds', false); }, 3000);
   };
   const cancel = () => terminate('CANCELLED', 'Cancelled by parent/operator');
   this.cancelCallbacks.set(id, cancel);
   signal?.addEventListener('abort', cancel, { once: true });
   timer = setTimeout(() => terminate('TIMED_OUT', 'Task hard deadline reached'), Math.max(1, task.started + task.limit * 1000 - Date.now()));
   executor.onExit = error => finish('FAILED', error.message);
   const setOutput = (text: string, append = false) => {
    const value = append ? task.output + text : text;
    task.outputTruncated = (append && task.outputTruncated) || Buffer.byteLength(value) > 32768;
    task.output = bounded(value);
   };
   executor.onEvent = event => {
    if (finished || stopping) return;
    if (event.type === 'agent_start') this.transition(task, 'RUNNING');
    if (event.type === 'message_start' && event.message?.role === 'assistant') { task.output = ''; task.outputTruncated = false; final = undefined; }
    if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
     task.firstTextMs ??= Date.now() - task.dispatchedAt!;
     setOutput(event.assistantMessageEvent.delta, true);
     if(Date.now()-checkpointAt>=2000){checkpointAt=Date.now();task.checkpoint=bounded(task.output,1200);task.checkpointAt=checkpointAt;this.persist(task,'checkpoint');}
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
     final = event.message;
     usage = mergeUsage(usage, final.usage);
     setOutput(typeof final.content === 'string' ? final.content : (final.content || []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n'));
    }
    if (event.type === 'tool_execution_start') { task.tool = event.toolName; this.persist(task, 'tool_start'); }
    if (event.type === 'tool_execution_end') { task.tool = ''; this.persist(task, 'tool_end'); }
    if (event.type === 'agent_settled') {
     if (event.aborted) finish('CANCELLED', 'Agent aborted');
     else if (final?.stopReason === 'stop' && !final.errorMessage) finish('SUCCEEDED');
     else finish('FAILED', final?.errorMessage || 'No completed assistant response');
     return;
    }
    this.emit({ type: 'task_progress', task: { ...task } });
   };
   (async () => {
    await executor.ready();
    if (stopping || finished) return;
    await executor.reset();
    if (stopping || finished) return;
    const response = await executor.request('prompt', { message: instruction }, Math.max(1000, task.limit * 1000));
    if (response?.disposition === 'handled' && !finished && !stopping) terminate('FAILED', 'Worker prompt was handled without starting an agent');
   })().catch(error => { if (!finished && !stopping) terminate('FAILED', error.message); });
   if (signal?.aborted) cancel();
   task.reviewAt = Date.now() + SUPERVISION_INTERVAL_SECONDS * 1000;
   task.reviewCount = 0;
   task.reviewDue = false;
   this.persist(task, 'started');
   scheduleReview();
   this.emit({ type: 'task_started', task: { ...task } });
 }
 }
 launch(crew: Crew, instruction: string, cwd: string, session: string, seconds = DEFAULT_TASK_SECONDS, signal?: AbortSignal, parentSessionId = '', tools: string[] = crew.tools ?? Array.from(READ_ONLY_TOOLS), skills: string[] = crew.skills ?? [], mcp = false, delegationDepth = 0, parentWorkerId?: string): WorkerHandle {
  if (this.closed) throw Error('Pool closed');
  if (!parentSessionId) throw Error('A bound parent session is required');
  if (signal?.aborted) throw Error('Task cancelled');
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_TASK_SECONDS) throw Error(`Task deadline must be 1-${MAX_TASK_SECONDS} seconds`);
  if (!Number.isInteger(delegationDepth) || delegationDepth < 0 || delegationDepth > 1) throw Error('Nested delegation depth is limited to one level');
  const parentTask = parentWorkerId && this.tasks.find(item => item.id === parentWorkerId);
  if (parentWorkerId && (!parentTask || parentTask.parentSessionId !== parentSessionId)) throw Error('Parent worker is unknown or belongs to another session');
  if (parentTask && seconds > Math.max(1, Math.floor(parentTask.limit / 2))) throw Error(`Copied task deadline cannot exceed half of parent task (${Math.floor(parentTask.limit / 2)} seconds)`);
  if (!instruction.trim()) throw Error('Task goal is empty');
  if (this.queued.size >= 1000) throw Error('Worker queue is full');
  const profile = this.profile(crew, cwd, tools, skills, mcp);
  const snapshotBase = { name: crew.name, role: crew.role, roleKey: crew.roleKey, model: profile.model, provider: profile.provider, tools: [...profile.tools], skills: [...profile.skills], mcp: profile.mcp };
  const snapshot: AgentProfileSnapshot = structuredClone({ ...snapshotBase, revision: profileRevision(snapshotBase) });
  Object.freeze(snapshot.tools); Object.freeze(snapshot.skills); Object.freeze(snapshot);
  const id = randomUUID(), capability = randomBytes(32).toString('hex');
  const handle: WorkerHandle = { version: 1, workerId: id, parentSessionId, capability, delegationDepth, parentWorkerId };
  const task: Task = { id, agent: crew.name, role: crew.role, title: instruction, cwd, session, parentSessionId, correlationId: randomUUID(), state: 'QUEUED', status: labels.QUEUED, started: Date.now(), output: '', profileSnapshot: snapshot, profileRevision: snapshot.revision, limit: seconds, model: crew.model, provider: crew.provider, ownerPid: process.pid, ownerEpoch: this.epoch, tools: [...profile.tools], skills: [...profile.skills], mcp, delegationDepth, parentWorkerId };
  this.database.transaction(() => {
   this.database.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,NULL)').run(id, parentSessionId, task.correlationId, hash(capability), this.epoch, task.state, JSON.stringify(task));
   this.database.prepare('INSERT INTO worker_events(worker_id,type,created,payload) VALUES(?,?,?,?)').run(id, 'queued', task.started, JSON.stringify({state:task.state,profileRevision:task.profileRevision}));
  });
  this.tasks.push(task);
  this.completions.set(id, new Promise<Task>(resolve => this.resolvers.set(id, resolve)));
  const abort = () => this.cancel(id);
  const timer = setTimeout(() => {
   if (!this.queued.has(id)) return;
   this.removeQueued(id);
   this.settle(task, 'TIMED_OUT', 'Task deadline reached while queued');
   this.schedulePump();
  }, task.limit * 1000);
  this.queued.set(id, { task, handle, profile, instruction, signal, timer, abort });
  // Strict round robin: a parent re-joins behind everyone already waiting, and tasks
  // for the just-served parent wait one full cycle instead of jumping the queue.
  const pid = task.parentSessionId;
  if (!this.parentRotation.includes(pid)) {
   if (pid === this.lastParent) this.parentRotation.push(pid);
   else {
    const served = this.lastParent ? this.parentRotation.indexOf(this.lastParent) : -1;
    if (served >= 0) this.parentRotation.splice(served, 0, pid); else this.parentRotation.push(pid);
   }
  }
  signal?.addEventListener('abort', abort, {once:true});
  this.emit({ type: 'task_queued', task: { ...task } });
  if (signal?.aborted) abort(); else this.pump();
  return handle;
 }
 private pump() {
  if (this.closed || this.cancelling || this.pumping) return;
  this.pumping = true;
  try {
   while (this.queued.size && this.children.size < this.concurrency) {
    const candidates = [...this.queued.values()];
    // FIFO within a parent; strict round robin between parents so one project cannot starve another.
    this.parentRotation = this.parentRotation.filter(pid => candidates.some(item => item.task.parentSessionId === pid));
    const parent = this.parentRotation[0];
    const entry = (parent && candidates.find(item => item.task.parentSessionId === parent)) || candidates[0];
    let executor: WorkerExecutor | undefined;
    try { executor = this.executor(entry.profile); }
    catch (error) {
     this.removeQueued(entry.task.id);
     this.settle(entry.task, 'FAILED', String(error));
     continue;
    }
    if (!executor) break;
    this.removeQueued(entry.task.id);
    this.lastParent = entry.task.parentSessionId;
    const served = this.parentRotation.indexOf(entry.task.parentSessionId);
    if (served >= 0) { this.parentRotation.splice(served, 1); this.parentRotation.push(entry.task.parentSessionId); }
    this.startTask(entry.task, entry.handle, executor, entry.instruction, entry.signal);
   }
  } finally { this.pumping = false; }
 }
 async run(crew: Crew, instruction: string, cwd: string, session: string, seconds = DEFAULT_TASK_SECONDS, signal?: AbortSignal, parentSessionId = '', tools: string[] = crew.tools ?? Array.from(READ_ONLY_TOOLS), skills: string[] = crew.skills ?? [], mcp = false, delegationDepth = 0, parentWorkerId?: string): Promise<Task> {
  const handle = this.launch(crew, instruction, cwd, session, seconds, signal, parentSessionId || session, tools, skills, mcp, delegationDepth, parentWorkerId);
  return this.completions.get(handle.workerId) || structuredClone(this.tasks.find(task => task.id === handle.workerId)!);
 }
}
