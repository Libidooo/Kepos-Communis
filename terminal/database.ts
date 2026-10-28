import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { databasePath } from './paths.ts';
// A connection per extension runtime. SQLite serializes writers across Pi processes;
// there is no claim that the extension replaces Pi's own SessionManager authority.
export class OrbitalDatabase {
 readonly sql:DatabaseSync;
 private statements=new Map<string,StatementSync>();
 private transactionDepth=0;
 constructor(readonly path=databasePath){
  mkdirSync(dirname(path),{recursive:true});this.sql=new DatabaseSync(path);
  try {
  this.sql.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  const version=Number((this.sql.prepare('PRAGMA user_version').get() as any).user_version);
  if(version>1)throw Error('Orbital database is newer than this extension; refusing downgrade');
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
const key=Symbol.for('orbital.sqlite.connection:'+databasePath);
export const db=():OrbitalDatabase=>{const shared=globalThis as any;return shared[key]??=(new OrbitalDatabase());};
