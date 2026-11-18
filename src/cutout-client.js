// Decode uploaded data locally: fetching large data URLs can fail in browsers.
export async function cutoutSource(source){
 if(typeof source==='string'&&source.startsWith('data:')){
  const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source);
  if(!match)throw new Error('原圖資料格式不正確，請重新上傳');
  const raw=atob(match[2]),bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  return new Blob([bytes],{type:match[1]});
 }
 const response=await cutoutResponse(source);
 const blob=await response.blob();
 if(!/^image\/(png|jpeg|webp)$/.test(blob.type))throw new Error('原圖回應不是圖片，請重新登入或上傳');
 return blob;
}
async function timedFetch(url,options={},timeout=120000){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 try{return await fetch(url,{...options,signal:options.signal||controller.signal});}
 catch(error){if(controller.signal.aborted){const timeoutError=new Error('請求逾時');timeoutError.name='TimeoutError';throw timeoutError;}throw error;}
 finally{clearTimeout(timer);}
}
async function submissionDiagnostic(){
 try{
  const response=await timedFetch('/api/health',{cache:'no-store'},8000);
  if(response.status===401)return '登入已過期，請重新登入';
  if(!response.ok)return `網站可連線，但抠圖後端回應 HTTP ${response.status}，請檢查 cutout 容器及反向代理`;
  const data=await response.json().catch(()=>null);
  if(data?.service!=='cutout')return '網站可連線，但抠圖服務路由回應異常，請檢查反向代理';
  return '服務健康檢查正常，但圖片提交連線中斷；請查看 Docker 日誌確認是否有上傳中斷或容器重啟';
 }catch{return '無法連接服務，網站或抠圖後端目前不可達，請檢查網絡及 Docker 服務';}
}
export async function cutoutResponse(url,options={}){
 let response;
 try{response=await timedFetch(url,options);}
 catch(error){
  const submitting=options.method==='POST'&&url==='/api/cutout-jobs';
  const message=submitting?await submissionDiagnostic():error.name==='TimeoutError'?'請求逾時，請檢查網絡及服務狀態':'無法連接服務，請檢查網絡、Docker 服務及海報網站連線';
  throw new Error(message,{cause:error});
 }
 if(!response.ok){
  const data=await response.json().catch(()=>null);
  const detail=typeof data?.detail==='string'?data.detail:null;
  const error=new Error(response.status===401?'登入已過期，請重新登入':detail||`抠圖服務回應錯誤（${response.status}）`);
  error.status=response.status;throw error;
 }
 return response;
}
export function cutoutFailure(error,stage,jobId){
 const message=error.message==='Load failed'||error.message==='Failed to fetch'?'連線中斷或回應未完整下載':error.message;
 return `未完成（${stage}）：${message}。`+(jobId?'任務編號：'+jobId+'；可用「查看抠圖任務」恢復。':'尚未取得任務編號，無法確認是否已提交；連線恢復後請重試。');
}
