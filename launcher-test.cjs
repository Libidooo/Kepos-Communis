const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') { console.log('SKIP Windows launcher regression'); process.exit(0); }
const isolated = fs.mkdtempSync(path.join(__dirname, 'recovery', 'launcher-test-'));
const target = path.join(isolated, '中文 空格', 'bin');
const installer = path.join(__dirname, 'install-launcher.cjs');
const env = { ...process.env, KEPOS_BIN_DIR: target };
const install = (...args) => spawnSync(process.execPath, [installer, ...args], { env, encoding: 'utf8', windowsHide: true });
function run(args, extraEnv = {}, cwd = isolated, codePage) {
 const command = codePage ? `chcp ${codePage}>nul & call "${path.join(target, 'kepos.cmd')}" ${args}` : `""${path.join(target, 'kepos.cmd')}" ${args}"`;
 return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
  cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
 });
}
try {
 assert.equal(install('--check').status, 1);
 const installed = install();
 assert.equal(installed.status, 0, installed.stderr);
 assert.equal(install('--check').status, 0);
 for (const name of ['kepos.cmd', 'kepos-launcher.cjs']) assert.ok(!/[^\x00-\x7f]/.test(fs.readFileSync(path.join(target, name), 'utf8')));
 const checked = run('--engine-check');
 assert.equal(checked.status, 0, checked.stderr);
 assert.equal(JSON.parse(checked.stdout).architecture,'sdk');
 const source = path.join(isolated, '源码 空格');
 fs.mkdirSync(source, { recursive: true });
 fs.copyFileSync(installer, path.join(source, 'install-launcher.cjs'));
 fs.writeFileSync(path.join(source, 'kepos.cjs'), 'console.log(JSON.stringify({entry:__filename,cwd:process.cwd(),args:process.argv.slice(2)}));process.exit(Number(process.env.KEPOS_TEST_EXIT||0));');
 const unicodeInstall = spawnSync(process.execPath, [path.join(source, 'install-launcher.cjs')], { env, encoding: 'utf8', windowsHide: true });
 assert.equal(unicodeInstall.status, 0, unicodeInstall.stderr);
 assert.ok(!/[^\x00-\x7f]/.test(fs.readFileSync(path.join(target, 'kepos-launcher.cjs'), 'utf8')));
 for (const page of [936, 65001]) {
  const unicodeRun = run('--accept "value with spaces"', {}, isolated, page);
  assert.equal(unicodeRun.status, 0, unicodeRun.stderr);
  const data = JSON.parse(unicodeRun.stdout);
  assert.equal(data.entry, path.join(source, 'kepos.cjs'));
  assert.deepEqual(data.args, ['--accept', 'value with spaces']);
 }
 const exited=run('--accept "value with spaces"',{KEPOS_TEST_EXIT:'7'});assert.equal(exited.status,7,exited.stderr);assert.equal(JSON.parse(exited.stdout).cwd,isolated);
 console.log('PASS ASCII-only global shim, Chinese/spaced install directory, Chinese source paths under CP936/UTF-8, quoted arguments, working directory and exit-code preservation');
} finally {
 const resolved = path.resolve(isolated);
 if (path.dirname(resolved) !== path.resolve(__dirname, 'recovery') || !path.basename(resolved).startsWith('launcher-test-')) throw Error('Unexpected launcher test cleanup path');
 fs.rmSync(resolved, { recursive: true, force: true });
}
