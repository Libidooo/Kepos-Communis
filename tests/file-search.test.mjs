import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { registerFileSearchTool } = await import('../dist/terminal/file-search.js');
const { checkResearchProvenance, routeResearchIntent } = await import('../dist/terminal/research-router.js');

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
  assert.equal(result.details.coverage, 'complete');
  assert.doesNotMatch(result.content[0].text, /private resume contents/);
});

test('file search reports incomplete coverage and provenance refuses to claim a missing file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kepos-file-search-'));
  mkdirSync(join(home, '.hidden'), { recursive: true });
  writeFileSync(join(home, '.hidden', 'resume.pdf'), 'not searched');
  const tools = new Map();
  registerFileSearchTool({ registerTool(tool) { tools.set(tool.name, tool); } }, { mode: 'machine', cwd: home, home, allow: [] }, () => null);
  const result = await tools.get('kepos_find_file').execute('call-hidden', { query: 'resume' });
  assert.equal(result.details.results.length, 0);
  assert.equal(result.details.coverage, 'partial');
  assert.ok(result.details.scanStats.hiddenDirectoriesExcluded > 0);
  const route = routeResearchIntent('打开简历文件');
  assert.equal(checkResearchProvenance(route, [{ kind: 'file_search', ok: true, coverage: 'partial', resultCount: 0 }], '没有简历').ready, false);
});

test('file route requires reading a located candidate; complete empty scans support only scoped no-match claims', () => {
  const route = routeResearchIntent('打开简历文件');
  assert.equal(checkResearchProvenance(route, [{ kind: 'file_search', ok: true, coverage: 'partial', resultCount: 1 }], '找到了简历').ready, false);
  assert.equal(checkResearchProvenance(route, [{ kind: 'file_search', ok: true, coverage: 'complete', resultCount: 0 }], '授权搜索范围内没有匹配文件').ready, true);
  assert.equal(checkResearchProvenance(route, [{ kind: 'file_search', ok: true, coverage: 'complete', resultCount: 1 }, { kind: 'file_read', ok: true }], '已经读取简历').ready, true);
});

test('filename search refuses an explicitly requested directory outside its read scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kepos-file-search-'));
  const tools = new Map();
  registerFileSearchTool({ registerTool(tool) { tools.set(tool.name, tool); } }, { mode: 'project', cwd: root, home: root, allow: [] }, path => path.startsWith(root) ? null : 'outside project read scope');
  await assert.rejects(() => tools.get('kepos_find_file').execute('call-2', { query: 'resume', paths: ['/private'] }), /没有可搜索的已授权目录/);
});
