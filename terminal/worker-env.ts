import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findEnvKeys } from '@earendil-works/pi-ai/compat';

// No blanket shell inheritance. The explicit passthrough remains an operator opt-in.
const WORKER_ENV_KEYS = ['PATH', 'PATHEXT', 'COMSPEC', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'SYSTEMROOT', 'SYSTEMDRIVE', 'LANG', 'LC_ALL', 'TERM', 'PI_CODING_AGENT_DIR', 'KEPOS_AGENT_DIR'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A credential reference must not accidentally enable code injection in the child runtime.
const RUNTIME_ENV = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|BASH_ENV|ENV)$/;
export type WorkerEnvSelection = { provider: string; model?: string; agentDir?: string };
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const own = (value: unknown, key: string): any => Object.hasOwn(record(value), key) ? record(value)[key] : undefined;

function readConfig(agentDir: string, name: 'models.json' | 'auth.json') {
 let text: string;
 try { text = readFileSync(join(agentDir, name), 'utf8').replace(/^\uFEFF/, ''); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
  throw Error(`Worker cannot read ${name}`);
 }
 // Pi 1.4 models.json allows line comments and trailing commas; auth.json is plain JSON.
 if (name === 'models.json') text = text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, match => match[0] === '"' ? match : '')
  .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? match);
 try {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid config');
  return parsed;
 } catch { throw Error(`Worker cannot parse ${name}; expected a JSON object`); }
}

// Match Pi's non-command config templates, including escapes. Never resolve values or run !commands.
function references(value: unknown): string[] {
 if (typeof value !== 'string' || value.startsWith('!')) return [];
 const names: string[] = [];
 for (const match of value.matchAll(/\$\$|\$!|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
  const name = match[1] ?? match[2];
  if (name && ENV_NAME.test(name) && !RUNTIME_ENV.test(name)) names.push(name);
 }
 return names;
}

function selectedEnvKeys(agentDir: string | undefined, selected: WorkerEnvSelection, base: NodeJS.ProcessEnv): string[] {
 // Public SDK helper returns only standard auth variable names for this provider, never all API keys.
 const names = [...(findEnvKeys(selected.provider, base) ?? [])];
 if (!agentDir || !selected.provider) return names;
 const provider = record(own(readConfig(agentDir, 'models.json').providers, selected.provider));
 const credential = record(own(readConfig(agentDir, 'auth.json'), selected.provider));
 const model = Array.isArray(provider.models) ? provider.models.find(item => item?.id === selected.model) : undefined;
 const headers = { ...record(own(provider.modelOverrides, selected.model ?? '')?.headers), ...record(model?.headers) };
 const values = [provider.apiKey, ...Object.values(record(provider.headers)), ...Object.values(headers)];
 if (credential.type === 'api_key') values.push(credential.key);
 for (const value of values) {
  for (const name of references(value)) {
   // Stored credential env entries are literal, scoped overrides already read by Pi itself.
   if (!own(credential.env, name)) names.push(name);
  }
 }
 return names;
}

/** Copy only runtime essentials, explicit grants, and the selected provider's declared auth references. */
export function workerEnv(base: NodeJS.ProcessEnv, pid: number, selected?: WorkerEnvSelection): NodeJS.ProcessEnv {
 const passthrough = (base.KEPOS_WORKER_ENV_PASSTHROUGH || '').split(',').map(key => key.trim()).filter(key => ENV_NAME.test(key));
 const rawDir = selected?.agentDir || base.PI_CODING_AGENT_DIR || base.KEPOS_AGENT_DIR;
 const home = (process.platform === 'win32' ? base.USERPROFILE : base.HOME) || base.HOME;
 const agentDir = rawDir ? resolve(rawDir === '~' || /^~[\\/]/.test(rawDir) ? join(home || '.', rawDir.slice(1)) : rawDir) : undefined;
 const names = selected ? selectedEnvKeys(agentDir, selected, base) : [];
 const env: NodeJS.ProcessEnv = {};
 for (const key of new Set([...WORKER_ENV_KEYS, ...passthrough, ...names])) {
  const value = base[key];
  if (value !== undefined) env[key] = value;
 }
 // Freeze the config root before changing cwd; Pi does not interpret KEPOS_AGENT_DIR itself.
 if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
 env.ORBITAL_PARENT_PID = String(pid);
 return env;
}
