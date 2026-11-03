// 代表记忆：让同一个代表第 N 次被派发时带走前 N-1 次的发现。
//
// 设计依据（调研报告 A1）：
//   - mem0 两阶段管道：先抽取，再 ADD / UPDATE / NOOP，绝不 DELETE。
//   - Zep 双时态：记忆失效只置 valid_to，保留"某个时刻我们相信什么"。
//   - 报告 §0 原则 5：SQLite 是记录源，不引入向量库；FTS 足够。
//
// 为什么永不删除：整理管道的判断可能出错。物理删除后无法回滚，
// 而双时态只标记失效——错判可以人工纠正，证据仍在。
import { randomUUID } from 'node:crypto';
import type { KeposDatabase } from './database.ts';

export type MemoryKind = 'semantic' | 'procedure';

export type MemoryRow = {
  id: string;
  agentId: string;
  kind: MemoryKind;
  content: string;
  sourceWorkerId?: string;
  validFrom: number;
  /** null 表示当前有效。 */
  validTo: number | null;
  createdAt: number;
};

/** 单条记忆上限：超过就不是"一条事实"而是整篇报告。 */
export const MAX_MEMORY_CHARS = 400;
/** 一次整理最多产出 8 条，超出截断——防止一次任务刷进大量噪声。 */
export const MAX_MEMORIES_PER_TASK = 8;
/** 注入时最多 50 条，拼成不超过 200 行的索引。 */
export const MAX_INJECTED_MEMORIES = 50;
export const MAX_INJECTED_LINES = 200;

/** 整理管道的输出项。 */
export type ConsolidationOp = { op: 'ADD' | 'UPDATE' | 'NOOP'; content: string; replacesId?: string };

export class RepresentativeMemory {
  constructor(private readonly database: KeposDatabase) {}

  /** 写入一条新记忆。 */
  add(input: { agentId: string; content: string; kind?: MemoryKind; sourceWorkerId?: string; now?: number }): MemoryRow {
    const now = input.now ?? Date.now();
    const content = String(input.content ?? '').trim().slice(0, MAX_MEMORY_CHARS);
    if (!content) throw Error('记忆内容不能为空');
    if (!input.agentId) throw Error('记忆必须归属某个代表');
    const row: MemoryRow = {
      id: randomUUID(), agentId: input.agentId, kind: input.kind ?? 'semantic',
      content, sourceWorkerId: input.sourceWorkerId, validFrom: now, validTo: null, createdAt: now,
    };
    this.database.prepare('INSERT INTO representative_memories(id,agent_id,kind,content,source_worker_id,valid_from,valid_to,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(row.id, row.agentId, row.kind, row.content, row.sourceWorkerId ?? null, row.validFrom, null, row.createdAt);
    return row;
  }

  /**
   * 用新内容替换一条旧记忆：旧行只置 valid_to，新行插入。
   * 返回新的当前有效行；找不到被替换的 id 时退化为新增。
   */
  update(replacesId: string, input: { agentId: string; content: string; kind?: MemoryKind; sourceWorkerId?: string; now?: number }): MemoryRow {
    const now = input.now ?? Date.now();
    // 只失效"本来就是当前有效"的那一行，避免重复失效历史版本。
    this.database.prepare('UPDATE representative_memories SET valid_to=? WHERE id=? AND valid_to IS NULL').run(now, replacesId);
    return this.add({ ...input, now });
  }

  /** 把一条记忆标记为失效，不删除。 */
  invalidate(id: string, now = Date.now()): boolean {
    const result = this.database.prepare('UPDATE representative_memories SET valid_to=? WHERE id=? AND valid_to IS NULL').run(now, id);
    return Number(result.changes) > 0;
  }

  /** 当前有效记忆，最新的在前。 */
  active(agentId: string, limit = MAX_INJECTED_MEMORIES): MemoryRow[] {
    const rows = this.database.prepare(
      'SELECT id,agent_id,kind,content,source_worker_id,valid_from,valid_to,created_at FROM representative_memories WHERE agent_id=? AND valid_to IS NULL ORDER BY valid_from DESC LIMIT ?',
    ).all(agentId, limit) as any[];
    return rows.map(toMemory);
  }

  /**
   * 双时态查询：某个时刻该代表"当时相信什么"。
   * 这是双时态的价值所在——能重建历史判断，而不是只看到当前状态。
   */
  asOf(agentId: string, at: number, limit = MAX_INJECTED_MEMORIES): MemoryRow[] {
    const rows = this.database.prepare(
      'SELECT id,agent_id,kind,content,source_worker_id,valid_from,valid_to,created_at FROM representative_memories WHERE agent_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) ORDER BY valid_from DESC LIMIT ?',
    ).all(agentId, at, at, limit) as any[];
    return rows.map(toMemory);
  }

  /** 文本检索：SQLite 的 LIKE 足够——代表记忆量级远未到需要 FTS 索引。 */
  search(agentId: string, query: string, limit = MAX_INJECTED_MEMORIES): MemoryRow[] {
    const needle = String(query ?? '').trim();
    if (!needle) return this.active(agentId, limit);
    const rows = this.database.prepare(
      'SELECT id,agent_id,kind,content,source_worker_id,valid_from,valid_to,created_at FROM representative_memories WHERE agent_id=? AND valid_to IS NULL AND content LIKE ? ORDER BY valid_from DESC LIMIT ?',
    ).all(agentId, `%${needle}%`, limit) as any[];
    return rows.map(toMemory);
  }

  /**
   * 应用一次整理结果。
   * UPDATE 必须指向该代表自己的当前有效记忆——防止整理管道写坏别人的记录。
   */
  apply(agentId: string, ops: ConsolidationOp[], sourceWorkerId?: string, now = Date.now()): { added: number; updated: number; skipped: number } {
    let added = 0, updated = 0, skipped = 0;
    for (const op of ops.slice(0, MAX_MEMORIES_PER_TASK)) {
      const content = String(op.content ?? '').trim();
      if (!content || op.op === 'NOOP') { skipped++; continue; }
      if (op.op === 'ADD') { this.add({ agentId, content, sourceWorkerId, now }); added++; continue; }
      if (op.op === 'UPDATE') {
        const owned = op.replacesId
          ? this.database.prepare('SELECT id FROM representative_memories WHERE id=? AND agent_id=? AND valid_to IS NULL').get(op.replacesId, agentId)
          : undefined;
        if (owned) { this.update(op.replacesId!, { agentId, content, sourceWorkerId, now }); updated++; }
        else { this.add({ agentId, content, sourceWorkerId, now }); added++; }
        continue;
      }
      skipped++;
    }
    return { added, updated, skipped };
  }

  /** 该任务是否已经整理过——去重锁，避免重复消耗。 */
  consolidated(workerId: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM memory_consolidated WHERE worker_id=?').get(workerId));
  }

  markConsolidated(workerId: string, at = Date.now()): void {
    this.database.prepare('INSERT OR IGNORE INTO memory_consolidated(worker_id,at) VALUES(?,?)').run(workerId, at);
  }

  /** 同一代表同一 slug 的过程记忆出现了多少次不同任务——A2 技能闭环的触发条件。 */
  procedureCount(agentId: string, slug: string): number {
    const row = this.database.prepare(
      'SELECT COUNT(DISTINCT source_worker_id) c FROM representative_memories WHERE agent_id=? AND kind=? AND content LIKE ? AND source_worker_id IS NOT NULL',
    ).get(agentId, 'procedure', `%${slug}%`) as any;
    return Number(row?.c ?? 0);
  }
}

function toMemory(row: any): MemoryRow {
  return {
    id: row.id, agentId: row.agent_id, kind: row.kind as MemoryKind, content: row.content,
    sourceWorkerId: row.source_worker_id ?? undefined,
    validFrom: row.valid_from, validTo: row.valid_to ?? null, createdAt: row.created_at,
  };
}

/**
 * 把记忆拼成注入用的一段索引。
 * 硬上限 200 行、50 条；超出就截断并明说截断了——不假装完整。
 * 结尾必须声明"仅供参考"，否则代表会把旧记忆当成当前事实。
 */
export function renderMemoryIndex(rows: MemoryRow[]): string {
  if (!rows.length) return '';
  const lines: string[] = ['## 该代表此前有效记忆（索引）', ''];
  let used = 0;
  for (const row of rows.slice(0, MAX_INJECTED_MEMORIES)) {
    const line = `- [${row.kind === 'procedure' ? '过程' : '事实'}] ${row.content}`;
    if (lines.length + 2 > MAX_INJECTED_LINES) break;
    lines.push(line);
    used++;
  }
  if (rows.length > used) lines.push(`- …… 另有 ${rows.length - used} 条未列出`);
  lines.push('', '以上记忆仅供参考；与本任务的实际证据冲突时，以本任务为准。');
  return lines.join('\n');
}

/**
 * 从整理模型输出的 JSON 里解析操作列表。
 * 模型可能返回 ```json 代码块或带说明文字——只认数组本身。
 */
export function parseConsolidationOps(raw: string): ConsolidationOp[] {
  const text = String(raw ?? '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: any;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const ops: ConsolidationOp[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const op = String(item.op ?? '').toUpperCase();
    if (!['ADD', 'UPDATE', 'NOOP'].includes(op)) continue;
    const content = String(item.content ?? '').trim();
    if (op !== 'NOOP' && !content) continue;
    ops.push({ op: op as ConsolidationOp['op'], content, ...(item.replacesId ? { replacesId: String(item.replacesId) } : {}) });
  }
  return ops.slice(0, MAX_MEMORIES_PER_TASK);
}

/** 整理提示词：两阶段管道的第二段，要求严格 JSON。 */
export function consolidationPrompt(input: { goal: string; checkpoint?: string; outputTail: string; memories: MemoryRow[]; failed?: boolean }): string {
  const existing = input.memories.length
    ? input.memories.map(row => `- id=${row.id} :: ${row.content}`).join('\n')
    : '（暂无）';
  return [
    '你是记忆整理器。下面是一次委派任务的结果，以及该代表已知的记忆。',
    '',
    '## 任务',
    input.goal,
    '',
    ...(input.checkpoint ? ['## 过程检查点', input.checkpoint, ''] : []),
    '## 产出末尾',
    input.outputTail,
    '',
    '## 该代表当前有效记忆',
    existing,
    '',
    '## 你的工作',
    '只抽取"下次同类任务还有用"的事实或可复用步骤，不要复述本次任务细节。',
    '输出严格 JSON 数组，不要任何解释文字：',
    '[{"op":"ADD","content":"一句话事实"},{"op":"UPDATE","replacesId":"要替换的记忆 id","content":"修正后的事实"},{"op":"NOOP"}]',
    '',
    '规则：',
    `- 单条不超过 ${MAX_MEMORY_CHARS} 字。`,
    `- 最多 ${MAX_MEMORIES_PER_TASK} 条；没有值得记住的就返回 [{"op":"NOOP"}]。`,
    '- 已有记忆仍然成立时用 NOOP，不要重复添加。',
    '- 新发现与旧记忆冲突时用 UPDATE 并给出 replacesId。',
    input.failed ? '- 本次任务失败：优先记录"哪个环节出错、下次应如何委派"，不要记录无根据的结论。' : '',
  ].filter(Boolean).join('\n');
}