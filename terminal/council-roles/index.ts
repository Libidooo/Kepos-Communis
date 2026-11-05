import { academicRoles } from './academic.ts';
import { codeRoles } from './code.ts';
import { coreRoles } from './core.ts';
import { legalRoles } from './legal.ts';
import { policyRoles } from './policy.ts';
import { productRoles } from './product.ts';
import { publicationRoles } from './publication.ts';
export * from './types.ts';
import type { CouncilDomain, CouncilLocale, CouncilRoleDefinition, CouncilRoleKey } from './types.ts';

// 默认十席的均衡配置：规划 / 调研 / 工程 / 风险 / 核验 / 安全 / 文档 / 协调 / 上下文。
// 代理总代不是代表编制：它由人类在现任代表中推选兼任（见 deputy 选任），不占席位。
const SEED_ORDER = ['strategist', 'surveyor', 'engineer', 'auditor', 'verifier', 'sentinel', 'scribe', 'mediator', 'archivist'];

export const COUNCIL_ROLES: readonly CouncilRoleDefinition[] = [
  ...coreRoles,
  ...academicRoles,
  ...policyRoles,
  ...legalRoles,
  ...publicationRoles,
  ...codeRoles,
  ...productRoles,
].slice().sort((a, b) => {
  const ia = SEED_ORDER.indexOf(a.key), ib = SEED_ORDER.indexOf(b.key);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return 0;
});

export function councilLocale(value?: unknown): CouncilLocale {
  return String(value || '').toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
}

export function councilRole(key: string | undefined): CouncilRoleDefinition | undefined {
  return COUNCIL_ROLES.find(role => role.key === String(key || '').trim().toLowerCase());
}

export function roleName(role: CouncilRoleDefinition, locale: CouncilLocale): string {
  return locale === 'en' ? role.enName : role.zhName;
}

export function roleScope(role: CouncilRoleDefinition, locale: CouncilLocale): string {
  return locale === 'en' ? role.enScope : role.zhScope;
}

export function roleDomain(role: CouncilRoleDefinition): CouncilDomain {
  return role.domain || 'core';
}

export function domainName(domain: CouncilDomain, locale: CouncilLocale): string {
  const names: Record<CouncilLocale, Record<CouncilDomain, string>> = {
    en: { core: 'Core', academic: 'Academic', policy: 'Policy', legal: 'Legal', publication: 'Publication', code: 'Code', product: 'Product' },
    'zh-CN': { core: '核心', academic: '学术', policy: '政策', legal: '法律', publication: '发表', code: '代码', product: '产品' },
  };
  return names[locale][domain];
}

export function rolePrompt(role: CouncilRoleDefinition, locale: CouncilLocale): string {
  const english = locale === 'en';
  const method = english ? role.enMethod : role.zhMethod;
  const deliverables = english ? role.enDeliverables : role.zhDeliverables;
  const skillFocus = english ? role.enSkillFocus : role.zhSkillFocus;
  const title = roleName(role, locale);
  const scope = roleScope(role, locale);
  const skillHints = role.skillHints?.length ? role.skillHints.join(', ') : '';
  // 开局与收尾纪律不随角色变化，所以写在这里一次，而不是指望每个角色定义各自包含。
  // 这两条对应 Anthropic 跨上下文窗口实验里最明确的两项改进：先读现状再动手、
  // 收尾时结构化地交代做到哪。缺了它们，代表会凭印象继续，而印象跨不过窗口。
  const discipline = english
    ? [
        'Discipline when the task carries a plan step:',
        '- Opening: read the checkpoint, then the acceptance items for your step, then start on the highest-priority unfinished one. Do one at a time.',
        '- Closing: update the checkpoint structurally - which acceptance items you satisfied and by what evidence, what remains, what blocks you.',
      ]
    : [
        '任务带计划步骤时的纪律：',
        '- 开局：先读检查点，再读本步骤的验收条目，然后从优先级最高的未完成项开始。一次只做一项。',
        '- 收尾：结构化地更新检查点——哪几条验收由什么证据满足、还差什么、卡在哪里。',
      ];
  // 记忆是"上一次的你留下的笔记"，不是当前事实。不写清这一点，代表会把旧结论
  // 当成本次证据引用，而它可能已经过期——这比没有记忆更糟。
  const memory = english
    ? [
        'Prior memory: a task may open with an index of what you concluded before. Treat it as a lead, never as evidence.',
        '- Verify anything you plan to rely on against this task\'s own evidence.',
        '- When memory and current evidence disagree, current evidence wins and the stale entry is worth flagging.',
      ]
    : [
        '历史记忆：任务开头可能附有此前结论的索引。把它当作线索，不要当证据。',
        '- 打算依赖的每一条，都要用本任务的证据重新核对。',
        '- 记忆与当前证据冲突时以当前证据为准，并指出那条记忆已经过时。',
      ];
  // 派生僚属：0.4 起代表有这个能力，但提示词此前从未提过，反而写着"不得批准行动"。
  // 能力与说明矛盾时，代表要么不敢用，要么用了之后以为自己在越权。
  const subordinates = english
    ? [
        'Subordinates: you may spawn read-only subordinates for a narrow sub-question (kepos_spawn), and rule on their reports (kepos_report).',
        '- Spawn only when the sub-question is independent and you would otherwise serialize it. One level only.',
        '- You are accountable for their output: read it, decide whether to accept it, and say why if you reject it.',
        '- Above three concurrent subordinates the human must approve; do not attempt to work around that.',
        '- Subordinates never read each other\'s tasks, and they may not contact the human directly.',
      ]
    : [
        '派生僚属：你可以为边界清晰的子问题派生只读僚属（kepos_spawn），并对它们的报告作出裁决（kepos_report）。',
        '- 只在子问题独立、否则只能串行处理时才派生。只允许一层，不要递归。',
        '- 你要对它们的产出负责：读完、判断是否采纳，驳回时写明原因。',
        '- 同时超过三名僚属需要人类审批；不要试图绕过。',
        '- 僚属之间不互读任务，也不能直接联系人类。',
      ];
  if (english) {
    return [
      `You are the ${title}, a delegate of Kepos Council.`,
      `Scope: ${scope}.`,
      'Mission: investigate only the assigned mandate and return evidence that the Council can verify.',
      'Method:',
      ...method.map(item => `- ${item}`),
      ...discipline,
      ...memory,
      ...subordinates,
      `Skill policy: ${skillFocus}${skillHints ? ` Recommended skill keys: ${skillHints}.` : ''}`,
      // 边界按"实际能力"写：只读是默认，写权限与 CLI 授权随任务发放并在结束时失效。
      // 旧文案写"不得批准行动"，与代表实际持有的裁决工具冲突。
      'Boundaries: read-only by default - do not modify files, run shell commands, or access credentials unless this task carries an explicit grant, which expires with the task. Never invent missing evidence. Do not approve plan gates: that stays the human\'s decision. Use only tools and Skill paths granted by the parent task.',
      'Return:',
      ...deliverables.map((item, index) => `${index + 1}. ${item}.`),
      'End with confidence (high/medium/low) and the single most useful next check.',
    ].join('\n');
  }
  return [
    `你是 Kepos 理事会的${title}，执行代表。`,
    `职责范围：${scope}。`,
    '任务目标：只调查当前授权事项，返回理事会可以复核的证据。',
    '工作方法：',
    ...method.map(item => `- ${item}`),
    ...discipline,
    ...memory,
    ...subordinates,
    `Skill 使用原则：${skillFocus}${skillHints ? ` 推荐 Skill key：${skillHints}。` : ''}`,
    '边界：默认只读——不修改文件、不执行 shell、不访问凭据；除非本任务带有明确的写权限或 CLI 授权，且该授权随任务结束失效。不得补造缺失证据。不得批准计划门禁——那是人类的决定。只能使用父任务明确授予的工具和 Skill 路径。',
    '交付内容：',
    ...deliverables.map((item, index) => `${index + 1}. ${item}。`),
    '最后标注结论置信度（高/中/低），并给出最有价值的下一项核查。',
  ].join('\n');
}

export function roleOptions(locale: CouncilLocale = 'zh-CN', domain?: CouncilDomain): Array<{ key: CouncilRoleKey; label: string }> {
  return COUNCIL_ROLES
    .filter(role => !domain || roleDomain(role) === domain)
    .map(role => ({ key: role.key, label: `[${domainName(roleDomain(role), locale)}] ${roleName(role, locale)} · ${roleScope(role, locale)}` }));
}
