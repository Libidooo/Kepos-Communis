// Structural task metadata only: keep this module independent of workers, the desk and graph rendering.
export type TaskStateLike = {
  state?: string;
  status?: string;
  started?: number;
  ended?: number;
  reviewDue?: boolean;
  stalled?: boolean;
};

export const TASK_ACTIVE_STATES: ReadonlySet<string> = new Set(['QUEUED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED']);
export const TASK_TERMINAL_STATES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'INTERRUPTED']);

const legacyStates: Record<string, string> = {
  '排队中': 'QUEUED',
  '启动中': 'STARTING',
  '运行中': 'RUNNING',
  '正在终止': 'CANCEL_REQUESTED',
  '等待人类审批': 'NEEDS_HUMAN',
  '待审批': 'NEEDS_HUMAN',
  '完成': 'SUCCEEDED',
  '已完成': 'SUCCEEDED',
  '失败': 'FAILED',
  '已取消': 'CANCELLED',
  '超时': 'TIMED_OUT',
  '已中断': 'INTERRUPTED',
};
const knownStates = new Set([...TASK_ACTIVE_STATES, ...TASK_TERMINAL_STATES, 'NEEDS_HUMAN', 'WAITING', 'PAUSED']);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalizedState = (value: unknown) => {
  const label = text(value);
  const state = label.toUpperCase();
  return knownStates.has(state) ? state : Object.hasOwn(legacyStates, label) ? legacyStates[label] : undefined;
};

// A recognized state is authoritative; Chinese status is a fallback for persisted legacy tasks.
export function taskState(task: TaskStateLike): string | undefined {
  return normalizedState(task.state) ?? normalizedState(task.status) ?? (text(task.state) || text(task.status) || undefined);
}
export const isTaskActive = (task: TaskStateLike): boolean => TASK_ACTIVE_STATES.has(taskState(task) || '');
export const isTaskTerminal = (task: TaskStateLike): boolean => TASK_TERMINAL_STATES.has(taskState(task) || '');
export const isTaskPending = (task: TaskStateLike): boolean => !isTaskTerminal(task) && (taskState(task) === 'NEEDS_HUMAN' || task.reviewDue === true);
export const isTaskCurrent = (task: TaskStateLike): boolean => isTaskActive(task) || isTaskPending(task);

const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function taskElapsedMs(task: TaskStateLike, now = Date.now()): number | undefined {
  if (!validTime(task.started)) return undefined;
  // Never substitute the wall clock for a missing terminal timestamp: old failures must not keep aging.
  const end = isTaskTerminal(task) ? task.ended : now;
  if (!validTime(end)) return undefined;
  return Math.max(0, end - task.started);
}

export function taskElapsedText(task: TaskStateLike, now = Date.now()): string {
  const elapsed = taskElapsedMs(task, now);
  return elapsed === undefined ? isTaskTerminal(task) ? '耗时未记录' : '—' : `${Math.round(elapsed / 1000)}s`;
}
