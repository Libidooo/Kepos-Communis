import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';

export type GraphViewAgent = { id: string; name: string; model?: string; roleKey?: string };
export type GraphViewTask = { id: string; agent: string; status?: string; state?: string; title?: string; tool?: string; checkpoint?: string; output?: string; parentWorkerId?: string; delegationDepth?: number; reviewDue?: boolean; error?: string; groupKey?: string };
export type GraphViewSnapshot = { agents: GraphViewAgent[]; tasks: GraphViewTask[] };
export type GraphHit = { id: string; kind: 'main' | 'agent' | 'task'; index: number; x: number; y: number; taskId?: string };
export type GraphOffsets = Record<string, { x: number; y: number }>;
type Cell = { char: string; color?: string };
type VisualNode = { id: string; label: string; kind: 'agent' | 'task'; task?: GraphViewTask; groupKey: string; x: number; y: number; index: number };
// 活跃=正在执行；NEEDS_HUMAN 归入"待处理"。desk 议会头部与这里 sidebar 的计数必须同源。
export const activeStates = new Set(['QUEUED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED']);
const connectedStates = new Set([...activeStates, 'NEEDS_HUMAN']);
export const countActive = (tasks: GraphViewTask[]) => tasks.filter(task => activeStates.has(task.state || '')).length;
export const countPending = (tasks: GraphViewTask[]) => tasks.filter(task => task.state === 'NEEDS_HUMAN' || task.reviewDue).length;
const plain = (value: unknown) => stripVTControlCharacters(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ');

// teal/blue/mauve exist only as orbital-76 vars; Pi's theme.fg rejects them, so emit them directly.
const directColors: Record<string, string> = { approval: '1;38;2;255;223;84', queue: '38;2;157;126;76', idle: '38;2;116;139;129', teal: '38;2;142;181;173', blue: '38;2;153;172;187', mauve: '38;2;181;160;173' };
const palette = ['teal', 'blue', 'mauve', 'accent'];
const stateColor = (task: GraphViewTask | undefined, index: number) => {
  if (!task) return 'muted';
  if (task.state === 'NEEDS_HUMAN') return 'approval';
  if (task.state === 'FAILED' || task.status === '失败') return 'error';
  if (task.state === 'SUCCEEDED' || task.status === '完成') return 'success';
  if (['CANCELLED', 'INTERRUPTED', 'TIMED_OUT'].includes(task.state || '')) return 'dim';
  if (task.state === 'QUEUED' || task.state === 'STARTING') return 'queue';
  const group = task.groupKey || task.parentWorkerId || task.agent;
  const hash = [...group].reduce((value, char) => value + char.charCodeAt(0), 0);
  return palette[hash % palette.length];
};

function line(grid: Cell[][], x0: number, y0: number, x1: number, y1: number, color: string) {
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  const stroke = dx > -dy * 2 ? '─' : -dy > dx * 2 ? '│' : sx === sy ? '╲' : '╱';
  let error = dx + dy, x = x0, y = y0;
  for (;;) {
    const cell = grid[y]?.[x];
    if (cell?.char === ' ') grid[y][x] = { char: stroke, color };
    else if (cell && '─│╱╲'.includes(cell.char) && cell.char !== stroke) grid[y][x] = { char: '┼', color };
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
    `任务 ${task?.title || '尚未分配任务'}`,
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

function sidebar(grid: Cell[][], snapshot: GraphViewSnapshot, selected: VisualNode | undefined, width: number, height: number) {
  if (width < 120) return;
  const x = width - 42, labelX = x + 3, labelWidth = 36;
  for (let y = 0; y < height; y++) put(grid, x, y, '│', 'borderMuted');
  const active = countActive(snapshot.tasks);
  const attention = countPending(snapshot.tasks);
  const rows = [
    ['议会观察', 'accent'],
    [`活跃 ${active} · 待处理 ${attention}`, attention ? 'warning' : 'muted'],
    ['', 'muted'],
    ['□ 空席    ■ 已配置', 'muted'],
    ['▣ 选中    ⚒ 人工审批', 'muted'],
    ['', 'muted'],
    [`当前 ${selected ? plain(selected.label) : 'Kepos Council'}`, 'accent'],
    [`状态 ${selected?.task?.status || selected?.task?.state || (selected ? '未分配' : '主 Agent')}`, 'muted'],
    ['', 'muted'],
    ['单击选中 · 双击详情', 'muted'],
    ['拖动坐席 · 滚轮缩放', 'muted'],
    ['F10 返回三栏工作台', 'muted'],
  ] as const;
  rows.forEach(([label, color], index) => { if (index < height) put(grid, labelX, index, truncateToWidth(plain(label), labelWidth), color); });
}

function makeNodes(snapshot: GraphViewSnapshot): VisualNode[] {
  const agents = (snapshot.agents || []).slice(0, 48);
  const tasks = snapshot.tasks || [];
  const byAgent = new Map(agents.map(agent => [agent.name, agent]));
  const taskByAgent = new Map(tasks.filter(task => !task.parentWorkerId).map(task => [task.agent, task]));
  const nodes: VisualNode[] = agents.map((agent, index) => ({ id: `agent:${agent.id}`, label: agent.name, kind: 'agent', task: taskByAgent.get(agent.name), groupKey: taskByAgent.get(agent.name)?.groupKey || 'default', index, x: 0, y: 0 }));
  for (const task of tasks) {
    const agent = byAgent.get(task.agent);
    if (agent && !task.parentWorkerId) continue;
    nodes.push({ id: `task:${task.id}`, label: task.agent, kind: 'task', task, groupKey: task.groupKey || task.parentWorkerId || `group-${Math.floor(nodes.length / 12)}`, index: nodes.length, x: 0, y: 0 });
  }
  for (let index = nodes.length; index < 48; index++) nodes.push({ id: `seat:${index}`, label: `席位 ${index + 1}`, kind: 'agent', groupKey: 'default', index, x: 0, y: 0 });
  return nodes.slice(0, 48);
}

function layoutNodes(nodes: VisualNode[], width: number, height: number, zoom: number, offsets: GraphOffsets) {
  const active = nodes.filter(node => node.task).length;
  const ringCount = active > 12 ? Math.max(2, Math.ceil(nodes.length / 12)) : 1;
  const groups: VisualNode[][] = [];
  if (ringCount === 1) groups.push(nodes);
  else {
    const map = new Map<string, VisualNode[]>();
    for (const node of nodes) { const list = map.get(node.groupKey) || []; list.push(node); map.set(node.groupKey, list); }
    for (const list of map.values()) for (let index = 0; index < list.length; index += 12) groups.push(list.slice(index, index + 12));
  }
  const canvasWidth = width >= 120 ? width - 42 : width;
  const center = { x: Math.floor(canvasWidth / 2), y: Math.floor(height / 2) };
  groups.forEach((group, ringIndex) => {
    const ringCenter = ringCount === 1 ? center : { x: Math.round(center.x + Math.cos((ringIndex / groups.length) * Math.PI * 2 - Math.PI / 2) * Math.min(canvasWidth * .23, 18 * zoom)), y: Math.round(center.y + Math.sin((ringIndex / groups.length) * Math.PI * 2 - Math.PI / 2) * Math.min(height * .25, 6 * zoom)) };
    const radiusX = ringCount === 1 ? Math.max(10, Math.min(canvasWidth / 2 - 5, 40 * zoom)) : Math.max(4, Math.min(10, 3 + group.length * .55));
    const radiusY = ringCount === 1 ? Math.max(3, Math.min(height / 2 - 3, 12 * zoom)) : Math.max(2, Math.min(5, 1.5 + group.length * .3));
    group.forEach((node, index) => { const angle = (index / Math.max(1, group.length)) * Math.PI * 2 - Math.PI / 2; const offset = offsets[node.id] || { x: 0, y: 0 }; node.x = Math.round(ringCenter.x + Math.cos(angle) * radiusX + offset.x); node.y = Math.round(ringCenter.y + Math.sin(angle) * radiusY + offset.y); });
  });
  return { center, nodes, ringCount };
}

export function renderGraph(snapshot: GraphViewSnapshot, width: number, height: number, selected: number, zoom: number, theme: any, detail = false, offsets: GraphOffsets = {}, now = Date.now()): { lines: string[]; hits: GraphHit[]; selected: GraphHit } {
  const safeWidth = Math.max(24, width), safeHeight = Math.max(8, height);
  const grid: Cell[][] = Array.from({ length: safeHeight }, () => Array.from({ length: safeWidth }, () => ({ char: ' ' })));
  const layout = layoutNodes(makeNodes(snapshot), safeWidth, safeHeight, zoom, offsets);
  const main = { id: 'main', kind: 'main' as const, index: -1, x: layout.center.x, y: layout.center.y };
  const byWorkerId = new Map(layout.nodes.filter(node => node.task).map(node => [node.task!.id, node]));
  for (const node of layout.nodes) { if (!node.task || (!connectedStates.has(node.task.state || '') && selected !== node.index)) continue; const parent = node.task.parentWorkerId ? byWorkerId.get(node.task.parentWorkerId) : undefined; line(grid, parent?.x ?? main.x, parent?.y ?? main.y, node.x, node.y, stateColor(node.task, node.index)); }
  put(grid, main.x - 1, main.y, '◉', selected === -1 ? 'accent' : 'text'); put(grid, main.x + 2, main.y, '主', 'accent');
  const hits: GraphHit[] = [main];
  for (const node of layout.nodes) { const selectedNode = selected === node.index; const empty = node.id.startsWith('seat:'); const approval = node.task?.state === 'NEEDS_HUMAN'; const color = empty ? 'muted' : node.task ? stateColor(node.task, node.index) : 'idle'; const marker = empty ? '□' : selectedNode ? '▣' : '■'; const shake = approval ? Math.floor(now / 400) % 2 : 0; put(grid, node.x - 1 + shake, node.y, marker, color); if (approval) put(grid, node.x - 1 - shake, node.y - 1, '⚒', 'approval'); else if (node.task?.reviewDue) put(grid, node.x, node.y, '!', 'warning'); if (selectedNode) put(grid, node.x - Math.floor(node.label.length / 2), node.y + 1, truncateToWidth(node.label, 10), color); hits.push({ id: node.id, kind: node.kind, index: node.index, x: node.x, y: node.y, taskId: node.task?.id }); }
  const selectedNode = selected >= 0 ? layout.nodes.find(node => node.index === selected) : undefined;
  sidebar(grid, snapshot, selectedNode, safeWidth, safeHeight);
  if (detail) bubble(grid, selectedNode || { id: 'main', label: 'Kepos Council', kind: 'agent', groupKey: 'main', x: main.x, y: main.y, index: -1 }, safeWidth, safeHeight);
  const lines = grid.map(row => colorize(row, theme));
  const info = selected === -1 ? '主 Agent · Kepos Council · Enter 输入目标' : selectedNode ? `${selectedNode.label} · ${selectedNode.task?.status || selectedNode.task?.state || '未激活'}${selectedNode.task?.reviewDue ? ' · 需要复核' : ''}` : `代表席 ${selected + 1} · 未配置`;
  lines.push(theme.fg('accent', truncateToWidth(`选中：${info} · ${layout.ringCount} 个环`, safeWidth)));
  if (detail && selectedNode?.task) { lines.push(theme.fg('muted', truncateToWidth(`任务：${selectedNode.task.title || '—'} · Esc 关闭详情 · Ctrl+X 取消该任务`, safeWidth))); if (selectedNode.task.error) lines.push(theme.fg('error', truncateToWidth(`错误：${selectedNode.task.error}`, safeWidth))); }
  else lines.push(theme.fg('dim', truncateToWidth('议会 · □ 空席  ■ 代表  ! 待处理 · F10 返回 · 点击/拖动 · 滚轮缩放', safeWidth)));
  return { lines, hits, selected: selected === -1 ? main : hits.find(hit => hit.index === selected) || main };
}
