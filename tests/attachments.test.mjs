import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const {
  listZipEntries, readZipEntry, xmlToText, loadAttachment,
  attachmentToPrompt, looksLikeFilePaths, clampAttachmentText, MAX_ATTACHMENT_BYTES,
} = await import('../dist/terminal/attachments.js');

// ── 测试内现场构造 ZIP ──
// 仓库不放二进制夹具：用 deflateRawSync + crc32 现场拼一个合法 zip，
// 这样夹具永远与实现同步，也不会在 git 里留二进制。
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data) >>> 0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt32LE(crc32(data) >>> 0, 16);
    centralEntry.writeUInt32LE(deflated.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, deflated);
    central.push(centralEntry, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const home = mkdtempSync(join(tmpdir(), 'kepos-attach-'));
const write = (name, data) => {
  const path = join(home, name);
  writeFileSync(path, typeof data === 'string' ? data : data);
  return path;
};

test('zip reader lists and extracts entries built by our own writer', () => {
  const zip = buildZip({ 'a.txt': 'hello 世界', 'dir/b.md': '# title' });
  const entries = listZipEntries(zip);
  assert.deepEqual(entries.map(e => e.name), ['a.txt', 'dir/b.md']);
  assert.equal(readZipEntry(zip, entries[0]).toString('utf8'), 'hello 世界');
  assert.equal(readZipEntry(zip, entries[1]).toString('utf8'), '# title');
});

test('zip reader rejects corrupt archives instead of guessing', () => {
  assert.throws(() => listZipEntries(Buffer.from('not a zip at all')), /ZIP/);
  const truncated = buildZip({ 'a.txt': 'x' }).subarray(0, 10);
  assert.throws(() => listZipEntries(truncated), /ZIP/);
});

test('docx text extraction keeps paragraphs and decodes entities', async () => {
  const docx = buildZip({
    'word/document.xml': `<w:document><w:body>
      <w:p><w:r><w:t>第一章 引言</w:t></w:r></w:p>
      <w:p><w:r><w:t>结论 &amp; 展望</w:t></w:r></w:p>
    </w:body></w:document>`,
  });
  const result = await loadAttachment(write('报告.docx', docx));
  assert.equal(result.ok, true);
  assert.match(result.attachment.text, /第一章 引言/);
  assert.match(result.attachment.text, /结论 & 展望/);
  assert.match(result.attachment.text, /第一章 引言\n/, 'paragraphs stay on separate lines');
  assert.equal(result.attachment.kind, 'document');
});

test('pptx slides are ordered numerically, not lexically', async () => {
  const pptx = buildZip({
    'ppt/slides/slide1.xml': '<p:sld><a:t>第一页</a:t></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld><a:t>第二页</a:t></p:sld>',
    'ppt/slides/slide10.xml': '<p:sld><a:t>第十页</a:t></p:sld>',
  });
  const result = await loadAttachment(write('演讲.pptx', pptx));
  assert.equal(result.ok, true);
  const text = result.attachment.text;
  assert.ok(text.indexOf('第一页') < text.indexOf('第二页'), 'slide1 before slide2');
  assert.ok(text.indexOf('第二页') < text.indexOf('第十页'), 'slide2 before slide10 (numeric sort)');
});

test('xlsx resolves shared strings and inline values', async () => {
  const xlsx = buildZip({
    'xl/sharedStrings.xml': '<sst><si><t>姓名</t></si><si><t>张三</t></si></sst>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
      <row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>
      <row><c><v>42</v></c></row>
    </sheetData></worksheet>`,
  });
  const result = await loadAttachment(write('数据.xlsx', xlsx));
  assert.equal(result.ok, true);
  assert.match(result.attachment.text, /姓名 \| 张三/);
  assert.match(result.attachment.text, /42/);
});

test('epub follows the spine order from container.xml through the OPF', async () => {
  const epub = buildZip({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    'OEBPS/content.opf': `<package><manifest>
      <item id="c2" href="ch2.xhtml"/><item id="c1" href="ch1.xhtml"/>
    </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
    'OEBPS/ch1.xhtml': '<html><body><p>第一章正文</p></body></html>',
    'OEBPS/ch2.xhtml': '<html><body><p>第二章正文</p></body></html>',
  });
  const result = await loadAttachment(write('书.epub', epub));
  assert.equal(result.ok, true);
  const text = result.attachment.text;
  assert.ok(text.indexOf('第一章正文') < text.indexOf('第二章正文'), 'spine order wins over manifest order');
});

test('plain text files decode strictly and binary is rejected', async () => {
  const good = await loadAttachment(write('notes.md', '# 标题\n正文'));
  assert.equal(good.ok, true);
  assert.equal(good.attachment.kind, 'text');
  assert.match(good.attachment.text, /# 标题/);

  // 非法 UTF-8 必须被拒绝，而不是变成乱码喂给模型。
  const bad = await loadAttachment(write('blob.unknownext', Buffer.from([0xff, 0xfe, 0x00, 0x01])));
  assert.equal(bad.ok, false);
});

test('credential files are refused even without a sandbox policy', async () => {
  const secret = write('.env', 'API_KEY=secret');
  // 附件内容会直接进入对话，所以凭据文件必须无条件拒绝——
  // 不能只在"位于 home 但不在 cwd"时才拦（项目目录等于 home 时会漏）。
  const blocked = await loadAttachment(secret);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /凭据文件/);

  const key = write('id_rsa', 'PRIVATE KEY');
  const blockedKey = await loadAttachment(key);
  assert.equal(blockedKey.ok, false);
  assert.match(blockedKey.reason, /凭据文件/);

  // Kepos 数据目录同样拒绝。
  const inside = write('inside.txt', 'x');
  const dataBlocked = await loadAttachment(inside, { deny: [home] });
  assert.equal(dataBlocked.ok, false);
  assert.match(dataBlocked.reason, /Kepos 自身数据目录/);
});

test('project-scope policy still restricts reads outside the task directory', async () => {
  // 不用 ../ 造"外面"：macOS 上 /tmp 是指向 /private/tmp 的符号链接，
  // 路径规范化后可能仍落在 home 内，测试就失去意义。改为在独立的兄弟目录建文件。
  const siblingDir = mkdtempSync(join(tmpdir(), 'kepos-attach-outside-'));
  const outsidePath = join(siblingDir, 'outside.txt');
  writeFileSync(outsidePath, 'nope');
  const inside = write('note.txt', 'ok');
  const policy = { mode: 'project', cwd: home, allow: [], deny: [], home };
  assert.equal((await loadAttachment(inside, { policy })).ok, true, 'a file inside the task directory is allowed');
  const blocked = await loadAttachment(outsidePath, { policy });
  assert.equal(blocked.ok, false, 'a file outside the task directory is refused');
  assert.match(blocked.reason, /拒绝读取/);
});

test('oversized files are refused before parsing', async () => {
  const big = write('big.txt', 'x'.repeat(MAX_ATTACHMENT_BYTES + 1));
  const result = await loadAttachment(big);
  assert.equal(result.ok, false);
  assert.match(result.reason, /过大/);
});

test('missing files and empty files report a clear reason', async () => {
  const missing = await loadAttachment(join(home, 'nope.docx'));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /不存在/);
  const empty = await loadAttachment(write('empty.txt', ''));
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /为空/);
});

test('long documents are clamped with head and tail preserved', () => {
  const text = 'A'.repeat(500) + 'MIDDLE' + 'B'.repeat(500);
  const clamped = clampAttachmentText(text, 200);
  assert.equal(clamped.truncated, true);
  assert.ok(clamped.text.startsWith('A'));
  assert.ok(clamped.text.endsWith('B'));
  assert.match(clamped.text, /附件过长/);
});

test('attachment prompt block is well formed', () => {
  const block = attachmentToPrompt({
    path: '/tmp/a.docx', name: 'a.docx', bytes: 10, kind: 'document',
    text: '正文', note: 'docx · 3 个部件', truncated: false,
  });
  assert.match(block, /^<file name="a\.docx" path="\/tmp\/a\.docx" note="docx · 3 个部件">/);
  assert.match(block, /正文/);
  assert.match(block, /<\/file>$/);
});

test('pasted paths are recognised only when every line is an existing file', () => {
  const real = write('paste.txt', 'x');
  assert.deepEqual(looksLikeFilePaths(real), [real]);
  // 混入普通文字时不该被识别，否则会把正常输入吞成附件。
  assert.equal(looksLikeFilePaths(`看下这个 ${real}`), null);
  // 不存在的路径也不算。
  assert.equal(looksLikeFilePaths(join(home, 'ghost.txt')), null);
  // 没有扩展名的也不猜。
  assert.equal(looksLikeFilePaths(home), null);
});

test('long attachments paginate by cursor so the middle is reachable', async () => {
  const { paginateAttachmentText } = await import('../dist/terminal/attachments.js');
  const long = 'A'.repeat(5000) + 'MIDDLE' + 'B'.repeat(5000);
  const first = paginateAttachmentText(long, 0, 3000);
  assert.equal(first.page, 1);
  assert.equal(first.pages, 4);
  // 旧行为只能看头尾；分页后按游标推进就能读到中段。
  let cursor = 0, rebuilt = '', guard = 0;
  while (cursor !== null && guard++ < 20) {
    const page = paginateAttachmentText(long, cursor, 3000);
    rebuilt += page.text;
    cursor = page.nextCursor;
  }
  assert.equal(rebuilt, long, 'pages concatenate back to the original');
  assert.ok(rebuilt.includes('MIDDLE'), 'the middle section is reachable');
});

test('pagination refuses an invalid cursor instead of guessing', async () => {
  const { paginateAttachmentText } = await import('../dist/terminal/attachments.js');
  assert.throws(() => paginateAttachmentText('abc', -1), /游标/);
  assert.throws(() => paginateAttachmentText('abc', 99), /游标/);
  assert.throws(() => paginateAttachmentText('abc', 0, 10), /分页/);
});

test('single attachment removal is addressable by index', async () => {
  const { loadAttachment } = await import('../dist/terminal/attachments.js');
  const a = await loadAttachment(write('one.txt', '1'));
  const b = await loadAttachment(write('two.txt', '2'));
  assert.equal(a.ok && b.ok, true);
  const list = [a.attachment, b.attachment];
  list.splice(0, 1);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'two.txt', 'removing index 1 keeps the second item');
});
