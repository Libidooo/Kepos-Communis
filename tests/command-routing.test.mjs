import test from 'node:test';
import assert from 'node:assert/strict';

const { routeCommand, localCommands } = await import('../dist/terminal/command-routing.js');

// 回归：/theme 曾注册为扩展命令，却因为不在 local 白名单里掉进 native 兜底，
// 弹出“高级引擎功能 · 是否离开 Kepos”对话框——用户无法在 Kepos 内切主题。
test('theme is a native Kepos command and never falls through to the leave-Kepos prompt', () => {
  const route = routeCommand('/theme', []);
  assert.equal(route.kind, 'local');
  assert.equal(route.name, 'theme');
  // 即使 Pi 把它登记成 registered，也必须优先按 Kepos 本地命令处理。
  const withRegistered = routeCommand('/theme', [{ name: 'theme', source: 'extension' }]);
  assert.equal(withRegistered.kind, 'local');
});

test('theme accepts an explicit name without being reclassified', () => {
  const route = routeCommand('/theme kepos-light', []);
  assert.equal(route.kind, 'local');
  assert.equal(route.name, 'theme');
});

test('theme is discoverable in autocomplete', () => {
  assert.ok(localCommands.some(command => command.name === 'theme'));
});

test('genuinely native commands still route to native', () => {
  for (const name of ['settings', 'compact', 'export', 'quit']) {
    assert.equal(routeCommand('/' + name, []).kind, 'native', name + ' stays native');
  }
});

test('unknown commands are never sent to the model', () => {
  assert.equal(routeCommand('/definitely-not-a-command', []).kind, 'unknown');
});
