import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultProject,parseBackup} from '../src/model.js';
import {cleanTemplateElements} from '../src/template-layout.js';
import {sizeInfo} from '../src/sizing.js';
import {archiveVersion} from '../src/archive.js';
const oldImage='data:image/png;base64,b2xk',newImage='data:image/png;base64,bmV3';
test('built-in restore snapshots its image once; a later custom background survives restore',async()=>{
 const first={...defaultProject(),template:'membership',templateImage:oldImage};
 const restored=parseBackup(JSON.stringify(first));
 assert.equal(restored.template,'custom');assert.equal(restored.background,oldImage);assert.equal(restored.templateImage,undefined);
 restored.background=newImage;restored.templateImage=oldImage; // simulate an older buggy saved version
 const next=parseBackup(JSON.stringify(restored));assert.equal(next.background,newImage);assert.equal(next.templateImage,undefined);
 const fetch=globalThis.fetch;
 try{globalThis.fetch=async(url,options)=>{if(url==='/api/archive-assets/check')return {ok:true,json:async()=>({missing:[]})};const data=JSON.parse(options.body);assert.match(data.project.background.assetHash,/^[a-f0-9]{64}$/);assert.equal(data.project.templateImage,undefined);return {ok:true,json:async()=>({})};};await archiveVersion(restored);}finally{globalThis.fetch=fetch;}
});
test('clean template text frames fit narrow sizes and leave export status strip clear',()=>{
 for(const page of [{width:1080,height:1080,unit:'px',dpi:150},{width:1080,height:1920,unit:'px',dpi:150},{width:210,height:297,unit:'mm',dpi:150},{width:1920,height:1080,unit:'px',dpi:150}]){
  const p={...defaultProject(),page};p.campaign={name:'會員優惠',start:'2026-11-01',end:'2026-11-30',stores:'全線門店'};
  const {w,h}=sizeInfo(p),items=cleanTemplateElements(p);
  for(const e of items){assert.ok(e.x>=0&&e.y>=0&&e.x+e.w<=w+.001&&e.y+e.h<=h-39+.001);}
  assert.ok(items.some(e=>e.value?.includes('2026-11-30')));assert.ok(items.some(e=>e.value==='全線門店'));
 }
});
test('malformed backups report a project error before migration touches their structure',()=>{
 for(const value of [null,[],{},'text',{schema:1,campaign:{},products:[],nodes:[null]}])assert.throws(()=>parseBackup(JSON.stringify(value)),/海報專案備份/);
 assert.throws(()=>parseBackup('{'),/JSON 備份/);
});

test('moving a small icon does not silently enlarge its frame',async()=>{
 const {clampNodeTransform}=await import('../src/sizing.js');
 assert.deepEqual(clampNodeTransform({x:80,y:90,w:16,h:9},540,960),{x:80,y:90,w:16,h:9});
 assert.deepEqual(clampNodeTransform({x:535,y:955,w:16,h:9},540,960),{x:524,y:951,w:16,h:9});
});
