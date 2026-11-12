// 代表档案的文件形态：Markdown + frontmatter。
//
// 为什么要文件化：`.claude/agents/*.md` 与 `AGENTS.md` 已是事实标准，
// 人可以直接读、直接改、diff 里看得见。JSON 里一坨 role 字符串做不到这些。
//
// 但**源仍然是 SQLite 的 workspace 记录**，md 是导出视图，不是权威。
// 理由很实在：saveConfig 有一套并发合并逻辑（多会话同时改配置不互相覆盖），
// 那套逻辑建立在"配置是一次原子读写"上。把权威搬进一堆文件，
// 就等于要重写合并逻辑并处理"文件被手改到一半"的状态——风险远大于收益。
//
// 所以分工是：
//   运行时 → saveConfig 写 SQLite → 同步导出 md（失败不影响保存）
//   人改 md → 显式 import（人主动触发，冲突可见）
// 这样文件是可读可改的接口，但不会在无人察觉时改变运行时行为。
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentReadOnlyTools, READ_ONLY_TOOLS } from './worker-contract.ts';
import type { AgentProfile } from './profiles.ts';

/** 档案目录名：放在项目归档区下，与工作区的 .kepos 其它内容同一处。 */
export const PROFILES_DIR = 'profiles';
/** 工作区说明文件名：主流 harness 都读它。 */
export const AGENTS_FILE = 'AGENTS.md';

/** 文件名只允许安全字符：它同时是 id 的显示形式。
 *  前导点必须去掉——`.` 与 `..` 是目录跳转，不是文件名。 */
const safeName = (value: string) => {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+|[-.]+$/g, '');
  return cleaned || 'agent';
};

/** 取 role 首句作为 description：frontmatter 需要一行摘要，正文才是完整职责。 */
export function summarizeRole(role: string, max = 120): string {
  const text = String(role ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  // 优先取第一个句子；没有标点就截断。
  const sentence = /^(.+?[。．.！!？?])/.exec(text)?.[1] ?? text;
  return sentence.length > max ? sentence.slice(0, max - 1) + '…' : sentence;
}

/** 一个列表值在 frontmatter 里怎么表示：短列表内联，长列表或多行用块状。 */
function formatList(values: readonly string[]): string {
  const items = values.map(value => String(value));
  if (!items.length) return '[]';
  const inline = `[${items.join(', ')}]`;
  // 内联超过 100 字符或含逗号时读起来很糟，改用块状列表。
  if (inline.length <= 100 && items.every(item => !item.includes(','))) return inline;
  return '';
}

/** AgentProfile → SKILL.md 风格的档案文本。 */
export function renderProfile(profile: AgentProfile): string {
  const description = summarizeRole(profile.role);
  const lines: string[] = ['---'];
  lines.push(`id: ${profile.id}`);
  lines.push(`name: ${profile.name}`);
  if (description) lines.push(`description: ${description}`);
  if (profile.roleKey) lines.push(`roleKey: ${profile.roleKey}`);
  lines.push(`model: ${profile.model}`);
  lines.push(`provider: ${profile.provider || ''}`);
  const tools = profile.tools ?? READ_ONLY_TOOLS;
  lines.push(`tools: ${formatList(tools)}` || 'tools:');
  if (!formatList(tools)) for (const tool of tools) lines.push(`  - ${tool}`);
  const skills = profile.skills ?? [];
  if (skills.length) {
    const inline = formatList(skills);
    if (inline) lines.push(`skills: ${inline}`);
    else { lines.push('skills:'); for (const skill of skills) lines.push(`  - ${skill}`); }
  } else lines.push('skills: []');
  if (profile.readScope) lines.push(`readScope: ${profile.readScope}`);
  if (profile.readAllow?.length) lines.push(`readAllow: ${formatList(profile.readAllow)}`);
  if (profile.mcpServers?.length) lines.push(`mcpServers: ${formatList(profile.mcpServers)}`);
  lines.push('---', '');
  // 正文就是职责提示词本身：不加"# 职责"标题，免得被当成提示词的一部分。
  lines.push(String(profile.role ?? '').trim(), '');
  return lines.join('\n');
}

/** 解析 frontmatter 的一行标量值；去掉可选的成对引号。 */
function scalar(raw: string): string {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

/** 内联列表 `[a, b]` 或单值。返回 undefined 表示"不是列表形态"。 */
function inlineList(raw: string): string[] | undefined {
  const value = raw.trim();
  if (value === '[]') return [];
  if (!value.startsWith('[') || !value.endsWith(']')) return undefined;
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(item => scalar(item)).filter(Boolean);
}

/**
 * 档案文本 → AgentProfile。
 *
 * 宽松解析：手写的 md 不会严格守格式，缺字段要能用默认值补上，
 * 真正不能缺的只有 name / model / role（没有它们这条档案没有意义）。
 * 缺 id 时返回 null 而不是编一个——文件被误删一行不该悄悄变成新代表。
 */
export function parseProfile(text: string): { profile?: AgentProfile; error?: string } {
  const raw = String(text ?? '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { error: '缺少 frontmatter（文件需以 --- 开头）' };
  const [, head, body] = match;
  const fields: Record<string, string | string[]> = {};
  let currentList: string | undefined;
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // 块状列表项：归属于上一个 `key:` 行。
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentList) {
      const existing = fields[currentList];
      const list = Array.isArray(existing) ? existing : [];
      list.push(scalar(item[1]));
      fields[currentList] = list;
      continue;
    }
    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, value] = pair;
    if (!value.trim()) { currentList = key; fields[key] = []; continue; }
    currentList = undefined;
    const list = inlineList(value);
    fields[key] = list ?? scalar(value);
  }
  const text_ = (key: string): string => {
    const value = fields[key];
    return Array.isArray(value) ? (value[0] ?? '') : String(value ?? '');
  };
  const list = (key: string): string[] => {
    const value = fields[key];
    if (Array.isArray(value)) return value;
    return value ? [String(value)] : [];
  };
  const name = text_('name').trim();
  const model = text_('model').trim();
  const role = body.trim();
  const id = text_('id').trim();
  // 校验顺序按"读者最先想知道的"排：是谁 → 用什么 → 做什么 → 能否对回既有代表。
  if (!name) return { error: '缺少 name' };
  if (!model) return { error: '缺少 model' };
  if (!role) return { error: '正文为空：正文就是职责提示词' };
  if (!id) return { error: '缺少 id（档案必须能对应回既有代表）' };
  const tools = currentReadOnlyTools(list('tools').filter(tool => (READ_ONLY_TOOLS as readonly string[]).includes(tool)));
  const profile: AgentProfile = {
    id, name, model, role,
    provider: text_('provider'),
    ...(text_('roleKey') ? { roleKey: text_('roleKey') } : {}),
    tools: tools.length ? tools : [...READ_ONLY_TOOLS],
    ...(list('skills').length ? { skills: list('skills') } : {}),
    ...(text_('readScope') === 'machine' ? { readScope: 'machine' as const } : text_('readScope') === 'project' ? { readScope: 'project' as const } : {}),
    ...(list('readAllow').length ? { readAllow: list('readAllow') } : {}),
    ...(list('mcpServers').length ? { mcpServers: list('mcpServers') } : {}),
  };
  return { profile };
}

/** 档案文件名：用 id，稳定且不会因改名产生孤儿文件。 */
export function profileFileName(profile: AgentProfile): string {
  return `${safeName(profile.id)}.md`;
}

export function profilesRoot(archiveRoot: string): string {
  return join(archiveRoot, PROFILES_DIR);
}

export type SyncResult = { written: number; removed: number; skipped: string[] };

/**
 * 把当前代表配置导出成 md，并清掉已不存在的代表的文件。
 *
 * 只在内容真的变化时才写：每次保存都重写全部文件会让 mtime 全变，
 * 人用 git 看 diff 时满屏噪声。
 */
export function syncProfiles(archiveRoot: string, profiles: readonly AgentProfile[]): SyncResult {
  const dir = profilesRoot(archiveRoot);
  const result: SyncResult = { written: 0, removed: 0, skipped: [] };
  try { mkdirSync(dir, { recursive: true }); }
  catch (error) {
    // 目录建不出来（只读挂载、路径被文件占用）：导出是尽力而为，不能因此让配置保存失败。
    result.skipped.push(`档案目录不可写：${String(error)}`);
    return result;
  }
  const keep = new Set<string>();
  for (const profile of profiles) {
    const file = join(dir, profileFileName(profile));
    keep.add(profileFileName(profile));
    let next: string;
    try { next = renderProfile(profile); }
    catch (error) { result.skipped.push(`${profile.name}: ${String(error)}`); continue; }
    try {
      if (existsSync(file) && readFileSync(file, 'utf8') === next) continue;
      writeFileSync(file, next, 'utf8');
      result.written++;
    } catch (error) { result.skipped.push(`${profile.name}: ${String(error)}`); }
  }
  // 代表被删除或改了 id：对应文件不再有主人，删掉避免误导。
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.md') || keep.has(entry)) continue;
      try { unlinkSync(join(dir, entry)); result.removed++; } catch { /* 删不掉不影响其他 */ }
    }
  } catch { /* 目录读不到就跳过清理 */ }
  return result;
}

export type ImportResult = { profiles: AgentProfile[]; errors: Array<{ file: string; error: string }> };

/**
 * 读回目录里的全部档案。给人改完之后导入用。
 *
 * 坏文件不静默丢弃：收集成 errors 一并返回，
 * 否则"我改了却没生效"会变成最难查的那类问题。
 */
export function readProfiles(archiveRoot: string): ImportResult {
  const dir = profilesRoot(archiveRoot);
  const result: ImportResult = { profiles: [], errors: [] };
  if (!existsSync(dir)) return result;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    let text: string;
    try { text = readFileSync(join(dir, entry), 'utf8'); }
    catch (error) { result.errors.push({ file: entry, error: String(error) }); continue; }
    const parsed = parseProfile(text);
    if (!parsed.profile) { result.errors.push({ file: entry, error: parsed.error || '无法解析' }); continue; }
    result.profiles.push(parsed.profile);
  }
  return result;
}

/**
 * 工作区说明：本工作区如何运转。
 *
 * 写给谁：写给下一个接手的人（或另一个 harness）。它必须能在没有 Kepos 的情况下
 * 说清这里发生过什么、东西放在哪。所以只描述事实与约定，不写运行命令——
 * 命令会变，约定不会。
 */
export function renderAgentsFile(input: {
  workspace: string;
  members: ReadonlyArray<{ name: string; roleKey?: string; model: string }>;
  archiveDir: string;
}): string {
  const members = input.members.length
    ? input.members.map(member => `- **${member.name}**${member.roleKey ? ` · ${member.roleKey}` : ''} · ${member.model}`).join('\n')
    : '- （尚未配置代表）';
  return [
    '# 本工作区如何运转',
    '',
    `工作目录：\`${input.workspace}\``,
    '',
    '这个工作区由 Kepos Communis 驱动：一位总理（主 Agent）把任务分派给多名默认只读的代表，',
    '代表可以派生僚属，并对僚属的结果负责。所有产出都留档，不依赖会话上下文存活。',
    '',
    '## 归档结构',
    '',
    `全部运行时产物在 \`${input.archiveDir}/\`，与源码分开，不干扰阅读项目本身：`,
    '',
    '- `profiles/*.md` —— 代表档案（frontmatter + 职责正文），可读可改',
    '- `<taskId>/brief.md` —— 任务说明与授权范围',
    '- `<taskId>/transcript.md` —— 执行过程（结论之前的全部内容）',
    '- `<taskId>/report.md` —— 结论（输出契约的 `## 结论` 一节起）',
    '- `<taskId>/decision.md` —— 直属代表对该报告的裁决',
    '- `index.json` —— 任务索引',
    '',
    '## 代表',
    '',
    members,
    '',
    '## 约定',
    '',
    '- 代表只读为默认；代理模式下由总理评估路径受限的 edit/write 申请，严格模式由人类确认，只读模式拒绝。授权仅限项目内批准路径，并在任务结束时失效。',
    '- 代表之间的证据不互读；同一工作小组内可读彼此证据，但结论各自独立。',
    '- 僚属不读其他任务的归档，也不读本目录之外的代表配置。',
    '- 记忆是双时态的：修正只标记失效，不删除，历史可回溯。',
    '- 任务完成不等于验收通过：计划步骤带 acceptance 条目，未勾满会记为 premature_done。',
    '',
  ].join('\n');
}

/** 写出 AGENTS.md；内容未变则不动文件。 */
export function syncAgentsFile(workspace: string, input: Omit<Parameters<typeof renderAgentsFile>[0], 'workspace'>): boolean {
  const file = join(workspace, AGENTS_FILE);
  const next = renderAgentsFile({ workspace, ...input });
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === next) return false;
    mkdirSync(workspace, { recursive: true });
    writeFileSync(file, next, 'utf8');
    return true;
  } catch { return false; }
}
