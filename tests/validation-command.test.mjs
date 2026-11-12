import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { inspectProjectCheck, runProjectCheck, PROJECT_CHECKS } = await import('../dist/terminal/validation-command.js');

const project = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kepos-project-check-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(\'CHECK_OK\')"', typecheck: 'node --version' } }));
  return cwd;
};

test('project checks only expose fixed named package scripts', () => {
  const cwd = project();
  try {
    assert.deepEqual(PROJECT_CHECKS, ['test', 'typecheck', 'build', 'lint', 'check']);
    const info = inspectProjectCheck(cwd, 'test');
    assert.equal(info.check, 'test');
    assert.equal(info.command, 'npm run --ignore-scripts test');
    assert.match(info.packageHash, /^[a-f0-9]{64}$/);
    assert.match(info.script, /CHECK_OK/);
    assert.match(inspectProjectCheck(cwd, 'anything').error, /只支持这些项目验证项/);
    assert.match(inspectProjectCheck(cwd, 'build').error, /没有 scripts\.build/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('a validation check executes the reviewed package script and returns real output and exit status', async () => {
  const cwd = project();
  try {
    const info = inspectProjectCheck(cwd, 'test');
    const result = await runProjectCheck({ info, expectedPackageHash: info.packageHash, timeoutMs: 10_000 });
    assert.equal(result.ok, true, result.error || result.output);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /CHECK_OK/);
    assert.ok(result.endedAt >= result.startedAt);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('a check is refused when package scripts change after the principal reviewed them', async () => {
  const cwd = project();
  try {
    const info = inspectProjectCheck(cwd, 'test');
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(0)"' } }));
    const result = await runProjectCheck({ info, expectedPackageHash: info.packageHash });
    assert.equal(result.ok, false);
    assert.match(result.error, /审批后发生变化/);
    assert.equal(result.output, '');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('npm script execution strips application credentials and forces offline mode', async () => {
  const cwd = project();
  try {
    const info = inspectProjectCheck(cwd, 'typecheck');
    // The runner accepts an injected base environment; the child receives only runtime keys.
    // Inspect this through a harmless script rather than exposing the environment to callers.
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { typecheck: 'node -e "console.log(process.env.SECRET_TOKEN || \'NO_SECRET\'); console.log(process.env.npm_config_offline)"' } }));
    const fresh = inspectProjectCheck(cwd, 'typecheck');
    const result = await runProjectCheck({ info: fresh, expectedPackageHash: fresh.packageHash, env: { PATH: process.env.PATH, SECRET_TOKEN: 'should-not-leak' }, timeoutMs: 10_000 });
    assert.equal(result.ok, true, result.error || result.output);
    assert.match(result.output, /NO_SECRET/);
    assert.match(result.output, /true/);
    assert.doesNotMatch(result.output, /should-not-leak/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
