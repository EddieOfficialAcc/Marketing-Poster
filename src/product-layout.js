import {retailFonts,originalLabel,offer,defaultRegions,retailText,region} from './retail.js';
import {requestedFontSize} from './font-settings.js';
// Rebuild layout from text metrics; never reuse coordinates from another mode.
export function applyProductLayout(node,measure,style=node.cardStyle||'classic'){
 if(!['classic','retail'].includes(style))throw new Error('商品排版無效');
 const probe={...node,cardStyle:style,regions:undefined},side=style==='retail',gap=Math.max(4,node.h*.018),pad=node.w*.02;
 const textWidth=node.w*(side?.49:.96),priceWidth=node.w*(side?.43:.96);
 function height(value,width,size,font,weight,lineHeight=1.15){
  if(!value)return 0;let count=0;
  for(const line of String(value).split('\n')){let row='';count++;for(const ch of line){if(row&&measure(row+ch,size,font,weight)>width){count++;row='';}row+=ch;}}
  return count*size*lineHeight+Math.max(2,size*.05);
 }
 const text={};
 for(const [key,value] of [['name',node.name],['spec',node.spec],['original',originalLabel(node)]]){
  const setting=node.textStyles?.[key]||{},size=requestedFontSize(probe,key);
  text[key]=height(value,textWidth,size,retailFonts[setting.font||'sans'],setting.bold?700:400,setting.lineHeight||1.15);
 }
 const priceSize=node.priceFontSize??(side?node.h*.24*.65:Math.min(42,node.h*.12)),label=offer(node);
 const priceHeight=side?priceSize*(label.average?1.65:1.2):height(label.bundle||('$'+label.main),priceWidth,priceSize,retailFonts.price,800);
 const textHeight=Object.values(text).reduce((a,b)=>a+b,0)+gap*(Object.values(text).filter(Boolean).length-1);
 const needed=side?Math.max(textHeight,priceHeight):textHeight+gap+priceHeight;
 // Keep at least a small usable image area. Impossible font sizes are reported,
 // rather than storing overlapping or out-of-bounds regions.
 const imageHeight=Math.min(defaultRegions(probe).image.h*node.h,node.h-pad*2-gap-needed);
 if(imageHeight<node.h*.12)throw new Error('目前字號及文字超出商品組可用空間，請增加商品組高度／寬度或減小字號');
 const regions={},put=(key,x,y,w,h)=>regions[key]={x:x/node.w,y:y/node.h,w:w/node.w,h:Math.max(1,h)/node.h};
 put('image',0,0,node.w,imageHeight);
 const top=imageHeight+gap;let y=top;
 for(const key of ['name','spec','original']){put(key,pad,y,textWidth,text[key]||1);if(text[key])y+=text[key]+gap;}
 put('price',side?node.w*.55:pad,side?top:y,priceWidth,priceHeight);
 // Preserve the requested size when switching mode (new default area heights
 // must not secretly become a different price size).
 node.cardStyle=style;node.regions=regions;node.priceFontSize=priceSize;
 return regions;
}

// Detect painted text collisions, not merely intersections of empty edit boxes.
export function overlappingText(node,measure){
 const items=retailText(node,measure).filter(p=>p.type==='text'&&p.part&&p.text.trim()).map(p=>({part:p.part,x:p.x,y:p.y,w:measure(p.text,p.size,p.family,p.weight),h:p.size*1.15}));
 const pairs=[];
 for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
  const a=items[i],b=items[j];
  if(a.part!==b.part&&a.x<b.x+b.w-.5&&a.x+a.w>b.x+.5&&a.y<b.y+b.h-.5&&a.y+a.h>b.y+.5)pairs.push([a.part,b.part]);
 }
 return pairs;
}
export function repairProjectText(project,measure){
 const repaired=[],unresolved=[];
 for(const node of project.nodes.filter(n=>n.type==='product')){
  if(!overlappingText(node,measure).length)continue;
  if(node.locked){unresolved.push(node.id);continue;}
  const candidate=structuredClone(node);
  try{applyProductLayout(candidate,measure);if(overlappingText(candidate,measure).length)throw new Error('排版空間不足');Object.assign(node,candidate);repaired.push(node.id);}
  catch{unresolved.push(node.id);}
 }
 return {repaired,unresolved};
}

// Imported photo boxes may extend below the old name baseline. Keep actual
// painted text clear without moving prices or changing the requested font sizes.
export function separateImageFromText(node,measure){
 if(node.imageOnly)return false;
 const image=region(node,'image'),gap=Math.max(4,node.h*.018);
 // Badge text (part null) sits inside the image by design, so it does not count as overlapping text.
 const text=retailText(node,measure).filter(p=>p.type==='text'&&p.part&&p.text.trim()&&p.x<image.x+image.w&&p.x+measure(p.text,p.size,p.family,p.weight)>image.x);
 const top=Math.min(...text.map(p=>p.y));
 if(!Number.isFinite(top)||image.y+image.h<=top-gap+.01)return false;
 const height=top-gap-image.y;
 if(height<node.h*.12){applyProductLayout(node,measure);return true;}
 node.regions={...node.regions,image:{x:image.x/node.w,y:image.y/node.h,w:image.w/node.w,h:height/node.h}};
 return true;
}
