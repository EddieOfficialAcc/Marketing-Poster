import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {archiveVersion} from '../src/archive.js';
import {sha256} from '../src/content-hash.js';
const image='data:image/png;base64,aW1hZ2UtYQ==',replacement='data:image/png;base64,aW1hZ2UtYg==';
const project=()=>({archiveCampaignId:'campaign',step:2,revision:5,template:'clean',products:[{id:'a',imageUrl:image}],icons:[{id:'i',imageUrl:image}],backgrounds:[{id:'bg',imageUrl:image}],background:image,nodes:[{price:'33'}]});
function fakeServer(){
 const assets=new Map(),uploads=[],versions=[];
 let failUpload=false,loseBeforeCommit=false;
 return {assets,uploads,versions,set failUpload(v){failUpload=v;},set loseBeforeCommit(v){loseBeforeCommit=v;},async fetch(url,options){
  if(url==='/api/archive-assets/check'){const {hashes}=JSON.parse(options.body);return {ok:true,json:async()=>({missing:hashes.filter(h=>!assets.has(h))})};}
  if(url.startsWith('/api/archive-assets/')){
   if(failUpload){failUpload=false;return {ok:false,status:503,json:async()=>({detail:'上傳失敗'})};}
   const digest=url.split('/').at(-1),bytes=Buffer.from(await options.body.arrayBuffer());
   assert.equal(createHash('sha256').update(bytes).digest('hex'),digest);assets.set(digest,bytes);uploads.push(bytes);
   return {ok:true,json:async()=>({assetHash:digest})};
  }
  assert.equal(url,'/api/archives/incremental');
  if(loseBeforeCommit){loseBeforeCommit=false;assets.clear();return {ok:false,status:409,json:async()=>({detail:{code:'missing_assets',message:'缺少素材'}})};}
  assert.ok(!options.body.includes('data:image'));const body=JSON.parse(options.body);versions.push(body);
  return {ok:true,json:async()=>({sequence:versions.length,revision:body.project.revision})};
 }};
}
test('image bytes upload once; later prices and positions only send references, including after refresh',async()=>{
 const original=globalThis.fetch,server=fakeServer();globalThis.fetch=server.fetch;
 try{
  const p=project();await archiveVersion(p);assert.equal(server.uploads.length,1);
  const ref=server.versions[0].project.products[0].imageUrl;assert.match(ref.assetHash,/^[a-f0-9]{64}$/);
  assert.equal(server.versions[0].project.step,undefined);assert.equal(p.products[0].imageUrl,image);
  p.nodes[0].price='40';p.revision++;await archiveVersion(p);assert.equal(server.uploads.length,1);
  assert.equal(server.versions[0].project.nodes[0].price,'33');assert.equal(server.versions[1].project.nodes[0].price,'40');
  const fresh=await import('../src/archive.js?fresh');await fresh.archiveVersion(p);assert.equal(server.uploads.length,1);
  p.products[0].imageUrl=replacement;p.revision++;await archiveVersion(p);assert.equal(server.uploads.length,2);
 }finally{globalThis.fetch=original;}
});
test('failed uploads never commit a version and a retry can finish; missing server assets are repaired',async()=>{
 const original=globalThis.fetch,server=fakeServer();globalThis.fetch=server.fetch;
 try{
  server.failUpload=true;await assert.rejects(archiveVersion(project()),/上傳失敗/);assert.equal(server.versions.length,0);
  await archiveVersion(project());assert.equal(server.versions.length,1);
  server.loseBeforeCommit=true;await archiveVersion(project());assert.equal(server.versions.length,2);assert.equal(server.uploads.length,2);
 }finally{globalThis.fetch=original;}
});
test('poster PNG is uploaded independently and metadata size does not grow with embedded image size',async()=>{
 const original=globalThis.fetch,server=fakeServer();globalThis.fetch=server.fetch;
 try{
  const p=project();const data='data:image/png;base64,'+Buffer.alloc(300000,7).toString('base64');
  p.products=Array.from({length:20},(_,i)=>({id:String(i),imageUrl:data}));
  const poster=new Blob(['poster'],{type:'image/png'});await archiveVersion(p,{poster,confirmedBy:'admin'});
  assert.equal(server.uploads.length,3);assert.ok(JSON.stringify(server.versions[0]).length<5000);
  assert.match(server.versions[0].poster.assetHash,/^[a-f0-9]{64}$/);assert.equal(server.versions[0].confirmed,true);
 }finally{globalThis.fetch=original;}
});
test('HTTP SHA-256 fallback matches standard hashes across block boundaries',()=>{
 for(const size of [0,3,55,56,63,64,65,1000,65536]){
  const bytes=Uint8Array.from({length:size},(_,i)=>i%251);
  assert.equal(sha256(bytes),createHash('sha256').update(bytes).digest('hex'));
 }
});
test('overlapping saves share an in-flight image upload',async()=>{
 const original=globalThis.fetch,server=fakeServer();globalThis.fetch=server.fetch;
 try{await Promise.all([archiveVersion(project()),archiveVersion(project())]);assert.equal(server.uploads.length,1);assert.equal(server.versions.length,2);}
 finally{globalThis.fetch=original;}
});
test('saving an older cutout draft repairs the second price binding before server validation',async()=>{
 const original=globalThis.fetch,server=fakeServer();globalThis.fetch=server.fetch;
 try{
  const p=project();p.products.push({id:'b-cutout',imageUrl:replacement,originalAssetId:'b',source:'cutout'});
  p.nodes=[{type:'product',productId:'a',price:'56',price2:'73',price2ProductId:'b',quantity:1,pictures:[{productId:'a'},{productId:'b-cutout'}]}];
  await archiveVersion(p);
  assert.equal(server.versions[0].project.nodes[0].price2ProductId,'b-cutout');
  assert.equal(server.versions[0].project.nodes[0].price2,'73');
  assert.equal(p.nodes[0].price2ProductId,'b','archiving repairs the snapshot without mutating the live draft');
 }finally{globalThis.fetch=original;}
});
