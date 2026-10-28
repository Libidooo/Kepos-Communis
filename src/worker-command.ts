import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {AppPaths} from './config.ts';
import {activatePaths,preparePaths} from './config.ts';
export async function workerCommand(options:any,paths:AppPaths):Promise<void>{
 preparePaths(paths);activatePaths(paths);const action=options.args[0]||'serve';if(action!=='serve')throw Error('Usage: kepos worker serve');
 const {OrbitalDatabase}=await import('../terminal/database.ts');const {WorkerPool}=await import('../terminal/workers.ts');const {RemoteWorkerServer}=await import('../terminal/remote-worker.ts');
 const database=new OrbitalDatabase(join(paths.dataDir,'orbital.sqlite'));const pool=new WorkerPool(database);const token=options.token||process.env.KEPOS_WORKER_TOKEN;if(!token)throw Error('Set KEPOS_WORKER_TOKEN or pass --token; it is never generated or logged.');
 const server=new RemoteWorkerServer(pool,{host:options.host||'127.0.0.1',port:Number(options.port||7788),token,tlsCert:options.tlsCert,tlsKey:options.tlsKey});const address=await server.listen();console.error(`Kepos worker listening on ${address.host}:${address.port} · tls=${address.tls}`);
 const stop=async()=>{await server.close();await pool.shutdown();database.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);await new Promise<void>(()=>{});
}
