import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AuthInteraction, AuthType } from '@earendil-works/pi-ai';

export interface ProviderInfo { id: string; name: string; methods: AuthType[]; configured: boolean; source?: string; }
export class AuthService {
 constructor(readonly runtime: any, private options: { agentName?: string; getDeviceId?: () => string } = {}) {}
 providers(): ProviderInfo[] {
  return this.runtime.getProviders().map((provider: any) => {
   const status = this.runtime.getProviderAuthStatus(provider.id);
   const methods: AuthType[] = [];
   if (typeof provider.auth?.apiKey?.login === 'function') methods.push('api_key');
   if (typeof provider.auth?.oauth?.login === 'function') methods.push('oauth');
   return { id: provider.id, name: provider.name || provider.id, methods, configured: !!status?.configured, ...(status?.source ? { source: status.source } : {}) };
  }).sort((a: ProviderInfo, b: ProviderInfo) => a.name.localeCompare(b.name));
 }
 status(): ProviderInfo[] { return this.providers(); }
 async login(providerId: string, method: AuthType | undefined, interaction: AuthInteraction): Promise<ProviderInfo> {
  const provider = this.providers().find(item => item.id === providerId);
  if (!provider) throw Error('Unknown provider: ' + providerId);
  if (interaction.signal?.aborted) throw interaction.signal.reason || Error('Authentication cancelled');
  if (!provider.methods.length) throw Error('This provider uses environment or ambient credentials; it has no interactive login.');
  let selected = method;
  if (!selected && provider.methods.length === 1) selected = provider.methods[0];
  if (!selected) selected = await interaction.prompt({ type: 'select', message: 'Choose authentication method', options: provider.methods.map(type => ({ id: type, label: type === 'oauth' ? 'Browser / subscription login' : 'API key' })) }) as AuthType;
  if (!provider.methods.includes(selected)) throw Error('Unsupported authentication method for ' + providerId);
  await this.runtime.login(providerId, selected, interaction, { agentName: this.options.agentName || 'kepos', getDeviceId: this.options.getDeviceId });
  return this.providers().find(item => item.id === providerId)!;
 }
 async logout(providerId: string): Promise<ProviderInfo> {
  if (!this.runtime.getProvider(providerId)) throw Error('Unknown provider: ' + providerId);
  await this.runtime.logout(providerId);
  return this.providers().find(item => item.id === providerId)!;
 }
}
export async function createAuthService(agentDir: string, options: { getDeviceId?: () => string } = {}): Promise<AuthService> {
 const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
 await runtime.refresh({ allowNetwork: false });
 return new AuthService(runtime, { agentName: 'kepos', ...options });
}
