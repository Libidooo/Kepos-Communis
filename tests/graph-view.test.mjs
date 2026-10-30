import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGraph, renderCouncilList, councilTasks } from '../dist/terminal/graph-view.js';
import { Desk } from '../dist/terminal/desk.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { fileURLToPath } from 'node:url';

const theme = { fg: (_color, value) => value };
const agents = [{ id: 'a', name: 'A' }];

test('unassigned seats have no connection; assigned seats connect to the main Agent', () => {
  // 总理座盒自带 │ 边框，判定连线时排除中心盒附近的行。
  const withoutBox = view => view.lines.slice(0, 32).filter((_, i) => i < 12 || i > 20).join('');
  const empty = renderGraph({ agents, tasks: [] }, 100, 32, -1, 1, theme);
  assert.equal(empty.hits.length, 49);
  assert.ok(empty.lines.slice(0, 32).join('').includes('■'));
  assert.ok(empty.lines.slice(0, 32).join('').includes('○'), 'empty seats are hollow circles');
  assert.ok(!empty.lines.slice(0, 32).join('').includes('□'));
  assert.equal(/[─│╱╲┼]/.test(withoutBox(empty)), false);
  const active = renderGraph({ agents, tasks: [{ id: 'task-a', agent: 'A', state: 'RUNNING' }] }, 100, 32, -1, 1, theme);
  assert.equal(/[─│╱╲┼]/.test(withoutBox(active)), true);
  const finished = renderGraph({ agents, tasks: [{ id: 'task-a', agent: 'A', state: 'SUCCEEDED' }] }, 100, 32, -1, 1, theme);
  assert.equal(/[─│╱╲┼]/.test(withoutBox(finished)), false);
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
  const sub = renderGraph({ agents, tasks: [{ id: 'sub', agent: 'X', state: 'RUNNING', parentWorkerId: 'task-a' }] }, 100, 32, 1, 1, theme);
  assert.equal(sub.hits.find(hit => hit.id === 'task:sub')?.taskId, 'sub');
  assert.equal(sub.hits.find(hit => hit.id === 'agent:a')?.taskId, undefined);
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

test('edges carry the group color while markers keep the state color', () => {
  const colored = { fg: (color, value) => `[${color}]${value}` };
  // groupKey 'c' hashes to palette slot 3 (accent), which goes through theme.fg.
  const task = { id: 'w', agent: 'A', state: 'RUNNING', groupKey: 'c' };
  const frame = renderGraph({ agents, tasks: [task] }, 100, 24, -1, 1, colored, false, {}, 0);
  const body = frame.lines.slice(0, 24).join('');
  assert.ok(body.includes('[accent]─') || body.includes('[accent]│'), 'edge uses the group palette');
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

test('human approval uses a bright hammer and a bounded two-frame tremble', () => {
  const snapshot = { agents, tasks: [{ id: 'gate', agent: 'A', state: 'NEEDS_HUMAN', title: '等待批准' }] };
  const first = renderGraph(snapshot, 100, 24, 0, 1, theme, false, {}, 0);
  const next = renderGraph(snapshot, 100, 24, 0, 1, theme, false, {}, 400);
  assert.ok(first.lines.join('').includes('⚠'));
  assert.ok(first.lines.join('').includes('\x1b[1;38;2;255;223;84m'));
  assert.notDeepEqual(first.lines, next.lines);
  assert.deepEqual(first.hits, next.hits);
});

test('seat states distinguish idle, queued, review, success, failure and cancellation', () => {
  const view = task => renderGraph({ agents, tasks: task ? [task] : [] }, 100, 24, -1, 1, theme).lines.join('');
  assert.ok(view().includes('\x1b[38;2;116;139;129m■'));
  assert.ok(view({ id: 'queued', agent: 'A', state: 'QUEUED' }).includes('\x1b[38;2;157;126;76m■'));
  assert.ok(view({ id: 'running', agent: 'A', state: 'RUNNING', reviewDue: true }).includes('!'));
  const colored = { fg: (color, value) => `[${color}]${value}` };
  const state = value => renderGraph({ agents, tasks: [{ id: value, agent: 'A', state: value }] }, 100, 24, -1, 1, colored).lines.join('');
  assert.ok(state('SUCCEEDED').includes('[success]■'));
  assert.ok(state('FAILED').includes('[error]■'));
  assert.ok(state('CANCELLED').includes('[dim]■'));
});

test('real orbital-76 theme renders every running-task palette color without throwing', async () => {
  // The theme loader is not a public export, so import it by file path.
  const { loadThemeFromPath } = await import(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js', import.meta.url));
  const real = loadThemeFromPath(fileURLToPath(new URL('../themes/orbital-76.json', import.meta.url)), 'truecolor');
  // Character-code sums 0..3 mod 4 cover teal, blue, mauve and accent.
  const groups = ['d', 'a', 'b', 'c'];
  const crew = groups.map((name, index) => ({ id: String(index), name }));
  const tasks = groups.map((name, index) => ({ id: 'w' + index, agent: name, state: 'RUNNING', status: '运行中', groupKey: name }));
  for (const width of [100, 140]) {
    const frame = renderGraph({ agents: crew, tasks }, width, 32, 0, 1, real, true);
    assert.ok(frame.lines.some(line => line.includes('\x1b[38;2;142;181;173m')), 'teal is emitted directly');
    assert.ok(frame.lines.some(line => line.includes('\x1b[38;2;153;172;187m')), 'blue is emitted directly');
    assert.ok(frame.lines.some(line => line.includes('\x1b[38;2;181;160;173m')), 'mauve is emitted directly');
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
  assert.notDeepEqual(run(0).lines, run(600).lines, 'running seat alternates ■/▪');
  const queued = now => renderGraph({ agents, tasks: [{ id: 'q', agent: 'A', state: 'QUEUED' }] }, 100, 24, -1, 1, theme, false, {}, now);
  assert.deepEqual(queued(0).lines, queued(600).lines, 'queued seat is static');
});

test('real seats spread evenly around the ring and the center is the 总理', () => {
  const crew = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: 'R' + i }));
  const tasks = crew.slice(0, 4).map((agent, i) => ({ id: 'w' + i, agent: agent.name, state: 'RUNNING' }));
  const view = renderGraph({ agents: crew, tasks }, 140, 40, -1, 1, theme);
  const slots = view.hits.slice(1).map((hit, i) => hit.taskId ? i : -1).filter(i => i >= 0);
  assert.deepEqual(slots, [0, 4, 8, 12], 'occupied slots are evenly interleaved with empty ones');
  assert.ok(view.lines.join('').includes('总理'), 'center node is the 总理');
  assert.ok(view.lines.join('').includes('·'), 'orbit track drawn as dim dots');
});

test('multi-ring layouts keep sequential seat indexes so selection and cancel address real nodes', () => {
  const agents40 = Array.from({ length: 40 }, (_, i) => ({ id: 'a' + i, name: 'A' + i }));
  const tasks = agents40.slice(0, 20).map((agent, i) => ({ id: 't' + i, agent: agent.name, state: 'RUNNING' }));
  // 20 个活跃任务触发多环分支；hits[0] 是总理座（index=-1），其后必须严格 0..n-1。
  const view = renderGraph({ agents: agents40, tasks }, 100, 40, -1, 1, theme);
  assert.equal(view.hits.length, 49);
  view.hits.slice(1).forEach((hit, i) => assert.equal(hit.index, i, `hit ${i} must carry index ${i}`));
  const selected = renderGraph({ agents: agents40, tasks }, 100, 40, 5, 1, theme);
  assert.equal(selected.selected.index, 5, 'selected index resolves to the addressed node');
});

test('single-ring slot collisions never drop real nodes', () => {
  // 47 个席位：k=47 的槽位舍入后与 k=0 碰撞，旧实现会静默覆盖第一个席位。
  const agents47 = Array.from({ length: 47 }, (_, i) => ({ id: 'a' + i, name: 'A' + i }));
  const view = renderGraph({ agents: agents47, tasks: [] }, 100, 40, -1, 1, theme);
  const ids = new Set(view.hits.map(hit => hit.id));
  for (const agent of agents47) assert.ok(ids.has('agent:' + agent.id), 'agent ' + agent.id + ' must survive the layout');
  assert.deepEqual(view.hits.slice(1).map(hit => hit.index).sort((a, b) => a - b), [...Array(48).keys()]);
});
