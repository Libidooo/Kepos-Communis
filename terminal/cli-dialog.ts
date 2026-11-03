// 外部 CLI 的"对话框"：把一次外部 agent 调用呈现成可追溯的会话记录。
//
// 设计取舍（人类未定，这里给出建议并说明理由）：
//
// 一、不做实时交互式 TUI。外部 CLI（codex / claude）自己带全屏界面，
//    嵌进我们的终端会互相打架：两套键位、两套光标、两套 resize 处理。
//    强行嵌入的收益（看见打字过程）远小于风险（渲染错乱、按键丢失）。
//
// 二、做"回合制对话"。每次调用 = 一个新回合：代表给一段话，CLI 返回一段话，
//    记录成 .kepos/<taskId>/cli-<cli>-<n>.md。这样：
//      - 天然可归档，与其他产出同构
//      - 不需要解析 CLI 的交互协议，只用 stdin/stdout
//      - 代表可以多轮推进（"继续"、"修一下刚才那个"），每轮都是一条记录
//
// 三、代表看到的"对话框"是这个 md 文件的内容摘要，不是实时窗格。
//    书案里单独一栏展示最近的调用：命令、耗时、退出码、输出首尾。
//    完整输出在 md 里，需要时翻页读——与 kepos_worker result 的分页一致。
//
// 四、一次调用是一个"回合"，不是"会话"。外部 CLI 的 --resume / 会话 id
//    各平台不一，强行统一会锁死到某一个 CLI 的实现细节。代表需要连续性时，
//    把上一轮输出作为下一轮的输入上下文即可，这样对所有 CLI 一视同仁。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type CliTurn = {
  /** 第几回合，从 1 开始。 */
  turn: number;
  cli: string;
  /** 代表给外部 CLI 的输入。 */
  prompt: string;
  /** 外部 CLI 的输出（stdout + stderr 合并后截断）。 */
  output: string;
  exitCode?: number;
  durationMs?: number;
  at: number;
  error?: string;
  truncated?: boolean;
};

const MAX_TURN_OUTPUT = 60_000;

/** 回合文件名：task 目录下按 CLI 与序号分开，避免不同 CLI 的回合混在一起。 */
export function cliTurnFile(archiveRoot: string, cli: string, turn: number): string {
  const safe = String(cli).replace(/[^a-z0-9-]/gi, '').toLowerCase();
  return join(archiveRoot, `cli-${safe}-${String(turn).padStart(3, '0')}.md`);
}

/** 把一次调用写成可读的回合记录。 */
export function renderCliTurn(turn: CliTurn): string {
  const header = [
    `# 外部 CLI 回合 ${turn.turn} · ${turn.cli}`,
    '',
    `- 时间：${new Date(turn.at).toISOString()}`,
    `- 退出码：${turn.exitCode ?? '—'}`,
    `- 耗时：${turn.durationMs !== undefined ? `${turn.durationMs}ms` : '—'}`,
    ...(turn.error ? [`- 错误：${turn.error}`] : []),
    ...(turn.truncated ? ['- 注意：输出过长，已截断保留首尾'] : []),
    '',
    '## 输入',
    '',
    '```text',
    turn.prompt,
    '```',
    '',
    '## 输出',
    '',
    '```text',
    turn.output || '（无输出）',
    '```',
    '',
  ];
  return header.join('\n');
}

/** 输出过长时保留首尾——中间通常是重复的进度刷屏。 */
export function clampTurnOutput(text: string, max = MAX_TURN_OUTPUT): { output: string; truncated: boolean } {
  const value = String(text ?? '');
  if (value.length <= max) return { output: value, truncated: false };
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return { output: `${value.slice(0, head)}\n\n… [输出过长，中间已省略] …\n\n${value.slice(-tail)}`, truncated: true };
}

/** 列出某任务的全部 CLI 回合，按序号升序。 */
export function listCliTurns(archiveRoot: string): Array<{ cli: string; turn: number; file: string }> {
  if (!existsSync(archiveRoot)) return [];
  const turns: Array<{ cli: string; turn: number; file: string }> = [];
  for (const name of readdirSync(archiveRoot)) {
    const match = /^cli-([a-z0-9-]+)-(\d+)\.md$/i.exec(name);
    if (match) turns.push({ cli: match[1], turn: Number(match[2]), file: join(archiveRoot, name) });
  }
  return turns.sort((a, b) => a.cli.localeCompare(b.cli) || a.turn - b.turn);
}

/** 书案里展示这一行的摘要：命令、状态、耗时，不含正文。 */
export function summarizeCliTurn(turn: CliTurn): string {
  const status = turn.error ? `✕ ${turn.error.slice(0, 40)}` : turn.exitCode === 0 ? '✓' : `退出码 ${turn.exitCode ?? '—'}`;
  const elapsed = turn.durationMs !== undefined ? ` · ${(turn.durationMs / 1000).toFixed(1)}s` : '';
  const firstLine = String(turn.output || '').trim().split('\n')[0]?.slice(0, 60) || '（无输出）';
  return `回合 ${turn.turn} · ${turn.cli} · ${status}${elapsed} · ${firstLine}`;
}

/** 读回一个回合的正文（供分页展示）。 */
export function readCliTurn(file: string): string {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}
