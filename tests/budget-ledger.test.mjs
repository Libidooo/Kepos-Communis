import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { KeposDatabase } = await import('../dist/terminal/database.js');
const { BudgetLedger, ledgerKey, usageTokens } = await import('../dist/terminal/budget-ledger.js');

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'kepos-ledger-'));
  return new KeposDatabase(join(dir, 'kepos.sqlite'));
}

test('usage totals prefer totalTokens and otherwise sum the parts', () => {
  assert.equal(usageTokens({ totalTokens: 500 }), 500);
  assert.equal(usageTokens({ input: 100, output: 50, cacheRead: 25 }), 175);
  assert.equal(usageTokens(undefined), 0);
});

test('day keys are local calendar days', () => {
  const now = new Date(2026, 2, 5, 23, 30).getTime();
  assert.equal(ledgerKey('day', '', now), '2026-03-05');
  assert.equal(ledgerKey('session', 'abc'), 'abc');
});

test('usage accumulates across days and scopes independently', () => {
  const db = fresh();
  try {
    const ledger = new BudgetLedger(db);
    ledger.record({ totalTokens: 100 }, { sessionId: 's1', now: Date.parse('2026-03-05T10:00:00') });
    ledger.record({ totalTokens: 50 }, { sessionId: 's1', now: Date.parse('2026-03-05T11:00:00') });
    ledger.record({ totalTokens: 70 }, { sessionId: 's2', now: Date.parse('2026-03-06T09:00:00') });

    assert.equal(ledger.read('day', '', Date.parse('2026-03-05T12:00:00')).tokens, 150);
    assert.equal(ledger.read('day', '', Date.parse('2026-03-06T12:00:00')).tokens, 70);
    assert.equal(ledger.read('session', 's1').tokens, 150);
    assert.equal(ledger.read('session', 's2').tokens, 70);
  } finally { db.close(); }
});

test('the daily cap refuses further dispatch and names the action', () => {
  const db = fresh();
  try {
    const ledger = new BudgetLedger(db);
    const now = Date.parse('2026-03-05T10:00:00');
    ledger.record({ totalTokens: 1000 }, { now });
    const ok = ledger.check({ dailyTokens: 5000 }, now);
    assert.equal(ok.allowed, true);
    assert.equal(ok.used.tokens, 1000);

    const blocked = ledger.check({ dailyTokens: 1000 }, now);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /今日预算已用尽/);
    assert.equal(blocked.action, 'pause', 'default action is pause, not kill');
  } finally { db.close(); }
});

test('cost caps work the same way and report both when both trip', () => {
  const db = fresh();
  try {
    const ledger = new BudgetLedger(db);
    const now = Date.parse('2026-03-05T10:00:00');
    ledger.record({ totalTokens: 2000, cost: { total: 1.5 } }, { now });
    const blocked = ledger.check({ dailyTokens: 1000, dailyCost: 1, onExceed: 'cancel' }, now);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason, /tokens/);
    // 费用超限时理由里要带出实际金额，方便人类判断。
    assert.match(blocked.reason, /1\.5000/);
    assert.equal(blocked.action, 'cancel', 'configured action is honoured');
  } finally { db.close(); }
});

test('a fresh day starts from zero', () => {
  const db = fresh();
  try {
    const ledger = new BudgetLedger(db);
    ledger.record({ totalTokens: 999 }, { now: Date.parse('2026-03-05T10:00:00') });
    const nextDay = Date.parse('2026-03-06T10:00:00');
    assert.equal(ledger.check({ dailyTokens: 100 }, nextDay).allowed, true, 'yesterday does not consume today');
  } finally { db.close(); }
});
