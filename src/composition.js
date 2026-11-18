import {bestPictureLayout, imageRatio, productMetrics, imageRegion} from './auto-layout.js';
import { uid } from './model.js';

export function pictures(node) {
  return node.pictures || [{ id: `${node.id}-image`, productId: node.productId, x: 0, y: 0, w: 1, h: 1 }];
}
export function ensurePictures(node) { return node.pictures ||= pictures(node); }
export function layoutPictures(node, mode = 'side', assets = null) {
  const items = ensurePictures(node), count = items.length;
  node.pictureLayout = mode;
  if(mode==='overlap' && count>=2 && assets){
    const area=imageRegion(node);
    const bounds=items.map(p=>assets.find(a=>a.id===p.productId)?.imageBounds||{x:0,w:1});
    const heights=items.map((_,i)=>.87+.13*i/(count-1));
    const widths=items.map((p,i)=>imageRatio(assets.find(a=>a.id===p.productId))*heights[i]);
    const xs=[0];
    for(let i=1;i<count;i++){
      const previousRight=xs[i-1]+widths[i-1]*(bounds[i-1].x+bounds[i-1].w);
      const overlap=Math.min(widths[i-1]*bounds[i-1].w,widths[i]*bounds[i].w)*.18;
      xs.push(previousRight-overlap-widths[i]*bounds[i].x);
    }
    const minX=Math.min(...xs),span=Math.max(...xs.map((x,i)=>x+widths[i]))-minX;
    const scale=Math.min(area.w/span,area.h/1.08);
    const left=(area.w-span*scale)/2,top=(area.h-1.08*scale)/2;
    items.forEach((p,i)=>Object.assign(p,{
      x:(left+(xs[i]-minX)*scale)/area.w,
      y:(top+.08*i/(count-1)*scale)/area.h,
      w:widths[i]*scale/area.w,h:heights[i]*scale/area.h
    }));
    return;
  }
  items.forEach((p, i) => {
    if (count === 1) Object.assign(p, { x: 0, y: 0, w: 1, h: 1 });
    else if (mode === 'stack') Object.assign(p, { x: 0, y: i/count, w: 1, h: 1/count });
    else if (mode === 'side') Object.assign(p, { x: i/count, y: 0, w: 1/count, h: 1 });
    else Object.assign(p, { x: .32*i/(count-1), y: 0, w: .68, h: .85+.15*i/(count-1) });
  });
}
export function addPicture(node, productId) {
  if(node.price2)throw new Error('各自售價的組件只支援兩件商品；請先清除第二件售價再加圖片');
  const items = ensurePictures(node);
  if (items.length >= 6) throw new Error('每個商品組件最多 6 張圖片');
  items.push({ id: uid(), productId, x: 0, y: 0, w: 1, h: 1 });
  layoutPictures(node,node.pictureLayout==='overlap'||items.length===2?'overlap':'side');
  return items.at(-1).id;
}
export function movePicture(node, id, direction) {
  const items = ensurePictures(node), index = items.findIndex(p => p.id === id);
  if (index < 0) return;
  const next = Math.max(0, Math.min(items.length - 1, index + direction));
  const [item] = items.splice(index, 1); items.splice(next, 0, item);
}
export function mergeProducts(project, primaryId, otherId) {
  const primary=project.nodes.find(n=>n.id===primaryId), other=project.nodes.find(n=>n.id===otherId);
  if(!primary || !other || primary===other || primary.type!=='product' || other.type!=='product') throw new Error('請選擇另一個商品組件');
  if(pictures(primary).length+pictures(other).length>6) throw new Error('合併後不可超過 6 張圖片');
  // Keep the primary metadata, but never silently reuse a price for a new offer.
  primary.pictures=[...pictures(primary),...pictures(other).map(p=>({...p,id:uid()}))];
  delete primary.price2;delete primary.originalPrice2;delete primary.price2ProductId;delete primary.groupCodes;
  primary.quantity=Math.min(99,primary.quantity+other.quantity);primary.price='';
  project.nodes=project.nodes.filter(n=>n.id!==otherId);layoutPictures(primary);
  return primary;
}

// Picture array order is the paint order in both Canvas and Fabric renderers.
export function cycleOverlap(node) {
  const items=ensurePictures(node);
  if(items.length<2)return;
  const legacyOverlap=!node.pictureLayout&&items.some((a,i)=>items.slice(i+1).some(b=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y));
  if(node.pictureLayout==='overlap'||legacyOverlap){
    items.push(items.shift());
    node.pictureLayout='overlap';
  }else layoutPictures(node,'overlap');
}

export function autoLayoutPictures(node, assets) {
  if(pictures(node).length===2||node.pictureLayout==='overlap'){layoutPictures(node,'overlap',assets);return;}
  layoutPictures(node,bestPictureLayout(node,assets));
  const items=ensurePictures(node),count=items.length;
  if(count<2)return;
  const gap=.04,span=(1-gap*(count-1))/count;
  items.forEach((p,i)=>Object.assign(p,node.pictureLayout==='stack'
    ?{x:0,y:i*(span+gap),w:1,h:span}
    :{x:i*(span+gap),y:0,w:span,h:1}));
}

export function removePicture(node,id) {
  const items=ensurePictures(node),index=items.findIndex(p=>p.id===id);
  if(index<0)return false;
  if(items.length===1)throw new Error('最後一張圖片請刪除整個商品組件');
  if(node.price2){
    const remaining=items.find(p=>p.id!==id);
    if(remaining.productId===node.price2ProductId){node.price=node.price2;node.originalPrice=node.originalPrice2||'';node.sku=node.groupCodes?.[1]||node.sku;}
    delete node.price2;delete node.originalPrice2;delete node.price2ProductId;delete node.originalPriceMax;delete node.groupCodes;
  }
  items.splice(index,1);node.productId=items[0].productId;
  if(items.length===1)layoutPictures(node,'side');
  return true;
}
export function pictureAt(node,point,assets) {
  if(node.type!=='product')return null;
  const box=imageRegion(node),areaH=box.h;
  for(const pic of [...pictures(node)].reverse()){
    const ratio=imageRatio(assets.find(a=>a.id===pic.productId));
    const height=Math.min(pic.h*areaH,pic.w*box.w/ratio),width=height*ratio;
    const x=node.x+box.x+pic.x*box.w+(pic.w*box.w-width)/2,y=node.y+box.y+(pic.y+pic.h)*areaH-height;
    if(point.x>=x&&point.x<=x+width&&point.y>=y&&point.y<=y+height)return pic.id;
  }
  return null;
}
