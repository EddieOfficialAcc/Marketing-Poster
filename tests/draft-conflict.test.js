import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// Serialized transaction harness: writes become visible only on commit;
// aborts discard every write, just as IndexedDB read/write transactions do.
function database(initial){
 const records=new Map(Object.entries(initial)),waiting=[];let active=false;
 function pump(){
  if(active||!waiting.length)return;
  active=true;const {tx,ops}=waiting.shift(),pending=new Map(records);let aborted=false;
  tx.abort=()=>{aborted=true;};
  function step(){
   if(aborted){tx.onabort?.();finish();return;}
   const op=ops.shift();
   if(op){op(pending);queueMicrotask(step);}
   else{records.clear();for(const [k,v] of pending)records.set(k,v);tx.oncomplete?.();finish();}
  }
  function finish(){active=false;queueMicrotask(pump);}
  queueMicrotask(step);
 }
 return {records,transaction(){
  const ops=[],tx={objectStore(){return {
   get(key){const request={};ops.push(data=>{request.result=structuredClone(data.get(key));request.onsuccess?.();});return request;},
   put(value,key){ops.push(data=>data.set(key,structuredClone(value)));}
  };}};
  waiting.push({tx,ops});queueMicrotask(pump);return tx;
 }};
}
const source=(await readFile(new URL('../src/products.js',import.meta.url),'utf8')).split('// Storage revision')[1].replaceAll('export async function','async function');
function tab(db){const context=vm.createContext({database:async()=>db});vm.runInContext('// Storage revision'+source,context);return context;}
test('stale tab cannot overwrite newer draft; reload reads winning changes',async()=>{
 const db=database({current:{name:'old',stores:'old'}}),a=tab(db),b=tab(db);
 const pa=await a.loadProject(),pb=await b.loadProject();
 pa.name='new campaign';await a.saveProject(pa);
 pb.stores='new stores';await assert.rejects(b.saveProject(pb),{code:'DRAFT_CONFLICT'});
 assert.equal(db.records.get('current').name,'new campaign');
 assert.equal(db.records.get('current').stores,'old');
 assert.equal(pb.stores,'new stores'); // losing in-memory copy remains exportable
 await assert.rejects(b.saveProject(pb),{code:'DRAFT_CONFLICT'});
 const refreshed=await b.loadProject();refreshed.stores='new stores';await b.saveProject(refreshed);
 assert.equal(db.records.get('current').name,'new campaign');assert.equal(db.records.get('current').stores,'new stores');
});
test('simultaneous first saves have exactly one winner; repeated same-tab saves work',async()=>{
 const db=database({}),a=tab(db),b=tab(db);
 await Promise.all([a.loadProject(),b.loadProject()]);
 const results=await Promise.allSettled([a.saveProject({name:'A'}),b.saveProject({name:'B'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'DRAFT_CONFLICT');
 const winner=results[0].status==='fulfilled'?a:b;
 await Promise.all([winner.saveProject({name:'second'}),winner.saveProject({name:'third'})]);
 assert.equal(db.records.get('current').name,'third');assert.equal(db.records.get('current-revision'),3);
});
test('save without successful load refuses to replace existing draft',async()=>{
 const db=database({current:{name:'keep'}}),a=tab(db);
 await assert.rejects(a.saveProject({name:'replace'}),/尚未成功讀取/);
 assert.equal(db.records.get('current').name,'keep');
});
