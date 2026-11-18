// Task metadata is tab-local and independent of the shared editable draft.
const key=project=>`poster-cutout:${project.archiveCampaignId}`;
export function rememberCutout(project,pending,storage){
 try{storage??=globalThis.sessionStorage;if(!project.archiveCampaignId||!storage)return false;if(pending)storage.setItem(key(project),JSON.stringify(pending));else storage.removeItem(key(project));return true;}catch{return false;}
}
export function recoverCutout(project,storage){
 try{
  storage??=globalThis.sessionStorage;
  if(!project.archiveCampaignId||!storage)return null;
  const pending=JSON.parse(storage.getItem(key(project))||'null');
  if(!pending||typeof pending.jobId!=='string'||!project.products.some(p=>p.id===pending.assetId))return null;
  if(!Array.isArray(pending.remaining))pending.remaining=[];
  return pending;
 }catch{return null;}
}
export function cutoutProgress(job,now=Date.now()){
 const start=job.started||job.created,elapsed=Number.isFinite(start)?Math.max(0,Math.floor(now/1000-start)):0;
 const duration=elapsed>=60?`${Math.floor(elapsed/60)}分${elapsed%60}秒`:`${elapsed}秒`;
 const labels={verifying:'正在校驗已下載的模型',initializing:'模型已下載，正在初始化',queued:`排隊中，前面有 ${job.ahead} 張圖片`,loading:'正在載入模型；首次使用需下載模型',processing:'正在去除背景',saving:'正在保存透明底圖片'};
 const parts=String(job.stage||'').split(':');
 const message=parts[0]==='download'?(parts[1]==='retry'?`正在連接模型下載，第 ${parts[2]} 次嘗試`:`正在下載模型 ${parts[1]}%（第 ${parts[2]} 次嘗試）`):(labels[job.stage]||'正在處理');
 return `${message} · ${job.state==='queued'?'已等待':'已處理'} ${duration}。`;
}
