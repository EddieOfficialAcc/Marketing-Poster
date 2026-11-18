import {requestSignal} from './request-signal.js';
import {installWorkflow} from './workflow.js';
const originalFetch=window.fetch.bind(window);
// Expired sessions are handled consistently for archives, cutouts and imports.
window.fetch=async (...args)=>{
 const response=await originalFetch(...args);
 const input=args[0],url=new URL(input instanceof Request?input.url:String(input),location.href);
 if(response.status===401&&url.origin===location.origin)location.replace('/login.html');
 return response;
};
try{
 const response=await fetch('/api/auth/me',{cache:'no-store',signal:requestSignal(15000)});
 if(!response.ok)throw new Error('請登入後使用工作台');
 const user=await response.json();window.posterUser=Object.freeze(user);
 const canEdit=!!user.permissions?.includes('edit');
 const $=selector=>document.querySelector(selector);
 document.body.classList.toggle('can-edit',canEdit);
 $('#admin-name').textContent=`${user.name||user.username} · ${(user.roleNames||[]).join('、')||'未授權'}`;
 $('#logout').addEventListener('click',async()=>{
  try{const response=await fetch('/api/auth/logout',{method:'POST'});if(!response.ok)throw new Error('退出失敗，請重試');location.replace('/login.html');}
  catch(e){alert(e.message);}
 });

 // 任務列表與編輯器分開兩個畫面：採購只有任務列表；市場部開啟任務才進入編輯器，「返回任務列表」回到列表。
 let studio=null,workflow=null;
 const loadStudio=()=>studio||=import('./app.js');
 function showView(view){
  document.body.classList.toggle('view-editor',view==='editor');
  document.body.classList.toggle('view-tasks',view!=='editor');
  window.scrollTo({top:0});
 }
 async function openEditor(id){
  if(!canEdit||!id)return;
  showView('editor');
  history.replaceState(null,'',`#edit=${encodeURIComponent(id)}`);  // 重新整理後仍停留在此任務的編輯器
  await loadStudio();
  await window.posterStudio.openCampaign(id);
 }
 async function openFreeEditor(){
  if(!canEdit)return;
  showView('editor');history.replaceState(null,'','#edit');
  await loadStudio();
 }
 function backToTasks(){
  showView('tasks');history.replaceState(null,'','#tasks');
  workflow?.load();
 }

 const deepLink=new URLSearchParams(location.search).get('campaign');  // 舊連結 ./?campaign=… 由 app.js 開啟
 showView(canEdit&&(deepLink||/^#edit/.test(location.hash))?'editor':'tasks');
 workflow=await installWorkflow({user,openEditor});
 $('#back-to-tasks').addEventListener('click',backToTasks);
 $('#wf-free-edit').hidden=!canEdit;
 $('#wf-free-edit').addEventListener('click',openFreeEditor);
 window.addEventListener('poster-workflow-changed',()=>workflow.load());
 document.body.hidden=false;
 if(canEdit)await loadStudio();
 const task=/^#task=(.+)$/.exec(location.hash),edit=/^#edit=(.+)$/.exec(location.hash);
 if(task)workflow.openDetail(decodeURIComponent(task[1]));
 else if(edit&&canEdit)await openEditor(decodeURIComponent(edit[1]));
}catch(e){document.body.hidden=false;document.querySelector('main').textContent=e.message;}
