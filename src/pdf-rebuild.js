import {uid,productNode} from './model.js';
import {sizeInfo} from './sizing.js';

export function applyPdfReconstruction(project,result){
 if(result?.version!==1||!Array.isArray(result.products)||result.products.length>20||!Number.isFinite(result.pageWidth)||result.pageWidth<=0||!Number.isFinite(result.pageHeight)||result.pageHeight<=0||!result.products.every(p=>Array.isArray(p?.images)))throw new Error('PDF 重建資料無效');
 const count=result.products.reduce((n,p)=>n+p.images.length,0);
 if(project.products.length+count>100)throw new Error('商品素材將超過 100 張，請先清理素材庫再重新導入');
 const {w,h}=sizeInfo(project),sx=w/result.pageWidth,sy=h/result.pageHeight;
 const assets=[],nodes=[],masks=[];
 for(const [index,source] of result.products.entries()){
  if(!Array.isArray(source.images)||!source.images.length||source.images.length>6)throw new Error('商品分組圖片數量無效');
  const groupAssets=source.images.map((im,i)=>({id:uid(),name:source.name,sku:'',spec:source.spec||'',imageUrl:im.imageUrl,source:'pdf-extract',filename:`PDF-商品${index+1}-${i+1}.png`,aliases:[]}));
  const n=productNode(groupAssets[0]);const [x,y,width,height]=source.box;
  Object.assign(n,{x:x*sx,y:y*sy,w:width*sx,h:height*sy,name:source.name,spec:source.spec||'',price:source.price||'',quantity:source.quantity||1,originalPrice:source.originalPrice||'',cardStyle:'retail',shadow:0,averageRounding:'tenth',pdfReview:false,pdfOcr:source.ocr});
  const [ix,iy,iw,ih]=source.imageBox,[tx,ty,tw,th]=source.textBox;
  const box=(a,b,c,d)=>({x:(a-x)/width,y:(b-y)/height,w:c/width,h:d/height});
  n.regions={image:box(ix,iy,iw,ih),name:box(tx,ty,tw*.51,th*.47),spec:box(tx,ty+th*.49,tw*.51,th*.22),original:box(tx,ty+th*.73,tw*.51,th*.23),price:box(tx+tw*.54,ty,tw*.46,th*.98)};
  n.fontSize=Math.max(8,th*sy*.16);n.priceFontSize=Math.max(14,th*sy*.57);n.priceAutoFit=true;
  n.textStyles={name:{size:n.fontSize,autoFit:true},spec:{size:n.fontSize,autoFit:true},original:{size:n.fontSize*.9,autoFit:true}};
  n.pictures=source.images.map((im,i)=>({id:uid(),productId:groupAssets[i].id,x:(im.box[0]-ix)/iw,y:(im.box[1]-iy)/ih,w:im.box[2]/iw,h:im.box[3]/ih}));
  const r=result.regions[index];if(!r)throw new Error('缺少商品底圖清理區');
  masks.push({id:uid(),x:r.box[0],y:r.box[1],w:r.box[2],h:r.box[3],color:r.color,nodeId:n.id});
  assets.push(...groupAssets);nodes.push(n);
 }
 project.products.push(...assets);project.nodes.push(...nodes);project.posterReuse.masks=masks;project.posterReuse.prepared=!!masks.length;
 project.pdfImport={version:1,backgroundId:project.backgroundId,productCount:nodes.length,imageCount:assets.length,warnings:result.warnings||[]};
 return project;
}
