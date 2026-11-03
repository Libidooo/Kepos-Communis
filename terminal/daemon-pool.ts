// Phase 2 of unified scheduling: the TUI's global pool becomes an adapter over the
// daemon's RPC surface, so the TUI, CLI and daemon share one executor set instead of
// each owning a WorkerPool.
//
// Degradation is explicit, never silent: when the daemon is unavailable the caller
// falls back to a local pool and the TUI shows a warning banner. Old tasks created by
// an in-process pool remain readable because SQLite is the source of truth; only new
// dispatch changes route.
import { SchedulerClient } from './scheduler-host.ts';
import type { WorkerPool, Task } from './workers.ts';
import type { Crew } from './store.ts';

export type DaemonPoolStatus = 'daemon' | 'local-fallback';

export interface DaemonWorkerPoolOptions {
  dataDir: string;
  /** 本地回退池：daemon 不可用时使用，由调用方注入以便复用现有池。 */
  fallback: WorkerPool;
  timeoutMs?: number;
  /** daemon 不可用时回调，用于顶栏警告条。 */
  onFallback?: (reason: string) => void;
  /** daemon 恢复时回调。 */
  onRecovered?: () => void;
}

/**
 * DaemonWorkerPool 不是 WorkerPool 的完整替代品——它只接管"派发"这一步。
 * 状态查询、事件与证据仍从 SQLite 读取（daemon 写的就是同一个库），
 * 因此本类只实现派发与取消，其余调用转给本地池。
 */
export class DaemonWorkerPool {
  status: DaemonPoolStatus = 'daemon';
  lastReason = '';
  private client: SchedulerClient | undefined;

  constructor(private readonly options: DaemonWorkerPoolOptions) {}

  /** 复用 daemon 写入的同一个数据库的本地池。 */
  get fallback() { return this.options.fallback; }
  get tasks(): Task[] { return this.options.fallback.tasks; }

  /** 探测 daemon；不可用则标记降级并回报原因。 */
  async probe(timeoutMs = 2000): Promise<boolean> {
    const client = SchedulerClient.fromDataDir(this.options.dataDir, timeoutMs);
    if (!client) return this.degrade('未发现调度守护进程（scheduler.port 不存在）');
    try {
      await client.request('health');
      this.client = client;
      if (this.status !== 'daemon') { this.status = 'daemon'; this.lastReason = ''; this.options.onRecovered?.(); }
      return true;
    } catch (error: any) {
      return this.degrade(`调度守护进程无响应：${error?.message || error}`);
    }
  }

  private degrade(reason: string) {
    // 只在状态真的变化时回调：probe 会被反复调用，重复触发会让警告条一直闪。
    const wasHealthy = this.status === 'daemon';
    this.client = undefined;
    this.status = 'local-fallback';
    this.lastReason = reason;
    if (wasHealthy) this.options.onFallback?.(reason);
    return false;
  }

  /** 派发：daemon 可用则走 RPC，否则回退本地池并明确告知调用方。 */
  async dispatch(crew: Crew, instruction: string, cwd: string, parentSessionId: string, seconds: number): Promise<{ route: DaemonPoolStatus; reason?: string; task?: Task }> {
    if (await this.probe()) {
      try {
        await this.client!.request('launch', { crew, instruction, cwd, parentSessionId, seconds });
        return { route: 'daemon' };
      } catch (error: any) {
        // 派发失败也降级，但要把原因带回去——绝不假装成功。
        this.degrade(`经守护进程派发失败：${error?.message || error}`);
      }
    }
    return { route: 'local-fallback', reason: this.lastReason };
  }

  /** 取消：两条路径都要尝试，先 daemon 后本地，确保不留孤儿。 */
  async cancel(taskId: string): Promise<void> {
    if (this.client) {
      try { await this.client.request('cancel', { taskId }); } catch { /* 本地兜底 */ }
    }
    this.options.fallback.cancel(taskId);
  }

  /** 顶栏警告条文案；正常时为空。 */
  bannerText(): string {
    return this.status === 'local-fallback' ? `⚠ 已降级为本地调度：${this.lastReason}` : '';
  }
}
