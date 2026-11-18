import test from 'node:test';
import assert from 'node:assert/strict';
import {posterSelection,selectOnPoster} from '../src/poster-selection.js';
const project={canvasSpace:2,page:{width:1000,height:1000,unit:'px',dpi:150}};
test('canvas framing accounts for letterboxing and converts to original-image coordinates',()=>{
 const b=posterSelection(project,1000,500,{x:.2,y:.3},{x:.6,y:.6});
 assert.equal(b.x,.2);assert.equal(b.y,.1);assert.ok(Math.abs(b.w-.4)<1e-8);assert.equal(b.h,.6);
});
test('framing supports moved backgrounds, reverse drags, and rejects areas outside the image',()=>{
 const p={...project,backgroundPlacement:{x:100,y:100,w:300,h:200}};
 const b=posterSelection(p,1000,500,{x:.8,y:.6},{x:.2,y:.2});assert.deepEqual(b,{x:0,y:0,w:1,h:1});
 assert.throws(()=>posterSelection(project,1000,500,{x:.1,y:0},{x:.5,y:.1}),/框選/);
});

test('scrolling keeps framing active and uses updated screen coordinates',async()=>{
 const oldDocument=globalThis.document,oldWindow=globalThis.window,events={},elements=[];
 const eventTarget={addEventListener:(name,fn)=>events[name]=fn,removeEventListener:(name)=>delete events[name]};
 globalThis.window=eventTarget;globalThis.document={...eventTarget,body:{append(){}},createElement(){const el={style:{},append(){},remove(){this.removed=true;},setPointerCapture(){}};elements.push(el);return el;}};
 try{
  let bounds={left:100,top:200,width:400,height:600},selected;
  selectOnPoster({getBoundingClientRect:()=>bounds},(a,b)=>{selected={a,b};},e=>{throw e;});
  const layer=elements[0];bounds={...bounds,top:100};events.scroll();assert.equal(layer.removed,undefined);assert.equal(layer.style.top,'100px');
  layer.onpointerdown({button:0,clientX:140,clientY:160,pointerId:1,preventDefault(){}});
  layer.onpointerup({clientX:300,clientY:400});await Promise.resolve();
  assert.deepEqual(selected,{a:{x:.1,y:.1},b:{x:.5,y:.5}});assert.equal(layer.removed,true);assert.equal(events.scroll,undefined);
 }finally{globalThis.document=oldDocument;globalThis.window=oldWindow;}
});
