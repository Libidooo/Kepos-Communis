import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { TASK_ACTIVE_STATES, isTaskActive, isTaskCurrent, isTaskPending, taskElapsedText, taskState, type TaskStateLike } from './task-state.ts';

export type GraphViewAgent = { id: string; name: string; model?: string; roleKey?: string };
export type GraphViewTask = TaskStateLike & { id: string; agent: string; agentId?: string; purpose?: 'delegation' | 'configuration'; internal?: boolean; title?: string; tool?: string; checkpoint?: string; output?: string; parentWorkerId?: string; delegationDepth?: number; error?: string; groupKey?: string };
export type GraphViewSnapshot = { agents: GraphViewAgent[]; tasks: GraphViewTask[] };
export type GraphHit = { id: string; kind: 'main' | 'agent' | 'task'; index: number; x: number; y: number; taskId?: string };
export type GraphOffsets = Record<string, { x: number; y: number }>;
export type CouncilFilter = 'active' | 'pending' | 'all';
export type CouncilView = { list: boolean; filter: CouncilFilter; query: string; index: number; focus?: 'ring' | 'list' | 'input' };
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
// htop 式对齐列：状态/代表名定宽补齐，标题吃剩余宽度。
const padCell = (value: string, width: number) => { const text = truncateToWidth(plain(value), width); return text + ' '.repeat(Math.max(0, width - visibleWidth(text))); };

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
// 分组色：连线与运行中坐席用它表达关系；避免与状态语义色混用。
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

/** 在网格上记录一条线段的方向位，返回终点该补的入边。 */
function stamp(grid: Cell[][], mask: (number | undefined)[][], x0: number, y0: number, x1: number, y1: number, color: string) {
  let x = x0, y = y0;
  while (x !== x1 || y !== y1) {
    let bits = 0;
    if (x1 > x) bits |= E; else if (x1 < x) bits |= W;
    if (y1 > y) bits |= S; else if (y1 < y) bits |= N;
    const row = mask[y];
    if (row && row[x] !== undefined) row[x] = (row[x] ?? 0) | bits;
    if (grid[y]?.[x]) grid[y][x].color = grid[y][x].color || color;
    if (x !== x1) x += x1 > x ? 1 : -1;
    else y += y1 > y ? 1 : -1;
    // 记录反方向，避免终点缺少入边。
    const opposite = bits & E ? W : bits & W ? E : bits & S ? N : bits & N ? S : 0;
    if (mask[y] && mask[y][x] !== undefined) mask[y][x] = (mask[y][x] ?? 0) | opposite;
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
  let column = x;
  for (const char of text) {
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
    const content = truncateToWidth(plain(row), inner);
    put(grid, x, y + index + 1, '│ ' + content + ' '.repeat(Math.max(0, inner - visibleWidth(content))) + ' │', index === 0 ? 'accent' : 'text');
  });
  put(grid, x, y + 7, '╰' + '─'.repeat(boxWidth - 2) + '╯', 'accent');
}

// 右侧常驻面板：框线容器 + 计数、可筛选任务列表、选中详情。列表负责寻找，详情负责判断和行动。
// 议会简要：右上角动态高度卡片，只框住实际内容，不再拖一整列空框。
function sidebar(grid: Cell[][], snapshot: GraphViewSnapshot, selected: VisualNode | undefined, width: number, height: number, now: number, council?: CouncilView) {
  if (width < 120) return;
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
      rows.push({ text: `${i === council.index ? '›' : ' '}${stateMark(task)} ${padCell(task.status || task.state || '—', 8)} ${padCell(task.agent, 8)} ${truncateToWidth(plain(task.title || ''), labelWidth - 20)}`, color: i === council.index ? 'accent' : stateColor(task, i) });
    }
    if (filtered.length > visible) rows.push({ text: `  ${Math.min(filtered.length, start + visible)}/${filtered.length} · ↑↓ 选择`, color: 'dim' });
    rows.push('div');
  }
  const task = selected?.task;
  rows.push({ text: task ? `${plain(selected!.label)} 书案` : selected ? `选中 ${plain(selected.label)}` : '选中 总理', color: 'accent' });
  if (task) {
    const elapsed = task.started ? Math.max(0, Math.round((now - task.started) / 1000)) + 's' : '—';
    rows.push({ text: `状态 ${task.status || task.state || '—'} · ${elapsed}`, color: stateColor(task, selected!.index) });
    if (task.tool) rows.push({ text: `工具 ${truncateToWidth(plain(task.tool), labelWidth - 3)}`, color: 'dim' });
    if (task.checkpoint) rows.push({ text: `进展 ${truncateToWidth(plain(task.checkpoint), labelWidth - 3)}`, color: 'dim' });
    rows.push({ text: `输出 ${truncateToWidth(plain(task.output || '等待结果'), labelWidth - 3)}`, color: 'text' });
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
    put(grid, labelX, y, truncateToWidth(plain(row.text), labelWidth), row.color);
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
  const taskByAgent = new Map(tasks.filter(task => !task.parentWorkerId).map(task => [task.agent, task]));
  const realNodes: VisualNode[] = agents.map(agent => ({ id: `agent:${agent.id}`, label: agent.name, kind: 'agent', task: taskByAgent.get(agent.name), groupKey: taskByAgent.get(agent.name)?.groupKey || 'default', index: 0, x: 0, y: 0 }));
  for (const task of tasks) {
    const agent = byAgent.get(task.agent);
    if (agent && !task.parentWorkerId) continue;
    // 任务节点用标题做标签：同名代表派生的多个任务不再长成一对双胞胎。
    realNodes.push({ id: `task:${task.id}`, label: plain(task.title || '') || task.agent, kind: 'task', task, groupKey: task.groupKey || task.parentWorkerId || `group-${Math.floor(realNodes.length / 12)}`, index: 0, x: 0, y: 0 });
  }
  // 真实席位沿 48 槽均匀分布、空席填隙，避免全部挤在起弧的一段；多环（活跃>12）保持分组顺序。
  // 不论哪个分支，节点 index 都必须连续覆盖 0..n-1：键盘 ↑↓、点击命中和 Ctrl+X 都按
  // index 寻址（hits[0] 是 index=-1 的总理座），漏赋值会让选中态整体错位。
  const activeCount = tasks.filter(task => activeStates.has(task.state || '')).length;
  const nodes: VisualNode[] = [];
  if (realNodes.length < 48 && activeCount <= 12) {
    const step = 48 / realNodes.length;
    const slots: (VisualNode | undefined)[] = Array(48).fill(undefined);
    realNodes.forEach((node, k) => {
      let slot = Math.round(k * step) % 48;
      while (slots[slot]) slot = (slot + 1) % 48; // 舍入碰撞沿环右移找空位，绝不覆盖已占席位。
      slots[slot] = node;
    });
    const empty = (index: number): VisualNode => ({ id: `seat:${index}`, label: `席位 ${index + 1}`, kind: 'agent', groupKey: 'default', index, x: 0, y: 0 });
    for (let index = 0; index < 48; index++) { const slot = slots[index]; if (slot) { slot.index = index; nodes.push(slot); } else nodes.push(empty(index)); }
  } else {
    realNodes.forEach((node, index) => { node.index = index; });
    nodes.push(...realNodes);
    for (let index = nodes.length; index < 48; index++) nodes.push({ id: `seat:${index}`, label: `席位 ${index + 1}`, kind: 'agent', groupKey: 'default', index, x: 0, y: 0 });
    if (nodes.length > 48) nodes.length = 48;
  }
  return nodes;
}

// 同心环：按父子深度分层，边只跨相邻层。
// 旧实现把多环画成互相拥挤的小圆，半径掉到 3–10 格，12 个节点在周长 ~48 格里只隔 4 格，
// 连线全部收向中心，视觉上就是一团乱麻。层数由最深委派链决定，半径吃满画布。
function nodeDepth(node: VisualNode, byWorker: Map<string, VisualNode>): number {
  let depth = 0, current = node, guard = 0;
  while (current?.task?.parentWorkerId && guard++ < 8) {
    const parent = byWorker.get(current.task.parentWorkerId);
    if (!parent) break;
    depth++; current = parent;
  }
  return depth;
}

function layoutNodes(nodes: VisualNode[], width: number, height: number, zoom: number, offsets: GraphOffsets) {
  const canvasWidth = width >= 120 ? width - 38 : width;
  const center = { x: Math.floor(canvasWidth / 2), y: Math.floor(height / 2) };
  const byWorker = new Map(nodes.filter(node => node.task).map(node => [node.task!.id, node]));
  // 有任务或本身是配置代表的节点上环；空席留在最外环补足 48 宫格。
  const ringed = nodes.filter(node => node.task || !node.id.startsWith('seat:'));
  const emptySeats = nodes.filter(node => node.id.startsWith('seat:'));
  const depthOf = new Map<VisualNode, number>();
  for (const node of ringed) depthOf.set(node, nodeDepth(node, byWorker));
  const maxDepth = ringed.reduce((max, node) => Math.max(max, depthOf.get(node) ?? 0), 0);
  const ringCount = Math.max(1, maxDepth + 1);
  const buckets: VisualNode[][] = Array.from({ length: ringCount }, () => []);
  for (const node of ringed) buckets[depthOf.get(node) ?? 0]!.push(node);
  // 内环要给总理座盒留出半径，逐环向外铺开；随环数线性增长而不是塌缩。
  const outerX = Math.max(12, Math.min(canvasWidth / 2 - 4, (canvasWidth / 2 - 4) * zoom));
  const outerY = Math.max(4, Math.min(height / 2 - 3, (height / 2 - 3) * zoom));
  const tracks: { cx: number; cy: number; rx: number; ry: number }[] = [];
  buckets.forEach((group, depth) => {
    const share = ringCount === 1 ? 1 : 0.52 + (depth / Math.max(1, ringCount - 1)) * 0.48;
    const rx = Math.max(10, outerX * share), ry = Math.max(3, outerY * share);
    tracks.push({ cx: center.x, cy: center.y, rx, ry });
    group.forEach((node, index) => {
      const angle = (index / Math.max(1, group.length)) * Math.PI * 2 - Math.PI / 2;
      const offset = offsets[node.id] || { x: 0, y: 0 };
      node.x = Math.round(center.x + Math.cos(angle) * rx + offset.x);
      node.y = Math.round(center.y + Math.sin(angle) * ry + offset.y);
    });
  });
  // 空席铺最外一圈，不与已有席位争半径。
  if (emptySeats.length) {
    const rx = Math.max(12, outerX + 2), ry = Math.max(4, outerY + 1);
    tracks.push({ cx: center.x, cy: center.y, rx, ry });
    emptySeats.forEach((node, index) => {
      const angle = (index / Math.max(1, emptySeats.length)) * Math.PI * 2 - Math.PI / 2;
      const offset = offsets[node.id] || { x: 0, y: 0 };
      node.x = Math.round(center.x + Math.cos(angle) * rx + offset.x);
      node.y = Math.round(center.y + Math.sin(angle) * ry + offset.y);
    });
  }
  // 整数网格会让座位重合（48 任务多环时实测出现 2 组），后到者沿邻近空位挪开，保证可见可点。
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
  const layout = layoutNodes(makeNodes(snapshot), safeWidth, safeHeight, zoom, offsets);
  const main = { id: 'main', kind: 'main' as const, index: -1, x: layout.center.x, y: layout.center.y };
  // 每层画一圈轨道虚线；多环时逐层可见，读得出"同心"结构。
  for (const track of layout.tracks) {
    const { cx, cy, rx, ry } = track;
    const steps = Math.max(64, Math.round((rx + ry) * 2));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(angle) * rx), y = Math.round(cy + Math.sin(angle) * ry);
      const cell = grid[y]?.[x];
      if (cell && cell.char === ' ') put(grid, x, y, '·', 'dim');
    }
  }
  const byWorkerId = new Map(layout.nodes.filter(node => node.task).map(node => [node.task!.id, node]));
  // 默认不画任何边：48 席的连线很容易糊成网。只有选中某个席位时，
  // 才把 总理 → 代表 → Worker 这条祖先链画出来，其余席位保持 dim。
  const selectedNodeEarly = selected >= 0 ? layout.nodes.find(node => node.index === selected) : undefined;
  const chain = new Set<string>();
  if (selectedNodeEarly) {
    let cursor: VisualNode | undefined = selectedNodeEarly;
    let guard = 0;
    while (cursor && guard++ < 8) { chain.add(cursor.id); cursor = cursor.task?.parentWorkerId ? byWorkerId.get(cursor.task.parentWorkerId) : undefined; }
  }
  const edgeMask: (number | undefined)[][] = Array.from({ length: safeHeight }, () => Array.from({ length: safeWidth }, () => 0 as number | undefined));
  if (selectedNodeEarly) {
    for (const node of layout.nodes) {
      if (!chain.has(node.id)) continue;
      const parent = node.task?.parentWorkerId ? byWorkerId.get(node.task.parentWorkerId) : undefined;
      stamp(grid, edgeMask, parent?.x ?? main.x, parent?.y ?? main.y, node.x, node.y, 'accent');
    }
    renderConnections(grid, edgeMask, 'accent');
  }
  put(grid, main.x - 1, main.y, '◉', selected === -1 ? 'accent' : 'text'); put(grid, main.x + 2, main.y, '总理', 'accent');
  const hits: GraphHit[] = [main];
  for (const node of layout.nodes) {
    const selectedNode = selected === node.index;
    const empty = node.id.startsWith('seat:');
    const approval = node.task?.state === 'NEEDS_HUMAN';
    // 选中时非本链席位退为 dim，让"谁属于这条链"一眼可见。
    const onChain = chain.size === 0 || chain.has(node.id);
    const color = empty ? 'muted' : !onChain ? 'dim' : node.task ? stateColor(node.task, node.index) : 'idle';
    const pulsing = !!node.task && ['RUNNING', 'STARTING'].includes(node.task.state || '');
    const marker = empty ? '○' : selectedNode ? '▣' : pulsing && Math.floor(now / 600) % 2 ? '▪' : '■';
    const shake = approval ? Math.floor(now / 400) % 2 : 0;
    put(grid, node.x - 1 + shake, node.y, marker, color);
    if (approval) put(grid, node.x - 1 - shake, node.y - 1, '⚠', 'approval'); else if (node.task?.reviewDue) put(grid, node.x, node.y, '!', 'warning');
    // 有任务的席位显示名字（选中席位任何布局都显示）；用可见宽度居中，CJK 不偏移。
    const labelled = selectedNode || (node.task && layout.tracks.length <= 1 ? node : undefined);
    if (labelled) put(grid, node.x - Math.floor(visibleWidth(plain(node.label)) / 2), node.y + 1, truncateToWidth(plain(node.label), 10), color);
    hits.push({ id: node.id, kind: node.kind, index: node.index, x: node.x, y: node.y, taskId: node.task?.id });
  }
  const selectedNode = selected >= 0 ? layout.nodes.find(node => node.index === selected) : undefined;
  sidebar(grid, snapshot, selectedNode, safeWidth, safeHeight, now, council);
  if (detail) bubble(grid, selectedNode || { id: 'main', label: '总理', kind: 'agent', groupKey: 'main', x: main.x, y: main.y, index: -1 }, safeWidth, safeHeight);
  const lines = grid.map(row => colorize(row, theme));
  const info = selected === -1 ? '总理 · Enter 输入目标' : selectedNode ? `${selectedNode.label} · ${selectedNode.task?.status || selectedNode.task?.state || '未激活'}${selectedNode.task?.reviewDue ? ' · 需要复核' : ''}` : `代表席 ${selected + 1} · 未配置`;
  lines.push(theme.fg('accent', truncateToWidth(`选中：${info} · ${layout.ringCount} 层同心环`, safeWidth)));
  if (detail && selectedNode?.task) { lines.push(theme.fg('muted', truncateToWidth(`任务：${selectedNode.task.title || '—'} · Esc 关闭详情 · Ctrl+X 取消该任务`, safeWidth))); if (selectedNode.task.error) lines.push(theme.fg('error', truncateToWidth(`错误：${selectedNode.task.error}`, safeWidth))); }
  else lines.push(theme.fg('dim', truncateToWidth('议会 · ○ 空席  ■ 代表  ⚠ 待审批 · 选中看链路 · Tab 列表 · F10 返回 · 拖动/缩放', safeWidth)));
  return { lines, hits, selected: selected === -1 ? main : hits.find(hit => hit.index === selected) || main };
}
