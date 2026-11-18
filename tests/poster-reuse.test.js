import {retailText,region} from '../src/retail.js';
import {imageRegion} from '../src/auto-layout.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
import {defaultProject,parseBackup} from '../src/model.js';
import {posterMasks,selectionBox,replacePosterProduct,validPosterReuse,cropPixelBox,addExtractedProduct,replacePosterText,replacePosterPrice,borderColor,maskAt} from '../src/poster-reuse.js';
import {priceTagNode} from '../src/price-tag.js';
const source='data:image/png;base64,YQ==';
function fixture(){return {...defaultProject(),template:'custom',background:source,page:{width:1000,height:1400,unit:'px',dpi:150},products:[{id:'a',name:'米',sku:'A',spec:'1kg',imageUrl:source},{id:'b',name:'麵',sku:'B',spec:'85g',imageUrl:source}],posterReuse:{width:1000,height:1400,masks:[{id:'m',x:.1,y:.2,w:.4,h:.5,color:'#fff5df'}]}};}
test('reverse dragging clamps selection to source image',()=>{assert.deepEqual(selectionBox({x:.8,y:1.2},{x:-.1,y:.3}),{x:0,y:.3,w:.8,h:.7});});
test('masks follow background placement and remain independent of moved products',()=>{
 const p=fixture(),n=replacePosterProduct(p,'m','a');assert.equal(n.x,50);assert.equal(n.y,140);assert.equal(n.w,200);assert.equal(n.h,350);
 n.x=200;n.y=300;assert.equal(posterMasks(p)[0].x,50);
 p.backgroundPlacement={x:10,y:20,w:1000,h:1400};assert.equal(posterMasks(p)[0].x,110);assert.equal(posterMasks(p)[0].y,300);
 p.template='clean';assert.deepEqual(posterMasks(p),[]);
});
test('repeat replacement retains geometry and typography but clears obsolete offer and images',()=>{
 const p=fixture(),n=replacePosterProduct(p,'m','a');n.x=90;n.regions={name:{x:0,y:.7,w:.4,h:.1}};n.textStyles={spec:{size:23}};n.price='90';n.originalPrice='100';n.quantity=3;n.importedOffer={price:'90'};
 const old=structuredClone(n);const result=replacePosterProduct(p,'m','b','product');assert.equal(result.id,old.id);assert.equal(p.nodes.length,1);assert.equal(result.x,90);assert.deepEqual(result.textStyles,old.textStyles);assert.deepEqual(result.regions,old.regions);assert.equal(result.name,'麵');assert.equal(result.spec,'85g');assert.equal(result.price,'');assert.equal(result.originalPrice,undefined);assert.equal(result.importedOffer,undefined);assert.equal(result.quantity,1);assert.equal(result.pictures[0].productId,'b');
});
test('replacement is atomic on missing assets, small slots, and locked nodes',()=>{
 const p=fixture();assert.throws(()=>replacePosterProduct(p,'m','missing'));assert.equal(p.nodes.length,0);
 p.posterReuse.masks[0].h=.01;assert.throws(()=>replacePosterProduct(p,'m','a'),/太小/);assert.equal(p.nodes.length,0);
 p.posterReuse.masks[0].h=.5;const n=replacePosterProduct(p,'m','a');n.locked=true;assert.throws(()=>replacePosterProduct(p,'m','b'),/鎖定/);assert.equal(n.productId,'a');
});
test('backup preserves editable masks and rejects invalid coordinates and colors',()=>{
 const p=fixture();replacePosterProduct(p,'m','a');const restored=parseBackup(JSON.stringify(p));assert.deepEqual(restored.posterReuse,p.posterReuse);assert.equal(restored.nodes[0].id,p.posterReuse.masks[0].nodeId);
 p.posterReuse.masks[0].w=2;assert.equal(validPosterReuse(p.posterReuse),false);assert.throws(()=>parseBackup(JSON.stringify(p)),/遮蓋/);
 p.posterReuse.masks[0].w=.4;p.posterReuse.masks[0].color='invalid';assert.equal(validPosterReuse(p.posterReuse),false);
});

test('crop uses original image pixels and clamps fractional rounding at the edge',()=>{
 assert.deepEqual(cropPixelBox({x:.1,y:.2,w:.4,h:.5},4000,6000),{x:400,y:1200,w:1600,h:3000});
 const b=cropPixelBox({x:.3333,y:.3333,w:.6667,h:.6667},100,100);assert.equal(b.x+b.w,100);assert.equal(b.y+b.h,100);
 assert.throws(()=>cropPixelBox({x:-.1,y:0,w:.5,h:.5},100,100));assert.throws(()=>cropPixelBox({x:0,y:0,w:.01,h:.01},100,100));
});
test('extracted source becomes an editable product and failures do not leave orphan assets',()=>{
 const p=fixture(),asset={id:'crop',name:'舊商品',sku:'',spec:'',imageUrl:source,source:'poster-crop'};
 const node=addExtractedProduct(p,'m',asset);assert.equal(node.productId,'crop');assert.equal(node.price,'');assert.equal(node.name,'舊商品');assert.equal(p.products.length,3);
 const restored=parseBackup(JSON.stringify(p));assert.equal(restored.products.at(-1).source,'poster-crop');assert.equal(restored.nodes[0].productId,'crop');
 node.locked=true;assert.throws(()=>addExtractedProduct(p,'m',{...asset,id:'crop2'}));assert.equal(p.products.length,3);assert.equal(node.productId,'crop');
 assert.throws(()=>addExtractedProduct(p,'missing',{...asset,id:'crop3'}));assert.equal(p.products.length,3);
});

test('image-only framing creates no visible text or pending price',()=>{
 const p=fixture(),n=replacePosterProduct(p,'m','a');assert.equal(n.imageOnly,true);
 assert.deepEqual(retailText(n,()=>1),[]);assert.deepEqual(imageRegion(n),{x:0,y:0,w:n.w,h:n.h});
 const restored=parseBackup(JSON.stringify(p));assert.equal(restored.nodes[0].imageOnly,true);
});
test('image replacement on an existing card preserves editable fields and does not duplicate the card',()=>{
 const p=fixture(),n=replacePosterProduct(p,'m','a','product');n.price='33';n.quantity=2;n.originalPrice='40';
 const b=imageRegion(n);p.posterReuse.masks.push({id:'second',x:(n.x+b.x)/500,y:(n.y+b.y)/700,w:b.w/500,h:b.h/700,color:'#fff5df'});
 const result=replacePosterProduct(p,'second','b');assert.equal(result.id,n.id);assert.equal(p.nodes.length,1);
 assert.equal(n.name,'米');assert.equal(n.price,'33');assert.equal(n.quantity,2);assert.equal(n.originalPrice,'40');assert.equal(n.productId,'b');
});
test('replacing raster text creates one editable text layer and subsequent changes reuse it',()=>{
 const p=fixture(),n=replacePosterText(p,'m','新活動日期');assert.equal(n.type,'text');assert.equal(p.nodes.length,1);assert.equal(p.products.length,2);
 replacePosterText(p,'m','2026-11-01');assert.equal(p.nodes.length,1);assert.equal(n.text,'2026-11-01');
 assert.equal(parseBackup(JSON.stringify(p)).nodes[0].text,'2026-11-01');
 n.locked=true;assert.throws(()=>replacePosterText(p,'m','不能改'));assert.equal(n.text,'2026-11-01');
});
test('recognized text style sizes the layer in poster pixels and fits every new line',()=>{
 const p=fixture(),box=posterMasks(p).find(m=>m.id==='m'),style={fontSizeRatio:.5,color:'#ff0000',align:'left',box:{x:.1,y:.2,w:.8,h:.6}};
 const one=replacePosterText(p,'m','新米',style);assert.ok(Math.abs(one.fontSize-box.h*.5)<.01);assert.ok(one.fontSize>1);
 const text='PANDO\n蜂蜜味 / 牛奶味\n長崎蛋糕\n12 件裝\n$100',n=replacePosterText(p,'m',text,style);
 assert.equal(n.id,one.id);assert.equal(n.y,box.y);assert.equal(n.h,box.h);assert.ok(n.fontSize*1.3*5<=n.h+.01);assert.ok(Math.floor(n.h/(n.fontSize*1.3))>=5);
});
test('recognized weight, line height and original rows carry into the text layer',()=>{
 const p=fixture(),box=posterMasks(p).find(m=>m.id==='m'),style={fontSizeRatio:.2,color:'#282828',align:'left',weight:400,lineHeight:1.25,rows:4,box:{x:.1,y:.1,w:.8,h:.7}};
 const n=replacePosterText(p,'m','樂事\n黑松露味/\n酸忌廉洋蔥味薯片\n90克 ~~$14~~',style);
 assert.deepEqual(n.textLayout,{align:'left',weight:400,lineHeight:1.25,font:'poster'});assert.ok(Math.abs(n.y-(box.y+.1*box.h))<.01);
 assert.ok(n.h>=4*n.fontSize*1.25-.01);assert.ok(n.y+n.h<=box.y+box.h+.01);
 assert.equal(replacePosterText(p,'m','x',{weight:900,lineHeight:9}).textLayout.weight,600);assert.equal(n.textLayout.lineHeight,1.3);
});
test('framing already editable product text updates its field instead of adding another layer',()=>{
 const p=fixture(),n=replacePosterProduct(p,'m','a','product'),b=region(n,'name');
 p.posterReuse.masks.push({id:'text',x:(n.x+b.x)/500,y:(n.y+b.y)/700,w:b.w/500,h:b.h/700,color:'#fff5df'});
 assert.equal(replacePosterText(p,'text','新米').id,n.id);assert.equal(p.nodes.length,1);assert.equal(n.name,'新米');
});
test('mask color comes from the selection border, ignoring the text inside',()=>{
 const w=10,h=6,data=new Uint8ClampedArray(w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4,inner=x>1&&x<8&&y>1&&y<4;data.set(inner?[40,40,40,255]:[255,245,223,255],i);}
 data.set([220,50,50,255],0);assert.equal(borderColor(data,w,h),'#fff5df');assert.equal(borderColor(new Uint8ClampedArray(16),2,2),null);
});
test('clicking selects the topmost region under the pointer',()=>{
 const masks=[{id:'a',x:0,y:0,w:.5,h:.5},{id:'b',x:.4,y:.4,w:.3,h:.3}];
 assert.equal(maskAt(masks,{x:.45,y:.45}).id,'b');assert.equal(maskAt(masks,{x:.1,y:.1}).id,'a');assert.equal(maskAt(masks,{x:.9,y:.9}),null);
});
test('price badge is rebuilt with the retail price layout and survives a backup round trip',()=>{
 const p=fixture(),n=replacePosterPrice(p,'m',{price:'$36',quantity:2},'#e03c31');
 assert.equal(n.type,'text');assert.deepEqual(n.priceTag,{price:'36',quantity:2});assert.equal(n.text,'$18 平均每件 $36/2件');assert.equal(n.color,'#e03c31');
 const texts=retailText(priceTagNode(n),(t,s)=>String(t).length*s*.6).filter(x=>x.type==='text'&&x.text).map(x=>x.text);
 for(const t of ['$','18','平均','每件','$36/2件'])assert.ok(texts.includes(t),t);
 assert.ok(retailText(priceTagNode(n),(t,s)=>String(t).length*s*.6).some(x=>x.type==='rect'));
 assert.equal(replacePosterPrice(p,'m',{price:'40',quantity:2}).id,n.id);assert.equal(n.text,'$20 平均每件 $40/2件');
 assert.deepEqual(parseBackup(JSON.stringify(p)).nodes[0].priceTag,{price:'40',quantity:2});
 assert.throws(()=>replacePosterPrice(p,'m',{price:'0',quantity:2}));assert.throws(()=>replacePosterPrice(p,'m',{price:'36',quantity:0}));
 const broken=structuredClone(p);broken.nodes[0].priceTag={price:'abc',quantity:2};assert.throws(()=>parseBackup(JSON.stringify(broken)),/價格牌/);
 replacePosterText(p,'m','改回文字');assert.equal(n.priceTag,undefined);
});
test('framing an existing product price updates that product instead of adding a badge',()=>{
 const p=fixture(),n=replacePosterProduct(p,'m','a','product'),b=region(n,'price');
 p.posterReuse.masks.push({id:'price',x:(n.x+b.x)/500,y:(n.y+b.y)/700,w:b.w/500,h:b.h/700,color:'#fff5df'});
 assert.equal(replacePosterPrice(p,'price',{price:'36',quantity:2}).id,n.id);assert.equal(p.nodes.length,1);assert.equal(n.price,'36');assert.equal(n.quantity,2);
});
test('recognized text may use the framed width so font differences do not add line breaks',()=>{
 const p=fixture(),box=posterMasks(p).find(m=>m.id==='m');
 const left=replacePosterText(p,'m','即食白飯4件裝/',{fontSizeRatio:.3,align:'left',box:{x:.1,y:.2,w:.5,h:.3}});
 assert.ok(Math.abs(left.x-(box.x+.1*box.w))<.01);assert.ok(Math.abs(left.x+left.w-(box.x+box.w))<.01);
 const center=replacePosterText(p,'m','置中',{fontSizeRatio:.3,align:'center',box:{x:.2,y:.2,w:.5,h:.3}});
 assert.ok(Math.abs(center.x-box.x)<.01);assert.ok(Math.abs(center.w-.9*box.w)<.01);
});

test('paint masks cover fractional shared edges without modifying stored mask geometry',async()=>{
 const {paintedPosterMasks}=await import('../src/poster-reuse.js');
 const p=fixture();p.backgroundPlacement={x:0,y:0,w:1000,h:1400};
 p.posterReuse.masks=[{id:'left',x:.1,y:.2,w:.3333,h:.3,color:'#fff5df'},{id:'right',x:.4333,y:.2,w:.3,h:.3,color:'#fff5df'}];
 const stored=structuredClone(p.posterReuse);
 const [a,b]=paintedPosterMasks(p);
 assert.ok(a.x+a.w>=b.x+1,'fractional shared edges overlap instead of exposing old ink');
 for(const m of [a,b])for(const key of ['x','y','w','h'])assert.ok(Number.isInteger(m[key]));
 assert.deepEqual(p.posterReuse,stored);
 assert.equal(posterMasks(p)[0].w,333.3);
});
