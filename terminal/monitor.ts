import type {OrbitalDatabase} from './database.ts';
export function taskSummaries(database:OrbitalDatabase,limit=100) {
 return database.prepare(`SELECT id,parent AS parentSessionId,state,
 json_extract(task,'$.agent') AS agent,json_extract(task,'$.cwd') AS cwd,
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
