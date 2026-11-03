// Phase 4 of unified scheduling: the daemon owns the token ledger.
//
// Until now budgets were enforced per process (workers.ts checked its own usage), so the
// TUI, CLI and daemon each counted separately and the "daily cap" was per-process rather
// than per-installation. The daemon is the only writer for dispatch now, so it is the
// natural place for one ledger keyed by day and parent session.
//
// The ledger reads `usage` already present in receipts — no new accounting path.
import type { KeposDatabase } from './database.ts';

export type LedgerScope = 'day' | 'session' | 'plan';

export interface LedgerEntry {
  key: string;
  scope: LedgerScope;
  tokens: number;
  cost: number;
  updatedAt: number;
}

/** 与 workers.ts 的口径一致：优先 totalTokens，否则 input+output+cacheRead。 */
export function usageTokens(usage: any): number {
  if (!usage) return 0;
  if (Number.isFinite(usage.totalTokens)) return Number(usage.totalTokens);
  return (Number(usage.input) || 0) + (Number(usage.output) || 0) + (Number(usage.cacheRead) || 0);
}

export function usageCost(usage: any): number {
  const total = Number(usage?.cost?.total);
  return Number.isFinite(total) ? total : 0;
}

/** 台账键：日期按本地自然日，便于"今天用了多少"直接查询。 */
export function ledgerKey(scope: LedgerScope, id: string, now = Date.now()): string {
  if (scope === 'day') {
    const date = new Date(now);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(id || '');
}

export interface LedgerLimits {
  dailyTokens?: number;
  dailyCost?: number;
  /** 超限动作：暂停等人，还是直接取消。 */
  onExceed?: 'pause' | 'cancel';
}

export interface LedgerDecision {
  allowed: boolean;
  reason?: string;
  /** 超限时需要执行的动作。 */
  action?: 'pause' | 'cancel';
  used: { tokens: number; cost: number };
}

/**
 * 预算台账。只做两件事：记账，以及在该拒绝时明确拒绝。
 * 绝不在这里杀掉任务——终止与否是人类的决定（D6 决策），这里只提供执行点。
 */
export class BudgetLedger {
  constructor(private readonly database: KeposDatabase) {
    database.sql.exec('CREATE TABLE IF NOT EXISTS budget_ledger(key TEXT PRIMARY KEY, scope TEXT NOT NULL, tokens INTEGER NOT NULL, cost REAL NOT NULL, updated_at INTEGER NOT NULL);');
  }

  record(usage: any, options: { sessionId?: string; planId?: string; now?: number } = {}): void {
    const now = options.now ?? Date.now();
    const tokens = usageTokens(usage);
    const cost = usageCost(usage);
    if (!tokens && !cost) return;
    const targets: Array<[LedgerScope, string]> = [['day', ledgerKey('day', '', now)]];
    if (options.sessionId) targets.push(['session', options.sessionId]);
    if (options.planId) targets.push(['plan', options.planId]);
    for (const [scope, key] of targets) {
      this.database.prepare(
        'INSERT INTO budget_ledger(key,scope,tokens,cost,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET tokens=tokens+excluded.tokens, cost=cost+excluded.cost, updated_at=excluded.updated_at',
      ).run(key, scope, tokens, cost, now);
    }
  }

  read(scope: LedgerScope, id: string, now = Date.now()): LedgerEntry | undefined {
    const key = ledgerKey(scope, id, now);
    const row = this.database.prepare('SELECT key,scope,tokens,cost,updated_at FROM budget_ledger WHERE key=?').get(key) as any;
    if (!row) return undefined;
    return { key: row.key, scope: row.scope, tokens: row.tokens, cost: row.cost, updatedAt: row.updated_at };
  }

  /**
   * 派发前的准入判断。超限时返回拒绝理由与需要执行的动作，
   * 由调用方决定是暂停还是取消——台账本身不终止任何东西。
   */
  check(limits: LedgerLimits, now = Date.now()): LedgerDecision {
    const today = this.read('day', '', now);
    const used = { tokens: today?.tokens ?? 0, cost: today?.cost ?? 0 };
    const overTokens = limits.dailyTokens !== undefined && used.tokens >= limits.dailyTokens;
    const overCost = limits.dailyCost !== undefined && used.cost >= limits.dailyCost;
    if (!overTokens && !overCost) return { allowed: true, used };
    const parts: string[] = [];
    if (overTokens) parts.push(`${used.tokens} / ${limits.dailyTokens} tokens`);
    if (overCost) parts.push(`~$${used.cost.toFixed(4)} / $${limits.dailyCost}`);
    return {
      allowed: false,
      reason: `今日预算已用尽（${parts.join(' · ')}）；新派发被拒绝`,
      action: limits.onExceed ?? 'pause',
      used,
    };
  }
}
