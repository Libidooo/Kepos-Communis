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

/** 在网格上记录一条正交线段（先竖后横），返回终点该补的入边。 */
function stamp(grid: Cell[][], mask: (number | undefined)[][], x0: number, y0: number, x1: number, y1: number, color: string) {
  // 先沿 y 走到目标行，再横向对齐：起点只带一个方向，不会长成 └ ┘ 这类转角。
  let x = x0, y = y0;
  while (y !== y1) {
    const bit = y1 > y ? S : N;
    if (mask[y]?.[x] !== undefined) mask[y][x] = (mask[y][x] ?? 0) | bit;
    if (grid[y]?.[x]) grid[y][x].color = grid[y][x].color || color;
    y += y1 > y ? 1 : -1;
    if (mask[y]?.[x] !== undefined) mask[y][x] = (mask[y][x] ?? 0) | (bit === S ? N : S);
  }
  while (x !== x1) {
    const bit = x1 > x ? E : W;
    if (mask[y]?.[x] !== undefined) mask[y][x] = (mask[y][x] ?? 0) | bit;
    if (grid[y]?.[x]) grid[y][x].color = grid[y][x].color || color;
    x += x1 > x ? 1 : -1;
    if (mask[y]?.[x] !== undefined) mask[y][x] = (mask[y][x] ?? 0) | (bit === E ? W : E);
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
  // 代表席始终显示它最近一项任务的状态色（完成/失败仍可读），
  // 但只有进行中的任务才让它离开原位去组小环——任务一结束就回位。
  const latestByAgent = new Map(
    tasks.filter(task => !task.parentWorkerId).map(task => [task.agent, task]),
  );
  const realNodes: VisualNode[] = agents.map(agent => {
    const latest = latestByAgent.get(agent.name);
    const task = latest && isTaskCurrent(latest) ? latest : undefined;
    // 终态任务仍挂在代表上，用于显示状态色，但不参与分组（groupKey 保持 'default'）。
    const display = latest;
    return { id: `agent:${agent.id}`, label: agent.name, kind: 'agent' as const, task: display, groupKey: task ? (task.groupKey || 'default') : 'default', index: 0, x: 0, y: 0 };
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
function layoutNodes(nodes: VisualNode[], width: number, height: number, zoom: number, offsets: GraphOffsets) {
  const active = nodes.filter(node => node.task).length;
  const ringCount = active > 12 ? Math.max(2, Math.ceil(nodes.length / 12)) : 1;
  const groups: VisualNode[][] = [];
  if (ringCount === 1) groups.push(nodes);
  else {
    // 按 groupKey 聚组，每组最多 12 席。
    const map = new Map<string, VisualNode[]>();
    for (const node of nodes) { const list = map.get(node.groupKey) || []; list.push(node); map.set(node.groupKey, list); }
    for (const list of map.values()) for (let index = 0; index < list.length; index += 12) groups.push(list.slice(index, index + 12));
  }
  const canvasWidth = width >= 120 ? width - 38 : width;
  const center = { x: Math.floor(canvasWidth / 2), y: Math.floor(height / 2) };
  const tracks: { cx: number; cy: number; rx: number; ry: number }[] = [];
  // 小环的环绕轨道：随 zoom 一起缩放，和环本身保持一致。
  const orbit = ringCount === 1 ? 0 : Math.min(canvasWidth * .22, 18) * zoom;
  const orbitY = ringCount === 1 ? 0 : Math.min(height * .24, 7) * zoom;
  groups.forEach((group, ringIndex) => {
    const ringCenter = ringCount === 1 ? center : {
      x: Math.round(center.x + Math.cos((ringIndex / groups.length) * Math.PI * 2 - Math.PI / 2) * orbit),
      y: Math.round(center.y + Math.sin((ringIndex / groups.length) * Math.PI * 2 - Math.PI / 2) * orbitY),
    };
    // 半径按席位数量决定：席位少时用小圆，席位多时再撑满画布。
    // zoom 作用于整个环布局（含小环自身半径），否则缩放只会拉开环间距、环本身不动。
    const need = Math.max(1, group.length);
    const baseRx = Math.min(canvasWidth / 2 - 5, Math.max(8, (need * 6) / (Math.PI * 2) + 6));
    const baseRy = Math.min(height / 2 - 3, Math.max(3, (need * 2.2) / (Math.PI * 2) + 2));
    // 单环与分组小环共用同一套缩放，保证放大/缩小是整体一致的。
    // 下限只守住"不压到总理座"（盒子约 12 列宽），留出 2 格呼吸。
    const radiusX = Math.max(9, Math.round(baseRx * zoom));
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
  const layout = layoutNodes(makeNodes(snapshot), safeWidth, safeHeight, zoom, offsets);
  const main = { id: 'main', kind: 'main' as const, index: -1, x: layout.center.x, y: layout.center.y };
  // 不画轨道虚线：满屏小圆点没有语义，只会盖住代表标签、抢走注意力。
  // 圆桌形态由席位本身的排布给出。
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
    // 选中时只让本链席位提亮；其余席位保留自己的状态色（排队、待审批仍要看得见），
    // 只是不再抢眼——状态信息不能被选中态掩盖。
    const onChain = chain.size === 0 || chain.has(node.id);
    const color = node.task ? stateColor(node.task, node.index) : 'idle';
    const pulsing = !!node.task && ['RUNNING', 'STARTING'].includes(node.task.state || '');
    const marker = selectedNode ? '▣' : pulsing && Math.floor(now / 600) % 2 ? '▪' : '■';
    const shake = approval ? Math.floor(now / 400) % 2 : 0;
    put(grid, node.x - 1 + shake, node.y, marker, color);
    if (approval) put(grid, node.x - 1 - shake, node.y - 1, '⚠', 'approval'); else if (node.task?.reviewDue) put(grid, node.x, node.y, '!', 'warning');
    // 每个席位都显示名字：没有任务时也能看清这 48 席是谁。
    // 空闲代表的文字用 dim，有任务的用状态色，选中时整行提亮。
    const nameColor = selectedNode ? 'accent' : color;
    put(grid, node.x - Math.floor(visibleWidth(plain(node.label)) / 2), node.y + 1, truncateToWidth(plain(node.label), 10), nameColor);
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
