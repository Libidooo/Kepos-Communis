const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function isSourceCheckout(root) {
  return fs.existsSync(path.join(root, 'src/cli.ts')) && fs.existsSync(path.join(root, 'tsconfig.json'));
}

function sourceFingerprint(root) {
  const hash = crypto.createHash('sha256');
  const files = [];
  function collect(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) collect(path.join(relative, name));
      return;
    }
    files.push(relative);
  }
  for (const relative of ['src', 'terminal', 'themes', 'tsconfig.json', 'package.json', 'package-lock.json', 'scripts/copy-assets.mjs']) collect(relative);
  for (const relative of files.sort()) {
    hash.update(relative.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function writeBuildStamp(root, fingerprint = sourceFingerprint(root)) {
  const directory = path.join(root, 'dist');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.kepos-build.json'), JSON.stringify({ version: 1, fingerprint }) + '\n');
}

function runBuild(root) {
  const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
  if (!fs.existsSync(compiler)) throw Error('Development dependencies are missing. Run npm ci in the Kepos project directory, then start Kepos again.');
  const steps = [
    [compiler, '-p', path.join(root, 'tsconfig.json')],
    [path.join(root, 'scripts/copy-assets.mjs')],
  ];
  for (const args of steps) {
    // Build messages use stderr so `kepos doctor --json` stays machine-readable.
    const result = spawnSync(process.execPath, args, { cwd: root, stdio: ['inherit', 2, 2], windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error('Kepos build failed. Fix the diagnostics above before restarting.');
  }
}

function ensureBuild(root) {
  const entry = path.join(root, 'dist/src/cli.js');
  if (!isSourceCheckout(root)) {
    if (!fs.existsSync(entry)) throw Error('The installed Kepos package is incomplete. Reinstall Kepos.');
    return entry;
  }
  const fingerprint = sourceFingerprint(root);
  const stamp = path.join(root, 'dist/.kepos-build.json');
  let previous;
  if (fs.existsSync(stamp)) {
    try { previous = JSON.parse(fs.readFileSync(stamp, 'utf8')); } catch { /* Rebuild an incomplete stamp. */ }
  }
  if (fs.existsSync(entry) && previous?.fingerprint === fingerprint) return entry;
  console.error('Kepos: building updated source...');
  runBuild(root);
  if (!fs.existsSync(entry)) throw Error('Kepos build did not create its CLI entry.');
  if (sourceFingerprint(root) !== fingerprint) throw Error('Source changed during compilation. Start Kepos again to rebuild consistently.');
  writeBuildStamp(root, fingerprint);
  return entry;
}

module.exports = { ensureBuild, isSourceCheckout, runBuild, sourceFingerprint, writeBuildStamp };
