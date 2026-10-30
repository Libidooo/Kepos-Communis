import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type RelayApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export const RELAY_API_LABELS: Record<RelayApi, string> = {
  'openai-completions': 'openai-completions（OpenAI Chat Completions 兼容，多数中转）',
  'openai-responses': 'openai-responses（Responses 新格式，GPT-5/o 系列最新模型）',
  'anthropic-messages': 'anthropic-messages（Claude 中转）',
};

export interface RelayProvider { name: string; baseUrl: string; api: RelayApi; apiKey: string; authHeader?: boolean; models?: { id: string; name?: string }[]; headers?: Record<string, string> }

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'relay';
}
export function relayEnvName(name: string): string { return 'KEPOS_RELAY_' + slugify(name).toUpperCase(); }
export const RELAY_ID_PREFIX = 'relay_';
export function modelsJsonPath(agentDir: string): string { return join(agentDir, 'models.json'); }

function readDoc(agentDir: string): any {
  const file = modelsJsonPath(agentDir);
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error: any) { throw Error('models.json 无法解析（' + error.message + '），请先修复或备份：' + file); }
}

function writeDoc(agentDir: string, doc: any): void {
  const file = modelsJsonPath(agentDir);
  mkdirSync(dirname(file), { recursive: true });
  doc.$schema = doc.$schema || 'https://pi.dev/schemas/models.schema.json';
  const temporary = file + '.relay.tmp';
  writeFileSync(temporary, JSON.stringify(doc, null, 2));
  renameSync(temporary, file);
}

export function readRelays(agentDir: string): Record<string, RelayProvider> {
  const providers = readDoc(agentDir)?.providers || {};
  const relays: Record<string, RelayProvider> = {};
  for (const [id, provider] of Object.entries<any>(providers)) {
    if (!id.startsWith(RELAY_ID_PREFIX)) continue;
    relays[id] = provider as RelayProvider;
  }
  return relays;
}

export function upsertRelay(agentDir: string, id: string, provider: RelayProvider, modelIds?: string[]): void {
  if (!id.startsWith(RELAY_ID_PREFIX)) throw Error('中转商 id 必须以 ' + RELAY_ID_PREFIX + ' 开头');
  const doc = readDoc(agentDir);
  doc.providers = doc.providers || {};
  const entry: any = { name: provider.name, baseUrl: provider.baseUrl.replace(/\/+$/, ''), api: provider.api, apiKey: provider.apiKey, authHeader: true };
  if (provider.headers) entry.headers = provider.headers;
  if (modelIds?.length) entry.models = modelIds.map(mid => ({ id: mid, name: mid }));
  doc.providers[id] = entry;
  writeDoc(agentDir, doc);
}

export function removeRelay(agentDir: string, id: string): boolean {
  const doc = readDoc(agentDir);
  if (!doc.providers?.[id]) return false;
  delete doc.providers[id];
  writeDoc(agentDir, doc);
  return true;
}

/** Keys are stored as `$ENV_NAME` references; the secret itself never lands in models.json. */
export function resolveRelayKey(provider: RelayProvider, overrideKey?: string): string | undefined {
  if (overrideKey) return overrideKey;
  const reference = String(provider.apiKey || '');
  if (reference.startsWith('$') && reference.length > 1) return process.env[reference.slice(1)];
  return undefined;
}

export interface ProbeResult { ok: boolean; status?: number; latencyMs: number; api?: RelayApi; models?: string[]; error?: string }

// The Pi runtime may swap globalThis.fetch for a proxied dispatcher; loopback targets
// through tools like Clash often hang. On network errors retry with a raw direct request.
function directRequest(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https') ? httpsRequest : httpRequest;
    const request = send(url, { headers, timeout: timeoutMs }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode || 0, body }));
    });
    request.on('timeout', () => request.destroy(Error(`直连超时（${timeoutMs}ms）`)));
    request.on('error', reject);
    request.end();
  });
}

/** Probe an OpenAI/Anthropic-compatible relay: try Bearer /models then x-api-key /v1/models. */
export async function probeRelay(baseUrl: string, key: string | undefined, fetchImpl: typeof fetch = fetch, timeoutMs = 10000): Promise<ProbeResult> {
  const base = baseUrl.replace(/\/+$/, '');
  const started = Date.now();
  const openaiHeaders: Record<string, string> = {};
  const anthropicHeaders: Record<string, string> = { 'anthropic-version': '2023-06-01' };
  if (key) { openaiHeaders.authorization = 'Bearer ' + key; anthropicHeaders['x-api-key'] = key; }
  const attempts: { api: RelayApi; url: string; headers: Record<string, string> }[] = [
    { api: 'openai-completions', url: base + '/models', headers: openaiHeaders },
    { api: 'openai-completions', url: base + '/v1/models', headers: openaiHeaders },
    { api: 'anthropic-messages', url: base + '/v1/models', headers: anthropicHeaders },
  ];
  const seen = new Set<string>();
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  for (const candidate of attempts) {
    // Dedup by api+url: OpenAI and Anthropic conventions share /v1/models but differ in auth.
    const signature = candidate.api + '|' + candidate.url;
    if (seen.has(signature)) continue;
    seen.add(signature);
    let status = 0;
    let body = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(candidate.url, { headers: candidate.headers, signal: controller.signal });
        status = response.status;
        body = await response.text().catch(() => '');
      } finally {
        clearTimeout(timer);
      }
    } catch {
      try {
        const direct = await directRequest(candidate.url, candidate.headers, timeoutMs);
        status = direct.status;
        body = direct.body;
      } catch (directError: any) {
        lastError = directError?.message || String(directError);
        continue;
      }
    }
    lastStatus = status;
    if (status === 200) {
      let models: string[] = [];
      try {
        const parsed = JSON.parse(body);
        models = (parsed?.data || parsed?.models || []).map((model: any) => String(model.id || model.name)).filter(Boolean);
      } catch { /* listing is not JSON; reachability still holds */ }
      return { ok: true, status: 200, latencyMs: Date.now() - started, api: candidate.api, models };
    }
    if (status === 401 || status === 403) {
      return { ok: false, status, latencyMs: Date.now() - started, error: '端点可达但鉴权失败：key 缺失或无效' };
    }
    lastError = 'HTTP ' + status;
  }
  return { ok: false, status: lastStatus, latencyMs: Date.now() - started, error: lastError || '不可达' };
}

export interface CcSwitchProvider { name: string; baseUrl: string; tokenEnv: string }

/**
 * cc-switch (Claude Code Switch) keeps providers in ~/.cc-switch/config.json and
 * switches them by rewriting ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN env semantics.
 * Import keeps the token as an $ANTHROPIC_AUTH_TOKEN reference: Kepos follows whatever
 * cc-switch currently has active, and the token itself never lands in models.json.
 */
export function readCcSwitchProviders(homeDir: string): CcSwitchProvider[] {
  const file = join(homeDir, '.cc-switch', 'config.json');
  if (!existsSync(file)) return [];
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  const rows: any[] = parsed?.claude?.providers || parsed?.providers || [];
  const out: CcSwitchProvider[] = [];
  for (const row of rows) {
    const name = String(row?.name || '').trim();
    const env = row?.settingsConfig?.env || row?.env || {};
    const baseUrl = String(env.ANTHROPIC_BASE_URL || row?.baseUrl || '').trim();
    const hasToken = Boolean(env.ANTHROPIC_AUTH_TOKEN || row?.token || row?.apiKey);
    if (!name || !baseUrl || !hasToken) continue;
    out.push({ name, baseUrl, tokenEnv: 'ANTHROPIC_AUTH_TOKEN' });
  }
  return out;
}

export function importCcSwitchProvider(agentDir: string, provider: CcSwitchProvider): string {
  const id = RELAY_ID_PREFIX + 'ccswitch_' + slugify(provider.name);
  upsertRelay(agentDir, id, { name: provider.name, baseUrl: provider.baseUrl, api: 'anthropic-messages', apiKey: '$' + provider.tokenEnv });
  return id;
}

/**
 * Guided relay setup inside the workspace (/login → 中转商). Keys typed here are used
 * for the immediate probe only and are never persisted; models.json keeps $ENV refs.
 */
export async function relaySetupFlow(ctx: any, agentDir: string): Promise<void> {
  const ui = ctx.ui;
  while (true) {
    const choice = await ui.select('Kepos · 中转商 / 自定义端点', ['新增中转商', '从 cc-switch 导入', '管理已有中转商', '返回']);
    if (choice !== '新增中转商' && choice !== '从 cc-switch 导入' && choice !== '管理已有中转商') return;
    if (choice === '新增中转商') {
      const name = (await ui.input('中转商名称', '如 my-relay'))?.trim();
      if (!name) continue;
      const baseUrl = (await ui.input('API 地址', 'https://relay.example（OpenAI 兼容含 /v1；Claude 中转填根地址）'))?.trim();
      if (!baseUrl) continue;
      const apiPick = await ui.select('协议类型', Object.values(RELAY_API_LABELS));
      if (!apiPick) continue;
      const api = (Object.keys(RELAY_API_LABELS) as RelayApi[]).find(key => RELAY_API_LABELS[key] === apiPick) || 'openai-completions';
      const keyEnv = (await ui.input('Key 环境变量名（key 只存引用，不写入文件）', relayEnvName(name)))?.trim() || relayEnvName(name);
      const instantKey = await ui.input('立即测试？可粘贴 key（仅本次使用，绝不保存；留空则用环境变量）', '');
      const probe = await probeRelay(baseUrl, instantKey?.trim() || process.env[keyEnv]);
      const summary = probe.ok
        ? `连通成功 · ${probe.api} · ${probe.latencyMs}ms · 可用模型 ${probe.models?.length ?? 0} 个`
        : `连通失败：${probe.error}${probe.status ? '（HTTP ' + probe.status + '）' : ''}`;
      if (!await ui.confirm(probe.ok ? '连通成功' : '连通失败', summary + '\n仍按当前配置保存？')) continue;
      let enabled: string[] | undefined;
      if (probe.ok && probe.models?.length) {
        const wanted = await ui.input('要启用的模型 id（逗号分隔；留空=暂不启用，之后可用 kepos relay models）', probe.models.slice(0, 24).join(','));
        if (wanted?.trim()) enabled = wanted.split(/[,，]/).map(item => item.trim()).filter(Boolean).filter(id => probe.models!.includes(id));
      }
      upsertRelay(agentDir, RELAY_ID_PREFIX + slugify(name), { name, baseUrl, api, apiKey: '$' + keyEnv }, enabled);
      ui.notify(`已保存 ${name}。把 key 放入环境变量 ${keyEnv}，然后 /reload 或重启使模型列表生效。`, 'info');
      return;
    }
    if (choice === '从 cc-switch 导入') {
      const { homedir } = await import('node:os');
      const providers = readCcSwitchProviders(homedir());
      if (!providers.length) { ui.notify('未找到 cc-switch 配置（~/.cc-switch/config.json）或其中没有可用供应商', 'warning'); continue; }
      const pick = await ui.select('选择要导入的 cc-switch 供应商（key 引用 $ANTHROPIC_AUTH_TOKEN，跟随 cc-switch 当前激活项）', providers.map(provider => `${provider.name} · ${provider.baseUrl}`));
      if (!pick) continue;
      const provider = providers.find(item => `${item.name} · ${item.baseUrl}` === pick)!;
      const id = importCcSwitchProvider(agentDir, provider);
      ui.notify(`已导入 ${id}。key 跟随 cc-switch 当前激活项（$ANTHROPIC_AUTH_TOKEN）；/reload 生效。`, 'info');
      return;
    }
    // 管理已有中转商
    const relays = readRelays(agentDir);
    const ids = Object.keys(relays);
    if (!ids.length) { ui.notify('还没有已保存的中转商', 'info'); continue; }
    const pick = await ui.select('选择中转商（Enter 查看/删除）', ids.map(id => `${id} · ${relays[id].baseUrl}`));
    if (!pick) continue;
    const id = pick.split(' · ')[0];
    const action = await ui.select(id, ['测试连通（用当前环境变量 key）', '删除', '返回']);
    if (action === '删除') {
      if (await ui.confirm('删除 ' + id + '？', '只移除 models.json 中的条目；环境变量不动。')) { removeRelay(agentDir, id); ui.notify('已删除 ' + id + '；/reload 生效。'); }
    } else if (action === '测试连通（用当前环境变量 key）') {
      const probe = await probeRelay(relays[id].baseUrl, resolveRelayKey(relays[id]));
      ui.notify(probe.ok ? `连通成功 · ${probe.api} · ${probe.latencyMs}ms · 模型 ${probe.models?.length ?? 0} 个` : `连通失败：${probe.error}`, probe.ok ? 'info' : 'warning');
    }
  }
}
