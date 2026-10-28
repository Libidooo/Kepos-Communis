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
    return { version: receipt.version, workerId: receipt.workerId, parentSessionId: receipt.parentSessionId, state: receipt.state,
        started: receipt.started, ended: receipt.ended, error: receipt.error, resultHash: receipt.resultHash,
        profileRevision: receipt.profileRevision, outputTruncated: receipt.outputTruncated, usage: receipt.usage, ...outputPage(receipt.output, options) };
}
