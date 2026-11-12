import test from 'node:test';
import assert from 'node:assert/strict';

const { compactionFailureNotice, compactionGenerationReason, compactionSuccessNotice } = await import('../dist/terminal/context-compaction.js');
const { KeposDatabase } = await import('../dist/terminal/database.js');
const { KeposSessionStore } = await import('../dist/terminal/session-store.js');

test('automatic compaction notices distinguish threshold and overflow recovery', () => {
  assert.match(compactionSuccessNotice('threshold', 180_000), /接近上限.*180,000.*原始会话记录保留/);
  assert.match(compactionSuccessNotice('overflow'), /上下文溢出.*恢复重试流程/);
  assert.equal(compactionSuccessNotice('manual'), null);
  assert.match(compactionFailureNotice({ reason: 'overflow', errorMessage: 'provider unavailable', willRetry: true }), /溢出恢复失败.*provider unavailable.*不会自动重试.*原始会话记录仍保留/);
  assert.match(compactionFailureNotice({ reason: 'threshold', aborted: true }), /阈值压缩失败.*操作已取消/);
});

test('Pi compaction trigger is recorded in the Kepos generation ledger while raw history remains available', () => {
  const database = new KeposDatabase(':memory:');
  try {
    const store = new KeposSessionStore(database);
    const session = store.createSession({ cwd: '/project', title: 'compaction test' });
    const user = { type: 'message', id: 'user-1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Keep the task goal.' } };
    const assistant = { type: 'message', id: 'assistant-1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'Current checkpoint.' } };
    store.syncPi(session.logicalSessionId, [user, assistant], [user, assistant], 'pi-session');

    const compacted = { type: 'compaction', id: 'compact-1', timestamp: new Date().toISOString(), summary: 'Goal: Keep the task goal.', firstKeptEntryId: 'assistant-1', tokensBefore: 180_000 };
    store.syncPi(session.logicalSessionId, [user, assistant, compacted], [compacted, assistant], 'pi-session', compactionGenerationReason('threshold'));

    const generations = store.generations(session.logicalSessionId);
    assert.equal(generations.at(-1).reason, 'pi_compaction_threshold');
    const rawHistory = store.getMessages(session.logicalSessionId, true);
    assert.equal(rawHistory.length, 3);
    assert.ok(rawHistory.some(message => JSON.stringify(message.content).includes('Keep the task goal.')));
  } finally {
    database.sql.close();
  }
});
