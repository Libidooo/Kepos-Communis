// 档案：把工作空间里产生的每一类数据放到固定位置。
//
// 为什么由 Kepos 自动归档，而不是让僚属自己写文件：
//   写文件需要权限，而权限要审批。若归档靠僚属写，每完成一次任务就要一道审批，
//   而且一旦被拒，产出就只留在上下文里随会话消失——这正是要避免的灾难。
//   归档是运行时的职责，不是授权对象：僚属只管产出，落盘由系统负责。
//
// 目录布局（全部在项目根下的 .kepos/，不干扰人类的文件浏览）：
//   .kepos/
//     roles/            角色定义 md（可读、可版本控制、可人工修订）
//     <taskId>/
//       brief.md        代表给僚属的任务说明
//       transcript.md   过程记录（工具调用与增量）
//       report.md       结构化结论（结论/证据/置信度/需要）
//       decision.md     代表对这份报告的采纳与裁决
//     index.json        归档索引：谁、何时、做了什么、结论摘要
//
// 分区原则：
//   过程（transcript）与结果（report）分开——过程是证据，结果是判断，混在一起
//   会让后来者误把过程当结论。代表决策单独一层，因为它可能不采纳僚属结论。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 归档根目录：项目根下的 .kepos，与用户主目录的数据存储分离。 */
export const ARCHIVE_DIR = '.kepos';

export type ArchivePaths = {
  root: string;
  roles: string;
  index: string;
  task: (taskId: string) => { dir: string; brief: string; transcript: string; report: string; decision: string };
};

export function archivePaths(cwd: string): ArchivePaths {
  const root = resolve(cwd, ARCHIVE_DIR);
  const task = (taskId: string) => {
    // taskId 来自系统生成的 UUID；仍做一次白名单过滤，防止路径穿越。
    const safe = String(taskId).replace(/[^A-Za-z0-9_-]/g, '');
    const dir = join(root, safe);
    return { dir, brief: join(dir, 'brief.md'), transcript: join(dir, 'transcript.md'), report: join(dir, 'report.md'), decision: join(dir, 'decision.md') };
  };
  return { root, roles: join(root, 'roles'), index: join(root, 'index.json'), task };
}

/** 确保归档目录存在。返回是否新建（用于提示"已开始归档"）。 */
export function ensureArchive(cwd: string): boolean {
  const paths = archivePaths(cwd);
  const fresh = !existsSync(paths.root);
  mkdirSync(paths.roles, { recursive: true });
  return fresh;
}

/** 写一份归档文档。用 mkdir 兜底，避免调用方必须先建目录。 */
export function writeArchiveDoc(file: string, content: string): void {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, content.endsWith('\n') ? content : content + '\n', 'utf8');
}

/** 归档索引条目：只留判断需要的信息，详细内容在各自文档里。 */
export type ArchiveEntry = {
  taskId: string;
  agent: string;
  parentWorkerId?: string;
  representative?: string;
  title: string;
  state: string;
  started: number;
  ended?: number;
  /** 结论摘要（报告的第一段），让索引本身可用。 */
  summary?: string;
  /** 代表是否采纳了僚属的结论。 */
  adopted?: boolean;
};

export function readArchiveIndex(cwd: string): ArchiveEntry[] {
  const file = archivePaths(cwd).index;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** 索引只保留最近 ARCHIVE_INDEX_LIMIT 条，避免无限增长。 */
export const ARCHIVE_INDEX_LIMIT = 500;

export function upsertArchiveEntry(cwd: string, entry: ArchiveEntry): void {
  const entries = readArchiveIndex(cwd).filter(item => item.taskId !== entry.taskId);
  entries.push(entry);
  const trimmed = entries.slice(-ARCHIVE_INDEX_LIMIT);
  writeArchiveDoc(archivePaths(cwd).index, JSON.stringify(trimmed, null, 2));
}

/** 从结构化产出里取一段可用作索引摘要的文字。 */
export function summarizeReport(report: string, max = 200): string {
  const text = String(report ?? '');
  const conclusion = text.match(/##\s*结论\s*\n+([\s\S]*?)(?=\n##\s|\s*$)/);
  const body = (conclusion?.[1] ?? text).trim().replace(/\s+/g, ' ');
  return body.length > max ? body.slice(0, max - 1) + '…' : body;
}

/** 角色定义写得可读、可人工修订：不是序列化的 JSON，而是带标题的 md。 */
export function renderRoleDoc(role: {
  key: string; zhName: string; enName: string; scope: string;
  method: string[]; deliverables: string[]; skillFocus: string; skillHints?: string[];
}, locale: 'zh-CN' | 'en' = 'zh-CN'): string {
  const zh = locale === 'zh-CN';
  return [
    `# ${zh ? role.zhName : role.enName} · ${role.key}`,
    '',
    `${role.enName} / ${role.zhName}`,
    '',
    `## ${zh ? '职责范围' : 'Scope'}`,
    role.scope,
    '',
    `## ${zh ? '工作方法' : 'Method'}`,
    ...role.method.map(item => `- ${item}`),
    '',
    `## ${zh ? '交付内容' : 'Deliverables'}`,
    ...role.deliverables.map((item, index) => `${index + 1}. ${item}`),
    '',
    `## ${zh ? 'Skill 使用原则' : 'Skill policy'}`,
    role.skillFocus,
    ...(role.skillHints?.length ? ['', `推荐 Skill：${role.skillHints.join(', ')}`] : []),
    '',
    '---',
    '此文件由 Kepos 生成，可人工修订；修改后请在配置界面重新保存该代表以更新职责提示词。',
    '',
  ].join('\n');
}

/** 列出已归档的任务 id，最近的在前（按修改时间）。 */
export function listArchivedTasks(cwd: string): string[] {
  const root = archivePaths(cwd).root;
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'roles')
      .map(entry => entry.name)
      .filter(name => existsSync(join(root, name, 'report.md')) || existsSync(join(root, name, 'transcript.md')));
  } catch { return []; }
}
