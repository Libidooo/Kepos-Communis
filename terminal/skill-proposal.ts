// 记忆 → 技能闭环：同一套做法重复到第三次，就该写成技能。
//
// 为什么需要这层：记忆是"这个代表记得"，技能是"任何代表都能照着做"。
// 前者随任务散落，后者是一次真正的固化。触发条件刻意定在 3 个**不同任务**
// 都走出了同一套步骤——同一个任务里重复三遍只是没写好，不是可复用过程。
//
// 为什么只提议、不自动装：一份 SKILL.md 会改变后续每一次分派的提示词。
// 未经审阅就写进 skills/ 等于让模型自己给自己扩权，所以提议目录独立、
// 采纳是人的动作（proxy 档可以自动采纳，但走的是已有的留痕通道）。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 触发阈值：同一代表、同一 slug，来自多少个不同任务。 */
export const SKILL_TRIGGER_WORKERS = 3;
/** 提议正文上限：技能是操作手册，不是论文。 */
export const MAX_SKILL_BODY_CHARS = 4000;
/** slug 只允许小写字母、数字与连字符——它会成为目录名。 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;

export const PROPOSED_DIR = 'skills-proposed';
export const INSTALLED_DIR = 'skills';

/** 从一段过程记忆里取 slug；没有就返回 undefined（无 slug 的过程不进闭环）。 */
export function slugOf(content: string): string | undefined {
  const match = /slug\s*[=:]\s*([A-Za-z0-9][A-Za-z0-9_-]*)/i.exec(String(content ?? ''));
  const slug = match?.[1]?.toLowerCase();
  // 形状不对就用规范化后的结果，而不是整条丢弃——`Bad_Slug!` 仍是一个可用的名字。
  return slug ? normalizeSlug(slug) : undefined;
}

/** 规范化为合法目录名：小写、下划线转连字符、去掉非法字符。 */
export function normalizeSlug(raw: string): string | undefined {
  const slug = String(raw ?? '').toLowerCase().replace(/_/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return SLUG_PATTERN.test(slug) ? slug : undefined;
}

/** 从一段过程记忆里取步骤正文（去掉 slug 标记本身）。 */
export function procedureOf(content: string): string {
  return String(content ?? '').replace(/slug\s*[=:]\s*[a-z0-9-]+/i, '').replace(/^[\s·,;:-]+/, '').trim();
}

/**
 * SKILL.md 的生成。frontmatter 用 agentskills 的 name/description 两字段，
 * 正文写步骤与边界——边界尤其重要，否则技能会被用到不适用的场景。
 *
 * 超长时截断**步骤**而不是整篇：一刀切尾巴会把"边界"切掉，
 * 而边界恰恰是防止误用的那一段。
 */
export function renderSkill(input: { slug: string; description: string; steps: string[]; agent?: string }): string {
  const description = String(input.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || input.slug;
  const head = [
    '---',
    `name: ${input.slug}`,
    `description: ${description}`,
    '---',
    '',
    `# ${input.slug}`,
    '',
    input.agent ? `由代表「${input.agent}」在多次任务中重复走出的流程，经审阅后固化。` : '经审阅后固化的流程。',
    '',
    '## 步骤',
    '',
  ].join('\n');
  const tail = [
    '',
    '## 边界',
    '',
    '- 只在任务与上述步骤同构时使用；情境不同就按当下证据判断，不要套用。',
    '- 步骤里的路径、命令与字段可能已过时：执行前先核对，冲突时以当前仓库为准。',
    '',
  ].join('\n');
  const budget = Math.max(200, MAX_SKILL_BODY_CHARS - head.length - tail.length);
  const steps: string[] = [];
  let used = 0;
  for (const raw of input.steps) {
    const step = String(raw ?? '').trim();
    if (!step) continue;
    const line = `${steps.length + 1}. ${step}`;
    // 预留省略行的位置，免得"已截断"本身被挤掉。
    if (used + line.length + 1 > budget - 20) break;
    steps.push(step);
    used += line.length + 1;
  }
  const omitted = input.steps.filter(step => String(step ?? '').trim()).length - steps.length;
  const body = steps.length
    ? steps.map((step, index) => `${index + 1}. ${step}`).join('\n') + (omitted > 0 ? `\n… 另有 ${omitted} 步未列出（原记录过长）` : '')
    : '（尚未记录具体步骤）';
  return `${head}${body}${tail}`;
}

export type SkillProposal = { slug: string; description: string; steps: string[]; agent: string; workers: number; path: string };

/** 提议目录（<agentDir>/skills-proposed）。 */
export function proposedRoot(agentDir: string): string {
  return join(agentDir, PROPOSED_DIR);
}

/**
 * 写一份提议。已存在则覆盖——同一 slug 的提议只有一个，
 * 后一次的证据（更多任务）应当更新它而不是留下多份互相矛盾的副本。
 */
export function writeProposal(agentDir: string, proposal: Omit<SkillProposal, 'path'>): SkillProposal {
  if (!SLUG_PATTERN.test(proposal.slug)) throw Error(`非法的技能 slug：${proposal.slug}`);
  const root = proposedRoot(agentDir);
  const dir = join(root, proposal.slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, renderSkill({ slug: proposal.slug, description: proposal.description, steps: proposal.steps, agent: proposal.agent }), 'utf8');
  return { ...proposal, path };
}

/** 列出全部待审阅提议。坏文件跳过——一份手写出错的 SKILL.md 不该让整个列表消失。 */
export function listProposals(agentDir: string): SkillProposal[] {
  const root = proposedRoot(agentDir);
  if (!existsSync(root)) return [];
  const out: SkillProposal[] = [];
  for (const slug of readdirSync(root)) {
    const path = join(root, slug, 'SKILL.md');
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8');
      const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() || slug;
      const steps = (text.split('## 步骤')[1] || '').split('## 边界')[0]
        .split('\n').map(line => /^\d+\.\s*(.+)$/.exec(line.trim())?.[1]).filter((line): line is string => !!line);
      out.push({ slug, description, steps, agent: '', workers: 0, path });
    } catch { continue; }
  }
  return out;
}

/**
 * 采纳：把提议移进 skills/ 供 Pi 的技能目录扫描。
 *
 * 用 rename 而不是复制：提议被移走后就不会在列表里重复出现，
 * "已采纳"的状态由目录本身表达，不需要另存一份状态表。
 */
export function adoptProposal(agentDir: string, slug: string): string {
  if (!SLUG_PATTERN.test(slug)) throw Error(`非法的技能 slug：${slug}`);
  const from = join(proposedRoot(agentDir), slug);
  if (!existsSync(join(from, 'SKILL.md'))) throw Error('没有找到该提议技能：' + slug);
  const to = join(agentDir, INSTALLED_DIR, slug);
  mkdirSync(join(agentDir, INSTALLED_DIR), { recursive: true });
  if (existsSync(to)) {
    // 同名技能已存在：不覆盖。人的安装优先于自动提议。
    throw Error(`技能 ${slug} 已经安装过；如需替换请先手动移除 ${to}`);
  }
  renameSync(from, to);
  return to;
}

/** 丢弃一份提议。 */
export function discardProposal(agentDir: string, slug: string): boolean {
  if (!SLUG_PATTERN.test(slug)) return false;
  const dir = join(proposedRoot(agentDir), slug);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 从该代表的过程记忆里挑出够格提技能的 slug。
 *
 * 判据是"不同任务数 ≥ 3"，由 RepresentativeMemory.procedureCount 提供；
 * 这里只做分组与去重，不重新数一遍——计数口径必须只有一处。
 */
export function candidatesFromProcedures(
  procedures: Array<{ content: string; workerId?: string }>,
  countFor: (slug: string) => number,
): Array<{ slug: string; steps: string[] }> {
  const bySlug = new Map<string, Set<string>>();
  for (const row of procedures) {
    const slug = slugOf(row.content);
    if (!slug) continue;
    const set = bySlug.get(slug) || new Set<string>();
    const text = procedureOf(row.content);
    if (text) set.add(text);
    bySlug.set(slug, set);
  }
  const out: Array<{ slug: string; steps: string[] }> = [];
  for (const [slug, steps] of bySlug) {
    if (countFor(slug) < SKILL_TRIGGER_WORKERS) continue;
    out.push({ slug, steps: [...steps] });
  }
  return out;
}
