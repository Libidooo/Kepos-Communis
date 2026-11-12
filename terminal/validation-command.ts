import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Only named project checks are executable through this capability. */
export const PROJECT_CHECKS = ['test', 'typecheck', 'build', 'lint', 'check'] as const;
export type ProjectCheck = typeof PROJECT_CHECKS[number];

export const PROJECT_CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 60_000;

export type ProjectCheckInfo = {
  check: ProjectCheck;
  cwd: string;
  packageJson: string;
  packageHash: string;
  script: string;
  command: string;
};

export type ProjectCheckResult = {
  ok: boolean;
  check: ProjectCheck;
  command: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated: boolean;
  output: string;
  error?: string;
};

function isProjectCheck(value: unknown): value is ProjectCheck {
  return typeof value === 'string' && (PROJECT_CHECKS as readonly string[]).includes(value);
}

/** Resolve only conventional package scripts; callers cannot supply executable names or arguments. */
export function inspectProjectCheck(cwd: string, requested: unknown): ProjectCheckInfo | { error: string } {
  if (!isProjectCheck(requested)) return { error: `只支持这些项目验证项：${PROJECT_CHECKS.join(' / ')}` };
  let projectRoot: string;
  try { projectRoot = realpathSync(resolve(cwd)); }
  catch { return { error: '项目目录不存在或无法解析' }; }
  const packageJson = join(projectRoot, 'package.json');
  if (!existsSync(packageJson)) return { error: '项目根目录没有 package.json；当前验证器只支持 Node/npm 项目' };
  let parsed: any;
  let source: string;
  try {
    source = readFileSync(packageJson, 'utf8');
    parsed = JSON.parse(source);
  } catch (error) { return { error: `无法读取有效的 package.json：${String((error as Error)?.message || error).slice(0, 200)}` }; }
  const script = parsed?.scripts?.[requested];
  if (typeof script !== 'string' || !script.trim()) return { error: `package.json 没有 scripts.${requested}，未运行任何命令` };
  if (script.length > 4000) return { error: `scripts.${requested} 超过 4000 字符，拒绝自动运行` };
  return {
    check: requested,
    cwd: projectRoot,
    packageJson,
    packageHash: createHash('sha256').update(source).digest('hex'),
    script,
    command: `npm run --ignore-scripts ${requested}`,
  };
}

function boundedOutput(value: string): { output: string; truncated: boolean } {
  if (value.length <= MAX_OUTPUT_CHARS) return { output: value, truncated: false };
  const head = Math.floor(MAX_OUTPUT_CHARS * 0.7);
  return { output: `${value.slice(0, head)}\n\n… [中间输出已截断] …\n\n${value.slice(-(MAX_OUTPUT_CHARS - head))}`, truncated: true };
}

function validationEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const env: NodeJS.ProcessEnv = {};
  // Keep only variables required to locate the runtime and write temporary files.
  // API tokens, cloud credentials, and application secrets are intentionally omitted.
  for (const key of [
    'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
    'LANG', 'LC_ALL', 'TERM',
  ]) if (base[key] !== undefined) env[key] = base[key];
  env.CI = '1';
  env.NO_COLOR = '1';
  env.npm_config_offline = 'true';
  env.npm_config_ignore_scripts = 'true';
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  env.npm_config_update_notifier = 'false';
  const userConfig = join(tmpdir(), `kepos-check-${randomUUID()}-user.npmrc`);
  const globalConfig = join(tmpdir(), `kepos-check-${randomUUID()}-global.npmrc`);
  writeFileSync(userConfig, '', { mode: 0o600 });
  writeFileSync(globalConfig, '', { mode: 0o600 });
  env.npm_config_userconfig = userConfig;
  env.npm_config_globalconfig = globalConfig;
  return { env, cleanup: () => { try { unlinkSync(userConfig); } catch {} try { unlinkSync(globalConfig); } catch {} } };
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `taskkill /PID ${child.pid} /T /F`], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch { child.kill('SIGTERM'); }
  const force = setTimeout(() => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 1500);
  force.unref?.();
}

/**
 * Run a pre-existing, named npm script with fixed arguments and a scrubbed environment.
 * The package script itself is project code and may launch subprocesses; the principal
 * must inspect it before approving. This is a validation capability, not an OS sandbox.
 */
export async function runProjectCheck(input: {
  info: ProjectCheckInfo;
  expectedPackageHash: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  shouldContinue?: () => boolean;
}): Promise<ProjectCheckResult> {
  const current = inspectProjectCheck(input.info.cwd, input.info.check);
  const started = (input.now || Date.now)();
  const startedAt = new Date(started).toISOString();
  if ('error' in current) {
    return { ok: false, check: input.info.check, command: input.info.command, cwd: input.info.cwd, startedAt, endedAt: new Date((input.now || Date.now)()).toISOString(), durationMs: 0, truncated: false, output: '', error: current.error };
  }
  if (current.packageHash !== input.expectedPackageHash || current.packageHash !== input.info.packageHash) {
    return { ok: false, check: input.info.check, command: input.info.command, cwd: input.info.cwd, startedAt, endedAt: new Date((input.now || Date.now)()).toISOString(), durationMs: 0, truncated: false, output: '', error: 'package.json 在审批后发生变化；拒绝执行，请重新申请并重新评估脚本' };
  }
  const timeoutMs = Math.max(1000, Math.min(PROJECT_CHECK_TIMEOUT_MS, Math.floor(input.timeoutMs ?? PROJECT_CHECK_TIMEOUT_MS)));
  const isolated = validationEnv(input.env || process.env);
  const env = isolated.env;
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', `npm run --ignore-scripts ${input.info.check}`]
    : ['run', '--ignore-scripts', input.info.check];
  const executable = process.platform === 'win32' ? (env.COMSPEC || 'cmd.exe') : 'npm';
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      cwd: input.info.cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    isolated.cleanup();
    const ended = (input.now || Date.now)();
    return { ok: false, check: input.info.check, command: input.info.command, cwd: input.info.cwd, startedAt, endedAt: new Date(ended).toISOString(), durationMs: ended - started, truncated: false, output: '', error: String((error as Error)?.message || error).slice(0, 500) };
  }
  let output = '';
  let errorText = '';
  let timedOut = false;
  let cancelled = false;
  const capture = (chunk: Buffer | string) => { output = (output + String(chunk)).slice(-MAX_OUTPUT_CHARS * 2); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('error', error => { errorText = String(error.message || error).slice(0, 500); });
  const timer = setTimeout(() => { timedOut = true; killProcessTree(child); }, timeoutMs);
  timer.unref?.();
  const cancelTimer = setInterval(() => {
    if (!cancelled && input.shouldContinue && !input.shouldContinue()) { cancelled = true; killProcessTree(child); }
  }, 500);
  cancelTimer.unref?.();
  const exitCode = await new Promise<number | undefined>(resolveExit => {
    child.once('close', code => resolveExit(code === null ? undefined : code));
  }).finally(() => { clearTimeout(timer); clearInterval(cancelTimer); isolated.cleanup(); });
  const ended = (input.now || Date.now)();
  const clipped = boundedOutput(output);
  return {
    ok: !errorText && !timedOut && !cancelled && exitCode === 0,
    check: input.info.check,
    command: input.info.command,
    cwd: input.info.cwd,
    startedAt,
    endedAt: new Date(ended).toISOString(),
    durationMs: Math.max(0, ended - started),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    ...(cancelled ? { cancelled: true } : {}),
    truncated: clipped.truncated,
    output: clipped.output,
    ...(errorText ? { error: errorText } : {}),
  };
}
