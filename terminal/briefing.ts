// 人类在任务进行中改变需求：这不是"再派一个任务"，是打断当前安排。
//
// 三条路径的区别必须清楚：
//   发给总理  —— 加急插入，总理结合进度重排计划，人多时把活分给代理总代。
//   发给代表  —— 代表停下当前目标，接受新安排，并向其上级汇报（有代理总代发给它，
//                否则发给总理）。汇报是这条路径的**目的**，不是附带动作：
//                改了安排却不告诉上级，等于上级手里的计划已经过期了。
//   发给僚属  —— 不允许。人类不直接指挥僚属，否则责任链断在中间：
//                代表不知道自己的下属被改了方向，也就无法对它负责。
import { randomUUID } from 'node:crypto';
import type { KeposDatabase } from './database.ts';

/** 收件人类别。僚属不在其中——这是设计，不是遗漏。 */
export type BriefingTarget = 'premier' | 'representative';

/** 加急指令的送达结果。失败必须是一个真实的取值，不能静默消失。 */
export type BriefingDelivery = 'queued' | 'forwarded' | 'woken' | 'new-task' | 'failed';

export type BriefingRecord = {
  id: string;
  at: number;
  target: BriefingTarget;
  /** 代表名或 '总理'。 */
  targetName: string;
  /** 相关任务；发给总理时为空。 */
  taskId?: string;
  text: string;
  delivery: BriefingDelivery;
  note?: string;
};

/** 单条指令上限：这是"改一句需求"，不是又一篇规格书。 */
export const MAX_BRIEFING_CHARS = 2000;

/**
 * 加急指令的统一抬头。
 *
 * 抬头存在的原因不是装饰：模型读到的是一段普通文本，
 * 没有这个标记它会把"改需求"当成"补充信息"，继续按原计划往下做。
 */
export const BRIEFING_HEADER = '## 人类加急';

/**
 * 给总理的加急指令：只带人类原话和加急标记。
 *
 * 重排纪律（先读进度、再对照计划、显式取消被替代的任务）常驻在监督提示词里，
 * 不必随每条加急重复注入——此前整段模板跟进来，对话里满屏"你需要做的"，
 * 人类只说了一句话，界面却像发了一篇檄文。
 */
export function premierBriefing(text: string): string {
  return [
    BRIEFING_HEADER,
    '',
    text.trim().slice(0, MAX_BRIEFING_CHARS),
  ].join('\n');
}

/**
 * 给代表的加急指令：停下当前目标，接受新安排，并向指定上级汇报。
 *
 * "停下"必须写清楚是**放弃当前目标**而不是做完再说。
 * 只写"请注意以下变更"，代表会把它当成追加要求，原来那件事照样跑完。
 */
export function representativeBriefing(text: string, superior: { name: string; role: 'deputy' | 'premier' }): string {
  const to = superior.role === 'deputy' ? `代理总代「${superior.name}」` : '总理';
  return [
    BRIEFING_HEADER,
    '',
    text.trim().slice(0, MAX_BRIEFING_CHARS),
    '',
    '## 你现在要做的',
    '1. **停下**当前目标：不要再推进原来的任务，也不要为了"做完手头这步"而延迟。已完成的产出保留，未完成的放弃。',
    '2. 判断这条变更让你原本的任务作废、缩小还是转向；只做新安排要求的部分。',
    `3. 收尾时在结论里写清三件事：原来做到哪、因为这条变更停了什么、按新安排接下来做什么。这份结论会转给${to}。`,
    '4. 不要自行扩大范围：新安排没提到的事不做，需要额外授权就写进「需要」一节。',
  ].join('\n');
}

/**
 * 代表刚收到变更时的即时转呈。
 *
 * 为什么不能等它跑完再报：上级手里的计划此刻已经过期了，
 * 越晚报出，上级基于旧计划做的安排越多。所以先报"变更已下达"，
 * 结论等代表真正改道完成后再补一份。
 */
export function briefingIssued(input: { agent: string; taskId: string; briefing: string }): string {
  return [
    '## 代表改道通知（结论待补）',
    '',
    `代表「${input.agent}」已收到人类变更，正在停止原目标（任务 ${input.taskId}）。`,
    '',
    '### 人类的变更',
    input.briefing.trim().slice(0, 800) || '（未记录内容）',
    '',
    '### 现在需要你知道的',
    '这条变更可能已经让你手上的计划失效一部分。在收到该代表的收尾结论前，不要基于它的旧方向继续安排。',
  ].join('\n');
}

/** 代表改道后，向上级转呈的汇报。 */
export function upwardReport(input: { agent: string; taskId: string; briefing: string; conclusion: string }): string {
  return [
    `## 代表汇报（因人类变更而改道）`,
    '',
    `代表「${input.agent}」在执行任务 ${input.taskId} 期间收到人类变更，已停下原目标。`,
    '',
    '### 人类的变更',
    input.briefing.trim().slice(0, 800) || '（未记录内容）',
    '',
    '### 代表的结论',
    input.conclusion.trim().slice(0, 1200) || '（代表未给出结论）',
    '',
    '### 需要你决定的',
    '这份汇报改变了原计划的一步：请确认后续安排，必要时更新计划并通知相关代表。',
  ].join('\n');
}

/**
 * 加急指令的落库。
 *
 * 为什么要存：界面上的"已加急"必须能对应到一条真实记录。
 * 之前的排队提示在消息实际丢失时依然显示成功——那种"看起来送到了"正是要消除的。
 */
export class BriefingStore {
  constructor(private readonly database: KeposDatabase) {}

  record(input: Omit<BriefingRecord, 'id' | 'at'> & { at?: number }): BriefingRecord {
    const record: BriefingRecord = {
      id: randomUUID(),
      at: input.at ?? Date.now(),
      target: input.target,
      targetName: input.targetName,
      taskId: input.taskId,
      text: String(input.text ?? '').slice(0, MAX_BRIEFING_CHARS),
      delivery: input.delivery,
      note: input.note,
    };
    this.database.prepare('INSERT INTO human_briefings(id,at,target,target_name,task_id,text,delivery,note) VALUES(?,?,?,?,?,?,?,?)')
      .run(record.id, record.at, record.target, record.targetName, record.taskId ?? null, record.text, record.delivery, record.note ?? null);
    return record;
  }

  /** 最近的人类变更，最新的在前。同一毫秒内按 rowid 倒序，否则排序不稳定。 */
  recent(limit = 20): BriefingRecord[] {
    const rows = this.database.prepare('SELECT id,at,target,target_name,task_id,text,delivery,note FROM human_briefings ORDER BY at DESC, rowid DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))) as any[];
    return rows.map(row => ({
      id: row.id, at: Number(row.at), target: row.target, targetName: row.target_name,
      taskId: row.task_id ?? undefined, text: row.text, delivery: row.delivery, note: row.note ?? undefined,
    }));
  }

  /** 某任务收到过的人类变更——任务详情里要能看到"它为什么改了方向"。 */
  forTask(taskId: string): BriefingRecord[] {
    const rows = this.database.prepare('SELECT id,at,target,target_name,task_id,text,delivery,note FROM human_briefings WHERE task_id=? ORDER BY at DESC, rowid DESC').all(taskId) as any[];
    return rows.map(row => ({
      id: row.id, at: Number(row.at), target: row.target, targetName: row.target_name,
      taskId: row.task_id ?? undefined, text: row.text, delivery: row.delivery, note: row.note ?? undefined,
    }));
  }
}

/** 送达结果的一句话说明，界面与工具共用。 */
export function deliveryNote(delivery: BriefingDelivery, targetName: string): string {
  switch (delivery) {
    // queued 是总理这一侧：它正在执行，消息插进当前回合并等它读完重排。
    case 'queued': return `已加急插入 ${targetName} 的当前回合：工具调用结束后立刻处理`;
    // forwarded 是代表已经在跑：它做完当前工具批次就改道。
    case 'forwarded': return `已转给 ${targetName}：它会在当前工具批次结束后停下并改道`;
    // woken 是代表还没轮到：这句把人从队列里提出来，抢占预留槽立刻启动。
    case 'woken': return `已加急启动 ${targetName}：它还没轮到的任务现在开始跑`;
    case 'new-task': return `已按原配置为 ${targetName} 开新任务`;
    case 'failed': return `未能送达 ${targetName}`;
    default: return '';
  }
}
