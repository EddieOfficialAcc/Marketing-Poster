import {requestSignal} from './request-signal.js';
// 「全自動換商品」對話框：上傳舊海報 PDF 與活動表 → 分析 → 預覽對應 → 產生新項目 → （可選）AI 校對。
import {matchCampaign} from './campaign-import.js';
import {autoPlan,reviewPayload,rowErrors} from './poster-auto.js';

const MAX_PRODUCTS=30;  // 大海報（如 A2 18 格）可放入的商品上限；一般 Excel 匯入仍為 12 件
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

async function api(url,options,fallback){
 const response=await fetch(url,options);const body=await response.json().catch(()=>null);
 if(!response.ok)throw new Error(typeof body?.detail==='string'?body.detail:response.status===401?'登入已過期，請重新登入':fallback);
 return body;
}

// taskSheet：目前項目屬採購任務時回傳該任務的活動表 File（否則 null）；inTask：產生的海報是否更新目前任務。
export function installPosterAuto({getProject,savedPosters,provider,productOptions,createProject,renderPoster,toast,taskSheet=async()=>null,inTask=()=>false}){
 const dialog=document.createElement('dialog');dialog.className='reuse-dialog auto-dialog';
 dialog.innerHTML=`<div class="panel-heading"><h2>全自動換商品</h2><button data-close>關閉</button></div>
 <p>上傳舊海報 PDF（或空白底圖）與活動表。商品格按<strong>左上到右下</strong>編號，依序放入活動表第 1、2、3… 件商品；名稱、規格及價格只取自活動表。舊海報沿用原文字位置與字型；空白底圖自動找出商品區或已印好的商品框。</p>
 <p class="hint" data-ai-status>正在檢查 AI 視覺模型…</p>
 <label data-auto-source hidden>海報來源<select data-auto-saved></select></label><p class="hint" data-auto-saved-hint></p>
 <div class="property-grid" data-auto-upload><label>舊海報或空白底圖（PDF／PNG／JPG）<input data-auto-pdf type="file" accept="application/pdf,.pdf,image/png,image/jpeg,image/webp"></label><label>頁碼<select data-auto-page disabled><option value="1">第 1 頁</option></select></label></div>
 <p class="auto-task-sheet" data-auto-task-sheet hidden>活動表：使用採購提交的 <strong data-auto-task-name></strong> <button type="button" data-auto-other-sheet>改用其他檔案</button></p>
 <label data-auto-sheet-pick>活動表（Excel／CSV，與「Excel 匯入」相同格式）<input data-auto-sheet type="file" accept=".xlsx,.csv"></label>
 <p class="hint"><a href="/api/campaign-template">下載活動表範本</a>；填 code（或商品編號，例如 BD-101643）會查詢 POS 與伺服器圖片庫。</p>
 <button data-auto-run class="primary">開始分析</button>
 <p data-auto-status role="status"></p>
 <section data-auto-preview hidden><h3>新商品（可修改或刪除）</h3><p class="hint" data-auto-mode></p><ul class="auto-warnings" data-auto-warnings></ul>
 <div class="table-scroll"><table><thead><tr><th>格</th><th>名稱（可換行）</th><th>規格</th><th>優惠總價</th><th>件數</th><th>原價</th><th>商品圖片</th><th></th></tr></thead><tbody data-auto-rows></tbody></table></div>
 <div class="property-buttons"><button data-auto-add>＋ 新增商品</button></div>

 <div class="auto-apply-actions"><p data-auto-apply-status role="status" aria-live="polite"></p><button data-auto-apply type="button" class="primary" disabled>產生海報（建立新項目）</button></div></section>
 <section data-auto-after hidden><h3>產生後</h3><p class="hint" data-auto-cutout-note></p><div class="property-buttons"><button data-auto-review>AI 校對成品</button></div><div data-auto-review-result></div></section>`;
 document.body.append(dialog);
 const $=selector=>dialog.querySelector(selector);
 let state=null,busy=false,aiAvailable=false,cutouts=[],taskFile=null;
 const status=text=>{$('[data-auto-status]').textContent=text;$('[data-auto-apply-status]').textContent=text;};
 const applyLabel=()=>inTask()?'產生海報（更新此任務）':'產生海報（建立新項目）';
 function generationBusy(value){
  busy=value;
  dialog.setAttribute('aria-busy',String(value));
  dialog.querySelectorAll('input,textarea,select,button[data-auto-other-sheet],[data-auto-delete],[data-auto-add],[data-close],[data-auto-run]').forEach(el=>{el.disabled=value;});
  $('[data-auto-apply]').textContent=value?'正在產生海報，請稍候…':applyLabel();
  if(state)refreshState();
 }
 function showTaskSheet(){
  $('[data-auto-task-sheet]').hidden=!taskFile;$('[data-auto-sheet-pick]').hidden=!!taskFile;
  if(taskFile)$('[data-auto-task-name]').textContent=taskFile.name;
 }
 $('[data-auto-other-sheet]').onclick=()=>{if(busy)return;taskFile=null;showTaskSheet();};
 function generationError(message){
  status(message);toast(message);$('[data-auto-apply-status]').scrollIntoView({block:'nearest'});
 }


 async function checkAi(){
  try{const s=await api('/api/poster-auto/status',{},'');aiAvailable=!!s.available;
   $('[data-ai-status]').textContent=aiAvailable?`AI 視覺模型：${s.deployment}。會先確認哪些格是商品，產生後可做 AI 校對；AI 不會改動任何商品資料。`:'未設定 AI 視覺模型：自動換商品照常運作，只略過 AI 檢查與校對。';}
  catch{aiAvailable=false;$('[data-ai-status]').textContent='無法連線後端，請確認服務已啟動。';}
  $('[data-auto-review]').hidden=!aiAvailable;
 }

 const isPdf=file=>file.type==='application/pdf'||/\.pdf$/i.test(file.name);
 $('[data-close]').onclick=()=>{if(!busy)dialog.close();};
 dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 $('[data-auto-pdf]').onchange=async e=>{
  const file=e.target.files[0],select=$('[data-auto-page]');select.replaceChildren(new Option('第 1 頁','1'));select.disabled=true;if(!file||!isPdf(file))return;
  try{const {pages}=await api('/api/poster-pdf/info',{method:'POST',headers:{'Content-Type':'application/pdf'},body:file},'PDF 讀取失敗');
   if(Number.isInteger(pages)&&pages>1){select.replaceChildren(...Array.from({length:Math.min(pages,200)},(_,i)=>new Option(`第 ${i+1} 頁 / 共 ${pages} 頁`,String(i+1))));select.disabled=false;}}
  catch(error){status(error.message);}
 };

 const fields=[['name','textarea'],['spec','text'],['price','decimal'],['quantity','number'],['originalPrice','decimal']];
 function field(row,i,[key,type]){
  const value=esc(row[key]??''),attrs=`data-field="${key}" data-i="${i}" aria-label="第 ${i+1} 格 ${key}"`;
  if(key==='price'&&row.price2)return `<label>第一件<input ${attrs} inputmode="decimal" value="${value}" style="width:6em"></label><label>第二件<input data-field="price2" data-i="${i}" aria-label="第二件售價" inputmode="decimal" value="${esc(row.price2)}" style="width:6em"></label>`;
  if(key==='originalPrice'&&row.originalPrice2)return `<label>第一件<input ${attrs} inputmode="decimal" value="${value}" style="width:6em"></label><label>第二件<input data-field="originalPrice2" data-i="${i}" aria-label="第二件原價" inputmode="decimal" value="${esc(row.originalPrice2)}" style="width:6em"></label>`;
  if(type==='textarea')return `<textarea ${attrs} rows="2" maxlength="100">${value}</textarea>`;
  if(type==='number')return `<input ${attrs} type="number" min="1" max="99" step="1" value="${value}" style="width:4em">`;
  return `<input ${attrs} type="text" ${type==='decimal'?'inputmode="decimal" style="width:6em"':'maxlength="100"'} value="${value}">`;
 }
 const errorText=row=>rowErrors(row).join('；');
 function refreshState(){
  const plan=autoPlan(state.analysis,state.rows);
  $('[data-auto-mode]').textContent=!state.rows.length?'已刪除全部商品。':plan.single?'單一商品海報：替換相片、名稱區及價格，保留標籤與條款。':plan.blank==='panel'?`空白底圖：已自動找出商品區，按 ${state.rows.length} 件分格並自動調整比例。`:plan.blank==='cells'?`空白底圖：偵測到 ${plan.cells} 個已印好的商品框，按格號放入。`:plan.mode==='match'?`商品 ${state.rows.length} 件＝舊海報 ${plan.cells} 格：按格號逐格替換，沿用原位置。`:`商品 ${state.rows.length} 件、舊海報 ${plan.cells} 格：產生時遮蓋全部舊商品，在原商品區按 ${state.rows.length} 件重新分格，自動調整比例。`;
  $('[data-auto-warnings]').replaceChildren(...[...(state.importWarnings||[]),...plan.warnings].filter(w=>!/重新分格/.test(w)).map(w=>Object.assign(document.createElement('li'),{textContent:w})));
  $('[data-auto-apply]').disabled=busy||!state.rows.length||state.rows.some(r=>rowErrors(r).length);
  $('[data-auto-add]').disabled=busy||state.rows.length>=MAX_PRODUCTS;
 }
 function secondImage(row,i){
  return [2,3,4].filter(number=>row['code'+number]).map(number=>{
  const second=row[number===2?'companion':'companion'+number]||{},asset=[...(second.libraryProducts||[]),...getProject().products].find(p=>p.id===second.assetId);
  return `<div class="paired-image"><strong>第${number}件 · ${esc(row['code'+number])}</strong><select data-auto-asset="${i}" data-auto-second="${number}" aria-label="第 ${i+1} 格第二件圖片">${productOptions(second.assetId,second.libraryProducts||[],true)}</select>${asset?`<img src="${esc(asset.imageUrl)}" alt="${esc(asset.name)}" style="max-width:64px;max-height:64px;object-fit:contain">`:'<small>請選擇第二件商品圖片</small>'}</div>`;
 }).join('');
 }
 function render(){
  $('[data-auto-rows]').innerHTML=state.rows.map((r,i)=>{const asset=[...(r.libraryProducts||[]),...getProject().products].find(a=>a.id===r.assetId);
   return `<tr><td>${i+1}</td>${fields.map(f=>`<td>${field(r,i,f)}</td>`).join('')}
   <td><select data-auto-asset="${i}" aria-label="第 ${i+1} 格商品圖片">${productOptions(r.assetId,r.libraryProducts||[],!!r.productid)}</select>${r.productid?`<small>code ${esc(r.sku)} · ${asset?.source==='pos-library'?'伺服器圖片庫':'尚未選中伺服器圖片'}</small>`:'<small>本機素材匹配（未提供 POS 商品編號）</small>'}${asset?`<img src="${esc(asset.imageUrl)}" alt="${esc(asset.name)}" style="max-width:64px;max-height:64px;object-fit:contain">`:''}${secondImage(r,i)}</td>
   <td><button data-auto-delete="${i}" class="danger" aria-label="刪除第 ${i+1} 格商品">刪除</button></td></tr>
   <tr data-auto-error="${i}"><td></td><td colspan="7"><small class="auto-error">${esc(errorText(r))}</small></td></tr>`;}).join('');
  refreshState();
 }
 $('[data-auto-rows]').addEventListener('input',e=>{
  const key=e.target.dataset.field,i=Number(e.target.dataset.i);if(busy||!key||!state?.rows[i])return;
  state.rows[i][key]=key==='quantity'?Number(e.target.value):key==='name'?e.target.value:e.target.value.trim().replace(/^[$＄]\s*/,'');
  dialog.querySelector(`[data-auto-error="${i}"] small`).textContent=errorText(state.rows[i]);refreshState();
 });
 $('[data-auto-rows]').addEventListener('change',e=>{const i=e.target.dataset.autoAsset;if(busy||i===undefined||!state)return;const row=state.rows[Number(i)],target=e.target.dataset.autoSecond?row[Number(e.target.dataset.autoSecond)>2?'companion'+e.target.dataset.autoSecond:'companion']:row;if(!target)return;target.assetId=e.target.value;render();});
 $('[data-auto-add]').onclick=()=>{
  if(!state||busy)return;if(state.rows.length>=MAX_PRODUCTS)return status(`最多 ${MAX_PRODUCTS} 件商品`);
  // 新增的商品沿用活動表的活動名稱、日期及門店；其餘欄位留空待填。
  const {campaign='',start='',end='',stores=''}=state.rows.find(r=>r.campaign)||state.campaign||{};
  state.rows.push({row:null,campaign,start,end,stores,name:'',sku:'',spec:'',price:'',quantity:1,originalPrice:'',assetId:''});
  render();dialog.querySelector(`[data-field="name"][data-i="${state.rows.length-1}"]`)?.focus();
 };
 $('[data-auto-rows]').addEventListener('click',e=>{const i=e.target.closest('[data-auto-delete]')?.dataset.autoDelete;if(i===undefined||!state||busy)return;state.rows.splice(Number(i),1);render();});

 const savedId=()=>$('[data-auto-source]').hidden?'':$('[data-auto-saved]').value;
 function sourceHint(){
  const option=$('[data-auto-saved]').selectedOptions[0];$('[data-auto-upload]').hidden=!!savedId();
  $('[data-auto-saved-hint]').textContent=!savedId()?'':option?.dataset.pdf==='1'?'沿用上傳時保存的原始 PDF 與頁碼，可偵測舊商品格。':'圖片：舊海報會從價格牌偵測商品格（含單品 POP），空白底圖會自動找商品區；PDF 的識別最準確。';
 }
 $('[data-auto-saved]').onchange=sourceHint;
 $('[data-auto-run]').onclick=async()=>{
  if(busy)return;const sheet=taskFile||$('[data-auto-sheet]').files[0];
  let current=null;
  try{current=savedId()?await savedPosters.get(savedId()):null;}catch(error){return status(error.message);}
  let pdf=current?current.file:$('[data-auto-pdf]').files[0];
  if(!pdf||!sheet)return status(current?'請選擇活動表':'請選擇舊海報（或空白底圖）及活動表');
  const page=current?.kind==='pdf'?current.page:Number($('[data-auto-page]').value)||1;
  const kind=sheet.name.split('.').at(-1).toLowerCase();if(!['xlsx','csv'].includes(kind))return status('活動表請使用 .xlsx 或 UTF-8 .csv');
  state=null;busy=true;$('[data-auto-run]').disabled=true;$('[data-auto-preview]').hidden=true;$('[data-auto-after]').hidden=true;
  try{
   status('正在讀取活動表、查詢 POS 並匹配圖片；首次使用需建立共享圖片索引…');
   const data=await api(`/api/import-campaign?kind=${kind}&limit=${MAX_PRODUCTS}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:sheet},'活動表解析失敗');
   if(data.errors?.length)throw new Error(`活動表有錯誤：${data.errors.slice(0,3).map(e=>typeof e==='string'?e:`第 ${e.row} 行 ${e.message||''}`).join('；')}`);
   if(!data.rows?.length)throw new Error('活動表沒有商品');
   status('正在按商品編號匹配素材庫圖片…');const rows=await matchCampaign(data.rows,provider);
   status(`正在分析舊海報（商品格、文字樣式${aiAvailable?'、AI 確認':''}），約需 30–90 秒…`);
   const analysis=isPdf(pdf)
    ?await api(`/api/poster-auto/analyze?page=${page}&ai=${aiAvailable?1:0}`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:pdf,signal:requestSignal(300000)},'舊海報分析失敗')
    :await api(`/api/poster-auto/analyze-image?ai=${aiAvailable?1:0}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:pdf,signal:requestSignal(180000)},'底圖分析失敗');
   const first=rows[0]||{};
   state={analysis,importWarnings:data.warnings||[],rows:rows.map(r=>({...r})),campaign:{campaign:first.campaign,start:first.start,end:first.end,stores:first.stores},pdfName:pdf.name,sheetName:sheet.name,owner:getProject()};
   status(`分析完成：活動表 ${rows.length} 件商品。可直接修改或刪除商品，核對圖片後產生海報。`);
   $('[data-auto-preview]').hidden=false;
  }catch(error){status(error.name==='TimeoutError'?'分析超時，請將所需頁面另存為較小的 PDF 後重試':error.message);}
  finally{busy=false;$('[data-auto-run]').disabled=false;if(state)render();}
 };

 $('[data-auto-apply]').onclick=async()=>{
  if(busy||!state)return;
  if(getProject()!==state.owner)return generationError('目前項目已切換，請重新分析');
  generationBusy(true);
  try{
   status('正在建立新項目並套用商品…');
   $('[data-auto-apply-status]').scrollIntoView({block:'nearest'});
   const bad=state.rows.findIndex(r=>rowErrors(r).length);if(bad>=0)throw new Error(`第 ${bad+1} 格：${errorText(state.rows[bad])}`);
   const nodes=await createProject(state.analysis,autoPlan(state.analysis,state.rows),{pdfName:state.pdfName,sheetName:state.sheetName,onProgress:status});
   const products=getProject().products;
   cutouts=nodes.flatMap(n=>{const a=products.find(p=>p.id===n.productId);return a&&a.source!=='cutout'?[{assetId:a.id,nodeId:n.id}]:[];});
   $('[data-auto-preview]').hidden=true;$('[data-auto-after]').hidden=false;$('[data-auto-review-result]').replaceChildren();
   state=null;noteCutouts();dialog.close();
   requestAnimationFrame(()=>document.querySelector('.canvas-stage')?.scrollIntoView({block:'start'}));
   status(`已${inTask()?'更新此任務的海報':'建立新項目'}並放入 ${nodes.length} 件商品。名稱、規格、價格均取自活動表，請在畫布核對。`);
  }catch(error){generationError(error.name==='TimeoutError'?'圖片下載超時，原項目及已選圖片保留，請檢查圖片共享盤後重試':`產生未完成：${error.message}。已保留選圖，可重試。`);}
  finally{generationBusy(false);}
 };

 function noteCutouts(){
  $('[data-auto-cutout-note]').textContent=cutouts.length?`${cutouts.length} 件商品圖未抠圖。關閉此視窗後，可先看排版，再按畫布工具列的「一鍵抠圖」把需要的商品圖抠成透明底。`:'所有商品圖均為透明底。';
 }

 async function reviewCurrent(result){
  if(busy){toast('已有分析或校對任務正在進行，請稍候');return;}busy=true;const owner=getProject(),revision=owner.revision;result.textContent='正在產生成品圖並交給 AI 校對，約需 30–60 秒…';
  try{
   const blob=await renderPoster(),bitmap=await createImageBitmap(blob),k=Math.min(1,2000/Math.max(bitmap.width,bitmap.height));
   const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*k);canvas.height=Math.round(bitmap.height*k);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
   bitmap.close();
   if(getProject()!==owner||owner.revision!==revision)throw new Error('海報已修改，請重新校對');
   const payload=reviewPayload(owner,canvas.toDataURL('image/jpeg',.88));
   if(!payload.slots.length)throw new Error('目前項目沒有可校對的商品');
   const review=await api('/api/poster-auto/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:requestSignal(240000)},'AI 校對失敗');
   if(getProject()!==owner||owner.revision!==revision)throw new Error('校對期間海報已修改，請重新校對');
   const names=Object.fromEntries(payload.slots.map(s=>[s.id,s.expected.name]));
   const bad=review.slots.filter(s=>!s.ok);
   result.innerHTML=`<p><strong>${bad.length||review.general.length?`AI 提出 ${bad.length} 格需要核對`:'AI 未發現問題'}</strong>（${esc(review.deployment)}；AI 校對僅供參考，仍須人工核對價格）</p><ul>${bad.map(s=>`<li>第 ${s.id} 格「${esc(names[s.id])}」：${s.issues.map(esc).join('；')}</li>`).join('')}${review.general.map(g=>`<li>${esc(g)}</li>`).join('')}</ul>`;
  }catch(error){result.textContent=error.name==='TimeoutError'?'AI 校對超時，請稍後重試':error.message;}
  finally{busy=false;}
 };

 $('[data-auto-review]').onclick=()=>reviewCurrent($('[data-auto-review-result]'));
 return {review:reviewCurrent,async open(){
  if(busy)return;status('');checkAi();
  // 在採購任務內開啟：直接帶入該任務的活動表，市場部不必另行下載再上傳。
  try{taskFile=await taskSheet();}catch{taskFile=null;}
  showTaskSheet();$('[data-auto-apply]').textContent=applyLabel();
  // 已保存的底圖都可直接選用（預設目前項目的底圖），不必再上傳。
  const saved=await savedPosters.list();
  $('[data-auto-saved]').replaceChildren(...saved.map(s=>new Option(`${s.name}${s.pdf?'（舊海報 PDF）':'（圖片）'}${s.current?'・目前項目':''}`,s.id,false,s.current)),new Option('上傳新檔案…',''));
  [...$('[data-auto-saved]').options].forEach((o,i)=>{if(saved[i]?.pdf)o.dataset.pdf='1';});
  if(!saved.some(s=>s.current))$('[data-auto-saved]').value=saved.find(s=>s.pdf)?.id||'';
  $('[data-auto-source]').hidden=!saved.length;sourceHint();dialog.showModal();
 }};
}
