import {requestSignal} from './request-signal.js';
async function requestPdf(file,endpoint){
 const response=await fetch(`/api/poster-pdf/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:file,signal:requestSignal(240000)});
 if(!response.ok){const body=await response.json().catch(()=>null);throw new Error(typeof body?.detail==='string'?body.detail:response.status===401?'登入已過期，請重新登入':`PDF 轉換失敗（${response.status}），請確認後端已更新`);}
 return response;
}
export async function importPdfPage(file,onProgress=()=>{}){
 if(file.size>30*1024*1024)throw new Error('PDF 不得超過 30 MB');
 onProgress('正在讀取 PDF 頁數…');const {pages}=await (await requestPdf(file,'info')).json();
 if(!Number.isInteger(pages)||pages<1||pages>200)throw new Error('PDF 頁數無效');
 let page=1;
 if(pages>1){
 const dialog=document.createElement('dialog');
 dialog.innerHTML='<h2>選擇舊海報頁面</h2><p>每次導入一頁，自動提取商品圖片並識別文字；導入後請核對識別結果。</p><label>頁碼<select></select></label><p class="hint">套用後請在海報尺寸中確認紙張規格；大幅印刷請核對圖片清晰度。</p><div class="property-buttons"><button data-cancel>取消</button><button data-import class="primary">導入這一頁</button></div>';
 const select=dialog.querySelector('select');select.replaceChildren(...Array.from({length:pages},(_,i)=>new Option(`第 ${i+1} 頁 / 共 ${pages} 頁`,String(i+1))));document.body.append(dialog);

 try{page=await new Promise(resolve=>{dialog.querySelector('[data-cancel]').onclick=()=>{dialog.close();resolve(null);};dialog.oncancel=e=>{e.preventDefault();dialog.close();resolve(null);};dialog.querySelector('[data-import]').onclick=()=>{dialog.close();resolve(Number(select.value));};dialog.showModal();});}
 finally{dialog.remove();}
 }
 if(page===null)return null;
 onProgress(`正在提取第 ${page} 頁商品圖片、識別文字並重建組件，請稍候…`);
 const result=await (await requestPdf(file,`rebuild?page=${page}`)).json();
 if(result.version!==1||!/^data:image\/png;base64,/.test(result.background)||!Array.isArray(result.products))throw new Error('PDF 重建結果無效');
 const raw=atob(result.background.split(',')[1]),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
 const output=new File([bytes],`${file.name.replace(/\.pdf$/i,'')} - 第${page}頁.png`,{type:'image/png'});
 output.reconstruction=result;output.page=page;output.source=file;return output;
}
