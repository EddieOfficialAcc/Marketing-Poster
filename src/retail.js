// Price arithmetic uses integer cents; display rounding never changes the offer.
export const retailFonts={sans:'"PingFang TC", "Microsoft JhengHei", sans-serif',serif:'"Songti TC", serif',price:'Arial, "Helvetica Neue", sans-serif',poster:'Arial, "Helvetica Neue", "PingFang TC", "Microsoft JhengHei", sans-serif'};
export const retailRegions={image:{x:0,y:0,w:1,h:.72},name:{x:0,y:.74,w:.53,h:.11},spec:{x:0,y:.85,w:.53,h:.06},original:{x:0,y:.92,w:.53,h:.06},price:{x:.55,y:.74,w:.45,h:.24}};
export function cents(value){const s=String(value??'').trim();return /^\d{1,7}(\.\d{1,2})?$/.test(s)?Math.round(Number(s)*100):null;}
export function cash(value){return (value/100).toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1');}
export function offer(node){
 const total=cents(node.price),quantity=node.quantity;
 if(!total||!Number.isInteger(quantity)||quantity<1)return {main:'待填',bundle:'',average:false};
 if(node.price2&&cents(node.price2)&&quantity===1){const values=[total,cents(node.price2)].sort((a,b)=>a-b);return {main:values[0]===values[1]?cash(values[0]):values.map(cash).join('–'),bundle:'',average:false};}
 const average=quantity>1,unit={integer:100,tenth:10,cent:1}[node.averageRounding||'tenth'];
 // A positive offer never displays as $0: round small averages up to one display unit.
 const value=average?Math.max(unit,Math.floor((total+quantity*unit/2)/(quantity*unit))*unit):total;
 return {main:cash(value),bundle:average?`$${cash(total)}/${quantity}件`:'',average};
}
export function originalLabel(node){
 const paired=node.price2&&node.originalPrice2?[cents(node.originalPrice),cents(node.originalPrice2)].sort((a,b)=>a-b):null;
 const min=paired?paired[0]:cents(node.originalPrice),max=paired?paired[1]:cents(node.originalPriceMax);
 return min?`$${cash(min)}${max&&max!==min?`–${cash(max)}`:''}`:'';
}
export function retailErrors(node){
 const errors=[];
 if(node.price2&&(!cents(node.price2)||node.quantity!==1||!Array.isArray(node.pictures)||node.pictures.length!==2||!node.pictures.some(p=>p.productId===node.price2ProductId)))errors.push('獨立售價須為正數，配兩件商品圖片及件數 1');
 if(node.originalPrice2&&(!node.price2||!cents(node.originalPrice2)||!cents(node.originalPrice)))errors.push('第二件原價須為正數，並填第一件原價及第二件售價');
 if(node.averageRounding!==undefined&&!['integer','tenth','cent'].includes(node.averageRounding))errors.push('平均單價取整規則無效');
 for(const key of ['originalPrice','originalPriceMax'])if(node[key] && (!cents(node[key])||cents(node[key])<=0))errors.push('原價須為正數、最多兩位小數');
 if(node.originalPriceMax&&(!node.originalPrice||cents(node.originalPriceMax)<cents(node.originalPrice)))errors.push('原價區間上限不可小於下限');
 if(node.regions){
  if(typeof node.regions!=='object'||Array.isArray(node.regions))errors.push('商品區域格式錯誤');
  else for(const [key,b] of Object.entries(node.regions))if(!retailRegions[key]||!b||!['x','y','w','h'].every(k=>Number.isFinite(b[k]))||b.x<0||b.y<0||b.w<=0||b.h<=0||b.x+b.w>1.00001||b.y+b.h>1.00001)errors.push('商品區域超出組件');
 }
 for(const [key,value] of Object.entries(node.textStyles||{})){
  if(!['name','spec','original'].includes(key)||!value||typeof value!=='object')errors.push('文字樣式格式錯誤');
  else if((value.size!==undefined&&(!Number.isFinite(value.size)||value.size<1||value.size>1000))||(value.color!==undefined&&!/^#[a-f\d]{6}$/i.test(value.color))||(value.font!==undefined&&!retailFonts[value.font])||(value.align!==undefined&&!['left','center','right'].includes(value.align))||(value.lineHeight!==undefined&&(!Number.isFinite(value.lineHeight)||value.lineHeight<1||value.lineHeight>2)))errors.push('文字樣式格式錯誤');
 }
 if(node.priceAutoFit!==undefined&&typeof node.priceAutoFit!=='boolean')errors.push('自動縮字設定無效');
 for(const style of Object.values(node.textStyles||{}))if(style?.autoFit!==undefined&&typeof style.autoFit!=='boolean')errors.push('自動縮字設定無效');
 if(node.badge!==undefined&&!['','新','熱賣','精選'].includes(node.badge))errors.push('促銷角標無效');
 return [...new Set(errors)];
}
export function defaultRegions(node){
 if(node.cardStyle==='retail')return retailRegions;
 const font=Math.min(node.fontSize,node.h*.052),price=Math.min(node.priceFontSize??42,node.priceFontSize?node.h*.4:node.h*.12),padding=Math.min(8,node.h*.02);
 const originalSpace=node.originalPrice?font*1.25:0;
 const image=Math.max(1,node.h-font*3.7-price*1.15-padding*2-originalSpace),base=(image+padding)/node.h;
 return {image:{x:0,y:0,w:1,h:image/node.h},name:{x:5/node.w,y:base,w:1-10/node.w,h:font*2.6/node.h},spec:{x:5/node.w,y:base+font*2.7/node.h,w:1-10/node.w,h:font/node.h},original:{x:5/node.w,y:base+font*3.95/node.h,w:1-10/node.w,h:font/node.h},price:{x:5/node.w,y:1-price*1.15/node.h,w:1-10/node.w,h:price*1.15/node.h}};
}
export function setRegionBox(node,key,box){
 const w=Math.max(.01,Math.min(1,box.w/node.w)),h=Math.max(.01,Math.min(1,box.h/node.h));
 node.regions||={};node.regions[key]={x:Math.max(0,Math.min(1-w,box.x/node.w)),y:Math.max(0,Math.min(1-h,box.y/node.h)),w,h};
}
export function region(node,key){
 const defaults=defaultRegions(node),b=node.regions?.[key]||defaults[key];
 const box={x:b.x*node.w,y:b.y*node.h,w:b.w*node.w,h:b.h*node.h};
 if(node.originalPrice&&['spec','original'].includes(key)){
  const s=node.regions?.spec||defaults.spec,o=node.regions?.original||defaults.original;
  if(s.x<o.x+o.w&&s.x+s.w>o.x&&s.y<o.y+o.h&&s.y+s.h>o.y){
   const top=Math.min(s.y,o.y)*node.h,bottom=Math.max(s.y+s.h,o.y+o.h)*node.h,gap=Math.min(3,(bottom-top)*.1),height=(bottom-top-gap)/2;
   box.y=key==='spec'?top:top+height+gap;box.h=height;
  }
 }

 if(['name','spec','original'].includes(key)){
  const p=node.regions?.price||defaults.price,price={x:p.x*node.w,y:p.y*node.h,w:p.w*node.w,h:p.h*node.h},gap=Math.max(3,node.w*.02);
  if(box.y<price.y+price.h&&box.y+box.h>price.y&&box.x<price.x+price.w&&box.x+box.w>price.x){
   const left=price.x-gap-box.x,right=box.x+box.w-price.x-price.w-gap;
   if(Math.max(left,right)>=node.w*.1){if(left>=right)box.w=left;else{box.x=price.x+price.w+gap;box.w=right;}}
  }
 }
 return box;
}
export function alignProductText(node){
 const image=region(node,'image'),top=Math.min(.76,(image.y+image.h)/node.h+.02),height=.98-top;
 node.regions||={};
 Object.assign(node.regions,{name:{x:.02,y:top,w:.49,h:height*.4},spec:{x:.02,y:top+height*.43,w:.49,h:height*.22},original:{x:.02,y:top+height*.73,w:.49,h:height*.22},price:{x:.55,y:top,w:.43,h:height}});
}

export function arrangeRetail(project,w,h){
 const nodes=project.nodes.filter(n=>n.type==='product'),counts=project.retailRows||[3,3,4];
 if(nodes.length>counts.reduce((a,b)=>a+b,0))throw new Error('商品超出模板格數，請增加每行格數');
 const weights=project.retailRowHeights||counts.map((_,i)=>i===2?.85:1),sum=weights.reduce((a,b)=>a+b,0);
 const left=w*.06,gap=w*.025,top=h*.18,available=h*.75-gap*(counts.length-1);
 let start=0,y=top;
 counts.forEach((count,row)=>{const cardW=(w-2*left-gap*(count-1))/count,cardH=available*weights[row]/sum;
  for(let col=0;col<count&&start<nodes.length;col++,start++){
   const n=nodes[start];if(n.locked)continue;
   const fontSize=n.cardStyle==='retail'&&n.w?n.fontSize*cardW/n.w:cardW*.047;
   Object.assign(n,{cardStyle:'retail',fontSize,x:left+col*(cardW+gap),y,w:cardW,h:cardH});
  }
  y+=cardH+gap;
 });
}
export function retailPageErrors(project){
 const rows=project.retailRows||[3,3,4],heights=project.retailRowHeights||rows.map(()=>1);
 if(!Array.isArray(rows)||!rows.length||rows.length>5||rows.some(n=>!Number.isInteger(n)||n<1||n>6)||!Array.isArray(heights)||heights.length!==rows.length||heights.some(n=>!Number.isFinite(n)||n<.2||n>3))return ['每行格數或行高設定無效'];
 return project.template==='retail'&&project.nodes.filter(n=>n.type==='product').length>rows.reduce((a,b)=>a+b,0)?['商品數量超過模板格數']:[];
}
// Both renderers consume identical measured primitives, including line breaks.
export function retailText(node,measure){
 if(node.imageOnly)return [];
 let part=null;const out=[],add=(value,box,size,color,weight=400,options={})=>{
  const family=retailFonts[options.font||'sans'],lineHeight=options.lineHeight||1.15;
  let font=size,rows=[];
  const wrap=()=>{rows=[];for(const line of String(value).split('\n')){let row='';for(const ch of line){if(row&&measure(row+ch,font,family,weight)>box.w){rows.push(row);row='';}row+=ch;}rows.push(row);}};
  wrap();while(options.autoFit!==false&&(rows.length*font*lineHeight>box.h||rows.some(t=>measure(t,font,family,weight)>box.w))&&font>1){font*=.95;wrap();}
  rows.forEach((line,i)=>{const width=measure(line,font,family,weight),x=box.x+(options.align==='right'?box.w-width:options.align==='center'?(box.w-width)/2:0);out.push({type:'text',part,clip:options.autoFit===false?null:{...box},text:line,x,y:box.y+i*font*lineHeight,size:font,color,weight,family,strike:options.strike});});
 };
 for(const [key,value] of [['name',node.name],['spec',node.spec],['original',originalLabel(node)]]){
  part=key;const style=node.textStyles?.[key]||{},box=region(node,key);
  if(key==='original'&&node.cardStyle!=='retail'&&!node.originalPrice)continue;
  add(value,box,style.size||(node.cardStyle==='retail'?(node.fontSize||node.w*.047):Math.min(node.fontSize,node.h*.052)*(key==='spec'?.8:1)),style.color||(key==='spec'?'#737769':'#343434'),style.bold?700:node.cardStyle!=='retail'&&key==='name'&&style.bold!==false?500:400,{...style,strike:key==='original'&&node.originalStrike});
 }
 part='price';
 const box=region(node,'price'),label=offer(node),color=node.color||'#f11926';
 const retail=node.cardStyle==='retail',totalCents=cents(node.price);
 const amount=retail||node.price2?label.main:(totalCents?cash(totalCents):'待填');
 const average=retail&&label.average;
 const desired=node.priceFontSize||(retail?box.h*.65:Math.min(42,node.h*.12));
 const big=node.priceAutoFit===false?desired:Math.min(desired,box.h*(average?.69:.85)),[integer,fraction]=amount.includes('–')?[amount,null]:amount.split('.');
 const runs=[{text:'$',size:big*.34,top:0},{text:integer,size:big,top:0},...(fraction?[{text:'.'+fraction,size:big*.47,top:big*.48}]:[])];
 if(!retail&&node.quantity>1)runs.push({text:` / ${node.quantity}件`,size:big*.34,top:big*.6,font:retailFonts.sans});
 const reserve=average?big*.35:0;
 const total=runs.reduce((sum,r)=>sum+measure(r.text,r.size,r.font||retailFonts.price,800),0)+reserve;
 const scale=node.priceAutoFit===false?1:Math.min(1,box.w/total),height=big*scale;
 let x=box.x;
 runs.forEach((r,i)=>{out.push({type:'text',part:'price',primary:i===1,text:r.text,x,y:box.y+r.top*scale,size:r.size*scale,color,weight:800,family:r.font||retailFonts.price});x+=measure(r.text,r.size,r.font||retailFonts.price,800)*scale;if(i===0)x+=reserve*scale;});
 if(average){add('平均\n每件',{x:box.x,y:box.y+height*.39,w:big*.52*scale,h:height*.61},big*.21*scale,color,800);const strip={x:box.x,y:box.y+box.h*.72,w:box.w,h:box.h*.28};out.push({type:'rect',part:'price',...strip,color});add(label.bundle,{x:strip.x+2,y:strip.y+strip.h*.06,w:strip.w-4,h:strip.h*.9},strip.h*.83,'#ffffff',800,{font:'sans',align:'center'});}
 if(node.badge){part=null;const s=node.w*.16;out.push({type:'rect',x:0,y:0,w:s,h:s*1.12,color:'#f11926'});add(node.badge,{x:2,y:2,w:s-4,h:s},s*.65,'#fff',800,{align:'center'});}
 return out;
}
export function canvasPrimitives(ctx,items){
 for(const p of items){ctx.fillStyle=p.color;if(p.type==='rect'){ctx.fillRect(p.x,p.y,p.w,p.h);continue;}
  ctx.save();if(p.clip){ctx.beginPath();ctx.rect(p.clip.x,p.clip.y,p.clip.w,p.clip.h);ctx.clip();}
  ctx.font=`${p.weight} ${p.size}px ${p.family}`;ctx.textBaseline='top';ctx.fillText(p.text,p.x,p.y);
  if(p.strike){ctx.strokeStyle=p.color;ctx.lineWidth=Math.max(.7,p.size*.05);ctx.beginPath();ctx.moveTo(p.x,p.y+p.size*.55);ctx.lineTo(p.x+ctx.measureText(p.text).width,p.y+p.size*.55);ctx.stroke();}
  ctx.restore();
 }
}
export function canvasMeasure(ctx){return (text,size,family,weight)=>{ctx.font=`${weight} ${size}px ${family}`;return ctx.measureText(text).width;};}
