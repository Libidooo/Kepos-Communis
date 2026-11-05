// 同组证据互读：把"证据"从归档里单独切出来，只对这一份放行。
//
// 为什么不能直接放开归档：
//   归档里的 transcript.md 与 report.md 都含结论。允许读文件就等于允许读结论，
//   而结论必须各自独立形成——同基座模型读到彼此判断会趋同，独立判断退化成附和。
//
// 所以这一层只做一件事：把每个任务产出里"## 结论"之前的部分写成
// .kepos/groups/<id>/evidence/<taskId>.md，同组可读，其余一律不读。
// 结论无论写在哪里都不会进来——切分在源头完成，而不是靠读取方自觉。
//
// 为什么证据值得共享：重复劳动是委派最贵的失败模式。两个代表各自读同一批文件，
// 付两份钱得到同一份事实；而"我查过 A 目录了"这类信息共享出去能直接省掉一轮。
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GROUP_DIR, groupDirName, safe } from './group-channel.ts';
import { splitEvidenceAndConclusion, type GroupMember } from './workgroup.ts';

/** 证据子目录：与消息文件同层但分开，避免与 message 文件混读。 */
export const EVIDENCE_DIR = 'evidence';
/** 单个任务的证据上限。共享是为了省重复劳动，不是转移整份上下文。 */
export const MAX_EVIDENCE_CHARS = 6000;

export function evidenceRoot(archiveRoot: string, groupId: string): string {
  return join(archiveRoot, GROUP_DIR, groupDirName(groupId), EVIDENCE_DIR);
}

/**
 * 把一个任务的产出切成证据，写入组内可见目录。
 *
 * 返回是否真的写了（没有证据可写时返回 false，不留空文件）。
 * 结论段永远不写入——即使它在产出里出现了多次，也只取第一处之前的内容。
 */
export function publishEvidence(input: {
  archiveRoot: string;
  groupId: string;
  task: { id: string; agent: string; output?: string; status?: string; started?: number; ended?: number };
}): boolean {
  const groupId = String(input.groupId ?? '').trim();
  if (!groupId) return false;
  const output = String(input.task.output ?? '');
  if (!output.trim()) return false;
  // 先切再判：只有证据段非空才落盘。
  const { evidence } = splitEvidenceAndConclusion(output);
  const body = evidence.trim();
  if (!body) return false;
  const dir = evidenceRoot(input.archiveRoot, groupId);
  try { mkdirSync(dir, { recursive: true }); } catch { return false; }
  const trimmed = body.length > MAX_EVIDENCE_CHARS
    ? `${body.slice(0, MAX_EVIDENCE_CHARS - 200)}\n… [证据过长已截断] …\n${body.slice(-200)}`
    : body;
  // 抬头里的名字是给人读的：不能过 safe()——它只保留 [A-Za-z0-9_-]，
  // 中文代表名会被剥成空串，读回来就分不出是谁的证据。只有文件名需要清洗。
  const agentLabel = String(input.task.agent ?? '').replace(/[\r\n\u0000-\u001f]/g, ' ').trim() || '代表';
  const header = [
    `# ${agentLabel} · ${safe(input.task.id)}`,
    '',
    `- 状态：${String(input.task.status ?? '—')}`,
    `- 开始：${input.task.started ? new Date(input.task.started).toISOString() : '—'}`,
    `- 结束：${input.task.ended ? new Date(input.task.ended).toISOString() : '进行中'}`,
    '',
    '> 这里只有证据，不含结论。结论必须各自独立形成。',
    '',
  ].join('\n');
  try { writeFileSync(join(dir, `${safe(input.task.id)}.md`), header + trimmed + '\n', 'utf8'); }
  catch { return false; }
  return true;
}

export type PeerEvidence = { taskId: string; agent: string; state: string; body: string };

/** 读同组其他人的证据，最新的在前。`selfTaskId` 的那份不返回——自己写的不用再读。 */
export function readGroupEvidence(archiveRoot: string, groupId: string, selfTaskId: string, limit = 4): PeerEvidence[] {
  const dir = evidenceRoot(archiveRoot, groupId);
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  try { files.push(...readdirSync(dir).filter(name => name.endsWith('.md'))); } catch { return []; }
  const out: PeerEvidence[] = [];
  for (const name of files) {
    if (name === `${safe(selfTaskId)}.md`) continue;
    let text: string;
    try { text = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    const title = /^# (.+)$/m.exec(text)?.[1] ?? name;
    const state = /^- 状态：(.+)$/m.exec(text)?.[1]?.trim() ?? '—';
    const [agent, taskId] = title.split('·').map(part => part.trim());
    // 去掉我们自己写的抬头与说明，只留证据正文。
    const body = text.split('> 这里只有证据，不含结论。结论必须各自独立形成。\n')[1]?.trim() ?? text;
    out.push({ taskId: taskId || name.replace(/\.md$/, ''), agent: agent || '—', state, body });
    if (out.length >= limit) break;
  }
  return out;
}

/** 渲染成可注入的段落。没有证据时返回空串，不产生空标题。 */
export function renderPeerEvidence(items: readonly PeerEvidence[]): string {
  if (!items.length) return '';
  const lines = ['## 同组证据（只有事实，不含结论）'];
  for (const item of items) {
    lines.push('', `### ${item.agent} · ${item.state}`, '', item.body);
  }
  lines.push('', '以上是其他成员读到的事实。可以引用它们，但不要据此推断他们的判断。');
  return lines.join('\n');
}

/** 任务离开组或结束时清掉它的证据：组是临时的，证据不该比组活得久。 */
export function clearGroupEvidence(archiveRoot: string, groupId: string): number {
  const dir = evidenceRoot(archiveRoot, groupId);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      try { unlinkSync(join(dir, name)); removed++; } catch { /* 忽略 */ }
    }
  } catch { /* 目录读不到 */ }
  return removed;
}

/**
 * 组内可见的证据视图，供 `visibleToPeer` 的既有签名复用。
 *
 * 保留这个函数是为了让 workgroup.ts 里早已写好、却从未被调用的
 * evidence/conclusion 切分逻辑真正接到调用链上，而不是另写一套。
 */
export function groupEvidenceFor(member: GroupMember, output: string): PeerEvidence {
  const { evidence } = splitEvidenceAndConclusion(output);
  return { taskId: member.taskId, agent: member.agent, state: member.state, body: evidence.trim() };
}
