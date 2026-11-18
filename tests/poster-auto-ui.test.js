import test from 'node:test';
import assert from 'node:assert/strict';
import {installPosterAuto} from '../src/poster-auto-ui.js';

test('generation does not rebuild selected rows; errors stay beside retry and successful retry closes the dialog',async()=>{
 const original={document:globalThis.document,fetch:globalThis.fetch,requestAnimationFrame:globalThis.requestAnimationFrame};
 const elements=new Map();let tableWrites=0,closed=false,calls=0,rejectGeneration;
 class Element{
  constructor(){this.hidden=false;this.files=[];this.value='';this.dataset={};this.listeners={};}
  set innerHTML(value){this.html=value;if(this===elements.get('[data-auto-rows]'))tableWrites++;}
  get innerHTML(){return this.html||'';}
  querySelector(key){if(!elements.has(key))elements.set(key,new Element());return elements.get(key);}
  querySelectorAll(){return [...elements.values()].filter(el=>el!==elements.get('[data-auto-apply]'));}
  addEventListener(key,fn){this.listeners[key]=fn;}replaceChildren(){}setAttribute(){}scrollIntoView(){}close(){closed=true;}
 }
 const dialog=new Element();const $=key=>dialog.querySelector(key);
 let project={products:[]};
 const row={name:'A / B',code:'A',sku:'A',price:'56',price2:'73',quantity:1,code2:'B',libraryProducts:[{id:'a',name:'A'}],companion:{code:'B',name:'B',libraryProducts:[{id:'b',name:'B'}]}};
 const analysis={version:1,pageWidth:1000,pageHeight:1400,slots:[{id:1,box:[30,300,300,400],imageBox:[30,300,300,280],textBox:[30,590,300,100],priceBox:[195,588,120,100],region:{box:[.03,.2,.3,.3],color:'#fff7e4'}}],warnings:[]};
 try{
  globalThis.document={createElement:()=>dialog,body:{append(){}},querySelector:()=>new Element()};
  globalThis.requestAnimationFrame=fn=>fn();
  globalThis.fetch=async url=>({ok:true,json:async()=>url.includes('import-campaign')?{rows:[row]}:analysis});
  installPosterAuto({getProject:()=>project,savedPosters:{},provider:{},productOptions:()=>'',toast:()=>{},renderPoster:()=>{},createProject:async(a,plan,{onProgress})=>{
   calls++;assert.equal(plan.pairs[0].row.assetId,'a');assert.equal(plan.pairs[0].row.companion.assetId,'b');
   if(calls===1){onProgress('正在保存目前項目…');return new Promise((resolve,reject)=>{rejectGeneration=reject;});}
   project={products:[]};return [{productId:'a'}];
  }});
  $('[data-auto-source]').hidden=true;$('[data-auto-sheet]').files=[{name:'real.xlsx'}];$('[data-auto-pdf]').files=[{name:'poster.jpg',type:'image/jpeg'}];
  await $('[data-auto-run]').onclick();const writes=tableWrites;
  const pending=$('[data-auto-apply]').onclick();await $('[data-auto-apply]').onclick();
  assert.equal(calls,1);assert.equal(tableWrites,writes);assert.equal($('[data-auto-apply]').disabled,true);
  rejectGeneration(new Error('第二件獨立售價或對應商品無效'));await pending;
  assert.equal(tableWrites,writes);assert.match($('[data-auto-apply-status]').textContent,/第二件獨立售價/);assert.equal($('[data-auto-apply]').disabled,false);assert.equal(closed,false);
  await $('[data-auto-apply]').onclick();assert.equal(calls,2);assert.equal(closed,true);assert.equal($('[data-auto-preview]').hidden,true);
 }finally{for(const [key,value] of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
