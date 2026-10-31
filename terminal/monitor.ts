import type {OrbitalDatabase} from './database.ts';
import {representativeRisk, type RepresentativeTaskHistory} from './representative-health.ts';
export function taskSummaries(database:OrbitalDatabase,limit=100) {
 return database.prepare(`SELECT id,parent AS parentSessionId,state,
 json_extract(task,'$.agent') AS agent,json_extract(task,'$.agentId') AS agentId,json_extract(task,'$.purpose') AS purpose,json_extract(task,'$.cwd') AS cwd,
 json_extract(task,'$.title') AS title,json_extract(task,'$.status') AS status,
 json_extract(task,'$.started') AS started,json_extract(task,'$.ended') AS ended,
 json_extract(task,'$.model') AS model,json_extract(task,'$.provider') AS provider,
 json_extract(task,'$.limit') AS "limit",json_extract(task,'$.tool') AS tool,
 json_extract(task,'$.profileRevision') AS profileRevision,json_extract(task,'$.queueWaitMs') AS queueWaitMs,
 json_extract(task,'$.firstTextMs') AS firstTextMs,json_extract(task,'$.checkpoint') AS checkpoint,json_extract(task,'$.checkpointAt') AS checkpointAt,
 json_extract(task,'$.reviewAt') AS reviewAt,json_extract(task,'$.reviewCount') AS reviewCount,json_extract(task,'$.reviewDue') AS reviewDue,
 json_extract(task,'$.delegationDepth') AS delegationDepth,json_extract(task,'$.parentWorkerId') AS parentWorkerId
 FROM workers ORDER BY CASE WHEN receipt IS NULL THEN 0 ELSE 1 END, json_extract(task,'$.started') DESC LIMIT ?`).all(Math.max(1,Math.min(200,limit))) as any[];
}
export function taskEvidence(database:OrbitalDatabase,id:string) {
 const row=database.prepare('SELECT task FROM workers WHERE id=?').get(id) as any;
 return row?JSON.parse(row.task):undefined;
}
export function planSummaries(database:OrbitalDatabase) {
 // The monitor exposes no Worker capabilities or full evidence in a list query.
 if(!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='missions'").get())return [];
 return database.prepare(`SELECT m.id,m.goal,m.cwd,m.parent AS parentSessionId,m.state,m.updated,
 (SELECT COUNT(*) FROM mission_jobs j WHERE j.mission_id=m.id) AS total,
 (SELECT COUNT(*) FROM mission_jobs j WHERE j.mission_id=m.id AND j.state='SUCCEEDED') AS completed,
 (SELECT COUNT(*) FROM mission_jobs j WHERE j.mission_id=m.id AND j.state='NEEDS_HUMAN') AS attention
 FROM missions m ORDER BY CASE WHEN m.state='NEEDS_HUMAN' THEN 0 ELSE 1 END,m.updated DESC LIMIT 100`).all() as any[];
}

const PLAN_GLYPHS: Record<string, string> = { QUEUED: '○', RUNNING: '▶', NEEDS_HUMAN: '⚠', SUCCEEDED: '✓', FAILED: '✕', CANCELLED: '⨉' };
/** Depth-first plan tree with dependency indentation; orphans and cycles fall back to roots. */
export function planTree(jobs: { id: string; task: string; state: string; dependsOn?: string[] }[]): string[] {
 const byId = new Map(jobs.map(job => [job.id, job]));
 const children = new Map<string, string[]>();
 const roots: string[] = [];
 for (const job of jobs) {
  const deps = (job.dependsOn || []).filter(dep => byId.has(dep));
  if (!deps.length) { roots.push(job.id); continue; }
  const parent = deps[deps.length - 1];
  const list = children.get(parent) || []; list.push(job.id); children.set(parent, list);
 }
 const lines: string[] = [];
 const seen = new Set<string>();
 const walk = (id: string, depth: number) => {
  if (seen.has(id)) return;
  seen.add(id);
  const job = byId.get(id)!;
  const glyph = PLAN_GLYPHS[job.state] || '·';
  lines.push(`${'  '.repeat(depth)}${glyph} ${id} · ${job.task.slice(0, 60)}${job.state === 'NEEDS_HUMAN' ? ' · 等待人类审批' : ''}`);
  for (const child of children.get(id) || []) walk(child, depth + 1);
 };
 for (const root of roots) walk(root, 0);
 for (const job of jobs) if (!seen.has(job.id)) walk(job.id, 0);
 return lines;
}

/** Risk note for a configured member based on recent task outcomes; undefined when healthy. */
export function agentRisk(tasks:readonly RepresentativeTaskHistory[],name:string,agentId?:string):string|undefined{
 return representativeRisk(tasks,{id:agentId,name});
}
