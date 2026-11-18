import {strikeText,richRuns,BOLD_WEIGHT,textFamily} from './rich-text.js';
import {posterSelection,selectOnPoster} from './poster-selection.js';
import {uid} from './model.js';
import {readImage} from './products.js';
import {selectionBox,replacePosterProduct,cropPixelBox,addExtractedProduct,replacePosterText,replacePosterPrice,borderColor,maskAt} from './poster-reuse.js';
import {validPriceTag,priceTagLabel,priceTagNode} from './price-tag.js';
import {retailText,canvasPrimitives,canvasMeasure} from './retail.js';
import {sizeInfo} from './sizing.js';

export function installPosterReuse({getProject,commit,toast,onCutout}){
 const actions=document.createElement('section');actions.className='poster-source-actions';actions.innerHTML='<p>拖曳框選底圖中的圖片或文字；選擇只換圖片、修改舊文字、替換價格牌或換成新商品卡。已重建的商品可直接點選修改。</p>';document.querySelector('.editor').prepend(actions);
 const shortcut=document.createElement('button');shortcut.className='primary';shortcut.textContent='框選並編輯底圖';actions.append(shortcut);
 const copyButton=document.createElement('button');copyButton.textContent='沿用套版建立新活動';actions.append(copyButton);
 const dialog=document.createElement('dialog');dialog.className='reuse-dialog';dialog.innerHTML=`<div class="panel-heading"><h2>舊海報套版</h2><button data-close>取消</button></div><p>只換圖時僅框圖片；修改舊文字時僅框文字。需要連名稱、規格和價格一起更新，才選「換成新商品卡」。</p><div class="reuse-workspace"><div><canvas aria-label="拖曳框選舊商品區域"></canvas><p class="hint">在底圖拖曳新增區域，點選已有區域可切換；新商品會在套用後出現在主編輯器。</p></div><div><label>替換區域<select data-masks></select></label><details class="advanced-settings"><summary>進階：精確位置與遮蓋顏色</summary><div class="property-grid">${['x','y','w','h'].map((k,i)=>`<label>${['左 %','上 %','寬 %','高 %'][i]}<input data-box="${k}" type="number" min="0" max="100" step="0.1"></label>`).join('')}</div><label>遮蓋顏色<input data-color type="color" value="#fff5df"></label><button data-pick>從底圖取色（再點圖片）</button><p class="hint">遮蓋顏色會自動取自框邊底色，一般無需修改。</p></details><label>操作方式<select data-replace-mode><option value="image">只替換圖片（不新增名稱、規格或價格）</option><option value="text">修改舊文字</option><option value="price">替換價格牌（平均每件／多件價）</option><option value="product">換成新商品卡（統一版式、可核對價格）</option></select></label><section data-product-options><hr><button data-crop-mode>框選舊商品圖片</button><label>提取後的商品名稱<input data-crop-name maxlength="100" placeholder="例如：秋田小町米"></label><button data-extract>提取圖片並套入此區域</button><img data-crop-preview hidden alt="從舊海報提取的商品圖片" style="max-width:100%;max-height:180px;object-fit:contain"><label><input data-cutout-after type="checkbox" checked>套用後抠圖（最後套入的商品；已是透明底則略過）</label><p class="hint">只換圖時框選包裝圖片，避開舊名稱與價格。只換圖片不會增加新文字；需要完整商品資料時選擇「換成新商品卡」。</p><hr><label>新商品素材<select data-asset></select></label><label class="button" for="reuse-product">上傳新商品圖片</label><input id="reuse-product" class="file-input" type="file" accept="image/png,image/jpeg,image/webp"><button data-replace>套入／替換所選商品</button></section><section data-text-options hidden><button data-recognize-text>識別原文字並沿用樣式</button><p data-recognize-status role="status"></p><label>新文字<textarea data-replacement-text rows="4" maxlength="500" placeholder="輸入新的商品名稱、規格、價格或活動說明"></textarea></label><button data-replace-text>替換所框選的文字</button><p class="hint">已有商品文字會直接更新；底圖上的舊文字會被遮蓋，再建立可編輯文字層。套用後可在右側修改字號、顏色及位置。</p></section><section data-price-options hidden><p class="hint">價格牌由多種字號與色塊組成，會用商品卡的價格排版重建；只需核對總價與件數，平均每件價自動計算。</p><button data-recognize-price>識別價格</button><p data-price-status role="status"></p><div class="property-grid"><label>總價<input data-tag-price type="number" min="0.01" max="9999999" step="0.01" placeholder="36"></label><label>件數<input data-tag-quantity type="number" min="1" max="99" step="1" value="1"></label></div><p class="hint" data-tag-preview></p><button data-replace-price>替換所框選的價格牌</button></section><button data-remove>刪除此遮蓋區</button><p data-status role="status"></p><button data-apply class="primary">套用並進入加商品</button></div></div>`;
 document.body.append(dialog);
 const $=s=>dialog.querySelector(s),canvas=$('canvas'),ctx=canvas.getContext('2d');
 let draft,owner,revision,image,selected=null,start=null,picking=false,isNew=false,busy=false,cropMode=false,cropBox=null,cutoutTarget=null,recognizedStyle=null,recognitionSerial=0,recognitionAbort=null,priceColor=null;
 const mask=()=>draft?.posterReuse.masks.find(m=>m.id===selected);
 function status(s){$('[data-status]').textContent=s;}
 function draw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  if(!cropMode)draft.posterReuse.masks.forEach((m,i)=>{ctx.fillStyle=m.color;ctx.fillRect(m.x*canvas.width,m.y*canvas.height,m.w*canvas.width,m.h*canvas.height);ctx.strokeStyle=m.id===selected?'#008ec5':'#777';ctx.lineWidth=2;ctx.strokeRect(m.x*canvas.width,m.y*canvas.height,m.w*canvas.width,m.h*canvas.height);ctx.fillStyle='#111';ctx.font='16px sans-serif';ctx.fillText(String(i+1),m.x*canvas.width+4,m.y*canvas.height+19);});
  const scale=canvas.width/sizeInfo(draft).w;
  for(const n of draft.nodes.filter(n=>n.type==='text')){
   if(n.priceTag){ctx.save();ctx.scale(scale,scale);ctx.translate(n.x,n.y);canvasPrimitives(ctx,retailText(priceTagNode(n),canvasMeasure(ctx)).filter(p=>p.text!==''));ctx.restore();continue;}
   const size=n.fontSize*scale,lh=n.textLayout?.lineHeight||1.3,align=n.textLayout?.align||'left',limit=Math.max(1,Math.floor(n.h/Math.max(1,n.fontSize*lh)));
   const font=heavy=>`${heavy?BOLD_WEIGHT:n.textLayout?.weight||600} ${Math.max(1,size)}px ${textFamily(n)}`;
   ctx.save();ctx.fillStyle=ctx.strokeStyle=n.color;ctx.textBaseline='top';ctx.lineWidth=Math.max(.7,size*.05);
   String(n.text).split('\n').slice(0,limit).forEach((raw,i)=>{
    const {chars,marks,bold}=strikeText(raw),runs=richRuns(chars,marks,bold),widths=runs.map(r=>{ctx.font=font(r.bold);return ctx.measureText(r.text).width;}),width=widths.reduce((a,b)=>a+b,0),top=n.y*scale+i*size*lh;
    let left=(n.x+(align==='center'?(n.w-width/scale)/2:align==='right'?n.w-width/scale:0))*scale;
    runs.forEach((r,k)=>{ctx.font=font(r.bold);ctx.fillText(r.text,left,top);if(r.strike){ctx.beginPath();ctx.moveTo(left,top+size*.55);ctx.lineTo(left+widths[k],top+size*.55);ctx.stroke();}left+=widths[k];});
   });
   ctx.restore();
  }
  if(cropMode&&cropBox){ctx.strokeStyle='#e59224';ctx.lineWidth=3;ctx.strokeRect(cropBox.x*canvas.width,cropBox.y*canvas.height,cropBox.w*canvas.width,cropBox.h*canvas.height);}
 }
 function controls(){
  $('[data-masks]').replaceChildren(...[new Option('請拖曳框選區域',''),...draft.posterReuse.masks.map((m,i)=>new Option(`區域 ${i+1}${draft.nodes.some(n=>n.id===m.nodeId)?' · 已放入商品':' · 只遮蓋'}`,m.id))]);$('[data-masks]').value=selected||'';
  $('[data-asset]').replaceChildren(new Option('請選擇新商品',''),...draft.products.map(a=>new Option(a.name,a.id)));
  const m=mask();for(const el of dialog.querySelectorAll('[data-box]')){el.disabled=!m;el.value=m?Math.round(m[el.dataset.box]*1000)/10:'';}
  if(m)$('[data-color]').value=m.color;
  draw();
 }
 async function open(next,newActivity,box=null){
  owner=getProject();revision=owner.revision;draft=next;isNew=newActivity;selected=null;start=null;picking=false;cropMode=false;cropBox=null;cutoutTarget=null;recognizedStyle=null;recognitionSerial++;
  image=new Image();image.src=draft.background;await image.decode();
  const scale=Math.min(1,900/image.naturalWidth,1000/image.naturalHeight);canvas.width=Math.round(image.naturalWidth*scale);canvas.height=Math.round(image.naturalHeight*scale);
  $('[data-replace-mode]').value='image';$('[data-product-options]').hidden=false;$('[data-text-options]').hidden=true;$('[data-replacement-text]').value='';$('[data-price-options]').hidden=true;$('[data-tag-price]').value='';$('[data-tag-quantity]').value='1';$('[data-tag-preview]').textContent='';$('[data-price-status]').textContent='';priceColor=null;
  $('[data-crop-name]').value='';$('[data-crop-preview]').hidden=true;
  if(box){if(draft.posterReuse.masks.length>=100)throw new Error('最多 100 個遮蓋區');const m={id:uid(),...box,color:'#fff5df'};draft.posterReuse.masks.push(m);selected=m.id;}
  controls();status('遮蓋區固定在底圖上；移動新商品不會露出原商品。');dialog.showModal();
 }
 async function edit(copy=false,box=null){
  try{const current=getProject();if(!current.background||current.template!=='custom')throw new Error('請先在「選模板」上傳底圖（圖片／PDF）');
   const next=structuredClone(current);if(!next.posterReuse){const source=new Image();source.src=next.background;await source.decode();if(getProject()!==current)throw new Error('目前項目已切換');next.posterReuse={width:source.naturalWidth,height:source.naturalHeight,masks:[]};}if(copy){next.archiveCampaignId=uid();delete next.archiveReceipt;delete next.cutoutPending;next.campaign={name:`${current.campaign.name}（新活動）`.slice(0,100),start:'',end:'',stores:''};next.status='draft';next.revision=1;next.history=[];next.approvedRevision=null;next.reviewedRevision=null;}
   await open(next,copy,box);
  }catch(e){toast(e.message);}
 }
 let cancelSelection=null;
 shortcut.onclick=async()=>{
  cancelSelection?.();const current=getProject();
  if(current.template!=='custom'||!current.background)return toast('請先上傳圖片或 PDF 底圖');
  try{
   const source=new Image();source.src=current.background;await source.decode();if(current!==getProject())return;
   const canvas=document.querySelector('#poster-surface .upper-canvas')||document.querySelector('#poster');
   canvas.scrollIntoView({block:'center',behavior:'instant'});
   // Wait for scrollIntoView to settle before measuring screen coordinates.
   requestAnimationFrame(()=>{if(current!==getProject())return;cancelSelection=selectOnPoster(canvas,async(a,b)=>{
    if(current!==getProject())throw new Error('項目已切換，請重新框選');
    const box=posterSelection(current,source.naturalWidth,source.naturalHeight,a,b);await edit(false,box);
   },error=>toast(error.message));});
  }catch(error){toast(error.message);}
 };
 copyButton.onclick=()=>{cancelSelection?.();edit(true);};
 $('[data-close]').onclick=()=>{if(!busy)dialog.close();};dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 $('[data-masks]').onchange=e=>{selected=e.target.value;cropMode=false;cropBox=null;controls();};
 function point(e){const r=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
 canvas.onpointerdown=e=>{
  if(busy||e.button!==0)return;const p=point(e);
  if(picking){const sample=document.createElement('canvas');sample.width=1;sample.height=1;const c=sample.getContext('2d');c.drawImage(image,Math.min(image.naturalWidth-1,Math.floor(p.x*image.naturalWidth)),Math.min(image.naturalHeight-1,Math.floor(p.y*image.naturalHeight)),1,1,0,0,1,1);const rgb=c.getImageData(0,0,1,1).data;const color='#'+Array.from(rgb.slice(0,3),v=>v.toString(16).padStart(2,'0')).join('');$('[data-color]').value=color;if(mask())mask().color=color;picking=false;draw();status('已取色。');return;}
  start=p;canvas.setPointerCapture(e.pointerId);e.preventDefault();
 };
 canvas.onpointermove=e=>{if(!start)return;draw();const b=selectionBox(start,point(e));ctx.strokeStyle='#008ec5';ctx.strokeRect(b.x*canvas.width,b.y*canvas.height,b.w*canvas.width,b.h*canvas.height);};
 canvas.onpointercancel=()=>{start=null;draw();};
 canvas.onpointerup=e=>{
  if(!start)return;const b=selectionBox(start,point(e));start=null;
  if(b.w*canvas.width<8||b.h*canvas.height<8){
   if(cropMode){draw();return;}
   // 單擊：選取最上層包含該點的區域；點空白處則取消選取。
   const hit=maskAt(draft.posterReuse.masks,b);
   if(hit?.id!==selected){selected=hit?.id||null;recognizedStyle=null;controls();status(hit?'已選取區域。':'在底圖拖曳可新增區域。');if(hit)autoRecognize();}else draw();
   return;
  }
  if(cropMode){cropBox=b;draw();status('已框選商品圖片，點「提取圖片並套入此區域」。');return;}
  if(draft.posterReuse.masks.length>=100){status('最多 100 個遮蓋區');draw();return;}
  const m={id:uid(),...b,color:sampleBorder(b)||$('[data-color]').value};draft.posterReuse.masks.push(m);selected=m.id;
  recognizedStyle=null;controls();status('已新增區域並自動取底色。可選商品套入，或只遮蓋舊內容。');
  autoRecognize();
 };
 // 已抠圖或本身透明底的素材不必再跑抠圖模型。
 async function needsCutout(asset){
  if(asset.source==='cutout')return false;
  try{
   const img=new Image();img.src=asset.imageUrl;await img.decode();
   const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0,64,64);
   const data=g.getImageData(0,0,64,64).data;for(let i=3;i<data.length;i+=4)if(data[i]<240)return false;
  }catch{}
  return true;
 }
 function sampleBorder(box){
  try{
   const rect=cropPixelBox(box,image.naturalWidth,image.naturalHeight),scale=Math.min(1,200/Math.max(rect.w,rect.h)),w=Math.max(1,Math.round(rect.w*scale)),h=Math.max(1,Math.round(rect.h*scale)),c=document.createElement('canvas');
   c.width=w;c.height=h;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(image,rect.x,rect.y,rect.w,rect.h,0,0,w,h);
   return borderColor(g.getImageData(0,0,w,h).data,w,h);
  }catch{return null;}
 }
 for(const el of dialog.querySelectorAll('[data-box]'))el.onchange=()=>{const m=mask();if(!m)return;const v=Number(el.value)/100;if(!Number.isFinite(v))return;const k=el.dataset.box;m[k]=Math.max((k==='w'||k==='h')?.001:0,Math.min(1,v));m.x=Math.min(m.x,1-m.w);m.y=Math.min(m.y,1-m.h);controls();};
 $('[data-color]').oninput=e=>{if(mask()){mask().color=e.target.value;draw();}};
 $('[data-pick]').onclick=()=>{cropMode=false;picking=true;status('點擊底圖空白處取色。');};
 $('[data-remove]').onclick=()=>{draft.posterReuse.masks=draft.posterReuse.masks.filter(m=>m.id!==selected);selected=null;cropMode=false;cropBox=null;controls();status('已移除遮蓋區；已加入的商品保留，可在主編輯器刪除。');};
 $('[data-replace]').onclick=()=>{try{const assetId=$('[data-asset]').value,n=replacePosterProduct(draft,selected,assetId,$('[data-replace-mode]').value);cutoutTarget={assetId,nodeId:n.id};controls();status($('[data-replace-mode]').value==='image'?'已替換圖片並清除舊投影；套用後會依勾選狀態抠圖去除商品圖底色。':`已換成新商品卡 ${n.name}，請填寫新價格。`);}catch(e){status(e.message);}};
 $('#reuse-product').onchange=async e=>{const file=e.target.files[0];if(!file)return;const target=draft;e.target.disabled=true;
  try{if(draft.products.length>=100)throw new Error('最多 100 張商品素材');const src=await readImage(file);if(draft!==target||!dialog.open)return;const a={id:uid(),name:file.name.replace(/\.[^.]+$/,'').slice(0,100),sku:'',spec:'',filename:file.name,aliases:[],imageUrl:src,source:'upload'};draft.products.push(a);controls();$('[data-asset]').value=a.id;status('新圖片已加入，請點「套入／替換所選商品」。');}catch(err){status(err.message);}finally{e.target.value='';e.target.disabled=false;}
 };

 $('[data-crop-mode]').onclick=()=>{
  if(!mask())return status('請先框選完整商品區（圖片、名稱、規格和價格），再提取其中的商品圖片。');
  cropMode=true;cropBox=null;picking=false;draw();status('正在顯示未遮蓋的原底圖。請拖曳框選商品包裝圖片，避開文字和價格。');
 };
 $('[data-extract]').onclick=()=>{
  try{
   if(!mask()||!cropMode||!cropBox)throw new Error('請先點「框選舊商品圖片」並拖曳選取圖片');
   const b=cropPixelBox(cropBox,image.naturalWidth,image.naturalHeight),output=document.createElement('canvas');
   const scale=Math.min(1,1800/Math.max(b.w,b.h));output.width=Math.max(1,Math.round(b.w*scale));output.height=Math.max(1,Math.round(b.h*scale));
   output.getContext('2d').drawImage(image,b.x,b.y,b.w,b.h,0,0,output.width,output.height);
   const name=$('[data-crop-name]').value.trim()||`提取商品 ${draft.posterReuse.masks.indexOf(mask())+1}`;
   const asset={id:uid(),name,sku:'',spec:'',filename:`${name}.png`,aliases:[],source:'poster-crop',imageUrl:output.toDataURL('image/png')};
   if(asset.imageUrl.length>16*1024*1024)throw new Error('提取圖片過大，請縮小選取範圍');
   const n=addExtractedProduct(draft,selected,asset,$('[data-replace-mode]').value);$('[data-crop-preview]').src=asset.imageUrl;$('[data-crop-preview]').hidden=false;cutoutTarget={assetId:asset.id,nodeId:n.id};cropMode=false;cropBox=null;controls();$('[data-asset]').value=asset.id;
   status($('[data-replace-mode]').value==='image'?'已提取並套入圖片，不新增文字或價格。套用後可抠圖。':'已換成新商品卡，套用後請填寫名稱、規格及價格。');
  }catch(e){status(e.message);}
 };
 function autoRecognize(){const mode=$('[data-replace-mode]').value;if(!['text','price'].includes(mode))return;recognizeSelection().catch(error=>{$(mode==='price'?'[data-price-status]':'[data-recognize-status]').textContent=error.message;});}
 async function recognizeSelection(){
  const chosen=mask();if(!chosen)throw new Error('請先在底圖框選舊文字');
  const serial=++recognitionSerial,rect=cropPixelBox(chosen,image.naturalWidth,image.naturalHeight),crop=document.createElement('canvas');
  crop.width=rect.w;crop.height=rect.h;crop.getContext('2d').drawImage(image,rect.x,rect.y,rect.w,rect.h,0,0,rect.w,rect.h);
  const blob=await new Promise(resolve=>crop.toBlob(resolve,'image/png'));
  // 只保留最新一次識別：新區域或重按按鈕時取消上一個請求，避免同時佔用後端。
  recognitionAbort?.abort();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);recognitionAbort=controller;
  const mode=$('[data-replace-mode]').value;$(mode==='price'?'[data-price-status]':'[data-recognize-status]').textContent='識別中…（約需數秒）';
  let response;
  try{response=await fetch(`/api/poster-pdf/analyze-text?mode=${mode==='price'?'price':'text'}`,{method:'POST',headers:{'Content-Type':'image/png'},body:blob,signal:controller.signal});}
  catch(error){if(serial!==recognitionSerial)return;throw new Error(error.name==='AbortError'?'文字識別超時，請縮小框選範圍後重試':error.message);}
  finally{clearTimeout(timer);if(recognitionAbort===controller)recognitionAbort=null;}
  if(serial!==recognitionSerial)return;
  if(!response.ok){const body=await response.json().catch(()=>null);throw new Error(typeof body?.detail==='string'?body.detail:`舊文字識別失敗（${response.status}）`);}
  const result=await response.json();if(serial!==recognitionSerial||!mask()||mask().id!==chosen.id)return;
  if($('[data-replace-mode]').value==='price'){
   priceColor=result.color;if(result.offer){$('[data-tag-price]').value=result.offer.price;$('[data-tag-quantity]').value=result.offer.quantity;}
   $('[data-price-status]').textContent=result.offer?'已識別價格，請核對總價與件數。':'未能從此區域讀出「總價/件數」（例如 $36/2件），請直接填寫。';tagPreview();return;
  }
  const [x,y,w,h]=result.box;recognizedStyle={fontSizeRatio:Number(result.fontSizeRatio)||.82,weight:result.weight,lineHeight:result.lineHeight,rows:String(result.text).split('\n').length,color:result.color,align:result.align,box:{x,y,w,h}};
  $('[data-replacement-text]').value=result.text;$('[data-recognize-status]').textContent=`已識別，信心度 ${Math.round(result.confidence*100)}%。位置、字號與顏色沿用估算值；字重、對齊與行距按原文字估算；刪除線以 ~~文字~~、粗體行以 **文字** 表示。${result.mixed?' 此區域混合了不同字號或顏色（例如價格牌），一個文字層無法還原，建議逐部分分開框選，或改用「換成新商品卡」的價格欄位。':''}${result.badge?' 文字位於色塊上，請把遮蓋顏色設為色塊顏色，或只框選色塊內部。':''}`;
 }
 $('[data-replace-mode]').onchange=()=>{const mode=$('[data-replace-mode]').value,text=mode==='text';$('[data-product-options]').hidden=['text','price'].includes(mode);$('[data-text-options]').hidden=!text;$('[data-price-options]').hidden=mode!=='price';if(mode==='price'){priceColor=null;$('[data-price-status]').textContent='';recognizeSelection().catch(error=>{$('[data-price-status]').textContent=error.message;});}cropMode=false;cropBox=null;draw();if(text){recognizedStyle=null;$('[data-replacement-text]').value='';$('[data-recognize-status]').textContent='';recognizeSelection().catch(error=>{$('[data-recognize-status]').textContent=error.message;});}};
 function tagPreview(){const price=$('[data-tag-price]').value,quantity=Number($('[data-tag-quantity]').value);$('[data-tag-preview]').textContent=validPriceTag({price,quantity})?`展示：${priceTagLabel({price,quantity})}`:'';}
 $('[data-tag-price]').oninput=$('[data-tag-quantity]').oninput=tagPreview;
 $('[data-recognize-price]').onclick=()=>recognizeSelection().catch(error=>{$('[data-price-status]').textContent=error.message;});
 $('[data-replace-price]').onclick=()=>{try{const n=replacePosterPrice(draft,selected,{price:$('[data-tag-price]').value,quantity:Number($('[data-tag-quantity]').value)},priceColor);controls();status(n.type==='product'?'已更新商品價格，原有版式不變。':'已建立價格牌；套用後可在右側修改總價與件數。');}catch(error){status(error.message);}};
 $('[data-recognize-text]').onclick=()=>recognizeSelection().catch(error=>{$('[data-recognize-status]').textContent=error.message;});
 $('[data-replace-text]').onclick=()=>{try{const n=replacePosterText(draft,selected,$('[data-replacement-text]').value,recognizedStyle);controls();status(n.type==='product'?'已更新可編輯商品文字，原有版式不變。':'已建立文字層並沿用識別到的位置、字號與顏色；可再微調。');}catch(error){status(error.message);}};
 $('[data-apply]').onclick=async()=>{
  if(busy)return;busy=true;const inputs=[...dialog.querySelectorAll('button,input,select')],disabled=inputs.map(el=>el.disabled);inputs.forEach(el=>el.disabled=true);status('正在保存並套用…');
  try{if(getProject()!==owner||owner.revision!==revision)throw new Error('原項目已變更，請關閉後重新開啟套版');if(draft.posterReuse.mode!=='blank'&&!draft.posterReuse.masks.length)throw new Error('請至少框選一個完整舊商品或舊文字區域；空白底圖請取消並返回設定確認');draft.posterReuse.prepared=true;await commit(draft,{owner,revision,isNew});dialog.close();toast(getProject().step===2?'舊內容遮蓋已套用，可加入新商品。':'遮蓋已保存，請先填寫新活動資料再加商品。');if(cutoutTarget&&$('[data-cutout-after]').checked){const n=getProject().nodes.find(n=>n.id===cutoutTarget.nodeId);const asset=getProject().products.find(a=>a.id===cutoutTarget.assetId);if(n?.productId===cutoutTarget.assetId&&asset&&await needsCutout(asset))onCutout?.(cutoutTarget.assetId,cutoutTarget.nodeId);}}
  catch(e){status(`尚未套用：${e.message}`);}finally{busy=false;inputs.forEach((el,i)=>el.disabled=disabled[i]);}
 };
 return {edit};
}
