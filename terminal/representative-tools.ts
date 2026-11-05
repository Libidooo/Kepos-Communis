// 代表侧扩展：在代表自己的进程里注册派生与裁决工具。
//
// 为什么走文件而不是 RPC：worker 只被父进程单向驱动（父 → 子），
// 子进程没有上行通道。要在代表进程里发起派生，只能用父进程能观察到的副作用——
// 写归档目录里的请求文件，父进程轮询后执行。
// 这条路有代价（延迟一个轮询周期），但它不需要改动 RPC 协议，也不给子进程
// 新增网络能力，权限面最小。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliSessions } from './cli-runtime.ts';
import { clampTurnOutput } from './cli-dialog.ts';
import { postGroupMessage, readGroupMessages, renderGroupChannel } from './group-channel.ts';
import { listCliTurns, readCliTurn } from './cli-dialog.ts';

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
  // 本任务 id：定位自己的归档、认出自己的僚属、在组通道里标识发言者。
  const taskId = String(process.env.KEPOS_TASK_ID || '');
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
