import { relayEnvName, modelsJsonPath, probeRelay, readRelays, removeRelay, resolveRelayKey, slugify, RELAY_ID_PREFIX, upsertRelay, type RelayApi } from '../terminal/relay.ts';
import { preparePaths, type AppPaths } from './config.ts';

function printProbe(result: Awaited<ReturnType<typeof probeRelay>>): void {
  if (result.ok) {
    console.log(`连通成功 · ${result.api} · ${result.latencyMs}ms`);
    if (result.models?.length) console.log('可用模型 ' + result.models.length + ' 个（前 20）：\n' + result.models.slice(0, 20).map(id => '  ' + id).join('\n'));
    else console.log('端点可达，但未返回模型列表。');
  } else {
    console.error(`连通失败：${result.error}${result.status ? '（HTTP ' + result.status + '）' : ''} · ${result.latencyMs}ms`);
  }
}

const API_VALUES: RelayApi[] = ['openai-completions', 'anthropic-messages'];

function resolveRelayId(name: string): string { return name.startsWith(RELAY_ID_PREFIX) ? name : RELAY_ID_PREFIX + slugify(name); }
function requireRelay(paths: AppPaths, name?: string) {
  const relays = readRelays(paths.agentDir);
  const id = resolveRelayId(name || '');
  const relay = relays[id];
  if (!relay) throw Error('未知中转商：' + id + '（kepos relay list 查看）');
  return { id, relay };
}

export async function relayCommand(options: any, paths: AppPaths): Promise<void> {
  preparePaths(paths);
  const [action, name, positioned] = options.args;
  switch (action) {
    case 'add': {
      if (!name || !positioned) throw Error('Usage: kepos relay add <名称> <baseUrl> [--api openai-completions|anthropic-messages] [--key-env NAME] [--key <key 仅测试>]');
      const api = (options.api as RelayApi) || 'openai-completions';
      if (!API_VALUES.includes(api)) throw Error('--api must be openai-completions or anthropic-messages');
      const keyEnv = options.keyEnv || relayEnvName(name);
      const id = RELAY_ID_PREFIX + slugify(name);
      // The key itself never lands on disk: models.json keeps a $ENV reference.
      upsertRelay(paths.agentDir, id, { name, baseUrl: positioned, api, apiKey: '$' + keyEnv }, options.enable ? String(options.enable).split(',').map((item: string) => item.trim()).filter(Boolean) : undefined);
      console.log(`已保存 ${id} → ${modelsJsonPath(paths.agentDir)}`);
      console.log(`API key 不落盘：把 key 放入环境变量 ${keyEnv}（当前会话 export/set；永久写入你的 shell 配置或 setx ${keyEnv} <key>）`);
      const probe = await probeRelay(positioned, options.key ?? process.env[keyEnv]);
      printProbe(probe);
      if (!probe.ok) process.exitCode = 1;
      return;
    }
    case 'test': {
      const { id, relay } = requireRelay(paths, name);
      const probe = await probeRelay(relay.baseUrl, resolveRelayKey(relay, options.key));
      printProbe(probe);
      if (!probe.ok) process.exitCode = 1;
      return;
    }
    case 'models': {
      const { id, relay } = requireRelay(paths, name);
      const probe = await probeRelay(relay.baseUrl, resolveRelayKey(relay, options.key));
      printProbe(probe);
      if (!probe.ok) { process.exitCode = 1; return; }
      const ids = probe.models || [];
      if (options.enable || options.all) {
        const wanted = options.all ? ids : String(options.enable).split(',').map((item: string) => item.trim()).filter(Boolean);
        const enabled = wanted.filter(id => ids.includes(id));
        const unknown = wanted.filter(id => !ids.includes(id));
        if (unknown.length) console.error('这些 id 不在中转商列表中，已跳过：' + unknown.join(', '));
        upsertRelay(paths.agentDir, id, relay, enabled);
        console.log('已启用 ' + enabled.length + ' 个模型到 ' + modelsJsonPath(paths.agentDir) + '；重启或 /reload 后在 F4 模型列表可见。');
      } else if (!ids.length) {
        console.error('中转商未返回模型列表。');
        process.exitCode = 1;
      }
      return;
    }
    case 'list': {
      const relays = readRelays(paths.agentDir);
      const ids = Object.keys(relays);
      if (!ids.length) { console.log('还没有已保存的中转商。用 kepos relay add <名称> <baseUrl> 添加。'); return; }
      for (const id of ids) {
        const relay = relays[id];
        console.log(`${id} · ${relay.baseUrl} · ${relay.api} · key=${relay.apiKey} · 模型 ${relay.models?.length || 0} 个已启用`);
      }
      return;
    }
    case 'remove': {
      if (!name) throw Error('Usage: kepos relay remove <名称>（kepos relay list 查看 id）');
      const id = name.startsWith(RELAY_ID_PREFIX) ? name : RELAY_ID_PREFIX + slugify(name);
      if (removeRelay(paths.agentDir, id)) console.log('已删除 ' + id + '；重启或 /reload 后生效。');
      else { console.error('未知中转商：' + id); process.exitCode = 1; }
      return;
    }
    default:
      throw Error('Usage: kepos relay add|test|models|list|remove');
  }
}
