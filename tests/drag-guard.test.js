import test from 'node:test';
import assert from 'node:assert/strict';
import {installDragGuard} from '../src/drag-guard.js';
function setup(){
 const surface=new EventTarget(),root=new EventTarget(),host=new EventTarget(),scheduled=[];let finishes=0;
 const guard=installDragGuard(surface,()=>finishes++,{root,host,defer:fn=>scheduled.push(fn)});
 const emit=(target,type,props={})=>{const e=new Event(type);Object.assign(e,{pointerId:1,pointerType:'mouse',button:0,buttons:1,isPrimary:true},props);target.dispatchEvent(e);};
 return {surface,root,host,guard,emit,flush:()=>scheduled.splice(0).forEach(fn=>fn()),count:()=>finishes};
}
test('release outside canvas finishes after normal pointerup processing',()=>{
 const c=setup();c.emit(c.surface,'pointerdown');const before=c.count();
 c.emit(c.root,'pointerup',{buttons:0});assert.equal(c.count(),before);c.flush();assert.equal(c.count(),before+1);
});
test('missed release is detected before the next mouse move reaches the editor',()=>{
 const c=setup();c.emit(c.surface,'pointerdown');const before=c.count();
 c.emit(c.root,'pointermove',{buttons:0});assert.equal(c.count(),before+1);
});
test('deferred old release cannot terminate a newly started drag',()=>{
 const c=setup();c.emit(c.surface,'pointerdown');c.emit(c.root,'pointerup',{buttons:0});
 c.emit(c.surface,'pointerdown');const before=c.count();c.flush();assert.equal(c.count(),before);
});
test('cancellation, lost capture, blur, hiding and page switch all end gestures',()=>{
 const c=setup();c.emit(c.surface,'pointerdown');let before=c.count();
 c.emit(c.root,'pointercancel');assert.equal(c.count(),++before);
 c.emit(c.surface,'lostpointercapture');c.flush();assert.equal(c.count(),++before);
 c.emit(c.host,'blur');assert.equal(c.count(),++before);
 c.root.hidden=true;c.emit(c.root,'visibilitychange');assert.equal(c.count(),++before);
 c.guard.stop();assert.equal(c.count(),++before);
});
