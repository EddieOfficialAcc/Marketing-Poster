// 海報製作流程：採購提交活動表 → 市場部製作 → 內容核對 → 確認。權限由伺服器按內聯網角色判斷，
// 頁面只按 actions 顯示可用操作；每個操作伺服器都會再檢查一次。由 session.js 在工作台頁面安裝。
import {requestSignal} from './request-signal.js';

const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const ACTIONS={claim:'接手製作',assign:'指派負責人',submit_review:'提交確認',confirm:'確認海報',send_back:'退回修改',return:'退回採購',resubmit:'重新提交活動表',cancel:'取消申請',reopen:'重新開啟'};
const NEEDS_REASON=new Set(['send_back','return','cancel','reopen']);
const STATUS_COLOR={submitted:'grey',in_design:'blue',pending_confirm:'amber',confirmed:'green',returned:'red',cancelled:'muted'};
let user=null,tab='processing',data={items:[],counts:{},statusNames:{}},current=null,filters={},refreshTimer,openEditor=()=>{};

async function api(url,options={}){
 const response=await fetch(url,{...options,signal:options.signal||requestSignal(60000)});
 if(response.status===401){location.replace('/login.html');throw new Error('請先登入');}
 const body=await response.json().catch(()=>null);
 if(!response.ok)throw new Error(typeof body?.detail==='string'?body.detail:`操作失敗（${response.status}）`);
 return body;
}
function toast(message){const el=$('#wf-toast');el.textContent=message;el.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>{el.hidden=true;},4000);}
const can=permission=>user?.permissions?.includes(permission);
const day=value=>value?String(value).slice(0,10):'';
function when(value){if(!value)return '';const d=new Date(value);return Number.isNaN(d.getTime())?value:d.toLocaleString('zh-HK',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
function overdue(item){return item.due_date&&!['confirmed','cancelled'].includes(item.status)&&item.due_date<new Date().toISOString().slice(0,10);}
function editorUrl(item){return `./?campaign=${encodeURIComponent(item.campaign_id)}`;}
const editLink=(item,cls,title,inner)=>`<a class="${cls}" href="${esc(editorUrl(item))}" data-edit-campaign="${esc(item.campaign_id)}" title="${title}">${inner}</a>`;
const canEditItem=item=>can('edit')&&item.status!=='cancelled';
// 版本號放進網址，海報更新後縮圖不會沿用瀏覽器快取。
const posterUrl=(item,width)=>`/api/workflow/${encodeURIComponent(item.campaign_id)}/poster?width=${width||0}&v=${item.version?.sequence||0}`;

function steps(item,large=false){
 if(item.status==='cancelled')return large?'<ol class="wf-steps-large" id="d-steps"><li class="back"><span>–</span>已取消</li></ol>':'<span class="wf-cancelled">已取消</span>';
 const labels=item.steps||['採購提交','市場部製作','內容核對','已確認'];
 const tag=large?'ol':'span',cls=large?'wf-steps-large':'wf-steps';
 return `<${tag} class="${cls}"${large?' id="d-steps"':''} title="${esc(item.statusName)}">${labels.map((label,i)=>{
  const state=item.status==='returned'&&i===0?'back':i<item.step?'done':i===item.step?'now':'todo';
  return large?`<li class="${state}"><span>${i+1}</span>${esc(label)}</li>`:`<i class="${state}" title="${esc(label)}"></i>`;}).join('')}</${tag}>`;
}
function posterCell(item){
 // 市場部：點海報直接進入編輯；採購：只能預覽已生成的海報。
 if(!item.version?.hasPoster){
  return canEditItem(item)
   ?editLink(item,'wf-no-poster wf-start','開始製作','開始製作')
   :'<span class="wf-no-poster">未生成</span>';
 }
 const img=`<img loading="lazy" src="${esc(posterUrl(item,160))}" alt="${esc(item.name)} 海報">`;
 if(canEditItem(item))return `<div class="wf-poster-cell">${editLink(item,'wf-thumb','進入編輯',img)}</div>`;
 return `<div class="wf-poster-cell"><button class="wf-thumb" data-preview="${esc(item.campaign_id)}" title="查看目前海報">${img}</button></div>`;
}

// 「待我處理」：市場部看待接手／自己負責的製作／可確認的；採購看自己被退回的申請。只影響顯示，權限仍由伺服器判斷。
const MINE_LABEL={submitted:'待接手',in_design:'待製作',pending_confirm:'待確認',returned:'待修正活動表'};
function needsMe(item){
 const me=user?.username;
 if(can('edit')){
  if(['submitted','in_design'].includes(item.status))return !item.assignee||item.assignee===me;
  if(item.status==='pending_confirm')return !!item.actions?.includes('confirm');
 }
 if(can('submit')&&item.status==='returned')return item.created_by===me||can('admin');
 return false;
}

function rows(){
 const items=data.items.filter(item=>Object.entries(filters).every(([key,value])=>{
  if(!value)return true;
  if(key==='mine')return needsMe(item);
  if(key==='status')return item.status===value;
  if(key==='period')return `${item.start} ${item.end}`.includes(value);
  return String(item[key]||'').toLowerCase().includes(value.toLowerCase());
 }));
 if(!items.length)return `<tr><td colspan="11" class="wf-empty">${!data.items.length?'這裡暫時沒有海報申請':filters.mine?'目前沒有待你處理的申請':'沒有符合篩選的申請'}</td></tr>`;
 // data-label 供窄螢幕卡片版顯示欄名。
 return items.map(item=>`<tr data-id="${esc(item.campaign_id)}" class="${overdue(item)?'wf-overdue':''}${needsMe(item)?' wf-needs-me':''}">
  <td data-label="編號"><span class="wf-priority wf-${esc(item.priority)}" title="重要性：${esc(item.priorityName)}"></span><a href="#" data-open="${esc(item.campaign_id)}">${esc(item.code)}</a>${item.legacy?'<small class="wf-legacy">舊存檔</small>':''}</td>
  <td data-label="海報">${posterCell(item)}</td>
  <td data-label="活動">${canEditItem(item)?editLink(item,'wf-name','點擊進入編輯',esc(item.name)):`<a class="wf-name" href="#" data-open="${esc(item.campaign_id)}">${esc(item.name)}</a>`}<small>${esc(item.stores||'')}${item.product_count?` · ${item.product_count} 件商品`:''}</small></td>
  <td data-label="活動時間">${esc(day(item.start))}<br><small>至 ${esc(day(item.end))}</small>${item.due_date?`<small class="${overdue(item)?'wf-late':''}">期限 ${esc(item.due_date)}${overdue(item)?'（已逾期）':''}</small>`:''}</td>
  <td data-label="狀態"><span class="wf-status wf-${STATUS_COLOR[item.status]}">${esc(item.statusName)}</span>${needsMe(item)?`<small class="wf-mine-chip">${esc(MINE_LABEL[item.status])}</small>`:''}</td>
  <td data-label="進度" class="wf-col-steps">${steps(item)}</td>
  <td data-label="提交人" class="wf-col-minor">${esc(item.created_by_name||'')}</td>
  <td data-label="負責人">${esc(item.assignee_name||'—')}</td>
  <td data-label="確認人" class="wf-col-minor">${esc(item.confirmed_by_name||'—')}${item.confirmed_at?`<small>${esc(when(item.confirmed_at))}</small>`:''}</td>
  <td data-label="最後更新" class="wf-col-minor">${esc(when(item.updated_at))}</td>
  <td class="wf-col-actions"><div class="wf-row-actions">${can('edit')
   ?`${canEditItem(item)?editLink(item,'wf-btn wf-green wf-mini','進入編輯',item.version?.hasPoster?'編輯':'開始製作'):''}${item.actions?.includes('confirm')?`<button class="wf-confirm wf-mini" data-quick="${esc(item.campaign_id)}">確認海報</button>`:''}<button class="wf-link" data-open="${esc(item.campaign_id)}">記錄</button>`
   :`<button class="wf-link" data-open="${esc(item.campaign_id)}">${item.status==='returned'&&can('submit')?'修正並重新提交':'查看進度'}</button>`}</div></td>
 </tr>`).join('');
}

let loadSeq=0,detailSeq=0;
// 抽屜裡正在填寫原因或已選指派人時，自動刷新不重繪操作區，避免清空輸入。
const drawerBusy=()=>!$('#wf-drawer').hidden&&($('#d-act').contains(document.activeElement)||!!$('[data-comment]')?.value.trim()||!!$('[data-assignee]')?.value);
async function load(){
 const seq=++loadSeq;let next;
 try{next=await api(`/api/workflow?tab=${tab}`);}
 catch(error){if(seq!==loadSeq)return;$('#wf-rows').innerHTML=`<tr><td colspan="11" class="wf-empty">${esc(error.message)}</td></tr>`;return;}
 if(seq!==loadSeq)return;  // 較新的請求（例如已切換分頁）優先
 data=next;
 for(const [name,count] of Object.entries(data.counts))$(`[data-count="${name}"]`).textContent=count?`(${count})`:'';
 const select=$('[data-filter="status"]'),wanted=select.value;
 const statuses=[...new Set(data.items.map(i=>i.status))];
 const mine=data.items.filter(needsMe).length;$('#wf-mine-count').textContent=mine?`(${mine})`:'';
 select.innerHTML='<option value="">所有狀態</option>'+statuses.map(s=>`<option value="${s}">${esc(data.statusNames[s])}</option>`).join('');select.value=statuses.includes(wanted)?wanted:'';
 $('#wf-rows').innerHTML=rows();
 if(current&&!drawerBusy())openDetail(current.campaign_id,false);
}

function facts(item){
 const rows=[['狀態',`<span class="wf-status wf-${STATUS_COLOR[item.status]}">${esc(item.statusName)}</span>`],['活動時間',`${esc(day(item.start))} 至 ${esc(day(item.end))}`],['適用門店',esc(item.stores||'—')],
  ['商品數',item.product_count||'—'],['重要性',esc(item.priorityName)],['希望完成',item.due_date?`<span class="${overdue(item)?'wf-late':''}">${esc(item.due_date)}${overdue(item)?'（已逾期）':''}</span>`:'—'],
  ['提交人（採購）',`${esc(item.created_by_name)} · ${esc(when(item.created_at))}`],['市場部負責人',esc(item.assignee_name||'未指派')],
  ['提交確認',esc(item.submitted_by_name||'—')],['確認人',item.confirmed_by_name?`${esc(item.confirmed_by_name)} · ${esc(when(item.confirmed_at))}`:'—'],
  ['最新版本',item.version?`#${item.version.sequence} · ${esc(when(item.version.savedAt))}${item.version.savedBy?` · ${esc(item.version.savedBy)}`:''}`:'尚未保存'],['備註',esc(item.note||'—')]];
 return rows.map(([k,v])=>`<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function actionPanel(item){
 const actions=(item.actions||[]).filter(a=>a!=='edit'&&ACTIONS[a]);
 const edit=item.actions?.includes('edit')?editLink(item,'button primary','進入編輯',item.version?'進入編輯':'開始製作（匯入活動表）'):'';
 const hint=item.status==='in_design'&&can('edit')&&!item.version?.hasPoster?'<p class="hint">完成海報後，於編輯第 3 步「生成海報預覽」，再按「確認海報」或「提交市場部確認」。</p>':
  ['submitted','returned'].includes(item.status)&&can('submit')&&!can('edit')?'<p class="hint">市場部接手後會在這裡更新進度；海報生成後可點左上圖片查看大圖。</p>':
  item.status==='pending_confirm'&&can('confirm')?'<p class="hint">請逐項核對海報上的名稱、規格、價格、活動日期及門店，正確後按「確認海報」；有問題請填原因後「退回修改」。</p>':'';
 if(!actions.length&&!edit)return `<h3>操作</h3><p class="hint">${can('edit')||can('submit')?'目前狀態沒有可執行的操作。':'你的帳號只有查看權限。'}</p>`;
 return `<h3>操作</h3>${hint}<div class="wf-act-row">${edit}${actions.map(a=>`<button data-action="${a}" class="${a==='confirm'?'wf-confirm':['return','send_back','cancel'].includes(a)?'danger':''}">${ACTIONS[a]}</button>`).join('')}</div>
  ${actions.includes('assign')?`<label class="wf-assign">指派給<select data-assignee><option value="">請選擇市場部同事</option></select></label>`:''}
  ${actions.some(a=>NEEDS_REASON.has(a)||a==='confirm'||a==='submit_review')?'<label>原因／備註（退回、取消、重新開啟必填）<textarea data-comment rows="2" maxlength="500"></textarea></label>':''}`;
}

async function openDetail(id,show=true){
 const seq=++detailSeq;
 try{
  const item=await api(`/api/workflow/${encodeURIComponent(id)}`);
  if(seq!==detailSeq)return;  // 已點開另一項，忽略較慢的舊回應
  current=item;
  $('#d-code').textContent=`${item.code}${item.legacy?' · 流程啟用前的存檔':''}`;$('#d-name').textContent=item.name;
  $('#d-poster').innerHTML=item.version?.hasPoster?`<img src="${esc(posterUrl(item,640))}" alt="目前海報">`:'<span>尚未生成海報預覽</span>';
  $('#d-poster').disabled=!item.version?.hasPoster;
  $('#d-facts').innerHTML=facts(item);$('#d-steps').outerHTML=steps(item,true);
  $('#d-act').innerHTML=actionPanel(item);
  $('#d-sheet').innerHTML=item.sheet?`<a href="/api/workflow/${encodeURIComponent(item.campaign_id)}/sheet">${esc(item.sheet.filename)}</a> · ${esc(item.sheet.uploaded_by)} · ${esc(when(item.sheet.uploaded_at))}`:'沒有附上活動表（流程啟用前的存檔）';
  $('#d-events').innerHTML=item.events.length?item.events.map(e=>`<li><b>${esc(e.actionName)}</b>${e.fromName||e.toName?` <span class="wf-flow">${esc(e.fromName||'—')} → ${esc(e.toName)}</span>`:''}<small>${esc(e.actor_name)} · ${esc(when(e.at))}${e.version?` · 版本 #${e.version}`:''}</small>${e.comment?`<p>${esc(e.comment)}</p>`:''}</li>`).join(''):'<li class="hint">沒有記錄</li>';
  if(item.actions?.includes('assign')){
   const people=await api('/api/auth/users').catch(()=>[]);
   if(seq!==detailSeq)return;
   const select=$('[data-assignee]');select.innerHTML+=people.filter(p=>p.roles.some(r=>['marketing','admin'].includes(r))).map(p=>`<option value="${esc(p.username)}">${esc(p.name)}</option>`).join('');
  }
  if(show){$('#wf-drawer').hidden=false;history.replaceState(null,'',`#task=${encodeURIComponent(item.campaign_id)}`);}
 }catch(error){toast(error.message);}
}

async function act(action){
 const comment=$('[data-comment]')?.value.trim()||'';
 if(action==='resubmit'){$('#wf-sheet-dialog').showModal();return;}
 if(NEEDS_REASON.has(action)&&!comment){toast('請先填寫原因，方便對方跟進');$('[data-comment]')?.focus();return;}
 const body={action,comment};
 if(action==='assign'){body.assignee=$('[data-assignee]').value;if(!body.assignee)return toast('請選擇市場部同事');}
 if(action==='confirm'&&!confirm(`確認「${current.name}」的名稱、規格、價格、日期及門店均已核對無誤？確認後海報可用於印刷。`))return;
 try{await api(`/api/workflow/${encodeURIComponent(current.campaign_id)}/action`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast(`已${ACTIONS[action]}`);const id=current.campaign_id;await load();if(current?.campaign_id===id)await openDetail(id,false);}
 catch(error){toast(error.message);}
}

function preview(item){
 const box=$('#wf-lightbox'),edit=box.querySelector('[data-edit]');
 box.querySelector('img').src=posterUrl(item,0);
 const allow=canEditItem(item);
 edit.hidden=!allow;edit.href=allow?editorUrl(item):'#';
 if(allow)edit.dataset.editCampaign=item.campaign_id;else delete edit.dataset.editCampaign;
 box.showModal();
}
function closeDetail(){$('#wf-drawer').hidden=true;current=null;history.replaceState(null,'',location.pathname);}

const ROLE_LABEL={admin:'管理員',marketing:'市場部（製作及確認）',purchaser:'採購（提交活動表）',viewer:'只讀'};
async function loadAccess(){
 const body=await api('/api/auth/role-grants');
 const grants=body.grants.map(g=>`<li>${esc(ROLE_LABEL[g.role]||g.role)} ← <code>${esc(g.code)}</code> <button type="button" data-revoke="${esc(g.code)}" data-role="${esc(g.role)}">移除</button></li>`).join('')||'<li>尚未額外對應。預設代碼已可用。</li>';
 const people=body.users.map(u=>`<li><b>${esc(u.name)}</b> <small>${esc(u.username)}</small> · ${u.roles.length?esc(u.roles.map(r=>ROLE_LABEL[r]||r).join('、')):'<span class="wf-late">未配對角色</span>'}<small>內聯網代碼：${esc((u.codes||[]).join('、')||'（無）')}</small></li>`).join('')||'<li>還沒有人用內聯網帳號登入</li>';
 $('#wf-access-body').innerHTML=`<h3>目前會認的代碼</h3><ul class="wf-codes">${Object.entries(body.defaults).map(([role,codes])=>`<li>${esc(ROLE_LABEL[role]||role)}：${esc(codes.join('、')||'（無）')}</li>`).join('')}</ul><h3>額外對應</h3><ul class="wf-codes">${grants}</ul><h3>已見過的帳號</h3><ul class="wf-people">${people}</ul>`;
 $('#wf-access-dialog').showModal();
}

async function summary(){
 const all=(await Promise.all(['processing','pending','done'].map(t=>api(`/api/workflow?tab=${t}`)))).flatMap(r=>r.items);
 const by=key=>all.reduce((map,i)=>{const k=i[key]||'未指派';map[k]=(map[k]||0)+1;return map;},{});
 const statusCount=by('statusName'),people=by('assignee_name'),late=all.filter(overdue);
 $('#wf-summary-body').innerHTML=`<div class="wf-summary-grid">${Object.entries(statusCount).map(([k,v])=>`<div><b>${v}</b><span>${esc(k)}</span></div>`).join('')}<div class="wf-late-box"><b>${late.length}</b><span>已逾期</span></div></div>
  <h3>市場部負責人工作量（未完成）</h3><ul>${Object.entries(all.filter(i=>!['confirmed','cancelled'].includes(i.status)).reduce((m,i)=>{const k=i.assignee_name||'未指派';m[k]=(m[k]||0)+1;return m;},{})).map(([k,v])=>`<li>${esc(k)}：${v} 件</li>`).join('')||'<li>沒有未完成的申請</li>'}</ul>
  ${late.length?`<h3>已逾期</h3><ul>${late.map(i=>`<li>${esc(i.code)} ${esc(i.name)}（期限 ${esc(i.due_date)}，${esc(i.statusName)}）</li>`).join('')}</ul>`:''}`;
 void people;$('#wf-summary-dialog').showModal();
}

async function upload(url,form,file){
 const query=new URLSearchParams({filename:file.name});
 for(const key of ['priority','due','note'])if(form[key]?.value)query.set(key,form[key].value);
 return api(`${url}${url.includes('?')?'&':'?'}${query}`,{method:url.endsWith('/sheet')?'PUT':'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
}

function editInPage(id){Promise.resolve().then(()=>openEditor(id)).catch(error=>toast(error.message));}

function wire(){
 document.querySelectorAll('[data-wf-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.wfTab;document.querySelectorAll('[data-wf-tab]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));load();});
 document.querySelectorAll('[data-filter]').forEach(el=>el.addEventListener('input',()=>{filters[el.dataset.filter]=el.value.trim();$('#wf-rows').innerHTML=rows();}));
 $('[data-filter-mine]').addEventListener('change',e=>{filters.mine=e.target.checked;$('#wf-rows').innerHTML=rows();});
 $('#wf-rows').addEventListener('click',async e=>{
  if(e.target.closest('[data-edit-campaign]'))return;
  const open=e.target.closest('[data-open]'),shot=e.target.closest('[data-preview]'),quick=e.target.closest('[data-quick]');
  if(quick){e.preventDefault();await openDetail(quick.dataset.quick);if(current?.campaign_id===quick.dataset.quick&&current.actions?.includes('confirm'))act('confirm');return;}
  if(shot){e.preventDefault();const item=data.items.find(i=>i.campaign_id===shot.dataset.preview)||(current?.campaign_id===shot.dataset.preview?current:null);if(item)preview(item);return;}
  if(open){e.preventDefault();openDetail(open.dataset.open);return;}
  const row=e.target.closest('tr[data-id]');
  if(!row||e.target.closest('a,button,input,select,textarea'))return;
  // 市場部點整列＝直接編輯；採購點整列＝只看進度／已生成海報。
  if(can('edit')){const item=data.items.find(i=>i.campaign_id===row.dataset.id);if(item&&canEditItem(item)){editInPage(item.campaign_id);return;}}
  openDetail(row.dataset.id);
 });
 // 縮圖、活動名稱、「編輯」按鈕及大圖裡的進入編輯：同一頁切到編輯區。
 document.addEventListener('click',e=>{
  const link=e.target.closest('a[data-edit-campaign]');
  if(!link||e.metaKey||e.ctrlKey||e.shiftKey||e.button!==0)return;
  e.preventDefault();
  $('#wf-lightbox').open&&$('#wf-lightbox').close();
  $('#wf-drawer').hidden=true;current=null;
  editInPage(link.dataset.editCampaign);
 });
 $('#d-close').onclick=closeDetail;
 $('#d-poster').onclick=()=>current&&preview(current);
 $('#d-act').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b)act(b.dataset.action);});
 document.querySelectorAll('dialog [data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
 $('#wf-summary').onclick=()=>summary().catch(error=>toast(error.message));
 $('#wf-new').onclick=()=>{$('#wf-new-form').reset();$('#wf-new-dialog .wf-error').textContent='';$('#wf-new-dialog').showModal();};
 $('#wf-new-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,file=form.sheet.files[0],button=form.querySelector('[type=submit]');if(!file)return;
  button.disabled=true;form.querySelector('.wf-error').textContent='';
  try{const created=await upload('/api/workflow',form,file);$('#wf-new-dialog').close();toast(`已提交 ${created.code}，市場部會盡快處理`);tab='processing';document.querySelector('[data-wf-tab=processing]').click();openDetail(created.campaign_id);}
  catch(error){form.querySelector('.wf-error').textContent=error.message;}finally{button.disabled=false;}
 });
 $('#wf-sheet-form').addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target,file=form.sheet.files[0],button=form.querySelector('[type=submit]');if(!file||!current)return;
  button.disabled=true;form.querySelector('.wf-error').textContent='';
  try{await upload(`/api/workflow/${encodeURIComponent(current.campaign_id)}/sheet`,form,file);$('#wf-sheet-dialog').close();toast('已重新提交活動表');await load();}
  catch(error){form.querySelector('.wf-error').textContent=error.message;}finally{button.disabled=false;}
 });
 $('#wf-access').onclick=()=>loadAccess().catch(error=>toast(error.message));
 $('#wf-grant-form')?.addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target;
  try{await api('/api/auth/role-grants',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:form.role.value,code:form.code.value.trim()})});form.code.value='';toast('已加入對應。已登入的同事重新整理即可；尚未登入成功的同事請再登入一次');await loadAccess();}
  catch(error){toast(error.message);}
 });
 $('#wf-access-body')?.addEventListener('click',async e=>{
  const b=e.target.closest('[data-revoke]');if(!b)return;
  try{await api(`/api/auth/role-grants?role=${encodeURIComponent(b.dataset.role)}&code=${encodeURIComponent(b.dataset.revoke)}`,{method:'DELETE'});await loadAccess();}
  catch(error){toast(error.message);}
 });
 const visible=()=>!document.hidden&&$('#tasks-view').offsetParent!==null;
 document.addEventListener('visibilitychange',()=>{if(visible())load();});
 refreshTimer=setInterval(()=>{if(visible()&&!document.querySelector('dialog[open]'))load();},60000);
}

export async function installWorkflow(options){
 user=options.user;openEditor=options.openEditor||openEditor;
 $('#wf-new').hidden=!can('submit');
 $('#role-hint').textContent=can('admin')?'管理員：可處理所有申請，並在「權限對應」把內聯網權限代碼配到採購、市場部或只讀。':can('edit')?'市場部：點任務進入編輯，採購提交的 Excel 會自動帶入；完成後在編輯器頂部生成預覽並「確認海報」。':can('submit')?'採購：按「上傳商品 Excel」建立海報任務；之後在這裡查看製作進度和已生成的海報。被退回的申請會標示「待修正活動表」。':'只可查看海報及進度。';
 $('#wf-access').hidden=!can('admin');
 // 採購只負責建任務／上傳 Excel，隱藏總結等市場部工具。
 if(can('submit')&&!can('edit')&&!can('admin')){$('#wf-summary').hidden=true;$('#wf-export').hidden=true;}
 wire();await load();
 return {load,openDetail,closeDetail};
}
void refreshTimer;
