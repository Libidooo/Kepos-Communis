import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot, type AppPaths } from '../config.ts';

export function packageVersion(): string {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
}

export async function doctorCommand(paths: AppPaths, json = false): Promise<void> {
  const sdk = await import('@earendil-works/pi-coding-agent');
  const result = {
    product: 'Kepos Communis', version: packageVersion(), node: process.versions.node,
    sdk: sdk.VERSION, architecture: 'sdk', ...paths, theme: 'orbital-76',
    themeBundled: existsSync(join(packageRoot, 'themes/orbital-76.json')), project: process.cwd(),
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const theme = result.themeBundled ? 'orbital-76 ready' : 'missing';
  console.log(`Kepos ${result.version} · Node ${result.node} · Pi SDK ${result.sdk}\nProject: ${result.project}\nHome: ${paths.home}\nTheme: ${theme}`);
}
