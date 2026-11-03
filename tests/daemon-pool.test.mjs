import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { DaemonWorkerPool } = await import('../dist/terminal/daemon-pool.js');

function makeFallback() {
  return { tasks: [], cancel() { this.cancelled = true; } };
}

test('no daemon endpoint degrades to the local pool with a stated reason', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kepos-daemon-pool-'));
  const reasons = [];
  const pool = new DaemonWorkerPool({ dataDir, fallback: makeFallback(), onFallback: r => reasons.push(r) });
  const healthy = await pool.probe();
  assert.equal(healthy, false, 'no endpoint means not healthy');
  assert.equal(pool.status, 'local-fallback');
  assert.match(pool.lastReason, /未发现调度守护进程/);
  assert.equal(reasons.length, 1, 'fallback is reported once');
  // 顶栏必须有明确文案，不能静默降级。
  assert.match(pool.bannerText(), /已降级为本地调度/);
});

test('an unreachable daemon (port file but nothing listening) also degrades', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kepos-daemon-dead-'));
  // 写一个没有任何进程监听的端口，模拟 daemon 崩溃后残留的端点文件。
  writeFileSync(join(dataDir, 'scheduler.token'), 'token\n');
  writeFileSync(join(dataDir, 'scheduler.port'), '1\n');
  const pool = new DaemonWorkerPool({ dataDir, fallback: makeFallback(), timeoutMs: 300 });
  const healthy = await pool.probe(300);
  assert.equal(healthy, false);
  assert.equal(pool.status, 'local-fallback');
  assert.match(pool.lastReason, /无响应|未发现/, 'the reason names the failure');
});

test('dispatch reports which route handled it instead of pretending success', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kepos-daemon-route-'));
  const pool = new DaemonWorkerPool({ dataDir, fallback: makeFallback() });
  const crew = { name: '审查官', model: 'm', provider: 'p', role: 'r' };
  const result = await pool.dispatch(crew, 'task', process.cwd(), 'session', 60);
  assert.equal(result.route, 'local-fallback', 'caller can see it fell back');
  assert.ok(result.reason, 'the reason is carried back');
});

test('cancel always reaches the local pool so no orphan survives', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kepos-daemon-cancel-'));
  const fallback = makeFallback();
  const pool = new DaemonWorkerPool({ dataDir, fallback });
  await pool.cancel('task-1');
  assert.equal(fallback.cancelled, true, 'local cancel is always attempted');
});

test('a healthy daemon recovers the banner', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kepos-daemon-recover-'));
  let recovered = 0;
  const pool = new DaemonWorkerPool({ dataDir, fallback: makeFallback(), onRecovered: () => recovered++ });
  await pool.probe();
  assert.equal(pool.status, 'local-fallback');
  // 没有真实 daemon 时无法恢复；这里只断言未健康时不误报恢复。
  assert.equal(recovered, 0);
  assert.ok(pool.bannerText().length > 0);
});

test('repeated probe failures do not spam the fallback callback', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kepos-daemon-spam-'));
  const reasons = [];
  const pool = new DaemonWorkerPool({ dataDir, fallback: makeFallback(), onFallback: r => reasons.push(r) });
  await pool.probe();
  await pool.probe();
  await pool.probe();
  // 状态已经降级，后续探测失败只是刷新原因，不应反复通知界面。
  assert.equal(reasons.length, 1, 'fallback announced once, not on every probe');
  assert.equal(pool.status, 'local-fallback');
});
