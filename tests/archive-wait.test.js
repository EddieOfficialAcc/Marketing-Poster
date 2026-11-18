import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForArchive} from '../src/archive.js';
test('archive wait preserves success and reports stalled sync without advancing',async()=>{
 assert.equal(await waitForArchive(Promise.resolve('saved'),{timeoutMs:100}),'saved');
 let advanced=false;
 await assert.rejects(async()=>{await waitForArchive(new Promise(()=>{}),{timeoutMs:10});advanced=true;},/原項目保留/);
 assert.equal(advanced,false);
});
test('archive wait preserves backend errors for retry',async()=>{
 const failure=new Error('server down');
 await assert.rejects(waitForArchive(Promise.reject(failure)),failure);
});
