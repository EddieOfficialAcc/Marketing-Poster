import test from 'node:test';
import assert from 'node:assert/strict';
import {offer,originalLabel,retailErrors,retailText,region,retailPageErrors} from '../src/retail.js';
import {arrangeProducts,imageRegion} from '../src/auto-layout.js';
import {defaultProject,productNode,parseBackup} from '../src/model.js';
import {EditorHistory,alignNodes,snapPosition} from '../src/editor-history.js';
import {applyCampaign} from '../src/campaign-import.js';
const measure=(text,size)=>[...text].reduce((w,c)=>w+(c.charCodeAt(0)>255?1:.6)*size,0);
const asset={id:'rice',name:'Rice',sku:'',spec:'100g',imageUrl:'data:image/png;base64,iVBORw0KGgo='};
function project(count=10){const p=defaultProject();p.template='retail';p.products=[asset];p.nodes=Array.from({length:count},()=>({...productNode(asset),price:'39.9',quantity:2}));return p;}
test('reference rounding rules preserve the total and quantity',()=>{
 for(const [price,quantity,averageRounding,main] of [['39.9',2,'integer','20'],['19.9',2,'integer','10'],['23',3,'tenth','7.7'],['55',2,'tenth','27.5'],['1',3,'cent','0.33']]){
  const n={price,quantity,averageRounding};assert.equal(offer(n).main,main);assert.equal(offer(n).bundle,`$${price}/${quantity}件`);assert.equal(n.price,price);
 }
 assert.equal(offer({price:'62.9',quantity:1}).main,'62.9');assert.equal(offer({price:'',quantity:2}).main,'待填');
});
test('3+3+4 slots stay within the product area at A3 and A4 sizes',()=>{
 for(const [width,height] of [[297,420],[210,297]]){const p=project();p.page={width,height,unit:'mm',dpi:300};arrangeProducts(p);assert.equal(p.nodes[0].y,p.nodes[2].y);assert.equal(p.nodes[3].y,p.nodes[5].y);assert.equal(p.nodes[6].y,p.nodes[9].y);assert.ok(p.nodes[6].w<p.nodes[0].w);for(const n of p.nodes){assert.equal(n.cardStyle,'retail');assert.ok(n.x+n.w<=Math.round(width*300/25.4)/2);assert.ok(n.y+n.h<Math.round(height*300/25.4)/2*.946);}}
});
test('changing a retail price size leaves the image region unchanged',()=>{const p=project(1);arrangeProducts(p);const n=p.nodes[0],before=imageRegion(n);n.priceFontSize=300;assert.deepEqual(imageRegion(n),before);n.regions={price:{x:.4,y:.8,w:.6,h:.2}};assert.deepEqual(imageRegion(n),before);assert.equal(region(n,'price').x,n.w*.4);});
test('retail backup round trip retains pricing, typography and independent regions',()=>{const p=project(1);arrangeProducts(p);Object.assign(p.nodes[0],{originalPrice:'29.9',originalPriceMax:'33',originalStrike:true,averageRounding:'integer',textStyles:{name:{size:12,color:'#112233',align:'right',font:'sans',lineHeight:1.3}},regions:{price:{x:.5,y:.7,w:.5,h:.3}}});const restored=parseBackup(JSON.stringify(p));assert.deepEqual(restored.nodes,p.nodes);assert.equal(originalLabel(restored.nodes[0]),'$29.9–33');assert.throws(()=>parseBackup(JSON.stringify({...p,nodes:[{...p.nodes[0],originalPriceMax:'20'}]})),/原價區間/);});
test('malformed or overflowing retail fields cannot be imported',()=>{assert.ok(retailErrors({regions:{price:{x:.9,y:0,w:.5,h:1}}}).length);assert.ok(retailErrors({averageRounding:'floor'}).length);assert.ok(retailErrors({textStyles:{name:{size:NaN}}}).length);assert.ok(retailPageErrors({...project(),retailRows:[0]}).length);assert.ok(retailPageErrors(project(11)).length);});
test('text primitives contain multi-size digits, original strike and a white-on-red bundle',()=>{const p=project(1);arrangeProducts(p);const n={...p.nodes[0],originalPrice:'23',originalStrike:true,badge:'新',averageRounding:'integer'};const scene=retailText(n,measure);assert.ok(scene.some(p=>p.text==='20'));assert.ok(scene.some(p=>p.text==='$39.9/2件'&&p.color==='#ffffff'));assert.ok(scene.some(p=>p.text==='$23'&&p.strike));for(const s of scene){assert.ok(Number.isFinite(s.x)&&Number.isFinite(s.y));if(s.type==='text')assert.ok(s.size>0);}});
test('locked cards keep their positions during layout and alignment',()=>{const p=project();p.nodes[0].locked=true;const first=structuredClone(p.nodes[0]);arrangeProducts(p);alignNodes(p.nodes,'left');assert.deepEqual(p.nodes[0],first);});
test('undo/redo preserve monotonic revision and revoke approval',()=>{const p=project(1),history=new EditorHistory();history.reset(p);p.nodes[0].price='55';history.record(p);p.revision=7;p.reviewedRevision=7;const undo=history.travel('undo',p);assert.equal(undo.nodes[0].price,'39.9');assert.equal(undo.revision,7);assert.equal(undo.reviewedRevision,null);const redo=history.travel('redo',undo);assert.equal(redo.nodes[0].price,'55');});
test('alignment and snap honor nearest edges',()=>{const nodes=[{x:0,y:0,w:10,h:20},{x:25,y:7,w:10,h:20},{x:70,y:1,w:10,h:20}];alignNodes(nodes,'spaceX');assert.equal(nodes[1].x,35);alignNodes(nodes,'bottom');assert.equal(nodes[0].y,7);assert.equal(snapPosition({id:'a',x:3,y:10,w:10,h:10},[],100,100).x,0);});
test('over-capacity campaign import is rejected before replacing current data',()=>{const p=project(),before=structuredClone(p);assert.throws(()=>applyCampaign(p,Array.from({length:11},()=>({assetId:'rice'}))),/格數/);assert.deepEqual(p,before);});
test('Excel optional retail fields reach the editable card',()=>{const p=project(0);applyCampaign(p,[{assetId:'rice',name:'Rice',price:'23',quantity:3,campaign:'Demo',start:'2026-11-01',end:'2026-11-07',stores:'A',originalPrice:'12',originalStrike:true,averageRounding:'tenth',badge:'新'}]);assert.equal(p.nodes[0].originalPrice,'12');assert.equal(p.nodes[0].originalStrike,true);assert.equal(p.nodes[0].badge,'新');assert.equal(p.nodes[0].cardStyle,'retail');});
test('classic product text honors independent sizes, colors and positions',()=>{
 const n={...productNode(asset),price:'33',quantity:2,textStyles:{name:{size:9,color:'#112233'},spec:{size:7,color:'#445566'}},regions:{name:{x:.1,y:.5,w:.7,h:.2},spec:{x:.1,y:.72,w:.7,h:.1},price:{x:.1,y:.85,w:.8,h:.15}}};
 const scene=retailText(n,measure),name=scene.find(p=>p.part==='name'),spec=scene.find(p=>p.part==='spec'),price=scene.find(p=>p.part==='price');
 assert.equal(name.color,'#112233');assert.equal(name.size,9);assert.equal(name.x,n.w*.1);assert.equal(name.y,n.h*.5);assert.equal(spec.color,'#445566');assert.equal(scene.filter(p=>p.part==='price').map(p=>p.text).join(''),'$33 / 2件');assert.equal(price.y,n.h*.85);
});
test('region transforms clamp inside the product and survive backup',async()=>{
 const {setRegionBox}=await import('../src/retail.js');const p=project(1),n=p.nodes[0];
 setRegionBox(n,'price',{x:n.w*.8,y:n.h*.9,w:n.w*.4,h:n.h*.3});
 assert.ok(n.regions.price.x+n.regions.price.w<=1);assert.ok(n.regions.price.y+n.regions.price.h<=1);assert.equal(retailErrors(n).length,0);
 assert.deepEqual(parseBackup(JSON.stringify(p)).nodes[0].regions,n.regions);
});
test('moving the price beside a classic name reserves a separate text column',()=>{
 const n={...productNode(asset),name:'Indomie Mi Goreng 即食麵',price:'33',quantity:1,regions:{price:{x:.55,y:.65,w:.43,h:.3}}};
 const name=region(n,'name'),price=region(n,'price');assert.ok(name.x+name.w<price.x);
 for(const item of retailText(n,measure).filter(p=>p.part==='name')){assert.ok(item.x+measure(item.text,item.size)<=price.x);assert.ok(item.clip);}
});
test('align text restores a shared top edge without changing image or prices',async()=>{
 const {alignProductText}=await import('../src/retail.js');const n={...productNode(asset),price:'33',quantity:2},before=imageRegion(n);
 alignProductText(n);assert.equal(region(n,'name').y,region(n,'price').y);assert.equal(region(n,'name').x,region(n,'spec').x);assert.ok(region(n,'name').x+region(n,'name').w<region(n,'price').x);assert.deepEqual(imageRegion(n),before);assert.equal(n.price,'33');assert.equal(n.quantity,2);assert.equal(retailErrors(n).length,0);
});
test('classic original price has its own row below specifications and above price',()=>{
 const n={...productNode(asset),price:'33',originalPrice:'40'},spec=region(n,'spec'),original=region(n,'original'),price=region(n,'price'),image=imageRegion(n);
 assert.ok(spec.y+spec.h<original.y);assert.ok(original.y+original.h<=price.y);assert.ok(image.y+image.h<=region(n,'name').y);
});
test('old custom layouts sharing the spec row are separated when restored',()=>{
 const n={...productNode(asset),originalPrice:'40',regions:{spec:{x:0,y:.7,w:.5,h:.15},original:{x:0,y:.7,w:.5,h:.15}}};
 const spec=region(n,'spec'),original=region(n,'original');assert.ok(spec.y+spec.h<original.y);assert.ok(original.y+original.h<=n.h*.85+.00001);
});
test('manual font size is honored when auto fit is disabled',()=>{
 const n={...productNode(asset),name:'Rice',price:'55',quantity:1,priceFontSize:450,priceAutoFit:false,textStyles:{name:{size:400,autoFit:false}}};
 const manual=retailText(n,measure);assert.equal(manual.find(p=>p.part==='name').size,400);assert.equal(manual.find(p=>p.part==='price'&&p.primary).size,450);assert.equal(manual.find(p=>p.part==='name').clip,null);
 n.priceAutoFit=true;n.textStyles.name.autoFit=true;const fitted=retailText(n,measure);assert.ok(fitted.find(p=>p.part==='name').size<400);assert.ok(fitted.find(p=>p.part==='price'&&p.primary).size<450);
 n.cardStyle='retail';n.priceAutoFit=false;assert.equal(retailText(n,measure).find(p=>p.text==='55').size,450);
});
test('manual font settings survive project backup and restore',()=>{
 const p=project(1);p.nodes[0].priceAutoFit=false;p.nodes[0].priceFontSize=900;p.nodes[0].textStyles={name:{size:800,autoFit:false}};
 const restored=parseBackup(JSON.stringify(p));assert.equal(restored.nodes[0].priceAutoFit,false);assert.equal(restored.nodes[0].textStyles.name.size,800);assert.equal(restored.nodes[0].textStyles.name.autoFit,false);
});

test('review fixes: trimmed prices, no $0 average, no single-value range',()=>{
  assert.equal(offer({price:'12 ',quantity:1}).main,'12');
  assert.equal(offer({price:'1',quantity:3,averageRounding:'integer'}).main,'1');
  assert.equal(originalLabel({originalPrice:'5',originalPriceMax:'5'}),'$5');
});
