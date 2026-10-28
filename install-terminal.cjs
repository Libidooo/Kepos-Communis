// Local installation only. No downloads, credentials, model calls, or terminal settings changes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const source = path.join(__dirname, 'terminal');
const target = path.resolve(process.env.KEPOS_INSTALL_DIR || path.join(os.homedir(), '.pi/agent/extensions/orbital'));
function runtimeFiles(directory, prefix = '') {
 const files = [];
 for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
  const relative = path.join(prefix, entry.name);
  const absolute = path.join(directory, entry.name);
  if (entry.isDirectory()) files.push(...runtimeFiles(absolute, relative));
  else if (/\.(ts|cjs)$/.test(entry.name)) files.push(relative);
 }
 return files.sort();
}
const names = runtimeFiles(source);
const digest = file => fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
try {
 if (!names.includes('index.ts')) throw Error('Missing source entry: index.ts');
 if (process.argv.includes('--check')) {
  let ok = true;
  for (const name of names) {
   const same = digest(path.join(source, name)) === digest(path.join(target, name));
   console.log((same ? 'MATCH ' : 'DIFF  ') + name);
   ok &&= same;
  }
  process.exitCode = ok ? 0 : 1;
 } else {
  if (target === path.resolve(source)) throw Error('Install target must differ from source');
  const backup = target + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
  // Save all previous runtime files before replacing any of them.
  for (const name of names) {
   const dest = path.join(target, name);
   if (fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(path.join(backup, name)), { recursive: true });
    fs.copyFileSync(dest, path.join(backup, name));
   }
  }
  fs.mkdirSync(target, { recursive: true });
  for (const name of names) {
   const dest = path.join(target, name), temp = dest + '.' + crypto.randomUUID() + '.tmp';
   fs.mkdirSync(path.dirname(dest), { recursive: true });
   try { fs.copyFileSync(path.join(source, name), temp); fs.renameSync(temp, dest); }
   finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  console.log(`Installed ${names.length} Kepos runtime files: ${target}`);
  console.log('In Pi: /reload then /kepos');
  if (fs.existsSync(backup)) console.log('Previous files backed up at: ' + backup);
 }
} catch (error) {
 console.error('Kepos installation failed: ' + error.message);
 process.exitCode = 1;
}
