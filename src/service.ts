import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {packageRoot} from './config.ts';

export const KEPOST_SERVICE_NAME='KeposScheduler';
function quote(value:string):string{return '"'+value.replaceAll('"','\\"')+'"';}
export function buildServiceCommand(home:string):string {
 return `${quote(process.execPath)} ${quote(join(packageRoot,'bin','kepos.cjs'))} daemon --home ${quote(home)}`;
}
function serviceArguments(home:string):string {
 return `${quote(join(packageRoot,'bin','kepos.cjs'))} daemon --home ${quote(home)}`;
}
function runTool(command:string,args:string[]):string {
 if(process.platform!=='win32')throw Error('Windows autostart commands require Windows');
 const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error((`${result.stderr||''}${result.stdout||''}`||`${command} failed with ${result.status}`).trim());
 return (result.stdout||'').trim();
}
function runTask(args:string[]):string {return runTool('schtasks.exe',args);}
function runPowerShell(script:string):string {return runTool('powershell.exe',['-NoProfile','-NonInteractive','-Command',script]);}
function psQuote(value:string):string {return "'"+value.replaceAll("'","''")+"'";}
// node.exe does not implement the Windows service protocol, so sc.exe registration
// starts and then dies with error 1053. schtasks /SC ONLOGON would need elevation.
// A per-user logon trigger via Register-ScheduledTask needs no admin rights.
export function installService(home:string):string {
 runPowerShell([
  `$action=New-ScheduledTaskAction -Execute ${psQuote(quote(process.execPath))} -Argument ${psQuote(serviceArguments(home))}`,
  `$trigger=New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
  `Register-ScheduledTask -TaskName ${psQuote(KEPOST_SERVICE_NAME)} -Action $action -Trigger $trigger -Description ${psQuote('Kepos daemon, starts at logon')} -ErrorAction Stop | Out-Null`,
 ].join('; '));
 return `Scheduled task ${KEPOST_SERVICE_NAME} registered: kepos daemon starts at logon (no admin required). It does not run before you sign in. Start now with: kepos service start`;
}
export function serviceAction(action:'start'|'stop'|'delete'|'query'):string {
 if(action==='delete')return runPowerShell(`Unregister-ScheduledTask -TaskName ${psQuote(KEPOST_SERVICE_NAME)} -Confirm:$false -ErrorAction Stop; Write-Output 'Removed ${KEPOST_SERVICE_NAME}'`);
 const flags:{[key:string]:string[]}={start:['/Run'],stop:['/End'],query:['/Query','/FO','LIST']};
 return runTask([...flags[action],'/TN',KEPOST_SERVICE_NAME]);
}
