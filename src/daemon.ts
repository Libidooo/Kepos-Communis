import { join } from 'node:path';
import { preparePaths, activatePaths, type AppPaths } from './config.ts';
import { OrbitalDatabase } from '../terminal/database.ts';
import { WorkerPool } from '../terminal/workers.ts';
import { RemoteWorkerClient, RemoteWorkerPool } from '../terminal/remote-worker.ts';
import { SchedulerDaemon } from '../terminal/daemon.ts';

export async function runDaemon(paths: AppPaths): Promise<void> {
  preparePaths(paths);activatePaths(paths);
  const database=new OrbitalDatabase(join(paths.dataDir,'orbital.sqlite'));
  const remoteHost=process.env.KEPOS_REMOTE_WORKER_HOST;
  const remotePort=Number(process.env.KEPOS_REMOTE_WORKER_PORT||7788);
  const remoteToken=process.env.KEPOS_REMOTE_WORKER_TOKEN;
  const pool=remoteHost&&remoteToken?new RemoteWorkerPool(new RemoteWorkerClient({host:remoteHost,port:remotePort,token:remoteToken,tls:process.env.KEPOS_REMOTE_WORKER_TLS==='1'})):new WorkerPool(database);
  const daemon=new SchedulerDaemon(database,pool as any);
  const abort=new AbortController();
  const stop=()=>abort.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try { await daemon.run(abort.signal); }
  finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await (pool as any).shutdown?.().catch(()=>{});database.close(); }
}
