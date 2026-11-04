// 自动化能力：系统在没人开口时自己干活。
//
// 这是整套系统里唯一会"不问自取"的部分，所以规则写在一处、且只有三条：
//
//   1. 每个能力都必须被人类显式打开。默认全关。
//      装好就开着的能力，等于把"要不要开始花钱"这个决定交给了默认值。
//
//   2. 会启动任务的，必须是代理档。
//      严格档防的就是"系统自己动"；把自动派发放在严格档下能开，是把这道防线拆了。
//      只读档更不行——它的定义就是没有行动能力。
//
//   3. 观察与派发是两个独立开关，不是同一个开关的两档。
//      "先看一周候选表，确认规则不误伤，再决定要不要真的派人"是这套东西的主要用法；
//      合成一个开关，就等于要人在还没数据的时候做决定。
//
// 为什么观察不受档位限制：它只往数据库写候选行，不启动进程、不花钱、不改文件。
// 它没有"行动"，所以不需要行动权限。这一点也让校准变得可行——
// 谁都能先观察，看清楚了再谈放权。
import type { ApprovalPolicy } from './approval.ts';
import type { WatchRule } from './watch.ts';

/** 三个自动化能力。键名即配置名。 */
export type AutomationCapability = 'observe' | 'dispatch' | 'precheck';

export type AutomationSettings = {
  /** 值守观察：监听目录，命中规则只记录候选。不派任务。 */
  observe?: boolean;
  /** 值守自动派发：命中且有语义评估通过时，真的开任务。需要代理档。 */
  dispatch?: boolean;
  /** 静默预检：并行复现一条 bug 报告。需要代理档。 */
  precheck?: boolean;
  /** 监听哪些目录；空表示当前工作目录。 */
  roots?: string[];
  /** 值守规则；空表示使用内置默认规则。 */
  rules?: WatchRule[];
  /** 预检用哪几位代表（名称或 id）；空表示按角度顺序取已配置的前几位。 */
  precheckAgents?: string[];
};

/** 三项能力的默认值。全关——这不是保守，是这类能力唯一可接受的默认。 */
export const AUTOMATION_DEFAULTS: Required<Pick<AutomationSettings, AutomationCapability>> = { observe: false, dispatch: false, precheck: false };

/** 能力是否会产生行动（启动任务、消耗预算）。 */
export function isActingCapability(capability: AutomationCapability): boolean {
  return capability === 'dispatch' || capability === 'precheck';
}

/** 能力的中文名与一句话说明，界面与提示共用同一份文案。 */
export const AUTOMATION_LABEL: Record<AutomationCapability, { name: string; what: string }> = {
  observe: { name: '值守观察', what: '监听文件变动，命中规则只记录候选；不派任务、不花钱' },
  dispatch: { name: '值守自动派发', what: '命中且语义评估通过时真的开任务；每条规则有冷却、整体有每分钟上限' },
  precheck: { name: '静默预检', what: '把一条 bug 报告交给几名代表并行复现；确认可复现才上报' },
};

export type AutomationDecision = { allowed: boolean; reason: string };

/**
 * 某个自动化能力此刻能不能用。
 *
 * 两道独立条件：能力自己开着；若它会行动，审批档必须是代理。
 * 不满足时 reason 必须说清是哪一条——"为什么没跑"和"跑了没效果"是两种完全不同的困惑。
 */
export function automationAllowed(policy: ApprovalPolicy, settings: AutomationSettings | undefined, capability: AutomationCapability): AutomationDecision {
  const enabled = settings?.[capability] === true;
  const name = AUTOMATION_LABEL[capability].name;
  if (!enabled) return { allowed: false, reason: `${name}未开启` };
  if (!isActingCapability(capability)) return { allowed: true, reason: `${name}已开启` };
  if (policy === 'proxy') return { allowed: true, reason: `${name}已开启（代理档）` };
  // 配置里开着但档位不允许：不是错误，是暂停。说清"已开启、被档位挡住"，
  // 否则人会以为设置丢了。
  return {
    allowed: false,
    reason: `${name}已开启，但当前是${policy === 'readonly' ? '只读' : '严格'}档，已暂停：${policy === 'readonly' ? '只读档没有行动能力' : '自动启动任务需要代理档'}`,
  };
}

/** 派发必须建立在观察之上：不监听就没有候选可派。 */
export function dispatchReady(settings: AutomationSettings | undefined): AutomationDecision {
  if (settings?.observe !== true) return { allowed: false, reason: '自动派发需要先开启值守观察：没有监听就没有候选可派' };
  return { allowed: true, reason: '' };
}

/**
 * 全部能力的状态快照，供界面一次性显示。
 * 顺序固定：先观察，再派发，最后预检——按危险程度递增。
 */
export function automationSnapshot(policy: ApprovalPolicy, settings: AutomationSettings | undefined) {
  const order: AutomationCapability[] = ['observe', 'dispatch', 'precheck'];
  return order.map(capability => {
    const base = automationAllowed(policy, settings, capability);
    // 派发额外检查前置：观察没开时，即使档位与开关都满足也不该跑。
    const dependency = capability === 'dispatch' && base.allowed ? dispatchReady(settings) : { allowed: true, reason: '' };
    return {
      capability,
      name: AUTOMATION_LABEL[capability].name,
      enabled: settings?.[capability] === true,
      acting: isActingCapability(capability),
      allowed: base.allowed && dependency.allowed,
      reason: base.allowed ? dependency.reason : base.reason,
    };
  });
}

/**
 * 切换一个能力。返回新的设置与"是否需要一个确认"。
 *
 * 关闭永远不需要确认——让刹车和油门一样难踩是最糟的设计。
 * 打开会行动的能力需要确认，且确认文案必须说清它会做什么。
 */
export function toggleAutomation(settings: AutomationSettings | undefined, capability: AutomationCapability, on: boolean): { settings: AutomationSettings; needsConfirm: boolean } {
  const next: AutomationSettings = { ...(settings ?? {}) };
  next[capability] = on;
  // 打开派发时顺带补上观察：否则它永远跑不起来，人会以为开关坏了。
  if (capability === 'dispatch' && on && next.observe !== true) next.observe = true;
  return { settings: next, needsConfirm: on && isActingCapability(capability) };
}

/** 打开一个会行动的能力时给人看的确切后果。不能只写"确定吗"。 */
export function confirmText(capability: AutomationCapability, context: { rules: number; agents: number; maxPerMinute: number }): string {
  if (capability === 'dispatch') {
    return [
      `将开启「${AUTOMATION_LABEL.dispatch.name}」。`,
      '',
      `· ${context.rules} 条规则会生效，命中后由程序层准入 + 语义评估双重判断`,
      `· 通过则自动开只读任务，最多每分钟 ${context.maxPerMinute} 个`,
      '· 每个任务有独立 token 预算，超限即停',
      '· 该任务不能派生僚属，也不能改任何文件',
      '',
      '这会真的消耗预算。建议先只开「值守观察」跑一段，确认规则不误伤再开这一项。',
    ].join('\n');
  }
  return [
    `将开启「${AUTOMATION_LABEL.precheck.name}」。`,
    '',
    `· 每条报告会并行开 ${context.agents} 个只读任务，各 4 分钟、12 万 token 上限`,
    '· 只有确认可复现才按铃叫你；其余结论只留记录',
    '· 同一份报告只预检一次',
    '',
    '这会真的消耗预算。它只在被调用时触发，不会自己跑。',
  ].join('\n');
}

/** 从旧版分散字段迁移到统一设置。旧字段在读到时即被清空，避免两份真相。 */
export function migrateAutomation(legacy: { watch?: { enabled?: boolean; roots?: string[]; rules?: WatchRule[] }; precheck?: { enabled?: boolean; agents?: string[] } }): AutomationSettings | undefined {
  const watch = legacy.watch;
  const precheck = legacy.precheck;
  if (!watch && !precheck) return undefined;
  const settings: AutomationSettings = {
    // 旧字段只有一个 enabled，无法区分观察与派发。
    // 迁移时一律降级为"仅观察"：这是唯一不会因为升级而开始花钱的选择。
    observe: watch?.enabled === true ? true : undefined,
    dispatch: false,
    precheck: precheck?.enabled === true ? true : undefined,
  };
  if (watch?.roots?.length) settings.roots = watch.roots;
  if (watch?.rules?.length) settings.rules = watch.rules;
  if (precheck?.agents?.length) settings.precheckAgents = precheck.agents;
  return settings;
}
