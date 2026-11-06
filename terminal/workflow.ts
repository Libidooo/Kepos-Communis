// 工作流：一套可复用的席位配方 + 计划模板。
//
// 为什么这两样要合成一个概念：它们单独存在时都不够用。
//   只有席位配方 —— 换个任务就得从头拆步骤。
//   只有计划模板 —— 换个领域就得手工改派给谁。
//   而真实用途是"这类任务通常由这几个人、按这个顺序做"。
//
// 为什么不引入 DSL：计划已经是 DAG（依赖 + 验收 + 门禁），
// 工作流只是给它加一层"保存与复用"。真正的表达能力来自 DAG，
// 再加一层分支/循环只会让"这一步为什么没跑"变得难答。
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptanceCheck } from './acceptance.ts';
import { freshAcceptance } from './acceptance.ts';
import type { MissionInput, MissionJobInput } from './scheduler.ts';
import type { AgentProfile } from './profiles.ts';
import { councilRole, roleName, rolePrompt, type CouncilLocale } from './council-roles/index.ts';

/** 席位配方的一项：这个名字 + 这个角色 + 这个模型。已有同 roleKey 的席位不会被重复创建。 */
export type WorkflowSeat = {
  /** 席位名。留空则用 roleKey 对应的默认名。 */
  name?: string;
  roleKey: string;
  /** 留空表示沿用当前主 Agent 的模型。 */
  model?: string;
  provider?: string;
  skills?: string[];
  readScope?: 'project' | 'machine';
};

/** 计划模板的一步。 */
export type WorkflowStep = {
  id: string;
  /**
   * 派给谁：优先按席位名匹配，其次按 roleKey 匹配现有代表。
   * 两者都没有时这一步无法实例化——工作流不该在没人可用时静默跳过。
   */
  seat?: string;
  roleKey?: string;
  /** 步骤任务描述。`{goal}` 会替换成本次目标。 */
  task: string;
  dependsOn?: string[];
  /** 本步骤所属的组。同组步骤共享组通道。 */
  groupId?: string;
  /** 验收条目（纯文本），实例化时全部从未通过开始。 */
  acceptance?: string[];
  seconds?: number;
  requiresHuman?: boolean;
};

export type Workflow = {
  id: string;
  name: string;
  description?: string;
  /** 席位配方。空数组表示"沿用当前编制"，只复用步骤模板。 */
  seats: WorkflowSeat[];
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
  source?: 'human' | 'premier';
};

/** 步骤数上限：工作流是给人读的，超过这个数就不再是"一套流程"而是脚本。 */
export const MAX_WORKFLOW_STEPS = 40;
/** 席位上限，与并发池一致。 */
export const MAX_WORKFLOW_SEATS = 48;
/** 单个步骤描述上限。 */
export const MAX_STEP_CHARS = 2000;

/**
 * 校验一份工作流。
 *
 * 全部问题一次报出，不是遇到第一个就返回——编排错误往往成片出现，
 * 逐条试错会让人反复往返。
 */
export function validateWorkflow(workflow: Workflow): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!workflow.id?.trim()) errors.push('缺少 id');
  if (!workflow.name?.trim()) errors.push('缺少名称');
  if (!Array.isArray(workflow.steps) || !workflow.steps.length) errors.push('至少需要一个步骤');
  if (workflow.steps.length > MAX_WORKFLOW_STEPS) errors.push(`步骤最多 ${MAX_WORKFLOW_STEPS} 个，当前 ${workflow.steps.length}`);
  if ((workflow.seats?.length ?? 0) > MAX_WORKFLOW_SEATS) errors.push(`席位最多 ${MAX_WORKFLOW_SEATS} 个`);
  const ids = new Set<string>();
  for (const step of workflow.steps ?? []) {
    const at = step.id?.trim();
    if (!at) { errors.push('存在没有 id 的步骤'); continue; }
    if (ids.has(at)) errors.push(`步骤 id 重复：${at}`);
    ids.add(at);
    if (!step.task?.trim()) errors.push(`步骤 ${at} 缺少任务描述`);
    if (String(step.task ?? '').length > MAX_STEP_CHARS) errors.push(`步骤 ${at} 描述过长`);
    if (!step.seat?.trim() && !step.roleKey?.trim()) errors.push(`步骤 ${at} 没有指定派给谁（seat 或 roleKey）`);
    if (step.roleKey && !councilRole(step.roleKey)) errors.push(`步骤 ${at} 的角色不存在：${step.roleKey}`);
  }
  // 依赖必须指向存在的步骤，且不能成环——成环的计划永远不会开始。
  for (const step of workflow.steps ?? []) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push(`步骤 ${step.id} 依赖了不存在的步骤：${dep}`);
      if (dep === step.id) errors.push(`步骤 ${step.id} 依赖了自己`);
    }
  }
  if (cycleIn(workflow.steps ?? [])) errors.push('步骤依赖成环');
  for (const seat of workflow.seats ?? []) {
    if (!seat.roleKey?.trim()) errors.push('席位缺少 roleKey');
    else if (!councilRole(seat.roleKey)) errors.push(`席位角色不存在：${seat.roleKey}`);
  }
  return { ok: !errors.length, errors };
}

/** 拓扑环检测。 */
function cycleIn(steps: readonly WorkflowStep[]): boolean {
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(steps.map(step => [step.id, step]));
  const walk = (id: string): boolean => {
    const mark = state.get(id);
    if (mark === 'visiting') return true;
    if (mark === 'done') return false;
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep) && walk(dep)) return true;
    }
    state.set(id, 'done');
    return false;
  };
  for (const step of steps) if (walk(step.id)) return true;
  return false;
}

/** 生成一个新 id。用 uuid 而非递增：工作流会被导出/导入，序号会撞。 */
export function newWorkflowId(): string {
  return 'wf_' + randomUUID().replaceAll('-', '').slice(0, 16);
}

/**
 * 从当前编制抽一份席位配方。
 *
 * 这是"把现有 48 席存成模板"的实现：只记录角色与模型这类**结构性**信息，
 * 不记录历史、记忆、任务。模板描述的是团队形状，不是它的过往。
 */
export function seatsFromAgents(agents: readonly AgentProfile[]): WorkflowSeat[] {
  return agents
    .filter(agent => agent.roleKey)
    .map(agent => ({
      name: agent.name,
      roleKey: agent.roleKey!,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.provider ? { provider: agent.provider } : {}),
      ...(agent.skills?.length ? { skills: [...agent.skills] } : {}),
      ...(agent.readScope ? { readScope: agent.readScope } : {}),
    }));
}

export type InstantiateResult =
  | { ok: true; seats: AgentProfile[]; mission: MissionInput; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * 把工作流实例化成"要补哪些席位" + "要提交什么计划"。
 *
 * 纯函数：不读写数据库、不启动任务。调用方拿着结果去 saveConfig 与 enqueue，
 * 这样实例化本身可以被测试，也不会在中途失败时留下半个编制。
 *
 * 席位处理的三条规则：
 *   1. 已有同 roleKey 的代表不重复创建——工作流是模板，不是"每次重建团队"。
 *   2. 已有同名代表也不创建，即使 roleKey 不同（人可能故意改过它的职责）。
 *   3. 缺模型时用传入的 defaultModel（通常是当前主 Agent 的模型）。
 */
export function instantiateWorkflow(
  workflow: Workflow,
  input: { goal: string; defaultModel: string; defaultProvider?: string; locale?: CouncilLocale; existingAgents: readonly AgentProfile[] },
): InstantiateResult {
  const check = validateWorkflow(workflow);
  if (!check.ok) return { ok: false, errors: check.errors };
  const goal = String(input.goal ?? '').trim();
  if (!goal) return { ok: false, errors: ['需要本次目标'] };

  const locale = input.locale ?? 'zh-CN';
  const warnings: string[] = [];
  const existing = [...input.existingAgents];
  const created: AgentProfile[] = [];

  // ── 席位：按 roleKey 去重补齐 ──────────────────────────────────────────
  for (const seat of workflow.seats ?? []) {
    const role = councilRole(seat.roleKey);
    if (!role) continue;                                  // validate 已经报过
    const name = seat.name?.trim() || roleName(role, locale);
    if (existing.some(agent => agent.roleKey === seat.roleKey)) continue;
    if (existing.some(agent => agent.name === name)) {
      warnings.push(`席位「${name}」已存在但不是该角色，未覆盖`);
      continue;
    }
    const profile: AgentProfile = {
      id: randomUUID(),
      name,
      roleKey: role.key,
      role: rolePrompt(role, locale),
      model: seat.model?.trim() || input.defaultModel,
      provider: seat.provider?.trim() || input.defaultProvider || '',
      ...(seat.skills?.length ? { skills: [...seat.skills] } : {}),
      ...(seat.readScope ? { readScope: seat.readScope } : {}),
    };
    existing.push(profile);
    created.push(profile);
  }

  // ── 步骤：解析派给谁 ────────────────────────────────────────────────────
  const jobs: MissionJobInput[] = [];
  for (const step of workflow.steps) {
    // 先按席位名找，再按 roleKey 找——名字是人的意图，roleKey 是兜底。
    const byName = step.seat?.trim() ? existing.find(agent => agent.name === step.seat!.trim()) : undefined;
    const byRole = !byName && step.roleKey ? existing.find(agent => agent.roleKey === step.roleKey) : undefined;
    const agent = byName ?? byRole;
    if (!agent) {
      return { ok: false, errors: [`步骤 ${step.id} 找不到可派的代表（seat=${step.seat ?? '—'} roleKey=${step.roleKey ?? '—'}）`] };
    }
    jobs.push({
      id: step.id,
      agent: { ...agent },
      task: subst(step.task, goal),
      ...(step.dependsOn?.length ? { dependsOn: [...step.dependsOn] } : {}),
      ...(step.groupId?.trim() ? { groupId: step.groupId.trim() } : {}),
      // 验收条目也要替换 {goal}：它们和 task 一样描述本次目标。
      // 留着模板原样会在复核时对着模板文本勾选，等于没有验收。
      acceptance: freshAcceptance((step.acceptance ?? []).map(item => subst(item, goal))),
      ...(step.seconds !== undefined ? { seconds: step.seconds } : {}),
      ...(step.requiresHuman !== undefined ? { requiresHuman: step.requiresHuman } : {}),
    });
  }

  const mission: MissionInput = {
    goal,
    cwd: '',
    parentSessionId: '',
    jobs,
  };
  return { ok: true, seats: created, mission, warnings };
}

/** `{goal}` 占位替换。只认这一个占位符——多几个就会变成没人记得住的模板语言。 */
export function subst(template: string, goal: string): string {
  return String(template ?? '').replaceAll('{goal}', goal);
}


/** 验收条目从纯文本转成结构。导出给调用方复用同一规则。 */
export function acceptanceOf(lines: readonly string[] | undefined): AcceptanceCheck[] {
  return freshAcceptance(lines ?? []);
}

/** 一句话摘要：工作流列表里显示用。 */
export function describeWorkflow(workflow: Workflow): string {
  const seats = workflow.seats?.length ?? 0;
  const groups = new Set((workflow.steps ?? []).map(step => step.groupId).filter(Boolean)).size;
  return `${workflow.steps.length} 步 · ${seats ? `${seats} 席` : '沿用现有编制'}${groups ? ` · ${groups} 个组` : ''}`;
}

// ── 文件形态 ──────────────────────────────────────────────────────────
// 工作流导出为 .kepos/workflows/<id>.md：frontmatter 给机器，正文是步骤清单。
// 与代表档案同一原则：数据库是权威，文件是视图——可读、可 diff、可复制到别的项目。

export const WORKFLOWS_DIR = 'workflows';

/** 安全的文件名：与代表档案同一条规则。 */
const safeFile = (value: string) => String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^[.-]+|[-.]+$/g, '') || 'workflow';

export function workflowsRoot(archiveRoot: string): string {
  return join(archiveRoot, WORKFLOWS_DIR);
}

/** 工作流 → Markdown。steps 按原顺序列出，依赖与组写在行内，便于一眼看出编排。 */
export function renderWorkflow(workflow: Workflow): string {
  const lines: string[] = ['---', `id: ${workflow.id}`, `name: ${workflow.name}`];
  if (workflow.description) lines.push(`description: ${workflow.description}`);
  lines.push(`steps: ${workflow.steps.length}`, `seats: ${workflow.seats.length}`, '---', '');
  lines.push(`# ${workflow.name}`, '');
  if (workflow.description) lines.push(workflow.description, '');
  if (workflow.seats.length) {
    lines.push('## 席位', '');
    for (const seat of workflow.seats) {
      const model = seat.model ? ` · ${seat.provider ? seat.provider + '/' : ''}${seat.model}` : '';
      lines.push(`- **${seat.name || seat.roleKey}** · ${seat.roleKey}${model}`);
    }
    lines.push('');
  }
  lines.push('## 步骤', '');
  for (const step of workflow.steps) {
    const deps = step.dependsOn?.length ? `（依赖 ${step.dependsOn.join(', ')}）` : '';
    const group = step.groupId ? ` [组 ${step.groupId}]` : '';
    const who = step.seat || step.roleKey || '—';
    lines.push(`### ${step.id} · ${who}${group}${deps}`, '', step.task, '');
    if (step.acceptance?.length) {
      lines.push('验收：', ...step.acceptance.map(item => `- ${item}`), '');
    }
  }
  return lines.join('\n');
}

export type WorkflowFileSync = { written: number; removed: number; skipped: string[] };

/** 导出全部工作流；内容未变不重写，已不存在的删掉。 */
export function syncWorkflows(archiveRoot: string, workflows: readonly Workflow[]): number {
  const dir = workflowsRoot(archiveRoot);
  try { mkdirSync(dir, { recursive: true }); } catch { return 0; }
  let written = 0;
  const keep = new Set<string>();
  for (const workflow of workflows) {
    const file = `${safeFile(workflow.id)}.md`;
    keep.add(file);
    const next = renderWorkflow(workflow);
    try {
      if (existsSync(join(dir, file)) && readFileSync(join(dir, file), 'utf8') === next) continue;
      writeFileSync(join(dir, file), next, 'utf8');
      written++;
    } catch { /* 单个失败不影响其余 */ }
  }
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.md') || keep.has(entry)) continue;
      try { unlinkSync(join(dir, entry)); } catch { /* 忽略 */ }
    }
  } catch { /* 目录读不到就跳过清理 */ }
  return written;
}
