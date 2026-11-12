import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';

const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.kepos', '.ssh', '.aws', '.azure', '.docker', '.gnupg', '.kube', '.gcloud',
  'node_modules', 'appdata', 'application data', 'library', 'program files', 'program files (x86)',
  '$recycle.bin', 'system volume information', 'windows', 'system32', '.cache', '.npm', '.codex',
]);
const MAX_ENTRIES = 30_000;
const MAX_DEPTH = 8;

type FileScope = { mode: 'project' | 'machine'; cwd: string; home: string; allow: string[] };

function defaultRoots(scope: FileScope): string[] {
  if (scope.mode !== 'machine') return [scope.cwd, ...scope.allow];
  const home = scope.home || homedir();
  return [scope.cwd, join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads'), join(home, 'OneDrive'),
    join(home, 'OneDrive', 'Desktop'), join(home, 'OneDrive', 'Documents'), home];
}

function queryTerms(query: string): { terms: string[]; resume: boolean } {
  const text = query.toLowerCase().replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  const resume = /简历|履历|resume|curriculum\s+vitae|\bcv\b/i.test(text);
  const remainder = text.replace(/简历|履历|curriculum\s+vitae|resume|\bcv\b|文件|文档|file|document|我的|my/gi, ' ').trim();
  const terms = remainder.split(/[\s,，、;；]+/).filter(term => term.length > 1);
  return { terms, resume };
}

function matchesName(name: string, query: string): boolean {
  const lower = name.toLowerCase();
  const { terms, resume } = queryTerms(query);
  if (resume && !/(简历|履历|resume|curriculum|\bcv\b)/i.test(lower)) return false;
  if (terms.length) return terms.every(term => lower.includes(term));
  return resume;
}

/** Register an OS-independent filename locator. It lists names only; reading remains a separate authorized action. */
export function registerFileSearchTool(pi: any, scope: FileScope, canRead: (path: string) => string | null) {
  pi.registerTool({
    name: 'kepos_find_file',
    label: '定位本地文件',
    description: '跨 Windows/macOS/Linux 按文件名查找本地文件，不依赖 Bash、fd 或 ripgrep。用于“打开简历”“找某个文档”等本地文件请求。先定位，再用 kepos_attach 读取结果；本工具只返回文件名、路径、大小与修改时间，不读文件内容。默认在当前项目和当前授权范围内搜索；机器范围会查用户的 Desktop/Documents/Downloads/OneDrive。被权限范围拒绝时先报告具体限制，不要猜路径或伪称本机无命令行。支持指定不超过 8 个搜索目录。',
    parameters: Type.Object({
      query: Type.String({ maxLength: 160, description: '文件名关键词，例如“简历”“resume”或“张三 简历”' }),
      paths: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }), { minItems: 1, maxItems: 8, description: '可选搜索目录；相对路径以当前项目为基准，且必须在任务读取授权范围内' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id: string, params: any) {
      const query = String(params.query || '').trim();
      if (!query) throw Error('请提供要查找的文件名关键词');
      const roots = [...new Set<string>((Array.isArray(params.paths) && params.paths.length
        ? params.paths.map((value: unknown) => isAbsolute(String(value)) ? resolve(String(value)) : resolve(scope.cwd, String(value)))
        : defaultRoots(scope)).map((path: string) => resolve(path)))];
      const blocked = roots.map(path => ({ path, reason: canRead(path) })).filter(item => item.reason);
      const allowedRoots = roots.filter(path => !canRead(path));
      if (!allowedRoots.length) throw Error(`没有可搜索的已授权目录。${blocked.map(item => `${item.path}: ${item.reason}`).join('；')}`);

      const found: Array<{ name: string; path: string; bytes: number; modifiedAt: string }> = [];
      const errors: string[] = blocked.map(item => `${item.path}: ${item.reason}`);
      const queue = allowedRoots.map(path => ({ path, depth: 0 }));
      const seenRoots = new Set<string>();
      let scanned = 0;
      const targetCount = Math.max(1, Math.min(20, Number(params.limit) || 10));

      while (queue.length && scanned < MAX_ENTRIES && found.length < targetCount) {
        const current = queue.shift()!;
        if (seenRoots.has(current.path)) continue;
        seenRoots.add(current.path);
        let entries;
        try { entries = await readdir(current.path, { withFileTypes: true }); }
        catch (error) {
          if (current.depth === 0) errors.push(`${current.path}: ${(error as NodeJS.ErrnoException).code || '无法读取'}`);
          continue;
        }
        for (const entry of entries) {
          if (++scanned >= MAX_ENTRIES || found.length >= targetCount) break;
          const path = join(current.path, entry.name);
          if (entry.isSymbolicLink() || canRead(path)) continue;
          if (entry.isDirectory()) {
            const lower = entry.name.toLowerCase();
            if (current.depth < MAX_DEPTH && !entry.name.startsWith('.') && !IGNORED_DIRECTORIES.has(lower)) queue.push({ path, depth: current.depth + 1 });
            continue;
          }
          if (!entry.isFile() || !matchesName(entry.name, query)) continue;
          try {
            const info = await stat(path);
            found.push({ name: entry.name, path, bytes: info.size, modifiedAt: info.mtime.toISOString() });
          } catch { /* a file may disappear during a search */ }
        }
      }
      const normalizedQuery = query.toLowerCase();
      found.sort((a, b) => Number(!a.name.toLowerCase().includes(normalizedQuery)) - Number(!b.name.toLowerCase().includes(normalizedQuery)));
      const result = { query, roots: allowedRoots, scannedEntries: scanned, truncated: scanned >= MAX_ENTRIES, results: found,
        ...(errors.length ? { skipped: errors.slice(0, 12) } : {}),
        note: found.length ? '文件名定位结果；尚未读取内容。选定目标后用 kepos_attach 读取。' : '没有在已授权目录中找到匹配文件；检查 skipped，并在需要时请求更宽的搜索目录。' };
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
