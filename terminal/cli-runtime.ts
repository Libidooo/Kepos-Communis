// 外部 CLI：可配置白名单、独立凭据、多会话、实际执行。
//
// 人类裁定（本次）：
//   1. 白名单存 config.json，人类加什么总理就能用什么——不写死。
//   2. 每个 CLI 独立配置，只传它需要的那个环境变量，不给全部。
//   3. 代表可同时开多个 CLI 会话，各自独立推进、分别回收结果。
//   4. 授权后代表自己 spawn；任务结束授权回收。
//
// 因此执行放在代表进程侧（kepos_cli 工具），但每层都有硬约束：
//   - 只启动白名单内的可执行文件，名字来自配置而非调用方。
//   - 参数按白名单里的 argPrefixes 校验，不接受任意组合。
//   - 只注入该 CLI 指定的那一个环境变量，其余一律不传。
//   - 会话绑定到授权：任务结束，会话一律终止。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { clampTurnOutput, cliTurnFile, renderCliTurn } from './cli-dialog.ts';
import { existsSync, readdirSync } from 'node:fs';

/** 该 CLI 已有多少份回合记录：下一个序号即在其后追加。 */
function nextTurn(archiveRoot: string, cli: string): number {
  const safe = String(cli).replace(/[^a-z0-9-]/gi, '').toLowerCase();
  try { return readdirSync(archiveRoot).filter(name => name.startsWith(`cli-${safe}-`) && name.endsWith('.md')).length + 1; }
  catch { return 1; }
}
import { join } from 'node:path';
import type { CliAllowEntry } from './store.ts';

export type CliSession = {
  /** 会话 id：代表用它区分多个并发对话。 */
  id: string;
  cli: string;
  /** 外部 CLI 进程。 */
  child: ChildProcess;
  startedAt: number;
  /** 累计输出（截断后）。 */
  output: string;
  exited: boolean;
  exitCode?: number;
  error?: string;
};

export type CliSpawnResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string };

/** 参数安全校验：必须匹配某个允许的前缀，且不能夹带 shell 语义。 */
export function validateArgs(args: readonly unknown[], prefixes: readonly string[]): { ok: true; args: string[] } | { ok: false; reason: string } {
  const out: string[] = [];
  for (const raw of args) {
    const arg = String(raw ?? '');
    if (!arg) continue;
    if (arg.length > 2000) return { ok: false, reason: '参数过长（上限 2000 字符）' };
    // 换行永远拒绝：它能把一个参数变成两条命令。
    if (/[\r\n]/.test(arg)) return { ok: false, reason: '参数不能含换行' };
    // 只拒绝真正的 shell 控制位：
    //   $ 和 ` 任何时候都会展开，一律拒绝；
    //   ; | & 只有出现在**开头**或作为分隔符时才危险，参数中间（如箭头 =>）是合法语法；
    //   < > 只有出现在开头时才是重定向。
    if (/[`$]/.test(arg)) return { ok: false, reason: `参数含 shell 展开符，已拒绝：${arg.slice(0, 60)}` };
    if (/^[;&|]/.test(arg) || /[;&|]\s/.test(arg)) return { ok: false, reason: `参数含命令分隔符，已拒绝：${arg.slice(0, 60)}` };
    if (/^[<>]/.test(arg)) return { ok: false, reason: `参数含重定向，已拒绝：${arg.slice(0, 60)}` };
    out.push(arg);
  }
  if (out.length && prefixes.length) {
    const first = out[0];
    const allowed = prefixes.some(prefix => first === prefix || first.startsWith(prefix + '=') || first.startsWith(prefix + ' '));
    if (!allowed) return { ok: false, reason: `首个参数必须以 ${prefixes.join(' / ')} 之一开头；收到：${first}` };
  }
  return { ok: true, args: out };
}

/** 只取该 CLI 指定的环境变量，其余不传。 */
export function isolatedEnv(entry: CliAllowEntry, base: NodeJS.ProcessEnv): Record<string, string> {
  // 运行时必需项：没有它们连可执行文件都找不到。
  const carried: Record<string, string> = {};
  for (const key of ['PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TERM']) {
    const value = base[key];
    if (value !== undefined) carried[key] = value;
  }
  // 凭据只传该 CLI 指定的那一个。
  if (entry.envKey) {
    const value = base[entry.envKey];
    if (value !== undefined && value !== '') carried[entry.envKey] = value;
  }
  return carried;
}

/** 该 CLI 的凭据是否已就绪——总理准备阶段用，避免授权了却跑不起来。 */
export function credentialsReady(entry: CliAllowEntry, base: NodeJS.ProcessEnv): { ok: boolean; reason?: string } {
  if (!entry.envKey) return { ok: true };
  const value = base[entry.envKey];
  return value ? { ok: true } : { ok: false, reason: `缺少环境变量 ${entry.envKey}：请先在你的环境里设置该 CLI 的凭据` };
}

/**
 * 多会话管理器：一个代表可以同时开多个对话，各自独立推进。
 * 会话与任务绑定——任务结束调用 closeAll(taskId)，全部终止。
 */
export class CliSessions {
  private sessions = new Map<string, CliSession & { taskId: string }>();
  private maxPerTask: number;

  constructor(options: { maxPerTask?: number } = {}) {
    this.maxPerTask = Math.max(1, Math.min(8, options.maxPerTask ?? 4));
  }

  list(taskId?: string): CliSession[] {
    const all = [...this.sessions.values()];
    const selected = taskId ? all.filter(item => item.taskId === taskId) : all;
    // 去掉内部字段 taskId：调用方只关心会话本身。
    return selected.map(item => {
      const session: CliSession & { taskId?: string } = { ...item };
      delete session.taskId;
      return session;
    });
  }

  /** 启动一个会话。调用方必须先通过授权与白名单校验。 */
  start(input: { taskId: string; cli: string; entry: CliAllowEntry; args: string[]; cwd: string; env: NodeJS.ProcessEnv; archiveRoot: string }): CliSpawnResult {
    const active = this.list(input.taskId).filter(item => !item.exited).length;
    if (active >= this.maxPerTask) return { ok: false, reason: `该任务已有 ${active} 个进行中的 CLI 会话，上限 ${this.maxPerTask}` };

    const checkedArgs = validateArgs(input.args, input.entry.argPrefixes ?? []);
    if (checkedArgs.ok !== true) return { ok: false, reason: (checkedArgs as { reason: string }).reason };

    const env = isolatedEnv(input.entry, input.env);
    const ready = credentialsReady(input.entry, input.env);
    if (!ready.ok) return { ok: false, reason: String(ready.reason) };

    let child: ChildProcess;
    try {
      // 关键：executable 来自配置的键，不来自调用方拼的字符串；不经过 shell。
      child = spawn(input.cli, checkedArgs.args, { cwd: input.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error: any) {
      return { ok: false, reason: `启动失败：${error?.message || error}` };
    }

    // id 只用可执行名的最后一段：绝对路径里有冒号和分隔符，不能进文件名。
    const base = input.cli.split(/[\/]/).pop() || "cli";
    // 去掉扩展名再清洗：文件名的可辨识部分足够区分会话。
    const bare = base.replace(/.(exe|cmd|bat|sh)$/i, "").replace(/[^A-Za-z0-9._-]/g, "") || "cli";
    const id = `${bare}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const session: CliSession & { taskId: string } = { id, cli: input.cli, child, startedAt: Date.now(), output: '', exited: false, taskId: input.taskId };
    this.sessions.set(id, session);

    const capture = (chunk: Buffer | string) => {
      session.output = (session.output + String(chunk)).slice(-60_000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', (error: Error) => { session.error = error.message; session.exited = true; });
    child.on('close', (code: number | null) => {
      session.exited = true;
      session.exitCode = code ?? undefined;
      // 会话结束后把这一轮写成归档。格式统一走 cli-dialog.renderCliTurn——
      // 此前这里手写了一份几乎相同的 markdown，两份格式会各自漂移，
      // 而回读入口（listCliTurns/readCliTurn）只认其中一种。
      try {
        mkdirSync(input.archiveRoot, { recursive: true });
        // 回合序号按该 CLI 已有文件数递增：同一会话多轮时不能互相覆盖。
        const turn = nextTurn(input.archiveRoot, input.cli);
        const clamped = clampTurnOutput(session.output || '');
        writeFileSync(cliTurnFile(input.archiveRoot, input.cli, turn), renderCliTurn({
          turn, cli: input.cli,
          prompt: `${input.cli} ${checkedArgs.args.join(' ')}`,
          output: clamped.output,
          exitCode: code ?? undefined,
          at: session.startedAt,
          durationMs: Date.now() - session.startedAt,
          ...(clamped.truncated ? { truncated: true } : {}),
          ...(session.error ? { error: session.error } : {}),
        }), 'utf8');
      } catch { /* 归档失败不影响会话本身 */ }
    });
    return { ok: true, sessionId: id };
  }

  /** 向会话写入输入（多轮对话用）。 */
  write(sessionId: string, text: string): { ok: boolean; reason?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: '未知会话' };
    if (session.exited) return { ok: false, reason: '会话已结束' };
    try {
      session.child.stdin?.write(text.endsWith('\n') ? text : text + '\n');
      return { ok: true };
    } catch (error: any) {
      return { ok: false, reason: String(error?.message || error) };
    }
  }

  /** 读会话当前累积输出。 */
  read(sessionId: string): { ok: true; output: string; exited: boolean; exitCode?: number } | { ok: false; reason: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, reason: '未知会话' };
    return { ok: true, output: session.output, exited: session.exited, exitCode: session.exitCode };
  }

  /** 终止一个会话。 */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return;
    try { session.child.kill(); } catch { /* 已退出 */ }
  }

  /** 任务结束：该任务的全部会话一律终止。授权回收的关键一环。 */
  closeAll(taskId: string): number {
    let closed = 0;
    for (const session of this.sessions.values()) {
      if (session.taskId !== taskId) continue;
      if (!session.exited) { try { session.child.kill(); } catch { /* 已退出 */ } closed++; }
    }
    for (const [id, session] of this.sessions) if (session.taskId === taskId && session.exited) this.sessions.delete(id);
    return closed;
  }
}
