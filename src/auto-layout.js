import {arrangeRetail,region} from './retail.js';
import {cleanTemplateElements} from './template-layout.js';
import {sizeInfo} from './sizing.js';

export function imageRatio(asset) {
  const ratio=Number(asset?.imageWidth)/Number(asset?.imageHeight);
  return Number.isFinite(ratio)&&ratio>0?Math.max(.15,Math.min(6,ratio)):.8;
}
export function productMetrics(h,fontSize=20,priceFontSize) {
  const font=Math.min(fontSize,h*.052),priceSize=Number.isFinite(priceFontSize)?Math.max(1,Math.min(priceFontSize,h*.4)):Math.min(42,h*.12);
  const padding=Math.min(8,h*.02);
  return {font,priceSize,padding,imageHeight:Math.max(1,h-font*3.7-priceSize*1.15-padding*2)};
}
export function imageRegion(node){if(node.imageOnly)return {x:0,y:0,w:node.w,h:node.h};return node.cardStyle==='retail'||node.regions?.image||node.originalPrice?region(node,'image'):{x:0,y:0,w:node.w,h:productMetrics(node.h,node.fontSize,node.priceFontSize).imageHeight};}
const imageAreaHeight=h=>productMetrics(h).imageHeight;
function scorePictures(ratios,w,h,mode) {
  const count=ratios.length,gap=.04;
  const bw=mode==='side'?(1-gap*(count-1))/count:1;
  const bh=mode==='stack'?(1-gap*(count-1))/count:1;
  return ratios.reduce((sum,r)=>{
    const height=Math.min(h*bh,w*bw/r);
    return sum+height*height*r;
  },0);
}
export function bestPictureLayout(node,assets) {
  const ratios=(node.pictures||[{productId:node.productId}]).map(p=>imageRatio(assets.find(a=>a.id===p.productId)));
  return scorePictures(ratios,node.w,imageAreaHeight(node.h),'stack')>scorePictures(ratios,node.w,imageAreaHeight(node.h),'side')?'stack':'side';
}

// Score real contained image area, with room for offer text and a penalty for
// empty grid cells. Never change the offer fields or non-product elements.
export function arrangeProducts(project) {
  const nodes=project.nodes.filter(n=>n.type==='product');if(!nodes.length)return;
  const {w,h}=sizeInfo(project),member=project.template==='membership';
  if(project.template==='retail'){arrangeRetail(project,w,h);return;}
  const left=w*(member?.019:.045),top=h*(member?.17:.16);
  const areaW=w-2*left,gap=Math.min(w,h)*.018;
  const footer=project.template==='clean'?cleanTemplateElements(project).filter(e=>e.type==='rect').at(-1).y:h;
  const areaH=Math.max(1,Math.min(h*(member?.54:.76),footer-top-gap));
  let best=null;
  const choices=member&&nodes.length<=8?[4]:Array.from({length:nodes.length},(_,i)=>i+1);
  for(const cols of choices){
    const rows=member&&nodes.length<=8?2:Math.ceil(nodes.length/cols);
    const cellW=(areaW-gap*(cols-1))/cols,cellH=(areaH-gap*(rows-1))/rows;
    if(cellW<=0||cellH<=0)continue;
    // A lone product is a feature card, not a full-page stretched image.
    const cardW=Math.min(cellW,w*(nodes.length===1?.62:.48));
    const cardH=Math.min(cellH,h*(nodes.length===1?.55:.43),cardW*1.7);
    let score=0;
    for(const node of nodes){
      const ratios=(node.pictures||[{productId:node.productId}]).map(p=>imageRatio(project.products.find(a=>a.id===p.productId)));
      const a=imageAreaHeight(cardH);
      score+=Math.max(scorePictures(ratios,cardW,a,'side'),scorePictures(ratios,cardW,a,'stack'));
    }
    score*=nodes.length/(rows*cols);
    if(!best||score>best.score)best={cols,rows,cellW,cellH,cardW,cardH,score};
  }
  const {cols,cellW,cellH,cardW,cardH}=best;
  nodes.forEach((node,i)=>{
    if(node.locked)return;
    const row=Math.floor(i/cols),inRow=Math.min(cols,nodes.length-row*cols);
    const offset=member?0:(cols-inRow)*(cellW+gap)/2;
    Object.assign(node,{x:left+offset+(i%cols)*(cellW+gap)+(cellW-cardW)/2,
      y:top+row*(cellH+gap),w:cardW,h:cardH,fontSize:Math.max(8,Math.min(24*w/900,cardW*.075,cardH*.065))});  // caps are for a 900-unit-wide canvas
  });
}
