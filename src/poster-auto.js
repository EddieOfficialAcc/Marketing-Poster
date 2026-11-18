import {separateImageFromText} from './product-layout.js';
import {attachCampaignPictures} from './campaign-import.js';
// 全自動換商品：舊海報的商品格按閱讀順序（左上到右下）逐一換成活動表的商品。
// 位置與文字樣式來自舊海報分析；名稱、規格、價格只取自活動表，AI 只判斷哪些格是商品及校對成品。
import {uid,productNode} from './model.js';
import {sizeInfo} from './sizing.js';
import {retailFonts,offer,originalLabel} from './retail.js';

const median=values=>{const list=values.filter(Number.isFinite).sort((a,b)=>a-b);return list.length?list[list.length>>1]:NaN;};

// 同一行的格子中心高度相近：按行分組後由左至右。
export function readingOrder(slots){
 const centre=s=>s.box[1]+s.box[3]/2,tolerance=median(slots.map(s=>s.box[3]))/2,rows=[];
 for(const slot of [...slots].sort((a,b)=>centre(a)-centre(b))){
  const row=rows.find(r=>Math.abs(centre(r[0])-centre(slot))<tolerance);
  if(row)row.push(slot);else rows.push([slot]);
 }
 return rows.flatMap(row=>row.sort((a,b)=>a.box[0]-b.box[0]));
}

// 整張海報的商品文字用同一樣式：取各格識別結果的中位數，避免個別格識別偏差。
export function posterTextStyle(slots){
 const styles=slots.map(s=>s.nameStyle).filter(s=>s&&!s.error),colors={};
 for(const s of styles)colors[s.color]=(colors[s.color]||0)+1;
 const lineHeight=median(styles.map(s=>s.lineHeight));
 return {fontSize:median(styles.map(s=>s.fontSize)),lineHeight:Math.min(2,Math.max(1,Number.isFinite(lineHeight)?lineHeight:1.4)),
  color:Object.keys(colors).sort((a,b)=>colors[b]-colors[a])[0]||'#231f20',bold:median(styles.map(s=>s.weight))>=600};
}

// 商品數與商品格數相同時逐格替換；不同時遮蓋全部舊商品，在原商品區內按商品數重新分格，
// 每格沿用一個代表格的內部比例（圖片、名稱區、價格牌），文字與價格牌按格子縮放。
// 同一行商品的文字字號、頂線及在格內的左右位置相同：逐格替換時按行取中位數，
// 避免個別格的識別偏差（被商品圖干擾）影響位置與字號；不同行可有不同字號（如首行較大）。
export function harmonizeRows(slots){
 const centre=s=>s.box[1]+s.box[3]/2,tolerance=median(slots.map(s=>s.box[3]))/2,rows=[];
 for(const slot of slots){const row=rows.find(r=>Math.abs(centre(r[0])-centre(slot))<tolerance);if(row)row.push(slot);else rows.push([slot]);}
 return slots.map(slot=>{
  const row=rows.find(r=>r.includes(slot)),valid=row.filter(s=>s.nameStyle&&!s.nameStyle.error);
  if(!valid.length)return slot;
  const ratio=(s,key)=>(s.nameStyle[key]-s.box[0])/s.box[2],base=valid[0].nameStyle;
  const [x,,w]=slot.box;
  return {...slot,nameStyle:{...base,...(slot.nameStyle&&!slot.nameStyle.error?slot.nameStyle:{}),fontSize:median(valid.map(s=>s.nameStyle.fontSize)),top:median(valid.map(s=>s.nameStyle.top)),
   left:x+w*median(valid.map(s=>ratio(s,'left'))),right:x+w*median(valid.map(s=>ratio(s,'right')))},rowFont:true};
 });
}

export function autoPlan(analysis,rows){
 if(analysis?.version!==1||!Array.isArray(analysis.slots))throw new Error('舊海報分析結果無效');
 const verdicts=analysis.ai?.slots||{},warnings=[...(analysis.warnings||[])];
 const skipped=analysis.slots.filter(s=>verdicts[s.id]?.status==='not_product');
 const usable=readingOrder(analysis.slots.filter(s=>!skipped.includes(s)));
 for(const s of skipped)warnings.push(`AI 判斷偵測到的一格不是商品（${verdicts[s.id].note||'無說明'}），已略過。`);
 if(usable.some(s=>verdicts[s.id]?.status==='merged'))warnings.push('AI 判斷有商品格可能含兩件商品，請核對。');
 if(analysis.ai?.uncovered)warnings.push(`AI 發現 ${analysis.ai.uncovered} 件商品未被偵測為商品格，這些舊商品會保留在底圖中。`);
 const style=posterTextStyle(usable);
 if(analysis.layout==='single'){
  // 單品 POP：只有一個商品位，只遮蓋舊相片、名稱區及價格，標籤與條款保留。
  if(rows.length>1)warnings.push(`這是單一商品海報，只放入第 1 件；其餘 ${rows.length-1} 件請用其他頁或另一張海報。`);
  return {mode:'match',single:true,pairs:usable.map((slot,i)=>({slot,row:rows[i]||null})),masks:rows.length?usable.flatMap(s=>s.region||[]):[],warnings,style,cells:usable.length};
 }
 if(analysis.blank&&analysis.layout==='panel')
  return {mode:'grid',blank:'panel',pairs:rows.length?gridSlots(usable,rows,analysis.zone).map((slot,i)=>({slot,row:rows[i]})):[],masks:[],warnings,style,cells:0};
 if(analysis.blank){
  // 底圖已印好商品框：按格號放入；框數固定，不能重新分格。
  if(rows.length<usable.length)warnings.push(`底圖有 ${usable.length} 個商品框，商品只有 ${rows.length} 件：第 ${rows.length+1===usable.length?usable.length:`${rows.length+1}–${usable.length}`} 格會留空。`);
  if(rows.length>usable.length)warnings.push(`底圖只有 ${usable.length} 個商品框：第 ${usable.length+1} 件起不會放入，請刪除部分商品或改用其他底圖。`);
  return {mode:'match',blank:'cells',pairs:usable.map((slot,i)=>({slot,row:rows[i]||null})),masks:[],warnings,style,cells:usable.length};
 }
 if(!usable.length||rows.length===usable.length)
  return {mode:'match',pairs:harmonizeRows(usable).map((slot,i)=>({slot,row:rows[i]||null})),masks:usable.filter((_,i)=>rows[i]).map(s=>s.region),warnings,style,cells:usable.length};
 warnings.push(`商品 ${rows.length} 件、舊海報 ${usable.length} 格：產生時遮蓋全部舊商品，按 ${rows.length} 件重新分格並自動調整比例。`);
 return {mode:'grid',pairs:gridSlots(usable,rows,null).map((slot,i)=>({slot,row:rows[i]})),masks:usable.map(s=>s.region),warnings,style,cells:usable.length};
}

// 選出最接近舊格比例的行列數；格子最多放大到代表格的 1.4 倍，多出的空間平均留白。
export function gridLayout(zone,count,aspect){
 let best=null;
 for(let cols=1;cols<=count;cols++){
  const rows=Math.ceil(count/cols);if(rows>1&&(rows-1)*cols>=count)continue;
  // 比例接近舊格為主；末行空位愈多愈不平均（4 件取 2＋2 而非 3＋1）。
  const score=Math.abs(Math.log((zone.w/cols)/(zone.h/rows)/aspect))+.8*(rows*cols-count)/cols;
  if(!best||score<best.score)best={cols,rows,score};
 }
 return best;
}
function gridSlots(usable,rows,fixedZone=null){
 const ok=usable.filter(s=>s.nameStyle&&!s.nameStyle.error&&s.priceBox);
 const area=s=>s.box[2]*s.box[3],pool=(ok.length?ok:usable).slice().sort((a,b)=>area(a)-area(b));
 const template=pool[pool.length>>1],boxes=priceBoxes(usable);
 const byKind=kind=>usable.filter(s=>s.priceBox&&boxes.kind(s.priceBox)===kind).sort((a,b)=>area(a)-area(b));
 const kinds={single:byKind('single'),bundle:byKind('bundle')};
 const zone=fixedZone?{x:fixedZone[0],y:fixedZone[1],w:fixedZone[2],h:fixedZone[3]}:{x:Math.min(...usable.map(s=>s.box[0])),y:Math.min(...usable.map(s=>s.box[1]))};
 if(!fixedZone){zone.w=Math.max(...usable.map(s=>s.box[0]+s.box[2]))-zone.x;zone.h=Math.max(...usable.map(s=>s.box[1]+s.box[3]))-zone.y;}
 const [,,TW,TH]=template.box,{cols,rows:lines}=gridLayout(zone,rows.length,TW/TH);
 let cw=zone.w/cols,ch=zone.h/lines;const grow=Math.min(cw/TW,ch/TH);
 if(grow>1.4){cw*=1.4/grow;ch*=1.4/grow;}
 const top=zone.y+(zone.h-ch*lines)/2;
 return rows.map((row,i)=>{
  const line=Math.floor(i/cols),inLine=Math.min(cols,rows.length-line*cols),col=i-line*cols;
  const cell={x:zone.x+(zone.w-cw*inLine)/2+col*cw,y:top+line*ch,w:cw,h:ch};
  // 由舊格 from 映射到新格：位置按寬高各自比例，字與價格牌按較小的比例等比縮放。
  const map=(from,[bx,by,bw,bh])=>{const [fx,fy,fw,fh]=from.box;return [cell.x+(bx-fx)*cw/fw,cell.y+(by-fy)*ch/fh,bw*cw/fw,bh*ch/fh];};
  const scale=Math.min(cw/TW,ch/TH),ns=template.nameStyle&&!template.nameStyle.error?template.nameStyle:null,[TX,TY]=template.box;
  const kind=row.quantity>1?'bundle':'single',source=kinds[kind][kinds[kind].length>>1];
  let priceBox=null;
  if(source){const [px,py]=map(source,source.priceBox),k=Math.min(cw/source.box[2],ch/source.box[3]);priceBox=[px,py,source.priceBox[2]*k,source.priceBox[3]*k];}
  else if(template.priceBox){const [px,py,,]=map(template,template.priceBox),f=kind==='bundle'?1.75:1/1.75;priceBox=[px,py,template.priceBox[2]*scale,template.priceBox[3]*scale*f];}
  if(priceBox){priceBox[2]=Math.min(priceBox[2],cell.x+cw-priceBox[0]);priceBox[3]=Math.min(priceBox[3],cell.y+ch-priceBox[1]);}
  return {id:i+1,box:[cell.x,cell.y,cw,ch],imageBox:map(template,template.imageBox),textBox:map(template,template.textBox),scale,priceFixed:true,priceBox,priceColor:template.priceColor,
   nameStyle:ns?{...ns,left:cell.x+(ns.left-TX)*cw/TW,top:cell.y+(ns.top-TY)*ch/TH,right:cell.x+(ns.right-TX)*cw/TW}:null};
 });
}

// 舊價格牌分兩種：單一價（較矮）與「平均每件＋$xx/2件」組合價（多一條色帶，較高）。
// 新商品的價格類型不同時，改用同一海報上該類價格牌的中位尺寸，左上角對齊舊價格牌。
export function priceBoxes(slots){
 const boxes=slots.map(s=>s.priceBox).filter(Boolean),shortest=Math.min(...boxes.map(b=>b[3]));
 const kind=box=>box[3]>shortest*1.35?'bundle':'single',sizes={single:[],bundle:[]};
 for(const box of boxes)sizes[kind(box)].push(box);
 const typical=list=>list.length?[median(list.map(b=>b[2])),median(list.map(b=>b[3]))]:null;
 return {kind,size:{single:typical(sizes.single),bundle:typical(sizes.bundle)}};
}
function fitPriceBox(slot,quantity,boxes){
 const box=slot.priceBox;if(!box)return null;
 const want=quantity>1?'bundle':'single';if(boxes.kind(box)===want)return box;
 const [w,h]=boxes.size[want]||(want==='bundle'?[box[2],box[3]*1.75]:[box[2],box[3]/1.75]);
 const [cx,cy,cw,ch]=slot.box;
 return [box[0],box[1],Math.min(w,cx+cw-box[0]),Math.min(h,cy+ch-box[1])];
}

// 測得的是價格牌的「墨跡」範圍。組合價的版面（大字＋平均每件＋色帶）與 retailText 的比例一致，直接沿用；
// 單一價在 retailText 中字號只佔區域高度 85%，且 Arial 數字高約字號 0.72、上方留白約 0.19，需放大區域才能與舊數字等高。
function priceLayout([x,y,w,h],quantity,[cx,cy,cw,ch]){
 if(quantity>1)return [x,y,w,h];
 const size=h/.72,top=Math.max(cy,y-size*.19);
 return [x,top,Math.min(w*1.08,cx+cw-x),Math.min(size/.85,cy+ch-top)];
}

// 與 retailText 相同的逐字換行，用來決定名稱佔幾行。
function lineCount(value,width,size,family,measure){
 let count=0;
 for(const line of String(value).split('\n')){let row='',rows=1;for(const ch of line){if(row&&measure(row+ch,size,family,400)>width){rows++;row='';}row+=ch;}count+=rows;}
 return count;
}

export function applyAutoReplace(project,analysis,plan,measure,filename=''){
 const {w:W,h:H}=sizeInfo(project),sx=W/analysis.pageWidth,sy=H/analysis.pageHeight,style=plan.style;
 if(project.posterReuse.masks.length+plan.masks.flat().length>100)throw new Error('遮蓋區將超過 100 個');
 const placed=plan.pairs.filter(p=>p.row);
 if(!placed.length)throw new Error('沒有可放入的商品');
 if(placed.some(p=>!project.products.some(a=>a.id===p.row.assetId)||(p.row.code2&&!project.products.some(a=>a.id===p.row.companion?.assetId))))throw new Error('請為每件商品選擇圖片');
 if(placed.some(({row:r})=>[3,4].some(i=>r['code'+i]&&!project.products.some(a=>a.id===r['companion'+i]?.assetId))))throw new Error('請選擇第三、第四件商品圖片');
 const nodes=[],boxes=priceBoxes(plan.pairs.filter(p=>!p.slot.priceFixed).map(p=>p.slot));
 for(const {slot,row} of placed){
  const asset=project.products.find(a=>a.id===row.assetId),n=productNode(asset);
  // 保持在畫布內：格子貼齊頁邊時，換算成畫布座標可能因浮點誤差超出一點點。
  const [x,y,w,h]=slot.box,cell={x:Math.max(0,x*sx),y:Math.max(0,y*sy)};cell.w=Math.min(w*sx,W-cell.x);cell.h=Math.min(h*sy,H-cell.y);
  Object.assign(n,cell,{name:row.name,sku:row.sku||asset.sku||'',spec:row.spec||'',price:row.price,quantity:row.quantity,cardStyle:'retail',shadow:0,averageRounding:row.averageRounding||'tenth',
   originalPrice:row.originalPrice||'',originalStrike:row.originalStrike??true,importedOffer:{filename,row:row.row,price:row.price,price2:row.price2,quantity:row.quantity},autoReplace:{slot:slot.id}});
  for(const key of ['price2','originalPrice2','originalPriceMax','badge'])if(row[key]!==undefined)n[key]=row[key];
  const rel=(bx,by,bw,bh)=>{const r={x:(bx*sx-cell.x)/cell.w,y:(by*sy-cell.y)/cell.h,w:bw*sx/cell.w,h:bh*sy/cell.h};
   r.x=Math.min(.99,Math.max(0,r.x));r.y=Math.min(.99,Math.max(0,r.y));r.w=Math.max(.01,Math.min(1-r.x,r.w));r.h=Math.max(.01,Math.min(1-r.y,r.h));return r;};
  const [ix,iy,iw,ih]=slot.imageBox,[tx,ty,tw,th]=slot.textBox,ns=slot.nameStyle&&!slot.nameStyle.error?slot.nameStyle:{};
  // 舊文字的左上角沿用原位；右邊界到價格牌左側為止（量得的右邊界易受商品圖干擾）。
  const ink=slot.priceFixed?slot.priceBox:fitPriceBox(slot,row.quantity,boxes);
  const left=Math.max(ns.left??tx,x+w*.04),top=ns.top??ty,right=ink&&ink[0]-w*.03>left+w*.2?ink[0]-w*.03:ns.right??tx+tw*.53;
  let size=((slot.rowFont||plan.single)&&Number.isFinite(ns.fontSize)?ns.fontSize:Number.isFinite(style.fontSize)?style.fontSize*(slot.scale||1):th*.12)*sy;
  // 價格在文字下方時（單品 POP），文字區不可伸入價格，放不下就自動縮字。
  const family=retailFonts.poster,width=(right-left)*sx,bottomLimit=ink&&ink[1]>top+size/sy*2?Math.min(y+h,ink[1]-h*.01):y+h;
  const lineHeight=(plan.single&&Number.isFinite(ns.lineHeight)?ns.lineHeight:style.lineHeight);
  let lines;
  for(let attempt=0;attempt<12;attempt++){
   lines=[['name',Math.max(1,lineCount(row.name,width,size,family,measure))],...(row.spec?[['spec',1]]:[]),...(row.originalPrice?[['original',1]]:[])];
   if(lines.reduce((sum,[,count])=>sum+count,0)*size*lineHeight/sy<=bottomLimit-top)break;
   size*=.92;
  }
  const pitch=size*lineHeight;
  n.regions={image:rel(ix,iy,iw,Math.max(1,ih))};let cursor=top;
  for(const [key,count] of lines){
   const height=Math.min(count*pitch/sy+1,Math.max(size/sy,bottomLimit-cursor));
   n.regions[key]=rel(left,cursor,right-left,height);cursor+=count*pitch/sy;
  }
  // 單品 POP 的價格右側通常留空：較長的新價格可用到 priceRoom，字不必縮小。
  const priceInk=ink&&slot.priceRoom?[ink[0],ink[1],Math.max(ink[2],slot.priceRoom/1.08),ink[3]]:ink;
  n.regions.price=ink?rel(...priceLayout(priceInk,row.quantity,[x,y,Math.max(w,(ink[0]+(slot.priceRoom||0))-x),h])):rel(tx+tw*.54,ty,tw*.46,th*.9);n.priceAutoFit=true;
  if(/^#[0-9a-f]{6}$/i.test(slot.priceColor||''))n.color=slot.priceColor;
  const text={size,color:style.color,lineHeight,font:'poster',autoFit:true,...(style.bold?{bold:true}:{})};
  n.textStyles={name:{...text},spec:{...text},original:{...text}};n.fontSize=size;
  separateImageFromText(n,measure);
  attachCampaignPictures(n,row,project.products);
  nodes.push(n);
 }
 const first=placed.find(p=>p.row.campaign)?.row||placed[0].row;
 project.campaign={name:first.campaign||'',start:first.start||'',end:first.end||'',stores:first.stores||''};
 const masks=plan.masks.flat().filter(Boolean).map(r=>{const x=Math.max(0,r.box[0]),y=Math.max(0,r.box[1]);
  return {id:uid(),x,y,w:Math.min(1-x,r.box[2]),h:Math.min(1-y,r.box[3]),color:/^#[0-9a-f]{6}$/i.test(r.color||'')?r.color:'#fff7e4'};});
 project.nodes.push(...nodes);project.posterReuse.masks.push(...masks);project.posterReuse.prepared=true;
 project.autoReplace={version:1,mode:plan.mode,blank:plan.blank||'',filename,slots:plan.pairs.map(p=>({slot:p.slot.id,row:p.row?.row??null,nodeId:nodes.find(n=>n.autoReplace.slot===p.slot.id)?.id||null})),ai:analysis.ai?.used?analysis.ai.deployment:'',warnings:plan.warnings};
 return nodes;
}

// AI 校對所需的「應有內容」：全部取自已套用的商品資料。
export function reviewPayload(project,image){
 const {w:W,h:H}=sizeInfo(project);
 const slots=project.nodes.filter(n=>n.type==='product'&&!n.imageOnly).map((n,i)=>{const o=offer(n);
  return {id:i+1,nodeId:n.id,box:[n.x/W,n.y/H,n.w/W,n.h/H],expected:{name:n.name,spec:n.spec||'',price:`$${o.main}`,...(o.bundle?{bundle:o.bundle,averageLabel:'平均每件'}:{}),...(n.originalPrice?{original:originalLabel(n),originalStruck:n.originalStrike!==false}:{})}};});
 return {image,slots};
}

// 預覽中修改的商品資料：與商品組件的檢查規則一致。
export function rowErrors(row){
 const errors=[],money=/^\d{1,7}(\.\d{1,2})?$/;
 if(!String(row.name||'').trim())errors.push('名稱必填');else if(row.name.length>100)errors.push('名稱最多 100 字');
 if(String(row.spec||'').length>100)errors.push('規格最多 100 字');
 if(!money.test(String(row.price))||Number(row.price)<=0)errors.push('優惠總價須為正數，最多兩位小數');
 if(!Number.isInteger(row.quantity)||row.quantity<1||row.quantity>99)errors.push('件數須為 1–99 的整數');
 if(row.originalPrice&&(!money.test(String(row.originalPrice))||Number(row.originalPrice)<=0))errors.push('原價須為正數，最多兩位小數');
 if(row.price2&&(row.code3||row.code4))errors.push('三至四件商品只支援共用優惠，請清除第二件獨立售價');
 if(row.price2&&(!money.test(String(row.price2))||Number(row.price2)<=0||!row.code2||row.quantity!==1))errors.push('第二件獨立售價須為正數、填 code2，件數須為 1');
 if(row.originalPrice2&&(!row.price2||!money.test(String(row.originalPrice2))||Number(row.originalPrice2)<=0))errors.push('第二件原價無效');
 if(!row.assetId)errors.push('請選擇商品圖片');
 for(const i of [2,3,4])if(row['code'+i]&&!row[i===2?'companion':'companion'+i]?.assetId)errors.push(`請選擇第${i}件商品圖片`);
 return errors;
}
