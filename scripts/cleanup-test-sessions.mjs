// 一次性清理：删除除最新会话外的全部测试对话，并同步 SQLite 里的
// workspace.sessionLinks / workspace.drafts 与会话镜像表。
// 只动"对话"，不碰任务归档（~/.kepos/<uuid>/ 与 index.json 是记录官的地盘，永不自动删）。
import { readdirSync, statSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

const sessionsDir = join(homedir(), '.kepos', 'data', 'sessions');
const dbFile = join(homedir(), '.kepos', 'data', 'orbital.sqlite');
const files = readdirSync(sessionsDir).filter(name => name.endsWith('.jsonl'));
if (!files.length) { console.log('没有会话可清理'); process.exit(0); }
const withTime = files.map(name => ({ name, mtime: statSync(join(sessionsDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
const keep = withTime[0].name; // 最新的一份：多半是当前打开的议案
const remove = withTime.slice(1).map(item => item.name);
console.log(`保留最新：${keep}`);
console.log(`删除 ${remove.length} 个旧会话`);

const { KeposDatabase } = await import('../dist/terminal/database.js');
const db = new KeposDatabase(dbFile);
try {
  const workspace = db.get('workspace') || {};
  const removedSet = new Set(remove);
  const before = { links: Object.keys(workspace.sessionLinks || {}).length, drafts: Object.keys(workspace.drafts || {}).length };
  // sessionLinks 键是会话文件绝对路径；按文件名匹配删除。
  for (const key of Object.keys(workspace.sessionLinks || {})) {
    if (removedSet.has(basename(key))) delete workspace.sessionLinks[key];
  }
  // 草稿按 sessionKey（会话文件路径或会话 id）存；同样按文件名匹配。
  for (const key of Object.keys(workspace.drafts || {})) {
    if (removedSet.has(basename(key))) delete workspace.drafts[key];
  }
  db.set('workspace', workspace);
  console.log(`配置已同步：links ${before.links} -> ${Object.keys(workspace.sessionLinks || {}).length}，drafts ${before.drafts} -> ${Object.keys(workspace.drafts || {}).length}`);

  // 会话镜像：清掉指向已删会话的逻辑会话（表名探测，缺表就跳过）。
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const table of ['session_messages', 'sessions', 'session_generations']) {
    if (!tables.includes(table)) continue;
    try {
      if (table === 'session_messages' && tables.includes('sessions')) {
        db.prepare(`DELETE FROM ${table} WHERE session_id NOT IN (SELECT id FROM sessions)`).run();
      } else {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      console.log(`镜像表 ${table} 已清空（历史镜像随对话一并清理）`);
    } catch (error) { console.log(`镜像表 ${table} 跳过：${error.message}`); }
  }
  for (const name of remove) rmSync(join(sessionsDir, name));
  console.log(`文件已删除 ${remove.length} 个；剩余 ${readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl')).length} 个会话`);
} finally { db.close(); }
