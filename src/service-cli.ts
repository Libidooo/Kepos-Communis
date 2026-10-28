import {installService,serviceAction} from './service.ts';
import {appPaths,preparePaths,type AppPaths} from './config.ts';
export function serviceCommand(options:any,paths:AppPaths):void{
 const action=options.args[0]||'query';
 if(action==='install'){preparePaths(paths);console.log(installService(paths.home));return;}
 if(!['start','stop','delete','query'].includes(action))throw Error('Usage: kepos service install|start|stop|delete|query');
 console.log(serviceAction(action as any));
}
