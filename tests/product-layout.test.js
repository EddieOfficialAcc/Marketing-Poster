import test from 'node:test';
import assert from 'node:assert/strict';
import {applyProductLayout} from '../src/product-layout.js';
import {region,retailText,retailErrors} from '../src/retail.js';
import {setFontSize} from '../src/font-settings.js';
const measure=(text,size)=>[...text].reduce((s,c)=>s+size*(c.charCodeAt(0)>255?1:.6),0);
const node=()=>({name:'Indomie Mi Goreng\n即食麵',spec:'85g × 5包',originalPrice:'40',price:'33',quantity:1,w:500,h:650,fontSize:24,priceFontSize:75,color:'#ff0000',cardStyle:'classic',regions:{price:{x:0,y:.7,w:.4,h:.25}}});
test('switching to retail discards stale left-side price and aligns text and price tops',()=>{
 const n=node();applyProductLayout(n,measure,'retail');const price=region(n,'price'),name=region(n,'name'),spec=region(n,'spec');
 assert.ok(price.x>n.w*.5);assert.equal(price.y,name.y);assert.ok(name.x+name.w<price.x);assert.ok(name.y+name.h<spec.y);assert.equal(retailErrors(n).length,0);
});
test('specification size 50 reserves actual wrapped height before original and price',()=>{
 const n=node();setFontSize(n,'spec',50);applyProductLayout(n,measure,'classic');
 const spec=region(n,'spec'),original=region(n,'original'),price=region(n,'price');assert.ok(spec.y+spec.h<original.y);assert.ok(original.y+original.h<price.y);
 for(const p of retailText(n,measure).filter(p=>p.part==='spec')){assert.equal(p.size,50);assert.ok(p.y+p.size<original.y);}
});
test('switching back to classic stacks all text and preserves offer data and font settings',()=>{
 const n=node();setFontSize(n,'spec',50);applyProductLayout(n,measure,'retail');applyProductLayout(n,measure,'classic');
 assert.equal(n.price,'33');assert.equal(n.quantity,1);assert.equal(n.textStyles.spec.size,50);assert.ok(region(n,'price').y>region(n,'spec').y);assert.ok(region(n,'price').x<n.w*.1);
});
test('impossible sizes fail without partially changing layout',()=>{
 const n=node();setFontSize(n,'spec',1000);const before=structuredClone(n);assert.throws(()=>applyProductLayout(n,measure,'retail'),/可用空間/);assert.deepEqual(n,before);
});
test('HK dollar symbol uses the same proportion and font in both layouts',()=>{
 const outputs=['classic','retail'].map(cardStyle=>retailText({...node(),cardStyle,priceAutoFit:false,priceFontSize:50},measure));
 for(const rows of outputs){const symbol=rows.find(p=>p.part==='price'&&p.text==='$'),number=rows.find(p=>p.primary);assert.equal(symbol.size,17);assert.equal(number.size,50);assert.equal(symbol.family,number.family);assert.equal(symbol.y,number.y);}
});
test('saved meat-snack layout with spec inside price is repaired on load',async()=>{
 const {overlappingText,repairProjectText}=await import('../src/product-layout.js');
 const n={...node(),id:'meat',type:'product',name:'肉干',spec:'66g',originalPrice:'',price:'90',w:400,h:600,fontSize:50,priceFontSize:85,priceAutoFit:false,textStyles:{spec:{size:30,autoFit:false}},regions:{name:{x:.05,y:.6,w:.9,h:.1},spec:{x:.05,y:.78,w:.5,h:.1},price:{x:.05,y:.77,w:.9,h:.2}}};
 assert.ok(overlappingText(n,measure).length);
 const p={nodes:[n]},result=repairProjectText(p,measure);assert.deepEqual(result.repaired,['meat']);assert.equal(overlappingText(n,measure).length,0);assert.equal(n.spec,'66g');assert.equal(n.price,'90');assert.equal(n.textStyles.spec.size,30);
 assert.deepEqual(repairProjectText(p,measure),{repaired:[],unresolved:[]});
});
test('a locked or oversized overlapping layout is reported without silently rewriting it',async()=>{
 const {repairProjectText}=await import('../src/product-layout.js');
 const n={...node(),id:'locked',type:'product',locked:true,regions:{name:{x:0,y:.7,w:1,h:.2},spec:{x:0,y:.7,w:1,h:.2},price:{x:0,y:.7,w:1,h:.2}}};const before=structuredClone(n);
 const result=repairProjectText({nodes:[n]},measure);assert.deepEqual(result.unresolved,['locked']);assert.deepEqual(n,before);
});

test('photo area is shortened above imported name without altering prices or name geometry',async()=>{
 const {separateImageFromText}=await import('../src/product-layout.js');
 const n=node();n.cardStyle='retail';n.regions={image:{x:0,y:0,w:1,h:.8},name:{x:.03,y:.6,w:.46,h:.15},spec:{x:.03,y:.77,w:.46,h:.08},original:{x:.03,y:.87,w:.46,h:.05},price:{x:.55,y:.65,w:.4,h:.3}};
 const name=structuredClone(n.regions.name),price=n.price;
 assert.equal(separateImageFromText(n,measure),true);
 const image=region(n,'image');assert.ok(image.y+image.h<region(n,'name').y);
 assert.deepEqual(n.regions.name,name);assert.equal(n.price,price);
 assert.equal(separateImageFromText(n,measure),false);
});
