// 归档可见性：谁能读谁的数据。
//
// 规则（人类裁定）：
//   代表 → 可读**自己僚属**的归档；不可读总理的思考路径、偏好、决策过程；
//          可读决策结果——但决策结果就是任务状态，不是一份独立文档，
//          所以"读决策结果"等价于查询任务状态，不涉及读总理的私有记录。
//   僚属 → 只读自己被分派任务的素材，读不到任何人的归档（已有沙箱 deny）。
//   总理 → 全部可读。
//
// 为什么必须挡住"思考路径、偏好、决策过程"：
//   代表若能看到总理的推理与倾向，会朝那个方向输出——谄媚上级，结论失去独立性。
//   这与小组内"共享证据、隔离结论"是同一条原则，只是换了一层。
import { resolve, sep } from 'node:path';
import { ARCHIVE_DIR } from './archive.ts';

export type ViewerRole = 'human' | 'premier' | 'representative' | 'subordinate';

export type Viewer = {
  role: ViewerRole;
  /** 代表自己的任务 id，用于判断"这是我僚属的归档"。 */
  taskId?: string;
};

export type ArchiveTarget = {
  /** 归档所属任务 id。 */
  taskId: string;
  /** 该任务的直属代表任务 id（没有则为总理直接派发的任务）。 */
  parentWorkerId?: string;
};

export type ArchiveAccess = { allowed: true } | { allowed: false; reason: string };

/**
 * 判断某个归档目录能否被读取。
 * 只做目录级判断；文档级（report vs decision）由 readArchiveDoc 再拦一次。
 */
export function canReadArchive(viewer: Viewer, target: ArchiveTarget): ArchiveAccess {
  if (viewer.role === 'human' || viewer.role === 'premier') return { allowed: true };
  if (viewer.role === 'subordinate') {
    return { allowed: false, reason: '僚属不能读取归档：只处理被分派的任务素材' };
  }
  // 代表：只能读自己僚属的归档。
  if (!viewer.taskId) return { allowed: false, reason: '未标识代表任务：无法判定归属' };
  if (target.parentWorkerId === viewer.taskId) return { allowed: true };
  if (target.taskId === viewer.taskId) return { allowed: true };
  return {
    allowed: false,
    reason: target.parentWorkerId
      ? '该归档属于其他代表的僚属：代表之间不能互读'
      : '该归档由总理直接派发：代表只能读自己僚属的归档',
  };
}

/**
 * 文档级可见性。
 * 即使目录可读，也不是每份文档都能看——总理的决策过程与偏好不在归档里，
 * 但 decision.md 是**代表自己**写的裁决，不是总理的，因此对下属代表可见。
 */
export type ArchiveDoc = 'brief' | 'transcript' | 'report' | 'decision';

export function canReadDoc(viewer: Viewer, doc: ArchiveDoc): ArchiveAccess {
  if (viewer.role === 'human' || viewer.role === 'premier') return { allowed: true };
  if (viewer.role === 'subordinate') return { allowed: false, reason: '僚属不能读取归档' };
  // 代表读自己僚属的全部文档，包括代表自己写下的裁决。
  void doc;
  return { allowed: true };
}

/** 路径归属：从归档路径反推 taskId，避免调用方伪造。 */
export function archiveTaskIdOf(cwd: string, filePath: string): string | null {
  const root = resolve(cwd, ARCHIVE_DIR);
  const target = resolve(filePath);
  if (target !== root && !target.startsWith(root + sep)) return null;
  const rest = target.slice(root.length + sep.length).split(sep);
  return rest[0] && rest[0] !== 'roles' && rest[0] !== 'index.json' ? rest[0] : null;
}

/**
 * 总理的私有记录（思考路径、偏好、决策过程）永远不写进项目归档。
 * 这个函数是唯一入口，返回空串表示"没有可披露的内容"——
 * 宁可代表什么也读不到，也不能给出半份推理让他去揣摩上级意图。
 */
export function premierPrivateArchive(): null {
  return null;
}
