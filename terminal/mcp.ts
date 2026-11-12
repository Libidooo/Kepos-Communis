import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Server names the human configured in <agentDir>/mcp.json (plus the project's
 * .pi/mcp.json when present). These are the only servers a delegation may grant:
 * the main agent chooses among them, it cannot invent new ones.
 */
export function configuredMcpServers(agentDir: string, cwd?: string): string[] {
  const names = new Set<string>();
  for (const file of [join(agentDir, 'mcp.json'), ...(cwd ? [join(cwd, '.pi', 'mcp.json')] : [])]) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      for (const name of Object.keys(parsed?.mcpServers || {})) if (name.trim()) names.add(name.trim());
    } catch { /* a broken config grants nothing */ }
  }
  return [...names];
}

export type McpGrant = { servers: string[] } | { error: string };

export type McpAssessment = { approved: true; servers: string[]; reason: string } | { approved: false; servers: []; reason: string };

/**
 * Resolve a delegation's temporary MCP request against the human's configuration.
 * true grants every configured server; an array grants exactly the named ones;
 * readonly supervision grants nothing. The grant dies with the worker process.
 */
export function resolveMcpGrant(requested: true | false | string[] | undefined, configured: string[], policy: string): McpGrant {
  if (requested !== true && !Array.isArray(requested)) return { servers: [] };
  if (policy !== 'proxy') return { error: policy === 'readonly'
    ? '只读监督模式不开放 MCP 授权；请人类处理需要 MCP 的工作。本批任务未启动'
    : '严格审批模式不能由模型自行授予 MCP；请人类确认后在代表配置中预先授权，或切换到代理审批。本批任务未启动' };
  const wanted = requested === true ? configured : [...new Set(requested)];
  const unknown = requested === true ? [] : wanted.filter(server => !configured.includes(server));
  if (unknown.length) return { error: `这些 MCP 服务器未配置（mcp.json）：${unknown.join(', ')}。已配置：${configured.join(', ') || '无'}。请人类先用 pi mcp add 配置；本批任务未启动` };
  if (!wanted.length) return { error: '当前没有任何已配置的 MCP 服务器可授予；本批任务未启动' };
  return { servers: wanted };
}

/** Validate a human-configured per-member default. Saving it is the human approval. */
export function resolveConfiguredMcpGrant(requested: string[] | undefined, configured: string[]): McpGrant {
  if (!requested?.length) return { servers: [] };
  const wanted = [...new Set(requested.map(name => String(name).trim()).filter(Boolean))];
  const unknown = wanted.filter(server => !configured.includes(server));
  if (unknown.length) return { error: `代表默认授权中包含未配置的 MCP 服务器：${unknown.join(', ')}。已配置：${configured.join(', ') || '无'}。请人类检查 mcp.json；本批任务未启动` };
  return { servers: wanted };
}

/** Check the model auditor's response against the exact requested allowlist. */
export function validateMcpAssessment(input: { approved?: unknown; servers?: unknown; reason?: unknown }, requested: readonly string[]): McpAssessment {
  const reason = String(input.reason ?? '').trim().slice(0, 500);
  if (input.approved !== true) return { approved: false, servers: [], reason: reason || '总理评估认为当前任务不需要申请的 MCP 权限' };
  const returned = Array.isArray(input.servers) ? input.servers.map(String) : [];
  const servers = [...new Set(returned.filter(server => requested.includes(server)))];
  if (!servers.length) return { approved: false, servers: [], reason: reason || '核验器没有批准任何申请中的服务器' };
  return { approved: true, servers, reason: reason || '该服务器与本任务直接相关，且仅授予申请的最小范围' };
}
