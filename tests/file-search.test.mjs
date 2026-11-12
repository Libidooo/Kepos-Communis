import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { registerFileSearchTool } = await import('../dist/terminal/file-search.js');

test('filename search locates personal documents and returns metadata without reading contents', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kepos-file-search-'));
  const documents = join(home, 'Documents');
  mkdirSync(documents, { recursive: true });
  const resume = join(documents, 'Jane-Resume.pdf');
  writeFileSync(resume, 'private resume contents');
  const tools = new Map();
  registerFileSearchTool({ registerTool(tool) { tools.set(tool.name, tool); } }, { mode: 'machine', cwd: home, home, allow: [] }, () => null);

  const result = await tools.get('kepos_find_file').execute('call-1', { query: 'resume' });
  assert.equal(result.details.results[0].path, resume);
  assert.equal(result.details.results[0].bytes, Buffer.byteLength('private resume contents'));
  assert.doesNotMatch(result.content[0].text, /private resume contents/);
});

test('filename search refuses an explicitly requested directory outside its read scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kepos-file-search-'));
  const tools = new Map();
  registerFileSearchTool({ registerTool(tool) { tools.set(tool.name, tool); } }, { mode: 'project', cwd: root, home: root, allow: [] }, path => path.startsWith(root) ? null : 'outside project read scope');
  await assert.rejects(() => tools.get('kepos_find_file').execute('call-2', { query: 'resume', paths: ['/private'] }), /没有可搜索的已授权目录/);
});
