export interface ResultPageOptions {
    cursor?: number;
    maxChars?: number;
    summaryOnly?: boolean;
}
export function outputPage(value: unknown, options: ResultPageOptions = {}) {
    const text = String(value ?? '');
    const cursor = options.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > text.length)
        throw Error('Invalid result cursor');
    const requested = options.maxChars ?? (options.summaryOnly === false ? 6000 : 1600);
    if (!Number.isSafeInteger(requested) || requested < 1)
        throw Error('Invalid result page size');
    const size = Math.max(2, Math.min(requested, 6000));
    if (cursor > 0 && /[\uDC00-\uDFFF]/.test(text[cursor]) && /[\uD800-\uDBFF]/.test(text[cursor - 1]))
        throw Error('Result cursor splits a character');
    let end = Math.min(text.length, cursor + size);
    // JSON can escape lone surrogates, but result pages should never split a character.
    if (end < text.length && end > cursor && /[\uD800-\uDBFF]/.test(text[end - 1]))
        end--;
    const output = text.slice(cursor, end);
    return { output, cursor, nextCursor: end < text.length ? end : null, totalCharacters: text.length, hasMore: end < text.length, kind: cursor === 0 && options.summaryOnly !== false ? 'excerpt' : 'evidence' };
}
export function receiptView(receipt: any, options: ResultPageOptions = {}) {
    if (!receipt || typeof receipt.output !== 'string')
        return receipt;
    // 摘要优先：代表按输出契约以「## 结论 / ## 证据 / ## 置信度 / ## 需要」收尾。
    // 主 Agent 默认只需要这一段，完整过程按 cursor 翻页读取——否则转录全文会
    // 挤占父会话上下文，而其中大部分是中间过程。
    const structured = options.cursor ? null : extractStructuredSummary(receipt.output);
    const page = structured && options.maxChars === undefined
        ? { output: structured, cursor: 0, nextCursor: null, totalCharacters: receipt.output.length, hasMore: true, kind: 'summary' }
        : outputPage(receipt.output, options);
    return { version: receipt.version, workerId: receipt.workerId, parentSessionId: receipt.parentSessionId, state: receipt.state,
        started: receipt.started, ended: receipt.ended, error: receipt.error, resultHash: receipt.resultHash,
        profileRevision: receipt.profileRevision, outputTruncated: receipt.outputTruncated, usage: receipt.usage, ...page };
}
/**
 * 从产出末尾抽出结构化摘要（四个约定标题）。
 * 找不到就返回 null，调用方回退到普通分页——绝不因为格式不合预期而丢掉产出。
 */
export function extractStructuredSummary(output: string): string | null {
    const text = String(output ?? '');
    const at = text.lastIndexOf('## 结论');
    if (at < 0) return null;
    const summary = text.slice(at).trim();
    // 摘要至少要有结论段才算有效；只有标题说明模型没按契约写。
    return summary.length > '## 结论'.length + 1 ? summary : null;
}
