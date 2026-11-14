import { createHash } from 'node:crypto';
/**
 * 时长体系（人类裁定）：审批的职责是"别脱轨"，不是"别太久"。
 *   默认 15 分钟——多数调查够用；超过 1 小时的步骤进入审批（原 20 分钟）；
 *   单任务上限 4 小时（原 1 小时）——长任务靠复核与门禁保持在轨道上，
 *   而不是被一刀切掐断。三个值可被 config 覆盖（defaultTaskSeconds 等）。
 */
export const DEFAULT_TASK_SECONDS = 900;
export const SUPERVISION_INTERVAL_SECONDS = 300;
export const HUMAN_APPROVAL_THRESHOLD_SECONDS = 3600;
export const MAX_CONCURRENT_CHILDREN = 48;
/** 连续几个复核周期没有任何进展才判定空转并唤醒主 Agent（3 × 5 分钟 = 15 分钟）。 */
export const STALL_REVIEW_CYCLES = 3;
export const MAX_TASK_SECONDS = 14400;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'kepos_attach', 'kepos_find_file', 'kepos_web_search', 'kepos_web_open', 'kepos_market_quote', 'kepos_research_status'] as const;
export const WEB_RESEARCH_TOOLS = ['kepos_web_search', 'kepos_web_open'] as const;
export const MARKET_RESEARCH_TOOLS = ['kepos_market_quote'] as const;
/** Representatives may see edit/write, but worker-sandbox blocks both until the host grants a scoped task capability. */
export const REPRESENTATIVE_WRITE_TOOLS = ['edit', 'write'] as const;
export function needsMarketResearch(text: string): boolean {
    return /(?:\b(?:stock|stocks|ticker|share price|quote|equity|market price)\b|股票|股价|行情|证券|英特尔|英伟达|苹果公司|特斯拉|\b(?:intc|nvda|aapl|tsla)\b)/i.test(String(text || ''));
}
export function needsLiveResearch(text: string): boolean {
    return /(?:\b(?:today|now|current(?:ly)?|latest|recent|live|real[ -]?time|as of|this (?:week|month|year)|price|quote|stock|market data|exchange rate|weather|breaking news|what time is it|current date)\b|今天|今日|现在|目前|当前|最新|近期|实时|行情|股价|股票|汇率|天气|新闻|现行|本周|本月|今年|几点)/i.test(String(text || ''));
}
/** High-recall routing for ordinary factual questions that need outside evidence. */
export function needsExternalResearch(text: string): boolean {
    const value = String(text || '').trim();
    if (!value) return false;
    // Repository claims should be grounded in local tools, not sent to a public search engine.
    if (/(?:kepos|本地|我们的(?:项目|工程|仓库|代码)|这个(?:项目|工程|仓库|代码)|本项目|本工程|本仓库|当前(?:代码|仓库|项目|总理|代表)|项目里的|仓库里的|代码中的|源码|文件|函数|报错|堆栈|补丁|commit|repository|codebase|source code|stack trace|attached file)/i.test(value)) return false;
    if (needsLiveResearch(value)) return true;
    return /[?？]/.test(value) || /\b(?:what|why|how|who|where|when|which|explain|describe|compare|difference|background|definition|history)\b/i.test(value) ||
        /(?:是什么|为什么|如何|怎么(?:做|用|回事|样)?|谁(?:是|在|负责)?|哪里|何时|哪个|哪些|多少|是否|有没有|请(?:介绍|解释|说明|比较|分析)|介绍一下|解释一下|说明一下|区别|差异|背景|历史|原理|原因|影响|现状|定义|数据来源)/i.test(value);
}
const LEGACY_DEFAULT_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'kepos_attach'];
const PREVIOUS_DEFAULT_READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls', 'kepos_attach', 'kepos_web_search', 'kepos_web_open'];
const EARLIER_RESEARCH_DEFAULT_TOOLS = ['read', 'grep', 'find', 'ls', 'kepos_attach', 'kepos_find_file', 'kepos_web_search', 'kepos_web_open'];
/** Upgrade an old full-read-only profile while preserving intentionally narrow profiles. */
export function currentReadOnlyTools(tools?: readonly string[]): string[] {
    if (!tools) return [...READ_ONLY_TOOLS];
    const unique = [...new Set(tools)];
    const defaultSets = [LEGACY_DEFAULT_READ_ONLY_TOOLS, PREVIOUS_DEFAULT_READ_ONLY_TOOLS, EARLIER_RESEARCH_DEFAULT_TOOLS, READ_ONLY_TOOLS]
        .map(items => new Set(items));
    // Keep the declared tool order in profile files. Sorting here made an imported
    // profile change on its second render, even though no setting had changed.
    const isKnownDefault = defaultSets.some(previous => unique.length === previous.size && unique.every(tool => previous.has(tool)));
    if (isKnownDefault) return [...READ_ONLY_TOOLS];
    return unique;
}
/**
 * 代表可用的工具集：只读之外，加上派生僚属与读写归档的能力。
 * 代表对自己的僚属全权负责，因此必须能分派；但它仍然不能直接改代码——
 * 写权限要单独申请（见 grant.ts），不由派生能力附带。
 */
export const REPRESENTATIVE_TOOLS = [...READ_ONLY_TOOLS, 'kepos_spawn', 'kepos_report', 'kepos_cli', 'kepos_request_write', 'kepos_request_check'] as const;
/** 一个代表最多同时带几个僚属。远小于总理的 48，避免层级爆炸。 */
// 实际执行在 subordinates.ts：那里同时管硬上限与"超过三人需人类审批"的门槛。
// 这里保留导出是为了兼容既有引用，值的来源只有一处。
export { MAX_SUBORDINATES_PER_REPRESENTATIVE } from './subordinates.ts';
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
