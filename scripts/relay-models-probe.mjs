import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'kepos-mretry-'));
mkdirSync(join(home, 'agent'), { recursive: true });
writeFileSync(join(home, 'agent', 'models.json'), JSON.stringify({
  $schema: 'https://pi.dev/schemas/models.schema.json',
  providers: {
    relay_demo: {
      name: 'Demo relay', baseUrl: 'https://relay.example/v1', api: 'openai-completions',
      apiKey: '$KEPOS_RELAY_DEMO', authHeader: true,
      models: [{ id: 'gpt-x', name: 'gpt-x' }, { id: 'deepseek-z', name: 'deepseek-z' }, { id: 'claude-y', name: 'claude-y' }],
    },
  },
}, null, 2));

const env = { ...process.env, KEPOS_RELAY_DEMO: 'sk-test', KEPOS_HOME: home };
const result = spawnSync('node', ['bin/kepos.cjs', 'models', '--home', home], { encoding: 'utf8', env });
console.log('== kepos models == status', result.status);
console.log(result.stdout.trim() || '(empty stdout)');
if (result.stderr.trim()) console.log('STDERR:', result.stderr.trim());
