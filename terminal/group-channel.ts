// 同组通信：围绕一个任务的协作。
//
// 组内可以发生的事（人类裁定）：
//   - 交换任务状态："我查完 A 目录了，B 目录还没动"
//   - 就具体问题讨论："我这边发现 auth 走 OAuth，你那边的 session 逻辑还有效吗"
//   - 争吵与辩论："你这个结论和证据对不上，重新核一下"
//
// 组内绝不能发生的事：
//   - 读对方的思考过程（推理链、犹豫、内部权衡）
//   - 读对方的结论（那是各自独立形成的判断）
//
// 为什么这条界线是这样划的：同组共享的是**事实与问题**，不是判断。
// 一旦能读到对方的结论，独立判断就退化成互相附和——同基座模型尤其如此。
// 而共享事实与问题，恰恰是减少重复劳动的部分。
//
// 实现走文件通道，与 spawn 请求同一理由：worker 只有父 → 子的单向 RPC，
// 子进程发起的行为只能通过父进程可观察的副作用表达。
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_DIR } from './archive.ts';

/** 组通道目录：放在归档区下，父进程与同组代表都能看到。 */
export const GROUP_DIR = 'groups';
/** 单条消息上限：这是"一句话通知/一个问题"，不是又一份报告。 */
export const MAX_MESSAGE_CHARS = 1200;
/** 每组成员最多保留多少条未读：超出按时间丢弃最旧的，避免通道变成第二个上下文。 */
export const MAX_MESSAGES_PER_GROUP = 60;

/** 消息种类。「讨论」是提问与回应，「辩论」是明确的分歧。 */
export type GroupMessageKind = 'status' | 'discuss' | 'challenge';

export type GroupMessage = {
  id: string;
  /** 组标识。 */
  groupId: string;
  /** 发言者的任务 id——用于判定"是不是我自己说的"。 */
  taskId: string;
  /** 发言者代表名。 */
  agent: string;
  kind: GroupMessageKind;
  /** 正文。状态类应短；讨论与辩论要说清依据。 */
  text: string;
  at: number;
  /** 指向的消息 id：讨论/辩论针对的是哪一条。 */
  re?: string;
};

const safe = (value: string) => String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '');

export function groupDir(archiveRoot: string, groupId: string): string {
  return join(archiveRoot, GROUP_DIR, safe(groupId));
}

/** 一个组在磁盘上的消息文件按时间命名，读时直接排序即可。 */
function messageFile(dir: string, message: GroupMessage): string {
  return join(dir, `${String(message.at).padStart(15, '0')}-${safe(message.id)}.json`);
}

/**
 * 发一条消息。
 *
 * `re` 只在讨论/辩论时可选：允许不带，因为有些分歧是对整个局面的。
 */
export function postGroupMessage(archiveRoot: string, input: Omit<GroupMessage, 'id' | 'at'> & { at?: number }): GroupMessage {
  const groupId = String(input.groupId ?? '').trim();
  if (!groupId) throw Error('缺少 groupId');
  if (!input.taskId) throw Error('缺少发言者任务 id');
  const text = String(input.text ?? '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!text) throw Error('消息不能为空');
  const message: GroupMessage = {
    id: `${safe(input.taskId).slice(0, 8)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    groupId, taskId: String(input.taskId), agent: String(input.agent ?? ''), kind: input.kind,
    text, at: input.at ?? Date.now(), ...(input.re ? { re: String(input.re) } : {}),
  };
  const dir = groupDir(archiveRoot, groupId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(messageFile(dir, message), JSON.stringify(message), 'utf8');
  pruneGroup(dir);
  return message;
}

/**
 * 只留最近 N 条。
 *
 * 通道不能被当成第二个上下文：代表读到的每一条都占 token。
 * 超出就丢最旧的——组内协作关心的是当下，不是完整纪要。
 */
function pruneGroup(dir: string): void {
  try {
    const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort();
    for (const name of files.slice(0, Math.max(0, files.length - MAX_MESSAGES_PER_GROUP))) {
      try { unlinkSync(join(dir, name)); } catch { /* 删不掉不影响新消息 */ }
    }
  } catch { /* 目录读不到就跳过清理 */ }
}

/** 读一组消息，最新的在前。 */
export function readGroupMessages(archiveRoot: string, groupId: string, limit = 20): GroupMessage[] {
  const dir = groupDir(archiveRoot, groupId);
  if (!existsSync(dir)) return [];
  const out: GroupMessage[] = [];
  let names: string[];
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')).sort().reverse(); }
  catch { return []; }
  for (const name of names.slice(0, Math.max(1, limit))) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed && typeof parsed.text === 'string') out.push(parsed as GroupMessage);
    } catch { /* 坏消息跳过——一条坏文件不该让整个通道消失 */ }
  }
  return out;
}

/**
 * 把消息渲染成代表可读的一段文字。
 *
 * 每条都带发言者与种类，且**不包含任何推理或结论内容**——
 * 通道里传的只有状态、问题与分歧本身。这条界线由发送端保证（只允许三种 kind），
 * 这里只做展示。
 */
export function renderGroupChannel(messages: readonly GroupMessage[], selfTaskId: string): string {
  if (!messages.length) return '';
  const label: Record<GroupMessageKind, string> = { status: '状态', discuss: '讨论', challenge: '异议' };
  const lines = messages.map(message => {
    const who = message.taskId === selfTaskId ? '你' : message.agent || message.taskId.slice(0, 8);
    return `- [${label[message.kind] ?? message.kind}] ${who}：${message.text}`;
  });
  return ['## 同组通道（只含状态与讨论，不含他人推理与结论）', '', ...lines].join('\n');
}

/** 这条消息是不是发给我的（不含自己发的）。 */
export function addressedElsewhere(message: GroupMessage, selfTaskId: string): boolean {
  return message.taskId !== selfTaskId;
}
