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

/**
 * Resolve a delegation's temporary MCP request against the human's configuration.
 * true grants every configured server; an array grants exactly the named ones;
 * readonly supervision grants nothing. The grant dies with the worker process.
 */
export function resolveMcpGrant(requested: true | string[] | undefined, configured: string[], policy: string): McpGrant {
  if (requested !== true && !Array.isArray(requested)) return { servers: [] };
  if (policy === 'readonly') return { error: '只读监督模式不开放 MCP 授权；请人类处理需要 MCP 的工作。本批任务未启动' };
  const wanted = requested === true ? configured : [...new Set(requested)];
  const unknown = requested === true ? [] : wanted.filter(server => !configured.includes(server));
  if (unknown.length) return { error: `这些 MCP 服务器未配置（mcp.json）：${unknown.join(', ')}。已配置：${configured.join(', ') || '无'}。请人类先用 pi mcp add 配置；本批任务未启动` };
  if (!wanted.length) return { error: '当前没有任何已配置的 MCP 服务器可授予；本批任务未启动' };
  return { servers: wanted };
}
