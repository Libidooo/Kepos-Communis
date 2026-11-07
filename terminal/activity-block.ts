// 回复流内的"活体状态行"：点阵波纹 + 随总理动作变化的品牌动词 + 可折叠执行轨迹。
//
// 设计语言移植自 reactbits.dev 的 LatticeLoader（3×3 ripple 点阵、settle 时点阵化作
// ✓/✕ 定格）与 ThoughtLine（steps 轨迹、settle 收拢）。终端没有透明度与缓动，
// 用字形层级（●/· 配 accent/dim）和 150ms 的重绘节拍表达同一动效；
// prefers-reduced-motion 的对应物是 config.motion=false：点阵静止为 ●·●。
//
// 位置约定：本模块只产出**纯文本行**，着色由 desk（唯一持有 theme 的一方）按行首
// 字形套色；注入点在 `◆ Kepos 总理` 名牌之下、回复正文之前（人类的裁定：状态不待
// 在最底下，要跟着回复流走）。
import { truncateToWidth } from '@earendil-works/pi-tui';

export type ActivityState = 'working' | 'done' | 'aborted' | 'error';
/** 总理此刻主要动作的信号：思考、起草正文，或某个工具在跑。 */
export type ActivitySignal = { kind: 'think' } | { kind: 'text' } | { kind: 'tool'; tool: string };
export type TraceStep = {
  kind: 'tool' | 'think';
  tool?: string;
  started: number;
  ended?: number;
  isError?: boolean;
  detail?: string;
};

/** 品牌动词：案卷/议事/结论——Kepos 的议会语汇，不写"调用工具 x"这种实现腔。 */
const THINK_VERB = '正在梳理思路';
const TEXT_VERB = '正在起草结论';
const TOOL_VERBS: ReadonlyArray<[RegExp, string]> = [
  [/^(read|grep|find|ls|glob)/i, '正在翻阅案卷'],
  [/^(bash|powershell)/i, '正在执行操作'],
  [/^(edit|write)/i, '正在落笔成文'],
  [/^kepos_(delegate|plan|spawn|grant|workflow)/i, '正在分派议事'],
  [/^kepos_(vote|group)/i, '正在征询意见'],
];
const TOOL_FALLBACK = '正在办理事务';

export function verbFor(signal: ActivitySignal | undefined): string {
  if (!signal) return THINK_VERB;
  if (signal.kind === 'think') return THINK_VERB;
  if (signal.kind === 'text') return TEXT_VERB;
  for (const [pattern, verb] of TOOL_VERBS) if (pattern.test(signal.tool)) return verb;
  return TOOL_FALLBACK;
}

/** 轨迹步骤的短名（不带"正在"——已完成的事用完成语态）。 */
const TOOL_SHORT: ReadonlyArray<[RegExp, string]> = [
  [/^(read|grep|find|ls|glob)/i, '翻阅案卷'],
  [/^(bash|powershell)/i, '执行操作'],
  [/^(edit|write)/i, '落笔成文'],
  [/^kepos_(delegate|plan|spawn|grant|workflow)/i, '分派议事'],
  [/^kepos_(vote|group)/i, '征询意见'],
];
export const toolShort = (tool: string): string => {
  for (const [pattern, label] of TOOL_SHORT) if (pattern.test(tool)) return label;
  return '办理事务';
};

/** 步骤摘要：路径取文件名、命令截 40 字符、模式串带引号——人扫一眼就知道干了什么。 */
export function stepDetail(tool: string, args: any): string | undefined {
  const a = args && typeof args === 'object' ? args : {};
  const path = typeof a.path === 'string' ? a.path : typeof a.file_path === 'string' ? a.file_path : undefined;
  if (path) return path.split(/[\\/]/).pop() || path;
  if (typeof a.command === 'string' && a.command.trim()) return a.command.trim().slice(0, 40);
  if (typeof a.pattern === 'string' && a.pattern.trim()) return `「${a.pattern.trim().slice(0, 24)}」`;
  try {
    const s = JSON.stringify(a);
    return s && s !== '{}' ? s.slice(0, 40) : undefined;
  } catch {
    return undefined;
  }
}

export function stepLabel(step: TraceStep): string {
  if (step.kind === 'think') return step.ended ? '思路已整理' : '正在梳理思路';
  return `${toolShort(step.tool || '')}${step.detail ? ` ${step.detail}` : ''}`;
}

/**
 * 3 格点阵 ripple：LatticeLoader 的 3×3 ripple（中心先亮）水平化 → 延迟 [1,0,1]。
 * 四拍一周、亮两拍；至少保证一格常亮——全暗的拍点会被误认成渲染缺口。
 * settle 定格：done ✓（success）/error ✕（error）/aborted ◼（warning），由调用方套色。
 */
const DELAYS = [1, 0, 1];
const STEP_MS = 150;
const CYCLE = 4;
export function latticeCells(state: ActivityState, now: number, startedAt: number, motion = true): { text: string; token: string } {
  if (state === 'done') return { text: '✓', token: 'success' };
  if (state === 'error') return { text: '✕', token: 'error' };
  if (state === 'aborted') return { text: '◼', token: 'warning' };
  if (!motion) return { text: '●·●', token: 'accent' };
  const phase = Math.floor((now - (startedAt || now)) / STEP_MS);
  const cells = DELAYS.map(d => {
    const t = ((phase - d) % CYCLE + CYCLE) % CYCLE;
    return t < 2 ? '●' : '·';
  });
  if (!cells.includes('●')) cells[1] = '●';
  return { text: cells.join(''), token: 'accent' };
}

/** 计时：3.2s → 1m04.3s（分位补零，等宽对齐）。 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${(s - m * 60).toFixed(1).padStart(4, '0')}s`;
}

const STATE_LABEL: Record<ActivityState, string> = { working: '', done: '已完成', aborted: '已中止', error: '失败' };
const MAX_TRACE_ROWS = 6;

/**
 * 状态行 + 可选轨迹。纯文本输出；行首字形约定（调用方据此套色、据此响应点击）：
 *   状态行：工作中以点阵开头（●/· 三连），settle 后以 ✓/✕/◼ + 空格开头；
 *   轨迹行：三空格缩进 + ✓/✕/┊；`… 共 N 步` 为溢出提示。
 */
export function renderActivityBlock(input: {
  state: ActivityState;
  ms?: number;
  signal?: ActivitySignal;
  steps: TraceStep[];
  open: boolean;
  width: number;
  now: number;
  startedAt: number;
  motion?: boolean;
}): string[] {
  const { state, ms, signal, steps, open, width, now, startedAt } = input;
  const cells = latticeCells(state, now, startedAt, input.motion !== false);
  const total = steps.length;
  const chevron = total > 0 ? `${open ? '▾' : '▸'} ${total} 步` : '';
  const head = state === 'working'
    ? `${cells.text} ${verbFor(signal)}${chevron ? `  ${chevron}` : ''}`
    : `${cells.text} ${STATE_LABEL[state]}${ms !== undefined ? ` · ${formatElapsed(ms)}` : ''}${chevron ? `  ${chevron}` : ''}`;
  const lines = [head];
  if (open && total) {
    if (total > MAX_TRACE_ROWS) lines.push(`   … 共 ${total} 步`);
    for (const step of steps.slice(-MAX_TRACE_ROWS)) {
      const dur = step.ended !== undefined ? ` · ${formatElapsed(step.ended - step.started)}` : '';
      const mark = step.ended !== undefined ? (step.isError ? '✕' : '✓') : '┊';
      lines.push(`   ${mark} ${stepLabel(step)}${step.ended === undefined ? ' …' : ''}${dur}`);
    }
  }
  return lines.map(line => truncateToWidth(line, Math.max(8, width)));
}
