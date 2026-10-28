const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const isolated = fs.mkdtempSync(path.join(__dirname, 'recovery', 'install-test-'));
process.env.ORBITAL_HOME = path.join(isolated, 'state', 'orbital');
const { jiti, root, ext } = require('./test-loader.cjs');
const target = path.join(isolated, 'extension');
const env = { ...process.env, KEPOS_INSTALL_DIR: target };
function runtimeFiles(directory, prefix = '') {
 const files = [];
 for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
  const relative = path.join(prefix, entry.name);
  if (entry.isDirectory()) files.push(...runtimeFiles(path.join(directory, entry.name), relative));
  else if (/\.(ts|cjs)$/.test(entry.name)) files.push(relative);
 }
 return files.sort();
}
function install(...args) {
 const result = spawnSync(process.execPath, [path.join(__dirname, 'install-terminal.cjs'), ...args], { env, encoding: 'utf8', windowsHide: true });
 if (result.error) throw result.error;
 return result;
}
(async () => {
 let database;
 try {
 assert.equal(ext, path.resolve(process.env.KEPOS_EXTENSION_DIR || path.join(__dirname, 'terminal')));
 assert.equal(install('--check').status, 1);
 const first = install();
 assert.equal(first.status, 0, first.stderr);
 const files = runtimeFiles(path.join(__dirname, 'terminal'));
 assert.deepEqual(runtimeFiles(target), files);
 assert.equal(install('--check').status, 0);
 fs.appendFileSync(path.join(target, 'worker-host.cjs'), '\n// intentionally stale fixture\n');
 const stale = install('--check');
 assert.equal(stale.status, 1);
 assert.match(stale.stdout, /DIFF\s+worker-host\.cjs/);
 assert.equal(install().status, 0);
 assert.equal(install('--check').status, 0);
 const backup = fs.readdirSync(isolated).find(name => name.startsWith('extension.backup-'));
 assert.match(fs.readFileSync(path.join(isolated, backup, 'worker-host.cjs'), 'utf8'), /intentionally stale/);
 const mod = await jiti.import(path.join(target, 'index.ts'));
 database = (await jiti.import(path.join(target, 'database.ts'))).db();
 let shutdown;
 mod.default({ on: (name, handler) => { if (name === 'session_shutdown') shutdown = handler; }, registerCommand() {}, registerTool() {} });
 await shutdown({ reason: 'quit' });
 const layout = path.join(isolated, 'layout');
 for (const folder of ['runtime', 'terminal']) { fs.mkdirSync(path.join(layout, folder), { recursive: true }); fs.writeFileSync(path.join(layout, folder, 'index.ts'), '// fixture'); }
 const { resolveExtension } = require('./runtime-paths.cjs');
 const previousOverride = process.env.KEPOS_EXTENSION_DIR;
 delete process.env.KEPOS_EXTENSION_DIR;
 try { assert.equal(resolveExtension(layout), path.join(layout, 'terminal', 'index.ts')); }
 finally { if (previousOverride !== undefined) process.env.KEPOS_EXTENSION_DIR = previousOverride; }
 const launch = (args = []) => spawnSync(process.execPath, [path.join(__dirname, 'kepos.cjs'), ...args], {
  cwd:isolated, env:process.env, encoding:'utf8', windowsHide:true,
 });
 const checked=launch(['--engine-check']);assert.equal(checked.status,0,checked.stderr);
 assert.equal(JSON.parse(checked.stdout).architecture,'sdk');
 const direct=launch(['doctor','--home',path.join(isolated,'app'),'--json']);assert.equal(direct.status,0,direct.stderr);
 assert.equal(JSON.parse(direct.stdout).home,path.join(isolated,'app'));
 assert.equal(launch(['--version']).status,0);
 assert.equal(launch(['--does-not-exist']).status,1);
 console.log(`PASS complete ${files.length}-file install, stale-file detection, backup/reinstall, standalone installed import, workspace test default, SDK compatibility entry, independent home and CLI error propagation`);
 } finally {
  database?.close();
  const resolved = path.resolve(isolated);
  if (path.dirname(resolved) !== path.resolve(__dirname, 'recovery') || !path.basename(resolved).startsWith('install-test-')) throw Error('Refusing cleanup outside the test directory');
  fs.rmSync(resolved, { recursive: true, force: true });
 }
})().catch(error => { console.error(error); process.exitCode = 1; });
