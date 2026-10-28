#!/usr/bin/env node
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ensureBuild } = require('./build-support.cjs');

async function start() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Kepos requires Node.js 24 or newer.');
  const root = path.resolve(__dirname, '..');
  const entry = ensureBuild(root);
  const { main } = await import(pathToFileURL(entry).href);
  await main(process.argv.slice(2));
}

start().catch(function reportFailure(error) {
  console.error('Kepos: ' + (error?.message || String(error)));
  process.exitCode = 1;
});
