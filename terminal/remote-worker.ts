import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {createServer,connect, type Server as NetServer, type Socket} from 'node:net';
import {createServer as createTlsServer,connect as connectTls, type Server as TlsServer} from 'node:tls';
import {readFileSync} from 'node:fs';
import type {WorkerPool, WorkerHandle} from './workers.ts';
import type {Crew} from './store.ts';

type Request={id:string;action:string;token?:string;remoteId?:string;parentSessionId?:string;crew?:Crew;instruction?:string;cwd?:string;seconds?:number;cursor?:number};
type RemoteRecord={handle:WorkerHandle;parentSessionId:string;};
function digest(value:string){return createHash('sha256').update(value).digest();}
function authorized(expected:string,provided?:string){if(!provided)return false;const left=digest(expected),right=digest(provided);return left.length===right.length&&timingSafeEqual(left,right);}

export interface RemoteWorkerServerOptions {host?:string;port:number;token:string;tlsCert?:string;tlsKey?:string;}
export class RemoteWorkerServer {
 private server?:NetServer|TlsServer;private jobs=new Map<string,RemoteRecord>();
 constructor(private readonly pool:WorkerPool,private readonly options:RemoteWorkerServerOptions){}
 async listen():Promise<{host:string;port:number;tls:boolean}>{
  if(!this.options.token.trim())throw Error('Remote worker token is required');
  const onConnection=(socket:Socket)=>this.attach(socket);
  if(this.options.tlsCert||this.options.tlsKey){if(!this.options.tlsCert||!this.options.tlsKey)throw Error('TLS requires both --tls-cert and --tls-key');this.server=createTlsServer({cert:readFileSync(this.options.tlsCert),key:readFileSync(this.options.tlsKey)},onConnection);}
  else {if((this.options.host||'127.0.0.1')!=='127.0.0.1'&&(this.options.host||'')!=='::1')throw Error('Remote worker must use TLS when bound beyond loopback');this.server=createServer(onConnection);}
  await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.options.port,this.options.host||'127.0.0.1',()=>{this.server!.removeListener('error',reject);resolve();});});
  const address=this.server.address();const port=typeof address==='object'&&address?address.port:this.options.port;return{host:this.options.host||'127.0.0.1',port,tls:!!this.options.tlsCert};
 }
 async close(){if(!this.server)return;await new Promise<void>(resolve=>this.server!.close(()=>resolve()));this.server=undefined;}
 private attach(socket:Socket){let buffer='';socket.setEncoding('utf8');socket.on('data',(chunk:string)=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;void this.handle(socket,line);}});}
 private async handle(socket:Socket,line:string){let request:Request;try{request=JSON.parse(line);}catch{this.reply(socket,'?',false,'Invalid JSON');return;}if(!authorized(this.options.token,request.token)){this.reply(socket,request.id,false,'Unauthorized');return;}try{let data:any;switch(request.action){case'health':data={ok:true,active:this.pool.active().length};break;case'submit':{if(!request.crew||!request.instruction||!request.cwd||!request.parentSessionId)throw Error('submit requires crew,instruction,cwd,parentSessionId');const handle=this.pool.launch(request.crew,request.instruction,request.cwd,'remote',Math.min(300,request.seconds??300),undefined,request.parentSessionId);const remoteId='rw_'+randomUUID().replaceAll('-','');this.jobs.set(remoteId,{handle,parentSessionId:request.parentSessionId});data={remoteId,state:this.pool.status(handle,request.parentSessionId).state};break;}case'status':{const job=this.requireJob(request.remoteId);data=this.pool.status(job.handle,job.parentSessionId);break;}case'result':{const job=this.requireJob(request.remoteId);data=this.pool.result(job.handle,job.parentSessionId);break;}case'cancel':{const job=this.requireJob(request.remoteId);data=this.pool.cancelHandle(job.handle,job.parentSessionId);break;}case'events':data=this.pool.eventsSince(request.cursor??0,{limit:Math.min(100,request.cursor===undefined?100:100)});break;default:throw Error('Unknown remote worker action');}this.reply(socket,request.id,true,data);}catch(error){this.reply(socket,request.id,false,error instanceof Error?error.message:String(error));}}
 private requireJob(remoteId?:string){const job=remoteId&&this.jobs.get(remoteId);if(!job)throw Error('Unknown remote worker job');return job;}
 private reply(socket:Socket,id:string,success:boolean,data:any){socket.write(JSON.stringify({id,success,...(success?{data}:{error:data})})+'\n');}
}

export interface RemoteWorkerClientOptions {host:string;port:number;token:string;tls?:boolean;rejectUnauthorized?:boolean;}
export class RemoteWorkerClient {
 constructor(private readonly options:RemoteWorkerClientOptions){}
 request<T=any>(action:string,extra:Partial<Request>={}):Promise<T>{const id=randomUUID();return new Promise((resolve,reject)=>{const socket=this.options.tls?connectTls({host:this.options.host,port:this.options.port,rejectUnauthorized:this.options.rejectUnauthorized??true}):connect({host:this.options.host,port:this.options.port});let buffer='';const timer=setTimeout(()=>{socket.destroy();reject(Error('Remote worker request timed out'));},15000);socket.setEncoding('utf8');socket.on('data',(chunk:string)=>{buffer+=chunk;const index=buffer.indexOf('\n');if(index<0)return;clearTimeout(timer);const response=JSON.parse(buffer.slice(0,index));socket.end();if(response.id!==id)return;if(response.success)resolve(response.data);else reject(Error(response.error||'Remote worker request failed'));});socket.on('error',error=>{clearTimeout(timer);reject(error);});socket.write(JSON.stringify({id,action,token:this.options.token,...extra})+'\n');});}
 health(){return this.request('health');}
 submit(input:{crew:Crew;instruction:string;cwd:string;parentSessionId:string;seconds?:number}){return this.request('submit',input);}
 status(remoteId:string){return this.request('status',{remoteId});}
 result(remoteId:string){return this.request('result',{remoteId});}
 cancel(remoteId:string){return this.request('cancel',{remoteId});}
}


export class RemoteWorkerPool {
 readonly children=new Map<string, any>();
 private records=new Map<string,{handle:WorkerHandle;parent:string;remoteId?:string;state:string;result?:any;polling:boolean;error?:string}>();
 constructor(private readonly client:RemoteWorkerClient){}
 launch(crew:Crew,instruction:string,cwd:string,_session:string,seconds=300,_signal?:AbortSignal,parentSessionId='',tools:string[]=[]):WorkerHandle{
  if(!parentSessionId)throw Error('A bound parent session is required');
  const handle:WorkerHandle={version:1,workerId:'remote_'+randomUUID().replaceAll('-',''),parentSessionId,capability:randomUUID()};
  const record={handle,parent:parentSessionId,state:'QUEUED',polling:false} as {handle:WorkerHandle;parent:string;remoteId?:string;state:string;result?:any;polling:boolean;error?:string};
  this.records.set(handle.workerId,record);
  this.client.submit({crew,instruction,cwd,parentSessionId,seconds}).then(response=>{record.remoteId=response.remoteId;record.state=response.state||'QUEUED';this.poll(record);}).catch(error=>{record.state='FAILED';record.error=String(error);record.result={state:'FAILED',error:record.error,output:''};});
  return handle;
 }
 private poll(record:any){if(record.polling||!record.remoteId)return;record.polling=true;this.client.result(record.remoteId).then(result=>{record.result=result;record.state=result.state||record.state;}).catch(error=>{record.error=String(error);record.state='FAILED';record.result={state:'FAILED',error:record.error,output:''};}).finally(()=>{record.polling=false;if(!['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(record.state))setTimeout(()=>this.poll(record),500);});}
 result(handle:WorkerHandle,parent:string){const record=this.records.get(handle.workerId);if(!record||record.parent!==parent||handle.parentSessionId!==parent)return{state:'UNKNOWN_HANDLE'};if(!record.remoteId)return record.result||{state:record.state};this.poll(record);return record.result||{state:record.state};}
 status(handle:WorkerHandle,parent:string){const result=this.result(handle,parent);return{workerId:handle.workerId,state:result.state};}
 cancelHandle(handle:WorkerHandle,parent:string){const record=this.records.get(handle.workerId);if(!record||record.parent!==parent)return{state:'UNKNOWN_HANDLE'};record.state='CANCELLED';if(record.remoteId)this.client.cancel(record.remoteId).catch(()=>{});record.result={state:'CANCELLED',output:'',error:'Cancelled by parent/operator'};return record.result;}
 eventsSince(){return{cursor:0,events:[]};}
 async shutdown(){for(const record of this.records.values())if(record.remoteId&&['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(record.state)===false)this.client.cancel(record.remoteId).catch(()=>{});this.records.clear();}
}
