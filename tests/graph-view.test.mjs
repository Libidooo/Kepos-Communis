import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGraph } from '../dist/terminal/graph-view.js';
import { Desk } from '../dist/terminal/desk.js';
import { visibleWidth } from '@earendil-works/pi-tui';

const theme = { fg: (_color, value) => value };
const agents = [{ id: 'a', name: 'A' }];

test('unassigned seats have no connection; assigned seats connect to the main Agent', () => {
  const empty = renderGraph({ agents, tasks: [] }, 120, 32, -1, 1, theme);
  assert.equal(empty.hits.length, 49);
  assert.ok(empty.lines.slice(0, 32).join('').includes('■'));
  assert.ok(empty.lines.slice(0, 32).join('').includes('□'));
  assert.equal(/[─│╱╲┼]/.test(empty.lines.slice(0, 32).join('')), false);
  const active = renderGraph({ agents, tasks: [{ id: 'task-a', agent: 'A', state: 'RUNNING' }] }, 120, 32, -1, 1, theme);
  assert.equal(/[─│╱╲┼]/.test(active.lines.slice(0, 32).join('')), true);
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
  assert.ok(first.lines.join('').includes('⚒'));
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
