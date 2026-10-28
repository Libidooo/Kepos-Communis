import type {OrbitalDatabase} from './database.ts';

export interface RetentionOptions {maxAgeMs?:number;maxRowsPerSource?:number;batchSize?:number;}
export interface RetentionReport {archived:number;remaining:number;cutoff:number;}
const SOURCES=[
 {name:'worker',table:'worker_events',id:'worker_id'},
 {name:'mission',table:'mission_events',id:'mission_id'},
 {name:'graph',table:'graph_events',id:'run_id'},
] as const;

export class EventRetention {
 constructor(private readonly database:OrbitalDatabase){database.sql.exec(`CREATE TABLE IF NOT EXISTS event_archive(source TEXT NOT NULL,entity TEXT NOT NULL,sequence INTEGER NOT NULL,type TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL,archived_at INTEGER NOT NULL,PRIMARY KEY(source,entity,sequence));CREATE INDEX IF NOT EXISTS event_archive_created ON event_archive(created);`);}
 run(options:RetentionOptions={}):RetentionReport {
  const maxAgeMs=Math.max(60_000,options.maxAgeMs??30*24*60*60*1000);const cutoff=Date.now()-maxAgeMs;const batchSize=Math.max(10,Math.min(5000,options.batchSize??500));let archived=0;
  for(const source of SOURCES){if(!this.tableExists(source.table))continue;archived+=this.archiveSource(source,cutoff,batchSize);}
  if(options.maxRowsPerSource!==undefined){for(const source of SOURCES){if(!this.tableExists(source.table))continue;archived+=this.pruneSource(source,Math.max(1,Math.floor(options.maxRowsPerSource)),batchSize);}}
  const remaining=SOURCES.reduce((total,source)=>total+(this.tableExists(source.table)?Number((this.database.prepare(`SELECT COUNT(*) AS n FROM ${source.table}`).get() as any).n):0),0);
  return{archived,remaining,cutoff};
 }
 private tableExists(table:string){return !!this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);}
 private archiveSource(source:typeof SOURCES[number],cutoff:number,batch:number){let total=0;for(;;){const rows=this.database.prepare(`SELECT rowid AS rid,${source.id} AS entity,seq,type,created,payload FROM ${source.table} WHERE created<? ORDER BY created,seq LIMIT ?`).all(cutoff,batch) as any[];if(!rows.length)break;this.database.transaction(()=>{for(const row of rows){this.database.prepare('INSERT OR IGNORE INTO event_archive VALUES(?,?,?,?,?,?,?)').run(source.name,String(row.entity),Number(row.seq),String(row.type),Number(row.created),String(row.payload),Date.now());this.database.prepare(`DELETE FROM ${source.table} WHERE rowid=?`).run(row.rid);}});total+=rows.length;if(rows.length<batch)break;}return total;}
 private pruneSource(source:typeof SOURCES[number],maxRows:number,batch:number){const count=Number((this.database.prepare(`SELECT COUNT(*) AS n FROM ${source.table}`).get() as any).n);let total=0;for(let remaining=count-maxRows;remaining>0;remaining-=batch){const rows=this.database.prepare(`SELECT rowid AS rid,${source.id} AS entity,seq,type,created,payload FROM ${source.table} ORDER BY created,seq LIMIT ?`).all(Math.min(batch,remaining)) as any[];if(!rows.length)break;this.database.transaction(()=>{for(const row of rows){this.database.prepare('INSERT OR IGNORE INTO event_archive VALUES(?,?,?,?,?,?,?)').run(source.name,String(row.entity),Number(row.seq),String(row.type),Number(row.created),String(row.payload),Date.now());this.database.prepare(`DELETE FROM ${source.table} WHERE rowid=?`).run(row.rid);}});total+=rows.length;}return total;}
 readArchive(options:{source?:string;entity?:string;cursor?:number;limit?:number}={}){const limit=Math.max(1,Math.min(500,options.limit??100));const clauses=['sequence>?'];const args:any[]=[options.cursor??0];if(options.source){clauses.push('source=?');args.push(options.source);}if(options.entity){clauses.push('entity=?');args.push(options.entity);}const rows=this.database.prepare(`SELECT source,entity,sequence,type,created,payload,archived_at AS archivedAt FROM event_archive WHERE ${clauses.join(' AND ')} ORDER BY sequence LIMIT ?`).all(...args,limit+1) as any[];const events=rows.slice(0,limit).map(row=>({...row,payload:JSON.parse(row.payload)}));return{events,nextCursor:events.at(-1)?.sequence??(options.cursor??0),hasMore:rows.length>limit};}
}
