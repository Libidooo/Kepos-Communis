// RPC worker host. Exiting parent closes stdin; this host must not outlive it.
// No third-party dependencies and no network activity beyond Pi's own provider.
const {resolve}=require('node:path');
const {pathToFileURL}=require('node:url');
const parent=Number(process.env.ORBITAL_PARENT_PID);
let exiting=false;
function shutdown(){if(exiting)return;exiting=true;process.exit(70);}
process.stdin.on('end',shutdown);process.stdin.on('close',shutdown);
const watch=setInterval(()=>{try{if(!parent)throw Error('No parent');process.kill(parent,0);}catch(error){if(error.code!=='EPERM')shutdown();}},1000);
watch.unref();
const cli=resolve(process.argv[2]);process.argv=[process.execPath,cli,...process.argv.slice(3)];
import(pathToFileURL(cli).href).catch(error=>{process.stderr.write(String(error)+'\n');process.exit(1);});
