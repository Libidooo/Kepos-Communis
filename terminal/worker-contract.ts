import { createHash } from 'node:crypto';
export const DEFAULT_TASK_SECONDS = 300;
export const SUPERVISION_INTERVAL_SECONDS = 300;
export const HUMAN_APPROVAL_THRESHOLD_SECONDS = 1200;
export const MAX_CONCURRENT_CHILDREN = 48;
/** 连续几个复核周期没有任何进展才判定空转并唤醒主 Agent（3 × 5 分钟 = 15 分钟）。 */
export const STALL_REVIEW_CYCLES = 3;
export const MAX_TASK_SECONDS = 3600;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'kepos_attach'] as const;
/**
 * 代表可用的工具集：只读之外，加上派生僚属与读写归档的能力。
 * 代表对自己的僚属全权负责，因此必须能分派；但它仍然不能直接改代码——
 * 写权限要单独申请（见 grant.ts），不由派生能力附带。
 */
export const REPRESENTATIVE_TOOLS = [...READ_ONLY_TOOLS, 'kepos_spawn', 'kepos_report'] as const;
/** 一个代表最多同时带几个僚属。远小于总理的 48，避免层级爆炸。 */
export const MAX_SUBORDINATES_PER_REPRESENTATIVE = 6;
/** 僚属时限不得超过其直属代表剩余时间的一半。 */
export const SUBORDINATE_BUDGET_RATIO = 0.5;
export type WorkerState = 'QUEUED' | 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'TIMED_OUT';
export type WorkerHandle = {
    version: 1;
    workerId: string;
    parentSessionId: string;
    capability: string;
    delegationDepth?: number;
    parentWorkerId?: string;
};
export type AgentProfileSnapshot = {
    name: string;
    role: string;
    roleKey?: string;
    model: string;
    provider: string;
    tools: string[];
    skills: string[];
    mcp: boolean;
    revision: string;
};
// v2 adds roleKey: stored revisions carry it, so two profiles differing only by roleKey must not share a hash.
export const profileRevision = (profile: Omit<AgentProfileSnapshot, 'revision'>) => createHash('sha256').update(JSON.stringify({
    v: 2, name: profile.name, role: profile.role, roleKey: profile.roleKey || null, model: profile.model, provider: profile.provider,
    tools: [...new Set(profile.tools)].sort(), skills: [...new Set(profile.skills)].sort(), mcp: profile.mcp,
})).digest('hex');
