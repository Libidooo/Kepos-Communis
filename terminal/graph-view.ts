import { truncateToWidth } from '@earendil-works/pi-tui';

export type GraphViewAgent = { id: string; name: string; model?: string; roleKey?: string };
export type GraphViewTask = { id: string; agent: string; status?: string; state?: string; title?: string; parentWorkerId?: string; delegationDepth?: number; reviewDue?: boolean; error?: string; groupKey?: string };
export type GraphViewSnapshot = { agents: GraphViewAgent[]; tasks: GraphViewTask[] };
export type GraphHit = { id: string; kind: 'main' | 'agent' | 'task'; index: number; x: number; y: number };
export type GraphOffsets = Record<string, { x: number; y: number }>;
type Cell = { char: string; color?: string };
type VisualNode = { id: string; label: string; kind: 'agent' | 'task'; task?: GraphViewTask; groupKey: string; x: number; y: number; index: number };

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
  for (let index = 0; index < text.length; index++) if (grid[y]?.[x + index]) grid[y][x + index] = { char: text[index], color };
}
function colorize(row: Cell[], theme: any): string { return row.map(cell => cell.char === ' ' ? ' ' : theme.fg(cell.color || 'text', cell.char)).join(''); }

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

function layoutNodes(nodes: VisualNode[], width: number, height: number, zoom: number, phase: number, offsets: GraphOffsets) {
  const active = nodes.filter(node => node.task).length;
  const ringCount = active > 12 ? Math.max(2, Math.ceil(nodes.length / 12)) : 1;
  const groups: VisualNode[][] = [];
  if (ringCount === 1) groups.push(nodes);
  else {
    const map = new Map<string, VisualNode[]>();
    for (const node of nodes) { const list = map.get(node.groupKey) || []; list.push(node); map.set(node.groupKey, list); }
    for (const list of map.values()) for (let index = 0; index < list.length; index += 12) groups.push(list.slice(index, index + 12));
  }
  const center = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  groups.forEach((group, ringIndex) => {
    const ringCenter = ringCount === 1 ? center : { x: Math.round(center.x + Math.cos((ringIndex / groups.length) * Math.PI * 2 - Math.PI / 2) * Math.min(width * .23, 18 * zoom)), y: Math.round(center.y + Math.sin((ringIndex / groups.length) * Math.PI * 2 - Math.PI / 2) * Math.min(height * .25, 6 * zoom)) };
    const radiusX = ringCount === 1 ? Math.max(10, Math.min(width / 2 - 5, width * .36 * zoom)) : Math.max(4, Math.min(10, 3 + group.length * .55));
    const radiusY = ringCount === 1 ? Math.max(3, Math.min(height / 2 - 3, height * .36 * zoom)) : Math.max(2, Math.min(5, 1.5 + group.length * .3));
    group.forEach((node, index) => { const angle = (index / Math.max(1, group.length)) * Math.PI * 2 - Math.PI / 2 + phase * (ringIndex % 2 ? -1 : 1); const offset = offsets[node.id] || { x: 0, y: 0 }; node.x = Math.round(ringCenter.x + Math.cos(angle) * radiusX + offset.x); node.y = Math.round(ringCenter.y + Math.sin(angle) * radiusY + offset.y); });
  });
  return { center, nodes, ringCount };
}

export function renderGraph(snapshot: GraphViewSnapshot, width: number, height: number, selected: number, zoom: number, theme: any, detail = false, offsets: GraphOffsets = {}): { lines: string[]; hits: GraphHit[]; selected: GraphHit } {
  const safeWidth = Math.max(24, width), safeHeight = Math.max(8, height);
  const grid: Cell[][] = Array.from({ length: safeHeight }, () => Array.from({ length: safeWidth }, () => ({ char: ' ' })));
  const layout = layoutNodes(makeNodes(snapshot), safeWidth, safeHeight, zoom, 0, offsets);
  const main = { id: 'main', kind: 'main' as const, index: -1, x: layout.center.x, y: layout.center.y };
  const byWorkerId = new Map(layout.nodes.filter(node => node.task).map(node => [node.task!.id, node]));
  for (const node of layout.nodes) { if (!node.task) continue; const parent = node.task.parentWorkerId ? byWorkerId.get(node.task.parentWorkerId) : undefined; line(grid, parent?.x ?? main.x, parent?.y ?? main.y, node.x, node.y, stateColor(node.task, node.index)); }
  put(grid, main.x - 1, main.y, '◉', selected === -1 ? 'accent' : 'text'); put(grid, main.x + 2, main.y, '主', 'accent');
  const hits: GraphHit[] = [main];
  for (const node of layout.nodes) { const selectedNode = selected === node.index; const color = stateColor(node.task, node.index); const marker = node.task?.reviewDue ? '!' : node.task?.state === 'FAILED' ? '×' : node.task?.state === 'SUCCEEDED' ? '✓' : selectedNode ? '◆' : '⏢'; put(grid, node.x - 1, node.y, marker, color); if (selectedNode) put(grid, node.x - Math.floor(node.label.length / 2), node.y + 1, truncateToWidth(node.label, 10), color); hits.push({ id: node.id, kind: node.kind, index: node.index, x: node.x, y: node.y }); }
  const lines = grid.map(row => colorize(row, theme));
  const selectedNode = selected >= 0 ? layout.nodes.find(node => node.index === selected) : undefined;
  const info = selected === -1 ? '主 Agent · Kepos Council · Enter 输入目标' : selectedNode ? `${selectedNode.label} · ${selectedNode.task?.status || selectedNode.task?.state || '未激活'}${selectedNode.task?.reviewDue ? ' · 需要复核' : ''}` : `代表席 ${selected + 1} · 未配置`;
  lines.push(theme.fg('accent', truncateToWidth(`选中：${info} · ${layout.ringCount} 个环`, safeWidth)));
  if (detail && selectedNode?.task) { lines.push(theme.fg('muted', truncateToWidth(`任务：${selectedNode.task.title || '—'} · 双击详情 · Ctrl+X 销毁 Worker`, safeWidth))); if (selectedNode.task.error) lines.push(theme.fg('error', truncateToWidth(`错误：${selectedNode.task.error}`, safeWidth))); }
  else lines.push(theme.fg('dim', truncateToWidth('F10 返回工作台 · ↑↓/点击选择 · 拖动节点或空白区域 · 滚轮缩放 · Enter 详情', safeWidth)));
  return { lines, hits, selected: selected === -1 ? main : hits.find(hit => hit.index === selected) || main };
}
