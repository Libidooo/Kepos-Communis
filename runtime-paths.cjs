const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function resolveEngine() {
 if (process.env.KEPOS_PI_PACKAGE) {
  const root = path.resolve(process.env.KEPOS_PI_PACKAGE);
  if (!fs.existsSync(path.join(root, 'dist/cli.js'))) throw Error('KEPOS_PI_PACKAGE does not contain a Pi runtime: ' + root);
  return root;
 }
 const candidates = [path.join(__dirname, 'node_modules/@earendil-works/pi-coding-agent')];
 try { candidates.push(path.dirname(require.resolve('@earendil-works/pi-coding-agent/package.json'))); } catch {}
 if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent'));
 candidates.push(path.join(path.dirname(process.execPath), 'node_modules/@earendil-works/pi-coding-agent'), '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent', '/usr/lib/node_modules/@earendil-works/pi-coding-agent');
 const root = candidates.find(candidate => fs.existsSync(path.join(candidate, 'dist/cli.js')));
 if (!root) throw Error('Pi runtime engine not found. Install @earendil-works/pi-coding-agent, or set KEPOS_PI_PACKAGE to its package directory.');
 return root;
}
function resolveExtension(baseDir = __dirname) {
 if (process.env.KEPOS_EXTENSION_DIR) {
  const file = path.resolve(process.env.KEPOS_EXTENSION_DIR, 'index.ts');
  if (!fs.existsSync(file)) throw Error('KEPOS_EXTENSION_DIR has no index.ts: ' + file);
  return file;
 }
 const candidates = [path.join(baseDir, 'terminal/index.ts'), path.join(baseDir, 'runtime/index.ts'), path.join(os.homedir(), '.pi/agent/extensions/orbital/index.ts')];
 const file = candidates.find(candidate => fs.existsSync(candidate));
 if (!file) throw Error('Kepos extension is missing; run node install-terminal.cjs first.');
 return file;
}
module.exports = { resolveEngine, resolveExtension };
