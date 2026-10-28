import { spawn, type ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPackageDir } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';

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

export type WorkerProfile = { cwd: string; model: string; provider: string; tools: string[]; skills: string[]; mcp: boolean; role: string };
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

 constructor(readonly profile: WorkerProfile, spawnWorker: typeof spawn = spawn) {
  this.key = JSON.stringify(profile);
  if (profile.mcp) throw Error('MCP requires server-scoped approval; warm executor refuses broad MCP access');
  const args = [join(getPackageDir(), 'dist', 'cli.js'), '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--no-approve', '--offline',
   ...(profile.tools.length ? ['--tools', profile.tools.join(',')] : ['--no-tools']),
   ...profile.skills.flatMap(p => ['--skill', p]), '--thinking', 'low', '--model', profile.model,
   ...(profile.provider ? ['--provider', profile.provider] : []),
   '--append-system-prompt', `Delegated role: ${profile.role}. Read-only scope. Do not access credentials. Work only on the assigned task; return verifiable findings.`];
  this.child = spawnWorker(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'worker-host.cjs'), ...args], {
   cwd: profile.cwd, env: { ...process.env, ORBITAL_PARENT_PID: String(process.pid) }, windowsHide: true,
   detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  this.child.stdout!.setEncoding('utf8');
  this.child.stderr!.setEncoding('utf8');
  this.child.stdout!.on('data', (chunk: string) => this.receive(chunk));
  this.child.stderr!.on('data', (text: string) => this.stderr = (this.stderr + text).slice(-4000));
  this.child.on('error', error => { this.failure = error; this.kill(); });
  this.child.on('close', code => {
   this.dead = true;
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
  this.stopping = true;
  this.rejectPending(this.failure || Error('Worker terminating'));
  if (!this.dead) killTree(this.child);
 }
}

// Structural interface allows lifecycle tests to inject a local RPC executor.
export type WorkerExecutor = Pick<WarmExecutor, 'child' | 'key' | 'busy' | 'dead' | 'stopping' | 'uses' | 'onEvent' | 'onExit' | 'ready' | 'reset' | 'request' | 'reserve' | 'release' | 'kill'>;
