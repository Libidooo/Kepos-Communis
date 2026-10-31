// RPC worker host. Exiting parent closes stdin; this host must not outlive it.
// No third-party dependencies and no network activity beyond Pi's own provider.
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const parent=Number(process.env.ORBITAL_PARENT_PID);
let exiting=false;let lastSignal=Date.now();
function shutdown(){if(exiting)return;exiting=true;process.exit(70);}
process.stdin.on('end',shutdown);process.stdin.on('close',shutdown);
// A data listener before Pi's async startup would switch stdin to flowing and discard
// its first RPC commands. Pause until Pi installs its own reader, THEN pair the
// watchdog listener and resume. cli.js's import finishing is not RPC readiness.
process.stdin.pause();
function pairReader(event){
 if(event!=='data')return;
 process.stdin.off('newListener',pairReader);
 // newListener fires BEFORE the reader is added; resume only after that stack returns.
 queueMicrotask(()=>{
  if(exiting)return;
  process.stdin.on('data',()=>{lastSignal=Date.now();});
  process.stdin.resume();
 });
}
process.stdin.on('newListener',pairReader);
// PID reuse can fool kill(parent, 0); the parent's 10-second pings also bound silence.
const watch=setInterval(()=>{
 try{if(!Number.isInteger(parent)||parent<=0)throw Error('No parent');process.kill(parent,0);}catch(error){if(error.code!=='EPERM')shutdown();}
 if(Date.now()-lastSignal>60000)shutdown();
},1000);
watch.unref();
const cli=resolve(process.argv[2]);process.argv=[process.execPath,cli,...process.argv.slice(3)];
import(pathToFileURL(cli).href).catch(error=>{process.stderr.write(String(error)+'\n');process.exit(1);});
