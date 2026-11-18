import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('expired same-origin asset requests redirect to login',async()=>{
 const source=(await readFile(new URL('../src/session.js',import.meta.url),'utf8')).split('\ntry{')[0].replace(/^import .*;\n/gm,'');
 const redirects=[],location={href:'http://localhost:6690/',origin:'http://localhost:6690',replace:url=>redirects.push(url)};
 const window={fetch:async()=>({status:401})};
 vm.runInNewContext(source,{window,location,URL,Request});
 await window.fetch('/output/evaluation/membership-background-v1.png');
 await window.fetch('/api/archives');
 await window.fetch('https://external.example/image.png');
 assert.deepEqual(redirects,['/login.html','/login.html']);
});

test('HTML background responses are never cached, and a later valid image can save',async()=>{
 const originalFetch=globalThis.fetch,originalReader=globalThis.FileReader;
 const {archiveVersion}=await import('../src/archive.js?invalid-background');
 let valid=false,requests=0,commits=0;
 globalThis.FileReader=class{readAsDataURL(blob){blob.arrayBuffer().then(bytes=>{this.result='data:'+blob.type+';base64,'+Buffer.from(bytes).toString('base64');this.onload();});}};
 globalThis.fetch=async url=>{
  if(url.startsWith('output/')){requests++;return new Response(valid?new Blob(['png'],{type:'image/png'}):'<html>login</html>',{headers:{'Content-Type':valid?'image/png':'text/html'}});}
  if(url.endsWith('/check'))return Response.json({missing:[]});
  commits++;return Response.json({});
 };
 try{
  const project={template:'membership',products:[],nodes:[]};
  for(let i=0;i<3;i++)await assert.rejects(archiveVersion(project),/不是有效圖片/);
  assert.equal(requests,3);assert.equal(commits,0);
  valid=true;await archiveVersion(project);await archiveVersion(project);
  assert.equal(requests,4);assert.equal(commits,2);
 }finally{globalThis.fetch=originalFetch;globalThis.FileReader=originalReader;}
});

test('missing cutout is cleared and persisted; transient failure retains pending job',async()=>{
 const source=await readFile(new URL('../src/app.js',import.meta.url),'utf8');
 const fn=source.slice(source.indexOf('async function followCutout('),source.indexOf('async function loadCutoutResult('));
 for(const status of [404,503]){
  const pending={jobId:'expired'},project={cutoutPending:pending,products:[{id:'original'}]},saved=[],label={};
  const context={project,structuredClone,rememberCutout:()=>{},queueSave:()=>saved.push(structuredClone(project)),$:()=>label,loadCutoutResult:async()=>{throw Object.assign(new Error('missing'),{status});}};
  vm.createContext(context);vm.runInContext(fn,context);
  if(status===404){await context.followCutout(pending,project);assert.equal(project.cutoutPending,undefined);assert.equal(saved[0].cutoutPending,undefined);assert.equal(saved[0].products.length,1);}
  else{await assert.rejects(context.followCutout(pending,project));assert.equal(project.cutoutPending,pending);assert.equal(saved.length,0);}
 }
});
