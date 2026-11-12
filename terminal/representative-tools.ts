// 代表侧扩展：在代表自己的进程里注册派生与裁决工具。
//
// 为什么走文件而不是 RPC：worker 只被父进程单向驱动（父 → 子），
// 子进程没有上行通道。要在代表进程里发起派生，只能用父进程能观察到的副作用——
// 写归档目录里的请求文件，父进程轮询后执行。
// 这条路有代价（延迟一个轮询周期），但它不需要改动 RPC 协议，也不给子进程
// 新增网络能力，权限面最小。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CliSessions } from './cli-runtime.ts';
import { clampTurnOutput } from './cli-dialog.ts';
import { postGroupMessage, readGroupMessages, renderGroupChannel } from './group-channel.ts';
import { listCliTurns, readCliTurn } from './cli-dialog.ts';
import { PROJECT_CHECKS, type ProjectCheck } from './validation-command.ts';

/** 代表进程的请求目录：放在归档区下，父进程天然能看见。 */
export const SPAWN_REQUEST_FILE = 'spawn-request.json';
/** 跨组借调申请：同上，由父进程轮询后转呈总理。 */
export const SECONDMENT_REQUEST_FILE = 'secondment-request.json';
/** 代表申请受限文件写权限；由宿主评估并将最终授权写入 Kepos 私有数据目录。 */
export const WRITE_ACCESS_REQUEST_FILE = 'write-access-request.json';
export const WRITE_ACCESS_RESULT_FILE = 'write-access-result.json';
export const PROJECT_CHECK_REQUEST_FILE = 'project-check-request.json';
export const PROJECT_CHECK_RESULT_FILE = 'project-check-result.json';
export const DECISION_FILE = 'decision.md';

export type RepresentativeWriteRequest = {
  id: string;
  taskId: string;
  tools: string[];
  paths: string[];
  reason: string;
  requestedAt: number;
};
export type RepresentativeWriteResult = { id: string; approved: boolean; reason: string; tools?: string[]; paths?: string[]; directoryPaths?: string[]; expiresAt?: number };

export type ProjectCheckRequest = { id: string; taskId: string; check: ProjectCheck; reason: string; requestedAt: number };
export type ProjectCheckResult = {
  id: string; taskId: string; approved: boolean; reason: string; check?: ProjectCheck;
  command?: string; cwd?: string; startedAt?: string; endedAt?: string; durationMs?: number;
  exitCode?: number; timedOut?: boolean; cancelled?: boolean; truncated?: boolean; output?: string; error?: string;
};

export function readProjectCheckRequest(archiveRoot: string): ProjectCheckRequest | null {
  try {
    const value = JSON.parse(readFileSync(join(archiveRoot, PROJECT_CHECK_REQUEST_FILE), 'utf8'));
    if (!value || typeof value.id !== 'string' || typeof value.taskId !== 'string' || !(PROJECT_CHECKS as readonly string[]).includes(value.check) || typeof value.reason !== 'string' || !Number.isFinite(value.requestedAt) || value.requestedAt <= 0) return null;
    return { id: value.id.slice(0, 100), taskId: value.taskId.slice(0, 100), check: value.check, reason: value.reason.slice(0, 500), requestedAt: Number(value.requestedAt) };
  } catch { return null; }
}

export function clearProjectCheckRequest(archiveRoot: string): void {
  try { unlinkSync(join(archiveRoot, PROJECT_CHECK_REQUEST_FILE)); } catch { /* already handled */ }
}

export function writeProjectCheckResult(archiveRoot: string, result: ProjectCheckResult): void {
  mkdirSync(archiveRoot, { recursive: true });
  writeFileSync(join(archiveRoot, PROJECT_CHECK_RESULT_FILE), JSON.stringify(result, null, 2) + '\n', 'utf8');
}

export function readProjectCheckResult(archiveRoot: string): ProjectCheckResult | null {
  try {
    const value = JSON.parse(readFileSync(join(archiveRoot, PROJECT_CHECK_RESULT_FILE), 'utf8'));
    if (!value || typeof value.id !== 'string' || typeof value.taskId !== 'string' || typeof value.approved !== 'boolean') return null;
    return value as ProjectCheckResult;
  } catch { return null; }
}

export function readWriteAccessRequest(archiveRoot: string): RepresentativeWriteRequest | null {
  const file = join(archiveRoot, WRITE_ACCESS_REQUEST_FILE);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || !value.requestedAt || typeof value.id !== 'string' || typeof value.taskId !== 'string') return null;
    return {
      id: value.id.slice(0, 100), taskId: value.taskId.slice(0, 100),
      tools: Array.isArray(value.tools) ? value.tools.map(String).slice(0, 8) : [],
      paths: Array.isArray(value.paths) ? value.paths.map(String).slice(0, 8) : [],
      reason: String(value.reason || '').slice(0, 500), requestedAt: Number(value.requestedAt) || 0,
    };
  } catch { return null; }
}

export function clearWriteAccessRequest(archiveRoot: string): void {
  const file = join(archiveRoot, WRITE_ACCESS_REQUEST_FILE);
  try { if (existsSync(file)) writeFileSync(file, JSON.stringify({ handled: true }) + '\n', 'utf8'); } catch { /* parent will time out and deny */ }
}

export function writeWriteAccessResult(archiveRoot: string, result: RepresentativeWriteResult): void {
  mkdirSync(archiveRoot, { recursive: true });
  writeFileSync(join(archiveRoot, WRITE_ACCESS_RESULT_FILE), JSON.stringify(result, null, 2) + '\n', 'utf8');
}

function readWriteAccessResult(archiveRoot: string): RepresentativeWriteResult | null {
  try {
    const value = JSON.parse(readFileSync(join(archiveRoot, WRITE_ACCESS_RESULT_FILE), 'utf8'));
    if (!value || typeof value.id !== 'string' || typeof value.approved !== 'boolean') return null;
    return { id: value.id, approved: value.approved, reason: String(value.reason || '').slice(0, 1000), tools: Array.isArray(value.tools) ? value.tools.map(String) : undefined, paths: Array.isArray(value.paths) ? value.paths.map(String) : undefined, directoryPaths: Array.isArray(value.directoryPaths) ? value.directoryPaths.map(String) : undefined, expiresAt: Number(value.expiresAt) || undefined };
  } catch { return null; }
}

export type SpawnRequest = {
  /** 请求 id：父进程处理后写回 handledAt，代表据此判断是否已被接收。 */
  id: string;
  task: string;
  seconds?: number;
  skills?: string[];
  readScope?: 'project' | 'machine';
  budgetTokens?: number;
  /** Ask the principal to assess these configured MCP servers for this child task. */
  mcp?: string[];
  mcpReason?: string;
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
      mcp: Array.isArray(parsed.mcp) ? parsed.mcp.map(String).slice(0, 8) : undefined,
      mcpReason: typeof parsed.mcpReason === 'string' ? parsed.mcpReason.slice(0, 500) : undefined,
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
 * 代表侧扩展入口：注册代表专属的派生、裁决、写权限申请与协作工具。
 * 只注册给代表进程——僚属的沙箱是另一个扩展，不会加载这里。
 */
export default function representativeTools(pi: any) {
  const archiveRoot = String(process.env.KEPOS_ARCHIVE_ROOT || '');
  const agent = String(process.env.KEPOS_AGENT_NAME || '代表');
  // 本任务 id：定位自己的归档、认出自己的僚属、在组通道里标识发言者。
  const taskId = String(process.env.KEPOS_TASK_ID || '');
  if (!archiveRoot) return;
  // The host poller consumes request files from .kepos/<taskId>. Keeping the
  // transport files per task prevents concurrent representatives from
  // overwriting each other's requests or receiving another task's decision.
  const taskArchiveRoot = taskId ? join(archiveRoot, taskId.replace(/[^A-Za-z0-9_-]/g, '')) : archiveRoot;

  pi.registerTool({
    name: 'kepos_request_write',
    label: '申请文件写权限',
    description: '为当前代表任务申请直接修改项目文件。必须给出具体理由和 1–8 个目标：已存在目录会授权其后代文件，已存在文件或新建文件路径只授权该文件本身。授权只支持 edit/write，并由总理按审批模式评估，严格模式由人类确认，只读模式拒绝。权限仅作用于批准路径并随当前任务结束失效。bash/powershell 不属于此授权。该工具会等待审批结果；获批后再调用 edit/write。',
    parameters: {
      type: 'object',
      properties: {
        tools: { type: 'array', items: { type: 'string', enum: ['edit', 'write'] }, minItems: 1, maxItems: 2, description: '只申请完成修改所需的最小工具集' },
        paths: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 8, description: '具体文件、已有目录或新建文件路径；相对路径以项目根目录为基准' },
        reason: { type: 'string', maxLength: 500, description: '说明要改什么、为什么只读工作不足，以及验收方式' },
      },
      required: ['tools', 'paths', 'reason'],
    },
    async execute(_id: string, params: any, signal?: AbortSignal) {
      if (!taskId) return { content: [{ type: 'text', text: '缺少当前任务标识，不能申请写权限。' }], isError: true };
      const prior = readWriteAccessRequest(taskArchiveRoot);
      if (prior?.requestedAt) return { content: [{ type: 'text', text: '已有写权限申请正在处理，请等待它返回后再提交。' }], isError: true };
      const tools: string[] = Array.isArray(params.tools) ? [...new Set<string>(params.tools.map((value: unknown) => String(value).toLowerCase()))] : [];
      const paths: string[] = Array.isArray(params.paths) ? [...new Set<string>(params.paths.map((value: unknown) => String(value).trim()).filter(Boolean))] : [];
      const reason = String(params.reason || '').trim();
      if (!tools.length || tools.some((tool: string) => !['edit', 'write'].includes(tool)) || !paths.length || paths.length > 8 || !reason || reason.length > 500) {
        return { content: [{ type: 'text', text: '申请无效：仅支持 edit/write；必须提供 1–8 个目标路径和不超过 500 字的理由。' }], isError: true };
      }
      const id = randomUUID();
      try { unlinkSync(join(taskArchiveRoot, WRITE_ACCESS_RESULT_FILE)); } catch { /* first request */ }
      mkdirSync(taskArchiveRoot, { recursive: true });
      const request: RepresentativeWriteRequest = { id, taskId, tools, paths, reason, requestedAt: Date.now() };
      writeFileSync(join(taskArchiveRoot, WRITE_ACCESS_REQUEST_FILE), JSON.stringify(request, null, 2) + '\n', 'utf8');
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) return { content: [{ type: 'text', text: '写权限申请已随任务取消。' }], isError: true };
        const result = readWriteAccessResult(taskArchiveRoot);
        if (result?.id === id) {
          if (!result.approved) return { content: [{ type: 'text', text: `总理/人类未授予写权限：${result.reason}` }], isError: true };
          return { content: [{ type: 'text', text: `写权限已生效：${(result.tools || []).join(' / ')}；批准路径：${(result.paths || []).map(path => `${path}${result.directoryPaths?.includes(path) ? '（目录内）' : '（仅此文件）'}`).join('；')}；到期 ${new Date(result.expiresAt || Date.now()).toLocaleString()}。现在可在该范围内调用 edit/write。` }], details: result };
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return { content: [{ type: 'text', text: '等待写权限审批超过 3 分钟；按未获批处理。请向总理汇报后继续只读工作。' }], isError: true };
    },
  });

  pi.registerTool({
    name: 'kepos_request_check',
    label: '申请运行项目验证',
    description: '申请运行项目 package.json 中已有的 test/typecheck/build/lint/check 脚本。必须说明与当前任务验收的关系；总理按当前审批模式评估，严格模式由人类确认，只读模式拒绝。宿主只接受固定脚本名和固定参数，不接受任意 shell 命令；运行时会清除应用凭据环境变量、关闭 npm 网络取包并设 5 分钟上限。项目脚本本身仍是可执行代码，总理必须检查脚本内容与任务是否相称。',
    parameters: {
      type: 'object',
      properties: {
        check: { type: 'string', enum: [...PROJECT_CHECKS], description: '只可申请项目已定义的 test/typecheck/build/lint/check 脚本' },
        reason: { type: 'string', maxLength: 500, description: '说明这条验证与任务验收的关系，以及不运行的影响' },
      },
      required: ['check', 'reason'],
    },
    async execute(_id: string, params: any, signal?: AbortSignal) {
      if (!taskId) return { content: [{ type: 'text', text: '缺少任务标识，不能申请项目验证。' }], isError: true };
      const prior = readProjectCheckRequest(taskArchiveRoot);
      if (prior?.requestedAt) return { content: [{ type: 'text', text: '已有项目验证申请正在处理，请等待结果后再提交。' }], isError: true };
      const check = String(params.check || '') as ProjectCheck;
      const reason = String(params.reason || '').trim();
      if (!(PROJECT_CHECKS as readonly string[]).includes(check) || !reason || reason.length > 500) {
        return { content: [{ type: 'text', text: `申请无效：check 只能是 ${PROJECT_CHECKS.join(' / ')}，并须提供不超过 500 字的验收理由。` }], isError: true };
      }
      const id = randomUUID();
      try { unlinkSync(join(taskArchiveRoot, PROJECT_CHECK_RESULT_FILE)); } catch { /* first request */ }
      mkdirSync(taskArchiveRoot, { recursive: true });
      const request: ProjectCheckRequest = { id, taskId, check, reason, requestedAt: Date.now() };
      writeFileSync(join(taskArchiveRoot, PROJECT_CHECK_REQUEST_FILE), JSON.stringify(request, null, 2) + '\n', 'utf8');
      const deadline = Date.now() + 8 * 60_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) return { content: [{ type: 'text', text: '项目验证申请已随任务取消。' }], isError: true };
        const result = readProjectCheckResult(taskArchiveRoot);
        if (result?.id === id && result.taskId === taskId) {
          if (!result.approved) return { content: [{ type: 'text', text: `项目验证未获批准：${result.reason}` }], isError: true };
          const output = String(result.output || '').slice(-18_000);
          const summary = `验证项：${result.check}\n命令：${result.command}\n目录：${result.cwd}\n结果：${result.exitCode === 0 ? '通过' : result.timedOut ? '超时' : result.cancelled ? '任务取消' : `失败（退出码 ${result.exitCode ?? '未知'}）`}\n耗时：${result.durationMs ?? '—'} ms\n开始：${result.startedAt || '—'}\n结束：${result.endedAt || '—'}${result.truncated ? '\n注意：较早输出已截断，完整结果保存在任务归档。' : ''}${result.error ? `\n错误：${result.error}` : ''}\n\n输出：\n${output || '（无输出）'}`;
          return { content: [{ type: 'text', text: summary }], details: result, isError: result.exitCode !== 0 || Boolean(result.timedOut || result.cancelled || result.error) };
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return { content: [{ type: 'text', text: '等待项目验证审批或执行结果超过 8 分钟；按未获批处理。请向总理汇报后继续。' }], isError: true };
    },
  });

  pi.registerTool({
    name: 'kepos_spawn',
    label: '派生僚属',
    description: '派生一个僚属执行子任务。僚属继承你的模型与只读工具，时限不超过你剩余时间的一半。同一时刻只能有一个待处理请求。若子任务确实需要已配置的外部软件，可填写最小 MCP 服务器列表和理由；总理会独立评估，代理模式下才可能临时授予，严格/只读模式或未配置服务器会交由人类处理。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给僚属的具体任务与验收标准' },
        seconds: { type: 'integer', minimum: 1, description: '时限秒数；缺省取你剩余时间的一半' },
        skills: { type: 'array', items: { type: 'string' }, description: '明确批准的 Skill 名称' },
        readScope: { type: 'string', enum: ['project', 'machine'], description: '读取范围；保密任务用 project' },
        budgetTokens: { type: 'integer', minimum: 1000, description: '僚属的 token 预算' },
        mcp: { type: 'array', items: { type: 'string' }, maxItems: 8, description: '可选：申请本任务所需的最小 MCP 服务器名称，必须已由人类配置；这不是授权' },
        mcpReason: { type: 'string', maxLength: 500, description: '解释为什么该子任务需要这些外部工具，以及不使用它们的影响' },
      },
      required: ['task'],
    },
    async execute(_id: string, params: any) {
      const mcp = Array.isArray(params.mcp) ? [...new Set<string>((params.mcp as unknown[]).map(server => String(server).trim()).filter(Boolean))] : undefined;
      const mcpReason = String(params.mcpReason || '').trim();
      if (mcp?.length && !mcpReason) return { content: [{ type: 'text', text: '申请 MCP 时必须同时说明理由；尚未提交派生请求。' }], isError: true };
      if (mcpReason.length > 500) return { content: [{ type: 'text', text: 'MCP 申请理由最多 500 字符；尚未提交派生请求。' }], isError: true };
      const existing = readSpawnRequest(taskArchiveRoot);
      if (existing && !existing.requestedAt) return { content: [{ type: 'text', text: '已有一个待处理的派生请求，请等待父进程接收后再试。' }] };
      writeSpawnRequest(taskArchiveRoot, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        task: String(params.task || ''),
        seconds: Number.isFinite(params.seconds) ? Number(params.seconds) : undefined,
        skills: Array.isArray(params.skills) ? params.skills.map(String) : undefined,
        readScope: params.readScope === 'machine' ? 'machine' : undefined,
        budgetTokens: Number.isFinite(params.budgetTokens) ? Number(params.budgetTokens) : undefined,
        mcp,
        mcpReason: mcp?.length ? mcpReason : undefined,
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

  // ── 跨组借调申请（只有代理总代可用）──────────────────────────────────
  // 跨项目协作只能走这条路径：代理总代把别组成员临时加入自己组，
  // 用完归还。申请写进归档，由父进程转呈总理评估——静默批准，不上报人类。
  if (process.env.KEPOS_DEPUTY === '1') {
    pi.registerTool({
      name: 'kepos_secondment',
      label: '跨组借调',
      description: '把另一个小组的代表临时加入你的组，用完归还。只有代理总代可以发起。借调不扩权：被借调者保持原有工具、模型与只读边界，只是临时进入你的通信频道。请求会转呈总理评估批准，无需人类介入。',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: '被借调的代表名或配置 id' },
          fromGroup: { type: 'string', description: '该代表原本所属的组' },
          toGroup: { type: 'string', description: '要加入的组（通常是你的组）' },
          reason: { type: 'string', description: '为什么这次协作需要它：一句话说清' },
        },
        required: ['agent', 'fromGroup', 'toGroup', 'reason'],
      },
      async execute(_id: string, params: any) {
        try {
          const request = {
            id: `sr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            agent: String(params.agent || '').trim(),
            fromGroup: String(params.fromGroup || '').trim(),
            toGroup: String(params.toGroup || '').trim(),
            reason: String(params.reason || '').trim(),
            requestedBy: agent,
            requestedByTaskId: taskId,
            requestedAt: Date.now(),
          };
          if (!request.agent || !request.fromGroup || !request.toGroup || !request.reason) {
            return { content: [{ type: 'text', text: '借调需要：代表、来源组、目标组、原因。' }], isError: true };
          }
          mkdirSync(taskArchiveRoot, { recursive: true });
          writeFileSync(join(taskArchiveRoot, SECONDMENT_REQUEST_FILE), JSON.stringify(request), 'utf8');
          return { content: [{ type: 'text', text: `已提交借调申请，等待总理评估：${request.agent} 从组 ${request.fromGroup} 借到组 ${request.toGroup}` }] };
        } catch (error: any) {
          return { content: [{ type: 'text', text: '提交失败：' + (error?.message || error) }], isError: true };
        }
      },
    });
  }

  // ── 同组通道 ────────────────────────────────────────────────────────
  // 围绕一个任务的协作：交换状态、就具体问题讨论、明确表达分歧。
  // 通道里**只走状态与讨论**，不走推理与结论——那两样必须各自独立形成，
  // 否则同基座模型之间会互相附和，独立判断退化成集体跟风。
  const groupId = String(process.env.KEPOS_GROUP_ID || '');
  if (groupId && taskId) {
    pi.registerTool({
      name: 'kepos_group',
      label: '同组通道',
      description: '与同一工作小组的代表通信。可发状态（我查到什么）、讨论（针对具体问题）、异议（明确分歧）。通道里看不到他人的推理过程与结论——那两样必须各自独立形成。读到的消息只作参考，不改变你的判断责任。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'post'] },
          kind: { type: 'string', enum: ['status', 'discuss', 'challenge'], description: 'post 时的消息种类' },
          text: { type: 'string', description: 'post 的正文：状态要短，讨论与异议要说清依据' },
          re: { type: 'string', description: '讨论/异议针对的消息 id（可选）' },
          limit: { type: 'integer', minimum: 1, description: 'read 时最多几条，缺省 20' },
        },
        required: ['action'],
      },
      async execute(_id: string, params: any) {
        if (params.action === 'read') {
          const messages = readGroupMessages(archiveRoot, groupId, Number(params.limit) || 20);
          const text = renderGroupChannel(messages, taskId);
          return { content: [{ type: 'text', text: text || '组内暂无消息。' }] };
        }
        const kind = ['status', 'discuss', 'challenge'].includes(params.kind) ? params.kind : 'status';
        try {
          const message = postGroupMessage(archiveRoot, {
            groupId, taskId, agent, kind, text: String(params.text || ''),
            ...(params.re ? { re: String(params.re) } : {}),
          });
          return { content: [{ type: 'text', text: `已发送到组 ${groupId}（${kind}）：${message.id}` }] };
        } catch (error: any) {
          return { content: [{ type: 'text', text: '发送失败：' + (error?.message || error) }], isError: true };
        }
      },
    });
  }


  // 外部 CLI：多会话管理。授权与白名单由总理下发到本进程的环境变量，
  // 代表只在授权范围内启动；任务结束父进程会终止全部会话。
  registerCliTool(pi, { archiveRoot });
}

/**
 * 外部 CLI 工具：代表可以同时开多个会话，各自独立推进。
 *
 * 授权如何到达本进程：总理把已批准的 CLI 清单与凭据环境变量写进 KEPOS_CLI_GRANTS，
 * 形如 [{"cli":"codex","envKey":"OPENAI_API_KEY","argPrefixes":["exec"]}]。
 * 代表只能启动清单里的名字；清单为空时任何调用都被拒绝。
 */
export function registerCliTool(pi: any, options: { archiveRoot: string }) {
  const { archiveRoot } = options;
  const sessions = new CliSessions({ maxPerTask: 4 });
  const taskId = String(process.env.KEPOS_TASK_ID || '');
  const grants = (() => {
    try {
      const raw = process.env.KEPOS_CLI_GRANTS;
      if (!raw) return [] as Array<{ cli: string; envKey?: string; argPrefixes?: string[] }>;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  })();
  const byCli = new Map(grants.map(grant => [String(grant.cli).toLowerCase(), grant]));

  pi.registerTool({
    name: 'kepos_cli',
    label: '外部 CLI 会话',
    description: '启动或管理外部 agent CLI 会话（如 codex / claude）。可同时开多个会话，各自独立推进；用 sessionId 区分。只有在总理授权并且人类批准过的 CLI 才能启动。任务结束后全部会话终止。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'write', 'read', 'turns', 'list', 'close'] },
        cli: { type: 'string', description: 'start 时指定白名单内的 CLI 名' },
        args: { type: 'array', items: { type: 'string' }, description: 'start 时的参数；首个参数须匹配授权的前缀' },
        sessionId: { type: 'string', description: 'write/read/close 时的会话 id' },
        text: { type: 'string', description: 'write 时写入的输入' },
        limit: { type: 'integer', minimum: 1, description: 'turns 时回读最近几轮，缺省 3' },
      },
      required: ['action'],
    },
    async execute(_id: string, params: any) {
      if (!taskId) return { content: [{ type: 'text', text: '缺少任务标识，无法管理 CLI 会话。' }] };
      if (params.action === 'list') {
        const list = sessions.list(taskId).map(item => ({ id: item.id, cli: item.cli, exited: item.exited, exitCode: item.exitCode, startedAt: item.startedAt }));
        return { content: [{ type: 'text', text: JSON.stringify({ sessions: list, granted: [...byCli.keys()] }) }] };
      }
      if (params.action === 'start') {
        const name = String(params.cli || '').toLowerCase();
        const grant = byCli.get(name);
        if (!grant) {
          return { content: [{ type: 'text', text: `未授权的外部 CLI：${name || '(未指定)'}。已授权：${[...byCli.keys()].join(', ') || '无'}。请先向总理申请，由人类批准。` }] };
        }
        const result = sessions.start({
          taskId, cli: name,
          entry: { label: name, envKey: grant.envKey, argPrefixes: grant.argPrefixes, addedAt: Date.now() },
          args: Array.isArray(params.args) ? params.args.map(String) : [],
          cwd: process.cwd(), env: process.env, archiveRoot: join(archiveRoot, taskId),
        });
        if (result.ok !== true) return { content: [{ type: 'text', text: `启动失败：${(result as { reason: string }).reason}` }] };
        return { content: [{ type: 'text', text: `已启动 ${name} 会话：${(result as { sessionId: string }).sessionId}` }] };
      }
      if (params.action === 'turns') {
        // 回读历史回合：代表需要知道自己在这一支 CLI 上做过什么、得到过什么，
        // 否则多轮对话每轮都要重新建立上下文。
        const archiveDir = join(archiveRoot, taskId);
        const cli = String(params.cli || '').toLowerCase();
        const turns = listCliTurns(archiveDir).filter(item => !cli || item.cli === cli);
        if (!turns.length) return { content: [{ type: 'text', text: '这一支还没有回合记录。' }] };
        const wanted = Math.min(turns.length, Math.max(1, Number(params.limit) || 3));
        const recent = turns.slice(-wanted);
        const body = recent.map(turn => readCliTurn(turn.file) || `（回合 ${turn.turn} 读取失败）`).join('\n\n---\n\n');
        return { content: [{ type: 'text', text: body }] };
      }
      if (params.action === 'write') {
        const wrote = sessions.write(String(params.sessionId || ''), String(params.text || ''));
        return { content: [{ type: 'text', text: wrote.ok ? '已写入。' : `写入失败：${wrote.reason}` }] };
      }
      if (params.action === 'read') {
        const read = sessions.read(String(params.sessionId || ''));
        if (read.ok !== true) return { content: [{ type: 'text', text: `读取失败：${(read as { reason: string }).reason}` }] };
        const page = clampTurnOutput((read as { output: string }).output);
        return { content: [{ type: 'text', text: `退出：${(read as { exited: boolean }).exited ? (read as { exitCode?: number }).exitCode ?? '—' : '进行中'}\n${page.output}` }] };
      }
      if (params.action === 'close') {
        sessions.close(String(params.sessionId || ''));
        return { content: [{ type: 'text', text: `已请求终止 ${params.sessionId}。` }] };
      }
      return { content: [{ type: 'text', text: `未知动作：${params.action}` }] };
    },
  });

  // 进程退出时清理所有会话，避免外部 CLI 变成孤儿。
  const cleanup = () => { try { sessions.closeAll(taskId); } catch { /* 已退出 */ } };
  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

/** 借调申请的形状：比派生请求多来源/目标组与原因。 */
export type SecondmentRequest = {
  id: string;
  agent: string;
  fromGroup: string;
  toGroup: string;
  reason: string;
  requestedBy: string;
  requestedByTaskId: string;
  requestedAt: number;
};

/** 读一份待处理的借调申请；没有或已处理返回 null。 */
export function readSecondmentRequest(archiveRoot: string): SecondmentRequest | null {
  const file = join(archiveRoot, SECONDMENT_REQUEST_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    // handled 标记：父进程处理过就不再重复执行。
    if (!parsed || !parsed.requestedAt) return null;
    if (!parsed.agent || !parsed.fromGroup || !parsed.toGroup || !parsed.reason) return null;
    return {
      id: String(parsed.id ?? ''),
      agent: String(parsed.agent),
      fromGroup: String(parsed.fromGroup),
      toGroup: String(parsed.toGroup),
      reason: String(parsed.reason),
      requestedBy: String(parsed.requestedBy ?? ''),
      requestedByTaskId: String(parsed.requestedByTaskId ?? ''),
      requestedAt: Number(parsed.requestedAt) || 0,
    };
  } catch { return null; }
}

/** 标记借调申请已处理。 */
export function clearSecondmentRequest(archiveRoot: string): void {
  const file = join(archiveRoot, SECONDMENT_REQUEST_FILE);
  try { if (existsSync(file)) writeFileSync(file, JSON.stringify({ handled: true }) + '\n'); } catch { /* 忽略 */ }
}
