import { createHash, randomUUID } from 'node:crypto';
import type { OrbitalDatabase } from './database.ts';
import { GraphStore } from './graph.ts';
import type { WorkerPool } from './workers.ts';
import { DEFAULT_TASK_SECONDS, HUMAN_APPROVAL_THRESHOLD_SECONDS, MAX_CONCURRENT_CHILDREN, READ_ONLY_TOOLS, MAX_TASK_SECONDS, profileRevision, type WorkerHandle } from './worker-contract.ts';
export type MissionState = 'QUEUED' | 'RUNNING' | 'PAUSED' | 'NEEDS_HUMAN' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type JobState = 'QUEUED' | 'RUNNING' | 'WAITING' | 'NEEDS_HUMAN' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export interface MissionJobInput {
    id?: string;
    agent: any;
    task: string;
    dependsOn?: string[];
    seconds?: number;
    requiresHuman?: boolean;
}
export interface MissionInput {
    id?: string;
    goal: string;
    cwd: string;
    parentSessionId: string;
    sessionFile?: string;
    jobs: MissionJobInput[];
    deadlineSeconds?: number;
}
export interface JobRecord {
    id: string;
    key: string;
    missionId: string;
    agent: any;
    task: string;
    dependsOn: string[];
    seconds: number;
    requiresHuman: boolean;
    state: JobState;
    handle?: WorkerHandle;
    output?: string;
    error?: string;
    started?: number;
    ended?: number;
    checkpoint?: string;
}
export interface MissionRecord {
    id: string;
    goal: string;
    cwd: string;
    parentSessionId: string;
    sessionFile?: string;
    state: MissionState;
    created: number;
    updated: number;
    deadline?: number;
    jobs: JobRecord[];
}
interface Owner {
    pid: number;
    epoch: string;
}
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const running = new Set(['QUEUED', 'STARTING', 'RUNNING', 'CANCEL_REQUESTED']);
function isAlive(pid: number): boolean { try {
    process.kill(pid, 0);
    return true;
}
catch (error: any) {
    return error.code === 'EPERM';
} }
function limitText(value: unknown, max = 4000): string { return String(value ?? '').slice(0, max); }
/** Durable plans coordinate bounded workers. No scheduler tick ever invokes a model itself. */
export type MissionWorkerPool = Pick<WorkerPool, 'launch' | 'result' | 'cancelHandle'> & Partial<Pick<WorkerPool, 'subscribe' | 'liveHandle'>>;

export class MissionScheduler {
    private timer?: ReturnType<typeof setInterval>;
    private unsubscribe?: () => void;
    private stopped = false;
    private ticking = false;
    private scheduled = false;
    private listeners = new Set<(event: any) => void>();
    private lastMission = '';
    private epoch = randomUUID();
    // Raw worker capabilities live only in the dispatching process; the database keeps
    // hashes so a leaked row does not hand out the live handle. A scheduler that lacks
    // the raw capability (restart, another process) recovers it via pool.liveHandle or
    // hands the step to a human instead of presenting a hash and failing authorization.
    private liveHandles = new Map<string, WorkerHandle>();
    private concurrency: number;
    readonly graph: GraphStore;
    lastError?: string;
    constructor(readonly database: OrbitalDatabase, readonly pool: MissionWorkerPool, readonly options: {
        concurrency?: number;
        tickMs?: number;
        missionIds?: string[];
    } = {}) {
        this.graph = new GraphStore(database);
        this.concurrency = Math.max(1, Math.min(MAX_CONCURRENT_CHILDREN, Math.floor(options.concurrency || MAX_CONCURRENT_CHILDREN)));
        this.database.sql.exec(`
   CREATE TABLE IF NOT EXISTS missions(id TEXT PRIMARY KEY,goal TEXT NOT NULL,cwd TEXT NOT NULL,parent TEXT NOT NULL,session_file TEXT,state TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,deadline INTEGER,meta TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS mission_jobs(id TEXT PRIMARY KEY,mission_id TEXT NOT NULL REFERENCES missions(id),agent TEXT NOT NULL,task TEXT NOT NULL,depends TEXT NOT NULL,seconds INTEGER NOT NULL,requires_human INTEGER NOT NULL,state TEXT NOT NULL,handle TEXT,output TEXT,error TEXT,checkpoint TEXT,started INTEGER,ended INTEGER);
   CREATE TABLE IF NOT EXISTS mission_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,mission_id TEXT NOT NULL,job_id TEXT,type TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS mission_jobs_mission ON mission_jobs(mission_id);
   CREATE INDEX IF NOT EXISTS mission_events_cursor ON mission_events(mission_id,seq);
  `);
    }
    enqueue(input: MissionInput): MissionRecord {
        this.validate(input);
        const id = input.id || 'm_' + randomUUID().replaceAll('-', '');
        const now = Date.now(), deadline = input.deadlineSeconds ? now + input.deadlineSeconds * 1000 : null;
        this.database.transaction(() => {
            this.database.prepare('INSERT INTO missions VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, input.goal, input.cwd, input.parentSessionId, input.sessionFile || '', 'QUEUED', now, now, deadline, JSON.stringify({ version: 2 }));
            input.jobs.forEach((item, index) => {
                const localId = item.id || `job-${index + 1}`;
                // User-facing IDs are scoped to a plan, allowing "scan" in several projects.
                const key = id + ':' + localId;
                const agent = structuredClone(item.agent);
                const base = {
                    name: agent.name,
                    role: agent.role || '',
                    roleKey: agent.roleKey,
                    model: agent.model,
                    provider: agent.provider || '',
                    tools: agent.tools ?? [...READ_ONLY_TOOLS],
                    skills: agent.skills ?? [],
                    mcp: false,
                };
                agent.profileRevision = profileRevision(base);
                const seconds = item.seconds ?? DEFAULT_TASK_SECONDS;
                const requiresHuman = !!item.requiresHuman || seconds > HUMAN_APPROVAL_THRESHOLD_SECONDS;
                this.database.prepare('INSERT INTO mission_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key, id, JSON.stringify(agent), item.task, JSON.stringify(item.dependsOn || []), seconds, requiresHuman ? 1 : 0, 'QUEUED', null, null, null, null, null, null);
                this.event(id, key, 'job_queued', { state: requiresHuman ? 'NEEDS_HUMAN' : 'QUEUED', profileRevision: agent.profileRevision, requiresHuman, reason: seconds > HUMAN_APPROVAL_THRESHOLD_SECONDS ? 'Long-running step requires human approval' : undefined });
            });
            this.event(id, null, 'mission_created', { state: 'QUEUED' });
        });
        this.graph.createRun({ id, goal: input.goal, cwd: input.cwd, parentSessionId: input.parentSessionId, state: 'QUEUED' });
        input.jobs.forEach((job, index) => {
            const localId = job.id || `job-${index + 1}`;
            const key = id + ':' + localId;
            this.graph.addNode(id, {
                id: key, kind: 'agent', label: job.task,
                profileRevision: job.agent.profileRevision,
                dependsOn: (job.dependsOn || []).map(dependency => id + ':' + dependency),
            });
        });
        this.scheduleTick();
        return this.get(id, input.parentSessionId)!;
    }
    private validate(input: MissionInput) {
        if (!input || !input.goal?.trim() || !input.cwd || !input.parentSessionId)
            throw Error('Mission goal, cwd and parentSessionId are required');
        if (input.id && !/^[-_a-zA-Z0-9.]+$/.test(input.id))
            throw Error('Invalid mission id');
        if (!Array.isArray(input.jobs) || input.jobs.length < 1 || input.jobs.length > 100)
            throw Error('Mission must contain 1-100 jobs');
        if (input.deadlineSeconds !== undefined && (!Number.isFinite(input.deadlineSeconds) || input.deadlineSeconds <= 0))
            throw Error('Invalid mission deadline');
        const ids = input.jobs.map((job, index) => job.id || `job-${index + 1}`);
        if (new Set(ids).size !== ids.length || ids.some(id => !/^[-_a-zA-Z0-9.]+$/.test(id)))
            throw Error('Invalid or duplicate job id');
        for (const job of input.jobs) {
            if (!job.task?.trim())
                throw Error('Job task is empty');
            if (job.agent?.tools !== undefined && (!Array.isArray(job.agent.tools) || job.agent.tools.some((tool: string) => !(READ_ONLY_TOOLS as readonly string[]).includes(tool))))
                throw Error('Job tools must be read-only');
            if (!job.agent?.name?.trim() || !job.agent?.model?.trim())
                throw Error('Job agent name and model are required');
            if (job.seconds !== undefined && (!Number.isInteger(job.seconds) || job.seconds < 1 || job.seconds > MAX_TASK_SECONDS))
                throw Error(`Job deadline must be 1-${MAX_TASK_SECONDS} seconds`);
            if (job.dependsOn !== undefined && !Array.isArray(job.dependsOn))
                throw Error('Job dependsOn must be an array');
            for (const dependency of job.dependsOn || [])
                if (!ids.includes(dependency))
                    throw Error('Unknown job dependency: ' + dependency);
        }
        const visiting = new Set<string>(), done = new Set<string>();
        const walk = (id: string) => { if (visiting.has(id))
            throw Error('Mission dependency cycle'); if (done.has(id))
            return; visiting.add(id); for (const dep of input.jobs[ids.indexOf(id)].dependsOn || [])
            walk(dep); visiting.delete(id); done.add(id); };
        ids.forEach(walk);
    }
    subscribe(listener: (event: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private notify(event: any) { for (const listener of this.listeners) {
        try {
            listener(event);
        }
        catch { }
    } }
    start() {
        if (this.timer)
            return;
        this.stopped = false;
        this.unsubscribe = this.pool.subscribe?.(event => { if (event.type === 'task_finished')
            this.scheduleTick(); });
        this.timer = setInterval(() => this.scheduleTick(), Math.max(50, this.options.tickMs ?? 1000));
        this.timer.unref?.();
        this.scheduleTick();
    }
    stop() {
        this.stopped = true;
        clearInterval(this.timer);
        this.timer = undefined;
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        // Queued/paused plans with no executing steps may be resumed by a later runner.
        for (const row of this.database.prepare('SELECT id,meta FROM missions').all() as any[]) {
            const meta = JSON.parse(row.meta);
            if (meta.owner?.epoch !== this.epoch)
                continue;
            const active = (this.database.prepare("SELECT COUNT(*) AS n FROM mission_jobs WHERE mission_id=? AND state='RUNNING'").get(row.id) as any).n;
            if (!active) {
                delete meta.owner;
                this.database.prepare('UPDATE missions SET meta=? WHERE id=?').run(JSON.stringify(meta), row.id);
            }
        }
    }
    private scheduleTick() {
        // enqueue does not silently begin model work until start/tick is explicitly called.
        if (this.stopped || !this.timer || this.scheduled)
            return;
        this.scheduled = true;
        queueMicrotask(() => { this.scheduled = false; void this.tick().catch(error => { this.lastError = String(error); }); });
    }
    list(parent?: string): MissionRecord[] {
        const rows = this.database.prepare('SELECT id FROM missions' + (parent ? ' WHERE parent=?' : '') + ' ORDER BY created,rowid').all(...(parent ? [parent] : [])) as any[];
        return rows.map(row => this.get(row.id, parent)!);
    }
    get(id: string, parent?: string): MissionRecord | null {
        const row = this.database.prepare('SELECT * FROM missions WHERE id=?').get(id) as any;
        if (!row || (parent !== undefined && row.parent !== parent))
            return null;
        const jobs = (this.database.prepare('SELECT * FROM mission_jobs WHERE mission_id=? ORDER BY rowid').all(id) as any[]).map(job => ({
            key: job.id, id: job.id.startsWith(id + ':') ? job.id.slice(id.length + 1) : job.id, missionId: id,
            agent: JSON.parse(job.agent), task: job.task, dependsOn: JSON.parse(job.depends), seconds: job.seconds,
            requiresHuman: !!job.requires_human, state: job.state, handle: job.handle ? JSON.parse(job.handle) : undefined,
            output: job.output || undefined, error: job.error || undefined, started: job.started || undefined, ended: job.ended || undefined, checkpoint: job.checkpoint || undefined,
        }));
        return { id: row.id, goal: row.goal, cwd: row.cwd, parentSessionId: row.parent, sessionFile: row.session_file || undefined, state: row.state, created: row.created, updated: row.updated, deadline: row.deadline || undefined, jobs };
    }
    events(id: string, parent: string, cursor = 0, limit = 100) {
        this.authorize(id, parent);
        if (!Number.isSafeInteger(cursor) || cursor < 0)
            throw Error('Invalid event cursor');
        const size = Math.max(1, Math.min(200, Math.floor(limit) || 100));
        const rows = this.database.prepare('SELECT seq,job_id,type,created,payload FROM mission_events WHERE mission_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, cursor, size + 1) as any[];
        const events = rows.slice(0, size).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
        return { events, nextCursor: events.at(-1)?.seq ?? cursor, hasMore: rows.length > size };
    }
    pause(id: string, parent: string) { const m = this.authorize(id, parent); if (!terminal.has(m.state) && m.state !== 'PAUSED')
        this.setMission(m, 'PAUSED'); }
    resume(id: string, parent: string) { const m = this.authorize(id, parent); if (m.state === 'PAUSED')
        this.setMission(m, 'QUEUED'); this.scheduleTick(); }
    approve(id: string, parent: string, jobId?: string) {
        const m = this.authorize(id, parent);
        if (terminal.has(m.state))
            return;
        const candidates = m.jobs.filter(job => job.state === 'NEEDS_HUMAN' && job.requiresHuman && (!jobId || job.id === jobId));
        if (!candidates.length)
            throw Error('No pending human approval; failures require an explicit new/revised plan');
        this.database.transaction(() => {
            for (const job of candidates) {
                this.database.prepare("UPDATE mission_jobs SET requires_human=0,state='QUEUED',error=NULL,ended=NULL WHERE id=? AND state='NEEDS_HUMAN'").run(job.key);
                this.event(id, job.key, 'human_approved', { state: 'QUEUED' });
            }
            if (m.state === 'NEEDS_HUMAN')
                this.setMission(m, 'QUEUED');
        });
        this.scheduleTick();
    }
    /** Adjust the time limit of a not-yet-dispatched step. Existing human gates are never cleared here. */
    reschedule(id: string, parent: string, jobId: string, seconds: number) {
        const m = this.authorize(id, parent);
        if (terminal.has(m.state))
            throw Error('计划已结束，不能再修改');
        const job = m.jobs.find(item => item.id === jobId);
        if (!job)
            throw Error('未知步骤');
        if (!['QUEUED', 'NEEDS_HUMAN'].includes(job.state))
            throw Error('只能调整尚未派发的步骤');
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TASK_SECONDS)
            throw Error(`时限必须为 1-${MAX_TASK_SECONDS} 秒`);
        const requiresHuman = job.requiresHuman || seconds > HUMAN_APPROVAL_THRESHOLD_SECONDS;
        this.database.transaction(() => {
            this.database.prepare("UPDATE mission_jobs SET seconds=?,requires_human=? WHERE id=? AND state IN ('QUEUED','NEEDS_HUMAN')").run(seconds, requiresHuman ? 1 : 0, job.key);
            this.event(id, job.key, 'job_rescheduled', { seconds, requiresHuman });
        });
        return this.get(id, parent)!;
    }
    /** Launch one ready step and record its handle; a failed launch rolls the worker back. */
    private dispatchJob(m: MissionRecord, job: JobRecord): void {
        let handle: WorkerHandle | undefined;
        try {
            const dependencies = job.dependsOn.map(id => m.jobs.find(item => item.id === id)!);
            const context = dependencies.map(dep => `[${dep.id}] ${limitText(dep.output)}`).join('\n\n');
            const instruction = `Mission: ${limitText(m.goal, 2000)}\n\nAssigned step: ${job.task}` + (context ? `\n\nCompleted dependency evidence (verify before relying on it):\n${context.slice(0, 12000)}` : '');
            handle = this.pool.launch(structuredClone(job.agent), instruction, m.cwd, m.sessionFile || '', job.seconds, undefined, m.parentSessionId, job.agent.tools ?? Array.from(READ_ONLY_TOOLS), [], false);
            const launched = handle;
            this.liveHandles.set(job.key, launched);
            // The pool authorizes by hashing the presented capability, so only the raw
            // value is ever sent to it; the database row keeps the hash so a leaked
            // database does not hand out the live handle.
            const stored = { ...launched, capability: createHash('sha256').update(launched.capability).digest('hex') };
            this.database.transaction(() => {
                this.database.prepare('UPDATE mission_jobs SET handle=? WHERE id=? AND state=\'RUNNING\'').run(JSON.stringify(stored), job.key);
                this.event(m.id, job.key, 'job_dispatched', { state: 'RUNNING', workerId: launched.workerId });
                this.graph.updateNode(m.id, job.key, 'RUNNING');
            });
            this.setMission(m, 'RUNNING');
        }
        catch (error) {
            // The launch may already have spawned a worker before the bookkeeping
            // transaction failed; never leave it running with no recorded handle.
            if (handle) { this.liveHandles.delete(job.key); try { this.pool.cancelHandle(handle, m.parentSessionId); } catch {} }
            this.setJob(job, 'FAILED', String(error));
        }
    }
    /** The raw capability for a dispatched step: this scheduler's own launch, or the shared pool's in-process recovery. */
    private handleFor(job: JobRecord, parent: string): WorkerHandle | undefined {
        const live = this.liveHandles.get(job.key);
        if (live) return live;
        return job.handle && this.pool.liveHandle ? this.pool.liveHandle(job.handle.workerId, parent) : undefined;
    }
    cancel(id: string, parent: string) {
        const m = this.authorize(id, parent);
        if (terminal.has(m.state))
            return;
        this.setMission(m, 'CANCELLED');
        for (const job of m.jobs) {
            if (job.state === 'RUNNING' && job.handle) {
                const handle = this.handleFor(job, parent);
                if (handle) {
                    this.liveHandles.delete(job.key);
                    this.pool.cancelHandle(handle, parent);
                    this.setJob(job, 'CANCELLED', 'Cancelled by operator');
                }
                // Without the raw capability this process cannot authorize the cancel;
                // reconcile settles the job from the worker's real receipt instead.
            }
            else if (!terminal.has(job.state))
                this.setJob(job, 'CANCELLED', 'Cancelled by operator');
        }
        this.scheduleTick();
    }
    async tick() {
        if (this.stopped || this.ticking)
            return;
        this.ticking = true;
        try {
            let plans = this.list().filter(mission => (!this.options.missionIds || this.options.missionIds.includes(mission.id)) && (!terminal.has(mission.state) || mission.jobs.some(job => job.state === 'RUNNING')) && this.claimOwner(mission.id));
            for (const plan of plans) {
                if (plan.state === 'CANCELLED')
                    for (const job of plan.jobs)
                        if (job.state === 'RUNNING' && job.handle) {
                            const handle = this.handleFor(job, plan.parentSessionId);
                            if (handle) this.pool.cancelHandle(handle, plan.parentSessionId);
                        }
                this.reconcile(plan);
                let current = this.get(plan.id)!;
                if (current.deadline && current.deadline <= Date.now() && !terminal.has(current.state)) {
                    for (const job of current.jobs) {
                        if (job.state === 'RUNNING' && job.handle) {
                            const handle = this.handleFor(job, current.parentSessionId);
                            if (handle) this.pool.cancelHandle(handle, current.parentSessionId);
                        }
                        if (job.state === 'QUEUED')
                            this.setJob(job, 'CANCELLED', 'Mission deadline reached');
                    }
                    this.setMission(current, 'NEEDS_HUMAN');
                    continue;
                }
                this.publishState(current);
            }
            plans = this.list().filter(mission => (!this.options.missionIds || this.options.missionIds.includes(mission.id)) && ['QUEUED', 'RUNNING'].includes(mission.state) && this.claimOwner(mission.id));
            // Count all active mission jobs once across plans, including paused plans that are draining.
            const count = (this.database.prepare("SELECT COUNT(*) AS n FROM mission_jobs WHERE state='RUNNING'").get() as any).n;
            let slots = Math.max(0, this.concurrency - count);
            while (slots > 0 && plans.length) {
                const start = (plans.findIndex(m => m.id === this.lastMission) + 1) % plans.length;
                let dispatched = false;
                for (let index = 0; index < plans.length; index++) {
                    const m = this.get(plans[(start + index) % plans.length].id)!;
                    if (!['QUEUED', 'RUNNING'].includes(m.state))
                        continue;
                    const job = this.nextReady(m);
                    if (!job)
                        continue;
                    if (!this.claimJob(m, job))
                        continue;
                    this.lastMission = m.id;
                    this.dispatchJob(m, job);
                    slots--;
                    dispatched = true;
                    break;
                }
                if (!dispatched)
                    break;
            }
            for (const plan of plans)
                this.publishState(this.get(plan.id)!);
        }
        finally {
            this.ticking = false;
        }
    }
    private nextReady(m: MissionRecord): JobRecord | undefined {
        for (const job of m.jobs) {
            if (job.state !== 'QUEUED')
                continue;
            const dependencies = job.dependsOn.map(id => m.jobs.find(item => item.id === id));
            if (dependencies.some(dep => !dep || ['FAILED', 'CANCELLED', 'NEEDS_HUMAN'].includes(dep.state)))
                continue;
            if (dependencies.some(dep => dep!.state !== 'SUCCEEDED'))
                continue;
            if (job.requiresHuman) {
                this.setJob(job, 'NEEDS_HUMAN', 'Awaiting human approval');
                continue;
            }
            return job;
        }
    }
    private reconcile(m: MissionRecord) {
        // A cancelled plan is settled as cancelled whatever the orphaned worker does;
        // only a live plan turns a lost receipt into a human decision.
        const cancelledPlan = m.state === 'CANCELLED';
        for (const job of m.jobs.filter(item => item.state === 'RUNNING')) {
            if (!job.handle) {
                this.setJob(job, cancelledPlan ? 'CANCELLED' : 'NEEDS_HUMAN', 'Dispatch outcome unknown; no automatic replay');
                continue;
            }
            const handle = this.handleFor(job, m.parentSessionId);
            if (!handle) {
                this.setJob(job, cancelledPlan ? 'CANCELLED' : 'NEEDS_HUMAN', cancelledPlan ? 'Cancelled by operator; the worker stops at its own deadline' : 'Worker capability is not held in this process; the worker stops at its own deadline and is not replayed');
                continue;
            }
            const receipt = this.pool.result(handle, m.parentSessionId) as any;
            if (running.has(receipt.state))
                continue;
            this.liveHandles.delete(job.key);
            if (receipt.state === 'SUCCEEDED') {
                this.database.transaction(() => {
                    this.database.prepare("UPDATE mission_jobs SET state='SUCCEEDED',output=?,checkpoint=?,ended=? WHERE id=? AND state='RUNNING'").run(receipt.output || '', limitText(receipt.output, 1000), Date.now(), job.key);
                    this.event(m.id, job.key, 'job_succeeded', { state: 'SUCCEEDED', resultHash: receipt.resultHash });
                    this.graph.updateNode(m.id, job.key, 'SUCCEEDED', { checkpoint: limitText(receipt.output, 1000) });
                    this.graph.artifact(m.id, { nodeId: job.key, kind: 'worker_receipt', summary: receipt.output || '', uri: receipt.resultHash });
                });
            }
            else
                this.setJob(job, receipt.state === 'CANCELLED' ? 'CANCELLED' : 'FAILED', receipt.error || ('Worker ' + receipt.state + '; no automatic replay'));
        }
    }
    private publishState(m: MissionRecord) {
        if (terminal.has(m.state) || m.state === 'PAUSED')
            return;
        if (m.jobs.every(job => job.state === 'SUCCEEDED'))
            this.setMission(m, 'SUCCEEDED');
        else if (m.jobs.some(job => ['FAILED', 'NEEDS_HUMAN', 'CANCELLED'].includes(job.state)))
            this.setMission(m, 'NEEDS_HUMAN');
    }
    private claimOwner(id: string) {
        return this.database.transaction(() => {
            const row = this.database.prepare('SELECT meta FROM missions WHERE id=?').get(id) as any;
            const meta = JSON.parse(row.meta);
            const owner = meta.owner as Owner | undefined;
            if (owner && owner.epoch !== this.epoch && isAlive(owner.pid))
                return false;
            if (!owner || owner.epoch !== this.epoch) {
                meta.owner = { pid: process.pid, epoch: this.epoch };
                this.database.prepare('UPDATE missions SET meta=? WHERE id=?').run(JSON.stringify(meta), id);
            }
            return true;
        });
    }
    private claimJob(m: MissionRecord, job: JobRecord) {
        return this.database.transaction(() => {
            const state = (this.database.prepare('SELECT state FROM missions WHERE id=?').get(m.id) as any)?.state;
            if (!['QUEUED', 'RUNNING'].includes(state))
                return false;
            const active = (this.database.prepare("SELECT COUNT(*) AS n FROM mission_jobs WHERE state='RUNNING'").get() as any).n;
            if (active >= this.concurrency)
                return false;
            return this.database.prepare("UPDATE mission_jobs SET state='RUNNING',started=?,error=NULL WHERE id=? AND state='QUEUED'").run(Date.now(), job.key).changes === 1;
        });
    }
    private setMission(m: MissionRecord, state: MissionState) {
        if (m.state === state)
            return;
        this.database.transaction(() => {
            this.database.prepare('UPDATE missions SET state=?,updated=? WHERE id=?').run(state, Date.now(), m.id);
            this.event(m.id, null, 'mission_' + state.toLowerCase(), { state });
        this.graph.updateRun(m.id, state as any);
        });
        this.notify({ type: 'mission_state', id: m.id, parentSessionId: m.parentSessionId, cwd: m.cwd, goal: m.goal, state });
    }
    private setJob(job: JobRecord, state: JobState, error?: string) {
        if (terminal.has(job.state))
            return;
        this.database.prepare('UPDATE mission_jobs SET state=?,error=?,ended=? WHERE id=?').run(state, error || null, Date.now(), job.key);
        this.event(job.missionId, job.key, 'job_' + state.toLowerCase(), { state, reason: limitText(error, 500) });
        this.graph.updateNode(job.missionId, job.key, state as any, { error });
    }
    private event(mid: string, jid: string | null, type: string, payload: any) { this.database.prepare('INSERT INTO mission_events(mission_id,job_id,type,created,payload) VALUES(?,?,?,?,?)').run(mid, jid, type, Date.now(), JSON.stringify(payload)); }
    private authorize(id: string, parent: string) { const m = this.get(id, parent); if (!m)
        throw Error('Unknown mission or wrong parent session'); return m; }
}
