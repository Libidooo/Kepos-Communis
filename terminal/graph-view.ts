import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { TASK_ACTIVE_STATES, isTaskActive, isTaskCurrent, isTaskPending, taskElapsedText, taskState, type TaskStateLike } from './task-state.ts';

export type GraphViewAgent = { id: string; name: string; model?: string; roleKey?: string; deputy?: boolean };
export type GraphViewTask = TaskStateLike & { id: string; agent: string; agentId?: string; purpose?: 'delegation' | 'configuration'; internal?: boolean; title?: string; tool?: string; checkpoint?: string; output?: string; parentWorkerId?: string; delegationDepth?: number; error?: string; groupKey?: string; started?: number; ended?: number };
export type GraphViewSnapshot = { agents: GraphViewAgent[]; tasks: GraphViewTask[] };
export type GraphHit = { id: string; kind: 'main' | 'agent' | 'task'; index: number; x: number; y: number; taskId?: string };
export type GraphOffsets = Record<string, { x: number; y: number }>;
export type CouncilFilter = 'active' | 'pending' | 'all';
export type CouncilView = { list: boolean; filter: CouncilFilter; query: string; index: number; focus?: 'ring' | 'list' | 'input'; desk?: boolean };
type Cell = { char: string; color?: string; italic?: boolean; faint?: boolean; bold?: boolean };
type VisualNode = { id: string; label: string; kind: 'agent' | 'task'; task?: GraphViewTask; groupKey: string; x: number; y: number; index: number; deputy?: boolean };
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

// 颜色一律走主题 token：Pi 的 theme.fg 只认主题 colors 里的 56 个固定键，
// vars 里的原始色名（teal/blue/mauve）不是 token，直接传会抛错。
// 分组调色板因此改用语义等价且色相互不相同的既有 token：
//   toolTitle=teal, syntaxKeyword=blue, syntaxOperator=mauve, accent=amber。
// 这样浅色主题下对比度由主题保证，/theme 切换即时跟随。
const palette = ['toolTitle', 'syntaxKeyword', 'syntaxOperator', 'accent'] as const;
// 旧状态色名映射到语义 token；approval 用 warning（待审批）、queue 用 accent。
const tokenFor: Record<string, string> = { approval: 'warning', queue: 'accent', idle: 'dim' };
export const themeToken = (color: string): string => tokenFor[color] || color;
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
// 选中态用 ⬤（LARGE BLACK CIRCLE）：终端改不了字号，取"笔画更重、墨量更大"的字形
// 来表达"选中比普通席位更大一号"，再叠加粗体，读起来就是"加粗并大一点"。
export const seatGlyph = (task: GraphViewTask | undefined, selected: boolean, now: number): string => {
  if (selected) return '⬤';
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

function put(grid: Cell[][], x: number, y: number, text: string, color?: string, style?: { italic?: boolean; faint?: boolean; bold?: boolean }) {
  // 唯一网格入口必须自净：任何调用者漏传了转义序列或控制符，都在这里被剥掉，
  // 绝不能把 ESC 当成一个可见字符格写进画面。
  let column = x;
  for (const char of plain(text)) {
    // 全角字符占两格，第二格留空由 colorize 跳过，宽度账才对得上。
    const width = Math.max(1, visibleWidth(char));
    if (grid[y]?.[column]) grid[y][column] = { char, color, ...style };
    for (let offset = 1; offset < width; offset++) if (grid[y]?.[column + offset]) grid[y][column + offset] = { char: '', color, ...style };
    column += width;
  }
}
function colorize(row: Cell[], theme: any): string {
  return row.map(cell => {
    if (!cell.char) return '';
    if (cell.char === ' ') return ' ';
    // 终端字体固定、字号不可改：字重与字形就是"加粗/加大"的实际手段。
    // 席位圆环与总理圆环用 bold 加粗；斜体/半亮只用于说明性文字（席位名）。
    let text = cell.char;
    if (cell.bold) text = `\x1b[1m${text}\x1b[22m`;
    if (cell.faint) text = `\x1b[2m${text}\x1b[22m`;
    if (cell.italic) text = `\x1b[3m${text}\x1b[23m`;
    return theme.fg(themeToken(cell.color || 'text'), text);
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
  rows.push({ text: task ? `${plain(selected!.label)} 书案` : selected ? `选中 ${plain(selected.label)}` : '选中 总理', color: 'borderAccent' });
  if (task) {
    // 用统一的 elapsed 计算：终态按 ended 冻结，缺失时显示“耗时未记录”，
    // 绝不用 now - started 让旧任务无限读秒（这里曾漏掉 ended，旧任务跑到 68258s）。
    const elapsed = taskElapsedText(task, now);
    rows.push({ text: `状态 ${task.status || task.state || '—'} · ${elapsed}`, color: stateColor(task, selected!.index) });
    // 细节字段统一降一档明度（工具/进展），输出保持正文级——它是阅读主体。
    if (task.tool) rows.push({ text: `工具 ${cut(task.tool, labelWidth - 3)}`, color: 'dim' });
    if (task.checkpoint) rows.push({ text: `进展 ${cut(task.checkpoint, labelWidth - 3)}`, color: 'dim' });
    rows.push({ text: `输出 ${cut(task.output || '等待结果', labelWidth - 3)}`, color: 'text' });
    rows.push('div');
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
  // 关键：卡片是浮在环图之上的不透明面板。环图席位先画，代表名会落在卡片矩形的
  // 格子范围里；若不先清空，就会从卡片空行中透出来（截图中"档案○""软件架"穿进侧栏）。
  // 因此必须先把整块矩形抹成空格，再画边框与内容。
  for (let y = 0; y <= cardH - 1 && y < height; y++) {
    for (let cx = x; cx <= right && cx < width; cx++) grid[y][cx] = { char: ' ' };
  }
  // 标题只用品牌色描边强调"这是焦点面板"，正文与计数仍用语义色；
  // 不再整块用 accent（琥珀）——那会和选中席位、主案强调色互相抢眼。
  put(grid, x, 0, '╭' + title, focused ? 'borderAccent' : 'borderMuted');
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
    return { id: `agent:${agent.id}`, label: agent.name, kind: 'agent' as const, task: latest, groupKey: active?.groupKey || 'default', index: 0, x: 0, y: 0, deputy: agent.deputy === true };
  });
  // 主环只铺代表席位。僚属（代表派生的子任务）不占席位：
  // 48 个代表各派生若干僚属时，环图会被几十个临时节点撑满，反而看不清组织。
  // 僚属改在书案里按需展开，主界面保持干净。
  // 这一取舍也符合职责链：代表对僚属全权负责，人类在代表这一层看到足够信息。
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
      stamp(grid, edgeMask, start.x, start.y, node.x, node.y, 'borderAccent');
    }
    renderConnections(grid, edgeMask, 'borderAccent');
  }
  // 先铺线再把总理座写上去：文字永远压在最上层，不会被连接符覆盖。
  // 选中态统一走品牌色（borderAccent），与主案焦点框同族；
  // 琥珀 accent 留给"强调/活跃"，否则选中席位会和议会简要一起抢成黄色。
  put(grid, main.x - 1, main.y, '◉', selected === -1 ? 'borderAccent' : 'text', { bold: true });
  put(grid, main.x + 1, main.y, ' 总理', 'accent');
  const hits: GraphHit[] = [main];
  // 字符占用登记：席位符号与标签分属不同行/列，密集环里后画的符号会压掉先画的
  // 标签文字（截图里"性○能工程官"就是符号盖住了名字）。画之前先查这张表，
  // 已有内容的位置不再写入，保证名字始终可读。
  const taken: boolean[][] = Array.from({ length: safeHeight }, () => Array.from({ length: safeWidth }, () => false));
  const claim = (x: number, y: number, len: number) => { for (let i = 0; i < len; i++) if (taken[y]?.[x + i] !== undefined) taken[y][x + i] = true; };
  const free = (x: number, y: number, len: number) => {
    for (let i = 0; i < len; i++) if (taken[y]?.[x + i] !== false) return false;
    return true;
  };
  // 标签避让要考虑上下相邻行：符号画在 node.y、标签在 node.y+1，
  // 若只查标签自己那一行，标签就会紧贴符号画成「性能工程官◎利益相关者」。
  // 因此标签检查时把第 y-1 行也算进来（只认紧邻，不影响远处席位）。
  const freeNear = (x: number, y: number, len: number) => {
    if (!free(x, y, len)) return false;
    if (y > 0) {
      // 紧邻上/下行只要有一个被占用的格落在标签范围内，就视为拥挤。
      for (let i = -1; i <= len; i++) if (taken[y - 1]?.[x + i]) return false;
    }
    return true;
  };
  // 总理座先占位，标签绝不会压上去。
  claim(main.x - 1, main.y, 7);
  for (const node of layout.nodes) {
    const selectedNode = selected === node.index;
    const approval = node.task?.state === 'NEEDS_HUMAN';
    const color = node.task ? stateColor(node.task, node.index) : 'idle';
    // 符号本身表达状态（见 seatGlyph），颜色只负责语义分组与轻重。
    // 只有该格尚未被文字占用时才写符号，避免盖掉相邻席位已画好的名字。
    const marker = seatGlyph(node.task, selectedNode, now);
    const shake = approval ? Math.floor(now / 400) % 2 : 0;
    if (free(node.x - 1 + shake, node.y, 1)) {
      put(grid, node.x - 1 + shake, node.y, marker, color, { bold: true });
      claim(node.x - 1 + shake, node.y, 1);
    }
    // 代理总代：推选出来的兼任治理职责，不是普通席位。
    // 参考总理 ◉ 的语义，额外套一个圆环把它圈起来——「(◉)」。
    // 只在两侧有空位时套环，绝不覆盖邻座文字；套不上就退化为加粗，仍有区别。
    if (node.deputy) {
      const ringColor = selectedNode ? 'borderAccent' : 'accent';
      const lx = node.x - 2 + shake, rx = node.x + shake;
      if (free(lx, node.y, 1)) { put(grid, lx, node.y, '(', ringColor, { bold: true }); claim(lx, node.y, 1); }
      if (free(rx, node.y, 1)) { put(grid, rx, node.y, ')', ringColor, { bold: true }); claim(rx, node.y, 1); }
    }
    // 待审批：黄色运行态 + 席位中央的感叹号（沿用敲定语义，不改成静态符号）。
    if (approval) put(grid, node.x, node.y, '!', 'approval'); else if (node.task?.reviewDue) put(grid, node.x, node.y, '!', 'warning');
    // 质感：只有"活的"席位带四角光环（·），让运行态在密集圆环里也能一眼扫到；
    // 终态与空闲不带，避免背景噪点。
    if (node.task && isTaskCurrent(node.task)) {
      for (const [dx, dy, glyph] of [[-1, -1, '·'], [1, -1, '·'], [-1, 1, '·'], [1, 1, '·']] as const) {
        const gx = node.x + dx, gy = node.y + dy;
        if (gx >= 0 && gx < safeWidth && gy >= 0 && gy < safeHeight) put(grid, gx, gy, glyph, selectedNode ? 'borderAccent' : 'dim');
      }
    }
    // 名字比符号降一阶明度；未分配的席位退到背景。
    // 选中席位用品牌色高亮（与主案焦点框一致），未选中跟随状态色。
    const nameColor = selectedNode ? 'borderAccent' : stateNameColor(node.task, node.index);
    // 标签可用横向范围：留出侧栏占位。此前只按 safeWidth 判断，
    // 圆环右侧席位名会越过侧栏左边界、左侧席位名被网格静默裁掉（"监管"变"管")。
    const gutter = (safeWidth >= 120 && !council?.desk) ? 38 : 0;
    const labelMaxX = safeWidth - gutter;
    // 席位名是"说明性文字"：不参与决策阅读，因此用斜体 + 半亮降权。
    // 多环布局时席位密集，标签必须更短，否则互相挤压、看起来像乱码。
    // 预算按圆环密度收窄：单环 12 列，多环 6 列——名字只作定位提示。
    const labelBudget = layout.ringCount > 1 ? 6 : 12;
    let label = cut(node.label, Math.max(2, Math.min(labelBudget, labelMaxX)));
    const labelY = node.y + 1;
    // 以席位圆点为中心严格居中：符号画在 node.x-1，标签中心对齐 node.x-1。
    // 之前用 node.x - floor(w/2)，宽标签整体右偏半格，密集时看起来像在晃。
    let labelWidth = visibleWidth(label);
    let labelX = node.x - 1 - Math.floor(labelWidth / 2);
    labelX = Math.max(1, Math.min(labelX, labelMaxX - labelWidth - 1));
    // 只有与总理座同一行才需要避让；推不出空间就让标签让位。
    if (labelY === main.y) {
      const boxLeft = main.x - 3, boxRight = main.x + 7;
      const overlaps = labelX <= boxRight && labelX + labelWidth >= boxLeft;
      if (overlaps) {
        // 位于总理右侧的席位向右让，左侧的向左让。
        labelX = node.x >= main.x
          ? boxRight + 1
          : boxLeft - labelWidth;
        // 让位后可能出界，按剩余空间截断。
        if (labelX < 1 || labelX >= labelMaxX) {
          // 空间不足：贴边放置并截断，而不是整段丢弃（丢掉会让席位居中没有任何说明）。
          labelX = Math.max(1, Math.min(labelX, labelMaxX - 2));
          if (labelX < 1) { hits.push({ id: node.id, kind: node.kind, index: node.index, x: node.x, y: node.y, taskId: node.task?.id }); continue; }
        }
      }
    }
    // 避让已占用的格子（相邻席位的符号/标签）。先在原位置试，再左右平移找空位，
    // 仍冲突则逐步缩短标签；全都失败才放弃这段文字——绝不覆盖别人的名字。
    // 标签放宽到 14 列后更容易与邻座相撞，因此平移范围也随之扩大。
    let placed = false;
    for (let shrink = 0; shrink <= 8 && !placed; shrink++) {
      const candidate = shrink ? cut(label, Math.max(2, labelWidth - shrink)) : label;
      const width = visibleWidth(candidate);
      for (const shift of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -8, 8, -10, 10]) {
        const x = labelX + shift;
        if (x < 1 || x + width > labelMaxX) continue;
        if (!freeNear(x, labelY, width)) continue;
        put(grid, x, labelY, candidate, nameColor, { italic: true, faint: true });
        claim(x, labelY, width);
        placed = true;
        break;
      }
    }
    // 底线保底：密集布局下可能一个空位都找不到，但"席位没有名字"比"名字略微拥挤"
    // 更糟（单代表场景曾整段消失）。此时强制放在自身符号下方，宁可挤一点也不丢信息。
    if (!placed) {
      const fallback = cut(label, Math.max(2, Math.min(6, labelWidth)));
      const width = visibleWidth(fallback);
      const x = Math.max(1, Math.min(node.x - Math.floor(width / 2), labelMaxX - width - 1));
      put(grid, x, labelY, fallback, nameColor, { italic: true, faint: true });
      claim(x, labelY, width);
    }
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
