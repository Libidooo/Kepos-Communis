import type { OrbitalDatabase } from './database.ts';
export interface WorkerEventQuery {
    cursor?: number;
    parentSessionId?: string;
    cwd?: string;
    limit?: number;
}
export interface WorkerEvent {
    seq: number;
    workerId: string;
    parentSessionId: string;
    cwd: string;
    type: string;
    created: number;
    payload: Record<string, unknown>;
}
export interface WorkerEventPage {
    events: WorkerEvent[];
    nextCursor: number;
    hasMore: boolean;
}
const SAFE_KEYS = new Set(['state', 'tool', 'reason', 'checkpoint', 'queueState', 'profileRevision', 'outputTruncated', 'queueWaitMs', 'resultHash', 'checkpointAt']);
function safePayload(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
        if (SAFE_KEYS.has(key) && (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null))
            result[key] = item;
    return result;
}
export function readWorkerEvents(database: OrbitalDatabase, query: WorkerEventQuery = {}): WorkerEventPage {
    if (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor) || query.cursor < 0))
        throw Error('Invalid event cursor');
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 100)));
    const cursor = Math.max(0, Math.floor(query.cursor ?? 0));
    const clauses = ['e.seq>?'];
    const args: any[] = [cursor];
    if (query.parentSessionId) {
        clauses.push('w.parent=?');
        args.push(query.parentSessionId);
    }
    if (query.cwd) {
        clauses.push("json_extract(w.task,'$.cwd')=?");
        args.push(query.cwd);
    }
    args.push(limit + 1);
    const rows = database.prepare(`SELECT e.seq,e.worker_id,e.type,e.created,e.payload,w.parent,json_extract(w.task,'$.cwd') AS cwd FROM worker_events e JOIN workers w ON w.id=e.worker_id WHERE ${clauses.join(' AND ')} ORDER BY e.seq LIMIT ?`).all(...args) as any[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const events = page.map(row => ({ seq: Number(row.seq), workerId: String(row.worker_id), parentSessionId: String(row.parent), cwd: String(row.cwd || ''), type: String(row.type), created: Number(row.created), payload: safePayload(JSON.parse(row.payload || '{}')) }));
    return { events, nextCursor: events.length ? events[events.length - 1].seq : cursor, hasMore };
}
