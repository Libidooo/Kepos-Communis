import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const forbiddenNames = /(^|[\\/])(?:\.env(?:\.|$)|auth\.json$|credentials?\.json$|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i;
const highConfidence = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /sk-[A-Za-z0-9]{24,}/,
];
const findings = [];

for (const file of tracked) {
  if (forbiddenNames.test(file)) findings.push(`${file}: sensitive filename`);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  for (const pattern of highConfidence) {
    if (pattern.test(text)) findings.push(`${file}: ${pattern}`);
  }
}

for (const pattern of highConfidence) {
  const historyPattern = pattern.source.replaceAll('(?:', '(');
  const result = execFileSync('git', ['log', '--all', '-G', historyPattern, '--format=%H'], { encoding: 'utf8' });
  if (result.trim()) findings.push(`git history matches ${pattern}`);
}

if (findings.length) {
  console.error('Public repository audit failed:');
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`PASS public audit: ${tracked.length} tracked files, no high-confidence secrets or credential files`);
}

const endpointFiles = tracked.filter(file => /\.(?:ts|mjs|cjs|md|json)$/.test(basename(file)));
const endpointText = endpointFiles.map(file => readFileSync(file, 'utf8')).join('\n');
if (/https?:\/\/[^\s'"`]+\?(?:[^\s]*&)?(?:token|key|secret|password)=/i.test(endpointText)) {
  console.error('Public repository audit failed: credential-like query parameter found in a URL');
  process.exitCode = 1;
}
