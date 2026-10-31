import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { TASK_ACTIVE_STATES, isTaskActive, isTaskCurrent, isTaskPending, taskElapsedText, taskState, type TaskStateLike } from './task-state.ts';

export type GraphViewAgent = { id: string; name: string; model?: string; roleKey?: string };
export type GraphViewTask = TaskStateLike & { id: string; agent: string; agentId?: string; purpose?: 'delegation' | 'configuration'; internal?: boolean; title?: string; tool?: string; checkpoint?: string; output?: string; parentWorkerId?: string; delegationDepth?: number; error?: string; groupKey?: string };
export type GraphViewSnapshot = { agents: GraphViewAgent[]; tasks: GraphViewTask[] };
export type GraphHit = { id: string; kind: 'main' | 'agent' | 'task'; index: number; x: number; y: number; taskId?: string };
export type GraphOffsets = Record<string, { x: number; y: number }>;
export type CouncilFilter = 'active' | 'pending' | 'all';
export type CouncilView = { list: boolean; filter: CouncilFilter; query: string; index: number; focus?: 'ring' | 'list' | 'input'; desk?: boolean };
type Cell = { char: string; color?: string };
type VisualNode = { id: string; label: string; kind: 'agent' | 'task'; task?: GraphViewTask; groupKey: string; x: number; y: number; index: number };
// 活跃=正在执行；NEEDS_HUMAN 归入“待处理”。终态残留的复核/停滞标记不再报警。
export const activeStates = TASK_ACTIVE_STATES;
export const countActive = (tasks: GraphViewTask[]) => tasks.filter(isTaskActive).length;
export const countPending = (tasks: GraphViewTask[]) => tasks.filter(isTaskPending).length;
const filterName = (filter: CouncilFilter) => filter === 'active' ? '活跃' : filter === 'pending' ? '待处理' : '全部';
// 待审批符号与 desk 徽章、F1 帮助文案保持一致。
export const stateMark = (task: GraphViewTask) => {
  const state = taskState(task);
  return state === 'FAILED' ? '✕' : state === 'SUCCEEDED' ? '✓' : state === 'NEEDS_HUMAN' ? '⚠' : isTaskPending(task) ? '!' : isTaskActive(task) ? '▶' : '·';
};
// 议会任务列表的统一筛选：图负责关系与态势，列表负责从问题找到具体任务。
export function councilTasks(snapshot: GraphViewSnapshot, filter: CouncilFilter, query: string): GraphViewTask[] {
  const q = query.trim();
  return (snapshot.tasks || []).filter(task => {
    if (filter === 'active' && !activeStates.has(task.state || '')) return false;
    if (filter === 'pending' && !(task.state === 'NEEDS_HUMAN' || task.reviewDue)) return false;
    if (q && !plain(task.title || '').includes(q) && !plain(task.agent).includes(q)) return false;
    return true;
  });
}
// 先剥完整 ANSI 序列再剥控制符：任务标题里的 [0m 残片曾以字面量漏进界面。
const plain = (value: unknown) => stripVTControlCharacters(String(value ?? '')).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ');
// 写进字符网格的文本必须用这个截断器：pi-tui 的 truncateToWidth 在真正截断处会插入
// \x1b[0m，而 put() 是逐字符建格的——ESC 会占掉一格，剩下的 "[0m" 就成了可见乱码
// （48 席里所有 6 字以上的角色名都会中招）。这里按可见宽度手裁，绝不产生转义序列。
const cut = (value: unknown, width: number): string => {
  const text = plain(value);
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;
  const ellipsis = width >= 2 ? '…' : '';
  const budget = width - visibleWidth(ellipsis);
  let result = '';
  let used = 0;
  for (const char of text) {
    const charWidth = Math.max(1, visibleWidth(char));
    if (used + charWidth > budget) break;
    result += char;
    used += charWidth;
  }
  return result + ellipsis;
};
// htop 式对齐列：状态/代表名定宽补齐，标题吃剩余宽度。
const padCell = (value: string, width: number) => { const text = cut(value, width); return text + ' '.repeat(Math.max(0, width - visibleWidth(text))); };

// teal/blue/mauve exist only as kepos-dark vars; Pi's theme.fg rejects them, so emit them directly.
const directColors: Record<string, string> = { approval: '1;38;2;255;223;84', queue: '38;2;157;126;76', idle: '38;2;116;139;129', teal: '38;2;142;181;173', blue: '38;2;153;172;187', mauve: '38;2;181;160;173' };
const palette = ['teal', 'blue', 'mauve', 'accent'];
export const stateColor = (task: GraphViewTask | undefined, index: number) => {
  if (!task) return 'muted';
  if (task.state === 'NEEDS_HUMAN') return 'approval';
  if (task.state === 'FAILED' || task.status === '失败') return 'error';
  if (task.state === 'SUCCEEDED' || task.status === '完成') return 'success';
  if (['CANCELLED', 'INTERRUPTED', 'TIMED_OUT'].includes(task.state || '')) return 'dim';
  if (task.state === 'QUEUED' || task.state === 'STARTING') return 'queue';
  // 运行中没有专用状态色：用分组色表达“属于哪一组”，状态由符号与中文表达。
  return groupColor(task, index);
};
// 名字跟随席位状态色：配色是敲定的语义，符号与名字同色，不要拆成两档明度。
export const stateNameColor = stateColor;
// 席位符号：字符携带状态，不加额外文字。
// 就绪 ◌ 最虚；待审批沿用敲定语义——黄色运行态 + 席位中间的 !（见下方渲染）。
// 其余按实心程度递减：运行 ◉/◎ 呼吸，排队 ◔，完成 ●，失败 ⊘，取消 ○。
// 只有运行中的席位在两帧之间变化，动效只用来指认"正在发生的事"。
export const seatGlyph = (task: GraphViewTask | undefined, selected: boolean, now: number): string => {
  if (selected) return '▣';
  if (!task) return '◌';
  const state = taskState(task);
  if (state === 'FAILED') return '⊘';
  if (state === 'SUCCEEDED') return '●';
  if (['CANCELLED', 'INTERRUPTED', 'TIMED_OUT'].includes(state || '')) return '○';
  if (state === 'QUEUED' || state === 'STARTING') return '◔';
  // NEEDS_HUMAN 与 RUNNING 一样是"活的"：都走呼吸，颜色与 ! 区分二者。
  return Math.floor(now / 700) % 2 ? '◉' : '◎';
};
export const groupColor = (task: GraphViewTask | undefined, _index = 0) => {
  if (!task) return 'muted';
  const group = task.groupKey || task.parentWorkerId || task.agent;
  const hash = [...group].reduce((value, char) => value + char.charCodeAt(0), 0);
  return palette[hash % palette.length];
};

// 连线使用方向位掩码：每个格子记录哪几边有连线，渲染时再选 ├ ┤ ┬ ┴ ┼ 或直线。
// 旧实现遇到交叉直接塞 ┼ 并覆盖颜色，两条不同分组的线相交后归属就丢了。
const N = 1, S = 2, W = 4, E = 8;
const junctionChar = (mask: number): string => {
  const table: Record<number, string> = {
    [N | S]: '│', [W | E]: '─',
    [N | E]: '└', [N | W]: '┘', [S | E]: '┌', [S | W]: '┐',
    [N | S | E]: '├', [N | S | W]: '┤', [N | W | E]: '┴', [S | W | E]: '┬',
    [N | S | W | E]: '┼',
  };
  return table[mask] || '·';
};

/** 沿一个轴推进，把双向位掩码记到每一个经过的格子上（含终点反向位）。 */
function stampAxis(mask: (number | undefined)[][], color: string, from: number, to: number, fixed: number, vertical: boolean, forward: number, backward: number) {
  const step = to > from ? 1 : -1;
  for (let p = from; p !== to; p += step) {
    const y = vertical ? p : fixed, x = vertical ? fixed : p;
    if (mask[y]?.[x] !== undefined) mask[y][x] = (mask[y][x] ?? 0) | forward;
    const nextY = vertical ? p + step : fixed, nextX = vertical ? fixed : p + step;
    if (mask[nextY]?.[nextX] !== undefined) mask[nextY][nextX] = (mask[nextY][nextX] ?? 0) | backward;
  }
}

/** 在网格上记录一条正交线段（先竖后横），让相邻格共享入/出边。 */
function stamp(grid: Cell[][], mask: (number | undefined)[][], x0: number, y0: number, x1: number, y1: number, color: string) {
  // 先沿 y 走到目标行，再横向对齐：起点只带一个方向，不会长成 └ ┘ 这类转角。
  stampAxis(mask, color, y0, y1, x0, true, y1 > y0 ? S : N, y1 > y0 ? N : S);
  stampAxis(mask, color, x0, x1, y1, false, x1 > x0 ? E : W, x1 > x0 ? W : E);
  // 线段经过的格子记下归属色，渲染时按 cell.color 输出。
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      if (grid[y]?.[x] && !grid[y][x].color) grid[y][x].color = color;
    }
  }
}

function renderConnections(grid: Cell[][], mask: (number | undefined)[][], color: string) {
  for (let y = 0; y < mask.length; y++) {
    for (let x = 0; x < (mask[y]?.length ?? 0); x++) {
      const bits = mask[y][x];
      if (!bits) continue;
      const cell = grid[y]?.[x];
      if (!cell || cell.char !== ' ') continue;
      grid[y][x] = { char: junctionChar(bits), color };
    }
  }
}

function line(grid: Cell[][], x0: number, y0: number, x1: number, y1: number, color: string) {
  // 仅用于诊断和未来需要斜线的场景；当前连线走 stamp + 位掩码的正交路径。
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  const stroke = dx > -dy * 2 ? '─' : -dy > dx * 2 ? '│' : sx === sy ? '╲' : '╱';
  let error = dx + dy, x = x0, y = y0;
  for (;;) {
    const cell = grid[y]?.[x];
    if (cell?.char === ' ') grid[y][x] = { char: stroke, color };
    if (x === x1 && y === y1) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}

function put(grid: Cell[][], x: number, y: number, text: string, color?: string) {
  // 唯一网格入口必须自净：任何调用者漏传了转义序列或控制符，都在这里被剥掉，
  // 绝不能把 ESC 当成一个可见字符格写进画面。
  let column = x;
  for (const char of plain(text)) {
    // 全角字符占两格，第二格留空由 colorize 跳过，宽度账才对得上。
    const width = Math.max(1, visibleWidth(char));
    if (grid[y]?.[column]) grid[y][column] = { char, color };
    for (let offset = 1; offset < width; offset++) if (grid[y]?.[column + offset]) grid[y][column + offset] = { char: '', color };
    column += width;
  }
}
function colorize(row: Cell[], theme: any): string {
  return row.map(cell => {
    if (!cell.char) return '';
    if (cell.char === ' ') return ' ';
    const direct = directColors[cell.color || ''];
    return direct ? `\x1b[${direct}m${cell.char}\x1b[${cell.color === 'approval' ? 0 : 39}m` : theme.fg(cell.color || 'text', cell.char);
  }).join('');
}

function bubble(grid: Cell[][], node: VisualNode, width: number, height: number) {
  const boxWidth = Math.min(38, width - 2), inner = boxWidth - 4;
  const x = width >= 120 ? width - boxWidth - 2 : node.x + boxWidth + 2 < width ? node.x + 2 : Math.max(0, node.x - boxWidth - 1);
  const y = Math.max(0, Math.min(height - 8, node.y - 3));
  const task = node.task;
  const rows = [
    ` ${node.label}  ·  ${task?.status || task?.state || '未分配'}`,
    `书案 ${task?.title || '尚未分配书案'}`,
    `工具 ${task?.tool || '—'}`,
    `进度 ${task?.checkpoint || '—'}`,
    `输出 ${task?.output || '等待结果'}`,
    'Esc 关闭详情 · F6 切到输入可发送',
  ];
  put(grid, x, y, '╭' + '─'.repeat(boxWidth - 2) + '╮', 'accent');
  rows.forEach((row, index) => {
    const content = cut(row, inner);
    put(grid, x, y + index + 1, '│ ' + content + ' '.repeat(Math.max(0, inner - visibleWidth(content))) + ' │', index === 0 ? 'accent' : 'text');
  });
  put(grid, x, y + 7, '╰' + '─'.repeat(boxWidth - 2) + '╯', 'accent');
}

// 右侧常驻面板：框线容器 + 计数、可筛选任务列表、选中详情。列表负责寻找，详情负责判断和行动。
// 议会简要：右上角动态高度卡片，只框住实际内容，不再拖一整列空框。
function sidebar(grid: Cell[][], snapshot: GraphViewSnapshot, selected: VisualNode | undefined, width: number, height: number, now: number, council?: CouncilView) {
  // 书案打开时右侧被书案面板占据，议会简要让位。
  if (width < 120 || council?.desk) return;
  const x = width - 38, labelX = x + 2, labelWidth = 32, right = width - 1;
  const focused = council?.focus === 'list';
  const frameColor = focused ? 'borderAccent' : 'borderMuted';
  const active = countActive(snapshot.tasks);
  const attention = countPending(snapshot.tasks);
  type Row = { text: string; color: string } | 'div';
  const rows: Row[] = [
    { text: `活跃 ${active}`, color: 'accent' },
    { text: `待处理 ${attention}`, color: attention ? 'warning' : 'dim' },
    'div',
  ];
  if (council?.list) {
    const filtered = councilTasks(snapshot, council.filter, council.query);
    rows.push({ text: `${council.query ? `“${council.query}” · ` : ''}${filterName(council.filter)}任务 · F8 换筛选`, color: council.filter === 'pending' && attention ? 'warning' : 'accent' });
    if (!filtered.length) rows.push({ text: '  没有匹配的任务', color: 'dim' });
    const detailRows = 7;
    const visible = Math.max(1, Math.min(filtered.length, Math.max(1, height - rows.length - detailRows - 3)));
    const start = Math.max(0, Math.min(council.index - Math.floor(visible / 2), Math.max(0, filtered.length - visible)));
    for (let i = start; i < Math.min(filtered.length, start + visible); i++) {
      const task = filtered[i];
      rows.push({ text: `${i === council.index ? '›' : ' '}${stateMark(task)} ${padCell(task.status || task.state || '—', 8)} ${padCell(task.agent, 8)} ${cut(task.title || '', labelWidth - 20)}`, color: i === council.index ? 'accent' : stateColor(task, i) });
    }
    if (filtered.length > visible) rows.push({ text: `  ${Math.min(filtered.length, start + visible)}/${filtered.length} · ↑↓ 选择`, color: 'dim' });
    rows.push('div');
  }
  const task = selected?.task;
  rows.push({ text: task ? `${plain(selected!.label)} 书案` : selected ? `选中 ${plain(selected.label)}` : '选中 总理', color: 'accent' });
  if (task) {
    const elapsed = task.started ? Math.max(0, Math.round((now - task.started) / 1000)) + 's' : '—';
    rows.push({ text: `状态 ${task.status || task.state || '—'} · ${elapsed}`, color: stateColor(task, selected!.index) });
    if (task.tool) rows.push({ text: `工具 ${cut(task.tool, labelWidth - 3)}`, color: 'dim' });
    if (task.checkpoint) rows.push({ text: `进展 ${cut(task.checkpoint, labelWidth - 3)}`, color: 'dim' });
    rows.push({ text: `输出 ${cut(task.output || '等待结果', labelWidth - 3)}`, color: 'text' });
    rows.push({ text: 'Enter 详情 · Ctrl+X 取消 · v 完整输出', color: 'dim' });
  } else {
    rows.push({ text: selected ? '尚无书案' : '总理 · Enter 输入目标', color: 'dim' });
    rows.push({ text: 'Enter 详情 · 单击选中坐席', color: 'dim' });
  }
  rows.push('div', { text: '拖动 · 滚轮缩放 · F10 返回', color: 'dim' });
  // 卡片高度贴合内容。
  const cardH = Math.min(height, rows.length + 2);
  const title = '─ 议会简要 ';
  const titleWidth = visibleWidth(title);
  const fill = Math.max(1, (right - x - 2) - titleWidth);
  put(grid, x, 0, '╭' + title, focused ? 'accent' : 'borderAccent');
  for (let cx = x + titleWidth + 1; cx < right; cx++) put(grid, cx, 0, '─', frameColor);
  put(grid, right, 0, '╮', frameColor);
  for (let y = 1; y < cardH - 1; y++) { put(grid, x, y, '│', frameColor); put(grid, right, y, '│', frameColor); }
  put(grid, x, cardH - 1, '╰', frameColor);
  for (let cx = x + 1; cx < right; cx++) put(grid, cx, cardH - 1, '─', frameColor);
  put(grid, right, cardH - 1, '╯', frameColor);
  rows.forEach((row, index) => {
    const y = index + 1;
    if (y >= cardH - 1) return;
    if (row === 'div') { put(grid, x, y, '├', frameColor); for (let cx = x + 1; cx < right; cx++) put(grid, cx, y, '─', frameColor); put(grid, right, y, '┤', frameColor); return; }
    put(grid, labelX, y, cut(row.text, labelWidth), row.color);
  });
}

// 窄屏没有 sidebar 空间：列表+详情占满画面，环图仍可主动打开（Tab）。
export function renderCouncilList(tasks: GraphViewTask[], width: number, height: number, index: number, theme: any): { rows: string[]; taskId: string | null } {
  const safeWidth = Math.max(24, width), safeHeight = Math.max(3, height);
  const visible = Math.max(1, safeHeight - 2);
  const start = Math.max(0, Math.min(index - Math.floor(visible / 2), Math.max(0, tasks.length - visible)));
  const rows = [theme.fg('accent', truncateToWidth(`任务列表 · ${tasks.length} 项 · ↑↓ 选择 · Enter 详情 · v 完整输出 · Tab 回环图`, safeWidth))];
  for (let i = start; i < Math.min(tasks.length, start + visible); i++) {
    const task = tasks[i];
    rows.push(theme.fg(i === index ? 'accent' : stateColor(task, i), truncateToWidth(`${i === index ? '›' : ' '}${stateMark(task)} ${padCell(task.status || task.state || '—', 8)} ${padCell(task.agent, 8)} ${plain(task.title || '—')}`, safeWidth)));
  }
  if (tasks.length > visible) rows.push(theme.fg('muted', truncateToWidth(`  ${Math.min(tasks.length, start + visible)}/${tasks.length}`, safeWidth)));
  return { rows, taskId: tasks[Math.min(index, tasks.length - 1)]?.id ?? null };
}

function makeNodes(snapshot: GraphViewSnapshot): VisualNode[] {
  const agents = (snapshot.agents || []).slice(0, 48);
  const tasks = snapshot.tasks || [];
  const byAgent = new Map(agents.map(agent => [agent.name, agent]));
  // 代表席始终显示它最近一项任务的状态色（完成/失败仍可读），
  // 但只有进行中的任务才让它离开原位去组小环——任务一结束就回位。
  const latestByAgent = new Map(
    tasks.filter(task => !task.parentWorkerId).map(task => [task.agent, task]),
  );
  const realNodes: VisualNode[] = agents.map(agent => {
    // 终态任务仍挂在代表上用于显示状态色，但 groupKey 保持 'default'，
    // 这样任务结束后代表回到代表席，不再占着临时分组环。
    const latest = latestByAgent.get(agent.name);
    const active = latest && isTaskCurrent(latest) ? latest : undefined;
    return { id: `agent:${agent.id}`, label: agent.name, kind: 'agent' as const, task: latest, groupKey: active?.groupKey || 'default', index: 0, x: 0, y: 0 };
  });
  for (const task of tasks) {
    const agent = byAgent.get(task.agent);
    if (agent && !task.parentWorkerId) continue;
    // 子任务结束同样收线，不再留在环上。
    if (!isTaskCurrent(task)) continue;
    // 任务节点用标题做标签：同名代表派生的多个任务不再长成一对双胞胎。
    realNodes.push({ id: `task:${task.id}`, label: plain(task.title || '') || task.agent, kind: 'task', task, groupKey: task.groupKey || task.parentWorkerId || `group-${Math.floor(realNodes.length / 12)}`, index: 0, x: 0, y: 0 });
  }
  // 只铺真实席位，不补空席。代表少的时候圆环本身就小，不需要占位符撑场面。
  // index 连续覆盖 0..n-1：键盘 ↑↓、点击命中和 Ctrl+X 都按 index 寻址
  //（hits[0] 是 index=-1 的总理座），漏赋值会让选中态整体错位。
  const nodes: VisualNode[] = realNodes.slice(0, 48);
  nodes.forEach((node, index) => { node.index = index; });
  return nodes;
}

// 议会形态：默认一个 48 席大圆环。活跃任务变多时按分组聚成若干小环，
// 每组的第一席（代理总代）朝向总理所在的中心，其余席位绕它排开。
// 这是既定的产品形态——不要改成同心环或泳道。
function layoutNodes(nodes: VisualNode[], width: number, height: number, zoom: number, offsets: GraphOffsets, reserveSidebar = false) {
  const activeCount = nodes.filter(node => node.task).length;
  const ringCount = activeCount > 12 ? Math.max(2, Math.ceil(nodes.length / 12)) : 1;
  // 单环就是全体；多环按 groupKey 聚组，每组最多 12 席。
  const groups: VisualNode[][] = ringCount === 1 ? [nodes] : (() => {
    const byGroup = new Map<string, VisualNode[]>();
    for (const node of nodes) {
      const list = byGroup.get(node.groupKey) ?? [];
      list.push(node);
      byGroup.set(node.groupKey, list);
    }
    return [...byGroup.values()].flatMap(list =>
      Array.from({ length: Math.ceil(list.length / 12) }, (_, i) => list.slice(i * 12, i * 12 + 12)),
    );
  })();
  const canvasWidth = width >= 120 && reserveSidebar ? width - 38 : width;
  const center = { x: Math.floor(canvasWidth / 2), y: Math.floor(height / 2) };
  const tracks: { cx: number; cy: number; rx: number; ry: number }[] = [];
  // 小环的环绕轨道：随 zoom 一起缩放，和环本身保持一致。
  // 多环时要给小环本身留出直径，否则相邻两环会压到一起、把标签挤到总理座上。
  const orbit = ringCount === 1 ? 0 : Math.min(canvasWidth * .26, 22) * zoom;
  const orbitY = ringCount === 1 ? 0 : Math.min(height * .30, 10) * zoom;
  groups.forEach((group, ringIndex) => {
    const ringCenter = ringCount === 1 ? center : {
      x: Math.round(center.x + Math.cos((ringIndex / groups.length) * Math.PI * 2 - Math.PI / 2) * orbit),
      y: Math.round(center.y + Math.sin((ringIndex / groups.length) * Math.PI * 2 - Math.PI / 2) * orbitY),
    };
    // 半径按席位数量决定：席位少时用小圆，席位多时再撑满画布。
    // 终端单元格约为 1:2（宽:高），所以椭圆天然是扁的；这里先定纵横比，
    // 再按 Ramanujan 周长反解尺寸，保证每席分到的弧长够放下一个名字（约 6 列）。
    const need = Math.max(1, group.length);
    const spreadX = canvasWidth / 2 - 5, spreadY = height / 2 - 3;
    // 纵横比：终端单元格约 1:2，椭圆天然偏扁。这里按画布可用空间给出更饱满的比例，
    // 让圆环在视觉上接近正圆，不至于压成一条横线。
    const ratio = Math.max(0.55, Math.min(0.95, spreadY / Math.max(1, spreadX)));
    // 目标周长；按椭圆周长公式反解长半轴 a（b = a * ratio）。
    const targetPerimeter = need * 7;
    let baseRx = (targetPerimeter / Math.PI) / (1 + ratio);
    let baseRy = baseRx * ratio;
    for (let pass = 0; pass < 2; pass++) {
      const b = baseRx * ratio;
      const perimeter = Math.PI * (3 * (baseRx + b) - Math.sqrt((3 * baseRx + b) * (baseRx + 3 * b)));
      if (perimeter <= 0) break;
      const scale = targetPerimeter / perimeter;
      baseRx *= scale;
      baseRy = baseRx * ratio;
    }
    // 多环时小环半径不能超过环绕轨道的一半，否则相邻分组会互相压住。
    const sizeCapX = ringCount === 1 ? spreadX : Math.max(6, orbit * 0.52);
    const sizeCapY = ringCount === 1 ? spreadY : Math.max(3, orbitY * 0.52);
    baseRx = Math.min(sizeCapX, Math.max(9, baseRx));
    baseRy = Math.min(sizeCapY, Math.max(4, baseRy));
    // zoom 直接相乘。下限只防止压到总理座（"◉  总理" 横向约 6 格）。
    const radiusX = Math.max(7, Math.round(baseRx * zoom));
    const radiusY = Math.max(3, Math.round(baseRy * zoom));
    tracks.push({ cx: ringCenter.x, cy: ringCenter.y, rx: radiusX, ry: radiusY });
    // 小环的第一席（代理总代）落在朝总理的一侧，其余席位绕它排开。
    const facing = ringCount === 1 ? -Math.PI / 2 : Math.atan2(center.y - ringCenter.y, center.x - ringCenter.x);
    group.forEach((node, index) => {
      const angle = facing + (index / Math.max(1, group.length)) * Math.PI * 2;
      const offset = offsets[node.id] || { x: 0, y: 0 };
      node.x = Math.round(ringCenter.x + Math.cos(angle) * radiusX + offset.x);
      node.y = Math.round(ringCenter.y + Math.sin(angle) * radiusY + offset.y);
    });
  });
  // 座位重合时沿邻近空位挪开，保证每个席位可见可点。
  const occupied = new Set<string>();
  for (const node of nodes) {
    const key = node.x + ',' + node.y;
    if (!occupied.has(key)) { occupied.add(key); continue; }
    let placed = false;
    for (let radius = 1; radius <= 8 && !placed; radius++) {
      for (let dy = -radius; dy <= radius && !placed; dy++) {
        for (let dx = -radius; dx <= radius && !placed; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const nx = node.x + dx, ny = node.y + dy;
          if (nx >= 1 && nx < canvasWidth - 1 && ny >= 0 && ny < height && !occupied.has(nx + ',' + ny)) { node.x = nx; node.y = ny; occupied.add(nx + ',' + ny); placed = true; }
        }
      }
    }
    if (!placed) occupied.add(key);
  }
  // 轨道虚线让"圆桌"读得出轮廓；单环时只留最外一条，多环时逐层可见。
  const track = tracks.length ? tracks : undefined;
  return { center, nodes, ringCount, tracks: track, track: tracks.length === 1 ? tracks[0] : undefined };
}

export function renderGraph(snapshot: GraphViewSnapshot, width: number, height: number, selected: number, zoom: number, theme: any, detail = false, offsets: GraphOffsets = {}, now = Date.now(), council?: CouncilView): { lines: string[]; hits: GraphHit[]; selected: GraphHit } {
  const safeWidth = Math.max(24, width), safeHeight = Math.max(8, height);
  const grid: Cell[][] = Array.from({ length: safeHeight }, () => Array.from({ length: safeWidth }, () => ({ char: ' ' })));
  const layout = layoutNodes(makeNodes(snapshot), safeWidth, safeHeight, zoom, offsets, !council?.desk);
  const main = { id: 'main', kind: 'main' as const, index: -1, x: layout.center.x, y: layout.center.y };
  const byWorkerId = new Map(layout.nodes.filter(node => node.task).map(node => [node.task!.id, node]));
  // 交互连线：总理与正在交互的代表之间连一条线。
  // 选中某席位时，画出 总理 → 该席位（及其委派链）的通路；未选中时
  // 只给活跃席位画一条朝内的短茎，读者仍能看出"谁在向总理汇报"。
  const selectedNodeEarly = selected >= 0 ? layout.nodes.find(node => node.index === selected) : undefined;
  const chain = new Set<string>();
  if (selectedNodeEarly) {
    let cursor: VisualNode | undefined = selectedNodeEarly;
    let guard = 0;
    while (cursor && guard++ < 8) { chain.add(cursor.id); cursor = cursor.task?.parentWorkerId ? byWorkerId.get(cursor.task.parentWorkerId) : undefined; }
  }
  const edgeMask: (number | undefined)[][] = Array.from({ length: safeHeight }, () => Array.from({ length: safeWidth }, () => 0 as number | undefined));
  if (selectedNodeEarly) {
    // 选中态：从总理座盒左右外侧出线，绝不与 "◉  总理" 字样重叠。
    for (const node of layout.nodes) {
      if (!chain.has(node.id)) continue;
      const parent = node.task?.parentWorkerId ? byWorkerId.get(node.task.parentWorkerId) : undefined;
      const start = parent ? { x: parent.x, y: parent.y } : { x: node.x >= main.x ? main.x + 5 : main.x - 2, y: main.y };
      stamp(grid, edgeMask, start.x, start.y, node.x, node.y, 'accent');
    }
    renderConnections(grid, edgeMask, 'accent');
  }
  // 先铺线再把总理座写上去：文字永远压在最上层，不会被连接符覆盖。
  put(grid, main.x - 1, main.y, '◉', selected === -1 ? 'accent' : 'text');
  put(grid, main.x + 1, main.y, ' 总理', 'accent');
  const hits: GraphHit[] = [main];
  for (const node of layout.nodes) {
    const selectedNode = selected === node.index;
    const approval = node.task?.state === 'NEEDS_HUMAN';
    const color = node.task ? stateColor(node.task, node.index) : 'idle';
    // 符号本身表达状态（见 seatGlyph），颜色只负责语义分组与轻重。
    const marker = seatGlyph(node.task, selectedNode, now);
    const shake = approval ? Math.floor(now / 400) % 2 : 0;
    put(grid, node.x - 1 + shake, node.y, marker, color);
    // 待审批：黄色运行态 + 席位中央的感叹号（沿用敲定语义，不改成静态符号）。
    if (approval) put(grid, node.x, node.y, '!', 'approval'); else if (node.task?.reviewDue) put(grid, node.x, node.y, '!', 'warning');
    // 名字比符号降一阶明度；未分配的席位退到背景。
    // 标签不能侵入总理座区，否则最小缩放下会糊在一起。
    const nameColor = selectedNode ? 'accent' : stateNameColor(node.task, node.index);
    const label = cut(node.label, 10);
    const labelY = node.y + 1;
    let labelX = node.x - Math.floor(visibleWidth(label) / 2);
    // 只有与总理座同一行才需要避让；推不出空间就让标签让位。
    if (labelY === main.y) {
      const boxLeft = main.x - 3, boxRight = main.x + 7;
      const overlaps = labelX <= boxRight && labelX + visibleWidth(label) >= boxLeft;
      if (overlaps) {
        // 位于总理右侧的席位向右让，左侧的向左让。
        labelX = node.x >= main.x
          ? boxRight + 1
          : boxLeft - visibleWidth(label);
        // 让位后可能出界，按剩余空间截断。
        if (labelX < 0 || labelX >= safeWidth) continue;
        put(grid, labelX, labelY, cut(label, safeWidth - labelX), nameColor);
        hits.push({ id: node.id, kind: node.kind, index: node.index, x: node.x, y: node.y, taskId: node.task?.id });
        continue;
      }
    }
    put(grid, labelX, labelY, label, nameColor);
    hits.push({ id: node.id, kind: node.kind, index: node.index, x: node.x, y: node.y, taskId: node.task?.id });
  }
  const selectedNode = selected >= 0 ? layout.nodes.find(node => node.index === selected) : undefined;
  sidebar(grid, snapshot, selectedNode, safeWidth, safeHeight, now, council);
  if (detail) bubble(grid, selectedNode || { id: 'main', label: '总理', kind: 'agent', groupKey: 'main', x: main.x, y: main.y, index: -1 }, safeWidth, safeHeight);
  const lines = grid.map(row => colorize(row, theme));
  const info = selected === -1 ? '总理 · Enter 输入目标' : selectedNode ? `${selectedNode.label} · ${selectedNode.task?.status || selectedNode.task?.state || '未激活'}${selectedNode.task?.reviewDue ? ' · 需要复核' : ''}` : `代表席 ${selected + 1} · 未配置`;
  lines.push(theme.fg('accent', truncateToWidth(`选中：${info} · ${layout.ringCount === 1 ? '一个议会环' : layout.ringCount + ' 个分组环'}`, safeWidth)));
  if (detail && selectedNode?.task) { lines.push(theme.fg('muted', truncateToWidth(`任务：${selectedNode.task.title || '—'} · Esc 关闭详情 · Ctrl+X 取消该任务`, safeWidth))); if (selectedNode.task.error) lines.push(theme.fg('error', truncateToWidth(`错误：${selectedNode.task.error}`, safeWidth))); }
  else lines.push(theme.fg('dim', truncateToWidth('议会 · ■ 代表  ⚠ 待审批 · 选中看链路 · Tab 列表 · F10 返回 · 拖动/缩放', safeWidth)));
  return { lines, hits, selected: selected === -1 ? main : hits.find(hit => hit.index === selected) || main };
}
