import test from 'node:test';
import assert from 'node:assert/strict';
import {importPdfPage} from '../src/pdf-import.js';

test('single-page PDF imports directly without creating a preview or confirmation dialog',async()=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url)=>{calls.push(url);return url.endsWith('/info')?new Response(JSON.stringify({pages:1}),{headers:{'Content-Type':'application/json'}}):new Response(JSON.stringify({version:1,background:'data:image/png;base64,YQ==',products:[]}));};
 try{const result=await importPdfPage(new File(['%PDF'], 'poster.pdf',{type:'application/pdf'}));assert.equal(result.name,'poster - 第1頁.png');assert.equal(result.type,'image/png');assert.deepEqual(calls,['/api/poster-pdf/info','/api/poster-pdf/rebuild?page=1']);}
 finally{globalThis.fetch=original;}
});
test('invalid PDF metadata stops before rendering',async()=>{
 const original=globalThis.fetch;let count=0;globalThis.fetch=async()=>{count++;return new Response(JSON.stringify({pages:0}));};
 try{await assert.rejects(importPdfPage(new File(['%PDF'],'bad.pdf')),/頁數/);assert.equal(count,1);}finally{globalThis.fetch=original;}
});
