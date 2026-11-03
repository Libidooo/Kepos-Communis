// 记忆整理管道：任务终态后把产出里值得记住的部分沉淀下来。
//
// 两阶段（mem0 模式）：
//   1. 触发：任务进入终态，且产出非空、未被整理过 → 入队。
//   2. 整理：一个极小的内部任务，让便宜模型把产出压成 ADD/UPDATE/NOOP。
//
// 成本控制（报告 A1 明确要求）：
//   - 空产出、纯失败（没有 checkpoint 也没有错误原因）跳过。
//   - 每任务最多 8 条记忆，超出截断。
//   - 整理自身的 token 计入预算；失败不影响任务结算。
import type { KeposDatabase } from './database.ts';
import { parseConsolidationOps, RepresentativeMemory, consolidationPrompt, type MemoryRow, type ConsolidationOp } from './memory.ts';
import { candidatesFromProcedures } from './skill-proposal.ts';

export type ConsolidationCandidate = {
  workerId: string;
  agentId: string;
  goal: string;
  checkpoint?: string;
  output: string;
  failed: boolean;
  /** 失败原因。失败任务常常只有错误、没有产出，而错误本身正是复盘要记的东西。 */
  error?: string;
};

// 失败类终态：这些任务即使没有产出也要复盘——"为什么没做成"本身就是可复用的经验。
const FAILED_STATES = new Set(['失败', '超时', '已中断']);

/** 是否值得为这个任务跑一次整理。 */
export function shouldConsolidate(task: { id: string; agentId?: string; output?: string; checkpoint?: string; status?: string; error?: string; failed?: boolean }, alreadyDone: (workerId: string) => boolean): boolean {
  if (!task.agentId) return false;            // 临时代表没有稳定 id，记忆无处归属
  if (alreadyDone(task.id)) return false;
  const output = String(task.output ?? '').trim();
  const checkpoint = String(task.checkpoint ?? '').trim();
  const failed = task.failed ?? FAILED_STATES.has(String(task.status ?? ''));
  // 失败任务有错误原因就值得复盘，哪怕产出为空。
  if (failed && String(task.error ?? '').trim()) return true;
  // 其余情况：什么都没有的任务没有可沉淀内容。
  if (!output && !checkpoint) return false;
  return true;
}

/** 从任务构造整理输入。产出只取末尾 4KiB——前面多为过程刷屏。 */
export function candidateFromTask(task: { id: string; agentId?: string; title?: string; checkpoint?: string; output?: string; status?: string; error?: string }): ConsolidationCandidate | null {
  if (!task.agentId) return null;
  const output = String(task.output ?? '');
  const failed = FAILED_STATES.has(String(task.status ?? ''));
  return {
    workerId: task.id,
    agentId: task.agentId,
    goal: String(task.title ?? ''),
    checkpoint: task.checkpoint,
    output: output.length > 4096 ? output.slice(-4096) : output,
    failed,
    ...(failed && task.error ? { error: String(task.error).slice(0, 600) } : {}),
  };
}

/**
 * 整理执行器：调用一个"模型"把候选产出压成操作列表。
 * model 由调用方注入（真实实现用便宜模型；测试用桩），这里不绑死具体 provider。
 */
export type ConsolidationModel = (prompt: string) => Promise<string>;

export class ConsolidationPipeline {
  private readonly memory: RepresentativeMemory;
  private readonly queue: ConsolidationCandidate[] = [];
  private running = false;

  constructor(private readonly database: KeposDatabase, private readonly model: ConsolidationModel, private readonly onChange?: (message: string) => void) {
    this.memory = new RepresentativeMemory(database);
  }

  /** 只入队，不立即执行——避免在任务结算路径上做网络调用。 */
  enqueue(candidate: ConsolidationCandidate): boolean {
    if (!shouldConsolidate({ id: candidate.workerId, agentId: candidate.agentId, output: candidate.output, checkpoint: candidate.checkpoint, error: candidate.error, failed: candidate.failed }, id => this.memory.consolidated(id))) return false;
    if (this.queue.some(item => item.workerId === candidate.workerId)) return false;
    this.queue.push(candidate);
    return true;
  }

  pending(): number { return this.queue.length; }

  /** 处理一个候选：取该代表已有记忆 → 问模型 → 落库 → 打去重标记。 */
  async consolidate(candidate: ConsolidationCandidate): Promise<{ added: number; updated: number; skipped: number }> {
    const existing = this.memory.active(candidate.agentId, 20);
    const prompt = consolidationPrompt({
      goal: candidate.goal, checkpoint: candidate.checkpoint,
      outputTail: candidate.output, memories: existing, failed: candidate.failed, error: candidate.error,
    });
    let ops: ConsolidationOp[] = [];
    try {
      ops = parseConsolidationOps(await this.model(prompt));
    } catch {
      // 模型失败不写记忆，也不标记完成——下次还能重试。
      return { added: 0, updated: 0, skipped: 0 };
    }
    const result = this.memory.apply(candidate.agentId, ops, candidate.workerId);
    if (result.added || result.updated) this.onChange?.(`${candidate.agentId} 记忆 +${result.added} ~${result.updated}`);
    // 只有真正处理过才标记，避免模型故障时永久跳过这个任务。
    this.memory.markConsolidated(candidate.workerId);
    return result;
  }

  /** 排空队列。串行执行，避免同时打满模型。 */
  async drain(): Promise<{ processed: number }> {
    if (this.running) return { processed: 0 };
    this.running = true;
    let processed = 0;
    try {
      while (this.queue.length) {
        const candidate = this.queue.shift()!;
        await this.consolidate(candidate);
        processed++;
      }
    } finally { this.running = false; }
    return { processed };
  }

  /** 供 kepos_memory 工具查询。 */
  list(agentId: string): MemoryRow[] { return this.memory.active(agentId); }
  search(agentId: string, query: string): MemoryRow[] { return this.memory.search(agentId, query); }
  invalidate(id: string): boolean { return this.memory.invalidate(id); }
  asOf(agentId: string, at: number): MemoryRow[] { return this.memory.asOf(agentId, at); }
  /** 该代表的过程记忆——技能闭环的输入。 */
  procedures(agentId: string): MemoryRow[] { return this.memory.active(agentId, 200).filter(row => row.kind === 'procedure'); }
  /** 同一 slug 出现在多少个不同任务里。计数口径只在 RepresentativeMemory 一处。 */
  procedureCount(agentId: string, slug: string): number { return this.memory.procedureCount(agentId, slug); }
  /** 该代表的过程记忆里，已经够格提技能的 slug。 */
  skillCandidates(agentId: string): Array<{ slug: string; steps: string[] }> {
    return candidatesFromProcedures(
      this.procedures(agentId).map(row => ({ content: row.content, workerId: row.sourceWorkerId })),
      slug => this.procedureCount(agentId, slug),
    );
  }
}