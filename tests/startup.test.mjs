import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { ensureBuild, sourceFingerprint } = require('../bin/build-support.cjs');

function sourceFixture() {
 const root = mkdtempSync(join(tmpdir(), 'kepos-source-start-'));
 mkdirSync(join(root, 'src'), { recursive: true });
 mkdirSync(join(root, 'scripts'), { recursive: true });
 mkdirSync(join(root, 'node_modules/typescript/bin'), { recursive: true });
 writeFileSync(join(root, 'src/cli.ts'), '// source');
 writeFileSync(join(root, 'tsconfig.json'), '{}');
 writeFileSync(join(root, 'package.json'), '{}');
 writeFileSync(join(root, 'node_modules/typescript/bin/tsc'), `const fs=require('node:fs');fs.mkdirSync('dist/src',{recursive:true});fs.writeFileSync('dist/src/cli.js','// generated');fs.appendFileSync('build-count','1');`);
 writeFileSync(join(root, 'scripts/copy-assets.mjs'), '// no extra assets');
 return root;
}

test('source startup builds once and only rebuilds when source changes', () => {
 const root = sourceFixture();
 assert.equal(ensureBuild(root), join(root, 'dist/src/cli.js'));
 assert.equal(readFileSync(join(root, 'build-count'), 'utf8'), '1');
 const firstFingerprint = sourceFingerprint(root);
 ensureBuild(root);
 assert.equal(readFileSync(join(root, 'build-count'), 'utf8'), '1');
 writeFileSync(join(root, 'src/cli.ts'), '// changed source');
 assert.notEqual(sourceFingerprint(root), firstFingerprint);
 ensureBuild(root);
 assert.equal(readFileSync(join(root, 'build-count'), 'utf8'), '11');
});

test('incomplete and failed source builds never receive a valid build stamp', () => {
 const root = sourceFixture();
 writeFileSync(join(root, 'node_modules/typescript/bin/tsc'), 'process.exit(2);');
 assert.throws(() => ensureBuild(root), /build failed/);
 assert.equal(existsSync(join(root, 'dist/.kepos-build.json')), false);
});

test('a failed rebuild does not load an older compiled entry', () => {
 const root = sourceFixture(); ensureBuild(root);
 writeFileSync(join(root, 'src/cli.ts'), '// incompatible change');
 writeFileSync(join(root, 'node_modules/typescript/bin/tsc'), 'process.exit(2);');
 assert.throws(() => ensureBuild(root), /build failed/);
 assert.ok(existsSync(join(root, 'dist/src/cli.js')), 'old artifact exists but must not be loaded');
});

test('published packages launch their compiled payload without development dependencies', () => {
 const root = mkdtempSync(join(tmpdir(), 'kepos-published-start-'));
 mkdirSync(join(root, 'dist/src'), { recursive: true });
 writeFileSync(join(root, 'dist/src/cli.js'), '// precompiled');
 assert.equal(ensureBuild(root), join(root, 'dist/src/cli.js'));
 const incomplete = mkdtempSync(join(tmpdir(), 'kepos-incomplete-start-'));
 assert.throws(() => ensureBuild(incomplete), /incomplete/);
});

test('launcher JSON stays parseable and preserves the calling project directory', () => {
 const cwd = mkdtempSync(join(tmpdir(), 'kepos-project-start-'));
 const result = spawnSync(process.execPath, [resolve('bin/kepos.cjs'), 'doctor', '--json'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000 });
 assert.equal(result.status, 0, result.stderr);
 assert.equal(JSON.parse(result.stdout).project, cwd);
});
