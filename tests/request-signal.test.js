import test from 'node:test';
import assert from 'node:assert/strict';
import {requestSignal} from '../src/request-signal.js';

test('requests remain usable without AbortSignal.timeout and still time out',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(AbortSignal,'timeout');
 Object.defineProperty(AbortSignal,'timeout',{configurable:true,value:undefined});
 try{
  const signal=requestSignal(5);
  assert.equal(signal.aborted,false);
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(signal.aborted,true);
  assert.equal(signal.reason.name,'TimeoutError');
 }finally{Object.defineProperty(AbortSignal,'timeout',descriptor);}
});
