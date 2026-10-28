import test from 'node:test';
import assert from 'node:assert/strict';
import {outputPage,receiptView} from '../dist/terminal/result-view.js';
import {TimingWindow} from '../dist/terminal/metrics.js';
test('evidence pages reconstruct output including emoji without splitting surrogates',()=>{
 const output='hello😀中文'.repeat(1000);let cursor=0,reconstructed='';
 do{const page=outputPage(output,{cursor,maxChars:201});assert.ok(page.output.length<=201);assert.ok(!/[\uD800-\uDBFF]$/.test(page.output));reconstructed+=page.output;cursor=page.nextCursor;}while(cursor!==null);
 assert.equal(reconstructed,output);assert.equal(outputPage(output).output.length<=1600,true);
 assert.throws(()=>outputPage(output,{cursor:-1}),/cursor/);
});
test('receipt previews omit full profiles but preserve result identity and pagination',()=>{
 const view=receiptView({version:1,state:'SUCCEEDED',workerId:'id',resultHash:'immutable',output:'x'.repeat(8000),profileSnapshot:{role:'large role'},profileRevision:'rev'},{});
 assert.equal(view.resultHash,'immutable');assert.equal(view.profileSnapshot,undefined);assert.equal(view.nextCursor,1600);assert.equal(view.profileRevision,'rev');
});
test('metrics keep a bounded window and report quantiles separately from total samples',()=>{
 const metric=new TimingWindow(10);for(let n=0;n<100;n++)metric.observe(n);const result=metric.snapshot();assert.equal(result.count,100);assert.equal(result.windowCount,10);assert.equal(result.p95Ms,98);
});
