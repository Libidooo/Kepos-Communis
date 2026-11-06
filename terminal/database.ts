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
   -- 人类在执行途中改变需求：加急指令必须留下记录。
   -- 界面显示"已加急"时要能对应一条真实送达，而不是"看起来很成功"。
   -- task_id 为空表示发给总理的整盘重排；有值表示发给某位代表。
   CREATE TABLE IF NOT EXISTS human_briefings(
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    target TEXT NOT NULL,
    target_name TEXT NOT NULL,
    task_id TEXT,
    text TEXT NOT NULL,
    delivery TEXT NOT NULL,
    note TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_briefing_task ON human_briefings(task_id,at);
   -- 事件驱动的观察层：命中规则的变更只记录"本会怎么做"，不执行。
   -- 观察期产物必须可查，否则无法据此判断规则是否会误伤。
   CREATE TABLE IF NOT EXISTS watch_candidates(
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    rule_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    task TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT '',
    observe_only INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX IF NOT EXISTS idx_watch_recent ON watch_candidates(at DESC);
   CREATE INDEX IF NOT EXISTS idx_watch_cooldown ON watch_candidates(rule_id,path,at);
   -- 语义评估的落库：置信度阈值能否校准，取决于评估有没有被记录。
   -- dispatched=1 表示该候选真的被派出去了（闸门放行），只有这些参与成功率计算。
   CREATE TABLE IF NOT EXISTS watch_assessments(
    at INTEGER NOT NULL,
    rule_id TEXT NOT NULL,
    path TEXT NOT NULL,
    worth INTEGER NOT NULL,
    confidence REAL,
    reason TEXT,
    dispatched INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_assess_path ON watch_assessments(path,at);
   -- 静默预检记录：同一条报告只预检一次。
   -- 没有这张表，重复的报告会反复开三席——最贵的重复劳动。
   CREATE TABLE IF NOT EXISTS precheck_runs(
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    verdict TEXT NOT NULL,
    summary TEXT NOT NULL,
    attempts INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_precheck_finger ON precheck_runs(fingerprint,at);
   -- 僚属派生超过三人时的审批记录：一个批准只放行一次派生。
   CREATE TABLE IF NOT EXISTS subordinate_approvals(
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    parent_task_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    task TEXT NOT NULL,
    state TEXT NOT NULL,
    live INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_subap_parent ON subordinate_approvals(parent_task_id,state);
   -- 预算截停的立案：截停回传上级、总理呈报、人类批准后按新额度重派。
   -- 同一任务只立一案（raise 去重）；launch 成功才置 dispatched，批准不蒸发。
   CREATE TABLE IF NOT EXISTS budget_escalations(
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    parent_session TEXT,
    agent TEXT NOT NULL,
    agent_id TEXT,
    task TEXT NOT NULL,
    spent INTEGER NOT NULL,
    cap INTEGER NOT NULL,
    digest TEXT,
    proposal INTEGER,
    proposed_by TEXT NOT NULL DEFAULT 'system',
    note TEXT,
    state TEXT NOT NULL,
    decided_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS idx_budesc_state ON budget_escalations(state,at);
   CREATE INDEX IF NOT EXISTS idx_budesc_task ON budget_escalations(task_id,state);
   -- 组内推举呈报：组内推举只是提名，批准由人类做。
   -- 报告必须留档——批的是谁、依据是什么，事后要能回看。
   CREATE TABLE IF NOT EXISTS election_reports(
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    group_id TEXT NOT NULL,
    state TEXT NOT NULL,
    goal TEXT,
    report TEXT NOT NULL,
    approved_agent TEXT,
    decided_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS idx_election_state ON election_reports(state,at);
   -- 跨组临时借调：只有代理总代发起、总理批准，到期自动失效。
   -- 记录必须留档：借调本身不扩权，但"谁在哪个组里"是治理事实。
   CREATE TABLE IF NOT EXISTS secondments(
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    from_group TEXT NOT NULL,
    to_group TEXT NOT NULL,
    reason TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    approved_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    released_at INTEGER
   );
   CREATE INDEX IF NOT EXISTS idx_secondment_active ON secondments(to_group,expires_at);
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
