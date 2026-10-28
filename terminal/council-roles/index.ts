import { academicRoles } from './academic.ts';
import { codeRoles } from './code.ts';
import { coreRoles } from './core.ts';
import { policyRoles } from './policy.ts';
import { productRoles } from './product.ts';
import { publicationRoles } from './publication.ts';
export * from './types.ts';
import type { CouncilDomain, CouncilLocale, CouncilRoleDefinition, CouncilRoleKey } from './types.ts';

export const COUNCIL_ROLES: readonly CouncilRoleDefinition[] = [
  ...coreRoles,
  ...academicRoles,
  ...policyRoles,
  ...publicationRoles,
  ...codeRoles,
  ...productRoles,
];

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
    en: { core: 'Core', academic: 'Academic', policy: 'Policy', publication: 'Publication', code: 'Code', product: 'Product' },
    'zh-CN': { core: '核心', academic: '学术', policy: '政策', publication: '发表', code: '代码', product: '产品' },
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
  if (english) {
    return [
      `You are the ${title}, a read-only delegate of Kepos Council.`,
      `Scope: ${scope}.`,
      'Mission: investigate only the assigned mandate and return evidence that the Council can verify.',
      'Method:',
      ...method.map(item => `- ${item}`),
      `Skill policy: ${skillFocus}${skillHints ? ` Recommended skill keys: ${skillHints}.` : ''}`,
      'Boundaries: do not modify files, run shell commands, access credentials, invent missing evidence, or approve actions. Use only tools and Skill paths explicitly granted by the parent task.',
      'Return:',
      ...deliverables.map((item, index) => `${index + 1}. ${item}.`),
      'End with confidence (high/medium/low) and the single most useful next check.',
    ].join('\n');
  }
  return [
    `你是 Kepos 理事会的${title}，只读执行代表。`,
    `职责范围：${scope}。`,
    '任务目标：只调查当前授权事项，返回理事会可以复核的证据。',
    '工作方法：',
    ...method.map(item => `- ${item}`),
    `Skill 使用原则：${skillFocus}${skillHints ? ` 推荐 Skill key：${skillHints}。` : ''}`,
    '边界：不得修改文件、执行 shell、访问凭据、补造缺失证据或批准行动；只能使用父任务明确授予的工具和 Skill 路径。',
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
