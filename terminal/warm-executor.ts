import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { getAgentDir, getPackageDir } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { dataRoot } from './paths.ts';
import { sandboxEnv, type ReadScope } from './worker-sandbox.ts';
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

export type WorkerProfile = { cwd: string; model: string; provider: string; tools: string[]; skills: string[]; mcp: boolean; role: string; readScope?: ReadScope; readAllow?: string[]; mcpServers?: string[] };
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
  this.key = JSON.stringify(profile);
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
  const args = [join(getPackageDir(), 'dist', 'cli.js'), '--mode', 'rpc', '--no-session', '--no-extensions', '-e', sandbox, '--no-skills', ...(mcpServers.length ? [] : ['--no-mcp']), '--no-context-files', '--no-prompt-templates', '--no-approve', '--offline',
   ...(toolAllow.length ? ['--tools', toolAllow.join(',')] : ['--no-tools']),
   ...profile.skills.flatMap(p => ['--skill', p]), '--thinking', 'low', '--model', profile.model,
   ...(profile.provider ? ['--provider', profile.provider] : []),
   '--append-system-prompt', `You are a delegated read-only worker in Kepos. Never access credentials; never modify files or run mutating commands; work only on the assigned task and return verifiable findings with sources.${mcpServers.length ? ` Approved MCP servers for this task only: ${mcpServers.join(', ')}.` : ''} Assigned role: ${profile.role}.`];
  // Sandbox scope travels via environment variables: Pi's CLI rejects unknown options,
  // so the read-guard configuration must never ride on argv.
  const env = workerEnv(process.env, process.pid, { provider: profile.provider, model: profile.model,
   agentDir: process.env.PI_CODING_AGENT_DIR || process.env.KEPOS_AGENT_DIR || getAgentDir() });
  Object.assign(env, sandboxEnv({ mode: profile.readScope === 'machine' ? 'machine' : 'project', allow: profile.readAllow ?? [], deny: [dataRoot] }));
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
