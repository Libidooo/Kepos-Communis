import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { readDenied } = await import('../dist/terminal/worker-sandbox.js');
const { ARCHIVE_DIR } = await import('../dist/terminal/archive.js');

// 归档区必须对僚属不可读。
// 项目根的 .kepos 里存着同项目其他僚属的报告与代表的裁决；
// 只挡用户主目录的 dataRoot 不够——readScope=project 会把项目根的 .kepos 一起放行，
// 僚属因此能读到别人的结论，正是要禁止的互读。
test('the project archive directory is refused to workers', () => {
  const project = mkdtempSync(join(tmpdir(), 'kepos-iso-'));
  const home = mkdtempSync(join(tmpdir(), 'kepos-iso-home-'));
  const data = join(home, 'data', 'kepos');
  const archiveDir = join(project, ARCHIVE_DIR);
  mkdirSync(join(archiveDir, 'task-other'), { recursive: true });
  writeFileSync(join(archiveDir, 'task-other', 'report.md'), '## 结论\n别人的结论');

  // 生产代码传入的 deny 列表：用户数据目录 + 项目归档区。
  const policy = { mode: 'project', cwd: project, allow: [], deny: [data, archiveDir], home };

  const denied = readDenied(join(archiveDir, 'task-other', 'report.md'), policy);
  assert.ok(denied, 'reading another worker report must be refused');
  assert.match(String(denied), /Kepos 数据目录/);

  // 归档根自身也不可列。
  assert.ok(readDenied(archiveDir, policy), 'the archive root itself is refused');

  // 项目里的普通文件仍可读：隔离不能误伤正常工作。
  writeFileSync(join(project, 'src.ts'), 'export const a = 1');
  assert.equal(readDenied(join(project, 'src.ts'), policy), null, 'ordinary project files stay readable');
});

test('the archive directory name is a single well-known segment', () => {
  // 路径拼接依赖它不带分隔符，否则 join 出来的 deny 路径会错位。
  assert.equal(ARCHIVE_DIR, '.kepos');
  assert.equal(ARCHIVE_DIR.includes('/'), false);
  assert.equal(ARCHIVE_DIR.includes('\\'), false);
});
