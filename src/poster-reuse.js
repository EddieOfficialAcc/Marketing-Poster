import {imageRegion} from './auto-layout.js';
import {region,cents} from './retail.js';
import {validPriceTag,priceTagLabel} from './price-tag.js';
import {productNode,uid} from './model.js';
import {backgroundBox} from './sizing.js';

// Masks use fractions of the original image, independent of movable product layers.
export function validPosterReuse(value){
 return value && typeof value==='object' && Number.isFinite(value.width)&&value.width>0&&Number.isFinite(value.height)&&value.height>0&&
 Array.isArray(value.masks)&&value.masks.length<=100&&value.masks.every(m=>m&&typeof m.id==='string'&&/^#[0-9a-f]{6}$/i.test(m.color)&&
 ['x','y','w','h'].every(k=>Number.isFinite(m[k]))&&m.x>=0&&m.y>=0&&m.w>0&&m.h>0&&m.x+m.w<=1.000001&&m.y+m.h<=1.000001);
}
export function posterMasks(project){
 if(project.template!=='custom'||!validPosterReuse(project.posterReuse))return [];
 const p=project.posterReuse,b=backgroundBox(project,p.width,p.height);
 return p.masks.map(m=>({...m,x:b.x+m.x*b.w,y:b.y+m.y*b.h,w:m.w*b.w,h:m.h*b.h}));
}
// Round only the paint geometry outward. Stored masks and selection coordinates
// remain exact; adjacent fractional rectangles must not expose the old poster.
export function paintedPosterMasks(project){
 return posterMasks(project).map(m=>{
  const x=Math.floor(m.x),y=Math.floor(m.y);
  return {...m,x,y,w:Math.ceil(m.x+m.w)-x,h:Math.ceil(m.y+m.h)-y};
 });
}
export function selectionBox(a,b){
 const clamp=v=>Math.max(0,Math.min(1,v));
 const x=Math.min(clamp(a.x),clamp(b.x)),y=Math.min(clamp(a.y),clamp(b.y));
 return {x,y,w:Math.abs(clamp(a.x)-clamp(b.x)),h:Math.abs(clamp(a.y)-clamp(b.y))};
}
export function replacePosterProduct(project,maskId,assetId,mode='image'){
 const mask=project.posterReuse?.masks.find(m=>m.id===maskId),asset=project.products.find(p=>p.id===assetId);
 if(!mask||!asset)throw new Error('請先框選區域並選擇商品素材');
 if(!['image','product'].includes(mode))throw new Error('請選擇替換方式');
 const box=posterMasks(project).find(m=>m.id===maskId);
 let existing=project.nodes.find(n=>n.id===mask.nodeId&&n.type==='product');
 if(!existing){const candidates=project.nodes.filter(n=>n.type==='product').map(n=>{const b=imageRegion(n);return {n,score:overlapRatio(box,{x:n.x+b.x,y:n.y+b.y,w:b.w,h:b.h})};}).filter(v=>v.score>.65).sort((a,b)=>b.score-a.score);existing=candidates[0]?.n;}
 if(existing&&mode==='image'){
  if(existing.locked)throw new Error('請先解除此商品鎖定');
  existing.productId=asset.id;existing.pictures=[{id:uid(),productId:asset.id,x:0,y:0,w:1,h:1}];existing.shadow=0;
  if(existing.pdfOcr)existing.pdfReview=false;mask.nodeId=existing.id;return existing;
 }
 if(existing){
  if(existing.locked)throw new Error('請先解除此商品鎖定');
  mask.nodeId=existing.id;existing.imageOnly=false;
  Object.assign(existing,{productId:asset.id,name:asset.name,sku:asset.sku||'',spec:asset.spec||'',price:'',quantity:1,shadow:0});
  if(existing.pdfOcr)existing.pdfReview=false;
  existing.pictures=[{id:uid(),productId:asset.id,x:0,y:0,w:1,h:1}];
  for(const k of ['originalPrice','originalPriceMax','importedOffer','badge'])delete existing[k];
  return existing;
 }
 if(project.nodes.length>=100)throw new Error('最多 100 個元素');
 if(box.w<20||box.h<(mode==='image'?20:100))throw new Error('商品區域太小，請框選完整的圖片、名稱、規格及價格；純文字可只遮蓋再新增文字');
 const node=productNode(asset);Object.assign(node,{x:box.x,y:box.y,w:box.w,h:box.h,imageOnly:mode==='image',shadow:0,fontSize:Math.max(8,Math.min(24,box.w/12,box.h/18))});
 project.nodes.push(node);mask.nodeId=node.id;return node;
}

// 框邊像素的中位色作為遮蓋顏色，避開框內文字或商品。
export function borderColor(rgba,width,height){
 const values=[[],[],[]],add=(x,y)=>{const i=(y*width+x)*4;if(rgba[i+3]<128)return;for(let k=0;k<3;k++)values[k].push(rgba[i+k]);};
 for(let x=0;x<width;x++){add(x,0);if(height>1)add(x,height-1);}
 for(let y=1;y<height-1;y++){add(0,y);if(width>1)add(width-1,y);}
 if(!values[0].length)return null;
 return '#'+values.map(list=>list.sort((a,b)=>a-b)[list.length>>1].toString(16).padStart(2,'0')).join('');
}
export function maskAt(masks,point){
 return [...masks].reverse().find(m=>point.x>=m.x&&point.x<=m.x+m.w&&point.y>=m.y&&point.y<=m.y+m.h)||null;
}
export function cropPixelBox(box,width,height){
 if(!box||!['x','y','w','h'].every(k=>Number.isFinite(box[k]))||box.w<=0||box.h<=0||box.x<0||box.y<0||box.x+box.w>1.000001||box.y+box.h>1.000001)throw new Error('請在底圖內框選商品圖片');
 const x=Math.floor(box.x*width),y=Math.floor(box.y*height);
 const w=Math.min(width,Math.ceil((box.x+box.w)*width))-x,h=Math.min(height,Math.ceil((box.y+box.h)*height))-y;
 if(w<8||h<8)throw new Error('選取圖片太小，請重新框選');
 return {x,y,w,h};
}
export function addExtractedProduct(project,maskId,asset,mode='image'){
 if(project.products.length>=100)throw new Error('最多 100 張商品素材');
 project.products.push(asset);
 try{return replacePosterProduct(project,maskId,asset.id,mode);}
 catch(error){project.products.pop();throw error;}
}

function overlapRatio(a,b){
 const area=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
 return area/Math.max(1,Math.max(a.w*a.h,b.w*b.h));
}
// 價格牌：框住已有商品的價格欄時直接改該商品；否則建立（或更新）沿用商品卡價格排版的價格牌。
export function replacePosterPrice(project,maskId,tag,color=null){
 const mask=project.posterReuse?.masks.find(m=>m.id===maskId),box=posterMasks(project).find(m=>m.id===maskId);
 if(!mask||!box)throw new Error('請先框選舊價格牌');
 const value={price:String(tag?.price??'').trim().replace(/^[$＄]\s*/,''),quantity:Number(tag?.quantity)};
 if(!validPriceTag(value))throw new Error('總價請填正數金額（最多兩位小數），件數 1–99');
 value.price=String(cents(value.price)/100);
 const linked=project.nodes.find(n=>n.id===mask.textNodeId&&n.type==='text');
 if(linked){if(linked.locked)throw new Error('請先解除文字鎖定');Object.assign(linked,{priceTag:value,text:priceTagLabel(value)});if(/^#[0-9a-f]{6}$/i.test(color||''))linked.color=color;return linked;}
 for(const n of project.nodes){
  if(n.type!=='product'||n.imageOnly)continue;
  const b=region(n,'price');if(overlapRatio(box,{x:n.x+b.x,y:n.y+b.y,w:b.w,h:b.h})<.5)continue;
  if(n.locked)throw new Error('請先解除此商品鎖定');
  n.price=value.price;n.quantity=value.quantity;if(n.pdfOcr)n.pdfReview=false;return n;
 }
 if(project.nodes.length>=100)throw new Error('最多 100 個元素');
 const node={id:uid(),type:'text',text:priceTagLabel(value),priceTag:value,x:box.x,y:box.y,w:Math.max(8,box.w),h:Math.max(8,box.h),fontSize:Math.max(1,Math.min(1000,box.h*.2)),color:/^#[0-9a-f]{6}$/i.test(color||'')?color:'#f11926',shadow:0,autoFit:true};
 project.nodes.push(node);mask.textNodeId=node.id;return node;
}
// 識別框只對應舊文字所佔行數；新文字多於一行時改用整個框選區域，並按行數收細字號。
function textGeometry(box,text,style){
 const rows=text.split('\n').length,recognized=Math.max(1,Number(style?.rows)||1),lineHeight=textLineHeight(style);
 // 行數不多於識別結果時沿用原文字位置；否則改用整個框選區域。
 const layout=rows<=recognized&&style?.box,position=layout?{x:box.x+layout.x*box.w,y:box.y+layout.y*box.h,w:layout.w*box.w,h:layout.h*box.h}:{...box};
 // 編輯器字體與原海報字形寬度略有不同；按對齊方向把寬度放到框選邊界，避免多出換行。
 if(layout){const align=style.align,right=box.x+box.w,end=position.x+position.w;
  if(align==='right'){position.w=end-box.x;position.x=box.x;}
  else if(align==='center'){const margin=Math.min(position.x-box.x,right-end);position.x-=margin;position.w+=margin*2;}
  else position.w=right-position.x;}
 const ratio=Number(style?.fontSizeRatio),base=ratio>0?box.h*ratio:box.h*.65,room=box.y+box.h-position.y,fontSize=Math.max(1,Math.min(1000,base,room/(rows*lineHeight)));
 // 識別框只包住字形墨跡，高度需容納完整行距。
 return {x:position.x,y:position.y,w:Math.max(8,position.w),h:Math.max(8,Math.min(room,Math.max(position.h,rows*fontSize*lineHeight))),fontSize};
}
function textLineHeight(style){const value=Number(style?.lineHeight);return value>=1&&value<=2.5?value:1.3;}
function textLayout(style){
 const weight=Number(style?.weight);
 // 有識別結果時用海報字體（英數 Arial），較貼近舊海報。
 return {align:['left','center','right'].includes(style?.align)?style.align:'left',weight:[300,400,500,600,700].includes(weight)?weight:600,lineHeight:textLineHeight(style),...(style?.fontSizeRatio?{font:'poster'}:{})};
}
export function replacePosterText(project,maskId,text,style=null){
 const mask=project.posterReuse?.masks.find(m=>m.id===maskId),box=posterMasks(project).find(m=>m.id===maskId);
 if(!mask||!box||!text.trim()||text.length>500)throw new Error('請先框選舊文字，並輸入新文字（最多 500 字）');
 const linked=project.nodes.find(n=>n.id===mask.textNodeId&&n.type==='text');
 if(linked){if(linked.locked)throw new Error('請先解除文字鎖定');delete linked.priceTag;linked.text=text;if(style)Object.assign(linked,textGeometry(box,text,style),{color:/^#[0-9a-f]{6}$/i.test(style.color||'')?style.color:linked.color,textLayout:textLayout(style)});return linked;}
 for(const n of project.nodes){
  if(n.type!=='product'||n.imageOnly)continue;
  for(const field of ['name','spec','price','original']){
   const b=region(n,field),absolute={x:n.x+b.x,y:n.y+b.y,w:b.w,h:b.h};
   if(overlapRatio(box,absolute)<.5)continue;
   if(n.locked)throw new Error('請先解除此商品鎖定');
   const key={original:'originalPrice'}[field]||field;
   let value=text.trim();if(['price','originalPrice'].includes(key)){value=value.replace(/^[$＄]\s*/,'');if(!/^\d{1,7}(\.\d{1,2})?$/.test(value)||Number(value)<=0)throw new Error('價格請填正數金額；件數請在商品價格頁修改');}
   if(value.length>100)throw new Error('商品文字最多 100 字');
   n[key]=value;if(n.pdfOcr)n.pdfReview=false;return n;
  }
 }
 if(project.nodes.length>=100)throw new Error('最多 100 個元素');
 const node={id:uid(),type:'text',text,...textGeometry(box,text,style),color:/^#[0-9a-f]{6}$/i.test(style?.color||'')?style.color:'#343434',textLayout:textLayout(style),shadow:0,autoFit:true};
 project.nodes.push(node);mask.textNodeId=node.id;return node;
}
