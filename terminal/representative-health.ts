import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

export interface RepresentativeTaskHistory {
  id: string;
  agent: string;
  agentId?: string;
  purpose?: string;
  state: string;
  profileRevision?: string;
  started?: number;
  ended?: number;
  error?: string;
}

export interface RepresentativeIdentity { id?: string; name: string }
export type FailureCategory = 'authentication' | 'model' | 'startup' | 'transport' | 'timeout' | 'execution';
const finishedStates = new Set(['SUCCEEDED', 'FAILED', 'INTERRUPTED', 'CANCELLED', 'TIMED_OUT']);

function safeReason(value: unknown): string {
  return stripVTControlCharacters(String(value || '未提供错误原因'))
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .slice(0, 240);
}

export function failureCategory(task: Pick<RepresentativeTaskHistory, 'state' | 'error'>): FailureCategory {
  const error = String(task.error || '');
  if (/unauthori[sz]ed|forbidden|api.?key|credential|auth|401|403|认证|凭据|鉴权/i.test(error)) return 'authentication';
  if (/model.*(?:not found|unknown|unsupported|unavailable)|unknown model|模型.*(?:不存在|不可用|未找到)/i.test(error)) return 'model';
  if (/unknown options|worker exited|spawn|enoent|rpc.*(?:timed out|closed)|owner.*(?:exited|silent)|启动/i.test(error)) return 'startup';
  if (/network|fetch failed|econn|enotfound|socket|tls|certificate|429|5\d\d|网络/i.test(error)) return 'transport';
  if (task.state === 'TIMED_OUT' || /timed? ?out|deadline|超时/i.test(error)) return 'timeout';
  return 'execution';
}

const advice: Record<FailureCategory, string> = {
  authentication: '检查该供应商的登录、Key 引用和子进程凭据传递；不要索取或输出密钥。',
  model: '核对当前可用模型目录，必要时修改代表的模型配置；不要猜模型 ID。',
  startup: '检查 Worker 启动参数、RPC 和执行器状态；这是运行环境问题，不等于代表能力失效。',
  transport: '检查服务可达性、限流和连接状态；不要无上限地重试。',
  timeout: '核对任务范围、网络延迟和时限；预算调整由人类决定。',
  execution: '核对职责、输入、Skill 绑定和验收要求，提出最小配置修订。',
};

export function representativeHealth(tasks: readonly RepresentativeTaskHistory[], member: RepresentativeIdentity) {
  const history = tasks.filter(task => {
    if (!finishedStates.has(task.state) || task.purpose === 'configuration') return false;
    if (task.agentId && member.id) return task.agentId === member.id;
    return !task.agentId && task.agent === member.name;
  }).sort((a, b) => (b.ended ?? b.started ?? 0) - (a.ended ?? a.started ?? 0) || b.id.localeCompare(a.id));
  const evaluated = history.filter(task => task.state !== 'CANCELLED' && !/预算|budget|cancelled by|user abort|人工取消/i.test(task.error || ''));
  const revision = evaluated[0]?.profileRevision;
  const recent = evaluated.filter(task => task.profileRevision === revision).slice(0, 10);
  const failed = recent.filter(task => task.state !== 'SUCCEEDED');
  let consecutive = 0;
  for (const task of recent) { if (task.state === 'SUCCEEDED') break; consecutive++; }
  const needsDiagnosis = consecutive >= 3 || recent.length >= 5 && failed.length / recent.length >= .5;
  const issues = failed.slice(0, 5).map(task => ({ taskId: task.id, category: failureCategory(task), reason: safeReason(task.error) }));
  const fingerprint = createHash('sha256').update(JSON.stringify([member.id || member.name, revision, recent.map(task => task.id)])).digest('hex');
  return {
    agentId: member.id,
    name: member.name,
    revision,
    sampleSize: recent.length,
    failureCount: failed.length,
    consecutiveFailures: consecutive,
    needsDiagnosis,
    issues,
    recommendations: [...new Set(issues.map(issue => advice[issue.category]))],
    fingerprint,
    availableForDispatch: true,
  };
}

export function representativeRisk(tasks: readonly RepresentativeTaskHistory[], member: RepresentativeIdentity): string | undefined {
  const health = representativeHealth(tasks, member);
  if (!health.needsDiagnosis) return undefined;
  return `近 ${health.sampleSize} 轮有 ${health.failureCount} 轮未完成，需总理诊断；代表仍可使用，配置与历史保留。`;
}
