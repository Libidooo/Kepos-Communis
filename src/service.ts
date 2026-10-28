import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {packageRoot} from './config.ts';

export const KEPOST_SERVICE_NAME='KeposScheduler';
function quote(value:string):string{return '"'+value.replaceAll('"','\\"')+'"';}
export function buildServiceCommand(home:string):string {
 return `${quote(process.execPath)} ${quote(join(packageRoot,'bin','kepos.cjs'))} daemon --home ${quote(home)}`;
}
function runSc(args:string[]):string {
 if(process.platform!=='win32')throw Error('Windows Service commands require Windows');
 const result=spawnSync('sc.exe',args,{encoding:'utf8',windowsHide:true});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error((result.stderr||result.stdout||`sc.exe failed with ${result.status}`).trim());
 return (result.stdout||'').trim();
}
export function installService(home:string,displayName='Kepos Scheduler'):string {
 const command=buildServiceCommand(home);
 try{runSc(['stop',KEPOST_SERVICE_NAME]);}catch{}
 try{runSc(['delete',KEPOST_SERVICE_NAME]);}catch{}
 return runSc(['create',KEPOST_SERVICE_NAME,'binPath=',command,'DisplayName=',displayName,'start=','auto','obj=','LocalSystem']);
}
export function serviceAction(action:'start'|'stop'|'delete'|'query'):string {return runSc([action,KEPOST_SERVICE_NAME]);}
