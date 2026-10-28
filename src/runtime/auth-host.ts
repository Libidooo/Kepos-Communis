import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent';
import { tuiInteraction } from '../auth/interactions.ts';
import type { AuthService } from '../auth/service.ts';
import type { KeposHost } from '../../terminal/index.ts';

async function chooseProvider(auth: AuthService, ctx: any, configuredOnly: boolean): Promise<string | undefined> {
  const providers = auth.providers().filter(function availableProvider(provider) {
    if (configuredOnly) return provider.configured;
    return provider.methods.length > 0;
  });
  if (!providers.length) {
    if (configuredOnly) throw Error('没有已配置的登录；环境变量凭据需要在系统中管理。');
    throw Error('没有支持交互登录的服务商。');
  }
  const labels = providers.map(provider => `${provider.name} · ${provider.id}`);
  const title = configuredOnly ? '退出登录' : '连接模型服务';
  const selected = await ctx.ui.select('Kepos · ' + title, labels);
  return providers[labels.indexOf(selected)]?.id;
}

export function createAuthHost(auth: AuthService, getRuntime: () => AgentSessionRuntime): KeposHost {
  return {
    async login(ctx: any, requested?: string): Promise<void> {
      if (!ctx.isIdle()) throw Error('请等待当前任务结束再登录');
      const provider = requested || await chooseProvider(auth, ctx, false);
      if (!provider) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(Error('登录超时，请重试')), 300000);
      try {
        await auth.login(provider, undefined, tuiInteraction(ctx, controller.signal));
        const available = await auth.runtime.getAvailable(provider);
        const runtime = getRuntime();
        if (available.length && runtime) {
          const current = runtime.session.model;
          if (!current || !auth.runtime.hasConfiguredAuth(current.provider)) {
            await runtime.session.setModel(available[0]);
            runtime.services.settingsManager.setDefaultModelAndProvider(available[0].provider, available[0].id);
          }
        }
        ctx.ui.notify('已连接 ' + provider + '，模型列表已更新。', 'info');
      } finally {
        clearTimeout(timer);
      }
    },
    async logout(ctx: any, requested?: string): Promise<void> {
      if (!ctx.isIdle()) throw Error('请等待当前任务结束再退出登录');
      const provider = requested || await chooseProvider(auth, ctx, true);
      if (!provider) return;
      const confirmed = await ctx.ui.confirm('退出 ' + provider + '？', '清除此 Kepos 安装保存的授权；不会注销服务商账号。');
      if (!confirmed) return;
      const status = await auth.logout(provider);
      const message = status.configured ? '本地授权已清除，环境变量等配置仍然有效。' : '已清除 Kepos 本地授权。';
      ctx.ui.notify(message, 'info');
    },
    authStatus: () => auth.status(),
  };
}
