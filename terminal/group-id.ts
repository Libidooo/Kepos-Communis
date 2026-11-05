// 组标识的校验与规范化。
//
// 为什么单独一个模块：groupId 会同时出现在三个地方——
// 任务记录（Task.groupId）、磁盘目录（.kepos/groups/<id>）、
// 沙箱放行名单（allowWithinDeny）。三处必须得到同一个字符串，
// 否则会出现"写了却读不到"或"放行了别人的组"。
//
// 规则刻意窄：只允许 [A-Za-z0-9_-]，长度 1-64。
// 组名是给人看的标签，不是自由文本；要表达语义请写进消息正文或任务描述。
export const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type GroupIdError = { ok: false; reason: string };
export type GroupIdOk = { ok: true; groupId: string };

/**
 * 校验并规范化一个组标识。
 *
 * 空值视为"不进组"，由调用方决定是否合法（分派时可选，计划步骤可选）。
 * 空白串会被 trim 后当作空值——而不是变成一个空目录名。
 */
export function normalizeGroupId(raw: unknown): GroupIdOk | GroupIdError {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, reason: '组标识为空' };
  if (!GROUP_ID_PATTERN.test(value)) {
    return { ok: false, reason: `组标识只能用字母、数字、下划线和连字符（1-64 位）：${value.slice(0, 40)}` };
  }
  return { ok: true, groupId: value };
}

/** 可选组的解析：缺省或空串返回 undefined，非法值抛错（不静默丢弃）。 */
export function optionalGroupId(raw: unknown): string | undefined {
  const value = String(raw ?? '').trim();
  if (!value) return undefined;
  const result = normalizeGroupId(value);
  if (result.ok === true) return result.groupId;
  // 不静默丢弃：一个写错的组名会让人以为"组没生效"而查很久。
  throw Error(result.reason);
}
