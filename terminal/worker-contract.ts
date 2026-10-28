import { createHash } from 'node:crypto';
export const DEFAULT_TASK_SECONDS = 300;
export const SUPERVISION_INTERVAL_SECONDS = 300;
export const HUMAN_APPROVAL_THRESHOLD_SECONDS = 1200;
export const MAX_CONCURRENT_CHILDREN = 48;
export const MAX_TASK_SECONDS = 3600;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
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
export const profileRevision = (profile: Omit<AgentProfileSnapshot, 'revision'>) => createHash('sha256').update(JSON.stringify({
    name: profile.name, role: profile.role, model: profile.model, provider: profile.provider,
    tools: [...new Set(profile.tools)].sort(), skills: [...new Set(profile.skills)].sort(), mcp: profile.mcp,
})).digest('hex');
