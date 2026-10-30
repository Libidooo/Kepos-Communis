import test from 'node:test';import assert from 'node:assert/strict';
const {buildServiceCommand,KEPOST_SERVICE_NAME,serviceAction}=await import('../dist/src/service.js');
test('Windows service command preserves spaces and uses the SDK daemon',()=>{const command=buildServiceCommand('C:/Users/Test User/.kepos');assert.equal(KEPOST_SERVICE_NAME,'KeposScheduler');assert.match(command,/kepos(?:-communis)?[\\/]bin[\\/]kepos\.cjs/i);assert.match(command,/daemon --home/);assert.match(command,/Test User/);});
test('service CLI stays explicit outside Windows',async()=>{assert.ok(typeof buildServiceCommand==='function');if(process.platform==='win32')return;assert.throws(()=>serviceAction('query'),/require Windows/);});
