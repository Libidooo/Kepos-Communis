import { truncateToWidth } from '@earendil-works/pi-tui';

export type GraphViewAgent = { id: string; name: string; model?: string; roleKey?: string };
export type GraphViewTask = { id: string; agent: string; status?: string; state?: string; title?: string; parentWorkerId?: string; delegationDepth?: number; reviewDue?: boolean; error?: string };
export type GraphViewSnapshot = { agents: GraphViewAgent[]; tasks: GraphViewTask[] };
export type GraphHit = { id: string; kind: 'main' | 'agent' | 'task'; index: number };
type Cell = { char: string; color?: string };

const palette = ['teal', 'blue', 'mauve', 'accent', 'success', 'warning'];
const stateColor = (task: GraphViewTask | undefined, index: number) => {
  if (!task) return 'muted';
  if (task.reviewDue || task.state === 'NEEDS_HUMAN') return 'warning';
  if (task.state === 'FAILED' || task.status === '失败') return 'error';
  if (task.state === 'SUCCEEDED' || task.status === '完成') return 'success';
  return palette[index % palette.length];
};

function line(grid: Cell[][], x0: number, y0: number, x1: number, y1: number, color: string) {
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let error = dx + dy, x = x0, y = y0;
  for (;;) {
    if (grid[y]?.[x]?.char === ' ') grid[y][x] = { char: '·', color };
    if (x === x1 && y === y1) break;
    const twice = 2 * error;
    if (twice >= dy) { error += dy; x += sx; }
    if (twice <= dx) { error += dx; y += sy; }
  }
}

function put(grid: Cell[][], x: number, y: number, text: string, color?: string) {
  for (let index = 0; index < text.length; index++) {
    if (grid[y]?.[x + index]) grid[y][x + index] = { char: text[index], color };
  }
}

function colorize(row: Cell[], theme: any): string {
  return row.map(cell => cell.char === ' ' ? ' ' : theme.fg(cell.color || 'text', cell.char)).join('');
}

function positions(width: number, height: number, zoom: number) {
  const center = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  const radiusX = Math.max(10, Math.min(Math.floor(width / 2) - 5, Math.floor((width - 10) * 0.38 * zoom)));
  const radiusY = Math.max(3, Math.min(Math.floor(height / 2) - 3, Math.floor((height - 4) * 0.38 * zoom)));
  return { center, slots: Array.from({ length: 48 }, (_, index) => {
    const angle = (index / 48) * Math.PI * 2 - Math.PI / 2;
    return { x: Math.round(center.x + Math.cos(angle) * radiusX), y: Math.round(center.y + Math.sin(angle) * radiusY) };
  }) };
}

export function graphHitTest(width: number, height: number, zoom: number, x: number, y: number): GraphHit | undefined {
  const { center, slots } = positions(width, height, zoom);
  if (Math.abs(x - center.x) <= 3 && Math.abs(y - center.y) <= 1) return { id: 'main', kind: 'main', index: -1 };
  const index = slots.findIndex(slot => Math.abs(x - slot.x) <= 2 && Math.abs(y - slot.y) <= 1);
  return index < 0 ? undefined : { id: `slot-${index}`, kind: 'agent', index };
}

export function renderGraph(snapshot: GraphViewSnapshot, width: number, height: number, selected: number, zoom: number, theme: any, detail = false): { lines: string[]; selected: GraphHit } {
  const safeWidth = Math.max(24, width), safeHeight = Math.max(8, height);
  const grid: Cell[][] = Array.from({ length: safeHeight }, () => Array.from({ length: safeWidth }, () => ({ char: ' ' })));
  const { center, slots } = positions(safeWidth, safeHeight, zoom);
  const tasks = snapshot.tasks || [];
  const taskByAgent = new Map(tasks.map(task => [task.agent, task]));
  const visibleAgents = snapshot.agents.slice(0, 48);
  const selectedHit: GraphHit = selected < 0 ? { id: 'main', kind: 'main', index: -1 } : { id: `slot-${Math.min(47, selected)}`, kind: 'agent', index: Math.min(47, selected) };

  for (const task of tasks) {
    const childIndex = visibleAgents.findIndex(agent => agent.name === task.agent);
    const nodeIndex = childIndex >= 0 ? childIndex : tasks.indexOf(task) % 48;
    const from = task.parentWorkerId ? slots.find((_slot, index) => `slot-${index}` === task.parentWorkerId) : center;
    const to = slots[nodeIndex];
    if (from && to) line(grid, from.x, from.y, to.x, to.y, stateColor(task, nodeIndex));
  }

  put(grid, center.x - 2, center.y, '◉', selected === -1 ? 'accent' : 'text');
  if (selected === -1) put(grid, center.x + 2, center.y, '主', 'accent');
  slots.forEach((slot, index) => {
    const agent = visibleAgents[index];
    const task = agent ? taskByAgent.get(agent.name) : tasks[index];
    const color = stateColor(task, index);
    const marker = task?.reviewDue ? '!' : task?.state === 'FAILED' ? '×' : task?.state === 'SUCCEEDED' ? '✓' : selected === index ? '◆' : '▱';
    put(grid, slot.x - 1, slot.y, marker, color);
    if (selected === index && agent) put(grid, slot.x - Math.floor(agent.name.length / 2), slot.y + 1, truncateToWidth(agent.name, 8), color);
  });

  const lines = grid.map(row => colorize(row, theme));
  const selectedAgent = selected >= 0 ? visibleAgents[selected] : undefined;
  const selectedTask = selectedAgent ? taskByAgent.get(selectedAgent.name) : undefined;
  const info = selected === -1 ? '主 Agent · Kepos Council · Enter 输入目标' : selectedAgent ? `${selectedAgent.name} · ${selectedTask?.status || selectedTask?.state || '未激活'}${selectedTask?.reviewDue ? ' · 需要复核' : ''}` : `代表席 ${selected + 1} · 未配置`;
  lines.push(theme.fg('accent', truncateToWidth(`选中：${info}`, safeWidth)));
  if (detail && selectedTask) {
    lines.push(theme.fg('muted', truncateToWidth(`任务：${selectedTask.title || '—'} · 双击详情 · Ctrl+X 销毁 Worker`, safeWidth)));
    if (selectedTask.error) lines.push(theme.fg('error', truncateToWidth(`错误：${selectedTask.error}`, safeWidth)));
  } else lines.push(theme.fg('dim', truncateToWidth('F10 返回工作台 · ↑↓/点击选择 · 滚轮缩放 · Enter 输入', safeWidth)));
  return { lines, selected: selectedHit };
}
