import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
import {defaultProject,parseBackup,validate} from '../src/model.js';
import {readingOrder,autoPlan,applyAutoReplace,reviewPayload,posterTextStyle,priceBoxes,gridLayout,rowErrors,harmonizeRows} from '../src/poster-auto.js';
import {retailText,region} from '../src/retail.js';

const source='data:image/png;base64,YQ==';
const measure=(text,size)=>[...String(text)].length*size;
const k=.5;  // the editor canvas for a 1000×1400 px page is 500×700
// Two rows on a 1000×1400 page: row one has three cells, row two two; the detector lists them out of order.
const cell=(id,x,y)=>({id,box:[x,y,300,400],imageBox:[x,y,300,280],textBox:[x,y+290,300,100],region:{box:[x/1000,(y-20)/1400,.3,420/1400],color:'#fff7e4'},
 nameStyle:{fontSize:15,top:y+292,left:x+14,right:x+160,bottom:y+380,lineHeight:1.4,color:'#231f20',weight:400,align:'left',oldText:`舊商品${id}\n100克`,rows:2},
 priceBox:[x+165,y+288,120,100],priceColor:'#ed1c24'});
const analysis=()=>({version:1,pageWidth:1000,pageHeight:1400,slots:[cell(4,30,800),cell(1,30,300),cell(3,670,305),cell(2,350,295),cell(5,350,810)],ai:{used:false},warnings:[]});
const five=(first)=>[first,row(1),row(2),row(3),row(4)];  // five products fill the five cells one to one
const row=(n,extra={})=>({row:n+1,campaign:'雙十一',start:'2026-11-01',end:'2026-11-11',stores:'全線',name:`新商品${n}`,sku:`S${n}`,spec:'200克',price:'36',quantity:2,originalPrice:'22',assetId:'a',...extra});
const project=()=>({...defaultProject(),template:'custom',background:source,page:{width:1000,height:1400,unit:'px',dpi:150},
 products:[{id:'a',name:'米',sku:'A',spec:'1kg',imageUrl:source}],posterReuse:{width:1000,height:1400,masks:[],mode:'replace',prepared:false}});

test('cells are filled in reading order: rows top to bottom, each row left to right',()=>{
 assert.deepEqual(readingOrder(analysis().slots).map(s=>s.id),[1,2,3,4,5]);
});

test('equal counts replace cell by cell; other counts re-divide the product area for every product',()=>{
 const same=autoPlan(analysis(),[0,1,2,3,4].map(n=>row(n)));
 assert.equal(same.mode,'match');assert.deepEqual(same.pairs.map(p=>p.slot.id),[1,2,3,4,5]);assert.equal(same.masks.length,5);
 for(const count of [2,3,6,7,12]){
  const plan=autoPlan(analysis(),Array.from({length:count},(_,n)=>row(n)));
  assert.equal(plan.mode,'grid');assert.equal(plan.pairs.length,count);assert.equal(plan.masks.length,5,'every old product is masked');
  assert.match(plan.warnings.join(),new RegExp(`商品 ${count} 件、舊海報 5 格`));
  for(const {slot} of plan.pairs){
   const [x,y,w,h]=slot.box;assert.ok(x>=30-1e-9&&y>=295-1e-9&&x+w<=970+1e-9&&y+h<=1210+1e-9,`cell ${slot.id} inside the product area`);
   assert.ok(slot.scale<=1.4+1e-9);const [px,py,pw,ph]=slot.priceBox;assert.ok(px>=x&&py>=y&&px+pw<=x+w+1e-9&&py+ph<=y+h+1e-9);
  }
  const cells=plan.pairs.map(p=>p.slot.box);
  for(let a=0;a<cells.length;a++)for(let b=a+1;b<cells.length;b++){const [ax,ay,aw,ah]=cells[a],[bx,by,bw,bh]=cells[b];
   assert.ok(ax+aw<=bx+1e-6||bx+bw<=ax+1e-6||ay+ah<=by+1e-6||by+bh<=ay+1e-6,'cells do not overlap');}
 }
});

test('grid shape follows the old cell proportions; a short last row is centred',()=>{
 assert.deepEqual((({cols,rows})=>[cols,rows])(gridLayout({w:900,h:800},6,.75)),[3,2]);
 assert.deepEqual((({cols,rows})=>[cols,rows])(gridLayout({w:900,h:800},4,.75)),[2,2]);
 const plan=autoPlan(analysis(),[0,1,2,3].map(n=>row(n))),boxes=plan.pairs.map(p=>p.slot.box);
 const p7=autoPlan(analysis(),Array.from({length:7},(_,n)=>row(n))).pairs.map(p=>p.slot.box);
 const last=p7.slice(-1)[0],first=p7[0];assert.ok(last[0]>first[0],'the single item of the last row is centred');
 assert.equal(boxes.length,4);
});

test('a bigger grid cell scales the text and price badge with it',()=>{
 const p=project(),a=analysis(),plan=autoPlan(a,[row(0),row(1,{quantity:1,price:'9.9'})]);
 const nodes=applyAutoReplace(p,a,plan,measure);
 assert.equal(p.posterReuse.masks.length,5);
 const scale=plan.pairs[0].slot.scale;assert.ok(scale>1);
 assert.ok(Math.abs(nodes[0].textStyles.name.size-15*scale*k)<1e-9);
 assert.ok(region(nodes[1],'price').h<region(nodes[0],'price').h,'single price badge stays shorter than a 2-piece badge');
});

test('edited rows are checked like product cards',()=>{
 assert.deepEqual(rowErrors(row(0)),[]);
 assert.deepEqual(rowErrors(row(0,{name:' ',price:'0',quantity:0,originalPrice:'abc',assetId:''})),['名稱必填','優惠總價須為正數，最多兩位小數','件數須為 1–99 的整數','原價須為正數，最多兩位小數','請選擇商品圖片']);
});

test('cells the vision model marks as not a product are skipped',()=>{
 const a=analysis();a.ai={used:true,slots:{2:{status:'not_product',note:'人物照片'},3:{status:'merged'}},uncovered:1};
 const plan=autoPlan(a,[row(0),row(1),row(2),row(3)]);
 assert.equal(plan.mode,'match');assert.deepEqual(plan.pairs.map(p=>p.slot.id),[1,3,4,5]);assert.equal(plan.pairs[1].row.name,'新商品1');
 assert.match(plan.warnings.join(),/不是商品（人物照片）/);assert.match(plan.warnings.join(),/可能含兩件商品/);assert.match(plan.warnings.join(),/1 件商品未被偵測/);
});

test('one text style for the whole poster: the median of the old cells',()=>{
 const slots=analysis().slots;slots[0].nameStyle.fontSize=30;slots[1].nameStyle={error:'沒有文字'};
 assert.deepEqual(posterTextStyle(slots),{fontSize:15,lineHeight:1.4,color:'#231f20',bold:false});
});

test('applied products carry only sheet data, sit in the old cells and keep the old text position',()=>{
 const p=project(),a=analysis(),plan=autoPlan(a,[row(0),row(1,{originalPrice:'',spec:''}),row(2,{quantity:1,price:'9.9'}),row(3),row(4)]);
 const nodes=applyAutoReplace(p,a,plan,measure,'活動.xlsx');
 assert.equal(nodes.length,5);assert.equal(p.posterReuse.masks.length,5);assert.equal(p.campaign.name,'雙十一');
 const [n]=nodes;
 assert.deepEqual([n.x,n.y,n.w,n.h],[30*k,300*k,300*k,400*k]);
 assert.deepEqual([n.name,n.spec,n.price,n.quantity,n.originalPrice,n.originalStrike],['新商品0','200克','36',2,'22',true]);
 assert.equal(n.color,'#ed1c24');assert.equal(n.textStyles.name.font,'poster');assert.equal(n.textStyles.name.size,15*k);
 const name=region(n,'name');assert.ok(Math.abs(name.x-14*k)<.01&&Math.abs(name.y-292*k)<.01);
 assert.ok(region(n,'spec').y>=name.y+name.h-1);assert.ok(region(n,'original').y>region(n,'spec').y);
 const price=region(n,'price');assert.ok(Math.abs(price.x-165*k)<.01&&Math.abs(price.y-288*k)<.01);
 const texts=retailText(n,measure).filter(x=>x.type==='text').map(x=>x.text);
 for(const t of ['新商品0','200克','$22','18','$36/2件'])assert.ok(texts.includes(t),t);
 assert.equal(nodes[1].regions.spec,undefined);assert.equal(nodes[1].regions.original,undefined);
 const restored=parseBackup(JSON.stringify(p));assert.equal(restored.nodes.length,5);assert.equal(restored.posterReuse.masks.length,5);
});

test('a long name takes more lines and pushes the spec down',()=>{
 const p=project(),a=analysis(),plan=autoPlan(a,five(row(0,{name:'很長很長很長很長很長很長很長很長很長很長的商品名稱'})));
 const [n]=applyAutoReplace(p,a,plan,measure);
 assert.ok(region(n,'name').h>15*k*1.4*1.9);assert.ok(region(n,'spec').y>(292+15*1.4*1.9)*k);
});

test('missing product images block applying',()=>{
 const p=project(),a=analysis();assert.throws(()=>applyAutoReplace(p,a,autoPlan(a,[row(0,{assetId:''})]),measure),/請為每件商品選擇圖片/);
});

test('the review payload states expected values from the applied data',()=>{
 const p=project(),a=analysis();applyAutoReplace(p,a,autoPlan(a,five(row(0))),measure);
 const payload=reviewPayload(p,'data:image/jpeg;base64,AA==');
 assert.deepEqual(payload.slots[0].expected,{name:'新商品0',spec:'200克',price:'$18',bundle:'$36/2件',averageLabel:'平均每件',original:'$22',originalStruck:true});
 payload.slots[0].box.forEach((v,i)=>assert.ok(Math.abs(v-[.03,300/1400,.3,400/1400][i])<1e-9));
});

test('a price badge is resized when the new offer type differs from the old one',()=>{
 const a=analysis();a.slots[0].priceBox=[195,1088,110,60];a.slots[1].priceBox=[195,588,120,100];  // cell 4 single, cell 1 bundle
 const boxes=priceBoxes(a.slots);assert.equal(boxes.kind([0,0,110,60]),'single');assert.equal(boxes.kind([0,0,120,100]),'bundle');
 const p=project(),plan=autoPlan(a,[row(0,{quantity:1,price:'9.9'}),row(1),row(2),row(3),row(4)]);
 const nodes=applyAutoReplace(p,a,plan,measure);
 // cell 1 (old bundle) now holds a single price: the typical single badge size, same top-left corner
 // (a single price is laid out larger than its ink box so the digits come out 60 tall again)
 const single=region(nodes[0],'price'),size=60/.72;
 assert.ok(Math.abs(single.h-size/.85*k)<.01&&Math.abs(single.w-110*1.08*k)<.01&&Math.abs(single.y-(588-300-size*.19)*k)<.01);
 // cell 4 (old single) now holds a 2-piece offer: the typical bundle badge height
 assert.ok(Math.abs(region(nodes[3],'price').h-100*k)<.01);
 // cell 2 keeps its own bundle badge
 assert.ok(Math.abs(region(nodes[1],'price').h-100*k)<.01);
});

// Blank backgrounds: the backend supplies template cells; no old products to mask.
const blankCell=(id,x,y,w,h,single=true)=>({id,box:[x,y,w,h],imageBox:[x+w*.04,y+h*.03,w*.92,h*.66],textBox:[x+w*.04,y+h*.72,w*.92,h*.26],region:null,priceColor:'#ed1c24',
 nameStyle:{fontSize:h*.034,top:y+h*.73,left:x+w*.06,right:x+w*.6,lineHeight:1.4,color:'#231f20',weight:400,align:'left'},priceBox:[x+w*.62,y+h*.73,w*.34,h*(single?.145:.245)]});
test('an open panel on a blank background is divided for any number of products, nothing masked',()=>{
 const a={version:1,pageWidth:1000,pageHeight:1400,blank:true,layout:'panel',zone:[50,200,900,1000],slots:[blankCell(1,50,200,300,349),blankCell(2,350,200,300,349,false)],ai:{},warnings:[]};
 for(const count of [1,4,10]){
  const plan=autoPlan(a,Array.from({length:count},(_,n)=>row(n)));
  assert.equal(plan.blank,'panel');assert.equal(plan.pairs.length,count);assert.deepEqual(plan.masks,[]);
  for(const {slot} of plan.pairs){const [x,y,w,h]=slot.box;assert.ok(x>=50-1e-9&&y>=200-1e-9&&x+w<=950+1e-9&&y+h<=1200+1e-9);}
 }
 const p=project();applyAutoReplace(p,a,autoPlan(a,[row(0),row(1)]),measure);assert.equal(p.posterReuse.masks.length,0);assert.equal(p.nodes.length,2);
});
test('printed product boxes are filled by number; spare boxes stay empty, surplus products are reported',()=>{
 const a={version:1,pageWidth:1000,pageHeight:1400,blank:true,layout:'cells',zone:[0,0,1000,800],slots:[1,2,3,4].map(i=>blankCell(i,(i-1)%2*500,Math.floor((i-1)/2)*400,480,380)),ai:{},warnings:[]};
 const fewer=autoPlan(a,[row(0),row(1),row(2)]);
 assert.equal(fewer.mode,'match');assert.equal(fewer.pairs.filter(p=>p.row).length,3);assert.match(fewer.warnings.join(),/第 4 格會留空/);assert.match(autoPlan(a,[row(0)]).warnings.join(),/第 2–4 格會留空/);
 const more=autoPlan(a,[0,1,2,3,4,5].map(n=>row(n)));
 assert.equal(more.pairs.length,4);assert.match(more.warnings.join(),/第 5 件起不會放入/);
});

test('text in one row shares size, top line and cell offsets; a misread cell follows its row',()=>{
 const slots=readingOrder(analysis().slots);slots[1].nameStyle={...slots[1].nameStyle,fontSize:30,top:900,left:600};slots[3].nameStyle.fontSize=11;slots[4].nameStyle.fontSize=11;
 const [a,b,c,d,e]=harmonizeRows(slots);
 assert.equal(b.nameStyle.fontSize,15);assert.equal(b.nameStyle.top,a.nameStyle.top>c.nameStyle.top?a.nameStyle.top:c.nameStyle.top);assert.equal(b.nameStyle.left,350+14);
 assert.equal(d.nameStyle.fontSize,11);assert.equal(e.nameStyle.fontSize,11);
 const p=project(),an=analysis();an.slots[0].nameStyle.fontSize=11;an.slots[4].nameStyle.fontSize=11;
 const nodes=applyAutoReplace(p,an,autoPlan(an,five(row(0))),measure);
 assert.equal(nodes[0].textStyles.name.size,15*k);assert.equal(nodes[3].textStyles.name.size,11*k);
});

test('a large poster takes as many products as it has cells (18 on an A2)',()=>{
 const slots=[];let id=1;
 for(const [top,count] of [[0,3],[500,5],[900,5],[1300,5]])for(let i=0;i<count;i++){const w=1200/count;slots.push({...cell(id++,0,0),box:[i*w,top,w,380],imageBox:[i*w,top,w,280],textBox:[i*w,top+290,w,90],
  nameStyle:{fontSize:14,top:top+292,left:i*w+12,right:i*w+w*.55,lineHeight:1.4,color:'#231f20',weight:400},priceBox:[i*w+w*.6,top+288,w*.35,60],region:{box:[i*w/1200,top/1700,w/1200,380/1700],color:'#fff7e4'}});}
 const a={version:1,pageWidth:1200,pageHeight:1700,slots,ai:{},warnings:[]},rows=Array.from({length:18},(_,n)=>row(n));
 const plan=autoPlan(a,rows);assert.equal(plan.mode,'match');assert.equal(plan.pairs.length,18);
 const p={...project(),page:{width:1200,height:1700,unit:'px',dpi:150},posterReuse:{width:1200,height:1700,masks:[],mode:'replace',prepared:false}};
 assert.equal(applyAutoReplace(p,a,plan,measure).length,18);assert.equal(p.posterReuse.masks.length,18);
 assert.equal(parseBackup(JSON.stringify(p)).nodes.length,18);
});

test('a one-product POP takes the first product and masks only its photo, name and price',()=>{
 // A POP page: photo top-right, name block on the left, a large price below the text.
 const slot={id:1,box:[30,100,940,1200],imageBox:[400,140,520,700],textBox:[50,400,300,400],priceBox:[60,950,400,260],priceColor:'#ed1c24',
  nameStyle:{fontSize:40,top:400,left:50,right:390,lineHeight:1.3,color:'#231f20',weight:400},region:[{box:[.4,.1,.5,.6],color:'#fff7e4'},{box:[.05,.4,.25,.3],color:'#fff7e4'},{box:[.1,.75,.4,.2],color:'#fff7e4'}]};
 const a={version:1,pageWidth:1000,pageHeight:1400,layout:'single',slots:[slot],ai:{},warnings:[]};
 const plan=autoPlan(a,[row(0),row(1)]);
 assert.equal(plan.single,true);assert.equal(plan.pairs.length,1);assert.match(plan.warnings.join(),/只放入第 1 件/);
 const p=project(),[n]=applyAutoReplace(p,a,plan,measure);
 assert.equal(p.posterReuse.masks.length,3);assert.equal(n.textStyles.name.size,40*k);
});

test('POP text that would run into the price below is shrunk to fit above it',()=>{
 const slot={id:1,box:[30,100,940,1200],imageBox:[400,140,520,700],textBox:[50,400,300,400],priceBox:[60,700,400,260],priceColor:'#ed1c24',
  nameStyle:{fontSize:40,top:400,left:50,right:200,lineHeight:1.3,color:'#231f20',weight:400},region:[]};
 const a={version:1,pageWidth:1000,pageHeight:1400,layout:'single',slots:[slot],ai:{},warnings:[]};
 const [n]=applyAutoReplace(project(),a,autoPlan(a,[row(0,{name:'很長的商品名稱需要換很多行才放得下'})]),measure);
 assert.ok(n.textStyles.name.size<40*k);
 const bottom=Math.max(...['name','spec','original'].map(key=>{const r=region(n,key);return r.y+r.h;}));
 assert.ok(n.y+bottom<=700*k+1,'all text ends above the price');
});

test('canvas AI review includes ordinary product cards and excludes image-only decorations',()=>{
 const p=defaultProject();p.nodes=[{id:'normal',type:'product',name:'咖啡',spec:'260g',price:'16',quantity:2,x:40,y:200,w:220,h:300},{id:'decoration',type:'product',imageOnly:true,x:0,y:0,w:100,h:100}];
 const payload=reviewPayload(p,'data:image/jpeg;base64,AA==');
 assert.equal(payload.slots.length,1);assert.equal(payload.slots[0].nodeId,'normal');
 assert.equal(payload.slots[0].expected.name,'咖啡');assert.equal(payload.slots[0].expected.price,'$8');
});

test('a cell reaching the page edge stays inside the canvas despite floating-point rounding',()=>{
 const a=analysis();a.pageWidth=587.7789916992188;a.pageHeight=834.3939819335938;
 for(const s of a.slots){s.box[0]=s.box[0]*.587;s.box[2]=s.box[2]*.587;}
 const edge=a.slots[2];edge.box[2]=a.pageWidth-edge.box[0];
 const p={...project(),page:{width:2818,height:4000,unit:'px',dpi:150},posterReuse:{width:2818,height:4000,masks:[],mode:'replace',prepared:false}};
 const nodes=applyAutoReplace(p,a,autoPlan(a,five(row(0))),measure);
 assert.deepEqual(validate(p).errors.filter(e=>e.includes('超出畫布')),[]);
 assert.ok(nodes.every(n=>n.x+n.w<=1409&&n.y+n.h<=2000));
});
