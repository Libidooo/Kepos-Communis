import { join } from 'node:path';
import { preparePaths, activatePaths, type AppPaths } from './config.ts';
import { OrbitalDatabase } from '../terminal/database.ts';
import { WorkerPool } from '../terminal/workers.ts';
import { RemoteWorkerClient, RemoteWorkerPool } from '../terminal/remote-worker.ts';
import { SchedulerDaemon } from '../terminal/daemon.ts';
import { SchedulerHost } from '../terminal/scheduler-host.ts';

export async function runDaemon(paths: AppPaths, options?: { port?: string }): Promise<void> {
  preparePaths(paths);activatePaths(paths);
  const database=new OrbitalDatabase(join(paths.dataDir,'orbital.sqlite'));
  const remoteHost=process.env.KEPOS_REMOTE_WORKER_HOST;
  const remotePort=Number(process.env.KEPOS_REMOTE_WORKER_PORT||7788);
  const remoteToken=process.env.KEPOS_REMOTE_WORKER_TOKEN;
  const pool=remoteHost&&remoteToken?new RemoteWorkerPool(new RemoteWorkerClient({host:remoteHost,port:remotePort,token:remoteToken,tls:process.env.KEPOS_REMOTE_WORKER_TLS==='1'})):new WorkerPool(database);
  const daemon=new SchedulerDaemon(database,pool as any);
  // Phase 1 of unified scheduling: clients (TUI/CLI/scripts) dispatch through this
  // process over the local RPC surface instead of owning their own WorkerPool.
  const rpcPort=Number(options?.port||process.env.KEPOS_RPC_PORT||7789);
  const rpc=new SchedulerHost(pool as any,daemon.scheduler,{port:rpcPort,host:'127.0.0.1',dataDir:paths.dataDir});
  const rpcAddress=await rpc.listen();
  console.error(`Kepos scheduler RPC on 127.0.0.1:${rpcAddress.port} (endpoint in ${paths.dataDir})`);
  const abort=new AbortController();
  const stop=()=>abort.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try { await daemon.run(abort.signal); }
  catch (error) {
    console.error('Kepos daemon failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
  finally {
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    await rpc.close();
    await (pool as any).shutdown?.().catch((shutdownError:unknown)=>{ console.error('Kepos daemon shutdown error:', shutdownError instanceof Error ? shutdownError.message : shutdownError); });
    database.close();
  }
}
