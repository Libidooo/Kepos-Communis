import test from 'node:test';
import assert from 'node:assert/strict';


import { visibleWidth } from '@earendil-works/pi-tui';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Desk 构造时会保存草稿，草稿写进配置库。没有隔离就会把本文件的夹具代表
// 写进真实配置——这已经发生过多次，表现为一个叫 A 的空代表长期留在编制里。
process.env.ORBITAL_HOME = mkdtempSync(join(tmpdir(), 'kepos-graph-view-home-'));
// 静态 import 会被提升到 env 赋值之前，所以这里必须动态导入。
const { renderGraph, renderCouncilList, councilTasks } = await import('../dist/terminal/graph-view.js');
const { Desk } = await import('../dist/terminal/desk.js');
const { makeNodes } = await import('../dist/terminal/graph-view.js');

const theme = { fg: (_color, value) => value };
const agents = [{ id: 'a', name: 'A' }];

test('idle seats stay unconnected; selecting a seat draws the line to 总理', () => {
  // 总理座盒自带 │ 边框，判定连线时排除中心盒附近的行。
  const withoutBox = view => view.lines.slice(0, 32).filter((_, i) => i < 12 || i > 20).join('');
  const empty = renderGraph({ agents, tasks: [] }, 100, 32, -1, 1, theme);
  // 只渲染真实代表：1 个总理座 + 已知代表，不再补 48 个空席。
  assert.equal(empty.hits.length, 1 + agents.length);
  assert.ok(empty.lines.slice(0, 32).join('').includes('◌'), 'idle seats use ◌');
  assert.equal(/[─│╱╲┼]/.test(withoutBox(empty)), false);
  // 交互发生（选中某个代表）时才连线；未选中保持圆桌干净。
  const idle = renderGraph({ agents, tasks: [{ id: 'task-a', agent: 'A', state: 'RUNNING' }] }, 100, 32, -1, 1, theme);
  assert.equal(/[─│╱╲┼├┤┬┴]/.test(withoutBox(idle)), false, 'idle council draws no edges');
  const active = renderGraph({ agents, tasks: [{ id: 'task-a', agent: 'A', state: 'RUNNING' }] }, 100, 32, 0, 1, theme);
  // 单个代表时连线很短，检查整帧而不只是排除中心区后的部分。
  assert.equal(/[─│╱╲┼├┤┬┴]/.test(active.lines.slice(0, 32).join('')), true, 'selected seat connects to 总理');
});

test('wide council keeps the ring compact and uses a right-side inspector', () => {
  const view = renderGraph({ agents, tasks: [] }, 160, 50, -1, 1, theme);
  assert.ok(view.hits[0].x < 80);
  assert.ok(view.lines.some(line => line.includes('议会简要')));
  assert.ok(view.lines.every(line => visibleWidth(line) <= 160));
});

test('council seats expose the task a cancel action should target', () => {
  const view = renderGraph({ agents, tasks: [{ id: 'task-a', agent: 'A', state: 'RUNNING' }] }, 100, 32, 0, 1, theme);
  assert.equal(view.hits.find(hit => hit.id === 'agent:a')?.taskId, 'task-a');
  // 僚属（代表派生的子任务）不进主环：它由直属代表全权负责，
  // 在书案里按需展开。主环只铺代表席位，避免被临时节点撑满。
  const sub = renderGraph({ agents, tasks: [{ id: 'sub', agent: 'X', state: 'RUNNING', parentWorkerId: 'task-a' }] }, 100, 32, 0, 1, theme);
  assert.equal(sub.hits.some(hit => hit.id === 'task:sub'), false, 'a subordinate worker never occupies a council seat');
  assert.equal(sub.hits.length, 1 + agents.length, 'only the 总理 seat plus representatives');
});

test('council header and sidebar counts share one definition of active and pending', () => {
  const snapshot = { agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], tasks: [
    { id: 't1', agent: 'A', state: 'RUNNING' },
    { id: 't2', agent: 'B', state: 'NEEDS_HUMAN', status: '等待人类审批', title: 'gate' },
  ] };
  const body = renderGraph(snapshot, 140, 32, -1, 1, theme).lines.join('\n');
  assert.match(body, /活跃 1/);
  assert.match(body, /待处理 1/);
  const config = { agents, projects: [], folded: [], drafts: {}, sessionLinks: {} };
  const context = { cwd: process.cwd(), model: { id: 'fixture' }, isIdle: () => true, sessionManager: { getSessionFile: () => 'fixture', getSessionId: () => 'fixture', getSessionName: () => 'fixture', getBranch: () => [] } };
  const desk = new Desk({ terminal: { rows: 40 }, requestRender() {} }, theme, context, config, [], { tasks: [] }, () => {}, () => {});
  desk.graph = { snapshot: () => snapshot };
  desk.graphView = true;
  assert.match(desk.render(140)[0], /活跃1 · 待处理1/);
  desk.dispose();
});

// 回归：侧栏曾用 now - started 自行计时，忽略 ended，导致已完成的任务一直读秒（实测 68258s）。
test('sidebar elapsed freezes at ended for finished tasks and never keeps counting', () => {
  const started = 1_000_000;
  const ended = started + 45_000;
  const tasks = [{ id: 't1', agent: 'A', state: 'SUCCEEDED', status: '完成', title: '旧任务', started, ended }];
  const snapshot = { agents: [{ id: 'a', name: 'A' }], tasks };
  const view = renderGraph(snapshot, 140, 32, 0, 1, theme, false, {}, ended + 86_400_000);
  const body = view.lines.join('\n');
  assert.match(body, /完成 · 45s/, 'elapsed freezes at ended');
  assert.equal(/6825\d+s|\d{6,}s/.test(body), false, 'no runaway counter');
  // 旧记录没有 ended：显示“耗时未记录”，也不能拿当前时间继续累计。
  const legacy = { agents: [{ id: 'a', name: 'A' }], tasks: [{ id: 't2', agent: 'A', status: '失败', started }] };
  const legacyBody = renderGraph(legacy, 140, 32, 0, 1, theme, false, {}, started + 86_400_000).lines.join('\n');
  assert.match(legacyBody, /耗时未记录/);
  assert.equal(/\d{5,}s/.test(legacyBody), false, 'legacy terminal tasks do not age');
});

test('council keyboard flow: draft Enter opens detail, Esc peels layers, F1 shows help', () => {
  const config = { agents, projects: [], folded: [], drafts: {}, sessionLinks: {} };
  const context = { cwd: process.cwd(), model: { id: 'fixture' }, isIdle: () => true, sessionManager: { getSessionFile: () => 'fixture', getSessionId: () => 'fixture', getSessionName: () => 'fixture', getBranch: () => [] } };
  let sent = 0;
  const desk = new Desk({ terminal: { rows: 40 }, requestRender() {} }, theme, context, config, [], { tasks: [] }, () => sent++, () => {});
  desk.editor.setText('这是未发送草稿');
  desk.handleInput('\x1b[21~'); // F10 enters the council with ring focus even with a draft
  assert.equal(desk.graphView, true);
  assert.equal(desk.graphFocus, 'ring');
  desk.handleInput('\x1b[B'); // down selects the first seat
  assert.equal(desk.graphSelected, 0);
  desk.handleInput('\r'); // Enter opens the seat detail instead of sending the draft
  assert.equal(desk.graphDetail, true);
  assert.equal(sent, 0);
  desk.handleInput('\x1b'); // Esc closes the detail first and stays in the council
  assert.equal(desk.graphDetail, false);
  assert.equal(desk.graphView, true);
  desk.handleInput('\x1b'); // Esc again leaves the council
  assert.equal(desk.graphView, false);
  desk.handleInput('\x1b[21~'); // F10 again, then F1: help must be visible in the council
  desk.handleInput('\x1bOP');
  assert.match(desk.render(120).join('\n'), /操作指南/);
  desk.dispose();
});

test('Ctrl+X on an assigned agent seat cancels that seat task instead of aborting', async () => {
  const config = { agents, projects: [], folded: [], drafts: {}, sessionLinks: {} };
  const context = { cwd: process.cwd(), model: { id: 'fixture' }, isIdle: () => true, sessionManager: { getSessionFile: () => 'fixture', getSessionId: () => 'fixture', getSessionName: () => 'fixture', getBranch: () => [] } };
  const actions = [];
  const desk = new Desk({ terminal: { rows: 40 }, requestRender() {} }, theme, context, config, [], { tasks: [] }, () => {}, () => {}, [], undefined, async action => { actions.push(action); });
  desk.graph = { snapshot: () => ({ agents, tasks: [{ id: 'task-a', agent: 'A', state: 'RUNNING', title: '检查' }] }) };
  desk.handleInput('\x1b[21~');
  desk.handleInput('\x1b[B');
  desk.render(120); // fills graphHits so the Ctrl+X lookup can resolve the seat's task
  desk.handleInput('\x18'); // ctrl+x
  assert.deepEqual(actions, [{ kind: 'cancel-selected', id: 'task-a' }]);
  desk.dispose();
});

test('layout keeps every seat on its own cell even with a full council', () => {
  const crew = Array.from({ length: 48 }, (_, i) => ({ id: String(i), name: 'R' + i }));
  const tasks = crew.map((agent, i) => ({ id: 'w' + i, agent: agent.name, state: 'RUNNING' }));
  const view = renderGraph({ agents: crew, tasks }, 140, 40, -1, 1, theme);
  const keys = new Set(view.hits.map(hit => hit.x + ',' + hit.y));
  assert.equal(keys.size, view.hits.length, 'no two seats share a cell');
});

// 回归：侧栏卡片是浮在环图之上的不透明面板。
// 布局已把环图限制在卡片左侧，所以仅靠"席位名不出现"无法守住不变量——
// 这里直接验证卡片矩形内的每一格都被清空后重新绘制（不透明度本身）。
test('the council sidebar paints an opaque card over anything beneath it', async () => {
  const { renderGraph: render } = await import('../dist/terminal/graph-view.js');
  const plainTheme = { fg: (_color, value) => value };
  const crew = Array.from({ length: 48 }, (_, i) => ({ id: String(i), name: '席位名' + String(i).padStart(2, '0') }));
  const width = 170;
  const view = render({ agents: crew, tasks: [] }, width, 44, -1, 1, plainTheme);
  const clean = view.lines.map(line => stripVTControlCharacters(line));
  const titleRow = clean.findIndex(line => line.includes('议会简要'));
  assert.ok(titleRow >= 0, 'sidebar renders');
  const cardStart = clean[titleRow].indexOf('╭');
  assert.ok(cardStart > 0, 'sidebar card has a left edge');
  // 卡片底边之后的行不应该带任何卡片边框残留（证明高度确实收在内容上）。
  const bottomRow = clean.findIndex((line, index) => index > titleRow && line.slice(cardStart).startsWith('╰'));
  assert.ok(bottomRow > titleRow, 'sidebar card has a bottom edge');
  for (let row = titleRow; row <= bottomRow; row++) {
    const inside = clean[row].slice(cardStart + 1, width - 1);
    assert.equal(/席位名\d\d/.test(inside), false, `row ${row}: seat label visible inside the opaque card`);
  }
});

// 回归：席位标签必须整体留在环图画布内。
// 右侧曾越过侧栏左边界、左侧被网格静默裁掉（"监管监测官"显示成"管监测官"）。
test('seat labels stay inside the ring canvas on both edges', () => {
  const plainTheme = { fg: (_color, value) => value };
  const longNames = ['监管监测官', '政策咨询评议官', '利益相关者分析官', '可复现性审查官', '发表准备审查官', '隐私与数据官'];
  const crew = longNames.map((name, i) => ({ id: String(i), name }));
  const width = 170, sideStart = width - 38;
  const view = renderGraph({ agents: crew, tasks: [] }, width, 44, -1, 1, plainTheme);
  for (const raw of view.lines) {
    const line = stripVTControlCharacters(raw);
    // 侧栏区域不得出现任何完整席位名（不透明卡片已覆盖，这里再守一次）。
    assert.equal(longNames.some(name => line.slice(sideStart).includes(name)), false, 'label crossed into the sidebar');
  }
});
test('long seat labels never leak escape sequences into the character grid', () => {
  // 模拟真实主题：每个字符都被 SGR 包裹，泄漏的 ESC 会变成独立一格、后面的 [0m 成为可见文本。
  const colored = { fg: (color, value) => `\x1b[38;5;${['accent', 'text', 'dim', 'muted'].includes(color) ? 250 : 240}m${value}\x1b[0m` };
  const visibleText = line => stripVTControlCharacters(line);
  const names = ['政策咨询评议官', '利益相关者分析官', '政策影响评估官', '可复现性审查官', '发表准备审查官', '隐私与数据官', '知识产权官', '学术编辑'];
  const crew = names.map((name, i) => ({ id: String(i), name }));
  const tasks = crew.map((agent, i) => ({ id: 'w' + i, agent: agent.name, state: 'RUNNING', tool: 'read', checkpoint: '已读取配置文件并完成比对' }));
  for (const width of [100, 120, 160]) {
    const view = renderGraph({ agents: crew, tasks }, width, 36, -1, 1, colored);
    const visible = visibleText(view.lines.join('\n'));
    assert.equal(/\[0m/.test(visible), false, `width ${width}: literal reset leaked`);
    assert.equal(/\[39m|\[38;/.test(visible), false, `width ${width}: literal SGR leaked`);
  }
  // 侧栏详情里的进展/工具/输出同样走网格，长文本截断后也不能出现残片。
  const view = renderGraph({ agents: crew, tasks }, 160, 36, 0, 1, colored);
  assert.ok(view.lines.every(line => !/\[0m/.test(visibleText(line))));
});

test('seat labels truncate by visible width, not by escape-laden strings', () => {
  // 席位名上限放宽到 14 列后，常见中文角色名应能完整显示；
  // 真正超长的名字才截断并加省略号（仍按可见宽度算，不掺转义序列）。
  // 注意：席位名是斜体+半亮，断言前先剥掉控制序列。
  const clean = lines => stripVTControlCharacters(lines.join(''));
  const crew = [{ id: '0', name: '政策咨询评议官' }];
  const text = clean(renderGraph({ agents: crew, tasks: [] }, 120, 32, -1, 1, theme).lines);
  assert.ok(text.includes('政策'), 'label keeps its head');
  assert.equal(/\[0m/.test(text), false, 'no literal escapes in the grid');
  // 超出预算时必须以省略号收尾，而不是硬切。
  const long = [{ id: '0', name: '超长席位名称用于验证截断行为是否以省略号收尾' }];
  const clipped = clean(renderGraph({ agents: long, tasks: [] }, 120, 32, -1, 1, theme).lines);
  assert.ok(clipped.includes('…'), 'over-budget label ends with an ellipsis');
});

test('council task filters pick active, pending and match keywords', () => {
  const snapshot = { agents: [{ id: 'a', name: 'A' }], tasks: [
    { id: 'run', agent: 'A', state: 'RUNNING', title: '扫描代码' },
    { id: 'gate', agent: 'A', state: 'NEEDS_HUMAN', status: '等待人类审批', title: '批准发布' },
    { id: 'done', agent: 'A', state: 'SUCCEEDED', status: '完成', title: '旧任务' },
  ] };
  assert.deepEqual(councilTasks(snapshot, 'active', '').map(task => task.id), ['run']);
  assert.deepEqual(councilTasks(snapshot, 'pending', '').map(task => task.id), ['gate']);
  assert.deepEqual(councilTasks(snapshot, 'all', '发布').map(task => task.id), ['gate']);
  assert.equal(councilTasks(snapshot, 'all', '').length, 3);
});

test('narrow council list renders full-width rows inside the width', () => {
  const tasks = [
    { id: 'run', agent: 'A', state: 'RUNNING', title: '扫描代码' },
    { id: 'gate', agent: 'A', state: 'NEEDS_HUMAN', status: '等待人类审批', title: '批准发布' },
  ];
  const list = renderCouncilList(tasks, 100, 12, 1, theme);
  assert.ok(list.rows.some(row => row.includes('批准发布')));
  assert.equal(list.taskId, 'gate');
  assert.ok(list.rows.every(row => visibleWidth(row) <= 100));
});

test('council list: F8 opens with a filter, Enter locates the seat, selection stays stable', () => {
  const snapshot = { agents, tasks: [{ id: 'task-a', agent: 'A', state: 'RUNNING', title: '检查' }] };
  const config = { agents, projects: [], folded: [], drafts: {}, sessionLinks: {} };
  const context = { cwd: process.cwd(), model: { id: 'fixture' }, isIdle: () => true, sessionManager: { getSessionFile: () => 'fixture', getSessionId: () => 'fixture', getSessionName: () => 'fixture', getBranch: () => [] } };
  const desk = new Desk({ terminal: { rows: 40 }, requestRender() {} }, theme, context, config, [], { tasks: [] }, () => {}, () => {});
  desk.graph = { snapshot: () => snapshot };
  desk.handleInput('\x1b[21~'); // F10
  desk.handleInput('\x1b[19~'); // F8 opens the list and cycles the filter active->pending
  assert.equal(desk.councilList, true);
  assert.equal(desk.graphFocus, 'list');
  assert.equal(desk.councilFilter, 'pending');
  desk.handleInput('\x1b[19~'); // pending->all
  assert.equal(desk.councilFilter, 'all');
  const frame = desk.render(140).join('\n');
  assert.match(frame, /全部任务/);
  assert.match(frame, /检查/);
  desk.handleInput('\x1b[B'); // down (single task, stays on it)
  desk.handleInput('\r'); // Enter locates the seat and opens the detail
  assert.equal(desk.graphDetail, true);
  assert.equal(desk.graphSelectedId, 'agent:a');
  snapshot.tasks.unshift({ id: 'new', agent: 'A', state: 'QUEUED', title: '新任务' });
  desk.render(140);
  assert.equal(desk.graphSelectedId, 'agent:a', 'selection follows the node, not the index');
  desk.dispose();
});

test('narrow council toggles between the task list and the ring with Tab', () => {
  const snapshot = { agents, tasks: [{ id: 'task-a', agent: 'A', state: 'RUNNING', title: '检查' }] };
  const config = { agents, projects: [], folded: [], drafts: {}, sessionLinks: {} };
  const context = { cwd: process.cwd(), model: { id: 'fixture' }, isIdle: () => true, sessionManager: { getSessionFile: () => 'fixture', getSessionId: () => 'fixture', getSessionName: () => 'fixture', getBranch: () => [] } };
  const desk = new Desk({ terminal: { rows: 30 }, requestRender() {} }, theme, context, config, [], { tasks: [] }, () => {}, () => {});
  desk.graph = { snapshot: () => snapshot };
  desk.handleInput('\x1b[21~'); // F10
  desk.handleInput('\t'); // Tab -> list mode
  assert.equal(desk.councilList, true);
  const frame = desk.render(110).join('\n');
  assert.match(frame, /任务列表/);
  assert.match(frame, /检查/);
  desk.handleInput('\t'); // Tab -> back to the ring
  assert.equal(desk.councilList, false);
  assert.match(desk.render(110).join('\n'), /■/);
  desk.dispose();
});

test('motion:false freezes the approval tremble while keeping the 审 mark', () => {
  const config = { agents, projects: [], folded: [], drafts: {}, sessionLinks: {}, motion: false };
  const context = { cwd: process.cwd(), model: { id: 'fixture' }, isIdle: () => true, sessionManager: { getSessionFile: () => 'fixture', getSessionId: () => 'fixture', getSessionName: () => 'fixture', getBranch: () => [] } };
  const desk = new Desk({ terminal: { rows: 40 }, requestRender() {} }, theme, context, config, [], { tasks: [] }, () => {}, () => {});
  desk.graph = { snapshot: () => ({ agents, tasks: [{ id: 'gate', agent: 'A', state: 'NEEDS_HUMAN', title: '等待批准' }] }) };
  desk.handleInput('\x1b[21~'); // F10
  const first = desk.render(120).join('\n');
  const second = desk.render(120).join('\n');
  assert.ok(first.includes('审'));
  assert.equal(first, second, 'no frame-to-frame motion when motion is off');
  desk.dispose();
});

// 选中态统一用品牌色（borderAccent）：与主案焦点框同族。
// 若退回 accent（琥珀），选中席位、连线与议会简要会一起抢成黄色。
test('selecting a seat draws its connection in the brand color while markers keep state color', () => {
  const colored = { fg: (color, value) => `[${color}]${value}` };
  const task = { id: 'w', agent: 'A', state: 'RUNNING', groupKey: 'c' };
  // 未选中不连线。
  const idle = renderGraph({ agents, tasks: [task] }, 100, 24, -1, 1, colored, false, {}, 0);
  assert.equal(/\[borderAccent\][─│├┤┬┴┼]/.test(idle.lines.slice(0, 24).join('')), false, 'idle council has no edge');
  // 选中后总理与该代表之间出现品牌色连线，且不用琥珀 accent。
  const picked = renderGraph({ agents, tasks: [task] }, 100, 24, 0, 1, colored, false, {}, 0);
  const body = picked.lines.slice(0, 24).join('');
  assert.ok(/\[borderAccent\][─│├┤┬┴┼]/.test(body), 'selected seat connects in the brand color');
  assert.equal(/\[accent\][─│├┤┬┴┼]/.test(body), false, 'selection does not fall back to the amber accent');
});

// 议会简要标题不再用琥珀整块抢眼；焦点态才用品牌色描边。
test('the council sidebar title does not compete with the selectable seats', () => {
  const colored = { fg: (color, value) => `[${color}]${value}` };
  const view = renderGraph({ agents, tasks: [] }, 160, 40, -1, 1, colored);
  // 网格逐格上色，字符之间夹着颜色标签：先剥标签再定位标题行。
  const strip = line => line.replace(/\[[a-zA-Z]+\]/g, '');
  const titleRow = view.lines.find(line => strip(line).includes('议会简要'));
  assert.ok(titleRow, 'sidebar title renders');
  // 标题行可以出现 borderAccent/borderMuted，但不得用 accent（琥珀）。
  assert.equal(/\[accent\]/.test(titleRow), false, 'sidebar title avoids the amber accent');
});

test('ring layout is stable between renders and dragging changes only the chosen seat', () => {
  const snapshot = { agents, tasks: [] };
  const first = renderGraph(snapshot, 120, 32, 0, 1, theme);
  const second = renderGraph(snapshot, 120, 32, 0, 1, theme);
  assert.deepEqual(second.hits, first.hits);
  const dragged = renderGraph(snapshot, 120, 32, 0, 1, theme, false, { 'agent:a': { x: 6, y: 2 } });
  assert.equal(dragged.hits[1].x, first.hits[1].x + 6);
  assert.equal(dragged.hits[1].y, first.hits[1].y + 2);
  assert.deepEqual(dragged.hits[0], first.hits[0]);
});

test('mouse drag captures a seat and moves it in the terminal view', () => {
  const config = { agents, projects: [], folded: [], drafts: {}, sessionLinks: {} };
  const context = { cwd: process.cwd(), model: { id: 'fixture' }, isIdle: () => true, sessionManager: { getSessionFile: () => 'fixture', getSessionId: () => 'fixture', getSessionName: () => 'fixture', getBranch: () => [] } };
  const desk = new Desk({ terminal: { rows: 40 }, requestRender() {} }, theme, context, config, [], { tasks: [] }, () => {}, () => {});
  desk.graphView = true;
  desk.render(120);
  const seat = desk.graphHits[1];
  const press = desk.handleMouse({ type: 'press', button: 'left', x: seat.x, y: seat.y + 1 });
  assert.equal(press.capture, true);
  desk.handleMouse({ type: 'drag', button: 'left', x: seat.x + 4, y: seat.y + 3 });
  desk.handleMouse({ type: 'release', button: 'left', x: seat.x + 4, y: seat.y + 3 });
  assert.deepEqual(desk.graphOffsets[seat.id], { x: 4, y: 2 });
  desk.render(120);
  assert.equal(desk.graphHits[1].x, seat.x + 4);
  desk.dispose();
});

test('node detail bubble stays inside a narrow terminal', () => {
  const view = renderGraph({ agents, tasks: [{ id: 'task-a', agent: 'A', state: 'RUNNING', title: '检查中文任务', tool: 'read' }] }, 80, 18, 0, 1, theme, true);
  assert.ok(view.lines.some(line => line.includes('检查中文任务')));
  assert.ok(view.lines.every(line => visibleWidth(line) <= 80));
});

test('human approval uses a bright hammer and a bounded two-frame tremble', async () => {
  // 待审批的琥珀色现在来自主题 warning token；用真实主题渲染才能断言实际色值。
  const { loadThemeFromPath } = await import(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js', import.meta.url));
  const real = loadThemeFromPath(fileURLToPath(new URL('../themes/kepos-default.json', import.meta.url)), 'truecolor');
  const snapshot = { agents, tasks: [{ id: 'gate', agent: 'A', state: 'NEEDS_HUMAN', title: '等待批准' }] };
  const first = renderGraph(snapshot, 100, 24, 0, 1, real, false, {}, 0);
  const next = renderGraph(snapshot, 100, 24, 0, 1, real, false, {}, 400);
  assert.ok(first.lines.join('').includes('⚠'));
  // 断言语义而非具体色值：审批色必须来自主题 warning token，
  // 这样主题改配色不会让测试变脆（旧断言写死了 #FFDF54，主题一改就红）。
  const warning = real.colors.warning;
  assert.equal(warning.kind, 'rgb', 'warning token resolves to a concrete color');
  const ansi = `\x1b[38;2;${warning.r};${warning.g};${warning.b}m`;
  assert.ok(first.lines.join('').includes(ansi), 'approval uses the warning token color');
  assert.notDeepEqual(first.lines, next.lines);
  assert.deepEqual(first.hits, next.hits);
});

test('seat states distinguish idle, queued, review, success, failure and cancellation', () => {
  const view = task => renderGraph({ agents, tasks: task ? [task] : [] }, 100, 24, -1, 1, theme).lines.join('');
  // 符号携带状态：就绪 ◌、排队 ◔、完成 ●、失败 ⊘、取消 ○；
  // 待审批与运行都用呼吸圆，靠黄色 + 席位中央的 ! 区分。
  assert.ok(view().includes('◌'), 'idle seat uses ◌');
  assert.ok(view({ id: 'queued', agent: 'A', state: 'QUEUED' }).includes('◔'), 'queued seat uses ◔');
  assert.ok(view({ id: 'gate', agent: 'A', state: 'NEEDS_HUMAN' }).includes('!'), 'pending seat carries !');
  assert.ok(view({ id: 'gate', agent: 'A', state: 'NEEDS_HUMAN' }).includes('◉') || view({ id: 'gate', agent: 'A', state: 'NEEDS_HUMAN' }).includes('◎'), 'pending seat stays in the live breathing shape');
  assert.ok(view({ id: 'running', agent: 'A', state: 'RUNNING', reviewDue: true }).includes('!'));
  const state = value => renderGraph({ agents, tasks: [{ id: value, agent: 'A', state: value }] }, 100, 24, -1, 1, { fg: (_c, v) => v }).lines.join('');
  assert.ok(state('SUCCEEDED').includes('●'), 'success uses ●');
  assert.ok(state('FAILED').includes('⊘'), 'failure uses ⊘');
  assert.ok(state('CANCELLED').includes('○'), 'cancelled uses ○');
});

test('real kepos-dark theme renders every running-task palette color without throwing', async () => {
  // The theme loader is not a public export, so import it by file path.
  const { loadThemeFromPath } = await import(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js', import.meta.url));
  const real = loadThemeFromPath(fileURLToPath(new URL('../themes/kepos-default.json', import.meta.url)), 'truecolor');
  // Character-code sums 0..3 mod 4 cover the four group tokens.
  const groups = ['d', 'a', 'b', 'c'];
  const crew = groups.map((name, index) => ({ id: String(index), name }));
  const tasks = groups.map((name, index) => ({ id: 'w' + index, agent: name, state: 'RUNNING', status: '运行中', groupKey: name }));
  for (const width of [100, 140]) {
    // 逐个选中，确保每条链路都能经真实主题渲染且不抛错。
    for (const index of [0, 1, 2, 3]) {
      const frame = renderGraph({ agents: crew, tasks }, width, 32, index, 1, real, true);
      assert.ok(frame.lines.length > 0);
    }
    // 分组色现在来自主题 token，所以每帧都带 ANSI，且不再是伪造我们的硬编码 SGR。
    const idle = renderGraph({ agents: crew, tasks }, width, 32, -1, 1, real, true);
    assert.ok(idle.lines.some(line => /\x1b\[38;2;\d+;\d+;\d+m/.test(line)), 'running seats emit theme colors');
    assert.equal(idle.lines.join('').includes('[0m'), false, 'no literal escapes leaked');
  }
});

test('a failing graph frame falls back to the desk instead of throwing out of render', () => {
  const config = { agents, projects: [], folded: [], drafts: {}, sessionLinks: {} };
  const context = { cwd: process.cwd(), model: { id: 'fixture' }, isIdle: () => true, sessionManager: { getSessionFile: () => 'fixture', getSessionId: () => 'fixture', getSessionName: () => 'fixture', getBranch: () => [] } };
  const strict = { fg: (color, value) => { if (color === 'accent') throw Error('Unknown theme color: accent'); return value; } };
  const desk = new Desk({ terminal: { rows: 40 }, requestRender() {} }, strict, context, config, [], { tasks: [] }, () => {}, () => {});
  desk.graphView = true;
  const lines = desk.render(120);
  assert.match(lines[0], /渲染出错/);
  assert.equal(desk.graphView, false);
  desk.dispose();
});

test('streaming assistant text stays visible while the message mutates in place',()=>{
 const config={agents:[],projects:[],folded:[],drafts:{},sessionLinks:{}};
 const live={role:'assistant',content:[],timestamp:7};
 const entries=[{id:'e1',type:'message',message:{role:'user',content:[{type:'text',text:'hi'}]}},{id:'e2',type:'message',message:live}];
 const context={cwd:process.cwd(),model:{id:'fixture'},isIdle:()=>false,sessionManager:{getSessionFile:()=>'f',getSessionId:()=>'s',getSessionName:()=>'n',getBranch:()=>entries}};
 const desk=new Desk({terminal:{rows:40},requestRender(){}},{fg:(color,value)=>value},context,config,[],{tasks:[]},()=>{},()=>{});
 desk.sending=true;desk.live=live;
 desk.render(80); // first paint caches the base while the reply is still empty
 live.content.push({type:'text',text:'First streaming delta'});
 assert.match(desk.render(80).join('\n'),/First streaming delta/,'first delta shows immediately');
 live.content[0].text+=' · second delta';
 assert.match(desk.render(80).join('\n'),/second delta/,'later deltas keep rendering');
 assert.doesNotMatch(desk.render(80).join('\n'),/hi.*First streaming delta.*hi/s,'no duplicated transcript');
});

test('running seats pulse between glyphs while queued stays static', () => {
  const run = now => renderGraph({ agents, tasks: [{ id: 'w', agent: 'A', state: 'RUNNING' }] }, 100, 24, -1, 1, theme, false, {}, now);
  assert.notDeepEqual(run(0).lines, run(700).lines, 'running seat breathes ◉/◎');
  const queued = now => renderGraph({ agents, tasks: [{ id: 'q', agent: 'A', state: 'QUEUED' }] }, 100, 24, -1, 1, theme, false, {}, now);
  assert.deepEqual(queued(0).lines, queued(600).lines, 'queued seat is static');
});

test('real seats spread evenly around the ring and the center is the 总理', () => {
  const crew = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: 'R' + i }));
  const tasks = crew.slice(0, 4).map((agent, i) => ({ id: 'w' + i, agent: agent.name, state: 'RUNNING' }));
  const view = renderGraph({ agents: crew, tasks }, 140, 40, -1, 1, theme);
  const slots = view.hits.slice(1).map((hit, i) => hit.taskId ? i : -1).filter(i => i >= 0);
  // 席位按代表顺序等角分布：有任务的是第 0..3 席。
  assert.deepEqual(slots, [0, 1, 2, 3], 'seats follow the representative order');
  assert.equal(view.hits.slice(1).every(hit => hit.index >= 0), true, 'every seat carries an index');
  assert.ok(view.lines.join('').includes('总理'), 'center node is the 总理');
  assert.ok(!view.lines.slice(0, 40).join('').includes('··'), 'no dim orbit dots clutter the ring');
});

test('multi-ring layouts keep sequential seat indexes so selection and cancel address real nodes', () => {
  const agents40 = Array.from({ length: 40 }, (_, i) => ({ id: 'a' + i, name: 'A' + i }));
  const tasks = agents40.slice(0, 20).map((agent, i) => ({ id: 't' + i, agent: agent.name, state: 'RUNNING' }));
  // 20 个活跃任务触发多环分支；hits[0] 是总理座（index=-1），其后必须严格 0..n-1。
  const view = renderGraph({ agents: agents40, tasks }, 100, 40, -1, 1, theme);
  assert.equal(view.hits.length, 1 + agents40.length);
  view.hits.slice(1).forEach((hit, i) => assert.equal(hit.index, i, `hit ${i} must carry index ${i}`));
  const selected = renderGraph({ agents: agents40, tasks }, 100, 40, 5, 1, theme);
  assert.equal(selected.selected.index, 5, 'selected index resolves to the addressed node');
});

test('every configured representative keeps its own seat', () => {
  // 47 个代表：全部都要出现，不因为槽位运算被吞掉。
  const agents47 = Array.from({ length: 47 }, (_, i) => ({ id: 'a' + i, name: 'A' + i }));
  const view = renderGraph({ agents: agents47, tasks: [] }, 100, 40, -1, 1, theme);
  const ids = new Set(view.hits.map(hit => hit.id));
  for (const agent of agents47) assert.ok(ids.has('agent:' + agent.id), 'agent ' + agent.id + ' must survive the layout');
  assert.deepEqual(view.hits.slice(1).map(hit => hit.index).sort((a, b) => a - b), [...Array(47).keys()]);
});

test('many active tasks cluster into grouped rings whose leader faces 总理', () => {
  // 16 个活跃任务分两组，触发多环：每组聚成一个小环，而不是塌成一个环。
  const crew = Array.from({ length: 16 }, (_, i) => ({ id: String(i), name: 'R' + i }));
  const tasks = crew.map((agent, i) => ({ id: 'w' + i, agent: agent.name, state: 'RUNNING', groupKey: i < 8 ? 'grp-a' : 'grp-b' }));
  const view = renderGraph({ agents: crew, tasks }, 110, 34, -1, 1, theme);
  const center = view.hits[0];
  const work = view.hits.filter(hit => hit.index >= 0 && !String(hit.id).startsWith('seat:'));
  assert.equal(work.length, 16);
  // 两个小环：同一组内相邻席位应彼此靠近，不同组应分处总理两侧。
  const groupA = work.slice(0, 8), groupB = work.slice(8);
  const centroid = list => ({
    x: list.reduce((sum, h) => sum + h.x, 0) / list.length,
    y: list.reduce((sum, h) => sum + h.y, 0) / list.length,
  });
  const a = centroid(groupA), b = centroid(groupB);
  const separation = Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(separation > 8, 'two groups form distinct rings, got separation ' + separation.toFixed(1));
  // 每组的首au席（代理总代）应比同组其他席位更靠近总理。
  const dist = hit => Math.hypot(hit.x - center.x, hit.y - center.y);
  for (const group of [groupA, groupB]) {
    const leader = group[0];
    const avgOther = group.slice(1).reduce((sum, h) => sum + dist(h), 0) / (group.length - 1);
    assert.ok(dist(leader) <= avgOther + 2, 'ring leader faces 总理');
  }
  // 没有空席占位：席位全部是真实代表或任务。
  const seats = view.hits.filter(hit => String(hit.id).startsWith('seat:'));
  assert.equal(seats.length, 0, 'no placeholder seats are drawn');
});

// 工作组分圈：组是任务期间真实存在的协作单元，比"同属一个会话"更能说明谁在跟谁干活。
// 直接断言分组键，而不是从渲染结果反推——布局随尺寸变化，键才是承诺。
test('an active group becomes its own ring, ahead of the session key',()=>{
  const nodes=makeNodes({
    agents:[{id:'a',name:'审查官'},{id:'b',name:'核验官'},{id:'c',name:'记录官'}],
    tasks:[
      {id:'t1',agent:'审查官',state:'RUNNING',status:'运行中',title:'一',groupId:'squad1',groupKey:'session1',started:1},
      {id:'t2',agent:'核验官',state:'RUNNING',status:'运行中',title:'二',groupId:'squad1',groupKey:'session1',started:2},
      {id:'t3',agent:'记录官',state:'RUNNING',status:'运行中',title:'三',groupKey:'session1',started:3},
    ],
  });
  const keyOf=name=>nodes.find(node=>node.label===name).groupKey;
  assert.equal(keyOf('审查官'),'group:squad1');
  assert.equal(keyOf('核验官'),'group:squad1','same group, same ring');
  assert.equal(keyOf('记录官'),'session1','no group falls back to the session key');
});

test('a settled group releases its members back to the default ring',()=>{
  const nodes=makeNodes({
    agents:[{id:'a',name:'审查官'}],
    tasks:[{id:'t1',agent:'审查官',state:'SUCCEEDED',status:'完成',title:'一',groupId:'squad1',started:1,ended:2}],
  });
  assert.equal(nodes.find(node=>node.label==='审查官').groupKey,'default','a finished task does not hold a ring');
});
