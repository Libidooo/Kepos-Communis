import { resolve } from 'node:path';
import { activatePaths, appPaths, type AppPaths } from './config.ts';
import { doctorCommand, packageVersion } from './cli/diagnostics.ts';
import { HELP, parseCli, type CliOptions } from './cli/options.ts';
export { HELP, parseCli, type CliOptions } from './cli/options.ts';

function commandPaths(options: CliOptions): AppPaths {
  const env = { ...process.env };
  if (options.home) {
    env.KEPOS_HOME = resolve(options.home);
    for (const key of ['KEPOS_AGENT_DIR', 'KEPOS_DATA_DIR', 'ORBITAL_HOME', 'ORBITAL_DATA_DIR']) delete env[key];
    delete process.env.ORBITAL_HOME;
    delete process.env.ORBITAL_DATA_DIR;
  }
  return appPaths(env);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCli(argv);
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.command === 'version') {
    console.log(packageVersion());
    return;
  }
  const paths = commandPaths(options);
  activatePaths(paths);
  if (options.cwd) process.chdir(resolve(options.cwd));

  switch (options.command) {
    case 'doctor':
      await doctorCommand(paths, options.json);
      return;
    case 'login': case 'logout': case 'auth': case 'models': {
      const { authCommand } = await import('./cli/auth.ts');
      await authCommand(options, paths);
      return;
    }
    case 'graph': {
      throw Error('Graph export has been retired. Start Kepos and press F10 to open the live terminal graph.');
    }
    case 'retention': {
      const { retentionCommand } = await import('./retention.ts'); await retentionCommand(options, paths); return;
    }
    case 'service': {
      const { serviceCommand } = await import('./service-cli.ts'); serviceCommand(options, paths); return;
    }
    case 'worker': {
      const { workerCommand } = await import('./worker-command.ts'); await workerCommand(options, paths); return;
    }
    case 'daemon': {
      if (options.args.length) throw Error('daemon does not accept positional arguments');
      const { runDaemon } = await import('./daemon.ts'); await runDaemon(paths); return;
    }
    case 'missions': case 'supervise': {
      const { missionCommand } = await import('./missions.ts');
      await missionCommand(options, paths);
      return;
    }
    case 'start': {
      if (options.args.length) throw Error('Unexpected arguments; start Kepos and enter your task in its editor.');
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Kepos workspace requires an interactive terminal. Use kepos --help for headless commands.');
      const { runWorkspace } = await import('./runtime/app.ts');
      await runWorkspace({ cwd: options.cwd, paths, model: options.model, provider: options.provider, session: options.session, continue: options.continue, theme: options.theme, thinking: options.thinking });
      return;
    }
    default:
      throw Error('Unknown command: ' + options.command + ' (run kepos --help)');
  }
}
