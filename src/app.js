import {replacePictureAsset,repairPairedPriceBindings} from './paired-prices.js';
import {strikeText,richRuns,BOLD_WEIGHT,TEXT_FONTS,textFamily} from './rich-text.js';
import {priceTagNode,priceTagLabel,validPriceTag} from './price-tag.js';
import {applyPdfReconstruction} from './pdf-rebuild.js';
import {importPdfPage} from './pdf-import.js';
import {posterMasks,paintedPosterMasks} from './poster-reuse.js';
import {installPosterReuse} from './poster-reuse-ui.js';
import {installPosterAuto} from './poster-auto-ui.js';
import {applyAutoReplace} from './poster-auto.js';
import {applyProductLayout,overlappingText,repairProjectText,separateImageFromText} from './product-layout.js';
import {setFontSize,requestedFontSize} from './font-settings.js';
import {isUploadAsset,assetUsers,deleteLibraryAsset} from './library-delete.js';
import {rememberCutout,recoverCutout,cutoutProgress} from './cutout-recovery.js';
import {newProject,newProjectFromPoster,backgroundChoices} from './new-project.js';
import {EditorHistory,alignNodes,snapPosition} from './editor-history.js';
import {posterPdf} from './print-pdf.js';
import {retailText,canvasPrimitives,canvasMeasure,region,defaultRegions,setRegionBox,alignProductText,retailRegions,offer,retailPageErrors} from './retail.js';
import {cutoutSource,cutoutResponse,cutoutFailure} from './cutout-client.js';
import {cleanTemplateElements} from './template-layout.js';
import {iconNode,containIcon} from './icon-assets.js';
import {productMetrics,imageRegion} from './auto-layout.js';
import {withDpi} from './png.js';
import {sizeInfo,resizeProject,backgroundBox,upgradeCanvasCoordinates,displaySize,clampNodeTransform} from './sizing.js';
import { archiveVersion, listArchives, getArchive, getArchiveDetails, deleteArchiveVersion, deleteCampaign, waitForArchive } from './archive.js';
import { matchCampaign, applyCampaign, snapshotCampaignImages } from './campaign-import.js';
import { createFabricEditor } from './fabric-editor.js';
import { steps, stepIssues, firstIncomplete } from './steps.js';
import { uid, defaultProject, touch, log, validate, transition, productNode, arrange, textEntries, priceLabel, parseBackup } from './model.js';
import { pictures, ensurePictures, addPicture, layoutPictures, autoLayoutPictures, removePicture, pictureAt, cycleOverlap, movePicture, mergeProducts } from './composition.js';
import { backgrounds } from './catalog.js';
import { UploadProductProvider, readImage, loadProject, saveProject, savePosterPdf, loadPosterPdf, posterPdfIds } from './products.js';

const $ = selector => document.querySelector(selector);
let WIDTH=900,HEIGHT=1280,backgroundEditing=false,backgroundMoving=false,pageEditing=false;
const canvas = $('#poster'), ctx = canvas.getContext('2d');
let project = defaultProject(), provider, selected = null, focusField = null, saveTimer, drag = null, pendingSave = Promise.resolve(), dirty = false, saveSequence = 0;
let selectedPicture = null, pictureSelectionExplicit=false;
let lastArchived=null;
let archiveTimer, archiveQueue=Promise.resolve(), confirmedArchive=null, confirming=false, confirmationTarget=null, archiveOffset=0, viewedArchive=null;
let generatedPoster = null, generating = false, fabricEditor = null, cutoutDraft = null, campaignImport = null;
let workflowItem = null;  // 目前項目對應的採購任務；renderSteps 用它判斷是否略過「活動資料」
let pendingSheetStamp = null;  // 下一次 Excel 匯入來自任務哪一次上傳的活動表
const images = new Map();
const editHistory=new EditorHistory();let historyOwner=null,historyTravel=false,activeRegion='price',editingRegion=false;
function historyButtons(){$('#undo-edit').disabled=!editHistory.past.length;$('#redo-edit').disabled=!editHistory.future.length;}
function recordHistory(){if(historyOwner!==project){editHistory.reset(project);historyOwner=project;}else if(!historyTravel)editHistory.record(project);historyButtons();}

const statusNames = { draft: '草稿', review: '待校對', approved: '已校對' };
const templatePaths = { membership: 'output/evaluation/membership-background-v1.png', promotion: 'output/evaluation/promotion-background-v1.png' };
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 4500); }
function scheduleArchive() {
  project.archiveCampaignId ||= uid();
  clearTimeout(archiveTimer);
  $('#archive-status').textContent='伺服器存檔待同步';
  archiveTimer=setTimeout(()=>{
    const owner=project,revision=project.revision;
    archiveQueue=archiveQueue.catch(()=>{}).then(async()=>{
      if(project!==owner||project.revision!==revision||confirming)return; // superseded queued draft
      const receipt=await archiveVersion(owner,{onProgress(progress){
        if(project!==owner||project.revision!==revision)return;
        $('#archive-status').textContent=progress.phase==='check'?'正在核對圖片同步狀態':progress.phase==='upload'&&progress.total?`正在上傳新增圖片 ${progress.done}/${progress.total}`:'正在保存活動資料';
      }});
      if(project===owner&&project.revision===revision){lastArchived={owner,revision,receipt};$('#archive-status').textContent=`✓ 伺服器已存檔 #${receipt.sequence}`;}
    }).catch(error=>{if(project===owner&&project.revision===revision)$('#archive-status').textContent='伺服器未存檔：'+error.message;});
  },1800);
}
function queueSave() {
  scheduleArchive();
  const sequence = ++saveSequence;
  dirty = true; $('#save-status').textContent = '正在儲存…'; clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snapshot = structuredClone(project);
    pendingSave = pendingSave.catch(() => {}).then(() => saveProject(snapshot)).then(() => {
      if (sequence === saveSequence) {
        dirty = false; $('#save-status').textContent = '✓ 已儲存至此瀏覽器';
      }
    }).catch(error => {
      const message=error.code==='DRAFT_CONFLICT'?error.message:'瀏覽器儲存失敗，請匯出專案備份以免遺失';
      $('#save-status').textContent=message;toast(message);
    });
  }, 250);
}
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
function edited(message) { recordHistory();touch(project, message); invalidatePreview();renderSteps(); queueSave(); renderStatus(); renderChecks(); renderTextResults(); renderBatchCutout(); renderWorkflowReview(); draw(); }
function getImage(src) {
  if (!src) return null;
  if (!images.has(src)) {
    const image = new Image(); images.set(src, image); image.onload = () => draw();
    image.onerror = () => toast('有圖片無法載入，請重新上傳或檢查底圖路徑'); image.src = src;
  }
  return images.get(src);
}
function roundRect(context, x, y, w, h, radius, fill) { context.fillStyle = fill; context.beginPath(); context.roundRect(x,y,w,h,radius); context.fill(); }
function lines(context, text, x, y, maxWidth, fontSize, color, maxLines = 2, weight = '400', align = 'left', lineHeight = 1.3, family = TEXT_FONTS.default) {
  const font=bold=>`${bold?BOLD_WEIGHT:weight} ${fontSize}px ${family}`;
  context.textAlign='left';context.font=font(false);context.fillStyle = color; context.textBaseline = 'top';
  const {chars,marks,bold}=strikeText(text);
  // 每行記錄字元及其刪除線、粗體標記；粗體段落需用自己的字重量度寬度。
  const measure=(line,heavy)=>richRuns(line,[],heavy).reduce((sum,run)=>{context.font=font(run.bold);return sum+context.measureText(run.text).width;},0);
  const draw=(row,line,flags,heavy,suffix='')=>{
    const all=[...line,...suffix],allFlags=[...flags,...[...suffix].map(()=>false)],allBold=[...heavy,...[...suffix].map(()=>false)];
    const width=measure(all,allBold),top=y+row*fontSize*lineHeight;let left=x+(align==='center'?(maxWidth-width)/2:align==='right'?maxWidth-width:0);
    for(const run of richRuns(all,allFlags,allBold)){
      context.font=font(run.bold);context.fillText(run.text,left,top);const end=left+context.measureText(run.text).width;
      if(run.strike){context.save();context.strokeStyle=color;context.lineWidth=Math.max(.7,fontSize*.05);context.beginPath();context.moveTo(left,top+fontSize*.55);context.lineTo(end,top+fontSize*.55);context.stroke();context.restore();}
      left=end;
    }
    context.font=font(false);
  };
  let line=[],flags=[],heavy=[],row=0;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (char === '\n' || measure([...line,char],[...heavy,bold[i]]) > maxWidth) {
      if (row === maxLines - 1) { while (line.length && measure([...line,'…'],[...heavy,false]) > maxWidth) {line.pop();flags.pop();heavy.pop();} draw(row,line,flags,heavy,'…'); return; }
      draw(row,line,flags,heavy); row++;
      [line,flags,heavy] = char === '\n' ? [[],[],[]] : [[char],[marks[i]],[bold[i]]];
    } else { line.push(char); flags.push(marks[i]); heavy.push(bold[i]); }
  }
  draw(row,line,flags,heavy);
}
function draw(target = ctx, exporting = false, scene = project) {
  const {w:WIDTH,h:HEIGHT}=sizeInfo(scene);
  if(target===ctx && !exporting && fabricEditor){fabricEditor.update(scene,selected,backgroundEditing,backgroundMoving,editingRegion?activeRegion:null);return;}
  if(target===ctx&&!exporting){const view=displaySize(scene,Number($('#poster-zoom').value)/100);canvas.style.width=`${view.width}px`;canvas.style.height=`${view.height}px`;canvas.style.maxWidth='none';}
  if(target===ctx&&!exporting&&(canvas.width!==Math.round(WIDTH)||canvas.height!==Math.round(HEIGHT))){canvas.width=Math.round(WIDTH);canvas.height=Math.round(HEIGHT);}
  target.clearRect(0,0,WIDTH,HEIGHT); target.fillStyle = '#fff5df'; target.fillRect(0,0,WIDTH,HEIGHT);
  const background = scene.template === 'custom' ? scene.background : templatePaths[scene.template];
  if (background) {
    const image = getImage(background);
    if (image?.complete && image.naturalWidth) {
      const box=backgroundBox(scene,image.naturalWidth,image.naturalHeight);
      target.drawImage(image,box.x,box.y,box.w,box.h);
      if(backgroundEditing&&!exporting){target.save();target.strokeStyle='#296b47';target.lineWidth=3;target.strokeRect(box.x,box.y,box.w,box.h);target.fillStyle='#296b47';target.fillRect(box.x+box.w-9,box.y+box.h-9,18,18);target.restore();}
    }
  } else {
    for(const item of cleanTemplateElements(scene)){
      if(item.type==='image'){const image=getImage(item.src);if(image?.complete&&image.naturalWidth)target.drawImage(image,item.x,item.y,item.w,item.h);}
      else if(item.type==='rect'){target.fillStyle=item.color;target.fillRect(item.x,item.y,item.w,item.h);}
      else{
        let font=item.font;
        // Fit the complete text into the reserved lines, including long store lists.
        while(font>1){target.font=`${item.weight} ${font}px "PingFang TC", "Microsoft JhengHei", sans-serif`;if(target.measureText(item.value).width<=item.w*item.lines*.96)break;font*=.94;}
        lines(target,item.value,item.x,item.y,item.w,font,item.color,item.lines,String(item.weight));
      }
    }
  }
  for(const m of paintedPosterMasks(scene)){target.fillStyle=m.color;target.fillRect(m.x,m.y,m.w,m.h);}
  for (const n of scene.nodes) {
    target.save();
    if(n.type==='imageIcon'){
      const asset=(scene.icons||[]).find(a=>a.id===n.iconId),image=getImage(asset?.imageUrl);
      if(image?.complete&&image.naturalWidth){const box=containIcon(n,image.naturalWidth,image.naturalHeight);target.drawImage(image,box.x,box.y,box.w,box.h);}
    } else if (n.type === 'product') {
      const {font,padding,priceSize}=productMetrics(n.h,n.fontSize,n.priceFontSize),imageBox=imageRegion(n),imageHeight=imageBox.h;
      for (const pic of pictures(n)) {
        const asset=scene.products.find(p=>p.id===pic.productId), image=getImage(asset?.imageUrl);
        if (!image?.complete || !image.naturalWidth) continue;
        const box={x:n.x+imageBox.x+pic.x*imageBox.w,y:n.y+imageBox.y+pic.y*imageHeight,w:pic.w*imageBox.w,h:pic.h*imageHeight};
        const scale=Math.min(box.w/image.naturalWidth,box.h/image.naturalHeight);
        const w=image.naturalWidth*scale,h=image.naturalHeight*scale;
        target.save();target.shadowColor='#1c241b40';target.shadowBlur=n.shadow;target.shadowOffsetY=n.shadow/2;
        target.drawImage(image,box.x+(box.w-w)/2,box.y+box.h-h,w,h);target.restore();
        if(!exporting && n.id===selected && pic.id===selectedPicture) {
          target.save();target.strokeStyle='#e59224';target.lineWidth=2;target.setLineDash([3,3]);target.strokeRect(box.x,box.y,box.w,box.h);target.restore();
        }
      }
      target.save();target.translate(n.x,n.y);canvasPrimitives(target,retailText(n,canvasMeasure(target)));target.restore();
    } else {
      if (n.type === 'icon') { roundRect(target,n.x,n.y,n.w,n.h,10,n.color); lines(target,n.text,n.x+10,n.y+10,n.w-20,n.autoFit===false?n.fontSize:Math.min(n.fontSize,n.h-20),'#fff',n.autoFit===false?1000:2,'800'); }
      else if(n.priceTag){target.save();target.translate(n.x,n.y);canvasPrimitives(target,retailText(priceTagNode(n),canvasMeasure(target)).filter(p=>p.text!==''));target.restore();}
      else{const lineHeight=n.textLayout?.lineHeight||1.3;lines(target,n.text,n.x,n.y,n.w,n.fontSize,n.color,n.autoFit===false?1000:Math.max(1,Math.floor(n.h/(n.fontSize*lineHeight))),String(n.textLayout?.weight||600),n.textLayout?.align||'left',lineHeight,textFamily(n));}
    }
    target.restore();
  }
  if (exporting&&scene.exportMode!=='print') {
    target.save(); target.fillStyle='#ffffffdb';target.fillRect(0,HEIGHT-39,WIDTH,39);
    lines(target,`待核對海報 · 未核對門店價格 · V${scene.revision} · ${statusNames[scene.status]}`,22,HEIGHT-30,WIDTH-44,17,'#b84b43',1,'600');target.restore();
  } else if (!exporting&&selected) {
    const n=scene.nodes.find(n=>n.id===selected);
    if(n) {
      if(editingRegion&&n.type==='product'){const b=region(n,activeRegion);target.save();target.strokeStyle='#168cc4';target.lineWidth=2;target.strokeRect(n.x+b.x,n.y+b.y,b.w,b.h);target.fillStyle='#168cc4';target.fillRect(n.x+b.x+b.w-5,n.y+b.y+b.h-5,10,10);target.restore();return;}
      target.save();target.strokeStyle='#32794d';target.lineWidth=2;target.setLineDash([7,4]);target.strokeRect(n.x-4,n.y-4,n.w+8,n.h+8);target.setLineDash([]);
      target.fillStyle='#32794d';target.fillRect(n.x+n.w-5,n.y+n.h-5,10,10);
      if(focusField && n.type==='product') { target.fillStyle='#9ebe5333';const y=focusField==='price'?n.y+n.h-48:n.y+Math.max(20,n.h-Math.min(115,n.h*.4));target.fillRect(n.x,y,n.w,focusField==='price'?48:58); }
      target.restore();
    }
  }
}

function invalidatePreview() {
  if(generatedPoster)URL.revokeObjectURL(generatedPoster.url);
  generatedPoster=null;confirmedArchive=null;$('#review-confirmed').disabled=true;$('#review-confirmed').checked=false;
  $('#final-image').removeAttribute('src');$('#final-image').hidden=true;
  $('#preview-placeholder').hidden=false;$('#download-poster').disabled=true;$('#download-pdf').disabled=true;
  $('#output-status').textContent='請生成目前版本的海報預覽。';
}
// 採購任務（非舊存檔）的項目：活動資料來自採購活動表，唯讀顯示在編輯列，設定區只留底圖與尺寸。
function taskMode(){return !!workflowItem&&!workflowItem.legacy&&workflowItem.campaign_id===project.archiveCampaignId;}
function renderSteps() {
  ({w:WIDTH,h:HEIGHT}=sizeInfo(project));
  backgroundEditing=false;backgroundMoving=false;
  $('#background-tools').hidden=!pageEditing;$('#resize-page').hidden=!pageEditing;$('#edit-background').textContent=pageEditing?'完成尺寸調整':'調整海報尺寸';$('#edit-background').setAttribute('aria-expanded',String(pageEditing));
  const outputSize=sizeInfo(project);$('.canvas-size').textContent=`${outputSize.width} × ${outputSize.height} px`;$('#output-size').textContent=`${outputSize.width} × ${outputSize.height} px · ${outputSize.dpi} DPI · PNG`;
  if(project.flowVersion!==2){project.step=project.step>=5?3:project.step>=3?2:1;project.flowVersion=2;}
  // 不再有獨立的「活動資料」一步：活動資料、底圖與尺寸在「加商品」上方的設定區（採購任務的活動資料唯讀）。
  // project.step 仍沿用 2＝加商品、3＝確認下載，舊存檔的 step 1 一律當作 2。
  const task=taskMode();
  if(project.step>=3&&firstIncomplete(project,2))project.step=2;  // 活動資料未齊：回到有設定區的「加商品」
  const step=Number.isInteger(project.step)&&project.step>=2&&project.step<=3?project.step:2;
  project.step=step;
  const shown=[2,3];
  $('#step-nav').innerHTML=shown.map((n,i)=>`<button data-step="${n}" ${step===n?'aria-current="step"':''}><span>${i+1}</span>${steps[n-1].title}</button>`).join('');
  $('#step-title').textContent=`${shown.indexOf(step)+1}. ${steps[step-1].title}`;
  $('#step-hint').textContent=steps[step-1].hint+(step!==2?'':task?' 活動名稱、日期及門店來自採購活動表；如需更正，請在任務記錄按「退回採購」。':' 活動名稱、日期及門店在上方「活動資料、底圖與尺寸」填寫。');
  // 活動資料的問題在目前步驟一併列出；未填齊時自動展開設定區（只展開，不替使用者收起）。
  const setupIssues=stepIssues(project,1),issues=[...setupIssues,...stepIssues(project,step)];
  const setup=$('#task-setup');
  if(setup){
    setup.hidden=step!==2;setup.classList?.toggle('is-task',task);
    $('#task-setup-title').textContent=task?'底圖與尺寸':'活動資料、底圖與尺寸';
    if(setupIssues.length&&!task)setup.open=true;
  }
  if(step===3&&!confirmedArchive&&!issues.length)issues.push('請查看預覽，重新確認並存檔');
  $('#step-issues').textContent=issues.length?issues.join('；'):step===3?'校對已確認，可以下載。':'本步必填檢查已通過，可繼續。';
  $('#previous-step').disabled=step===shown[0];$('#next-step').hidden=step===3;
  renderStudioWorkflowBar();  // 切換項目（新建、開啟存檔）後編輯列要跟著更新
  $('#next-step').textContent=step===2?'預覽海報':'下一步：加商品';
  const summary=$('#pdf-import-summary');summary.hidden=!project.pdfImport;
  if(project.pdfImport){const pending=project.nodes.filter(n=>!n.imageOnly&&n.pdfReview===false).length;$('#pdf-import-status').textContent=`已提取 ${project.pdfImport.imageCount} 張商品圖、重建 ${project.pdfImport.productCount} 組商品；${pending} 組待核對。`+(project.pdfImport.warnings||[]).join(' ');}
  $('.studio').hidden=step!==2;$('#final-output').hidden=step!==3;
  $('.advanced-workflow').hidden=step!==3;
  $('#download-poster').disabled=!generatedPoster||generatedPoster.revision!==project.revision||project.reviewedRevision!==project.revision||confirmedArchive?.revision!==project.revision;
  $('#download-pdf').disabled=$('#download-poster').disabled;
  const currentPreview=!!generatedPoster&&generatedPoster.revision===project.revision;
  const savingThisPreview=confirming&&confirmationTarget?.owner===project&&confirmationTarget?.poster===generatedPoster&&currentPreview;
  $('#review-confirmation').hidden=step!==3;$('#review-confirmed').checked=savingThisPreview||(project.reviewedRevision===project.revision&&confirmedArchive?.revision===project.revision);$('#review-confirmed').disabled=confirming||!currentPreview;
  $('#confirmed-by').disabled=confirming;
  $('#review-confirmed').title=confirming?'正在保存核對結果，請稍候':!currentPreview?'請先生成目前版本的海報預覽':'';
  $('#review-help').textContent=confirming?'正在保存核對結果…':!currentPreview?'先生成海報預覽，才能勾選確認。需修改商品時，點上方商品名稱返回核對。':'請核對預覽後勾選確認。需修改商品時，點上方商品名稱返回核對。';
  $('#step-products').hidden=false;
  $('#step-products').innerHTML=project.nodes.filter(n=>n.type==='product').map(n=>`<div class="added-row"><button data-review-node="${esc(n.id)}"><strong>${esc(n.name||'未命名商品')}</strong><span>${esc(priceLabel(n))}</span></button><button data-remove-node="${esc(n.id)}" class="danger" aria-label="刪除 ${esc(n.name)}">刪除</button></div>`).join('')||'<p class="hint">尚未加入商品</p>';
  $('#delete-selected').disabled=!(selected||fabricEditor?.selectedIds().length);

}
function goStep(target) {
  finishDrag();fabricEditor?.stopDragging();
  const blocked=firstIncomplete(project,target);
  project.step=blocked?blocked.step:target;
  if(blocked)toast(blocked.issues[0]);
  renderSteps();queueSave();
  if(project.step===2){tab('products');draw();}
  if(project.step===3){renderChecks();if(!generatedPoster&&!generating)$('#generate-poster').click();}
  $('.step-guide').scrollIntoView({behavior:'smooth',block:'start'});
}
$('#step-nav').addEventListener('click',e=>{const b=e.target.closest('[data-step]');if(b)goStep(Number(b.dataset.step));});
$('#previous-step').addEventListener('click',()=>goStep(Math.max(1,project.step-1)));
$('#next-step').addEventListener('click',()=>goStep(Math.min(3,project.step+1)));
$('#edit-poster').addEventListener('click',()=>goStep(2));
async function confirmArchive(checked){
  if(confirming){renderSteps();return false;}
  if(!checked){project.reviewedRevision=null;confirmedArchive=null;edited('取消海報確認');return false;}
  const actor=$('#confirmed-by').value.trim();
  if(!actor||!generatedPoster||generatedPoster.revision!==project.revision){const message=!actor?'無法取得登入帳號，請重新登入後確認':'請先生成目前版本的海報預覽';toast(message);$('#output-status').textContent=message;renderSteps();return false;}
  const owner=project,poster=generatedPoster;
  const snapshot={...structuredClone(poster.snapshot),reviewedRevision:poster.revision,confirmedBy:actor};
  confirmationTarget={owner,poster};confirming=true;renderSteps();$('#output-status').textContent='正在保存確認資料及海報圖片…';
  try{
    const receipt=await archiveVersion(snapshot,{poster:poster.blob,confirmedBy:actor,onProgress(progress){
      if(project!==owner||generatedPoster!==poster)return;
      const message=progress.phase==='upload'?`正在保存核對結果：上傳圖片 ${progress.done}/${progress.total}…`:progress.phase==='save'?'正在保存核對結果及確認人…':'正在核對圖片同步狀態…';
      $('#output-status').textContent=message;$('#review-help').textContent=message;
    }});
    if(receipt?.stored===false)throw new Error('伺服器已有較新的版本（可能由其他同事修改），本次確認未保存；請重新開啟活動後再確認');
    if(project!==owner||project.revision!==poster.revision||generatedPoster!==poster)throw new Error('原版本已存檔；目前內容已改動，請重新確認');
    lastArchived={owner,revision:project.revision,receipt};clearTimeout(archiveTimer);confirmedArchive=receipt;project.reviewedRevision=project.revision;project.confirmedBy=actor;
    queueSave();$('#output-status').textContent=`已確認並存檔 #${receipt.sequence} · ${actor} · ${new Date(receipt.created_at).toLocaleString('zh-HK')}`;
    return true;
  }catch(error){toast(error.message);$('#output-status').textContent='本次確認未完成：'+error.message;return false;}
  finally{confirming=false;confirmationTarget=null;renderSteps();if(typeof loadWorkflowItem==='function'&&project.archiveCampaignId)loadWorkflowItem();}
}
$('#review-confirmed').addEventListener('change',e=>confirmArchive(e.target.checked));
$('#confirmed-by').addEventListener('input',()=>{project.reviewedRevision=null;confirmedArchive=null;renderSteps();});

function deleteNodes(ids) {
  const wanted=new Set(ids);if(!project.nodes.some(n=>wanted.has(n.id)))return;
  finishDrag();fabricEditor?.stopDragging();fabricEditor?.remove(ids);
  project.nodes=project.nodes.filter(n=>!wanted.has(n.id));selected=null;selectedPicture=null;pictureSelectionExplicit=false;editingRegion=false;focusField=null;
  edited('刪除海報元素');renderProperties();toast('已從海報移除，原始素材仍在素材庫');
}
$('#step-products').addEventListener('click',e=>{
  const remove=e.target.closest('[data-remove-node]');if(remove){deleteNodes([remove.dataset.removeNode]);return;}
  const b=e.target.closest('[data-review-node]');
  if(b){goStep(2);select(b.dataset.reviewNode,'price');$('#properties').scrollIntoView({block:'start',behavior:'smooth'});}
});
function selectPicture(nodeId,pictureId){
 activeRegion='image';editingRegion=false;selected=nodeId;selectedPicture=pictureId;pictureSelectionExplicit=true;
 renderProperties();$('#delete-selected').textContent='刪除所選商品／元素';$('#delete-selected').disabled=false;
}
function deletePictureSelection(){
 const node=project.nodes.find(n=>n.id===selected);
 if(pictureSelectionExplicit&&node?.type==='product'&&pictures(node).length>1){
  finishDrag();fabricEditor?.stopDragging();
  if(!removePicture(node,selectedPicture))return;
  selectedPicture=null;pictureSelectionExplicit=false;
  edited('刪除組內單張圖片');renderProperties();toast('已移除這張圖片，優惠件數及價格保持不變，請核對');
 }else deleteNodes(selected?[selected]:fabricEditor?.selectedIds()||[]);
}
function deleteSelection(){const ids=selected?[selected]:fabricEditor?.selectedIds()||[];deleteNodes(ids);}
$('#delete-selected').addEventListener('click',deleteSelection);
window.addEventListener('keydown',e=>{
  if(project.step!==2||!['Delete','Backspace'].includes(e.key)||e.target.closest('input,textarea,select,[contenteditable],dialog')||document.querySelector('dialog[open]'))return;
  const ids=selected?[selected]:fabricEditor?.selectedIds()||[];if(ids.length){e.preventDefault();deleteSelection();}
});

function productOptions(value = '', candidates = [], serverOnly = false, uploadsOnly = false) {
  const options=serverOnly&&candidates.length?candidates:[...new Map([...project.products.filter(p=>uploadsOnly?isUploadAsset(p,project.products):(!p.libraryHidden&&p.source!=='sample')||p.id===value),...candidates].map(p=>[p.id,p])).values()];
  return '<option value="">請選擇商品圖片</option>'+options.map(p=>`<option value="${esc(p.id)}" ${p.id===value?'selected':''}>${esc(p.name)} · ${esc(p.angle||p.filename||'上傳圖片')}</option>`).join('');
}
function secondCampaignImage(row,i){
 return [2,3,4].filter(number=>row['code'+number]).map(number=>{
 const second=row[number===2?'companion':'companion'+number]||{},asset=[...(second.libraryProducts||[]),...project.products].find(p=>p.id===second.assetId);
 return `<div class="paired-image"><strong>第${number}件 · ${esc(row['code'+number])}</strong><select data-import-row="${i}" data-import-second="${number}" aria-label="第 ${row.row} 行第二件圖片">${productOptions(second.assetId,second.libraryProducts||[],true)}</select>${asset?`<img src="${esc(asset.imageUrl)}" alt="${esc(asset.name)}">`:'<small>請選擇第二件商品圖片</small>'}</div>`;
 }).join('');
}
function renderCampaignImport() {
  const data=campaignImport;if(!data)return;
  $('#campaign-problems').innerHTML=data.errors.map(e=>`<div class="check error">${esc(e)}</div>`).join('')+data.warnings.map(e=>`<div class="check">${esc(e)}</div>`).join('');
  $('#campaign-rows').innerHTML=data.rows.map((row,i)=>{
    const asset=[...(row.libraryProducts||[]),...project.products].find(p=>p.id===row.assetId);
    return `<tr><td>${row.row}</td><td><strong>${esc(row.name)}</strong><br>${esc(row.sku||'無商品編號')}${row.productid?` · productid ${esc(row.productid)}`:''} · ${esc(row.spec||'規格待核對')}</td><td>${row.price2?`第一件 $${esc(row.price)}<br>第二件 $${esc(row.price2)}`:`$${esc(row.price)} / ${row.quantity}件`}</td><td><select data-import-row="${i}" aria-label="第 ${row.row} 行商品圖片">${productOptions(row.assetId,row.libraryProducts||[],!!row.productid)}</select>${asset?`<img src="${esc(asset.imageUrl)}" alt="${esc(asset.name)}">`:'<small>缺圖或多個匹配，請選擇正確圖片；可取消後先上傳缺少的素材。</small>'}${secondCampaignImage(row,i)}</td></tr>`;
  }).join('');
  $('#apply-campaign').disabled=!!data.errors.length||!data.rows.length||data.rows.some(r=>!r.assetId||[2,3,4].some(i=>r['code'+i]&&!r[i===2?'companion':'companion'+i]?.assetId));
}
$('#campaign-upload').addEventListener('change',async e=>{
  const sheetStamp=pendingSheetStamp;pendingSheetStamp=null;  // 只屬於由任務活動表觸發的這一次匯入
  const file=e.target.files[0];if(!file)return;
  e.target.disabled=true;$('#import-progress').textContent='正在檢查表格並匹配商品圖片…';const owner=project;
  try{
    const kind=file.name.split('.').at(-1).toLowerCase();if(!['xlsx','csv'].includes(kind))throw new Error('請使用 .xlsx 或 UTF-8 .csv');
    if(file.size>5*1024*1024)throw new Error('Excel 不可超過 5 MB');
    const response=await fetch(`/api/import-campaign?kind=${kind}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
    const data=await response.json().catch(()=>null);
    if(!response.ok||!data)throw new Error(data?.detail||'表格解析服務不可用，請啟動完整 Docker 服務');
    if(owner!==project)throw new Error('專案已切換，請重新匯入');
    campaignImport={...data,filename:file.name,sheetStamp,rows:await matchCampaign(data.rows,provider)};renderCampaignImport();$('#campaign-dialog').showModal();
    $('#import-progress').textContent=`已讀取 ${data.rows.length} 行商品，請確認資料及图片匹配。`;
  }catch(error){toast(error.message);$('#import-progress').textContent=error.message;}
  finally{e.target.value='';e.target.disabled=false;}
});
$('#campaign-rows').addEventListener('change',e=>{
  if(e.target.dataset.importRow===undefined||!campaignImport)return;
  const row=campaignImport.rows[Number(e.target.dataset.importRow)];
  const target=e.target.dataset.importSecond?row[Number(e.target.dataset.importSecond)>2?'companion'+e.target.dataset.importSecond:'companion']:row;if(!target)return;target.assetId=e.target.value;renderCampaignImport();
});
$('#close-campaign').addEventListener('click',()=>{$('#campaign-dialog').close();campaignImport=null;});
$('#apply-campaign').addEventListener('click',async ()=>{
  if(!campaignImport||campaignImport.errors.length)return;
  if(project.nodes.length&&!confirm('匯入會替換目前海報的活動資料及畫布。請確認已備份。'))return;
  try{
    const owner=project, pending=campaignImport;
    const next=structuredClone(owner);
    await snapshotCampaignImages(next,pending.rows);
    await measureAssets(next,pending.rows.flatMap(row=>[row.assetId,...['companion','companion3','companion4'].map(k=>row[k]?.assetId).filter(Boolean)]));
    if(project!==owner||campaignImport!==pending)return;
    // 一般匯入建立新活動；採購任務的活動表匯入必須保留任務的活動編號，否則存檔與確認會脫離任務。
    applyCampaign(next,pending.rows,pending.filename);Object.assign(project,next);project.step=2;if(!taskMode())project.archiveCampaignId=uid();selected=null;selectedPicture=null;
    // 記下套用的是任務哪一次上傳的活動表；採購之後重新提交時，編輯頁據此提示重新匯入。
    if(taskMode()&&pending.sheetStamp?.campaign===project.archiveCampaignId)project.sheetImportedAt=pending.sheetStamp.stamp;
    edited('Excel 活動匯入');refresh();tab('products');$('#campaign-dialog').close();campaignImport=null;
    $('#import-progress').textContent='已產生海報草稿，請確認底圖、商品擺放及促銷資料。';
  }catch(error){toast(error.message);}
});
function renderBackgrounds() {
  const uploaded=availableBackgrounds(),options=[...backgrounds,...uploaded];
  if(project.template==='custom' && !options.some(b=>b.id===project.backgroundId))options.push({id:'custom',name:'目前自訂底圖'});
  const current=project.template==='custom'?(options.find(b=>b.imageUrl===project.background)?.id||project.backgroundId||'custom'):project.template;
  $('#background-select').innerHTML=options.map(b=>`<option value="${esc(b.id)}" ${b.id===current?'selected':''}>${esc(b.label||b.name)}</option>`).join('');
  const picker=$('#tab-templates');picker.querySelectorAll('[data-uploaded-background]').forEach(el=>el.remove());
  const anchor=picker.querySelector('[data-template]');
  for(const asset of uploaded){
    const card=document.createElement('button');card.type='button';card.className='template-card';card.dataset.uploadedBackground=asset.id;
    const active=project.template==='custom'&&project.background===asset.imageUrl;card.setAttribute('aria-pressed',String(active));
    const image=document.createElement('img');image.src=asset.imageUrl;image.alt=asset.label||asset.name;image.loading='lazy';
    const title=document.createElement('strong');title.textContent=asset.label||asset.name;
    const caption=document.createElement('small');caption.textContent=active?'✓ 目前使用的上傳底圖':'已上傳底圖／PDF 頁面 · 點擊使用';
    card.append(image,title,caption);picker.insertBefore(card,anchor);
  }
  picker.querySelectorAll('[data-template]').forEach(card=>card.setAttribute('aria-pressed',String(card.dataset.template===project.template)));

}
function compositionProperties(n) {
  const items=pictures(n);
  if(!items.some(p=>p.id===selectedPicture))selectedPicture=items.at(-1).id;
  const active=items.find(p=>p.id===selectedPicture);
  const options=items.map((p,i)=>{const asset=project.products.find(a=>a.id===p.productId);return `<option value="${esc(p.id)}" ${p.id===selectedPicture?'selected':''}>${i+1}. ${esc(asset?.name||'未知圖片')} · ${i===items.length-1?'最前':'後層'}</option>`;}).join('');
  const thumbnails=items.map((p,i)=>{const asset=project.products.find(a=>a.id===p.productId);return `<button type="button" class="picture-choice ${pictureSelectionExplicit&&p.id===selectedPicture?'active':''}" data-select-picture="${esc(p.id)}" aria-pressed="${pictureSelectionExplicit&&p.id===selectedPicture}"><img src="${esc(asset?.imageUrl||'')}" alt="${esc(asset?.name||'商品圖片')}"><span>${i+1} · ${i===items.length-1?'前層':'後層'}</span></button>`;}).join('');
  const sliders=['x','y','w','h'].map((key,i)=>`<label>${['水平位置','垂直位置','圖片寬度','圖片高度'][i]} %<input type="range" data-picture-prop="${key}" min="${i>1?10:0}" max="100" value="${Math.round(active[key]*100)}"></label>`).join('');
  return `<section class="composition-panel"><h3>圖片展示 · ${items.length} 張</h3><div class="picture-choices">${thumbnails}</div><button data-compose="remove" class="danger" ${!pictureSelectionExplicit?'disabled':''}>刪除所選圖片</button><button class="primary" data-compose="prepare">${pictureSelectionExplicit?'抠圖所選圖片':'去背景並優化組合'}</button><div class="property-buttons"><button data-compose="duplicate">＋ 加一張</button><button data-compose="auto">自動排列</button><button data-compose="overlap" title="再次點擊切換前後順序">前後錯落 ⇄</button></div><p class="hint">兩張圖片自動前後錯落；點縮圖可選中其中一張並刪除。圖片張數不會更改優惠件數。再次點擊「前後錯落」可切換前後順序，位置及大小保持不變。請使用透明底商品圖。</p><details><summary>替換圖片 / 組合不同商品</summary><label>選擇組內圖片<select id="picture-select">${options}</select></label><label>選擇素材<select id="composition-product">${productOptions()}</select></label><div class="property-buttons"><button data-compose="add">加入組合</button><button data-compose="replace">替換圖片</button></div><label>合併另一商品<select id="merge-product"><option value="">請選擇</option>${project.nodes.filter(v=>v.type==='product'&&v.id!==n.id).map(v=>`<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></label><button data-compose="merge">合併（需重填總價）</button><details><summary>微調位置與前後</summary><div class="property-grid">${sliders}</div><button data-compose="forward">圖片前移</button><button data-compose="backward">圖片後移</button></details></details></section>`;

}
$('#add-selected-product').addEventListener('click',()=>{const id=$('#product-select').value;if(id)addIndexedProduct(id);else toast('請先選擇商品图片');});
$('#merge-selected').addEventListener('click',()=>{
  const ids=fabricEditor?.selectedIds()||[], nodes=ids.map(id=>project.nodes.find(n=>n.id===id));
  if(nodes.length<2||nodes.some(n=>n?.type!=='product'))return toast('請按 Shift 多選至少兩個商品組件');
  if(nodes.reduce((sum,n)=>sum+pictures(n).length,0)>6)return toast('每組最多 6 張圖片');
  if(!confirm('合併所選商品將保留第一組名稱，合計件數並清空價格，請重新核對總價。'))return;
  for(const id of ids.slice(1))mergeProducts(project,ids[0],id);
  selected=ids[0];edited('多選商品合併');renderProperties();
});
let cutoutBusy=false;
async function startCutout(assetId,targetNodeId=null,remaining=[],targetPictureId=null) {
  if(cutoutBusy)return toast('抠圖任務仍在進行，可刷新後繼續查看');
  const asset=await provider.get(assetId);if(!asset)return;
  const ownerProject=project;cutoutBusy=true;cutoutDraft=null;
  $('#cutout-dialog').showModal();$('#cutout-original').src=asset.imageUrl;
  $('#cutout-result').removeAttribute('src');$('#save-cutout').disabled=true;
  let stage='讀取原圖',jobId=null;
  $('#cutout-status').textContent='正在讀取原圖…';
  try{
    const body=await cutoutSource(asset.imageUrl);
    stage='提交圖片';$('#cutout-status').textContent='正在提交圖片…';
    const job=await (await cutoutResponse('/api/cutout-jobs',{method:'POST',headers:{'Content-Type':body.type},body})).json();
    jobId=job.id;
    if(ownerProject!==project||!project.products.some(p=>p.id===assetId)){$('#cutout-status').textContent='項目已切換，本次抠圖已取消';return;}
    stage='保存任務記錄';
    project.cutoutPending={jobId:job.id,assetId,targetNodeId,remaining,targetPictureId};
    rememberCutout(project,project.cutoutPending);queueSave();
    stage='取得抠圖進度或結果';
    await followCutout(project.cutoutPending,ownerProject);
  }catch(error){if(project===ownerProject)$('#cutout-status').textContent=cutoutFailure(error,stage,jobId);}
  finally{cutoutBusy=false;}
}
async function followCutout(pending,ownerProject){
  try{await loadCutoutResult(pending,ownerProject);}
  catch(error){
    if(error.status===404&&project===ownerProject&&project.cutoutPending===pending){
      delete project.cutoutPending;rememberCutout(project,null);queueSave();
      $('#cutout-status').textContent='抠圖任務已過期或已清理，請重新提交。原圖與已保存的素材仍保留。';
      return;
    }
    throw error;
  }
}
async function loadCutoutResult(pending,ownerProject){
  const asset=await provider.get(pending.assetId);if(!asset)throw new Error('原始商品素材不存在');
  while(project===ownerProject&&project.cutoutPending===pending){
    const job=await (await cutoutResponse(`/api/cutout-jobs/${encodeURIComponent(pending.jobId)}`)).json();
    if(job.state==='failed')throw new Error(job.error||'抠圖失敗');
    if(job.state==='succeeded')break;
    $('#cutout-status').textContent=cutoutProgress(job)+'任務編號：'+pending.jobId+'；可用「查看抠圖任務」恢復。';
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(project!==ownerProject||project.cutoutPending!==pending)return;
  const response=await cutoutResponse(`/api/cutout-jobs/${encodeURIComponent(pending.jobId)}/result`);
  const imageUrl=await readImage(new File([await response.blob()],'cutout.png',{type:'image/png'}));
  if(project!==ownerProject||project.cutoutPending!==pending)return;
  let result=project.products.find(p=>p.cutoutJobId===pending.jobId);
  if(!result){
    if(project.products.length>=100)throw new Error('素材庫已滿；結果仍保存在伺服器，請先整理素材');
    result={...structuredClone(asset),id:uid(),imageUrl,originalAssetId:asset.id,source:'cutout',cutoutReviewed:false,cutoutJobId:pending.jobId,angle:`${asset.angle||'商品圖'} · 透明底待確認`,filename:`${(asset.filename||asset.name).replace(/\.[^.]+$/,'')}-cutout.png`};
    project.products.push(result);
  }
  pending.resultAssetId=result.id;rememberCutout(project,pending);queueSave();renderLibrary();
  cutoutDraft={...pending,imageUrl,ownerProject};$('#cutout-result').src=imageUrl;
  $('#save-cutout').textContent=pending.targetNodeId?'確認效果並套用到商品':'確認效果';$('#save-cutout').disabled=false;
  $('#cutout-status').textContent='抠圖完成，已顯示伺服器任務結果。請確認包裝邊緣與文字；素材保存狀態請查看頁面頂部。';
}
async function resumeCutout(){
  if(cutoutBusy){$('#cutout-dialog').showModal();return;}const pending=project.cutoutPending;if(!pending)return toast('目前沒有待查看的抠圖任務');
  cutoutBusy=true;cutoutDraft=null;
  $('#cutout-dialog').showModal();$('#save-cutout').disabled=true;$('#cutout-result').removeAttribute('src');
  $('#cutout-original').src=project.products.find(p=>p.id===pending.assetId)?.imageUrl||'';
  $('#cutout-status').textContent='正在恢復抠圖任務…';
  try{await followCutout(pending,project);}catch(error){$('#cutout-status').textContent=cutoutFailure(error,'恢復抠圖結果',pending.jobId);}
  finally{cutoutBusy=false;}
}
$('#resume-cutout').addEventListener('click',resumeCutout);
$('#product-list').addEventListener('click',e=>{const b=e.target.closest('[data-cutout]');if(b)startCutout(b.dataset.cutout);});
$('#close-cutout').addEventListener('click',()=>{$('#cutout-dialog').close();cutoutDraft=null;});
$('#cutout-dialog').addEventListener('cancel',()=>{cutoutDraft=null;});
$('#save-cutout').addEventListener('click',async()=>{
  const draft=cutoutDraft;if(!draft)return;
  const source=await provider.get(draft.assetId);if(!source||draft.ownerProject!==project)return toast('原始專案或素材已變更');
  if(project.products.length>=100&&!project.products.some(p=>p.id===draft.resultAssetId))return toast('素材數量已達 100 張');
  const known=project.products.find(p=>p.source==='sample'&&p.filename===source.filename);
  const fileNameOnly=source.name===(source.filename||'').replace(/\.[^.]+$/,'');
  const asset={...structuredClone(source),id:uid(),imageUrl:draft.imageUrl,originalAssetId:source.id,source:'cutout',assetVersion:1,angle:`${source.angle||'商品圖'} · 透明底`,filename:`${(source.filename||source.name).replace(/\.[^.]+$/,'')}-cutout.png`};
  if(fileNameOnly&&known){asset.name=known.name;asset.spec=known.spec;}
  const saved=project.products.find(p=>p.id===draft.resultAssetId);
  if(saved){asset.id=saved.id;Object.assign(saved,asset,{cutoutReviewed:true});}else project.products.push(asset);
  await measureAssets(project,[asset.id]);
  delete project.cutoutPending;rememberCutout(project,null);
  const node=project.nodes.find(n=>n.id===draft.targetNodeId&&n.type==='product');
  if(node){
    ensurePictures(node);replacePictureAsset(node,source.id,asset.id,draft.targetPictureId);
    if(fileNameOnly&&known&&node.name===source.name){node.name=known.name;if(!node.spec)node.spec=known.spec;}
    // Cutout replaces pixels only; preserve the user's picture layout and scale.
    selected=node.id;edited('確認抠圖並替換商品組合');renderProperties();
  }
  cutoutDraft=null;$('#cutout-dialog').close();queueSave();await renderLibrary();$('#product-select').value=asset.id;
  if(node&&draft.remaining.length)await startCutout(draft.remaining[0],node.id,draft.remaining.slice(1));
  else toast(node?'已套用透明底商品圖，請填寫並核對商品名稱、規格及價格':'透明底素材已保存，可加入畫布');
});
async function prepareProduct(node,cycle=false) {
  if(cycle&&pictures(node).length<2)return toast('請先點「加一張」，兩張以上圖片才可切換前後');
  const ids=[];
  for(const id of new Set(pictures(node).map(p=>p.productId))){
    const asset=project.products.find(p=>p.id===id);if(!asset)continue;
    if(asset.source==='cutout')continue;
    const image=getImage(asset.imageUrl);await image.decode();
    const probe=document.createElement('canvas');probe.width=64;probe.height=64;
    const context=probe.getContext('2d');context.drawImage(image,0,0,64,64);
    const pixels=context.getImageData(0,0,64,64).data;
    let transparent=false;for(let i=3;i<pixels.length;i+=4)if(pixels[i]<240){transparent=true;break;}
    if(!transparent)ids.push(id);
  }
  if(ids.length)await startCutout(ids[0],node.id,ids.slice(1));
  else {if(cycle){cycleOverlap(node);edited('商品前後順序切換');renderProperties();}else toast('商品圖片已是透明底，已保留目前大小及位置');}
}
function selectBackground(id){
  const preset=backgrounds.find(b=>b.id===id),asset=availableBackgrounds().find(b=>b.id===id);
  if(!preset&&!asset)return;
  if((preset&&project.template===id)||(asset&&project.template==='custom'&&project.background===asset.imageUrl)){renderBackgrounds();return;}
  delete project.posterReuse;delete project.backgroundPlacement;delete project.templateImage;
  if(preset){project.template=id;project.background=null;project.backgroundId=null;}
  else {project.template='custom';project.background=asset.imageUrl;project.backgroundId=asset.id;}
  if(id==='retail')activateRetail();edited('底圖選擇');renderBackgrounds();renderProperties();syncRetailControls();
}
$('#background-select').addEventListener('change',e=>selectBackground(e.target.value));
$('#tab-templates').addEventListener('click',e=>{const button=e.target.closest('[data-uploaded-background]');if(button)selectBackground(button.dataset.uploadedBackground);});
$('#properties').addEventListener('change',e=>{if(e.target.id==='picture-select'){selectPicture(selected,e.target.value);draw();}});
$('#properties').addEventListener('input',e=>{
  const key=e.target.dataset.pictureProp;if(!key)return;
  const n=project.nodes.find(n=>n.id===selected);if(!n||n.type!=='product')return;
  const pic=ensurePictures(n).find(p=>p.id===selectedPicture);if(!pic)return;
  pic[key]=Number(e.target.value)/100;
  pic.x=Math.min(pic.x,1-pic.w);pic.y=Math.min(pic.y,1-pic.h);
  if(key==='x')pic.x=Math.min(Number(e.target.value)/100,1-pic.w);
  if(key==='y')pic.y=Math.min(Number(e.target.value)/100,1-pic.h);
  e.target.value=Math.round(pic[key]*100);edited('組內圖片位置修改');
});
$('#properties').addEventListener('click',async e=>{
  const choice=e.target.closest('[data-select-picture]');if(choice){selectPicture(selected,choice.dataset.selectPicture);draw();return;}
  const action=e.target.closest('[data-compose]')?.dataset.compose;if(!action)return;
  const n=project.nodes.find(n=>n.id===selected);if(!n||n.type!=='product')return;
  try {
    if(action==='remove'){deletePictureSelection();return;}
    if(action==='prepare'&&pictureSelectionExplicit){const pic=pictures(n).find(p=>p.id===selectedPicture);if(pic)await startCutout(pic.productId,n.id,[],pic.id);return;}
    if(action==='prepare'||action==='overlap'){await prepareProduct(n,action==='overlap');return;}
    const owner=project;
    await measureAssets(owner,[...pictures(n).map(p=>p.productId),$('#composition-product')?.value].filter(Boolean));
    if(project!==owner||!project.nodes.includes(n))return;
    const items=ensurePictures(n);
    if(action==='duplicate')selectedPicture=addPicture(n,items.find(p=>p.id===selectedPicture)?.productId||n.productId);
    if(action==='add'){const id=$('#composition-product').value;if(!id)throw new Error('請選擇商品圖片');selectedPicture=addPicture(n,id);}
    if(action==='replace'){const id=$('#composition-product').value;if(!id)throw new Error('請選擇替換圖片');const pic=items.find(p=>p.id===selectedPicture);if(pic)replacePictureAsset(n,pic.productId,id,pic.id);}
    if(action==='forward'||action==='backward')movePicture(n,selectedPicture,action==='forward'?1:-1);
    if(action==='side'||action==='overlap')layoutPictures(n,action);
    if(action==='merge'){
      const id=$('#merge-product').value;if(!id)throw new Error('請選擇另一個商品組件');
      if(!confirm('將另一商品合併進本組，保留本組名稱及規格、合計優惠件數，並清空總價供重新確認。是否繼續？'))return;
      mergeProducts(project,n.id,id);toast('已合併，請確認組合名稱、規格及優惠總價');
    }
    if(['auto','duplicate','add','replace','remove','merge'].includes(action))autoLayoutPictures(n,project.products);
    edited('商品組合修改');renderProperties();
  }catch(error){toast(error.message);}
});
async function renderLibrary() {
  const products = await provider.list($('#product-search').value);
  const choice=$('#product-select').value;
  $('#product-select').innerHTML=productOptions(choice,[],false,true);
  const visibleCount=project.products.filter(p=>isUploadAsset(p,project.products)).length;
  $('#product-count').textContent=visibleCount;
  $('#index-count').textContent=`${visibleCount} 已索引`;
  $('#product-list').innerHTML = products.length ? products.map(p=>`<article class="product-card"><img src="${esc(p.imageUrl)}" alt="${esc(p.name)}"><strong title="${esc(p.name)}">${esc(p.name)}</strong><small title="${esc(p.filename||p.name)}">${esc(p.sku||p.filename||'本機上傳')}</small><button data-add="${esc(p.id)}">＋ 加入畫布</button><button class="index-edit" data-edit-index="${esc(p.id)}">編輯索引</button><button data-cutout="${esc(p.id)}">自動抠圖</button><button data-delete-asset="${esc(p.id)}" class="danger">刪除素材</button></article>`).join('') : '<div class="empty-state">尚無符合的商品<br>上傳圖片，開始第一張海報</div>';
}
function renderTextResults() {
  const query=$('#text-search').value.trim().toLowerCase();
  const entries=textEntries(project).filter(e=>e.text && `${e.text} ${project.nodes.find(n=>n.id===e.id)?.sku || ''}`.toLowerCase().includes(query));
  $('#text-results').innerHTML=entries.length?entries.map(e=>`<button class="text-result" data-locate="${esc(e.id)}" data-field="${e.field}"><small>${e.label}</small><span>${esc(e.text)}</span></button>`).join(''):'<div class="empty-state">沒有符合的文字</div>';
}
function renderStatus() {
  $('#current-project-label').textContent=`目前項目：${project.campaign.name||'未命名'}`;
  $('#workflow-status').textContent=statusNames[project.status];$('#version').textContent=`版本 ${project.revision}`;
  $('#submit').disabled=project.status!=='draft';$('#approve').disabled=project.status!=='review';$('#return-draft').disabled=project.status==='draft';
  $('#history').innerHTML=project.history.slice(0,5).map(e=>`<div>${esc(new Date(e.at).toLocaleString('zh-HK'))} · V${e.revision}<br>${esc(e.message)}</div>`).join('');
  $('#element-count').textContent=`${project.nodes.length} 個元素`;
}
function renderChecks() {
  const {errors,warnings}=validate(project);
  const dimensions=sizeInfo(project);
  for(const n of project.nodes.filter(n=>n.type==='product'))for(const pic of pictures(n)){
    const image=getImage(project.products.find(a=>a.id===pic.productId)?.imageUrl);if(!image?.naturalWidth)continue;
    const areaH=imageRegion(n).h;
    const factor=Math.min(pic.w*n.w/image.naturalWidth,pic.h*areaH/image.naturalHeight)*dimensions.scale;
    if(factor>1.2)warnings.push(`${n.name}：商品圖片輸出約放大 ${factor.toFixed(1)} 倍，建議更換高清素材`);
  }
  if(project.exportMode==='print'){const d=sizeInfo(project),safe=3*d.dpi/25.4/d.scale;for(const n of project.nodes)if(n.x<safe||n.y<safe||n.x+n.w>d.w-safe||n.y+n.h>d.h-safe)warnings.push('有元素距裁切邊緣不足 3 mm，請確認印刷安全邊距');}
  const measure=canvasMeasure(ctx);
  for(const n of project.nodes.filter(n=>n.type==='product')){
   if(overlappingText(n,measure).length)errors.push(`${n.name}：名稱、規格、原價或價格重疊，請點「重新整理文字間距」；空間不足時增大商品組或減小字號`);
   const overflow=retailText(n,measure).some(p=>{if(p.type!=='text'||!p.part||p.clip)return false;const b=region(n,p.part);return p.x<b.x-.5||p.y<b.y-.5||p.x+measure(p.text,p.size,p.family,p.weight)>b.x+b.w+.5||p.y+p.size>b.y+b.h+.5;});
   if(overflow)warnings.push(`${n.name}：文字超出設定區域，請加大區域或開啟自動縮字`);
  }
  $('#check-results').innerHTML=(errors.length?errors.map(e=>`<div class="check error">! ${esc(e)}</div>`).join(''):'<div class="check ok">✓ 必填資料與基礎價格格式已通過</div>')+warnings.map(w=>`<div class="check">△ ${esc(w)}</div>`).join('');
}
const input = (label,key,value,type='text',extra='') => `<label>${label}<input data-prop="${key}" type="${type}" value="${esc(value)}" ${extra}></label>`;
function renderProperties() {
  const n=project.nodes.find(n=>n.id===selected);
  if(!n||n.type!=='product'||!pictures(n).some(p=>p.id===selectedPicture))pictureSelectionExplicit=false;
  $('#delete-selected').textContent='刪除所選商品／元素';
  if(!n) { $('#properties').innerHTML='<div class="empty-state">選取畫布上的商品或文字<br>即可調整內容、尺寸與層級</div>';return; }
  $('#delete-selected').textContent='刪除所選商品／元素';
  let html=`<div class="selection-title">${n.type==='product'?'商品組件':['icon','imageIcon'].includes(n.type)?'促銷標識':'文字圖層'}</div>`;
  if(n.type==='product'){html+=`<label><input data-prop="imageOnly" type="checkbox" ${n.imageOnly?'checked':''}>只顯示圖片（隱藏名稱、規格及價格）</label>`;html+=n.imageOnly?compositionProperties(n):compositionProperties(n)+retailProperties(n);if(n.pdfOcr&&!n.imageOnly)html+=`<section class="checks"><h3>PDF 識別核對</h3><p class="hint">對照原頁核對名稱、規格、優惠總價及件數；識別結果可能有誤。</p><details><summary>識別原文</summary><pre style="white-space:pre-wrap">${esc([...n.pdfOcr.nameAndSpec,...n.pdfOcr.offer].map(r=>r.text).join('\n'))}</pre></details><label><input data-prop="pdfReview" type="checkbox" ${n.pdfReview?'checked':''}>已對照原 PDF 核對此商品</label></section>`;}
  else if(n.type==='imageIcon')html+=input('標識名稱','text',n.text,'text','maxlength="200"')+'<p class="hint">圖片等比例顯示，可拖曳、縮放及調整前後層級。</p>';
  else if(n.priceTag)html+=`<div class="property-grid"><label>總價<input data-price-tag="price" type="number" min="0.01" max="9999999" step="0.01" value="${esc(n.priceTag.price)}"></label><label>件數<input data-price-tag="quantity" type="number" min="1" max="99" step="1" value="${n.priceTag.quantity}"></label></div><p class="hint">展示：${esc(n.text)}。平均每件價由總價 ÷ 件數自動計算。</p>`;
  else{html+=`<label>顯示文字<textarea data-prop="text" rows="3" maxlength="200">${esc(n.text)}</textarea></label><p class="hint">用 ~~文字~~ 加刪除線（例如 ~~$14~~），**文字** 加粗（例如 **樂事**）。</p>`;if(n.type==='text'){const layout=n.textLayout||{};html+=`<div class="property-grid"><label>字重<select data-text-layout="weight">${[[300,'細'],[400,'標準'],[500,'中等'],[600,'半粗'],[700,'粗']].map(([v,l])=>`<option value="${v}" ${(layout.weight||600)===v?'selected':''}>${l}</option>`).join('')}</select></label><label>字體<select data-text-layout="font">${[['default','預設（蘋方）'],['poster','海報（英數 Arial）']].map(([v,l])=>`<option value="${v}" ${(layout.font||'default')===v?'selected':''}>${l}</option>`).join('')}</select></label><label>對齊<select data-text-layout="align">${[['left','靠左'],['center','置中'],['right','靠右']].map(([v,l])=>`<option value="${v}" ${(layout.align||'left')===v?'selected':''}>${l}</option>`).join('')}</select></label></div>`;}}
  html+=`<label><input data-prop="locked" type="checkbox" ${n.locked?'checked':''}>鎖定位置及尺寸</label>`;
  html+='<details class="advanced-settings"><summary>進階：尺寸、陰影與層級</summary>';
  html+=`<div class="property-grid">${input('X 位置','x',Math.round(n.x),'number',`min="0" max="${WIDTH}"`)}${input('Y 位置','y',Math.round(n.y),'number',`min="0" max="${HEIGHT}"`)}${input('寬度','w',Math.round(n.w),'number',`min="60" max="${WIDTH}"`)}${input('高度','h',Math.round(n.h),'number',`min="60" max="${HEIGHT}"`)}${['imageIcon','product'].includes(n.type)?'':input('字號','fontSize',n.fontSize,'number','min="1" max="1000"')+input('文字 / 標識顏色','color',n.color,'color')}</div>`;
  if(['text','icon'].includes(n.type))html+=`<label><input data-prop="autoFit" type="checkbox" ${n.autoFit!==false?'checked':''}>自動縮字以符合區域</label><p id="font-status" class="hint" role="status"></p>`;
  if(n.type==='product') html+=input('陰影強度','shadow',n.shadow,'range','min="0" max="30"');
  html+='<div class="property-buttons"><button data-action="front">移至最前</button><button data-action="back">移至最後</button><button data-action="duplicate">複製</button></div></details>';
  html+=`<button data-delete-node="${esc(n.id)}" class="danger remove-product">${n.type==='product'?'刪除此商品（含圖片、文字及價格）':'刪除此元素'}</button>`;
  $('#properties').innerHTML=html;syncFontStatus(n);
}
function select(id, field=null) { if(['name','spec','original','price'].includes(field))activeRegion=field;editingRegion=false; pictureSelectionExplicit=false; $('#delete-selected').disabled=!id;if(selected!==id)selectedPicture=null;selected=id;focusField=field;renderProperties();draw(); }
function refresh() {
  repairPairedPriceBindings(project);
  project.exportMode='print';
  renderBatchCutout();
  const freshlyLoaded=historyOwner!==project;
  if(historyOwner!==project){editHistory.reset(project);historyOwner=project;historyButtons();}
  upgradeCanvasCoordinates(project);
  const repair=freshlyLoaded?repairProjectText(project,canvasMeasure(ctx)):{repaired:[],unresolved:[]};
  if(repair.repaired.length){editHistory.record(project);touch(project,'修復已保存的商品文字重疊');invalidatePreview();historyButtons();}
  const page=project.page||{width:1800,height:2560,unit:'px',dpi:150};for(const key of ['width','height','unit','dpi'])$('#page-'+key).value=page[key];
  provider = new UploadProductProvider(project.products);
  $('#campaign-name').value=project.campaign.name;$('#start-date').value=project.campaign.start;$('#end-date').value=project.campaign.end;$('#stores').value=project.campaign.stores;
  project.archiveCampaignId ||= uid();$('#confirmed-by').value=window.posterUser?.username||'';
  syncRetailControls();renderSteps();renderBackgrounds();renderLibrary();renderProperties();renderTextResults();renderStatus();renderChecks();draw();
  if(repair.repaired.length){queueSave();toast(`已修復 ${repair.repaired.length} 個商品的舊文字重疊，請重新確認海報`);}
}
function tab(name) { document.querySelectorAll('[data-tab]').forEach(b=>{const active=b.dataset.tab===name;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active));});document.querySelectorAll('.library .tab-body').forEach(el=>el.hidden=el.id!==`tab-${name}`); }
document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>tab(b.dataset.tab)));
$('#product-search').addEventListener('input',renderLibrary);$('#text-search').addEventListener('input',renderTextResults);
$('#product-upload').addEventListener('change',async e=>{
  const files=[...e.target.files];let added=0;
  for(const file of files) {
    try { if(project.products.length>=100)throw new Error('最多儲存 100 張素材');await provider.upload(file);added++;queueSave(); }
    catch(error){toast(`${file.name}：${error.message}`);}
  }
  renderLibrary();e.target.value='';if(added)toast(`已加入 ${added} 張素材，點擊「加入畫布」開始排版`);
});
async function measureAssets(owner,ids) {
  await Promise.all([...new Set(ids)].map(async id=>{
    const asset=owner.products.find(p=>p.id===id);if(!asset)return;
    try{const image=getImage(asset.imageUrl);await image.decode();asset.imageWidth=image.naturalWidth;asset.imageHeight=image.naturalHeight;
      const probe=document.createElement('canvas');probe.width=160;probe.height=160;
      const context=probe.getContext('2d');context.drawImage(image,0,0,160,160);
      const rgba=context.getImageData(0,0,160,160).data;let left=160,right=-1;
      for(let y=0;y<160;y++)for(let x=0;x<160;x++)if(rgba[(y*160+x)*4+3]>16){left=Math.min(left,x);right=Math.max(right,x);}
      asset.imageBounds=right>=left?{x:left/160,w:(right-left+1)/160}:{x:0,w:1};}catch{/* Broken assets remain visible to existing checks; use a neutral ratio. */}
  }));
}
function arrangeAllProducts(){
  arrange(project);
  for(const node of project.nodes.filter(n=>n.type==='product'&&!n.locked))autoLayoutPictures(node,project.products);
}
async function addIndexedProduct(id) {
  if(project.nodes.length>=100)return toast('最多支援 100 個元素');
  const product=await provider.get(id);if(!product)return;
  const owner=project;
  if(project.template==='retail'&&project.nodes.filter(n=>n.type==='product').length>=(project.retailRows||[3,3,4]).reduce((a,b)=>a+b,0))return toast('模板格數已滿，請先在第一步增加每行商品數');
  await measureAssets(owner,[...owner.nodes.filter(n=>n.type==='product').flatMap(n=>pictures(n).map(p=>p.productId)),id]);
  if(project!==owner||!project.products.some(p=>p.id===id))return;
  const node=productNode(product,project.nodes.filter(n=>n.type==='product').length);project.nodes.push(node);
  if(project.template==='custom'&&project.posterReuse){Object.assign(node,clampNodeTransform(node,WIDTH,HEIGHT));autoLayoutPictures(node,project.products);}else arrangeAllProducts();
  selected=node.id;
  edited('加入商品');renderProperties();
  return product;
}
$('#product-list').addEventListener('click',async e=>{
  const button=e.target.closest('[data-add]');
  if(button){await addIndexedProduct(button.dataset.add);return;}
  const editButton=e.target.closest('[data-edit-index]');if(!editButton)return;
  const product=await provider.get(editButton.dataset.editIndex);if(!product)return;
  $('#index-id').value=product.id;$('#index-name').value=product.name;$('#index-sku').value=product.sku;
  $('#index-aliases').value=(product.aliases||[]).join('\n');$('#index-filename').textContent=`原始檔名：${product.filename||product.name}`;
  $('#index-dialog').showModal();
});
$('#close-index').addEventListener('click',()=>$('#index-dialog').close());
$('#index-form').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    await provider.updateMetadata($('#index-id').value,{name:$('#index-name').value,sku:$('#index-sku').value,aliases:$('#index-aliases').value.split(/\n|,|，|;/)});
    // Existing poster nodes are snapshots, so updating the library does not
    // silently rename an approved poster or change its rendered appearance.
    $('#index-dialog').close();$('#lookup-results').innerHTML='';queueSave();renderLibrary();toast('商品圖片索引已更新，可用名稱、SKU 或別名配圖');
  }catch(error){toast(error.message);}
});
async function lookupProduct() {
  const result=await provider.resolve($('#lookup-name').value);
  if(result.status==='empty'){$('#lookup-results').innerHTML='<p class="hint">請先輸入商品名稱、SKU 或別名。</p>';return;}
  if(result.status==='matched'){
    const product=await addIndexedProduct(result.product.id);
    if(product){$('#lookup-results').innerHTML=`<div class="check ok">✓ 已關聯 ${esc(product.name)} 並加入畫布</div>`;toast('商品圖片已自動關聯');}
    return;
  }
  if(result.status==='missing'){$('#lookup-results').innerHTML='<div class="check">未找到商品圖片。請先上傳圖片，再透過「編輯索引」補充商品名稱或別名。</div>';return;}
  $('#lookup-results').innerHTML=`<p class="hint">找到 ${result.matches.length} 張候選圖片，請選擇正確的商品及角度：</p>`+result.matches.map(match=>`<button class="match-card" data-match="${esc(match.product.id)}"><img src="${esc(match.product.imageUrl)}" alt="${esc(match.product.name)}"><span><strong>${esc(match.product.name)}</strong><small>${esc(match.product.filename||match.product.name)}</small><small>${match.matchedBy} · ${match.exact?'完整匹配':'部分匹配'}</small></span></button>`).join('');
}
$('#lookup').addEventListener('click',lookupProduct);
$('#lookup-name').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();lookupProduct();}});
$('#lookup-name').addEventListener('input',()=>$('#lookup-results').innerHTML='');
$('#lookup-results').addEventListener('click',async e=>{
  const button=e.target.closest('[data-match]');if(!button)return;
  const product=await addIndexedProduct(button.dataset.match);
  if(product)$('#lookup-results').innerHTML=`<div class="check ok">✓ 已選擇 ${esc(product.name)} 並加入畫布</div>`;
});
$('#text-results').addEventListener('click',e=>{
  const button=e.target.closest('[data-locate]');if(!button)return;
  select(button.dataset.locate,button.dataset.field);canvas.scrollIntoView({behavior:'smooth',block:'center'});canvas.classList.remove('focused');requestAnimationFrame(()=>canvas.classList.add('focused'));
  const field=$(`[data-prop="${button.dataset.field}"]`);field?.focus({preventScroll:true});
});
for (const [id,key] of [['campaign-name','name'],['start-date','start'],['end-date','end'],['stores','stores']]) $('#'+id).addEventListener('input',e=>{project.campaign[key]=e.target.value;edited('活動資料修改');});
$('#properties').addEventListener('input',e=>{
  const key=e.target.dataset.prop,n=project.nodes.find(n=>n.id===selected);if(!key||!n)return;
  let value=e.target.type==='checkbox'?e.target.checked:e.target.value;
  if(n.locked&&['x','y','w','h'].includes(key))return;
  const bounds={x:[0,WIDTH-n.w],y:[0,HEIGHT-n.h],w:[60,WIDTH],h:[60,HEIGHT],fontSize:[1,1000],priceFontSize:[1,1000],shadow:[0,30],quantity:[1,99]};
  if(bounds[key]) { if(value==='')return;value=Number(value);if(!Number.isFinite(value))return;value=Math.min(bounds[key][1],Math.max(bounds[key][0],value));if(key==='quantity')value=Math.round(value); }
  if(key==='cardStyle'){try{applyProductLayout(n,canvasMeasure(ctx),value);edited('切換商品排版並重新對齊');renderProperties();}catch(error){e.target.value=n.cardStyle||'classic';toast(error.message);}return;}
  const previous=structuredClone(n);
  n[key]=value;if(key==='price2'&&value&&!n.price2ProductId){n.price2ProductId=n.pictures?.find(p=>p.productId!==n.productId)?.productId;}if(n.pdfOcr&&['name','spec','price','quantity','price2','originalPrice2','originalPrice','originalPriceMax'].includes(key)){n.pdfReview=false;const review=$('#properties [data-prop="pdfReview"]');if(review)review.checked=false;}if(key==='priceFontSize')setFontSize(n,'price',value);if(key==='fontSize')setFontSize(n,'text',value);n.x=Math.max(0,Math.min(n.x,WIDTH-n.w));n.y=Math.max(0,Math.min(n.y,HEIGHT-n.h));
  if(n.type==='product'&&!n.imageOnly&&['name','spec','price2','originalPrice2','originalPrice','originalPriceMax','price','quantity','priceFontSize','w','h'].includes(key)){try{applyProductLayout(n,canvasMeasure(ctx));}catch(error){Object.keys(n).forEach(k=>delete n[k]);Object.assign(n,previous);e.target.value=previous[key]??'';toast(error.message);return;}}
  focusField=null;edited('元素資料修改');if(key==='imageOnly'){activeRegion='image';editingRegion=false;renderProperties();draw();}syncFontStatus(n);if(['cardStyle','averageRounding','quantity','price','price2','originalPrice2','originalPrice','originalPriceMax'].includes(key)){const label=$('#offer-preview');if(label)label.textContent=`展示：${n.cardStyle==='retail'?('$'+offer(n).main+(offer(n).bundle?' · '+offer(n).bundle:'')):priceLabel(n)}`;}
});
$('#properties').addEventListener('change',e=>{
  const n=project.nodes.find(n=>n.id===selected),key=e.target.dataset.prop,layout=e.target.dataset.textLayout;
  const tagKey=e.target.dataset.priceTag;
  if(n?.priceTag&&tagKey&&!n.locked){const tag={...n.priceTag,[tagKey]:tagKey==='quantity'?Number(e.target.value):String(e.target.value).replace(/^[$＄]\s*/,'')};if(!validPriceTag(tag)){e.target.value=n.priceTag[tagKey];return toast('總價請填正數金額（最多兩位小數），件數 1–99');}n.priceTag=tag;n.text=priceTagLabel(tag);edited('價格牌修改');renderProperties();return;}
  if(n&&layout&&!n.locked){n.textLayout={...n.textLayout,[layout]:layout==='weight'?Number(e.target.value):e.target.value};edited('文字樣式修改');return;}
  if(n && key && e.target.type==='number') e.target.value=n[key];
});
$('#properties').addEventListener('click',e=>{
  const action=e.target.closest('[data-action]')?.dataset.action,index=project.nodes.findIndex(n=>n.id===selected);if(!['front','back','delete','duplicate'].includes(action)||index<0)return;
  const n=project.nodes[index];
  if(action==='front'){project.nodes.splice(index,1);project.nodes.push(n);}
  if(action==='back'){project.nodes.splice(index,1);project.nodes.unshift(n);}
  if(action==='delete'){deleteNodes([selected]);return;}
  if(action==='duplicate'){if(project.nodes.length>=100)return toast('最多支援 100 個元素');const copy={...structuredClone(n),id:uid(),x:Math.min(n.x+20,WIDTH-n.w),y:Math.min(n.y+20,HEIGHT-n.h)};project.nodes.push(copy);selected=copy.id;}
  edited('圖層修改');renderProperties();
});
$('#deselect').addEventListener('click',()=>select(null));
$('#auto-layout').addEventListener('click',async ()=>{
 const owner=project;
 await measureAssets(owner,owner.nodes.filter(n=>n.type==='product').flatMap(n=>pictures(n).map(p=>p.productId)));
 if(project!==owner)return;
 if(retailPageErrors(project).length)return toast(retailPageErrors(project)[0]);
 finishDrag();fabricEditor?.stopDragging();arrangeAllProducts();edited('自動排列商品');renderProperties();
 toast('已按圖片比例及海報空間調整商品排列與大小，請確認價格與文字');
});
function addText(icon=false) {
  if(project.nodes.length>=100)return toast('最多支援 100 個元素');
  const n={id:uid(),type:icon?'icon':'text',text:icon?'新品':'輸入宣傳文字',x:60,y:180,w:icon?120:350,h:icon?70:100,fontSize:icon?32:30,color:'#e52731',shadow:0};
  project.nodes.push(n);selected=n.id;edited('新增文字');renderProperties();
}
$('#add-text').addEventListener('click',()=>addText());$('#add-icon').addEventListener('click',()=>{renderIcons();$('#icon-dialog').showModal();});
$('#close-icons').addEventListener('click',()=>$('#icon-dialog').close());
$('#add-text-icon').addEventListener('click',()=>{addText(true);$('#icon-dialog').close();});
function renderIcons(){
 $('#icon-library').innerHTML=(project.icons||[]).map(a=>`<button data-icon-id="${esc(a.id)}" class="icon-asset"><img src="${esc(a.imageUrl)}" alt="${esc(a.name)}"><span>${esc(a.name)}</span><small>加入海報</small></button>`).join('')||'<p class="hint">尚未上傳標識，請上傳國旗、品牌 Logo、促銷貼紙或其他標識圖片。</p>';
}
function placeIcon(asset){
 if(project.nodes.length>=100)throw new Error('最多支援 100 個元素');
 const n=iconNode(asset,project);project.nodes.push(n);selected=n.id;selectedPicture=null;pictureSelectionExplicit=false;
 edited('加入圖片標識');renderProperties();
}
$('#icon-library').addEventListener('click',e=>{
 const id=e.target.closest('[data-icon-id]')?.dataset.iconId;if(!id)return;
 try{placeIcon(project.icons.find(a=>a.id===id));$('#icon-dialog').close();}catch(error){toast(error.message);}
});
$('#icon-upload').addEventListener('change',async e=>{
 const owner=project;let count=0;e.target.disabled=true;
 try{for(const file of e.target.files){
  if((owner.icons||[]).length>=50)throw new Error('最多儲存 50 張標識素材');
  if(owner.nodes.length>=100)throw new Error('最多支援 100 個元素');
  const imageUrl=await readImage(file),image=getImage(imageUrl);await image.decode();if(project!==owner)return;
  const asset={id:uid(),name:file.name.replace(/\.[^.]+$/,'').slice(0,200),imageUrl,width:image.naturalWidth,height:image.naturalHeight};
  (owner.icons||=[]).push(asset);placeIcon(asset);count++;
 }
 }catch(error){toast(error.message);}
 finally{e.target.disabled=false;e.target.value='';if(project===owner){renderIcons();if(count){$('#icon-dialog').close();toast(`已上傳並加入 ${count} 張標識，可拖曳調整位置`);}}}
});
document.querySelectorAll('[data-template]').forEach(b=>b.addEventListener('click',()=>selectBackground(b.dataset.template)));
$('#background-upload').addEventListener('change',async e=>{
 const file=e.target.files[0];if(!file)return;const owner=project;e.target.disabled=true;
 try{
  const inputFile=(file.type==='application/pdf'||/\.pdf$/i.test(file.name))?await importPdfPage(file,message=>{$('#pdf-upload-status').textContent=message;}):file;if(!inputFile)return;
  const imageUrl=await readImage(inputFile),image=new Image();image.src=imageUrl;await image.decode();
  if(project!==owner)throw new Error('目前項目已切換，請重新上傳');
  if(creatingProject)throw new Error('正在建立項目，請稍候');
  const next=newProjectFromPoster(owner,{id:uid(),name:inputFile.name,imageUrl},{width:image.naturalWidth,height:image.naturalHeight});
  sizeInfo(next);
  if(inputFile.reconstruction)applyPdfReconstruction(next,inputFile.reconstruction);
  // 保存原始 PDF（本機），「全自動換商品」選這張底圖時直接沿用原檔與頁碼，不必再上傳。
  if(inputFile.source)await savePosterPdf(next.backgroundId,{name:inputFile.source.name,page:inputFile.page,blob:inputFile.source},next.backgrounds.map(b=>b.id)).catch(error=>toast(`原始 PDF 未能保存：${error.message}`));
  creatingProject=true;
  try{await saveAndOpenNewProject(next,owner,owner.revision);}finally{creatingProject=false;}
  toast('已保存原項目並建立新活動，請先填寫活動名稱、日期及門店，再點「下一步：加商品」。');
 }catch(error){toast(error.message);}finally{e.target.value='';e.target.disabled=false;$('#pdf-upload-status').textContent='';}
});

function coordinates(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*WIDTH/r.width,y:(e.clientY-r.top)*HEIGHT/r.height};}
canvas.addEventListener('pointerdown',e=>{
  if(fabricEditor||e.button!==0||!e.isPrimary)return;
  finishDrag();
  if(backgroundEditing){const image=getImage(project.template==='custom'?project.background:templatePaths[project.template]);if(!image?.naturalWidth)return;const point=coordinates(e),box=backgroundBox(project,image.naturalWidth,image.naturalHeight);const resize=Math.abs(point.x-box.x-box.w)<24&&Math.abs(point.y-box.y-box.h)<24;if(!resize&&!backgroundMoving)return;drag={background:true,pointerId:e.pointerId,start:point,original:box,resize};canvas.setPointerCapture(e.pointerId);e.preventDefault();return;}
  const p=coordinates(e),n=[...project.nodes].reverse().find(n=>p.x>=n.x-6&&p.x<=n.x+n.w+6&&p.y>=n.y-6&&p.y<=n.y+n.h+6);
  if(n?.type==='product'){
   const key=editingRegion&&n.id===selected?activeRegion:['price','name','spec','original'].find(key=>{const b=region(n,key);return p.x>=n.x+b.x&&p.x<=n.x+b.x+b.w&&p.y>=n.y+b.y&&p.y<=n.y+b.y+b.h;});
   if(key){const b=region(n,key);if(p.x>=n.x+b.x&&p.x<=n.x+b.x+b.w&&p.y>=n.y+b.y&&p.y<=n.y+b.y+b.h){selectRegion(n.id,key);if(n.locked)return;canvas.setPointerCapture(e.pointerId);drag={id:n.id,region:key,pointerId:e.pointerId,start:p,original:b,resize:Math.abs(p.x-(n.x+b.x+b.w))<18&&Math.abs(p.y-(n.y+b.y+b.h))<18,moved:false};return;}}
  }
  select(n?.id??null);if(!n||n.locked)return;const hit=pictureAt(n,p,project.products);if(hit){selectPicture(n.id,hit);draw();}canvas.setPointerCapture(e.pointerId);
  drag={id:n.id,pointerId:e.pointerId,start:p,original:{x:n.x,y:n.y,w:n.w,h:n.h},resize:Math.abs(p.x-(n.x+n.w))<18&&Math.abs(p.y-(n.y+n.h))<18,moved:false};
});
canvas.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.pointerId)return;
  if(e.pointerType==='mouse'&&(e.buttons&1)===0){finishDrag();return;}
  if(drag.background){const p=coordinates(e),box=drag.original;if(drag.resize){const w=Math.max(30,Math.min(WIDTH*5,box.w+p.x-drag.start.x));project.backgroundPlacement={...box,w,h:w*box.h/box.w};}else project.backgroundPlacement={...box,x:box.x+p.x-drag.start.x,y:box.y+p.y-drag.start.y};drag.moved=true;draw();return;}
  const p=coordinates(e),n=project.nodes.find(n=>n.id===drag.id);if(!n)return;
  const dx=p.x-drag.start.x,dy=p.y-drag.start.y;if(Math.abs(dx)+Math.abs(dy)<2&&!drag.moved)return;
  drag.moved=true;
  if(drag.region){const b=drag.original;setRegionBox(n,drag.region,{x:b.x+(drag.resize?0:dx),y:b.y+(drag.resize?0:dy),w:b.w+(drag.resize?dx:0),h:b.h+(drag.resize?dy:0)});draw();return;}
  if(drag.resize){const ratio=drag.original.h/drag.original.w;n.w=Math.min(WIDTH-n.x,(HEIGHT-n.y)/ratio,Math.max(1,drag.original.w+dx));n.h=n.w*ratio;}
  else{n.x=Math.max(0,Math.min(WIDTH-n.w,drag.original.x+dx));n.y=Math.max(0,Math.min(HEIGHT-n.h,drag.original.y+dy));}
  if(!drag.resize&&$('#snap-enabled').checked){const snapped=snapPosition(n,project.nodes,WIDTH,HEIGHT);n.x=snapped.x;n.y=snapped.y;}
  draw();
});
function finishDrag(){const previous=drag;drag=null;if(previous&&canvas.hasPointerCapture(previous.pointerId))canvas.releasePointerCapture(previous.pointerId);if(previous?.moved){edited('位置或尺寸修改');renderProperties();}}
window.addEventListener('pointerup',finishDrag);window.addEventListener('pointercancel',finishDrag);window.addEventListener('blur',finishDrag);document.addEventListener('visibilitychange',()=>{if(document.hidden)finishDrag();});
canvas.addEventListener('pointerup',finishDrag);canvas.addEventListener('pointercancel',finishDrag);canvas.addEventListener('lostpointercapture',finishDrag);
$('#run-checks').addEventListener('click',()=>{renderChecks();toast('基礎資料檢查已更新，未連接門店價格');});
for (const [id,action] of [['submit','submit'],['approve','approve'],['return-draft','return']]) $('#'+id).addEventListener('click',()=>{
  try{transition(project,action);invalidatePreview();queueSave();renderStatus();renderChecks();toast(action==='approve'?'已記錄校對狀態，請確認門店價格':'流程狀態已更新');}catch(error){renderChecks();toast(error.message);}
});
function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
const filename = () => project.campaign.name.replace(/[\\/:*?"<>|]/g,'_').slice(0,60)||'poster';
$('#export').addEventListener('click',()=>goStep(3));
$('#generate-poster').addEventListener('click',async()=>{
  if(generating)return;
  const blocked=firstIncomplete(project,3);if(blocked){goStep(blocked.step);toast(blocked.issues[0]);return;}
  const ownerProject=project, snapshot=structuredClone(project);generating=true;$('#generate-poster').disabled=true;
  invalidatePreview();$('#output-status').textContent='正在載入圖片並生成海報…';
  try{
    const collisions=snapshot.nodes.filter(n=>n.type==='product'&&overlappingText(n,canvasMeasure(ctx)).length);if(collisions.length)throw new Error('商品文字有重疊，請先重新整理文字間距');
    const required=snapshot.nodes.filter(n=>n.type==='product').flatMap(n=>pictures(n).map(pic=>getImage(snapshot.products.find(p=>p.id===pic.productId)?.imageUrl)));
    for(const n of snapshot.nodes.filter(n=>n.type==='imageIcon'))required.push(getImage((snapshot.icons||[]).find(a=>a.id===n.iconId)?.imageUrl));
    if(snapshot.template==='retail')for(const item of cleanTemplateElements(snapshot).filter(i=>i.type==='image'))required.push(getImage(item.src));
    const bg=snapshot.template==='custom'?snapshot.background:templatePaths[snapshot.template];if(bg)required.push(getImage(bg));
    await Promise.all(required.filter(Boolean).map(image=>image.decode()));await document.fonts.ready;renderChecks();
    const output=document.createElement('canvas');const dimensions=sizeInfo(snapshot);output.width=dimensions.width;output.height=dimensions.height;const context=output.getContext('2d');context.scale(dimensions.scale,dimensions.scale);if(!fabricEditor)draw(context,true,snapshot);
    const rendered=fabricEditor?await fabricEditor.renderBlob(snapshot):await new Promise(resolve=>output.toBlob(resolve,'image/png'));if(!rendered)throw new Error('圖片匯出失敗');
    const blob=await withDpi(rendered,dimensions.dpi);
    if(project!==ownerProject||project.revision!==snapshot.revision||project.status!==snapshot.status)throw new Error('生成期間內容已變更，請重新校對及生成');
    const safeName=snapshot.campaign.name.replace(/[\\/:*?"<>|]/g,'_').slice(0,60)||'poster';
    generatedPoster={snapshot,blob,url:URL.createObjectURL(blob),revision:snapshot.revision,name:`${safeName}-V${snapshot.revision}.png`};renderWorkflowReview();
    $('#final-image').src=generatedPoster.url;$('#final-image').hidden=false;$('#preview-placeholder').hidden=true;$('#download-poster').disabled=true;$('#download-pdf').disabled=true;renderSteps();
    $('#output-status').textContent=`版本 ${snapshot.revision} 已生成。下載的檔案與此預覽完全相同。`;
  }catch(error){toast(error.message);$('#output-status').textContent=`生成失敗：${error.message}`;}
  finally{generating=false;$('#generate-poster').disabled=false;}
});
$('#download-poster').addEventListener('click',()=>{
  if(!generatedPoster||generatedPoster.revision!==project.revision||confirmedArchive?.revision!==project.revision||firstIncomplete(project,4)){invalidatePreview();toast('請重新校對並生成海報');return;}
  download(generatedPoster.blob,generatedPoster.name);
});
let archiveListTicket=0;
async function renderArchiveList(reset=false){
  const ticket=++archiveListTicket;
  if(reset){archiveOffset=0;$('#archive-list').innerHTML='';}
  $('#more-archives').disabled=true;
  try{
    const rows=await listArchives(archiveOffset);if(ticket!==archiveListTicket)return;archiveOffset+=rows.length;
    if(!archiveOffset)$('#archive-list').textContent='尚無伺服器存檔';
    $('#archive-list').insertAdjacentHTML('beforeend',rows.map(row=>`<button data-archive="${esc(row.id)}"><strong>${esc(row.name)} · #${row.sequence} · V${row.revision}</strong><span>${row.confirmed_by?'已確認 · '+esc(row.confirmed_by):'草稿'} · ${esc(new Date(row.created_at).toLocaleString('zh-HK'))}</span></button>`).join(''));
    $('#more-archives').hidden=rows.length<50;
  }catch(error){if(ticket!==archiveListTicket)return;toast(error.message);if(reset)$('#archive-list').textContent='無法讀取伺服器存檔，請確認後端服務。';}
  finally{if(ticket===archiveListTicket)$('#more-archives').disabled=false;}
}
$('#open-archives').addEventListener('click',()=>{++archiveViewTicket;viewedArchive=null;$('#archive-dialog').showModal();$('#archive-detail').hidden=true;renderArchiveList(true);});
$('#close-archives').addEventListener('click',()=>$('#archive-dialog').close());
$('#more-archives').addEventListener('click',()=>renderArchiveList());
let archiveViewTicket=0,restoringArchive=false;
$('#archive-list').addEventListener('click',async e=>{
  const button=e.target.closest('[data-archive]');if(!button||deletingCampaign||restoringArchive)return;
  const ticket=++archiveViewTicket;viewedArchive=null;$('#archive-detail').hidden=true;$('#archive-load-status').textContent='正在讀取版本資料…';
  try{
    const result=await getArchiveDetails(button.dataset.archive);if(ticket!==archiveViewTicket)return;viewedArchive=result;$('#archive-load-status').textContent='';
    const v=result.version,c=result.project.campaign;
    $('#archive-detail').hidden=false;$('#archive-detail-title').textContent=`${c.name} · 存檔 #${v.sequence} · V${v.revision}`;
    $('#archive-detail-info').textContent=`${c.start||'未填日期'} — ${c.end||'未填日期'} · ${c.stores||'未填門店'} · ${v.confirmed_by?(result.project.savedBy?'確認帳號：':'歷史確認人（未驗證身份）：')+v.confirmed_by:'未確認草稿'} · ${new Date(v.created_at).toLocaleString('zh-HK')} · SHA-256：${v.digest}`;
    $('#archive-poster').hidden=!v.poster_hash;$('#archive-png').hidden=!v.poster_hash;
    if(v.poster_hash)$('#archive-poster').src=`/api/archives/${encodeURIComponent(v.id)}/poster`;else $('#archive-poster').removeAttribute('src');
    $('#archive-detail').scrollIntoView({block:'nearest'});
  }catch(error){if(ticket===archiveViewTicket){$('#archive-load-status').textContent='版本讀取失敗：'+error.message;toast(error.message);}}
});
$('#archive-json').addEventListener('click',async()=>{
 if(!viewedArchive)return;const id=viewedArchive.version.id;$('#archive-json').disabled=true;$('#archive-load-status').textContent='正在下載完整資料及圖片…';
 try{const full=await getArchive(id);download(new Blob([JSON.stringify(full.project)],{type:'application/json'}),`archive-${id}.json`);$('#archive-load-status').textContent='備份已下載';}
 catch(error){$('#archive-load-status').textContent='備份下載失敗：'+error.message;}
 finally{$('#archive-json').disabled=false;}
});
$('#archive-png').addEventListener('click',async()=>{
  if(!viewedArchive)return;const version=viewedArchive.version;
  try{const response=await fetch(`/api/archives/${encodeURIComponent(version.id)}/poster`);if(!response.ok)throw new Error('讀取海報失敗');download(await response.blob(),`poster-${version.id}.png`);}catch(error){toast(error.message);}
});
$('#archive-restore').addEventListener('click',async()=>{
  if(!viewedArchive||restoringArchive||deletingCampaign||!confirm('將開啟此活動繼續編輯；目前草稿會先保存，之後自動更新該活動的最新存檔。'))return;
  restoringArchive=true;$('#archive-restore').disabled=true;
  $('#archive-load-status').textContent='正在保存目前草稿…';
  try{
    const source=viewedArchive,owner=project,revision=project.revision;
    await waitForArchive(archiveVersion(project));if(project!==owner||project.revision!==revision)throw new Error('目前草稿已變更，請重試');
    $('#archive-load-status').textContent='正在讀取此版本的完整圖片…';
    const full=await getArchive(source.version.id);
    if(project!==owner||project.revision!==revision)throw new Error('目前草稿已變更，請重試');
    const restored=parseBackup(JSON.stringify(full.project));
    restored.archiveCampaignId=source.version.campaign_id;restored.parentArchiveId=source.version.id;
    invalidatePreview();project=restored;selected=null;selectedPicture=null;images.clear();refresh();queueSave();$('#archive-dialog').close();toast('已開啟活動，修改後自動更新存檔，需重新確認');
  }catch(error){$('#archive-load-status').textContent='開啟失敗：'+error.message;toast(error.message);}
  finally{restoringArchive=false;$('#archive-restore').disabled=false;}
});
$('#backup').addEventListener('click',()=>download(new Blob([JSON.stringify(project)],{type:'application/json'}),`${filename()}-V${project.revision}.json`));
$('#restore').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file)return;
  try{
    if(file.size>150*1024*1024)throw new Error('備份不可超過 150 MB');
    const restored=parseBackup(await file.text());
    if(!window.confirm('匯入將取代目前專案。請確認已匯出目前專案備份。'))return;
    invalidatePreview();project=restored;selected=null;selectedPicture=null;images.clear();refresh();queueSave();toast('專案已匯入，流程狀態重設為草稿');
  }catch(error){toast(`匯入失敗：${error.message}`);}finally{e.target.value='';}
});

$('#apply-size').addEventListener('click',()=>{
 try{applyCanvasSize({width:Number($('#page-width').value),height:Number($('#page-height').value),unit:$('#page-unit').value,dpi:Number($('#page-dpi').value)});toast('整張海報尺寸已套用');}catch(error){toast(error.message);}
});
$('#page-preset').addEventListener('change',e=>{
 const presets={legacy:[1800,2560,'px',150],a4:[210,297,'mm',300],a3:[297,420,'mm',300],shop:[435,620,'mm',300],square:[1080,1080,'px',150],story:[1080,1920,'px',150],wide:[1920,1080,'px',150]};
 const p=presets[e.target.value];if(!p)return;['width','height','unit','dpi'].forEach((k,i)=>$('#page-'+k).value=p[i]);
});
function syncPageInputs(){
 const page=project.page||{width:1800,height:2560,unit:'px',dpi:150};
 for(const prefix of ['page-','edit-page-'])for(const key of ['width','height','unit','dpi'])$('#'+prefix+key).value=page[key];
}
function applyCanvasSize(page){
 finishDrag();fabricEditor?.stopDragging();resizeProject(project,page);delete project.backgroundPlacement;project.backgroundFit='contain';
 backgroundEditing=false;selected=null;syncPageInputs();edited('海報畫布尺寸修改（保留商品與文字）');renderProperties();
}
$('#edit-background').addEventListener('click',()=>{
 finishDrag();fabricEditor?.stopDragging();pageEditing=!pageEditing;backgroundEditing=false;backgroundMoving=false;selected=null;
 syncPageInputs();renderSteps();draw();
 if(pageEditing)$('#background-tools').scrollIntoView({block:'nearest',behavior:'smooth'});
});
$('#apply-canvas-size').addEventListener('click',()=>{
 try{applyCanvasSize({width:Number($('#edit-page-width').value),height:Number($('#edit-page-height').value),unit:$('#edit-page-unit').value,dpi:Number($('#edit-page-dpi').value)});toast(validate(project).errors.some(e=>e.includes('超出畫布'))?'画布已调整，部分内容超出边界，请手动调整或点击自动排列':'画布已调整，商品与文字位置和大小保持不变');}catch(error){toast(error.message);}
});
$('#fit-page-background').addEventListener('click',async()=>{
 const owner=project,src=project.template==='custom'?project.background:templatePaths[project.template];
 if(!src)return toast('此版式沒有圖片底圖，請直接填寫海報寬高');
 try{const image=getImage(src);await image.decode();if(project!==owner)return;const size=sizeInfo(project);applyCanvasSize({width:size.width,height:Math.round(size.width*image.naturalHeight/image.naturalWidth),unit:'px',dpi:size.dpi});toast('黃色畫布已改為底圖比例，底圖完整貼合畫布');}catch(error){toast(error.message);}
});
let pageDrag=null;
$('#resize-page').addEventListener('pointerdown',e=>{
 if(e.button!==0||!e.isPrimary)return;e.preventDefault();finishDrag();
 pageDrag={pointerId:e.pointerId,x:e.clientX,y:e.clientY,rect:canvas.getBoundingClientRect(),size:sizeInfo(project),owner:project,zoom:Number($('#poster-zoom').value),page:null};
 e.currentTarget.setPointerCapture(e.pointerId);
});
$('#resize-page').addEventListener('pointermove',e=>{
 if(!pageDrag||e.pointerId!==pageDrag.pointerId)return;
 if(e.pointerType==='mouse'&&!(e.buttons&1)){finishPageResize();return;}
 const d=pageDrag,dx=e.clientX-d.x,dy=e.clientY-d.y;
 let sx=Math.max(.1,(d.rect.width+dx)/d.rect.width),sy=Math.max(.1,(d.rect.height+dy)/d.rect.height);
 if($('#lock-page-ratio').checked)sx=sy=Math.max(.1,1+(dx*d.rect.width+dy*d.rect.height)/(d.rect.width**2+d.rect.height**2));
 const page={width:Math.round(d.size.width*sx),height:Math.round(d.size.height*sy),unit:'px',dpi:d.size.dpi};
 try{sizeInfo({page});d.page=page;$('#resize-size').textContent=`${page.width} × ${page.height} px`;$('#resize-size').hidden=false;const outline=$('#resize-outline');outline.hidden=false;outline.style.width=`${d.rect.width*sx}px`;outline.style.height=`${d.rect.height*sy}px`;}catch(error){d.page=null;$('#resize-size').hidden=false;$('#resize-size').textContent=error.message;}
});
function finishPageResize(cancel=false){
 const d=pageDrag;pageDrag=null;if(!d)return;
 if($('#resize-page').hasPointerCapture(d.pointerId))$('#resize-page').releasePointerCapture(d.pointerId);
 $('#resize-outline').hidden=true;$('#resize-size').hidden=true;
 if(!cancel&&d.page&&project===d.owner){try{applyCanvasSize(d.page);}catch(error){toast(error.message);}}
}
$('#resize-page').addEventListener('pointerup',()=>finishPageResize());
$('#resize-page').addEventListener('pointercancel',()=>finishPageResize(true));
$('#resize-page').addEventListener('lostpointercapture',()=>finishPageResize(true));
window.addEventListener('blur',()=>finishPageResize(true));
function setPosterZoom(){
 finishDrag();const scale=Number($('#poster-zoom').value)/100;$('#poster-zoom-value').textContent=`${Math.round(scale*100)}%`;
 if(fabricEditor)fabricEditor.setDisplayScale(scale);
 else{const view=displaySize(project,scale);canvas.style.width=`${view.width}px`;canvas.style.height=`${view.height}px`;canvas.style.maxWidth='none';canvas.style.flexShrink='0';}
}
$('#show-grid').addEventListener('change',e=>{$('#poster-grid').hidden=!e.target.checked;});
$('#grid-density').addEventListener('change',e=>{$('#poster-grid').style.setProperty('--grid-count',e.target.value);});
$('#poster-zoom').addEventListener('input',setPosterZoom);
$('#poster-zoom-reset').addEventListener('click',()=>{$('#poster-zoom').value=100;setPosterZoom();});



function selectInput(label,key,value,options){return `<label>${label}<select data-prop="${key}">${options.map(([v,t])=>`<option value="${v}" ${v===value?'selected':''}>${t}</option>`).join('')}</select></label>`;}
function retailProperties(n){
 const names={image:'商品圖片',name:'商品名稱',spec:'規格',original:'原價',price:'促銷價格'};
 let html=`<label class="edit-content-picker">編輯內容<select id="retail-region">${Object.entries(names).map(([key,label])=>`<option value="${key}" ${activeRegion===key?'selected':''}>${label}</option>`).join('')}</select></label><section class="property-page" aria-label="${names[activeRegion]}參數"><h3>${names[activeRegion]}</h3>`;
 if(activeRegion==='name')html+=`<label>商品名稱（可換行）<textarea data-prop="name" maxlength="100" rows="3">${esc(n.name)}</textarea></label>`+input('商品編號 / SKU','sku',n.sku,'text','maxlength="80"');
 if(activeRegion==='spec')html+=input('包裝規格（例如：85g × 5包）','spec',n.spec,'text','maxlength="100"');
 if(activeRegion==='original'){
  html+=`<div class="property-grid">${input('原價（選填）','originalPrice',n.originalPrice||'','text','inputmode="decimal"')}${n.price2?'':input('原價上限（選填）','originalPriceMax',n.originalPriceMax||'','text','inputmode="decimal"')}</div><label><input data-prop="originalStrike" type="checkbox" ${n.originalStrike?'checked':''}>原價加刪除線</label><p class="hint">單一原價只填左邊；不同款式原價有範圍時再填上限。不展示原價則留空。</p>`;
 }
 if(activeRegion==='original'&&n.price2)html+=input('第二件原價（選填）','originalPrice2',n.originalPrice2||'','text','inputmode="decimal"');
 if(activeRegion==='price'){
  html+=`<div class="property-grid">${input(n.price2?'第一件售價（HK$）':'優惠總價（HK$）','price',n.price,'text','inputmode="decimal" placeholder="例如 33" maxlength="12"')}${input('優惠件數','quantity',n.quantity,'number','min="1" max="99" step="1"')}</div>`;
  if(n.pictures?.length===2)html+=input(`第二件獨立售價（${esc(n.groupCodes?.[1]||'第二張商品圖')}，選填）`,'price2',n.price2||'','text','inputmode="decimal"')+'<p class="hint">留空為共用優惠；填寫後兩件各自售價，優惠件數須為 1。海報合併展示兩個價格。</p>';
  html+=selectInput('平均每件價格取整','averageRounding',n.averageRounding||'tenth',[['integer','四捨五入到整元'],['tenth','四捨五入到一位小數'],['cent','四捨五入到兩位小數']]);
  html+=`<p id="offer-preview" class="hint">展示：${esc(n.cardStyle==='retail'?('$'+offer(n).main+(offer(n).bundle?' · '+offer(n).bundle:'')):priceLabel(n))}</p>`;
 }
 html+='<details open id="retail-regions" class="advanced-settings"><summary>位置與樣式</summary><p class="hint">可拖動藍色選框及縮放手柄。關閉自動縮字後按指定字號顯示，請加大區域避免重疊。</p><div class="property-grid">';
 const actual=region(n,activeRegion),box={x:actual.x/n.w,y:actual.y/n.h,w:actual.w/n.w,h:actual.h/n.h};
 for(const [key,label] of [['x','水平位置 %'],['y','垂直位置 %'],['w','寬度 %'],['h','高度 %']])html+=`<label>${label}<input type="number" data-region="${key}" value="${Math.round(box[key]*1000)/10}" min="${['w','h'].includes(key)?1:0}" max="100" step="0.5"></label>`;
 html+='</div><button data-action="reset-region">還原此區域</button>';
 if(activeRegion==='price'){
  html+=`<div class="property-grid">${input('字號','priceFontSize',n.priceFontSize??(n.cardStyle==='retail'?Math.round(region(n,'price').h*.65):productMetrics(n.h,n.fontSize).priceSize),'number','min="1" max="1000"')}${input('顏色','color',n.color,'color')}</div><label><input data-prop="priceAutoFit" type="checkbox" ${n.priceAutoFit!==false?'checked':''}>自動縮字以符合區域</label>`;
 }
 if(['name','spec','original'].includes(activeRegion)){
  const style=n.textStyles?.[activeRegion]||{};
  html+=`<div class="property-grid"><label>字號<input data-text-style="size" type="number" min="1" max="1000" value="${Math.round(requestedFontSize(n,activeRegion)*100)/100}"></label><label>顏色<input data-text-style="color" type="color" value="${esc(style.color||(activeRegion==='spec'?'#737769':'#343434'))}"></label><label>行距<input data-text-style="lineHeight" type="number" min="1" max="2" step="0.05" value="${esc(style.lineHeight||1.15)}"></label><label>對齊<select data-text-style="align">${['left','center','right'].map((key,i)=>`<option value="${key}" ${(style.align||'left')===key?'selected':''}>${['左','中','右'][i]}</option>`).join('')}</select></label><label>字體<select data-text-style="font">${[['sans','黑體'],['serif','宋體'],['price','數字體'],['poster','海報（英數 Arial）']].map(([key,label])=>`<option value="${key}" ${(style.font||'sans')===key?'selected':''}>${label}</option>`).join('')}</select></label><label><input data-text-style="bold" type="checkbox" ${style.bold?'checked':''}>粗體</label></div><label><input data-text-style="autoFit" type="checkbox" ${style.autoFit!==false?'checked':''}>自動縮字以符合區域</label>`;
 }
 if(activeRegion!=='image')html+='<p id="font-status" class="hint" role="status"></p>';
 html+='</details></section><details class="advanced-settings"><summary>整組排版與角標</summary>';
 html+=selectInput('商品排版','cardStyle',n.cardStyle||'classic',[['classic','經典上下排列'],['retail','至優價 · 文案左／價格右']]);
 html+=selectInput('促銷角標','badge',n.badge||'',[['','無'],['新','新'],['熱賣','熱賣'],['精選','精選']]);
 html+='<div class="property-buttons"><button data-edit-region="group">移動整組</button><button data-align-product-text>名稱／規格／價格對齊</button><button data-repair-product-text>重新整理文字間距</button></div></details>';return html;
}
function activateRetail(){
 project.retailRows||=[3,3,4];project.retailRowHeights||=[1,1,.85];project.retailTerms||='優惠詳情以門店公佈為準。';
 if(!retailPageErrors(project).length)arrangeAllProducts();
}
function syncRetailControls(){
 $('#retail-settings').hidden=project.template!=='retail';$('#retail-rows').value=(project.retailRows||[3,3,4]).join(',');$('#retail-heights').value=(project.retailRowHeights||[1,1,.85]).join(',');$('#retail-terms').value=project.retailTerms||'優惠詳情以門店公佈為準。';
}
$('#apply-retail-layout').addEventListener('click',()=>{
 const rows=$('#retail-rows').value.split(/[,，+＋]/).map(Number),heights=$('#retail-heights').value.split(/[,，+＋]/).map(Number);
 const proposed={...project,retailRows:rows,retailRowHeights:heights},errors=retailPageErrors(proposed);if(errors.length)return toast(errors[0]);
 project.retailRows=rows;project.retailRowHeights=heights;arrangeAllProducts();edited('修改分行布局');renderProperties();
});
$('#retail-terms').addEventListener('input',e=>{project.retailTerms=e.target.value;edited('活動說明修改');});
$('#properties').addEventListener('change',e=>{if(e.target.id==='retail-region'){activeRegion=e.target.value;editingRegion=true;renderProperties();draw();$('#retail-regions')?.setAttribute('open','');}if(e.target.dataset.prop==='cardStyle'){renderProperties();}});
$('#properties').addEventListener('input',e=>{
 const n=project.nodes.find(n=>n.id===selected);if(!n)return;
 if(e.target.dataset.region){const key=e.target.dataset.region,value=Number(e.target.value)/100;if(!Number.isFinite(value)||e.target.value==='')return;const box={...(n.regions?.[activeRegion]||defaultRegions(n)[activeRegion])};box[key]=Math.max(['w','h'].includes(key)?.01:0,Math.min(1,value));if(key==='x')box.x=Math.min(box.x,1-box.w);if(key==='y')box.y=Math.min(box.y,1-box.h);if(key==='w')box.w=Math.min(box.w,1-box.x);if(key==='h')box.h=Math.min(box.h,1-box.y);n.regions||={};n.regions[activeRegion]=box;e.target.value=Math.round(box[key]*1000)/10;edited('商品內部區域修改');}
 if(e.target.dataset.textStyle){const previous=structuredClone(n);const key=e.target.dataset.textStyle;let value=e.target.type==='checkbox'?e.target.checked:e.target.value;if(['size','lineHeight'].includes(key)){if(value==='')return;value=Number(value);if(!Number.isFinite(value))return;value=Math.max(1,Math.min(key==='size'?1000:2,value));}n.textStyles||={};n.textStyles[activeRegion]||={};n.textStyles[activeRegion][key]=value;if(key==='size')setFontSize(n,activeRegion,value);if(['size','font','bold','lineHeight'].includes(key)){try{applyProductLayout(n,canvasMeasure(ctx));}catch(error){Object.keys(n).forEach(k=>delete n[k]);Object.assign(n,previous);renderProperties();toast(error.message);return;}}edited('商品文字樣式修改');syncFontStatus(n);}
});
$('#properties').addEventListener('click',e=>{if(e.target.dataset.action==='reset-region'){const n=project.nodes.find(n=>n.id===selected);if(n?.regions)delete n.regions[activeRegion];edited('還原商品區域');renderProperties();}});
function travelHistory(direction){finishDrag();fabricEditor?.stopDragging();const restored=editHistory.travel(direction,project);if(!restored)return;const revision=project.revision;Object.assign(project,restored);for(const key of Object.keys(project))if(!(key in restored))delete project[key];project.revision=revision;historyTravel=true;selected=null;selectedPicture=null;edited(direction==='undo'?'撤銷編輯':'重做編輯');historyTravel=false;refresh();historyButtons();}
$('#undo-edit').addEventListener('click',()=>travelHistory('undo'));$('#redo-edit').addEventListener('click',()=>travelHistory('redo'));
window.addEventListener('keydown',e=>{if(e.target.closest('input,textarea,select,[contenteditable],dialog')||document.querySelector('dialog[open]'))return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();travelHistory(e.shiftKey?'redo':'undo');}});
$('#align-selection').addEventListener('click',()=>{const ids=fabricEditor?.selectedIds()||[];if(ids.length<2)return toast('請框選或 Shift 選取至少兩個元素');alignNodes(project.nodes.filter(n=>ids.includes(n.id)),$('#align-action').value);edited('對齊所選元素');renderProperties();});
$('#download-pdf').addEventListener('click',async()=>{
 if(!generatedPoster||generatedPoster.revision!==project.revision||confirmedArchive?.revision!==project.revision||firstIncomplete(project,4))return toast('請先生成、確認並存檔目前版本');
 const poster=generatedPoster;$('#download-pdf').disabled=true;
 try{const pdf=await posterPdf(poster.blob,poster.snapshot,0);download(pdf,poster.name.replace(/\.png$/,'.pdf'));}catch(error){toast(error.message);}finally{renderSteps();}
});
$('#load-retail-demo').addEventListener('click',async()=>{
 const owner=project,revision=project.revision;$('#load-retail-demo').disabled=true;
 try{
  const response=await fetch('assets/retail/demo.json');if(!response.ok)throw new Error('樣稿索引載入失敗');const demo=await response.json(),assets=[];
  for(const asset of demo.products){const response=await fetch(asset.path);if(!response.ok)throw new Error('樣稿圖片載入失敗');const blob=await response.blob(),imageUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});assets.push({...asset,imageUrl});}
  if(project!==owner||project.revision!==revision)throw new Error('載入期間專案已變更，請重新載入示例');
  const missing=assets.filter(a=>!project.products.some(p=>p.id===a.id));if(project.products.length+missing.length>100)throw new Error('素材數量超過 100 張上限');
  project.products.push(...missing);project.template='retail';project.retailRows=[3,3,4];project.retailRowHeights=[1,1,.85];
  project.nodes=demo.goods.map((g,i)=>{const asset=project.products.find(p=>p.id===g.productIds[0]),n={...productNode(asset,i),...g};delete n.productIds;n.pictures=g.productIds.map(id=>({id:uid(),productId:id,x:0,y:0,w:1,h:1}));layoutPictures(n,g.productIds.length===2?'overlap':'side');return n;});
  project.campaign={name:'至優價 · 樣稿示例（請修改）',start:'',end:'',stores:''};project.retailTerms='排版示例，非本次活動價格。請核對並修改商品、價格及活動條款。';
  arrange(project);selected=null;edited('載入樣稿示例');refresh();toast('樣稿商品已載入，請填寫本次活動日期及門店；可撤銷本次操作');
 }catch(error){toast(error.message);}finally{$('#load-retail-demo').disabled=false;}
});

function selectRegion(id,key){$('#delete-selected').disabled=false;selected=id;selectedPicture=null;pictureSelectionExplicit=false;activeRegion=key;editingRegion=true;renderProperties();draw();}
$('#properties').addEventListener('click',e=>{const button=e.target.closest('[data-edit-region]');if(!button)return;if(button.dataset.editRegion==='group'){editingRegion=false;draw();}else selectRegion(selected,button.dataset.editRegion);});

async function saveAndOpenNewProject(next,owner,revision,onProgress=()=>{}){
 let active=true;
 const report=message=>{if(active)onProgress(message);};
 try{
  clearTimeout(saveTimer);clearTimeout(archiveTimer);
  report('正在等待本機草稿保存…');await waitForArchive(pendingSave,{timeoutMs:30000});
  report('正在等待背景存檔完成…');
  await waitForArchive(archiveQueue.catch(()=>{}),{timeoutMs:120000,onTick:seconds=>report(`等待背景存檔（${seconds} 秒）：${$('#archive-status').textContent}`)});
  if(lastArchived?.owner!==owner||lastArchived.revision!==revision){
   try{
    report('正在核對需同步的圖片…');
    let phase='正在核對需同步的圖片';
    const receipt=await waitForArchive(archiveVersion(owner,{onProgress(progress){
     phase=progress.phase==='upload'?`正在上傳圖片 ${progress.done}/${progress.total}`:progress.phase==='save'?'正在保存活動資料':'正在核對需同步的圖片';report(phase+'…');
    }}),{onTick:seconds=>report(`${phase}（${seconds} 秒）…`)});
    lastArchived={owner,revision,receipt};
   }catch(error){if(error.status!==410)throw error;}
  }
  report('舊項目已保存，正在建立新項目…');
  if(project!==owner||project.revision!==revision)throw new Error('保存期間目前項目已變更，請重新新建');
  await saveProject(next);
  clearTimeout(saveTimer);clearTimeout(archiveTimer);++saveSequence;
  invalidatePreview();project=next;selected=null;selectedPicture=null;pictureSelectionExplicit=false;editingRegion=false;focusField=null;
  campaignImport=null;cutoutDraft=null;pageEditing=false;dirty=false;images.clear();
  $('#page-preset').value=next.page?'custom':'legacy';$('#poster-zoom').value='100';$('#poster-zoom-value').textContent='100%';
  fabricEditor?.setDisplayScale(1);$('#save-status').textContent='✓ 新項目已儲存至此瀏覽器';
  refresh();if(project.step===2)tab('products');scheduleArchive();
  if(!document.querySelector('dialog[open]')){
    const target=project.step===2?$('.canvas-stage'):$('#campaign-name');
    target?.scrollIntoView({block:'center'});if(project.step!==2)target?.focus({preventScroll:true});
  }
 }finally{active=false;}
}

let creatingProject=false;
function availableBackgrounds(){
 const assets=[...(project.backgrounds||[])];
 if(project.template==='custom'&&project.background&&!assets.some(a=>a.imageUrl===project.background))assets.push({id:'current-background',name:'目前上傳的底圖',imageUrl:project.background});
 return backgroundChoices(assets);
}
function openNewProject(){
 if(creatingProject)return;
 const select=$('#new-project-template');select.querySelectorAll('optgroup').forEach(group=>group.remove());
 const assets=availableBackgrounds();
 if(assets.length){const group=document.createElement('optgroup');group.label='已上傳的底圖／PDF 頁面';for(const a of assets)group.append(new Option(a.label||a.name,`background:${a.id}`));select.append(group);}
 const current=assets.find(a=>a.imageUrl===project.background);
 select.value=project.template==='custom'&&current?`background:${current.id}`:['clean','retail','membership','promotion'].includes(project.template)?project.template:'clean';
 $('#new-project-name').value='';$('#new-project-status').textContent='';$('#new-project-dialog').showModal();$('#new-project-name').focus();
}
$('#new-project').addEventListener('click',openNewProject);
$('#new-project-setup').addEventListener('click',openNewProject);
$('#close-new-project').addEventListener('click',()=>{if(!creatingProject)$('#new-project-dialog').close();});
$('#new-project-dialog').addEventListener('cancel',e=>{if(creatingProject)e.preventDefault();});
$('#new-project-form').addEventListener('submit',async e=>{
 e.preventDefault();if(creatingProject)return;
 finishDrag();fabricEditor?.stopDragging();
 const owner=project,revision=project.revision;
 const choice=$('#new-project-template').value,options={name:$('#new-project-name').value,keepAssets:$('#new-project-keep-assets').checked};
 const background=choice.startsWith('background:')?availableBackgrounds().find(a=>a.id===choice.slice(11)):null;
 creatingProject=true;$('#create-new-project').disabled=true;$('#close-new-project').disabled=true;
 $('#new-project-status').textContent='正在保存目前項目…';
 try{
  let next;
  if(choice.startsWith('background:')){
   if(!background)throw new Error('找不到所選底圖，請重新選擇');
   const image=new Image();image.src=background.imageUrl;await image.decode();
   next=newProjectFromPoster(owner,background,{width:image.naturalWidth,height:image.naturalHeight},options);sizeInfo(next);
  }else next=newProject(owner,{...options,template:choice});
  await saveAndOpenNewProject(next,owner,revision,message=>{$('#new-project-status').textContent=message;});
  $('#new-project-dialog').close();$('.step-guide').scrollIntoView({block:'start'});
  toast('已建立空白項目，舊項目可從「活動存檔」開啟');
 }catch(error){$('#new-project-status').textContent=`尚未新建，原項目保留：${error.message}`;}
 finally{creatingProject=false;$('#create-new-project').disabled=false;$('#close-new-project').disabled=false;}
});

let deletingCampaign=false;
$('#archive-delete-version').addEventListener('click',()=>{if(viewedArchive&&!deletingCampaign&&!restoringArchive)$('#archive-delete').click();});
$('#archive-delete').addEventListener('click',async()=>{
 if(!viewedArchive||deletingCampaign||restoringArchive)return;
 const id=viewedArchive.version.campaign_id,name=viewedArchive.project.campaign.name;
 if(!confirm(`刪除活動「${name}」？\n此活動的全部草稿、歷史版本及已確認海報將從存檔中刪除，無法復原。其他活動及本機素材庫不受影響。\n如需保留，請先取消並下載備份。`))return;
 deletingCampaign=true;$('#archive-delete').disabled=true;$('#archive-restore').disabled=true;
 const active=project.archiveCampaignId===id;
 try{
  if(active){clearTimeout(saveTimer);clearTimeout(archiveTimer);await pendingSave;await waitForArchive(archiveQueue.catch(()=>{}));}
  const result=await deleteCampaign(id);
  ++archiveViewTicket;viewedArchive=null;$('#archive-detail').hidden=true;$('#archive-poster').removeAttribute('src');
  if(project.archiveCampaignId===id){
   clearTimeout(saveTimer);clearTimeout(archiveTimer);++saveSequence;
   finishDrag();fabricEditor?.stopDragging();invalidatePreview();project=newProject(project,{keepAssets:true});
   selected=null;selectedPicture=null;editingRegion=false;pictureSelectionExplicit=false;focusField=null;campaignImport=null;cutoutDraft=null;pageEditing=false;images.clear();
   refresh();queueSave();
  }
  await renderArchiveList(true);toast(`已刪除活動，共 ${result.deleted_versions} 個版本`);
 }catch(error){toast(`刪除未完成：${error.message}`);if(active)queueSave();}
 finally{deletingCampaign=false;$('#archive-delete').disabled=false;$('#archive-restore').disabled=false;}
});

$('#repair-image-text').addEventListener('click',()=>{
 finishDrag();fabricEditor?.stopDragging();let count=0,failed=0;
 for(const node of project.nodes.filter(n=>n.type==='product'&&!n.locked)){
  const candidate=structuredClone(node);
  try{if(separateImageFromText(candidate,canvasMeasure(ctx))){Object.assign(node,candidate);count++;}}catch{failed++;}
 }
 if(count){edited('整理圖片與文字間距');renderProperties();}
 toast(`已整理 ${count} 組圖片與文字間距`+(failed?`；${failed} 組空間不足，請增大商品組或減小字號`:''));
});
$('#properties').addEventListener('click',e=>{
 if(!e.target.closest('[data-align-product-text]'))return;
 const n=project.nodes.find(n=>n.id===selected);if(n?.type!=='product')return;
 try{applyProductLayout(n,canvasMeasure(ctx),'retail');edited('名稱、規格與價格分欄對齊');renderProperties();}catch(error){toast(error.message);}
});

$('#properties').addEventListener('click',e=>{const button=e.target.closest('[data-delete-node]');if(button)deleteNodes([button.dataset.deleteNode]);});

$('#product-list').addEventListener('click',e=>{
 const button=e.target.closest('[data-delete-asset]');if(!button)return;
 const id=button.dataset.deleteAsset,asset=project.products.find(p=>p.id===id);if(!asset)return;
 const message=`從左側上傳圖片中移除「${asset.name}」？海報內已使用的圖片、位置及價格會保留。`;
 if(!confirm(message))return;
 finishDrag();fabricEditor?.stopDragging();deleteLibraryAsset(project,id);
 $('#lookup-results').innerHTML='';
 edited('移除上傳圖片列表條目');renderLibrary();
 toast('已從上傳圖片列表移除，海報內容保持不變');
});

function syncFontStatus(n){
 const label=$('#font-status');if(!label)return;
 if(n.type!=='product'){
  const check=$('#properties [data-prop="autoFit"]');if(check)check.checked=n.autoFit!==false;
  label.textContent=n.autoFit===false?`固定字號 ${n.fontSize}；超出時請擴大區域。`:`設定字號 ${n.fontSize}，開啟自動縮字。`;return;
 }
 if(activeRegion==='image')return;
 const automatic=activeRegion==='price'?n.priceAutoFit!==false:n.textStyles?.[activeRegion]?.autoFit!==false;
 const checkbox=activeRegion==='price'?$('#properties [data-prop="priceAutoFit"]'):$('#properties [data-text-style="autoFit"]');if(checkbox)checkbox.checked=automatic;
 const rows=retailText(n,canvasMeasure(ctx)).filter(p=>p.type==='text'&&p.part===activeRegion&&(activeRegion!=='price'||p.primary));
 const actual=rows[0]?.size,requested=requestedFontSize(n,activeRegion)??region(n,'price').h*.65;
 const format=value=>Math.round(value*10)/10;
 label.textContent=automatic?`設定 ${format(requested)}；排版字號 ${format(actual??requested)}（自動縮字）。手動改字號會關閉自動縮字。`:`固定字號 ${format(requested)}，不自動縮小；超出時請擴大區域。`;
}

$('#properties').addEventListener('click',e=>{
 if(!e.target.closest('[data-repair-product-text]'))return;
 const n=project.nodes.find(n=>n.id===selected);if(n?.type!=='product')return;
 try{applyProductLayout(n,canvasMeasure(ctx));edited('重新整理商品文字間距');renderProperties();}catch(error){toast(error.message);}
});

// 全自動換商品：舊海報 PDF＋活動表 → 新項目。
async function renderPosterBlob(scene=project){
  const snapshot=structuredClone(scene),required=snapshot.nodes.filter(n=>n.type==='product').flatMap(n=>pictures(n).map(pic=>getImage(snapshot.products.find(p=>p.id===pic.productId)?.imageUrl)));
  if(snapshot.template==='custom'&&snapshot.background)required.push(getImage(snapshot.background));
  await Promise.all(required.filter(Boolean).map(image=>image.decode().catch(()=>{})));await document.fonts.ready;
  if(fabricEditor)return fabricEditor.renderBlob(snapshot);
  const output=document.createElement('canvas'),dimensions=sizeInfo(snapshot);output.width=dimensions.width;output.height=dimensions.height;
  const context=output.getContext('2d');context.scale(dimensions.scale,dimensions.scale);draw(context,true,snapshot);
  return new Promise(resolve=>output.toBlob(resolve,'image/png'));
}
// 已保存的底圖：上傳過原始 PDF 的用 PDF（可偵測舊商品格），其餘用圖片（空白底圖）。
const savedPosters={
  async list(){
    const pdfs=new Set(await posterPdfIds().catch(()=>[]));
    const uploaded=(project.backgrounds||[]).map(b=>({id:b.id,name:b.name,pdf:pdfs.has(b.id),current:project.template==='custom'&&b.id===project.backgroundId}));
    // 內建模板也可當空白底圖：會員八格、感謝祭為圖片；至優價、清爽版由程式繪製後使用。
    const templates=backgrounds.map(b=>({id:`template:${b.id}`,name:`模板・${b.name}`,pdf:false,current:project.template===b.id}));
    return [...uploaded,...templates];
  },
  async get(id){
    if(id.startsWith('template:')){
      const template=backgrounds.find(b=>`template:${b.id}`===id);if(!template)throw new Error('找不到這個模板');
      const response=template.path?await fetch(template.path):null;
      if(response&&!response.ok)throw new Error(`模板圖片讀取失敗（${response.status}）`);
      const blob=response?await response.blob():await renderPosterBlob(newProject(project,{template:template.id,keepAssets:false}));
      if(!blob)throw new Error('模板圖片產生失敗');
      return {kind:'image',file:new File([blob],`${template.name}.png`,{type:blob.type||'image/png'}),name:template.name};
    }
    const background=(project.backgrounds||[]).find(b=>b.id===id);if(!background)throw new Error('找不到這張底圖');
    const pdf=await loadPosterPdf(id).catch(()=>null);
    if(pdf)return {kind:'pdf',file:new File([pdf.blob],pdf.name,{type:'application/pdf'}),page:pdf.page,name:pdf.name};
    const blob=await (await fetch(background.imageUrl)).blob();
    return {kind:'image',file:new File([blob],background.name,{type:blob.type||'image/png'}),name:background.name};
  }
};
// 自動抠圖（全自動換商品用）：逐件提交抠圖任務，完成後直接換入商品組件，不逐件確認。
// 已是透明底的圖片略過；同一原圖抠過的結果直接沿用。結果標記為「自動抠圖待確認」，可在素材庫檢查。
const transparentAssets=new Set();  // 已確認原本就是透明底的素材（本次瀏覽期間）
async function hasTransparency(imageUrl){
  try{const image=getImage(imageUrl);await image.decode();const c=document.createElement('canvas');c.width=c.height=64;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(image,0,0,64,64);
    const data=g.getImageData(0,0,64,64).data;for(let i=3;i<data.length;i+=4)if(data[i]<240)return true;}catch{}
  return false;
}
async function autoCutout(items,onProgress=()=>{}){
  const owner=project,failed=[],retry=[];let done=0,skipped=0;
  for(const [index,{assetId,nodeId}] of items.entries()){
    if(project!==owner)throw new Error('目前項目已切換，自動抠圖已停止');
    const node=project.nodes.find(n=>n.id===nodeId&&n.type==='product'),asset=project.products.find(p=>p.id===assetId);
    if(!node||!asset)continue;
    const label=String(node.name).split('\n').join(' ');
    onProgress(`正在自動抠圖 ${index+1}／${items.length}：${label}`);
    try{
      let result=asset.source==='cutout'?asset:project.products.find(p=>p.source==='cutout'&&p.originalAssetId===asset.id);
      if(!result&&await hasTransparency(asset.imageUrl)){transparentAssets.add(asset.id);skipped++;continue;}
      if(!result){
        const body=await cutoutSource(asset.imageUrl);
        let job=await (await cutoutResponse('/api/cutout-jobs',{method:'POST',headers:{'Content-Type':body.type},body})).json();
        const jobId=job.id;
        while(job.state!=='succeeded'){
          if(job.state==='failed')throw new Error(job.error||'抠圖失敗');
          await new Promise(resolve=>setTimeout(resolve,2000));
          if(project!==owner)throw new Error('目前項目已切換，自動抠圖已停止');
          job=await (await cutoutResponse(`/api/cutout-jobs/${encodeURIComponent(jobId)}`)).json();
        }
        const blob=await (await cutoutResponse(`/api/cutout-jobs/${encodeURIComponent(jobId)}/result`)).blob();
        const imageUrl=await readImage(new File([blob],'cutout.png',{type:'image/png'}));
        if(project!==owner)throw new Error('目前項目已切換，自動抠圖已停止');
        if(project.products.length>=100)throw new Error('素材庫已滿 100 張，請先整理素材');
        result={...structuredClone(asset),id:uid(),imageUrl,originalAssetId:asset.id,source:'cutout',cutoutReviewed:false,cutoutJobId:jobId,assetVersion:1,
          angle:`${asset.angle||'商品圖'} · 自動抠圖待確認`,filename:`${(asset.filename||asset.name).replace(/\.[^.]+$/,'')}-cutout.png`};
        project.products.push(result);
      }
      ensurePictures(node);replacePictureAsset(node,asset.id,result.id);
      done++;
    }catch(error){failed.push(`${label}：${error.message}`);retry.push({assetId,nodeId});}
  }
  if(done)edited('自動抠圖並換入透明底商品圖');
  queueSave();await renderLibrary();renderBatchCutout();
  return {done,skipped,failed,retry};
}
// 「一鍵抠圖」：畫布上商品組件中尚未抠圖的圖片（已透明底的在執行時略過）。
function cutoutCandidates(){
  const seen=new Set();
  return project.nodes.filter(n=>n.type==='product').flatMap(n=>pictures(n).flatMap(pic=>{
    const asset=project.products.find(p=>p.id===pic.productId);
    if(!asset||asset.source==='cutout'||transparentAssets.has(asset.id)||seen.has(`${n.id}:${asset.id}`))return [];
    seen.add(`${n.id}:${asset.id}`);return [{assetId:asset.id,nodeId:n.id}];
  }));
}
let batchCutoutRunning=false;
function renderBatchCutout(){
  const button=$('#batch-cutout');if(!button)return;
  const count=cutoutCandidates().length;
  button.hidden=!count&&!batchCutoutRunning;button.disabled=batchCutoutRunning;
  if(!batchCutoutRunning)button.textContent=`一鍵抠圖（${count} 件）`;
}
$('#batch-cutout').addEventListener('click',async()=>{
  const items=cutoutCandidates();if(!items.length||batchCutoutRunning)return;
  if(cutoutBusy)return toast('抠圖任務仍在進行，請稍候');
  batchCutoutRunning=true;cutoutBusy=true;renderBatchCutout();
  try{
    const result=await autoCutout(items,message=>{$('#batch-cutout').textContent=message.replace('正在自動抠圖','抠圖中');});
    toast(`一鍵抠圖完成：${result.done} 件已換成透明底${result.skipped?`，${result.skipped} 件原本已是透明底`:''}${result.failed.length?`；${result.failed.length} 件失敗，可再按一次重試：${result.failed.join('；')}`:''}。請在畫布檢查邊緣。`);
  }catch(error){toast(error.message);}
  finally{batchCutoutRunning=false;cutoutBusy=false;renderBatchCutout();}
});
const posterAuto=installPosterAuto({getProject:()=>project,savedPosters,provider:{resolve:(...args)=>provider.resolve(...args)},productOptions,toast,renderPoster:()=>renderPosterBlob(),
  inTask:()=>taskMode(),
  async taskSheet(){
    if(!taskMode()||!workflowItem.sheet)return null;
    const item=workflowItem,response=await fetch(`/api/workflow/${encodeURIComponent(item.campaign_id)}/sheet`);
    if(!response.ok)return null;
    const blob=await response.blob();
    return new File([blob],item.sheet.filename||'活動表.xlsx',{type:blob.type});
  },
  async createProject(analysis,plan,{pdfName,sheetName,onProgress=()=>{}}){
    if(creatingProject)throw new Error('正在建立項目，請稍候');
    creatingProject=true;
    const owner=project,revision=owner.revision;
    let phase='讀取海報底圖';
    const progress=message=>{phase=message;onProgress(message);};
    try{
    progress('正在讀取海報底圖…');
    const [head,body]=analysis.background.split(','),bytes=Uint8Array.from(atob(body),c=>c.charCodeAt(0)),mime=/^data:(image\/(?:png|jpeg|webp));base64$/.exec(head)?.[1]||'image/png';
    const name=`${pdfName.replace(/\.(pdf|png|jpe?g|webp)$/i,'')} - 自動換商品`,imageUrl=await readImage(new File([bytes],`${name}.${mime.split('/')[1]}`,{type:mime})),image=new Image();image.src=imageUrl;await image.decode();
    if(project!==owner||owner.revision!==revision)throw new Error('目前項目已變更，請重新分析');
    const next=newProjectFromPoster(owner,{id:uid(),name:`${name}.png`,imageUrl},{width:image.naturalWidth,height:image.naturalHeight});sizeInfo(next);
    await snapshotCampaignImages(next,plan.pairs.filter(p=>p.row).map(p=>p.row),undefined,progress);
    progress('正在解碼圖片並排列商品…');
    await measureAssets(next,plan.pairs.filter(p=>p.row).flatMap(p=>[p.row.assetId,...['companion','companion3','companion4'].map(k=>p.row[k]?.assetId).filter(Boolean)]));
    const nodes=applyAutoReplace(next,analysis,plan,canvasMeasure(ctx),sheetName);next.step=2;
    // 從採購任務發起：沿用任務的活動編號，存檔與確認仍屬此任務。修訂號須高於任務已存的版本，
    // 否則伺服器把它當作過期的自動保存而不更新（archives.py latestOnly）。
    const task=taskMode();
    if(task){next.archiveCampaignId=owner.archiveCampaignId;next.revision=Math.max(next.revision||1,owner.revision+1);
      if(workflowItem?.sheet&&sheetName===workflowItem.sheet.filename)next.sheetImportedAt=workflowItem.sheet.uploaded_at;}
    progress('正在保存新海報…');await saveAndOpenNewProject(next,owner,revision,progress);
    toast(task?'已用自動換商品更新此任務的海報，請核對每件商品的名稱、規格及價格。':'已建立自動換商品的新項目，請核對每件商品的名稱、規格及價格。');
    return nodes;
    }catch(error){throw Object.assign(new Error(`${phase}：${error.message}`,{cause:error}),{name:error.name});}
    finally{creatingProject=false;}
  }});
$('#open-poster-auto').addEventListener('click',()=>posterAuto.open());
$('#ai-review-canvas').addEventListener('click',()=>{
 if(!project.nodes.some(n=>n.type==='product'))return toast('請先加入商品');
 $('#ai-review-dialog').showModal();posterAuto.review($('#ai-review-result'));
});
$('#close-ai-review').addEventListener('click',()=>$('#ai-review-dialog').close());
const posterReuseEditor=installPosterReuse({getProject:()=>project,toast,onCutout:startCutout,async commit(next,{owner,revision,isNew}){
 finishDrag();fabricEditor?.stopDragging();
 clearTimeout(saveTimer);clearTimeout(archiveTimer);
 try{
  await pendingSave;await waitForArchive(archiveQueue.catch(()=>{}));
  if(project!==owner||project.revision!==revision)throw new Error('目前項目已變更，請重新開啟套版');
  if(isNew){try{await archiveVersion(structuredClone(owner));}catch(error){if(error.status!==410)throw error;}}
  if(project!==owner||project.revision!==revision)throw new Error('目前項目已變更，請重新開啟套版');
  touch(next,isNew?'沿用舊海報建立活動':'修改舊海報套版');next.step=firstIncomplete(next,2)?1:2;next.flowVersion=2;
  await saveProject(next);++saveSequence;
  invalidatePreview();project=next;selected=null;selectedPicture=null;pictureSelectionExplicit=false;editingRegion=false;focusField=null;
  campaignImport=null;cutoutDraft=null;pageEditing=false;dirty=false;images.clear();
  $('#page-preset').value='custom';$('#poster-zoom').value='100';$('#poster-zoom-value').textContent='100%';fabricEditor?.setDisplayScale(1);
  refresh();tab('products');scheduleArchive();
 }catch(error){queueSave();throw error;}
}});

$('#pdf-original').addEventListener('click',()=>{const dialog=$('#pdf-original-dialog');$('#pdf-original-image').src=project.backgrounds?.find(a=>a.id===project.pdfImport?.backgroundId)?.imageUrl||project.background;dialog.showModal();});
$('#close-pdf-original').addEventListener('click',()=>$('#pdf-original-dialog').close());


// Start only after every shared state binding and dialog handler is initialized.

try {
  fabricEditor=await createFabricEditor(canvas,{
    picture:selectPicture,
    region:selectRegion,
    regionModify(id,key,box){const n=project.nodes.find(n=>n.id===id);if(!n||n.locked)return;setRegionBox(n,key,box);edited('文字／價格區域調整');renderProperties();},
    snap(node){return $('#snap-enabled').checked?snapPosition(node,project.nodes,WIDTH,HEIGHT):null;},
    select(ids){editingRegion=false;pictureSelectionExplicit=false;selected=ids.length===1?ids[0]:null;selectedPicture=null;renderProperties();$('#delete-selected').disabled=!ids.length;$('#merge-selected').disabled=ids.length<2;},
    background(box){project.backgroundPlacement=box;edited('底圖位置與尺寸修改');},
    modify(updates){
      for(const u of updates){const n=project.nodes.find(v=>v.id===u.id);if(!n||n.locked)continue;
        Object.assign(n,clampNodeTransform(u,WIDTH,HEIGHT));if($('#snap-enabled').checked&&updates.length===1){const snap=snapPosition(n,project.nodes,WIDTH,HEIGHT);n.x=snap.x;n.y=snap.y;}
      }
      edited('Fabric 圖層調整');renderProperties();
    },
    error(error){toast(error.message);}
  });
  $('#engine-status').textContent='Fabric.js 編輯器';
}catch(error){$('#engine-status').textContent=`相容模式：${error.message}`;console.error('Fabric initialization failed',error);toast('完整編輯器載入失敗；仍可拖動商品，整張畫布請點「調整海報尺寸」。');}
try { const saved=await loadProject();if(saved?.schema===1)project=saved;$('#save-status').textContent=saved?'✓ 已恢復本機草稿':'自動儲存已就緒'; }
catch{toast('瀏覽器儲存不可用，請定期匯出備份');$('#save-status').textContent='請使用專案備份保存';}
refresh();scheduleArchive();
await openFromWorkflow();
// Product assets are added only by user upload/import; no automatic sample seeding.

const recoveredCutout=recoverCutout(project);if(recoveredCutout)project.cutoutPending=recoveredCutout;
if(project.cutoutPending)resumeCutout();


// Follow the displayed editor height, including zoom, toolbar wrapping and page resizing.
if(typeof ResizeObserver!=='undefined'){
 const editor=document.querySelector('.studio>.editor'),library=document.querySelector('.studio>.library');
 if(editor&&library){
  const libraryHeightObserver=new ResizeObserver(()=>{
   const height=editor.getBoundingClientRect().height;
   if(height>0)library.style.setProperty('--poster-panel-height',`${height}px`);
  });
  libraryHeightObserver.observe(editor);
 }
}

// ---- 海報製作流程：由流程頁開啟指定活動；第 3 步把海報預覽提交市場部確認 ----
// workflowItem 在檔案頂部宣告。openFromWorkflow 在模組求值暫停期間就會讀它。
async function workflowFetch(url,options={}){
  const response=await fetch(url,options);const body=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(typeof body?.detail==='string'?body.detail:`流程操作失敗（${response.status}）`);
  return body;
}
async function loadWorkflowItem(){
  let item=null;
  if(project.archiveCampaignId){try{item=await workflowFetch(`/api/workflow/${encodeURIComponent(project.archiveCampaignId)}`);}catch{item=null;}}
  workflowItem=item;
  renderSteps();renderWorkflowReview();
}
function workflowConfirmVisible(item){
  const me=window.posterUser||{},canConfirm=me.permissions?.includes('confirm');
  const ownWork=!!me.policies?.confirmByOther&&(item.assignee===me.username||item.submitted_by===me.username||(!item.assignee&&!item.submitted_by));
  return canConfirm&&!ownWork&&['submitted','in_design','pending_confirm'].includes(item.status);
}
// 採購重新提交活動表後，已保存的海報不會自動更新。未記錄匯入版本的舊項目視為套用了最初提交的活動表。
function sheetOutdated(item){
  if(!item||item.legacy||!item.sheet||!project.nodes.length)return false;
  return item.sheet.uploaded_at!==(project.sheetImportedAt||item.created_at);
}
async function reimportTaskSheet(){
  const item=workflowItem;if(!taskMode()||!item.sheet)return;
  if(item.product_count>12){posterAuto.open();return;}  // 超過 12 件：自動換商品會帶入任務的活動表
  const response=await fetch(`/api/workflow/${encodeURIComponent(item.campaign_id)}/sheet`);
  if(!response.ok)throw new Error('讀取活動表失敗');
  const blob=await response.blob(),file=new File([blob],item.sheet.filename||'活動表.xlsx',{type:blob.type});
  pendingSheetStamp={campaign:item.campaign_id,stamp:item.sheet.uploaded_at};
  const input=$('#campaign-upload'),files=new DataTransfer();files.items.add(file);input.files=files.files;input.dispatchEvent(new Event('change'));
}
$('#studio-sheet-reimport').addEventListener('click',()=>reimportTaskSheet().catch(error=>toast(error.message)));
$('#studio-sheet-dismiss').addEventListener('click',()=>{
  const item=workflowItem;if(!taskMode()||!item.sheet)return;
  project.sheetImportedAt=item.sheet.uploaded_at;edited('已核對更新的活動表');renderWorkflowReview();
});
function renderStudioWorkflowBar(){
  const bar=$('#studio-workflow-bar');if(!bar)return;
  const item=workflowItem&&workflowItem.campaign_id===project.archiveCampaignId?workflowItem:null;
  // 沒有對應任務（自由編輯）時仍顯示此列，保留「返回任務列表」。
  bar.hidden=false;
  const outdated=sheetOutdated(item);$('#studio-sheet-update').hidden=!outdated;
  if(outdated)$('#studio-sheet-text').textContent=`採購已於 ${new Date(item.sheet.uploaded_at).toLocaleString('zh-HK')} 重新提交活動表（${item.sheet.filename}），目前海報尚未套用新內容。`;
  if(!item){
    $('#studio-workflow-name').textContent='自由編輯';
    $('#studio-workflow-status').textContent='此項目不屬於任何採購任務，不會出現在任務列表的狀態中';
    $('#studio-workflow-campaign').textContent='';
    $('#studio-confirm').hidden=true;return;
  }
  const c=project.campaign;
  $('#studio-workflow-campaign').textContent=`${c.start||'？'} 至 ${c.end||'？'} · ${c.stores||'門店未填'}${item.legacy?'':' · 來自採購活動表'}`;
  const ready=generatedPoster&&generatedPoster.revision===project.revision;
  const showConfirm=workflowConfirmVisible(item);
  $('#studio-workflow-name').textContent=`${item.code} · ${item.name}`;
  $('#studio-workflow-status').textContent=item.status==='confirmed'
    ?`已確認${item.confirmed_by_name?` · ${item.confirmed_by_name}`:''}`
    :ready?`${item.statusName} · 預覽已就緒，可確認`:`${item.statusName} · 請先生成海報預覽`;
  const confirmBtn=$('#studio-confirm');
  confirmBtn.hidden=!showConfirm;confirmBtn.disabled=!showConfirm;
  confirmBtn.textContent=ready?'確認海報':'確認海報（請先生成預覽）';
}
function renderWorkflowReview(){
  const box=$('#workflow-review');if(!box)return;
  const item=workflowItem&&workflowItem.campaign_id===project.archiveCampaignId?workflowItem:null;
  renderStudioWorkflowBar();
  box.hidden=!item;if(!item)return;
  const ready=generatedPoster&&generatedPoster.revision===project.revision,open=['submitted','in_design'].includes(item.status);
  const showConfirm=workflowConfirmVisible(item);
  const ownWork=!!window.posterUser?.policies?.confirmByOther&&(item.assignee===window.posterUser.username||item.submitted_by===window.posterUser.username||(!item.assignee&&!item.submitted_by));
  $('#submit-for-review').disabled=!open||!ready;
  $('#confirm-poster').hidden=!showConfirm;$('#confirm-poster').disabled=!ready;
  $('#workflow-review-status').innerHTML=`流程 ${esc(item.code)} · ${esc(item.statusName)}`+(
    item.status==='pending_confirm'?(showConfirm?'：請核對名稱、規格、價格、日期及門店後按「確認海報」。':'：已提交，等待另一位市場部同事確認。'):
    item.status==='confirmed'?`：已由 ${esc(item.confirmed_by_name||'')} 確認。再修改並保存會改回「製作中」，需重新確認。`:
    item.status==='returned'?'：已退回採購修正活動表。':
    item.status==='cancelled'?'：申請已取消。':
    showConfirm?(ready?'：可按頂部「確認海報」，或先提交給另一位同事確認。':'：請先生成目前版本的海報預覽。'):
    ownWork?(ready?'：請按「提交市場部確認」，由另一位同事核對。':'：請先生成目前版本的海報預覽。'):
    ready?'：可提交市場部確認。':'：請先生成目前版本的海報預覽，再提交確認。');
}
async function runConfirmPoster(){
  const item=workflowItem;
  if(!item||!window.posterUser?.permissions?.includes('confirm'))return;
  if(!generatedPoster||generatedPoster.revision!==project.revision){
    goStep(3);toast('請先按「生成海報預覽」，再確認');return;
  }
  if(!confirm(`確認「${project.campaign?.name||item.name}」的名稱、規格、價格、日期及門店均已核對無誤？確認後海報可用於印刷。`))return;
  const buttons=[$('#confirm-poster'),$('#studio-confirm')].filter(Boolean);
  buttons.forEach(b=>b.disabled=true);
  try{
    const already=project.reviewedRevision===project.revision&&confirmedArchive?.revision===project.revision;
    if(!already&&!await confirmArchive(true))return;
    toast('已確認海報');
  }finally{buttons.forEach(b=>b.disabled=false);renderWorkflowReview();window.dispatchEvent(new Event('poster-workflow-changed'));}
}
$('#confirm-poster').addEventListener('click',()=>runConfirmPoster());
$('#studio-confirm')?.addEventListener('click',()=>runConfirmPoster());
$('#studio-generate')?.addEventListener('click',()=>{goStep(3);$('#generate-poster')?.click();});
$('#submit-for-review').addEventListener('click',async()=>{
  const poster=generatedPoster,item=workflowItem,button=$('#submit-for-review');
  if(!item)return;if(!poster||poster.revision!==project.revision)return toast('請先生成目前版本的海報預覽');
  button.disabled=true;$('#workflow-review-status').textContent='正在保存海報預覽並提交確認…';
  clearTimeout(archiveTimer);
  try{
    const receipt=await waitForArchive(archiveVersion(structuredClone(poster.snapshot),{poster:poster.blob}));
    if(receipt?.stored===false||!receipt?.poster_hash)throw new Error('伺服器已有較新的版本，海報預覽未保存；請重新開啟活動後再提交');
    workflowItem=await workflowFetch(`/api/workflow/${encodeURIComponent(item.campaign_id)}/action`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'submit_review',comment:''})});
    toast('已提交市場部確認');
  }catch(error){toast(error.message);}
  finally{renderWorkflowReview();window.dispatchEvent(new Event('poster-workflow-changed'));}
});
async function openFromWorkflow(){
  const id=decodeURIComponent((/[?&]campaign=([^&#]+)/.exec(globalThis.location?.search||'')||[])[1]||'');
  if(!id){await loadWorkflowItem();return;}
  globalThis.history?.replaceState?.(null,'',location.pathname);
  await openWorkflowCampaign(id);
}
let openingWorkflow=null;
function openWorkflowCampaign(id){
  if(openingWorkflow)return openingWorkflow.then(()=>project.archiveCampaignId===id?loadWorkflowItem():openWorkflowCampaign(id));
  openingWorkflow=switchToWorkflowCampaign(id).finally(()=>{openingWorkflow=null;});
  return openingWorkflow;
}
async function switchToWorkflowCampaign(id){
  if(project.archiveCampaignId===id){await loadWorkflowItem();return;}
  try{
    const item=await workflowFetch(`/api/workflow/${encodeURIComponent(id)}`);
    const [latest]=await workflowFetch(`/api/archives?campaign_id=${encodeURIComponent(id)}&latest_only=true`);
    workflowItem=item;  // 先記下任務，切換項目後第一次繪製就是任務模式（taskMode 以活動編號比對，切換前不生效）
    const owner=project,revision=project.revision;
    // 先保存目前草稿，才切換到流程項目；草稿所屬活動已被刪除（410）時不阻擋開啟。
    try{await waitForArchive(archiveVersion(owner));}catch(error){if(error.status!==410)throw error;}
    if(project!==owner||project.revision!==revision)throw new Error('目前草稿已變更，請重新從流程頁開啟');
    if(latest){
      const full=await getArchive(latest.id),restored=parseBackup(JSON.stringify(full.project));
      restored.archiveCampaignId=id;restored.parentArchiveId=latest.id;
      invalidatePreview();project=restored;selected=null;selectedPicture=null;images.clear();refresh();queueSave();
      toast(`已開啟 ${item.code} ${item.name}`);
    }else{
      const next=newProject(owner,{name:item.name});next.archiveCampaignId=id;
      next.campaign={name:item.name,start:item.start||'',end:item.end||'',stores:item.stores||''};
      await saveAndOpenNewProject(next,owner,revision);
      // 超過 12 件不能用一般匯入：直接開啟「全自動換商品」，已帶入此任務的活動表，只需選舊海報或底圖。
      if(item.product_count>12){toast(`${item.code} 有 ${item.product_count} 件商品，請選擇舊海報或底圖；活動表已自動帶入`);posterAuto.open();}
      else{
        // 匯入採購提交的活動表：與手動「Excel 匯入」相同，市場部確認圖片匹配後生成草稿。
        const response=await fetch(`/api/workflow/${encodeURIComponent(id)}/sheet`);
        if(!response.ok)throw new Error('讀取活動表失敗');
        const blob=await response.blob(),file=new File([blob],item.sheet?.filename||'活動表.xlsx',{type:blob.type});
        pendingSheetStamp={campaign:id,stamp:item.sheet?.uploaded_at};
        const input=$('#campaign-upload'),files=new DataTransfer();files.items.add(file);input.files=files.files;input.dispatchEvent(new Event('change'));
        toast(`已建立 ${item.code} 的海報項目，請確認活動表的圖片匹配後生成草稿`);
      }
    }
  }catch(error){toast(`無法開啟流程項目：${error.message}`);}
  await loadWorkflowItem();
}
async function editWorkflowCampaign(id){
  await openWorkflowCampaign(id);
}
window.posterStudio=Object.freeze({openCampaign:editWorkflowCampaign,refreshWorkflow:loadWorkflowItem,goStep});
