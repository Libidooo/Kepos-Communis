import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeInstruction, canResumeWorker } from '../dist/terminal/task-resume.js';

test('only interrupted, failed, and timed-out workers are resumable', () => {
  for (const state of ['INTERRUPTED', 'FAILED', 'TIMED_OUT']) assert.equal(canResumeWorker({ state }), true);
  for (const state of ['SUCCEEDED', 'CANCELLED', 'RUNNING', 'QUEUED']) assert.equal(canResumeWorker({ state }), false);
});

test('resume brief carries original task, checkpoint, output, and changed paths while resetting permissions', () => {
  const brief = buildResumeInstruction({
    id: 'old-task', state: 'INTERRUPTED', instruction: 'Fix the parser and run typecheck.',
    checkpoint: 'Updated parser.ts; starting validation.', output: 'Read parser.ts and found a missing branch.',
    changedFiles: ['src/parser.ts'], error: 'Owner process exited',
  });
  assert.match(brief, /Fix the parser and run typecheck/);
  assert.match(brief, /Updated parser\.ts; starting validation/);
  assert.match(brief, /found a missing branch/);
  assert.match(brief, /src\/parser\.ts/);
  assert.match(brief, /no previous file-write, MCP, or CLI authorization carries over/);
  assert.match(brief, /inspect the current project state before repeating any action/i);
});

test('resume brief is bounded and retains checkpoint and latest output tail', () => {
  const brief = buildResumeInstruction({
    id: 'long-task', state: 'TIMED_OUT', instruction: 'A'.repeat(20_000),
    checkpoint: 'checkpoint marker', output: 'B'.repeat(20_000) + ' latest output marker',
  });
  assert.ok(brief.length < 12_000);
  assert.match(brief, /checkpoint marker/);
  assert.match(brief, /latest output marker/);
  assert.match(brief, /task text truncated/);
});

test('completed or cancelled tasks cannot produce a resume instruction', () => {
  assert.throws(() => buildResumeInstruction({ id: 'done', state: 'SUCCEEDED', title: 'done' }), /can be resumed/);
  assert.throws(() => buildResumeInstruction({ id: 'cancelled', state: 'CANCELLED', title: 'cancelled' }), /can be resumed/);
});

test('resume launches one fresh task without the old MCP or write grant and is idempotent', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'kepos-resume-integration-'));
  process.env.ORBITAL_HOME = join(root, 'orbital');
  const { WorkerPool } = await import('../dist/terminal/workers.js');
  const { KeposDatabase } = await import('../dist/terminal/database.js');
  const { resumeWorkerTask } = await import('../dist/terminal/task-resume.js');
  let profile;
  const db = new KeposDatabase(join(root, 'workers.sqlite'));
  const source = {
    id: 'interrupted-task', agent: 'Researcher', agentId: 'researcher', role: 'Investigate',
    title: 'old display title', instruction: 'Inspect the project and fix the parser.', cwd: root,
    session: 'source.pi', parentSessionId: 'parent', correlationId: 'old-correlation',
    state: 'INTERRUPTED', status: '已中断', started: Date.now() - 1000,
    checkpoint: 'Parser inspected; branch fix pending.', checkpointAt: Date.now() - 2000,
    output: 'The branch is missing in parser.ts.', error: 'Owner process exited',
    changedFiles: ['parser.ts'], limit: 900, model: 'fixture-model', provider: 'fixture-provider',
    ownerPid: process.pid, ownerEpoch: 'old-epoch', tools: ['read', 'edit', 'write'],
    skills: ['approved-skill'], mcp: true, mcpServers: ['old-mcp'], budgetTokens: 2000,
    readScope: 'project', profileSnapshot: { name: 'Researcher', role: 'Investigate', model: 'fixture-model', provider: 'fixture-provider', tools: ['read', 'edit', 'write'], skills: ['approved-skill'], mcp: true, revision: 'old-revision' },
  };
  db.prepare('INSERT INTO workers VALUES(?,?,?,?,?,?,?,NULL)').run(source.id, source.parentSessionId, source.correlationId, '', source.ownerEpoch, source.state, JSON.stringify(source));
  // Reconstruct the pool from SQLite to prove a saved checkpoint can be resumed
  // after the original in-memory task object has gone away.
  const pool = new WorkerPool(db, value => { profile = value; throw new Error('fixture: do not spawn'); }, { concurrency: 1 });
  const persistedSource = pool.tasks.find(task => task.id === source.id);
  assert.ok(persistedSource);
  assert.equal(persistedSource.checkpoint, source.checkpoint);
  const profiles = [{ id: 'researcher', name: 'Researcher', model: 'fixture-model', provider: 'fixture-provider', role: 'Current config', tools: ['read'], skills: ['approved-skill'], mcpServers: ['old-mcp'] }];
  const first = resumeWorkerTask(pool, persistedSource, profiles, 'parent');
  assert.equal(first.state, 'RESUMED');
  const resumed = pool.tasks.find(task => task.id === first.taskId);
  assert.ok(resumed);
  assert.notEqual(resumed.id, source.id);
  assert.equal(resumed.resumedFromTaskId, source.id);
  assert.match(resumed.instruction, /Parser inspected; branch fix pending/);
  assert.equal(resumed.mcp, false);
  assert.equal(resumed.mcpServers, undefined);
  assert.equal(profile.mcp, false);
  assert.equal(profile.mcpServers, undefined);
  assert.equal(profile.cliGrants, undefined);
  assert.equal(profile.readScope, 'project');
  assert.ok(!profile.writeGrantFile || !(await import('node:fs')).existsSync(profile.writeGrantFile));
  assert.ok(resumed.tools.includes('kepos_request_write'), 'the representative may request fresh write access');
  const second = resumeWorkerTask(pool, persistedSource, profiles, 'parent');
  assert.equal(second.state, 'ALREADY_RESUMED');
  assert.equal(second.taskId, first.taskId);
  assert.equal(pool.tasks.filter(task => task.resumedFromTaskId === source.id).length, 1);
  pool.close();
  db.close();
});
