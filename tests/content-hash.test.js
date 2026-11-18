import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hashBlob} from '../src/content-hash.js';

test('HTTP fallback hashes large images correctly while yielding to the UI',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});
 const bytes=new Uint8Array(1024*1024).fill(123);
 let ticks=0;const timer=setInterval(()=>ticks++,0);
 try{
  assert.equal(await hashBlob(new Blob([bytes])),createHash('sha256').update(bytes).digest('hex'));
  assert.ok(ticks>0,'large image hashing must allow UI events to run');
 }finally{
  clearInterval(timer);
  if(original)Object.defineProperty(globalThis,'crypto',original);else delete globalThis.crypto;
 }
});
