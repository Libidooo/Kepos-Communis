// 代表侧扩展：在代表自己的进程里注册派生与裁决工具。
//
// 为什么走文件而不是 RPC：worker 只被父进程单向驱动（父 → 子），
// 子进程没有上行通道。要在代表进程里发起派生，只能用父进程能观察到的副作用——
// 写归档目录里的请求文件，父进程轮询后执行。
// 这条路有代价（延迟一个轮询周期），但它不需要改动 RPC 协议，也不给子进程
// 新增网络能力，权限面最小。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 代表进程的请求目录：放在归档区下，父进程天然能看见。 */
export const SPAWN_REQUEST_FILE = 'spawn-request.json';
export const DECISION_FILE = 'decision.md';

export type SpawnRequest = {
  /** 请求 id：父进程处理后写回 handledAt，代表据此判断是否已被接收。 */
  id: string;
  task: string;
  seconds?: number;
  skills?: string[];
  readScope?: 'project' | 'machine';
  budgetTokens?: number;
  requestedAt: number;
};

function requestPath(archiveRoot: string): string {
  return join(archiveRoot, SPAWN_REQUEST_FILE);
}

/** 代表写一份派生请求。覆盖上一次未处理的请求——同一时刻只允许一个待处理请求。 */
export function writeSpawnRequest(archiveRoot: string, request: SpawnRequest): void {
  mkdirSync(archiveRoot, { recursive: true });
  writeFileSync(requestPath(archiveRoot), JSON.stringify(request, null, 2) + '\n', 'utf8');
}

/** 父进程读待处理请求；没有则返回 null。 */
export function readSpawnRequest(archiveRoot: string): SpawnRequest | null {
  const file = requestPath(archiveRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.task !== 'string' || !parsed.task.trim()) return null;
    return {
      id: String(parsed.id ?? ''),
      task: String(parsed.task),
      seconds: Number.isFinite(parsed.seconds) ? Number(parsed.seconds) : undefined,
      skills: Array.isArray(parsed.skills) ? parsed.skills.map(String) : undefined,
      readScope: parsed.readScope === 'machine' ? 'machine' : parsed.readScope === 'project' ? 'project' : undefined,
      budgetTokens: Number.isFinite(parsed.budgetTokens) ? Number(parsed.budgetTokens) : undefined,
      requestedAt: Number(parsed.requestedAt) || 0,
    };
  } catch { return null; }
}

/** 处理完就删除，避免同一请求被重复执行。 */
export function clearSpawnRequest(archiveRoot: string): void {
  const file = requestPath(archiveRoot);
  try { if (existsSync(file)) writeFileSync(file, JSON.stringify({ handled: true }) + '\n'); } catch { /* 忽略 */ }
}

/** 代表写下对僚属报告的裁决。parentWorkerId 由调用方给出，用于定位归档目录。 */
export type Decision = {
  adopted: boolean;
  /** 采纳时说明依据；驳回时说明要重派什么。 */
  note: string;
  /** 需要代表重新派发的后续任务（可选）。 */
  rework?: string;
};

export function writeDecision(archiveRoot: string, decision: Decision, agent: string): void {
  mkdirSync(archiveRoot, { recursive: true });
  const lines = [
    '# 代表裁决',
    '',
    `- 裁决者：${agent}`,
    `- 时间：${new Date().toISOString()}`,
    `- 结论：${decision.adopted ? '采纳' : '不采纳'}`,
    '',
    '## 依据',
    '',
    decision.note || '（未说明）',
    ...(decision.rework ? ['', '## 重派要求', '', decision.rework] : []),
    '',
  ];
  writeFileSync(join(archiveRoot, DECISION_FILE), lines.join('\n'), 'utf8');
}

/** 读回裁决，供父进程索引与展示。 */
export function readDecision(archiveRoot: string): { adopted?: boolean; note?: string } {
  const file = join(archiveRoot, DECISION_FILE);
  if (!existsSync(file)) return {};
  try {
    const text = readFileSync(file, 'utf8');
    const adopted = /- 结论：(采纳|不采纳)/.exec(text)?.[1];
    const note = /## 依据\s*\n+([\s\S]*?)(?=\n##|\s*$)/.exec(text)?.[1]?.trim();
    return { adopted: adopted === '采纳' ? true : adopted === '不采纳' ? false : undefined, note };
  } catch { return {}; }
}

/**
 * 代表侧扩展入口：注册两个工具。
 * 只注册给代表进程——僚属的沙箱是另一个扩展，不会加载这里。
 */
export default function representativeTools(pi: any) {
  const archiveRoot = String(process.env.KEPOS_ARCHIVE_ROOT || '');
  const agent = String(process.env.KEPOS_AGENT_NAME || '代表');
  if (!archiveRoot) return;

  pi.registerTool({
    name: 'kepos_spawn',
    label: '派生僚属',
    description: '派生一个僚属执行子任务。僚属继承你的模型与只读工具，时限不超过你剩余时间的一半。同一时刻只能有一个待处理请求。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给僚属的具体任务与验收标准' },
        seconds: { type: 'integer', minimum: 1, description: '时限秒数；缺省取你剩余时间的一半' },
        skills: { type: 'array', items: { type: 'string' }, description: '明确批准的 Skill 名称' },
        readScope: { type: 'string', enum: ['project', 'machine'], description: '读取范围；保密任务用 project' },
        budgetTokens: { type: 'integer', minimum: 1000, description: '僚属的 token 预算' },
      },
      required: ['task'],
    },
    async execute(_id: string, params: any) {
      const existing = readSpawnRequest(archiveRoot);
      if (existing && !existing.requestedAt) return { content: [{ type: 'text', text: '已有一个待处理的派生请求，请等待父进程接收后再试。' }] };
      writeSpawnRequest(archiveRoot, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        task: String(params.task || ''),
        seconds: Number.isFinite(params.seconds) ? Number(params.seconds) : undefined,
        skills: Array.isArray(params.skills) ? params.skills.map(String) : undefined,
        readScope: params.readScope === 'machine' ? 'machine' : undefined,
        budgetTokens: Number.isFinite(params.budgetTokens) ? Number(params.budgetTokens) : undefined,
        requestedAt: Date.now(),
      });
      return { content: [{ type: 'text', text: `已提交派生请求。父进程会在下一个轮询周期接收并启动僚属。\n任务：${String(params.task).slice(0, 200)}` }] };
    },
  });

  pi.registerTool({
    name: 'kepos_report',
    label: '裁决僚属报告',
    description: '对某个僚属的报告作出裁决：采纳或驳回。驳回时说明要重派什么。裁决写入该僚属的归档 decision.md。',
    parameters: {
      type: 'object',
      properties: {
        workerId: { type: 'string', description: '僚属任务 id' },
        adopted: { type: 'boolean', description: 'true 采纳，false 驳回' },
        note: { type: 'string', description: '裁决依据；驳回时写清缺什么' },
        rework: { type: 'string', description: '需要重新派发的后续任务（可选）' },
      },
      required: ['workerId', 'adopted', 'note'],
    },
    async execute(_id: string, params: any) {
      const dir = join(archiveRoot, String(params.workerId).replace(/[^A-Za-z0-9_-]/g, ''));
      if (!existsSync(dir)) return { content: [{ type: 'text', text: `找不到该僚属的归档：${params.workerId}` }] };
      writeDecision(dir, { adopted: Boolean(params.adopted), note: String(params.note || ''), rework: params.rework ? String(params.rework) : undefined }, agent);
      return { content: [{ type: 'text', text: `已对 ${params.workerId} 作出裁决：${params.adopted ? '采纳' : '不采纳'}。` }] };
    },
  });
}
