import {repairPairedPriceBindings} from './paired-prices.js';
import {requestSignal} from './request-signal.js';
import {hashBlob} from './content-hash.js';
const templatePaths={membership:'output/evaluation/membership-background-v1.png',promotion:'output/evaluation/promotion-background-v1.png'};
const templates=new Map(),hashes=new Map(),blobHashes=new WeakMap(),uploads=new Map();
export function blobData(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('無法讀取圖片資料'));reader.readAsDataURL(blob);});}
async function request(url,options){
 const response=await fetch(url,{...options,signal:requestSignal(120000)});
 if(!response.ok){const data=await response.json().catch(()=>null),detail=data?.detail;const error=new Error(typeof detail==='string'?detail:detail?.message||`伺服器存檔失敗 (${response.status})`);error.status=response.status;error.detail=detail;throw error;}
 return response.json();
}
function imageBlob(source){
 if(source instanceof Blob)return source;
 const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source);
 if(!match)throw new Error('存檔圖片格式不正確');
 const raw=atob(match[2]),bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
 return new Blob([bytes],{type:match[1]});
}
async function sourceHash(source){
 const cache=source instanceof Blob?blobHashes:hashes;
 if(!cache.has(source))cache.set(source,hashBlob(imageBlob(source)).catch(error=>{cache.delete(source);throw error;}));
 return cache.get(source);
}
async function syncImages(resources,onProgress){
 const {missing}=await request('/api/archive-assets/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hashes:[...resources.keys()]})});
 let next=0,done=0;onProgress?.({phase:'upload',done,total:missing.length});
 // Bound memory/network usage for large libraries; do not decode all images at once.
 await Promise.all(Array.from({length:Math.min(2,missing.length)},async()=>{
  while(next<missing.length){
   const digest=missing[next++],source=resources.get(digest);
   if(source===undefined)throw new Error('伺服器回傳未知的圖片校驗碼');
   if(!uploads.has(digest)){
    const blob=imageBlob(source);
    uploads.set(digest,request(`/api/archive-assets/${digest}`,{method:'PUT',headers:{'Content-Type':blob.type},body:blob}).then(result=>{if(result.assetHash!==digest)throw new Error('圖片上傳校驗失敗');}).finally(()=>uploads.delete(digest)));
   }
   await uploads.get(digest);onProgress?.({phase:'upload',done:++done,total:missing.length});
  }
 }));
}
export async function archiveVersion(project,{poster=null,confirmedBy='',onProgress}={}){
 const snapshot=structuredClone(project);
 repairPairedPriceBindings(snapshot);
 delete snapshot.step;delete snapshot.archiveReceipt;
 const path=templatePaths[snapshot.template];
 if(path){
  if(!templates.has(path)){
   const response=await fetch(path);
   if(response.status===401)throw new Error('登入已過期，請重新登入');
   if(!response.ok)throw new Error('底圖無法載入，尚未存檔');
   const blob=await response.blob();
   if(!/^image\/(png|jpeg|webp)$/.test(blob.type)||!blob.size)throw new Error('底圖回應不是有效圖片，請重新登入或稍後重試');
   templates.set(path,await blobData(blob));
  }
  snapshot.templateImage=templates.get(path);
 }else delete snapshot.templateImage;
 if(snapshot.template==='retail'){
  for(const [key,path] of [['retailHeader','assets/retail/header.png'],['retailLogo','assets/retail/logo.png']])if(!snapshot[key]){
   if(!templates.has(path)){const response=await fetch(path);if(!response.ok)throw new Error('品牌素材無法載入');templates.set(path,await blobData(await response.blob()));}
   snapshot[key]=templates.get(path);
  }
 }
 const resources=new Map(),sources=new Set();onProgress?.({phase:'check'});
 async function reference(source){const digest=await sourceHash(source);resources.set(digest,source);sources.add(source);return {assetHash:digest};}
 for(const collection of ['products','icons','backgrounds'])for(const asset of snapshot[collection]||[])asset.imageUrl=await reference(asset.imageUrl);
 for(const key of ['background','templateImage','retailHeader','retailLogo'])if(snapshot[key])snapshot[key]=await reference(snapshot[key]);
 const posterRef=poster?await reference(poster):null;
 for(const key of hashes.keys())if(!sources.has(key))hashes.delete(key);
 const body=JSON.stringify({latestOnly:true,campaignId:snapshot.archiveCampaignId,project:snapshot,poster:posterRef,confirmed:!!confirmedBy,confirmedBy});
 if(new TextEncoder().encode(body).length>2*1024*1024)throw new Error('活動資料超過 2 MB，請減少過長的文字或非圖片資料');
 for(let attempt=0;attempt<2;attempt++){
  await syncImages(resources,onProgress);onProgress?.({phase:'save'});
  try{return await request('/api/archives/incremental',{method:'POST',headers:{'Content-Type':'application/json'},body});}
  catch(error){if(attempt||error.status!==409||error.detail?.code!=='missing_assets')throw error;}
 }
}
export const listArchives=(offset=0)=>request(`/api/archives?latest_only=true&offset=${offset}`);
export const getArchive=id=>request(`/api/archives/${encodeURIComponent(id)}/project`);

export const deleteCampaign=id=>request(`/api/campaigns/${encodeURIComponent(id)}`,{method:'DELETE'});

export const getArchiveDetails=id=>request(`/api/archives/${encodeURIComponent(id)}`);
export const deleteArchiveVersion=id=>request(`/api/archives/${encodeURIComponent(id)}`,{method:'DELETE'});

export function waitForArchive(promise,{timeoutMs=180000,onTick=()=>{}}={}){
 return new Promise((resolve,reject)=>{
  const started=Date.now();
  const interval=setInterval(()=>onTick(Math.floor((Date.now()-started)/1000)),1000);
  const timeout=setTimeout(()=>{cleanup();reject(new Error('伺服器存檔等待逾時，本次操作尚未完成；原項目保留，可稍後重試或先匯出備份'));},timeoutMs);
  function cleanup(){clearInterval(interval);clearTimeout(timeout);}
  Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
 });
}
