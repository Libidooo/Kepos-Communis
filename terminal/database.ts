import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { databaseFile } from './paths.ts';
// A connection per extension runtime. SQLite serializes writers across Pi processes;
// there is no claim that the extension replaces Pi's own SessionManager authority.
export class KeposDatabase {
 readonly sql:DatabaseSync;
 private statements=new Map<string,StatementSync>();
 private transactionDepth=0;
 constructor(readonly path=databaseFile()){
  mkdirSync(dirname(path),{recursive:true});this.sql=new DatabaseSync(path);
  try {
  this.sql.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const version=Number((this.sql.prepare('PRAGMA user_version').get() as any).user_version);
  if(version>1)throw Error('Kepos database is newer than this extension; refusing downgrade');
  this.transaction(()=>{this.sql.exec(`
   CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,pi_path TEXT UNIQUE,pi_id TEXT,cwd TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',generation INTEGER NOT NULL DEFAULT 0,checkpoint TEXT,meta TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS messages(session_id TEXT NOT NULL REFERENCES sessions(id),uid TEXT NOT NULL,seq INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(session_id,uid),UNIQUE(session_id,seq));
   CREATE TABLE IF NOT EXISTS generations(session_id TEXT NOT NULL REFERENCES sessions(id),generation INTEGER NOT NULL,checkpoint TEXT NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(session_id,generation));
   CREATE TABLE IF NOT EXISTS generation_messages(session_id TEXT NOT NULL,generation INTEGER NOT NULL,uid TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(session_id,generation,uid),FOREIGN KEY(session_id,generation) REFERENCES generations(session_id,generation),FOREIGN KEY(session_id,uid) REFERENCES messages(session_id,uid));
   CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY,parent TEXT NOT NULL,correlation TEXT NOT NULL,capability_hash TEXT NOT NULL,owner_epoch TEXT NOT NULL,state TEXT NOT NULL,task TEXT NOT NULL,receipt TEXT);
   CREATE TABLE IF NOT EXISTS worker_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,worker_id TEXT NOT NULL REFERENCES workers(id),type TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS workers_parent ON workers(parent);
   CREATE INDEX IF NOT EXISTS worker_events_owner ON worker_events(worker_id,seq);
   CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,seq);
   CREATE TRIGGER IF NOT EXISTS immutable_receipt BEFORE UPDATE OF receipt ON workers WHEN OLD.receipt IS NOT NULL AND NEW.receipt IS NOT OLD.receipt BEGIN SELECT RAISE(ABORT,'terminal receipt is immutable'); END;
   -- 代表记忆：双时态。失效只置 valid_to，永不物理删除——
   -- 这样"某时刻我们相信什么"可以回溯，也避免整理管道误删后无法恢复。
   CREATE TABLE IF NOT EXISTS representative_memories(
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'semantic',
    content TEXT NOT NULL,
    source_worker_id TEXT,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_mem_agent_valid ON representative_memories(agent_id,valid_to);
   -- 整理管道去重：同一任务只整理一次。
   CREATE TABLE IF NOT EXISTS memory_consolidated(worker_id TEXT PRIMARY KEY,at INTEGER NOT NULL);
   -- Watchdog 判定：模型对"是否仍在推进"的判断结果，用于事后算误报率。
   CREATE TABLE IF NOT EXISTS watchdog_verdicts(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence_cursor INTEGER NOT NULL,
    model TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_watchdog_worker ON watchdog_verdicts(worker_id,seq);
   PRAGMA user_version=1;
  `);});
  } catch(error) { this.sql.close(); throw error; }
 }
 // Reuse prepared statements on hot paths such as history synchronization.
 prepare(sql:string):StatementSync{let statement=this.statements.get(sql);if(!statement){statement=this.sql.prepare(sql);this.statements.set(sql,statement);}return statement;}
 transaction<T>(fn:()=>T):T{
  const nested=this.transactionDepth>0;const name='kepos_tx_'+this.transactionDepth;
  this.sql.exec(nested?'SAVEPOINT '+name:'BEGIN IMMEDIATE');this.transactionDepth++;
  try{
   const result=fn();
   if(result&&typeof (result as any).then==='function')throw Error('SQLite transaction callback must be synchronous');
   this.sql.exec(nested?'RELEASE SAVEPOINT '+name:'COMMIT');return result;
  }catch(error){
   try{this.sql.exec(nested?'ROLLBACK TO SAVEPOINT '+name:'ROLLBACK');if(nested)this.sql.exec('RELEASE SAVEPOINT '+name);}catch{}
   throw error;
  }finally{this.transactionDepth--;}
 }
 get<T>(key:string):T|undefined{const row=this.prepare('SELECT value FROM kv WHERE key=?').get(key) as any;return row?JSON.parse(row.value):undefined;}
 set(key:string,value:unknown){this.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
 close(){this.statements.clear();this.sql.close();}
}
const key=Symbol.for('kepos.sqlite.connection:'+databaseFile());
export const db=():KeposDatabase=>{const shared=globalThis as any;return shared[key]??=(new KeposDatabase());};
