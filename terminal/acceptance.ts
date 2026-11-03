// 计划步骤的验收条目：feature_list.json 思路的落地。
//
// 为什么把"验收标准"从任务正文里提出来单存：
//   正文里的验收标准是散文，复核时模型会顺着自己的话往下读，读到"已完成"就停。
//   单独存成 [{check, passes}] 后，复核必须逐条回答"这一条过了吗"——
//   未勾选的条目留在那里，不能靠一句"全部完成"糊过去。
//   这是 harness 层面的事实，不是提示词里的请求。

/** 一条验收标准。passes 在计划创建时必须是 false——先声明，后达成。 */
export type AcceptanceCheck = { check: string; passes: boolean };

export const MIN_ACCEPTANCE = 1;
export const MAX_ACCEPTANCE = 8;
/** 单条上限：超过就不是"可以验证的一条"，而是一段需求描述。 */
export const MAX_CHECK_CHARS = 300;

/**
 * 校验并规范化一组验收条目。
 *
 * 拒绝空条目、超量、超长；不接受创建时就 passes:true 的输入——
 * 那等于把"已完成"写进了计划，复核环节就失去意义。
 * 已存在于记录里的 passes 值不会被这个函数重置，那是 markPasses 的职责。
 */
export function normalizeAcceptance(input: unknown): AcceptanceCheck[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw Error('acceptance 必须是数组，每项形如 {check, passes}');
  if (input.length > MAX_ACCEPTANCE) throw Error(`验收条目最多 ${MAX_ACCEPTANCE} 条，收到 ${input.length} 条`);
  const seen = new Set<string>();
  const out: AcceptanceCheck[] = [];
  for (const raw of input) {
    // 允许直接给字符串：模型更容易写 ["测试通过", "无新增依赖"]，
    // 强制每项写成对象只会让它编造一个 passes 值。
    const check = String(typeof raw === 'string' ? raw : raw?.check ?? '').trim();
    if (!check) throw Error('验收条目不能为空');
    if (check.length > MAX_CHECK_CHARS) throw Error(`验收条目过长（${check.length} > ${MAX_CHECK_CHARS}）：${check.slice(0, 60)}…`);
    const key = check.toLowerCase();
    if (seen.has(key)) continue;                 // 重复条目只留一条，不报错
    seen.add(key);
    out.push({ check, passes: typeof raw === 'object' && raw?.passes === true });
  }
  return out;
}

/** 创建计划时的验收条目：一律从"未通过"开始。 */
export function freshAcceptance(input: unknown): AcceptanceCheck[] {
  return normalizeAcceptance(input).map(item => ({ check: item.check, passes: false }));
}

/** 是否所有条目都已勾选。没有条目时返回 null——"没写验收"不等于"验收通过"。 */
export function acceptanceState(checks: AcceptanceCheck[] | undefined): 'complete' | 'pending' | 'absent' {
  if (!checks?.length) return 'absent';
  return checks.every(item => item.passes) ? 'complete' : 'pending';
}

/** 未勾选的条目，供复核提示与 false-done 判定。 */
export function unmetChecks(checks: AcceptanceCheck[] | undefined): string[] {
  return (checks || []).filter(item => !item.passes).map(item => item.check);
}

/**
 * 按复核者的勾选结果更新条目。
 * 只接受明确列出的下标或原文——复核者说"都过了"不算，得逐条点名。
 * 返回新数组与本次新勾选的数量。
 */
export function markPasses(checks: AcceptanceCheck[], passed: unknown): { checks: AcceptanceCheck[]; marked: number } {
  const wanted = Array.isArray(passed) ? passed : [];
  if (!wanted.length) return { checks, marked: 0 };
  // 允许传原文（更稳）或 1 起的序号（模型数得清）。
  const targets = new Set<number>();
  for (const item of wanted) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    const byIndex = Number(text);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= checks.length) { targets.add(byIndex - 1); continue; }
    const at = checks.findIndex(check => check.check === text || check.check.includes(text) || text.includes(check.check));
    if (at >= 0) targets.add(at);
  }
  let marked = 0;
  const next = checks.map((item, index) => {
    if (!targets.has(index) || item.passes) return item;
    marked++;
    return { ...item, passes: true };
  });
  return { checks: next, marked };
}

/**
 * 计划完成但仍有未勾选条目 → premature_done。
 * 这不是错误状态，是一个可度量的事件：它记录"模型认为完成了，验收说没有"。
 */
export function isPrematureDone(checks: AcceptanceCheck[] | undefined, succeeded: boolean): boolean {
  if (!succeeded) return false;
  return unmetChecks(checks).length > 0;
}

/** 复核提示词：要求对照条目逐条回答，而不是笼统评价。 */
export function acceptanceReviewPrompt(goal: string, checks: AcceptanceCheck[], outputTail: string): string {
  return [
    '你是计划复核者。下面是步骤目标、验收条目与该步骤的产出末尾。',
    '',
    '## 目标',
    goal,
    '',
    '## 验收条目',
    ...checks.map((item, index) => `${index + 1}. [${item.passes ? '已勾选' : '未勾选'}] ${item.check}`),
    '',
    '## 产出末尾',
    outputTail,
    '',
    '## 你的工作',
    '逐条判断：产出是否**直接证明**这一条成立。',
    '只输出严格 JSON，不要解释：',
    '{"passed":[1,3],"unmet":["第 2 条：缺少测试输出"]}',
    '规则：',
    '- passed 用条目序号（1 起）。没有证据的条目不要列入。',
    '- 产出里"我已完成"之类的自述不是证据，要看到结果本身。',
    '- unmet 写清缺什么，供下一轮补做。',
  ].join('\n');
}

/**
 * 解析复核模型返回的 JSON。
 * 与记忆整理同一个原则：模型可能加围栏或说明文字，只认对象本身，坏输入返回空。
 */
export function parseReviewVerdict(raw: string): { passed: number[]; unmet: string[] } {
  const text = String(raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { passed: [], unmet: [] };
  let parsed: any;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return { passed: [], unmet: [] }; }
  const passed: number[] = Array.isArray(parsed?.passed)
    ? (parsed.passed as unknown[]).map(value => Number(value)).filter(value => Number.isInteger(value) && value >= 1)
    : [];
  const unmet = Array.isArray(parsed?.unmet) ? parsed.unmet.map((value: unknown) => String(value ?? '').trim()).filter(Boolean).slice(0, MAX_ACCEPTANCE) : [];
  return { passed: [...new Set(passed)], unmet };
}
