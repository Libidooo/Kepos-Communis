// 代表派生请求的接收端。
//
// 代表进程无法上行调用（RPC 只有父 → 子），所以它把派生请求写进归档目录，
// 由这里的轮询器接手执行。代价是延迟一个轮询周期；收益是子进程不需要新增
// 网络能力，权限面保持最小。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_DIR } from './archive.ts';
import { clearSpawnRequest, readSpawnRequest, type SpawnRequest } from './representative-tools.ts';

export type SpawnHandler = (taskId: string, request: SpawnRequest) => Promise<{ ok: boolean; reason?: string }>;

export type SpawnPollOptions = {
  /** 轮询间隔，缺省 2 秒：够快让人看不出延迟，又不至于空转。 */
  intervalMs?: number;
  /** 每个代表同时只处理一个请求，避免一次派生出十几个僚属。 */
  onSpawn: SpawnHandler;
};

/**
 * 轮询所有活跃代表的归档目录，把待处理的派生请求交给 onSpawn。
 * 处理完立刻把请求标记为 handled，避免下一轮重复执行。
 */
export class SpawnRequestPoller {
  private timer?: ReturnType<typeof setInterval>;
  private busy = new Set<string>();

  constructor(private readonly options: SpawnPollOptions) {}

  start(taskIds: () => string[], cwd: string): void {
    if (this.timer) return;
    const interval = Math.max(500, this.options.intervalMs ?? 2000);
    this.timer = setInterval(() => { void this.tick(taskIds(), cwd); }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.busy.clear();
  }

  async tick(taskIds: string[], cwd: string): Promise<void> {
    for (const taskId of taskIds) {
      if (this.busy.has(taskId)) continue;
      const root = join(cwd, ARCHIVE_DIR, String(taskId).replace(/[^A-Za-z0-9_-]/g, ''));
      if (!existsSync(root)) continue;
      const request = readSpawnRequest(root);
      // requestedAt 为 0 说明文件已被标记处理过。
      if (!request || !request.requestedAt) continue;
      this.busy.add(taskId);
      try {
        const result = await this.options.onSpawn(taskId, request);
        // 失败时也标记已处理：否则会无限重试同一条错误请求。
        // 失败原因写回归档，代表下一轮能读到。
        clearSpawnRequest(root);
        if (!result.ok) {
          const { writeArchiveDoc } = await import('./archive.ts');
          writeArchiveDoc(join(root, 'spawn-failed.md'), `# 派生失败\n\n请求：${request.task}\n\n原因：${result.reason || '未说明'}\n`);
        }
      } catch (error: any) {
        clearSpawnRequest(root);
        const { writeArchiveDoc } = await import('./archive.ts');
        writeArchiveDoc(join(root, 'spawn-failed.md'), `# 派生失败\n\n请求：${request.task}\n\n原因：${error?.message || error}\n`);
      } finally {
        this.busy.delete(taskId);
      }
    }
  }
}
