// 附件读取：Kepos 自己实现，不依赖任何第三方解析库。
//
// 覆盖范围（全部用 Node 内置能力）：
//   docx / pptx / xlsx / epub / zip  → 手写 ZIP 中央目录解析 + zlib.inflateRawSync
//   png / jpg / gif / webp / bmp     → 交给 Pi 公开导出的 MIME 侦测 + 缩放
//   pdf                              → 可选依赖 pdfjs-dist（装了精确提取，没装明确告知）
//   纯文本 / 源码 / json / csv 等     → 直接读取，带 UTF-8 严格校验
//
// 安全边界：凭据目录一律拒绝、Kepos 自身数据目录拒绝、单文件 8 MiB 上限。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { detectSupportedImageMimeTypeFromFile, resizeImage } from '@earendil-works/pi-coding-agent';
import { readDenied, type SandboxPolicy } from './worker-sandbox.ts';
import { truncateMiddle } from './presentation.ts';

/** 单文件读取上限，与 worker-contract 的 MAX_OUTPUT_BYTES 保持一致。 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** 解压后上限：防 deflate 炸弹（实测 50MB 可压到 51KB）。 */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
/** 交给模型的正文上限；超出保留头尾并标注。 */
export const MAX_ATTACHMENT_TEXT = 120_000;

export type AttachmentKind = 'image' | 'text' | 'document';
export type Attachment = {
  path: string;
  name: string;
  bytes: number;
  kind: AttachmentKind;
  /** 图片的 base64（仅 kind==='image'）。 */
  data?: string;
  mimeType?: string;
  /** 文本类附件的正文（仅 kind==='text'|'document'）。 */
  text?: string;
  /** 提取时的说明：页数、条目数、是否截断、失败原因。 */
  note?: string;
  truncated?: boolean;
};
export type AttachmentResult = { ok: true; attachment: Attachment } | { ok: false; reason: string };
/**
 * 收窄辅助。tsconfig 是 strict: false，TypeScript 不肯在 await 结果上按 !ok 收窄，
 * 所以必须用显式的类型谓词，否则每个调用方都要写 as 断言。
 */
export function isAttached(result: AttachmentResult): result is { ok: true; attachment: Attachment } {
  return result.ok === true;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.log', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift', '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.sql', '.graphql', '.proto', '.tex', '.rst', '.diff', '.patch', '.env.example',
]);

// ── ZIP 读取器 ────────────────────────────────────────────────────────────
// 只实现 Office / EPUB 实际会用到的子集：方法 0（store）与 8（deflate），
// 拒绝 ZIP64 与加密条目。中央目录是权威来源，本地头只用来推算数据起点。
const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

type ZipEntry = { name: string; method: number; compressedSize: number; size: number; localOffset: number };

/** 从 ZIP 缓冲区列出条目。抛错表示文件损坏或使用了不支持的特性。 */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  // EOCD 在文件尾部，可能有最长 65535 字节的注释，因此反向扫描。
  const scanFrom = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw Error('不是有效的 ZIP 容器（找不到中央目录结尾）');
  // ZIP64 需要额外的偏移表，Office 文件不会用到；明确拒绝而不是猜。
  for (let i = eocd - 20; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === ZIP64_LOCATOR_SIG) throw Error('暂不支持 ZIP64 格式的压缩包');
  }
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) throw Error('ZIP 中央目录偏移越界');
  const entries: ZipEntry[] = [];
  let offset = cdOffset;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length) throw Error('ZIP 中央目录被截断');
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) throw Error('ZIP 中央目录条目签名无效');
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (flags & 0x0001) throw Error('不支持加密的 ZIP 条目');
    // 目录条目以 / 结尾，没有内容。
    if (!name.endsWith('/')) entries.push({ name, method, compressedSize, size, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解出单个条目的内容。 */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localOffset;
  if (at + 30 > buf.length) throw Error('ZIP 本地头越界');
  if (buf.readUInt32LE(at) !== LOCAL_SIG) throw Error('ZIP 本地头签名无效');
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const start = at + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw Error('ZIP 条目数据越界');
  const raw = buf.subarray(start, end);
  // 方法 0 是存储（EPUB 的 mimetype 条目按规范必须如此），直接切片。
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method !== 8) throw Error(`不支持的压缩方式 ${entry.method}`);
  // 解压上限取"声明大小 × 64"与硬上限的较小值：正常文档的压缩比远低于 64，
  // 而 deflate 炸弹可达 1000:1，这道闸保证它无法撑爆内存。
  return inflateRawSync(raw, { maxOutputLength: Math.min(MAX_INFLATED_BYTES, Math.max(entry.size, 1) * 64) });
}

/** 便捷：按名字取条目文本。 */
function entryText(buf: Buffer, entries: ZipEntry[], name: string): string | undefined {
  const entry = entries.find(item => item.name === name);
  if (!entry) return undefined;
  return readZipEntry(buf, entry).toString('utf8');
}

// ── XML 文本提取 ──────────────────────────────────────────────────────────
/** 正则元字符转义：分段标签里的 `:` 与可能的特殊字符不能直接拼进正则。 */
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 剥离标签但不吞掉文字：先把段落/行级标签换成换行，再解实体、去标签。 */
export function xmlToText(xml: string, blockTags: string[] = ['w:p', 'a:p']): string {
  let text = xml;
  for (const tag of blockTags) {
    text = text.replace(new RegExp(`</${escapeRegExp(tag)}>`, 'gi'), '\n');
  }
  text = text
    .replace(/<w:br\s*\/>/gi, '\n')
    .replace(/<w:tab\s*\/>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
  // 合并多余空行，但保留段落分隔。
  return text.split('\n').map(line => line.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── 各格式提取器 ──────────────────────────────────────────────────────────

function extractDocx(buf: Buffer): { text: string; note: string } {
  const entries = listZipEntries(buf);
  const body = entryText(buf, entries, 'word/document.xml');
  if (!body) throw Error('docx 缺少 word/document.xml');
  return { text: xmlToText(body), note: `docx · ${entries.length} 个部件` };
}

function extractPptx(buf: Buffer): { text: string; note: string } {
  const entries = listZipEntries(buf);
  // 幻灯片必须按数字排序：slide2 在 slide10 之前。
  const slides = entries
    .filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => Number(a.name.match(/(\d+)\.xml$/)?.[1] || 0) - Number(b.name.match(/(\d+)\.xml$/)?.[1] || 0));
  if (!slides.length) throw Error('pptx 中没有幻灯片');
  const parts = slides.map((entry, index) => {
    const xml = readZipEntry(buf, entry).toString('utf8');
    const runs = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map(match => match[1]);
    const cleaned = runs.join(' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return `— 第 ${index + 1} 页 —\n${cleaned}`.trim();
  });
  return { text: parts.join('\n\n'), note: `pptx · ${slides.length} 页` };
}

function extractXlsx(buf: Buffer): { text: string; note: string } {
  const entries = listZipEntries(buf);
  const sharedXml = entryText(buf, entries, 'xl/sharedStrings.xml') || '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match =>
    [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  const sheets = entries
    .filter(entry => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((a, b) => Number(a.name.match(/(\d+)\.xml$/)?.[1] || 0) - Number(b.name.match(/(\d+)\.xml$/)?.[1] || 0));
  if (!sheets.length) throw Error('xlsx 中没有工作表');
  const lines: string[] = [];
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const xml = readZipEntry(buf, sheet).toString('utf8');
    lines.push(`— 工作表 ${sheetIndex + 1} —`);
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1];
        const value = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
        const inline = cell[2].match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
        const isShared = /\bt="s"/.test(attrs);
        const resolved = inline || (isShared ? (shared[Number(value)] ?? '') : value);
        if (resolved) cells.push(resolved.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
      }
      if (cells.length) lines.push(cells.join(' | '));
    }
    lines.push('');
  }
  return { text: lines.join('\n').trim(), note: `xlsx · ${sheets.length} 个工作表 · ${shared.length} 条共享字符串` };
}

function extractEpub(buf: Buffer): { text: string; note: string } {
  const entries = listZipEntries(buf);
  const container = entryText(buf, entries, 'META-INF/container.xml');
  if (!container) throw Error('epub 缺少 META-INF/container.xml');
  const opfPath = container.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw Error('epub 的 container.xml 未指向 OPF');
  const opf = entryText(buf, entries, decodeURIComponent(opfPath));
  if (!opf) throw Error('epub 的 OPF 缺失');
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map<string, string>();
  for (const item of opf.matchAll(/<item\s[^>]*>/g)) {
    const id = item[0].match(/\bid="([^"]+)"/)?.[1];
    const href = item[0].match(/\bhref="([^"]+)"/)?.[1];
    if (id && href) manifest.set(id, decodeURIComponent(href));
  }
  // spine 定义阅读顺序，比文件名排序可靠。
  const order = [...opf.matchAll(/<itemref\s[^>]*idref="([^"]+)"/g)].map(match => manifest.get(match[1])).filter((href): href is string => !!href);
  const chapters = order.length ? order : [...manifest.values()].filter(href => /\.x?html?$/i.test(href));
  const texts: string[] = [];
  for (const href of chapters) {
    const xml = entryText(buf, entries, baseDir + href);
    if (!xml) continue;
    const body = xml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? xml;
    const cleaned = xmlToText(body.replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n'), ['p']);
    if (cleaned) texts.push(cleaned);
  }
  if (!texts.length) throw Error('epub 中没有可读章节');
  return { text: texts.join('\n\n'), note: `epub · ${texts.length} 章` };
}

function extractZipListing(buf: Buffer): { text: string; note: string } {
  const entries = listZipEntries(buf);
  const lines = entries.map(entry => `${entry.name}  (${entry.size} B)`);
  // 压缩包本身没有正文，给出清单；其中文本类成员顺带提取前几段。
  const textMembers = entries.filter(entry => TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())).slice(0, 5);
  const excerpts: string[] = [];
  for (const entry of textMembers) {
    try {
      const body = readZipEntry(buf, entry).toString('utf8');
      const head = body.split('\n').slice(0, 40).join('\n');
      if (head.trim()) excerpts.push(`— ${entry.name}（前 40 行）—\n${head}`);
    } catch { /* 单个成员读取失败不影响整体清单 */ }
  }
  return {
    text: [`压缩包内含 ${entries.length} 项：`, ...lines, ...(excerpts.length ? ['', ...excerpts] : [])].join('\n'),
    note: `zip · ${entries.length} 项`,
  };
}

/** PDF：走可选依赖。装了 pdfjs-dist 就精确提取，没装就明确告知，绝不返回假文本。 */
async function extractPdf(buf: Buffer): Promise<{ text: string; note: string }> {
  let pdfjs: any;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as string);
  } catch {
    try { pdfjs = await import('pdfjs-dist' as string); }
    catch { throw Error('PDF 需要解析器：请安装 pdfjs-dist（npm i pdfjs-dist）后重试'); }
  }
  const getDocument = pdfjs.getDocument || pdfjs.default?.getDocument;
  if (!getDocument) throw Error('pdfjs-dist 版本不支持 getDocument');
  const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: false, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let page = 1; page <= doc.numPages; page++) {
    const content = await (await doc.getPage(page)).getTextContent();
    const line = content.items.map((item: any) => item.str ?? '').join('').replace(/\s+/g, ' ').trim();
    pages.push(`— 第 ${page} 页 —\n${line}`);
  }
  const total = doc.numPages;
  await doc.destroy?.();
  return { text: pages.join('\n\n'), note: `pdf · ${total} 页` };
}

// ── 对外入口 ──────────────────────────────────────────────────────────────

/** 把超长文本收敛到预算内，保留头尾并标注截断。 */
export function clampAttachmentText(text: string, max = MAX_ATTACHMENT_TEXT): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  // 与 boundedText 共用同一截断算法，只有提示语不同。
  return {
    text: truncateMiddle(text, max, '\n\n… [附件过长，中间已省略；用 kepos_attach 的 cursor 读取后续段落] …\n\n', 0.7),
    truncated: true,
  };
}

/**
 * 附件分页：超长附件按段读取，替代"只有头尾"的旧行为。
 * 返回该段的正文与下一段的游标；游标为 null 表示读到末尾。
 * 游标按字符计，切点会避开代理对，防止把 emoji / 生僻字劈成两半。
 */
export function paginateAttachmentText(
  text: string,
  cursor = 0,
  pageSize = MAX_ATTACHMENT_TEXT,
): { text: string; cursor: number; nextCursor: number | null; total: number; page: number; pages: number } {
  const total = text.length;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > total) throw Error('无效的附件游标');
  if (!Number.isSafeInteger(pageSize) || pageSize < 256) throw Error('无效的分页大小');
  // 游标落在代理对中间时前移一位，保证不劈开字符。
  if (cursor > 0 && /[\uDC00-\uDFFF]/.test(text[cursor]) && /[\uD800-\uDBFF]/.test(text[cursor - 1])) cursor -= 1;
  let end = Math.min(total, cursor + pageSize);
  if (end < total && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  return {
    text: text.slice(cursor, end),
    cursor,
    nextCursor: end < total ? end : null,
    total,
    page: Math.floor(cursor / pageSize) + 1,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * 读取一个附件。
 * @param rawPath 用户给出的路径（支持 ~ 展开与相对路径，相对路径按 cwd 解析）
 * @param options.policy 读取策略：复用 worker-sandbox 的凭据与目录白名单
 * @param options.deny 额外拒绝的目录（通常是 Kepos 数据目录）
 */
export async function loadAttachment(
  rawPath: string,
  options: { policy?: SandboxPolicy; deny?: string[]; cwd?: string } = {},
): Promise<AttachmentResult> {
  const trimmed = String(rawPath || '').trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return { ok: false, reason: '路径为空' };
  const base = options.cwd || process.cwd();
  const expanded = trimmed.startsWith('~') ? resolve(process.env.HOME || process.env.USERPROFILE || '', trimmed.slice(1)) : trimmed;
  const target = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);

  // 1) 安全边界：凭据目录与额外禁止目录。
  // 附件比子 Agent 读取更敏感——内容会直接进入对话上下文——因此凭据文件名
  // 在这里无条件拒绝。worker-sandbox 的 readDenied 只在"位于 home 但不在 cwd"时
  // 拦截，若项目目录恰好等于 home 就会漏放 .env，这里补上这道闸。
  const basename = target.split(/[\\/]/).pop()?.toLowerCase() || '';
  const segments = target.toLowerCase().split(/[\\/]/);
  const credentialNames = ['auth.json', 'credentials', 'id_rsa', '.env', '.env.local', '.npmrc', '.netrc', '.pypirc'];
  const credentialDirs = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.gcloud'];
  if (credentialNames.includes(basename)) {
    return { ok: false, reason: `拒绝读取凭据文件：${basename}（附件内容会进入对话，不允许携带密钥）` };
  }
  if (credentialDirs.some(dir => segments.includes(dir))) {
    return { ok: false, reason: '拒绝读取凭据目录' };
  }
  if (options.policy) {
    const denied = readDenied(target, options.policy);
    if (denied) return { ok: false, reason: `拒绝读取：${denied}` };
  }
  for (const banned of options.deny || []) {
    if (banned && resolve(target).toLowerCase().startsWith(resolve(banned).toLowerCase())) {
      return { ok: false, reason: '拒绝读取 Kepos 自身数据目录' };
    }
  }
  // 2) 存在性与大小。
  if (!existsSync(target)) return { ok: false, reason: `文件不存在：${target}` };
  const stat = statSync(target);
  if (!stat.isFile()) return { ok: false, reason: '不是普通文件（目录请指定具体文件）' };
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, reason: `文件过大（${(stat.size / 1048576).toFixed(1)} MiB，上限 ${MAX_ATTACHMENT_BYTES / 1048576} MiB）` };
  }
  if (stat.size === 0) return { ok: false, reason: '文件为空' };

  const extension = extname(target).toLowerCase();
  const name = target.split(/[\\/]/).pop() || target;

  // 3) 图片：交给 Pi 的公开能力处理（含缩放与格式校验）。
  try {
    const mime = await detectSupportedImageMimeTypeFromFile(target);
    if (mime) {
      const bytes = readFileSync(target);
      const resized = await resizeImage(bytes, mime, { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024, jpegQuality: 85 });
      if (resized) {
        return { ok: true, attachment: { path: target, name, bytes: stat.size, kind: 'image', data: Buffer.from(resized.data).toString('base64'), mimeType: resized.mimeType, note: '图片已按模型分辨率上限压缩' } };
      }
    }
  } catch { /* 不是图片就继续按文档处理 */ }

  const buf = readFileSync(target);

  // 4) 文档：按扩展名 + 魔数双重判断。
  try {
    let extracted: { text: string; note: string } | undefined;
    if (extension === '.pdf' || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
      extracted = await extractPdf(buf);
    } else if (extension === '.docx') extracted = extractDocx(buf);
    else if (extension === '.pptx') extracted = extractPptx(buf);
    else if (extension === '.xlsx') extracted = extractXlsx(buf);
    else if (extension === '.epub') extracted = extractEpub(buf);
    else if (extension === '.zip' || (buf.length > 4 && buf.readUInt32LE(0) === LOCAL_SIG && !TEXT_EXTENSIONS.has(extension))) {
      extracted = extractZipListing(buf);
    }
    if (extracted) {
      const clamped = clampAttachmentText(extracted.text);
      return {
        ok: true,
        attachment: {
          path: target, name, bytes: stat.size, kind: 'document',
          text: clamped.text, note: extracted.note, truncated: clamped.truncated,
        },
      };
    }
  } catch (error: any) {
    return { ok: false, reason: `${name} 解析失败：${error?.message || error}` };
  }

  // 5) 纯文本：严格 UTF-8 校验，避免把二进制当文本喂给模型。
  if (TEXT_EXTENSIONS.has(extension) || !extension) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      const clamped = clampAttachmentText(text);
      return { ok: true, attachment: { path: target, name, bytes: stat.size, kind: 'text', text: clamped.text, note: '文本文件', truncated: clamped.truncated } };
    } catch {
      return { ok: false, reason: `${name} 不是有效的 UTF-8 文本` };
    }
  }

  return { ok: false, reason: `不支持的附件类型 ${extension || '(无扩展名)'}` };
}

/** 把附件渲染成注入正文的文本块，格式与 Pi 的 @file 约定一致。 */
export function attachmentToPrompt(attachment: Attachment): string {
  const header = `<file name="${attachment.name}" path="${attachment.path}"${attachment.note ? ` note="${attachment.note}"` : ''}${attachment.truncated ? ' truncated="true"' : ''}>`;
  return `${header}\n${attachment.text || ''}\n</file>`;
}

/** 判断一段文本是否"整段都是存在的文件路径"——用于粘贴自动识别。 */
export function looksLikeFilePaths(text: string, cwd?: string): string[] | null {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 4000) return null;
  // 逐行/逐段拆分：支持一行一个路径，或引号包裹的含空格路径。
  const candidates = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!candidates.length || candidates.length > 20) return null;
  const resolved: string[] = [];
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/^["']|["']$/g, '');
    // 必须有扩展名，避免把普通句子里的斜杠当成路径。
    if (!/[\\/]/.test(cleaned) && !/^[a-zA-Z]:/.test(cleaned)) return null;
    if (!/\.[a-zA-Z0-9]{1,8}$/.test(cleaned)) return null;
    const target = isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd || process.cwd(), cleaned);
    if (!existsSync(target)) return null;
    resolved.push(target);
  }
  return resolved;
}
