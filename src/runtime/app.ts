import { join, resolve } from 'node:path';
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  InteractiveMode, SessionManager, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';
import { createAuthService, type AuthService } from '../auth/service.ts';
import { activatePaths, appPaths, deviceId, preparePaths, type AppPaths } from '../config.ts';
import { createAuthHost } from './auth-host.ts';

export interface WorkspaceOptions {
  cwd?: string;
  paths?: AppPaths;
  model?: string;
  provider?: string;
  session?: string;
  continue?: boolean;
  theme?: string;
  thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface Workspace {
  runtime: AgentSessionRuntime;
  auth: AuthService;
  paths: AppPaths;
}

function initialSession(options: WorkspaceOptions, cwd: string, paths: AppPaths): SessionManager {
  if (options.session) return SessionManager.open(resolve(options.session), paths.sessionDir);
  if (options.continue) return SessionManager.continueRecent(cwd, paths.sessionDir);
  return SessionManager.create(cwd, paths.sessionDir);
}

function initialModel(auth: AuthService, options: WorkspaceOptions): any {
  if (!options.model) return undefined;
  let model;
  if (options.provider) model = auth.runtime.getModel(options.provider, options.model);
  else model = auth.runtime.getModels().find((candidate: any) => candidate.id === options.model || `${candidate.provider}/${candidate.id}` === options.model);
  if (!model) throw Error('Unknown model: ' + options.model);
  return model;
}

export async function createWorkspace(options: WorkspaceOptions = {}): Promise<Workspace> {
  const paths = options.paths || appPaths();
  preparePaths(paths);
  activatePaths(paths);
  // Load path-bound services only after selecting this installation's data directory.
  const activeStore = await import('../../terminal/paths.ts');
  const expectedDatabase = resolve(join(paths.dataDir, 'orbital.sqlite'));
  if (resolve(activeStore.databasePath) !== expectedDatabase) {
    throw Error('This process is already bound to another Kepos data directory. Start a separate process for a different --home.');
  }
  const { default: keposExtension } = await import('../../terminal/index.ts');
  const auth = await createAuthService(paths.agentDir, { getDeviceId: () => deviceId(paths) });
  const cwd = resolve(options.cwd || process.cwd());
  let runtime: AgentSessionRuntime;
  const host = createAuthHost(auth, () => runtime, paths.agentDir);

  const createRuntime: CreateAgentSessionRuntimeFactory = async function createProjectRuntime({ cwd: targetCwd, sessionManager, sessionStartEvent }) {
    const services = await createAgentSessionServices({
      cwd: targetCwd, agentDir: paths.agentDir, modelRuntime: auth.runtime,
      resourceLoaderOptions: {
        noExtensions: true,
        additionalThemePaths: [join(paths.themeDir, 'orbital-76.json')],
        extensionFactories: [{ name: 'kepos', factory: pi => keposExtension(pi, host) }],
      },
    });
    const session = await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent,
      model: initialModel(auth, options), thinkingLevel: options.thinking,
    });
    return { ...session, services, diagnostics: services.diagnostics };
  };

  const manager = initialSession(options, cwd, paths);
  runtime = await createAgentSessionRuntime(createRuntime, { cwd: manager.getCwd(), agentDir: paths.agentDir, sessionManager: manager });
  return { runtime, auth, paths };
}

export async function runWorkspace(options: WorkspaceOptions = {}): Promise<void> {
  const { runtime } = await createWorkspace(options);
  const mode = new InteractiveMode(runtime, {
    initialMessage: '/kepos',
    initialThemeSetting: options.theme || runtime.services.settingsManager.getThemeSetting() || 'orbital-76',
    modelFallbackMessage: runtime.modelFallbackMessage,
    startupDiagnostics: [...runtime.diagnostics],
  });
  try {
    await mode.run();
  } finally {
    await runtime.dispose();
  }
}
