import type { AuthInteraction } from '@earendil-works/pi-ai';
import { createAuthService, type AuthService } from '../auth/service.ts';
import { terminalInteraction } from '../auth/interactions.ts';
import { deviceId, preparePaths, type AppPaths } from '../config.ts';
import type { CliOptions } from './options.ts';

async function selectProvider(auth: AuthService, options: CliOptions, interaction: AuthInteraction): Promise<string> {
  const requested = options.args[0] || options.provider;
  if (requested) return requested;
  const providers = auth.providers().filter(function canSelect(provider) {
    if (options.command === 'logout') return provider.configured;
    return provider.methods.length > 0;
  });
  if (!providers.length) throw Error('No matching providers');
  const message = options.command === 'login' ? 'Connect a provider:' : 'Remove a saved credential:';
  return interaction.prompt({ type: 'select', message, options: providers.map(provider => ({ id: provider.id, label: `${provider.name} (${provider.id})` })) });
}

async function authenticate(auth: AuthService, options: CliOptions): Promise<void> {
  const controller = new AbortController();
  function stop(): void { controller.abort(Error('Authentication cancelled')); }
  process.once('SIGINT', stop);
  const timer = setTimeout(() => controller.abort(Error('Authentication timed out')), 300000);
  try {
    const interaction = terminalInteraction(controller.signal);
    const provider = await selectProvider(auth, options, interaction);
    if (options.command === 'login') {
      await auth.login(provider, options.method, interaction);
      console.log('Connected ' + provider + '. Run kepos to begin.');
      return;
    }
    const status = await auth.logout(provider);
    const message = status.configured
      ? 'Saved credential removed; environment configuration is still active.'
      : 'Removed Kepos credential for ' + provider + '.';
    console.log(message);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
  }
}

export async function authCommand(options: CliOptions, paths: AppPaths): Promise<void> {
  preparePaths(paths);
  const auth = await createAuthService(paths.agentDir, { getDeviceId: () => deviceId(paths) });
  if (options.command === 'auth') {
    if (options.args[0] && options.args[0] !== 'status') throw Error('Usage: kepos auth status');
    const statuses = auth.status();
    const text = statuses.filter(provider => provider.configured)
      .map(provider => `${provider.id}: configured (${provider.source || 'provider'})`).join('\n');
    console.log(options.json ? JSON.stringify(statuses) : text || 'No connected providers. Run kepos login.');
    return;
  }
  if (options.command === 'models') {
    const models = await auth.runtime.getAvailable();
    const origin = (providerId: string) => (providerId.startsWith('relay_') ? ' [中转]' : ' [官方]');
    const data = models.map((model: any) => ({ provider: model.provider, id: model.id, name: model.name, contextWindow: model.contextWindow, origin: origin(model.provider) }));
    const text = data.map((model: any) => `${model.provider}/${model.id}${origin(model.provider)}`).join('\n');
    console.log(options.json ? JSON.stringify(data) : text || 'No available models. Run kepos login.');
    return;
  }
  await authenticate(auth, options);
}
