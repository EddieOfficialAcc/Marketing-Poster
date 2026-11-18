import test from 'node:test';
import assert from 'node:assert/strict';
import {cutoutSource,cutoutResponse,cutoutFailure} from '../src/cutout-client.js';
test('uploaded base64 is decoded without any fetch',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=()=>{throw new Error('must not fetch');};
 try{const blob=await cutoutSource('data:image/png;base64,aGVsbG8=');assert.equal(blob.type,'image/png');assert.equal(await blob.text(),'hello');}
 finally{globalThis.fetch=original;}
});
test('network failure is readable and HTTP status is preserved for expired jobs',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async()=>{throw new TypeError('Load failed');};
  await assert.rejects(cutoutResponse('/api/cutout-jobs'),/無法連接服務/);
  globalThis.fetch=async()=>Response.json({detail:'找不到抠圖任務'},{status:404});
  await assert.rejects(cutoutResponse('/api/cutout-jobs/id'),{status:404});
 }finally{globalThis.fetch=original;}
});
test('recovery is only offered when the current submission has a job id',()=>{
 const error=new Error('Load failed');
 assert.match(cutoutFailure(error,'提交圖片',null),/尚未取得任務編號/);
 assert.doesNotMatch(cutoutFailure(error,'提交圖片',null),/查看抠圖任務/);
 assert.match(cutoutFailure(error,'取得結果','job-1'),/job-1.*查看抠圖任務/);
});

test('failed submission probes health without repeating the image POST',async()=>{
 const original=globalThis.fetch,calls=[];
 try{
  globalThis.fetch=async(url,options)=>{calls.push([url,options.method||'GET']);if(url==='/api/health')return Response.json({service:'cutout'});throw new TypeError('Load failed');};
  await assert.rejects(cutoutResponse('/api/cutout-jobs',{method:'POST',body:new Blob(['image'])}),/健康檢查正常/);
  assert.deepEqual(calls,[['/api/cutout-jobs','POST'],['/api/health','GET']]);
 }finally{globalThis.fetch=original;}
});
