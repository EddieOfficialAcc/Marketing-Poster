import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rememberCutout,recoverCutout,cutoutProgress} from '../src/cutout-recovery.js';
const storage=()=>{const data=new Map();return {setItem:(k,v)=>data.set(k,v),getItem:k=>data.get(k),removeItem:k=>data.delete(k)};};
test('task recovery does not depend on shared draft writes and is scoped to campaign',()=>{
 const store=storage(),project={archiveCampaignId:'a',products:[{id:'photo'}]},pending={jobId:'job-1',assetId:'photo',remaining:[]};
 assert.equal(rememberCutout(project,pending,store),true);assert.deepEqual(recoverCutout(project,store),pending);
 assert.equal(recoverCutout({...project,archiveCampaignId:'b'},store),null);
 assert.equal(recoverCutout({...project,products:[]},store),null);
 rememberCutout(project,null,store);assert.equal(recoverCutout(project,store),null);
});
test('unavailable recovery storage cannot stop image processing',()=>{
 const denied={setItem(){throw new Error('quota');},getItem(){throw new Error('denied');}};
 assert.equal(rememberCutout({archiveCampaignId:'a'},{jobId:'x'},denied),false);assert.equal(recoverCutout({archiveCampaignId:'a'},denied),null);
});
test('progress distinguishes queue, download and processing time',()=>{
 assert.match(cutoutProgress({stage:'queued',state:'queued',ahead:2,created:100},165000),/前面有 2.*已等待 1分5秒/);
 assert.match(cutoutProgress({stage:'download:35:1',state:'running',started:160},165000),/下載模型 35%.*5秒/);
 assert.match(cutoutProgress({stage:'processing',state:'running',started:160},165000),/正在去除背景/);
});
test('submitted job is followed even when the draft cannot be written',async()=>{
 const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('async function startCutout('),source.indexOf('async function followCutout('));
 let followed=false,queued=false;const labels=new Map(),store=storage();
 const context={cutoutBusy:false,cutoutDraft:null,project:{archiveCampaignId:'a',products:[{id:'photo'}]},provider:{get:async()=>({imageUrl:'image'})},
 $:selector=>{if(!labels.has(selector))labels.set(selector,{showModal(){},removeAttribute(){}});return labels.get(selector);},
 cutoutSource:async()=>({type:'image/png'}),cutoutResponse:async()=>({json:async()=>({id:'job-1'})}),
 rememberCutout:(p,task)=>rememberCutout(p,task,store),queueSave:()=>{queued=true;},
 saveProject:async()=>{throw Object.assign(new Error('conflict'),{code:'DRAFT_CONFLICT'});},
 followCutout:async task=>{assert.equal(task.jobId,'job-1');followed=true;},cutoutFailure:()=> 'failed',toast:()=>{}};
 vm.createContext(context);vm.runInContext(fn,context);await context.startCutout('photo');
 assert.ok(followed);assert.ok(queued);assert.equal(context.cutoutBusy,false);assert.equal(recoverCutout(context.project,store).jobId,'job-1');
});
