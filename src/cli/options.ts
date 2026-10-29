export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface CliOptions {
  command: string;
  args: string[];
  home?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  session?: string;
  continue?: boolean;
  theme?: string;
  thinking?: ThinkingLevel;
  method?: 'api_key' | 'oauth';
  host?: string; port?: string; token?: string; tlsCert?: string; tlsKey?: string; days?: string; maxEvents?: string;
  json?: boolean;
  help?: boolean;
}

const VALUE_FLAGS = {
  '--home': 'home', '--cwd': 'cwd', '--model': 'model', '--provider': 'provider',
  '--session': 'session', '--theme': 'theme', '--thinking': 'thinking', '--method': 'method', '--host': 'host', '--port': 'port', '--token': 'token', '--tls-cert': 'tlsCert', '--tls-key': 'tlsKey', '--days': 'days', '--max-events': 'maxEvents',
} as const;

export function parseCli(argv: string[]): CliOptions {
  const result: CliOptions = { command: 'start', args: [] };
  let commandSet = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') {
      result.args.push(...argv.slice(index + 1));
      break;
    }
    switch (arg) {
      case '--help': case '-h': result.help = true; continue;
      case '--version': case '-v': result.command = 'version'; commandSet = true; continue;
      case '--engine-check': result.command = 'doctor'; result.json = true; commandSet = true; continue;
      case '--json': result.json = true; continue;
      case '--continue': case '-c': result.continue = true; continue;
    }
    const key = VALUE_FLAGS[arg as keyof typeof VALUE_FLAGS];
    if (key) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw Error('Missing value for ' + arg);
      Object.assign(result, { [key]: value });
      continue;
    }
    if (arg.startsWith('-')) throw Error('Unknown option: ' + arg + ' (run kepos --help)');
    if (commandSet) result.args.push(arg);
    else {
      result.command = arg;
      commandSet = true;
    }
  }
  if (result.method && !['oauth', 'api_key'].includes(result.method)) throw Error('--method must be oauth or api_key');
  const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (result.thinking && !thinkingLevels.includes(result.thinking)) throw Error('Unknown thinking level');
  return result;
}

export const HELP = `Kepos Communis — your agent command desk

Usage: kepos [command] [options]

  kepos                    Open the terminal workspace
  kepos login [provider]   Connect a model provider (OAuth or API key)
  kepos logout [provider]  Remove Kepos's saved provider credential
  kepos auth status       Show credential metadata, never secret values
  kepos models            List models available to this installation
  kepos doctor            Check local dependencies and data paths
  kepos missions          List durable task plans
  kepos missions show|events|pause|approve|resume|cancel|run <id> [job]
  kepos supervise <file>  Run a durable task plan from a JSON file
  kepos daemon            Run one cross-process scheduler owner
  kepos worker serve      Run an authenticated remote Worker executor
  kepos retention         Archive old derived events

Options:
  --home <directory>      Kepos home (default: ~/.kepos)
  --cwd <directory>       Project directory
  --model <id>            Initial model; use --provider to disambiguate
  --continue              Continue the latest project session
  --session <file>        Open a saved session
  --theme <name>          Pi-compatible theme (default: orbital-76)
  --thinking <level>      off, minimal, low, medium, high, xhigh, max
  --method <type>         login method: oauth or api_key
  --json                  Machine-readable status
  --help / --version

Node.js 24+ required. Pi is installed automatically as a Kepos dependency.
No model is contacted by help, doctor, auth status, or model listing.
`;
