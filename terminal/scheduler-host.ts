import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, connect, type Server as NetServer, type Socket } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { READ_ONLY_TOOLS, DEFAULT_TASK_SECONDS, type WorkerHandle } from './worker-contract.ts';
import type { WorkerPool } from './workers.ts';
import type { MissionScheduler } from './scheduler.ts';

/**
 * Phase 1 of unified scheduling (docs/unified-scheduling.md): the daemon exposes the
 * WorkerPool/Scheduler over a local line-delimited JSON transport so clients (TUI, CLI,
 * scripts) share one pool instead of each owning one. Same machine, same user — the
 * endpoint lives in the data directory and the token is generated on first start.
 */

export interface SchedulerHostOptions { port: number; host?: string; token?: string; dataDir?: string }

export function schedulerEndpointPaths(dataDir: string) { return { token: join(dataDir, 'scheduler.token'), port: join(dataDir, 'scheduler.port') }; }

export function readSchedulerEndpoint(dataDir: string): { token: string; port: number } | undefined {
  const paths = schedulerEndpointPaths(dataDir);
  if (!existsSync(paths.token) || !existsSync(paths.port)) return undefined;
  try {
    const port = Number(readFileSync(paths.port, 'utf8').trim());
    const token = readFileSync(paths.token, 'utf8').trim();
    return port > 0 && token ? { token, port } : undefined;
  } catch { return undefined; }
}

function persistEndpoint(dataDir: string, token: string, port: number): void {
  mkdirSync(dataDir, { recursive: true });
  const paths = schedulerEndpointPaths(dataDir);
  writeFileSync(paths.token, token + '\n');
  writeFileSync(paths.port, String(port) + '\n');
}

function clearEndpoint(dataDir: string): void {
  const paths = schedulerEndpointPaths(dataDir);
  for (const file of [paths.port]) { try { if (existsSync(file)) unlinkSync(file); } catch {} }
}

function digest(value: string) { return createHash('sha256').update(value).digest(); }
function authorized(expected: string, provided?: string) { if (!provided) return false; const a = digest(expected), b = digest(provided); return a.length === b.length && timingSafeEqual(a, b); }

const MAX_WIRE_BYTES = 1024 * 1024;
type Request = { id: string; action: string; token?: string } & Record<string, any>;

export class SchedulerHost {
  private server?: NetServer;
  readonly token: string;

  constructor(private readonly pool: WorkerPool, private readonly scheduler: MissionScheduler, private readonly options: SchedulerHostOptions) {
    const paths = options.dataDir ? schedulerEndpointPaths(options.dataDir) : undefined;
    this.token = options.token || (paths && existsSync(paths.token) ? readFileSync(paths.token, 'utf8').trim() : '') || randomBytes(24).toString('hex');
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) return { host: this.options.host || '127.0.0.1', port: (this.server.address() as any)?.port || this.options.port };
    const server = createServer(socket => this.attach(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host || '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    this.server = server;
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : this.options.port;
    if (this.options.dataDir) persistEndpoint(this.options.dataDir, this.token, port);
    return { host: this.options.host || '127.0.0.1', port };
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
    if (this.options.dataDir) clearEndpoint(this.options.dataDir);
  }

  private attach(socket: Socket) {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_WIRE_BYTES) { socket.destroy(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        void this.handle(socket, line);
      }
    });
  }

  private reply(socket: Socket, id: string, success: boolean, data: any) {
    socket.write(JSON.stringify({ id, success, ...(success ? { data } : { error: data }) }) + '\n');
  }

  private async handle(socket: Socket, line: string) {
    let request: Request;
    try { request = JSON.parse(line); } catch { this.reply(socket, '?', false, 'Invalid JSON'); return; }
    if (!authorized(this.token, request.token)) { this.reply(socket, request.id, false, 'Unauthorized'); return; }
    try {
      const data = await this.dispatch(request);
      this.reply(socket, request.id, true, data);
    } catch (error) {
      this.reply(socket, request.id, false, error instanceof Error ? error.message : String(error));
    }
  }

  private handleOf(request: Request): WorkerHandle {
    const handle = request.handle as WorkerHandle | undefined;
    if (!handle || handle.version !== 1 || typeof handle.workerId !== 'string' || typeof handle.parentSessionId !== 'string' || typeof handle.capability !== 'string') throw Error('request requires a worker handle');
    return handle;
  }

  private async dispatch(request: Request): Promise<any> {
    const parent = typeof request.parentSessionId === 'string' ? request.parentSessionId : '';
    switch (request.action) {
      case 'health': return { ok: true, active: this.pool.active().length, queued: this.pool.tasks.filter(task => task.state === 'QUEUED').length };
      case 'launch': {
        const { crew, instruction, cwd } = request;
        if (!crew || !instruction || !cwd || !request.parentSessionId) throw Error('launch requires crew,instruction,cwd,parentSessionId');
        return this.pool.launch(crew, instruction, cwd, request.session || '', request.seconds ?? DEFAULT_TASK_SECONDS, undefined, request.parentSessionId, Array.isArray(request.tools) && request.tools.length ? request.tools : Array.from(READ_ONLY_TOOLS), Array.isArray(request.skills) ? request.skills : [], false, request.delegationDepth || 0, request.parentWorkerId || undefined, request.budgetTokens);
      }
      case 'status': return this.pool.status(this.handleOf(request), this.handleOf(request).parentSessionId);
      case 'result': return this.pool.result(this.handleOf(request), this.handleOf(request).parentSessionId);
      case 'wait': return this.pool.wait(this.handleOf(request), this.handleOf(request).parentSessionId, Math.min(30, Math.max(0, Number(request.seconds ?? 2))));
      case 'review': return this.pool.review(this.handleOf(request), this.handleOf(request).parentSessionId);
      case 'cancel': return this.pool.cancelHandle(this.handleOf(request), this.handleOf(request).parentSessionId);
      case 'cancelAll': this.pool.cancelAll(); return { state: 'cancelling' };
      case 'tasks': return this.pool.tasks.filter(task => !parent || task.parentSessionId === parent).slice(-100).map(task => ({ id: task.id, agent: task.agent, state: task.state, status: task.status, title: task.title.slice(0, 200), parentSessionId: task.parentSessionId, stalled: task.stalled || undefined, budgetTokens: task.budgetTokens, mcpServers: task.mcpServers }));
      case 'events': return this.pool.eventsSince(request.cursor ?? 0, { parentSessionId: parent || undefined, limit: Math.min(200, Number(request.limit ?? 100)) });
      case 'plans': return this.scheduler.list(parent || undefined).map(plan => ({ id: plan.id, goal: plan.goal, state: plan.state, cwd: plan.cwd, completed: plan.jobs.filter(job => job.state === 'SUCCEEDED').length, total: plan.jobs.length, attention: plan.jobs.filter(job => job.state === 'NEEDS_HUMAN').length }));
      case 'plan': {
        const planId = String(request.planId || '');
        const plan = planId && this.scheduler.get(planId, parent);
        if (!plan) throw Error('当前会话没有该计划');
        switch (request.planAction) {
          case 'pause': this.scheduler.pause(planId, parent); break;
          case 'resume': this.scheduler.resume(planId, parent); this.scheduler.start(); break;
          case 'cancel': this.scheduler.cancel(planId, parent); break;
          case 'approve': if (!request.jobId) throw Error('approve requires jobId'); this.scheduler.approve(planId, parent, request.jobId); this.scheduler.start(); break;
          default: throw Error('Unknown plan action: ' + request.planAction);
        }
        return { done: true };
      }
      default: throw Error('Unknown scheduler action: ' + request.action);
    }
  }
}

export interface SchedulerClientOptions { host?: string; port: number; token: string; timeoutMs?: number }

export class SchedulerClient {
  constructor(private readonly options: SchedulerClientOptions) {}

  /** Client bound to a daemon's persisted endpoint; undefined when no daemon is running. */
  static fromDataDir(dataDir: string, timeoutMs = 8000): SchedulerClient | undefined {
    const endpoint = readSchedulerEndpoint(dataDir);
    return endpoint ? new SchedulerClient({ port: endpoint.port, token: endpoint.token, timeoutMs }) : undefined;
  }

  request<T = any>(action: string, extra: Record<string, any> = {}): Promise<T> {
    const id = randomBytes(8).toString('hex');
    const timeoutMs = this.options.timeoutMs ?? 8000;
    return new Promise<T>((resolve, reject) => {
      const socket = connect({ host: this.options.host || '127.0.0.1', port: this.options.port });
      let buffer = '';
      let settled = false;
      const settle = (fn: () => void) => { if (settled) return; settled = true; fn(); };
      const timer = setTimeout(() => settle(() => { socket.destroy(); reject(Error('Scheduler RPC timed out')); }), timeoutMs);
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MAX_WIRE_BYTES) { clearTimeout(timer); settle(() => { socket.destroy(); reject(Error('Scheduler response exceeded the 1 MiB wire limit')); }); return; }
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        clearTimeout(timer);
        let response: any;
        try { response = JSON.parse(buffer.slice(0, index)); } catch { settle(() => { socket.destroy(); reject(Error('Scheduler sent an unparsable response')); }); return; }
        socket.end();
        if (response.id !== id) { settle(() => reject(Error('Scheduler response id mismatch'))); return; }
        if (response.success) settle(() => resolve(response.data)); else settle(() => reject(Error(response.error || 'Scheduler request failed')));
      });
      socket.on('error', error => { clearTimeout(timer); settle(() => reject(error)); });
      socket.write(JSON.stringify({ id, action, token: this.options.token, ...extra }) + '\n');
    });
  }

  health() { return this.request('health'); }
  launch(input: { crew: any; instruction: string; cwd: string; parentSessionId: string; session?: string; seconds?: number; tools?: string[]; skills?: string[]; budgetTokens?: number; parentWorkerId?: string; delegationDepth?: number }) { return this.request('launch', input); }
  status(handle: WorkerHandle) { return this.request('status', { handle }); }
  result(handle: WorkerHandle) { return this.request('result', { handle }); }
  wait(handle: WorkerHandle, seconds = 2) { return this.request('wait', { handle, seconds }); }
  review(handle: WorkerHandle) { return this.request('review', { handle }); }
  cancel(handle: WorkerHandle) { return this.request('cancel', { handle }); }
  cancelAll() { return this.request('cancelAll'); }
  tasks(parentSessionId?: string) { return this.request('tasks', { parentSessionId }); }
  events(cursor = 0, parentSessionId?: string, limit?: number) { return this.request('events', { cursor, parentSessionId, limit }); }
  plans(parentSessionId?: string) { return this.request('plans', { parentSessionId }); }
  plan(planId: string, parentSessionId: string, planAction: 'pause' | 'resume' | 'cancel' | 'approve', jobId?: string) { return this.request('plan', { planId, parentSessionId, planAction, jobId }); }
}
