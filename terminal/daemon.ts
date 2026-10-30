import {randomUUID} from 'node:crypto';
import type {OrbitalDatabase} from './database.ts';
import type {WorkerPool} from './workers.ts';
import {MissionScheduler} from './scheduler.ts';

export class SchedulerLease {
 private readonly owner=randomUUID();
 constructor(private readonly database:OrbitalDatabase,private readonly name='default',private readonly ttlMs=10000){database.sql.exec('CREATE TABLE IF NOT EXISTS scheduler_leases(name TEXT PRIMARY KEY,owner TEXT NOT NULL,pid INTEGER NOT NULL,heartbeat INTEGER NOT NULL,expires INTEGER NOT NULL);');}
 acquire():boolean{const now=Date.now();return !!this.database.transaction(()=>{const row=this.database.prepare('SELECT * FROM scheduler_leases WHERE name=?').get(this.name) as any;if(row&&row.owner!==this.owner&&row.expires>now)return false;this.database.prepare('INSERT INTO scheduler_leases VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,pid=excluded.pid,heartbeat=excluded.heartbeat,expires=excluded.expires').run(this.name,this.owner,process.pid,now,now+this.ttlMs);return true;});}
 renew():boolean{const now=Date.now();const result=this.database.prepare('UPDATE scheduler_leases SET heartbeat=?,expires=? WHERE name=? AND owner=?').run(now,now+this.ttlMs,this.name,this.owner);return result.changes===1;}
 release():void{this.database.prepare('DELETE FROM scheduler_leases WHERE name=? AND owner=?').run(this.name,this.owner);}
 get token(){return this.owner;}
}
export class SchedulerDaemon {
 private started=false;private heartbeat?:ReturnType<typeof setInterval>;private stopping=false;private readonly heartbeatMs:number;
 private onLeaseLost?:(error:Error)=>void;
 readonly lease:SchedulerLease;readonly scheduler:MissionScheduler;
 constructor(readonly database:OrbitalDatabase,readonly pool:WorkerPool,options:{tickMs?:number;leaseName?:string;leaseTtlMs?:number;heartbeatMs?:number}={}){this.lease=new SchedulerLease(database,options.leaseName||'default',options.leaseTtlMs||10000);this.scheduler=new MissionScheduler(database,pool,{tickMs:options.tickMs||500});this.heartbeatMs=options.heartbeatMs??Math.max(1000,Math.floor((this.lease as any).ttlMs/3));}
 start():void{if(this.started)throw Error('Scheduler daemon is already running');if(!this.lease.acquire())throw Error('Another Kepos scheduler daemon owns this data directory');this.started=true;this.stopping=false;this.scheduler.start();this.heartbeat=setInterval(()=>{if(!this.lease.renew()){const notify=this.onLeaseLost;this.stop();notify?.(Error('Scheduler lease lost: another daemon took over this data directory'));}},this.heartbeatMs);this.heartbeat.unref?.();}
 stop():void{if(this.stopping)return;this.stopping=true;clearInterval(this.heartbeat);this.heartbeat=undefined;this.started=false;this.onLeaseLost=undefined;this.scheduler.stop();this.lease.release();}
 async run(signal?:AbortSignal):Promise<void>{this.start();try{await new Promise<void>((resolve,reject)=>{const done=()=>{cleanup();resolve();};const fail=(error:Error)=>{cleanup();reject(error);};const cleanup=()=>{signal?.removeEventListener('abort',done);};this.onLeaseLost=fail;signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();});}finally{this.stop();}}
}
