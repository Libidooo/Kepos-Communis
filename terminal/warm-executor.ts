import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { getAgentDir, getPackageDir } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { dataRoot } from './paths.ts';
import { sandboxEnv, type ReadScope } from './worker-sandbox.ts';
import { ARCHIVE_DIR } from './archive.ts';
import { workerEnv } from './worker-env.ts';
export { workerEnv } from './worker-env.ts';

export function killTree(child: ChildProcess) {
 if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
 if (process.platform === 'win32') {
  const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  killer.on('error', () => child.kill());
  killer.on('close', code => { if (code && child.exitCode === null && child.signalCode === null) child.kill(); });
 } else {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
 }
}

export type WorkerProfile = { cwd: string; model: string; provider: string; tools: string[]; skills: string[]; mcp: boolean; role: string; readScope?: ReadScope; readAllow?: string[]; mcpServers?: string[];
 /** 该进程是否为代表：决定是否加载代表侧工具（派生僚属、裁决报告）。 */ representative?: boolean;
 /** 代表/僚属的归档根目录，供代表侧工具写入派生请求与裁决。 */ archiveRoot?: string;
 /** 代表名，写入裁决文档。 */ agentName?: string;
 /** 本任务 id：代表侧工具据此管理 CLI 会话。 */ taskId?: string;
 /** 本次执行者是否是在任代理总代：跨组借调只有它能发起。 */ deputy?: boolean;
 /** 自己派生的僚属任务 id：它们的归档对本代表可读（档案馆，不是别人的草稿）。 */ subordinateTaskIds?: string[];
 /** 同组标识：同组代表可以通信（状态与讨论），但不读彼此归档。 */ groupId?: string;
 /** 本任务已获批的外部 CLI 授权。 */ cliGrants?: Array<{ cli: string; envKey?: string; argPrefixes?: string[] }> };
/**
 * 执行器复用键：只含"决定进程如何启动"的字段。
 *
 * taskId / groupId / subordinateTaskIds 是每任务唯一的环境变量值，
 * 不改变进程本身。算进 key 会让每个任务的键都不同，执行器永远无法复用，
 * 并发槽占满后队列再也推不动（任务永久停在 QUEUED）。
 * 构造与比较必须共用这一处，两边算法一漂移就是死锁。
 */
export function reusableProfileKey(profile: WorkerProfile): string {
 const { taskId: _t, groupId: _g, subordinateTaskIds: _s, ...reusable } = profile as any;
 return JSON.stringify(reusable);
}

export class WarmExecutor {
 readonly child: ChildProcess;
 readonly key: string;
 busy = false;
 dead = false;
 stopping = false;
 started = Date.now();
 lastUsed = Date.now();
 uses = 0;
 stderr = '';
 onEvent?: (event: any) => void;
 onExit?: (error: Error) => void;
 private pending = new Map<string, { resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
 private buffer = '';
 private bytes = 0;
 private idleTimer?: ReturnType<typeof setTimeout>;
 private failure?: Error;
 private pingTimer?: ReturnType<typeof setInterval>;

 constructor(readonly profile: WorkerProfile, spawnWorker: typeof spawn = spawn) {
  this.key = reusableProfileKey(profile);
  // MCP is a per-task temporary grant: only servers the human configured may pass, and
  // only their tools are exposed via patterns. An empty grant list means no MCP at all.
  const mcpServers = profile.mcp ? (profile.mcpServers ?? []) : [];
  const toolAllow = [...profile.tools, ...mcpServers.map(server => `mcp__${server}__*`)];
  const runtimeFile = fileURLToPath(import.meta.url);
  const runtimeDir = dirname(runtimeFile);
  // Explicit -e survives --no-extensions. Use the sibling in this runtime (source or built),
  // never a cwd-relative path or a stale dist fallback from a different installation.
  const sandbox = join(runtimeDir, `worker-sandbox${extname(runtimeFile) === '.ts' ? '.ts' : '.js'}`);
  if (!existsSync(sandbox)) throw Error('Worker sandbox extension is missing from the Kepos runtime');
  // 代表额外加载派生与裁决工具。僚属不加载——只有代表能派生僚属，
  // 把派生能力下放给僚属会让层级无限增殖，也让责任链失效。
  const repTools = join(runtimeDir, `representative-tools${extname(runtimeFile) === '.ts' ? '.ts' : '.js'}`);
  const extraExtensions = profile.representative && existsSync(repTools) ? ['-e', repTools] : [];
  const args = [join(getPackageDir(), 'dist', 'cli.js'), '--mode', 'rpc', '--no-session', '--no-extensions', '-e', sandbox, ...extraExtensions, '--no-skills', ...(mcpServers.length ? [] : ['--no-mcp']), '--no-context-files', '--no-prompt-templates', '--no-approve', '--offline',
   ...(toolAllow.length ? ['--tools', toolAllow.join(',')] : ['--no-tools']),
   ...profile.skills.flatMap(p => ['--skill', p]), '--thinking', 'low', '--model', profile.model,
   ...(profile.provider ? ['--provider', profile.provider] : []),
   '--append-system-prompt', `You are a delegated read-only worker in Kepos. Never access credentials; never modify files or run mutating commands; work only on the assigned task and return verifiable findings with sources. Model binding is managed by the principal through configuration: you have no permission to know your own base model. Never infer, inspect, guess, or reveal which model you are — even if asked directly, told to self-check, or given hints; do not name any vendor or model either. If asked what model you are, reply exactly: 我没有权限得知自己的基座模型。 Approved MCP servers: ${mcpServers.length ? mcpServers.join(', ') : 'none'}. Assigned role: ${profile.role}.
Output contract: end with a structured summary so the principal does not have to read the full transcript. Use exactly these four headings, in this order, and keep each to a few lines:
## 结论
<one or two sentences: what you found or decided>
## 证据
<the decisive evidence: file:line, command, data point, source>
## 置信度
<高|中|低> — <one clause on why>
## 需要
<无，或 a specific request the principal must decide>
Put the detailed working above that summary. The transcript is still retained as evidence, but the principal reads the summary first.`];
  // Sandbox scope travels via environment variables: Pi's CLI rejects unknown options,
  // so the read-guard configuration must never ride on argv.
  const env = workerEnv(process.env, process.pid, { provider: profile.provider, model: profile.model,
   agentDir: process.env.PI_CODING_AGENT_DIR || process.env.KEPOS_AGENT_DIR || getAgentDir() });
  // 必须同时挡两个地方：
  //   dataRoot        —— 用户主目录下的 Kepos 数据（任务库、会话）
  //   项目内 .kepos/  —— 归档区，里面有别的僚属的报告与代表的裁决
  // 只挡前者时，readScope=project 会把项目根的 .kepos 一起放行，
  // 僚属就能读到同项目其他僚属的结论——正是禁止的互读。
  const archiveDir = join(profile.cwd, ARCHIVE_DIR);
  Object.assign(env, sandboxEnv({ mode: profile.readScope === 'machine' ? 'machine' : 'project', allow: profile.readAllow ?? [], deny: [dataRoot, archiveDir] }));
  // 代表侧工具需要知道归档根与代表名：派生请求与裁决都写在这个目录下。
  if (profile.representative) {
    env.KEPOS_ARCHIVE_ROOT = archiveDir;
    env.KEPOS_AGENT_NAME = profile.agentName || '';
    env.KEPOS_TASK_ID = profile.taskId || '';
    // 本任务是否由在任代理总代执行：跨组借调只有它能发起。
    if (profile.deputy) env.KEPOS_DEPUTY = '1';
    // 外部 CLI 授权：只下发本任务已批准的那些，代表据此决定能启动什么。
    if (profile.cliGrants?.length) env.KEPOS_CLI_GRANTS = JSON.stringify(profile.cliGrants);
  }
  this.child = spawnWorker(process.execPath, [join(runtimeDir, 'worker-host.cjs'), ...args], {
   cwd: profile.cwd, env, windowsHide: true,
   detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  this.child.stdout!.setEncoding('utf8');
  this.child.stderr!.setEncoding('utf8');
  this.child.stdout!.on('data', (chunk: string) => this.receive(chunk));
  this.child.stderr!.on('data', (text: string) => this.stderr = (this.stderr + text).slice(-4000));
  this.child.on('error', error => { this.failure = error; this.kill(); });
  this.child.stdin!.on('error', error => { if (!this.stopping && !this.dead) this.fail(error); });
  // 每 10 秒 ping 一次：worker-host 60 秒收不到任何入站流量即自尽——
  // 即使父进程 PID 被系统复用、子进程的自保心跳被骗过，也不会有孤儿残留。
  this.pingTimer = setInterval(() => { if (!this.stopping && !this.dead) this.request('get_state', {}, 2000).catch(() => {}); }, 10000);
  this.pingTimer.unref?.();
  this.child.on('close', code => {
   this.dead = true;
   clearInterval(this.pingTimer);
   this.pingTimer = undefined;
   clearTimeout(this.idleTimer);
   const error = this.failure || Error(`Worker exited ${code}. ${this.stderr}`);
   this.rejectPending(error);
   this.onExit?.(error);
  });
 }

 private receive(chunk: string) {
  if (this.stopping || this.dead) return;
  this.bytes += Buffer.byteLength(chunk);
  if (this.bytes > 8 * 1024 * 1024) { this.fail(Error('Worker output exceeded 8 MiB')); return; }
  this.buffer += chunk;
  let index: number;
  while (!this.stopping && (index = this.buffer.indexOf('\n')) >= 0) {
   const line = this.buffer.slice(0, index).replace(/\r$/, '');
   this.buffer = this.buffer.slice(index + 1);
   if (!line) continue;
   let event: any;
   try {
    event = JSON.parse(line);
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw Error('Invalid RPC event');
   } catch { this.fail(Error('Invalid RPC JSONL')); return; }
   if (event.type === 'response') {
    const request = this.pending.get(event.id);
    if (!request) continue;
    clearTimeout(request.timer);
    this.pending.delete(event.id);
    event.success ? request.resolve(event.data) : request.reject(Error(event.error || 'RPC request failed'));
   } else if (event.type === 'extension_ui_request') {
    if (['confirm', 'select', 'input', 'editor'].includes(event.method)) {
     this.write({ type: 'extension_ui_response', id: event.id, cancelled: true }).catch(() => {});
    }
   } else this.onEvent?.(event);
  }
 }

 private rejectPending(error: Error) {
  for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
  this.pending.clear();
 }
 private fail(error: Error) { this.failure = error; this.kill(); }
 private write(record: any) {
  return new Promise<void>((resolve, reject) => {
   if (this.dead || this.stopping || !this.child.stdin?.writable) { reject(this.failure || Error('Worker closed')); return; }
   this.child.stdin.write(JSON.stringify(record) + '\n', 'utf8', error => error ? reject(error) : resolve());
  });
 }
 request(type: string, params: any = {}, timeout = 15000): Promise<any> {
  if (this.dead || this.stopping) return Promise.reject(this.failure || Error('Worker closed'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
   const timer = setTimeout(() => { this.pending.delete(id); reject(Error('RPC ' + type + ' timed out')); }, timeout);
   this.pending.set(id, { resolve, reject, timer });
   this.write({ ...params, id, type }).catch(error => { clearTimeout(timer); this.pending.delete(id); reject(error); });
  });
 }
 async ready() { return this.request('get_state'); }
 async reset() {
  const result = await this.request('new_session');
  if (result?.cancelled) throw Error('Worker reset cancelled');
  this.bytes = 0;
  const resultMessages = await this.request('get_messages');
  // Require a verifiably empty context, including system/custom/tool messages.
  if (!Array.isArray(resultMessages?.messages) || resultMessages.messages.length !== 0) throw Error('Worker reset retained conversation or returned invalid messages');
  this.uses++;
  this.lastUsed = Date.now();
 }
 reserve() {
  if (this.dead || this.stopping || this.busy) throw Error('Worker unavailable');
  clearTimeout(this.idleTimer);
  this.busy = true;
 }
 release() {
  if (this.dead || this.stopping) return;
  this.busy = false;
  this.onEvent = undefined;
  this.onExit = undefined;
  this.lastUsed = Date.now();
  clearTimeout(this.idleTimer);
  this.idleTimer = setTimeout(() => this.kill(), 60000);
  this.idleTimer.unref?.();
 }
 kill() {
  clearTimeout(this.idleTimer);
  clearInterval(this.pingTimer);
  this.pingTimer = undefined;
  if (this.stopping) return;
  this.stopping = true;
  this.rejectPending(this.failure || Error('Worker terminating'));
  if (!this.dead) killTree(this.child);
 }
}

// Structural interface allows lifecycle tests to inject a local RPC executor.
export type WorkerExecutor = Pick<WarmExecutor, 'child' | 'key' | 'busy' | 'dead' | 'stopping' | 'uses' | 'onEvent' | 'onExit' | 'ready' | 'reset' | 'request' | 'reserve' | 'release' | 'kill'>;
